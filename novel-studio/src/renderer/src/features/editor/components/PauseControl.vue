<!--
  画本编辑 · 停顿调节（docs/11 §2.3 停顿推断表、§4.2「停顿：ms，可编辑」、§4.4 全部字段）
  ============================================================================
  停顿是「对轨直接消费」的字段（docs/11 §3：缺了 pauseAfterMs，对轨只能瞎猜留白），
  所以这里给三档操作粒度：
    · 单词调节   —— 滑杆 + 直接输入 ms（0~3000，步进 50）
    · 预设一键   —— 直接套用 PAUSE_RULES 的推断值（句号 500 / 省略号 700 / 场景切换 1200…）
    · 全局节奏   —— TEMPO_PRESETS（紧凑 0.8 / 标准 1.0 / 舒缓 1.3）对当前值乘系数
  另外提供句内停顿插入点（pauseInline）的编辑：多音字之外，长句断气也靠它。

  本组件不改数据：emit('change' / 'change-inline')，由父组件决定写库策略。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import { PAUSE_RULES, TEMPO_PRESETS } from '@shared/constants.ts'

const props = withDefaults(defineProps<{
  /** 句末留白（毫秒） */
  pauseAfterMs: number
  /** 句内停顿插入点（字符索引） */
  pauseInline?: number[] | null
  /** 行文本（用于展示插入点上下文与合法范围） */
  text?: string
  /** 只读 */
  readonly?: boolean
  /** 紧凑形态（表格单元格） */
  compact?: boolean
  /** 是否允许编辑句内停顿（抽屉里为 true） */
  allowInline?: boolean
}>(), {
  pauseInline: null,
  text: '',
  readonly: false,
  compact: true,
  allowInline: false,
})

const emit = defineEmits<{
  /** 句末停顿变化（毫秒） */
  change: [pauseAfterMs: number]
  /** 句内停顿插入点变化 */
  'change-inline': [pauseInline: number[] | null]
  /** 请求打开抽屉（紧凑形态下点「更多」） */
  open: []
}>()

const MAX_PAUSE_MS = 3000
const popoverOpen = ref(false)
/** 新增插入点的位置输入 */
const inlineCursor = ref<number | null>(null)

const pauseText = computed(() => `${props.pauseAfterMs} ms`)

/** 预设里过滤掉不可点的伪匹配（__scene_change__ 之类），并给出展示名 */
const presets = computed(() => PAUSE_RULES.filter(rule => !rule.match.startsWith('__')))

/** 当前停顿的「档位」说明：帮用户判断这个值是不是合理 */
const pauseHint = computed(() => {
  const value = props.pauseAfterMs
  if (value <= 0) return '无留白：相邻同角色行会粘连（质检会报 no_pause）'
  if (value < 250) return '很紧凑：适合分行未断句的二次切'
  if (value <= 600) return '常规句末留白'
  if (value <= 1000) return '明显留白：段落结束的节奏'
  return '长留白：场景切换或刻意停顿'
})

function setPause(value: number): void {
  if (props.readonly) return
  const safe = Math.min(MAX_PAUSE_MS, Math.max(0, Math.round(value)))
  emit('change', safe)
}

/** 停顿滑杆（el-slider）：载荷为 number | number[] */
function onPauseSliderInput(value: number | number[]): void {
  setPause(Number(value))
}

/** 停顿数值框（el-input-number）：载荷为 number，输入框被清空时为 undefined */
function onPauseNumberInput(value: number | undefined): void {
  setPause(value ?? 0)
}

/** 全局节奏：对当前值乘系数（docs/11 §2.3「全局节奏预设」） */
function applyTempo(factor: number): void {
  setPause(props.pauseAfterMs * factor)
}

const inlineList = computed(() => [...(props.pauseInline ?? [])].sort((a, b) => a - b))

function contextAt(index: number): string {
  const chars = [...props.text]
  const before = chars.slice(Math.max(0, index - 3), index).join('')
  const after = chars.slice(index, index + 3).join('')
  return `${before}▮${after}`
}

function removeInline(index: number): void {
  if (props.readonly) return
  const next = inlineList.value.filter(item => item !== index)
  emit('change-inline', next.length ? next : null)
}

function addInline(): void {
  if (props.readonly) return
  const length = [...props.text].length
  const raw = inlineCursor.value
  const at = raw === null || Number.isNaN(raw) ? length : Math.min(length, Math.max(0, Math.round(raw)))
  const next = [...new Set([...inlineList.value, at])].sort((a, b) => a - b)
  emit('change-inline', next)
  inlineCursor.value = null
}

/** 句内停顿位置输入（el-input-number）：载荷为 number，输入框被清空时为 undefined */
function onInlineCursorInput(value: number | undefined): void {
  inlineCursor.value = value ?? null
}

function onOpenChange(value: boolean): void {
  popoverOpen.value = value
  if (value) emit('open')
}
</script>

<template>
  <div class="ns-pause" :class="{ 'ns-pause--compact': compact, 'is-readonly': readonly }">
    <template v-if="compact">
      <el-popover
        :model-value="popoverOpen"
        trigger="click"
        placement="bottom"
        :width="300"
        :disabled="readonly"
        @update:model-value="onOpenChange"
      >
        <template #reference>
          <span class="ns-pause__chip" :class="{ 'is-zero': pauseAfterMs === 0 }" :title="pauseHint">
            {{ pauseText }}
            <em v-if="inlineList.length">· {{ inlineList.length }} 处句内</em>
          </span>
        </template>

        <div class="ns-pause__panel">
          <el-slider
            :model-value="pauseAfterMs"
            :min="0"
            :max="1500"
            :step="50"
            size="small"
            @update:model-value="onPauseSliderInput"
          />
          <div class="ns-pause__inline-inputs">
            <el-input-number
              :model-value="pauseAfterMs"
              :min="0"
              :max="MAX_PAUSE_MS"
              :step="50"
              size="small"
              controls-position="right"
              @update:model-value="onPauseNumberInput"
            />
            <span class="ns-pause__unit">ms</span>
          </div>
          <div class="ns-pause__presets">
            <button
              v-for="rule in presets"
              :key="rule.match"
              type="button"
              class="ns-pause__preset"
              @click="setPause(rule.pauseMs)"
            >
              {{ rule.label }} {{ rule.pauseMs }}
            </button>
          </div>
          <p class="ns-pause__hint">{{ pauseHint }}</p>
        </div>
      </el-popover>
    </template>

    <template v-else>
      <div class="ns-pause__row">
        <el-slider
          :model-value="pauseAfterMs"
          :min="0"
          :max="MAX_PAUSE_MS"
          :step="50"
          :disabled="readonly"
          class="ns-pause__slider"
          @update:model-value="onPauseSliderInput"
        />
        <el-input-number
          :model-value="pauseAfterMs"
          :min="0"
          :max="MAX_PAUSE_MS"
          :step="50"
          :disabled="readonly"
          size="small"
          controls-position="right"
          class="ns-pause__number"
          @update:model-value="onPauseNumberInput"
        />
        <span class="ns-pause__unit">ms</span>
      </div>

      <div class="ns-pause__preset-block">
        <span class="ns-pause__preset-label">按标点套用</span>
        <button
          v-for="rule in presets"
          :key="rule.match"
          type="button"
          class="ns-pause__preset"
          :disabled="readonly"
          @click="setPause(rule.pauseMs)"
        >
          {{ rule.label }}（{{ rule.pauseMs }}）
        </button>
      </div>

      <div class="ns-pause__preset-block">
        <span class="ns-pause__preset-label">全局节奏</span>
        <button
          v-for="tempo in TEMPO_PRESETS"
          :key="tempo.id"
          type="button"
          class="ns-pause__preset"
          :disabled="readonly"
          @click="applyTempo(tempo.factor)"
        >
          {{ tempo.label }} ×{{ tempo.factor }}
        </button>
      </div>

      <p class="ns-pause__hint">{{ pauseHint }}</p>

      <div v-if="allowInline" class="ns-pause__inline">
        <div class="ns-pause__inline-head">
          <span class="ns-pause__preset-label">句内停顿插入点</span>
          <span class="ns-pause__unit">共 {{ inlineList.length }} 处</span>
        </div>

        <ul v-if="inlineList.length" class="ns-pause__inline-list">
          <li v-for="point in inlineList" :key="point" class="ns-pause__inline-item">
            <code>{{ point }}</code>
            <span class="ns-pause__inline-ctx">{{ contextAt(point) }}</span>
            <button type="button" class="ns-pause__inline-del" :disabled="readonly" @click="removeInline(point)">移除</button>
          </li>
        </ul>
        <p v-else class="ns-pause__hint">没有句内停顿。长句可以在这里插一处，让配音员知道在哪儿换气。</p>

        <div class="ns-pause__inline-add">
          <el-input-number
            :model-value="inlineCursor ?? undefined"
            :min="0"
            :max="Math.max(0, text.length)"
            size="small"
            controls-position="right"
            placeholder="字符位置"
            :disabled="readonly"
            @update:model-value="onInlineCursorInput"
          />
          <span class="ns-pause__unit">字符索引</span>
          <el-button size="small" :disabled="readonly" @click="addInline">在末尾添加</el-button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ns-pause {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.ns-pause--compact .ns-pause__chip {
  padding: 1px 6px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.ns-pause--compact .ns-pause__chip.is-zero {
  border-color: var(--ns-warning, #e6a23c);
  color: var(--ns-warning, #e6a23c);
}
.ns-pause--compact .ns-pause__chip em {
  color: var(--ns-text-secondary, #909399);
  font-style: normal;
  font-size: 11px;
}
.ns-pause__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ns-pause__inline-inputs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ns-pause__presets,
.ns-pause__preset-block {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.ns-pause__preset-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-pause__preset {
  padding: 2px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 10px;
  background: #fff;
  color: var(--ns-text-regular, #606266);
  font-size: 11px;
  cursor: pointer;
}
.ns-pause__preset:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-pause__preset:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.ns-pause__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.5;
}
.ns-pause__row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ns-pause__slider {
  flex: 1;
  min-width: 140px;
}
.ns-pause__number {
  width: 118px;
}
.ns-pause__unit {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  white-space: nowrap;
}
.ns-pause__inline {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
}
.ns-pause__inline-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ns-pause__inline-list {
  margin: 6px 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-pause__inline-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.ns-pause__inline-item code {
  min-width: 28px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  font-family: ui-monospace, Consolas, monospace;
}
.ns-pause__inline-ctx {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-pause__inline-del {
  border: none;
  background: none;
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
  cursor: pointer;
}
.ns-pause__inline-add {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
