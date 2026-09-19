/**
 * 主进程 · IPC 载荷校验表（全部通道的 req 形状）
 * ============================================================================
 * 设计依据：docs/20 §1.2「每个 handler 入口用 schema 校验载荷（防篡改、防类型漂移）」
 *
 * 本文件是 `src/shared/ipc.ts` 的 `IpcContract['*']['req']` 的**运行期镜像**：
 *   · 类型单一来源仍是 `src/shared/ipc.ts`（这里不重复声明类型）
 *   · 运行期形状每通道一条，`IPC_REQ_SCHEMAS` 用 `satisfies Record<IpcChannel, Schema<unknown>>`
 *     约束 —— 漏一个通道编译期就会红（本环境无 tsc，因此另有运行期测试
 *     `tests/main/ipc-contract.test.ts` 兜底）
 *
 * 约定：
 *   · 未声明字段一律**剔除**（`v.object` 默认 strip），这是 IPC 防篡改的第一道
 *   · 可选字段用 `v.optional(...)`；可为空的字段（数据库 NULL）用 `v.nullable(...)`
 *   · `Partial<T>` 语义用显式可选字段或 `.partial()` 表达
 *   · 数组一律给上限（`max`），防止一个请求把主进程内存打满
 */

import type { IpcChannel } from '../../shared/ipc.ts'
import { v, type Schema } from '../infra/validate/index.ts'

// ---------------------------------------------------------------------------
// 复用片段
// ---------------------------------------------------------------------------

/** 主键（UUID/nanoid 语义） */
const Id = v.string().max(128)
const IdOrNull = v.nullable(Id)
const OptId = v.optional(v.nullable(Id))
const OptString = v.optional(v.string())
/**
 * 可空字符串：`null`（或空串）表示「不设置 / 用默认值」。
 *
 * **只用于 `AppSettings` 类型里声明为 `string | null` 的字段**（`paths.ffmpegPath` /
 * `paths.modelDir` / `audio.defaultInputDeviceId` / `export.coverPath`）。
 *
 * 为什么必须允许 `null`：这几个字段的「未设置」状态在 UI 上是**正常操作**
 * ——「跟随系统默认设备」把设备选成 `null`、「清除封面」把封面清成 `null`，
 * 而 `002_seed.sql` 也正是把它们预置成 `'null'`。此前 schema 写的是 `OptString`
 * （`v.optional(v.string())`，不接受 `null` 也不接受空串），导致这些操作**保存必失败**
 * （`SchemaError: 应为字符串，实际是 null`）—— 见 docs/91 §5.2.7 待办。
 *
 * 同时允许空串：路径输入框被清空时 UI 天然产生 `''`，边界上宽容一点、
 * 由渲染进程归一到 `null`（不让 `''` 进入设置树）。
 */
const OptNullableString = v.optional(v.nullable(v.string().allowEmpty()))

/**
 * 可空的可选整数/数字。
 *
 * ⚠️ 为什么「可空」必须显式写出来：领域类型里 `string | null` / `number | null` 的字段，
 * 界面上「清空」这个动作发的就是 `null`（先例：`CharacterPanel.vue` 的
 * `description: form.description || null`、`LineEditorDrawer.vue` 的 `{ note: null }`）。
 * 若 schema 只写 `v.optional(v.string())`，清空一个备注就会得到 `INVALID_PAYLOAD` ——
 * 用户看到的是「参数不对」，而真正的原因是他清空了一个可空字段。
 * 规则：**领域类型可空 ⇒ schema 必须可空**（docs/91 §5.2.11）。
 */
const OptNullableInt = v.optional(v.nullable(v.number().int()))
// （已移除：StringOrNull 未被使用）
const StrArray = v.array(v.string().allowEmpty(), { max: 10_000 })
const OptBool = v.optional(v.boolean())
const OptNum = v.optional(v.number())
const OptInt = v.optional(v.number().int())
/** `Record<string, unknown>`：转发型参数（如 options） */
const LooseObject = v.object({}).passthrough() as unknown as Schema<Record<string, unknown>>

const ChapterKind = v.enum(['chapter', 'front', 'back', 'extra', 'volume'])
const SpeakerType = v.enum(['narration', 'character'])
const LineKind = v.enum(['dialogue', 'narration', 'inner', 'sfx_note'])
// （已移除：LineState 未被使用；画本行状态校验在 canvas 域 schema 内联）
const DecidedBy = v.enum(['rule', 'vector', 'llm', 'human'])
const SpeedMark = v.enum(['slow', 'normal', 'fast'])
const RecordingMode = v.enum(['line_by_line', 'continuous', 'role', 'punch_in', 'package'])
const ArrangeStrategy = v.enum(['serialize', 'keep', 'compress-pause', 'tighten'])
const ProcessScope = v.enum(['segment', 'character', 'chapter', 'book'])
const ExportFormat = v.enum(['mp3', 'wav', 'm4a'])
const ExportOverwrite = v.enum(['skip', 'overwrite', 'rename'])
const TaskStatus = v.enum(['queued', 'waiting', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'])
const TaskKind = v.enum([
  'book.import',
  'canvas.generate',
  'canvas.recompute',
  'character.centroid',
  'embedding.batch',
  'asr.transcribe',
  'audio.process',
  'audio.render',
  'export.chapter',
  'export.book',
  'package.export',
  'package.import',
  'package.merge',
  'db.backup',
  'cache.clean',
])
const LogLevel = v.enum(['error', 'warn', 'info', 'debug', 'trace'])

/** 结果形状（res 侧不校验；`{ok:true}` 类响应的公共形状，供领域 handler 复用） */
const OkShape = v.object({ ok: v.boolean() })
export { OkShape }

const FileDialogFilter = v.object({ name: v.string(), extensions: v.array(v.string().max(32), { max: 64 }) })
const FileDialogFilters = v.optional(v.array(FileDialogFilter, { max: 64 }))

const AudioFormatShape = v.object({
  sampleRate: v.number({ int: true, min: 8000, max: 384_000 }),
  bitDepth: v.union([v.literal(16), v.literal(24), v.literal(32)]),
  channels: v.union([v.literal(1), v.literal(2)]),
})

/** docs/05 §4.2 VAD 参数 */
const VadOptionsShape = v.object({
  enabled: v.boolean(),
  silenceDb: v.number({ min: -100, max: 0 }),
  minSilenceMs: v.number({ min: 0, max: 60_000 }),
  minSpeechMs: v.number({ min: 0, max: 60_000 }),
  minSliceMs: v.number({ min: 0, max: 600_000 }),
  maxSliceMs: v.number({ min: 0, max: 3_600_000 }),
  headRollbackMs: v.number({ min: 0, max: 5000 }),
  tailKeepMs: v.number({ min: 0, max: 5000 }),
  autoNoiseFloor: v.boolean(),
  charsPerSecond: v.number({ min: 0.5, max: 30 }),
})

/** docs/05 §5.3 静音修剪 */
const TrimOptionsShape = v.object({
  enabled: v.boolean(),
  thresholdDb: v.number({ min: -100, max: 0 }),
  headPaddingMs: v.number({ min: 0, max: 10_000 }),
  tailPaddingMs: v.number({ min: 0, max: 10_000 }),
})

const SliceMatchShape = v.object({
  sliceIndex: v.number({ int: true, min: 0 }),
  lineId: Id,
  confidence: v.number({ min: 0, max: 1 }),
})

const VadSliceShape = v.object({
  id: Id,
  sessionId: Id,
  sliceIndex: v.number({ int: true, min: 0 }),
  startMs: v.number({ min: 0 }),
  endMs: v.number({ min: 0 }),
  rmsDb: v.nullable(v.number()),
  peakDb: v.nullable(v.number()),
  matchedLine: IdOrNull,
  matchScore: v.nullable(v.number()),
  accepted: v.boolean(),
  flags: StrArray,
})

/** docs/10 §6.2 分章规则 */
const ChapterRuleShape = v.object({
  id: v.string().max(64),
  linePattern: v.string().max(500),
  maxLineLength: v.number({ int: true, min: 1, max: 10_000 }),
  requireBlankAround: v.boolean(),
  titleGroup: v.number({ int: true, min: 0, max: 9 }),
  kind: ChapterKind,
})

const ChapterRuleSetShape = v.object({
  id: v.string().max(128),
  name: v.string().max(120),
  builtin: v.boolean(),
  patterns: v.array(ChapterRuleShape, { max: 200 }),
  allowNumericOnly: v.boolean(),
})

/** docs/10 §6 章节草稿 */
const ChapterDraftShape = v.object({
  tempId: v.string().max(128),
  index: v.number({ int: true, min: 0 }),
  title: v.string().max(500),
  rawText: v.string().max(2_000_000),
  charCount: v.number({ int: true, min: 0 }),
  estimatedDurationMs: v.number({ min: 0 }),
  kind: ChapterKind,
  volumeIndex: v.nullable(v.number().int()),
  startOffset: v.number({ int: true, min: 0 }),
  endOffset: v.number({ int: true, min: 0 }),
  included: v.boolean(),
})

/** docs/11 §5 画本行补丁（全部可选 = Partial<CanvasLinePatch>） */
const CanvasLinePatchShape = v.object({
  text: OptString,
  speakerType: v.optional(SpeakerType),
  characterId: OptId,
  kind: v.optional(LineKind),
  // 情绪 / 注音 / 备注在领域类型里是 `string | null`，UI 清空时发的就是 null（见 OptNullableInt 注释）
  emotion: OptNullableString,
  emotionIntensity: v.optional(v.nullable(v.number({ int: true, min: 1, max: 5 }))),
  speed: v.optional(v.nullable(SpeedMark)),
  gainDb: v.optional(v.nullable(v.number({ min: -60, max: 60 }))),
  pauseAfterMs: OptInt,
  pauseInline: v.optional(v.nullable(v.array(v.number({ int: true, min: 0 }), { max: 1000 }))),
  pronunciation: OptNullableString,
  note: OptNullableString,
  needsReview: OptBool,
  decidedBy: v.optional(DecidedBy),
  flags: v.optional(v.array(v.string().max(64), { max: 64 })),
})

/** docs/11 §5 生成选项 */
const CanvasGenerateOptionsShape = v.object({
  useEmbedding: v.boolean(),
  useLlm: v.boolean(),
  contextWindow: v.number({ int: true, min: 0, max: 20 }),
  threshold: v.number({ min: 0, max: 1 }),
  margin: v.number({ min: 0, max: 1 }),
  ruleSetId: IdOrNull,
  overwriteHuman: v.boolean(),
  inferTags: v.boolean(),
})

/** docs/13 §3 item 补丁 */
const ArrangementItemPatchShape = v.object({
  timelineStartMs: OptNum,
  srcInMs: OptNum,
  srcOutMs: OptNum,
  fadeInMs: OptNum,
  fadeOutMs: OptNum,
  locked: OptBool,
})

/** docs/14 §2 处理链 */
const ProcessChainShape = v.object({
  highpass: v.object({ enabled: v.boolean(), freq: v.number({ min: 0, max: 20_000 }), poles: v.union([v.literal(1), v.literal(2)]) }),
  denoise: v.object({ enabled: v.boolean(), nr: v.number(), nf: v.number(), tn: v.boolean() }),
  deesser: v.object({ enabled: v.boolean(), intensity: v.number(), freq: v.number() }),
  eq: v.array(
    v.object({
      id: v.string().max(64),
      type: v.enum(['lowshelf', 'highshelf', 'peak', 'lowpass', 'highpass']),
      freq: v.number({ min: 0, max: 20_000 }),
      gainDb: v.number({ min: -30, max: 30 }),
      q: v.number({ min: 0.1, max: 30 }),
      enabled: v.boolean(),
    }),
    { max: 64 },
  ),
  compressor: v.object({
    enabled: v.boolean(),
    thresholdDb: v.number(),
    ratio: v.number(),
    attackMs: v.number(),
    releaseMs: v.number(),
    makeupDb: v.number(),
  }),
  limiter: v.object({ enabled: v.boolean(), limitDb: v.number(), attackMs: v.number(), releaseMs: v.number() }),
  repair: v.object({
    dcOffset: v.boolean(),
    polarityInvert: v.boolean(),
    declick: v.array(v.object({ atMs: v.number({ min: 0 }), lengthMs: v.number({ min: 0 }) }), { max: 10_000 }),
    silenceFill: v.array(v.object({ startMs: v.number({ min: 0 }), endMs: v.number({ min: 0 }) }), { max: 10_000 }),
    tempo: v.object({ enabled: v.boolean(), factor: v.number({ min: 0.25, max: 4 }) }),
  }),
})

/** docs/14 §4.2 处理预设（不含时间戳与 id，见 preset:create） */
const ProcessPresetShape = v.object({
  id: Id,
  projectId: IdOrNull,
  name: v.string().max(120),
  description: v.nullable(v.string().max(500)),
  builtin: v.boolean(),
  chain: ProcessChainShape,
  tags: v.array(v.string().max(32), { max: 32 }),
  sortOrder: v.number({ int: true }),
  createdAt: v.number(),
  updatedAt: v.number(),
})

const ProcessPresetCreateShape = v.object({
  projectId: IdOrNull,
  name: v.string().max(120),
  description: v.nullable(v.string().max(500)),
  chain: ProcessChainShape,
  tags: v.array(v.string().max(32), { max: 32 }),
  sortOrder: v.number({ int: true }),
})

const ProcessPresetPatchShape = ProcessPresetShape.partial()

/** docs/15 §2 混音轨 */
const DuckingConfigShape = v.object({
  enabled: v.boolean(),
  amountDb: v.number(),
  thresholdDb: v.number(),
  attackMs: v.number(),
  releaseMs: v.number(),
  mode: v.enum(['sidechain', 'envelope']),
})

const MusicTrackConfigShape = v.object({
  assetId: Id,
  startMs: v.number({ min: 0 }),
  endMs: v.nullable(v.number({ min: 0 })),
  loop: v.boolean(),
  fadeInMs: v.number({ min: 0 }),
  fadeOutMs: v.number({ min: 0 }),
  ducking: DuckingConfigShape,
})

const MixTrackShape = v.object({
  id: Id,
  mixProjectId: Id,
  kind: v.enum(['voice', 'music', 'sfx']),
  refId: IdOrNull,
  name: v.string().max(120),
  gainDb: v.number({ min: -60, max: 24 }),
  pan: v.number({ min: -1, max: 1 }),
  isMute: v.boolean(),
  isSolo: v.boolean(),
  presetId: IdOrNull,
  sortOrder: v.number({ int: true }),
  music: v.nullable(MusicTrackConfigShape),
})

const MixMasterShape = v.object({
  targetLufs: v.number({ min: -40, max: 0 }),
  truePeakDb: v.number({ min: -10, max: 0 }),
  lra: v.number({ min: 0, max: 30 }),
  limiterEnabled: v.boolean(),
  sampleRate: v.union([v.literal(44100), v.literal(48000)]),
  channels: v.union([v.literal(1), v.literal(2)]),
})

const MixProjectShape = v.object({
  id: Id,
  chapterId: Id,
  arrangementId: Id,
  name: v.string().max(120),
  isDefault: v.boolean(),
  tracks: v.array(MixTrackShape, { max: 256 }),
  master: MixMasterShape,
  headSilenceMs: v.number({ min: 0 }),
  tailSilenceMs: v.number({ min: 0 }),
  titleReading: v.object({ enabled: v.boolean(), lineId: IdOrNull, tailPauseMs: v.number({ min: 0 }) }),
  version: v.number({ int: true, min: 1 }),
  createdAt: v.number(),
  updatedAt: v.number(),
})

/** docs/15 §4 导出参数 */
const ExportMetadataShape = v.object({
  title: OptString,
  artist: OptString,
  album: OptString,
  narrator: OptString,
  genre: OptString,
  date: OptString,
  coverPath: OptString,
})

const ExportParamsShape = v.object({
  format: ExportFormat,
  mp3Bitrate: v.union([v.literal(128), v.literal(192), v.literal(256), v.literal(320)]),
  m4bBitrate: v.union([v.literal(64), v.literal(96), v.literal(128), v.literal(192)]),
  sampleRate: v.union([v.literal(44100), v.literal(48000)]),
  targetLufs: v.number({ min: -40, max: 0 }),
  truePeakDb: v.number({ min: -10, max: 0 }),
  lra: v.number({ min: 0, max: 30 }),
  headSilenceMs: v.number({ min: 0 }),
  tailSilenceMs: v.number({ min: 0 }),
  outputDir: v.string().max(1000),
  fileNameTemplate: v.string().max(300),
  metadata: ExportMetadataShape,
  overwrite: ExportOverwrite,
  splitM4bEvery: v.number({ int: true, min: 0, max: 5000 }),
})

/** docs/04 §8.2 应用设置（settings:set 用**深可选**形状） */
const AppSettingsShape = v.object({
  paths: v.object({
    projectRoot: OptString,
    exportDir: OptString,
    ffmpegPath: OptNullableString,
    modelDir: OptNullableString,
    cacheDir: OptString,
    backupDir: OptString,
  }).partial(),
  audio: v.object({
    sampleRate: v.optional(v.union([v.literal(44100), v.literal(48000)])),
    bitDepth: v.optional(v.union([v.literal(16), v.literal(24), v.literal(32)])),
    channels: v.optional(v.union([v.literal(1), v.literal(2)])),
    defaultInputDeviceId: OptNullableString,
    monitorEnabled: OptBool,
    monitorGainDb: OptNum,
    inputGainDb: OptNum,
    agcEnabled: OptBool,
    countdownMs: OptInt,
    autoTrim: OptBool,
    trimThresholdDb: OptNum,
    trimPaddingMs: OptInt,
    echoCancellation: OptBool,
  }).partial(),
  recording: v.object({
    defaultMode: v.optional(RecordingMode),
    stopKey: OptString,
    nextLineKey: OptString,
    redoKey: OptString,
    playKey: OptString,
    footPedalEnabled: OptBool,
    footPedalMapping: v.optional(v.record(v.string().max(64))),
    vad: v.optional(VadOptionsShape),
    maxSessionMinutes: OptInt,
  }).partial(),
  canvas: v.object({
    attributionThreshold: OptNum,
    attributionMargin: OptNum,
    contextWindow: OptInt,
    autoAcceptConfidence: OptNum,
    defaultPauseAfterMs: OptInt,
    defaultEmotion: OptString,
    maxLineChars: OptInt,
    maxNarrationRun: OptInt,
    shortLineChars: OptInt,
  }).partial(),
  mixing: v.object({
    targetLufs: OptNum,
    truePeakDb: OptNum,
    headSilenceMs: OptInt,
    tailSilenceMs: OptInt,
    defaultMusicGainDb: OptNum,
    duckAmountDb: OptNum,
    duckAttackMs: OptInt,
    duckReleaseMs: OptInt,
    maxCrossTrackOverlapMs: OptInt,
    maxGapMs: OptInt,
  }).partial(),
  export: v.object({
    format: v.optional(ExportFormat),
    mp3Bitrate: v.optional(v.union([v.literal(128), v.literal(192), v.literal(256), v.literal(320)])),
    m4bBitrate: v.optional(v.union([v.literal(64), v.literal(96), v.literal(128), v.literal(192)])),
    fileNameTemplate: OptString,
    chapterTitleTemplate: OptString,
    writeMetadata: OptBool,
    coverPath: OptNullableString,
    splitM4bEvery: OptInt,
  }).partial(),
  ai: v.object({
    provider: v.optional(v.enum(['mock', 'local', 'openai-compatible', 'dify'])),
    baseUrl: OptString,
    model: OptString,
    timeoutMs: OptInt,
    maxConcurrency: OptInt,
    allowSendTextToCloud: OptBool,
  }).partial(),
  embedding: v
    .object({ modelId: OptString, batchSize: OptInt, threads: OptInt })
    .partial(),
  asr: v.object({ modelId: OptString, language: OptString, threads: OptInt, translate: OptBool }).partial(),
  import: v.object({ maxFileSizeBytes: OptInt, maxUrlPages: OptInt, fetchDelayMs: OptInt }).partial(),
  ui: v
    .object({
      theme: v.optional(v.enum(['light', 'dark', 'system'])),
      language: OptString,
      editorDensity: v.optional(v.enum(['compact', 'normal', 'relaxed'])),
    })
    .partial(),
  advanced: v
    .object({
      logLevel: v.optional(LogLevel),
      autoBackup: v.optional(v.enum(['daily', 'weekly', 'off'])),
      keepBackups: OptInt,
      autoCleanupTakes: OptBool,
    })
    .partial(),
}).partial()

// ---------------------------------------------------------------------------
// 通道 → schema
// ---------------------------------------------------------------------------

/**
 * 全部 invoke 通道的请求 schema。
 * `satisfies Record<IpcChannel, Schema<unknown>>` 保证「契约里有的这里都有」。
 */
export const IPC_REQ_SCHEMAS = {
  // ── 应用与系统（docs/20 §4.1）──────────────────────────────────────────
  'app:getInfo': v.void(),
  'app:getPaths': v.void(),
  'app:getCapabilities': v.void(),
  // 只允许 http/https（docs/20 §4.1）；其余协议在 handler 里也会再挡一次
  'app:openExternal': v.object({ url: v.string().max(2000) }),
  'app:showItemInFolder': v.object({ path: v.string().max(2000) }),
  'app:openFolderDialog': v.object({ title: OptString, defaultPath: OptString }),
  'app:openFileDialog': v.object({ title: OptString, filters: FileDialogFilters, multi: OptBool }),
  'app:saveFileDialog': v.object({ title: OptString, defaultPath: OptString, filters: FileDialogFilters }),
  'app:diagnostics': v.void(),
  'app:quit': v.object({ force: OptBool }),

  // ── 书籍与章节 ─────────────────────────────────────────────────────────
  'book:list': v.object({ projectId: OptId }),
  'book:get': v.object({ bookId: Id }),
  'book:update': v.object({
    bookId: Id,
    patch: v
      .object({
        title: OptString,
        author: v.optional(v.nullable(v.string().max(200))),
        narrator: OptString,
        language: OptString,
        coverPath: v.optional(v.nullable(v.string().max(1000))),
      })
      .partial(),
  }),
  'book:delete': v.object({ bookId: Id, deleteAudio: OptBool }),
  'book:probeFile': v.object({ filePath: v.string().max(2000) }),
  'book:detectEncoding': v.object({ filePath: v.string().max(2000), sampleBytes: OptInt }),
  'book:previewSplit': v.object({
    filePath: OptString,
    // 正文可能很大：上限 200 MB 字符（导入限制见 docs/10 §2）
    text: v.optional(v.string({ max: 200_000_000, nonEmpty: false })),
    ruleSetId: OptId,
    cleanOptions: v.optional(v.record(v.boolean())),
  }),
  'book:commitImport': v.object({
    projectId: Id,
    bookMeta: v.object({
      title: v.string().max(500),
      author: v.optional(v.nullable(v.string().max(200))),
      narrator: OptString,
      language: OptString,
      coverPath: v.optional(v.nullable(v.string().max(1000))),
    }),
    source: v.object({
      type: v.enum(['txt', 'docx', 'pdf', 'paste', 'url']),
      path: v.optional(v.nullable(v.string().max(2000))),
      encoding: v.optional(v.nullable(v.string().max(64))),
      contentHash: v.string().max(128),
    }),
    drafts: v.array(ChapterDraftShape, { max: 20_000 }),
  }),
  'book:importFile': v.object({ projectId: Id, filePath: v.string().max(2000), options: v.optional(LooseObject) }),
  'book:importText': v.object({
    projectId: Id,
    text: v.string({ max: 200_000_000, nonEmpty: false }),
    title: v.string().max(500),
    options: v.optional(LooseObject),
  }),
  'book:importUrl': v.object({ projectId: Id, url: v.string().max(2000), options: v.optional(LooseObject) }),
  'book:findDuplicate': v.object({ contentHash: v.string().max(128), projectId: Id }),
  'book:ruleSets': v.void(),
  'book:saveRuleSet': v.object({ ruleSet: ChapterRuleSetShape }),
  'book:deleteRuleSet': v.object({ id: v.string().max(128) }),

  'chapter:list': v.object({ bookId: Id }),
  'chapter:get': v.object({ chapterId: Id }),
  'chapter:update': v.object({
    chapterId: Id,
    patch: v
      // `volumeTitle` 在领域类型里是 `string | null`（types.ts），而 UI 的「清除卷名」
      // 发的正是空串/`null` —— 用 OptString（非空）会直接 INVALID_PAYLOAD，
      // 表现为「改卷名永远不生效」。服务端会把空串归一到 null（见 chapter.service）。
      .object({ title: OptString, kind: v.optional(ChapterKind), volumeTitle: OptNullableString })
      .partial(),
  }),
  'chapter:reorder': v.object({ bookId: Id, orderedIds: v.array(Id, { max: 50_000 }) }),
  'chapter:merge': v.object({ chapterIds: v.array(Id, { min: 1, max: 500 }), title: v.string().max(500) }),
  'chapter:split': v.object({ chapterId: Id, atOffsets: v.array(v.number({ int: true, min: 0 }), { max: 1000 }) }),
  'chapter:delete': v.object({ chapterId: Id }),
  'chapter:stats': v.object({ chapterId: Id }),
  'chapter:inserTitleLine': v.object({ chapterId: Id }),

  // ── 画本 ───────────────────────────────────────────────────────────────
  'canvas:generate': v.object({ chapterId: Id, options: CanvasGenerateOptionsShape }),
  'canvas:getGenerateReport': v.object({ chapterId: Id }),
  'canvas:getChapter': v.object({
    chapterId: Id,
    offset: OptInt,
    limit: OptInt,
    filter: v.optional(
      v.object({
        needsReview: OptBool,
        speakerType: v.optional(SpeakerType),
        characterId: OptId,
        kind: OptString,
      }),
    ),
  }),
  'canvas:getLine': v.object({ lineId: Id }),
  'canvas:updateLine': v.object({ lineId: Id, patch: CanvasLinePatchShape, rev: OptInt }),
  'canvas:batchUpdate': v.object({
    lineIds: v.optional(v.array(Id, { max: 200_000 })),
    patch: CanvasLinePatchShape,
    filter: v.optional(
      v.object({ needsReview: OptBool, characterId: OptId, kind: OptString }),
    ),
  }),
  'canvas:recomputeAttribution': v.object({
    chapterId: Id,
    scope: v.enum(['low_confidence', 'all', 'selection']),
    lineIds: v.optional(v.array(Id, { max: 200_000 })),
  }),
  'canvas:qualityCheck': v.object({ chapterId: Id }),
  'canvas:snapshotCreate': v.object({ chapterId: Id, label: OptString, reason: OptString }),
  'canvas:insertLines': v.object({
    chapterId: Id,
    afterSeq: v.number({ int: true, min: 0 }),
    text: v.string({ max: 1_000_000, nonEmpty: false }),
    characterId: OptId,
  }),
  'canvas:deleteLine': v.object({ lineId: Id }),
  'canvas:exportText': v.object({ chapterId: Id, format: v.enum(['txt', 'csv', 'json']), outPath: OptString }),

  // ── 角色与配音员 ───────────────────────────────────────────────────────
  'character:list': v.object({ bookId: Id, includeArchived: OptBool }),
  'character:upsert': v.object({
    character: v.object({
      id: OptId,
      bookId: Id,
      name: v.string().max(200),
      aliases: v.optional(StrArray),
      gender: v.optional(v.nullable(v.enum(['male', 'female', 'other', 'unknown']))),
      ageGroup: v.optional(v.nullable(v.enum(['child', 'teen', 'young', 'middle', 'elder', 'unknown']))),
      // 以下四项在领域类型里可空，而 CharacterPanel.vue 清空输入框时发的就是 null
      // （`description: form.description || null`）—— 新建角色时描述通常为空，
      // 若这里不可空，**连「新建角色」都会失败**（docs/91 §5.2.11 真机堵点）
      description: OptNullableString,
      note: OptNullableString,
      color: OptNullableString,
      defaultSpeed: v.optional(v.nullable(SpeedMark)),
      defaultEmotion: OptNullableString,
      defaultGainDb: v.optional(v.nullable(v.number({ min: -60, max: 60 }))),
      defaultPauseMs: OptNullableInt,
      isArchived: OptBool,
      sortOrder: OptInt,
    }),
  }),
  'character:merge': v.object({ targetId: Id, sourceIds: v.array(Id, { min: 1, max: 500 }), keepAliases: OptBool }),
  'character:archive': v.object({ characterId: Id, archived: v.boolean() }),
  'character:extract': v.object({ bookId: Id, chapterIds: v.optional(v.array(Id, { max: 20_000 })) }),
  'character:stats': v.object({ characterId: Id }),
  'character:rebuildCentroid': v.object({ bookId: Id, characterIds: v.optional(v.array(Id, { max: 20_000 })) }),

  'voiceActor:list': v.object({ projectId: Id }),
  'voiceActor:upsert': v.object({
    actor: v.object({
      id: OptId,
      projectId: Id,
      name: v.string().max(200),
      // 可空字段一律 nullable：界面上「清空」发的是 null（见 OptNullableInt 注释）
      contact: OptNullableString,
      note: OptNullableString,
      profile: v.optional(
        v.nullable(
          v.object({
            samplePath: v.nullable(v.string().max(1000)),
            gender: v.enum(['male', 'female', 'other', 'unknown']),
            pitchRange: v.optional(v.nullable(v.array(v.number(), { max: 2 }))),
            speechRate: v.optional(v.nullable(v.number())),
          }),
        ),
      ),
    }),
  }),
  'voiceActor:delete': v.object({ actorId: Id }),
  'voiceActor:bind': v.object({ characterId: Id, actorId: Id, isPrimary: OptBool }),
  'voiceActor:unbind': v.object({ characterId: Id, actorId: Id }),
  'voiceActor:workload': v.object({ bookId: Id }),
  'voiceActor:bindings': v.object({ bookId: Id }),

  // ── 录音 ───────────────────────────────────────────────────────────────
  'record:prepare': v.object({
    projectId: Id,
    chapterId: IdOrNull,
    mode: RecordingMode,
    format: AudioFormatShape,
    deviceId: OptId,
    actorId: OptId,
  }),
  'record:attachPort': v.object({ sessionId: Id }),
  'record:start': v.object({ sessionId: Id }),
  'record:pause': v.object({ sessionId: Id }),
  'record:resume': v.object({ sessionId: Id }),
  'record:stop': v.object({ sessionId: Id, lineId: OptId, trim: v.optional(TrimOptionsShape) }),
  'record:abort': v.object({ sessionId: Id, keepFile: OptBool }),
  'record:punchIn': v.object({
    lineId: Id,
    srcInMs: v.number({ min: 0 }),
    srcOutMs: v.number({ min: 0 }),
    preRollMs: v.number({ min: 0, max: 60_000 }),
    postRollMs: v.number({ min: 0, max: 60_000 }),
  }),
  'record:slice': v.object({ sessionId: Id, vad: VadOptionsShape }),
  'record:matchSlices': v.object({
    sessionId: Id,
    chapterId: Id,
    slices: v.array(VadSliceShape, { max: 20_000 }),
    useAsr: OptBool,
  }),
  'record:acceptSlices': v.object({ sessionId: Id, accepted: v.array(SliceMatchShape, { max: 20_000 }) }),
  'record:optimizeTrim': v.object({ takeId: Id, options: TrimOptionsShape }),

  'device:list': v.void(),
  'device:savePreference': v.object({ deviceId: v.string().max(200), label: v.string().max(300) }),
  'device:selfTestResult': v.object({
    result: v.object({
      hasSignal: v.boolean(),
      clipping: v.boolean(),
      droppedFrames: v.number({ int: true, min: 0 }),
      noiseFloorDb: v.nullable(v.number()),
      peakDb: v.nullable(v.number()),
      rmsDb: v.nullable(v.number()),
      requestedSampleRate: v.number({ int: true, min: 0 }),
      actualSampleRate: v.number({ int: true, min: 0 }),
      latencyMs: v.nullable(v.number()),
      suggestion: v.nullable(v.string().max(500)),
    }),
  }),

  'take:listByLine': v.object({ lineId: Id }),
  'take:listByChapter': v.object({ chapterId: Id }),
  'take:setSelected': v.object({ lineId: Id, takeId: Id }),
  'take:delete': v.object({ takeId: Id, hard: OptBool }),
  'take:flag': v.object({ takeId: Id, flags: v.array(v.string().max(32), { max: 32 }) }),
  'take:combineParts': v.object({ lineId: Id, takeIds: v.array(Id, { min: 1, max: 200 }) }),

  // ── 对轨 ───────────────────────────────────────────────────────────────
  'alignment:listArrangements': v.object({ chapterId: Id }),
  'alignment:create': v.object({ chapterId: Id, name: v.string().max(120), strategy: ArrangeStrategy }),
  'alignment:duplicate': v.object({ arrangementId: Id, name: v.string().max(120) }),
  'alignment:delete': v.object({ arrangementId: Id }),
  'alignment:setDefault': v.object({ arrangementId: Id }),
  'alignment:get': v.object({ arrangementId: Id }),
  'alignment:autoArrange': v.object({
    arrangementId: Id,
    strategy: ArrangeStrategy,
    preserveLocked: v.boolean(),
    defaultPauseMs: v.number({ min: 0, max: 60_000 }),
  }),
  'alignment:updateItem': v.object({ itemId: Id, patch: ArrangementItemPatchShape }),
  'alignment:batchUpdateItems': v.object({
    updates: v.array(v.object({ itemId: Id, patch: ArrangementItemPatchShape }), { max: 50_000 }),
  }),
  'alignment:validate': v.object({ arrangementId: Id }),
  'alignment:resolveOverlap': v.object({ arrangementId: Id, itemIdA: Id, itemIdB: Id, strategy: ArrangeStrategy }),
  'alignment:resetTrack': v.object({ arrangementId: Id, trackId: v.string().max(128) }),
  'alignment:resetAll': v.object({ arrangementId: Id }),
  'alignment:autoMatchSegments': v.object({ chapterId: Id, useAsr: OptBool }),
  'alignment:bindSegment': v.object({ lineId: Id, segmentId: Id, srcInMs: OptNum, srcOutMs: OptNum }),
  'alignment:unbindSegment': v.object({ lineId: Id }),
  'alignment:issueKindLabels': v.void(),
  'alignment:previewRender': v.object({
    arrangementId: Id,
    mixProjectId: IdOrNull,
    startMs: v.number({ min: 0 }),
    durationMs: v.number({ min: 0 }),
  }),
  'alignment:forcedAlign': v.object({ lineId: OptId, segmentId: OptId }),

  // ── 处理与素材 ─────────────────────────────────────────────────────────
  'process:preview': v.object({ segmentId: Id, chain: ProcessChainShape, durationMs: OptNum }),
  'process:apply': v.object({ segmentId: Id, presetId: OptId, chain: v.optional(ProcessChainShape) }),
  'process:batchApply': v.object({
    scope: ProcessScope,
    ids: v.array(Id, { max: 200_000 }),
    presetId: OptId,
    chain: v.optional(ProcessChainShape),
  }),
  'process:listApplied': v.object({ segmentIds: v.array(Id, { max: 20_000 }) }),
  'process:revert': v.object({ segmentId: Id }),
  'preset:list': v.object({ projectId: OptId }),
  'preset:create': v.object({ preset: ProcessPresetCreateShape }),
  'preset:update': v.object({ id: Id, patch: ProcessPresetPatchShape }),
  'preset:delete': v.object({ id: Id }),
  'preset:import': v.object({ path: v.string().max(2000) }),
  'preset:export': v.object({ ids: v.array(Id, { max: 1000 }), path: v.string().max(2000) }),
  'music:import': v.object({
    projectId: Id,
    files: v.array(v.string().max(2000), { min: 1, max: 5000 }),
    kind: v.enum(['bgm', 'sfx']),
  }),
  'music:list': v.object({ projectId: Id, kind: v.optional(v.enum(['bgm', 'sfx'])) }),
  'music:probe': v.object({ assetId: Id }),
  'music:delete': v.object({ assetId: Id }),
  'analysis:noiseProfile': v.object({
    segmentId: Id,
    startMs: v.number({ min: 0 }),
    endMs: v.number({ min: 0 }),
  }),
  'analysis:metrics': v.object({ path: OptString, segmentId: OptId }),
  'analysis:peaks': v.object({
    path: OptString,
    segmentId: OptId,
    peaksPerSec: v.number({ int: true, min: 1, max: 1000 }),
    fromMs: OptNum,
    toMs: OptNum,
  }),
  'ffmpeg:capabilities': v.void(),

  // ── 混音与导出 ─────────────────────────────────────────────────────────
  'mix:listProjects': v.object({ chapterId: Id }),
  'mix:get': v.object({ mixProjectId: Id }),
  'mix:save': v.object({ mixProject: MixProjectShape }),
  'mix:create': v.object({ chapterId: Id, arrangementId: Id, name: v.string().max(120) }),
  'mix:duplicate': v.object({ mixProjectId: Id, name: v.string().max(120) }),
  'mix:delete': v.object({ mixProjectId: Id }),
  'mix:measureLoudness': v.object({ path: OptString, segmentId: OptId, targetLufs: OptNum }),
  'export:preCheck': v.object({
    bookId: Id,
    chapterIds: v.optional(v.array(Id, { max: 20_000 })),
    mixProjectId: IdOrNull,
    params: ExportParamsShape,
  }),
  'export:chapter': v.object({
    chapterIds: v.array(Id, { min: 1, max: 20_000 }),
    mixProjectId: IdOrNull,
    params: ExportParamsShape,
  }),
  'export:book': v.object({ bookId: Id, mixProjectId: IdOrNull, params: ExportParamsShape, makeM4b: v.boolean() }),
  'export:m4b': v.object({ bookId: Id, chapterIds: v.array(Id, { max: 20_000 }), params: ExportParamsShape }),
  'export:report': v.object({ jobId: Id }),
  'export:verify': v.object({ jobId: Id }),
  'export:openFolder': v.object({ jobId: Id }),
  'export:vbrPresets': v.void(),

  // ── 项目包 / 任务包 ────────────────────────────────────────────────────
  'package:exportProject': v.object({ projectId: Id, options: LooseObject }),
  'package:importProject': v.object({ path: v.string().max(2000), options: LooseObject }),
  'package:exportTask': v.object({ bookId: Id, actorId: Id, options: LooseObject }),
  'package:mergeTask': v.object({ projectId: Id, path: v.string().max(2000) }),
  'package:inspect': v.object({ path: v.string().max(2000) }),
  'package:listHistory': v.object({ projectId: Id }),
  'package:lastMergeReport': v.object({ projectId: Id }),

  // ── 设置与任务 ─────────────────────────────────────────────────────────
  'settings:get': v.object({ keys: v.optional(v.array(v.string().max(128), { max: 500 })) }),
  'settings:set': v.object({ patch: AppSettingsShape }),
  'settings:setSecret': v.object({ key: v.string().max(128), value: v.string({ max: 20_000, nonEmpty: false }) }),
  'settings:testProvider': v.object({
    provider: v.object({
      provider: v.enum(['mock', 'local', 'openai-compatible', 'dify']),
      baseUrl: v.string({ max: 2000, nonEmpty: false }),
      model: v.string({ max: 200, nonEmpty: false }),
      timeoutMs: v.number({ int: true, min: 1000, max: 600_000 }),
      maxConcurrency: v.number({ int: true, min: 1, max: 32 }),
      allowSendTextToCloud: v.boolean(),
      apiKey: OptString,
    }),
  }),
  'settings:reset': v.object({ keys: v.optional(v.array(v.string().max(128), { max: 500 })) }),

  'task:list': v.object({
    status: v.optional(v.array(TaskStatus, { max: 7 })),
    kind: v.optional(v.array(TaskKind, { max: 32 })),
    limit: v.optional(v.number({ int: true, min: 1, max: 1000 })),
  }),
  'task:get': v.object({ taskId: Id }),
  'task:cancel': v.object({ taskId: Id }),
  'task:retry': v.object({ taskId: Id }),
  'task:clearFinished': v.void(),
  'task:result': v.object({ taskId: Id }),

  'log:subscribe': v.object({ level: LogLevel }),
  'db:backup': v.void(),
  'db:listBackups': v.void(),
  'db:restore': v.object({ path: v.string().max(2000) }),
  'db:integrityCheck': v.void(),
  'db:stats': v.void(),
} satisfies Record<IpcChannel, Schema<unknown>>

/** 通道 → req 类型（供 handler 侧取用；等价 `z.infer`） */
export type ReqOf<C extends IpcChannel> = (typeof IPC_REQ_SCHEMAS)[C] extends Schema<infer T> ? T : never

/** 取某通道的 schema；契约外的通道返回 undefined（供自检使用） */
export function schemaFor(channel: string): Schema<unknown> | undefined {
  return (IPC_REQ_SCHEMAS as Record<string, Schema<unknown>>)[channel]
}

/** schema 覆盖的通道名（与 `IPC_CHANNELS` 比对用） */
export function schemaChannels(): string[] {
  return Object.keys(IPC_REQ_SCHEMAS).sort()
}
