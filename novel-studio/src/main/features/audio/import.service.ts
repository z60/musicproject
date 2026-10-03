/**
 * Novel Studio · 录音模块「按说话人导入音频」服务
 * ============================================================================
 * 设计依据：
 *   · docs/12-功能域-录音.md（录音域）
 *   · docs/91 §5.2.49（真实样本勘察与纯逻辑层）
 *
 * ## 这个功能解决什么问题
 *
 * 配音员的交付方式是「**一个人一个文件、覆盖若干章**」，文件名形如：
 *
 * ```
 * 2221-2240-石志坚-月光.mp3      → 角色 石志坚 / CV 月光 / 第 2221~2240 章
 * 2221-2250-多角色-春哥拿大顶.mp3 → 该 CV 在这段里配的**多个角色**的全部台词
 * 2251-2255-旁白-语心草.mp3       → 这段的**旁白**（CV 只是录音者标注）
 * ```
 *
 * 所以导入要做的事是：**把「一个音频文件」对应到「这批画本行」并落库为 take**。
 *
 * ## 三层分工（与本仓库既有架构一致）
 *
 * ```
 *   src/shared/audio-import 目录  纯逻辑：解析文件名、解析画本、说话人匹配、选行、规划
 *   ← 本文件（服务层）→           编排：读盘、查库、调规划、写 take/segment
 *   src/main/ipc/handlers 目录    薄壳：只做载荷搬运
 * ```
 *
 * ⚠️ **选行逻辑绝对不能在这里再写一遍**：服务层与规划层必须调用
 * `src/shared/audio-import/select.ts` 的同一个函数，否则会出现
 * 「预览说 90 行、实际导入 40 行」这种两边都不报错、只是数量对不上的问题。
 *
 * ## 本文件**不**做「按 VAD 切句后逐句匹配到行」
 *
 * 真实样本是「一个文件覆盖 74 章」的连续朗读，若要精确到行必须先把音频切成句、
 * 再与画本行做对齐 —— 那是**强制对齐**（docs/13 §AI 强制对齐）的范畴，
 * 设计上后置。本阶段采用**整段 take**：每个匹配到的行产生一条 take，
 * 指向同一个源音频文件（不同 partIndex），由对轨阶段再做细切。
 * 这样「导入」这件事本身是**可验证、可回滚**的，且不引入对齐误差。
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import { VAD_IMPORT_OVERRIDES } from '../../../shared/constants.ts'
import type {
  AudioImportApplyResult,
  AudioImportCandidate,
  AudioImportCanvasScan,
  AudioImportFileOverride,
  AudioImportFileRequest,
  AudioImportPlan,
  Id,
  Take,
  VadOptions,
  VoiceSegment,
} from '../../../shared/types.ts'
import {
  buildImportPlan,
  clampSpan,
  isAudioExtension,
  parseAudioFileName,
  selectLinesForTarget,
  type ImportPlan,
  type PlanOptions,
} from '../../../shared/audio-import/index.ts'
import { parseCanvasText, normalizeName, type LineRef, type ParsedCanvas } from '../../../shared/canvas/index.ts'
import type { CanvasLineOwner, CanvasParsedLine, CanvasRosterEntry } from '../../../shared/canvas/docx-canvas.ts'
import { parseCvFromNote } from '../../../shared/canvas/character-display.ts'
import { alignLinesToAsr } from '../../../shared/audio/asr-align.ts'
import type { AsrRunner } from './asr-runner.ts'
import { containerLabel, planLineSplits, probeAudioContainer, type AudioContainer } from '../../../shared/audio/index.ts'
import type { Logger } from '../../infra/log/index.ts'
import type { FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import { buildDecodeToWavCommand, buildDurationProbeCommand } from '../../../shared/ffmpeg/commands.ts'
import type { AudioProjectScope } from './project-scope.ts'
import type { TakeRepo } from './repositories/take.repo.ts'
import type { VoiceSegmentRepo } from './repositories/voice-segment.repo.ts'

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

/** 服务层需要的最小仓储集合（都由 ports.ts 注入，避免直接 import 实现） */
export interface AudioImportRepos {
  /**
   * 取某本书的全部章节。
   *
   * ### ⚠️ `no` 是**章节号**，不是 `chapters.seq`
   *   这是本项目一个**极易搞错**的地方，务必看清：
   *
   *   | 字段 | 含义 | 真实样本那本书的取值 |
   *   |------|------|---------------------|
   *   | `chapters.seq` | **序号**（第几个章节）。`book.service.ts` 里是 `baseSeq + i`，`import.service.ts` 里是 `i + 1` | `1 … 100` |
   *   | 章节号 | 标题里的数字，如 `第2201章` → `2201` | `2201 … 2300` |
   *
   *   文件名里的区间是**章节号**（`2221-2240`），所以必须按章节号对齐。
   *   早期实现误用 `seq`，结果在真实样本上**一个章节都对不上** ——
   *   而那本书的 `seq` 恰好是 1~100、与 2201~2300 完全不重合，
   *   症状是「全部文件都报区间不在画本内」。
   *
   *   `ChapterDraft` 里根本没有章节号字段，它**只存在于 `title`**，
   *   所以调用方（ports.ts）必须从标题解析出来再传进来。
   */
  listChapters: (bookId: Id) => Promise<Array<{ id: Id; no: number; title: string }>>
  /** 取某章的全部画本行（已按 seq 排序） */
  listLines: (chapterId: Id) => Promise<
    Array<{
      id: Id
      seq: number
      speakerType: 'narration' | 'character'
      characterId: Id | null
      kind: 'dialogue' | 'narration' | 'inner' | 'sfx_note'
      text: string
    }>
  >
  /**
   * 取某本书的全部角色（含别名，用于角色 token 匹配）。
   * `note` 里可能带 `CV：xxx`（画本导入写入）—— 不选画本文件时它是 CV 的来源。
   */
  listCharacters: (bookId: Id) => Promise<Array<{ id: Id; name: string; aliases: string[]; note?: string | null }>>
  /** 取某本书的全部配音演员 */
  listVoiceActors: (projectId: Id) => Promise<Array<{ id: Id; name: string }>>
}

export interface AudioImportServiceDeps {
  getDb: () => unknown
  /** `{userData}/projects` */
  projectRoot: () => string
  scope: AudioProjectScope
  repos: AudioImportRepos
  takeRepo: () => TakeRepo
  segmentRepo: () => VoiceSegmentRepo
  /** 取某行的章节 id（写成品行需要） */
  lineChapterId: (lineId: Id) => Promise<Id | null>
  /** 成品落库后把画本行推进到 `recorded` */
  markLineRecorded?: (lineId: Id) => Promise<unknown>
  /** 读 .docx / .txt 的纯文本（由主进程注入，便于测试替换） */
  readDocument: (filePath: string) => Promise<string>
  /**
   * 把外部音频文件复制进项目目录，返回**实际落盘的绝对路径**与项目内相对路径。
   *
   * 为什么返回绝对路径而不只是相对路径：调用方要校验「复制出来的那一份」是否可读，
   * 而相对路径需要按 `{projectRoot}/{projectId}/{rel}` **假定**拼出来 ——
   * 一旦拼法与实现不一致（真机事故 docs/91 §5.2.19 就是这么来的），
   * 校验就会去读一个不存在的路径，或者更糟：**读到上一次导入的残留文件并误判为通过**。
   * 让复制方直接回报实际路径，就没有这个假设。
   */
  copyIntoProject: (input: {
    projectId: Id
    sourcePath: string
    relativeTarget: string
  }) => Promise<{ relativePath: string; absolutePath: string }>
  /**
   * 探测音频时长（毫秒）；拿不到返回 null。ffmpeg 不可用时也必须返回 null 而不是抛错
   */
  probeDurationMs?: (filePath: string) => Promise<number | null>
  /**
   * ffmpeg 执行器（导入时把 mp3/m4a 解码成 WAV 用）。
   *
   * 不提供 = 本项目不做转码：非 WAV 的源文件会被明确拒绝
   * （`AUDIO_IMPORT_SOURCE_NOT_WAV`）。测试里就是这样构造「用户还没装 ffmpeg」的场景。
   */
  ffmpeg?: FfmpegRunner
  /**
   * ffmpeg 是否真的可用（来自启动期能力探测 `capabilities.ffmpeg.available`）。
   *
   * 为什么不能只看 `deps.ffmpeg` 在不在：执行器**总是**存在（它只是 spawn 的封装），
   * 没装 ffmpeg 时它一样会被构造出来。真正决定「能不能转」的是启动期探测的结果。
   * 缺省视为可用（只要给了 `ffmpeg`），便于测试只注入执行器。
   */
  ffmpegAvailable?: () => boolean
  /**
   * 把项目内的一段音频解码成**单声道 PCM**（导入时按 VAD 切句用）。
   *
   * 返回 `null` 表示「解不了」（文件坏了 / 采样率非法 / 依赖不可用）。
   * 这时服务层**退回「整段 take」**而不是失败 —— 导入本身仍然可用，
   * 只是每一行拿不到精确区间。这个降级是有意为之，并且会记日志。
   *
   * 为什么做成依赖而不是直接调 `readAudioFile`：
   *   · 纯逻辑测试可以注入**合成 PCM**（正弦 + 静音），
   *     从而在不依赖 ffmpeg、不依赖真音频文件的前提下验证整条切句链路；
   *   · 真实实现在 `ports.ts`（`readAudioFile` 会读文件、解析 WAV 头、下混单声道）。
   */
  decodeAudio?: (absolutePath: string) => Promise<{ samples: Float32Array; sampleRate: number } | null>
  /** VAD 参数（导入切句用；只需指定要改的那几个，其余用 `VAD_DEFAULTS`） */
  vadOptions?: Partial<VadOptions>
  /**
   * ASR 引擎（音频转文字）。给了就**优先走识别文本对齐**（`alignLinesToAsr`），
   * 不可用/失败/对不上时自动退回 VAD 路径 —— 真机需求「需要音频转文字…导入速度无所谓」。
   * 不注入 = 永不尝试（纯逻辑测试与「没装识别引擎」的机器都是这条路径）。
   */
  asr?: AsrRunner
  /**
   * 取文件的修改时间（毫秒）。用于文档解析缓存的失效判定。
   *
   * 为什么做成依赖而不是直接 `fs.stat`：
   *   · **可测**：单测用的是不存在的假路径，`stat` 必然失败 ——
   *     若直接 stat，`mtimeMs` 恒为 0，缓存会「永远命中」，
   *     真机上画本被换掉后仍用旧内容，而这种不一致比慢严重得多。
   *   · 不提供时**完全禁用缓存**（保守策略：读不到 mtime 就不敢缓存）。
   */
  mtimeOf?: (filePath: string) => Promise<number | null>
  newId?: (prefix: string) => Id
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

/**
 * 画本解析摘要。
 *
 * 直接复用契约类型 `AudioImportCanvasScan`（而不是另立一个内部类型）：
 * 这个结果**整个**要经 IPC 返回渲染进程，两套类型只会带来无意义的映射代码
 * 与「两处字段名不一致」的风险。
 */
export type CanvasScanResult = AudioImportCanvasScan

/**
 * 单个文件的处理阶段（进度上报用）。
 *
 * 顺序固定：`copy`（复制/转码成 WAV）→ `split`（解码 + 逐帧能量 + VAD + 铺满每行）→ `write`（写 take）。
 * 任务层按阶段给出**文件内份额**，进度条因此在一个大文件上也会动。
 */
export type AudioImportPhase = 'copy' | 'split' | 'write'

/** UI 侧的人工修正（覆盖自动判定）—— 与契约同名，避免两套概念 */
export type FileOverrides = AudioImportFileOverride

/** 请求里描述一个待导入文件 —— 与契约同名 */
export type AudioImportRequestFile = AudioImportFileRequest

/** 导入执行结果：直接复用契约类型（理由同 `CanvasScanResult`） */
export type AudioImportResult = AudioImportApplyResult

export interface AudioImportPlanWithContext {
  plan: AudioImportPlan
  scan: CanvasScanResult
}

/**
 * 把纯逻辑层的 `ImportPlan` 映射成**契约形态**（`shared/types.ts` 里的
 * `AudioImportPlan`）。
 *
 * ### 为什么要显式映射，而不是直接把内部类型塞进 IPC 响应
 *   1. **契约不该暴露实现细节**：`target`/`cvResolution` 是纯逻辑层的内部结构，
 *      改它们不该牵动 IPC 契约（否则渲染进程会被迫跟着改）。
 *   2. **IPC 载荷必须是「扁平的、可序列化的」**：内部类型里有 `Map`、
 *      循环引用风险；契约里全是普通对象与数组。
 *   3. **一次映射换来两端解耦**：UI 只需要
 *      `status` / `lineCount` / `notes` / `targetExplanation` 这些展示字段。
 */
export function toContractPlan(plan: ImportPlan): AudioImportPlan {
  return {
    files: plan.files.map((f) => ({
      filePath: f.filePath,
      fileName: f.fileName,
      sizeBytes: f.sizeBytes,
      durationMs: f.durationMs,
      status: f.status,
      range: f.range,
      chaptersInCanvas: f.chaptersInCanvas,
      chaptersMissingInCanvas: f.chaptersMissingInCanvas,
      lineCount: f.lineCount,
      linesByChapter: f.linesByChapter,
      samples: f.samples,
      overlappingLineCount: f.overlappingLineCount,
      targetExplanation: f.target?.explanation ?? null,
      targetKind: f.target?.kind ?? null,
      cvMatchedName: f.cvResolution?.matched?.name ?? null,
      cvMatchMethod: f.cvResolution?.method ?? 'unresolved',
      cvConfidence: f.cvResolution?.confidence ?? 0,
      notes: f.notes,
    })),
    summary: plan.summary,
    warnings: plan.warnings,
  }
}

export interface AudioImportService {
  /** ① 扫描画本：解析 docx + 对齐数据库章节/角色 */
  scanCanvas(input: { projectId: Id; bookId: Id; canvasPath?: string }): Promise<AudioImportCanvasScan>
  /** ② 扫描文件夹里的音频候选文件 */
  scanAudioFiles(input: { dir: string; recursive?: boolean }): Promise<AudioImportCandidate[]>
  /** ③ 生成导入预览（不写库） */
  buildPlan(input: {
    projectId: Id
    bookId: Id
    canvasPath?: string
    files: AudioImportFileRequest[]
    /** 已经探测过的时长（来自 `scanAudioFiles`），省去重复跑 ffprobe */
    durationByPath?: ReadonlyMap<string, number | null>
  }): Promise<AudioImportPlanWithContext>
  /** ④ 执行导入（写库） */
  applyImport(input: {
    projectId: Id
    bookId: Id
    canvasPath?: string
    files: AudioImportFileRequest[]
    /** 只导入这些文件（按 fileName 过滤）；不传 = 全部就绪的 */
    onlyFiles?: string[]
    /** 跳过「需人工确认」的文件（默认 false：也会导入，但会记在 notes 里） */
    skipNeedsReview?: boolean
    /** 已经探测过的时长（来自 `scanAudioFiles` / `buildPlan`） */
    durationByPath?: ReadonlyMap<string, number | null>
    /**
     * 逐文件进度回调（任务层用它写 `ctx.report`）。
     *
     * 为什么按文件 + 阶段而不是按毫秒：一个文件的耗时几乎全在「转码/解码 → 逐帧能量 + VAD + 切句」，
     * 阶段之间是天然的分界；只报「第几个文件」时，单个大文件（真机最大 125 MB）会让
     * 进度条停在同一个百分比好几分钟 —— 用户看到的就是「进度条不动」。
     */
    onProgress?: (done: number, total: number, fileName: string, phase: AudioImportPhase) => void
    /** 取消信号：每个文件开始前检查一次（已在处理的文件跑完再退出） */
    signal?: AbortSignal
  }): Promise<AudioImportApplyResult>
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

const RECURSIVE_DEPTH_LIMIT = 4

/**
 * 单个文件的转码超时（毫秒）。
 *
 * 真机样本最大的一个约 30 MB / 74 章。解码一条 48 kHz 单声道的音轨远快于实时，
 * 5 分钟是「慢机器也能过、但卡死时不会让整批导入永远挂着」的量级。
 * 超时后 `FfmpegRunner` 会 SIGTERM → 2 秒 → SIGKILL（docs/14 §7.2）。
 */
const TRANSCODE_TIMEOUT_MS = 5 * 60 * 1000

/** 取字符串末尾若干字符（ffmpeg 的报错关键信息在最后几行，前面全是进度噪音） */
function tailText(s: string, max: number): string {
  const t = String(s ?? '')
  return t.length <= max ? t : `…${t.slice(t.length - max)}`
}

/**
 * 去掉扩展名（只认最后一个点之后的短后缀）。
 *
 * 为什么要去：项目内落盘的那一份扩展名由内容决定（统一 `.wav`），
 * 源文件的 `.mp3` 留着就会拼出 `...-多角色-春哥拿大顶.mp3.wav`。
 * 只对「点后 ≤ 8 位且不含点」的后缀动手，避免把
 * `2221-2250-多角色-春哥拿大顶` 这类名字里的点当扩展名切掉。
 */
function stripExtension(name: string): string {
  const s = String(name ?? '')
  const m = /^(.*)\.([^.]{1,8})$/.exec(s)
  return m && m[1] ? m[1] : s
}

/**
 * 把文件名清洗成可安全用作路径片段的形式。
 *
 * 必要性：文件名来自**用户目录**，可能含 `..`、路径分隔符、控制字符。
 * 直接拼进项目内路径会造成目录穿越（写到项目目录之外），
 * 这是导入外部文件时最典型的安全问题。
 */
export function sanitizeFileName(name: string): string {
  return (
    String(name ?? '')
      // 去掉路径分隔符与目录穿越片段
      .replace(/[/\\]/g, '_')
      .replace(/\.{2,}/g, '_')
      // 控制字符与 Windows 非法字符
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F<>:"|?*]/g, '_')
      .trim()
      .slice(0, 120) || 'unnamed'
  )
}

export function createAudioImportService(deps: AudioImportServiceDeps): AudioImportService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`)
  const now = deps.now ?? (() => Date.now())
  const log = deps.log

  /**
   * 文档解析缓存。
   *
   * ### 为什么需要它
   *   正常流程会**三次**请求同一份画本：
   *   `record:importScanCanvas`（扫描）→ `record:importPlan`（预览）→
   *   `record:importApply`（导入）。每次都重新 `mammoth` 解析 + 全文分词，
   *   而真实样本里最大的那份画本是 2.13 MB / 16,537 行 —— 用户会明显感觉到卡。
   *
   * ### 为什么带 mtime
   *   只按路径缓存会让「用户在导入过程中改了画本」用到旧内容，
   *   而这种不一致比慢更糟（预览与实际用的不是同一份文本）。
   *   带上 `mtimeMs` 后，文件一变缓存自然失效。
   *
   * ### 为什么只存一条
   *   实际使用只围绕**当前选中的那一份画本**，存一条就够，
   *   也避免了「缓存无限增长」这个需要额外策略的问题。
   */
  let docCache: {
    path: string
    mtimeMs: number
    /** 同一份画本在不同书下对齐出的章节不同，所以书也要参与缓存判定 */
    bookId: Id
    canvas: ParsedCanvas
    scan: CanvasScanResult
    chapterIds: Id[]
  } | null = null

  /**
   * 章节号 → chapterId；以及 chapterId → 章节号（反向查，避免每次线性搜）。
   *
   * ⚠️ 键是**章节号**（`listChapters` 返回的 `no`），不是 `chapters.seq`。
   *    见 `AudioImportRepos.listChapters` 的注释 —— 这两个值在真实书里完全不同。
   */
  async function chapterMaps(bookId: Id): Promise<{
    byNo: Map<number, { id: Id; title: string }>
    noById: Map<Id, number>
  }> {
    const chapters = await deps.repos.listChapters(bookId)
    const byNo = new Map<number, { id: Id; title: string }>()
    const noById = new Map<Id, number>()
    for (const c of chapters) {
      byNo.set(c.no, { id: c.id, title: c.title })
      noById.set(c.id, c.no)
    }
    return { byNo, noById }
  }

  /**
   * 直接用**数据库里已导入的画本**构建解析结果（章节 / canvas_lines / characters）。
   *
   * 为什么需要它：用户导入音频时，画本早就通过「书籍导入」进库了，
   * 再要求他选一次画本 docx 是多余的 —— 而且很容易选错版本。
   * 角色名与 CV 都从库里读：`characters.name` 是角色，`characters.note` 里的
   * `CV：xxx`（画本导入写入）是 CV。
   */
  async function loadFromDb(input: { projectId: Id; bookId: Id }): Promise<{
    canvas: ParsedCanvas
    scan: CanvasScanResult
    chapterIds: Id[]
  }> {
    const chapters = await deps.repos.listChapters(input.bookId)
    const characters = await deps.repos.listCharacters(input.bookId)
    const voiceActors = await deps.repos.listVoiceActors(input.projectId)

    const nameById = new Map<Id, string>()
    const cvById = new Map<Id, string>()
    for (const c of characters) {
      nameById.set(c.id, c.name)
      const cv = parseCvFromNote(c.note)
      if (cv) cvById.set(c.id, cv)
    }

    const roster: CanvasRosterEntry[] = characters.map((c) => ({
      cv: cvById.get(c.id) ?? null,
      character: c.name,
      description: null,
      lineCount: null,
      sourceLine: 0,
    }))

    const lines: CanvasParsedLine[] = []
    const chapterIds: Id[] = []
    for (const ch of chapters) {
      chapterIds.push(ch.id)
      const rows = await deps.repos.listLines(ch.id)
      for (const r of rows) {
        const kind: LineRef['kind'] = r.kind === 'narration' ? 'narration' : r.characterId ? 'dialogue' : 'group'
        const owners: CanvasLineOwner[] = []
        if (r.characterId) {
          const name = nameById.get(r.characterId)
          if (name) owners.push({ character: name, cv: cvById.get(r.characterId) ?? '' })
        }
        lines.push({
          sourceLine: r.seq,
          chapterNo: ch.no,
          kind,
          owners,
          dialogueText: kind === 'narration' ? '' : r.text,
          chapterTitle: ch.title,
          segments: [],
          rawText: r.text,
        })
      }
    }

    const chapterNos = [...new Set(chapters.map((c) => c.no))].sort((a, b) => a - b)
    const canvas: ParsedCanvas = { roster, lines, chapters: chapterNos, warnings: [] }

    const cvSet = new Set<string>()
    for (const r of roster) if (r.cv) cvSet.add(r.cv)
    for (const l of lines) for (const o of l.owners) if (o.cv) cvSet.add(o.cv)

    const scan: CanvasScanResult = {
      filePath: '',
      chapters: chapters.map((c) => ({ no: c.no, chapterId: c.id, title: c.title, lineCount: 0 })),
      characters: characters.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
      voiceActors,
      canvasCvs: [...cvSet].sort(),
      documentChapterRange:
        chapterNos.length > 0
          ? { from: chapterNos[0]!, to: chapterNos[chapterNos.length - 1]! }
          : null,
      warnings: [],
    }

    log?.info?.('audioImport.canvasFromDb', {
      event: 'audioImport.canvasFromDb',
      bookId: input.bookId,
      dbChapters: chapterIds.length,
      lines: lines.length,
      characters: characters.length,
      cvs: scan.canvasCvs.length,
    })
    return { canvas, scan, chapterIds }
  }
  /** 读文档 + 解析 + 与数据库对齐（带缓存，见上） */
  async function loadAndAlign(input: {
    projectId: Id
    bookId: Id
    /** 省略 = 用数据库里已导入的画本（推荐）；给了才去解析 docx */
    canvasPath?: string
  }): Promise<{ canvas: ParsedCanvas; scan: CanvasScanResult; chapterIds: Id[] }> {
    // 没给画本文件 → 直接用库里的画本（章节 / canvas_lines / characters）
    if (!input.canvasPath) return loadFromDb({ projectId: input.projectId, bookId: input.bookId })
    /**
     * 拿不到 mtime（没注入，或 stat 失败）时**完全跳过缓存**。
     *
     * 这是刻意的保守策略：**不知道文件有没有变，就不敢用缓存**。
     * 早期版本把 mtimeMs 兜成 0，结果是「永远命中」——
     * 用户在导入过程中换了画本，第二次预览仍用旧内容，
     * 而预览与实际导入不一致正是本功能最怕的问题。
     */
    let mtimeMs: number | null = null
    if (deps.mtimeOf) {
      try {
        mtimeMs = await deps.mtimeOf(input.canvasPath)
      } catch {
        mtimeMs = null
      }
    }

    if (
      mtimeMs !== null &&
      docCache &&
      docCache.path === input.canvasPath &&
      docCache.mtimeMs === mtimeMs &&
      docCache.bookId === input.bookId
    ) {
      return { canvas: docCache.canvas, scan: docCache.scan, chapterIds: docCache.chapterIds }
    }

    const text = await deps.readDocument(input.canvasPath)
    const canvas = parseCanvasText(text)

    const { byNo } = await chapterMaps(input.bookId)
    const characters = await deps.repos.listCharacters(input.bookId)
    const voiceActors = await deps.repos.listVoiceActors(input.projectId)

    const chapters: CanvasScanResult['chapters'] = []
    const chapterIds: Id[] = []
    for (const no of canvas.chapters) {
      const hit = byNo.get(no)
      if (!hit) continue
      chapterIds.push(hit.id)
      chapters.push({ no, chapterId: hit.id, title: hit.title, lineCount: 0 })
    }

    // 画本里的 CV：角色表 + 正文标记都要收（角色表可能不全）
    const cvSet = new Set<string>()
    for (const r of canvas.roster) if (r.cv) cvSet.add(r.cv)
    for (const l of canvas.lines) for (const o of l.owners) cvSet.add(o.cv)

    const scan: CanvasScanResult = {
      filePath: input.canvasPath,
      chapters,
      characters,
      voiceActors,
      canvasCvs: [...cvSet].sort(),
      documentChapterRange:
        canvas.chapters.length > 0
          ? { from: canvas.chapters[0]!, to: canvas.chapters[canvas.chapters.length - 1]! }
          : null,
      warnings: canvas.warnings.map((w) => ({
        sourceLine: w.sourceLine,
        reason: w.reason,
        detail: w.detail,
        sample: w.sample,
      })),
    }

    // 只在拿得到 mtime 时才写缓存（拿不到 → 不允许缓存，见上面的说明）
    if (mtimeMs !== null) {
      docCache = { path: input.canvasPath, mtimeMs, bookId: input.bookId, canvas, scan, chapterIds }
    }
    log?.info?.('audioImport.canvasScanned', {
      event: 'audioImport.canvasScanned',
      filePath: input.canvasPath,
      docChapters: canvas.chapters.length,
      dbChapters: chapterIds.length,
      rosterEntries: canvas.roster.length,
      lines: canvas.lines.length,
      warnings: canvas.warnings.length,
      cached: false,
    })

    return { canvas, scan, chapterIds }
  }

  /**
   * 把**数据库画本行**映射成 `LineRef`（与文档行同一形态）。
   *
   * 这是「预览与导入共用一套选行逻辑」的关键一步：
   * 文档行由 `parseCanvasText` 直接产出，数据库行在这里转换。
   *
   * 映射规则（三处都要对，错一处就会整体少选/多选）：
   *   · `kind`：`speakerType === 'narration'` → `narration`
   *             `kind` 列里 `inner`/`sfx_note` 算对白（它们要念）
   *             有 `character_id` → `dialogue`
   *   · `owners`：由 `character_id` 反查角色名，并**用文档角色表补上 CV 名**
   *   · `dialogueText`：用 `text`
   *
   * ### ⚠️ 为什么 CV 名必须补上（不补就直接废掉「多角色」这条路）
   *   数据库 `canvas_lines` **只存 `character_id`，没有 CV 列**。
   *   而 `multiRole` 的选行是按 **CV** 匹配 `owners[].cv` 的。
   *   如果这里把 `cv` 留空，多角色文件会「说话人解析成功、却一行都选不到」
   *   —— 表现为 `no-lines`，而真实原因是数据映射缺一个字段。极难查。
   *
   *   CV↔角色 的对应关系**只有文档角色表有**（`【CV-角色】` 标记也能佐证），
   *   所以这里必须接收 `characterToCv` 映射并填进去。
   */
  async function dbLinesAsRefs(input: {
    bookId: Id
    chapterIds: readonly Id[]
    chapterNoById: ReadonlyMap<Id, number>
    characterNameById: ReadonlyMap<Id, string>
    /** 角色名（归一化后）→ CV 名。来自文档角色表；缺了会让多角色选行失败 */
    cvByCharacterName: ReadonlyMap<string, string>
  }): Promise<Array<{ lineId: Id; chapterId: Id; ref: LineRef }>> {
    const out: Array<{ lineId: Id; chapterId: Id; ref: LineRef }> = []
    for (const chapterId of input.chapterIds) {
      const lines = await deps.repos.listLines(chapterId)
      const chapterNo = input.chapterNoById.get(chapterId)
      if (chapterNo === undefined) continue
      for (const l of lines) {
        const characterName = l.characterId ? (input.characterNameById.get(l.characterId) ?? null) : null
        const kind: 'dialogue' | 'group' | 'narration' =
          l.speakerType === 'narration' || (l.kind === 'narration' && !l.characterId)
            ? 'narration'
            : characterName
              ? 'dialogue'
              : 'group'
        // CV 必须从文档角色表补上，否则多角色选行会全部落空（见函数注释）
        const cv = characterName ? (input.cvByCharacterName.get(normalizeName(characterName)) ?? '') : ''
        out.push({
          lineId: l.id,
          chapterId,
          ref: {
            sourceLine: l.seq,
            chapterNo,
            kind,
            owners: characterName ? [{ cv, character: characterName }] : [],
            dialogueText: l.text,
          },
        })
      }
    }
    out.sort((a, b) => a.ref.chapterNo - b.ref.chapterNo || a.ref.sourceLine - b.ref.sourceLine)
    return out
  }

  /**
   * 把一个导入文件切成「每行一段」（解码 → VAD → 铺满）。
   *
   * 三条降级路径，**都不让导入失败**（用户给的是既成音频，失败了他无路可走）：
   *
   * | 情形 | 结果 |
   * |------|------|
   * | 没注入 `decodeAudio` / 解码返回 null | `rangeByLineId` 为空，`method='none'`，退回整段 |
   * | 解码成功但 0 采样 | 同上（`planLineSplits` 不编造区间） |
   * | 解码成功但 VAD 找不到人声 | `method='whole-timeline'`，按文本长度比例硬切 |
   *
   * ⚠️ `method='whole-timeline'` 的区间**不可信**（只是按比例切），
   * 所以 `needsReview` 会带上低置信度的行，take 上也会打 `import-needs-review`。
   */
  async function splitForFile(input: {
    absolutePath: string
    orderedHits: ReadonlyArray<{ lineId: Id; ref: LineRef }>
    fallbackDurationMs: number
  }): Promise<{
    rangeByLineId: Map<Id, { startMs: number; endMs: number }>
    needsReview: Set<Id>
    warnings: string[]
    /** `asr` = 用识别文本做强制对齐（最准）；`vad` = 按停顿切；`whole-timeline` = 按字数比例 */
    method: 'asr' | 'vad' | 'whole-timeline' | 'empty' | 'none'
    fallbackDurationMs: number
    /** VAD 切出的语音片数（0 = 没走切句）。进日志，用于区分两种「导入成功」 */
    sliceCount: number
  }> {
    const none = (warnings: string[], fallbackDurationMs: number) => ({
      rangeByLineId: new Map<Id, { startMs: number; endMs: number }>(),
      needsReview: new Set<Id>(),
      warnings,
      method: 'none' as const,
      fallbackDurationMs,
      sliceCount: 0,
    })

    if (input.orderedHits.length === 0) {
      return none([], input.fallbackDurationMs)
    }

    /**
     * ── ① 音频转文字 → 每段文字的起止 → 按文本强制对齐（真机需求）──────────────
     *
     * 顺序上**先试 ASR**：它给的是「这一句文字在哪一段时间里」，
     * 比 VAD 的「哪里有停顿」强一个量级。识别不可用/失败/对不上时再退回 VAD 路径。
     * 慢是已知代价，用户已明确接受（「导入速度无所谓」）。
     */
    if (deps.asr) {
      try {
        const asr = await deps.asr.transcribe({
          absolutePath: input.absolutePath,
          durationMs: input.fallbackDurationMs,
        })
        if (asr && asr.segments.length > 0) {
          const aligned = alignLinesToAsr({
            segments: asr.segments,
            // token 级时间戳（whisper.cpp -ojf）：逐字对齐靠它把长句的尾音也框进去
            tokens: asr.tokens,
            lines: input.orderedHits.map((h) => ({ lineId: h.lineId, text: h.ref.dialogueText ?? '' })),
            durationMs: input.fallbackDurationMs,
            charsPerSecond: deps.vadOptions?.charsPerSecond,
          })
          if (aligned.usable && aligned.ranges.length > 0) {
            const rangeByLineId = new Map<Id, { startMs: number; endMs: number }>()
            for (const r of aligned.ranges) rangeByLineId.set(r.lineId, { startMs: r.startMs, endMs: r.endMs })
            log?.info?.('audioImport.asrAligned', {
              event: 'audioImport.asrAligned',
              shape: asr.shape,
              segments: asr.segments.length,
              tokens: asr.tokens?.length ?? 0,
              lines: input.orderedHits.length,
              matched: aligned.matchedCount,
              unclaimedLines: aligned.unclaimedLines,
              // 字级命中率（识别文本有多少字在画本里找到）
              matchRatio: Number(aligned.avgSimilarity.toFixed(3)),
              elapsedMs: asr.elapsedMs,
            })
            return {
              rangeByLineId,
              needsReview: new Set<Id>(aligned.needsReview),
              warnings: aligned.warnings,
              method: 'asr',
              fallbackDurationMs: input.fallbackDurationMs,
              sliceCount: asr.segments.length,
            }
          }
          log?.warn?.('audioImport.asrUnusable', {
            event: 'audioImport.asrUnusable',
            unclaimedLines: aligned.unclaimedLines,
            lines: input.orderedHits.length,
            matchRatio: Number(aligned.avgSimilarity.toFixed(3)),
            note: '识别文本与画本行对不上的比例过高 —— 退回 VAD 切句',
          })
        }
      } catch (e) {
        // 识别失败必须只记日志：导入不能因为引擎坏了而失败
        log?.warn?.('audioImport.asrFailed', {
          event: 'audioImport.asrFailed',
          reason: e instanceof Error ? e.message : String(e),
          note: '已退回 VAD 切句',
        })
      }
    }

    /**
     * ── ② VAD 路径的前提：能把音频解成 PCM ────────────────────────────────
     *
     * ⚠️ 这个判断必须放在 ASR 之后：ASR 分支**不需要** `decodeAudio`
     * （引擎自己用 ffmpeg 转 16 kHz，本进程只读它输出的 JSON）。
     * 放在前面会让「装了识别引擎但渲染侧解码不可用」的环境永远走不到识别。
     */
    if (!deps.decodeAudio) {
      return none([], input.fallbackDurationMs)
    }

    let decoded: { samples: Float32Array; sampleRate: number } | null = null
    try {
      decoded = await deps.decodeAudio(input.absolutePath)
    } catch (e) {
      // 解码抛错不该毁掉导入：如实记日志后退回整段
      log?.warn?.('audioImport.decodeFailed', {
        event: 'audioImport.decodeFailed',
        reason: e instanceof Error ? e.message : String(e),
      })
      return none(['无法解码这段音频，已按整段导入（每行没有精确区间）'], input.fallbackDurationMs)
    }
    if (!decoded) {
      return none(['无法解码这段音频，已按整段导入（每行没有精确区间）'], input.fallbackDurationMs)
    }

    /**
     * 解出来了、但**一个采样都没有** —— 这不是「解不了」，而是「这段音频是空的」。
     *
     * 两者必须分开：前者退回整段还有意义（我们只是没能力看内容），
     * 后者退回整段会写出 N 条指向空文件的 take —— 界面显示「已导入 N 行」，
     * 而每一行都是静音。所以这里回报 `empty`，由调用方**明确跳过这个文件**。
     */
    if (decoded.samples.length === 0 || !(decoded.sampleRate > 0)) {
      return {
        rangeByLineId: new Map<Id, { startMs: number; endMs: number }>(),
        needsReview: new Set<Id>(input.orderedHits.map((h) => h.lineId)),
        warnings: ['这段音频解出来是空的（0 个采样）—— 没有可导入的内容'],
        method: 'empty',
        fallbackDurationMs: input.fallbackDurationMs,
        sliceCount: 0,
      }
    }

    const plan = planLineSplits({
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      lines: input.orderedHits.map((h) => ({ lineId: h.lineId, text: h.ref.dialogueText ?? '' })),
      /**
       * 导入用**更敏感**的 VAD（`VAD_IMPORT_OVERRIDES`）：连续朗读的句间停顿只有
       * 100~200 ms，默认的「250 ms 桥接」会把它们并成大片，导致只能按字符比例硬切、
       * 音与文本错位（真机反馈：「2221 章导入进来后音和文本没对上，比如旁白的第三行」）。
       * 用户在设置里调过的 `recording.vad` 仍然优先。
       */
      vad: { ...VAD_IMPORT_OVERRIDES, ...(deps.vadOptions ?? {}) },
    })

    /**
     * 时长以 **PCM 长度**为准（`plan.stats.durationMs`），不用 ffprobe 的结果。
     * 同一份数据算两次必然不一致：VAD 的时间轴是按样本数铺的，
     * 若 take 用另一个时长，末行的 `srcOut` 可能比音频实际长度大一点点。
     */
    const rangeByLineId = new Map<Id, { startMs: number; endMs: number }>()
    for (const r of plan.ranges) rangeByLineId.set(r.lineId, { startMs: r.startMs, endMs: r.endMs })

    return {
      rangeByLineId,
      needsReview: new Set(plan.needsReview),
      warnings: plan.warnings,
      method: plan.method,
      fallbackDurationMs: plan.stats.durationMs > 0 ? plan.stats.durationMs : input.fallbackDurationMs,
      sliceCount: plan.stats.sliceCount,
    }
  }

  /** 读文件头 64 字节 + 体积（容器判定只需要头） */
  async function readHead(path: string): Promise<{ head: Uint8Array; sizeBytes: number }> {
    const { open, stat } = await import('node:fs/promises')
    const sizeBytes = (await stat(path)).size
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(64)
      const { bytesRead } = await fh.read(buf, 0, 64, 0)
      return { head: new Uint8Array(buf.subarray(0, bytesRead)), sizeBytes }
    } finally {
      await fh.close()
    }
  }

  /**
   * 校验「项目内的那一份」确实是 WAV，并回报它的真实体积。
   *
   * 为什么读**复制方回报的绝对路径**而不是按约定拼：见 `copyIntoProject` 的注释
   * （真机事故 docs/91 §5.2.19 —— 拼错时会读到上一次导入的残留文件并误判为通过）。
   */
  async function verifyProjectWav(input: {
    absolutePath: string
    relativePath: string
    fileName: string
  }): Promise<{ container: AudioContainer; sizeBytes: number }> {
    let head: Uint8Array
    let sizeBytes = 0
    try {
      const r = await readHead(input.absolutePath)
      head = r.head
      sizeBytes = r.sizeBytes
    } catch (e) {
      throw new AppError('INVALID_PAYLOAD', {
        cause: e,
        details: {
          reason: 'copied-file-unreadable',
          fileName: input.fileName,
          relativePath: input.relativePath,
          absolutePath: input.absolutePath,
          hint: '复制/转码之后读不到项目内的文件，请检查磁盘空间与权限',
        },
      })
    }

    const probe = probeAudioContainer(head)
    if (!probe.readableAsWav) {
      /**
       * 走到这里说明**我们自己的产物**不是 WAV —— 与「源文件不是 WAV」是两回事，
       * 属于实现缺陷而不是用户输入问题，所以仍然用通用的 `INVALID_PAYLOAD`。
       */
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          reason: 'project-copy-not-wav',
          fileName: input.fileName,
          relativePath: input.relativePath,
          container: probe.container,
          evidence: probe.evidence,
        },
      })
    }
    return { container: probe.container, sizeBytes }
  }

  /**
   * 把外部音频落进项目目录，**并保证落地的那一份是可读的 WAV**。
   *
   * 两条路径：
   *   1. 源文件本来就是 WAV（按**内容**判定，不看扩展名）→ 原样复制，零重编码
   *   2. 源文件是 mp3/m4a/… → 经 ffmpeg 解码成 `48 kHz / 单声道 / 16 位` WAV
   *
   * ### 为什么必须在入口处统一成 WAV（真实缺陷）
   *   第一版直接把源文件复制进来、扩展名写成 `.wav` —— 而源文件其实是 mp3。
   *   项目内其它链路（剪裁/测量/波形/处理链）**只认 WAV**，`readWavPayload`
   *   按内容校验（`RIFF`+`WAVE` 魔数）会抛错。后果是「设为成品 / 测量 / 波形」
   *   全部失败，**而扩展名看起来完全正确** —— 排查时很容易先怀疑别的地方。
   *
   * ### 为什么扩展名一律归一成 `.wav`
   *   项目内文件是**派生数据**（派生自源文件），不是用户原始素材的归档。
   *   统一扩展名让「`file_path` 以 `.wav` 结尾」这个约定在导入阶段就成立，
   *   下游不必再判断扩展名与内容是否一致。
   *
   * @throws `AUDIO_IMPORT_SOURCE_NOT_WAV` —— 源文件不是 WAV 且 ffmpeg 不可用
   * @throws `AUDIO_IMPORT_TRANSCODE_FAILED` —— ffmpeg 可用但转码失败
   */
  async function copyAndVerifyAudio(input: {
    projectId: Id
    sourcePath: string
    fileName: string
    /** `imports/{ts}-{name}`，**不带扩展名**（由本函数统一补 `.wav`） */
    relativeTargetBase: string
  }): Promise<{
    relativePath: string
    absolutePath: string
    container: AudioContainer
    sizeBytes: number
    transcoded: boolean
  }> {
    const relativeTarget = `${input.relativeTargetBase}.wav`

    // ① 先看**源文件**是什么容器 —— 按内容判定，不看扩展名
    let srcHead: Uint8Array
    try {
      srcHead = (await readHead(input.sourcePath)).head
    } catch (e) {
      throw new AppError('FILE_NOT_FOUND', {
        cause: e,
        details: { op: 'audio:import', path: input.sourcePath },
      })
    }
    const srcProbe = probeAudioContainer(srcHead)

    // ② 本来是 WAV → 原样复制（逐字节搬运，不经过任何编解码）
    if (srcProbe.readableAsWav) {
      const copied = await deps.copyIntoProject({
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        relativeTarget,
      })
      const verified = await verifyProjectWav({
        absolutePath: copied.absolutePath,
        relativePath: copied.relativePath,
        fileName: input.fileName,
      })
      return {
        relativePath: copied.relativePath,
        absolutePath: copied.absolutePath,
        container: verified.container,
        sizeBytes: verified.sizeBytes,
        transcoded: false,
      }
    }

    // ③ 非 WAV → 转码；ffmpeg 不可用时如实报错并给可行动指引
    const ffmpeg = deps.ffmpeg
    const available = ffmpeg ? (deps.ffmpegAvailable?.() ?? true) : false
    if (!ffmpeg || !available) {
      throw new AppError('AUDIO_IMPORT_SOURCE_NOT_WAV', {
        params: { fileName: input.fileName, containerLabel: containerLabel(srcProbe.container) },
        details: {
          reason: 'import-source-not-wav',
          fileName: input.fileName,
          container: srcProbe.container,
          containerLabel: containerLabel(srcProbe.container),
          evidence: srcProbe.evidence,
          ffmpegAvailable: available,
          ffmpegConfigured: Boolean(deps.ffmpeg),
          hint:
            `这个文件是 ${containerLabel(srcProbe.container)}，需要先转成 WAV 才能导入。\n` +
            '请在「设置 → 音频」里指定转码工具（ffmpeg）的路径，然后重新导入；' +
            '或者先用外部工具把它转成 WAV。',
        },
      })
    }

    const { mkdir } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const destAbs = join(deps.projectRoot(), input.projectId, relativeTarget)
    await mkdir(dirname(destAbs), { recursive: true })

    const command = buildDecodeToWavCommand({ input: input.sourcePath, output: destAbs })
    let exitCode = -1
    let stderr = ''
    try {
      const r = await ffmpeg.execute(command, { timeoutMs: TRANSCODE_TIMEOUT_MS })
      exitCode = r.exitCode
      stderr = r.stderr
    } catch (e) {
      // 进程根本起不来（ENOENT = 路径不对）
      throw new AppError('AUDIO_IMPORT_TRANSCODE_FAILED', {
        cause: e,
        params: { fileName: input.fileName },
        details: {
          reason: 'ffmpeg-not-runnable',
          fileName: input.fileName,
          container: srcProbe.container,
          hint: '转码工具起不来，请在「设置 → 音频」里确认路径是否正确。',
        },
      })
    }
    if (exitCode !== 0) {
      throw new AppError('AUDIO_IMPORT_TRANSCODE_FAILED', {
        params: { fileName: input.fileName },
        details: {
          reason: 'ffmpeg-nonzero-exit',
          fileName: input.fileName,
          container: srcProbe.container,
          exitCode,
          // stderr 只进日志/诊断包，**绝不**给用户看（含绝对路径与滤镜名）
          stderr: tailText(stderr, 2000),
        },
      })
    }

    const verified = await verifyProjectWav({
      absolutePath: destAbs,
      relativePath: relativeTarget,
      fileName: input.fileName,
    })
    log?.info?.('audioImport.transcoded', {
      event: 'audioImport.transcoded',
      fileName: input.fileName,
      from: srcProbe.container,
      to: verified.container,
      sizeBytes: verified.sizeBytes,
    })
    return {
      relativePath: relativeTarget,
      absolutePath: destAbs,
      container: verified.container,
      sizeBytes: verified.sizeBytes,
      transcoded: true,
    }
  }

  /** 把 UI 的人工修正转成规划层的输入形态 */
  function overridesToInput(o: FileOverrides | undefined): {
    overrideCharacter?: string | null
    overrideCv?: string | null
    overrideNarration?: boolean
    fromChapter?: number
    toChapter?: number
  } {
    if (!o) return {}
    return {
      ...(o.character !== undefined && o.character !== null ? { overrideCharacter: o.character } : {}),
      ...(o.cv !== undefined && o.cv !== null ? { overrideCv: o.cv } : {}),
      ...(o.narration ? { overrideNarration: true } : {}),
      // 文件名解析不出区间时，用户手工填的章节区间（见 AudioImportFileOverride）
      ...(o.fromChapter !== undefined && o.fromChapter !== null ? { fromChapter: o.fromChapter } : {}),
      ...(o.toChapter !== undefined && o.toChapter !== null ? { toChapter: o.toChapter } : {}),
    }
  }

  return {
    // ── ① 扫描画本 ───────────────────────────────────────────────────────────
    async scanCanvas(input) {
      const { scan, chapterIds } = await loadAndAlign(input)
      // 顺手统计每章行数（UI 要显示「这章有几行」）
      const counts = new Map<Id, number>()
      for (const cid of chapterIds) {
        const lines = await deps.repos.listLines(cid)
        counts.set(cid, lines.length)
      }
      for (const c of scan.chapters) c.lineCount = counts.get(c.chapterId) ?? 0
      return scan
    },

    // ── ② 扫描音频候选 ───────────────────────────────────────────────────────
    async scanAudioFiles(input) {
      const recursive = input.recursive ?? false
      const found: string[] = []

      const walk = (dir: string, depth: number): void => {
        let names: string[]
        try {
          names = readdirSync(dir)
        } catch (e) {
          log?.warn?.('audioImport.scanDirFailed', {
            event: 'audioImport.scanDirFailed',
            dir,
            reason: e instanceof Error ? e.message : String(e),
          })
          return
        }
        for (const name of names) {
          if (name.startsWith('.')) continue
          const full = join(dir, name)
          let st: ReturnType<typeof statSync>
          try {
            st = statSync(full)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            if (recursive && depth < RECURSIVE_DEPTH_LIMIT) walk(full, depth + 1)
            continue
          }
          // 只按扩展名筛「是不是音频」；命名合不合规由 `parseAudioFileName` 判定，
          // 但**解析失败的文件也要带出来**（见 `AudioImportCandidate.parseError`）。
          const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
          if (!isAudioExtension(ext)) continue
          found.push(full)
        }
      }
      walk(input.dir, 0)
      found.sort((a, b) => a.localeCompare(b))

      const out: AudioImportCandidate[] = []
      const unparsed: Array<{ fileName: string; reason: string; detail: string }> = []
      for (const filePath of found) {
        const fileName = basename(filePath)
        let sizeBytes = 0
        try {
          sizeBytes = statSync(filePath).size
        } catch {
          /* 读不到大小不影响解析，留 0 */
        }
        let durationMs: number | null = null
        if (deps.probeDurationMs) {
          try {
            durationMs = await deps.probeDurationMs(filePath)
          } catch {
            // 探测失败**不能中断扫描**：一个坏文件不该毁掉整批导入
            durationMs = null
          }
        }
        const parsed = parseAudioFileName(fileName)
        const parseError = parsed.ok ? null : { reason: parsed.reason, detail: parsed.detail }
        if (parseError) unparsed.push({ fileName, ...parseError })
        out.push({ filePath, fileName, sizeBytes, durationMs, parseError })
      }

      log?.info?.('audioImport.filesScanned', {
        event: 'audioImport.filesScanned',
        dir: input.dir,
        recursive,
        candidates: out.length,
        parseable: out.length - unparsed.length,
        // 解析不了的文件必须能在日志里对上号（用户会问「为什么只扫出 N 个」）
        unparsed: unparsed.slice(0, 20),
      })
      return out
    },

    // ── ③ 生成预览 ───────────────────────────────────────────────────────────
    async buildPlan(input) {
      const { canvas, scan } = await loadAndAlign(input)

      /**
       * ⚠️ 必须在这里也探测时长，不能只依赖 `scanAudioFiles`。
       *
       * 踩过的坑：`buildPlan` 原来只 `statSync` 取大小、不探时长，
       * 于是预览里 `durationMs` 全是 null；而 `applyImport` 用
       * `filePlan.durationMs` 写 take 的 `srcOutMs`/`durationMs` ——
       * 结果是**所有导入 take 的时长恒为 0**。UI 上看不出来
       * （列表只显示「已导入」），要到混音/导出时才发现音频长度是 0。
       *
       * 调用方已经扫过一遍时可以通过 `durationByPath` 传进来，避免重复探测。
       */
      const fileInputs = []
      for (const f of input.files) {
        const fileName = basename(f.filePath)
        const r = parseAudioFileName(fileName)
        let sizeBytes = 0
        try {
          sizeBytes = statSync(f.filePath).size
        } catch {
          /* ignore */
        }
        let durationMs: number | null = input.durationByPath?.get(f.filePath) ?? null
        if (durationMs === null && deps.probeDurationMs) {
          try {
            durationMs = await deps.probeDurationMs(f.filePath)
          } catch {
            durationMs = null
          }
        }
        fileInputs.push({
          filePath: f.filePath,
          fileName,
          sizeBytes,
          ...(durationMs !== null ? { durationMs } : {}),
          parsed: r.ok ? r.value : null,
          parseError: r.ok ? null : { reason: r.reason, detail: r.detail },
          ...overridesToInput(f.overrides),
        })
      }

      const plan = buildImportPlan(fileInputs, canvas, { maxChapters: 2000 } satisfies PlanOptions)
      log?.info?.('audioImport.planBuilt', {
        event: 'audioImport.planBuilt',
        files: plan.summary.totalFiles,
        ready: plan.summary.readyFiles,
        needsReview: plan.summary.needsReviewFiles,
        totalLines: plan.summary.totalLines,
      })
      // 返回**契约形态**：IPC 只认扁平可序列化的普通对象
      return { plan: toContractPlan(plan), scan }
    },

    // ── ④ 执行导入 ───────────────────────────────────────────────────────────
    async applyImport(input) {
      const { canvas, scan, chapterIds } = await loadAndAlign(input)

      // 数据库侧的行（转成 LineRef）—— 与预览同一个选行函数
      const { noById } = await chapterMaps(input.bookId)
      const characterNameById = new Map<Id, string>()
      for (const c of scan.characters) characterNameById.set(c.id, c.name)

      /**
       * 角色名（归一化）→ CV 名。
       *
       * 数据来源是**文档角色表**（`【CV-角色】` 标记也能佐证，但角色表更权威：
       * 正文标记里出现过 `【无-xxx】` 这种脏数据）。
       * 同角色名若有多个 CV，取第一个并记日志 —— 那属于画本自身的不一致，
       * 不该让导入静默挑一个还不告诉用户。
       */
      const cvByCharacterName = new Map<string, string>()
      for (const r of canvas.roster) {
        if (!r.cv) continue
        const key = normalizeName(r.character)
        if (key.length === 0) continue
        const existing = cvByCharacterName.get(key)
        if (existing === undefined) {
          cvByCharacterName.set(key, r.cv)
        } else if (existing !== r.cv) {
          log?.warn?.('audioImport.characterHasMultipleCvs', {
            event: 'audioImport.characterHasMultipleCvs',
            character: r.character,
            kept: existing,
            ignored: r.cv,
            note: '画本角色表里同一角色对应了多个 CV；导入按第一个匹配',
          })
        }
      }

      const dbLines = await dbLinesAsRefs({
        bookId: input.bookId,
        chapterIds,
        chapterNoById: noById,
        characterNameById,
        cvByCharacterName,
      })

      // 按章节号分组，便于按「文件区间」过滤
      const linesByChapterNo = new Map<number, typeof dbLines>()
      for (const item of dbLines) {
        const list = linesByChapterNo.get(item.ref.chapterNo)
        if (list) list.push(item)
        else linesByChapterNo.set(item.ref.chapterNo, [item])
      }

      const result: AudioImportResult = {
        files: 0,
        createdTakes: 0,
        createdSegments: 0,
        markedRecorded: 0,
        skipped: [],
        perFile: [],
      }

      const only = input.onlyFiles ? new Set(input.onlyFiles) : null

      let processed = 0
      for (const f of input.files) {
        const fileName = basename(f.filePath)
        if (only && !only.has(fileName)) continue
        // 取消：每个文件开始前检查（见 `applyImport` 的 signal 说明）
        if (input.signal?.aborted) throw new AppError('TASK_CANCELLED')
        processed += 1
        input.onProgress?.(processed, input.files.length, fileName, 'copy')

        const perFile: AudioImportResult['perFile'][number] = {
          fileName,
          lineCount: 0,
          createdTakes: 0,
          error: null,
          // 默认值 = 「还没走切句」；真正跑完由 `splitForFile` 的结果覆盖
          splitMethod: 'none',
          sliceCount: 0,
          needsReview: 0,
        }
        result.perFile.push(perFile)
        result.files++

        try {
          const parsed = parseAudioFileName(fileName)
          const ov = overridesToInput(f.overrides)
          /**
           * 文件名解析不出来时**不再直接放弃**：用户在界面上填了章节区间 + 角色/CV，
           * 就按人工信息导入（真机需求：「解析不出的可以自己选择哪个 CV 或者角色」）。
           * 没有区间则仍然跳过 —— 没有区间就不知道这个文件覆盖哪些章，选不出行。
           */
          const manualRange = ov.fromChapter !== undefined && ov.toChapter !== undefined
          if (!parsed.ok && !manualRange) {
            perFile.error = `文件名无法解析：${parsed.detail}（可在该行「指定说话人」里手工填章节区间与角色/CV）`
            result.skipped.push({ fileName, reason: perFile.error })
            continue
          }

          // 时长同样要探测：take 的 srcOutMs/durationMs 依赖它（见 buildPlan 的注释）
          let fileDuration: number | null = input.durationByPath?.get(f.filePath) ?? null
          if (fileDuration === null && deps.probeDurationMs) {
            try {
              fileDuration = await deps.probeDurationMs(f.filePath)
            } catch {
              fileDuration = null
            }
          }
          const plan = buildImportPlan(
            [
              {
                filePath: f.filePath,
                fileName,
                parsed: parsed.ok ? parsed.value : null,
                parseError: parsed.ok ? null : { reason: parsed.reason, detail: parsed.detail },
                ...(fileDuration !== null ? { durationMs: fileDuration } : {}),
                ...ov,
              },
            ],
            canvas,
          )
          const filePlan = plan.files[0]
          // 有区间与目标即可导入（`parsed` 可以为 null —— 那是「人工填的区间」这条路）
          if (!filePlan || !filePlan.range || !filePlan.target) {
            perFile.error = '规划失败'
            result.skipped.push({ fileName, reason: perFile.error })
            continue
          }
          if (filePlan.status === 'invalid-name') {
            perFile.error = '文件名不符合命名约定'
            result.skipped.push({ fileName, reason: perFile.error })
            continue
          }
          if (filePlan.status === 'no-lines') {
            perFile.error = '该区间/说话人在画本里没有对应的行'
            result.skipped.push({ fileName, reason: perFile.error })
            continue
          }
          if (input.skipNeedsReview && filePlan.status === 'needs-review') {
            perFile.error = '需人工确认，已按设置跳过'
            result.skipped.push({ fileName, reason: perFile.error })
            continue
          }

          // 用同一套选行函数作用在**数据库行**上
          const span = clampSpan({ from: filePlan.range!.from, to: filePlan.range!.to }, 2000)
          const chapterSet = new Set<number>()
          for (let c = span.from; c <= span.to; c++) if (linesByChapterNo.has(c)) chapterSet.add(c)

          const matched = selectLinesForTarget(
            dbLines.map((d) => d.ref),
            filePlan.target!,
            chapterSet,
          )
          // 选行返回的是 ref；再按 (chapterNo, sourceLine) 找回数据库 id
          const byKey = new Map<string, (typeof dbLines)[number]>()
          for (const d of dbLines) byKey.set(`${d.ref.chapterNo}:${d.ref.sourceLine}`, d)

          perFile.lineCount = matched.length

          if (matched.length === 0) {
            perFile.error = '该说话人在这个区间内没有可写入的行'
            result.skipped.push({ fileName, reason: perFile.error })
            continue
          }

          // 落库：每个匹配行一条 take（整段引用同一个源文件；细切交给对轨）
          const ts = now()

          /**
           * **先把源文件落进项目一次**，再让所有 take 指向它。
           *
           * 为什么不按行各复制一份：真实样本「一个文件覆盖 74 章」，
           * 按行复制会产生几十上百份同样的副本（样本里最大的一个 30 MB）。
           * 一个导入文件复制一份，既满足「file_path 相对项目」的约定，
           * 又不浪费磁盘。
           *
           * 目标路径带时间戳前缀，避免两次导入同名文件互相覆盖；
           * 扩展名由 `copyAndVerifyAudio` 统一补成 `.wav`（WAV 原样复制 / 其它转码）。
           */
          const imported = await copyAndVerifyAudio({
            projectId: input.projectId,
            sourcePath: f.filePath,
            fileName,
            relativeTargetBase: `imports/${ts}-${sanitizeFileName(stripExtension(fileName))}`,
          })
          const importedRel = imported.relativePath
          // 转码/复制完成 → 进入最耗时的一步（解码 + 逐帧能量 + VAD + 铺行）
          input.onProgress?.(processed, input.files.length, fileName, 'split')

          /**
           * ── 切句：解码 → VAD → 把语音片铺满匹配到的行 ──────────────────────
           *
           * 用户明确要求「**切成每行一条 take**」（而不是整段）。见 docs/91 §5.2.49 ⑮。
           *
           * 顺序上必须放在 `copyAndVerifyAudio` **之后**：那一步保证了项目内的
           * 那一份一定是可读的 WAV，解码才有意义（直接解 mp3 需要另写解码器）。
           */
          const orderedHits: Array<(typeof dbLines)[number]> = []
          for (const ref of matched) {
            const hit = byKey.get(`${ref.chapterNo}:${ref.sourceLine}`)
            if (hit) orderedHits.push(hit)
          }
          const split = await splitForFile({
            absolutePath: imported.absolutePath,
            orderedHits,
            fallbackDurationMs: filePlan.durationMs ?? 0,
          })
          // 切句完成 → 进入写 take 阶段（按行写，通常很快，但行多时也要看得见）
          input.onProgress?.(processed, input.files.length, fileName, 'write')

          if (split.warnings.length > 0) {
            log?.warn?.('audioImport.splitWarning', {
              event: 'audioImport.splitWarning',
              fileName,
              method: split.method,
              warnings: split.warnings,
            })
          }

          // 回报给渲染进程：同一个 createdTakes 可能是「逐行切好」也可能是「整段」
          perFile.splitMethod = split.method
          perFile.sliceCount = split.sliceCount
          perFile.needsReview = split.needsReview.size

          /**
           * 解出来是**空音频** → 明确跳过这个文件，不写任何 take。
           *
           * 为什么不退回整段：那会写出 N 条指向空 WAV 的 take，
           * 界面显示「已导入 N 行」而每一行都是静音 —— 用户要到混音/导出才发现。
           * 跳过 + 一条说得清的 reason 才是如实回报。
           */
          if (split.method === 'empty') {
            perFile.error = '这段音频是空的（解出来 0 个采样），没有可导入的内容'
            result.skipped.push({ fileName, reason: perFile.error })
            continue
          }

          for (const ref of matched) {
            const hit = byKey.get(`${ref.chapterNo}:${ref.sourceLine}`)
            if (!hit) continue

            /**
             * `part_index` 从 **1** 开始（0 保留给「没有分段概念」的老数据）。
             *
             * ⚠️ `maxPartIndex` 在**空表时返回 -1**（内存实现如此，SQLite 的
             * `MAX()` 也返回 NULL）。直接 `+1` 会得到 0 —— 虽然 DDL 默认值是 0、
             * 不至于报错，但「第一条 take 的 partIndex 是 0」会让
             * 「按 partIndex 排序 === 录制顺序」这个约定从第一步就不成立。
             */
            const partIndex = Math.max(1, (await deps.takeRepo().maxPartIndex(hit.lineId)) + 1)
            /**
             * 这一行**已经有成品**了吗？有就不覆盖（人工/上次导入的选择优先）。
             *
             * ⚠️ 判断用「有没有 selected take」而不是「是不是第一条 take」：
             * 上一版（每文件只设一行）留下的 take 都是未选中的，
             * 用 `partIndex === 1` 会让这些行**永远补不上成品**，已录依旧是 0%。
             */
            const existingSelected = (await deps.takeRepo().listByLine(hit.lineId)).some((t) => t.isSelected)
            const takePk = newId('take')

            /**
             * 这一行在源音频里的区间。
             *
             * 拿到了（`method === 'vad' | 'whole-timeline'`）就是**逐行切好的**：
             * `srcIn/srcOut` 指向该行那一段。拿不到（解不了码 / 空音频）则退回整段，
             * 行为与上一版一致 —— 不因为切句不可用就让整个导入失败。
             */
            const range = split.rangeByLineId.get(hit.lineId) ?? null
            const srcIn = range ? range.startMs : 0
            const srcOut = range ? range.endMs : split.fallbackDurationMs
            const takeDuration = Math.max(0, srcOut - srcIn)
            const lowConfidence = split.needsReview.has(hit.lineId)

            const take: Take = {
              id: takePk,
              lineId: hit.lineId,
              sessionId: null,
              filePath: importedRel,
              partIndex,
              srcInMs: srcIn,
              srcOutMs: srcOut,
              trimmedInMs: 0,
              trimmedOutMs: takeDuration,
              durationMs: takeDuration,
              peakDb: null,
              rmsDb: null,
              lufs: null,
              gainDb: 0,
              format: { sampleRate: 48000, bitDepth: 16, channels: 1 },
              source: 'import',
              packageId: null,
              /**
               * `import-needs-review` 是给 UI 的信号：这条 take 的边界是**按比例硬切**的
               * （不是落在句子之间），导入后应当优先试听这几行。
               * 它不影响落库与成品设置 —— 有音频总比没有好，
               * 用户要的是「先能用，再挑错」，而不是「边界不确定就不导入」。
               */
              flags: lowConfidence ? ['imported', 'import-needs-review'] : ['imported'],
              isSelected: false,
              note: range
                ? `按说话人导入：${fileName}（第 ${srcIn}~${srcOut} ms）`
                : `按说话人导入：${fileName}（整段）`,
              recordedAt: ts,
              createdAt: ts,
            }
            await deps.takeRepo().insert(take)
            perFile.createdTakes++
            result.createdTakes++

            /**
             * **每一行**的第一条 take 自动设为成品（用户要的是「导入即成品」）。
             *
             * ⚠️ 这里原来是一个**每文件**的 `selectedOk` 开关：一个文件覆盖 168 行时
             * 只有第 1 行被设成品并标记 recorded，其余 167 行仍是「未录」——
             * 画本编辑里的「已录」因此永远停在 0%（真机故障）。
             *
             * 该行此前**没有成品**才自动设成品；已有成品的行（已录过/重叠导入）
             * 不覆盖用户的选择。
             */
            if (!existingSelected) {
              try {
                await materializeSegment(hit.lineId, take)
                await deps.takeRepo().setSelected(hit.lineId, takePk)
                result.createdSegments++

                /**
                 * 把画本行推进到 `recorded`。
                 *
                 * 真机事故 docs/91 §5.2.44 的教训：**有成品 = 这行录过了**，
                 * 少了这一步，界面上永远显示未录、章节进度恒为 0。
                 * 失败只记日志 —— 不能因为状态推进失败就把已经落好的 take 丢掉。
                 */
                if (deps.markLineRecorded) {
                  try {
                    await deps.markLineRecorded(hit.lineId)
                    result.markedRecorded++
                  } catch (e) {
                    log?.warn?.('audioImport.markRecordedFailed', {
                      event: 'audioImport.markRecordedFailed',
                      lineId: hit.lineId,
                      reason: e instanceof Error ? e.message : String(e),
                    })
                  }
                }
              } catch (e) {
                // 设成品失败不影响 take 已落库的事实；如实记日志
                log?.warn?.('audioImport.selectFailed', {
                  event: 'audioImport.selectFailed',
                  fileName,
                  lineId: hit.lineId,
                  reason: e instanceof Error ? e.message : String(e),
                })
              }
            }
          }

          if (perFile.createdTakes === 0) {
            perFile.error = '匹配到行但一条 take 都没写入（行可能已被删除）'
            result.skipped.push({ fileName, reason: perFile.error })
          }

          log?.info?.('audioImport.fileImported', {
            event: 'audioImport.fileImported',
            fileName,
            matchedLines: perFile.lineCount,
            createdTakes: perFile.createdTakes,
            /**
             * 切句结果必须出现在日志里。
             *
             * 「导入成功」有两种完全不同的质量：逐行精确切分（`vad`）与
             * 按比例硬切（`whole-timeline`）。只看「写入 N 条 take」是分不出来的，
             * 而用户听到的差别很大。所以要打 `splitMethod` / `sliceCount` /
             * `needsReview` 三个字段。
             */
            splitMethod: split.method,
            sliceCount: split.sliceCount,
            needsReview: split.needsReview.size,
            durationMs: split.fallbackDurationMs,
          })
        } catch (e) {
          // 单个文件失败不能中断整批：把原因记进 perFile 并继续
          perFile.error = e instanceof AppError ? e.key : e instanceof Error ? e.message : String(e)
          result.skipped.push({ fileName, reason: perFile.error })
          log?.error?.('audioImport.fileFailed', {
            event: 'audioImport.fileFailed',
            fileName,
            reason: perFile.error,
          })
        }
      }

      log?.info?.('audioImport.done', {
        event: 'audioImport.done',
        files: result.files,
        createdTakes: result.createdTakes,
        createdSegments: result.createdSegments,
        skipped: result.skipped.length,
      })
      return result
    },
  }

  /**
   * 把一条 take 设为成品（与 `take.service.ts` 同语义：先拷文件、再写 segment）。
   *
   * ⚠️ 这里**不复制音频文件**：本阶段的 take 只记录「来自哪个导入文件的哪一段」，
   *   源文件由调用方负责落到 `rootDir`。真正的成品文件拷贝在
   *   「对轨/处理」链路里做（那时才有精确的 in/out 区间）。
   *   这是本阶段的**已知简化**，记在 docs/91 §5.2.49 的未完成清单里。
   */
  async function materializeSegment(lineId: Id, take: Take): Promise<VoiceSegment | null> {
    const chapterId = await deps.lineChapterId(lineId)
    if (!chapterId) return null
    const ts = now()
    const seg: VoiceSegment = {
      id: newId('seg'),
      lineId,
      chapterId,
      takeId: take.id,
      filePath: take.filePath,
      processedPath: null,
      presetHash: null,
      srcInMs: take.srcInMs,
      srcOutMs: take.srcOutMs,
      durationMs: take.durationMs,
      peakDb: take.peakDb,
      rmsDb: take.rmsDb,
      lufs: null,
      flags: take.flags,
      createdAt: ts,
      updatedAt: ts,
    }
    await deps.segmentRepo().upsertByLine(seg)
    return seg
  }
}

// ---------------------------------------------------------------------------
// 供 ports.ts 复用：ffmpeg 探测（拿不到就返回 null，绝不抛错）
// ---------------------------------------------------------------------------

/**
 * 用 ffprobe 探测音频时长。
 *
 * ⚠️ ffmpeg 不可用时必须**返回 null 而不是抛错**：
 *   「按说话人导入」的核心价值是把文件对应到画本行，**时长只是展示信息**。
 *   若因为没装 ffmpeg 就整批导入失败，那是把可选能力当成了必需依赖。
 */
export function createDurationProbe(ffmpeg: FfmpegRunner): (filePath: string) => Promise<number | null> {
  return async (filePath: string): Promise<number | null> => {
    try {
      // ⚠️ 命令由 `buildDurationProbeCommand` 产出，第一项是 `'ffprobe'` ——
      // 这里曾经手写参数数组且**漏了程序名**（从 `-v` 开始），spawn 直接 ENOENT，
      // 又被下面的 catch 吞成 null，于是「非 WAV 导入时长」永远是空且不报错。
      const res = await ffmpeg.execute(buildDurationProbeCommand({ file: filePath }))
      if (res.exitCode !== 0) return null
      const seconds = Number(String(res.stdout ?? '').trim())
      if (!Number.isFinite(seconds) || seconds <= 0) return null
      return Math.round(seconds * 1000)
    } catch {
      return null
    }
  }
}
