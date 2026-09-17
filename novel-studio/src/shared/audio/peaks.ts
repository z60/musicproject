/**
 * Novel Studio · 波形峰值缓存（多级 LOD）
 * ============================================================================
 * 设计依据：
 *   · docs/04-基础设施与队列.md §4 —— 峰值缓存文件格式
 *   · docs/05-音频管线.md §11.3 —— 3 级 LOD（100/10/1 peaks/s）
 *
 * 文件头（32 字节）：
 *   magic='NSPK' | version u16 | reserved u16 | peakPerSec u32 | sampleCount u64 | channels u16 | reserved(10B)
 * 数据体：每 (1/peakPerSec) 秒，每声道 2 个 int16（min, max）
 *
 * 为什么用 int16 而不是 float：15 分钟音频 ≈ 90000 对；int16 一对 4 字节 ≈ 350 KB，
 * 一次读取即可绘制，float32 会让缓存与内存翻倍而画面上看不出差别。
 *
 * 失败语义：本文件所有函数都不抛业务异常；反序列化失败返回 null，
 *          调用方按「缓存失效」处理（重新计算，不报错）。
 */

import { AUDIO_DEFAULTS } from '../constants.ts'

/** 缓存文件 magic */
export const PEAKS_MAGIC = 'NSPK'
/** 缓存文件版本（格式变更必须 +1，旧版本缓存直接判失效） */
export const PEAKS_VERSION = 1
/** 文件头长度 */
export const PEAKS_HEADER_BYTES = 32

/** 支持的 LOD 级别（peaks/s），见 docs/05 §11.3 */
export const PEAKS_LOD_LEVELS = [100, 10, 1] as const

/** 默认峰值密度：100 peaks/s（每 10 ms 一对），见 docs/04 §4 */
export const DEFAULT_PEAKS_PER_SEC = 100

export interface PeaksMeta {
  peaksPerSec: number
  /** 源文件的样本总数（每声道） */
  sampleCount: number
  channels: number
}

export interface SerializedPeaks extends PeaksMeta {
  peaks: Int16Array
}

// ============================================================================
// 计算
// ============================================================================

function clampInt16(v: number): number {
  const r = Math.round(v)
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r
}

/**
 * 计算 min/max 峰值对（int16 量化）。
 *
 * @param opts.peaksPerSec 每秒峰值对数（100 / 10 / 1，见 docs/05 §11.3）
 * @returns Int16Array，长度 = 2 * 桶数，顺序为 [min0, max0, min1, max1, ...]
 *
 * @throws 不抛异常；空输入返回空数组
 */
export function computePeaks(
  samples: Float32Array,
  opts: { peaksPerSec: number; sampleRate: number },
): Int16Array {
  const peaksPerSec = opts.peaksPerSec > 0 ? opts.peaksPerSec : DEFAULT_PEAKS_PER_SEC
  const sampleRate = opts.sampleRate > 0 ? opts.sampleRate : AUDIO_DEFAULTS.sampleRate
  if (samples.length === 0) return new Int16Array(0)
  const bucket = Math.max(1, Math.round(sampleRate / peaksPerSec))
  const buckets = Math.ceil(samples.length / bucket)
  const out = new Int16Array(buckets * 2)
  for (let b = 0; b < buckets; b++) {
    const start = b * bucket
    const end = Math.min(start + bucket, samples.length)
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let i = start; i < end; i++) {
      const x = samples[i] as number
      const v = Number.isFinite(x) ? x : 0
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0
      max = 0
    }
    out[b * 2] = clampInt16(min * 32767)
    out[b * 2 + 1] = clampInt16(max * 32767)
  }
  return out
}

// ============================================================================
// 序列化
// ============================================================================

/**
 * 序列化为缓存文件内容（32 字节头 + int16 数据体）。
 *
 * @throws 不抛异常；peaks 长度为奇数时丢弃最后半个样本
 */
export function serializePeaks(input: SerializedPeaks): Buffer {
  const pairs = Math.floor(input.peaks.length / 2)
  const buf = Buffer.alloc(PEAKS_HEADER_BYTES + pairs * 4)
  buf.write(PEAKS_MAGIC, 0, 'ascii')
  buf.writeUInt16LE(PEAKS_VERSION, 4)
  buf.writeUInt16LE(0, 6) // reserved
  buf.writeUInt32LE(Math.max(1, Math.floor(input.peaksPerSec)), 8)
  // sampleCount 是 u64：JS 侧只用到 2^53，写高 32 位为 0 即可
  const sampleCount = Math.max(0, Math.floor(input.sampleCount))
  buf.writeUInt32LE(sampleCount >>> 0, 12)
  buf.writeUInt32LE(Math.floor(sampleCount / 0x1_0000_0000) >>> 0, 16)
  buf.writeUInt16LE(input.channels === 2 ? 2 : 1, 20)
  // 22..31 reserved（保持 32 字节头对齐）
  for (let i = 0; i < pairs; i++) {
    buf.writeInt16LE(input.peaks[i * 2] as number, PEAKS_HEADER_BYTES + i * 4)
    buf.writeInt16LE(input.peaks[i * 2 + 1] as number, PEAKS_HEADER_BYTES + i * 4 + 2)
  }
  return buf
}

/**
 * 反序列化峰值缓存。
 *
 * @returns null = 缓存无效（magic/版本/长度不符），调用方重新计算即可，**不要报错**
 * @throws 不抛异常
 */
export function deserializePeaks(buf: Buffer): SerializedPeaks | null {
  if (!buf || buf.length < PEAKS_HEADER_BYTES) return null
  if (buf.toString('ascii', 0, 4) !== PEAKS_MAGIC) return null
  const version = buf.readUInt16LE(4)
  if (version !== PEAKS_VERSION) return null
  const peaksPerSec = buf.readUInt32LE(8)
  if (peaksPerSec === 0) return null
  const sampleCount = buf.readUInt32LE(12) + buf.readUInt32LE(16) * 0x1_0000_0000
  const channels = buf.readUInt16LE(20) === 2 ? 2 : 1
  const body = buf.length - PEAKS_HEADER_BYTES
  const pairs = Math.floor(body / 4)
  if (pairs === 0) return null
  const peaks = new Int16Array(pairs * 2)
  for (let i = 0; i < pairs; i++) {
    peaks[i * 2] = buf.readInt16LE(PEAKS_HEADER_BYTES + i * 4)
    peaks[i * 2 + 1] = buf.readInt16LE(PEAKS_HEADER_BYTES + i * 4 + 2)
  }
  return { peaks, peaksPerSec, sampleCount, channels }
}

// ============================================================================
// 降采样（LOD）
// ============================================================================

/**
 * 降采样峰值（100 peaks/s → 10 → 1）。
 *
 * 规则：每 `from/to` 对合并成一对，min 取最小、max 取最大（绝不丢瞬时峰值）。
 * 非整数倍率时按浮点边界分组（末组可能不满）。
 *
 * @throws 不抛异常；`to >= from` 时原样返回副本
 */
export function downsamplePeaks(peaks: Int16Array, from: number, to: number): Int16Array {
  const srcPairs = Math.floor(peaks.length / 2)
  if (srcPairs === 0) return new Int16Array(0)
  if (!(from > 0) || !(to > 0) || to >= from) return new Int16Array(peaks)
  const ratio = from / to
  const outPairs = Math.max(1, Math.round(srcPairs / ratio))
  const out = new Int16Array(outPairs * 2)
  for (let i = 0; i < outPairs; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(srcPairs, Math.max(start + 1, Math.floor((i + 1) * ratio)))
    let min = 32767
    let max = -32768
    for (let p = start; p < end; p++) {
      const lo = peaks[p * 2] as number
      const hi = peaks[p * 2 + 1] as number
      if (lo < min) min = lo
      if (hi > max) max = hi
    }
    out[i * 2] = start < srcPairs ? min : 0
    out[i * 2 + 1] = start < srcPairs ? max : 0
  }
  return out
}

/** 便捷：按目标 LOD 逐级降采样（100 → 10 → 1），避免越级精度损失 */
export function downsampleToLevel(
  peaks: Int16Array,
  fromPeaksPerSec: number,
  targetPeaksPerSec: number,
): Int16Array {
  const levels = [...PEAKS_LOD_LEVELS].sort((a, b) => b - a)
  // 显式标注 Int16Array<ArrayBufferLike>：TS 5.7+ 起 TypedArray 带 buffer 泛型参数，
  // 而 `downsamplePeaks` 的返回值是宽松的 Int16Array<ArrayBufferLike>，不标注会报 TS2322
  let cur: Int16Array<ArrayBufferLike> = new Int16Array(peaks)
  let curRate = fromPeaksPerSec
  for (const level of levels) {
    if (level >= curRate || level < targetPeaksPerSec) continue
    cur = downsamplePeaks(cur, curRate, level)
    curRate = level
    if (curRate === targetPeaksPerSec) break
  }
  if (curRate !== targetPeaksPerSec) cur = downsamplePeaks(cur, curRate, targetPeaksPerSec)
  return cur
}

/** 峰值对的统计信息（UI 画骨架线用） */
export function peaksStats(peaks: Int16Array): { pairs: number; min: number; max: number; peakDb: number } {
  const pairs = Math.floor(peaks.length / 2)
  if (pairs === 0) return { pairs: 0, min: 0, max: 0, peakDb: Number.NEGATIVE_INFINITY }
  let min = 32767
  let max = -32768
  for (let i = 0; i < pairs; i++) {
    const lo = peaks[i * 2] as number
    const hi = peaks[i * 2 + 1] as number
    if (lo < min) min = lo
    if (hi > max) max = hi
  }
  const linear = Math.max(Math.abs(min), Math.abs(max)) / 32767
  return { pairs, min, max, peakDb: linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY }
}
