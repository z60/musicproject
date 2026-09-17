/**
 * Novel Studio · 粘贴文本解析器（直通，docs/10 §8.5 / §2）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §2 表格：粘贴文本 → 文本域 → 直通（走同一分章管线）
 *   · §8.5：文本域支持粘贴任意长度；超过 1 MB 时提示「文本较大，解析可能需要一会」；
 *          默认书名「未命名作品」+ 时间戳，用户可改
 *
 * 这里不做任何「智能」处理：粘贴进来的已经是 JS 字符串（无需编码嗅探），
 * 只做「去 BOM + 统一换行 + 大小提示」，后续清洗/分章与文件导入完全共用。
 */

import { Buffer } from 'node:buffer'

import { normalizeNewlines, stripBom } from '../../../../../shared/text/encoding.ts'
import { AppError } from '../../../../../shared/errors.ts'

// ============================================================================
// 类型
// ============================================================================

export interface PlainParseInput {
  /** 粘贴进来的原始文本 */
  text: string
  /** 用户给的书名（可空，走默认名） */
  title?: string
  /** 大文本提示阈值（默认 1 MB，docs/10 §8.5） */
  largeThresholdBytes?: number
  /** 注入当前时间（便于测试；默认 Date.now） */
  now?: () => number
  signal?: AbortSignal
}

export interface PlainParseResult {
  text: string
  /** 粘贴文本一定已是 JS 字符串，编码记为 UTF-8（写入 book 元数据） */
  encoding: string
  /** 最终书名（用户没给时用「未命名作品 + 时间戳」） */
  title: string
  warnings: string[]
}

// ============================================================================
// 常量
// ============================================================================

export const DEFAULT_LARGE_THRESHOLD_BYTES = 1024 * 1024

/** 默认书名前缀（docs/10 §8.5） */
export const DEFAULT_PASTE_TITLE_PREFIX = '未命名作品'

// ============================================================================
// 工具
// ============================================================================

/** 生成「未命名作品 2025-01-02 15:04」形式的时间戳（本地时区，便于用户辨认） */
export function timestampTitle(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${DEFAULT_PASTE_TITLE_PREFIX} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 解析粘贴文本（docs/10 §8.5）。
 *
 * @param input.text 粘贴内容（任意长度）
 * @param input.title 用户指定书名；为空时用「未命名作品 + 时间戳」
 * @returns 归一化后的文本、编码标记（UTF-8）、书名与警告
 * @throws AppError `INVALID_PAYLOAD`（粘贴内容为空，没什么可导入）
 * @throws AppError `TASK_CANCELLED`（signal 已中止）
 */
export async function parsePlain(input: PlainParseInput): Promise<PlainParseResult> {
  if (input.signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage: 'parsePlain' } })
  const raw = input.text ?? ''
  const text = normalizeNewlines(stripBom(raw))
  if (text.trim().length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { reason: '粘贴内容为空' } })
  }
  const warnings: string[] = []
  const byteLength = Buffer.byteLength(text, 'utf8')
  const threshold = input.largeThresholdBytes ?? DEFAULT_LARGE_THRESHOLD_BYTES
  if (byteLength > threshold) {
    warnings.push(`文本较大（约 ${(byteLength / 1024 / 1024).toFixed(1)} MB），解析可能需要一会。`)
  }
  const title = input.title?.trim() ? input.title.trim() : timestampTitle((input.now ?? Date.now)())
  return { text, encoding: 'UTF-8', title, warnings }
}
