<!--
  Novel Studio · 统一确认对话框
  ============================================================================
  设计依据：
    · docs/22 §7 —— 展示策略：error 级「关键流程用 Modal」；fatal 用不可关闭 Modal
    · docs/11 §4.7 —— 破坏性批量操作（批量删除、批量合并旁白）必须先确认并说清影响范围
    · docs/15 §5.1 —— 导出覆盖已有文件（skip/overwrite/rename）需要明确选择

  为什么不用 ElMessageBox 直接调用：
    · 需要「影响范围 + 明细 + 二次确认文案」的固定版式（例如「将影响 128 行」）；
    · 需要在批量流程里复用同一套按钮语义（确认/取消/危险色）；
    · 组件化以后能被 el-dialog 的 teleport/焦点陷阱统一管理，键盘可用。
-->

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 双向绑定：是否显示 */
  modelValue: boolean
  title: string
  /** 一句话说清后果 */
  message?: string
  /** 明细（影响范围清单，允许多行） */
  details?: string[]
  /** 需要用户输入确认文字时的期望值（如输入书名才能删除） */
  confirmKeyword?: string | null
  confirmText?: string
  cancelText?: string
  /** danger 用于删除类操作（按钮变红） */
  type?: 'info' | 'warning' | 'danger'
  loading?: boolean
  confirmDisabled?: boolean
  width?: string
  /** 是否在关闭前把「取消」也当作一次显式操作（默认 true） */
  closeOnCancel?: boolean
}>(), {
  message: '',
  details: () => [],
  confirmKeyword: null,
  confirmText: '确定',
  cancelText: '取消',
  type: 'warning',
  loading: false,
  confirmDisabled: false,
  width: '460px',
  closeOnCancel: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  cancel: []
}>()

/** 需要输入关键词确认时的输入值 */
const keyword = ref('')
/** 面板元素：打开时聚焦，否则 @keydown 收不到事件（Enter/Esc 快捷确认就失效了） */
const panel = ref<HTMLElement | null>(null)

watch(() => props.modelValue, async (visible) => {
  if (!visible) return
  keyword.value = ''
  await nextTick()
  panel.value?.focus()
})

const needsKeyword = computed(() => typeof props.confirmKeyword === 'string' && props.confirmKeyword.length > 0)
const keywordOk = computed(() => !needsKeyword.value || keyword.value.trim() === props.confirmKeyword)
const canConfirm = computed(() => keywordOk.value && !props.confirmDisabled && !props.loading)

function close(): void {
  emit('update:modelValue', false)
}

function onCancel(): void {
  emit('cancel')
  if (props.closeOnCancel) close()
}

function onConfirm(): void {
  if (!canConfirm.value) return
  emit('confirm')
}

function onKeydown(event: KeyboardEvent): void {
  // Enter 确认、Esc 取消：让「批量处理」这类连续确认场景不用摸鼠标
  if (event.key === 'Escape') onCancel()
  if (event.key === 'Enter' && !needsKeyword.value) onConfirm()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.modelValue" class="ns-confirm" @keydown="onKeydown">
      <div class="ns-confirm__mask" @click="props.type !== 'danger' && onCancel()" />
      <div
        ref="panel"
        class="ns-confirm__panel"
        :style="{ width: props.width }"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
      >
        <header class="ns-confirm__head" :class="`ns-confirm__head--${props.type}`">
          <span class="ns-confirm__icon" aria-hidden="true">
            {{ props.type === 'danger' ? '⛔' : props.type === 'warning' ? '⚠' : 'ℹ' }}
          </span>
          <h3 class="ns-confirm__title">{{ props.title }}</h3>
        </header>

        <div class="ns-confirm__body">
          <p v-if="props.message" class="ns-confirm__message">{{ props.message }}</p>

          <ul v-if="props.details.length" class="ns-confirm__details">
            <li v-for="(item, index) in props.details" :key="index">{{ item }}</li>
          </ul>

          <label v-if="needsKeyword" class="ns-confirm__keyword">
            <span>请输入「{{ props.confirmKeyword }}」以确认：</span>
            <input v-model="keyword" type="text" class="ns-confirm__input" :placeholder="props.confirmKeyword ?? ''">
          </label>
        </div>

        <footer class="ns-confirm__foot">
          <button type="button" class="ns-btn" :disabled="props.loading" @click="onCancel">
            {{ props.cancelText }}
          </button>
          <button
            type="button"
            class="ns-btn"
            :class="props.type === 'danger' ? 'ns-btn--danger' : 'ns-btn--primary'"
            :disabled="!canConfirm"
            @click="onConfirm"
          >
            {{ props.loading ? '处理中…' : props.confirmText }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ns-confirm {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ns-confirm__mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 45%);
}
.ns-confirm__panel {
  position: relative;
  max-width: 92vw;
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: 0 8px 32px rgb(0 0 0 / 20%);
}
.ns-confirm__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px 8px;
}
.ns-confirm__icon {
  font-size: 18px;
}
.ns-confirm__head--warning .ns-confirm__icon {
  color: var(--ns-warning, #e6a23c);
}
.ns-confirm__head--danger .ns-confirm__icon {
  color: var(--ns-danger, #f56c6c);
}
.ns-confirm__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 16px;
  font-weight: 600;
}
.ns-confirm__body {
  padding: 0 20px 8px;
}
.ns-confirm__message {
  margin: 0 0 8px;
  color: var(--ns-text-regular, #606266);
  font-size: 14px;
  line-height: 1.6;
}
.ns-confirm__details {
  max-height: 200px;
  margin: 0;
  padding: 8px 8px 8px 28px;
  overflow: auto;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  line-height: 1.7;
}
.ns-confirm__keyword {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
.ns-confirm__input {
  padding: 6px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  font-size: 13px;
}
.ns-confirm__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px 18px;
}
.ns-btn {
  min-width: 76px;
  padding: 7px 16px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: #fff;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-btn--danger {
  border-color: var(--ns-danger, #f56c6c);
  background: var(--ns-danger, #f56c6c);
  color: #fff;
}
</style>
