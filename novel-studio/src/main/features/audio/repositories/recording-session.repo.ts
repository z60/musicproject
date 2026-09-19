/**
 * Novel Studio · 录音会话仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6 `recording_sessions` 表（status / marks(JSON) / dropped_frames / gain_db）
 *   · docs/12 §13「dropped_frames 必须恒为 0；非 0 即 P0 缺陷」——所以它是一等字段，不是日志
 *   · docs/12 §9「会话文件永不自动删（清理时需要用户显式确认）」
 *
 * ### 会话与 take 的关系
 *   会话是**原始素材**，take 是从会话里剪出来的成品候选。一次会话可以产出多条 take
 *   （连续模式切句），因此 `takes.session_id` 是多对一。删会话不会删 take
 *   （`ON DELETE SET NULL`），这里也**不提供** `remove`：契约里没有「删会话」通道，
 *   物理删除只能靠用户显式清理（`bootstrap/cleanup.ts` 的保留策略）。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, RecordingSession, SessionStatus, Timestamp } from '../../../../shared/types.ts'

export interface RecordingSessionRepo {
  insert(session: RecordingSession): Promise<RecordingSession>
  get(sessionId: Id): Promise<RecordingSession | null>
  /** 按章节列会话（连续录制/补录复盘用），最新在前 */
  listByChapter(chapterId: Id): Promise<RecordingSession[]>
  /** 按项目列会话（诊断与清理用），最新在前 */
  listByProject(projectId: Id, limit?: number): Promise<RecordingSession[]>
  /**
   * 定稿：写入最终时长/测量值/状态/结束时间。
   *
   * 为什么单独一个方法而不是通用 `update(patch)`：定稿是**一次性的状态跃迁**
   * （active → finalized/failed），写成通用补丁的话「谁都能把已定稿的会话改回 active」，
   * 而 `listByChapter` 之类的查询是按 status 过滤的，那种改动会安静地改变查询结果。
   */
  finalize(
    sessionId: Id,
    patch: {
      status: Extract<SessionStatus, 'finalized' | 'failed' | 'aborted' | 'recovered'>
      durationMs: number
      peakDb: number | null
      rmsDb: number | null
      droppedFrames: number
      finishedAt: Timestamp
    },
  ): Promise<RecordingSession>
  /** 录制中更新标记（`record:mark`，单向通道；不改变 status） */
  setMarks(sessionId: Id, marks: RecordingSession['marks']): Promise<RecordingSession>
  /** 录制中累计丢帧（非 0 即 P0，见文件头） */
  addDroppedFrames(sessionId: Id, frames: number): Promise<void>
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准，测试与无库环境用）
// ---------------------------------------------------------------------------

export function createMemoryRecordingSessionRepo(seed?: {
  sessions?: RecordingSession[]
  now?: () => Timestamp
}): RecordingSessionRepo {
  const items = new Map<Id, RecordingSession>()
  const now = seed?.now ?? (() => Date.now())
  for (const s of seed?.sessions ?? []) items.set(s.id, cloneSession(s))

  function requireSession(sessionId: Id): RecordingSession {
    const s = items.get(sessionId)
    if (!s) {
      // 会话不存在时**必须报错**：静默忽略会让「点了停止但什么都没发生」无从排查
      throw sessionNotFound(sessionId)
    }
    return s
  }

  return {
    async insert(session) {
      if (items.has(session.id)) {
        throw new AppError('CONFLICT', { details: { entity: 'recording_session', id: session.id } })
      }
      const next = cloneSession({ ...session, startedAt: session.startedAt || now() })
      items.set(next.id, next)
      return cloneSession(next)
    },

    async get(sessionId) {
      const s = items.get(sessionId)
      return s ? cloneSession(s) : null
    },

    async listByChapter(chapterId) {
      return [...items.values()]
        .filter((s) => s.chapterId === chapterId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(cloneSession)
    },

    async listByProject(projectId, limit) {
      const list = [...items.values()]
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(cloneSession)
      return limit === undefined ? list : list.slice(0, limit)
    },

    async finalize(sessionId, patch) {
      const s = requireSession(sessionId)
      const next: RecordingSession = {
        ...s,
        status: patch.status,
        durationMs: patch.durationMs,
        peakDb: patch.peakDb,
        rmsDb: patch.rmsDb,
        droppedFrames: patch.droppedFrames,
        finishedAt: patch.finishedAt,
      }
      items.set(sessionId, next)
      return cloneSession(next)
    },

    async setMarks(sessionId, marks) {
      const s = requireSession(sessionId)
      const next: RecordingSession = { ...s, marks: marks.map((m) => ({ ...m })) }
      items.set(sessionId, next)
      return cloneSession(next)
    },

    async addDroppedFrames(sessionId, frames) {
      const s = requireSession(sessionId)
      items.set(sessionId, { ...s, droppedFrames: s.droppedFrames + frames })
    },
  }
}

function sessionNotFound(sessionId: Id): AppError {
  return new AppError('NOT_FOUND', { details: { entity: 'recording_session', sessionId } })
}

function cloneSession(s: RecordingSession): RecordingSession {
  return {
    ...s,
    format: { ...s.format },
    marks: s.marks.map((m) => ({ ...m })),
  }
}
