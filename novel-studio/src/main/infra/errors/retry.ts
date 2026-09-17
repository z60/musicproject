/**
 * 基础设施 · 重试判定
 * ============================================================================
 * 设计依据：
 *   · docs/04 §2.2「重试：仅对 retryable 错误自动重试（默认 1 次，指数退避 1s/4s）；
 *     ffmpeg 编码失败不重试」
 *   · docs/04 §10「重试：仅网络类错误与 429/5xx；指数退避 1s→4s；最多 2 次」
 *
 * 「重试」这件事在全仓库只应该有一个判断入口，否则会出现「网络错误重试了、
 * 参数错误也重试了」这种把错误放大 3 倍的行为。
 * 是否可重试的**唯一来源**是 `AppError.retryable`（由 messages.ts 的消息表决定），
 * 这里只补两条规则：取消类错误永不重试、未知异常默认不重试。
 */

import { AppError, isAppError, isCancelKey, wrapUnknown } from '../../../shared/errors.ts'

/** 指数退避默认序列（docs/04 §2.2：1s → 4s） */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 4000]

/** 把任意异常转成 AppError（不重复包裹） */
export function asAppError(e: unknown, fallbackKey = 'TASK_FAILED'): AppError {
  return isAppError(e) ? e : wrapUnknown(e, fallbackKey as never)
}

/**
 * 该错误是否值得重试。
 * 取消类错误（TASK_CANCELLED / PROVIDER_ABORTED / PROCESS_ABORTED）永不重试。
 */
export function isRetryableError(e: unknown): boolean {
  const err = asAppError(e)
  if (err.isCancelled || isCancelKey(err.key)) return false
  return err.retryable === true
}

/** 第 `attempt` 次重试前的等待毫秒数（attempt 从 1 起：1 → 1000ms，2 → 4000ms） */
export function retryDelayMs(attempt: number, delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS): number {
  if (delays.length === 0) return 0
  const idx = Math.min(Math.max(1, Math.floor(attempt)), delays.length) - 1
  return delays[idx] ?? delays[delays.length - 1] ?? 0
}

/** 是否还有重试额度 */
export function hasRetryBudget(attempts: number, maxAttempts: number): boolean {
  return attempts < Math.max(1, maxAttempts)
}

/**
 * {@link isRetryableError} 的对外别名。
 * 上一轮的 IPC 层已经以 `shouldRetry` 的名字导出过这个判断，改名会让调用点无声失效，
 * 因此两个名字都保留（同一个函数对象，不存在实现分叉）。
 */
export const shouldRetry = isRetryableError
