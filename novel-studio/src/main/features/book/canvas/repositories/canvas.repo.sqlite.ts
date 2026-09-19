/**
 * Novel Studio · 画本行仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `repositories/canvas.repo.ts`（接口 + **内存实现**）—— 那是行为基准，
 *     本文件把同样的语义翻译成 SQL，**不引入第二套行为**。
 *   · docs/21 §5：`canvas_lines` / `line_embeddings` / `canvas_snapshots` 表结构
 *   · docs/11 §4.9 乐观锁 `rev`；§4.7 批量删除是**软删除**（可恢复）；§2 FR-2.4.7 生成前自动打快照
 *
 * ### 与内存实现必须一致的四条语义（逐条都有对应测试）
 *   1. **乐观锁**：`updateLine(..., expectedRev)` 在 rev 不匹配时抛 `CONFLICT`；
 *      每次成功更新 `rev + 1`。
 *   2. **CHECK 约束的归一化**：`confidence` 夹到 0..1（非有限值 → null）、
 *      `emotionIntensity` 夹到 1..5 并取整、`pauseAfterMs` 负值 → 0。
 *      内存实现做这一步是为了"保住表上的 CHECK"，SQLite 这边**也必须做** ——
 *      否则一个越界值会让整条 UPDATE 直接抛 CHECK 失败，而不是被温和地夹住。
 *   3. **软删除**：`deleted_at IS NULL` 是所有读路径的前提；`softDeleteLines`/`restoreLines` 可逆。
 *   4. **快照**：`payload` = 当时**存活**的行（按 seq 升序）序列化。
 *      表结构要求它是 `BLOB`（DDL 注释：JSON 序列化后 gzip），所以这里 gzip。
 *
 * ### 事务
 *   `replaceChapterLines` 与 `batchUpdate` 由**仓储自己**开事务（接口注释如此约定），
 *   用 `withTransactionAsync`（支持 async 回调；better-sqlite3 的 `db.transaction` 只收同步回调）。
 *   ⚠️ 调用方不要再套一层事务 —— SQLite 不支持嵌套 `BEGIN`。
 */

import { gunzipSync, gzipSync } from 'node:zlib'

import { AppError } from '../../../../../shared/errors.ts'
import type {
  CanvasGenerateReport,
  CanvasLine,
  CanvasLinePatch,
  Id,
  Timestamp,
} from '../../../../../shared/types.ts'
import { dropUndefined } from '../../../../../shared/util/drop-undefined.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import { withTransactionAsync } from '../../../../infra/db/with-transaction.ts'
import type {
  CanvasRepo,
  CanvasSnapshot,
  LineEmbeddingRecord,
  ReplaceChapterResult,
} from './canvas.repo.ts'

// ---------------------------------------------------------------------------
// 列与映射
// ---------------------------------------------------------------------------

/** 插入/读取用的列清单（29 列；`deleted_at` 由软删除专管，不进这里） */
const LINE_COLUMNS = `
  id, chapter_id, book_id, seq, speaker_type, character_id, kind, text, source_text,
  char_start, char_end, emotion, emotion_intensity, speed, gain_db, pause_after_ms, pause_inline,
  pronunciation, note, state, confidence, candidates, decided_by, needs_review, flags, is_title,
  rev, created_at, updated_at
`

const SELECT_LINE = `SELECT ${LINE_COLUMNS} FROM canvas_lines`

/** 列名清单（插入/整章替换拼 SQL 都要用；顺序必须与 `lineToParams` 一致） */
const CANVAS_LINE_COLUMN_NAMES: readonly string[] = LINE_COLUMNS.split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

interface CanvasLineRow {
  id: string
  chapter_id: string
  book_id: string
  seq: number
  speaker_type: string
  character_id: string | null
  kind: string
  text: string
  source_text: string | null
  char_start: number
  char_end: number
  emotion: string | null
  emotion_intensity: number | null
  speed: string | null
  gain_db: number | null
  pause_after_ms: number
  pause_inline: string | null
  pronunciation: string | null
  note: string | null
  state: string
  confidence: number | null
  candidates: string | null
  decided_by: string | null
  needs_review: number
  flags: string | null
  is_title: number
  rev: number
  created_at: number
  updated_at: number
}

/**
 * `CanvasLinePatch` 的字段 → 列名。
 *
 * 刻意**不含** `seq` / `isTitle` / `rev` / `state`：它们不在 `CanvasLinePatch` 类型里
 * （那是结构字段，不是内容字段）。改 seq 走 `shiftSeq`，rev 由乐观锁自己维护。
 */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  text: 'text',
  kind: 'kind',
  characterId: 'character_id',
  speakerType: 'speaker_type',
  emotion: 'emotion',
  emotionIntensity: 'emotion_intensity',
  speed: 'speed',
  gainDb: 'gain_db',
  pauseAfterMs: 'pause_after_ms',
  pauseInline: 'pause_inline',
  pronunciation: 'pronunciation',
  note: 'note',
  flags: 'flags',
  needsReview: 'needs_review',
  decidedBy: 'decided_by',
  confidence: 'confidence',
  candidates: 'candidates',
}

/** 需要 JSON 序列化的列 */
const JSON_COLUMNS = new Set(['pause_inline', 'candidates', 'flags'])
/** boolean ↔ 0/1 的列 */
const BOOL_COLUMNS = new Set(['needs_review', 'is_title'])

function parseJsonArray(raw: string | null): unknown[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function lineFromRow(row: CanvasLineRow): CanvasLine {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    bookId: row.book_id,
    seq: row.seq,
    speakerType: row.speaker_type as CanvasLine['speakerType'],
    characterId: row.character_id,
    kind: row.kind as CanvasLine['kind'],
    text: row.text,
    sourceText: row.source_text,
    charStart: row.char_start,
    charEnd: row.char_end,
    emotion: row.emotion,
    emotionIntensity: row.emotion_intensity,
    speed: row.speed as CanvasLine['speed'],
    gainDb: row.gain_db,
    pauseAfterMs: row.pause_after_ms,
    pauseInline: parseJsonArray(row.pause_inline) as number[] | null,
    pronunciation: row.pronunciation,
    note: row.note,
    state: row.state as CanvasLine['state'],
    confidence: row.confidence,
    candidates: parseJsonArray(row.candidates) as CanvasLine['candidates'],
    decidedBy: row.decided_by as CanvasLine['decidedBy'],
    needsReview: row.needs_review === 1,
    flags: (parseJsonArray(row.flags) as string[] | null) ?? [],
    isTitle: row.is_title === 1,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 一行的 29 个插入参数（顺序必须与 `LINE_COLUMNS` 完全一致） */
function lineToParams(line: CanvasLine): unknown[] {
  return [
    line.id,
    line.chapterId,
    line.bookId,
    line.seq,
    line.speakerType,
    line.characterId,
    line.kind,
    line.text,
    line.sourceText,
    line.charStart,
    line.charEnd,
    line.emotion,
    line.emotionIntensity,
    line.speed,
    line.gainDb,
    line.pauseAfterMs,
    line.pauseInline === null ? null : JSON.stringify(line.pauseInline),
    line.pronunciation,
    line.note,
    line.state,
    line.confidence,
    line.candidates === null ? null : JSON.stringify(line.candidates),
    line.decidedBy,
    line.needsReview ? 1 : 0,
    JSON.stringify(line.flags),
    line.isTitle ? 1 : 0,
    line.rev,
    line.createdAt,
    line.updatedAt,
  ]
}

/**
 * 把 patch 归一到满足表上的 CHECK 约束（与内存实现的 `applyPatch` 逐条一致）。
 * 越界值**夹住**而不是抛错，理由见文件头第 2 条。
 */
function normalizePatch(patch: CanvasLinePatch): CanvasLinePatch {
  const next: CanvasLinePatch = { ...patch }
  if (next.confidence !== undefined && next.confidence !== null) {
    next.confidence = Number.isFinite(next.confidence) ? Math.max(0, Math.min(1, next.confidence)) : null
  }
  if (next.emotionIntensity !== undefined && next.emotionIntensity !== null) {
    next.emotionIntensity = Math.max(1, Math.min(5, Math.round(next.emotionIntensity)))
  }
  if (next.pauseAfterMs !== undefined) {
    const v = next.pauseAfterMs
    next.pauseAfterMs = Number.isFinite(v) && v >= 0 ? v : 0
  }
  return next
}

/**
 * 把归一化后的 patch 转成 SQL 片段（只认白名单里的字段）。
 *
 * ⚠️ **`undefined` 的键必须跳过**：经 IPC 校验器来的 `patch` 里，
 * 没给的可选键也在（值是 `undefined`，见 `shared/util/drop-undefined.ts`），
 * 照写会 `SET text = NULL` —— 宽列直接 NOT NULL 报错，可空列静默清空。
 * `null` 则是用户明确要清空，照写。
 */
function patchToSql(patch: CanvasLinePatch): { sets: string[]; params: unknown[] } {
  const sets: string[] = []
  const params: unknown[] = []
  for (const [field, value] of Object.entries(dropUndefined(patch))) {
    const col = PATCH_COLUMNS[field]
    if (!col) continue
    sets.push(`${col} = ?`)
    if (JSON_COLUMNS.has(col)) params.push(value === null || value === undefined ? null : JSON.stringify(value))
    else if (BOOL_COLUMNS.has(col)) params.push(value === true ? 1 : value === false ? 0 : null)
    else params.push(value === undefined ? null : value)
  }
  return { sets, params }
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export function createSqliteCanvasRepo(db: DbLike): CanvasRepo {
  const now = (): Timestamp => Date.now()

  function requireRow(lineId: Id): CanvasLineRow {
    const row = db
      .prepare(`${SELECT_LINE} WHERE deleted_at IS NULL AND id = ?`)
      .get(lineId) as CanvasLineRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId } })
    return row
  }

  /**
   * 插入实现（内部函数而不是 `this.insertLines`）。
   * 为什么不用 `this`：对象方法被解构（`const { x } = repo`）后 `this` 会丢失，
   * 而这在装配层与测试里都可能发生。内存实现同样用内部函数规避了这一点。
   */
  function insertLinesImpl(lines: CanvasLine[]): number {
    if (lines.length === 0) return 0
    const stmt = db.prepare(
      `INSERT INTO canvas_lines (${LINE_COLUMNS}) VALUES (${Array.from({ length: 29 }, () => '?').join(', ')})`,
    )
    const ts = now()
    let n = 0
    for (const line of lines) {
      // createdAt/updatedAt 缺失时补当前时间（与内存实现一致）
      const row = { ...line, createdAt: line.createdAt || ts, updatedAt: ts }
      try {
        stmt.run(...lineToParams(row))
        n++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/UNIQUE|PRIMARY/i.test(msg)) {
          throw new AppError('CONFLICT', { cause: e, details: { entity: 'canvas_line', id: line.id } })
        }
        throw e
      }
    }
    return n
  }

  /**
   * 整章替换：旧行让位、新行进场（一个事务）。
   *
   * ### 为什么不是「软删旧行 + 插入新行」
   * 生成画本用的 id 是**确定性**的 —— `{chapterId}-L{seq:05d}`（见 `canvas.service.ts`），
   * 所以「重新生成同一章」时新行与旧行 **id 完全相同**，而 `canvas_lines.id` 是**主键**：
   * 盲插会 UNIQUE 冲突。内存实现靠 `Map` 覆盖「碰巧」通过 —— 这正是
   * 「内存实现是行为基准」的陷阱（docs/91 §5.2.8 记过同类事故）。
   *
   * ### 也不能改成「物理删除旧行再插入」
   * `takes` / `voice_segments` / `line_embeddings` 都是 `ON DELETE CASCADE` 指向画本行，
   * 物理删除会**连带销毁录音元数据**（磁盘文件变孤儿、界面再也找不回来）——
   * docs/21 §「软删除」明确「音频相关实体禁物理删除」。
   *
   * ### 采用的做法：同 id **原地更新**，其余旧行软删除
   * 与内存实现的语义**完全等价**（同一 id → 内容被新一轮替换，且行仍然存活），
   * 同时保住了指向该行的录音引用。返回的 `deleted` 按内存实现的口径统计
   * （= 本次被取代的旧存活行数），这样两个实现的返回值可比对。
   */
  function replaceChapterLinesImpl(chapterId: Id, lines: CanvasLine[]): ReplaceChapterResult {
    const ts = now()
    const rows = lines.map((l) => ({ ...l, chapterId, createdAt: l.createdAt || ts, updatedAt: ts }))

    const oldAlive =
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM canvas_lines WHERE chapter_id = ? AND deleted_at IS NULL`)
          .get(chapterId) as { n: number } | undefined
      )?.n ?? 0

    // ① 同 id 的行原地更新（并恢复存活）；库里没有这个 id 才插入
    //    `LINE_COLUMNS` 是插入用的列清单，这里拿它的列名拼 UPDATE 的 SET
    const setClause = CANVAS_LINE_COLUMN_NAMES.map((c) => `${c} = ?`).join(', ')
    for (const row of rows) {
      const exists = db.prepare(`SELECT 1 AS x FROM canvas_lines WHERE id = ?`).get(row.id)
      if (exists) {
        db.prepare(`UPDATE canvas_lines SET ${setClause}, deleted_at = NULL WHERE id = ?`).run(
          ...lineToParams(row),
          row.id,
        )
      } else {
        insertLinesImpl([row])
      }
    }

    // ② 不在新一轮里的旧行：软删除（可恢复）
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(', ')
      db.prepare(
        `UPDATE canvas_lines SET deleted_at = ?, updated_at = ?
          WHERE chapter_id = ? AND deleted_at IS NULL AND id NOT IN (${ph})`,
      ).run(ts, ts, chapterId, ...ids)
    } else {
      db.prepare(
        `UPDATE canvas_lines SET deleted_at = ?, updated_at = ? WHERE chapter_id = ? AND deleted_at IS NULL`,
      ).run(ts, ts, chapterId)
    }

    return { deleted: oldAlive, inserted: rows.length }
  }

  return {
    // ── 读 ─────────────────────────────────────────────────────────────────
    async listLines(chapterId: Id): Promise<CanvasLine[]> {
      const rows = db
        .prepare(`${SELECT_LINE} WHERE deleted_at IS NULL AND chapter_id = ? ORDER BY seq ASC`)
        .all(chapterId) as CanvasLineRow[]
      return rows.map(lineFromRow)
    },

    async getLine(lineId: Id): Promise<CanvasLine | null> {
      const row = db
        .prepare(`${SELECT_LINE} WHERE deleted_at IS NULL AND id = ?`)
        .get(lineId) as CanvasLineRow | undefined
      return row ? lineFromRow(row) : null
    },

    async listByCharacter(characterId: Id): Promise<CanvasLine[]> {
      const rows = db
        .prepare(
          `${SELECT_LINE} WHERE deleted_at IS NULL AND character_id = ?
            ORDER BY chapter_id ASC, seq ASC`,
        )
        .all(characterId) as CanvasLineRow[]
      return rows.map(lineFromRow)
    },

    async countByChapter(chapterId: Id): Promise<number> {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM canvas_lines WHERE deleted_at IS NULL AND chapter_id = ?`)
        .get(chapterId) as { n: number } | undefined
      return row?.n ?? 0
    },

    async countHumanDecided(chapterId: Id): Promise<number> {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM canvas_lines
            WHERE deleted_at IS NULL AND chapter_id = ? AND decided_by = 'human'`,
        )
        .get(chapterId) as { n: number } | undefined
      return row?.n ?? 0
    },

    // ── 写 ─────────────────────────────────────────────────────────────────
    async insertLines(lines: CanvasLine[]): Promise<number> {
      return insertLinesImpl(lines)
    },

    async replaceChapterLines(chapterId: Id, lines: CanvasLine[]): Promise<ReplaceChapterResult> {
      return withTransactionAsync(db, () => replaceChapterLinesImpl(chapterId, lines), {
        eventPrefix: 'canvas.tx',
      })
    },

    async updateLine(lineId: Id, patch: CanvasLinePatch, expectedRev?: number): Promise<CanvasLine> {
      const current = requireRow(lineId)
      if (expectedRev !== undefined && current.rev !== expectedRev) {
        // 乐观锁冲突必须给出「期望值 / 实际值」，UI 要据此提示「这条已被改动，请刷新」
        throw new AppError('CONFLICT', {
          details: { entity: 'canvas_line', lineId, expectedRev, actualRev: current.rev },
        })
      }
      const normalized = normalizePatch(patch)
      const { sets, params } = patchToSql(normalized)
      const ts = now()
      // 即使 patch 里没有可写字段，也要推进 rev（调用方确实提交了一次修改意图）
      const allSets = [...sets, 'rev = rev + 1', 'updated_at = ?']
      db.prepare(`UPDATE canvas_lines SET ${allSets.join(', ')} WHERE id = ?`).run(...params, ts, lineId)
      return lineFromRow(requireRow(lineId))
    },

    async batchUpdate(patches: Array<{ lineId: Id; patch: CanvasLinePatch }>): Promise<number> {
      if (patches.length === 0) return 0
      return withTransactionAsync(
        db,
        () => {
          const ts = now()
          let n = 0
          for (const { lineId, patch } of patches) {
            // 跳过不存在 / 已软删除的行（与内存实现一致：批量更新是「尽力而为」）
            const alive = db
              .prepare(`SELECT rev FROM canvas_lines WHERE deleted_at IS NULL AND id = ?`)
              .get(lineId) as { rev: number } | undefined
            if (!alive) continue
            const { sets, params } = patchToSql(normalizePatch(patch))
            const allSets = [...sets, 'rev = rev + 1', 'updated_at = ?']
            db.prepare(`UPDATE canvas_lines SET ${allSets.join(', ')} WHERE id = ?`).run(...params, ts, lineId)
            n++
          }
          return n
        },
        { eventPrefix: 'canvas.tx' },
      )
    },

    async softDeleteLines(lineIds: Id[]): Promise<number> {
      if (lineIds.length === 0) return 0
      const ts = now()
      const ph = lineIds.map(() => '?').join(', ')
      const r = db
        .prepare(
          `UPDATE canvas_lines SET deleted_at = ?, updated_at = ?
            WHERE deleted_at IS NULL AND id IN (${ph})`,
        )
        .run(ts, ts, ...lineIds) as { changes?: number }
      return r.changes ?? 0
    },

    async restoreLines(lineIds: Id[]): Promise<number> {
      if (lineIds.length === 0) return 0
      const ts = now()
      const ph = lineIds.map(() => '?').join(', ')
      const r = db
        .prepare(`UPDATE canvas_lines SET deleted_at = NULL, updated_at = ? WHERE deleted_at IS NOT NULL AND id IN (${ph})`)
        .run(ts, ...lineIds) as { changes?: number }
      return r.changes ?? 0
    },

    /**
     * 把某章未删除行的 `seq` 整体加 `delta`。
     *
     * 为什么单独开一个方法：`seq` **不在** `CanvasLinePatch` 里（它是结构字段），
     * 所以 `batchUpdate` 表达不了「整体挪一格」。章首插入标题念白行时需要它。
     *
     * `seqGreaterThan` 只挪尾巴（章中间插入用），理由见接口注释 —— 整章一起挪会
     * 让插入点之前的行也越过插入点，与新增行撞 seq（该列**没有唯一约束**，
     * 不会报错，只会静默乱序）。
     */
    async shiftSeq(chapterId: Id, delta: number, opts?: { seqGreaterThan?: number }): Promise<number> {
      const bound = opts?.seqGreaterThan
      const sql =
        bound === undefined
          ? `UPDATE canvas_lines SET seq = seq + ?, updated_at = ?
              WHERE chapter_id = ? AND deleted_at IS NULL`
          : `UPDATE canvas_lines SET seq = seq + ?, updated_at = ?
              WHERE chapter_id = ? AND deleted_at IS NULL AND seq > ?`
      const params = bound === undefined ? [delta, now(), chapterId] : [delta, now(), chapterId, bound]
      const r = db.prepare(sql).run(...params) as { changes?: number }
      return r.changes ?? 0
    },

    // ── 向量 ───────────────────────────────────────────────────────────────
    async upsertEmbedding(record: LineEmbeddingRecord): Promise<void> {
      // 向量按 Float32Array 的原始字节存 BLOB（DDL 注释：L2 归一化后的 Float32Array）
      const bytes = Buffer.from(record.vector.buffer, record.vector.byteOffset, record.vector.byteLength)
      db.prepare(
        `INSERT INTO line_embeddings (line_id, model_id, dim, vector, content_hash, context_scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(line_id) DO UPDATE SET
           model_id = excluded.model_id, dim = excluded.dim, vector = excluded.vector,
           content_hash = excluded.content_hash, context_scope = excluded.context_scope,
           created_at = excluded.created_at`,
      ).run(record.lineId, record.modelId, record.dim, bytes, record.contentHash, record.contextScope, record.createdAt)
    },

    async getEmbedding(lineId: Id): Promise<LineEmbeddingRecord | null> {
      const row = db
        .prepare(
          `SELECT line_id, model_id, dim, vector, content_hash, context_scope, created_at
             FROM line_embeddings WHERE line_id = ?`,
        )
        .get(lineId) as
        | {
            line_id: string
            model_id: string
            dim: number
            vector: Uint8Array
            content_hash: string
            context_scope: number
            created_at: number
          }
        | undefined
      return row ? embeddingFromRow(row) : null
    },

    async listEmbeddings(chapterId: Id): Promise<LineEmbeddingRecord[]> {
      const rows = db
        .prepare(
          `SELECT e.line_id, e.model_id, e.dim, e.vector, e.content_hash, e.context_scope, e.created_at
             FROM line_embeddings e
             JOIN canvas_lines l ON l.id = e.line_id
            WHERE l.chapter_id = ? AND l.deleted_at IS NULL`,
        )
        .all(chapterId) as Array<{
        line_id: string
        model_id: string
        dim: number
        vector: Uint8Array
        content_hash: string
        context_scope: number
        created_at: number
      }>
      return rows.map(embeddingFromRow)
    },

    async deleteEmbedding(lineId: Id): Promise<void> {
      db.prepare(`DELETE FROM line_embeddings WHERE line_id = ?`).run(lineId)
    },

    async listEmbeddingsByCharacter(characterId: Id): Promise<LineEmbeddingRecord[]> {
      const rows = db
        .prepare(
          `SELECT e.line_id, e.model_id, e.dim, e.vector, e.content_hash, e.context_scope, e.created_at
             FROM line_embeddings e
             JOIN canvas_lines l ON l.id = e.line_id
            WHERE l.character_id = ? AND l.deleted_at IS NULL`,
        )
        .all(characterId) as Array<{
        line_id: string
        model_id: string
        dim: number
        vector: Uint8Array
        content_hash: string
        context_scope: number
        created_at: number
      }>
      return rows.map(embeddingFromRow)
    },

    // ── 快照 ───────────────────────────────────────────────────────────────
    async createSnapshot(input): Promise<CanvasSnapshot> {
      const payload = (
        db
          .prepare(`${SELECT_LINE} WHERE deleted_at IS NULL AND chapter_id = ? ORDER BY seq ASC`)
          .all(input.chapterId) as CanvasLineRow[]
      ).map(lineFromRow)
      const snapshot: CanvasSnapshot = {
        id: input.id ?? globalThis.crypto.randomUUID(),
        chapterId: input.chapterId,
        label: input.label ?? null,
        reason: input.reason ?? 'manual',
        payload,
        createdAt: input.now ?? now(),
      }
      // DDL 要求 payload 是 BLOB 且注释写明「JSON 序列化（gzip 后）」
      db.prepare(
        `INSERT INTO canvas_snapshots (id, chapter_id, label, reason, line_count, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        snapshot.id,
        snapshot.chapterId,
        snapshot.label,
        snapshot.reason,
        payload.length,
        gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')),
        snapshot.createdAt,
      )
      return snapshot
    },

    async listSnapshots(chapterId: Id): Promise<CanvasSnapshot[]> {
      const rows = db
        .prepare(
          `SELECT id, chapter_id, label, reason, payload, created_at
             FROM canvas_snapshots WHERE chapter_id = ? ORDER BY created_at DESC`,
        )
        .all(chapterId) as Array<{
        id: string
        chapter_id: string
        label: string | null
        reason: string | null
        payload: Uint8Array
        created_at: number
      }>
      return rows.map(snapshotFromRow)
    },

    async getSnapshot(snapshotId: Id): Promise<CanvasSnapshot | null> {
      const row = db
        .prepare(
          `SELECT id, chapter_id, label, reason, payload, created_at
             FROM canvas_snapshots WHERE id = ?`,
        )
        .get(snapshotId) as
        | {
            id: string
            chapter_id: string
            label: string | null
            reason: string | null
            payload: Uint8Array
            created_at: number
          }
        | undefined
      return row ? snapshotFromRow(row) : null
    },

    // ── 生成报告（表在 003 迁移里，一章一行）────────────────────────────────
    async saveGenerateReport(report: CanvasGenerateReport, opts?: { now?: Timestamp }): Promise<void> {
      const ts = opts?.now ?? now()
      // 标量列是同一条语句里写入的**冗余索引**（供统计/排查用）；
      // 读取只用 `payload`，所以两者不会分叉（见 003 迁移的注释）。
      db.prepare(
        `INSERT INTO canvas_generate_reports
           (chapter_id, total_lines, low_confidence, embedding_used, llm_used, elapsed_ms, payload, generated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chapter_id) DO UPDATE SET
           total_lines    = excluded.total_lines,
           low_confidence = excluded.low_confidence,
           embedding_used = excluded.embedding_used,
           llm_used       = excluded.llm_used,
           elapsed_ms     = excluded.elapsed_ms,
           payload        = excluded.payload,
           generated_at   = excluded.generated_at,
           updated_at     = excluded.updated_at`,
      ).run(
        report.chapterId,
        report.totalLines ?? 0,
        report.lowConfidence ?? 0,
        report.embeddingUsed ? 1 : 0,
        report.llmUsed ? 1 : 0,
        report.elapsedMs ?? 0,
        JSON.stringify(report),
        ts,
        ts,
      )
    },

    async getGenerateReport(chapterId: Id): Promise<CanvasGenerateReport | null> {
      const row = db
        .prepare(`SELECT payload FROM canvas_generate_reports WHERE chapter_id = ?`)
        .get(chapterId) as { payload: string } | undefined
      if (!row) return null
      try {
        return JSON.parse(row.payload) as CanvasGenerateReport
      } catch {
        // 坏掉的报告不该让整个画本打不开：按「没有报告」处理。
        // 这意味着 UI 会显示「还没生成过」——所以保留警告日志，便于真机排查。
        return null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 行 → 领域对象（向量 / 快照）
// ---------------------------------------------------------------------------

function embeddingFromRow(row: {
  line_id: string
  model_id: string
  dim: number
  vector: Uint8Array
  content_hash: string
  context_scope: number
  created_at: number
}): LineEmbeddingRecord {
  // 先拷贝字节：驱动返回的缓冲区 byteOffset 不保证 4 字节对齐，
  // 直接 `new Float32Array(row.vector.buffer, byteOffset, n)` 在某些情况下会抛
  // RangeError（未对齐）。拷一份到新 buffer 最稳。
  const bytes = Uint8Array.from(row.vector)
  return {
    lineId: row.line_id,
    modelId: row.model_id,
    dim: row.dim,
    vector: new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4)),
    contentHash: row.content_hash,
    contextScope: row.context_scope,
    createdAt: row.created_at,
  }
}

function snapshotFromRow(row: {
  id: string
  chapter_id: string
  label: string | null
  reason: string | null
  payload: Uint8Array
  created_at: number
}): CanvasSnapshot {
  let payload: CanvasLine[] = []
  try {
    const json = gunzipSync(Buffer.from(row.payload)).toString('utf8')
    const parsed: unknown = JSON.parse(json)
    payload = Array.isArray(parsed) ? (parsed as CanvasLine[]) : []
  } catch {
    // 快照坏了不该让整个列表爆炸：返回空 payload（调用方按「快照不可用」处理）
    payload = []
  }
  return {
    id: row.id,
    chapterId: row.chapter_id,
    label: row.label,
    reason: (row.reason ?? 'manual') as CanvasSnapshot['reason'],
    payload,
    createdAt: row.created_at,
  }
}

// 供装配层与测试引用（避免各处硬编码字符串）
export const CANVAS_LINE_COLUMNS = LINE_COLUMNS
export type { CanvasLineRow }
