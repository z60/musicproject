<!--
  Novel Studio · 重叠消解面板（docs/13 §4.3 / §4.8）
  ============================================================================
  设计依据：
    · docs/13 §4.3 —— 必须区分**同轨重叠（必须消解）**与**跨轨重叠**：
        相交 ≤ `maxCrossTrackOverlapMs`（默认 3000 ms）属正常对话，保留；
        超过上限才列入报告（`level: 'warning'`）；长间隙（> `maxGapMs`）多半是
        「缺录了一行」，与重叠是**不同的视觉等级** —— 因此三块分开列，绝不混在一张表里。
    · docs/13 §4.3「逐条处理优先于全局」—— 每条冲突都能单独选策略，因为
        「哪句该让」只有人知道；「全部按同一策略处理」是便利入口，不是默认路径。
    · docs/13 §4.8 —— 批量消解 = **一次撤销整批**（`resolveAllOverlaps` 只 push 一条命令），
        界面上必须把这句话写在按钮旁边，用户才敢按。
    · docs/13 §4.5 —— 消解前先「试试」：展示每个策略会移动谁、移动多少毫秒
        （`arrangement.previewResolution` 是纯函数，不落库、不进撤销栈）。

  唯一的状态来源是 `useOverlapResolver`（检测、逐条/批量消解、预演都在里面），
  本组件只负责排布与交互节奏。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ArrangeStrategy, Id } from '@shared/types.ts'
import { ARRANGE_STRATEGY_LABELS } from '@shared/constants.ts'
import { formatDuration } from '@/shared/lib/format.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { useOverlapResolver, RESOLVE_STRATEGIES } from '../composables/useOverlapResolver.ts'
import type { SameTrackConflictRow } from '../composables/useOverlapResolver.ts'

const props = withDefaults(defineProps<{
  /** 面板是否可见（不可见时不做预演计算，避免长章节的额外开销） */
  active?: boolean
  /** 用户切换策略后是否立刻同步到方案（默认只在面板内生效） */
  syncOnMount?: boolean
}>(), {
  active: true,
  syncOnMount: true,
})

const emit = defineEmits<{
  /** 跳到时间线某处并选中相关片段（视图负责滚动与选中） */
  focus: [payload: { itemIds: Id[]; timeMs: number | null }]
  /** 打开校验报告面板（跨轨/长间隙不属于消解范畴，引导过去看完整报告） */
  'open-validation': []
}>()

const resolver = useOverlapResolver()

if (props.syncOnMount) resolver.syncStrategyFromArrangement()

/** 批量消解前必须确认（影响面可能几十条，docs/11 §4.7 同类约定） */
const confirmAll = ref(false)
/** 逐条策略覆盖（未覆盖时跟随面板策略） */
const overrides = ref<Record<string, ArrangeStrategy>>({})
/** 展开预演的冲突 key */
const previewOpen = ref<string[]>([])

/** 四种策略（顺序来自 composable：默认项在前） */
const strategyOptions = computed(() => RESOLVE_STRATEGIES
  .map(value => ({ value, label: ARRANGE_STRATEGY_LABELS[value] ?? value })))

const sameTrack = computed(() => resolver.sameTrack.value)
const crossWarnings = computed(() => resolver.crossTrackWarnings.value)
const longGaps = computed(() => resolver.longGaps.value)
const counts = computed(() => resolver.counts.value)

const totalConflicts = computed(() => counts.value.sameTrack)

/** 预演：每条冲突 × 每个策略会怎么动（只在面板可见时算） */
const previews = computed(() => {
  if (!props.active) return new Map<string, ReturnType<typeof resolver.optionsFor>>()
  const map = new Map<string, ReturnType<typeof resolver.optionsFor>>()
  for (const row of sameTrack.value) map.set(row.key, resolver.optionsFor(row))
  return map
})

function strategyOf(row: SameTrackConflictRow): ArrangeStrategy {
  return overrides.value[row.key] ?? resolver.strategy.value
}

/** 面板策略：el-select 的选项值即 ArrangeStrategy */
function onStrategyInput(value: ArrangeStrategy): void {
  resolver.strategy.value = value
}

/** 单条冲突行的策略覆盖：el-select 的选项值即 ArrangeStrategy，v-for 内需带上行上下文 */
function onRowStrategyInput(row: SameTrackConflictRow): (value: ArrangeStrategy) => void {
  return (value: ArrangeStrategy): void => {
    overrides.value = { ...overrides.value, [row.key]: value }
  }
}

function effectOf(row: SameTrackConflictRow): string {
  const list = previews.value.get(row.key) ?? []
  const hit = list.find(option => option.strategy === strategyOf(row))
  return hit?.effect ?? '—'
}

function isPreviewOpen(row: SameTrackConflictRow): boolean {
  return previewOpen.value.includes(row.key)
}

function togglePreview(row: SameTrackConflictRow): void {
  previewOpen.value = isPreviewOpen(row)
    ? previewOpen.value.filter(key => key !== row.key)
    : [...previewOpen.value, row.key]
}

function focusRow(row: SameTrackConflictRow): void {
  emit('focus', { itemIds: [row.a, row.b], timeMs: Math.min(row.aStartMs, row.bStartMs) })
}

function focusTime(timeMs: number | null, ids: Id[] = []): void {
  emit('focus', { itemIds: ids, timeMs })
}

/** 逐条消解：选好策略 → 调 alignment:resolveOverlap（一条撤销命令） */
async function resolveOne(row: SameTrackConflictRow): Promise<void> {
  if (resolver.busy.value) return
  const ok = await resolver.applyPair(row, strategyOf(row))
  if (ok) {
    const next = { ...overrides.value }
    delete next[row.key]
    overrides.value = next
    // 消解后这一条的起点可能变了，重新聚焦一次便于核对
    focusRow(row)
  }
}

async function confirmApplyAll(): Promise<void> {
  confirmAll.value = false
  const handled = await resolver.applyAll()
  if (handled > 0) {
    overrides.value = {}
    previewOpen.value = []
  }
}

const batchDetails = computed(() => {
  const details = [
    `将按「${ARRANGE_STRATEGY_LABELS[resolver.strategy.value] ?? resolver.strategy.value}」处理 ${totalConflicts.value} 处同轨重叠。`,
    '只移动未锁定的片段；已锁定的片段会被跳过并在校验里继续报出。',
    '整批只产生一条撤销记录：Ctrl+Z 可一次全部还原（docs/13 §4.8）。',
  ]
  // 片段已被删除的冲突（画本改过之后会短暂出现）无法自动处理，必须提前说清
  const orphan = sameTrack.value.filter(row => row.aLabel === '（已删除）' || row.bLabel === '（已删除）').length
  if (orphan > 0) details.push(`其中 ${orphan} 处涉及的片段已被删除，会被跳过。`)
  return details
})
</script>

<template>
  <div class="ns-overlap">
    <header class="ns-overlap__head">
      <h3 class="ns-overlap__title">重叠与间隙</h3>
      <el-tag size="small" :type="totalConflicts > 0 ? 'danger' : 'success'">
        同轨重叠 {{ totalConflicts }}
      </el-tag>
      <el-tag size="small" :type="counts.crossTrackWarning > 0 ? 'warning' : 'info'">
        跨轨告警 {{ counts.crossTrackWarning }}
      </el-tag>
      <el-tag size="small" :type="counts.longGap > 0 ? 'warning' : 'info'">
        长间隙 {{ counts.longGap }}
      </el-tag>
    </header>

    <p v-if="resolver.message.value" class="ns-overlap__message">{{ resolver.message.value }}</p>

    <!-- 面板策略 + 批量入口 -->
    <section class="ns-overlap__batch">
      <label class="ns-overlap__batch-label">策略</label>
      <el-select :model-value="resolver.strategy.value" size="small" class="ns-overlap__select" @update:model-value="onStrategyInput">
        <el-option v-for="option in strategyOptions" :key="option.value" :value="option.value" :label="option.label" />
      </el-select>
      <el-button
        size="small"
        type="primary"
        :disabled="totalConflicts === 0 || resolver.busy.value"
        :loading="resolver.busy.value"
        @click="confirmAll = true"
      >
        全部按同一策略处理
      </el-button>
    </section>
    <p class="ns-overlap__hint">
      建议先用「串行化」（后一段整体后移）：它不动波形内容，只改位置，最容易核对。
      压缩留白 / 紧贴会改动前后间隙，适合已经确认过的段落。
    </p>

    <!-- 同轨重叠：逐条 -->
    <EmptyState
      v-if="totalConflicts === 0"
      icon="🎯"
      size="small"
      title="没有同轨重叠"
      :description="counts.crossTrackWarning + counts.longGap > 0
        ? '跨轨重叠与长间隙不是消解范畴，请到校验报告查看。'
        : '当前方案在时间上没有两段压在一条轨上的情况。'"
      :action-text="counts.crossTrackWarning + counts.longGap > 0 ? '打开校验报告' : ''"
      @action="emit('open-validation')"
    />

    <ul v-else class="ns-overlap__list">
      <li v-for="row in sameTrack" :key="row.key" class="ns-overlap__item">
        <div class="ns-overlap__item-head" @click="focusRow(row)">
          <span class="ns-overlap__track" :title="row.trackName">{{ row.trackName }}</span>
          <span class="ns-overlap__overlap">{{ formatDuration(row.overlapMs, { showMs: true }) }}</span>
          <span class="ns-overlap__range">
            {{ formatDuration(row.aStartMs) }}–{{ formatDuration(row.aEndMs) }}
            ✕
            {{ formatDuration(row.bStartMs) }}–{{ formatDuration(row.bEndMs) }}
          </span>
        </div>

        <div class="ns-overlap__pair">
          <div class="ns-overlap__side">
            <span class="ns-overlap__tag">前</span>
            <span class="ns-overlap__label" :title="row.aLabel">{{ row.aLabel }}</span>
          </div>
          <div class="ns-overlap__side">
            <span class="ns-overlap__tag">后</span>
            <span class="ns-overlap__label" :title="row.bLabel">{{ row.bLabel }}</span>
          </div>
        </div>

        <div class="ns-overlap__item-actions">
          <el-select
            :model-value="strategyOf(row)"
            size="small"
            class="ns-overlap__select ns-overlap__select--row"
            @update:model-value="onRowStrategyInput(row)"
          >
            <el-option v-for="option in strategyOptions" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
          <el-button size="small" text @click="togglePreview(row)">
            {{ isPreviewOpen(row) ? '收起预览' : '处理后预览' }}
          </el-button>
          <el-button size="small" :disabled="resolver.busy.value" @click="resolveOne(row)">按此策略消解</el-button>
        </div>

        <!-- 处理后预览：谁会动、动多少（纯函数预演，不改数据） -->
        <div v-if="isPreviewOpen(row)" class="ns-overlap__preview">
          <p class="ns-overlap__preview-title">当前策略「{{ ARRANGE_STRATEGY_LABELS[strategyOf(row)] ?? strategyOf(row) }}」的后果：</p>
          <p class="ns-overlap__preview-line">{{ effectOf(row) }}</p>
          <ul class="ns-overlap__preview-list">
            <li v-for="option in (previews.get(row.key) ?? [])" :key="option.strategy">
              <span class="ns-overlap__preview-name">{{ option.label }}</span>
              <span class="ns-overlap__preview-effect">{{ option.effect }}</span>
            </li>
          </ul>
        </div>
      </li>
    </ul>

    <!-- 跨轨重叠告警：不是消解范畴，只作提示与跳转 -->
    <section v-if="crossWarnings.length" class="ns-overlap__section">
      <h4 class="ns-overlap__section-title">跨轨重叠过大（{{ crossWarnings.length }}）</h4>
      <ul class="ns-overlap__mini-list">
        <li
          v-for="row in crossWarnings"
          :key="row.key"
          class="ns-overlap__mini-row"
          @click="focusTime(row.timeMs, [row.a, row.b])"
        >
          <span class="ns-overlap__mini-time">{{ formatDuration(row.timeMs) }}</span>
          <span class="ns-overlap__mini-text">{{ row.aLabel }} ✕ {{ row.bLabel }}</span>
          <span class="ns-overlap__mini-num">{{ formatDuration(row.overlapMs, { showMs: true }) }}</span>
        </li>
      </ul>
      <p class="ns-overlap__hint">
        跨轨重叠属于「正常对话」的范畴：只有超过上限才会列在这里。
        若确实是串场，请改时间线或在画本里调整角色归属。
      </p>
    </section>

    <!-- 长间隙：多半是缺录了一行 -->
    <section v-if="longGaps.length" class="ns-overlap__section">
      <h4 class="ns-overlap__section-title">过长静音（{{ longGaps.length }}）</h4>
      <ul class="ns-overlap__mini-list">
        <li
          v-for="row in longGaps"
          :key="row.key"
          class="ns-overlap__mini-row"
          @click="focusTime(row.timeMs, row.afterItemId ? [row.afterItemId] : [])"
        >
          <span class="ns-overlap__mini-time">{{ row.timeMs === null ? '—' : formatDuration(row.timeMs) }}</span>
          <span class="ns-overlap__mini-text">{{ row.label }}</span>
        </li>
      </ul>
    </section>

    <ConfirmDialog
      v-model="confirmAll"
      type="danger"
      title="全部按同一策略消解重叠？"
      :message="`将一次处理 ${totalConflicts} 处同轨重叠。`"
      :details="batchDetails"
      confirm-text="执行整批消解"
      @confirm="confirmApplyAll"
    />
  </div>
</template>

<style scoped>
.ns-overlap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
  font-size: 12px;
}
.ns-overlap__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ns-overlap__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-overlap__message {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ns-success, #67c23a) 10%, var(--ns-bg, #fff));
  color: var(--ns-text-regular, #606266);
}
.ns-overlap__batch {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ns-overlap__batch-label {
  color: var(--ns-text-secondary, #909399);
}
.ns-overlap__select {
  width: 110px;
}
.ns-overlap__select--row {
  width: 96px;
}
.ns-overlap__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-overlap__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ns-overlap__item {
  padding: 8px;
  border: 1px solid var(--ns-border, #ebeef5);
  border-left: 3px solid var(--ns-danger, #f56c6c);
  border-radius: 6px;
  background: var(--ns-bg, #fff);
}
.ns-overlap__item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.ns-overlap__track {
  max-width: 72px;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-overlap__overlap {
  color: var(--ns-danger, #f56c6c);
  font-variant-numeric: tabular-nums;
}
.ns-overlap__range {
  margin-left: auto;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ns-overlap__pair {
  margin: 6px 0;
}
.ns-overlap__side {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.ns-overlap__tag {
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-bg-subtle, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-overlap__label {
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-overlap__item-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ns-overlap__preview {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--ns-bg-subtle, #f5f7fa);
}
.ns-overlap__preview-title {
  margin: 0 0 4px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-overlap__preview-line {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
}
.ns-overlap__preview-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ns-overlap__preview-name {
  display: inline-block;
  width: 64px;
  color: var(--ns-text-secondary, #909399);
}
.ns-overlap__preview-effect {
  color: var(--ns-text-regular, #606266);
}
.ns-overlap__section {
  padding-top: 8px;
  border-top: 1px solid var(--ns-border, #ebeef5);
}
.ns-overlap__section-title {
  margin: 0 0 4px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.ns-overlap__mini-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
}
.ns-overlap__mini-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.ns-overlap__mini-row:hover {
  background: var(--ns-bg-subtle, #f5f7fa);
}
.ns-overlap__mini-time {
  flex: 0 0 auto;
  width: 52px;
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-overlap__mini-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-overlap__mini-num {
  flex: 0 0 auto;
  color: var(--ns-warning, #e6a23c);
  font-variant-numeric: tabular-nums;
}
</style>
