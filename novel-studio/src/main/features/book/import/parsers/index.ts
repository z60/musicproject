/**
 * Novel Studio · 解析器分发（docs/10 §3 第 ① 步）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §3 第 ① 步：探测源类型 —— 文件按「读扩展名 + 魔数（magic bytes）双重判定（防改扩展名）」
 *   · §2 支持源表格：TXT / DOCX / PDF / 粘贴 / URL / 剪贴板文件（按扩展名分发）
 *   · §10 错误码：FILE_TOO_LARGE（在 txt.parser 里检查）
 *
 * 魔数与扩展名不一致时**以魔数为准**（防改扩展名），并记录一条 warning 供 UI 提示。
 */

import { Buffer } from 'node:buffer'

import type { BookSourceType, ImportFileProbe } from '../../../../../shared/types.ts'
import { IMPORT_LIMITS } from '../../../../../shared/constants.ts'
import { AppError } from '../../../../../shared/errors.ts'

export * from './txt.parser.ts'
export * from './plain.parser.ts'
export * from './docx.parser.ts'
export * from './pdf.parser.ts'
export * from './web.parser.ts'

// ============================================================================
// 扩展名与魔数
// ============================================================================

/** 扩展名 → 源类型 */
export const EXTENSION_KINDS: Readonly<Record<string, BookSourceType | 'html'>> = {
  '.txt': 'txt',
  '.text': 'txt',
  '.md': 'txt',
  '.log': 'txt',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
}

/** PDF 魔数：`%PDF-` */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]
/** ZIP 魔数（DOCX 是 ZIP 容器） */
const ZIP_MAGICS = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
]

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false
  }
  return true
}

/** 文本型 BOM（UTF-8 / UTF-16 / UTF-32）都说明这是纯文本 */
function hasTextBom(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0xef, 0xbb, 0xbf]) ||
    startsWith(bytes, [0xff, 0xfe]) ||
    startsWith(bytes, [0xfe, 0xff]) ||
    startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])
  )
}

/** 去掉前导空白后是否以 HTML 标签开头 */
function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1').trimStart().toLowerCase()
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<?xml') && head.includes('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body')
  )
}

/** 二进制噪声比例（用于判断「不是文本」） */
export function binaryNoiseRatio(bytes: Uint8Array): number {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  if (sample.length === 0) return 0
  let noise = 0
  for (const b of sample) {
    if (b === 0x00) {
      noise++
      continue
    }
    if (b < 0x09) noise++
    else if (b > 0x0d && b < 0x20) noise++
  }
  return noise / sample.length
}

/**
 * ZIP 容器里是否含 `word/`（DOCX 特征）。
 * ZIP 的中央目录在文件尾部，条目名也会出现在本地文件头里，因此在头尾各取一段做特征匹配。
 */
export function looksLikeDocxZip(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).toString('latin1')
  if (head.includes('word/')) return true
  const tailStart = Math.max(0, bytes.length - 64 * 1024)
  const tail = Buffer.from(bytes.subarray(tailStart)).toString('latin1')
  return tail.includes('word/')
}

// ============================================================================
// 探测
// ============================================================================

export interface ProbeInput {
  /** 文件字节（至少前若干 KB；不传 filePath 时全靠它） */
  buffer?: Buffer | Uint8Array
  /** 文件路径或文件名（取扩展名用） */
  filePath?: string
  /** 文件大小（不给则取 buffer.length） */
  sizeBytes?: number
}

export interface ProbeResult extends ImportFileProbe {
  /** 实际判定的源类型（html 归为 url：复用正文提取能力） */
  detectedBy: 'extension' | 'magic' | 'both' | 'fallback'
  /** 扩展名与实际内容不一致等提示 */
  warnings: string[]
  /** 扩展名声明的类型（若给了 filePath） */
  extensionKind: BookSourceType | 'html' | null
  /** 内容（魔数/字节特征）判定出的真实类型 */
  contentKind: 'docx' | 'pdf' | 'html' | 'text' | 'unknown'
  /** 建议的解析器（省得调用方再算一遍） */
  parser: 'txt' | 'docx' | 'pdf' | 'html' | undefined
}

/**
 * 探测文件类型（docs/10 §3 第 ① 步：扩展名 + 魔数双重判定）。
 *
 * 判定优先级：
 *   1. 魔数：`%PDF-` → pdf；ZIP + `word/` → docx；HTML 特征 → html；文本 BOM → text
 *   2. 扩展名（魔数无法判定时）
 *   3. 兜底：二进制噪声低 → 纯文本；否则 unknown
 *
 * @param input.buffer 文件头字节（建议 ≥ 64 KB，用于 ZIP 特征与 HTML 判定）
 * @param input.filePath 文件路径（取扩展名）
 * @returns ImportFileProbe（kind/sizeBytes/hasTextLayer）+ 判定来源、contentKind、建议解析器与警告
 */
export function probeFile(input: ProbeInput): ProbeResult {
  const bytes = input.buffer ? (Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer)) : Buffer.alloc(0)
  const sizeBytes = input.sizeBytes ?? bytes.length
  const warnings: string[] = []
  const extension = input.filePath ? extensionOf(input.filePath) : null
  const extensionKind = extension ? EXTENSION_KINDS[extension] ?? null : null

  let contentKind: ProbeResult['contentKind'] = 'unknown'
  if (bytes.length > 0) {
    if (startsWith(bytes, PDF_MAGIC)) {
      contentKind = 'pdf'
    } else if (ZIP_MAGICS.some((m) => startsWith(bytes, m))) {
      if (looksLikeDocxZip(bytes)) {
        contentKind = 'docx'
      } else {
        warnings.push('这是一个 ZIP 压缩包，但不是 DOCX（未找到 word/ 目录）')
      }
    } else if (hasTextBom(bytes)) {
      contentKind = 'text'
    } else if (looksLikeHtml(bytes)) {
      contentKind = 'html'
    } else if (binaryNoiseRatio(bytes) < 0.02) {
      contentKind = 'text'
    }
  }

  let kind: BookSourceType | 'unknown'
  let detectedBy: ProbeResult['detectedBy']
  const magicKind: BookSourceType | 'html' | null =
    contentKind === 'pdf' || contentKind === 'docx' || contentKind === 'html'
      ? contentKind
      : contentKind === 'text'
        ? 'txt'
        : null
  // 强魔数（PDF/ZIP/HTML 结构）优先于扩展名；纯文本的「魔数」只是低噪声兜底，
  // 不能盖掉 .docx/.pdf 这类明确扩展名
  const strongMagic = contentKind === 'pdf' || contentKind === 'docx' || contentKind === 'html'
  const textLikeMagic = contentKind === 'text' && (extensionKind === null || extensionKind === 'txt')

  if (magicKind && (strongMagic || textLikeMagic)) {
    kind = magicKind === 'html' ? 'url' : magicKind
    detectedBy = extensionKind ? 'both' : 'magic'
    if (extensionKind && extensionKind !== magicKind) {
      // 防改扩展名：以内容为准，但明确提示（docs/10 §3 第 ① 步）
      warnings.push(`文件扩展名（${extension}）与文件内容（${magicKind}）不一致，已按内容处理`)
      detectedBy = 'magic'
    }
  } else if (extensionKind) {
    kind = extensionKind === 'html' ? 'url' : extensionKind
    detectedBy = 'extension'
  } else if (contentKind === 'text') {
    kind = 'txt'
    detectedBy = 'fallback'
    warnings.push('未能从扩展名或魔数判定类型，按纯文本处理')
  } else {
    kind = 'unknown'
    detectedBy = 'fallback'
    warnings.push('无法识别文件类型')
  }

  if (sizeBytes > IMPORT_LIMITS.maxFileSizeBytes) {
    warnings.push(`文件大小超过默认上限 ${(IMPORT_LIMITS.maxFileSizeBytes / 1024 / 1024).toFixed(0)} MB`)
  }

  const parser: ProbeResult['parser'] =
    contentKind === 'html' || extensionKind === 'html'
      ? 'html'
      : kind === 'txt'
        ? 'txt'
        : kind === 'docx'
          ? 'docx'
          : kind === 'pdf'
            ? 'pdf'
            : undefined

  return {
    kind,
    sizeBytes,
    // PDF 的文本层要真正解析后才知道；这里不猜（见 pdf.parser.parsePdf）
    detectedBy,
    warnings,
    extensionKind,
    contentKind,
    parser,
  }
}

/** 取扩展名（小写，含点） */
export function extensionOf(filePath: string): string | null {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return null
  return name.slice(idx).toLowerCase()
}

/**
 * 把探测结果映射到解析器名字（供 import.service 分发用）。
 * @param probe probeFile 的结果
 * @returns 'txt' | 'docx' | 'pdf' | 'web' | 'plain'；无法处理时 undefined
 */
export function dispatcherFor(probe: ImportFileProbe): 'txt' | 'docx' | 'pdf' | 'web' | 'plain' | undefined {
  switch (probe.kind) {
    case 'txt':
      return 'txt'
    case 'docx':
      return 'docx'
    case 'pdf':
      return 'pdf'
    case 'url':
      return 'web'
    case 'paste':
      return 'plain'
    default:
      return undefined
  }
}

/**
 * 文件分发入口：探测 → 返回解析器名（真正解析由 import.service 编排，
 * 因为那一步需要注入 mammoth/pdfjs/cheerio 等可选依赖）。
 *
 * @throws AppError `INVALID_PAYLOAD`：无法识别的文件类型
 */
export function dispatchFile(input: ProbeInput): { probe: ProbeResult; parser: 'txt' | 'docx' | 'pdf' | 'web' } {
  const probe = probeFile(input)
  const parser = dispatcherFor(probe)
  if (!parser || parser === 'plain') {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        reason: '无法识别的文件类型',
        filePath: input.filePath,
        detected: probe.kind,
        warnings: probe.warnings,
      },
    })
  }
  return { probe, parser }
}
