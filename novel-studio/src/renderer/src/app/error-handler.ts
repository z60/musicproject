/**
 * 渲染进程 · 全局错误钩子（错误兜底第三级）
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md §5 三级兜底
 *
 * 覆盖四条「没人接」的路径：
 *   1. Vue 组件渲染/生命周期/侦听器内的异常      → app.config.errorHandler
 *   2. 未捕获的同步异常                          → window.onerror
 *   3. 未处理的 Promise 拒绝（最常见：漏 await）  → unhandledrejection
 *   4. 路由懒加载失败 / 主进程主动推送的错误      → router.onError + app:error
 *
 * 全部统一走 reportError()，因此文案、分级、去重、日志与其它错误完全一致。
 */

import type { App } from 'vue'
import type { Router } from 'vue-router'
import { AppError, isSerializedAppError } from '@shared/errors.ts'
import type { SerializedAppError } from '@shared/errors.ts'
import { on } from '../shared/lib/ipc.ts'
import { reportError } from '../shared/lib/error-bus.ts'

export interface GlobalHandlerOptions {
  /** 开发模式：展示 dev 说明与原始错误链 */
  isDev: boolean
  /** 是否把 window.onerror 的同步错误也当作致命（默认否，交给错误边界） */
  fatalOnWindowError?: boolean
}

let installed = false

/**
 * 装配全局错误钩子。必须在 app.mount() 之前调用。
 *
 * 顺序要求：
 *   initErrorBus(deps) → installGlobalErrorHandlers(...) → app.mount()
 * 这样挂载过程本身出错也能被兜住。
 */
export function installGlobalErrorHandlers(app: App, router: Router, options: GlobalHandlerOptions): void {
  if (installed) return
  installed = true

  // ── 1) Vue 内部异常 ──────────────────────────────────────────────────────
  app.config.errorHandler = (err, instance, info) => {
    const component = instance ? componentNameOf(instance) : undefined
    reportError(
      new AppError('UI_RENDER_ERROR', {
        cause: err,
        details: {
          info,                      // 'render function' | 'setup' | 'watcher callback' ...
          component,
        },
      }),
      { event: `renderer.vue.${String(info).replace(/\s+/g, '.')}` },
    )
  }

  // Vue 对未处理的 Promise 拒绝也会尝试拦截；这里兜住组件内 async 的漏网场景
  app.config.warnHandler = options.isDev
    ? (msg, _instance, trace) => {
        // 开发期只打印，不进错误总线（否则正常告警会弹窗）
        console.warn('[vue:warn]', msg, trace)
      }
    : () => { /* 生产期静默 */ }

  // ── 2) window.onerror：非 Vue 管理的同步异常（第三方脚本、原生事件回调）────
  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script 的 error 不冒泡到 window.onerror，但会到这里）
    const target = event.target as HTMLElement | null
    if (target && target !== (window as unknown as HTMLElement) && 'tagName' in target) {
      reportError(
        new AppError('INTERNAL', {
          details: { kind: 'resource', tag: target.tagName, src: (target as HTMLImageElement).src },
        }),
        { event: 'renderer.resourceLoadFailed', action: 'dismiss' },
      )
      return
    }

    reportError(
      new AppError('UI_RENDER_ERROR', {
        cause: event.error ?? event.message,
        details: { filename: event.filename, lineno: event.lineno, colno: event.colno },
      }),
      { event: 'renderer.windowError' },
    )
  }, true)

  // ── 3) 未处理的 Promise 拒绝 ────────────────────────────────────────────
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason

    // 取消类（用户点了取消）不应报错
    if (reason && typeof reason === 'object') {
      const name = (reason as { name?: string }).name
      if (name === 'AbortError') return
    }

    const appErr = isSerializedAppError(reason)
      ? AppError.fromSerialized(reason as SerializedAppError)
      : reason instanceof AppError
        ? reason
        : new AppError('UI_UNHANDLED_PROMISE', { cause: reason })

    reportError(appErr, { event: 'renderer.unhandledRejection' })
  })

  // ── 4) 路由错误：懒加载 chunk 失败最常见（构建产物更新后旧页面点击） ──────
  router.onError((error, to) => {
    const message = String((error as { message?: string })?.message ?? error)
    const isChunkError = /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(message)

    reportError(
      new AppError(isChunkError ? 'UI_RENDER_ERROR' : 'INTERNAL', {
        cause: error,
        details: { route: to?.fullPath, kind: isChunkError ? 'chunk-load' : 'router' },
        severity: isChunkError ? 'warning' : 'error',
        action: 'reload',
        retryable: isChunkError,
      }),
      { event: 'renderer.routerError' },
    )
  })

  // ── 5) 主进程主动推送的错误（app:error） ─────────────────────────────────
  // 这类错误未经请求-响应，必须在这里兑现，否则用户永远不知道主进程出了问题
  on('app:error', (payload) => {
    reportError(payload, { event: 'main.pushedError', force: true })
  })

  // ── 6) 启动时发现被中断的任务：提示用户可重试 ──────────────────────────
  on('main:interruptedTasks', (payload) => {
    const count = (payload as { count?: number } | undefined)?.count ?? 0
    if (count <= 0) return
    reportError(AppError.of('TASK_INTERRUPTED', { params: { count } }), {
      event: 'main.interruptedTasks',
      force: true,
    })
  })
}

/** 从组件实例尽力取出可读名称（用于定位是哪个组件崩了） */
function componentNameOf(instance: unknown): string | undefined {
  const inst = instance as { type?: { name?: string; __name?: string; __file?: string } } | null
  if (!inst?.type) return undefined
  return inst.type.name ?? inst.type.__name ?? inst.type.__file ?? 'AnonymousComponent'
}

/** 供测试重置 */
export function __resetGlobalHandlersForTest(): void {
  installed = false
}
