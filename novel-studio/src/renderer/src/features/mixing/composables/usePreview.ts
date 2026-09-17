/**
 * Novel Studio · 预听渲染与 A/B 试听调度（docs/14 §10、docs/15 §8）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §10 —— 预听与对比：单片段 A/B（同一位置切换）、列表盲听、
 *     处理链逐步启用、章节级预览
 *   · docs/14 §4.3 ⑤ —— 每个参数的 A/B 试听按钮：`process:preview` 渲染前 N 秒
 *   · docs/15 §8 —— **播放器试听与 ffmpeg 渲染结果可能不一致**（尤其 ducking 与响度），
 *     因此「渲染预览」才是正确验证手段：本文件做的正是**渲染预览**，不是 Web Audio 模拟。
 *
 * 三件事在这个文件里，且只在这里：
 *   1. `renderProcessedPreview()`：`process:preview` 的防抖 + 取消 + 结果缓存。
 *      为什么必须防抖 + 取消：这个通道会**真的起一次 ffmpeg**。用户拖动参数时
 *      若每次都发一次请求，轻则排队卡住，重则几十个 ffmpeg 同时抢 CPU
 *      （docs/04 §6 的并发限制是给任务队列用的，临时的 preview 不在队列里）。
 *      做法是「请求序号」：只有最后一个请求会真正发起 IPC，先到的直接作废。
 *      这里不用 AbortController —— IPC 的 invoke 无法被真正中断，
 *      序号方案能保证「不多渲染」，AbortController 只能保证「不处理结果」。
 *   2. `waitForTask()` / `extractPathFromTaskResult()`：渲染类通道返回的是 taskId，
 *      需要等任务结束再拿产物路径。
 *   3. `usePreview()`：真正的播放控制（`HTMLAudioElement`），支持
 *      A/B 同一位置切换（切源前记住 currentTime，切源后 seek 回同一位置）。
 *
 * 关于「实时电平表」的一个已知取舍（重要）：
 *   把 <audio> 接进 Web Audio（createMediaElementSource）能得到真实时电平，
 *   但该 API 对**跨源媒体**会把输出静音（除非协议同时启用 corsEnabled 且
 *   元素带 crossOrigin）。`ns-media://` 的协议注册在主进程侧（当前仓库尚未实现），
 *   我们无法在渲染进程确认 CORS 行为——贸然接线会导致「预听没声音」这种最糟的故障。
 *   因此这里默认**不**接线：预听的电平由产物文件的实测指标驱动
 *   （`analysis:metrics` → `pushMeterLevels`），并沿用 useMeter 的弹道动画。
 *   `realtimeMeter` 选项留给协议侧确认后再打开。
 */

import { onScopeDispose, readonly, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { AudioMetrics, Id, ProcessChain, TaskRecord, TaskStatus } from '@shared/types.ts'
import { call, callSafe, on } from '@/shared/lib/ipc.ts'
import { reportByKey } from '@/shared/lib/error-bus.ts'
import { tryBuildMediaUrl, isMediaUrl } from '@/shared/lib/media-url.ts'
import { pushMeterLevels, clearMeterLevels, setMeterLevelProvider, attachAnalyser } from '@/features/mixing/composables/useMeter.ts'
import type { AnalyserLevels } from '@/features/mixing/composables/useMeter.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** docs/15 §8：长章节预览只渲前 30 秒 */
export const DEFAULT_PREVIEW_DURATION_MS = 30_000

/** 连点时的合并窗口：窗口内的多次请求只保留最后一次 */
export const PREVIEW_DEBOUNCE_MS = 350

/** 预览产物缓存有效期（同一 chain 反复试听不必重复渲染） */
export const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// URL 解析
// ---------------------------------------------------------------------------

/**
 * 把主进程给的产物路径变成 `<audio src>` 可用的 URL。
 *
 * 三种形态：
 *   · 已经是 `ns-media://…` → 原样使用（主进程直接给了 URL）；
 *   · 项目内相对路径（`cache/tmp/xxx.wav`）→ 拼成 `ns-media://<projectId>/…`
 *     （主进程侧会做「必须落在项目目录内」的校验，docs/01 §4.3）；
 *   · 绝对路径 / `file://` → 原样返回。Electron 渲染进程能否直接读 file://
 *     取决于窗口的 webSecurity 配置，这里做「尽力而为」，失败由 audio 的
 *     error 事件兜底（见 usePreview 的 onerror）。
 */
export function resolvePreviewUrl(path: string | null | undefined, projectId: string | null | undefined): string | null {
  if (!path) return null
  if (isMediaUrl(path)) return path
  const asUrl = tryBuildMediaUrl(projectId ?? null, path)
  if (asUrl) return asUrl
  return path
}

// ---------------------------------------------------------------------------
// 任务结果解析
// ---------------------------------------------------------------------------

const PATH_KEYS = ['path', 'outputPath', 'output', 'filePath', 'previewPath'] as const

/** 从任务结果里尽力取出产物路径（不同通道的返回字段不完全一致） */
export function extractPathFromTaskResult(result: unknown): string | null {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/** 从任务结果里取批量处理报告（BatchProcessReport 的形状，见 processChain.store） */
export function extractBatchResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  return record.report ?? record.summary ?? result
}

export interface TaskWaitResult {
  status: TaskStatus
  result: unknown
  error: unknown
  timedOut: boolean
}

/**
 * 等一个任务进入终态。
 *
 * 为什么要「先查再订阅」：任务可能在我们订阅之前就结束了（预览渲染很快），
 * 只靠事件会永远等下去。因此先 `task:get` 一次，非终态才订阅 `task:finished`。
 * 事件订阅一定在 finally 里取消，否则页面切走后监听器泄漏（docs/20 §7）。
 */
export async function waitForTask(
  taskId: Id,
  options: { timeoutMs?: number } = {},
): Promise<TaskWaitResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000

  const snapshot = await callSafe('task:get', { taskId }) as TaskRecord | null
  if (snapshot && isTerminalStatus(snapshot.status)) {
    return { status: snapshot.status, result: snapshot.result, error: snapshot.error, timedOut: false }
  }

  return await new Promise<TaskWaitResult>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let off: (() => void) | null = null

    const finish = (value: TaskWaitResult): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      off?.()
      resolve(value)
    }

    off = on('task:finished', (payload) => {
      if (!payload || payload.taskId !== taskId) return
      finish({
        status: (payload.status ?? 'succeeded') as TaskStatus,
        result: payload.result,
        error: payload.error,
        timedOut: false,
      })
    })

    timer = setTimeout(() => {
      finish({ status: 'interrupted', result: null, error: null, timedOut: true })
    }, Math.max(1000, timeoutMs))
  })
}

export function isTerminalStatus(status: TaskStatus | undefined | null): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

// ---------------------------------------------------------------------------
// process:preview 的防抖 / 取消 / 缓存
// ---------------------------------------------------------------------------

interface CacheEntry {
  url: string
  at: number
}

const previewCache = new Map<string, CacheEntry>()
let requestSeq = 0

/** 当前是否有预览渲染在排队/进行（UI 用来显示「渲染中…」） */
const pendingCount = ref(0)
export const previewPendingCount: Readonly<Ref<number>> = readonly(pendingCount)

function cacheKeyOf(segmentId: Id, chain: ProcessChain, durationMs: number): string {
  // 用 JSON 做键：chain 是小对象（几十个字段），序列化成本可忽略；
  // 真正的成本在 ffmpeg，缓存命中收益远大于这里。
  return `preview:${segmentId}:${durationMs}:${JSON.stringify(chain)}`
}

function readCache(key: string): string | null {
  const hit = previewCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > PREVIEW_CACHE_TTL_MS) {
    previewCache.delete(key)
    return null
  }
  return hit.url
}

/** 清空预览缓存（切换章节 / 处理链被改动后调用） */
export function clearPreviewCache(): void {
  previewCache.clear()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

export interface RenderPreviewOptions {
  segmentId: Id
  chain: ProcessChain
  /** 渲染时长（毫秒）；默认前 30 秒（docs/15 §8） */
  durationMs?: number
  /** 合并窗口；传 0 表示立即渲染（例如点击「A/B」按钮时不该再等） */
  debounceMs?: number
  /** 项目 id：用于把产物相对路径转成 ns-media:// URL */
  projectId?: string | null
  /** 是否跳过缓存强制重渲（参数改动后需要） */
  force?: boolean
}

export interface RenderPreviewResult {
  url: string | null
  path: string | null
  /** 被更新的请求取代（没有发起 IPC） */
  superseded: boolean
  error: unknown
}

/**
 * 渲染一段预览音频（`process:preview`）。
 *
 * 语义：
 *   · 350 ms 内的连点只保留最后一次（`superseded=true` 的调用直接返回，不发 IPC）；
 *   · 相同的 (segmentId, chain, durationMs) 命中缓存，不重复渲染；
 *   · 失败按 error-bus 兑现（默认弹提示），并返回 `error` 供 UI 内联显示。
 */
export async function renderProcessedPreview(options: RenderPreviewOptions): Promise<RenderPreviewResult> {
  const durationMs = options.durationMs ?? DEFAULT_PREVIEW_DURATION_MS
  const key = cacheKeyOf(options.segmentId, options.chain, durationMs)

  if (!options.force) {
    const cached = readCache(key)
    if (cached) return { url: cached, path: null, superseded: false, error: null }
  }

  const mySeq = ++requestSeq
  const debounceMs = options.debounceMs ?? PREVIEW_DEBOUNCE_MS
  pendingCount.value += 1

  try {
    if (debounceMs > 0) {
      await sleep(debounceMs)
      // 期间有新请求 → 本次作废，不发起 IPC（这就是「取消上一次渲染」）
      if (mySeq !== requestSeq) {
        return { url: null, path: null, superseded: true, error: null }
      }
    }

    const res = await call('process:preview', {
      segmentId: options.segmentId,
      chain: options.chain,
      durationMs,
    }) as { path: string }

    const path = res?.path ?? null
    const url = resolvePreviewUrl(path, options.projectId ?? null)
    if (url) previewCache.set(key, { url, at: Date.now() })
    return { url, path, superseded: false, error: null }
  } catch (error) {
    return { url: null, path: null, superseded: false, error }
  } finally {
    pendingCount.value = Math.max(0, pendingCount.value - 1)
  }
}

// ---------------------------------------------------------------------------
// 产物实测指标（驱动表头 / A-B 读数）
// ---------------------------------------------------------------------------

/** 测一个预览产物的指标（silent：失败不弹提示，表头退化为「未测」即可） */
export async function measurePreviewFile(path: string): Promise<AudioMetrics | null> {
  return await callSafe('analysis:metrics', { path }) as AudioMetrics | null
}

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------

export type PreviewSide = 'A' | 'B'

export interface PreviewSource {
  /** `<audio src>` 用的 URL */
  url: string | null
  /** 人类可读标签（盲听时 UI 自行隐藏） */
  label?: string
  /**
   * 产物实测电平（可选）。播放时推给表头 id，让通道条 / 响度表显示**真实测量值**
   * 而不是随便动一动的假动画（来源：process:preview 后紧跟 analysis:metrics）。
   */
  levels?: { rmsDb: number | null; peakDb: number | null } | null
}

export interface UsePreviewOptions {
  /** 播放时把实测电平推给这个表头 id（不传则不驱动表头） */
  meterId?: string | null
  /**
   * 是否把 `<audio>` 接进 Web Audio 做**真实时**电平。
   * 默认 false：`createMediaElementSource` 对跨源媒体会静音输出，
   * 而 `ns-media://` 的 CORS 行为由主进程协议注册决定（见文件头说明）。
   * 协议侧确认 corsEnabled 之后再打开这个开关。
   */
  realtimeMeter?: boolean
}

export interface PreviewHandle {
  /** 当前试听的是 A（原始）还是 B（处理后） */
  side: Ref<PreviewSide>
  playing: Readonly<Ref<boolean>>
  loading: Readonly<Ref<boolean>>
  ready: Readonly<Ref<boolean>>
  error: Readonly<Ref<unknown>>
  positionMs: Readonly<Ref<number>>
  durationMs: Readonly<Ref<number>>
  /** 当前实际使用的 URL */
  currentUrl: Readonly<Ref<string | null>>
  setSources: (a: PreviewSource | null, b: PreviewSource | null) => void
  setSide: (side: PreviewSide, opts?: { keepPosition?: boolean; autoplay?: boolean }) => Promise<void>
  toggle: () => Promise<void>
  play: () => Promise<void>
  pause: () => void
  seek: (positionMs: number) => void
  stop: () => void
  /** 关掉表头推送（关闭 A/B 条时调用，避免残留电平） */
  releaseMeter: () => void
}

/**
 * 预听播放器（一个实例 = 一个 `<audio>`）。
 *
 * 为什么用 `new Audio()` 而不是模板里的 `<audio>`：
 *   同一时刻全应用只允许**一个**预听在响（两个 A/B 播放器同时出声毫无意义），
 *   把它做成组件内的单例可以避免「模板里放一个隐藏 audio + ref 传递」的绕路，
 *   也让 AbCompareBar 这类纯展示组件不必关心音频元素的生命周期。
 *
 * A/B 切同一位置：
 *   `setSide()` 先记下 currentTime，再换 src 并 seek 回同一毫秒后继续播放。
 *   docs/15 §12 的测试要点「切换原始/处理后位置完全同步（无跳变）」就靠这一处实现。
 */
export function usePreview(options: UsePreviewOptions = {}): PreviewHandle {
  const side = ref<PreviewSide>('A')
  const playing = ref(false)
  const loading = ref(false)
  const ready = ref(false)
  const error = shallowRef<unknown>(null)
  const positionMs = ref(0)
  const durationMs = ref(0)
  const currentUrl = ref<string | null>(null)

  const sources: Record<PreviewSide, PreviewSource | null> = { A: null, B: null }

  let meterId = options.meterId ?? null
  /** 实时分析器（仅在 realtimeMeter 打开且协议支持时非空） */
  let analyser: AnalyserLevels | null = null
  let detachProvider: (() => void) | null = null
  const audio: HTMLAudioElement | null = typeof window !== 'undefined' && typeof Audio !== 'undefined'
    ? new Audio()
    : null

  if (audio) {
    audio.preload = 'auto'
  }

  function urlOf(target: PreviewSide): string | null {
    return sources[target]?.url ?? null
  }

  function syncMetrics(): void {
    if (!meterId) return
    const levels = sources[side.value]?.levels
    if (!levels) return
    pushMeterLevels(meterId, { rmsDb: levels.rmsDb ?? null, peakDb: levels.peakDb ?? null })
  }

  if (options.realtimeMeter && audio && meterId) {
    analyser = attachAnalyser(audio)
    if (analyser) {
      detachProvider = setMeterLevelProvider(meterId, analyser.read)
    }
  }

  function bindAudio(): void {
    if (!audio) return
    audio.addEventListener('timeupdate', () => { positionMs.value = audio.currentTime * 1000 })
    audio.addEventListener('loadedmetadata', () => {
      durationMs.value = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0
      ready.value = true
    })
    audio.addEventListener('play', () => {
      playing.value = true
      syncMetrics()
    })
    audio.addEventListener('pause', () => { playing.value = false })
    audio.addEventListener('ended', () => {
      playing.value = false
      positionMs.value = durationMs.value
    })
    audio.addEventListener('error', () => {
      playing.value = false
      ready.value = false
      // 音频文件丢失/被移动是 docs/22 里已有语义的错误（AUDIO_FILE_MISSING），
      // 不在这里自拼文案，交给 error-bus 按消息表兑现。
      error.value = reportByKey('AUDIO_FILE_MISSING', {
        source: sources[side.value]?.label ?? side.value,
      }, { event: 'mixing.preview.loadFailed' })
    })
  }

  bindAudio()

  async function play(): Promise<void> {
    if (!audio) return
    const url = urlOf(side.value)
    if (!url) return
    error.value = null
    try {
      analyser?.resume()
      await audio.play()
      syncMetrics()
    } catch (e) {
      // 自动播放被拦截（没有用户手势）或解码失败：只记状态，不弹提示
      error.value = e
      playing.value = false
    }
  }

  function pause(): void {
    audio?.pause()
  }

  async function toggle(): Promise<void> {
    if (playing.value) pause()
    else await play()
  }

  function seek(positionMsInput: number): void {
    if (!audio) return
    const max = durationMs.value > 0 ? durationMs.value : Number.POSITIVE_INFINITY
    const next = Math.min(Math.max(0, positionMsInput), max)
    try {
      audio.currentTime = next / 1000
      positionMs.value = next
    } catch {
      /* 尚未 loadedmetadata 时 seek 会抛，忽略 */
    }
  }

  function setSources(a: PreviewSource | null, b: PreviewSource | null): void {
    sources.A = a
    sources.B = b
    const nextUrl = urlOf(side.value)
    if (nextUrl && audio && audio.src !== nextUrl) {
      loading.value = true
      ready.value = false
      audio.src = nextUrl
      currentUrl.value = nextUrl
      audio.load()
    }
  }

  async function setSide(target: PreviewSide, opts: { keepPosition?: boolean; autoplay?: boolean } = {}): Promise<void> {
    const keepPosition = opts.keepPosition ?? true
    const position = positionMs.value
    const wasPlaying = playing.value || (opts.autoplay ?? false)
    const url = urlOf(target)
    const previousUrl = currentUrl.value

    side.value = target
    if (!url) {
      pause()
      return
    }
    if (url === previousUrl) {
      if (keepPosition) seek(position)
      if (wasPlaying) await play()
      return
    }

    if (audio) {
      loading.value = true
      ready.value = false
      audio.src = url
      currentUrl.value = url
      audio.load()
      // seek 要在元数据就绪之后：否则会被浏览器丢弃（表现为「切 A/B 跳回开头」）
      const onMeta = (): void => {
        audio.removeEventListener('loadedmetadata', onMeta)
        if (keepPosition) seek(position)
        loading.value = false
        if (wasPlaying) void play()
      }
      audio.addEventListener('loadedmetadata', onMeta)
    }
    syncMetrics()
  }

  function stop(): void {
    pause()
    seek(0)
  }

  function releaseMeter(): void {
    if (meterId) clearMeterLevels(meterId)
    meterId = null
  }

  onScopeDispose(() => {
    audio?.pause()
    if (audio) {
      audio.removeAttribute('src')
      audio.load()
    }
    detachProvider?.()
    analyser?.dispose()
    if (options.meterId) clearMeterLevels(options.meterId)
  })

  return {
    side,
    playing: readonly(playing) as Readonly<Ref<boolean>>,
    loading: readonly(loading) as Readonly<Ref<boolean>>,
    ready: readonly(ready) as Readonly<Ref<boolean>>,
    error: error as Readonly<Ref<unknown>>,
    positionMs: readonly(positionMs) as Readonly<Ref<number>>,
    durationMs: readonly(durationMs) as Readonly<Ref<number>>,
    currentUrl: readonly(currentUrl) as Readonly<Ref<string | null>>,
    setSources,
    setSide,
    toggle,
    play,
    pause,
    seek,
    stop,
    releaseMeter,
  }
}
