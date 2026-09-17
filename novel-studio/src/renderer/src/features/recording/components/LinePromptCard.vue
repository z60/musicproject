<!--
  Novel Studio · 当前行提示卡（docs/12 §3.1 / §3.3 / §5）
  ============================================================================
  设计依据：
    · docs/12 §3.1 —— 「当前行 42/87 ▸ 说话人 ▸ 情绪 ▸ 语速」+ 台词 + 备注 + 发音提示
                      + 上下文前后各一行
    · docs/12 §3.3 —— 预计时长来自「字数 / 语速 × 情绪系数」（docs/05 §4.4 的估算口径）
    · docs/12 §5   —— 任务包（角色模式）下画本**只读**：不能改文本、不能改说话人；
                      允许「标记文本有问题」与「添加个人备注（本地）」
    · docs/22 §6.2 —— 只读原因的文案取自消息表（PACKAGE_TASK_READONLY），不自拼

  为什么把「原文对照」放在这一张卡里：
    画本行的 text 可能被人工改过（docs/11 §2），录的时候必须能一眼看到「念的和原文差在哪」，
    否则改错了没人发现。差异在卡片内直接并排显示，不跳页。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { EMOTIONS, LINE_KIND_LABELS, LINE_STATE_LABELS, SPEED_OPTIONS } from '@shared/constants.ts'
import type { CanvasLine, SpeedMark } from '@shared/types.ts'
import { UNKNOWN, formatDurationLong, formatScore, text as textOr } from '@/shared/lib/format.ts'
import { recordingMessage } from '../stores/recording.store.ts'

const props = withDefaults(defineProps<{
  /** 当前要录的行（未加载出来时为 null） */
  line: CanvasLine | null
  /** 上下文：前一行 */
  prevLine?: CanvasLine | null
  /** 上下文：后一行 */
  nextLine?: CanvasLine | null
  /** 说话人显示名（角色名或「旁白」），由页面解析后传入，避免组件里跨域查角色表 */
  speakerName?: string
  /** 行进度展示（如 `42/87`） */
  lineProgress?: string
  /** 预计朗读时长（毫秒）—— 由页面按字数/语速/情绪系数算好传入 */
  estimatedDurationMs?: number | null
  /** 速算用的语速（字/秒），仅用于展示「按 4.2 字/秒估算」 */
  charsPerSecond?: number
  /** 该行已录 take 数 / 是否已有成品 */
  takeCount?: number
  hasSelectedTake?: boolean
  /** 任务包（角色模式）只读 */
  readonly?: boolean
  /** 该行是否被标记「本轮跳过」（docs/12 §3.3） */
  skipped?: boolean
}>(), {
  prevLine: null,
  nextLine: null,
  speakerName: '旁白',
  lineProgress: '',
  estimatedDurationMs: null,
  charsPerSecond: 4.2,
  takeCount: 0,
  hasSelectedTake: false,
  readonly: false,
  skipped: false,
})

const emit = defineEmits<{
  /** 请求编辑该行（跳画本编辑；只读模式下不应发出） */
  edit: []
  /** 标记「文本有问题」（任务包模式下生成反馈项，docs/12 §5） */
  report: []
  /** 添加/编辑个人备注（本地） */
  annotate: []
}>()

/** 情绪强度 1~5（docs/11 §5 的语义） */
const emotionLabel = computed(() => {
  const line = props.line
  if (!line?.emotion) return UNKNOWN
  const intensity = line.emotionIntensity
  const base = EMOTIONS.includes(line.emotion as typeof EMOTIONS[number]) ? line.emotion : line.emotion
  return intensity === null || intensity === undefined ? base : `${base}(${intensity})`
})

const speedLabel = computed(() => {
  const speed = props.line?.speed ?? null
  if (!speed) return '正常'
  return SPEED_OPTIONS.find(o => o.value === (speed as SpeedMark))?.label ?? speed
})

const pauseLabel = computed(() => {
  const pause = props.line?.pauseAfterMs
  if (pause === null || pause === undefined) return UNKNOWN
  return `${pause} ms`
})

const kindLabel = computed(() => (props.line ? (LINE_KIND_LABELS[props.line.kind] ?? props.line.kind) : UNKNOWN))
const stateLabel = computed(() => (props.line ? (LINE_STATE_LABELS[props.line.state] ?? props.line.state) : UNKNOWN))

/** 原文对照：只有当 text 与 sourceText 不同才显示，避免正常行被噪音占满 */
const hasSourceDiff = computed(() => {
  const line = props.line
  if (!line?.sourceText) return false
  return line.sourceText.trim() !== line.text.trim()
})

/** 只读原因（文案取自消息表，不自拼） */
const readonlyHint = computed(() => recordingMessage('PACKAGE_TASK_READONLY'))

const estimatedText = computed(() => {
  if (props.estimatedDurationMs === null) return UNKNOWN
  return `约 ${formatDurationLong(props.estimatedDurationMs)}（按 ${formatScore(props.charsPerSecond, 1)} 字/秒估算）`
})

/** 字里挑多音字不做自动替换，只在有 pronunciation 提示时显示（docs/11 §5） */
const pronunciation = computed(() => props.line?.pronunciation ?? null)

function contextLine(line: CanvasLine | null | undefined): string {
  if (!line) return UNKNOWN
  const speaker = line.speakerType === 'narration' ? '旁白' : '角色'
  return `${line.seq} (${speaker}) ${line.text}`
}
</script>

<template>
  <section class="ns-prompt" :class="{ 'is-readonly': readonly, 'is-empty': !line }">
    <header class="ns-prompt__head">
      <span v-if="lineProgress" class="ns-prompt__progress">当前行 {{ lineProgress }}</span>
      <span v-if="line" class="ns-prompt__speaker">▸ {{ speakerName }}</span>
      <span v-if="line" class="ns-prompt__tag">情绪：{{ emotionLabel }}</span>
      <span v-if="line" class="ns-prompt__tag">语速：{{ speedLabel }}</span>
      <span v-if="line" class="ns-prompt__tag">句末停顿：{{ pauseLabel }}</span>
      <span v-if="line" class="ns-prompt__tag">{{ kindLabel }} · {{ stateLabel }}</span>
      <span v-if="skipped" class="ns-prompt__tag ns-prompt__tag--warn">本轮跳过</span>
      <span v-if="line" class="ns-prompt__tag ns-prompt__tag--muted">
        take {{ takeCount }}{{ hasSelectedTake ? '（已选成品）' : '（未选成品）' }}
      </span>
    </header>

    <!-- 空态：画本行还没加载出来时也要说清下一步，而不是一片空白 -->
    <div v-if="!line" class="ns-prompt__empty">
      <p class="ns-prompt__empty-title">还没有可录的台词行</p>
      <p class="ns-prompt__empty-hint">
        请先在「画本编辑」里生成/检查本章画本；没有画本行时也可以直接录音，
        素材会存为会话文件，稍后再绑定到行上。
      </p>
      <button type="button" class="ns-prompt__btn" @click="emit('edit')">前往画本编辑</button>
    </div>

    <template v-else>
      <p class="ns-prompt__text">{{ line.text }}</p>

      <div v-if="hasSourceDiff" class="ns-prompt__source">
        <span class="ns-prompt__source-label">原文对照</span>
        <span class="ns-prompt__source-text">{{ textOr(line.sourceText) }}</span>
      </div>

      <dl class="ns-prompt__meta">
        <div class="ns-prompt__meta-item">
          <dt>预计时长</dt>
          <dd>{{ estimatedText }}</dd>
        </div>
        <div class="ns-prompt__meta-item">
          <dt>发音提示</dt>
          <dd>{{ pronunciation ? pronunciation : '无' }}</dd>
        </div>
        <div class="ns-prompt__meta-item">
          <dt>备注</dt>
          <dd>{{ line.note ? line.note : '无' }}</dd>
        </div>
      </dl>

      <div class="ns-prompt__context">
        <span class="ns-prompt__context-label">上下文</span>
        <p class="ns-prompt__context-line">{{ contextLine(prevLine) }}</p>
        <p class="ns-prompt__context-line">{{ contextLine(nextLine) }}</p>
      </div>

      <footer class="ns-prompt__actions">
        <template v-if="readonly">
          <p class="ns-prompt__readonly" :title="readonlyHint.detail">
            {{ readonlyHint.title }}：{{ readonlyHint.detail }}
          </p>
          <button type="button" class="ns-prompt__btn" @click="emit('report')">标记文本有问题</button>
          <button type="button" class="ns-prompt__btn" @click="emit('annotate')">添加个人备注</button>
        </template>
        <template v-else>
          <button type="button" class="ns-prompt__btn" @click="emit('edit')">编辑该行</button>
          <button type="button" class="ns-prompt__btn" @click="emit('annotate')">行备注</button>
        </template>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.ns-prompt {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-prompt.is-readonly {
  border-style: dashed;
}
.ns-prompt__head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-prompt__progress {
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-prompt__speaker {
  color: var(--ns-primary, #409eff);
  font-weight: 600;
}
.ns-prompt__tag--warn {
  color: var(--ns-warning, #e6a23c);
}
.ns-prompt__tag--muted {
  opacity: 0.85;
}
.ns-prompt__text {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 22px;
  font-weight: 600;
  line-height: 1.6;
  word-break: break-word;
}
.ns-prompt__text::before {
  content: '「';
  color: var(--ns-text-placeholder, #c0c4cc);
}
.ns-prompt__text::after {
  content: '」';
  color: var(--ns-text-placeholder, #c0c4cc);
}
.ns-prompt__source {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  font-size: 13px;
}
.ns-prompt__source-label {
  flex: 0 0 auto;
  color: var(--ns-text-secondary, #909399);
}
.ns-prompt__source-text {
  color: var(--ns-text-regular, #606266);
}
.ns-prompt__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 6px 16px;
  margin: 0;
}
.ns-prompt__meta-item {
  display: flex;
  gap: 6px;
  font-size: 12px;
}
.ns-prompt__meta-item dt {
  flex: 0 0 auto;
  color: var(--ns-text-secondary, #909399);
}
.ns-prompt__meta-item dd {
  margin: 0;
  color: var(--ns-text-regular, #606266);
}
.ns-prompt__context {
  padding: 8px 10px;
  border-left: 3px solid var(--ns-border, #dcdfe6);
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-prompt__context-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-prompt__context-line {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
  line-height: 1.6;
}
.ns-prompt__empty {
  padding: 12px 0;
}
.ns-prompt__empty-title {
  margin: 0 0 4px;
  font-weight: 600;
}
.ns-prompt__empty-hint {
  margin: 0 0 10px;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
  line-height: 1.6;
}
.ns-prompt__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.ns-prompt__readonly {
  flex: 1 1 240px;
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-prompt__btn {
  padding: 4px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: #fff;
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  cursor: pointer;
}
.ns-prompt__btn:hover {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
</style>
