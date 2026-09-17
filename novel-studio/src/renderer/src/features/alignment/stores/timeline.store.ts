/**
 * 对轨域 · 时间线视口与选择状态
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md
 *   · §4.5 时间线视图（左侧轨道头 + 刻度尺 + 画布 + MiniMap）
 *   · §4.6 视图能力：横向缩放（整章总览 ↔ 样本级 ~1 ms/px）、纵向轨道高度
 *     （紧凑/标准/宽松）、**每个章节记住上次的缩放与滚动位置**（localStorage）
 *   · §9   UI 结构：视口/选中/播放头由 store 持有，Canvas 只负责画与命中
 *
 * 为什么把这些状态放在 store 而不是组件里：
 *   刻度尺（TimelineRuler）、画布（TimelineCanvas）、轨道头（TrackHeader）、
 *   MiniMap 四个组件必须共享**同一个视口**。如果各自持有一份，滚轮缩放时
 *   刻度尺与画布会错位一帧甚至彻底不同步 —— 这是时间线类 UI 最经典的一类 bug。
 *
 * 坐标系约定（与 shared/lib/waveform-transform.ts 完全一致，禁止自创）：
 *   · 时间单位恒为**毫秒**；
 *   · `pxPerMs` 是唯一缩放量；
 *   · `scrollMs` 是视口左边缘对应的时间（不是滚动像素），
 *     因此缩放时不需要重算滚动位置（`zoomAround` 直接可用）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Id, TrackId } from '@shared/types.ts'
import {
  TIMELINE_ZOOM_LIMITS,
  clampTime,
  durationToWidth,
  fitPxPerMs,
  timeToX,
  viewportDurationMs,
  viewportEndMs,
  xToTime,
  zoomAround,
} from '@/shared/lib/waveform-transform.ts'
import type { Viewport } from '@/shared/lib/waveform-transform.ts'

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 纵向缩放档位（docs/13 §4.6「轨道高度可调（紧凑/标准/宽松）」） */
export type TrackHeightPreset = 'compact' | 'normal' | 'relaxed'

/** 轨道高度像素值。宽松档要能看清波形包络，紧凑档用于 8 轨以上的长章节 */
export const TRACK_HEIGHT_PX: Record<TrackHeightPreset, number> = {
  compact: 30,
  normal: 46,
  relaxed: 72,
}

export const TRACK_HEIGHT_LABELS: Record<TrackHeightPreset, string> = {
  compact: '紧凑',
  normal: '标准',
  relaxed: '宽松',
}

/** 网格粒度（docs/13 §4.5 底部状态条：0.1s / 0.05s / 1s） */
export type GridMs = 50 | 100 | 1000

export const GRID_OPTIONS: ReadonlyArray<{ value: GridMs; label: string }> = [
  { value: 50, label: '0.05 s' },
  { value: 100, label: '0.1 s' },
  { value: 1000, label: '1 s' },
]

/** 轨道之间的视觉间隙（px）；命中检测与绘制都用它，避免两处不一致 */
export const TRACK_GAP_PX = 4

/** 视口记忆的 localStorage 前缀（键里带 chapterId，一章一份） */
const MEMORY_KEY_PREFIX = 'ns.alignment.timeline.v1:'

export interface TimelineMemory {
  pxPerMs: number
  scrollMs: number
  scrollTopPx: number
  trackHeight: TrackHeightPreset
  /** 用户手动排过的轨道顺序（docs/13 §4.1「可手动排序（用户偏好持久化）」） */
  trackOrder: TrackId[]
}

function defaultMemory(): TimelineMemory {
  return {
    pxPerMs: 0.01,
    scrollMs: 0,
    scrollTopPx: 0,
    trackHeight: 'normal',
    trackOrder: [],
  }
}

/** 读取某章的视口记忆（localStorage 不可用 / 数据损坏时一律回落默认值） */
export function readTimelineMemory(chapterId: Id | null | undefined): TimelineMemory | null {
  if (!chapterId) return null
  try {
    const raw = globalThis.localStorage?.getItem(MEMORY_KEY_PREFIX + chapterId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TimelineMemory>
    const preset: TrackHeightPreset =
      parsed.trackHeight === 'compact' || parsed.trackHeight === 'relaxed' ? parsed.trackHeight : 'normal'
    return {
      pxPerMs: Number.isFinite(parsed.pxPerMs) && (parsed.pxPerMs as number) > 0
        ? (parsed.pxPerMs as number)
        : 0.01,
      scrollMs: Number.isFinite(parsed.scrollMs) ? Math.max(0, parsed.scrollMs as number) : 0,
      scrollTopPx: Number.isFinite(parsed.scrollTopPx) ? Math.max(0, parsed.scrollTopPx as number) : 0,
      trackHeight: preset,
      trackOrder: Array.isArray(parsed.trackOrder) ? parsed.trackOrder.filter(t => typeof t === 'string') : [],
    }
  } catch {
    // 隐私模式 / 配额满 / 手工改坏 —— 记不住位置不是功能故障，静默回落
    return null
  }
}

function writeTimelineMemory(chapterId: Id, memory: TimelineMemory): void {
  try {
    globalThis.localStorage?.setItem(MEMORY_KEY_PREFIX + chapterId, JSON.stringify(memory))
  } catch {
    /* 写不进去只是记不住位置 */
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useTimelineStore = defineStore('alignment/timeline', () => {
  // ── 视口 ────────────────────────────────────────────────────────────────
  /** 缩放：每毫秒多少像素（唯一缩放量） */
  const pxPerMs = ref(0.01)
  /** 视口左边缘对应的时间（毫秒） */
  const scrollMs = ref(0)
  /** 轨道区纵向滚动（像素） */
  const scrollTopPx = ref(0)
  /** 画布 CSS 像素尺寸（由 TimelineCanvas 的 ResizeObserver 写入） */
  const viewportWidthPx = ref(0)
  const viewportHeightPx = ref(0)

  // ── 纵向 ────────────────────────────────────────────────────────────────
  const trackHeight = ref<TrackHeightPreset>('normal')
  /** 用户自定义轨道顺序（空数组 = 用自动顺序：旁白第一，其余按出场） */
  const trackOrderPreference = ref<TrackId[]>([])

  // ── 选择 / 播放头 / 循环 ────────────────────────────────────────────────
  const selectedIds = ref<Id[]>([])
  /** 主选中项（Inspector 与底部状态条读它；多选时取最近一次点中的） */
  const primarySelectedId = ref<Id | null>(null)
  const playheadMs = ref(0)
  const loop = ref<{ startMs: number; endMs: number } | null>(null)

  // ── 编辑辅助 ────────────────────────────────────────────────────────────
  /** 吸附开关（拖动时按住 Alt 临时关闭，见 useTimelineInteraction） */
  const snapEnabled = ref(true)
  const gridMs = ref<GridMs>(100)
  /** 播放时是否让视口跟随播放头 */
  const followPlayhead = ref(true)

  /** 章节总时长（由视图在加载 items 后写入，用于夹紧播放头/滚动范围） */
  const durationMs = ref(0)
  /** 当前章节 id（缩放记忆的键） */
  const chapterId = ref<Id | null>(null)
  /** 状态条提示（拖动时的吸附反馈，如「吸附到相邻边界」） */
  const hint = ref('')

  // ── 计算 ────────────────────────────────────────────────────────────────
  const viewport = computed<Viewport>(() => ({ pxPerMs: pxPerMs.value, scrollMs: scrollMs.value }))

  /** 视口覆盖的时长（毫秒） */
  const visibleDurationMs = computed(() => viewportDurationMs(viewportWidthPx.value, viewport.value))
  /** 视口右边缘时间（毫秒） */
  const visibleEndMs = computed(() => viewportEndMs(viewportWidthPx.value, viewport.value))
  /** 每秒多少像素（缩放标签与吸附阈值换算都要用） */
  const pxPerSecond = computed(() => pxPerMs.value * 1000)
  const trackHeightPx = computed(() => TRACK_HEIGHT_PX[trackHeight.value])
  const zoomLimits = TIMELINE_ZOOM_LIMITS

  /** 缩放的人话描述：`1 px = 20 ms`（状态条显示） */
  const zoomLabel = computed(() => {
    const msPerPx = pxPerMs.value > 0 ? 1 / pxPerMs.value : 0
    if (msPerPx >= 1000) return `1 px ≈ ${(msPerPx / 1000).toFixed(1)} s`
    if (msPerPx >= 1) return `1 px ≈ ${msPerPx.toFixed(1)} ms`
    return `1 px ≈ ${(msPerPx * 1000).toFixed(0)} µs`
  })

  /** 底部状态条：`视口 3:12.4 → 3:40.0（26 个 / 共 87 个）` 由视图补 items 计数 */
  const visibleRangeLabel = computed(() => ({
    fromMs: scrollMs.value,
    toMs: visibleEndMs.value,
    widthPx: viewportWidthPx.value,
  }))

  // ── 视口操作 ────────────────────────────────────────────────────────────

  /** 画布尺寸变化（ResizeObserver）：只在宽度真的变化时改，避免无谓重绘 */
  function setViewportSize(widthPx: number, heightPx: number): void {
    const w = Math.max(0, Math.round(widthPx))
    const h = Math.max(0, Math.round(heightPx))
    if (w === viewportWidthPx.value && h === viewportHeightPx.value) return
    viewportWidthPx.value = w
    viewportHeightPx.value = h
  }

  /** 直接设定缩放（滚动位置保持左边缘不动；需要锚点请用 zoomAroundX） */
  function setPxPerMs(next: number): void {
    pxPerMs.value = Math.min(TIMELINE_ZOOM_LIMITS.maxPxPerMs, Math.max(TIMELINE_ZOOM_LIMITS.minPxPerMs, next))
  }

  /** 以某个时间点为锚点缩放（锚点对应的像素位置不变） */
  function zoomAroundMs(factor: number, anchorMs: number): void {
    const next = zoomAround(viewport.value, factor, anchorMs, TIMELINE_ZOOM_LIMITS)
    pxPerMs.value = next.pxPerMs
    scrollMs.value = Math.max(0, next.scrollMs)
  }

  /** 以鼠标位置为锚点缩放（Ctrl+滚轮的入口） */
  function zoomAroundX(factor: number, xPx: number): void {
    zoomAroundMs(factor, xToTime(xPx, viewport.value))
  }

  /** 平移（像素）：正数表示视口右移（内容左移） */
  function panByPx(deltaPx: number): void {
    if (deltaPx === 0 || !(pxPerMs.value > 0)) return
    setScrollMs(scrollMs.value + deltaPx / pxPerMs.value)
  }

  /** 平移（毫秒） */
  function panByMs(deltaMs: number): void {
    setScrollMs(scrollMs.value + deltaMs)
  }

  /**
   * 设置左边缘时间。
   * 约束：不小于 0；右边缘不越过「章节总时长 + 一点余量」（否则用户会滚进无尽空白）。
   */
  function setScrollMs(next: number): void {
    const tail = Math.max(2000, viewportDurationMs(viewportWidthPx.value, viewport.value) * 0.25)
    const max = Math.max(0, durationMs.value + tail - viewportDurationMs(viewportWidthPx.value, viewport.value))
    scrollMs.value = Math.min(Math.max(0, Number.isFinite(next) ? next : 0), max)
  }

  /** 把某个时间点放到视口中央附近 */
  function centerOn(ms: number): void {
    setScrollMs(ms - viewportDurationMs(viewportWidthPx.value, viewport.value) / 2)
  }

  /** 保证某个时间点在视口内（跟随播放头用；已在视口内则不动，避免抖动） */
  function ensureTimeVisible(ms: number, marginPx = 64): void {
    const left = xToTime(0, viewport.value)
    const right = xToTime(viewportWidthPx.value, viewport.value)
    const marginMs = pxPerMs.value > 0 ? marginPx / pxPerMs.value : 0
    if (ms < left + marginMs) setScrollMs(ms - marginMs)
    else if (ms > right - marginMs) setScrollMs(ms - viewportDurationMs(viewportWidthPx.value, viewport.value) + marginMs)
  }

  /** 缩放适配整章（打开章节的初始视口，docs/13 §4.6「从整章总览到样本级」） */
  function fitChapter(totalDurationMs: number, widthPx = viewportWidthPx.value): void {
    if (!(widthPx > 0) || !(totalDurationMs > 0)) return
    pxPerMs.value = fitPxPerMs(totalDurationMs, widthPx, TIMELINE_ZOOM_LIMITS)
    scrollMs.value = 0
  }

  /** 纵向滚动（轨道区），带上界（内容高度由调用方给出） */
  function setScrollTop(next: number, contentHeightPx = Number.POSITIVE_INFINITY): void {
    const max = Math.max(0, contentHeightPx - viewportHeightPx.value)
    scrollTopPx.value = Math.min(Math.max(0, Number.isFinite(next) ? next : 0), max)
  }

  function scrollTracksBy(deltaPx: number, contentHeightPx = Number.POSITIVE_INFINITY): void {
    setScrollTop(scrollTopPx.value + deltaPx, contentHeightPx)
  }

  // ── 纵向缩放与轨道顺序 ──────────────────────────────────────────────────

  function setTrackHeight(preset: TrackHeightPreset): void {
    trackHeight.value = preset
  }

  /** 紧凑 → 标准 → 宽松 → 紧凑（状态条按钮用它） */
  function cycleTrackHeight(): void {
    const order: TrackHeightPreset[] = ['compact', 'normal', 'relaxed']
    const index = order.indexOf(trackHeight.value)
    trackHeight.value = order[(index + 1) % order.length] as TrackHeightPreset
  }

  function setTrackOrderPreference(order: TrackId[]): void {
    trackOrderPreference.value = [...order]
  }

  /**
   * 按当前顺序（自动顺序 ∪ 用户偏好）重排：上移/下移一位。
   * 返回新顺序，由调用方回写偏好（store 不持有 tracks 数据，避免与 arrangement store 耦合）。
   */
  function moveTrackInOrder(currentOrder: TrackId[], trackId: TrackId, delta: number): TrackId[] {
    const list = [...currentOrder]
    const from = list.indexOf(trackId)
    if (from < 0) return list
    // 旁白固定第一轨（docs/13 §4.1：视觉稳定，不允许被移走）
    const minIndex = list[0] === 'narration' ? 1 : 0
    const to = Math.min(list.length - 1, Math.max(minIndex, from + delta))
    if (to === from) return list
    list.splice(from, 1)
    list.splice(to, 0, trackId)
    return list
  }

  // ── 选择 ────────────────────────────────────────────────────────────────

  function select(id: Id | null, mode: 'replace' | 'toggle' | 'range' = 'replace'): void {
    if (id === null) {
      selectedIds.value = []
      primarySelectedId.value = null
      return
    }
    if (mode === 'toggle') {
      const exists = selectedIds.value.includes(id)
      selectedIds.value = exists ? selectedIds.value.filter(x => x !== id) : [...selectedIds.value, id]
      primarySelectedId.value = exists
        ? (selectedIds.value[selectedIds.value.length - 1] ?? null)
        : id
      return
    }
    selectedIds.value = [id]
    primarySelectedId.value = id
  }

  function selectMany(ids: Id[], additive = false): void {
    const merged = additive ? [...new Set([...selectedIds.value, ...ids])] : [...ids]
    selectedIds.value = merged
    primarySelectedId.value = merged[merged.length - 1] ?? null
  }

  function clearSelection(): void {
    selectedIds.value = []
    primarySelectedId.value = null
  }

  function isSelected(id: Id): boolean {
    return selectedIds.value.includes(id)
  }

  /** 选中项被删除/切换方案后要清理，否则 Inspector 会显示幽灵数据 */
  function pruneSelection(existingIds: ReadonlySet<Id>): void {
    const next = selectedIds.value.filter(id => existingIds.has(id))
    if (next.length === selectedIds.value.length) return
    selectedIds.value = next
    primarySelectedId.value = next[next.length - 1] ?? null
  }

  // ── 播放头 ──────────────────────────────────────────────────────────────

  function setPlayhead(ms: number, clampToChapter = true): void {
    const max = clampToChapter ? durationMs.value : Math.max(durationMs.value, ms)
    playheadMs.value = clampTime(Math.round(ms), max)
  }

  function nudgePlayhead(deltaMs: number): void {
    setPlayhead(playheadMs.value + deltaMs)
  }

  // ── 循环区间（docs/13 §4.6「框选区间循环播放」） ────────────────────────

  function setLoop(startMs: number, endMs: number): void {
    const a = Math.round(Math.min(startMs, endMs))
    const b = Math.round(Math.max(startMs, endMs))
    loop.value = b - a < 20 ? null : { startMs: clampTime(a, durationMs.value || b), endMs: clampTime(b, durationMs.value || b) }
  }

  function clearLoop(): void {
    loop.value = null
  }

  function toggleLoopAtPlayhead(spanMs = 3000): void {
    if (loop.value) {
      clearLoop()
      return
    }
    setLoop(playheadMs.value, playheadMs.value + spanMs)
  }

  // ── 编辑辅助 ────────────────────────────────────────────────────────────

  function toggleSnap(force?: boolean): void {
    snapEnabled.value = force ?? !snapEnabled.value
  }

  function setGrid(next: GridMs): void {
    gridMs.value = next
  }

  function setHint(text: string): void {
    hint.value = text
  }

  // ── 缩放记忆（docs/13 §4.6「每个章节记住上次的缩放与滚动位置」） ────────

  /**
   * 绑定章节：先读记忆，读不到则等 items 加载完后由视图调用 fitChapter 做初始适配。
   * 切章节时必须重置选中与循环区间 —— 否则会出现「选中了上一章的 item」。
   */
  function bindChapter(nextChapterId: Id | null, totalDurationMs = 0): void {
    chapterId.value = nextChapterId
    durationMs.value = totalDurationMs
    clearSelection()
    clearLoop()
    playheadMs.value = 0
    scrollTopPx.value = 0

    const memory = readTimelineMemory(nextChapterId)
    if (memory) {
      pxPerMs.value = Math.min(TIMELINE_ZOOM_LIMITS.maxPxPerMs, Math.max(TIMELINE_ZOOM_LIMITS.minPxPerMs, memory.pxPerMs))
      scrollMs.value = Math.max(0, memory.scrollMs)
      scrollTopPx.value = Math.max(0, memory.scrollTopPx)
      trackHeight.value = memory.trackHeight
      trackOrderPreference.value = memory.trackOrder
    } else {
      const base = defaultMemory()
      pxPerMs.value = base.pxPerMs
      scrollMs.value = 0
      trackHeight.value = base.trackHeight
      trackOrderPreference.value = []
    }
  }

  function setDuration(totalDurationMs: number): void {
    durationMs.value = Math.max(0, Math.round(totalDurationMs))
  }

  /** 保存缩放记忆（离开页面 / 切章节 / 视口变化防抖后调用） */
  function saveMemory(): void {
    const id = chapterId.value
    if (!id) return
    writeTimelineMemory(id, {
      pxPerMs: pxPerMs.value,
      scrollMs: scrollMs.value,
      scrollTopPx: scrollTopPx.value,
      trackHeight: trackHeight.value,
      trackOrder: trackOrderPreference.value,
    })
  }

  function resetView(): void {
    scrollMs.value = 0
    scrollTopPx.value = 0
    if (durationMs.value > 0 && viewportWidthPx.value > 0) fitChapter(durationMs.value)
  }

  // ── 坐标换算的便捷包装（组件里不再直接 import waveform-transform） ──────
  const toX = (ms: number): number => timeToX(ms, viewport.value)
  const toTime = (x: number): number => xToTime(x, viewport.value)
  const toWidth = (ms: number): number => durationToWidth(ms, viewport.value)

  return {
    // 状态
    pxPerMs, scrollMs, scrollTopPx, viewportWidthPx, viewportHeightPx,
    trackHeight, trackOrderPreference,
    selectedIds, primarySelectedId, playheadMs, loop,
    snapEnabled, gridMs, followPlayhead,
    durationMs, chapterId, hint,
    // 计算
    viewport, visibleDurationMs, visibleEndMs, pxPerSecond, trackHeightPx,
    zoomLimits, zoomLabel, visibleRangeLabel,
    // 视口
    setViewportSize, setPxPerMs, zoomAroundMs, zoomAroundX, panByPx, panByMs,
    setScrollMs, centerOn, ensureTimeVisible, fitChapter, setScrollTop, scrollTracksBy,
    // 纵向
    setTrackHeight, cycleTrackHeight, setTrackOrderPreference, moveTrackInOrder,
    // 选择
    select, selectMany, clearSelection, isSelected, pruneSelection,
    // 播放头 / 循环
    setPlayhead, nudgePlayhead, setLoop, clearLoop, toggleLoopAtPlayhead,
    // 编辑辅助
    toggleSnap, setGrid, setHint,
    // 章节与记忆
    bindChapter, setDuration, saveMemory, resetView,
    // 坐标包装
    toX, toTime, toWidth,
  }
})

export type TimelineStore = ReturnType<typeof useTimelineStore>

/** 便捷类型：视口（组件 props 里偶尔需要显式传递视口快照） */
export type { Viewport }
