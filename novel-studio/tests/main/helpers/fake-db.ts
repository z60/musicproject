/**
 * 测试辅助 · 内存数据库替身（**不是** SQLite）
 * ============================================================================
 * 环境里没有 better-sqlite3（原生模块，无网络无法安装），但迁移器/事务包装/完整性检查
 * 的逻辑必须被验证。因此这里实现一个**只覆盖用到的那几条 SQL**的假实现：
 *
 *   · 真存储：`meta` 表（key-value） → 迁移器的 getMeta/setMeta 能真实读写
 *   · 记录所有 `exec()` 的 SQL 文本 → 断言「建表语句被执行过」
 *   · `transaction()` 支持快照回滚 → 断言「中途失败则 schema_version 不变」
 *   · `pragma()` 返回可配置值 → 断言 applyPragmas 的降级探测
 *
 * 明确不做的事：解析 SQL、模拟锁、模拟约束。**不要**用它验证 SQL 语义 ——
 * 那属于真实 SQLite 的职责（D-1 SQL 文本可用 Python sqlite3 单独验证）。
 */

import type { DbLike, StatementLike } from '../../../src/main/infra/db/types.ts'

export interface FakeDb extends DbLike {
  /** 执行过的所有 SQL（exec + prepare） */
  readonly executed: string[]
  /** meta 表内容 */
  readonly meta: Map<string, string>
  /** pragma 语句 → 返回值（用于模拟 WAL 不可用等降级） */
  readonly pragmas: Map<string, unknown>
  /** 让下一次 exec 抛错（模拟迁移中途失败） */
  failNextExec(error?: Error): void
  /** 人为制造「表还不存在」的状态（全新库） */
  dropMetaTable(): void
}

const META_SELECT = /^\s*SELECT\s+value\s+FROM\s+meta/i
const META_UPSERT = /^\s*INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+meta/i

export function createFakeDb(opts?: { withMetaTable?: boolean; journalMode?: string }): FakeDb {
  const executed: string[] = []
  const meta = new Map<string, string>()
  const pragmas = new Map<string, unknown>([
    ['journal_mode', opts?.journalMode ?? 'wal'],
    ['synchronous', 'normal'],
    ['foreign_keys', 1],
    ['busy_timeout', 5000],
    ['temp_store', 'memory'],
    ['cache_size', -64000],
    ['mmap_size', 268435456],
    ['integrity_check', [{ integrity_check: 'ok' }]],
    ['foreign_key_check', []],
  ])
  let metaTableExists = opts?.withMetaTable ?? true
  let failNext: Error | null = null
  const inTransaction = { value: false }

  function snapshot(): { meta: Map<string, string>; table: boolean } {
    return { meta: new Map(meta), table: metaTableExists }
  }
  function restore(snap: { meta: Map<string, string>; table: boolean }): void {
    meta.clear()
    for (const [k, v] of snap.meta) meta.set(k, v)
    metaTableExists = snap.table
  }

  function makeStatement(sql: string): StatementLike {
    executed.push(sql)
    return {
      run(...params: unknown[]) {
        if (META_UPSERT.test(sql)) {
          metaTableExists = true
          meta.set(String(params[0]), String(params[1]))
          return { changes: 1, lastInsertRowid: meta.size }
        }
        if (/^\s*DELETE\s+FROM\s+backups/i.test(sql)) return { changes: 1, lastInsertRowid: 0 }
        return { changes: 1, lastInsertRowid: 1 }
      },
      get(...params: unknown[]) {
        if (META_SELECT.test(sql)) {
          if (!metaTableExists) throw new Error('SQLITE_ERROR: no such table: meta')
          const value = meta.get(String(params[0]))
          return value === undefined ? undefined : { value }
        }
        if (/sqlite_master/i.test(sql)) return undefined
        if (/COUNT\(\*\)/i.test(sql)) return { n: 0 }
        return undefined
      },
      all(..._params: unknown[]) {
        if (META_SELECT.test(sql)) {
          if (!metaTableExists) throw new Error('SQLITE_ERROR: no such table: meta')
          return [...meta.entries()].map(([key, value]) => ({ key, value }))
        }
        if (/sqlite_master/i.test(sql)) {
          if (!metaTableExists) return []
          return [{ name: 'meta' }, { name: 'settings' }]
        }
        return []
      },
    }
  }

  // `DbLike.open` 是 `readonly`（生产包不该有人手改连接状态），
  // 所以 fake 用独立变量存状态，再用 getter 暴露 —— close() 后 open 变 false 可被断言。
  let openState = true

  const db: FakeDb = {
    executed,
    meta,
    pragmas,
    name: 'fake-db',
    get open() {
      return openState
    },
    prepare: makeStatement,
    exec(sql: string) {
      executed.push(sql)
      if (failNext) {
        const err = failNext
        failNext = null
        throw err
      }
      if (/CREATE\s+TABLE.*\bmeta\b/i.test(sql)) metaTableExists = true
      if (/^\s*PRAGMA\s+journal_mode/i.test(sql)) return
      if (/^\s*BEGIN|^\s*COMMIT|^\s*ROLLBACK|^\s*SAVEPOINT|^\s*RELEASE/i.test(sql)) return
    },
    pragma(statement: string) {
      const name = statement.split(/[=\s(]/)[0]!.trim().toLowerCase()
      const full = statement.trim().toLowerCase()
      if (pragmas.has(full)) return pragmas.get(full)
      if (pragmas.has(name)) return pragmas.get(name)
      return undefined
    },
    transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
      return (...args: A): R => {
        // 嵌套调用（savepoint 语义）：只回滚到最近一层，用快照实现
        const snap = snapshot()
        const already = inTransaction.value
        inTransaction.value = true
        try {
          const out = fn(...args)
          inTransaction.value = already
          return out
        } catch (e) {
          restore(snap)
          inTransaction.value = already
          throw e
        }
      }
    },
    close() {
      openState = false
    },
    failNextExec(error?: Error) {
      failNext = error ?? new Error('SQLITE_ERROR: simulated failure')
    },
    dropMetaTable() {
      metaTableExists = false
    },
  }
  return db
}
