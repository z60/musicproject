/**
 * Novel Studio · 对轨域的 SQL 查询（单一来源）
 * ============================================================================
 * 设计依据：
 *   · docs/13 §4.2 轨道 = 旁白或角色（`speaker_type` / `character_id`）
 *   · docs/13 §5   校验需要「片段 + 它的测量值 + 文件是否存在」
 *   · docs/91 §5.2.19 音频路径的基准是 `{projectRoot}/{projectId}`
 *
 * ### 为什么单独一个文件而不是写在 `ports.ts` 里
 *   对轨的输入查询（画本行 + 轨道 + 留白 + 绑定）与片段查询（含处理后的路径）
 *   是**领域知识**，不是装配细节。写在装配层会导致测试只能自己再抄一份 SQL ——
 *   于是「测试通过但生产 SQL 写错」永远不会被发现。这里的函数被生产与测试**共用**。
 *
 * ### 两个容易写错的点
 *   1. **轨道 id**：`speaker_type = 'character'` 且 `character_id` 非空时用角色 id，
 *      否则一律 `'narration'`。`character_id` 被 `ON DELETE SET NULL` 置空的行
 *      会自然回落到旁白轨（而不是变成一条 id 为 null 的怪轨）。
 *   2. **绑定是 LEFT JOIN**：缺录的行必须出现在结果里（`segment_id IS NULL`），
 *      它们正是校验里的 `missing_line`。用 INNER JOIN 会把「缺录」直接吞掉。
 */

import type { Id } from '../../../shared/types.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { AlignmentLineRow, AlignmentSegmentRow } from './alignment.service.ts'

/** JSON 数组列（`flags` 之类）→ string[]：坏数据不该让整个查询抛错 */
export function parseJsonArrayColumn(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface AlignmentLineQueries {
  listByChapter(chapterId: Id): Promise<AlignmentLineRow[]>
}

export function createAlignmentLineQueries(db: () => DbLike): AlignmentLineQueries {
  return {
    async listByChapter(chapterId) {
      const rows = db()
        .prepare(
          `SELECT l.id AS line_id, l.seq, l.speaker_type, l.character_id,
                  LENGTH(COALESCE(l.text, '')) AS char_count, l.pause_after_ms,
                  c.default_pause_ms AS character_pause_ms,
                  s.id AS segment_id
             FROM canvas_lines l
             LEFT JOIN characters c ON c.id = l.character_id
             LEFT JOIN voice_segments s ON s.line_id = l.id
            WHERE l.chapter_id = ? AND l.deleted_at IS NULL
            ORDER BY l.seq ASC`,
        )
        .all(chapterId) as Array<{
        line_id: string
        seq: number
        speaker_type: string
        character_id: string | null
        char_count: number
        pause_after_ms: number | null
        character_pause_ms: number | null
        segment_id: string | null
      }>
      return rows.map((r) => ({
        lineId: r.line_id,
        seq: r.seq,
        // 轨道 id：旁白恒为 'narration'，角色行用角色 id（docs/13 §4.2）
        trackId: r.speaker_type === 'character' && r.character_id ? r.character_id : 'narration',
        charCount: r.char_count,
        pauseAfterMs: r.pause_after_ms,
        characterPauseMs: r.character_pause_ms,
        segmentId: r.segment_id,
      }))
    },
  }
}

const SEGMENT_SELECT = `SELECT id, line_id, chapter_id, file_path, processed_path, duration_ms, rms_db, peak_db, flags
                          FROM voice_segments`

interface SegmentSqlRow {
  id: string
  line_id: string
  chapter_id: string
  file_path: string
  processed_path: string | null
  duration_ms: number
  rms_db: number | null
  peak_db: number | null
  flags: string | null
}

function toSegmentRow(r: SegmentSqlRow): AlignmentSegmentRow {
  return {
    segmentId: r.id,
    lineId: r.line_id,
    chapterId: r.chapter_id,
    filePath: r.file_path,
    processedPath: r.processed_path,
    durationMs: r.duration_ms,
    rmsDb: r.rms_db,
    peakDb: r.peak_db,
    flags: parseJsonArrayColumn(r.flags),
  }
}

export interface AlignmentSegmentQueries {
  listByChapter(chapterId: Id): Promise<AlignmentSegmentRow[]>
  get(segmentId: Id): Promise<AlignmentSegmentRow | null>
  /**
   * 把片段绑到某行。
   *
   * 返回 `'taken'` 表示目标行已经有片段（`voice_segments.line_id` 是 UNIQUE）——
   * 调用方据此抛 `CONFLICT` 并提示「先解绑再绑定」，而不是让 SQLite 抛原始约束错误。
   */
  rebind(segmentId: Id, lineId: Id, now?: () => number): Promise<'ok' | 'taken' | 'missing'>
  /** 解绑 = 删行（schema 里没有「未绑定的片段」状态；`line_id` 是 NOT NULL UNIQUE） */
  unbind(lineId: Id): Promise<boolean>
}

export function createAlignmentSegmentQueries(db: () => DbLike, now: () => number = () => Date.now()): AlignmentSegmentQueries {
  return {
    async listByChapter(chapterId) {
      const rows = db().prepare(`${SEGMENT_SELECT} WHERE chapter_id = ?`).all(chapterId) as SegmentSqlRow[]
      return rows.map(toSegmentRow)
    },

    async get(segmentId) {
      const row = db().prepare(`${SEGMENT_SELECT} WHERE id = ?`).get(segmentId) as SegmentSqlRow | undefined
      return row ? toSegmentRow(row) : null
    },

    async rebind(segmentId, lineId) {
      const conn = db()
      const exists = conn.prepare(`SELECT id FROM voice_segments WHERE id = ?`).get(segmentId)
      if (!exists) return 'missing'
      const taken = conn
        .prepare(`SELECT id FROM voice_segments WHERE line_id = ? AND id <> ?`)
        .get(lineId, segmentId) as { id: string } | undefined
      if (taken) return 'taken'
      try {
        conn.prepare(`UPDATE voice_segments SET line_id = ?, updated_at = ? WHERE id = ?`).run(
          lineId,
          now(),
          segmentId,
        )
      } catch (e) {
        // UNIQUE(line_id) 的兜底：上面查过一次，但并发请求之间仍可能撞上
        const msg = e instanceof Error ? e.message : String(e)
        if (/UNIQUE/i.test(msg)) return 'taken'
        throw e
      }
      return 'ok'
    },

    async unbind(lineId) {
      const r = db().prepare(`DELETE FROM voice_segments WHERE line_id = ?`).run(lineId) as { changes?: number }
      return (r.changes ?? 0) > 0
    },
  }
}
