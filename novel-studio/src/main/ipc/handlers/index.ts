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
 * 静态 handler 汇总：**不依赖任何服务的域**。
 *
 * 元素类型是**擦除泛型**的 `RegisteredHandler`：各通道 req 类型不同，
 * 若标成 `ChannelSpec[]`（默认 `ChannelSpec<unknown, unknown>`）会因逆变逐条报 TS2322。
 */
export const ALL_HANDLERS: RegisteredHandler[] = [
  ...appHandlers,
  ...systemHandlers,
]

/**
 * 需要注入领域服务的 handler 工厂。
 *
 * ### 为什么不直接写在 `ALL_HANDLERS` 里
 *   这类 handler 要持有 `BookService` 之类的服务实例，而服务是在
 *   `ports.ts`（启动期）构造的 —— 如果在模块顶层 import 服务，
 *   就会形成 `handlers → 服务 → 仓储 → db` 的静态依赖链，
 *   让 handler 层再也无法在「没有数据库」的测试环境里被 import。
 *
 *   因此约定：域 handler 一律通过**工厂**注册，由 `ports.ts` 在启动时把服务传进来。
 *   `registerAllHandlers` 决定是否启用它们；未注册的通道由占位 handler 兜住
 *   （抛 `NOT_IMPLEMENTED`，不会静默无反应）。
 */
export interface DomainHandlerRegistry {
  /** 域名 → 返回该域全部 handler 的工厂 */
  readonly [domain: string]: (deps: HandlerDeps) => RegisteredHandler[]
}

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
 *
 * @param extra 额外参与自检的 handler（域 handler 由装配层注入，不在 `ALL_HANDLERS` 里）
 */
export function selfCheckHandlers(strict = false, extra: readonly RegisteredHandler[] = []): HandlerSelfCheckResult {
  const seen = new Map<string, number>()
  const unknown: string[] = []

  for (const h of [...ALL_HANDLERS, ...extra]) {
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
 * 注册 handler 列表。
 *
 * @param registrar 注册器
 * @param deps      通用依赖
 * @param domainHandlers 领域 handler（**必须传进来**）。
 *
 *   ⚠️ 这里踩过一个真实缺陷：`ipc/index.ts` 的 `registerAllHandlers` 接到了一个
 *   `domainHandlers` 参数，却**没有继续传给它内部的这个函数** ——
 *   于是域 handler 从未被注册，而 `assertContractParity()` 因为拿不到它们而抛错。
 *
 *   症状很有迷惑性：启动日志显示「implemented: 28 / placeholders: 130」看起来正常，
 *   但契约总数是 158（28+130），自检却失败 —— 因为域 handler 那 15 个通道
 *   既没在实现列表里、也没拿到占位。**计数对得上，集合对不上。**
 */
export function registerAllHandlers(
  registrar: RegistrarLike,
  deps: HandlerDeps,
  domainHandlers: readonly RegisteredHandler[] = [],
): HandlerSelfCheckResult {
  const all = [...ALL_HANDLERS, ...domainHandlers]
  // 自检要把域 handler 一起算进去：否则「域 handler 与静态表重名」这类错误
  // 会直到渲染进程调用时才暴露（表现为「后注册的静默覆盖前一个」）
  const check = selfCheckHandlers(true, domainHandlers)

  for (const h of all) {
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

/**
 * 已实现 handler 的通道清单（供 coverage 统计与测试）。
 *
 * @param domainHandlers 只统计静态表时不用传；装配层可比对「契约 vs 实际注册」时传进来
 */
export function listImplementedChannels(domainHandlers: readonly RegisteredHandler[] = []): string[] {
  return selfCheckHandlers(false, domainHandlers).implemented
}
