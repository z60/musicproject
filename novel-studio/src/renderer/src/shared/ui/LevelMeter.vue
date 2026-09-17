<!--
  Novel Studio · 电平表（峰值 + 有效值 + 削波指示）
  ============================================================================
  设计依据：
    · docs/12 §10 —— LinePromptCard 区域要有 LevelMeter；「峰值+有效值，含削波指示」
    · docs/12 §6.1 —— 设备诊断页显示噪声底、峰值、是否削波
    · docs/15 §9   —— 混音台通道条与总线的表头（BusMeter 复用本组件）
    · docs/12 §3.3 —— 削波是「必须让用户立刻知道」的问题（RECORD_CLIPPING）

  实现要点：
    · 输入是 dBFS（-∞ ~ 0），显示映射到 [minDb, maxDb] 区间；
    · RMS 与 Peak 两条：RMS 粗（能量感），Peak 细（瞬时过载）；
    · 削波为**锁存**指示（一旦发生就亮，直到用户点击清除或重新开始录制），
      否则瞬时峰值一闪而过，用户根本看不到（docs/12 §3.3 的教训）。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { formatDb } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  /** 有效值（dBFS） */
  rmsDb?: number | null
  /** 峰值（dBFS） */
  peakDb?: number | null
  /** 是否发生削波（通常由 useLevelMeter 的锁存逻辑给出） */
  clipping?: boolean
  /** 显示范围下界 */
  minDb?: number
  /** 显示范围上界 */
  maxDb?: number
  orientation?: 'horizontal' | 'vertical'
  /** 竖向时的像素高度 */
  height?: number
  /** 显示标题与数字读数 */
  showReadout?: boolean
  label?: string
  /** 是否可点击清除削波锁存 */
  clearableClip?: boolean
}>(), {
  rmsDb: null,
  peakDb: null,
  clipping: false,
  minDb: -60,
  maxDb: 0,
  orientation: 'horizontal',
  height: 120,
  showReadout: true,
  label: '',
  clearableClip: true,
})

const emit = defineEmits<{
  /** 点击清除削波锁存 */
  clearClip: []
}>()

/** dBFS → 0~1 的显示比例；-∞ 归 0 */
function ratioOf(db: number | null | undefined): number {
  if (db === null || db === undefined) return 0
  if (db === Number.NEGATIVE_INFINITY) return 0
  if (!Number.isFinite(db)) return 0
  const span = props.maxDb - props.minDb
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (db - props.minDb) / span))
}

const rmsRatio = computed(() => ratioOf(props.rmsDb))
const peakRatio = computed(() => ratioOf(props.peakDb))

/** 颜色分区：>-6 dBFS 黄、>-1 dBFS 红（与录音设备的习惯刻度一致） */
const peakColor = computed(() => {
  const db = props.peakDb
  if (db === null || db === undefined || !Number.isFinite(db)) return 'var(--ns-success, #67c23a)'
  if (db >= -1) return 'var(--ns-danger, #f56c6c)'
  if (db >= -6) return 'var(--ns-warning, #e6a23c)'
  return 'var(--ns-success, #67c23a)'
})

const rmsText = computed(() => formatDb(props.rmsDb === Number.NEGATIVE_INFINITY ? null : props.rmsDb))
const peakText = computed(() => formatDb(props.peakDb))
</script>

<template>
  <div
    class="ns-meter"
    :class="[`ns-meter--${orientation}`, { 'is-clipping': clipping }]"
    :style="orientation === 'vertical' ? { height: `${height}px` } : undefined"
  >
    <div v-if="label" class="ns-meter__label">{{ label }}</div>

    <div class="ns-meter__track" :title="`峰值 ${peakText} / 有效值 ${rmsText}`">
      <!-- 峰值：底层细条 -->
      <div
        class="ns-meter__peak"
        :style="{
          background: peakColor,
          ...(orientation === 'vertical'
            ? { height: `${peakRatio * 100}%`, width: '100%' }
            : { width: `${peakRatio * 100}%`, height: '100%' }),
        }"
      />
      <!-- 有效值：上层粗条 -->
      <div
        class="ns-meter__rms"
        :style="orientation === 'vertical'
          ? { height: `${rmsRatio * 100}%`, width: '100%' }
          : { width: `${rmsRatio * 100}%`, height: '100%' }"
      />
      <!-- -6 dBFS 与 0 dBFS 参考线 -->
      <span class="ns-meter__tick ns-meter__tick--six" />
      <span class="ns-meter__tick ns-meter__tick--zero" />
    </div>

    <div v-if="showReadout" class="ns-meter__readout">
      <span class="ns-meter__value">RMS {{ rmsText }}</span>
      <span class="ns-meter__value" :style="{ color: peakColor }">PK {{ peakText }}</span>
    </div>

    <button
      v-if="clipping"
      type="button"
      class="ns-meter__clip"
      :disabled="!clearableClip"
      @click="emit('clearClip')"
    >
      削波
    </button>
  </div>
</template>

<style scoped>
.ns-meter {
  display: flex;
  gap: 6px;
}
.ns-meter--horizontal {
  flex-direction: column;
}
.ns-meter--vertical {
  flex-direction: column-reverse;
  align-items: center;
}
.ns-meter__label {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-meter__track {
  position: relative;
  flex: 1;
  overflow: hidden;
  border-radius: 3px;
  background: var(--ns-fill, #ebeef5);
}
.ns-meter--horizontal .ns-meter__track {
  height: 10px;
  width: 100%;
}
.ns-meter--vertical .ns-meter__track {
  width: 12px;
  min-height: 60px;
}
.ns-meter__peak {
  position: absolute;
  bottom: 0;
  left: 0;
  opacity: 0.85;
  transition: width 0.05s linear, height 0.05s linear;
}
.ns-meter__rms {
  position: absolute;
  bottom: 0;
  left: 0;
  background: rgb(64 158 255 / 55%);
  transition: width 0.05s linear, height 0.05s linear;
}
.ns-meter__tick {
  position: absolute;
  background: rgb(0 0 0 / 18%);
}
.ns-meter--horizontal .ns-meter__tick {
  top: 0;
  bottom: 0;
  width: 1px;
}
.ns-meter__tick--six {
  left: 90%;
}
.ns-meter__tick--zero {
  left: calc(100% - 1px);
}
.ns-meter__readout {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ns-meter__clip {
  align-self: flex-start;
  padding: 0 6px;
  border: none;
  border-radius: 3px;
  background: var(--ns-danger, #f56c6c);
  color: #fff;
  font-size: 10px;
  cursor: pointer;
}
.ns-meter__clip:disabled {
  cursor: default;
  opacity: 0.85;
}
.ns-meter.is-clipping .ns-meter__track {
  outline: 1px solid var(--ns-danger, #f56c6c);
}
</style>
