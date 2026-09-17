<!--
  Novel Studio · EQ 频率响应曲线（docs/14 §4.3 第 4 条「EQ 响应曲线可视化」）
  ============================================================================
  为什么必须自己画曲线：
    EQ 是唯一「参数对了但听感不对」最难自查的模块。数字（250 Hz / -2 dB / Q1）
    看不出「整体是不是把 200~400 Hz 挖空了」，而一条曲线一眼就能看出来。

  幅频响应公式（全部按 RBJ Audio EQ Cookbook，参考采样率固定 48 kHz，
  与内部工作格式一致，见 docs/14 §3.2）：
    · 通用：w0 = 2π·f0/Fs，|H(f)| = |b0 + b1·e^-jw + b2·e^-2jw| / |a0 + a1·e^-jw + a2·e^-2jw|
      其中 w = 2π·f/Fs；曲线画的是 20·log10|H|。
    · peak（峰值/钟形）：A = 10^(dB/40)，alpha = sin(w0)/(2Q)
        b0 = 1 + alpha·A   b1 = -2cos(w0)   b2 = 1 - alpha·A
        a0 = 1 + alpha/A   a1 = -2cos(w0)   a2 = 1 - alpha/A
    · lowshelf（低架，S=1）：A = 10^(dB/40)，alpha = sin(w0)/2·√2
        b0 = A·((A+1) - (A-1)cos(w0) + 2√A·alpha)
        b1 = 2A·((A-1) - (A+1)cos(w0))
        b2 = A·((A+1) - (A-1)cos(w0) - 2√A·alpha)
        a0 = (A+1) + (A-1)cos(w0) + 2√A·alpha
        a1 = -2((A-1) + (A+1)cos(w0))
        a2 = (A+1) + (A-1)cos(w0) - 2√A·alpha
    · highshelf（高架）：把 lowshelf 的 b0/b1/b2 取镜像写法（＋号与－号对调）：
        b0 = A·((A+1) + (A-1)cos(w0) + 2√A·alpha)
        b1 = -2A·((A-1) + (A+1)cos(w0))
        b2 = A·((A+1) + (A-1)cos(w0) - 2√A·alpha)
        a0 = (A+1) - (A-1)cos(w0) + 2√A·alpha
        a1 = 2((A-1) - (A+1)cos(w0))
        a2 = (A+1) - (A-1)cos(w0) - 2√A·alpha
    · lowpass：alpha = sin(w0)/(2Q)
        b0 = (1-cos w0)/2  b1 = 1-cos w0  b2 = b0   a0 = 1+alpha  a1 = -2cos w0  a2 = 1-alpha
    · highpass：
        b0 = (1+cos w0)/2  b1 = -(1+cos w0)  b2 = b0   a0 = 1+alpha  a1 = -2cos w0  a2 = 1-alpha
    多段叠加时把各段的 dB 相加（工程上常用的近似；只在带宽重叠严重时略有偏差）。

  交互（与 docs/14 §10 的「同一位置切换」配合使用）：
    · 拖动控制点 = 改 freq/gain（横向对数轴、纵向 dB）
    · 滚轮 = 改 Q
    · 双击控制点 = 启用/停用；双击空白 = 新增峰值点
    · 右键控制点 / 选中后按 Delete = 删除
  组件本身**无状态**（受控组件）：所有改动 emit 给父级，由 store 的 patchEqBand 落地，
  这样「拖动过程中不写库、松手才提交」的策略可以完全由父级控制。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EqBand } from '@shared/types.ts'
import { prepareCanvas } from '../composables/useMeter.ts'

const props = withDefaults(defineProps<{
  bands: EqBand[]
  /** 画布高度（正比于可读性，主编辑器给 220，概览给 110） */
  height?: number
  /** 只读（主控区的 EQ 概览用它，不允许改参数） */
  readonly?: boolean
  selectedId?: string | null
}>(), {
  height: 220,
  readonly: false,
  selectedId: null,
})

const emit = defineEmits<{
  'select-band': [id: string]
  'update-band': [id: string, patch: Partial<EqBand>]
  'toggle-band': [id: string]
  'remove-band': [id: string]
  'add-band': [freq: number, gainDb: number]
}>()

/** 参考采样率：内部工作格式恒为 48 kHz（docs/14 §3.2） */
const FS = 48000
const F_MIN = 20
const F_MAX = 20000
const DB_MIN = -18
const DB_MAX = 18
/** 绘图内边距（左留给 dB 刻度、下留给频率刻度） */
const PAD = { left: 36, right: 14, top: 12, bottom: 20 }
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const DB_TICKS = [-18, -12, -6, 0, 6, 12, 18]
/** 控制点命中半径（px） */
const HIT_RADIUS = 11

const TYPE_LABELS: Record<EqBand['type'], string> = {
  peak: '峰值',
  lowshelf: '低架',
  highshelf: '高架',
  lowpass: '低通',
  highpass: '高通',
}

const canvasRef = ref<HTMLCanvasElement | null>(null)
const hoverId = ref<string | null>(null)
const size = ref({ width: 520, height: props.height })
let draggingId: string | null = null
let detachResize: (() => void) | null = null

// ── 坐标换算 ────────────────────────────────────────────────────────────────
const plot = computed(() => ({
  left: PAD.left,
  top: PAD.top,
  width: Math.max(40, size.value.width - PAD.left - PAD.right),
  height: Math.max(40, size.value.height - PAD.top - PAD.bottom),
}))

const logSpan = Math.log(F_MAX / F_MIN)

function xOfFreq(freq: number): number {
  const ratio = Math.log(Math.min(F_MAX, Math.max(F_MIN, freq)) / F_MIN) / logSpan
  return plot.value.left + ratio * plot.value.width
}

function freqOfX(x: number): number {
  const ratio = (x - plot.value.left) / plot.value.width
  const freq = F_MIN * Math.exp(Math.min(1, Math.max(0, ratio)) * logSpan)
  return Math.round(Math.min(F_MAX, Math.max(F_MIN, freq)))
}

function yOfDb(db: number): number {
  const ratio = (DB_MAX - Math.min(DB_MAX, Math.max(DB_MIN, db))) / (DB_MAX - DB_MIN)
  return plot.value.top + ratio * plot.value.height
}

function dbOfY(y: number): number {
  const ratio = (y - plot.value.top) / plot.value.height
  const db = DB_MAX - Math.min(1, Math.max(0, ratio)) * (DB_MAX - DB_MIN)
  return Math.round(db * 10) / 10
}

// ── 幅频响应（公式见文件头）─────────────────────────────────────────────────
interface Biquad { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }

function qOf(band: EqBand): number {
  return Math.max(0.1, Math.min(10, band.q))
}

function coefficients(band: EqBand): Biquad | null {
  const f0 = Math.min(FS / 2 - 1, Math.max(10, band.freq))
  const w0 = (2 * Math.PI * f0) / FS
  const cos0 = Math.cos(w0)
  const sin0 = Math.sin(w0)
  const q = qOf(band)
  const alpha = sin0 / (2 * q)
  const A = Math.pow(10, band.gainDb / 40)
  const sqrtA = Math.sqrt(A)

  switch (band.type) {
    case 'peak':
      return {
        b0: 1 + alpha * A, b1: -2 * cos0, b2: 1 - alpha * A,
        a0: 1 + alpha / A, a1: -2 * cos0, a2: 1 - alpha / A,
      }
    case 'lowshelf': {
      // S = 1 → alpha = sin(w0)/2 · √2
      const sa = (sin0 / 2) * Math.SQRT2
      return {
        b0: A * ((A + 1) - (A - 1) * cos0 + 2 * sqrtA * sa),
        b1: 2 * A * ((A - 1) - (A + 1) * cos0),
        b2: A * ((A + 1) - (A - 1) * cos0 - 2 * sqrtA * sa),
        a0: (A + 1) + (A - 1) * cos0 + 2 * sqrtA * sa,
        a1: -2 * ((A - 1) + (A + 1) * cos0),
        a2: (A + 1) + (A - 1) * cos0 - 2 * sqrtA * sa,
      }
    }
    case 'highshelf': {
      const sa = (sin0 / 2) * Math.SQRT2
      return {
        b0: A * ((A + 1) + (A - 1) * cos0 + 2 * sqrtA * sa),
        b1: -2 * A * ((A - 1) + (A + 1) * cos0),
        b2: A * ((A + 1) + (A - 1) * cos0 - 2 * sqrtA * sa),
        a0: (A + 1) - (A - 1) * cos0 + 2 * sqrtA * sa,
        a1: 2 * ((A - 1) - (A + 1) * cos0),
        a2: (A + 1) - (A - 1) * cos0 - 2 * sqrtA * sa,
      }
    }
    case 'lowpass': {
      const b0 = (1 - cos0) / 2
      return { b0, b1: 1 - cos0, b2: b0, a0: 1 + alpha, a1: -2 * cos0, a2: 1 - alpha }
    }
    case 'highpass': {
      const b0 = (1 + cos0) / 2
      return { b0, b1: -(1 + cos0), b2: b0, a0: 1 + alpha, a1: -2 * cos0, a2: 1 - alpha }
    }
    default:
      return null
  }
}

function magnitudeDb(coeff: Biquad, freq: number): number {
  const w = (2 * Math.PI * freq) / FS
  const cos1 = Math.cos(w)
  const sin1 = Math.sin(w)
  const cos2 = Math.cos(2 * w)
  const sin2 = Math.sin(2 * w)
  const numRe = coeff.b0 + coeff.b1 * cos1 + coeff.b2 * cos2
  const numIm = -(coeff.b1 * sin1 + coeff.b2 * sin2)
  const denRe = coeff.a0 + coeff.a1 * cos1 + coeff.a2 * cos2
  const denIm = -(coeff.a1 * sin1 + coeff.a2 * sin2)
  const den = Math.hypot(denRe, denIm)
  if (den < 1e-12) return 0
  return 20 * Math.log10(Math.max(1e-6, Math.hypot(numRe, numIm) / den))
}

/** 所有启用频段叠加后的响应（dB），freqs 为采样点频率列表 */
function responseAt(freqs: number[]): number[] {
  const out = new Array<number>(freqs.length).fill(0)
  for (const band of props.bands) {
    if (!band.enabled) continue
    const coeff = coefficients(band)
    if (!coeff) continue
    for (let i = 0; i < freqs.length; i += 1) out[i] = (out[i] ?? 0) + magnitudeDb(coeff, freqs[i] ?? F_MIN)
  }
  return out
}

/** 采样点：对数轴上等距 240 点（够平滑，也不至于每帧算太多） */
const SAMPLE_FREQS = Array.from({ length: 240 }, (_, index) => {
  const ratio = index / 239
  return F_MIN * Math.exp(ratio * logSpan)
})

// ── 绘制 ────────────────────────────────────────────────────────────────────
function draw(): void {
  const frame = prepareCanvas(canvasRef.value)
  if (!frame) return
  const { ctx, width, height } = frame
  size.value = { width, height }

  const box = plot.value
  ctx.clearRect(0, 0, width, height)

  // 背景 + 绘图区
  ctx.fillStyle = 'rgba(0, 0, 0, 0.02)'
  ctx.fillRect(box.left, box.top, box.width, box.height)

  // 网格与刻度
  ctx.font = '10px ui-monospace, Consolas, monospace'
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)'
  ctx.lineWidth = 1
  for (const db of DB_TICKS) {
    const y = Math.round(yOfDb(db)) + 0.5
    ctx.beginPath()
    ctx.moveTo(box.left, y)
    ctx.lineTo(box.left + box.width, y)
    ctx.stroke()
    ctx.fillStyle = db === 0 ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.35)'
    ctx.textAlign = 'right'
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, box.left - 4, y)
  }
  for (const freq of FREQ_TICKS) {
    const x = Math.round(xOfFreq(freq)) + 0.5
    ctx.strokeStyle = freq === 1000 ? 'rgba(64, 158, 255, 0.28)' : 'rgba(0, 0, 0, 0.08)'
    ctx.beginPath()
    ctx.moveTo(x, box.top)
    ctx.lineTo(x, box.top + box.height)
    ctx.stroke()
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`
    ctx.fillText(label, x, box.top + box.height + 4)
  }
  ctx.textBaseline = 'middle'

  // 单段曲线（细、半透明）：让用户看清是哪一段抬/削的
  for (const band of props.bands) {
    if (!band.enabled) continue
    const coeff = coefficients(band)
    if (!coeff) continue
    ctx.strokeStyle = band.id === props.selectedId ? 'rgba(64, 158, 255, 0.55)' : 'rgba(120, 120, 120, 0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    SAMPLE_FREQS.forEach((freq, index) => {
      const x = xOfFreq(freq)
      const y = yOfDb(magnitudeDb(coeff, freq))
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // 总曲线（粗）
  const total = responseAt(SAMPLE_FREQS)
  const gradient = ctx.createLinearGradient(box.left, 0, box.left + box.width, 0)
  gradient.addColorStop(0, '#409eff')
  gradient.addColorStop(1, '#67c23a')
  ctx.strokeStyle = props.readonly ? 'rgba(64, 158, 255, 0.6)' : gradient
  ctx.lineWidth = 2
  ctx.beginPath()
  total.forEach((db, index) => {
    const x = xOfFreq(SAMPLE_FREQS[index] ?? F_MIN)
    const y = yOfDb(db)
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()

  // 0 dB 基准线
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  const zeroY = Math.round(yOfDb(0)) + 0.5
  ctx.moveTo(box.left, zeroY)
  ctx.lineTo(box.left + box.width, zeroY)
  ctx.stroke()
  ctx.setLineDash([])

  // 控制点
  for (const band of props.bands) {
    const x = xOfFreq(band.freq)
    const y = yOfDb(band.gainDb)
    const selected = band.id === props.selectedId
    const hovered = band.id === hoverId.value
    ctx.beginPath()
    ctx.arc(x, y, selected ? 6 : hovered ? 5.5 : 4.5, 0, Math.PI * 2)
    ctx.fillStyle = !band.enabled
      ? 'rgba(160, 160, 160, 0.75)'
      : band.gainDb > 0 ? '#e6a23c' : band.gainDb < 0 ? '#409eff' : '#909399'
    ctx.fill()
    ctx.strokeStyle = selected ? '#303133' : '#fff'
    ctx.lineWidth = selected ? 2 : 1.5
    ctx.stroke()
  }
}

// ── 命中测试与交互 ──────────────────────────────────────────────────────────
function localPoint(event: PointerEvent | MouseEvent | WheelEvent): { x: number; y: number } | null {
  const canvas = canvasRef.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function hitTest(x: number, y: number): EqBand | null {
  let best: EqBand | null = null
  let bestDistance = HIT_RADIUS
  for (const band of props.bands) {
    const distance = Math.hypot(xOfFreq(band.freq) - x, yOfDb(band.gainDb) - y)
    if (distance <= bestDistance) {
      best = band
      bestDistance = distance
    }
  }
  return best
}

function onPointerDown(event: PointerEvent): void {
  if (props.readonly) return
  const point = localPoint(event)
  if (!point) return
  const hit = hitTest(point.x, point.y)
  if (!hit) return
  draggingId = hit.id
  emit('select-band', hit.id)
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event)
  if (!point) return
  if (props.readonly) return

  if (draggingId) {
    const band = props.bands.find(item => item.id === draggingId)
    if (!band) return
    // 方向键式微调：按住 Shift 时只改频率（避免「手一抖 dB 也跑了」）
    const freq = freqOfX(point.x)
    const gainDb = event.shiftKey ? band.gainDb : dbOfY(point.y)
    emit('update-band', band.id, { freq, gainDb })
    return
  }
  const hit = hitTest(point.x, point.y)
  hoverId.value = hit ? hit.id : null
}

function endDrag(event: PointerEvent): void {
  if (!draggingId) return
  draggingId = null
  ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)
}

function onDoubleClick(event: MouseEvent): void {
  if (props.readonly) return
  const point = localPoint(event)
  if (!point) return
  const hit = hitTest(point.x, point.y)
  if (hit) {
    emit('toggle-band', hit.id)
    return
  }
  // 双击空白 = 新增峰值点（就地取频率/增益，新增后可直接拖到位）
  emit('add-band', freqOfX(point.x), dbOfY(point.y))
}

function onContextMenu(event: MouseEvent): void {
  if (props.readonly) return
  const point = localPoint(event)
  if (!point) return
  const hit = hitTest(point.x, point.y)
  if (!hit) return
  event.preventDefault()
  emit('remove-band', hit.id)
}

function onWheel(event: WheelEvent): void {
  if (props.readonly) return
  const point = localPoint(event)
  if (!point) return
  const hit = hitTest(point.x, point.y)
    ?? props.bands.find(item => item.id === props.selectedId)
    ?? null
  if (!hit) return
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.1 : 0.1
  const q = Math.round(Math.min(10, Math.max(0.1, qOf(hit) + delta)) * 100) / 100
  emit('update-band', hit.id, { q })
}

/** 键盘：Delete/Backspace 删除选中点；E 切换启用（与右键、双击等价的可达路径） */
function onKeydown(event: KeyboardEvent): void {
  if (props.readonly) return
  const band = props.bands.find(item => item.id === props.selectedId)
  if (!band) return
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    emit('remove-band', band.id)
  } else if (event.key === 'e' || event.key === 'E') {
    emit('toggle-band', band.id)
  }
}

/** 悬停读数：把鼠标位置的频率/总响应显示出来（截图汇报、对着 EQ 讲解时都用得上） */
const hoverReadout = computed(() => {
  const band = props.bands.find(item => item.id === (hoverId.value ?? props.selectedId))
  if (!band) return null
  return `${TYPE_LABELS[band.type]} ${band.freq} Hz · ${band.gainDb > 0 ? '+' : ''}${band.gainDb} dB · Q ${band.q}`
})

onMounted(() => {
  draw()
  const canvas = canvasRef.value
  if (canvas && typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => { draw() })
    observer.observe(canvas)
    detachResize = () => { observer.disconnect() }
  }
  window.addEventListener('resize', draw)
})

onBeforeUnmount(() => {
  detachResize?.()
  window.removeEventListener('resize', draw)
})

watch(() => [props.bands, props.selectedId, props.readonly, props.height], () => {
  if (canvasRef.value) canvasRef.value.style.height = `${props.height}px`
  draw()
}, { deep: true })
</script>

<template>
  <div class="ns-eq" :class="{ 'is-readonly': props.readonly }">
    <canvas
      ref="canvasRef"
      class="ns-eq__canvas"
      :style="{ height: `${props.height}px` }"
      :tabindex="props.readonly ? -1 : 0"
      role="img"
      :aria-label="`EQ 频率响应曲线，共 ${props.bands.length} 段`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @pointerleave="hoverId = null"
      @dblclick="onDoubleClick"
      @contextmenu="onContextMenu"
      @wheel="onWheel"
      @keydown="onKeydown"
    />

    <p v-if="!props.readonly" class="ns-eq__tips">
      拖动控制点改频率/增益（按住 Shift 只改频率）· 滚轮改 Q · 双击控制点启用/停用 ·
      双击空白新增峰值点 · 右键或 Delete 删除
    </p>
    <p v-else class="ns-eq__tips ns-eq__tips--ro">只读概览：到处理链编辑器里调整 EQ</p>

    <p v-if="hoverReadout" class="ns-eq__readout">{{ hoverReadout }}</p>
    <p v-else-if="!props.bands.length" class="ns-eq__empty">
      还没有 EQ 频段：在处理链编辑器里点「新增频段」，或直接在本区域双击空白处
    </p>
  </div>
</template>

<style scoped>
.ns-eq {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-eq__canvas {
  display: block;
  width: 100%;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 6px;
  background: var(--ns-bg-elevated, #fff);
  cursor: crosshair;
  outline: none;
}
.ns-eq__canvas:focus-visible {
  border-color: var(--ns-primary, #409eff);
}
.is-readonly .ns-eq__canvas {
  cursor: default;
}
.ns-eq__tips {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.5;
}
.ns-eq__tips--ro {
  opacity: 0.8;
}
.ns-eq__readout {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font: 11px/1.5 ui-monospace, Consolas, monospace;
}
.ns-eq__empty {
  margin: 0;
  color: var(--ns-warning, #e6a23c);
  font-size: 11px;
}
</style>
