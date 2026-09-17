<!--
  Novel Studio · 导出进度（docs/15 §5.5 Step 7 / §5.4 断点续传）
  ============================================================================
  设计依据：
    · docs/04 §2.4 —— 「禁止每个功能自建进度 UI」：进度条 + 阶段 + 剩余时间 + 取消
      一律用 `TaskProgressCard`（本组件只补导出特有的信息）。
    · docs/15 §5.5 Step 7 —— 需要显示：**当前章 N/M、剩余时间估算、实时速率**。
      其中章级信息来自 `export:progress` 事件（taskId/currentChapter/totalChapters/
      stage/elapsedMs/etaMs/speed），任务级进度来自 `task:progress`（由进度卡消费）。
    · docs/15 §5.4 —— 断点续传的价值必须讲清楚：120 章导出可能跑 1 小时，
      取消/断电后重跑**已完成的章不重渲**（同 paramsHash）。
    · docs/15 §11  —— M4B 合并阶段会晚于分章完成，因此这一阶段耗时也要有交代。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { formatDuration, formatInt, formatPercent, UNKNOWN } from '@/shared/lib/format.ts'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import type { ExportFlowProgress } from '../composables/useExportFlow.ts'

const props = withDefaults(defineProps<{
  /** 导出任务 id（null = 还没开始） */
  taskId: string | null
  /** `export:progress` 的节流快照（章级进度） */
  progress: ExportFlowProgress | null
  /** 正在提交导出请求（点了按钮但还没拿到 taskId） */
  submitting?: boolean
  /** 范围描述（如「全书 120 章」） */
  scope: string
  /** 输出目录（让用户随时确认写到哪里） */
  outputDir: string
  /** 任务标题（默认「导出《书名》」） */
  title?: string
  /** 任务类型（TASK_KIND_LABELS 的键；仅当进度事件还没带来 kind 时作为兜底标签） */
  taskKind?: string
  /** 是否允许取消 */
  cancelable?: boolean
  /** 输出格式（显示在摘要行） */
  format: string
  /** 本次预计产出的章数（用于「当前章 N/M」在事件还没到达时的兜底分母） */
  plannedChapters: number
  /** 报告面板是否已有结果（用于把「取消」变成「已完成」） */
  finished?: boolean
  /** 预检里已存在会被覆盖/跳过的输出（提示断点行为） */
  resumeHint?: boolean
}>(), {
  submitting: false,
  title: undefined,
  taskKind: 'export.book',
  cancelable: true,
  finished: false,
  resumeHint: true,
})

const emit = defineEmits<{
  cancel: [taskId: string]
  retry: [taskId: string]
  /** 查看任务中心 */
  open: [taskId: string]
  /** 清除本条任务显示 */
  close: [taskId: string]
  /** 打开输出目录（导出结束后最常用的动作） */
  'open-folder': []
  /** 没有任务时直接开始导出 */
  start: []
}>()

/** 当前章 N/M：优先用事件值，事件还没来时用计划章数兜底 */
const currentChapter = computed(() => props.progress?.currentChapter ?? 0)
const totalChapters = computed(() => props.progress?.totalChapters ?? props.plannedChapters)
const chapterRatio = computed(() => {
  if (totalChapters.value <= 0) return 0
  return Math.min(1, Math.max(0, currentChapter.value / totalChapters.value))
})
const chapterText = computed(() =>
  totalChapters.value > 0
    ? `当前章 ${formatInt(currentChapter.value)}/${formatInt(totalChapters.value)}（${formatPercent(chapterRatio.value)}）`
    : '等待主进程上报章进度…',
)

/** 剩余时间：eta 由主进程算（含章进度与历史速率），UI 只做格式化 */
const etaText = computed(() => {
  const eta = props.progress?.etaMs
  if (eta === null || eta === undefined) return UNKNOWN
  return formatDuration(eta)
})

/**
 * 实时速率。
 * ⚠️ `export:progress.speed` 的**单位在契约里没有写明**（docs/15 §5.5 只说「实时速率」），
 * 这里按「章/秒」显示并在 UI 上标注口径，避免用户把「看成一个整体速度」当成分钟。
 */
const speedText = computed(() => {
  const speed = props.progress?.speed
  if (speed === null || speed === undefined || !Number.isFinite(speed)) return UNKNOWN
  return `${speed.toFixed(2)} 章/秒`
})

const elapsedText = computed(() => {
  const elapsed = props.progress?.elapsedMs
  if (elapsed === null || elapsed === undefined) return UNKNOWN
  return formatDuration(elapsed)
})

const stageText = computed(() => props.progress?.stage ?? '')

/** 进度卡上的速率（章/秒） */
const throughput = computed(() => {
  const speed = props.progress?.speed
  if (speed === null || speed === undefined || !Number.isFinite(speed)) return null
  return { unit: '章', perSecond: speed }
})

function onCancel(taskId: string): void {
  emit('cancel', taskId)
}

function onRetry(taskId: string): void {
  emit('retry', taskId)
}

function onOpen(taskId: string): void {
  emit('open', taskId)
}

function onClose(taskId: string): void {
  emit('close', taskId)
}

/** 「取消导出」按钮：没有 taskId 时不该有反应（禁用态已经挡了一层） */
function onCancelClick(): void {
  const id = props.taskId
  if (!id) return
  emit('cancel', id)
}
</script>

<template>
  <section class="ns-run">
    <header class="ns-run__head">
      <div>
        <h3 class="ns-run__title">执行导出</h3>
        <p class="ns-run__desc">
          范围：{{ props.scope }} · 格式：{{ props.format.toUpperCase() }} · 输出目录：
          <code>{{ props.outputDir || UNKNOWN }}</code>
        </p>
      </div>
    </header>

    <!-- 还没开始：给明确的下一步动作（而不是空白） -->
    <EmptyState
      v-if="!props.taskId && !props.submitting"
      icon="🚀"
      title="还没有开始导出"
      description="确认预检通过后点「开始导出」；导出过程可以随时取消，已完成的章会在重跑时自动跳过。"
      action-text="开始导出"
      size="small"
      @action="emit('start')"
    >
      <p class="ns-run__resume-hint">
        断点续传：同一套参数（混音方案 + 对轨版本 + 响度 + 导出参数）下已成功的章会直接跳过，
        适合 100 章以上的整本导出（docs/15 §5.4）。
      </p>
    </EmptyState>

    <template v-else>
      <TaskProgressCard
        :task-id="props.taskId ?? undefined"
        :title="props.title ?? '导出有声成品'"
        :kind="props.taskKind"
        :throughput="throughput"
        :cancelable="props.cancelable"
        :closable="props.finished"
        openable
        @cancel="onCancel"
        @retry="onRetry"
        @open="onOpen"
        @close="onClose"
      />

      <div class="ns-run__grid">
        <div class="ns-run__cell">
          <span class="ns-run__cell-label">章节进度</span>
          <strong class="ns-run__cell-value">{{ chapterText }}</strong>
          <el-progress
            :percentage="Math.round(chapterRatio * 100)"
            :show-text="false"
            :stroke-width="6"
          />
        </div>
        <div class="ns-run__cell">
          <span class="ns-run__cell-label">剩余时间</span>
          <strong class="ns-run__cell-value">{{ etaText }}</strong>
          <span class="ns-run__cell-hint">主进程按已完成章的实测速率推算</span>
        </div>
        <div class="ns-run__cell">
          <span class="ns-run__cell-label">实时速率</span>
          <strong class="ns-run__cell-value">{{ speedText }}</strong>
          <span class="ns-run__cell-hint">章节处理速度（章/秒）</span>
        </div>
        <div class="ns-run__cell">
          <span class="ns-run__cell-label">已用时间</span>
          <strong class="ns-run__cell-value">{{ elapsedText }}</strong>
          <span class="ns-run__cell-hint">{{ stageText || '等待阶段信息' }}</span>
        </div>
      </div>

      <div class="ns-run__notes">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="导出期间请不要离开本页"
          description="切页或关窗口会被拦下来确认：导出任务由主进程执行，但渲染进程持有进度与取消入口。"
        />
        <p class="ns-run__resume-hint">
          断点续传：同参数重跑时，已在导出库里成功且文件仍存在的章会标记为「跳过」，
          不会重新渲染（docs/15 §5.4）{{ props.resumeHint ? '' : '（本次参数已变更，已完成的章会重渲）' }}。
        </p>
      </div>

      <div class="ns-run__actions">
        <el-button
          v-if="!props.finished"
          type="danger"
          plain
          :disabled="!props.taskId || !props.cancelable"
          @click="onCancelClick"
        >
          取消导出
        </el-button>
        <el-button @click="emit('open-folder')">打开输出目录</el-button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ns-run {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ns-run__title {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.ns-run__desc {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-run__desc code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-run__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.ns-run__cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-run__cell-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-run__cell-value {
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.ns-run__cell-hint {
  color: var(--ns-text-placeholder, #c0c4cc);
  font-size: 11px;
}
.ns-run__notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-run__resume-hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-run__actions {
  display: flex;
  gap: 8px;
}
</style>
