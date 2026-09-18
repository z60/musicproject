<!--
  Novel Studio · 画本编辑主界面（docs/11 §4.1 三栏布局）
  ============================================================================
  三栏：左＝章节导航（行数/进度/质检徽标，点击切章，顶部生成入口）；中＝画本区（表格 ↔ 剧本
  ↔ 待确认队列，共享选中行与滚动位置）+ 批量条 + 状态栏；右＝可折叠侧栏（原文/角色/质检）。

  为什么「待确认队列」是中栏的第三种视图而不是右栏侧栏：canvas.store 的 activeView 本身就是
  `'table' | 'script' | 'review'`，useCanvasKeyboard 的 Ctrl+1/2/3 也这么定义；只有放在中栏才能同时
  拿到「共享选中行 + 滚动位置 + Ctrl+1 一键返回」。质检面板是逐条修复的辅助工具，放右栏。

  硬约束：docs/11 §4.8/§4.9（切章前若有未保存改动必须先 flush 并给出可见反馈、Ctrl+S 强制落库）；
  docs/11 §2.4（embeddingUsed=false 必须显著提示「已降级为规则判定」）；docs/22 §6.2（不调
  window.api.invoke、不自拼错误文案、提示走 error-bus）。数据/编辑/撤销/落库/质检/生成全在
  canvas.store，本文件只做布局、面板开合、章节切换与键盘接线。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { CanvasGenerateOptions, CanvasLinePatch, Chapter, ChapterCanvasState, ChapterProgress, Character, DecidedBy, Id, LineKind } from '@shared/types.ts'
import { BUILTIN_RULE_SETS, CANVAS_DEFAULTS, DECIDED_BY_LABELS, LINE_KIND_LABELS } from '@shared/constants.ts'
import { call } from '@/shared/lib/ipc.ts'
import { reportByKey } from '@/shared/lib/error-bus.ts'
import { formatCount, formatDurationLong, formatInt, formatPercent } from '@/shared/lib/format.ts'
import AutoSaveIndicator from '@/shared/ui/AutoSaveIndicator.vue'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import CanvasTable from '../components/CanvasTable.vue'
import CanvasScriptView from '../components/CanvasScriptView.vue'
import LineEditorDrawer from '../components/LineEditorDrawer.vue'
import SpeakerCell from '../components/SpeakerCell.vue'
import EmotionTagPicker from '../components/EmotionTagPicker.vue'
import PauseControl from '../components/PauseControl.vue'
import PronunciationEditor from '../components/PronunciationEditor.vue'
import CharacterPanel from '../components/CharacterPanel.vue'
import CharacterMergeDialog from '../components/CharacterMergeDialog.vue'
import ReviewQueue from '../components/ReviewQueue.vue'
import SourceTextPane from '../components/SourceTextPane.vue'
import QualityIssuesPanel from '../components/QualityIssuesPanel.vue'
import BatchActionBar from '../components/BatchActionBar.vue'
import TaskPackageExportDialog from '../components/TaskPackageExportDialog.vue'
import TaskPackageImportDialog from '../components/TaskPackageImportDialog.vue'
import { useCanvasFilter, SPEAKER_ANY, SPEAKER_NARRATION, SPEAKER_UNKNOWN } from '../composables/useCanvasFilter.ts'
import { useCanvasKeyboard } from '../composables/useCanvasKeyboard.ts'
import { useCanvasStore } from '../stores/canvas.store.ts'
import type { CanvasViewMode } from '../stores/canvas.store.ts'
import { useCharactersStore } from '../stores/characters.store.ts'
import { usePackagesStore } from '../stores/packages.store.ts'

const props = withDefaults(defineProps<{
  /** 指定要编辑的章节（深链跳转用）；为空时跟随 session 的当前章节 */
  chapterId?: Id | null
}>(), { chapterId: null })
const emit = defineEmits<{
  /** 用户切换了章节（宿主页面可据此同步自己的上下文） */
  'chapter-changed': [chapterId: Id]
}>()

const router = useRouter()
const session = useSessionStore()
const settings = useSettingsStore()
const canvas = useCanvasStore()
const characters = useCharactersStore()
const packages = usePackagesStore()

const notice = ref('')
const bookId = computed<Id | null>(() => session.book?.id ?? null)
const projectId = computed<Id | null>(() => session.projectId)
const readonly = computed(() => packages.readonly)
const readonlyReason = computed(() => (readonly.value ? '当前画本来自任务包且尚未合并，只读以防与导演侧不一致（docs/11 §6.3）。' : null))
const currentChapterId = computed<Id | null>(() => props.chapterId ?? session.chapterId)
const activeLine = computed(() => canvas.activeLine)
const saveErrorText = computed<string | null>(() => (canvas.saveError as { message?: string } | null)?.message ?? null)

// ── 左栏：章节导航 ───────────────────────────────────────────────────────────
type ChapterRow = Chapter & { progress: ChapterProgress | null }
const chapters = ref<ChapterRow[]>([])
const chaptersLoading = ref(false)
const CANVAS_STATE_LABELS: Record<ChapterCanvasState, string> = { none: '未生成', generated: '已生成', edited: '已编辑', done: '已完成' }
const chapterTitle = computed(() => chapters.value.find(c => c.id === canvas.chapterId)?.title ?? session.chapter?.title ?? null)

async function loadChapters(): Promise<void> {
  if (!bookId.value) { chapters.value = []; return }
  chaptersLoading.value = true
  try { chapters.value = await call('chapter:list', { bookId: bookId.value }) } finally { chaptersLoading.value = false }
}

/** 切章前先落库（docs/11 §4.8），并把结果说清楚——不允许静默丢掉内存里的改动 */
async function openChapter(row: ChapterRow): Promise<void> {
  if (row.id === canvas.chapterId) return
  if (canvas.hasUnsaved) {
    const pending = canvas.pendingCount
    const ok = await canvas.flush()
    notice.value = ok
      ? `切换章节前已把 ${formatCount(pending)} 行的修改写入数据库。`
      : `切换章节前落库失败：这 ${formatCount(pending)} 行修改仍在内存中（见状态栏），可重试或「放弃修改」。`
  }
  session.selectChapter(row)
  emit('chapter-changed', row.id)
  await canvas.load(row.id)
  if (!notice.value.startsWith('切换章节前落库失败')) notice.value = `已切到《${row.title}》。`
}

// ── 中栏：视图 / 筛选 / 选中 ────────────────────────────────────────────────
/** 顶层解构出来的 ref 在模板里会被自动解包，避免模板里写 `xxx.value` */
const canvasFilter = useCanvasFilter(canvas.lines)
const { filter: filterState, counts: filterCounts, summary: filterSummary, isActive: filterActive, filtered: filteredLines } = canvasFilter
const showGenerateForm = ref(false)
const batchTargets = computed(() => (canvas.selectedCount > 0 ? canvas.selectedLines : filteredLines.value))
const showBatchBar = computed(() => canvas.lines.length > 0 && (canvas.selectedCount > 0 || filterActive.value))

/** 快速编辑区的写入口：单行 patch 走 store 的 commitFields（立即落库 + 进撤销栈） */
function patchActiveLine(patch: CanvasLinePatch, label: string): void {
  const line = activeLine.value
  if (!line || readonly.value) return
  void canvas.commitFields(line.id, patch, label)
}

function gotoRecording(): void { void router.push('/recording') }

/**
 * 中栏视图切换：el-radio-group 的选项值即 CanvasViewMode。
 *
 * 参数收宽是必须的：Element Plus 2.14 起事件参数类型为
 * `string | number | boolean | undefined`，精确类型因函数参数逆变而不可赋值。
 */
function onActiveViewInput(value: string | number | boolean | undefined): void {
  canvas.setActiveView(value as CanvasViewMode)
}

/** 说话人筛选：el-select 的选项值为 string（SPEAKER_* 常量或角色 id） */
function onSpeakerFilterInput(value: string): void {
  canvasFilter.set({ speaker: value })
}

/** 类型筛选：el-select 可清空，空值按 null（不限）处理；选项值为 LineKind */
function onKindFilterInput(value: LineKind | null): void {
  canvasFilter.set({ kind: value ?? null })
}

/** 待确认筛选（el-checkbox）：载荷为 boolean | string | number，未勾选即不限（null） */
function onNeedsReviewFilterInput(value: boolean | string | number): void {
  canvasFilter.set({ needsReview: value ? true : null })
}

/** 关键字筛选（el-input）：载荷为 string */
function onKeywordFilterInput(value: string): void {
  canvasFilter.set({ keyword: value })
}

/** 筛选后清掉不可见的选中项，避免批量操作改了看不见的行（useCanvasFilter.pruneSelection） */
watch(filteredLines, () => {
  const pruned = canvasFilter.pruneSelection(canvas.selectedIds)
  if (pruned.size !== canvas.selectedIds.size) canvas.selectByLineIds([...pruned])
})

function focusLine(lineId: Id, openDrawer = false): void {
  const line = canvas.lineById.get(lineId)
  if (!line) return
  if (!canvasFilter.matches(line)) canvasFilter.reset() // 被筛掉的行直接聚焦会「看起来没反应」
  if (canvas.activeView === 'review') canvas.setActiveView('table')
  canvas.focusLine(lineId, { openDrawer })
}

function onScroll(scrollTop: number, topIndex: number): void {
  canvas.setScrollTop(canvas.activeView, scrollTop, topIndex)
}

/** 行被改动后重跑质检（表格/抽屉/队列都走这里） */
function onLineChanged(): void { void canvas.loadIssueList() }

const drawerOpen = computed<boolean>({
  get: () => canvas.drawerOpen,
  set: (value: boolean) => {
    if (value) { if (canvas.activeLineId) canvas.openDrawer(canvas.activeLineId) } else { canvas.closeDrawer() }
  },
})

// ── 右栏：可折叠侧栏 ────────────────────────────────────────────────────────
type RightPanel = 'source' | 'characters' | 'quality' | 'none'
const rightPanel = ref<RightPanel>('source')
function toggleRightPanel(): void { rightPanel.value = rightPanel.value === 'none' ? 'source' : 'none' }

/** 右栏视图切换：el-radio-group 的选项值即这三项之一（参数收宽，理由同上） */
function onRightPanelInput(value: string | number | boolean | undefined): void {
  rightPanel.value = value as 'source' | 'characters' | 'quality'
}

// ── 顶栏：强制保存 / 导出文本 / 任务包 ──────────────────────────────────────
/** 导出文本格式（canvas:exportText 支持 txt/csv/json；默认 TXT 最通用） */
const exportFormat = 'txt' as const
const taskExportOpen = ref(false)
const taskImportOpen = ref(false)

async function forceSave(): Promise<void> {
  const pending = canvas.pendingCount
  const ok = await canvas.saveNow()
  notice.value = ok
    ? (pending > 0 ? `已强制落库：${formatCount(pending)} 行未保存修改已写入数据库。` : '已强制落库：没有待写库的修改。')
    : '强制落库失败：修改仍在内存中，可点状态栏的「重试」或「放弃修改」。'
}

async function exportText(): Promise<void> {
  if (!canvas.chapterId) return
  const result = await call('canvas:exportText', { chapterId: canvas.chapterId, format: exportFormat })
  notice.value = `已导出本章画本文本（${exportFormat.toUpperCase()}）：${result.path}`
}

async function onMerged(): Promise<void> {
  notice.value = '回收合并完成：画本行与录音片段已刷新，明细见回收报告。'
  await canvas.reload({ force: true })
  await characters.load(bookId.value, projectId.value)
}

/** docs/11 §6.5：linesHash 不一致 → 只含变更行的增量下发 */
function onIncrementalExport(): void {
  taskImportOpen.value = false
  packages.setExportOptions({ onlyChangedLines: true })
  taskExportOpen.value = true
  notice.value = '已切到增量导出：本次只包含相对上次下发发生变更的行。'
}

// ── 生成画本（docs/11 §2 / §2.4）───────────────────────────────────────────
const generateOptions = ref<CanvasGenerateOptions>({
  useEmbedding: true,
  useLlm: false,
  contextWindow: CANVAS_DEFAULTS.contextWindow,
  threshold: CANVAS_DEFAULTS.attributionThreshold,
  margin: CANVAS_DEFAULTS.attributionMargin,
  ruleSetId: null,
  overwriteHuman: false,
  inferTags: true,
})
const generateConfirmOpen = ref(false)
const warnedChapterId = ref<Id | null>(null)
const report = computed(() => canvas.generateReport)
const humanCount = computed(() => canvas.lines.filter(line => line.decidedBy === 'human').length)
const byKindRows = computed(() => (Object.keys(LINE_KIND_LABELS) as LineKind[])
  .map(kind => ({ kind, label: LINE_KIND_LABELS[kind] ?? kind, count: report.value?.byKind?.[kind] ?? 0 })))
const byDecisionRows = computed(() => (Object.keys(DECIDED_BY_LABELS) as DecidedBy[])
  .map(key => ({ key, label: DECIDED_BY_LABELS[key] ?? key, count: report.value?.byDecision?.[key] ?? 0 })))

// 默认值来自 CANVAS_DEFAULTS，再被 settings.canvas 覆盖（用户改过设置就按设置来）
watch(() => settings.settings?.canvas, (config) => {
  if (!config) return
  generateOptions.value = {
    ...generateOptions.value,
    contextWindow: config.contextWindow,
    threshold: config.attributionThreshold,
    margin: config.attributionMargin,
  }
}, { immediate: true })

/** docs/11 §2.4：降级必须显著提示 —— 报告里的红条 + 一条 error-bus 提示（每章只报一次） */
watch(report, (value) => {
  if (!value || value.embeddingUsed || warnedChapterId.value === value.chapterId) return
  warnedChapterId.value = value.chapterId
  reportByKey('CANVAS_EMBEDDING_UNAVAILABLE')
})

/** docs/11 §8：本章已有 N 行人工修改时先确认（人工结果永不覆盖，只覆盖其余部分） */
function askGenerate(): void {
  if (humanCount.value > 0 && !generateOptions.value.overwriteHuman) generateConfirmOpen.value = true
  else void runGenerate()
}

async function runGenerate(): Promise<void> {
  generateConfirmOpen.value = false
  if (!canvas.chapterId) return
  const taskId = await canvas.startGenerate(generateOptions.value)
  notice.value = taskId
    ? '生成任务已启动：进度见下方进度卡，完成后会自动刷新行、报告与质检。'
    : '生成没有启动成功（详见提示），可检查章节文本后重试。'
}

// ── 键盘（Ctrl+S 落库 / Ctrl+Z 撤销 / Ctrl+1·2·3 切视图 / Enter 开抽屉）─────
const keyboard = useCanvasKeyboard({
  // CanvasViewMode 与 CanvasKeyboardScope 取值一致（'table' | 'script' | 'review'），
  // 直接透传即可。早期写成 `activeView === 'review' ? 'review' : 'editor'`，
  // 而 'editor' 并不是合法的 scope（scope 只有三档视图），类型检查直接报 TS2322。
  scope: () => canvas.activeView,
  // 待确认队列自带一套键位（scope=review）；抽屉打开时也不抢键（输入框里要能打字）
  enabled: () => canvas.activeView !== 'review' && !canvas.drawerOpen,
  actions: {
    'editor.save': () => { void forceSave() },
    'editor.showTable': () => canvas.setActiveView('table'),
    'editor.showScript': () => canvas.setActiveView('script'),
    'editor.showReview': () => canvas.setActiveView('review'),
    'editor.toggleView': () => canvas.setActiveView(canvas.activeView === 'table' ? 'script' : 'table'),
    'editor.openDrawer': () => { if (canvas.activeLineId) canvas.openDrawer(canvas.activeLineId) },
    'editor.closeDrawer': () => canvas.closeDrawer(),
    'editor.clearSelection': () => canvas.clearSelection(),
    'editor.selectAll': () => canvas.selectAll(),
    'editor.prevLine': (extend: boolean) => { canvas.moveActive(-1, extend) },
    'editor.nextLine': (extend: boolean) => { canvas.moveActive(1, extend) },
    'editor.undo': () => { void canvas.undo() },
    'editor.redo': () => { void canvas.redo() },
  },
})

// ── 角色合并（预览与提交走 characters.store，禁止自算「将影响 N 行」）────────
const mergeOpen = ref(false)
const mergeLoading = ref(false)
const mergeWithId = ref<Id | null>(null)
const mergeTarget = computed<Character | null>(() => (activeLine.value?.characterId ? characters.characterById.get(activeLine.value.characterId) ?? null : null))
const mergeParticipants = computed<Character[]>(() => {
  const other = characters.activeCharacters.find(c => c.id === mergeWithId.value) ?? null
  return mergeTarget.value && other ? [mergeTarget.value, other] : []
})
const mergePreview = computed(() => {
  const target = mergeTarget.value
  if (!target || !mergeWithId.value) return null
  return characters.previewMerge(target.id, [target.id, mergeWithId.value])
})
const mergeCandidates = computed(() => characters.activeCharacters.filter(c => c.id !== mergeTarget.value?.id))

async function onMergeConfirm(payload: { targetId: Id; sourceIds: Id[]; keepAliases: boolean }): Promise<void> {
  mergeLoading.value = true
  try {
    await characters.mergeCharacters(payload.targetId, payload.sourceIds, payload.keepAliases)
    mergeOpen.value = false
    mergeWithId.value = null
    notice.value = `已把 ${formatCount(payload.sourceIds.length)} 个角色并入「${characters.nameOf(payload.targetId)}」，台词归属同步迁移。`
    await canvas.reload({ force: true })
  } finally {
    mergeLoading.value = false
  }
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────
let unsubscribeProgress: (() => void) | null = null

onMounted(async () => {
  void settings.load()
  canvas.setProjectId(projectId.value)
  characters.setBookId(bookId.value)
  characters.setProjectId(projectId.value)
  packages.setProjectId(projectId.value)
  await loadChapters()
  if (currentChapterId.value) await canvas.load(currentChapterId.value)
  await characters.load(bookId.value, projectId.value)
  unsubscribeProgress = canvas.subscribeGenerationProgress()
  keyboard.attach()
})

onBeforeUnmount(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = null
  keyboard.detach()
})

// 章节上下文变化（含深链 props.chapterId）时重新加载画本
watch(currentChapterId, async (id) => {
  if (id && id !== canvas.loadedChapterId) await canvas.load(id)
})
</script>

<template>
  <div class="ns-editor">
    <header class="ns-editor__bar">
      <span class="ns-editor__crumb">{{ session.breadcrumb || '未选择书籍' }}</span>
      <el-button size="small" type="primary" @click="showGenerateForm = true">生成画本</el-button>
      <el-button size="small" @click="exportText">导出本章文本</el-button>
      <el-button size="small" :disabled="readonly" @click="taskExportOpen = true">导出任务包</el-button>
      <el-button size="small" @click="taskImportOpen = true">导入 / 回收任务包</el-button>
      <span class="ns-editor__grow" />
      <el-button size="small" :disabled="!canvas.canUndo" @click="canvas.undo()">撤销 {{ canvas.undoLabel }}</el-button>
      <el-button size="small" :disabled="!canvas.canRedo" @click="canvas.redo()">重做</el-button>
      <el-button size="small" @click="toggleRightPanel()">{{ rightPanel === 'none' ? '展开侧栏' : '折叠侧栏' }}</el-button>
    </header>

    <p v-if="readonly" class="ns-editor__banner is-info">{{ readonlyReason }}</p>
    <p v-if="notice" class="ns-editor__banner is-notice">{{ notice }}<el-button size="small" text @click="notice = ''">知道了</el-button></p>

    <div class="ns-editor__body" :class="{ 'is-collapsed': rightPanel === 'none' }">
      <!-- 左栏：章节导航 -->
      <aside class="ns-editor__left">
        <header class="ns-editor__left-head">
          <span>章节（{{ formatCount(chapters.length) }}）</span>
          <el-button size="small" text @click="showGenerateForm = true">生成</el-button>
          <el-button size="small" text :loading="chaptersLoading" @click="loadChapters">刷新</el-button>
        </header>
        <LoadingBlock v-if="chaptersLoading && !chapters.length" text="正在读取章节…" :min-height="'120px'" />
        <EmptyState
          v-else-if="!chapters.length" size="small" icon="📄" title="这本书还没有章节"
          description="先到「导入向导」把正文导入并按规则切好章节，再回来生成画本。"
        />
        <ul v-else class="ns-editor__chapters">
          <li
            v-for="row in chapters" :key="row.id" class="ns-editor__chapter"
            :class="{ 'is-active': row.id === canvas.chapterId }" @click="openChapter(row)"
          >
            <div class="ns-editor__chapter-top">
              <span class="ns-editor__seq">{{ row.seq }}</span>
              <span class="ns-editor__chapter-title" :title="row.title">{{ row.title }}</span>
              <el-tag v-if="row.progress?.reviewCount" size="small" type="warning">待确认 {{ formatCount(row.progress.reviewCount) }}</el-tag>
            </div>
            <div class="ns-editor__chapter-meta">
              <span>{{ formatInt(row.lineCount) }} 行</span>
              <span>{{ CANVAS_STATE_LABELS[row.canvasState] }}</span>
              <span v-if="row.progress?.lineCount">已录 {{ formatPercent((row.progress.recordedCount ?? 0) / row.progress.lineCount) }}</span>
            </div>
            <div class="ns-editor__chapter-bar"><i :style="{ width: row.progress?.lineCount ? formatPercent((row.progress.recordedCount ?? 0) / row.progress.lineCount) : '0%' }" /></div>
          </li>
        </ul>
      </aside>

      <!-- 中栏：画本区 -->
      <main class="ns-editor__center">
        <header class="ns-editor__tools">
          <el-radio-group :model-value="canvas.activeView" size="small" @update:model-value="onActiveViewInput">
            <el-radio-button value="table">表格</el-radio-button>
            <el-radio-button value="script">剧本</el-radio-button>
            <el-radio-button value="review">待确认（{{ formatCount(canvas.reviewCount) }}）</el-radio-button>
          </el-radio-group>
          <el-button size="small" @click="canvas.setDensity(canvas.density === 'compact' ? 'standard' : 'compact')">{{ canvas.density === 'compact' ? '标准密度' : '紧凑密度' }}</el-button>
          <span class="ns-editor__muted">筛选</span>
          <el-select :model-value="filterState.speaker" size="small" class="ns-editor__filter" @update:model-value="onSpeakerFilterInput">
            <el-option :value="SPEAKER_ANY" label="全部说话人" />
            <el-option :value="SPEAKER_UNKNOWN" label="未分配（台词无角色）" />
            <el-option :value="SPEAKER_NARRATION" label="旁白" />
            <el-option v-for="character in characters.activeCharacters" :key="character.id" :value="character.id" :label="character.name" />
          </el-select>
          <el-select
            :model-value="filterState.kind" size="small" clearable class="ns-editor__filter is-narrow" placeholder="类型"
            @update:model-value="onKindFilterInput"
          >
            <el-option v-for="item in canvasFilter.kindOptions" :key="item.value" :value="item.value" :label="item.label" />
          </el-select>
          <el-checkbox :model-value="filterState.needsReview === true" size="small" @update:model-value="onNeedsReviewFilterInput">仅待确认</el-checkbox>
          <el-input
            :model-value="filterState.keyword" size="small" clearable class="ns-editor__filter is-wide" placeholder="文本关键字"
            @update:model-value="onKeywordFilterInput"
          />
          <el-button size="small" text :disabled="!filterActive" @click="canvasFilter.reset()">重置筛选</el-button>
          <span class="ns-editor__grow" />
          <span class="ns-editor__muted">显示 {{ formatCount(filterCounts.shown) }} / {{ formatCount(filterCounts.total) }} 行</span>
        </header>

        <p v-if="canvas.loadError" class="ns-editor__banner is-error">
          这一章的画本没能加载出来：可在左栏换一章再切回来重试；其它章节的改动仍在内存中。
        </p>
        <LoadingBlock v-if="canvas.loading" text="正在加载画本…" />

        <!-- 未生成（或主动打开生成面板）：空态 + 生成参数 + 进度卡 + 生成报告 -->
        <div v-else-if="!canvas.lines.length || showGenerateForm" class="ns-editor__generate">
          <EmptyState
            v-if="!canvas.lines.length" size="small" icon="🎬" title="这一章还没有画本"
            description="生成画本会切句、剥离引号、判定说话人并按标点推断停顿——它是后续录音、对轨、混音的唯一主轴。"
            hint="首次生成建议开启「语义判定」；模型缺失时会自动降级为规则判定，并在报告里明确告知。"
          />
          <section class="ns-editor__form">
            <h4 class="ns-editor__form-title">生成参数</h4>
            <div class="ns-editor__form-row">
              <el-checkbox v-model="generateOptions.useEmbedding">启用语义判定（向量）</el-checkbox>
              <el-checkbox v-model="generateOptions.useLlm">AI 复核存疑行（较慢）</el-checkbox>
              <el-checkbox v-model="generateOptions.inferTags">自动标注情绪与语速</el-checkbox>
              <el-checkbox v-model="generateOptions.overwriteHuman">覆盖人工确认过的行（默认永不覆盖）</el-checkbox>
            </div>
            <div class="ns-editor__form-row">
              <span class="ns-editor__label">上下文窗口</span>
              <el-input-number v-model="generateOptions.contextWindow" size="small" :min="0" :max="10" controls-position="right" class="ns-editor__number" />
              <span class="ns-editor__label">判定阈值</span>
              <el-input-number v-model="generateOptions.threshold" size="small" :min="0" :max="1" :step="0.01" :precision="2" controls-position="right" class="ns-editor__number" />
              <span class="ns-editor__label">Top1-Top2 差值</span>
              <el-input-number v-model="generateOptions.margin" size="small" :min="0" :max="1" :step="0.01" :precision="2" controls-position="right" class="ns-editor__number" />
              <span class="ns-editor__label">章节规则集</span>
              <el-select v-model="generateOptions.ruleSetId" size="small" clearable placeholder="按内置规则" class="ns-editor__filter">
                <el-option v-for="ruleSet in BUILTIN_RULE_SETS" :key="ruleSet.id" :value="ruleSet.id" :label="ruleSet.name" />
              </el-select>
            </div>
            <div class="ns-editor__form-row">
              <el-button type="primary" size="small" :disabled="readonly" @click="askGenerate">开始生成</el-button>
              <el-button v-if="canvas.lines.length" size="small" @click="showGenerateForm = false">返回画本</el-button>
              <span v-if="humanCount" class="ns-editor__muted">本章已有 {{ formatCount(humanCount) }} 行人工确认，重算不会覆盖它们。</span>
              <span class="ns-editor__muted">{{ settings.embeddingReady ? '语义模型已就绪' : '语义模型未就绪，将降级为规则判定' }}</span>
            </div>
            <TaskProgressCard v-if="canvas.generateTaskId" :task-id="canvas.generateTaskId" title="生成画本" kind="canvas.generate" />
            <p v-if="canvas.generateProgress" class="ns-editor__muted">
              阶段：{{ canvas.generateProgress.stage }}（{{ formatInt(canvas.generateProgress.processed) }} / {{ formatInt(canvas.generateProgress.total) }}）
            </p>
          </section>

          <section v-if="report" class="ns-editor__report">
            <h4 class="ns-editor__form-title">生成报告</h4>
            <p v-if="!report.embeddingUsed" class="ns-editor__banner is-warn">
              <strong>已降级为规则判定</strong>：本次没有启用向量判定（模型未找到或校验失败），说话人归属只按规则与上下文推断，
              准确率明显低于语义判定。可在设置里检查模型文件，然后对低置信行重算。
            </p>
            <ul class="ns-editor__report-stats">
              <li>总行数：<strong>{{ formatInt(report.totalLines) }}</strong></li><li>待确认：{{ formatCount(report.lowConfidence) }}</li>
              <li>引号未配对：{{ formatCount(report.unmatchedQuote) }}</li><li>过长行：{{ formatCount(report.tooLong) }}</li>
              <li>耗时：{{ formatDurationLong(report.elapsedMs) }}</li>
              <li>语义判定：{{ report.embeddingUsed ? '已启用' : '未启用（规则判定）' }}</li><li>AI 复核：{{ report.llmUsed ? '已启用' : '未启用' }}</li>
            </ul>
            <div class="ns-editor__report-grid">
              <ul class="ns-editor__report-list"><li v-for="row in byKindRows" :key="row.kind">{{ row.label }}：{{ formatCount(row.count) }}</li></ul>
              <ul class="ns-editor__report-list"><li v-for="row in byDecisionRows" :key="row.key">{{ row.label }}：{{ formatCount(row.count) }}</li></ul>
              <ul class="ns-editor__report-list">
                <li v-for="row in report.bySpeaker.slice(0, 8)" :key="row.characterId ?? row.name">
                  {{ row.name || '旁白' }}：{{ formatCount(row.lines) }} 行 / {{ formatCount(row.chars) }} 字
                </li>
              </ul>
            </div>
            <ul v-if="report.warnings.length" class="ns-editor__report-list">
              <li v-for="(warning, index) in report.warnings" :key="index">{{ warning }}</li>
            </ul>
          </section>
        </div>

        <!-- 画本三视图：共享选中行与滚动位置（切换视图保持位置） -->
        <template v-else>
          <CanvasTable
            v-if="canvas.activeView === 'table'" :lines="filteredLines" :readonly="readonly" :density="canvas.density"
            :active-line-id="canvas.activeLineId" :issue-line-ids="canvas.issueLineIds"
            :initial-scroll-top="canvas.scrollTopOf('table')" :initial-top-index="canvas.topIndexOf('table')"
            @scroll="onScroll" @open="canvas.openDrawer" @locate="focusLine" @changed="onLineChanged"
          />
          <CanvasScriptView
            v-else-if="canvas.activeView === 'script'" :lines="filteredLines" :readonly="readonly" :density="canvas.density"
            :active-line-id="canvas.activeLineId" :issue-line-ids="canvas.issueLineIds"
            :initial-scroll-top="canvas.scrollTopOf('script')" :initial-top-index="canvas.topIndexOf('script')"
            @scroll="onScroll" @open="canvas.openDrawer" @locate="focusLine" @changed="onLineChanged"
          />
          <ReviewQueue
            v-else :active="true" :readonly="readonly" @open="canvas.openDrawer" @locate="focusLine"
            @changed="onLineChanged" @back-to-table="canvas.setActiveView('table')"
          />
        </template>

        <!-- 快速属性编辑：只选中一行时不必开抽屉（复用表格里的四个单元格组件） -->
        <div v-if="activeLine && canvas.selectedCount === 1" class="ns-editor__quick">
          <span class="ns-editor__muted">#{{ activeLine.seq }}</span>
          <SpeakerCell :line="activeLine" :readonly="readonly" :threshold="canvas.threshold" @change="onLineChanged" @open="canvas.openDrawer" @locate="focusLine" />
          <EmotionTagPicker
            :emotion="activeLine.emotion" :intensity="activeLine.emotionIntensity" :readonly="readonly"
            @change="(patch) => patchActiveLine(patch, '修改情绪')"
          />
          <PauseControl
            :pause-after-ms="activeLine.pauseAfterMs" :pause-inline="activeLine.pauseInline" :text="activeLine.text" :readonly="readonly"
            @change="(value) => patchActiveLine({ pauseAfterMs: value }, '修改停顿')"
          />
          <PronunciationEditor
            :text="activeLine.text" :pronunciation="activeLine.pronunciation" :readonly="readonly"
            @change="(value) => patchActiveLine({ pronunciation: value }, '修改发音提示')"
          />
          <span class="ns-editor__grow" />
          <el-select v-model="mergeWithId" size="small" clearable filterable placeholder="与该角色合并…" class="ns-editor__filter">
            <el-option v-for="character in mergeCandidates" :key="character.id" :value="character.id" :label="character.name" />
          </el-select>
          <el-button size="small" :disabled="readonly || !mergePreview" @click="mergeOpen = true">合并角色…</el-button>
        </div>

        <BatchActionBar
          v-if="showBatchBar" :targets="batchTargets" :selected-count="canvas.selectedCount"
          :filter-summary="filterSummary" :filter-active="filterActive" :readonly="readonly"
          @applied="(summary) => { notice = summary; onLineChanged() }" @clear-selection="canvas.clearSelection()"
        />

        <footer class="ns-editor__status">
          <span>总行数 {{ formatInt(canvas.statusSummary.total) }}</span><span>已选 {{ formatInt(canvas.selectedCount) }}</span>
          <span>待确认 {{ formatInt(canvas.statusSummary.review) }}</span><span>未分配 {{ formatInt(canvas.statusSummary.unassigned) }}</span>
          <span>已录 {{ formatInt(canvas.statusSummary.recorded) }}</span>
          <span :class="{ 'is-warn-text': canvas.statusSummary.issues > 0 }">质检 {{ formatInt(canvas.statusSummary.issues) }}</span>
          <span>撤销栈 {{ canvas.undoDepth }}/{{ canvas.undoCapacity }}</span>
          <span v-if="canvas.conflictLineIds.size" class="is-warn-text">有 {{ formatCount(canvas.conflictLineIds.size) }} 行被其它窗口改过，需重新加载</span>
          <span class="ns-editor__grow" />
          <AutoSaveIndicator :status="canvas.saveStatus" :saved-at="canvas.savedAt" :error-text="saveErrorText" compact @retry="forceSave" @revert="canvas.discardUnsaved()" />
        </footer>
      </main>

      <!-- 右栏：可折叠侧栏 -->
      <aside v-if="rightPanel !== 'none'" class="ns-editor__right">
        <header class="ns-editor__right-head">
          <el-radio-group :model-value="rightPanel" size="small" @update:model-value="onRightPanelInput">
            <el-radio-button value="source">原文对照</el-radio-button>
            <el-radio-button value="characters">角色表</el-radio-button>
            <el-radio-button value="quality">质检</el-radio-button>
          </el-radio-group>
          <el-button size="small" text @click="rightPanel = 'none'">折叠</el-button>
        </header>
        <SourceTextPane
          v-if="rightPanel === 'source'" :lines="canvas.lines" :active-line-id="canvas.activeLineId" :chapter-title="chapterTitle"
          @select="focusLine" @open="canvas.openDrawer" @toggle-collapse="rightPanel = 'none'"
        />
        <CharacterPanel
          v-else-if="rightPanel === 'characters'" :readonly="readonly" :chapter-id="canvas.chapterId" @changed="onLineChanged"
          @focus-character="(id) => { canvasFilter.set({ speaker: id }); canvas.setActiveView('table') }"
        />
        <QualityIssuesPanel
          v-else :active="true" :readonly="readonly" @focus-line="focusLine" @open="canvas.openDrawer" @close="rightPanel = 'none'" @changed="onLineChanged"
        />
      </aside>
    </div>

    <LineEditorDrawer v-model="drawerOpen" :line="activeLine" :readonly="readonly" :readonly-reason="readonlyReason" @changed="onLineChanged" @request-record="gotoRecording" @locate="focusLine" />
    <CharacterMergeDialog v-model="mergeOpen" :characters="mergeParticipants" :preview="mergePreview" :stats="characters.stats" :loading="mergeLoading" @confirm="onMergeConfirm" />
    <ConfirmDialog
      v-model="generateConfirmOpen" title="本章已有手工修改" type="warning" confirm-text="继续生成" @confirm="runGenerate"
      :message="`共 ${formatCount(humanCount)} 行由人工确认过。重新生成会保留这些行，只覆盖其余部分。`"
      :details="[
        `本次参数：判定阈值 ${generateOptions.threshold} · 差值 ${generateOptions.margin} · 上下文 ${generateOptions.contextWindow} 行`,
        generateOptions.useEmbedding ? '语义判定：已启用' : '语义判定：未启用（将降级为规则判定）',
        '生成前会自动打快照，必要时可回滚',
      ]"
    />
    <TaskPackageExportDialog v-model="taskExportOpen" :readonly="readonly" @exported="(path) => (notice = `任务包已导出：${path}`)" />
    <TaskPackageImportDialog v-model="taskImportOpen" :readonly="readonly" @merged="onMerged" @request-incremental-export="onIncrementalExport" />
  </div>
</template>

<style scoped>
.ns-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--ns-bg, #fff); } .ns-editor__bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--ns-border-light, #e4e7ed); background: var(--ns-bg-subtle, #fafafa); }
.ns-editor__crumb { max-width: 260px; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; } .ns-editor__grow { flex: 1; } .ns-editor__muted { color: var(--ns-text-secondary, #909399); font-size: 11px; }
.ns-editor__banner { margin: 0; padding: 6px 10px; font-size: 12px; line-height: 1.7; }
.ns-editor__banner.is-notice { background: rgb(64 158 255 / 10%); color: var(--ns-primary, #409eff); } .ns-editor__banner.is-info { background: var(--ns-fill-light, #f5f7fa); color: var(--ns-text-regular, #606266); }
.ns-editor__banner.is-error { background: rgb(245 108 108 / 12%); color: var(--ns-danger, #f56c6c); } .ns-editor__banner.is-warn { border-radius: 4px; background: rgb(230 162 60 / 14%); color: var(--ns-warning, #e6a23c); }
.ns-editor__body { display: grid; grid-template-columns: 244px minmax(0, 1fr) 340px; flex: 1; min-height: 0; } .ns-editor__body.is-collapsed { grid-template-columns: 244px minmax(0, 1fr); }
.ns-editor__left { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--ns-border-light, #e4e7ed); }
.ns-editor__left-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--ns-border-light, #e4e7ed); font-size: 12px; font-weight: 600; }
.ns-editor__chapters { flex: 1; min-height: 0; margin: 0; padding: 4px; overflow: auto; list-style: none; } .ns-editor__chapter { padding: 5px 6px; border-radius: 4px; cursor: pointer; } .ns-editor__chapter:hover { background: var(--ns-fill-light, #f5f7fa); }
.ns-editor__chapter.is-active { background: rgb(64 158 255 / 12%); box-shadow: inset 2px 0 0 var(--ns-primary, #409eff); }
.ns-editor__chapter-top { display: flex; align-items: center; gap: 4px; } .ns-editor__seq { flex: 0 0 22px; color: var(--ns-text-placeholder, #c0c4cc); font-size: 11px; text-align: right; } .ns-editor__chapter-title { flex: 1; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.ns-editor__chapter-meta { display: flex; gap: 8px; margin: 2px 0 3px 26px; color: var(--ns-text-secondary, #909399); font-size: 10px; } .ns-editor__chapter-bar { height: 3px; margin-left: 26px; border-radius: 2px; background: var(--ns-fill, #ebeef5); } .ns-editor__chapter-bar i { display: block; height: 100%; border-radius: 2px; background: var(--ns-success, #67c23a); }
.ns-editor__center { display: flex; flex-direction: column; min-width: 0; min-height: 0; } .ns-editor__tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 5px 8px; border-bottom: 1px solid var(--ns-border-light, #e4e7ed); }
.ns-editor__filter { width: 140px; } .ns-editor__filter.is-narrow { width: 96px; } .ns-editor__filter.is-wide { width: 150px; }
.ns-editor__generate { flex: 1; min-height: 0; padding: 10px; overflow: auto; } .ns-editor__form, .ns-editor__report { margin-top: 10px; padding: 10px; border: 1px solid var(--ns-border-light, #e4e7ed); border-radius: 6px; }
.ns-editor__form-title { margin: 0 0 6px; font-size: 12px; font-weight: 600; } .ns-editor__label { color: var(--ns-text-regular, #606266); font-size: 12px; } .ns-editor__number { width: 112px; }
.ns-editor__form-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ns-editor__report-stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0; padding: 0; list-style: none; color: var(--ns-text-regular, #606266); font-size: 12px; } .ns-editor__report-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; } .ns-editor__report-list { margin: 0; padding-left: 16px; color: var(--ns-text-regular, #606266); font-size: 11px; line-height: 1.8; }
.ns-editor__quick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 5px 8px; border-top: 1px solid var(--ns-border-light, #e4e7ed); background: var(--ns-bg-subtle, #fafafa); }
.ns-editor__status { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 4px 10px; border-top: 1px solid var(--ns-border-light, #e4e7ed); color: var(--ns-text-secondary, #909399); font-size: 11px; } .ns-editor__status .is-warn-text { color: var(--ns-warning, #e6a23c); }
.ns-editor__right { display: flex; flex-direction: column; min-height: 0; } .ns-editor__right-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-bottom: 1px solid var(--ns-border-light, #e4e7ed); }
</style>
