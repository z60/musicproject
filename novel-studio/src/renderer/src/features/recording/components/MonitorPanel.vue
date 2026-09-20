<!--
  Novel Studio · 监听返送设置（docs/12 §7 / docs/05 §11.2）
  ============================================================================
  设计依据：
    · docs/12 §7  —— 四种配置与各自风险；**默认关闭**；监听+麦克风直通啸叫风险高，
                     必须给强烈警告；echoCancellation 会引入处理伪影 → 可配置且要说明代价
    · docs/05 §11.2—— 监听图：[参考音] → MonitorGain → destination；麦克风直通默认关
    · docs/12 §7 坑 3 —— **监听链路的增益必须独立于录音增益**（本组件只碰监听音量）
    · docs/12 §6  —— 延迟显示（估算值）

  两段必须出现的说明文案：
    1. 开启直通时的警告 —— 取自消息表 RECORD_MONITOR_FEEDBACK（不自拼错误文案）
    2. echoCancellation 的代价 —— UI 说明性文字（非错误），逐字对应 docs/12 §7 的表述
-->

<script setup lang="ts">
import { computed } from 'vue'
import { recordingMessage } from '../stores/recording.store.ts'
import { formatDb, UNKNOWN } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  enabled: boolean
  gainDb: number
  passThrough: boolean
  echoCancellation: boolean
  autoLowerWhileRecording: boolean
  /** 录音中（用于显示「已自动降低监听音量」） */
  recordingActive?: boolean
  /** 监听延迟（毫秒，估算值） */
  latencyMs?: number | null
  /** 啸叫风险（直通 + 音量偏高） */
  feedbackRisk?: boolean
  /** 已挂进监听图的参考音/试听元素数量 */
  attachedCount?: number
  /** 采集图是否已建立（没建立时监听无输出） */
  captureReady?: boolean
}>(), {
  recordingActive: false,
  latencyMs: null,
  feedbackRisk: false,
  attachedCount: 0,
  captureReady: false,
})

const emit = defineEmits<{
  'update:enabled': [value: boolean]
  'update:gainDb': [value: number]
  'update:passThrough': [value: boolean]
  'update:echoCancellation': [value: boolean]
  'update:autoLowerWhileRecording': [value: boolean]
  /** 试听提示音（验证链路） */
  testTone: []
  /** 跳到设备诊断页（排查延迟/底噪） */
  openDiagnostics: []
}>()

/** 啸叫提示文案（消息表） */
const feedbackMessage = computed(() => recordingMessage('RECORD_MONITOR_FEEDBACK'))

const riskText = computed(() => {
  if (!props.feedbackRisk) return ''
  return `${feedbackMessage.value.title}：${feedbackMessage.value.hint ?? ''}`
})

function onGainInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('update:gainDb', value)
}

function onGainDuck(): void {
  // -6 dB 是 docs/05 §11.2 的默认监听音量，这里作为「一键回到安全值」
  emit('update:gainDb', -6)
}

const latencyText = computed(() => {
  if (props.latencyMs === null || props.latencyMs === undefined) return UNKNOWN
  // docs/12 §6.2：输入延迟读不到，显示的是「估算值」
  return `${props.latencyMs} ms（估算）`
})
</script>

<template>
  <section class="ns-monitor">
    <header class="ns-monitor__head">
      <span class="ns-monitor__title">监听返送</span>
      <label class="ns-monitor__switch">
        <input
          type="checkbox"
          :checked="enabled"
          @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
        >
        <span>{{ enabled ? '已启用' : '已关闭（默认）' }}</span>
      </label>
      <button type="button" class="ns-monitor__link" @click="emit('openDiagnostics')">设备诊断</button>
    </header>

    <div class="ns-monitor__row">
      <label class="ns-monitor__field">
        <span>监听音量</span>
        <input type="range" min="-40" max="12" step="1" :value="gainDb" :disabled="!enabled" @input="onGainInput">
        <span class="ns-monitor__value">{{ formatDb(gainDb) }}</span>
      </label>
      <button type="button" class="ns-monitor__btn" :disabled="!enabled" @click="onGainDuck">-6 dB</button>
      <button type="button" class="ns-monitor__btn" :disabled="!enabled" @click="emit('testTone')">试听提示音</button>
    </div>

    <div class="ns-monitor__row">
      <label class="ns-monitor__check">
        <input
          type="checkbox"
          :checked="passThrough"
          :disabled="!enabled"
          @change="emit('update:passThrough', ($event.target as HTMLInputElement).checked)"
        >
        <span>麦克风直通（听自己的声音，啸叫风险高）</span>
      </label>
      <label class="ns-monitor__check">
        <input
          type="checkbox"
          :checked="echoCancellation"
          :disabled="!enabled"
          @change="emit('update:echoCancellation', ($event.target as HTMLInputElement).checked)"
        >
        <span>回声消除</span>
      </label>
      <label class="ns-monitor__check">
        <input
          type="checkbox"
          :checked="autoLowerWhileRecording"
          @change="emit('update:autoLowerWhileRecording', ($event.target as HTMLInputElement).checked)"
        >
        <span>录音期间自动降低监听音量</span>
      </label>
    </div>

    <p v-if="riskText" class="ns-monitor__risk">{{ riskText }}</p>

    <p v-if="echoCancellation" class="ns-monitor__note">
      已启用回声消除：这是为通话设计的处理，音色会略有变化。追求音质请在设置中关闭它，并戴好封闭式耳机。
    </p>
    <p v-if="passThrough && !feedbackRisk" class="ns-monitor__note">
      麦克风直通已开启：请务必佩戴耳机，否则监听回放会被麦克风拾取（叠录/染色）。
    </p>
    <p v-if="enabled && !captureReady" class="ns-monitor__note">
      采集图尚未建立：监听要等设备就绪后才能出声。
    </p>

    <footer class="ns-monitor__foot">
      <span>延迟：{{ latencyText }}</span>
      <span>监听中的参考音：{{ attachedCount }} 路</span>
      <span v-if="recordingActive && autoLowerWhileRecording">录音中已自动降低 6 dB</span>
      <span class="ns-monitor__foot-hint">监听音量与录音增益相互独立，调这里不会改变录制音量。</span>
    </footer>
  </section>
</template>

<style scoped>
.ns-monitor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-monitor__head {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.ns-monitor__title {
  font-weight: 600;
}
.ns-monitor__switch,
.ns-monitor__check {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-regular, #606266);
}
.ns-monitor__link {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  font-size: 12px;
  cursor: pointer;
}
.ns-monitor__row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
}
.ns-monitor__field {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-monitor__field input[type='range'] {
  width: 140px;
}
.ns-monitor__value {
  min-width: 56px;
  color: var(--ns-text-primary, #303133);
  font-variant-numeric: tabular-nums;
}
.ns-monitor__btn {
  padding: 2px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  font-size: 12px;
  cursor: pointer;
}
.ns-monitor__btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.ns-monitor__risk {
  margin: 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: rgb(230 162 60 / 14%);
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.6;
}
.ns-monitor__note {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-monitor__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: var(--ns-text-secondary, #909399);
}
.ns-monitor__foot-hint {
  opacity: 0.9;
}
</style>
