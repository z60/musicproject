<!--
  Novel Studio · 任务中心（docs/04 §2）
  ============================================================================
  设计依据：
    · docs/04 §2  —— 长任务全部进队列：导入、生成画本、向量化、ASR、处理、渲染、
      导出、任务包、备份、清理缓存。用户要能在这里看到「谁在跑、跑到哪、为什么失败」。
    · docs/04 §2.2 —— 任务持久化：启动时把 running/waiting 标记为 interrupted，
      UI 必须给出「重试 / 丢弃」的选择，因此 interrupted 与 failed 一样提供重试。
    · docs/04 §2.4 —— 进度只来自 `task:progress`；本页**不自建进度 UI**，
      复用 shared/ui/TaskProgressCard.vue（它自己订阅 taskId）。
    · docs/20 §7  —— 窗口重建后要用 task:list 恢复列表（tasks.refresh 负责）。
    · docs/01 §3.2 —— 大列表（>200 条任务）用虚拟滚动：这里手写 computeVisibleRange，
      不用 el-table 承载全部行（el-table 会把每行都挂到 DOM 上）。
    · docs/22 §6.2 —— 消息只走 error-bus；本页不写任何错误文案，只展示主进程给的内容。

  订阅约定：`useTasksStore().init()` 会在应用级订阅 task:progress / task:finished，
  因此**页面卸载时不要 dispose**（订阅属于 App.vue 的生命周期）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useTasksStore } from '@/app/store/tasks.store.ts'
import { computeVisibleRange } from '@/shared/lib/virtual-list.ts'
import { formatDate, formatDuration, formatInt, formatRelativeTime } from '@/shared/lib/format.ts'
import { SEVERITY_LABELS, TASK_KIND_LABELS } from '@shared/constants.ts'
import type { TaskKind, TaskRecord, TaskStatus } from '@shared/types.ts'

const router = useRouter()
const tasks = useTasksStore()
const session = useSessionStore()

// ============================================================================
// 文案与配色（任务状态是业务枚举，不是错误码，因此标签写在这里）
// ============================================================================

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '排队中',
  waiting: '等待中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被中断',
}

const STATUS_TAGS: Record<TaskStatus, 'primary' | 'success' | 'info' | 'warning' | 'danger'> = {
  queued: 'info',
  waiting: 'info',
  running: 'primary',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'info',
  interrupted: 'warning',
}

/** 排序权重：把「需要人管」的状态放前面 */
const STATUS_ORDER: TaskStatus[] = ['running', 'waiting', 'queued', 'failed', 'interrupted', 'cancelled', 'succeeded']

const STATUS_OPTIONS = STATUS_ORDER.map(value => ({ value, label: STATUS_LABELS[value] }))
const KIND_OPTIONS = (Object.keys(TASK_KIND_LABELS) as TaskKind[])
  .map(kind => ({ value: kind, label: TASK_KIND_LABELS[kind] ?? kind }))

// ============================================================================
// 统计卡
// ============================================================================

const stats = computed(() => ({
  running: tasks.records.filter(record => tasks.isRunning(record.status)).length,
  succeeded: tasks.records.filter(record => record.status === 'succeeded').length,
  failed: tasks.records.filter(record => record.status === 'failed' || record.status === 'interrupted').length,
  cancelled: tasks.records.filter(record => record.status === 'cancelled').length,
}))

// ============================================================================
// 筛选与排序
// ============================================================================

const statusFilter = ref<TaskStatus[]>([])
const kindFilter = ref<TaskKind[]>([])
const projectFilter = ref<string | null>(null)
const sortKey = ref<'createdAt-desc' | 'createdAt-asc' | 'status'>('createdAt-desc')

const projectOptions = computed(() => {
  const ids = new Set<string>()
  for (const record of tasks.records) {
    if (record.projectId) ids.add(record.projectId)
  }
  return [...ids]
})

function matches(record: TaskRecord): boolean {
  if (statusFilter.value.length && !statusFilter.value.includes(record.status)) return false
  if (kindFilter.value.length && !kindFilter.value.includes(record.kind)) return false
  if (projectFilter.value && record.projectId !== projectFilter.value) return false
  return true
}

const visibleTasks = computed<TaskRecord[]>(() => {
  const list = tasks.records.filter(matches)
  if (sortKey.value === 'status') {
    return [...list].sort((a, b) => {
      const diff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      return diff !== 0 ? diff : b.createdAt - a.createdAt
    })
  }
  if (sortKey.value === 'createdAt-asc') return [...list].sort((a, b) => a.createdAt - b.createdAt)
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
})

function resetFilters(): void {
  statusFilter.value = []
  kindFilter.value = []
  projectFilter.value = null
}

function onlyFailed(): void {
  statusFilter.value = ['failed', 'interrupted']
}

// ============================================================================
// 虚拟滚动（docs/01 §3.2：长列表必须虚拟化）
// ============================================================================

/** 行高固定 76px：等高行才能用 computeVisibleRange 的等行高版本 */
const ROW_HEIGHT = 76

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(480)

const range = computed(() => computeVisibleRange({
  scrollTop: scrollTop.value,
  viewportHeight: viewportHeight.value,
  rowHeight: ROW_HEIGHT,
  total: visibleTasks.value.length,
  overscan: 6,
}))

const visibleRows = computed<Array<{ task: TaskRecord; index: number }>>(() => {
  const current = range.value
  if (current.endIndex < current.startIndex) return []
  const rows: Array<{ task: TaskRecord; index: number }> = []
  for (let index = current.startIndex; index <= current.endIndex; index++) {
    const task = visibleTasks.value[index]
    if (task) rows.push({ task, index })
  }
  return rows
})

function onScroll(): void {
  scrollTop.value = viewport.value?.scrollTop ?? 0
}

let resizeObserver: ResizeObserver | null = null

// ============================================================================
// 行内展示
// ============================================================================

function percentOf(record: TaskRecord): number {
  return Math.round(Math.min(1, Math.max(0, tasks.progressOf(record.id))) * 100)
}

function progressStatus(record: TaskRecord): 'success' | 'exception' | 'warning' | '' {
  if (record.status === 'succeeded') return 'success'
  if (record.status === 'failed') return 'exception'
  if (record.status === 'interrupted') return 'warning'
  return ''
}

function etaText(record: TaskRecord): string {
  const etaMs = tasks.etaOf(record.id)
  if (etaMs === null || etaMs === undefined) return ''
  return formatDuration(etaMs)
}

function canRetry(record: TaskRecord): boolean {
  return record.status === 'failed' || record.status === 'interrupted' || record.status === 'cancelled'
}

function onCancel(record: TaskRecord): void {
  void tasks.cancel(record.id)
}

async function onRetry(record: TaskRecord): Promise<void> {
  const newId = await tasks.retry(record.id)
  if (newId) {
    selectedId.value = newId
    await loadResult(newId)
  }
}

// ============================================================================
// 详情面板（全字段 + 进度卡 + 结果 + 错误 + 日志入口）
// ============================================================================

const drawerVisible = ref(false)
const selectedId = ref<string | null>(null)
const selected = computed<TaskRecord | null>(
  () => tasks.records.find(record => record.id === selectedId.value) ?? null,
)

const resultBusy = ref(false)
const resultValue = ref<unknown>(null)

async function loadResult(taskId: string): Promise<void> {
  resultBusy.value = true
  resultValue.value = null
  try {
    resultValue.value = await tasks.result(taskId)
  } finally {
    resultBusy.value = false
  }
}

function openDetail(record: TaskRecord): void {
  selectedId.value = record.id
  drawerVisible.value = true
  void loadResult(record.id)
}

/** 结果的 JSON 预览（结果形状随任务类型变化，因此以 JSON 为准） */
const resultJson = computed(() => {
  const value = resultValue.value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
})

interface SummaryRow {
  label: string
  value: string
}

/**
 * 结构化摘要：结果里有明确字段时优先给人看的表格，
 * 没有就退回 JSON 预览（导出报告、回收报告、备份结果都走这一条）。
 */
const resultSummary = computed<SummaryRow[]>(() => {
  const value = resultValue.value
  if (!value || typeof value !== 'object') return []
  const data = value as Record<string, unknown>
  const rows: SummaryRow[] = []

  const summary = data.summary
  if (summary && typeof summary === 'object') {
    const detail = summary as Record<string, unknown>
    const keys: Array<[string, string]> = [
      ['total', '章节总数'],
      ['succeeded', '成功'],
      ['skipped', '跳过'],
      ['failed', '失败'],
      ['warnings', '警告'],
    ]
    for (const [key, label] of keys) {
      const number = detail[key]
      if (typeof number === 'number') rows.push({ label, value: formatInt(number) })
    }
    const duration = detail.totalDurationMs
    if (typeof duration === 'number') rows.push({ label: '成品总时长', value: formatDuration(duration) })
  }

  const m4b = data.m4b
  if (m4b && typeof m4b === 'object') {
    const detail = m4b as Record<string, unknown>
    if (typeof detail.path === 'string') rows.push({ label: 'M4B 产物', value: detail.path })
    if (typeof detail.chapters === 'number') rows.push({ label: 'M4B 章节数', value: formatInt(detail.chapters) })
    if (typeof detail.verified === 'boolean') rows.push({ label: 'M4B 校验', value: detail.verified ? '通过' : '未通过' })
  }

  if (typeof data.chapterCount === 'number') rows.push({ label: '章节数', value: formatInt(data.chapterCount) })
  if (typeof data.imported === 'number') rows.push({ label: '已导入', value: formatInt(data.imported) })
  if (typeof data.bookId === 'string') rows.push({ label: '书籍 ID', value: data.bookId })
  if (typeof data.path === 'string') rows.push({ label: '产物路径', value: data.path })
  if (typeof data.cleared === 'number') rows.push({ label: '已清理', value: formatInt(data.cleared) })

  // 任务包回收报告（TaskPackageMergeReport）
  if (typeof data.placed === 'number') rows.push({ label: '已归档片段', value: formatInt(data.placed) })
  if (typeof data.adopted === 'number') rows.push({ label: '采纳试录', value: formatInt(data.adopted) })
  if (Array.isArray(data.missing)) rows.push({ label: '缺失行', value: formatInt(data.missing.length) })
  if (Array.isArray(data.unknown)) rows.push({ label: '未知行', value: formatInt(data.unknown.length) })
  if (typeof data.checksumFailed === 'number') rows.push({ label: '校验失败', value: formatInt(data.checksumFailed) })
  if (typeof data.linesChanged === 'boolean') rows.push({ label: '画本已变更', value: data.linesChanged ? '是' : '否' })

  return rows
})

/** 错误展示：主进程给的是 JSON（{ code, message, details }），能解析就拆开显示 */
const errorView = computed<{ code: string; severity: string; message: string; details: string } | null>(() => {
  const raw = selected.value?.error
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { code?: string; severity?: string; message?: string; details?: unknown }
    if (parsed && typeof parsed === 'object') {
      return {
        code: typeof parsed.code === 'string' ? parsed.code : '',
        severity: typeof parsed.severity === 'string' ? parsed.severity : '',
        message: typeof parsed.message === 'string' ? parsed.message : raw,
        details: parsed.details ? JSON.stringify(parsed.details, null, 2) : '',
      }
    }
  } catch {
    // 不是 JSON（旧版本写入的纯字符串）：原样显示，不改写主进程给的文案
  }
  return { code: '', severity: '', message: raw, details: '' }
})

function severityLabel(severity: string): string {
  return (SEVERITY_LABELS as Record<string, string>)[severity] ?? severity
}

// ============================================================================
// 清空已结束（二次确认）
// ============================================================================

const clearVisible = ref(false)
const clearBusy = ref(false)

async function confirmClear(): Promise<void> {
  clearBusy.value = true
  try {
    await tasks.clearFinished()
    clearVisible.value = false
  } finally {
    clearBusy.value = false
  }
}

function gotoLogs(): void {
  void router.push({ path: '/settings', query: { focus: 'diagnostics' } })
}

// ============================================================================
// 生命周期
// ============================================================================

onMounted(() => {
  // 应用级订阅（App.vue 已 init，这里再调一次是幂等的：store 内部有 unsubscribe 守卫）
  tasks.init()
  void tasks.refresh({ limit: 500 })

  const el = viewport.value
  if (!el) return
  viewportHeight.value = el.clientHeight || viewportHeight.value
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      viewportHeight.value = el.clientHeight || viewportHeight.value
    })
    resizeObserver.observe(el)
  }
})

onBeforeUnmount(() => {
  // 只断开本页自己的 ResizeObserver：
  // **不要** tasks.dispose()，任务订阅属于应用级（App.vue 负责建立与释放）
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div class="ns-tasks">
    <!-- ── 统计卡 ───────────────────────────────────────────────────── -->
    <header class="ns-tasks__head">
      <div class="ns-tasks__stats">
        <div class="ns-stat">
          <span class="ns-stat__label">进行中</span>
          <strong class="ns-stat__value">{{ formatInt(stats.running) }}</strong>
        </div>
        <div class="ns-stat ns-stat--ok">
          <span class="ns-stat__label">成功</span>
          <strong class="ns-stat__value">{{ formatInt(stats.succeeded) }}</strong>
        </div>
        <div class="ns-stat" :class="{ 'ns-stat--bad': stats.failed > 0 }">
          <span class="ns-stat__label">失败 / 中断</span>
          <strong class="ns-stat__value">{{ formatInt(stats.failed) }}</strong>
        </div>
        <div class="ns-stat">
          <span class="ns-stat__label">已取消</span>
          <strong class="ns-stat__value">{{ formatInt(stats.cancelled) }}</strong>
        </div>
      </div>

      <div class="ns-tasks__head-actions">
        <el-button size="small" :loading="tasks.loading" @click="tasks.refresh({ limit: 500 })">刷新</el-button>
        <el-button size="small" @click="clearVisible = true">清空已结束</el-button>
      </div>
    </header>

    <!-- 有失败任务时统一给红条（比在列表里散布红字更容易被发现） -->
    <div v-if="tasks.hasFailure" class="ns-tasks__alert" role="alert">
      <span>有失败或被中断的任务：它们不会自动重跑，可以点「重试」重新入队（重试会新建一条任务记录）。</span>
      <el-button size="small" type="danger" plain @click="onlyFailed">只看失败</el-button>
    </div>

    <!-- ── 筛选 ─────────────────────────────────────────────────────── -->
    <section class="ns-tasks__filters">
      <el-select
        v-model="statusFilter"
        class="ns-filter"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="状态（全部）"
      >
        <el-option v-for="item in STATUS_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>

      <el-select
        v-model="kindFilter"
        class="ns-filter ns-filter--wide"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="任务类型（全部）"
      >
        <el-option v-for="item in KIND_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>

      <el-select v-model="projectFilter" class="ns-filter" clearable placeholder="项目（全部）">
        <el-option
          v-for="id in projectOptions"
          :key="id"
          :label="id === session.projectId ? `${id}（当前项目）` : id"
          :value="id"
        />
      </el-select>

      <el-select v-model="sortKey" class="ns-filter ns-filter--sm">
        <el-option label="创建时间（新→旧）" value="createdAt-desc" />
        <el-option label="创建时间（旧→新）" value="createdAt-asc" />
        <el-option label="按状态（需处理的在前）" value="status" />
      </el-select>

      <el-button size="small" @click="resetFilters">重置筛选</el-button>
      <span class="ns-tasks__count">
        共 {{ formatInt(tasks.records.length) }} 条，当前显示 {{ formatInt(visibleTasks.length) }} 条
      </span>
    </section>

    <!-- ── 列表（虚拟滚动）────────────────────────────────────────── -->
    <LoadingBlock v-if="tasks.loading && !tasks.records.length" variant="skeleton" text="正在读取任务列表…" :rows="5" />

    <EmptyState
      v-else-if="!visibleTasks.length"
      icon="⏱"
      title="这里还没有任务"
      :description="tasks.records.length
        ? '当前筛选条件下没有任务；试试「重置筛选」。'
        : '导入书籍、生成画本、批量处理、混音渲染、导出成品等耗时操作都会出现在这里，可以随时取消与重试。'"
      hint="任务的进度、阶段文案与剩余时间全部来自主进程，界面只负责显示。"
      action-text="去书架看看"
      @action="router.push('/bookshelf')"
    />

    <div v-else class="ns-tasks__viewport-wrap">
      <div ref="viewport" class="ns-tasks__viewport" @scroll="onScroll">
        <!-- 上占位：把可见行推到正确位置（paddingTop 由 computeVisibleRange 给出） -->
        <div class="ns-tasks__spacer" :style="{ height: `${range.paddingTop}px` }" />

        <div
          v-for="row in visibleRows"
          :key="row.task.id"
          class="ns-task-row"
          :class="{
            'is-active': selectedId === row.task.id,
            'is-failed': row.task.status === 'failed' || row.task.status === 'interrupted',
          }"
          :style="{ height: `${ROW_HEIGHT}px` }"
          @click="openDetail(row.task)"
        >
          <div class="ns-task-row__line">
            <el-tag size="small" effect="plain">{{ TASK_KIND_LABELS[row.task.kind] ?? row.task.kind }}</el-tag>
            <el-tag size="small" :type="STATUS_TAGS[row.task.status]">{{ STATUS_LABELS[row.task.status] }}</el-tag>
            <span class="ns-task-row__stage">{{ tasks.stageOf(row.task.id) || '—' }}</span>
            <span v-if="etaText(row.task)" class="ns-task-row__eta">剩余 {{ etaText(row.task) }}</span>
          </div>

          <div class="ns-task-row__line ns-task-row__line--bar">
            <el-progress
              class="ns-task-row__progress"
              :percentage="percentOf(row.task)"
              :stroke-width="6"
              :status="progressStatus(row.task)"
              :show-text="false"
            />
            <span class="ns-task-row__percent">{{ percentOf(row.task) }}%</span>

            <span class="ns-task-row__meta">尝试 {{ row.task.attempts }}/{{ row.task.maxAttempts }}</span>
            <span class="ns-task-row__meta">创建 {{ formatRelativeTime(row.task.createdAt) }}</span>
            <span v-if="row.task.finishedAt" class="ns-task-row__meta">
              结束 {{ formatDate(row.task.finishedAt, 'MM-DD HH:mm') }}
            </span>

            <span class="ns-task-row__actions" @click.stop>
              <el-button size="small" link @click="openDetail(row.task)">详情</el-button>
              <el-button v-if="tasks.isRunning(row.task.status)" size="small" link @click="onCancel(row.task)">取消</el-button>
              <el-button v-if="canRetry(row.task)" size="small" link type="primary" @click="onRetry(row.task)">重试</el-button>
            </span>
          </div>
        </div>

        <!-- 下占位：保证滚动条长度与总行数一致 -->
        <div class="ns-tasks__spacer" :style="{ height: `${range.paddingBottom}px` }" />
      </div>

      <p class="ns-tasks__virtual-note">
        已启用虚拟滚动：{{ formatInt(visibleTasks.length) }} 条任务里只渲染当前可见的
        {{ range.renderCount }} 行（滚动时行高固定，因此可以精确计算位置）。
      </p>
    </div>

    <!-- ── 详情抽屉 ────────────────────────────────────────────────── -->
    <el-drawer v-model="drawerVisible" title="任务详情" size="560px" :destroy-on-close="true">
      <template v-if="selected">
        <TaskProgressCard
          :task-id="selected.id"
          :title="TASK_KIND_LABELS[selected.kind] ?? selected.kind"
          :error-message="selected.error"
          :openable="false"
          @cancel="onCancel(selected)"
          @retry="onRetry(selected)"
        />

        <h4 class="ns-detail__title">任务记录</h4>
        <dl class="ns-kv">
          <div class="ns-kv__row"><dt>任务 ID</dt><dd class="ns-mono">{{ selected.id }}</dd></div>
          <div class="ns-kv__row"><dt>类型</dt><dd>{{ TASK_KIND_LABELS[selected.kind] ?? selected.kind }}（{{ selected.kind }}）</dd></div>
          <div class="ns-kv__row"><dt>状态</dt><dd>{{ STATUS_LABELS[selected.status] }}（{{ selected.status }}）</dd></div>
          <div class="ns-kv__row"><dt>优先级</dt><dd>{{ selected.priority }}（越小越先；用户触发为 0，后台维护为 100）</dd></div>
          <div class="ns-kv__row"><dt>项目 ID</dt><dd class="ns-mono">{{ selected.projectId ?? '—' }}</dd></div>
          <div class="ns-kv__row"><dt>进度</dt><dd>{{ percentOf(selected) }}%</dd></div>
          <div class="ns-kv__row"><dt>阶段</dt><dd>{{ tasks.stageOf(selected.id) || '—' }}</dd></div>
          <div class="ns-kv__row"><dt>尝试次数</dt><dd>{{ selected.attempts }} / {{ selected.maxAttempts }}</dd></div>
          <div class="ns-kv__row"><dt>互斥键</dt><dd class="ns-mono">{{ selected.concurrencyKey ?? '—' }}</dd></div>
          <div class="ns-kv__row"><dt>去重键</dt><dd class="ns-mono">{{ selected.dedupeKey ?? '—' }}</dd></div>
          <div class="ns-kv__row"><dt>创建时间</dt><dd>{{ formatDate(selected.createdAt) }}</dd></div>
          <div class="ns-kv__row"><dt>开始时间</dt><dd>{{ selected.startedAt ? formatDate(selected.startedAt) : '—' }}</dd></div>
          <div class="ns-kv__row"><dt>结束时间</dt><dd>{{ selected.finishedAt ? formatDate(selected.finishedAt) : '—' }}</dd></div>
        </dl>

        <h4 class="ns-detail__title">错误</h4>
        <template v-if="errorView">
          <p class="ns-detail__error">
            <el-tag v-if="errorView.code" size="small" type="danger">{{ errorView.code }}</el-tag>
            <el-tag v-if="errorView.severity" size="small" type="warning">
              {{ severityLabel(errorView.severity) }}
            </el-tag>
            {{ errorView.message }}
          </p>
          <pre v-if="errorView.details" class="ns-detail__pre">{{ errorView.details }}</pre>
          <p class="ns-detail__note">
            这段文案来自主进程（消息表的插值结果），任务中心不重复加工，避免同一件事出现两种说法。
          </p>
        </template>
        <p v-else class="ns-detail__note">这条任务没有错误信息。</p>

        <h4 class="ns-detail__title">结果</h4>
        <p v-if="resultBusy" class="ns-detail__note">正在读取结果…</p>
        <template v-else-if="resultValue === null || resultValue === undefined">
          <p class="ns-detail__note">这条任务还没有结果（进行中、被取消或失败的任务通常没有结果）。</p>
        </template>
        <template v-else>
          <el-table v-if="resultSummary.length" :data="resultSummary" size="small">
            <el-table-column prop="label" label="项" width="150" />
            <el-table-column prop="value" label="值" min-width="240" show-overflow-tooltip />
          </el-table>
          <el-collapse class="ns-detail__collapse">
            <el-collapse-item title="查看完整 JSON" name="json">
              <pre class="ns-detail__pre">{{ resultJson }}</pre>
            </el-collapse-item>
          </el-collapse>
        </template>

        <div class="ns-detail__actions">
          <el-button size="small" @click="loadResult(selected.id)">重新读取结果</el-button>
          <el-button size="small" @click="gotoLogs">查看日志与诊断</el-button>
          <el-button v-if="canRetry(selected)" size="small" type="primary" @click="onRetry(selected)">重试</el-button>
        </div>
      </template>

      <p v-else class="ns-detail__note">任务已从列表移除（清空已结束后会看不到历史记录）。</p>
    </el-drawer>

    <ConfirmDialog
      v-model="clearVisible"
      type="warning"
      title="清空已结束的任务？"
      message="只清理列表记录，不会影响已经产出的文件。"
      :details="[
        `将被清理：成功 ${stats.succeeded} 条、失败/中断 ${stats.failed} 条、已取消 ${stats.cancelled} 条`,
        '进行中的任务不受影响，仍会继续执行。',
        '清理后这些任务的历史与结果将无法在任务中心再次查看（日志里仍有记录）。',
      ]"
      confirm-text="清空已结束"
      :loading="clearBusy"
      @confirm="confirmClear"
    />
  </div>
</template>

<style scoped>
.ns-tasks {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}
.ns-tasks__head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.ns-tasks__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.ns-stat {
  display: flex;
  min-width: 128px;
  flex-direction: column;
  padding: 8px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-stat--ok {
  border-color: rgb(103 194 58 / 45%);
}
.ns-stat--bad {
  border-color: var(--ns-danger, #f56c6c);
  background: rgb(245 108 108 / 8%);
}
.ns-stat__label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-stat__value {
  color: var(--ns-text-primary, #303133);
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.ns-tasks__head-actions {
  display: flex;
  gap: 8px;
}
.ns-tasks__alert {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-left: 4px solid var(--ns-danger, #f56c6c);
  border-radius: 6px;
  background: rgb(245 108 108 / 12%);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
}
.ns-tasks__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.ns-filter {
  width: 190px;
}
.ns-filter--wide {
  width: 240px;
}
.ns-filter--sm {
  width: 210px;
}
.ns-tasks__count {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-tasks__viewport-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-tasks__viewport {
  /* 固定高度的滚动容器：虚拟滚动需要一个已知视口高度 */
  height: calc(100vh - 320px);
  min-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-tasks__spacer {
  width: 100%;
}
.ns-task-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  justify-content: center;
  box-sizing: border-box;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ns-fill, #ebeef5);
  cursor: pointer;
}
.ns-task-row:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-task-row.is-active {
  background: rgb(64 158 255 / 8%);
}
.ns-task-row.is-failed {
  border-left: 3px solid var(--ns-danger, #f56c6c);
}
.ns-task-row__line {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.ns-task-row__line--bar {
  gap: 10px;
}
.ns-task-row__stage {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-task-row__eta {
  color: var(--ns-primary, #409eff);
  font-size: 12px;
}
.ns-task-row__progress {
  flex: 1 1 180px;
  min-width: 120px;
}
.ns-task-row__percent {
  flex: 0 0 42px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.ns-task-row__meta {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  white-space: nowrap;
}
.ns-task-row__actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.ns-tasks__virtual-note {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-detail__title {
  margin: 16px 0 6px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-detail__error {
  margin: 0;
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
  line-height: 1.7;
}
.ns-detail__note {
  margin: 6px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-detail__pre {
  max-height: 260px;
  margin: 6px 0 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.ns-detail__collapse {
  margin-top: 8px;
}
.ns-detail__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0 24px;
}
.ns-kv {
  margin: 0;
}
.ns-kv__row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.7;
}
.ns-kv__row dt {
  flex: 0 0 96px;
  color: var(--ns-text-secondary, #909399);
}
.ns-kv__row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ns-text-regular, #606266);
  word-break: break-all;
}
.ns-mono {
  font-family: ui-monospace, Consolas, monospace;
}
</style>
