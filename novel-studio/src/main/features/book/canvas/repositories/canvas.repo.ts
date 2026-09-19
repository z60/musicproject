/**
 * Novel Studio · 画本行仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §5   canvas_lines / line_embeddings / canvas_snapshots 表结构
 *   · docs/11 §4.9 自动保存与冲突（乐观锁 rev）
 *   · docs/11 §2   「每次生成前自动打快照，可回滚」（FR-2.4.7）
 *   · docs/03 §5.2 「必须记录 model_id 与 content_hash」
 *
 * 这里只定接口 + 内存实现：
 *   · 生产实现（`createSqliteCanvasRepo(db)`）落在同目录，由 better-sqlite3 + 事务完成；
 *     本任务环境下不引入原生依赖，因此先给出可测试的内存实现，接口即落库契约。
 *   · 内存实现是**测试与降级演示**用的：它精确复刻乐观锁、软删除、快照语义。
 *
 * 零第三方依赖。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type {
  CanvasGenerateReport,
  CanvasLine,
  CanvasLinePatch,
  Id,
  Timestamp,
} from '../../../../../shared/types.ts'
import { definedKeys, dropUndefined } from '../../../../../shared/util/drop-undefined.ts'

// ============================================================================
// 类型
// ============================================================================

/** 一行向量（对应 line_embeddings，docs/21 §5） */
export interface LineEmbeddingRecord {
  lineId: Id
  modelId: string
  dim: number
  /** 已 L2 归一化的 Float32Array */
  vector: Float32Array
  /** sha256(modelId + '|' + 判定文本)（docs/06 §7.1） */
  contentHash: string
  /** 拼上下文时用的行窗口（默认 2） */
  contextScope: number
  createdAt: Timestamp
}

/** 画本快照（docs/21 §5 canvas_snapshots；生成/重算前自动打） */
export interface CanvasSnapshot {
  id: Id
  chapterId: Id
  label: string | null
  reason: 'pre_generate' | 'manual' | 'pre_restore'
  /** 序列化后的行数据（生产实现与表结构一致） */
  payload: CanvasLine[]
  createdAt: Timestamp
}

export interface ReplaceChapterResult {
  deleted: number
  inserted: number
}

export interface CanvasRepo {
  // ---- 读 ----
  listLines(chapterId: Id): Promise<CanvasLine[]>
  getLine(lineId: Id): Promise<CanvasLine | null>
  /**
   * 某角色名下的全部存活行（跨章）。
   *
   * 用途：`character:stats`（出场统计）与 `character:merge`（合并前算「将影响 N 行」）。
   * **不是**按 `canvas_lines.character_id` 的索引扫描就能省掉的东西 ——
   * 合并必须先拿到行 id 才能生成补丁（合并不是简单改一列，还要置 `decidedBy='human'`）。
   */
  listByCharacter(characterId: Id): Promise<CanvasLine[]>
  countByChapter(chapterId: Id): Promise<number>
  /** 人工确认过的行数（生成前提示「本章已有 N 行人工修改」，docs/11 §8） */
  countHumanDecided(chapterId: Id): Promise<number>

  // ---- 写 ----
  insertLines(lines: CanvasLine[]): Promise<number>
  /** 整章替换（一个事务）：先软删除旧行再插入新行 */
  replaceChapterLines(chapterId: Id, lines: CanvasLine[]): Promise<ReplaceChapterResult>
  /**
   * 更新单行。`expectedRev` 给定时做乐观锁校验，不匹配抛 AppError('CONFLICT')（docs/11 §4.9）。
   * 返回更新后的行；行不存在抛 AppError('NOT_FOUND')。
   */
  updateLine(lineId: Id, patch: CanvasLinePatch, expectedRev?: number): Promise<CanvasLine>
  /** 批量更新（一个事务），返回更新行数；docs/21 的 check 约束在实现里也要保住 */
  batchUpdate(patches: Array<{ lineId: Id; patch: CanvasLinePatch }>): Promise<number>
  /** 软删除（docs/11 §4.7：批量删除是软删除，可恢复） */
  softDeleteLines(lineIds: Id[]): Promise<number>
  restoreLines(lineIds: Id[]): Promise<number>
  /**
   * 把某章未删除行的 `seq` 整体加 `delta`（返回影响行数）。
   *
   * 为什么需要它：`seq` **不在** `CanvasLinePatch` 里（它是结构字段，不是内容字段），
   * 所以 `batchUpdate` 表达不了「整体挪一格」。「章首插入标题念白行」需要这个能力：
   * 标题行占 `seq = 0`，原有行要整体后移（docs/15 §7）。
   *
   * `opts.seqGreaterThan` 给定时**只挪 `seq > 该值` 的行**（省略 = 全挪）。
   *
   * ⚠️ 为什么必须有这个下界：在**章中间**插入若干行时，只有「插入点之后的那些行」
   * 需要让位。若整章一起挪，插入点**之前**的行也会被推到插入点之后 ——
   * 新行落地时就会和它们**撞在同一个 seq 上**（`seq` 没有唯一约束，不会报错，
   * 只会让这一章的朗读顺序静默错乱）。这个下界把「让位」限制成真正的尾巴。
   */
  shiftSeq(chapterId: Id, delta: number, opts?: { seqGreaterThan?: number }): Promise<number>

  // ---- 向量 ----
  upsertEmbedding(record: LineEmbeddingRecord): Promise<void>
  getEmbedding(lineId: Id): Promise<LineEmbeddingRecord | null>
  listEmbeddings(chapterId: Id): Promise<LineEmbeddingRecord[]>
  /** 某角色名下所有存活行的向量（`character:rebuildCentroid` 要用） */
  listEmbeddingsByCharacter(characterId: Id): Promise<LineEmbeddingRecord[]>
  /** 文本变了要作废该行向量（docs/06 §5.5：content_hash 变化 → 仅重算该行） */
  deleteEmbedding(lineId: Id): Promise<void>

  // ---- 快照 ----
  createSnapshot(input: {
    id?: Id
    chapterId: Id
    label?: string | null
    reason?: CanvasSnapshot['reason']
    now?: Timestamp
  }): Promise<CanvasSnapshot>
  listSnapshots(chapterId: Id): Promise<CanvasSnapshot[]>
  getSnapshot(snapshotId: Id): Promise<CanvasSnapshot | null>

  // ---- 生成报告（docs/11 §2.4；表在 003 迁移里，一章一行）----
  /**
   * 保存本章的生成报告（**整行覆盖**）。
   *
   * 一章一行：契约是 `{ chapterId } → CanvasGenerateReport | null`，没有 id 也没有历史。
   * 生成会替换整章画本行，UI 要看的就是「**本次**生成的结果」。
   * 要留历史请用画本快照（`createSnapshot`），别在这张表里堆副本。
   */
  saveGenerateReport(report: CanvasGenerateReport, opts?: { now?: Timestamp }): Promise<void>
  /** 读本章最近一次生成报告；从未生成过返回 `null`（**不是**编造的空报告） */
  getGenerateReport(chapterId: Id): Promise<CanvasGenerateReport | null>
}

// ============================================================================
// 内存实现
// ============================================================================

const HUMAN_EDITABLE_FIELDS: ReadonlyArray<keyof CanvasLinePatch> = [
  'text', 'kind', 'characterId', 'speakerType', 'emotion', 'emotionIntensity',
  'speed', 'gainDb', 'pauseAfterMs', 'pauseInline', 'pronunciation', 'note', 'flags',
]

/**
 * 创建内存画本仓储（供测试与演示）。
 *
 * - 时间戳可用 `now` 注入（测试里固定时间，避免 flaky 断言）
 * - 深拷贝进出：调用方拿到的是副本，改它不会污染仓储（等价于走了一次 SQLite 往返）
 * - 乐观锁、软删除、快照语义与生产实现一致
 */
export function createMemoryCanvasRepo(seed?: { lines?: CanvasLine[]; now?: () => Timestamp }): CanvasRepo {
  const lines = new Map<Id, { line: CanvasLine; deletedAt: Timestamp | null }>()
  const embeddings = new Map<Id, LineEmbeddingRecord>()
  const snapshots = new Map<Id, CanvasSnapshot>()
  /** 生成报告：一章一行（与 003 迁移的 PRIMARY KEY(chapter_id) 同语义） */
  const reports = new Map<Id, CanvasGenerateReport>()
  const now = seed?.now ?? (() => Date.now())
  let seq = 0
  const nextId = (prefix: string): Id => `${prefix}-${++seq}`

  for (const l of seed?.lines ?? []) lines.set(l.id, { line: cloneLine(l), deletedAt: null })

  const requireLine = (lineId: Id): CanvasLine => {
    const rec = lines.get(lineId)
    if (!rec || rec.deletedAt != null) {
      throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId } })
    }
    return rec.line
  }

  const applyPatch = (line: CanvasLine, patch: CanvasLinePatch): CanvasLine => {
    // 只应用**真正给出**的键（`undefined` = 没给，`null` = 明确清空）：
    // 经 IPC 校验器来的 patch 会把没给的可选键物化成 `undefined`，
    // 直接 `{...line, ...patch}` 会把文本/说话人静默变成 undefined（见 drop-undefined.ts）
    const next: CanvasLine = { ...line, ...dropUndefined(patch), updatedAt: now() }
    // 保住表上的 CHECK 约束语义（docs/21 §5）
    if (next.confidence != null) {
      next.confidence = Math.max(0, Math.min(1, next.confidence))
      if (!Number.isFinite(next.confidence)) next.confidence = null
    }
    if (next.emotionIntensity != null) {
      next.emotionIntensity = Math.max(1, Math.min(5, Math.round(next.emotionIntensity)))
    }
    if (next.pauseAfterMs == null || !Number.isFinite(next.pauseAfterMs) || next.pauseAfterMs < 0) {
      next.pauseAfterMs = 0
    }
    return next
  }

  /** 插入实现（内部直接调用，避免依赖 `this` 绑定） */
  const insertLinesImpl = async (incoming: CanvasLine[]): Promise<number> => {
    const ts = now()
    for (const l of incoming) {
      lines.set(l.id, {
        line: cloneLine({ ...l, createdAt: l.createdAt || ts, updatedAt: ts }),
        deletedAt: null,
      })
    }
    return incoming.length
  }

  return {
    async listLines(chapterId) {
      return [...lines.values()]
        .filter((r) => r.deletedAt == null && r.line.chapterId === chapterId)
        .map((r) => cloneLine(r.line))
        .sort((a, b) => a.seq - b.seq)
    },

    async getLine(lineId) {
      const rec = lines.get(lineId)
      return rec && rec.deletedAt == null ? cloneLine(rec.line) : null
    },

    async listByCharacter(characterId) {
      return [...lines.values()]
        .filter((r) => r.deletedAt == null && r.line.characterId === characterId)
        .map((r) => cloneLine(r.line))
        .sort((a, b) => (a.chapterId === b.chapterId ? a.seq - b.seq : a.chapterId.localeCompare(b.chapterId)))
    },

    async countByChapter(chapterId) {
      return [...lines.values()].filter((r) => r.deletedAt == null && r.line.chapterId === chapterId).length
    },

    async countHumanDecided(chapterId) {
      return [...lines.values()].filter(
        (r) => r.deletedAt == null && r.line.chapterId === chapterId && r.line.decidedBy === 'human',
      ).length
    },

    async insertLines(incoming) {
      return insertLinesImpl(incoming)
    },

    async replaceChapterLines(chapterId, incoming) {
      let deleted = 0
      for (const [, rec] of lines) {
        if (rec.deletedAt == null && rec.line.chapterId === chapterId) {
          rec.deletedAt = now()
          deleted++
        }
      }
      const inserted = await insertLinesImpl(incoming.map((l) => ({ ...l, chapterId })))
      return { deleted, inserted }
    },

    async updateLine(lineId, patch, expectedRev) {
      // 用统一的取行辅助：不存在或已软删除时抛 NOT_FOUND（避免各处重复这段校验）
      requireLine(lineId)
      const rec = lines.get(lineId)!
      if (expectedRev != null && rec.line.rev !== expectedRev) {
        throw new AppError('CONFLICT', {
          details: { entity: 'canvas_line', lineId, expectedRev, actualRev: rec.line.rev },
        })
      }
      const next = applyPatch(rec.line, patch)
      next.rev = rec.line.rev + 1
      rec.line = next
      return cloneLine(next)
    },

    async batchUpdate(patches) {
      let n = 0
      for (const p of patches) {
        const rec = lines.get(p.lineId)
        if (!rec || rec.deletedAt != null) continue
        const next = applyPatch(rec.line, p.patch)
        next.rev = rec.line.rev + 1
        rec.line = next
        n++
      }
      return n
    },

    async softDeleteLines(lineIds) {
      const ts = now()
      let n = 0
      for (const id of lineIds) {
        const rec = lines.get(id)
        if (rec && rec.deletedAt == null) {
          rec.deletedAt = ts
          n++
        }
      }
      return n
    },

    async restoreLines(lineIds) {
      let n = 0
      for (const id of lineIds) {
        const rec = lines.get(id)
        if (rec && rec.deletedAt != null) {
          rec.deletedAt = null
          n++
        }
      }
      return n
    },

    async shiftSeq(chapterId, delta, opts) {
      const bound = opts?.seqGreaterThan
      let n = 0
      for (const [, rec] of lines) {
        if (rec.deletedAt != null || rec.line.chapterId !== chapterId) continue
        if (bound !== undefined && rec.line.seq <= bound) continue
        rec.line = { ...rec.line, seq: rec.line.seq + delta, updatedAt: now() }
        n++
      }
      return n
    },

    async upsertEmbedding(record) {
      embeddings.set(record.lineId, { ...record, vector: Float32Array.from(record.vector) })
    },

    async getEmbedding(lineId) {
      const r = embeddings.get(lineId)
      return r ? { ...r, vector: Float32Array.from(r.vector) } : null
    },

    async listEmbeddings(chapterId) {
      const out: LineEmbeddingRecord[] = []
      for (const [lineId, r] of embeddings) {
        const rec = lines.get(lineId)
        if (!rec || rec.line.chapterId !== chapterId) continue
        out.push({ ...r, vector: Float32Array.from(r.vector) })
      }
      return out
    },

    async listEmbeddingsByCharacter(characterId) {
      const out: LineEmbeddingRecord[] = []
      for (const [lineId, r] of embeddings) {
        const rec = lines.get(lineId)
        // 软删除的行不算：它的向量还在，但行已经不在画本里了
        if (!rec || rec.deletedAt != null || rec.line.characterId !== characterId) continue
        out.push({ ...r, vector: Float32Array.from(r.vector) })
      }
      return out
    },

    async deleteEmbedding(lineId) {
      embeddings.delete(lineId)
    },

    async createSnapshot(input) {
      const snapshot: CanvasSnapshot = {
        id: input.id ?? nextId('snap'),
        chapterId: input.chapterId,
        label: input.label ?? null,
        reason: input.reason ?? 'manual',
        payload: [...lines.values()]
          .filter((r) => r.deletedAt == null && r.line.chapterId === input.chapterId)
          .map((r) => cloneLine(r.line))
          .sort((a, b) => a.seq - b.seq),
        createdAt: input.now ?? now(),
      }
      snapshots.set(snapshot.id, snapshot)
      return { ...snapshot, payload: snapshot.payload.map(cloneLine) }
    },

    async listSnapshots(chapterId) {
      return [...snapshots.values()]
        .filter((s) => s.chapterId === chapterId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => ({ ...s, payload: s.payload.map(cloneLine) }))
    },

    async getSnapshot(snapshotId) {
      const s = snapshots.get(snapshotId)
      return s ? { ...s, payload: s.payload.map(cloneLine) } : null
    },

    async saveGenerateReport(report, opts) {
      void (opts?.now ?? now())
      // 深拷贝：报告里带嵌套结构（byKind / bySpeaker / byDecision），
      // 直接存引用会让调用方后续改对象时**悄悄改掉「历史报告」**
      reports.set(report.chapterId, cloneReport(report))
    },

    async getGenerateReport(chapterId) {
      const r = reports.get(chapterId)
      return r ? cloneReport(r) : null
    },
  }
}

/** 深拷贝一份生成报告（嵌套对象与数组都要新对象，理由见 `saveGenerateReport`） */
export function cloneReport(report: CanvasGenerateReport): CanvasGenerateReport {
  const byKind: Record<string, number> = {}
  for (const [k, v] of Object.entries(report.byKind ?? {})) byKind[k] = v
  const byDecision: Record<string, number> = {}
  for (const [k, v] of Object.entries(report.byDecision ?? {})) byDecision[k] = v
  return {
    ...report,
    byKind: byKind as CanvasGenerateReport['byKind'],
    byDecision: byDecision as CanvasGenerateReport['byDecision'],
    bySpeaker: (report.bySpeaker ?? []).map((s) => ({ ...s })),
    warnings: [...(report.warnings ?? [])],
  }
}

/** 深拷贝一行（避开 Float32Array/引用共享带来的「改了仓储里的数据」这类隐蔽 bug） */
function cloneLine(line: CanvasLine): CanvasLine {
  return {
    ...line,
    candidates: line.candidates ? line.candidates.map((c) => ({ ...c })) : null,
    pauseInline: line.pauseInline ? [...line.pauseInline] : null,
    flags: [...line.flags],
  }
}

/**
 * 供上层判断「哪些字段由人工改过」（docs/11 §4.4：改过就自动置 `decidedBy='human'`）。
 *
 * ⚠️ 判断依据是**值非 undefined**，不是 `key in patch`：经 IPC 校验器来的 patch
 * 里每个可选键都在（值是 `undefined`），用 `in` 会把「只改了停顿」误判成
 * 「改了文本/说话人」，从而把行静默记成人工确认（见 drop-undefined.ts）。
 */
export function isHumanEditablePatch(patch: CanvasLinePatch): boolean {
  const given = new Set<string>(definedKeys(patch))
  return HUMAN_EDITABLE_FIELDS.some((f) => given.has(f))
}
