/**
 * Novel Studio · WAV（RIFF）头读写与崩溃恢复
 * ============================================================================
 * 设计依据：docs/05-音频管线.md
 *   · §2.4 预置头 + 追加写 + 定期 sync + 伴生元数据
 *   · §3   崩溃恢复：meta.framesWritten 优先，缺失时按 fileSize 反推，并取 min
 *
 * 三条铁律（对应三处「已经踩过的坑」）
 *   1. 中途文件头是错的（长度 0），但**数据是完整的** —— 恢复时永远以文件实际大小为准取 min，
 *      否则会出现「头大身子小」的文件，播放器读到 EOF 就崩。
 *   2. 文件小于 44 字节 → 只有头没有素材，必须明确放弃恢复（调用方抛
 *      RECORD_SESSION_UNRECOVERABLE），绝不静默产出一个 0 秒文件。
 *   3. bitDepth=32 表示 float32（fmt 块 formatTag=3），不是 32 位整型 PCM。
 */

import { WAV_HEADER_BYTES } from '../constants.ts'
import type { AudioFormat } from '../types.ts'
import { bytesPerFrame, fileSizeToFrames, int16LEToFloat32 } from './pcm.ts'

/** RIFF 格式标签：1 = 整型 PCM，3 = IEEE float */
export const WAV_FORMAT_TAG = { PCM: 1, FLOAT: 3 } as const

// 便于调用方从一处拿到头长度（值来自 constants.ts，不重复定义）
export { WAV_HEADER_BYTES }

/** 默认格式（meta 缺失时的兜底）：48 kHz / 24-bit / 单声道，见 docs/05 §12 */
export const WAV_FALLBACK_FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 24, channels: 1 }

export interface WavHeaderParseResult {
  format: AudioFormat
  /** 数据段可用字节数（已按文件实际大小裁剪） */
  dataBytes: number
  /** data 块载荷起始偏移 */
  dataOffset: number
  valid: boolean
  reason?: string
}

// ============================================================================
// 写头
// ============================================================================

/**
 * 生成 44 字节标准 RIFF/WAVE/fmt/data 头。
 *
 * @param opts.dataBytes 数据段字节数（定稿时 = framesWritten * bytesPerFrame；占位写 0）
 * @returns 44 字节 Buffer，直接 pwrite 到文件偏移 0
 */
export function writeWavHeader(opts: { dataBytes: number; format: AudioFormat }): Buffer {
  const { format } = opts
  const dataBytes = Math.max(0, Math.floor(opts.dataBytes) || 0)
  const bps = bytesPerSampleOf(format)
  const blockAlign = bytesPerFrame(format)
  const byteRate = format.sampleRate * blockAlign
  const tag = format.bitDepth === 32 ? WAV_FORMAT_TAG.FLOAT : WAV_FORMAT_TAG.PCM

  const buf = Buffer.alloc(WAV_HEADER_BYTES)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4) // 文件总长 - 8
  buf.write('WAVE', 8, 'ascii')

  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt 块长度（PCM 固定 16）
  buf.writeUInt16LE(tag, 20)
  buf.writeUInt16LE(format.channels, 22)
  buf.writeUInt32LE(format.sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bps * 8, 34)

  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

function bytesPerSampleOf(format: AudioFormat): number {
  return format.bitDepth === 16 ? 2 : format.bitDepth === 32 ? 4 : 3
}

// ============================================================================
// 读头
// ============================================================================

/**
 * 解析 WAV 头（按块扫描，容忍 fmt/data 之前存在 LIST 等附加块）。
 *
 * 必须处理的四种异常（对应单测）：
 *   · 缓冲区小于 44 字节        → valid=false, reason='文件小于 44 字节'
 *   · 缺少 RIFF/WAVE 标识       → valid=false, reason=...
 *   · data 声明长度超过实际大小 → valid=false, dataBytes 已裁剪为实际可用值
 *   · bitDepth=32（formatTag=3）→ format.bitDepth=32 表示 float32
 *
 * @throws 不抛异常（解析器必须能在损坏文件上返回结果，由调用方决定抛
 *         RECORD_SESSION_UNRECOVERABLE）
 */
export function parseWavHeader(buf: Buffer): WavHeaderParseResult {
  const fallbackFormat: AudioFormat = { ...WAV_FALLBACK_FORMAT }
  if (!buf || buf.length < WAV_HEADER_BYTES) {
    return {
      format: fallbackFormat,
      dataBytes: 0,
      dataOffset: WAV_HEADER_BYTES,
      valid: false,
      reason: `文件小于 ${WAV_HEADER_BYTES} 字节，只有头没有素材`,
    }
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return {
      format: fallbackFormat,
      dataBytes: 0,
      dataOffset: WAV_HEADER_BYTES,
      valid: false,
      reason: '缺少 RIFF/WAVE 标识，疑似介质损坏或非 WAV 文件',
    }
  }

  let format: AudioFormat = { ...WAV_FALLBACK_FORMAT }
  let haveFmt = false
  let dataOffset = -1
  let declaredDataBytes = -1

  // 从偏移 12 起按块扫描（每块 8 字节头 + 载荷，奇数长度需补齐 1 字节）
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) {
        return {
          format: fallbackFormat,
          dataBytes: 0,
          dataOffset: body,
          valid: false,
          reason: 'fmt 块长度非法或超出文件范围',
        }
      }
      const tag = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      const sampleRate = buf.readUInt32LE(body + 4)
      const bits = buf.readUInt16LE(body + 14)
      const bitDepth = bits === 16 ? 16 : bits === 32 ? 32 : bits === 24 ? 24 : 0
      if (!bitDepth) {
        return {
          format: fallbackFormat,
          dataBytes: 0,
          dataOffset: body,
          valid: false,
          reason: `不支持的位深 ${bits}（只支持 16 / 24 / 32(float)）`,
        }
      }
      if (tag !== WAV_FORMAT_TAG.PCM && tag !== WAV_FORMAT_TAG.FLOAT) {
        return {
          format: fallbackFormat,
          dataBytes: 0,
          dataOffset: body,
          valid: false,
          reason: `不支持的 WAV 格式标签 ${tag}（1=PCM, 3=float）`,
        }
      }
      format = {
        sampleRate: sampleRate > 0 ? sampleRate : WAV_FALLBACK_FORMAT.sampleRate,
        bitDepth: bitDepth as 16 | 24 | 32,
        channels: channels === 2 ? 2 : 1,
      }
      haveFmt = true
    } else if (id === 'data') {
      dataOffset = body
      declaredDataBytes = size
      break // data 之后的内容与播放无关
    }
    // 奇数长度块需补齐到偶数边界
    off = body + size + (size % 2)
  }

  if (!haveFmt) {
    return {
      format: fallbackFormat,
      dataBytes: 0,
      dataOffset: dataOffset >= 0 ? dataOffset : WAV_HEADER_BYTES,
      valid: false,
      reason: '缺少 fmt 块',
    }
  }
  if (dataOffset < 0) {
    return { format, dataBytes: 0, dataOffset: WAV_HEADER_BYTES, valid: false, reason: '缺少 data 块' }
  }

  const available = Math.max(0, buf.length - dataOffset)
  if (declaredDataBytes > available) {
    // 头大身子小：这是「写到一半被杀 / 头是占位头」的典型形态，必须按实际大小裁剪
    return {
      format,
      dataBytes: available,
      dataOffset,
      valid: false,
      reason: `data 块声明 ${declaredDataBytes} 字节，实际只有 ${available} 字节（按实际大小裁剪）`,
    }
  }
  return { format, dataBytes: declaredDataBytes, dataOffset, valid: true }
}

// ============================================================================
// 崩溃恢复（docs/05 §3）
// ============================================================================

export interface RepairWavHeaderInput {
  /** 文件实际字节数（由 fs.stat 得到，不用头里的字段） */
  fileSizeBytes: number
  /** 伴生 {sessionId}.meta.json 的内容；缺失时为 null */
  meta: { format: AudioFormat; framesWritten: number } | null
  /** meta 缺失时的兜底格式（默认 48k/24bit/mono） */
  fallbackFormat?: AudioFormat
}

export interface RepairWavHeaderResult {
  /** 可直接 pwrite 到副本偏移 0 的 44 字节头 */
  header: Buffer
  /** 恢复出的帧数（已按文件实际大小取 min） */
  frames: number
  /** 是否用了兜底逻辑（meta 缺失 / 文件小于 44 字节） */
  usedFallback: boolean
  /** 恢复出的格式（meta 缺失时为 fallbackFormat，调用方应在 UI 提示） */
  format: AudioFormat
  /** 不可恢复时为 false —— 调用方抛 RECORD_SESSION_UNRECOVERABLE，且**不要删原始文件** */
  recoverable: boolean
  reason?: string
}

/**
 * 崩溃恢复的头修复（docs/05 §3 的算法落地）。
 *
 * 步骤：
 *   1. meta 存在 → frames = meta.framesWritten；缺失 → frames = floor((fileSize-44)/bytesPerFrame)
 *   2. frames = min(frames, floor((fileSize-44)/bytesPerFrame))   ← 以文件为准，避免头大身子小
 *   3. 用 frames 生成正确的 44 字节头
 *
 * @throws 不抛异常；recoverable=false 时由调用方抛 RECORD_SESSION_UNRECOVERABLE
 *         （文件 < 44 字节 → 只有头没有素材）
 */
export function repairWavHeader(input: RepairWavHeaderInput): RepairWavHeaderResult {
  const fileSizeBytes = Math.max(0, Math.floor(input.fileSizeBytes) || 0)
  const format: AudioFormat = input.meta?.format ?? { ...(input.fallbackFormat ?? WAV_FALLBACK_FORMAT) }
  const available = fileSizeToFrames(fileSizeBytes, format)

  if (fileSizeBytes < WAV_HEADER_BYTES) {
    return {
      header: writeWavHeader({ dataBytes: 0, format }),
      frames: 0,
      usedFallback: true,
      format,
      recoverable: false,
      reason: `文件仅 ${fileSizeBytes} 字节（< ${WAV_HEADER_BYTES}），只有头没有素材`,
    }
  }

  const usedFallback = input.meta === null
  const claimed = input.meta ? Math.max(0, Math.floor(input.meta.framesWritten) || 0) : available
  // 关键：以文件实际大小为准取 min（docs/05 §3 步骤 2）
  const frames = Math.min(claimed, available)

  return {
    header: writeWavHeader({ dataBytes: frames * bytesPerFrame(format), format }),
    frames,
    usedFallback,
    format,
    recoverable: frames > 0 || available === 0,
    reason:
      claimed > available
        ? `meta 声明 ${claimed} 帧，文件实际只够 ${available} 帧，已按文件为准裁剪`
        : undefined,
  }
}

/** 便捷：头部字节数 */
export function wavHeaderBytes(): number {
  return WAV_HEADER_BYTES
}

/**
 * 从「用 writeWavHeader 生成的头」读出数据段声明长度（偏移 40 的 u32）。
 * @throws 不抛异常；头长度不足 44 字节时返回 null
 */
export function readDataBytesFromHeader(header: Buffer): number | null {
  if (header.length < WAV_HEADER_BYTES) return null
  return header.readUInt32LE(40)
}

/** 16-bit WAV 载荷 → float32（工具脚本/测试用） */
export function wavPcm16ToFloat32(buf: Buffer, dataOffset = WAV_HEADER_BYTES): Float32Array {
  return int16LEToFloat32(buf.subarray(dataOffset))
}
