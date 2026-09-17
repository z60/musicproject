/**
 * 应用级状态 · 任务中心（跨功能域共享）
 * ============================================================================
 * 设计依据：
 *   · docs/04 §2.4 —— 「统一的任务进度卡」：禁止每个功能自建进度 UI
 *   · docs/20 §7 —— 事件幂等、窗口重建后要能用 `task:list` + 事件恢复
 *   · docs/01 §3.2 —— 长任务进度统一由 `useTaskProgress(taskId)` 订阅
 *
 * 分工：
 *   · `shared/lib/task-progress.ts` 负责**单任务的进度状态**（模块级注册表 + 一对全局监听器）
 *   · 本 store 负责**任务列表**（队列表格、取消、重试、清空）以及把进度合并进列表
 *   · 二者通过 `onTaskStateChange` 单向连接：进度只来自主进程，本 store 不自行推进状态
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { getTaskState, onTaskStateChange, resetTaskProgress } from '@/shared/lib/task-progress.ts'
import type { TaskProgressState } from '@/shared/lib/task-progress.ts'
import type { TaskKind, TaskRecord, TaskStatus } from '@shared/types.ts'

/** 完成任务后保留多久再自动从列表里消失（毫秒）；0 表示永不自动清 */
const AUTO_DROP_FINISHED_MS = 60_000

export const useTasksStore = defineStore('app/tasks', () => {
  const records = ref<TaskRecord[]>([])
  const loading = ref(false)
  /** 单任务进度（来自 task-progress 注册表），key = taskId */
  const progress = ref<Record<string, TaskProgressState>>({})
  const lastError = ref<unknown>(null)

  let unsubscribe: (() => void) | null = null
  let dropTimer: ReturnType<typeof setInterval> | null = null

  const running = computed(() => records.value.filter(r => isRunning(r.status)))
  const finished = computed(() => records.value.filter(r => !isRunning(r.status)))
  const runningCount = computed(() => running.value.length)
  /** 是否有失败任务（顶栏用它显示红点） */
  const hasFailure = computed(() => records.value.some(r => r.status === 'failed' || r.status === 'interrupted'))

  function isRunning(status: TaskStatus): boolean {
    return status === 'queued' || status === 'waiting' || status === 'running'
  }

  /** 某一行的进度值（0~1）：优先用实时事件，没有则用列表里的快照 */
  function progressOf(taskId: string): number {
    const live = progress.value[taskId]
    if (live) return live.progress
    const record = records.value.find(r => r.id === taskId)
    return record?.progress ?? 0
  }

  function stageOf(taskId: string): string {
    return progress.value[taskId]?.stage ?? records.value.find(r => r.id === taskId)?.stage ?? ''
  }

  function etaOf(taskId: string): number | null {
    return progress.value[taskId]?.etaMs ?? null
  }

  /** 合并一条进度事件到本地映射（列表行也同步刷新，保证「进度条与状态」一致） */
  function mergeProgress(state: TaskProgressState): void {
    progress.value = { ...progress.value, [state.taskId]: state }

    const index = records.value.findIndex(r => r.id === state.taskId)
    if (index < 0) return
    const record = records.value[index]!
    records.value[index] = {
      ...record,
      progress: state.progress,
      stage: state.stage || record.stage,
      status: state.finished ? state.status : (isRunning(record.status) ? record.status : 'running'),
      finishedAt: state.finished ? Date.now() : record.finishedAt,
    }
  }

  /**
   * 订阅任务事件（只调一次，App.vue 挂载时 init）。
   * 为什么要在这里做「去重/合并」：`task:progress` 是 ≤10/s 的高频事件，
   * 若每个订阅者各自 setState，Vue 会触发大量无关组件重渲染。
   */
  function init(): void {
    if (unsubscribe) return
    unsubscribe = onTaskStateChange(mergeProgress)

    // 终态任务自动淡出（保留一小段时间让用户看到「已完成」）
    if (!dropTimer) {
      dropTimer = setInterval(() => {
        const now = Date.now()
        records.value = records.value.filter(r => {
          if (isRunning(r.status)) return true
          const at = r.finishedAt ?? r.createdAt
          return now - at < AUTO_DROP_FINISHED_MS
        })
      }, 15_000)
    }
  }

  /** 从主进程拉取任务列表（启动、窗口重建、手动刷新都走它） */
  async function refresh(filter: { status?: TaskStatus[]; kind?: TaskKind[]; limit?: number } = {}): Promise<void> {
    loading.value = true
    try {
      const list = await call('task:list', filter)
      records.value = list
      lastError.value = null
    } catch (error) {
      lastError.value = error
    } finally {
      loading.value = false
    }
  }

  /** 取消任务：主进程返回 ok 后本地不急着改状态，等 task:finished 事件（主进程权威） */
  async function cancel(taskId: string): Promise<boolean> {
    const result = await callSafe('task:cancel', { taskId })
    if (result?.ok) {
      patchLocal(taskId, { stage: '正在取消…' })
      return true
    }
    return false
  }

  /** 重试：返回新任务 id（主进程会新建一条记录） */
  async function retry(taskId: string): Promise<string | null> {
    const result = await callSafe('task:retry', { taskId })
    if (result?.taskId) {
      await refresh()
      return result.taskId
    }
    return null
  }

  /** 清空已结束任务（失败/取消的也一起清） */
  async function clearFinished(): Promise<number> {
    const result = await callSafe('task:clearFinished', undefined)
    const cleared = result?.cleared ?? 0
    records.value = records.value.filter(r => isRunning(r.status))
    for (const id of Object.keys(progress.value)) {
      if (!records.value.some(r => r.id === id)) resetTaskProgress(id)
    }
    return cleared
  }

  /** 取任务结果（导出报告、批量处理报告都从这里拿） */
  async function result<T = unknown>(taskId: string): Promise<T | null> {
    return await callSafe('task:result', { taskId }) as T | null
  }

  function patchLocal(taskId: string, patch: Partial<TaskRecord>): void {
    const index = records.value.findIndex(r => r.id === taskId)
    if (index < 0) return
    records.value[index] = { ...records.value[index]!, ...patch }
  }

  /** 已知任务 id 的实时状态（TaskProgressCard 需要） */
  function stateOf(taskId: string): TaskProgressState | null {
    return progress.value[taskId] ?? getTaskState(taskId)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    if (dropTimer) {
      clearInterval(dropTimer)
      dropTimer = null
    }
  }

  return {
    records, loading, progress, lastError,
    running, finished, runningCount, hasFailure,
    init, refresh, cancel, retry, clearFinished, result,
    progressOf, stageOf, etaOf, stateOf, dispose,
    isRunning,
  }
})
