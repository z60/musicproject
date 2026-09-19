/**
 * 基础设施 · 任务队列
 * ============================================================================
 * 设计依据：docs/04 §2.2「设计」——下面每一项都是硬要求，不是可选项。
 *
 * | 机制 | 实现 |
 * |------|------|
 * | 并发控制 | 每个 concurrencyKey 独立上限：ffmpeg: min(4, cores-1)、whisper: 1、
 * |          | embedding: 1（避免 OOM）、db-write: 1 |
 * | 优先级   | 用户直接触发的任务（0）优先于自动后台任务（100）；越小越先 |
 * | 进度     | ctx.report(progress, stage)，节流到 ≤10 次/秒再推给渲染进程 |
 * | 取消     | AbortController 贯穿 ctx.signal；任务必须在关键点检查并清理临时文件 |
 * | 重试     | 仅 retryable 错误自动重试；指数退避 1s/4s；取消类错误永不重试 |
 * | 持久化   | 任务写库；启动时把 running/waiting 标记为 interrupted |
 * | 幂等     | dedupeKey 相同的活动任务直接返回已有 taskId |
 *
 * 第一版就写队列的理由（docs/04 §2.1）：导入、判定、转写、处理、渲染、导出
 * 全是秒级到小时级操作，且**可能被连点并发触发**。没有统一队列就会出现
 * 「同时跑 8 个 ffmpeg 把机器打满」这类问题，而这类问题一旦出现在用户现场，
 * 排查成本极高。
 */

import { randomBytes } from 'node:crypto'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppError, toSerialized, wrapUnknown } from '../../../shared/errors.ts'
import type { MessageKey } from '../../../shared/messages.ts'
import type { TaskProgressEvent, TaskRecord, TaskStatus } from '../../../shared/types.ts'
import { DEFAULT_RETRY_DELAYS_MS, isRetryableError, retryDelayMs } from '../errors/retry.ts'
import { ACTIVE_TASK_STATUSES, FINISHED_TASK_STATUSES, createMemoryTaskStore, type TaskListFilter, type TaskStore } from './store.ts'
import type { QueueEventSink, QueueLogSink, TaskContext, TaskSpec } from './types.ts'
import { delay } from './yield.ts'

export { createMemoryTaskStore } from './store.ts'
export type { TaskListFilter, TaskStore, TaskListFilter as TaskFilter } from './store.ts'

// ---------------------------------------------------------------------------
// 并发上限
// ---------------------------------------------------------------------------

/** 默认并发上限（docs/04 §2.2 / §6） */
export function defaultConcurrencyCaps(cores = Math.max(1, cpus().length)): Record<string, number> {
  return {
    // 编码很吃 CPU，占满会让 UI 卡：min(4, cores - 1)
    ffmpeg: Math.min(4, Math.max(1, cores - 1)),
    // whisper 模型常驻数百 MB，串行
    whisper: 1,
    // ONNX 会话避免 OOM
    embedding: 1,
    // better-sqlite3 是同步 API，写必须串行
    'db-write': 1,
  }
}

/** 无并发键时的桶名（统计用） */
const NO_KEY = '__default__'

// ---------------------------------------------------------------------------
// 进度节流
// ---------------------------------------------------------------------------

/**
 * 进度节流器：每个任务独立计时，**保证 1 秒内最多 10 次**上报（docs/04 §2.2）。
 *
 * 丢弃中间值是有意为之：进度事件只是 UI 的近似显示，而高频推送会让渲染进程
 * 在长任务里不停重排（导入 10 万行时会明显掉帧）。
 * 最终值由任务完成时的补发 + `task:finished` 兜底，因此**不会丢失终态**。
 */
export class ProgressThrottle {
  private lastEmitAt = Number.NEGATIVE_INFINITY
  private readonly intervalMs: number
  private dropped = 0

  constructor(intervalMs = 100) {
    this.intervalMs = Math.max(1, intervalMs)
  }

  /** 是否允许此刻上报（允许则记录时间） */
  tryAcquire(now: number): boolean {
    if (now - this.lastEmitAt >= this.intervalMs) {
      this.lastEmitAt = now
      this.dropped = 0
      return true
    }
    this.dropped++
    return false
  }

  /** 被丢弃的次数（诊断用） */
  get droppedCount(): number {
    return this.dropped
  }
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

export interface TaskQueueOptions {
  store?: TaskStore
  specs: ReadonlyArray<TaskSpec<never, unknown>> | ReadonlyArray<TaskSpec<unknown, unknown>>
  events?: QueueEventSink
  log?: QueueLogSink
  now?: () => number
  /** 并发上限覆盖（默认见 defaultConcurrencyCaps） */
  caps?: Record<string, number>
  cores?: number
  /** 全局同时在跑的任务数上限（默认不限，只按 concurrencyKey 限） */
  maxConcurrent?: number
  /** 队列长度上限：超出抛 TASK_QUEUE_FULL */
  maxQueueSize?: number
  /** 任务临时目录根（默认 os.tmpdir()/novel-studio-tasks） */
  tempRoot?: string
  /** 重试退避序列（默认 [1000, 4000]） */
  retryDelaysMs?: readonly number[]
  /** 进度节流窗口（默认 100ms = ≤10 次/秒） */
  progressIntervalMs?: number
  /** 注入 sleep（测试里替换掉真实等待） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 注入 id 生成（默认 24 位十六进制） */
  makeId?: () => string
  /** 注入临时目录创建（默认 mkdtemp） */
  makeTempDir?: (taskId: string) => Promise<string>
  /** 注入临时目录清理（默认递归删除） */
  removeTempDir?: (dir: string) => Promise<void>
  /** waitFor 的超时（默认 30s，避免测试挂死） */
  waitTimeoutMs?: number
}

export interface EnqueueOptions {
  priority?: number
  projectId?: string | null
  dedupeKey?: string | null
  maxAttempts?: number
}

export interface EnqueueResult {
  taskId: string
  /** true = 命中既有活动任务（dedupeKey 幂等），没有新建 */
  deduped: boolean
}

interface QueueEntry {
  record: TaskRecord
  payload: unknown
  spec: TaskSpec<unknown, unknown>
}

interface RunningEntry extends QueueEntry {
  controller: AbortController
  context: TaskContext
  tempDir: string
  done: Promise<void>
}

/**
 * 任务队列。
 *
 * ```ts
 * const queue = new TaskQueue({ specs: [importBookTask], store: sqliteTaskStore })
 * const { interrupted } = await queue.start()   // 含「running/waiting → interrupted」
 * const { taskId } = await queue.enqueue('book.import', payload, { priority: 0 })
 * await queue.whenIdle()                        // 或订阅 task:finished
 * ```
 */
export class TaskQueue {
  private readonly specs = new Map<string, TaskSpec<unknown, unknown>>()
  private readonly pending = new Map<string, QueueEntry>()
  private readonly running = new Map<string, RunningEntry>()
  /** 退避等待中的任务（已释放并发槽，但仍属于队列） */
  private readonly backoff = new Map<string, QueueEntry>()
  /** 退避期间被取消的任务 id（定时器到点后不得复活） */
  private readonly cancelledWhileBackoff = new Set<string>()
  /** 本会话内保留 payload，用于 task:retry */
  private readonly payloadCache = new Map<string, { payload: unknown; kind: string; opts: EnqueueOptions }>()

  private readonly caps: Record<string, number>
  private readonly store: TaskStore
  private readonly events?: QueueEventSink
  private readonly logSink?: QueueLogSink
  private readonly now: () => number
  private readonly maxConcurrent: number
  private readonly maxQueueSize: number
  private readonly tempRoot: string
  private readonly retryDelays: readonly number[]
  private readonly progressIntervalMs: number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly makeIdFn: () => string
  private readonly makeTempDirFn: (taskId: string) => Promise<string>
  private readonly removeTempDirFn: (dir: string) => Promise<void>
  private readonly waitTimeoutMs: number

  private pumpScheduled = false
  private pumping = false
  private pumpAgain = false
  private idleWaiters: Array<() => void> = []
  private disposed = false

  constructor(opts: TaskQueueOptions) {
    for (const spec of opts.specs) this.specs.set(spec.kind, spec as TaskSpec<unknown, unknown>)
    this.store = opts.store ?? createMemoryTaskStore()
    this.events = opts.events
    this.logSink = opts.log
    this.now = opts.now ?? Date.now
    this.caps = { ...defaultConcurrencyCaps(opts.cores), ...(opts.caps ?? {}) }
    this.maxConcurrent = opts.maxConcurrent ?? Number.POSITIVE_INFINITY
    this.maxQueueSize = opts.maxQueueSize ?? 500
    this.tempRoot = opts.tempRoot ?? join(tmpdir(), 'novel-studio-tasks')
    this.retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.progressIntervalMs = opts.progressIntervalMs ?? 100
    this.sleepFn = opts.sleep ?? delay
    this.waitTimeoutMs = opts.waitTimeoutMs ?? 30_000
    this.makeIdFn = opts.makeId ?? (() => randomBytes(12).toString('hex'))
    this.makeTempDirFn = opts.makeTempDir ?? (async (taskId) => {
      const { mkdir, mkdtemp } = await import('node:fs/promises')
      // **必须先确保临时根目录存在**（幂等）。
      //
      // 真机后果（实测复现）：`tempRoot` 是 `cacheDir/tasks`，而启动流程里
      // **没有任何一步创建过它**（`cacheDir` 本身也可能不存在）。
      // `mkdtemp` 遇到不存在的父目录直接抛 ENOENT，被错误体系翻成
      // `FILE_NOT_FOUND · 文件不存在` —— 于是**每一个任务**（导入、生成画本…）
      // 都以一句毫无指向性的「文件不存在」失败。
      // 这一层是 tempRoot 的拥有者，所以在这里兜底最合适：调用方不需要记得建目录。
      await mkdir(this.tempRoot, { recursive: true })
      return mkdtemp(join(this.tempRoot, `task-${taskId.slice(0, 8)}-`))
    })
    this.removeTempDirFn = opts.removeTempDir ?? (async (dir) => {
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true })
    })
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  /**
   * 启动队列：**先把上次残留的 running/waiting 标记为 interrupted**
   * （docs/04 §2.2「持久化」、docs/01 §11「强制关闭后下次启动走恢复恢复」）。
   * 必须在任何 enqueue 之前完成，否则新任务会和「幽灵任务」抢占并发槽。
   */
  async start(): Promise<{ interrupted: number }> {
    const interrupted = await this.markInterrupted()
    this.schedulePump()
    return { interrupted }
  }

  /**
   * 注册（或替换）一个任务定义。
   *
   * ### 为什么需要它（而不是只靠构造函数传 specs）
   *   域服务（如 `book.service.ts`）的任务定义需要**闭包捕获自己的依赖**，
   *   而队列又要在域服务之前建好（服务需要 queue 引用来 enqueue）——
   *   两者互相依赖。构造期一次性传入无法表达这个关系。
   *
   *   因此：先用空 specs 建队列 → 建服务（把 queue 传进去）→
   *   服务把自己的 specs 注册回来。这样没有初始化顺序的循环。
   *
   * 同 kind 重复注册会**替换**（后注册者生效），并记一条 warn —— 静默替换会让
   * 「哪个实现真的在跑」变得不可知。
   */
  registerSpec(spec: TaskSpec<unknown, unknown>): void {
    if (this.specs.has(spec.kind)) {
      this.log('warn', 'task.spec.replaced', { event: 'task.spec.replaced', kind: spec.kind })
    }
    this.specs.set(spec.kind, spec)
  }

  /** 把库里遗留的 running/waiting 标记为 interrupted（返回处理条数） */
  async markInterrupted(): Promise<number> {
    const stale = await this.store.loadByStatus(['running', 'waiting'])
    let count = 0
    for (const rec of stale) {
      if (this.running.has(rec.id)) continue // 本进程正在跑的不误标
      await this.store.update(rec.id, { status: 'interrupted', finishedAt: rec.finishedAt ?? this.now() })
      this.payloadCache.delete(rec.id)
      count++
    }
    if (count > 0) this.log('warn', 'task.recover.interrupted', { event: 'task.recover.interrupted', count })
    return count
  }

  /**
   * 关闭：取消所有在跑任务（应用退出前调用，见 docs/01 §11）。
   *
   * **必须等每个在跑任务真正进入终态**，不能只发 abort 就返回：
   *   `cancel()` 对 running 任务只设置 abort 信号并立即返回 —— 任务在下一个
   *   检查点（`ctx.throwIfAborted()`）才会感知并落库终态。若 dispose 不等，
   *   调用方随后查 `get(taskId)` 会看到 `running`，而应用可能已经退出，
   *   那些任务会以 `running` 状态留在库里直到下次启动才被标为 interrupted。
   *
   *   这是真实缺陷（由 tests/main/queue.test.ts 的 dispose 用例抓出）：
   *   早期实现 `for (id of running) await this.cancel(id)` 看似正确，
   *   实际 cancel 立刻返回，循环结束后任务仍在跑。
   *
   * 等待有上限（waitTimeoutMs），避免某个不检查 abort 的劣质任务让退出挂死。
   */
  async dispose(reason = 'app-quit'): Promise<void> {
    this.disposed = true

    // 先取出所有在跑任务的完成承诺 —— cancel 会改 running 映射，需先快照
    const runningDones = [...this.running.entries()].map(([id, entry]) => ({ id, done: entry.done }))

    for (const id of [...this.running.keys()]) await this.cancel(id, reason)

    // 等在跑任务真正落终态（带超时，不让退出无限挂起）
    //
    // 注意：超时计时器**必须清除**。用裸 `setTimeout` 做 race 会在任务早已完成后
    // 仍让事件循环等到超时才退出 —— 实测把一个 300ms 的测试拖成 30 秒。
    const waitWithTimeout = async (id: string, done: Promise<void>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          done.catch(() => undefined),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, this.waitTimeoutMs)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      // 兜底：超时仍未落终态的任务，强制标记为 cancelled，避免库里留 running
      const still = this.running.get(id)
      if (still) {
        this.running.delete(id)
        await this.finish(still.record, 'cancelled')
      }
    }

    await Promise.all(runningDones.map(({ id, done }) => waitWithTimeout(id, done)))

    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      await this.finish(entry.record, 'cancelled')
    }
    for (const [id] of [...this.backoff]) this.cancelledWhileBackoff.add(id)
    this.flushIdleWaiters()
  }

  // ── 入队 / 取消 / 重试 ───────────────────────────────────────────────────

  /**
   * 提交任务。
   *
   * · 有 `dedupeKey` 且已存在**活动**任务（queued/waiting/running）时直接返回该 taskId
   *   —— 这就是「用户连点两次『生成画本』只跑一次」的实现（docs/04 §2.2「幂等」）
   * · 队列已满抛 `TASK_QUEUE_FULL`
   */
  async enqueue(kind: string, payload: unknown, opts?: EnqueueOptions): Promise<EnqueueResult> {
    if (this.disposed) throw new AppError('TASK_FAILED', { details: { reason: 'queue-disposed', kind } })
    const spec = this.specs.get(kind)
    if (!spec) {
      throw new AppError('NOT_IMPLEMENTED', {
        params: { feature: `task:${kind}` },
        details: { kind, reason: 'unknown-task-kind' },
      })
    }

    // ── 幂等：同 dedupeKey 的活动任务直接复用 ──────────────────────────────
    const dedupeKey = opts?.dedupeKey ?? spec.dedupeKey?.(payload) ?? null
    if (dedupeKey) {
      const existing = await this.findActiveByDedupe(dedupeKey)
      if (existing) return { taskId: existing.id, deduped: true }
    }

    const inFlight = this.pending.size + this.running.size + this.backoff.size
    if (inFlight >= this.maxQueueSize) {
      throw new AppError('TASK_QUEUE_FULL', {
        params: { count: inFlight },
        details: { maxQueueSize: this.maxQueueSize, kind },
      })
    }

    const id = this.makeIdFn()
    const record: TaskRecord = {
      id,
      kind: kind as TaskRecord['kind'],
      status: 'queued',
      priority: opts?.priority ?? spec.priority ?? 50,
      projectId: opts?.projectId ?? null,
      progress: 0,
      stage: null,
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: opts?.maxAttempts ?? spec.maxAttempts ?? 1,
      concurrencyKey: spec.concurrencyKey ?? null,
      dedupeKey,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
    }
    await this.store.save(record)
    this.pending.set(id, { record, payload, spec })
    this.payloadCache.set(id, { payload, kind, opts: opts ?? {} })
    this.log('info', 'task.enqueued', { event: 'task.enqueued', taskId: id, taskKind: kind, priority: record.priority })
    this.schedulePump()
    return { taskId: id, deduped: false }
  }

  /**
   * 取消任务。
   * · running → abort 信号（任务在检查点感知），随后标记 `cancelled`
   * · queued/waiting/退避中 → 直接从队列移除并标记 `cancelled`
   * · 终态任务 → 返回 false（重复取消是幂等的，不报错）
   */
  async cancel(taskId: string, reason = 'user'): Promise<boolean> {
    const runningEntry = this.running.get(taskId)
    if (runningEntry) {
      runningEntry.controller.abort(new AppError('TASK_CANCELLED', { details: { reason } }))
      this.log('info', 'task.cancel.requested', { event: 'task.cancel.requested', taskId, reason })
      return true
    }
    const pend = this.pending.get(taskId)
    if (pend) {
      this.pending.delete(taskId)
      await this.finish(pend.record, 'cancelled')
      this.schedulePump()
      return true
    }
    const back = this.backoff.get(taskId)
    if (back) {
      this.backoff.delete(taskId)
      this.cancelledWhileBackoff.add(taskId)
      await this.finish(back.record, 'cancelled')
      this.schedulePump()
      return true
    }
    const rec = await this.get(taskId)
    if (!rec) throw new AppError('TASK_NOT_FOUND', { details: { taskId } })
    return false
  }

  /**
   * 重试：以同一 payload 重新入队（**新 taskId**；docs/20 §4.10 `task:retry` 返回 `{ taskId }`）。
   *
   * 限制：payload 只在本会话内保留。对**上次启动遗留**的 interrupted 任务无法重试
   * （库里只有 JSON，队列不反序列化任意 kind 的参数）→ 明确抛错并提示用户重新发起，
   * 而不是静默返回一个永远不跑的任务。
   */
  async retry(taskId: string): Promise<string> {
    const rec = await this.get(taskId)
    if (!rec) throw new AppError('TASK_NOT_FOUND', { details: { taskId } })
    const cached = this.payloadCache.get(taskId)
    if (!cached) {
      throw new AppError('TASK_FAILED', {
        details: {
          taskId,
          reason: 'payload-expired',
          hint: '该任务来自上一次运行，参数已不可用，请在界面上重新发起',
        },
      })
    }
    const { taskId: newId } = await this.enqueue(cached.kind, cached.payload, {
      ...cached.opts,
      dedupeKey: null, // 重试必须新建：否则会被自己的旧记录去重掉
    })
    return newId
  }

  // ── 查询 ───────────────────────────────────────────────────────────────

  async get(taskId: string): Promise<TaskRecord | null> {
    if (this.store.get) return (await this.store.get(taskId)) ?? null
    const all = await this.store.loadByStatus([...ACTIVE_TASK_STATUSES, ...FINISHED_TASK_STATUSES])
    return all.find((r) => r.id === taskId) ?? null
  }

  async list(filter?: TaskListFilter): Promise<TaskRecord[]> {
    if (this.store.list) return this.store.list(filter)
    const rows = await this.store.loadByStatus([...ACTIVE_TASK_STATUSES, ...FINISHED_TASK_STATUSES])
    let out = rows
    if (filter?.status?.length) {
      const wanted = new Set(filter.status)
      out = out.filter((r) => wanted.has(r.status))
    }
    if (filter?.kind?.length) {
      const kinds = new Set(filter.kind)
      out = out.filter((r) => kinds.has(r.kind))
    }
    out = [...out].sort((a, b) => a.createdAt - b.createdAt)
    return filter?.limit !== undefined ? out.slice(0, filter.limit) : out
  }

  /** 取任务结果（`task:result` 通道）；未成功时抛 TASK_FAILED 并说明当前状态 */
  async result(taskId: string): Promise<unknown> {
    const rec = await this.get(taskId)
    if (!rec) throw new AppError('TASK_NOT_FOUND', { details: { taskId } })
    if (rec.status === 'succeeded') return rec.result
    throw new AppError('TASK_FAILED', {
      details: { taskId, status: rec.status, reason: 'task-not-succeeded', error: rec.error },
    })
  }

  /** 清理终态任务，返回清理条数（`task:clearFinished`） */
  async clearFinished(): Promise<number> {
    const rows = await this.store.loadByStatus(FINISHED_TASK_STATUSES)
    const ids = rows.map((r) => r.id).filter((id) => !this.running.has(id))
    if (ids.length === 0) return 0
    if (this.store.remove) await this.store.remove(ids)
    else for (const id of ids) await this.store.update(id, { status: 'interrupted' })
    for (const id of ids) this.payloadCache.delete(id)
    return ids.length
  }

  /** 运行中/排队中的数量（诊断面板用） */
  stats(): { running: number; pending: number; backoff: number; byKey: Record<string, number> } {
    const byKey: Record<string, number> = {}
    for (const e of this.running.values()) {
      const key = e.record.concurrencyKey ?? NO_KEY
      byKey[key] = (byKey[key] ?? 0) + 1
    }
    return { running: this.running.size, pending: this.pending.size, backoff: this.backoff.size, byKey }
  }

  /** 等待队列空闲（全部任务进入终态） */
  whenIdle(): Promise<void> {
    if (this.pending.size === 0 && this.running.size === 0 && this.backoff.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /** 等待某个任务进入终态（超时抛 TASK_FAILED，避免调用方无限挂起） */
  async waitFor(taskId: string, timeoutMs = this.waitTimeoutMs): Promise<TaskRecord> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const rec = await this.get(taskId)
      if (!rec) throw new AppError('TASK_NOT_FOUND', { details: { taskId } })
      if ((FINISHED_TASK_STATUSES as readonly string[]).includes(rec.status)) return rec
      const entry = this.running.get(taskId)
      if (entry) {
        await entry.done
        continue
      }
      if (Date.now() > deadline) {
        throw new AppError('TASK_FAILED', { details: { taskId, reason: 'wait-timeout', status: rec.status } })
      }
      await new Promise<void>((r) => setImmediate(r))
    }
  }

  // ── 调度 ───────────────────────────────────────────────────────────────

  private schedulePump(): void {
    if (this.pumpScheduled) return
    this.pumpScheduled = true
    setImmediate(() => {
      this.pumpScheduled = false
      void this.pump()
    })
  }

  /**
   * 调度循环：按「优先级升序 → 创建时间升序」挑可运行的任务。
   *
   * 被并发上限挡住的任务标记为 `waiting`（UI 显示「排队中」），但**继续尝试下一个候选**
   * —— 这是「ffmpeg 槽被占满时不影响导入任务」的关键（work-conserving 调度）。
   *
   * 用 `pumping` 互斥：调度过程中有 await（写库），并发进入会导致同一任务被启动两次。
   */
  private async pump(): Promise<void> {
    if (this.disposed) return
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      for (;;) {
        if (this.running.size >= this.maxConcurrent) break
        // 原 const now = this.now() 未使用；排序时间基准由 record.createdAt 承担
        const candidates = [...this.pending.values()]
          .sort((a, b) => a.record.priority - b.record.priority || a.record.createdAt - b.record.createdAt)
        if (candidates.length === 0) break

        let picked: QueueEntry | null = null
        for (const cand of candidates) {
          const key = cand.record.concurrencyKey
          if (!key) {
            picked = cand
            break
          }
          const limit = this.caps[key] ?? 1
          if (this.countRunningWithKey(key) < limit) {
            picked = cand
            break
          }
          // 被并发上限挡住 → 标记 waiting（持久化，UI 可见）
          if (cand.record.status !== 'waiting') {
            cand.record.status = 'waiting'
            await this.store.update(cand.record.id, { status: 'waiting' })
          }
        }
        if (!picked) break
        this.pending.delete(picked.record.id)
        await this.startTask(picked)
      }
    } finally {
      this.pumping = false
      this.flushIdleWaiters()
      if (this.pumpAgain) {
        this.pumpAgain = false
        this.schedulePump()
      }
    }
  }

  private countRunningWithKey(key: string): number {
    let n = 0
    for (const e of this.running.values()) if ((e.record.concurrencyKey ?? NO_KEY) === key) n++
    return n
  }

  private async startTask(entry: QueueEntry): Promise<void> {
    const { record, payload, spec } = entry
    const attempt = record.attempts + 1
    const controller = new AbortController()
    const throttle = new ProgressThrottle(this.progressIntervalMs)

    let tempDir: string
    try {
      tempDir = await this.makeTempDirFn(record.id)
    } catch (e) {
      // 临时目录建不起来（磁盘满/权限）→ 不进入任务体，直接失败
      await this.finish(record, 'failed', undefined, wrapUnknown(e, 'DISK_FULL' as MessageKey))
      this.schedulePump()
      return
    }

    const context: TaskContext = {
      taskId: record.id,
      kind: record.kind,
      projectId: record.projectId,
      attempt,
      signal: controller.signal,
      tempDir,
      report: (progress: number, stage?: string) => {
        const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0))
        record.progress = clamped
        if (stage !== undefined) record.stage = stage
        // 节流：≤10 次/秒（docs/04 §2.2）
        if (!throttle.tryAcquire(this.now())) return
        void this.store.update(record.id, { progress: clamped, stage: record.stage })
        this.emitProgress(record)
      },
      throwIfAborted: () => {
        if (controller.signal.aborted) {
          throw new AppError('TASK_CANCELLED', { details: { taskId: record.id, source: 'task-aborted' } })
        }
      },
      isAborted: () => controller.signal.aborted,
      log: (event: string, fields?: Record<string, unknown>) => {
        this.log('info', event, { event, taskId: record.id, taskKind: record.kind, ...(fields ?? {}) })
      },
    }

    // 先占住并发槽再启动任务体：任务体里的第一个 await 之前就可能被调度器重新进入
    let releaseDone: () => void = () => undefined
    const done = new Promise<void>((resolveDone) => {
      releaseDone = resolveDone
    })
    const runningEntry: RunningEntry = { record, payload, spec, controller, context, tempDir, done }
    this.running.set(record.id, runningEntry)

    const patch: Partial<TaskRecord> = {
      status: 'running',
      startedAt: record.startedAt ?? this.now(),
      attempts: attempt,
      error: null, // 重试时清掉上次错误，避免 UI 显示「正在运行 + 上次失败」
    }
    Object.assign(record, patch)
    await this.store.update(record.id, patch)

    if (spec.onCancel) {
      controller.signal.addEventListener(
        'abort',
        () => {
          const invoke = (): void => {
            try {
              void Promise.resolve(spec.onCancel?.(context)).catch((e) => {
                this.log('warn', 'task.onCancel.failed', { event: 'task.onCancel.failed', taskId: record.id, reason: String(e) })
              })
            } catch (e) {
              this.log('warn', 'task.onCancel.failed', { event: 'task.onCancel.failed', taskId: record.id, reason: String(e) })
            }
          }
          invoke()
        },
        { once: true },
      )
    }

    this.log('info', 'task.started', {
      event: 'task.started',
      taskId: record.id,
      taskKind: record.kind,
      attempt,
      priority: record.priority,
      concurrencyKey: record.concurrencyKey,
    })

    void (async () => {
      try {
        const result = await spec.run(context, payload)
        if (controller.signal.aborted) {
          // 任务体没检查 signal 就返回了：仍按取消处理（用户意图优先）
          await this.finish(record, 'cancelled')
          return
        }
        await this.finish(record, 'succeeded', result)
      } catch (e) {
        if (controller.signal.aborted || this.isCancelError(e)) {
          await this.finish(record, 'cancelled')
          return
        }
        const err = wrapUnknown(e, 'TASK_FAILED' as MessageKey)
        if (isRetryableError(err) && attempt < record.maxAttempts) {
          await this.scheduleRetry(record, payload, spec, attempt, err)
          return
        }
        await this.finish(record, 'failed', undefined, err)
      } finally {
        try {
          await this.removeTempDirFn(tempDir)
        } catch (e) {
          this.log('warn', 'task.temp.cleanup.failed', {
            event: 'task.temp.cleanup.failed',
            taskId: record.id,
            reason: String(e),
          })
        }
        this.running.delete(record.id)
        releaseDone()
        this.schedulePump()
      }
    })()
  }

  private async scheduleRetry(
    record: TaskRecord,
    payload: unknown,
    spec: TaskSpec<unknown, unknown>,
    attempt: number,
    err: unknown,
  ): Promise<void> {
    const waitMs = retryDelayMs(attempt, this.retryDelays)
    const appErr = wrapUnknown(err, 'TASK_FAILED' as MessageKey)
    // 先把任务从 running 挪到 backoff：**必须释放并发槽**，否则退避期间会白占一个槽
    this.running.delete(record.id)
    record.status = 'queued'
    record.error = JSON.stringify(toSerialized(appErr))
    this.backoff.set(record.id, { record, payload, spec })
    await this.store.update(record.id, { status: 'queued', error: record.error })
    this.log('warn', 'task.retry.scheduled', {
      event: 'task.retry.scheduled',
      taskId: record.id,
      taskKind: record.kind,
      attempt,
      waitMs,
      code: appErr.key,
    })
    void this.sleepFn(waitMs).then(() => {
      if (this.disposed) return
      const stillWaiting = this.backoff.get(record.id)
      if (!stillWaiting) return // 退避期间被取消
      this.backoff.delete(record.id)
      if (this.cancelledWhileBackoff.delete(record.id)) return
      this.pending.set(record.id, stillWaiting)
      this.schedulePump()
    })
  }

  /**
   * 结束任务：写终态 + 推 `task:finished`（docs/20 §7「不丢终态」）。
   * 事件推送失败绝不影响任务状态（错误处理路径本身永不抛错）。
   */
  private async finish(
    record: TaskRecord,
    status: Extract<TaskStatus, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    const patch: Partial<TaskRecord> = { status, finishedAt: this.now() }
    if (status === 'succeeded') {
      patch.progress = 1
      patch.result = (result ?? null) as TaskRecord['result']
      patch.error = null
    }
    if (error !== undefined) {
      const appErr = wrapUnknown(error, 'TASK_FAILED' as MessageKey)
      patch.error = JSON.stringify(toSerialized(appErr))
      // 失败原因落到 stage：UI 列表不展开详情也能看出问题
      patch.stage = appErr.message
    }
    Object.assign(record, patch)
    await this.store.update(record.id, patch)

    const event = {
      taskId: record.id,
      status,
      result: patch.result ?? undefined,
      error: patch.error ? JSON.parse(patch.error) : undefined,
    }
    try {
      this.events?.finished(event)
      // 终态进度补发一次：节流会丢掉中间 report，完成时补上最终值
      this.emitProgress(record)
    } catch (e) {
      this.log('warn', 'task.finished.emit.failed', {
        event: 'task.finished.emit.failed',
        taskId: record.id,
        reason: String(e),
      })
    }
    this.log(status === 'succeeded' ? 'info' : 'warn', `task.${status}`, {
      event: `task.${status}`,
      taskId: record.id,
      taskKind: record.kind,
      attempts: record.attempts,
      elapsedMs: record.startedAt ? this.now() - record.startedAt : null,
      ...(patch.error ? { code: (JSON.parse(patch.error) as { code: string }).code } : {}),
    })
  }

  private emitProgress(record: TaskRecord): void {
    const payload: TaskProgressEvent = {
      taskId: record.id,
      kind: record.kind,
      progress: record.progress,
      ...(record.stage ? { stage: record.stage } : {}),
      // etaMs 需要历史同类任务耗时；没有就给 undefined，UI 显示「计算中」而不是瞎猜（docs/04 §2.4）
    }
    try {
      this.events?.progress(payload)
    } catch {
      /* 推送失败不影响任务本体 */
    }
  }

  private isCancelError(e: unknown): boolean {
    if (!e || typeof e !== 'object') return false
    const name = (e as { name?: string }).name
    const key = (e as { key?: string }).key
    const code = (e as { code?: string }).code
    return name === 'AbortError' || code === 'ABORT_ERR' || code === 'ERR_CANCELED' || key === 'TASK_CANCELLED'
  }

  private async findActiveByDedupe(dedupeKey: string): Promise<TaskRecord | null> {
    for (const e of this.pending.values()) if (e.record.dedupeKey === dedupeKey) return e.record
    for (const e of this.running.values()) if (e.record.dedupeKey === dedupeKey) return e.record
    for (const e of this.backoff.values()) if (e.record.dedupeKey === dedupeKey) return e.record
    const rows = await this.store.loadByStatus(ACTIVE_TASK_STATUSES)
    return rows.find((r) => r.dedupeKey === dedupeKey) ?? null
  }

  private flushIdleWaiters(): void {
    if (this.pending.size > 0 || this.running.size > 0 || this.backoff.size > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) {
      try {
        w()
      } catch {
        /* 等待者自身抛错不能影响队列 */
      }
    }
  }

  private log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
    try {
      if (this.logSink) this.logSink[level](event, fields)
    } catch {
      /* 日志失败不影响队列 */
    }
  }
}
