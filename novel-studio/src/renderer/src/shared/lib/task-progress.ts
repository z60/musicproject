/**
 * Novel Studio · 任务进度订阅（全应用唯一的任务事件消费点）
 * ============================================================================
 * 设计依据：
 *   · docs/01 §3.2 —— 「长任务进度统一由 useTaskProgress(taskId) 订阅，
 *     禁止每个功能自己写轮询」
 *   · docs/04 §2.4 —— 统一的任务进度卡（禁止每个功能自建进度 UI）
 *   · docs/20 §7 —— 事件与状态同步约定：**事件幂等**，
 *     「渲染进程按 taskId + progress 单调性去重」；`task:finished` 必须送达
 *   · docs/20 §6.1 —— progress 是 0~1 的小数（不是百分比）
 *
 * 为什么要有模块级注册表：
 *   同一个任务可能被多处观察（导出向导页 + 右下角进度坞 + 任务中心）。
 *   若各自 `on('task:progress')`，就会出现 3 个监听器、3 份状态、3 次 setState。
 *   这里把它收敛成：**一对全局监听器 + 一张 taskId → 状态表**，订阅者只是读引用。
 *
 * 单调性规则（docs/20 §7）：
 *   · 已进入终态（finished）的任务不再接受 progress 事件（迟到事件会污染 UI）；
 *   · `progress` 小于当前值的重复/乱序事件被丢弃；
 *   · `task:finished` 一定生效（哪怕 progress 倒退），并释放监听。
 */

import { computed, onScopeDispose, readonly, ref, unref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { on } from './ipc'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type TaskProgressStatus =
  | 'queued' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface TaskProgressState {
  taskId: string
  /** 任务类型（TASK_KIND_LABELS 里有中文标签） */
  kind: string
  /** 0~1 */
  progress: number
  /** 当前阶段文案（主进程给的，直接显示） */
  stage: string
  etaMs: number | null
  throughput: { unit: string; perSecond: number } | null
  status: TaskProgressStatus
  /** 终态错误（已序列化的 AppError 形状），由调用方决定是否兑现提示 */
  error: unknown
  result: unknown
  /** 首次出现时间 */
  startedAt: number
  /** 最近一次更新时间 */
  updatedAt: number
  /** 是否已进入终态 */
  finished: boolean
  /** 收到过的事件数（诊断用：排查「进度卡住不动」） */
  eventCount: number
  /** 进度是否倒退过（诊断用；为 true 说明主进程侧有乱序推送） */
  regressed: boolean
}

export interface TaskProgressView {
  state: ComputedRef<TaskProgressState | null>
  /** 0~1 */
  progress: ComputedRef<number>
  /** 0~100，取整（进度条直接用） */
  percent: ComputedRef<number>
  stage: ComputedRef<string>
  etaMs: ComputedRef<number | null>
  status: ComputedRef<TaskProgressStatus>
  isRunning: ComputedRef<boolean>
  isFinished: ComputedRef<boolean>
  isFailed: ComputedRef<boolean>
  error: ComputedRef<unknown>
  /** 清掉本地状态（切换章节/关闭面板时调用，避免旧进度残影） */
  reset: () => void
}

const TERMINAL: ReadonlySet<TaskProgressStatus> = new Set<TaskProgressStatus>([
  'succeeded', 'failed', 'cancelled', 'interrupted',
])

// ---------------------------------------------------------------------------
// 模块级注册表
// ---------------------------------------------------------------------------

const states = new Map<string, Ref<TaskProgressState>>()
const listeners = new Set<(state: TaskProgressState) => void>()
let unsubscribe: (() => void) | null = null

function createState(taskId: string, partial: Partial<TaskProgressState> = {}): TaskProgressState {
  const now = Date.now()
  return {
    taskId,
    kind: '',
    progress: 0,
    stage: '',
    etaMs: null,
    throughput: null,
    status: 'running',
    error: null,
    result: null,
    startedAt: now,
    updatedAt: now,
    finished: false,
    eventCount: 0,
    regressed: false,
    ...partial,
  }
}

function ensureRef(taskId: string): Ref<TaskProgressState> {
  let r = states.get(taskId)
  if (!r) {
    r = ref(createState(taskId)) as Ref<TaskProgressState>
    states.set(taskId, r)
  }
  return r
}

function emit(state: TaskProgressState): void {
  for (const listener of listeners) {
    try {
      listener(state)
    } catch {
      // 订阅者自己的异常不该拖垮任务事件流（它会被 Vue 的 errorHandler 兜住）
    }
  }
}

/** 统一入口：写入状态并广播（所有变更都从这里过，保证单调性只实现一次） */
function patch(taskId: string, updater: (prev: TaskProgressState) => TaskProgressState): TaskProgressState {
  const target = ensureRef(taskId)
  const next = updater(target.value)
  target.value = next
  emit(next)
  return next
}

function ensureListeners(): void {
  if (unsubscribe) return
  const offProgress = on('task:progress', (payload) => {
    if (!payload || typeof payload.taskId !== 'string') return
    applyProgress(payload)
  })
  const offFinished = on('task:finished', (payload) => {
    if (!payload || typeof payload.taskId !== 'string') return
    applyFinished(payload)
  })
  unsubscribe = () => {
    offProgress()
    offFinished()
    unsubscribe = null
  }
}

/** 处理 `task:progress`（导出便于单测与「用手工数据模拟进度」的开发工具调用） */
export function applyProgress(payload: {
  taskId: string
  kind?: string
  progress: number
  stage?: string
  etaMs?: number
  throughput?: { unit: string; perSecond: number }
}): TaskProgressState {
  ensureListeners()
  return patch(payload.taskId, (prev) => {
    // 1) 终态之后到达的进度事件一律丢弃（窗口重建时主进程会补发旧事件）
    if (prev.finished) return prev

    const incoming = Number.isFinite(payload.progress) ? payload.progress : prev.progress
    // 2) 单调去重：乱序/重复事件不倒退进度
    const regressed = incoming < prev.progress
    const progress = Math.min(1, Math.max(prev.progress, incoming))

    return {
      ...prev,
      kind: payload.kind ?? prev.kind,
      progress,
      stage: payload.stage ?? prev.stage,
      etaMs: payload.etaMs ?? prev.etaMs,
      throughput: payload.throughput ?? prev.throughput,
      status: prev.status === 'queued' || prev.status === 'waiting' ? 'running' : prev.status,
      updatedAt: Date.now(),
      eventCount: prev.eventCount + 1,
      regressed: prev.regressed || regressed,
    }
  })
}

/** 处理 `task:finished`（终态优先，永远生效；哪怕 progress 倒退） */
export function applyFinished(payload: {
  taskId: string
  status: string
  result?: unknown
  error?: unknown
}): TaskProgressState {
  ensureListeners()
  const status = (TERMINAL.has(payload.status as TaskProgressStatus)
    ? payload.status
    : 'succeeded') as TaskProgressStatus

  const result = patch(payload.taskId, prev => ({
    ...prev,
    status,
    // 成功收尾时把进度补满，避免进度条停在 97% 这种观感问题
    progress: status === 'succeeded' ? 1 : prev.progress,
    result: payload.result ?? prev.result,
    error: payload.error ?? prev.error,
    finished: true,
    updatedAt: Date.now(),
    eventCount: prev.eventCount + 1,
  }))

  // 任务已死，不再需要为它保留实时更新；状态留在表里供 UI 读最后结果
  return result
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/** 读一次快照（store 里做列表合并时用） */
export function getTaskState(taskId: string): TaskProgressState | null {
  const r = states.get(taskId)
  return r ? r.value : null
}

/** 当前被观察过的全部任务 id（任务中心兜底列表） */
export function listTrackedTaskIds(): string[] {
  return [...states.keys()]
}

/**
 * 订阅任意任务的进度变更（应用级任务坞/任务中心用它维护总列表）。
 * 返回取消函数；`task:progress` 高频（≤10/s，主进程已节流），不必再防抖。
 */
export function onTaskStateChange(listener: (state: TaskProgressState) => void): () => void {
  ensureListeners()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 清掉某个任务的本地状态；不传则清全部（切换项目时用） */
export function resetTaskProgress(taskId?: string): void {
  if (taskId) {
    states.delete(taskId)
    return
  }
  states.clear()
}

/** 由 `task:list` 的返回初始化一条状态（窗口重建后恢复进度显示，docs/20 §7） */
export function seedTaskState(seed: {
  taskId: string
  kind?: string
  progress?: number
  stage?: string | null
  status?: string
}): TaskProgressState {
  const status = (seed.status ?? 'running') as TaskProgressStatus
  return patch(seed.taskId, prev => ({
    ...prev,
    kind: seed.kind ?? prev.kind,
    progress: Math.min(1, Math.max(prev.progress, seed.progress ?? 0)),
    stage: seed.stage ?? prev.stage,
    status,
    finished: TERMINAL.has(status),
    updatedAt: Date.now(),
  }))
}

/**
 * 订阅一个任务的进度。
 *
 * 用法（docs/01 §3.2 规定的唯一姿势）：
 * ```ts
 * const { percent, stage, isFailed } = useTaskProgress(taskId)
 * ```
 * 也可以在第一个参数传 ref（章节切换时自动跟随）：
 * ```ts
 * const taskId = ref<string | null>(null)
 * const progress = useTaskProgress(taskId)   // taskId 变化后自动重绑
 * ```
 */
export function useTaskProgress(
  source: string | null | undefined | Ref<string | null | undefined>,
): TaskProgressView {
  const taskIdRef = computed<string | null>(() => {
    const value = typeof source === 'object' && source !== null && 'value' in source
      ? unref(source)
      : source
    return value ?? null
  })

  // 绑定即建状态：这样 `taskId` 一出现，UI 立刻有 0% 的骨架，而不是空白
  const state = computed<TaskProgressState | null>(() => {
    const id = taskIdRef.value
    if (!id) return null
    return ensureRef(id).value
  })

  // 让全局监听器在「有任务被观察」时才建立（不在首屏就注册无用的 IPC 监听）
  if (taskIdRef.value) ensureListeners()
  watch(taskIdRef, (id) => {
    if (id) ensureListeners()
  })

  const progress = computed(() => state.value?.progress ?? 0)
  const percent = computed(() => Math.round(progress.value * 100))
  const stage = computed(() => state.value?.stage ?? '')
  const etaMs = computed(() => state.value?.etaMs ?? null)
  const status = computed<TaskProgressStatus>(() => state.value?.status ?? 'queued')
  const isRunning = computed(() => {
    const s = status.value
    return s === 'running' || s === 'queued' || s === 'waiting'
  })
  const isFinished = computed(() => state.value?.finished ?? false)
  const isFailed = computed(() => status.value === 'failed' || status.value === 'interrupted')

  // 组件卸载即停止观察（状态本身留着，供任务坞继续显示）
  onScopeDispose(() => {
    // 无操作：注册表按 taskId 长驻，避免「切页回来进度从 0 开始」
  })

  return {
    state,
    progress,
    percent,
    stage,
    etaMs,
    status,
    isRunning,
    isFinished,
    isFailed,
    error: computed(() => state.value?.error ?? null),
    reset: () => {
      const id = taskIdRef.value
      if (id) resetTaskProgress(id)
    },
  }
}

/** 只读视图（给 store 暴露出去，防止外部直接改状态） */
export function taskProgressReadonly(taskId: string): Readonly<Ref<TaskProgressState | null>> {
  const id = taskId
  return readonly(computed(() => ensureRef(id).value)) as Readonly<Ref<TaskProgressState | null>>
}

/** 供测试重置模块级监听（避免测试之间互相干扰） */
export function __resetTaskProgressForTest(): void {
  unsubscribe?.()
  unsubscribe = null
  listeners.clear()
  states.clear()
}
