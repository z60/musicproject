/**
 * 基础设施 · Electron 最小接口
 * ============================================================================
 * 设计依据：docs/02 §3「Electron 安全配置」、docs/20 §8「preload 暴露面」
 *
 * **为什么这里定义自己的接口，而不是 `import type { BrowserWindow } from 'electron'`**：
 *   1. 本仓库的测试与脚本用 Node 原生 `--experimental-strip-types` 直接执行，
 *      环境里**没有安装 electron**；`import type` 虽会被擦除，但一旦有任何一个
 *      运行期 import 混进来（例如为了取常量），整个模块就会炸；
 *   2. 显式列出「我们到底用了 Electron 的哪些能力」比泛泛地引用一个巨大的类型更有价值：
 *      升级 Electron 时能一眼看出影响面；
 *   3. 便于单测注入假实现（tests/main/ipc-contract.test.ts 就是这么做的）。
 *
 * 生产实现天然满足这些接口（Electron 的类型是这里的超集，结构化类型自动兼容），
 * 装配点见 infra/electron/index.ts 的 `loadElectron()`。
 */

/** preload 侧的 ipcRenderer（只列本仓库用到的成员，docs/20 §8） */
export interface IpcRendererLike {
  /** 请求-响应 */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /** 单向发送（高频、可丢弃） */
  send(channel: string, ...args: unknown[]): void
  /** 订阅主进程事件 */
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  /** 取消订阅（必须与 on 成对，否则组件卸载后泄漏） */
  off(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  /**
   * 转移 MessagePort（录音音频的零拷贝通道，docs/05 §2.3）。
   * Electron 10+ 提供；缺失时应降级并明确提示，而不是静默丢音频。
   */
  postMessage?(channel: string, message: unknown, transfer?: unknown[]): void
}

/** `contextBridge`（只列本仓库用到的成员） */
export interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void
}

/**
 * 渲染进程的 webContents（只列本仓库用到的成员）
 */
export interface WebContentsLike {
  id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  on(event: string, listener: (...args: unknown[]) => void): void
  once?(event: string, listener: (...args: unknown[]) => void): void
  off?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
  setWindowOpenHandler?(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void
  setAudioMuted?(muted: boolean): void
  openDevTools?(): void
  reload?(): void
  /** preload 侧 postMessage（MessagePort 转移，docs/20 §2） */
  postMessage?(channel: string, message: unknown, transfer?: unknown[]): void
  session?: unknown
}

/** BrowserWindow（只列本仓库用到的成员） */
export interface BrowserWindowLike {
  webContents: WebContentsLike
  isDestroyed(): boolean
  isMinimized?(): boolean
  isMaximized?(): boolean
  restore?(): void
  focus?(): void
  show?(): void
  hide?(): void
  minimize?(): void
  maximize?(): void
  close?(): void
  destroy?(): void
  loadURL(url: string, opts?: Record<string, unknown>): Promise<void>
  loadFile?(filePath: string, opts?: Record<string, unknown>): Promise<void>
  getBounds(): { x: number; y: number; width: number; height: number }
  setBounds?(bounds: { x?: number; y?: number; width?: number; height?: number }): void
  on(event: string, listener: (...args: unknown[]) => void): void
  once?(event: string, listener: (...args: unknown[]) => void): void
}

export interface BrowserWindowCtorLike {
  new (options: BrowserWindowOptionsLike): BrowserWindowLike
  getAllWindows(): BrowserWindowLike[]
  fromWebContents?(contents: WebContentsLike): BrowserWindowLike | null
}

/** BrowserWindow 构造参数（本仓库只使用下面这些键，其余透传） */
export interface BrowserWindowOptionsLike {
  width?: number
  height?: number
  x?: number
  y?: number
  minWidth?: number
  minHeight?: number
  show?: boolean
  title?: string
  backgroundColor?: string
  autoHideMenuBar?: boolean
  webPreferences?: {
    preload?: string
    contextIsolation?: boolean
    nodeIntegration?: boolean
    sandbox?: boolean
    webSecurity?: boolean
    allowRunningInsecureContent?: boolean
    spellcheck?: boolean
    backgroundThrottling?: boolean
    devTools?: boolean
  }
  [key: string]: unknown
}

/** ipcMain.handle 的事件对象 */
export interface IpcMainInvokeEventLike {
  sender: WebContentsLike
  senderFrame?: { url?: string } | null
  frameId?: number
  processId?: number
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeAllListeners?(channel?: string): void
}

export interface DialogFilterLike {
  name: string
  extensions: string[]
}

export interface DialogLike {
  showOpenDialog(
    window: BrowserWindowLike | null,
    options: { title?: string; defaultPath?: string; properties?: string[]; filters?: DialogFilterLike[] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>
  showSaveDialog(
    window: BrowserWindowLike | null,
    options: { title?: string; defaultPath?: string; filters?: DialogFilterLike[] },
  ): Promise<{ canceled: boolean; filePath?: string }>
  showMessageBox?(
    window: BrowserWindowLike | null,
    options: { type?: string; title?: string; message: string; detail?: string; buttons?: string[]; defaultId?: number },
  ): Promise<{ response: number }>
}

export interface ShellLike {
  openExternal(url: string): Promise<void>
  showItemInFolder(fullPath: string): void
  openPath?(path: string): Promise<string>
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface ProtocolLike {
  handle(scheme: string, handler: (request: { url: string }) => Promise<unknown> | unknown): void
  registerSchemesAsPrivileged(schemes: unknown[]): void
}

export interface AppLike {
  isPackaged: boolean
  getVersion(): string
  getName?(): string
  /** 'userData' | 'logs' | 'temp' | 'home' | ... */
  getPath(name: string): string
  setPath?(name: string, path: string): void
  getAppPath?(): string
  getLocale?(): string
  whenReady(): Promise<void>
  on(event: string, listener: (...args: unknown[]) => void): void
  once?(event: string, listener: (...args: unknown[]) => void): void
  quit(): void
  exit(code?: number): void
  requestSingleInstanceLock(): boolean
  releaseSingleInstanceLock?(): void
  relaunch?(options?: { args?: string[]; execPath?: string }): void
  setAppUserModelId?(id: string): void
  commandLine?: { appendSwitch(key: string, value?: string): void }
}

/** `screen`（窗口状态恢复时用于避免窗口跑到屏幕外） */
export interface ScreenLike {
  getPrimaryDisplay(): { workAreaSize: { width: number; height: number }; bounds: { x: number; y: number; width: number; height: number } }
  getAllDisplays?(): Array<{ bounds: { x: number; y: number; width: number; height: number } }>
}

export interface PowerMonitorLike {
  on(event: string, listener: (...args: unknown[]) => void): void
}

/** electron 模块的最小投影 */
export interface ElectronLike {
  app: AppLike
  ipcMain: IpcMainLike
  BrowserWindow: BrowserWindowCtorLike
  dialog: DialogLike
  shell: ShellLike
  safeStorage: SafeStorageLike
  protocol?: ProtocolLike
  screen?: ScreenLike
  powerMonitor?: PowerMonitorLike
  crashReporter?: { start(options: Record<string, unknown>): void }
}
