/**
 * checkIntegrity 的日志状态测试（不需要 Electron / better-sqlite3）
 * ============================================================================
 * 设计依据：docs/91 §8 的两条已知缺陷
 *
 * 这两条缺陷的共同表现是「**日志把人骗了**」，而不是功能出错：
 *   1. 只读模式下打印 `db.integrity.ok schemaVersion: 0` ——
 *      与「刚建的全新空库」一字不差，于是「迁移根本没跑完」被读成「正常空库」。
 *   2. schemaVersion 0 与「迁移全部失败」无法区分。
 *
 * 所以这组测试断言的是**落哪条日志、带哪些字段**，而不是 integrity_check 的返回值。
 * 用 createFakeDb 而不是真 SQLite：这里验证的是「怎么记日志」，不是 SQL 语义，
 * 而 fake-db 的注释明确说了「不要用它验证 SQL 语义」——两者的边界正好互补。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { checkIntegrity } from '../../src/main/db.ts'
import { createFakeDb } from './helpers/fake-db.ts'
import type { Logger } from '../../src/main/infra/log/index.ts'

interface LogCall {
  level: 'info' | 'warn'
  event: string
  data: Record<string, unknown>
}

/** 只记录 info/warn 的日志器替身；其余方法无操作 */
function captureLogger(calls: LogCall[]): Logger {
  const noop = (): void => undefined
  const record = (level: 'info' | 'warn') => (event: string, data?: Record<string, unknown>) => {
    calls.push({ level, event, data: data ?? {} })
  }
  const stub: Record<string, unknown> = {
    level: 'info',
    setLevel: noop,
    error: record('warn'),
    warn: record('warn'),
    info: record('info'),
    debug: noop,
    trace: noop,
    errorFields: noop,
    child: () => stub,
    write: noop,
    addSink: noop,
    setEntryListener: noop,
    recent: () => [],
  }
  return stub as unknown as Logger
}

function events(calls: LogCall[]): string[] {
  return calls.map(c => c.event)
}

describe('checkIntegrity · 日志状态', () => {
  it('只读模式（迁移失败）记 db.integrity.degraded，而不是 db.integrity.ok', () => {
    const calls: LogCall[] = []
    const db = createFakeDb() // 有 meta 表但没有 schema_version → 版本 0
    const result = checkIntegrity(db, captureLogger(calls), {
      readOnly: true,
      readOnlyReason: 'DB_MIGRATION_FAILED',
    })

    assert.equal(result.ok, true, '完整性本身是好的')
    assert.deepEqual(events(calls), ['db.integrity.degraded'], '只读 + 完整不能记成 ok')
    const entry = calls[0]!
    assert.equal(entry.data['readOnly'], true)
    assert.equal(entry.data['reason'], 'DB_MIGRATION_FAILED')
    assert.equal(entry.data['schemaVersion'], 0)
    assert.equal(entry.data['schemaState'], 'migration-not-applied')
    assert.match(String(entry.data['hint']), /迁移未完成/)
  })

  it('迁移中途失败（版本 > 0 但仍是只读）标成 partial-schema', () => {
    const calls: LogCall[] = []
    const db = createFakeDb()
    db.meta.set('schema_version', '3')
    checkIntegrity(db, captureLogger(calls), { readOnly: true, readOnlyReason: 'x' })

    assert.deepEqual(events(calls), ['db.integrity.degraded'])
    assert.equal(calls[0]!.data['schemaVersion'], 3)
    assert.equal(calls[0]!.data['schemaState'], 'partial-schema')
  })

  it('正常全新库记 db.integrity.ok，并用 schemaState 标明「待迁移」', () => {
    const calls: LogCall[] = []
    const db = createFakeDb()
    checkIntegrity(db, captureLogger(calls))

    assert.deepEqual(events(calls), ['db.integrity.ok'])
    assert.equal(calls[0]!.data['schemaVersion'], 0)
    assert.equal(calls[0]!.data['schemaState'], 'empty-pending-migration')
  })

  it('已迁移的库标成 migrated（与「待迁移的空库」区分开）', () => {
    const calls: LogCall[] = []
    const db = createFakeDb()
    db.meta.set('schema_version', '5')
    checkIntegrity(db, captureLogger(calls))

    assert.deepEqual(events(calls), ['db.integrity.ok'])
    assert.equal(calls[0]!.data['schemaState'], 'migrated')
  })

  it('完整性失败记 db.integrity.failed，并带上只读标志', () => {
    const calls: LogCall[] = []
    const db = createFakeDb()
    db.pragmas.set('integrity_check', [{ integrity_check: 'page 3 corrupt' }])
    const result = checkIntegrity(db, captureLogger(calls), { readOnly: true, readOnlyReason: 'x' })

    assert.equal(result.ok, false)
    assert.deepEqual(events(calls), ['db.integrity.failed'])
    assert.equal(calls[0]!.data['readOnly'], true)
    assert.deepEqual(calls[0]!.data['errors'], ['page 3 corrupt'])
  })
})
