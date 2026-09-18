/**
 * 渲染进程 · 错误展示总线（唯一出提示的口子）
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md §7 展示策略
 *
 * 为什么必须有这一层：
 *   若每个组件都自己 ElMessage.error(res.error.message)，会出现
 *     · 同一错误弹两次（组件 + 全局）
 *     · 文案绕过消息表（用了 message 而不是 title）
 *     · 分级不一致（该弹框的弹成了 toast）
 *   因此规定：**消息展示只允许走 reportError()**。
 *
 * 关键行为：
 *   1. severity → 展示形式（info 顶部条 / warning toast / error toast+重试 / fatal 阻断 Modal）
 *   2. 取消类错误（TASK_CANCELLED 等）直接吞掉，不弹、不记 error 日志
 *   3. 1500 ms 内相同 code+params 合并为一条并累加计数（批量任务防刷屏）
 *   4. fatal 永不自动关闭，并禁止继续操作
 */

import { AppError, resolve, isAppError, isSerializedAppError } from '@shared/errors.ts'
import type { DisplayableError, SerializedAppError } from '@shared/errors.ts'
import type { ErrorAction, MessageKey, Severity } from '@shared/messages.ts'

// ---------------------------------------------------------------------------
// window.api 守卫（**故意不 import ipc.ts**）
// ---------------------------------------------------------------------------
// `ipc.ts` 会 import 本文件的 `reportError`。若这里反过来 import 它的
// `requireWindowApi`，就形成循环依赖 —— 循环依赖在运行期的表现是
// 「某个导出在特定加载顺序下是 undefined」，那是比原 bug 更难查的一类问题。
// 因此这里**本地**实现同一件事（9 行），宁可重复也不引入循环。
//
// 失败模式的说明见 shared/lib/ipc.ts 的 requireWindowApi 注释：
// preload 没生效时 `window.api` 是 undefined，而类型检查发现不了
// （env.d.ts 声明了它的形状）。
function requireWindowApi(): NonNullable<typeof window.api> {
  const api = window.api
  if (api === undefined || api === null) {
    throw new Error(
      '[ipc] window.api 不存在 —— preload 脚本没有生效，渲染进程无法访问主进程。\n' +
        '排查顺序：\n' +
        '  1. out/preload/index.cjs 是否存在\n' +
        '  2. 它是否为 CJS（行首有 import/export → sandbox preload 加载不了）\n' +
        '  3. src/preload/index.ts 末尾是否调用了 installPreload()\n' +
        '  4. 主进程窗口的 preloadPath 是否指向上面那个文件',
    )
  }
  return api
}

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export interface ReportErrorOptions {
  /** 重试回调：提供后且 action === 'retry' 时展示「重试」按钮 */
  retryFn?: () => void | Promise<void>
  /** 日志事件名（默认由调用方上下文推导） */
  event?: string
  /** 覆盖 action（少数场景：同一错误在不同页面可给不同动作） */
  action?: ErrorAction
  /** 覆盖展示正文（如批量任务把明细作为 detail 展示） */
  detailOverride?: string
  /** 强制不弹（仅记录），用于已知会被上层统一汇总的场景（批量任务逐条失败） */
  silent?: boolean
  /** 跳过去重（致命错误或用户主动点击查看时） */
  force?: boolean
}

export interface ErrorLogSink {
  (fields: {
    event: string
    level: 'error' | 'warn' | 'info'
    code: string
    numericCode: string
    severity: Severity
    params: Record<string, string | number>
    detail?: string
    causeChain?: string[]
    context?: Record<string, unknown>
  }): void
}
// ---------------------------------------------------------------------------
// 依赖注入（由 app 启动时装配，便于测试与替换 UI 库）
// ---------------------------------------------------------------------------

export interface ErrorBusDeps {
  /** 轻提示（info 级） */
  toastInfo: (text: string) => void
  /** 警告/错误 toast。返回可更新句柄（用于累加计数时不新开一条） */
  toast: (opts: {
    severity: Severity
    title: string
    detail?: string
    hint?: string
    /** 展开后的开发信息（仅 DEV） */
    devText?: string
    actions: Array<{ label: string; handler: () => void }>
  }) => { update: (patch: Partial<{ title: string; detail: string; hint: string }>) => void; close: () => void }
  /** 阻断型弹框（fatal）。不可自动关闭。 */
  modalFatal: (opts: {
    title: string
    detail?: string
    hint?: string
    code: string
    actions: Array<{ label: string; handler: () => void }>
  }) => void
  /** 写日志（主进程落盘） */
  log: ErrorLogSink
  /** 是否开发模式：决定是否展示 devText 与堆栈 */
  isDev: boolean
  /** fatal 时的额外收尾（例如禁用交互） */
  onFatal?: (err: DisplayableError) => void
}

let deps: ErrorBusDeps | null = null

export function initErrorBus(dependencies: ErrorBusDeps): void {
  deps = dependencies
}

// ---------------------------------------------------------------------------
// 去重与合并
// ---------------------------------------------------------------------------

interface ShownEntry {
  at: number
  count: number
  handle?: { update: (patch: Partial<{ title: string; detail: string; hint: string }>) => void }
}

const DEDUPE_WINDOW_MS = 1500
const shown = new Map<string, ShownEntry>()

/** 去重键：语义键 + 参数，避免把「缺少模型 A」和「缺少模型 B」合并成一条 */
function dedupeKey(appErr: AppError): string {
  const params = Object.keys(appErr.params).sort().map(k => `${k}=${String(appErr.params[k])}`).join('&')
  return params ? `${appErr.key}|${params}` : appErr.key
}

/** 供测试与「切章节/切项目」时清理 */
export function resetErrorBusDedupe(): void {
  shown.clear()
}

function gcShown(): void {
  const now = Date.now()
  for (const [k, v] of shown) {
    if (now - v.at > DEDUPE_WINDOW_MS * 4) shown.delete(k)
  }
}

// ---------------------------------------------------------------------------
// 核心：报告一个错误
// ---------------------------------------------------------------------------

/**
 * 唯一的错误展示入口。
 * 任何 catch 到的错误都应该交给它，而不是自己弹提示。
 */
export function reportError(input: unknown, options: ReportErrorOptions = {}): AppError {
  const appErr = normalize(input)

  // 1) 取消不是错误：吞掉
  if (appErr.isCancelled) {
    deps?.log({
      event: options.event ?? 'renderer.cancelled',
      level: 'info',
      code: appErr.key,
      numericCode: appErr.numericCode,
      severity: appErr.severity,
      params: appErr.params,
    })
    return appErr
  }

  const display = resolve(appErr, { includeDev: deps?.isDev ?? false })
  const action = options.action ?? display.action
  /** 批量任务等场景可由调用方覆盖正文（展示失败明细） */
  const detail = options.detailOverride ?? display.detail

  // 2) 始终写日志（即使用户看不到，也要能查）
  deps?.log({
    event: options.event ?? 'renderer.error',
    level: display.severity === 'error' || display.severity === 'fatal' ? 'error' : 'warn',
    code: display.key,
    numericCode: display.code,
    severity: display.severity,
    params: appErr.params,
    detail,
    causeChain: appErr.causeChain.length ? appErr.causeChain : undefined,
    ...(appErr.details ? { context: appErr.details } : {}),
  })

  if (options.silent) return appErr

  // 3) 去重 / 合并
  const key = dedupeKey(appErr)
  const now = Date.now()
  const prev = shown.get(key)
  if (!options.force && prev && now - prev.at < DEDUPE_WINDOW_MS && display.severity !== 'fatal') {
    prev.count++
    prev.at = now
    prev.handle?.update({
      title: `${display.title}（已发生 ${prev.count} 次）`,
    })
    return appErr
  }

  const actions = buildActions(action, display, options)

  // 4) 分级展示
  if (display.severity === 'fatal') {
    deps?.modalFatal({
      title: display.title,
      detail,
      hint: display.hint,
      code: display.code,
      actions,
    })
    deps?.onFatal?.(display)
    shown.set(key, { at: now, count: 1 })
    gcShown()
    return appErr
  }

  if (display.severity === 'info') {
    deps?.toastInfo([display.title, detail].filter(Boolean).join('：'))
    shown.set(key, { at: now, count: 1 })
    gcShown()
    return appErr
  }

  const handle = deps?.toast({
    severity: display.severity,
    title: display.title,
    detail,
    hint: display.hint,
    devText: display.devText,
    actions,
  })
  shown.set(key, { at: now, count: 1, handle })
  gcShown()
  return appErr
}

// ---------------------------------------------------------------------------
// 便捷入口
// ---------------------------------------------------------------------------

/** 明确知道原因时直接报业务异常 */
export function reportByKey(
  key: MessageKey,
  params?: Record<string, string | number>,
  options: ReportErrorOptions = {},
): AppError {
  return reportError(AppError.of(key, { params }), options)
}

/**
 * 批量任务汇总：避免逐条刷屏，由任务结束时统一报一条。
 * 典型场景：124 个片段处理，其中 8 个因同一原因失败 → 用户只看到 1 条提示。
 */
export function reportBatchFailures(opts: {
  total: number
  failed: number
  ok: number
  /** 失败明细（前 50 条进 details，前 5 条进提示正文） */
  samples?: Array<{ label: string; code: string; message: string }>
  /** 失败原因几乎相同时用这个码，默认按「全失败 / 部分失败」自动选 */
  primaryKey?: MessageKey
  /** 重试整批的回调 */
  retryFn?: () => void | Promise<void>
}): void {
  const { total, failed, ok } = opts
  if (failed === 0) return

  const allFailed = failed === total
  const primaryKey: MessageKey = opts.primaryKey ?? (allFailed ? 'TASK_FAILED' : 'EXPORT_PARTIAL_SUCCESS')

  const sampleLines = (opts.samples ?? [])
    .slice(0, 5)
    .map(s => `· ${s.label}：${s.message}（${s.code}）`)
    .join('\n')

  const err = new AppError(primaryKey, {
    params: { name: '批量任务', ok, failed, count: failed },
    details: { total, failed, ok, samples: opts.samples?.slice(0, 50) },
    severity: allFailed ? 'error' : 'warning',
    action: allFailed ? 'retry' : 'dismiss',
    retryable: allFailed,
  })

  reportError(err, {
    event: 'renderer.batchFailures',
    force: true,
    ...(sampleLines ? { detailOverride: `${err.resolved.detail ?? ''}\n${sampleLines}`.trim() } : {}),
    ...(opts.retryFn ? { retryFn: opts.retryFn } : {}),
  })

  // 完整明细进日志（提示里只放前 5 条，避免长文本挤爆 toast）
  if (sampleLines) {
    deps?.log({
      event: 'renderer.batchFailureDetails',
      level: 'error',
      code: err.key,
      numericCode: err.numericCode,
      severity: err.severity,
      params: err.params,
      detail: sampleLines,
      context: { total, failed, ok, samples: opts.samples },
    })
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function normalize(input: unknown): AppError {
  if (isAppError(input)) return input
  if (isSerializedAppError(input)) return AppError.fromSerialized(input as SerializedAppError)
  return AppError.of('INTERNAL', { cause: input })
}

function buildActions(
  action: ErrorAction,
  display: DisplayableError,
  options: ReportErrorOptions,
): Array<{ label: string; handler: () => void }> {
  const actions: Array<{ label: string; handler: () => void }> = []

  if (action === 'retry' && options.retryFn) {
    actions.push({
      label: '重试',
      handler: () => {
        void Promise.resolve()
          .then(() => options.retryFn?.())
          .catch((e) => reportError(e, { event: 'renderer.retryFailed' }))
      },
    })
  }

  if (action === 'open_settings') {
    actions.push({
      label: '前往设置',
      handler: () => { window.location.hash = `#/settings?focus=${encodeURIComponent(display.code)}` },
    })
  }

  if (action === 'open_folder') {
    actions.push({
      label: '打开文件夹',
      // 用 requireWindowApi() 而不是裸 window.api：preload 没生效时
      // 这条会抛出**说明原因**的错误（「preload 脚本没有生效」+ 排查顺序），
      // 而不是 `Cannot read properties of undefined (reading 'invoke')`。
      // 在错误提示的按钮里再报一个看不懂的错，是最糟的体验。
      handler: () => { void requireWindowApi().invoke('app:getPaths', undefined as never) },
    })
  }

  if (action === 'reload') {
    actions.push({ label: '重新加载', handler: () => window.location.reload() })
  }

  if (action === 'contact_support') {
    actions.push({
      label: '导出诊断包',
      handler: () => {
        void requireWindowApi().invoke('app:diagnostics', undefined as never)
          .catch(e => reportError(e, { event: 'renderer.diagnosticsFailed', action: 'dismiss' }))
      },
    })
  }

  return actions
}
