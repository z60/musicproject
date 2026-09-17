<!--
  Novel Studio · M4B 专属选项（docs/15 §5.2 / §5.5 Step 2 & Step 5 / §7 章首标题念白）
  ============================================================================
  设计依据：
    · docs/15 §5.2 —— 整本合并 M4B 的「必须注意」清单：
        `-map_chapters 1` 不加会丢章节信息；章节时间轴必须整数毫秒且无缝；
        **> 200 章建议按卷拆分**（部分播放器章节列表会异常）；总时长 ≤ 24 h；
        `.m4b` 与 `.m4a` 同容器，用 `.m4b` 让播放器识别为有声书。
    · docs/15 §5.5 —— M4B 选项属于 Step 2（输出）与 Step 5（元数据与封面）的一部分：
      码率、章节标记来源、封面、按卷拆分。
    · docs/15 §7 —— 「章首标题念白」在 1.0 里的实现方式：
      在画本章首**插一行标题念白**（kind=narration, is_title=1），由旁白配音员录，
      从而不需要渲染阶段做特殊处理。因此这里的开关必须把这件事讲清楚，
      并给出「去画本插入这一行」的入口。
    · docs/15 §5.3 —— 章标题模板 `第{index}章 {title}` 是章节标记的**来源**，
      预览用 `buildChapterTitle`（与主进程同口径，见 shared/lib/template.ts）。

  为什么按卷拆分要同时给「建议值」和「手动值」：
    用户按卷建的章节（volumeSeq 非空）天然适合「一卷一个文件」；没分卷的书
    只能按固定章数切。前者用建议值（按最大卷的章数取整），后者让用户自己定。
-->

<script setup lang="ts">
import { computed } from 'vue'
import type { ExportParams } from '@shared/types.ts'
import type { ResolvedMessage } from '@shared/messages.ts'
import { EXPORT_DEFAULTS } from '@shared/constants.ts'
import { formatBytes, formatDurationLong, formatInt } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  /** 是否在分章导出后再合并一个 M4B */
  enabled: boolean
  /** M4B 码率（kbps） */
  bitrate: ExportParams['m4bBitrate']
  /** 每 N 章一卷；0 = 不拆分 */
  splitM4bEvery: number
  /** 章节标记标题模板 */
  chapterTitleTemplate: string
  /** 章首标题念白开关 */
  titleReading: boolean
  /** 封面路径（与元数据共用；null = 不带封面） */
  coverPath: string | null
  /** 本次范围的总章数 */
  chapterCount: number
  /** 本次范围的预估总时长 */
  totalDurationMs: number
  /** 采样率（AAC 输出用） */
  sampleRate: ExportParams['sampleRate']
  /** 章节标记预览（前几章，已用 buildChapterTitle 渲染） */
  chapterPreview: string[]
  /** 章数超限警告（取自消息表 EXPORT_M4B_TOO_MANY_CHAPTERS；null = 无） */
  chapterWarning: ResolvedMessage | null
  /** 预估时长是否超过单文件上限 */
  tooLong: boolean
  /** 按卷拆分时建议的每卷章数（0 = 无从建议） */
  suggestedSplit: number
  /** 是否已有分章成品可以「仅合并」 */
  canMergeOnly?: boolean
  /** 范围是整本（插入标题念白针对单章，整本时禁用） */
  bookScope?: boolean
  disabled?: boolean
}>(), {
  canMergeOnly: false,
  bookScope: false,
  disabled: false,
})

const emit = defineEmits<{
  'update:enabled': [value: boolean]
  'update:bitrate': [value: ExportParams['m4bBitrate']]
  'update:splitM4bEvery': [value: number]
  'update:chapterTitleTemplate': [value: string]
  'update:titleReading': [value: boolean]
  /** 选择封面（与 Step 5 的封面同一入口） */
  'pick-cover': []
  /** 仅合并 M4B（分章成品已存在时） */
  'merge-only': []
  /** 去画本页插入标题念白行（docs/15 §7 的 1.0 实现） */
  'insert-title-line': []
}>()

const BITRATE_OPTIONS: Array<{ value: ExportParams['m4bBitrate']; label: string }> = [
  { value: 64, label: '64 kbps（语音，体积最小）' },
  { value: 96, label: '96 kbps（推荐，有声书默认）' },
  { value: 128, label: '128 kbps（更保真）' },
  { value: 192, label: '192 kbps（体积大，一般不需要）' },
]

/** 单文件时长上限（小时，docs/15 §5.2） */
const maxHours = EXPORT_DEFAULTS.m4bMaxHours

/** 预估 M4B 体积：时长 × 码率（容器开销忽略不计，用于量级判断） */
const estimatedBytes = computed(() => {
  if (!props.enabled) return 0
  const seconds = props.totalDurationMs / 1000
  return seconds * ((props.bitrate * 1000) / 8)
})

/** 拆分后的文件数（0 表示不拆） */
const splitCount = computed(() => {
  const per = props.splitM4bEvery
  if (!props.enabled || per <= 0 || props.chapterCount <= 0) return 0
  return Math.ceil(props.chapterCount / per)
})

const tooManyChapters = computed(() => props.chapterCount > EXPORT_DEFAULTS.m4bChapterWarnThreshold)

/** 封面只显示文件名（完整路径在 title 里） */
const coverName = computed(() => {
  const path = props.coverPath
  if (!path) return '未设置（M4B 将不带封面）'
  return path.split(/[\\/]+/).pop() ?? path
})

/** 章数警告的正文（标题/正文/建议都来自消息表，不在组件里自拼错误文案） */
const chapterWarningText = computed(() => {
  const warning = props.chapterWarning
  if (!warning) return ''
  return [warning.detail, warning.hint].filter(Boolean).join(' ')
})

/** 单文件时长超限的说明（事实型提示：时长 + 上限） */
const tooLongText = computed(() =>
  `预计 ${formatDurationLong(props.totalDurationMs)}，超过单文件上限 ${maxHours} 小时；`
  + '超长文件的 seek 索引会非常庞大，请按卷拆分或缩小范围。',
)

function onEnabled(value: unknown): void {
  emit('update:enabled', value === true)
}

function onBitrate(value: unknown): void {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return
  emit('update:bitrate', numeric as ExportParams['m4bBitrate'])
}

function onSplit(value: number | undefined): void {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  emit('update:splitM4bEvery', numeric)
}

function onTemplate(value: string): void {
  emit('update:chapterTitleTemplate', value)
}

function onTitleReading(value: unknown): void {
  emit('update:titleReading', value === true)
}

function applySuggestedSplit(): void {
  onSplit(props.suggestedSplit || Math.max(10, Math.ceil(props.chapterCount / 2)))
}

function onPickCover(): void {
  emit('pick-cover')
}
</script>

<template>
  <section class="ns-m4b" :class="{ 'is-off': !props.enabled }">
    <header class="ns-m4b__head">
      <div>
        <h3 class="ns-m4b__title">整本合并 M4B（有声书容器）</h3>
        <p class="ns-m4b__desc">
          M4B 与 M4A 是同一个容器，用 <code>.m4b</code> 扩展名能让播放器识别成「有声书」并显示章节列表。
          合并使用 concat + 章节表（<code>-map_chapters 1</code>），因此章节跳转在支持的播放器里是原生的。
        </p>
      </div>
      <el-switch
        :model-value="props.enabled"
        :disabled="props.disabled"
        active-text="合并整本 M4B"
        @update:model-value="onEnabled"
      />
    </header>

    <p v-if="!props.enabled" class="ns-m4b__off-hint">
      当前只导出分章文件。需要「一个文件听完整本」时再打开这里的开关（分章文件仍会照常生成）。
    </p>

    <template v-else>
      <div class="ns-m4b__grid">
        <label class="ns-m4b__field">
          <span class="ns-m4b__label">M4B 码率</span>
          <el-select :model-value="props.bitrate" :disabled="props.disabled" @update:model-value="onBitrate">
            <el-option v-for="option in BITRATE_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </label>

        <div class="ns-m4b__field">
          <span class="ns-m4b__label">预计体积</span>
          <strong class="ns-m4b__value">{{ formatBytes(estimatedBytes) }}</strong>
          <span class="ns-m4b__hint">
            {{ formatInt(props.chapterCount) }} 章 · 约 {{ formatDurationLong(props.totalDurationMs) }} ·
            {{ props.sampleRate === 48000 ? '48' : '44.1' }} kHz AAC
          </span>
        </div>

        <div class="ns-m4b__field">
          <span class="ns-m4b__label">章节标记来源</span>
          <span class="ns-m4b__hint">
            画本标题模板 <code>{index}</code>（章号）与 <code>{title}</code>（章节标题）
          </span>
          <el-input
            :model-value="props.chapterTitleTemplate"
            :disabled="props.disabled"
            placeholder="第{index}章 {title}"
            @update:model-value="onTemplate"
          />
          <ul class="ns-m4b__preview">
            <li v-for="(title, index) in props.chapterPreview" :key="index">{{ title }}</li>
            <li v-if="props.chapterPreview.length < props.chapterCount" class="ns-m4b__preview-more">
              … 其余 {{ formatInt(props.chapterCount - props.chapterPreview.length) }} 章同理
            </li>
          </ul>
        </div>

        <div class="ns-m4b__field">
          <span class="ns-m4b__label">封面</span>
          <p class="ns-m4b__cover" :title="props.coverPath ?? ''">
            {{ coverName }}
          </p>
          <el-button size="small" :disabled="props.disabled" @click="onPickCover">选择封面…</el-button>
          <span class="ns-m4b__hint">与 Step 5 的封面共用同一个文件（JPEG / PNG）。</span>
        </div>
      </div>

      <!-- 章数 / 时长上限（docs/15 §5.2） -->
      <el-alert
        v-if="props.chapterWarning"
        type="warning"
        :closable="false"
        show-icon
        :title="props.chapterWarning.title"
        :description="chapterWarningText"
      />
      <el-alert
        v-if="props.tooLong"
        type="warning"
        :closable="false"
        show-icon
        title="单文件时长超过上限"
        :description="tooLongText"
      />

      <div class="ns-m4b__split">
        <span class="ns-m4b__label">按卷拆分</span>
        <el-input-number
          :model-value="props.splitM4bEvery"
          :min="0"
          :max="1000"
          :step="10"
          :disabled="props.disabled"
          controls-position="right"
          @update:model-value="onSplit"
        />
        <span class="ns-m4b__hint">每 N 章一个 M4B；0 = 不拆分</span>
        <el-button size="small" :disabled="props.disabled" @click="applySuggestedSplit">
          按卷建议（{{ formatInt(props.suggestedSplit || 0) }} 章/卷）
        </el-button>
        <span v-if="splitCount > 1" class="ns-m4b__split-result">
          将生成 {{ formatInt(splitCount) }} 个 M4B 文件
        </span>
        <span v-else-if="tooManyChapters" class="ns-m4b__split-result ns-m4b__split-result--warn">
          章数较多，建议拆分成多个文件
        </span>
      </div>

      <!-- 章首标题念白（docs/15 §7） -->
      <div class="ns-m4b__reading">
        <el-switch
          :model-value="props.titleReading"
          :disabled="props.disabled"
          active-text="章首念标题"
          @update:model-value="onTitleReading"
        />
        <div class="ns-m4b__reading-body">
          <p class="ns-m4b__hint">
            1.0 的「念标题」是靠<strong>画本里插一行标题念白</strong>实现的：在每章开头插入一行
            <code>kind=narration</code>、标记为「章节标题」的画本行，由旁白配音员一起录，
            之后的对轨与混音无需任何特殊处理（docs/15 §7）。AI 生成（TTS）在 1.0 不实现。
          </p>
          <el-button
            size="small"
            :disabled="props.disabled || props.bookScope"
            @click="emit('insert-title-line')"
          >
            去画本插入标题念白行
          </el-button>
          <span v-if="props.bookScope" class="ns-m4b__hint">
            整本范围下逐章插入请到章节列表或画本页操作。
          </span>
        </div>
      </div>

      <div class="ns-m4b__actions">
        <el-button
          size="small"
          :disabled="props.disabled || !props.canMergeOnly"
          @click="emit('merge-only')"
        >
          仅合并 M4B（已有分章成品）
        </el-button>
        <span class="ns-m4b__hint">
          分章文件已存在时无需重新渲染，直接合并即可；合并失败不影响已生成的分章成品（docs/15 §11）。
        </span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ns-m4b {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-m4b.is-off {
  border-style: dashed;
}
.ns-m4b__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ns-m4b__title {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.ns-m4b__desc {
  max-width: 720px;
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-m4b__desc code,
.ns-m4b__hint code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  font-size: 11px;
}
.ns-m4b__off-hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-m4b__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}
.ns-m4b__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-m4b__label {
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  font-weight: 600;
}
.ns-m4b__value {
  color: var(--ns-text-primary, #303133);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.ns-m4b__hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.6;
}
.ns-m4b__preview {
  max-height: 108px;
  margin: 0;
  padding: 6px 8px 6px 22px;
  overflow: auto;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
}
.ns-m4b__preview-more {
  color: var(--ns-text-placeholder, #c0c4cc);
}
.ns-m4b__cover {
  margin: 0;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-m4b__split,
.ns-m4b__reading,
.ns-m4b__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ns-m4b__reading {
  align-items: flex-start;
  padding-top: 8px;
  border-top: 1px solid var(--ns-border-light, #e4e7ed);
}
.ns-m4b__reading-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  flex: 1;
  min-width: 240px;
}
.ns-m4b__reading-body p {
  margin: 0;
}
.ns-m4b__split-result {
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ns-m4b__split-result--warn {
  color: var(--ns-warning, #e6a23c);
}
.ns-m4b__actions {
  padding-top: 8px;
  border-top: 1px solid var(--ns-border-light, #e4e7ed);
}
</style>
