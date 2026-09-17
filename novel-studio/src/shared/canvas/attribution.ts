/**
 * Novel Studio · 说话人判定与画本生成（本域核心）
 * ============================================================================
 * 设计依据：
 *   · docs/06 §5.1  说话人判定总流程 Step 1 ~ Step 8（本文件逐条实现）
 *   · docs/06 §5.2  相似度与阈值（threshold 0.62 / margin 0.06 / 窗口 2 / 短句 6 字）
 *   · docs/06 §5.3  规则层细节（引号族、引导语变体、插入式对白）
 *   · docs/06 §8    降级矩阵（无模型 → 规则判定，不报错、不静默返回空数据）
 *   · docs/11 §2    生成流程 Step 1 ~ Step 9 与切句/停顿规则
 *   · docs/11 §3    为什么 confidence / candidates / decidedBy 必须存在
 *
 * 三层能力（docs/06 §2）在本文件的落点：
 *   L1 规则层：splitToLines / classifyKind / 引导语 / 短句保护 / 连续对白 / 停顿 / 情绪词表
 *   L2 向量层：buildContext + EmbeddingProvider（注入）+ attributeByVector（余弦 Top-3）
 *   L3 LLM 层：LlmReviewer（注入），只复核 needsReview 行，失败即降级（docs/06 §8）
 *
 * 零第三方依赖：只 import Node 内置与本仓库 src/shared/.ts。
 * ONNX 推理、分词器、LLM 都由调用方注入实现（无网络环境下的唯一可行做法）：
 *   · EmbeddingProvider 的生产实现 = onnxruntime-node + bge-small-zh-v1.5（docs/06 §4.1）
 *   · LlmReviewer 的生产实现 = AIProvider.chat + 结构化输出校验（docs/06 §6.2 §6.4）
 *
 * 注意：`generateCanvasLines` 是 async 的 —— 因为 EmbeddingProvider 按契约就是异步的
 * （docs/06 §3.1）。这是对任务书签名的唯一偏离，已在最终报告里说明。
 */

import { AppError } from '../errors.ts'
import {
  CANVAS_DEFAULTS,
  EMOTIONS,
  PAUSE_RULES,
  QUOTE_PAIRS,
  SFX_BRACKETS,
} from '../constants.ts'
import type {
  CanvasGenerateOptions,
  CanvasGenerateReport,
  CanvasLine,
  DecidedBy,
  Id,
  LineKind,
  LineState,
  SpeakerCandidate,
  SpeakerType,
  SpeedMark,
} from '../types.ts'
import { computeCentroid, cosine, l2Normalize, rankCandidates } from './vector.ts'
import type { CentroidEntry } from './vector.ts'

// ============================================================================
// 注入式接口（无网络环境的替代方案；生产实现见注释）
// ============================================================================

/**
 * 向量提供者。生产实现：`OnnxEmbeddingProvider`（onnxruntime-node + bge-small-zh-v1.5
 * INT8，CLS pooling，输出后立即 L2 归一化，见 docs/06 §4.1 §4.2）。
 *
 * 契约：
 *   · 返回数组长度必须与 `texts` 一致，否则实现方违约，本模块抛 AppError('INVALID_PAYLOAD')
 *   · 维度必须与 `dim` 一致（不一致 → 抛 AppError('MODEL_LOAD_FAILED') 语义的异常）
 *   · 支持 AbortSignal；中断时应抛 AbortError（本模块会转成 TASK_CANCELLED）
 */
export interface EmbeddingProvider {
  readonly modelId: string
  readonly dim: number
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

/** 提交给 LLM 复核的一批低置信行（docs/06 §6.2 的 prompt 变量来源） */
export interface LlmReviewRequest {
  chapterId: Id
  items: Array<{
    lineId: Id
    seq: number
    text: string
    kind: LineKind
    context: string[]
  }>
  characters: Array<{ id: Id; name: string; aliases: string[] }>
  signal?: AbortSignal
}

export interface LlmReviewItem {
  lineId: Id
  /** 角色名，或 'narration' 表示旁白 */
  speaker: string
  confidence: number
}

/**
 * LLM 复核（L3，可选）。生产实现：`AIProvider.chat` + `callStructured`
 * （去代码围栏 + Zod 校验 + lineId 存在性校验，docs/06 §6.4）。
 *
 * 契约：**不得抛错中断生成**——本模块会 catch 一切异常并降级
 * （记录 CANVAS_LLM_UNAVAILABLE 警告 + llmUsed=false），只有 AbortError 会向上传播。
 */
export interface LlmReviewer {
  reviewBatch(req: LlmReviewRequest): Promise<LlmReviewItem[]>
}

// ============================================================================
// 规则常量（CANVAS_DEFAULTS 未覆盖的部分集中在这里，避免散落的魔数）
// ============================================================================

/**
 * 引导语动词表（docs/06 §5.3）。按长度降序排列，保证正则的最长匹配优先。
 * 生产环境应做成可配置规则集（docs/06 §5.3「实现建议」），此处作为内置默认。
 */
export const CUE_VERBS: readonly string[] = [
  '沉声说道', '低声说道', '轻声说道', '冷冷地说道', '淡淡地说道', '冷声说道',
  '喃喃自语', '咬牙切齿道', '斩钉截铁道', '拍案而起道',
  '说道', '问道', '答道', '喊道', '叫道', '吼道', '骂道', '笑道', '怒道', '哭道',
  '沉声道', '低声道', '轻声道', '冷冷道', '淡淡道', '怒喝', '喝问',
  '开口道', '接着说', '插嘴道', '附和道', '解释道', '回答道', '应声道', '回了一句',
  '嘟囔道', '喃喃道', '嘀咕道', '自语道', '沉吟道', '叹了口气', '叹道',
  '吩咐', '追问', '反问', '劝说', '开口', '接着', '应道', '回道',
  '说', '道', '问', '答', '喊', '叫', '笑', '哼', '叹', '骂', '吼', '劝', '嚷',
] as const

/** 心理描写标志（docs/11 §2.2 第 4 条） */
export const INNER_MARKERS: readonly string[] = [
  '心想', '心道', '心中一', '心中一动', '心中暗', '暗忖', '暗想', '暗自', '默默想',
  '心中想', '心念', '思索', '寻思', '思忖', '念头', '心想道', '内心',
] as const

/**
 * 内心独白的引导语（「萧炎心道，……」这类）。
 * 与对白引导语分开，因为它的结构是「名单 + 心想 + 逗号 + 想法」，动词不在句末。
 */
export const INNER_CUE_VERBS: readonly string[] = [
  '心道', '心想', '心念', '暗道', '暗想', '暗忖', '心中想', '心中暗道', '心下一动', '默默想', '思忖', '寻思',
] as const

/**
 * 规则判定的置信度（docs 未给数值，属于本域补充常量；已在报告里记为契约缺口）。
 * 之所以 > vector 阈值：规则命中「引导语明确指名」时是确定性证据，而不是相似度。
 */
export const RULE_CONFIDENCE = {
  /** 引导语明确指名 */
  cueOverride: 0.95,
  /** 连续对白偏向上一说话人 */
  consecutive: 0.72,
  /** 短句保护下沿用的上下文结论 */
  shortLine: 0.55,
  /** 场景内角色过滤后的结论 */
  sceneFilter: 0.7,
} as const

/**
 * 连续对白加成：把上一说话人的候选分数抬高这么多再做阈值+margin 判定。
 * 取略大于默认 margin(0.06)，使「两个候选差不多」时确实偏向上一说话人，
 * 而「向量强信号」仍然压得住（docs/06 §5.1 Step 6「偏向」而非「强制」）。
 */
export const CONSECUTIVE_BONUS_DEFAULT = 0.08

/** 向后查找「最近引导语」的最大距离（行） */
export const CUE_LOOKBACK_DEFAULT = 6

/** 句内停顿：行长达到此值才开始插入 pauseInline */
export const PAUSE_INLINE_MIN_CHARS = 16
/** 句内停顿的最小间隔（字符） */
export const PAUSE_INLINE_MIN_SPACING = 8

/** 情绪/语速词表（L1 优先；命中则**不调** LLM，docs/06 §7.2「本地优先」） */
export const EMOTION_LEXICON: ReadonlyArray<{
  emotion: string
  intensity: number
  speed: SpeedMark | null
  keywords: readonly string[]
}> = [
  { emotion: '愤怒', intensity: 5, speed: 'fast', keywords: ['怒吼', '怒喝', '大怒', '暴怒', '恼火', '气愤', '咬牙切齿', '厉声', '怒道', '咆哮', '怒吼道'] },
  { emotion: '喜悦', intensity: 3, speed: 'normal', keywords: ['哈哈', '大笑', '欢喜', '高兴', '开心', '愉快', '喜悦', '欣喜', '笑容'] },
  { emotion: '悲伤', intensity: 4, speed: 'slow', keywords: ['哽咽', '抽泣', '落泪', '泪水', '伤心', '悲伤', '痛哭', '悲痛', '哀伤', '凄然'] },
  { emotion: '惊讶', intensity: 3, speed: 'fast', keywords: ['震惊', '吃惊', '诧异', '愕然', '愣住', '一惊', '讶异', '难以置信'] },
  { emotion: '恐惧', intensity: 4, speed: 'slow', keywords: ['惊恐', '恐惧', '害怕', '颤抖', '浑身发抖', '胆寒', '骇然', '战栗'] },
  { emotion: '厌恶', intensity: 2, speed: 'normal', keywords: ['厌恶', '恶心', '嫌恶', '鄙夷', '不齿'] },
  { emotion: '嘲讽', intensity: 3, speed: 'normal', keywords: ['冷笑', '嗤笑', '讥讽', '嘲讽', '讽刺', '冷哼', '揶揄'] },
  { emotion: '激动', intensity: 4, speed: 'fast', keywords: ['激动', '兴奋', '热血', '大喊', '亢奋'] },
  { emotion: '低沉', intensity: 2, speed: 'slow', keywords: ['低声道', '沉声', '低声', '沙哑', '喃喃', '轻叹', '叹息', '幽幽'] },
  { emotion: '温柔', intensity: 2, speed: 'slow', keywords: ['温柔', '轻声', '柔声', '微笑', '柔和'] },
  { emotion: '焦急', intensity: 3, speed: 'fast', keywords: ['焦急', '着急', '催促', '连忙', '赶紧', '慌忙', '急切'] },
  { emotion: '决绝', intensity: 5, speed: 'fast', keywords: ['决绝', '斩钉截铁', '毅然', '发誓', '绝不', '誓不'] },
  { emotion: '无奈', intensity: 2, speed: 'slow', keywords: ['无奈', '苦笑', '叹了口气', '叹气', '摇头', '耸了耸肩'] },
  { emotion: '平静', intensity: 1, speed: 'normal', keywords: ['淡淡', '平静', '淡然', '若无其事', '不咸不淡'] },
] as const

/** 情绪词表里出现的情绪名必须都在 EMOTIONS 里（否则 UI 下拉框会显示未知值） */
function assertLexiconEmotions(): void {
  const allowed = new Set<string>(EMOTIONS)
  for (const entry of EMOTION_LEXICON) {
    if (!allowed.has(entry.emotion)) {
      throw new AppError('CANVAS_LLM_UNAVAILABLE', {
        details: { reason: 'emotion-lexicon-out-of-range', emotion: entry.emotion },
      })
    }
  }
}
assertLexiconEmotions()

/** 引导语之前的人名窗口（docs/06 §5.1 Step 3：2~6 字） */
export const CUE_NAME_WINDOW = 6

/** 引导语窗口里需要剥掉的修饰成分（避免把「皱眉道」的「皱眉」当人名） */
const CUE_MODIFIERS: readonly string[] = [
  '微微', '缓缓', '冷冷', '淡淡', '轻轻', '低声', '沉声', '轻声', '忙', '又', '才',
  '便', '就', '也', '则', '只', '却', '忽', '忽而', '猛然', '顿时', '随即', '立刻',
  '马上', '终于', '笑着', '哭着', '摇头', '点头', '皱眉', '抬头', '低头', '转头',
  '转身', '回头', '沉吟', '顿了顿', '停了停', '叹气', '叹息', '咬牙', '拱手',
  '抱拳', '上前', '退后', '拱手道', '拱了拱手', '淡淡地', '冷冷地', '轻声地',
  '抚须', '傲然', '悠然', '漠然', '默然', '正色', '肃然', '大笑', '微微一笑',
]

/** 代词/泛指：不能当人名（否则「他说道」会抽出角色「他」） */
export const NON_NAME_TOKENS: readonly string[] = [
  '他', '她', '它', '我', '你', '您', '咱', '俺', '他们', '她们', '我们', '你们',
  '众人', '大家', '所有人', '旁人', '有人', '此人', '那人', '那人', '这人', '对方',
  '老者', '少年', '青年', '中年', '汉子', '男子', '女子', '女孩', '男孩', '那人',
] as const

// ============================================================================
// 工具：全角/半角、标点判定
// ============================================================================

/** 主切分标点（docs/11 §2.1：句末 。！？… ；(弱)） */
const TERMINAL_PUNCT = new Set(['。', '！', '？', '…', '；', '!', '?', ';', '～', '~'])
/** 次切分标点（docs/11 §2.1：长句在逗号/破折号处二次切） */
const SECONDARY_PUNCT = new Set(['，', ',', '、', '—', '：', ':', '·'])
/** 收尾符号：切分点之后要把它们并进当前行（否则引号会掉到下一行） */
const CLOSING_DELIMS = new Set(['”', '」', '』', '’', '"', '）', ')', '】', '》', '〉'])

function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)
}

/** 计「字」数：只数汉字/字母/数字，标点与空白不计（短句保护与 too_long 都用它） */
export function countReadableChars(text: string): number {
  let n = 0
  for (const ch of text) {
    if (isCjk(ch) || /[A-Za-z0-9]/.test(ch)) n++
  }
  return n
}

/** 引号与括号的统一深度表（切句时「引号/书名号/括号内部不切」的依据） */
interface DepthInfo {
  /** inside[i] = 1 表示第 i 个字符处于引号或括号内部（含起始符与结束符本身） */
  inside: Uint8Array
  /** 未闭合的引号/括号数（> 0 即 quote_unmatched） */
  unclosed: number
  /** 多余的结束符数（同样视为不配对） */
  orphanCloses: number
}

const BRACKET_PAIRS: ReadonlyArray<[string, string]> = [
  ['【', '】'],
  ['（', '）'],
  ['(', ')'],
  ['《', '》'],
  ['〈', '〉'],
  ['[', ']'],
  ['〔', '〕'],
]

function computeDepth(text: string): DepthInfo {
  const inside = new Uint8Array(text.length)
  const stack: Array<{ open: string; close: string; kind: 'quote' | 'bracket' }> = []
  let orphanCloses = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const top = stack[stack.length - 1]

    if (top && ch === top.close) {
      stack.pop()
      inside[i] = 1 // 结束符本身仍属于内部（切分点只允许出现在它之后）
      continue
    }

    const quotePair = QUOTE_PAIRS.find(([o]) => o === ch)
    if (quotePair) {
      stack.push({ open: quotePair[0], close: quotePair[1], kind: 'quote' })
      inside[i] = 1
      continue
    }

    const bracketPair = BRACKET_PAIRS.find(([o]) => o === ch)
    if (bracketPair) {
      stack.push({ open: bracketPair[0], close: bracketPair[1], kind: 'bracket' })
      inside[i] = 1
      continue
    }

    // 多余的结束符：既不是栈顶的 close，也不是任何 open
    if (CLOSING_DELIMS.has(ch) || BRACKET_PAIRS.some(([, c]) => c === ch)) {
      orphanCloses++
      continue
    }

    inside[i] = stack.length > 0 ? 1 : 0
  }

  return { inside, unclosed: stack.length, orphanCloses }
}

// ============================================================================
// Step 1：分句 → 画本行初稿（docs/06 §5.1 Step 1 / docs/11 §2.1）
// ============================================================================

/** 分句产出的行初稿 */
export interface LineDraft {
  index: number
  /** 原文片段（已 trim 首尾空白，保留引号） */
  text: string
  /** 归一化后章节文本中的起止偏移（charStart 含、charEnd 不含） */
  charStart: number
  charEnd: number
  paragraphIndex: number
  /** 是否段落首行（段落边界，停顿加长） */
  startsParagraph: boolean
  /** 是否段落末行 */
  endsParagraph: boolean
  /** 引号不配对（进质检 quote_unmatched） */
  quoteUnmatched: boolean
  /** 超过 maxLineChars 且无法再切 */
  tooLong: boolean
}

export interface SplitOptions {
  /** 单行最大字数（默认 CANVAS_DEFAULTS.maxLineChars = 120） */
  maxLineChars?: number
}

interface RawSegment {
  text: string
  start: number
  end: number
  quoteUnmatched: boolean
}

/**
 * Step 1：把章节原文切成画本行初稿。
 *
 * 规则（docs/11 §2.1）：
 *   · 主切分：句末标点 。！？…；（弱）；引号/书名号/括号内部不切
 *   · 单引号段：引导语与台词**同行**（保留 cue 元数据，docs/11 §2.2）
 *   · 多引号段（插入式：「我……」他顿了顿，「……不去了。」）：按引号边界切分，
 *     使插入的叙述不被吞掉——这是唯一不会丢文本的处理方式
 *   · 次切分：单段 > maxLineChars 时，在逗号/分号/破折号处按「最靠中间」二次切
 *   · 段落边界：空行强制断行（startsParagraph / endsParagraph）
 *   · 保留 charStart / charEnd（偏移基于 \r\n 归一化后的文本）
 *
 * 失败时抛 AppError('CANVAS_CHAPTER_EMPTY')（文本为空）；
 * 空章节由调用方决定是否调用，本函数只对 null/undefined 文本报错。
 */
export function splitToLines(chapterText: string, opts?: SplitOptions): LineDraft[] {
  if (typeof chapterText !== 'string') {
    throw new AppError('CANVAS_CHAPTER_EMPTY', { details: { reason: 'not-a-string' } })
  }
  const maxLineChars = opts?.maxLineChars ?? CANVAS_DEFAULTS.maxLineChars
  const text = chapterText.replace(/\r\n?/g, '\n')

  // ---- 1) 按「空行」划分段落，段落内按换行再分层 ----
  const logicalLines: Array<{ text: string; start: number; paragraphIndex: number; startsParagraph: boolean; endsParagraph: boolean }> = []
  let paragraphIndex = -1

  const pushLogical = (raw: string, start: number, isParagraphStart: boolean, isParagraphEnd: boolean) => {
    logicalLines.push({
      text: raw,
      start,
      paragraphIndex: Math.max(0, paragraphIndex),
      startsParagraph: isParagraphStart,
      endsParagraph: isParagraphEnd,
    })
  }

  const newlinePositions: number[] = []
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') newlinePositions.push(i)

  const rawLines: Array<{ text: string; start: number; end: number }> = []
  let lineStart = 0
  for (const nl of newlinePositions) {
    rawLines.push({ text: text.slice(lineStart, nl), start: lineStart, end: nl })
    lineStart = nl + 1
  }
  rawLines.push({ text: text.slice(lineStart), start: lineStart, end: text.length })

  // 组装段落：连续非空行属于同一段落
  const paragraphs: Array<Array<{ text: string; start: number; end: number }>> = []
  let current: Array<{ text: string; start: number; end: number }> = []
  for (const line of rawLines) {
    if (line.text.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current)
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) paragraphs.push(current)

  for (const para of paragraphs) {
    paragraphIndex++
    para.forEach((line, li) => {
      pushLogical(line.text, line.start, li === 0, li === para.length - 1)
    })
  }

  // ---- 2) 每个逻辑行：主切分 → 引号段切分 → 次切分 ----
  const out: LineDraft[] = []
  for (const logical of logicalLines) {
    const depth = computeDepth(logical.text)
    const unbalanced = depth.unclosed > 0 || depth.orphanCloses > 0

    const primary: RawSegment[] = []
    let segStart = 0
    let i = 0
    while (i < logical.text.length) {
      const ch = logical.text[i]
      if (TERMINAL_PUNCT.has(ch) && depth.inside[i] === 0) {
        let j = i + 1
        while (j < logical.text.length && (TERMINAL_PUNCT.has(logical.text[j]) || CLOSING_DELIMS.has(logical.text[j]))) j++
        primary.push({ text: logical.text.slice(segStart, j), start: logical.start + segStart, end: logical.start + j, quoteUnmatched: unbalanced })
        segStart = j
        i = j
        continue
      }
      i++
    }
    if (segStart < logical.text.length) {
      primary.push({
        text: logical.text.slice(segStart),
        start: logical.start + segStart,
        end: logical.start + logical.text.length,
        quoteUnmatched: unbalanced,
      })
    }

    // 引号段切分（只在同一逻辑行内出现 ≥ 2 个顶层引号段时才切，避免拆散「引导语+台词」）
    const expanded: RawSegment[] = []
    for (const seg of primary) expanded.push(...splitByQuoteSpans(seg))

    for (const seg of expanded) {
      const trimmed = trimSegment(seg)
      if (trimmed === null) continue
      const pieces = secondarySplit(trimmed, maxLineChars)
      const collected: LineDraft[] = []
      for (const p of pieces) {
        collected.push({
          index: 0,
          text: p.text,
          charStart: p.start,
          charEnd: p.end,
          paragraphIndex: logical.paragraphIndex,
          startsParagraph: false,
          endsParagraph: false,
          quoteUnmatched: p.quoteUnmatched,
          tooLong: countReadableChars(p.text) > maxLineChars,
        })
      }
      // 段落首/末标记只给该逻辑行切出的第一/最后一段（避免二次切分后出现多个「段落首行」）
      if (collected.length > 0) {
        if (logical.startsParagraph) collected[0].startsParagraph = true
        if (logical.endsParagraph) collected[collected.length - 1].endsParagraph = true
      }
      out.push(...collected)
    }
  }

  // 重新编号（切分过程中 index 会随顺序自然递增，这里保证稳定）
  out.forEach((d, idx) => {
    d.index = idx
  })
  return out
}

interface Piece {
  text: string
  start: number
  end: number
  quoteUnmatched: boolean
  first: boolean
  last: boolean
}

/** 去掉片段首尾空白，同步修正偏移；纯空白片段返回 null */
function trimSegment(seg: RawSegment): { text: string; start: number; end: number; quoteUnmatched: boolean } | null {
  const m = /^\s*/.exec(seg.text)
  const lead = m ? m[0].length : 0
  const trailMatch = /\s*$/.exec(seg.text)
  const trail = trailMatch ? trailMatch[0].length : 0
  const text = seg.text.slice(lead, seg.text.length - trail)
  if (text.length === 0) return null
  return { text, start: seg.start + lead, end: seg.end - trail, quoteUnmatched: seg.quoteUnmatched }
}

interface QuoteSpanInfo {
  outerStart: number
  outerEnd: number
  /** 引号内的内容区间（不含引号本身） */
  innerStart: number
  innerEnd: number
}

/** 找出一段文本里的**顶层**引号段（嵌套的内层不算，docs/06 §5.3「按最内层优先配对」） */
export function findTopLevelQuoteSpans(text: string): QuoteSpanInfo[] {
  const spans: QuoteSpanInfo[] = []
  const stack: Array<{ open: string; close: string; at: number }> = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const top = stack[stack.length - 1]
    if (top && ch === top.close) {
      const closed = stack.pop()!
      if (stack.length === 0) {
        spans.push({ outerStart: closed.at, outerEnd: i + 1, innerStart: closed.at + 1, innerEnd: i })
      }
      continue
    }
    const pair = QUOTE_PAIRS.find(([o]) => o === ch)
    if (pair) stack.push({ open: pair[0], close: pair[1], at: i })
  }
  return spans
}

/**
 * 插入式对白的切分：`“我……”他顿了顿，“……不去了。”`
 *   → 3 个片段（台词 / 叙述 / 台词）。只有 ≥ 2 个顶层引号段时才切。
 */
function splitByQuoteSpans(seg: RawSegment): RawSegment[] {
  const spans = findTopLevelQuoteSpans(seg.text)
  if (spans.length < 2) return [seg]

  const out: RawSegment[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.outerStart > cursor) {
      out.push({
        text: seg.text.slice(cursor, span.outerStart),
        start: seg.start + cursor,
        end: seg.start + span.outerStart,
        quoteUnmatched: seg.quoteUnmatched,
      })
    }
    out.push({
      text: seg.text.slice(span.outerStart, span.outerEnd),
      start: seg.start + span.outerStart,
      end: seg.start + span.outerEnd,
      quoteUnmatched: seg.quoteUnmatched,
    })
    cursor = span.outerEnd
  }
  if (cursor < seg.text.length) {
    out.push({
      text: seg.text.slice(cursor),
      start: seg.start + cursor,
      end: seg.end,
      quoteUnmatched: seg.quoteUnmatched,
    })
  }
  return out.filter((s) => s.text.trim().length > 0)
}

/**
 * 次切分：把超长片段在次切分标点处切开（优先取靠中间的），递归直到满足 maxLineChars。
 * 引号段内部的标点**允许**切（该段本身就是台词，docs/11 §2.1「过长句再按逗号二次切」）。
 */
function secondarySplit(
  seg: { text: string; start: number; end: number; quoteUnmatched: boolean },
  maxLineChars: number,
): Piece[] {
  if (countReadableChars(seg.text) <= maxLineChars) {
    return [{ ...seg, first: true, last: true }]
  }

  const spans = findTopLevelQuoteSpans(seg.text)
  // 若整段就是一个引号段，则在其内部（去掉外层引号）寻找切点
  const single = spans.length === 1 && spans[0].outerStart === 0 && spans[0].outerEnd === seg.text.length
  const innerText = single ? seg.text.slice(1, seg.text.length - 1) : seg.text
  const innerOffset = single ? 1 : 0
  const depth = computeDepth(innerText)

  const candidates: number[] = []
  for (let i = 0; i < innerText.length; i++) {
    if (SECONDARY_PUNCT.has(innerText[i]) && depth.inside[i] === 0) candidates.push(i + innerOffset)
  }
  if (candidates.length === 0) {
    return [{ ...seg, first: true, last: true }]
  }
  // 选最靠中间、且切完两段都不至于太短的切点
  const mid = seg.text.length / 2
  const minSide = Math.max(4, Math.floor(maxLineChars / 4))
  const usable = candidates.filter((p) => p >= minSide && seg.text.length - p >= minSide)
  const pick = (usable.length > 0 ? usable : candidates).reduce((best, p) =>
    Math.abs(p - (single ? mid + 1 : mid)) < Math.abs(best - (single ? mid + 1 : mid)) ? p : best,
  )
  const splitAt = Math.min(seg.text.length - 1, pick + 1)

  const left: RawSegment = {
    text: seg.text.slice(0, splitAt),
    start: seg.start,
    end: seg.start + splitAt,
    quoteUnmatched: seg.quoteUnmatched,
  }
  const right: RawSegment = {
    text: seg.text.slice(splitAt),
    start: seg.start + splitAt,
    end: seg.end,
    quoteUnmatched: seg.quoteUnmatched,
  }
  const parts = [
    ...secondarySplit({ ...left, text: left.text.trim() }, maxLineChars),
    ...secondarySplit({ ...right, text: right.text.trim() }, maxLineChars),
  ]
  return parts.map((p, idx) => ({ ...p, first: idx === 0, last: idx === parts.length - 1 }))
}

// ============================================================================
// Step 2：规则粗筛 kind + 引号剥离 + 引导语提取（docs/06 §5.1 Step 2 / docs/11 §2.2）
// ============================================================================

export interface CueInfo {
  /** 引导语动词：说 / 道 / 问 / 喊 … */
  verb: string
  /** 从引导语里猜出的人名（未与角色表核对；核对用 resolveSpeakerHint） */
  speakerHint: string | null
  /** 引导语之前的原始窗口（2~6 字），用于与角色表做包含匹配 */
  speakerWindow: string | null
  position: 'before' | 'after' | 'middle'
  /** 引导语原文片段 */
  text: string
}

export interface KindClassification {
  kind: LineKind
  /** 可录文本（已剥离引号；引号不配对时保留原样） */
  text: string
  /** 命中的引号族（如 '“”'） */
  quoteStyle: string | null
  cue: CueInfo | null
  /** 引号不配对（进 flags: ['quote_unmatched']） */
  unbalanced: boolean
  /** 破折号对白（——后接对白） */
  dashDialogue: boolean
  /** 命中的规则标识，便于 UI「为什么这么判」 */
  matched: string[]
}

export interface ClassifyOptions {
  /** 覆盖内置引导语动词表（docs/06 §5.3：规则应可配置） */
  cueVerbs?: readonly string[]
  innerMarkers?: readonly string[]
  /** 覆盖内心独白引导语动词表 */
  innerCueVerbs?: readonly string[]
}

/**
 * Step 2：规则粗筛 kind。
 *
 * 处理顺序严格按 docs/11 §2.2：
 *   1) 音效括号 → sfx_note
 *   2) 有引号包裹 → dialogue（text = 引号内内容）
 *   3) 无引号但 `——对白` → dialogue
 *   4) 心理描写标志 → inner
 *   5) 其余 → narration（含「整行以引导语结尾」的 `他说道。`）
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')（入参既不是字符串也不是 { text }）。
 */
export function classifyKind(
  line: string | { text: string },
  opts?: ClassifyOptions,
): KindClassification {
  const raw = typeof line === 'string' ? line : line?.text
  if (typeof raw !== 'string') {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'classifyKind', reason: 'missing-text' } })
  }
  const text = raw.trim()
  const matched: string[] = []

  // 1) 音效提示：整行被 【】 或 （音效：…） 包裹
  for (const [open, close] of SFX_BRACKETS) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
      matched.push('sfx_bracket')
      return {
        kind: 'sfx_note',
        text: text.slice(open.length, text.length - close.length).trim(),
        quoteStyle: null,
        cue: null,
        unbalanced: false,
        dashDialogue: false,
        matched,
      }
    }
  }

  const depth = computeDepth(text)
  const spans = findTopLevelQuoteSpans(text)
  const unbalanced = depth.unclosed > 0 || depth.orphanCloses > 0

  // 2) 引号包裹 → dialogue
  if (spans.length > 0) {
    const first = spans[0]
    const pair = QUOTE_PAIRS.find(([o]) => o === text[first.outerStart])
    const inner = spans.map((s) => text.slice(s.innerStart, s.innerEnd)).join('')
    const leading = text.slice(0, first.outerStart)
    const trailing = text.slice(spans[spans.length - 1].outerEnd)
    const cue =
      matchCue(leading, 'before', opts) ??
      matchCue(trailing, 'after', opts) ??
      (spans.length > 1 ? matchCue(text.slice(spans[0].outerEnd, spans[1].outerStart), 'middle', opts) : null)
    matched.push('quote_pair')
    if (cue) matched.push('cue')
    if (unbalanced) matched.push('quote_unmatched')
    if (findTopLevelQuoteSpans(inner).length > 0) matched.push('nested_quote')
    return {
      kind: 'dialogue',
      text: inner.trim(),
      quoteStyle: pair ? `${pair[0]}${pair[1]}` : null,
      cue,
      unbalanced,
      dashDialogue: false,
      matched,
    }
  }

  // 3) 破折号对白：——我不去。
  const dashMatch = /^\s*(?:——|—{1,2}|-{2})\s*(.+)$/.exec(text)
  if (dashMatch && countReadableChars(dashMatch[1]) > 0) {
    matched.push('dash_dialogue')
    return {
      kind: 'dialogue',
      text: dashMatch[1].trim(),
      quoteStyle: null,
      cue: matchCue(text.slice(0, text.indexOf(dashMatch[1])), 'before', opts) ?? null,
      unbalanced,
      dashDialogue: true,
      matched,
    }
  }

  // 4) 心理描写 → inner
  const markers = opts?.innerMarkers ?? INNER_MARKERS
  const hit = markers.find((m) => text.includes(m))
  if (hit) {
    matched.push(`inner:${hit}`)
    const cue = matchInnerCue(text, opts)
    if (cue) matched.push('inner_cue')
    return {
      kind: 'inner',
      text,
      quoteStyle: null,
      cue,
      unbalanced,
      dashDialogue: false,
      matched,
    }
  }

  // 5) narration（整行以引导语结尾的「他说道。」也走这里，docs/11 §2.2 第 3 条）
  matched.push('narration')
  return {
    kind: 'narration',
    text,
    quoteStyle: null,
    cue: null,
    unbalanced,
    dashDialogue: false,
    matched,
  }
}

/**
 * 从一段文本里匹配引导语（动词 + 可选人名）。
 *
 * `position`：before = 引导语在台词之前（`萧炎说道：`）；
 *             after  = 引导语在台词之后（`萧炎说道。` 跟在引号后面）；
 *             middle = 插入在两个引号段之间。
 * 失败不抛错（返回 null 是正常路径：绝大多数行没有引导语）。
 */
export function matchCue(
  text: string,
  position: CueInfo['position'],
  opts?: ClassifyOptions,
): CueInfo | null {
  const chunk = text.trim()
  if (chunk.length === 0) return null

  const verbs = opts?.cueVerbs ?? CUE_VERBS
  // 引导语一般落在片段末尾（before/after/middle 三种位置都是「名字+动词+可选标点」的结构）
  const sorted = [...verbs].sort((a, b) => b.length - a.length)
  for (const verb of sorted) {
    // 允许动词后跟 道/着 与标点
    const re = new RegExp(`${escapeRegExp(verb)}(?:道|着|了一声|了一句)?\\s*[：:，,。.；;！!？?…—]*\\s*$`)
    if (!re.test(chunk)) continue

    const verbIndex = chunk.lastIndexOf(verb)
    const before = chunk.slice(0, verbIndex)
    const window = takeCjkWindow(before, CUE_NAME_WINDOW)
    const hint = guessNameFromWindow(window)
    return {
      verb,
      speakerHint: hint,
      speakerWindow: window || null,
      position,
      text: chunk,
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 内心独白的引导语匹配：「萧炎心道，异火与斗气终究要合为一体。」
 * 结构是「人名 + 心想类动词 + 逗号 + 想法」，动词**不在句末**，所以不能复用 {@link matchCue}。
 * 失败返回 null（该行仍会被判为 inner，只是没有明确指名的说话人）。
 */
export function matchInnerCue(text: string, opts?: ClassifyOptions): CueInfo | null {
  const chunk = text.trim()
  const verbs = [...(opts?.innerCueVerbs ?? INNER_CUE_VERBS)].sort((a, b) => b.length - a.length)
  for (const verb of verbs) {
    const idx = chunk.indexOf(verb)
    if (idx <= 0) continue
    const before = chunk.slice(0, idx)
    const window = takeCjkWindow(before, CUE_NAME_WINDOW)
    if (window.length < 2) continue
    return {
      verb,
      speakerHint: guessNameFromWindow(window),
      speakerWindow: window,
      position: 'before',
      text: chunk.slice(0, idx + verb.length),
    }
  }
  return null
}

/** 取一段文本末尾的 n 个汉字（跳过标点/空白） */
function takeCjkWindow(text: string, n: number): string {
  const chars: string[] = []
  for (let i = text.length - 1; i >= 0 && chars.length < n; i--) {
    const ch = text[i]
    if (isCjk(ch)) chars.unshift(ch)
    else if (chars.length > 0) break
  }
  return chars.join('')
}

/** 从 2~6 字窗口里剥掉修饰语、代词，猜一个人名（可能返回 null） */
export function guessNameFromWindow(window: string): string | null {
  if (!window) return null
  let w = window
  // 反复剥掉结尾/开头的修饰成分
  let changed = true
  while (changed) {
    changed = false
    for (const mod of CUE_MODIFIERS) {
      if (w.endsWith(mod) && w.length > mod.length) {
        w = w.slice(0, w.length - mod.length)
        changed = true
      }
    }
  }
  if (w.length === 0) return null
  if (NON_NAME_TOKENS.includes(w)) return null
  // 取末尾 2~4 字作为人名候选（中文姓名多为 2~3 字，称谓多为 3~4 字）
  for (const len of [3, 2, 4]) {
    if (w.length >= len) {
      const cand = w.slice(w.length - len)
      if (!NON_NAME_TOKENS.includes(cand)) return cand
    }
  }
  return w.length >= 2 ? w : null
}

// ============================================================================
// 角色表与引导语消解
// ============================================================================

/** 判定用的角色引用（由调用方从角色表 + character_centroids 组装） */
export interface CanvasCharacterRef {
  id: Id
  name: string
  aliases: string[]
  description?: string | null
  /** 原型向量；未归一化也接受（内部归一化）。缺失 → 该角色不参与向量判定 */
  centroid?: Float32Array | null
}

/**
 * 把引导语里的名字窗口解析成角色（先精确名/别名，再最长包含匹配）。
 *
 * 为什么用「包含匹配」：引导语窗口里常混着修饰语（`药老皱眉道` 的窗口是「药老皱眉」），
 * 必须先剥修饰语再匹配；若剥完还不匹配，就用「已知角色名是否是该窗口的子串」兜底。
 * 无法解析时返回 null（调用方应把该行标 needsReview，而不是瞎猜一个角色）。
 */
export function resolveSpeakerHint(
  characters: CanvasCharacterRef[],
  cue: CueInfo,
): { character: CanvasCharacterRef; matchedBy: 'exact' | 'contains' } | null {
  const window = cue.speakerWindow ?? ''
  const hint = cue.speakerHint ?? ''
  const candidates: string[] = []
  if (hint) candidates.push(hint)
  // 窗口本身也参与匹配（可能人名比 hint 更长，如「美杜莎女王」）
  if (window && window !== hint) candidates.push(window)

  for (const raw of candidates) {
    for (const c of characters) {
      if (c.name === raw || c.aliases.includes(raw)) return { character: c, matchedBy: 'exact' }
    }
  }

  // 最长包含匹配：角色名/别名出现在窗口里
  let best: { character: CanvasCharacterRef; len: number } | null = null
  for (const c of characters) {
    for (const key of [c.name, ...c.aliases]) {
      if (key.length < 2) continue
      if ((window.includes(key) || hint.includes(key)) && (!best || key.length > best.len)) {
        best = { character: c, len: key.length }
      }
    }
  }
  return best ? { character: best.character, matchedBy: 'contains' } : null
}

// ============================================================================
// Step 4：上下文拼装（docs/06 §5.1 Step 4）
// ============================================================================

/** 判定用的行视图（Step 2 的产物 + 场景信息） */
export interface AttributionLine {
  id: Id
  seq: number
  kind: LineKind
  /** 可录文本（已剥离引号） */
  text: string
  /** 原文片段 */
  sourceText: string
  cue: CueInfo | null
  cueSpeaker: CanvasCharacterRef | null
  charStart: number
  charEnd: number
  paragraphIndex: number
  sceneIndex: number
  startsParagraph: boolean
  endsParagraph: boolean
  quoteUnmatched: boolean
  tooLong: boolean
}

export interface LineContext {
  lineId: Id
  /** 送入 embedding 的拼接文本 */
  text: string
  parts: {
    cue: string | null
    before: string[]
    after: string[]
    current: string
    prevSpeakerName: string | null
  }
  /** 上下文形态：dialogue-context（引导语优先）/ neighborhood（前后 N 行）/ current-only */
  shape: 'dialogue-context' | 'neighborhood' | 'current-only'
  prevSpeaker: { characterId: Id; name: string } | null
  prevSpeakerIndex: number | null
  /** 由 buildContext 之后由调用方填入（embed 的产物），attributeByVector 只消费它 */
  vector: Float32Array | null
}

export interface BuildContextOptions {
  /** 上一行的说话人（由调用方按已判定的前缀传入，实现「上一个说话人」） */
  priorSpeaker?: { characterId: Id; name: string } | null
  priorSpeakerIndex?: number | null
  /** 向后找引导语的最大距离，默认 CUE_LOOKBACK_DEFAULT */
  cueLookback?: number
  /** 找不到动态上一说话人时，用静态可判定（引导语指名）的上一说话人兜底 */
  staticPriorSpeaker?: { characterId: Id; name: string } | null
}

/**
 * Step 4：上下文拼装。
 *
 * - dialogue / inner：优先「最近引导语」+「当前行」+「上一说话人」（docs/06 §5.1 Step 4 第二句）。
 *   刻意**不**把前后 2 行整段塞进去：那样当前句的语义会被邻居稀释（第五章的实测教训），
 *   真正需要邻居信息的是旁白。
 * - narration：前 N 行 + 当前行 + 后 N 行（N = contextWindow）。
 *
 * 失败不抛错：找不到上下文时退化为 current-only（仍然能判定，只是证据更少）。
 */
export function buildContext(
  lines: AttributionLine[],
  index: number,
  window: number,
  opts?: BuildContextOptions,
): LineContext {
  const line = lines[index]
  const n = Math.max(0, Math.floor(window))
  const cueLookback = opts?.cueLookback ?? CUE_LOOKBACK_DEFAULT

  const before: string[] = []
  const after: string[] = []
  for (let i = Math.max(0, index - n); i < index; i++) before.push(lines[i].sourceText)
  for (let i = index + 1; i <= Math.min(lines.length - 1, index + n); i++) after.push(lines[i].sourceText)

  // 最近的引导语（含「引导语在前一行、台词在本行」这种跨行情况）
  let nearestCue: string | null = null
  for (let i = index; i >= Math.max(0, index - cueLookback); i--) {
    const target = lines[i]
    if (i === index) {
      if (target.cue) {
        nearestCue = target.cue.text
        break
      }
      continue
    }
    if (target.cue) {
      nearestCue = target.cue.text
      break
    }
  }

  const prior = opts?.priorSpeaker ?? opts?.staticPriorSpeaker ?? null
  const prevSpeakerName = prior?.name ?? null

  if (line.kind === 'dialogue' || line.kind === 'inner') {
    const segs: string[] = []
    if (nearestCue) segs.push(nearestCue)
    segs.push(line.text)
    if (prevSpeakerName) segs.push(prevSpeakerName)
    return {
      lineId: line.id,
      text: segs.join('\n'),
      parts: { cue: nearestCue, before: [], after: [], current: line.text, prevSpeakerName },
      shape: nearestCue || prevSpeakerName ? 'dialogue-context' : 'current-only',
      prevSpeaker: prior,
      prevSpeakerIndex: opts?.priorSpeakerIndex ?? null,
      vector: null,
    }
  }

  const segs = [...before, line.text, ...after].filter((s) => s.length > 0)
  return {
    lineId: line.id,
    text: segs.join('\n'),
    parts: { cue: nearestCue, before, after, current: line.text, prevSpeakerName },
    shape: before.length > 0 || after.length > 0 ? 'neighborhood' : 'current-only',
    prevSpeaker: prior,
    prevSpeakerIndex: opts?.priorSpeakerIndex ?? null,
    vector: null,
  }
}

// ============================================================================
// Step 5：向量判定（docs/06 §5.1 Step 5 / §5.2）
// ============================================================================

export type VectorReason =
  | 'accepted'
  | 'below_threshold'
  | 'margin_too_small'
  | 'no_centroids'
  | 'no_query'
  | 'dim_mismatch'

export interface VectorDecision {
  characterId: Id | null
  name: string | null
  /** best.score（未通过阈值时为 best 的原始分数，用于 UI 展示） */
  confidence: number
  /** Top-N 候选（默认 3），按分数降序 */
  candidates: SpeakerCandidate[]
  /** 是否通过 threshold + margin */
  accepted: boolean
  reason: VectorReason
  query: Float32Array | null
}

export interface AttributeOptions {
  /** 归属阈值（默认 CANVAS_DEFAULTS.attributionThreshold = 0.62） */
  threshold?: number
  /** Top1 与 Top2 的最小差值（默认 0.06） */
  margin?: number
  topN?: number
  /** 场景内角色过滤：只在这些角色里排序（docs/06 §5.1 Step 6） */
  restrictTo?: Id[] | null
  /** 显式查询向量（优先于 context.vector） */
  query?: Float32Array | null
}

/**
 * Step 5：余弦判定 + 阈值 + margin。
 *
 * 返回**永远**带 candidates（Top-3）与 confidence —— 这是 UI「告诉用户为什么判给他」的
 * 唯一依据（docs/11 §3）。未通过判定时不猜角色，只把候选与分数交出去。
 *
 * 失败不抛错：无向量/无原型/维度不匹配都通过 `reason` 显式表达，由上层决定降级方式。
 */
export function attributeByVector(
  context: LineContext,
  centroids: CentroidEntry[],
  opts?: AttributeOptions,
): VectorDecision {
  const threshold = opts?.threshold ?? CANVAS_DEFAULTS.attributionThreshold
  const margin = opts?.margin ?? CANVAS_DEFAULTS.attributionMargin
  const topN = opts?.topN ?? 3
  const query = opts?.query ?? context.vector

  if (!query || query.length === 0) {
    return {
      characterId: null, name: null, confidence: 0, candidates: [], accepted: false,
      reason: 'no_query', query: null,
    }
  }
  if (centroids.length === 0) {
    return {
      characterId: null, name: null, confidence: 0, candidates: [], accepted: false,
      reason: 'no_centroids', query,
    }
  }

  const restrict = opts?.restrictTo && opts.restrictTo.length > 0 ? new Set(opts.restrictTo) : null
  const pool = restrict ? centroids.filter((c) => restrict.has(c.characterId)) : centroids
  // 场景过滤后为空 → 退回全量角色表（宁可比得宽，也不要因为场景识别失败而全部判不出）
  const effective = pool.length > 0 ? pool : centroids

  const normalized = l2Normalize(query)
  const candidates = rankCandidates(normalized, effective, topN)
  if (candidates.length === 0) {
    return {
      characterId: null, name: null, confidence: 0, candidates: [], accepted: false,
      reason: 'dim_mismatch', query: normalized,
    }
  }

  const best = candidates[0]
  const second = candidates[1] ?? null
  if (best.score < threshold) {
    return {
      characterId: null, name: null, confidence: best.score, candidates, accepted: false,
      reason: 'below_threshold', query: normalized,
    }
  }
  if (second && best.score - second.score < margin) {
    return {
      characterId: null, name: null, confidence: best.score, candidates, accepted: false,
      reason: 'margin_too_small', query: normalized,
    }
  }

  return {
    characterId: best.characterId, name: best.name, confidence: best.score, candidates,
    accepted: true, reason: 'accepted', query: normalized,
  }
}

// ============================================================================
// Step 6：规则后处理（docs/06 §5.1 Step 6）
// ============================================================================

export interface LineDecision {
  lineId: Id
  characterId: Id | null
  name: string | null
  speakerType: SpeakerType
  confidence: number
  candidates: SpeakerCandidate[]
  decidedBy: DecidedBy
  needsReview: boolean
  /** 判定依据（中文，直接给 UI / 给用户看） */
  reason: string
  /** 向量层的原始结论（保留下来，便于解释与重算对比） */
  vector: VectorDecision | null
  /** 是否命中短句保护 */
  shortLineProtected: boolean
}

/**
 * 「上一说话人」的最小形状（规则后处理里用于连续对白偏向 / 短句保护）。
 *
 * 提成命名类型是刻意的：循环内的 `lastAssigned` 初值为 null，
 * TS 的控制流分析会把它收窄成 null，导致派生变量（prevCharacter / prevId）
 * 反复报 TS7022 / TS2339。用具名类型 + 一次断言把语义钉死，比处处内联对象类型可靠。
 */
interface LastSpeaker {
  characterId: Id
  name: string
}

export interface RulePostProcessOptions {
  characters: CanvasCharacterRef[]
  threshold?: number
  margin?: number
  shortLineChars?: number
  /** 连续对白加成（默认 CONSECUTIVE_BONUS_DEFAULT） */
  consecutiveBonus?: number
  /** 是否启用「场景内角色过滤」 */
  sceneFilter?: boolean
  /** 向量是否真的可用（false → 规则判定为唯一依据） */
  embeddingAvailable?: boolean
}

/**
 * Step 6：规则后处理。按行顺序处理，因为「连续对白」依赖上一行的**最终**结论。
 *
 * 规则优先级（从高到低）：
 *   1. human：decidedBy='human' 的行原样返回 —— 永不覆盖（docs/06 §5.5、docs/11 §3）
 *   2. 引导语明确指名 → 直接覆盖向量结果（规则优先，引导语是强信号）
 *   3. 短句保护：可读字数 < shortLineChars 的行不做向量判定，沿用引导语/上一说话人
 *   4. 场景内角色过滤：已出场角色里有达标候选时，改判为它
 *   5. 连续对白偏向上一说话人（加成后重新比较）
 *   6. 都不成立 → 保持向量结论（未通过阈值时 needsReview=true）
 *
 * 纯函数：不修改入参（返回新数组与新对象）。
 */
export function applyRulePostProcess(
  results: LineDecision[],
  lines: AttributionLine[],
  opts: RulePostProcessOptions,
): LineDecision[] {
  const threshold = opts.threshold ?? CANVAS_DEFAULTS.attributionThreshold
  // 说明：margin 由调用方的 rankCandidates 使用；此处无需重复计算
  const shortLineChars = opts.shortLineChars ?? CANVAS_DEFAULTS.shortLineChars
  const bonus = opts.consecutiveBonus ?? CONSECUTIVE_BONUS_DEFAULT
  const sceneFilter = opts.sceneFilter ?? true
  const embeddingAvailable = opts.embeddingAvailable ?? false

  const out: LineDecision[] = []
  let sceneIndex = -1
  let sceneCharacters = new Set<Id>()
  /** 上一行**最终**指派的角色（仅当上一行是台词/内心行时才对「连续对白」有效） */
  let lastAssigned: LastSpeaker | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const base = results[i] ?? emptyDecision(line)
    const clone: LineDecision = { ...base, candidates: [...base.candidates] }

    if (line.sceneIndex !== sceneIndex) {
      sceneIndex = line.sceneIndex
      sceneCharacters = new Set<Id>()
    }

    // 「上一说话人」只在上一行确实是台词/内心行时成立（docs/06 §5.1 Step 6：上一行是角色 A 的台词）
    const prevLine = i > 0 ? lines[i - 1] : null
    const prevIsSpeakerLine = prevLine != null && (prevLine.kind === 'dialogue' || prevLine.kind === 'inner')
    // 取「上一说话人」时必须**显式断言**类型：`lastAssigned` 的初始值是 null，
    // TS 的控制流分析在循环内会认为它永远是 null（实际会被循环体后半段改写），
    // 于是 `prevCharacter` 被收窄成 never，后面所有字段访问都报 TS2339。
    // 断言表达式是一次「求值」，不再参与收窄，因此拿到真实联合类型。
    const prevCharacter: LastSpeaker | null = prevIsSpeakerLine
      ? (lastAssigned as LastSpeaker | null)
      : null

    // 1) 人工确认过的行：原样返回
    if (base.decidedBy === 'human') {
      clone.reason = '人工确认，重算不覆盖'
      if (clone.characterId && clone.speakerType === 'character') {
        sceneCharacters.add(clone.characterId)
        lastAssigned = { characterId: clone.characterId, name: clone.name ?? '' }
      } else {
        lastAssigned = null
      }
      out.push(clone)
      continue
    }

    const needsSpeaker = line.kind === 'dialogue' || line.kind === 'inner'
    let decided = false

    // 2) 引导语明确指名 → 覆盖
    if (line.cue) {
      const resolved = resolveSpeakerHint(opts.characters, line.cue)
      if (resolved) {
        clone.characterId = resolved.character.id
        clone.name = resolved.character.name
        clone.speakerType = 'character'
        clone.confidence = Math.max(clone.confidence, RULE_CONFIDENCE.cueOverride)
        clone.decidedBy = 'rule'
        clone.needsReview = false
        clone.reason = `引导语指名「${line.cue.speakerWindow ?? line.cue.speakerHint ?? ''}」+ ${line.cue.verb}`
        decided = true
      } else if (needsSpeaker) {
        clone.needsReview = true
        clone.reason = `引导语未能匹配角色表（${line.cue.speakerHint ?? line.cue.speakerWindow ?? '?'}）`
      }
    }

    // 3) 短句保护：长度不足时向量不可靠（docs/06 §5.1 Step 6 / §5.2 短句阈值 6 字）
    const readable = countReadableChars(line.text)
    if (!decided && needsSpeaker && readable < shortLineChars) {
      clone.shortLineProtected = true
      const vectorClaim = clone.vector?.accepted === true && clone.vector.characterId != null
      if (prevCharacter) {
        clone.characterId = prevCharacter.characterId
        clone.name = prevCharacter.name
        clone.speakerType = 'character'
        clone.confidence = Math.max(RULE_CONFIDENCE.shortLine, vectorClaim ? clone.confidence : 0)
        clone.decidedBy = 'rule'
        clone.needsReview = false
        clone.reason = `短句保护（${readable} 字 < ${shortLineChars}），沿用上一说话人`
        decided = true
      } else if (!vectorClaim) {
        clone.characterId = null
        clone.name = null
        clone.speakerType = 'narration'
        clone.confidence = 0
        clone.decidedBy = 'rule'
        clone.needsReview = true
        clone.reason = `短句保护（${readable} 字 < ${shortLineChars}）且无可用上下文`
        decided = true
      }
    }

    // 4) 场景内角色过滤：向量判到场景外角色时，改判场景内达标候选
    if (!decided && sceneFilter && clone.vector?.accepted === true && clone.characterId) {
      const inScene = sceneCharacters.has(clone.characterId)
      if (!inScene && sceneCharacters.size > 0) {
        const sceneCandidate = clone.candidates.find(
          (c) => sceneCharacters.has(c.characterId) && c.score >= threshold,
        )
        if (sceneCandidate) {
          clone.characterId = sceneCandidate.characterId
          clone.name = sceneCandidate.name
          clone.confidence = sceneCandidate.score
          clone.decidedBy = 'vector'
          clone.needsReview = false
          clone.reason = `场景内角色过滤（场外候选 ${clone.vector.name ?? ''} 被排除）`
          decided = true
        }
      }
    }

    // 5) 连续对白偏向上一说话人（docs/06 §5.1 Step 6）
    //    做法：把上一说话人的候选分数抬高 `bonus` 后再与「向量已接受的结果」比较。
    //    · 向量没接受（低于阈值 / margin 不足）→ 直接沿用上一说话人
    //    · 向量接受了别人，但上一说话人「加成后」反超 → 改判为上一说话人
    //    · 向量以超过 bonus 的差距明确指向别人 → 尊重向量（「偏向」而非「强制」）
    if (!decided && needsSpeaker && !line.cue && prevCharacter) {
      if (clone.characterId === prevCharacter.characterId) {
        clone.speakerType = 'character'
        clone.needsReview = clone.confidence < threshold
        clone.reason = `${clone.reason || '与上一行同一说话人'}；与上一行同一说话人`
        decided = true
      } else {
        // 显式标注（`Id` / `string` / `number`）：`prevCharacter` 是循环内的
        // 控制流敏感变量，TS 对从这里派生的 const 会报 TS7022（诊断成循环引用）。
        // 标注后语义不变，只是把推断结果钉死。
        const prevId: Id = prevCharacter.characterId
        const prevName: string = prevCharacter.name
        const prevBoosted: number =
          (clone.candidates.find((c) => c.characterId === prevId)?.score ?? 0) + bonus
        const bestScore = clone.candidates[0]?.score ?? 0
        const bestIsPrev = clone.candidates[0]?.characterId === prevId
        const boostedBest = bestIsPrev ? bestScore + bonus : bestScore
        const vectorAcceptedOther = clone.vector?.accepted === true && clone.characterId != null
        const override =
          !embeddingAvailable ||
          !vectorAcceptedOther ||
          (prevBoosted >= threshold && prevBoosted >= boostedBest)
        if (override) {
          clone.characterId = prevId
          clone.name = prevName
          clone.speakerType = 'character'
          clone.confidence = Math.max(RULE_CONFIDENCE.consecutive, Math.min(prevBoosted, 0.99))
          clone.decidedBy = 'rule'
          clone.needsReview = false
          clone.reason = embeddingAvailable
            ? '连续对白（无引导语），偏向上一说话人'
            : '连续对白（无引导语，向量不可用），沿用上一说话人'
          decided = true
        } else if (!clone.characterId) {
          clone.reason = `${clone.reason || '向量未达阈值'}；上一行说话人为「${prevName}」，待人工确认`
        }
      }
    }

    // 6) 收尾：未指派的行
    if (needsSpeaker && !clone.characterId) {
      clone.speakerType = 'narration'
      clone.needsReview = true
      if (!clone.reason) {
        clone.reason = describeVectorReason(clone.vector)
      }
    } else if (!needsSpeaker) {
      clone.characterId = null
      clone.name = null
      clone.speakerType = 'narration'
      clone.confidence = 0
      clone.needsReview = false
      clone.reason = line.kind === 'sfx_note' ? '音效提示行（不参与配音）' : '旁白行'
    }

    if (clone.characterId && clone.speakerType === 'character') {
      sceneCharacters.add(clone.characterId)
      lastAssigned = { characterId: clone.characterId, name: clone.name ?? '' }
    } else {
      lastAssigned = null
    }

    out.push(clone)
  }

  return out
}

function emptyDecision(line: AttributionLine): LineDecision {
  return {
    lineId: line.id,
    characterId: null,
    name: null,
    speakerType: 'narration',
    confidence: 0,
    candidates: [],
    decidedBy: 'rule',
    needsReview: false,
    reason: '',
    vector: null,
    shortLineProtected: false,
  }
}

/** 把向量失败原因翻译成给用户看的中文（docs/11 §3「用户必须能理解为什么判错」） */
export function describeVectorReason(vector: VectorDecision | null): string {
  if (!vector) return '无向量结论（规则判定）'
  switch (vector.reason) {
    case 'accepted':
      return `语义判定：${vector.name ?? ''}（${vector.confidence.toFixed(2)}）`
    case 'below_threshold':
      return `最高相似度 ${vector.confidence.toFixed(2)} 低于阈值`
    case 'margin_too_small':
      return `前两名差距过小（${vector.candidates.map((c) => `${c.name} ${c.score.toFixed(2)}`).join(' / ')}）`
    case 'no_centroids':
      return '角色原型向量为空（需先确认角色表）'
    case 'no_query':
      return '未计算向量（未启用语义判定或行太短）'
    case 'dim_mismatch':
      return '向量维度与角色原型不一致（可能换过模型）'
  }
}

// ============================================================================
// Step 8：停顿推断（docs/11 §2.3 / constants.PAUSE_RULES）
// ============================================================================

export interface PauseOptions {
  /** 下一行说话人（用于场景切换判定） */
  nextSpeakerId?: Id | null
  /** 下一行是否段落首行 */
  nextStartsParagraph?: boolean
  /** 本行是否段落末行 */
  paragraphEnd?: boolean
  /** 全局节奏系数（TEMPO_PRESETS.factor：0.8 / 1.0 / 1.3） */
  tempoFactor?: number
  defaultPauseMs?: number
  kind?: LineKind
  /** 显式标记的停顿（人工设定），优先级最高 */
  explicitPauseMs?: number | null
  /** 覆盖停顿表（PAUSE_RULES 的可配置版本） */
  rules?: ReadonlyArray<{ label: string; match: string; pauseMs: number }>
  inlineMinChars?: number
}

export interface PauseResult {
  pauseAfterMs: number
  /** 句内停顿插入点（字符索引），无则 null */
  pauseInline: number[] | null
  /** 命中的停顿规则名（可直接显示在 UI 上） */
  ruleLabel: string
  tempoFactor: number
}

/**
 * Step 8：停顿推断。数值全部来自 {@link PAUSE_RULES}（docs/11 §2.3），再乘全局节奏系数。
 *
 * 两条补充约定（docs §2.3 表末两行是「覆盖式」规则）：
 *   · 场景切换（说话人变化 + 段落结束）→ 1200 ms
 *   · 连续对白（同一角色）→ 350 ms：在标点基线之上取较小值，让对话更紧凑
 *
 * 失败不抛错：无法匹配任何规则时用 defaultPauseMs（默认 500）。
 */
export function inferPause(
  text: string,
  nextLine: string | null,
  prevSpeaker: Id | null,
  curSpeaker: Id | null,
  opts?: PauseOptions,
): PauseResult {
  const tempoFactor = opts?.tempoFactor ?? 1
  const rules = opts?.rules ?? PAUSE_RULES
  const defaultPause = opts?.defaultPauseMs ?? CANVAS_DEFAULTS.defaultPauseAfterMs
  const findRule = (match: string) => rules.find((r) => r.match === match)

  let pauseMs = defaultPause
  let label = '默认留白'

  const trimTail = text.replace(/[\s”」』'"）)】]+$/g, '')
  const hasNext = typeof nextLine === 'string' && nextLine.trim().length > 0
  const paragraphEnd = opts?.paragraphEnd ?? !hasNext
  const sameSpeakerDialogue =
    opts?.kind === 'dialogue' && prevSpeaker != null && curSpeaker != null && prevSpeaker === curSpeaker

  if (opts?.explicitPauseMs != null) {
    pauseMs = opts.explicitPauseMs
    label = '显式标记覆盖'
  } else if (
    opts?.nextSpeakerId != null && curSpeaker != null && opts.nextSpeakerId !== curSpeaker &&
    (paragraphEnd || opts.nextStartsParagraph === true)
  ) {
    const r = findRule('__scene_change__')
    pauseMs = r?.pauseMs ?? 1200
    label = r?.label ?? '场景切换'
  } else if (paragraphEnd) {
    const r = findRule('\\n\\n')
    pauseMs = r?.pauseMs ?? 900
    label = r?.label ?? '段落结束'
  } else if (/……$|…$|—$|——$/.test(trimTail)) {
    const r = findRule('……')
    pauseMs = r?.pauseMs ?? 700
    label = r?.label ?? '省略号/破折号'
  } else if (/！$|!$/.test(trimTail)) {
    const r = findRule('！')
    pauseMs = r?.pauseMs ?? 450
    label = r?.label ?? '感叹号结尾'
  } else if (/？$|\?$/.test(trimTail)) {
    const r = findRule('？')
    pauseMs = r?.pauseMs ?? 450
    label = r?.label ?? '问号结尾'
  } else if (/。$|；$|;$/.test(trimTail)) {
    const r = findRule('。')
    pauseMs = r?.pauseMs ?? 500
    label = r?.label ?? '句号结尾'
  } else if (/，$|,$/.test(trimTail)) {
    const r = findRule('，')
    pauseMs = r?.pauseMs ?? 200
    label = r?.label ?? '逗号结尾（分行未断句）'
  } else if (sameSpeakerDialogue) {
    const r = findRule('__same_speaker__')
    pauseMs = r?.pauseMs ?? 350
    label = r?.label ?? '连续对白（同一角色）'
  }

  if (sameSpeakerDialogue && label !== '连续对白（同一角色）' && label !== '显式标记覆盖') {
    const r = findRule('__same_speaker__')
    const compact = r?.pauseMs ?? 350
    if (pauseMs > compact) {
      pauseMs = compact
      label = `${r?.label ?? '连续对白'}（覆盖基线）`
    }
  }

  const scaled = Math.max(0, Math.round(pauseMs * tempoFactor))

  // 句内停顿：长句在逗号处给一口气，避免配音演员一口气念到底
  const inlineMin = opts?.inlineMinChars ?? PAUSE_INLINE_MIN_CHARS
  const pauseInline: number[] = []
  if (countReadableChars(text) >= inlineMin) {
    let last = -PAUSE_INLINE_MIN_SPACING
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if ((ch === '，' || ch === '、' || ch === ',') && i > 0 && i < text.length - 1 && i - last >= PAUSE_INLINE_MIN_SPACING) {
        pauseInline.push(i)
        last = i
      }
    }
  }

  return {
    pauseAfterMs: scaled,
    pauseInline: pauseInline.length > 0 ? pauseInline : null,
    ruleLabel: label,
    tempoFactor,
  }
}

// ============================================================================
// Step 7：情绪/语速推断（词表优先，docs/06 §7.2「本地优先」/ §6.3）
// ============================================================================

export interface TagInferenceInput {
  text: string
  kind?: LineKind
}

export interface TagInferenceOptions {
  enabled?: boolean
  defaultEmotion?: string
  /** 是否允许把未命中的行留给上层调 LLM（本函数**不会**自己调 LLM） */
  llmEnabled?: boolean
  lexicon?: typeof EMOTION_LEXICON
}

export interface TagInferenceResult {
  emotion: string | null
  emotionIntensity: number | null
  speed: SpeedMark | null
  /** 命中的关键词 */
  matched: string[]
  source: 'lexicon' | 'none'
  /** true 表示「词表未命中且开启了 LLM」→ 由上层决定是否调 LLM（docs/06 §6.3） */
  needsLlm: boolean
}

/**
 * Step 7：情绪/语速推断。
 *
 * **纯词表优先**：命中词表的行绝不调 LLM（省 token，docs/06 §7.2）。
 * 未命中且 `llmEnabled=true` 时返回 `needsLlm=true`，把调用权留给上层
 * （上层用 docs/06 §6.3 的 `emotion_tag` prompt 批量处理）。
 *
 * `enabled=false` 时**完全不标注**（emotion 返回 null）：画本行留空由角色表的
 * `defaultEmotion` 继承（docs/11 §4.6「默认表演参数：画本行未指定时继承」）。
 *
 * 失败不抛错：未命中返回 source='none'，emotion 用 defaultEmotion（默认「平静」）。
 */
export function inferTags(line: TagInferenceInput, options?: TagInferenceOptions): TagInferenceResult {
  const enabled = options?.enabled ?? true
  const defaultEmotion = options?.defaultEmotion ?? CANVAS_DEFAULTS.defaultEmotion
  const lexicon = options?.lexicon ?? EMOTION_LEXICON

  if (!enabled) {
    return {
      emotion: null, emotionIntensity: null, speed: null,
      matched: [], source: 'none', needsLlm: false,
    }
  }

  const text = line.text ?? ''
  let best: { entry: (typeof EMOTION_LEXICON)[number]; hits: string[]; score: number } | null = null

  for (const entry of lexicon) {
    const hits: string[] = []
    let score = 0
    for (const kw of entry.keywords) {
      if (text.includes(kw)) {
        hits.push(kw)
        score += kw.length
      }
    }
    if (hits.length === 0) continue
    if (!best || score > best.score) best = { entry, hits, score }
  }

  if (!best) {
    return {
      emotion: defaultEmotion,
      emotionIntensity: null,
      speed: null,
      matched: [],
      source: 'none',
      needsLlm: options?.llmEnabled === true,
    }
  }

  return {
    emotion: best.entry.emotion,
    emotionIntensity: best.entry.intensity,
    speed: best.entry.speed,
    matched: best.hits,
    source: 'lexicon',
    needsLlm: false,
  }
}

// ============================================================================
// 主入口：生成画本（Step 1 ~ Step 8 编排，Step 9 由 main 层 service 落库）
// ============================================================================

export interface CanvasLimits {
  maxLineChars?: number
  shortLineChars?: number
  maxNarrationRun?: number
  maxDialogueRun?: number
  contextWindow?: number
  attributionThreshold?: number
  attributionMargin?: number
  autoAcceptConfidence?: number
  defaultPauseAfterMs?: number
  /** 向量分批大小（docs/06 §4.3，默认 16） */
  embedBatchSize?: number
  /** LLM 复核每批行数（docs/06 §6.2，默认 20） */
  llmBatchSize?: number
  consecutiveBonus?: number
  sceneFilter?: boolean
  cueLookback?: number
}

export interface CanvasGenerateInput {
  chapterId: Id
  bookId: Id
  chapterTitle?: string
  chapterText: string
  /** 已确认的角色表（含原型向量）。为空 → 走「角色表为空」降级（docs/06 §8） */
  characters: CanvasCharacterRef[]
  options: CanvasGenerateOptions
  /** 全局节奏系数（TEMPO_PRESETS.factor），默认 1 */
  tempoFactor?: number
  /** 注入的向量提供者；不注入 → embeddingUsed=false，纯规则判定，不抛错 */
  embed?: EmbeddingProvider
  /** 注入的 LLM 复核；不注入 → llmUsed=false */
  llm?: LlmReviewer
  signal?: AbortSignal
  /** 已存在的行（用于保护 decidedBy='human'，docs/06 §5.5） */
  existingLines?: CanvasLine[]
  idFactory?: (seq: number) => Id
  includeTitleLine?: boolean
  limits?: CanvasLimits
  now?: () => number
}

export interface CanvasGenerateDraft {
  id: Id
  chapterId: Id
  bookId: Id
  seq: number
  speakerType: SpeakerType
  characterId: Id | null
  characterName: string | null
  kind: LineKind
  text: string
  sourceText: string | null
  charStart: number
  charEnd: number
  emotion: string | null
  emotionIntensity: number | null
  speed: SpeedMark | null
  gainDb: number | null
  pauseAfterMs: number
  pauseInline: number[] | null
  pronunciation: string | null
  note: string | null
  state: LineState
  confidence: number | null
  candidates: SpeakerCandidate[] | null
  decidedBy: DecidedBy | null
  needsReview: boolean
  flags: string[]
  isTitle: boolean
  /** 判定依据（UI 直接展示） */
  attributionReason: string
  /** 命中的停顿规则名 */
  pauseRule: string
  cue: CueInfo | null
  tooLong: boolean
  paragraphIndex: number
  sceneIndex: number
  /**
   * 该行判定时用的向量（已 L2 归一化）；未做向量判定时为 null。
   * Step 9 落库需要它：写 `line_embeddings` + 增量更新 `character_centroids`（docs/06 §5.1 Step 8）。
   */
  vector: Float32Array | null
}

export interface CanvasGenerateOutput {
  lines: CanvasGenerateDraft[]
  report: CanvasGenerateReport
}

/** 生效的限制值（CANVAS_DEFAULTS ← CanvasGenerateOptions ← input.limits） */
function resolveLimits(input: CanvasGenerateInput): Required<CanvasLimits> {
  const o = input.options
  const l = input.limits ?? {}
  return {
    maxLineChars: l.maxLineChars ?? CANVAS_DEFAULTS.maxLineChars,
    shortLineChars: l.shortLineChars ?? CANVAS_DEFAULTS.shortLineChars,
    maxNarrationRun: l.maxNarrationRun ?? CANVAS_DEFAULTS.maxNarrationRun,
    maxDialogueRun: l.maxDialogueRun ?? CANVAS_DEFAULTS.maxDialogueRun,
    contextWindow: l.contextWindow ?? o.contextWindow ?? CANVAS_DEFAULTS.contextWindow,
    attributionThreshold: l.attributionThreshold ?? o.threshold ?? CANVAS_DEFAULTS.attributionThreshold,
    attributionMargin: l.attributionMargin ?? o.margin ?? CANVAS_DEFAULTS.attributionMargin,
    autoAcceptConfidence: l.autoAcceptConfidence ?? CANVAS_DEFAULTS.autoAcceptConfidence,
    defaultPauseAfterMs: l.defaultPauseAfterMs ?? CANVAS_DEFAULTS.defaultPauseAfterMs,
    embedBatchSize: l.embedBatchSize ?? 16,
    llmBatchSize: l.llmBatchSize ?? 20,
    consecutiveBonus: l.consecutiveBonus ?? CONSECUTIVE_BONUS_DEFAULT,
    sceneFilter: l.sceneFilter ?? true,
    cueLookback: l.cueLookback ?? CUE_LOOKBACK_DEFAULT,
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError('TASK_CANCELLED', { details: { reason: signal.reason ?? 'aborted' } })
  }
}

/** 把任意 embed 异常翻译成显式降级（docs/06 §8：embedding 缺失/损坏/OOM 都不阻断流程） */
export function describeEmbeddingFailure(e: unknown): { key: string; warning: string } {
  const message = e instanceof Error ? e.message : String(e)
  if (/out of memory|oom|enomem|bad_alloc/i.test(message)) {
    return { key: 'MODEL_OOM', warning: 'MODEL_OOM: 向量推理内存不足，已降级为规则判定（docs/06 §8）' }
  }
  return {
    key: 'CANVAS_EMBEDDING_UNAVAILABLE',
    warning: 'CANVAS_EMBEDDING_UNAVAILABLE: 语义模型不可用，已降级为规则判定（docs/06 §8）',
  }
}

/**
 * 画本生成主入口（Step 1 ~ Step 8；Step 9 落库在 main 层 service）。
 *
 * 降级是**显式**的：
 *   · 未注入 `embed` 或 `options.useEmbedding=false` → `report.embeddingUsed=false` + 警告，
 *     流程照常按规则判定产出结果（绝不抛错、绝不静默返回空数组）
 *   · `embed` 注入但调用失败 → catch，写警告，继续用规则判定
 *   · 角色表为空 → 警告 + 所有 dialogue 行进 needsReview
 *   · LLM 复核失败 → 警告 + llmUsed=false（docs/06 §6.4「不阻塞用户」）
 *
 * 失败时抛：AppError('CANVAS_CHAPTER_EMPTY')（章节为空）/ AppError('TASK_CANCELLED')（取消）。
 */
export async function generateCanvasLines(input: CanvasGenerateInput): Promise<CanvasGenerateDraft[]> {
  const output = await generateCanvas(input)
  return output.lines
}

/**
 * 与 {@link generateCanvasLines} 相同，但同时返回 `CanvasGenerateReport`（docs/11 §2.4）。
 * main 层 service 用这个版本（一次编排同时拿到行与报告，不重复推理）。
 */
export async function generateCanvas(input: CanvasGenerateInput): Promise<CanvasGenerateOutput> {
  const limits = resolveLimits(input)
  const startedAt = input.now ? input.now() : Date.now()
  const warnings: string[] = []
  const o = input.options

  const text = input.chapterText ?? ''
  if (text.trim().length === 0) {
    throw new AppError('CANVAS_CHAPTER_EMPTY', { details: { chapterId: input.chapterId } })
  }
  throwIfAborted(input.signal)

  // ---- 人工保护（docs/06 §5.5）：已有人工行时明确告知，但不抛错 ----
  const existing = input.existingLines ?? []
  const humanLines = existing.filter((l) => l.decidedBy === 'human')
  const humanBySeq = new Map<number, CanvasLine>()
  for (const l of humanLines) humanBySeq.set(l.seq, l)
  if (humanLines.length > 0 && !o.overwriteHuman) {
    warnings.push(`CANVAS_ALREADY_EDITED: 本章已有 ${humanLines.length} 行人工确认，重算将保留它们`)
  }

  // ---- Step 1：分句 ----
  const drafts = splitToLines(text, { maxLineChars: limits.maxLineChars })

  // ---- Step 2：规则粗筛 ----
  const characters = input.characters ?? []
  const lines: AttributionLine[] = []
  let seq = 0
  const idOf = input.idFactory ?? ((n: number) => `${input.chapterId}-L${String(n).padStart(5, '0')}`)

  if (input.includeTitleLine === true && input.chapterTitle) {
    lines.push({
      id: idOf(seq),
      seq,
      kind: 'narration',
      text: input.chapterTitle,
      sourceText: input.chapterTitle,
      cue: null,
      cueSpeaker: null,
      charStart: 0,
      charEnd: 0,
      paragraphIndex: -1,
      sceneIndex: -1,
      startsParagraph: true,
      endsParagraph: true,
      quoteUnmatched: false,
      tooLong: countReadableChars(input.chapterTitle) > limits.maxLineChars,
    })
    seq++
  }

  // 场景划分（docs/06 §5.1 Step 6「场景内角色过滤」）：段落切换且已跨过 ≥3 行即视为新场景
  let sceneIndex = -1
  let sceneLineCount = 0
  for (const d of drafts) {
    const cls = classifyKind(d.text)
    const cueSpeaker = cls.cue ? resolveSpeakerHint(characters, cls.cue)?.character ?? null : null
    if (d.startsParagraph && (sceneLineCount >= 3 || sceneIndex < 0)) {
      sceneIndex++
      sceneLineCount = 0
    }
    sceneLineCount++
    lines.push({
      id: idOf(seq),
      seq,
      kind: cls.kind,
      text: cls.text,
      sourceText: d.text,
      cue: cls.cue,
      cueSpeaker,
      charStart: d.charStart,
      charEnd: d.charEnd,
      paragraphIndex: d.paragraphIndex,
      sceneIndex: Math.max(0, sceneIndex),
      startsParagraph: d.startsParagraph,
      endsParagraph: d.endsParagraph,
      quoteUnmatched: d.quoteUnmatched || cls.unbalanced,
      tooLong: d.tooLong,
    })
    seq++
  }

  // ---- Step 3：角色表 ----
  if (characters.length === 0) {
    warnings.push('角色表为空：已跳过归属判定，请在角色表中确认候选后再重算（docs/06 §8）')
  }

  const centroids: CentroidEntry[] = []
  for (const c of characters) {
    if (!c.centroid || c.centroid.length === 0) continue
    const { centroid } = computeCentroid([c.centroid], { outlierThreshold: -1 })
    centroids.push({ characterId: c.id, name: c.name, vector: centroid })
  }

  // 注入的 provider 先落到局部常量：后续 await 之间不必再依赖对 input 的属性收窄
  const embedProvider = input.embed
  const llmReviewer = input.llm

  const wantEmbedding =
    o.useEmbedding === true && embedProvider != null && centroids.length > 0 && characters.length > 0
  let embeddingUsed = false

  // ---- Step 4 + 5：上下文拼装 + 批量向量判定 ----
  const contexts: Array<LineContext | null> = new Array(lines.length).fill(null)
  const vectorDecisions: Array<VectorDecision | null> = new Array(lines.length).fill(null)

  if (wantEmbedding && embedProvider) {
    try {
      // 静态上一说话人：只依据引导语（确定性信号），避免与「动态上一说话人」循环依赖
      const staticPrior = (index: number): { characterId: Id; name: string } | null => {
        for (let i = index - 1; i >= Math.max(0, index - limits.cueLookback); i--) {
          const l = lines[i]
          if (l.cueSpeaker) return { characterId: l.cueSpeaker.id, name: l.cueSpeaker.name }
        }
        return null
      }

      const needVector: number[] = []
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        const needsSpeaker = l.kind === 'dialogue' || l.kind === 'inner'
        if (!needsSpeaker) continue
        if (countReadableChars(l.text) < limits.shortLineChars) continue // 短句保护：不做向量判定
        needVector.push(i)
      }

      for (const i of needVector) {
        contexts[i] = buildContext(lines, i, limits.contextWindow, {
          staticPriorSpeaker: staticPrior(i),
          cueLookback: limits.cueLookback,
        })
      }

      const batch = Math.max(1, Math.floor(limits.embedBatchSize))
      for (let start = 0; start < needVector.length; start += batch) {
        throwIfAborted(input.signal)
        const slice = needVector.slice(start, start + batch)
        const texts = slice.map((i) => contexts[i]!.text)
        const vectors = await embedProvider.embed(texts, input.signal)
        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
          throw new AppError('INVALID_PAYLOAD', {
            details: { op: 'EmbeddingProvider.embed', expected: texts.length, got: vectors?.length },
          })
        }
        slice.forEach((lineIndex, k) => {
          const v = vectors[k]
          if (!v || v.length !== embedProvider.dim) return // 维度不符的样本跳过（当作无向量）
          contexts[lineIndex]!.vector = l2Normalize(v)
        })
      }
      embeddingUsed = true
    } catch (e) {
      if (e instanceof AppError && e.key === 'TASK_CANCELLED') throw e
      if ((e as { name?: string })?.name === 'AbortError') {
        throw new AppError('TASK_CANCELLED', { cause: e })
      }
      const info = describeEmbeddingFailure(e)
      warnings.push(info.warning)
      embeddingUsed = false
      for (let i = 0; i < contexts.length; i++) contexts[i] = null
    }
  } else if (o.useEmbedding === true && embedProvider == null) {
    warnings.push('CANVAS_EMBEDDING_UNAVAILABLE: 未注入语义模型，本次为规则判定（docs/06 §8）')
  } else if (o.useEmbedding === true && centroids.length === 0 && characters.length > 0) {
    warnings.push('CANVAS_EMBEDDING_UNAVAILABLE: 角色原型向量缺失，本次为规则判定（docs/03 §5.3 冷启动）')
  }

  if (embeddingUsed) {
    for (let i = 0; i < lines.length; i++) {
      const ctx = contexts[i]
      if (!ctx) continue
      vectorDecisions[i] = attributeByVector(ctx, centroids, {
        threshold: limits.attributionThreshold,
        margin: limits.attributionMargin,
        topN: 3,
      })
    }
  }

  // ---- Step 6：规则后处理 ----
  const initial: LineDecision[] = lines.map((l, i) => {
    const v = vectorDecisions[i]
    if (v && v.accepted && v.characterId) {
      return {
        lineId: l.id,
        characterId: v.characterId,
        name: v.name,
        speakerType: 'character' as SpeakerType,
        confidence: v.confidence,
        candidates: v.candidates,
        decidedBy: 'vector' as DecidedBy,
        needsReview: false,
        reason: describeVectorReason(v),
        vector: v,
        shortLineProtected: false,
      }
    }
    return {
      lineId: l.id,
      characterId: null,
      name: null,
      speakerType: 'narration' as SpeakerType,
      confidence: v ? v.confidence : 0,
      candidates: v ? v.candidates : [],
      decidedBy: 'rule' as DecidedBy,
      needsReview: false,
      reason: v ? describeVectorReason(v) : '',
      vector: v ?? null,
      shortLineProtected: false,
    }
  })

  let decisions = applyRulePostProcess(initial, lines, {
    characters,
    threshold: limits.attributionThreshold,
    margin: limits.attributionMargin,
    shortLineChars: limits.shortLineChars,
    consecutiveBonus: limits.consecutiveBonus,
    sceneFilter: limits.sceneFilter && characters.length > 0,
    embeddingAvailable: embeddingUsed,
  })

  // ---- Step 7：人工行还原（decidedBy='human' 永不覆盖） ----
  if (humanBySeq.size > 0) {
    decisions = decisions.map((d, i) => {
      const line = lines[i]
      const human = humanBySeq.get(line.seq)
      if (!human || o.overwriteHuman) return d
      return {
        ...d,
        characterId: human.characterId,
        name: characters.find((c) => c.id === human.characterId)?.name ?? null,
        speakerType: human.speakerType,
        confidence: human.confidence ?? d.confidence,
        candidates: human.candidates ?? d.candidates,
        decidedBy: 'human' as DecidedBy,
        needsReview: human.needsReview,
        reason: '人工确认，重算不覆盖（decided_by=human）',
      }
    })
  }

  // ---- Step 7b：LLM 低置信复核（L3，可选） ----
  // 只送「真的低置信」的行：needsReview 且 confidence < autoAcceptConfidence
  // （docs/06 §7.2「LLM 只处理低置信行，通常占 10~20%」；autoAccept 是这条线的来源）
  let llmUsed = false
  if (o.useLlm === true && llmReviewer != null) {
    const reviewIdx = decisions
      .map((d, i) => ({ d, i }))
      .filter(({ d, i }) => d.needsReview && d.decidedBy !== 'human' &&
        d.confidence < limits.autoAcceptConfidence &&
        (lines[i].kind === 'dialogue' || lines[i].kind === 'inner'))
      .map(({ i }) => i)

    if (reviewIdx.length > 0) {
      try {
        const batchSize = Math.max(1, Math.floor(limits.llmBatchSize))
        const applied: LineDecision[] = [...decisions]
        for (let start = 0; start < reviewIdx.length; start += batchSize) {
          throwIfAborted(input.signal)
          const slice = reviewIdx.slice(start, start + batchSize)
          const items = slice.map((i) => ({
            lineId: lines[i].id,
            seq: lines[i].seq,
            text: lines[i].text,
            kind: lines[i].kind,
            context: contexts[i]
              ? [contexts[i]!.parts.current, ...contexts[i]!.parts.before, ...contexts[i]!.parts.after]
              : [lines[i].text],
          }))
          const reviewed = await llmReviewer.reviewBatch({
            chapterId: input.chapterId,
            items,
            characters: characters.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
            signal: input.signal,
          })
          if (!Array.isArray(reviewed)) throw new AppError('INVALID_PAYLOAD', { details: { op: 'LlmReviewer.reviewBatch' } })
          const allowedIds = new Set(items.map((it) => it.lineId))
          for (const r of reviewed) {
            // 幻觉 ID 直接丢弃（docs/06 §6.4 三层防护之语义层）
            if (!allowedIds.has(r.lineId)) continue
            const idx = slice[items.findIndex((it) => it.lineId === r.lineId)]
            if (idx == null) continue
            const target = characters.find((c) => c.name === r.speaker || c.aliases.includes(r.speaker))
            if (!target) continue
            if (!(r.confidence >= limits.attributionThreshold)) continue
            applied[idx] = {
              ...applied[idx],
              characterId: target.id,
              name: target.name,
              speakerType: 'character',
              confidence: r.confidence,
              decidedBy: 'llm',
              needsReview: false,
              reason: `AI 复核（置信度 ${r.confidence.toFixed(2)}）`,
            }
          }
          llmUsed = true
        }
        decisions = applied
      } catch (e) {
        if (e instanceof AppError && e.key === 'TASK_CANCELLED') throw e
        if ((e as { name?: string })?.name === 'AbortError') throw new AppError('TASK_CANCELLED', { cause: e })
        warnings.push('CANVAS_LLM_UNAVAILABLE: 智能复核不可用，低置信行已全部进入待确认列表（docs/06 §6.4）')
        llmUsed = false
      }
    } else {
      llmUsed = true // 没有需要复核的行：视为「本次不需要 LLM」，报告里记为可用
    }
  }

  // ---- Step 8：标记推断 + 停顿推断，组装最终行 ----
  const draftsOut: CanvasGenerateDraft[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const d = decisions[i]

    const tags = inferTags(
      { text: line.text, kind: line.kind },
      { enabled: o.inferTags === true, defaultEmotion: CANVAS_DEFAULTS.defaultEmotion, llmEnabled: false },
    )

    const next = i + 1 < lines.length ? lines[i + 1] : null
    const nextDecision = i + 1 < decisions.length ? decisions[i + 1] : null
    const prevDecision = i > 0 ? decisions[i - 1] : null
    const pause = inferPause(
      line.text,
      next ? next.text : null,
      prevDecision && prevDecision.speakerType === 'character' ? prevDecision.characterId : null,
      d.speakerType === 'character' ? d.characterId : null,
      {
        // 场景切换：下一行说话人不同 + 段落边界（docs/11 §2.3）
        nextSpeakerId:
          nextDecision && nextDecision.speakerType === 'character' ? nextDecision.characterId : null,
        paragraphEnd: line.endsParagraph || next === null,
        nextStartsParagraph: next ? next.startsParagraph : false,
        tempoFactor: input.tempoFactor ?? 1,
        defaultPauseMs: limits.defaultPauseAfterMs,
        kind: line.kind,
      },
    )

    const flags: string[] = []
    if (line.quoteUnmatched) flags.push('quote_unmatched')
    if (line.tooLong) flags.push('too_long')
    if (d.shortLineProtected) flags.push('short_line')

    const assigned = d.characterId != null && d.speakerType === 'character'
    const speakerType: SpeakerType = line.kind === 'narration' || line.kind === 'sfx_note' ? 'narration' : (assigned ? 'character' : 'narration')
    const human = humanBySeq.get(line.seq)
    const preserveHuman = human != null && !o.overwriteHuman

    draftsOut.push({
      id: line.id,
      chapterId: input.chapterId,
      bookId: input.bookId,
      seq: line.seq,
      speakerType,
      characterId: speakerType === 'character' ? d.characterId : null,
      characterName: speakerType === 'character' ? d.name : null,
      kind: line.kind,
      text: line.text,
      sourceText: line.sourceText,
      charStart: line.charStart,
      charEnd: line.charEnd,
      emotion: preserveHuman ? human!.emotion : tags.emotion,
      emotionIntensity: preserveHuman ? human!.emotionIntensity : tags.emotionIntensity,
      speed: preserveHuman ? human!.speed : tags.speed,
      gainDb: preserveHuman ? human!.gainDb : null,
      pauseAfterMs: preserveHuman ? human!.pauseAfterMs : pause.pauseAfterMs,
      pauseInline: preserveHuman ? human!.pauseInline : pause.pauseInline,
      pronunciation: preserveHuman ? human!.pronunciation : null,
      note: preserveHuman ? human!.note : null,
      state: preserveHuman ? human!.state : 'draft',
      confidence: speakerType === 'character' ? d.confidence : null,
      candidates: d.candidates.length > 0 ? d.candidates : null,
      decidedBy: d.decidedBy,
      needsReview: d.needsReview || (line.quoteUnmatched && speakerType !== 'character'),
      flags: preserveHuman ? human!.flags : flags,
      isTitle: false,
      attributionReason: d.reason,
      pauseRule: pause.ruleLabel,
      cue: line.cue,
      tooLong: line.tooLong,
      paragraphIndex: line.paragraphIndex,
      sceneIndex: line.sceneIndex,
      vector: contexts[i]?.vector ?? null,
    })
  }

  const elapsedMs = (input.now ? input.now() : Date.now()) - startedAt
  const report = buildGenerateReport({
    chapterId: input.chapterId,
    lines: draftsOut,
    elapsedMs,
    embeddingUsed,
    llmUsed,
    warnings,
    characters,
  })

  return { lines: draftsOut, report }
}

// ============================================================================
// 生成报告（docs/11 §2.4）
// ============================================================================

export interface BuildReportInput {
  chapterId: Id
  lines: CanvasGenerateDraft[]
  elapsedMs: number
  embeddingUsed: boolean
  llmUsed: boolean
  warnings: string[]
  characters: CanvasCharacterRef[]
}

/**
 * 组装 `CanvasGenerateReport`（docs/11 §2.4）。
 * `unmatchedQuote` / `tooLong` 直接来自 flags，保证与质检（quality.ts）口径一致。
 */
export function buildGenerateReport(input: BuildReportInput): CanvasGenerateReport {
  const byKind: Record<LineKind, number> = { dialogue: 0, narration: 0, inner: 0, sfx_note: 0 }
  const byDecision: Record<DecidedBy, number> = { rule: 0, vector: 0, llm: 0, human: 0 }
  const speakerMap = new Map<string, { characterId: Id | null; name: string; lines: number; chars: number }>()
  let lowConfidence = 0
  let unmatchedQuote = 0
  let tooLong = 0

  for (const l of input.lines) {
    byKind[l.kind] = (byKind[l.kind] ?? 0) + 1
    if (l.decidedBy) byDecision[l.decidedBy] = (byDecision[l.decidedBy] ?? 0) + 1
    if (l.needsReview) lowConfidence++
    if (l.flags.includes('quote_unmatched')) unmatchedQuote++
    if (l.flags.includes('too_long') || l.tooLong) tooLong++

    const key = l.characterId ?? '__narration__'
    const name = l.characterName ?? (l.speakerType === 'narration' ? '旁白' : '未分配')
    const entry = speakerMap.get(key) ?? { characterId: l.characterId, name, lines: 0, chars: 0 }
    entry.lines++
    entry.chars += countReadableChars(l.text)
    speakerMap.set(key, entry)
  }

  const bySpeaker = [...speakerMap.values()].sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name))

  return {
    chapterId: input.chapterId,
    totalLines: input.lines.length,
    byKind,
    bySpeaker,
    byDecision,
    lowConfidence,
    unmatchedQuote,
    tooLong,
    elapsedMs: input.elapsedMs,
    embeddingUsed: input.embeddingUsed,
    llmUsed: input.llmUsed,
    warnings: [...input.warnings],
  }
}

/** 供外部（main 层 / 测试）复用的余弦入口，避免调用方直接依赖 vector.ts 的内部约定 */
export { cosine }
