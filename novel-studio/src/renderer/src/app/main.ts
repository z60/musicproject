/**
 * Novel Studio · 渲染进程入口（应用装配）
 * ============================================================================
 * 设计依据：
 *   · docs/22 §6 —— 各层职责与接线点；**装配顺序**：
 *       initErrorBus(deps) → installGlobalErrorHandlers(app, router, …) → app.mount()
 *     理由（docs/22 §6 + §5 三级兜底）：
 *       1. error-bus 必须先拿到 UI 依赖（toast / modal / log），否则挂载期间一旦
 *          有错误要展示，会退化成「无处可弹」；
 *       2. 全局钩子必须在 mount 之前装上 —— **挂载过程本身也可能抛错**
 *          （某个组件的 setup 崩了、router 懒加载 chunk 404），那时走的是
 *          app.config.errorHandler / router.onError，晚一步就漏了；
 *       3. 最后才 mount，此时「错误 → 展示」的整条链路已经通了。
 *
 * 另外两条约定：
 *   · Element Plus 的 ElMessage / ElMessageBox 用**动态 import**：它们体积不小，
 *     首屏只是书架列表，没必要为了错误提示把整套反馈组件打进首屏包；
 *   · `log` 回调要把日志送到主进程（electron-log 落盘，docs/22 §8），
 *     本文件里的 sendLogToMain 说明了当前契约下的可行路径与退化策略。
 */

import { createApp, h, reactive } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

import App from './App.vue'
import { router } from './router'
import { installGlobalErrorHandlers } from './error-handler.ts'
import { ToastBody } from './toast-body.ts'
import { initErrorBus } from '@/shared/lib/error-bus.ts'
import type { ErrorBusDeps, ErrorLogSink } from '@/shared/lib/error-bus.ts'
import { call } from '@/shared/lib/ipc.ts'
import { useUiStore } from './store/ui.store.ts'
import '@/assets/theme.css'

const isDev = Boolean(import.meta.env?.DEV)

// ---------------------------------------------------------------------------
// Element Plus 反馈组件的懒加载（避免首屏加载）
// ---------------------------------------------------------------------------

async function loadMessage(): Promise<typeof import('element-plus')['ElMessage']> {
  const { ElMessage } = await import('element-plus')
  return ElMessage
}

async function loadMessageBox(): Promise<typeof import('element-plus')['ElMessageBox']> {
  const { ElMessageBox } = await import('element-plus')
  return ElMessageBox
}

/** severity → Element Plus 提示类型（docs/22 §7 的分级展示表） */
function toastType(severity: 'info' | 'warning' | 'error' | 'fatal'): 'info' | 'warning' | 'error' {
  if (severity === 'fatal') return 'error'
  return severity
}

// ---------------------------------------------------------------------------
// error-bus 依赖装配（docs/22 §7）
// ---------------------------------------------------------------------------

const toastInfo: ErrorBusDeps['toastInfo'] = (text) => {
  void loadMessage().then((ElMessage) => {
    ElMessage({ type: 'info', message: text, duration: 3000, showClose: true })
  })
}

const toast: ErrorBusDeps['toast'] = (opts) => {
  // 就地更新而不是重开一条：error-bus 的「已发生 N 次」合并靠这个 handle（docs/22 §7）
  const state = reactive({
    title: opts.title,
    detail: opts.detail ?? '',
    hint: opts.hint ?? '',
  })
  let instance: { close: () => void } | null = null

  void loadMessage().then((ElMessage) => {
    instance = ElMessage({
      type: toastType(opts.severity),
      duration: opts.severity === 'warning' ? 3000 : 5000,
      showClose: true,
      message: h(ToastBody, {
        state,
        devText: opts.devText ?? null,
        actions: opts.actions,
      }),
    })
  })

  return {
    update: (patch) => {
      Object.assign(state, patch)
    },
    close: () => {
      instance?.close()
    },
  }
}

const modalFatal: ErrorBusDeps['modalFatal'] = (opts) => {
  void loadMessageBox().then((ElMessageBox) => {
    const primary = opts.actions[0]
    void ElMessageBox({
      title: opts.title,
      // 不可自动关闭、不可点遮罩关闭（docs/22 §7：fatal 必须阻断）
      showClose: false,
      closeOnClickModal: false,
      closeOnPressEscape: false,
      showCancelButton: false,
      confirmButtonText: primary?.label ?? '我知道了',
      message: h(ToastBody, {
        state: reactive({
          title: '',
          detail: opts.detail ?? '',
          hint: opts.hint ?? '',
        }),
        devText: null,
        actions: opts.actions,
        code: opts.code,
      }),
      customClass: 'ns-fatal-modal',
    }).catch(() => {
      /* 用户点确认走 resolve；这里只是防止 unhandledrejection */
    }).finally(() => {
      primary?.handler()
    })
  })
}

/**
 * 渲染进程日志 → 主进程（最终落盘）。
 *
 * 契约现状（写成注释是因为这里踩到了文档不一致，且**已按契约收敛**）：
 *   · docs/20 §4.10 只登记了 `log:subscribe`（invoke）与 `log:entry`（**主 → 渲染的事件**），
 *     docs/22 §8 要求的日志落盘发生在主进程；`src/shared/ipc.ts` 的 `IpcSendMap`
 *     里**没有**渲染 → 主的日志通道（只有 `record:meter` / `record:mark` 两条高频通道）。
 *   · 因此这里走**唯一在契约内的路径**：渲染进程 console.* →
 *     Electron 的 `webContents 'console-message'` 事件把输出转发到主进程 →
 *     主进程的 electron-log 落盘。
 *
 * 为什么不再往主进程 `send('log:entry', ...)`：
 *   `send()` 的通道名类型来自 `IpcSendMap`，而 `log:entry` 不在其中；
 *   硬发需要往契约里新增一条渲染 → 主的发送通道（要同时改 IPC_SEND_NAMES、preload 白名单、
 *   主进程处理器、docs/20 与 docs/23），这属于**契约变更**，不能在「修类型」的名义下顺手做。
 *   console 转发路径已经能达成「日志落盘」这一目标，故按契约内的方案实现。
 */
const sendLogToMain: ErrorLogSink = (fields) => {
  logToConsole(fields)
}

function logToConsole(fields: Parameters<ErrorLogSink>[0]): void {
  const payload = {
    event: fields.event,
    code: fields.code,
    numericCode: fields.numericCode,
    severity: fields.severity,
    params: fields.params,
    detail: fields.detail,
    causeChain: fields.causeChain,
    context: fields.context,
  }
  if (fields.level === 'error') console.error('[ns]', payload)
  else if (fields.level === 'warn') console.warn('[ns]', payload)
  else console.info('[ns]', payload)
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(ElementPlus)

// 1) 先把错误展示链路接好（toast / modal / 日志 / fatal 收尾）
initErrorBus({
  toastInfo,
  toast,
  modalFatal,
  log: sendLogToMain,
  isDev,
  onFatal: (display) => {
    // fatal → 全局阻断：AppShell 渲染遮罩，后续交互被挡住（docs/22 §7）
    const ui = useUiStore(pinia)
    ui.setFatal(display)
    // 顺带把诊断包路径落日志，方便支持同学要用户去取
    void call('app:diagnostics', undefined)
      .then(result => sendLogToMain({
        event: 'renderer.fatalDiagnostics',
        level: 'error',
        code: display.code,
        numericCode: display.code,
        severity: 'fatal',
        params: {},
        context: { reportPath: result.reportPath },
      }))
      .catch(() => { /* 诊断包生成失败不再级联报错 */ })
  },
})

// 2) 再装全局钩子：Vue / window / promise / router / app:error（挂载期间的错误也要兜住）
installGlobalErrorHandlers(app, router, { isDev })

// 3) 主题在挂载前应用，避免首屏闪白（与 App.vue 的 onMounted 重复调用是无害的）
useUiStore(pinia).applyTheme()

// 4) 等路由就绪再挂载：避免首屏闪一个空白路由
void router.isReady().then(() => {
  app.mount('#app')
})
