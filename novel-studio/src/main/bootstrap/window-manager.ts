/**
 * 启动编排 · 窗口创建与安全硬化
 * ============================================================================
 * 设计依据：docs/02 §3「Electron 安全配置（必须照抄）」、docs/01 §11「关闭与崩溃语义」
 *
 * ```ts
 * webPreferences: {
 *   preload: join(__dirname, '../preload/index.cjs'),   // 必须 .cjs，见 WindowManagerOptions.preloadPath
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
import { isValidEventName } from '../infra/log/logger.ts'
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
  /**
   * preload 绝对路径。
   *
   * ⚠️ 必须是 **`out/preload/index.cjs`**，不是 `index.js` —— 原因：
   *   `package.json` 是 `"type": "module"`，因此 `.js` 会被按 ESM 解析；
   *   而 `sandbox: true` 的 preload 只有受限的 CJS `require`，**没有 ESM 能力**。
   *   所以 `electron.vite.config.ts` 把 preload 产物定为 `[name].cjs`
   *   （见该文件 `preload.build.rollupOptions.output`）。
   *   写成 `.js` 的症状是「窗口能开、但渲染进程没有 window.api」，
   *   而且主进程日志里没有明显报错 —— 很难查。
   */
  preloadPath: string
  /** 允许导航到的基础 URL（dev server 地址或 file:// 产物路径） */
  appUrl: string
  /** 允许的 URL 前缀（dev 下可能有多个：Vite HMR 等） */
  allowedUrlPrefixes?: readonly string[]
  stateStore?: WindowStateStore
  log?: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
    /** 渲染进程的 console.error 落到这一级；缺省时退到 warn */
    error?: (event: string, fields: Record<string, unknown>) => void
    debug?: (event: string, fields: Record<string, unknown>) => void
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

// ---------------------------------------------------------------------------
// 渲染进程 console → 主进程日志
// ---------------------------------------------------------------------------
// 为什么必须有这段（真机事故 docs/91 §5.2.41）：
//   `src/renderer/src/app/main.ts` 把「渲染进程日志最终落盘」的实现写成
//   「console.* → webContents 的 console-message 事件 → 主进程 electron-log」，
//   但主进程**从来没有注册过 `console-message`** —— 于是渲染进程的一切输出
//   （包括 reportError 的结构化记录）都停在了 devtools 里。
//   取证时的直接后果：日志里有 738 条主进程侧的
//   `record.frameGap {claimed:2304, written:0}`，却**一条渲染进程的
//   `recording.attachPort.failed` 都没有**，排查只能靠猜。
//
// 渲染进程用 `console.x('[ns] ' + JSON.stringify(payload))` 发结构化记录
// （必须是**单个字符串参数**：Chromium 只会把格式化后的文本交给 console-message，
// 多参数的对象会被渲染成 `{event: 'x'}` 这种非 JSON 文本，解析不回来）。

/** 结构化渲染日志的前缀（与 `src/renderer/src/app/main.ts` 的 `logToConsole` 约定一致） */
export const RENDERER_LOG_PREFIX = '[ns] '
/** 单条消息落盘上限：超长的堆栈/JSON 会挤爆日志文件 */
export const RENDERER_CONSOLE_MAX_CHARS = 4000

export interface RendererConsoleMessage {
  /** 0 verbose / 1 info / 2 warning / 3 error */
  level: number
  message: string
  line: number
  sourceId: string
}

/** 把 console-message 的两种参数形态（Electron ≤31 位置参数 / ≥32 的 details 对象）归一 */
export function parseConsoleMessageArgs(args: readonly unknown[]): RendererConsoleMessage {
  const second = args[1]
  const asLevel = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.min(3, Math.max(0, Math.trunc(value)))
    switch (String(value ?? '')) {
      case 'error':
        return 3
      case 'warning':
      case 'warn':
        return 2
      case 'info':
        return 1
      case 'debug':
      case 'verbose':
        return 0
      default:
        return 1
    }
  }
  if (second !== null && typeof second === 'object') {
    const d = second as { level?: unknown; message?: unknown; lineNumber?: unknown; line?: unknown; sourceId?: unknown }
    return {
      level: asLevel(d.level),
      message: String(d.message ?? ''),
      line: Number(d.lineNumber ?? d.line ?? 0) || 0,
      sourceId: String(d.sourceId ?? ''),
    }
  }
  return {
    level: asLevel(args[1]),
    message: String(args[2] ?? ''),
    line: Number(args[3] ?? 0) || 0,
    sourceId: String(args[4] ?? ''),
  }
}

/** `[ns] {json}` → 结构化字段；不是这种形态时返回 null（普通 console 输出） */
export function parseRendererLogPayload(message: string): Record<string, unknown> | null {
  if (!message.startsWith(RENDERER_LOG_PREFIX)) return null
  const body = message.slice(RENDERER_LOG_PREFIX.length).trim()
  if (!body.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    // 截断或非 JSON：按普通文本落盘（信息不能丢）
    return null
  }
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

  /**
   * 渲染进程 console → 主进程日志（见文件内「渲染进程 console → 主进程日志」一节）。
   *
   * 落盘策略：
   *   · `[ns] {json}` 形态 → 用渲染进程给的事件名（合法时）与结构化字段落盘，
   *     并打上 `rendererConsole: true`，这样 `recording.attachPort.failed` 这类
   *     渲染侧事件在主进程日志里**可被直接检索**；
   *   · 其余（Vue 警告、CSP 违规、未捕获异常…）→ 事件名统一为 `renderer.console`，
   *     原文进 `message`（截断到 4000 字符）。
   * 本函数**绝不抛错**：日志失败不能影响窗口。
   */
  function forwardRendererConsole(args: unknown[]): void {
    try {
      const parsed = parseConsoleMessageArgs(args)
      if (!parsed.message) return
      const text =
        parsed.message.length > RENDERER_CONSOLE_MAX_CHARS
          ? `${parsed.message.slice(0, RENDERER_CONSOLE_MAX_CHARS)}…（已截断 ${parsed.message.length - RENDERER_CONSOLE_MAX_CHARS} 字符）`
          : parsed.message

      const structured = parseRendererLogPayload(text)
      const fields: Record<string, unknown> = {
        ...(parsed.sourceId ? { source: parsed.sourceId } : {}),
        ...(parsed.line ? { line: parsed.line } : {}),
      }
      let event = 'renderer.console'
      if (structured) {
        const name = typeof structured.event === 'string' ? structured.event : ''
        if (isValidEventName(name)) event = name
        Object.assign(fields, structured, { rendererConsole: true })
        if (event === 'renderer.console') fields.rendererEvent = name || null
      } else {
        fields.message = text
      }

      const data = { event, ...fields }
      if (parsed.level >= 3) (log?.error ?? log?.warn)?.call(log, event, data)
      else if (parsed.level === 2) log?.warn?.call(log, event, data)
      else log?.info?.call(log, event, data)
    } catch {
      /* 渲染进程日志转发失败：静默（日志不能反过来成为故障源） */
    }
  }

  /**
   * 已经装过硬化的 webContents。
   *
   * 同一个 webContents 会被**两条路径**各装一次：应用级 `web-contents-created`
   * （BrowserWindow 构造时就发）与 `createMainWindow` 里的显式调用。
   * 没有这个去重，每个监听器都会装两遍 —— 症状是**渲染进程的每条日志都落盘两次**
   * （真机日志实证：同一条 CSP 警告 / `[vite] connecting` 成对出现）。
   */
  const hardenedContents = new WeakSet<object>()

  /** 全局硬化：每个 webContents 创建时都要装（docs/02 §3） */
  function hardenContents(contents: WebContentsLike): void {
    if (hardenedContents.has(contents as object)) return
    hardenedContents.add(contents as object)

    try {
      // 渲染进程 console → 主进程日志。**必须装在**：这是渲染侧唯一的落盘通路
      // （渲染进程没有直写日志的 IPC 通道，见 app/main.ts 的契约说明）。
      contents.on('console-message', (...args: unknown[]) => {
        forwardRendererConsole(args)
      })
    } catch (e) {
      log?.warn?.('window.harden.consoleMessage.failed', { event: 'window.harden.consoleMessage.failed', reason: String(e) })
    }

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
