<!--
  画本编辑 · 表格视图（虚拟滚动）
  ============================================================================
  设计依据：docs/11 §4.2
    | 序 | 状态 | 说话人 | 类型 | 文本 | 情绪 | 语速 | 停顿 | 提示 |
    性能要求：**5000 行下滚动 ≥ 30 fps**（虚拟滚动 + 行内文本纯文本渲染，聚焦时才挂载编辑器）
    置信度色带：≥0.85 绿、0.62~0.85 黄、<0.62 红、人工确认 蓝

  三条性能纪律（改代码时不要破坏）：
    1. 绝不用 el-table 承载全部行 —— 5000 行 × 9 列 = 4.5 万个单元格，DOM 就够卡死；
       这里用 @/shared/lib/virtual-list.ts 手写虚拟滚动，只渲染视口内的行（含 overscan）。
    2. 行内文本默认**纯文本**渲染（div + CSS 截断），只有双击进入编辑的那一行才挂 el-input。
    3. 滚动事件用 requestAnimationFrame 合帧，避免每个 scroll 事件都触发一次 setState。

  编辑策略：文本走 useEditableField（500 ms 防抖，docs/11 §4.9）；
  标记类（说话人/情绪/语速/停顿/发音）立即写库（useImmediateField 的语义，写入口在 canvas.store）。
-->

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CanvasLine, Id, SpeedMark } from '@shared/types.ts'
import { CONFIDENCE_BANDS, LINE_KIND_LABELS, LINE_STATE_LABELS, SPEED_OPTIONS } from '@shared/constants.ts'
import { computeScrollToIndex, computeVisibleRange, indexAtOffset } from '@/shared/lib/virtual-list.ts'
import { useEditableField } from '@/shared/lib/use-editable-field.ts'
import { formatInt } from '@/shared/lib/format.ts'
import SpeakerCell from './SpeakerCell.vue'
import EmotionTagPicker from './EmotionTagPicker.vue'
import PauseControl from './PauseControl.vue'
import PronunciationEditor from './PronunciationEditor.vue'
import { useCanvasStore, CANVAS_FLAG_ICONS, CANVAS_FLAG_LABELS } from '../stores/canvas.store.ts'

const props = withDefaults(defineProps<{
  /** 要渲染的行（已由 useCanvasFilter 筛选） */
  lines: CanvasLine[]
  /** 只读（任务包模式 docs/11 §6.3） */
  readonly?: boolean
  /** 行密度：紧凑 / 标准（docs/11 §4.2「列宽可调」的总开关） */
  density?: 'compact' | 'standard'
  /** 当前行（与抽屉、剧本视图共享） */
  activeLineId?: Id | null
  /** 有质检问题的行（给状态列的「有问题」图标用） */
  issueLineIds?: Set<Id>
  /** 初始滚动位置（视图切换时从 store 还原） */
  initialScrollTop?: number
  /** 初始滚动位置对应的行下标（不同视图行高不同，用行号更准） */
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
  /** 滚动位置变化（store 记住，切视图时还原） */
  scroll: [scrollTop: number, topIndex: number]
  /** 打开单行编辑抽屉 */
  open: [lineId: Id]
  /** 定位原文 */
  locate: [lineId: Id]
  /** 切换密集度 */
  'toggle-density': []
  /** 行数统计变化（状态栏用） */
  'count-change': [count: number]
  /** 某行被改动（父组件刷新队列 / 质检） */
  changed: [lineId: Id]
}>()

const canvas = useCanvasStore()

/** 行高：紧凑 30 / 标准 40（与 CSS 的 --ns-row-h 保持一致） */
const ROW_HEIGHT = computed(() => (props.density === 'compact' ? 30 : 40))
const OVERSCAN = 6

const scroller = ref<HTMLElement | null>(null)
/** 行内编辑框：用函数 ref（v-for 里的字符串 ref 会变成数组，拿不到 focus()） */
const editorRef = ref<{ focus: () => void } | null>(null)
const setEditorRef = (el: unknown): void => {
  editorRef.value = (el as { focus: () => void } | null) ?? null
}

const scrollTop = ref(props.initialScrollTop)
const viewportHeight = ref(600)
/** 表格整体宽度（列宽计算用，目前只用于给文本列留最小值） */
const viewportWidth = ref(1200)
/** 说话人列宽度（可拖拽调整，docs/11 §4.2「列宽可调」） */
const speakerWidth = ref(150)
let resizing = false
let resizeStartX = 0
let resizeStartWidth = 150
let frame = 0

const total = computed(() => props.lines.length)

/** 可见区间（纯函数来自 shared/lib/virtual-list.ts，边界情况已被单测覆盖） */
const range = computed(() => computeVisibleRange({
  scrollTop: scrollTop.value,
  viewportHeight: viewportHeight.value,
  rowHeight: ROW_HEIGHT.value,
  total: total.value,
  overscan: OVERSCAN,
}))

/** 只渲染视口内的行（+overscan） */
const visibleLines = computed(() => {
  if (range.value.endIndex < range.value.startIndex) return []
  return props.lines.slice(range.value.startIndex, range.value.endIndex + 1)
})

const gridStyle = computed(() => ({
  gridTemplateColumns: `52px 40px ${speakerWidth.value}px 62px minmax(160px, 1fr) 104px 70px 92px 92px`,
}))

const spacerStyle = computed(() => ({
  paddingTop: `${range.value.paddingTop}px`,
  paddingBottom: `${range.value.paddingBottom}px`,
}))

const allSelected = computed(() =>
  total.value > 0 && props.lines.every(l => canvas.selectedIds.has(l.id)))
const someSelected = computed(() => !allSelected.value && props.lines.some(l => canvas.selectedIds.has(l.id)))

// ---------------------------------------------------------------------------
// 尺寸与滚动
// ---------------------------------------------------------------------------

let resizeObserver: ResizeObserver | null = null

function measure(): void {
  const el = scroller.value
  if (!el) return
  const nextHeight = el.clientHeight
  // 视口高度为 0（还没布局 / 面板折叠）时保留旧值，避免退化成「只渲染 1 行」
  if (nextHeight > 0) viewportHeight.value = nextHeight
  if (el.clientWidth > 0) viewportWidth.value = el.clientWidth
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  // rAF 合帧：5000 行下每个 scroll 事件都 setState 是掉帧的主要原因
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const top = el.scrollTop
    scrollTop.value = top
    const topIndex = indexAtOffset(top, ROW_HEIGHT.value, total.value)
    emit('scroll', top, topIndex)
  })
}

/** 把某一行滚进视口（键盘上下移动、质检跳转都走它） */
function scrollToIndex(index: number, align: 'nearest' | 'center' | 'start' = 'nearest'): void {
  const el = scroller.value
  if (!el || index < 0) return
  const next = computeScrollToIndex(index, {
    currentScrollTop: el.scrollTop,
    rowHeight: ROW_HEIGHT.value,
    total: total.value,
    viewportHeight: viewportHeight.value,
    align,
  })
  el.scrollTop = next
  scrollTop.value = next
}

/** 还原视图位置：优先按行号（跨视图行高不同，用行号才准） */
function restorePosition(): void {
  const el = scroller.value
  if (!el) return
  if (props.initialTopIndex > 0) {
    el.scrollTop = props.initialTopIndex * ROW_HEIGHT.value
  } else if (props.initialScrollTop > 0) {
    el.scrollTop = props.initialScrollTop
  }
  scrollTop.value = el.scrollTop
}

onMounted(() => {
  measure()
  restorePosition()
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(scroller.value)
  }
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', onResizeEnd)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
  if (frame) cancelAnimationFrame(frame)
  frame = 0
})

// 行数变化（筛选、加载、批量合并）后把滚动位置收敛到合法范围，否则会滚到空白区
watch(total, (next) => {
  const el = scroller.value
  if (!el) return
  const max = Math.max(0, next * ROW_HEIGHT.value - viewportHeight.value)
  if (el.scrollTop > max) {
    el.scrollTop = max
    scrollTop.value = max
  }
  emit('count-change', next)
}, { immediate: true })

// 密度切换后行高变了，保持「当前屏第一行」不变
watch(() => props.density, () => {
  const topIndex = indexAtOffset(scrollTop.value, ROW_HEIGHT.value, total.value)
  void nextTick(() => {
    const el = scroller.value
    if (!el) return
    el.scrollTop = topIndex * ROW_HEIGHT.value
    scrollTop.value = el.scrollTop
  })
})

// 键盘/质检/抽屉移动当前行时，把它滚进视口
watch(() => props.activeLineId, (id) => {
  if (!id) return
  const index = props.lines.findIndex(l => l.id === id)
  if (index >= 0) scrollToIndex(index)
})

// ---------------------------------------------------------------------------
// 列宽拖拽（说话人列）
// ---------------------------------------------------------------------------

function onResizeStart(event: MouseEvent): void {
  resizing = true
  resizeStartX = event.clientX
  resizeStartWidth = speakerWidth.value
  event.preventDefault()
}

function onResizeMove(event: MouseEvent): void {
  if (!resizing) return
  const delta = event.clientX - resizeStartX
  speakerWidth.value = Math.min(360, Math.max(96, resizeStartWidth + delta))
}

function onResizeEnd(): void {
  resizing = false
}

// ---------------------------------------------------------------------------
// 选择
// ---------------------------------------------------------------------------

const lastClickIndex = ref(0)

function onRowClick(line: CanvasLine, index: number, event: MouseEvent): void {
  if (event.shiftKey) {
    const [from, to] = lastClickIndex.value <= index ? [lastClickIndex.value, index] : [index, lastClickIndex.value]
    const ids = props.lines.slice(from, to + 1).map(l => l.id)
    canvas.selectByLineIds(ids, 'range')
    canvas.setActiveLine(line.id)
    return
  }
  if (event.ctrlKey || event.metaKey) {
    canvas.selectByLineIds([line.id], 'toggle')
    canvas.setActiveLine(line.id)
    lastClickIndex.value = index
    return
  }
  canvas.selectByLineIds([line.id], 'single')
  canvas.setActiveLine(line.id)
  lastClickIndex.value = index
}

function toggleSelectAll(): void {
  if (allSelected.value) canvas.clearSelection()
  else canvas.selectByLineIds(props.lines.map(l => l.id), 'single')
}

// ---------------------------------------------------------------------------
// 文本编辑（聚焦时才挂载 el-input）
// ---------------------------------------------------------------------------

const editingId = ref<Id | null>(null)
/** 编辑对象快照：写库时必须用「进入编辑时那一行」，避免切行后写错行 */
const editingTarget = ref<{ id: Id; text: string } | null>(null)

const textField = useEditableField<string>('', {
  write: async (value: string) => {
    const target = editingTarget.value
    if (!target) return value
    return await canvas.commitText(target.id, value)
  },
  delayMs: 500, // docs/11 §4.9：文本编辑防抖 500 ms
  failureDetail: '保存失败，你的修改仍在内存中（尚未写入数据库）。可点「重试」重新保存。',
})

function startEdit(line: CanvasLine): void {
  if (props.readonly) return
  editingId.value = line.id
  editingTarget.value = { id: line.id, text: line.text }
  textField.reset(line.text)
  void nextTick(() => editorRef.value?.focus())
}

async function endEdit(): Promise<void> {
  if (!editingId.value) return
  await textField.flush()
  const id = editingId.value
  editingId.value = null
  editingTarget.value = null
  emit('changed', id)
}

function cancelEdit(): void {
  textField.revert()
  editingId.value = null
  editingTarget.value = null
}

// Ctrl+S 强制落库（docs/11 §4.8）：store 自增 flushSignal，这里把防抖中的文本也冲掉
watch(() => canvas.flushSignal, () => {
  if (editingId.value) void textField.flush()
})

// ---------------------------------------------------------------------------
// 标记类编辑（立即写库）
// ---------------------------------------------------------------------------

async function setEmotion(line: CanvasLine, patch: { emotion?: string | null; emotionIntensity?: number | null }): Promise<void> {
  if (props.readonly) return
  await canvas.commitFields(line.id, patch, '修改情绪')
  emit('changed', line.id)
}

async function setSpeed(line: CanvasLine, speed: SpeedMark | null): Promise<void> {
  if (props.readonly) return
  await canvas.commitFields(line.id, { speed }, '修改语速')
  emit('changed', line.id)
}

async function setPause(line: CanvasLine, pauseAfterMs: number): Promise<void> {
  if (props.readonly) return
  await canvas.commitFields(line.id, { pauseAfterMs }, '修改停顿')
  emit('changed', line.id)
}

async function setPronunciation(line: CanvasLine, pronunciation: string | null): Promise<void> {
  if (props.readonly) return
  await canvas.commitFields(line.id, { pronunciation }, '修改发音提示')
  emit('changed', line.id)
}

// ---------------------------------------------------------------------------
// 展示派生（纯函数，避免在模板里写逻辑）
// ---------------------------------------------------------------------------

/** 左侧色条 / 状态图标用的置信度颜色：人工确认一律蓝（docs/11 §4.2） */
function stripColor(line: CanvasLine): string {
  if (line.decidedBy === 'human') return '#3d7eff'
  const value = line.confidence
  if (value === null || value === undefined) return 'transparent'
  const band = CONFIDENCE_BANDS.find(item => value >= item.min)
  return band?.color ?? 'transparent'
}

function stateIcon(line: CanvasLine): string {
  if (line.flags.includes('deleted')) return '🗑'
  if (line.needsReview) return '待'
  if (props.issueLineIds.has(line.id)) return '⚠'
  if (line.state === 'recorded' || line.state === 'aligned') return '✓'
  if (line.state === 'assigned') return '●'
  return '○'
}

function stateTitle(line: CanvasLine): string {
  const parts: string[] = [LINE_STATE_LABELS[line.state] ?? line.state]
  if (line.needsReview) parts.push('待人工确认')
  if (props.issueLineIds.has(line.id)) parts.push('有质检问题')
  if (line.flags.includes('deleted')) parts.push('已软删除')
  return parts.join(' · ')
}

function kindLabel(line: CanvasLine): string {
  return LINE_KIND_LABELS[line.kind] ?? line.kind
}

function speedLabel(line: CanvasLine): string {
  const option = SPEED_OPTIONS.find(item => item.value === line.speed)
  return option?.label ?? '正常'
}

function flagTitle(line: CanvasLine): string {
  return line.flags.map(flag => CANVAS_FLAG_LABELS[flag] ?? flag).join('、')
}

function visibleFlags(line: CanvasLine): string[] {
  return line.flags.filter(flag => flag !== 'deleted').slice(0, 4)
}

function flagIcon(flag: string): string {
  return CANVAS_FLAG_ICONS[flag] ?? '标'
}
</script>

<template>
  <div class="ns-table">
    <!-- 表格工具行：密度开关 + 列宽提示 + 行数（列宽可拖） -->
    <div class="ns-table__toolbar">
      <el-button size="small" text @click="emit('toggle-density')">
        行密度：{{ density === 'compact' ? '紧凑' : '标准' }}
      </el-button>
      <span class="ns-table__toolbar-hint">拖动「说话人」列右边界可调列宽</span>
      <span class="ns-table__toolbar-count">
        共 {{ formatInt(total) }} 行<template v-if="canvas.selectedCount"> · 已选 {{ formatInt(canvas.selectedCount) }}</template>
      </span>
    </div>

    <!-- 表头（与行用同一套 grid 模板，保证列对齐） -->
    <div class="ns-table__head" :style="gridStyle">
      <span class="ns-table__th ns-table__th--check">
        <el-checkbox
          :model-value="allSelected"
          :indeterminate="someSelected"
          :disabled="readonly"
          @update:model-value="toggleSelectAll"
        />
      </span>
      <span class="ns-table__th">状态</span>
      <span class="ns-table__th ns-table__th--resizable">
        说话人
        <i class="ns-table__resizer" title="拖动调整列宽" @mousedown="onResizeStart" />
      </span>
      <span class="ns-table__th">类型</span>
      <span class="ns-table__th">文本（双击编辑）</span>
      <span class="ns-table__th">情绪</span>
      <span class="ns-table__th">语速</span>
      <span class="ns-table__th">停顿</span>
      <span class="ns-table__th">提示</span>
    </div>

    <!-- 滚动容器：只渲染视口内的行 -->
    <div ref="scroller" class="ns-table__scroller" @scroll="onScroll">
      <div class="ns-table__spacer" :style="spacerStyle">
        <div
          v-for="(line, index) in visibleLines"
          :key="line.id"
          class="ns-table__row"
          :class="{
            'is-selected': canvas.selectedIds.has(line.id),
            'is-active': line.id === props.activeLineId,
            'is-review': line.needsReview,
            'is-deleted': line.flags.includes('deleted'),
            'is-recorded': line.state === 'recorded' || line.state === 'aligned',
          }"
          :style="{ ...gridStyle, height: `${ROW_HEIGHT}px` }"
          @click="onRowClick(line, range.startIndex + index, $event)"
          @dblclick="startEdit(line)"
        >
          <i class="ns-table__strip" :style="{ background: stripColor(line) }" />

          <span class="ns-table__td ns-table__td--seq">{{ line.seq }}</span>

          <span class="ns-table__td ns-table__td--state" :title="stateTitle(line)">
            <em class="ns-table__state" :class="{ 'is-issue': issueLineIds.has(line.id), 'is-review': line.needsReview }">
              {{ stateIcon(line) }}
            </em>
          </span>

          <span class="ns-table__td ns-table__td--speaker">
            <SpeakerCell
              :line="line"
              :readonly="readonly"
              :compact="true"
              :threshold="canvas.threshold"
              @open="(id) => emit('open', id)"
              @locate="(id) => emit('locate', id)"
              @change="(id) => emit('changed', id)"
            />
          </span>

          <span class="ns-table__td ns-table__td--kind">{{ kindLabel(line) }}</span>

          <span class="ns-table__td ns-table__td--text" :title="editingId === line.id ? '' : line.text">
            <el-input
              v-if="editingId === line.id"
              :ref="setEditorRef"
              :model-value="textField.value.value"
              size="small"
              class="ns-table__editor"
              @update:model-value="textField.set"
              @keydown.enter.prevent="endEdit"
              @keydown.esc.prevent="cancelEdit"
              @blur="endEdit"
            />
            <template v-else>{{ line.text }}</template>
          </span>

          <span class="ns-table__td ns-table__td--emotion" @dblclick.stop>
            <EmotionTagPicker
              :emotion="line.emotion"
              :intensity="line.emotionIntensity"
              :readonly="readonly"
              :compact="true"
              @change="(patch) => setEmotion(line, patch)"
            />
          </span>

          <span class="ns-table__td ns-table__td--speed" @dblclick.stop>
            <el-popover trigger="click" placement="bottom" :width="150" :disabled="readonly">
              <template #reference>
                <span class="ns-table__speed">{{ speedLabel(line) }}</span>
              </template>
              <div class="ns-table__speed-menu">
                <button type="button" class="ns-table__speed-item" @click="setSpeed(line, null)">默认</button>
                <button
                  v-for="option in SPEED_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="ns-table__speed-item"
                  :class="{ 'is-active': line.speed === option.value }"
                  @click="setSpeed(line, option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </el-popover>
          </span>

          <span class="ns-table__td ns-table__td--pause" @dblclick.stop>
            <PauseControl
              :pause-after-ms="line.pauseAfterMs"
              :pause-inline="line.pauseInline"
              :text="line.text"
              :readonly="readonly"
              :compact="true"
              @change="(value) => setPause(line, value)"
            />
          </span>

          <span class="ns-table__td ns-table__td--hint" @dblclick.stop>
            <PronunciationEditor
              :text="line.text"
              :pronunciation="line.pronunciation"
              :readonly="readonly"
              :compact="true"
              @change="(value) => setPronunciation(line, value)"
              @open="emit('open', line.id)"
            />
            <el-tooltip v-if="line.note" :content="line.note" placement="top">
              <span class="ns-table__note">注</span>
            </el-tooltip>
            <el-tooltip v-if="line.flags.length" :content="flagTitle(line)" placement="top">
              <span class="ns-table__flags">
                <em v-for="flag in visibleFlags(line)" :key="flag">{{ flagIcon(flag) }}</em>
              </span>
            </el-tooltip>
          </span>
        </div>
      </div>

      <p v-if="!total" class="ns-table__empty">
        当前筛选下没有行。可以放宽筛选条件，或切换章节。
      </p>
    </div>
  </div>
</template>

<style scoped>
.ns-table {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.ns-table__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-table__toolbar-hint,
.ns-table__toolbar-count {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-table__toolbar-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.ns-table__head,
.ns-table__row {
  display: grid;
  align-items: center;
}
.ns-table__head {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 32px;
  border-bottom: 1px solid var(--ns-border, #dcdfe6);
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-table__th {
  position: relative;
  padding: 0 6px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.ns-table__th--check {
  display: flex;
  justify-content: center;
}
.ns-table__resizer {
  position: absolute;
  top: 4px;
  right: -4px;
  width: 8px;
  height: 24px;
  cursor: col-resize;
}
.ns-table__resizer:hover {
  background: rgb(64 158 255 / 20%);
}
.ns-table__scroller {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--ns-bg-elevated, #fff);
  /* 把渲染隔离在滚动容器内：5000 行滚动时避免整页重排（别用 strict，会让 flex 尺寸计算变形） */
  contain: layout paint;
}
.ns-table__spacer {
  will-change: padding-top;
}
.ns-table__row {
  position: relative;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  cursor: default;
}
.ns-table__row:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-table__row.is-selected {
  background: rgb(64 158 255 / 10%);
}
.ns-table__row.is-active {
  box-shadow: inset 0 0 0 1px var(--ns-primary, #409eff);
}
.ns-table__row.is-review .ns-table__td--text {
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-table__row.is-deleted {
  opacity: 0.55;
  text-decoration: line-through;
}
.ns-table__strip {
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
}
.ns-table__td {
  min-width: 0;
  padding: 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-table__td--seq {
  display: flex;
  justify-content: center;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ns-table__td--state {
  display: flex;
  justify-content: center;
}
.ns-table__state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  font-style: normal;
}
.ns-table__state.is-issue {
  background: rgb(245 108 108 / 15%);
  color: var(--ns-danger, #f56c6c);
}
.ns-table__state.is-review {
  background: rgb(230 162 60 / 18%);
  color: var(--ns-warning, #e6a23c);
  font-weight: 600;
}
.ns-table__td--kind {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-table__editor {
  width: 100%;
}
.ns-table__speed {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  font-size: 12px;
  cursor: pointer;
}
.ns-table__speed-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ns-table__speed-item {
  padding: 3px 8px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.ns-table__speed-item:hover,
.ns-table__speed-item.is-active {
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-primary, #409eff);
}
.ns-table__td--hint {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ns-table__note {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
  font-size: 11px;
  cursor: help;
}
.ns-table__flags {
  display: inline-flex;
  gap: 2px;
  color: var(--ns-warning, #e6a23c);
  font-size: 11px;
  cursor: help;
}
.ns-table__flags em {
  font-style: normal;
}
.ns-table__empty {
  margin: 24px 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
  text-align: center;
}
</style>
