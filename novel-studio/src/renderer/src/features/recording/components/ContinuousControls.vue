<!--
  Novel Studio · 连续录制控制条（docs/12 §4.1 / §4.2 / §9.1 / §10）
  ============================================================================
  设计依据：
    · docs/12 §4.1 —— 交互只有三件事：开始连续录制、期间打标记（M 人工切点 /
      N 标记「这段重来」）、停止后进切片确认。因此控制条上不该出现逐行模式的按钮。
    · docs/12 §4.2 —— 采集侧必须给出：已录时长（大字号）、静音指示、
      切点闪烁 + 计数、**已匹配行数**（用 VAD 计数估算，给进度感）、快捷键提示。
    · docs/12 §9.1 —— 键位**唯一来源**是 shared/lib/shortcuts.ts；本组件不写死按键，
      只吃父页面从 `useShortcuts().displayOf(id)` 传来的展示串，保证与全局绑定一致。
    · docs/12 §4.4 —— 「进切片确认」是停止之后的必经一步；这里给入口，
      但不自己触发切片（切片要主进程跑 VAD，由页面编排）。

  组件只渲染 + 抛事件：prepare/start/stop/mark 全在录音页，避免控制条被 IPC 依赖污染。
-->

<script setup lang="ts">
import { computed } from 'vue'
import type { RecordSessionState } from '@shared/types.ts'
import { formatDuration, formatInt } from '@/shared/lib/format.ts'
import type { RecordMark } from '../stores/recording.store.ts'

const props = withDefaults(defineProps<{
  /** 会话状态（主进程镜像） */
  state: RecordSessionState
  /** 已录时长（毫秒，主进程 record:status 上报） */
  durationMs?: number
  /** 本次会话的标记（M 切点 / N 重来 / note） */
  marks?: RecordMark[]
  /** 采集侧估算的语音段数（「已识别到约 N 句」，docs/12 §4.2） */
  speechRunCount?: number
  /** 当前是否处于静音（给用户「可以停了」的提示，docs/12 §4.2） */
  silence?: boolean
  /** 削波事件累计（非 0 要显眼） */
  clipEvents?: number
  /** 是否已有可确认的切片结果 */
  sliceAvailable?: boolean
  /** 正在跑 VAD 切片 */
  analyzing?: boolean
  /** 丢弃（放弃本次会话，保留/删除原始文件由页面决定） */
  disabled?: boolean
  /** id → 快捷键展示串（来自 useShortcuts.displayOf） */
  shortcuts?: Record<string, string>
  /** 是否显示「进切片确认」按钮（确认页里不需要） */
  showSliceEntry?: boolean
}>(), {
  durationMs: 0,
  marks: () => [],
  speechRunCount: 0,
  silence: false,
  clipEvents: 0,
  sliceAvailable: false,
  analyzing: false,
  disabled: false,
  shortcuts: () => ({}),
  showSliceEntry: true,
})

const emit = defineEmits<{
  start: []
  stop: []
  /** 打切点标记（record.mark / M） */
  mark: []
  /** 标记「这段重来」（continuous.retake / N） */
  retake: []
  /** 追加一条备注标记 */
  note: []
  /** 丢弃本次连续录制 */
  discard: []
  /** 进入切片确认界面 */
  openSlices: []
}>()

const isRecording = computed(() => props.state === 'recording')
const isPaused = computed(() => props.state === 'paused')
const isFinalizing = computed(() => props.state === 'finalizing')
const isPreparing = computed(() => props.state === 'preparing' || props.state === 'ready')
/** 空闲到可以开新会话的状态集合（与 TransportBar 的 canStart 口径一致） */
const canStart = computed(
  () => props.state === 'idle' || props.state === 'done' || props.state === 'ready' || props.state === 'recovered',
)

const busy = computed(() => isFinalizing.value || props.disabled)

const stateText = computed(() => {
  switch (props.state) {
    case 'idle': return '空闲'
    case 'preparing': return '准备设备…'
    case 'ready': return '就绪'
    case 'recording': return '连续录制中'
    case 'paused': return '已暂停'
    case 'finalizing': return '正在定稿，请勿关闭'
    case 'done': return '已完成'
    case 'recovered': return '由恢复产生'
    case 'failed': return '失败'
    default: return props.state
  }
})

/** 切点计数（M）：给用户「切了几刀」的量感（docs/12 §4.2「轻微计数」） */
const cutCount = computed(() => props.marks.filter(m => m.kind === 'cut').length)
const retakeCount = computed(() => props.marks.filter(m => m.kind === 'retake').length)
const noteCount = computed(() => props.marks.filter(m => m.kind === 'note').length)

/** 最近的标记（倒序展示最近 6 条，避免控制条被长列表撑开） */
const recentMarks = computed(() => [...props.marks].slice(-6).reverse())

const MARK_LABELS: Record<RecordMark['kind'], string> = {
  cut: '切点',
  retake: '重来',
  note: '备注',
}

function hint(id: string): string {
  return props.shortcuts[id] ?? ''
}
</script>

<template>
  <section class="ns-continuous" :class="{ 'is-recording': isRecording }">
    <div class="ns-continuous__main">
      <div class="ns-continuous__timer">
        <span class="ns-continuous__duration">{{ formatDuration(durationMs, { showMs: true }) }}</span>
        <span class="ns-continuous__state" :class="{ 'is-live': isRecording }">
          <span v-if="isRecording" class="ns-continuous__dot" aria-hidden="true" />
          {{ stateText }}
        </span>
      </div>

      <div class="ns-continuous__signals">
        <span class="ns-continuous__signal" :class="{ 'is-silent': silence }">
          {{ silence ? '静音中（可以停了）' : '有声音' }}
        </span>
        <span class="ns-continuous__signal">
          已识别到约 <strong>{{ formatInt(speechRunCount) }}</strong> 句（采集侧估算）
        </span>
        <span class="ns-continuous__signal" :class="{ 'is-warn': clipEvents > 0 }">
          削波事件 {{ formatInt(clipEvents) }}
        </span>
      </div>

      <div class="ns-continuous__buttons">
        <button
          v-if="canStart || !isRecording"
          type="button"
          class="ns-continuous__button is-primary"
          :disabled="busy || (!canStart && !isPaused)"
          :title="hint('record.toggle')"
          @click="emit('start')"
        >
          ● 开始连续录制<span v-if="hint('record.toggle')" class="ns-continuous__kbd">{{ hint('record.toggle') }}</span>
        </button>

        <button
          v-if="isRecording || isPaused"
          type="button"
          class="ns-continuous__button is-danger"
          :disabled="busy"
          :title="hint('record.toggle')"
          @click="emit('stop')"
        >
          ■ 停止并切片<span v-if="hint('record.toggle')" class="ns-continuous__kbd">{{ hint('record.toggle') }}</span>
        </button>

        <button
          type="button"
          class="ns-continuous__button"
          :disabled="!isRecording || busy"
          :title="hint('record.mark')"
          @click="emit('mark')"
        >
          打标记<span v-if="hint('record.mark')" class="ns-continuous__kbd">{{ hint('record.mark') }}</span>
        </button>

        <button
          type="button"
          class="ns-continuous__button"
          :disabled="!isRecording || busy"
          :title="hint('continuous.retake')"
          @click="emit('retake')"
        >
          标记重来<span v-if="hint('continuous.retake')" class="ns-continuous__kbd">{{ hint('continuous.retake') }}</span>
        </button>

        <button
          type="button"
          class="ns-continuous__button"
          :disabled="!isRecording || busy"
          @click="emit('note')"
        >
          备注标记
        </button>

        <button
          type="button"
          class="ns-continuous__button"
          :disabled="busy || isRecording || isPaused || isPreparing"
          @click="emit('discard')"
        >
          丢弃本次
        </button>

        <button
          v-if="showSliceEntry"
          type="button"
          class="ns-continuous__button is-primary"
          :disabled="analyzing || !sliceAvailable"
          @click="emit('openSlices')"
        >
          {{ analyzing ? 'VAD 分析中…' : '进切片确认' }}
        </button>
      </div>
    </div>

    <div class="ns-continuous__marks">
      <span class="ns-continuous__marks-title">
        切点 {{ cutCount }} · 重来 {{ retakeCount }} · 备注 {{ noteCount }}
      </span>
      <ul v-if="recentMarks.length" class="ns-continuous__marks-list">
        <li v-for="(mark, index) in recentMarks" :key="`${mark.kind}-${mark.atMs}-${index}`">
          <span class="ns-continuous__mark-kind" :class="`is-${mark.kind}`">{{ MARK_LABELS[mark.kind] }}</span>
          <span class="ns-continuous__mark-time">{{ formatDuration(mark.atMs, { showMs: true }) }}</span>
        </li>
      </ul>
      <span v-else class="ns-continuous__marks-empty">还没有标记（连续录制期间按 M 可人工打切点）</span>
    </div>

    <p class="ns-continuous__footnote">
      连续录制期间不要改行：切点由 VAD 自动生成，人工标记只作为切点候选（docs/12 §4.1）。
      停止后原始会话 WAV 会保留，因此可以反复重切（docs/12 §4.4）。
    </p>
  </section>
</template>

<style scoped>
.ns-continuous {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}

.ns-continuous.is-recording {
  border-color: rgb(245 108 108 / 45%);
  box-shadow: 0 0 0 1px rgb(245 108 108 / 18%);
}

.ns-continuous__main {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  align-items: center;
  justify-content: space-between;
}

.ns-continuous__timer {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ns-continuous__duration {
  font-size: 30px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1.1;
  color: var(--ns-text-primary, #303133);
}

.ns-continuous__state {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

.ns-continuous__state.is-live {
  color: var(--ns-danger, #f56c6c);
}

.ns-continuous__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentcolor;
  animation: ns-continuous-blink 1.1s ease-in-out infinite;
}

.ns-continuous__signals {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
  color: var(--ns-text-regular, #606266);
}

.ns-continuous__signal.is-silent {
  color: var(--ns-text-secondary, #909399);
}

.ns-continuous__signal.is-warn {
  color: var(--ns-danger, #f56c6c);
}

.ns-continuous__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ns-continuous__button {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 6px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  font-size: 13px;
  color: var(--ns-text-regular, #606266);
  cursor: pointer;
}

.ns-continuous__button:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}

.ns-continuous__button.is-primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}

.ns-continuous__button.is-danger {
  border-color: var(--ns-danger, #f56c6c);
  background: var(--ns-danger, #f56c6c);
  color: #fff;
}

.ns-continuous__button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ns-continuous__kbd {
  padding: 0 4px;
  border-radius: 3px;
  background: rgb(0 0 0 / 12%);
  font-size: 11px;
}

.ns-continuous__marks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

.ns-continuous__marks-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ns-continuous__marks-list li {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 1px 6px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 3px;
}

.ns-continuous__mark-kind.is-cut {
  color: var(--ns-primary, #409eff);
}

.ns-continuous__mark-kind.is-retake {
  color: var(--ns-warning, #e6a23c);
}

.ns-continuous__mark-time {
  font-variant-numeric: tabular-nums;
  color: var(--ns-text-regular, #606266);
}

.ns-continuous__footnote {
  margin: 0;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}

@keyframes ns-continuous-blink {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.25;
  }
}
</style>
