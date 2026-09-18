/**
 * Novel Studio · 导出向导态（docs/15 §5.5 八步向导）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §5.1 —— 分章导出（MP3 / WAV / M4A）
 *   · docs/15 §5.2 —— 整本合并 M4B（章数上限 200、单文件 24 h、按卷拆分）
 *   · docs/15 §5.3 —— 命名与目录：模板 → `buildFileNames` 预览（与主进程同口径）
 *   · docs/15 §5.4 —— 断点续传（同 paramsHash 已完成的章 skip）
 *   · docs/15 §5.5 —— 八步向导：范围 / 输出 / 混音方案 / 响度 / 元数据 / 预检 / 执行 / 报告
 *   · docs/15 §11  —— 磁盘空间预估（中间混音 WAV ≈ 时长 × 288 KB/s）
 *
 * 四条纪律：
 *   1. **向导态只在本 store**：组件之间不互相传状态，前进/后退都不丢数据
 *      （用户在第 4 步改完响度再回第 2 步改格式，第 4 步的选择必须还在）。
 *   2. 首次进入时用 `settings.export` / `settings.mixing` 初始化；之后**以用户改动为准**，
 *      不再被设置页变更覆盖（否则改了一半的参数会被设置页改动冲掉）。
 *   3. 任何影响导出结果的参数变化 → 立刻作废预检结果（`qc.invalidate()`），
 *      避免「用旧预检结果导出新参数」（docs/15 §6.1 的前提是「渲染前」）。
 *   4. 本 store **不 import 混音台的任何 store/组件**（混音方案只经 IPC
 *      `mix:listProjects` / `mix:get` 获取），保证与混音台工作流解耦。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { getMessage } from '@shared/messages.ts'
import type { ResolvedMessage } from '@shared/messages.ts'
import { EXPORT_DEFAULTS, LOUDNESS_TARGETS, VAD_DEFAULTS } from '@shared/constants.ts'
import type {
  Chapter,
  ChapterProgress,
  ExportChapterResult,
  ExportFormat,
  ExportMetadata,
  ExportOverwrite,
  ExportParams,
  ExportReport,
  Id,
  LoudnessMeasurement,
  MixProject,
} from '@shared/types.ts'
import type { IpcReq, IpcRes } from '@shared/ipc.ts'
import { call, callCollecting, callSafe } from '@/shared/lib/ipc.ts'
import { cloneForIpc } from '@/shared/lib/clone.ts'
import { reportBatchFailures } from '@/shared/lib/error-bus.ts'
import {
  DEFAULT_CHAPTER_TITLE_TEMPLATE,
  DEFAULT_FILE_NAME_TEMPLATE,
  buildChapterTitle,
  buildFileNames,
  emptyPlaceholders,
  unknownPlaceholders,
} from '@/shared/lib/template.ts'
import type { FileNamePreview, TemplateContext } from '@/shared/lib/template.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useQcStore } from './qc.store.ts'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** `chapter:list` 的行（章节 + 进度概览） */
export type ExportChapterRow = Chapter & { progress: ChapterProgress | null }

/** Step 1 范围 */
export type ExportRangeMode = 'current' | 'selected' | 'book'

/** Step 2/5 的 M4B 专属选项（码率与拆分数在 ExportParams 里，见 M4bOptionsPanel） */
export interface M4bWizardState {
  /** 是否在分章导出之后再合并一个 M4B（docs/15 §5.2） */
  enabled: boolean
  /**
   * 章节标记标题模板（默认 `第{index}章 {title}`）。
   * ⚠️ 契约缺口：`ExportParams` 里没有这个字段，主进程若用自己的默认值，
   * 渲染侧预览与成品章节名可能不一致（已在交付报告中标注）。1.0 里它与
   * `settings.export.chapterTitleTemplate` 同源，因此只要用户不改设置就是一致的。
   */
  chapterTitleTemplate: string
  /** 章首标题念白（docs/15 §7：1.0 靠画本里插一行标题念白实现） */
  titleReading: boolean
}

/** Step 3 全书范围下的逐章方案汇总（按章抽样统计，避免 120 次 IPC 打满） */
export interface MixSummaryEntry {
  chapterId: Id
  chapterTitle: string
  projectName: string
  trackCount: number
  voiceCount: number
  musicCount: number
  sfxCount: number
  hasBgm: boolean
  targetLufs: number
  arrangementId: Id
}

export interface MixSummary {
  /** 参与抽样的章数 */
  sampled: number
  /** 目标章总数（全书范围） */
  total: number
  /** 有混音方案的章数 */
  withProjects: number
  /** 没有任何混音方案的章（= MIX_ARRANGEMENT_EMPTY 语义） */
  withoutProjects: number
  /** 方案里没有可用人声轨的章（= MIX_NO_VOICE_TRACK 语义） */
  noVoiceTrack: number
  /** 有 BGM 的章数 */
  withBgm: number
  entries: MixSummaryEntry[]
}

/** 混音方案的诊断结论（UI 文案一律取自消息表，不在组件里自拼） */
export type MixDiagnosis = 'unknown' | 'ok' | 'empty' | 'no_voice_track'

/** 每章的预估产物（命名预览 + 时长） */
export interface ChapterPlanItem {
  chapterId: Id
  chapterIndex: number
  /** 章节原始标题（命名模板的 `{chapterTitle}` 用它） */
  chapterTitle: string
  /** M4B 章节标记标题（`buildChapterTitle(chapterTitleTemplate)`） */
  m4bTitle: string
  volumeTitle: string | null
  durationMs: number
  preview: FileNamePreview
}

/** M4B 章数告警阈值（docs/15 §5.2：> 200 章建议按卷拆分） */
export const M4B_CHAPTER_WARN_THRESHOLD = EXPORT_DEFAULTS.m4bChapterWarnThreshold
/** 全书范围下汇总混音方案时的抽样上限（IPC 是按章查询的，不抽样会打满主进程） */
export const MIX_SUMMARY_SAMPLE_LIMIT = 30
/** 命名模板预览的条数上限（太多会拖慢第一步的渲染） */
export const NAME_PREVIEW_LIMIT = 8

/** 采样率 → WAV 每秒字节数（24 bit 单声道，docs/15 §5.1 `-c:a pcm_s24le`） */
function wavBytesPerSecond(sampleRate: number): number {
  return sampleRate * 3
}

/** 码率（kbps）→ 每秒字节数 */
function bitrateBytesPerSecond(kbps: number): number {
  return (kbps * 1000) / 8
}

/** 依据目标响度取 LRA 默认值（LOUDNESS_TARGETS 三档；自定义则沿用最近一档或 11） */
function lraForTarget(targetLufs: number): number {
  const hit = LOUDNESS_TARGETS.find(t => t.lufs === targetLufs)
  if (hit) return hit.lra
  // 自定义目标：按「越响动态越小」的常识给一个保守值
  if (targetLufs >= -14) return 11
  if (targetLufs <= -23) return 15
  return 11
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useExportStore = defineStore('mixing/export', () => {
  /** 预检结果与「已知悉」集合放在 qc.store（同功能域，允许互相引用） */
  const qc = useQcStore()
  /** 只读应用级会话上下文（当前书/章/路径）；写操作一律走 IPC */
  const session = useSessionStore()
  /** 范围默认值只初始化一次（否则每次 bootstrap 都会覆盖用户在第 1 步的选择） */
  let initializedRange = false

  // ── 向导框架 ─────────────────────────────────────────────────────────────
  /** 当前步骤 1~8（docs/15 §5.5） */
  const step = ref(1)
  /** 已到达过的最大步骤（el-steps 只允许点回已走过的步骤，避免跳过预检） */
  const maxVisitedStep = ref(1)
  /** 是否已用设置初始化过参数（初始化只做一次，「后退不丢数据」的前提） */
  const initialized = ref(false)

  // ── 书籍与章节 ───────────────────────────────────────────────────────────
  const bookId = ref<Id | null>(null)
  const bookTitle = ref('')
  const author = ref('')
  const narrator = ref('')
  const chapters = ref<ExportChapterRow[]>([])
  const chaptersLoading = ref(false)
  /** 书籍上下文是否已就绪（bootstrap 完成） */
  const ready = ref(false)

  // ── Step 1：范围 ─────────────────────────────────────────────────────────
  const rangeMode = ref<ExportRangeMode>('book')
  const selectedChapterIds = ref<Id[]>([])

  // ── Step 2/4/5：导出参数 ─────────────────────────────────────────────────
  const params = ref<ExportParams>(createDefaultParams())
  /** 是否写入元数据标签（`settings.export.writeMetadata`；不属于 ExportParams） */
  const writeMetadata = ref(true)
  /** MP3 的 VBR 质量档（`export:vbrPresets` 拉取；ExportParams 无对应字段，仅作参考展示） */
  const vbrPresets = ref<Array<{ label: string; value: number }>>([])
  const vbrLoading = ref(false)

  // ── Step 2/5：M4B ───────────────────────────────────────────────────────
  const m4b = ref<M4bWizardState>({
    enabled: false,
    chapterTitleTemplate: DEFAULT_CHAPTER_TITLE_TEMPLATE,
    titleReading: false,
  })

  // ── Step 3：混音方案 ─────────────────────────────────────────────────────
  const mixProjects = ref<MixProject[]>([])
  const mixProject = ref<MixProject | null>(null)
  const mixProjectId = ref<Id | null>(null)
  /** false = 不使用混音方案（纯干声导出） */
  const useMixProject = ref(true)
  const mixLoading = ref(false)
  const mixSummary = ref<MixSummary | null>(null)
  const mixDiagnosis = ref<MixDiagnosis>('unknown')

  // ── Step 4：响度测量（两遍法的第一遍，docs/15 §4） ───────────────────────
  const measurement = ref<LoudnessMeasurement | null>(null)
  const measuring = ref(false)
  /** 被测量的参考文件（用户选的文件或最近一次渲染结果） */
  const measuredPath = ref<string | null>(null)

  // ── Step 7/8：任务与报告 ─────────────────────────────────────────────────
  const taskId = ref<Id | null>(null)
  const jobId = ref<Id | null>(null)
  const report = ref<ExportReport | null>(null)
  const reportLoading = ref(false)
  /** 报告 JSON 的另存目标路径（app:saveFileDialog 选择） */
  const reportSavePath = ref<string | null>(null)
  /** 参数版本号：每次影响导出结果的改动 +1（用于展示「预检已作废」） */
  const paramsVersion = ref(0)

  // ── 默认参数 ─────────────────────────────────────────────────────────────

  function createDefaultParams(): ExportParams {
    return {
      format: 'mp3',
      mp3Bitrate: EXPORT_DEFAULTS.mp3Bitrate,
      m4bBitrate: EXPORT_DEFAULTS.m4bBitrate,
      sampleRate: EXPORT_DEFAULTS.mp3SampleRate,
      targetLufs: -16,
      truePeakDb: EXPORT_DEFAULTS.truePeakDb,
      lra: lraForTarget(-16),
      headSilenceMs: EXPORT_DEFAULTS.headSilenceMs,
      tailSilenceMs: EXPORT_DEFAULTS.tailSilenceMs,
      outputDir: '',
      fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
      metadata: { genre: 'Audiobook' },
      overwrite: 'skip',
      splitM4bEvery: 0,
    }
  }

  /**
   * 用设置与书籍信息初始化向导默认值（docs/15 §5.5 Step 2/4/5）。
   * `force = true` 时用于「恢复默认」（会丢掉用户改动，必须由用户显式触发）。
   */
  function initFromSettings(force = false): void {
    if (initialized.value && !force) return
    const settings = useSettingsStore()
    const ex = settings.settings?.export
    const mx = settings.settings?.mixing
    const book = session.book

    const targetLufs = typeof mx?.targetLufs === 'number' ? mx.targetLufs : -16
    params.value = {
      format: ex?.format ?? 'mp3',
      mp3Bitrate: ex?.mp3Bitrate ?? EXPORT_DEFAULTS.mp3Bitrate,
      m4bBitrate: ex?.m4bBitrate ?? EXPORT_DEFAULTS.m4bBitrate,
      sampleRate: EXPORT_DEFAULTS.mp3SampleRate,
      targetLufs,
      truePeakDb: typeof mx?.truePeakDb === 'number' ? mx.truePeakDb : EXPORT_DEFAULTS.truePeakDb,
      lra: lraForTarget(targetLufs),
      headSilenceMs: typeof mx?.headSilenceMs === 'number' ? mx.headSilenceMs : EXPORT_DEFAULTS.headSilenceMs,
      tailSilenceMs: typeof mx?.tailSilenceMs === 'number' ? mx.tailSilenceMs : EXPORT_DEFAULTS.tailSilenceMs,
      outputDir: session.paths?.exportDir ?? settings.settings?.paths.exportDir ?? '',
      fileNameTemplate: ex?.fileNameTemplate ?? DEFAULT_FILE_NAME_TEMPLATE,
      metadata: {
        // docs/15 §5.1 的元数据模板：title={chapterTitle} album={bookTitle} artist={author}
        title: '{chapterTitle}',
        artist: book?.author ?? '',
        album: book?.title ?? '',
        narrator: book?.narrator ?? '',
        genre: 'Audiobook',
        date: String(new Date().getFullYear()),
        coverPath: ex?.coverPath ?? book?.coverPath ?? null,
      },
      overwrite: 'skip',
      splitM4bEvery: ex?.splitM4bEvery ?? 0,
    }
    writeMetadata.value = ex?.writeMetadata ?? true
    m4b.value = {
      enabled: false,
      chapterTitleTemplate: ex?.chapterTitleTemplate ?? DEFAULT_CHAPTER_TITLE_TEMPLATE,
      titleReading: false,
    }
    initialized.value = true
    paramsVersion.value += 1
  }

  /** 进入向导时调用一次：加载设置、路径、书籍与章节 */
  async function bootstrap(): Promise<void> {
    const settings = useSettingsStore()

    try {
      await settings.load()
      await session.loadPaths()
      const id = session.bookId
      bookId.value = id
      if (id && session.book?.id !== id) await session.ensureBook(id)

      bookTitle.value = session.book?.title ?? ''
      author.value = session.book?.author ?? ''
      narrator.value = session.book?.narrator ?? ''

      initFromSettings()

      if (id) {
        await loadChapters(id)
        // 默认范围：整本（导出向导最常见的用法）；单章书退回「当前章」
        if (!initializedRange) {
          rangeMode.value = chapters.value.length > 1 ? 'book' : 'current'
          initializedRange = true
        }
        if (rangeMode.value === 'current' && session.chapterId) {
          selectedChapterIds.value = [session.chapterId]
        }
      }
    } catch {
      // 失败已由 error-bus 兑现（例如书籍已被删除）；这里只保证界面能起来
    } finally {
      ready.value = true
      void loadVbrPresets()
    }
  }

  /** 拉取章节列表（Step 1 的多选、Step 2 的命名预览、Step 6 的范围统计都要用） */
  async function loadChapters(id: Id): Promise<void> {
    chaptersLoading.value = true
    try {
      const rows = await call('chapter:list', { bookId: id }) as IpcRes<'chapter:list'>
      chapters.value = rows
    } catch {
      // 失败已由 error-bus 兑现；保持空列表，UI 会显示空态
      chapters.value = []
    } finally {
      chaptersLoading.value = false
    }
  }

  // ── 派生：范围与计划 ─────────────────────────────────────────────────────

  /** 本次导出的章节 id（按章节顺序，去重） */
  const targetChapterIds = computed<Id[]>(() => {
    if (rangeMode.value === 'book') return chapters.value.map(c => c.id)
    if (rangeMode.value === 'current') {
      const id = session.chapterId
      return id ? [id] : []
    }
    const picked = new Set(selectedChapterIds.value)
    return chapters.value.filter(c => picked.has(c.id)).map(c => c.id)
  })

  const targetChapterRows = computed<ExportChapterRow[]>(() => {
    const ids = new Set(targetChapterIds.value)
    return chapters.value.filter(c => ids.has(c.id))
  })

  const targetChapterCount = computed(() => targetChapterIds.value.length)

  const isBookScope = computed(() => rangeMode.value === 'book')

  /** 当前章是否在已加载的章节列表里（不在时要提示「章节不属于当前书」） */
  const currentChapterMissing = computed(() =>
    rangeMode.value === 'current' && session.chapterId !== null && !chapters.value.some(c => c.id === session.chapterId),
  )

  /** 单章预估时长：优先用已录音频时长，否则按字数 ÷ 语速估算（docs/05 §4 的 4.2 字/秒） */
  function estimateChapterDurationMs(row: ExportChapterRow): number {
    const audioMs = row.progress?.audioMs ?? 0
    if (audioMs > 0) return audioMs + params.value.headSilenceMs + params.value.tailSilenceMs
    const chars = row.progress?.charCount ?? row.charCount
    return Math.round((chars / VAD_DEFAULTS.charsPerSecond) * 1000)
      + params.value.headSilenceMs
      + params.value.tailSilenceMs
  }

  /** 合计预估时长（Step 1 的「预估时长」） */
  const estimatedDurationMs = computed(() =>
    targetChapterRows.value.reduce((sum, row) => sum + estimateChapterDurationMs(row), 0),
  )

  /** 预估成品体积（按格式与码率；用于 Step 2 的提示） */
  const estimatedOutputBytes = computed(() => {
    const seconds = estimatedDurationMs.value / 1000
    const p = params.value
    if (p.format === 'wav') return seconds * wavBytesPerSecond(p.sampleRate)
    if (p.format === 'm4a') return seconds * bitrateBytesPerSecond(p.m4bBitrate)
    return seconds * bitrateBytesPerSecond(p.mp3Bitrate)
  })

  /** 预估中间文件占用（docs/15 §11：混音中间 WAV ≈ 时长 × 288 KB/s，逐章串行可复用） */
  const estimatedTempBytes = computed(() => {
    const maxChapterMs = targetChapterRows.value.reduce((max, row) => Math.max(max, estimateChapterDurationMs(row)), 0)
    return (maxChapterMs / 1000) * 288 * 1024
  })

  /** 命名模板的上下文（docs/15 §5.3 占位符） */
  const templateContext = computed<Omit<TemplateContext, 'chapterIndex' | 'chapterTitle' | 'volumeTitle'> & { ext?: string }>(() => ({
    bookTitle: bookTitle.value,
    author: author.value,
    narrator: narrator.value,
    date: new Date(),
    format: params.value.format,
    totalChapters: targetChapterCount.value || chapters.value.length,
    ext: params.value.format,
  }))

  /**
   * Step 2 的文件名实时预览：与主进程同口径（同一个 `buildFileNames`）。
   * 只预览前 `NAME_PREVIEW_LIMIT` 章 —— 120 章的表格在向导里没人看，
   * 但前几章足以暴露「模板写错」「占位符为空」这两类问题。
   */
  const namePreviews = computed<FileNamePreview[]>(() =>
    buildFileNames(
      params.value.fileNameTemplate,
      targetChapterRows.value.slice(0, NAME_PREVIEW_LIMIT).map((row, index) => ({
        chapterIndex: index + 1,
        chapterTitle: row.title,
        volumeTitle: row.volumeTitle,
      })),
      templateContext.value,
    ),
  )

  /** 模板里写错的占位符（黄色提示，不阻断） */
  const unknownTokens = computed(() => unknownPlaceholders(params.value.fileNameTemplate))

  /** 模板里「值为空将留白」的占位符（例如没填旁白人时的 `{narrator}`） */
  const emptyTokens = computed(() => {
    const first = namePreviews.value[0]
    if (!first) return [] as string[]
    return emptyPlaceholders(params.value.fileNameTemplate, {
      ...templateContext.value,
      chapterIndex: 1,
      chapterTitle: targetChapterRows.value[0]?.title ?? '',
      volumeTitle: targetChapterRows.value[0]?.volumeTitle ?? null,
    })
  })

  /** 逐章计划（命名预览 + 时长）：报告面板与「磁盘空间提示」共用 */
  const chapterPlan = computed<ChapterPlanItem[]>(() => {
    const previews = buildFileNames(
      params.value.fileNameTemplate,
      targetChapterRows.value.map((row, index) => ({
        chapterIndex: index + 1,
        chapterTitle: row.title,
        volumeTitle: row.volumeTitle,
      })),
      templateContext.value,
    )
    return targetChapterRows.value.map((row, index) => ({
      chapterId: row.id,
      chapterIndex: index + 1,
      chapterTitle: row.title,
      m4bTitle: buildChapterTitle(m4b.value.chapterTitleTemplate, { index: index + 1, title: row.title }),
      volumeTitle: row.volumeTitle,
      durationMs: estimateChapterDurationMs(row),
      preview: previews[index] as FileNamePreview,
    }))
  })

  /** M4B 章节标记预览（前几章，docs/15 §5.2 章节标记来源） */
  const m4bChapterPreview = computed(() =>
    targetChapterRows.value.slice(0, 5).map((row, index) => buildChapterTitle(
      m4b.value.chapterTitleTemplate,
      { index: index + 1, title: row.title },
    )),
  )

  /** 按卷拆分时建议的每卷章数（按卷统计的最大卷章数，取整到 10） */
  const suggestedSplitEvery = computed(() => {
    const byVolume = new Map<number, number>()
    for (const row of targetChapterRows.value) {
      const key = row.volumeSeq ?? 0
      byVolume.set(key, (byVolume.get(key) ?? 0) + 1)
    }
    const max = Math.max(0, ...byVolume.values())
    if (max <= 0) return 0
    return Math.max(10, Math.ceil(max / 10) * 10)
  })

  // ── 派生：M4B 警示（文案取自消息表） ────────────────────────────────────

  /** > 200 章 → EXPORT_M4B_TOO_MANY_CHAPTERS */
  const m4bTooManyChapters = computed(() => m4b.value.enabled && targetChapterCount.value > M4B_CHAPTER_WARN_THRESHOLD)

  /**
   * 单文件超过 24 h（docs/15 §5.2 总时长上限）。
   * ⚠️ 消息表里没有「M4B 时长超限」的语义键（只有章节数超限），
   * 因此这里只给**事实型**提示（由 M4bOptionsPanel 展示时长与上限），
   * 不去借用 `EXPORT_M4B_VERIFY_FAILED` 之类语义不符的文案。
   */
  const m4bTooLong = computed(() => m4b.value.enabled && estimatedDurationMs.value > EXPORT_DEFAULTS.m4bMaxHours * 3_600_000)

  /** 单文件时长上限（小时，docs/15 §5.2） */
  const m4bMaxHours = EXPORT_DEFAULTS.m4bMaxHours

  const m4bChapterWarning = computed<ResolvedMessage | null>(() => {
    if (!m4bTooManyChapters.value) return null
    return getMessage('EXPORT_M4B_TOO_MANY_CHAPTERS', {
      count: targetChapterCount.value,
      per: suggestedSplitEvery.value || Math.ceil(targetChapterCount.value / 2),
    })
  })

  // ── 派生：混音方案 ───────────────────────────────────────────────────────

  /** 本次导出实际用到的混音方案 id（全书范围一律 null：各章用自己的默认方案） */
  const effectiveMixProjectId = computed<Id | null>(() => {
    if (isBookScope.value) return null
    if (!useMixProject.value) return null
    return mixProjectId.value
  })

  /** 混音方案诊断结论的文案（MIX_ARRANGEMENT_EMPTY / MIX_NO_VOICE_TRACK，来自消息表） */
  const mixDiagnosisMessage = computed<ResolvedMessage | null>(() => {
    if (!useMixProject.value) return null
    if (mixDiagnosis.value === 'empty') return getMessage('MIX_ARRANGEMENT_EMPTY')
    if (mixDiagnosis.value === 'no_voice_track') return getMessage('MIX_NO_VOICE_TRACK')
    return null
  })

  /** 选中方案的摘要（轨道数、目标响度、是否有 BGM） */
  const mixDetail = computed(() => {
    const project = mixProject.value
    if (!project) return null
    const voice = project.tracks.filter(t => t.kind === 'voice')
    const music = project.tracks.filter(t => t.kind === 'music')
    const sfx = project.tracks.filter(t => t.kind === 'sfx')
    return {
      name: project.name,
      isDefault: project.isDefault,
      arrangementId: project.arrangementId,
      version: project.version,
      trackCount: project.tracks.length,
      voiceCount: voice.length,
      musicCount: music.length,
      sfxCount: sfx.length,
      mutedCount: project.tracks.filter(t => t.isMute).length,
      hasBgm: music.some(t => t.music !== null),
      targetLufs: project.master.targetLufs,
      truePeakDb: project.master.truePeakDb,
      limiterEnabled: project.master.limiterEnabled,
      sampleRate: project.master.sampleRate,
      headSilenceMs: project.headSilenceMs,
      tailSilenceMs: project.tailSilenceMs,
      /** 有 solo 的轨：solo 会静音其他轨，侧链源必须仍然有效（docs/15 §3.1） */
      soloCount: project.tracks.filter(t => t.isSolo).length,
    }
  })

  // ── 派生：响度 ───────────────────────────────────────────────────────────

  /** 实测与目标之间的建议增益（两遍法的 Pass 2：gainDb = target_I - input_i，docs/15 §4） */
  const suggestedGainDb = computed<number | null>(() => {
    const m = measurement.value
    if (!m || !Number.isFinite(m.inputI)) return null
    return params.value.targetLufs - m.inputI
  })

  /** 素材是否近乎静音（input_i = -inf → 该章会被阻断，docs/15 §11） */
  const measurementSilent = computed(() => measurement.value !== null && !Number.isFinite(measurement.value.inputI))

  /**
   * 目标响度与真峰是否冲突（→ MIX_TARGET_CONFLICT）。
   * 判据（docs/15 §11）：要把素材提升/压限超过 6 dB，说明目标远超素材的实际电平，
   * 限幅器会很吃力；或目标响度已经很响（≥ -14）却又要一个很高的真峰上限。
   */
  const targetConflict = computed(() => {
    const p = params.value
    if (p.truePeakDb > -1 && p.targetLufs >= -14) return true
    const gain = suggestedGainDb.value
    if (gain !== null && Math.abs(gain) > 6) return true
    const m = measurement.value
    if (m && Number.isFinite(m.inputTp) && p.truePeakDb > m.inputTp + 6) return true
    return false
  })

  // ── Step 门槛与提示 ─────────────────────────────────────────────────────

  /** 当前步骤未满足的条件（每一条都是一句可执行的指引） */
  const stepIssues = computed<string[]>(() => {
    const issues: string[] = []
    const p = params.value
    switch (step.value) {
      case 1:
        if (targetChapterCount.value === 0) issues.push('请至少选择一章用于导出')
        if (currentChapterMissing.value) issues.push('当前章节不属于已加载的书籍，请回到章节列表重新选择')
        break
      case 2:
        if (!p.outputDir) issues.push('请选择输出目录')
        if (!p.fileNameTemplate.trim()) issues.push('文件命名模板不能为空')
        // 未知占位符只提示、不阻断（docs/15 §5.3：未知占位符原样保留，用户能一眼看出写错了）
        if (p.format === 'wav' && estimatedOutputBytes.value > 4 * 1024 * 1024 * 1024) {
          issues.push('WAV 是未压缩格式，本次预估体积超过 4 GB，建议改用 MP3 或 M4A')
        }
        break
      case 3:
        if (useMixProject.value && !isBookScope.value && !mixProjectId.value) {
          issues.push('请选择一个混音方案，或勾选「不使用混音方案（纯干声）」')
        }
        if (mixDiagnosis.value === 'no_voice_track') issues.push('该混音方案里没有可用的人声轨，导出会得到近似静音的结果')
        break
      case 4:
        if (!Number.isFinite(p.targetLufs)) issues.push('目标响度必须是数字')
        if (p.truePeakDb >= 0) issues.push('真峰上限必须小于 0 dBTP')
        if (p.headSilenceMs < 0 || p.tailSilenceMs < 0) issues.push('头尾静音不能为负数')
        break
      case 5:
        if (!writeMetadata.value) break
        if (!p.metadata.title?.trim() && !p.metadata.album?.trim()) issues.push('未填写标题与专辑名，成品在播放器里会显示为文件名')
        break
      case 6:
        if (!qc.canProceed) issues.push('请先完成预检，并处理全部阻断项、确认全部警告')
        break
      case 7:
        if (!taskId.value) issues.push('还没有开始导出任务')
        break
      case 8:
        if (!report.value) issues.push('还没有可查看的导出报告')
        break
      default:
        break
    }
    return issues
  })

  const canProceed = computed(() => stepIssues.value.length === 0)

  const stepTitles = [
    '范围',
    '输出',
    '混音方案',
    '响度',
    '元数据与封面',
    '预检报告',
    '执行',
    '完成报告',
  ] as const

  const stepTitle = computed(() => stepTitles[step.value - 1] ?? '')

  /** 范围摘要（顶栏与报告都用） */
  const rangeLabel = computed(() => {
    if (rangeMode.value === 'book') return `全书 ${targetChapterCount.value} 章`
    if (rangeMode.value === 'current') return '当前章'
    return `选定 ${targetChapterCount.value} 章`
  })

  // ── 动作：向导导航 ───────────────────────────────────────────────────────

  /**
   * 前后步导航。**任何一步都不清理数据**：所有选择都留在本 store 里，
   * 「后退不丢数据」靠的是「状态只有一个来源」而不是快照/回滚。
   */
  function goToStep(next: number): void {
    const target = Math.min(8, Math.max(1, Math.trunc(next)))
    // 只允许回到已走过的步骤，或前进一步（预检不能跳过）
    if (target > maxVisitedStep.value + 1) return
    step.value = target
    if (target > maxVisitedStep.value) maxVisitedStep.value = target
    // 进入第 6 步时，若参数已变更（预检被作废），提示需要重跑由面板负责
  }

  function nextStep(): void {
    if (!canProceed.value) return
    goToStep(step.value + 1)
  }

  function prevStep(): void {
    goToStep(step.value - 1)
  }

  /** 回到第一步重新配置（Step 8 的「再次导出」） */
  function restartWizard(): void {
    step.value = 1
    maxVisitedStep.value = Math.max(1, maxVisitedStep.value)
    taskId.value = null
    jobId.value = null
    report.value = null
    reportSavePath.value = null
    qc.clearVerify()
  }

  // ── 动作：Step 1 范围 ────────────────────────────────────────────────────

  function setRangeMode(mode: ExportRangeMode): void {
    rangeMode.value = mode
    if (mode === 'current') {
      const id = session.chapterId
      selectedChapterIds.value = id ? [id] : []
    }
    // 切到「选定章」时默认全选：用户通常是「去掉几章」而不是「从零挑 120 章」
    if (mode === 'selected' && selectedChapterIds.value.length === 0) {
      selectedChapterIds.value = chapters.value.map(c => c.id)
    }
  }

  function toggleChapter(id: Id, selected?: boolean): void {
    const has = selectedChapterIds.value.includes(id)
    const want = selected ?? !has
    if (want && !has) selectedChapterIds.value = [...selectedChapterIds.value, id]
    if (!want && has) selectedChapterIds.value = selectedChapterIds.value.filter(x => x !== id)
  }

  function selectAllChapters(): void {
    selectedChapterIds.value = chapters.value.map(c => c.id)
  }

  function invertSelection(): void {
    const picked = new Set(selectedChapterIds.value)
    selectedChapterIds.value = chapters.value.filter(c => !picked.has(c.id)).map(c => c.id)
  }

  function clearSelection(): void {
    selectedChapterIds.value = []
  }

  /** 按卷选择（volumeSeq 为 null 的章归入「无卷」分组） */
  function selectByVolume(volumeSeq: number | null, selected = true): void {
    const ids = chapters.value.filter(c => (c.volumeSeq ?? null) === volumeSeq).map(c => c.id)
    const picked = new Set(selectedChapterIds.value)
    if (selected) for (const id of ids) picked.add(id)
    else for (const id of ids) picked.delete(id)
    selectedChapterIds.value = chapters.value.filter(c => picked.has(c.id)).map(c => c.id)
  }

  /** 卷分组（Step 1 的「按卷选择」列表） */
  const volumeGroups = computed(() => {
    const map = new Map<number | null, { volumeSeq: number | null; volumeTitle: string | null; chapterIds: Id[] }>()
    for (const row of chapters.value) {
      const key = row.volumeSeq ?? null
      const entry = map.get(key) ?? { volumeSeq: key, volumeTitle: row.volumeTitle, chapterIds: [] }
      entry.chapterIds.push(row.id)
      map.set(key, entry)
    }
    return [...map.values()]
  })

  /** 某卷已选章数 */
  function selectedCountOfVolume(volumeSeq: number | null): number {
    const picked = new Set(selectedChapterIds.value)
    return chapters.value.filter(c => (c.volumeSeq ?? null) === volumeSeq && picked.has(c.id)).length
  }

  // ── 动作：Step 2/4/5 参数 ────────────────────────────────────────────────

  /** 单个参数改动（泛型保留字面量类型，避免 'mp3' 被放宽成 string） */
  function setParam<K extends keyof ExportParams>(key: K, value: ExportParams[K]): void {
    params.value[key] = value
    if (key === 'targetLufs' && typeof value === 'number') {
      // 换目标档位时同步 LRA（用户之后仍可手动改）
      params.value.lra = lraForTarget(value)
    }
  }

  /**
   * 切换输出格式。
   * 注意：选 M4A **不会**自动打开「合并 M4B」—— 合并是一次额外的长任务
   * （要重编码整本），必须由用户显式勾选（M4bOptionsPanel 的开关）。
   */
  function setFormat(format: ExportFormat): void {
    params.value.format = format
  }

  function patchMetadata(patch: Partial<ExportMetadata>): void {
    params.value.metadata = { ...params.value.metadata, ...patch }
  }

  function setWriteMetadata(value: boolean): void {
    writeMetadata.value = value
  }

  function setM4bEnabled(value: boolean): void {
    m4b.value.enabled = value
  }

  function setM4bChapterTitleTemplate(value: string): void {
    m4b.value.chapterTitleTemplate = value
  }

  function setTitleReading(value: boolean): void {
    m4b.value.titleReading = value
  }

  function setOverwrite(mode: ExportOverwrite): void {
    params.value.overwrite = mode
  }

  /**
   * 选择输出目录（app:openFolderDialog）。
   * 失败**不抛出**：错误已由 error-bus 兑现，抛出只会变成 unhandledrejection 再报一次。
   */
  async function pickOutputDir(): Promise<void> {
    try {
      const picked = await call('app:openFolderDialog', {
        title: '选择导出目录',
        defaultPath: params.value.outputDir || undefined,
      }) as IpcRes<'app:openFolderDialog'>
      if (picked.path) params.value.outputDir = picked.path
    } catch {
      /* 已兑现提示 */
    }
  }

  /** 选择封面（app:openFileDialog；docs/15 §11：只支持 JPEG/PNG，失败忽略封面继续） */
  async function pickCover(): Promise<void> {
    try {
      const picked = await call('app:openFileDialog', {
        title: '选择封面图片',
        filters: [{ name: '图片（JPEG / PNG）', extensions: ['jpg', 'jpeg', 'png'] }],
      }) as IpcRes<'app:openFileDialog'>
      const path = picked.paths[0]
      if (path) patchMetadata({ coverPath: path })
    } catch {
      /* 已兑现提示 */
    }
  }

  function clearCover(): void {
    patchMetadata({ coverPath: null })
  }

  /** 用书籍信息回填元数据（Step 5 的「从书籍信息回填」按钮） */
  function fillMetadataFromBook(book: { title: string; author: string | null; narrator: string } | null): void {
    patchMetadata({
      album: book?.title ?? '',
      artist: book?.author ?? '',
      narrator: book?.narrator ?? '',
    })
  }

  /** 拉取 MP3 的 VBR 质量档（`export:vbrPresets`，纯展示；见 M4bOptionsPanel 中的说明） */
  async function loadVbrPresets(): Promise<void> {
    if (vbrPresets.value.length || vbrLoading.value) return
    vbrLoading.value = true
    const presets = await callSafe('export:vbrPresets', undefined)
    vbrPresets.value = (presets as Array<{ label: string; value: number }> | null) ?? []
    vbrLoading.value = false
  }

  /**
   * 把「输出」这一组参数写回设置，作为下次进入向导的默认值。
   * 直接走 `settings:set`（而不是 settings.store 的 action），
   * 保证本功能域**只读**应用级 store 的状态（docs/01 §3.2）。
   */
  async function rememberAsDefaults(): Promise<boolean> {
    const p = params.value
    const changed = await callSafe('settings:set', {
      patch: {
        export: {
          format: p.format,
          mp3Bitrate: p.mp3Bitrate,
          m4bBitrate: p.m4bBitrate,
          fileNameTemplate: p.fileNameTemplate,
          chapterTitleTemplate: m4b.value.chapterTitleTemplate,
          writeMetadata: writeMetadata.value,
          coverPath: p.metadata.coverPath ?? null,
          splitM4bEvery: p.splitM4bEvery,
        },
      },
    })
    return changed !== null
  }

  // ── 动作：Step 3 混音方案 ────────────────────────────────────────────────

  /**
   * 加载混音方案。
   *   · 单章/选定章：直接 `mix:listProjects({chapterId})`（选定章取第一章，UI 上说明）；
   *   · 全书：逐章抽样汇总（IPC 是按章查询的），并说明「将使用各章的默认方案」。
   */
  async function loadMixPlans(): Promise<void> {
    mixLoading.value = true
    try {
      if (isBookScope.value) {
        await loadMixSummary()
        mixProjects.value = []
        mixProject.value = null
        mixProjectId.value = null
        mixDiagnosis.value = mixSummary.value && mixSummary.value.withoutProjects > 0 ? 'empty' : 'ok'
        if (mixSummary.value && mixSummary.value.noVoiceTrack > 0) mixDiagnosis.value = 'no_voice_track'
        return
      }

      const chapterId = targetChapterIds.value[0]
      if (!chapterId) {
        mixProjects.value = []
        mixProject.value = null
        mixProjectId.value = null
        mixDiagnosis.value = 'empty'
        return
      }

      const projects = await call('mix:listProjects', { chapterId }) as IpcRes<'mix:listProjects'>
      mixProjects.value = projects
      if (!projects.length) {
        mixProject.value = null
        mixProjectId.value = null
        mixDiagnosis.value = 'empty'
        return
      }

      const preferred = projects.find(p => p.id === mixProjectId.value)
        ?? projects.find(p => p.isDefault)
        ?? (projects[0] as MixProject)
      await selectMixProject(preferred.id)
    } catch (error) {
      mixDiagnosis.value = 'unknown'
      mixProjects.value = []
      mixProject.value = null
      mixProjectId.value = null
      void error
    } finally {
      mixLoading.value = false
    }
  }

  /** 全书范围下的混音方案抽样汇总（逐章 IPC 失败用 reportBatchFailures 汇总成一条） */
  async function loadMixSummary(): Promise<void> {
    const rows = targetChapterRows.value.slice(0, MIX_SUMMARY_SAMPLE_LIMIT)
    const sink: Array<{ label: string; code: string; message: string }> = []
    const results = await Promise.all(rows.map(row =>
      callCollecting('mix:listProjects', { chapterId: row.id }, sink, row.title),
    ))

    const entries: MixSummaryEntry[] = []
    let without = 0
    let noVoice = 0
    let withBgm = 0

    results.forEach((result, index) => {
      const row = rows[index]
      if (!result || !row) return
      if (!result.ok) return
      const projects = result.data as MixProject[]
      if (!projects.length) {
        without++
        return
      }
      const project = projects.find(p => p.isDefault) ?? (projects[0] as MixProject)
      const voice = project.tracks.filter(t => t.kind === 'voice')
      const music = project.tracks.filter(t => t.kind === 'music')
      if (voice.length === 0) noVoice++
      if (music.some(t => t.music !== null)) withBgm++
      entries.push({
        chapterId: row.id,
        chapterTitle: row.title,
        projectName: project.name,
        trackCount: project.tracks.length,
        voiceCount: voice.length,
        musicCount: music.length,
        sfxCount: project.tracks.filter(t => t.kind === 'sfx').length,
        hasBgm: music.some(t => t.music !== null),
        targetLufs: project.master.targetLufs,
        arrangementId: project.arrangementId,
      })
    })

    mixSummary.value = {
      sampled: rows.length,
      total: targetChapterCount.value,
      withProjects: entries.length,
      withoutProjects: without,
      noVoiceTrack: noVoice,
      withBgm,
      entries,
    }

    if (sink.length) {
      reportBatchFailures({
        total: rows.length,
        failed: sink.length,
        ok: rows.length - sink.length,
        samples: sink,
      })
    }
  }

  /** 选中一个混音方案并拉取详情（`mix:get`）；失败时只标记为未知，不抛出 */
  async function selectMixProject(id: Id): Promise<void> {
    mixProjectId.value = id
    try {
      const detail = await call('mix:get', { mixProjectId: id }) as IpcRes<'mix:get'>
      mixProject.value = detail
      const voiceCount = detail.tracks.filter(t => t.kind === 'voice').length
      mixDiagnosis.value = voiceCount === 0 ? 'no_voice_track' : 'ok'
    } catch {
      mixProject.value = null
      mixDiagnosis.value = 'unknown'
    }
  }

  /** 是否使用混音方案（关掉即「纯干声」导出） */
  function setUseMixProject(value: boolean): void {
    useMixProject.value = value
  }

  // ── 动作：Step 4 响度测量 ────────────────────────────────────────────────

  /**
   * 「先测量再决定」（docs/15 §4 两遍法的第一遍）：
   * 对**一个已有的参考音频**跑 `mix:measureLoudness`，拿到 input_i / input_tp / input_lra，
   * 从而判断目标响度需要多少增益（Pass 2 的 gainDb = target - input_i）。
   *
   * 为什么让用户选文件而不是直接测当前章：向导阶段还没有渲染成品，
   * 1.0 的 `mix:measureLoudness` 只接受 `path` / `segmentId`，
   * 完整预览渲染（docs/15 §8）不在向导范围内（见交付报告中的契约缺口说明）。
   */
  async function measureReference(path: string): Promise<LoudnessMeasurement | null> {
    measuring.value = true
    try {
      const result = await call('mix:measureLoudness', {
        path,
        targetLufs: params.value.targetLufs,
      }) as IpcRes<'mix:measureLoudness'>
      measurement.value = result
      measuredPath.value = path
      return result
    } catch (error) {
      measurement.value = null
      measuredPath.value = null
      void error
      return null
    } finally {
      measuring.value = false
    }
  }

  function clearMeasurement(): void {
    measurement.value = null
    measuredPath.value = null
  }

  // ── 动作：Step 6 预检 ────────────────────────────────────────────────────

  /** 预检入参（QcPreCheckPanel 直接用它调 qc.run） */
  const preCheckRequest = computed<IpcReq<'export:preCheck'> | null>(() => {
    const id = bookId.value
    if (!id) return null
    return {
      bookId: id,
      chapterIds: cloneForIpc(targetChapterIds.value),
      mixProjectId: effectiveMixProjectId.value,
      params: cloneForIpc(params.value),
    }
  })

  /**
   * 预检结果的只读透传：结果本体在 qc.store（它还要管「已知悉」集合与复核结果），
   * 这里透出一份方便向导统一读状态（Step 6 的门槛判断也读 qc.canProceed）。
   */
  const preCheck = computed(() => qc.preCheck)

  // ── 动作：Step 7 任务 ────────────────────────────────────────────────────

  /** 记录主进程返回的 taskId（执行面板与流程编排都用它） */
  function setTask(taskIdValue: Id, jobIdValue: Id | null = null): void {
    taskId.value = taskIdValue
    jobId.value = jobIdValue
  }

  function clearTask(): void {
    taskId.value = null
  }

  /** 记录报告（Step 8） */
  function setReport(value: ExportReport | null): void {
    report.value = value
    if (value) {
      jobId.value = value.jobId
      step.value = 8
      maxVisitedStep.value = Math.max(maxVisitedStep.value, 8)
    }
  }

  /** 带警告的章节（报告面板的明细表用；`ExportReport` 没有逐章错误字段，见交付报告） */
  const chaptersWithWarnings = computed<ExportChapterResult[]>(() =>
    (report.value?.chapters ?? []).filter(c => !c.skipped && c.warnings.length > 0),
  )

  const skippedChapters = computed<ExportChapterResult[]>(() =>
    (report.value?.chapters ?? []).filter(c => c.skipped),
  )

  /**
   * 章间响度差（docs/15 §6.2：≤ 1.5 LU，超出听众会觉得「这章响那章轻」）。
   * 只统计非跳过的章：跳过章没有实测值。
   */
  const measuredSpread = computed(() => {
    const values = (report.value?.chapters ?? [])
      .filter(c => !c.skipped && c.measuredLufs !== null && Number.isFinite(c.measuredLufs))
      .map(c => c.measuredLufs as number)
    if (values.length < 2) return null
    return Math.max(...values) - Math.min(...values)
  })

  // ── 参数变化 → 作废预检（纪律 3） ────────────────────────────────────────

  watch(
    [params, rangeMode, selectedChapterIds, mixProjectId, useMixProject, m4b],
    () => {
      paramsVersion.value += 1
      if (qc.hasResult) qc.invalidate()
    },
    { deep: true },
  )

  return {
    // 向导框架
    step, maxVisitedStep, initialized, stepTitles, stepTitle, stepIssues, canProceed,
    goToStep, nextStep, prevStep, restartWizard,
    // 书籍与章节
    bookId, bookTitle, author, narrator, chapters, chaptersLoading, ready,
    bootstrap, loadChapters,
    // Step 1
    rangeMode, selectedChapterIds, targetChapterIds, targetChapterRows, targetChapterCount,
    volumeGroups, isBookScope, currentChapterMissing, rangeLabel,
    setRangeMode, toggleChapter, selectAllChapters, invertSelection, clearSelection,
    selectByVolume, selectedCountOfVolume,
    // Step 2/4/5 参数
    params, writeMetadata, vbrPresets, vbrLoading,
    templateContext, namePreviews, unknownTokens, emptyTokens, chapterPlan,
    estimatedDurationMs, estimatedOutputBytes, estimatedTempBytes, estimateOf: estimateChapterDurationMs,
    setParam, setFormat, setOverwrite, patchMetadata, setWriteMetadata,
    pickOutputDir, pickCover, clearCover, fillMetadataFromBook,
    loadVbrPresets, rememberAsDefaults, initFromSettings,
    // M4B
    m4b, m4bChapterPreview, m4bTooManyChapters, m4bTooLong, m4bMaxHours,
    m4bChapterWarning, suggestedSplitEvery,
    setM4bEnabled, setM4bChapterTitleTemplate, setTitleReading,
    // Step 3
    mixProjects, mixProject, mixProjectId, useMixProject, mixLoading, mixSummary, mixDiagnosis,
    mixDiagnosisMessage, mixDetail, effectiveMixProjectId,
    loadMixPlans, selectMixProject, setUseMixProject,
    // Step 4
    measurement, measuring, measuredPath, suggestedGainDb, measurementSilent, targetConflict,
    measureReference, clearMeasurement,
    // Step 6
    preCheckRequest, preCheck, paramsVersion,
    // Step 7/8
    taskId, jobId, report, reportLoading, reportSavePath,
    chaptersWithWarnings, skippedChapters, measuredSpread,
    setTask, clearTask, setReport,
  }
})
