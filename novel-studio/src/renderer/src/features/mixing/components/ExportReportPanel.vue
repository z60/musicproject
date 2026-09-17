<!--
  Novel Studio · 导出完成报告（docs/15 §5.5 Step 8 / §6.2 渲染后实测 / §6.3 导出报告）
  ============================================================================
  设计依据：
    · docs/15 §6.3 —— 报告字段：jobId / 起止时间 / elapsedMs / params / chapters[] /
      summary / m4b；落盘为 `export-report.json`。
      「UI 表格展示，可排序（按响度偏差、按时长）」「**『打开输出目录』按钮必须显眼**」。
    · docs/15 §6.2 —— 渲染后实测的验收口径：
        目标响度偏差 |Δ| ≤ 1.0 LU（QC_THRESHOLDS.lufsTolerance）
        章间响度差 ≤ 1.5 LU（QC_THRESHOLDS.chapterLufsSpread）
        真峰 ≤ 目标真峰；整章静音是**阻断**（该章应标记失败）
      → 表格里「目标」与「实测」并排，偏差列直接标注是否超阈值。
    · docs/22 §7 —— 单章失败不中断整本：本面板把失败/跳过统计与逐章明细列全，
      提示只由 error-bus 发一条（批量失败汇总），不在这里重复弹。

  为什么报告数据由外部传入而不在本组件里拉：
    · 报告的生命周期与任务绑定（换任务要换报告），由 useExportFlow 统一编排；
    · 但「复核」（export:verify）与「另存 JSON」是报告面板独有的动作，
      这里只 emit 事件，IPC 仍由 flow 调用（保证错误只在一个地方兑现）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ExportChapterResult, ExportReport } from '@shared/types.ts'
import { QC_THRESHOLDS } from '@shared/constants.ts'
import { getMessage } from '@shared/messages.ts'
import {
  formatBytes,
  formatDate,
  formatDb,
  formatDbfs,
  formatDuration,
  formatDurationLong,
  formatInt,
  formatLu,
  formatLufs,
  UNKNOWN,
} from '@/shared/lib/format.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import type { QcVerifyResponse } from '../stores/qc.store.ts'

const props = withDefaults(defineProps<{
  /** 导出报告（null = 还没拿到） */
  report: ExportReport | null
  /** 正在拉报告 */
  loading?: boolean
  /** 报告拉取失败（给「重新拉取」按钮） */
  unavailable?: boolean
  /** `export:verify` 的复核结果（已按 jobId 过滤；null = 还没复核） */
  verify: QcVerifyResponse | null
  verifyRunning?: boolean
  /** 复核时间 */
  verifiedAt?: number | null
  /** 输出目录（打开目录与路径拼装用） */
  outputDir: string
  /** 报告 JSON 的另存路径（已选择时显示提示） */
  savedPath?: string | null
}>(), {
  loading: false,
  unavailable: false,
  verify: null,
  verifyRunning: false,
  verifiedAt: null,
  savedPath: null,
})

const emit = defineEmits<{
  /** 打开输出目录（docs/15 §6.3：用户最常用的动作） */
  'open-folder': []
  /** 再次导出（保留参数，回到第 1 步） */
  're-export': []
  /** 另存报告 JSON */
  'export-json': []
  /** 复核成品（重新测量） */
  verify: []
  /** 报告拉取失败后重新拉取 */
  reload: []
}>()

/** 只看有问题的章（失败/跳过/有警告/偏差超阈值） */
const onlyIssues = ref(false)

/** 表格行：在报告字段上补上「偏差」与展示文案，避免模板里堆算式 */
interface ReportRow extends ExportChapterResult {
  delta: number | null
  deltaOutOfTolerance: boolean
  durationText: string
  sizeText: string
  gainText: string
  tpText: string
  statusText: string
  hasIssue: boolean
}

function basename(path: string): string {
  return path.split(/[\\/]+/).pop() ?? path
}

const rows = computed<ReportRow[]>(() => {
  const report = props.report
  if (!report) return []
  return report.chapters.map((chapter) => {
    const target = Number.isFinite(chapter.targetLufs) ? chapter.targetLufs : report.params.targetLufs
    const measured = chapter.measuredLufs
    const delta = measured === null || !Number.isFinite(measured) ? null : measured - target
    const deltaOutOfTolerance = delta !== null && Math.abs(delta) > QC_THRESHOLDS.lufsTolerance
    const tpOver = chapter.measuredTpDbfs !== null && chapter.measuredTpDbfs > report.params.truePeakDb + 0.1
    return {
      ...chapter,
      delta,
      deltaOutOfTolerance,
      durationText: formatDuration(chapter.durationMs),
      sizeText: formatBytes(chapter.sizeBytes),
      gainText: formatDb(chapter.adjustedGainDb),
      tpText: formatDbfs(chapter.measuredTpDbfs),
      statusText: chapter.skipped ? '跳过（复用上次成品）' : '已导出',
      hasIssue: chapter.skipped || chapter.warnings.length > 0 || deltaOutOfTolerance || tpOver,
    }
  })
})

const visibleRows = computed(() => (onlyIssues.value ? rows.value.filter(r => r.hasIssue) : rows.value))

const issueCount = computed(() => rows.value.filter(r => r.hasIssue).length)

const summary = computed(() => props.report?.summary ?? null)

/** 章间响度差（docs/15 §6.2：≤ 1.5 LU） */
const spread = computed(() => {
  const values = rows.value
    .filter(r => !r.skipped && r.measuredLufs !== null && Number.isFinite(r.measuredLufs))
    .map(r => r.measuredLufs as number)
  if (values.length < 2) return null
  return Math.max(...values) - Math.min(...values)
})

const spreadOutOfRange = computed(() =>
  spread.value !== null && spread.value > QC_THRESHOLDS.chapterLufsSpread,
)

/** 全部失败 / 部分失败的提示（文案取自消息表，不在组件里自拼） */
const failureMessage = computed(() => {
  const s = summary.value
  if (!s || s.failed === 0) return null
  if (s.failed === s.total) return getMessage('TASK_FAILED', { name: '导出任务' })
  return getMessage('EXPORT_PARTIAL_SUCCESS', { ok: s.succeeded, failed: s.failed })
})

const verifyRows = computed(() => {
  const verify = props.verify
  if (!verify) return []
  const byName = new Map(rows.value.map(r => [basename(r.output), r]))
  return verify.chapters.map((chapter, index) => {
    const match = byName.get(basename(chapter.path))
    const reportLufs = match?.measuredLufs ?? null
    const drift = chapter.measuredLufs !== null && reportLufs !== null
      ? chapter.measuredLufs - reportLufs
      : null
    return {
      key: `${chapter.path}-${index}`,
      file: basename(chapter.path),
      measuredLufs: chapter.measuredLufs,
      measuredTp: chapter.measuredTp,
      drift,
      /** 复核与导出时的读数差 > 0.5 LU 说明文件被改动过或测量不稳 */
      drifted: drift !== null && Math.abs(drift) > 0.5,
      outOfTolerance: chapter.measuredLufs !== null
        && Math.abs(chapter.measuredLufs - (match?.targetLufs ?? props.report?.params.targetLufs ?? 0)) > QC_THRESHOLDS.lufsTolerance,
    }
  })
})

const m4b = computed(() => props.report?.m4b ?? null)

const headerText = computed(() => {
  const report = props.report
  if (!report) return ''
  return `任务 ${report.jobId} · ${formatDate(report.startedAt, 'YYYY-MM-DD HH:mm')} 开始 · 耗时 ${formatDuration(report.elapsedMs)}`
})
</script>

<template>
  <section class="ns-report">
    <LoadingBlock v-if="props.loading && !props.report" text="正在读取导出报告…" :rows="4" min-height="200px" @retry="emit('reload')" />

    <EmptyState
      v-else-if="!props.report"
      icon="📄"
      title="还没有导出报告"
      description="报告在导出任务结束后生成；如果任务已完成但仍看不到报告，可以手动重新拉取。"
      :hint="props.unavailable ? '上次拉取报告失败。' : ''"
      action-text="重新拉取报告"
      size="small"
      @action="emit('reload')"
    />

    <template v-else>
      <header class="ns-report__head">
        <div>
          <h3 class="ns-report__title">导出完成</h3>
          <p class="ns-report__desc">{{ headerText }}</p>
          <p class="ns-report__desc">
            输出目录：<code>{{ props.outputDir || UNKNOWN }}</code>
          </p>
        </div>
        <div class="ns-report__head-actions">
          <!-- docs/15 §6.3：这个按钮必须显眼 -->
          <el-button type="primary" @click="emit('open-folder')">打开输出目录</el-button>
          <el-button @click="emit('export-json')">导出报告 JSON</el-button>
          <el-button :loading="props.verifyRunning" @click="emit('verify')">复核成品</el-button>
          <el-button @click="emit('re-export')">再次导出</el-button>
        </div>
      </header>

      <p v-if="props.savedPath" class="ns-report__saved">
        已选择另存位置：<code>{{ props.savedPath }}</code>。主进程同时把权威报告写在输出目录的
        <code>export-report.json</code>（docs/15 §6.3）。
      </p>

      <!-- 汇总 -->
      <div v-if="summary" class="ns-report__stats">
        <div class="ns-report__stat">
          <span class="ns-report__stat-label">章节总数</span>
          <strong class="ns-report__stat-value">{{ formatInt(summary.total) }}</strong>
        </div>
        <div class="ns-report__stat">
          <span class="ns-report__stat-label">成功</span>
          <strong class="ns-report__stat-value">{{ formatInt(summary.succeeded) }}</strong>
        </div>
        <div class="ns-report__stat">
          <span class="ns-report__stat-label">跳过（断点复用）</span>
          <strong class="ns-report__stat-value">{{ formatInt(summary.skipped) }}</strong>
        </div>
        <div class="ns-report__stat" :class="{ 'is-bad': summary.failed > 0 }">
          <span class="ns-report__stat-label">失败</span>
          <strong class="ns-report__stat-value">{{ formatInt(summary.failed) }}</strong>
        </div>
        <div class="ns-report__stat">
          <span class="ns-report__stat-label">警告</span>
          <strong class="ns-report__stat-value">{{ formatInt(summary.warnings) }}</strong>
        </div>
        <div class="ns-report__stat">
          <span class="ns-report__stat-label">成品总时长</span>
          <strong class="ns-report__stat-value">{{ formatDurationLong(summary.totalDurationMs) }}</strong>
        </div>
      </div>

      <el-alert
        v-if="failureMessage"
        type="error"
        :closable="false"
        show-icon
        :title="failureMessage.title"
        :description="[failureMessage.detail, failureMessage.hint].filter(Boolean).join(' ')"
      />

      <el-alert
        v-if="spreadOutOfRange"
        type="warning"
        :closable="false"
        show-icon
        title="章间响度差偏大"
        :description="`实测最大差 ${formatLu(spread)}，超过 ${QC_THRESHOLDS.chapterLufsSpread} LU 的标准；听众会觉得「这章响那章轻」，建议检查异常章的素材电平后重新导出。`"
      />
      <p v-else-if="spread !== null" class="ns-report__spread">
        章间响度差 {{ formatLu(spread) }}（标准 ≤ {{ QC_THRESHOLDS.chapterLufsSpread }} LU）✓
      </p>

      <!-- 逐章明细 -->
      <div class="ns-report__table-head">
        <strong>逐章实测（目标 vs 实测）</strong>
        <div class="ns-report__table-tools">
          <el-checkbox v-model="onlyIssues">
            只看有问题的章（{{ formatInt(issueCount) }}）
          </el-checkbox>
          <span class="ns-report__hint">
            偏差超 ±{{ QC_THRESHOLDS.lufsTolerance }} LU 会标红；真峰超过目标也标红。
          </span>
        </div>
      </div>

      <el-table :data="visibleRows" size="small" border stripe max-height="420" class="ns-report__table">
        <el-table-column prop="chapterIndex" label="#" width="60" sortable />
        <el-table-column prop="title" label="章节" min-width="180" show-overflow-tooltip />
        <el-table-column prop="durationMs" label="时长" width="90" sortable>
          <template #default="{ row }">{{ row.durationText }}</template>
        </el-table-column>
        <el-table-column prop="targetLufs" label="目标" width="100" sortable>
          <template #default="{ row }">{{ formatLufs(row.targetLufs) }}</template>
        </el-table-column>
        <el-table-column prop="measuredLufs" label="实测" width="110" sortable>
          <template #default="{ row }">{{ formatLufs(row.measuredLufs) }}</template>
        </el-table-column>
        <el-table-column prop="delta" label="偏差" width="120" sortable>
          <template #default="{ row }">
            <el-tag v-if="row.deltaOutOfTolerance" type="danger" size="small">{{ formatLu(row.delta) }}</el-tag>
            <span v-else>{{ formatLu(row.delta) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="真峰" width="110">
          <template #default="{ row }">{{ row.tpText }}</template>
        </el-table-column>
        <el-table-column label="增益" width="100">
          <template #default="{ row }">{{ row.gainText }}</template>
        </el-table-column>
        <el-table-column prop="output" label="输出文件" min-width="200" show-overflow-tooltip />
        <el-table-column prop="sizeBytes" label="大小" width="100" sortable>
          <template #default="{ row }">{{ row.sizeText }}</template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.skipped" type="info" size="small">跳过</el-tag>
            <span v-else>{{ row.statusText }}</span>
          </template>
        </el-table-column>
        <el-table-column label="警告" min-width="220">
          <template #default="{ row }">
            <span v-if="!row.warnings.length" class="ns-report__hint">—</span>
            <ul v-else class="ns-report__warnings">
              <li v-for="(warning, index) in row.warnings" :key="index">{{ warning }}</li>
            </ul>
          </template>
        </el-table-column>
      </el-table>

      <!-- M4B 结果 -->
      <div v-if="m4b" class="ns-report__m4b">
        <el-tag :type="m4b.verified ? 'success' : 'warning'" effect="dark" size="small">
          {{ m4b.verified ? 'M4B 校验通过' : 'M4B 未通过校验' }}
        </el-tag>
        <span>{{ m4b.path }}</span>
        <span class="ns-report__hint">
          {{ formatInt(m4b.chapters) }} 章 · {{ formatBytes(m4b.sizeBytes) }}
        </span>
        <span v-if="!m4b.verified" class="ns-report__hint">
          播放器可能无法正确显示章节列表；可用「复核成品」再看一次，或按卷拆分后重新合并。
        </span>
      </div>

      <!-- 复核结果（docs/15 §6.2「渲染后实测」） -->
      <div class="ns-report__verify">
        <div class="ns-report__table-head">
          <strong>成品复核</strong>
          <span class="ns-report__hint">
            {{ props.verify ? `${formatDate(props.verifiedAt ?? 0, 'HH:mm:ss')} 重新测量` : '尚未复核：复核会用第三方测量重新读一遍成品，验证标签与响度' }}
          </span>
        </div>
        <el-table v-if="props.verify" :data="verifyRows" size="small" border max-height="240">
          <el-table-column prop="file" label="文件" min-width="220" show-overflow-tooltip />
          <el-table-column label="实测响度" width="130">
            <template #default="{ row }">
              <el-tag v-if="row.outOfTolerance" type="danger" size="small">{{ formatLufs(row.measuredLufs) }}</el-tag>
              <span v-else>{{ formatLufs(row.measuredLufs) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测真峰" width="120">
            <template #default="{ row }">{{ formatDbfs(row.measuredTp) }}</template>
          </el-table-column>
          <el-table-column label="与导出时差异" width="160">
            <template #default="{ row }">
              <el-tag v-if="row.drifted" type="warning" size="small">{{ formatLu(row.drift) }}</el-tag>
              <span v-else>{{ formatLu(row.drift) }}</span>
            </template>
          </el-table-column>
        </el-table>
        <p v-else class="ns-report__hint">
          复核会对输出目录里的成品重新测量响度与真峰，用于确认「文件没被改动、标签写对了」。
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ns-report {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ns-report__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.ns-report__title {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.ns-report__desc {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-report__desc code,
.ns-report__saved code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-report__head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ns-report__saved {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-report__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}
.ns-report__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-report__stat.is-bad {
  border-color: var(--ns-danger, #f56c6c);
}
.ns-report__stat-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-report__stat-value {
  color: var(--ns-text-primary, #303133);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.ns-report__spread {
  margin: 0;
  color: var(--ns-success, #67c23a);
  font-size: 12px;
}
.ns-report__table-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-report__table-tools {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ns-report__hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-report__warnings {
  margin: 0;
  padding-left: 16px;
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.6;
}
.ns-report__m4b {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
.ns-report__verify {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ns-border-light, #e4e7ed);
}
.ns-report__verify p {
  margin: 0;
}
</style>
