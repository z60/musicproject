/**
 * 测试 · 备份目录必须跟随设置（真机反馈 docs/91 §5.2.48）
 * ============================================================================
 * 事故：在「设置 → 路径 → 备份目录」里选了目录，点「立即备份」，文件却落在
 * **启动时算出来的默认目录**（`{userData}/backups`）—— 因为 `createDbPort` 收的是
 * 一个静态字符串 `paths.backupDir`。
 *
 * 修法：`backupDir` 接受取值函数，`backup()` / `listBackups()` **每次现取**
 * （与导出目录 `exportDir: () => …` 同一做法）。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createDbPort } from '../../src/main/db.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { Logger } from '../../src/main/infra/log/index.ts'

const noop = (): void => undefined

/** 最小 logger（只关心事件名，不关心级别） */
function stubLogger(): Logger {
  const events: string[] = []
  const record = () => (event: string): void => {
    events.push(event)
  }
  const stub = {
    level: 'info',
    setLevel: noop,
    error: record(),
    warn: record(),
    info: record(),
    debug: noop,
    trace: noop,
    errorFields: noop,
    child: () => stub,
    write: noop,
    addSink: noop,
    setEntryListener: noop,
    recent: () => [],
    /** 测试断言用 */
    events,
  }
  return stub as unknown as Logger
}

function createTempDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  // `backupDatabase` 会读 meta.schema_version / 写 backups 表；两张表都给上，避免"表不存在"干扰
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '4')`)
  db.exec('CREATE TABLE backups (id TEXT PRIMARY KEY, file_path TEXT, size_bytes INTEGER, schema_version INTEGER, reason TEXT, created_at INTEGER)')
  return db
}

function makePort(opts: { db: DatabaseSync; dbPath: string; backupDir: string | (() => string) }) {
  return createDbPort({
    getDb: () => opts.db as unknown as DbLike,
    dbPath: opts.dbPath,
    backupDir: opts.backupDir,
    log: stubLogger(),
    closeForRestore: noop,
    reopenAfterRestore: async () => ({ ok: true, errors: [] }),
  })
}

describe('数据库备份 · 目标目录必须跟随设置', () => {
  it('backup() 写进"取值函数"给出的目录，而不是启动期默认目录', async () => {
    const defaultDir = mkdtempSync(join(tmpdir(), 'ns-bak-default-'))
    const chosenDir = join(mkdtempSync(join(tmpdir(), 'ns-bak-chosen-')), '我的备份')
    const db = createTempDb()
    const port = makePort({ db, dbPath: join(defaultDir, 'novel-studio.db'), backupDir: () => chosenDir })

    const result = await port.backup()

    assert.ok(result.path.startsWith(chosenDir), `备份文件必须落在所选目录：${result.path}`)
    assert.ok(existsSync(result.path), '备份文件真实存在')
    assert.ok(!existsSync(join(defaultDir, 'novel-studio.db')), '默认目录不该被写进备份（只有 dbPath 的父目录）')
    db.close()
  })

  it('listBackups() 也从"取值函数"的目录读（不看默认目录里的旧备份）', async () => {
    const defaultDir = mkdtempSync(join(tmpdir(), 'ns-bak-default2-'))
    const chosenDir = mkdtempSync(join(tmpdir(), 'ns-bak-chosen2-'))
    const db = createTempDb()
    const port = makePort({ db, dbPath: join(defaultDir, 'novel-studio.db'), backupDir: () => chosenDir })

    // 默认目录里放一个"旧备份"：修改目录后它不该再出现在列表里
    const stray = join(defaultDir, 'novel-studio-2020-01-01T00-00-00.db')
    mkdirSync(dirname(stray), { recursive: true })
    writeFileSync(stray, 'not-a-real-db')

    await port.backup()
    const list = port.listBackups()

    assert.equal(list.length, 1, `只应看到所选目录里的 1 份备份，实际 ${list.length}`)
    assert.ok(list[0]!.filePath.startsWith(chosenDir), `列表项应来自所选目录：${list[0]!.filePath}`)
    db.close()
  })

  it('目录在两次调用之间改了 → 立刻生效（每次现取）', async () => {
    const first = mkdtempSync(join(tmpdir(), 'ns-bak-first-'))
    const second = mkdtempSync(join(tmpdir(), 'ns-bak-second-'))
    const db = createTempDb()
    let current = first
    const port = makePort({ db, dbPath: join(first, 'novel-studio.db'), backupDir: () => current })

    const a = await port.backup()
    current = second
    const b = await port.backup()

    assert.ok(a.path.startsWith(first), `第一次应落在 ${first}`)
    assert.ok(b.path.startsWith(second), `改目录后第二次应落在 ${second}，实际 ${b.path}`)
    db.close()
  })

  it('传普通字符串仍然可用（启动期/迁移前备份等场景）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-bak-string-'))
    const db = createTempDb()
    const port = makePort({ db, dbPath: join(dir, 'novel-studio.db'), backupDir: dir })

    const result = await port.backup()
    assert.ok(result.path.startsWith(dir), `字符串形式也要落在该目录：${result.path}`)
    db.close()
  })
})
