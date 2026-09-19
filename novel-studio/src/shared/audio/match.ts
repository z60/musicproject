/**
 * Novel Studio · 连续录制的切片 ↔ 画本行匹配（纯逻辑，无 IO）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §4.3「连续录制停止后：VAD 切片 → 与画本行匹配 → 人工确认」
 *   · docs/12 §4.3 约束「**不做自动入库**：匹配只是建议，必须用户确认（`record:acceptSlices`）」
 *   · docs/05 §4.2 `charsPerSecond`（中文语速，用于把字数换算成期望时长）
 *
 * ### 为什么用「单调对齐 + 时长代价」而不是「按顺序一一对应」
 *   连续录制里最常见的两件事：**漏读**（某一行的切片根本没录）与**多切**（一口气读了两行，
 *   VAD 把它切成一片）。一一对应在这种输入上会从漏读点开始整体错位 —— 用户会看到
 *   「第 7 行匹配到了第 8 行的音频」，而且越往后越离谱。
 *   单调对齐（允许跳过行、允许跳过切片）能把错误限制在局部，且每个匹配都带 confidence。
 *
 * ### 为什么没有 ASR
 *   契约里 `record:matchSlices` 有 `useAsr` 开关，但本仓库**没有 ASR 实现**。
 *   传 `useAsr: true` 时这里不假装用了语音识别，而是原样返回同一套时长对齐结果，
 *   并由服务层在响应里带上「ASR 未启用」的说明（`docs/91` 有登记）。
 *   「用规则结果冒充 ASR 结果」会让用户以为识别过，那是最坏的一种谎。
 */

import type { Id } from '../types.ts'

/** 参与匹配的一条切片（只用到时长与测量值，与 VadSlice 结构解耦） */
export interface SliceForMatch {
  sliceIndex: number
  startMs: number
  endMs: number
}

/** 参与匹配的一条画本行（只需要 id 与文本长度） */
export interface LineForMatch {
  lineId: Id
  /** 该行要念的文本长度（字符数，按 `[...text].length` 计） */
  charCount: number
}

export interface SliceMatchResult {
  sliceIndex: number
  lineId: Id
  /** 0~1：越高越可信（1 = 时长几乎完全吻合） */
  confidence: number
}

export interface MatchOptions {
  /** 语速（字/秒），来自 VAD 设置；用于把字数换算成期望时长 */
  charsPerSecond: number
  /** 每行固定附加时长（换气/停顿），毫秒 */
  perLineOverheadMs?: number
  /** 时长偏差容忍倍数（默认 1.6：切片时长在期望时长的 1/1.6 ~ 1.6 倍内都算「合理区间」） */
  toleranceRatio?: number
  /**
   * **接受**一条匹配的最低置信度（默认 0.35）。
   *
   * 低于它的配对**不作为匹配输出**，而是回到 `unmatchedSlices` / `unrecordedLines`。
   * 为什么要有这个下限：一条 0.05 置信度的「匹配」在 UI 上看起来仍然是一条匹配
   * ——用户会以为「第 3 行对上了第 12 行的音频」，而实际上算法只是「没有更好的选择」。
   * 诚实的表达是「这一片没找到对应行」。
   */
  minConfidence?: number
  /** 需要人工复核的置信度上限（默认 0.6）：`[minConfidence, reviewConfidence)` 进 `lowConfidenceSlices` */
  reviewConfidence?: number
}

export interface MatchOutput {
  matches: SliceMatchResult[]
  /** 没被任何行匹配上的切片下标（多半是咳嗽/翻页/杂音，或与任何行都不吻合） */
  unmatchedSlices: number[]
  /** 没有被任何切片匹配上的行（漏读） */
  unrecordedLines: Id[]
  /** 已接受但**建议人工复核**的切片下标（置信度 < reviewConfidence） */
  lowConfidenceSlices: number[]
  /** 诊断用：期望时长与切片时长的总体偏差倍数 */
  scale: number
}

/** 期望时长（毫秒）：字数 / 语速 + 固定开销 */
export function expectedLineDurationMs(charCount: number, opts: MatchOptions): number {
  const cps = opts.charsPerSecond > 0 ? opts.charsPerSecond : 5
  const overhead = Math.max(0, opts.perLineOverheadMs ?? 0)
  return Math.max(1, (Math.max(0, charCount) * 1000) / cps + overhead)
}

/**
 * 单调对齐：动态规划最小化「|log(切片时长/期望时长)| 代价 + 跳过惩罚」。
 *
 * 用 **对数比** 而不是差值：3 秒的切片配 6 秒的期望与 300 ms 的切片配 600 ms 的期望，
 * 偏差都是「一倍」，但差值分别是 3000 ms 与 300 ms。用差值会让长切片主导整条路径，
 * 短行（对白里大量的一两个字）就永远匹配不上。
 *
 * @complexity O(n·m)，n/m 是切片数与行数。连续录制一章通常几十到几百，
 *             实测 400×400 在 1 ms 量级；上限有服务层的 20000 条截断保护。
 */
export function matchSlicesToLines(
  slices: readonly SliceForMatch[],
  lines: readonly LineForMatch[],
  opts: MatchOptions,
): MatchOutput {
  const tolerance = opts.toleranceRatio && opts.toleranceRatio > 0 ? opts.toleranceRatio : 1.6
  const minConfidence = opts.minConfidence ?? 0.35
  const reviewConfidence = opts.reviewConfidence ?? 0.6
  const toleranceLog = Math.log(tolerance)
  /** 跳过一条行/一片切片的代价（相对 log 比值）。0.7 ≈ 一次「完全不像」的对齐 */
  const skipCost = 0.7

  const n = slices.length
  const m = lines.length
  if (n === 0 || m === 0) {
    return {
      matches: [],
      unmatchedSlices: slices.map((s) => s.sliceIndex),
      unrecordedLines: lines.map((l) => l.lineId),
      lowConfidenceSlices: [],
      scale: 1,
    }
  }

  const durations = slices.map((s) => Math.max(1, s.endMs - s.startMs))
  const expected = lines.map((l) => expectedLineDurationMs(l.charCount, opts))

  /**
   * 单调对齐（一次 DP）。
   *
   * `rate` 是「实测语速 / 设定语速」的估计：比对时长用 `expected * rate` 作基准。
   * 用 **对数比** 而不是差值：3 秒的切片配 6 秒的期望与 300 ms 配 600 ms，
   * 偏差都是「一倍」，但差值分别是 3000 ms 与 300 ms —— 用差值会让长切片主导整条路径，
   * 短行（对白里大量的一两个字）就永远匹配不上。
   */
  function align(rate: number): {
    pairs: Array<{ sliceIndex: number; lineId: Id; ratio: number }>
    unmatchedSlices: number[]
  } {
    function pairCost(i: number, j: number): number {
      const ratio = Math.log(durations[i]! / (expected[j]! * rate))
      const excess = Math.abs(ratio) - toleranceLog
      return (excess > 0 ? excess : 0) + Math.abs(ratio) * 0.15
    }

    // dp[i][j] = 前 i 片切片与前 j 行对齐的最小代价
    const INF = Number.POSITIVE_INFINITY
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF))
    const from: Array<Array<'pair' | 'skipSlice' | 'skipLine' | null>> = Array.from({ length: n + 1 }, () =>
      new Array<'pair' | 'skipSlice' | 'skipLine' | null>(m + 1).fill(null),
    )
    dp[0]![0] = 0
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        const cur = dp[i]![j]!
        if (!Number.isFinite(cur)) continue
        if (i < n && j < m) {
          const cost = cur + pairCost(i, j)
          if (cost < dp[i + 1]![j + 1]!) {
            dp[i + 1]![j + 1] = cost
            from[i + 1]![j + 1] = 'pair'
          }
        }
        if (i < n) {
          const cost = cur + skipCost
          if (cost < dp[i + 1]![j]!) {
            dp[i + 1]![j] = cost
            from[i + 1]![j] = 'skipSlice'
          }
        }
        if (j < m) {
          const cost = cur + skipCost
          if (cost < dp[i]![j + 1]!) {
            dp[i]![j + 1] = cost
            from[i]![j + 1] = 'skipLine'
          }
        }
      }
    }

    const pairs: Array<{ sliceIndex: number; lineId: Id; ratio: number }> = []
    const unmatched: number[] = []
    let i = n
    let j = m
    while (i > 0 || j > 0) {
      const step = from[i]?.[j] ?? null
      if (step === 'pair') {
        pairs.push({
          sliceIndex: slices[i - 1]!.sliceIndex,
          lineId: lines[j - 1]!.lineId,
          ratio: durations[i - 1]! / (expected[j - 1]! * rate),
        })
        i -= 1
        j -= 1
        continue
      }
      if (step === 'skipSlice') {
        unmatched.push(slices[i - 1]!.sliceIndex)
        i -= 1
        continue
      }
      if (step === 'skipLine') {
        j -= 1
        continue
      }
      // 理论上不可达（dp 表保证每个格子都有来路）；保险起见按滑动窗口收尾
      if (i > 0) {
        unmatched.push(slices[i - 1]!.sliceIndex)
        i -= 1
      } else {
        j -= 1
      }
    }
    pairs.reverse()
    unmatched.reverse()
    return { pairs, unmatchedSlices: unmatched }
  }

  /**
   * 两遍对齐：先估语速尺度，再按尺度重算。
   *
   * 为什么需要第一遍：用户的真实语速常常与设置里的 `charsPerSecond` 差一大截
   * （不同人、不同情绪、不同文体）。只做一遍的话，「整体慢一倍」会被当成
   * 「每一句都不吻合」→ 全部低于置信度下限 → **一条都匹配不上**，
   * 而用户念得好好的。这与「宁可让用户调参也不产出坏数据」的取向不冲突：
   * 第一遍只用来估一个**整体尺度**（中位数，抗单点离群），真正的接受/拒绝仍看第二遍的置信度。
   *
   * 少于 {@link MIN_PAIRS_FOR_RATE} 对配对时**不估尺度**（样本太少，一句超长就会被当成
   * 「语速慢一倍」）—— 此时报告 scale = 1，让用户自己决定是否调 `charsPerSecond`。
   */
  const provisional = align(1)
  const ratios = provisional.pairs.map((p) => p.ratio).filter((r) => Number.isFinite(r) && r > 0)
  const rate =
    ratios.length >= MIN_PAIRS_FOR_RATE
      ? clampRate(median(ratios))
      : 1
  const finalPass = rate === 1 ? provisional : align(rate)

  const matches: SliceMatchResult[] = []
  const unmatchedSlices: number[] = []
  const matchedLines = new Set<Id>()
  for (const pair of finalPass.pairs) {
    const confidence = confidenceOf(pair.ratio, tolerance)
    if (confidence < minConfidence) {
      // 「没有更好的选择」不等于「匹配上了」：低于下限的配对回到未匹配，
      // 让用户看到「这一片没找到对应行」，而不是一条毫无意义的对应关系
      unmatchedSlices.push(pair.sliceIndex)
      continue
    }
    matches.push({ sliceIndex: pair.sliceIndex, lineId: pair.lineId, confidence })
    matchedLines.add(pair.lineId)
  }
  unmatchedSlices.push(...finalPass.unmatchedSlices)
  unmatchedSlices.sort((a, b) => a - b)
  matches.sort((a, b) => a.sliceIndex - b.sliceIndex)

  const unrecordedLines = lines.filter((l) => !matchedLines.has(l.lineId)).map((l) => l.lineId)
  // 「已接受但值得复核」的一档（不是被拒的那一档，见 minConfidence 的说明）
  const lowConfidenceSlices = matches.filter((mm) => mm.confidence < reviewConfidence).map((mm) => mm.sliceIndex)

  // 报告用的整体尺度：匹配上的切片时长之和 / 期望时长之和
  // （1 表示「设置的语速就是对的」；明显偏离时 UI 可以建议改 charsPerSecond）
  const durationBySlice = new Map(slices.map((s, idx) => [s.sliceIndex, durations[idx]!] as const))
  const expectedByLine = new Map(lines.map((l, idx) => [l.lineId, expected[idx]!] as const))
  let sliceSum = 0
  let expectedSum = 0
  for (const mm of matches) {
    sliceSum += durationBySlice.get(mm.sliceIndex) ?? 0
    expectedSum += expectedByLine.get(mm.lineId) ?? 0
  }
  const scale = expectedSum > 0 ? round3(sliceSum / expectedSum) : 1

  return { matches, unmatchedSlices, unrecordedLines, lowConfidenceSlices, scale }
}

/** 估计语速尺度所需的最少配对数（样本太少时一句超长就会被当成「语速慢一倍」） */
export const MIN_PAIRS_FOR_RATE = 3

/** 语速尺度的合理范围：超出就说明「对齐本身不可信」，宁可退回 1（按设定语速算） */
export const RATE_RANGE = { min: 0.5, max: 2.5 } as const

/** 中位数（抗单点离群：一句被切成两半不该把整体尺度带偏） */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : ((sorted[mid - 1]! + sorted[mid]!) / 2)
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1
  return Math.min(RATE_RANGE.max, Math.max(RATE_RANGE.min, rate))
}

/**
 * 置信度：比值恰好等于期望时长时 = 1.0；到容忍边界时 = 0.5；越界后快速趋零。
 *
 * 形状取 **cos 的半个周期**（`0.5 + 0.5·cos(x·π/2)`）而不是线性：
 * 容忍区**内部**要保持高置信（那段是「匹配得挺好」），到边界才开始明显下降，
 * 出界后迅速掉下去。线性衰减在中心附近太平（0.9 与 0.6 只差一点），
 * 会让「大致对齐」和「几乎对齐」看起来一样可信。
 */
export function confidenceOf(ratio: number, tolerance: number): number {
  const t = tolerance > 1 ? tolerance : 1.6
  const logRatio = Math.abs(Math.log(ratio > 0 ? ratio : 1e-6))
  const logT = Math.log(t)
  if (logRatio <= logT) {
    const x = logRatio / logT
    return round3(0.5 + 0.5 * Math.cos((Math.PI / 2) * x))
  }
  const over = (logRatio - logT) / logT
  return round3(0.5 * Math.exp(-over * 3))
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
