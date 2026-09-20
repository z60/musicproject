/**
 * Novel Studio · 录音倒计时（docs/12 §3.2）
 * ============================================================================
 * 为什么单独抽一个 composable（真机事故 docs/91 §5.2.37）：
 *   「按录制键 → 倒计时 → 开始采集」这条链在两个视图里各写了一份 `setInterval`，
 *   而两份都**只把数字减到 0、把遮罩关掉，从来没调用过开始录音** ——
 *   默认设置就是倒计时 3 秒（`audio.countdownMs = 3000`），于是「点击录制没有开始」。
 *
 * 现在规则只有一份，而且**可被 Node 测试直接覆盖**（只依赖 `vue`，不 import 任何项目内模块）：
 *   · `request(totalMs)` —— 需要倒计时返回 true；`totalMs <= 0` 返回 false（调用方立即开录）
 *   · 归零 → 隐藏遮罩 + `onElapsed()`（**这就是事故里漏掉的那一步**）
 *   · `cancelAndBegin()` —— 用户按任意键：立刻开录（docs/12 §3.2「按下录制键要能立即开始」）
 *   · `stop()` —— 只清理（卸载/放弃时用，不触发开录）
 *
 * `onElapsed` 每次倒计时只触发一次（防止 tick 与取消同时到达时开录两次）。
 */

import { ref, type Ref } from 'vue'

export interface UseRecordCountdownOptions {
  /** 倒计时归零（或用户取消倒计时）→ 调用方开始录音 */
  onElapsed: () => void
  /** 每拍间隔，默认 100ms（测试注入更小的值） */
  stepMs?: number
  /** 定时器注入（测试用假定时器；默认 setInterval/clearInterval） */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
    clearInterval: (handle: ReturnType<typeof setInterval>) => void
  }
}

export interface RecordCountdown {
  /** 遮罩是否可见（父组件传给 CountdownOverlay 的 visible） */
  visible: Ref<boolean>
  /** 剩余秒数（父组件每拍更新，这里只做展示） */
  seconds: Ref<number>
  /**
   * 请求开始倒计时。
   * 返回 true = 已进入倒计时（等 `onElapsed`）；false = 不需要倒计时，调用方**立即**开始录音。
   */
  request: (totalMs: number) => boolean
  /** 用户按键/点击取消倒计时 → 立刻开始录音 */
  cancelAndBegin: () => void
  /** 只清理（卸载、放弃本次录制）：不触发开录 */
  stop: () => void
}

export function useRecordCountdown(options: UseRecordCountdownOptions): RecordCountdown {
  const stepMs = Math.max(1, options.stepMs ?? 100)
  const scheduler = options.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  }

  const visible = ref(false)
  const seconds = ref(0)
  let timer: ReturnType<typeof setInterval> | null = null
  /** 本次倒计时是否已经「开始录音」过（防止重复触发） */
  let elapsed = false

  function clearTimer(): void {
    if (timer !== null) scheduler.clearInterval(timer)
    timer = null
  }

  function hide(): void {
    visible.value = false
    seconds.value = 0
  }

  function fire(): void {
    if (elapsed) return
    elapsed = true
    clearTimer()
    hide()
    options.onElapsed()
  }

  function request(totalMs: number): boolean {
    clearTimer()
    if (!(totalMs > 0)) {
      hide()
      return false
    }
    elapsed = false
    seconds.value = totalMs / 1000
    visible.value = true
    let remaining = totalMs
    timer = scheduler.setInterval(() => {
      remaining -= stepMs
      seconds.value = Math.max(0, remaining / 1000)
      if (remaining <= 0) fire()
    }, stepMs)
    return true
  }

  function cancelAndBegin(): void {
    // 没在倒计时时不该被当成「开始录制」（避免误触发）
    if (!visible.value) return
    fire()
  }

  function stop(): void {
    elapsed = true
    clearTimer()
    hide()
  }

  return { visible, seconds, request, cancelAndBegin, stop }
}
