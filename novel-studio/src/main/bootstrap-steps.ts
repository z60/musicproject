/**
 * Novel Studio · 启动步骤的实现（Electron 装配层）
 * ============================================================================
 * 设计依据：docs/01 §10「启动顺序（必须严格）」、§11「关闭与崩溃语义」
 *
 * ### 本文件与 bootstrap/ 的分工
 *   · `bootstrap/index.ts` 定义**顺序表**（`BOOT_STEPS`）与执行器 —— 纯逻辑、可测；
 *   · `bootstrap/app-lifecycle.ts` 定义 `StartupSteps` 契约与另一套步骤名 —— 可测；
 *   · **本文件是把它们接到真实 Electron / 数据库 / 文件系统上的那一层**。
 *
 *   只有这一层允许触碰 `electron`、`better-sqlite3`、真实文件路径。
 *   把装配集中在一处，测试环境（没有 Electron / 没有原生模块）才能完全不加载它。
 *
 * ### 顺序的两个不可交换点（docs/01 §10 原话）
 *   · 3 必须在 4 之前（**数据库出问题要留日志**）
 *   · 5 必须在 6 之前（**不能把待修复的 .tmp 当垃圾删掉** —— 会直接导致录音丢失）
 *
 *   这两条不是风格问题：调换后的后果不是报错，而是静默丢数据。
 */

import { promises as fsp, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { AppError, summarizeCauseChain } from '../shared/errors.ts'
import type { FfmpegCapabilities, ModelStatus } from '../shared/types.ts'
import { formatBootReport, type BootContext, type BootStepHandlers } from './bootstrap/index.ts'
import { cleanupCaches, cleanupStaleTemps, defaultCleanupTargets, DEFAULT_CACHE_TTL_MS, DEFAULT_TEMP_MAX_AGE_MS } from './bootstrap/cleanup.ts'
import { recoverRecordings } from './bootstrap/recovery.ts'
import { createWindowManager, MEDIA_SCHEME } from './bootstrap/window-manager.ts'
import { checkIntegrity, openDatabase, runMigrations } from './db.ts'
import { resolveAppPaths, ffmpegCandidates } from './paths.ts'
import { createSettingsStore } from './settings.ts'
import { createStoreLogger } from './store-logger.ts'
import type { AppState } from './app-state.ts'
import type { LogLevel } from './infra/log/index.ts'

export interface BootDeps {
  state: AppState
  /** 应用版本（`app.getVersion()`） */
  version: string
  /** 是否打包后运行 */
  isPackaged: boolean
  /** 开发期标志（控制 DevTools 与控制台日志） */
  isDev: boolean
  /**
   * 渲染进程入口地址。
   * dev 下是 Vite dev server（`ELECTRON_RENDERER_URL`）；打包后是 `file://.../out/renderer/index.html`。
   */
  rendererUrl: string | null
  rendererFile: string | null
  /** 进程级唯一标识文件所在目录（便携模式与单实例锁都用得到） */
  execPath: string
  /** 打包后的资源根（`process.resourcesPath`） */
  resourcesPath?: string
  /** 未打包时的 resources 目录（`<repo>/resources`） */
  devResourcesDir?: string
  /** preload 产物的绝对路径（`out/preload/index.cjs`） */
  preloadPath: string
}

/** 启动步骤实现表（键名必须与 `BOOT_STEPS` 的 id 完全一致，见 bootstrap/index.ts） */
export function createBootStepHandlers(deps: BootDeps): BootStepHandlers {
  const { state } = deps

  return {
    // ── 1. 单实例锁 ────────────────────────────────────────────────────────
    // 为什么在最前：第二次启动必须**聚焦已有窗口然后退出**，
    // 而不是开两个实例同时写同一个 SQLite（会直接触发 DB_BUSY/损坏)。
    'single-instance-lock': () => {
      const electron = state.electron
      if (!electron) throw new AppError('INTERNAL', { details: { reason: 'electron-not-loaded' } })

      state.hasLock = electron.app.requestSingleInstanceLock()
      if (!state.hasLock) {
        // 没拿到锁 → 立即退出。这里**不抛错**：这不是失败，是正常的「已有一个实例」。
        // 因此用 record 明确标注，让启动报告显示成 skipped 而不是 FAIL。
        return { hasLock: false }
      }

      electron.app.on('second-instance', () => {
        // 用户又点了一次图标：把已有窗口拉到前面
        try {
          state.windowManager?.focusExisting()
        } catch (e) {
          state.log().warn('app.secondInstance.focusFailed', {
            event: 'app.secondInstance.focusFailed',
            reason: String(e),
          })
        }
      })
      return { hasLock: true }
    },

    // ── 2. 解析路径 ────────────────────────────────────────────────────────
    'resolve-paths': () => {
      const electron = state.electron
      if (!electron) throw new AppError('INTERNAL', { details: { reason: 'electron-not-loaded' } })

      const paths = resolveAppPaths({
        execPath: deps.execPath,
        userDataDir: electron.app.getPath('userData'),
        isPackaged: deps.isPackaged,
        ...(deps.resourcesPath !== undefined ? { resourcesPath: deps.resourcesPath } : {}),
        ...(deps.devResourcesDir !== undefined ? { devResourcesDir: deps.devResourcesDir } : {}),
      })
      state.paths = paths
      state.portable = paths.portable
      state.dbPath = join(paths.userData, 'novel-studio.db')
      return { paths, portable: paths.portable, dbPath: state.dbPath }
    },

    // ── 3. 初始化日志（必须在数据库之前）──────────────────────────────────
    'init-logger': () => {
      const paths = state.requirePaths()
      const storeLogger = createStoreLogger({
        logDir: paths.logDir,
        level: readLogLevelOverride() ?? 'info',
        devOnly: deps.isDev,
      })
      state.storeLogger = storeLogger
      storeLogger.logger.info('app.boot.start', {
        event: 'app.boot.start',
        version: deps.version,
        isPackaged: deps.isPackaged,
        portable: state.portable,
        userData: paths.userData,
        logDir: paths.logDir,
      })
      return { logDir: paths.logDir }
    },

    // ── 4. 打开数据库 ──────────────────────────────────────────────────────
    'open-database': async () => {
      const paths = state.requirePaths()
      const log = state.requireLogger()
      const opened = await openDatabase({ dbPath: state.dbPath ?? join(paths.userData, 'novel-studio.db'), log })
      state.db = opened.db
      // 设置要尽早可用：日志级别、路径覆盖、AI provider 都由它决定。
      // 这里建的都是「读设置」的端口，写库前不需要队列。
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
        ...(readLogLevelOverride() ? { logLevel: readLogLevelOverride()! } : {}),
      })
      return { schemaVersion: 0 }
    },

    // ── 5. 跑迁移 ──────────────────────────────────────────────────────────
    'run-migrations': async () => {
      const paths = state.requirePaths()
      const log = state.requireLogger()
      try {
        const res = await runMigrations({ db: state.requireDb(), backupDir: paths.backupDir, log })
        return { from: res.result.from, to: res.result.to, applied: res.result.applied, backedUp: res.backedUp }
      } catch (e) {
        const appErr = e instanceof AppError ? e : null
        const reason = appErr ? appErr.key : String(e)
        const details = (appErr?.details ?? {}) as Record<string, unknown>

        // ── 基础设施残缺 vs 用户数据问题：必须区别对待 ──────────────────────
        // 「迁移 SQL 读不到」不是用户数据的问题，而是**安装/打包残缺**
        //   （.sql 没被复制到 out 目录、resources 缺失……）。
        // 这类情况降级成只读模式毫无意义：应用能开窗口，但一张业务表都没有，
        // 用户看到的是「点了没反应」，而真实原因只留在日志里。
        // 踩过的坑：`to` 多写了一层 main/ → SQL 落到 out/main/main/...
        // 运行时按 out/main 找 → ENOENT → 静默只读 → 库里只有 settings 一张表
        // （还是 createSettingsStore 自己建的），books/projects/meta 全都不存在。
        if (details['reason'] === 'sql-not-found') {
          throw new AppError('DB_MIGRATION_FAILED', {
            cause: e,
            details: {
              ...details,
              fatal: 'migration-sql-missing',
              hint: '迁移 SQL 未随构建产物提供：检查 electron.vite.config.ts 的 RUNTIME_ASSET_DIRS 是否正确复制到 out/main/infra/db/migrations/',
            },
          })
        }

        // 其余迁移失败 → 进只读模式而不是直接退出：
        // 用户至少还能导出数据、看诊断信息。写操作由 canWrite() 统一挡住。
        // 失败**必须**把完整原因链打进日志。
        // 踩过的坑：这里原来只记了 `reason`（= 'DB_MIGRATION_FAILED'），
        // 于是「SQL 文件根本没被复制到 out 目录」这个真实原因（ENOENT + 路径）
        // 在日志里完全看不到，只剩一个抽象错误码 —— 排查时无从下手。
        const causeChain = appErr?.causeChain ?? summarizeCauseChain(e)
        state.readOnly = true
        state.readOnlyReason = reason
        log.error('db.migrate.failed.readOnly', {
          event: 'db.migrate.failed.readOnly',
          reason,
          details,
          causeChain,
          stack: e instanceof Error ? e.stack : undefined,
        })
        return { readOnly: true, reason, details, causeChain }
      }
    },

    // ── 6. 完整性检查 ──────────────────────────────────────────────────────
    'integrity-check': () => {
      const log = state.requireLogger()
      const result = checkIntegrity(state.requireDb(), log)
      if (!result.ok) {
        // 不致命：应用照常启动，但要让用户知道（UI 读 capabilities 里的诊断位）
        log.warn('db.integrity.needsAttention', {
          event: 'db.integrity.needsAttention',
          errors: result.errors.slice(0, 3),
        })
      }
      return { ok: result.ok, errors: result.errors }
    },

    // ── 7. 崩溃恢复（必须在清理临时文件之前）──────────────────────────────
    'recover-crashed-recordings': async () => {
      const paths = state.requirePaths()
      const log = state.requireLogger()
      const report = await recoverRecordings({
        projectRoot: paths.projectRoot,
        log,
        quarantineDir: join(paths.userData, '.quarantine'),
        // 恢复出来的 session 要入 7 库；写库入口在数据库层可用时提供，
        // 只读模式下不注入 —— recovery 会把它们记成 unpersisted 而不是假装成功。
        ...(state.canWrite()
          ? {
              sessions: {
                insertRecoveredSession: () => {
                  // 真正的 recording_sessions 写入由「录音」域的 handler 负责；
                  // 启动恢复阶段没有 take/segment 上下文，因此这里**明确不写**，
                  // 只把文件修好并登记到 manifest，等用户在 UI 里确认后再入库。
                  // 这不是偷懒：盲目入库会产生「孤儿 session」，比不入库更难收拾。
                },
              },
            }
          : {}),
      })
      log.info('recovery.done', {
        event: 'recovery.done',
        scannedProjects: report.scannedProjects,
        candidates: report.candidates,
        repaired: report.repaired.length,
        abandoned: report.abandoned.length,
        unpersisted: report.unpersistedSessions,
        warnings: report.warnings.length,
      })
      // manifest 必须交给下一步（清理）当白名单，否则刚修好的录音会被删
      return { recoveryManifest: report.manifest, recovered: report.repaired.length }
    },

    // ── 8. 清理临时文件与缓存 ──────────────────────────────────────────────
    'cleanup-temp-and-cache': async (ctx: BootContext) => {
      const paths = state.requirePaths()
      const log = state.requireLogger()
      // 恢复清单来自上一步的产出，**必须**当白名单传下去：
      // 上一步刚把 `.wav.tmp` 修成可用录音，这一步若无脑清理就把它删了 ——
      // 这正是 docs/01 §10「5 必须在 6 之前」要防的事，也是本仓库最容易丢用户数据的一处。
      const manifest = readRecoveryManifest(ctx)

      const projectIds = listProjectIds(paths.projectRoot)
      const dirs = defaultCleanupTargets({
        userDataDir: paths.userData,
        projectRoot: paths.projectRoot,
        projectIds,
      })

      const temp = await cleanupStaleTemps({
        dirs,
        log,
        projectRoot: paths.projectRoot,
        modelDir: paths.modelDir,
        userDataDir: paths.userData,
        ...(state.dbPath ? { dbPath: state.dbPath } : {}),
        // 恢复清单：刚修好的录音**绝不删除**（docs/04 §3 规则 1）
        protectedPaths: manifest,
        maxAgeMs: DEFAULT_TEMP_MAX_AGE_MS,
      })

      const cache = await cleanupCaches({
        dirs: [join(paths.cacheDir, 'tmp')],
        log,
        projectRoot: paths.projectRoot,
        userDataDir: paths.userData,
        protectedPaths: manifest,
        caches: [
          { dir: join(paths.cacheDir, 'transcode'), ttlMs: DEFAULT_CACHE_TTL_MS },
          { dir: join(paths.cacheDir, 'asr'), ttlMs: DEFAULT_CACHE_TTL_MS },
          { dir: join(paths.cacheDir, 'embedding'), ttlMs: DEFAULT_CACHE_TTL_MS },
        ],
        logDir: paths.logDir,
      })

      log.info('cleanup.done', {
        event: 'cleanup.done',
        tempDeleted: temp.deletedFiles,
        cacheDeleted: cache.deletedFiles,
        protectedSkipped: temp.skippedProtected + cache.skippedProtected,
        manifestSize: manifest.length,
      })
      return { tempDeleted: temp.deletedFiles, cacheDeleted: cache.deletedFiles }
    },

    // ── 9. 校验模型（不阻塞开窗）──────────────────────────────────────────
    'verify-models': async () => {
      const paths = state.requirePaths()
      const models = await verifyModels(paths.modelDir, paths.resourceDir)
      const ok = models.filter((m) => m.ok).length
      state.log().info('models.verified', {
        event: 'models.verified',
        total: models.length,
        ok,
        missing: models.filter((m) => !m.exists).map((m) => m.id),
      })
      return { models, modelsOk: ok }
    },

    // ── 10. 探测 ffmpeg（不阻塞开窗）──────────────────────────────────────
    'detect-ffmpeg': async () => {
      const paths = state.requirePaths()
      const settings = state.settings?.current()
      const candidates = ffmpegCandidates({
        paths,
        // `settings?.paths?.ffmpegPath` 里的第二个 `?.` 不是多余的：
        // 启动路径上的设置树可能因库里存过坏值而缺一整支（docs/91 §5.2.3 的
        // `import = null` 就是这么让第 11 步崩掉的）。启动期读取一律取值级兜底，
        // 宁可退回「按候选路径探测」也不能让启动中止。
        settingsFfmpegPath: settings?.paths?.ffmpegPath ?? null,
      })
      const ffmpeg = await probeFfmpeg(candidates, state)
      state.log().info('ffmpeg.probed', {
        event: 'ffmpeg.probed',
        available: ffmpeg.available,
        version: ffmpeg.version,
        path: ffmpeg.path,
        missingFilters: ffmpeg.missing.length,
      })
      // 能力快照在这里成型，随后由 register-ipc-handlers 交给 capabilities 端口
      const prev = state.capabilities
      state.capabilities = {
        ffmpeg: ffmpeg.available ? ffmpeg : defaultFfmpegCapabilities(),
        models: prev?.models ?? [],
        secureStorage: canUseSecureStorage(state),
        embedding: prev?.embedding ?? { modelId: 'bge-small-zh-v1.5', dim: 512, available: false },
      }
      return { ffmpeg }
    },

    // ── 11. 注册媒体协议 ───────────────────────────────────────────────────
    // 注意：**权限声明不在这里**。`protocol.registerSchemesAsPrivileged` 必须在
    // 应用就绪**之前**调用（Electron 硬要求），因此它被放在 `src/main/index.ts`
    // 的 `whenReady()` 之前 —— 曾经写在这一步（ready 之后），真机上 0ms 就失败。
    // 这里只做 ready 之后才允许的那件事：绑定 `ns-media://` 的 handler。
    'register-media-protocol': () => {
      const electron = state.electron
      const paths = state.requirePaths()
      if (!electron?.protocol) {
        state.log().warn('protocol.skipped', { event: 'protocol.skipped', reason: 'protocol-unavailable' })
        return { registered: false }
      }
      // 真正的 handler 注册在 ipc 层（需要 fs 校验），这里只做「协议可用」这一步
      state.log().info('protocol.registered', { event: 'protocol.registered', scheme: MEDIA_SCHEME })
      return { registered: true, scheme: MEDIA_SCHEME, projectRoot: paths.projectRoot }
    },

    // ── 12. 注册 IPC handlers ──────────────────────────────────────────────
    // 由 src/main/index.ts 注入（它持有完整的 HandlerDeps 装配）。
    'register-ipc-handlers': () => {
      throw new AppError('APP_CONFIG_INVALID', {
        details: { reason: 'register-ipc-handlers-not-injected' },
      })
    },

    // ── 13. 创建主窗口 ─────────────────────────────────────────────────────
    'create-main-window': async () => {
      const electron = state.electron
      if (!electron) throw new AppError('INTERNAL', { details: { reason: 'electron-not-loaded' } })

      const manager = createWindowManager({
        electron,
        preloadPath: deps.preloadPath,
        appUrl: deps.rendererUrl ?? deps.rendererFile ?? '',
        allowedUrlPrefixes: deps.rendererUrl ? [deps.rendererUrl] : [],
        stateStore: createDbWindowStateStore(state),
        log: state.requireLogger(),
        isDev: deps.isDev,
      })
      state.windowManager = manager
      const win = await manager.createMainWindow()
      state.mainWindow = win
      return { created: true }
    },

    // ── 14. 载入渲染进程 ───────────────────────────────────────────────────
    'load-renderer': async () => {
      const win = state.requireWindow()
      const target = deps.rendererUrl ?? deps.rendererFile
      if (!target) {
        throw new AppError('APP_CONFIG_INVALID', {
          details: {
            reason: 'renderer-entry-missing',
            hint: 'dev 下需设置 ELECTRON_RENDERER_URL；打包后需提供 out/renderer/index.html 路径',
          },
        })
      }
      try {
        if (deps.rendererUrl) await win.loadURL(deps.rendererUrl)
        else if (win.loadFile) await win.loadFile(deps.rendererFile!)
        else await win.loadURL(`file://${deps.rendererFile!}`)
      } catch (e) {
        throw new AppError('INTERNAL', {
          cause: e,
          details: { reason: 'renderer-load-failed', target },
        })
      }
      state.log().info('window.renderer.loaded', { event: 'window.renderer.loaded', target })
      return { loaded: true }
    },

    // ── 15. 后台维护（不阻塞，失败不影响可用性）────────────────────────────
    'background-maintenance': async () => {
      const paths = state.requirePaths()
      const log = state.requireLogger()
      // 只做「读了就有用」的事：窗口状态已在关闭时保存，这里只补一次日志轮转。
      try {
        const { pruneOldLogs } = await import('./infra/log/index.ts')
        const removed = pruneOldLogs(paths.logDir, state.storeLogger?.retentionDays ?? 14)
        if (removed > 0) log.info('log.pruned', { event: 'log.pruned', removed })
      } catch (e) {
        log.warn('log.pruneFailed', { event: 'log.pruneFailed', reason: String(e) })
      }
      return { done: true }
    },
  }
}

// ============================================================================
// 辅助
// ============================================================================

/** 命令行 `--log-level=` 覆盖（排障用；优先于设置） */
function readLogLevelOverride(): LogLevel | null {
  const arg = process.argv.find((a) => a.startsWith('--log-level='))
  if (!arg) return null
  const v = arg.slice('--log-level='.length)
  return (['error', 'warn', 'info', 'debug', 'trace'] as const).includes(v as LogLevel) ? (v as LogLevel) : null
}

/**
 * 从启动上下文里取恢复清单。
 *
 * `BootContext.values` 是无类型袋子（`Record<string, unknown>`），因此这里做一次
 * **显式收敛**。取不到就返回空数组 —— 那样清理会更保守（宁可少删，不可误删）。
 */
function readRecoveryManifest(ctx: BootContext): readonly string[] {
  const v = ctx.values.recoveryManifest
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : []
}

/** 列出 `projects/` 下的项目 id（用于生成每项目的 .tmp 清理目标） */
function listProjectIds(projectRoot: string): string[] {
  try {
    return readdirSync(projectRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function defaultFfmpegCapabilities(): FfmpegCapabilities {
  return { version: '', available: false, path: null, filters: [], missing: [], encoders: [] }
}

function canUseSecureStorage(state: AppState): boolean {
  try {
    return state.electron?.safeStorage.isEncryptionAvailable() ?? false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 窗口状态持久化（settings 表）
// ---------------------------------------------------------------------------

/** 持久化窗口状态用的键（`settings` 表里的一行，与 AppSettings 树无关） */
const WINDOW_STATE_KEY = 'ui.windowState'

/**
 * 把窗口状态存进 `settings` 表。
 *
 * 为什么不放进 `AppSettings` 树：窗口位置是**机器相关**的运行时状态，
 * 不该出现在「导出设置 / 重置设置」里（用户在另一台机器上重置设置，
 * 不该顺手把自己这台机器的窗口位置也清掉）。
 */
function createDbWindowStateStore(state: AppState): import('./bootstrap/window-manager.ts').WindowStateStore {
  const read = (): { x?: number; y?: number; width: number; height: number; maximized: boolean } | null => {
    try {
      const db = state.db
      if (!db) return null
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(WINDOW_STATE_KEY) as
        | { value: string }
        | undefined
      if (!row) return null
      const parsed: unknown = JSON.parse(row.value)
      if (parsed === null || typeof parsed !== 'object') return null
      const o = parsed as Record<string, unknown>
      if (typeof o.width !== 'number' || typeof o.height !== 'number') return null
      return {
        ...(typeof o.x === 'number' ? { x: o.x } : {}),
        ...(typeof o.y === 'number' ? { y: o.y } : {}),
        width: o.width,
        height: o.height,
        maximized: o.maximized === true,
      }
    } catch {
      return null
    }
  }

  const write = (v: { x?: number; y?: number; width: number; height: number; maximized: boolean }): void => {
    try {
      const db = state.db
      if (!db) return
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      ).run(WINDOW_STATE_KEY, JSON.stringify(v), Date.now())
    } catch {
      /* 存不下窗口位置是小事，绝不影响关闭流程 */
    }
  }

  return { load: read, save: write }
}

// ---------------------------------------------------------------------------
// 模型校验
// ---------------------------------------------------------------------------

interface ModelsManifestEntry {
  id: string
  kind: 'whisper' | 'embedding'
  file: string
  sha256?: string | null
  sizeBytes?: number | null
}

/**
 * 校验 `resources/models/models.json` 里登记的模型是否就位。
 *
 * **只报不拦**：模型缺失时应用照常启动（不用模型的功能可用），
 * 只是 embedding/ASR 相关能力探测为 false —— UI 据此隐藏入口，
 * 而不是等用户点了才报错（docs/02 §5.1）。
 */
async function verifyModels(modelDir: string, resourceDir: string): Promise<ModelStatus[]> {
  const manifestPath = join(resourceDir, 'models', 'models.json')
  let entries: ModelsManifestEntry[] = []
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) entries = parsed as ModelsManifestEntry[]
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown }).models)) {
      entries = (parsed as { models: ModelsManifestEntry[] }).models
    }
  } catch {
    return []
  }

  const out: ModelStatus[] = []
  for (const e of entries) {
    const filePath = join(modelDir, e.file)
    let sizeBytes: number | null = null
    try {
      const st = await fsp.stat(filePath)
      sizeBytes = st.size
    } catch {
      sizeBytes = null
    }
    const exists = sizeBytes !== null
    const sizeOk = !e.sizeBytes || (sizeBytes !== null && sizeBytes === e.sizeBytes)
    out.push({
      id: e.id,
      kind: e.kind,
      filePath,
      exists,
      expectedSha256: e.sha256 ?? null,
      actualSha256: null, // 校验和留到用户显式点「校验」时算，启动期不读几十 MB 文件
      sizeBytes,
      ok: exists && sizeOk,
      message: exists
        ? sizeOk
          ? null
          : `文件大小与登记不符（期望 ${e.sizeBytes} 字节，实际 ${sizeBytes}）`
        : '模型文件不存在，请放入 resources/models 或改用 Mock provider',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// ffmpeg 探测
// ---------------------------------------------------------------------------

/** 关键滤镜白名单：缺任何一个，对应的处理链就没法跑（docs/14 §3.1） */
const REQUIRED_FILTERS = ['loudnorm', 'alimiter', 'highpass', 'acompressor', 'afftdn', 'deesser', 'equalizer'] as const

/**
 * 探测 ffmpeg（docs/02 §5.1）。
 *
 * 用 `-version` 与 `-filters` 两个命令：前者确认可执行，后者确认**关键滤镜**在位。
 * 只报可用性，不抛错 —— 没有 ffmpeg 时录音/对齐仍可用，只是没法处理与导出。
 */
async function probeFfmpeg(candidates: readonly string[], state: AppState): Promise<FfmpegCapabilities> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const log = state.requireLogger()

  for (const candidate of candidates) {
    try {
      const versionOut = await run(candidate, ['-version'], { timeout: 10_000, windowsHide: true })
      const version = /ffmpeg version (\S+)/.exec(String(versionOut.stdout))?.[1] ?? ''
      let filters: string[] = []
      let encoders: string[] = []
      try {
        const filtersOut = await run(candidate, ['-hide_banner', '-filters'], { timeout: 15_000, windowsHide: true })
        filters = parseNameColumn(String(filtersOut.stdout))
        const encodersOut = await run(candidate, ['-hide_banner', '-encoders'], { timeout: 15_000, windowsHide: true })
        encoders = parseNameColumn(String(encodersOut.stdout))
      } catch (e) {
        log.warn('ffmpeg.probe.filtersFailed', { event: 'ffmpeg.probe.filtersFailed', reason: String(e) })
      }
      const missing = REQUIRED_FILTERS.filter((f) => !filters.includes(f))
      return { version, available: true, path: candidate, filters, missing, encoders }
    } catch {
      // 换下一个候选
    }
  }
  return defaultFfmpegCapabilities()
}

/** 从 `ffmpeg -filters` / `-encoders` 的输出里取「名字」列（第二列是名称） */
function parseNameColumn(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    // 形如： ` T.. acompressor   A->A  ...` / ` V....D libx264  ...`
    const m = /^\s*[A-Z.]{5,}\s+(\S+)\s/.exec(line)
    if (m) out.push(m[1]!)
  }
  return out
}

export { formatBootReport }
