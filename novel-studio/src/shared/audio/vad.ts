/**
 * Novel Studio · VAD 切片（连续录音 → K 个片段）
 * ============================================================================
 * 设计依据：docs/05-音频管线.md §4
 *   · §4.1 帧级分析：20 ms 帧，RMS/峰值/ZCR；噪声底 = 滑动 3 s 窗口的 **10 分位**
 *   · §4.2 状态机：连续 >= minSpeechMs 超阈才算进入 speech；连续 >= minSilenceMs 低于阈才切分
 *   · §4.3 边界精修：起点回退 headRollbackMs、尾部保留 tailKeepMs、过短丢弃、
 *          过长标记 too_long、间隔 < VAD_BRIDGE_GAP_MS 合并
 *
 * 为什么噪声底用 10 分位而不是均值：均值会被语音污染（一段 30 秒录音里只要有 10 秒在说话，
 * 均值就被抬高十几 dB），进而把门限抬高，导致「小声的字被吃掉」。
 *
 * 失败语义：`detectSlices()` 在没有任何可用切片时抛 `VAD_NO_SPEECH_FOUND`
 *           （原始会话必须保留，用户可调参数重切）。
 */

import { VAD_BRIDGE_GAP_MS, VAD_DISCARD_MARGIN_DB, VAD_SPEECH_MARGIN_DB } from '../constants.ts'
import { AppError } from '../errors.ts'
import type { VadOptions } from '../types.ts'
import { SILENCE_FLOOR_DB } from './pcm.ts'

/** VAD 帧长（毫秒），见 docs/05 §4.1、§12 */
export const VAD_FRAME_MS = 20

/** 噪声底估计的滑动窗口长度（毫秒），见 docs/05 §4.1 */
export const VAD_NOISE_WINDOW_MS = 3000

export interface VadFrame {
  /** 帧 RMS（dBFS）；数字静音为 -Infinity */
  rmsDb: number
  /** 帧峰值（dBFS）；数字静音为 -Infinity */
  peakDb: number
  /** 过零率 0~1（区分摩擦音与浊音，1.0 只做记录） */
  zcr: number
}

export interface VadSliceRange {
  startMs: number
  endMs: number
  rmsDb: number
  peakDb: number
  /** 'too_long' = 超过 maxSliceMs，进人工确认（可能是漏检静音） */
  flags: string[]
}

/** findSlices / detectSpeech 需要的附加上下文（都是可选，缺省时用 VAD 默认值） */
export type VadOptionsExt = VadOptions & {
  /** 帧长（毫秒），默认 20 */
  frameMs?: number
  /** 已算好的噪声底（避免重复计算） */
  noiseFloorDb?: number
  /** 精确总时长（毫秒）；缺省按 frames.length * frameMs 估算 */
  totalMs?: number
}

// ============================================================================
// §4.1 帧级分析
// ============================================================================

/**
 * 逐帧计算 RMS / 峰值 / 过零率（非重叠帧）。
 * 尾部不足一帧的残余样本**也**作为一帧参与（否则最后 10 ms 的语音会丢）。
 *
 * @throws 不抛异常；空输入返回 []
 */
export function frameEnergy(
  samples: Float32Array,
  opts: { frameMs: number; sampleRate: number },
): VadFrame[] {
  const frameMs = opts.frameMs > 0 ? opts.frameMs : VAD_FRAME_MS
  // 采样率非法时按工程默认 48 kHz 处理（见 docs/05 §12）
  const sampleRate = opts.sampleRate > 0 ? opts.sampleRate : 48000
  const frameSize = Math.max(1, Math.round((frameMs / 1000) * sampleRate))
  const out: VadFrame[] = []
  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(start + frameSize, samples.length)
    const n = end - start
    let sum = 0
    let peak = 0
    let crossings = 0
    let prev = samples[start] as number
    for (let i = start; i < end; i++) {
      const x = samples[i] as number
      sum += x * x
      const a = Math.abs(x)
      if (a > peak) peak = a
      if (i > start && ((x >= 0 && prev < 0) || (x < 0 && prev >= 0))) crossings++
      prev = x
    }
    const mean = n > 0 ? sum / n : 0
    out.push({
      rmsDb: mean > 0 ? 10 * Math.log10(mean) : Number.NEGATIVE_INFINITY,
      peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
      zcr: n > 1 ? crossings / (n - 1) : 0,
    })
  }
  return out
}

/** 分位（线性插值），values 必须已升序 */
function percentileSorted(values: number[], p: number): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY
  if (values.length === 1) return values[0] as number
  const idx = (values.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return values[lo] as number
  const frac = idx - lo
  return (values[lo] as number) * (1 - frac) + (values[hi] as number) * frac
}

/**
 * 噪声底估计（docs/05 §4.1）：滑动 `windowFrames` 窗口，取各窗口 10 分位的**最小值**。
 *
 * 两步都为了抗语音污染：
 *   1. 窗口内用 10 分位（而不是均值）→ 窗口里混进少量语音也不会抬高结果；
 *   2. 跨窗口取最小值 → 只要存在一个「纯噪声窗口」（说话间隙一定存在），结果就是真噪声底。
 *
 * 数字静音（-Infinity）先收敛到 SILENCE_FLOOR_DB(-100)，避免出现 -Infinity 门限。
 *
 * @throws 不抛异常；无帧时返回 SILENCE_FLOOR_DB
 */
export function estimateNoiseFloorDb(
  frames: VadFrame[],
  opts: { windowFrames: number },
): number {
  if (frames.length === 0) return SILENCE_FLOOR_DB
  const windowFrames = Math.max(1, Math.floor(opts.windowFrames))
  const values = frames.map(f =>
    Number.isFinite(f.rmsDb) ? Math.max(f.rmsDb, SILENCE_FLOOR_DB) : SILENCE_FLOOR_DB,
  )

  if (values.length <= windowFrames) {
    return percentileSorted([...values].sort((a, b) => a - b), 0.1)
  }

  const step = Math.max(1, Math.floor(windowFrames / 2))
  let best = Number.POSITIVE_INFINITY
  for (let start = 0; start + windowFrames <= values.length; start += step) {
    const win = values.slice(start, start + windowFrames).sort((a, b) => a - b)
    const q = percentileSorted(win, 0.1)
    if (q < best) best = q
  }
  return Number.isFinite(best) ? best : SILENCE_FLOOR_DB
}

/** 按帧长把「毫秒」换算成「帧数」（至少 1 帧） */
function msToFrames(ms: number, frameMs: number): number {
  return Math.max(1, Math.round(ms / frameMs))
}

/**
 * 帧级语音判定（docs/05 §4.2 的状态机）。
 *
 * 门限 = autoNoiseFloor ? 噪声底 + marginDb : silenceDb
 * 状态机落在帧序列上的等价实现：
 *   · 连续超阈不足 minSpeechMs 的孤立段 → 判为噪声（咳嗽、翻页）
 *   · 两个语音段之间不足 minSilenceMs 的静音 → 仍判为语音（句内停顿）
 *
 * @throws 不抛异常
 */
export function detectSpeech(frames: VadFrame[], opts: VadOptionsExt & { marginDb: number }): boolean[] {
  const frameMs = opts.frameMs && opts.frameMs > 0 ? opts.frameMs : VAD_FRAME_MS
  const n = frames.length
  if (n === 0) return []

  let threshold: number
  if (opts.autoNoiseFloor) {
    const noiseFloor =
      opts.noiseFloorDb ??
      estimateNoiseFloorDb(frames, { windowFrames: msToFrames(VAD_NOISE_WINDOW_MS, frameMs) })
    threshold = noiseFloor + opts.marginDb
  } else {
    threshold = opts.silenceDb
  }

  const minSpeechFrames = msToFrames(opts.minSpeechMs, frameMs)
  const minSilenceFrames = msToFrames(opts.minSilenceMs, frameMs)

  // 1) 原始超阈标记
  const above = frames.map(f => Number.isFinite(f.rmsDb) && f.rmsDb > threshold)

  // 2) 丢掉过短的语音段
  const speech = new Array<boolean>(n).fill(false)
  let i = 0
  while (i < n) {
    if (!above[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && above[j]) j++
    if (j - i >= minSpeechFrames) for (let k = i; k < j; k++) speech[k] = true
    i = j
  }

  // 3) 合并「内部停顿」：两段语音之间不足 minSilenceMs 的静音回归语音
  let k = 0
  while (k < n) {
    if (speech[k]) {
      k++
      continue
    }
    let m = k
    while (m < n && !speech[m]) m++
    const leftSpeech = k > 0 && speech[k - 1]
    const rightSpeech = m < n && speech[m]
    if (leftSpeech && rightSpeech && m - k < minSilenceFrames) {
      for (let t = k; t < m; t++) speech[t] = true
    }
    k = m
  }
  return speech
}

/** 帧区段（内部工具） */
interface FrameRun {
  startFrame: number
  endFrame: number // 闭区间
}

function groupRuns(flags: boolean[]): FrameRun[] {
  const runs: FrameRun[] = []
  let i = 0
  while (i < flags.length) {
    if (!flags[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < flags.length && flags[j + 1]) j++
    runs.push({ startFrame: i, endFrame: j })
    i = j + 1
  }
  return runs
}

/** 用线性功率平均把若干帧的 RMS 合成一个 RMS（不能直接对 dB 取平均） */
function combineRmsDb(frames: VadFrame[], from: number, to: number): number {
  if (to < from) return Number.NEGATIVE_INFINITY
  let power = 0
  let count = 0
  for (let i = from; i <= to; i++) {
    const r = frames[i]?.rmsDb ?? Number.NEGATIVE_INFINITY
    if (Number.isFinite(r)) power += Math.pow(10, r / 10)
    count++
  }
  if (count === 0 || power <= 0) return Number.NEGATIVE_INFINITY
  return 10 * Math.log10(power / count)
}

function combinePeakDb(frames: VadFrame[], from: number, to: number): number {
  let peak = Number.NEGATIVE_INFINITY
  for (let i = from; i <= to; i++) {
    const p = frames[i]?.peakDb ?? Number.NEGATIVE_INFINITY
    if (p > peak) peak = p
  }
  return peak
}

/**
 * 由帧与语音标记生成切片（docs/05 §4.3 边界精修）。
 *
 * 处理顺序（顺序本身是有讲究的）：
 *   1. 连续 speech 帧 → 原始段
 *   2. 间隔 < VAD_BRIDGE_GAP_MS(250) 的两段合并（句内停顿被误切）
 *   3. 起点回退 headRollbackMs(80)、尾部保留 tailKeepMs(200)，并裁剪到 [0, totalMs] 且互不重叠
 *   4. 过短丢弃：时长 < minSliceMs(180) 或 RMS < 噪声底 + VAD_DISCARD_MARGIN_DB(6)
 *   5. 过长标记：时长 > maxSliceMs(15 s) → flags=['too_long']（不丢弃，进人工确认）
 *
 * @throws 不抛异常；全静音/无帧返回 []（调用方 → `VAD_NO_SPEECH_FOUND`）
 */
export function findSlices(frames: VadFrame[], speech: boolean[], opts: VadOptionsExt): Array<VadSliceRange> {
  const frameMs = opts.frameMs && opts.frameMs > 0 ? opts.frameMs : VAD_FRAME_MS
  if (frames.length === 0) return []
  const totalMs = opts.totalMs ?? frames.length * frameMs

  // 1) 原始段 + 2) 桥接
  const raw = groupRuns(speech)
  const bridged: FrameRun[] = []
  for (const run of raw) {
    const prev = bridged[bridged.length - 1]
    if (prev) {
      const gapMs = (run.startFrame - (prev.endFrame + 1)) * frameMs
      if (gapMs < VAD_BRIDGE_GAP_MS) {
        prev.endFrame = run.endFrame
        continue
      }
    }
    bridged.push({ ...run })
  }

  // 3) 边界精修（含互不重叠裁剪）
  const out: VadSliceRange[] = []
  let prevEndMs = 0
  for (const run of bridged) {
    const coreStartMs = run.startFrame * frameMs
    const coreEndMs = Math.min((run.endFrame + 1) * frameMs, totalMs)
    let startMs = Math.max(0, coreStartMs - opts.headRollbackMs, prevEndMs)
    let endMs = Math.min(totalMs, coreEndMs + opts.tailKeepMs)
    if (endMs <= startMs) {
      // 精修后已无空间：与前一片合并（不丢音频）
      const last = out[out.length - 1]
      if (last) last.endMs = Math.max(last.endMs, endMs)
      continue
    }
    const rmsDb = combineRmsDb(frames, run.startFrame, run.endFrame)
    const peakDb = combinePeakDb(frames, run.startFrame, run.endFrame)
    // 过短/过长判定一律基于「检测到的语音**核心区**」：
    // padding（回退 80 ms + 尾保留 200 ms）是为了听感，不该把 100 ms 的咳嗽变成 380 ms 的「合格切片」。
    const coreDurationMs = coreEndMs - coreStartMs

    // 4) 过短 / 过静 → 丢弃（咳嗽、椅子声）
    if (coreDurationMs < opts.minSliceMs) continue
    if (
      Number.isFinite(opts.noiseFloorDb as number) &&
      Number.isFinite(rmsDb) &&
      rmsDb < (opts.noiseFloorDb as number) + VAD_DISCARD_MARGIN_DB
    ) {
      continue
    }

    // 5) 过长 → 标记（不丢，交人工确认）
    const flags: string[] = []
    if (coreDurationMs > opts.maxSliceMs) flags.push('too_long')

    out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), rmsDb, peakDb, flags })
    prevEndMs = endMs
  }
  return out
}

/** 切片统计（调用方写 vad_slices 表时用） */
export function summarizeSlices(slices: VadSliceRange[]): {
  count: number
  totalMs: number
  tooLong: number
  avgRmsDb: number
} {
  if (slices.length === 0) return { count: 0, totalMs: 0, tooLong: 0, avgRmsDb: Number.NEGATIVE_INFINITY }
  let totalMs = 0
  let tooLong = 0
  let power = 0
  let voiced = 0
  for (const s of slices) {
    totalMs += s.endMs - s.startMs
    if (s.flags.includes('too_long')) tooLong++
    if (Number.isFinite(s.rmsDb)) {
      power += Math.pow(10, s.rmsDb / 10)
      voiced++
    }
  }
  return {
    count: slices.length,
    totalMs,
    tooLong,
    avgRmsDb: voiced > 0 ? 10 * Math.log10(power / voiced) : Number.NEGATIVE_INFINITY,
  }
}

/**
 * 端到端切片：帧分析 → 噪声底 → 语音判定 → 边界精修。
 *
 * ⚠ 已知边界（设计使然，不是 bug）：若整段录音**完全没有静音窗口**（例如 1 秒纯正弦、
 *   或一口气不停的朗读），10 分位会等于语音电平本身，噪声底被高估 → 门限被抬高 → 切不出切片。
 *   此时抛出 `VAD_NO_SPEECH_FOUND`，UI 按「可调参重切」引导用户改用固定门限
 *   （把 `autoNoiseFloor` 设为 false，用 `silenceDb`）—— 这比「把噪声当语音切出一堆垃圾」
 *   更安全（宁可让用户调参，也不要产出坏数据）。
 *
 * @throws `VAD_NO_SPEECH_FOUND` —— 整段录音都低于门限（全静音、增益过低、设备静音）。
 *         原始会话必须保留，允许用户调参重切。
 */
export function detectSlices(
  samples: Float32Array,
  opts: VadOptions & { sampleRate: number; frameMs?: number; marginDb?: number },
): Array<VadSliceRange> {
  const frameMs = opts.frameMs && opts.frameMs > 0 ? opts.frameMs : VAD_FRAME_MS
  const frames = frameEnergy(samples, { frameMs, sampleRate: opts.sampleRate })
  if (frames.length === 0) {
    throw new AppError('VAD_NO_SPEECH_FOUND', { details: { frames: 0, samples: samples.length } })
  }
  const noiseFloorDb = estimateNoiseFloorDb(frames, {
    windowFrames: msToFrames(VAD_NOISE_WINDOW_MS, frameMs),
  })
  const marginDb = opts.marginDb ?? VAD_SPEECH_MARGIN_DB
  const speech = detectSpeech(frames, { ...opts, frameMs, noiseFloorDb, marginDb })
  const slices = findSlices(frames, speech, { ...opts, frameMs, noiseFloorDb })
  if (slices.length === 0) {
    throw new AppError('VAD_NO_SPEECH_FOUND', {
      details: { frames: frames.length, noiseFloorDb, thresholdDb: noiseFloorDb + marginDb },
    })
  }
  return slices
}
