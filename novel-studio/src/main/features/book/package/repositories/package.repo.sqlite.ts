/**
 * Novel Studio · 项目包 / 任务包历史仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `package.repo.ts`（接口 + 内存实现）—— 行为基准
 *   · docs/21 §6 `packages` 表（列与 CHECK 约束的唯一口径）
 *
 * ### 列清单单一来源
 *   `PACKAGE_COLUMNS` 同时用于 SELECT 与 INSERT。本项目在 take 仓储上真被
 *   「列序错位」坑过（见 docs/91 §5.2.18）：INSERT 的列名与 VALUES 的实参顺序
 *   一旦靠人肉对齐，加一列就会静默错位（status 写进 stats 这种）。
 *
 * ### JSON 列的处理
 *   `manifest` / `stats` / `report` 在库里是 TEXT，在本层出口是**解析后的对象**：
 *   解析失败一律退化成 null 并**不抛错** —— 一行坏 JSON 不该让「包历史」整个打不开，
 *   用户要看到的是「这条记录信息不全」，而不是一个空白页面。
 *
 * ### 为什么 project_id 不设 deleted_at 之类的软删
 *   `packages.project_id` 是 `ON DELETE CASCADE`（docs/21 §6）：项目删了，
 *   它的包历史一起走。包文件本身留在磁盘上（用户可以自己找回来），
 *   但历史记录跟着项目走 —— 这是 docs/03 §10「项目级导出由用户自管」的解读。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { Id, TaskPackageMergeReport } from '../../../../../shared/types.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import type {
  PackageDirection,
  PackageKind,
  PackageRepo,
  PackageRow,
  PackageStats,
  PackageStatus,
} from './package.repo.ts'

/** INSERT 与 SELECT 共用的列顺序（唯一来源） */
const PACKAGE_COLUMNS: readonly string[] = [
  'id',
  'project_id',
  'kind',
  'direction',
  'actor_id',
  'book_id',
  'file_path',
  'lines_hash',
  'manifest',
  'stats',
  'status',
  'report',
  'created_at',
  'finished_at',
]

const SELECT_PACKAGE = `SELECT ${PACKAGE_COLUMNS.join(', ')} FROM packages`

interface PackageSqlRow {
  id: string
  project_id: string
  kind: string
  direction: string
  actor_id: string | null
  book_id: string | null
  file_path: string
  lines_hash: string | null
  manifest: string | null
  stats: string | null
  status: string
  report: string | null
  created_at: number
  finished_at: number | null
}

/** SQL 行 → 领域行（导出给测试与调试用，便于绕过仓储直接断言） */
export function packageFromRow(row: PackageSqlRow): PackageRow {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as PackageKind,
    direction: row.direction as PackageDirection,
    actorId: row.actor_id,
    bookId: row.book_id,
    filePath: row.file_path,
    linesHash: row.lines_hash,
    manifest: parseJson(row.manifest),
    stats: (parseJson(row.stats) as PackageStats | null) ?? null,
    status: row.status as PackageStatus,
    report: (parseJson(row.report) as TaskPackageMergeReport | null) ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

/** 坏 JSON 不抛错：只当这一列没值（见文件头「JSON 列的处理」） */
function parseJson(text: string | null): unknown {
  if (text === null || text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function toText(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

export function createSqlitePackageRepo(db: DbLike, opts?: { now?: () => number }): PackageRepo {
  const now = opts?.now ?? (() => Date.now())

  function readOne(id: Id): PackageRow {
    const row = db.prepare(`${SELECT_PACKAGE} WHERE id = ?`).get(id) as PackageSqlRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'package', id } })
    return packageFromRow(row)
  }

  return {
    async insert(row) {
      try {
        db.prepare(
          `INSERT INTO packages (${PACKAGE_COLUMNS.join(', ')})
           VALUES (${PACKAGE_COLUMNS.map(() => '?').join(', ')})`,
        ).run(
          row.id,
          row.projectId,
          row.kind,
          row.direction,
          row.actorId,
          row.bookId,
          row.filePath,
          row.linesHash,
          toText(row.manifest),
          toText(row.stats),
          row.status,
          toText(row.report),
          row.createdAt || now(),
          row.finishedAt,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/UNIQUE|PRIMARY/i.test(msg)) {
          throw new AppError('CONFLICT', { cause: e, details: { entity: 'package', id: row.id } })
        }
        throw e
      }
      return readOne(row.id)
    },

    async update(id, patch) {
      const cur = readOne(id)
      const next = {
        filePath: patch.filePath !== undefined ? patch.filePath : cur.filePath,
        linesHash: patch.linesHash !== undefined ? patch.linesHash : cur.linesHash,
        manifest: patch.manifest !== undefined ? patch.manifest : cur.manifest,
        stats: patch.stats !== undefined ? patch.stats : cur.stats,
        status: patch.status ?? cur.status,
        report: patch.report !== undefined ? patch.report : cur.report,
        finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
      }
      db.prepare(
        `UPDATE packages
            SET file_path = ?, lines_hash = ?, manifest = ?, stats = ?, status = ?,
                report = ?, finished_at = ?
          WHERE id = ?`,
      ).run(
        next.filePath,
        next.linesHash,
        toText(next.manifest),
        toText(next.stats),
        next.status,
        toText(next.report),
        next.finishedAt,
        id,
      )
      return readOne(id)
    },

    async get(id) {
      const row = db.prepare(`${SELECT_PACKAGE} WHERE id = ?`).get(id) as PackageSqlRow | undefined
      return row ? packageFromRow(row) : null
    },

    async listByProject(projectId, limit) {
      const rows = db
        .prepare(`${SELECT_PACKAGE} WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(projectId, Math.max(1, Math.floor(limit ?? 200))) as PackageSqlRow[]
      return rows.map(packageFromRow)
    },

    async lastMerge(projectId) {
      // `report IS NOT NULL` 是刻意的：失败或未收尾的合并行没有报告，
      // 拿它当「上次合并报告」会让 UI 显示一个空报告（比 null 更难排查）。
      const row = db
        .prepare(
          `${SELECT_PACKAGE}
            WHERE project_id = ? AND direction = 'merge' AND report IS NOT NULL
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(projectId) as PackageSqlRow | undefined
      return row ? packageFromRow(row) : null
    },
  }
}
