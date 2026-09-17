/**
 * Novel Studio · PCM 采样域基础运算（零依赖）
 * ============================================================================
 * 设计依据：docs/05-音频管线.md
 *   · §2.2 采集格式 float32（Web Audio 原生）
 *   · §2.4 落盘 WAV 24-bit / 32-bit float，framesWritten 与 bytesPerFrame 换算
 *   · §2.5 削波检测（连续 >=3 个样本 |x| >= 0.99 计一次）
 *   · §12  关键参数速查表
 *
 * 本文件只做「采样数组 / 字节缓冲」之间的换算与度量，不碰文件系统、不碰 ffmpeg。
 *   · 所有 dB 一律为 dBFS（满幅正弦为 0 dBFS；正弦 RMS 为 -3.01 dBFS）
 *   · 静音（全零或空数组）的 RMS/峰值一律返回 -Infinity，绝不返回 0 或 NaN
 *
 * 失败语义：本文件的函数不抛业务异常，非法输入按「取空/取 0」处理；
 *          需要抛错的封装在 vad.ts / trim.ts 中（错误码见 JSDoc）。
 */

import { WAV_HEADER_BYTES } from '../constants.ts'
import type { AudioFormat } from '../types.ts'

/** 数字静音下限（dBFS）。用于把 -Infinity 收敛为可比较的值（估计噪声底用） */
export const SILENCE_FLOOR_DB = -100

/** 削波判定默认阈值（|x| >= 0.99），见 docs/05 §2.5 */
export const CLIP_THRESHOLD = 0.99

/** 判定一次削波所需的连续样本数，见 docs/05 §2.5 */
export const CLIP_CONSECUTIVE = 3

// ============================================================================
// 字节 / 帧 / 时长 换算
// ============================================================================

/**
 * 单个样本占用的字节数。
 * 32 位一律视为 float32（4 字节），见 docs/05 §2.5 与 types.ts 的 FLOAT32_BIT_DEPTH。
 */
export function bytesPerSample(bitDepth: 16 | 24 | 32): number {
  switch (bitDepth) {
    case 16:
      return 2
    case 24:
      return 3
    case 32:
      return 4
    default:
      // 运行期可能收到越界值（IPC 直调），这里保守返回 3（24-bit 落盘默认）
      return 3
  }
}

/** 单帧（所有声道各一个样本）占用的字节数 */
export function bytesPerFrame(format: AudioFormat): number {
  return bytesPerSample(format.bitDepth) * format.channels
}

/** 毫秒 → 帧数（四舍五入到最近的整帧） */
export function durationMsToFrames(ms: number, sampleRate: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.round((ms / 1000) * sampleRate)
}

/** 帧数 → 毫秒（四舍五入到整数毫秒） */
export function framesToDurationMs(frames: number, sampleRate: number): number {
  if (!Number.isFinite(frames) || frames <= 0 || sampleRate <= 0) return 0
  return Math.round((frames / sampleRate) * 1000)
}

/** 依据「已写帧数」推算数据段字节数（WAV 定稿头与崩溃恢复都用它） */
export function framesToDataBytes(frames: number, format: AudioFormat): number {
  return Math.max(0, Math.floor(frames)) * bytesPerFrame(format)
}

/**
 * 依据文件实际大小推算可用帧数（崩溃恢复用，见 docs/05 §3 步骤 2）。
 * 文件小于 44 字节时返回 0（只有头、没有素材）。
 */
export function fileSizeToFrames(fileSizeBytes: number, format: AudioFormat): number {
  const body = fileSizeBytes - WAV_HEADER_BYTES
  if (body <= 0) return 0
  return Math.floor(body / bytesPerFrame(format))
}

/** WAV 头长度沿用 constants.ts 的 WAV_HEADER_BYTES（44 字节，标准 RIFF/WAVE/fmt/data） */

// ============================================================================
// 量化：float32 <-> int16 / int24
// ============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 定点量化标度：正半轴用 2^n-1，负半轴用 2^n（对称满幅）。
 * 只用 2^n-1 会让 -1 只能到 -(2^n-1)，与解码端的 2^n 不一致，产生 1 LSB 偏差。
 */
function quantize(x: number, maxPos: number, maxNeg: number): number {
  const v = Number.isFinite(x) ? x : 0
  const scaled = v >= 0 ? Math.round(v * maxPos) : Math.round(v * maxNeg)
  return clamp(scaled, -maxNeg, maxPos)
}

/** float32 → 24-bit PCM（LE，3 字节/样本），有符号 */
export function float32ToInt24LE(src: Float32Array): Buffer {
  const out = Buffer.alloc(src.length * 3)
  for (let i = 0, o = 0; i < src.length; i++, o += 3) {
    const v = quantize(src[i] as number, 8388607, 8388608)
    out[o] = v & 0xff
    out[o + 1] = (v >> 8) & 0xff
    out[o + 2] = (v >> 16) & 0xff
  }
  return out
}

/** 24-bit PCM（LE）→ float32 */
export function int24LEToFloat32(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 3)
  const out = new Float32Array(n)
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const raw = (buf[o] as number) | ((buf[o + 1] as number) << 8) | ((buf[o + 2] as number) << 16)
    // 左移 8 位再算术右移 8 位 = 符号扩展
    const v = (raw << 8) >> 8
    out[i] = v / 8388608
  }
  return out
}

/** float32 → 16-bit PCM（LE，有符号） */
export function float32ToInt16LE(src: Float32Array): Buffer {
  const out = Buffer.alloc(src.length * 2)
  for (let i = 0; i < src.length; i++) {
    out.writeInt16LE(quantize(src[i] as number, 32767, 32768), i * 2)
  }
  return out
}

/** 16-bit PCM（LE）→ float32 */
export function int16LEToFloat32(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (buf.readInt16LE(i * 2) as number) / 32768
  return out
}

/** float32 → 32-bit float PCM（LE，给 bitDepth=32 的 WAV 写盘用） */
export function float32ToFloat32LE(src: Float32Array): Buffer {
  const out = Buffer.alloc(src.length * 4)
  for (let i = 0; i < src.length; i++) out.writeFloatLE(src[i] as number, i * 4)
  return out
}

// ============================================================================
// 声道交织 / 解交织
// ============================================================================

/**
 * 多声道 → 交织（frames 个帧，每帧依次写各声道）。
 * 各声道长度不一致时以最短者为准（防越界读）。
 */
export function interleaveChannels(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  const ch = channels.length
  let frames = channels[0]!.length
  for (const c of channels) frames = Math.min(frames, c.length)
  const out = new Float32Array(frames * ch)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) out[f * ch + c] = channels[c]![f] as number
  }
  return out
}

/** 交织 → 多声道（长度不是声道整数倍时，尾部残余样本丢弃） */
export function deinterleaveChannels(interleaved: Float32Array, channels: number): Float32Array[] {
  const ch = Math.max(1, Math.floor(channels))
  const frames = Math.floor(interleaved.length / ch)
  const out: Float32Array[] = []
  for (let c = 0; c < ch; c++) {
    const arr = new Float32Array(frames)
    for (let f = 0; f < frames; f++) arr[f] = interleaved[f * ch + c] as number
    out.push(arr)
  }
  return out
}

/** 交织样本降为单声道（等权平均），对应 docs/05 §6.1 的 `pan=mono|c0=0.5*c0+0.5*c1` */
export function mixdownToMono(interleaved: Float32Array, channels: number): Float32Array {
  const ch = Math.max(1, Math.floor(channels))
  if (ch === 1) return interleaved
  const frames = Math.floor(interleaved.length / ch)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < ch; c++) sum += interleaved[f * ch + c] as number
    out[f] = sum / ch
  }
  return out
}

// ============================================================================
// 电平度量
// ============================================================================

/**
 * 峰值（dBFS）。空数组或全零 → -Infinity（明确定义，勿改成 -100）。
 */
export function computePeakDb(samples: Float32Array): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] as number)
    if (a > peak) peak = a
  }
  if (peak <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(peak)
}

/**
 * RMS（dBFS）。空数组或全零 → -Infinity。
 */
export function computeRmsDb(samples: Float32Array): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] as number
    sum += x * x
  }
  const mean = sum / samples.length
  if (mean <= 0) return Number.NEGATIVE_INFINITY
  return 10 * Math.log10(mean)
}

/** 峰值绝对值（线性 0~1+），录完 take 判 flags 用 */
export function computePeakLinear(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] as number)
    if (a > peak) peak = a
  }
  return peak
}

/** 峰均比（crest factor，dB）。静音时为 0（无法定义） */
export function computeCrestFactorDb(samples: Float32Array): number {
  const peak = computePeakDb(samples)
  const rms = computeRmsDb(samples)
  if (!Number.isFinite(peak) || !Number.isFinite(rms)) return 0
  return peak - rms
}

/**
 * 削波检测（docs/05 §2.5）。
 * 连续 >= `consecutive`（默认 3）个样本 |x| >= `threshold`（默认 0.99）计一次；
 * 同一次连续过载只计一次，避免一个长过载段被重复计数。
 *
 * @returns 过载次数；> 20 时应给 take 打 flags:['clip']（见 VAD/录音侧）
 */
export function detectClipping(
  samples: Float32Array,
  opts: { threshold?: number; consecutive?: number } = {},
): number {
  const threshold = opts.threshold ?? CLIP_THRESHOLD
  const consecutive = Math.max(1, Math.floor(opts.consecutive ?? CLIP_CONSECUTIVE))
  let run = 0
  let count = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] as number
    if (Number.isFinite(x) && Math.abs(x) >= threshold) {
      run++
      if (run >= consecutive) {
        count++
        run = 0 // 本次过载已计入，重新开始计数
      }
    } else {
      run = 0
    }
  }
  return count
}

/** dBFS → 线性幅度（-1 → 0.891251...）。-Infinity → 0 */
export function dbToLinear(db: number): number {
  if (db === Number.NEGATIVE_INFINITY) return 0
  if (!Number.isFinite(db)) return db === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : 0
  return Math.pow(10, db / 20)
}

/** 线性幅度 → dBFS（0 或负值 → -Infinity） */
export function linearToDb(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(v)
}

// ============================================================================
// 其它小工具
// ============================================================================

/** 按绝对时间区间切片（越界自动裁剪） */
export function sliceSamples(samples: Float32Array, startMs: number, endMs: number, sampleRate: number): Float32Array {
  const from = clamp(durationMsToFrames(startMs, sampleRate), 0, samples.length)
  const to = clamp(durationMsToFrames(endMs, sampleRate), from, samples.length)
  return samples.subarray(from, to)
}

/** 逐样本数字增益（写盘前施加，见 docs/05 §2.5） */
export function applyGainDb(samples: Float32Array, gainDb: number): Float32Array {
  const g = dbToLinear(gainDb)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] as number) * g
  return out
}

/**
 * 兼容性断言：确认音频格式合法。
 * @throws 不抛业务异常，仅返回 false；调用方决定是否抛 INVALID_PAYLOAD
 */
export function isValidFormat(format: AudioFormat): boolean {
  return (
    Number.isFinite(format.sampleRate) &&
    format.sampleRate > 0 &&
    (format.bitDepth === 16 || format.bitDepth === 24 || format.bitDepth === 32) &&
    (format.channels === 1 || format.channels === 2)
  )
}
