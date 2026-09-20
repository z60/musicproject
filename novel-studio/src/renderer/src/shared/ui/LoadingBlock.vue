<!--
  Novel Studio · 加载占位块
  ============================================================================
  设计依据：
    · docs/13 §4.5 —— 时间线/检查器在载入时需要骨架，避免布局跳动
    · docs/10 §7   —— 向导每一步解析（可能几秒）都要有「正在处理」的可见反馈
    · docs/00 非功能指标 —— 首屏与长列表加载不能出现无反馈的空白

  两种形态：
    · spinner：短时等待（< 1s 的 IPC 查询）
    · skeleton：结构性等待（列表/表格首次载入），行数可配
-->

<script setup lang="ts">
withDefaults(defineProps<{
  text?: string
  variant?: 'spinner' | 'skeleton'
  /** skeleton 行数 */
  rows?: number
  /** 容器最小高度，避免加载完成时布局跳动 */
  minHeight?: string
  /** 骨架行的宽度比例（模拟真实内容的不齐整） */
  widths?: number[]
}>(), {
  text: '加载中…',
  variant: 'spinner',
  rows: 5,
  minHeight: '160px',
  widths: () => [92, 78, 85, 70, 88],
})

const emit = defineEmits<{
  /** 超时后用户可点「重试」 */
  retry: []
}>()

defineSlots<{
  default?: () => unknown
}>()
</script>

<template>
  <div class="ns-loading" :style="{ minHeight }" role="status" aria-live="polite">
    <template v-if="variant === 'spinner'">
      <div class="ns-loading__spinner" aria-hidden="true" />
      <p class="ns-loading__text">{{ text }}</p>
      <button type="button" class="ns-loading__retry" @click="emit('retry')">重试</button>
    </template>

    <template v-else>
      <div v-for="index in rows" :key="index" class="ns-loading__row">
        <div
          class="ns-loading__bar"
          :style="{ width: `${widths[(index - 1) % widths.length] ?? 80}%` }"
        />
      </div>
      <p class="ns-loading__text ns-loading__text--skeleton">{{ text }}</p>
    </template>
  </div>
</template>

<style scoped>
.ns-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 16px;
}
.ns-loading__spinner {
  width: 26px;
  height: 26px;
  border: 3px solid var(--ns-fill, #ebeef5);
  border-top-color: var(--ns-primary, #409eff);
  border-radius: 50%;
  animation: ns-spin 0.9s linear infinite;
}
@keyframes ns-spin {
  to { transform: rotate(360deg); }
}
.ns-loading__text {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
}
.ns-loading__text--skeleton {
  align-self: flex-start;
  margin-top: 6px;
  font-size: 12px;
}
.ns-loading__retry {
  padding: 4px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.ns-loading__row {
  width: 100%;
}
.ns-loading__bar {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--ns-fill, #ebeef5) 25%, var(--ns-fill-light, #f5f7fa) 37%, var(--ns-fill, #ebeef5) 63%);
  background-size: 400% 100%;
  animation: ns-shimmer 1.4s ease infinite;
}
@keyframes ns-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}
</style>
