<!--
  Novel Studio · 切片波形 × 画本行对照时间线（docs/12 §4.4 / docs/05 §4.3 / §11.3）
  ============================================================================
  设计依据：
    · docs/12 §4.4 —— 确认界面的右栏是「波形 + 时间线对照」：上面是切片波形，
      下面是匹配到的画本行文本，用户扫一眼就能判断「这刀切在哪、对不对」。
    · docs/05 §4.3 —— 切片带 RMS/峰值；没有原始 PCM 时用它们**重建包络**，
      既不额外读盘，也能让「切片是否含静音」变得可见。
    · docs/05 §11.3 —— 波形绘制口径：按「每像素列一个 min/max」聚合（`buildEnvelope`），
      不做抽样，否则会漏掉瞬态。
    · docs/12 §10 —— 「不要用 DOM 堆柱状条」：几十片 × 上百列 = 上千个 DOM 节点，
      滚动与重排会拖垮确认界面，因此这里用 Canvas 自绘。

  坐标换算全部走 `@/shared/lib/waveform-transform.ts`（timeToX / xToTime / buildEnvelope /
  amplitudeToY / dbfsToAmplitude / fitPxPerMs / clampTime），组件里不自己写 px↔ms 公式。

  交互：点击定位（选中该时间点所在的切片并抛出 seek）；悬停显示该切片与对照行的文本。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { SliceMatch, VadSlice } from '@shared/types.ts'
import {
  TIMELINE_ZOOM_LIMITS,
  amplitudeToY,
  buildEnvelope,
  clampTime,
  dbfsToAmplitude,
  durationToWidth,
  fitPxPerMs,
  timeToX,
  xToTime,
} from '@/shared/lib/waveform-transform.ts'
import type { EnvelopeColumn, Viewport } from '@/shared/lib/waveform-transform.ts'
import { UNKNOWN, formatDb, formatDuration, formatScore } from '@/shared/lib/format.ts'

/** 对照用的画本行（只带绘制需要的字段）；父页面构造结构相同的数组即可 */
interface TimelineLine {
  id: string
  seq: number
  speakerName: string
  text: string
}

const props = withDefaults(defineProps<{
  slices: VadSlice[]
  /** 本章画本行（用于对照显示文本） */
  lines?: TimelineLine[]
  /** DP 匹配结果 */
  matches?: SliceMatch[]
  /** 手工绑定（优先级高于匹配结果） */
  manualBindings?: Record<number, string>
  /** 当前选中的切片 */
  selectedIndex?: number
  /** 播放头位置（毫秒） */
  playheadMs?: number | null
  /** 画布高度（CSS 像素） */
  height?: number
  showRuler?: boolean
}>(), {
  lines: () => [],
  matches: () => [],
  manualBindings: () => ({}),
  selectedIndex: 0,
  playheadMs: null,
  height: 190,
  showRuler: true,
})

const emit = defineEmits<{
  /** 点击选中某个切片 */
  select: [sliceIndex: number]
  /** 点击位置换算出的时间（毫秒）—— 供页面定位播放头 */
  seek: [ms: number]
  /** 悬停变化（null = 移出画布） */
  hover: [sliceIndex: number | null]
}>()

/** 包络重建的列宽（毫秒）：会话越长越粗，避免峰值数组过大（4 小时会话也不能卡） */
const MAX_PEAKS = 20_000
const bucketMs = computed(() => {
  const total = totalDurationMs.value
  if (!(total > 0)) return 10
  return Math.max(10, Math.ceil(total / MAX_PEAKS))
})

const totalDurationMs = computed(() => {
  const last = props.slices.reduce((max, slice) => Math.max(max, slice.endMs), 0)
  return last > 0 ? last : 0
})

const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const widthPx = ref(640)
const canvasHeight = computed(() => Math.max(120, props.height))
/** 波形区高度（其余留给画本行对照与标尺） */
const waveHeight = computed(() => Math.round(canvasHeight.value * 0.52))
const labelTop = computed(() => waveHeight.value + 6)
const labelHeight = computed(() => canvasHeight.value - labelTop.value)
/** 悬停的切片（tooltip 用它） */
const hoveredIndex = ref<number | null>(null)
/** tooltip 的位置（相对容器） */
const tooltipX = ref(0)
const tooltipY = ref(0)

/** lineId → 画本行 */
const lineById = computed(() => {
  const map = new Map<string, TimelineLine>()
  for (const line of props.lines) map.set(line.id, line)
  return map
})

const matchByIndex = computed(() => {
  const map = new Map<number, SliceMatch>()
  for (const match of props.matches) map.set(match.sliceIndex, match)
  return map
})

function lineIdOf(sliceIndex: number): string | null {
  return props.manualBindings[sliceIndex] ?? matchByIndex.value.get(sliceIndex)?.lineId ?? null
}

function lineOf(sliceIndex: number): TimelineLine | null {
  const lineId = lineIdOf(sliceIndex)
  return lineId ? lineById.value.get(lineId) ?? null : null
}

/**
 * 由切片的 RMS/峰值重建 peaks（[-1,1] 归一化幅度）。
 * 每片内部做「起伏」而不是一条直线：让用户看出这一片是有声音的（而不是一段静音被切进来）。
 */
const peaks = computed<Float32Array>(() => {
  const bucket = bucketMs.value
  const total = Math.ceil(totalDurationMs.value / bucket) + 1
  const data = new Float32Array(Math.max(1, total))
  for (const slice of props.slices) {
    const rms = dbfsToAmplitude(slice.rmsDb ?? -60)
    const peak = Math.max(rms, dbfsToAmplitude(slice.peakDb ?? -60))
    const from = Math.max(0, Math.floor(slice.startMs / bucket))
    const to = Math.min(data.length - 1, Math.ceil(slice.endMs / bucket))
    let k = 0
    for (let i = from; i <= to; i++) {
      // 用确定性的伪起伏（不用 Math.random：每次重绘波形都在跳会让人以为数据在变）
      const wobble = 0.72 + 0.28 * Math.abs(Math.sin((k + 1) * 0.7))
      const amp = rms + (peak - rms) * wobble
      data[i] = Math.max(data[i] ?? 0, Math.min(1, amp))
      k++
    }
  }
  return data
})

/** 视口：整段会话铺满画布宽度（确认界面不需要横向滚动，对齐全貌更重要） */
const viewport = computed<Viewport>(() => {
  const total = totalDurationMs.value
  if (!(total > 0) || !(widthPx.value > 0)) return { pxPerMs: TIMELINE_ZOOM_LIMITS.minPxPerMs, scrollMs: 0 }
  return {
    pxPerMs: fitPxPerMs(total, widthPx.value, TIMELINE_ZOOM_LIMITS),
    scrollMs: 0,
  }
})

const canvasRefShallow = shallowRef<CanvasRenderingContext2D | null>(null)

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

const COLORS = {
  matched: '#409eff',
  accepted: '#67c23a',
  unmatched: '#e6a23c',
  selected: 'rgba(64, 158, 255, 0.14)',
  grid: '#e4e7ed',
  text: '#606266',
  muted: '#909399',
  playhead: '#f56c6c',
}

/** 切片边界（时间轴上的竖线 + 片底色） */
function drawSliceBackdrop(ctx: CanvasRenderingContext2D, slice: VadSlice, selected: boolean, matched: boolean, accepted: boolean): void {
  const vp = viewport.value
  const x = timeToX(slice.startMs, vp)
  const w = Math.max(1, durationToWidth(slice.endMs - slice.startMs, vp))

  if (selected) {
    ctx.fillStyle = COLORS.selected
    ctx.fillRect(x, 0, w, labelTop.value + labelHeight.value)
  }

  // 未匹配的片用底色点出来（用户唯一要动脑的部分）
  if (!matched) {
    ctx.fillStyle = 'rgba(230, 162, 60, 0.10)'
    ctx.fillRect(x, 0, w, waveHeight.value)
  } else if (accepted) {
    ctx.fillStyle = 'rgba(103, 194, 58, 0.08)'
    ctx.fillRect(x, 0, w, waveHeight.value)
  }

  ctx.strokeStyle = matched ? (accepted ? COLORS.accepted : COLORS.matched) : COLORS.unmatched
  ctx.lineWidth = selected ? 1.4 : 1
  ctx.beginPath()
  ctx.moveTo(Math.round(x) + 0.5, 0)
  ctx.lineTo(Math.round(x) + 0.5, waveHeight.value)
  ctx.stroke()
}

/** 用 buildEnvelope 的列直接画 min/max 竖线（每像素列一根） */
function drawEnvelope(ctx: CanvasRenderingContext2D): void {
  const data = peaks.value
  if (!data.length || !(totalDurationMs.value > 0)) return
  const vp = viewport.value
  const bucket = bucketMs.value
  const midY = waveHeight.value / 2
  const half = Math.max(4, midY - 6)

  const columns: EnvelopeColumn[] = buildEnvelope({
    peaks: data,
    fromIndex: 0,
    toIndex: data.length - 1,
    viewport: vp,
    xStartPx: 0,
    xEndPx: widthPx.value,
    bucketMs: bucket,
  })

  // 指针推进：列 x 与切片都按时间递增，避免每列都去线性查找切片
  let pointer = 0
  const ordered = props.slices
  for (const column of columns) {
    const atMs = xToTime(column.x, vp)
    while (pointer < ordered.length - 1 && (ordered[pointer]?.endMs ?? 0) < atMs) pointer++
    const slice = ordered[pointer]
    const matched = slice ? lineIdOf(slice.sliceIndex) !== null : false
    const accepted = slice ? Boolean(slice.accepted) : false
    ctx.strokeStyle = matched ? (accepted ? COLORS.accepted : COLORS.matched) : COLORS.unmatched
    // 包络按「列的绝对幅度」上下对称绘制：重建出来的 peaks 是单极性的（RMS/峰值），
    // 直接用 min/max 会画成只有上半边的图形，看上去像被削掉了。
    const amp = Math.max(Math.abs(column.min), Math.abs(column.max))
    ctx.beginPath()
    ctx.moveTo(column.x + 0.5, amplitudeToY(amp, midY, half))
    ctx.lineTo(column.x + 0.5, amplitudeToY(-amp, midY, half))
    ctx.stroke()
  }

  // 中线（0 幅度）
  ctx.strokeStyle = COLORS.grid
  ctx.beginPath()
  ctx.moveTo(0, midY + 0.5)
  ctx.lineTo(widthPx.value, midY + 0.5)
  ctx.stroke()
}

/** 时间标尺：间隔取「好看」的档位，避免出现 733 ms 这种刻度 */
function niceStepMs(totalMs: number, targetTicks = 8): number {
  const raw = totalMs / Math.max(1, targetTicks)
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]
  for (const step of steps) {
    if (step >= raw) return step
  }
  return steps[steps.length - 1]!
}

function drawRuler(ctx: CanvasRenderingContext2D): void {
  if (!props.showRuler || !(totalDurationMs.value > 0)) return
  const vp = viewport.value
  const step = niceStepMs(totalDurationMs.value)
  ctx.fillStyle = COLORS.muted
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  for (let ms = 0; ms <= totalDurationMs.value; ms += step) {
    const x = timeToX(ms, vp)
    ctx.strokeStyle = COLORS.grid
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, waveHeight.value - 4)
    ctx.lineTo(Math.round(x) + 0.5, waveHeight.value)
    ctx.stroke()
    ctx.fillText(formatDuration(ms), Math.round(x) + 2, waveHeight.value + 1)
  }
}

/** 画本行对照轨道：每片下面写它匹配到的行（序号 + 说话人 + 文本开头） */
function drawLineLabels(ctx: CanvasRenderingContext2D): void {
  const vp = viewport.value
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'top'

  for (const slice of props.slices) {
    const x = timeToX(slice.startMs, vp)
    const w = Math.max(1, durationToWidth(slice.endMs - slice.startMs, vp))
    const line = lineOf(slice.sliceIndex)

    ctx.save()
    ctx.beginPath()
    ctx.rect(x, labelTop.value, Math.max(2, w - 1), labelHeight.value)
    ctx.clip()

    if (line) {
      ctx.fillStyle = COLORS.text
      const header = `${line.seq} ${line.speakerName}`
      ctx.fillText(header, x + 3, labelTop.value + 2)
      ctx.fillStyle = COLORS.muted
      ctx.fillText(line.text, x + 3, labelTop.value + 16)
    } else {
      ctx.fillStyle = COLORS.unmatched
      ctx.fillText('未匹配', x + 3, labelTop.value + 2)
    }
    ctx.restore()

    // 片间竖线（延伸到对照轨）
    ctx.strokeStyle = COLORS.grid
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, labelTop.value)
    ctx.lineTo(Math.round(x) + 0.5, canvasHeight.value)
    ctx.stroke()

    // 宽度足够时显示片信息
    if (w > 96) {
      ctx.fillStyle = COLORS.muted
      const score = matchByIndex.value.get(slice.sliceIndex)?.confidence ?? null
      ctx.fillText(
        `#${slice.sliceIndex + 1} ${formatDuration(slice.endMs - slice.startMs)}${score === null ? '' : ` · ${formatScore(score)}`}`,
        x + 3,
        labelTop.value + 30,
      )
    }
  }
}

function drawPlayhead(ctx: CanvasRenderingContext2D): void {
  const ms = props.playheadMs
  if (ms === null) return
  const vp = viewport.value
  const x = timeToX(ms, vp)
  ctx.strokeStyle = COLORS.playhead
  ctx.beginPath()
  ctx.moveTo(Math.round(x) + 0.5, 0)
  ctx.lineTo(Math.round(x) + 0.5, canvasHeight.value)
  ctx.stroke()
}

function drawEmpty(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COLORS.muted
  ctx.font = '12px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText('还没有切片结果：停止连续录制后会自动跑 VAD 分析', 12, canvasHeight.value / 2)
}

function draw(): void {
  const canvas = canvasRef.value
  const ctx = canvasRefShallow.value
  if (!canvas || !ctx) return
  // 先按 DPR 调整位图尺寸（会清空内容），再设变换并重绘
  const scale = dpr()
  canvas.width = Math.max(1, Math.round(widthPx.value * scale))
  canvas.height = Math.max(1, Math.round(canvasHeight.value * scale))
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, widthPx.value, canvasHeight.value)

  if (!props.slices.length) {
    drawEmpty(ctx)
    return
  }

  // 先画底色（选中/未匹配），再画包络，最后画对照文本与播放头
  for (const slice of props.slices) {
    drawSliceBackdrop(
      ctx,
      slice,
      slice.sliceIndex === props.selectedIndex,
      lineIdOf(slice.sliceIndex) !== null,
      Boolean(slice.accepted),
    )
  }
  drawEnvelope(ctx)
  drawRuler(ctx)
  drawLineLabels(ctx)
  drawPlayhead(ctx)
}

function dpr(): number {
  return Math.max(1, Math.min(3, globalThis.devicePixelRatio ?? 1))
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

/** 时间点 → 切片下标（切片按时间升序，线性扫描足够：确认界面最多几百片） */
function sliceIndexAt(ms: number): number | null {
  for (const slice of props.slices) {
    if (ms >= slice.startMs && ms <= slice.endMs) return slice.sliceIndex
  }
  // 落在片间空隙：取最近的一片的「前一片」
  let nearest: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const slice of props.slices) {
    const distance = Math.min(Math.abs(ms - slice.startMs), Math.abs(ms - slice.endMs))
    if (distance < bestDistance) {
      bestDistance = distance
      nearest = slice.sliceIndex
    }
  }
  return nearest
}

function localX(event: MouseEvent): number {
  const container = containerRef.value
  if (!container) return 0
  const rect = container.getBoundingClientRect()
  return event.clientX - rect.left
}

function onClick(event: MouseEvent): void {
  if (!props.slices.length) return
  const ms = clampTime(xToTime(localX(event), viewport.value), totalDurationMs.value)
  emit('seek', ms)
  const index = sliceIndexAt(ms)
  if (index !== null) emit('select', index)
}

function onMouseMove(event: MouseEvent): void {
  if (!props.slices.length) return
  const x = localX(event)
  const ms = clampTime(xToTime(x, viewport.value), totalDurationMs.value)
  const index = sliceIndexAt(ms)
  hoveredIndex.value = index
  const container = containerRef.value
  const rect = container?.getBoundingClientRect()
  const containerWidth = rect?.width ?? widthPx.value
  tooltipX.value = Math.min(x + 12, Math.max(0, containerWidth - 260))
  tooltipY.value = event.clientY - (rect?.top ?? 0) + 12
  emit('hover', index)
}

function onMouseLeave(): void {
  hoveredIndex.value = null
  emit('hover', null)
}

const hoveredSlice = computed(() => props.slices.find(s => s.sliceIndex === hoveredIndex.value) ?? null)
const hoveredLine = computed(() => (hoveredIndex.value === null ? null : lineOf(hoveredIndex.value)))

// ---------------------------------------------------------------------------
// 尺寸同步 + 重绘
// ---------------------------------------------------------------------------

let observer: ResizeObserver | null = null

function syncSize(): void {
  const container = containerRef.value
  if (!container) return
  const width = Math.max(160, Math.round(container.clientWidth))
  if (width !== widthPx.value) widthPx.value = width
  draw()
}

onMounted(() => {
  const canvas = canvasRef.value
  canvasRefShallow.value = canvas?.getContext('2d') ?? null
  syncSize()
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    observer = new ResizeObserver(() => syncSize())
    observer.observe(containerRef.value)
  }
  draw()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

// 任何影响画面的输入变化都要重绘（切片、选中、播放头、尺寸）
watch(
  () => [props.slices, props.selectedIndex, props.playheadMs, props.matches, props.manualBindings, widthPx.value, canvasHeight.value],
  () => draw(),
  { deep: false },
)
</script>

<template>
  <section class="ns-slice-timeline">
    <header class="ns-slice-timeline__header">
      <h4 class="ns-slice-timeline__title">切片波形 × 画本行对照</h4>
      <p class="ns-slice-timeline__hint">
        点击定位（选中该时间点所在的切片）· 悬停查看文本 · 颜色：<span class="is-matched">蓝=已匹配</span>
        <span class="is-accepted">绿=已接受</span><span class="is-unmatched">橙=未匹配</span>
      </p>
    </header>

    <div
      ref="containerRef"
      class="ns-slice-timeline__canvas-wrap"
      :style="{ height: `${canvasHeight}px` }"
      @click="onClick"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
    >
      <canvas ref="canvasRef" class="ns-slice-timeline__canvas" />
      <div
        v-if="hoveredSlice"
        class="ns-slice-timeline__tooltip"
        :style="{ left: `${tooltipX}px`, top: `${tooltipY}px` }"
      >
        <p class="ns-slice-timeline__tooltip-title">
          #{{ hoveredSlice.sliceIndex + 1 }}
          {{ formatDuration(hoveredSlice.startMs, { showMs: true }) }} →
          {{ formatDuration(hoveredSlice.endMs, { showMs: true }) }}
        </p>
        <p class="ns-slice-timeline__tooltip-meta">
          RMS {{ formatDb(hoveredSlice.rmsDb) }} · 峰值 {{ formatDb(hoveredSlice.peakDb) }} ·
          分数 {{ hoveredLine ? formatScore(matchByIndex.get(hoveredSlice.sliceIndex)?.confidence ?? null) : UNKNOWN }}
          {{ manualBindings[hoveredSlice.sliceIndex] ? '· 手工绑定' : '' }}
        </p>
        <p v-if="hoveredLine" class="ns-slice-timeline__tooltip-text">
          {{ hoveredLine.seq }} {{ hoveredLine.speakerName }}：{{ hoveredLine.text }}
        </p>
        <p v-else class="ns-slice-timeline__tooltip-text is-unmatched">未匹配到画本行，请手工绑定</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ns-slice-timeline { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-elevated, #fff); }
.ns-slice-timeline__header { display: flex; flex-direction: column; gap: 4px; }
.ns-slice-timeline__title { margin: 0; font-size: 14px; color: var(--ns-text-primary, #303133); }
.ns-slice-timeline__hint { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-slice-timeline__hint .is-matched { color: var(--ns-primary, #409eff); }
.ns-slice-timeline__hint .is-accepted { color: var(--ns-success, #67c23a); }
.ns-slice-timeline__hint .is-unmatched { color: var(--ns-warning, #e6a23c); }
.ns-slice-timeline__canvas-wrap { position: relative; width: 100%; overflow: hidden; border: 1px solid var(--ns-border-light, #e4e7ed); border-radius: 6px; background: var(--ns-bg-subtle, #fafafa); cursor: crosshair; }
.ns-slice-timeline__canvas { display: block; width: 100%; height: 100%; }
.ns-slice-timeline__tooltip { position: absolute; z-index: 2; max-width: 250px; padding: 6px 8px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: rgb(255 255 255 / 96%); box-shadow: 0 4px 12px rgb(0 0 0 / 12%); pointer-events: none; }
.ns-slice-timeline__tooltip-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--ns-text-primary, #303133); }
.ns-slice-timeline__tooltip-meta { margin: 2px 0 0; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--ns-text-secondary, #909399); }
.ns-slice-timeline__tooltip-text { margin: 4px 0 0; font-size: 12px; color: var(--ns-text-regular, #606266); }
.ns-slice-timeline__tooltip-text.is-unmatched { color: var(--ns-warning, #e6a23c); }
</style>
