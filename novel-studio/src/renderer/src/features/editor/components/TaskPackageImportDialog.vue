<!--
  Novel Studio · 任务包导入与回收合并（docs/11 §6.4 回收合并 / §6.5 画本变更后重发）
  ============================================================================
  设计依据：
    · docs/11 §6.4 —— 回收流程：读包校验（格式版本 / checksums）→ 比对 linesHash
      → 逐行归位（存在即入库 take、不存在记 unknownLines、损坏跳过）→
      冲突处理（同 line 已有 take 则追加、同 takeId 重复按内容去重）→ 生成回收报告。
      **回收报告必须落到 UI 上**（placed / missing / unknown / checksumFailed /
      corrupted / linesChanged / diffCount / duplicateTakes / adopted）。
    · docs/11 §6.5 —— `linesHash` 不一致 → 提供「重新导出任务包（仅含变更行）」的增量下发入口。
    · messages.ts  PACKAGE_LINES_CHANGED / PACKAGE_MERGE_PARTIAL / PACKAGE_INVALID ——
      「画本已变更」必须**显著提示 + 需人工确认**，提示文案一律走 error-bus（不自己拼）。

  分工：inspect / mergeTask / 报告 / 历史全部在 packages.store（状态不随对话框关闭丢失），
  本组件只负责「选文件 → 调 store → 展示报告」。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Id, PackageHistoryEntry, TaskPackageMergeReport } from '@shared/types.ts'
import { formatCount, formatDate, formatInt, formatRelativeTime } from '@/shared/lib/format.ts'
import { call } from '@/shared/lib/ipc.ts'
import { reportByKey } from '@/shared/lib/error-bus.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { usePackagesStore } from '@/features/editor/stores/packages.store.ts'

const props = withDefaults(defineProps<{
  /** 双向绑定：是否显示 */
  modelValue: boolean
  /** 只读（画本来自任务包且未合并时，禁止在导入流程里改画本） */
  readonly?: boolean
}>(), { readonly: false })

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 合并完成（父组件刷新画本 / 质检 / 状态栏） */
  merged: [report: TaskPackageMergeReport]
  /** 请求「仅重发变更行」的增量导出（父组件打开导出对话框并勾上 onlyChangedLines） */
  'request-incremental-export': []
}>()

const session = useSessionStore()
const packages = usePackagesStore()

/** 选中的包文件 */
const path = ref('')
const report = ref<TaskPackageMergeReport | null>(null)
const feedback = ref('')
const picking = ref(false)
const showHistory = ref(false)

const projectId = computed<Id | null>(() => session.projectId)
const inspect = computed(() => packages.inspectResult)

// ── 合并任务进度 ─────────────────────────────────────────────────────────────
const live = useTaskProgress(computed(() => packages.mergeTaskId))

watch([live.isFinished, live.status], async ([finished, status]) => {
  if (!finished) return
  if (status !== 'succeeded') {
    feedback.value = '合并任务未成功结束，可在任务中心查看原因后重试。'
    return
  }
  const result = await packages.fetchMergeReport(packages.mergeTaskId)
  if (!result) {
    feedback.value = '任务已完成，但没读到回收报告；可点「最近一次回收报告」再看一次。'
    return
  }
  applyReport(result)
})

/** 报告落地后的统一提示（docs/11 §6.4/§6.5：先把「需人工确认」说清楚） */
function applyReport(next: TaskPackageMergeReport): void {
  report.value = next
  feedback.value = next.adopted > 0
    ? `已归位 ${formatCount(next.placed)} 行，其中 ${formatCount(next.adopted)} 条原本没有录音的行已自动设为成品。`
    : `已归位 ${formatCount(next.placed)} 行。`

  if (next.linesChanged) {
    // 关键：不是错误，但必须让人看见 —— 走 error-bus 的 PACKAGE_LINES_CHANGED
    reportByKey('PACKAGE_LINES_CHANGED', { count: next.diffCount })
  }
  const unplaced = next.missing.length + next.unknown.length + next.corrupted + next.checksumFailed
  if (unplaced > 0) {
    reportByKey('PACKAGE_MERGE_PARTIAL', {
      ok: next.placed,
      missing: next.missing.length + next.corrupted + next.checksumFailed,
      unknown: next.unknown.length,
    })
  }
  emit('merged', next)
}

// ── 选文件与识别 ─────────────────────────────────────────────────────────────
async function pickFile(): Promise<void> {
  feedback.value = ''
  picking.value = true
  try {
    const picked = await call('app:openFileDialog', {
      title: '选择任务包（.nst）或项目包（.nsp）',
      filters: [{ name: '任务包 / 项目包', extensions: ['nst', 'nsp', 'zip'] }],
      multi: false,
    })
    const first = picked.paths?.[0]
    if (!first) return
    path.value = first
    report.value = null
    const result = await packages.inspect(first)
    if (!result) {
      // PACKAGE_INVALID 已由 store 的 call 走 error-bus 提示，这里只留一句可操作的引导
      feedback.value = '这个文件没能识别成任务包：请确认对方发送的包完整（或重新导出一次）。'
      return
    }
    feedback.value = result.kind === 'nst'
      ? '已识别为「任务包 .nst」：里面是某位配音员的录音回传，可直接回收合并。'
      : '已识别为「项目包 .nsp」：这是整项目备份包，合并会覆盖项目级配置，请确认后再继续。'
  } finally {
    picking.value = false
  }
}

// ── 合并 ─────────────────────────────────────────────────────────────────────
async function startMerge(): Promise<void> {
  feedback.value = ''
  if (props.readonly) {
    feedback.value = '当前为只读模式，不能执行回收合并。'
    return
  }
  if (!path.value) {
    feedback.value = '先选择一个任务包文件。'
    return
  }
  if (!projectId.value) {
    feedback.value = '没有当前项目：请先从书架打开一本书。'
    return
  }
  packages.setProjectId(projectId.value)
  const taskId = await packages.mergeTask(path.value)
  if (!taskId) feedback.value = '合并没有启动成功（详见提示），可检查包文件后重试。'
}

async function loadLastReport(): Promise<void> {
  packages.setProjectId(projectId.value)
  const last = await packages.loadLastMergeReport()
  if (!last) {
    feedback.value = '还没有这个项目的回收报告记录。'
    return
  }
  applyReport(last)
}

// ── 历史记录 ─────────────────────────────────────────────────────────────────
async function loadHistory(): Promise<void> {
  showHistory.value = true
  packages.setProjectId(projectId.value)
  await packages.loadHistory()
}

function inspectHistory(entry: PackageHistoryEntry): void {
  if (entry.report) {
    report.value = entry.report
    feedback.value = `来自历史记录：${entry.actorName ?? '未知来源'} · ${formatDate(entry.createdAt)}`
    return
  }
  feedback.value = `这条历史（${entry.direction}）没有保存回收报告明细。`
}

const DIRECTION_LABELS: Record<PackageHistoryEntry['direction'], string> = {
  export: '导出',
  import: '导入',
  merge: '回收合并',
}

const KIND_LABELS: Record<PackageHistoryEntry['kind'], string> = {
  nsp: '项目包',
  nst: '任务包',
}

// ── 打开时准备 ───────────────────────────────────────────────────────────────
watch(() => props.modelValue, async (visible) => {
  if (!visible) return
  feedback.value = ''
  packages.setProjectId(projectId.value)
  await packages.loadHistory()
  if (!report.value && packages.mergeReport) report.value = packages.mergeReport
})

function close(): void {
  emit('update:modelValue', false)
}

/** 对话框显隐：el-dialog 的 update:model-value 载荷为 boolean */
function onVisibleInput(value: boolean): void {
  emit('update:modelValue', value)
}

/** 报告里需要人工处理的总数（缺漏 + 未知 + 损坏 + 校验失败） */
const unplacedCount = computed(() => {
  const r = report.value
  if (!r) return 0
  return r.missing.length + r.unknown.length + r.corrupted + r.checksumFailed
})
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    title="导入 / 回收任务包"
    width="720px"
    :close-on-click-modal="false"
    @update:model-value="onVisibleInput"
  >
    <div class="ns-nsi">
      <template v-if="!projectId">
        <EmptyState
          size="small"
          icon="📚"
          title="还没有打开项目"
          description="回收合并需要知道把录音归到哪个项目：先从书架打开一本书。"
        />
      </template>

      <template v-else>
        <!-- 1. 选包与识别 -->
        <section class="ns-nsi__section">
          <h4 class="ns-nsi__title">1. 选择任务包</h4>
          <div class="ns-nsi__row">
            <el-button size="small" :loading="picking" @click="pickFile">选择文件…</el-button>
            <span class="ns-nsi__path">{{ path || '（还没有选择文件）' }}</span>
            <el-button size="small" text @click="loadLastReport">最近一次回收报告</el-button>
          </div>

          <div v-if="inspect" class="ns-nsi__summary">
            <el-tag size="small" :type="inspect.kind === 'nst' ? 'primary' : 'warning'">
              {{ inspect.kind === 'nst' ? '任务包 .nst' : '项目包 .nsp' }}
            </el-tag>
            <span class="ns-nsi__muted">格式版本 {{ inspect.formatVersion }}</span>
            <p class="ns-nsi__summary-text">{{ inspect.summary }}</p>
          </div>
          <LoadingBlock v-else-if="packages.busy" text="正在读取包摘要…" />
        </section>

        <!-- 2. 执行合并 -->
        <section class="ns-nsi__section">
          <h4 class="ns-nsi__title">2. 回收合并</h4>
          <div class="ns-nsi__row">
            <el-button type="primary" size="small" :disabled="props.readonly || !path" @click="startMerge">
              开始回收合并
            </el-button>
            <el-button size="small" text @click="loadHistory">查看历史记录</el-button>
            <el-button size="small" text @click="close">关闭</el-button>
          </div>
          <p class="ns-nsi__muted">
            合并会逐行归位：lineId 存在则音频入库为 take（同 line 已有 take 只追加、不覆盖），
            lineId 不存在记入待处理，文件损坏或校验失败则跳过并记录 —— 绝不整体失败。
          </p>

          <TaskProgressCard
            v-if="packages.mergeTaskId"
            :task-id="packages.mergeTaskId"
            title="回收合并任务包"
            kind="package.merge"
            @retry="startMerge"
          />

          <p v-if="feedback" class="ns-nsi__feedback">{{ feedback }}</p>
        </section>

        <!-- 3. 回收报告 -->
        <section v-if="report" class="ns-nsi__section">
          <h4 class="ns-nsi__title">3. 回收报告</h4>

          <div v-if="report.linesChanged" class="ns-nsi__alert is-danger">
            <strong>画本已变更，需人工确认。</strong>
            与下发时的 linesHash 不一致，共 {{ formatCount(report.diffCount) }} 处差异。
            已按 lineId 归位，无法对应的行放进了下面的「缺漏 / 未知」列表；
            确认无误后可「仅重发变更行」做一次增量下发，不用让配音员重录全部。
            <el-button size="small" type="primary" plain @click="emit('request-incremental-export')">
              重新导出任务包（仅变更行）
            </el-button>
          </div>
          <div v-else class="ns-nsi__alert is-success">
            画本与下发时一致（linesHash 相符），全部录音已按行归位。
          </div>

          <ul class="ns-nsi__stats">
            <li>来源配音员：<strong>{{ report.actorName || '—' }}</strong></li>
            <li>已归位：<strong>{{ formatCount(report.placed) }}</strong> 行</li>
            <li>自动设为成品：{{ formatCount(report.adopted) }} 条</li>
            <li>重复 take 去重：{{ formatCount(report.duplicateTakes) }} 条</li>
            <li>缺漏行：{{ formatCount(report.missing.length) }}</li>
            <li>无法识别：{{ formatCount(report.unknown.length) }}</li>
            <li>校验失败：{{ formatCount(report.checksumFailed) }} 个文件</li>
            <li>损坏跳过：{{ formatCount(report.corrupted) }} 个文件</li>
            <li>画本差异：{{ formatCount(report.diffCount) }} 处</li>
          </ul>

          <div v-if="unplacedCount" class="ns-nsi__lists">
            <p class="ns-nsi__muted">
              需要人工处理 {{ formatCount(unplacedCount) }} 项（下列 id 可直接与对方核对）：
            </p>
            <p v-if="report.missing.length" class="ns-nsi__ids">
              <b>缺漏行 id：</b>{{ report.missing.slice(0, 20).map(id => String(id).slice(0, 8)).join('、') }}
              <span v-if="report.missing.length > 20">… 其余 {{ formatCount(report.missing.length - 20) }} 条见日志</span>
            </p>
            <p v-if="report.unknown.length" class="ns-nsi__ids">
              <b>未知行 id：</b>{{ report.unknown.slice(0, 20).map(id => String(id).slice(0, 8)).join('、') }}
              <span v-if="report.unknown.length > 20">… 其余 {{ formatCount(report.unknown.length - 20) }} 条见日志</span>
            </p>
          </div>
        </section>

        <!-- 4. 历史记录 -->
        <section v-if="showHistory" class="ns-nsi__section">
          <h4 class="ns-nsi__title">4. 历史记录（导出 / 导入 / 回收）</h4>
          <p v-if="!packages.history.length" class="ns-nsi__muted">这个项目还没有任务包历史。</p>
          <ul v-else class="ns-nsi__history">
            <li v-for="entry in packages.history" :key="entry.id" class="ns-nsi__history-item" @click="inspectHistory(entry)">
              <el-tag size="small" :type="entry.direction === 'merge' ? 'success' : 'info'">
                {{ DIRECTION_LABELS[entry.direction] }}
              </el-tag>
              <span class="ns-nsi__history-kind">{{ KIND_LABELS[entry.kind] }}</span>
              <span class="ns-nsi__history-actor">{{ entry.actorName ?? '—' }}</span>
              <span class="ns-nsi__history-time" :title="formatDate(entry.createdAt)">
                {{ formatRelativeTime(entry.createdAt) }}
              </span>
              <span class="ns-nsi__history-path" :title="entry.filePath">{{ entry.filePath }}</span>
              <span v-if="entry.report" class="ns-nsi__muted">
                归位 {{ formatInt(entry.report.placed) }} / 差异 {{ formatInt(entry.report.diffCount) }}
              </span>
              <span v-else class="ns-nsi__muted">无报告明细</span>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <template #footer>
      <span class="ns-nsi__muted">
        回收完成后，画本行状态与录音片段会一并刷新；如需复核，可在录音页的 take 列表里 A/B 对比。
      </span>
    </template>
  </el-dialog>
</template>

<style scoped>
.ns-nsi { display: flex; flex-direction: column; gap: 12px; max-height: 62vh; overflow: auto; }
.ns-nsi__section { padding-bottom: 8px; border-bottom: 1px dashed var(--ns-border-light, #e4e7ed); }
.ns-nsi__section:last-child { border-bottom: none; }
.ns-nsi__title { margin: 0 0 6px; color: var(--ns-text-primary, #303133); font-size: 12px; font-weight: 600; }
.ns-nsi__row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ns-nsi__path { flex: 1; min-width: 200px; overflow: hidden; color: var(--ns-text-secondary, #909399); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.ns-nsi__muted { color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.7; }
.ns-nsi__summary { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.ns-nsi__summary-text { flex: 1 0 100%; margin: 2px 0 0; color: var(--ns-text-regular, #606266); font-size: 12px; }
.ns-nsi__feedback { margin: 6px 0 0; color: var(--ns-warning, #e6a23c); font-size: 12px; line-height: 1.7; }
.ns-nsi__alert { margin-bottom: 8px; padding: 8px; border-radius: 4px; font-size: 12px; line-height: 1.8; }
.ns-nsi__alert.is-danger { background: rgb(230 162 60 / 14%); color: var(--ns-warning, #e6a23c); }
.ns-nsi__alert.is-success { background: rgb(103 194 58 / 12%); color: var(--ns-success, #67c23a); }
.ns-nsi__stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; list-style: none; color: var(--ns-text-regular, #606266); font-size: 12px; }
.ns-nsi__lists { margin-top: 6px; }
.ns-nsi__ids { margin: 2px 0; color: var(--ns-text-regular, #606266); font-size: 11px; word-break: break-all; }
.ns-nsi__history { margin: 0; padding: 0; list-style: none; }
.ns-nsi__history-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 3px; font-size: 11px; cursor: pointer; }
.ns-nsi__history-item:hover { background: var(--ns-fill-light, #f5f7fa); }
.ns-nsi__history-kind { color: var(--ns-text-regular, #606266); }
.ns-nsi__history-actor { color: var(--ns-text-primary, #303133); font-weight: 600; }
.ns-nsi__history-time { color: var(--ns-text-secondary, #909399); }
.ns-nsi__history-path { flex: 1; overflow: hidden; color: var(--ns-text-placeholder, #c0c4cc); text-overflow: ellipsis; white-space: nowrap; }
</style>
