<!--
  Novel Studio · take 问题标记面板（docs/12 §8.1「flags」/ docs/05 §2.5 / docs/12 §10）
  ============================================================================
  设计依据：
    · docs/05 §2.5 —— 单次录音累计削波事件 > 20 次 → 该 take 应打 `clip` 标记并建议
      降低增益重录；音频管线的这个结论必须**一键可落**，否则用户只会「听着不对」。
    · docs/12 §8.1 —— flags 是 take 的元数据（削波/噪声/反馈/过长/过短/待重录/文本有问题），
      TakeList 的筛选（`activeFlags`）直接吃这组值，所以打标与筛选放在同一个面板里。
    · docs/12 §7   —— 啸叫（feedback）是监听返送的典型故障，要有专门标记便于回查。
    · docs/12 §5   —— 任务包模式下「文本有问题」会变成反馈项（reported）。

  打标一律走 takes store 的 `take:flag`（toggleFlag / applyFlags），本组件不直接调 IPC：
    · store 已经处理了「整体替换 flags」的语义与本地缓存同步；
    · 失败时 store 是静默的（callSafe），因此这里负责把失败交给 error-bus 展示，
      绝不在组件里自己拼错误文案（docs/22 §6.2）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import { AppError } from '@shared/errors.ts'
import type { Take } from '@shared/types.ts'
import { formatDb } from '@/shared/lib/format.ts'
import { reportError } from '@/shared/lib/error-bus.ts'
import { TAKE_FLAG_PRESETS, useTakesStore } from '../stores/takes.store.ts'

const props = withDefaults(defineProps<{
  /** 当前 take（没有 take 时面板只做筛选） */
  take?: Take | null
  /** 本行的全部 take（用于统计每个标记各有多少条） */
  takes?: Take[]
  /** 生效中的筛选（由父页面持有，同时传给 TakeList） */
  activeFlags?: string[]
  /** 只读（例如定稿中） */
  disabled?: boolean
  compact?: boolean
}>(), {
  take: null,
  takes: () => [],
  activeFlags: () => [],
  disabled: false,
  compact: false,
})

const emit = defineEmits<{
  'update:activeFlags': [flags: string[]]
  /** 打标成功（父页面可据此刷新列表或提示） */
  changed: [take: Take]
}>()

const takesStore = useTakesStore()

/** 用户自填的「其他」标记（自由文本，写入同一个 flags 数组） */
const customFlag = ref('')
const busy = ref(false)

const currentFlags = computed(() => props.take?.flags ?? [])

/** 每个预置标记在本行 take 里出现多少次（用户一眼看出「这一行全是削波」） */
const counts = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {}
  for (const preset of TAKE_FLAG_PRESETS) result[preset.key] = 0
  for (const take of props.takes) {
    for (const flag of take.flags) {
      result[flag] = (result[flag] ?? 0) + 1
    }
  }
  return result
})

/** 超出预置表的标记（历史数据/自定义）也要能筛 */
const extraFlags = computed(() => {
  const known = new Set(TAKE_FLAG_PRESETS.map(p => p.key))
  const found = new Set<string>()
  for (const take of props.takes) {
    for (const flag of take.flags) {
      if (!known.has(flag)) found.add(flag)
    }
  }
  return [...found]
})

function labelOf(flag: string): string {
  return TAKE_FLAG_PRESETS.find(p => p.key === flag)?.label ?? flag
}

function hintOf(flag: string): string {
  return TAKE_FLAG_PRESETS.find(p => p.key === flag)?.hint ?? '自定义标记'
}

function isSevere(flag: string): boolean {
  return TAKE_FLAG_PRESETS.find(p => p.key === flag)?.severe ?? false
}

function hasFlag(flag: string): boolean {
  return currentFlags.value.includes(flag)
}

function reportFailure(action: string): void {
  reportError(
    AppError.of('INTERNAL', { details: { channel: 'take:flag', action } }),
    { event: `recording.takeFlag.${action}` },
  )
}

/** 打标：切换单个标记（走 store 的 take:flag） */
async function toggle(flag: string): Promise<void> {
  const take = props.take
  if (!take || props.disabled || busy.value) return
  busy.value = true
  try {
    const updated = await takesStore.toggleFlag(take.id, flag)
    if (!updated) {
      reportFailure('toggle')
      return
    }
    emit('changed', updated)
  } finally {
    busy.value = false
  }
}

/** 写入「其他」自定义标记（重复时不重复追加） */
async function addCustom(): Promise<void> {
  const take = props.take
  const flag = customFlag.value.trim()
  if (!take || props.disabled || busy.value || !flag) return
  if (take.flags.includes(flag)) {
    customFlag.value = ''
    return
  }
  busy.value = true
  try {
    const updated = await takesStore.applyFlags(take.id, [...take.flags, flag])
    if (!updated) {
      reportFailure('apply')
      return
    }
    customFlag.value = ''
    emit('changed', updated)
  } finally {
    busy.value = false
  }
}

/** 一键按「削波事件过多」的建议打标（录音会话给出的结论，docs/05 §2.5） */
async function markAllSevere(): Promise<void> {
  const take = props.take
  if (!take || props.disabled || busy.value) return
  const severe = TAKE_FLAG_PRESETS.filter(p => p.severe).map(p => p.key)
  const next = [...new Set([...take.flags, ...severe])]
  busy.value = true
  try {
    const updated = await takesStore.applyFlags(take.id, next)
    if (!updated) {
      reportFailure('apply')
      return
    }
    emit('changed', updated)
  } finally {
    busy.value = false
  }
}

/** 清空该 take 的所有标记 */
async function clearAll(): Promise<void> {
  const take = props.take
  if (!take || props.disabled || busy.value || !take.flags.length) return
  busy.value = true
  try {
    const updated = await takesStore.applyFlags(take.id, [])
    if (!updated) {
      reportFailure('clear')
      return
    }
    emit('changed', updated)
  } finally {
    busy.value = false
  }
}

// ── 筛选（生效集合由父页面持有；这里只负责切换并同步给 store） ────────────────

function toggleFilter(flag: string): void {
  const next = props.activeFlags.includes(flag)
    ? props.activeFlags.filter(f => f !== flag)
    : [...props.activeFlags, flag]
  emit('update:activeFlags', next)
  takesStore.setFlagFilters(next)
}

function clearFilter(): void {
  emit('update:activeFlags', [])
  takesStore.setFlagFilters([])
}
</script>

<template>
  <section class="ns-flag-panel" :class="{ 'is-compact': compact }">
    <header class="ns-flag-panel__header">
      <h4 class="ns-flag-panel__title">问题标记</h4>
      <span v-if="take" class="ns-flag-panel__take">
        take #{{ take.partIndex + 1 }} · 峰值 {{ formatDb(take.peakDb) }}
      </span>
      <span v-else class="ns-flag-panel__take is-muted">未选中 take（只能筛选）</span>
    </header>

    <p v-if="!TAKE_FLAG_PRESETS.length" class="ns-flag-panel__empty">标记预设为空</p>

    <div class="ns-flag-panel__grid">
      <button
        v-for="preset in TAKE_FLAG_PRESETS"
        :key="preset.key"
        type="button"
        class="ns-flag-panel__chip"
        :class="{
          'is-on': hasFlag(preset.key),
          'is-severe': preset.severe,
        }"
        :disabled="disabled || !take || busy"
        :title="hintOf(preset.key)"
        @click="toggle(preset.key)"
      >
        <span>{{ preset.label }}</span>
        <span v-if="counts[preset.key]" class="ns-flag-panel__count">{{ counts[preset.key] }}</span>
      </button>
    </div>

    <div class="ns-flag-panel__custom">
      <input
        v-model="customFlag"
        class="ns-flag-panel__input"
        type="text"
        placeholder="其他标记（自由文本）…"
        :disabled="disabled || !take"
        @keydown.enter.prevent="addCustom"
      >
      <button
        type="button"
        class="ns-flag-panel__action"
        :disabled="disabled || !take || !customFlag.trim() || busy"
        @click="addCustom"
      >
        打标
      </button>
    </div>

    <div v-if="take" class="ns-flag-panel__actions">
      <button type="button" class="ns-flag-panel__action" :disabled="disabled || busy" @click="markAllSevere">
        标记全部严重问题
      </button>
      <button
        type="button"
        class="ns-flag-panel__action"
        :disabled="disabled || busy || !take.flags.length"
        @click="clearAll"
      >
        清空标记
      </button>
    </div>

    <div class="ns-flag-panel__filter">
      <div class="ns-flag-panel__filter-head">
        <span class="ns-flag-panel__filter-title">按标记筛选 take 列表</span>
        <button
          type="button"
          class="ns-flag-panel__link"
          :disabled="!activeFlags.length"
          @click="clearFilter"
        >
          清除筛选
        </button>
      </div>
      <div class="ns-flag-panel__grid">
        <button
          v-for="preset in TAKE_FLAG_PRESETS"
          :key="`filter-${preset.key}`"
          type="button"
          class="ns-flag-panel__chip is-filter"
          :class="{ 'is-on': activeFlags.includes(preset.key), 'is-severe': isSevere(preset.key) }"
          @click="toggleFilter(preset.key)"
        >
          {{ preset.label }}
        </button>
        <button
          v-for="flag in extraFlags"
          :key="`extra-${flag}`"
          type="button"
          class="ns-flag-panel__chip is-filter"
          :class="{ 'is-on': activeFlags.includes(flag) }"
          @click="toggleFilter(flag)"
        >
          {{ labelOf(flag) }}
        </button>
      </div>
      <p v-if="!takes.length" class="ns-flag-panel__hint">本行还没有 take，标记会在录制定稿后可用。</p>
      <p v-else-if="take && take.flags.length" class="ns-flag-panel__hint">
        当前 take 已标记：{{ take.flags.map(labelOf).join('、') }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.ns-flag-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}

.ns-flag-panel.is-compact {
  gap: 6px;
  padding: 8px 10px;
}

.ns-flag-panel__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ns-flag-panel__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ns-text-primary, #303133);
}

.ns-flag-panel__take {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ns-text-secondary, #909399);
}

.ns-flag-panel__take.is-muted {
  color: var(--ns-text-placeholder, #c0c4cc);
}

.ns-flag-panel__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ns-flag-panel__chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 3px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 12px;
  background: #fff;
  font-size: 12px;
  color: var(--ns-text-regular, #606266);
  cursor: pointer;
}

.ns-flag-panel__chip:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}

.ns-flag-panel__chip.is-on {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}

.ns-flag-panel__chip.is-severe.is-on {
  border-color: var(--ns-danger, #f56c6c);
  background: rgb(245 108 108 / 14%);
  color: var(--ns-danger, #f56c6c);
}

.ns-flag-panel__chip:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ns-flag-panel__chip.is-filter {
  border-radius: 4px;
}

.ns-flag-panel__count {
  padding: 0 4px;
  border-radius: 8px;
  background: rgb(0 0 0 / 8%);
  font-size: 11px;
}

.ns-flag-panel__custom,
.ns-flag-panel__actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.ns-flag-panel__input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  font-size: 12px;
}

.ns-flag-panel__action {
  padding: 4px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: #fff;
  font-size: 12px;
  color: var(--ns-text-regular, #606266);
  cursor: pointer;
}

.ns-flag-panel__action:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}

.ns-flag-panel__action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ns-flag-panel__filter {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
}

.ns-flag-panel__filter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ns-flag-panel__filter-title {
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

.ns-flag-panel__link {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 12px;
  color: var(--ns-primary, #409eff);
  cursor: pointer;
}

.ns-flag-panel__link:disabled {
  color: var(--ns-text-placeholder, #c0c4cc);
  cursor: not-allowed;
}

.ns-flag-panel__hint,
.ns-flag-panel__empty {
  margin: 0;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
</style>
