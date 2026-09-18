/**
 * 契约 · `DEFAULT_PROJECT_ID` 在真 schema 上确实解析到默认项目（docs/91 §5.2.4）
 * ============================================================================
 * 渲染进程的「书架为空 → 用默认项目」这条修复，依赖两件事同时成立：
 *   ① `DEFAULT_PROJECT_ID` 就是主进程 `ensureDefault` 使用的那个 id（现在是同一个常量）
 *   ② 把这个 id 交给 `ensureDefault`，在**真 schema** 上会解析到（或建出）默认项目，
 *      而不是失败、也不是每次新建一个
 *
 * 纯函数单测（tests/renderer/project-context.test.ts）只能覆盖「挑哪个 id」，
 * 覆盖不了 ② —— 那需要真 SQLite 与真迁移 SQL。所以这里补上。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createSqliteProjectRepo } from '../../src/main/features/book/import/repositories/project.repo.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { DEFAULT_PROJECT_ID } from '../../src/shared/constants.ts'

const PROJECT_ROOT = 'C:\\ud\\projects'

/** 跑真实迁移链，得到一个与真机同形的库 */
async function migratedDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  return db
}

describe('默认项目 · 与真 schema 的契约', () => {
  it('ensureDefault(DEFAULT_PROJECT_ID) 会建出 id 恰为常量值的默认项目', async () => {
    const db = await migratedDb()
    const repo = createSqliteProjectRepo(db as unknown as DbLike)

    const project = await repo.ensureDefault({ projectId: DEFAULT_PROJECT_ID, projectRoot: PROJECT_ROOT })

    assert.equal(project.id, DEFAULT_PROJECT_ID)
    // 注意分隔符是**正斜杠**：project.repo.ts 的 joinRoot 是刻意用简单拼接的
    // （注释：避免在测试里引入路径差异），因此 Windows 上会得到 `…\projects/default`
    // 这种混合分隔符。真库里的 root_dir 就是这个形状，Windows API 也接受它。
    assert.equal(project.rootDir, `${PROJECT_ROOT}/default`, '目录约定：{projectRoot}/{id}')

    const rows = db.prepare('SELECT id, name, root_dir FROM projects').all() as Array<{
      id: string
      name: string
      root_dir: string
    }>
    assert.equal(rows.length, 1, '只应有一个项目')
    assert.equal(rows[0]?.id, DEFAULT_PROJECT_ID)
  })

  it('重复调用是幂等的（不会每次启动新建一个项目）', async () => {
    const db = await migratedDb()
    const repo = createSqliteProjectRepo(db as unknown as DbLike)

    const first = await repo.ensureDefault({ projectId: DEFAULT_PROJECT_ID, projectRoot: PROJECT_ROOT })
    const second = await repo.ensureDefault({ projectId: DEFAULT_PROJECT_ID, projectRoot: PROJECT_ROOT })

    assert.equal(first.id, second.id)
    assert.equal(first.createdAt, second.createdAt, '第二次必须复用已有项目，而不是重建')
    const n = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
    assert.equal(n, 1)
  })

  it('渲染进程传这个 id 建书时，外键指向的项目一定存在', async () => {
    // books.project_id 是 NOT NULL REFERENCES projects(id)：项目不存在时插入会失败。
    // 这正是「缺 projectId 就写不进书」的数据库层原因。
    const db = await migratedDb()
    const repo = createSqliteProjectRepo(db as unknown as DbLike)
    await repo.ensureDefault({ projectId: DEFAULT_PROJECT_ID, projectRoot: PROJECT_ROOT })

    db.exec('PRAGMA foreign_keys = ON')
    const exists = db.prepare('SELECT id FROM projects WHERE id = ?').get(DEFAULT_PROJECT_ID)
    assert.ok(exists, '默认项目必须已落库，否则 commitImport 的外键插入会失败')
  })
})
