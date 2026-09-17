/**
 * Novel Studio · 引号与对白解析
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md
 *   · §2.2 引号与对白解析（Step 2）：
 *       1. 检测 “ ” / 「 」 / 『 』 / " " / ‘ ’（按嵌套深度，从内层向外配对）
 *       2. 无引号但匹配 `——对白` → dialogue（破折号对白）
 *       3. 整行以引导语结尾且无引号 → narration
 *       4. 心理描写（心想/暗忖/心道/心中/暗自/默默想）且无引号 → inner
 *       5. 音效提示 `【...】` / `（音效：...）` → sfx_note
 *       6. 引号不配对 → unbalanced=true（进质检 quote_unmatched）
 *   · §2.4 QuoteParseResult 结构
 *
 * 零第三方依赖：引号族取自 constants.ts 的 QUOTE_PAIRS。
 */

import { QUOTE_PAIRS } from '../constants.ts'

// ============================================================================
// 类型
// ============================================================================

/** 一处成对的引号片段（按「闭合顺序」记录，因此天然是最内层优先） */
export interface QuoteSpan {
  /** 引号族标签，如 `“”` / `「」` / `""` */
  style: string
  /** 开引号在文本中的下标 */
  openIndex: number
  /** 闭引号在文本中的下标 */
  closeIndex: number
  /** 引号内的文本（不含引号本身） */
  text: string
  /** 嵌套深度，最外层为 1 */
  depth: number
}

export interface QuoteCue {
  /** 引导动词，如「说道」「问道」 */
  verb: string
  /** 从引导语前提取的人名/代词（启发式，可能为 null，UI 只作预填，需人工确认） */
  speakerHint: string | null
  position: 'before' | 'after' | 'middle'
}

export type QuoteKind = 'dialogue' | 'narration' | 'inner' | 'sfx_note'

export interface QuoteParseResult {
  kind: QuoteKind
  /** 剥离引号后的「可录文本」 */
  text: string
  /** 使用的引号族（无引号时 null） */
  quoteStyle: string | null
  /** 引导语（若有） */
  cue: QuoteCue | null
  /** 引号不配对 */
  unbalanced: boolean
  /** 解析出的引号片段（最内层在前） */
  spans: QuoteSpan[]
}

// ============================================================================
// 引号族索引
// ============================================================================

/** 引号族标签（与 QUOTE_PAIRS 一一对应） */
export const QUOTE_STYLE_LABELS: string[] = QUOTE_PAIRS.map(([o, c]) => `${o}${c}`)

const OPEN_TO_FAMILY = new Map<string, number>()
const CLOSE_TO_FAMILY = new Map<string, number>()
for (let f = 0; f < QUOTE_PAIRS.length; f++) {
  const [open, close] = QUOTE_PAIRS[f]!
  if (!OPEN_TO_FAMILY.has(open)) OPEN_TO_FAMILY.set(open, f)
  if (!CLOSE_TO_FAMILY.has(close)) CLOSE_TO_FAMILY.set(close, f)
}

/** 所有引号字符（用于 stripQuotes） */
export const ALL_QUOTE_CHARS: string[] = Array.from(
  new Set(QUOTE_PAIRS.flatMap(([o, c]) => [o, c])),
)

/** 引导动词表：长词在前，避免「低声说道」被「说道」先吃掉 */
export const CUE_VERBS: string[] = [
  '低声说道', '低声说', '轻声说道', '轻声说', '冷冷说道', '冷笑道', '笑着说道', '笑着说',
  '大声说道', '大声喊', '沉声说道', '缓缓说道', '开口说道', '回答道', '回答说', '喃喃说道',
  '嘟囔道', '咕哝道', '自语道', '吼道', '怒道', '骂道', '喊道', '问道', '答道', '念道',
  '说道', '问道', '讲道', '叫道', '接过话', '插嘴道', '接口道', '接着说',
  '说', '道', '问', '喊', '叫', '答', '念', '吼', '骂',
]

const CUE_VERB_RE = new RegExp(CUE_VERBS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))

/** 心理描写线索词（docs/11 §2.2 第 4 步） */
const INNER_HINTS = ['心想', '暗忖', '心道', '心中', '暗自', '默默想', '心里想', '心底', '内心']

/** 对白里出现这些时不算「引导语结尾的叙述」（docs/11 §2.2 第 3 步的反向判断） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/

// ============================================================================
// 引号配对
// ============================================================================

/**
 * 扫描并配对引号（docs/11 §2.2 第 1 步）。
 *
 * 算法：单趟扫描 + 栈。
 *   · 当前字符等于栈顶族的闭引号 → 闭合，记录 span（因此结果是「最内层在前」）
 *   · 否则当前字符是某族的开引号 → 入栈
 *   · 否则若是闭引号但栈顶不匹配 → 记为游离闭引号（unbalanced）
 * 直引号 `"`（开=闭）也能正确配对：先判闭合、再判开启。
 *
 * @param text 单行文本
 * @returns spans（最内层在前）、unbalanced 标记、以及**未闭合的开引号**列表
 *          （未闭合时仍要让 UI 知道这行是台词，见 parseQuote）
 */
export function collectQuoteSpans(text: string): { spans: QuoteSpan[]; unbalanced: boolean; unclosed: QuoteSpan[] } {
  const spans: QuoteSpan[] = []
  const stack: Array<{ family: number; index: number }> = []
  let stray = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const top = stack[stack.length - 1]
    if (top !== undefined && QUOTE_PAIRS[top.family]![1] === ch) {
      stack.pop()
      spans.push({
        style: QUOTE_STYLE_LABELS[top.family]!,
        openIndex: top.index,
        closeIndex: i,
        text: text.slice(top.index + 1, i),
        depth: stack.length + 1,
      })
      continue
    }
    const family = OPEN_TO_FAMILY.get(ch)
    if (family !== undefined) {
      stack.push({ family, index: i })
      continue
    }
    if (CLOSE_TO_FAMILY.has(ch)) stray++
  }
  // 未闭合的开引号：closeIndex = -1，text 为开到行尾的内容
  const unclosed: QuoteSpan[] = stack.map((s) => ({
    style: QUOTE_STYLE_LABELS[s.family]!,
    openIndex: s.index,
    closeIndex: -1,
    text: text.slice(s.index + 1),
    depth: 1,
  }))
  return { spans, unbalanced: stray > 0 || stack.length > 0, unclosed }
}

/**
 * 每行使用的主要引号族（取最外层 span 的族）。
 * @returns 引号族标签；无引号时 null
 */
export function detectQuoteStyle(spans: QuoteSpan[]): string | null {
  if (spans.length === 0) return null
  let outermost = spans[0]!
  for (const s of spans) {
    if (s.depth < outermost.depth) outermost = s
  }
  return outermost.style
}

/**
 * 去掉文本里所有引号字符（成对或不配对都只删引号本身，不动引号内的文字）。
 * @param text 原文
 * @returns 去掉引号后的文本
 */
export function stripQuotes(text: string): string {
  let out = ''
  for (const ch of text) {
    if (!ALL_QUOTE_CHARS.includes(ch)) out += ch
  }
  return out
}

// ============================================================================
// 引导语提取
// ============================================================================

/** 从动词前的连续汉字里取人名（纯粹启发式，见下方说明） */
function guessSpeaker(before: string): string | null {
  let i = before.length
  while (i > 0 && CJK_RE.test(before[i - 1]!)) i--
  const run = before.slice(i)
  if (run.length === 0 || run.length > 4) return null
  return run
}

/**
 * 提取引导语（docs/11 §2.2 第 2~3 步、docs/10 §7.1）。
 *
 * 位置判定：
 *   · 有引号片段时：动词在第一个引号之前 → `before`；在最后一个引号之后 → `after`；
 *     夹在两个片段之间 → `middle`
 *   · 无引号（破折号对白等）时：动词落在文本后 40% 视为 `after`，否则 `before`
 *
 * speakerHint 是启发式：取动词前连续汉字（≤ 4 字），拿不到就返回 null ——
 * 宁可返回 null 也不要给 UI 一个错误的说话人（docs/11 §4.2 置信度分档，
 * 说话人判定最终由画本生成链路决定，这里只做预填）。
 *
 * @param text 单行文本
 * @param spans collectQuoteSpans 的结果
 * @returns 引导语；没有引导动词时 null
 */
export function extractCue(text: string, spans: QuoteSpan[]): QuoteCue | null {
  const m = CUE_VERB_RE.exec(text)
  if (!m) return null
  const verb = m[0]
  const at = m.index
  const speakerHint = guessSpeaker(text.slice(0, at))

  if (spans.length > 0) {
    const sorted = [...spans].sort((a, b) => a.openIndex - b.openIndex)
    const firstOpen = sorted[0]!.openIndex
    const lastClose = sorted[sorted.length - 1]!.closeIndex
    let position: QuoteCue['position']
    if (at < firstOpen) position = 'before'
    else if (at > lastClose) position = 'after'
    else position = 'middle'
    return { verb, speakerHint, position }
  }
  const position: QuoteCue['position'] = at >= Math.floor(text.length * 0.6) ? 'after' : 'before'
  return { verb, speakerHint, position }
}

// ============================================================================
// 主入口
// ============================================================================

const SFX_SQUARE_RE = /^【.*】$/
const SFX_SQUARE_ALT_RE = /^\[.*\]$/
const SFX_PAREN_RE = /^[（(]\s*音效\s*[:：].*[）)]$/
const DASH_DIALOGUE_RE = /^[—–-]{1,2}\s*/

/**
 * 解析一行文本的引号与对白（docs/11 §2.2 的 6 步处理顺序）。
 *
 * @param text 单行文本
 * @returns QuoteParseResult：kind / 剥离引号后的可录文本 / 引号族 / 引导语 / unbalanced
 *          · `text` 在有多处顶层引号时按出现顺序拼接（如 `「你好」「再见」` → `你好再见`）
 *          · `unbalanced=true` 时仍返回已解析出的内容，由质检标 `quote_unmatched`
 */
export function parseQuote(text: string): QuoteParseResult {
  const trimmed = text.trim()
  const { spans, unbalanced, unclosed } = collectQuoteSpans(trimmed)
  const style = detectQuoteStyle(spans)

  // ⑤ 音效提示（先于对白判定：`【音效】` 形式本身可能就是对话行）
  if (SFX_SQUARE_RE.test(trimmed) && spans.length === 0) {
    return { kind: 'sfx_note', text: trimmed.slice(1, -1).trim(), quoteStyle: null, cue: null, unbalanced, spans }
  }
  if (SFX_PAREN_RE.test(trimmed) || SFX_SQUARE_ALT_RE.test(trimmed)) {
    return {
      kind: 'sfx_note',
      text: trimmed.replace(/^[（(\[]\s*(音效\s*[:：]\s*)?/, '').replace(/[）)\]]$/, '').trim(),
      quoteStyle: null,
      cue: null,
      unbalanced,
      spans,
    }
  }

  // ① 有引号 → 台词
  if (spans.length > 0) {
    const topLevel = spans.filter((s) => s.depth === 1)
    const source = topLevel.length > 0 ? topLevel : [...spans].sort((a, b) => a.openIndex - b.openIndex)
    const ordered = [...source].sort((a, b) => a.openIndex - b.openIndex)
    const inner = ordered.map((s) => s.text).join('').trim()
    return {
      kind: 'dialogue',
      text: inner.length > 0 ? inner : stripQuotes(trimmed).trim(),
      quoteStyle: style,
      cue: extractCue(trimmed, spans),
      unbalanced,
      spans,
    }
  }

  // ② 未闭合的开引号（如整行只有左引号）仍按台词处理，并标 unbalanced（docs/11 §2.2 第 6 步）
  if (spans.length === 0 && unclosed.length > 0) {
    const first = unclosed[0]!
    return {
      kind: 'dialogue',
      text: first.text.trim(),
      quoteStyle: first.style,
      cue: extractCue(trimmed, unclosed),
      unbalanced: true,
      spans: unclosed,
    }
  }

  // ③ 破折号对白
  const dash = DASH_DIALOGUE_RE.exec(trimmed)
  if (dash && trimmed.slice(dash[0].length).trim().length > 0) {
    return {
      kind: 'dialogue',
      text: trimmed.slice(dash[0].length).trim(),
      quoteStyle: null,
      cue: extractCue(trimmed, spans),
      unbalanced,
      spans,
    }
  }

  // ④ 心理描写（无引号）
  if (INNER_HINTS.some((h) => trimmed.includes(h))) {
    return { kind: 'inner', text: trimmed, quoteStyle: null, cue: extractCue(trimmed, spans), unbalanced, spans }
  }

  // ⑤ 其余为叙述（含「整行以引导语结尾」的情况，如「他说道。」）
  return { kind: 'narration', text: trimmed, quoteStyle: null, cue: extractCue(trimmed, spans), unbalanced, spans }
}

/**
 * 计算文本每个位置的引号嵌套深度（0 = 不在引号内）。
 * 供 sentence.ts 判断「引号内不切分」使用（docs/11 §2.1）。
 * @param text 单段文本（不要跨段落，段落边界会重置引号状态）
 * @returns 长度与 text 相同的深度数组
 */
export function quoteDepthMap(text: string): number[] {
  const depth = new Array<number>(text.length).fill(0)
  const stack: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const top = stack[stack.length - 1]
    if (top !== undefined && QUOTE_PAIRS[top]![1] === ch) {
      stack.pop()
      depth[i] = stack.length
      continue
    }
    const family = OPEN_TO_FAMILY.get(ch)
    if (family !== undefined) {
      stack.push(family)
      depth[i] = stack.length
      continue
    }
    depth[i] = stack.length
  }
  return depth
}
