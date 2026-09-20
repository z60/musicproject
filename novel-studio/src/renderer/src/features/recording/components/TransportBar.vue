<!--
  Novel Studio · 走带控制条（docs/12 §3.1 底部 / §2 状态机 / §9 快捷键）
  ============================================================================
  设计依据：
    · docs/12 §2  —— 按钮的可用性**完全**由会话状态机决定：
                     idle → 可开始；recording → 暂停/停止/打标记；
                     paused → 继续/停止；finalizing → 全部禁用且显示「正在保存，请勿关闭」
    · docs/12 §3.1—— 布局：倒计时开关、上一行、录制/停止、下一行、跳过、补录
    · docs/12 §3.3—— 录音中禁止改行（会误导）；因此上下行按钮在录音期间禁用
    · docs/12 §9.1—— 按钮上要显示快捷键提示（用户不必记）

  组件只负责「渲染 + 抛事件」，任何业务（准备会话、停止定稿、跳行）都在录音页里做：
  这样走带栏不会被 IPC 依赖污染，也能在同一页的三种模式里复用。
-->

<script setup lang="ts">
import { computed } from 'vue'
import type { RecordSessionState, RecordingMode } from '@shared/types.ts'
import { formatDuration } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  state: RecordSessionState
  mode: RecordingMode
  /** 已录时长（毫秒，主进程上报） */
  durationMs?: number
  /** 行进度 */
  lineProgress?: string
  /** 本行 take 数 / 是否已选成品 */
  takeCount?: number
  hasSelectedTake?: boolean
  /** 倒计时（毫秒；0 = 关闭倒计时） */
  countdownMs?: number
  /** 自动跳下一行（默认跳到下一个未录行，docs/12 §3.3） */
  autoNext?: boolean
  /** 是否允许补录（需要先选中一个 take） */
  canPunchIn?: boolean
  /** 是否已选中区间（补录区间的起止都在该 take 内） */
  hasPunchRange?: boolean
  /** id → 快捷键展示串（来自 useShortcuts.displayOf） */
  shortcuts?: Record<string, string>
  /** 磁盘不足：开始按钮要禁用并说明原因 */
  diskLow?: boolean
  compact?: boolean
}>(), {
  durationMs: 0,
  lineProgress: '',
  takeCount: 0,
  hasSelectedTake: false,
  countdownMs: 3000,
  autoNext: true,
  canPunchIn: false,
  hasPunchRange: false,
  shortcuts: () => ({}),
  diskLow: false,
  compact: false,
})

const emit = defineEmits<{
  record: []
  stop: []
  pause: []
  resume: []
  prev: []
  next: []
  skip: []
  redo: []
  mark: []
  punchIn: []
  'update:countdownMs': [value: number]
  'update:autoNext': [value: boolean]
  /** 呼出快捷键速查面板 */
  help: []
}>()

const isFinalizing = computed(() => props.state === 'finalizing')
const isRecording = computed(() => props.state === 'recording')
const isPaused = computed(() => props.state === 'paused')
const isPreparing = computed(() => props.state === 'preparing' || props.state === 'ready')
const canNavigate = computed(() => !isRecording.value && !isPaused.value && !isFinalizing.value)
const canStart = computed(() => props.state === 'idle' || props.state === 'done' || props.state === 'ready' || props.state === 'recovered')

/** 快捷键提示：按钮上显示为 `<kbd>`，没有配置就不显示 */
function hint(id: string): string {
  return props.shortcuts[id] ?? ''
}

const stateText = computed(() => {
  switch (props.state) {
    case 'idle': return '空闲'
    case 'preparing': return '准备设备…'
    case 'ready': return '就绪'
    case 'recording': return '录制中'
    case 'paused': return '已暂停'
    case 'finalizing': return '正在保存，请勿关闭'
    case 'done': return '已完成'
    case 'recovered': return '由恢复产生'
    case 'failed': return '失败'
    default: return props.state
  }
})

/** 倒计时档位（0 = 立即开始，docs/12 §3.2「可选倒计时」） */
const COUNTDOWN_CHOICES = [0, 1000, 2000, 3000, 5000]

function onCountdownChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  emit('update:countdownMs', Number.isFinite(value) ? value : 0)
}
</script>

<template>
  <footer class="ns-transport" :class="{ 'is-compact': compact, 'is-finalizing': isFinalizing }">
    <div class="ns-transport__group">
      <button
        type="button"
        class="ns-btn"
        :disabled="!canNavigate"
        :title="`上一行 ${hint('line.prev')}`"
        @click="emit('prev')"
      >
        ◀ 上一行 <kbd v-if="hint('line.prev')">{{ hint('line.prev') }}</kbd>
      </button>

      <button
        v-if="!isRecording && !isPaused"
        type="button"
        class="ns-btn ns-btn--record"
        :disabled="!canStart || diskLow || isFinalizing"
        :title="diskLow ? '磁盘空间不足，无法开始录音' : `开始录音 ${hint('record.toggle')}`"
        @click="emit('record')"
      >
        ● 录制 <kbd v-if="hint('record.toggle')">{{ hint('record.toggle') }}</kbd>
      </button>

      <template v-else>
        <button
          type="button"
          class="ns-btn ns-btn--stop"
          :title="`停止并保存 ${hint('record.toggle')}`"
          @click="emit('stop')"
        >
          ■ 停止 <kbd v-if="hint('record.toggle')">{{ hint('record.toggle') }}</kbd>
        </button>
        <button
          v-if="isRecording"
          type="button"
          class="ns-btn"
          title="暂停采集（已采集的缓冲会先写完）"
          @click="emit('pause')"
        >
          ⏸ 暂停
        </button>
        <button v-else type="button" class="ns-btn" title="继续采集" @click="emit('resume')">
          ⏵ 继续
        </button>
      </template>

      <button
        type="button"
        class="ns-btn"
        :disabled="!canNavigate"
        :title="`下一行 ${hint('line.next')}`"
        @click="emit('next')"
      >
        下一行 ▶ <kbd v-if="hint('line.next')">{{ hint('line.next') }}</kbd>
      </button>

      <button
        type="button"
        class="ns-btn"
        :disabled="!canNavigate"
        :title="`跳过本轮 ${hint('line.skip')}`"
        @click="emit('skip')"
      >
        跳过 <kbd v-if="hint('line.skip')">{{ hint('line.skip') }}</kbd>
      </button>
    </div>

    <div class="ns-transport__group">
      <button
        type="button"
        class="ns-btn"
        :disabled="isFinalizing"
        :title="`丢弃本次并重新录 ${hint('record.redo')}`"
        @click="emit('redo')"
      >
        ⟲ 重录 <kbd v-if="hint('record.redo')">{{ hint('record.redo') }}</kbd>
      </button>

      <button
        type="button"
        class="ns-btn"
        :disabled="!isRecording"
        :title="`在当前位置打标记 ${hint('record.mark')}`"
        @click="emit('mark')"
      >
        ⚑ 打标记 <kbd v-if="hint('record.mark')">{{ hint('record.mark') }}</kbd>
      </button>

      <button
        type="button"
        class="ns-btn"
        :disabled="!canPunchIn || isFinalizing"
        :title="hasPunchRange
          ? '对选中区间补录（先播 pre-roll 再自动开录）'
          : '请先在 take 上选择要修补的区间'"
        @click="emit('punchIn')"
      >
        ✚ 补录
      </button>

      <button type="button" class="ns-btn" title="快捷键速查与冲突检测" @click="emit('help')">
        ⌘ 快捷键
      </button>
    </div>

    <div class="ns-transport__status">
      <span class="ns-transport__dot" :class="`is-${state} `" />
      <span class="ns-transport__state">{{ stateText }}</span>
      <span v-if="isRecording || isPaused" class="ns-transport__timer">{{ formatDuration(durationMs, { showMs: true }) }}</span>
      <span v-if="lineProgress" class="ns-transport__lines">{{ lineProgress }}</span>
      <span class="ns-transport__takes">
        take {{ takeCount }}{{ hasSelectedTake ? ' · 已选成品' : ' · 未选成品' }}
      </span>
    </div>

    <div class="ns-transport__options">
      <label class="ns-transport__field">
        <span>倒计时</span>
        <select :value="countdownMs" :disabled="isRecording || isPaused" @change="onCountdownChange">
          <option v-for="choice in COUNTDOWN_CHOICES" :key="choice" :value="choice">
            {{ choice === 0 ? '关闭' : `${choice / 1000} 秒` }}
          </option>
        </select>
      </label>

      <label class="ns-transport__field ns-transport__field--check">
        <input
          type="checkbox"
          :checked="autoNext"
          :disabled="isRecording || isPaused"
          @change="emit('update:autoNext', ($event.target as HTMLInputElement).checked)"
        >
        <span>录完跳下一未录行</span>
      </label>

      <span v-if="isPreparing" class="ns-transport__hint">正在申请设备与加载采集模块…</span>
      <span v-if="diskLow" class="ns-transport__hint ns-transport__hint--bad">磁盘可用空间不足，已阻止开始录音</span>
    </div>
  </footer>
</template>

<style scoped>
.ns-transport {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  align-items: center;
  padding: 10px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-transport.is-finalizing {
  border-color: var(--ns-warning, #e6a23c);
}
.ns-transport__group {
  display: flex;
  gap: 6px;
  align-items: center;
}
.ns-btn {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 6px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 6px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.ns-btn--record {
  border-color: var(--ns-danger, #f56c6c);
  color: var(--ns-danger, #f56c6c);
  font-weight: 600;
}
.ns-btn--stop {
  border-color: var(--ns-danger, #f56c6c);
  background: var(--ns-danger, #f56c6c);
  color: #fff;
  font-weight: 600;
}
kbd {
  padding: 0 4px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 10px;
  font-family: inherit;
}
.ns-transport__status {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-transport__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ns-text-placeholder, #c0c4cc);
}
.ns-transport__dot.is-recording {
  background: var(--ns-danger, #f56c6c);
  box-shadow: 0 0 0 3px rgb(245 108 108 / 25%);
}
.ns-transport__dot.is-paused {
  background: var(--ns-warning, #e6a23c);
}
.ns-transport__timer {
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.ns-transport__options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  margin-left: auto;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-transport__field {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.ns-transport__field select {
  padding: 3px 6px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  font-size: 12px;
}
.ns-transport__hint--bad {
  color: var(--ns-danger, #f56c6c);
}
</style>
