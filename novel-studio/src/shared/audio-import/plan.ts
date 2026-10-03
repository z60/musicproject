/**
 * Novel Studio · 按说话人导入音频：导入规划（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/12-功能域-录音.md、docs/91 §5.2.1
 *
 * ## 这一层做什么
 *
 * 把「一批音频文件 + 一份画本」算成一份**可预览、可人工修正的导入计划**：
 *
 * ```
 * 音频文件名          解析          匹配画本           计划
 * ─────────────  →  ─────────  →  ─────────────  →  ──────────────
 * 2221-2240-石志坚-月光.mp3   区间 2221-2240   角色「石志坚」    待导入 90 行
 *                              CV「月光」→「月光_深白色」
 * 2221-2250-多角色-春哥拿大顶.mp3  CV 命中（8 个角色） 多角色          待导入 40 行
 * ```
 *
 * ## 为什么必须有「规划」这一步（而不是选完文件直接导入）
 *
 * 真机样本暴露了三种**必须人工介入**的情况：
 *
 *   1. **CV 名对不上**：例如把画本里的 `春哥拿大顶` 写成 `春哥那个哥`
 *      （真机确实这样错过一次）。自动猜会把音频绑到错误的角色上，
 *      而这个错误会静默流到对轨与成品里。
 *   2. **区间的章节在画本里不存在**：文件名写 `2127-2300`，但画本只覆盖
 *      `2201-2300`。这时要明确告诉用户「有 74 章不在画本里」，
 *      而不是默默按交集导入（用户会以为全导进去了）。
 *   3. **同一行被多个文件覆盖**：两个文件的区间重叠且都命中同一角色。
 *      直接导入会产生两条 take 挂在同一行，用户不知道哪条是成品。
 *
 * 这三件事都必须在**导入之前**让用户看到并决定，所以计划必须是数据、
 * 能序列化给渲染进程、能被逐个修正后重新提交。
 *
 * 本目录禁止引入任何第三方依赖。
 */

import type { CanvasParsedLine, ParsedCanvas } from '../canvas/docx-canvas.ts'
import type { ParsedAudioFileName, SpeakerTokenKind } from './filename.ts'
import type { CvIndex, ResolvedCv, SpeakerResolution, SpeakerTarget } from './resolve.ts'
import { buildCvIndex, decideTarget, matchSpeaker } from './resolve.ts'
import { selectLinesForTarget } from './select.ts'

/** 单个文件的解析输入（主进程补齐画本上下文后交给本层） */
export interface AudioFileInput {
  /** 绝对路径（主进程给；纯逻辑层不读盘） */
  filePath: string
  /** 文件名（含扩展名） */
  fileName: string
  /**
   * 文件名解析结果（由调用方先行调用 `parseAudioFileName`）。
   *
   * 为什么不在这里现解析：本层要能接受**用户已在 UI 里修正过**的条目
   * （例如把解析失败的文件手工指定成某个角色），所以解析结果是输入而不是内部步骤。
   */
  parsed?: ParsedAudioFileName | null
  /** 解析失败的原因（`parsed` 为 null 时提供） */
  parseError?: { reason: string; detail: string } | null
  /** 文件字节数（用于预览展示与体积合计） */
  sizeBytes?: number
  /** 时长毫秒（主进程用 ffprobe 探测；拿不到时为 null） */
  durationMs?: number | null
  /**
   * 人工修正：直接指定为某个角色（覆盖自动判定）。
   * UI 上用户把「未解析」的文件指派给一个角色时填这里。
   */
  overrideCharacter?: string | null
  /** 人工修正：直接指定为某个 CV（覆盖自动判定） */
  overrideCv?: string | null
  /** 人工修正：强制按旁白处理 */
  overrideNarration?: boolean
  /**
   * 人工修正：章节区间（**文件名解析不出区间时必填**）。
   *
   * 真机需求：「以后解析不出的，可以在处理里自己选择哪个 CV 或者角色」。
   * 光有角色/CV 还不够 —— 没有区间就不知道这个文件覆盖哪些章，
   * 也就选不出行。所以 UI 必须让用户把区间一起填上（默认填画本的章节范围）。
   */
  fromChapter?: number | null
  toChapter?: number | null
}

/** 计划里单个文件的状态 */
export type FilePlanStatus =
  | 'ready' // 区间与角色都解析成功，且画本里有对应的行
  | 'needs-review' // 能匹配上，但置信度不足（缩写/包含/收敛），建议人工确认
  | 'unresolved-speaker' // 说话人没解析出来，必须人工指定
  | 'no-lines' // 说话人解析成功，但区间内没有它的行
  | 'invalid-name' // 文件名不符合命名约定
  | 'duplicate-lines' // 与其它文件命中了同一批行

/** 计划里单个文件的详情 */
export interface FileImportPlan {
  filePath: string
  fileName: string
  sizeBytes: number
  durationMs: number | null

  /** 文件名解析结果；`null` 表示文件名不合法 */
  parsed: ParsedAudioFileName | null
  /** 文件名解析失败原因（`parsed === null` 时有值） */
  parseError: { reason: string; detail: string } | null

  /** CV 解析结果 */
  cvResolution: SpeakerResolution | null
  /** 绑定目标判定 */
  target: SpeakerTarget | null

  /** 该文件覆盖的章节区间（解析成功时有值） */
  range: { from: number; to: number } | null
  /**
   * 区间里**画本实际存在**的章节号。
   * `range` 有值但这里是空数组 ⇒ 这个文件整段都不在画本范围内。
   */
  chaptersInCanvas: number[]
  /** 区间里的章节号，但画本里没有（用于提示「有 N 章不在画本里」） */
  chaptersMissingInCanvas: number[]

  /** 命中画本行数 */
  lineCount: number
  /** 命中的行按章节分布：`{ 章节号: 行数 }` */
  linesByChapter: Record<number, number>
  /**
   * 命中行的**去重键**（仅本层内部用于查「同一行被多个文件覆盖」）。
   *
   * ⚠️ **不要把它当「要导入的行 id」用，也不要放进 IPC 契约**（契约里确实没有它）。
   *
   *   原因：这个键的**编号空间跟随输入**。
   *   预览传的是**文档行**（键 = 文档行号 `sourceLine`），
   *   导入传的是**数据库行**（键 = `seq`）。两个空间的数字含义不同，
   *   拿其中一个去查库会查到**另一批行** —— 而且数量可能恰好一样，
   *   于是「看起来对、实际错位」，这是最难发现的一类 bug。
   *
   *   要展示就展示 `samples`；要落库就交给服务层按同一个说话人目标重算。
   */
  lineKeys: string[]
  /** 命中行的样例文本（前几条，供 UI 预览） */
  samples: Array<{ chapterNo: number; character: string; text: string }>

  /**
   * 与**别的文件**重叠的行数（> 0 表示这个文件与另一个文件争同一批行）。
   *
   * 单独用一个字段而不是靠 `status === 'duplicate-lines'`：
   * 状态只能表达「这个文件最主要的问题」，一个文件可能同时是
   * `needs-review`（CV 需确认）**且**参与重叠。靠状态推断会漏报 ——
   * 真机上表现为「两条音频抢同一行，界面却没说」。
   */
  overlappingLineCount: number

  status: FilePlanStatus
  /** 需要用户注意的说明（UI 直接展示） */
  notes: string[]
}

export interface ImportPlanSummary {
  totalFiles: number
  readyFiles: number
  needsReviewFiles: number
  unresolvedFiles: number
  noLinesFiles: number
  invalidFiles: number
  /**
   * **参与重叠**的文件数（至少有一行与别的文件争用）。
   *
   * 注意它不等于「状态为 `duplicate-lines` 的文件数」：状态提升只在
   * 文件本来没有别的问题时才发生，否则会掩盖更重要的 `needs-review`。
   */
  overlappingFiles: number
  /** 被多个文件命中的行数（去重） */
  duplicatedLineCount: number
  /** 计划导入的总行数（只统计 ready + needs-review） */
  totalLines: number
  /** 总时长毫秒（能测到时） */
  totalDurationMs: number
  /** 总字节数 */
  totalBytes: number
  /** 画本里的章节范围（用于提示区间越界） */
  canvasChapterRange: { from: number; to: number } | null
  /** 画本里全部 CV（供 UI 下拉修正） */
  availableCvs: string[]
  /** 画本里全部角色（供 UI 下拉修正） */
  availableCharacters: string[]
}

export interface ImportPlan {
  files: FileImportPlan[]
  summary: ImportPlanSummary
  warnings: string[]
}

export interface PlanOptions {
  /**
   * 把画本行映射成稳定 key（通常是数据库 line id）。
   * 不提供时用 `sourceLine`。
   */
  lineKeyOf?: (line: CanvasParsedLine) => string
  /**
   * 章节区间超过画本范围多少章就告警。
   * 真实样本 `2127-2300` vs 画本 `2201-2300` → 差 74 章，必须提示。
   */
  chapterOverflowWarnThreshold?: number
  /** 画本章节号的安全上限（防止文件名写 `1-999999` 把整个文档算进来） */
  maxChapters?: number
}

/** 从画本推断章节范围 */
export function canvasChapterRange(canvas: ParsedCanvas): { from: number; to: number } | null {
  if (canvas.chapters.length === 0) return null
  return { from: canvas.chapters[0]!, to: canvas.chapters[canvas.chapters.length - 1]! }
}

const EMPTY_INDEX: CvIndex = { byNormalized: new Map(), all: [] }

/**
 * 读人工指定的章节区间；不完整/不合法时返回 null（当作没给）。
 *
 * 为什么这么严：区间决定「选哪些行」。半个区间（只填起始章）会静默选错范围，
 * 比直接拒绝更糟 —— 用户会以为「指定成功了」，结果导入的行根本不对。
 */
function readManualRange(input: AudioFileInput): { from: number; to: number } | null {
  const from = input.fromChapter
  const to = input.toChapter
  if (typeof from !== 'number' || typeof to !== 'number') return null
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 1 || to < 1 || to < from) return null
  return { from, to }
}

/**
 * 生成导入计划。
 *
 * @param inputs 选中的音频文件（已由主进程补上路径与大小）
 * @param canvas 画本解析结果
 * @returns 可序列化的计划（渲染进程直接渲染）
 */
export function buildImportPlan(
  inputs: readonly AudioFileInput[],
  canvas: ParsedCanvas,
  opts: PlanOptions = {},
): ImportPlan {
  const lineKeyOf = opts.lineKeyOf ?? ((l: CanvasParsedLine) => String(l.sourceLine))
  const maxChapters = opts.maxChapters ?? 2000
  const overflowThreshold = opts.chapterOverflowWarnThreshold ?? 0

  // 画本侧索引：CV 用角色表 + 正文出现的 CV 一起建
  const cvsInCanvas = new Set<string>()
  for (const l of canvas.lines) for (const o of l.owners) cvsInCanvas.add(o.cv)
  const index = canvas.roster.length > 0 || cvsInCanvas.size > 0
    ? buildCvIndex(canvas.roster, [...cvsInCanvas])
    : EMPTY_INDEX

  const canvasRange = canvasChapterRange(canvas)
  const canvasChapterSet = new Set(canvas.chapters)

  const warnings: string[] = []
  const files: FileImportPlan[] = []
  /** lineKey → 已经被哪些文件命中（查「同一行被多个文件覆盖」） */
  const keyOwners = new Map<string, string[]>()

  for (const input of inputs) {
    const notes: string[] = []
    const base: FileImportPlan = {
      filePath: input.filePath,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes ?? 0,
      durationMs: input.durationMs ?? null,
      parsed: null,
      parseError: null,
      cvResolution: null,
      target: null,
      range: null,
      chaptersInCanvas: [],
      chaptersMissingInCanvas: [],
      lineCount: 0,
      linesByChapter: {},
      lineKeys: [],
      samples: [],
      overlappingLineCount: 0,
      status: 'invalid-name',
      notes,
    }

    // 调用方负责把文件名解析好；这里只接受结果，保持本层纯粹
    const parsed = input.parsed
    /**
     * 人工给的章节区间（文件名解析不出来时的唯一办法）。
     *
     * 校验：两个都给了、且是 ≥1 的整数、且 to ≥ from —— 否则视为没给
     * （宁可继续报「命名不合规」，也不要拿半个区间去选行）。
     */
    const manualRange = readManualRange(input)
    if (!parsed && !manualRange) {
      base.parseError = input.parseError ?? { reason: 'unknown', detail: '未提供文件名解析结果' }
      notes.push(`文件名不符合命名约定：${base.parseError.detail}`)
      files.push(base)
      continue
    }

    base.parsed = parsed ?? null
    if (manualRange) {
      base.range = manualRange
      if (!parsed) {
        base.parseError = input.parseError ?? { reason: 'unknown', detail: '未提供文件名解析结果' }
        notes.push('文件名不符合命名约定，已按人工指定的章节区间与说话人处理')
      }
    } else if (parsed) {
      base.range = { from: parsed.range.from, to: parsed.range.to }
    }

    // ── 说话人解析（含人工修正优先级）─────────────────────────────────────────
    const cvResolution = matchSpeaker(input.overrideCv ?? parsed?.cvToken ?? '', index)
    base.cvResolution = cvResolution

    let target: SpeakerTarget
    if (input.overrideNarration) {
      // 人工强制旁白：最高优先级
      target = {
        kind: 'narration',
        character: null,
        cvName: cvResolution.matched?.name ?? null,
        cvCharacters: cvResolution.matched?.characters ?? [],
        explanation: '人工指定：按旁白匹配',
      }
    } else if (input.overrideCharacter) {
      // 人工指定角色：次高优先级。此时不信任何自动判定。
      const chars = cvResolution.matched?.characters ?? []
      target = {
        kind: 'character',
        character: input.overrideCharacter,
        cvName: cvResolution.matched?.name ?? null,
        cvCharacters: chars,
        explanation: `人工指定：按角色「${input.overrideCharacter}」匹配`,
      }
    } else if (input.overrideCv) {
      /**
       * 人工指定 CV：**以 CV 为准**，不再看文件名里的角色 token。
       *
       * 曾经的缺陷：这里落到 `decideTarget(parsed.speakerKind, parsed.characterToken, …)`，
       * 而它优先信文件名里的角色 —— 于是「按 CV」选了个别的 CV 也不生效：
       * 例如给 `2221-2240-石志坚-月光.mp3` 选 CV「德钦」（德钦配的是石玉凤），
       * 结果目标仍是「石志坚」，导入的还是石志坚的行。真机反馈就是「选择 CV 出现错误」。
       *
       * 语义与 `overrideCharacter` 对称：人工修正 > 自动判定。
       */
      const chars = cvResolution.matched?.characters ?? []
      const cvName = cvResolution.matched?.name ?? null
      if (chars.length === 1) {
        target = {
          kind: 'cv-single-role',
          character: chars[0]!,
          cvName,
          cvCharacters: chars,
          explanation: `人工指定：按 CV「${cvName ?? input.overrideCv}」匹配（该 CV 配了 1 个角色）`,
        }
      } else if (chars.length > 1) {
        target = {
          kind: 'multiRole',
          character: null,
          cvName,
          cvCharacters: chars,
          explanation: `人工指定：按 CV「${cvName ?? input.overrideCv}」的全部行匹配（${chars.length} 个角色）`,
        }
      } else {
        target = {
          kind: 'unknown',
          character: null,
          cvName,
          cvCharacters: [],
          explanation: `人工指定的 CV「${input.overrideCv}」在画本里找不到对应记录`,
        }
      }
    } else {
      target = decideTarget(
        (parsed?.speakerKind ?? 'unknown') as SpeakerTokenKind,
        parsed?.characterToken ?? null,
        canvas.roster,
        cvResolution,
      )
    }
    base.target = target

    const manuallyFixed = Boolean(input.overrideCharacter || input.overrideNarration || input.overrideCv)
    if (manuallyFixed) notes.push('已人工指定说话人')
    if (cvResolution.reason && !manuallyFixed) notes.push(cvResolution.reason)

    // ⚠️ `target.kind === 'unknown'` **不再直接判为不可导入**。
    //
    // 场景：文件名里的 CV 与画本对不上（例如把 `春哥拿大顶` 写成 `春哥那个哥`，
    // 真机确实这样错过一次）。若这里直接跳过，用户**既看不到这个文件、
    // 也没有地方修正它** —— 一个真实存在的音频就这么从界面上消失了，
    // 用户只会觉得「导入漏了文件」。
    //
    // 所以改为：继续走区间/选行流程，让它进入 `needs-review`，
    // 由 UI 提供「指定角色 / 指定 CV」的修正入口。
    //
    // 文件名本身不合法时也一样有入口：用户在界面上补**章节区间** + 指定角色/CV，
    // 本层就按人工信息规划（见上面的 `manualRange`）。真正做到「解析不出的文件
    // 也能自己选 CV 或角色」—— 只有「既没解析出区间、又没人工补区间」才跳过。
    const unresolvedSpeaker = target.kind === 'unknown'
    if (unresolvedSpeaker) {
      notes.push('说话人无法自动判定 —— 请在下方指定角色或 CV 后再导入')
    }

    // ── 区间与画本的交集 ──────────────────────────────────────────────────────
    // 区间：优先人工给的（`base.range` 上面已定），解析成功时它就是文件名里的区间
    const effectiveRange = base.range!
    const span = Math.min(effectiveRange.to - effectiveRange.from + 1, maxChapters)
    const hardTo = effectiveRange.from + span - 1
    const inCanvas: number[] = []
    const missing: number[] = []
    for (let c = effectiveRange.from; c <= hardTo; c++) {
      if (canvasChapterSet.has(c)) inCanvas.push(c)
      else missing.push(c)
    }
    base.chaptersInCanvas = inCanvas
    base.chaptersMissingInCanvas = missing

    if (missing.length > overflowThreshold && canvasRange) {
      notes.push(
        `文件区间 ${effectiveRange.from}-${effectiveRange.to} 里有 ${missing.length} 章不在画本范围内` +
          `（画本只有 ${canvasRange.from}-${canvasRange.to}）`,
      )
    }

    if (inCanvas.length === 0) {
      base.status = 'no-lines'
      notes.push('该区间在画本里没有任何章节，无法匹配到行')
      files.push(base)
      continue
    }
    // ── 选行 ──────────────────────────────────────────────────────────────────
    const inCanvasSet = new Set(inCanvas)
    const lines = selectLinesForTarget(canvas.lines, target, inCanvasSet)

    base.lineCount = lines.length
    base.lineKeys = lines.map((l) => lineKeyOf(l))
    const byChapter: Record<number, number> = {}
    for (const l of lines) byChapter[l.chapterNo] = (byChapter[l.chapterNo] ?? 0) + 1
    base.linesByChapter = byChapter
    base.samples = lines.slice(0, 5).map((l) => ({
      chapterNo: l.chapterNo,
      character: l.owners[0]?.character ?? '旁白',
      text: l.rawText.slice(0, 80),
    }))

    for (const k of base.lineKeys) {
      const owners = keyOwners.get(k)
      if (owners) owners.push(input.fileName)
      else keyOwners.set(k, [input.fileName])
    }

    if (lines.length === 0) {
      // 说话人没解析出来 + 一行都没选中 → 归类为「需人工确认」而不是「无行」，
      // 否则用户根本看不到这个文件（见上面 unresolvedSpeaker 的说明）。
      base.status = unresolvedSpeaker ? 'needs-review' : 'no-lines'
      if (!unresolvedSpeaker) notes.push('该说话人在这个区间内没有台词行')
      files.push(base)
      continue
    }

    // ── 状态：置信度不足 → 需人工确认 ─────────────────────────────────────────
    //
    // ⚠️ 人工指定**不等于**一定可行：用户可能填了一个该区间内没有台词的角色
    //    （例如把一个多角色文件指定成某个在区间内没有台词的角色）。
    //    这时若直接报 `ready`，用户会以为
    //    「已就绪、可以导入」，点下去却什么都不会发生 —— 静默失败。
    //    所以这里要区分「指定有效」与「指定了但没有行」。
    const manualTargetMatchedNothing = manuallyFixed && base.lineCount === 0
    if (manualTargetMatchedNothing) {
      base.status = 'needs-review'
      notes.push(
        target.kind === 'narration'
          ? '人工指定为旁白，但该区间内没有旁白行'
          : `人工指定的角色「${target.character ?? ''}」在该区间内没有台词行，请确认角色名或章节区间`,
      )
    } else if (unresolvedSpeaker) {
      // 已经选了行，但说话人没对上：必须人工确认
      base.status = 'needs-review'
    } else if (manuallyFixed) {
      base.status = 'ready'
    } else if (cvResolution.method === 'prefix' || cvResolution.method === 'contains') {
      base.status = 'needs-review'
      notes.push(
        `CV 按「${cvResolution.method === 'prefix' ? '前缀' : '包含'}」关系匹配（置信度 ${cvResolution.confidence}），请确认`,
      )
    } else if (cvResolution.method === 'unresolved') {
      // 角色 token 命中了角色表，所以还能匹配；但 CV 名字对不上，仍要提醒
      base.status = 'needs-review'
      notes.push('CV 未匹配上，但角色已命中，仍可导入（请确认）')
    } else {
      base.status = 'ready'
    }

    files.push(base)
  }

  // ── 重复覆盖检测 ────────────────────────────────────────────────────────────
  const duplicatedKeys = new Set<string>()
  for (const [k, owners] of keyOwners) {
    if (owners.length > 1) duplicatedKeys.add(k)
  }
  if (duplicatedKeys.size > 0) {
    for (const f of files) {
      const dupCount = f.lineKeys.filter((k) => duplicatedKeys.has(k)).length
      if (dupCount === 0) continue
      f.overlappingLineCount = dupCount
      f.notes.push(`有 ${dupCount} 行同时被多个文件覆盖，导入后会变成多 take（可稍后选成品）`)
      // 只在文件**本来没有别的问题**时才提升状态：
      // 状态要表达最主要的问题，把 needs-review（CV 需确认）覆盖成
      // duplicate-lines 会让用户漏掉更该处理的确认项。
      if (f.status === 'ready') f.status = 'duplicate-lines'
    }
    warnings.push(
      `${duplicatedKeys.size} 行被多个音频文件覆盖 —— 导入后会形成同一行的多条 take，请在导入后确认成品`,
    )
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────────
  const summary: ImportPlanSummary = {
    totalFiles: files.length,
    readyFiles: files.filter((f) => f.status === 'ready').length,
    needsReviewFiles: files.filter((f) => f.status === 'needs-review').length,
    unresolvedFiles: files.filter((f) => f.status === 'unresolved-speaker').length,
    noLinesFiles: files.filter((f) => f.status === 'no-lines').length,
    invalidFiles: files.filter((f) => f.status === 'invalid-name').length,
    // 「参与重叠的文件数」直接数，不靠状态推断（见字段注释）：
    // 两份文件都可能是 needs-review 而同时互相重叠，靠状态会漏报成 0。
    overlappingFiles: files.filter((f) => f.overlappingLineCount > 0).length,
    duplicatedLineCount: duplicatedKeys.size,
    totalLines: files
      .filter((f) => f.status === 'ready' || f.status === 'needs-review' || f.status === 'duplicate-lines')
      .reduce((n, f) => n + f.lineCount, 0),
    totalDurationMs: files.reduce((n, f) => n + (f.durationMs ?? 0), 0),
    totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
    canvasChapterRange: canvasRange,
    availableCvs: index.all.map((c: ResolvedCv) => c.name),
    availableCharacters: [...new Set(canvas.roster.map((r) => r.character))],
  }

  if (summary.unresolvedFiles > 0) {
    warnings.push(`${summary.unresolvedFiles} 个文件的说话人无法自动判定，需要人工指定`)
  }
  if (summary.noLinesFiles > 0) {
    warnings.push(`${summary.noLinesFiles} 个文件在画本里找不到对应的行`)
  }
  if (summary.invalidFiles > 0) {
    warnings.push(`${summary.invalidFiles} 个文件的命名不符合约定，已跳过`)
  }

  return { files, summary, warnings }
}

