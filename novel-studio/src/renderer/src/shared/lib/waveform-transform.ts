/**
 * Novel Studio · 波形绘制坐标换算（纯逻辑，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/13 §4.5/§4.6 —— 时间线：横向缩放（整章总览 ↔ 样本级）、波形 LOD 3 级
 *     （100/10/1 peaks/s）、拖动 1000 个 item 时 ≥ 30 fps（脏矩形重绘）
 *   · docs/05 §11.3/§11.4 —— 波形绘制与命中检测
 *   · docs/12 §10 —— 录音页实时波形（环形缓冲 + rAF）
 *
 * 坐标约定（全渲染进程统一，别的模块不要自创）：
 *   · 时间轴上的「时间」单位是**毫秒**，与领域模型一致（timelineStartMs / srcInMs）；
 *   · `pxPerMs`（每毫秒像素数）是唯一的缩放量，横向缩放只改它；
 *   · `scrollMs` 是视口左边缘对应的时间（不是滚动像素），这样缩放时滚动位置不用重算。
 *
 * 本文件全部是纯函数，可被 `node --experimental-strip-types` 直接跑单测
 * （见 tests/renderer/waveform-transform.test.ts）。
 */

// ---------------------------------------------------------------------------
// 视口与基本换算
// ---------------------------------------------------------------------------

export interface Viewport {
  /** 缩放：每毫秒多少像素 */
  pxPerMs: number
  /** 视口左边缘对应的时间（毫秒） */
  scrollMs: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 时间 → 像素（相对视口左边缘） */
export function timeToX(ms: number, vp: Viewport): number {
  return (ms - vp.scrollMs) * vp.pxPerMs
}

/** 像素 → 时间；timeToX 的逆运算（同一 Viewport 下应满足 xToTime(timeToX(t)) === t） */
export function xToTime(x: number, vp: Viewport): number {
  return vp.scrollMs + x / vp.pxPerMs
}

/** 时长（毫秒）→ 像素宽度 */
export function durationToWidth(ms: number, vp: Viewport): number {
  return ms * vp.pxPerMs
}

/** 视口宽度能覆盖多少毫秒 */
export function viewportDurationMs(viewportWidthPx: number, vp: Viewport): number {
  if (!(vp.pxPerMs > 0)) return 0
  return Math.max(0, viewportWidthPx) / vp.pxPerMs
}

/** 视口右边缘时间（含） */
export function viewportEndMs(viewportWidthPx: number, vp: Viewport): number {
  return vp.scrollMs + viewportDurationMs(viewportWidthPx, vp)
}

/** 把时间约束在 [0, durationMs]（拖动播放头/片段时必用） */
export function clampTime(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0
  const max = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  return Math.min(Math.max(0, ms), max)
}

/** 时间区间是否与视口相交（item 裁剪/剔除用） */
export function isTimeRangeVisible(fromMs: number, toMs: number, viewportWidthPx: number, vp: Viewport): boolean {
  const left = Math.min(fromMs, toMs)
  const right = Math.max(fromMs, toMs)
  return right >= vp.scrollMs && left <= viewportEndMs(viewportWidthPx, vp)
}

/**
 * 以某个时间为中心缩放（滚轮缩放）。
 * 语义：`anchorMs` 对应的像素位置在缩放前后保持不变 —— 否则用户的缩放体验会「往外跑」。
 */
export function zoomAround(
  vp: Viewport,
  factor: number,
  anchorMs: number,
  limits: { minPxPerMs: number; maxPxPerMs: number },
): Viewport {
  const next = Math.min(limits.maxPxPerMs, Math.max(limits.minPxPerMs, vp.pxPerMs * factor))
  const anchorX = timeToX(anchorMs, vp)
  return { pxPerMs: next, scrollMs: anchorMs - anchorX / next }
}

// ---------------------------------------------------------------------------
// 波形 LOD（docs/13 §4.6：3 级 100/10/1 peaks/s）
// ---------------------------------------------------------------------------

export type PeaksPerSec = 1 | 10 | 100

/** 可选 LOD 档位，从粗到细 */
export const LOD_LEVELS: readonly PeaksPerSec[] = [1, 10, 100] as const

/** 每个 peak 至少要占多少像素才值得用该档（低于它就该降级） */
export const MIN_PX_PER_PEAK = 0.5

/**
 * 按缩放级别自动选择 LOD。
 * 规则：取「每 peak 像素数 ≥ MIN_PX_PER_PEAK」的最细档位，都不满足时取最粗档（1 peaks/s）。
 *   · 整章总览（0.0005 px/ms ≈ 0.5 px/s）→ 1 peaks/s
 *   · 常规编辑（0.02 px/ms = 20 px/s）   → 10 peaks/s
 *   · 样本级（0.2 px/ms = 200 px/s）     → 100 peaks/s
 */
export function chooseLod(pxPerMs: number, levels: readonly PeaksPerSec[] = LOD_LEVELS): PeaksPerSec {
  if (!(pxPerMs > 0)) return levels[0] ?? 1
  const pxPerSec = pxPerMs * 1000
  let picked: PeaksPerSec = levels[0] ?? 1
  for (const level of levels) {
    if (pxPerSec / level >= MIN_PX_PER_PEAK) picked = level
  }
  return picked
}

/** 相邻两档之间是否应切换（避免在临界点反复抖动；组件里做迟滞用） */
export function shouldSwitchLod(current: PeaksPerSec, pxPerMs: number, hysteresis = 0.15): boolean {
  const ideal = chooseLod(pxPerMs)
  if (ideal === current) return false
  const idealPxPerPeak = (pxPerMs * 1000) / ideal
  return Math.abs(1 - idealPxPerPeak / MIN_PX_PER_PEAK) > hysteresis
}

// ---------------------------------------------------------------------------
// peaks 索引映射
// ---------------------------------------------------------------------------

/**
 * 时间 → peaks 数组下标（向下取整，越界收敛）。
 * 返回值恒在 [0, totalPeaks - 1]；totalPeaks ≤ 0 时返回 -1（调用方据此跳过绘制）。
 */
export function peaksIndexAtTime(ms: number, peaksPerSec: number, totalPeaks: number): number {
  if (!(peaksPerSec > 0) || !(totalPeaks > 0)) return -1
  const idx = Math.floor((Number.isFinite(ms) ? ms : 0) / 1000 * peaksPerSec)
  return Math.min(totalPeaks - 1, Math.max(0, idx))
}

/** peaks 下标 → 该 peak 代表的起始时间（毫秒） */
export function timeAtPeaksIndex(index: number, peaksPerSec: number): number {
  if (!(peaksPerSec > 0)) return 0
  return (Math.max(0, Math.floor(index)) / peaksPerSec) * 1000
}

/** peaks 下标 → 该 peak 覆盖的时长（毫秒） */
export function peaksBucketMs(peaksPerSec: number): number {
  return peaksPerSec > 0 ? 1000 / peaksPerSec : 0
}

export interface PeaksRange {
  /** 起始下标（含），无数据时为 -1 */
  from: number
  /** 结束下标（含），无数据时为 -1 */
  to: number
  /** 实际取用的数量 */
  count: number
}

/**
 * 时间区间 → peaks 下标区间（**闭区间**）。
 * 语义：
 *   · 完全落在数据之外 → `{ from: -1, to: -1, count: 0 }`；
 *   · 区间两端越界会被裁剪到 [0, totalPeaks-1]（绘制时不会读到 undefined）；
 *   · from/to 两端都保留（含端点），因为绘制的是 min/max 包络，少一个 bucket 会看到缺口。
 */
export function peaksIndexRange(
  fromMs: number,
  toMs: number,
  peaksPerSec: number,
  totalPeaks: number,
): PeaksRange {
  if (!(peaksPerSec > 0) || !(totalPeaks > 0)) return { from: -1, to: -1, count: 0 }
  const left = Math.min(fromMs, toMs)
  const right = Math.max(fromMs, toMs)

  const bucket = peaksBucketMs(peaksPerSec)
  const lastStartMs = (totalPeaks - 1) * bucket
  if (right < 0) return { from: -1, to: -1, count: 0 }
  if (left > lastStartMs + bucket) return { from: -1, to: -1, count: 0 }

  const from = peaksIndexAtTime(Math.max(0, left), peaksPerSec, totalPeaks)
  const to = peaksIndexAtTime(Math.max(0, right), peaksPerSec, totalPeaks)
  return { from, to, count: to >= from ? to - from + 1 : 0 }
}

/**
 * 当前视口需要绘制哪些 peaks（含左右 overscan 像素）。
 * 组件把结果直接喂给 peaks 数组切片即可。
 */
export function computeVisiblePeaks(input: {
  viewport: Viewport
  /** 视口像素宽度 */
  viewportWidth: number
  peaksPerSec: number
  totalPeaks: number
  /** 左右各多取多少像素（默认 64，快速平移时不露白） */
  overscanPx?: number
}): PeaksRange {
  const overscanPx = Math.max(0, input.overscanPx ?? 64)
  const fromMs = xToTime(-overscanPx, input.viewport)
  const toMs = xToTime(input.viewportWidth + overscanPx, input.viewport)
  return peaksIndexRange(fromMs, toMs, input.peaksPerSec, input.totalPeaks)
}

// ---------------------------------------------------------------------------
// 脏矩形（docs/13 §4.6：拖动时只重绘脏区）
// ---------------------------------------------------------------------------

/** 两个矩形是否相交（触碰不算相交，避免多算一次重绘） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** 交集；不相交返回 null */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (right <= x || bottom <= y) return null
  return { x, y, w: right - x, h: bottom - y }
}

/** 把矩形裁剪到边界内；完全在外返回 null */
export function clipRect(rect: Rect, bounds: Rect): Rect | null {
  return intersectRect(rect, bounds)
}

/** 合并两个矩形的最小外接矩形 */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: right - x, h: bottom - y }
}

/** 扩张矩形（描边宽度、光晕、选中框都需要留边） */
export function expandRect(rect: Rect, pad: number): Rect {
  const p = Math.max(0, pad)
  return { x: rect.x - p, y: rect.y - p, w: rect.w + p * 2, h: rect.h + p * 2 }
}

/** 归一化：负宽高换成正的（pointer 拖动会有反向拖） */
export function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.w < 0 ? rect.x + rect.w : rect.x,
    y: rect.h < 0 ? rect.y + rect.h : rect.y,
    w: Math.abs(rect.w),
    h: Math.abs(rect.h),
  }
}

/**
 * 计算需要重绘的区域，并保证**不越出画布边界**（越界会让 Canvas 白画一遍还变大）。
 *   · 两次区域相同（或几乎相同，浮点抖动）→ 返回 null，表示可以不重绘；
 *   · `bounds` 传入画布矩形；裁剪后为空 → 返回 null。
 */
export function computeDirtyRect(prev: Rect | null, next: Rect | null, bounds: Rect, pad = 2): Rect | null {
  if (!next) return null
  if (prev && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5
    && Math.abs(prev.w - next.w) < 0.5 && Math.abs(prev.h - next.h) < 0.5) {
    return null
  }
  const merged = prev ? unionRect(prev, next) ?? next : next
  return clipRect(expandRect(normalizeRect(merged), pad), bounds)
}

/**
 * 时间区间 → 屏幕上要重绘的矩形（对轨拖动 item、录音实时波形都走这里）。
 * 返回 null 表示该区间不在视口内，无需重绘。
 */
export function timeRangeToDirtyRect(input: {
  fromMs: number
  toMs: number
  viewport: Viewport
  /** 垂直范围（轨道的 y 与高度） */
  y: number
  h: number
  bounds: Rect
  pad?: number
}): Rect | null {
  const x1 = timeToX(Math.min(input.fromMs, input.toMs), input.viewport)
  const x2 = timeToX(Math.max(input.fromMs, input.toMs), input.viewport)
  const rect = normalizeRect({ x: x1, y: input.y, w: x2 - x1, h: input.h })
  return clipRect(expandRect(rect, input.pad ?? 2), input.bounds)
}

// ---------------------------------------------------------------------------
// 包络绘制辅助（min/max 抽取）
// ---------------------------------------------------------------------------

export interface EnvelopeColumn {
  /** 列中心像素（相对视口） */
  x: number
  /** 该列包含的 peaks 下标范围（闭区间） */
  fromIndex: number
  toIndex: number
  min: number
  max: number
}

/**
 * 把一个 peaks 区间压缩成「每像素列一个 min/max」的包络。
 * 这是波形绘制的核心：像素比 peaks 稀疏时一列要吃掉多个 peak，必须取极值而不是抽样，
 * 否则会漏掉瞬态（鼓点、爆破音）。
 *
 * `peaks` 取值为 [-1, 1] 的归一化幅度（与主进程 `analysis:peaks` 口径一致）。
 */
export function buildEnvelope(input: {
  peaks: ArrayLike<number>
  fromIndex: number
  toIndex: number
  viewport: Viewport
  /** 绘制区左右像素边界（相对视口） */
  xStartPx: number
  xEndPx: number
  /** 每个峰值在源数据中占用的时间（毫秒） */
  bucketMs: number
}): EnvelopeColumn[] {
  const { peaks, fromIndex, toIndex, viewport, bucketMs } = input
  if (toIndex < fromIndex || fromIndex < 0 || bucketMs <= 0 || !(viewport.pxPerMs > 0)) return []

  const xStart = Math.min(input.xStartPx, input.xEndPx)
  const xEnd = Math.max(input.xStartPx, input.xEndPx)
  const columns: EnvelopeColumn[] = []

  for (let x = Math.floor(xStart); x <= Math.ceil(xEnd); x++) {
    const colFromMs = xToTime(x, viewport)
    const colToMs = xToTime(x + 1, viewport)
    const i0 = Math.max(fromIndex, Math.floor(colFromMs / bucketMs))
    const i1 = Math.min(toIndex, Math.ceil(colToMs / bucketMs) - 1)
    if (i1 < i0) continue

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let i = i0; i <= i1; i++) {
      const v = Number(peaks[i] ?? 0)
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue
    columns.push({ x, fromIndex: i0, toIndex: i1, min, max })
  }

  return columns
}

/** 幅度（-1~1）→ 垂直像素：以 `midY` 为零线，`halfHeight` 为满幅 */
export function amplitudeToY(amp: number, midY: number, halfHeight: number): number {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(amp) ? amp : 0))
  return midY - clamped * halfHeight
}

/** dBFS → 归一化幅度（0 dBFS = 1.0）；低于 -120 dB 视为静音，避免出现 Infinity */
export function dbfsToAmplitude(db: number): number {
  if (!Number.isFinite(db) || db <= -120) return 0
  return Math.min(1, Math.pow(10, db / 20))
}

/** 归一化幅度 → dBFS；0 → -Infinity（UI 用 format.formatDb 显示成 `-∞ dB`） */
export function amplitudeToDbfs(amp: number): number {
  const a = Math.abs(amp)
  if (!(a > 0)) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(Math.min(1, a))
}

/**
 * 缩放到适配：把整章时长铺满给定像素宽度。
 * 打开章节时用它得到初始 `pxPerMs`，并保证不会因为极短/极长章节算出 0 或 Infinity。
 */
export function fitPxPerMs(durationMs: number, widthPx: number, limits: { minPxPerMs: number; maxPxPerMs: number }): number {
  if (!(durationMs > 0) || !(widthPx > 0)) return limits.minPxPerMs
  const ideal = widthPx / durationMs
  return Math.min(limits.maxPxPerMs, Math.max(limits.minPxPerMs, ideal))
}

/** 时间线缩放范围（docs/13 §4.6：整章总览 ↔ 样本级 ~1 ms/px） */
export const TIMELINE_ZOOM_LIMITS = {
  /** 1 ms/px 的倒数：0.001 px/ms */
  minPxPerMs: 0.0002,
  maxPxPerMs: 2,
} as const

/** 一段音频折叠成的 min/max 列（波形显示的原始数据，不含像素信息） */
export interface ColumnEnvelope {
  min: number
  max: number
}

/**
 * `analysis:peaks` 的载荷 → min/max 列。
 *
 * 契约（`src/shared/ipc.ts` 的 `analysis:peaks`）：`peaks` 是 **min/max 交替、
 * 按 int16/32767 归一化到 [-1,1]** 的数组，`totalPeaks` = 桶数 = `peaks.length / 2`。
 *
 * 越界值夹到 [-1,1]：理论上主进程不会给出越界值，但截断/异常数据不该让画布
 * 画出屏幕外的柱子（`amplitudeToY` 只在 [-1,1] 上有定义）。
 */
export function peakPairsToEnvelope(peaks: ArrayLike<number>): ColumnEnvelope[] {
  const buckets = Math.floor((peaks?.length ?? 0) / 2)
  const out: ColumnEnvelope[] = []
  for (let b = 0; b < buckets; b++) {
    const min = Math.max(-1, Math.min(1, peaks[b * 2] ?? 0))
    const max = Math.max(-1, Math.min(1, peaks[b * 2 + 1] ?? 0))
    out.push({ min, max })
  }
  return out
}
