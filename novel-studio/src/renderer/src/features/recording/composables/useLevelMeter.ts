/**
 * 录音域 · 电平与静音检测（实时）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §3.1 —— 电平表要有「峰值 + 有效值 + 削波」三件事
 *   · docs/05 §2.5 —— 削波检测：**连续 ≥3 个样本 |x| ≥ 0.99 → 计数 +1**；
 *                     单次录音累计 > 20 次 → take 打 `clip` 标记
 *   · docs/12 §12  —— 「长时间削波：峰值持续 0 dBFS > 10 次 → 提示输入过载」
 *   · docs/05 §4.1 —— 帧级分析：20 ms 帧的 RMS(dBFS)；噪声底取**滑动 3 秒窗口的
 *                     10 分位**（比均值更抗语音污染）；门限 = 噪声底 + 12 dB
 *   · docs/12 §4.2 —— 连续录制要显示「当前是否静音」与「已识别到约 N 句」
 *
 * 本组合式函数只做数学，不碰 IPC、不碰 DOM：
 *   · `useRecorder` 用它算采集块的电平 → 20 Hz 上报主进程 + 写 recording.store
 *   · `DeviceDiagnosticsView` 用它算底噪（3 秒测量）
 *   · `ContinuousControls` 用它算静音指示与切点计数（给用户「可以停了」的提示）
 */

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { amplitudeToDbfs } from '@/shared/lib/waveform-transform.ts'
import { VAD_DEFAULTS, VAD_SPEECH_MARGIN_DB } from '@shared/constants.ts'

export interface LevelSample {
  rmsDb: number
  peakDb: number
  /** 本块是否已发生过削波（锁存值；由调用方决定何时清除） */
  clipping: boolean
}

export interface UseLevelMeterOptions {
  /** 帧长（毫秒），与 docs/05 §4.1 的 VAD 帧长一致 */
  frameMs?: number
  /** 噪声底滑动窗口（毫秒） */
  noiseWindowMs?: number
  /** 噪声底分位（0.1 = 10 分位） */
  noisePercentile?: number
  /** 削波：连续多少个样本超幅算一次事件 */
  clipRunLength?: number
  /** 削波幅度阈值（|x| ≥ 该值） */
  clipAmplitude?: number
  /** 噪声底不可用时的静音门限（dBFS） */
  fallbackSilenceDb?: number
  /** 语音判定余量（dB） */
  speechMarginDb?: number
  minSpeechMs?: number
  minSilenceMs?: number
  /** 峰值保持的衰减速率（dB/秒），0 = 不衰减 */
  peakDecayDbPerSec?: number
}

export interface UseLevelMeterReturn {
  /** 最近一块的 RMS（dBFS；数字静音为 -∞） */
  rmsDb: Ref<number | null>
  /** 最近一块的瞬时峰值（dBFS） */
  peakDb: Ref<number | null>
  /** 峰值保持（缓慢衰减，便于读数） */
  peakHoldDb: Ref<number | null>
  /** 削波锁存（一旦发生就为 true，直到 clearClip） */
  clipping: Ref<boolean>
  /** 削波事件累计（连续 ≥3 样本超幅算 1 次） */
  clipEvents: Ref<number>
  /** 峰值贴顶（≥ -0.1 dBFS）的块数 */
  overloadBlocks: Ref<number>
  /** 滑动窗口 10 分位噪声底（dBFS） */
  noiseFloorDb: Ref<number | null>
  /** 当前是否静音（docs/12 §4.2 的静音指示） */
  silence: Ref<boolean>
  /** 已检测到的语音段数（连续录制的「已识别到约 N 句」） */
  speechRunCount: Ref<number>
  /** 已处理帧数 / 总样本数（自检里用于核对采集计数） */
  frameCount: Ref<number>
  totalFrames: Ref<number>
  /** 有效语音时长（毫秒） */
  speechMs: Ref<number>
  /** 噪声底是否已经稳定可用（自检报告用） */
  noiseFloorReady: ComputedRef<boolean>
  /** 底噪偏高（> -50 dBFS）→ 建议降噪（docs/12 §6.1 检查项 4） */
  noiseFloorHigh: ComputedRef<boolean>
  /** 是否有信号：RMS > -50 dBFS（docs/12 §6.1 检查项 1） */
  signalDetected: ComputedRef<boolean>
  /** 峰值是否已经贴顶 */
  peakAtCeiling: ComputedRef<boolean>
  /** 当前生效的语音门限（噪声底 + 余量，或回退值） */
  speechThresholdDb: ComputedRef<number>
  pushBlock: (samples: Float32Array, sampleRate: number) => LevelSample
  /** 只用已知的帧 dB 喂入（自检里用已算好的帧） */
  pushFrameDb: (db: number, sampleRate: number) => void
  clearClip: () => void
  reset: (sampleRate?: number) => void
}

export function useLevelMeter(options: UseLevelMeterOptions = {}): UseLevelMeterReturn {
  const frameMs = options.frameMs ?? 20
  const noiseWindowMs = options.noiseWindowMs ?? 3000
  const noisePercentile = options.noisePercentile ?? 0.1
  const clipRunLength = options.clipRunLength ?? 3
  const clipAmplitude = options.clipAmplitude ?? 0.99
  const fallbackSilenceDb = options.fallbackSilenceDb ?? VAD_DEFAULTS.silenceDb
  const speechMarginDb = options.speechMarginDb ?? VAD_SPEECH_MARGIN_DB
  const minSpeechMs = options.minSpeechMs ?? VAD_DEFAULTS.minSpeechMs
  const minSilenceMs = options.minSilenceMs ?? VAD_DEFAULTS.minSilenceMs
  const peakDecayDbPerSec = options.peakDecayDbPerSec ?? 24

  const rmsDb = ref<number | null>(null)
  const peakDb = ref<number | null>(null)
  const peakHoldDb = ref<number | null>(null)
  const clipping = ref(false)
  const clipEvents = ref(0)
  const overloadBlocks = ref(0)
  const noiseFloorDb = ref<number | null>(null)
  const silence = ref(true)
  const speechRunCount = ref(0)
  const frameCount = ref(0)
  const totalFrames = ref(0)
  const speechMs = ref(0)

  /** 未凑满一帧的样本（50 ms 块 / 20 ms 帧必然有零头，丢掉会系统性低估噪声底） */
  let carry: Float32Array = new Float32Array(0)
  /** 帧 dB 滑动窗口 */
  let frameDbs: number[] = []
  let sampleRateRef = 48000
  let speechAccumMs = 0
  let silenceAccumMs = minSilenceMs
  let lastPushAt = 0

  const speechThresholdDb = computed(() => {
    const floor = noiseFloorDb.value
    return floor === null ? fallbackSilenceDb : floor + speechMarginDb
  })
  const noiseFloorReady = computed(() => noiseFloorDb.value !== null && frameCount.value >= 30)
  const noiseFloorHigh = computed(() => noiseFloorDb.value !== null && noiseFloorDb.value > -50)
  const signalDetected = computed(() => rmsDb.value !== null && Number.isFinite(rmsDb.value) && rmsDb.value > -50)
  const peakAtCeiling = computed(() => (peakDb.value ?? Number.NEGATIVE_INFINITY) >= -0.1)

  /** 噪声底：滑动窗口的 10 分位（docs/05 §4.1） */
  function recomputeNoiseFloor(): void {
    const limit = Math.max(1, Math.round(noiseWindowMs / frameMs))
    if (frameDbs.length > limit) frameDbs = frameDbs.slice(frameDbs.length - limit)
    if (frameDbs.length < 15) {
      // 样本太少时分位数没有意义（前 0.3 秒），此时回退到门限默认值
      noiseFloorDb.value = null
      return
    }
    const sorted = [...frameDbs].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * noisePercentile)))
    noiseFloorDb.value = sorted[index] ?? null
  }

  /** 静音/语音状态机（docs/05 §4.2 的简化版：只做提示，不生成切片） */
  function advanceStateMachine(db: number, advancedMs: number): void {
    const threshold = noiseFloorDb.value === null ? fallbackSilenceDb : noiseFloorDb.value + speechMarginDb
    if (silence.value) {
      if (db > threshold) {
        speechAccumMs += advancedMs
        silenceAccumMs = 0
        if (speechAccumMs >= minSpeechMs) {
          silence.value = false
          speechRunCount.value += 1
        }
      } else {
        speechAccumMs = 0
      }
      return
    }

    speechMs.value += advancedMs
    if (db <= threshold) {
      silenceAccumMs += advancedMs
      if (silenceAccumMs >= minSilenceMs) {
        silence.value = true
        speechAccumMs = 0
      }
    } else {
      silenceAccumMs = 0
    }
  }

  function pushFrameDb(db: number, sampleRate: number): void {
    sampleRateRef = sampleRate
    const value = Number.isFinite(db) ? db : -120
    frameDbs.push(value)
    frameCount.value += 1
    recomputeNoiseFloor()
    advanceStateMachine(value, frameMs)
  }

  /**
   * 喂入一个采集块（通常是 50 ms）。返回本块的瞬时读数。
   * 内部：算 RMS/峰值 → 削波事件计数 → 拆成 20 ms 帧驱动噪声底与静音判定。
   */
  function pushBlock(samples: Float32Array, sampleRate: number): LevelSample {
    const now = Date.now()
    const elapsed = lastPushAt ? Math.max(0, now - lastPushAt) : 0
    lastPushAt = now

    let sumSquares = 0
    let peak = 0
    let run = 0
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] ?? 0
      const abs = x < 0 ? -x : x
      sumSquares += x * x
      if (abs > peak) peak = abs
      // docs/05 §2.5：连续 ≥3 个样本 |x| ≥ 0.99 → 计数 +1
      if (abs >= clipAmplitude) {
        run += 1
        if (run === clipRunLength) {
          clipEvents.value += 1
          clipping.value = true
          run = 0
        }
      } else {
        run = 0
      }
    }

    const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0
    const nextRmsDb = amplitudeToDbfs(rms)
    const nextPeakDb = amplitudeToDbfs(peak)
    rmsDb.value = nextRmsDb
    peakDb.value = nextPeakDb

    // 峰值保持：衰减按真实经过时间算，块间隔抖动不会让读数乱跳
    const decay = peakDecayDbPerSec > 0 && elapsed > 0 ? (peakDecayDbPerSec * elapsed) / 1000 : 0
    const held = peakHoldDb.value === null ? nextPeakDb : peakHoldDb.value - decay
    peakHoldDb.value = Math.max(nextPeakDb, held)

    // 峰值贴顶（≥ -0.1 dBFS）块计数 —— docs/12 §12「峰值持续 0 dBFS > 10 次」
    if (nextPeakDb >= -0.1) overloadBlocks.value += 1

    totalFrames.value += samples.length
    sampleRateRef = sampleRate

    // 拆帧：先拼上上一块的零头，再按 frameMs 切
    const frameLength = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
    const merged = new Float32Array(carry.length + samples.length)
    merged.set(carry, 0)
    merged.set(samples, carry.length)
    let offset = 0
    while (merged.length - offset >= frameLength) {
      let frameSum = 0
      for (let i = offset; i < offset + frameLength; i++) {
        const x = merged[i] ?? 0
        frameSum += x * x
      }
      pushFrameDb(amplitudeToDbfs(Math.sqrt(frameSum / frameLength)), sampleRate)
      offset += frameLength
    }
    carry = merged.slice(offset)

    return { rmsDb: nextRmsDb, peakDb: nextPeakDb, clipping: clipping.value }
  }

  function clearClip(): void {
    clipping.value = false
    clipEvents.value = 0
    overloadBlocks.value = 0
  }

  function reset(sampleRate = sampleRateRef): void {
    rmsDb.value = null
    peakDb.value = null
    peakHoldDb.value = null
    clipping.value = false
    clipEvents.value = 0
    overloadBlocks.value = 0
    noiseFloorDb.value = null
    silence.value = true
    speechRunCount.value = 0
    frameCount.value = 0
    totalFrames.value = 0
    speechMs.value = 0
    carry = new Float32Array(0)
    frameDbs = []
    speechAccumMs = 0
    silenceAccumMs = minSilenceMs
    lastPushAt = 0
    sampleRateRef = sampleRate
  }

  return {
    rmsDb, peakDb, peakHoldDb, clipping, clipEvents, overloadBlocks,
    noiseFloorDb, silence, speechRunCount, frameCount, totalFrames, speechMs,
    noiseFloorReady, noiseFloorHigh, signalDetected, peakAtCeiling, speechThresholdDb,
    pushBlock, pushFrameDb, clearClip, reset,
  }
}
