<!--
  Novel Studio · 对轨主界面（docs/13 §4.5 布局 / §4.6 视图能力 / §6 试听预览 / §7 多方案）
  ============================================================================
  布局照 docs/13 §4.5 的 ASCII 图：
    工具条（章选择 / 方案 / 策略 / 留白 / 自动对轨 / 校验 / 预览渲染）
    → 刻度尺 + 轨道头列 + 时间线主画布（Canvas 自绘）+ MiniMap
    → 状态条（选中：时间线起止 | 源内起止 | locked + 锁定/吸附/网格/±10ms/重置/试听）
    右侧「Judge」区：Inspector（属性与操作）/ ValidationPanel / OverlapResolver

  职责边界（**刻意很薄**）：
    · 状态全在 store（arrangement / timeline / playback / validation）；
    · 绘制与交互全在 TimelineCanvas（内部 useTimelineRenderer + useTimelineInteraction）；
    · 播放：本视图创建唯一的 `usePlaybackScheduler`（AudioContext 必须在用户手势里 init）；
    · 本文件只做装配、编排与状态条文案，不算坐标、不拼错误文案。

  键盘（docs/13 §4.7 / §4.8）：`Space`/`←→`/`Ctrl+Z`/`Esc`/`F`/`+ -` 由画布的交互层处理；
  `Ctrl+S` 在本视图处理（把批量队列里的改动立即落库）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { ArrangementItem, ArrangeStrategy, Id, TrackId } from '@shared/types.ts'
import { ARRANGE_DEFAULTS, ARRANGE_STRATEGY_LABELS } from '@shared/constants.ts'
import { formatDuration, formatOffsetMs } from '@/shared/lib/format.ts'
import { isEditableTarget, matchEvent } from '@/shared/lib/shortcuts.ts'
import AutoSaveIndicator from '@/shared/ui/AutoSaveIndicator.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useChaptersStore } from '@/features/book/stores/chapters.store.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import ArrangementSelector from '../components/ArrangementSelector.vue'
import Inspector from '../components/Inspector.vue'
import MiniMap from '../components/MiniMap.vue'
import OverlapResolver from '../components/OverlapResolver.vue'
import PreviewRenderDialog from '../components/PreviewRenderDialog.vue'
import TimelineCanvas from '../components/TimelineCanvas.vue'
import TimelineRuler from '../components/TimelineRuler.vue'
import TrackHeader from '../components/TrackHeader.vue'
import ValidationPanel from '../components/ValidationPanel.vue'
import { usePlaybackScheduler } from '../composables/usePlaybackScheduler.ts'
import { useArrangementStore } from '../stores/arrangement.store.ts'
import { usePlaybackStore } from '../stores/playback.store.ts'
import { GRID_OPTIONS, useTimelineStore } from '../stores/timeline.store.ts'
import type { GridMs } from '../stores/timeline.store.ts'
import { useValidationStore } from '../stores/validation.store.ts'
import type { ValidationIssueRow } from '../stores/validation.store.ts'

const router = useRouter()
const session = useSessionStore()
const settings = useSettingsStore()
const chapters = useChaptersStore()
const arrangement = useArrangementStore()
const timeline = useTimelineStore()
const playback = usePlaybackStore()
const validation = useValidationStore()

// ── 本地展示态（不进 store） ────────────────────────────────────────────────
type JudgeTab = 'inspector' | 'validation' | 'overlaps'
const judgeTab = ref<JudgeTab>('inspector')
const previewVisible = ref(false)
const selectedTrackId = ref<TrackId | null>(null)
const interactionHint = ref('')
const hoverItemId = ref<Id | null>(null)
/** 自动对轨参数：策略与整章默认句间留白（docs/13 §4.4） */
const strategy = ref<ArrangeStrategy>('serialize')
const defaultPauseMs = ref<number>(ARRANGE_DEFAULTS.defaultPauseMs)
const arranging = ref(false)
const booting = ref(false)

const chapterId = computed<Id | null>(() => session.chapterId)

// ── 播放：全视图唯一的调度器 ────────────────────────────────────────────────
const scheduler = usePlaybackScheduler({
  projectId: () => session.projectId,
  totalDurationMs: () => arrangement.totalDurationMs,
  itemsByTrack: () => arrangement.itemsByTrack,
  resolveSource: item => arrangement.resolveSource(item, playback.useProcessed),
  loop: () => timeline.loop,
  getPlayheadMs: () => timeline.playheadMs,
  setPlayheadMs: (ms) => { timeline.setPlayhead(ms); playback.setCurrentMs(ms) },
  expectedSampleRate: () => settings.audio?.sampleRate ?? null,
})

async function togglePlay(): Promise<void> {
  if (playback.isPlaying) { scheduler.pause(); return }
  const ready = await scheduler.init()
  if (!ready) return
  await scheduler.play(timeline.playheadMs)
}

async function auditionItem(itemId: Id): Promise<void> {
  const item = arrangement.itemById(itemId)
  if (!item) return
  const ready = await scheduler.init()
  if (!ready) return
  await scheduler.auditionItem(item)
}

// ── 初始化 ─────────────────────────────────────────────────────────────────
async function bootstrap(id: Id): Promise<void> {
  booting.value = true
  try {
    timeline.bindChapter(id, 0)
    await arrangement.loadChapter(id)
    timeline.setDuration(arrangement.totalDurationMs)
    // 没有 items（还没跑自动对轨）时给引导空态；有 items 才适配整章
    if (!arrangement.items.length) timeline.resetView()
    else timeline.fitChapter(arrangement.totalDurationMs)
    strategy.value = arrangement.arrangement?.strategy ?? strategy.value
    validation.clear()
    timeline.setHint('已加载章节：拖动片段移动位置，拖左右边缘改裁剪点')
  } finally {
    booting.value = false
  }
}

onMounted(async () => {
  if (session.bookId && !chapters.rows.length) void chapters.load(session.bookId)
  const id = chapterId.value
  if (id) await bootstrap(id)
})

watch(chapterId, async (id, previous) => {
  if (!id || id === previous) return
  await bootstrap(id)
})

onBeforeUnmount(() => {
  void arrangement.flushNow()   // 离开页面前把改动落库
  timeline.saveMemory()         // 记住缩放位置（docs/13 §4.6 缩放记忆）
  playback.reset()
})

// ── 派生数据（全部来自 store） ──────────────────────────────────────────────
const tracks = computed(() => arrangement.tracks)
const selectedItem = computed<ArrangementItem | null>(() => arrangement.selectedItem)

const conflictIds = computed<ReadonlySet<Id>>(() => {
  const set = new Set<Id>()
  for (const conflict of arrangement.overlapReport.sameTrack) { set.add(conflict.a); set.add(conflict.b) }
  return set
})

/** 每轨同轨重叠数（轨道头红灯） */
const conflictByTrack = computed<Map<TrackId, number>>(() => {
  const map = new Map<TrackId, number>()
  for (const conflict of arrangement.overlapReport.sameTrack) {
    map.set(conflict.trackId, (map.get(conflict.trackId) ?? 0) + 1)
  }
  return map
})

/** 该轨是否全部锁定（轨道头锁图标） */
function trackLocked(trackId: TrackId): boolean {
  const list = arrangement.trackItems(trackId)
  return list.length > 0 && list.every(item => item.locked)
}

const chapterOptions = computed(() => chapters.rows.map(row => ({ value: row.id, label: `#${row.seq} ${row.title}` })))
const strategyOptions = computed(() => (Object.keys(ARRANGE_STRATEGY_LABELS) as ArrangeStrategy[])
  .map(value => ({ value, label: ARRANGE_STRATEGY_LABELS[value] ?? value })))
const gridOptions = computed(() => GRID_OPTIONS.map(option => ({ value: option.value, label: option.label })))

/** 状态条：选中项信息（docs/13 §4.5 的字段顺序：起止 | 源内起止 | locked | offset） */
const selectionText = computed(() => {
  const item = selectedItem.value
  if (!item) return '未选中片段'
  const seq = arrangement.lineSeq(item)
  const label = arrangement.lineLabel(item, 10)
  const start = item.timelineStartMs
  const parts = [
    `${seq === null ? '' : `#${seq} `}${label || item.id.slice(0, 8)}`,
    `@ ${formatDuration(start, { showMs: true })} - ${formatDuration(start + arrangement.durationOf(item), { showMs: true })}`,
    `源 ${formatDuration(item.srcInMs, { showMs: true })}-${formatDuration(item.srcOutMs, { showMs: true })}`,
    item.locked ? 'locked' : '未锁定',
  ]
  if (item.fadeInMs || item.fadeOutMs) parts.push(`淡入出 ${item.fadeInMs}/${item.fadeOutMs} ms`)
  return parts.join(' | ')
})

const multiSelectionText = computed(() => (
  timeline.selectedIds.length > 1 ? `（已选 ${timeline.selectedIds.length} 段：批量操作作用于全部选中项）` : ''))

const hoverLabel = computed(() => {
  const item = hoverItemId.value ? arrangement.itemById(hoverItemId.value) : null
  if (!item) return ''
  const seq = arrangement.lineSeq(item)
  return `悬停：${seq === null ? '' : `#${seq} `}${arrangement.lineLabel(item, 10)} @ ${formatDuration(item.timelineStartMs, { showMs: true })}`
})

const durationLabel = computed(() => formatDuration(arrangement.totalDurationMs))
const missingLabel = computed(() => (arrangement.missingLineCount > 0 ? `缺录 ${arrangement.missingLineCount} 行` : ''))

// ── 工具条动作 ─────────────────────────────────────────────────────────────
function onChapterChange(id: Id): void {
  // 先记住当前章节的缩放位置再切章（切章后 store 的 chapterId 已变，取不回旧值）
  timeline.saveMemory()
  session.selectChapter(chapters.rows.find(item => item.id === id) ?? null)
}

/** 网格选择：el-select 的选项值即 GridMs */
function onGridInput(value: GridMs): void {
  timeline.setGrid(value)
}

async function onAutoArrange(): Promise<void> {
  if (arranging.value) return
  arranging.value = true
  try {
    const res = await arrangement.autoArrange({
      strategy: strategy.value,
      preserveLocked: true,
      defaultPauseMs: defaultPauseMs.value,
    })
    timeline.setDuration(arrangement.totalDurationMs)
    timeline.fitChapter(arrangement.totalDurationMs)
    validation.clear() // 排布变了，旧报告不再对应当前时间线
    timeline.setHint(`自动对轨完成：${res.updated} 段（策略 ${ARRANGE_STRATEGY_LABELS[strategy.value] ?? strategy.value}，已保留锁定片段）`)
  } catch {
    /* 错误已由 ipc 层交给 error-bus */
  } finally {
    arranging.value = false
  }
}

async function onValidate(): Promise<void> {
  const id = arrangement.currentArrangementId
  if (!id) return
  judgeTab.value = 'validation'
  const res = await validation.validate(id)
  if (!res) return
  timeline.setHint(validation.totalCount === 0
    ? '校验通过：未发现问题'
    : `校验完成：共 ${validation.totalCount} 项（必修 ${validation.blockingCount}）`)
}

function onArrangementChanged(): void {
  timeline.setDuration(arrangement.totalDurationMs)
  timeline.fitChapter(arrangement.totalDurationMs)
  validation.clear()
  timeline.setHint('已切换方案：时间线已整体切换')
}

// ── 画布 / 刻度尺 / MiniMap 的交互结果 ──────────────────────────────────────
function onRulerSeek(ms: number): void { timeline.setPlayhead(ms); playback.setCurrentMs(ms) }
function onLoopSet(range: { startMs: number; endMs: number }): void { timeline.setLoop(range.startMs, range.endMs) }
function onMapScroll(ms: number): void { timeline.setScrollMs(ms) }
function onMapFit(): void { timeline.fitChapter(arrangement.totalDurationMs) }

function onCanvasSelection(ids: Id[]): void { if (ids.length) judgeTab.value = 'inspector' }
function onCanvasItemMove(payload: { label: string; items: ArrangementItem[] }): void {
  timeline.setHint(`${payload.label}：已提交 ${payload.items.length} 段（Ctrl+Z 可整体撤销）`)
}
function onCanvasHover(payload: { itemId: Id | null; timeMs: number } | null): void { hoverItemId.value = payload?.itemId ?? null }
/** 缩放已由交互层执行；这里只把新的缩放级别反馈到状态条 */
function onCanvasZoom(): void { interactionHint.value = `缩放 ${timeline.zoomLabel}（Ctrl+滚轮缩放，Shift+滚轮平移）` }
function onCanvasLayout(payload: { contentHeight: number; viewportHeightPx: number }): void {
  timeline.setScrollTop(timeline.scrollTopPx, payload.contentHeight)
}
function onJumpLine(lineId: Id): void { void router.push({ path: '/canvas', query: { line: lineId } }) }

// ── Judge 区：校验跳转与「一条一条处理」 ────────────────────────────────────
function focusIssue(row: ValidationIssueRow): void {
  if (row.itemId) timeline.select(row.itemId)
  if (row.timeMs !== null) timeline.ensureTimeVisible(row.timeMs)
  judgeTab.value = 'inspector'
}

/**
 * 引导模式按 Enter「处理」：按 kind 跳到最省事的那个工具。
 * 绝不假装已修好——校验结果只由主进程给出，本地不篡改。
 */
function handleIssue(row: ValidationIssueRow): void {
  switch (row.kind) {
    case 'same_track_overlap':
      judgeTab.value = 'overlaps'
      if (row.itemId) timeline.select(row.itemId)
      timeline.setHint('已在重叠消解面板定位该片段：选策略后「按此策略消解」')
      break
    case 'wrong_order':
    case 'orphan_segment':
      void router.push({ path: '/alignment/match' })
      break
    case 'missing_line':
      timeline.setHint('该行缺录：去录音页补录，或先在录制对齐页核对绑定')
      void router.push({ path: '/recording' })
      break
    case 'file_missing':
      timeline.setHint('音频文件丢失：回录音页重选 Take，或恢复该片段文件')
      break
    default:
      if (row.timeMs !== null) timeline.ensureTimeVisible(row.timeMs)
      if (row.itemId) timeline.select(row.itemId)
      timeline.setHint(`${row.label}：已定位到时间线，请人工确认`)
      break
  }
}

function focusConflict(payload: { itemIds: Id[]; timeMs: number | null }): void {
  if (payload.itemIds.length) timeline.selectMany(payload.itemIds, false)
  if (payload.timeMs !== null) timeline.ensureTimeVisible(payload.timeMs)
}

// ── 状态条动作（docs/13 §4.5 第三行） ──────────────────────────────────────
function onToggleLock(): void {
  const ids = timeline.selectedIds.length
    ? [...timeline.selectedIds]
    : (selectedItem.value ? [selectedItem.value.id] : [])
  if (!ids.length) return
  const allLocked = ids.every(id => arrangement.itemById(id)?.locked)
  arrangement.setLockedMany(ids, !allLocked)
  timeline.setHint(allLocked ? '已解锁所选片段' : '已锁定所选片段（拖动与自动排布都不会动它）')
}

function onNudge(deltaMs: number): void {
  arrangement.nudgeSelected(deltaMs)
  const item = selectedItem.value
  if (item) timeline.setHint(`微调 ${formatOffsetMs(deltaMs)} → 起点 ${formatDuration(item.timelineStartMs, { showMs: true })}`)
}

function onResetPosition(): void {
  const item = selectedItem.value
  if (!item) return
  arrangement.resetItemToAuto(item.id)
  timeline.setHint('已重置为自动排布结果')
}

async function onSaveNow(): Promise<void> {
  await arrangement.flushNow()
  timeline.setHint('已提交全部改动（alignment:batchUpdateItems）')
}

// ── 轨道头动作 ─────────────────────────────────────────────────────────────
function onTrackLock(trackId: TrackId, locked: boolean): void {
  const ids = arrangement.trackItems(trackId).map(item => item.id)
  if (!ids.length) return
  arrangement.setLockedMany(ids, locked)
  timeline.setHint(locked ? '整轨已锁定' : '整轨已解锁（可重新自动排布该轨）')
}

/** TrackHeader 抛的是「目标状态」，store 的 toggle 是取反，这里做一次对齐 */
function onTrackSolo(trackId: TrackId, value: boolean): void {
  if (playback.isSolo(trackId) !== value) playback.toggleSolo(trackId)
  scheduler.applyMix()
}

function onTrackMute(trackId: TrackId, value: boolean): void {
  if (playback.isMuted(trackId) !== value) playback.toggleMute(trackId)
  scheduler.applyMix()
}

function onTrackGain(trackId: TrackId, db: number): void {
  playback.setTrackGain(trackId, db)
  scheduler.applyMix()
}

async function onTrackReset(trackId: TrackId): Promise<void> {
  await arrangement.resetTrack(trackId)
  timeline.setDuration(arrangement.totalDurationMs)
  timeline.setHint('该轨已重置为自动排布结果')
}

// ── 键盘：只接管 Ctrl+S / Ctrl+M（其余在画布交互层） ───────────────────────
function onWindowKeydown(event: KeyboardEvent): void {
  if (isEditableTarget(event.target)) return
  if (matchEvent(event, 'Ctrl+S')) {
    event.preventDefault()
    void onSaveNow()
    return
  }
  if (matchEvent(event, 'Ctrl+M')) {
    event.preventDefault()
    timeline.toggleSnap()
    timeline.setHint(timeline.snapEnabled ? '吸附已开启' : '吸附已关闭（拖动时 Alt 也可临时关闭）')
  }
}
onMounted(() => globalThis.addEventListener?.('keydown', onWindowKeydown))
onBeforeUnmount(() => globalThis.removeEventListener?.('keydown', onWindowKeydown))

/** 选中项出现时自动切到检查器（用户点画布就是想看属性） */
watch(() => timeline.primarySelectedId, id => { if (id) judgeTab.value = 'inspector' })
watch(() => arrangement.lastError, error => { if (error) timeline.setHint('加载对轨数据失败：详见提示（可重试）') })
</script>

<template>
  <div class="ns-align">
    <!-- ───────── 工具条（docs/13 §4.5 第二行） ───────── -->
    <header class="ns-align__toolbar">
      <el-select
        :model-value="chapterId ?? ''" size="small" class="ns-align__chapter"
        placeholder="选择章节" filterable @update:model-value="onChapterChange"
      >
        <el-option v-for="option in chapterOptions" :key="option.value" :value="option.value" :label="option.label" />
      </el-select>

      <ArrangementSelector :chapter-id="chapterId" @changed="onArrangementChanged" @open-preview="previewVisible = true" />

      <span class="ns-align__divider" />
      <span class="ns-align__label">策略</span>
      <el-select v-model="strategy" size="small" class="ns-align__strategy">
        <el-option v-for="option in strategyOptions" :key="option.value" :value="option.value" :label="option.label" />
      </el-select>
      <span class="ns-align__label">句间留白</span>
      <el-input-number v-model="defaultPauseMs" :min="0" :max="5000" :step="50" size="small" controls-position="right" class="ns-align__pause" />
      <span class="ns-align__unit">ms</span>

      <el-button size="small" type="primary" :loading="arranging" :disabled="!chapterId" @click="onAutoArrange">自动对轨</el-button>
      <el-button size="small" :loading="validation.loading" :disabled="!arrangement.currentArrangementId" @click="onValidate">
        校验<span v-if="validation.totalCount">（{{ validation.totalCount }}）</span>
      </el-button>
      <el-button size="small" :disabled="!arrangement.currentArrangementId" @click="previewVisible = true">预览渲染</el-button>

      <div class="ns-align__toolbar-right">
        <span class="ns-align__meta">总时长 {{ durationLabel }}</span>
        <span v-if="missingLabel" class="ns-align__meta ns-align__meta--warn">{{ missingLabel }}</span>
        <AutoSaveIndicator
          :status="arrangement.saveStatus" :saved-at="arrangement.lastSavedAt"
          :error-text="arrangement.lastErrorText" :revertable="false" compact @retry="onSaveNow"
        />
      </div>
    </header>

    <!-- ───────── 主体：时间线 + Judge 区 ───────── -->
    <div class="ns-align__body">
      <section class="ns-align__timeline">
        <LoadingBlock v-if="booting" text="正在加载章节的对轨数据…" />

        <EmptyState
          v-else-if="!arrangement.items.length" icon="🎚️" title="这一章还没有排布结果"
          description="录制完成后点「自动对轨」生成初版排布；也可以先切换方案看看已有排布。"
          action-text="立即自动对轨" hint="自动对轨会保留已锁定片段的位置。" @action="onAutoArrange"
        />

        <template v-else>
          <!-- 刻度尺行：左侧与轨道头等宽，保证刻度与画布严格对齐 -->
          <div class="ns-align__ruler-row">
            <div class="ns-align__ruler-spacer">轨道 / 时间轴</div>
            <TimelineRuler
              :px-per-ms="timeline.pxPerMs" :scroll-ms="timeline.scrollMs" :playhead-ms="timeline.playheadMs"
              :duration-ms="arrangement.totalDurationMs" :loop="timeline.loop" :zoom-label="timeline.zoomLabel"
              :snap-enabled="timeline.snapEnabled" :grid-ms="timeline.gridMs"
              @seek="onRulerSeek" @loop-set="onLoopSet" @loop-clear="timeline.clearLoop()"
            />
          </div>

          <!-- 轨道区：左列轨道头 + 右侧 Canvas（行高逐行对齐） -->
          <div class="ns-align__tracks">
            <div class="ns-align__headers">
              <TrackHeader
                v-for="track in tracks" :key="track.trackId" :track="track" :height="timeline.trackHeightPx"
                :selected="selectedTrackId === track.trackId" :solo="playback.isSolo(track.trackId)"
                :muted="playback.isMuted(track.trackId)" :gain-db="playback.gainOf(track.trackId)"
                :audible="playback.isAudible(track.trackId)" :locked="trackLocked(track.trackId)"
                :conflict-count="conflictByTrack.get(track.trackId) ?? 0" :resettable="track.itemCount > 0"
                @select="(id) => (selectedTrackId = id)" @solo="onTrackSolo" @mute="onTrackMute"
                @gain="onTrackGain" @lock="onTrackLock" @reset-track="onTrackReset"
                @cycle-height="timeline.cycleTrackHeight()"
              />
            </div>

            <TimelineCanvas
              class="ns-align__canvas" :px-per-ms="timeline.pxPerMs" :scroll-ms="timeline.scrollMs"
              :track-height="timeline.trackHeightPx" :scroll-top-px="timeline.scrollTopPx" :tracks="tracks"
              :items-by-track="arrangement.itemsByTrack" :selected-ids="timeline.selectedIds"
              :primary-selected-id="timeline.primarySelectedId" :audition-item-id="playback.auditionItemId"
              :conflict-ids="conflictIds" :playhead-ms="timeline.playheadMs" :loop="timeline.loop"
              :snap-enabled="timeline.snapEnabled" :grid-ms="timeline.gridMs"
              @update:selection="onCanvasSelection" @item-move="onCanvasItemMove"
              @playhead-move="(ms) => playback.setCurrentMs(ms)" @request-zoom="onCanvasZoom"
              @request-play-toggle="togglePlay" @nudge="onNudge"
              @status="(text) => (interactionHint = text)" @hover="onCanvasHover"
              @layout-change="onCanvasLayout"
            />
          </div>

          <!-- MiniMap：整章总览 + 视口窗口（长章节导航，docs/13 §11） -->
          <MiniMap
            :tracks="tracks" :items-by-track="arrangement.itemsByTrack" :duration-ms="arrangement.totalDurationMs"
            :px-per-ms="timeline.pxPerMs" :scroll-ms="timeline.scrollMs" :viewport-width-px="timeline.viewportWidthPx"
            :playhead-ms="timeline.playheadMs" :playing-ms="playback.currentMs" :playing="playback.isPlaying"
            :loop="timeline.loop" :selected-ids="timeline.selectedIds" :conflict-ids="conflictIds"
            @scroll="onMapScroll" @seek="onRulerSeek" @fit="onMapFit"
          />
        </template>
      </section>

      <!-- Judge 区：检查器 / 校验报告 / 重叠消解 -->
      <aside class="ns-align__judge">
        <div class="ns-align__tabs">
          <button type="button" class="ns-align__tab" :class="{ 'is-active': judgeTab === 'inspector' }" @click="judgeTab = 'inspector'">检查器</button>
          <button type="button" class="ns-align__tab" :class="{ 'is-active': judgeTab === 'validation' }" @click="judgeTab = 'validation'">
            校验{{ validation.totalCount ? `(${validation.totalCount})` : '' }}
          </button>
          <button type="button" class="ns-align__tab" :class="{ 'is-active': judgeTab === 'overlaps' }" @click="judgeTab = 'overlaps'">
            重叠{{ arrangement.overlapReport.sameTrack.length ? `(${arrangement.overlapReport.sameTrack.length})` : '' }}
          </button>
        </div>

        <div class="ns-align__judge-body">
          <Inspector
            v-if="judgeTab === 'inspector'" :item-id="timeline.primarySelectedId"
            @audition="auditionItem" @jump-line="onJumpLine"
          />
          <ValidationPanel
            v-else-if="judgeTab === 'validation'" :arrangement-id="arrangement.currentArrangementId"
            @focus="focusIssue" @handle="handleIssue"
            @open-matcher="router.push({ path: '/alignment/match' })" @open-overlaps="judgeTab = 'overlaps'"
          />
          <OverlapResolver
            v-else :active="judgeTab === 'overlaps'"
            @focus="focusConflict" @open-validation="judgeTab = 'validation'"
          />
        </div>
      </aside>
    </div>

    <!-- ───────── 状态条（docs/13 §4.5 第三行） ───────── -->
    <footer class="ns-align__status">
      <div class="ns-align__status-info">
        <span class="ns-align__selection" :title="selectionText">{{ selectionText }}</span>
        <span v-if="multiSelectionText" class="ns-align__muted">{{ multiSelectionText }}</span>
        <span v-if="hoverLabel" class="ns-align__muted">{{ hoverLabel }}</span>
        <span v-if="interactionHint" class="ns-align__hint">{{ interactionHint }}</span>
        <span v-else-if="timeline.hint" class="ns-align__hint">{{ timeline.hint }}</span>
      </div>

      <div class="ns-align__status-actions">
        <el-button size="small" :disabled="!selectedItem && !timeline.selectedIds.length" @click="onToggleLock">🔒 锁定</el-button>
        <el-button size="small" @click="timeline.toggleSnap()">吸附{{ timeline.snapEnabled ? '✓' : '✗' }}</el-button>
        <el-select :model-value="timeline.gridMs" size="small" class="ns-align__grid" @update:model-value="onGridInput">
          <el-option v-for="option in gridOptions" :key="option.value" :value="option.value" :label="option.label" />
        </el-select>
        <el-button size="small" :disabled="!selectedItem" @click="onNudge(-10)">← −10ms</el-button>
        <el-button size="small" :disabled="!selectedItem" @click="onNudge(10)">+10ms →</el-button>
        <el-button size="small" :disabled="!selectedItem" @click="onResetPosition">重置位置</el-button>
        <el-button size="small" :disabled="!selectedItem" @click="selectedItem && auditionItem(selectedItem.id)">试听</el-button>
        <el-button size="small" :disabled="!scheduler.isReady.value && !playback.isPlaying" @click="togglePlay">
          {{ playback.isPlaying ? '暂停' : '播放' }}
        </el-button>
      </div>
    </footer>

    <PreviewRenderDialog
      v-model="previewVisible" :arrangement-id="arrangement.currentArrangementId" :chapter-id="chapterId"
      :initial-start-ms="timeline.playheadMs" @open-tasks="router.push({ path: '/tasks' })"
    />

    <!-- 试听不可用（AudioContext 未就绪 / 解码失败）：详情由 error-bus 给出，这里只做常驻提示 -->
    <p v-if="playback.lastError" class="ns-align__error">
      试听不可用：音频上下文未就绪或片段解码失败（可在设置里确认「试听用处理后文件」）
    </p>
  </div>
</template>

<style scoped>
.ns-align {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
  min-height: 0;
  background: var(--ns-bg, #fff);
}
.ns-align__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ns-border, #e6e9f0);
}
.ns-align__chapter { width: 180px; }
.ns-align__divider { width: 1px; height: 18px; background: var(--ns-border, #e6e9f0); }
.ns-align__label,
.ns-align__unit { color: var(--ns-text-secondary, #909399); font-size: 12px; }
.ns-align__strategy { width: 120px; }
.ns-align__pause { width: 110px; }
.ns-align__toolbar-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.ns-align__meta { color: var(--ns-text-secondary, #909399); font-size: 12px; font-variant-numeric: tabular-nums; }
.ns-align__meta--warn { color: var(--ns-warning, #e6a23c); }
.ns-align__body { display: grid; grid-template-columns: minmax(0, 1fr) 344px; min-height: 0; }
.ns-align__timeline {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ns-border, #e6e9f0);
}
.ns-align__ruler-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); }
.ns-align__ruler-spacer {
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-right: 1px solid var(--ns-border, #e6e9f0);
  border-bottom: 1px solid var(--ns-border, #e6e9f0);
  background: var(--ns-bg-subtle, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-align__tracks { display: grid; grid-template-columns: 190px minmax(0, 1fr); flex: 1 1 auto; min-height: 0; }
.ns-align__headers { overflow: hidden auto; border-right: 1px solid var(--ns-border, #e6e9f0); }
.ns-align__canvas { min-height: 0; }
.ns-align__judge { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ns-align__tabs { display: flex; border-bottom: 1px solid var(--ns-border, #e6e9f0); }
.ns-align__tab {
  flex: 1 1 0;
  padding: 7px 4px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  cursor: pointer;
}
.ns-align__tab:hover { color: var(--ns-primary, #409eff); }
.ns-align__tab.is-active {
  border-bottom-color: var(--ns-primary, #409eff);
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-align__judge-body { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.ns-align__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--ns-border, #e6e9f0);
  background: var(--ns-bg-subtle, #fafafa);
  font-size: 12px;
}
.ns-align__status-info { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-width: 0; }
.ns-align__selection {
  overflow: hidden;
  max-width: 62ch;
  color: var(--ns-text-primary, #303133);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ns-align__muted { color: var(--ns-text-secondary, #909399); }
.ns-align__hint { color: var(--ns-primary, #409eff); }
.ns-align__status-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: auto; }
.ns-align__grid { width: 96px; }
.ns-align__error {
  margin: 0;
  padding: 4px 10px;
  background: color-mix(in srgb, var(--ns-danger, #f56c6c) 10%, var(--ns-bg, #fff));
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
}
</style>
