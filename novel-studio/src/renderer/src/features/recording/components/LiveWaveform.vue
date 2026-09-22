<!--
  Novel Studio · 实时波形（录音中滚动显示）
  ============================================================================
  设计依据：
    · docs/12 §10  —— LiveWaveform.vue：实时波形（环形缓冲 + rAF 绘制）
    · docs/05 §11.3—— 「录音中实时波形：从采集块直接算 min/max，环形缓冲保留最近 5 s，
                        requestAnimationFrame 绘制」
    · docs/12 §4.2 —— 连续录制时滚动显示最近 5 秒
    · docs/12 §3.1 —— 波形区旁边要有时间标尺与采样率

  实现要点（这几条决定了 30 分钟录音时 UI 不卡）：
    1. **环形缓冲**：只保留最近 `windowMs` 的 min/max 对（默认 5 s，每列 5 ms → 1000 列），
       内存恒定，与录音时长无关。
    2. **滚动用「拷贝 + 只画新出现的窄条」**：每帧把画布自身左移 dx 像素
       （`drawImage(canvas, -dx, 0)`），再用 `timeRangeToDirtyRect` 算出右侧脏条并只画它。
       整屏重绘只在尺寸/缩放/换行时发生。
    3. **绘制在 rAF 里，采样在 pushBlock 里**：音频块到达频率（20 Hz）与屏幕刷新率解耦，
       采不到块时也不会白画。
    4. 不用 wavesurfer.js、不堆 DOM 柱条：`docs/02` 里 wavesurfer 只用于对轨侧的片段波形。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  amplitudeToY,
  computeDirtyRect,
  peakPairsToEnvelope,
  timeRangeToDirtyRect,
  timeToX,
} from '@/shared/lib/waveform-transform.ts'
import type { Rect, Viewport } from '@/shared/lib/waveform-transform.ts'
import { formatSampleRate } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  /** 是否正在采集（false 时波形静止，但仍然显示已画的内容） */
  active?: boolean
  /** 暂停中：不滚动、不推进（docs/12 §2 的 paused） */
  paused?: boolean
  /** 采样率（用于列宽换算与时标尺） */
  sampleRate?: number
  /** 显示窗口长度（毫秒） */
  windowMs?: number
  /** 画布高度（CSS 像素） */
  height?: number
  /** 已录时长（毫秒）—— 用于标尺上的「总时长」读数 */
  durationMs?: number
  /** 是否削波（画红条 + 顶部提示） */
  clipping?: boolean
  /** 是否显示时间标尺 */
  showRuler?: boolean
}>(), {
  active: false,
  paused: false,
  sampleRate: 48000,
  windowMs: 5000,
  height: 110,
  durationMs: 0,
  clipping: false,
  showRuler: true,
})

const emit = defineEmits<{
  /** 用户改变显示窗口长度（5s / 15s / 30s） */
  'window-change': [windowMs: number]
}>()

/** 每列代表的时长（毫秒）—— 越小波形越细（= 分辨率越高） */
const COLUMN_MS = 5
/** 窗口可选档位（docs/12 §4.2 默认 5 秒） */
const WINDOW_CHOICES = [5000, 15_000, 30_000]

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const widthPx = ref(600)
const canvasHeight = computed(() => props.height)

/** 环形缓冲：每列两个 float（min/max），长度 = 列数 * 2 */
const ring = shallowRef<Float32Array>(new Float32Array(0))
const columnCount = ref(1000)
let writeIndex = 0
/** 已经写过的列数（绝对计数）：决定时间轴与可见范围 */
let writtenColumns = 0
/** 未凑满一列的样本 */
let pending = new Float32Array(0)
let pendingLength = 0
let sampleRateRef = 48000
/** take 预览模式：未录音时显示当前行选中 take 的整段波形（docs/91 §5.2.46 / §5.2.47） */
const takeMode = ref(false)
const takeTotalMs = ref(0)
/** take 预览时每列代表的时长（主进程 peaks 的桶宽；实时模式恒为 COLUMN_MS） */
const takeColumnMs = ref(COLUMN_MS)
const columnMs = (): number => (takeMode.value ? takeColumnMs.value : COLUMN_MS)

let rafId: number | null = null
let context: CanvasRenderingContext2D | null = null
let renderedNowMs = 0
let needsFullRedraw = true

const viewport = computed<Viewport>(() => {
  const windowMs = takeMode.value && takeTotalMs.value > 0 ? takeTotalMs.value : props.windowMs > 0 ? props.windowMs : 5000
  const pxPerMs = widthPx.value / windowMs
  const nowMs = writtenColumns * columnMs()
  // take 预览：固定从 0 开始看整段；实时：自动滚到最新
  return { pxPerMs, scrollMs: takeMode.value ? 0 : Math.max(0, nowMs - windowMs) }
})

const elapsedMs = computed(() => writtenColumns * COLUMN_MS)
const hasData = computed(() => writtenColumns > 0)
const isEmptyHint = computed(() => !props.active && !hasData.value)

/** 环形缓冲重建（列数变化 = 窗口长度变化）；列数可由调用方指定（take 预览用整段列数） */
function rebuildRing(nextColumns: number = Math.max(64, Math.ceil(props.windowMs / COLUMN_MS))): void {
  if (nextColumns === columnCount.value && ring.value.length) return
  columnCount.value = nextColumns
  ring.value = new Float32Array(nextColumns * 2)
  writeIndex = 0
  writtenColumns = 0
  pending = new Float32Array(0)
  pendingLength = 0
  needsFullRedraw = true
}

/** 把一列 min/max 写进环形缓冲 */
function writeColumn(min: number, max: number): void {
  const buffer = ring.value
  const index = writeIndex * 2
  buffer[index] = min
  buffer[index + 1] = max
  writeIndex = (writeIndex + 1) % columnCount.value
  writtenColumns += 1
}

/**
 * 采集块入口（由录音页通过 onPcmBlock 转调，或组件 ref 直接调用）。
 * `docs/05 §11.3`：从采集块直接算 min/max，不做 FFT、不做 smoothing。
 */
function pushBlock(samples: Float32Array, sampleRate = props.sampleRate): void {
  if (!samples.length) return
  // 一旦有实时采集块进来，就退出 take 预览（录音期间显示的是实时流）
  if (takeMode.value) clearTake()
  if (sampleRate !== sampleRateRef) sampleRateRef = sampleRate
  const columnFrames = Math.max(1, Math.round((sampleRate * COLUMN_MS) / 1000))

  // 把不足一列的样本与上一块拼起来
  let source: Float32Array
  if (pendingLength > 0) {
    source = new Float32Array(pendingLength + samples.length)
    source.set(pending.subarray(0, pendingLength), 0)
    source.set(samples, pendingLength)
  } else {
    source = samples
  }

  let offset = 0
  while (source.length - offset >= columnFrames) {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let i = offset; i < offset + columnFrames; i++) {
      const v = source[i] ?? 0
      if (v < min) min = v
      if (v > max) max = v
    }
    writeColumn(min, max)
    offset += columnFrames
  }

  const rest = source.length - offset
  if (rest > 0) {
    const next = new Float32Array(rest)
    next.set(source.subarray(offset), 0)
    pending = next
    pendingLength = rest
  } else {
    pending = new Float32Array(0)
    pendingLength = 0
  }
}

function reset(): void {
  writeIndex = 0
  writtenColumns = 0
  pending = new Float32Array(0)
  pendingLength = 0
  renderedNowMs = 0
  needsFullRedraw = true
  if (ring.value.length) ring.value.fill(0)
  if (context && canvasRef.value) {
    context.clearRect(0, 0, widthPx.value, canvasHeight.value)
    drawEmpty()
  }
}

/**
 * take 预览：把主进程 `analysis:peaks` 的峰值铺进波形区（docs/91 §5.2.46 / §5.2.47）。
 *
 * `peaks` 是 **min/max 交替、归一化到 [-1,1]** 的数组（契约见 `analysis:peaks`），
 * `totalMs` 是这段音频的时长（时间轴右端）。
 *
 * 为什么不用 `fetch(ns-media://…) + decodeAudioData`：渲染进程 CSP 是
 * `connect-src 'self'`（docs/02 §3：渲染进程不直接访问外部资源，全部经主进程），
 * 自定义协议的音频**读不出来** —— 真机事故 docs/91 §5.2.47 就是这么踩的。
 */
function showPeaks(peaks: ArrayLike<number>, totalMs: number): void {
  const envelope = peakPairsToEnvelope(peaks)
  const buckets = envelope.length
  if (buckets <= 0) return
  takeMode.value = true
  takeTotalMs.value = Math.max(1000, Math.round(totalMs))
  takeColumnMs.value = takeTotalMs.value / buckets
  rebuildRing(buckets)
  writeIndex = 0
  writtenColumns = 0
  pending = new Float32Array(0)
  pendingLength = 0
  for (const col of envelope) writeColumn(col.min, col.max)
  renderedNowMs = 0
  needsFullRedraw = true
}

/**
 * 退出 take 预览并**清空画面**（回到空态）。
 *
 * ⚠️ 必须无条件重置：以前写成"只在 take 模式下才 reset"，于是实时波形留下的
 * 上一次内容在切行时**永远不会被清掉**（真机反馈 docs/91 §5.2.47：
 * 「点击下一行还未实现重置实时波形」）。
 */
function clearTake(): void {
  takeMode.value = false
  takeTotalMs.value = 0
  takeColumnMs.value = COLUMN_MS
  reset()
}

/** 设备像素比适配：canvas 内部分辨率 = CSS 像素 × dpr（否则高分屏上波形发虚） */
function syncCanvasSize(): void {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return
  const nextWidth = Math.max(120, Math.round(container.clientWidth))
  const dpr = globalThis.devicePixelRatio || 1
  if (widthPx.value !== nextWidth) {
    widthPx.value = nextWidth
    needsFullRedraw = true
  }
  const nextCanvasWidth = Math.round(nextWidth * dpr)
  const nextCanvasHeight = Math.round(canvasHeight.value * dpr)
  if (canvas.width !== nextCanvasWidth || canvas.height !== nextCanvasHeight) {
    canvas.width = nextCanvasWidth
    canvas.height = nextCanvasHeight
    needsFullRedraw = true
  }
  canvas.style.height = `${canvasHeight.value}px`
  canvas.style.width = '100%'
  context = canvas.getContext('2d')
  if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/** 画空态（没有数据时的零线与提示） */
function drawEmpty(): void {
  if (!context) return
  const midY = canvasHeight.value / 2
  context.clearRect(0, 0, widthPx.value, canvasHeight.value)
  context.strokeStyle = 'rgba(144, 147, 153, 0.35)'
  context.beginPath()
  context.moveTo(0, midY)
  context.lineTo(widthPx.value, midY)
  context.stroke()
  if (!isEmptyHint.value) return
  context.fillStyle = 'rgba(144, 147, 153, 0.8)'
  context.font = '12px system-ui, sans-serif'
  context.fillText('等待采集…（按下录制后这里会滚动显示最近 5 秒）', 12, midY - 10)
}

/**
 * 只画 [x0, x1) 这一段：背景、列、零线、标尺、削波条都在这里画。
 * 全屏重绘 = drawRegion(0, width)；滚动时只画右侧新出现的窄条。
 */
function drawRegion(x0: number, x1: number): void {
  if (!context) return
  const height = canvasHeight.value
  const left = Math.max(0, Math.floor(x0))
  const right = Math.min(widthPx.value, Math.ceil(x1))
  if (right <= left) return

  context.clearRect(left, 0, right - left, height)

  const midY = height / 2
  const halfHeight = Math.max(4, (height - (props.showRuler ? 16 : 8)) / 2)

  // 零线
  context.strokeStyle = 'rgba(144, 147, 153, 0.35)'
  context.beginPath()
  context.moveTo(left, midY)
  context.lineTo(right, midY)
  context.stroke()

  // 波形列：从环形缓冲按绝对列号取（k % columnCount）
  const vp = viewport.value
  const buffer = ring.value
  if (buffer.length && writtenColumns > 0) {
    const col = columnMs()
    const pxPerColumn = Math.max(1, col * vp.pxPerMs)
    const firstColumn = Math.max(0, Math.floor(vp.scrollMs / col))
    const lastColumn = writtenColumns - 1
    context.fillStyle = props.clipping ? 'rgba(245, 108, 108, 0.85)' : 'rgba(64, 158, 255, 0.85)'
    for (let k = firstColumn; k <= lastColumn; k++) {
      const x = timeToX(k * col, vp)
      if (x + pxPerColumn < left || x > right) continue
      const ringIndex = (k % columnCount.value) * 2
      const min = buffer[ringIndex] ?? 0
      const max = buffer[ringIndex + 1] ?? 0
      const yTop = amplitudeToY(max, midY, halfHeight)
      const yBottom = amplitudeToY(min, midY, halfHeight)
      context.fillRect(x, yTop, pxPerColumn, Math.max(1, yBottom - yTop))
    }
  }

  // 时间标尺：每秒一根刻度（窗口 ≤ 5 s 时每 500 ms 一根）
  if (props.showRuler) {
    const tickMs = props.windowMs <= 5000 ? 500 : 1000
    const startTick = Math.floor(vp.scrollMs / tickMs) * tickMs
    const endMs = vp.scrollMs + props.windowMs
    context.strokeStyle = 'rgba(144, 147, 153, 0.28)'
    context.fillStyle = 'rgba(144, 147, 153, 0.95)'
    context.font = '10px system-ui, sans-serif'
    for (let t = startTick; t <= endMs; t += tickMs) {
      const x = timeToX(t, vp)
      if (x < left || x > right) continue
      context.beginPath()
      context.moveTo(x, height - 14)
      context.lineTo(x, height - 8)
      context.stroke()
      context.fillText(formatRuler(t), x + 2, height - 3)
    }
  }

  // 削波条：docs/12 §3.3 要求「必须让用户立刻知道」
  if (props.clipping) {
    context.fillStyle = 'rgba(245, 108, 108, 0.9)'
    context.fillRect(left, 0, right - left, 2)
  }
}

function formatRuler(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`
}

const bounds = computed<Rect>(() => ({ x: 0, y: 0, w: widthPx.value, h: canvasHeight.value }))

/** 一帧：滚动（拷贝自身左移）+ 只重画右侧脏条 */
function renderFrame(): void {
  rafId = globalThis.requestAnimationFrame(renderFrame)
  syncCanvasSize()
  if (!context) return

  const vp = viewport.value
  const nowMs = writtenColumns * COLUMN_MS

  if (needsFullRedraw) {
    needsFullRedraw = false
    if (!writtenColumns) {
      drawEmpty()
      renderedNowMs = 0
      return
    }
    drawRegion(0, widthPx.value)
    renderedNowMs = nowMs
    return
  }

  if (props.paused || !props.active) return
  if (!writtenColumns) return

  const shiftPx = (nowMs - renderedNowMs) * vp.pxPerMs
  if (shiftPx < 1) return

  const wholeShift = Math.floor(shiftPx)
  // 画布自身左移：等价于把已有波形整体向左推（比重新画全屏便宜得多）
  context.save()
  context.globalCompositeOperation = 'copy'
  context.drawImage(canvasRef.value as HTMLCanvasElement, -wholeShift, 0)
  context.restore()

  const fromMs = renderedNowMs + (wholeShift / vp.pxPerMs)
  const dirty = timeRangeToDirtyRect({
    fromMs,
    toMs: nowMs,
    viewport: vp,
    y: 0,
    h: canvasHeight.value,
    bounds: bounds.value,
    pad: 4,
  })
  // computeDirtyRect 保证不越界，并且极小变化直接判定为「无需重绘」
  const rect = computeDirtyRect(null, dirty, bounds.value, 2)
  if (rect) drawRegion(rect.x, rect.x + rect.w)
  renderedNowMs = fromMs
}

onMounted(() => {
  rebuildRing()
  syncCanvasSize()
  drawEmpty()
  rafId = globalThis.requestAnimationFrame(renderFrame)
})

// 窗口长度变化 → 重建环形缓冲（列数变了）并整屏重绘
watch(
  () => props.windowMs,
  () => {
    rebuildRing()
    needsFullRedraw = true
  },
)

onBeforeUnmount(() => {
  if (rafId !== null) globalThis.cancelAnimationFrame(rafId)
  rafId = null
})

// 窗口长度变化 → 重建环形缓冲并整屏重绘
function onWindowChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  if (!Number.isFinite(value) || value <= 0) return
  emit('window-change', value)
}

defineExpose({ pushBlock, reset, showPeaks, clearTake })
</script>

<template>
  <div ref="containerRef" class="ns-wave">
    <header class="ns-wave__head">
      <span class="ns-wave__title">{{ takeMode ? '当前 take 波形' : '实时波形' }}</span>
      <span class="ns-wave__meta">{{ formatSampleRate(sampleRate) }} · 每列 5 ms</span>
      <span class="ns-wave__meta">
        {{ takeMode ? `take 时长 ${(takeTotalMs / 1000).toFixed(1)} s` : `已录 ${(elapsedMs / 1000).toFixed(1)} s` }}
      </span>
      <span v-if="clipping" class="ns-wave__meta ns-wave__meta--bad">削波</span>
      <span v-else-if="active && !paused" class="ns-wave__meta ns-wave__meta--live">采集流</span>
      <label class="ns-wave__field">
        <span>窗口</span>
        <select :value="windowMs" @change="onWindowChange">
          <option v-for="choice in WINDOW_CHOICES" :key="choice" :value="choice">{{ choice / 1000 }} s</option>
        </select>
      </label>
    </header>

    <canvas ref="canvasRef" class="ns-wave__canvas" :style="{ height: `${canvasHeight}px` }" />

    <footer class="ns-wave__foot">
      <span v-if="paused">已暂停：波形停止滚动（暂停期间不写盘）</span>
      <span v-else-if="takeMode">显示选中／刚录制的 take 波形；没有 take 时这里为空</span>
      <span v-else-if="!active">未录音：显示上一次会话留下的波形</span>
      <span v-else>滚动显示最近 {{ windowMs / 1000 }} 秒；总时长 {{ (durationMs / 1000).toFixed(1) }} s</span>
    </footer>
  </div>
</template>

<style scoped>
.ns-wave {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-wave__head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-wave__title {
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-wave__meta--bad {
  color: var(--ns-danger, #f56c6c);
  font-weight: 600;
}
.ns-wave__meta--live {
  color: var(--ns-success, #67c23a);
}
.ns-wave__field {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  margin-left: auto;
}
.ns-wave__field select {
  padding: 2px 6px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  font-size: 12px;
}
.ns-wave__canvas {
  display: block;
  width: 100%;
  border-radius: 4px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-wave__foot {
  font-size: 11px;
  color: var(--ns-text-secondary, #909399);
}
</style>
