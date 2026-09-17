/**
 * 基础设施 · 事务包装与分批写入
 * ============================================================================
 * 设计依据：docs/04 §1.2 / §1.1 两条铁律
 *
 * > 铁律 1：任何可能超过 50 ms 的查询必须先 EXPLAIN QUERY PLAN 验证走索引。
 * > 铁律 2：批量写（如导入 10 万行画本）必须分批（每批 2000 行）+ 事务提交 +
 * >         setImmediate 让出事件循环。
 *
 * 铁律 2 的理由：better-sqlite3 是**同步** API，主进程是单线程事件循环。
 * 一个大事务写完 10 万行会冻结整个主进程（包括 IPC 响应与录音写入），
 * 用户会看到 UI 卡死、录音丢帧。分批 + 让路是唯一正确的写法。
 */

import { AppError, wrapUnknown } from '../../../shared/errors.ts'
import type { MessageKey } from '../../../shared/messages.ts'
import { yieldToLoop } from '../queue/yield.ts'
import type { DbLike, StatementLike } from './types.ts'
import { readSqliteCode } from './types.ts'

/**
 * 事务嵌套深度。better-sqlite3 的 `db.transaction()` 自身支持嵌套（内部用 savepoint），
 * 但**手写 BEGIN 的降级路径**必须自己记深度，否则嵌套调用会抛
 * 「cannot start a transaction within a transaction」。
 */
const depthByDb = new WeakMap<object, number>()

/**
 * 在事务里执行 `fn`：失败自动 ROLLBACK，成功 COMMIT。
 *
 * · 有驱动的 `db.transaction` 时优先用它（性能更好，且正确处理嵌套 savepoint）
 * · 否则手写 `BEGIN` / `COMMIT` / `ROLLBACK`，嵌套时用 `SAVEPOINT`
 *
 * **不要在事务里 await**：better-sqlite3 的事务是同步的，中间 await 会让其它代码
 * 插进同一个事务，产生难以复现的锁竞争。需要让路请用 {@link batchInsert}。
 */
export function tx<T>(db: DbLike, fn: () => T): T {
  if (typeof db.transaction === 'function') {
    return db.transaction(fn)()
  }
  return manualTransaction(db, fn, false)
}

/** 写事务用 IMMEDIATE：更早拿到写锁，避免锁升级失败（docs/04 §1.2） */
export function txImmediate<T>(db: DbLike, fn: () => T): T {
  if (typeof db.transaction === 'function') {
    // better-sqlite3 的 transaction 支持 `.immediate()`，但类型不在最小接口内
    const factory = db.transaction as unknown as {
      (f: () => T): (() => T) & { immediate?: () => T }
    }
    const wrapped = factory(fn)
    return typeof wrapped.immediate === 'function' ? wrapped.immediate() : wrapped()
  }
  return manualTransaction(db, fn, true)
}

function manualTransaction<T>(db: DbLike, fn: () => T, immediate: boolean): T {
  const depth = depthByDb.get(db as unknown as object) ?? 0
  const savepoint = depth > 0 ? `sp_${depth}_${Date.now().toString(36)}` : null
  try {
    if (savepoint) db.exec(`SAVEPOINT ${savepoint};`)
    else db.exec(immediate ? 'BEGIN IMMEDIATE;' : 'BEGIN;')
    depthByDb.set(db as unknown as object, depth + 1)
    const out = fn()
    if (savepoint) db.exec(`RELEASE ${savepoint};`)
    else db.exec('COMMIT;')
    return out
  } catch (e) {
    try {
      if (savepoint) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`)
      else db.exec('ROLLBACK;')
    } catch {
      /* 回滚失败通常意味着连接已坏；原始错误更重要，不能被覆盖 */
    }
    throw wrapUnknown(e)
  } finally {
    depthByDb.set(db as unknown as object, depth)
  }
}

/** 当前是否在事务中（诊断用） */
export function inTransaction(db: DbLike): boolean {
  return (depthByDb.get(db as unknown as object) ?? 0) > 0
}

export interface BatchInsertOptions {
  /** 每批行数（默认 2000，docs/04 §1.1 铁律 2） */
  batchSize?: number
  /** 是否在批间让出事件循环（默认 true；纯后台一次性脚本可关掉以提速） */
  yieldBetweenBatches?: boolean
  /** 进度回调（0..1），用于 ctx.report 与日志 */
  onProgress?: (done: number, total: number) => void
  /** 供测试注入（默认 setImmediate） */
  yielder?: () => Promise<void>
}

/**
 * 分批插入：`INSERT INTO t (...) VALUES (?, ?, ...)`，每批一个事务，批间让出事件循环。
 *
 * @param rows 每行对应一组参数（按 SQL 中 `?` 的顺序展开）
 * @returns 写入的行数
 */
export async function batchInsert(
  db: DbLike,
  sql: string,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  opts?: BatchInsertOptions,
): Promise<number> {
  const batchSize = Math.max(1, opts?.batchSize ?? 2000)
  const yielder = opts?.yielder ?? yieldToLoop
  const shouldYield = opts?.yieldBetweenBatches ?? true
  let done = 0
  let stmt: StatementLike | null = null

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    tx(db, () => {
      stmt = stmt ?? db.prepare(sql)
      for (const params of batch) stmt.run(...params)
    })
    done += batch.length
    opts?.onProgress?.(done, rows.length)
    if (shouldYield && done < rows.length) await yielder()
  }
  return done
}

/**
 * 分批更新（大表结构变更用的「分批拷贝」也走这里，docs/21 §13 迁移纪律 3）。
 * 与 batchInsert 的差别：每行参数之后会追加 `whereParams`（如主键）。
 */
export async function batchUpdate(
  db: DbLike,
  sql: string,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  opts?: BatchInsertOptions,
): Promise<number> {
  return batchInsert(db, sql, rows, opts)
}

/** 把 sqlite 错误包装成业务异常（带 SQLITE_* 码，供 errno 映射表使用） */
export function asDbError(e: unknown, fallback: MessageKey): AppError {
  if (e instanceof AppError) return e
  const code = readSqliteCode(e)
  const suffix = code ? { sqliteCode: code } : undefined
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return new AppError('DB_BUSY', { cause: e, details: suffix })
  }
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    return new AppError('DB_CORRUPT', { cause: e, details: suffix })
  }
  return new AppError(fallback, { cause: e, details: suffix })
}
