<!--
  Novel Studio · 切片与画本行匹配（docs/13 §3.1 / §3.2）
  ============================================================================
  设计依据：
    · docs/13 §3.1 —— 自动匹配（FR-4.2）：`alignment:autoMatchSegments` 用 DP 把
      「连续录制切出来的片段」对上「画本行」，返回
        matches: [{ segmentId, lineId, confidence }]
        unmatchedSegments: Id[]      （有录音但没找到行：多半是多录/串录）
        unrecordedLines:  Id[]      （有行但没录音：缺录，直接影响导出）
      三者都要展示，**不能只显示 matches**：漏掉 unmatched/unrecorded 会让用户以为
      「匹配完了就没事了」，而缺录正是导出预检会拦下的阻断项。
    · docs/13 §3.2 —— 手动匹配界面：左右对照（片段 ↔ 画本行），
      支持手工绑定（`alignment:bindSegment`）与解绑（`alignment:unbindSegment`）、
      批量接受。**置信度必须可见**（色块分高/中/低，docs/11 §4.2 的分档表），
      用户才知道哪几条要人工看一眼。
    · docs/13 §8.2 —— `useAsr` 会触发 ASR 任务（耗时、吃 CPU），
      必须显式说明后再让用户打开，不能默认静默开启。

  ★ 数据缺口与处理（不造假）：
    契约里没有「按章节列出 voice_segments」的通道，`unmatchedSegments` 只给了 id。
    因此片段侧能显示的就是 id 本身 + 已知的置信度/绑定的行；
    源文件的时长/规格需要时按需查 `analysis:metrics`（点「源信息」才查，避免批量 IPC）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Id } from '@shared/types.ts'
import { CONFIDENCE_BANDS } from '@shared/constants.ts'
import { formatDuration, formatPercent, formatScore } from '@/shared/lib/format.ts'
import { call, callCollecting } from '@/shared/lib/ipc.ts'
import { reportBatchFailures } from '@/shared/lib/error-bus.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useArrangementStore } from '../stores/arrangement.store.ts'

/**
 * `alignment:autoMatchSegments` 的响应（契约形状）。
 *
 * 注意：script setup 块**不能有 export**（SFC 编译硬约束），因此这里只定义不导出；
 * MatchReviewView 需要同形状时自己再声明一份（结构类型是兼容的）。
 */
interface AutoMatchResult {
  matches: Array<{ segmentId: Id; lineId: Id; confidence: number }>
  unmatchedSegments: Id[]
  unrecordedLines: Id[]
}

/** 绑定历史的一条（本页显示；不落库，刷新即重建） */
interface BindHistoryEntry {
  at: number
  action: 'bind' | 'unbind' | 'bulk-accept'
  lineId: Id | null
  segmentId: Id | null
  note: string
}

interface MatchStats {
  matches: number
  accepted: number
  unmatched: number
  unrecorded: number
  lowConfidence: number
}

const props = withDefaults(defineProps<{
  /** 章节 id（发起自动匹配必须） */
  chapterId?: Id | null
  /** 低置信度阈值：低于它标红，提示人工确认 */
  lowConfidenceThreshold?: number
}>(), {
  chapterId: null,
  lowConfidenceThreshold: 0.62,
})

const emit = defineEmits<{
  /** 统计变化（父页面用它渲染统计卡） */
  'update:stats': [stats: MatchStats]
  /** 产生一条绑定历史（父页面累积展示） */
  history: [entry: BindHistoryEntry]
  /** 绑定/解绑改变了数据：父页面应刷新对轨数据 */
  changed: []
  /** 跳到画本行（父页面负责路由） */
  'jump-line': [lineId: Id]
  /** 去录音该行（父页面负责路由） */
  'record-line': [lineId: Id]
}>()

const arrangement = useArrangementStore()

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const result = ref<AutoMatchResult | null>(null)
const loading = ref(false)
const accepting = ref(false)
/** `useAsr` 开关（默认关：ASR 是重任务，要让用户显式打开） */
const useAsr = ref(false)
/** 已接受（= 已通过 bindSegment 落库）的 segmentId */
const acceptedIds = ref<Id[]>([])
/** 手工绑定覆盖：segmentId → lineId（只在本页生效，落库走 bindSegment） */
const manualBinds = ref<Record<Id, Id>>({})
/** 已解绑的行（从对照列表里标灰，不隐藏——用户要能撤销这个判断） */
const unboundLineIds = ref<Id[]>([])
/** 源信息（按需查询 analysis:metrics 的结果） */
const sourceInfo = ref<{ segmentId: Id; text: string } | null>(null)
/** 片段 → 行 的当前绑定（自动匹配 + 手工绑定合并后的视图） */
const selectedSegment = ref<Id | null>(null)

const normalizedChapterId = computed(() => props.chapterId ?? arrangement.chapter?.id ?? null)

/** 行 id → 「#seq 文本」 */
function lineTitle(lineId: Id, maxChars = 28): string {
  const line = arrangement.lineById.get(lineId)
  if (!line) return '（画本行已删除）'
  const raw = (line.text ?? '').replace(/\s+/g, ' ').trim()
  const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw
  return `#${line.seq} ${text}`
}

function confidenceColor(confidence: number): string {
  const band = CONFIDENCE_BANDS.find(item => confidence >= item.min) ?? CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1]
  return band.color
}

function confidenceLabel(confidence: number): string {
  const band = CONFIDENCE_BANDS.find(item => confidence >= item.min) ?? CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1]
  return band.label
}

// ---------------------------------------------------------------------------
// 派生：对照行（左片段 / 右画本行）
// ---------------------------------------------------------------------------

interface PairRow {
  key: string
  segmentId: Id
  lineId: Id | null
  confidence: number | null
  /** 自动匹配给的原始结果（手工绑定后仍保留，便于对比） */
  autoLineId: Id | null
  manual: boolean
  accepted: boolean
  unbound: boolean
  lineSeq: number | null
}

const pairs = computed<PairRow[]>(() => {
  const rows: PairRow[] = []
  const data = result.value
  if (!data) return rows

  for (const match of data.matches) {
    const override = manualBinds.value[match.segmentId] ?? null
    const lineId = override ?? match.lineId
    rows.push({
      key: match.segmentId,
      segmentId: match.segmentId,
      lineId,
      confidence: match.confidence,
      autoLineId: match.lineId,
      manual: override !== null,
      accepted: acceptedIds.value.includes(match.segmentId),
      unbound: lineId !== null && unboundLineIds.value.includes(lineId),
      lineSeq: lineId ? arrangement.lineById.get(lineId)?.seq ?? null : null,
    })
  }

  for (const segmentId of data.unmatchedSegments) {
    const override = manualBinds.value[segmentId] ?? null
    const lineId = override
    rows.push({
      key: segmentId,
      segmentId,
      lineId,
      confidence: null,
      autoLineId: null,
      manual: override !== null,
      accepted: acceptedIds.value.includes(segmentId),
      unbound: false,
      lineSeq: lineId ? arrangement.lineById.get(lineId)?.seq ?? null : null,
    })
  }

  // 有行号的排前面（按画本顺序读，最符合人的核对方式），未匹配的沉底
  rows.sort((a, b) => {
    if (a.lineSeq === null && b.lineSeq === null) return a.segmentId.localeCompare(b.segmentId)
    if (a.lineSeq === null) return 1
    if (b.lineSeq === null) return -1
    return a.lineSeq - b.lineSeq
  })
  return rows
})

/** 未录行（缺录）：这是导出阻断项，单独列出 */
const unrecordedRows = computed(() => (result.value?.unrecordedLines ?? []).map((lineId) => {
  const line = arrangement.lineById.get(lineId)
  return {
    lineId,
    seq: line?.seq ?? null,
    text: line ? (line.text ?? '').slice(0, 40) : '（画本行已删除）',
  }
}))

const lowConfidencePairs = computed(() => pairs.value.filter(row => row.confidence !== null && row.confidence < props.lowConfidenceThreshold))

const stats = computed<MatchStats>(() => ({
  matches: result.value?.matches.length ?? 0,
  accepted: acceptedIds.value.length,
  unmatched: pairs.value.filter(row => row.lineId === null).length,
  unrecorded: unrecordedRows.value.length,
  lowConfidence: lowConfidencePairs.value.length,
}))

/** 统计一变就上报给父页面（MatchReviewView 的统计卡） */
function publishStats(): void {
  emit('update:stats', stats.value)
}

function pushHistory(entry: Omit<BindHistoryEntry, 'at'>): void {
  emit('history', { ...entry, at: Date.now() })
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function runAutoMatch(): Promise<void> {
  const chapterId = normalizedChapterId.value
  if (!chapterId || loading.value) return
  loading.value = true
  try {
    const res = await call('alignment:autoMatchSegments', {
      chapterId,
      useAsr: useAsr.value || undefined,
    }) as AutoMatchResult
    result.value = {
      matches: res.matches ?? [],
      unmatchedSegments: res.unmatchedSegments ?? [],
      unrecordedLines: res.unrecordedLines ?? [],
    }
    // 新一轮匹配：清掉上一轮的手工覆盖与接受标记（否则会张冠李戴）
    acceptedIds.value = []
    manualBinds.value = {}
    unboundLineIds.value = []
    sourceInfo.value = null
    publishStats()
  } catch {
    // 失败已由 ipc.call 交给 error-bus 展示；这里只保证不留下半截结果
    result.value = null
  } finally {
    loading.value = false
  }
}

/** 手工绑定：把某个片段绑到某一行（alignment:bindSegment） */
async function bind(lineId: Id, segmentId: Id): Promise<boolean> {
  try {
    await call('alignment:bindSegment', { lineId, segmentId })
    manualBinds.value = { ...manualBinds.value, [segmentId]: lineId }
    unboundLineIds.value = unboundLineIds.value.filter(id => id !== lineId)
    pushHistory({ action: 'bind', lineId, segmentId, note: '手工绑定' })
    publishStats()
    emit('changed')
    return true
  } catch {
    return false
  }
}

/** 解绑：该行回到「未录」状态（alignment:unbindSegment） */
async function unbind(lineId: Id, segmentId: Id | null): Promise<void> {
  try {
    await call('alignment:unbindSegment', { lineId })
    unboundLineIds.value = [...unboundLineIds.value, lineId]
    acceptedIds.value = acceptedIds.value.filter(id => id !== segmentId)
    const next = { ...manualBinds.value }
    if (segmentId) delete next[segmentId]
    manualBinds.value = next
    pushHistory({ action: 'unbind', lineId, segmentId, note: '解绑（该行回到未录）' })
    publishStats()
    emit('changed')
  } catch {
    /* 失败已交给 error-bus */
  }
}

/**
 * 批量接受：把当前所有「已配上行」的结果显式落库。
 *
 * 为什么要逐条 bind 而不是假设 autoMatchSegments 已经写库：
 *   契约只声明它**返回** matches，没有说明是否持久化。显式 bind 一次是幂等的，
 *   无论主进程是否已写库，结果都一致；也让「接受」这个动作有确定的语义。
 * 失败用 callCollecting + reportBatchFailures 汇总成一条提示（docs/22 §7）。
 */
async function acceptAll(): Promise<void> {
  if (accepting.value) return
  const targets = pairs.value.filter(row => row.lineId !== null && !row.accepted)
  if (!targets.length) return
  accepting.value = true
  const failures: Array<{ label: string; code: string; message: string }> = []
  let ok = 0
  try {
    for (const row of targets) {
      const lineId = row.lineId as Id
      const outcome = await callCollecting(
        'alignment:bindSegment',
        { lineId, segmentId: row.segmentId },
        failures,
        lineTitle(lineId, 12),
      )
      if (outcome.ok) {
        ok += 1
        if (!acceptedIds.value.includes(row.segmentId)) acceptedIds.value = [...acceptedIds.value, row.segmentId]
      }
    }
    reportBatchFailures({ total: targets.length, failed: failures.length, ok, samples: failures })
    if (ok > 0) {
      pushHistory({ action: 'bulk-accept', lineId: null, segmentId: null, note: `接受 ${ok} 条自动匹配` })
      publishStats()
      emit('changed')
    }
  } finally {
    accepting.value = false
  }
}

/** 源信息：按需查一次 analysis:metrics（不做批量，避免几十次 IPC） */
async function loadSourceInfo(segmentId: Id): Promise<void> {
  selectedSegment.value = segmentId
  if (sourceInfo.value?.segmentId === segmentId) return
  try {
    const metrics = await call('analysis:metrics', { segmentId })
    const parts = [
      metrics.durationMs ? formatDuration(metrics.durationMs, { showMs: true }) : '时长未知',
      metrics.sampleRate ? `${Math.round(metrics.sampleRate / 1000)} kHz` : '',
      metrics.peakDb === null ? '峰值未测' : `峰值 ${formatScore(metrics.peakDb, 1)} dB`,
    ].filter(Boolean)
    sourceInfo.value = { segmentId, text: parts.join(' · ') }
  } catch {
    sourceInfo.value = { segmentId, text: '源信息不可用（metrics 查询失败）' }
  }
}

function onManualPick(row: PairRow, lineId: Id | null): void {
  if (!lineId) return
  void bind(lineId, row.segmentId)
}

/** 手动绑定下拉：el-select 的选项值为行 Id，v-for 内需带上行上下文 */
function onManualPickInput(row: PairRow): (lineId: Id | null) => void {
  return (lineId: Id | null): void => {
    onManualPick(row, lineId)
  }
}

/** 候选行：优先给「还没上行的行」（未录行），再给全部行 */
const candidateLines = computed(() => {
  const bound = new Set(pairs.value.map(row => row.lineId).filter((id): id is Id => id !== null))
  return arrangement.lines
    .filter(line => !bound.has(line.id))
    .slice(0, 400)
    .map(line => ({
      value: line.id,
      label: `#${line.seq} ${(line.text ?? '').slice(0, 24)}`,
      unrecorded: unrecordedRows.value.some(row => row.lineId === line.id),
    }))
})
</script>

<template>
  <div class="ns-matcher">
    <!-- 工具条：匹配范围 / useAsr / 动作 -->
    <header class="ns-matcher__head">
      <el-button size="small" type="primary" :loading="loading" :disabled="!normalizedChapterId" @click="runAutoMatch">
        自动匹配
      </el-button>
      <el-button
        size="small"
        :loading="accepting"
        :disabled="!result || pairs.every(row => row.lineId === null || row.accepted)"
        @click="acceptAll"
      >
        批量接受（{{ pairs.filter(row => row.lineId !== null && !row.accepted).length }}）
      </el-button>
      <div class="ns-matcher__asr">
        <el-switch v-model="useAsr" size="small" active-text="用 ASR 提高匹配率" />
        <span class="ns-matcher__asr-hint">
          {{ useAsr
            ? '已开启：点击「自动匹配」会先跑一次 ASR 任务（识别耗时较长、占用 CPU），结果只用于提高匹配率。'
            : '默认关闭：仅按切片时长与停顿做 DP 匹配；错绑较多时再打开 ASR。' }}
        </span>
      </div>
    </header>

    <!-- 统计 -->
    <div class="ns-matcher__stats">
      <span class="ns-matcher__stat">匹配 {{ stats.matches }}</span>
      <span class="ns-matcher__stat ns-matcher__stat--ok">已接受 {{ stats.accepted }}</span>
      <span class="ns-matcher__stat" :class="{ 'ns-matcher__stat--warn': stats.unmatched > 0 }">未匹配片段 {{ stats.unmatched }}</span>
      <span class="ns-matcher__stat" :class="{ 'ns-matcher__stat--danger': stats.unrecorded > 0 }">未录行 {{ stats.unrecorded }}</span>
      <span class="ns-matcher__stat" :class="{ 'ns-matcher__stat--warn': stats.lowConfidence > 0 }">低置信 {{ stats.lowConfidence }}</span>
    </div>

    <LoadingBlock v-if="loading" text="正在匹配片段与画本行…" min-height="160px" />

    <EmptyState
      v-else-if="!result"
      icon="🧩"
      size="small"
      title="还没有匹配结果"
      description="连续录制会把一次会话切成很多片段，需要把它们对回画本行；也可以先手工绑定几条，再跑自动匹配。"
      hint="自动匹配只影响绑定关系，不动音频文件。"
    />

    <template v-else>
      <!-- 左右对照：左 = 片段，右 = 画本行 -->
      <div class="ns-matcher__table">
        <div class="ns-matcher__table-head">
          <span>片段 / 切片</span>
          <span>置信度</span>
          <span>画本行</span>
          <span>操作</span>
        </div>

        <div
          v-for="row in pairs"
          :key="row.key"
          class="ns-matcher__row"
          :class="{
            'is-manual': row.manual,
            'is-unbound': row.unbound,
            'is-unmatched': row.lineId === null,
            'is-active': selectedSegment === row.segmentId,
          }"
          @click="loadSourceInfo(row.segmentId)"
        >
          <div class="ns-matcher__cell ns-matcher__cell--segment">
            <code class="ns-matcher__id">{{ row.segmentId.slice(0, 12) }}</code>
            <span v-if="sourceInfo?.segmentId === row.segmentId" class="ns-matcher__source">{{ sourceInfo.text }}</span>
          </div>

          <div class="ns-matcher__cell ns-matcher__cell--conf">
            <template v-if="row.confidence !== null">
              <span class="ns-matcher__conf-block" :style="{ background: confidenceColor(row.confidence) }" />
              <span class="ns-matcher__conf-text" :title="`${confidenceLabel(row.confidence)}（${formatScore(row.confidence)}）`">
                {{ formatPercent(row.confidence, 0) }}
              </span>
            </template>
            <span v-else class="ns-matcher__conf-none">未匹配</span>
          </div>

          <div class="ns-matcher__cell ns-matcher__cell--line">
            <template v-if="row.lineId">
              <span class="ns-matcher__line-seq">#{{ row.lineSeq ?? '—' }}</span>
              <span class="ns-matcher__line-text" :title="lineTitle(row.lineId, 60)">{{ lineTitle(row.lineId) }}</span>
              <el-tag v-if="row.manual" size="small" type="warning">手工</el-tag>
              <el-tag v-if="row.accepted" size="small" type="success">已接受</el-tag>
              <el-tag v-if="row.unbound" size="small" type="info">已解绑</el-tag>
            </template>
            <el-select
              v-else
              :model-value="null"
              size="small"
              class="ns-matcher__picker"
              placeholder="选一行绑定"
              filterable
              @update:model-value="onManualPickInput(row)"
            >
              <el-option
                v-for="candidate in candidateLines"
                :key="candidate.value"
                :value="candidate.value"
                :label="candidate.label"
              >
                <span class="ns-matcher__option">
                  <span>{{ candidate.label }}</span>
                  <span v-if="candidate.unrecorded" class="ns-matcher__option-tag">未录</span>
                </span>
              </el-option>
            </el-select>
          </div>

          <div class="ns-matcher__cell ns-matcher__cell--actions">
            <el-button v-if="row.lineId" size="small" text @click.stop="unbind(row.lineId as Id, row.segmentId)">解绑</el-button>
            <el-button v-if="row.lineId" size="small" text @click.stop="emit('jump-line', row.lineId as Id)">看画本</el-button>
            <el-button v-if="row.lineId" size="small" text @click.stop="emit('record-line', row.lineId as Id)">重录</el-button>
            <span v-if="!row.lineId" class="ns-matcher__hint">选择一行即可手工绑定</span>
          </div>
        </div>
      </div>

      <!-- 未录行：缺录是导出阻断项，单独强调 -->
      <section class="ns-matcher__section">
        <h4 class="ns-matcher__section-title">
          未录行（{{ unrecordedRows.length }}）
          <span class="ns-matcher__section-hint">这些画本行没有对应录音，导出预检会拦下</span>
        </h4>
        <EmptyState
          v-if="unrecordedRows.length === 0"
          icon="👍"
          size="small"
          title="没有未录行"
          description="整章的所有画本行都已有对应录音。"
        />
        <ul v-else class="ns-matcher__mini-list">
          <li v-for="row in unrecordedRows" :key="row.lineId" class="ns-matcher__mini-row">
            <span class="ns-matcher__mini-seq">#{{ row.seq ?? '—' }}</span>
            <span class="ns-matcher__mini-text" :title="row.text">{{ row.text }}</span>
            <el-button size="small" text @click="emit('record-line', row.lineId)">去录音</el-button>
            <el-button size="small" text @click="emit('jump-line', row.lineId)">看画本</el-button>
          </li>
        </ul>
      </section>

      <p class="ns-matcher__note">
        提示：手工绑定与解绑是**立即落库**的（`alignment:bindSegment` / `alignment:unbindSegment`），
        本页的绑定历史只用于回看，刷新后不会保留；对轨结果请在时间线重新加载。
      </p>
    </template>
  </div>
</template>

<style scoped>
.ns-matcher {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  font-size: 12px;
}
.ns-matcher__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ns-matcher__asr {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.ns-matcher__asr-hint {
  max-width: 420px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.5;
}
.ns-matcher__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--ns-bg-subtle, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-variant-numeric: tabular-nums;
}
.ns-matcher__stat--ok {
  color: var(--ns-success, #67c23a);
}
.ns-matcher__stat--warn {
  color: var(--ns-warning, #e6a23c);
}
.ns-matcher__stat--danger {
  color: var(--ns-danger, #f56c6c);
}
.ns-matcher__table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ns-border, #ebeef5);
  border-radius: 6px;
  overflow: hidden;
}
.ns-matcher__table-head,
.ns-matcher__row {
  display: grid;
  grid-template-columns: 190px 96px minmax(220px, 1fr) 190px;
  align-items: center;
  gap: 6px;
}
.ns-matcher__table-head {
  padding: 6px 8px;
  background: var(--ns-bg-subtle, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-matcher__row {
  padding: 5px 8px;
  border-top: 1px solid var(--ns-border, #f2f3f5);
  cursor: default;
}
.ns-matcher__row:hover {
  background: var(--ns-bg-subtle, #fafbfc);
}
.ns-matcher__row.is-active {
  box-shadow: inset 2px 0 0 var(--ns-primary, #409eff);
}
.ns-matcher__row.is-manual {
  background: color-mix(in srgb, var(--ns-warning, #e6a23c) 5%, var(--ns-bg, #fff));
}
.ns-matcher__row.is-unbound {
  opacity: 0.6;
}
.ns-matcher__row.is-unmatched {
  background: color-mix(in srgb, var(--ns-danger, #f56c6c) 4%, var(--ns-bg, #fff));
}
.ns-matcher__cell {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.ns-matcher__id {
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-matcher__source {
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-matcher__conf-block {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.ns-matcher__conf-text {
  color: var(--ns-text-regular, #606266);
  font-variant-numeric: tabular-nums;
}
.ns-matcher__conf-none {
  color: var(--ns-danger, #f56c6c);
}
.ns-matcher__line-seq {
  flex: 0 0 auto;
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-matcher__line-text {
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-matcher__picker {
  width: 100%;
}
.ns-matcher__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ns-matcher__option-tag {
  color: var(--ns-danger, #f56c6c);
  font-size: 11px;
}
.ns-matcher__hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-matcher__section {
  padding-top: 8px;
  border-top: 1px solid var(--ns-border, #ebeef5);
}
.ns-matcher__section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.ns-matcher__section-hint {
  color: var(--ns-danger, #f56c6c);
  font-size: 11px;
  font-weight: 400;
}
.ns-matcher__mini-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ns-matcher__mini-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
}
.ns-matcher__mini-row:hover {
  background: var(--ns-bg-subtle, #f5f7fa);
}
.ns-matcher__mini-seq {
  flex: 0 0 auto;
  width: 48px;
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-matcher__mini-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-matcher__note {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
</style>
