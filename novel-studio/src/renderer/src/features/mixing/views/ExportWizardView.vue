<!--
  Novel Studio · 导出向导（docs/15 §5.5 八步向导）
  ============================================================================
  设计依据：
    · docs/15 §5.5 —— 八个步骤：
        1 范围 / 2 输出 / 3 混音方案 / 4 响度 / 5 元数据与封面 /
        6 预检报告 / 7 执行 / 8 完成报告
    · docs/15 §5.3 —— 命名模板与目录结构：Step 2 必须**实时预览**将要生成的文件名
      （与主进程同一个 `buildFileNames`，见 shared/lib/template.ts）。
    · docs/15 §4    —— 响度两遍法：Step 4 提供「先测量再决定」（先测 input_i，再算增益）。
    · docs/15 §6.1  —— Step 6 阻断项必须处理（「去处理」按钮直达画本行/对轨页）。
    · docs/04 §2.4  —— 长任务进度统一用 TaskProgressCard（Step 7 由 ExportProgressPanel 承载）。
    · docs/22 §7    —— 错误一律交给 error-bus；本视图不弹提示、不自拼错误文案。

  视图的职责边界（**刻意很薄**）：
    · 布局与步骤切换：本文件；
    · 状态与校验：`stores/export.store.ts`（向导态）、`stores/qc.store.ts`（质检）；
    · IPC 编排（开始/取消/重试/报告/离开守卫）：`composables/useExportFlow.ts`；
    · 各步骤的实质内容：5 个子组件。
  这样「后退不丢数据」只需要保证 store 不被清空，而不是靠快照回滚 ——
  用户在第 4 步改完响度再回第 2 步改格式，回到第 4 步时参数仍在。
-->

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { EXPORT_DEFAULTS, LOUDNESS_TARGETS } from '@shared/constants.ts'
import { getMessage } from '@shared/messages.ts'
import type { ExportParams } from '@shared/types.ts'
import {
  formatBytes,
  formatDb,
  formatDbfs,
  formatDuration,
  formatDurationLong,
  formatInt,
  formatLra,
  formatLufs,
  UNKNOWN,
} from '@/shared/lib/format.ts'
import { MAX_FILE_NAME_BYTES, TEMPLATE_PLACEHOLDERS } from '@/shared/lib/template.ts'
import { call } from '@/shared/lib/ipc.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import ErrorBoundary from '@/shared/ui/ErrorBoundary.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import M4bOptionsPanel from '../components/M4bOptionsPanel.vue'
import MetadataEditor from '../components/MetadataEditor.vue'
import QcPreCheckPanel from '../components/QcPreCheckPanel.vue'
import ExportProgressPanel from '../components/ExportProgressPanel.vue'
import ExportReportPanel from '../components/ExportReportPanel.vue'
import { useExportStore } from '../stores/export.store.ts'
import type { ExportChapterRow, ExportRangeMode } from '../stores/export.store.ts'
import { useQcStore } from '../stores/qc.store.ts'
import { useExportFlow } from '../composables/useExportFlow.ts'
import type { ExportJumpTarget } from '../composables/useExportFlow.ts'

const router = useRouter()
const store = useExportStore()
const qc = useQcStore()
const session = useSessionStore()
const settings = useSettingsStore()
/** 编排：开始/取消/重试/报告/离开守卫（必须在 setup 里调用，它内部注册了路由守卫） */
const flow = useExportFlow()

/** 解构成顶层 ref，模板里直接当值用（避免模板里写 `.value`） */
const {
  progressEvent,
  starting,
  reportUnavailable,
  leaveConfirmVisible,
} = flow

/** 「去画本插入标题念白行」的结果提示（纯本地提示，不需要进 store） */
const titleLineHint = ref('')
const measuringHint = ref('')

const MP3_BITRATES = [128, 192, 256, 320] as const
const SAMPLE_RATES = [44100, 48000] as const
const M4B_BITRATES = [64, 96, 128, 192] as const

const RANGE_OPTIONS: Array<{ value: ExportRangeMode; label: string; hint: string }> = [
  { value: 'current', label: '当前章', hint: '只导出当前选中的章节，适合快速验证效果' },
  { value: 'selected', label: '选定章', hint: '按卷或逐章挑选，适合分批交付' },
  { value: 'book', label: '全书', hint: '整本导出（120 章大约 1 小时），支持断点续传' },
]

// ── 初始化 ─────────────────────────────────────────────────────────────────

onMounted(() => {
  void store.bootstrap()
})

// 进入 Step 3 时读取混音方案（IPC 是按章查询的，全书范围会抽样汇总）
watch(() => store.step, (step) => {
  if (step !== 3 || store.mixLoading) return
  if (store.isBookScope ? store.mixSummary !== null : store.mixProjects.length > 0) return
  void store.loadMixPlans()
})

// ── 派生 ───────────────────────────────────────────────────────────────────

const stepItems = computed(() => store.stepTitles.map((title, index) => ({ title, index })))

/** 章节 id → 标题（预检清单里显示可读名称） */
const chapterTitles = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const row of store.chapters) map[row.id] = row.title
  return map
})

const summaryText = computed(() => [
  store.bookTitle || '未选择书籍',
  store.rangeLabel,
  `约 ${formatDurationLong(store.estimatedDurationMs)}`,
  `成品约 ${formatBytes(store.estimatedOutputBytes)}`,
].join(' · '))

/** 能力探测：ffmpeg 不可用时不该让用户白等一场导出（docs/02 §5.1） */
const ffmpegReady = computed(() => settings.ffmpegReady)
const missingFilters = computed(() => settings.missingFilters)

const mixConflict = computed(() => (store.targetConflict ? getMessage('MIX_TARGET_CONFLICT') : null))
const rangeHint = computed(() => RANGE_OPTIONS.find(option => option.value === store.rangeMode)?.hint ?? '')

const mixSummaryRows = computed(() => store.mixSummary?.entries ?? [])

const loudnessPresets = computed(() => LOUDNESS_TARGETS.map(target => ({
  ...target,
  active: Math.abs(store.params.targetLufs - target.lufs) < 0.01,
})))
const isCustomLufs = computed(() => !loudnessPresets.value.some(preset => preset.active))

const taskKind = computed(() => (store.isBookScope ? 'export.book' : 'export.chapter'))
const taskTitle = computed(() => `导出《${store.bookTitle || '未命名书籍'}》`)
const verifyResult = computed(() => qc.verifyFor(store.jobId))

/** 下一步的可用性：Step 6 由预检结果决定，其余由 store 的步骤校验决定 */
const canGoNext = computed(() => store.canProceed && ffmpegReady.value)
const nextDisabledReason = computed(() => {
  if (!ffmpegReady.value) return 'ffmpeg 不可用：请在设置中配置 ffmpeg 路径后再导出。'
  return store.stepIssues[0] ?? ''
})

/** 输出目录 + 相对路径 = 实际写盘位置（Step 2 的「写到哪儿」） */
function fullPath(relative: string): string {
  const dir = store.params.outputDir.replace(/[\\/]+$/, '')
  return dir ? `${dir}/${relative}` : relative
}

function isSelected(chapterId: string): boolean {
  return store.selectedChapterIds.includes(chapterId)
}

function estimateOf(row: ExportChapterRow): string {
  return formatDuration(store.estimateOf(row))
}

function missingLinesOf(row: ExportChapterRow): number {
  return Math.max(0, (row.progress?.lineCount ?? 0) - (row.progress?.recordedCount ?? 0))
}

// ── 类型化的输入处理器 ─────────────────────────────────────────────────────
// 模板表达式里不写 TS 语法（断言/类型标注），一切收窄都在脚本里完成。

function onRangeChange(value: unknown): void {
  if (value === 'current' || value === 'selected' || value === 'book') store.setRangeMode(value)
}

function onToggleChapter(chapterId: string, value: unknown): void {
  store.toggleChapter(chapterId, value === true)
}

/** 章节勾选：el-checkbox 的载荷是 string | number | boolean，按行把 chapterId 固定进处理器 */
function onToggleChapterInput(chapterId: string): (value: boolean | string | number) => void {
  return (value: boolean | string | number): void => {
    onToggleChapter(chapterId, value)
  }
}

function onFormatChange(value: unknown): void {
  if (value === 'mp3' || value === 'wav' || value === 'm4a') store.setFormat(value)
}

function onBitrateChange(value: unknown): void {
  const numeric = Number(value)
  if (store.params.format === 'm4a') {
    if (numeric === 64 || numeric === 96 || numeric === 128 || numeric === 192) store.setParam('m4bBitrate', numeric)
    return
  }
  if (numeric === 128 || numeric === 192 || numeric === 256 || numeric === 320) store.setParam('mp3Bitrate', numeric)
}

function onM4bBitrate(value: ExportParams['m4bBitrate']): void {
  store.setParam('m4bBitrate', value)
}

function onSampleRateChange(value: unknown): void {
  const numeric = Number(value)
  if (numeric === 44100 || numeric === 48000) store.setParam('sampleRate', numeric)
}

function onOverwriteChange(value: unknown): void {
  if (value === 'skip' || value === 'overwrite' || value === 'rename') store.setOverwrite(value)
}

function onTemplateInput(value: string): void {
  store.setParam('fileNameTemplate', value)
}

function appendPlaceholder(token: string): void {
  store.setParam('fileNameTemplate', `${store.params.fileNameTemplate}{${token}}`)
}

function resetTemplate(): void {
  store.setParam('fileNameTemplate', EXPORT_DEFAULTS.fileNameTemplate)
}

function onSplitEvery(value: number): void {
  store.setParam('splitM4bEvery', value)
}

/**
 * 数字输入的统一收窄。
 * el-input-number 清空时会传 undefined（某些版本是 null），el-radio-group 传的是
 * string/number/boolean，因此这里统一只接受「能变成有限数字」的值，其余保留旧值。
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  return null
}

function onTargetLufs(value: unknown): void {
  const numeric = toFiniteNumber(value)
  if (numeric !== null) store.setParam('targetLufs', numeric)
}

function onTruePeak(value: unknown): void {
  const numeric = toFiniteNumber(value)
  if (numeric !== null) store.setParam('truePeakDb', numeric)
}

function onLra(value: unknown): void {
  const numeric = toFiniteNumber(value)
  if (numeric !== null) store.setParam('lra', numeric)
}

function onHeadSilence(value: unknown): void {
  const numeric = toFiniteNumber(value)
  if (numeric !== null) store.setParam('headSilenceMs', numeric)
}

function onTailSilence(value: unknown): void {
  const numeric = toFiniteNumber(value)
  if (numeric !== null) store.setParam('tailSilenceMs', numeric)
}

function onToggleMixProject(value: unknown): void {
  store.setUseMixProject(value === true)
}

function onSelectMixProject(value: unknown): void {
  if (typeof value === 'string' && value) void store.selectMixProject(value)
}

function onToggleM4b(value: unknown): void {
  store.setM4bEnabled(value === true)
}

function onTitleReading(value: boolean): void {
  store.setTitleReading(value)
}

function onChapterTitleTemplate(value: string): void {
  store.setM4bChapterTitleTemplate(value)
}

function onWriteMetadata(value: boolean): void {
  store.setWriteMetadata(value)
}

function onCommitMetadata(metadata: Parameters<typeof store.patchMetadata>[0]): void {
  store.patchMetadata(metadata)
}

// ── Step 1 / 4 的动作 ──────────────────────────────────────────────────────

function goBookshelf(): void {
  void router.push('/bookshelf')
}

function goChapters(): void {
  void router.push('/chapters')
}

function goMixer(): void {
  void router.push({ path: '/mixing', query: { chapterId: store.targetChapterIds[0] ?? undefined } })
}

function goTasks(): void {
  void router.push('/tasks')
}

/** 「先测量再决定」（docs/15 §4 两遍法的第一遍） */
async function measureReference(): Promise<void> {
  try {
    const picked = await call('app:openFileDialog', {
      title: '选择用于测量响度的参考音频',
      filters: [{ name: '音频（wav / mp3 / m4a / flac）', extensions: ['wav', 'mp3', 'm4a', 'flac'] }],
    }) as { paths: string[] }
    const path = picked.paths[0]
    if (!path) return
    const measurement = await store.measureReference(path)
    measuringHint.value = measurement
      ? '已按两遍法的第一遍测出素材响度；导出时会对每一章独立做同样的测量与增益（逐章独立才能保证章间一致）。'
      : ''
  } catch {
    // 失败已由 error-bus 兑现（选文件/测量失败都不是本视图该自己弹的东西）
    measuringHint.value = ''
  }
}

// ── Step 5 / M4B 的动作 ────────────────────────────────────────────────────

function onFillMetadataFromBook(): void {
  const book = session.book
  store.fillMetadataFromBook(book ? { title: book.title, author: book.author, narrator: book.narrator } : null)
}

function onMergeOnly(): void {
  void flow.mergeM4bOnly()
}

/** 章首标题念白：1.0 靠「在画本里插一行标题念白」（docs/15 §7） */
async function onInsertTitleLine(): Promise<void> {
  const chapterId = store.targetChapterIds[0] ?? session.chapterId
  if (!chapterId) {
    titleLineHint.value = '请先在 Step 1 选择要处理的章节。'
    return
  }
  try {
    // 注意通道名：契约里就是 `chapter:inserTitleLine`（历史拼写，勿改）
    await call('chapter:inserTitleLine', { chapterId })
    // 画本行变了 → 旧预检结果作废（避免用旧结果导出）
    qc.invalidate()
    titleLineHint.value = '已在该章画本开头插入「章节标题」念白行，请到画本页确认文本并安排录音。'
  } catch {
    // 失败已由 error-bus 兑现
    titleLineHint.value = ''
  }
}

// ── Step 6 / 7 / 8 的动作 ──────────────────────────────────────────────────

function onJumpIssue(target: ExportJumpTarget, payload: { chapterId: string | null; lineId: string | null }): void {
  void flow.jumpToIssue(target, payload)
}

function onStartExport(): void {
  void flow.start()
}

function onCancelTask(): void {
  void flow.cancel()
}

function onRetryTask(): void {
  void flow.retry()
}

function onOpenFolder(): void {
  void flow.openOutputFolder()
}

function onVerify(): void {
  void flow.runVerify()
}

function onReloadReport(): void {
  void flow.loadReport()
}

function onSubmitReportJson(): void {
  void flow.saveReportJson()
}

function onViewReport(): void {
  store.goToStep(8)
}

/** 再次导出：清任务与报告、保留参数（「后退不丢数据」的延伸） */
function onRestart(): void {
  flow.restart()
  qc.invalidate()
}
</script>

<template>
  <div class="ns-wiz">
    <header class="ns-wiz__top">
      <div>
        <h2 class="ns-wiz__heading">导出向导</h2>
        <p class="ns-wiz__summary">{{ summaryText }}</p>
      </div>
      <div class="ns-wiz__top-actions">
        <el-tag v-if="!ffmpegReady" type="danger" effect="dark">ffmpeg 不可用</el-tag>
        <el-tag v-else-if="missingFilters.length" type="warning">缺失滤镜：{{ missingFilters.join('、') }}</el-tag>
        <el-tag v-else type="success" effect="plain">ffmpeg 就绪</el-tag>
      </div>
    </header>

    <el-steps :active="store.step - 1" align-center finish-status="success" class="ns-wiz__steps">
      <el-step v-for="item in stepItems" :key="item.index" :title="item.title" />
    </el-steps>

    <LoadingBlock
      v-if="!store.ready"
      text="正在加载书籍、章节与默认导出参数…"
      variant="skeleton"
      :rows="5"
      min-height="320px"
      @retry="store.bootstrap()"
    />

    <EmptyState
      v-else-if="!store.bookId"
      icon="📚"
      title="还没有选择书籍"
      description="导出向导需要一个已导入的书籍。请先到书架打开一本书。"
      action-text="去书架"
      @action="goBookshelf"
    />

    <ErrorBoundary v-else min-height="360px">
      <!-- ── Step 1 范围（docs/15 §5.5） ───────────────────────────────── -->
      <section v-if="store.step === 1" class="ns-wiz__step">
        <div class="ns-wiz__field">
          <span class="ns-wiz__label">导出范围</span>
          <el-radio-group :model-value="store.rangeMode" @update:model-value="onRangeChange">
            <el-radio-button v-for="option in RANGE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
          <span class="ns-wiz__hint">{{ rangeHint }}</span>
        </div>

        <div class="ns-wiz__stats">
          <div class="ns-wiz__stat">
            <span class="ns-wiz__stat-label">合计章数</span>
            <strong class="ns-wiz__stat-value">{{ formatInt(store.targetChapterCount) }}</strong>
            <span class="ns-wiz__stat-hint">共 {{ formatInt(store.chapters.length) }} 章可选</span>
          </div>
          <div class="ns-wiz__stat">
            <span class="ns-wiz__stat-label">预估时长</span>
            <strong class="ns-wiz__stat-value">{{ formatDurationLong(store.estimatedDurationMs) }}</strong>
            <span class="ns-wiz__stat-hint">优先用已录音频时长；无录音时按 4.2 字/秒估算</span>
          </div>
          <div class="ns-wiz__stat">
            <span class="ns-wiz__stat-label">预估成品体积</span>
            <strong class="ns-wiz__stat-value">{{ formatBytes(store.estimatedOutputBytes) }}</strong>
            <span class="ns-wiz__stat-hint">按当前格式与码率</span>
          </div>
          <div class="ns-wiz__stat">
            <span class="ns-wiz__stat-label">中间文件峰值</span>
            <strong class="ns-wiz__stat-value">{{ formatBytes(store.estimatedTempBytes) }}</strong>
            <span class="ns-wiz__stat-hint">单章混音 WAV（约 288 KB/s，docs/15 §11）</span>
          </div>
        </div>

        <el-alert
          v-if="store.currentChapterMissing"
          type="error"
          :closable="false"
          show-icon
          title="当前章节不属于这本书"
          description="会话里的当前章节与已加载的书籍不一致，请回章节列表重新选择，或改用「全书 / 选定章」。"
        />

        <el-alert
          v-if="store.rangeMode === 'book'"
          type="info"
          :closable="false"
          show-icon
          title="整本导出"
          description="按章节顺序逐章导出；中途取消后可重跑，已完成的章会自动跳过（断点续传，docs/15 §5.4）。"
        />

        <template v-else>
          <el-alert
            v-if="store.rangeMode === 'selected'"
            type="info"
            :closable="false"
            show-icon
            title="按卷选择更快"
            description="下方可按卷一键全选/取消；「反选」适合「只补录了一批章」的场景。"
          />

          <div class="ns-wiz__toolbar">
            <el-button size="small" @click="store.selectAllChapters()">全选</el-button>
            <el-button size="small" @click="store.invertSelection()">反选</el-button>
            <el-button size="small" @click="store.clearSelection()">清空</el-button>
            <span class="ns-wiz__hint">已选 {{ formatInt(store.targetChapterCount) }} 章</span>
          </div>

          <div v-if="store.volumeGroups.length > 1" class="ns-wiz__volumes">
            <div v-for="group in store.volumeGroups" :key="String(group.volumeSeq)" class="ns-wiz__volume">
              <span class="ns-wiz__volume-name">{{ group.volumeTitle ?? '未分卷' }}</span>
              <span class="ns-wiz__hint">
                {{ formatInt(group.chapterIds.length) }} 章（已选 {{ formatInt(store.selectedCountOfVolume(group.volumeSeq)) }}）
              </span>
              <el-button size="small" link type="primary" @click="store.selectByVolume(group.volumeSeq, true)">选中本卷</el-button>
              <el-button size="small" link @click="store.selectByVolume(group.volumeSeq, false)">取消本卷</el-button>
            </div>
          </div>

          <el-table :data="store.chapters" size="small" border height="320">
            <el-table-column width="56" label="选">
              <template #default="{ row }">
                <el-checkbox
                  :model-value="isSelected(row.id)"
                  @update:model-value="onToggleChapterInput(row.id)"
                />
              </template>
            </el-table-column>
            <el-table-column prop="seq" label="#" width="60" />
            <el-table-column prop="title" label="章节" min-width="200" show-overflow-tooltip />
            <el-table-column label="卷" width="120">
              <template #default="{ row }">{{ row.volumeTitle ?? UNKNOWN }}</template>
            </el-table-column>
            <el-table-column label="画本行" width="90">
              <template #default="{ row }">{{ formatInt(row.progress?.lineCount ?? row.lineCount) }}</template>
            </el-table-column>
            <el-table-column label="已录" width="90">
              <template #default="{ row }">{{ formatInt(row.progress?.recordedCount ?? 0) }}</template>
            </el-table-column>
            <el-table-column label="缺录" width="90">
              <template #default="{ row }">
                <span :class="{ 'ns-wiz__bad': missingLinesOf(row) > 0 }">{{ formatInt(missingLinesOf(row)) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="预计时长" width="110">
              <template #default="{ row }">{{ estimateOf(row) }}</template>
            </el-table-column>
          </el-table>

          <EmptyState
            v-if="!store.chaptersLoading && store.chapters.length === 0"
            icon="📄"
            title="这本书还没有章节"
            description="请先在导入向导里完成分章，或到章节管理页确认导入结果。"
            action-text="去章节管理"
            size="small"
            @action="goChapters"
          />
        </template>
      </section>

      <!-- ── Step 2 输出（docs/15 §5.5 / §5.3 命名与目录） ─────────────── -->
      <section v-else-if="store.step === 2" class="ns-wiz__step">
        <div class="ns-wiz__grid">
          <div class="ns-wiz__field">
            <span class="ns-wiz__label">格式</span>
            <el-radio-group :model-value="store.params.format" @update:model-value="onFormatChange">
              <el-radio-button value="mp3">MP3</el-radio-button>
              <el-radio-button value="wav">WAV</el-radio-button>
              <el-radio-button value="m4a">M4A</el-radio-button>
            </el-radio-group>
            <span class="ns-wiz__hint">MP3 最通用；WAV 无损但体积大；M4A 适合与整本 M4B 配套。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">码率</span>
            <el-select
              :model-value="store.params.format === 'm4a' ? store.params.m4bBitrate : store.params.mp3Bitrate"
              :disabled="store.params.format === 'wav'"
              @update:model-value="onBitrateChange"
            >
              <template v-if="store.params.format === 'm4a'">
                <el-option v-for="rate in M4B_BITRATES" :key="rate" :value="rate" :label="`${rate} kbps`" />
              </template>
              <template v-else>
                <el-option v-for="rate in MP3_BITRATES" :key="rate" :value="rate" :label="`${rate} kbps`" />
              </template>
            </el-select>
            <span class="ns-wiz__hint">WAV 是无压缩格式，码率不可选。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">采样率</span>
            <el-radio-group :model-value="store.params.sampleRate" @update:model-value="onSampleRateChange">
              <el-radio-button v-for="rate in SAMPLE_RATES" :key="rate" :value="rate">
                {{ rate === 44100 ? '44.1 kHz' : '48 kHz' }}
              </el-radio-button>
            </el-radio-group>
            <span class="ns-wiz__hint">有声书常用 44.1 kHz；与人声素材一致可少一次重采样。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">输出目录</span>
            <el-input :model-value="store.params.outputDir" readonly placeholder="未选择">
              <template #append>
                <el-button @click="store.pickOutputDir()">选择…</el-button>
              </template>
            </el-input>
            <span class="ns-wiz__hint">
              成品会写到「输出目录 / 命名模板」的相对路径里，例如
              <code>{{ fullPath(store.namePreviews[0]?.relativePath ?? '{bookTitle}/001_{chapterTitle}.mp3') }}</code>
            </span>
          </div>

          <div class="ns-wiz__field ns-wiz__field--full">
            <span class="ns-wiz__label">文件命名模板</span>
            <el-input
              :model-value="store.params.fileNameTemplate"
              placeholder="{bookTitle}/{chapterIndex:03}_{chapterTitle}"
              @update:model-value="onTemplateInput"
            />
            <div class="ns-wiz__chips">
              <el-tag
                v-for="placeholder in TEMPLATE_PLACEHOLDERS"
                :key="placeholder.token"
                size="small"
                effect="plain"
                class="ns-wiz__chip"
                @click="appendPlaceholder(placeholder.token)"
              >
                {{ placeholder.token }} · {{ placeholder.label }}
              </el-tag>
              <el-button size="small" link @click="resetTemplate">恢复默认</el-button>
            </div>
            <span class="ns-wiz__hint">
              点击标签把占位符追加到模板末尾；清洗规则与主进程一致（非法字符剔除、
              UTF-8 字节数截断到 {{ MAX_FILE_NAME_BYTES }}、重名自动加 _2）。
            </span>
            <el-alert
              v-if="store.unknownTokens.length"
              type="warning"
              :closable="false"
              show-icon
              title="模板里有不认识的占位符"
              :description="`${store.unknownTokens.join('、')} 会被原样保留在文件名里（不阻断导出）。可用占位符见上方标签。`"
            />
            <el-alert
              v-else-if="store.emptyTokens.length"
              type="info"
              :closable="false"
              show-icon
              title="有占位符当前取值为空"
              :description="`${store.emptyTokens.join('、')} 现在取不到值，会在文件名里留白（例如作者 / 旁白未填写）。`"
            />
          </div>
        </div>

        <!-- 命名预览：与主进程同一个 buildFileNames，所见即所得（docs/15 §5.3） -->
        <div class="ns-wiz__preview">
          <div class="ns-wiz__preview-head">
            <strong>将生成的文件（前 {{ store.namePreviews.length }} 个）</strong>
            <span class="ns-wiz__hint">共 {{ formatInt(store.targetChapterCount) }} 章</span>
          </div>
          <el-table :data="store.namePreviews" size="small" border max-height="240">
            <el-table-column label="#" width="60">
              <template #default="{ $index }">{{ formatInt($index + 1) }}</template>
            </el-table-column>
            <el-table-column label="章节" min-width="160">
              <template #default="{ $index }">{{ store.targetChapterRows[$index]?.title ?? UNKNOWN }}</template>
            </el-table-column>
            <el-table-column prop="fileName" label="文件名" min-width="220" show-overflow-tooltip />
            <el-table-column label="目录" min-width="140">
              <template #default="{ row }">{{ row.dir || '（输出目录根）' }}</template>
            </el-table-column>
            <el-table-column label="重名" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.renamed" type="warning" size="small">已加序号</el-tag>
                <span v-else>{{ UNKNOWN }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div class="ns-wiz__grid">
          <div class="ns-wiz__field">
            <span class="ns-wiz__label">同名文件处理</span>
            <el-radio-group :model-value="store.params.overwrite" @update:model-value="onOverwriteChange">
              <el-radio value="skip">跳过</el-radio>
              <el-radio value="overwrite">覆盖</el-radio>
              <el-radio value="rename">改名</el-radio>
            </el-radio-group>
            <span class="ns-wiz__hint">
              跳过 = 断点续传的默认行为（已成功的章不重渲）；覆盖会重写文件；改名会生成 <code>_2</code> 后缀。
            </span>
          </div>
          <div class="ns-wiz__field">
            <span class="ns-wiz__label">预计占用</span>
            <span class="ns-wiz__kv">
              成品 {{ formatBytes(store.estimatedOutputBytes) }} · 中间文件峰值 {{ formatBytes(store.estimatedTempBytes) }}
            </span>
            <el-button size="small" @click="store.rememberAsDefaults()">把输出参数设为默认</el-button>
            <span class="ns-wiz__hint">写入设置后，下次进入向导会沿用这些值。</span>
          </div>
        </div>

        <el-alert
          v-if="store.params.format === 'mp3' && store.vbrPresets.length"
          type="info"
          :closable="false"
          show-icon
          title="可用的 VBR 质量档（export:vbrPresets）"
          :description="`${store.vbrPresets.map(p => `${p.label}(${p.value})`).join('、')}。1.0 的导出参数只带 CBR 码率（mp3Bitrate），VBR 档位仅作对照，未写入参数。`"
        />

        <!-- M4B 选项：勾选「整本合并 M4B」或选 M4A 时展开（docs/15 §5.2） -->
        <M4bOptionsPanel
          :enabled="store.m4b.enabled"
          :bitrate="store.params.m4bBitrate"
          :split-m4b-every="store.params.splitM4bEvery"
          :chapter-title-template="store.m4b.chapterTitleTemplate"
          :title-reading="store.m4b.titleReading"
          :cover-path="store.params.metadata.coverPath ?? null"
          :chapter-count="store.targetChapterCount"
          :total-duration-ms="store.estimatedDurationMs"
          :sample-rate="store.params.sampleRate"
          :chapter-preview="store.m4bChapterPreview"
          :chapter-warning="store.m4bChapterWarning"
          :too-long="store.m4bTooLong"
          :suggested-split="store.suggestedSplitEvery"
          :book-scope="store.isBookScope"
          @update:enabled="onToggleM4b"
          @update:bitrate="onM4bBitrate"
          @update:split-m4b-every="onSplitEvery"
          @update:chapter-title-template="onChapterTitleTemplate"
          @update:title-reading="onTitleReading"
          @pick-cover="store.pickCover()"
          @merge-only="onMergeOnly"
          @insert-title-line="onInsertTitleLine"
        />
        <p v-if="titleLineHint" class="ns-wiz__hint">{{ titleLineHint }}</p>
      </section>

      <!-- ── Step 3 混音方案（docs/15 §5.5 / §10） ─────────────────────── -->
      <section v-else-if="store.step === 3" class="ns-wiz__step">
        <div class="ns-wiz__toolbar">
          <el-switch
            :model-value="store.useMixProject"
            active-text="使用混音方案"
            @update:model-value="onToggleMixProject"
          />
          <span class="ns-wiz__hint">关闭 = 纯干声导出（不混入音乐/音效，也不套用总线处理）。</span>
          <el-button size="small" :loading="store.mixLoading" @click="store.loadMixPlans()">重新读取</el-button>
        </div>

        <LoadingBlock v-if="store.mixLoading" text="正在读取混音方案…" min-height="160px" @retry="store.loadMixPlans()" />

        <template v-else-if="store.useMixProject">
          <el-alert
            v-if="store.mixDiagnosisMessage"
            type="error"
            :closable="false"
            show-icon
            :title="store.mixDiagnosisMessage.title"
            :description="[store.mixDiagnosisMessage.detail, store.mixDiagnosisMessage.hint].filter(Boolean).join(' ')"
          />

          <!-- 全书：按章汇总（IPC 是按章查询的，因此抽样统计） -->
          <template v-if="store.isBookScope">
            <el-alert
              type="info"
              :closable="false"
              show-icon
              title="全书导出将使用各章的默认方案"
              :description="`全书范围无法指定单一方案，主进程会逐章取该章的默认混音方案。下面抽样统计了 ${formatInt(store.mixSummary?.sampled ?? 0)} 章（共 ${formatInt(store.mixSummary?.total ?? store.targetChapterCount)} 章）：有方案 ${formatInt(store.mixSummary?.withProjects ?? 0)} 章，无方案 ${formatInt(store.mixSummary?.withoutProjects ?? 0)} 章，带 BGM ${formatInt(store.mixSummary?.withBgm ?? 0)} 章，无人声轨 ${formatInt(store.mixSummary?.noVoiceTrack ?? 0)} 章。`"
            />
            <el-table :data="mixSummaryRows" size="small" border max-height="320">
              <el-table-column prop="chapterTitle" label="章节" min-width="180" show-overflow-tooltip />
              <el-table-column prop="projectName" label="默认方案" min-width="140" show-overflow-tooltip />
              <el-table-column label="轨道" width="90">
                <template #default="{ row }">{{ formatInt(row.trackCount) }} 轨</template>
              </el-table-column>
              <el-table-column label="人声 / 音乐 / 音效" width="150">
                <template #default="{ row }">{{ row.voiceCount }} / {{ row.musicCount }} / {{ row.sfxCount }}</template>
              </el-table-column>
              <el-table-column label="BGM" width="80">
                <template #default="{ row }">
                  <el-tag v-if="row.hasBgm" size="small" type="success">有</el-tag>
                  <span v-else>{{ UNKNOWN }}</span>
                </template>
              </el-table-column>
              <el-table-column label="目标响度" width="110">
                <template #default="{ row }">{{ formatLufs(row.targetLufs) }}</template>
              </el-table-column>
            </el-table>
          </template>

          <!-- 单章 / 选定章：选择方案 -->
          <template v-else>
            <EmptyState
              v-if="store.mixProjects.length === 0"
              icon="🎚"
              title="这一章还没有混音方案"
              description="请到混音台为该章创建方案（干声版 / 带 BGM 版），或关闭上面的开关做纯干声导出。"
              action-text="去混音台"
              size="small"
              @action="goMixer"
            />
            <el-radio-group
              v-else
              :model-value="store.mixProjectId"
              class="ns-wiz__plans"
              @update:model-value="onSelectMixProject"
            >
              <el-radio v-for="project in store.mixProjects" :key="project.id" :value="project.id" class="ns-wiz__plan">
                {{ project.name }}
                <el-tag v-if="project.isDefault" size="small" effect="plain">默认</el-tag>
                <span class="ns-wiz__hint">v{{ project.version }} · {{ formatInt(project.tracks.length) }} 轨</span>
              </el-radio>
            </el-radio-group>

            <div v-if="store.mixDetail" class="ns-wiz__stats">
              <div class="ns-wiz__stat">
                <span class="ns-wiz__stat-label">轨道数</span>
                <strong class="ns-wiz__stat-value">{{ formatInt(store.mixDetail.trackCount) }}</strong>
                <span class="ns-wiz__stat-hint">
                  人声 {{ store.mixDetail.voiceCount }} · 音乐 {{ store.mixDetail.musicCount }} · 音效 {{ store.mixDetail.sfxCount }}
                  <template v-if="store.mixDetail.mutedCount">· 静音 {{ store.mixDetail.mutedCount }}</template>
                </span>
              </div>
              <div class="ns-wiz__stat">
                <span class="ns-wiz__stat-label">目标响度</span>
                <strong class="ns-wiz__stat-value">{{ formatLufs(store.mixDetail.targetLufs) }}</strong>
                <span class="ns-wiz__stat-hint">
                  真峰 {{ formatDbfs(store.mixDetail.truePeakDb) }} ·
                  {{ store.mixDetail.limiterEnabled ? '已启用限幅' : '未启用限幅' }}
                </span>
              </div>
              <div class="ns-wiz__stat">
                <span class="ns-wiz__stat-label">BGM</span>
                <strong class="ns-wiz__stat-value">{{ store.mixDetail.hasBgm ? '有' : '无' }}</strong>
                <span class="ns-wiz__stat-hint">音乐轨 {{ formatInt(store.mixDetail.musicCount) }} 条</span>
              </div>
              <div class="ns-wiz__stat">
                <span class="ns-wiz__stat-label">头尾静音</span>
                <strong class="ns-wiz__stat-value">
                  {{ formatDuration(store.mixDetail.headSilenceMs) }} / {{ formatDuration(store.mixDetail.tailSilenceMs) }}
                </strong>
                <span class="ns-wiz__stat-hint">方案默认值；Step 4 可覆盖</span>
              </div>
            </div>

            <el-alert
              v-if="store.mixDetail && store.mixDetail.soloCount > 0"
              type="warning"
              :closable="false"
              show-icon
              title="方案里有 Solo 轨道"
              description="Solo 会静音其他轨道；侧链源（人声）必须始终有效，否则自动闪避会失效（docs/15 §3.1）。"
            />
            <el-alert
              v-if="store.mixDetail && store.mixDetail.targetLufs !== store.params.targetLufs"
              type="info"
              :closable="false"
              show-icon
              title="方案的响度目标与导出参数不同"
              description="导出以 Step 4 的参数为准（逐章独立归一）；如需与方案一致，可回上一步把目标响度改回来。"
            />
            <p class="ns-wiz__hint">
              混音方案管「音量与效果」、对轨方案管「位置」，是两层配置。导出时主进程会把
              <code>paramsHash</code>（混音方案 + 对轨版本 + 处理预设 + 响度参数 + 导出参数）记进出库记录，
              参数不变时重跑会跳过已完成的章。
            </p>
          </template>
        </template>
      </section>

      <!-- ── Step 4 响度（docs/15 §4 / §5.5） ──────────────────────────── -->
      <section v-else-if="store.step === 4" class="ns-wiz__step">
        <div class="ns-wiz__grid">
          <div class="ns-wiz__field">
            <span class="ns-wiz__label">目标响度</span>
            <el-radio-group :model-value="store.params.targetLufs" @update:model-value="onTargetLufs">
              <el-radio v-for="preset in loudnessPresets" :key="preset.id" :value="preset.lufs">{{ preset.label }}</el-radio>
            </el-radio-group>
            <span class="ns-wiz__hint">当前为{{ isCustomLufs ? '自定义值' : '预设档位' }}；换档会同步 LRA 默认值。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">自定义目标（LUFS）</span>
            <el-input-number
              :model-value="store.params.targetLufs"
              :min="-40"
              :max="0"
              :step="0.5"
              :precision="1"
              controls-position="right"
              @update:model-value="onTargetLufs"
            />
            <span class="ns-wiz__hint">有声书行业惯例 -16 LUFS；越响越可能触发限幅。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">真峰上限（dBTP）</span>
            <el-input-number
              :model-value="store.params.truePeakDb"
              :min="-6"
              :max="-0.1"
              :step="0.1"
              :precision="1"
              controls-position="right"
              @update:model-value="onTruePeak"
            />
            <span class="ns-wiz__hint">默认 {{ EXPORT_DEFAULTS.truePeakDb }} dBTP；靠 alimiter + 实测验证保证不超。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">LRA（动态范围）</span>
            <el-input-number
              :model-value="store.params.lra"
              :min="1"
              :max="30"
              :step="1"
              controls-position="right"
              @update:model-value="onLra"
            />
            <span class="ns-wiz__hint">测量与校验用；1.0 用线性 volume 校正，不会动态压动态。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">头部静音（ms）</span>
            <el-input-number
              :model-value="store.params.headSilenceMs"
              :min="0"
              :max="10000"
              :step="100"
              controls-position="right"
              @update:model-value="onHeadSilence"
            />
            <span class="ns-wiz__hint">默认 {{ EXPORT_DEFAULTS.headSilenceMs }} ms；避免播放器开头吃字。</span>
          </div>

          <div class="ns-wiz__field">
            <span class="ns-wiz__label">尾部静音（ms）</span>
            <el-input-number
              :model-value="store.params.tailSilenceMs"
              :min="0"
              :max="20000"
              :step="100"
              controls-position="right"
              @update:model-value="onTailSilence"
            />
            <span class="ns-wiz__hint">默认 {{ EXPORT_DEFAULTS.tailSilenceMs }} ms；给结尾留出呼吸感。</span>
          </div>
        </div>

        <el-alert
          v-if="mixConflict"
          type="warning"
          :closable="false"
          show-icon
          :title="mixConflict.title"
          :description="[mixConflict.detail, mixConflict.hint].filter(Boolean).join(' ')"
        />

        <div class="ns-wiz__measure">
          <div class="ns-wiz__measure-head">
            <strong>先测量再决定</strong>
            <el-button size="small" :loading="store.measuring" @click="measureReference">选择参考音频并测量</el-button>
            <el-button v-if="store.measurement" size="small" link @click="store.clearMeasurement()">清除测量</el-button>
          </div>
          <p class="ns-wiz__hint">
            导出用的是<strong>两遍法</strong>（docs/15 §4）：第一遍测量素材的积分响度 input_i，
            第二遍按 <code>gainDb = 目标 - input_i</code> 做线性增益并用 <code>alimiter</code> 保真峰，
            最后重新测量验证（偏差 &gt; 0.5 LU 会微调一次）。先测一下参考素材，就能预判需要多少增益。
          </p>
          <div v-if="store.measurement" class="ns-wiz__stats">
            <div class="ns-wiz__stat">
              <span class="ns-wiz__stat-label">实测积分响度</span>
              <strong class="ns-wiz__stat-value">{{ formatLufs(store.measurement.inputI) }}</strong>
              <span class="ns-wiz__stat-hint">{{ store.measuredPath ?? '' }}</span>
            </div>
            <div class="ns-wiz__stat">
              <span class="ns-wiz__stat-label">实测真峰</span>
              <strong class="ns-wiz__stat-value">{{ formatDbfs(store.measurement.inputTp) }}</strong>
              <span class="ns-wiz__stat-hint">导出上限 {{ formatDbfs(store.params.truePeakDb) }}</span>
            </div>
            <div class="ns-wiz__stat">
              <span class="ns-wiz__stat-label">实测 LRA</span>
              <strong class="ns-wiz__stat-value">{{ formatLra(store.measurement.inputLra) }}</strong>
              <span class="ns-wiz__stat-hint">门限 {{ formatDb(store.measurement.inputThresh) }}</span>
            </div>
            <div class="ns-wiz__stat">
              <span class="ns-wiz__stat-label">建议增益</span>
              <strong class="ns-wiz__stat-value">{{ formatDb(store.suggestedGainDb) }}</strong>
              <span class="ns-wiz__stat-hint">目标 {{ formatLufs(store.params.targetLufs) }}</span>
            </div>
          </div>
          <el-alert
            v-if="store.measurementSilent"
            type="error"
            :closable="false"
            show-icon
            title="测量结果是近乎静音"
            description="input_i 接近 -∞ 说明素材几乎没有声音；请检查对轨与素材文件 —— 这种章渲染出来也是静音（docs/15 §11）。"
          />
          <p v-if="measuringHint" class="ns-wiz__hint">{{ measuringHint }}</p>
        </div>
      </section>

      <!-- ── Step 5 元数据与封面（docs/15 §5.5 / §5.1） ────────────────── -->
      <section v-else-if="store.step === 5" class="ns-wiz__step">
        <MetadataEditor
          :metadata="store.params.metadata"
          :write-metadata="store.writeMetadata"
          :book="session.book ? { title: session.book.title, author: session.book.author, narrator: session.book.narrator } : null"
          :format="store.params.format"
          @update:write-metadata="onWriteMetadata"
          @commit="onCommitMetadata"
          @pick-cover="store.pickCover()"
          @clear-cover="store.clearCover()"
          @fill-from-book="onFillMetadataFromBook"
        />

        <M4bOptionsPanel
          v-if="store.m4b.enabled"
          :enabled="store.m4b.enabled"
          :bitrate="store.params.m4bBitrate"
          :split-m4b-every="store.params.splitM4bEvery"
          :chapter-title-template="store.m4b.chapterTitleTemplate"
          :title-reading="store.m4b.titleReading"
          :cover-path="store.params.metadata.coverPath ?? null"
          :chapter-count="store.targetChapterCount"
          :total-duration-ms="store.estimatedDurationMs"
          :sample-rate="store.params.sampleRate"
          :chapter-preview="store.m4bChapterPreview"
          :chapter-warning="store.m4bChapterWarning"
          :too-long="store.m4bTooLong"
          :suggested-split="store.suggestedSplitEvery"
          :can-merge-only="!!store.report"
          :book-scope="store.isBookScope"
          @update:enabled="onToggleM4b"
          @update:bitrate="onM4bBitrate"
          @update:split-m4b-every="onSplitEvery"
          @update:chapter-title-template="onChapterTitleTemplate"
          @update:title-reading="onTitleReading"
          @pick-cover="store.pickCover()"
          @merge-only="onMergeOnly"
          @insert-title-line="onInsertTitleLine"
        />
        <p v-if="titleLineHint" class="ns-wiz__hint">{{ titleLineHint }}</p>
      </section>

      <!-- ── Step 6 预检报告（docs/15 §6.1） ───────────────────────────── -->
      <section v-else-if="store.step === 6" class="ns-wiz__step">
        <QcPreCheckPanel
          :request="store.preCheckRequest"
          :scope-label="store.rangeLabel"
          :chapter-titles="chapterTitles"
          @jump="onJumpIssue"
        />
      </section>

      <!-- ── Step 7 执行（docs/15 §5.5 / §5.4） ────────────────────────── -->
      <section v-else-if="store.step === 7" class="ns-wiz__step">
        <ExportProgressPanel
          :task-id="store.taskId"
          :progress="progressEvent"
          :submitting="starting"
          :scope="store.rangeLabel"
          :output-dir="store.params.outputDir"
          :format="store.params.format"
          :planned-chapters="store.targetChapterCount"
          :task-kind="taskKind"
          :title="taskTitle"
          :finished="!!store.report"
          @start="onStartExport"
          @cancel="onCancelTask"
          @retry="onRetryTask"
          @open="goTasks"
          @close="store.clearTask()"
          @open-folder="onOpenFolder"
        />
      </section>

      <!-- ── Step 8 完成报告（docs/15 §6.2 / §6.3） ────────────────────── -->
      <section v-else class="ns-wiz__step">
        <ExportReportPanel
          :report="store.report"
          :loading="store.reportLoading"
          :unavailable="reportUnavailable"
          :verify="verifyResult"
          :verify-running="qc.verifyRunning"
          :verified-at="qc.verifiedAt"
          :output-dir="store.params.outputDir"
          :saved-path="store.reportSavePath"
          @open-folder="onOpenFolder"
          @re-export="onRestart"
          @export-json="onSubmitReportJson"
          @verify="onVerify"
          @reload="onReloadReport"
        />
      </section>
    </ErrorBoundary>

    <!-- 步骤门槛提示 + 导航（切步骤不清数据 → 后退不丢数据） -->
    <footer v-if="store.ready && store.bookId" class="ns-wiz__foot">
      <div class="ns-wiz__foot-issues">
        <span v-if="store.stepIssues.length && store.step !== 7 && store.step !== 8" class="ns-wiz__foot-issue">
          {{ nextDisabledReason }}
        </span>
        <span v-else class="ns-wiz__hint">第 {{ store.step }} 步 · {{ store.stepTitle }}</span>
      </div>
      <div class="ns-wiz__foot-actions">
        <el-button :disabled="store.step <= 1" @click="store.prevStep()">上一步</el-button>
        <el-button v-if="store.step === 6" type="primary" :disabled="!canGoNext" @click="onStartExport">
          开始导出
        </el-button>
        <el-button v-else-if="store.step === 7" type="primary" :disabled="!store.report" @click="onViewReport">
          查看报告
        </el-button>
        <el-button v-else-if="store.step === 8" type="primary" @click="onRestart">再次导出</el-button>
        <el-button v-else type="primary" :disabled="!canGoNext" @click="store.nextStep()">下一步</el-button>
      </div>
    </footer>

    <!-- 导出中离开页面的确认（docs/15 §5.5 Step 7：导出过程中禁止离开页面） -->
    <ConfirmDialog
      v-model="leaveConfirmVisible"
      title="导出正在进行，确定要离开吗？"
      message="离开本页只是关掉界面，主进程的任务仍在后台继续；也可以先取消任务再离开。"
      :details="[
        '已完成的章会保留，重跑时自动跳过（断点续传）。',
        `当前范围：${store.rangeLabel}`,
      ]"
      confirm-text="离开页面"
      type="warning"
      @confirm="flow.confirmLeave()"
      @cancel="flow.cancelLeave()"
    />
  </div>
</template>

<style scoped>
.ns-wiz {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px 24px;
}
.ns-wiz__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ns-wiz__heading {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 18px;
}
.ns-wiz__summary {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-wiz__top-actions {
  display: flex;
  gap: 8px;
}
.ns-wiz__steps {
  padding: 6px 0 2px;
}
.ns-wiz__step {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ns-wiz__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}
.ns-wiz__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-wiz__field--full {
  grid-column: 1 / -1;
}
.ns-wiz__label {
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  font-weight: 600;
}
.ns-wiz__hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-all;
}
.ns-wiz__hint code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-wiz__bad {
  color: var(--ns-danger, #f56c6c);
}
.ns-wiz__kv {
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
.ns-wiz__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.ns-wiz__chip {
  cursor: pointer;
}
.ns-wiz__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.ns-wiz__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-wiz__stat-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-wiz__stat-value {
  color: var(--ns-text-primary, #303133);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.ns-wiz__stat-hint {
  color: var(--ns-text-placeholder, #c0c4cc);
  font-size: 11px;
  line-height: 1.6;
}
.ns-wiz__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.ns-wiz__volumes {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.ns-wiz__volume {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 999px;
  background: var(--ns-bg-elevated, #fff);
  font-size: 12px;
}
.ns-wiz__volume-name {
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-wiz__preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-wiz__preview-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-wiz__plans {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-wiz__plan {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ns-wiz__measure {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-wiz__measure-head {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
}
.ns-wiz__measure p {
  margin: 0;
}
.ns-wiz__foot {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: 0 -2px 10px rgb(0 0 0 / 6%);
}
.ns-wiz__foot-issues {
  min-width: 0;
  flex: 1;
}
.ns-wiz__foot-issue {
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
}
.ns-wiz__foot-actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
</style>
