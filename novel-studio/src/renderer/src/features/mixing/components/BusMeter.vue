<!--
  Novel Studio · 总线/通道电平表（docs/15 §9 BusMeter）
  ============================================================================
  组成（两件套，各司其职）：
    1. `shared/ui/LevelMeter.vue`（复用）—— 峰值 + 有效值两条 + **锁存式削波指示**。
       为什么复用而不是再画一遍：削波锁存的语义（docs/12 §3.3「一旦发生就亮，
       直到用户点掉」）已经在那个组件里实现过一次，重复实现必然出现
       「有的表会锁、有的表一闪而过」这种不一致。
    2. Canvas 自绘的**峰值走势条**（近 9 秒）—— 峰值条只能表达「现在多响」，
       而混音时真正要看的是「这句话比上一句响了多少」。
       Canvas 每帧重绘，DOM 里始终只有 1 个 canvas 节点（docs 明确禁止堆 DOM 柱）。

  电平来源：useMeter 的统一 rAF 循环（见 composables/useMeter.ts）。
    · 实时来源：预听时的 Web Audio 分析器（可选，见 usePreview 的说明）；
    · 静态来源：`analysis:metrics` 实测值（mix.store.sampleTrackLevels 推入），
      此时表头显示的是「实测电平」，读数区会标注出来，避免被误读成实时电平。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import LevelMeter from '@/shared/ui/LevelMeter.vue'
import { formatDb } from '@/shared/lib/format.ts'
import {
  drawBarMeter,
  ratioOfDb,
  useMeter,
  DEFAULT_MAX_DB,
  DEFAULT_MIN_DB,
} from '@/features/mixing/composables/useMeter.ts'
import type { MeterCanvasFrame, MeterState } from '@/features/mixing/composables/useMeter.ts'

const props = withDefaults(defineProps<{
  /** 表头 id（useMeter 注册键；同一 id 只允许一个实例） */
  meterId: string
  label?: string
  minDb?: number
  maxDb?: number
  orientation?: 'horizontal' | 'vertical'
  /** 竖向时 LevelMeter 的高度 */
  height?: number
  /** 走势条高度（0 = 不画走势条） */
  historyHeight?: number
  /** 静态电平（来自 analysis:metrics）还是实时电平（Web Audio） */
  source?: 'live' | 'static' | 'idle'
  compact?: boolean
  showReadout?: boolean
}>(), {
  label: '',
  minDb: DEFAULT_MIN_DB,
  maxDb: DEFAULT_MAX_DB,
  orientation: 'vertical',
  height: 150,
  historyHeight: 26,
  source: 'idle',
  compact: false,
  showReadout: true,
})

const emit = defineEmits<{
  /** 用户点了「削波」指示清除锁存 */
  clearClip: [meterId: string]
}>()

/** 走势采样点数量（20 Hz × 180 ≈ 9 秒） */
const HISTORY_POINTS = 180
const HISTORY_INTERVAL_MS = 50

const canvasRef = ref<HTMLCanvasElement | null>(null)
/** 非响应式历史缓冲：它每帧变，进响应式只会带来无意义的 re-render */
const history: Array<number | null> = []
let lastSampleAt = 0

const meter = useMeter({
  id: props.meterId,
  minDb: props.minDb,
  maxDb: props.maxDb,
  canvas: () => canvasRef.value,
  render: (frame: MeterCanvasFrame, state: MeterState) => {
    drawHistory(frame, state)
  },
})

function drawHistory(frame: MeterCanvasFrame, state: MeterState): void {
  const { ctx, width, height } = frame

  // ① 采样（20 Hz，与 Vue 读数同频；比这更密只是在画同一根柱子）
  const now = state.updatedAtMs
  if (now - lastSampleAt >= HISTORY_INTERVAL_MS) {
    lastSampleAt = now
    history.push(state.peakHoldDb ?? state.peakDb)
    while (history.length > HISTORY_POINTS) history.shift()
  }

  // ② 背景与参考线（-24 / -12 / -6 dBFS）
  drawBarMeter(frame, { ...state, peakDb: null, rmsDb: null }, {
    minDb: props.minDb,
    maxDb: props.maxDb,
    ticks: [],
    clipIndicator: false,
  })

  ctx.strokeStyle = 'rgb(0 0 0 / 12%)'
  ctx.lineWidth = 1
  for (const db of [-24, -12, -6]) {
    const y = Math.round(height - ratioOfDb(db, props.minDb, props.maxDb) * height) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }

  if (!history.length) return

  // ③ 走势柱
  const columnWidth = Math.max(1, width / HISTORY_POINTS)
  const offset = width - history.length * columnWidth
  for (let i = 0; i < history.length; i++) {
    const db = history[i]
    const ratio = ratioOfDb(db, props.minDb, props.maxDb)
    if (ratio <= 0) continue
    const columnHeight = Math.max(1, ratio * height)
    const peak = db ?? props.minDb
    ctx.fillStyle = peak >= -1
      ? 'rgb(245 108 108 / 85%)'
      : peak >= -6 ? 'rgb(230 162 60 / 85%)' : 'rgb(103 194 58 / 80%)'
    ctx.fillRect(offset + i * columnWidth, height - columnHeight, Math.max(1, columnWidth - 0.5), columnHeight)
  }
}

const state = computed(() => meter.state.value)
const peakHoldText = computed(() => formatDb(state.value.peakHoldDb))
const sourceLabel = computed(() => {
  switch (props.source) {
    case 'live': return '实时'
    case 'static': return '实测'
    default: return '未采样'
  }
})
const idle = computed(() => props.source === 'idle' && state.value.rmsDb === null && state.value.peakDb === null)

function onClearClip(): void {
  meter.clearClip()
  emit('clearClip', props.meterId)
}

/** 供父组件在「采样」时直接用同一口径推值（避免重复 import useMeter） */
defineExpose({ clearClip: onClearClip })
</script>

<template>
  <div class="ns-bus-meter" :class="{ 'is-compact': compact, 'is-idle': idle }">
    <div v-if="label || showReadout" class="ns-bus-meter__head">
      <span v-if="label" class="ns-bus-meter__label" :title="label">{{ label }}</span>
      <el-tooltip
        :content="source === 'live'
          ? '实时电平：来自预听音频的 Web Audio 分析'
          : source === 'static'
            ? '实测电平：来自 analysis:metrics 的真实测量值（主进程未提供实时混音电平事件）'
            : '尚未采样：点工具栏「采样轨道电平」或开始预听'"
        placement="top"
      >
        <span class="ns-bus-meter__source" :class="`ns-bus-meter__source--${source}`">{{ sourceLabel }}</span>
      </el-tooltip>
    </div>

    <div class="ns-bus-meter__body" :class="`ns-bus-meter__body--${orientation}`">
      <!-- 复用共享电平表：峰值 + 有效值 + 锁存削波 -->
      <LevelMeter
        :rms-db="state.rmsDb"
        :peak-db="state.peakDb"
        :clipping="state.clipping"
        :min-db="minDb"
        :max-db="maxDb"
        :orientation="orientation"
        :height="height"
        :show-readout="showReadout"
        :clearable-clip="true"
        @clear-clip="onClearClip"
      />

      <!-- Canvas 自绘峰值走势（近 9 秒） -->
      <canvas
        v-if="historyHeight > 0"
        ref="canvasRef"
        class="ns-bus-meter__history"
        :style="{ height: `${historyHeight}px` }"
        :title="`峰值走势（近 9 秒），保持峰值 ${peakHoldText}`"
      />
    </div>

    <p v-if="showReadout" class="ns-bus-meter__foot">
      <span>保持 {{ peakHoldText }}</span>
      <span v-if="idle" class="ns-bus-meter__idle">（无信号）</span>
    </p>
  </div>
</template>

<style scoped>
.ns-bus-meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ns-bus-meter__head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ns-bus-meter__label {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-bus-meter__source {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 10px;
}
.ns-bus-meter__source--live {
  background: rgb(103 194 58 / 15%);
  color: var(--ns-success, #67c23a);
}
.ns-bus-meter__source--static {
  background: rgb(64 158 255 / 15%);
  color: var(--ns-primary, #409eff);
}
.ns-bus-meter__body {
  display: flex;
  gap: 4px;
}
.ns-bus-meter__body--vertical {
  flex-direction: column;
  align-items: center;
}
.ns-bus-meter__body--horizontal {
  flex-direction: row;
  align-items: stretch;
}
.ns-bus-meter__history {
  display: block;
  width: 100%;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-bus-meter__foot {
  display: flex;
  gap: 6px;
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.ns-bus-meter__idle {
  opacity: 0.8;
}
.ns-bus-meter.is-idle .ns-bus-meter__history {
  opacity: 0.6;
}
</style>
