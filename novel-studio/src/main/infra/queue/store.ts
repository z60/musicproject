/**
 * 基础设施 · 任务持久化端口
 * ============================================================================
 * 设计依据：docs/04 §2.2「持久化：任务写库，启动时把 running/waiting 标记为 interrupted」
 *
 * **为什么不直接依赖 better-sqlite3**：
 *   1. 环境无网络/无原生模块，队列的单测必须能在纯 Node 下跑；
 *   2. 队列只关心「存取任务记录」这一件事，把它抽成端口后，生产实现（tasks 表）
 *      与测试实现（内存）可以互换，队列本身不需要知道 SQL。
 *
 * 生产实现要点（`infra/db` + features 域下的 repositories/task.repo.ts）：
 *   · `save` → `INSERT INTO tasks(...)`
 *   · `update` → `UPDATE tasks SET ... WHERE id = ?`（只更新传入字段）
 *   · `loadByStatus` → `SELECT * FROM tasks WHERE status IN (...) ORDER BY priority, created_at`
 *   · 必须跑在 `concurrencyKey = 'db-write'` 的串行语义下（better-sqlite3 是同步 API）
 */

import type { TaskRecord, TaskStatus } from '../../../shared/types.ts'

export interface TaskListFilter {
  status?: readonly TaskStatus[]
  kind?: readonly string[]
  projectId?: string
  limit?: number
}

/**
 * 任务存储端口。
 *
 * 必填的三个方法对应 docs/04 §2.2 的三件事：写、改、按状态捞（启动恢复）。
 * 其余方法有默认降级实现（见 queue.ts 的 `storeGet` 等辅助函数），
 * 因此一个「最小实现」只写 save/update/loadByStatus 也能跑。
 */
export interface TaskStore {
  /** 新任务落库 */
  save(record: TaskRecord): void | Promise<void>
  /** 局部更新（只覆盖传入的字段） */
  update(id: string, patch: Partial<TaskRecord>): void | Promise<void>
  /** 按状态批量读取（启动恢复用） */
  loadByStatus(status: readonly TaskStatus[]): TaskRecord[] | Promise<TaskRecord[]>
  /** 可选：按 id 读取 */
  get?(id: string): TaskRecord | null | Promise<TaskRecord | null>
  /** 可选：列表（task:list 通道） */
  list?(filter?: TaskListFilter): TaskRecord[] | Promise<TaskRecord[]>
  /** 可选：删除（task:clearFinished 通道） */
  remove?(ids: readonly string[]): void | Promise<void>
}

/** 全部状态（loadByStatus 的降级路径需要它） */
export const ALL_TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'waiting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]

/** 活动状态：占着并发槽或等待调度（幂等去重只看这些） */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'waiting', 'running']

/** 终态：不会再变化，可以清理 */
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted']

/**
 * 内存任务存储（单测与「本会话临时队列」用）。
 *
 * 它**不是**生产实现：进程退出后任务记录就没了，重启的崩溃恢复需要 sqlite 版本。
 * 但语义与 sqlite 版完全一致（含深拷贝，防止调用方改到队列内部对象）。
 */
export function createMemoryTaskStore(initial?: readonly TaskRecord[]): TaskStore & { all(): TaskRecord[] } {
  const byId = new Map<string, TaskRecord>()
  for (const r of initial ?? []) byId.set(r.id, clone(r))

  const store: TaskStore & { all(): TaskRecord[] } = {
    save(record) {
      byId.set(record.id, clone(record))
    },
    update(id, patch) {
      const cur = byId.get(id)
      if (!cur) return
      byId.set(id, { ...cur, ...clone(patch) } as TaskRecord)
    },
    loadByStatus(status) {
      const wanted = new Set(status)
      return [...byId.values()].filter((r) => wanted.has(r.status)).map(clone)
    },
    get(id) {
      const r = byId.get(id)
      return r ? clone(r) : null
    },
    list(filter) {
      let rows = [...byId.values()]
      if (filter?.status?.length) {
        const wanted = new Set(filter.status)
        rows = rows.filter((r) => wanted.has(r.status))
      }
      if (filter?.kind?.length) {
        const kinds = new Set(filter.kind)
        rows = rows.filter((r) => kinds.has(r.kind))
      }
      if (filter?.projectId) rows = rows.filter((r) => r.projectId === filter.projectId)
      rows.sort((a, b) => a.createdAt - b.createdAt)
      if (filter?.limit !== undefined) rows = rows.slice(0, Math.max(0, filter.limit))
      return rows.map(clone)
    },
    remove(ids) {
      for (const id of ids) byId.delete(id)
    },
    all() {
      return [...byId.values()].map(clone)
    },
  }
  return store
}

function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v)) as T
}
