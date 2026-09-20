<!--
  书籍导入域 · 章节管理（docs/10 §7.2 导入完成后 / ChapterListView）
  ============================================================================
  设计依据：
    · docs/10 §7.2 —— 每章显示：序号、标题、字数、预估时长、画本状态、录音完成度；
      书籍信息条显示：总章数、总字数、总预估时长、已完成录音时长、配音员分工概览
    · docs/10 §7.2 —— 提供「批量生成画本」（跳 docs/11）与「开始录音」（跳 docs/12）
    · docs/10 §7.1 —— 重命名 / 改类型 / 改卷名 / 上移下移或拖拽（chapter:reorder）/
      合并拆分（ChapterMergeDialog）/ 删除（ConfirmDialog）
    · docs/00 非功能指标 —— 长列表虚拟滚动：用 shared/lib/virtual-list.ts 手写，
      一本 3000 章的书不能把 DOM 撑爆
    · docs/04 §2.4 —— 生成画本等长任务统一用 TaskProgressCard（一任务一卡）
    · docs/22 §6.2 —— 本视图不弹提示、不自拼错误文案：失败统一由 error-bus 兑现
                      （store 里的 call() 已经这么做了，视图只负责「回滚可见」）

  职责边界：
    · 数据与写库：stores/chapters.store.ts（乐观更新 + 失败回滚 + 重取列表）；
    · 多选：composables/useChapterSelection.ts（范围选 / 反选 / 剪枝）；
    · 本文件：布局、虚拟滚动、把事件接上去。
-->

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ActorWorkload, ChapterCanvasState, ChapterKind } from '@shared/types.ts'
import { formatCount, formatDate, formatDuration, formatDurationLong, formatInt, formatProgressRatio } from '@/shared/lib/format.ts'
import { computeVisibleRange } from '@/shared/lib/virtual-list.ts'
import { chapterTitleOrPlaceholder } from '@/shared/lib/book-scope.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useTasksStore } from '@/app/store/tasks.store.ts'
import ChapterMergeDialog from '@/features/book/components/ChapterMergeDialog.vue'
import { useChapterSelection } from '@/features/book/composables/useChapterSelection.ts'
import {
  CANVAS_STATE_LABELS,
  CANVAS_STATE_TYPES,
  CHAPTER_KIND_OPTIONS,
  useChaptersStore,
  type ChapterRow,
} from '@/features/book/stores/chapters.store.ts'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const chapters = useChaptersStore()
const tasks = useTasksStore()

/** 虚拟滚动：等高行（标题过长用省略号，避免行高不一致导致错位） */
const ROW_HEIGHT = 46

// ── 加载 ───────────────────────────────────────────────────────────────────

onMounted(async () => {
  if (!session.bookId) return
  chapters.setKeyword(typeof route.query.q === 'string' ? route.query.q : '')
  await chapters.load(session.bookId)
})

/** 顶栏搜索（TopBar 会把关键词带在 ?q= 上） */
watch(() => route.query.q, (value) => {
  chapters.setKeyword(typeof value === 'string' ? value : '')
})

// ── 选择（多选/范围选/反选）────────────────────────────────────────────────

const selection = useChapterSelection(() => chapters.visibleRows.map(row => row.id))

/** 可见行 id 变化后剪掉失效的选择（过滤/重排/删除后必须做） */
watch(() => chapters.visibleRows.map(row => row.id).join(','), () => {
  selection.prune(chapters.visibleRows.map(row => row.id))
})

function onRowClick(index: number, event: MouseEvent): void {
  selection.click(index, { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey })
}

// ── 虚拟滚动 ───────────────────────────────────────────────────────────────

const scrollEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)

const range = computed(() => computeVisibleRange({
  scrollTop: scrollTop.value,
  viewportHeight: viewportHeight.value,
  rowHeight: ROW_HEIGHT,
  total: chapters.visibleRows.length,
  overscan: 6,
}))

const windowRows = computed(() => {
  const { startIndex, endIndex } = range.value
  if (endIndex < startIndex) return []
  return chapters.visibleRows.slice(startIndex, endIndex + 1).map((row, i) => ({ row, index: startIndex + i }))
})

function onScroll(): void {
  scrollTop.value = scrollEl.value?.scrollTop ?? 0
}

function measure(): void {
  viewportHeight.value = scrollEl.value?.clientHeight ?? 0
}

onMounted(() => {
  measure()
  globalThis.addEventListener?.('resize', measure)
})

/**
 * 行数变化后重新量视口高度：初次挂载时表格还没渲染（正在 loading），
 * 不补量的话虚拟滚动会退化成一行的窄窗口。
 */
watch(() => chapters.rows.length, async () => {
  await nextTick()
  measure()
})

// ── 行内编辑（标题 / 卷名）─────────────────────────────────────────────────

const editingTitleId = ref<string | null>(null)
const titleDraft = ref('')
const editingVolumeId = ref<string | null>(null)
const volumeDraft = ref('')

function startEditTitle(row: ChapterRow): void {
  editingTitleId.value = row.id
  titleDraft.value = row.title
}

async function commitTitle(row: ChapterRow): Promise<void> {
  const next = titleDraft.value.trim()
  editingTitleId.value = null
  if (!next || next === row.title) return
  const updated = await chapters.rename(row.id, next)
  if (!updated) rollback(`把「${row.title}」改名为「${next}」`)
}

function startEditVolume(row: ChapterRow): void {
  editingVolumeId.value = row.id
  volumeDraft.value = row.volumeTitle ?? ''
}

async function commitVolume(row: ChapterRow): Promise<void> {
  const next = volumeDraft.value.trim()
  editingVolumeId.value = null
  if (next === (row.volumeTitle ?? '')) return
  const updated = await chapters.setVolumeTitle(row.id, next)
  if (!updated) rollback(`修改「${row.title}」的卷名`)
}

// ── 回滚可见提示（状态提示，不是错误文案，原因由 error-bus 呈现）───────────

const rollbackNotice = ref<{ action: string; retry: () => void } | null>(null)

function rollback(action: string, retry: () => void = () => { void chapters.reload() }): void {
  rollbackNotice.value = { action, retry }
}

// ── 关键字提示与过滤 ───────────────────────────────────────────────────────

const filtering = computed(() => chapters.keyword.trim().length > 0)

// ── 上移 / 下移 / 拖拽（chapter:reorder）──────────────────────────────────

async function onMoveBy(row: ChapterRow, delta: number): Promise<void> {
  const ok = await chapters.moveBy(row.id, delta)
  if (!ok) rollback(`移动「${row.title}」`)
}

const dragIndex = ref<number | null>(null)

function onDragStart(index: number, event: DragEvent): void {
  if (filtering.value) {
    event.preventDefault()
    return
  }
  dragIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

async function onDropOn(targetIndex: number, event: DragEvent): Promise<void> {
  event.preventDefault()
  const from = dragIndex.value
  dragIndex.value = null
  if (from === null || from === targetIndex) return
  // reorder 要求给出**全部**章节的顺序（store 会校验长度），因此这里以 rows 为基准
  const ids = chapters.rows.map(row => row.id)
  const [moved] = ids.splice(from, 1)
  if (!moved) return
  ids.splice(targetIndex, 0, moved)
  const ok = await chapters.reorder(ids)
  if (!ok) rollback('调整章节顺序')
}

// ── 合并 / 拆分 ────────────────────────────────────────────────────────────

const mergeDialog = ref<{ mode: 'merge' | 'split'; ids: string[] } | null>(null)

const mergeItems = computed(() => {
  const target = mergeDialog.value
  if (!target) return []
  return chapters.rows
    .filter(row => target.ids.includes(row.id))
    .map(row => ({ id: row.id, title: row.title, charCount: row.charCount }))
})

function openMergeDialog(): void {
  const ids = selection.selectedIds.value
  if (ids.length < 2) return
  mergeDialog.value = { mode: 'merge', ids }
}

function openSplitDialog(row: ChapterRow): void {
  mergeDialog.value = { mode: 'split', ids: [row.id] }
}

function onMergeDialogVisible(visible: boolean): void {
  if (!visible) mergeDialog.value = null
}

async function onMergeDialogConfirm(payload:
  | { mode: 'merge'; ids: string[]; title: string }
  | { mode: 'split'; id: string; offsets: number[] }): Promise<void> {
  mergeDialog.value = null
  if (payload.mode === 'merge') {
    const merged = await chapters.merge(payload.ids, payload.title)
    if (!merged) {
      rollback(`合并 ${formatInt(payload.ids.length)} 章`, () => { void onMergeDialogConfirm(payload) })
      return
    }
    selection.reset()
    return
  }
  const created = await chapters.split(payload.id, payload.offsets)
  if (!created) rollback('拆分章节', () => { void onMergeDialogConfirm(payload) })
}

// ── 删除（ConfirmDialog，破坏性操作）──────────────────────────────────────

const pendingDeleteIds = ref<string[] | null>(null)

const deleteVisible = computed({
  get: () => pendingDeleteIds.value !== null,
  set: (value: boolean) => { if (!value) pendingDeleteIds.value = null },
})

const deleteTargets = computed(() => (pendingDeleteIds.value ?? [])
  .map(id => chapters.getById(id))
  .filter((row): row is ChapterRow => !!row))

const deleteDetails = computed<string[]>(() => deleteTargets.value.map(row => (
  `#${formatInt(row.seq)} ${row.title} · ${formatInt(row.charCount)} 字 · 画本状态「${CANVAS_STATE_LABELS[row.canvasState]}」· 已录 ${formatInt(row.progress?.recordedCount ?? 0)}/${formatInt(row.lineCount)} 行`
)))

function askDelete(ids: string[]): void {
  if (!ids.length) return
  pendingDeleteIds.value = ids
}

async function confirmDelete(): Promise<void> {
  const ids = pendingDeleteIds.value ?? []
  pendingDeleteIds.value = null
  const failed: string[] = []
  for (const id of ids) {
    const ok = await chapters.remove(id)
    if (!ok) failed.push(id)
  }
  if (failed.length) {
    rollback(`删除 ${formatInt(failed.length)} 章`, () => { askDelete(failed) })
    return
  }
  selection.reset()
}

// ── 生成画本（canvas:generate + TaskProgressCard）─────────────────────────

const generating = ref(false)

async function onGenerateCanvas(ids: string[]): Promise<void> {
  if (!ids.length || generating.value) return
  generating.value = true
  try {
    const result = await chapters.generateCanvas(ids, chapters.defaultGenerateOptions())
    if (result.failed.length) {
      rollback(`为 ${formatInt(result.failed.length)} 章提交生成任务`, () => { void onGenerateCanvas(result.failed) })
    }
  } finally {
    generating.value = false
  }
}

/**
 * 画本任务面板（真机反馈：docs/91 §5.2.35）。
 *
 * 过滤规则在 store 的 `currentBookCanvasTasks`（→ 纯函数 `visibleCanvasTasks`）里：
 * 只显示**当前这本书**、且章节仍然存在的任务，最多 6 条 —— 上一本书的
 * 「生成画本」提示不会出现在本书。
 */
const canvasTaskEntries = computed(() => chapters.currentBookCanvasTasks)

/** 面板标题里的章节名：找不到就给「未知章节」，**绝不把 uuid 显示给用户** */
function chapterTitleOf(chapterId: string): string {
  return chapterTitleOrPlaceholder(chapters.getById(chapterId)?.title)
}

/** 重试：先清掉旧任务登记，再用同一章的选项重新提交（canvas:generate 的载荷是单章） */
async function retryCanvas(chapterId: string): Promise<void> {
  chapters.clearCanvasTask(chapterId)
  await chapters.generateCanvas([chapterId], chapters.defaultGenerateOptions())
}

// ── 配音员分工（voiceActor:workload）──────────────────────────────────────

const workloadOpen = ref(false)

async function openWorkload(): Promise<void> {
  workloadOpen.value = true
  await chapters.loadWorkload()
}

const workloadRows = computed<ActorWorkload[]>(() => chapters.workloads)

// ── 跳转（选中当前章后去录音 / 对轨 / 导出 / 画本）────────────────────────

async function jumpTo(row: ChapterRow, path: string): Promise<void> {
  session.selectChapter(row)
  await router.push({ path })
}

// ── 表内下拉/搜索处理器（不在模板里写 as 断言）────────────────────────────

function onKeywordInput(event: Event): void {
  chapters.setKeyword((event.target as HTMLInputElement).value)
}

function onKindChange(row: ChapterRow, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  const allowed: ChapterKind[] = ['chapter', 'front', 'back', 'extra', 'volume']
  if (!allowed.includes(value as ChapterKind)) return
  void chapters.setKind(row.id, value as ChapterKind)
}

// ── 展示辅助 ───────────────────────────────────────────────────────────────

function canvasTagType(state: ChapterCanvasState): string {
  return `cl__tag--${CANVAS_STATE_TYPES[state]}`
}

function progressText(row: ChapterRow): string {
  const progress = row.progress
  if (!progress) return '未开始'
  return `${formatProgressRatio(progress.recordedCount, progress.lineCount)} · 已录 ${formatDuration(progress.audioMs)}`
}

const bookTitle = computed(() => session.book?.title ?? '未选择书籍')
</script>

<template>
  <section class="cl">
    <!-- 无书：引导回书架（路由守卫也会拦，但直接进来的情况要自己兜住） -->
    <EmptyState
      v-if="!session.hasBook"
      title="还没有选中书籍"
      description="章节管理需要先确定「在哪本书上操作」：去书架选一本书，或先导入一本。"
      icon="📚"
      action-text="去书架"
      @action="router.push({ path: '/bookshelf' })"
    />

    <template v-else>
      <!-- 顶部书籍信息条（docs/10 §7.2） -->
      <header class="cl__bar">
        <div class="cl__bar-main">
          <h2 class="cl__title">{{ bookTitle }}</h2>
          <p class="cl__stats">
            {{ formatInt(chapters.stats.count) }} 章 ·
            {{ formatCount(chapters.stats.chars) }}字 ·
            预估 {{ formatDurationLong(chapters.stats.estimatedDurationMs) }} ·
            已录音 {{ formatDuration(chapters.stats.recordedMs) }} ·
            画本已完成 {{ formatInt(chapters.stats.canvasDone) }} 章（未生成 {{ formatInt(chapters.stats.canvasNone) }} 章）
          </p>
        </div>
        <div class="cl__bar-ops">
          <button type="button" class="ns-btn" :disabled="chapters.loading" @click="chapters.reload()">刷新</button>
          <button type="button" class="ns-btn" @click="openWorkload">配音员分工</button>
          <button type="button" class="ns-btn" @click="chapters.loadWorkload()">刷新分工</button>
          <button type="button" class="ns-btn ns-btn--primary" @click="router.push({ path: '/import' })">导入新书</button>
        </div>
      </header>

      <!-- 工具条：搜索 / 多选 / 批量操作 -->
      <div class="cl__toolbar">
        <label class="cl__search">
          <span aria-hidden="true">🔍</span>
          <input
            class="cl__input"
            type="search"
            placeholder="搜索章节标题或卷名"
            :value="chapters.keyword"
            @input="onKeywordInput"
          >
        </label>
        <span class="cl__sel-info">已选 {{ formatInt(selection.selectedCount.value) }} 章</span>
        <button type="button" class="ns-btn ns-btn--small" @click="selection.selectAll()">全选</button>
        <button type="button" class="ns-btn ns-btn--small" @click="selection.invert()">反选</button>
        <button type="button" class="ns-btn ns-btn--small" :disabled="!selection.hasSelected.value" @click="selection.clear()">
          清空选择
        </button>
        <span class="cl__divider" />
        <button
          type="button"
          class="ns-btn ns-btn--small"
          :disabled="!selection.hasSelected.value || generating"
          @click="onGenerateCanvas(selection.selectedIds.value)"
        >
          批量生成画本
        </button>
        <button
          type="button"
          class="ns-btn ns-btn--small"
          :disabled="!selection.canMerge.value"
          :title="selection.canMerge.value ? '合并选中的相邻章节' : '至少选两章才能合并'"
          @click="openMergeDialog"
        >
          合并
        </button>
        <button
          type="button"
          class="ns-btn ns-btn--small ns-btn--danger"
          :disabled="!selection.hasSelected.value"
          @click="askDelete(selection.selectedIds.value)"
        >
          批量删除
        </button>
      </div>

      <p v-if="rollbackNotice" class="cl__notice" role="status">
        <span>{{ rollbackNotice.action }}未生效 —— 列表已还原。</span>
        <button type="button" class="ns-btn ns-btn--small" @click="rollbackNotice.retry()">重试</button>
        <button type="button" class="ns-btn ns-btn--small" @click="rollbackNotice = null">知道了</button>
      </p>

      <p v-if="filtering" class="cl__hint">
        正在按「{{ chapters.keyword }}」过滤：显示的 {{ formatInt(chapters.visibleRows.length) }} /
        {{ formatInt(chapters.rows.length) }} 章。过滤状态下不提供拖拽排序（顺序含义不明确），请先清空搜索。
      </p>

      <!-- 画本任务进度（每个任务一张统一进度卡，docs/04 §2.4） -->
      <div v-if="canvasTaskEntries.length" class="cl__tasks">
        <TaskProgressCard
          v-for="task in canvasTaskEntries"
          :key="task.taskId"
          :task-id="task.taskId"
          :title="`生成画本：${chapterTitleOf(task.chapterId)}`"
          kind="canvas.generate"
          size="compact"
          cancelable
          retryable
          closable
          openable
          @cancel="tasks.cancel"
          @retry="retryCanvas(task.chapterId)"
          @close="chapters.clearCanvasTask(task.chapterId)"
          @open="router.push({ path: '/tasks' })"
        />
      </div>

      <LoadingBlock v-if="chapters.loading && !chapters.rows.length" variant="skeleton" :rows="8" text="正在读取章节…" />

      <!-- 有书无章：两种引导（导入新书 / 回导入向导补分章规则） -->
      <EmptyState
        v-else-if="!chapters.rows.length"
        title="这本书还没有章节"
        description="导入时可能没有匹配到分章规则，或章节被全部删除了。回到导入向导调整分章规则（或选一种备选策略）即可补上。"
        icon="📄"
        hint="也可以直接导入另一本书；本书的正文若还在，重新导入后选择「打开已有书籍」可以避免重复。"
        action-text="回导入向导"
        @action="router.push({ path: '/import' })"
      />

      <EmptyState
        v-else-if="!chapters.visibleRows.length"
        title="没有匹配的章节"
        description="换一个关键词，或清空搜索条件看全部章节。"
        icon="🔍"
        size="small"
        action-text="清空搜索"
        @action="chapters.setKeyword('')"
      />

      <!-- 章节表（虚拟滚动） -->
      <div v-else class="cl__table">
        <div class="cl__thead">
          <span class="cl__col-check" />
          <span class="cl__col-seq">#</span>
          <span class="cl__col-title">标题</span>
          <span class="cl__col-kind">类型</span>
          <span class="cl__col-volume">卷</span>
          <span class="cl__col-num">字数</span>
          <span class="cl__col-num">预估时长</span>
          <span class="cl__col-canvas">画本状态</span>
          <span class="cl__col-progress">录音完成度</span>
          <span class="cl__col-ops">操作</span>
        </div>

        <div ref="scrollEl" class="cl__scroll" @scroll="onScroll">
          <div :style="{ height: `${range.paddingTop}px` }" />
          <div
            v-for="item in windowRows"
            :key="item.row.id"
            class="cl__row"
            :class="{ 'cl__row--on': selection.isSelected(item.row.id), 'cl__row--busy': chapters.isBusy(item.row.id) }"
            :style="{ height: `${ROW_HEIGHT}px` }"
            draggable="true"
            @click="onRowClick(item.index, $event)"
            @dragstart="onDragStart(item.index, $event)"
            @dragover.prevent
            @drop="onDropOn(item.index, $event)"
          >
            <span class="cl__col-check">
              <input
                type="checkbox"
                :checked="selection.isSelected(item.row.id)"
                :title="'选中这一章（Shift 可连选）'"
                @click.stop="selection.toggle(item.row.id)"
              >
            </span>
            <span class="cl__col-seq">{{ formatInt(item.row.seq) }}</span>

            <span class="cl__col-title">
              <input
                v-if="editingTitleId === item.row.id"
                v-model="titleDraft"
                class="cl__input cl__input--title"
                type="text"
                @click.stop
                @keydown.enter.prevent="commitTitle(item.row)"
                @keydown.esc.prevent="editingTitleId = null"
                @blur="commitTitle(item.row)"
              >
              <template v-else>
                <span class="cl__title-text" :title="item.row.title">{{ item.row.title }}</span>
                <button type="button" class="cl__link" @click.stop="startEditTitle(item.row)">改名</button>
              </template>
            </span>

            <span class="cl__col-kind">
              <select
                class="cl__select"
                :value="item.row.kind"
                @click.stop
                @change="onKindChange(item.row, $event)"
              >
                <option v-for="option in CHAPTER_KIND_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </span>

            <span class="cl__col-volume">
              <input
                v-if="editingVolumeId === item.row.id"
                v-model="volumeDraft"
                class="cl__input"
                type="text"
                placeholder="卷名"
                @click.stop
                @keydown.enter.prevent="commitVolume(item.row)"
                @keydown.esc.prevent="editingVolumeId = null"
                @blur="commitVolume(item.row)"
              >
              <button v-else type="button" class="cl__link" :title="item.row.volumeTitle ?? '未分卷'" @click.stop="startEditVolume(item.row)">
                {{ item.row.volumeTitle || '设置卷名' }}
              </button>
            </span>

            <span class="cl__col-num">{{ formatInt(item.row.charCount) }}</span>
            <span class="cl__col-num">{{ formatDuration(chapters.durationOf(item.row)) }}</span>

            <span class="cl__col-canvas">
              <span class="cl__tag" :class="canvasTagType(item.row.canvasState)">
                {{ CANVAS_STATE_LABELS[item.row.canvasState] }}
              </span>
              <span class="cl__muted">{{ formatInt(item.row.lineCount) }} 行</span>
            </span>

            <span class="cl__col-progress" :title="item.row.progress ? `未分配 ${formatInt(item.row.progress.unassignedCount)} 行 · 待复核 ${formatInt(item.row.progress.reviewCount)} 行` : '还没有录音进度数据'">
              {{ progressText(item.row) }}
            </span>

            <span class="cl__col-ops" @click.stop>
              <button type="button" class="cl__link" :disabled="item.index === 0" title="上移" @click="onMoveBy(item.row, -1)">↑</button>
              <button type="button" class="cl__link" :disabled="item.index === chapters.visibleRows.length - 1" title="下移" @click="onMoveBy(item.row, 1)">↓</button>
              <button type="button" class="cl__link" title="生成画本（canvas:generate）" @click="onGenerateCanvas([item.row.id])">画本</button>
              <button type="button" class="cl__link" title="去录音" @click="jumpTo(item.row, '/recording')">录音</button>
              <button type="button" class="cl__link" title="去对轨" @click="jumpTo(item.row, '/alignment')">对轨</button>
              <button type="button" class="cl__link" title="去导出（导出按书籍范围，进入后可选择章节）" @click="jumpTo(item.row, '/export')">导出</button>
              <button type="button" class="cl__link" title="拆分这一章" @click="openSplitDialog(item.row)">拆分</button>
              <button type="button" class="cl__link cl__link--danger" title="删除（需二次确认）" @click="askDelete([item.row.id])">删除</button>
            </span>
          </div>
          <div :style="{ height: `${range.paddingBottom}px` }" />
        </div>

        <p class="cl__virtual-hint">
          虚拟滚动：DOM 中只渲染 {{ formatInt(range.renderCount) }} / {{ formatInt(chapters.visibleRows.length) }} 行；
          拖动行可调整顺序（chapter:reorder 成功后序号由服务端权威重排）。
        </p>
      </div>

      <!-- 配音员分工概览（voiceActor:workload，docs/10 §7.2） -->
      <Teleport to="body">
        <div v-if="workloadOpen" class="cl-drawer" role="dialog" aria-modal="true">
          <div class="cl-drawer__mask" @click="workloadOpen = false" />
          <aside class="cl-drawer__panel">
            <header class="cl-drawer__head">
              <h3 class="cl-drawer__title">配音员分工</h3>
              <button type="button" class="ns-btn ns-btn--small" @click="workloadOpen = false">关闭</button>
            </header>
            <div class="cl-drawer__body">
              <LoadingBlock v-if="chapters.workloadLoading" text="正在统计分工…" />
              <table v-else-if="workloadRows.length" class="cl-drawer__table">
                <thead>
                  <tr>
                    <th>配音员</th>
                    <th>行数</th>
                    <th>字数</th>
                    <th>预估时长</th>
                    <th>已录行数</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="actor in workloadRows" :key="actor.actorId">
                    <td>{{ actor.name }}</td>
                    <td>{{ formatInt(actor.lines) }}</td>
                    <td>{{ formatCount(actor.chars) }}</td>
                    <td>{{ formatDuration(actor.estimatedDurationMs) }}</td>
                    <td>{{ formatInt(actor.recordedCount) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="cl__hint">
                还没有分工数据：先在画本编辑里把角色绑定到配音员（voiceActor:bind），这里就会显示每人多少行、多少字、已录多少。
              </p>
            </div>
          </aside>
        </div>
      </Teleport>

      <!-- 删除确认（破坏性操作：列出影响范围 + 要求确认） -->
      <ConfirmDialog
        v-model="deleteVisible"
        type="danger"
        :title="deleteTargets.length > 1 ? `删除 ${formatInt(deleteTargets.length)} 个章节？` : `删除「${deleteTargets[0]?.title ?? ''}」？`"
        message="删除后章节与它的画本行都会消失；已录制的音频片段会保留在音频目录（不会被本次操作删掉）。"
        :details="deleteDetails"
        confirm-text="确认删除"
        @confirm="confirmDelete"
      />

      <ChapterMergeDialog
        :model-value="mergeDialog !== null"
        :mode="mergeDialog?.mode ?? 'merge'"
        :items="mergeItems"
        @update:model-value="onMergeDialogVisible"
        @confirm="onMergeDialogConfirm"
        @cancel="mergeDialog = null"
      />

      <p class="cl__hint">
        书籍更新于 {{ formatDate(session.book?.updatedAt, 'YYYY-MM-DD HH:mm') }} ·
        章节类型与卷名会影响导出命名（docs/15 的 {chapterIndex:03} 模板）。
      </p>
    </template>
  </section>
</template>

<style scoped>
.cl {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 28px;
}
.cl__bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.cl__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 20px;
  font-weight: 600;
}
.cl__stats {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.cl__bar-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cl__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.cl__search {
  display: flex;
  flex: 1 1 200px;
  align-items: center;
  gap: 6px;
}
.cl__sel-info {
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.cl__divider {
  width: 1px;
  height: 18px;
  background: var(--ns-border, #dcdfe6);
}
.cl__input,
.cl__select {
  padding: 5px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.cl__input--title {
  width: 100%;
  border-color: var(--ns-primary, #409eff);
}
.cl__select {
  padding: 3px 4px;
  font-size: 12px;
}
.cl__notice {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--ns-warning, #e6a23c);
  border-radius: 6px;
  background: rgb(230 162 60 / 10%);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.cl__tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.cl__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.cl__table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  overflow: hidden;
}
.cl__thead,
.cl__row {
  display: grid;
  grid-template-columns: 40px 52px minmax(200px, 1.4fr) 84px 110px 80px 96px 110px 180px 250px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 13px;
}
.cl__thead {
  height: 34px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.cl__scroll {
  max-height: 56vh;
  min-height: 200px;
  overflow: auto;
}
.cl__row {
  border-top: 1px solid var(--ns-border-light, #e4e7ed);
  color: var(--ns-text-primary, #303133);
  cursor: default;
}
.cl__row--on {
  background: rgb(64 158 255 / 8%);
}
.cl__row--busy {
  opacity: 0.6;
  pointer-events: none;
}
.cl__col-seq,
.cl__col-num {
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.cl__col-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.cl__title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cl__col-canvas {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cl__tag {
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
}
.cl__tag--info {
  background: var(--ns-fill, #ebeef5);
  color: var(--ns-text-secondary, #909399);
}
.cl__tag--primary {
  background: rgb(64 158 255 / 14%);
  color: var(--ns-primary, #409eff);
}
.cl__tag--warning {
  background: rgb(230 162 60 / 16%);
  color: var(--ns-warning, #e6a23c);
}
.cl__tag--success {
  background: rgb(103 194 58 / 16%);
  color: var(--ns-success, #67c23a);
}
.cl__muted {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.cl__col-progress {
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cl__col-ops {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  justify-content: flex-end;
  overflow: hidden;
}
.cl__link {
  padding: 0 3px;
  border: 0;
  background: transparent;
  color: var(--ns-primary, #409eff);
  font-size: 12px;
  cursor: pointer;
}
.cl__link--danger {
  color: var(--ns-danger, #f56c6c);
}
.cl__link:disabled {
  color: var(--ns-text-placeholder, #c0c4cc);
  cursor: not-allowed;
}
.cl__virtual-hint {
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--ns-border-light, #e4e7ed);
  background: var(--ns-bg-subtle, #fafafa);
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.cl-drawer {
  position: fixed;
  inset: 0;
  z-index: 2600;
  display: flex;
  justify-content: flex-end;
}
.cl-drawer__mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 35%);
}
.cl-drawer__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(520px, 92vw);
  height: 100%;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: -6px 0 24px rgb(0 0 0 / 16%);
}
.cl-drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
}
.cl-drawer__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
}
.cl-drawer__body {
  flex: 1;
  overflow: auto;
  padding: 12px 16px 20px;
}
.cl-drawer__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.cl-drawer__table th,
.cl-drawer__table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  text-align: left;
}
.cl-drawer__table th {
  color: var(--ns-text-regular, #606266);
  font-weight: 500;
}
.ns-btn {
  padding: 6px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn--small {
  padding: 4px 10px;
  font-size: 12px;
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-btn--danger {
  border-color: var(--ns-danger, #f56c6c);
  color: var(--ns-danger, #f56c6c);
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
