/**
 * 真机事故回归 · 一次设置保存把整棵设置树写成 null，应用再也起不来（docs/91 §5.2.3）
 * ============================================================================
 * 事故链条（每一段都有真机实证）：
 *
 *   1. 用户只在 UI 上改了一个分组（「路径」→ 书籍保存位置）
 *   2. IPC 校验层 `ObjectSchema._parse`（infra/validate/schema.ts）会把 shape 里
 *      **每一个**键都物化进结果 —— 输入里没出现的分组就变成 `undefined`。
 *      于是到达 `settings.set()` 的补丁其实是「12 个分组全在、其中 11 个是 `undefined`」。
 *      （这是**有意为之**并有测试断言的行为，见 tests/main/validate.test.ts:132/107。）
 *   3. `applyPatch` 把 `undefined` 当成"给整支赋值" → 内存里 `audio`/`import`/… 全变成
 *      `undefined`；`persist` 里 `JSON.stringify(v ?? null)` 把它们写成了 **`null`**
 *   4. 下次启动 `loadFromDb` 读到 `import = null`，用这个 null 覆盖整棵树
 *   5. `ports.ts` 读 `state.settings?.current().import.maxFileSizeBytes`：
 *      `?.` 只护住了 `state.settings`，`.import` 为 null 时
 *      `TypeError: Cannot read properties of null (reading 'maxFileSizeBytes')`
 *      → 启动在第 11 步（register-ipc-handlers）中止 → **每次启动都失败**
 *
 * 真机库里存下来的 17 行（时间戳同一毫秒，可完整重建）：
 *   paths.projectRoot=null  paths.exportDir="…\book"  paths.ffmpegPath=null
 *   paths.modelDir=null  paths.cacheDir=null  paths.backupDir=null
 *   audio=null  recording=null  canvas=null  mixing=null  export=null  ai=null
 *   embedding=null  asr=null  import=null  ui=null  advanced=null
 *
 * ### 三条防线（本文件各钉一条）
 *   · **写**：分组键绝不能被 `undefined`/`null` 赋整支
 *   · **读**：分组行形状不符时忽略（坏值不得让应用起不来）
 *   · **启动**：取值级兜底（`import?.maxFileSizeBytes`）
 *
 * 用 `node:sqlite`（真 SQLite 引擎）而非 fake-db：本仓库的 fake-db 不解析 SQL，
 * 也不实现 settings 表的读写，撑不起这条链路。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { IPC_REQ_SCHEMAS } from '../../src/main/ipc/schemas.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createSettingsStore } from '../../src/main/settings.ts'
import { IMPORT_LIMITS } from '../../src/shared/constants.ts'

const PATHS = {
  projectRoot: 'C:\\ud\\projects',
  exportDir: 'C:\\ud\\exports',
  ffmpegPath: null,
  modelDir: 'C:\\res\\models',
  cacheDir: 'C:\\ud\\cache',
  backupDir: 'C:\\ud\\backups',
}

/** 真机里被写坏的 11 个分组行（`applyPatch` 事故的直接产物） */
const CORRUPTED_BRANCHES = [
  'audio',
  'recording',
  'canvas',
  'mixing',
  'export',
  'ai',
  'embedding',
  'asr',
  'import',
  'ui',
  'advanced',
] as const

function asDb(db: DatabaseSync): DbLike {
  return db as unknown as DbLike
}

/** 建一张与 001_init.sql 一致的 settings 表 */
function createSettingsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    is_secret  INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );`)
}

function settingsRows(db: DatabaseSync): Array<{ key: string; value: string }> {
  return db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>
}

/** 分组行 = 不含点的键。表语义是「一行为一个叶子」，所以这个数组必须永远是空的 */
function branchRows(db: DatabaseSync): string[] {
  return settingsRows(db)
    .filter((r) => !r.key.includes('.'))
    .map((r) => r.key)
}

/** 走**真实**校验器产出补丁（不手写模拟，否则哪天校验器变了测试就假绿） */
function validatedPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const parsed = IPC_REQ_SCHEMAS['settings:set'].parse({ patch }) as { patch: Record<string, unknown> }
  return parsed.patch
}

function newStore(db: DatabaseSync) {
  createSettingsTable(db)
  return createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
}

// ---------------------------------------------------------------------------
// ① 前提：校验器确实会把所有分组物化出来（这条是理解整个 bug 的钥匙）
// ---------------------------------------------------------------------------

describe('前提 · UI 只改一个分组，补丁里却是全部分组', () => {
  it('只提交 paths 时，校验结果里其余分组是 undefined（而非"不出现"）', () => {
    const patch = validatedPatch({ paths: { exportDir: 'D:\\out' } })

    assert.equal(patch['paths'] ? 1 : 0, 1)
    // 这就是事故的引信：UI 没碰过的分组也出现在补丁里
    assert.equal(patch['audio'], undefined)
    assert.equal(patch['import'], undefined)
    assert.ok(Object.keys(patch).length >= 12, `补丁应含全部分组键，实际 ${Object.keys(patch).length} 个`)
  })
})

// ---------------------------------------------------------------------------
// ② 写防线：这样一笔补丁写下去，不得把任何分组清掉
// ---------------------------------------------------------------------------

describe('写防线 · 分组键不得被 undefined/null 赋整支', () => {
  it('真实补丁（只改 paths）写库后，其余分组完好、库里没有分组行', () => {
    const db = new DatabaseSync(':memory:')
    const store = newStore(db)

    const res = store.set(validatedPatch({ paths: { exportDir: 'D:\\out' } }))

    // changedKeys 里只应有叶子键（分组键一旦出现，就说明整支被动了）
    for (const key of res.changedKeys) {
      assert.ok(key.includes('.'), `changedKeys 里不该出现分组键：${key}`)
    }

    // 整棵树必须完好（真机上就是这里开始崩的）
    assert.equal(store.current().import.maxFileSizeBytes, IMPORT_LIMITS.maxFileSizeBytes)
    assert.equal(store.current().audio.sampleRate, 48000)
    assert.equal(store.current().ui.theme, 'system')

    // 用户真正改的那一项必须生效
    assert.equal(store.current().paths.exportDir, 'D:\\out')

    // 库里不得出现任何分组行
    assert.deepEqual(branchRows(db), [], '分组行是非法数据：表语义是一行一个叶子')
  })

  it('显式传 `{ audio: null }` 也不会清掉整支（UI 没有任何操作表达这个意思）', () => {
    const db = new DatabaseSync(':memory:')
    const store = newStore(db)

    const res = store.set({ audio: null, import: undefined })

    assert.deepEqual(res.changedKeys, [])
    assert.equal(store.current().audio.sampleRate, 48000)
    assert.equal(store.current().import.maxFileSizeBytes, IMPORT_LIMITS.maxFileSizeBytes)
    assert.deepEqual(branchRows(db), [])
  })
})

// ---------------------------------------------------------------------------
// ③ 读防线：库已经坏了，应用也必须能起来
// ---------------------------------------------------------------------------

describe('读防线 · 库里已有坏值（真机那 17 行）时也必须能启动', () => {
  it('复刻真机的 17 行：分组不被清空，用户改过的路径仍保留', () => {
    const db = new DatabaseSync(':memory:')
    createSettingsTable(db)
    const insert = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)')

    // 真机原样：11 个分组 = null，6 个 paths 叶子（其中两个是真实值/合法 null）
    for (const branch of CORRUPTED_BRANCHES) insert.run(branch, 'null')
    insert.run('paths.projectRoot', 'null')
    insert.run('paths.exportDir', JSON.stringify('C:\\projectText\\cloudproject\\musicproject\\book'))
    insert.run('paths.ffmpegPath', 'null')
    insert.run('paths.modelDir', 'null')
    insert.run('paths.cacheDir', 'null')
    insert.run('paths.backupDir', 'null')

    // 修复前这里会得到 `import === null`，随后 ports.ts 在启动第 11 步抛 TypeError
    const store = createSettingsStore({ db: asDb(db), pathDefaults: PATHS })

    for (const branch of CORRUPTED_BRANCHES) {
      const value = (store.current() as unknown as Record<string, unknown>)[branch]
      assert.equal(value !== null && typeof value === 'object', true, `分组 ${branch} 必须是对象，实际 ${String(value)}`)
    }
    // 启动路径上真正会炸的那一处
    assert.equal(store.current().import.maxFileSizeBytes, IMPORT_LIMITS.maxFileSizeBytes)
    assert.equal(store.current().advanced.logLevel, 'info')

    // 坏分组行被忽略，但用户真正改过的路径必须保留
    assert.equal(store.current().paths.exportDir, 'C:\\projectText\\cloudproject\\musicproject\\book')
  })

  it('坏行的坏法千奇百怪，都不能把分组弄坏（数组/数字/字符串/非法 JSON）', () => {
    const db = new DatabaseSync(':memory:')
    createSettingsTable(db)
    const insert = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)')
    insert.run('audio', '[]')
    insert.run('import', '42')
    insert.run('ui', '"oops"')
    insert.run('advanced', '{坏掉的 JSON')

    const store = createSettingsStore({ db: asDb(db), pathDefaults: PATHS })

    assert.equal(store.current().audio.sampleRate, 48000)
    assert.equal(store.current().import.maxFileSizeBytes, IMPORT_LIMITS.maxFileSizeBytes)
    assert.equal(store.current().ui.theme, 'system')
    assert.equal(store.current().advanced.logLevel, 'info')
  })
})

// ---------------------------------------------------------------------------
// ④ reset 用分组名时，只能写叶子行
// ---------------------------------------------------------------------------

describe('reset · 传分组名时展开成叶子', () => {
  it('`reset([\'paths\'])` 不产生 `paths` 分组行（SECTIONS.resetKeys 给的就是分组名）', () => {
    const db = new DatabaseSync(':memory:')
    const store = newStore(db)

    // 先改掉一项，确保 reset 真的会写回默认值
    store.set({ paths: { exportDir: 'D:\\changed' } })
    assert.equal(store.current().paths.exportDir, 'D:\\changed')

    store.reset(['paths'])

    assert.equal(store.current().paths.exportDir, PATHS.exportDir, 'reset 应恢复默认值')
    assert.deepEqual(branchRows(db), [], '不得写出 `paths = {整个对象}` 这种分组行')
    assert.ok(
      settingsRows(db).some((r) => r.key === 'paths.exportDir'),
      '默认值应落在叶子行上',
    )
  })
})
