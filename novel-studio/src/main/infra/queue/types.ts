/**
 * 基础设施 · 任务队列类型
 * ============================================================================
 * 设计依据：docs/04 §2「任务队列」
 *
 * ```ts
 * interface TaskRecord { id, kind, status: 'queued'|'waiting'|'running'|'succeeded'
 *                        |'failed'|'cancelled'|'interrupted', priority, projectId,
 *                        payload: string, progress, stage, result, error, attempts,
 *                        maxAttempts, concurrencyKey, createdAt, startedAt, finishedAt }
 * ```
 * 注意：`TaskRecord` 的**权威定义**在 `src/shared/types.ts`（本文件直接复用，不重复声明），
 * 因为渲染进程 `task:list` 返回的就是它。
 */

import type { TaskKind, TaskProgressEvent, TaskRecord, TaskStatus } from '../../../shared/types.ts'

export type { TaskKind, TaskProgressEvent, TaskRecord, TaskStatus }

/** 任务上下文：任务实现者唯一能接触到的运行时能力（docs/04 §2.3） */
export interface TaskContext {
  taskId: string
  kind: TaskKind
  projectId: string | null
  /** 第几次尝试（1 起） */
  attempt: number
  /** 贯穿式取消信号：任务必须在关键点检查它（docs/04 §2.2「取消」） */
  signal: AbortSignal
  /** 本任务专属临时目录（结束/取消时由队列清理） */
  tempDir: string
  /**
   * 上报进度。队列会**节流到 ≤10 次/秒**再推给渲染进程
   * （docs/04 §2.2「进度」、docs/20 §4.11「≤ 10/s」）。
   */
  report(progress: number, stage?: string): void
  /** 若已取消则抛 `TASK_CANCELLED`（不是 Error，UI 不会弹提示） */
  throwIfAborted(): void
  /** 是否已取消（不抛错的轻量检查） */
  isAborted(): boolean
  /** 结构化日志（自动带上 taskId/kind） */
  log: (event: string, fields?: Record<string, unknown>) => void
}

/** 任务定义（docs/04 §2.3 模板） */
export interface TaskSpec<TPayload = unknown, TResult = unknown> {
  kind: TaskKind
  /**
   * 并发键（docs/04 §2.2 并发控制）：同 key 互斥/限量。
   * 常用值：`ffmpeg`（min(4, cores-1)）、`whisper`（1）、`embedding`（1）、`db-write`（1）。
   */
  concurrencyKey?: string | null
  /** 默认优先级：用户交互触发 = 0，后台维护 = 100；越小越先（docs/04 §2.2） */
  priority?: number
  /** 最大尝试次数（含首次）。默认 1 = 不重试。 */
  maxAttempts?: number
  /**
   * 幂等键（docs/04 §2.2「幂等」）：如 `audio.process:{segmentId}:{presetHash}`。
   * 返回相同值的活动任务会被复用（`enqueue` 直接返回已有 taskId）。
   */
  dedupeKey?: (payload: TPayload) => string | null | undefined
  /** 任务体。**必须**在长循环里 `ctx.throwIfAborted()` 并清理临时文件。 */
  run: (ctx: TaskContext, payload: TPayload) => Promise<TResult> | TResult
  /** 取消时的额外清理（临时文件等）。抛错只记日志，不影响取消结果。 */
  onCancel?: (ctx: TaskContext) => void | Promise<void>
}

/** 队列 → 渲染进程的事件出口（生产实现见 ipc/events.ts） */
export interface QueueEventSink {
  progress: (e: TaskProgressEvent) => void
  finished: (e: { taskId: string; status: TaskStatus; result?: unknown; error?: unknown }) => void
}

/** 队列的日志出口（与 infra/log 的 Logger 结构兼容） */
export interface QueueLogSink {
  info: (event: string, fields: Record<string, unknown>) => void
  warn: (event: string, fields: Record<string, unknown>) => void
  error: (event: string, fields: Record<string, unknown>) => void
}
