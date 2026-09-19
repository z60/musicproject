/**
 * Novel Studio · 成品片段仓储（`voice_segments`，接口 + 内存实现 + SQLite 实现放一起）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6  `voice_segments`（**对 `line_id` 唯一**）
 *   · docs/12 §3.3「多个 part 合成一个 segment」——超长行分段录后合并成唯一成品
 *   · docs/03 §6  非破坏性处理：`processed_path` 是处理链的派生文件，换成品时要作废
 *
 * ### 为什么对 line_id 唯一这件事必须在仓储里守住
 *   对轨（docs/13）按「一行一个成品」建立时间线；若同一行出现两个 segment，
 *   对轨界面会出现两条来源相同、内容不同的片段 —— 用户无法判断哪条会进最终音频。
 *   所以 `upsertByLine` 是**唯一**的写入入口：有则原地更新（保住 id 与既有引用），
 *   没有则插入。这与画本行「同 id 原地更新」是同一个思路（docs/91 §5.2.9）。
 */

import type { Id, VoiceSegment } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'

export interface VoiceSegmentRepo {
  /** 取某行的成品（没有则 null） */
  getByLine(lineId: Id): Promise<VoiceSegment | null>
  get(segmentId: Id): Promise<VoiceSegment | null>
  /**
   * 按行写入成品：已有则**原地更新**（保留 id，作废 processed_path/preset_hash），
   * 没有则插入。返回落库后的成品。
   */
  upsertByLine(segment: VoiceSegment): Promise<VoiceSegment>
  /** 删除某行的成品（行被删/成品被取消时） */
  removeByLine(lineId: Id): Promise<boolean>
}

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

export function createMemoryVoiceSegmentRepo(seed?: { segments?: VoiceSegment[] }): VoiceSegmentRepo {
  const byLine = new Map<Id, VoiceSegment>()
  for (const s of seed?.segments ?? []) byLine.set(s.lineId, cloneSegment(s))
  return {
    async getByLine(lineId) {
      const s = byLine.get(lineId)
      return s ? cloneSegment(s) : null
    },
    async get(segmentId) {
      for (const s of byLine.values()) if (s.id === segmentId) return cloneSegment(s)
      return null
    },
    async upsertByLine(segment) {
      const existing = byLine.get(segment.lineId)
      const next: VoiceSegment = existing
        ? {
            ...cloneSegment(segment),
            id: existing.id,
            createdAt: existing.createdAt,
            // 换了成品音频 → 之前的处理结果不再对应当前内容，必须作废（docs/03 §6）
            processedPath: null,
            presetHash: null,
          }
        : cloneSegment(segment)
      byLine.set(next.lineId, next)
      return cloneSegment(next)
    },
    async removeByLine(lineId) {
      return byLine.delete(lineId)
    },
  }
}

// ---------------------------------------------------------------------------
// SQLite 实现
// ---------------------------------------------------------------------------

const SEGMENT_COLUMNS: readonly string[] = [
  'id',
  'line_id',
  'chapter_id',
  'take_id',
  'file_path',
  'processed_path',
  'preset_hash',
  'src_in_ms',
  'src_out_ms',
  'duration_ms',
  'peak_db',
  'rms_db',
  'lufs',
  'flags',
  'created_at',
  'updated_at',
]

interface SegmentRow {
  id: string
  line_id: string
  chapter_id: string
  take_id: string | null
  file_path: string
  processed_path: string | null
  preset_hash: string | null
  src_in_ms: number
  src_out_ms: number
  duration_ms: number
  peak_db: number | null
  rms_db: number | null
  lufs: number | null
  flags: string | null
  created_at: number
  updated_at: number
}

function parseFlags(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function segmentFromRow(row: SegmentRow): VoiceSegment {
  return {
    id: row.id,
    lineId: row.line_id,
    chapterId: row.chapter_id,
    takeId: row.take_id,
    filePath: row.file_path,
    processedPath: row.processed_path,
    presetHash: row.preset_hash,
    srcInMs: row.src_in_ms,
    srcOutMs: row.src_out_ms,
    durationMs: row.duration_ms,
    peakDb: row.peak_db,
    rmsDb: row.rms_db,
    lufs: row.lufs,
    flags: parseFlags(row.flags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function segmentToParams(s: VoiceSegment): unknown[] {
  return [
    s.id,
    s.lineId,
    s.chapterId,
    s.takeId,
    s.filePath,
    s.processedPath,
    s.presetHash,
    s.srcInMs,
    s.srcOutMs,
    s.durationMs,
    s.peakDb,
    s.rmsDb,
    s.lufs,
    JSON.stringify(s.flags ?? []),
    s.createdAt,
    s.updatedAt,
  ]
}

/**
 * UPDATE 的 `SET` 片段与参数**必须来自同一份列清单**。
 *
 * 踩过的坑：手工写 `.slice(2)` 来「跳过 id 与 created_at」，结果参数比 SET 少一个 ——
 * `file_path` 收到的是 `take_id` 的值，SQLite 直接报
 * `NOT NULL constraint failed: voice_segments.file_path`（本轮测试抓到）。
 * 现在两处都从 `UPDATE_COLUMNS` 派生，想错都难。
 */
const UPDATE_COLUMNS = SEGMENT_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at')

function updateParams(s: VoiceSegment): unknown[] {
  const all = segmentToParams(s)
  return UPDATE_COLUMNS.map((col) => all[SEGMENT_COLUMNS.indexOf(col)])
}

export function createSqliteVoiceSegmentRepo(db: DbLike): VoiceSegmentRepo {
  return {
    async getByLine(lineId: Id): Promise<VoiceSegment | null> {
      const row = db.prepare(`SELECT * FROM voice_segments WHERE line_id = ?`).get(lineId) as
        | SegmentRow
        | undefined
      return row ? segmentFromRow(row) : null
    },

    async get(segmentId: Id): Promise<VoiceSegment | null> {
      const row = db.prepare(`SELECT * FROM voice_segments WHERE id = ?`).get(segmentId) as
        | SegmentRow
        | undefined
      return row ? segmentFromRow(row) : null
    },

    async upsertByLine(segment: VoiceSegment): Promise<VoiceSegment> {
      const existing = db.prepare(`SELECT id, created_at FROM voice_segments WHERE line_id = ?`).get(segment.lineId) as
        | { id: string; created_at: number }
        | undefined

      if (!existing) {
        db.prepare(
          `INSERT INTO voice_segments (${SEGMENT_COLUMNS.join(', ')})
           VALUES (${SEGMENT_COLUMNS.map(() => '?').join(', ')})`,
        ).run(...segmentToParams(segment))
        return segment
      }

      // 原地更新：保住 id（既有引用：对轨项、处理结果、导出记录都按 segment id 关联）
      const next: VoiceSegment = {
        ...segment,
        id: existing.id,
        createdAt: existing.created_at,
        // 换了成品音频 → 之前的处理结果不再对应当前内容
        processedPath: null,
        presetHash: null,
      }
      const sets = UPDATE_COLUMNS.map((c) => `${c} = ?`).join(', ')
      db.prepare(`UPDATE voice_segments SET ${sets} WHERE id = ?`).run(...updateParams(next), existing.id)
      return next
    },

    async removeByLine(lineId: Id): Promise<boolean> {
      const r = db.prepare(`DELETE FROM voice_segments WHERE line_id = ?`).run(lineId) as { changes?: number }
      return (r.changes ?? 0) > 0
    },
  }
}

function cloneSegment(s: VoiceSegment): VoiceSegment {
  return { ...s, flags: [...s.flags] }
}
