/**
 * Novel Studio · 导出任务仓储（`export_jobs`，接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6 `export_jobs`（每行 = 一章的导出结果；`chapter_id IS NULL` = 整批任务）
 *   · docs/15 §6  导出报告（ExportReport / ExportChapterResult）
 *   · 005 迁移    新增 `duration_ms`（报告需要「该章导出后的实际时长」）
 *
 * ### 行的关系：批量行 + 章节行
 *   一次导出会写：
 *   · **批量行**：`id = jobId`，`chapter_id IS NULL`，记录整批的状态与参数；
 *   · **章节行**：`id = "{jobId}#{index}"`，`chapter_id` 指向该章。
 *   用「id 前缀」建立关系而不是新增外键列：005 只加了一列（见迁移注释），
 *   而按前缀聚合足够快（一次导出最多几百章，且都有索引）。
 *   **这个约定必须写在这里**，否则后来者会以为这些行毫无关系。
 *
 * ### 为什么失败也要落行
 *   `status='failed'` + `error`（JSON）保留下来，报告里才能显示「哪一章、为什么失败」。
 *   失败行不写 `output_path`（没有产物），但保留 `params_hash`（重试时复用同一份参数的判据）。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, Timestamp } from '../../../../shared/types.ts'

/** 导出任务行的状态（与 DDL 的 CHECK 一致） */
export type ExportJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted'

export interface ExportJobRow {
  id: Id
  projectId: Id
  bookId: Id
  /** null = 整批任务 */
  chapterId: Id | null
  mixProjectId: Id | null
  arrangementId: Id | null
  /** 导出参数（JSON 原样保存） */
  params: string
  paramsHash: string
  outputPath: string | null
  outputSize: number | null
  measuredLufs: number | null
  measuredTpDb: number | null
  adjustedGainDb: number | null
  /** 导出后该章的实际时长（005 加的列） */
  durationMs: number | null
  status: ExportJobStatus
  /** JSON：IpcError（失败时） */
  error: string | null
  /** JSON 数组 */
  warnings: string[]
  startedAt: Timestamp | null
  finishedAt: Timestamp | null
  createdAt: Timestamp
}

export interface ExportJobPatch {
  outputPath?: string | null
  outputSize?: number | null
  measuredLufs?: number | null
  measuredTpDb?: number | null
  adjustedGainDb?: number | null
  durationMs?: number | null
  status?: ExportJobStatus
  error?: string | null
  warnings?: string[]
  startedAt?: Timestamp | null
  finishedAt?: Timestamp | null
}

export interface ExportJobRepo {
  insert(row: ExportJobRow): Promise<ExportJobRow>
  get(jobId: Id): Promise<ExportJobRow | null>
  update(jobId: Id, patch: ExportJobPatch): Promise<ExportJobRow>
  /** 整批行 + 它的章节行（按 id 前缀） */
  listByJob(jobId: Id): Promise<ExportJobRow[]>
  /** 最近的任务（诊断与「上次导出」查询用） */
  listRecent(bookId: Id, limit?: number): Promise<ExportJobRow[]>
  /** 幂等判据：同一章 + 同一参数指纹 + 成功过 */
  findSucceeded(chapterId: Id, paramsHash: string): Promise<ExportJobRow | null>
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准）
// ---------------------------------------------------------------------------

export function createMemoryExportJobRepo(seed?: { rows?: ExportJobRow[]; now?: () => number }): ExportJobRepo {
  const items = new Map<Id, ExportJobRow>()
  const now = seed?.now ?? (() => Date.now())
  for (const r of seed?.rows ?? []) items.set(r.id, cloneRow(r))

  return {
    async insert(row) {
      if (items.has(row.id)) {
        throw new AppError('CONFLICT', { details: { entity: 'export_job', id: row.id } })
      }
      const next = cloneRow({ ...row, createdAt: row.createdAt || now() })
      items.set(next.id, next)
      return cloneRow(next)
    },

    async get(jobId) {
      const row = items.get(jobId)
      return row ? cloneRow(row) : null
    },

    async update(jobId, patch) {
      const cur = items.get(jobId)
      if (!cur) throw new AppError('NOT_FOUND', { details: { entity: 'export_job', id: jobId } })
      const next: ExportJobRow = { ...cur, ...patch, warnings: patch.warnings ?? cur.warnings }
      items.set(jobId, next)
      return cloneRow(next)
    },

    async listByJob(jobId) {
      return [...items.values()]
        .filter((r) => r.id === jobId || r.id.startsWith(`${jobId}#`))
        .sort((a, b) => (a.chapterId === null ? -1 : b.chapterId === null ? 1 : a.id.localeCompare(b.id)))
        .map(cloneRow)
    },

    async listRecent(bookId, limit) {
      return [...items.values()]
        .filter((r) => r.bookId === bookId && r.chapterId === null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit ?? 20)
        .map(cloneRow)
    },

    async findSucceeded(chapterId, paramsHash) {
      const found = [...items.values()].find(
        (r) => r.chapterId === chapterId && r.paramsHash === paramsHash && r.status === 'succeeded',
      )
      return found ? cloneRow(found) : null
    },
  }
}

function cloneRow(r: ExportJobRow): ExportJobRow {
  return { ...r, warnings: [...r.warnings] }
}
