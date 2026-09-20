<!--
  Novel Studio · 置信度色带（docs/11 §4.2）
  ============================================================================
  设计依据：
    · docs/11 §4.2 —— 「置信度色带：≥0.85 绿、0.62~0.85 黄、<0.62 红、人工确认 蓝。
       这是用户『一眼看出哪里要改』的关键视觉设计」
    · docs/11 §4.4 —— 单行抽屉里要显示 Top-3 候选及其分数
    · docs/11 §4.5 —— 待确认队列的候选按钮同样用它
    · docs/06 §5.2  —— 阈值来自设置（attributionThreshold / attributionMargin）

  分档常量来自 @shared/constants.ts 的 CONFIDENCE_BANDS（唯一来源，别在组件里重写阈值）。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { CONFIDENCE_BANDS, DECIDED_BY_LABELS } from '@shared/constants.ts'
import type { DecidedBy, SpeakerCandidate } from '@shared/types.ts'
import { formatScore } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  /** 0~1；null 表示未参与判定（如规则直接命中、音效行） */
  confidence?: number | null
  /** 判定来源：human 时用蓝色（已人工确认，不必再看） */
  decidedBy?: DecidedBy | null
  /** 是否显示分数文本 */
  showScore?: boolean
  /** 紧凑模式（表格单元格用） */
  compact?: boolean
  /** Top-N 候选（鼠标悬停显示，避免污染表格视觉） */
  candidates?: SpeakerCandidate[] | null
  /** 判定阈值（用于标出「刚好过线」，默认用 CONFIDENCE_BANDS 的档位） */
  threshold?: number | null
}>(), {
  confidence: null,
  decidedBy: null,
  showScore: true,
  compact: false,
  candidates: null,
  threshold: null,
})

const emit = defineEmits<{
  /** 点击候选（待确认队列里直接用数字键选，这里供鼠标用） */
  pick: [characterId: string, score: number]
}>()

/** 人工确认：无论分数多少都显示蓝色并标注「人工」（docs/11 §4.2） */
const isHuman = computed(() => props.decidedBy === 'human')

const band = computed(() => {
  const value = props.confidence
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return CONFIDENCE_BANDS.find(item => value >= item.min) ?? CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1]!
})

const color = computed(() => (isHuman.value ? '#3d7eff' : (band.value?.color ?? '#c0c4cc')))
const label = computed(() => (isHuman.value ? '人工' : (band.value?.label ?? '—')))
const scoreText = computed(() => (props.confidence === null ? '—' : formatScore(props.confidence)))

/** 候选列表（按分数降序，最多展示 3 个 —— docs/11 §4.4 的 Top-3） */
const topCandidates = computed(() => (props.candidates ?? []).slice(0, 3))

/** 是否紧贴阈值（差距 < 0.03）：这类行最容易判错，值得高亮提醒 */
const borderline = computed(() => {
  const threshold = props.threshold
  const value = props.confidence
  if (threshold === null || value === null || value === undefined) return false
  return Math.abs(value - threshold) < 0.03
})
</script>

<template>
  <span class="ns-conf" :class="{ 'ns-conf--compact': compact, 'ns-conf--borderline': borderline }">
    <span
      class="ns-conf__dot"
      :style="{ background: color }"
      :title="`置信度 ${scoreText}（${label}）${decidedBy ? ` · ${DECIDED_BY_LABELS[decidedBy] ?? decidedBy}` : ''}`"
    />
    <span v-if="showScore" class="ns-conf__score">{{ scoreText }}</span>
    <span v-if="!compact && decidedBy" class="ns-conf__by">{{ DECIDED_BY_LABELS[decidedBy] ?? decidedBy }}</span>

    <span v-if="topCandidates.length" class="ns-conf__candidates">
      <button
        v-for="(candidate, index) in topCandidates"
        :key="candidate.characterId"
        type="button"
        class="ns-conf__cand"
        :title="`按 ${index + 1} 可直接选择 ${candidate.name}`"
        @click="emit('pick', candidate.characterId, candidate.score)"
      >
        <span class="ns-conf__cand-key">{{ index + 1 }}</span>
        {{ candidate.name }}
        <span class="ns-conf__cand-score">{{ formatScore(candidate.score) }}</span>
      </button>
    </span>
  </span>
</template>

<style scoped>
.ns-conf {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  vertical-align: middle;
}
.ns-conf__dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
}
.ns-conf__score {
  color: var(--ns-text-regular, #606266);
  font-variant-numeric: tabular-nums;
}
.ns-conf__by {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-conf--compact .ns-conf__score {
  font-size: 11px;
}
.ns-conf--borderline {
  padding: 1px 4px;
  outline: 1px dashed var(--ns-warning, #e6a23c);
  border-radius: 3px;
}
.ns-conf__candidates {
  display: inline-flex;
  gap: 4px;
}
.ns-conf__cand {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 10px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-regular, #606266);
  font-size: 11px;
  cursor: pointer;
}
.ns-conf__cand:hover {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-conf__cand-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--ns-fill, #ebeef5);
  font-size: 10px;
}
.ns-conf__cand-score {
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
</style>
