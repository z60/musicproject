/**
 * Novel Studio · TXT 解析器（docs/10 §8.1）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §3 第 ②③ 步：限流读取 → 嗅探编码 → 解码 → 统一换行 → 记录 encoding
 *   · §4 编码嗅探（实现见 shared/text/encoding.ts）
 *   · §4.4 常见异常（ï»¿ / 锟斤拷 / 混合编码）
 *   · §8.1 TXT 实现要点：以 Buffer 读取；大文件先取前缀判编码再整体解码；
 *          50 MB 以上分块解码后拼接；保留 rawText 供「查看被删内容」
 *   · §10 错误码：FILE_TOO_LARGE / ENCODING_DECODE_FAILED
 */

import { Buffer } from 'node:buffer'

import type { EncodingDetection } from '../../../../../shared/types.ts'
import { IMPORT_LIMITS } from '../../../../../shared/constants.ts'
import { AppError, formatBytes } from '../../../../../shared/errors.ts'
import {
  createDecoder,
  detectEncoding,
  normalizeNewlines,
  stripBom,
  type Decoder,
  type DetectOptions,
} from '../../../../../shared/text/encoding.ts'

// ============================================================================
// 类型
// ============================================================================

export interface TxtParseInput {
  /** 原始字节（必须用 Buffer 读，不能用 fs.readFile(path,'utf8')，见 docs/10 §8.1） */
  buffer: Buffer
  /** 已确定编码时直接给解码器（UI 让用户选完编码后重新解码，不再重读文件，docs/10 §4.3） */
  decoder?: Decoder
  /** 或给出编码名，由本模块建解码器（可配合 decoders 注入 iconv-lite） */
  encoding?: string
  /** 注入型解码器表（生产环境用 iconv-lite） */
  decoders?: Record<string, Decoder>
  /** 已算好的判定结果（避免重复嗅探） */
  detection?: EncodingDetection
  /** 嗅探选项（可与 sniffer 注入配合，生产环境用 chardet） */
  detectOptions?: DetectOptions
  /** 单文件上限（默认 IMPORT_LIMITS.maxFileSizeBytes = 200 MB） */
  maxBytes?: number
  /** 超过它就走分块解码（默认 50 MB，docs/10 §8.1） */
  chunkThresholdBytes?: number
  /** 分块大小（默认 8 MB） */
  chunkBytes?: number
  /** 混合编码检查的块大小（默认 1 MB，docs/10 §4.4） */
  mixedCheckBlockBytes?: number
  /** 混合编码检查的最大块数（默认 8，避免大文件反复嗅探） */
  mixedCheckMaxBlocks?: number
  signal?: AbortSignal
}

export interface TxtParseResult {
  /** 解码 + 换行归一 + 去 BOM 后的全文（清洗前的 rawText） */
  text: string
  encoding: string
  detection: EncodingDetection
  /** 原始字节数 */
  byteLength: number
  /** 是否走了分块解码 */
  chunked: boolean
  warnings: string[]
}

// ============================================================================
// 常量
// ============================================================================

/** 默认分块阈值与块大小（docs/10 §8.1） */
export const DEFAULT_CHUNK_THRESHOLD_BYTES = 50 * 1024 * 1024
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
export const DEFAULT_MIXED_CHECK_BLOCK_BYTES = 1024 * 1024
export const DEFAULT_MIXED_CHECK_MAX_BLOCKS = 8

// ============================================================================
// 内部工具
// ============================================================================

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage: 'parseTxt' } })
}

/** 解码失败统一抛 ENCODING_DECODE_FAILED（docs/10 §10） */
function decodeFailed(encoding: string, reason: string): AppError {
  return new AppError('ENCODING_DECODE_FAILED', {
    params: {},
    details: { encoding, reason },
  })
}

/** 把偏移量对齐到「不会切断多字节字符」的位置（仅对定长/自同步编码有效） */
function alignOffset(buffer: Buffer, offset: number, encoding: string): number {
  if (offset >= buffer.length) return buffer.length
  if (encoding === 'UTF-16LE' || encoding === 'UTF-16BE') {
    return offset % 2 === 0 ? offset : offset + 1
  }
  // UTF-8：跳过续字节（10xxxxxx）
  let off = offset
  while (off < buffer.length && (buffer[off]! & 0xc0) === 0x80) off++
  return off
}

/** 支持「按块边界对齐」的编码（GB18030/Big5 等不等长编码不在此列） */
const ALIGNABLE_ENCODINGS = new Set(['UTF-8', 'UTF-16LE', 'UTF-16BE'])

interface DecodeOutcome {
  text: string
  chunked: boolean
  warning?: string
}

/**
 * 分块解码（docs/10 §8.1）。
 *  · 解码器带 stream 时：无论什么编码都能安全分块
 *  · 否则：UTF-8 / UTF-16 通过对齐块边界安全分块
 *  · 其余编码（GB18030 / Big5…）：退化为整块解码，并给出内存提示
 */
function decodeAll(
  buffer: Buffer,
  encoding: string,
  decoder: Decoder,
  chunkBytes: number,
): DecodeOutcome {
  if (decoder.stream) {
    const parts: string[] = []
    for (let off = 0; off < buffer.length; off += chunkBytes) {
      const end = Math.min(off + chunkBytes, buffer.length)
      const piece = decoder.stream(buffer.subarray(off, end), false)
      if (piece === null) throw decodeFailed(encoding, `分块解码失败（offset=${off}）`)
      parts.push(piece)
    }
    const tail = decoder.stream(Buffer.alloc(0), true)
    if (tail === null) throw decodeFailed(encoding, '分块解码收尾失败')
    parts.push(tail)
    return { text: parts.join(''), chunked: true }
  }

  if (ALIGNABLE_ENCODINGS.has(encoding)) {
    const parts: string[] = []
    let off = 0
    while (off < buffer.length) {
      const end = alignOffset(buffer, Math.min(off + chunkBytes, buffer.length), encoding)
      const piece = decoder(buffer.subarray(off, end))
      if (piece === null) throw decodeFailed(encoding, `分块解码失败（offset=${off}）`)
      parts.push(piece)
      off = end
    }
    return { text: parts.join(''), chunked: true }
  }

  const text = decoder(buffer)
  if (text === null) throw decodeFailed(encoding, '解码器返回 null')
  return {
    text,
    chunked: false,
    warning: `编码 ${encoding} 不支持安全分块解码，已整块解码；超大文件可能占用较多内存`,
  }
}

/**
 * 混合编码检查（docs/10 §4.4：「半数正常半数乱码 = 拼接文件」）。
 * 在均匀分布的若干 1 MB 块上独立嗅探，若结论不一致就给出警告。
 * @returns 警告文案数组（无问题时为空）
 */
function checkMixedEncoding(
  buffer: Buffer,
  encoding: string,
  detectOptions: DetectOptions | undefined,
  blockBytes: number,
  maxBlocks: number,
): string[] {
  if (buffer.length <= blockBytes * 2) return []
  const findings = new Set<string>()
  const blockCount = Math.min(maxBlocks, Math.ceil(buffer.length / blockBytes))
  const step = Math.max(1, Math.floor((buffer.length - blockBytes) / Math.max(1, blockCount - 1)))
  for (let i = 0; i < blockCount; i++) {
    const start = buffer.length > blockBytes ? Math.min(i * step, buffer.length - blockBytes) : 0
    const slice = buffer.subarray(start, Math.min(start + blockBytes, buffer.length))
    const found = detectEncoding(slice, detectOptions)
    if (found.encoding !== encoding) findings.add(found.encoding)
  }
  if (findings.size === 0) return []
  return [
    `检测到疑似混合编码：整体判定为 ${encoding}，但部分区段更像 ${[...findings].join(' / ')}。` +
      '这类文件多为多次拼接或转码产生，建议在预览中抽查正文。',
  ]
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 解析 TXT（docs/10 §8.1）。
 *
 * 流程：限流检查 → 编码嗅探（或使用调用方给定的编码）→ 解码 → 去 BOM → 统一换行。
 *
 * @param input.buffer 原始字节
 * @param input.decoder / input.encoding 用户指定编码时使用（UI 的编码确认步骤）
 * @param input.signal 取消信号；每一步都会检查
 * @returns 全文、最终编码、判定明细、原始字节数、是否分块解码、警告
 * @throws AppError `FILE_TOO_LARGE`（超过 maxBytes）
 * @throws AppError `ENCODING_DECODE_FAILED`（本环境无该编码解码器 / 解码结果为空）
 * @throws AppError `TASK_CANCELLED`（signal 已中止）
 */
export async function parseTxt(input: TxtParseInput): Promise<TxtParseResult> {
  throwIfAborted(input.signal)
  const warnings: string[] = []
  const maxBytes = input.maxBytes ?? IMPORT_LIMITS.maxFileSizeBytes
  const buffer = input.buffer

  // ① 限流（docs/10 §3 第 ② 步、§10 FILE_TOO_LARGE）
  if (buffer.length > maxBytes) {
    throw new AppError('FILE_TOO_LARGE', {
      params: { size: formatBytes(buffer.length), max: formatBytes(maxBytes) },
      details: { byteLength: buffer.length, maxBytes },
    })
  }
  if (buffer.length === 0) {
    throw decodeFailed('unknown', '文件内容为空')
  }

  // ② 编码判定（或使用调用方指定的编码）
  const detection =
    input.detection ??
    (input.encoding
      ? { encoding: input.encoding, confidence: 1, candidates: [], bomLength: 0, needsUserChoice: false }
      : detectEncoding(buffer, input.detectOptions))
  const encoding = input.encoding ?? detection.encoding
  if (detection.needsUserChoice) {
    // 编码不确定不是错误（docs/10 §10：ENCODING_UNCERTAIN 是进入编码选择步骤的引导）
    warnings.push(
      `编码识别不确定（判定为 ${detection.encoding}，置信度 ${detection.confidence.toFixed(2)}），` +
        '请在编码确认步骤预览候选编码下的文本并确认。',
    )
  }
  throwIfAborted(input.signal)

  // ③ 解码
  const decoder = input.decoder ?? createDecoder(encoding, input.decoders)
  if (!decoder) {
    throw decodeFailed(
      encoding,
      '本环境没有该编码的解码器（UTF-32 或 small-ICU 构建）；' +
        '生产环境应注入 iconv-lite 实现，方式：{ decoders: { GB18030: (buf) => iconv.decode(buf, "gb18030") } }',
    )
  }
  const byteLength = buffer.length
  const chunkThreshold = input.chunkThresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES
  const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES
  let decoded: string
  let chunked = false
  if (byteLength > chunkThreshold) {
    const outcome = decodeAll(buffer, encoding, decoder, chunkBytes)
    decoded = outcome.text
    chunked = outcome.chunked
    if (outcome.warning) warnings.push(outcome.warning)
  } else {
    const single = decoder(buffer)
    if (single === null) throw decodeFailed(encoding, '解码器返回 null')
    decoded = single
  }
  throwIfAborted(input.signal)

  // ④ 去 BOM + 统一换行（docs/10 §3 第 ③ 步）
  const text = normalizeNewlines(stripBom(decoded))
  if (text.length === 0) {
    throw decodeFailed(encoding, '解码结果为空，文件可能已损坏或被错误转码')
  }

  // ⑤ 混合编码提示（docs/10 §4.4）
  warnings.push(
    ...checkMixedEncoding(
      buffer,
      encoding,
      input.detectOptions,
      input.mixedCheckBlockBytes ?? DEFAULT_MIXED_CHECK_BLOCK_BYTES,
      input.mixedCheckMaxBlocks ?? DEFAULT_MIXED_CHECK_MAX_BLOCKS,
    ),
  )

  return { text, encoding, detection, byteLength, chunked, warnings }
}
