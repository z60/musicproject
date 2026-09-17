/**
 * 基础设施 · 让出事件循环
 * ============================================================================
 * 设计依据：docs/04 §1.1 铁律 2「批量写必须分批 + setImmediate 让出事件循环」、
 *          docs/01 §12「embedding 批量放 Worker 或分批 setImmediate 让出事件循环」
 *
 * 为什么必须是 setImmediate 而不是 `await Promise.resolve()`：
 *   · 微任务（Promise）**不会**让出事件循环，IO 回调与 IPC 消息仍然排在后面
 *   · setImmediate 排在 check 阶段，能真正让 IO/timer 先跑一轮
 * 这就是「分批 insert 之间必须让路」的技术原因。
 */

/**
 * 让出事件循环一轮，使 IO 回调、IPC 消息、定时器有机会执行。
 * 在写入/计算的分批循环里每一批之后都要调用它（否则主进程会「假死」）。
 */
export function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/** 让出若干轮（给渲染进程的紧急消息留更宽的窗口） */
export async function yieldTimes(rounds: number): Promise<void> {
  for (let i = 0; i < Math.max(0, rounds); i++) await yieldToLoop()
}

/** 睡眠（可被 AbortSignal 打断；取消后立即 resolve，由调用方检查 signal） */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
