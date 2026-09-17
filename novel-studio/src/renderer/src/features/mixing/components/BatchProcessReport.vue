<!--
  Novel Studio · 批量处理报告（docs/14 §7.3 报告 UI、§7.2 取消语义）
  ============================================================================
  报告的形状就是文档里那张图：目标 N | 成功 N | 跳过 K（参数未变）| 失败 M，下面是失败明细。

  三条必须守住的规则：
    ① **不逐条弹提示**：失败明细只进这张表；提示走 `reportBatchFailures`
       （store.retryFailures 内部已经这么做了 —— 一条提示 + 明细进日志）。
    ② **「查看命令」必须提供**（docs/14 §7.3）：把完整 ffmpeg 命令行原样显示并可复制，
       否则用户/开发者无法在终端里复现问题。命令缺失时按钮就不出现，而不是点了报错。
    ③ **已完成的片段不回滚**（docs/14 §7.2）：取消只停止派发新任务，报告里明确写这一句，
       避免用户以为「取消了就等于什么都没发生」。

  「跳过」的语义：主进程按 `process:{segmentId}:{presetHash}` 幂等去重（docs/14 §7.1），
  重复点不会重跑，所以「跳过」通常是**好事**（参数没变），要在界面上解释清楚。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useProcessChainStore } from '../stores/processChain.store.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import { formatCount, formatRelativeTime } from '@/shared/lib/format.ts'
import type { Id } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  /** 失败明细最多渲染多少条（超过只显示前 N 条并给出总数，避免几百条把界面拖死） */
  maxFailures?: number
}>(), {
  maxFailures: 50,
})

const emit = defineEmits<{
  /** 「改用其他预设」：视图把预设管理区展开/滚动到视野内 */
  'open-presets': []
}>()

const chain = useProcessChainStore()

const task = useTaskProgress(chain.batchTaskId)
const expanded = ref<Set<Id>>(new Set())
const retried = ref<Set<Id>>(new Set())
const hinted = ref<string | null>(null)
const busy = ref(false)

/** 任务终态时把结果解析成报告（明细只有任务结束后才有） */
watch(() => task.isFinished.value, (finished) => {
  const taskId = chain.batchTaskId
  if (!finished || !taskId) return
  void chain.collectReport(taskId)
})

// 新的一批开始处理时清掉上一次的本地状态
watch(() => chain.batchTaskId, () => {
  expanded.value = new Set()
  retried.value = new Set()
  hinted.value = null
})

const report = computed(() => chain.report)
const hasReport = computed(() => report.value.total > 0 || report.value.failures.length > 0 || report.value.finishedAt !== null)

const summary = computed(() => {
  const r = report.value
  return [
    { label: '目标', value: r.total, note: '解析出的目标片段数' },
    { label: '成功', value: r.succeeded, note: '已写入处理结果' },
    { label: '跳过', value: r.skipped, note: '参数未变，按幂等键去重' },
    { label: '失败', value: r.failed, note: '逐条失败，不影响其它片段' },
  ]
})

const finishedText = computed(() => (
  report.value.finishedAt ? formatRelativeTime(report.value.finishedAt) : '进行中'
))

function toggleCommand(segmentId: Id): void {
  const next = new Set(expanded.value)
  if (next.has(segmentId)) next.delete(segmentId)
  else next.add(segmentId)
  expanded.value = next
}

/** 单条重试：用当前处理链只重跑这一条（成功与否都以任务结果为准） */
async function retryOne(segmentId: Id, label: string): Promise<void> {
  if (!segmentId) return
  busy.value = true
  const taskId = await chain.applyToSegment(segmentId)
  busy.value = false
  if (!taskId) {
    hinted.value = `「${label}」重试派发失败，请检查处理链与 ffmpeg 能力`
    return
  }
  const next = new Set(retried.value)
  next.add(segmentId)
  retried.value = next
  hinted.value = `已重新派发「${label}」（任务 ${taskId.slice(0, 8)}），完成后可回到本报告查看结果`
}

/** 整体重试失败项（store 内部逐条静默收集，再用 reportBatchFailures 汇总成一条提示） */
async function retryAll(): Promise<void> {
  if (!report.value.failures.length) return
  busy.value = true
  const ok = await chain.retryFailures()
  busy.value = false
  hinted.value = ok > 0
    ? `已重试 ${ok} 条（其余仍失败，明细见下表）`
    : '重试仍然失败：可先「查看命令」在终端复现，或改用其它预设'
}

/** 单条回退：清掉 processed_path，回到原始素材（docs/14 §7.3 的「回退」） */
async function revertOne(segmentId: Id, label: string): Promise<void> {
  if (!segmentId) return
  busy.value = true
  const ok = await chain.revertSegment(segmentId)
  busy.value = false
  hinted.value = ok ? `已回退「${label}」到原始素材` : `「${label}」回退失败`
}

async function copyCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
    hinted.value = '命令行已复制，可直接在终端里复现'
  } catch {
    hinted.value = '复制失败：请手动选中命令行复制'
  }
}
</script>

<template>
  <section class="ns-report">
    <header class="ns-report__head">
      <div>
        <h3>批量处理报告</h3>
        <p class="ns-hint">
          跳过不是错误：主进程按 <code>process:{segmentId}:{presetHash}</code> 做幂等去重，
          参数没变就不会重跑。
        </p>
      </div>
      <div class="ns-report__ops">
        <el-button
          size="small"
          type="primary"
          :disabled="!report.failures.length"
          :loading="busy"
          @click="retryAll"
        >
          重试失败项（{{ report.failures.length }}）
        </el-button>
        <el-button size="small" @click="emit('open-presets')">改用其他预设</el-button>
      </div>
    </header>

    <TaskProgressCard
      v-if="chain.batchTaskId"
      :task-id="chain.batchTaskId"
      title="批量处理中"
      kind="process.batch"
      size="compact"
      :openable="true"
    />

    <el-alert
      v-if="report.cancelled"
      class="ns-report__alert"
      type="warning"
      :closable="false"
      show-icon
      title="任务已取消：已完成的处理结果保留，不会回滚"
      description="取消只停止派发新任务，并在 2 秒内结束正在跑的 ffmpeg（docs/14 §7.2）。"
    />

    <p v-if="hinted" class="ns-report__hint">{{ hinted }}</p>

    <EmptyState
      v-if="!hasReport && !chain.batchTaskId"
      size="small"
      icon="📋"
      title="还没有批量处理记录"
      description="在处理链里点「套用到…」选择范围后，这里会显示 成功 / 跳过 / 失败 的完整报告"
    />

    <template v-else>
      <div class="ns-report__summary">
        <div v-for="item in summary" :key="item.label" class="ns-report__card">
          <span class="ns-report__label">{{ item.label }}</span>
          <strong :class="{ 'is-bad': item.label === '失败' && item.value > 0 }">{{ formatCount(item.value) }}</strong>
          <span class="ns-hint">{{ item.note }}</span>
        </div>
        <div class="ns-report__card">
          <span class="ns-report__label">结束时间</span>
          <strong>{{ finishedText }}</strong>
          <span class="ns-hint">任务 {{ report.taskId ? report.taskId.slice(0, 8) : '—' }}</span>
        </div>
      </div>

      <p v-if="!report.failures.length" class="ns-report__ok">
        没有失败项：{{ formatCount(report.succeeded) }} 个片段处理成功，
        {{ formatCount(report.skipped) }} 个因参数未变被跳过。
      </p>

      <div v-else class="ns-report__failures">
        <h4>失败明细（{{ report.failures.length }}）</h4>
        <article
          v-for="failure in report.failures.slice(0, props.maxFailures)"
          :key="failure.segmentId || failure.label"
          class="ns-failure"
        >
          <header class="ns-failure__head">
            <strong>{{ failure.label }}</strong>
            <el-tag size="small" type="danger">{{ failure.code }}</el-tag>
            <el-tag v-if="retried.has(failure.segmentId)" size="small" type="info">已重新派发</el-tag>
            <span class="ns-failure__msg">{{ failure.message }}</span>
          </header>

          <!-- 「查看命令」：有命令才显示（docs/14 §7.3）-->
          <div v-if="failure.commandLine" class="ns-failure__cmd">
            <el-button size="small" text @click="toggleCommand(failure.segmentId)">
              {{ expanded.has(failure.segmentId) ? '收起命令' : '查看命令' }}
            </el-button>
            <el-button size="small" text @click="copyCommand(failure.commandLine ?? '')">复制</el-button>
            <pre v-if="expanded.has(failure.segmentId)">{{ failure.commandLine }}</pre>
          </div>

          <div class="ns-failure__ops">
            <el-button
              size="small"
              :disabled="!failure.segmentId"
              :loading="busy"
              @click="retryOne(failure.segmentId, failure.label)"
            >
              单条重试
            </el-button>
            <el-button
              size="small"
              :disabled="!failure.segmentId"
              :loading="busy"
              @click="revertOne(failure.segmentId, failure.label)"
            >
              回退到原始
            </el-button>
            <span class="ns-hint">重试使用当前处理链；回退会清掉该片段的处理产物</span>
          </div>
        </article>
        <p v-if="report.failures.length > props.maxFailures" class="ns-hint">
          共 {{ report.failures.length }} 条失败，这里只列出前 {{ props.maxFailures }} 条；
          建议先用「查看命令」定位共性问题，再批量重试。
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ns-report { display: flex; flex-direction: column; gap: 8px; }
.ns-report__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ns-report h3 { margin: 0; font-size: 13.5px; color: var(--ns-text-primary, #303133); }
.ns-report h4 { margin: 0; font-size: 12.5px; color: var(--ns-text-primary, #303133); }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-hint code { padding: 0 3px; background: var(--ns-fill-light, #f5f7fa); font-size: 10.5px; }
.ns-report__ops { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-report__alert { margin: 0; }
.ns-report__hint { margin: 0; color: var(--ns-primary, #409eff); font-size: 11.5px; }
.ns-report__summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 6px; }
.ns-report__card {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-subtle, #fafafa);
}
.ns-report__label { color: var(--ns-text-regular, #606266); font-size: 11px; }
.ns-report__card strong { color: var(--ns-text-primary, #303133); font: 600 13px/1.2 ui-monospace, Consolas, monospace; }
.ns-report__card strong.is-bad { color: var(--ns-danger, #f56c6c); }
.ns-report__ok { margin: 0; color: var(--ns-success, #67c23a); font-size: 11.5px; }
.ns-report__failures { display: flex; flex-direction: column; gap: 6px; }
.ns-failure {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 1px solid rgb(245 108 108 / 45%); border-radius: 6px; background: rgb(245 108 108 / 5%);
}
.ns-failure__head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ns-failure__head strong { color: var(--ns-text-primary, #303133); font-size: 12px; }
.ns-failure__msg { color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-failure__cmd { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ns-failure__cmd pre {
  flex: 1 1 100%; margin: 0; padding: 6px 8px; overflow: auto; max-height: 160px;
  border-radius: 4px; background: #1f1f1f; color: #e6e6e6;
  font: 11px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all;
}
.ns-failure__ops { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
</style>
