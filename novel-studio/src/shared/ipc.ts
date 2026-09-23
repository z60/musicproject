/**
 * Novel Studio · IPC 契约（唯一来源）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md
 *
 * 规则（违反即为缺陷）：
 *   1. 本文件是通道名与载荷类型的**唯一来源**。主进程 handler 注册、渲染进程
 *      调用、preload 白名单全部引用它，不允许任何地方出现裸字符串通道名。
 *   2. 主进程 handler **永不 throw**，统一返回 IpcResult<T>：
 *        { ok: true, data } | { ok: false, error: SerializedAppError }
 *      理由是 ipcMain.handle 抛出的异常经 Electron 序列化后会丢掉自定义字段
 *      （code / severity / retryable），只剩一个字符串（docs/22 §6.1）。
 *   3. 本文件只放「传输契约」；业务领域类型在 types.ts，错误机制在 errors.ts。
 *
 * 通道命名：<域>:<动作>，全小写，冒号分隔。事件名同构。
 */

import type {
  ActorWorkload,
  AlignIssueKind,
  AppCapabilities,
  AppInfo,
  AppPaths,
  AppSettings,
  Arrangement,
  ArrangementItem,
  ArrangementItemPatch,
  ArrangementValidation,
  AudioDeviceInfo,
  AudioFormat,
  AudioMetrics,
  Book,
  CanvasGenerateOptions,
  CanvasGenerateReport,
  CanvasLine,
  CanvasLinePatch,
  Chapter,
  ChapterDraft,
  ChapterProgress,
  ChapterRuleSet,
  Character,
  CharacterCandidate,
  CharacterStats,
  CleanReport,
  DeviceSelfTestResult,
  EncodingDetection,
  
  ExportParams,
  ExportReport,
  Id,
  ImportFileProbe,
  LoudnessMeasurement,
  MusicAsset,
  MixProject,
  PackageHistoryEntry,
  ProcessChain,
  ProcessPreset,
  ProcessScope,
  QcPreCheckResult,
  QualityIssue,
  RecordPrepareResult,
  RecordStopResult,
  RecordSessionState,
  RecordingMode,
  
  SliceMatch,
  TaskKind,
  TaskProgressEvent,
  TaskRecord,
  TaskStatus,
  Take,
  TaskPackageMergeReport,
  TrimOptions,
  VadOptions,
  VadSlice,
  VoiceSegment,
  VoiceActor,
} from './types.ts'

// ============================================================================
// 统一响应形状
// ============================================================================

/** 过 IPC 的错误结构（字段定义见 docs/22 §3；序列化实现见 errors.ts） */
export interface SerializedAppError {
  /** 语义键，如 RECORD_DEVICE_LOST */
  code: string
  /** 派生数字编号，如 E20002（日志与报障用） */
  numericCode: string
  /** 已插值的标题（仅供日志 grep，UI 请用 getMessage 取 title/detail/hint） */
  message: string
  severity: 'info' | 'warning' | 'error' | 'fatal'
  action: 'retry' | 'open_settings' | 'open_folder' | 'reload' | 'contact_support' | 'dismiss' | 'none'
  retryable: boolean
  params: Record<string, string | number>
  /** 结构化上下文，只进日志 */
  details?: Record<string, unknown>
  /** 原始错误摘要链，只进日志 */
  causeChain?: string[]
  stack?: string
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedAppError }

/** 空载荷通道用 void（渲染侧调用时传 undefined） */
export type NoReq = void

// ============================================================================
// 通道契约表
// ============================================================================

export interface IpcContract {
  // ── 应用与系统 ────────────────────────────────────────────────────────────
  'app:getInfo': { req: NoReq; res: AppInfo }
  'app:getPaths': { req: NoReq; res: AppPaths }
  'app:getCapabilities': { req: NoReq; res: AppCapabilities }
  'app:openExternal': { req: { url: string }; res: { ok: boolean } }
  'app:showItemInFolder': { req: { path: string }; res: { ok: boolean } }
  'app:openFolderDialog': { req: { title?: string; defaultPath?: string }; res: { path: string | null } }
  'app:openFileDialog': {
    req: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multi?: boolean }
    res: { paths: string[] }
  }
  'app:saveFileDialog': { req: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }; res: { path: string | null } }
  'app:diagnostics': { req: NoReq; res: { reportPath: string } }
  'app:quit': { req: { force?: boolean }; res: { ok: boolean } }

  // ── 书籍与章节 ────────────────────────────────────────────────────────────
  'book:list': { req: { projectId?: Id }; res: Book[] }
  'book:get': { req: { bookId: Id }; res: Book }
  'book:update': { req: { bookId: Id; patch: Partial<Pick<Book, 'title' | 'author' | 'narrator' | 'language' | 'coverPath'>> }; res: Book }
  'book:delete': { req: { bookId: Id; deleteAudio?: boolean }; res: { ok: boolean } }
  'book:probeFile': { req: { filePath: string }; res: ImportFileProbe }
  'book:detectEncoding': { req: { filePath: string; sampleBytes?: number }; res: EncodingDetection }
  'book:previewSplit': {
    /**
     * `importMode: 'canvas'`：文档本身已经是画本（【角色-CV】“台词” + 角色表），
     * 提交入库时直接写画本行，不再跑说话人判定。
     */
    req: {
      filePath?: string
      text?: string
      ruleSetId?: string | null
      cleanOptions?: Record<string, boolean>
      importMode?: 'text' | 'canvas'
    }
    /**
     * `contentHash` 必须回传（docs/10 §9）：去重要在**提交之前**用同一个哈希查
     * `book:findDuplicate`，而 `book:commitImport` 的 `source.contentHash` 是**非空**必填。
     * 少了它，导入到最后一步必然被 schema 拒收（真机事故 docs/91 §5.2.6）。
     */
    res: { drafts: ChapterDraft[]; cleanReport: CleanReport; encoding: string; contentHash: string }
  }
  'book:commitImport': {
    req: {
      projectId: Id
      bookMeta: { title: string; author?: string | null; narrator?: string; language?: string; coverPath?: string | null }
      source: { type: Book['sourceType']; path?: string | null; encoding?: string | null; contentHash: string }
      drafts: ChapterDraft[]
      /** 见 `book:previewSplit`：'canvas' 时 drafts.rawText 会被解析成画本行直接落库 */
      importMode?: 'text' | 'canvas'
    }
    res: { bookId: Id; chapterCount: number }
  }
  'book:importFile': { req: { projectId: Id; filePath: string; options?: Record<string, unknown> }; res: { taskId: Id } }
  'book:importText': { req: { projectId: Id; text: string; title: string; options?: Record<string, unknown> }; res: { taskId: Id } }
  'book:importUrl': { req: { projectId: Id; url: string; options?: Record<string, unknown> }; res: { taskId: Id } }
  'book:findDuplicate': { req: { contentHash: string; projectId: Id }; res: { exists: boolean; bookId: Id | null } }
  'book:ruleSets': { req: NoReq; res: ChapterRuleSet[] }
  'book:saveRuleSet': { req: { ruleSet: ChapterRuleSet }; res: ChapterRuleSet }
  'book:deleteRuleSet': { req: { id: string }; res: { ok: boolean } }

  'chapter:list': { req: { bookId: Id }; res: Array<Chapter & { progress: ChapterProgress | null }> }
  'chapter:get': { req: { chapterId: Id }; res: Chapter }
  'chapter:update': { req: { chapterId: Id; patch: Partial<Pick<Chapter, 'title' | 'kind' | 'volumeTitle'>> }; res: Chapter }
  'chapter:reorder': { req: { bookId: Id; orderedIds: Id[] }; res: { ok: boolean } }
  'chapter:merge': { req: { chapterIds: Id[]; title: string }; res: Chapter }
  'chapter:split': { req: { chapterId: Id; atOffsets: number[] }; res: Chapter[] }
  'chapter:delete': { req: { chapterId: Id }; res: { ok: boolean } }
  'chapter:stats': { req: { chapterId: Id }; res: ChapterProgress }
  'chapter:inserTitleLine': { req: { chapterId: Id }; res: CanvasLine }

  // ── 画本 ──────────────────────────────────────────────────────────────────
  'canvas:generate': { req: { chapterId: Id; options: CanvasGenerateOptions }; res: { taskId: Id } }
  'canvas:getGenerateReport': { req: { chapterId: Id }; res: CanvasGenerateReport | null }
  'canvas:getChapter': {
    req: {
      chapterId: Id
      offset?: number
      limit?: number
      filter?: { needsReview?: boolean; speakerType?: 'narration' | 'character'; characterId?: Id; kind?: string }
    }
    res: { lines: CanvasLine[]; total: number }
  }
  'canvas:getLine': { req: { lineId: Id }; res: CanvasLine }
  'canvas:updateLine': { req: { lineId: Id; patch: CanvasLinePatch; rev?: number }; res: CanvasLine }
  'canvas:batchUpdate': {
    req: { lineIds?: Id[]; patch: CanvasLinePatch; filter?: { needsReview?: boolean; characterId?: Id | null; kind?: string } }
    res: { updated: number }
  }
  'canvas:recomputeAttribution': {
    req: { chapterId: Id; scope: 'low_confidence' | 'all' | 'selection'; lineIds?: Id[] }
    res: { taskId: Id }
  }
  'canvas:qualityCheck': { req: { chapterId: Id }; res: QualityIssue[] }
  'canvas:snapshotCreate': { req: { chapterId: Id; label?: string; reason?: string }; res: { snapshotId: Id } }
  'canvas:insertLines': { req: { chapterId: Id; afterSeq: number; text: string; characterId?: Id | null }; res: CanvasLine[] }
  'canvas:deleteLine': { req: { lineId: Id }; res: { ok: boolean } }
  'canvas:exportText': { req: { chapterId: Id; format: 'txt' | 'csv' | 'json'; outPath?: string }; res: { path: string } }

  // ── 角色与配音员 ──────────────────────────────────────────────────────────
  'character:list': { req: { bookId: Id; includeArchived?: boolean }; res: Character[] }
  'character:upsert': { req: { character: Partial<Character> & { bookId: Id; name: string } }; res: Character }
  'character:merge': {
    req: { targetId: Id; sourceIds: Id[]; keepAliases?: boolean }
    res: { movedLines: number; mergedAliases: string[]; conflicts: string[] }
  }
  'character:archive': { req: { characterId: Id; archived: boolean }; res: { ok: boolean } }
  'character:extract': { req: { bookId: Id; chapterIds?: Id[] }; res: CharacterCandidate[] }
  'character:stats': { req: { characterId: Id }; res: CharacterStats }
  'character:rebuildCentroid': { req: { bookId: Id; characterIds?: Id[] }; res: { taskId: Id } }

  'voiceActor:list': { req: { projectId: Id }; res: VoiceActor[] }
  'voiceActor:upsert': { req: { actor: Partial<VoiceActor> & { projectId: Id; name: string } }; res: VoiceActor }
  'voiceActor:delete': { req: { actorId: Id }; res: { ok: boolean } }
  'voiceActor:bind': { req: { characterId: Id; actorId: Id; isPrimary?: boolean }; res: { ok: boolean } }
  'voiceActor:unbind': { req: { characterId: Id; actorId: Id }; res: { ok: boolean } }
  'voiceActor:workload': { req: { bookId: Id }; res: ActorWorkload[] }
  'voiceActor:bindings': { req: { bookId: Id }; res: Array<{ characterId: Id; actorId: Id; isPrimary: boolean }> }

  // ── 录音 ──────────────────────────────────────────────────────────────────
  'record:prepare': {
    req: { projectId: Id; chapterId: Id | null; mode: RecordingMode; format: AudioFormat; deviceId?: string | null; actorId?: Id | null }
    res: RecordPrepareResult
  }
  'record:attachPort': { req: { sessionId: Id }; res: { ok: boolean } }
  'record:start': { req: { sessionId: Id }; res: { ok: boolean } }
  'record:pause': { req: { sessionId: Id }; res: { ok: boolean } }
  'record:resume': { req: { sessionId: Id }; res: { ok: boolean } }
  'record:stop': { req: { sessionId: Id; lineId?: Id | null; trim?: TrimOptions }; res: RecordStopResult }
  'record:abort': { req: { sessionId: Id; keepFile?: boolean }; res: { ok: boolean } }
  'record:punchIn': {
    req: { lineId: Id; srcInMs: number; srcOutMs: number; preRollMs: number; postRollMs: number }
    res: { sessionId: Id }
  }
  'record:slice': { req: { sessionId: Id; vad: VadOptions }; res: { slices: VadSlice[] } }
  'record:matchSlices': { req: { sessionId: Id; chapterId: Id; slices: VadSlice[]; useAsr?: boolean }; res: { matches: SliceMatch[]; unmatchedSlices: number[]; unrecordedLines: Id[] } }
  'record:acceptSlices': { req: { sessionId: Id; accepted: SliceMatch[] }; res: { createdTakes: number; createdSegments: number } }
  'record:optimizeTrim': { req: { takeId: Id; options: TrimOptions }; res: { trimmedInMs: number; trimmedOutMs: number } }

  'device:list': { req: NoReq; res: { devices: AudioDeviceInfo[]; preferred: string | null } }
  'device:savePreference': { req: { deviceId: string; label: string }; res: { ok: boolean } }
  'device:selfTestResult': { req: { result: DeviceSelfTestResult }; res: { ok: boolean } }

  'take:listByLine': { req: { lineId: Id }; res: Take[] }
  'take:listByChapter': { req: { chapterId: Id }; res: Take[] }
  'take:setSelected': { req: { lineId: Id; takeId: Id }; res: VoiceSegment }
  'take:delete': { req: { takeId: Id; hard?: boolean }; res: { ok: boolean } }
  'take:flag': { req: { takeId: Id; flags: string[] }; res: Take }
  'take:combineParts': { req: { lineId: Id; takeIds: Id[] }; res: { takeId: Id } }

  // ── 对轨 ──────────────────────────────────────────────────────────────────
  'alignment:listArrangements': { req: { chapterId: Id }; res: Arrangement[] }
  'alignment:create': { req: { chapterId: Id; name: string; strategy: Arrangement['strategy'] }; res: Arrangement }
  'alignment:duplicate': { req: { arrangementId: Id; name: string }; res: Arrangement }
  'alignment:delete': { req: { arrangementId: Id }; res: { ok: boolean } }
  'alignment:setDefault': { req: { arrangementId: Id }; res: { ok: boolean } }
  'alignment:get': { req: { arrangementId: Id }; res: { arrangement: Arrangement; items: ArrangementItem[] } }
  'alignment:autoArrange': {
    req: { arrangementId: Id; strategy: Arrangement['strategy']; preserveLocked: boolean; defaultPauseMs: number }
    res: { items: ArrangementItem[]; totalDurationMs: number }
  }
  'alignment:updateItem': { req: { itemId: Id; patch: ArrangementItemPatch }; res: ArrangementItem }
  'alignment:batchUpdateItems': { req: { updates: Array<{ itemId: Id; patch: ArrangementItemPatch }> }; res: { updated: number } }
  'alignment:validate': { req: { arrangementId: Id }; res: ArrangementValidation }
  'alignment:resolveOverlap': {
    req: { arrangementId: Id; itemIdA: Id; itemIdB: Id; strategy: Arrangement['strategy'] }
    res: { items: ArrangementItem[] }
  }
  'alignment:resetTrack': { req: { arrangementId: Id; trackId: string }; res: { items: ArrangementItem[] } }
  'alignment:resetAll': { req: { arrangementId: Id }; res: { items: ArrangementItem[] } }
  'alignment:autoMatchSegments': { req: { chapterId: Id; useAsr?: boolean }; res: { matches: Array<{ segmentId: Id; lineId: Id; confidence: number }>; unmatchedSegments: Id[]; unrecordedLines: Id[] } }
  'alignment:bindSegment': { req: { lineId: Id; segmentId: Id; srcInMs?: number; srcOutMs?: number }; res: { ok: boolean } }
  'alignment:unbindSegment': { req: { lineId: Id }; res: { ok: boolean } }
  'alignment:issueKindLabels': { req: NoReq; res: Record<AlignIssueKind, string> }
  'alignment:previewRender': { req: { arrangementId: Id; mixProjectId: Id | null; startMs: number; durationMs: number }; res: { taskId: Id } }
  'alignment:forcedAlign': { req: { lineId?: Id; segmentId?: Id }; res: { taskId: Id } }

  // ── 处理与素材 ────────────────────────────────────────────────────────────
  'process:preview': { req: { segmentId: Id; chain: ProcessChain; durationMs?: number }; res: { path: string } }
  'process:apply': { req: { segmentId: Id; presetId?: Id; chain?: ProcessChain }; res: { taskId: Id } }
  'process:batchApply': {
    req: { scope: ProcessScope; ids: Id[]; presetId?: Id; chain?: ProcessChain }
    res: { taskId: Id }
  }
  'process:listApplied': { req: { segmentIds: Id[] }; res: Array<{ segmentId: Id; processedPath: string | null; presetHash: string | null }> }
  'process:revert': { req: { segmentId: Id }; res: { ok: boolean } }
  'preset:list': { req: { projectId?: Id }; res: ProcessPreset[] }
  'preset:create': { req: { preset: Omit<ProcessPreset, 'id' | 'createdAt' | 'updatedAt' | 'builtin'> }; res: ProcessPreset }
  'preset:update': { req: { id: Id; patch: Partial<ProcessPreset> }; res: ProcessPreset }
  'preset:delete': { req: { id: Id }; res: { ok: boolean } }
  'preset:import': { req: { path: string }; res: { imported: number; warnings: string[] } }
  'preset:export': { req: { ids: Id[]; path: string }; res: { path: string } }
  'music:import': { req: { projectId: Id; files: string[]; kind: 'bgm' | 'sfx' }; res: MusicAsset[] }
  'music:list': { req: { projectId: Id; kind?: 'bgm' | 'sfx' }; res: MusicAsset[] }
  'music:probe': { req: { assetId: Id }; res: AudioMetrics }
  'music:delete': { req: { assetId: Id }; res: { ok: boolean } }
  'analysis:noiseProfile': { req: { segmentId: Id; startMs: number; endMs: number }; res: { rmsDb: number; suggestedNf: number } }
  'analysis:metrics': { req: { path?: string; segmentId?: Id }; res: AudioMetrics }
  'analysis:peaks': { req: { path?: string; segmentId?: Id; peaksPerSec: number; fromMs?: number; toMs?: number }; res: { peaks: number[]; channels: number; totalPeaks: number } }
  'ffmpeg:capabilities': { req: NoReq; res: AppCapabilities['ffmpeg'] }

  // ── 混音与导出 ────────────────────────────────────────────────────────────
  'mix:listProjects': { req: { chapterId: Id }; res: MixProject[] }
  'mix:get': { req: { mixProjectId: Id }; res: MixProject }
  'mix:save': { req: { mixProject: MixProject }; res: MixProject }
  'mix:create': { req: { chapterId: Id; arrangementId: Id; name: string }; res: MixProject }
  'mix:duplicate': { req: { mixProjectId: Id; name: string }; res: MixProject }
  'mix:delete': { req: { mixProjectId: Id }; res: { ok: boolean } }
  'mix:measureLoudness': { req: { path?: string; segmentId?: Id; targetLufs?: number }; res: LoudnessMeasurement }
  'export:preCheck': { req: { bookId: Id; chapterIds?: Id[]; mixProjectId: Id | null; params: ExportParams }; res: QcPreCheckResult }
  'export:chapter': { req: { chapterIds: Id[]; mixProjectId: Id | null; params: ExportParams }; res: { taskId: Id } }
  'export:book': { req: { bookId: Id; mixProjectId: Id | null; params: ExportParams; makeM4b: boolean }; res: { taskId: Id } }
  'export:m4b': { req: { bookId: Id; chapterIds: Id[]; params: ExportParams }; res: { taskId: Id } }
  'export:report': { req: { jobId: Id }; res: ExportReport }
  'export:verify': { req: { jobId: Id }; res: { chapters: Array<{ path: string; measuredLufs: number | null; measuredTp: number | null }> } }
  'export:openFolder': { req: { jobId: Id }; res: { ok: boolean } }
  'export:vbrPresets': { req: NoReq; res: Array<{ label: string; value: number }> }

  // ── 项目包 / 任务包 ───────────────────────────────────────────────────────
  'package:exportProject': { req: { projectId: Id; options: Record<string, unknown> }; res: { taskId: Id } }
  'package:importProject': { req: { path: string; options: Record<string, unknown> }; res: { taskId: Id } }
  'package:exportTask': { req: { bookId: Id; actorId: Id; options: Record<string, unknown> }; res: { taskId: Id } }
  'package:mergeTask': { req: { projectId: Id; path: string }; res: { taskId: Id } }
  'package:inspect': { req: { path: string }; res: { kind: 'nsp' | 'nst'; formatVersion: number; summary: string } }
  'package:listHistory': { req: { projectId: Id }; res: PackageHistoryEntry[] }
  'package:lastMergeReport': { req: { projectId: Id }; res: TaskPackageMergeReport | null }

  // ── 设置与任务 ────────────────────────────────────────────────────────────
  'settings:get': { req: { keys?: string[] }; res: AppSettings }
  'settings:set': { req: { patch: DeepPartial<AppSettings> }; res: { changedKeys: string[] } }
  'settings:setSecret': { req: { key: string; value: string }; res: { ok: boolean } }
  'settings:testProvider': { req: { provider: AppSettings['ai'] & { apiKey?: string } }; res: { ok: boolean; message: string; latencyMs?: number } }
  'settings:reset': { req: { keys?: string[] }; res: { ok: boolean } }

  'task:list': { req: { status?: TaskStatus[]; kind?: TaskKind[]; limit?: number }; res: TaskRecord[] }
  'task:get': { req: { taskId: Id }; res: TaskRecord }
  'task:cancel': { req: { taskId: Id }; res: { ok: boolean } }
  'task:retry': { req: { taskId: Id }; res: { taskId: Id } }
  'task:clearFinished': { req: NoReq; res: { cleared: number } }
  'task:result': { req: { taskId: Id }; res: unknown }

  'log:subscribe': { req: { level: AppSettings['advanced']['logLevel'] }; res: { ok: boolean } }
  'db:backup': { req: NoReq; res: { path: string } }
  'db:listBackups': { req: NoReq; res: Array<{ id: Id; filePath: string; sizeBytes: number; schemaVersion: number; reason: string; createdAt: number }> }
  'db:restore': { req: { path: string }; res: { ok: boolean } }
  'db:integrityCheck': { req: NoReq; res: { ok: boolean; errors: string[] } }
  'db:stats': { req: NoReq; res: { sizeBytes: number; schemaVersion: number; tables: Array<{ name: string; rows: number }> } }
}

// ---------------------------------------------------------------------------
// 类型工具
// ---------------------------------------------------------------------------

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends readonly unknown[] ? T[K] : DeepPartial<T[K]>) : T[K]
}

export type IpcChannel = keyof IpcContract
export type IpcReq<C extends IpcChannel> = IpcContract[C]['req']
export type IpcRes<C extends IpcChannel> = IpcContract[C]['res']

// ============================================================================
// 事件契约（主 → 渲染）
// ============================================================================

export interface IpcEventMap {
  /** 主进程主动推送的错误（docs/22 §6.1：已由 invoke 返回过的不要再推） */
  'app:error': SerializedAppError
  'app:beforeQuit': { reason: 'user' | 'os' }
  'app:capabilitiesChanged': AppCapabilities
  'crash:recovered': { sessions: number; totalMs: number }
  'main:interruptedTasks': { count: number }

  'task:progress': TaskProgressEvent
  'task:finished': { taskId: Id; status: TaskStatus; result?: unknown; error?: SerializedAppError }

  'record:status': {
    sessionId: Id
    state: RecordSessionState
    framesWritten: number
    durationMs: number
    droppedFrames: number
    diskFreeBytes: number
  }
  'record:level': { sessionId: Id; rmsDb: number; peakDb: number; clipping: boolean }
  'record:sliceProgress': { sessionId: Id; analyzedMs: number; totalMs: number }

  'canvas:progress': { chapterId: Id; stage: string; processed: number; total: number }
  'export:progress': {
    taskId: Id
    currentChapter: number
    totalChapters: number
    stage: string
    elapsedMs: number
    etaMs: number | null
    speed: number | null
  }
  'mix:renderProgress': { taskId: Id; stage: string; progress: number }

  'settings:changed': { changedKeys: string[] }
  'provider:circuitChanged': { provider: string; state: 'open' | 'closed'; untilTs: number }
  'log:entry': { ts: number; level: string; event: string; data?: Record<string, unknown> }
}

export type IpcEventName = keyof IpcEventMap
export type IpcEventPayload<E extends IpcEventName> = IpcEventMap[E]

/** 渲染 → 主的单向发送通道（高频、可丢弃） */
export interface IpcSendMap {
  /**
   * `claimedFrames` = 渲染侧**累计**已转投主进程的帧数（不是单块帧数）。
   * 主进程拿它与「落盘 + 内存」的帧数核对丢帧 —— 两条通道独立，故意如此
   * （端口整体失效时只有这条能发现，docs/91 §5.2.41）。
   */
  'record:meter': { sessionId: Id; rmsDb: number; peakDb: number; claimedFrames: number }
  'record:mark': { sessionId: Id; kind: 'cut' | 'retake' | 'note'; atMs: number }
}

export type IpcSendName = keyof IpcSendMap
export type IpcSendPayload<S extends IpcSendName> = IpcSendMap[S]

// ============================================================================
// 运行期辅助（主进程逐条校验、preload 白名单共用）
// ============================================================================

/**
 * 全部 invoke 通道名。
 * 注意：这是运行期要用到的数组，因此必须与 IpcContract 保持同步 ——
 * tests 里有契约完整性测试比对两者（新增通道忘了登记会红）。
 */
export const IPC_CHANNELS = [
  'app:getInfo', 'app:getPaths', 'app:getCapabilities', 'app:openExternal',
  'app:showItemInFolder', 'app:openFolderDialog', 'app:openFileDialog', 'app:saveFileDialog',
  'app:diagnostics', 'app:quit',

  'book:list', 'book:get', 'book:update', 'book:delete', 'book:probeFile',
  'book:detectEncoding', 'book:previewSplit', 'book:commitImport', 'book:importFile',
  'book:importText', 'book:importUrl', 'book:findDuplicate', 'book:ruleSets',
  'book:saveRuleSet', 'book:deleteRuleSet',

  'chapter:list', 'chapter:get', 'chapter:update', 'chapter:reorder', 'chapter:merge',
  'chapter:split', 'chapter:delete', 'chapter:stats', 'chapter:inserTitleLine',

  'canvas:generate', 'canvas:getGenerateReport', 'canvas:getChapter', 'canvas:getLine',
  'canvas:updateLine', 'canvas:batchUpdate', 'canvas:recomputeAttribution',
  'canvas:qualityCheck', 'canvas:snapshotCreate', 'canvas:insertLines',
  'canvas:deleteLine', 'canvas:exportText',

  'character:list', 'character:upsert', 'character:merge', 'character:archive',
  'character:extract', 'character:stats', 'character:rebuildCentroid',

  'voiceActor:list', 'voiceActor:upsert', 'voiceActor:delete', 'voiceActor:bind',
  'voiceActor:unbind', 'voiceActor:workload', 'voiceActor:bindings',

  'record:prepare', 'record:attachPort', 'record:start', 'record:pause', 'record:resume',
  'record:stop', 'record:abort', 'record:punchIn', 'record:slice', 'record:matchSlices',
  'record:acceptSlices', 'record:optimizeTrim',

  'device:list', 'device:savePreference', 'device:selfTestResult',

  'take:listByLine', 'take:listByChapter', 'take:setSelected', 'take:delete',
  'take:flag', 'take:combineParts',

  'alignment:listArrangements', 'alignment:create', 'alignment:duplicate', 'alignment:delete',
  'alignment:setDefault', 'alignment:get', 'alignment:autoArrange', 'alignment:updateItem',
  'alignment:batchUpdateItems', 'alignment:validate', 'alignment:resolveOverlap',
  'alignment:resetTrack', 'alignment:resetAll', 'alignment:autoMatchSegments',
  'alignment:bindSegment', 'alignment:unbindSegment', 'alignment:issueKindLabels',
  'alignment:previewRender', 'alignment:forcedAlign',

  'process:preview', 'process:apply', 'process:batchApply', 'process:listApplied',
  'process:revert', 'preset:list', 'preset:create', 'preset:update', 'preset:delete',
  'preset:import', 'preset:export', 'music:import', 'music:list', 'music:probe',
  'music:delete', 'analysis:noiseProfile', 'analysis:metrics', 'analysis:peaks',
  'ffmpeg:capabilities',

  'mix:listProjects', 'mix:get', 'mix:save', 'mix:create', 'mix:duplicate', 'mix:delete',
  'mix:measureLoudness', 'export:preCheck', 'export:chapter', 'export:book', 'export:m4b',
  'export:report', 'export:verify', 'export:openFolder', 'export:vbrPresets',

  'package:exportProject', 'package:importProject', 'package:exportTask', 'package:mergeTask',
  'package:inspect', 'package:listHistory', 'package:lastMergeReport',

  'settings:get', 'settings:set', 'settings:setSecret', 'settings:testProvider', 'settings:reset',

  'task:list', 'task:get', 'task:cancel', 'task:retry', 'task:clearFinished', 'task:result',

  'log:subscribe', 'db:backup', 'db:listBackups', 'db:restore', 'db:integrityCheck', 'db:stats'
] as const satisfies readonly IpcChannel[]

export const IPC_EVENT_NAMES = [
  'app:error', 'app:beforeQuit', 'app:capabilitiesChanged', 'crash:recovered',
  'main:interruptedTasks', 'task:progress', 'task:finished', 'record:status',
  'record:level', 'record:sliceProgress', 'canvas:progress', 'export:progress',
  'mix:renderProgress', 'settings:changed', 'provider:circuitChanged', 'log:entry'
] as const satisfies readonly IpcEventName[]

export const IPC_SEND_NAMES = ['record:meter', 'record:mark'] as const satisfies readonly IpcSendName[]

export function isIpcChannel(value: string): value is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(value)
}

export function isIpcEventName(value: string): value is IpcEventName {
  return (IPC_EVENT_NAMES as readonly string[]).includes(value)
}

export function isIpcSendName(value: string): value is IpcSendName {
  return (IPC_SEND_NAMES as readonly string[]).includes(value)
}
