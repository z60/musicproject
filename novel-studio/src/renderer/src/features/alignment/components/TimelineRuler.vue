<!--
  Novel Studio · 时间线刻度尺（docs/13 §4.5 / §4.6）
  ============================================================================
  设计依据：
    · docs/13 §4.5 —— 时间轴在轨道区之上，刻度与轨道区**共用同一个视口**
      （`pxPerMs` / `scrollMs`），否则刻度与片段会错位；
    · docs/13 §4.6 —— 「横向缩放从整章总览到样本级」：刻度必须按缩放自动选
      1 s / 5 s / 10 s / 1 min 乃至毫秒细分。这里**不自造台阶表**，直接用
      `useTimelineRenderer.chooseTickSpec`（画布网格用的是同一份，保证对齐）；
    · docs/13 §4.5 —— 点击/拖动定位播放头；`Shift` 拖动 = 画循环区间
      （用来反复听一处重叠，§4.6「循环区间」）。

  为什么刻度尺也自绘 Canvas：
    刻度数量随缩放变化（整章总览时 ~10 条，样本级时 ~200 条），DOM 文本节点
    在缩放过程中每帧重建会明显掉帧；Canvas 一次 fillText 循环即可，且能与
    主画布的网格线严格对齐（同一套 `majorTickTimes`）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clampTime, xToTime } from '@/shared/lib/waveform-transform.ts'
import { formatDuration } from '@/shared/lib/format.ts'
import {
  chooseTickSpec,
  majorTickTimes,
  tickLabel,
} from '../composables/useTimelineRenderer.ts'

const props = withDefaults(defineProps<{
  /** 每毫秒像素（与 TimelineCanvas 同一视口，必须同源） */
  pxPerMs: number
  /** 视口左边缘对应的时间（毫秒） */
  scrollMs: number
  /** 播放头位置（毫秒） */
  playheadMs: number
  /** 章节总时长（点击/拖动越界时夹紧） */
  durationMs: number
  /** 循环区间（画半透明色带） */
  loop?: { startMs: number; endMs: number } | null
  /** 刻度尺高度（像素） */
  height?: number
  /** 缩放级别文案（由视图给 timeline store 的 zoomLabel，不在组件里重算） */
  zoomLabel?: string
  /** 吸附是否开启（状态提示用） */
  snapEnabled?: boolean
  /** 网格粒度（毫秒），显示在缩放旁边 */
  gridMs?: number
}>(), {
  loop: null,
  height: 30,
  zoomLabel: '',
  snapEnabled: true,
  gridMs: 100,
})

const emit = defineEmits<{
  /** 定位播放头（点击或拖动刻度尺） */
  seek: [ms: number]
  /** 拖出了循环区间（Shift + 拖动） */
  'loop-set': [range: { startMs: number; endMs: number }]
  /** 双击刻度尺：清除循环区间 */
  'loop-clear': []
}>()

const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

/** CSS 宽度（由 ResizeObserver 维护；刻度只关心宽度） */
let cssWidth = 0
let dpr = 1
let observer: ResizeObserver | null = null

/** 拖动状态：null = 未按下 */
const drag = ref<{ mode: 'playhead' | 'loop'; startMs: number } | null>(null)

const gridLabel = computed(() => {
  const ms = props.gridMs
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return ms >= 1000 ? `${ms / 1000} s` : `${Math.round(ms)} ms`
})

const playheadLabel = computed(() => formatDuration(props.playheadMs, { showMs: true }))

// ---------------------------------------------------------------------------
// 坐标换算：与画布严格同源（同一 Viewport 结构）
// ---------------------------------------------------------------------------

function viewport(): { pxPerMs: number; scrollMs: number } {
  return { pxPerMs: props.pxPerMs, scrollMs: props.scrollMs }
}

/** 事件 → 视口内 x（相对刻度尺左边缘） */
function localX(event: PointerEvent | MouseEvent): number {
  const el = canvas.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  return event.clientX - rect.left
}

/** 事件 → 时间（毫秒，夹紧到 [0, 章节时长]） */
function timeAt(event: PointerEvent | MouseEvent): number {
  return clampTime(xToTime(localX(event), viewport()), Math.max(0, props.durationMs))
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

const COLORS = {
  background: '#f5f7fa',
  border: '#e6e9f0',
  major: 'rgba(144, 147, 153, 0.55)',
  minor: 'rgba(144, 147, 153, 0.28)',
  label: 'rgba(48, 49, 51, 0.72)',
  playhead: '#f56c6c',
  loopBand: 'rgba(64, 158, 255, 0.16)',
  loopEdge: 'rgba(64, 158, 255, 0.75)',
  outOfRange: 'rgba(144, 147, 153, 0.08)',
} as const

function draw(): void {
  const el = canvas.value
  if (!el) {
    return
  }
  const ctx = el.getContext('2d')
  if (!ctx) return

  const width = Math.max(1, Math.round(cssWidth))
  const height = Math.max(12, Math.round(props.height))
  const ratio = Math.max(1, dpr)

  // devicePixelRatio：物理像素与 CSS 像素分离，避免高分屏发虚
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

  const vp = viewport()
  const spec = chooseTickSpec(vp.pxPerMs)

  // 1) 章节之外的部分压暗（避免用户以为「后面还有内容」）
  if (props.durationMs > 0) {
    const endX = (props.durationMs - vp.scrollMs) * vp.pxPerMs
    if (endX < width) {
      ctx.fillStyle = COLORS.outOfRange
      ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), height)
    }
  }

  // 2) 循环区间色带（在刻度之下，文字之上仍可读）
  const loop = props.loop
  if (loop && loop.endMs > loop.startMs) {
    const x1 = (loop.startMs - vp.scrollMs) * vp.pxPerMs
    const x2 = (loop.endMs - vp.scrollMs) * vp.pxPerMs
    if (x2 > 0 && x1 < width) {
      const left = Math.max(0, x1)
      const right = Math.min(width, x2)
      ctx.fillStyle = COLORS.loopBand
      ctx.fillRect(left, 0, right - left, height)
      ctx.strokeStyle = COLORS.loopEdge
      ctx.lineWidth = 1
      ctx.beginPath()
      if (x1 >= 0) {
        ctx.moveTo(Math.round(x1) + 0.5, 0)
        ctx.lineTo(Math.round(x1) + 0.5, height)
      }
      if (x2 <= width) {
        ctx.moveTo(Math.round(x2) + 0.5, 0)
        ctx.lineTo(Math.round(x2) + 0.5, height)
      }
      ctx.stroke()
    }
  }

  // 3) 次刻度：只画短线，不出标签（毫秒细分靠它，标签靠主刻度）
  if (spec.minorMs > 0 && spec.minorMs * vp.pxPerMs >= 4) {
    ctx.strokeStyle = COLORS.minor
    ctx.lineWidth = 1
    ctx.beginPath()
    const first = Math.floor(xToTime(0, vp) / spec.minorMs) * spec.minorMs
    for (let t = first; t <= xToTime(width, vp); t += spec.minorMs) {
      if (t < 0) continue
      if (t % spec.majorMs === 0) continue // 主刻度自己画
      const x = Math.round((t - vp.scrollMs) * vp.pxPerMs) + 0.5
      if (x < 0 || x > width) continue
      ctx.moveTo(x, height - 6)
      ctx.lineTo(x, height - 1)
    }
    ctx.stroke()
  }

  // 4) 主刻度 + 时间码
  ctx.strokeStyle = COLORS.major
  ctx.fillStyle = COLORS.label
  ctx.lineWidth = 1
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textBaseline = 'top'
  ctx.beginPath()
  for (const t of majorTickTimes(vp, width, spec)) {
    const x = Math.round((t - vp.scrollMs) * vp.pxPerMs) + 0.5
    if (x < -1 || x > width + 1) continue
    ctx.moveTo(x, height - 11)
    ctx.lineTo(x, height - 1)
    ctx.fillText(tickLabel(t, spec), x + 4, 3)
  }
  ctx.stroke()

  // 5) 播放头（红色三角 + 竖线：拖动时能看清锚点）
  const playheadX = (props.playheadMs - vp.scrollMs) * vp.pxPerMs
  if (playheadX >= -8 && playheadX <= width + 8) {
    const px = Math.round(playheadX) + 0.5
    ctx.strokeStyle = COLORS.playhead
    ctx.fillStyle = COLORS.playhead
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, height)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(px - 5, 0)
    ctx.lineTo(px + 5, 0)
    ctx.lineTo(px, 8)
    ctx.closePath()
    ctx.fill()
  }

  // 6) 下沿分隔线（与画布顶部对齐，视觉上把刻度尺「钉」在轨道区上）
  ctx.fillStyle = COLORS.border
  ctx.fillRect(0, height - 1, width, 1)
}

// ---------------------------------------------------------------------------
// 尺寸 / 缩放变化重绘
// ---------------------------------------------------------------------------

function measure(): void {
  const el = host.value
  if (!el) return
  cssWidth = Math.max(0, Math.round(el.clientWidth))
  draw()
}

watch(
  () => [props.pxPerMs, props.scrollMs, props.playheadMs, props.durationMs, props.height,
    props.loop?.startMs ?? null, props.loop?.endMs ?? null],
  () => draw(),
)

watch(() => props.height, () => draw())

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
// 交互
// ---------------------------------------------------------------------------

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const ms = timeAt(event)
  if (event.shiftKey) {
    drag.value = { mode: 'loop', startMs: ms }
  } else {
    drag.value = { mode: 'playhead', startMs: ms }
    emit('seek', ms)
  }
  try {
    ;(event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId)
  } catch {
    /* 没有 pointer capture 的环境只是拖出边界会掉手，不影响主流程 */
  }
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  const current = drag.value
  if (!current) return
  const ms = timeAt(event)
  if (current.mode === 'playhead') {
    emit('seek', ms)
    return
  }
  // 循环区间：拖动过程中实时给出（宽度过小的区间没有意义，落到 200 ms 下限）
  const start = Math.min(current.startMs, ms)
  const end = Math.max(current.startMs, ms)
  if (end - start >= 200) emit('loop-set', { startMs: start, endMs: end })
}

function onPointerUp(event: PointerEvent): void {
  drag.value = null
  try {
    ;(event.currentTarget as Element | null)?.releasePointerCapture?.(event.pointerId)
  } catch {
    /* 忽略 */
  }
}

function onDoubleClick(): void {
  // 双击 = 清除循环区间（与「框选建循环」对称的操作）
  emit('loop-clear')
}
</script>

<template>
  <div ref="host" class="ns-ruler" :style="{ height: `${height}px` }">
    <canvas
      ref="canvas"
      class="ns-ruler__canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
    />
    <!-- 视图下沿：当前缩放级别 / 网格粒度 / 播放头时间码（docs/13 §4.6 缩放记忆与状态） -->
    <div class="ns-ruler__meta">
      <span class="ns-ruler__zoom">{{ zoomLabel || '—' }}</span>
      <span class="ns-ruler__sep">·</span>
      <span>网格 {{ gridLabel }}</span>
      <span class="ns-ruler__sep">·</span>
      <span :class="['ns-ruler__snap', { 'is-off': !snapEnabled }]">
        {{ snapEnabled ? '吸附开' : '吸附关' }}
      </span>
      <span class="ns-ruler__sep">·</span>
      <span class="ns-ruler__head">{{ playheadLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.ns-ruler {
  position: relative;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--ns-border, #e6e9f0);
  user-select: none;
}
.ns-ruler__canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: ew-resize;
  touch-action: none;
}
.ns-ruler__meta {
  position: absolute;
  right: 6px;
  bottom: 1px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ns-bg, #fff) 82%, transparent);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 14px;
  pointer-events: none;
}
.ns-ruler__zoom {
  color: var(--ns-text-regular, #606266);
}
.ns-ruler__sep {
  opacity: 0.5;
}
.ns-ruler__snap.is-off {
  color: var(--ns-warning, #e6a23c);
}
.ns-ruler__head {
  color: var(--ns-danger, #f56c6c);
  font-variant-numeric: tabular-nums;
}
</style>
