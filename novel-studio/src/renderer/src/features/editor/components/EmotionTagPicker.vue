<!--
  画本编辑 · 情绪与强度选择（docs/11 §4.2「情绪：标签 + 强度」、§4.3「情绪以行内小标签呈现」）
  ============================================================================
  两种形态：
    · compact（表格 / 剧本行内）：只渲染一个标签，点击才弹出选择面板 ——
      5000 行下不能给每行挂一个下拉（这是 docs/11 §4.2 的性能要求）。
    · 展开（单行抽屉）：情绪下拉 + 强度滑杆 + 清除，一眼看清全部取值。

  情绪取值来自 @shared/constants.ts 的 EMOTIONS（唯一来源，不在组件里另写一份）。
  本组件不改数据：一律 emit('change', patch)，由父组件决定走 useImmediateField（标记类立即写库）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import { EMOTIONS } from '@shared/constants.ts'
import type { Emotion } from '@shared/constants.ts'

const props = withDefaults(defineProps<{
  /** 情绪词；null = 未设置 */
  emotion?: string | null
  /** 强度 1~5；null = 未设置 */
  intensity?: number | null
  /** 只读（任务包模式 / 只读画本） */
  readonly?: boolean
  /** 紧凑形态（表格单元格） */
  compact?: boolean
  /** 是否允许清除情绪 */
  clearable?: boolean
}>(), {
  emotion: null,
  intensity: null,
  readonly: false,
  compact: true,
  clearable: true,
})

const emit = defineEmits<{
  /** 情绪或强度变化；emotion=null 表示清除 */
  change: [patch: { emotion?: string | null; emotionIntensity?: number | null }]
  /** 展开面板（父组件可用来打开抽屉） */
  open: []
}>()

/** 弹出面板是否打开（compact 形态用） */
const popoverOpen = ref(false)

const label = computed(() => props.emotion ?? '—')
const intensityText = computed(() => (props.intensity === null || props.intensity === undefined
  ? ''
  : `×${props.intensity}`))

/** 强度用 5 档（1 很轻 → 5 很重），与 NstLine.emotionIntensity 的取值范围一致 */
const INTENSITY_LEVELS = [1, 2, 3, 4, 5] as const

function pick(next: string | null): void {
  if (props.readonly) return
  emit('change', { emotion: next })
  popoverOpen.value = false
}

function setIntensity(next: number | null): void {
  if (props.readonly) return
  emit('change', { emotionIntensity: next })
}

/** 情绪下拉（el-select）：选项值为 EMOTIONS 里的 Emotion，可清空（清空载荷为 undefined） */
function onEmotionInput(value: Emotion | undefined): void {
  pick(value || null)
}

/** 强度滑杆（el-slider）：载荷为 number | number[]（档位是 show-stops 的整数） */
function onIntensityInput(value: number | number[]): void {
  setIntensity(Number(value) || null)
}

function onOpenChange(value: boolean): void {
  if (props.readonly) return
  popoverOpen.value = value
  if (value) emit('open')
}
</script>

<template>
  <div class="ns-emotion" :class="{ 'ns-emotion--compact': compact, 'is-readonly': readonly }">
    <!-- 紧凑形态：标签 + 弹出面板 -->
    <template v-if="compact">
      <el-popover
        :model-value="popoverOpen"
        trigger="click"
        placement="bottom-start"
        :width="252"
        :disabled="readonly"
        @update:model-value="onOpenChange"
      >
        <template #reference>
          <span
            class="ns-emotion__tag"
            :class="{ 'is-empty': !emotion }"
            :title="emotion ? `情绪：${emotion}${intensityText ? ` 强度 ${intensityText}` : ''}` : '设置情绪'"
          >
            {{ label }}<em v-if="intensityText">{{ intensityText }}</em>
          </span>
        </template>

        <div class="ns-emotion__panel">
          <div class="ns-emotion__grid">
            <button
              v-for="item in EMOTIONS"
              :key="item"
              type="button"
              class="ns-emotion__chip"
              :class="{ 'is-active': item === emotion }"
              @click="pick(item)"
            >
              {{ item }}
            </button>
          </div>

          <div class="ns-emotion__intensity">
            <span class="ns-emotion__intensity-label">强度</span>
            <button
              v-for="level in INTENSITY_LEVELS"
              :key="level"
              type="button"
              class="ns-emotion__level"
              :class="{ 'is-active': intensity === level }"
              @click="setIntensity(level)"
            >
              {{ level }}
            </button>
            <button v-if="clearable" type="button" class="ns-emotion__clear" @click="pick(null)">清除</button>
          </div>
        </div>
      </el-popover>
    </template>

    <!-- 展开形态：抽屉里用 -->
    <template v-else>
      <div class="ns-emotion__row">
        <el-select
          :model-value="emotion ?? ''"
          :disabled="readonly"
          placeholder="未设置"
          clearable
          size="small"
          class="ns-emotion__select"
          @update:model-value="onEmotionInput"
        >
          <el-option v-for="item in EMOTIONS" :key="item" :label="item" :value="item" />
        </el-select>

        <span class="ns-emotion__strength-label">强度</span>
        <el-slider
          :model-value="intensity ?? 0"
          :min="0"
          :max="5"
          :step="1"
          :disabled="readonly"
          show-stops
          size="small"
          class="ns-emotion__slider"
          @update:model-value="onIntensityInput"
        />
        <span class="ns-emotion__strength-text">{{ intensityText || '未设' }}</span>
      </div>
      <p class="ns-emotion__hint">强度 1 很轻、5 很重；只在情绪已设置时生效（导出任务包时会带给配音员）。</p>
    </template>
  </div>
</template>

<style scoped>
.ns-emotion {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.ns-emotion--compact .ns-emotion__tag {
  padding: 1px 6px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.ns-emotion--compact .ns-emotion__tag.is-empty {
  color: var(--ns-text-placeholder, #c0c4cc);
}
.ns-emotion--compact .ns-emotion__tag em {
  margin-left: 2px;
  color: var(--ns-text-secondary, #909399);
  font-style: normal;
  font-size: 11px;
}
.ns-emotion.is-readonly .ns-emotion__tag {
  cursor: default;
  opacity: 0.85;
}
.ns-emotion__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ns-emotion__grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
}
.ns-emotion__chip {
  padding: 4px 0;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: #fff;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.ns-emotion__chip.is-active {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}
.ns-emotion__intensity {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
}
.ns-emotion__intensity-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-emotion__level {
  width: 22px;
  height: 22px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 50%;
  background: #fff;
  color: var(--ns-text-regular, #606266);
  font-size: 11px;
  cursor: pointer;
}
.ns-emotion__level.is-active {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-emotion__clear {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  cursor: pointer;
}
.ns-emotion__row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ns-emotion__select {
  width: 120px;
}
.ns-emotion__slider {
  flex: 1;
  min-width: 120px;
}
.ns-emotion__strength-label,
.ns-emotion__strength-text {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  white-space: nowrap;
}
.ns-emotion__hint {
  margin: 2px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
</style>
