/**
 * 真机事故回归 · 引导期 `settings` 表「遮蔽」迁移建表（docs/91 §5.2.2）
 * ============================================================================
 * 事故链条（每一段都有真机实证）：
 *
 *   1. 启动第 4 步 `open-database` 调 `createSettingsStore`，它用
 *      `CREATE TABLE IF NOT EXISTS settings` 建了一张**窄表**（key / value / updated_at）
 *   2. 第 5 步 `run-migrations` 跑 `001_init.sql`，其中
 *      `CREATE TABLE IF NOT EXISTS settings (… is_secret …)` 因为表已存在而**变成空操作**
 *   3. 紧接着 `CREATE INDEX IF NOT EXISTS idx_settings_secret ON settings(is_secret)`
 *      报 `no such column: is_secret` → 单事务回滚 → **一张业务表都没建出来**
 *   4. `meta` 也在同一个事务里，于是 schema_version 恒为 0 ⇒ 每次启动都重试、每次都失败
 *      ⇒ **重启无效、重装无效**（重装不会删 userData 里的库）
 *
 * 用户看到的是点「书架」报 E70011「数据表不完整：缺少「books」这张表」。
 * **`books` 只是最后一个症状，根因在 `settings`。**
 *
 * ### 为什么这个文件用 `node:sqlite`，而不是 shared 的 fake-db
 * `tests/main/helpers/fake-db.ts` 明确「不解析 SQL」，因此**永远抓不到 `no such column`** ——
 * 拿它测这个 bug 会得到一条永远为绿的测试（本仓库已经吃过一次「测试永远是绿的」的教训，
 * 见 docs/91 §5.1）。`node:sqlite`（Node 22.5+ 内置）是**真 SQLite 引擎**，
 * 而 Node 里加载不了 better-sqlite3（它按 Electron ABI 编译），所以这是唯一可行
 * 且足够真实的离线验证手段。这里连迁移器 `migrate()` 一起跑，顺带验证「失败整体回滚」。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { currentSchemaVersion, migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { SETTINGS_BOOTSTRAP_DDL, createSettingsStore } from '../../src/main/settings.ts'

const PATHS = {
  projectRoot: '/ud/projects',
  exportDir: '/ud/exports',
  ffmpegPath: null,
  modelDir: '/res/models',
  cacheDir: '/ud/cache',
  backupDir: '/ud/backups',
}

/**
 * 历史版本（有缺陷）的引导期 DDL —— 真机库里现存的就是这个形状。
 * 它比 `001_init.sql` 的 `settings` **少一列 `is_secret`**。
 */
const LEGACY_NARROW_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);`

/** `DatabaseSync` 结构化兼容 `DbLike`（Node 内置驱动与 better-sqlite3 的 API 子集一致） */
function asDb(db: DatabaseSync): DbLike {
  return db as unknown as DbLike
}

function tablesOf(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  return rows.map((r) => r.name).sort()
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/** 跑完整迁移链（与 `src/main/db.ts::runMigrations` 同源：loadMigrations + migrate） */
async function runAllMigrations(db: DatabaseSync): Promise<{ applied: number; to: number }> {
  return migrate(asDb(db), loadMigrations(), { log: () => {} })
}

/**
 * 取一份「可读的完整诊断」= 外层文案 + 完整原因链。
 *
 * 为什么不只看 `e.message`：迁移失败被包成 `AppError('DB_MIGRATION_FAILED')`，
 * 它的 message 是给用户看的固定文案「数据升级失败」，**真实原因（缺哪一列）只在
 * `causeChain` 里** —— 这正是本仓库踩过的坑（docs/91 §5.2.1 第 3 条教训）。
 * 断言必须打在原因链上，否则测试会「看起来在验真因，其实什么都没验」。
 */
function diagnosisOf(e: unknown): string {
  const err = e as { message?: unknown; causeChain?: unknown }
  const chain = Array.isArray(err.causeChain) ? err.causeChain.join(' | ') : ''
  return `${String(err.message ?? '')} :: ${chain}`
}

// ---------------------------------------------------------------------------
// ① 全新库：引导期先建表，迁移必须仍然建出全部业务表
// ---------------------------------------------------------------------------

describe('settings 引导期建表不得遮蔽迁移（全新库）', () => {
  it('先 createSettingsStore 再迁移 → 迁移成功，books 存在', async () => {
    const db = new DatabaseSync(':memory:')

    // 启动第 4 步：库是全新的，settings 表由这里创建
    createSettingsStore({ db: asDb(db), pathDefaults: PATHS })

    // 启动第 5 步
    const res = await runAllMigrations(db)

    assert.equal(res.applied, 2, 'init 与 seed 都应被应用')
    const tables = tablesOf(db)
    assert.ok(tables.includes('books'), `迁移后必须有 books，实际表：${tables.join(', ')}`)
    assert.ok(tables.includes('projects'))
    assert.ok(tables.includes('meta'))
    assert.equal(currentSchemaVersion(asDb(db)), 2)
  })

  it('迁移后的 settings 表列齐全（is_secret 在位）', async () => {
    const db = new DatabaseSync(':memory:')
    createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
    await runAllMigrations(db)

    const cols = columnsOf(db, 'settings')
    for (const c of ['key', 'value', 'is_secret', 'updated_at']) {
      assert.ok(cols.includes(c), `settings 缺列 ${c}（实际：${cols.join(', ')}）`)
    }
  })
})

// ---------------------------------------------------------------------------
// ② 真机形态：库里**已经**是那张窄表（本次事故的实际状态）
// ---------------------------------------------------------------------------

describe('settings 引导期建表不得遮蔽迁移（真机残缺库）', () => {
  it('历史窄表 + 已有数据 → 修复后迁移成功，且用户数据不丢', async () => {
    const db = new DatabaseSync(':memory:')

    // 真机库现状：只有一张窄 settings，里面有用户设置
    db.exec(LEGACY_NARROW_SETTINGS_DDL)
    db.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('ui.theme', '"dark"', 0)`)

    // 启动第 4 步：应当就地补列（SQLite 没有 ADD COLUMN IF NOT EXISTS）
    createSettingsStore({ db: asDb(db), pathDefaults: PATHS })

    const cols = columnsOf(db, 'settings')
    assert.ok(cols.includes('is_secret'), `引导期应补上 is_secret，实际：${cols.join(', ')}`)

    // 启动第 5 步：这次必须真的跑通
    const res = await runAllMigrations(db)
    assert.equal(res.applied, 2)
    assert.ok(tablesOf(db).includes('books'), '迁移后必须有 books')

    // 补列是 ALTER TABLE ADD COLUMN，原有行与取值必须原样保留
    const row = db.prepare(`SELECT value, is_secret FROM settings WHERE key = 'ui.theme'`).get() as
      | { value: string; is_secret: number }
      | undefined
    assert.ok(row, '用户原有的设置行不能丢')
    assert.equal(row.value, '"dark"')
    assert.equal(Number(row.is_secret), 0, '补出来的列要取默认值 0')
  })

  it('重复启动（引导期反复补列）是幂等的', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(LEGACY_NARROW_SETTINGS_DDL)

    createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
    createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
    createSettingsStore({ db: asDb(db), pathDefaults: PATHS })

    await runAllMigrations(db)
    // 再跑一次迁移：没有待应用项，且不报错
    const again = await runAllMigrations(db)
    assert.equal(again.applied, 0, '已迁移完的库不应重复应用')
    assert.ok(tablesOf(db).includes('books'))
  })
})

// ---------------------------------------------------------------------------
// ③ 故意打破：证明这条测试真的能抓住这个 bug（否则它只是装饰）
// ---------------------------------------------------------------------------

/**
 * 注意一个**测试环境差异**：node:sqlite 抛的 code 是 `ERR_SQLITE_ERROR`，
 * 而 better-sqlite3 抛的是 `SQLITE_ERROR`。`detectSqliteSchemaError` 认的是后者，
 * 所以在这里 `no such column` 不会映射成 `DB_SCHEMA_INCOMPLETE`（E70011）——
 * 那条映射由 tests/shared/errors.test.ts 按 better-sqlite3 的真实错误形态单独验证。
 * 本文件只负责证明「SQL 真的跑不过，且事务整体回滚」。
 */
describe('故意打破 · 不补列就必然永久失败', () => {
  it('窄 settings 表 + 直接迁移 → 报 no such column: is_secret，且整体回滚', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(LEGACY_NARROW_SETTINGS_DDL) // 故意**不**调 createSettingsStore（= 不补列）

    await assert.rejects(
      () => runAllMigrations(db),
      (e: unknown) => {
        // 断言打在**原因链**上：真因（no such column: is_secret）在链里，不在 message 里
        assert.match(diagnosisOf(e), /no such column: is_secret/, '必须明确指向缺失的列')
        return true
      },
    )

    // 事务整体回滚 ⇒ 一张业务表都没留下，schema_version 仍是 0 ⇒ 下次启动还会重试
    const tables = tablesOf(db)
    assert.deepEqual(tables, ['settings'], `回滚后只应剩 settings，实际：${tables.join(', ')}`)
    assert.ok(!tables.includes('books'))
    assert.equal(currentSchemaVersion(asDb(db)), 0)
  })
})

// ---------------------------------------------------------------------------
// ④ 防复发：引导期 DDL 与迁移 DDL 的 settings 列集合必须一致
// ---------------------------------------------------------------------------

describe('防复发 · 两处 settings DDL 必须同形', () => {
  it('引导期兜底 DDL 的列与 001_init.sql 的列完全相同', () => {
    const initSql = loadMigrations().find((m) => m.version === 1)?.sql
    assert.ok(initSql, '找不到 version=1 的迁移')

    const fromMigration = new DatabaseSync(':memory:')
    fromMigration.exec(initSql)
    const fromBootstrap = new DatabaseSync(':memory:')
    fromBootstrap.exec(SETTINGS_BOOTSTRAP_DDL)

    // 顺序也一并要求一致：列序不同意味着「表形状」已经分叉，早晚还会出事
    assert.deepEqual(
      columnsOf(fromBootstrap, 'settings'),
      columnsOf(fromMigration, 'settings'),
      '引导期兜底 DDL 与 001_init.sql 的 settings 列必须完全一致 —— ' +
        '前者**早于**迁移执行，比迁移窄就会把迁移的建表语句变成空操作（docs/91 §5.2.2）',
    )
  })
})
