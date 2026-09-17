/**
 * IPC handler 注册总入口
 * ============================================================================
 * 设计依据：docs/01-系统架构.md §10（启动顺序第 10 步）、docs/20-IPC契约.md §4
 *
 * 设计要点：
 *   1. **不直接 import Electron 的 ipcMain** —— 而是接受一个 `RegistrarLike`。
 *      这样本模块可以在没有 Electron 的环境里被单测（本仓库开发机无外网）。
 *      bootstrap 侧传入真实实现即可。
 *   2. 注册前先做**契约自检**：所有登记的通道必须存在于 `IPC_CHANNELS`，
 *      且不能重复。漏注册/多注册都会在启动时立刻炸出来，而不是等到渲染进程调用。
 *   3. 提供 `listImplementedChannels()`，供 `check:coverage` 与测试统计覆盖度。
 */

import { IPC_CHANNELS } from '../../../shared/ipc.ts'
import type { HandlerDeps, RegisteredHandler, SchemaLike } from './deps.ts'
import { appHandlers } from './app.ts'
import { systemHandlers } from './system.ts'

// ---------------------------------------------------------------------------
// 可注入的注册器（生产实现是 src/main/ipc/registry.ts 的 handle）
// ---------------------------------------------------------------------------

export interface RegistrarLike {
  register<TReq, TRes>(
    channel: string,
    schema: SchemaLike<TReq>,
    run: (req: TReq, deps: HandlerDeps) => Promise<TRes> | TRes,
    options: { fallbackKey?: string },
  ): void
}

/**
 * 目前所有域的 handler 汇总。后续每新增一个域，在这里追加。
 *
 * 元素类型是**擦除泛型**的 `RegisteredHandler`：各通道 req 类型不同，
 * 若标成 `ChannelSpec[]`（默认 `ChannelSpec<unknown, unknown>`）会因逆变逐条报 TS2322。
 */
export const ALL_HANDLERS: RegisteredHandler[] = [
  ...appHandlers,
  ...systemHandlers,
]

// 供测试与上层装配使用的类型再导出（`import type { HandlerDeps } from '.../handlers/index.ts'`）
export type { ChannelSpec, HandlerDeps, RegisteredHandler, SchemaLike } from './deps.ts'

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export interface HandlerSelfCheckResult {
  total: number
  implemented: string[]
  duplicates: string[]
  unknown: string[]
  /** 契约里有、但尚未实现 handler 的通道 */
  missing: string[]
}

/**
 * 契约自检。不抛错，返回结构化结果 —— 便于启动时记录日志、测试里断言。
 * 若 `strict` 为真且有问题，则抛错（供 CI / 启动门禁用）。
 */
export function selfCheckHandlers(strict = false): HandlerSelfCheckResult {
  const seen = new Map<string, number>()
  const unknown: string[] = []

  for (const h of ALL_HANDLERS) {
    seen.set(h.channel, (seen.get(h.channel) ?? 0) + 1)
    if (!IPC_CHANNELS.includes(h.channel)) unknown.push(h.channel)
  }

  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c)
  const implemented = [...seen.keys()].sort()
  const missing = IPC_CHANNELS.filter(c => !seen.has(c)).sort()

  if (strict) {
    const problems: string[] = []
    if (unknown.length > 0) problems.push(`登记了契约中不存在的通道：${unknown.join(', ')}`)
    if (duplicates.length > 0) problems.push(`重复登记的通道：${duplicates.join(', ')}`)
    if (problems.length > 0) {
      throw new Error(`[ipc] handler 自检未通过：\n  ${problems.join('\n  ')}`)
    }
  }

  return {
    total: IPC_CHANNELS.length,
    implemented,
    duplicates,
    unknown,
    missing,
  }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册全部已实现的 handler。
 *
 * @param registrar 生产传 registry.handle 的适配器；测试传假实现
 * @param deps      各域需要的服务（见 deps.ts）
 * @returns 注册结果统计（便于启动日志）
 */
export function registerAllHandlers(registrar: RegistrarLike, deps: HandlerDeps): HandlerSelfCheckResult {
  const check = selfCheckHandlers(true)

  for (const h of ALL_HANDLERS) {
    registrar.register(
      h.channel,
      h.schema,
      (req) => h.run(req as never, deps),
      h.fallbackKey !== undefined ? { fallbackKey: h.fallbackKey } : {},
    )
  }

  deps.log.info('ipc.handlers.registered', {
    implemented: check.implemented.length,
    contractTotal: check.total,
    missing: check.missing.length,
  })

  // 未实现的通道数量较多时给一条 warn，避免「以为都通了」
  if (check.missing.length > 0) {
    deps.log.warn('ipc.handlers.incomplete', {
      missing: check.missing.length,
      total: check.total,
      firstMissing: check.missing.slice(0, 10),
    })
  }

  return check
}

/** 已实现 handler 的通道清单（供 coverage 统计与测试） */
export function listImplementedChannels(): string[] {
  return selfCheckHandlers().implemented
}
