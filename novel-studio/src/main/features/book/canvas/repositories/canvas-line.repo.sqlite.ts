/**
 * Novel Studio · 画本行写入（SQLite）· 章节管理域所需的最小实现
 * ============================================================================
 * 设计依据：docs/15 §「章首标题念白」（`is_title=1` 的虚拟行）、docs/11 §3（人工结果永不覆盖）、
 *          docs/91 §5.2.8（本文件是 `chapter:inserTitleLine` 的落库实现）
 *
 * ### 为什么是「最小实现」而不是完整的画本仓储
 *   画本域自己的 SQLite 仓储还没落地 —— 当前 `canvas/repositories/canvas.repo.ts` 只有**内存**实现，
 *   而 `canvas:*` 通道整体仍是占位。章节管理域只用到 5 个动作（数行、找标题行、
 *   整体下移 seq、插一行、改一行正文），所以这里只实现这些，并通过
 *   `chapter.service.ts` 的 `CanvasLineWriter` 端口注入 —— 将来画本域落地完整仓储时，
 *   只要让它满足同一个端口即可接上，章节域不用改。
 *
 * ### 事务纪律
 *   本文件**不开事务**：所有写操作由调用方（chapter.service）包在一个事务里。
 *   在这里再开一层会变成嵌套 `BEGIN`（SQLite 直接报错）。
 *
 * ### 列与类型的三个坑
 *   1. `needs_review` / `is_title` 在库里是 **0/1 INTEGER**，领域类型是 `boolean`；
 *   2. `pause_inline` / `candidates` / `flags` 是 **JSON 文本列**；
 *   3. `flags` 列可为 NULL，但领域类型 `flags: string[]` 不可空 → 读回时兜 `[]`。
 */

import type { CanvasLine, Id } from '../../../../../shared/types.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import type { CanvasLineWriter } from '../../chapter/chapter.service.ts'

const INSERT_COLUMNS = `
  id, chapter_id, book_id, seq, speaker_type, character_id, kind, text, source_text,
  char_start, char_end, emotion, emotion_intensity, speed, gain_db, pause_after_ms, pause_inline,
  pronunciation, note, state, confidence, candidates, decided_by, needs_review, flags, is_title,
  rev, created_at, updated_at
`

const SELECT_COLUMNS = `
  id, chapter_id, book_id, seq, speaker_type, character_id, kind, text, source_text,
  char_start, char_end, emotion, emotion_intensity, speed, gain_db, pause_after_ms, pause_inline,
  pronunciation, note, state, confidence, candidates, decided_by, needs_review, flags, is_title,
  rev, created_at, updated_at
`

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

/** JSON 列的安全解析（坏数据不该让整个列表爆炸，与仓储其它地方的宽容口径一致） */
function parseJsonArray<T>(raw: string | null): T[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

function lineFromRow(row: CanvasLineRow): CanvasLine {
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
    pauseInline: parseJsonArray<number>(row.pause_inline),
    pronunciation: row.pronunciation,
    note: row.note,
    state: row.state as CanvasLine['state'],
    confidence: row.confidence,
    candidates: parseJsonArray<CanvasLine['candidates'] extends (infer U)[] | null ? U : never>(row.candidates),
    decidedBy: row.decided_by as CanvasLine['decidedBy'],
    needsReview: row.needs_review === 1,
    flags: parseJsonArray<string>(row.flags) ?? [],
    isTitle: row.is_title === 1,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createSqliteCanvasLineRepo(db: DbLike): CanvasLineWriter {
  async function countLines(chapterId: Id): Promise<number> {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM canvas_lines WHERE chapter_id = ? AND deleted_at IS NULL`)
      .get(chapterId) as { n: number } | undefined
    return row?.n ?? 0
  }

  async function findTitleLine(chapterId: Id): Promise<CanvasLine | null> {
    // 只认未删除的；同一章理论上只该有一行，取 seq 最小的那个以保证确定性
    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM canvas_lines
          WHERE chapter_id = ? AND is_title = 1 AND deleted_at IS NULL
          ORDER BY seq ASC LIMIT 1`,
      )
      .get(chapterId) as CanvasLineRow | undefined
    return row ? lineFromRow(row) : null
  }

  async function shiftSeqDown(chapterId: Id): Promise<void> {
    // 插到章首 = 让已有行整体后移一格（标题行占 seq 0，正文从 1 起）
    db.prepare(
      `UPDATE canvas_lines SET seq = seq + 1
        WHERE chapter_id = ? AND deleted_at IS NULL`,
    ).run(chapterId)
  }

  async function insert(line: CanvasLine): Promise<void> {
    db.prepare(`INSERT INTO canvas_lines (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
    )
  }

  async function updateText(lineId: Id, text: string): Promise<void> {
    db.prepare(`UPDATE canvas_lines SET text = ?, updated_at = ? WHERE id = ?`).run(text, Date.now(), lineId)
  }

  return { countLines, findTitleLine, shiftSeqDown, insert, updateText }
}
