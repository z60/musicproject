/**
 * Novel Studio · 启动状态（启动流程里所有步骤共享的单一可变状态）
 * ============================================================================
 * 设计依据：docs/01 §10「启动顺序」、§11「关闭语义」
 *
 * ### 为什么需要它（而不是把值一层层传下去）
 *   `BOOT_STEPS` 的处理器签名是 `(ctx: BootContext) => ...`，`BootContext.values` 是
 *   无类型的 `Record<string, unknown>`。启动过程里跨步骤传递的句柄有七八个
 *   （logger / db / settings / 窗口 / 队列 …），全靠 `values` 传就意味着每一步都要
 *   `as` 一次，编译器完全帮不上忙 —— 名字打错也不会报错。
 *
 *   因此这里把跨步骤状态收敛成**一个带类型对象**，处理器直接读它。
 *   `BootContext.values` 仍然会被填充（供启动报告展示），但业务代码不依赖它。
 *
 * ### 生命周期
 *   `createAppState()` 在每次启动时创建一个；`dispose()` 保证「关了再开」不会泄漏。
 *   关闭顺序在 `dispose()` 里写死（先窗口后数据库），理由见该函数注释。
 */

import type { BrowserWindowLike, ElectronLike } from './infra/electron/types.ts'
import type { DbLike } from './infra/db/types.ts'
import type { Logger } from './infra/log/index.ts'
import type { TaskQueue } from './infra/queue/index.ts'
import type { WindowManager } from './bootstrap/window-manager.ts'
import type { ResolvedAppPaths } from './paths.ts'
import type { SettingsStore } from './settings.ts'
import type { StoreLogger } from './store-logger.ts'
import type { AppCapabilities } from '../shared/types.ts'

export interface AppState {
  // ── Electron ─────────────────────────────────────────────────────────────
  electron: ElectronLike | null

  // ── 启动第 1~2 步 ────────────────────────────────────────────────────────
  /** 是否拿到单实例锁（false → 调用方应立即退出，不继续后续步骤） */
  hasLock: boolean
  paths: ResolvedAppPaths | null
  /** 是否便携模式（进启动日志与诊断包） */
  portable: boolean

  // ── 启动第 3 步 ──────────────────────────────────────────────────────────
  storeLogger: StoreLogger | null

  // ── 启动第 4~6 步 ────────────────────────────────────────────────────────
  db: DbLike | null
  dbPath: string | null
  /** 迁移失败等原因进入只读模式（只读模式下写类 handler 必须拒绝） */
  readOnly: boolean
  /** 只读原因（进 UI 提示与诊断包） */
  readOnlyReason: string | null
  settings: SettingsStore | null

  // ── 启动第 9~10 步 ───────────────────────────────────────────────────────
  capabilities: AppCapabilities | null

  // ── 启动第 12~13 步 ──────────────────────────────────────────────────────
  queue: TaskQueue | null
  windowManager: WindowManager | null
  mainWindow: BrowserWindowLike | null

  // ── 派生 ─────────────────────────────────────────────────────────────────
  /** 便捷取 logger；未初始化时返回一个只写控制台的兜底实现（启动最早期的错误也需要能看见） */
  log(): Logger
  /** 便捷取路径；未解析时抛错（调用顺序错误必须立刻暴露，而不是静默返回 null） */
  requirePaths(): ResolvedAppPaths
  requireLogger(): Logger
  requireDb(): DbLike
  requireSettings(): SettingsStore
  requireWindow(): BrowserWindowLike
  /** 是否可写（只读模式下禁止一切写库操作） */
  canWrite(): boolean

  dispose(): Promise<void>
}

/** 兜底日志器：日志系统就绪前（或初始化失败时）也能把错误送到控制台 */
function fallbackLogger(): Logger {
  const noop = (): void => undefined
  const write = (level: string, event: string, data?: Record<string, unknown>): void => {
    const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ''
    if (level === 'error' || level === 'warn') console.error(`[${level}] ${event}${suffix}`)
    else console.info(`[${level}] ${event}${suffix}`)
  }
  const stub = {
    level: 'info' as const,
    setLevel: noop,
    error: (event: string, data?: Record<string, unknown>) => write('error', event, data),
    warn: (event: string, data?: Record<string, unknown>) => write('warn', event, data),
    info: (event: string, data?: Record<string, unknown>) => write('info', event, data),
    debug: noop,
    trace: noop,
    errorFields: (e: unknown, event: string, context?: Record<string, unknown>) =>
      write('error', event, { ...context, error: e instanceof Error ? e.message : String(e) }),
    child: () => stub,
    write: noop,
    addSink: noop,
    setEntryListener: noop,
    recent: () => [],
  }
  return stub as unknown as Logger
}

export function createAppState(): AppState {
  const state: AppState = {
    electron: null,
    hasLock: false,
    paths: null,
    portable: false,
    storeLogger: null,
    db: null,
    dbPath: null,
    readOnly: false,
    readOnlyReason: null,
    settings: null,
    capabilities: null,
    queue: null,
    windowManager: null,
    mainWindow: null,

    log(): Logger {
      return state.storeLogger?.logger ?? fallbackLogger()
    },

    requirePaths(): ResolvedAppPaths {
      if (!state.paths) throw new Error('启动顺序错误：路径尚未解析（resolvePaths 必须在任何用到路径的步骤之前）')
      return state.paths
    },

    requireLogger(): Logger {
      return state.log()
    },

    requireDb(): DbLike {
      if (!state.db) throw new Error('启动顺序错误：数据库尚未打开（openDatabase 必须在用到 db 的步骤之前）')
      return state.db
    },

    requireSettings(): SettingsStore {
      if (!state.settings) throw new Error('启动顺序错误：设置尚未初始化')
      return state.settings
    },

    requireWindow(): BrowserWindowLike {
      if (!state.mainWindow) throw new Error('启动顺序错误：主窗口尚未创建')
      return state.mainWindow
    },

    canWrite(): boolean {
      return state.db !== null && !state.readOnly
    },

    /**
     * 释放资源。
     *
     * **顺序有意如此**：先窗口后数据库。
     *   · 窗口先关 —— 渲染进程此时可能正在等一个 IPC 响应，若先关数据库，
     *     那些 handler 会以「数据库已关闭」失败，用户看到一串莫名其妙的错误。
     *   · 队列在数据库之前停 —— 队列的持久化写库依赖连接。
     */
    async dispose(): Promise<void> {
      try {
        if (state.queue) {
          await state.queue.dispose()
        }
      } catch (e) {
        state.log().warn('app.dispose.queueFailed', { event: 'app.dispose.queueFailed', reason: String(e) })
      }
      try {
        state.mainWindow = null
      } catch {
        /* 窗口销毁由 Electron 负责 */
      }
      try {
        state.db?.close()
      } catch (e) {
        state.log().warn('app.dispose.dbCloseFailed', { event: 'app.dispose.dbCloseFailed', reason: String(e) })
      }
      state.db = null
      state.windowManager = null
      state.queue = null
    },
  }
  return state
}
