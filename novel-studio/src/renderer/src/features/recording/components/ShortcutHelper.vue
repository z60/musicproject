<!--
  Novel Studio · 快捷键速查面板（docs/12 §9.1 / §10、docs/12 §9.3）
  ============================================================================
  设计依据：
    · docs/12 §9.1 —— 默认键位表的**唯一来源**是 `shared/lib/shortcuts.ts` 的
      DEFAULT_RECORDING_SHORTCUTS；本组件不硬编码任何键位字符串。
    · docs/04 §8.2 —— 用户覆盖项存放在 `settings.recording`（stopKey / nextLineKey /
      redoKey / playKey）四个字段里；「实际生效值」必须体现覆盖，而不是只显示默认值。
      覆盖映射（设置字段 → 绑定 id）封装在 useShortcuts 里，本组件复用它的
      setOverride / clearOverride，避免把映射表复制成两份。
    · docs/12 §10  —— ShortcutHelper「可呼出」。呼出方式由父页面负责（走带栏帮助按钮），
      组件只管显示与改键；关闭用 Esc 或点遮罩。
    · docs/12 §9.3 —— 冲突（同一键位绑了多个动作）必须**标红**：录音时按下一个键
      跑出两个动作，现场根本没法排查，所以面板要把冲突摊开在同一处。

  诚实边界：`useShortcuts` 只在调用 `enable()` 时注册全局 keydown；本组件**不调 enable**，
  因此它不会与录音页的快捷键监听抢键（同一键位被两个 handler 处理会重复触发动作）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  DEFAULT_RECORDING_SHORTCUTS,
  findConflicts,
  formatShortcut,
  parseShortcut,
} from '@/shared/lib/shortcuts.ts'
import { useShortcuts } from '../composables/useShortcuts.ts'

const props = withDefaults(defineProps<{
  /** 面板可见性（v-model） */
  modelValue: boolean
  /** 是否显示脚踏板提示（录音页呼出时显示，设置页不显示） */
  showPedalHint?: boolean
}>(), {
  showPedalHint: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 某个绑定被改键/恢复默认后抛出（父页面可据此刷新按钮上的快捷键提示） */
  overrideChanged: [actionId: string]
}>()

/** 只为复用覆盖映射与改键动作；onAction 不会被调用（未 enable） */
const shortcuts = useShortcuts({ onAction: () => undefined })

const keyword = ref('')
/** 正在改键的绑定 id（按下一键即写入设置） */
const capturingId = ref<string | null>(null)
/** 改键失败的原因（来自 parseShortcut 的 error，或「该动作不可自定义」） */
const captureError = ref('')

const rows = computed(() => shortcuts.rows.value)

const visibleRows = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return rows.value
  return rows.value.filter(row =>
    row.label.toLowerCase().includes(query)
    || row.display.toLowerCase().includes(query)
    || row.id.toLowerCase().includes(query),
  )
})

/** 冲突组（键位 → 绑定了它的动作），用 DEFAULT_RECORDING_SHORTCUTS + findConflicts 计算 */
const conflictGroups = computed(() => findConflicts(shortcuts.bindings.value))
const conflictIds = computed(() => {
  const ids = new Set<string>()
  for (const group of conflictGroups.value) {
    for (const item of group.items) ids.add(item.id)
  }
  return ids
})

const overriddenCount = computed(() => shortcuts.overriddenIds.value.length)

/** 默认值表里属于录音域的条数（写清楚「表里有 N 条」而不是让用户自己数） */
const defaultCount = computed(() => DEFAULT_RECORDING_SHORTCUTS.length)

function close(): void {
  capturingId.value = null
  captureError.value = ''
  emit('update:modelValue', false)
}

function startCapture(actionId: string): void {
  captureError.value = ''
  capturingId.value = actionId
}

/**
 * 改键：把键盘事件回写成键位串（eventToShortcutString 由 useShortcuts 包了一层）。
 * 非法键位沿用 parseShortcut 给出的 error 文案，不在组件里自拼。
 */
async function onCaptureKeydown(event: KeyboardEvent): Promise<void> {
  if (!capturingId.value) return
  event.preventDefault()
  event.stopPropagation()

  if (event.key === 'Escape') {
    capturingId.value = null
    return
  }

  const actionId = capturingId.value
  const candidate = shortcuts.captureShortcut({
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  })
  if (!candidate) {
    captureError.value = '这个键位无法识别，请换一个（例如 Ctrl+Shift+P）'
    return
  }

  const parsed = parseShortcut(candidate)
  if (!parsed.valid) {
    captureError.value = parsed.error ?? '该键位不可用'
    return
  }

  const ok = await shortcuts.setOverride(actionId, candidate)
  if (!ok) {
    // 只有四个键可自定义（docs/04 §8.2），其余动作只能看
    captureError.value = '该动作的键位不可自定义（仅「开始/停止、下一行、丢弃并重录、播放 take」可改）'
    return
  }
  capturingId.value = null
  captureError.value = ''
  emit('overrideChanged', actionId)
}

async function resetOne(actionId: string): Promise<void> {
  const ok = await shortcuts.clearOverride(actionId)
  if (ok) emit('overrideChanged', actionId)
}

async function resetAll(): Promise<void> {
  const ids = [...shortcuts.overriddenIds.value]
  for (const id of ids) {
    await shortcuts.clearOverride(id)
    emit('overrideChanged', id)
  }
}

/** Esc 关闭面板（capture 阶段：避免被输入框的 Esc 处理掉） */
function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !capturingId.value) {
    event.preventDefault()
    close()
  }
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      capturingId.value = null
      captureError.value = ''
      globalThis.addEventListener?.('keydown', onPanelKeydown, true)
      globalThis.addEventListener?.('keydown', onCaptureKeydown, true)
    } else {
      globalThis.removeEventListener?.('keydown', onPanelKeydown, true)
      globalThis.removeEventListener?.('keydown', onCaptureKeydown, true)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('keydown', onPanelKeydown, true)
  globalThis.removeEventListener?.('keydown', onCaptureKeydown, true)
})
</script>

<template>
  <div v-if="modelValue" class="ns-shortcut-helper" role="dialog" aria-modal="true" @click.self="close">
    <section class="ns-shortcut-helper__panel">
      <header class="ns-shortcut-helper__header">
        <div>
          <h3 class="ns-shortcut-helper__title">快捷键速查</h3>
          <p class="ns-shortcut-helper__subtitle">
            默认表 {{ defaultCount }} 条 · 已自定义 {{ overriddenCount }} 条 · 点击键位即可改键（Esc 取消）
          </p>
        </div>
        <button type="button" class="ns-shortcut-helper__close" @click="close">关闭</button>
      </header>

      <div v-if="conflictGroups.length" class="ns-shortcut-helper__conflicts">
        <p class="ns-shortcut-helper__conflict-title">
          发现 {{ conflictGroups.length }} 组冲突：同一键位绑定了多个动作，录音时会同时触发。
        </p>
        <ul class="ns-shortcut-helper__conflict-list">
          <li v-for="group in conflictGroups" :key="group.canonical">
            <kbd class="is-conflict">{{ group.display }}</kbd>
            <span>{{ group.items.map(item => item.label ?? item.id).join(' / ') }}</span>
          </li>
        </ul>
      </div>

      <div class="ns-shortcut-helper__toolbar">
        <input
          v-model="keyword"
          class="ns-shortcut-helper__search"
          type="search"
          placeholder="搜索功能名或键位…"
        >
        <button
          type="button"
          class="ns-shortcut-helper__button"
          :disabled="overriddenCount === 0"
          @click="resetAll"
        >
          全部恢复默认
        </button>
      </div>

      <p v-if="captureError" class="ns-shortcut-helper__error">{{ captureError }}</p>

      <table class="ns-shortcut-helper__table">
        <thead>
          <tr>
            <th scope="col">功能</th>
            <th scope="col">键位</th>
            <th scope="col">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="row.id">
            <td class="ns-shortcut-helper__label">{{ row.label }}</td>
            <td>
              <button
                type="button"
                class="ns-shortcut-helper__key"
                :class="{
                  'is-conflict': conflictIds.has(row.id),
                  'is-overridden': row.overridden,
                  'is-capturing': capturingId === row.id,
                }"
                @click="startCapture(row.id)"
              >
                <kbd>{{ capturingId === row.id ? '按下新键位…' : formatShortcut(row.shortcut) }}</kbd>
              </button>
            </td>
            <td class="ns-shortcut-helper__state">
              <span v-if="capturingId === row.id" class="is-capturing">等待输入</span>
              <span v-else-if="conflictIds.has(row.id)" class="is-conflict">冲突</span>
              <span v-else-if="row.overridden" class="is-overridden">已自定义</span>
              <span v-else class="is-default">默认</span>
              <button
                v-if="row.overridden"
                type="button"
                class="ns-shortcut-helper__reset"
                @click="resetOne(row.id)"
              >
                恢复
              </button>
            </td>
          </tr>
          <tr v-if="!visibleRows.length">
            <td colspan="3" class="ns-shortcut-helper__empty">没有匹配的快捷键</td>
          </tr>
        </tbody>
      </table>

      <footer class="ns-shortcut-helper__footer">
        <p v-if="showPedalHint" class="ns-shortcut-helper__pedal">
          脚踏板（docs/12 §9.2）：多数踏板模拟键盘键（如 F13）或手柄按钮；映射与「踏板测试」在设置页配置。
          最常用的映射是「踏板 = 停止并下一行」。
        </p>
        <p class="ns-shortcut-helper__note">
          录音页激活时会接管全局快捷键，并拦截会中断录音的窗口关闭/刷新组合键（docs/12 §9.3）。
        </p>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ns-shortcut-helper {
  position: fixed;
  inset: 0;
  z-index: 2900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgb(0 0 0 / 45%);
}

.ns-shortcut-helper__panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(720px, 100%);
  max-height: 86vh;
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: 0 12px 36px rgb(0 0 0 / 26%);
}

.ns-shortcut-helper__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.ns-shortcut-helper__title {
  margin: 0;
  font-size: 16px;
  color: var(--ns-text-primary, #303133);
}

.ns-shortcut-helper__subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

.ns-shortcut-helper__close,
.ns-shortcut-helper__button,
.ns-shortcut-helper__reset {
  padding: 5px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-regular, #606266);
  cursor: pointer;
}

.ns-shortcut-helper__close:hover,
.ns-shortcut-helper__button:hover:not(:disabled),
.ns-shortcut-helper__reset:hover {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}

.ns-shortcut-helper__button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ns-shortcut-helper__conflicts {
  padding: 10px 12px;
  border: 1px solid rgb(245 108 108 / 40%);
  border-radius: 6px;
  background: rgb(245 108 108 / 8%);
}

.ns-shortcut-helper__conflict-title {
  margin: 0;
  font-size: 13px;
  color: var(--ns-danger, #f56c6c);
}

.ns-shortcut-helper__conflict-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--ns-text-regular, #606266);
}

.ns-shortcut-helper__conflict-list li {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 2px 0;
}

.ns-shortcut-helper__toolbar {
  display: flex;
  gap: 8px;
}

.ns-shortcut-helper__search {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  font-size: 13px;
}

.ns-shortcut-helper__error {
  margin: 0;
  font-size: 12px;
  color: var(--ns-danger, #f56c6c);
}

.ns-shortcut-helper__table {
  width: 100%;
  border-collapse: collapse;
  overflow: auto;
  font-size: 13px;
}

.ns-shortcut-helper__table th {
  padding: 6px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  text-align: left;
  font-weight: 600;
  color: var(--ns-text-secondary, #909399);
}

.ns-shortcut-helper__table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  color: var(--ns-text-regular, #606266);
}

.ns-shortcut-helper__label {
  color: var(--ns-text-primary, #303133);
}

.ns-shortcut-helper__key {
  padding: 2px 6px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.ns-shortcut-helper__key.is-overridden {
  border-style: solid;
  border-color: var(--ns-primary, #409eff);
}

.ns-shortcut-helper__key.is-conflict kbd {
  color: var(--ns-danger, #f56c6c);
  font-weight: 600;
}

.ns-shortcut-helper__key.is-capturing {
  border-color: var(--ns-warning, #e6a23c);
  background: rgb(230 162 60 / 12%);
}

.ns-shortcut-helper__state {
  display: flex;
  gap: 8px;
  align-items: center;
}

.ns-shortcut-helper__state .is-conflict {
  color: var(--ns-danger, #f56c6c);
}

.ns-shortcut-helper__state .is-overridden {
  color: var(--ns-primary, #409eff);
}

.ns-shortcut-helper__state .is-capturing {
  color: var(--ns-warning, #e6a23c);
}

.ns-shortcut-helper__state .is-default,
.ns-shortcut-helper__empty {
  color: var(--ns-text-secondary, #909399);
}

.ns-shortcut-helper__empty {
  padding: 18px 8px;
  text-align: center;
}

.ns-shortcut-helper__footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ns-shortcut-helper__pedal,
.ns-shortcut-helper__note {
  margin: 0;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

kbd {
  padding: 1px 5px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  font-family: inherit;
  font-size: 12px;
}
</style>
