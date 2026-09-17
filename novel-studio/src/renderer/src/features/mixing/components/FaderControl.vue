<!--
  Novel Studio · 参数/推子控件（docs/14 §4.3 五要素的 ①②③，docs/15 §9 通道条推子）
  ============================================================================
  为什么把「推子」和「参数滑块」做成同一个组件：
    docs/14 §4.3 要求**每个参数**都有
      ① 滑块 + 数字输入（精确输入很重要，不能只有滑块）
      ② 单位与范围提示
      ③ 双击滑块恢复默认值
    而混音台的通道条推子（docs/15 §9 FaderControl）本来就要求「dB 刻度 + 双击归零」。
    两者是同一个交互，只是一个竖向（通道条）、一个横向（参数行）。
    做成两个组件必然导致「双击行为不一致」「数字输入精度不一致」这类问题，
    所以这里用一个组件 + orientation 覆盖两种用法。

  与 Element Plus 的分工：
    · 滑块自己实现 —— el-slider 没有竖向 dB 刻度模式，也拿不到「双击复原」这种语义；
      自绘还顺手解决了「拖动时不要每像素都 setState」（指针移动里做量化后再 emit）。
    · 数字输入用 el-input-number —— 精确输入、步进、范围钳制都是它的强项，不该重造。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: number
  min: number
  max: number
  /** 量化步长（拖动与键盘都按它对齐） */
  step?: number
  /** ③ 双击滑块恢复到这个默认值 */
  defaultValue: number
  label?: string
  /** ② 单位（dB / ms / Hz / ×…）；空串表示无量纲（如 Q、强度 0~1） */
  unit?: string
  /** ② 单位与范围提示，例如「降噪量 0.01~97 dB，建议 6~18」 */
  hint?: string
  precision?: number
  orientation?: 'vertical' | 'horizontal'
  /** 竖向时的高度（px） */
  height?: number
  disabled?: boolean
  /** 禁用原因（docs/14 §3.1：控件不可用时必须说明原因） */
  disabledReason?: string
  /** 竖向推子的刻度（dB 刻度习惯：-60/-40/-20/-12/-6/0） */
  scaleTicks?: number[]
  /** 紧凑模式（通道条内） */
  compact?: boolean
}>(), {
  step: 0.1,
  unit: '',
  hint: '',
  precision: 2,
  orientation: 'horizontal',
  height: 140,
  disabled: false,
  disabledReason: '',
  scaleTicks: () => [],
  compact: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: number]
  /** 提交（拖动结束 / 数字输入确认 / 键盘操作）——用于触发防抖落库或预览 */
  change: [value: number]
  /** ③ 双击复原被触发 */
  reset: [value: number]
}>()

const trackRef = ref<HTMLElement | null>(null)
const dragging = ref(false)

const span = computed(() => {
  const value = props.max - props.min
  return value > 0 ? value : 1
})

const ratio = computed(() => Math.min(1, Math.max(0, (props.modelValue - props.min) / span.value)))

/** 量化到步长并夹到范围内（保留精度，避免 0.30000000000000004 这种值写进处理链） */
function quantize(value: number): number {
  const step = props.step > 0 ? props.step : 0.1
  const snapped = Math.round((value - props.min) / step) * step + props.min
  const clamped = Math.min(props.max, Math.max(props.min, snapped))
  return Number(clamped.toFixed(props.precision))
}

function valueFromPointer(event: PointerEvent): number {
  const el = trackRef.value
  if (!el) return props.modelValue
  const rect = el.getBoundingClientRect()
  const raw = props.orientation === 'vertical'
    ? 1 - (event.clientY - rect.top) / Math.max(1, rect.height)
    : (event.clientX - rect.left) / Math.max(1, rect.width)
  const clamped = Math.min(1, Math.max(0, raw))
  return quantize(props.min + clamped * span.value)
}

function commit(next: number, withChange = true): void {
  if (next !== props.modelValue) emit('update:modelValue', next)
  if (withChange) emit('change', next)
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  dragging.value = true
  const target = event.currentTarget as HTMLElement | null
  target?.setPointerCapture?.(event.pointerId)
  const next = valueFromPointer(event)
  if (next !== props.modelValue) emit('update:modelValue', next)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value || props.disabled) return
  const next = valueFromPointer(event)
  if (next !== props.modelValue) emit('update:modelValue', next)
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  const target = event.currentTarget as HTMLElement | null
  target?.releasePointerCapture?.(event.pointerId)
  emit('change', props.modelValue)
}

/** ③ 双击复原（docs/14 §4.3 第 3 条） */
function onDoubleClick(): void {
  if (props.disabled) return
  const next = quantize(props.defaultValue)
  emit('update:modelValue', next)
  emit('change', next)
  emit('reset', next)
}

/** 键盘可用：滑块必须能用方向键调（拖不动的用户与精确微调都靠它） */
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  const big = props.step * 10
  let next: number | null = null
  switch (event.key) {
    case 'ArrowUp': case 'ArrowRight': next = props.modelValue + props.step; break
    case 'ArrowDown': case 'ArrowLeft': next = props.modelValue - props.step; break
    case 'PageUp': next = props.modelValue + big; break
    case 'PageDown': next = props.modelValue - big; break
    case 'Home': next = props.min; break
    case 'End': next = props.max; break
    case 'Enter': next = props.defaultValue; break
    default: return
  }
  event.preventDefault()
  commit(quantize(next))
}

function onNumberChange(value: number | undefined): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  commit(quantize(value))
}

/** 竖向拖到底时用满高度，横向用百分比宽度 */
const fillStyle = computed(() => (props.orientation === 'vertical'
  ? { height: `${ratio.value * 100}%` }
  : { width: `${ratio.value * 100}%` }))

const knobStyle = computed(() => (props.orientation === 'vertical'
  ? { bottom: `calc(${ratio.value * 100}% - 6px)` }
  : { left: `calc(${ratio.value * 100}% - 6px)` }))

function tickStyle(tick: number): Record<string, string> {
  const value = Math.min(1, Math.max(0, (tick - props.min) / span.value))
  return props.orientation === 'vertical'
    ? { bottom: `calc(${value * 100}% - 1px)` }
    : { left: `calc(${value * 100}% - 1px)` }
}

const title = computed(() => {
  if (props.disabled && props.disabledReason) return props.disabledReason
  return props.hint || `${props.label ?? ''} ${props.min}~${props.max} ${props.unit}`.trim()
})
</script>

<template>
  <div
    class="ns-fader"
    :class="[`ns-fader--${orientation}`, { 'is-compact': compact, 'is-disabled': disabled }]"
  >
    <div v-if="label" class="ns-fader__label">{{ label }}</div>

    <!-- ① 滑块（自绘：支持竖向 dB 刻度 + 双击复原 + 键盘） -->
    <div
      ref="trackRef"
      class="ns-fader__track"
      :class="{ 'is-dragging': dragging }"
      :style="orientation === 'vertical' ? { height: `${height}px` } : undefined"
      role="slider"
      :tabindex="disabled ? -1 : 0"
      :aria-label="label || '参数'"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="modelValue"
      :aria-disabled="disabled"
      :title="title"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
      @keydown="onKeydown"
    >
      <span class="ns-fader__fill" :style="fillStyle" />
      <span class="ns-fader__knob" :style="knobStyle" />
      <span
        v-for="tick in scaleTicks"
        :key="tick"
        class="ns-fader__tick"
        :style="tickStyle(tick)"
        :title="String(tick)"
      />
    </div>

    <!-- ① 数字输入（精确输入；docs/14 §4.3 明确「不能只有滑块」） -->
    <div class="ns-fader__value">
      <el-input-number
        :model-value="modelValue"
        :min="min"
        :max="max"
        :step="step"
        :precision="precision"
        :disabled="disabled"
        :controls-position="orientation === 'vertical' ? 'right' : 'right'"
        size="small"
        class="ns-fader__input"
        @change="onNumberChange"
      />
      <span v-if="unit" class="ns-fader__unit">{{ unit }}</span>
    </div>

    <p v-if="hint" class="ns-fader__hint">{{ hint }}</p>
    <p v-if="disabled && disabledReason" class="ns-fader__hint ns-fader__hint--blocked">
      {{ disabledReason }}
    </p>
  </div>
</template>

<style scoped>
.ns-fader {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ns-fader--vertical {
  align-items: center;
}
.ns-fader__label {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-fader__track {
  position: relative;
  flex: 0 0 auto;
  border-radius: 4px;
  background: var(--ns-fill, #ebeef5);
  cursor: pointer;
  outline: none;
  touch-action: none;
}
.ns-fader--horizontal .ns-fader__track {
  width: 100%;
  min-width: 90px;
  height: 12px;
}
.ns-fader--vertical .ns-fader__track {
  width: 14px;
}
.ns-fader__track:focus-visible {
  box-shadow: 0 0 0 2px rgb(64 158 255 / 45%);
}
.ns-fader.is-disabled .ns-fader__track {
  cursor: not-allowed;
  opacity: 0.55;
}
.ns-fader__fill {
  position: absolute;
  border-radius: 4px;
  background: linear-gradient(90deg, rgb(64 158 255 / 65%), var(--ns-primary, #409eff));
}
.ns-fader--horizontal .ns-fader__fill {
  top: 0;
  bottom: 0;
  left: 0;
}
.ns-fader--vertical .ns-fader__fill {
  right: 0;
  bottom: 0;
  left: 0;
  background: linear-gradient(0deg, rgb(64 158 255 / 65%), var(--ns-primary, #409eff));
}
.ns-fader__knob {
  position: absolute;
  width: 12px;
  height: 12px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--ns-primary, #409eff);
  box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
}
.ns-fader--horizontal .ns-fader__knob {
  top: 0;
}
.ns-fader--vertical .ns-fader__knob {
  left: 1px;
}
.ns-fader__tick {
  position: absolute;
  background: rgb(0 0 0 / 22%);
}
.ns-fader--horizontal .ns-fader__tick {
  top: 0;
  bottom: 0;
  width: 1px;
}
.ns-fader--vertical .ns-fader__tick {
  right: 0;
  left: 0;
  height: 1px;
}
.ns-fader__value {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ns-fader__input {
  width: 100%;
  min-width: 84px;
}
.ns-fader__unit {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  white-space: nowrap;
}
.ns-fader__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.5;
}
.ns-fader__hint--blocked {
  color: var(--ns-warning, #e6a23c);
}
.ns-fader.is-compact .ns-fader__hint {
  display: none;
}
</style>
