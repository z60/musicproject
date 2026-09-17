/**
 * 启动编排 · WAV 头构造与解析（崩溃恢复专用）
 * ============================================================================
 * 设计依据：
 *   · docs/05 §2.4「策略：预置头 + 追加写 + 定期 sync + 伴生元数据」
 *   · docs/05 §3「崩溃恢复（数据安全核心）」第 3~4 步
 *   · docs/04 §7「生成合法 WAV 头（RIFF/WAVE/fmt/data，data size = 样本数 × 帧字节）」
 *
 * 为什么需要「自己解析 WAV 头」：
 *   录音写入器先把 44 字节占位头写下去（那时还不知道总长度），结束时才回填。
 *   进程被杀 / 断电时，文件里是**完整的数据 + 错误的头**。恢复时要：
 *     1. 用 meta.json 的 framesWritten（或 `(fileSize-44)/frameBytes`）算出真实帧数
 *     2. 重新生成一个合法的 44 字节头
 *   解析现有头是为了在 meta.json 丢失时**抢救出采样率/位深/声道**——
 *   如果连格式都不知道，就只能放弃恢复（宁可让用户人工抢救，也不要猜错格式
 *   产生一段听起来像噪音的「恢复录音」）。
 */

import { WAV_HEADER_BYTES as HEADER_BYTES } from '../../shared/constants.ts'

/** WAV 头长度（RIFF/WAVE/fmt/data 最小实现，见 constants.ts） */
export const WAV_HEADER_BYTES = HEADER_BYTES

/** 音频格式（与 docs/04 §7 的 meta.json 字段一致） */
export interface WavFormat {
  sampleRate: number
  bitDepth: number
  channels: number
  /**
   * 32 位时是 float（WAVE_FORMAT_IEEE_FLOAT=3）还是 PCM（1）。
   * docs/05 §2.5 建议落盘 32f（可救增益失误），因此这个位必须显式记录；
   * 缺省按 PCM 处理（更保守：错判成 float 会让整段录音听起来是噪音）。
   */
  float?: boolean
}

/** 每帧字节数 = 声道数 × 位深/8 */
export function bytesPerFrame(format: WavFormat): number {
  return Math.max(1, format.channels) * Math.max(8, format.bitDepth) / 8
}

export const WAVE_FORMAT_PCM = 1
export const WAVE_FORMAT_IEEE_FLOAT = 3

/** 生成 44 字节合法 WAV 头（RIFF / WAVE / fmt / data） */
export function buildWavHeader(format: WavFormat, frames: number): Buffer {
  const channels = Math.max(1, Math.floor(format.channels))
  const bitDepth = Math.max(8, Math.floor(format.bitDepth))
  const sampleRate = Math.max(1, Math.floor(format.sampleRate))
  const blockAlign = (channels * bitDepth) / 8
  const byteRate = sampleRate * blockAlign
  const dataBytes = Math.max(0, Math.floor(frames)) * blockAlign

  const buf = Buffer.alloc(WAV_HEADER_BYTES)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4) // RIFF chunk size = 4 + (8+16) + (8+dataBytes)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size（PCM 固定 16）
  buf.writeUInt16LE(format.float === true && bitDepth === 32 ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitDepth, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

export interface ParsedWav {
  valid: boolean
  /** 'RIFF' + 'WAVE' 都在 */
  riff: boolean
  audioFormat: number
  sampleRate: number
  channels: number
  bitDepth: number
  /** 头部声明的 data 字节数 */
  declaredDataBytes: number
  /** 头部声明的帧数（向下取整到帧边界） */
  declaredFrames: number
  dataOffset: number
  issues: string[]
}

/**
 * 解析 WAV 头（遍历 chunk，而不是死认 44 字节偏移）。
 *
 * 为什么遍历 chunk：录音写入器写的是 44 字节标准头，但**转码/外部工具**产出的 WAV
 * 常带 `LIST`/`fact` 等附加块（偏移就不是 44），死认偏移会把数据段起点算错，
 * 恢复出来的文件会带一段噪音。
 */
export function parseWavHeader(buf: Buffer): ParsedWav {
  const issues: string[] = []
  const out: ParsedWav = {
    valid: false,
    riff: false,
    audioFormat: 0,
    sampleRate: 0,
    channels: 0,
    bitDepth: 0,
    declaredDataBytes: 0,
    declaredFrames: 0,
    dataOffset: WAV_HEADER_BYTES,
    issues,
  }
  if (buf.length < WAV_HEADER_BYTES) {
    issues.push(`文件头不足 ${WAV_HEADER_BYTES} 字节（实际 ${buf.length}）`)
    return out
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF') issues.push('缺少 RIFF 标识')
  if (buf.toString('ascii', 8, 12) !== 'WAVE') issues.push('缺少 WAVE 标识')
  out.riff = issues.length === 0

  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      out.audioFormat = buf.readUInt16LE(body)
      out.channels = buf.readUInt16LE(body + 2)
      out.sampleRate = buf.readUInt32LE(body + 4)
      out.bitDepth = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      out.declaredDataBytes = size
      out.dataOffset = body
      const frameBytes = (Math.max(1, out.channels) * Math.max(8, out.bitDepth)) / 8
      out.declaredFrames = frameBytes > 0 ? Math.floor(size / frameBytes) : 0
      break
    }
    // chunk 按偶数字节对齐（RIFF 规范）
    offset = body + size + (size % 2)
  }

  if (out.sampleRate <= 0) issues.push('fmt 块缺少有效采样率')
  if (out.channels <= 0) issues.push('fmt 块缺少有效声道数')
  if (out.bitDepth <= 0) issues.push('fmt 块缺少有效位深')
  if (out.declaredDataBytes === 0) issues.push('data 块声明长度为 0（未回填的占位头）')

  out.valid = out.audioFormat !== 0 && out.sampleRate > 0 && out.channels > 0 && out.bitDepth > 0
  return out
}

/** 从已解析的头推断格式（meta.json 缺失时的抢救路径） */
export function formatFromParsed(parsed: ParsedWav): WavFormat | null {
  if (!parsed.valid) return null
  return {
    sampleRate: parsed.sampleRate,
    bitDepth: parsed.bitDepth,
    channels: parsed.channels,
    float: parsed.audioFormat === WAVE_FORMAT_IEEE_FLOAT,
  }
}

/** 帧数 → 时长（毫秒） */
export function framesToMs(frames: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0
  return Math.round((frames / sampleRate) * 1000)
}

/** 从文件大小推断可用帧数（docs/05 §3 第 2 步：以文件为准，避免头大身子小） */
export function availableFrames(fileSize: number, format: WavFormat, dataOffset = WAV_HEADER_BYTES): number {
  const bytes = fileSize - dataOffset
  if (bytes <= 0) return 0
  return Math.floor(bytes / bytesPerFrame(format))
}
