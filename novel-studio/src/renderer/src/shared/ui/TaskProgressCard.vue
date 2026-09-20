<!--
  Novel Studio · 统一任务进度卡（docs/04 §2.4）
  ============================================================================
  为什么必须只有一个进度 UI 实现：
    docs/04 §2.4 明确「禁止每个功能自建进度 UI」。导入、生成画本、批量处理、
    混音渲染、导出、备份……如果各写一遍，就会出现：取消按钮有的有有的没有、
    剩余时间算法各不相同、失败后有的能重试有的不能。
    因此统一到这一个组件：**进度 + 阶段 + 剩余时间 + 速率 + 取消/重试**。

  两种用法：
    1) 只给 taskId —— 组件自己订阅 `task:progress` / `task:finished`（推荐）
       <TaskProgressCard task-id="01H..." title="导出《斗破苍穹》" cancelable />
    2) 纯展示 —— 由父组件喂 progress/stage/status（用于历史报告回放）

  事件：
    cancel / retry / close / open 都不是组件内部行为，一律向上抛，
    由功能域决定调哪个 IPC 通道（组件不该知道业务）。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { TASK_KIND_LABELS } from '@shared/constants.ts'
import type { TaskStatus } from '@shared/types.ts'
import { formatDuration, formatElapsed, formatPercent } from '@/shared/lib/format.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'

const props = withDefaults(defineProps<{
  /** 任务 id：给了就自订阅进度（推荐用法） */
  taskId?: string
  /** 标题（不传则用任务类型的中文标签） */
  title?: string
  /** 任务类型（TASK_KIND_LABELS 的键） */
  kind?: string
  /** 外部提供的进度（0~1）；给了 taskId 时以订阅值为准 */
  progress?: number
  stage?: string | null
  etaMs?: number | null
  status?: TaskStatus
  /** 尺寸：compact 用于右下角进度坞 */
  size?: 'default' | 'compact'
  cancelable?: boolean
  retryable?: boolean
  closable?: boolean
  /** 失败原因（主进程已给出中文文案时优先用它） */
  errorMessage?: string | null
  /** 是否显示「查看」入口（跳任务中心） */
  openable?: boolean
  /** 是否显示速率 */
  throughput?: { unit: string; perSecond: number } | null
}>(), {
  taskId: undefined,
  title: undefined,
  kind: undefined,
  progress: undefined,
  stage: null,
  etaMs: null,
  status: undefined,
  size: 'default',
  cancelable: true,
  retryable: true,
  closable: false,
  errorMessage: null,
  openable: true,
  throughput: null,
})

const emit = defineEmits<{
  cancel: [taskId: string]
  retry: [taskId: string]
  close: [taskId: string]
  open: [taskId: string]
}>()

// 订阅（taskId 为空时是空操作，组件纯展示）
// 用 computed 包一层：任务 id 变化（例如重试后换成新任务）时能自动重绑
const live = useTaskProgress(computed(() => props.taskId ?? null))

const resolvedKind = computed(() => live.state.value?.kind ?? props.kind ?? '')
const label = computed(() => {
  if (props.title) return props.title
  const kind = resolvedKind.value
  return kind ? (TASK_KIND_LABELS[kind] ?? kind) : '任务'
})
const resolvedProgress = computed(() => {
  if (props.taskId) return live.progress.value
  return Math.min(1, Math.max(0, props.progress ?? 0))
})
const resolvedStage = computed(() => (props.taskId ? live.stage.value : (props.stage ?? '')))
const resolvedEtaMs = computed(() => (props.taskId ? live.etaMs.value : (props.etaMs ?? null)))
const resolvedStatus = computed<TaskStatus>(() => {
  if (props.taskId) return live.status.value as TaskStatus
  return props.status ?? 'running'
})

const isRunning = computed(() => ['queued', 'waiting', 'running'].includes(resolvedStatus.value))
const isFailed = computed(() => resolvedStatus.value === 'failed' || resolvedStatus.value === 'interrupted')
const isCancelled = computed(() => resolvedStatus.value === 'cancelled')
const isDone = computed(() => resolvedStatus.value === 'succeeded')

const percent = computed(() => Math.round(resolvedProgress.value * 100))
const elapsedText = computed(() => {
  const startedAt = live.state.value?.startedAt
  return startedAt ? formatElapsed(startedAt) : ''
})
const etaText = computed(() => {
  const eta = resolvedEtaMs.value
  if (eta === null || eta === undefined) return ''
  return `剩余约 ${formatDuration(eta)}`
})
const throughputText = computed(() => {
  const t = props.throughput ?? live.state.value?.throughput ?? null
  if (!t) return ''
  return `${t.perSecond.toFixed(2)} ${t.unit}/秒`
})
/** 进度倒退过（主进程侧乱序推送）时给出诊断提示，避免用户觉得「进度条坏了」 */
const regressed = computed(() => live.state.value?.regressed === true)

const statusColor = computed(() => {
  if (isFailed.value) return 'var(--ns-danger, #f56c6c)'
  if (isCancelled.value) return 'var(--ns-text-secondary, #909399)'
  if (isDone.value) return 'var(--ns-success, #67c23a)'
  return 'var(--ns-primary, #409eff)'
})

function onCancel(): void {
  if (props.taskId) emit('cancel', props.taskId)
}
function onRetry(): void {
  if (props.taskId) emit('retry', props.taskId)
}
function onClose(): void {
  if (props.taskId) emit('close', props.taskId)
}
function onOpen(): void {
  if (props.taskId) emit('open', props.taskId)
}
</script>

<template>
  <div class="ns-task-card" :class="[`ns-task-card--${props.size}`, { 'is-failed': isFailed, 'is-done': isDone }]">
    <div class="ns-task-card__head">
      <span class="ns-task-card__title" :title="label">{{ label }}</span>
      <span class="ns-task-card__percent" :style="{ color: statusColor }">{{ formatPercent(resolvedProgress) }}</span>

      <span v-if="isDone" class="ns-task-card__flag ns-task-card__flag--ok">已完成</span>
      <span v-else-if="isFailed" class="ns-task-card__flag ns-task-card__flag--bad">失败</span>
      <span v-else-if="isCancelled" class="ns-task-card__flag">已取消</span>
    </div>

    <div class="ns-task-card__bar" :class="`ns-task-card__bar--${resolvedStatus}`">
      <div
        class="ns-task-card__bar-inner"
        :style="{ width: `${percent}%`, background: statusColor }"
        role="progressbar"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
      />
    </div>

    <p v-if="resolvedStage" class="ns-task-card__stage">{{ resolvedStage }}</p>
    <p v-if="props.errorMessage" class="ns-task-card__error">{{ props.errorMessage }}</p>
    <p v-else-if="regressed" class="ns-task-card__hint">进度事件出现乱序，已按单调值显示（不影响任务本身）。</p>

    <div class="ns-task-card__meta">
      <span v-if="elapsedText">已用 {{ elapsedText }}</span>
      <span v-if="etaText">{{ etaText }}</span>
      <span v-if="throughputText">{{ throughputText }}</span>
    </div>

    <div v-if="props.size === 'default'" class="ns-task-card__actions">
      <button v-if="isRunning && props.cancelable" type="button" class="ns-btn" @click="onCancel">取消</button>
      <button v-if="!isRunning && props.retryable && isFailed" type="button" class="ns-btn ns-btn--primary" @click="onRetry">重试</button>
      <button v-if="props.openable && props.taskId" type="button" class="ns-btn" @click="onOpen">查看</button>
      <button v-if="props.closable && !isRunning" type="button" class="ns-btn" @click="onClose">移除</button>
    </div>
  </div>
</template>

<style scoped>
.ns-task-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: 0 1px 4px rgb(0 0 0 / 6%);
}
.ns-task-card--compact {
  padding: 8px 10px;
  gap: 4px;
}
.ns-task-card.is-failed {
  border-color: var(--ns-danger, #f56c6c);
}
.ns-task-card.is-done {
  border-color: var(--ns-success, #67c23a);
}
.ns-task-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ns-task-card__title {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-task-card__percent {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.ns-task-card__flag {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-task-card__flag--ok {
  background: rgb(103 194 58 / 15%);
  color: var(--ns-success, #67c23a);
}
.ns-task-card__flag--bad {
  background: rgb(245 108 108 / 15%);
  color: var(--ns-danger, #f56c6c);
}
.ns-task-card__bar {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--ns-fill, #ebeef5);
}
.ns-task-card__bar--failed .ns-task-card__bar-inner {
  opacity: 0.7;
}
.ns-task-card__bar-inner {
  height: 100%;
  border-radius: 3px;
  transition: width 0.2s ease;
}
.ns-task-card__stage {
  margin: 0;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-task-card__error {
  margin: 0;
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
  line-height: 1.5;
}
.ns-task-card__hint {
  margin: 0;
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
}
.ns-task-card__meta {
  display: flex;
  gap: 12px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-task-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}
.ns-btn {
  padding: 3px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  cursor: pointer;
}
.ns-btn:hover {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
</style>
