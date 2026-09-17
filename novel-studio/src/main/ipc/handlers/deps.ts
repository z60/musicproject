/**
 * IPC handler 层 · 依赖契约
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §4（通道清单）、§8（preload 暴露面）
 *
 * 本文件只定义「handler 需要什么」，不关心「这些服务怎么建出来」。
 * 具体装配在 src/main/bootstrap 完成（注册顺序见 docs/01 §10）。
 *
 * 为什么用依赖注入而不是直接 import 具体实现：
 *   1. handler 层可以在没有 Electron / SQLite 的环境下被单测（本仓库的开发机无外网）
 *   2. 避免 handler 与 infra 之间产生循环依赖
 *   3. 让「哪些能力被用到了」变成显式清单，便于审计
 *
 * ⚠️ 已知契约不一致（待修）：
 *   src/main/ipc/registry.ts 的 `handle()` 签名第二个参数是 `ZodType<TReq>`（zod 类型），
 *   但本仓库实际实现的是自研校验器 `src/main/infra/validate`（导出 `Schema<T>`）。
 *   离线环境装不上 zod，因此该签名会编译失败。本层不依赖它，而是用下面的
 *   `ChannelSpec` 形式（`schema` 形态兼容两者的 `parse()`），
 *   真正的统一应在 bootstrap 里做一次适配，或把 registry 的签名改为 `Schema<TReq>`。
 */

import type { AppCapabilities, AppPaths, AppSettings, TaskRecord, TaskStatus, TaskKind } from '../../../shared/types.ts'
import type {
  IpcChannel,
  IpcEventName,
  IpcEventPayload,
  IpcReq,
  IpcSendName,
  IpcSendPayload,
} from '../../../shared/ipc.ts'
import type { Logger } from '../../infra/log/logger.ts'

// ---------------------------------------------------------------------------
// 最小 schema 形态（兼容自研校验器的 Schema<T>）
// ---------------------------------------------------------------------------

/**
 * 只要求有 `parse` 方法 —— 自研 `Schema<T>` 与 zod 的 `ZodType<T>` 都满足它。
 * handler 层因此不绑定任何具体校验库。
 *
 * `value` 参数声明为 `unknown`（而不是 `T`）：校验器天然是**逆变**的 ——
 * 它接受任意不可信输入并产出 `T`。写成 `parse(value: T)` 会让
 * `SchemaLike<IpcReq<C>>` 无法赋给 `SchemaLike<unknown>`（`unknown` 不可赋给具体载荷类型），
 * handler 汇总表就会一片 TS2322。声明成 `unknown` 既符合真实语义，也让泛型正常逆变匹配。
 */
export interface SchemaLike<T> {
  parse(value: unknown): T
}

/** 无载荷通道用的透传 schema（void 通道） */
export const voidSchema: SchemaLike<void> = {
  parse(): void {
    return undefined
  },
}

/** 原样透传（用于尚未写 schema 的通道，作为过渡） */
export function passthroughSchema<T>(): SchemaLike<T> {
  return { parse: (v: unknown) => v as T }
}

// ---------------------------------------------------------------------------
// 服务依赖
// ---------------------------------------------------------------------------

/** 应用信息与路径（由 bootstrap 提供，因为只有主进程知道这些） */
export interface AppEnvPort {
  getInfo(): {
    version: string
    electron: string
    node: string
    chrome: string
    platform: string
    arch: string
    isPackaged: boolean
    portable: boolean
  }
  getPaths(): AppPaths
  /** 打开外部链接（仅 http/https，见 docs/02 §3） */
  openExternal(url: string): Promise<void>
  /** 在系统文件管理器中定位文件 */
  showItemInFolder(path: string): void
  /** 目录选择对话框 */
  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>
  /** 文件选择对话框 */
  pickFiles(opts: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    multi?: boolean
  }): Promise<string[]>
  /** 保存文件对话框 */
  pickSavePath(opts: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<string | null>
  /** 退出应用（force=true 时不做未完成操作的拦截） */
  quit(force: boolean): void
}

/** 能力探测（ffmpeg / 模型 / 安全存储 / embedding，见 docs/02 §5.1、docs/21 §16） */
export interface CapabilityPort {
  getCapabilities(): Promise<AppCapabilities>
  /** 重新探测（用户改了 ffmpeg 路径或放了模型之后） */
  refresh(): Promise<AppCapabilities>
}

/** 设置读写（docs/04 §8） */
export interface SettingsPort {
  /** 读取全部设置（敏感字段已掩码） */
  getAll(): AppSettings
  /** 按 key 前缀读取（'audio' / 'audio.sampleRate'） */
  get(keys?: string[]): AppSettings
  /** 写入补丁，返回变化的 key 列表（点分路径） */
  set(patch: Record<string, unknown>): { changedKeys: string[] }
  /** 写入加密密钥（值经 safeStorage 加密，见 docs/04 §9） */
  setSecret(key: string, value: string): void
  /** 重置为默认值 */
  reset(keys?: string[]): void
}

/**
 * 任务队列（docs/04 §2）。
 *
 * ⚠️ 全部方法允许返回 Promise：队列的持久化端口是异步的（`TaskStore.save/update` 可能是
 * sqlite 同步实现，也可能是远程/文件实现），**handler 侧必须 await**。
 * 早期版本把这里写成同步签名，会导致 `{ cleared: Promise }` 这种「响应体里出现 Promise」
 * 的严重 bug（JSON 序列化后变成 `{}`，UI 看到 undefined）。因此签名统一放宽为联合类型。
 */
export interface TaskPort {
  list(filter: { status?: TaskStatus[]; kind?: TaskKind[]; limit?: number }): TaskRecord[] | Promise<TaskRecord[]>
  get(taskId: string): TaskRecord | null | Promise<TaskRecord | null>
  cancel(taskId: string): boolean | Promise<boolean>
  retry(taskId: string): { taskId: string } | null | Promise<{ taskId: string } | null>
  clearFinished(): number | Promise<number>
  result(taskId: string): unknown | Promise<unknown>
}

/** 数据库维护（docs/04 §1、docs/21 §15） */
export interface DbPort {
  backup(): Promise<{ path: string }>
  listBackups(): Array<{
    id: string
    filePath: string
    sizeBytes: number
    schemaVersion: number
    reason: string
    createdAt: number
  }>
  restore(path: string): Promise<void>
  integrityCheck(): { ok: boolean; errors: string[] }
  stats(): { sizeBytes: number; schemaVersion: number; tables: Array<{ name: string; rows: number }> }
}

/** 诊断包导出（docs/04 §5.4） */
export interface DiagnosticsPort {
  export(): Promise<{ reportPath: string }>
}

/** AI Provider 连通性测试（docs/06 §3.1 healthCheck） */
export interface ProviderPort {
  test(config: AppSettings['ai'] & { apiKey?: string }): Promise<{ ok: boolean; message: string; latencyMs?: number }>
}

// ---------------------------------------------------------------------------
// 事件与日志
// ---------------------------------------------------------------------------

/** 主 → 渲染 的事件推送 */
export interface EventPort {
  emit<E extends IpcEventName>(event: E, payload: IpcEventPayload<E>): void
}

/** 渲染 → 主 的单向通道订阅（handler 层只用它做登记，实际转接在 bootstrap） */
export interface SendPort {
  on<S extends IpcSendName>(channel: S, handler: (payload: IpcSendPayload<S>) => void): void
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface HandlerDeps {
  log: Logger
  env: AppEnvPort
  capabilities: CapabilityPort
  settings: SettingsPort
  tasks: TaskPort
  db: DbPort
  diagnostics: DiagnosticsPort
  provider: ProviderPort
  events: EventPort
  /** 可选：只有需要接收渲染进程单向消息的域才用得到 */
  sends?: SendPort
}

// ---------------------------------------------------------------------------
// handler 描述（用于自检与文档生成）
// ---------------------------------------------------------------------------

/**
 * 每个 handler 的登记项。
 *
 * `channel` 必须是 IpcContract 的键 —— 这样新增通道时若忘了实现，
 * 类型层与 `scripts/check-coverage.ts` 都会报出来。
 */
export interface ChannelSpec<TReq = unknown, TRes = unknown> {
  channel: IpcChannel
  /** 载荷校验（无载荷通道用 voidSchema） */
  schema: SchemaLike<TReq>
  /** 业务实现 */
  run: (req: TReq, deps: HandlerDeps) => Promise<TRes> | TRes
  /**
   * 错误兜底语义键（docs/22 §5 第二级）。
   * 指定更精确的码，可以让未预期异常也给出比「发生了未预期的错误」更有用的提示。
   */
  fallbackKey?: string
}

/**
 * 构造 handler 时用的窄化工厂。
 *
 * **为什么需要它**：`ChannelSpec` 的默认泛型是 `unknown`，直接写对象字面量会让
 * `run` 的参数退化成 `unknown`，于是每个字段访问都报 `TS18046: 'req' is of type 'unknown'`
 * （在 handler 层一次报了 45 处）。用本工厂可以让编译器**从契约**推断出 req/res 的确切类型。
 *
 * 两种使用形式：
 *   h('app:getInfo', () => deps.env.getInfo())                  // 由返回值推断 TRes
 *   h('app:getInfo', voidSchema, () => deps.env.getInfo())      // 显式给 schema（无载荷通道）
 *   h('settings:set', schema, (req, deps) => ...)               // req 自动是 { patch: ... }
 *
 * 返回值是**擦除泛型**的 `RegisteredHandler`（而不是 `ChannelSpec<IpcReq<C>, TRes>`）：
 * 汇总表 `ALL_HANDLERS` 要同时装下所有通道的 handler，而各通道的 req 类型互不相同；
 * 直接标注 `ChannelSpec[]` 会因 `schema` 的逆变而逐条报 TS2322。
 * 擦除只影响汇总表的静态类型，**类型安全没有损失** —— 每个 handler 的内部
 * （`req` 的字段访问）仍然由调用点按契约推断并全程检查。
 */
export interface RegisteredHandler {
  channel: IpcChannel
  /** 载荷校验：接受任意不可信输入 */
  schema: SchemaLike<unknown>
  /** 业务实现：入参已由 schema 校验，静态上按契约类型使用 */
  run: (req: never, deps: HandlerDeps) => Promise<unknown> | unknown
  fallbackKey?: string
}

export function h<C extends IpcChannel, TRes>(
  channel: C,
  schemaOrRun:
    | SchemaLike<IpcReq<C>>
    | ((req: IpcReq<C>, deps: HandlerDeps) => Promise<TRes> | TRes),
  runOrOptions?:
    | ((req: IpcReq<C>, deps: HandlerDeps) => Promise<TRes> | TRes)
    | { fallbackKey?: string },
  maybeOptions?: { fallbackKey?: string },
): RegisteredHandler {
  const isSchema = typeof schemaOrRun === 'object' && schemaOrRun !== null
  const schema = isSchema
    ? (schemaOrRun as SchemaLike<IpcReq<C>>)
    : passthroughSchema<IpcReq<C>>()
  const run = (isSchema
    ? runOrOptions
    : schemaOrRun) as (req: IpcReq<C>, deps: HandlerDeps) => Promise<TRes> | TRes
  const options = (isSchema ? maybeOptions : runOrOptions) as { fallbackKey?: string } | undefined

  return {
    channel,
    schema: schema as SchemaLike<unknown>,
    run: run as unknown as RegisteredHandler['run'],
    ...(options?.fallbackKey !== undefined ? { fallbackKey: options.fallbackKey } : {}),
  }
}
