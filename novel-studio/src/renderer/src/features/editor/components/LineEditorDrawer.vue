<!--
  画本编辑 · 单行编辑抽屉（全部字段，docs/11 §4.4）
  ============================================================================
  必须包含（docs/11 §4.4）：
    · 全部字段：text / kind / speakerType / characterId / emotion / emotionIntensity /
      speed / gainDb / pauseAfterMs / pauseInline / pronunciation / note / flags / needsReview
    · **候选列表**：Top-3 角色及其分数，点击即改（比下拉找角色快得多）
    · **原文片段**：显示 sourceText 与上下文（前后各 2 行原始文本）
    · **试听**：若已录音，直接播放（不需要跳到录音页）
    · **强制标记**：decidedBy='human'（改过就自动设置）
    · **备注**：给配音员看

  自动保存（docs/11 §4.9）：
    · 文本 / 备注 → useEditableField 防抖 500 ms
    · 标记类（类型、语速、音量、停顿、发音、待确认）→ useImmediateField（立即写库）
    · 失败不静默：AutoSaveIndicator 明确说「修改仍在内存中」，并给重试 / 放弃修改
    · 乐观锁冲突（rev 不匹配 → 主进程返回 CONFLICT）→ 提示「重新加载」，绝不覆盖别人的修改
-->

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AudioMetrics, CanvasLine, CanvasLinePatch, Id, LineKind, SpeedMark } from '@shared/types.ts'
import { LINE_KIND_LABELS, LINE_STATE_LABELS, SPEED_OPTIONS } from '@shared/constants.ts'
import { call } from '@/shared/lib/ipc.ts'
import { formatDuration, formatLufs, formatScore, formatDb } from '@/shared/lib/format.ts'
import { useEditableField, useImmediateField } from '@/shared/lib/use-editable-field.ts'
import AutoSaveIndicator from '@/shared/ui/AutoSaveIndicator.vue'
import ConfidenceBadge from '@/shared/ui/ConfidenceBadge.vue'
import SpeakerCell from './SpeakerCell.vue'
import EmotionTagPicker from './EmotionTagPicker.vue'
import PauseControl from './PauseControl.vue'
import PronunciationEditor from './PronunciationEditor.vue'
import { useCanvasStore, CANVAS_FLAG_LABELS } from '../stores/canvas.store.ts'
import { useSpeakerAssign } from '../composables/useSpeakerAssign.ts'

const props = withDefaults(defineProps<{
  /** 双向绑定：抽屉是否打开 */
  modelValue: boolean
  /** 当前编辑的行（null = 没有选中行） */
  line: CanvasLine | null
  /** 只读（任务包模式 docs/11 §6.3） */
  readonly?: boolean
  /** 任务包只读时的原因文案（不做编辑入口的静默禁用） */
  readonlyReason?: string | null
}>(), {
  readonly: false,
  readonlyReason: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 行被改动（父组件刷新队列 / 质检） */
  changed: [lineId: Id]
  /** 请求去录音（父组件负责路由跳转，本组件不认识别的功能域） */
  'request-record': [lineId: Id]
  /** 请求定位原文 */
  locate: [lineId: Id]
}>()

const canvas = useCanvasStore()
const speaker = useSpeakerAssign()

const lineId = computed(() => props.line?.id ?? null)

/**
 * 勾选/取消一个 flag。
 *
 * 之所以从模板内联搬到这里：模板表达式里的 `line` 是 `props.line`，类型是 `CanvasLine | null`，
 * 内联写法在 vue-tsc 下会报 TS18047「'__VLS_ctx.line' is possibly 'null'」，
 * 而且参数 `checked` 也只能靠上下文推断。放进 script 后可以显式判空 + 显式标注参数类型。
 */
function onFlagToggle(value: string, checked: boolean | string | number): void {
  const current = props.line
  if (!current) return
  // 与原模板内联写法一致：按真值判断勾选状态
  const next = checked
    ? [...current.flags, value]
    : current.flags.filter(f => f !== value)
  setFlags(next)
}

/** 标志位勾选框（el-checkbox）：载荷为 boolean | string | number，v-for 内需带上标志位名 */
function onFlagToggleInput(value: string): (checked: boolean | string | number) => void {
  return (checked: boolean | string | number): void => {
    onFlagToggle(value, checked)
  }
}

// ---------------------------------------------------------------------------
// 文本 / 备注：500 ms 防抖（docs/11 §4.9）
// ---------------------------------------------------------------------------

const textField = useEditableField<string>('', {
  write: async (value: string) => {
    const line = props.line
    if (!line) return value
    const saved = await canvas.commitText(line.id, value)
    emit('changed', line.id)
    return saved
  },
  delayMs: 500,
})

const noteField = useEditableField<string>('', {
  write: async (value: string) => {
    const line = props.line
    if (!line) return value
    await canvas.commitFields(line.id, { note: value.trim() ? value : null }, '修改备注')
    emit('changed', line.id)
    return value
  },
  delayMs: 500,
})

// ---------------------------------------------------------------------------
// 标记类：立即写库（useImmediateField，delayMs = 0）
// ---------------------------------------------------------------------------

function markField<T>(get: () => T, toPatch: (value: T) => CanvasLinePatch, label: string) {
  return useImmediateField<T>(get, async (value) => {
    const line = props.line
    if (!line) return value
    await canvas.commitFields(line.id, toPatch(value), label)
    emit('changed', line.id)
    return value
  })
}

const kindField = markField<LineKind>(() => props.line?.kind ?? 'narration', value => ({ kind: value }), '修改类型')
const speedField = markField<SpeedMark | null>(() => props.line?.speed ?? null, value => ({ speed: value }), '修改语速')
const gainField = markField<number | null>(() => props.line?.gainDb ?? null, value => ({ gainDb: value }), '修改音量偏移')
const pauseField = markField<number>(() => props.line?.pauseAfterMs ?? 0, value => ({ pauseAfterMs: value }), '修改停顿')
const pronunciationField = markField<string | null>(
  () => props.line?.pronunciation ?? null,
  value => ({ pronunciation: value }),
  '修改发音提示',
)
const reviewField = markField<boolean>(() => props.line?.needsReview ?? false, value => ({ needsReview: value }), '修改待确认状态')

// 下面三个是模板里下拉/滑杆/开关的载荷适配：Element Plus 不给上下文类型，
// 所以把转换从模板搬到这里，参数类型显式写清（模板里禁止写 TS 类型标注）。

/** 语速单选（el-radio-group）：选项值为 SpeedMark，空串表示「默认」 */
function onSpeedInput(value: SpeedMark | ''): void {
  speedField.set(value || null)
}

/** 音量偏移滑杆（el-slider）：载荷为 number | number[]（show-input 时同样是 number） */
function onGainInput(value: number | number[]): void {
  gainField.set(Number(value) || null)
}

/** 待人工确认开关（el-switch）：载荷为 boolean | string | number */
function onReviewInput(value: boolean | string | number): void {
  reviewField.set(Boolean(value))
}

/** 复合字段（情绪 / 句内停顿 / 标志位）直接调 store（同样是立即写库） */
async function commitCompound(patch: CanvasLinePatch, label: string): Promise<void> {
  const line = props.line
  if (!line || props.readonly) return
  await canvas.commitFields(line.id, patch, label)
  emit('changed', line.id)
}

// ---------------------------------------------------------------------------
// 切换行时同步各字段的本地值
// ---------------------------------------------------------------------------

function syncFields(): void {
  const line = props.line
  textField.reset(line?.text ?? '')
  noteField.reset(line?.note ?? '')
  kindField.reset(line?.kind ?? 'narration')
  speedField.reset(line?.speed ?? null)
  gainField.reset(line?.gainDb ?? null)
  pauseField.reset(line?.pauseAfterMs ?? 0)
  pronunciationField.reset(line?.pronunciation ?? null)
  reviewField.reset(line?.needsReview ?? false)
  playing.value = false
  metrics.value = null
  playbackHint.value = ''
  flagDraft.value = ''
}

watch(() => props.line?.id, syncFields, { immediate: true })

// Ctrl+S：store 自增 flushSignal，把防抖中的文本/备注也冲掉（docs/11 §4.8）
watch(() => canvas.flushSignal, () => {
  void textField.flush()
  void noteField.flush()
})

// ---------------------------------------------------------------------------
// 关闭 / 导航
// ---------------------------------------------------------------------------

async function close(): Promise<void> {
  await textField.flush()
  await noteField.flush()
  emit('update:modelValue', false)
  canvas.closeDrawer()
}

/** 抽屉显隐：el-drawer 的 update:model-value 载荷为 boolean */
function onVisibleInput(value: boolean): void {
  emit('update:modelValue', value)
}

const sequence = computed(() => props.line?.seq ?? 0)

function go(delta: number): void {
  void (async () => {
    await textField.flush()
    await noteField.flush()
    const id = canvas.moveActive(delta)
    if (id) canvas.openDrawer(id)
  })()
}

// ---------------------------------------------------------------------------
// 候选列表（Top-3，点击即改）
// ---------------------------------------------------------------------------

const candidates = computed(() => (props.line ? speaker.candidatesOf(props.line, 3) : []))

async function pickCandidate(characterId: string): Promise<void> {
  const line = props.line
  if (!line || props.readonly) return
  const ok = await speaker.assign(line, characterId, { label: `指派说话人：${characterId}` })
  if (ok.ok) emit('changed', line.id)
}

// ---------------------------------------------------------------------------
// 原文片段（sourceText + 前后各 2 行原始文本）
// ---------------------------------------------------------------------------

interface ContextRow {
  id: Id
  seq: number
  offset: number
  text: string
  isCurrent: boolean
}

const contextRows = computed<ContextRow[]>(() => {
  const line = props.line
  if (!line) return []
  const index = canvas.indexById.get(line.id)
  if (index === undefined) return []
  const from = Math.max(0, index - 2)
  const to = Math.min(canvas.lines.length - 1, index + 2)
  const rows: ContextRow[] = []
  for (let i = from; i <= to; i++) {
    const item = canvas.lines[i]
    if (!item) continue
    rows.push({
      id: item.id,
      seq: item.seq,
      offset: i - index,
      text: item.sourceText ?? item.text,
      isCurrent: item.id === line.id,
    })
  }
  return rows
})

// ---------------------------------------------------------------------------
// 试听（docs/11 §4.4）：take:listByLine 拿路径 → ns-media:// + analysis:metrics 显示音频信息
// ---------------------------------------------------------------------------

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const playbackHint = ref('')
const metrics = ref<AudioMetrics | null>(null)
const playbackLoading = ref(false)

async function togglePlay(): Promise<void> {
  const line = props.line
  if (!line) return

  if (playing.value) {
    audioEl.value?.pause()
    playing.value = false
    return
  }

  playbackLoading.value = true
  playbackHint.value = ''
  try {
    const info = await canvas.loadPlayback(line.id)
    if (!info) {
      playbackHint.value = '这一行还没有录音，先去录音页录一条。'
      return
    }
    // 音频信息（时长/峰值/响度）：让用户知道「这条录音是不是能用」
    metrics.value = await call('analysis:metrics', { path: info.filePath }) as AudioMetrics
    await nextTick()
    await audioEl.value?.play()
    playing.value = true
  } catch {
    playbackHint.value = '播放失败，可能是文件已被移动或格式不受支持。'
  } finally {
    playbackLoading.value = false
  }
}

function onEnded(): void {
  playing.value = false
}

// ---------------------------------------------------------------------------
// 标志位
// ---------------------------------------------------------------------------

const flagDraft = ref('')
/** 已知标志位 + 行上实际出现的（保证自定义标记也能被移除） */
const flagOptions = computed(() => {
  const present = new Set<string>([...Object.keys(CANVAS_FLAG_LABELS), ...(props.line?.flags ?? [])])
  return [...present].map(value => ({ value, label: CANVAS_FLAG_LABELS[value] ?? value }))
})

function setFlags(next: string[]): void {
  void commitCompound({ flags: next }, '修改标记')
}

function addFlagDraft(): void {
  const value = flagDraft.value.trim()
  const line = props.line
  if (!value || !line || line.flags.includes(value)) {
    flagDraft.value = ''
    return
  }
  setFlags([...line.flags, value])
  flagDraft.value = ''
}

// ---------------------------------------------------------------------------
// 冲突（乐观锁 rev 不匹配 → CONFLICT，docs/11 §4.9）
// ---------------------------------------------------------------------------

const hasConflict = computed(() => (lineId.value ? canvas.conflictLineIds.has(lineId.value) : false))

async function reloadLine(): Promise<void> {
  if (!lineId.value) return
  await canvas.reloadLine(lineId.value)
  syncFields()
}

const saveErrorText = computed(() => {
  const error = canvas.saveError as { message?: string } | null
  return error?.message ?? null
})

function kindLabel(kind: LineKind): string {
  return LINE_KIND_LABELS[kind] ?? kind
}
</script>

<template>
  <el-drawer
    :model-value="props.modelValue"
    :with-header="false"
    size="440px"
    :append-to-body="true"
    @update:model-value="onVisibleInput"
    @close="emit('update:modelValue', false)"
  >
    <div class="ns-drawer">
      <!-- 头部：序 / 类型 / 状态 / 上下一行 -->
      <header class="ns-drawer__head">
        <div class="ns-drawer__title">
          <span class="ns-drawer__seq">#{{ sequence }}</span>
          <span class="ns-drawer__kind">{{ line ? kindLabel(line.kind) : '未选中行' }}</span>
          <span v-if="line" class="ns-drawer__state">{{ LINE_STATE_LABELS[line.state] ?? line.state }}</span>
          <span v-if="line?.isTitle" class="ns-drawer__badge">章首念白</span>
        </div>
        <div class="ns-drawer__head-actions">
          <el-button size="small" :disabled="!line" @click="go(-1)">上一行</el-button>
          <el-button size="small" :disabled="!line" @click="go(1)">下一行</el-button>
          <el-button size="small" text @click="close">关闭</el-button>
        </div>
      </header>

      <div v-if="!line" class="ns-drawer__empty">没有选中的行。在表格或剧本里点一行再打开这里。</div>

      <template v-else>
        <!-- 只读说明（不做静默禁用） -->
        <div v-if="readonly" class="ns-drawer__notice is-info">
          {{ readonlyReason ?? '当前画本为只读（任务包模式）：为保证与导演侧一致，这里不能修改台词与角色。' }}
        </div>

        <!-- 冲突提示：绝不覆盖别人的修改 -->
        <div v-if="hasConflict" class="ns-drawer__notice is-warn">
          这一行在别处被改过（乐观锁冲突），当前显示的是你内存里的版本。
          <el-button size="small" text @click="reloadLine">重新加载最新值</el-button>
        </div>

        <!-- 保存状态：失败必须说清「修改仍在内存中」 -->
        <div class="ns-drawer__savebar">
          <AutoSaveIndicator
            :status="canvas.saveStatus"
            :saved-at="canvas.savedAt"
            :error-text="saveErrorText"
            :retryable="true"
            :revertable="true"
            compact
            @retry="canvas.flush()"
            @revert="canvas.discardUnsaved()"
          />
          <span class="ns-drawer__autosave-hint">文本 500 ms 防抖写库；标记类改动立即写库</span>
        </div>

        <!-- 归属：候选 Top-3 -->
        <section class="ns-drawer__section">
          <h4 class="ns-drawer__section-title">归属</h4>
          <SpeakerCell
            :line="line"
            :readonly="readonly"
            :compact="false"
            :threshold="canvas.threshold"
            :show-hotkeys="true"
            @change="(id) => emit('changed', id)"
            @locate="(id) => emit('locate', id)"
            @open="() => undefined"
          />

          <div class="ns-drawer__candidates">
            <span class="ns-drawer__candidates-label">候选（Top-3，点击即改）</span>
            <ConfidenceBadge
              :confidence="line.confidence"
              :decided-by="line.decidedBy"
              :candidates="candidates"
              :threshold="canvas.threshold"
              @pick="(characterId) => pickCandidate(characterId)"
            />
            <p v-if="!candidates.length" class="ns-drawer__muted">
              这一行没有候选分数（规则直接命中，或尚未做向量判定）。
            </p>
            <p v-else class="ns-drawer__muted">
              第一名 {{ candidates[0]?.name }} {{ formatScore(candidates[0]?.score ?? null) }}
              —— 人工改过之后 decidedBy 会记为「人工确认」，重算不会覆盖。
            </p>
          </div>
        </section>

        <!-- 文本 -->
        <section class="ns-drawer__section">
          <h4 class="ns-drawer__section-title">
            文本
            <span class="ns-drawer__count">{{ [...(line.text ?? '')].length }} 字</span>
          </h4>
          <el-input
            :model-value="textField.value.value"
            type="textarea"
            :rows="4"
            :disabled="readonly"
            placeholder="要录的内容（已剥离引号）"
            @update:model-value="textField.set"
            @blur="textField.flush()"
          />
        </section>

        <!-- 类型 / 语速 / 音量 -->
        <section class="ns-drawer__section">
          <h4 class="ns-drawer__section-title">表演参数</h4>

          <div class="ns-drawer__field">
            <label class="ns-drawer__label">类型</label>
            <el-select
              :model-value="kindField.value.value"
              :disabled="readonly"
              size="small"
              @update:model-value="kindField.set"
            >
              <el-option v-for="(label, value) in LINE_KIND_LABELS" :key="value" :label="label" :value="value" />
            </el-select>
          </div>

          <div class="ns-drawer__field">
            <label class="ns-drawer__label">情绪</label>
            <EmotionTagPicker
              :emotion="line.emotion"
              :intensity="line.emotionIntensity"
              :readonly="readonly"
              :compact="false"
              @change="(patch) => commitCompound(patch, '修改情绪')"
            />
          </div>

          <div class="ns-drawer__field">
            <label class="ns-drawer__label">语速</label>
            <el-radio-group
              :model-value="speedField.value.value ?? ''"
              :disabled="readonly"
              size="small"
              @update:model-value="onSpeedInput"
            >
              <el-radio-button value="">默认</el-radio-button>
              <el-radio-button v-for="option in SPEED_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </el-radio-button>
            </el-radio-group>
          </div>

          <div class="ns-drawer__field">
            <label class="ns-drawer__label">音量偏移</label>
            <el-slider
              :model-value="gainField.value.value ?? 0"
              :min="-12"
              :max="12"
              :step="0.5"
              :disabled="readonly"
              show-input
              size="small"
              @update:model-value="onGainInput"
            />
            <span class="ns-drawer__muted">当前：{{ formatDb(line.gainDb) }}（给对轨/混音作为起点，不是最终响度）</span>
          </div>

          <div class="ns-drawer__field">
            <label class="ns-drawer__label">停顿</label>
            <PauseControl
              :pause-after-ms="line.pauseAfterMs"
              :pause-inline="line.pauseInline"
              :text="line.text"
              :readonly="readonly"
              :compact="false"
              :allow-inline="true"
              @change="(value) => pauseField.set(value)"
              @change-inline="(value) => commitCompound({ pauseInline: value }, '修改句内停顿')"
            />
          </div>

          <div class="ns-drawer__field">
            <label class="ns-drawer__label">发音提示</label>
            <PronunciationEditor
              :text="line.text"
              :pronunciation="line.pronunciation"
              :readonly="readonly"
              :compact="false"
              @change="(value) => pronunciationField.set(value)"
            />
          </div>
        </section>

        <!-- 备注：给配音员看 -->
        <section class="ns-drawer__section">
          <h4 class="ns-drawer__section-title">备注（会随任务包发给配音员）</h4>
          <el-input
            :model-value="noteField.value.value"
            type="textarea"
            :rows="2"
            :disabled="readonly"
            placeholder="如：这里是情绪爆发点，不要喊破音"
            @update:model-value="noteField.set"
            @blur="noteField.flush()"
          />
        </section>

        <!-- 标志位与待确认 -->
        <section class="ns-drawer__section">
          <h4 class="ns-drawer__section-title">标记与状态</h4>
          <div class="ns-drawer__flags">
            <el-checkbox
              v-for="option in flagOptions"
              :key="option.value"
              :model-value="line?.flags.includes(option.value) === true"
              :disabled="readonly"
              size="small"
              @update:model-value="onFlagToggleInput(option.value)"
            >
              {{ option.label }}
            </el-checkbox>
          </div>

          <div class="ns-drawer__flag-add">
            <el-input
              v-model="flagDraft"
              size="small"
              placeholder="自定义标记（回车添加）"
              :disabled="readonly"
              @keydown.enter="addFlagDraft"
            />
            <el-button size="small" :disabled="readonly || !flagDraft.trim()" @click="addFlagDraft">添加</el-button>
          </div>

          <div class="ns-drawer__field">
            <label class="ns-drawer__label">待人工确认</label>
            <el-switch
              :model-value="reviewField.value.value"
              :disabled="readonly"
              @update:model-value="onReviewInput"
            />
            <span class="ns-drawer__muted">关掉即从「待确认队列」里移除；改过归属也会自动关掉。</span>
          </div>
        </section>

        <!-- 原文片段与上下文 -->
        <section class="ns-drawer__section">
          <h4 class="ns-drawer__section-title">原文片段</h4>
          <div class="ns-drawer__source">
            <p class="ns-drawer__source-text">
              {{ line.sourceText ?? '（这一行没有原文片段，可能是人工新增的行）' }}
            </p>
            <p class="ns-drawer__muted">
              字符区间 {{ line.charStart }} ~ {{ line.charEnd }}
              <span v-if="line.sourceText && line.sourceText !== line.text"> · 文本已被人工修改过</span>
            </p>
          </div>

          <ul class="ns-drawer__context">
            <li
              v-for="row in contextRows"
              :key="row.id"
              class="ns-drawer__context-row"
              :class="{ 'is-current': row.isCurrent }"
            >
              <span class="ns-drawer__context-seq">{{ row.offset === 0 ? '当前' : (row.offset > 0 ? `+${row.offset}` : row.offset) }}</span>
              <span class="ns-drawer__context-text">{{ row.text }}</span>
            </li>
          </ul>
        </section>

        <!-- 试听 -->
        <section class="ns-drawer__section">
          <h4 class="ns-drawer__section-title">试听</h4>
          <div class="ns-drawer__audio">
            <el-button size="small" :loading="playbackLoading" @click="togglePlay">
              {{ playing ? '暂停' : '播放' }}
            </el-button>
            <span v-if="canvas.playbackDurationMs !== null" class="ns-drawer__muted">
              时长 {{ formatDuration(canvas.playbackDurationMs) }}
            </span>
            <span v-if="metrics" class="ns-drawer__muted">
              峰值 {{ formatDb(metrics.peakDb) }} · {{ formatLufs(metrics.lufs) }}
            </span>
            <el-button v-if="!canvas.playbackUrl" size="small" text @click="emit('request-record', line.id)">去录音</el-button>
          </div>
          <p v-if="playbackHint" class="ns-drawer__muted">{{ playbackHint }}</p>
          <audio
            ref="audioEl"
            class="ns-drawer__player"
            :src="canvas.playbackUrl ?? undefined"
            controls
            preload="none"
            @ended="onEnded"
            @pause="playing = false"
          />
        </section>

        <!-- 强制标记说明 -->
        <p class="ns-drawer__foot-note">
          说明：这里的所有人工编辑都会写入 decidedBy=<code>human</code>，
          重算归属不会覆盖（docs/11 §3：这是最容易被投诉的一类 bug）。
        </p>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.ns-drawer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 2px 4px 20px;
  overflow: auto;
}
.ns-drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
}
.ns-drawer__title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ns-drawer__seq {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ns-drawer__kind {
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
  font-weight: 600;
}
.ns-drawer__state,
.ns-drawer__badge {
  padding: 1px 6px;
  border-radius: 3px;
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
  font-size: 11px;
}
.ns-drawer__head-actions {
  display: flex;
  gap: 4px;
}
.ns-drawer__empty {
  padding: 24px 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
  text-align: center;
}
.ns-drawer__notice {
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
}
.ns-drawer__notice.is-warn {
  background: rgb(230 162 60 / 14%);
  color: var(--ns-warning, #e6a23c);
}
.ns-drawer__notice.is-info {
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}
.ns-drawer__savebar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ns-drawer__autosave-hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-drawer__section {
  padding-top: 6px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
}
.ns-drawer__section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-drawer__count {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  font-weight: 400;
}
.ns-drawer__candidates {
  margin-top: 8px;
}
.ns-drawer__candidates-label {
  display: block;
  margin-bottom: 4px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-drawer__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.ns-drawer__label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-drawer__muted {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-drawer__flags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.ns-drawer__flag-add {
  display: flex;
  gap: 6px;
  margin: 8px 0;
}
.ns-drawer__source {
  padding: 8px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-drawer__source-text {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}
.ns-drawer__context {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ns-drawer__context-row {
  display: flex;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 3px;
  font-size: 12px;
  line-height: 1.6;
}
.ns-drawer__context-row.is-current {
  background: rgb(64 158 255 / 12%);
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-drawer__context-seq {
  flex: 0 0 34px;
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-drawer__context-text {
  flex: 1;
  word-break: break-word;
}
.ns-drawer__audio {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ns-drawer__player {
  width: 100%;
  height: 32px;
  margin-top: 8px;
}
.ns-drawer__foot-note {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-drawer__foot-note code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  font-family: ui-monospace, Consolas, monospace;
}
</style>
