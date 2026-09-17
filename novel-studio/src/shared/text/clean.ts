/**
 * Novel Studio · 文本清洗
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §5.1 必须清洗（默认开启，可关）：广告行 / 页尾导航 / 网址水印 / 重复行 /
 *          页码行 / 零宽字符 / 全角空格 / 多余空行 / 行首尾空白 / 不换行空格
 *   · §5.2 谨慎处理（默认关闭）：非相邻去重 / 合并硬换行段落 / 繁简转换 / 去括号内容
 *   · §5.3 清洗报告（必须可见）：计数 + suspiciousLines + 「查看被删内容」
 *
 * 关键纪律（docs/10 §5.3 原文）：「不要静默删用户的东西」——
 * 因此本模块除了计数以外，**逐行记录被删除的内容**（`removedLines`），供 UI 逐条恢复。
 * `CleanReport`（src/shared/types.ts）是上游契约、不可改，所以这里用
 * `CleanReportDetail extends CleanReport` 扩展出 `removedLines` 等字段。
 *
 * 零第三方依赖：繁简转换必须注入实现（生产环境用 opencc-js），未注入时该项被跳过并记 warning，
 * 绝不假装转换成功。
 */

import type { CleanReport } from '../types.ts'
import { AD_LINE_PATTERNS, NAV_LINE_PATTERNS } from '../constants.ts'
import { normalizeNewlinesWithCount, stripBom } from './encoding.ts'

// ============================================================================
// 类型
// ============================================================================

export type RemovedReason =
  | 'ad'
  | 'nav'
  | 'url-watermark'
  | 'duplicate'
  | 'non-adjacent-duplicate'
  | 'page-number'
  | 'bracket-content'

export interface RemovedLine {
  /** 在「换行归一化之后」的原文里的行号（1 起） */
  lineNo: number
  /** 被删掉的内容原文（括号内容类为被删片段） */
  text: string
  reason: RemovedReason
  /** 中文原因说明，供 UI 直接展示 */
  reasonText: string
}

/** docs/10 §5.3 的 CleanReport + 「查看被删内容」所需字段 */
export interface CleanReportDetail extends CleanReport {
  /** 被删除的内容清单（受 maxRemovedLines 限制） */
  removedLines: RemovedLine[]
  /** removedLines 是否被截断（计数仍然精确） */
  removedLinesTruncated: boolean
  /** 按原因分组的删除计数 */
  removedByReason: Record<RemovedReason, number>
  /** 谨慎项：合并掉的硬换行处数 */
  mergedHardWrapLines: number
  /** 连续空行压缩处数 */
  collapsedBlankRuns: number
  /** 空格归一化处数（&nbsp; / U+00A0 / U+3000 / 连续空格） */
  normalizedSpaces: number
  /** 被跳过或需要人工注意的提示 */
  warnings: string[]
}

export interface CleanOptions {
  // ---- 必须清洗（docs/10 §5.1，默认全开） ----
  /** 去站点广告行（关键词见 AD_LINE_PATTERNS） */
  removeAdLines?: boolean
  /** 去页尾导航行（上一章/下一章/返回目录…） */
  removeNavLines?: boolean
  /** 去网址水印（行内 URL 且整行 < 60 字） */
  removeUrlWatermark?: boolean
  /** 去相邻/窗口内重复行（±5 行，长度 > 8） */
  removeDuplicateLines?: boolean
  /** 去页码行（第 12 页 / - 12 - / 纯数字行） */
  removePageNumberLines?: boolean
  /**
   * 保护纯数字行：开启后「纯数字行」不会被当页码删除。
   * 用途：规则集允许「纯数字章节标题」（constants.ts 的 `builtin:cn-loose` 的 num-only 规则）时，
   * 页码规则会把章节标题一起删掉 —— 这是一处 docs/10 §5.1 与 §6.2 的规则冲突，
   * 由调用方在选定该规则集时打开本开关（见 import.service.ts）。
   */
  protectPureDigitLines?: boolean
  /** 去零宽与特殊字符（U+200B~U+200F、U+202A~U+202E、U+FEFF 非首位） */
  removeZeroWidth?: boolean
  /** 全角空格 U+3000 → 普通空格，并压缩连续空格 */
  normalizeFullWidthSpace?: boolean
  /** `&nbsp;` 与 U+00A0 → 普通空格 */
  normalizeNbsp?: boolean
  /** 连续 ≥3 个 \n → 2 个 */
  collapseBlankLines?: boolean
  /** 每行 trim()（中文排版惯例） */
  trimLines?: boolean

  // ---- 谨慎处理（docs/10 §5.2，默认关闭） ----
  /** 去重「非相邻重复行」（可能误删作者有意重复的排比句） */
  removeNonAdjacentDuplicates?: boolean
  /** 合并被硬换行切断的段落（可能误合对话） */
  mergeHardWrappedLines?: boolean
  /** 去除所有括号内容（会删掉作者注释与音效提示） */
  removeBracketContent?: boolean
  /** 繁简转换（改变原文，仅在用户明确需要时启用） */
  traditionalToSimplified?: boolean
  /**
   * 繁简转换实现（注入）。生产环境用 opencc-js：
   *   `const converter = (s) => OpenCC.Converter({ from: 'hk', to: 'cn' })(s)`
   * 未注入时该项被跳过并在 warnings 中说明（不假装成功）。
   */
  traditionalToSimplifiedConverter?: (text: string) => string

  // ---- 其它 ----
  /** 重复行检查窗口（±N 行，默认 5，docs/10 §5.1） */
  duplicateWindow?: number
  /** suspiciousLines 上限（默认 200，docs/10 §5.3） */
  maxSuspiciousLines?: number
  /** removedLines 上限（默认 5000；计数不受影响） */
  maxRemovedLines?: number
}

// ============================================================================
// 判定用正则与常量
// ============================================================================

/** 零宽与双向控制字符（docs/10 §5.1） */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g

/** 行内 URL 判定（网址水印用） */
const URL_RE = /(?:https?:\/\/|www\.)[^\s，。；：！？"'）】》]+|[\w-]{2,}\.(?:com|net|org|cn|cc|info|xyz|top|me|tv|biz|site|vip|club|online|art|fun|shop|wang|ltd|ren|icu)(?:\/[^\s]*)?/i

/** 页码行样式 */
const PAGE_LABEL_RE = /^第\s*[0-9]{1,6}\s*页$/
const PAGE_DASHED_RE = /^[-—–－=~_·]{1,3}\s*[0-9]{1,6}\s*[-—–－=~_·]{1,3}$/
const PAGE_NUMERIC_RE = /^[0-9]{1,5}$/
const PAGE_PAREN_RE = /^[（(\[【]\s*[0-9]{1,5}\s*[）)\]】]$/

/** 导航/分隔符号（判断「整行只有导航词」用） */
const NAV_SEPARATOR_RE = /[\s|｜/\\·、,，.。:：;；\-—_]+/g

/** 句末标点（合并硬换行时判断「这行说完了没有」） */
const SENTENCE_END_RE = /[。！？…；：!?;:”’」』】）)]$/

/** 括号族（去括号内容用） */
const BRACKET_PAIRS: Array<[string, string]> = [
  ['（', '）'],
  ['(', ')'],
  ['【', '】'],
  ['[', ']'],
  ['〔', '〕'],
  ['《', '》'],
]

const REASON_TEXT: Record<RemovedReason, string> = {
  ad: '站点广告行（命中广告关键词）',
  nav: '页尾导航行（上一章/下一章/返回目录…）',
  'url-watermark': '网址水印行（行内 URL 且整行较短）',
  duplicate: '与相邻窗口内的行重复（分页导致的重复段落）',
  'non-adjacent-duplicate': '与更早的行重复（谨慎项：可能误删有意重复）',
  'page-number': '页码行',
  'bracket-content': '括号内容（谨慎项：会删掉作者注释与音效提示）',
}

function emptyByReason(): Record<RemovedReason, number> {
  return {
    ad: 0,
    nav: 0,
    'url-watermark': 0,
    duplicate: 0,
    'non-adjacent-duplicate': 0,
    'page-number': 0,
    'bracket-content': 0,
  }
}

// ============================================================================
// 判定助手（全部导出，便于 UI 做「实时预览」与单测）
// ============================================================================

/** 命中了几种广告关键词（同一行重复命中只算一次） */
export function matchAdKeywords(line: string): string[] {
  const hits: string[] = []
  for (const kw of AD_LINE_PATTERNS) {
    if (line.includes(kw) && !hits.includes(kw)) hits.push(kw)
  }
  return hits
}

/** 命中了几种导航关键词 */
export function matchNavKeywords(line: string): string[] {
  const hits: string[] = []
  for (const kw of NAV_LINE_PATTERNS) {
    if (line.includes(kw) && !hits.includes(kw)) hits.push(kw)
  }
  return hits
}

/**
 * 是否为广告行（docs/10 §5.1）。
 * 保守判定：命中关键词且整行 ≤ 60 字，或一行里命中 ≥2 个不同关键词。
 * 长行里只出现一个关键词时**不删**（正文里可能出现「首发」「转码」这类词），
 * 改为在 suspiciousLines 里提示，由用户决定。
 */
export function isAdLine(line: string): boolean {
  const hits = matchAdKeywords(line)
  if (hits.length === 0) return false
  return line.length <= 60 || hits.length >= 2
}

/** 是否为页尾导航行：整行只由导航词与分隔符组成，或命中 ≥2 个导航词 */
export function isNavLine(line: string): boolean {
  const hits = matchNavKeywords(line)
  if (hits.length === 0) return false
  if (hits.length >= 2) return true
  const residue = line.replace(NAV_SEPARATOR_RE, '')
  for (const kw of NAV_LINE_PATTERNS) {
    if (residue.includes(kw)) return residue.replace(kw, '') === ''
  }
  return false
}

/** 是否为网址水印行：行内 URL 且整行 < 60 字（docs/10 §5.1） */
export function isUrlWatermarkLine(line: string): boolean {
  return line.length < 60 && URL_RE.test(line)
}

/**
 * 是否为页码行（docs/10 §5.1）：
 * `第 12 页` / `- 12 -` / `（12）` / 纯数字行（长度 < 6 且前后是空行）。
 * @param protectPureDigit 为 true 时不把纯数字行当页码（保住「纯数字章节标题」）
 */
export function isPageNumberLine(
  line: string,
  context?: { prevBlank?: boolean; nextBlank?: boolean; protectPureDigit?: boolean },
): boolean {
  if (PAGE_LABEL_RE.test(line) || PAGE_DASHED_RE.test(line)) return true
  const surrounded = context?.prevBlank === true && context?.nextBlank === true
  if (!surrounded) return false
  if (PAGE_PAREN_RE.test(line)) return true
  if (context?.protectPureDigit) return false
  return line.length < 6 && PAGE_NUMERIC_RE.test(line)
}

// ============================================================================
// 主入口
// ============================================================================

interface CleanState {
  removedLines: RemovedLine[]
  removedByReason: Record<RemovedReason, number>
  removedLinesTruncated: boolean
  maxRemovedLines: number
  suspiciousLines: CleanReport['suspiciousLines']
  maxSuspiciousLines: number
}

function recordRemoved(state: CleanState, lineNo: number, text: string, reason: RemovedReason): void {
  state.removedByReason[reason]++
  if (state.removedLines.length < state.maxRemovedLines) {
    state.removedLines.push({ lineNo, text, reason, reasonText: REASON_TEXT[reason] })
  } else {
    state.removedLinesTruncated = true
  }
}

function recordSuspicious(
  state: CleanState,
  lineNo: number,
  text: string,
  reason: string,
): void {
  if (state.suspiciousLines.length >= state.maxSuspiciousLines) return
  state.suspiciousLines.push({ lineNo, text: text.slice(0, 200), reason })
}

/** 去掉一行里的括号内容（谨慎项），返回删除后的文本与被删片段 */
export function stripBracketContent(line: string): { text: string; removed: string[] } {
  let out = ''
  const removed: string[] = []
  let i = 0
  while (i < line.length) {
    let matched = false
    for (const [open, close] of BRACKET_PAIRS) {
      if (line.startsWith(open, i)) {
        const closeAt = line.indexOf(close, i + open.length)
        if (closeAt !== -1) {
          removed.push(line.slice(i, closeAt + close.length))
          i = closeAt + close.length
          matched = true
          break
        }
      }
    }
    if (matched) continue
    out += line[i]
    i++
  }
  return { text: out, removed }
}

/**
 * 清洗文本（docs/10 §5.1 默认项 + §5.2 谨慎项）。
 *
 * 处理顺序（先后关系会影响报告口径，务必保持稳定）：
 *   ① 统一换行（\r\n|\r → \n，计入 normalizedNewlines）
 *   ② 去零宽/双向控制字符（计入 removedZeroWidthChars）
 *   ③ &nbsp; / U+00A0 / U+3000 → 空格，压缩连续空格（计入 normalizedSpaces）
 *   ④ 逐行：trim → 广告 → 导航 → 网址水印 → 页码 → 重复行
 *   ⑤ 谨慎项：去括号内容 / 合并硬换行段落 / 非相邻去重 / 繁简转换
 *   ⑥ 连续空行压缩（≥3 个 \n → 2 个）
 *
 * @param text 原始（已解码）文本
 * @param options 见 CleanOptions；谨慎项默认全关（docs/10 §5.2）
 * @returns `{ text: 清洗后文本, report: CleanReportDetail }`；
 *          report.removedLines 列出每一处被删内容，供 UI「查看被删内容」逐条恢复（docs/10 §5.3）
 * @throws 不抛错；无法执行的项（如未注入繁简转换）记入 report.warnings
 */
export function cleanText(text: string, options?: CleanOptions): { text: string; report: CleanReportDetail } {
  const opts: Required<
    Pick<
      CleanOptions,
      | 'removeAdLines'
      | 'removeNavLines'
      | 'removeUrlWatermark'
      | 'removeDuplicateLines'
      | 'removePageNumberLines'
      | 'protectPureDigitLines'
      | 'removeZeroWidth'
      | 'normalizeFullWidthSpace'
      | 'normalizeNbsp'
      | 'collapseBlankLines'
      | 'trimLines'
      | 'removeNonAdjacentDuplicates'
      | 'mergeHardWrappedLines'
      | 'removeBracketContent'
      | 'traditionalToSimplified'
    >
  > = {
    removeAdLines: options?.removeAdLines ?? true,
    removeNavLines: options?.removeNavLines ?? true,
    removeUrlWatermark: options?.removeUrlWatermark ?? true,
    removeDuplicateLines: options?.removeDuplicateLines ?? true,
    removePageNumberLines: options?.removePageNumberLines ?? true,
    protectPureDigitLines: options?.protectPureDigitLines ?? false,
    removeZeroWidth: options?.removeZeroWidth ?? true,
    normalizeFullWidthSpace: options?.normalizeFullWidthSpace ?? true,
    normalizeNbsp: options?.normalizeNbsp ?? true,
    collapseBlankLines: options?.collapseBlankLines ?? true,
    trimLines: options?.trimLines ?? true,
    removeNonAdjacentDuplicates: options?.removeNonAdjacentDuplicates ?? false,
    mergeHardWrappedLines: options?.mergeHardWrappedLines ?? false,
    removeBracketContent: options?.removeBracketContent ?? false,
    traditionalToSimplified: options?.traditionalToSimplified ?? false,
  }
  const duplicateWindow = Math.max(0, options?.duplicateWindow ?? 5)
  const warnings: string[] = []

  const state: CleanState = {
    removedLines: [],
    removedByReason: emptyByReason(),
    removedLinesTruncated: false,
    maxRemovedLines: Math.max(0, options?.maxRemovedLines ?? 5000),
    suspiciousLines: [],
    maxSuspiciousLines: Math.max(0, options?.maxSuspiciousLines ?? 200),
  }

  // ① 统一换行
  const { text: lfText, replaced: normalizedNewlines } = normalizeNewlinesWithCount(text)
  // BOM 只在首位处理（docs/10 §4.4）；正文中的 U+FEFF 计入零宽字符
  let body = stripBom(lfText)

  // ② 零宽字符
  let removedZeroWidthChars = 0
  if (opts.removeZeroWidth) {
    body = body.replace(ZERO_WIDTH_RE, () => {
      removedZeroWidthChars++
      return ''
    })
  }

  // ③ 空格归一化
  let normalizedSpaces = 0
  if (opts.normalizeNbsp) {
    body = body.replace(/&nbsp;|\u00A0/g, () => {
      normalizedSpaces++
      return ' '
    })
  }
  if (opts.normalizeFullWidthSpace) {
    body = body.replace(/\u3000/g, () => {
      normalizedSpaces++
      return ' '
    })
    body = body.replace(/ {2,}/g, () => {
      normalizedSpaces++
      return ' '
    })
  }

  // ④ 逐行清洗
  const lines = body.split('\n')
  const kept: string[] = []
  const keptIsBlank: boolean[] = []
  /** ±duplicateWindow 内的重复检查窗口：文本 → 最近一次出现的行号 */
  const recent = new Map<string, number>()
  /** 非相邻去重用的全集（谨慎项） */
  const seen = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]!
    const line = opts.trimLines ? raw.trim() : raw

    if (line.length === 0) {
      kept.push('')
      keptIsBlank.push(true)
      continue
    }

    const prevBlank = kept.length === 0 ? true : keptIsBlank[kept.length - 1] === true
    const nextBlank = lines[i + 1] === undefined || lines[i + 1]!.trim().length === 0

    // 广告行
    if (opts.removeAdLines && isAdLine(line)) {
      recordRemoved(state, lineNo, line, 'ad')
      continue
    }
    const adHits = matchAdKeywords(line)
    if (adHits.length > 0) {
      recordSuspicious(state, lineNo, line, `疑似广告行但已保留（命中「${adHits.join('、')}」，行较长）`)
    }

    // 页尾导航行
    if (opts.removeNavLines && isNavLine(line)) {
      recordRemoved(state, lineNo, line, 'nav')
      continue
    }

    // 网址水印行
    if (opts.removeUrlWatermark && isUrlWatermarkLine(line)) {
      recordRemoved(state, lineNo, line, 'url-watermark')
      continue
    }

    // 页码行
    if (
      opts.removePageNumberLines &&
      isPageNumberLine(line, { prevBlank, nextBlank, protectPureDigit: opts.protectPureDigitLines })
    ) {
      recordRemoved(state, lineNo, line, 'page-number')
      continue
    }

    // 重复行（±5 行窗口内完全重复且长度 > 8）
    if (opts.removeDuplicateLines && line.length > 8) {
      const lastSeen = recent.get(line)
      if (lastSeen !== undefined && i - lastSeen <= duplicateWindow) {
        recordRemoved(state, lineNo, line, 'duplicate')
        continue
      }
    }

    // 非相邻重复（谨慎项）
    if (opts.removeNonAdjacentDuplicates && line.length > 8) {
      if (seen.has(line)) {
        recordRemoved(state, lineNo, line, 'non-adjacent-duplicate')
        continue
      }
    }

    if (line.length > 8) {
      recent.set(line, i)
      // 清理窗口外的记录，避免 Map 无限增长（大文件内存）
      if (recent.size > duplicateWindow * 4) {
        for (const [k, v] of recent) {
          if (i - v > duplicateWindow) recent.delete(k)
        }
      }
      seen.set(line, i)
    }

    kept.push(line)
    keptIsBlank.push(false)
  }

  // ⑤ 谨慎项（按 docs/10 §5.2 顺序）
  let mergedHardWrapLines = 0
  let workingLines = kept

  if (opts.removeBracketContent) {
    const after: string[] = []
    for (let i = 0; i < workingLines.length; i++) {
      const line = workingLines[i]!
      if (line.length === 0) {
        after.push(line)
        continue
      }
      const { text: stripped, removed } = stripBracketContent(line)
      if (removed.length > 0) {
        recordRemoved(state, i + 1, removed.join(''), 'bracket-content')
        const trimmed = stripped.trim()
        if (trimmed.length === 0) continue // 整行都是括号内容 → 行消失（已记录）
        after.push(opts.trimLines ? trimmed : stripped)
        continue
      }
      after.push(line)
    }
    workingLines = after
  }

  if (opts.mergeHardWrappedLines) {
    const after: string[] = []
    for (let i = 0; i < workingLines.length; i++) {
      const line = workingLines[i]!
      const next = workingLines[i + 1]
      const canMerge =
        line.length >= 20 &&
        !SENTENCE_END_RE.test(line) &&
        next !== undefined &&
        next.length > 0 &&
        !/^[“”「『"']/.test(next)
      if (canMerge) {
        after.push(line + next)
        mergedHardWrapLines++
        i++ // 吃掉下一行
        continue
      }
      after.push(line)
    }
    workingLines = after
  }

  if (opts.traditionalToSimplified) {
    const converter = options?.traditionalToSimplifiedConverter
    if (converter) {
      workingLines = workingLines.map((l) => (l.length > 0 ? converter(l) : l))
    } else {
      warnings.push('未注入繁简转换实现（生产环境用 opencc-js），该项已跳过，原文保持不变')
    }
  }

  // ⑥ 连续空行压缩
  let collapsedBlankRuns = 0
  let result = workingLines.join('\n')
  if (opts.collapseBlankLines) {
    result = result.replace(/\n{3,}/g, () => {
      collapsedBlankRuns++
      return '\n\n'
    })
  }

  const report: CleanReportDetail = {
    removedAdLines: state.removedByReason.ad,
    removedDuplicateLines: state.removedByReason.duplicate + state.removedByReason['non-adjacent-duplicate'],
    removedPageNumberLines: state.removedByReason['page-number'],
    removedZeroWidthChars,
    normalizedNewlines,
    suspiciousLines: state.suspiciousLines,
    remainingChars: result.length,
    removedLines: state.removedLines,
    removedLinesTruncated: state.removedLinesTruncated,
    removedByReason: state.removedByReason,
    mergedHardWrapLines,
    collapsedBlankRuns,
    normalizedSpaces,
    warnings,
  }
  return { text: result, report }
}
