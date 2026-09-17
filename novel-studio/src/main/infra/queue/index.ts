/**
 * 基础设施 · 任务队列出口
 * ============================================================================
 * 见 docs/04 §2。装配点：bootstrap/app-lifecycle.ts（注入 sqlite 版 TaskStore）。
 */

export { ProgressThrottle, TaskQueue, defaultConcurrencyCaps } from './queue.ts'
export type { EnqueueOptions, EnqueueResult, TaskQueueOptions } from './queue.ts'

export {
  ACTIVE_TASK_STATUSES,
  ALL_TASK_STATUSES,
  FINISHED_TASK_STATUSES,
  createMemoryTaskStore,
} from './store.ts'
export type { TaskListFilter, TaskStore } from './store.ts'

export type {
  QueueEventSink,
  QueueLogSink,
  TaskContext,
  TaskKind,
  TaskProgressEvent,
  TaskRecord,
  TaskSpec,
  TaskStatus,
} from './types.ts'

export { delay, yieldTimes, yieldToLoop } from './yield.ts'
