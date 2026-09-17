/**
 * 基础设施 · 日志出口
 * ============================================================================
 * 见 docs/04 §5。
 */

export {
  BODY_PREVIEW_CHARS,
  EVENT_EXAMPLES,
  LOG_LEVELS,
  LOG_RETENTION_DAYS,
  MASK,
  createConsoleSink,
  createFileSink,
  createLogger,
  createMemorySink,
  describeBody,
  isValidEventName,
  logFingerprint,
  pruneOldLogs,
  sanitizeString,
  sanitizeValue,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type Logger,
  type LoggerOptions,
  type SanitizeContext,
} from './logger.ts'
