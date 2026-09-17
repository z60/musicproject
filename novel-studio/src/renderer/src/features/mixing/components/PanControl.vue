<!--
  Novel Studio · 声像控制（docs/15 §9 通道条 PanControl）
  ============================================================================
  设计要点：
    · 声像范围 -1（全左）~ +1（全右），0 为中置（MixTrack.pan，docs/15 §2）。
    · **必须有中置吸附**：手动把 pan 停在 -0.02 会让整轨听感偏一点却查不出来，
      所以 |pan| < 0.05 一律吸附到 0，并在中置位置画一条显著的刻度线。
    · 双击 / 按 C / 按 Enter 复位到中置（与 FaderControl 的双击复原语义保持一致，
      见 docs/14 §4.3 第 3 条 —— 整个功能域内的「双击 = 复原默认值」必须统一）。
    · 显示成 L23 / C / R45 这种习惯写法，而不是裸数字 -0.23（调音台上没人这么念）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BusKind } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  modelValue: number
  disabled?: boolean
  disabledReason?: string
  label?: string
  /** 声音类型：music/sfx 轨默认提示「音乐一般保持中置」 */
  kind?: BusKind
  compact?: boolean
}>(), {
  disabled: false,
  disabledReason: '',
  label: '声像',
  kind: 'voice',
  compact: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: number]
  change: [value: number]
}>()

/** 中置吸附阈值（见文件头说明） */
const DETENT = 0.05

const trackRef = ref<HTMLElement | null>(null)
const dragging = ref(false)

const ratio = computed(() => (props.modelValue + 1) / 2)

const readout = computed(() => {
  const pan = props.modelValue
  if (Math.abs(pan) < DETENT) return 'C'
  const side = pan < 0 ? 'L' : 'R'
  return `${side}${Math.round(Math.abs(pan) * 100)}`
})

const hint = computed(() => (props.kind === 'voice'
  ? '声像 -1（全左）~ +1（全右）；双击或按 C 复位中置。旁白通常保持中置'
  : '声像 -1（全左）~ +1（全右）；BGM/音效一般保持中置，特殊情况才做偏移'))

function format(value: number): string {
  return value.toFixed(2)
}

function quantize(value: number): number {
  const clamped = Math.min(1, Math.max(-1, value))
  if (Math.abs(clamped) < DETENT) return 0
  return Number(clamped.toFixed(2))
}

function valueFromPointer(event: PointerEvent): number {
  const el = trackRef.value
  if (!el) return props.modelValue
  const rect = el.getBoundingClientRect()
  const raw = (event.clientX - rect.left) / Math.max(1, rect.width)
  return quantize(Math.min(1, Math.max(0, raw)) * 2 - 1)
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

function resetCenter(): void {
  if (props.disabled) return
  commit(0)
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  switch (event.key) {
    case 'ArrowLeft': event.preventDefault(); commit(quantize(props.modelValue - 0.05)); break
    case 'ArrowRight': event.preventDefault(); commit(quantize(props.modelValue + 0.05)); break
    case 'Home': event.preventDefault(); commit(-1); break
    case 'End': event.preventDefault(); commit(1); break
    case 'c': case 'C': case 'Enter': event.preventDefault(); commit(0); break
    default: break
  }
}
</script>

<template>
  <div class="ns-pan" :class="{ 'is-disabled': disabled, 'is-compact': compact }">
    <div class="ns-pan__head">
      <span class="ns-pan__label">{{ label }}</span>
      <span class="ns-pan__readout" :title="`pan = ${format(modelValue)}`">{{ readout }}</span>
      <button
        type="button"
        class="ns-pan__center"
        :disabled="disabled"
        title="复位中置（双击滑块亦可）"
        @click="resetCenter"
      >
        C
      </button>
    </div>

    <div
      ref="trackRef"
      class="ns-pan__track"
      role="slider"
      :tabindex="disabled ? -1 : 0"
      aria-label="声像"
      :aria-valuemin="-1"
      :aria-valuemax="1"
      :aria-valuenow="modelValue"
      :aria-disabled="disabled"
      :title="disabled && disabledReason ? disabledReason : hint"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="resetCenter"
      @keydown="onKeydown"
    >
      <span class="ns-pan__fill" :style="{ width: `${ratio * 100}%` }" />
      <span class="ns-pan__detent" />
      <span class="ns-pan__knob" :style="{ left: `calc(${ratio * 100}% - 5px)` }" />
      <span class="ns-pan__tick ns-pan__tick--left">L</span>
      <span class="ns-pan__tick ns-pan__tick--right">R</span>
    </div>

    <p v-if="disabled && disabledReason" class="ns-pan__hint ns-pan__hint--blocked">{{ disabledReason }}</p>
    <p v-else-if="!compact" class="ns-pan__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.ns-pan {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-pan__head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ns-pan__label {
  flex: 1;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-pan__readout {
  min-width: 34px;
  color: var(--ns-text-primary, #303133);
  font: 600 12px/1 ui-monospace, Consolas, monospace;
  text-align: right;
}
.ns-pan__center {
  padding: 0 5px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: #fff;
  color: var(--ns-text-regular, #606266);
  font-size: 10px;
  line-height: 16px;
  cursor: pointer;
}
.ns-pan__center:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.ns-pan__track {
  position: relative;
  height: 14px;
  border-radius: 4px;
  background: var(--ns-fill, #ebeef5);
  cursor: pointer;
  outline: none;
  touch-action: none;
}
.ns-pan.is-disabled .ns-pan__track {
  cursor: not-allowed;
  opacity: 0.55;
}
.ns-pan__track:focus-visible {
  box-shadow: 0 0 0 2px rgb(64 158 255 / 45%);
}
.ns-pan__fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 4px;
  background: rgb(64 158 255 / 45%);
}
.ns-pan__detent {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: rgb(0 0 0 / 35%);
}
.ns-pan__knob {
  position: absolute;
  top: 1px;
  width: 10px;
  height: 10px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--ns-primary, #409eff);
  box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
}
.ns-pan__tick {
  position: absolute;
  top: 50%;
  color: var(--ns-text-secondary, #909399);
  font-size: 9px;
  line-height: 1;
  transform: translateY(-50%);
}
.ns-pan__tick--left {
  left: 3px;
}
.ns-pan__tick--right {
  right: 3px;
}
.ns-pan__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.5;
}
.ns-pan__hint--blocked {
  color: var(--ns-warning, #e6a23c);
}
</style>
