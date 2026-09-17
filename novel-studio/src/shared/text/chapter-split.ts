/**
 * Novel Studio · 分章（切章规则引擎 + 备选策略 + 正则安全校验）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §6.1 规则集结构（linePattern / maxLineLength / requireBlankAround / titleGroup / kind）
 *   · §6.2 内置规则（constants.ts 的 BUILTIN_RULE_SETS）
 *   · §6.3 匹配算法与边界校验（宁可漏切、不可错切）
 *   · §6.4 备选分章策略（按空行块 / 按长度均分 / 整本一章）
 *   · §6.5 自定义正则的安全校验（拒绝灾难性回溯，100 ms 超时保护）
 *   · §6.6 ChapterDraft 结构
 *   · §7.1 章节号规范化（「一二三」「123」「零一二」→ index）与人工干预（合并/拆分/排序）
 *   · §10 错误码 NO_CHAPTER_MATCHED / CHAPTER_SPLIT_SUSPICIOUS / RULE_PATTERN_*
 *
 * 零第三方依赖：只用 `node:perf_hooks` 计时，其余全是自实现纯逻辑。
 */

import { performance } from 'node:perf_hooks'

import type { ChapterDraft, ChapterKind, ChapterRule, ChapterRuleSet } from '../types.ts'
import { VAD_DEFAULTS } from '../constants.ts'
import { AppError } from '../errors.ts'

// ============================================================================
// 类型
// ============================================================================

export type SplitStrategy = 'rules' | 'blank-blocks' | 'length' | 'single' | 'headings' | 'none'
export type FallbackStrategy = 'blank-blocks' | 'length' | 'single' | 'none' | 'auto'

export interface SplitOptions {
  /** 两候选边界之间字数小于它 → 后者视为误切并合并（docs/10 §6.3，默认 50） */
  minChapterChars?: number
  /** 首个边界之前的文本大于它 → 作为「前言」保留为一章（默认 200） */
  frontMatterMinChars?: number
  /** 最后一个边界产生的章正文小于它 → 并入上一章（默认 200，docs/10 §6.3「末章」） */
  tailMinChars?: number
  /** 单条正则的匹配耗时预算（毫秒，默认 100，docs/10 §6.5） */
  matchTimeoutMs?: number
  /** 全部匹配的累计耗时预算（毫秒，默认 10000）；超出即抛 RULE_PATTERN_UNSAFE */
  totalMatchBudgetMs?: number
  /** 估算时长用（字/秒，默认 VAD_DEFAULTS.charsPerSecond = 4.2） */
  charsPerSecond?: number
  /** 卷标题是否单独作为一章输出（默认 false：只作层级标记，不切章，docs/10 §6.3） */
  emitVolumes?: boolean
  /** 无匹配时的备选策略；'none' = 返回空数组，由调用方抛 NO_CHAPTER_MATCHED（默认） */
  fallback?: FallbackStrategy
  /** 备选策略参数（fallback 生效时使用） */
  fallbackOptions?: FallbackOptions
}

export interface SplitWarning {
  code:
    | 'pattern-invalid'
    | 'pattern-unsafe'
    | 'match-timeout'
    | 'index-regression'
    | 'merged-candidate'
    | 'no-match'
  message: string
  ruleId?: string
  lineNo?: number
}

export interface SplitResult {
  drafts: ChapterDraft[]
  strategy: SplitStrategy
  /** 命中的规则 id（去重，按首次命中顺序） */
  matchedRuleIds: string[]
  /** 候选边界总数（合并前） */
  candidateCount: number
  /** 因「间距过近」被合并掉的候选数 */
  mergedCount: number
  /** 卷层级标记（emitVolumes=false 时卷不产章，但记录在此） */
  volumes: Array<{ index: number; title: string; startOffset: number }>
  warnings: SplitWarning[]
}

export interface FallbackOptions {
  /** 按空行块：块长小于它则与相邻块合并（默认 100，docs/10 §6.4） */
  minBlockChars?: number
  /** 按长度：每多少字切一块（默认 3000，docs/10 §6.4） */
  charsPerChunk?: number
  /** 估算时长用（字/秒） */
  charsPerSecond?: number
  /** 自动生成的标题模板，`{n}` 会被替换为序号（默认「第{n}部分」） */
  titlePrefix?: string
}

/** 正则安全校验结果；code 用于选择错误码（RULE_PATTERN_INVALID / RULE_PATTERN_UNSAFE） */
export interface PatternValidation {
  ok: boolean
  error?: string
  code?: 'RULE_PATTERN_INVALID' | 'RULE_PATTERN_UNSAFE'
}

interface RawChapter {
  title: string
  kind: ChapterKind
  startOffset: number
  endOffset: number
  rawText: string
}

interface TextLine {
  index: number
  text: string
  /** 行首在全文中的偏移 */
  start: number
  /** 行尾（不含换行符）在全文中的偏移 */
  end: number
}

interface CompiledRule {
  rule: ChapterRule
  regex: RegExp | null
  rejected: boolean
}

interface Candidate {
  lineIndex: number
  lineStart: number
  lineEnd: number
  ruleId: string
  title: string
  kind: ChapterKind
}

// ============================================================================
// 正则安全校验（docs/10 §6.5）
// ============================================================================

/** 内联标志前缀，如 `(?i)`；JS 引擎不支持内联标志，需转成 RegExp flags */
const INLINE_FLAG_PREFIX = /^\(\?([ims]+)\)/

/** 允许的 RegExp flags（JS） */
const ALLOWED_FLAGS = 'imsu'

/** 裸行模式的最大长度（防止有人把整篇文本粘进来当规则） */
const MAX_PATTERN_LENGTH = 2000

/** 有界重复 {m,n} 的上限（超过它视为误用） */
const MAX_BOUNDED_REPEAT = 1000

/** 捕获组 + 紧跟量词 */
const QUANTIFIED_GROUP = /\(((?:\\.|[^()\\])*)\)(?:[*+]|\{\d+,\d*\})/g

/** 组内的量词（用于识别嵌套量词，如 `(a+)+`、`(.*)*`） */
const INNER_QUANTIFIER = /(?:\\.|[^()\\])[*+?]|\{\d+,\d*\}/g

/** 有界重复 */
const BOUNDED_REPEAT = /\{\s*(\d+)\s*(?:,\s*(\d*)\s*)?\}/g

/**
 * 把规则里写的内联标志（`(?i)`，PCRE/RE2 风格，见 constants.ts 的 `en-chapter`）
 * 转成 JS 的 RegExp flags，并剥掉该前缀。
 *
 * 说明：`constants.ts` 的 `BUILTIN_RULE_SETS` 里 `en-chapter` 写的是
 * `(?i)chapter\s+[\dIVXLC]+\.?.*`，在 JS 里 `new RegExp` 会抛 “Invalid group”。
 * 契约文件由上游维护、不可修改，所以由本模块兼容这一写法。
 */
export function normalizePatternFlags(pattern: string): { source: string; flags: string } {
  let source = pattern
  let flags = ''
  for (;;) {
    const m = INLINE_FLAG_PREFIX.exec(source)
    if (!m) break
    for (const ch of m[1]!) {
      if (ALLOWED_FLAGS.includes(ch) && !flags.includes(ch)) flags += ch
    }
    source = source.slice(m[0].length)
  }
  return { source, flags }
}

/**
 * 正则安全校验（docs/10 §6.5）：拒绝灾难性回溯模式与非法正则。
 *
 * 判定顺序：
 *   1. 空 / 超长 → `RULE_PATTERN_INVALID`
 *   2. 编译失败 → `RULE_PATTERN_INVALID`（reason 带引擎原文）
 *   3. 嵌套量词（`(a+)+`、`(.*)*`）→ `RULE_PATTERN_UNSAFE`
 *   4. 被量词包裹且含「单字符/空」分支的择一（`(a|a)*`、`(a|)*`）→ `RULE_PATTERN_UNSAFE`
 *   5. 重复上界过大（`{1,100000}`）→ `RULE_PATTERN_UNSAFE`
 *
 * 诚实说明：完整的灾难性回溯判定需要 re2 之类引擎（docs/10 §6.5 原文）。
 * 无网络环境下只能做启发式 + 事后耗时检测，这里是「宁可拒绝」的保守实现。
 *
 * @param pattern 正则源串（不含首尾锚点；引擎会自动补 `^\s*(?:…)\s*$`）
 * @returns ok=true 表示可安全使用；否则 error 可直接作为 AppError 的 `reason` 参数
 */
export function validateLinePattern(pattern: string): PatternValidation {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return { ok: false, error: '正则表达式不能为空', code: 'RULE_PATTERN_INVALID' }
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      error: `正则过长（${pattern.length} 字符，上限 ${MAX_PATTERN_LENGTH}）`,
      code: 'RULE_PATTERN_INVALID',
    }
  }
  const { source, flags } = normalizePatternFlags(pattern)
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, flags)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `正则语法错误：${reason}`, code: 'RULE_PATTERN_INVALID' }
  }

  QUANTIFIED_GROUP.lastIndex = 0
  for (;;) {
    const m = QUANTIFIED_GROUP.exec(source)
    if (!m) break
    const body = m[1] ?? ''
    INNER_QUANTIFIER.lastIndex = 0
    if (INNER_QUANTIFIER.test(body)) {
      return {
        ok: false,
        error: `存在嵌套量词（如 (a+)+ / (.*)*）：「(${body})」`,
        code: 'RULE_PATTERN_UNSAFE',
      }
    }
    if (body.includes('|')) {
      const branches = body.split('|')
      const risky = branches.some((b) => b.length <= 1)
      if (risky) {
        return {
          ok: false,
          error: `被量词包裹的择一分支可能匹配空串或单字符（如 (a|)*）：「(${body})」`,
          code: 'RULE_PATTERN_UNSAFE',
        }
      }
    }
  }

  BOUNDED_REPEAT.lastIndex = 0
  for (;;) {
    const m = BOUNDED_REPEAT.exec(source)
    if (!m) break
    const min = Number(m[1])
    const max = m[2] === undefined || m[2] === '' ? min : Number(m[2])
    if (min > MAX_BOUNDED_REPEAT || max > MAX_BOUNDED_REPEAT) {
      return {
        ok: false,
        error: `重复次数上限过大（{${m[1]},${m[2] ?? ''}}，上限 ${MAX_BOUNDED_REPEAT}）`,
        code: 'RULE_PATTERN_UNSAFE',
      }
    }
  }
  return { ok: true }
}

/**
 * 校验并在不安全时抛业务异常（供 import.service 与 UI 复用）。
 * @throws AppError `RULE_PATTERN_INVALID`（语法问题）或 `RULE_PATTERN_UNSAFE`（回溯风险）
 */
export function assertLinePatternSafe(pattern: string): void {
  const v = validateLinePattern(pattern)
  if (v.ok) return
  throw new AppError(v.code ?? 'RULE_PATTERN_INVALID', { params: { reason: v.error ?? '未知原因' } })
}

/**
 * 把规则编译成带首尾锚点的正则（docs/10 §6.1：引擎自动加 `^...$` 并允许前后空白）。
 * @returns 编译结果；不安全或语法错误时 regex=null，rejected=true（调用方应记 warning 并跳过）
 */
export function compileChapterRule(rule: ChapterRule): CompiledRule {
  const v = validateLinePattern(rule.linePattern)
  if (!v.ok) return { rule, regex: null, rejected: true }
  const { source, flags } = normalizePatternFlags(rule.linePattern)
  try {
    return { rule, regex: new RegExp(`^\\s*(?:${source})\\s*$`, flags), rejected: false }
  } catch {
    return { rule, regex: null, rejected: true }
  }
}

export interface MatchOutcome {
  matched: boolean
  title: string | null
  elapsedMs: number
  /** 单次匹配耗时超出预算（只能事后发现，见下方说明） */
  timedOut: boolean
}

/**
 * 带耗时预算的正则匹配。
 *
 * 诚实说明：JS 的正则执行**无法被抢占式中断**，所以「100 ms 超时」只能事后发现
 * （测量本次 exec 的耗时）。真正的防线是 `validateLinePattern` 的静态拒绝；
 * 本函数保证一旦某条规则超预算就停用它并记 warning（docs/10 §6.5），
 * 而不是让整本导入无声卡死。
 *
 * @param regex 已编译正则
 * @param input 单行文本（trim 后）
 * @param titleGroup 标题提取组（0 = 整个匹配）
 * @param budgetMs 耗时预算
 */
export function matchWithBudget(
  regex: RegExp,
  input: string,
  titleGroup: number,
  budgetMs: number,
): MatchOutcome {
  const t0 = performance.now()
  const m = regex.exec(input)
  const elapsedMs = performance.now() - t0
  const timedOut = elapsedMs > budgetMs
  if (!m) return { matched: false, title: null, elapsedMs, timedOut }
  const picked = m[titleGroup] ?? m[0]
  return { matched: true, title: (picked ?? '').trim(), elapsedMs, timedOut }
}

// ============================================================================
// 章节号规范化（docs/10 §7.1）
// ============================================================================

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
}

const CN_UNITS: Record<string, number> = {
  十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000,
  万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000,
}

const CN_NUMBER_CHARS = Object.keys(CN_DIGITS).join('') + Object.keys(CN_UNITS).join('')

/**
 * 中文数字 / 阿拉伯数字 → 整数。
 * 支持：「一二三」→123（逐字位）、「零一二」→12（前导零忽略）、「第十」→10、
 * 「二十三」→23、「一百零八」→108、「一万二千三百四十五」→12345、「12」→12。
 * @param input 数字片段（不含「第」「章」等）
 * @returns 解析出的数字；含未知字符或超范围（> 100 万）时 null
 */
export function parseChineseNumber(input: string): number | null {
  const s = input.trim()
  if (s.length === 0) return null
  if (/^[0-9]+$/.test(s)) {
    const n = Number.parseInt(s, 10)
    return Number.isFinite(n) && n <= 1_000_000 ? n : null
  }
  const hasUnit = [...s].some((ch) => CN_UNITS[ch] !== undefined)
  if (!hasUnit) {
    // 逐字位写法：零一二 → 012 → 12
    let digits = ''
    for (const ch of s) {
      const d = CN_DIGITS[ch]
      if (d === undefined) return null
      digits += String(d)
    }
    const n = Number.parseInt(digits, 10)
    return Number.isFinite(n) && n <= 1_000_000 ? n : null
  }
  let total = 0
  let section = 0
  let number = 0
  for (const ch of s) {
    const d = CN_DIGITS[ch]
    if (d !== undefined) {
      number = d
      continue
    }
    const u = CN_UNITS[ch]
    if (u === undefined) return null
    if (u < 10000) {
      // 「十二」这种省略了「一」的写法：number 为 0 时按 1 算
      section += (number === 0 ? 1 : number) * u
    } else {
      section = (section + number) * u
      total += section
      section = 0
    }
    number = 0
  }
  const result = total + section + number
  return result >= 0 && result <= 1_000_000 ? result : null
}

/** 去掉标题外层的装饰符号，便于提取章节号 */
function unwrapTitle(title: string): string {
  return title
    .trim()
    .replace(/^[【\[（(《<「『]+/, '')
    .replace(/[】\]）)》)」》>]+$/, '')
    .trim()
}

const CHAPTER_NUMBER_PATTERNS: RegExp[] = [
  // 第X章 / 第X节 / 第X回 / 第X卷 / 第X部 / 第X篇 / 第X话 / 第X集
  new RegExp(`第\\s*([0-9]+|[${CN_NUMBER_CHARS}]+)\\s*[章节節回卷部篇话話集]?`),
  // 番外一 / 外传三
  new RegExp(`(?:番外|外传|外傳|前传|前傳)\\s*([0-9]+|[${CN_NUMBER_CHARS}]+)`),
]

const LEADING_NUMBER = new RegExp(`^([0-9]+|[${CN_NUMBER_CHARS}]+)(?=[\\s、.．:：\\-—]|$)`)
const PURE_NUMBER = new RegExp(`^(?:[0-9]+|[${CN_NUMBER_CHARS}]+)$`)

/**
 * 从章节标题里解析章节号（docs/10 §7.1：识别「一二三」「123」「零一二」并统一为 index）。
 *
 * 支持形态：
 *   · 第X章 / 第X节 / 第五回 / 第二卷 / 第12话 / 番外三
 *   · 纯数字标题（'12'）、数字+分隔（'12 开始'）、纯中文数字（'一二三'）
 * @param title 章节标题原文
 * @returns 章节号（≥0）；无法解析（如「楔子」「序章」「大结局」）返回 null
 */
export function parseChapterIndex(title: string): number | null {
  const clean = unwrapTitle(title)
  if (clean.length === 0) return null
  for (const re of CHAPTER_NUMBER_PATTERNS) {
    const m = re.exec(clean)
    if (m?.[1]) {
      const n = parseChineseNumber(m[1])
      if (n !== null) return n
    }
  }
  if (PURE_NUMBER.test(clean)) return parseChineseNumber(clean)
  const lead = LEADING_NUMBER.exec(clean)
  if (lead?.[1]) return parseChineseNumber(lead[1])
  return null
}

// ============================================================================
// 通用小工具
// ============================================================================

/** 估算录音时长（docs/10 §6.6：charCount / defaultCharsPerSec * 1000） */
export function estimateDurationMs(charCount: number, charsPerSecond?: number): number {
  const cps = charsPerSecond && charsPerSecond > 0 ? charsPerSecond : VAD_DEFAULTS.charsPerSecond
  return Math.round((charCount / cps) * 1000)
}

/** 把文本切成带偏移的行（end 不含换行符） */
export function splitLinesWithOffsets(text: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  let index = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) {
      lines.push({ index, text: text.slice(start), start, end: text.length })
      break
    }
    lines.push({ index, text: text.slice(start, nl), start, end: nl })
    start = nl + 1
    index++
  }
  return lines
}

function isBlankLine(lines: TextLine[], i: number): boolean {
  if (i < 0 || i >= lines.length) return true // 文档首尾之外视为空行
  return lines[i]!.text.trim().length === 0
}

function makeDraft(
  raw: RawChapter,
  index: number,
  volumeIndex: number | null,
  charsPerSecond: number | undefined,
): ChapterDraft {
  const charCount = raw.rawText.length
  return {
    tempId: `ch-${index}-${raw.startOffset}`,
    index,
    title: raw.title,
    rawText: raw.rawText,
    charCount,
    estimatedDurationMs: estimateDurationMs(charCount, charsPerSecond),
    kind: raw.kind,
    volumeIndex,
    startOffset: raw.startOffset,
    endOffset: raw.endOffset,
    included: true,
  }
}

// ============================================================================
// 主入口：splitChapters（docs/10 §6.3）
// ============================================================================

/**
 * 按规则集分章（docs/10 §6.3）。边界校验全部启用：
 *   · 标题行长度上限（防正文里的「第三章」引用）
 *   · requireBlankAround（部分规则要求前后空行）
 *   · 两候选间距 < minChapterChars（默认 50）→ 后者视为误切并合并
 *   · 首章前文本 > 200 字 → 作为「前言」保留；否则丢弃
 *   · 末章正文 < 200 字 → 并入上一章
 *   · 章节号倒退 → 记 warning（可能是上下部/倒叙，不强制阻止）
 *
 * 无匹配时：默认返回空数组（不猜），调用方据此抛 `NO_CHAPTER_MATCHED`
 * 让用户选择备选策略（docs/10 §6.4、§10）；也可用 `options.fallback` 直接指定策略。
 *
 * @param text 已清洗、换行已归一的全文
 * @param ruleSet 规则集（BUILTIN_RULE_SETS 或用户自定义）
 * @param options 见 SplitOptions
 * @returns 章节草稿；无匹配且 fallback='none' 时为空数组
 * @throws AppError `RULE_PATTERN_UNSAFE` 累计匹配耗时超出预算时
 */
export function splitChapters(text: string, ruleSet: ChapterRuleSet, options?: SplitOptions): ChapterDraft[] {
  return splitChaptersDetailed(text, ruleSet, options).drafts
}

/**
 * `splitChapters` 的详细版本：额外返回策略、命中规则、合并计数与 warning。
 * UI 的「分章规则」步骤需要这些信息做提示（docs/10 §7.1 Step 3）。
 * @throws AppError `RULE_PATTERN_UNSAFE` 累计匹配耗时超出预算时
 */
export function splitChaptersDetailed(
  text: string,
  ruleSet: ChapterRuleSet,
  options?: SplitOptions,
): SplitResult {
  const minChapterChars = options?.minChapterChars ?? 50
  const frontMatterMinChars = options?.frontMatterMinChars ?? 200
  const tailMinChars = options?.tailMinChars ?? 200
  const matchTimeoutMs = options?.matchTimeoutMs ?? 100
  const totalBudgetMs = options?.totalMatchBudgetMs ?? 10_000
  const charsPerSecond = options?.charsPerSecond
  const emitVolumes = options?.emitVolumes ?? false
  const warnings: SplitWarning[] = []

  const compiled: CompiledRule[] = ruleSet.patterns.map((rule) => {
    const c = compileChapterRule(rule)
    if (c.rejected) {
      const v = validateLinePattern(rule.linePattern)
      warnings.push({
        code: v.code === 'RULE_PATTERN_UNSAFE' ? 'pattern-unsafe' : 'pattern-invalid',
        ruleId: rule.id,
        message: `规则「${rule.id}」被拒绝：${v.error ?? '未知原因'}`,
      })
    }
    return c
  })

  const lines = splitLinesWithOffsets(text)
  const candidates: Candidate[] = []
  let totalMatchMs = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.text.trim()
    if (trimmed.length === 0) continue
    let matched = false
    for (const c of compiled) {
      if (!c.regex) continue
      if (trimmed.length > c.rule.maxLineLength) continue
      if (c.rule.requireBlankAround && !(isBlankLine(lines, i - 1) && isBlankLine(lines, i + 1))) continue
      const outcome = matchWithBudget(c.regex, trimmed, c.rule.titleGroup ?? 0, matchTimeoutMs)
      totalMatchMs += outcome.elapsedMs
      if (totalMatchMs > totalBudgetMs) {
        // docs/10 §6.5：匹配超时后中断并提示
        throw new AppError('RULE_PATTERN_UNSAFE', {
          params: { reason: `规则「${c.rule.id}」匹配累计耗时超过 ${totalBudgetMs} ms` },
          details: { ruleId: c.rule.id, totalMatchMs, lineNo: i + 1 },
        })
      }
      if (outcome.timedOut) {
        warnings.push({
          code: 'match-timeout',
          ruleId: c.rule.id,
          lineNo: i + 1,
          message: `规则「${c.rule.id}」单行匹配耗时 ${outcome.elapsedMs.toFixed(1)} ms，已停用该规则`,
        })
        c.regex = null
        continue
      }
      if (!outcome.matched) continue
      candidates.push({
        lineIndex: i,
        lineStart: line.start,
        lineEnd: line.end,
        ruleId: c.rule.id,
        title: outcome.title && outcome.title.length > 0 ? outcome.title : trimmed,
        kind: c.rule.kind,
      })
      matched = true
      break
    }
    // 纯数字标题（如「12」单独成行）：仅当规则集允许且前后空行（docs/10 §6.2 cn-numonly）
    if (!matched && ruleSet.allowNumericOnly && /^[0-9]{1,4}$/.test(trimmed)) {
      if (isBlankLine(lines, i - 1) && isBlankLine(lines, i + 1)) {
        candidates.push({
          lineIndex: i,
          lineStart: line.start,
          lineEnd: line.end,
          ruleId: 'numeric-only',
          title: trimmed,
          kind: 'chapter',
        })
      }
    }
  }

  const matchedRuleIds: string[] = []
  for (const c of candidates) {
    if (!matchedRuleIds.includes(c.ruleId)) matchedRuleIds.push(c.ruleId)
  }

  // ---- 卷标记与边界合并（docs/10 §6.3） ----
  const volumes: Array<{ index: number; title: string; startOffset: number }> = []
  const accepted: Candidate[] = []
  /** accepted[k] 所属卷号（0 = 无卷） */
  const acceptedVolume: number[] = []
  let mergedCount = 0
  let volumeSeq = 0

  for (const c of candidates) {
    if (c.kind === 'volume') {
      volumeSeq++
      volumes.push({ index: volumeSeq, title: c.title, startOffset: c.lineStart })
      if (!emitVolumes) continue // 卷不切章，只作层级标记
    }
    const prev = accepted[accepted.length - 1]
    // 卷标题与它下面的第一章之间本来就「没有正文字数」，不能按误切合并
    if (prev && prev.kind !== 'volume' && c.kind !== 'volume') {
      const gap = c.lineStart - prev.lineEnd
      if (gap < minChapterChars) {
        mergedCount++
        warnings.push({
          code: 'merged-candidate',
          ruleId: c.ruleId,
          lineNo: c.lineIndex + 1,
          message: `「${c.title}」与上一章边界间距仅 ${gap} 字（< ${minChapterChars}），已按误切合并`,
        })
        continue
      }
    }
    accepted.push(c)
    acceptedVolume.push(c.kind === 'volume' ? volumeSeq : volumeSeq > 0 ? volumeSeq : 0)
  }

  if (candidates.length === 0) {
    warnings.push({ code: 'no-match', message: '未匹配到任何章节标题规则' })
    const fallback = options?.fallback ?? 'none'
    const outcome = runFallback(text, fallback, options?.fallbackOptions ?? {})
    if (outcome.strategy === 'none') {
      return {
        drafts: [],
        strategy: 'none',
        matchedRuleIds,
        candidateCount: 0,
        mergedCount: 0,
        volumes,
        warnings,
      }
    }
    return {
      drafts: outcome.drafts,
      strategy: outcome.strategy,
      matchedRuleIds,
      candidateCount: 0,
      mergedCount: 0,
      volumes,
      warnings,
    }
  }

  // ---- 组装章节（首章 / 中间章 / 末章） ----
  const raws: RawChapter[] = []
  const rawVolumes: Array<number | null> = []

  const firstStart = accepted[0]!.lineStart
  const headText = text.slice(0, firstStart)
  if (headText.trim().length > frontMatterMinChars) {
    // docs/10 §6.3 首章：> 200 字作为「前言/序」保留，否则丢弃（多为书名/作者/简介）
    raws.push({ title: '前言', kind: 'front', startOffset: 0, endOffset: firstStart, rawText: headText })
    rawVolumes.push(null)
  }

  for (let k = 0; k < accepted.length; k++) {
    const c = accepted[k]!
    const next = accepted[k + 1]
    let start = c.lineStart
    // 该章之前的卷标题留在正文里（避免丢字）：章起点提前到卷标题行
    const vol = acceptedVolume[k] ?? 0
    if (vol > 0) {
      const marker = volumes.find((v) => v.index === vol)
      const lowerBound = k === 0 ? 0 : accepted[k - 1]!.lineEnd
      if (marker && marker.startOffset < start && marker.startOffset >= lowerBound) start = marker.startOffset
    }
    // 与上一段不重叠
    const prevRaw = raws[raws.length - 1]
    if (prevRaw) start = Math.max(start, prevRaw.endOffset)
    let end = next ? next.lineStart : text.length
    if (end < start) end = start
    raws.push({
      title: c.title,
      kind: c.kind,
      startOffset: start,
      endOffset: end,
      rawText: text.slice(start, end),
    })
    rawVolumes.push(emitVolumes && c.kind === 'volume' ? vol : vol > 0 ? vol : null)
  }

  // 末章：正文过短则并入上一章（docs/10 §6.3）
  if (raws.length >= 2) {
    const last = raws[raws.length - 1]!
    const mergeable = last.kind === 'chapter' || last.kind === 'extra' || last.kind === 'back'
    if (mergeable && last.rawText.length > 0 && last.rawText.length < tailMinChars) {
      const prevRaw = raws[raws.length - 2]!
      prevRaw.endOffset = last.endOffset
      prevRaw.rawText = text.slice(prevRaw.startOffset, last.endOffset)
      raws.pop()
      rawVolumes.pop()
      warnings.push({
        code: 'merged-candidate',
        message: `末章「${last.title}」正文仅 ${last.rawText.length} 字（< ${tailMinChars}），已并入上一章`,
      })
    }
  }

  const drafts = raws.map((raw, i) => makeDraft(raw, i + 1, rawVolumes[i] ?? null, charsPerSecond))

  // ---- 单调性检查（docs/10 §6.3：倒退给警告，不强制阻止） ----
  let lastIndex: number | null = null
  let lastTitle = ''
  for (const d of drafts) {
    const n = parseChapterIndex(d.title)
    if (n === null) continue
    if (lastIndex !== null && n < lastIndex) {
      warnings.push({
        code: 'index-regression',
        message: `章节号出现倒退：「${d.title}」(${n}) 小于上一章「${lastTitle}」(${lastIndex})，请确认是否为上下部或倒叙`,
      })
    }
    lastIndex = n
    lastTitle = d.title
  }

  return {
    drafts,
    strategy: 'rules',
    matchedRuleIds,
    candidateCount: candidates.length,
    mergedCount,
    volumes,
    warnings,
  }
}

interface FallbackOutcome {
  drafts: ChapterDraft[]
  strategy: SplitStrategy
}

/** 备选策略分发（docs/10 §6.4） */
function runFallback(text: string, strategy: FallbackStrategy, options: FallbackOptions): FallbackOutcome {
  switch (strategy) {
    case 'blank-blocks':
      return { drafts: splitByBlankBlocks(text, options), strategy: 'blank-blocks' }
    case 'length':
      return { drafts: splitByLength(text, options), strategy: 'length' }
    case 'single':
      return { drafts: splitAsSingleChapter(text, options), strategy: 'single' }
    case 'auto': {
      const chosen = chooseFallbackStrategy(text, options)
      return { drafts: runFallback(text, chosen, options).drafts, strategy: chosen }
    }
    default:
      return { drafts: [], strategy: 'none' }
  }
}

// ============================================================================
// 备选策略（docs/10 §6.4）
// ============================================================================

/**
 * 按空行块分章（docs/10 §6.4）：在「连续 2+ 空行」处切分；块长 < minBlockChars(100) 则并入前一块。
 * 标题取块首行（≤ 30 字时），否则自动生成「第 N 部分」。
 * @param text 全文
 * @param options 见 FallbackOptions
 * @returns 章节草稿（文本非空时至少 1 章）
 */
export function splitByBlankBlocks(text: string, options?: FallbackOptions): ChapterDraft[] {
  const minBlockChars = options?.minBlockChars ?? 100
  const charsPerSecond = options?.charsPerSecond
  const prefix = options?.titlePrefix ?? '第{n}部分'
  if (text.trim().length === 0) return []

  // 找出「连续 2+ 空行」的切点
  const breaks: number[] = []
  const re = /\n[ \t\u3000]*\n[ \t\u3000]*\n/g
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    breaks.push(m.index + 1)
  }

  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const b of breaks) {
    if (b > cursor) spans.push({ start: cursor, end: b })
    cursor = b
  }
  if (cursor < text.length) spans.push({ start: cursor, end: text.length })
  if (spans.length === 0) spans.push({ start: 0, end: text.length })

  // 过短的块并入前一块
  const merged: Array<{ start: number; end: number }> = []
  for (const span of spans) {
    const prev = merged[merged.length - 1]
    if (prev && text.slice(span.start, span.end).trim().length < minBlockChars) {
      prev.end = span.end
      continue
    }
    merged.push({ ...span })
  }

  const drafts: ChapterDraft[] = []
  for (const span of merged) {
    const rawText = text.slice(span.start, span.end)
    if (rawText.trim().length === 0) continue
    const firstLine = (rawText.split('\n', 1)[0] ?? '').trim()
    const autoTitle = prefix.replace('{n}', String(drafts.length + 1))
    const title = firstLine.length > 0 && firstLine.length <= 30 ? firstLine : autoTitle
    drafts.push(
      makeDraft({ title, kind: 'chapter', startOffset: span.start, endOffset: span.end, rawText }, drafts.length + 1, null, charsPerSecond),
    )
  }
  return drafts
}

/**
 * 按长度均分（docs/10 §6.4）：每 charsPerChunk(3000) 字在最近的句末标点处切，标题「第 N 部分」。
 * @param text 全文
 * @param options 见 FallbackOptions
 * @returns 章节草稿（文本非空时至少 1 章）
 */
export function splitByLength(text: string, options?: FallbackOptions): ChapterDraft[] {
  const chunk = Math.max(200, options?.charsPerChunk ?? 3000)
  const charsPerSecond = options?.charsPerSecond
  const prefix = options?.titlePrefix ?? '第{n}部分'
  if (text.trim().length === 0) return []

  const SENTENCE_END = new Set(['。', '！', '？', '…', '；', '!', '?', '.'])
  const boundaries: number[] = [0]
  let pos = 0
  while (pos + chunk < text.length) {
    const target = pos + chunk
    const backLimit = Math.max(pos + Math.floor(chunk * 0.6), pos + 1)
    const fwdLimit = Math.min(pos + Math.floor(chunk * 1.4), text.length - 1)
    let cut = -1
    for (let i = target; i >= backLimit; i--) {
      if (SENTENCE_END.has(text[i]!)) {
        cut = i + 1
        break
      }
    }
    if (cut === -1) {
      for (let i = target + 1; i <= fwdLimit; i++) {
        if (SENTENCE_END.has(text[i]!)) {
          cut = i + 1
          break
        }
      }
    }
    if (cut === -1) cut = target
    if (cut <= pos) cut = pos + chunk
    // 省略号/英文句点连排时一起吃掉，避免把「……」切开
    while (cut < text.length && (text[cut] === '…' || text[cut] === '.')) cut++
    boundaries.push(cut)
    pos = cut
  }
  boundaries.push(text.length)

  const drafts: ChapterDraft[] = []
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i]!
    const end = boundaries[i + 1]!
    const rawText = text.slice(start, end)
    if (rawText.trim().length === 0) continue
    const title = prefix.replace('{n}', String(drafts.length + 1))
    drafts.push(
      makeDraft({ title, kind: 'chapter', startOffset: start, endOffset: end, rawText }, drafts.length + 1, null, charsPerSecond),
    )
  }
  return drafts
}

/**
 * 整本一章（docs/10 §6.4）：适用于短篇，用户显式选择时才用。
 * @param text 全文
 * @param options 只需 charsPerSecond
 */
export function splitAsSingleChapter(text: string, options?: FallbackOptions): ChapterDraft[] {
  if (text.trim().length === 0) return []
  const title = (options?.titlePrefix ?? '全文').replace('{n}', '1')
  return [
    makeDraft(
      { title, kind: 'chapter', startOffset: 0, endOffset: text.length, rawText: text },
      1,
      null,
      options?.charsPerSecond,
    ),
  ]
}

/**
 * 自动挑选备选策略（docs/10 §6.4）：
 * 文本有稳定空行结构（被「连续 2+ 空行」分隔出 ≥ 3 块，且平均块长 ≥ 200）→ 按空行块；
 * 否则 → 按长度均分。
 * @param text 全文
 * @returns 'blank-blocks' | 'length'
 */
export function chooseFallbackStrategy(text: string, options?: FallbackOptions): 'blank-blocks' | 'length' {
  const blocks = splitByBlankBlocks(text, options)
  if (blocks.length >= 3) {
    const avg = blocks.reduce((s, b) => s + b.charCount, 0) / blocks.length
    if (avg >= 200) return 'blank-blocks'
  }
  return 'length'
}

// ============================================================================
// 按标题结构分章（DOCX 的标题样式，docs/10 §8.2）
// ============================================================================

export interface HeadingBoundary {
  /** 标题层级（1 = 最高） */
  level: number
  title: string
  /** 在全文中的偏移 */
  offset: number
}

export interface HeadingSplitOptions {
  /** 视为章节边界的最大层级（默认 3，即 h1/h2/h3） */
  maxLevel?: number
  /** 把第 1 级标题当「卷」处理（默认 false，即 h1 也是章） */
  h1AsVolume?: boolean
  /** 边界间距小于它则视为误切合并（默认 50，与 §6.3 一致） */
  minChapterChars?: number
  /** 首个边界之前超过它 → 保留为「前言」（默认 200） */
  frontMatterMinChars?: number
  charsPerSecond?: number
}

/**
 * 按标题结构分章（docs/10 §8.2：DOCX 的 `h1/h2/h3` 与 `Heading 1/2/3` 是**强章节边界**，
 * 优先于正则匹配）。
 *
 * 规则与 §6.3 的边界校验一致：间距过近的标题合并、首章前文本超限保留为「前言」、不丢字。
 *
 * @param text 结构化提取后的全文（标题行独占一行，前后有空行）
 * @param headings 标题边界（来自 docx.parser 的 htmlToStructuredText）
 * @param options 见 HeadingSplitOptions
 * @returns 章节草稿；没有任何可用边界时返回空数组（调用方应退回正则分章）
 */
export function splitByHeadings(
  text: string,
  headings: readonly HeadingBoundary[],
  options?: HeadingSplitOptions,
): ChapterDraft[] {
  const maxLevel = options?.maxLevel ?? 3
  const h1AsVolume = options?.h1AsVolume ?? false
  const minChapterChars = options?.minChapterChars ?? 50
  const frontMatterMinChars = options?.frontMatterMinChars ?? 200
  const charsPerSecond = options?.charsPerSecond

  const boundaries = [...headings]
    .filter((h) => h.level <= maxLevel && h.offset >= 0 && h.offset < text.length && h.title.trim().length > 0)
    .sort((a, b) => a.offset - b.offset)
  if (boundaries.length === 0) return []

  interface Boundary {
    offset: number
    title: string
    kind: ChapterKind
    volumeSeq: number | null
  }
  const accepted: Boundary[] = []
  let volumeSeq = 0
  for (const h of boundaries) {
    const isVolume = h1AsVolume && h.level === 1
    if (isVolume) volumeSeq++
    const prev = accepted[accepted.length - 1]
    if (prev && !isVolume && prev.kind !== 'volume' && h.offset - (prev.offset + prev.title.length) < minChapterChars) {
      continue // 与上一个边界挨得太近，视为误切（与 §6.3 同口径）
    }
    accepted.push({
      offset: h.offset,
      title: h.title.trim(),
      kind: isVolume ? 'volume' : 'chapter',
      volumeSeq: volumeSeq > 0 ? volumeSeq : null,
    })
  }
  if (accepted.length === 0) return []

  const raws: Array<{ title: string; kind: ChapterKind; start: number; end: number; rawText: string }> = []
  const volumes: Array<number | null> = []
  const headText = text.slice(0, accepted[0]!.offset)
  if (headText.trim().length > frontMatterMinChars) {
    raws.push({ title: '前言', kind: 'front', start: 0, end: accepted[0]!.offset, rawText: headText })
    volumes.push(null)
  }
  for (let i = 0; i < accepted.length; i++) {
    const b = accepted[i]!
    const next = accepted[i + 1]
    const start = raws.length > 0 ? Math.max(b.offset, raws[raws.length - 1]!.end) : b.offset
    const end = next ? next.offset : text.length
    raws.push({
      title: b.title,
      kind: b.kind,
      start,
      end: Math.max(start, end),
      rawText: text.slice(start, Math.max(start, end)),
    })
    volumes.push(b.volumeSeq)
  }

  return raws.map((raw, i) =>
    makeDraft(
      { title: raw.title, kind: raw.kind, startOffset: raw.start, endOffset: raw.end, rawText: raw.rawText },
      i + 1,
      volumes[i] ?? null,
      charsPerSecond,
    ),
  )
}

// ============================================================================
// 分章结果体检（docs/10 §10 CHAPTER_SPLIT_SUSPICIOUS）
// ============================================================================

export interface SplitSuspicion {
  suspicious: boolean
  /** 触发原因（用于 AppError('CHAPTER_SPLIT_SUSPICIOUS') 的 params 与提示） */
  reasons: string[]
}

/**
 * 分章结果是否可疑（docs/10 §10：「1 章却 100 万字」这类启发式告警）。
 * 触发条件：① 章数 ≤ 1 且总字数 > 20000；② 单章 > 100000 字。
 * @param drafts 分章草稿
 * @returns suspicious + 原因列表；调用方据此抛/提示 `CHAPTER_SPLIT_SUSPICIOUS`
 */
export function inspectSplitSuspicion(drafts: ChapterDraft[]): SplitSuspicion {
  const reasons: string[] = []
  const total = drafts.reduce((s, d) => s + d.charCount, 0)
  const longest = drafts.reduce((m, d) => Math.max(m, d.charCount), 0)
  if (drafts.length <= 1 && total > 20_000) reasons.push(`仅切出 ${drafts.length} 章，却有 ${total} 字`)
  if (longest > 100_000) reasons.push(`单章最长 ${longest} 字，可能存在漏切`)
  return { suspicious: reasons.length > 0, reasons }
}

/** 便捷判定：分章结果是否可疑 */
export function isSplitSuspicious(drafts: ChapterDraft[]): boolean {
  return inspectSplitSuspicion(drafts).suspicious
}

// ============================================================================
// 人工干预辅助（docs/10 §7.1 Step 5：合并 / 拆分 / 改名 / 排序）
// ============================================================================

/**
 * 合并相邻章节（UI「合并」按钮）。区间取并集拼接原文，避免丢字。
 * @param drafts 原草稿数组
 * @param indexes 要合并的章节 index（必须连续）
 * @param title 合并后的标题（默认取第一个的标题）
 * @returns 新草稿数组（原数组不变）；index 不存在或不连续时返回 null
 */
export function mergeDrafts(drafts: ChapterDraft[], indexes: number[], title?: string): ChapterDraft[] | null {
  const picked = drafts.filter((d) => indexes.includes(d.index))
  if (picked.length !== indexes.length || picked.length === 0) return null
  const first = picked[0]!
  const last = picked[picked.length - 1]!
  if (last.index - first.index !== picked.length - 1) return null
  const startIdx = drafts.indexOf(first)
  const endIdx = drafts.indexOf(last)
  const rawText = drafts.slice(startIdx, endIdx + 1).map((d) => d.rawText).join('')
  const merged: ChapterDraft = {
    ...first,
    title: title ?? first.title,
    rawText,
    charCount: rawText.length,
    estimatedDurationMs: estimateDurationMs(rawText.length),
    endOffset: last.endOffset,
  }
  const out = [...drafts.slice(0, startIdx), merged, ...drafts.slice(endIdx + 1)]
  return out.map((d, i) => ({ ...d, index: i + 1, tempId: `ch-${i + 1}-${d.startOffset}` }))
}

/**
 * 按给定偏移把一章拆成多章（UI「拆分」按钮，docs/10 §7.1 Step 5）。
 * @param draft 原章节
 * @param offsets 拆分点（相对该章 rawText 的偏移，可乱序；越界值会被忽略）
 * @returns 新章节数组（index 由调用方统一重排）；无有效拆分点时返回 null
 */
export function splitDraftAt(draft: ChapterDraft, offsets: number[]): ChapterDraft[] | null {
  const cuts = [...new Set(offsets)].sort((a, b) => a - b).filter((o) => o > 0 && o < draft.rawText.length)
  if (cuts.length === 0) return null
  const points = [0, ...cuts, draft.rawText.length]
  const out: ChapterDraft[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i]!
    const end = points[i + 1]!
    const rawText = draft.rawText.slice(start, end)
    out.push({
      ...draft,
      tempId: `${draft.tempId}-${i + 1}`,
      title: i === 0 ? draft.title : `${draft.title}（${i + 1}）`,
      rawText,
      charCount: rawText.length,
      estimatedDurationMs: estimateDurationMs(rawText.length),
      startOffset: draft.startOffset + start,
      endOffset: draft.startOffset + end,
    })
  }
  return out
}

/**
 * 按标题里的数字排序（docs/10 §7.1：正则切出来的顺序可能是乱的）。
 * 解析不出章节号的排在后面，并保持原有相对顺序。
 * @param drafts 草稿数组
 * @returns 新数组（index 与 tempId 已重排）
 */
export function sortDraftsByTitleIndex(drafts: ChapterDraft[]): ChapterDraft[] {
  const decorated = drafts.map((d, i) => ({ d, i, n: parseChapterIndex(d.title) }))
  decorated.sort((a, b) => {
    if (a.n === null && b.n === null) return a.i - b.i
    if (a.n === null) return 1
    if (b.n === null) return -1
    return a.n - b.n
  })
  return decorated.map((x, i) => ({ ...x.d, index: i + 1, tempId: `ch-${i + 1}-${x.d.startOffset}` }))
}
