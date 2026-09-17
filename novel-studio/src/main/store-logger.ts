/**
 * Novel Studio · 主进程日志器装配
 * ============================================================================
 * 设计依据：docs/04 §5「日志与诊断」、docs/22 §3「日志分级」、§8「日志落盘」
 *
 * 本文件只做「把 sink 拼起来」，脱敏/分级/轮转全在 `infra/log/logger.ts` 里，
 * 不在这里重复实现。
 *
 * ### sink 组合的取舍
 *   · **文件 sink**：唯一真正的落盘点（`<dataRoot>/logs/YYYY-MM-DD.log`，按天轮转，
 *     保留 LOG_RETENTION_DAYS 天）。诊断包就是读它。
 *   · **控制台 sink**：只给开发期看。打包后接在用户终端上是噪音，
 *     因此 `devOnly` 为真时才挂。
 *   · 两者都挂时，运维视角就是「文件为准，控制台为辅」。
 */

import { createConsoleSink, createFileSink, createLogger, LOG_RETENTION_DAYS, type LogLevel, type Logger, type LogSink } from './infra/log/index.ts'

export interface CreateStoreLoggerOptions {
  /** 日志目录（`<dataRoot>/logs`） */
  logDir: string
  /** 日志级别（来自设置或命令行） */
  level?: LogLevel
  /** 是否挂控制台 sink（开发期 true） */
  devOnly?: boolean
  /** 额外 sink（测试注入内存 sink 用） */
  extraSinks?: LogSink[]
}

export interface StoreLogger {
  logger: Logger
  /** 当天日志文件路径的所在目录（诊断包与「打开日志目录」用） */
  logDir: string
  retentionDays: number
}

/**
 * 创建主进程日志器。
 *
 * 注意：**日志器必须在数据库之前就绪**（docs/01 §10：3 在 4 之前）——
 * 「数据库出问题要留日志」这条只在这一顺序下成立。
 */
export function createStoreLogger(opts: CreateStoreLoggerOptions): StoreLogger {
  const sinks: LogSink[] = [createFileSink({ dir: opts.logDir, retentionDays: LOG_RETENTION_DAYS })]
  if (opts.devOnly) {
    // 开发期控制台只输出 info 及以上：debug/trace 太吵，会淹掉启动报告
    sinks.push(createConsoleSink({ minLevel: 'info' }))
  }
  if (opts.extraSinks) sinks.push(...opts.extraSinks)

  const logger = createLogger({
    level: opts.level ?? 'info',
    sinks,
    userDataDir: opts.logDir,
  })

  return { logger, logDir: opts.logDir, retentionDays: LOG_RETENTION_DAYS }
}
