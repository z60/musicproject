<!--
  Novel Studio · 录音倒计时遮罩（docs/12 §3.2「可选倒计时（默认 3 秒，可关；按下录制键立即开始）」）
  ============================================================================
  设计依据：
    · docs/12 §3.2 —— 录制循环第 2 步：可选倒计时；按下录制键要能**立即开始**，
      因此这里必须支持「按任意键取消」（取消 = 让录音页立刻跳过倒计时开始录音，
      或者干脆放弃本次录制，由父组件决定语义 —— 组件只抛 `cancel`）。
    · docs/04 §8.2 —— 时长的唯一来源是设置 `audio.countdownMs`（0 表示不倒计时），
      组件**不自己写默认值**，只在父组件没传 totalMs 时读设置。

  为什么「按任意键」而不是只认 Esc：
    配音员通常是站着/戴着耳机操作，眼睛在稿子上。倒计时遮罩是整屏遮挡，
    此时「敲任意键」是唯一直觉动作；只认 Esc 会让人以为界面卡住。

  事件语义（父组件负责真正的推进）：
    cancel   —— 用户取消倒计时。父组件可以「立刻开始录音」或「取消本次录制」；
    组件不做任何录音动作，也不弹提示（错误/提示一律走 error-bus）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useSettingsStore } from '@/app/store/settings.store.ts'

const props = withDefaults(defineProps<{
  /** 是否显示（父组件控制；倒计时归零后由父组件置 false） */
  visible: boolean
  /** 剩余秒数（父组件每 100 ms 更新一次，这里只做展示） */
  seconds: number
  /**
   * 本段倒计时总时长（毫秒）。
   * 不传（null）时取设置 `audio.countdownMs` —— 它是文件里唯一的默认值来源。
   */
  totalMs?: number | null
  /** 是否允许「按任意键取消」（录制前的倒计时应允许；自动连录场景可关掉） */
  cancellable?: boolean
  /** 取消提示文案（父组件可传「按任意键立刻开始」） */
  cancelHint?: string
}>(), {
  totalMs: null,
  cancellable: true,
  cancelHint: '按任意键立刻开始',
})

const emit = defineEmits<{
  /** 用户取消倒计时（父组件决定是「立即开始」还是「放弃本次录制」） */
  cancel: []
}>()

const settings = useSettingsStore()

/** 设置里的倒计时（0 = 关闭，见 docs/12 §3.2） */
const configuredMs = computed(() => settings.audio?.countdownMs ?? 0)
const effectiveMs = computed(() => {
  const total = props.totalMs
  if (typeof total === 'number' && total > 0) return total
  return configuredMs.value > 0 ? configuredMs.value : 0
})

/** 已过去的比例（0~1），用于外圈的进度环 */
const progress = computed(() => {
  if (!(effectiveMs.value > 0)) return 0
  const remainingMs = Math.max(0, props.seconds * 1000)
  return Math.min(1, Math.max(0, 1 - remainingMs / effectiveMs.value))
})

/** 大字只显示整数秒（父组件可能给 2.4 这种值） */
const displaySeconds = computed(() => Math.max(0, Math.ceil(props.seconds)))

/** 剩余不足 1 秒时高亮（给配音员一个可预判的视觉节拍） */
const urgent = computed(() => props.seconds > 0 && props.seconds <= 1)

const ringStyle = computed(() => ({
  '--ns-countdown-progress': String(progress.value),
}))

function onKeydown(event: KeyboardEvent): void {
  if (!props.visible || !props.cancellable) return
  // 倒计时期间不接受「纯修饰键」——用户按住 Ctrl 准备快捷键时不该被当成取消
  if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') return
  event.preventDefault()
  event.stopPropagation()
  emit('cancel')
}

/**
 * capture 阶段注册：倒计时是整屏遮罩，必须抢在 useShortcuts 之前吃掉这次按键，
 * 否则 `Space` 会同时触发「开始录音」与「取消倒计时」，语义就乱了。
 */
watch(
  () => props.visible,
  (visible) => {
    if (visible) globalThis.addEventListener?.('keydown', onKeydown, true)
    else globalThis.removeEventListener?.('keydown', onKeydown, true)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('keydown', onKeydown, true)
})

function onOverlayClick(): void {
  if (!props.cancellable) return
  emit('cancel')
}
</script>

<template>
  <div
    v-if="visible"
    class="ns-countdown"
    role="dialog"
    aria-modal="true"
    aria-label="录音倒计时"
    @click.self="onOverlayClick"
  >
    <div class="ns-countdown__panel" @click.stop>
      <p class="ns-countdown__title">准备开始录音</p>

      <div
        class="ns-countdown__ring"
        :class="{ 'is-urgent': urgent }"
        :style="ringStyle"
      >
        <span class="ns-countdown__number">{{ displaySeconds }}</span>
        <span class="ns-countdown__unit">秒</span>
      </div>

      <p class="ns-countdown__hint">
        {{ cancellable ? cancelHint : '倒计时结束后自动开始' }}
      </p>

      <!-- 设置来源要写清楚：用户不知道去哪儿关掉它会以为软件坏了（docs/12 §3.2） -->
      <p class="ns-countdown__source">
        倒计时时长来自设置 <code>audio.countdownMs</code>：
        {{ effectiveMs > 0 ? `${effectiveMs} ms` : '未启用（0 = 不倒计时）' }}
      </p>

      <div class="ns-countdown__actions">
        <button
          type="button"
          class="ns-countdown__button"
          :disabled="!cancellable"
          @click="emit('cancel')"
        >
          {{ cancellable ? '取消（任意键）' : '不可取消' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ns-countdown {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 52%);
  backdrop-filter: blur(2px);
}

.ns-countdown__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 28px 36px;
  border-radius: 14px;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: 0 12px 40px rgb(0 0 0 / 28%);
}

.ns-countdown__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ns-text-primary, #303133);
}

/* 进度环：用 conic-gradient 画弧，不做 DOM 逐帧重排 */
.ns-countdown__ring {
  position: relative;
  display: flex;
  align-items: baseline;
  justify-content: center;
  width: 132px;
  height: 132px;
  border-radius: 50%;
  background: conic-gradient(
    var(--ns-primary, #409eff) calc(var(--ns-countdown-progress, 0) * 360deg),
    var(--ns-fill, #ebeef5) 0
  );
}

.ns-countdown__ring::after {
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: var(--ns-bg-elevated, #fff);
  content: '';
}

.ns-countdown__ring.is-urgent {
  background: conic-gradient(
    var(--ns-danger, #f56c6c) calc(var(--ns-countdown-progress, 0) * 360deg),
    var(--ns-fill, #ebeef5) 0
  );
  animation: ns-countdown-pulse 0.6s ease-in-out infinite;
}

.ns-countdown__number {
  z-index: 1;
  align-self: center;
  font-size: 54px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1;
  color: var(--ns-text-primary, #303133);
}

.ns-countdown__unit {
  z-index: 1;
  align-self: flex-end;
  margin-bottom: 34px;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

.ns-countdown__hint {
  margin: 0;
  font-size: 13px;
  color: var(--ns-text-regular, #606266);
}

.ns-countdown__source {
  margin: 0;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

.ns-countdown__source code {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
}

.ns-countdown__actions {
  display: flex;
  gap: 8px;
}

.ns-countdown__button {
  padding: 6px 18px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-regular, #606266);
  cursor: pointer;
}

.ns-countdown__button:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}

.ns-countdown__button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@keyframes ns-countdown-pulse {
  0%,
  100% {
    transform: scale(1);
  }

  50% {
    transform: scale(1.04);
  }
}
</style>
