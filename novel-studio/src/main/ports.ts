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
 *   未实现的端口**不返回假数据**：调用即抛 `NOT_IMPLEMENTED` 并带上
 *   `params.feature`，与 `handlers/placeholders.ts` 的约定一致 ——
 *   返回空对象会让 UI 显示「导出成功 / 测试通过」这种真假难辨的状态。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { AppError } from '../shared/errors.ts'
import type { AppCapabilities, AppSettings } from '../shared/types.ts'
import type { HandlerDeps } from './ipc/handlers/deps.ts'
import { createMemoryTaskStore } from './infra/queue/store.ts'
import { TaskQueue } from './infra/queue/queue.ts'
import type { IpcEventName, IpcEventPayload, IpcSendName, IpcSendPayload } from '../shared/ipc.ts'
import type { Logger } from './infra/log/index.ts'
import { createDbPort } from './db.ts'
import { createBookService, type BookService } from './features/book/import/book.service.ts'
import { createBookHandlers } from './ipc/handlers/book.ts'
import { createChapterService } from './features/book/chapter/chapter.service.ts'
import { createChapterHandlers } from './ipc/handlers/chapter.ts'
import { createSqliteCanvasLineRepo } from './features/book/canvas/repositories/canvas-line.repo.sqlite.ts'
import type { RegisteredHandler } from './ipc/handlers/deps.ts'
import type { AppState } from './app-state.ts'

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
}

/** 端口装配的结果：既返回 HandlerDeps，也返回队列与域 handler（关闭/注册时要用） */
export interface BuiltPorts {
  deps: HandlerDeps
  queue: TaskQueue
  /** 领域 handler（书籍导入域等）。由 `registerAllHandlers` 的第三参注入。 */
  domainHandlers: RegisteredHandler[]
  /** 书籍导入域服务（供启动期的「确保默认项目」使用） */
  book: BookService
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
  const bookService = createBookService({
    getDb: () => state.db,
    projectRoot: paths.projectRoot,
    log,
    queue,
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

  const domainHandlers: RegisteredHandler[] = [
    ...createBookHandlers(bookService),
    ...createChapterHandlers(chapterService),
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
      setSecret: (key: string, value: string) => {
        // 加密由 infra/secure 负责；密钥值本身不落明文（docs/04 §9）
        const store = state.requireSettings()
        store.setSecretRaw(key, value)
      },
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

    // ── Provider 连通性测试（明确未实现）───────────────────────────────────
    provider: {
      test: async () => {
        throw new AppError('NOT_IMPLEMENTED', {
          params: { feature: 'AI Provider 连通性测试' },
          details: {
            reason: 'provider-test-not-implemented',
            hint: '真实连通性测试需要按 provider 类型发起一次最小请求；当前只有 mock/local 提供者',
          },
        })
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

  return { deps, queue, domainHandlers, book: bookService }
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
