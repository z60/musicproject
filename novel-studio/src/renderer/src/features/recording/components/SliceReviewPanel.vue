<!--
  Novel Studio · 切片确认列表（docs/12 §4.4 / docs/05 §4.3）
  ============================================================================
  设计依据：
    · docs/12 §4.4 —— 左栏「切片列表」逐条给出：序号、匹配到的画本行、匹配分数、
      接受状态；未匹配的切片要一眼看出来（`?`），因为它们是用户唯一需要动脑的部分。
    · docs/12 §4.4 —— 表里的能力必须齐全：试听单个切片、手动匹配、拆分/合并、
      重切、接受策略（高置信自动接受 / 全部接受 / 全部拒绝）。
    · docs/05 §4.3 —— 边界精修后的切片带 RMS/峰值，用它们判断「这刀切得对不对」
      （RMS 明显偏低 = 多半把静音切进去了）。
    · docs/12 §4.4 —— 「原始会话永不删除」：重切随时可做，所以重切按钮不做二次确认。

  数据来源：`continuous.store`（切片 / 匹配 / 手工绑定 / 接受状态都在它里面）。
  组件**不直接调 IPC**：播放用 ns-media:// URL（media-url.ts），写库全走 store 的
  `record:acceptSlices` 等动作。

  一个必须说清的边界（store 里也写了）：`record:acceptSlices` 的载荷只有
  SliceMatch[]，不带边界。所以此处的「合并/拆分」只改本次确认的对照显示，
  真正落盘要重切 —— 面板顶部会用醒目的提示说明这一点（`needsReslice`）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { VadSlice } from '@shared/types.ts'
import { UNKNOWN, formatDb, formatDuration, formatScore } from '@/shared/lib/format.ts'
import { recordingUrl } from '@/shared/lib/media-url.ts'
import { useContinuousStore } from '../stores/continuous.store.ts'

const props = withDefaults(defineProps<{
  /** 项目 id（拼 ns-media:// URL 试听会话 WAV 必需） */
  projectId: string
  /** lineId → 展示串（`42 · 萧炎：我萧炎…`）；缺省时退回 lineId */
  lineLabels?: Record<string, string>
  /** 可绑定/改绑的画本行（未匹配切片的手工匹配用） */
  lineOptions?: Array<{ id: string; label: string }>
  /** 自动接受的高置信阈值（设置 canvas.autoAcceptConfidence） */
  threshold?: number
  /** 定稿/接受进行中：全部操作禁用 */
  disabled?: boolean
  compact?: boolean
}>(), {
  lineLabels: () => ({}),
  lineOptions: () => [],
  threshold: 0.85,
  disabled: false,
  compact: false,
})

const emit = defineEmits<{
  /** 选中某条切片（时间线同步高亮） */
  select: [sliceIndex: number]
  /** 手工绑定/解绑完成 */
  bindChanged: [sliceIndex: number, lineId: string | null]
  /** 接受状态变化 */
  acceptChanged: [sliceIndex: number, accepted: boolean]
  /** 批量操作后（参数 = 受影响的切片数） */
  bulkChanged: [count: number, action: 'all' | 'high' | 'reject' | 'reslice']
  /** 需要页面去跑重切（本组件不调 IPC） */
  requestReslice: []
}>()

const store = useContinuousStore()

/** 筛选模式（docs/12 §4.4 的「未匹配进待确认」） */
type FilterMode = 'all' | 'unmatched' | 'matched' | 'accepted' | 'rejected'
const filter = ref<FilterMode>('all')

/** 展开的行（拆分用：需要用户给一个片段内的时间点） */
const expandedIndex = ref<number | null>(null)
const splitAtMs = ref(0)

const FILTERS: Array<{ value: FilterMode; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'unmatched', label: '未匹配' },
  { value: 'matched', label: '已匹配' },
  { value: 'accepted', label: '已接受' },
  { value: 'rejected', label: '已拒绝' },
]

const slices = computed(() => store.slices)

function lineOf(index: number): string | null {
  return store.lineOf(index)
}

function isAccepted(index: number): boolean {
  return store.isAccepted(index)
}

function isMatched(index: number): boolean {
  return lineOf(index) !== null
}

function matchesFilter(mode: FilterMode, slice: VadSlice): boolean {
  const index = slice.sliceIndex
  switch (mode) {
    case 'unmatched': return !isMatched(index)
    case 'matched': return isMatched(index)
    case 'accepted': return isAccepted(index)
    case 'rejected': return isMatched(index) && !isAccepted(index)
    default: return true
  }
}

const visibleSlices = computed(() => slices.value.filter(slice => matchesFilter(filter.value, slice)))

const filterCounts = computed<Record<FilterMode, number>>(() => ({
  all: slices.value.length,
  unmatched: slices.value.filter(s => matchesFilter('unmatched', s)).length,
  matched: slices.value.filter(s => matchesFilter('matched', s)).length,
  accepted: slices.value.filter(s => matchesFilter('accepted', s)).length,
  rejected: slices.value.filter(s => matchesFilter('rejected', s)).length,
}))

const acceptedCount = computed(() => store.acceptedCount)
const totalSlices = computed(() => store.totalSlices)

/** 高置信（可被「仅接受高置信」采纳）的数量，用于按钮上的提示 */
const highConfidenceCount = computed(() => {
  let count = 0
  for (const slice of slices.value) {
    if (store.isHighConfidence(slice.sliceIndex, props.threshold)) count++
  }
  return count
})

function labelOf(index: number): string {
  const lineId = lineOf(index)
  if (!lineId) return '（未匹配）'
  return props.lineLabels[lineId] ?? lineId
}

function durationOf(slice: VadSlice): number {
  return Math.max(0, slice.endMs - slice.startMs)
}

function onSelect(index: number): void {
  store.select(index)
  emit('select', index)
}

function onToggleAccept(index: number): void {
  if (props.disabled) return
  store.toggleAccept(index)
  emit('acceptChanged', index, isAccepted(index))
}

function onBind(index: number, event: Event): void {
  if (props.disabled) return
  const value = (event.target as HTMLSelectElement).value
  if (!value) {
    store.unbind(index)
    emit('bindChanged', index, null)
    return
  }
  store.bind(index, value)
  emit('bindChanged', index, value)
}

function onUnbind(index: number): void {
  if (props.disabled) return
  store.unbind(index)
  emit('bindChanged', index, null)
}

function toggleExpand(index: number): void {
  expandedIndex.value = expandedIndex.value === index ? null : index
  const slice = slices.value.find(s => s.sliceIndex === index)
  splitAtMs.value = slice ? Math.round((slice.startMs + slice.endMs) / 2) : 0
}

function onMerge(index: number): void {
  if (props.disabled) return
  if (store.mergeWithNext(index)) emit('bulkChanged', 1, 'reslice')
}

function onSplit(index: number): void {
  if (props.disabled) return
  if (store.splitAt(index, splitAtMs.value)) emit('bulkChanged', 1, 'reslice')
}

// ── 接受策略（docs/12 §4.4） ─────────────────────────────────────────────────

function acceptAll(): void {
  if (props.disabled) return
  store.acceptAll()
  emit('bulkChanged', acceptedCount.value, 'all')
}

function acceptHigh(): void {
  if (props.disabled) return
  const changed = store.acceptHighConfidence(props.threshold)
  emit('bulkChanged', changed, 'high')
}

function rejectAll(): void {
  if (props.disabled) return
  store.rejectAll()
  emit('bulkChanged', 0, 'reject')
}

function requestReslice(): void {
  if (props.disabled) return
  emit('requestReslice')
}

// ── 试听（会话 WAV 的某个区间）───────────────────────────────────────────────
// 用**一个** <audio> 元素：同时只该有一路试听，避免「点了两条同时在放」。
const player = ref<HTMLAudioElement | null>(null)
const playingIndex = ref<number | null>(null)
let stopTimer: ReturnType<typeof setInterval> | null = null

const sessionUrl = computed(() => {
  if (!store.sessionId) return ''
  return recordingUrl(props.projectId, store.sessionId) ?? ''
})

function stopPlayback(): void {
  if (stopTimer) {
    clearInterval(stopTimer)
    stopTimer = null
  }
  player.value?.pause()
  playingIndex.value = null
}

async function playSlice(slice: VadSlice): Promise<void> {
  const element = player.value
  if (!element || !sessionUrl.value) return
  if (playingIndex.value === slice.sliceIndex) {
    stopPlayback()
    return
  }
  element.src = sessionUrl.value
  element.currentTime = slice.startMs / 1000
  playingIndex.value = slice.sliceIndex
  try {
    await element.play()
  } catch {
    // 播放失败（文件缺失/格式不支持）由页面统一走 error-bus（TAKE_SRC_MISSING 口径）
    stopPlayback()
    return
  }
  // 到 endMs 自动停（用定时器而不是 timeupdate：切片很短，timeupdate 太稀疏）
  stopTimer = setInterval(() => {
    const current = element.currentTime * 1000
    if (current >= slice.endMs - 5) stopPlayback()
  }, 25)
}

onBeforeUnmount(stopPlayback)
</script>

<template>
  <section class="ns-slice-panel" :class="{ 'is-compact': compact }">
    <header class="ns-slice-panel__header">
      <div class="ns-slice-panel__summary">
        <h4 class="ns-slice-panel__title">切片列表</h4>
        <p class="ns-slice-panel__counts">
          共 {{ totalSlices }} 片 · 已接受 {{ acceptedCount }} ·
          未匹配 {{ filterCounts.unmatched }} · 高置信（≥ {{ formatScore(threshold) }}）{{ highConfidenceCount }}
        </p>
      </div>
      <div class="ns-slice-panel__filters">
        <button
          v-for="item in FILTERS"
          :key="item.value"
          type="button"
          class="ns-slice-panel__filter"
          :class="{ 'is-on': filter === item.value }"
          @click="filter = item.value"
        >
          {{ item.label }}（{{ filterCounts[item.value] }}）
        </button>
      </div>
    </header>

    <p v-if="store.needsReslice" class="ns-slice-panel__warn">
      边界已被手动拆分/合并：接受时仍按主进程的原始边界落盘。要让新边界生效，请用「重切」。
    </p>
    <p v-if="store.analyzing || store.matching" class="ns-slice-panel__progress">
      正在分析：{{ formatDuration(store.progress.analyzedMs) }} / {{ formatDuration(store.progress.totalMs) }}
      （{{ Math.round(store.progressRatio * 100) }}%）
    </p>

    <div class="ns-slice-panel__actions">
      <button type="button" class="ns-slice-panel__button" :disabled="disabled" @click="acceptAll">
        全部接受
      </button>
      <button
        type="button"
        class="ns-slice-panel__button"
        :disabled="disabled || highConfidenceCount === 0"
        @click="acceptHigh"
      >
        仅接受高置信（{{ highConfidenceCount }}）
      </button>
      <button type="button" class="ns-slice-panel__button is-danger" :disabled="disabled" @click="rejectAll">
        全部拒绝
      </button>
      <button type="button" class="ns-slice-panel__button" :disabled="disabled" @click="requestReslice">
        重切（调 VAD 参数）
      </button>
    </div>

    <div class="ns-slice-panel__list" role="list">
      <article
        v-for="slice in visibleSlices"
        :key="slice.id"
        class="ns-slice-panel__row"
        :class="{
          'is-selected': store.selectedIndex === slice.sliceIndex,
          'is-accepted': isAccepted(slice.sliceIndex),
          'is-unmatched': !isMatched(slice.sliceIndex),
        }"
        role="listitem"
        @click="onSelect(slice.sliceIndex)"
      >
        <div class="ns-slice-panel__row-main">
          <span class="ns-slice-panel__index">{{ slice.sliceIndex + 1 }}</span>

          <span class="ns-slice-panel__time">
            {{ formatDuration(slice.startMs, { showMs: true }) }}
            →
            {{ formatDuration(slice.endMs, { showMs: true }) }}
            <em>（{{ formatDuration(durationOf(slice)) }}）</em>
          </span>

          <span class="ns-slice-panel__metrics">
            RMS {{ formatDb(slice.rmsDb) }} · 峰值 {{ formatDb(slice.peakDb) }}
          </span>

          <span class="ns-slice-panel__match">
            <select
              class="ns-slice-panel__select"
              :value="lineOf(slice.sliceIndex) ?? ''"
              :disabled="disabled"
              @click.stop
              @change="onBind(slice.sliceIndex, $event)"
            >
              <option value="">（未匹配）</option>
              <option v-for="option in lineOptions" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select>
            <span v-if="store.isManual(slice.sliceIndex)" class="ns-slice-panel__manual">手工</span>
          </span>

          <span class="ns-slice-panel__score" :title="`匹配分数：${formatScore(store.scoreOf(slice.sliceIndex))}`">
            {{ store.scoreOf(slice.sliceIndex) === null ? UNKNOWN : formatScore(store.scoreOf(slice.sliceIndex)) }}
          </span>

          <span class="ns-slice-panel__state">
            <button
              type="button"
              class="ns-slice-panel__toggle"
              :class="{ 'is-on': isAccepted(slice.sliceIndex), 'is-off': !isAccepted(slice.sliceIndex) }"
              :disabled="disabled || !isMatched(slice.sliceIndex)"
              :title="isMatched(slice.sliceIndex) ? '切换接受状态' : '未匹配的画本行不能被接受'"
              @click.stop="onToggleAccept(slice.sliceIndex)"
            >
              {{ isAccepted(slice.sliceIndex) ? '✓ 接受' : '✗ 拒绝' }}
            </button>
          </span>

          <span class="ns-slice-panel__row-actions">
            <button
              type="button"
              class="ns-slice-panel__link"
              :disabled="!sessionUrl"
              @click.stop="playSlice(slice)"
            >
              {{ playingIndex === slice.sliceIndex ? '停止' : '试听' }}
            </button>
            <button
              type="button"
              class="ns-slice-panel__link"
              :disabled="disabled || !store.isManual(slice.sliceIndex)"
              @click.stop="onUnbind(slice.sliceIndex)"
            >
              解绑
            </button>
            <button
              type="button"
              class="ns-slice-panel__link"
              :disabled="disabled"
              @click.stop="toggleExpand(slice.sliceIndex)"
            >
              {{ expandedIndex === slice.sliceIndex ? '收起' : '拆分/合并' }}
            </button>
          </span>
        </div>

        <p class="ns-slice-panel__line-text">{{ labelOf(slice.sliceIndex) }}</p>

        <div v-if="expandedIndex === slice.sliceIndex" class="ns-slice-panel__expand" @click.stop>
          <label class="ns-slice-panel__expand-field">
            拆分点（片段内毫秒）
            <input v-model.number="splitAtMs" type="number" min="0" :max="durationOf(slice)">
          </label>
          <button type="button" class="ns-slice-panel__button" :disabled="disabled" @click="onSplit(slice.sliceIndex)">
            在 {{ formatDuration(splitAtMs, { showMs: true }) }} 处拆分
          </button>
          <button type="button" class="ns-slice-panel__button" :disabled="disabled" @click="onMerge(slice.sliceIndex)">
            与下一片合并
          </button>
          <p class="ns-slice-panel__expand-note">
            拆分/合并只改本次确认的对照与统计；真正落盘需重切（原始会话 WAV 仍在）。
          </p>
        </div>
      </article>

      <p v-if="!visibleSlices.length" class="ns-slice-panel__empty">
        {{ totalSlices ? '当前筛选下没有切片' : '还没有切片结果：停止连续录制后会自动跑 VAD 分析' }}
      </p>
    </div>

    <audio ref="player" class="ns-slice-panel__audio" preload="metadata" @ended="stopPlayback" />
  </section>
</template>

<style scoped>
.ns-slice-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-elevated, #fff); }
.ns-slice-panel__header { display: flex; flex-direction: column; gap: 8px; }
.ns-slice-panel__title { margin: 0; font-size: 14px; color: var(--ns-text-primary, #303133); }
.ns-slice-panel__counts { margin: 4px 0 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-slice-panel__filters { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-slice-panel__filter { padding: 3px 8px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 12px; color: var(--ns-text-regular, #606266); cursor: pointer; }
.ns-slice-panel__filter.is-on { border-color: var(--ns-primary, #409eff); background: rgb(64 158 255 / 12%); color: var(--ns-primary, #409eff); }
.ns-slice-panel__warn { margin: 0; padding: 6px 10px; border-radius: 4px; background: rgb(230 162 60 / 14%); font-size: 12px; color: var(--ns-warning, #e6a23c); }
.ns-slice-panel__progress { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-slice-panel__actions { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-slice-panel__button { padding: 4px 10px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 12px; color: var(--ns-text-regular, #606266); cursor: pointer; }
.ns-slice-panel__button:hover:not(:disabled) { border-color: var(--ns-primary, #409eff); color: var(--ns-primary, #409eff); }
.ns-slice-panel__button.is-danger:hover:not(:disabled) { border-color: var(--ns-danger, #f56c6c); color: var(--ns-danger, #f56c6c); }
.ns-slice-panel__button:disabled { cursor: not-allowed; opacity: 0.5; }
.ns-slice-panel__list { display: flex; flex-direction: column; gap: 4px; max-height: 420px; overflow-y: auto; }
.ns-slice-panel__row { padding: 6px 8px; border: 1px solid transparent; border-bottom-color: var(--ns-border-light, #e4e7ed); border-radius: 4px; cursor: pointer; }
.ns-slice-panel__row:hover { background: var(--ns-fill-light, #f5f7fa); }
.ns-slice-panel__row.is-selected { border-color: var(--ns-primary, #409eff); background: rgb(64 158 255 / 8%); }
.ns-slice-panel__row.is-unmatched { border-left: 3px solid var(--ns-warning, #e6a23c); padding-left: 6px; }
.ns-slice-panel__row.is-accepted .ns-slice-panel__index { color: var(--ns-success, #67c23a); }
.ns-slice-panel__row-main { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: 12px; color: var(--ns-text-regular, #606266); }
.ns-slice-panel__index { min-width: 22px; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ns-text-secondary, #909399); }
.ns-slice-panel__time em { color: var(--ns-text-secondary, #909399); font-style: normal; }
.ns-slice-panel__metrics, .ns-slice-panel__score { font-variant-numeric: tabular-nums; color: var(--ns-text-secondary, #909399); }
.ns-slice-panel__match { display: inline-flex; gap: 4px; align-items: center; }
.ns-slice-panel__select { max-width: 220px; padding: 2px 4px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 3px; font-size: 12px; }
.ns-slice-panel__manual { padding: 0 4px; border-radius: 3px; background: rgb(64 158 255 / 12%); color: var(--ns-primary, #409eff); }
.ns-slice-panel__toggle { padding: 2px 8px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 3px; background: var(--ns-bg-elevated); font-size: 12px; cursor: pointer; }
.ns-slice-panel__toggle.is-on { border-color: var(--ns-success, #67c23a); color: var(--ns-success, #67c23a); }
.ns-slice-panel__toggle.is-off { border-color: var(--ns-border, #dcdfe6); color: var(--ns-text-secondary, #909399); }
.ns-slice-panel__toggle:disabled { cursor: not-allowed; opacity: 0.5; }
.ns-slice-panel__row-actions { display: inline-flex; gap: 8px; margin-left: auto; }
.ns-slice-panel__link { padding: 0; border: 0; background: transparent; font-size: 12px; color: var(--ns-primary, #409eff); cursor: pointer; }
.ns-slice-panel__link:disabled { color: var(--ns-text-placeholder, #c0c4cc); cursor: not-allowed; }
.ns-slice-panel__line-text { margin: 3px 0 0; overflow: hidden; font-size: 12px; color: var(--ns-text-secondary, #909399); text-overflow: ellipsis; white-space: nowrap; }
.ns-slice-panel__expand { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: var(--ns-fill-light, #f5f7fa); }
.ns-slice-panel__expand-field { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-slice-panel__expand-field input { width: 90px; padding: 2px 6px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 3px; }
.ns-slice-panel__expand-note { flex: 1 1 100%; margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-slice-panel__empty { margin: 0; padding: 20px 8px; text-align: center; font-size: 12px; color: var(--ns-text-secondary, #909399); }
/* 试听元素隐藏：它只是播放通道，界面上不需要控件（试听按钮控制它） */
.ns-slice-panel__audio { display: none; }
</style>
