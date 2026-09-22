/// <reference types="vite/client" />

/**
 * 渲染进程环境声明
 * ============================================================================
 * 说明：
 *   · `window.api` 的形状由 preload 决定（实现见 src/preload/index.ts，
 *     契约见 src/shared/ipc.ts）。这里只声明渲染进程能看到的最小面。
 *   · 组件**禁止**直接使用 window.api，一律经 src/renderer/src/shared/lib/ipc.ts
 *     的 call()/on()/send()，以便统一解包 IpcResult 并兑现错误（docs/22 §6.2）。
 */

import type {
  IpcChannel,
  IpcEventName,
  IpcEventPayload,
  IpcReq,
  IpcSendName,
  IpcSendPayload,
  IpcRes,
} from '../../shared/ipc.ts'

declare global {
  interface Window {
    readonly api: {
      /** 请求-响应（唯一允许的查询/命令入口，但请经 lib/ipc.ts 包装） */
      invoke<C extends IpcChannel>(channel: C, payload: IpcReq<C>): Promise<IpcRes<C>>
      /** 单向发送（高频、可丢弃） */
      send<S extends IpcSendName>(channel: S, payload: IpcSendPayload<S>): void
      /** 订阅事件，返回取消订阅函数（必须调用，否则组件卸载后泄漏） */
      on<E extends IpcEventName>(event: E, handler: (payload: IpcEventPayload<E>) => void): () => void
      /** 建立录音音频通道：通道由 **preload 侧**创建，渲染进程不碰 MessagePort（docs/91 §5.2.41） */
      attachRecordPort(): void
      /** 送出一块 PCM 到主进程（转移 ArrayBuffer；false = 通道还没建立） */
      sendRecordPcm(buffer: ArrayBuffer, frames: number): boolean
      /** 关闭录音音频通道（会话结束 / 释放采集时调用） */
      detachRecordPort(): void
      /** 构造 ns-media:// URL 以读取项目内音频（主进程侧做路径校验） */
      mediaUrl(projectId: string, relPath: string): string
    }
  }

  /** Vite 注入的环境变量 */
  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly PROD: boolean
    readonly MODE: string
  }
}

export {}
