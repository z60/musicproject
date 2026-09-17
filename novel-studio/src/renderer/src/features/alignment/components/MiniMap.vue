<!--
  Novel Studio · 时间线总览缩略图（docs/13 §4.5 / §4.6 / §11）
  ============================================================================
  设计依据：
    · docs/13 §11 —— 「章节极长（> 2000 个 item）时提供 MiniMap」：长章节里
      横向缩到整章后片段只有几像素宽，光靠主时间线找不到位置，必须有一个
      「整章 → 当前视口」的全局视图；
    · docs/13 §4.5 —— 与主时间线共用同一个 `durationMs` 与横向坐标口径，
      窗口矩形必须与主画布的可见范围严格一致（否则会出现「拖了没反应」）；
    · docs/13 §4.6 —— 播放头位置也画上：这里读的是 `playback.currentMs`
      （试听调度器按 `ctx.currentTime` 推进的那个位置），而不是时间线 store 的
      `playheadMs`，两者在播放时会有几十毫秒的差异，用户看到的是「正在播到哪」。

  与主画布的区别（刻意做成两套绘制）：
    · 主画布按 1:1 视口绘制（只画可见项、带波形）；
    · MiniMap 把**整章压进一条固定宽度**，每轨一条细泳道，只画块不画波形，
      因此不需要 LOD 与脏矩形（一次全量重绘 < 1 ms，2000 个 item 也是）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { itemDurationMs } from '@shared/arrange/layout.ts'
import type { ArrangementItem, Id, TrackId } from '@shared/types.ts'
import { clampTime, viewportDurationMs } from '@/shared/lib/waveform-transform.ts'
import { formatDuration } from '@/shared/lib/format.ts'
import type { TrackView } from '../stores/arrangement.store.ts'

const props = withDefaults(defineProps<{
  /** 轨道顺序与主时间线一致（旁白第一轨） */
  tracks: TrackView[]
  /** 按轨分组的 items（与主画布同一份索引） */
  itemsByTrack: ReadonlyMap<TrackId, ArrangementItem[]>
  /** 章节总时长（整章 = 整宽） */
  durationMs: number
  /** 主视口：每毫秒像素 */
  pxPerMs: number
  /** 主视口：左边缘时间 */
  scrollMs: number
  /** 主视口：可视宽度（像素），用来画窗口矩形 */
  viewportWidthPx: number
  /** 时间线播放头（未播放时用） */
  playheadMs: number
  /** 试听调度器的播放位置（播放中用；与 playheadMs 不一致时以它为准） */
  playingMs?: number | null
  /** 是否正在播放（决定画哪一个播放头） */
  playing?: boolean
  /** 循环区间 */
  loop?: { startMs: number; endMs: number } | null
  /** 选中项（缩略图上加白描边，便于确认「我选的是不是这一段」） */
  selectedIds?: readonly Id[]
  /** 重叠冲突项（红色标记，与主画布同色） */
  conflictIds?: ReadonlySet<Id>
  height?: number
}>(), {
  playingMs: null,
  playing: false,
  loop: null,
  selectedIds: () => [],
  conflictIds: () => new Set<Id>(),
  height: 58,
})

const emit = defineEmits<{
  /** 把视口左边缘移到该时间（视图调用 timeline.setScrollMs） */
  scroll: [scrollMs: number]
  /** 定位播放头（点击缩略图） */
  seek: [ms: number]
  /** 双击：适配整章（等价于键盘 F） */
  fit: []
}>()

const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

let cssWidth = 0
let dpr = 1
let observer: ResizeObserver | null = null
let dragging = false

const COLORS = {
  background: '#f5f7fa',
  lane: '#eef1f6',
  laneAlt: '#e9edf4',
  border: '#dcdfe6',
  itemSelected: '#409eff',
  itemConflict: '#f56c6c',
  window: 'rgba(64, 158, 255, 0.18)',
  windowEdge: '#409eff',
  playhead: '#f56c6c',
  playingHead: '#67c23a',
  loop: 'rgba(64, 158, 255, 0.28)',
} as const

/** 缩略图上的时间 → x（整章压满宽度） */
function timeToMiniX(ms: number): number {
  if (!(props.durationMs > 0)) return 0
  return (ms / props.durationMs) * cssWidth
}

/** x → 时间（点击/拖动导航用） */
function miniXToTime(x: number): number {
  if (!(cssWidth > 0)) return 0
  return clampTime((x / cssWidth) * props.durationMs, Math.max(0, props.durationMs))
}

const visibleDurationMs = computed(() => viewportDurationMs(props.viewportWidthPx, {
  pxPerMs: props.pxPerMs,
  scrollMs: props.scrollMs,
}))

const headMs = computed(() => (props.playing && props.playingMs !== null ? props.playingMs : props.playheadMs))

const rangeLabel = computed(() => {
  const from = formatDuration(props.scrollMs)
  const to = formatDuration(Math.min(props.scrollMs + visibleDurationMs.value, props.durationMs))
  return `视口 ${from} – ${to}`
})

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

function draw(): void {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')
  if (!ctx) return

  const width = Math.max(1, Math.round(cssWidth))
  const height = Math.max(20, Math.round(props.height))
  const ratio = Math.max(1, dpr)
  const physicalW = Math.round(width * ratio)
  const physicalH = Math.round(height * ratio)
  if (el.width !== physicalW || el.height !== physicalH) {
    el.width = physicalW
    el.height = physicalH
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)

  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, width, height)

  // 循环区间色带（铺在整个缩略图上，作为背景参考）
  const loop = props.loop
  if (loop && loop.endMs > loop.startMs) {
    const x1 = timeToMiniX(loop.startMs)
    const x2 = timeToMiniX(loop.endMs)
    ctx.fillStyle = COLORS.loop
    ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height)
  }

  // 每条轨一条泳道：即使某轨没有 item 也画出来（用户才知道「这轨是空的」）
  const rowCount = Math.max(1, props.tracks.length)
  const pad = 2
  const laneHeight = Math.max(2, (height - pad * 2) / rowCount)
  const selected = new Set<Id>(props.selectedIds)

  props.tracks.forEach((track, index) => {
    const top = pad + index * laneHeight
    const laneH = Math.max(2, laneHeight - 1)
    ctx.fillStyle = index % 2 === 0 ? COLORS.lane : COLORS.laneAlt
    ctx.fillRect(0, top, width, laneH)

    const list = props.itemsByTrack.get(track.trackId)
    if (!list || !list.length) return

    for (const item of list) {
      const x = timeToMiniX(item.timelineStartMs)
      const w = Math.max(1, timeToMiniX(itemDurationMs(item)))
      const isConflict = props.conflictIds.has(item.id)
      ctx.fillStyle = isConflict ? COLORS.itemConflict : track.color
      ctx.globalAlpha = 0.78
      ctx.fillRect(x, top, w, laneH)
      ctx.globalAlpha = 1
      if (selected.has(item.id)) {
        ctx.strokeStyle = COLORS.itemSelected
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, top + 0.5, Math.max(1, w - 1), Math.max(1, laneH - 1))
      }
    }
  })

  // 当前视口窗口（可拖动导航）
  const winX = timeToMiniX(props.scrollMs)
  const winW = Math.max(2, timeToMiniX(visibleDurationMs.value))
  ctx.fillStyle = COLORS.window
  ctx.fillRect(winX, 0, winW, height)
  ctx.strokeStyle = COLORS.windowEdge
  ctx.lineWidth = 1
  ctx.strokeRect(winX + 0.5, 0.5, Math.max(1, winW - 1), height - 1)

  // 播放头（播放中 = 绿色：一眼区分「时间线光标」与「实际出声位置」）
  const x = timeToMiniX(headMs.value)
  ctx.strokeStyle = props.playing ? COLORS.playingHead : COLORS.playhead
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(Math.round(x) + 0.5, 0)
  ctx.lineTo(Math.round(x) + 0.5, height)
  ctx.stroke()

  // 外框
  ctx.strokeStyle = COLORS.border
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
}

function measure(): void {
  const el = host.value
  if (!el) return
  cssWidth = Math.max(0, Math.round(el.clientWidth))
  draw()
}

watch(
  () => [
    props.durationMs, props.pxPerMs, props.scrollMs, props.viewportWidthPx,
    props.playheadMs, props.playingMs, props.playing, props.height,
    props.tracks.length,
    props.loop?.startMs ?? null, props.loop?.endMs ?? null,
    props.selectedIds.length,
  ],
  () => draw(),
)

onMounted(() => {
  dpr = globalThis.devicePixelRatio && globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
  measure()
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(host.value)
  }
  globalThis.addEventListener?.('resize', measure)
  draw()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  globalThis.removeEventListener?.('resize', measure)
})

// ---------------------------------------------------------------------------
// 交互：点击 = 播放头 + 居中；拖动 = 平移视口
// ---------------------------------------------------------------------------

function localX(event: PointerEvent): number {
  const el = canvas.value
  if (!el) return 0
  return event.clientX - el.getBoundingClientRect().left
}

/** 让窗口矩形中心落在 `ms` 上（不越界） */
function centerOn(ms: number): void {
  emit('scroll', Math.max(0, ms - visibleDurationMs.value / 2))
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging = true
  const ms = miniXToTime(localX(event))
  emit('seek', ms)
  centerOn(ms)
  try {
    ;(event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId)
  } catch {
    /* 没有 pointer capture 也能用（只是拖出组件会掉手） */
  }
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return
  centerOn(miniXToTime(localX(event)))
}

function onPointerUp(event: PointerEvent): void {
  dragging = false
  try {
    ;(event.currentTarget as Element | null)?.releasePointerCapture?.(event.pointerId)
  } catch {
    /* 忽略 */
  }
}

/** 双击 = 整章适配（等价于键盘 F，docs/13 §4.6） */
function onDoubleClick(): void {
  emit('fit')
}
</script>

<template>
  <div ref="host" class="ns-minimap" :style="{ height: `${height}px` }">
    <canvas
      ref="canvas"
      class="ns-minimap__canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
    />
    <span class="ns-minimap__hint">{{ rangeLabel }} · 双击适配整章</span>
  </div>
</template>

<style scoped>
.ns-minimap {
  position: relative;
  width: 100%;
  min-width: 0;
  border-top: 1px solid var(--ns-border, #e6e9f0);
  background: var(--ns-bg-subtle, #fafafa);
  user-select: none;
}
.ns-minimap__canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
}
.ns-minimap__hint {
  position: absolute;
  right: 6px;
  bottom: 2px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ns-bg, #fff) 80%, transparent);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  pointer-events: none;
}
</style>
