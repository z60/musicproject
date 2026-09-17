<!--
  Novel Studio · 渲染前预检报告（docs/15 §6.1 / §5.5 Step 6）
  ============================================================================
  设计依据：
    · docs/15 §6.1 —— 预检项与严重度：
        阻断：缺录行、未分配说话人、磁盘空间不足
        警告：孤儿片段、take 削波标记、片段过短/过长、章节时长异常、输出文件已存在
      处理要求：「阻断项必须处理才能下一步」；警告可以「已知悉，继续」。
    · docs/15 §6.1 —— 「列出缺失行，可『仅导出已录部分』」：因此每个阻断项都带一个
      「去处理」按钮，直接跳到画本行 / 对轨 / 设置页，而不是让用户自己找。
    · docs/22 §7 —— 预检**本身**不发提示（它不是错误），只是把结果列清楚；
      真正导出时的失败才由 error-bus 统一兑现。

  为什么由本组件调 `export:preCheck`：
    预检是「Step 6 的动作」，它的入参完全来自向导态；放在组件里可以让
    「重新预检」按钮、自动预检、结果展示三者共享同一份 qc.store 状态，
    不需要视图再中转一层。IPC 仍统一走 qc.store → shared/lib/ipc.ts 的 call。
-->

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { formatDate, formatDurationLong, formatInt, formatPercent, UNKNOWN } from '@/shared/lib/format.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useQcStore } from '../stores/qc.store.ts'
import type { QcIssue, QcPreCheckRequest } from '../stores/qc.store.ts'
import type { ExportJumpTarget } from '../composables/useExportFlow.ts'

const props = withDefaults(defineProps<{
  /** 预检入参（向导 store 组装的 bookId + 章节 + 混音方案 + params；为 null 表示上下文未就绪） */
  request: QcPreCheckRequest | null
  /** 本次范围的可读描述（如「全书 120 章」），随结果一起记录 */
  scopeLabel: string
  /** 章节 id → 标题（清单里显示可读名称） */
  chapterTitles: Record<string, string>
  /** 挂载时自动跑一次（进入第 6 步时 true） */
  autoRun?: boolean
}>(), {
  autoRun: true,
})

const emit = defineEmits<{
  /** 「去处理」：由视图负责真正的路由跳转（组件不该知道路由表） */
  jump: [target: ExportJumpTarget, payload: { chapterId: string | null; lineId: string | null }]
}>()

const qc = useQcStore()

/**
 * 检查项的 kind 是自由字符串（契约里 `kind: string`，没有枚举）。
 * 因此这里用关键词做**唯一**一次映射，映射不到就退回章节列表；
 * 这样即便主进程将来新增 kind，按钮也只是变成「去章节列表」而不会报错。
 */
const KIND_LABELS: Record<string, string> = {
  missing_line: '缺录行',
  missing_lines: '缺录行',
  unassigned_speaker: '未分配说话人',
  unassigned: '未分配说话人',
  orphan_segment: '孤儿片段',
  clipped_take: '削波标记',
  short_segment: '片段过短',
  long_segment: '片段过长',
  chapter_duration: '章节时长异常',
  disk_space: '磁盘空间不足',
  output_exists: '输出文件已存在',
  output_not_writable: '输出目录不可写',
  silent_chapter: '整章静音',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function targetOf(kind: string): ExportJumpTarget {
  const key = kind.toLowerCase()
  if (key.includes('disk') || key.includes('space') || key.includes('writable') || key.includes('output')) return 'settings'
  if (key.includes('orphan') || key.includes('overlap') || key.includes('segment') || key.includes('duration') || key.includes('silence')) return 'alignment'
  if (key.includes('line') || key.includes('speaker') || key.includes('take') || key.includes('clip')) return 'canvas'
  return 'chapters'
}

function subjectOf(issue: QcIssue): string {
  if (issue.chapterId) {
    const title = props.chapterTitles[issue.chapterId]
    return title ? `《${title}》` : `章节 ${issue.chapterId}`
  }
  return '全书'
}

/** 阻断项按 kind 归组：120 章都缺录时，用户需要看到「1 类问题、N 处」而不是 N 条 */
const blockerGroups = computed(() => groupIssues(qc.blockers))
const warningGroups = computed(() => groupIssues(qc.warnings))

function groupIssues(list: QcIssue[]): Array<{ kind: string; label: string; items: QcIssue[] }> {
  const map = new Map<string, QcIssue[]>()
  for (const issue of list) {
    const arr = map.get(issue.kind) ?? []
    arr.push(issue)
    map.set(issue.kind, arr)
  }
  return [...map.entries()].map(([kind, items]) => ({ kind, label: kindLabel(kind), items }))
}

const stats = computed(() => qc.stats)
const recordedPercent = computed(() => {
  const ratio = qc.recordedRatio
  return ratio === null ? 0 : Math.round(ratio * 100)
})

const statCards = computed(() => {
  const s = stats.value
  if (!s) return []
  return [
    { key: 'chapters', label: '章节', value: formatInt(s.chapters), hint: props.scopeLabel },
    { key: 'lines', label: '画本行', value: formatInt(s.lines), hint: '待录制的全部行' },
    { key: 'recorded', label: '已录行', value: formatInt(s.recordedLines), hint: `占比 ${formatPercent(qc.recordedRatio)}` },
    { key: 'missing', label: '缺录行', value: formatInt(s.missingLines), hint: s.missingLines > 0 ? '必须补录或仅导出已录部分' : '无缺录' },
    { key: 'duration', label: '预计总时长', value: formatDurationLong(s.totalDurationMs), hint: '含头尾静音' },
    { key: 'cuts', label: '剪切标记', value: formatInt(s.cutCount), hint: '录制时标记的剪切点' },
  ]
})

const checkedAtText = computed(() => (qc.checkedAt ? formatDate(qc.checkedAt, 'HH:mm:ss') : UNKNOWN))

/** 跑一次预检（可以重复跑；新结果会清空旧的「已知悉」） */
async function run(): Promise<void> {
  const request = props.request
  if (!request) return
  await qc.run(request, props.scopeLabel)
}

onMounted(() => {
  if (props.autoRun && !qc.hasResult) void run()
})

/**
 * 注意：参数/范围变化后 `export.store` 会清空预检结果（避免用旧结果导出）。
 * 这里**不自动重跑**（预检要读全库，重跑代价高），而是由 EmptyState 明确告诉用户
 * 「还没有预检结果 → 开始预检」。
 */

function onJump(issue: QcIssue): void {
  emit('jump', targetOf(issue.kind), { chapterId: issue.chapterId, lineId: issue.lineId })
}

/** el-checkbox 的 update:model-value 只给布尔值，这里补上「是哪一条」 */
function onAcknowledgeOf(issue: QcIssue): (checked: boolean) => void {
  return (checked: boolean) => {
    if (checked) qc.acknowledge(issue)
    else qc.revokeAcknowledge(issue)
  }
}
</script>

<template>
  <section class="ns-qc">
    <header class="ns-qc__head">
      <div>
        <h3 class="ns-qc__title">渲染前预检</h3>
        <p class="ns-qc__desc">
          预检只读数据库，很快；它检查的是「缺录 / 未分配说话人 / 对轨异常 / 输出目录」这类
          <strong>渲染前就能发现</strong>的问题。阻断项必须处理，警告可以逐条「已知悉」后继续。
        </p>
      </div>
      <div class="ns-qc__head-actions">
        <span v-if="qc.hasResult" class="ns-qc__stamp">
          {{ qc.checkedScope || props.scopeLabel }} · {{ checkedAtText }} 检查
        </span>
        <el-button size="small" :loading="qc.running" :disabled="!props.request" @click="run">
          {{ qc.hasResult ? '重新预检' : '开始预检' }}
        </el-button>
      </div>
    </header>

    <LoadingBlock
      v-if="qc.running && !qc.hasResult"
      text="正在检查缺录行、说话人分配与对轨结果…"
      variant="skeleton"
      :rows="4"
      min-height="180px"
      @retry="run"
    />

    <EmptyState
      v-else-if="!qc.hasResult"
      icon="🔍"
      title="还没有预检结果"
      description="点「开始预检」检查本次范围的缺录行、未分配说话人与对轨异常。"
      :hint="props.request ? '' : '正在加载书籍与章节，稍后即可预检。'"
      action-text="开始预检"
      size="small"
      @action="run"
    />

    <template v-else>
      <!-- 统计摘要（数字卡 + 录制进度条） -->
      <div class="ns-qc__stats">
        <div v-for="card in statCards" :key="card.key" class="ns-qc__stat">
          <span class="ns-qc__stat-label">{{ card.label }}</span>
          <strong class="ns-qc__stat-value">{{ card.value }}</strong>
          <span class="ns-qc__stat-hint">{{ card.hint }}</span>
        </div>
      </div>

      <div class="ns-qc__progress">
        <el-progress
          :percentage="recordedPercent"
          :stroke-width="10"
          :status="recordedPercent >= 100 ? 'success' : undefined"
        />
        <span class="ns-qc__progress-hint">
          已录 {{ formatInt(stats?.recordedLines) }} / {{ formatInt(stats?.lines) }} 行；
          缺录 {{ formatInt(stats?.missingLines) }} 行。
        </span>
      </div>

      <!-- 阻断项 -->
      <el-alert
        v-if="qc.blockers.length === 0"
        type="success"
        :closable="false"
        show-icon
        title="没有阻断项"
        description="所有章节都具备导出条件。"
      />
      <div v-else class="ns-qc__block">
        <div class="ns-qc__block-head">
          <el-tag type="danger" effect="dark">阻断 {{ qc.blockers.length }} 项</el-tag>
          <span class="ns-qc__block-title">必须处理完才能进入下一步</span>
        </div>
        <div v-for="group in blockerGroups" :key="group.kind" class="ns-qc__group">
          <div class="ns-qc__group-head">
            <strong>{{ group.label }}</strong>
            <span class="ns-qc__group-count">{{ group.items.length }} 处</span>
          </div>
          <ul class="ns-qc__list">
            <li v-for="(issue, index) in group.items.slice(0, 20)" :key="`${group.kind}-${index}`" class="ns-qc__item">
              <span class="ns-qc__item-subject">{{ subjectOf(issue) }}</span>
              <span class="ns-qc__item-message">{{ issue.message }}</span>
              <el-button size="small" link type="primary" @click="onJump(issue)">去处理</el-button>
            </li>
          </ul>
          <p v-if="group.items.length > 20" class="ns-qc__more">
            仅显示前 20 处，其余 {{ group.items.length - 20 }} 处在导出报告与画本页可见。
          </p>
        </div>
      </div>

      <!-- 警告项 -->
      <div class="ns-qc__block ns-qc__block--warning">
        <div class="ns-qc__block-head">
          <el-tag type="warning" effect="dark">警告 {{ qc.warnings.length }} 项</el-tag>
          <span class="ns-qc__block-title">
            未确认 {{ qc.pendingWarnings.length }} 项；确认后即可继续
          </span>
          <el-button
            v-if="qc.pendingWarnings.length"
            size="small"
            link
            type="primary"
            @click="qc.acknowledgeAll()"
          >
            全部已知悉
          </el-button>
        </div>

        <p v-if="qc.warnings.length === 0" class="ns-qc__none">没有警告项。</p>

        <div v-for="group in warningGroups" :key="group.kind" class="ns-qc__group">
          <div class="ns-qc__group-head">
            <strong>{{ group.label }}</strong>
            <span class="ns-qc__group-count">{{ group.items.length }} 处</span>
          </div>
          <ul class="ns-qc__list">
            <li v-for="(issue, index) in group.items.slice(0, 20)" :key="`${group.kind}-w-${index}`" class="ns-qc__item">
              <el-checkbox
                :model-value="qc.isAcknowledged(issue)"
                @update:model-value="onAcknowledgeOf(issue)"
              >
                <span class="ns-qc__item-subject">{{ subjectOf(issue) }}</span>
                <span class="ns-qc__item-message">{{ issue.message }}</span>
              </el-checkbox>
              <el-button size="small" link type="primary" @click="onJump(issue)">去处理</el-button>
            </li>
          </ul>
          <p v-if="group.items.length > 20" class="ns-qc__more">
            仅显示前 20 处，其余 {{ group.items.length - 20 }} 处可「全部已知悉」后继续。
          </p>
        </div>
      </div>

      <p class="ns-qc__foot">
        <template v-if="qc.canProceed">
          ✓ 预检通过（无阻断项、{{ formatInt(qc.warnings.length) }} 项警告已知悉），可以开始导出。
        </template>
        <template v-else-if="qc.blockers.length">
          还有 {{ formatInt(qc.blockers.length) }} 个阻断项未处理。
        </template>
        <template v-else>
          还有 {{ formatInt(qc.pendingWarnings.length) }} 项警告未确认：逐条勾选，或点「全部已知悉」。
        </template>
      </p>
    </template>
  </section>
</template>

<style scoped>
.ns-qc {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ns-qc__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ns-qc__title {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.ns-qc__desc {
  max-width: 760px;
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-qc__head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}
.ns-qc__stamp {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-qc__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.ns-qc__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-qc__stat-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-qc__stat-value {
  color: var(--ns-text-primary, #303133);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.ns-qc__stat-hint {
  color: var(--ns-text-placeholder, #c0c4cc);
  font-size: 11px;
}
.ns-qc__progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-qc__progress-hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-qc__block {
  padding: 12px 14px;
  border: 1px solid var(--ns-danger, #f56c6c);
  border-radius: 8px;
  background: rgb(245 108 108 / 6%);
}
.ns-qc__block--warning {
  border-color: var(--ns-warning, #e6a23c);
  background: rgb(230 162 60 / 6%);
}
.ns-qc__block-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.ns-qc__block-title {
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ns-qc__group + .ns-qc__group {
  margin-top: 10px;
}
.ns-qc__group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-qc__group-count {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-qc__list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.ns-qc__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ns-qc__item-subject {
  flex: 0 0 auto;
  color: var(--ns-text-primary, #303133);
}
.ns-qc__item-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-qc__more,
.ns-qc__none {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-qc__foot {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
</style>
