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

import { alignCharsMonotone, type TimedText } from './char-align.ts'
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
  /** 哪个识别单位被某一行认领了（没被认领的 = 噪声，或本行还没被识别出来的尾音） */
  const unmatchedSet = new Set(aligned.unmatchedUnits)
  const unitClaimed = (u: number): boolean => !unmatchedSet.has(u)

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

  /** 每行的锚点：对上的行取「第一个命中的字」的时刻；没对上的没有锚点（NaN） */
  const anchors: number[] = lines.map((_, i) => {
    const span = aligned.spans[i]!
    return trusted[i] && span.firstMs !== null ? span.firstMs : Number.NaN
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
    const startMs = cursor

    /** 下一个「对上了」的行（跳过没对上的行）—— 它的首字时刻就是本行最自然的右界 */
    let nextAnchored = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (Number.isFinite(anchors[j]!)) {
        nextAnchored = j
        break
      }
    }

    let endMs: number
    if (isLast) {
      endMs = Math.max(startMs + 1, durationMs)
    } else if (isTrusted) {
      /**
       * 对上的行怎么收尾 —— 这是「长句尾音丢失」的根治点。
       *
       * 2221 章那一行的文字横跨两个识别段（前半句一段、后半句另一段），
       * 逐字对齐后最后一个命中的字落在第二段末尾，于是：
       *   · 若下一行紧跟着（中间没有没对上的行）：右界 = **下一行首字的时刻**，
       *     本行自然吃到下一行开口之前的全部音频（含句间停顿）——
       *     这同时解决了「两行被识别并进同一段」的情况（在段内部按首字时刻切开）；
       *   · 若中间夹着没对上的行：右界只能是「本行最后一个命中单位的**下一个单位起点**」，
       *     否则那些行会被本行吞掉，一个字都分不到。
       */
      const hasUnanchoredBetween = nextAnchored > i + 1
      const hardMax = Math.max(startMs + 1, durationMs - linesAfter)
      const nextFirstUnit = nextAnchored >= 0 ? aligned.spans[nextAnchored]!.firstUnit : null
      /**
       * 两行的字落在**同一个识别单位**里（短句连读被并成一段）：
       * 这时没有单位边界可以当界，就在段内部按「下一行首字的时刻」切开。
       */
      const sharesUnit =
        nextFirstUnit !== null && span.lastUnit !== null && nextFirstUnit === span.lastUnit
      /**
       * 本行最后一个命中单位之后、下一行首字之前的那几个单位，如果**没有任何行**认领，
       * 那它们只能属于**本行**（识别漏字，或者句间停顿/噪声）——
       * 真机症状「长句后半句没有音频」就是这一种。此时把右界推到下一行开口之前。
       */
      const gapStart = (span.lastUnit ?? -1) + 1
      const gapEnd = nextFirstUnit ?? units.length
      let gapUnclaimed = false
      if (!hasUnanchoredBetween && gapEnd > gapStart && gapStart >= 0) {
        gapUnclaimed = true
        for (let u = gapStart; u < gapEnd; u++) {
          if (unitClaimed(u)) {
            gapUnclaimed = false
            break
          }
        }
      }

      let raw: number
      if (sharesUnit) raw = Math.max(span.lastMs ?? startMs, anchors[nextAnchored]!)
      else if (span.endHintMs === null) raw = nextAnchored >= 0 ? anchors[nextAnchored]! : durationMs
      else if (gapUnclaimed && nextAnchored >= 0) raw = anchors[nextAnchored]!
      else raw = span.endHintMs
      endMs = Math.min(hardMax, Math.max(startMs + 1, raw))
    } else {
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
      // 锚点没有留出空间（≤ 起点）时退回硬上界，避免算出 1 ms 的区间
      const boundary = Math.min(hardMax, Math.max(startMs + group.length, boundaryRaw))
      const share = (boundary - startMs) * (myWeight / Math.max(1, totalWeight))
      const minShare = Math.max(120, (weightOf(line.text) / 4.2) * 1000 * 0.5)
      endMs = Math.min(hardMax, Math.max(startMs + minShare, startMs + share))
      // 组内最后一行吃到边界，避免累计误差留下空隙
      if (i === groupEnd) endMs = Math.max(endMs, Math.min(hardMax, boundary))
      endMs = Math.max(endMs, startMs + 1)
    }

    const confidence = isTrusted ? span.coverage : 0
    const reasons: string[] = []
    if (isTrusted) {
      reasons.push('按识别文本对齐（逐字强制对齐）')
      reasons.push(`命中 ${span.matchedChars}/${span.totalChars} 字`)
      if (useTokens) reasons.push('token 级时间戳')
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
