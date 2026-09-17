/**
 * 基础设施 · 结构化日志
 * ============================================================================
 * 设计依据：docs/04 §5（分级与输出 / 脱敏规则 / 结构化记录 / 崩溃捕获）
 *          docs/22 §8（错误日志必填字段）、docs/21 §10（日志双重策略）
 *
 * ### 分级（docs/04 §5.1）
 * | 级别 | 用途 | 生产默认 |
 * |------|------|----------|
 * | error | 操作失败、异常 | 记录 + 上报 UI（去重） |
 * | warn  | 降级、可恢复异常 | 记录 |
 * | info  | 关键业务动作 | 记录 |
 * | debug | 流程细节、IPC 参数 | 关闭 |
 * | trace | 逐帧/逐样本 | 关闭 |
 *
 * ### 脱敏（docs/04 §5.2，**必须**）
 * | 内容 | 处理 |
 * |------|------|
 * | API Key / Token | 永不记录；掩码 `***` |
 * | 作品正文 | 默认不记录；debug 下仅前 20 字 + 长度 |
 * | 文件绝对路径 | `{userData}/...` 相对形式（保护用户名） |
 * | HTTP 请求/响应体 | 只记长度、状态码、耗时 |
 * | 系统用户名 | 掩码 |
 *
 * 脱敏放在**写入器内部**（而不是靠调用方自觉）：日志是最后一道可能泄露密钥的地方，
 * 「调用方记得别传 Key」这种约定一定会被违反。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { toLogFields } from '../../../shared/errors.ts'

// ---------------------------------------------------------------------------
// 级别
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_WEIGHT: Record<LogLevel, number> = { error: 40, warn: 30, info: 20, debug: 10, trace: 5 }

/** 日志文件保留天数（docs/04 §5.1：文本 14 天；app_logs 表 7 天） */
export const LOG_RETENTION_DAYS = 14

/** 正文在日志里的最大保留字符数（docs/04 §5.2：debug 下仅前 20 字 + 长度） */
export const BODY_PREVIEW_CHARS = 20

/** 单条日志里字符串字段的上限（防止一个超大对象把一行日志刷成几 MB） */
const MAX_STRING_CHARS = 400

// ---------------------------------------------------------------------------
// 事件命名（docs/04 §5.3：`域.动作.结果`）
// ---------------------------------------------------------------------------

const EVENT_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+){1,3}$/

/**
 * 事件名是否合规：`域.动作.结果`（如 `canvas.generate.done`）。
 * 严格命名让日志能被按域统计（「今天有多少次导出失败」不该靠正则猜）。
 */
export function isValidEventName(event: string): boolean {
  if (typeof event !== 'string' || event.length === 0 || event.length > 80) return false
  return EVENT_RE.test(event)
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 命中即整值掩码的键名（docs/04 §5.2） */
const SECRET_KEY_RE = /(api[-_]?key|apikey|token|secret|password|passwd|authorization|bearer|cookie|credential|private[-_]?key)/i
/** 命中即按「正文」处理（只记长度，debug 下记前 N 字） */
const BODY_KEY_RE = /(^|_)(text|body|content|raw|rawtext|source_text|sourcetext|prompt|completion|transcript|html)$/i
/** 命中即按「HTTP 体」处理（只记长度，连前 N 字都不给） */
const HTTP_BODY_KEY_RE = /(requestbody|responsebody|request_body|response_body|payload)/i

/** 掩码值（键名命中密钥规则时使用） */
export const MASK = '***'

export interface SanitizeContext {
  /** userData 目录（绝对路径 → `{userData}/...`） */
  userDataDir?: string | null
  /** 用户主目录（绝对路径 → `{home}/...`，保护系统用户名） */
  homeDir?: string | null
  /** 是否保留正文前 N 字（debug/trace 模式下为 true，docs/04 §5.2） */
  includeBodyPreview?: boolean
  /** 额外需要替换的根目录（label → 绝对路径），如 `{project}`、`{model}` */
  extraRoots?: Record<string, string>
}

/**
 * 字符串脱敏：绝对路径 → `{userData}/...`、系统用户名 → 掩码。
 *
 * 顺序很重要：先替换**最长的根**，否则 `{home}` 会先吃掉 `{userData}` 的前缀。
 */
export function sanitizeString(value: string, ctx?: SanitizeContext): string {
  let out = value

  const roots: Array<{ prefix: string; label: string }> = []
  if (ctx?.userDataDir) roots.push({ prefix: ctx.userDataDir, label: '{userData}' })
  if (ctx?.homeDir) roots.push({ prefix: ctx.homeDir, label: '{home}' })
  for (const [label, dir] of Object.entries(ctx?.extraRoots ?? {})) roots.push({ prefix: dir, label })
  roots.sort((a, b) => b.prefix.length - a.prefix.length)

  for (const { prefix, label } of roots) {
    if (!prefix) continue
    // Windows 路径大小写不敏感，且 `\` 与 `/` 混用很常见
    const re = new RegExp(escapeRegExp(prefix).replace(/[\\/]+/g, '[\\\\/]+'), 'gi')
    out = out.replace(re, label)
  }

  // 仍残留的绝对路径：掩码用户名段（C:\Users\xxx\... / /home/xxx/... / /Users/xxx/...）
  out = out.replace(/([A-Za-z]:[\\/]Users[\\/])([^\\/]+)/gi, '$1{user}')
  out = out.replace(/(\/(?:home|Users)\/)([^\\/]+)/g, '$1{user}')

  if (out.length > MAX_STRING_CHARS) out = `${out.slice(0, MAX_STRING_CHARS)}…(共 ${out.length} 字)`
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 递归脱敏任意值（对象/数组/错误）。
 * 返回的新对象**不再包含**密钥原文；`Error` 只保留 name/message/stack（stack 也过脱敏）。
 */
export function sanitizeValue(value: unknown, ctx?: SanitizeContext, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return sanitizeString(value, ctx)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
  if (typeof value === 'function' || typeof value === 'symbol') return '[fn]'
  if (depth > 4) return '[deep]'
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message, ctx),
      ...(value.stack ? { stack: sanitizeString(value.stack.split('\n').slice(0, 6).join('\n'), ctx) } : {}),
    }
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => sanitizeValue(item, ctx, depth + 1))
    return value.length > 20 ? [...head, `…(共 ${value.length} 项)`] : head
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = MASK
        continue
      }
      if (HTTP_BODY_KEY_RE.test(k)) {
        out[k] = typeof val === 'string' ? `[http-body ${val.length} 字，不记录]` : '[http-body 不记录]'
        continue
      }
      if (BODY_KEY_RE.test(k)) {
        out[k] = describeBody(val, ctx?.includeBodyPreview === true)
        continue
      }
      out[k] = sanitizeValue(val, ctx, depth + 1)
    }
    return out
  }
  return String(value)
}

/** 正文类字段的处理（docs/04 §5.2：默认不记录；debug 下仅前 20 字 + 长度） */
export function describeBody(value: unknown, includePreview: boolean): string {
  if (value === null || value === undefined) return String(value)
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!includePreview) return `[正文 ${text.length} 字，未记录]`
  return `${text.slice(0, BODY_PREVIEW_CHARS)}…(共 ${text.length} 字)`
}

// ---------------------------------------------------------------------------
// 输出（sink）
// ---------------------------------------------------------------------------

export interface LogRecord {
  ts: number
  level: LogLevel
  /** `域.动作.结果` */
  event: string
  /** 已脱敏的字段 */
  data: Record<string, unknown>
  /** 来源标记（main / renderer / worker） */
  scope: string
}

export interface LogSink {
  write(record: LogRecord): void
  close?(): void
}

/** 文件输出（`logs/YYYY-MM-DD.log`，保留 14 天） */
export function createFileSink(opts: { dir: string; retentionDays?: number }): LogSink {
  const retentionDays = opts.retentionDays ?? LOG_RETENTION_DAYS
  let ensured = false
  let lastPrunedDay = ''
  return {
    write(record) {
      try {
        if (!ensured) {
          mkdirSync(opts.dir, { recursive: true })
          ensured = true
        }
        const day = new Date(record.ts).toISOString().slice(0, 10)
        if (day !== lastPrunedDay) {
          lastPrunedDay = day
          pruneOldLogs(opts.dir, retentionDays, record.ts)
        }
        appendFileSync(join(opts.dir, `${day}.log`), `${JSON.stringify(record)}\n`, 'utf8')
      } catch {
        // 日志写不进去（磁盘满/权限）绝不能反过来抛错——错误处理路径本身永不抛错
      }
    },
  }
}

/** 控制台输出（开发期） */
export function createConsoleSink(opts?: { minLevel?: LogLevel }): LogSink {
  // 只输出「≥ minLevel 的严重度」：minLevel='debug' 时输出除 trace 外全部
  const min = LEVEL_WEIGHT[opts?.minLevel ?? 'debug']
  return {
    write(record) {
      if (LEVEL_WEIGHT[record.level] < min) return
      const keys = Object.keys(record.data)
      const suffix = keys.length > 0 ? ` ${JSON.stringify(record.data)}` : ''
      const line = `[${record.level}] ${record.event}${suffix}`
      if (record.level === 'error' || record.level === 'warn') console.error(line)
      else console.log(line)
    },
  }
}

/** 内存输出（测试与「诊断面板」用；有上限，防内存泄漏） */
export function createMemorySink(maxRecords = 500): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = []
  return {
    records,
    write(record) {
      records.push(record)
      if (records.length > maxRecords) records.splice(0, records.length - maxRecords)
    },
  }
}

/** 删除超过保留期的日志文件（docs/04 §5.1：文件保留 14 天） */
export function pruneOldLogs(dir: string, retentionDays: number, now = Date.now()): number {
  let removed = 0
  try {
    const cutoff = now - retentionDays * 24 * 3600 * 1000
    for (const name of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full)
          removed++
        }
      } catch {
        /* 竞态删除，忽略 */
      }
    }
  } catch {
    /* 目录不存在等，忽略 */
  }
  return removed
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  level?: LogLevel
  sinks?: LogSink[]
  userDataDir?: string | null
  homeDir?: string | null
  extraRoots?: Record<string, string>
  scope?: string
  now?: () => number
  /** 渲染进程日志订阅者（`log:entry` 事件，docs/04 §5.1） */
  onEntry?: (record: LogRecord) => void
  /** 环形缓冲容量（诊断包取最近日志） */
  recentLimit?: number
}

export interface Logger {
  readonly level: LogLevel
  setLevel(level: LogLevel): void
  error(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  info(event: string, data?: Record<string, unknown>): void
  debug(event: string, data?: Record<string, unknown>): void
  trace(event: string, data?: Record<string, unknown>): void
  /** 记录一个业务异常（自动带上 code/numericCode/causeChain/context，docs/22 §8） */
  errorFields(e: unknown, event: string, context?: Record<string, unknown>): void
  /** 派生带固定字段的子 logger（如 `{ taskId }`） */
  child(fields: Record<string, unknown>, scope?: string): Logger
  /** 直接写一条已构造的记录（渲染进程上报用） */
  write(record: Partial<LogRecord> & { level: LogLevel; event: string }): void
  addSink(sink: LogSink): void
  /** 诊断面板打开/关闭时的日志流订阅 */
  setEntryListener(fn: ((record: LogRecord) => void) | null): void
  /** 最近 N 条（内存环形缓冲） */
  recent(limit?: number): LogRecord[]
}

/**
 * 创建结构化日志器。
 *
 * 关键行为：
 *   1. **先脱敏再落盘**（含 Error.stack），调用方无需关心
 *   2. 事件名不合规时**不丢事件**：改写为 `log.invalidEvent` 并把原名放进
 *      `data.invalidEventName`（日志不能因为命名不规范就消失，但也要能被发现）
 *   3. 任何 sink 抛错都被吞掉（日志失败不影响业务）
 */
export function createLogger(opts?: LoggerOptions): Logger {
  const now = opts?.now ?? Date.now
  const sinks = [...(opts?.sinks ?? [])]
  const ring: LogRecord[] = []
  const ringLimit = opts?.recentLimit ?? 300
  let level: LogLevel = opts?.level ?? 'info'
  let entryListener = opts?.onEntry ?? null
  const scope = opts?.scope ?? 'main'

  const baseCtx: SanitizeContext = {
    userDataDir: opts?.userDataDir ?? null,
    homeDir: opts?.homeDir ?? null,
    extraRoots: opts?.extraRoots,
  }

  function build(
    levelIn: LogLevel,
    event: string,
    data: Record<string, unknown> | undefined,
    recordScope: string,
  ): LogRecord {
    const includeBodyPreview = LEVEL_WEIGHT[levelIn] <= LEVEL_WEIGHT.debug
    const safeEvent = isValidEventName(event) ? event : 'log.invalidEvent'
    const safeData = sanitizeValue(data ?? {}, { ...baseCtx, includeBodyPreview }) as Record<string, unknown>
    if (safeEvent !== event) safeData.invalidEventName = event
    return { ts: now(), level: levelIn, event: safeEvent, data: safeData, scope: recordScope }
  }

  function emit(record: LogRecord): void {
    // 权重越大越严重：只输出「严重度 ≥ 当前级别」的记录
    // （level='info' 时输出 error/warn/info；level='debug' 时额外输出 debug/trace）
    if (LEVEL_WEIGHT[record.level] < LEVEL_WEIGHT[level]) return
    ring.push(record)
    if (ring.length > ringLimit) ring.splice(0, ring.length - ringLimit)
    for (const sink of sinks) {
      try {
        sink.write(record)
      } catch {
        /* 单个 sink 失败不影响其它 */
      }
    }
    if (entryListener) {
      try {
        entryListener(record)
      } catch {
        /* 渲染进程可能正在重建，忽略 */
      }
    }
  }

  const logger: Logger = {
    get level(): LogLevel {
      return level
    },
    setLevel(next: LogLevel) {
      level = next
    },
    error: (event, data) => emit(build('error', event, data, scope)),
    warn: (event, data) => emit(build('warn', event, data, scope)),
    info: (event, data) => emit(build('info', event, data, scope)),
    debug: (event, data) => emit(build('debug', event, data, scope)),
    trace: (event, data) => emit(build('trace', event, data, scope)),
    errorFields(e, event, context) {
      // 见 docs/22 §8：错误日志必填 code/numericCode/severity/retryable/params/causeChain
      emit(build('error', event, toLogFields(e, event, context) as unknown as Record<string, unknown>, scope))
    },
    child(fields, childScope) {
      const merged = (data?: Record<string, unknown>): Record<string, unknown> => ({ ...fields, ...(data ?? {}) })
      const childScopeResolved = childScope ?? scope
      return {
        get level(): LogLevel {
          return level
        },
        setLevel(next: LogLevel) {
          level = next
        },
        error: (event, data) => emit(build('error', event, merged(data), childScopeResolved)),
        warn: (event, data) => emit(build('warn', event, merged(data), childScopeResolved)),
        info: (event, data) => emit(build('info', event, merged(data), childScopeResolved)),
        debug: (event, data) => emit(build('debug', event, merged(data), childScopeResolved)),
        trace: (event, data) => emit(build('trace', event, merged(data), childScopeResolved)),
        errorFields: (e, event, context) =>
          emit(
            build(
              'error',
              event,
              { ...fields, ...(toLogFields(e, event, context) as unknown as Record<string, unknown>) },
              childScopeResolved,
            ),
          ),
        child: (f2, s2) => logger.child({ ...fields, ...f2 }, s2 ?? childScopeResolved),
        write: (record) => logger.write({ ...record, scope: record.scope ?? childScopeResolved, data: merged(record.data) }),
        addSink: (sink) => logger.addSink(sink),
        setEntryListener: (fn) => logger.setEntryListener(fn),
        recent: (limit) => logger.recent(limit),
      }
    },
    write(record) {
      const safeEvent = isValidEventName(record.event) ? record.event : 'log.invalidEvent'
      const data = sanitizeValue(record.data ?? {}, { ...baseCtx, includeBodyPreview: LEVEL_WEIGHT[record.level] <= LEVEL_WEIGHT.debug })
      emit({
        ts: record.ts ?? now(),
        level: record.level,
        event: safeEvent,
        data: (safeEvent === record.event ? data : { ...(data as object), invalidEventName: record.event }) as Record<string, unknown>,
        scope: record.scope ?? scope,
      })
    },
    addSink(sink) {
      sinks.push(sink)
    },
    setEntryListener(fn) {
      entryListener = fn
    },
    recent(limit = 100) {
      return ring.slice(-limit)
    },
  }
  return logger
}

/** 便于测试：计算一条日志的稳定指纹（如「同一条日志 1 秒内只推一次」的断言） */
export function logFingerprint(record: Pick<LogRecord, 'event' | 'data'>): string {
  return createHash('sha1').update(`${record.event}|${JSON.stringify(record.data)}`).digest('hex').slice(0, 12)
}

/** 事件命名示例（docs/04 §5.3：`域.动作.结果`） */
export const EVENT_EXAMPLES = [
  'app.start.done',
  'db.migrate.applied',
  'db.integrity.failed',
  'task.enqueued',
  'task.finished',
  'record.start.done',
  'record.write.backpressure',
  'export.chapter.done',
  'canvas.generate.done',
  'log.invalidEvent',
] as const
