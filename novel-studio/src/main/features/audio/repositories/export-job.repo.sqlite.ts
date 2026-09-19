/**
 * Novel Studio · 导出任务仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `export-job.repo.ts`（接口 + 内存实现）—— 行为基准
 *   · docs/21 §6 `export_jobs` + 005 迁移的 `duration_ms`
 *
 * ### 列清单单一来源
 *   `JOB_COLUMNS` 同时用于 SELECT 与 INSERT（本项目在 take 仓储上真被列序错位坑过，
 *   见 docs/91 §5.2.18）。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import type { ExportJobRepo, ExportJobRow, ExportJobStatus } from './export-job.repo.ts'

const JOB_COLUMNS: readonly string[] = [
  'id',
  'project_id',
  'book_id',
  'chapter_id',
  'mix_project_id',
  'arrangement_id',
  'params',
  'params_hash',
  'output_path',
  'output_size',
  'measured_lufs',
  'measured_tp_db',
  'adjusted_gain_db',
  'duration_ms',
  'status',
  'error',
  'warnings',
  'started_at',
  'finished_at',
  'created_at',
]

const SELECT_JOB = `SELECT ${JOB_COLUMNS.join(', ')} FROM export_jobs`

interface JobSqlRow {
  id: string
  project_id: string
  book_id: string
  chapter_id: string | null
  mix_project_id: string | null
  arrangement_id: string | null
  params: string
  params_hash: string
  output_path: string | null
  output_size: number | null
  measured_lufs: number | null
  measured_tp_db: number | null
  adjusted_gain_db: number | null
  duration_ms: number | null
  status: string
  error: string | null
  warnings: string | null
  started_at: number | null
  finished_at: number | null
  created_at: number
}

export function exportJobFromRow(row: JobSqlRow): ExportJobRow {
  return {
    id: row.id,
    projectId: row.project_id,
    bookId: row.book_id,
    chapterId: row.chapter_id,
    mixProjectId: row.mix_project_id,
    arrangementId: row.arrangement_id,
    params: row.params,
    paramsHash: row.params_hash,
    outputPath: row.output_path,
    outputSize: row.output_size,
    measuredLufs: row.measured_lufs,
    measuredTpDb: row.measured_tp_db,
    adjustedGainDb: row.adjusted_gain_db,
    durationMs: row.duration_ms,
    status: row.status as ExportJobStatus,
    error: row.error,
    warnings: parseWarnings(row.warnings),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }
}

function parseWarnings(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function createSqliteExportJobRepo(db: DbLike, opts?: { now?: () => number }): ExportJobRepo {
  const now = opts?.now ?? (() => Date.now())

  function readOne(jobId: Id): ExportJobRow {
    const row = db.prepare(`${SELECT_JOB} WHERE id = ?`).get(jobId) as JobSqlRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'export_job', id: jobId } })
    return exportJobFromRow(row)
  }

  return {
    async insert(row) {
      try {
        db.prepare(
          `INSERT INTO export_jobs (${JOB_COLUMNS.join(', ')})
           VALUES (${JOB_COLUMNS.map(() => '?').join(', ')})`,
        ).run(
          row.id,
          row.projectId,
          row.bookId,
          row.chapterId,
          row.mixProjectId,
          row.arrangementId,
          row.params,
          row.paramsHash,
          row.outputPath,
          row.outputSize,
          row.measuredLufs,
          row.measuredTpDb,
          row.adjustedGainDb,
          row.durationMs,
          row.status,
          row.error,
          JSON.stringify(row.warnings ?? []),
          row.startedAt,
          row.finishedAt,
          row.createdAt || now(),
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/UNIQUE|PRIMARY/i.test(msg)) {
          throw new AppError('CONFLICT', { cause: e, details: { entity: 'export_job', id: row.id } })
        }
        throw e
      }
      return readOne(row.id)
    },

    async get(jobId) {
      const row = db.prepare(`${SELECT_JOB} WHERE id = ?`).get(jobId) as JobSqlRow | undefined
      return row ? exportJobFromRow(row) : null
    },

    async update(jobId, patch) {
      const cur = readOne(jobId)
      const next = {
        outputPath: patch.outputPath !== undefined ? patch.outputPath : cur.outputPath,
        outputSize: patch.outputSize !== undefined ? patch.outputSize : cur.outputSize,
        measuredLufs: patch.measuredLufs !== undefined ? patch.measuredLufs : cur.measuredLufs,
        measuredTpDb: patch.measuredTpDb !== undefined ? patch.measuredTpDb : cur.measuredTpDb,
        adjustedGainDb: patch.adjustedGainDb !== undefined ? patch.adjustedGainDb : cur.adjustedGainDb,
        durationMs: patch.durationMs !== undefined ? patch.durationMs : cur.durationMs,
        status: patch.status ?? cur.status,
        error: patch.error !== undefined ? patch.error : cur.error,
        warnings: patch.warnings ?? cur.warnings,
        startedAt: patch.startedAt !== undefined ? patch.startedAt : cur.startedAt,
        finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
      }
      db.prepare(
        `UPDATE export_jobs
            SET output_path = ?, output_size = ?, measured_lufs = ?, measured_tp_db = ?,
                adjusted_gain_db = ?, duration_ms = ?, status = ?, error = ?, warnings = ?,
                started_at = ?, finished_at = ?
          WHERE id = ?`,
      ).run(
        next.outputPath,
        next.outputSize,
        next.measuredLufs,
        next.measuredTpDb,
        next.adjustedGainDb,
        next.durationMs,
        next.status,
        next.error,
        JSON.stringify(next.warnings),
        next.startedAt,
        next.finishedAt,
        jobId,
      )
      return readOne(jobId)
    },

    async listByJob(jobId) {
      const rows = db
        .prepare(`${SELECT_JOB} WHERE id = ? OR id LIKE ? ORDER BY id ASC`)
        .all(jobId, `${jobId}#%`) as JobSqlRow[]
      return rows.map(exportJobFromRow)
    },

    async listRecent(bookId, limit) {
      const rows = db
        .prepare(
          `${SELECT_JOB} WHERE book_id = ? AND chapter_id IS NULL ORDER BY created_at DESC LIMIT ?`,
        )
        .all(bookId, Math.max(1, Math.floor(limit ?? 20))) as JobSqlRow[]
      return rows.map(exportJobFromRow)
    },

    async findSucceeded(chapterId, paramsHash) {
      const row = db
        .prepare(
          `${SELECT_JOB} WHERE chapter_id = ? AND params_hash = ? AND status = 'succeeded' LIMIT 1`,
        )
        .get(chapterId, paramsHash) as JobSqlRow | undefined
      return row ? exportJobFromRow(row) : null
    },
  }
}
