<!--
  Novel Studio · 自动保存指示（保存中 / 已保存 / 保存失败）
  ============================================================================
  设计依据（这是 docs/11 §4.9 的硬性要求）：
    > 失败处理：写库失败 → 顶部红条「保存失败，你的修改仍在内存中」+ 重试按钮
    > （**不能让用户以为存上了**）

  因此三态的语义必须严格区分：
    · dirty    —— 有改动还没落库（灰）
    · saving   —— 正在写库（蓝，转圈）
    · saved    —— 已落库（绿，可显示时间）
    · error    —— **红线 + 「修改仍在内存中」+ 重试/放弃修改**（红，且不自动消失）

  与 useEditableField 配合（状态来源就是它）：
    const field = useEditableField(line.text, { write })
    <AutoSaveIndicator :status="field.status.value" :saved-at="field.savedAt.value" @retry="field.flush()" />
-->

<script setup lang="ts">
import { computed } from 'vue'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import { formatDate } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  status: SaveStatus
  /** 最近一次成功落库时间（毫秒） */
  savedAt?: number | null
  /** 失败时的原因（一般来自 error-bus 已兑现的 AppError.message） */
  errorText?: string | null
  /** 失败时是否给「重试」按钮 */
  retryable?: boolean
  /** 失败时是否给「放弃修改（回滚）」按钮 */
  revertable?: boolean
  compact?: boolean
}>(), {
  savedAt: null,
  errorText: null,
  retryable: true,
  revertable: true,
  compact: false,
})

const emit = defineEmits<{
  retry: []
  revert: []
}>()

const text = computed(() => {
  switch (props.status) {
    case 'dirty': return '有未保存的修改'
    case 'saving': return '保存中…'
    case 'saved': return props.savedAt ? `已保存 ${formatDate(props.savedAt, 'HH:mm:ss')}` : '已保存'
    case 'error': return '保存失败'
    default: return '已同步'
  }
})

const tone = computed(() => {
  switch (props.status) {
    case 'saving': return 'info'
    case 'saved': return 'success'
    case 'error': return 'danger'
    case 'dirty': return 'warning'
    default: return 'muted'
  }
})

const showRetry = computed(() => props.status === 'error' && props.retryable)
const showRevert = computed(() => props.status === 'error' && props.revertable)
</script>

<template>
  <div class="ns-save" :class="[`ns-save--${tone}`, { 'ns-save--compact': compact }]" role="status" aria-live="polite">
    <span class="ns-save__dot" aria-hidden="true" />
    <span class="ns-save__text">{{ text }}</span>

    <!-- 关键文案：必须明确告知改动还在内存里（docs/11 §4.9） -->
    <template v-if="status === 'error'">
      <span class="ns-save__critical">你的修改仍在内存中，尚未写入数据库。</span>
      <span v-if="errorText" class="ns-save__reason">{{ errorText }}</span>

      <span class="ns-save__actions">
        <button v-if="showRetry" type="button" class="ns-save__btn" @click="emit('retry')">重试</button>
        <button v-if="showRevert" type="button" class="ns-save__btn ns-save__btn--ghost" @click="emit('revert')">放弃修改</button>
      </span>
    </template>
  </div>
</template>

<style scoped>
.ns-save {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.ns-save--compact {
  padding: 2px 6px;
  font-size: 11px;
}
.ns-save--info {
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}
.ns-save--success {
  background: rgb(103 194 58 / 12%);
  color: var(--ns-success, #67c23a);
}
.ns-save--warning {
  background: rgb(230 162 60 / 12%);
  color: var(--ns-warning, #e6a23c);
}
.ns-save--danger {
  background: rgb(245 108 108 / 14%);
  color: var(--ns-danger, #f56c6c);
}
.ns-save--muted {
  color: var(--ns-text-secondary, #909399);
}
.ns-save__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentcolor;
}
.ns-save--info .ns-save__dot {
  animation: ns-pulse 1s ease-in-out infinite;
}
@keyframes ns-pulse {
  50% { opacity: 0.3; }
}
.ns-save__text {
  font-weight: 600;
}
.ns-save__critical {
  font-weight: 600;
}
.ns-save__reason {
  max-width: 360px;
  overflow: hidden;
  opacity: 0.85;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-save__actions {
  display: inline-flex;
  gap: 6px;
}
.ns-save__btn {
  padding: 1px 8px;
  border: 1px solid currentcolor;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
}
.ns-save__btn--ghost {
  opacity: 0.8;
}
</style>
