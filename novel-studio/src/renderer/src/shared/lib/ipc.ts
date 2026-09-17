/**
 * 渲染进程 · IPC 客户端（统一解包 + 统一兑现错误）
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md §6.1、§6.2
 *
 * 规则：
 *   · 组件与 store 一律通过 call() 访问主进程，禁止直接用 window.api.invoke
 *   · call() 内部完成 { ok, data, error } 的解包与 reportError，
 *     因此调用方只需关心成功路径（失败会抛出 AppError，可用 try/catch 处理额外逻辑）
 *   · 需要「失败也能继续」的场景用 callSafe()，它不抛错、不弹提示，返回 null
 */

import { AppError, isSerializedAppError } from '@shared/errors.ts'
import type { IpcResult, SerializedAppError } from '@shared/errors.ts'
import type {
  IpcContract as SharedIpcContract,
  IpcEventMap as SharedIpcEventMap,
  IpcSendName as SharedIpcSendName,
  IpcSendPayload as SharedIpcSendPayload,
} from '@shared/ipc.ts'
import { reportError, type ReportErrorOptions } from './error-bus.ts'

// ---------------------------------------------------------------------------
// 契约类型（唯一权威来源是 src/shared/ipc.ts；这里只做「渲染侧视图」）
// ---------------------------------------------------------------------------

/**
 * 渲染侧契约视图：
 *   · **继承** src/shared 的权威契约（docs/20 §1：通道名与载荷类型的唯一来源），
 *     这样 `call('canvas:getChapter', {...})` 的返回类型是 `CanvasLine[]` 而不是 `unknown`；
 *   · 同时保留宽松索引签名做兜底：万一某条通道尚未登记也能调用（类型为 unknown），
 *     避免「主进程加了通道、渲染侧编译不过」造成阻塞。
 */
export interface IpcContract extends SharedIpcContract {
  // 未登记通道的兜底（类型为 unknown，调用方自行收窄）
  [channel: string]: { req: unknown; res: unknown }
}

export type IpcChannel = keyof IpcContract
export type IpcReq<C extends IpcChannel> = IpcContract[C]['req']
export type IpcRes<C extends IpcChannel> = IpcContract[C]['res']

/**
 * 单向发送（`record:meter` / `record:mark`）。
 * 直接复用权威契约：这里**不加**兜底索引签名 ——
 * `keyof` 一旦被索引签名吞掉就退化成 `string`，再交给 `window.api.send<S extends IpcSendName>`
 * 就会报 TS2344「Type 'S' does not satisfy the constraint」。
 */
export type IpcSendName = SharedIpcSendName
export type IpcSendPayload<S extends IpcSendName> = SharedIpcSendPayload<S>

// ---------------------------------------------------------------------------
// 事件订阅类型
// ---------------------------------------------------------------------------

/** 事件同理：继承权威 IpcEventMap，保留兜底索引 */
export interface IpcEventMap extends SharedIpcEventMap {
  [event: string]: unknown
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

export interface CallOptions extends ReportErrorOptions {
  /**
   * 失败时的处理策略：
   *   'report'（默认）—— 交给 error-bus 展示
   *   'silent'        —— 只记日志，不弹（由上层统一汇总，如批量任务逐条失败）
   *   'throw'         —— 不展示，直接抛 AppError 给调用方
   */
  onError?: 'report' | 'silent' | 'throw'
}

/**
 * 调用主进程。成功返回数据；失败按 onError 策略处理，默认展示提示并抛出。
 * 调用方若只想在失败时做额外清理，可 try/catch；不需要就完全不写。
 */
export async function call<C extends IpcChannel>(
  channel: C,
  payload?: IpcReq<C>,
  options: CallOptions = {},
): Promise<IpcRes<C>> {
  const strategy = options.onError ?? 'report'

  let raw: IpcResult<IpcRes<C>>
  try {
    // 这里必须把通道名断言成 `keyof SharedIpcContract`（= preload 声明的 `IpcChannel`）：
    // 本地的 `IpcChannel` 为了兜底带了索引签名，`keyof` 会退化成 `string`，
    // 而 `window.api.invoke<C extends IpcChannel>` 的约束来自 shared 契约 ——
    // 直接传会报 TS2344「Type 'C' does not satisfy the constraint 'keyof IpcContract'」。
    // 断言只影响这一个实参的静态类型：载荷与返回值仍由上面的泛型 C 全程校验。
    // `payload as never` 同理：`invoke<C>` 期望 `IpcReq<C>`，而 C 此时已是「契约键」这种
    // 更宽的键类型，TS 无法证明 `IpcReq<C>` 一定可赋给该通道的具体载荷类型（如 `void`）。
    raw = (await window.api.invoke(
      channel as keyof SharedIpcContract,
      payload as never,
    )) as IpcResult<IpcRes<C>>
  } catch (e) {
    // 通道未注册 / preload 抛错 / 主进程未响应 —— 这类问题不该发生，兜底成 INTERNAL
    const appErr = AppError.of('INTERNAL', { cause: e, details: { channel } })
    if (strategy === 'throw') throw appErr
    if (strategy !== 'silent') reportError(appErr, { event: `ipc.${channel}.transportFailed`, ...options })
    throw appErr
  }

  if (raw && typeof raw === 'object' && 'ok' in raw) {
    if (raw.ok) return raw.data

    const serialized = raw.error
    const appErr = isSerializedAppError(serialized)
      ? AppError.fromSerialized(serialized as SerializedAppError)
      : AppError.of('INTERNAL', { details: { channel, raw } })

    if (strategy === 'throw') throw appErr
    if (strategy === 'silent') {
      reportError(appErr, { event: `ipc.${channel}.failed`, silent: true, ...options })
    } else {
      reportError(appErr, { event: `ipc.${channel}.failed`, ...options })
    }
    throw appErr
  }

  // 主进程返回了非契约形状（例如旧版本 handler 直接返回数据）：兼容放行
  return raw as unknown as IpcRes<C>
}

/** 不抛错版本：失败返回 null（并把错误静默记日志）。用于「尽力而为」的调用。 */
export async function callSafe<C extends IpcChannel>(
  channel: C,
  payload?: IpcReq<C>,
): Promise<IpcRes<C> | null> {
  try {
    return await call(channel, payload, { onError: 'silent' })
  } catch {
    return null
  }
}

/**
 * 「静默收集」版本：用于批量任务循环体。
 * 逐条失败不弹提示，收集后由调用方用 reportBatchFailures 统一汇总。
 */
export async function callCollecting<C extends IpcChannel>(
  channel: C,
  payload: IpcReq<C>,
  sink: Array<{ label: string; code: string; message: string }>,
  label: string,
): Promise<{ ok: true; data: IpcRes<C> } | { ok: false; error: AppError }> {
  try {
    return { ok: true, data: await call(channel, payload, { onError: 'throw' }) }
  } catch (e) {
    const appErr = e instanceof AppError ? e : AppError.of('INTERNAL', { cause: e })
    sink.push({ label, code: appErr.numericCode, message: appErr.message })
    reportError(appErr, { event: `ipc.${channel}.collectedFailure`, silent: true })
    return { ok: false, error: appErr }
  }
}

// ---------------------------------------------------------------------------
// 事件订阅（必须返回取消函数，否则组件卸载后会泄漏并重复响应）
// ---------------------------------------------------------------------------

export function on<E extends keyof SharedIpcEventMap & string>(
  event: E,
  handler: (payload: SharedIpcEventMap[E]) => void,
): () => void {
  // 断言是必要的，且**只**用于这一个调用：
  //   · 事件名：本地 `IpcEventMap` 带兜底索引签名，`keyof` 退化成 string，
  //     直接传会报 TS2344「Type 'E' does not satisfy the constraint 'keyof IpcEventMap'」；
  //   · handler：`on<E>` 的参数是 `IpcEventPayload<E>`，而 E 在此已是更宽的键类型，
  //     TS 无法证明二者兼容（函数参数逆变），故按 unknown 载荷转一次。
  // 对调用方没有损失：handler 的载荷类型仍由上面的 `SharedIpcEventMap[E]` 全程校验。
  const subscribe = window.api.on as (
    event: keyof SharedIpcEventMap,
    handler: (payload: unknown) => void,
  ) => () => void
  return subscribe(event, handler as (payload: unknown) => void)
}

/** 订阅任务进度（返回取消函数） */
export function onTaskProgress(
  taskId: string,
  handler: (p: IpcEventMap['task:progress']) => void,
): () => void {
  return on('task:progress', (p) => {
    if (p.taskId === taskId) handler(p)
  })
}

/** 单向发送（可丢弃的高频数据） */
export function send<S extends IpcSendName>(channel: S, payload?: IpcSendPayload<S>): void {
  window.api.send<S>(channel, payload as IpcSendPayload<S>)
}
