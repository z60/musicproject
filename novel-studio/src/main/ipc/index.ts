/**
 * 主进程 · IPC 层总入口
 * ============================================================================
 * 设计依据：docs/01 §10「启动顺序第 10 步：注册 IPC handlers（幂等）」、
 *           docs/20 §4（通道清单）、§10（测试要点）
 *
 * ### 分层
 * ```
 * ipc/
 * ├── registry.ts      传输层骨架：handle() 包裹（校验 + 兜底 + 日志）、契约自检、内存 ipcMain
 * ├── schemas.ts       全部 158 个通道的 req schema（契约的运行期镜像）
 * ├── events.ts        主 → 渲染的事件推送（含「不丢终态」的待补发队列）
 * ├── handlers/
 * │   ├── deps.ts      handler 依赖端口（AppEnvPort / SettingsPort / TaskPort / DbPort ...）
 * │   ├── app.ts       app:*（10）
 * │   ├── system.ts    settings/task/db/log/ffmpeg（18）
 * │   ├── placeholders.ts  其余通道的显式未实现占位（抛 NOT_IMPLEMENTED，绝不返回空数据）
 * │   └── index.ts     ALL_HANDLERS 汇总与自检
 * └── index.ts       ← 本文件：把上面几块装到一起，并做契约完整性自检
 * ```
 *
 * ### 两条不可动摇的规则
 *   1. **每个通道都必须有 schema**：运行时校验是「渲染进程被注入后也调不出越界参数」的
 *      唯一保证（docs/20 §1.2）。本文件里的 `resolveSchema()` 优先使用契约 schema，
 *      只有契约里没有的通道才退回 handler 自带的宽松 schema。
 *   2. **每个通道都必须注册**：`registerAllHandlers()` 默认给未实现的通道注册
 *      `NOT_IMPLEMENTED` 占位，然后跑 `assertContractParity()`。
 *      漏注册（用户点了没反应）与多注册（契约漂移）都会在启动时直接抛错。
 */

import { AppError } from '../../shared/errors.ts'
import { IPC_CHANNELS } from '../../shared/ipc.ts'
import type { IpcMainLike } from '../infra/electron/types.ts'
import type { Logger } from '../infra/log/index.ts'
import { ALL_HANDLERS, registerAllHandlers as registerSpecList, selfCheckHandlers } from './handlers/index.ts'
import type { HandlerDeps, RegisteredHandler, SchemaLike } from './handlers/deps.ts'
import { createPlaceholderHandlers } from './handlers/placeholders.ts'
import { IPC_REQ_SCHEMAS } from './schemas.ts'
import {
  assertContractParity,
  handle,
  hasChannel,
  initIpcRegistry,
  listRegisteredChannels,
  type ContractParityResult,
  type HandleOptions,
  type IpcRegistryDeps,
} from './registry.ts'

export * from './registry.ts'
export * from './events.ts'
export { ALL_HANDLERS, selfCheckHandlers } from './handlers/index.ts'
export type { ChannelSpec, HandlerDeps, RegisteredHandler, SchemaLike } from './handlers/deps.ts'
export { IPC_REQ_SCHEMAS, schemaChannels, schemaFor } from './schemas.ts'

// ---------------------------------------------------------------------------
// RegistrarLike 适配器：把 ChannelSpec 层接到 registry.handle 上
// ---------------------------------------------------------------------------

/**
 * `handlers/index.ts` 定义的注册器接口。
 * 之所以要在中间加一层适配（而不是让 handler 直接 import registry），是为了让
 * handler 层完全不依赖电子环境（可单测），并且注册顺序/重名检查集中在一处。
 */
export interface RegistrarLike {
  register<TReq, TRes>(
    channel: string,
    schema: SchemaLike<TReq>,
    run: (req: TReq, deps: HandlerDeps) => Promise<TRes> | TRes,
    options: { fallbackKey?: string },
  ): void
}

export interface CreateRegistrarOptions {
  /** 校验器来源（默认契约 schema，缺失时回退到 spec 自带的） */
  useContractSchemas?: boolean
  /** 传给 registry.handle 的选项（如 overwrite） */
  handleOptions?: HandleOptions
}

/**
 * 创建「走 registry.handle」的注册器。
 *
 * 关键点：**schema 优先取 `IPC_REQ_SCHEMAS`**。
 * 领域 handler 早期常用 `passthroughSchema()` 过渡（不校验），
 * 一旦契约 schema 就绪就必须以契约为准 —— 否则「同一通道两套校验」会让
 * handler 收到的 req 形状取决于注册顺序，这是很难查的 bug。
 */
export function createRegistryRegistrar(opts?: CreateRegistrarOptions): RegistrarLike {
  const useContract = opts?.useContractSchemas ?? true
  return {
    register(channel, schema, run, options) {
      const contractSchema = useContract
        ? (IPC_REQ_SCHEMAS as Record<string, SchemaLike<unknown>>)[channel]
        : undefined
      const effective = contractSchema ?? schema
      handle(
        channel,
        effective as never,
        // registry 的 fn 签名是 (req, event, ctx)；ChannelSpec.run 只关心 (req, deps)
        ((req: unknown) => run(req as never, currentDeps as HandlerDeps)) as never,
        {
          ...(options.fallbackKey !== undefined ? { fallbackKey: options.fallbackKey as never } : {}),
          ...(opts?.handleOptions ?? {}),
        },
      )
    },
  }
}

/** 当前注入的依赖（由 registerAllHandlers 设置；适配器闭包读取它） */
let currentDeps: HandlerDeps | null = null

// ---------------------------------------------------------------------------
// 汇总注册
// ---------------------------------------------------------------------------

export interface RegisterAllOptions {
  /** 注入 ipcMain（不传则只登记不注册，便于测试） */
  ipcMain?: IpcMainLike
  /** 是否用契约 schema 覆盖 handler 自带的宽松 schema（默认 true） */
  useContractSchemas?: boolean
  /** 是否为未实现的通道注册 NOT_IMPLEMENTED 占位（默认 true） */
  placeholderForMissing?: boolean
  /** 是否在注册后做契约完整性自检（默认 true；测试里可关掉以单独断言） */
  assertParity?: boolean
  /**
   * **领域 handler**（持有服务实例，由装配层用 `createBookHandlers(bookService)` 之类构造）。
   *
   * 为什么不写进 `ALL_HANDLERS`：域 handler 需要真实服务，而服务是在启动期装配的。
   * 放进静态表会让 `handlers/index.ts` 静态依赖「服务 → 仓储 → db」，
   * 那样 handler 层再也无法在无数据库的测试环境里被 import。
   */
  domainHandlers?: readonly RegisteredHandler[]
  /** 额外注册（如 future 的域）在占位之前执行 */
  extra?: readonly RegisteredHandler[]
  /** registry 依赖（日志、wasNotified） */
  registry?: Partial<Omit<IpcRegistryDeps, 'ipcMain'>>
}

export interface RegisterAllResult {
  /** 真实实现的通道数（不含占位） */
  implemented: number
  /** 占位通道数 */
  placeholders: number
  /** 注册总数（应等于契约总数） */
  registered: number
  /** 契约自检结果 */
  parity: ContractParityResult
  /** 占位通道清单（供启动日志与「功能未实现」统计） */
  placeholderChannels: string[]
}

/**
 * 注册全部 IPC handler（启动顺序第 10 步，docs/01 §10）。
 *
 * 幂等：重复调用时默认抛「通道重复注册」——这是**有意为之**：
 * 启动顺序里这一步只应执行一次，重复执行说明装配代码有问题，早失败早发现。
 * 若确实需要重跑（如开发期热重载），传 `registry.handleOptions.overwrite = true`。
 *
 * @returns 注册统计（含占位清单，启动日志里会打出来，避免「以为都实现了」）
 */
export function registerAllHandlers(deps: HandlerDeps, opts?: RegisterAllOptions): RegisterAllResult {
  currentDeps = deps

  const log: Logger = deps.log
  const registryDeps: IpcRegistryDeps = {
    ...(opts?.ipcMain ? { ipcMain: opts.ipcMain } : {}),
    log: {
      error: (event, fields) => log.error(event, fields),
      info: (event, fields) => log.info(event, fields),
    },
    ...(opts?.registry ?? {}),
  }
  initIpcRegistry(registryDeps)

  // ── 1) 真实实现的 handler ────────────────────────────────────────────────
  // 三部分来源：静态表（app/system）、装配层注入的域 handler、调用方额外追加的
  const domainSpecs: readonly RegisteredHandler[] = opts?.domainHandlers ?? []
  const realSpecs: RegisteredHandler[] = [...ALL_HANDLERS, ...domainSpecs, ...(opts?.extra ?? [])]
  const implementedChannels = realSpecs.map((h) => h.channel)

  // 重复登记 / 契约外的通道在这里就炸（handlers/index.ts 的自检）
  // 注意要把域 handler 一起传进去：否则「域 handler 撞名」不会被发现
  const selfCheck = selfCheckHandlers(true, [...domainSpecs, ...(opts?.extra ?? [])])
  if (selfCheck.unknown.length > 0 || selfCheck.duplicates.length > 0) {
    throw new AppError('INTERNAL', {
      details: {
        kind: 'IPC_HANDLER_SELFCHECK',
        unknown: selfCheck.unknown,
        duplicates: selfCheck.duplicates,
      },
    })
  }

  const registrar = createRegistryRegistrar({ useContractSchemas: opts?.useContractSchemas ?? true })
  // ⚠️ 必须把**域 handler 与 extra 一起**传进去。
  //    曾经漏传 domainHandlers：它们没被注册，而下面的
  //    `assertContractParity()` 因为拿不到这些通道直接抛错 ——
  //    症状是「implemented 28 / placeholders 130 / 合计 158，计数对得上但自检失败」。
  registerSpecList(registrar, deps, [...domainSpecs, ...(opts?.extra ?? [])])

  // ── 2) 未实现通道的显式占位 ──────────────────────────────────────────────
  // 判据用「契约 − 已实现」，而 implementedChannels 已经包含域 handler，
  // 因此这些通道不会被重复注册占位（重复会撞 registry 的「通道重复注册」检查）
  const placeholderForMissing = opts?.placeholderForMissing ?? true
  let placeholderChannels: string[] = []
  if (placeholderForMissing) {
    const placeholders = createPlaceholderHandlers(implementedChannels).filter((h) => !hasChannel(h.channel))
    for (const spec of placeholders) {
      registrar.register(spec.channel, spec.schema, spec.run as never, {
        ...(spec.fallbackKey !== undefined ? { fallbackKey: spec.fallbackKey } : {}),
      })
      placeholderChannels.push(spec.channel)
    }
  }

  // ── 3) 契约完整性自检 ────────────────────────────────────────────────────
  const parity = assertParityIsOn(opts)
    ? assertContractParity()
    : {
        expected: IPC_CHANNELS.length,
        actual: listRegisteredChannels().length,
        missing: IPC_CHANNELS.filter((c) => !hasChannel(c)),
        extra: [],
      }

  log.info('ipc.register.done', {
    event: 'ipc.register.done',
    implemented: implementedChannels.length,
    placeholders: placeholderChannels.length,
    registered: parity.actual,
    contractTotal: parity.expected,
  })

  // 占位较多时给一条 warn：避免「启动日志一切正常」造成「功能都做完了」的错觉
  if (placeholderChannels.length > 0) {
    log.warn('ipc.register.placeholders', {
      event: 'ipc.register.placeholders',
      count: placeholderChannels.length,
      contractTotal: parity.expected,
      first: placeholderChannels.slice(0, 10),
    })
  }

  return {
    implemented: implementedChannels.length,
    placeholders: placeholderChannels.length,
    registered: parity.actual,
    parity,
    placeholderChannels,
  }
}

function assertParityIsOn(opts?: RegisterAllOptions): boolean {
  return opts?.assertParity ?? true
}
