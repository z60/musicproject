/**
 * Novel Studio · 录音会话仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `recording-session.repo.ts`（接口 + 内存实现）—— 行为基准
 *   · docs/21 §6 `recording_sessions` 表：`format` 是三个列（sample_rate/bit_depth/channels）、
 *     `marks` 是 JSON 文本、`status` 有 CHECK 约束
 *
 * ### 两条与内存实现必须一致的行为
 *   1. **sessions 不提供删除**（契约里没有删会话的通道，物理清理由 cleanup 的保留策略做）；
 *   2. `finalize` 是单向跃迁：SQL 里用 `WHERE id = ?` 直接写状态，不存在「改回 active」的路径
 *      —— 与接口注释一致，避免有人拿通用补丁把已定稿会话改回 active。
 *
 * ### 列清单单一来源
 *   `SESSION_COLUMNS` 同时用于 SELECT 与 INSERT，插错列序在测试里会立刻表现为
 *   「字段错位」（本项目在 take 仓储上真被这个坑过一次，见 docs/91 §5.2.18）。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { AudioFormat, Id, RecordingSession, SessionStatus } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import type { RecordingSessionRepo } from './recording-session.repo.ts'

const SESSION_COLUMNS: readonly string[] = [
  'id',
  'project_id',
  'chapter_id',
  'mode',
  'actor_id',
  'file_path',
  'sample_rate',
  'bit_depth',
  'channels',
  'duration_ms',
  'peak_db',
  'rms_db',
  'gain_db',
  'device_label',
  'device_id',
  'dropped_frames',
  'status',
  'marks',
  'started_at',
  'finished_at',
]

const SELECT_SESSION = `SELECT ${SESSION_COLUMNS.join(', ')} FROM recording_sessions`

interface SessionRow {
  id: string
  project_id: string
  chapter_id: string | null
  mode: string
  actor_id: string | null
  file_path: string
  sample_rate: number
  bit_depth: number
  channels: number
  duration_ms: number
  peak_db: number | null
  rms_db: number | null
  gain_db: number
  device_label: string | null
  device_id: string | null
  dropped_frames: number
  status: string
  marks: string | null
  started_at: number
  finished_at: number | null
}

export function sessionFromRow(row: SessionRow): RecordingSession {
  const format: AudioFormat = {
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth as AudioFormat['bitDepth'],
    channels: row.channels as AudioFormat['channels'],
  }
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    mode: row.mode as RecordingSession['mode'],
    actorId: row.actor_id,
    filePath: row.file_path,
    format,
    durationMs: row.duration_ms,
    peakDb: row.peak_db,
    rmsDb: row.rms_db,
    gainDb: row.gain_db,
    deviceLabel: row.device_label,
    deviceId: row.device_id,
    droppedFrames: row.dropped_frames,
    status: row.status as SessionStatus,
    marks: parseMarks(row.marks),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function parseMarks(raw: string | null): RecordingSession['marks'] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((m): m is { kind: string; atMs: number } => {
        return typeof m === 'object' && m !== null && typeof (m as { kind?: unknown }).kind === 'string'
      })
      .filter((m) => m.kind === 'cut' || m.kind === 'retake' || m.kind === 'note')
      .map((m) => ({ kind: m.kind as 'cut' | 'retake' | 'note', atMs: Number(m.atMs) || 0 }))
  } catch {
    return []
  }
}

function sessionToParams(s: RecordingSession): unknown[] {
  return [
    s.id,
    s.projectId,
    s.chapterId,
    s.mode,
    s.actorId,
    s.filePath,
    s.format.sampleRate,
    s.format.bitDepth,
    s.format.channels,
    s.durationMs,
    s.peakDb,
    s.rmsDb,
    s.gainDb,
    s.deviceLabel,
    s.deviceId,
    s.droppedFrames,
    s.status,
    JSON.stringify(s.marks ?? []),
    s.startedAt,
    s.finishedAt,
  ]
}

export function createSqliteRecordingSessionRepo(db: DbLike): RecordingSessionRepo {
  function readOne(sessionId: Id): RecordingSession {
    const row = db.prepare(`${SELECT_SESSION} WHERE id = ?`).get(sessionId) as SessionRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'recording_session', sessionId } })
    return sessionFromRow(row)
  }

  return {
    async insert(session) {
      try {
        db.prepare(
          `INSERT INTO recording_sessions (${SESSION_COLUMNS.join(', ')})
           VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`,
        ).run(...sessionToParams(session))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/UNIQUE|PRIMARY/i.test(msg)) {
          throw new AppError('CONFLICT', { cause: e, details: { entity: 'recording_session', id: session.id } })
        }
        throw e
      }
      return readOne(session.id)
    },

    async get(sessionId) {
      const row = db.prepare(`${SELECT_SESSION} WHERE id = ?`).get(sessionId) as SessionRow | undefined
      return row ? sessionFromRow(row) : null
    },

    async listByChapter(chapterId) {
      const rows = db
        .prepare(`${SELECT_SESSION} WHERE chapter_id = ? ORDER BY started_at DESC`)
        .all(chapterId) as SessionRow[]
      return rows.map(sessionFromRow)
    },

    async listByProject(projectId, limit) {
      const sql =
        limit === undefined
          ? `${SELECT_SESSION} WHERE project_id = ? ORDER BY started_at DESC`
          : `${SELECT_SESSION} WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`
      const rows = (
        limit === undefined
          ? db.prepare(sql).all(projectId)
          : db.prepare(sql).all(projectId, Math.max(1, Math.floor(limit)))
      ) as SessionRow[]
      return rows.map(sessionFromRow)
    },

    async finalize(sessionId, patch) {
      db.prepare(
        `UPDATE recording_sessions
            SET status = ?, duration_ms = ?, peak_db = ?, rms_db = ?, dropped_frames = ?, finished_at = ?
          WHERE id = ?`,
      ).run(
        patch.status,
        patch.durationMs,
        patch.peakDb,
        patch.rmsDb,
        patch.droppedFrames,
        patch.finishedAt,
        sessionId,
      )
      return readOne(sessionId)
    },

    async setMarks(sessionId, marks) {
      db.prepare(`UPDATE recording_sessions SET marks = ? WHERE id = ?`).run(JSON.stringify(marks ?? []), sessionId)
      return readOne(sessionId)
    },

    async addDroppedFrames(sessionId, frames) {
      db.prepare(`UPDATE recording_sessions SET dropped_frames = dropped_frames + ? WHERE id = ?`).run(
        Math.max(0, Math.floor(frames)),
        sessionId,
      )
    },
  }
}
