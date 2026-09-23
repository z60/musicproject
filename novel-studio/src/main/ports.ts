/**
 * Novel Studio · IPC handler 依赖装配（`HandlerDeps` 的真实实现）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §4、docs/01 §10 第 12 步
 *
 * ### 这个文件解决什么问题
 *   `src/main/ipc/handlers/deps.ts` 定义了 `HandlerDeps`（10 个端口），
 *   但**谁把真实实现塞进去**一直没人写 —— 于是 `registerAllHandlers()` 无从调用，
 *   应用也就起不来。本文件就是那个装配点。
 *
 * ### 每一端口的实现程度（**如实标注，不假装**）
 *   完整实现：`log` / `env` / `settings` / `db` / `events` / `sends` / `tasks`（内存存储）
 *   部分实现：`capabilities`（ffmpeg 与模型来自启动期探测，embedding 固定不可用 ——
 *             没有 ONNX 推理实现，见 docs/91 §3）
 *   明确未实现：`diagnostics`（导出诊断包需要 zip 写入实现）、
 *             `provider`（真实连通性测试需要 provider HTTP 调用）
 *
 *   域 handler 的接线情况见 `domainHandlers`：项目包 / 任务包域（`package:*` 7 个通道）
 *   本轮接通；其中 `.nsp` 导入**只做解包与项目登记，不合并业务数据**（详见
 *   `features/book/package/package.tasks.ts` 顶部的「实现边界」）。
 *
 *   未实现的端口**不返回假数据**：调用即抛 `NOT_IMPLEMENTED` 并带上
 *   `params.feature`，与 `handlers/placeholders.ts` 的约定一致 ——
 *   返回空对象会让 UI 显示「导出成功 / 测试通过」这种真假难辨的状态。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { AppError } from '../shared/errors.ts'
import type { AppCapabilities, AppSettings, LineState } from '../shared/types.ts'
import type { HandlerDeps } from './ipc/handlers/deps.ts'
import { createMemoryTaskStore } from './infra/queue/store.ts'
import { TaskQueue } from './infra/queue/queue.ts'
import type { IpcEventName, IpcEventPayload, IpcSendName, IpcSendPayload } from '../shared/ipc.ts'
import type { Logger } from './infra/log/index.ts'
import { createDbPort } from './db.ts'
import { encryptSecret, decryptSecret, SECRET_PREFIX } from './infra/secure/index.ts'
import { resolvePrimaryProvider, resolveProvider } from '../shared/ai/factory.ts'
import { createProviderLlmReviewer } from './features/book/canvas/llm-reviewer.ts'
import { createFetchHttpClient } from '../shared/ai/http.ts'
import type { HttpClient } from '../shared/ai/types.ts'
import { createBookService, type BookService } from './features/book/import/book.service.ts'
import { createBookHandlers } from './ipc/handlers/book.ts'
import { createChapterService } from './features/book/chapter/chapter.service.ts'
import { createChapterHandlers } from './ipc/handlers/chapter.ts'
import { createSqliteCanvasLineRepo } from './features/book/canvas/repositories/canvas-line.repo.sqlite.ts'
import { createSqliteChapterRepo } from './features/book/import/repositories/chapter.repo.sqlite.ts'
import { createSqliteCanvasRepo } from './features/book/canvas/repositories/canvas.repo.sqlite.ts'
import { createSqliteCharacterRepo } from './features/book/canvas/repositories/character.repo.sqlite.ts'
import { createCanvasFeature } from './features/book/canvas/index.ts'
import { createCanvasImportPort } from './features/book/canvas/canvas-import.service.ts'
import { createCanvasTasks } from './features/book/canvas/canvas.tasks.ts'
import { createCanvasHandlers } from './ipc/handlers/canvas.ts'
import { createCharacterService } from './features/book/canvas/character.service.ts'
import { createCharacterHandlers } from './ipc/handlers/character.ts'
import { createAnalysisService } from './features/audio/analysis.service.ts'
import { createDeviceService } from './features/audio/device.service.ts'
import { createAudioProjectScope } from './features/audio/project-scope.ts'
import { createAlignmentService } from './features/audio/alignment.service.ts'
import { createAlignmentHandlers } from './ipc/handlers/alignment.ts'
import { createSqliteArrangementRepo } from './features/audio/repositories/arrangement.repo.sqlite.ts'
import { createRenderTasks } from './features/audio/render.tasks.ts'
import { createAlignmentLineQueries, createAlignmentSegmentQueries } from './features/audio/alignment.queries.ts'
import { createFfmpegRunner } from './infra/media/ffmpeg-runner.ts'
import { createPresetService } from './features/audio/preset.service.ts'
import { createProcessService } from './features/audio/process.service.ts'
import { createProcessTasks } from './features/audio/process.tasks.ts'
import { createProcessingHandlers } from './ipc/handlers/processing.ts'
import { createMusicService } from './features/audio/music.service.ts'
import { createMusicHandlers } from './ipc/handlers/music.ts'
import { createSqliteMusicAssetRepo } from './features/audio/repositories/music.repo.sqlite.ts'
import { createMixService } from './features/audio/mix.service.ts'
import { createMixHandlers } from './ipc/handlers/mix.ts'
import { createSqliteMixProjectRepo } from './features/audio/repositories/mix.repo.sqlite.ts'
import { createExportService } from './features/audio/export.service.ts'
import { createExportHandlers } from './ipc/handlers/export.ts'
import { createExportTasks } from './features/audio/export.tasks.ts'
import { createSqliteExportJobRepo } from './features/audio/repositories/export-job.repo.sqlite.ts'
import { createSqlitePresetRepo } from './features/audio/repositories/preset.repo.sqlite.ts'
import { createPackageService } from './features/book/package/package.service.ts'
import { createPackageHandlers } from './ipc/handlers/package.ts'
import { createPackageTasks } from './features/book/package/package.tasks.ts'
import { createSqlitePackageRepo } from './features/book/package/repositories/package.repo.sqlite.ts'
import { createRecordService, type RecordPortLike, type RecordService } from './features/audio/record.service.ts'
import { createTakeService } from './features/audio/take.service.ts'
import { createAudioHandlers } from './ipc/handlers/audio.ts'
import { createSqliteAudioMetricsRepo } from './features/audio/repositories/audio-metrics.repo.ts'
import { createSqliteRecordingSessionRepo } from './features/audio/repositories/recording-session.repo.sqlite.ts'
import { createSqliteTakeRepo } from './features/audio/repositories/take.repo.sqlite.ts'
import { createSqliteVoiceSegmentRepo } from './features/audio/repositories/voice-segment.repo.ts'
import { createSqliteVoiceActorRepo } from './features/book/canvas/repositories/voice-actor.repo.sqlite.ts'
import { createSqliteBookRepo } from './features/book/import/repositories/book.repo.sqlite.ts'
import { CANVAS_DEFAULTS, TRIM_DEFAULTS } from '../shared/constants.ts'
import type { RegisteredHandler } from './ipc/handlers/deps.ts'
import type { AppState } from './app-state.ts'
import type { ProcessChain } from '../shared/types.ts'

export interface BuildHandlerDepsOptions {
  state: AppState
  /** 应用版本 */
  version: string
  /** 便携模式（`app:getInfo` 会返回） */
  portable: boolean
  /** 打开外部链接（Electron shell）；失败要能看出原因 */
  openExternal: (url: string) => Promise<void>
  /** 在文件管理器中定位 */
  showItemInFolder: (path: string) => void
  pickFolder: (opts: { title?: string; defaultPath?: string }) => Promise<string | null>
  pickFiles: (opts: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    multi?: boolean
  }) => Promise<string[]>
  pickSavePath: (opts: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<string | null>
  /** 退出应用（Electron app.quit / app.exit） */
  quit: (force: boolean) => void
  /**
   * AI Provider 探测用的 HTTP 客户端（生产默认内置 fetch）。
   * 注入它才能在不联网的环境里验证「测试连接」的真实行为。
   */
  aiHttp?: HttpClient
}

/** 端口装配的结果：既返回 HandlerDeps，也返回队列与域 handler（关闭/注册时要用） */
export interface BuiltPorts {
  deps: HandlerDeps
  queue: TaskQueue
  /** 领域 handler（书籍导入域等）。由 `registerAllHandlers` 的第三参注入。 */
  domainHandlers: RegisteredHandler[]
  /** 书籍导入域服务（供启动期的「确保默认项目」使用） */
  book: BookService
  /**
   * 录音域服务（供 `record:port` 的 MessagePort 接管与退出时的会话收敛使用）。
   *
   * 为什么必须从这里暴露：端口是 transferable，只能由主入口在 `ipcMain.on('record:port')`
   * 里拿到，而端口要交给会话 —— 那是本服务的状态。
   */
  record: RecordService
  /** 把渲染进程送来的采集端口交给录音域（`src/main/index.ts` 调用） */
  attachRecordPort: (port: RecordPortLike) => void
}

/**
 * 装配 `HandlerDeps`。
 *
 * **必须在 DB 打开之后调用**（`state.requireDb()` 会校验顺序）。
 */
export function buildHandlerDeps(opts: BuildHandlerDepsOptions): BuiltPorts {
  const { state } = opts
  const paths = state.requirePaths()
  const log: Logger = state.requireLogger()

  // ── 任务队列 ─────────────────────────────────────────────────────────────
  // 说明：这里用**内存任务存储**。这不是「偷懒」而是当前唯一正确选择 ——
  // 生产用的 SQLite 任务存储尚未实现（docs/91 §3 有登记），
  // 用内存存储的后果只是「重启后任务列表为空」，而不是给出错误的任务状态。
  // 真正跑起来的任务（如导出）仍然会正常工作，只是历史记录不留存。
  const queue = new TaskQueue({
    specs: [], // 各域的 TaskSpec 由对应域注册；当前无实现域，因此为空
    store: createMemoryTaskStore(),
    log: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
    tempRoot: join(paths.cacheDir, 'tasks'),
  })

  const pathsRecord = {
    userData: paths.userData,
    projectRoot: paths.projectRoot,
    exportDir: paths.exportDir,
    cacheDir: paths.cacheDir,
    logDir: paths.logDir,
    backupDir: paths.backupDir,
    modelDir: paths.modelDir,
    resourceDir: paths.resourceDir,
  }

  // ── 书籍导入域服务 ───────────────────────────────────────────────────────
  // 队列要拿到本域的 TaskSpec，因此**先建队列、再建服务**，最后把 specs 注册进去。
  // 反过来（先建服务）会拿不到 queue 引用，异步导入通道就永远是 NOT_IMPLEMENTED。
  // 画本导入端口：把「已经是画本」的文档（【角色-CV】“台词”）解析结果写进
  // 角色表与 canvas_lines。仓储每次现取（库可能在「从备份恢复」后换掉）。
  const canvasImportPort = createCanvasImportPort({
    getCanvasRepo: () => createSqliteCanvasRepo(state.requireDb()),
    getCharacterRepo: () => createSqliteCharacterRepo(state.requireDb()),
    updateChapter: async (chapterId, patch) => {
      await createSqliteChapterRepo(state.requireDb()).update(chapterId, patch)
    },
  })
  const bookService = createBookService({
    getDb: () => state.db,
    projectRoot: paths.projectRoot,
    log,
    queue,
    canvasImport: canvasImportPort,
    // 注意 `import?.maxFileSizeBytes` 里的 `?.`：**分组本身也可能不可靠**。
    // 真机事故（docs/91 §5.2.3）：库里一行 `import = null` 让整支变成 null，
    // 而这里原来只写了 `state.settings?.current().import.maxFileSizeBytes` ——
    // `?.` 只护住了 state.settings，`.import` 为 null 时直接
    // `TypeError: Cannot read properties of null (reading 'maxFileSizeBytes')`，
    // 启动在第 11 步中止，应用再也起不来。启动路径上的读取必须取值级兜底。
    ...(state.settings?.current().import?.maxFileSizeBytes !== undefined
      ? { importLimits: { maxFileSizeBytes: state.settings.current().import.maxFileSizeBytes } }
      : {}),
  })
  for (const spec of bookService.taskSpecs()) queue.registerSpec(spec)

  // ── 章节管理域服务 ───────────────────────────────────────────────────────
  // 与导入域分开：导入负责「把书变成章节」，章节管理负责「章节之后的一切」
  // （改标题/重排/合并/拆分/删除/进度）。两者共用同一套仓储与迁移。

  /**
   * 画本行仓储**按当前 db 现取**：库可能在「从备份恢复」后被换成新连接，
   * 持有旧连接的仓储会读到已关闭的库。因此每次都现构造（构造本身很轻）。
   */
  async function withCanvasRepo<T>(
    fn: (repo: ReturnType<typeof createSqliteCanvasLineRepo>) => Promise<T>,
  ): Promise<T> {
    const db = state.db
    if (!db) {
      throw new AppError('DB_NOT_OPEN', { details: { feature: 'chapter', what: 'canvas-lines' } })
    }
    return fn(createSqliteCanvasLineRepo(db))
  }

  /** 取当前 db 句柄（拿不到就抛 DB_NOT_OPEN，而不是让各域各自编一段错误） */
  function requireDbFor(feature: string) {
    const db = state.db
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature } })
    return db
  }

  /**
   * 画本段设置（质检阈值、默认停顿等）。
   *
   * 取值级兜底（`?? CANVAS_DEFAULTS`）不是多余防御：真机事故（docs/91 §5.2.3）
   * 证明库里可能出现**整段为 null** 的设置行，而 `settings.loadFromDb` 只是
   * 「不把 null 灌进默认树」——它保证的是「正常情况下是对象」，不是「永远是对象」。
   * 这里再兜一次，代价是一次 `??`，收益是画本域永远不会因为设置缺项而炸。
   */
  function canvasSettings(): AppSettings['canvas'] {
    return state.requireSettings().current().canvas ?? CANVAS_DEFAULTS
  }

  // 画本域任务（生成画本 / 重算判定）：与导入域同一套做法 —— 队列先建好，
  // 再把本域的 TaskSpec 注册进去，然后才能入队。
  const canvasTasks = createCanvasTasks({
    getDb: () => state.db,
    queue,
    log,
    limits: {
      maxLineChars: canvasSettings().maxLineChars,
      shortLineChars: canvasSettings().shortLineChars,
      maxNarrationRun: canvasSettings().maxNarrationRun,
    },
  })
  for (const spec of canvasTasks.taskSpecs()) queue.registerSpec(spec)

  // ── 角色与配音员域 ───────────────────────────────────────────────────────
  // 与画本域同一层层级：角色表既是判定（原型向量）的输入，也是编辑器的角色面板。
  // 它**不持有**仓储实例：`repo()` 每次调用现取，兼容「从备份恢复」换连接。
  const characterService = createCharacterService({
    repo: () => {
      const db = requireDbFor('character')
      return {
        characters: createSqliteCharacterRepo(db),
        actors: createSqliteVoiceActorRepo(db),
        canvas: createSqliteCanvasRepo(db),
      }
    },
    chapters: {
      listByBook: (bookId) => createSqliteChapterRepo(requireDbFor('character')).listByBook(bookId),
      getText: (chapterId) => createSqliteChapterRepo(requireDbFor('character')).getText(chapterId),
    },
    listProjectActors: async (bookId) => {
      const db = requireDbFor('character')
      const book = await createSqliteBookRepo(db).findById(bookId)
      if (!book) return []
      return createSqliteVoiceActorRepo(db).listByProject(book.projectId)
    },
    queue,
    log,
  })

  const chapterService = createChapterService({
    getDb: () => state.db,
    log,
    // 画本行写入端口：`chapter:inserTitleLine` 往 canvas_lines 插「章首标题念白行」。
    canvasLines: {
      countLines: (chapterId) => withCanvasRepo((r) => r.countLines(chapterId)),
      findTitleLine: (chapterId) => withCanvasRepo((r) => r.findTitleLine(chapterId)),
      shiftSeqDown: (chapterId) => withCanvasRepo((r) => r.shiftSeqDown(chapterId)),
      insert: (line) => withCanvasRepo((r) => r.insert(line)),
      updateText: (lineId, text) => withCanvasRepo((r) => r.updateText(lineId, text)),
    },
  })

  // ── 音频域（分析 / 设备 / take / 录音）──────────────────────────────────
  // 音频文件按「项目根相对路径」落库，读盘时**必须再拼一个 projectId**
  // （`{projectRoot}/{projectId}/{rel}`，与 ns-media 协议同一口径，见 docs/91 §5.2.19）。
  // 各服务都不持有仓储实例：db 与项目根都可能被「从备份恢复」换掉。
  const audioScope = createAudioProjectScope({ getDb: () => state.db })

  /**
   * 事件端口在 `deps` 里定义（它需要 windowManager），而录音服务要在那之前构造。
   * 用一个**延迟读取的占位**接上：录音服务只在真正录制时才发 `record:status`，
   * 那时 `deps` 早已装配完成。直接传 `undefined` 会让状态事件永远发不出去。
   */
  let eventsPort: HandlerDeps['events'] | null = null

  /** 画本行的章节 id：写 take / 成品行（`voice_segments.chapter_id`）要用它 */
  async function lineChapterId(lineId: string): Promise<string | null> {
    const db = requireDbFor('audio')
    const row = db
      .prepare(`SELECT chapter_id FROM canvas_lines WHERE id = ? AND deleted_at IS NULL`)
      .get(lineId) as { chapter_id: string } | undefined
    return row?.chapter_id ?? null
  }

  /**
   * 录音完成后把画本行推进到 `recorded`（docs/12 §3.3 / docs/01 §210）。
   * 仓储方法本身保证"只前进"，这里只负责把它接到录音域（真机事故 docs/91 §5.2.44：
   * 这一步以前完全缺失，导致录音成功但 UI 永远显示未录）。
   */
  async function markLineRecorded(lineId: string): Promise<{ from: LineState; to: LineState; changed: boolean } | null> {
    // 用完整的画本行仓储（`createSqliteCanvasRepo`），不是导入域那个只写文本的窄接口
    return createSqliteCanvasRepo(requireDbFor('record')).markLineRecorded(lineId)
  }

  const analysisService = createAnalysisService({
    getDb: () => state.db,
    projectRoot: () => paths.projectRoot,
    scope: audioScope,
    metricsRepo: () => createSqliteAudioMetricsRepo(requireDbFor('analysis')),
    log,
  })
  const deviceService = createDeviceService({ settings: () => state.requireSettings(), log })
  const takeService = createTakeService({
    projectRoot: () => paths.projectRoot,
    scope: audioScope,
    takeRepo: () => createSqliteTakeRepo(requireDbFor('take')),
    segmentRepo: () => createSqliteVoiceSegmentRepo(requireDbFor('take')),
    lineChapterId,
    markLineRecorded,
    log,
  })
  const recordService = createRecordService({
    projectRoot: () => paths.projectRoot,
    scope: audioScope,
    sessionRepo: () => createSqliteRecordingSessionRepo(requireDbFor('record')),
    takeRepo: () => createSqliteTakeRepo(requireDbFor('record')),
    segmentRepo: () => createSqliteVoiceSegmentRepo(requireDbFor('record')),
    lineChapterId,
    markLineRecorded,
    /** 匹配切片要按行文本长度估算期望时长（docs/05 §4.2 的 charsPerSecond） */
    lineCharCounts: async (chapterId) => {
      const db = requireDbFor('record')
      const rows = db
        .prepare(
          `SELECT id AS line_id, LENGTH(COALESCE(text, '')) AS char_count
             FROM canvas_lines
            WHERE chapter_id = ? AND deleted_at IS NULL
            ORDER BY seq ASC`,
        )
        .all(chapterId) as Array<{ line_id: string; char_count: number }>
      return rows.map((r) => ({ lineId: r.line_id, charCount: r.char_count }))
    },
    audioSettings: () => {
      // VAD 参数在 `recording.vad`，修剪参数散在 `audio.*`（docs/21 §12 的设置分组就这样）
      const settings = state.requireSettings().current()
      const trim = {
        enabled: settings.audio?.autoTrim ?? TRIM_DEFAULTS.enabled,
        thresholdDb: settings.audio?.trimThresholdDb ?? TRIM_DEFAULTS.thresholdDb,
        headPaddingMs: settings.audio?.trimPaddingMs ?? TRIM_DEFAULTS.headPaddingMs,
        tailPaddingMs: settings.audio?.trimPaddingMs ?? TRIM_DEFAULTS.tailPaddingMs,
      }
      return {
        trim,
        ...(settings.recording?.vad ? { vad: settings.recording.vad } : {}),
      }
    },
    events: { emit: (event, payload) => eventsPort?.emit(event as IpcEventName, payload as never) },
    log,
  })

  // ── 处理链与预设域（`process:*` / `preset:*`）───────────────────────────
  // ffmpeg 执行器是唯一真正 spawn 进程的地方；路径来自启动期能力探测
  // （`capabilities.ffmpeg.path`），未探到时交给 PATH —— 不硬编码绝对路径。
  const ffmpegRunner = createFfmpegRunner({
    ffmpegPath: () => state.capabilities?.ffmpeg.path ?? 'ffmpeg',
    log: { info: log.info.bind(log), warn: log.warn.bind(log) },
  })
  const presetService = createPresetService({
    repo: () => createSqlitePresetRepo(requireDbFor('preset')),
    log,
  })
  /** 预设/显式链 → 具体链（处理任务与试听共用同一条解析路径，避免两处判断不一致） */
  const resolveProcessChain = async (presetId?: string | null, chain?: ProcessChain | null) => {
    const resolved = await presetService.resolveChain(presetId ?? null, chain ?? null)
    return resolved.chain
  }
  const processTasks = createProcessTasks({
    getDb: () => state.db,
    queue,
    ffmpeg: ffmpegRunner,
    projectRoot: () => paths.projectRoot,
    resolveChain: resolveProcessChain,
    log,
  })
  for (const spec of processTasks.taskSpecs()) queue.registerSpec(spec)
  const processService = createProcessService({
    getDb: () => state.db,
    projectRoot: () => paths.projectRoot,
    tasks: processTasks,
    ffmpeg: ffmpegRunner,
    resolveChain: resolveProcessChain,
    log,
  })

  // ── 对轨域（`alignment:*` 19 个通道）────────────────────────────────────
  // 预览渲染是唯一需要真跑 ffmpeg 的对轨动作（其余都是「读库 → 纯函数 → 写库」）。
  const renderTasks = createRenderTasks({
    getDb: () => state.db,
    queue,
    ffmpeg: ffmpegRunner,
    projectRoot: () => paths.projectRoot,
    log,
  })
  for (const spec of renderTasks.taskSpecs()) queue.registerSpec(spec)

  const alignmentService = createAlignmentService({
    getDb: () => state.db,
    projectRoot: () => paths.projectRoot,
    repo: () => createSqliteArrangementRepo(requireDbFor('alignment')),
    /** 画本行 + 角色轨道 + 留白（对轨的唯一输入来源） */
    /** 画本行 + 角色轨道 + 留白（对轨的唯一输入来源；SQL 在 alignment.queries.ts） */
    lines: createAlignmentLineQueries(() => requireDbFor('alignment')),
    /** 片段查询与绑定（含「目标行已被占用」的判定） */
    segments: createAlignmentSegmentQueries(() => requireDbFor('alignment')),
    render: { enqueuePreview: (payload) => renderTasks.enqueuePreview(payload) },
    audioSettings: () => {
      const settings = state.requireSettings().current()
      return settings.recording?.vad ? { vad: settings.recording.vad } : {}
    },
    log,
  })

  // ── 素材域（`music:*` 4 个通道）──────────────────────────────────────────
  // 导入即托管（复制到 `music/{kind}/`）：引用用户的原路径会让「整理素材目录」变成
  // 「所有 BGM 轨失效」。探测非 WAV 素材需要 ffmpeg（解码成临时 WAV 再测）。
  const musicService = createMusicService({
    getDb: () => state.db,
    projectRoot: () => paths.projectRoot,
    repo: () => createSqliteMusicAssetRepo(requireDbFor('music')),
    projectExists: async (projectId) => {
      const db = requireDbFor('music')
      const row = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId)
      return row !== undefined
    },
    ffmpeg: ffmpegRunner,
    log,
  })

  // ── 混音域（`mix:*` 7 个通道）────────────────────────────────────────────
  // 方案整份以 JSON 存（契约的 `mix:save` 传的就是整份），保存时校验引用关系；
  // 响度测量走 ffmpeg 的 loudnorm 第一遍（唯一能拿到标准 LUFS 的途径）。
  const mixService = createMixService({
    getDb: () => state.db,
    projectRoot: () => paths.projectRoot,
    repo: () => createSqliteMixProjectRepo(requireDbFor('mix')),
    scope: audioScope,
    ffmpeg: ffmpegRunner,
    arrangementChapterId: async (arrangementId) => {
      const db = requireDbFor('mix')
      const row = db.prepare(`SELECT chapter_id FROM arrangements WHERE id = ?`).get(arrangementId) as
        | { chapter_id: string }
        | undefined
      return row?.chapter_id ?? null
    },
    log,
  })

  // ── 导出域（export:*；本轮实现预检 / 报告 / 验收 / 定位 / VBR 档位）──────
  // 三个渲染任务（chapter/book/m4b）需要完整混音管线，仍在下一轮：它们不在
  // EXPORT_CHANNELS 里，占位清单会如实列出。
  const exportTasks = createExportTasks({
    getDb: () => state.db,
    queue,
    ffmpeg: ffmpegRunner,
    projectRoot: () => paths.projectRoot,
    repo: () => createSqliteExportJobRepo(requireDbFor('export')),
    log,
  })
  for (const spec of exportTasks.taskSpecs()) queue.registerSpec(spec)
  const exportService = createExportService({
    getDb: () => state.db,
    projectRoot: () => paths.projectRoot,
    repo: () => createSqliteExportJobRepo(requireDbFor('export')),
    ffmpeg: ffmpegRunner,
    showItemInFolder: (path) => opts.showItemInFolder(path),
    log,
  })

  // ── 项目包 / 任务包域（`package:*` 7 个通道）─────────────────────────────
  // 三个长任务（导出 .nsp / .nst、导入 .nsp、回收合并 .nst）都走队列：
  // 导出可能写几 GB、合并要逐条写音频，卡在 IPC 里会把整个界面拖住。
  // projectRoot 与 db **按调用现取**（库可能被「从备份恢复」换掉），与 exportTasks 同一做法。
  const packageTasks = createPackageTasks({
    getDb: () => state.db,
    queue,
    projectRoot: () => paths.projectRoot,
    // 包默认落在设置里的导出目录；设置里没写就退回启动期算出来的默认值
    exportDir: () => state.requireSettings().current().paths?.exportDir || paths.exportDir,
    app: () => ({ name: 'Novel Studio', version: opts.version }),
    repo: () => createSqlitePackageRepo(requireDbFor('package')),
    log,
  })
  for (const spec of packageTasks.taskSpecs()) queue.registerSpec(spec)
  const packageService = createPackageService({
    getDb: () => state.db,
    repo: () => createSqlitePackageRepo(requireDbFor('package')),
    tasks: packageTasks,
    /** 历史列表里的配音员名：查不到给 null（模板串会显示「未知配音员」，不编假名字） */
    actorName: (actorId) => {
      const row = requireDbFor('package')
        .prepare(`SELECT name FROM voice_actors WHERE id = ?`)
        .get(actorId) as { name: string } | undefined
      return row?.name ?? null
    },
    log,
  })

  const domainHandlers: RegisteredHandler[] = [
    ...createBookHandlers(bookService),
    ...createChapterHandlers(chapterService),
    ...createCanvasHandlers({
      // 画本域的上下文**每次调用现取**（理由同 withCanvasRepo：库可能被换掉）
      ctx: () => {
        const db = requireDbFor('canvas')
        const canvasRepo = createSqliteCanvasRepo(db)
        const characterRepo = createSqliteCharacterRepo(db)
        return {
          feature: createCanvasFeature({
            canvasRepo,
            characterRepo,
            // 生产环境**没有** ONNX 推理实现（`capabilities.embedding.available` 恒为 false，
            // 见 docs/91 §3）。传 null 会走规则判定并给出 `CANVAS_EMBEDDING_UNAVAILABLE` 警告 ——
            // 这正是 docs/06 §8 的要求：「绝不因为模型缺失就阻断用户」。
            // 传一个假 provider 才是错的：那会让 `report.embeddingUsed` 说谎。
            embedProvider: null,
            // LLM 复核（画本编辑器的「AI 复核存疑行」）：
            // 每次生成现取设置 —— 用户可能在设置页刚改完服务商/地址/隐私开关。
            // 没有可用配置时返回 null，由 createProviderLlmReviewer 返回空数组，
            // 上层记 CANVAS_LLM_UNAVAILABLE 并让低置信行进待确认列表（绝不谎报 llmUsed）。
            llmReviewer: createProviderLlmReviewer({
              getContext: () => {
                const ai = state.requireSettings().current().ai
                if (!ai) return null
                return {
                  provider: resolveProvider(ai, { apiKey: readSecret('ai.apiKey') }),
                  allowCloud: ai.allowSendTextToCloud,
                  timeoutMs: ai.timeoutMs,
                }
              },
            }),
            log: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
          }),
          canvasRepo,
          chapters: createSqliteChapterRepo(db),
        }
      },
      tasks: canvasTasks,
      canvasSettings,
      exportDir: () =>
        state.requireSettings().current().paths?.exportDir || paths.exportDir,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createCharacterHandlers({
      service: characterService,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createAudioHandlers({
      analysis: analysisService,
      device: deviceService,      take: takeService,
      record: recordService,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createProcessingHandlers({
      process: processService,
      preset: presetService,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createAlignmentHandlers({
      alignment: alignmentService,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createMusicHandlers({
      music: musicService,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createMixHandlers({
      mix: mixService,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createExportHandlers({
      export: exportService,
      tasks: exportTasks,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
    ...createPackageHandlers({
      pkg: packageService,
      log: { info: log.info.bind(log), warn: log.warn.bind(log) },
    }),
  ]

  const dbPort = createDbPort({
    getDb: () => state.db,
    dbPath: state.dbPath ?? join(paths.userData, 'novel-studio.db'),
    backupDir: paths.backupDir,
    log,
    closeForRestore: () => {
      try {
        state.db?.close()
      } finally {
        state.db = null
      }
    },
    reopenAfterRestore: async () => {
      // 重新打开（复用启动期同一条路径与 PRAGMA 逻辑）
      const { openDatabase } = await import('./db.ts')
      const { applyPragmas } = await import('./infra/db/index.ts')
      const opened = await openDatabase({
        dbPath: state.dbPath ?? join(paths.userData, 'novel-studio.db'),
        log,
      })
      void applyPragmas
      state.db = opened.db
      // settings 存储持有的是**旧连接**，恢复后必须重建，否则它继续读已关闭的库
      const { createSettingsStore } = await import('./settings.ts')
      state.settings = createSettingsStore({
        db: opened.db,
        pathDefaults: {
          projectRoot: paths.projectRoot,
          exportDir: paths.exportDir,
          ffmpegPath: null,
          modelDir: paths.modelDir,
          cacheDir: paths.cacheDir,
          backupDir: paths.backupDir,
        },
      })
      const r = dbPort.integrityCheck()
      return { ok: r.ok, errors: r.errors }
    },
  })

  /**
   * 写入密钥：加密后落库（docs/04 §9）。空串 = 清除。
   *
   * 旧实现直接把明文交给 `setSecretRaw`，而后者又会因为 `ai.apiKey` 不在默认设置树里
   * 而静默丢弃 —— 结果是「密钥既没加密、也没存进去」。两处都已修正。
   */
  function writeSecret(key: string, value: string): void {
    const store = state.requireSettings()
    if (value === '') {
      store.setSecretRaw(key, '')
      return
    }
    store.setSecretRaw(key, encryptSecret(value, state.electron?.safeStorage ?? null))
  }

  /**
   * 读取并解密密钥。**只给主进程内部用**（如 provider.test），绝不返回给渲染进程。
   *
   * 兼容修复前写入的历史明文（无 `v1:` 前缀）：先原样返回，再顺手加密回写，
   * 让用户的密钥不再继续裸存；平台不支持安全存储时保持明文，不阻断读取。
   */
  function readSecret(key: string): string | null {
    const store = state.requireSettings()
    const raw = store.getSecretRaw(key)
    if (raw === null || raw === '') return null
    const safeStorage = state.electron?.safeStorage ?? null

    if (!raw.startsWith(SECRET_PREFIX)) {
      try {
        store.setSecretRaw(key, encryptSecret(raw, safeStorage))
      } catch {
        /* 加密不可用：保持明文，能力位会告知用户 */
      }
      return raw
    }

    try {
      return decryptSecret(raw, safeStorage, {
        onDecryptFailed: () => {
          // 换机器/换用户导致解密失败 → 清除并让用户重新输入（docs/04 §9）
          store.setSecretRaw(key, '')
        },
      })
    } catch (e) {
      log.warn('settings.secret.decryptFailed', {
        event: 'settings.secret.decryptFailed',
        key,
        reason: e instanceof Error ? e.message : String(e),
      })
      return null
    }
  }

  const deps: HandlerDeps = {
    log,
    // ── 应用信息与路径（完整实现）──────────────────────────────────────────
    env: {
      getInfo: () => ({
        version: opts.version,
        electron: process.versions.electron ?? '',
        node: process.versions.node,
        chrome: process.versions.chrome ?? '',
        platform: process.platform,
        arch: process.arch,
        isPackaged: state.electron?.app.isPackaged ?? false,
        portable: opts.portable,
      }),
      getPaths: () => pathsRecord,
      openExternal: (url: string) => opts.openExternal(url),
      showItemInFolder: (path: string) => opts.showItemInFolder(path),
      pickFolder: (o) => opts.pickFolder(o),
      pickFiles: (o) => opts.pickFiles(o),
      pickSavePath: (o) => opts.pickSavePath(o),
      quit: (force: boolean) => opts.quit(force),
    },

    // ── 能力探测（部分实现，见文件头说明）──────────────────────────────────
    capabilities: {
      getCapabilities: async (): Promise<AppCapabilities> => currentCapabilities(state),
      refresh: async (): Promise<AppCapabilities> => {
        // 重新探测 = 重跑启动期的两步探测（模型 + ffmpeg）。
        // 目前只更新 ffmpeg 可用性；模型校验需要读 manifest，成本低但还没接线。
        const caps = currentCapabilities(state)
        log.info('capabilities.refreshed', { event: 'capabilities.refreshed', ffmpeg: caps.ffmpeg.available })
        return caps
      },
    },

    // ── 设置（完整实现，写穿到 settings 表）────────────────────────────────
    settings: {
      getAll: () => state.requireSettings().getAll(),
      get: (keys?: string[]) => state.requireSettings().get(keys),
      set: (patch: Record<string, unknown>) => state.requireSettings().set(patch),
      setSecret: (key: string, value: string) => writeSecret(key, value),
      getSecret: (key: string) => readSecret(key),
      reset: (keys?: string[]) => state.requireSettings().reset(keys),
    },

    // ── 任务队列（用真实队列，内存存储）────────────────────────────────────
    tasks: {
      list: (filter) => queue.list(filter as Parameters<TaskQueue['list']>[0]),
      get: (taskId) => queue.get(taskId),
      cancel: (taskId) => queue.cancel(taskId),
      retry: async (taskId) => {
        try {
          const id = await queue.retry(taskId)
          return { taskId: id }
        } catch (e) {
          // 队列在「未落库 payload」时会抛 TASK_NOT_FOUND —— 原样上抛，
          // 由 handler 层转成标准的 IpcResult（错误码已经是对的）
          if (e instanceof AppError) return null
          throw e
        }
      },
      clearFinished: () => queue.clearFinished(),
      result: (taskId) => queue.result(taskId),
    },

    // ── 数据库维护（完整实现）──────────────────────────────────────────────
    db: dbPort,

    // ── 诊断包（明确未实现）───────────────────────────────────────────────
    diagnostics: {
      export: async () => {
        throw new AppError('NOT_IMPLEMENTED', {
          params: { feature: '导出诊断包' },
          details: {
            reason: 'diagnostics-export-not-implemented',
            hint: '诊断包需要 zip 写入实现（archiver 适配层尚未落地，见 docs/91 §3）',
          },
        })
      },
    },

    // ── Provider 连通性测试（真实最小请求，docs/06 §3.1 healthCheck）────────
    provider: {
      test: async (config) => {
        const { apiKey: fromRequest, ...ai } = config
        // 优先用界面上刚粘贴、还没保存的密钥；否则读已保存的密文并解密。
        const apiKey = fromRequest && fromRequest.length > 0 ? fromRequest : readSecret('ai.apiKey')
        // 只探**主** Provider：降级链的 healthCheck 是 some(ok)，链尾 LocalEcho 恒为 ok，
        // 用它做连通性测试会永远显示「连接成功」—— 那就等于没有测试。
        const provider = resolvePrimaryProvider(ai as AppSettings['ai'], {
          apiKey,
          http: opts.aiHttp ?? createFetchHttpClient(),
        })
        const status = await provider.healthCheck()
        log.info('provider.test.done', {
          event: 'provider.test.done',
          provider: provider.kind,
          ok: status.ok,
          latencyMs: status.latencyMs ?? null,
        })
        return { ok: status.ok, message: status.message, latencyMs: status.latencyMs }
      },
    },

    // ── 事件推送（完整实现）───────────────────────────────────────────────
    events: {
      emit<E extends IpcEventName>(event: E, payload: IpcEventPayload<E>): void {
        const manager = state.windowManager
        if (!manager) return
        for (const contents of manager.liveWebContents()) {
          try {
            contents.send(event, payload)
          } catch (e) {
            log.warn('ipc.event.sendFailed', {
              event: 'ipc.event.sendFailed',
              channel: event,
              reason: String(e),
            })
          }
        }
      },
    },

    // ── 渲染 → 主的单向通道（完整实现：登记在真实 ipcMain 上）────────────
    sends: {
      on<S extends IpcSendName>(channel: S, handler: (payload: IpcSendPayload<S>) => void): void {
        const ipcMain = state.electron?.ipcMain
        if (!ipcMain) return
        ipcMain.on(channel, (_event, payload) => {
          try {
            handler(payload as IpcSendPayload<S>)
          } catch (e) {
            log.warn('ipc.send.handlerFailed', {
              event: 'ipc.send.handlerFailed',
              channel,
              reason: String(e),
            })
          }
        })
      },
    },
  }

  // 录音服务的事件端口在这里接上（它构造时 `deps` 还没成型，见上面的说明）
  eventsPort = deps.events

  return {
    deps,
    queue,
    domainHandlers,
    book: bookService,
    record: recordService,
    attachRecordPort: (port) => recordService.attachIncomingPort(port),
  }
}

/** 当前能力快照；未探测时给出「全都不可用」的诚实默认值，而不是假装可用 */
function currentCapabilities(state: AppState): AppCapabilities {
  const caps = state.capabilities
  if (caps) return caps
  return {
    ffmpeg: { version: '', available: false, path: null, filters: [], missing: [], encoders: [] },
    models: [],
    secureStorage: false,
    embedding: { modelId: 'bge-small-zh-v1.5', dim: 512, available: false },
  }
}

/** ffmpeg 是否就位（其它域据此决定是否允许「处理」类操作） */
export function isFfmpegAvailable(state: AppState): boolean {
  return state.capabilities?.ffmpeg.available === true
}

/** 首个存在的资源路径（供后续域探测二进制/模型用） */
export function firstExisting(candidates: readonly string[]): string | null {
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* 忽略非法路径 */
    }
  }
  return null
}

export type { AppSettings }
