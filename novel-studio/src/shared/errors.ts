/**
 * Novel Studio · 业务异常与错误兜底
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md
 *
 * 对外只暴露一个异常类型：AppError（别名 BusinessError）。
 * 职责：
 *   1. 用语义键构造业务异常（文案从 messages.ts 取，不在这里硬编码）
 *   2. 把任意原始错误（Node errno / 字符串 / AbortError）包裹成 AppError
 *   3. 序列化过 IPC（保留 code / severity / action / retryable / params）
 *   4. 在渲染侧「兑现」成可直接渲染的消息
 *
 * 铁律：
 *   · 错误处理路径本身永不抛错（未知键 → 兜底 INTERNAL）
 *   · 取消不是错误（AbortError → TASK_CANCELLED，UI 不弹提示）
 *   · 不重复包裹（已是 AppError 直接返回，否则用户会看到"发生了未知错误"）
 *   · 原始错误不丢弃（放 cause / causeChain，只进日志，永不进 UI）
 */

import {
  getMessage,
  resolveCode,
  type ErrorAction,
  type MessageKey,
  type MessageParams,
  type ResolvedMessage,
  type Severity,
} from './messages.ts'

// ============================================================================
// 类型
// ============================================================================

/** 过 IPC 的错误结构（纯数据，可 JSON 序列化） */
export interface SerializedAppError {
  code: string                        // 语义键
  numericCode: string                 // 派生编号，如 'E200005'
  message: string                     // = 已插值的 title，便于日志 grep
  severity: Severity
  action: ErrorAction
  retryable: boolean
  params: MessageParams
  details?: Record<string, unknown>   // 结构化上下文（进日志，不进 UI）
  causeChain?: string[]               // 原始错误摘要链（进日志，不进 UI）
  stack?: string                      // 仅开发模式/error 以上级别
}

/** IPC 统一响应形状：主进程永远不 throw 出 handler */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedAppError }

// ============================================================================
// 系统错误 → 业务码 映射
// ============================================================================

/**
 * 不做这层映射，90% 的兜底都会退化成「发生了未知错误」，用户毫无头绪。
 * 新增系统错误时只改这张表，不改业务代码。
 *
 * 导出供 scripts/gen-error-docs.ts 生成映射表文档（单一来源，避免两处维护）。
 */
export const SYSTEM_ERRNO_MAP: Readonly<Record<string, MessageKey>> = {
  // 文件系统
  ENOENT: 'FILE_NOT_FOUND',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
  EROFS: 'PERMISSION_DENIED',
  ENOSPC: 'DISK_FULL',
  EBUSY: 'FILE_BUSY',
  EDQUOT: 'DISK_FULL',
  EMFILE: 'INTERNAL',
  ENFILE: 'INTERNAL',
  EISDIR: 'INTERNAL',
  ENOTDIR: 'FILE_NOT_FOUND',
  ENAMETOOLONG: 'INTERNAL',
  ENOTEMPTY: 'FILE_BUSY',
  // SQLite
  SQLITE_BUSY: 'DB_BUSY',
  SQLITE_LOCKED: 'DB_BUSY',
  SQLITE_CORRUPT: 'DB_CORRUPT',
  SQLITE_NOTADB: 'DB_CORRUPT',
  SQLITE_FULL: 'DISK_FULL',
  SQLITE_READONLY: 'PERMISSION_DENIED',
  SQLITE_CANTOPEN: 'PERMISSION_DENIED',
  // 网络
  ETIMEDOUT: 'PROVIDER_TIMEOUT',
  ECONNRESET: 'PROVIDER_NETWORK_ERROR',
  ECONNREFUSED: 'PROVIDER_UNAVAILABLE',
  ENOTFOUND: 'PROVIDER_UNAVAILABLE',
  EAI_AGAIN: 'PROVIDER_UNAVAILABLE',
  EPIPE: 'PROVIDER_NETWORK_ERROR',
  UND_ERR_CONNECT_TIMEOUT: 'PROVIDER_TIMEOUT',
  UND_ERR_HEADERS_TIMEOUT: 'PROVIDER_TIMEOUT',
  UND_ERR_BODY_TIMEOUT: 'PROVIDER_TIMEOUT',
  // 进程 / 模块
  ERR_MODULE_NOT_FOUND: 'INTERNAL',
  MODULE_NOT_FOUND: 'INTERNAL',
  ERR_INVALID_ARG_TYPE: 'INVALID_PAYLOAD',
  ERR_INVALID_ARG_VALUE: 'INVALID_PAYLOAD',
  // 浏览器侧（渲染进程可能抛出）
  NotAllowedError: 'DEVICE_PERMISSION',
  NotFoundError: 'DEVICE_UNAVAILABLE',
  NotReadableError: 'DEVICE_UNAVAILABLE',
  OverconstrainedError: 'DEVICE_UNAVAILABLE',
  AbortError: 'TASK_CANCELLED',
  QuotaExceededError: 'DISK_FULL',
} as const

/** 取消类错误：不弹提示、不写 error 级日志 */
const CANCEL_KEYS: ReadonlySet<string> = new Set(['TASK_CANCELLED', 'PROVIDER_ABORTED', 'PROCESS_ABORTED'])

export function isCancelKey(key: string): boolean {
  return CANCEL_KEYS.has(key)
}

// ============================================================================
// AppError
// ============================================================================

export interface AppErrorOptions {
  params?: MessageParams
  details?: Record<string, unknown>
  cause?: unknown
  /** 覆盖消息表中的严重度（少数情况需要，例如同一码在不同场景下阻断性不同） */
  severity?: Severity
  /** 覆盖消息表中的动作 */
  action?: ErrorAction
  /** 覆盖 retryable */
  retryable?: boolean
}

export class AppError extends Error {
  /** 语义键，如 'RECORD_DEVICE_LOST' */
  readonly key: string
  /** 派生数字编号，如 'E200005' */
  readonly numericCode: string
  readonly severity: Severity
  readonly action: ErrorAction
  readonly retryable: boolean
  readonly params: MessageParams
  readonly details?: Record<string, unknown>
  /** 原始错误摘要链（只进日志） */
  readonly causeChain: string[]

  constructor(key: string, options?: AppErrorOptions) {
    // 1) 先解析消息（未知键会回退到 INTERNAL，不抛错）
    const opts = options ?? {}
    const msg = getMessage(key, opts.params)

    // 2) message 用 title，便于日志与 Sentry 之类工具直接可读
    super(msg.title)

    this.name = 'AppError'
    // 兼容 target 降级到 ES5 时的原型链
    Object.setPrototypeOf(this, AppError.prototype)

    this.key = msg.key
    this.numericCode = msg.code
    this.severity = opts.severity ?? msg.severity
    this.action = opts.action ?? msg.action
    this.retryable = opts.retryable ?? msg.retryable
    this.params = opts.params ?? {}
    if (opts.details) this.details = opts.details
    this.causeChain = opts.cause ? summarizeCauseChain(opts.cause) : []

    if (opts.cause !== undefined) {
      // Node 16+ 支持 Error.cause；同时保留在 causeChain 里以过 IPC
      ;(this as { cause?: unknown }).cause = opts.cause
    }

    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError)
  }

  /** 静态构造：`AppError.of('DEVICE_LOST', { params: { device: 'USB Mic' } })` */
  static of(key: string, options?: AppErrorOptions): AppError {
    return new AppError(key, options)
  }

  /** 消息（已插值），渲染侧直接用这个 */
  get resolved(): ResolvedMessage {
    return getMessage(this.key, this.params)
  }

  /** 是否为取消类错误 */
  get isCancelled(): boolean {
    return isCancelKey(this.key)
  }

  toJSON(): SerializedAppError {
    return toSerialized(this)
  }

  /** 从 IPC 收到的纯数据还原成 AppError */
  static fromSerialized(raw: SerializedAppError): AppError {
    const e = new AppError(raw.code, {
      params: raw.params ?? {},
      details: raw.details,
      severity: raw.severity,
      action: raw.action,
      retryable: raw.retryable,
    })
    // 还原 causeChain 与 stack（便于开发模式展示）
    if (raw.causeChain?.length) (e.causeChain as string[]).push(...raw.causeChain)
    if (raw.stack) e.stack = raw.stack
    return e
  }
}

/** 业务异常别名：业务代码里读起来更顺 */
export { AppError as BusinessError }

// ============================================================================
// 判定与包裹
// ============================================================================

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (
    typeof e === 'object' && e !== null &&
    (e as { name?: string }).name === 'AppError' &&
    typeof (e as { key?: unknown }).key === 'string'
  )
}

/** 是否取消类错误（原始形态也要能识别） */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: string }).name
  const code = (e as { code?: string }).code
  return name === 'AbortError' || code === 'ABORT_ERR' || code === 'ERR_CANCELED'
}

/**
 * 读取错误的 code 字段（Node 系统错误、undici、DOMException 都在这里）
 *
 * ⚠️ DOMException 的 `code` 是**数字**（AbortError=20、NotAllowedError=18…），
 * 它的「错误名」在 `name` 里。因此这里还要回看一次 `name` ——
 * 否则 `SYSTEM_ERRNO_MAP` 里那批**按名字**写的条目
 * （`NotAllowedError` / `NotFoundError` / `NotReadableError` / `OverconstrainedError` /
 * `QuotaExceededError`）全是死代码：麦克风权限被拒、设备被占用都会退化成「未预期的错误」。
 * 只查表里存在的名字，避免把普通 `Error` 的 name 当 errno。
 */
function readErrorCode(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined
  const code = (e as { code?: unknown }).code
  if (typeof code === 'string') return code
  const errno = (e as { errno?: unknown }).errno
  if (typeof errno === 'string') return errno
  const name = (e as { name?: unknown }).name
  if (typeof name === 'string' && name !== 'Error' && name in SYSTEM_ERRNO_MAP) return name
  return undefined
}

/** 把任意错误转成 AppError。已是 AppError 时原样返回（不重复包裹）。 */
export function wrapUnknown(e: unknown, fallbackKey: MessageKey = 'INTERNAL'): AppError {
  if (isAppError(e)) return e

  if (isAbortError(e)) {
    return new AppError('TASK_CANCELLED', { cause: e })
  }

  if (e instanceof Error) {
    // SQLite 的「表/视图不存在」必须在通用的 errno 映射之前识别。
    // 理由见 detectSqliteSchemaError 的注释：它的 code 是通用的 SQLITE_ERROR，
    // 没有专属 errno 可映射，不特殊处理就会被兜底成 INTERNAL（UI 显示错误编号「-」）。
    const schemaErr = detectSqliteSchemaError(e)
    if (schemaErr) return schemaErr

    const sysCode = readErrorCode(e)
    const mapped = sysCode ? SYSTEM_ERRNO_MAP[sysCode] : undefined
    if (mapped) {
      return new AppError(mapped, {
        cause: e,
        details: sysCode ? { sysCode } : undefined,
      })
    }
    return new AppError(fallbackKey, { cause: e, details: sysCode ? { sysCode } : undefined })
  }

  // 抛了非 Error（字符串 / 对象 / undefined）
  return new AppError(fallbackKey, { details: { raw: safeStringify(e) } })
}

/**
 * 错误归一化的**唯一入口**（渲染进程的错误总线与主进程都用它）。
 *
 * 顺序：
 *   1. 已经是 `AppError` → 原样返回（不重复包裹）
 *   2. 过 IPC 的序列化体 → `AppError.fromSerialized` 还原
 *   3. 其余一切都交给 {@link wrapUnknown} —— **必须走这一条**，
 *      否则 `SYSTEM_ERRNO_MAP`、`isAbortError`、`detectSqliteSchemaError` 全都不生效
 *
 * ### 为什么单列这个函数（真机事故 docs/91 §5.2.38）
 *   渲染进程的错误总线原来自己写了一句 `AppError.of('INTERNAL', { cause: input })`，
 *   绕过了 `wrapUnknown`。后果是**所有映射都失效**：
 *     · 设备诊断里一次被中断的采集（DOMException `AbortError`）本该按「取消」静默处理，
 *       却弹出「发生了未预期的错误 / 错误编号：「-」」+「兜底码…某处缺少精确抛错」；
 *     · `NotAllowedError`（麦克风权限被拒）、`ENOSPC`（磁盘满）、`SQLITE_BUSY` 等
 *       也全都退化成同一句「未预期的错误」，用户拿不到任何可行动的线索。
 *   把归一化收在这里之后，「先映射、再兜底」这件事只剩一处实现，两边都测得到。
 */
export function normalizeErrorInput(input: unknown): AppError {
  if (isAppError(input)) return input
  if (isSerializedAppError(input)) return AppError.fromSerialized(input as SerializedAppError)
  return wrapUnknown(input)
}

/**
 * 识别 SQLite 的「表不存在」类错误，转成可读的 `DB_SCHEMA_INCOMPLETE`。
 *
 * ### 为什么必须单独做这件事（真机上踩过）
 *   真实报错：`[SQLITE_ERROR] SqliteError: no such table: books`
 *   它的 `code` 是 **`SQLITE_ERROR`** —— SQLite 的**通用**错误码，
 *   而 `SYSTEM_ERRNO_MAP` 里能映射的是 `SQLITE_BUSY` / `SQLITE_CORRUPT` /
 *   `SQLITE_READONLY` 这类**专属**码。于是 `SQLITE_ERROR` 一路落到
 *   `wrapUnknown` 的兜底分支 → `INTERNAL` → UI 只显示错误编号「-」，
 *   附一句「某处缺少精确抛错，应补齐」。
 *
 *   用户实际需要知道的是「表没建」，而不是「未知错误」——这两者对
 *   排查的指导价值天差地别。所以这里按**消息模式**补一条精确映射。
 *
 * ### 为什么放在 shared 层而不是仓库层
 *   仓库层逐个 `try/catch` 需要改十几处、且以后新增仓库必然漏。
 *   这个判断是纯字符串/字段检查，零依赖，放在错误归一化的唯一入口最可靠。
 */
export function detectSqliteSchemaError(e: unknown): AppError | null {
  if (!(e instanceof Error)) return null
  const code = (e as { code?: unknown }).code
  if (code !== 'SQLITE_ERROR') return null

  // 覆盖 SQLite 的三种措辞：
  //   no such table: books
  //   no such view: v_xxx
  //   no such index: idx_xxx
  const m = /\bno such (?:table|view|index|column|trigger):\s*([A-Za-z_][\w.]*)/.exec(e.message)
  if (!m) return null

  const kind = /\bno such (table|view|index|column|trigger)\b/.exec(e.message)?.[1] ?? 'table'
  const name = m[1]!
  return new AppError('DB_SCHEMA_INCOMPLETE', {
    cause: e,
    params: { table: name },
    details: {
      reason: 'sqlite-schema-missing',
      missingKind: kind,
      missingName: name,
      sqliteCode: 'SQLITE_ERROR',
      hint:
        '表不存在通常意味着数据库迁移没有完成。检查启动日志里是否有 ' +
        'db.migrate.failed.readOnly / DB_MIGRATION_FAILED —— ' +
        '最常见成因是迁移 SQL（.sql）没有被复制进构建产物。',
    },
  })
}

/** 断言：用于「不该发生」的路径，抛出的仍是业务异常 */
export function assertBusiness(
  condition: unknown,
  key: MessageKey,
  options?: AppErrorOptions,
): asserts condition {
  if (!condition) throw new AppError(key, options)
}

// ============================================================================
// 序列化 / 兑现
// ============================================================================

const MAX_CAUSE_CHAIN = 5

/** 把原始错误的链摘要成字符串数组（只取 message，截断，不带堆栈） */
export function summarizeCauseChain(e: unknown, depth = 0): string[] {
  const out: string[] = []
  let cur: unknown = e
  while (cur && depth + out.length < MAX_CAUSE_CHAIN) {
    if (cur instanceof Error) {
      const code = readErrorCode(cur)
      const head = `${cur.name}: ${cur.message}`.slice(0, 300)
      out.push(code ? `[${code}] ${head}` : head)
      cur = (cur as { cause?: unknown }).cause
    } else if (typeof cur === 'object' && cur !== null) {
      out.push(safeStringify(cur).slice(0, 300))
      break
    } else {
      out.push(String(cur).slice(0, 300))
      break
    }
  }
  return out
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 转成过 IPC 的纯数据。
 * stack 只在开发模式或 error/fatal 级别带上（避免诊断包臃肿，也避免顺手泄露内部路径）。
 */
export function toSerialized(e: AppError, opts?: { includeStack?: boolean }): SerializedAppError {
  const includeStack = opts?.includeStack ?? (e.severity === 'error' || e.severity === 'fatal')
  return {
    code: e.key,
    numericCode: e.numericCode,
    message: getMessage(e.key, e.params).title,
    severity: e.severity,
    action: e.action,
    retryable: e.retryable,
    params: e.params,
    ...(e.details ? { details: sanitizeDetails(e.details) } : {}),
    ...(e.causeChain.length ? { causeChain: e.causeChain } : {}),
    ...(includeStack && e.stack ? { stack: e.stack.split('\n').slice(0, 12).join('\n') } : {}),
  }
}

/** 兜底包裹 + 序列化（handler 里catch 到任何东西时调用它） */
export function toSerializedUnknown(e: unknown, fallbackKey: MessageKey = 'INTERNAL'): SerializedAppError {
  return toSerialized(wrapUnknown(e, fallbackKey))
}

/** details 脱敏：绝不把密钥带进日志或诊断包 */
const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|bearer)/i

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(details)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = '***'
      continue
    }
    if (typeof v === 'string' && v.length > 2000) {
      out[k] = `${v.slice(0, 2000)}…(截断，共 ${v.length} 字)`
      continue
    }
    out[k] = v
  }
  return out
}

/** IPC 成功/失败构造助手 */
export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
export function fail(e: unknown, fallbackKey: MessageKey = 'INTERNAL'): IpcResult<never> {
  return { ok: false, error: toSerializedUnknown(e, fallbackKey) }
}

/**
 * 渲染侧「兑现」：从 IPC 错误数据得到可渲染消息。
 * 这是 UI 文案的唯一出口——组件里不要自己拼文案。
 */
export interface DisplayableError {
  key: string
  code: string
  title: string
  detail?: string
  hint?: string
  severity: Severity
  action: ErrorAction
  retryable: boolean
  /** 仅开发模式展示 */
  devText?: string
}

export function resolve(
  e: AppError | SerializedAppError | unknown,
  opts?: { includeDev?: boolean },
): DisplayableError {
  const appErr = isAppError(e)
    ? e
    : isSerializedAppError(e)
      ? AppError.fromSerialized(e)
      : wrapUnknown(e)

  const msg = appErr.resolved
  const devParts: string[] = []
  if (opts?.includeDev) {
    if (msg.dev) devParts.push(msg.dev)
    if (appErr.causeChain.length) devParts.push(`原因链：${appErr.causeChain.join(' → ')}`)
  }

  return {
    key: appErr.key,
    code: appErr.numericCode,
    title: msg.title,
    detail: msg.detail,
    hint: msg.hint,
    severity: appErr.severity,
    action: appErr.action,
    retryable: appErr.retryable,
    ...(devParts.length ? { devText: devParts.join('\n') } : {}),
  }
}

export function isSerializedAppError(v: unknown): v is SerializedAppError {
  return typeof v === 'object' && v !== null &&
    typeof (v as { code?: unknown }).code === 'string' &&
    typeof (v as { numericCode?: unknown }).numericCode === 'string' &&
    typeof (v as { severity?: unknown }).severity === 'string'
}

// ============================================================================
// 日志辅助
// ============================================================================

/** 错误日志的必填字段（见 docs/22 §8）。所有 catch 处应统一调用它。 */
export interface ErrorLogFields {
  event: string
  code: string
  numericCode: string
  severity: Severity
  retryable: boolean
  params: MessageParams
  cause?: string
  causeChain?: string[]
  context?: Record<string, unknown>
  stack?: string
}

export function toLogFields(
  e: unknown,
  event: string,
  context?: Record<string, unknown>,
  fallbackKey: MessageKey = 'INTERNAL',
): ErrorLogFields {
  const appErr = wrapUnknown(e, fallbackKey)
  const includeStack = appErr.severity === 'error' || appErr.severity === 'fatal'
  return {
    event,
    code: appErr.key,
    numericCode: appErr.numericCode,
    severity: appErr.severity,
    retryable: appErr.retryable,
    params: appErr.params,
    ...(appErr.causeChain.length ? { cause: appErr.causeChain[0], causeChain: appErr.causeChain } : {}),
    ...(context ? { context } : {}),
    ...(includeStack && appErr.stack ? { stack: appErr.stack } : {}),
  }
}

/** 预置的常用业务异常工厂（读起来更像业务语言） */
export const Errors = {
  notFound: (what: string) => new AppError('NOT_FOUND', { details: { what } }),
  invalid: (details?: Record<string, unknown>) => new AppError('INVALID_PAYLOAD', { details }),
  permission: (details?: Record<string, unknown>) => new AppError('PERMISSION_DENIED', { details }),
  diskFull: (needBytes: number) =>
    new AppError('DISK_FULL', {
      params: { need: formatBytes(needBytes) },
      details: { needBytes },
    }),
  fileMissing: (name: string) => new AppError('FILE_NOT_FOUND', { params: { name } }),
  notImplemented: (feature: string) => new AppError('NOT_IMPLEMENTED', { params: { feature } }),
  cancelled: () => new AppError('TASK_CANCELLED'),
  /** 万能兜底（兜底不到具体原因时用，会带上原始错误供日志排查） */
  internal: (cause?: unknown, details?: Record<string, unknown>) =>
    new AppError('INTERNAL', { cause, details }),
}

/** 占位符缺值时的退化显示（与 messages.ts 的 interpolate 保持一致） */
export const PLACEHOLDER_FALLBACK = '-'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return PLACEHOLDER_FALLBACK
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // 整数值不带小数（1 KB 而不是 1.0 KB），非整数保留一位（1.5 MB）
  const text = i === 0 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)
  return `${text} ${units[i]}`
}

// ============================================================================
// 启动自检（开发期把配置错误尽早暴露）
// ============================================================================

export function assertErrorSystemReady(): void {
  // 抽查若干关键码，确认编号派生正常（未登记会返回 E000000，属明显异常）
  const samples: MessageKey[] = ['INTERNAL', 'DEVICE_LOST', 'EXPORT_FFMPEG_FAILED', 'UI_RENDER_ERROR']
  for (const key of samples) {
    const code = resolveCode(key)
    if (code === 'E000000') {
      throw new Error(`[errors] 语义键 "${key}" 未登记到 messages.ts 的 SEGMENTS 中`)
    }
  }
}
