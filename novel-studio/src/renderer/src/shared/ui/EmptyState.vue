<!--
  Novel Studio · 空态
  ============================================================================
  设计依据：
    · docs/10 §7.2 —— 书架为空、章节列表为空时必须有引导（「还没有书，点这里导入」）
    · docs/11 §4.2 —— 画本为空（未生成）要能一键跳去生成
    · docs/13 §5 —— 校验无问题时也应给「无问题」的正反馈，而不是空白

  要点：空态必须**给下一步动作**，否则用户会以为功能坏了。
-->

<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  description?: string
  /** 图标（emoji 或 Element Plus 图标名；这里用字符，避免强依赖图标包） */
  icon?: string
  /** 主按钮文案，为空则不显示按钮 */
  actionText?: string
  /** 次要提示（如「支持 txt / docx / pdf / url」） */
  hint?: string
  size?: 'default' | 'small'
  bordered?: boolean
}>(), {
  description: '',
  icon: '📚',
  actionText: '',
  hint: '',
  size: 'default',
  bordered: true,
})

const emit = defineEmits<{
  action: []
}>()
</script>

<template>
  <div
    class="ns-empty"
    :class="[`ns-empty--${size}`, { 'ns-empty--bordered': bordered }]"
  >
    <div class="ns-empty__icon" aria-hidden="true">{{ icon }}</div>
    <h3 class="ns-empty__title">{{ title }}</h3>
    <p v-if="description" class="ns-empty__desc">{{ description }}</p>
    <p v-if="hint" class="ns-empty__hint">{{ hint }}</p>
    <button
      v-if="actionText"
      type="button"
      class="ns-empty__btn"
      @click="emit('action')"
    >
      {{ actionText }}
    </button>
    <div v-if="$slots.default" class="ns-empty__extra">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ns-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 48px 24px;
  text-align: center;
}
.ns-empty--small {
  padding: 24px 16px;
}
.ns-empty--bordered {
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-empty__icon {
  font-size: 34px;
  line-height: 1;
  opacity: 0.85;
}
.ns-empty__title {
  margin: 6px 0 0;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
}
.ns-empty__desc {
  max-width: 460px;
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  line-height: 1.6;
}
.ns-empty__hint {
  max-width: 460px;
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-empty__btn {
  margin-top: 10px;
  padding: 7px 18px;
  border: 1px solid var(--ns-primary, #409eff);
  border-radius: 4px;
  background: var(--ns-primary, #409eff);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.ns-empty__extra {
  margin-top: 10px;
}
</style>
