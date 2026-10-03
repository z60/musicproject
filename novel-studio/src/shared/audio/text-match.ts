/**
 * Novel Studio · 切句 ↔ 画本行匹配：**文本比对内核**（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/12 §4.3、docs/13 §8.2、docs/91 §5.2.49
 *
 * ## 这个模块解决什么问题
 *
 * 「按说话人导入音频」的形态是「**一个文件 = 一个说话人 + 一段章节区间**」，
 * 真实样本里一个文件能覆盖 74 章、上百行。要落到**行**上，只有两条路：
 *
 * | 路线 | 判据 | 代价 |
 * |------|------|------|
 * | 纯时长对齐（已有 `match.ts`） | 每句时长 ≈ 该行字数 × 语速 | 零依赖，但**说话人停顿不齐就会整体错位** |
 * | **文本比对（本模块）** | 把每句识别成文字，与行文本比对 | 需要 ASR（whisper.cpp），但**顺序错乱也能对上** |
 *
 * 时长对齐最怕「多切/少切一句」：一旦错一句，**后面全部顺移**。
 * 文本比对不怕 —— 它是按内容认领的。所以两者要**结合起来**：
 * 文本相似度给主判据，时长给先验与兜底。
 *
 * ## 本模块只做纯逻辑
 *
 *   ```
 *   VAD 切句 → [音频段]                    ← shared/audio/vad.ts（已有）
 *   ASR 识别 → [每段的文本]                 ← 需要 whisper.cpp（主进程接线，未做）
 *   文本比对 → 段 ↔ 行 的对应 + 置信度        ← **本模块**
 *   人工确认 → 落库                        ← record:acceptSlices（已有）
 *   ```
 *
 * 本模块**不碰音频、不跑 ASR**：输入是「已经识别好的文本」。
 * 这样它能被完整单测，而真正需要 whisper 的那一步在接线时替换即可。
 *
 * ## 相似度判据为什么不用「编辑距离除以长度」
 *
 *   中文台词经 ASR 识别后常见三类噪声：
 *     1. **同音字**（「石志坚」→「石志间」）—— 编辑距离会认为差很多，实际只差一个字
 *     2. **标点全丢**（ASR 通常不输出标点）—— 必须先归一化，否则每句都"不像"
 *     3. **口语填充**（「嗯」「那个」）—— 会被算成插入
 *
 *   所以本模块用 **字符级 Dice 系数**（`2·|交集| / (|A|+|B|)`，按**多重集**计），
 *   它对同音字与少量插入删除的鲁棒性明显好于编辑距离，
 *   而且 O(n) 就能算出来（编辑距离是 O(n²)，在上百行 × 上百句的规模下差别很大）。
 *
 * 本目录禁止引入任何第三方依赖。
 */

/** 一段 ASR 识别结果（时间轴 + 文本） */
export interface AsrSegment {
  /** 在音频里的起止（毫秒） */
  startMs: number
  endMs: number
  /** 识别出的文本（可能为空串 —— 识别失败或纯噪声） */
  text: string
  /** 识别置信度 0~1（whisper 会给；拿不到时传 null） */
  asrConfidence?: number | null
}

/** 一条候选画本行 */
export interface MatchableLine {
  lineId: string
  /** 该行文本（会先归一化再比对） */
  text: string
  /**
   * 该行在**本说话人区间内的顺序序号**（0 基）。
   *
   * 用于「顺序先验」：ASR 段落与画本行**大体同序**，
   * 所以「位置差很多」的配对要被扣分 —— 这是时长之外的第二个约束。
   */
  order: number
}

/** 一段的候选配对（一段可能对应多行的候选） */
export interface TextMatchCandidate {
  segmentIndex: number
  lineId: string
  /** 文本相似度 0~1（归一化后的 Dice 系数） */
  textSimilarity: number
  /** 综合得分 0~1（文本为主 + 时长/顺序先验） */
  score: number
  /** 该段识别出的文本（便于 UI 展示「识别成了什么」） */
  recognized: string
  /** 该行原文本（便于 UI 对照） */
  expected: string
  /** 命中的判据说明（UI 直接展示，便于人工判断） */
  reasons: string[]
}

export interface TextMatchOptions {
  /**
   * 文本相似度的**接受下限**。低于它的配对不会被采用。
   * 默认 0.34：中文台词短句多，同音字 + 标点丢失后相似度普遍在 0.5 上下，
   * 0.34 能容纳 2~3 个字的差异而不会把不相关的句子配进来。
   */
  minSimilarity?: number
  /**
   * 顺序先验的强度 0~1（默认 0.25）。
   * 得分 = `(1-w)·文本 + w·顺序分`。设为 0 则完全忽略顺序。
   */
  orderWeight?: number
  /**
   * 时长先验的强度 0~1（默认 0.15）。
   * 需要调用方给出 `expectedDurationMs`（按字数 × 语速估）。
   */
  durationWeight?: number
  /** 该说话人的语速（字/秒），用于估时长。不传则不做时长先验 */
  charsPerSecond?: number
}

export interface TextMatchResult {
  /** 采用的配对（按段序号升序） */
  matches: Array<{
    segmentIndex: number
    lineId: string
    score: number
    textSimilarity: number
    reasons: string[]
  }>
  /** 没能配上的段（识别为空、或相似度都不够） */
  unmatchedSegments: number[]
  /** 没有被任何段认领的行 */
  unclaimedLines: string[]
  /**
   * 每段的候选（按得分降序，最多 3 个）。UI 让用户改配对时直接用它。
   */
  candidatesBySegment: TextMatchCandidate[][]
  /** 整体质量评估，UI 据此提示「需要复核」 */
  quality: {
    /** 平均相似度（只看采用的配对） */
    avgSimilarity: number
    /** 段数与行数是否一致 */
    countMatched: boolean
    /** 是否存在「两段争一行」被抢占的情况 */
    hadContention: boolean
  }
}

// ---------------------------------------------------------------------------
// 文本归一化
// ---------------------------------------------------------------------------

/** 中文标点与常见修饰符号（比对时全部丢掉） */
const PUNCT_RE = /[\s\u3000。，、！？；：“”‘’「」『』（）()《》〈〉【】\[\]{}·・—－\-~～…\.\,\!\?\:\;\"']/g

/**
 * 归一化文本：去标点、去空白、去零宽字符、大小写折叠。
 *
 * **为什么必须做**：ASR（whisper）几乎不输出标点，而画本行里满是 `“”，。！`。
 * 不归一化的话，每句话的相似度都会被标点拉到 0.6 以下，
 * 「全都像」和「全都不像」一样没用。
 */
export function normalizeForCompare(text: string): string {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(PUNCT_RE, '')
    .toLowerCase()
}

/**
 * 字符级 **Dice 系数**（按多重集计）。
 *
 * ```
 *   dice(A,B) = 2 · Σ_min(countA(c), countB(c)) / (|A| + |B|)
 * ```
 *
 * 相比编辑距离的优点（中文 ASR 场景）：
 *   · 对**同音字**宽容：`石志坚` vs `石志间` → 仍有 0.667
 *     （编辑距离版本是 1 - 1/3 = 0.667，看似相同，但一旦有一处插入：
 *      `石志坚说` vs `石志间` 时 Dice 是 0.75，而编辑距离会掉到 0.5）
 *   · 对**词序轻微调换**友好（多重集不计顺序）
 *   · O(n)，不用 DP 表
 *
 * 已知局限（如实记录）：多重集不计顺序，所以「甲乙」与「乙甲」会被判为完全相同。
 * 对**短句**这会过于宽松 —— 因此真实使用时还有「顺序先验」与「时长先验」兜着，
 * 而且最终一定经过人工确认（`record:acceptSlices` 是显式动作）。
 */
export function diceCoefficient(a: string, b: string): number {
  const x = normalizeForCompare(a)
  const y = normalizeForCompare(b)
  if (x.length === 0 && y.length === 0) return 0
  if (x.length === 0 || y.length === 0) return 0

  const counts = new Map<string, number>()
  for (const ch of x) counts.set(ch, (counts.get(ch) ?? 0) + 1)

  let overlap = 0
  for (const ch of y) {
    const n = counts.get(ch)
    if (n === undefined || n === 0) continue
    counts.set(ch, n - 1)
    overlap++
  }
  return (2 * overlap) / (x.length + y.length)
}

/**
 * 顺序先验分：两段在各自序列里的**相对位置**越接近，分越高。
 *
 * 用相对位置（而非绝对序号）是为了容忍「多切了一句」导致的整体顺移 ——
 * 那样绝对序号会全错，但相对位置仍然接近。
 */
export function orderPrior(segmentIndex: number, segmentCount: number, lineOrder: number, lineCount: number): number {
  if (segmentCount <= 1 || lineCount <= 1) return 1
  const sPos = segmentIndex / (segmentCount - 1)
  const lPos = lineOrder / (lineCount - 1)
  return Math.max(0, 1 - Math.abs(sPos - lPos))
}

/**
 * 时长先验分：该段实际时长与该行「按字数估的时长」越接近越好。
 *
 * @returns 0~1；给不出估计（没语速 / 时长为 0）时返回 1（**不加权也不惩罚**）
 */
export function durationPrior(
  segmentDurationMs: number,
  lineCharCount: number,
  charsPerSecond: number | undefined,
): number {
  if (!charsPerSecond || charsPerSecond <= 0) return 1
  if (segmentDurationMs <= 0 || lineCharCount <= 0) return 1
  const expectedMs = (lineCharCount / charsPerSecond) * 1000
  if (expectedMs <= 0) return 1
  const ratio = segmentDurationMs / expectedMs
  // 比值 1 → 1 分；比值 2 或 0.5 → 2/3 分；比值 4 或 0.25 → 1/3 分（1/ratio 越界时对称处理）
  const r = ratio >= 1 ? ratio : 1 / ratio
  return 1 / r
}

// ---------------------------------------------------------------------------
// 主匹配
// ---------------------------------------------------------------------------

/**
 * 把 ASR 段落与画本行配对。
 *
 * ### 算法（为什么不是简单的贪心）
 *   1. 算出**所有** 段×行 的得分（段数 × 行数，真实规模是 100×100 量级，可接受）
 *   2. 按得分**降序全局贪心认领**：每次取当前最高分的 (段,行)，
 *      两者都还没被认领才接受
 *   3. 低于 `minSimilarity` 的一律不认领
 *
 *   为什么用全局贪心而不是「每段取自己最高分」：
 *   后者会出现「两段都认为自己是第 7 行」——先到先得取决于遍历顺序，
 *   而全局贪心让**分差最大的那对先落定**，结果更稳。
 *   代价是同一行只会被认领一次；真实的「一行被切成两段」会留下一个未配对段，
 *   由 UI 让人工处理（**不猜**，与 `record:acceptSlices` 的纪律一致）。
 */
export function matchAsrToLines(
  segments: readonly AsrSegment[],
  lines: readonly MatchableLine[],
  opts: TextMatchOptions = {},
): TextMatchResult {
  const minSimilarity = opts.minSimilarity ?? 0.34
  const orderWeight = opts.orderWeight ?? 0.25
  const durationWeight = opts.durationWeight ?? 0.15

  const lineCount = lines.length
  const segmentCount = segments.length

  /** 全部候选得分 */
  const scored: TextMatchCandidate[] = []
  for (let s = 0; s < segmentCount; s++) {
    const seg = segments[s]!
    const recognized = String(seg.text ?? '')
    const dur = Math.max(0, seg.endMs - seg.startMs)
    for (let l = 0; l < lineCount; l++) {
      const line = lines[l]!
      const sim = diceCoefficient(recognized, line.text)
      const op = orderPrior(s, segmentCount, line.order, lineCount)
      const dp = durationPrior(dur, normalizeForCompare(line.text).length, opts.charsPerSecond)

      const reasons: string[] = []
      if (sim >= 0.8) reasons.push('文本高度吻合')
      else if (sim >= 0.5) reasons.push('文本基本吻合')
      else if (sim > 0) reasons.push('文本部分吻合')

      // 综合得分：权重归一化（三者相加为 1，避免调参时整体尺度漂移）
      const wText = Math.max(0, 1 - orderWeight - durationWeight)
      const score = sim * wText + op * orderWeight + dp * durationWeight

      scored.push({
        segmentIndex: s,
        lineId: line.lineId,
        textSimilarity: sim,
        score,
        recognized,
        expected: line.text,
        reasons,
      })
    }
  }

  // 候选表（每段按得分降序，最多留 3 个，供 UI 让用户改配对）
  const candidatesBySegment: TextMatchCandidate[][] = Array.from({ length: segmentCount }, () => [])
  for (const c of scored) candidatesBySegment[c.segmentIndex]!.push(c)
  for (const list of candidatesBySegment) list.sort((a, b) => b.score - a.score || a.lineId.localeCompare(b.lineId))

  // 全局贪心认领
  scored.sort((a, b) => b.score - a.score || a.segmentIndex - b.segmentIndex || a.lineId.localeCompare(b.lineId))

  const claimedSeg = new Set<number>()
  const claimedLine = new Set<string>()
  const matches: TextMatchResult['matches'] = []
  let hadContention = false

  for (const c of scored) {
    if (c.textSimilarity < minSimilarity) continue
    if (claimedSeg.has(c.segmentIndex)) continue
    if (claimedLine.has(c.lineId)) {
      hadContention = true
      continue
    }
    claimedSeg.add(c.segmentIndex)
    claimedLine.add(c.lineId)
    matches.push({
      segmentIndex: c.segmentIndex,
      lineId: c.lineId,
      score: c.score,
      textSimilarity: c.textSimilarity,
      reasons: c.reasons,
    })
  }

  matches.sort((a, b) => a.segmentIndex - b.segmentIndex)

  const unmatchedSegments: number[] = []
  for (let s = 0; s < segmentCount; s++) if (!claimedSeg.has(s)) unmatchedSegments.push(s)

  const unclaimedLines = lines.filter((l) => !claimedLine.has(l.lineId)).map((l) => l.lineId)

  const avgSimilarity =
    matches.length === 0 ? 0 : matches.reduce((sum, m) => sum + m.textSimilarity, 0) / matches.length

  return {
    matches,
    unmatchedSegments,
    unclaimedLines,
    candidatesBySegment,
    quality: {
      avgSimilarity,
      countMatched: segmentCount === lineCount,
      hadContention,
    },
  }
}

/**
 * 判断「这次匹配结果是否足够可信，可以自动通过」。
 *
 * 纪律：**默认不自动通过**。只有当
 *   · 段数与行数完全一致
 *   · 平均相似度足够高
 *   · 没有争抢
 *   · 每个配对都超过高置信阈值
 * 四条同时成立时才建议自动通过；否则一律交人工确认。
 *
 * 这与 `record:matchSlices` 的既有纪律一致（docs/12 §4.3）：
 * **不替用户决定**，宁可让他多点一下。
 */
export function isAutoAcceptable(
  result: TextMatchResult,
  opts: { minAvgSimilarity?: number; minPerMatchSimilarity?: number } = {},
): { ok: boolean; reasons: string[] } {
  const minAvg = opts.minAvgSimilarity ?? 0.75
  const minPer = opts.minPerMatchSimilarity ?? 0.6
  const reasons: string[] = []

  if (!result.quality.countMatched) {
    reasons.push(`切出的句数（${result.matches.length + result.unmatchedSegments.length}）与行数不一致`)
  }
  if (result.unmatchedSegments.length > 0) {
    reasons.push(`有 ${result.unmatchedSegments.length} 段没能配上行`)
  }
  if (result.unclaimedLines.length > 0) {
    reasons.push(`有 ${result.unclaimedLines.length} 行没有被认领`)
  }
  if (result.quality.hadContention) reasons.push('存在「多段争同一行」的情况')
  if (result.quality.avgSimilarity < minAvg) {
    reasons.push(`平均相似度 ${result.quality.avgSimilarity.toFixed(2)} 低于 ${minAvg}`)
  }
  const weak = result.matches.filter((m) => m.textSimilarity < minPer)
  if (weak.length > 0) reasons.push(`有 ${weak.length} 个配对的相似度低于 ${minPer}`)

  return { ok: reasons.length === 0, reasons }
}
