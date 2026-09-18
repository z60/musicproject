/**
 * Novel Studio · 项目仓库（SQLite）
 * ============================================================================
 * 设计依据：docs/03 §2「目录结构」、docs/21「projects 表」、docs/01 §10 第 4 步
 *
 * ### 为什么需要「确保默认项目存在」
 *   契约里 `books.project_id` 是 `NOT NULL REFERENCES projects(id)`（外键），
 *   而 `session.projectId` 又是从 `book.projectId` 派生的 —— 于是出现**鸡生蛋**：
 *   要有书才能拿到 projectId，但建书必须有 projectId。
 *
 *   而契约里**没有** `project:create` 通道，渲染进程也无从创建项目。
 *   同时 `book:list` 的 `projectId` 是**可选**的，也就是「不给项目也能列全部书」
 *   本来就是预期用法。
 *
 *   结论：项目是**基础设施**，不是用户可见的概念。因此本仓库提供
 *   {@link ProjectRepo.ensureDefault}：启动时（或首次导入时）保证至少有一个
 *   默认项目，其目录为 `{projectRoot}/{id}`（docs/03 §2 的约定）。
 *
 *   这是本轮补上的设计缺口，已记入 docs/91。
 */

import { DEFAULT_PROJECT_ID } from '../../../../../shared/constants.ts'
import type { Id, Timestamp } from '../../../../../shared/types.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import { projectFromRow, type Project, type ProjectRow } from './mappers.ts'

export interface ProjectRepo {
  findById(id: Id): Promise<Project | null>
  list(): Promise<Project[]>
  count(): Promise<number>
  insert(project: Project): Promise<void>
  /**
   * 确保项目存在：
   *   · 给了 id 且已存在 → 原样返回
   *   · 给了 id 但不存在 → 用它建（目录 `{projectRoot}/{id}`）
   *   · 没给 id → 返回已有的（若有），否则创建一个默认项目
   */
  ensureDefault(opts: {
    projectId?: Id | null
    projectRoot: string
    name?: string
    now?: () => Timestamp
    newId?: () => Id
  }): Promise<Project>
}

/**
 * 默认项目的 id 已迁到 `shared/constants.ts`（渲染进程也要用它来解「书架为空」时的死锁，
 * 见那里的注释与 docs/91 §5.2.4）。这里转出一次，保持既有引用路径可用。
 */
export { DEFAULT_PROJECT_ID }

const INSERT_SQL = `
INSERT INTO projects (id, name, description, root_dir, schema_version, settings, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`

export function createSqliteProjectRepo(db: DbLike): ProjectRepo {
  const selectOne = `SELECT * FROM projects WHERE deleted_at IS NULL AND id = ?`

  async function findById(id: Id): Promise<Project | null> {
    const row = db.prepare(selectOne).get(id) as ProjectRow | undefined
    return row ? projectFromRow(row) : null
  }

  async function list(): Promise<Project[]> {
    const rows = db
      .prepare(`SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC`)
      .all() as ProjectRow[]
    return rows.map(projectFromRow)
  }

  async function count(): Promise<number> {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL`).get() as
      | { n: number }
      | undefined
    return row?.n ?? 0
  }

  async function insert(project: Project): Promise<void> {
    db.prepare(INSERT_SQL).run(
      project.id,
      project.name,
      project.description,
      project.rootDir,
      project.schemaVersion,
      null, // settings：项目级覆盖设置，暂不写入（用全局设置）
      project.createdAt,
      project.updatedAt,
    )
  }

  async function ensureDefault(opts: {
    projectId?: Id | null
    projectRoot: string
    name?: string
    now?: () => Timestamp
    newId?: () => Id
  }): Promise<Project> {
    const now = opts.now ?? Date.now

    // 1) 指定了 id：存在就复用，不存在就用它建
    const wanted = opts.projectId ?? null
    if (wanted) {
      const found = await findById(wanted)
      if (found) return found
      const created: Project = {
        id: wanted,
        name: opts.name ?? '默认项目',
        description: null,
        rootDir: joinRoot(opts.projectRoot, wanted),
        schemaVersion: 1,
        createdAt: now(),
        updatedAt: now(),
      }
      await insert(created)
      return created
    }

    // 2) 没指定 id：优先复用任意已有的项目（避免每次启动新建一个）
    const existing = await list()
    if (existing.length > 0) return existing[0]!

    // 3) 一个都没有：建默认项目
    const id = DEFAULT_PROJECT_ID
    const created: Project = {
      id,
      name: opts.name ?? '默认项目',
      description: '应用首次启动时自动创建；书籍与录音都归属它。',
      rootDir: joinRoot(opts.projectRoot, id),
      schemaVersion: 1,
      createdAt: now(),
      updatedAt: now(),
    }
    await insert(created)
    return created
  }

  return { findById, list, count, insert, ensureDefault }
}

/** `{projectRoot}/{id}`；用简单拼接而不是 path.join 以避免在测试里引入路径差异 */
function joinRoot(root: string, id: Id): string {
  const sep = root.endsWith('/') || root.endsWith('\\') ? '' : '/'
  return `${root}${sep}${id}`
}
