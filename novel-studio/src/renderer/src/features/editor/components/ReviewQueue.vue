<!--
  画本编辑 · 待确认队列（docs/11 §4.5「效率关键：3 分钟清 100 行」）
  ============================================================================
  ┌────────────────────────────────────────────────────────┐
  │ 待确认 37 行（第 12/37）      [一键确认高置信] [跳过]     │
  ├────────────────────────────────────────────────────────┤
  │ 上下文： 11 (旁白) … / 12 (?) … ← 当前行 / 13 (旁白) …   │
  ├────────────────────────────────────────────────────────┤
  │ 归属： [1 萧炎 0.58] [2 药老 0.54] [3 旁白] [4 其它▾]    │
  └────────────────────────────────────────────────────────┘

  全键盘（键位表来自 shared/lib/shortcuts.ts 的 REVIEW_QUEUE_SHORTCUTS，界面提示与实现同源）：
    1/2/3 选候选并完成该行 · Enter 确认并下一行 · S 跳过 · P 播放 · Z 撤销
    Ctrl+Enter 应用到下面 N 行 · Ctrl+Shift+Enter 一键确认高置信
  输入框里不抢键（useCanvasKeyboard 内部用 isEditableTarget 判断）。
-->

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CanvasLine, Id } from '@shared/types.ts'
import { LINE_KIND_LABELS } from '@shared/constants.ts'
import { formatDuration, formatDurationLong, formatInt, formatPercent, formatScore } from '@/shared/lib/format.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useCanvasKeyboard } from '../composables/useCanvasKeyboard.ts'
import { useSpeakerAssign } from '../composables/useSpeakerAssign.ts'
import { useCanvasStore } from '../stores/canvas.store.ts'
import { useReviewStore } from '../stores/review.store.ts'
import { useCharactersStore } from '../stores/characters.store.ts'

const props = withDefaults(defineProps<{
  /** 只读（任务包模式）：只能看与跳过，不能改归属 */
  readonly?: boolean
  /** 是否接管键盘（该视图可见时为 true） */
  active?: boolean
}>(), {
  readonly: false,
  active: true,
})

const emit = defineEmits<{
  /** 打开单行编辑抽屉 */
  open: [lineId: Id]
  /** 定位原文 */
  locate: [lineId: Id]
  /** 队列变化（父组件刷新质检 / 状态栏） */
  changed: []
  /** 请求回到表格视图（清空后引导） */
  'back-to-table': []
}>()

const canvas = useCanvasStore()
const review = useReviewStore()
const speaker = useSpeakerAssign()
const characters = useCharactersStore()

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const playbackHint = ref('')
const busy = ref(false)

const current = computed(() => review.current)
const candidates = computed(() => (current.value ? speaker.candidatesOf(current.value, 3) : []))
const progress = computed(() => review.progress)

/** 「其它…」= 打开抽屉手工指派 */
function openManual(line: CanvasLine): void {
  emit('open', line.id)
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

const keyboard = useCanvasKeyboard({
  scope: 'review',
  enabled: () => props.active && !props.readonly,
  actions: {
    'review.pick1': () => void pick(0),
    'review.pick2': () => void pick(1),
    'review.pick3': () => void pick(2),
    'review.confirm': () => void confirm(),
    'review.skip': () => skip(),
    'review.play': () => void play(),
    'review.undo': () => void undo(),
    'review.applyRun': () => void applyRun(),
    'review.acceptHigh': () => void acceptHigh(),
    'review.next': () => review.advance(),
    'review.prev': () => review.setIndex(review.index - 1),
    'editor.save': () => void canvas.saveNow(),
    'editor.undo': () => void canvas.undo(),
    'editor.redo': () => void canvas.redo(),
    'editor.showTable': () => emit('back-to-table'),
    'editor.showScript': () => emit('back-to-table'),
  },
})

onMounted(async () => {
  keyboard.attach()
  await review.build()
})

onBeforeUnmount(() => {
  keyboard.detach()
  audioEl.value?.pause()
})

// 切换到队列视图时确保队列是新的（可能刚在表格里改过归属）
watch(() => props.active, async (active) => {
  if (!active) {
    keyboard.detach()
    return
  }
  keyboard.attach()
  await review.build()
})

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function pick(index: number): Promise<void> {
  if (props.readonly) return
  const before = review.confirmedCount
  await review.pickCandidate(index)
  if (review.confirmedCount !== before) emit('changed')
}

async function confirm(): Promise<void> {
  if (props.readonly) return
  await review.confirmCurrent()
  emit('changed')
}

function skip(): void {
  review.skipCurrent()
  emit('changed')
}

async function undo(): Promise<void> {
  await review.undoLast()
  emit('changed')
}

async function applyRun(): Promise<void> {
  if (props.readonly) return
  const result = await review.applyRunToNext()
  if (result.applied) emit('changed')
}

async function acceptHigh(): Promise<void> {
  if (props.readonly) return
  await review.acceptHighConfidence()
  emit('changed')
}

/** P：播放当前行的录音（没有录音时给明确提示，而不是静默失败） */
async function play(): Promise<void> {
  const line = current.value
  if (!line) return
  if (playing.value) {
    audioEl.value?.pause()
    playing.value = false
    return
  }
  playbackHint.value = ''
  const info = await canvas.loadPlayback(line.id)
  if (!info) {
    playbackHint.value = '这一行还没有录音。'
    return
  }
  await nextTick()
  try {
    await audioEl.value?.play()
    playing.value = true
  } catch {
    playbackHint.value = '播放失败，可能是音频文件已被移动。'
  }
}

async function rebuild(): Promise<void> {
  busy.value = true
  try {
    await review.build()
    emit('changed')
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------------------
// 队列来源与批量应用行数
// ---------------------------------------------------------------------------

/** 低置信来源（el-checkbox）：载荷为 boolean | string | number */
function onNeedsReviewSourceInput(value: boolean | string | number): void {
  review.setSources({ needsReview: Boolean(value) })
  void rebuild()
}

/** 质检标记来源（el-checkbox）：载荷为 boolean | string | number */
function onQualitySourceInput(value: boolean | string | number): void {
  review.setSources({ quality: Boolean(value) })
  void rebuild()
}

/** 未分配来源（el-checkbox）：载荷为 boolean | string | number */
function onUnassignedSourceInput(value: boolean | string | number): void {
  review.setSources({ unassigned: Boolean(value) })
  void rebuild()
}

/** 批量应用行数（el-input-number）：载荷为 number，输入框被清空时为 undefined */
function onRunLengthInput(value: number | undefined): void {
  review.setRunLength(value ?? 10)
}

function speakerLabelOf(line: CanvasLine | null): string {
  return speaker.speakerLabel(line)
}

function kindLabelOf(line: CanvasLine | null): string {
  if (!line) return ''
  return LINE_KIND_LABELS[line.kind] ?? line.kind
}

function lineColor(line: CanvasLine | null): string {
  return characters.colorOf(line?.characterId ?? null)
}

function confidenceText(score: number | null): string {
  return formatScore(score)
}

/** 完成反馈文案：说清「清了多少行、用了多久、平均每行多长时间」 */
const finishedSummary = computed(() => {
  const done = progress.value.done
  const elapsed = progress.value.elapsedMs
  const perLine = progress.value.perLineMs
  return `已处理 ${formatInt(done)} 行，用时 ${formatDurationLong(elapsed)}${perLine ? `（平均每行 ${(perLine / 1000).toFixed(1)} 秒）` : ''}`
})
</script>

<template>
  <div class="ns-review">
    <!-- 顶部：进度 + 一键确认 + 跳过 -->
    <header class="ns-review__head">
      <div class="ns-review__count">
        待确认 <strong>{{ formatInt(review.remaining) }}</strong> 行
        <span v-if="review.total" class="ns-review__position">（第 {{ formatInt(review.position) }}/{{ formatInt(review.total) }}）</span>
      </div>

      <el-button size="small" type="primary" plain :disabled="!review.highConfidenceTargets.length" @click="acceptHigh">
        一键确认高置信（{{ review.highConfidenceTargets.length }}）
      </el-button>
      <el-button size="small" :disabled="!current" @click="skip">跳过</el-button>
      <el-button size="small" text @click="rebuild">重新构建队列</el-button>
    </header>

    <!-- 进度与剩余预估 -->
    <div class="ns-review__progress">
      <el-progress
        :percentage="Math.round(progress.ratio * 100)"
        :stroke-width="6"
        :show-text="false"
        class="ns-review__bar"
      />
      <span class="ns-review__progress-text">
        {{ formatPercent(progress.ratio) }}
        · 已处理 {{ formatInt(progress.done) }}（确认 {{ formatInt(progress.confirmed) }} / 跳过 {{ formatInt(progress.skipped) }}）
        · 已用 {{ formatDuration(progress.elapsedMs) }}
        <template v-if="progress.etaMs !== null"> · 剩余约 {{ formatDuration(progress.etaMs) }}</template>
        <template v-else-if="progress.remaining > 0"> · 剩余预估需处理几行后才准</template>
      </span>
    </div>

    <!-- 队列来源筛选 -->
    <div class="ns-review__sources">
      <span class="ns-review__sources-label">队列来源</span>
      <el-checkbox
        :model-value="review.sources.needsReview"
        size="small"
        @update:model-value="onNeedsReviewSourceInput"
      >
        低置信（needsReview）
      </el-checkbox>
      <el-checkbox
        :model-value="review.sources.quality"
        size="small"
        @update:model-value="onQualitySourceInput"
      >
        质检标记
      </el-checkbox>
      <el-checkbox
        :model-value="review.sources.unassigned"
        size="small"
        @update:model-value="onUnassignedSourceInput"
      >
        未分配
      </el-checkbox>

      <span class="ns-review__run-label">Ctrl+Enter 应用行数</span>
      <el-input-number
        :model-value="review.runLength"
        :min="1"
        :max="200"
        size="small"
        controls-position="right"
        class="ns-review__run-input"
        @update:model-value="onRunLengthInput"
      />
    </div>

    <LoadingBlock v-if="review.building" text="正在构建待确认队列…" :min-height="'240px'" />

    <!-- 空态：全部清空时给明确完成反馈 -->
    <EmptyState
      v-else-if="!review.total"
      title="待确认队列已经清空"
      :description="review.confirmedCount ? finishedSummary : '当前来源设置下没有需要确认的行。'"
      icon="🎉"
      action-text="回到表格"
      hint="可以放宽「队列来源」，或继续在表格里通读检查。"
      @action="emit('back-to-table')"
    />

    <template v-else>
      <!-- 上下文：上一行 / 当前行 / 下一行 -->
      <section class="ns-review__context">
        <div class="ns-review__ctx-row" :class="{ 'is-current': false }">
          <span class="ns-review__ctx-seq">{{ review.previous?.seq ?? '—' }}</span>
          <span class="ns-review__ctx-speaker">{{ speakerLabelOf(review.previous) }}</span>
          <span class="ns-review__ctx-text">{{ review.previous?.text ?? '（已是第一行）' }}</span>
        </div>

        <div class="ns-review__ctx-row is-current">
          <span class="ns-review__ctx-seq">{{ current?.seq ?? '—' }}</span>
          <span class="ns-review__ctx-speaker" :style="{ color: lineColor(current) }">
            {{ current ? speakerLabelOf(current) : '' }}
          </span>
          <span class="ns-review__ctx-text">{{ current?.text ?? '' }}</span>
          <span class="ns-review__ctx-kind">{{ kindLabelOf(current) }}</span>
        </div>

        <div class="ns-review__ctx-row">
          <span class="ns-review__ctx-seq">{{ review.nextItem?.seq ?? '—' }}</span>
          <span class="ns-review__ctx-speaker">{{ speakerLabelOf(review.nextItem) }}</span>
          <span class="ns-review__ctx-text">{{ review.nextItem?.text ?? '（已是最后一行）' }}</span>
        </div>
      </section>

      <!-- 归属候选 -->
      <section class="ns-review__candidates">
        <span class="ns-review__candidates-label">归属</span>

        <button
          v-for="(candidate, index) in candidates"
          :key="candidate.characterId"
          type="button"
          class="ns-review__candidate"
          :class="{ 'is-top': index === 0 }"
          :disabled="readonly"
          @click="pick(index)"
        >
          <em>{{ index + 1 }}</em>
          <i class="ns-review__dot" :style="{ background: characters.colorOf(candidate.characterId) }" />
          <span class="ns-review__candidate-name">{{ candidate.name || characters.nameOf(candidate.characterId) }}</span>
          <span class="ns-review__candidate-score">{{ confidenceText(candidate.score) }}</span>
        </button>

        <button
          type="button"
          class="ns-review__candidate"
          :disabled="readonly"
          @click="review.pickNarration()"
        >
          <em>{{ candidates.length + 1 }}</em>
          <span class="ns-review__candidate-name">旁白</span>
        </button>

        <button
          type="button"
          class="ns-review__candidate ns-review__candidate--more"
          :disabled="readonly"
          @click="current && openManual(current)"
        >
          其它…
        </button>

        <span v-if="!candidates.length" class="ns-review__no-candidate">
          这一行没有候选分数 —— 用「其它…」在抽屉里手工指派。
        </span>
      </section>

      <!-- 当前行的辅助信息 -->
      <section class="ns-review__meta">
        <span>置信度 {{ confidenceText(current?.confidence ?? null) }}</span>
        <span>判定 {{ current?.decidedBy === 'human' ? '人工' : '自动' }}</span>
        <span v-if="current?.flags.length">标记 {{ current.flags.join('、') }}</span>
        <el-button size="small" text @click="current && play()">{{ playing ? '暂停' : '播放（P）' }}</el-button>
        <el-button size="small" text @click="current && emit('locate', current.id)">看原文</el-button>
        <span v-if="playbackHint" class="ns-review__hint">{{ playbackHint }}</span>
      </section>

      <audio
        ref="audioEl"
        class="ns-review__player"
        :src="canvas.playbackUrl ?? undefined"
        preload="none"
        @ended="playing = false"
        @pause="playing = false"
      />

      <!-- 键位提示（与实现同源，改键位不会漏改提示） -->
      <footer class="ns-review__keys">
        <span><kbd>{{ keyboard.hint('review.pick1') }}</kbd>/<kbd>{{ keyboard.hint('review.pick2') }}</kbd>/<kbd>{{ keyboard.hint('review.pick3') }}</kbd> 选候选</span>
        <span><kbd>{{ keyboard.hint('review.confirm') }}</kbd> 确认并下一行</span>
        <span><kbd>{{ keyboard.hint('review.skip') }}</kbd> 跳过</span>
        <span><kbd>{{ keyboard.hint('review.play') }}</kbd> 播放</span>
        <span><kbd>{{ keyboard.hint('review.undo') }}</kbd> 撤销</span>
        <span><kbd>{{ keyboard.hint('review.applyRun') }}</kbd> 应用到下面 N 行</span>
        <span><kbd>{{ keyboard.hint('review.acceptHigh') }}</kbd> 一键确认高置信</span>
        <span v-if="readonly" class="ns-review__readonly">任务包模式：只读，仅可跳过</span>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.ns-review {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 10px 12px;
  overflow: auto;
}
.ns-review__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ns-review__count {
  font-size: 14px;
  color: var(--ns-text-primary, #303133);
}
.ns-review__count strong {
  color: var(--ns-warning, #e6a23c);
  font-size: 18px;
}
.ns-review__position {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-review__progress {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ns-review__bar {
  flex: 1;
}
.ns-review__progress-text {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  white-space: nowrap;
}
.ns-review__sources {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-review__sources-label,
.ns-review__run-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-review__run-input {
  width: 96px;
}
.ns-review__context {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-review__ctx-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
}
.ns-review__ctx-row.is-current {
  background: rgb(64 158 255 / 12%);
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
}
.ns-review__ctx-seq {
  flex: 0 0 40px;
  font-variant-numeric: tabular-nums;
}
.ns-review__ctx-speaker {
  flex: 0 0 76px;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-review__ctx-text {
  flex: 1;
  word-break: break-word;
}
.ns-review__ctx-kind {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 8px;
  background: #fff;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  font-weight: 400;
}
.ns-review__candidates {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ns-review__candidates-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-review__candidate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 16px;
  background: #fff;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  cursor: pointer;
}
.ns-review__candidate.is-top {
  border-color: var(--ns-primary, #409eff);
  box-shadow: 0 1px 4px rgb(64 158 255 / 20%);
}
.ns-review__candidate:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.ns-review__candidate em {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--ns-fill, #ebeef5);
  font-size: 11px;
  font-style: normal;
}
.ns-review__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.ns-review__candidate-name {
  font-weight: 600;
}
.ns-review__candidate-score {
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-review__candidate--more {
  border-style: dashed;
}
.ns-review__no-candidate {
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
}
.ns-review__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-review__hint {
  color: var(--ns-warning, #e6a23c);
}
.ns-review__player {
  width: 100%;
  height: 32px;
}
.ns-review__keys {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-review__keys kbd {
  padding: 0 4px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  font-family: ui-monospace, Consolas, monospace;
}
.ns-review__readonly {
  color: var(--ns-primary, #409eff);
}
</style>
