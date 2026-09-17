/**
 * 主进程 · IPC 注册表与错误包裹器（错误兜底第二级）
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md §6.1（为何用 {ok,error} 而非 throw）
 *           docs/20-IPC契约.md §1（契约原则）、§5（错误契约）、§10（测试要点）
 *
 * 核心约定：
 *   ipcMain.handle 抛出的异常会被 Electron 序列化，自定义字段（code / retryable）
 *   会全部丢失，只剩一个 message 字符串。因此这里 handler **永不 throw**，
 *   一律返回 `{ ok: true, data }` 或 `{ ok: false, error: SerializedAppError }`。
 *
 * 每个 handler 自动获得：
 *   1. 载荷校验（本仓库内置的 `validate`，失败 → INVALID_PAYLOAD + 字段级 details）
 *   2. 未捕获异常的兜底包裹（wrapUnknown → 按 errno 映射表转业务码）
 *   3. 错误日志（含 numericCode / causeChain / context）
 *   4. 若业务代码已显式 notifyRenderer，则不再重复推送（wasNotified 机制）
 *
 * ### 本次改造（相对上一轮）
 *   · **去掉对 `zod` 与 `electron` 的静态依赖**：schema 改用 `infra/validate`，
 *     `ipcMain` 通过 {@link initIpcRegistry} 注入（`IpcMainLike` 是本仓库自己的最小接口），
 *     因此本文件可以在纯 Node 下被 import 与测试
 *   · 新增 **契约完整性自检** {@link assertContractParity}：比对 `IPC_CHANNELS`
 *     与实际注册的通道集合，缺失/多余都抛错（启动自检 + 测试共用）
 */

import {
  AppError,
  fail,
  isAppError,
  ok,
  toLogFields,
  wrapUnknown,
} from '../../shared/errors.ts'
import type { IpcResult } from '../../shared/errors.ts'
import { IPC_CHANNELS } from '../../shared/ipc.ts'
import type { MessageKey } from '../../shared/messages.ts'
import { extractIssues, type Schema } from '../infra/validate/index.ts'
import type { IpcMainInvokeEventLike, IpcMainLike } from '../infra/electron/types.ts'

export { isRetryableError, shouldRetry } from '../infra/errors/retry.ts'

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

export interface IpcRegistryDeps {
  /**
   * ipcMain（Electron 的真对象，或测试用的内存实现）。
   * 不传时 {@link handle} 只登记不注册 —— 便于纯逻辑测试，
   * 但**启动自检会因此失败**（这正是我们想要的：漏装配要吵出来）。
   */
  ipcMain?: IpcMainLike
  log: {
    error: (event: string, fields: Record<string, unknown>) => void
    info: (event: string, fields: Record<string, unknown>) => void
  }
  /**
   * 错误已被推送过（业务代码自己弹过提示）时返回 true。
   * 用于避免「业务已提示 + handler 又提示」的双弹。
   */
  wasNotified?: (err: AppError) => boolean
}

let deps: IpcRegistryDeps | null = null
const registered = new Set<string>()
/** 通道 → 已包装的处理器（测试与自检可直接调用，绕过 Electron） */
const wrappers = new Map<string, (event: IpcMainInvokeEventLike, raw: unknown) => Promise<IpcResult<unknown>>>()

export function initIpcRegistry(dependencies: IpcRegistryDeps): void {
  deps = dependencies
}

/** 重置（测试用）：清空登记与包装器 */
export function __resetRegistryForTest(): void {
  deps = null
  registered.clear()
  wrappers.clear()
}

// ---------------------------------------------------------------------------
// 上下文：让日志能带上「哪个通道、哪个项目、哪个任务」
// ---------------------------------------------------------------------------

export interface IpcContext {
  channel: string
  /** 可从载荷中提取的排障维度（不强制） */
  projectId?: string
  taskId?: string
  chapterId?: string
  bookId?: string
  lineId?: string
  segmentId?: string
  sessionId?: string
  actorId?: string
}

/** 从载荷里尽力提取上下文（只认少数已知字段，避免把正文写进日志） */
export function extractContext(channel: string, payload: unknown): IpcContext {
  const ctx: IpcContext = { channel }
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    for (const field of ['projectId', 'taskId', 'chapterId', 'bookId', 'lineId', 'segmentId', 'sessionId', 'actorId'] as const) {
      const v = p[field]
      if (typeof v === 'string' && v.length < 64) ctx[field] = v
    }
  }
  return ctx
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export interface HandleOptions {
  /**
   * 该通道的兜底语义键。默认 INTERNAL。
   * 若能预期主要失败场景（如导入通道 → 多为文件问题），指定更精确的兜底码，
   * 可以让未知异常也给出比「发生了未预期的错误」更有用的提示。
   */
  fallbackKey?: MessageKey
  /** 幂等：重复注册同一通道时是否覆盖（默认抛错，防止手误重复注册） */
  overwrite?: boolean
}

/**
 * 注册一个 invoke 通道。
 *
 * @param channel 契约里的通道名（`src/shared/ipc.ts` 的 `IpcChannel`）
 * @param schema  载荷校验器（`infra/validate`，与 zod 调用形态一致）
 * @param fn      业务实现。**允许 throw**：这里统一转成 `{ok:false,error}`
 */
export function handle<TReq, TRes>(
  channel: string,
  schema: Schema<TReq>,
  fn: (req: TReq, event: IpcMainInvokeEventLike, ctx: IpcContext) => Promise<TRes> | TRes,
  options: HandleOptions = {},
): void {
  if (registered.has(channel)) {
    if (!options.overwrite) {
      throw new Error(`[ipc] 通道重复注册：${channel}（如需覆盖请显式传 overwrite: true）`)
    }
    registered.delete(channel)
    wrappers.delete(channel)
  }
  registered.add(channel)

  const fallbackKey = options.fallbackKey ?? 'INTERNAL'

  const wrapper = async (event: IpcMainInvokeEventLike, raw: unknown): Promise<IpcResult<TRes>> => {
    const ctx = extractContext(channel, raw)

    // ── 1) 载荷校验 ────────────────────────────────────────────────────────
    let req: TReq
    try {
      req = schema.parse(raw)
    } catch (e) {
      const issues = extractIssues(e)
      const appErr = new AppError('INVALID_PAYLOAD', {
        details: { ...ctx, issues },
        cause: e,
      })
      logFailure(`${channel}.invalidPayload`, appErr, ctx)
      // 载荷错误属于开发问题（参数校验失败），不推 UI toast——用户看到也没法行动
      return fail(appErr, 'INVALID_PAYLOAD')
    }

    // ── 2) 执行业务 ────────────────────────────────────────────────────────
    try {
      const data = await fn(req, event, ctx)
      return ok(data)
    } catch (e) {
      const appErr = wrapUnknown(e, fallbackKey)

      // 取消不是错误：不写 error 日志、不推 UI（docs/22 §4「取消不是错误」）
      if (appErr.isCancelled) {
        deps?.log.info(`${channel}.cancelled`, { event: `${channel}.cancelled`, ...ctx })
        return { ok: false, error: appErr.toJSON() }
      }

      logFailure(`${channel}.failed`, appErr, ctx)
      // 业务已自行 notifyRenderer 过的，这里不再推（避免双弹，docs/20 §4.11）
      if (deps?.wasNotified?.(appErr)) {
        deps.log.info(`${channel}.notify.skipped`, { event: `${channel}.notify.skipped`, ...ctx, code: appErr.key })
      }
      return { ok: false, error: appErr.toJSON() }
    }
  }

  wrappers.set(channel, wrapper as (event: IpcMainInvokeEventLike, raw: unknown) => Promise<IpcResult<unknown>>)
  if (deps?.ipcMain) {
    deps.ipcMain.handle(channel, wrapper as (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown)
  }
}

/** 需要主进程主动推送（不经请求-响应）的场景：登记仅用于占位与契约一致性 */
export function markChannelRegistered(channel: string): void {
  registered.add(channel)
}

/** 已注册通道集合（供契约完整性测试比对 src/shared/ipc.ts） */
export function listRegisteredChannels(): string[] {
  return [...registered].sort()
}

export function hasChannel(channel: string): boolean {
  return registered.has(channel)
}

/**
 * 直接调用已注册的处理器（不经过 Electron）。
 * 用途：测试、启动自检，以及「主进程内部把 IPC 通道当服务调用」。
 */
export async function invokeRegistered(channel: string, payload?: unknown): Promise<IpcResult<unknown>> {
  const wrapper = wrappers.get(channel)
  if (!wrapper) {
    throw new AppError('NOT_IMPLEMENTED', {
      params: { feature: `ipc:${channel}` },
      details: { channel, reason: 'channel-not-registered' },
    })
  }
  return wrapper(fakeEvent(), payload)
}

function fakeEvent(): IpcMainInvokeEventLike {
  return {
    sender: { id: 0, send: () => undefined, isDestroyed: () => false, on: () => undefined },
  }
}

// ---------------------------------------------------------------------------
// 契约完整性自检（docs/20 §10「契约完整性」）
// ---------------------------------------------------------------------------

export interface ContractParityResult {
  /** 契约里的通道总数 */
  expected: number
  /** 实际注册的通道总数 */
  actual: number
  /** 契约里有、但没注册（漏注册） */
  missing: string[]
  /** 注册了、但契约里没有（裸字符串通道名，违反契约单一来源） */
  extra: string[]
}

/**
 * 比对 `IPC_CHANNELS` 与实际注册的通道集合。
 *
 * 缺失与多余**都抛错**：
 *   · 缺失 = 渲染进程会调用到一个不存在的通道（用户点了没反应）
 *   · 多余 = 有人写了裸字符串通道名（契约漂移：改一侧另一侧不会失败）
 * 启动时跑一次的成本极低，收益是「契约漂移在启动时就炸，而不是上线后」。
 *
 * @param opts.registered 覆盖实际注册集合（测试用）
 * @throws AppError('INTERNAL') 当 missing/extra 非空
 */
export function assertContractParity(opts?: { registered?: readonly string[] }): ContractParityResult {
  const actualList = opts?.registered ?? listRegisteredChannels()
  const expectedSet = new Set<string>(IPC_CHANNELS)
  const actualSet = new Set<string>(actualList)
  const missing = [...expectedSet].filter((c) => !actualSet.has(c)).sort()
  const extra = [...actualSet].filter((c) => !expectedSet.has(c)).sort()
  const result: ContractParityResult = {
    expected: expectedSet.size,
    actual: actualSet.size,
    missing,
    extra,
  }
  if (missing.length > 0 || extra.length > 0) {
    throw new AppError('INTERNAL', {
      details: {
        kind: 'IPC_CONTRACT_PARITY',
        expected: result.expected,
        actual: result.actual,
        missing,
        extra,
        hint: '契约单一来源是 src/shared/ipc.ts；漏注册请在 ipc/index.ts 补齐，多余请删掉裸字符串通道名',
      },
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function logFailure(event: string, appErr: AppError, ctx: IpcContext): void {
  // IpcContext 是接口（无索引签名），转成 Record 才能作为日志上下文字段
  const fields = toLogFields(appErr, event, { ...ctx })
  if (appErr.severity === 'error' || appErr.severity === 'fatal') {
    deps?.log.error(event, { ...fields })
  } else {
    deps?.log.info(event, { ...fields })
  }
}

// ---------------------------------------------------------------------------
// 任务侧的统一包裹（队列 runner 复用）
// ---------------------------------------------------------------------------

/**
 * 包裹任务体：任何异常都转成 AppError，并附加任务上下文。
 * 单个任务失败绝不能中断整批（批量处理场景见 docs/14 §7）。
 */
export async function runGuarded<T>(
  fn: () => Promise<T>,
  meta: { kind: string; taskId: string; fallbackKey?: MessageKey },
): Promise<{ ok: true; data: T } | { ok: false; error: AppError }> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    const appErr = wrapUnknown(e, meta.fallbackKey ?? 'TASK_FAILED')
    const fields = toLogFields(appErr, `task.${meta.kind}.failed`, {
      taskId: meta.taskId,
      taskKind: meta.kind,
    })
    deps?.log.error(`task.${meta.kind}.failed`, { ...fields })
    return { ok: false, error: appErr }
  }
}

export { isAppError }

// ---------------------------------------------------------------------------
// 测试/自检用的内存 ipcMain
// ---------------------------------------------------------------------------

/**
 * 内存版 ipcMain：记录 `handle` 的通道与处理器，支持 `invoke` 直接调用。
 * 用于「不启动 Electron 也能验证 handler 行为」的测试与启动自检。
 */
export function createInMemoryIpcMain(): IpcMainLike & {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  channels(): string[]
} {
  const handlers = new Map<string, (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown>()
  const sendHandlers = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>()
  return {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    on(channel, listener) {
      const list = sendHandlers.get(channel) ?? []
      list.push(listener)
      sendHandlers.set(channel, list)
    },
    removeAllListeners(channel) {
      if (channel) sendHandlers.delete(channel)
      else sendHandlers.clear()
    },
    async invoke(channel, payload) {
      const h = handlers.get(channel)
      if (!h) throw new Error(`[ipc] 未注册通道：${channel}`)
      return h(fakeEvent(), payload)
    },
    channels() {
      return [...handlers.keys()].sort()
    },
  }
}
