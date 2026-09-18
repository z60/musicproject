/**
 * 基础设施 · 异步事务包装（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）
 * ============================================================================
 * ### 为什么不用 `infra/db/tx.ts` 的 `tx()`
 *   `tx()` 优先走 better-sqlite3 的 `db.transaction(fn)`，而它**要求回调是同步的**
 *   （驱动的硬约束，见 tx.ts 头部的「不要在事务里 await」）。本仓库的仓储方法
 *   （`insertMany` / `update` / `softDeleteByIds` …）都是 **async**，
 *   所以需要一个支持 async 回调的包装。
 *
 * ### 为什么是 `IMMEDIATE`
 *   这类操作都是「先读后写」（先查章节、校验、再写回）。`DEFERRED` 要到第一次写
 *   才拿写锁，两个并发操作会在中途锁升级时撞 `SQLITE_BUSY` 甚至死锁；
 *   `IMMEDIATE` 一开始就拿写锁，冲突立刻暴露（配合 `busy_timeout` 重试）。
 *
 * ### 回滚失败为什么不吞掉
 *   回滚失败意味着**连接状态已不可信**（例如磁盘故障、连接已被关闭）。
 *   这时原始异常仍然要往上抛（它才是用户真正该看到的），但回滚失败的事实必须留证据 ——
 *   否则会变成「数据处于未知状态，而日志里什么都没有」。
 */

import type { DbLike } from './types.ts'

/** 只用到 warn：避免为了记一条日志而依赖完整的 Logger 接口（测试可传 noop） */
export interface TxLogger {
  warn(event: string, data?: Record<string, unknown>): void
}

export interface WithTransactionOptions {
  /** 回滚失败时记一条 warn（强烈建议传） */
  log?: TxLogger
  /**
   * 日志事件前缀，默认 `'db.tx'`。
   * 各域保留自己的前缀（如 `'book.tx'`）便于在日志里定位是哪个域的事务出了问题。
   */
  eventPrefix?: string
}

/**
 * 在**一个事务**里跑 `fn`（支持 async 回调）。
 *
 * @returns `fn` 的返回值
 * @throws `fn` 抛出的任何异常（事务已回滚）
 */
export async function withTransactionAsync<T>(
  db: DbLike,
  fn: () => Promise<T> | T,
  opts?: WithTransactionOptions,
): Promise<T> {
  const event = `${opts?.eventPrefix ?? 'db.tx'}.rollbackFailed`
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = await fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackErr) {
      opts?.log?.warn(event, {
        event,
        reason: String(rollbackErr),
        cause: e instanceof Error ? e.message : String(e),
      })
    }
    throw e
  }
}
