/**
 * Novel Studio · 音频域的项目归属解析（主进程侧）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §2 「数据库里只存**相对于 `projects/{projectId}/` 的路径**」
 *   · docs/02 §3 `ns-media://{projectId}/{relPath}` 的协议校验（必须落在项目目录内）
 *   · `infra/fs/paths.ts` 的 `resolveProjectPath(projectId, relPath, projectRoot)`
 *
 * ### 为什么需要这个模块（真问题，不是过度设计）
 *   音频域的服务**只拿到相对路径**（`takes/{lineId}/{takeId}.wav`、`recordings/{id}.wav`…），
 *   而相对路径的基准目录是 `{projectRoot}/{projectId}`、**不是** `{projectRoot}`。
 *   录制域落地前，take / analysis 直接把相对路径拼在了 `projectRoot` 上，于是文件被写到
 *   `{userData}/projects/segments/x.wav`，而渲染进程播放走的是
 *   `ns-media://{projectId}/segments/x.wav` → `{userData}/projects/{projectId}/segments/x.wav`
 *   —— **两个位置**：试听 404，而主进程自己读得到（因为读写用了同一套错路径），
 *   这种「一半能用」的错最难察觉。见 docs/91 §5.2.19。
 *
 * ### 为什么不用「当前项目」全局变量
 *   主进程里放一个 `currentProjectId` 看着省事，但它的取值取决于「上一次谁调过哪个通道」，
 *   一旦串了就会安静地把音频写进别的项目目录。这里的做法是**每次按数据自己推**：
 *   行 → 章节 → 书 → 项目；会话直接带 project_id；只有「谁都不认领的裸路径」
 *   才在多项目时报错，而不是猜一个。
 */

import { AppError } from '../../../shared/errors.ts'
import type { Id } from '../../../shared/types.ts'
import type { DbLike } from '../../infra/db/types.ts'

export interface AudioProjectScope {
  /** 画本行 → 项目 id */
  projectIdOfLine(lineId: Id): Promise<Id>
  /** take → 项目 id（经 canvas_lines → chapters → books） */
  projectIdOfTake(takeId: Id): Promise<Id>
  /** 成品片段 → 项目 id */
  projectIdOfSegment(segmentId: Id): Promise<Id>
  /** 录音会话 → 项目 id（它自己就有 project_id 列，不用绕） */
  projectIdOfSession(sessionId: Id): Promise<Id>
  /**
   * 任意项目内相对路径 → 项目 id。
   *
   * 规则（按顺序）：
   *   1. 在 `takes` / `voice_segments` / `recording_sessions` 里找 `file_path` 的归属；
   *   2. 找不到时，若库里**只有一个**项目 → 用它（中间产物如 `cache/tmp/*.wav` 没有任何行认领）；
   *   3. 多项目 + 无归属 → 抛 `INVALID_PAYLOAD`（`reason: 'project-not-resolvable'`）。
   *      猜一个项目的后果是「读到别的项目的同名文件」，比报错糟得多。
   */
  projectIdOfPath(relativePath: string): Promise<Id>
  /** 当前项目列表（用于「只有一个项目」的兜底与诊断） */
  listProjectIds(): Promise<Id[]>
}

/** 音频路径归属解析依赖：只要一个「现取 db」的函数（库可能被「从备份恢复」换掉） */
export interface AudioProjectScopeDeps {
  getDb: () => DbLike | null
}

export function createAudioProjectScope(deps: AudioProjectScopeDeps): AudioProjectScope {
  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'audio-scope' } })
    return db
  }

  /** 行 → 项目：canvas_lines → chapters → books → projects */
  function queryLine(lineId: Id): Id | null {
    const row = requireDb()
      .prepare(
        `SELECT b.project_id AS project_id
           FROM canvas_lines l
           JOIN chapters c ON c.id = l.chapter_id
           JOIN books b ON b.id = c.book_id
          WHERE l.id = ?`,
      )
      .get(lineId) as { project_id: string | null } | undefined
    return row?.project_id ?? null
  }

  async function listProjectIds(): Promise<Id[]> {
    const rows = requireDb().prepare(`SELECT id FROM projects ORDER BY id ASC`).all() as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  return {
    async projectIdOfLine(lineId) {
      const projectId = queryLine(lineId)
      if (!projectId) {
        throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId } })
      }
      return projectId
    },

    async projectIdOfTake(takeId) {
      const row = requireDb()
        .prepare(
          `SELECT b.project_id AS project_id
             FROM takes t
             JOIN canvas_lines l ON l.id = t.line_id
             JOIN chapters c ON c.id = l.chapter_id
             JOIN books b ON b.id = c.book_id
            WHERE t.id = ?`,
        )
        .get(takeId) as { project_id: string | null } | undefined
      if (!row?.project_id) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
      return row.project_id
    },

    async projectIdOfSegment(segmentId) {
      const row = requireDb()
        .prepare(
          `SELECT b.project_id AS project_id
             FROM voice_segments s
             JOIN canvas_lines l ON l.id = s.line_id
             JOIN chapters c ON c.id = l.chapter_id
             JOIN books b ON b.id = c.book_id
            WHERE s.id = ?`,
        )
        .get(segmentId) as { project_id: string | null } | undefined
      if (!row?.project_id) {
        throw new AppError('NOT_FOUND', { details: { entity: 'voice_segment', segmentId } })
      }
      return row.project_id
    },

    async projectIdOfSession(sessionId) {
      const row = requireDb()
        .prepare(`SELECT project_id FROM recording_sessions WHERE id = ?`)
        .get(sessionId) as { project_id: string } | undefined
      if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'recording_session', sessionId } })
      return row.project_id
    },

    async projectIdOfPath(relativePath) {
      const db = requireDb()
      const normalized = relativePath.replace(/\\/g, '/')
      // ① 音频表里找归属（takes / voice_segments / recording_sessions 是「项目内音频」的全部来源）
      const owners: Array<{ sql: string }> = [
        {
          sql: `SELECT b.project_id AS project_id
                  FROM takes t
                  JOIN canvas_lines l ON l.id = t.line_id
                  JOIN chapters c ON c.id = l.chapter_id
                  JOIN books b ON b.id = c.book_id
                 WHERE t.file_path = ? LIMIT 1`,
        },
        {
          sql: `SELECT b.project_id AS project_id
                  FROM voice_segments s
                  JOIN canvas_lines l ON l.id = s.line_id
                  JOIN chapters c ON c.id = l.chapter_id
                  JOIN books b ON b.id = c.book_id
                 WHERE s.file_path = ? LIMIT 1`,
        },
        { sql: `SELECT project_id FROM recording_sessions WHERE file_path = ? LIMIT 1` },
      ]
      for (const o of owners) {
        const row = db.prepare(o.sql).get(normalized) as { project_id: string | null } | undefined
        if (row?.project_id) return row.project_id
      }

      // ② 没有行认领（中间产物）：只有唯一项目时才敢确定
      const ids = await listProjectIds()
      if (ids.length === 1) return ids[0]!
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          op: 'audio:projectScope',
          reason: 'project-not-resolvable',
          relativePath: normalized,
          projectCount: ids.length,
          hint:
            ids.length === 0
              ? '库里还没有项目：先导入一本书（导入时会自动创建默认项目）'
              : '该路径不被任何 take/片段/会话认领，且库里有多个项目 —— 请改用 segmentId 或先落库',
        },
      })
    },

    async listProjectIds() {
      return listProjectIds()
    },
  }
}
