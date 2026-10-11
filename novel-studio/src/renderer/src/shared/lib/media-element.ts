/**
 * Novel Studio · `<audio>` 区间播放（客户端侧）
 * ============================================================================
 * 背景（真机反馈：「CV 音导入后无法播放」）：
 *   · 「按说话人导入」的 take 指向**整段源文件**，音频在文件里的第 N 秒（`srcInMs`），
 *     不是第 0 秒；
 *   · `<audio>` 的 `currentTime` 必须在**元数据加载之后**设置 —— 设 `src` 之后立刻赋值，
 *     浏览器会忽略（还没解析出时长），于是「点了播放却从文件开头开始放」。
 *
 * 这两件事都在这里收口：`playRange` 负责「设 src → 等 loadedmetadata → seek → play」，
 * 并在 `timeupdate` 里播到区间终点就停（否则一条 22 分钟的文件会一直放下去）。
 */

/**
 * `<audio>` 里这个模块用到的部分。
 *
 * 写成**结构类型**而不是直接写 `HTMLAudioElement`：主进程/测试工程的 `lib` 里没有 DOM，
 * 而测试要 import 这个文件（渲染进程其它模块都没引用 DOM 类型，所以从前没暴露这个问题）。
 * 真实的 `<audio>` 元素天然满足它。
 */
export interface ClipAudioElement {
  currentTime: number
  src: string
  readyState: number
  load(): void
  play(): Promise<void>
  pause(): void
  addEventListener(type: ClipEventName, listener: () => void): void
  removeEventListener(type: ClipEventName, listener: () => void): void
}

type ClipEventName = 'loadedmetadata' | 'error' | 'timeupdate' | 'ended' | 'pause'

/**
 * 播放到区间终点就暂停（返回取消订阅函数）。
 *
 * ⚠️ **只用 `timeupdate` 是不够的**：它每 ~250ms 才触发一次，于是播放会冲过区间终点
 * 最多 250ms。真机症状就是「这一行的末尾有下一段的杂音」——
 * 2221 章那一行的 take 止于 36990，而下一句开头的「众」从 37138 才开始，
 * 差 148ms：区间本身没错，是**播放冲过头**把那个字放出来了。
 *
 * 所以这里三层保险：
 *   ① `requestAnimationFrame`（约 16ms 一次）—— 主判据，冲到终点立刻暂停；
 *   ② `timeupdate` —— rAF 在后台窗口被节流时的兜底；
 *   ③ `ended`/`pause` —— 放完或用户手动暂停时收摊，别留下 rAF 空转。
 */
/** `globalThis` 上可能的 rAF（浏览器有、Node/测试环境没有） */
interface RafHost {
  requestAnimationFrame?: (callback: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
}

export function clipToEnd(element: ClipAudioElement, endMs: number): () => void {
  let frameId: number | null = null
  let done = false

  /** 浏览器里 rAF 必须带 window 作为 this（裸调用会 Illegal invocation），所以包一层 */
  const host = globalThis as unknown as RafHost
  const requestFrame: ((cb: () => void) => number) | null =
    typeof host.requestAnimationFrame === 'function' ? (cb) => host.requestAnimationFrame!(cb) : null
  const cancelFrame: ((handle: number) => void) | null =
    typeof host.cancelAnimationFrame === 'function' ? (handle) => host.cancelAnimationFrame!(handle) : null

  const reachedEnd = (): boolean => element.currentTime * 1000 >= endMs

  const stop = (): void => {
    if (done) return
    done = true
    if (frameId !== null && cancelFrame) cancelFrame(frameId)
    frameId = null
    element.removeEventListener('timeupdate', onTimeUpdate)
    element.removeEventListener('ended', stop)
    element.removeEventListener('pause', stop)
  }

  const onTimeUpdate = (): void => {
    if (reachedEnd()) {
      element.pause()
      stop()
    }
  }

  const tick = (): void => {
    if (done) return
    if (reachedEnd()) {
      element.pause()
      stop()
      return
    }
    frameId = requestFrame ? requestFrame(tick) : (setTimeout(tick, 16) as unknown as number)
  }

  element.addEventListener('timeupdate', onTimeUpdate)
  element.addEventListener('ended', stop)
  element.addEventListener('pause', stop)
  frameId = requestFrame ? requestFrame(tick) : (setTimeout(tick, 16) as unknown as number)
  return stop
}

/**
 * 等 `loadedmetadata`（已经加载过就直接返回）。
 *
 * 为什么必须有超时：`<audio preload="none">`（录音页那个元素就是）在 `play()` 之前
 * **不会去取数据**，没有超时的话这里会永远挂着 —— 用户看到的是「点播放没反应」，
 * 正是这次要修的故障形态。超时后由调用方按「音频不可用」上报。
 */
function waitForMetadata(element: ClipAudioElement, timeoutMs = 15_000): Promise<void> {
  // 1 = HAVE_METADATA：有了它 currentTime 才能可靠地赋值
  if (element.readyState >= 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      element.removeEventListener('loadedmetadata', onLoaded)
      element.removeEventListener('error', onError)
    }
    const onLoaded = (): void => { cleanup(); resolve() }
    const onError = (): void => { cleanup(); reject(new Error('media-load-failed')) }
    element.addEventListener('loadedmetadata', onLoaded)
    element.addEventListener('error', onError)
    timer = setTimeout(() => { cleanup(); reject(new Error('media-metadata-timeout')) }, timeoutMs)
  })
}

/** 上一次 clipToEnd 的取消函数（同一个元素反复播不同 take 时不能越积越多） */
const clipCancels = new WeakMap<ClipAudioElement, () => void>()

/**
 * 播放 `url` 的 `[startMs, endMs)` 这一段。
 *
 * 失败（文件缺失/格式不支持/被 CSP 拦）会 **reject**，由调用方决定怎么提示；
 * 这里不做静默降级 —— 「点了播放没反应」正是这次要修的问题。
 */
export async function playRange(
  element: ClipAudioElement,
  url: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const previous = clipCancels.get(element)
  if (previous) { previous(); clipCancels.delete(element) }
  element.pause()
  element.src = url
  // 显式 load()：`preload="none"` 的元素不会自己取数据，不调它就等不到 loadedmetadata
  element.load()
  await waitForMetadata(element)
  const startSec = Math.max(0, startMs / 1000)
  // 差值太小就不动：重新赋同样的 currentTime 会让部分实现重新 seek（有咔哒声）
  if (Math.abs(element.currentTime - startSec) > 0.02) element.currentTime = startSec
  if (endMs > startMs) clipCancels.set(element, clipToEnd(element, endMs))
  await element.play()
}