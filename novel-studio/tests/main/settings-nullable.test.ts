/**
 * 回归 · 「未设置」必须能存进去：可空字符串字段的契约（docs/91 §5.2.7 待办 ①）
 * ============================================================================
 * 真机现象：`OptString = v.optional(v.string())` **既不接受 `null` 也不接受空串**，
 * 而 `AppSettings` 类型里这几个字段本来就是 `string | null`，UI 也**会**产出 `null`：
 *
 *   · 音频 →「跟随系统默认设备」把 `defaultInputDeviceId` 选成 `null`
 *   · 导出 →「清除封面」把 `coverPath` 清成 `null`
 *   · 路径 → `ffmpegPath` / `modelDir` 清空 = 用随应用分发的默认位置（seed 里就是 `'null'`）
 *
 * 结果是这些操作**保存必失败**（`SchemaError: 应为字符串，实际是 null`），
 * 用户看到一句「参数不合法」，而设置怎么点都存不进去。
 *
 * 同时钉住**反面**：类型里是 `string` 的路径字段（`projectRoot` 等）**仍然不许 null**
 * —— 修 bug 不能把契约放宽成「什么都能塞」。
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

/** 经**真实** `settings:set` schema 校验并写入（模拟 IPC 全链路） */
function setViaIpc(store: ReturnType<typeof newStore>['store'], patch: Record<string, unknown>): void {
  const parsed = IPC_REQ_SCHEMAS['settings:set'].parse({ patch }) as { patch: Record<string, unknown> }
  store.set(parsed.patch)
}

const parse = (patch: Record<string, unknown>) => IPC_REQ_SCHEMAS['settings:set'].parse({ patch })

describe('可空字符串 · 类型里是 `string | null` 的字段必须接受 null', () => {
  it('音频「跟随系统默认设备」：`defaultInputDeviceId = null` 能存进去', () => {
    const { store } = newStore()

    setViaIpc(store, { audio: { defaultInputDeviceId: 'some-device-id' } })
    assert.equal(store.current().audio.defaultInputDeviceId, 'some-device-id')

    setViaIpc(store, { audio: { defaultInputDeviceId: null } })
    assert.equal(store.current().audio.defaultInputDeviceId, null, '❌ 选回「跟随系统默认设备」存不进去')
  })

  it('导出「清除封面」：`coverPath = null` 能存进去', () => {
    const { store } = newStore()

    setViaIpc(store, { export: { coverPath: 'C:\\cover.png' } })
    assert.equal(store.current().export.coverPath, 'C:\\cover.png')

    setViaIpc(store, { export: { coverPath: null } })
    assert.equal(store.current().export.coverPath, null, '❌ 清除封面存不进去')
  })

  it('路径可空字段：`ffmpegPath` / `modelDir` 置 null（= 用分发默认位置）能存进去', () => {
    const { store } = newStore()

    setViaIpc(store, { paths: { ffmpegPath: 'C:\\ff\\ffmpeg.exe', modelDir: 'D:\\models' } })
    assert.equal(store.current().paths.ffmpegPath, 'C:\\ff\\ffmpeg.exe')
    assert.equal(store.current().paths.modelDir, 'D:\\models')

    setViaIpc(store, { paths: { ffmpegPath: null, modelDir: null } })
    assert.equal(store.current().paths.ffmpegPath, null, '❌ 清空 ffmpeg 路径存不进去')
    assert.equal(store.current().paths.modelDir, null, '❌ 清空模型目录存不进去')
  })

  it('边界宽容：路径输入框清空产生的空串也被接受（渲染进程会归一到 null）', () => {
    assert.doesNotThrow(() => parse({ paths: { ffmpegPath: '', modelDir: '' } }))
    assert.doesNotThrow(() => parse({ audio: { defaultInputDeviceId: '' } }))
  })
})

describe('可空字符串 · 反面：类型里是 `string` 的字段不许 null', () => {
  it('`paths.projectRoot` / `exportDir` / `cacheDir` / `backupDir` 传 null 必须被拒', () => {
    for (const key of ['projectRoot', 'exportDir', 'cacheDir', 'backupDir']) {
      assert.throws(
        () => parse({ paths: { [key]: null } }),
        /应为字符串/,
        `❌ paths.${key} 类型是 string（由运行时解析），不该接受 null —— ` +
          `放宽它会让「空路径」这种非法状态进设置树`,
      )
    }
  })

  it('其它非空字符串字段（如书名模板）也不接受 null 与空串', () => {
    assert.throws(() => parse({ export: { fileNameTemplate: null } }), /应为字符串/)
    assert.throws(() => parse({ export: { fileNameTemplate: '' } }), /不能为空字符串/)
  })
})
