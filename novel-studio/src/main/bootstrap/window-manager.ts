/**
 * 启动编排 · 窗口创建与安全硬化
 * ============================================================================
 * 设计依据：docs/02 §3「Electron 安全配置（必须照抄）」、docs/01 §11「关闭与崩溃语义」
 *
 * ```ts
 * webPreferences: {
 *   preload: join(__dirname, '../preload/index.js'),
 *   contextIsolation: true,      // 必须
 *   nodeIntegration: false,      // 必须
 *   sandbox: true,               // 必须；若某能力必须关闭，单独论证并记录 ADR
 *   webSecurity: true,           // 必须
 *   allowRunningInsecureContent: false,
 *   spellcheck: false,
 *   backgroundThrottling: false  // 录音/波形绘制需要稳定帧率
 * }
 * ```
 *
 * 全局硬化（每个 webContents 都要装）：
 *   · `setWindowOpenHandler` 一律 deny，外链交给系统浏览器
 *   · `will-navigate` 阻止导航离开应用
 *   · `will-attach-webview` 阻止挂 webview
 *
 * 窗口状态持久化：尺寸/位置/最大化状态写 `settings`（docs/04 §8.1），
 * 并且**必须校验仍在可见屏幕内**，否则换了外接显示器后窗口会跑到屏幕外打不开。
 */

import { AppError } from '../../shared/errors.ts'
import type {
  BrowserWindowLike,
  BrowserWindowOptionsLike,
  ElectronLike,
  WebContentsLike,
} from '../infra/electron/types.ts'

/** 窗口状态（持久化到 settings 表） */
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1440, height: 900, maximized: false }

/** 窗口状态读写端口（生产实现：SQLite settings 表，键 `ui.windowState`） */
export interface WindowStateStore {
  /** 未持久化过时返回 null（首次启动）；也可返回 Promise（SQLite 实现） */
  load(): WindowState | null | Promise<WindowState | null>
  save(state: WindowState): void | Promise<void>
}

/** 内存实现（测试与「设置不可用时」的降级） */
export function createMemoryWindowStateStore(initial?: WindowState): WindowStateStore & { state: WindowState | null } {
  const box = { state: initial ?? null }
  return {
    get state() {
      return box.state
    },
    load: () => box.state,
    save: (state) => {
      box.state = state
    },
  }
}

export interface WindowManagerOptions {
  electron: ElectronLike
  /** preload 绝对路径（`join(__dirname, '../preload/index.js')`） */
  preloadPath: string
  /** 允许导航到的基础 URL（dev server 地址或 file:// 产物路径） */
  appUrl: string
  /** 允许的 URL 前缀（dev 下可能有多个：Vite HMR 等） */
  allowedUrlPrefixes?: readonly string[]
  stateStore?: WindowStateStore
  log?: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
  }
  /** 打开外部链接（默认 electron.shell.openExternal） */
  openExternal?: (url: string) => void
  /** 只允许 http/https（docs/02 §3） */
  isDev?: boolean
}

export interface WindowManager {
  /** 创建主窗口（已应用安全配置与状态恢复） */
  createMainWindow(): Promise<BrowserWindowLike>
  /** 当前窗口（不存在或已销毁时返回 null） */
  getWindow(): BrowserWindowLike | null
  /** 全部可用 webContents（事件推送目标） */
  liveWebContents(): WebContentsLike[]
  /** 保存窗口状态（关闭前/定时调用） */
  persistState(): Promise<void>
  /** 聚焦窗口（二次启动时用，docs/01 §10 第 1 步） */
  focusExisting(): boolean
}

/**
 * 创建窗口管理器。
 *
 * 安全配置**不提供关闭开关**：想关只能改这个文件并写 ADR（docs/02 §3 的要求是
 * 「必须照抄」，把开关做出来就等于给未来的人一个偷懒的口子）。
 */
export function createWindowManager(opts: WindowManagerOptions): WindowManager {
  const { electron } = opts
  const log = opts.log
  let mainWindow: BrowserWindowLike | null = null

  function isAllowedNavigation(url: string, allowed: readonly string[]): boolean {
    if (allowed.some((prefix) => url.startsWith(prefix))) return true
    // file:// 产物（打包后）也放行：路径由我们自己给出
    return url.startsWith('file://')
  }

  /** 全局硬化：每个 webContents 创建时都要装（docs/02 §3） */
  function hardenContents(contents: WebContentsLike): void {
    try {
      contents.setWindowOpenHandler?.(({ url }) => {
        // 外链一律交给系统浏览器，绝不在应用内开窗（防钓鱼 + 防越权）
        try {
          if (/^https?:/i.test(url)) (opts.openExternal ?? electron.shell.openExternal)(url)
          else log?.warn?.('window.openExternal.blocked', { event: 'window.openExternal.blocked', scheme: url.split(':')[0] })
        } catch (e) {
          log?.warn?.('window.openExternal.failed', { event: 'window.openExternal.failed', reason: String(e) })
        }
        return { action: 'deny' }
      })
    } catch (e) {
      log?.warn?.('window.harden.setWindowOpenHandler.failed', { event: 'window.harden.setWindowOpenHandler.failed', reason: String(e) })
    }

    try {
      contents.on('will-navigate', (...args: unknown[]) => {
        const event = args[0] as { preventDefault?: () => void }
        const url = String(args[1] ?? '')
        const allowed = [opts.appUrl, ...(opts.allowedUrlPrefixes ?? [])]
        if (!isAllowedNavigation(url, allowed)) {
          event?.preventDefault?.()
          log?.warn?.('window.navigation.blocked', { event: 'window.navigation.blocked', url })
        }
      })
    } catch (e) {
      log?.warn?.('window.harden.willNavigate.failed', { event: 'window.harden.willNavigate.failed', reason: String(e) })
    }
  }

  /** 应用级硬化：任何新建的 webContents 都装一遍（含 devtools、子窗口） */
  function installAppLevelHardening(): void {
    try {
      electron.app.on('web-contents-created', (...args: unknown[]) => {
        const contents = args[1] as WebContentsLike | undefined
        if (!contents) return
        hardenContents(contents)
        // 禁止挂 webview（Electron 官方安全清单第一条）
        try {
          contents.on('will-attach-webview', (...inner: unknown[]) => {
            const event = inner[0] as { preventDefault?: () => void }
            event?.preventDefault?.()
          })
        } catch {
          /* 某些版本无此事件 */
        }
      })
    } catch (e) {
      log?.warn?.('window.harden.appLevel.failed', { event: 'window.harden.appLevel.failed', reason: String(e) })
    }
  }

  /** 把窗口位置校正到可见屏幕内（换显示器后窗口跑到屏幕外是经典支持问题） */
  function normalizeState(state: WindowState): WindowState {
    const safe: WindowState = {
      width: Math.max(1024, Math.floor(state.width || DEFAULT_WINDOW_STATE.width)),
      height: Math.max(680, Math.floor(state.height || DEFAULT_WINDOW_STATE.height)),
      maximized: state.maximized === true,
    }
    const screen = electron.screen
    if (screen && state.x !== undefined && state.y !== undefined) {
      const displays = screen.getAllDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
      const visible = displays.some((d) => {
        const b = d.bounds
        // 要求窗口标题栏至少有 40px 落在某个显示器内，否则用户拖不动它
        return state.x! + safe.width > b.x && state.x! < b.x + b.width && state.y! + 40 > b.y && state.y! < b.y + b.height
      })
      if (visible) {
        safe.x = Math.floor(state.x)
        safe.y = Math.floor(state.y)
      } else {
        log?.warn?.('window.state.offscreen', { event: 'window.state.offscreen', x: state.x, y: state.y })
      }
    } else if (state.x !== undefined && state.y !== undefined) {
      safe.x = Math.floor(state.x)
      safe.y = Math.floor(state.y)
    }
    return safe
  }

  async function loadState(): Promise<WindowState> {
    try {
      const saved = await opts.stateStore?.load()
      return normalizeState(saved ?? DEFAULT_WINDOW_STATE)
    } catch (e) {
      log?.warn?.('window.state.loadFailed', { event: 'window.state.loadFailed', reason: String(e) })
      return { ...DEFAULT_WINDOW_STATE }
    }
  }

  async function createMainWindow(): Promise<BrowserWindowLike> {
    const state = await loadState()
    const prefs = {
      preload: opts.preloadPath,
      // ── docs/02 §3：以下 7 项必须照抄 ──────────────────────────────────
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: false,
      ...(opts.isDev ? { devTools: true } : {}),
    }
    const options: BrowserWindowOptionsLike = {
      width: state.width,
      height: state.height,
      ...(state.x !== undefined ? { x: state.x } : {}),
      ...(state.y !== undefined ? { y: state.y } : {}),
      minWidth: 1024,
      minHeight: 680,
      show: false, // 先隐藏，ready-to-show 后再显示，避免白屏闪烁
      title: 'Novel Studio',
      backgroundColor: '#1a1a1a',
      autoHideMenuBar: true,
      webPreferences: prefs,
    }

    let win: BrowserWindowLike
    try {
      win = new electron.BrowserWindow(options)
    } catch (e) {
      throw new AppError('INTERNAL', { cause: e, details: { reason: 'window-create-failed' } })
    }
    mainWindow = win
    hardenContents(win.webContents)

    if (state.maximized) {
      try {
        win.maximize?.()
      } catch {
        /* 平台差异，忽略 */
      }
    }

    win.on('ready-to-show', () => {
      try {
        win.show?.()
      } catch (e) {
        log?.warn?.('window.show.failed', { event: 'window.show.failed', reason: String(e) })
      }
    })

    win.on('resize', () => void persistState())
    win.on('move', () => void persistState())
    win.on('close', () => void persistState())
    win.on('closed', () => {
      mainWindow = null
    })

    log?.info?.('window.create.done', {
      event: 'window.create.done',
      width: state.width,
      height: state.height,
      maximized: state.maximized,
    })
    return win
  }

  async function persistState(): Promise<void> {
    const win = mainWindow
    if (!win || (win.isDestroyed?.() ?? false)) return
    let state: WindowState
    try {
      const isMax = win.isMaximized?.() ?? false
      const bounds = win.getBounds()
      state = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: isMax,
      }
    } catch (e) {
      log?.warn?.('window.state.readFailed', { event: 'window.state.readFailed', reason: String(e) })
      return
    }
    try {
      await opts.stateStore?.save(state)
    } catch (e) {
      // 存不下窗口状态是小事，绝不能因此影响关闭流程
      log?.warn?.('window.state.saveFailed', { event: 'window.state.saveFailed', reason: String(e) })
    }
  }

  function getWindow(): BrowserWindowLike | null {
    if (!mainWindow) return null
    if (mainWindow.isDestroyed?.() ?? false) {
      mainWindow = null
      return null
    }
    return mainWindow
  }

  function liveWebContents(): WebContentsLike[] {
    const out: WebContentsLike[] = []
    const win = getWindow()
    if (win) out.push(win.webContents)
    try {
      for (const w of electron.BrowserWindow.getAllWindows()) {
        if (w.isDestroyed?.() ?? false) continue
        if (w.webContents && !out.includes(w.webContents)) out.push(w.webContents)
      }
    } catch {
      /* getAllWindows 在某些早期阶段不可用 */
    }
    return out
  }

  function focusExisting(): boolean {
    const win = getWindow()
    if (!win) return false
    try {
      if (win.isMinimized?.() ?? false) win.restore?.()
      win.focus?.()
      return true
    } catch (e) {
      log?.warn?.('window.focus.failed', { event: 'window.focus.failed', reason: String(e) })
      return false
    }
  }

  installAppLevelHardening()

  return { createMainWindow, getWindow, liveWebContents, persistState, focusExisting }
}

/**
 * 自定义协议 `ns-media://` 的注册与校验（docs/02 §3）。
 *
 * URL 形如 `ns-media://{projectId}/recordings/{id}.wav`，
 * handler 内**必须**校验解析出的路径位于 `{projectRoot}/{projectId}/` 之下，
 * 否则 `ns-media://p1/../../etc/passwd` 就能读到任意文件。
 */
export interface MediaProtocolDeps {
  electron: ElectronLike
  projectRoot: string
  log?: { warn: (event: string, fields: Record<string, unknown>) => void; info?: (event: string, fields: Record<string, unknown>) => void }
  /** 解析相对路径 → 绝对路径（生产传 infra/fs 的 resolveProjectPath） */
  resolve: (projectId: string, relPath: string) => string
  /** 读文件（默认 node:fs/promises） */
  readFile?: (absPath: string) => Promise<Buffer>
}

export const MEDIA_SCHEME = 'ns-media'

/** 注册 `ns-media://` 特权协议（必须在 app.ready 之前调用 registerSchemesAsPrivileged） */
export function registerMediaSchemePrivileges(electron: ElectronLike): void {
  try {
    electron.protocol?.registerSchemesAsPrivileged?.([
      {
        scheme: MEDIA_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
      },
    ])
  } catch (e) {
    throw new AppError('INTERNAL', { cause: e, details: { reason: 'protocol-privileges-failed' } })
  }
}

/** 注册 `ns-media://` handler（app.ready 之后） */
export function registerMediaProtocol(deps: MediaProtocolDeps): void {
  const protocol = deps.electron.protocol
  if (!protocol?.handle) {
    throw new AppError('INTERNAL', { details: { reason: 'protocol-unavailable' } })
  }
  const readFile = deps.readFile ?? (async (p: string) => (await import('node:fs/promises')).readFile(p))

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    // ns-media://{projectId}/{relPath}
    const projectId = decodeURIComponent(url.hostname || url.pathname.split('/')[1] || '')
    const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    // 逃逸校验在 resolve 里完成（infra/fs/paths.ts 的 resolveProjectPath 命中即抛 PATH_ESCAPE_BLOCKED）
    const abs = deps.resolve(projectId, relPath)
    const data = await readFile(abs)
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { 'content-type': contentTypeOf(abs) },
    })
  })
  deps.log?.info?.('protocol.media.registered', { event: 'protocol.media.registered', scheme: MEDIA_SCHEME })
}

function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
    case 'm4b':
      return 'audio/mp4'
    case 'ogg':
      return 'audio/ogg'
    case 'flac':
      return 'audio/flac'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    default:
      return 'application/octet-stream'
  }
}
