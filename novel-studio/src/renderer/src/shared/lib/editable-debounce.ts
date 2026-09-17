/**
 * Novel Studio · 编辑防抖 + 乐观 UI + 失败回滚
 * ============================================================================
 * 设计依据：
 *   · docs/11 §4.9 自动保存与冲突 ——
 *       「文本编辑：防抖 500 ms 写库（乐观 UI）」「标记编辑：立即写库」
 *       「失败处理：写库失败 → 顶部红条『保存失败，你的修改仍在内存中』+ 重试按钮
 *         （**不能让用户以为存上了**）」
 *   · docs/11 §4.8 —— 编辑立即进内存 + 进撤销栈，防抖后批量写库；
 *       Ctrl+S 与切换章节时强制落库。
 *
 * 为什么要在业务组件外面再包一层：
 *   画本表格、角色表、混音台、预设编辑器……每个地方都要「改了立刻显示 → 稍后落库 →
 *   失败要看得见」。如果每处各写一遍 setTimeout + try/catch，必然出现：
 *     · 有的地方失败静默（用户以为存上了）；
 *     · 有的地方每次按键都发一次 IPC（把主进程打满）；
 *     · 切页面时把未落库的改动丢了。
 *   所以统一收敛到这里：**状态机 + 定时器 + 失败重试 + 冲刷**。
 *
 * 本文件**不依赖 vue / element-plus**（只用注入的回调），原因有二：
 *   1. 纯函数状态机才好测、才能在 Worker 侧复用；
 *   2. 组件用 `useEditableField`（在 shared/lib/use-editable-field.ts）包一层拿响应式状态。
 */

/** 落库回调：返回规范化后的值（主进程可能回填 rev / updatedAt，因此以返回值为准） */
export type WriteFn<T> = (value: T) => Promise<T>

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface EditableFieldHooks<T> {
  /** 写入器：调用 IPC（内部必须走 shared/lib/ipc.ts 的 call） */
  write: WriteFn<T>
  /** 防抖间隔（毫秒）。文本编辑默认 500（docs/11 §4.9）；下拉/开关类应传 0（立即写） */
  delayMs?: number
  /** 本地值变化（乐观 UI 已经在内存里生效，这里用于同步 store / 撤销栈） */
  onLocalChange?: (value: T, meta: { reason: 'set' | 'rollback' | 'reset' }) => void
  /** 写库成功（拿到主进程返回值） */
  onSaved?: (value: T) => void
  /** 写库失败：组件通常把错误交给 error-bus（本文件不弹提示，避免二次兑现） */
  onError?: (error: unknown, pendingValue: T) => void
  /** 状态变化（AutoSaveIndicator 用它显示三态） */
  onStatusChange?: (status: SaveStatus) => void
  /** 相等的判定（避免同一个值反复触发写库，如光标移动触发的 change 事件） */
  equals?: (a: T, b: T) => boolean
  /** 现在时间（可注入，便于测试） */
  now?: () => number
}

export interface EditableFieldState<T> {
  /** 内存中的当前值（乐观 UI 生效后的值） */
  value: T
  /** 最后一次成功落库的值 */
  persisted: T
  status: SaveStatus
  /** 最近一次失败的错误（成功后清空） */
  lastError: unknown
  /** 还有几次重试机会（写失败时按 retryLimit 设置） */
  retriesLeft: number
  /** 未落库的改动是否还在（组件用它决定是否拦截「切换章节」） */
  dirty: boolean
}

const DEFAULTS = {
  delayMs: 500,
  /** 重试次数：失败后用户可点「重试」，也允许自动重试一次网络类抖动 */
  retryLimit: 1,
}

function defaultEquals<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

/**
 * 可编辑字段控制器（与框架无关）。
 *
 * 关键语义：
 *   · `set(value)` 立即改内存值（乐观 UI），并按 `delayMs` 排一次写库；
 *   · `flush()` 立刻写库（Ctrl+S、切换章节、卸载前调用）；
 *   · `revert()` 回滚到「最后一次落库成功」的值（用于明确的失败回滚）；
 *   · 失败**不回滚**（docs/11 §4.9：改动仍在内存中，必须让用户知道，而不是偷偷丢掉）；
 *   · `dispose()` 停掉定时器；若还有脏数据，会先 flush 一次（尽力而为）。
 */
export class EditableField<T> {
  private readonly hooks: EditableFieldHooks<T>
  private readonly delayMs: number
  private readonly retryLimit: number
  private readonly equals: (a: T, b: T) => boolean
  private readonly now: () => number

  private current: T
  private persistedValue: T
  private statusValue: SaveStatus = 'idle'
  private errorValue: unknown = null
  private retries = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> | null = null
  /** 写库期间又发生的新改动：写完后必须再写一次，否则最后一次编辑会丢 */
  private pendingAfterInflight = false
  private disposed = false
  private lastSavedAt: number | null = null

  constructor(initial: T, hooks: EditableFieldHooks<T>) {
    this.current = initial
    this.persistedValue = initial
    this.hooks = hooks
    this.delayMs = Math.max(0, hooks.delayMs ?? DEFAULTS.delayMs)
    this.retryLimit = Math.max(0, DEFAULTS.retryLimit)
    this.retries = this.retryLimit
    this.equals = hooks.equals ?? defaultEquals
    this.now = hooks.now ?? (() => Date.now())
  }

  get state(): EditableFieldState<T> {
    return {
      value: this.current,
      persisted: this.persistedValue,
      status: this.statusValue,
      lastError: this.errorValue,
      retriesLeft: this.retries,
      dirty: !this.equals(this.current, this.persistedValue),
    }
  }

  /** 最近一次成功落库的时间（AutoSaveIndicator 显示「已保存 12:03」） */
  get savedAt(): number | null {
    return this.lastSavedAt
  }

  /** 乐观更新：立即改内存值，并安排一次写库 */
  set(value: T): void {
    if (this.disposed) return
    if (this.equals(value, this.current)) return // 光标移动等空事件：不算改动
    this.current = value
    this.hooks.onLocalChange?.(value, { reason: 'set' })

    if (this.delayMs === 0) {
      void this.flush()
      return
    }
    this.setStatus('dirty')
    this.schedule()
  }

  /** 修改函数式便捷入口 */
  update(updater: (prev: T) => T): void {
    this.set(updater(this.current))
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.delayMs)
  }

  /**
   * 立即写库。返回的 Promise 在本次写入（含写期间追加的改动）结束后 resolve。
   * 失败**不会 reject**：错误已通过 onError 上抛给调用方兑现（避免 unhandledrejection 再报一次）。
   */
  async flush(): Promise<void> {
    if (this.disposed && !this.state.dirty) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.inflight) {
      this.pendingAfterInflight = true
      return this.inflight
    }

    if (this.equals(this.current, this.persistedValue)) {
      if (this.statusValue === 'dirty') this.setStatus('saved')
      return
    }

    const snapshot = this.current
    this.setStatus('saving')

    this.inflight = (async () => {
      try {
        const saved = await this.hooks.write(snapshot)
        // 主进程可能回填 rev/updatedAt；但**不能**覆盖用户在写库期间的新编辑
        this.persistedValue = saved
        if (this.equals(this.current, snapshot)) {
          this.current = saved
          this.hooks.onLocalChange?.(saved, { reason: 'set' })
        }
        this.errorValue = null
        this.retries = this.retryLimit
        this.lastSavedAt = this.now()
        this.setStatus('saved')
        this.hooks.onSaved?.(saved)
      } catch (error) {
        this.errorValue = error
        this.retries = Math.max(0, this.retries - 1)
        // 故意不回滚：docs/11 §4.9 要求「改动仍在内存中」对用户可见
        this.setStatus('error')
        this.hooks.onError?.(error, this.current)
      } finally {
        this.inflight = null
      }
    })()

    await this.inflight
    if (this.pendingAfterInflight) {
      this.pendingAfterInflight = false
      await this.flush()
    }
  }

  /** 明确回滚到已落库的值（用于「放弃修改」按钮） */
  revert(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.current = this.persistedValue
    this.errorValue = null
    this.setStatus('idle')
    this.hooks.onLocalChange?.(this.current, { reason: 'rollback' })
  }

  /** 外部数据被替换（切换章节、重新加载）——不留脏标记、不写库 */
  reset(value: T): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.current = value
    this.persistedValue = value
    this.errorValue = null
    this.retries = this.retryLimit
    this.setStatus('idle')
    this.hooks.onLocalChange?.(value, { reason: 'reset' })
  }

  /** 手动重试（错误提示上的「重试」按钮接这里） */
  async retry(): Promise<void> {
    if (this.equals(this.current, this.persistedValue)) return
    await this.flush()
  }

  /** 释放：停表并尽力冲刷一次未落库的改动（组件卸载/切路由时调用） */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.disposed = true
    if (!this.equals(this.current, this.persistedValue)) {
      // 不 await：调用方（onBeforeUnmount）同步返回，但写请求已经发出
      void this.flush()
    }
  }

  private setStatus(status: SaveStatus): void {
    if (this.statusValue === status) return
    this.statusValue = status
    this.hooks.onStatusChange?.(status)
  }
}

/** 工厂（语义更清晰：`createEditableField(line.text, { write })`） */
export function createEditableField<T>(initial: T, hooks: EditableFieldHooks<T>): EditableField<T> {
  return new EditableField(initial, hooks)
}

/**
 * 独立防抖函数（不涉及落库的场景：搜索框、筛选条件、预览重算）。
 * 带 `flush` 与 `cancel`，与 EditableField 的语义保持一致。
 */
export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void
  flush(): void
  cancel(): void
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): DebouncedFn<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: A | null = null

  const wrapped = ((...args: A) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const callArgs = lastArgs
      lastArgs = null
      if (callArgs) fn(...callArgs)
    }, Math.max(0, delayMs))
  }) as DebouncedFn<A>

  wrapped.flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const callArgs = lastArgs
    lastArgs = null
    if (callArgs) fn(...callArgs)
  }
  wrapped.cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    lastArgs = null
  }

  return wrapped
}

/**
 * 批处理队列：把「N 次改动」合并成一次 IPC（docs/11 §4.7 批量操作 = 一个事务写库）。
 * `add` 后按 `flushMs` 合并；`flush()` 立即提交；提交期间到达的条目进下一批。
 */
export function createBatchQueue<T>(
  commit: (batch: T[]) => Promise<void>,
  options: { flushMs?: number; maxBatch?: number; onError?: (e: unknown) => void } = {},
): {
  add: (item: T) => void
  flush: () => Promise<void>
  size: () => number
  cancel: () => void
} {
  const flushMs = Math.max(0, options.flushMs ?? 200)
  const maxBatch = Math.max(1, options.maxBatch ?? 500)
  let queue: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const run = async (): Promise<void> => {
    if (inflight) {
      await inflight
      return
    }
    if (!queue.length) return
    const batch = queue.splice(0, maxBatch)
    inflight = (async () => {
      try {
        await commit(batch)
      } catch (error) {
        options.onError?.(error)
      } finally {
        inflight = null
      }
    })()
    await inflight
    if (queue.length) await run()
  }

  return {
    add(item: T): void {
      queue.push(item)
      if (queue.length >= maxBatch) {
        void run()
        return
      }
      if (!timer) timer = setTimeout(() => { timer = null; void run() }, flushMs)
    },
    async flush(): Promise<void> {
      clearTimer()
      await run()
    },
    size: () => queue.length,
    cancel(): void {
      clearTimer()
      queue = []
    },
  }
}
