/**
 * Novel Studio · 切句
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md §2.1 切句规则（Step 1）
 *
 * ```
 * 主切分：句末标点 。 ！ ？ … ；(弱)
 * 次切分：若单句 > maxLineChars（默认 120）→ 在逗号/破折号处二次切（优先取靠中间的）
 * 不分切：引号内部即使有逗号也不切（保持台词完整）
 * 不断开：引号对内部、书名号内部、括号内部
 * 段落边界：空行 → 强制断行，且该行 pauseAfterMs 加长（段落留白）
 * ```
 *
 * 另外两个实现细节（文档未写，但必须定死，否则偏移量会对不上）：
 *   · 单个换行也强制断行 —— TXT 小说里「一行即一段」，按 \n 切开才能让每段独立成行；
 *     同时段落边界重置引号状态（避免一处不配对引号污染后面所有段落）。
 *   · 输出 `{ text, start, end }` 满足 `input.slice(start, end) === text`
 *     （首尾空白已通过调整偏移量裁掉，而不是只裁剪字符串）。
 *
 * 零第三方依赖。
 */

import { CANVAS_DEFAULTS } from '../constants.ts'
import { quoteDepthMap } from './quote.ts'

// ============================================================================
// 类型
// ============================================================================

export interface SentencePiece {
  text: string
  /** 在输入 text 中的起始下标（含） */
  start: number
  /** 在输入 text 中的结束下标（不含）；满足 input.slice(start, end) === text */
  end: number
}

export interface SplitSentencesOptions {
  /** 单行最大字数（docs/11 §2.1，默认 CANVAS_DEFAULTS.maxLineChars = 120） */
  maxLineChars?: number
}

// ============================================================================
// 常量
// ============================================================================

/** 主切分标点（。！？…；以及英文等价形式） */
const SENTENCE_END_CHARS = new Set(['。', '！', '？', '；', '…', '!', '?', ';'])

/** 次切分标点（逗号、顿号、破折号；docs/11 §2.1「在逗号/破折号处二次切」） */
const SECONDARY_BREAK_CHARS = new Set(['，', '、', ',', '—', '－'])

/** 句末标点后可能紧跟的收尾符号，必须一起带走（否则会留在下一行开头） */
const TRAILING_CHARS = new Set(['”', '’', '」', '』', '）', ')', '】', '》', '〉', '…', '.', '"', "'"])

/** 空白字符（切分后需要从片段首尾裁掉，并同步调整偏移量） */
const SPACE_RE = /[ \t\u3000\u00a0\u200b]/

/** 括号族：括号内部不断开（docs/11 §2.1「不断开：书名号内部、括号内部」） */
const BRACKET_OPENERS = new Set(['（', '(', '【', '《', '〈', '〔', '[', '｛', '{'])
const BRACKET_CLOSERS = new Set(['）', ')', '】', '》', '〉', '〕', ']', '｝', '}'])

/**
 * 计算「不可切分」位置：引号内部 + 括号/书名号内部（docs/11 §2.1）。
 * 开括号与闭括号本身也标记为不可切分，避免把标点留在下一行开头。
 * @param slice 单段文本（不跨段落）
 * @returns 长度与 slice 相同的布尔数组，true = 该位置不许断开
 */
export function protectedPositionMap(slice: string): boolean[] {
  const depth = quoteDepthMap(slice)
  const flags = new Array<boolean>(slice.length).fill(false)
  let bracket = 0
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!
    if (BRACKET_OPENERS.has(ch)) {
      bracket++
      flags[i] = true
      continue
    }
    if (BRACKET_CLOSERS.has(ch)) {
      flags[i] = true
      if (bracket > 0) bracket--
      continue
    }
    flags[i] = depth[i]! > 0 || bracket > 0
  }
  return flags
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 把一段章节正文切成画本用的句子片段（docs/11 §2.1）。
 *
 * 规则：
 *   1. 换行强制断行（段落边界），并在每段内独立计算引号嵌套（避免脏引号跨段污染）
 *   2. 段内：在引号外的句末标点处切分；标点后紧跟的 `”」』）】…` 一并归入前一句
 *   3. 超长句（> maxLineChars）在逗号/破折号处二次切分，优先取靠句子中间的断点；
 *      递归进行，直到每片都不超限；若整句没有可用断点，则在 maxLineChars 处硬切
 *      （避免产出超长行 —— 超长行会导致「录的时候忘词、对轨波形方块过大」，docs/11 §2.1）
 *
 * @param text 章节正文（可含换行）
 * @param opts.maxLineChars 单行最大字数，默认 120
 * @returns 片段数组，按出现顺序；每片的 start/end 为原文本偏移（`slice` 严格相等）
 */
export function splitSentences(text: string, opts?: SplitSentencesOptions): SentencePiece[] {
  const maxLineChars = Math.max(1, opts?.maxLineChars ?? CANVAS_DEFAULTS.maxLineChars)
  const out: SentencePiece[] = []
  if (text.length === 0) return out

  // 段落切分（保留绝对偏移）：每个 \n 都是硬断行（TXT 里一行即一段）
  const paragraphs: Array<{ start: number; end: number }> = []
  let segStart = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    paragraphs.push({ start: segStart, end: i })
    segStart = i + 1
  }
  if (segStart < text.length) paragraphs.push({ start: segStart, end: text.length })
  if (paragraphs.length === 0) paragraphs.push({ start: 0, end: text.length })

  for (const para of paragraphs) {
    if (para.end <= para.start) continue
    const slice = text.slice(para.start, para.end)
    // 引号与括号内部不许断开；段内独立计算，避免脏引号跨段污染
    const protectedMap = protectedPositionMap(slice)

    // 先按主标点切
    const cuts: Array<{ start: number; end: number }> = []
    let cursor = 0
    for (let i = 0; i < slice.length; i++) {
      if (protectedMap[i]) continue // 引号/括号内不切
      if (!SENTENCE_END_CHARS.has(slice[i]!)) continue
      let end = i + 1
      // 把连排的省略号/句点、以及收尾引号括号一起带走
      while (end < slice.length && TRAILING_CHARS.has(slice[end]!)) end++
      if (end > cursor) cuts.push({ start: cursor, end })
      cursor = end
      i = end - 1
    }
    if (cursor < slice.length) cuts.push({ start: cursor, end: slice.length })

    for (const cut of cuts) {
      const absStart = para.start + cut.start
      const absEnd = para.start + cut.end
      pushTrimmed(out, text, absStart, absEnd)
      // 超长 → 二次切分
      const piece = out[out.length - 1]
      if (piece && piece.end - piece.start > maxLineChars) {
        out.pop()
        splitTooLong(out, text, piece.start, piece.end, maxLineChars, protectedMap, para.start)
      }
    }
  }
  return out
}

/** 裁掉片段首尾空白并同步偏移量，然后推入结果（空片段丢弃） */
function pushTrimmed(out: SentencePiece[], text: string, start: number, end: number): void {
  let s = start
  let e = end
  while (s < e && SPACE_RE.test(text[s]!)) s++
  while (e > s && SPACE_RE.test(text[e - 1]!)) e--
  if (e <= s) return
  out.push({ text: text.slice(s, e), start: s, end: e })
}

/**
 * 超长片段的二次切分（docs/11 §2.1）：在逗号/破折号处切，优先取靠中间的断点。
 * 左右两侧都递归处理，保证**每一片都不超过 maxLineChars**。
 * protectedMap 为「整段」的不可切分位置（下标相对段首）。
 *
 * 说明：长度以 UTF-16 码元计（与全仓库 charCount 口径一致），
 * 但硬切时会避开代理对中间，绝不会把 emoji 拆成两个孤立代理项。
 */
function splitTooLong(
  out: SentencePiece[],
  text: string,
  start: number,
  end: number,
  maxLineChars: number,
  protectedMap: boolean[],
  paraStart: number,
): void {
  if (end - start <= maxLineChars) {
    pushTrimmed(out, text, start, end)
    return
  }
  const mid = (start + end) / 2
  // 找候选断点：引号/括号外的逗号、顿号、破折号
  const candidates: Array<{ cutAfter: number; distance: number }> = []
  for (let i = start; i < end - 1; i++) {
    const local = i - paraStart
    if (local >= 0 && local < protectedMap.length && protectedMap[local]) continue
    const ch = text[i]!
    if (!SECONDARY_BREAK_CHARS.has(ch)) continue
    let cutAfter = i + 1
    // 破折号成对（——）：一起吃掉
    while (cutAfter < end && SECONDARY_BREAK_CHARS.has(text[cutAfter]!)) cutAfter++
    candidates.push({ cutAfter, distance: Math.abs(cutAfter - mid) })
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.distance - b.distance || a.cutAfter - b.cutAfter)
    const best = candidates[0]!
    if (best.cutAfter > start && best.cutAfter < end) {
      splitTooLong(out, text, start, best.cutAfter, maxLineChars, protectedMap, paraStart)
      splitTooLong(out, text, best.cutAfter, end, maxLineChars, protectedMap, paraStart)
      return
    }
  }
  // 没有可用断点 → 硬切（不切坏代理对）
  let cut = start + maxLineChars
  if (cut >= end) cut = end
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff && cut < end) cut++
  pushTrimmed(out, text, start, cut)
  splitTooLong(out, text, cut, end, maxLineChars, protectedMap, paraStart)
}

/**
 * 只取片段文本（UI 预览与报告用）。
 * @param text 章节正文
 * @param maxLineChars 单行最大字数
 * @returns 每片的文本
 */
export function splitSentenceTexts(text: string, maxLineChars?: number): string[] {
  return splitSentences(text, { maxLineChars }).map((p) => p.text)
}
