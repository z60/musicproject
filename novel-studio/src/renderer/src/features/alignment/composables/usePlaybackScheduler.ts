/**
 * 对轨域 · 试听调度（Web Audio）
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md §6.1（实时试听的音频图与调度规则）
 *
 *   [片段文件 (ns-media://)] ─▶ AudioBufferSourceNode ─▶ itemGain ─▶ trackGain ─▶ master ─▶ destination
 *                                      ▲
 *                               按 arrangement 的 offset 调度启动
 *
 *   · 每个 item 一个 source，`source.start(when, offset, duration)`：
 *       when     = ctx.currentTime + (itemStartMs - playheadMs) / 1000
 *       offset   = srcInMs / 1000
 *       duration = (srcOutMs - srcInMs) / 1000
 *   · 每轨一个 GainNode 承担**音量 / Mute / Solo**；`itemGain` 承担淡入淡出；
 *     主 GainNode 到 destination（docs/13 §4.6 的 Solo/Mute 要求「每轨独立」）。
 *   · 播放头随 `ctx.currentTime` 前进（rAF 更新 store 里的 currentMs），播到章末自动停；
 *     循环区间支持反复听同一处重叠。
 *   · 不做实时处理链（处理链交给 ffmpeg，docs/14）：试听时可选用 `processed_path`
 *     或原始文件，切换只影响**加载哪个文件**，不改变音频图结构。
 *   · 长章节按**播放窗口**懒加载（只 fetch/decode 播放头附近 20 s 内的片段），
 *     解码结果按「处理方式 + 路径」缓存（上限见 BUFFER_CACHE_LIMIT），
 *     避免 2000 个 item 的章节一次性吃满内存。
 *
 * 已知风险（无运行环境无法验证，写在这里避免下次踩）：
 *   `fetch('ns-media://…')` 要求主进程注册该协议时开启 `supportFetchAPI: true`
 *   （docs/20 §8 的 mediaUrl 与 preload 侧实现）。若被拒，本文件会走 error-bus
 *   报 `AUDIO_DECODE_FAILED` 之类的错误并给出「改用 <audio> 试听」的提示，
 *   而不是静默无声（静默无声是最难排查的一种失败）。
 */

import { onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'
import type { ArrangementItem, Id, TrackId } from '@shared/types.ts'
import { reportError } from '@/shared/lib/error-bus.ts'
import { mediaUrlWithCacheBust, processedUrl, segmentUrl } from '@/shared/lib/media-url.ts'
import { itemDurationMs } from '@shared/arrange/layout.ts'
import { usePlaybackStore } from '../stores/playback.store.ts'
import type { SegmentSource } from '../stores/arrangement.store.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 播放窗口：只调度/加载播放头之后这段时间内的片段（docs/13 §6.1「长章节按播放窗口懒加载」） */
export const PLAY_WINDOW_MS = 20_000

/** 解码结果缓存上限（条）。短片段（十几秒 WAV）解码后约 1~3 MB，48 条约几十 MB */
export const BUFFER_CACHE_LIMIT = 48

/** 计划开始时间往前留的余量（秒）：太小会被调度器丢帧，太大会让「按 Space」有延迟 */
const SCHEDULE_LEAD_S = 0.03

/** dB → 线性增益 */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1
  if (db <= -60) return 0
  return Math.pow(10, db / 20)
}

export interface PlaybackSchedulerOptions {
  /** 当前项目（拼 ns-media:// 用）；为空则无法试听 */
  projectId: () => string | null
  /** 章节总时长（播到末自动停） */
  totalDurationMs: () => number
  /** 轨内 items（调度遍历全部轨） */
  itemsByTrack: () => ReadonlyMap<TrackId, ArrangementItem[]>
  /** 片段来源（processed / 原始，由 playback store 的 useProcessed 决定） */
  resolveSource: (item: ArrangementItem) => SegmentSource | null
  /** 循环区间 */
  loop: () => { startMs: number; endMs: number } | null
  /** 播放头读写（与时间线 store 同步） */
  getPlayheadMs: () => number
  setPlayheadMs: (ms: number) => void
  /** 设置里的期望采样率（与 AudioContext 实际值不一致时提示） */
  expectedSampleRate: () => number | null
}

export interface PlaybackSchedulerApi {
  /** 懒初始化 AudioContext（必须在用户手势里调用，否则被自动播放策略拦住） */
  init: () => Promise<boolean>
  isReady: Ref<boolean>
  /** 当前活动的 source 数（诊断：排查「有声音但节点泄漏」） */
  activeSourceCount: Ref<number>
  play: (fromMs?: number) => Promise<void>
  pause: () => void
  stop: () => void
  seek: (ms: number) => void
  /** 单片段试听（Inspector 的「试听该片段」/ 底部状态条） */
  auditionItem: (item: ArrangementItem | null) => Promise<void>
  /** 音量 / Mute / Solo 改变后重新应用（不做重建，只 setTargetAtTime） */
  applyMix: () => void
  /** 清空解码缓存（切换处理后/原始文件、切换章节时调用） */
  clearCache: () => void
  dispose: () => void
}

interface ActiveSource {
  node: AudioBufferSourceNode
  gain: GainNode
  trackId: TrackId
  itemId: Id
}

export function usePlaybackScheduler(options: PlaybackSchedulerOptions): PlaybackSchedulerApi {
  const playback = usePlaybackStore()

  const isReady = ref(false)
  const activeSourceCount = ref(0)

  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  const trackGains = new Map<TrackId, GainNode>()
  let active: ActiveSource[] = []

  /** 解码缓存：key = `${source.key}`（已含 processed/raw 区分） */
  const bufferCache = new Map<string, AudioBuffer>()
  const bufferInflight = new Map<string, Promise<AudioBuffer | null>>()

  let rafHandle: number | null = null
  let startedAtCtxTime = 0
  let startedAtMs = 0

  // -------------------------------------------------------------------------
  // 基础设施
  // -------------------------------------------------------------------------

  async function init(): Promise<boolean> {
    if (ctx) {
      if (ctx.state === 'suspended') await ctx.resume()
      isReady.value = true
      return true
    }
    try {
      const Ctor = globalThis.AudioContext
      if (typeof Ctor !== 'function') {
        reportError(new Error('当前环境没有 AudioContext'), { event: 'alignment.playback.noAudioContext' })
        return false
      }
      ctx = new Ctor({ latencyHint: 'playback' })
      master = ctx.createGain()
      master.gain.value = dbToGain(playback.masterGainDb)
      master.connect(ctx.destination)
      isReady.value = true
      playback.setSampleRate(ctx.sampleRate)
      const expected = options.expectedSampleRate()
      // 采样率不一致不会让试听失败，但会让「试听比导出更亮/更闷」——明确提示而不是让用户猜
      if (expected && Number.isFinite(expected) && Math.abs(expected - ctx.sampleRate) > 1) {
        playback.setError(new Error(`试听采样率 ${ctx.sampleRate} Hz 与设置中的 ${expected} Hz 不一致`))
      } else {
        playback.setError(null)
      }
      return true
    } catch (error) {
      playback.setError(error)
      reportError(error, { event: 'alignment.playback.initFailed' })
      return false
    }
  }

  /**
   * 片段 URL：`processed_path` 有值且用户选了「处理后」时用处理后的文件。
   * `ns-media://<projectId>/<relPath>`（主进程做路径校验，docs/01 §4.3）。
   */
  function urlOf(source: SegmentSource, projectId: string): string | null {
    const url = source.isProcessed
      ? processedUrl(projectId, source.path)
      : segmentUrl(projectId, source.path)
    if (!url) return null
    // 重新处理同一片段后文件名不变：带一个版本参数，避免命中旧缓存听不出变化
    return mediaUrlWithCacheBust(url, source.isProcessed ? 'p' : 'r')
  }

  function evictBuffers(): void {
    while (bufferCache.size > BUFFER_CACHE_LIMIT) {
      const oldest = bufferCache.keys().next()
      if (oldest.done) break
      bufferCache.delete(oldest.value)
    }
  }

  /** 取（必要时 fetch + decode）片段音频；失败返回 null 并由调用方决定是否报错 */
  async function loadBuffer(source: SegmentSource, silent = false): Promise<AudioBuffer | null> {
    const cached = bufferCache.get(source.key)
    if (cached) {
      // LRU：命中即置为最新
      bufferCache.delete(source.key)
      bufferCache.set(source.key, cached)
      return cached
    }
    const inflight = bufferInflight.get(source.key)
    if (inflight) return await inflight

    const projectId = options.projectId()
    if (!projectId) return null
    const url = urlOf(source, projectId)
    if (!url) return null

    const task = (async (): Promise<AudioBuffer | null> => {
      playback.beginLoading()
      try {
        const activeCtx = ctx
        if (!activeCtx) return null
        const response = await fetch(url)
        if (!response.ok) throw new Error(`加载片段失败：HTTP ${response.status}`)
        const bytes = await response.arrayBuffer()
        const buffer = await activeCtx.decodeAudioData(bytes)
        bufferCache.set(source.key, buffer)
        evictBuffers()
        playback.markDecoded()
        return buffer
      } catch (error) {
        if (!silent) {
          reportError(error, {
            event: 'alignment.playback.decodeFailed',
            detailOverride: `无法加载片段音频：${source.path}。若该文件已被移动或删除，请重新录制或在录音页重新定位文件。`,
          })
        }
        return null
      } finally {
        playback.endLoading()
        bufferInflight.delete(source.key)
      }
    })()

    bufferInflight.set(source.key, task)
    return await task
  }

  // -------------------------------------------------------------------------
  // 音量 / Solo / Mute
  // -------------------------------------------------------------------------

  function trackGainNode(trackId: TrackId): GainNode | null {
    if (!ctx || !master) return null
    const existing = trackGains.get(trackId)
    if (existing) return existing
    const node = ctx.createGain()
    node.gain.value = 0
    node.connect(master)
    trackGains.set(trackId, node)
    return node
  }

  /** 把 store 里的音量/Solo/Mute 应用到音频图（改变时不重建节点，只改增益） */
  function applyMix(): void {
    if (!ctx) return
    const now = ctx.currentTime
    if (master) {
      // setTargetAtTime 平滑过渡，避免拖动音量滑块时的爆音
      master.gain.setTargetAtTime(dbToGain(playback.masterGainDb), now, 0.01)
    }
    const audible = new Set<TrackId>()
    for (const item of iterateItems()) audible.add(item.trackId)
    for (const trackId of audible) {
      const node = trackGainNode(trackId)
      if (!node) continue
      const gain = playback.isAudible(trackId) ? dbToGain(playback.gainOf(trackId)) : 0
      node.gain.setTargetAtTime(gain, now, 0.01)
    }
  }

  /** 遍历当前 items（所有轨，按轨内顺序） */
  function* iterateItems(): Generator<ArrangementItem> {
    for (const list of options.itemsByTrack().values()) {
      for (const item of list) yield item
    }
  }

  // -------------------------------------------------------------------------
  // 调度
  // -------------------------------------------------------------------------

  function stopAllSources(): void {
    for (const entry of active) {
      try {
        entry.node.onended = null
        entry.node.stop()
      } catch {
        /* 已经停了 */
      }
      try {
        entry.node.disconnect()
        entry.gain.disconnect()
      } catch {
        /* 忽略 */
      }
    }
    active = []
    activeSourceCount.value = 0
  }

  function stopRaf(): void {
    if (rafHandle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(rafHandle)
    }
    rafHandle = null
  }

  /**
   * 调度一个 item。
   * `when` 用绝对时间（ctx.currentTime 基准），因此多轨之间的同步由 Web Audio
   * 的采样级时钟保证（docs/13 §6.1「播放精度：when 是采样级精确」）。
   */
  function scheduleItem(item: ArrangementItem, buffer: AudioBuffer, playheadMs: number, trackId: TrackId): void {
    const activeCtx = ctx
    if (!activeCtx) return
    const trackNode = trackGainNode(trackId)
    if (!trackNode) return

    const itemStart = item.timelineStartMs
    const itemEnd = itemStart + itemDurationMs(item)
    const srcIn = Math.max(0, item.srcInMs)
    const srcOut = Math.max(srcIn, item.srcOutMs)

    // 与播放头的关系决定 when / offset / duration
    const deltaMs = itemStart - playheadMs
    let when: number
    let offsetSec: number
    let durationSec: number

    if (deltaMs >= 0) {
      when = activeCtx.currentTime + SCHEDULE_LEAD_S + deltaMs / 1000
      offsetSec = srcIn / 1000
      durationSec = Math.max(0, (srcOut - srcIn) / 1000)
    } else {
      // 已经开头的片段：从播放头处切进去（offset 前移相同毫秒数）
      const intoMs = playheadMs - itemStart
      if (intoMs >= itemEnd - itemStart) return
      when = activeCtx.currentTime + SCHEDULE_LEAD_S
      offsetSec = (srcIn + intoMs) / 1000
      durationSec = Math.max(0, (srcOut - srcIn - intoMs) / 1000)
    }
    if (!(durationSec > 0)) return

    const node = activeCtx.createBufferSource()
    node.buffer = buffer
    const gain = activeCtx.createGain()
    node.connect(gain)
    gain.connect(trackNode)

    // 淡入淡出（itemGain）：起点 0 → 1，末段 1 → 0（docs/13 §6.1 图中的 itemGain）
    const fadeInSec = Math.max(0, item.fadeInMs) / 1000
    const fadeOutSec = Math.max(0, item.fadeOutMs) / 1000
    const startAt = when
    const endAt = when + durationSec
    const gainParam = gain.gain
    gainParam.setValueAtTime(fadeInSec > 0 ? 0 : 1, startAt)
    if (fadeInSec > 0) gainParam.linearRampToValueAtTime(1, Math.min(endAt, startAt + fadeInSec))
    if (fadeOutSec > 0 && endAt - fadeOutSec > startAt) {
      gainParam.setValueAtTime(1, endAt - fadeOutSec)
      gainParam.linearRampToValueAtTime(0, endAt)
    }

    const entry: ActiveSource = { node, gain, trackId, itemId: item.id }
    node.onended = () => {
      active = active.filter(a => a !== entry)
      activeSourceCount.value = active.length
      try {
        node.disconnect()
        gain.disconnect()
      } catch {
        /* 忽略 */
      }
    }
    node.start(when, offsetSec, durationSec)
    active.push(entry)
    activeSourceCount.value = active.length
  }

  /** 播放窗口内需要调度的 items */
  function itemsInWindow(fromMs: number, toMs: number): ArrangementItem[] {
    const out: ArrangementItem[] = []
    for (const item of iterateItems()) {
      const end = item.timelineStartMs + itemDurationMs(item)
      // 与窗口相交（含「已在播放头之前但还没结束」的片段）
      if (end < fromMs || item.timelineStartMs > toMs) continue
      out.push(item)
    }
    return out
  }

  /**
   * 开始播放。
   * 调度流程：取窗口内 items → 先把解码全部拿到（用 beginLoading/endLoading 反馈进度）
   * → 一次性 schedule（时间基准统一为同一个 ctx.currentTime，多轨天然同步）。
   */
  async function play(fromMs?: number): Promise<void> {
    const started = await init()
    if (!started || !ctx) return
    const activeCtx = ctx

    const playhead = fromMs ?? options.getPlayheadMs()
    const total = options.totalDurationMs()
    const loop = options.loop()
    // 循环区间已设定但播放头在区间之外：从区间起点开始（否则窗口为空，按 Space 像「没反应」）
    if (loop && (playhead < loop.startMs || playhead >= loop.endMs)) {
      return await play(loop.startMs)
    }
    if (total > 0 && playhead >= total) {
      // 已经在章末：从头开始
      return await play(0)
    }

    stopAllSources()
    const windowEnd = Math.min(loop ? loop.endMs : Number.POSITIVE_INFINITY, playhead + PLAY_WINDOW_MS)
    const candidates = itemsInWindow(playhead, windowEnd)

    const tracks = new Set(candidates.map(i => i.trackId))
    for (const trackId of tracks) trackGainNode(trackId)
    applyMix()

    // 预加载（窗口内全部解码；短片段很快，长章节的窗口上限是 20 s 音频）
    const prepared: Array<{ item: ArrangementItem; buffer: AudioBuffer }> = []
    const results = await Promise.all(candidates.map(async (item) => {
      const source = options.resolveSource(item)
      if (!source) return null
      const buffer = await loadBuffer(source, true)
      return buffer ? { item, buffer } : null
    }))
    for (const entry of results) if (entry) prepared.push(entry)

    if (!prepared.length) {
      // 窗口内没有可播放的片段：不算错误，但要明确反馈（否则用户以为坏了）
      playback.setError(new Error('播放头之后 20 秒内没有可用的音频片段'))
      options.setPlayheadMs(playhead)
      return
    }

    startedAtCtxTime = activeCtx.currentTime
    startedAtMs = playhead
    for (const entry of prepared) scheduleItem(entry.item, entry.buffer, playhead, entry.item.trackId)

    playback.setPlaying(true)
    playback.setError(null)
    options.setPlayheadMs(playhead)
    startRaf()
  }

  /**
   * rAF 推进播放头（用 `ctx.currentTime` 而不是 Date.now：
   * 只有音频时钟才能保证「看到的播放头」与「听到的位置」一致）。
   */
  function startRaf(): void {
    stopRaf()
    const tick = (): void => {
      const activeCtx = ctx
      if (!activeCtx || !playback.isPlaying) {
        rafHandle = null
        return
      }
      const elapsedMs = (activeCtx.currentTime - startedAtCtxTime) * 1000
      const current = startedAtMs + elapsedMs
      const loop = options.loop()
      const total = options.totalDurationMs()

      if (loop && current >= loop.endMs) {
        // 循环区间：重新调度（反复听同一处重叠，docs/13 §4.6）
        // play() 内部会 stopAllSources + 重排调度 + 重启 rAF，因此这里直接 return
        void play(loop.startMs)
        return
      }
      if (total > 0 && current >= total) {
        options.setPlayheadMs(total)
        playback.setCurrentMs(total)
        playback.setPlaying(false)
        stopAllSources()
        rafHandle = null
        return
      }

      playback.setCurrentMs(current)
      // 播放头走到窗口末尾前补调度下一段（滚动窗口，避免长章节一次性调度几千个节点）
      if (current - startedAtMs > PLAY_WINDOW_MS * 0.5) {
        startedAtMs = current
        startedAtCtxTime = activeCtx.currentTime
        void extendWindow(current)
      }
      const raf = globalThis.requestAnimationFrame
      rafHandle = typeof raf === 'function' ? raf(tick) : null
    }
    const raf = globalThis.requestAnimationFrame
    rafHandle = typeof raf === 'function' ? raf(tick) : null
  }

  /** 播放窗口向前滚动时补调度（已调度过的片段靠 source 去重，不会重复出声） */
  async function extendWindow(fromMs: number): Promise<void> {
    if (!ctx) return
    const scheduled = new Set(active.map(a => a.itemId))
    const loop = options.loop()
    const toMs = Math.min(loop ? loop.endMs : Number.POSITIVE_INFINITY, fromMs + PLAY_WINDOW_MS)
    const need = itemsInWindow(fromMs, toMs).filter(item => !scheduled.has(item.id))
    if (!need.length) return
    for (const item of need) {
      const source = options.resolveSource(item)
      if (!source) continue
      const buffer = await loadBuffer(source, true)
      if (!buffer) continue
      if (!playback.isPlaying) return
      // 补调度的片段：以「现在」为基准、按其与当前播放头的关系切进去
      scheduleItem(item, buffer, options.getPlayheadMs(), item.trackId)
    }
  }

  function pause(): void {
    stopAllSources()
    stopRaf()
    playback.setPlaying(false)
  }

  function stop(): void {
    pause()
    playback.setCurrentMs(0)
    options.setPlayheadMs(0)
  }

  /** 跳转：播放中则重排调度，停止中则只移动播放头 */
  function seek(ms: number): void {
    const wasPlaying = playback.isPlaying
    stopAllSources()
    stopRaf()
    options.setPlayheadMs(ms)
    playback.setCurrentMs(ms)
    playback.setPlaying(false)
    if (wasPlaying) void play(ms)
  }

  /**
   * 单片段试听（Inspector 与状态条）。
   * 与整章试听共用音频图，但只调度一个 source；结束时自动清理高亮。
   */
  async function auditionItem(item: ArrangementItem | null): Promise<void> {
    if (!item) {
      playback.setAuditionItem(null)
      return
    }
    const started = await init()
    if (!started || !ctx) return
    stopAllSources()
    stopRaf()
    playback.setPlaying(false)

    const source = options.resolveSource(item)
    if (!source) {
      playback.setError(new Error('该片段没有可用的音频文件（可能在录音页尚未生成片段）'))
      return
    }
    const buffer = await loadBuffer(source, false)
    if (!buffer) return

    playback.setAuditionItem(item.id)
    const trackNode = trackGainNode(item.trackId)
    applyMix()
    if (!trackNode) return

    const activeCtx = ctx
    const node = activeCtx.createBufferSource()
    node.buffer = buffer
    const gain = activeCtx.createGain()
    node.connect(gain)
    gain.connect(trackNode)
    const when = activeCtx.currentTime + SCHEDULE_LEAD_S
    const durationSec = Math.max(0.01, (Math.max(item.srcInMs, item.srcOutMs) - item.srcInMs) / 1000)
    const gainParam = gain.gain
    const fadeInSec = Math.max(0, item.fadeInMs) / 1000
    const fadeOutSec = Math.max(0, item.fadeOutMs) / 1000
    gainParam.setValueAtTime(fadeInSec > 0 ? 0 : 1, when)
    if (fadeInSec > 0) gainParam.linearRampToValueAtTime(1, Math.min(when + durationSec, when + fadeInSec))
    if (fadeOutSec > 0) gainParam.linearRampToValueAtTime(0, when + durationSec)

    const entry: ActiveSource = { node, gain, trackId: item.trackId, itemId: item.id }
    node.onended = () => {
      active = active.filter(a => a !== entry)
      activeSourceCount.value = active.length
      if (playback.auditionItemId === item.id) playback.setAuditionItem(null)
      try {
        node.disconnect()
        gain.disconnect()
      } catch {
        /* 忽略 */
      }
    }
    node.start(when, Math.max(0, item.srcInMs) / 1000, durationSec)
    active.push(entry)
    activeSourceCount.value = active.length
  }

  function clearCache(): void {
    bufferCache.clear()
    bufferInflight.clear()
  }

  function dispose(): void {
    stop()
    clearCache()
    for (const node of trackGains.values()) {
      try {
        node.disconnect()
      } catch {
        /* 忽略 */
      }
    }
    trackGains.clear()
    master = null
    const closing = ctx
    ctx = null
    isReady.value = false
    if (closing) void closing.close().catch(() => { /* 关闭失败不影响退出 */ })
  }

  onScopeDispose(dispose)

  return {
    init,
    isReady,
    activeSourceCount,
    play,
    pause,
    stop,
    seek,
    auditionItem,
    applyMix,
    clearCache,
    dispose,
  }
}
