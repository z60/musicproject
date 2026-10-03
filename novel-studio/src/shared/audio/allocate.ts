/**
 * Novel Studio · 把 VAD 语音片**铺满**画本行（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/12 §4.3、docs/05 §4（VAD）、docs/91 §5.2.49
 *
 * ## 这个模块与 `match.ts` 的分工（两者不是一回事）
 *
 * | 模块 | 形态 | 回答的问题 |
 * |------|------|-----------|
 * | `match.ts` 的 `matchSlicesToLines` | **配对** | 「第 3 片是不是第 7 行？」→ 输出若干对 + 置信度，配不上的就**不配** |
 * | 本模块 `allocateLinesToSlices` | **铺满** | 「这 N 行各自占哪一段音频？」→ 输出**每行一段**不重叠区间 |
 *
 * 为什么导入场景需要后者：
 *   「一个音频文件 = 一个说话人 + 一段章节区间」要落到**每一行**上，
 *   所以**不允许有行拿不到区间**（否则那一行在界面上永远是未录）。
 *   配对的思路会留下「未配对」，而导入需要的是全覆盖。
 *
 * 两者的关系：`match.ts` 用于**直播录音**的切片确认（可以由人挑挑拣拣）；
 *   本模块用于**导入既成音频**（必须全铺开，错的由人改）。
 *
 * ## 核心难点：句子数与行数**几乎不会相等**
 *
 * VAD 切出 87 片、而画本有 90 行，这是常态（漏检、连读、环境噪声都会影响）。
 * 所以算法必须能处理三种情形：
 *
 * ```
 *   M === N   一片一行            → 直接对应
 *   M <  N   片子不够            → 按行文本长度**合并**相邻片，或按比例**切分**片
 *   M >  N   片子太多            → 把相邻片**归并**给同一行
 * ```
 *
 * 本模块的做法是「**按文本长度分配总时长**」：
 *   1. 先算出每行应占的**时长占比**（按字符数）
 *   2. 再沿时间轴依次切出每行的区间（在语音片的**边界**上尽量对齐）
 *
 * 这样无论 M 与 N 是什么关系都能得到「每行一段、无缝、不重叠」的结果，
 * 且**总时长被完整覆盖**（不会把音频尾巴丢掉）。
 *
 * ⚠️ 这是**时长比例**分配，不是强制对齐：它保证「每行都有音频」，
 *    但**不保证**切出来的边界正好落在句子上。
 *    真正确认边界要靠 ASR 文本比对（`text-match.ts`）或人工微调。
 *    所以结果里带 `confidence`，低置信度的行要提示用户复核。
 *
 * 本目录禁止引入任何第三方依赖。
 */

import type { Id } from '../types.ts'

/**
 * 吸附容忍度的默认上限（毫秒，语音坐标）。
 *
 * 真机实测依据（2221 章旁白，24 行 / 33 片）：
 *   · 无上限（= 期望时长的一半，可达 3 s）→ 每行时长 / 应有时长 的比值 0.34 ~ 2.43；
 *   · 上限 600 ms → 比值收窄到 0.63 ~ 1.6，且偏移不再跨句。
 * 「附近没有停顿」时按比例切，比把整句音频挪到别人头上更接近真相。
 */
export const DEFAULT_MAX_SNAP_MS = 600

/**
 * 找句间能量低谷的默认搜索半径（毫秒）。
 *
 * 取 1500 ms 的理由：连续朗读里，「本句末尾」离按字数算出的比例位置通常不超过一句；
 * 半径再大就可能落到**别人那句**的停顿上（那正是 5.2.59 的故障形态）。
 * 实际使用时还会被「本行期望时长 × 0.6」压小。
 */
export const DEFAULT_DIP_SEARCH_MS = 1500

/** 一个语音片（来自 VAD） */
export interface SpeechSlice {
  /** 在**源音频**里的起止（毫秒，绝对时间轴） */
  startMs: number
  endMs: number
  /** 该片是否被 VAD 标记为可疑（如 `too_long`） */
  flags?: string[]
}

/** 一条画本行（分配用） */
export interface AllocatableLine {
  lineId: Id
  /** 该行要念的文本 */
  text: string
}

/**
 * 逐帧能量包络（`frameEnergy` 的产物：每 20 ms 一帧的 RMS）。
 *
 * 为什么需要它：VAD 的切片阈值是「静音」的硬判据，**句间那种又短又浅的停顿**
 * （100~200 ms、比语音低 4~10 dB）过不了阈值，于是好几行被并进同一片。
 * 但它们在能量包络上**是看得见的低谷** —— 拿它当切点，比按字符比例硬切准得多。
 * 代价是每帧都要算（O(采样数)），这正是「慢一点没关系，要能对上」的取舍。
 */
export interface EnergyEnvelope {
  /** 帧长（毫秒） */
  frameMs: number
  /** 每帧 RMS（dBFS，越负越安静）。非有限值（数字静音）按 -120 处理 */
  values: readonly number[]
}

/** 分配给某一行的一段区间 */
export interface LineAudioRange {
  lineId: Id
  /** 在源音频里的起止（毫秒，绝对时间轴） */
  startMs: number
  endMs: number
  /** 覆盖了哪几个语音片（下标，闭区间） */
  sliceFrom: number
  sliceTo: number
  /**
   * 置信度 0~1。
   * 高 = 这一段的边界落在语音片边界上（切得干净）；
   * 低 = 边界落在片中间（多半是「片数不够、按比例硬切」）。
   */
  confidence: number
  /** 判定依据（UI 直接展示，便于人工判断要不要改） */
  reasons: string[]
}

export interface AllocateOptions {
  /**
   * 语音片之间的**静音间隙**归给谁。
   * - `'previous'`（默认）：归前一行 —— 念完一句后的自然停顿属于这一句
   * - `'split'`：从中间切开
   */
  gapOwner?: 'previous' | 'split'
  /**
   * 置信度低于此值的行会被标进 `needsReview`（默认 0.5）。
   * 不设更高是因为「按比例硬切」在这种数据上是常态，门槛太高会满屏警告。
   */
  lowConfidenceThreshold?: number
  /**
   * 吸附容忍度的**上限**（毫秒，语音坐标，默认 `DEFAULT_MAX_SNAP_MS`）。
   *
   * 为什么必须有上限：容忍度原本是「本行期望语音时长的一半」——
   * 一行期望 6 s 时容忍度就是 3 s，于是可以把边界拖到 3 s 外的某个停顿上。
   * 真机实测（2221 章旁白 24 行）：这样切出来的每行时长与「按字数该有的时长」
   * 比值在 **0.34 ~ 2.43** 之间，用户看到的就是「第 3 行的音和文本对不上」
   * （前一行只拿到 3.5 s、这一行被拉到 6.9 s）。
   * 上限 600 ms 的语义是：**只在比例位置附近微调**，
   * 附近没有停顿就老实地按比例切 —— 那比把整句音频挪到别人头上更接近真相。
   */
  maxSnapMs?: number
  /**
   * 逐帧能量包络：VAD 片边界都太远时，**改成找句间能量低谷**当切点
   * （`EnergyEnvelope` 的说明见上）。不传 = 只用比例切分。
   */
  energy?: EnergyEnvelope | null
  /** 找能量低谷的搜索半径上限（毫秒，默认 `DEFAULT_DIP_SEARCH_MS`） */
  dipSearchMs?: number
}

export interface AllocateResult {
  /** 每行一段（与传入顺序一致） */
  ranges: LineAudioRange[]
  /** 需要人工复核的行（置信度低、或 VAD 片数明显不足） */
  needsReview: Id[]
  /** 整体提示（UI 顶部展示） */
  warnings: string[]
  stats: {
    sliceCount: number
    lineCount: number
    /** 是否一片一行（最理想） */
    oneToOne: boolean
    /** 覆盖到的音频总时长（毫秒） */
    coveredMs: number
    /** 平均置信度 */
    avgConfidence: number
  }
}

/**
 * 按文本长度把语音片**铺满**所有行。
 *
 * @param slices 语音片（按时间升序，**允许中间有静音间隙**）
 * @param lines  画本行（按应有的朗读顺序）
 */
export function allocateLinesToSlices(
  slices: readonly SpeechSlice[],
  lines: readonly AllocatableLine[],
  opts: AllocateOptions = {},
): AllocateResult {
  const warnings: string[] = []

  // ── 退化情形 ──────────────────────────────────────────────────────────────
  if (lines.length === 0) {
    return {
      ranges: [],
      needsReview: [],
      warnings: ['没有画本行可分配'],
      stats: { sliceCount: slices.length, lineCount: 0, oneToOne: false, coveredMs: 0, avgConfidence: 0 },
    }
  }
  if (slices.length === 0) {
    // **不编造区间**：没有任何语音片时如实返回「全部需要复核」
    return {
      ranges: [],
      needsReview: lines.map((l) => l.lineId),
      warnings: ['没有检测到任何语音片（VAD 未找到人声）—— 整段音频可能都是静音，或阈值不合适'],
      stats: { sliceCount: 0, lineCount: lines.length, oneToOne: false, coveredMs: 0, avgConfidence: 0 },
    }
  }

  // ── 1) 计算每行的权重（按字符数，下限 1 防止空行占 0）────────────────────
  const weights = lines.map((l) => Math.max(1, [...String(l.text ?? '')].length))

  /**
   * 时间轴取「第一片起点 → 最后一片终点」。
   *
   * 为什么不从 0 开始：真实交付的音频前面常有几秒空白/板声，
   * 把它算进第一行会让第一行莫名长出一大截。
   */
  const timelineStart = slices[0]!.startMs
  const timelineEnd = slices[slices.length - 1]!.endMs

  const gapOwner = opts.gapOwner ?? 'previous'
  const maxSnapMs = opts.maxSnapMs ?? DEFAULT_MAX_SNAP_MS
  const energy = opts.energy ?? null
  const dipSearchMs = opts.dipSearchMs ?? DEFAULT_DIP_SEARCH_MS

  /**
   * ── 特例：片数 === 行数 → **直接一片一行** ────────────────────────────────
   *
   * ### 为什么必须走这条捷径（不是优化，是正确性）
   *   下面那条通用路径是「按文本长度比例算出一个边界，再吸附到语音片边界」。
   *   它有个**结构性缺陷**：比例是拿**整条时间轴**（含句间静音）算的，
   *   而静音不属于任何一行的朗读时长 —— 于是估算位置会系统性地偏，
   *   偏移量约为**一个静音间隙**。它在每一步吸附后重新同步，所以误差不累积，
   *   但**短行容不下一个间隙**：容差是 `max(200, 期望长度×0.5)`，
   *   而间隙常有 400~500 ms ⇒ 短行吸附失败 ⇒ 被打成低置信度。
   *
   *   实测（真样本 237 行，见 `scripts/verify-audio-import-sample.ts`）：
   *   即使 VAD 切出的片数与行数**完全相等**（一片一行的理想情形），
   *   通用路径仍会把 9 行里的 1 行、40 行里的 15 行、93 行里的 19 行判成低置信度，
   *   原因全是「附近没有语音片边界（最近的在 400+ ms 外）」。
   *   而这些行的边界**本来就是确定的** —— 第 i 行就是第 i 片。
   *
   * ### 语义与通用路径保持一致
   *   · 行 i 的区间 = `[上一片末尾, 第 i 片末尾]` —— 静音间隙归**前一行**
   *     （`gapOwner='previous'`，与「念完一句后的停顿属于这一句」一致）；
   *     `gapOwner='split'` 时从间隙中点切
   *   · 无缝、不重叠、覆盖到末尾三条不变量照样成立
   *   · 置信度 **1**：这是信息最完整的情形，没有理由让用户去复核
   */
  if (slices.length === lines.length) {
    /**
     * 每行区间的起点 = **前一片的末尾**（第 0 行是首片起点）。
     *
     * 也就是说：行 i 的区间是 `[第 i-1 片的末尾, 第 i 片的末尾]` ——
     * 它**以一段静音开头**，那段静音就是上一句念完后的停顿。
     *
     * ⚠️ 这与「间隙归前一行」这句注释**字面上看着矛盾**，但两者说的是两件事：
     *   语义上那段停顿是**上一句的收尾**（所以叫 gapOwner='previous'），
     *   而几何上区间必须无缝，所以它物理上落在**下一行的开头**。
     *   通用路径一直就是这个行为（既有测试 `ranges[0].endMs === S[0].endMs` 钉着它），
     *   本捷径与它保持一致 —— 否则同一份输入会因为「片数是否恰好等于行数」
     *   而得到两种不同的切法，那才是真正的坑。
     */
    const starts: number[] = [timelineStart]
    for (let i = 1; i < slices.length; i++) {
      const prevEnd = slices[i - 1]!.endMs
      const curStart = slices[i]!.startMs
      const at = gapOwner === 'split' ? Math.round((prevEnd + curStart) / 2) : prevEnd
      starts.push(Math.max(at, starts[i - 1]! + 1))
    }
    const oneToOneRanges: LineAudioRange[] = lines.map((line, i) => {
      const startMs = starts[i]!
      const endMs =
        i === lines.length - 1 ? Math.max(timelineEnd, startMs + 1) : Math.max(starts[i + 1]!, startMs + 1)
      return {
        lineId: line.lineId,
        startMs,
        endMs,
        sliceFrom: sliceIndexAt(slices, startMs),
        sliceTo: sliceIndexAt(slices, Math.max(startMs, endMs - 1)),
        confidence: 1,
        /**
         * 措辞同时点出「一片一行」与「切在该片末尾」。
         * 后半句是既有断言（`/语音片末尾/`）在看的，而它确实描述了切点在哪。
         */
        reasons: [`一片一行：第 ${i + 1} 行切在第 ${i + 1} 个语音片末尾`],
      }
    })
    const suspiciousSlices = slices.filter((s) => (s.flags ?? []).length > 0).length
    if (suspiciousSlices > 0) {
      warnings.push(`有 ${suspiciousSlices} 个语音片被 VAD 标记为可疑（如过长），复核时请留意`)
    }
    return {
      ranges: oneToOneRanges,
      // 一片一行是信息最完整的情形，不做低置信度判定
      needsReview: [],
      warnings,
      stats: {
        sliceCount: slices.length,
        lineCount: lines.length,
        oneToOne: true,
        coveredMs: oneToOneRanges.reduce((sum, r) => sum + Math.max(0, r.endMs - r.startMs), 0),
        avgConfidence: 1,
      },
    }
  }

  // ── 2) 依次切出每行的区间 ────────────────────────────────────────────────
  const ranges: LineAudioRange[] = []

  /**
   * ## 为什么目标位置算在「**语音时长**」上，而不是「时间轴」上
   *
   * 这是本文件第二个、也是更隐蔽的一个结构性缺陷（第一个是 ⑫ 的反向区间）。
   *
   * 第一版（以及片数=行数时的通用路径）都是：
   * ```
   *   目标位置 = cursor + 剩余时间轴 × (本行权重 / 剩余权重)
   * ```
   * 而**时间轴包含句间静音**，静音却不属于任何一行的朗读时长 ——
   * 于是估算位置系统性地偏，偏移量约为**一个静音间隙**。
   * 它在每一步吸附后重新同步，所以误差不累积，但只要间隙大于该行的容差，
   * 吸附就会失败、这一行就被打成低置信度。
   *
   * 实测（真样本，`scripts/verify-audio-import-sample.ts`）：
   * 每行朗读 1.8s、间隙 0.42s 时，40 行里有 15 行、93 行里有 19 行被误判；
   * 原因永远是「附近没有语音片边界」。
   *
   * **正确做法**：先把「本行应当消耗多少**语音**」算出来，再把它映射回时间轴。
   * ```
   *   目标累计语音 = 总语音时长 × (本行及之前的权重 / 总权重)
   *   目标时刻     = timeAtSpeech(目标累计语音)   ← 静音不参与权重分配
   * ```
   * 这样静音只影响「映射」，不参与「分配」；片数 ≠ 行数时也不会把静音
   * 摊到各行头上。吸附判据同样改用**语音距离**（见 `snapToSpeechBoundary`）。
   */
  const speechLens = slices.map((s) => Math.max(0, s.endMs - s.startMs))
  const totalSpeech = speechLens.reduce((a, b) => a + b, 0)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  /** `cumSpeechEnd[j]` = 第 j 片**结束时**已消耗的语音时长 */
  const cumSpeechEnd: number[] = []
  {
    let acc = 0
    for (const len of speechLens) {
      acc += len
      cumSpeechEnd.push(acc)
    }
  }
  /** 第 j 片**开始前**已消耗的语音时长 */
  const cumSpeechBefore = (j: number): number => (j <= 0 ? 0 : (cumSpeechEnd[j - 1] ?? 0))

  /**
   * 累计语音时长 → 时间轴时刻。
   *
   * 落在某片内部时按该片内的语音偏移线性映射（片内没有静音，所以这一步是准的）；
   * 落进**片间静音**的部分由 `snapToSpeechBoundary` 的间隙归属规则处理。
   */
  const timeAtSpeech = (speech: number): number => {
    if (totalSpeech <= 0) return timelineEnd
    if (speech <= 0) return timelineStart
    if (speech >= totalSpeech) return timelineEnd
    for (let j = 0; j < slices.length; j++) {
      if ((cumSpeechEnd[j] ?? 0) >= speech) {
        const s = slices[j]!
        return Math.min(s.endMs, s.startMs + (speech - cumSpeechBefore(j)))
      }
    }
    return timelineEnd
  }

  let cumWeight = 0
  let cursor = timelineStart
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1
    const weight = weights[i]!

    cumWeight += weight
    /** 本行结束时「应当已经念掉」的累计语音时长 */
    const targetSpeech = totalWeight > 0 ? (totalSpeech * cumWeight) / totalWeight : totalSpeech
    /** 本行自己的语音时长估计（= 容差的基准） */
    const expectedSpeech = totalWeight > 0 ? (totalSpeech * weight) / totalWeight : 0

    const rawEnd = isLast ? timelineEnd : timeAtSpeech(targetSpeech)

    /**
     * 上界：非最后一行必须给后面每一行留至少 1ms。
     * 这是**硬保证** —— 吸附可以越过按语音算出的边界，所以最后还要夹一次。
     * （87 片铺 90 行时最后 3 行各只剩 1ms，就是少了这一夹。）
     */
    const linesAfter = lines.length - i - 1
    const latestAllowed = isLast ? timelineEnd : Math.max(cursor + 1, timelineEnd - linesAfter)
    const targetEnd = Math.min(Math.max(rawEnd, cursor + 1), latestAllowed)

    const snapped = snapToSpeechBoundary(
      slices,
      cumSpeechEnd,
      cursor,
      { targetSpeech, expectedSpeech, rawEnd: targetEnd },
      { isLast, gapOwner, timelineEnd: latestAllowed, maxSnapMs, energy, dipSearchMs },
    )
    const { startMs, endMs } = snapped

    /**
     * 事后复核：**本行拿到的时长**与「按字数应有的时长」差太多就标出来。
     *
     * 为什么在算完之后还要再看一眼：切点可能落在很干净的停顿上（听起来没错），
     * 但整行因此长了 3 倍 / 短了一半 —— 那说明**上一行的切点**偏了，这一行是被挤出来的。
     * 真机实测（2226 章旁白）就有 4.87× 的行：边界都在停顿上，但分配明显不对。
     * 这种必须让用户试听，而不是因为「切得干净」就宣告成功。
     */
    const density = timelineEnd > timelineStart ? totalSpeech / (timelineEnd - timelineStart) : 1
    const expectedMs = expectedSpeech / Math.max(0.2, density)
    const actualMs = endMs - startMs
    const ratio = actualMs / Math.max(1, expectedMs)
    const oddDuration = !isLast && expectedMs > 0 && (ratio > 1.6 || ratio < 0.55)
    const confidence = oddDuration ? Math.min(snapped.confidence, 0.45) : snapped.confidence
    const reason = oddDuration
      ? `${snapped.reason}；但本行时长 ${Math.round(actualMs)}ms 与字数估算 ${Math.round(expectedMs)}ms 相差较大，建议复核`
      : snapped.reason

    ranges.push({
      lineId: lines[i]!.lineId,
      startMs,
      endMs,
      sliceFrom: sliceIndexAt(slices, startMs),
      sliceTo: sliceIndexAt(slices, Math.max(startMs, endMs - 1)),
      confidence,
      reasons: [reason],
    })

    cursor = endMs
  }

  // ── 3) 复核提示 ──────────────────────────────────────────────────────────
  const oneToOne = slices.length === lines.length
  if (!oneToOne) {
    const diff = slices.length - lines.length
    warnings.push(
      diff < 0
        ? `检测到 ${slices.length} 个语音片，但有 ${lines.length} 行 —— 片数不足，已按文本长度比例切分（边界可能不落在句子上，请复核）`
        : `检测到 ${slices.length} 个语音片，但只有 ${lines.length} 行 —— 片数偏多，已把相邻片归并给同一行`,
    )
  }
  const suspicious = slices.filter((s) => (s.flags ?? []).length > 0).length
  if (suspicious > 0) {
    warnings.push(`有 ${suspicious} 个语音片被 VAD 标记为可疑（如过长），复核时请留意`)
  }

  /**
   * ### 区间完全落在静音上的行 —— 必须**单独报出来**
   *
   * 「区间长度 > 0」并不等于「这一行有声音」：一行完全落在两片之间的静音里时，
   * 区间是正的，但用户听到的是**一段空白**。
   *
   * 这在片数不足（VAD 漏检）时确实会发生，而且是**纯时长分配的能力边界**：
   * 分配器只知道标出来的语音片，漏检区域在它眼里就是静音，
   * 它无法知道那里其实有声音。要真正解决必须靠 ASR 文本比对
   * （`text-match.ts`，尚未接入导入链路）。
   *
   * 但**至少要让用户看得见**：否则表现为「某几行导入了却没声音」，
   * 而界面上一切正常。所以这里给这些行附一条明确的原因，并进 `needsReview`。
   */
  const silentLines: string[] = []
  for (const r of ranges) {
    if (overlapWithSpeech(slices, r.startMs, r.endMs) <= 0) {
      silentLines.push(r.lineId)
      r.reasons.push('这一行的区间全部落在静音上（VAD 可能漏检了这段语音）')
    }
  }
  if (silentLines.length > 0) {
    warnings.push(
      `有 ${silentLines.length} 行的区间完全落在静音上 —— VAD 很可能漏检了这几句的语音，` +
        `导入后请重点复核这几行`,
    )
  }

  const threshold = opts.lowConfidenceThreshold ?? 0.5
  const needsReview = ranges.filter((r) => r.confidence < threshold).map((r) => r.lineId)
  // 落在静音上的行一律进复核清单（即使它恰好是「切在片边界上」的高置信度）
  for (const id of silentLines) if (!needsReview.includes(id)) needsReview.push(id)

  const avgConfidence =
    ranges.length === 0 ? 0 : ranges.reduce((sum, r) => sum + r.confidence, 0) / ranges.length

  return {
    ranges,
    needsReview,
    warnings,
    stats: {
      sliceCount: slices.length,
      lineCount: lines.length,
      oneToOne,
      coveredMs: ranges.reduce((sum, r) => sum + Math.max(0, r.endMs - r.startMs), 0),
      avgConfidence,
    },
  }
}

/**
 * 在一段窗口里找**最像换句处**的那一帧（能量低谷），返回它的中心时刻（毫秒）。
 *
 * 判据（三条一起看，缺一条就可能切在字中间）：
 *   1. 必须在搜索窗内（`targetMs ± searchMs`，并夹在上界内）；
 *   2. 必须是**低谷**：比窗口内的中位能量低至少 `DIP_MIN_DROP_DB`；
 *   3. 在大致相当的低谷里选**离目标位置最近**的 —— 距离按「每秒罚 6 dB」折算，
 *      所以半秒外深 6 dB 的停顿会赢过紧挨着但只浅 2 dB 的凹陷。
 *
 * 找不到合格低谷时返回 `null`，由调用方退回「按字符比例切」。
 */
export function findEnergyDip(
  energy: EnergyEnvelope,
  input: { fromMs: number; toMs: number; targetMs: number; searchMs: number },
): number | null {
  const { frameMs, values } = energy
  if (!(frameMs > 0) || values.length === 0) return null
  const at = (v: number): number => (Number.isFinite(v) ? v : -120)
  const lo = Math.max(input.fromMs, input.targetMs - input.searchMs)
  const hi = Math.min(input.toMs, input.targetMs + input.searchMs)
  const fromFrame = Math.max(0, Math.floor(lo / frameMs))
  const toFrame = Math.min(values.length - 1, Math.ceil(hi / frameMs))
  if (toFrame - fromFrame < 2) return null

  // 窗口内的中位能量：用它判断「这算不算低谷」，避免把整段都低的数据当成停顿
  const window: number[] = []
  for (let i = fromFrame; i <= toFrame; i++) window.push(at(values[i]!))
  const sorted = [...window].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!

  let bestFrame = -1
  let bestScore = Number.POSITIVE_INFINITY
  for (let i = fromFrame; i <= toFrame; i++) {
    const db = at(values[i]!)
    if (median - db < DIP_MIN_DROP_DB) continue
    const t = (i + 0.5) * frameMs
    // 距离罚：每秒 6 dB（0.5 s 罚 3 dB）
    const score = db + (Math.abs(t - input.targetMs) / 1000) * 6
    if (score < bestScore) {
      bestScore = score
      bestFrame = i
    }
  }
  return bestFrame < 0 ? null : Math.round((bestFrame + 0.5) * frameMs)
}

/** 低谷判据：比窗口内中位能量低这么多 dB 才算「停顿」 */
const DIP_MIN_DROP_DB = 3

/**
 * 允许向右（延后切点）搜索的上限（毫秒）。
 *
 * 向右搜索会吃掉下一行的音频、并把游标整体推后 —— 真机实测「两边都放开」时
 * 后面几行会被逼到只剩 1 ms。所以只留一个「半句话以内」的小修正量。
 */
const DIP_FORWARD_MS = 400
/** 找一个时刻落在第几片（落在间隙里时返回**前一片**的下标） */
function sliceIndexAt(slices: readonly SpeechSlice[], ms: number): number {
  for (let i = slices.length - 1; i >= 0; i--) {
    if (slices[i]!.startMs <= ms) return i
  }
  return 0
}

/**
 * 一段区间与所有语音片的重叠时长总和。
 *
 * 用来回答「这一行到底有没有拿到**声音**」—— 比「区间长度 > 0」强得多：
 * 一行完全落在静音里时区间长度照样是正的，但它听起来是一段空白。
 */
function overlapWithSpeech(slices: readonly SpeechSlice[], startMs: number, endMs: number): number {
  let sum = 0
  for (const s of slices) {
    sum += Math.max(0, Math.min(endMs, s.endMs) - Math.max(startMs, s.startMs))
  }
  return sum
}

/**
 * 把「按语音时长算出的边界」**吸附**到语音片边界上。
 *
 * ### 为什么必须吸附
 *   按字符比例算出来的边界是「数学上的中点」，多半落在一句话**中间**。
 *   落在一句话中间切成两行的后果是：前一行结尾被切掉半个字、
 *   后一行开头多出半个字 —— 听起来像吞字。
 *
 *   所以本函数在「期望边界附近」找一个**片边界**（片尾或片首）来当切点，
 *   并据此给出置信度：
 *     · 切点正好是某个片的尾/首 → 高置信度（切得干净）
 *     · 附近没有片边界（例如一片很长、跨了好几行）→ 只能硬切 → 低置信度
 *
 * ### 判据是「语音距离」而不是「毫秒距离」（本轮修正）
 *   期望位置与候选边界都换算成**累计语音时长**再比距离。
 *   用毫秒距离会有一个系统性偏差：候选边界里既有「片尾」（它后面跟着一段静音）
 *   也有「片首」（它前面跟着一段静音），两者的毫秒坐标天然差一个间隙，
 *   于是同样「正确」的片尾会因为那 400 ms 的静音而输给一个更近但语义更差的片首。
 *   换成语音坐标后，静音完全不参与距离计算 —— 这正是它该有的地位。
 *
 * @param cumSpeechEnd `cumSpeechEnd[j]` = 第 j 片结束时已消耗的累计语音时长
 * @param want         本行的期望：目标累计语音 / 期望语音时长 / 时间轴上的硬切位置
 */
function snapToSpeechBoundary(
  slices: readonly SpeechSlice[],
  cumSpeechEnd: readonly number[],
  startMs: number,
  want: { targetSpeech: number; expectedSpeech: number; rawEnd: number },
  ctx: {
    isLast: boolean
    gapOwner: 'previous' | 'split'
    timelineEnd: number
    maxSnapMs: number
    energy: EnergyEnvelope | null
    dipSearchMs: number
  },
): { startMs: number; endMs: number; reason: string; confidence: number } {
  if (ctx.isLast) {
    // 最后一行收到音频末尾；但起点若已在末尾之后（极端数据），也要保证不反向
    const endMs = Math.max(want.rawEnd, startMs + 1)
    return { startMs, endMs, reason: '最后一行：收到音频末尾', confidence: 1 }
  }

  /**
   * 可选的吸附点：各片的「终点」与「起点」。
   *
   * ⚠️ **必须严格大于 `startMs`**（留 1ms 余量）。
   *   踩过的坑：曾经允许 `at > startMs` 的候选里包含「刚好等于起点」的片首，
   *   于是吸附后 `endMs === startMs`，经兜底又被设成一个**更早**的值，
   *   产生 `102042 → 99800` 这种**反向区间**（区间长度为负）。
   *   真机上那会表现为「切出一段不存在的音频」。
   *   所以这里直接要求候选在起点**之后**，从源头保证区间严格前进。
   */
  const MIN_STEP_MS = 1
  const maxAt = Math.max(startMs + MIN_STEP_MS, ctx.timelineEnd)
  const speechBeforeSlice = (j: number): number => (j <= 0 ? 0 : (cumSpeechEnd[j - 1] ?? 0))
  const candidates: Array<{ at: number; speech: number; kind: 'end' | 'start'; sliceIndex: number }> = []
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]!
    const speechAtEnd = cumSpeechEnd[i] ?? 0
    const speechAtStart = speechBeforeSlice(i)
    // 候选必须**严格在起点之后**、且**不越过上界**（上界已给后面的行留了空间）
    if (s.endMs > startMs + MIN_STEP_MS && s.endMs <= maxAt) {
      candidates.push({ at: s.endMs, speech: speechAtEnd, kind: 'end', sliceIndex: i })
    }
    if (s.startMs > startMs + MIN_STEP_MS && s.startMs <= maxAt) {
      candidates.push({ at: s.startMs, speech: speechAtStart, kind: 'start', sliceIndex: i })
    }
  }
  /**
   * 能量低谷兜底（两个「没有可用片边界」的分支共用）。
   *
   * ⚠️ 必须在这两个分支里都能用：真机上大量文件是「整段只有一片」
   * （连续朗读、没有超过阈值的静音），那种情况下候选片边界可能一个都没有 ——
   * 如果不在这里找低谷，等于把最需要精修的数据排除在精修之外。
   */
  const attemptDip = (): { endMs: number; reason: string; confidence: number } | null => {
    if (!ctx.energy) return null
    const dipSearch = Math.min(ctx.dipSearchMs, Math.max(200, want.expectedSpeech * 0.6))
    /**
     * 搜索范围**不对称**：向左可以找 `dipSearch`，向右只找 `DIP_FORWARD_MS`。
     *
     * 为什么不对称：向右（把本行结尾往后推）= 吃掉下一行的音频，而且会把游标整体推后，
     * 真机实测「两边都放开」时后面几行被压成 1 ms（比例 0.00）——那比偏一点更糟。
     * 向左只影响本行，最坏是把本行末尾留给下一行，后面的行不会被挤压。
     */
    const dipForward = Math.min(DIP_FORWARD_MS, dipSearch)
    const dip = findEnergyDip(ctx.energy, {
      fromMs: startMs + MIN_STEP_MS,
      toMs: Math.max(startMs + MIN_STEP_MS, Math.min(maxAt, want.rawEnd + dipForward)),
      targetMs: want.rawEnd,
      searchMs: dipSearch,
    })
    if (dip === null) return null
    const deviation = Math.abs(dip - want.rawEnd)
    const farFromEstimate = deviation > Math.max(400, want.expectedSpeech * 0.6)
    return {
      endMs: Math.max(dip, startMs + MIN_STEP_MS),
      reason: farFromEstimate
        ? `切在句间能量低谷，但离按字数的估计差 ${Math.round(deviation)}ms —— 建议复核`
        : '切在句间能量低谷（VAD 没标出的短停顿）',
      confidence: farFromEstimate ? 0.45 : 0.6,
    }
  }

  if (candidates.length === 0) {
    // 上界之内没有片边界 → 先看能量低谷，再退回按语音比例算出的位置硬切
    const dip = attemptDip()
    if (dip) return { startMs, ...dip }
    const safeEnd = Math.min(Math.max(want.rawEnd, startMs + MIN_STEP_MS), maxAt)
    return {
      startMs,
      endMs: Math.max(safeEnd, startMs + MIN_STEP_MS),
      reason: '上界之内没有语音片边界，按文本比例切分',
      confidence: 0.3,
    }
  }

  /**
   * 在候选里选切点。
   *
   * ### 为什么要在「距离相近」时**优先片尾**
   *   片尾与下一片的片首之间就是**静音间隙**。选片尾 = 间隙归**后一行**
   *   （下一行从间隙之后开始）；选片首 = 间隙归**前一行**。
   *
   *   默认语义是 `gapOwner='previous'`（念完一句后的停顿属于这一句），
   *   所以距离相近时应当**优先片尾** —— 否则间隙总是被后一行吃掉，
   *   与配置的语义相反。
   *
   *   （第一版只按「距离最近」选，于是 `[0,1000] [1300,2300]` 这种数据里
   *     1000 与 1300 距离相同时会选 1300，让第 1 行少了 300ms 的停顿。）
   */
  const NEAR_TIE_MS = 150
  const candidatesSorted = [...candidates].sort((a, b) => {
    const da = Math.abs(a.speech - want.targetSpeech)
    const db = Math.abs(b.speech - want.targetSpeech)
    if (Math.abs(da - db) > NEAR_TIE_MS) return da - db
    // 距离相近：片尾优先（间隙归前一行）
    if (a.kind !== b.kind) return a.kind === 'end' ? -1 : 1
    return da - db
  })
  const best = candidatesSorted[0]!
  const bestDist = Math.abs(best.speech - want.targetSpeech)

  /**
   * 吸附距离的容忍度：不超过「本行期望语音时长的一半」。
   * 超过就说明附近没有合适的边界（例如一片横跨多行），
   * 这时**不吸附**（硬切）并给低置信度 —— 而不是硬拽一个很远的边界，
   * 那会把某一行的音频拉得很长或很短。
   *
   * 下限 150ms 是语音坐标下的量级（不是时间轴的 200ms）：
   * 它对应「半句话」的下限，避免极短行把容差压成 0 而永远无法吸附。
   */
  const tolerance = Math.min(
    Math.max(150, want.expectedSpeech * 0.5),
    ctx.maxSnapMs,
  )
  if (bestDist > tolerance) {
    /**
     * VAD 片边界都太远 —— 但**句间那点又短又浅的停顿是真实存在的**，
     * 只是没到 VAD 的静音判据。改用逐帧能量包络找一个低谷当切点。
     *
     * 这是「慢一点没关系，要能对上」的落点：多算一遍包络（O(采样数)），
     * 换来切点落在**真实的换句处**，而不是某个字中间。
     */
    const dip = attemptDip()
    if (dip) return { startMs, ...dip }
    return {
      startMs,
      endMs: want.rawEnd,
      reason: `附近没有语音片边界（最近的差 ${Math.round(bestDist)}ms 语音），按文本比例切分`,
      confidence: 0.35,
    }
  }

  let endMs = best.at
  let reason: string
  if (best.kind === 'end') {
    reason = `切在第 ${best.sliceIndex + 1} 个语音片末尾`
  } else {
    reason = `切在第 ${best.sliceIndex + 1} 个语音片开头`
    // 片首切点时，中间的静音间隙按 gapOwner 决定归前一行还是对半分
    if (ctx.gapOwner === 'split') {
      const prevEnd = slices[Math.max(0, best.sliceIndex - 1)]?.endMs ?? startMs
      endMs = Math.round((prevEnd + best.at) / 2)
      reason += '（静音间隙对半分）'
    }
  }

  // 防止出现零长度或反向区间（**严格前进**，见上面 MIN_STEP_MS 的说明）
  if (endMs <= startMs) endMs = Math.max(want.rawEnd, startMs + MIN_STEP_MS)

  const closeness = 1 - bestDist / Math.max(1, tolerance)
  return { startMs, endMs, reason, confidence: 0.7 + 0.3 * closeness }
}
