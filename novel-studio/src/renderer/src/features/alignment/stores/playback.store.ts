/**
 * 对轨域 · 试听播放器状态
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md
 *   · §6.1 实时试听：`[片段文件] → AudioBufferSourceNode → itemGain → trackGain → master → destination`
 *   · §4.6 Solo/Mute：每轨独立，「用于听单轨与检查重叠」
 *
 * 分工（重要，别把两件事混在一起）：
 *   · 本 store 只存**状态**（是否在播、播放头毫秒、Solo/Mute/音量、可选处理后文件）；
 *   · 真正调度 Web Audio 节点的是 `composables/usePlaybackScheduler.ts`；
 *   · 播放头推进由调度器按 `ctx.currentTime` 写回 `currentMs`（rAF 节流）。
 *   这样「播放状态」可以在多个组件（底部状态条、MiniMap、检查器）之间共享，
 *   而 AudioContext 的生命周期只在调度器里管一处。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Id, TrackId } from '@shared/types.ts'

/** 音量范围（dB）：轨道滑块与主音量都用它，避免出现 0 增益听不见还以为坏了 */
export const GAIN_MIN_DB = -60
export const GAIN_MAX_DB = 12

export const usePlaybackStore = defineStore('alignment/playback', () => {
  /** 是否正在播放（调度器唯一写入口） */
  const isPlaying = ref(false)
  /** 播放头位置（毫秒）。播放时由 `ctx.currentTime` 推进，暂停/跳转时由交互直接设置 */
  const currentMs = ref(0)

  /** Solo：非空时只有这些轨可听（docs/13 §4.6） */
  const soloTrackIds = ref<TrackId[]>([])
  /** Mute：被静音的轨 */
  const mutedTrackIds = ref<TrackId[]>([])
  /** 每轨音量（dB），缺省 0 dB */
  const trackGainDb = ref<Record<string, number>>({})
  /** 主音量（dB），缺省 0 dB */
  const masterGainDb = ref(0)

  /**
   * 试听用处理后的文件还是原始文件（docs/13 §6.1「试听时可选用 processed_path 或原始文件」）。
   * 默认用处理后的：用户调完处理链就应该听处理后的效果。
   */
  const useProcessed = ref(true)

  /** 单片段试听中的 item（画布上给它加高亮） */
  const auditionItemId = ref<Id | null>(null)
  /** 正在解码/加载的片段数（>0 时状态条显示「正在加载音频…」） */
  const loadingCount = ref(0)
  /** 已经成功解码的片段数（诊断用，排查「点了试听没声音」） */
  const decodedCount = ref(0)
  /** 最近一次播放错误（AudioContext 未就绪 / 解码失败） */
  const lastError = ref<unknown>(null)
  /** AudioContext 采样率（与设置里的期望值不一致时状态条给出提示） */
  const sampleRate = ref<number | null>(null)

  const soloActive = computed(() => soloTrackIds.value.length > 0)

  /** 某轨此刻是否可听（Solo 优先于 Mute：有 Solo 时只听 Solo） */
  function isAudible(trackId: TrackId): boolean {
    if (soloActive.value) return soloTrackIds.value.includes(trackId)
    return !mutedTrackIds.value.includes(trackId)
  }

  function isSolo(trackId: TrackId): boolean {
    return soloTrackIds.value.includes(trackId)
  }

  function isMuted(trackId: TrackId): boolean {
    return mutedTrackIds.value.includes(trackId)
  }

  function toggleSolo(trackId: TrackId): void {
    soloTrackIds.value = isSolo(trackId)
      ? soloTrackIds.value.filter(id => id !== trackId)
      : [...soloTrackIds.value, trackId]
  }

  function toggleMute(trackId: TrackId): void {
    mutedTrackIds.value = isMuted(trackId)
      ? mutedTrackIds.value.filter(id => id !== trackId)
      : [...mutedTrackIds.value, trackId]
  }

  function clearSolo(): void {
    soloTrackIds.value = []
  }

  function gainOf(trackId: TrackId): number {
    return trackGainDb.value[trackId] ?? 0
  }

  function setTrackGain(trackId: TrackId, db: number): void {
    const clamped = Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db))
    trackGainDb.value = { ...trackGainDb.value, [trackId]: clamped }
  }

  function setMasterGain(db: number): void {
    masterGainDb.value = Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db))
  }

  function setPlaying(next: boolean): void {
    isPlaying.value = next
  }

  function setCurrentMs(ms: number): void {
    currentMs.value = Math.max(0, Math.round(ms))
  }

  function setAuditionItem(id: Id | null): void {
    auditionItemId.value = id
  }

  function setUseProcessed(next: boolean): void {
    useProcessed.value = next
  }

  function beginLoading(): void {
    loadingCount.value += 1
  }

  function endLoading(): void {
    loadingCount.value = Math.max(0, loadingCount.value - 1)
  }

  function markDecoded(): void {
    decodedCount.value += 1
  }

  function setError(error: unknown): void {
    lastError.value = error
  }

  function setSampleRate(hz: number | null): void {
    sampleRate.value = hz
  }

  /** 切换章节 / 卸载时复位（避免上一章的 Solo 影响新章节） */
  function reset(): void {
    isPlaying.value = false
    currentMs.value = 0
    soloTrackIds.value = []
    mutedTrackIds.value = []
    trackGainDb.value = {}
    masterGainDb.value = 0
    auditionItemId.value = null
    loadingCount.value = 0
    decodedCount.value = 0
    lastError.value = null
  }

  return {
    isPlaying, currentMs,
    soloTrackIds, mutedTrackIds, trackGainDb, masterGainDb,
    useProcessed, auditionItemId, loadingCount, decodedCount, lastError, sampleRate,
    soloActive,
    isAudible, isSolo, isMuted, toggleSolo, toggleMute, clearSolo,
    gainOf, setTrackGain, setMasterGain,
    setPlaying, setCurrentMs, setAuditionItem, setUseProcessed,
    beginLoading, endLoading, markDecoded, setError, setSampleRate,
    reset,
  }
})

export type PlaybackStore = ReturnType<typeof usePlaybackStore>
