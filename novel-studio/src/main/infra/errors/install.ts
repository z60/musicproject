/**
 * 主进程 · 全局错误钩子（错误兜底第三级）
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md §5 三级兜底、§6 各层职责
 *           docs/04 §5.4「崩溃捕获」、docs/01 §13.3「关键接线点」
 *
 * 职责：
 *   1. uncaughtException / unhandledRejection → 记录 + 通知渲染进程 + （必要时）优雅退出
 *   2. 提供 notifyRenderer()，让任意主进程代码把业务异常推给 UI
 *   3. 保证「错误处理路径本身永不抛错」
 *
 * 装配顺序要求：installGlobalErrorHandlers() 必须在创建窗口之前调用，
 * 这样窗口创建阶段的异常也能被捕获（docs/01 §13.3）。
 *
 * ### 本轮补齐的三件事（原实现的三处风险）
 *   1. **`onFatalShutdown` 只尝试一次**：原实现在每次未捕获异常时都会再调一次，
 *      而它要做的是「立即定稿正在写入的录音 WAV」——重复调用会二次定稿同一个文件，
 *      产生「幽灵 WAV」（第一次已改名，第二次去改一个不存在的路径）。
 *   2. **通知去重**：原实现按 `code+params` 在 3 秒窗口内去重，但**致命错误绕过去重**，
 *      于是每秒崩一次的致命错误会每秒弹一次窗。现在致命错误也去重（30 s 窗口），
 *      既保证用户看到，又不刷屏。
 *   3. **窗口不存在时不抛错**：electron 未加载（纯 Node 环境）、窗口已销毁、
 *      窗口正在重建，都不允许让错误处理路径本身抛错。
 */

import { AppError, toLogFields, wrapUnknown } from '../../../shared/errors.ts'
import type { SerializedAppError } from '../../../shared/errors.ts'
import type { Severity } from '../../../shared/messages.ts'
import type { BrowserWindowLike, ElectronLike } from '../electron/types.ts'

// ---------------------------------------------------------------------------
// 依赖注入（避免直接依赖具体 logger 实现，便于单测）
// ---------------------------------------------------------------------------

export interface ErrorHandlerDeps {
  /** 结构化日志。实现见 src/main/infra/log */
  log: {
    error: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
    info: (event: string, fields: Record<string, unknown>) => void
  }
  /**
   * 致命错误的收尾钩子：例如「立即定稿正在写入的录音 WAV」。
   * 必须是同步且快速的（可能已在崩溃路径上）。
   * **只会被调用一次**（见文件顶部说明 1）。
   */
  onFatalShutdown?: (err: AppError) => void
  /** 是否在未捕获异常后退出进程。默认：生产（isPackaged）true，开发 false */
  exitOnUncaught?: boolean
  /** 注入 electron（不传则惰性动态导入；纯 Node 测试环境拿不到也不报错） */
  electron?: ElectronLike
  /** 注入投递函数（默认遍历 electron 的全部窗口） */
  deliver?: (payload: SerializedAppError, severity: Severity) => void
  /** 退出前的宽限时间（毫秒），给日志与 UI 一点时间。默认 800 */
  exitGraceMs?: number
}

let deps: ErrorHandlerDeps | null = null
let installed = false
/** 防止「记录错误时又抛错」导致无限递归 */
let handling = false
/** 收尾钩子是否已经跑过（只跑一次） */
let fatalShutdownAttempted = false
/** 是否已排过退出定时器（避免连续异常排出一串 setTimeout） */
let exitScheduled = false

/** 近期已向 UI 展示过的错误（防止同一个错误反复弹窗） */
const recentlyNotified = new Map<string, number>()
/** 非致命错误的去重窗口（docs/04 §5.1：错误「记录 + 上报 UI（去重）」） */
const NOTIFY_DEDUPE_MS = 3000
/** 致命错误的去重窗口：更长，但**不再绕过去重** */
const FATAL_NOTIFY_DEDUPE_MS = 30_000

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export function installGlobalErrorHandlers(dependencies: ErrorHandlerDeps): void {
  if (installed) {
    dependencies.log.warn('errors.install.skipped', { event: 'errors.install.skipped', reason: 'already-installed' })
    return
  }
  installed = true
  deps = dependencies

  process.on('uncaughtException', (error, origin) => {
    if (handling) {
      // 极罕见：错误处理过程中再次崩溃。写裸 stderr 并退出，不再尝试日志。
      process.stderr.write(`[novel-studio] fatal during error handling: ${String(error)}\n`)
      process.exit(1)
      return
    }
    handling = true
    try {
      const appErr = wrapUnknown(error, 'MAIN_UNCAUGHT_EXCEPTION')
      dependencies.log.error('main.uncaughtException', {
        ...toLogFields(error, 'main.uncaughtException', { origin }, 'MAIN_UNCAUGHT_EXCEPTION'),
      })

      // 顺序不可换：先收尾（把录音等关键数据落盘）→ 再通知 → 再退出
      runFatalShutdownOnce(appErr)
      notifyRenderer(appErr)

      void maybeExit(String(origin))
    } finally {
      handling = false
    }
  })

  process.on('unhandledRejection', (reason) => {
    if (handling) return
    handling = true
    try {
      const appErr = wrapUnknown(reason, 'MAIN_UNHANDLED_REJECTION')
      dependencies.log.warn('main.unhandledRejection', {
        ...toLogFields(reason, 'main.unhandledRejection', undefined, 'MAIN_UNHANDLED_REJECTION'),
      })
      // promise 未处理通常不致命：fatal 级别才通知 UI，也**不退出**
      if (appErr.severity === 'fatal') notifyRenderer(appErr)
    } finally {
      handling = false
    }
  })

  // 下面两类事件需要 electron 才能订阅；拿不到（纯 Node 环境）就跳过，绝不因此抛错
  void attachElectronHooks(dependencies)
}

/** 订阅 electron 侧的崩溃事件（渲染进程崩溃、子进程异常退出） */
async function attachElectronHooks(dependencies: ErrorHandlerDeps): Promise<void> {
  try {
    const electron = dependencies.electron ?? (await loadElectronSafe())
    if (!electron?.app || typeof electron.app.on !== 'function') return

    electron.app.on('render-process-gone', (_event: unknown, _contents: unknown, details: unknown) => {
      const d = (details ?? {}) as { reason?: string; exitCode?: number }
      safeLog(dependencies, 'error', 'main.renderProcessGone', {
        event: 'main.renderProcessGone',
        code: 'UI_RENDER_ERROR',
        numericCode: 'E000000',
        severity: 'error',
        retryable: false,
        reason: d.reason ?? 'unknown',
        exitCode: d.exitCode ?? null,
      })
    })

    electron.app.on('child-process-gone', (_event: unknown, details: unknown) => {
      const d = (details ?? {}) as { type?: string; reason?: string; exitCode?: number }
      safeLog(dependencies, 'error', 'main.childProcessGone', {
        event: 'main.childProcessGone',
        severity: 'error',
        type: d.type ?? 'unknown',
        reason: d.reason ?? 'unknown',
        exitCode: d.exitCode ?? null,
      })
    })
  } catch (e) {
    safeLog(dependencies, 'warn', 'errors.install.electronHooks.skipped', {
      event: 'errors.install.electronHooks.skipped',
      reason: String(e),
    })
  }
}

/** 惰性加载 electron；失败返回 null（不抛错——这是错误处理路径） */
async function loadElectronSafe(): Promise<ElectronLike | null> {
  try {
    const mod = await import('../electron/index.ts')
    return await mod.loadElectron()
  } catch {
    return null
  }
}

/**
 * 收尾钩子只跑一次。
 * 为什么强调「一次」：它要做的是把正在写入的录音定稿（写 WAV 头 + 原子改名）。
 * 连续两次未捕获异常时重复定稿，第二次会去改一个已经改名的文件。
 */
function runFatalShutdownOnce(err: AppError): void {
  if (fatalShutdownAttempted) {
    safeLog(deps, 'warn', 'errors.onFatalShutdown.skipped', {
      event: 'errors.onFatalShutdown.skipped',
      reason: 'already-attempted',
      code: err.key,
    })
    return
  }
  fatalShutdownAttempted = true
  safeCall(() => deps?.onFatalShutdown?.(err), 'onFatalShutdown')
}

/** 是否需要退出，以及退出的宽限时间 */
async function maybeExit(origin: string): Promise<void> {
  if (exitScheduled) return
  try {
    let shouldExit = deps?.exitOnUncaught
    if (shouldExit === undefined) {
      const electron = deps?.electron ?? (await loadElectronSafe())
      // 拿不到 electron 信息时保守处理：**不退出**（开发/测试环境更安全；
      // 生产环境一定能拿到 app.isPackaged）
      shouldExit = electron?.app?.isPackaged ?? false
    }
    if (!shouldExit) return
    exitScheduled = true
    safeLog(deps, 'warn', 'main.exit.scheduled', {
      event: 'main.exit.scheduled',
      origin,
      graceMs: deps?.exitGraceMs ?? 800,
    })
    setTimeout(() => {
      try {
        const electron = deps?.electron
        if (electron?.app) electron.app.exit(1)
        else process.exit(1)
      } catch {
        process.exit(1)
      }
    }, deps?.exitGraceMs ?? 800)
  } catch {
    /* 连退出都失败：什么都不做比抛错好 */
  }
}

// ---------------------------------------------------------------------------
// 通知渲染进程
// ---------------------------------------------------------------------------

/**
 * 把主进程侧的异常推给 UI（事件 `app:error`，见 docs/20 §4.11）。
 *
 * **已被 IPC 响应的错误不要再调用它**，否则用户会看到两次（docs/20 §5.1）。
 * 本函数保证：
 *   · 同一错误在去重窗口内只推一次（致命错误窗口更长）
 *   · electron 不可用 / 没有窗口 / 窗口正在销毁 → 只记日志，永不抛错
 */
export function notifyRenderer(err: AppError | SerializedAppError, opts?: { force?: boolean }): void {
  const appErr = toAppError(err)

  if (!opts?.force) {
    const window = appErr.severity === 'fatal' ? FATAL_NOTIFY_DEDUPE_MS : NOTIFY_DEDUPE_MS
    const key = `${appErr.key}|${stableParams(appErr.params)}`
    const now = Date.now()
    const last = recentlyNotified.get(key)
    if (last !== undefined && now - last < window) {
      safeLog(deps, 'info', 'errors.notifyRenderer.deduped', {
        event: 'errors.notifyRenderer.deduped',
        code: appErr.key,
        windowMs: window,
      })
      return
    }
    recentlyNotified.set(key, now)
    pruneNotified(now)
  }

  const payload = appErr.toJSON()
  try {
    if (deps?.deliver) {
      deps.deliver(payload, appErr.severity)
      return
    }
    deliverViaElectron(payload, appErr.severity)
  } catch (e) {
    // 窗口正在销毁 / electron 不可用 → 忽略，但**不能反过来抛错**
    safeLog(deps, 'warn', 'errors.notifyRenderer.failed', {
      event: 'errors.notifyRenderer.failed',
      code: appErr.key,
      message: String(e),
    })
  }
}

/** 默认投递：遍历全部窗口；没有窗口就是没有（不报错；「不丢终态」由事件层负责） */
function deliverViaElectron(payload: SerializedAppError, severity: Severity): void {
  const electron = deps?.electron
  if (!electron?.BrowserWindow || typeof electron.BrowserWindow.getAllWindows !== 'function') {
    safeLog(deps, 'info', 'errors.notifyRenderer.noTarget', {
      event: 'errors.notifyRenderer.noTarget',
      code: payload.code,
      reason: 'electron-unavailable',
    })
    return
  }
  let windows: BrowserWindowLike[] = []
  try {
    windows = electron.BrowserWindow.getAllWindows()
  } catch (e) {
    safeLog(deps, 'warn', 'errors.notifyRenderer.failed', {
      event: 'errors.notifyRenderer.failed',
      code: payload.code,
      message: String(e),
    })
    return
  }
  if (!Array.isArray(windows) || windows.length === 0) {
    safeLog(deps, 'info', 'errors.notifyRenderer.noTarget', {
      event: 'errors.notifyRenderer.noTarget',
      code: payload.code,
      reason: 'no-window',
    })
    return
  }
  for (const win of windows) {
    try {
      if (win?.isDestroyed?.() ?? false) continue
      win.webContents.send('app:error', payload)
      // 致命错误时把窗口带到前台，否则用户可能根本没看到
      if (severity === 'fatal') {
        if (win.isMinimized?.() ?? false) win.restore?.()
        win.focus?.()
      }
    } catch (e) {
      // 单个窗口失败不影响其它窗口
      safeLog(deps, 'warn', 'errors.notifyRenderer.windowFailed', {
        event: 'errors.notifyRenderer.windowFailed',
        code: payload.code,
        message: String(e),
      })
    }
  }
}

function toAppError(err: AppError | SerializedAppError): AppError {
  if (err instanceof AppError) return err
  if (typeof err === 'object' && err !== null && 'numericCode' in err) {
    return AppError.fromSerialized(err as SerializedAppError)
  }
  return wrapUnknown(err)
}

function stableParams(params: Record<string, string | number> | undefined): string {
  const keys = Object.keys(params ?? {}).sort()
  return keys.map((k) => `${k}=${String((params as Record<string, unknown>)[k])}`).join('&')
}

/** 去重表不能无限增长 */
function pruneNotified(now: number): void {
  if (recentlyNotified.size < 200) return
  for (const [k, ts] of recentlyNotified) {
    if (now - ts > FATAL_NOTIFY_DEDUPE_MS) recentlyNotified.delete(k)
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function safeCall(fn: () => void, label: string): void {
  try {
    fn()
  } catch (e) {
    safeLog(deps, 'error', 'errors.safeCall.failed', {
      event: 'errors.safeCall.failed',
      label,
      message: String(e),
    })
  }
}

function safeLog(
  target: ErrorHandlerDeps | null,
  level: 'error' | 'warn' | 'info',
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    const fn = target?.log?.[level]
    if (typeof fn === 'function') fn(event, fields)
  } catch {
    /* 日志失败不能让错误处理路径崩掉 */
  }
}

/** 是否已发生致命收尾（诊断用） */
export function hasFatalShutdownRun(): boolean {
  return fatalShutdownAttempted
}

/** 供测试重置内部状态 */
export function __resetErrorHandlersForTest(): void {
  installed = false
  deps = null
  handling = false
  fatalShutdownAttempted = false
  exitScheduled = false
  recentlyNotified.clear()
}
