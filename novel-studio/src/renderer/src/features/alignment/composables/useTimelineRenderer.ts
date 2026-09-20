/**
 * 对轨域 · 时间线 Canvas 绘制（LOD + 脏矩形 + 离屏静态层）
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md
 *   · §9 渲染架构：**时间线绝不用 DOM 元素渲染片段**（1000 个 DOM 节点 + 拖动会卡）。
 *        本文件因此把「片段」实现成绘制指令（`ClipBlock` 是逻辑单元，不是组件）。
 *   · §4.6 视图能力：波形 LOD 3 级（100/10/1 peaks/s，按缩放自动切换）、
 *        item 上叠加行号与文本首 10 字、播放头、循环区间、
 *        **1000 个 item 下拖动 ≥ 30 fps（脏矩形重绘 + 视口剔除）**
 *   · §4.3 重叠冲突用红色斜纹高亮
 * 绘制依据：docs/05 §11.3（波形 LOD 与缓存）、§11.4（命中检测与脏矩形）
 *
 * 坐标换算、LOD 选择、包络抽取、脏矩形计算**全部**复用
 * `@/shared/lib/waveform-transform.ts`，本文件不重写这些数学（否则刻度尺、MiniMap、
 * 命中检测三处一定会算出不同的结果）。
 *
 * 性能三条硬约束（都写在代码里，改代码时别破坏）：
 *   1. 视口外的 item 先被 `isTimeRangeVisible` 剔除，再算矩形；脏矩形重绘时再用
 *      「脏区时间范围」二次剔除 —— 拖动时通常只有 1~3 个 item 真正进入绘制。
 *   2. 静态部分（背景、轨道底、网格）画进**离屏 canvas**，逐帧只 `drawImage` 一次。
 *   3. 绘制循环里不建立 Vue 响应式依赖：所有数据通过 getter 传入，画一帧不触发任何
 *      watcher（否则拖动时 Vue 的调度开销会和绘制抢时间）。
 */

import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ArrangementItem, Id, TrackId } from '@shared/types.ts'
import { callSafe } from '@/shared/lib/ipc.ts'
import { formatTimecode } from '@/shared/lib/format.ts'
import { itemDurationMs } from '@shared/arrange/layout.ts'
import {
  amplitudeToY,
  buildEnvelope,
  chooseLod,
  clipRect,
  durationToWidth,
  isTimeRangeVisible,
  peaksBucketMs,
  peaksIndexRange,
  shouldSwitchLod,
  timeToX,
  unionRect,
  xToTime,
} from '@/shared/lib/waveform-transform.ts'
import type { PeaksPerSec, Rect, Viewport } from '@/shared/lib/waveform-transform.ts'
import { TRACK_GAP_PX } from '../stores/timeline.store.ts'
import { useUiStore } from '@/app/store/ui.store.ts'
import { themeColor } from '@/shared/lib/canvas-theme.ts'
import type { SegmentSource, TrackKind, TrackView } from '../stores/arrangement.store.ts'

// ===========================================================================
// 布局：轨道行（Canvas 与命中检测共用，避免两处各算一套 y）
// ===========================================================================

export interface TrackRow {
  trackId: TrackId
  /** 轨道序号（0 = 第一轨；旁白固定第一轨，docs/13 §4.1） */
  index: number
  /** 行顶部 y（已含纵向滚动偏移） */
  top: number
  height: number
  /** 轨道展示名（画布上不需要，但状态条/调试要用） */
  name: string
  kind: TrackKind
  /** 片段填充色（从 TrackView 复制过来，绘制时不必再建 Map 查找） */
  color: string
}

export interface TimelineLayout {
  rows: TrackRow[]
  byTrack: Map<TrackId, TrackRow>
  /** 内容总高度（含间隙），用于纵向滚动上界与 MiniMap */
  contentHeight: number
  trackHeight: number
}

/**
 * 生成轨道行布局。
 * `scrollTopPx` 只影响 `top`（视口内坐标），不影响行高 —— 这样纵向滚动不需要重建 DOM。
 */
export function buildLayout(
  tracks: TrackView[],
  trackHeightPx: number,
  scrollTopPx: number,
  gapPx = TRACK_GAP_PX,
): TimelineLayout {
  const rows: TrackRow[] = []
  const byTrack = new Map<TrackId, TrackRow>()
  const height = Math.max(8, Math.round(trackHeightPx))
  tracks.forEach((track, index) => {
    const row: TrackRow = {
      trackId: track.trackId,
      index,
      top: index * (height + gapPx) - scrollTopPx,
      height,
      name: track.name,
      kind: track.kind,
      color: track.color,
    }
    rows.push(row)
    byTrack.set(track.trackId, row)
  })
  return {
    rows,
    byTrack,
    contentHeight: Math.max(0, tracks.length * (height + gapPx) - gapPx),
    trackHeight: height,
  }
}

/** y → 轨道行（不在任何行内返回 null；间隙返回 null，点击间隙等于点击空白） */
export function rowAtY(layout: TimelineLayout, y: number): TrackRow | null {
  for (const row of layout.rows) {
    if (y >= row.top && y < row.top + row.height) return row
  }
  return null
}

/**
 * 轨内按起点二分：返回第一个 `timelineStartMs >= ms` 的下标（没有则返回数组长度）。
 * 命中检测与绘制都用它（docs/05 §11.4「按轨道行分组 + 轨内按时间二分」）。
 */
export function lowerBoundByStart(list: readonly ArrangementItem[], ms: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((list[mid] as ArrangementItem).timelineStartMs < ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ===========================================================================
// 矩形几何
// ===========================================================================

/** item 在屏幕上的矩形（宽度含淡入淡出，与 docs/13 §4.2 的时长口径一致） */
export function itemRect(item: ArrangementItem, row: TrackRow, vp: Viewport, insetPx = 1): Rect {
  const x = timeToX(item.timelineStartMs, vp)
  const w = Math.max(1, durationToWidth(itemDurationMs(item), vp))
  return {
    x,
    y: row.top + insetPx,
    w,
    h: Math.max(2, row.height - insetPx * 2),
  }
}

/**
 * 片段「音频主体」矩形：淡入淡出区在两端各占一段宽度
 * （`dur = srcOut - srcIn + fadeIn + fadeOut`，所以波形只画在扣掉 fade 之后的部分）。
 */
export function contentRectOf(item: ArrangementItem, rect: Rect, vp: Viewport): Rect {
  const fadeInPx = durationToWidth(Math.max(0, item.fadeInMs), vp)
  const fadeOutPx = durationToWidth(Math.max(0, item.fadeOutMs), vp)
  const w = Math.max(0, rect.w - fadeInPx - fadeOutPx)
  return { x: rect.x + fadeInPx, y: rect.y, w, h: rect.h }
}

// ===========================================================================
// 刻度（刻度尺与画布网格共用同一套，保证刻度线对齐）
// ===========================================================================

export interface TickSpec {
  /** 主刻度（带标签）间隔，毫秒 */
  majorMs: number
  /** 次刻度间隔，毫秒；0 表示不画次刻度 */
  minorMs: number
}

/** 人类友好的时间台阶（毫秒）：从样本级到小时级 */
const TICK_STEPS = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500,
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
] as const

/** 主刻度之间至少留多少像素（标签才不会挤在一起） */
const MIN_MAJOR_PX = 72

/**
 * 按缩放选择刻度间隔（docs/13 §4.6「从整章总览到样本级」）。
 * 毫秒级缩放时会落到 1 ms 主刻度，秒级以上是 5 s/10 s/1 min 这类整值 —— 绝不出现 7.3 s。
 */
export function chooseTickSpec(pxPerMs: number): TickSpec {
  if (!(pxPerMs > 0)) return { majorMs: 60_000, minorMs: 10_000 }
  for (const step of TICK_STEPS) {
    if (step * pxPerMs >= MIN_MAJOR_PX) {
      return { majorMs: step, minorMs: minorStep(step) }
    }
  }
  const last = TICK_STEPS[TICK_STEPS.length - 1] as number
  return { majorMs: last, minorMs: minorStep(last) }
}

function minorStep(major: number): number {
  const divisor = major % 5 === 0 ? 5 : major % 4 === 0 ? 4 : major % 2 === 0 ? 2 : 1
  return divisor === 1 ? 0 : major / divisor
}

/** 主刻度的时间点（含区间两端外的第一个，保证边缘不空） */
export function majorTickTimes(vp: Viewport, widthPx: number, spec: TickSpec): number[] {
  const from = xToTime(0, vp)
  const to = xToTime(widthPx, vp)
  const out: number[] = []
  const start = Math.floor(from / spec.majorMs) * spec.majorMs
  for (let t = start; t <= to; t += spec.majorMs) {
    if (t >= 0) out.push(t)
    if (out.length > 2000) break // 防御：异常缩放下的爆量
  }
  return out
}

/** 刻度标签：短间隔显示 `mm:ss.mmm`，长间隔显示 `mm:ss` */
export function tickLabel(ms: number, spec: TickSpec): string {
  return spec.majorMs < 1000 ? formatTimecode(ms, { showMs: true }) : formatTimecode(ms)
}

// ===========================================================================
// 颜色工具
// ===========================================================================

/** `#rrggbb` + alpha → `rgba(...)`（Canvas 不支持 CSS 变量，颜色只能在 JS 侧拼） */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    const r = parseInt(value.slice(1, 3), 16)
    const g = parseInt(value.slice(3, 5), 16)
    const b = parseInt(value.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
  }
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const r = parseInt(value[1] + value[1], 16)
    const g = parseInt(value[2] + value[2], 16)
    const b = parseInt(value[3] + value[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
  }
  return value
}

/** 从 hex 推一个更暗的描边色（避免再引一个色板常量） */
export function darker(hex: string, factor = 0.72): string {
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    const r = Math.round(parseInt(hex.slice(1, 3), 16) * factor)
    const g = Math.round(parseInt(hex.slice(3, 5), 16) * factor)
    const b = Math.round(parseInt(hex.slice(5, 7), 16) * factor)
    return `rgb(${r}, ${g}, ${b})`
  }
  return hex
}

// ===========================================================================
// peaks 缓存（按 LOD 各一份，长章节按窗口懒加载）
// ===========================================================================

export interface PeaksEntry {
  /** `${source.key}|${lod}|${windowIndex}` */
  key: string
  peaksPerSec: PeaksPerSec
  /** 该窗口起点（源内毫秒）—— 包络索引的基准 */
  fromMs: number
  toMs: number
  peaks: Float32Array
  totalPeaks: number
  at: number
}

/**
 * 每窗口 120 s：一个正常片段（几十秒内）只需一次请求；
 * 超过窗口的长片段（本身会被校验报 long_segment）会按窗口分块绘制。
 */
export const PEAKS_WINDOW_MS = 120_000

/**
 * 缓存上限：48 条窗口 × 每窗最多 120 s × 100 peaks/s = 12000 个 float（48 KB），
 * 最坏约 2.3 MB —— 对 Electron 渲染进程是安全量级；超出按最近最少使用淘汰。
 */
export const PEAKS_CACHE_LIMIT = 48

export interface PeaksStats {
  cached: number
  inflight: number
  failed: number
  pending: number
}

interface TimelineRendererStats {
  /** 上一帧耗时（毫秒）—— 状态条展示，用于自证「拖动 ≥30 fps」 */
  frameMs: number
  itemsDrawn: number
  itemsCulled: number
  lod: PeaksPerSec
  fullRedraw: boolean
}

// ===========================================================================
// 渲染器
// ===========================================================================

export interface TimelineRendererOptions {
  /** 轨道行布局（由组件用 buildLayout 生成；含纵向滚动） */
  layout: () => TimelineLayout
  /** 轨内 items（按时间升序的索引） */
  itemsByTrack: () => ReadonlyMap<TrackId, ArrangementItem[]>
  /** 视口 */
  viewport: () => Viewport
  /** 选中态 */
  selection: () => { selectedIds: readonly Id[]; primaryId: Id | null; auditionId: Id | null }
  /** 重叠冲突 item（画红色斜纹，docs/13 §4.3） */
  conflictIds: () => ReadonlySet<Id>
  /** item 上的行号与文本（docs/13 §4.6：行号 + 文本首 10 字） */
  labelOf: (item: ArrangementItem) => { seq: number | null; text: string }
  /** 片段音频来源（拿不到就只画块不画波形） */
  resolveSource: (item: ArrangementItem) => SegmentSource | null
  playhead: () => number
  loop: () => { startMs: number; endMs: number } | null
  marquee: () => Rect | null
  showGrid: () => boolean
}

export interface TimelineRendererApi {
  /** 绑定画布（null = 解绑） */
  attach: (canvas: HTMLCanvasElement | null) => void
  /** 尺寸/DPR 变化（devicePixelRatio 缩放在这里一次性设好） */
  resize: (widthPx: number, heightPx: number, dpr: number) => void
  /** 静态层失效（视口/轨道/尺寸变化时调用） */
  invalidateStatic: () => void
  /** 请求重绘（可带脏矩形；不传 = 全量重绘） */
  requestDraw: (dirty?: Rect | null) => void
  /** 立即重绘（同步，用于尺寸刚变时避免闪一帧空白） */
  drawNow: (dirty?: Rect | null) => void
  /** 计算「拖动前后」两块的合并脏矩形（交互层用它，见 useTimelineInteraction） */
  dirtyForTimeRange: (input: { fromMs: number; toMs: number; row: TrackRow }) => Rect | null
  /** 当前 LOD（状态条显示） */
  lod: () => PeaksPerSec
  peaksStats: () => PeaksStats
  lastStats: Ref<TimelineRendererStats>
  cancelPending: () => void
  dispose: () => void
}

/**
 * 强调色（网格/播放头/选区/冲突/循环区）：深浅色下都能看清，保持常量。
 *
 * ⚠️ **底色与文字色不在这里** —— 它们必须跟着主题走（见 `canvasColors()`）：
 * 真机反馈「深色模式下有些背景是白的」，时间线画布就是其中一块。
 */
const COLORS = {
  gridMajor: 'rgba(144, 147, 153, 0.28)',
  gridMinor: 'rgba(144, 147, 153, 0.13)',
  playhead: '#f56c6c',
  playheadHandle: '#f56c6c',
  loopBand: 'rgba(64, 158, 255, 0.12)',
  loopEdge: 'rgba(64, 158, 255, 0.6)',
  selection: '#409eff',
  marqueeFill: 'rgba(64, 158, 255, 0.14)',
  marqueeBorder: '#409eff',
  conflict: '#f56c6c',
  textInverse: '#ffffff',
  loading: 'rgba(144, 147, 153, 0.25)',
} as const

/** 画布里的主题相关颜色从 `:root` 取（Canvas 不认 CSS 变量，见 shared/lib/canvas-theme.ts） */
const themeVar = themeColor

/**
 * 画布里的**主题相关**颜色。
 *
 * 为什么每次重绘都取一遍：用户切深浅色后不能等下次 resize 才变 ——
 * 取值很便宜（`getComputedStyle` 一次），换来的是「切主题立刻跟着变」。
 */
export function canvasColors(): {
  background: string
  laneFill: string
  laneAltFill: string
  laneBorder: string
  text: string
  lock: string
} {
  return {
    background: themeVar('--ns-bg-elevated', '#ffffff'),
    laneFill: themeVar('--ns-bg-subtle', '#fbfcfe'),
    laneAltFill: themeVar('--ns-fill-light', '#f6f8fb'),
    laneBorder: themeVar('--ns-border-light', '#e6e9f0'),
    text: themeVar('--ns-text-primary', 'rgba(48, 49, 51, 0.92)'),
    lock: themeVar('--ns-text-secondary', 'rgba(48, 49, 51, 0.55)'),
  }
}

export function useTimelineRenderer(options: TimelineRendererOptions): TimelineRendererApi {
  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let cssWidth = 0
  let cssHeight = 0
  let dpr = 1

  /** 静态层（网格 + 轨道底），只在视口/轨道变化时重建 */
  let staticLayer: HTMLCanvasElement | null = null
  let staticDirty = true

  let frameHandle: number | null = null
  let pendingDirty: Rect | null = null
  let pendingFull = false

  /** 冲突斜纹 pattern（只创建一次） */
  let hatch: CanvasPattern | null = null

  const lastStats = ref<TimelineRendererStats>({
    frameMs: 0,
    itemsDrawn: 0,
    itemsCulled: 0,
    lod: 10,
    fullRedraw: true,
  })

  const peaksCache = new Map<string, PeaksEntry>()
  const peaksInflight = new Set<string>()
  const peaksFailed = new Set<string>()
  let cachedLod: PeaksPerSec = chooseLod(options.viewport().pxPerMs)

  // -------------------------------------------------------------------------
  // peaks 加载
  // -------------------------------------------------------------------------

  function peaksWindowIndex(ms: number): number {
    return Math.floor(Math.max(0, ms) / PEAKS_WINDOW_MS)
  }

  function touchCache(key: string): PeaksEntry | null {
    const entry = peaksCache.get(key)
    if (!entry) return null
    // LRU：删了再塞回去（Map 保序），命中即变最新
    peaksCache.delete(key)
    peaksCache.set(key, entry)
    return entry
  }

  function evictIfNeeded(): void {
    while (peaksCache.size > PEAKS_CACHE_LIMIT) {
      const oldest = peaksCache.keys().next()
      if (oldest.done) break
      peaksCache.delete(oldest.value)
    }
  }

  /**
   * 取某个窗口的 peaks（命中直接返回；否则**入队请求并返回 null**）。
   *
   * 请求语义假设（本次实现发现的契约含糊点）：
   *   `analysis:peaks({ segmentId, peaksPerSec, fromMs, toMs })` 返回的 `peaks` 被视为
   *   **该 fromMs..toMs 窗口内**的包络，`totalPeaks` 是该窗口的峰值个数
   *   （因此包络索引以窗口起点为基准）。若上游实际返回的是「整段的前 N 个」，
   *   包络会整体左移 —— 这是最需要回归确认的一处（写在这里避免下次再猜）。
   */
  function ensurePeaks(source: SegmentSource, lod: PeaksPerSec, windowIndex: number): PeaksEntry | null {
    const key = `${source.key}|${lod}|${windowIndex}`
    const cached = touchCache(key)
    if (cached) return cached
    if (peaksInflight.has(key) || peaksFailed.has(key)) return null

    const fromMs = windowIndex * PEAKS_WINDOW_MS
    const toMs = fromMs + PEAKS_WINDOW_MS
    peaksInflight.add(key)

    void callSafe('analysis:peaks', {
      segmentId: source.segmentId,
      peaksPerSec: lod,
      fromMs,
      toMs,
    }).then((raw) => {
      peaksInflight.delete(key)
      const result = raw as unknown as { peaks: number[]; channels: number; totalPeaks: number } | null
      if (!result || !Array.isArray(result.peaks) || result.peaks.length === 0) {
        // 文件丢失 / 片段不存在：标记失败并**不再重试**（校验报告会以 file_missing 提示），
        // 否则每帧都会重新请求同一个坏片段，把主进程打满。
        peaksFailed.add(key)
        return
      }
      const peaks = Float32Array.from(result.peaks, v => (Number.isFinite(v) ? v : 0))
      peaksCache.set(key, {
        key,
        peaksPerSec: lod,
        fromMs,
        toMs,
        peaks,
        totalPeaks: Number.isFinite(result.totalPeaks) && result.totalPeaks > 0 ? result.totalPeaks : peaks.length,
        at: Date.now(),
      })
      evictIfNeeded()
      // 数据到了：重绘一次把波形补上（每段每档只发生一次，不是每帧）
      requestDraw(null)
    })
    return null
  }

  function peaksStats(): PeaksStats {
    return {
      cached: peaksCache.size,
      inflight: peaksInflight.size,
      failed: peaksFailed.size,
      pending: peaksInflight.size,
    }
  }

  // -------------------------------------------------------------------------
  // 离屏静态层
  // -------------------------------------------------------------------------

  function createStaticLayer(): void {
    if (!(cssWidth > 0) || !(cssHeight > 0)) return
    const layer = staticLayer ?? globalThis.document?.createElement('canvas') ?? null
    if (!layer) return
    layer.width = Math.max(1, Math.round(cssWidth * dpr))
    layer.height = Math.max(1, Math.round(cssHeight * dpr))
    const layerCtx = layer.getContext('2d')
    if (!layerCtx) return
    const theme = canvasColors()
    layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    layerCtx.clearRect(0, 0, cssWidth, cssHeight)
    layerCtx.fillStyle = theme.background
    layerCtx.fillRect(0, 0, cssWidth, cssHeight)

    const layout = options.layout()
    const vp = options.viewport()
    const spec = chooseTickSpec(vp.pxPerMs)

    // 1) 轨道底色（交替底色便于横向对齐视线）
    layout.rows.forEach((row) => {
      if (row.top > cssHeight || row.top + row.height < 0) return
      layerCtx.fillStyle = row.index % 2 === 0 ? theme.laneFill : theme.laneAltFill
      layerCtx.fillRect(0, row.top, cssWidth, row.height)
      layerCtx.strokeStyle = theme.laneBorder
      layerCtx.lineWidth = 1
      layerCtx.beginPath()
      layerCtx.moveTo(0, row.top + row.height + 0.5)
      layerCtx.lineTo(cssWidth, row.top + row.height + 0.5)
      layerCtx.stroke()
    })

    // 2) 时间网格（与刻度尺同源，保证竖线对齐）
    if (options.showGrid()) {
      if (spec.minorMs > 0) {
        layerCtx.strokeStyle = COLORS.gridMinor
        layerCtx.beginPath()
        const from = xToTime(0, vp)
        const to = xToTime(cssWidth, vp)
        for (let t = Math.floor(from / spec.minorMs) * spec.minorMs; t <= to; t += spec.minorMs) {
          if (t < 0) continue
          const x = Math.round(timeToX(t, vp)) + 0.5
          layerCtx.moveTo(x, 0)
          layerCtx.lineTo(x, cssHeight)
        }
        layerCtx.stroke()
      }
      layerCtx.strokeStyle = COLORS.gridMajor
      layerCtx.beginPath()
      for (const t of majorTickTimes(vp, cssWidth, spec)) {
        const x = Math.round(timeToX(t, vp)) + 0.5
        layerCtx.moveTo(x, 0)
        layerCtx.lineTo(x, cssHeight)
      }
      layerCtx.stroke()
    }

    staticLayer = layer
    staticDirty = false
  }

  function ensureHatch(): CanvasPattern | null {
    if (hatch) return hatch
    const doc = globalThis.document
    if (!doc || !ctx) return null
    const tile = doc.createElement('canvas')
    tile.width = 8
    tile.height = 8
    const tileCtx = tile.getContext('2d')
    if (!tileCtx) return null
    tileCtx.strokeStyle = withAlpha(COLORS.conflict, 0.75)
    tileCtx.lineWidth = 2
    tileCtx.beginPath()
    tileCtx.moveTo(-2, 10)
    tileCtx.lineTo(10, -2)
    tileCtx.moveTo(2, 14)
    tileCtx.lineTo(14, 2)
    tileCtx.stroke()
    hatch = ctx.createPattern(tile, 'repeat')
    return hatch
  }

  // -------------------------------------------------------------------------
  // 片段绘制
  // -------------------------------------------------------------------------

  /** 圆角矩形路径（`roundRect` 已在新版 Chromium 可用，这里仍给出等价回退） */
  function roundRectPath(target: CanvasRenderingContext2D, rect: Rect, radius: number): void {
    const r = Math.max(0, Math.min(radius, rect.w / 2, rect.h / 2))
    target.beginPath()
    if (typeof target.roundRect === 'function') {
      target.roundRect(rect.x, rect.y, rect.w, rect.h, r)
      return
    }
    target.moveTo(rect.x + r, rect.y)
    target.lineTo(rect.x + rect.w - r, rect.y)
    target.quadraticCurveTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r)
    target.lineTo(rect.x + rect.w, rect.y + rect.h - r)
    target.quadraticCurveTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h)
    target.lineTo(rect.x + r, rect.y + rect.h)
    target.quadraticCurveTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r)
    target.lineTo(rect.x, rect.y + r)
    target.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y)
    target.closePath()
  }

  /** 波形包络（LOD 由 chooseLod 决定；数据按窗口懒加载） */
  function drawEnvelope(
    target: CanvasRenderingContext2D,
    item: ArrangementItem,
    rect: Rect,
    vp: Viewport,
    lod: PeaksPerSec,
    source: SegmentSource,
  ): void {
    const content = contentRectOf(item, rect, vp)
    if (!(content.w > 2) || rect.h < 12 || !(vp.pxPerMs > 0)) return

    const midY = rect.y + rect.h / 2
    const half = Math.max(2, rect.h / 2 - 3)
    const firstWindow = peaksWindowIndex(item.srcInMs)
    const lastWindow = peaksWindowIndex(Math.max(item.srcInMs, item.srcOutMs - 1))

    target.save()
    target.beginPath()
    target.rect(content.x, rect.y, content.w, rect.h)
    target.clip()

    for (let windowIndex = firstWindow; windowIndex <= lastWindow; windowIndex++) {
      const windowFrom = windowIndex * PEAKS_WINDOW_MS
      const segFrom = Math.max(item.srcInMs, windowFrom)
      const segTo = Math.min(item.srcOutMs, windowFrom + PEAKS_WINDOW_MS)
      if (segTo <= segFrom) continue

      const entry = ensurePeaks(source, lod, windowIndex)
      if (!entry) continue

      // 该窗口在屏幕上的 x 区间（源内时间 → 屏幕像素）
      const x1 = content.x + (segFrom - item.srcInMs) * vp.pxPerMs
      const x2 = content.x + (segTo - item.srcInMs) * vp.pxPerMs
      const xStart = Math.max(content.x, 0)
      const xEnd = Math.min(content.x + content.w, cssWidth)
      if (x2 < xStart || x1 > xEnd) continue // 视口外剔除

      // 源内坐标视口：x = content.x 对应该 item 的 srcInMs；索引基准是窗口起点
      const sourceVp: Viewport = {
        pxPerMs: vp.pxPerMs,
        scrollMs: (item.srcInMs - entry.fromMs) - content.x / vp.pxPerMs,
      }
      const range = peaksIndexRange(segFrom - entry.fromMs, segTo - entry.fromMs, lod, entry.totalPeaks)
      if (range.from < 0 || range.to < range.from) continue

      const bucketMs = peaksBucketMs(lod)
      const columns = buildEnvelope({
        peaks: entry.peaks,
        fromIndex: range.from,
        toIndex: Math.min(range.to, entry.peaks.length - 1),
        viewport: sourceVp,
        xStartPx: xStart,
        xEndPx: xEnd,
        bucketMs,
      })
      if (!columns.length) continue

      target.beginPath()
      // 上半：从左到右取 max；下半：从右到左取 min —— 一条闭合路径一次填充
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i] as (typeof columns)[number]
        const y = amplitudeToY(col.max, midY, half)
        if (i === 0) target.moveTo(col.x, y)
        else target.lineTo(col.x, y)
      }
      for (let i = columns.length - 1; i >= 0; i--) {
        const col = columns[i] as (typeof columns)[number]
        target.lineTo(col.x, amplitudeToY(col.min, midY, half))
      }
      target.closePath()
      target.fillStyle = withAlpha('#1f2d3d', 0.55)
      target.fill()
    }
    target.restore()
  }

  /** 淡入淡出三角（视觉提示，docs/13 §4.6） */
  function drawFades(target: CanvasRenderingContext2D, item: ArrangementItem, rect: Rect, vp: Viewport): void {
    const fadeInPx = Math.min(rect.w / 2, durationToWidth(Math.max(0, item.fadeInMs), vp))
    const fadeOutPx = Math.min(rect.w / 2, durationToWidth(Math.max(0, item.fadeOutMs), vp))
    target.fillStyle = 'rgba(255, 255, 255, 0.55)'
    if (fadeInPx > 1.5) {
      target.beginPath()
      target.moveTo(rect.x, rect.y)
      target.lineTo(rect.x + fadeInPx, rect.y)
      target.lineTo(rect.x, rect.y + rect.h)
      target.closePath()
      target.fill()
    }
    if (fadeOutPx > 1.5) {
      target.beginPath()
      target.moveTo(rect.x + rect.w, rect.y)
      target.lineTo(rect.x + rect.w - fadeOutPx, rect.y)
      target.lineTo(rect.x + rect.w, rect.y + rect.h)
      target.closePath()
      target.fill()
    }
  }

  /** 锁定图标（小挂锁：一眼能看出「自动排布不会动它」） */
  function drawLock(target: CanvasRenderingContext2D, rect: Rect): void {
    const size = Math.min(9, rect.h / 3)
    if (size < 4) return
    const x = rect.x + rect.w - size - 4
    const y = rect.y + 4
    target.fillStyle = canvasColors().lock
    target.fillRect(x, y + size * 0.45, size, size * 0.6)
    target.strokeStyle = canvasColors().lock
    target.lineWidth = 1.2
    target.beginPath()
    target.arc(x + size / 2, y + size * 0.45, size * 0.3, Math.PI, 0)
    target.stroke()
  }

  function drawItem(
    target: CanvasRenderingContext2D,
    item: ArrangementItem,
    row: TrackRow,
    vp: Viewport,
    lod: PeaksPerSec,
    selection: { selectedIds: readonly Id[]; primaryId: Id | null; auditionId: Id | null },
    conflict: boolean,
  ): void {
    const rect = itemRect(item, row, vp)
    const color = row.color

    // 块体：未锁定时略透，锁定时更实（人工确认过的位置看起来「更硬」）
    target.fillStyle = withAlpha(color, item.locked ? 0.42 : 0.28)
    roundRectPath(target, rect, Math.min(4, rect.h / 3))
    target.fill()

    // 波形包络（拿不到片段文件时不画，绝不画假波形）
    const source = options.resolveSource(item)
    if (source && rect.h >= 12 && rect.w >= 6) drawEnvelope(target, item, rect, vp, lod, source)
    else if (rect.h >= 12 && rect.w >= 6) {
      // 无音频数据：画一条浅色基线，明确区别于「有波形但很安静」
      target.strokeStyle = COLORS.loading
      target.lineWidth = 1
      target.beginPath()
      target.moveTo(rect.x + 2, rect.y + rect.h / 2)
      target.lineTo(rect.x + rect.w - 2, rect.y + rect.h / 2)
      target.stroke()
    }

    drawFades(target, item, rect, vp)

    // 边框
    target.strokeStyle = darker(color, 0.7)
    target.lineWidth = 1
    roundRectPath(target, rect, Math.min(4, rect.h / 3))
    target.stroke()

    // 冲突：红色斜纹（docs/13 §4.3「重叠冲突红色斜纹」）
    if (conflict) {
      const pattern = ensureHatch()
      if (pattern) {
        target.save()
        roundRectPath(target, rect, Math.min(4, rect.h / 3))
        target.clip()
        target.fillStyle = pattern
        target.fillRect(rect.x, rect.y, rect.w, rect.h)
        target.restore()
      }
      target.strokeStyle = COLORS.conflict
      target.lineWidth = 1.5
      roundRectPath(target, rect, Math.min(4, rect.h / 3))
      target.stroke()
    }

    // 行号 + 文本前 10 字（docs/13 §4.6「画本行对照」）
    if (rect.w >= 42 && rect.h >= 22) {
      const label = options.labelOf(item)
      const text = label.seq === null ? label.text : `${label.seq} ${label.text}`
      if (text) {
        target.save()
        target.beginPath()
        target.rect(rect.x + 3, rect.y, Math.max(0, rect.w - 6), rect.h)
        target.clip()
        target.fillStyle = canvasColors().text
        target.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
        target.textBaseline = 'top'
        target.fillText(text, rect.x + 4, rect.y + (rect.h >= 34 ? 3 : Math.max(2, rect.h / 2 - 7)))
        target.restore()
      }
    }

    if (item.locked) drawLock(target, rect)

    // 选中 / 试听中的描边
    if (selection.selectedIds.includes(item.id)) {
      target.save()
      target.strokeStyle = COLORS.selection
      target.lineWidth = selection.primaryId === item.id ? 2 : 1.5
      target.setLineDash(selection.auditionId === item.id ? [4, 3] : [])
      roundRectPath(target, { x: rect.x - 1, y: rect.y - 1, w: rect.w + 2, h: rect.h + 2 }, Math.min(5, rect.h / 3))
      target.stroke()
      target.restore()
    } else if (selection.auditionId === item.id) {
      target.save()
      target.strokeStyle = COLORS.selection
      target.setLineDash([4, 3])
      target.lineWidth = 1.5
      roundRectPath(target, rect, Math.min(4, rect.h / 3))
      target.stroke()
      target.restore()
    }
  }

  // -------------------------------------------------------------------------
  // 主绘制
  // -------------------------------------------------------------------------

  function drawFrame(dirty: Rect | null): void {
    if (!ctx || !(cssWidth > 0) || !(cssHeight > 0)) return
    const startedAt = performance.now()
    const bounds: Rect = { x: 0, y: 0, w: cssWidth, h: cssHeight }
    const region = dirty ? clipRect(dirty, bounds) : bounds
    if (!region || region.w <= 0 || region.h <= 0) return

    if (staticDirty) createStaticLayer()

    const vp = options.viewport()
    const layout = options.layout()
    const selection = options.selection()
    const conflicts = options.conflictIds()

    // LOD 切换带迟滞，避免在临界缩放点抖动（shouldSwitchLod 的 hysteresis）
    const ideal = chooseLod(vp.pxPerMs)
    if (ideal !== cachedLod && shouldSwitchLod(cachedLod, vp.pxPerMs)) cachedLod = ideal
    const lod = cachedLod

    ctx.save()
    ctx.beginPath()
    ctx.rect(region.x, region.y, region.w, region.h)
    ctx.clip()

    // 1) 背景：优先贴离屏静态层（一次 drawImage），静态层不可用时退回纯色
    if (staticLayer) {
      ctx.drawImage(
        staticLayer,
        Math.round(region.x * dpr), Math.round(region.y * dpr), Math.round(region.w * dpr), Math.round(region.h * dpr),
        region.x, region.y, region.w, region.h,
      )
    } else {
      ctx.fillStyle = canvasColors().background
      ctx.fillRect(region.x, region.y, region.w, region.h)
    }

    // 脏区对应的时间范围：拖动时靠它把 99% 的 item 剔除掉（docs/13 §4.6）
    const dirtyFromMs = xToTime(region.x, vp)
    const dirtyToMs = xToTime(region.x + region.w, vp)

    // 2) 循环区间（在 items 下面，避免盖住片段）
    const loop = options.loop()
    if (loop) {
      const x1 = timeToX(loop.startMs, vp)
      const x2 = timeToX(loop.endMs, vp)
      if (x2 >= 0 && x1 <= cssWidth) {
        ctx.fillStyle = COLORS.loopBand
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), cssHeight)
        ctx.strokeStyle = COLORS.loopEdge
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x1 + 0.5, 0)
        ctx.lineTo(x1 + 0.5, cssHeight)
        ctx.moveTo(x2 - 0.5, 0)
        ctx.lineTo(x2 - 0.5, cssHeight)
        ctx.stroke()
      }
    }

    // 3) 片段（逐轨、逐 item；两级剔除：视口 → 脏区）
    let drawn = 0
    let culled = 0
    const byTrack = options.itemsByTrack()
    for (const row of layout.rows) {
      if (row.top > region.y + region.h || row.top + row.height < region.y) {
        // 整行不在脏区垂直范围内：只需统计剔除数，不进入 item 循环
        culled += byTrack.get(row.trackId)?.length ?? 0
        continue
      }
      const list = byTrack.get(row.trackId)
      if (!list || !list.length) continue

      // 轨内按 timelineStartMs 有序 ⇒ 二分找到第一个起点进入脏区的 item，再向后扫描（docs/05 §11.4）
      let index = Math.max(0, lowerBoundByStart(list, dirtyFromMs) - 8)
      for (; index < list.length; index++) {
        const item = list[index] as ArrangementItem
        if (item.timelineStartMs > dirtyToMs) break
        const end = item.timelineStartMs + itemDurationMs(item)
        // 两级剔除：视口（isTimeRangeVisible）+ 脏区（起点已过脏区右界 / 终点在脏区左界之前）
        if (!isTimeRangeVisible(item.timelineStartMs, end, cssWidth, vp) || end < dirtyFromMs) {
          culled += 1
          continue
        }
        drawItem(ctx, item, row, vp, lod, selection, conflicts.has(item.id))
        drawn += 1
      }
    }

    // 4) 框选矩形（交互层持有；这里只负责画）
    const marquee = options.marquee()
    if (marquee && marquee.w > 0 && marquee.h > 0) {
      ctx.fillStyle = COLORS.marqueeFill
      ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h)
      ctx.strokeStyle = COLORS.marqueeBorder
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.strokeRect(marquee.x + 0.5, marquee.y + 0.5, marquee.w, marquee.h)
      ctx.setLineDash([])
    }

    // 5) 播放头（最上层）
    const playheadX = timeToX(options.playhead(), vp)
    if (playheadX >= region.x - 2 && playheadX <= region.x + region.w + 2) {
      ctx.strokeStyle = COLORS.playhead
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(playheadX) + 0.5, 0)
      ctx.lineTo(Math.round(playheadX) + 0.5, cssHeight)
      ctx.stroke()
      ctx.fillStyle = COLORS.playheadHandle
      ctx.beginPath()
      ctx.moveTo(playheadX - 5, 0)
      ctx.lineTo(playheadX + 5, 0)
      ctx.lineTo(playheadX, 7)
      ctx.closePath()
      ctx.fill()
    }

    ctx.restore()

    lastStats.value = {
      frameMs: Math.round((performance.now() - startedAt) * 100) / 100,
      itemsDrawn: drawn,
      itemsCulled: culled,
      lod,
      fullRedraw: dirty === null,
    }
  }

  // -------------------------------------------------------------------------
  // 重绘调度
  // -------------------------------------------------------------------------

  function flush(): void {
    frameHandle = null
    const dirty = pendingFull ? null : pendingDirty
    pendingDirty = null
    pendingFull = false
    drawFrame(dirty)
  }

  function requestDraw(dirty?: Rect | null): void {
    if (dirty === undefined || dirty === null) {
      pendingFull = true
      pendingDirty = null
    } else if (!pendingFull) {
      pendingDirty = pendingDirty ? unionRect(pendingDirty, dirty) : dirty
    }
    if (frameHandle !== null) return
    const raf = globalThis.requestAnimationFrame
    if (typeof raf !== 'function') {
      flush()
      return
    }
    frameHandle = raf(() => flush())
  }

  function drawNow(dirty?: Rect | null): void {
    cancelPending()
    drawFrame(dirty ?? null)
  }

  function cancelPending(): void {
    if (frameHandle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(frameHandle)
    }
    frameHandle = null
    pendingDirty = null
    pendingFull = false
  }

  /**
   * 「旧位置 ∪ 新位置」的脏矩形。
   * 这是拖动时的核心：只重绘两块区域，而不是整个画布（docs/13 §4.6）。
   */
  function dirtyForTimeRange(input: { fromMs: number; toMs: number; row: TrackRow }): Rect | null {
    const vp = options.viewport()
    const bounds: Rect = { x: 0, y: 0, w: cssWidth, h: cssHeight }
    const x1 = timeToX(Math.min(input.fromMs, input.toMs), vp)
    const x2 = timeToX(Math.max(input.fromMs, input.toMs), vp)
    const rect: Rect = {
      x: Math.min(x1, x2),
      y: input.row.top - 1,
      w: Math.max(1, Math.abs(x2 - x1)),
      h: input.row.height + 2,
    }
    return clipRect(rect, bounds)
  }

  function attach(next: HTMLCanvasElement | null): void {
    canvas = next
    ctx = next ? next.getContext('2d', { alpha: false }) : null
    if (!ctx) return
    // 保证 devicePixelRatio 缩放只在一处设置（所有绘制都用 CSS 像素坐标）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    staticDirty = true
  }

  function resize(widthPx: number, heightPx: number, nextDpr: number): void {
    const w = Math.max(1, Math.round(widthPx))
    const h = Math.max(1, Math.round(heightPx))
    const scale = Number.isFinite(nextDpr) && nextDpr > 0 ? nextDpr : 1
    if (w === cssWidth && h === cssHeight && scale === dpr) return
    cssWidth = w
    cssHeight = h
    dpr = scale
    if (canvas) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    staticLayer = null
    staticDirty = true
    peaksFailed.clear() // 尺寸变化通常伴随重建，允许重新尝试（避免一次瞬时失败永久留白）
    drawNow(null)
  }

  function invalidateStatic(): void {
    staticDirty = true
    requestDraw(null)
  }

  function lod(): PeaksPerSec {
    return cachedLod
  }

  function dispose(): void {
    cancelPending()
    peaksCache.clear()
    peaksInflight.clear()
    peaksFailed.clear()
    staticLayer = null
    canvas = null
    ctx = null
    hatch = null
  }

  onScopeDispose(dispose)

  /**
   * 深浅色切换后重建静态层（底色画在静态层里）。
   *
   * 不做这一步的表现：用户切到深色主题后，时间线画布仍是白底 ——
   * 真机反馈「深色模式下有些背景是白的」里就有它。
   */
  if (typeof watch === 'function') {
    const ui = useUiStore()
    watch(() => ui.theme, () => invalidateStatic())
  }
  return {
    attach,
    resize,
    invalidateStatic,
    requestDraw,
    drawNow,
    dirtyForTimeRange,
    lod,
    peaksStats,
    lastStats,
    cancelPending,
    dispose,
  }
}

/** 便捷类型：组件里保存布局的引用（每帧读，浅引用即可） */
export type TimelineLayoutRef = Ref<TimelineLayout>
