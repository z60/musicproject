<!--
  Novel Studio · 时间线主画布（docs/13 §9 渲染架构 / §4.6 视图能力 / §4.5 布局）
  ============================================================================
  ★ 渲染架构（docs/13 §9 的硬性要求，改这个文件前先读）：
    时间线**绝不用 DOM 元素渲染片段** —— 1000 个 DOM 节点 + 拖动会卡。
    本组件因此是「一个 canvas + 一层交互状态机」：
      · 片段是**绘制指令**（`ClipBlock` 是逻辑单元，不是 Vue 组件）；
      · 命中检测在 `useTimelineInteraction` 里做（按行分组 + 轨内二分）；
      · 拖动时只请求**脏矩形**重绘（`renderer.requestDraw(dirty)`），
        帧内只重画「上一帧位置 ∪ 这一帧位置」；
      · 绘制循环内不建立任何 Vue 响应式依赖：所有数据通过 getter 传入，
        画一帧不触发 watcher（否则拖动时 Vue 的调度会和绘制抢时间）。
    性能指标（docs/13 §4.6）：**1000 个 item 下拖动 ≥ 30 fps**。

  本组件的三块职责与边界：
    1. 数据 → 绘制：把 props（视口 / 按轨分组的 items / 选中 / 播放头 / 循环）
       交给 `useTimelineRenderer`（网格、角色配色、波形包络、行号与文本前 10 字、
       锁定图标、重叠斜纹、淡入淡出、播放头、选择框全部由它画）；
    2. 交互 → 状态：把 pointer/wheel/key 事件交给 `useTimelineInteraction`
       （命中检测、拖动/缩放/框选/播放头拖动、吸附、`Alt` 关吸附、滚轮缩放平移）；
    3. 结果 → 视图：交互产生的选择/拖动/播放头/缩放通过 emits **通知**视图，
       用于状态条文案、面板切换与埋点。**真正的状态写入仍在 store 里**，
       所以这里不做「emit 回去再改一遍」的双写。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ArrangementItem, Id, TrackId } from '@shared/types.ts'
import type { Rect } from '@/shared/lib/waveform-transform.ts'
import { buildLayout } from '../composables/useTimelineRenderer.ts'
import type { TimelineLayout } from '../composables/useTimelineRenderer.ts'
import { useTimelineRenderer } from '../composables/useTimelineRenderer.ts'
import { useTimelineInteraction } from '../composables/useTimelineInteraction.ts'
import { useArrangementStore } from '../stores/arrangement.store.ts'
import type { TrackView } from '../stores/arrangement.store.ts'
import { usePlaybackStore } from '../stores/playback.store.ts'
import { useTimelineStore } from '../stores/timeline.store.ts'

const props = withDefaults(defineProps<{
  /** 视口：每毫秒像素（与刻度尺、MiniMap 同源） */
  pxPerMs: number
  /** 视口：左边缘时间（毫秒） */
  scrollMs: number
  /** 轨道行高（像素；由 timeline store 的预设决定） */
  trackHeight: number
  /** 轨道区纵向滚动偏移（像素） */
  scrollTopPx?: number
  /** 轨道顺序（旁白第一轨）与配色 */
  tracks: TrackView[]
  /** 按轨分组的 items（store 的 itemsByTrack，浅引用即可） */
  itemsByTrack: ReadonlyMap<TrackId, ArrangementItem[]>
  /** 选中项 */
  selectedIds: readonly Id[]
  primarySelectedId?: Id | null
  /** 单片段试听中（画布上加高亮） */
  auditionItemId?: Id | null
  /** 同轨重叠冲突项（红色斜纹） */
  conflictIds?: ReadonlySet<Id>
  /** 播放头 */
  playheadMs: number
  /** 循环区间 */
  loop?: { startMs: number; endMs: number } | null
  /** 吸附开关（`Alt` 可临时关闭，见交互层） */
  snapEnabled?: boolean
  /** 网格粒度（毫秒） */
  gridMs?: number
  /** 是否画网格（缩放到样本级时网格会很密，可关） */
  showGrid?: boolean
}>(), {
  scrollTopPx: 0,
  primarySelectedId: null,
  auditionItemId: null,
  conflictIds: () => new Set<Id>(),
  loop: null,
  snapEnabled: true,
  gridMs: 100,
  showGrid: true,
})

const emit = defineEmits<{
  /** 选择变化（视图用于同步面板/状态条） */
  'update:selection': [ids: Id[]]
  /** 循环区间变化 */
  'update:loop': [range: { startMs: number; endMs: number } | null]
  /** 一次拖动提交（拖动片段 / 拖边缘），带撤销标签与新快照 */
  'item-move': [payload: { label: string; items: ArrangementItem[] }]
  /** 播放头移动 */
  'playhead-move': [ms: number]
  /** 请求缩放（视图可据此更新缩放提示；缩放本身已由交互层执行） */
  'request-zoom': [payload: { factor: number; anchorX: number }]
  /** 请求播放/暂停（`Space`）——播放器在视图里，组件不碰 AudioContext */
  'request-play-toggle': []
  /** 键盘微调（`←/→` 步进，视图转发给 arrangement.nudgeSelected） */
  nudge: [deltaMs: number]
  /** 交互提示（状态条） */
  status: [text: string]
  /** 悬停命中（状态条显示「悬停：萧炎 @ 3:12.4」） */
  hover: [payload: { itemId: Id | null; timeMs: number } | null]
  /** 布局信息（视图 clamp 纵向滚动用） */
  'layout-change': [payload: { contentHeight: number; viewportHeightPx: number }]
}>()

const arrangement = useArrangementStore()
const timeline = useTimelineStore()
const playback = usePlaybackStore()

const host = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

/** CSS 尺寸（ResizeObserver 维护；渲染器按 DPR 放大物理像素） */
let cssWidth = 0
let cssHeight = 0
let observer: ResizeObserver | null = null

/** 布局：轨道行（画布与命中检测共用同一份，避免两处各算一套 y） */
const layoutRef = computed<TimelineLayout>(() => buildLayout(
  props.tracks,
  props.trackHeight,
  props.scrollTopPx,
))

const viewport = () => ({ pxPerMs: props.pxPerMs, scrollMs: props.scrollMs })

// ---------------------------------------------------------------------------
// 渲染器 / 交互层的装配
//
// 两者互相依赖：渲染器要读交互层的框选矩形（marquee），交互层要调渲染器请求重绘。
// 用「getter 间接引用」解掉这个环（绘制发生在两者都装配完之后，取到的一定是最终实例）。
// ---------------------------------------------------------------------------

let marqueeGetter: () => Rect | null = () => null

const renderer = useTimelineRenderer({
  layout: () => layoutRef.value,
  itemsByTrack: () => props.itemsByTrack,
  viewport,
  selection: () => ({
    selectedIds: props.selectedIds,
    primaryId: props.primarySelectedId ?? null,
    auditionId: props.auditionItemId ?? null,
  }),
  conflictIds: () => props.conflictIds,
  // 行号 + 文本前 10 字（docs/13 §4.6）：文本一律走 store 的 lineLabel，组件不自己截字符串
  labelOf: item => ({ seq: arrangement.lineSeq(item), text: arrangement.lineLabel(item, 10) }),
  // 片段音频来源（拿不到就不画波形，绝不猜路径）
  resolveSource: item => arrangement.resolveSource(item, playback.useProcessed),
  playhead: () => props.playheadMs,
  loop: () => props.loop,
  marquee: () => marqueeGetter(),
  showGrid: () => props.showGrid,
})

const interaction = useTimelineInteraction({
  layout: () => layoutRef.value,
  viewport,
  itemsByTrack: () => props.itemsByTrack,
  itemById: id => arrangement.itemById(id),
  ensureSortedIndex: () => arrangement.ensureSortedIndex(),
  renderer,
  size: () => ({ width: cssWidth, height: cssHeight }),

  /** 拖动中每帧：**只写内存**，不落库、不进撤销栈（docs/13 §4.8） */
  patchLocal: (itemId, patch) => {
    arrangement.patchLocalInPlace(itemId, patch)
  },

  /** 松手提交：一条撤销命令 + 一次批量落库 */
  commit: (label, before) => {
    arrangement.commitChanges(label, before)
    const items = before
      .map(item => arrangement.itemById(item.id))
      .filter((item): item is ArrangementItem => Boolean(item))
      .map(item => ({ ...item }))
    emit('item-move', { label, items })
  },

  select: (id, mode) => {
    timeline.select(id, mode)
    emit('update:selection', [...timeline.selectedIds])
  },
  selectMany: (ids, additive) => {
    timeline.selectMany(ids, additive)
    emit('update:selection', [...timeline.selectedIds])
  },
  clearSelection: () => {
    timeline.clearSelection()
    emit('update:selection', [])
  },

  setPlayhead: (ms) => {
    timeline.setPlayhead(ms)
    playback.setCurrentMs(ms)
    emit('playhead-move', timeline.playheadMs)
  },
  playhead: () => props.playheadMs,

  setLoop: (startMs, endMs) => {
    timeline.setLoop(startMs, endMs)
    emit('update:loop', { startMs, endMs })
  },
  clearLoop: () => {
    timeline.clearLoop()
    emit('update:loop', null)
  },
  loop: () => props.loop,

  snapEnabled: () => props.snapEnabled,
  gridMs: () => props.gridMs,
  sourceDurationMs: item => arrangement.resolveSource(item, playback.useProcessed)?.durationMs ?? null,

  togglePlay: () => emit('request-play-toggle'),
  nudge: deltaMs => emit('nudge', deltaMs),
  undo: () => { void arrangement.undo() },
  redo: () => { void arrangement.redo() },

  zoomAtX: (factor, xPx) => {
    timeline.zoomAroundX(factor, xPx)
    emit('request-zoom', { factor, anchorX: xPx })
  },
  panByPx: deltaPx => timeline.panByPx(deltaPx),
  setScrollMs: ms => timeline.setScrollMs(ms),
  scrollTracksBy: (deltaPx, contentHeight) => timeline.scrollTracksBy(deltaPx, contentHeight),
  fitChapter: () => timeline.fitChapter(arrangement.totalDurationMs, cssWidth),
})

// 渲染器读框选矩形（装配完成后才可能被调用）
marqueeGetter = () => interaction.marquee.value

// ---------------------------------------------------------------------------
// 尺寸与 DPR
// ---------------------------------------------------------------------------

function measure(): void {
  const el = host.value
  if (!el) return
  const nextW = Math.max(1, Math.round(el.clientWidth))
  const nextH = Math.max(1, Math.round(el.clientHeight))
  const changed = nextW !== cssWidth || nextH !== cssHeight
  cssWidth = nextW
  cssHeight = nextH
  if (!changed) return

  const dpr = globalThis.devicePixelRatio && globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
  renderer.resize(cssWidth, cssHeight, dpr)
  timeline.setViewportSize(cssWidth, cssHeight)
  // 静态层（背景/轨道底/网格）尺寸变了必须失效
  renderer.invalidateStatic()
  renderer.drawNow(null)
  emit('layout-change', { contentHeight: layoutRef.value.contentHeight, viewportHeightPx: cssHeight })
}

onMounted(() => {
  renderer.attach(canvasEl.value)
  measure()
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(host.value)
  }
  globalThis.addEventListener?.('resize', measure)
  // 焦点：键盘（Space/方向键/Ctrl+Z/F）需要容器可聚焦
  host.value?.focus?.()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  globalThis.removeEventListener?.('resize', measure)
  // 卸载时中断未完成的拖动（还原到按下前，不产生撤销记录）
  interaction.cancel()
  renderer.dispose()
})

// ---------------------------------------------------------------------------
// 重绘触发
// ---------------------------------------------------------------------------

/** 视口/轨道变化 → 静态层失效 + 全量重绘（这类变化一定会动到背景与网格） */
watch(
  () => [props.pxPerMs, props.scrollMs, props.trackHeight, props.scrollTopPx, props.tracks.length],
  () => {
    renderer.invalidateStatic()
    renderer.requestDraw(null)
    emit('layout-change', { contentHeight: layoutRef.value.contentHeight, viewportHeightPx: cssHeight })
  },
)

/** 叠加层变化（选中/播放头/循环/冲突/试听）→ 只需重绘一帧 */
watch(
  () => [
    props.playheadMs,
    props.primarySelectedId,
    props.auditionItemId,
    props.selectedIds.join('|'),
    props.loop?.startMs ?? null,
    props.loop?.endMs ?? null,
    props.gridMs,
    props.showGrid,
    props.conflictIds,
    props.itemsByTrack,
  ],
  () => renderer.requestDraw(null),
)

/**
 * 本地补丁（拖动、检查器改数值）只 bump `dragRevision`，`itemsByTrack` 身份不变。
 * 拖动期间由交互层逐帧请求脏矩形，这里**主动跳过** —— 若每帧都全量重绘，
 * docs/13 §4.6 的「1000 item 拖动 ≥ 30 fps」就保不住。
 */
watch(
  () => arrangement.dragRevision,
  () => {
    if (interaction.state.value === 'idle') renderer.requestDraw(null)
  },
)

/** 交互提示 / 悬停 → 状态条 */
watch(() => interaction.statusText.value, text => emit('status', text))
watch(
  () => interaction.hover.value,
  (hit) => {
    if (!hit || !hit.itemId) {
      emit('hover', null)
      return
    }
    emit('hover', { itemId: hit.itemId, timeMs: hit.timeMs })
  },
)

/** 键盘：全部交给交互层；返回 false（未消费）的键继续冒泡给视图（如 Ctrl+S） */
function onKeydown(event: KeyboardEvent): void {
  interaction.onKeydown(event)
}

/** 拖播放头期间阻止文本选中（否则整页会被拖蓝） */
const cursor = computed(() => interaction.cursor.value)
</script>

<template>
  <div
    ref="host"
    class="ns-tl-canvas"
    tabindex="0"
    :style="{ cursor }"
    @keydown="onKeydown"
  >
    <canvas
      ref="canvasEl"
      class="ns-tl-canvas__surface"
      @pointerdown="interaction.onPointerDown($event)"
      @pointermove="interaction.onPointerMove($event)"
      @pointerup="interaction.onPointerUp($event)"
      @pointercancel="interaction.onPointerUp($event)"
      @pointerleave="interaction.onPointerLeave()"
      @dblclick="interaction.onDoubleClick($event)"
      @wheel="interaction.onWheel($event)"
      @contextmenu.prevent
    />
    <!-- 坐标提示：左下角显示当前视口与 LOD（诊断用，docs/13 §4.6 的 LOD 可见性） -->
    <div class="ns-tl-canvas__badge">
      LOD {{ renderer.lod() }} peaks/s · 帧 {{ Math.round(renderer.lastStats.value.frameMs * 10) / 10 }} ms
    </div>
  </div>
</template>

<style scoped>
.ns-tl-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 120px;
  overflow: hidden;
  outline: none;
  background: var(--ns-bg, #fff);
  /* 拖动时不要选中文本（Canvas 上的拖动是编辑操作，不是选择文字） */
  user-select: none;
  touch-action: none;
}
.ns-tl-canvas__surface {
  display: block;
  width: 100%;
  height: 100%;
}
.ns-tl-canvas__badge {
  position: absolute;
  left: 6px;
  bottom: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ns-bg, #fff) 78%, transparent);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}
</style>
