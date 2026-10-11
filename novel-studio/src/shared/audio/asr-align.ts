/**
 * Novel Studio · 音频转文字（ASR）结果 → 每行音频区间（纯逻辑）
 * ============================================================================
 * 真机需求：「需要音频转文字 记录每段文字的位置后分割」（导入速度无所谓）。
 *
 * 这一层解决链路里最后一段：
 *
 * ```
 *   whisper 识别 → 每段文字 + 起止毫秒（`AsrSegment[]`）+ 每个 token 的起止（`AsrToken[]`）
 *   本模块       → 逐字单调对齐 → 每行的音频区间（互不重叠、无缝、覆盖到末尾）
 * ```
 *
 * ## 为什么必须有 ASR（而不是继续打磨 VAD）
 *   VAD 只知道「哪里有声音、哪里有停顿」。连续朗读时停顿可能落在句子中间，
 *   也可能好几行之间根本没有停顿 —— 这时无论怎么吸附，边界都只能靠**猜**。
 *
 * ## 为什么还要「逐字」而不是「段 ↔ 行」
 *   识别引擎切出来的「段」与画本「行」**不是一对一**：一行被切成两段（长句），
 *   或者两行被并成一段（短句连读）都是常态。只按段配对必然有一边切错
 *   （真机症状：2221 章长句「…如果是的话，这也太打脸了！」整段没有音频）。
 *   逐字对齐（`char-align.ts`）把每个字钉到毫秒，这两种情况都能自然处理：
 *   一行跨两段 → 取到两段的并集；一段含两行 → 在段内部按字的时刻切开。
 *
 * ## 三条不变量（与 VAD 路径一致，导入侧依赖）
 *   ① 每行都有区间（对不上的行由前后邻居按字数插值，并进复核清单）
 *   ② 区间按顺序、不重叠、无缝（后一行起点 === 前一行终点）
 *   ③ 覆盖到音频末尾（末尾未配对的部分给最后一行）
 *
 * 本目录禁止引入任何第三方依赖。
 */

import {
  alignCharsMonotone,
  chooseInterRegionCut,
  isSpeechText,
  looksLikeNext,
  type CharAlignLineSpan,
  type TimedText,
} from './char-align.ts'
import { nearestSilenceCenter, snapBoundaryToSilence, type AudioSilence } from './silence.ts'
import type { Id } from '../types.ts'
import type { AsrSegment } from './text-match.ts'

/** 一行拿到的音频区间（与 `allocate.ts` 的 `LineAudioRange` 同形，便于两条路径互换） */
export interface AsrLineRange {
  lineId: Id
  startMs: number
  endMs: number
  /** 0~1：这一行的**字数命中率**（未配对的行按邻居插值，给 0） */
  confidence: number
  /** 判定依据（UI 直接展示） */
  reasons: string[]
}

export interface AsrAlignInput {
  /** ASR 段落（时间升序；空数组 = 没跑识别） */
  segments: readonly AsrSegment[]
  /**
   * token 级时间戳（whisper.cpp `-ojf`）。给了就用它做逐字对齐（最准）；
   * 没给就退回按段对齐 —— 结果仍然可用，只是长句的边界会粗一点。
   */
  tokens?: readonly TimedText[]
  /** 画本行（按应有的朗读顺序） */
  lines: ReadonlyArray<{ lineId: Id; text: string }>
  /**
   * 音频里的静音区间（ffmpeg `silencedetect`）。给了就把每行的边界**吸附到静音里** ——
   * 这是对付「识别时间戳有误差」的最后一道（见 `silence.ts` 的说明）。
   */
  silences?: readonly AudioSilence[]
  /** 音频总时长（毫秒）—— 末尾对齐的边界 */
  durationMs: number
  /** 时间轴起点（默认取第一段起点；前面那段空白不摊给第一行） */
  timelineStartMs?: number
  /** 认定「这一行对上了」所需的最低字数命中率（默认 0.34，与文本相似度下限一致） */
  minLineCoverage?: number
  /** 整体字级命中率的下限（默认 0.2）：低于它认为这次识别根本不是这段画本，退回 VAD */
  minMatchRatio?: number
  /** 语速（字/秒），仅用于「识别结果为空」时给出提示 */
  charsPerSecond?: number
  /** 可接受的「未配对行占比」上限（默认 0.4）：超过就认为这次识别不可用，由调用方退回 VAD */
  maxUnmatchedRatio?: number
}

export interface AsrAlignResult {
  ranges: AsrLineRange[]
  /** 需要人工复核的行（没对上的 / 命中率低的） */
  needsReview: Id[]
  warnings: string[]
  /** 对上的行数（逐字对齐里有字的行） */
  matchedCount: number
  /** 没被任何行认领的识别段数（识别到了但画本里没有这句） */
  unmatchedSegments: number
  /** 未配对的行数 */
  unclaimedLines: number
  /** 整体**字级命中率** 0~1（识别文本与画本是否同一段内容的自检指标） */
  avgSimilarity: number
  /** 是否可用（未配对行占比在容忍范围内，且整体命中率够高） */
  usable: boolean
}

/** 归一化分段：丢掉空文本，夹掉非法时间，按起点排序 */
export function normalizeAsrSegments(segments: readonly AsrSegment[]): AsrSegment[] {
  const out: AsrSegment[] = []
  for (const seg of segments) {
    const text = String(seg.text ?? '').trim()
    if (text.length === 0) continue
    const startMs = Number.isFinite(seg.startMs) ? Math.max(0, seg.startMs) : 0
    const endMs = Number.isFinite(seg.endMs) ? Math.max(startMs, seg.endMs) : startMs
    if (endMs <= startMs) continue
    out.push({
      startMs,
      endMs,
      text,
      ...(seg.asrConfidence !== undefined ? { asrConfidence: seg.asrConfidence } : {}),
    })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/** 没对上的行分区间时的**每行底线**（毫秒）：再挤也不能出现 1 ms 的空 take */
const MIN_GROUP_LINE_MS = 120

/**
 * 吸附边界时允许的窗口与底线。
 *
 *   · 邻居**对上了**：窗口 = 它自己认出来的话的结束/开始（最强约束，吸附不会切到人或丢字）；
 *   · 邻居**没对上**：只允许在边界附近 ±`UNTRUSTED_WINDOW_MS` 内微调（不然会把它的音频全挪走）；
 *   · 任何一侧都至少留 `MIN_GROUP_LINE_MS`。
 */
const UNTRUSTED_WINDOW_MS = 320

/**
 * 退路吸附的最大移动距离（毫秒）。
 *
 * 识别偶尔会把边界定在字的**里面**（token 归属错了），这时两行各自认出来的话之间
 * 就没有静音可用 —— 只能按音频找最近的停顿。限制在 900ms 内是为了不跑到别的句子去。
 */
const MAX_FALLBACK_SNAP_MS = 900

/**
 * 「明显过长」的行的修正阈值（见 ¦correctOverlongRangesToPause¦）。
 *
 * 只动「时长 > 本文件语速估出的 1.5 倍，且多出 800 ms 以上」的行 —— 宁可少改：
 * 正常行之间语速差异本来就有 ±30%，阈值太低会误伤。
 */
const OVERLONG_FACTOR = 1.5
const OVERLONG_MIN_EXCESS_MS = 800
/** 能当切点的停顿的最短长度：短停顿多是句内语气停顿，不是句间/换人边界 */
const MIN_CUT_PAUSE_MS = 200

/**
 * 未配对行「从紧跟着的停顿里开始切」的容差（毫秒）。
 *
 * 上一行结束处如果紧接着就是一段停顿，那这段停顿就是本行应占的位置 ——
 * 起点落在停顿里，占位 take 才是**干净的静音**，而不是上一句的尾音。
 */
const PAUSE_START_TOLERANCE_MS = 400

/**
 * 把「明显过长」的行的右界挪到它后面那个**停顿**里（原地修改 `ranges`）。
 *
 * 为什么必须有这一步：whisper 的 **token 时间戳在同一识别段的尾部会被压缩** ——
 * 一段里挤了两句话时，后半句的 token 常常整体偏移一两秒。于是「下一行首字时刻」
 * 这个锚点会落到下一句**已经开口之后**，上一行就多吞了一整句的开头。
 * 真机实测（2221 章旁白第 13 行）：本行「石志坚像是会读心术，目光灼灼，」被排成
 * 68.35–75.79 s（7.4 s，2.0 字/秒），末尾混进了下一句「邵大亨等人被石志坚…」的前 1.6 s；
 * 而音频里 72.90–74.17 s 有一个 1.26 s 的句末停顿 —— 真正的边界在那里。
 * 用窗口切片复听可以证实：71.0–73.0 s 说的是「…目光灼灼」，74.0–76.8 s 说的是
 * 「邵大亨等人被石志坚…」，边界就在那段停顿里。
 *
 * 判据（只动明显过长的行，宁可少改）：
 *   1. 本行时长 > 本文件语速（各命中行语速的**中位数**，自校准，不依赖设置）估出的 1.5 倍；
 *   2. 多出的部分 ≥ 800 ms；
 *   3. 在本行**后半段**（45% 之后、末尾 100 ms 之前）能找到 ≥ 200 ms 的停顿 ——
 *      取其中最长的那段，右界落在**停顿的结束**（停顿留给本行当尾巴，下一行从开口处开始）。
 *
 * 它只会把右界**往前挪**，绝不会往后推 —— 所以不可能让某一行多吞音频；
 * 万一判错，代价只是「本行尾巴多留一段静音」。
 */
function correctOverlongRangesToPause(args: {
  ranges: AsrLineRange[]
  lines: ReadonlyArray<{ lineId: Id; text: string }>
  trusted: readonly boolean[]
  silences: readonly AudioSilence[]
  weightOf: (text: string) => number
}): void {
  const { ranges, lines, trusted, silences, weightOf } = args
  if (silences.length === 0 || ranges.length < 2) return

  /** 本文件的语速（字/秒）：用各命中行的中位数，避开个别异常行的影响 */
  const rates: number[] = []
  for (let i = 0; i < ranges.length; i++) {
    if (trusted[i] !== true) continue
    const duration = ranges[i]!.endMs - ranges[i]!.startMs
    if (duration < 1200) continue
    const rate = weightOf(lines[i]!.text) / (duration / 1000)
    if (rate > 1.5 && rate < 12) rates.push(rate)
  }
  if (rates.length < 3) return
  rates.sort((a, b) => a - b)
  const mid = rates.length >> 1
  const medianRate = Math.min(8, Math.max(1.8, rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2))

  for (let i = 0; i + 1 < ranges.length; i++) {
    if (trusted[i] !== true) continue
    const range = ranges[i]!
    const duration = range.endMs - range.startMs
    const expected = (weightOf(lines[i]!.text) / medianRate) * 1000
    if (duration <= expected * OVERLONG_FACTOR) continue
    if (duration - expected < OVERLONG_MIN_EXCESS_MS) continue

    const from = range.startMs + duration * 0.45
    const to = range.endMs - 100
    let picked: AudioSilence | null = null
    for (const s of silences) {
      if (s.startMs < from || s.endMs > to) continue
      if (s.endMs - s.startMs < MIN_CUT_PAUSE_MS) continue
      if (picked === null || s.endMs - s.startMs > picked.endMs - picked.startMs) picked = s
    }
    if (picked === null) continue
    const cut = picked.endMs
    // 至少留下估算时长的 60%（否则宁可不动）
    if (cut <= range.startMs + Math.max(400, expected * 0.6)) continue

    range.endMs = cut
    range.reasons.push(
      '本行明显过长（' +
        weightOf(lines[i]!.text) +
        ' 字用了 ' +
        Math.round(duration) +
        ' ms），右界改到后面的停顿结束处',
    )
    // 起点恒等于上一行的终点：下一行跟着前移，边界保持无缝
    const next = ranges[i + 1]!
    if (next.startMs < cut) next.startMs = cut
  }
}

/**
 * 把每行的右界吸附到静音里（原地修改 `ranges`）。
 *
 * 只在 `[上一行自己认出来的话结束, 下一行自己认出来的话开始]` 这个窗口里动，
 * 所以它**只会让边界更准，不会切进任何一边认出来的话**；窗口里没有静音就保持原样。
 */
function refineBoundariesToSilence(args: {
  ranges: AsrLineRange[]
  spans: readonly CharAlignLineSpan[]
  units: readonly TimedText[]
  trusted: readonly boolean[]
  silences: readonly AudioSilence[]
}): void {
  const { ranges, spans, units, trusted, silences } = args
  if (silences.length === 0 || ranges.length < 2) return
  const speech = units.map((u) => isSpeechText(u.text))

  for (let i = 0; i + 1 < ranges.length; i++) {
    const current = ranges[i]!
    const next = ranges[i + 1]!
    const from = current.endMs

    let lower = from - UNTRUSTED_WINDOW_MS
    let upper = from + UNTRUSTED_WINDOW_MS

    const prevSpan = spans[i]!
    if (trusted[i] === true && prevSpan.lastUnit !== null) {
      for (let u = prevSpan.lastUnit; u >= (prevSpan.firstUnit ?? 0); u--) {
        if (speech[u]) {
          lower = units[u]!.endMs
          break
        }
      }
    }
    const nextSpan = spans[i + 1]!
    if (trusted[i + 1] === true && nextSpan.firstUnit !== null) {
      for (let u = nextSpan.firstUnit; u < units.length; u++) {
        if (speech[u]) {
          upper = units[u]!.startMs
          break
        }
      }
    }

    // 两边都至少留一点（不能让某一行变成 0 长度）
    lower = Math.max(lower, current.startMs + MIN_GROUP_LINE_MS)
    upper = Math.min(upper, next.endMs - MIN_GROUP_LINE_MS)

    /**
     * ① 首选：两行「各自认出来的话」之间那段静音（token 证据 + 音频证据一致，最可靠）；
     * ② 退路：①里没有静音 —— 说明这个边界**切在某个字的里面**（token 归属很可能错了），
     *    那就以音频为准：吸到离它最近的、够长的停顿中心。
     *    真机实测：识别把边界定在 36000（切在上一行自己的「众」上），
     *    而音频里 36400~37140 才是那个句末停顿 —— 退路把它拉回 36770，上一行的「众人」就完整了。
     */
    let snapped: number | null = null
    if (upper > lower) snapped = snapBoundaryToSilence(lower, upper, silences)
    if (snapped === null) {
      snapped = nearestSilenceCenter(from, silences, { maxDistanceMs: MAX_FALLBACK_SNAP_MS })
    }
    if (snapped === null || snapped === from) continue
    // 退路可能落在相邻边界之外，这里再夹一次
    snapped = Math.min(Math.max(snapped, current.startMs + MIN_GROUP_LINE_MS), next.endMs - MIN_GROUP_LINE_MS)
    if (snapped === from) continue
    /**
     * ★ 边界**已经落在某段停顿里**时，不许被推出这段停顿。
     *
     * 上面那次夹取用的是「两侧各留 MIN_GROUP_LINE_MS」，窗口与 [lower, upper] 不同：
     * 当下一行是**没对上的短占位行**（例如「画本有、录音里没念」的行只有 120ms）时，
     * `next.endMs - 120` 会把边界顶回上一行的终点 —— 也就是从停顿里推回**语音**里
     * （真机：占位 take 里混进了上一句的尾音）。落在停顿里的边界本来就是好位置。
     */
    const silenceAt = (ms: number): AudioSilence | null => silences.find((s) => ms >= s.startMs && ms <= s.endMs) ?? null
    if (silenceAt(from) !== null && silenceAt(snapped) !== silenceAt(from)) continue
    current.endMs = snapped
    next.startMs = snapped
    current.reasons.push(
      '右界吸附到静音（' + (snapped > from ? '+' : '') + Math.round(snapped - from) + 'ms）',
    )
  }
}

/** 把 token 摊成对齐单位（时间夹到合法范围；单位顺序 = 时间顺序） */
function tokensToUnits(tokens: readonly TimedText[]): TimedText[] {
  const out: TimedText[] = []
  for (const t of tokens) {
    const text = String(t.text ?? '').trim()
    if (text.length === 0) continue
    const startMs = Number.isFinite(t.startMs) ? Math.max(0, t.startMs) : 0
    const endMs = Number.isFinite(t.endMs) ? Math.max(startMs, t.endMs) : startMs
    out.push({ text, startMs, endMs })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * 把 ASR 结果对到画本行，产出每行的音频区间。
 *
 * 分配规则（三条，与 `char-align.ts` 的逐字结果配合）：
 *   · **对上的行**：右界 = 下一个对上的行的**首字时刻**（句间停顿归前一行；
 *     两行落在同一个识别单位里时，就是在单位内部按首字时刻切开）；
 *     中间夹着没对上的行时，右界退回「本行最后一个命中单位的**下一个单位起点**」，
 *     免得把那些行的音频全吞掉；
 *     本行之后、下一行首字之前那些**谁都没认领**的单位，算本行**没被识别出来的尾音**
 *     （真机症状「长句后半句没了」就是这一种）；
 *   · 起点永远是上一行的终点（第一行是时间轴起点）—— 无缝、不重叠由此保证；
 *   · **对不上的行**：夹在前后配对行之间按**字数比例**分（并进复核清单）；
 *     末尾未配对的部分全给最后一行（宁可多给，也不要丢音频）。
 */
export function alignLinesToAsr(input: AsrAlignInput): AsrAlignResult {
  const segments = normalizeAsrSegments(input.segments)
  const lines = input.lines
  const warnings: string[] = []

  if (lines.length === 0 || segments.length === 0) {
    return {
      ranges: [],
      needsReview: lines.map((l) => l.lineId),
      warnings: ['没有可用的识别结果（ASR 段落为空）'],
      matchedCount: 0,
      unmatchedSegments: segments.length,
      unclaimedLines: lines.length,
      avgSimilarity: 0,
      usable: false,
    }
  }

  /**
   * 对齐单位：**token 优先**（whisper.cpp `-ojf`，中文 token 通常 1~3 字），
   * 没有 token 时退回「一段 = 一个单位」。后者仍能工作，只是长句内部切不开。
   */
  const tokenUnits = tokensToUnits(input.tokens ?? [])
  const useTokens = tokenUnits.length > 0
  const units: readonly TimedText[] = useTokens
    ? tokenUnits
    : segments.map((s) => ({ text: s.text, startMs: s.startMs, endMs: s.endMs }))
  const unitSegmentIndex: number[] = useTokens
    ? tokenUnits.map((u) => {
        // token → 它落在哪一段（识别段覆盖了 token 的起点）
        let hit = 0
        for (let s = 0; s < segments.length; s++) {
          if (segments[s]!.startMs <= u.startMs) hit = s
          else break
        }
        return hit
      })
    : segments.map((_, i) => i)

  const aligned = alignCharsMonotone(units, lines.map((l) => ({ lineId: l.lineId, text: l.text })))
  warnings.push(...aligned.warnings)
  /** 哪些识别单位一个字都没被认领（噪声；或某一行没被识别出来的部分） */
  const unmatchedSet = new Set(aligned.unmatchedUnits)

  const minCoverage = input.minLineCoverage ?? 0.34
  const trusted = aligned.spans.map(
    (s) => s.matchedChars > 0 && (s.coverage >= minCoverage || (s.totalChars <= 3 && s.matchedChars >= 1)),
  )
  const matchedCount = trusted.filter(Boolean).length
  const unclaimed = lines.length - matchedCount
  const maxUnmatchedRatio = input.maxUnmatchedRatio ?? 0.4
  const minMatchRatio = input.minMatchRatio ?? 0.2
  const usable =
    unclaimed / lines.length <= maxUnmatchedRatio && aligned.matchRatio >= minMatchRatio

  const timelineStart = input.timelineStartMs ?? segments[0]!.startMs
  const durationMs =
    Number.isFinite(input.durationMs) && input.durationMs > 0
      ? input.durationMs
      : segments[segments.length - 1]!.endMs

  /**
   * 每行的锚点：对上的行取「第一个命中字的**起点**」；没对上的没有锚点（NaN）。
   *
   * ★ 必须是**起点**而不是字中心：锚点会被当成「上一行的右界」，
   *   用字中心会让上一行多切进这个字的一半 —— 真机症状就是
   *   「石志坚笑了…」这一行的末尾混进了下一句开头那个「众」的起音。
   */
  const anchors: number[] = lines.map((_, i) => {
    const span = aligned.spans[i]!
    if (!trusted[i]) return Number.NaN
    return span.firstBoundaryMs ?? span.firstMs ?? Number.NaN
  })

  const weightOf = (text: string): number => Math.max(1, [...String(text ?? '')].length)
  const ranges: AsrLineRange[] = []
  let cursor = timelineStart
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const span = aligned.spans[i]!
    const isLast = i === lines.length - 1
    const isTrusted = trusted[i] === true
    const linesAfter = lines.length - i - 1
    /**
     * 起点**永远是上一行的终点**（第一行是时间轴起点）。
     *
     * 不用「锚点」当起点：锚点是「第一个命中的字」的时刻，它可能晚于上一行的终点
     * （识别漏了开头的字），那样会留下一段没人认领的音频；而上一行的终点本来就是
     * 「不属于上一行的第一个单位」的位置，天然就是本行最合理的起点。
     */
    let startMs = cursor

    /** 下一个「对上了」的行（跳过没对上的行）—— 它的首字时刻就是本行最自然的右界 */
    let nextAnchored = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (Number.isFinite(anchors[j]!)) {
        nextAnchored = j
        break
      }
    }

    let endMs: number
    /** 右界是怎么定下来的（写进 reasons，便于抽查「为什么切在这儿」） */
    let endReason = ''
    if (isLast) {
      endMs = Math.max(startMs + 1, durationMs)
    } else if (isTrusted) {
      const hardMax = Math.max(startMs + 1, durationMs - linesAfter)
      const nextFirstUnit = nextAnchored >= 0 ? aligned.spans[nextAnchored]!.firstUnit : null
      /**
       * 两行的字落在**同一个识别单位**里（短句连读被并成一段）：
       * 这时没有单位边界可以当界，就在段内部按「下一行首字的时刻」切开。
       */
      const sharesUnit =
        nextFirstUnit !== null && span.lastUnit !== null && nextFirstUnit === span.lastUnit

      let raw: number
      if (sharesUnit) {
        raw = Math.max(span.lastMs ?? startMs, anchors[nextAnchored]!)
        endReason = '两行同在一个识别单位里，按下一行首字的时刻切开'
      } else if (span.endHintMs === null) {
        raw = nextAnchored >= 0 ? anchors[nextAnchored]! : durationMs
        endReason = '本行最后一个命中单位就是最后一个单位'
      } else if (nextAnchored === i + 1 && span.lastUnit !== null) {
        /**
         * 紧邻的下一行也对上了：本行最后一个命中单位与它第一个命中单位之间，可能夹着
         * 几个**谁都没认领**的单位（识别把它们听成了别的字）。
         * 这些音频要么是本行没被识别出来的尾音、要么是下一行没被识别出来的开头 ——
         * 用「识别段边界 + 语音停顿 + 文字更像谁」挑一个切点（见 chooseInterRegionCut）。
         *
         * 真机症状就出在这里：把「實至間端起了茶杯」（下一行「石志坚…端起茶杯」的开头）
         * 整段塞给了前一行 —— 用户听到的是「下一句的音放上一句里了」。
         */
        const regionFrom = span.lastUnit + 1
        const regionTo = nextFirstUnit ?? units.length
        if (regionTo > regionFrom) {
          const picked = chooseInterRegionCut({
            units: units.slice(regionFrom, regionTo),
            segmentOf: unitSegmentIndex.slice(regionFrom, regionTo),
            prevSegment: regionFrom > 0 ? unitSegmentIndex[regionFrom - 1]! : null,
            nextSegment: regionTo < unitSegmentIndex.length ? unitSegmentIndex[regionTo]! : null,
            prevUnitEndMs: regionFrom > 0 ? units[regionFrom - 1]!.endMs : null,
            nextUnitStartMs: regionTo < units.length ? units[regionTo]!.startMs : null,
            prevText: line.text,
            nextText: lines[nextAnchored]!.text,
          })
          endReason = '夹层切点：' + picked.reason
          const regionLength = regionTo - regionFrom
          raw =
            picked.cut <= 0
              ? span.endHintMs
              : picked.cut >= regionLength
                ? anchors[nextAnchored]!
                : units[regionFrom + picked.cut]!.startMs
        } else {
          raw = span.endHintMs
          endReason = '夹层为空，切在下一个单位起点'
        }
      } else if (nextAnchored > i + 1) {
        /**
         * 中间夹着「没对上」的行：右界只能取本行最后一个命中单位的**下一个单位起点**，
         * 否则那些行会被本行吞掉、一个字都分不到（它们的位置本来就只能靠插值）。
         */
        raw = span.endHintMs
        endReason = '后面有没对上的行，右界留出它们的空间'
      } else {
        raw = nextAnchored >= 0 ? anchors[nextAnchored]! : durationMs
      }

      /**
       * ★ 最后一道硬约束：**右界绝不越过下一行第一个命中单位的起点**。
       *
       * 只要两行的命中落在不同单位上，下一行第一个「认出来的字」属于它自己 ——
       * 本行一点都不能碰（真机症状：这一行的末尾混进了下一句开头那个「众」的起音）。
       * 不管上面走了哪条分支，这里都再兜一次；两行落在**同一个单位**里时不做这一步
       * （那种情况没有单位边界可用，只能按字切开）。
       */
      if (nextFirstUnit !== null && span.lastUnit !== null && nextFirstUnit > span.lastUnit) {
        const nextUnitStartMs = units[nextFirstUnit]!.startMs
        if (raw > nextUnitStartMs) {
          raw = nextUnitStartMs
          endReason = (endReason ? endReason + '；' : '') + '不越过下一行第一个命中单位的起点'
        }
      }
      endMs = Math.min(hardMax, Math.max(startMs + 1, raw))
    } else {
      /**
       * ★ 占位音的起点：若上一行结束处紧接着就是一段停顿，就**从停顿里开始切**。
       *
       * 真机复报（2221 章旁白第 13/14 行：画本有、这段录音里没念）：
       * 占位 take 的区间落在 45.76–46.40s，而上一句「…怎么办？」说到 45.87s ——
       * 于是用户试听「邵大亨等人一脸诧异。」，听到的是**上一句的尾音**。
       * 从停顿（45.87–47.17）里开始切之后，占位区间就是纯静音（并有 import-needs-review 标记）。
       */
      const nearbyPause = (input.silences ?? []).find(
        (s) => s.startMs >= startMs - 1 && s.startMs <= startMs + PAUSE_START_TOLERANCE_MS,
      )
      if (nearbyPause) startMs = Math.max(startMs, nearbyPause.startMs)
      /** 未配对：与相邻的未配对行共享 [startMs, 下一个锚点]，按字数比例分 */
      let nextAnchor = durationMs
      for (let j = i + 1; j < lines.length; j++) {
        if (Number.isFinite(anchors[j]!)) {
          nextAnchor = anchors[j]!
          break
        }
      }
      let groupEnd = i
      while (groupEnd + 1 < lines.length && !Number.isFinite(anchors[groupEnd + 1]!)) groupEnd++
      const group = lines.slice(i, groupEnd + 1)
      const totalWeight = group.reduce((sum, l) => sum + weightOf(l.text), 0)
      const myWeight = weightOf(line.text)
      /**
       * 上界：必须给后面的每一行留位置（这里用 1 ms 的硬下限；
       * 不这么做时「一段跨很多行」会让末尾几行各自只剩 1 ms —— 与 allocate 路径同一个坑）。
       */
      const hardMax = Math.max(startMs + 1, durationMs - linesAfter)
      const boundaryRaw = Number.isFinite(nextAnchor) ? nextAnchor : durationMs
      /**
       * 下一行的**句子**从哪儿开始：如果下一行第一个命中的单位正好是某个识别段的头一个单位，
       * 那这个段的起点就是它的句子起点 —— 整段都属于它，夹层（这几行没被识别出来的音频）
       * 不该越过去。真机例：第 32 行（分隔线）之后，第 33 行的「实际上，作为香港最大的电影公司」
       * 是 S11（98000）的头一句，而旧实现让夹层一直吃到 99429（下一行第一个命中字）。
       */
      let nextSentenceStart: number | null = null
      if (nextAnchored >= 0) {
        const firstUnit = aligned.spans[nextAnchored]!.firstUnit
        if (firstUnit !== null) {
          const segIndex = unitSegmentIndex[firstUnit]!
          // 该段的「段头」：同一段里排在下一行第一个命中单位之前的那些单位
          let headFrom = firstUnit
          while (headFrom > 0 && unitSegmentIndex[headFrom - 1] === segIndex) headFrom--
          const headText = units.slice(headFrom, firstUnit).map((u) => u.text).join('')
          const groupText = group.map((l) => l.text).join('')
          /**
           * 用**段内第一个 token 的时刻**，而不是 whisper 给的段起点：
           * 段起点是引擎的粗边界（真机里 S3 给的是 26000，而它第一个 token 在 26719，差 700ms），
           * token 时刻才是「这里真的有声音」的位置。
           */
          const segLeadMs = units[headFrom]!.startMs
          if (headText.trim().length === 0) {
            // 下一行第一个命中单位就是段头：段的起点就是它的句子起点
            nextSentenceStart = segLeadMs
          } else if (looksLikeNext(headText, groupText, lines[nextAnchored]!.text)) {
            /**
             * 段头那几个单位更像**下一行** → 它们只是下一行没被认出来的开头，整段从段首起归下一行。
             * 反过来（段头更像这一组没对上的行）就不设这个上界 —— 段头本来就是这几行的音频。
             * 真机例：S11（98000）的段头「實際上,作為香港最大的電影公司…」像第 33 行 → 切成 98000。
             */
            nextSentenceStart = segLeadMs
          }
        }
      }
      /**
       * 夹层最多吃到「下一行句子起点」，但每组至少留 `group.length × 120ms`：
       * 真机里确实会出现「画本有、这段录音里根本没念」的行（例如 2221 章的分隔线），
       * 那时宁可给它一小段（并进复核清单），也不要写出一条 1 ms 的空 take ——
       * 界面会显示「已录」而点开什么也没有。
       */
      const capped =
        nextSentenceStart !== null
          ? Math.min(boundaryRaw, Math.max(nextSentenceStart, startMs + group.length))
          : boundaryRaw
      const groupFloor = MIN_GROUP_LINE_MS * group.length
      /**
       * 同样兜一道：夹层不许越过「下一行第一个命中单位的起点」（它的字属于它自己）。
       */
      const nextUnitCeiling =
        nextAnchored >= 0 && aligned.spans[nextAnchored]!.firstUnit !== null
          ? units[aligned.spans[nextAnchored]!.firstUnit!]!.startMs
          : null
      const ceiling = nextUnitCeiling !== null ? Math.min(capped, nextUnitCeiling) : capped
      let boundary = Math.min(hardMax, Math.max(startMs + groupFloor, ceiling))
      /**
       * ★ 未配对的行 = 「画本有、这段录音里没念」的占位行：优先把整组塞进附近的**停顿**里。
       *
       * 占位 take 只需要一小段静音（并进复核清单），而切在上一句尾音或下一句开头，
       * 用户试听时听到的都**不是这一句**（真机复报：2221 章旁白第 13/14 行 ——
       * 占位区间落在 45.76–46.40s，前半是上一句的尾音，后半是 45.87–47.17s 那段停顿）。
       */
      const coveringPause = (input.silences ?? []).find(
        (s) =>
          s.startMs <= boundary &&
          s.endMs >= startMs + groupFloor &&
          s.startMs >= startMs - PAUSE_START_TOLERANCE_MS,
      )
      if (coveringPause) {
        const relocated = Math.max(startMs, coveringPause.startMs)
        const relocatedEnd = Math.min(Math.max(boundary, relocated + groupFloor), coveringPause.endMs)
        if (relocatedEnd > relocated) {
          // 前一行吃到这个起点为止：多出来的是它自己的尾音或停顿，无害
          if (i > 0) {
            ranges[i - 1]!.endMs = relocated
            ranges[i - 1]!.reasons.push('右界让位给后面没对上的行（占位音放进停顿里）')
          }
          startMs = relocated
          boundary = relocatedEnd
        }
      }
      const share = (boundary - startMs) * (myWeight / Math.max(1, totalWeight))
      const minShare = Math.max(120, (weightOf(line.text) / 4.2) * 1000 * 0.5)
      /**
       * 按字数比例分，但**不许越过 boundary**。
       *
       * 原来是 max(minShare, share)：当某行很短时，minShare（按 4.2 字/秒估）会把它一直顶到
       * 「下一行第一个命中字」那里 —— 于是又吃掉了下一句的开头（真机：seq 4 被 minShare
       * 顶到 26719，而下一行的第一个 token 在 26719 之前就已经不该归它了）。
       */
      // 还要给组内后面的每一行留出底线，否则一行就能把整组吃光（后面的行只剩 1ms）
      const maxEnd = Math.max(startMs + 1, boundary - (groupEnd - i) * MIN_GROUP_LINE_MS)
      endMs = Math.min(maxEnd, Math.max(startMs + minShare, startMs + share))
      // 组内最后一行吃到边界，避免累计误差留下空隙
      if (i === groupEnd) endMs = Math.max(endMs, boundary)
      endMs = Math.max(endMs, startMs + 1)
    }

    const confidence = isTrusted ? span.coverage : 0
    const reasons: string[] = []
    if (isTrusted) {
      reasons.push('按识别文本对齐（逐字强制对齐）')
      reasons.push(`命中 ${span.matchedChars}/${span.totalChars} 字`)
      if (useTokens) reasons.push('token 级时间戳')
      if (endReason) reasons.push('右界：' + endReason)
    } else {
      reasons.push('识别文本没有与这一行对上，已按前后段的位置与字数插值')
      if (span.matchedChars > 0) reasons.push(`只命中 ${span.matchedChars}/${span.totalChars} 字`)
    }
    ranges.push({ lineId: line.lineId, startMs, endMs, confidence, reasons })
    cursor = endMs
  }

  const needsReview = ranges.filter((r) => r.confidence < 0.5).map((r) => r.lineId)
  if (unclaimed > 0) {
    warnings.push(`有 ${unclaimed}/${lines.length} 行没有与识别文本对上（已按前后段位置插值）—— 这些行请重点试听`)
  }
  /**
   * 最后一道：把每个**行间边界**吸附到音频量出来的静音里。
   *
   * 识别给的时间戳有几十~几百毫秒误差（同一个文件换模型/换线程数就会变），
   * 只靠它定边界，就总有「下一句第一个字的起音切进上一行」的可能 ——
   * 真机里 whisper 把「众」报在 36900，而 audio 里那个字其实从 37138 才开始。
   * 吸附到静音（并落在静音中间）能给出几百毫秒的安全余量。
   */
  /**
   * 先修「明显过长」的行（token 时间戳在段尾会被压缩，见该函数的注释），
   * 再做最后一轮的静音吸附。
   */
  correctOverlongRangesToPause({
    ranges,
    lines,
    trusted,
    silences: input.silences ?? [],
    weightOf,
  })
  refineBoundariesToSilence({
    ranges,
    spans: aligned.spans,
    units,
    trusted,
    silences: input.silences ?? [],
  })

  /** 没被任何行认领的识别段（识别到了、画本里没有这句） */
  const usedSegments = new Set<number>()
  for (let u = 0; u < units.length; u++) {
    if (!unmatchedSet.has(u)) usedSegments.add(unitSegmentIndex[u]!)
  }
  const unmatchedSegments = segments.length - usedSegments.size
  if (unmatchedSegments > 0) {
    warnings.push(`有 ${unmatchedSegments} 段识别文本在画本里找不到对应行（可能是画本缺句或识别噪声）`)
  }

  return {
    ranges,
    needsReview,
    warnings,
    matchedCount,
    unmatchedSegments,
    unclaimedLines: unclaimed,
    avgSimilarity: aligned.matchRatio,
    usable,
  }
}
