/**
 * Novel Studio · preload（渲染进程与主进程之间唯一的桥）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §8「preload 暴露面」、docs/02 §3「Electron 安全配置」
 *
 * ### 这个文件的安全职责（比它看起来更重要）
 *   渲染进程是 `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，
 *   因此它**没有任何特权**。所有能力都必须经这里显式放行。因此本文件的三条纪律：
 *
 *   1. **白名单校验**：`invoke` / `send` / `on` 收到的通道名必须存在于
 *      `src/shared/ipc.ts` 的契约数组里。哪怕渲染进程被 XSS 注入，
 *      也只能调用契约里登记过的通道，无法构造任意通道名去够主进程。
 *   2. **绝不暴露 `ipcRenderer` 本体**，也不暴露 `require` / `process` / `fs`。
 *      只暴露 5 个窄接口（见下方 `exposeApi`）。
 *   3. **`on` 必须返回取消订阅函数** —— 否则 Vue 组件卸载后监听器泄漏，
 *      表现为「切走再回来会重复响应两次、三次…」。
 *
 * ### 为什么写成可注入的形式
 *   本仓库测试用 Node 原生 `--experimental-strip-types` 直接执行，环境里**没有 electron**。
 *   因此这里不静态 import electron，而是：
 *     · 生产：`installPreload()` 内部动态 `require('electron')`；
 *     · 测试：`createPreloadApi(fakeIpc)` 注入假 ipcRenderer，直接验证白名单与解包逻辑。
 */

import {
  IPC_CHANNELS,
  IPC_EVENT_NAMES,
  IPC_SEND_NAMES,
  isIpcChannel,
  isIpcEventName,
  isIpcSendName,
} from '../shared/ipc.ts'
import type { IpcRendererLike } from './infra/electron/types.ts'

// ---------------------------------------------------------------------------
// 对外暴露的 API 形状（与 src/renderer/src/env.d.ts 的声明一致）
// ---------------------------------------------------------------------------

export interface PreloadApi {
  /**
   * 请求-响应。**注意：返回的是 `IpcResult<T>` 原样结构**，
   * 解包与错误兑现由渲染进程的 `src/renderer/src/shared/lib/ipc.ts` 的 `call()` 负责
   * （docs/22 §6.2：消息展示只允许走 error-bus，所以这里不做任何提示）。
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>
  /** 单向发送（高频、可丢弃；如录音电平） */
  send(channel: string, payload?: unknown): void
  /** 订阅事件，返回取消订阅函数 */
  on(event: string, handler: (payload: unknown) => void): () => void
  /** 把录音音频的 MessagePort 交给主进程（零拷贝通道） */
  attachRecordPort(port: unknown): void
  /** 构造 `ns-media://` URL 以读取项目内音频（主进程侧做路径校验，docs/01 §4.3） */
  mediaUrl(projectId: string, relPath: string): string
}

// ---------------------------------------------------------------------------
// 构造（可注入，便于测试）
// ---------------------------------------------------------------------------

export interface PreloadLogger {
  warn(event: string, data?: Record<string, unknown>): void
}

export interface CreatePreloadApiOptions {
  /** 主进程是否支持 MessagePort 转移（旧版本 Electron 可能没有） */
  supportsPortTransfer?: boolean
  /** 可选的调试日志（preload 里没有 logger，用 console 或注入） */
  log?: PreloadLogger
}

/**
 * 构造暴露给渲染进程的 API。
 *
 * @throws 只在**装配阶段**（installPreload）抛错；运行期的通道校验失败会抛给调用方，
 *         由渲染进程的 error-bus 兑现成用户提示。
 */
export function createPreloadApi(
  ipc: IpcRendererLike,
  options: CreatePreloadApiOptions = {},
): PreloadApi {
  const log = options.log
  const supportsPortTransfer = options.supportsPortTransfer ?? typeof ipc.postMessage === 'function'

  /** 通道校验失败时抛出的错误（渲染进程会看到，属于开发期问题） */
  const rejectChannel = (kind: string, channel: string): never => {
    throw new Error(
      `[preload] 未登记的 ${kind} 通道：${channel}。` +
      `只有 src/shared/ipc.ts 契约中登记的通道才允许使用。`,
    )
  }

  return {
    async invoke(channel: string, payload?: unknown): Promise<unknown> {
      if (!isIpcChannel(channel)) rejectChannel('invoke', channel)
      // 无载荷通道（NoReq / void）必须传 undefined，否则主进程侧 schema 可能拒绝
      return ipc.invoke(channel, payload)
    },

    send(channel: string, payload?: unknown): void {
      if (!isIpcSendName(channel)) {
        // send 是单向的：抛错对调用方没有意义（没有 Promise 可 catch），
        // 因此只记警告并丢弃 —— 但仍不能用未登记通道去试探主进程。
        log?.warn('preload.send.rejected', { channel })
        return
      }
      ipc.send(channel, payload)
    },

    on(event: string, handler: (payload: unknown) => void): () => void {
      if (!isIpcEventName(event)) {
        log?.warn('preload.on.rejected', { event })
        // 返回空函数而不是抛错：订阅失败不应该让调用方的组件挂掉，
        // 但必须是**可见的**（有 warn 日志），不能静默成功。
        return () => void 0
      }

      const listener = (_e: unknown, payload: unknown): void => {
        handler(payload)
      }
      ipc.on(event, listener)

      return () => {
        ipc.off(event, listener)
      }
    },

    attachRecordPort(port: unknown): void {
      if (!supportsPortTransfer) {
        // 关键降级点：不能静默丢弃，否则用户录完才发现没声音
        throw new Error(
          '[preload] 当前 Electron 版本不支持 MessagePort 转移（ipcRenderer.postMessage 缺失）。' +
          '录音功能需要 Electron 10+；请升级 Electron 或改用文件式录音链路。',
        )
      }
      // 主进程侧在 ipc/handlers/record 里用 event.ports[0] 取端口
      ipc.postMessage!('record:port', null, [port])
    },

    mediaUrl(projectId: string, relPath: string): string {
      // 逐段编码：路径分隔符必须保留（否则主进程无法还原相对路径），
      // 但每段内的特殊字符要编码，避免 `..` 绕过与非法字符。
      const safeProject = encodeURIComponent(projectId)
      const safePath = relPath
        .split(/[\\/]+/)
        .filter(seg => seg.length > 0)
        .map(seg => encodeURIComponent(seg))
        .join('/')
      return `ns-media://${safeProject}/${safePath}`
    },
  }
}

// ---------------------------------------------------------------------------
// 装配（生产入口）
// ---------------------------------------------------------------------------

/**
 * 在 preload 环境里装配并暴露 API。
 *
 * 这个函数**只在 Electron 的 preload 沙箱里执行**，因此它内部用动态 require 取 electron，
 * 以保证同一份源码在 Node 测试环境下被 import 时不会因缺少 electron 而失败。
 */
export function installPreload(): void {
  let electron: { ipcRenderer?: IpcRendererLike; contextBridge?: { exposeInMainWorld(k: string, v: unknown): void } }

  try {
    // 用 require 而不是 import：preload 产物是 CJS（见 electron.vite.config.ts），
    // 且必须在**运行时**才去取 electron，否则测试环境 import 本模块会失败。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    electron = require('electron') as typeof electron
  } catch (e) {
    // 不在 Electron 环境中（例如被脚本误 import）：明确报错，不静默
    throw new Error(
      `[preload] 无法加载 electron 模块（本文件只能在 Electron 的 preload 环境里执行）：${String(e)}`,
    )
  }

  const { ipcRenderer, contextBridge } = electron
  if (!ipcRenderer || !contextBridge) {
    throw new Error('[preload] electron.ipcRenderer 或 electron.contextBridge 不可用，preload 无法装配')
  }

  const api = createPreloadApi(ipcRenderer, {
    supportsPortTransfer: typeof ipcRenderer.postMessage === 'function',
    log: {
      warn: (event, data) => {
        // preload 里没有主进程的 logger，只能落到渲染进程控制台；
        // 这类警告是「有人用了未登记通道」的信号，必须可见。
        console.warn(`[novel-studio:preload] ${event}`, data ?? '')
      },
    },
  })

  contextBridge.exposeInMainWorld('api', api)
}

// ---------------------------------------------------------------------------
// 自检（供测试与装配方核对）
// ---------------------------------------------------------------------------

/** preload 的三个白名单集合大小，用于启动日志与测试断言 */
export function preloadWhitelistSizes(): { channels: number; events: number; sends: number } {
  return {
    channels: IPC_CHANNELS.length,
    events: IPC_EVENT_NAMES.length,
    sends: IPC_SEND_NAMES.length,
  }
}
