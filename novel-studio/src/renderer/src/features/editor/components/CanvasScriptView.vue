<!--
  画本编辑 · 剧本视图（连续阅读，docs/11 §4.3）
  ============================================================================
  设计依据：
    · 旁白（灰色）、台词（按角色配色 + 角色名前缀）、内心（虚线下划线）、音效（括号样式）
    · 情绪与停顿以**行内小标签**呈现（不打断阅读）
    · 适合「通读找错」；表格适合「批量改」
    · 两视图共享同一份数据与选中行（切换视图保持位置）

  行高取舍：这里用**固定行高 + 文本截断（最多 3 行）**而不是逐行测高。
  理由：逐行测高在 5000 行下要么付出一次全量布局的成本，要么滚动时抖位；
  而固定行高可以让虚拟滚动保持 30 fps 以上，与表格视图口径一致。
  位置还原用「行下标」而不是像素偏移（两视图行高不同，用行号才准）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CanvasLine, Id } from '@shared/types.ts'
import { LINE_KIND_LABELS } from '@shared/constants.ts'
import { computeScrollToIndex, computeVisibleRange, indexAtOffset } from '@/shared/lib/virtual-list.ts'
import { formatInt } from '@/shared/lib/format.ts'
import EmotionTagPicker from './EmotionTagPicker.vue'
import { useCanvasStore } from '../stores/canvas.store.ts'
import { useCharactersStore } from '../stores/characters.store.ts'

const props = withDefaults(defineProps<{
  /** 要渲染的行（已筛选） */
  lines: CanvasLine[]
  /** 只读 */
  readonly?: boolean
  /** 行密度 */
  density?: 'compact' | 'standard'
  /** 当前行（与表格 / 抽屉共享） */
  activeLineId?: Id | null
  /** 有质检问题的行 */
  issueLineIds?: Set<Id>
  /** 初始滚动位置（切视图时从 store 还原） */
  initialScrollTop?: number
  /** 初始滚动位置对应的行下标 */
  initialTopIndex?: number
}>(), {
  readonly: false,
  density: 'standard',
  activeLineId: null,
  issueLineIds: () => new Set<Id>(),
  initialScrollTop: 0,
  initialTopIndex: 0,
})

const emit = defineEmits<{
  scroll: [scrollTop: number, topIndex: number]
  open: [lineId: Id]
  locate: [lineId: Id]
  changed: [lineId: Id]
}>()

const canvas = useCanvasStore()
const characters = useCharactersStore()

/** 固定行高：紧凑 56（2 行文本）/ 标准 76（3 行文本） */
const ROW_HEIGHT = computed(() => (props.density === 'compact' ? 56 : 76))
const OVERSCAN = 6

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(props.initialScrollTop)
const viewportHeight = ref(600)
let frame = 0
let resizeObserver: ResizeObserver | null = null

const total = computed(() => props.lines.length)
const range = computed(() => computeVisibleRange({
  scrollTop: scrollTop.value,
  viewportHeight: viewportHeight.value,
  rowHeight: ROW_HEIGHT.value,
  total: total.value,
  overscan: OVERSCAN,
}))

const visibleLines = computed(() => {
  if (range.value.endIndex < range.value.startIndex) return []
  return props.lines.slice(range.value.startIndex, range.value.endIndex + 1)
})

function measure(): void {
  const el = scroller.value
  if (el && el.clientHeight > 0) viewportHeight.value = el.clientHeight
}

function onScroll(): void {
  const el = scroller.value
  if (!el || frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const top = el.scrollTop
    scrollTop.value = top
    emit('scroll', top, indexAtOffset(top, ROW_HEIGHT.value, total.value))
  })
}

function scrollToIndex(index: number): void {
  const el = scroller.value
  if (!el || index < 0) return
  const next = computeScrollToIndex(index, {
    currentScrollTop: el.scrollTop,
    rowHeight: ROW_HEIGHT.value,
    total: total.value,
    viewportHeight: viewportHeight.value,
  })
  el.scrollTop = next
  scrollTop.value = next
}

onMounted(() => {
  measure()
  const el = scroller.value
  if (el) {
    if (props.initialTopIndex > 0) el.scrollTop = props.initialTopIndex * ROW_HEIGHT.value
    else if (props.initialScrollTop > 0) el.scrollTop = props.initialScrollTop
    scrollTop.value = el.scrollTop
  }
  if (typeof ResizeObserver !== 'undefined' && el) {
    resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(el)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (frame) cancelAnimationFrame(frame)
})

watch(total, (next) => {
  const el = scroller.value
  if (!el) return
  const max = Math.max(0, next * ROW_HEIGHT.value - viewportHeight.value)
  if (el.scrollTop > max) {
    el.scrollTop = max
    scrollTop.value = max
  }
})

watch(() => props.density, () => {
  const topIndex = indexAtOffset(scrollTop.value, ROW_HEIGHT.value, total.value)
  const el = scroller.value
  if (el) {
    el.scrollTop = topIndex * ROW_HEIGHT.value
    scrollTop.value = el.scrollTop
  }
})

watch(() => props.activeLineId, (id) => {
  if (!id) return
  const index = props.lines.findIndex(l => l.id === id)
  if (index >= 0) scrollToIndex(index)
})

// ---------------------------------------------------------------------------
// 展示派生
// ---------------------------------------------------------------------------

function speakerColor(line: CanvasLine): string {
  if (line.speakerType === 'narration' || !line.characterId) return 'transparent'
  return characters.colorOf(line.characterId)
}

function speakerName(line: CanvasLine): string {
  if (line.kind === 'sfx_note') return '音效'
  if (line.speakerType === 'narration' || !line.characterId) return '旁白'
  return characters.nameOf(line.characterId)
}

/** 台词文本在剧本视图里加「」括号，音效行用【】——一眼区分「要念」与「只是提示」 */
function displayText(line: CanvasLine): string {
  if (line.kind === 'dialogue') return `「${line.text}」`
  if (line.kind === 'sfx_note') return `【${line.text}】`
  return line.text
}

function select(line: CanvasLine): void {
  canvas.selectByLineIds([line.id], 'single')
  canvas.setActiveLine(line.id)
}

async function setEmotion(line: CanvasLine, patch: { emotion?: string | null; emotionIntensity?: number | null }): Promise<void> {
  if (props.readonly) return
  await canvas.commitFields(line.id, patch, '修改情绪')
  emit('changed', line.id)
}

function rowClass(line: CanvasLine): Record<string, boolean> {
  return {
    'is-selected': canvas.selectedIds.has(line.id),
    'is-active': line.id === props.activeLineId,
    'is-narration': line.kind === 'narration',
    'is-dialogue': line.kind === 'dialogue',
    'is-inner': line.kind === 'inner',
    'is-sfx': line.kind === 'sfx_note',
    'is-review': line.needsReview,
    'is-deleted': line.flags.includes('deleted'),
  }
}
</script>

<template>
  <div class="ns-script">
    <div class="ns-script__toolbar">
      <span class="ns-script__legend">
        <em class="is-narration">旁白</em>
        <em class="is-dialogue">台词</em>
        <em class="is-inner">内心</em>
        <em class="is-sfx">音效</em>
      </span>
      <span class="ns-script__count">共 {{ formatInt(total) }} 行 · 单击选中，双击打开单行编辑</span>
    </div>

    <div ref="scroller" class="ns-script__scroller" @scroll="onScroll">
      <div class="ns-script__spacer" :style="{ paddingTop: `${range.paddingTop}px`, paddingBottom: `${range.paddingBottom}px` }">
        <article
          v-for="line in visibleLines"
          :key="line.id"
          class="ns-script__line"
          :class="rowClass(line)"
          :style="{ height: `${ROW_HEIGHT}px`, borderLeftColor: speakerColor(line) }"
          @click="select(line)"
          @dblclick="emit('open', line.id)"
        >
          <span class="ns-script__seq">{{ line.seq }}</span>

          <div class="ns-script__body">
            <div class="ns-script__meta">
              <span class="ns-script__speaker" :style="{ color: line.characterId ? speakerColor(line) : undefined }">
                {{ speakerName(line) }}
              </span>
              <span class="ns-script__kind">{{ LINE_KIND_LABELS[line.kind] ?? line.kind }}</span>

              <span v-if="line.emotion" class="ns-script__chip">{{ line.emotion }}<em v-if="line.emotionIntensity"> ×{{ line.emotionIntensity }}</em></span>
              <span v-if="line.pauseAfterMs" class="ns-script__chip is-pause">停 {{ line.pauseAfterMs }}ms</span>
              <span v-if="line.pronunciation" class="ns-script__chip is-pron" :title="line.pronunciation">音</span>
              <span v-if="line.needsReview" class="ns-script__chip is-review">待确认</span>
              <span v-if="issueLineIds.has(line.id)" class="ns-script__chip is-issue">有问题</span>
              <span v-if="line.note" class="ns-script__chip is-note" :title="line.note">注</span>

              <span class="ns-script__grow" />

              <EmotionTagPicker
                :emotion="line.emotion"
                :intensity="line.emotionIntensity"
                :readonly="readonly"
                :compact="true"
                @click.stop
                @change="(patch) => setEmotion(line, patch)"
              />
              <button type="button" class="ns-script__edit" @click.stop="emit('open', line.id)">编辑</button>
            </div>

            <p class="ns-script__text">{{ displayText(line) }}</p>
          </div>
        </article>
      </div>

      <p v-if="!total" class="ns-script__empty">当前筛选下没有行。</p>
    </div>
  </div>
</template>

<style scoped>
.ns-script {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.ns-script__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  background: var(--ns-bg-subtle, #fafafa);
  font-size: 12px;
}
.ns-script__legend {
  display: inline-flex;
  gap: 10px;
}
.ns-script__legend em {
  font-style: normal;
}
.ns-script__legend .is-narration {
  color: var(--ns-text-secondary, #909399);
}
.ns-script__legend .is-dialogue {
  color: var(--ns-primary, #409eff);
}
.ns-script__legend .is-inner {
  border-bottom: 1px dashed currentcolor;
  color: #9b59b6;
}
.ns-script__legend .is-sfx {
  color: var(--ns-warning, #e6a23c);
}
.ns-script__count {
  margin-left: auto;
  color: var(--ns-text-secondary, #909399);
}
.ns-script__scroller {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--ns-bg-elevated, #fff);
  contain: layout paint;
}
.ns-script__line {
  display: flex;
  gap: 8px;
  padding: 6px 10px 6px 8px;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  box-sizing: border-box;
  cursor: pointer;
}
.ns-script__line:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-script__line.is-selected {
  background: rgb(64 158 255 / 10%);
}
.ns-script__line.is-active {
  box-shadow: inset 0 0 0 1px var(--ns-primary, #409eff);
}
.ns-script__line.is-deleted {
  opacity: 0.5;
}
.ns-script__seq {
  flex: 0 0 34px;
  color: var(--ns-text-placeholder, #c0c4cc);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.ns-script__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ns-script__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}
.ns-script__speaker {
  font-weight: 600;
  white-space: nowrap;
}
.ns-script__line.is-narration .ns-script__speaker {
  color: var(--ns-text-secondary, #909399);
}
.ns-script__kind {
  color: var(--ns-text-placeholder, #c0c4cc);
}
.ns-script__chip {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  white-space: nowrap;
}
.ns-script__chip em {
  font-style: normal;
}
.ns-script__chip.is-pause {
  background: rgb(144 147 153 / 12%);
}
.ns-script__chip.is-pron {
  background: rgb(103 194 58 / 15%);
  color: var(--ns-success, #67c23a);
}
.ns-script__chip.is-review {
  background: rgb(230 162 60 / 18%);
  color: var(--ns-warning, #e6a23c);
}
.ns-script__chip.is-issue {
  background: rgb(245 108 108 / 15%);
  color: var(--ns-danger, #f56c6c);
}
.ns-script__chip.is-note {
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}
.ns-script__grow {
  flex: 1;
}
.ns-script__edit {
  padding: 1px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-regular, #606266);
  font-size: 11px;
  cursor: pointer;
}
.ns-script__text {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.ns-script__line.is-narration .ns-script__text {
  color: var(--ns-text-regular, #606266);
}
.ns-script__line.is-inner .ns-script__text {
  border-bottom: 1px dashed currentcolor;
  color: #9b59b6;
  text-decoration: underline dashed rgb(155 89 182 / 45%);
  text-underline-offset: 3px;
}
.ns-script__line.is-sfx .ns-script__text {
  color: var(--ns-warning, #e6a23c);
  font-size: 13px;
}
.ns-script__line.is-review .ns-script__text {
  font-weight: 600;
}
.ns-script__empty {
  margin: 24px 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
  text-align: center;
}
</style>
