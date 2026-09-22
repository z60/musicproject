/**
 * 回归 · 密钥存储（真机现象：「配置了 AI 却连不上」）
 * ============================================================================
 * 修复前的两个缺陷（都在密钥落库这一段）：
 *
 *   1. `setSecretRaw` 走设置树的 `setByPath`，而它**只写默认树里已存在的叶子**。
 *      `ai` 分组里根本没有 `apiKey` 这个叶子 → 写入返回 false → `persist` 拿到空
 *      changed 直接返回 → **密钥被静默丢弃**（连内存里都没有）。
 *   2. 普通 `persist` 从不写 `is_secret`，密钥行与普通设置行无法区分。
 *
 * 这组测试用**真 SQLite 引擎**（node:sqlite）钉住修复后的语义：
 *   · 密钥键可以是默认树里不存在的键（ai.apiKey）且必须真落库
 *   · 必须带 `is_secret = 1`，且**不能**出现在 `getAll()` 里（永不回显）
 *   · 重建 store 后仍能读回（证明是落库而不是只在内存）
 *   · 普通设置写回时必须 `is_secret = 0`
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createSettingsStore } from '../../src/main/settings.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'

const PATHS = {
  projectRoot: 'C:\\u\\projects',
  exportDir: 'C:\\u\\exports',
  ffmpegPath: null,
  modelDir: 'C:\\r\\models',
  cacheDir: 'C:\\u\\cache',
  backupDir: 'C:\\u\\backups',
}

function asDb(db: DatabaseSync): DbLike {
  return db as unknown as DbLike
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    is_secret  INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );`)
  return db
}

function row(db: DatabaseSync, key: string): { value: string; is_secret: number } | undefined {
  return db.prepare('SELECT value, is_secret FROM settings WHERE key = ?').get(key) as
    | { value: string; is_secret: number }
    | undefined
}

describe('settings · 密钥存储', () => {
  it('默认树里不存在的密钥键也能落库（修复前被静默丢弃）', () => {
    const db = newDb()
    const store = createSettingsStore({ db: asDb(db), pathDefaults: PATHS })

    const changed = store.setSecretRaw('ai.apiKey', 'v1:CIPHERTEXT')
    assert.deepEqual(changed.changedKeys, ['ai.apiKey'], '必须报告确实写入了')

    const saved = row(db, 'ai.apiKey')
    assert.ok(saved, '密钥必须真的写进 settings 表')
    assert.equal(Number(saved.is_secret), 1, '密钥行必须 is_secret = 1')
    // 值按 JSON 字符串存（与普通设置同一列语义）
    assert.equal(JSON.parse(saved.value), 'v1:CIPHERTEXT')
    assert.equal(store.getSecretRaw('ai.apiKey'), 'v1:CIPHERTEXT')
  })

  it('密钥不进设置树：getAll() 里读不到（密钥永不回显）', () => {
    const db = newDb()
    const store = createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
    store.setSecretRaw('ai.apiKey', 'v1:SECRET')

    const all = store.getAll() as unknown as { ai: Record<string, unknown> }
    assert.equal('apiKey' in all.ai, false, 'ai.apiKey 不得混进 AppSettings')
    assert.equal((all.ai as { apiKey?: unknown }).apiKey, undefined)
  })

  it('重建 store 后仍能读回（证明是落库，不是只在内存）', () => {
    const db = newDb()
    createSettingsStore({ db: asDb(db), pathDefaults: PATHS }).setSecretRaw('ai.apiKey', 'v1:PERSISTED')

    const reopened = createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
    assert.equal(reopened.getSecretRaw('ai.apiKey'), 'v1:PERSISTED')
  })

  it('空串表示清除', () => {
    const db = newDb()
    const store = createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
    store.setSecretRaw('ai.apiKey', 'v1:X')
    store.setSecretRaw('ai.apiKey', '')
    assert.equal(store.getSecretRaw('ai.apiKey'), '')
  })

  it('普通设置写回时 is_secret = 0（不会把旧密钥位的键一直当密钥）', () => {
    const db = newDb()
    const store = createSettingsStore({ db: asDb(db), pathDefaults: PATHS })
    // 先把同名 key 标成密钥，再用普通 set 写回
    store.setSecretRaw('ui.theme', 'v1:WAS_SECRET')
    assert.equal(Number(row(db, 'ui.theme')!.is_secret), 1)

    store.set({ ui: { theme: 'dark' } })
    const saved = row(db, 'ui.theme')!
    assert.equal(Number(saved.is_secret), 0, '普通写回必须把 is_secret 归零')
    assert.equal(JSON.parse(saved.value), 'dark')
  })

  it('纯内存 store（db = null）也能读写密钥', () => {
    const store = createSettingsStore({ db: null, pathDefaults: PATHS })
    store.setSecretRaw('ai.apiKey', 'v1:MEM')
    assert.equal(store.getSecretRaw('ai.apiKey'), 'v1:MEM')
  })
})
