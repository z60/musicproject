<!--
  Novel Studio · 录制对齐（docs/13 §3 录制对齐子功能 / §3.1 / §3.2）
  ============================================================================
  设计依据：
    · docs/13 §3 —— 「录制对齐」是独立子功能：连续录制（`docs/12` §3）会切出很多
      片段，需要一个专门的地方把它们对回画本行，而不是塞在时间线里顺手做；
    · docs/13 §3.1 —— 自动匹配结果的三部分（matches / unmatchedSegments /
      unrecordedLines）必须完整可见，未录行是导出阻断项；
    · docs/13 §3.2 —— 手动匹配界面（左右对照 + 置信度色块 + 手工绑定/解绑）；
    · docs/13 §9  —— 路由 `/alignment/match` 指向本页（router.ts 已登记）。

  本页只做「组织」：顶部的章节信息 + 统计卡 + 绑定历史 + 回到时间线的入口，
  匹配交互本体在 `components/SliceMatcher.vue`（同一份组件也能放进别的容器里）。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Id } from '@shared/types.ts'
import { formatRelativeTime } from '@/shared/lib/format.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import SliceMatcher from '../components/SliceMatcher.vue'
import { useArrangementStore } from '../stores/arrangement.store.ts'

/** 与 SliceMatcher 的 `history` 事件同形状（script setup 块不能 export，故各自声明） */
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

const router = useRouter()
const session = useSessionStore()
const arrangement = useArrangementStore()

const chapterId = computed<Id | null>(() => session.chapterId)
const chapterTitle = computed(() => session.chapter?.title ?? arrangement.chapter?.title ?? '未选择章节')

const stats = ref<MatchStats>({ matches: 0, accepted: 0, unmatched: 0, unrecorded: 0, lowConfidence: 0 })
const history = ref<BindHistoryEntry[]>([])
const reloading = ref(false)

/** 统计卡（未匹配片段 / 未录行 / 低置信 都要单独成卡，用户才知道下一步去哪） */
const cards = computed(() => [
  { key: 'matches', label: '自动匹配', value: stats.value.matches, tone: 'info', hint: 'DP 匹配出的片段↔画本行对' },
  { key: 'accepted', label: '已接受', value: stats.value.accepted, tone: 'success', hint: '已通过 alignment:bindSegment 落库' },
  { key: 'unmatched', label: '未匹配片段', value: stats.value.unmatched, tone: stats.value.unmatched ? 'warning' : 'info', hint: '有录音但没有行：可能是多录或串录' },
  { key: 'unrecorded', label: '未录行', value: stats.value.unrecorded, tone: stats.value.unrecorded ? 'danger' : 'info', hint: '有行但没有录音：导出预检会拦下' },
  { key: 'lowConfidence', label: '低置信', value: stats.value.lowConfidence, tone: stats.value.lowConfidence ? 'warning' : 'info', hint: '低于 0.62：建议人工核对这几条' },
])

const historyText = (entry: BindHistoryEntry): string => {
  const line = entry.lineId ? arrangement.lineById.get(entry.lineId) : null
  const lineLabel = line ? `#${line.seq} ${(line.text ?? '').slice(0, 14)}` : (entry.lineId ?? '')
  const action = entry.action === 'bind' ? '绑定' : entry.action === 'unbind' ? '解绑' : '批量接受'
  return [
    action,
    lineLabel,
    entry.segmentId ? `← ${entry.segmentId.slice(0, 10)}` : '',
    entry.note,
  ].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------
// 绑定历史（本页只累积展示；落库由 SliceMatcher 直接调 IPC 完成）
// ---------------------------------------------------------------------------

function onStats(next: MatchStats): void {
  stats.value = next
}

function onHistory(entry: BindHistoryEntry): void {
  // 只保留最近 100 条（避免长时间操作把 DOM 撑爆）。
  // 对轨数据的刷新由 SliceMatcher 的 `changed` 事件触发（一次操作只刷一次）。
  history.value = [entry, ...history.value].slice(0, 100)
}

/** 绑定/解绑改变了 items：把对轨数据重新拉一遍（时间线回来看到的就是最新的） */
async function reloadTimeline(): Promise<void> {
  const id = chapterId.value
  if (!id || reloading.value) return
  reloading.value = true
  try {
    await arrangement.loadChapter(id)
  } finally {
    reloading.value = false
  }
}

function backToTimeline(): void {
  void router.push({ path: '/alignment' })
}

function jumpLine(lineId: Id): void {
  void router.push({ path: '/canvas', query: { line: lineId } })
}

function recordLine(): void {
  void router.push({ path: '/recording' })
}

onMounted(async () => {
  const id = chapterId.value
  if (!id) return
  // 画本行与片段来源都在 arrangement store 的上下文里（SliceMatcher 依赖它做左右对照）
  if (arrangement.chapter?.id !== id || !arrangement.lines.length) {
    await arrangement.loadChapter(id)
  }
})
</script>

<template>
  <div class="ns-match">
    <!-- 顶部：章节 + 回到时间线 -->
    <header class="ns-match__head">
      <div class="ns-match__title">
        <span class="ns-match__eyebrow">录制对齐</span>
        <h2 class="ns-match__chapter">{{ chapterTitle }}</h2>
        <span class="ns-match__meta">
          画本行 {{ arrangement.lines.length }} · 已排布片段 {{ arrangement.items.length }}
        </span>
      </div>
      <div class="ns-match__head-actions">
        <el-button size="small" :loading="reloading" :disabled="!chapterId" @click="reloadTimeline">
          重新加载对轨数据
        </el-button>
        <el-button size="small" type="primary" @click="backToTimeline">回到时间线</el-button>
      </div>
    </header>

    <!-- 统计卡 -->
    <section class="ns-match__cards">
      <div v-for="card in cards" :key="card.key" class="ns-match__card" :class="`is-${card.tone}`" :title="card.hint">
        <span class="ns-match__card-value">{{ card.value }}</span>
        <span class="ns-match__card-label">{{ card.label }}</span>
      </div>
    </section>

    <EmptyState
      v-if="!chapterId"
      icon="🎙️"
      title="还没有选择章节"
      description="录制对齐是按章进行的：请先在章节列表里选一章，再回来核对片段与画本行的绑定。"
      action-text="去章节列表"
      @action="router.push({ path: '/chapters' })"
    />

    <div v-else class="ns-match__body">
      <div class="ns-match__main">
        <SliceMatcher
          :chapter-id="chapterId"
          @update:stats="onStats"
          @history="onHistory"
          @changed="reloadTimeline"
          @jump-line="jumpLine"
          @record-line="recordLine"
        />
      </div>

      <!-- 侧栏：绑定历史 + 判据说明 -->
      <aside class="ns-match__side">
        <h3 class="ns-match__side-title">绑定历史（本次会话）</h3>
        <p v-if="!history.length" class="ns-match__side-empty">
          还没有手工绑定或解绑操作。自动匹配结果需要点「批量接受」才会显式落库。
        </p>
        <ul v-else class="ns-match__history">
          <li v-for="(entry, index) in history" :key="`${entry.at}-${index}`" class="ns-match__history-row">
            <span class="ns-match__history-time">{{ formatRelativeTime(entry.at) }}</span>
            <span class="ns-match__history-text" :title="historyText(entry)">{{ historyText(entry) }}</span>
          </li>
        </ul>
        <p class="ns-match__side-note">
          历史只用于回看，**不落库**：绑定关系本身已经写进数据库（bindSegment / unbindSegment），
          刷新页面后历史会清空，但绑定结果不会丢。
        </p>

        <h3 class="ns-match__side-title">判据速查</h3>
        <dl class="ns-match__facts">
          <dt>自动匹配</dt>
          <dd>按切片时长、停顿与画本行预计时长做 DP 对齐；有 ASR 结果时会更准（需显式开启）。</dd>
          <dt>置信度</dt>
          <dd>≥ 0.85 高（绿）/ ≥ 0.62 中（黄）/ 更低为低（红）：低置信建议人工核对。</dd>
          <dt>未录行</dt>
          <dd>导出预检的阻断项：必须补录，或在画本里删掉该行。</dd>
          <dt>未匹配片段</dt>
          <dd>通常是一次多录（重录、试音、咳嗽）；绑错行会直接导致 `wrong_order`。</dd>
        </dl>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.ns-match {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}
.ns-match__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}
.ns-match__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ns-match__eyebrow {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.ns-match__chapter {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 16px;
  font-weight: 600;
}
.ns-match__meta {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ns-match__head-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.ns-match__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.ns-match__card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--ns-border, #ebeef5);
  border-radius: 8px;
  background: var(--ns-bg, #fff);
}
.ns-match__card.is-success {
  border-color: color-mix(in srgb, var(--ns-success, #67c23a) 45%, var(--ns-border, #ebeef5));
}
.ns-match__card.is-warning {
  border-color: color-mix(in srgb, var(--ns-warning, #e6a23c) 45%, var(--ns-border, #ebeef5));
}
.ns-match__card.is-danger {
  border-color: color-mix(in srgb, var(--ns-danger, #f56c6c) 45%, var(--ns-border, #ebeef5));
}
.ns-match__card-value {
  color: var(--ns-text-primary, #303133);
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.ns-match__card-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-match__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 288px;
  gap: 12px;
  min-height: 0;
}
.ns-match__main {
  min-width: 0;
  border: 1px solid var(--ns-border, #ebeef5);
  border-radius: 8px;
  background: var(--ns-bg, #fff);
}
.ns-match__side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.ns-match__side-title {
  margin: 4px 0 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.ns-match__side-empty {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-match__history {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  margin: 0;
  padding: 6px;
  overflow: auto;
  border: 1px solid var(--ns-border, #ebeef5);
  border-radius: 6px;
  background: var(--ns-bg-subtle, #fafafa);
  list-style: none;
}
.ns-match__history-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
}
.ns-match__history-time {
  flex: 0 0 auto;
  width: 56px;
  color: var(--ns-text-secondary, #909399);
}
.ns-match__history-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-match__side-note {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-match__facts {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 4px 8px;
  margin: 0;
  font-size: 11px;
}
.ns-match__facts dt {
  color: var(--ns-text-secondary, #909399);
}
.ns-match__facts dd {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  line-height: 1.6;
}
</style>
