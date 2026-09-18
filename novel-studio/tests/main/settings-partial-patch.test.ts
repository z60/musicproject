/**
 * 回归 · 局部补丁**不得清空同组其它设置**（真机现象，docs/91 §5.2.7）
 * ============================================================================
 * 用户报告：「设置里选择了导出位置后，选择备份位置，导出位置会被清空。」
 *
 * 根因与 §5.2.3 是**同一类**，只是深了一层：
 *   IPC 校验层 `ObjectSchema._parse` 会把 shape 里**每个**字段都物化进结果，
 *   所以 `settings:set({patch:{paths:{backupDir:'Y'}}})` 到达 `applyPatch` 时其实是
 *
 *       { paths: { projectRoot: undefined, exportDir: undefined, ffmpegPath: undefined,
 *                  modelDir: undefined, cacheDir: undefined, backupDir: 'Y' } }
 *
 *   §5.2.3 的修复只挡住了「**分组键**为 undefined」；分组**内部的叶子**仍是 undefined，
 *   展开时被逐个写进树里 → 同组其它项**全部被清空**。
 *
 * ### 断言方式：快照对比「只有目标字段变了」
 *   不写死默认值（默认值会随 constants/seed 变化，写死会让测试变成「抄一遍默认值」），
 *   而是记录补丁**前**的整组快照，断言补丁**后**只有被点名的那一项发生变化。
 *   这样「多改了字段」和「少改了字段」都会红。
 *
 * 用 `node:sqlite`（真 SQLite）+ **真实校验器**：`undefined` 是校验层引入的，
 * 手写补丁无法复刻这条链路。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { IPC_REQ_SCHEMAS } from '../../src/main/ipc/schemas.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createSettingsStore } from '../../src/main/settings.ts'

const PATHS = {
  projectRoot: 'C:\\ud\\projects',
  exportDir: 'C:\\ud\\exports',
  ffmpegPath: null,
  modelDir: 'C:\\res\\models',
  cacheDir: 'C:\\ud\\cache',
  backupDir: 'C:\\ud\\backups',
}

function asDb(db: DatabaseSync): DbLike {
  return db as unknown as DbLike
}

function newStore() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    is_secret  INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );`)
  return { db, store: createSettingsStore({ db: asDb(db), pathDefaults: PATHS }) }
}

/** 走**真实**校验器（undefined 就是它引入的；手写补丁复刻不了这条链路） */
function viaSchema(store: ReturnType<typeof newStore>['store'], patch: Record<string, unknown>): void {
  const parsed = IPC_REQ_SCHEMAS['settings:set'].parse({ patch }) as { patch: Record<string, unknown> }
  store.set(parsed.patch)
}

const snapshot = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v)) as Record<string, unknown>

/** 逐字段比较，返回「值发生变化」的字段名 */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}

/**
 * 核心断言：一笔只改 `field` 的补丁，**只能**改到 `field`。
 * @param group 分组名（`paths` / `audio` / `recording` / `ai` / `advanced` …）
 */
function assertOnlyChanged(
  store: ReturnType<typeof newStore>['store'],
  group: keyof ReturnType<ReturnType<typeof newStore>['store']['current']>,
  patch: Record<string, unknown>,
  field: string,
): void {
  const before = snapshot(store.current()[group])
  viaSchema(store, patch)
  const after = snapshot(store.current()[group])

  const changed = changedFields(before, after)
  assert.deepEqual(
    changed,
    [field],
    `只改 ${String(group)}.${field} 时，实际被改动的是：${changed.join(', ') || '（无）'}` +
      `—— 其余字段必须**原样保留**（被清空/改掉都是缺陷，见 docs/91 §5.2.7）`,
  )
}

// ---------------------------------------------------------------------------
// 用户报告的那一条
// ---------------------------------------------------------------------------

describe('局部补丁 · 路径（用户报告的现象）', () => {
  it('先选导出位置、再选备份位置 → 导出位置必须还在', () => {
    const { store } = newStore()

    viaSchema(store, { paths: { exportDir: 'D:\\我的导出' } })
    assert.equal(store.current().paths.exportDir, 'D:\\我的导出', '前提：第一次选择要生效')

    viaSchema(store, { paths: { backupDir: 'E:\\我的备份' } })

    assert.equal(store.current().paths.exportDir, 'D:\\我的导出', '❌ 选备份位置不能清空导出位置')
    assert.equal(store.current().paths.backupDir, 'E:\\我的备份')
  })

  it('逐个选择 4 个目录，先选的都不能被后选的清掉', () => {
    const { store } = newStore()

    viaSchema(store, { paths: { exportDir: 'D:\\out' } })
    viaSchema(store, { paths: { backupDir: 'E:\\bak' } })
    viaSchema(store, { paths: { modelDir: 'F:\\models' } })
    viaSchema(store, { paths: { cacheDir: 'G:\\cache' } })

    const p = store.current().paths
    assert.equal(p.exportDir, 'D:\\out')
    assert.equal(p.backupDir, 'E:\\bak')
    assert.equal(p.modelDir, 'F:\\models')
    assert.equal(p.cacheDir, 'G:\\cache')
  })

  it('选一个目录时，同组其它路径必须一个都不动', () => {
    const { store } = newStore()
    assertOnlyChanged(store, 'paths', { paths: { backupDir: 'E:\\bak' } }, 'backupDir')
    assertOnlyChanged(store, 'paths', { paths: { exportDir: 'D:\\out' } }, 'exportDir')
    assertOnlyChanged(store, 'paths', { paths: { ffmpegPath: 'C:\\ff\\ffmpeg.exe' } }, 'ffmpegPath')
  })

  it('库里不得出现「从没设过却被写成 null」的路径行', () => {
    const { db, store } = newStore()

    viaSchema(store, { paths: { exportDir: 'D:\\out' } })
    viaSchema(store, { paths: { backupDir: 'E:\\bak' } })

    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'paths.%' ORDER BY key").all() as Array<{
      key: string
      value: string
    }>
    const nulled = rows.filter((r) => r.value === 'null' && r.key !== 'paths.ffmpegPath')
    assert.deepEqual(nulled, [], `这些路径被误写成 null（用户从没设过）：${nulled.map((r) => r.key).join(', ')}`)
  })
})

// ---------------------------------------------------------------------------
// 用户问的「其他路径是不是也有这种情况」：受影响的是**所有分组**
// ---------------------------------------------------------------------------

describe('局部补丁 · 其它分组同样受影响', () => {
  it('音频：只改倒计时，同组其它项一个都不能动', () => {
    assertOnlyChanged(newStore().store, 'audio', { audio: { countdownMs: 5000 } }, 'countdownMs')
  })

  it('录音：只改一个快捷键，VAD 与同组其它项一个都不能动', () => {
    assertOnlyChanged(newStore().store, 'recording', { recording: { stopKey: 'F9' } }, 'stopKey')
  })

  it('AI：只改服务商，同组其它项一个都不能动', () => {
    assertOnlyChanged(newStore().store, 'ai', { ai: { provider: 'openai-compatible' } }, 'provider')
  })

  it('高级：只改日志级别，备份策略一个都不能动', () => {
    assertOnlyChanged(newStore().store, 'advanced', { advanced: { logLevel: 'debug' } }, 'logLevel')
  })

  it('导出：只改格式，命名模板等一个都不能动', () => {
    assertOnlyChanged(newStore().store, 'export', { export: { format: 'wav' } }, 'format')
  })

  it('混音：只改目标响度，闪避参数一个都不能动', () => {
    assertOnlyChanged(newStore().store, 'mixing', { mixing: { targetLufs: -14 } }, 'targetLufs')
  })

  it('画本：只改一个阈值，同组其它项一个都不能动', () => {
    assertOnlyChanged(newStore().store, 'canvas', { canvas: { maxLineChars: 100 } }, 'maxLineChars')
  })

  it('嵌套子对象：整支提交 VAD（契约要求完整对象）时，只有被改的字段变化', () => {
    const { store } = newStore()
    const before = snapshot(store.current().recording.vad)

    // UI 就是这么发的（`save({ recording: { vad: { ...vad } } })`）—— 整支、不是局部
    viaSchema(store, { recording: { vad: { ...before, minSilenceMs: 500 } } })
    const after = snapshot(store.current().recording.vad)

    assert.equal(after['minSilenceMs'], 500)
    assert.deepEqual(
      changedFields(before, after),
      ['minSilenceMs'],
      '整支提交 VAD 时，只有被改的那一项能变（其余必须是原值）',
    )
  })

  it('局部 VAD 补丁会被 schema 拒收 —— 契约要求整支提交（记录既有行为）', () => {
    // `VadOptionsShape` 是**完整对象**（没有 .partial()），所以 `{vad:{minSilenceMs}}`
    // 这种局部写法在 IPC 边界就被拒了。这解释了「嵌套组为什么没有同样的清空问题」：
    // 它压根不接受局部补丁，只能整支覆盖 —— 而整支覆盖时每个字段都是显式值。
    const { store } = newStore()
    assert.throws(
      () => IPC_REQ_SCHEMAS['settings:set'].parse({ patch: { recording: { vad: { minSilenceMs: 500 } } } }),
      /vad/,
    )
    // 且这一笔坏补丁不会留下任何副作用
    assert.equal(store.current().recording.vad.minSilenceMs, 350)
  })
})

// ---------------------------------------------------------------------------
// 边界：补丁两种写法、以及「不修过头」
// ---------------------------------------------------------------------------

describe('局部补丁 · 两种写法与 null 语义', () => {
  it('点分写法在 store 这一层同样不能清空同组（直接调用，不经 IPC）', () => {
    // 注意：经 IPC 时点分键会被 schema **剥掉**（settings:set 的 shape 是嵌套对象，
    // 未声明的键按 strip 处理）—— 那是另一件事，见下方用例。
    const { store } = newStore()
    const before = snapshot(store.current().audio)

    store.set({ 'audio.sampleRate': 44100 })

    assert.equal(store.current().audio.sampleRate, 44100)
    assert.deepEqual(changedFields(before, snapshot(store.current().audio)), ['sampleRate'])
  })

  it('经 IPC 的点分键会被 schema 剥掉（记录既有行为，不是本次要修的）', () => {
    const { store } = newStore()
    const before = snapshot(store.current().audio)
    viaSchema(store, { 'audio.sampleRate': 44100 })
    assert.deepEqual(changedFields(before, snapshot(store.current().audio)), [], '点分键经 IPC 不生效')
  })

  /**
   * 下面两条**绕过 IPC schema** 直接调 `settings.set()`。
   *
   * 因为 `OptString = v.optional(v.string())` 目前**不接受 null**（见 schemas.ts），
   * `{ paths: { ffmpegPath: null } }` 根本到不了 applyPatch —— 那是**另一个独立缺陷**
   * （schema 比它校验的 `AppSettings` 类型更窄：类型里 `paths.*` / `defaultInputDeviceId` /
   * `coverPath` 都是 `string | null`），已记在 docs/91 §5.2.7 末尾待办。
   *
   * 这里只钉 applyPatch 自己的语义：**`undefined` 跳过、`null` 生效**。
   * 少了这一组，修复很容易「顺手把 null 也跳过」—— 那样用户就再也无法把某项设回默认。
   */
  it('显式 null 必须生效（不能因为修 undefined 就顺手把 null 也忽略掉）', () => {
    const { store } = newStore()

    store.set({ paths: { ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe' } })
    assert.equal(store.current().paths.ffmpegPath, 'C:\\ffmpeg\\bin\\ffmpeg.exe')

    store.set({ paths: { ffmpegPath: null } })
    assert.equal(store.current().paths.ffmpegPath, null, '❌ 显式 null 被当成「没提供」忽略了')
  })

  it('同一笔补丁里，undefined（不改）与 null（设回默认）必须被区分', () => {
    const { store } = newStore()
    store.set({ paths: { exportDir: 'D:\\out', cacheDir: 'G:\\cache' } })

    store.set({ paths: { exportDir: null, cacheDir: undefined } })

    assert.equal(store.current().paths.exportDir, null, '显式 null 应生效')
    assert.equal(store.current().paths.cacheDir, 'G:\\cache', 'undefined 应保持原值')
  })
})
