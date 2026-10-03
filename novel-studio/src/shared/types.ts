/**
 * Novel Studio · 领域类型（主进程与渲染进程共享）
 * ============================================================================
 * 设计依据：
 *   · docs/03-数据模型与存储.md   —— 存储设计（snake_case 落在 SQLite）
 *   · docs/21-数据字典与SQL.md    —— 表与字段的权威定义
 *   · docs/11-功能域-画本编辑.md  §3 —— 画本行为何是唯一主轴
 *
 * 命名约定：
 *   · 本文件全部用 camelCase（领域类型）；存储层 snake_case 由 repository 的
 *     mappers.ts 负责转换，其他任何地方不得直接出现 snake_case 字段。
 *   · 布尔用真 boolean（存储层的 0/1 转换同样在映射层完成）。
 *   · 时间戳统一为 Unix 毫秒（number）。
 *   · 音频路径一律为「相对项目根目录」的相对路径，绝不存绝对路径
 *     （理由见 docs/03 §2）。
 */

// ============================================================================
// 基础别名
// ============================================================================

export type Id = string
/** Unix 毫秒 */
export type Timestamp = number

export const NARRATION_TRACK_ID = 'narration' as const
export type TrackId = typeof NARRATION_TRACK_ID | Id

// ============================================================================
// 项目与书籍
// ============================================================================

export interface Project {
  id: Id
  name: string
  description: string | null
  /** 唯一允许存绝对路径的地方（项目根目录） */
  rootDir: string
  schemaVersion: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type BookSourceType = 'txt' | 'docx' | 'pdf' | 'paste' | 'url'

export interface Book {
  id: Id
  projectId: Id
  title: string
  author: string | null
  /** 默认朗读/旁白配音员名，导出元数据用 */
  narrator: string
  language: string
  sourceType: BookSourceType
  sourcePath: string | null
  encoding: string | null
  /** 清洗后全文的 SHA-256，用于导入去重 */
  contentHash: string
  charCount: number
  chapterCount: number
  coverPath: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type ChapterKind = 'chapter' | 'front' | 'back' | 'extra' | 'volume'
export type ChapterCanvasState = 'none' | 'generated' | 'edited' | 'done'

export interface Chapter {
  id: Id
  bookId: Id
  seq: number
  title: string
  kind: ChapterKind
  volumeSeq: number | null
  volumeTitle: string | null
  charCount: number
  startOffset: number
  endOffset: number
  canvasState: ChapterCanvasState
  lineCount: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** 章节进度概览（对应 v_chapter_progress 视图） */
export interface ChapterProgress {
  chapterId: Id
  bookId: Id
  seq: number
  title: string
  lineCount: number
  recordedCount: number
  reviewCount: number
  unassignedCount: number
  audioMs: number
  charCount: number
}

// ============================================================================
// 导入相关（docs/10）
// ============================================================================

export interface EncodingDetection {
  encoding: string
  confidence: number
  candidates: Array<{ encoding: string; score: number; preview: string }>
  bomLength: number
  needsUserChoice: boolean
}

export interface CleanReport {
  removedAdLines: number
  removedDuplicateLines: number
  removedPageNumberLines: number
  removedZeroWidthChars: number
  normalizedNewlines: number
  suspiciousLines: Array<{ lineNo: number; text: string; reason: string }>
  remainingChars: number
}

export interface ChapterRule {
  id: string
  /** 正则源串（引擎自动加首尾锚点并允许前后空白） */
  linePattern: string
  maxLineLength: number
  requireBlankAround: boolean
  titleGroup: number
  kind: ChapterKind
}

export interface ChapterRuleSet {
  id: string
  name: string
  builtin: boolean
  patterns: ChapterRule[]
  allowNumericOnly: boolean
}

export interface ChapterDraft {
  tempId: string
  index: number
  title: string
  rawText: string
  charCount: number
  estimatedDurationMs: number
  kind: ChapterKind
  volumeIndex: number | null
  startOffset: number
  endOffset: number
  /** 是否勾选导入 */
  included: boolean
  /**
   * 「已是画本格式」的文档解析结果（仅 `importMode: 'canvas'` 时存在）。
   * 行与角色在导入时**直接落库**，不再跑画本判定。
   */
  canvasScript?: CanvasScriptChapter
}

// ---------------------------------------------------------------------------
// 画本脚本导入（文档本身已经是画本：`【角色名-CV名】“台词”`）
// ---------------------------------------------------------------------------

/** 画本脚本里的角色（来自文档中的角色表：序号/CV/角色名/性别/角色描述/台词数/音色/年龄） */
export interface CanvasScriptCharacter {
  name: string
  /** CV（配音员）名 */
  cv: string | null
  gender: string | null
  description: string | null
  /** 音色，如「青叔音」 */
  voiceType: string | null
  /** 年龄原文（可能是数字或「中年」） */
  ageText: string | null
  /** 角色表里的台词数原文 */
  lineCountText: string | null
}

/** 画本脚本里的一行 */
export interface CanvasScriptLine {
  /** null = 旁白 */
  speaker: string | null
  /** 该行的 CV（来自 `【角色-CV】`），旁白为 null */
  cv: string | null
  /** 实际要录的文本（已去掉【】与引号） */
  text: string
  /** inner = 标了（OS）/ 内心 的台词 */
  kind: 'dialogue' | 'narration' | 'inner'
  /** 原始整行（回溯/对照用） */
  sourceText: string
  /** 行内标注（如 `（OS）`）；没有则为 undefined */
  note?: string
  charStart: number
  charEnd: number
}

export interface CanvasScriptChapter {
  characters: CanvasScriptCharacter[]
  lines: CanvasScriptLine[]
}

export interface ImportFileProbe {
  kind: BookSourceType | 'unknown'
  sizeBytes: number
  hasTextLayer?: boolean
}

// ============================================================================
// 画本（docs/11 · 全系统唯一主轴）
// ============================================================================

export type SpeakerType = 'narration' | 'character'
export type LineKind = 'dialogue' | 'narration' | 'inner' | 'sfx_note'
export type LineState = 'draft' | 'assigned' | 'recorded' | 'aligned'
export type DecidedBy = 'rule' | 'vector' | 'llm' | 'human'
export type SpeedMark = 'slow' | 'normal' | 'fast'

export interface SpeakerCandidate {
  characterId: Id
  name: string
  score: number
}

export interface CanvasLine {
  id: Id
  chapterId: Id
  bookId: Id
  seq: number
  speakerType: SpeakerType
  characterId: Id | null
  kind: LineKind
  /** 实际要录的文本（已剥离引号，可被人工编辑） */
  text: string
  /** 原文对应片段（保留，便于对照与重算） */
  sourceText: string | null
  charStart: number
  charEnd: number
  emotion: string | null
  emotionIntensity: number | null
  speed: SpeedMark | null
  gainDb: number | null
  /** 句末留白（毫秒），对轨直接消费 */
  pauseAfterMs: number
  /** 句内停顿插入点（字符索引） */
  pauseInline: number[] | null
  pronunciation: string | null
  note: string | null
  state: LineState
  confidence: number | null
  candidates: SpeakerCandidate[] | null
  decidedBy: DecidedBy | null
  needsReview: boolean
  flags: string[]
  /** 章首标题念白行（docs/15 §7） */
  isTitle: boolean
  rev: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CanvasLinePatch {
  text?: string
  speakerType?: SpeakerType
  characterId?: Id | null
  kind?: LineKind
  emotion?: string | null
  emotionIntensity?: number | null
  speed?: SpeedMark | null
  gainDb?: number | null
  pauseAfterMs?: number
  pauseInline?: number[] | null
  pronunciation?: string | null
  note?: string | null
  needsReview?: boolean
  decidedBy?: DecidedBy
  flags?: string[]
  /**
   * 说话人判定置信度（0~1）与候选列表。
   * 重算（recompute）会连同 characterId/speakerType 一起回写，UI 的「低置信度」筛选依赖它。
   */
  confidence?: number | null
  candidates?: SpeakerCandidate[] | null
}

export interface CanvasGenerateOptions {
  useEmbedding: boolean
  useLlm: boolean
  contextWindow: number
  threshold: number
  margin: number
  ruleSetId: string | null
  /** 是否覆盖人工确认过的行（默认 false，永不覆盖） */
  overwriteHuman: boolean
  /** 情绪/语速自动标注 */
  inferTags: boolean
}

export interface CanvasGenerateReport {
  chapterId: Id
  totalLines: number
  byKind: Record<LineKind, number>
  bySpeaker: Array<{ characterId: Id | null; name: string; lines: number; chars: number }>
  byDecision: Record<DecidedBy, number>
  lowConfidence: number
  unmatchedQuote: number
  tooLong: number
  elapsedMs: number
  /** 是否真的用了向量判定（模型缺失时为 false，必须在 UI 明确告知） */
  embeddingUsed: boolean
  llmUsed: boolean
  warnings: string[]
}

export type QualityIssueKind =
  | 'empty_text'
  | 'too_long'
  | 'unassigned'
  | 'quote_unmatched'
  | 'no_character_ref'
  | 'narration_run'
  | 'dialogue_run'
  | 'no_pause'
  | 'suspicious_speaker'
  | 'missing_pronunciation'
  | 'recorded_missing'
  | 'duplicate_text'

export interface QualityIssue {
  kind: QualityIssueKind
  lineId: Id | null
  seq: number | null
  message: string
  /** 可否一键修复（安全项才允许） */
  autoFixable: boolean
}

// ============================================================================
// 角色与配音员（docs/11 §4.6 / §6.1）
// ============================================================================

export type Gender = 'male' | 'female' | 'other' | 'unknown'
export type AgeGroup = 'child' | 'teen' | 'young' | 'middle' | 'elder' | 'unknown'

export interface Character {
  id: Id
  bookId: Id
  name: string
  aliases: string[]
  gender: Gender | null
  ageGroup: AgeGroup | null
  description: string | null
  note: string | null
  /** UI 配色 */
  color: string | null
  defaultSpeed: SpeedMark | null
  defaultEmotion: string | null
  defaultGainDb: number | null
  defaultPauseMs: number | null
  isArchived: boolean
  sortOrder: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CharacterCandidate {
  name: string
  aliases: string[]
  occurrences: number
  /** 首次出现的章节标题，帮助人工确认 */
  firstChapterTitle: string | null
  /**
   * 出现过的章节数（迁移自 Online-novel-character-extraction 的聚合口径）。
   * 比 occurrences 更能说明「这是个稳定角色」：碎片往往只在一章里反复出现。
   */
  chapterCount?: number
  /**
   * 四类描述（外貌/性格/语言/特征），各取**最长**的一段（上游 best_appearance 规则）。
   * 目前由**规则**从正文里抽（关键词句式），拿不到时字段为 null —— 不是「没有外貌」的意思。
   */
  descriptions?: {
    appearance: string | null
    personality: string | null
    speech: string | null
    feature: string | null
  }
}

export interface CharacterStats {
  characterId: Id
  lines: number
  chars: number
  estimatedDurationMs: number
  recordedMs: number
}

export interface VoiceActor {
  id: Id
  projectId: Id
  name: string
  contact: string | null
  note: string | null
  profile: VoiceProfile | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface VoiceProfile {
  samplePath: string | null
  gender: Gender
  /** Hz */
  pitchRange: [number, number] | null
  /** 字/秒 */
  speechRate: number | null
}

export interface ActorWorkload {
  actorId: Id
  name: string
  lines: number
  chars: number
  estimatedDurationMs: number
  recordedCount: number
}

// ============================================================================
// 录音与片段（docs/12）
// ============================================================================

export type RecordingMode = 'line_by_line' | 'continuous' | 'role' | 'punch_in' | 'package'
export type SessionStatus = 'active' | 'finalized' | 'aborted' | 'recovered' | 'failed'

export type RecordSessionState =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'done'
  | 'recovered'
  | 'failed'

export interface AudioFormat {
  sampleRate: number
  bitDepth: 16 | 24 | 32
  channels: 1 | 2
}

/** 32 = float32（可救增益失误，docs/05 §2.5 建议默认） */
export const FLOAT32_BIT_DEPTH = 32 as const

export interface RecordingSession {
  id: Id
  projectId: Id
  chapterId: Id | null
  mode: RecordingMode
  actorId: Id | null
  /** 相对项目根：recordings/{id}.wav */
  filePath: string
  format: AudioFormat
  durationMs: number
  peakDb: number | null
  rmsDb: number | null
  gainDb: number
  deviceLabel: string | null
  deviceId: string | null
  /** 必须恒为 0（docs/12 §13）；非 0 即 P0 缺陷 */
  droppedFrames: number
  status: SessionStatus
  marks: Array<{ kind: 'cut' | 'retake' | 'note'; atMs: number }>
  startedAt: Timestamp
  finishedAt: Timestamp | null
}

export interface Take {
  id: Id
  lineId: Id
  sessionId: Id | null
  filePath: string
  /** 超长行分段录时的顺序（docs/12 §3.3） */
  partIndex: number
  srcInMs: number
  srcOutMs: number
  trimmedInMs: number
  trimmedOutMs: number
  durationMs: number
  peakDb: number | null
  rmsDb: number | null
  lufs: number | null
  gainDb: number
  format: AudioFormat
  source: 'local' | 'package' | 'import'
  packageId: Id | null
  flags: string[]
  isSelected: boolean
  note: string | null
  recordedAt: Timestamp
  createdAt: Timestamp
}

export interface VoiceSegment {
  id: Id
  lineId: Id
  chapterId: Id
  takeId: Id | null
  filePath: string
  /** 处理链派生文件（非破坏性，docs/03 §6） */
  processedPath: string | null
  presetHash: string | null
  srcInMs: number
  srcOutMs: number
  durationMs: number
  peakDb: number | null
  rmsDb: number | null
  lufs: number | null
  flags: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AudioMetrics {
  filePath: string
  fileSize: number
  mtime: Timestamp
  durationMs: number
  peakDb: number | null
  truePeakDb: number | null
  rmsDb: number | null
  lufs: number | null
  lra: number | null
  sampleRate: number | null
  channels: number | null
  measuredAt: Timestamp
}

/** VAD 切片（docs/05 §4） */
export interface VadSlice {
  id: string
  sessionId: Id
  sliceIndex: number
  startMs: number
  endMs: number
  rmsDb: number | null
  peakDb: number | null
  matchedLine: Id | null
  matchScore: number | null
  accepted: boolean
  flags: string[]
}

export interface SliceMatch {
  sliceIndex: number
  lineId: Id
  confidence: number
}

export interface VadOptions {
  enabled: boolean
  silenceDb: number
  minSilenceMs: number
  minSpeechMs: number
  minSliceMs: number
  maxSliceMs: number
  headRollbackMs: number
  tailKeepMs: number
  autoNoiseFloor: boolean
  /**
   * 间隔小于此值的两段语音**合并**成一片（默认 250 ms，见 `VAD_BRIDGE_GAP_MS`）。
   *
   * 为什么导入场景需要调小它：录制场景合并短间隙是对的（句内停顿不该切片），
   * 但**导入既成音频**时相反 —— 「按说话人导入」的文件是一个说话人连续念整章，
   * 句与句之间往往只有 100~250 ms 的短停顿。若把它们桥接掉，VAD 就只能切出
   * 「几行一片」的大片，接着只能**按字符比例硬切**，音与文本就会错位
   * （真机反馈：导入后第 N 行的音和文本对不上）。
   *
   * 不传 = 用 `VAD_BRIDGE_GAP_MS`（录制路径行为不变）。
   */
  bridgeGapMs?: number
  /** 中文语速估算用（字/秒），用于估算画本行期望时长 */
  charsPerSecond: number
}

export interface TrimOptions {
  enabled: boolean
  thresholdDb: number
  headPaddingMs: number
  tailPaddingMs: number
}

export interface RecordPrepareResult {
  sessionId: Id
  warnings: string[]
}

export interface RecordStopResult {
  session: RecordingSession
  take: Take | null
  segment: VoiceSegment | null
}

export interface AudioDeviceInfo {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
  isDefault: boolean
}

export interface DeviceSelfTestResult {
  hasSignal: boolean
  clipping: boolean
  droppedFrames: number
  noiseFloorDb: number | null
  peakDb: number | null
  rmsDb: number | null
  requestedSampleRate: number
  actualSampleRate: number
  latencyMs: number | null
  suggestion: string | null
}

// ============================================================================
// 对轨（docs/13）
// ============================================================================

export type ArrangeStrategy = 'serialize' | 'keep' | 'compress-pause' | 'tighten'

export interface Arrangement {
  id: Id
  chapterId: Id
  name: string
  isDefault: boolean
  strategy: ArrangeStrategy
  totalDurationMs: number
  /** 每次整体重排 +1，供导出 paramsHash 使用 */
  version: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ArrangementItem {
  id: Id
  arrangementId: Id
  segmentId: Id
  lineId: Id
  trackId: TrackId
  timelineStartMs: number
  srcInMs: number
  srcOutMs: number
  fadeInMs: number
  fadeOutMs: number
  locked: boolean
  orderInTrack: number
  overlapWith: Id | null
}

export interface ArrangementItemPatch {
  timelineStartMs?: number
  srcInMs?: number
  srcOutMs?: number
  fadeInMs?: number
  fadeOutMs?: number
  locked?: boolean
  /**
   * 轨内顺序号。重排（autoArrange）/ 重置为自动（resetItemToAuto）会整体改写它，
   * 因此必须可 patch —— 否则「重置」只能改时间不改顺序，导出时会按旧序号重排。
   */
  orderInTrack?: number
}

export type AlignIssueKind =
  | 'missing_line'
  /** 有录音（voice_segments）但方案里没有对应条目 —— 会被渲染/导出丢掉，必须重新排布 */
  | 'unarranged_line'
  | 'orphan_segment'
  | 'same_track_overlap'
  | 'cross_track_overlap_warn'
  | 'long_gap'
  | 'short_segment'
  | 'long_segment'
  | 'silent_segment'
  | 'clipped_segment'
  | 'file_missing'
  | 'wrong_order'

export interface ArrangementValidation {
  missingLines: Id[]
  /** 有片段但不在方案条目里的画本行（渲染会丢音频；需重新自动排布） */
  unarrangedLines: Id[]
  orphanSegments: Id[]
  sameTrackOverlaps: Array<{ a: Id; b: Id; overlapMs: number }>
  crossTrackOverlaps: Array<{ a: Id; b: Id; overlapMs: number; level: 'normal' | 'warning' }>
  longGaps: Array<{ afterLineId: Id; gapMs: number }>
  shortSegments: Id[]
  longSegments: Id[]
  issues: Array<{ kind: AlignIssueKind; message: string; lineId: Id | null; itemId: Id | null }>
  totalDurationMs: number
  warnings: string[]
}

// ============================================================================
// 处理链与预设（docs/14）
// ============================================================================

export interface EqBand {
  id: string
  type: 'lowshelf' | 'highshelf' | 'peak' | 'lowpass' | 'highpass'
  freq: number
  gainDb: number
  q: number
  enabled: boolean
}

export interface ProcessChain {
  highpass: { enabled: boolean; freq: number; poles: 1 | 2 }
  denoise: { enabled: boolean; nr: number; nf: number; tn: boolean }
  deesser: { enabled: boolean; intensity: number; freq: number }
  eq: EqBand[]
  compressor: {
    enabled: boolean
    thresholdDb: number
    ratio: number
    attackMs: number
    releaseMs: number
    makeupDb: number
  }
  limiter: { enabled: boolean; limitDb: number; attackMs: number; releaseMs: number }
  repair: {
    dcOffset: boolean
    polarityInvert: boolean
    declick: Array<{ atMs: number; lengthMs: number }>
    silenceFill: Array<{ startMs: number; endMs: number }>
    tempo: { enabled: boolean; factor: number }
  }
}

export interface ProcessPreset {
  id: Id
  projectId: Id | null
  name: string
  description: string | null
  builtin: boolean
  chain: ProcessChain
  tags: string[]
  sortOrder: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type ProcessScope = 'segment' | 'character' | 'chapter' | 'book'

export interface MusicAsset {
  id: Id
  projectId: Id
  kind: 'bgm' | 'sfx'
  name: string
  filePath: string
  originalName: string | null
  durationMs: number | null
  sampleRate: number | null
  channels: number | null
  peakDb: number | null
  lufs: number | null
  loopable: boolean
  tags: string[]
  note: string | null
  licenseNote: string | null
  createdAt: Timestamp
}

export interface DuckingConfig {
  enabled: boolean
  amountDb: number
  thresholdDb: number
  attackMs: number
  releaseMs: number
  mode: 'sidechain' | 'envelope'
}

// ============================================================================
// 混音与导出（docs/15）
// ============================================================================

export type BusKind = 'voice' | 'music' | 'sfx'

export interface MixTrack {
  id: Id
  mixProjectId: Id
  kind: BusKind
  refId: Id | null
  name: string
  gainDb: number
  pan: number
  isMute: boolean
  isSolo: boolean
  presetId: Id | null
  sortOrder: number
  music: MusicTrackConfig | null
}

export interface MusicTrackConfig {
  assetId: Id
  startMs: number
  endMs: number | null
  loop: boolean
  fadeInMs: number
  fadeOutMs: number
  ducking: DuckingConfig
}

export interface MixMaster {
  targetLufs: number
  truePeakDb: number
  lra: number
  limiterEnabled: boolean
  sampleRate: 44100 | 48000
  channels: 1 | 2
}

export interface MixProject {
  id: Id
  chapterId: Id
  arrangementId: Id
  name: string
  isDefault: boolean
  tracks: MixTrack[]
  master: MixMaster
  headSilenceMs: number
  tailSilenceMs: number
  titleReading: { enabled: boolean; lineId: Id | null; tailPauseMs: number }
  version: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type ExportFormat = 'mp3' | 'wav' | 'm4a'
export type ExportOverwrite = 'skip' | 'overwrite' | 'rename'

export interface ExportParams {
  format: ExportFormat
  mp3Bitrate: 128 | 192 | 256 | 320
  m4bBitrate: 64 | 96 | 128 | 192
  sampleRate: 44100 | 48000
  targetLufs: number
  truePeakDb: number
  lra: number
  headSilenceMs: number
  tailSilenceMs: number
  outputDir: string
  fileNameTemplate: string
  metadata: ExportMetadata
  overwrite: ExportOverwrite
  /** 每 N 章一卷；0 = 不拆分（>200 章时部分播放器章节异常） */
  splitM4bEvery: number
}

export interface ExportMetadata {
  title?: string
  artist?: string
  album?: string
  narrator?: string
  genre?: string
  date?: string
  coverPath?: string | null
}

export type ExportStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted'

export interface ExportChapterResult {
  chapterIndex: number
  chapterId: Id
  title: string
  durationMs: number
  measuredLufs: number | null
  measuredTpDbfs: number | null
  targetLufs: number
  adjustedGainDb: number | null
  output: string
  sizeBytes: number | null
  skipped: boolean
  warnings: string[]
}

export interface ExportReport {
  jobId: Id
  projectId: Id
  bookId: Id
  mixProjectId: Id | null
  arrangementId: Id | null
  startedAt: Timestamp
  finishedAt: Timestamp | null
  elapsedMs: number
  params: ExportParams
  chapters: ExportChapterResult[]
  summary: {
    total: number
    succeeded: number
    skipped: number
    failed: number
    warnings: number
    totalDurationMs: number
  }
  m4b: { path: string; chapters: number; sizeBytes: number; verified: boolean } | null
}

export interface QcPreCheckResult {
  /** 阻断项：必须处理才能导出 */
  blockers: Array<{ kind: string; message: string; lineId: Id | null; chapterId: Id | null }>
  warnings: Array<{ kind: string; message: string; lineId: Id | null; chapterId: Id | null }>
  stats: {
    chapters: number
    lines: number
    recordedLines: number
    missingLines: number
    totalDurationMs: number
    cutCount: number
  }
}

export interface LoudnessMeasurement {
  inputI: number
  inputTp: number
  inputLra: number
  inputThresh: number
  targetOffset: number
}

// ============================================================================
// 任务队列（docs/04 §2）
// ============================================================================

export type TaskKind =
  | 'book.import'
  | 'canvas.generate'
  /**
   * 批量生成画本（章节管理的「批量生成画本」）：**一条任务**处理 N 章。
   *
   * 为什么单独一个 kind：批量若逐章入队，用户会在章节管理看到 N 张进度卡
   * （真机上表现为「一直弹出进度为 0 的标签」），任务中心也会被 N 条记录淹没。
   * 合成一条任务后，进度只有一份，失败也只重试这一条。
   */
  | 'canvas.generate.batch'
  /**
   * 重算说话人判定（`canvas:recomputeAttribution`）。
   *
   * 为什么单独一个 kind 而不是复用 `canvas.generate`：两者在任务中心里是**不同的事**
   * ——生成是「从正文造出画本行」，重算是「对已有行重新判定归属」。共用一个 kind
   * 会让用户看到「生成画本」却发生了重算，也让失败重试的语义含混。
   */
  | 'canvas.recompute'
  /**
   * 重建角色原型向量（`character:rebuildCentroid`）。
   *
   * 为什么单独一个 kind：它是**纯维护性**任务（把已判定行的向量重新汇总成角色原型），
   * 既不产出用户可见的新内容，也不改画本行 —— 和「生成 / 重算」混在一起会让
   * 任务中心的列表分不清「刚才那次跑了什么」。
   */
  | 'character.centroid'
  | 'embedding.batch'
  | 'asr.transcribe'
  | 'audio.process'
  | 'audio.render'
  | 'export.chapter'
  | 'export.book'
  | 'package.export'
  | 'package.import'
  | 'package.merge'
  /**
   * 按说话人导入音频（`record:importStart`）。
   *
   * 为什么必须是任务而不是一次同步调用：一个文件要「解码 → 逐帧能量 → VAD → 铺满每行」
   * （真机样本最大 30 MB / 74 章），几十个文件就是几分钟。放在 IPC 里同步做，
   * 渲染进程会一直转圈、用户不能离开向导；做成任务后可以关掉向导、在任务中心看进度，
   * 而且失败能重试、重启能续（队列的既有能力）。
   */
  | 'audioImport.apply'
  | 'db.backup'
  | 'cache.clean'

export type TaskStatus =
  | 'queued'
  | 'waiting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface TaskRecord<TResult = unknown> {
  id: Id
  kind: TaskKind
  status: TaskStatus
  priority: number
  projectId: Id | null
  progress: number
  stage: string | null
  result: TResult | null
  error: string | null
  attempts: number
  maxAttempts: number
  concurrencyKey: string | null
  dedupeKey: string | null
  createdAt: Timestamp
  startedAt: Timestamp | null
  finishedAt: Timestamp | null
}

export interface TaskProgressEvent {
  taskId: Id
  kind: TaskKind
  progress: number
  stage?: string
  etaMs?: number
  throughput?: { unit: string; perSecond: number }
}

export interface TaskFinishedEvent {
  taskId: Id
  status: TaskStatus
  result?: unknown
  error?: unknown
}

// ============================================================================
// 项目包 / 任务包（docs/03 §8 §9）
// ============================================================================

export interface NspManifest {
  format: 'nsp'
  formatVersion: number
  app: { name: string; version: string }
  schemaVersion: number
  exportedAt: string
  project: { id: Id; name: string; totalDurationMs: number }
  contents: {
    database: boolean
    recordings: boolean
    takes: boolean
    segments: boolean
    processed: boolean
    exports: boolean
    music: boolean
  }
  counts: { chapters: number; lines: number; segments: number }
  files: number
  uncompressedBytes: number
}

export interface NstManifest {
  format: 'nst'
  formatVersion: number
  packageId: Id
  source: { projectId: Id; bookId: Id; exportedAt: string }
  assignee: { voiceActorId: Id | null; name: string; note: string | null }
  recordSettings: {
    sampleRate: number
    bitDepth: number
    channels: number
    fileNameTemplate: string
    recommendGainDb: number
    targetPeakDb: number
  }
  characters: Array<{
    id: Id
    name: string
    note: string | null
    defaultSpeed: SpeedMark | null
    defaultEmotion: string | null
  }>
  lines: NstLine[]
  /** 下发时的画本快照哈希，回收时比对是否已变更 */
  linesHash: string
}

export interface NstLine {
  id: Id
  seq: number
  chapterTitle: string
  characterId: Id | null
  characterName: string
  text: string
  emotion: string | null
  emotionIntensity: number | null
  speed: SpeedMark | null
  pauseAfterMs: number
  pronunciation: string | null
  note: string | null
  prevLine: string | null
  nextLine: string | null
  hasReference: boolean
}

export interface NstTakesFile {
  takes: Array<{
    lineId: Id
    takeId: Id
    fileName: string
    durationMs: number
    peakDb: number | null
    recordedAt: Timestamp
    device: string | null
  }>
}

export interface PackageHistoryEntry {
  id: Id
  kind: 'nsp' | 'nst'
  direction: 'export' | 'import' | 'merge'
  actorId: Id | null
  actorName: string | null
  filePath: string
  linesHash: string | null
  stats: Record<string, number> | null
  report: TaskPackageMergeReport | null
  createdAt: Timestamp
}

export interface TaskPackageMergeReport {
  packageId: Id
  actorName: string
  placed: number
  missing: Id[]
  unknown: Id[]
  checksumFailed: number
  corrupted: number
  linesChanged: boolean
  diffCount: number
  duplicateTakes: number
  adopted: number
}

// ============================================================================
// 设置（docs/04 §8.2）
// ============================================================================

export interface AppSettings {
  paths: {
    projectRoot: string
    exportDir: string
    ffmpegPath: string | null
    modelDir: string | null
    cacheDir: string
    backupDir: string
  }
  audio: {
    sampleRate: 44100 | 48000
    bitDepth: 16 | 24 | 32
    channels: 1 | 2
    defaultInputDeviceId: string | null
    monitorEnabled: boolean
    monitorGainDb: number
    inputGainDb: number
    agcEnabled: boolean
    countdownMs: number
    autoTrim: boolean
    trimThresholdDb: number
    trimPaddingMs: number
    echoCancellation: boolean
    /**
     * 录音设备 id → label 快照。
     *
     * 为什么主进程要存这个：`navigator.mediaDevices.enumerateDevices()` 只能在渲染进程调用，
     * 且**未授权时拿不到 label**（docs/12 §11）。主进程把用户见过的 label 存下来，
     * 这样「已拔掉但仍在偏好里」的设备在设置页里也能显示成人话，而不是一串 id。
     */
    deviceLabels: Record<string, string>
    /** 最近一次「录 5 秒并回放」自检结果（docs/12 §11：自检结果存主进程） */
    lastSelfTest: DeviceSelfTestResult | null
  }
  recording: {
    defaultMode: RecordingMode
    stopKey: string
    nextLineKey: string
    redoKey: string
    playKey: string
    footPedalEnabled: boolean
    footPedalMapping: Record<string, string>
    vad: VadOptions
    maxSessionMinutes: number
  }
  canvas: {
    /** 归属判定阈值（默认 0.62，docs/06 §5.2） */
    attributionThreshold: number
    /** Top1 与 Top2 的最小差值（默认 0.06） */
    attributionMargin: number
    contextWindow: number
    autoAcceptConfidence: number
    defaultPauseAfterMs: number
    defaultEmotion: string
    maxLineChars: number
    maxNarrationRun: number
    shortLineChars: number
  }
  mixing: {
    targetLufs: number
    truePeakDb: number
    headSilenceMs: number
    tailSilenceMs: number
    defaultMusicGainDb: number
    duckAmountDb: number
    duckAttackMs: number
    duckReleaseMs: number
    maxCrossTrackOverlapMs: number
    maxGapMs: number
  }
  export: {
    format: ExportFormat
    mp3Bitrate: 128 | 192 | 256 | 320
    m4bBitrate: 64 | 96 | 128 | 192
    fileNameTemplate: string
    chapterTitleTemplate: string
    writeMetadata: boolean
    coverPath: string | null
    splitM4bEvery: number
  }
  ai: {
    provider: 'mock' | 'local' | 'openai-compatible' | 'dify'
    baseUrl: string
    model: string
    timeoutMs: number
    maxConcurrency: number
    allowSendTextToCloud: boolean
  }
  embedding: { modelId: string; batchSize: number; threads: number }
  asr: { modelId: string; language: string; threads: number; translate: boolean }
  import: { maxFileSizeBytes: number; maxUrlPages: number; fetchDelayMs: number }
  ui: { theme: 'light' | 'dark' | 'system'; language: string; editorDensity: 'compact' | 'normal' | 'relaxed' }
  advanced: {
    logLevel: 'error' | 'warn' | 'info' | 'debug' | 'trace'
    autoBackup: 'daily' | 'weekly' | 'off'
    keepBackups: number
    autoCleanupTakes: boolean
  }
}

// ============================================================================
// 按说话人导入音频（docs/12 §录音域、docs/91 §5.2.49）
// ============================================================================
//
// 这一组类型是**跨进程契约**：主进程的服务层直接构造它们，渲染进程只读。
// 所以刻意**不引用** `src/shared/audio-import/**` 里的内部类型
// （那些是纯逻辑层的实现细节，改它们不该影响 IPC 契约）。

/** 画本扫描摘要（`record:importScanCanvas` 的响应） */
export interface AudioImportCanvasScan {
  filePath: string
  /** 文档章节号 ↔ 数据库章节 id 的对齐结果（只含数据库里真实存在的章节） */
  chapters: Array<{ no: number; chapterId: Id; title: string; lineCount: number }>
  characters: Array<{ id: Id; name: string; aliases: string[] }>
  voiceActors: Array<{ id: Id; name: string }>
  /** 画本里出现过的 CV 名（来自角色表与正文标记） */
  canvasCvs: string[]
  /** 文档里的章节号范围（可能超出数据库已有章节，UI 要据此提示） */
  documentChapterRange: { from: number; to: number } | null
  /** 文档解析警告（结构不规范之处），UI 应展示而不是静默忽略 */
  warnings: Array<{ sourceLine: number; reason: string; detail: string; sample?: string }>
}

/** 扫描到的音频候选文件（**含命名不合规的**，见 `parseError`） */
export interface AudioImportCandidate {
  filePath: string
  fileName: string
  sizeBytes: number
  /** 时长；ffmpeg 不可用或探测失败时为 null（不是 0 —— 0 表示「真的是 0 秒」） */
  durationMs: number | null
  /**
   * 文件名解析失败的原因（`null` = 解析成功）。
   *
   * 为什么扫描结果要**带着**不合规的文件：真机反馈「目录里 24 个文件，扫描只扫出 6 个」——
   * 以前这里把解析失败的文件直接丢掉，用户只看到一个变小的数字，
   * 既不知道少了几个、也不知道少了哪些、更不知道该怎么改名。
   * 界面必须把「跳过了哪些文件、为什么」如实列出来。
   */
  parseError?: { reason: string; detail: string } | null
}

/** 人工修正（覆盖自动判定） */
export interface AudioImportFileOverride {
  character?: string | null
  cv?: string | null
  narration?: boolean
  /**
   * 章节区间（文件名解析不出区间时必填）。
   *
   * 「解析不出的文件」既要能指定说话人、也要能指定它覆盖哪些章 ——
   * 否则没有区间就选不出行，指定了角色也没用。
   */
  fromChapter?: number | null
  toChapter?: number | null
}

/** 请求里描述一个待导入文件 */
export interface AudioImportFileRequest {
  filePath: string
  overrides?: AudioImportFileOverride
}

export type AudioImportFileStatus =
  | 'ready'
  | 'needs-review'
  | 'unresolved-speaker'
  | 'no-lines'
  | 'invalid-name'
  | 'duplicate-lines'

/** 单个文件的导入计划 */
export interface AudioImportFilePlan {
  filePath: string
  fileName: string
  sizeBytes: number
  durationMs: number | null
  status: AudioImportFileStatus
  /** 章节区间（文件名解析成功时有值） */
  range: { from: number; to: number } | null
  /** 区间里画本实际存在的章节号 */
  chaptersInCanvas: number[]
  /** 区间里画本没有的章节号（用于提示「有 N 章不在画本里」） */
  chaptersMissingInCanvas: number[]
  /** 命中画本行数 */
  lineCount: number
  /** 命中行的章节分布 */
  linesByChapter: Record<number, number>
  /**
   * 命中行样例（供 UI 预览）。
   *
   * ⚠️ 这里刻意**不提供**「命中行的 id 列表」。
   *   原因：预览走**文档行**（编号是文档行号）、导入走**数据库行**（编号是 `seq`），
   *   两个编号空间不同。把其中任一当成「要导入的行」暴露出去，
   *   都会诱使调用方拿它去查库 —— 而那样查到的行**未必是同一批**。
   *   要展示就先展示 `samples`，要落库就交给服务层按同一个目标重算。
   */
  samples: Array<{ chapterNo: number; character: string; text: string }>
  /** 与别的文件重叠的行数 */
  overlappingLineCount: number
  /** 说话人目标说明（UI 直接显示） */
  targetExplanation: string | null
  /** 目标类型（UI 据此决定给用户哪些修正选项） */
  targetKind: string | null
  /** CV 匹配方式与置信度 */
  cvMatchedName: string | null
  cvMatchMethod: string
  cvConfidence: number
  /** 需要用户注意的说明 */
  notes: string[]
}

export interface AudioImportPlanSummary {
  totalFiles: number
  readyFiles: number
  needsReviewFiles: number
  unresolvedFiles: number
  noLinesFiles: number
  invalidFiles: number
  overlappingFiles: number
  duplicatedLineCount: number
  totalLines: number
  totalDurationMs: number
  totalBytes: number
  canvasChapterRange: { from: number; to: number } | null
  availableCvs: string[]
  availableCharacters: string[]
}

/** 导入预览（`record:importPlan` 的响应） */
export interface AudioImportPlan {
  files: AudioImportFilePlan[]
  summary: AudioImportPlanSummary
  warnings: string[]
}

/** 单个文件的导入结果 */
export interface AudioImportFileResult {
  fileName: string
  lineCount: number
  createdTakes: number
  error: string | null
  /**
   * 这个文件的音频是怎么切到行上的（docs/91 §5.2.49 ⑮）。
   *
   * - `vad`            按 VAD 语音片切分，边界落在句间静音上（最可信）
   * - `whole-timeline` VAD 没找到静音间隙，按每行文本长度**按比例**硬切
   * - `empty`          解出来是空音频，没有产生任何区间（此时 `createdTakes` 为 0）
   * - `none`           没有解码能力（缺依赖 / 解码失败），退回**整段 take**
   *
   * 为什么必须回报给渲染进程：`createdTakes` 相同的两次导入，听感可能完全不同 ——
   * 「整段 take」意味着每一行听到的都是同一整段音频。UI 必须能区分并提示用户。
   */
  splitMethod: 'asr' | 'vad' | 'whole-timeline' | 'empty' | 'none'
  /** 切出的段数（VAD 的语音片数 / ASR 的识别段数；0 = 没切） */
  sliceCount: number
  /** 区间不可信、建议试听复核的行数（`splitMethod !== 'vad'` 时通常 > 0） */
  needsReview: number
}

/** 导入执行结果（`record:importApply` 的响应） */
export interface AudioImportApplyResult {
  files: number
  createdTakes: number
  createdSegments: number
  markedRecorded: number
  skipped: Array<{ fileName: string; reason: string }>
  perFile: AudioImportFileResult[]
}



export interface FfmpegCapabilities {
  version: string
  available: boolean
  path: string | null
  filters: string[]
  /** 探测到缺失的关键滤镜（UI 据此隐藏控件，而不是等用户点了才报错） */
  missing: string[]
  encoders: string[]
}

export interface ModelStatus {
  id: string
  kind: 'whisper' | 'embedding'
  filePath: string
  exists: boolean
  expectedSha256: string | null
  actualSha256: string | null
  sizeBytes: number | null
  ok: boolean
  message: string | null
}

export interface AppCapabilities {
  ffmpeg: FfmpegCapabilities
  models: ModelStatus[]
  secureStorage: boolean
  embedding: { modelId: string; dim: number; available: boolean }
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  arch: string
  isPackaged: boolean
  portable: boolean
}

export interface AppPaths {
  userData: string
  projectRoot: string
  exportDir: string
  cacheDir: string
  logDir: string
  backupDir: string
  modelDir: string
  resourceDir: string
}
