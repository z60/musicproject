/**
 * 对轨域 · 时间线交互（命中检测 + 拖动状态机 + 吸附）
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md
 *   · §9 交互层：Canvas 上的 pointer 事件 + 状态机
 *        （idle / dragging / resizing / panning / selecting）
 *   · §9 命中检测：**按轨道行分组（先按 y 判断轨道），轨内按 timelineStartMs 二分查找**；
 *        边缘把手命中区 ≥ 6px
 *   · §4.6 滚轮：`Ctrl+滚轮` 以鼠标为锚点缩放、`Shift+滚轮` 平移、纵向滚动轨道区；
 *        `Space` 播放/暂停；点击空白定位播放头；**框选区间循环播放**
 *   · §4.7 手动微调：拖动整体 / 拖左边缘 / 拖右边缘 / 吸附（`Alt` 临时关闭）
 *   · §4.6 性能：拖动**只重绘脏矩形**（`computeDirtyRect` + `timeRangeToDirtyRect`）
 * 算法细节：docs/05 §5.4（手动微调的**时间陷阱**）、§11.4（命中检测）
 *
 * ★★★ 拖左边缘的语义陷阱（本项目最容易写错的一行）★★★
 *   错误写法：只改 `timelineStartMs` → 音频内容跟着位移，用户听到的像是「整段被挪走」。
 *   正确语义：**改裁剪点，保持内容在时间线上的绝对位置不变**：
 *       Δ = newStart - oldStart
 *       srcInMs'          = srcInMs + Δ     ← 反向补偿
 *       timelineStartMs'  = newStart
 *   不变量：`timelineStartMs - srcInMs` 恒定。
 *   本文件不自己写这段算术，而是调用 `@shared/arrange/manual.ts` 的 `resizeLeftEdge()`
 *   （主进程 `alignment:updateItem` 用的是同一份实现，全仓库只有一个口径）。
 */

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { ArrangementItem, ArrangementItemPatch, Id, TrackId } from '@shared/types.ts'
import { isEditableTarget, matchEvent } from '@/shared/lib/shortcuts.ts'
import { computeDirtyRect, normalizeRect, rectsIntersect, timeToX, xToTime } from '@/shared/lib/waveform-transform.ts'
import type { Rect, Viewport } from '@/shared/lib/waveform-transform.ts'
import { itemDurationMs } from '@shared/arrange/layout.ts'
import { resizeLeftEdge, resizeRightEdge, snapToTargets } from '@shared/arrange/manual.ts'
import { itemRect, lowerBoundByStart, rowAtY } from './useTimelineRenderer.ts'
import type { TimelineLayout, TimelineRendererApi, TrackRow } from './useTimelineRenderer.ts'

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 交互状态机（docs/13 §9） */
export type InteractionState =
  | 'idle'
  | 'dragging'
  | 'resizing-left'
  | 'resizing-right'
  | 'panning'
  | 'selecting'
  | 'playhead'

export type HitKind = 'item' | 'edge-left' | 'edge-right' | 'empty' | 'ruler'

export interface TimelineHit {
  kind: HitKind
  itemId: Id | null
  trackId: TrackId | null
  /** 命中位置对应的时间（毫秒） */
  timeMs: number
  x: number
  y: number
}

/** 边缘把手命中区宽度（docs/13 §9 要求 ≥ 6px） */
export const EDGE_HANDLE_PX = 6

/** 吸附阈值（像素）→ 毫秒：阈值按像素定义，缩放到样本级时仍是「6 像素的手感」 */
export const SNAP_PX = 6

/** 拖动多少像素才算「真的拖了」（用来区分「单击定位播放头」与「框选」） */
const DRAG_THRESHOLD_PX = 3

/** 指针区域：画布 / 刻度尺（刻度尺上默认拖播放头，`Shift` 拖动画循环区间） */
export type PointerZone = 'canvas' | 'ruler'

interface DragContext {
  mode: InteractionState
  itemId: Id | null
  row: TrackRow | null
  /** 按下点（相对画布左上角） */
  startLocalX: number
  startLocalY: number
  /** 按下时的指针时间（毫秒） */
  startTimeMs: number
  /** 拖动开始时的 item 快照（撤销命令、吸附基准、左边缘补偿都要它） */
  original: ArrangementItem | null
  /** 撤销命令的 before 快照 */
  before: ArrangementItem[]
  /** 上一次请求重绘的区域（下一帧与新区间合并成一块脏矩形） */
  lastDirty: Rect | null
  /** 上一次播放头 x（拖播放头的窄带脏矩形用） */
  lastPlayheadX: number | null
  moved: boolean
  additive: boolean
  /** 框选是否用于「建立循环区间」而不是「选中片段」 */
  loopMode: boolean
  /** 吸附目标（按下时算一次：拖动期间邻居不会变，避免每帧重建数组） */
  snapTargets: number[]
  /** 中键平移的起始视口左边缘 */
  panStartScrollMs: number
}

export interface TimelineInteractionOptions {
  /** 轨道行布局（含纵向滚动） */
  layout: () => TimelineLayout
  viewport: () => Viewport
  itemsByTrack: () => ReadonlyMap<TrackId, ArrangementItem[]>
  itemById: (id: Id) => ArrangementItem | null
  /** 命中检测前保证轨内索引有序（拖动是原地改 item 的） */
  ensureSortedIndex: () => void
  renderer: TimelineRendererApi
  /** 画布 CSS 尺寸 */
  size: () => { width: number; height: number }
  /** 拖动中每帧的**内存**写入（不落库、不进撤销栈） */
  patchLocal: (itemId: Id, patch: ArrangementItemPatch) => void
  /** 松手提交：一条撤销命令 + 一次批量落库（docs/13 §4.8） */
  commit: (label: string, before: ArrangementItem[]) => void
  /** 选择 */
  select: (id: Id | null, mode?: 'replace' | 'toggle') => void
  selectMany: (ids: Id[], additive?: boolean) => void
  clearSelection: () => void
  /** 播放头 */
  setPlayhead: (ms: number) => void
  playhead: () => number
  /** 循环区间 */
  setLoop: (startMs: number, endMs: number) => void
  clearLoop: () => void
  loop: () => { startMs: number; endMs: number } | null
  /** 吸附与网格 */
  snapEnabled: () => boolean
  gridMs: () => number
  /** 片段的源文件时长（夹紧裁剪点用；拿不到传 null） */
  sourceDurationMs: (item: ArrangementItem) => number | null
  /** 键盘动作 */
  togglePlay: () => void
  nudge: (deltaMs: number) => void
  undo: () => void
  redo: () => void
  /** 视口操作 */
  zoomAtX: (factor: number, xPx: number) => void
  panByPx: (deltaPx: number) => void
  setScrollMs: (ms: number) => void
  scrollTracksBy: (deltaPx: number, contentHeight: number) => void
  fitChapter: () => void
}

export interface TimelineInteractionApi {
  state: Ref<InteractionState>
  /** 悬停命中结果（状态条显示「悬停：萧炎 @ 3:12.4」） */
  hover: Ref<TimelineHit | null>
  /** 框选矩形（渲染器负责画） */
  marquee: Ref<Rect | null>
  /** 鼠标光标样式 */
  cursor: ComputedRef<string>
  /** 交互提示（底部状态条） */
  statusText: ComputedRef<string>
  onPointerDown: (event: PointerEvent, zone?: PointerZone) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  onPointerLeave: () => void
  onDoubleClick: (event: MouseEvent) => void
  onWheel: (event: WheelEvent) => void
  /** 键盘：返回 true 表示已消费 */
  onKeydown: (event: KeyboardEvent) => boolean
  /** 中断当前交互（Esc / 组件卸载）：还原被拖动的 item，不产生撤销记录 */
  cancel: () => void
}

// ---------------------------------------------------------------------------
// 命中检测（纯函数，可单测；docs/13 §9 / docs/05 §11.4）
// ---------------------------------------------------------------------------

/**
 * 命中检测：先按 y 定轨道行，再在轨内做二分查找。
 *
 *   · `edge-left` / `edge-right` —— 边缘把手（命中区 `EDGE_HANDLE_PX`，默认 6px）；
 *   · `item`                     —— 片段主体；
 *   · `empty`                    —— 轨道空白（单击定位播放头 / 拖动起框选）；
 *   · `ruler`                    —— 画布之上（刻度尺区域）。
 *
 * 同一轨内多段重叠时（本身会被校验报 `same_track_overlap`）取**最短的一段**：
 * 视觉上它压在上面，也最可能是用户想抓的目标。
 */
export function hitTestTimeline(input: {
  x: number
  y: number
  layout: TimelineLayout
  viewport: Viewport
  itemsByTrack: ReadonlyMap<TrackId, ArrangementItem[]>
  edgeHandlePx?: number
}): TimelineHit {
  const { x, y, layout, viewport } = input
  const edgePx = Math.max(3, input.edgeHandlePx ?? EDGE_HANDLE_PX)
  const timeMs = xToTime(x, viewport)

  if (y < 0) return { kind: 'ruler', itemId: null, trackId: null, timeMs, x, y }

  const row = rowAtY(layout, y)
  if (!row) return { kind: 'empty', itemId: null, trackId: null, timeMs, x, y }

  const list = input.itemsByTrack.get(row.trackId)
  if (!list || !list.length) return { kind: 'empty', itemId: null, trackId: null, timeMs, x, y }

  // 二分找到第一个起点 >= timeMs 的位置，再向前回看（长片段/重叠的起点可能更早）
  const start = lowerBoundByStart(list, timeMs)
  let best: { item: ArrangementItem; rect: Rect } | null = null
  let scanned = 0
  for (let i = Math.max(0, start - 64); i < list.length && scanned < 128; i++, scanned++) {
    const item = list[i] as ArrangementItem
    if (item.timelineStartMs > timeMs) break
    const end = item.timelineStartMs + itemDurationMs(item)
    if (end < timeMs) continue
    const rect = itemRect(item, row, viewport)
    if (x < rect.x || x > rect.x + rect.w) continue
    if (!best || rect.w < best.rect.w) best = { item, rect }
  }

  if (!best) return { kind: 'empty', itemId: null, trackId: row.trackId, timeMs, x, y }

  const { item, rect } = best
  if (x <= rect.x + edgePx) return { kind: 'edge-left', itemId: item.id, trackId: row.trackId, timeMs, x, y }
  if (x >= rect.x + rect.w - edgePx) return { kind: 'edge-right', itemId: item.id, trackId: row.trackId, timeMs, x, y }
  return { kind: 'item', itemId: item.id, trackId: row.trackId, timeMs, x, y }
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

/** 指针相对元素左上角的坐标（pointer capture 后 `offsetX` 不可靠，统一用这个） */
function localPoint(event: { clientX: number; clientY: number; currentTarget: EventTarget | null }): { x: number; y: number } {
  const el = event.currentTarget as HTMLElement | null
  if (el && typeof el.getBoundingClientRect === 'function') {
    const rect = el.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  return { x: event.clientX, y: event.clientY }
}

export function useTimelineInteraction(options: TimelineInteractionOptions): TimelineInteractionApi {
  const state = ref<InteractionState>('idle')
  const hover = ref<TimelineHit | null>(null)
  const marquee = ref<Rect | null>(null)
  const hintText = ref('')

  let drag: DragContext | null = null

  const cursor = computed(() => {
    if (state.value === 'dragging' || state.value === 'panning') return 'grabbing'
    if (state.value === 'resizing-left' || state.value === 'resizing-right') return 'ew-resize'
    if (state.value === 'playhead') return 'ew-resize'
    if (state.value === 'selecting') return 'crosshair'
    const kind = hover.value?.kind
    if (kind === 'edge-left' || kind === 'edge-right') return 'ew-resize'
    if (kind === 'item') return 'grab'
    return 'default'
  })

  const statusText = computed(() => {
    if (hintText.value) return hintText.value
    switch (state.value) {
      case 'dragging': return '拖动中：只改 timelineStartMs（内容随块移动）'
      case 'resizing-left': return '拖左边缘：timelineStartMs 与 srcInMs 反向补偿，内容绝对位置不变（docs/05 §5.4）'
      case 'resizing-right': return '拖右边缘：只改 srcOutMs'
      case 'panning': return '平移视口'
      case 'selecting': return '框选：框内有片段则选中；框内没有片段则建立循环区间'
      case 'playhead': return '拖动播放头'
      default: return ''
    }
  })

  function bounds(): Rect {
    const { width, height } = options.size()
    return { x: 0, y: 0, w: width, h: height }
  }

  /** 吸附阈值：像素 → 毫秒（缩放到样本级时手感一致） */
  function snapThresholdMs(): number {
    const vp = options.viewport()
    return vp.pxPerMs > 0 ? SNAP_PX / vp.pxPerMs : 0
  }

  /**
   * 按下时算一次吸附目标。
   * 目标 = 0 / 播放头 / 循环区间边界 / 同轨与邻轨的片段边界（±半屏内）。
   * 说明：画本行本身没有时间信息，它在时间线上的「边界」就是该行 item 的起止点，
   * 因此相邻 item 边界即代表「画本行边界」（docs/13 §4.7）。
   */
  function buildSnapTargets(item: ArrangementItem | null): number[] {
    const vp = options.viewport()
    const targets: number[] = [0, options.playhead()]
    const loop = options.loop()
    if (loop) targets.push(loop.startMs, loop.endMs)

    const pivot = item ? item.timelineStartMs : 0
    const halfScreenMs = (options.size().width / Math.max(vp.pxPerMs, 1e-9)) * 0.5
    const windowMs = Math.max(2000, halfScreenMs)

    for (const list of options.itemsByTrack().values()) {
      for (const other of list) {
        if (item && other.id === item.id) continue
        const start = other.timelineStartMs
        const end = start + itemDurationMs(other)
        if (Math.abs(start - pivot) > windowMs && Math.abs(end - pivot) > windowMs) continue
        targets.push(start, end)
      }
    }
    return targets
  }

  /** 拖动一帧：算出「上一帧脏区 ∪ 本帧区域」并请求重绘，返回本帧区域 */
  function drawItemDirty(item: ArrangementItem, row: TrackRow): Rect | null {
    const rect = itemRect(item, row, options.viewport())
    const previous = drag?.lastDirty ?? null
    const dirty = computeDirtyRect(previous, rect, bounds(), 3)
    if (dirty) options.renderer.requestDraw(dirty)
    return rect
  }

  function beginDrag(mode: InteractionState, event: PointerEvent, hit: TimelineHit, row: TrackRow | null): DragContext {
    const point = localPoint(event)
    const item = hit.itemId ? options.itemById(hit.itemId) : null
    return {
      mode,
      itemId: hit.itemId,
      row,
      startLocalX: point.x,
      startLocalY: point.y,
      startTimeMs: hit.timeMs,
      original: item ? { ...item } : null,
      before: item ? [{ ...item }] : [],
      lastDirty: null,
      lastPlayheadX: timeToX(options.playhead(), options.viewport()),
      moved: false,
      additive: event.ctrlKey || event.metaKey,
      loopMode: event.shiftKey,
      snapTargets: buildSnapTargets(item),
      panStartScrollMs: options.viewport().scrollMs,
    }
  }

  function capture(event: PointerEvent): void {
    const target = event.currentTarget as Element | null
    try {
      target?.setPointerCapture?.(event.pointerId)
    } catch {
      /* 个别环境没有 pointer capture：不影响主流程（只是拖出画布会掉手） */
    }
  }

  function onPointerDown(event: PointerEvent, zone: PointerZone = 'canvas'): void {
    if (event.button !== 0 && event.button !== 1) return
    const { width, height } = options.size()
    if (width <= 0 || height <= 0) return
    const point = localPoint(event)
    capture(event)

    if (zone === 'ruler') {
      // 刻度尺：默认拖播放头；`Shift` 拖动 = 画循环区间（docs/13 §4.6「框选区间循环播放」）
      const rulerHit: TimelineHit = {
        kind: 'ruler', itemId: null, trackId: null, timeMs: xToTime(point.x, options.viewport()), x: point.x, y: -1,
      }
      drag = beginDrag(event.shiftKey ? 'selecting' : 'playhead', event, rulerHit, null)
      state.value = drag.mode
      if (drag.mode === 'playhead') options.setPlayhead(drag.startTimeMs)
      hintText.value = drag.mode === 'playhead' ? '正在定位播放头' : '拖出循环区间'
      options.renderer.requestDraw(null)
      return
    }

    options.ensureSortedIndex()
    const layout = options.layout()
    const hit = hitTestTimeline({
      x: point.x,
      y: point.y,
      layout,
      viewport: options.viewport(),
      itemsByTrack: options.itemsByTrack(),
    })

    if (event.button === 1) {
      // 中键平移（与常见 DAW 一致）
      if (event.preventDefault) event.preventDefault()
      drag = beginDrag('panning', event, hit, rowAtY(layout, point.y))
      state.value = 'panning'
      return
    }

    if (hit.kind === 'edge-left' || hit.kind === 'edge-right') {
      const item = hit.itemId ? options.itemById(hit.itemId) : null
      if (item?.locked) {
        // 锁定语义：自动排布与手工拖动都不动它（docs/13 §4.7）
        options.select(item.id, 'replace')
        hintText.value = '该片段已锁定：先解锁（右键 → 解锁）才能拖动'
        options.renderer.requestDraw(null)
        return
      }
      drag = beginDrag(hit.kind === 'edge-left' ? 'resizing-left' : 'resizing-right', event, hit, rowAtY(layout, point.y))
      state.value = drag.mode
      return
    }

    if (hit.kind === 'item' && hit.itemId) {
      const item = options.itemById(hit.itemId)
      options.select(hit.itemId, event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
      if (item?.locked) {
        hintText.value = '该片段已锁定：拖动不会移动它（右键 → 解锁并重排）'
        options.renderer.requestDraw(null)
        return
      }
      drag = beginDrag('dragging', event, hit, rowAtY(layout, point.y))
      state.value = 'dragging'
      return
    }

    // 空白：按下先记录，松手时若没拖动就定位播放头，拖了就框选
    drag = beginDrag('selecting', event, hit, rowAtY(layout, point.y))
    state.value = 'selecting'
    marquee.value = null
    if (!drag.additive) options.clearSelection()
  }

  function onPointerMove(event: PointerEvent): void {
    const point = localPoint(event)
    const vp = options.viewport()

    if (!drag) {
      // 空闲：只更新悬停命中（状态条与光标样式用）
      options.ensureSortedIndex()
      hover.value = hitTestTimeline({
        x: point.x,
        y: point.y,
        layout: options.layout(),
        viewport: vp,
        itemsByTrack: options.itemsByTrack(),
      })
      return
    }

    const dx = point.x - drag.startLocalX
    const dy = point.y - drag.startLocalY
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) drag.moved = true
    const pxPerMs = Math.max(vp.pxPerMs, 1e-9)

    switch (drag.mode) {
      case 'panning': {
        // 向右拖 → 视口左边缘左移（内容跟着指针走）
        options.setScrollMs(drag.panStartScrollMs - dx / pxPerMs)
        options.renderer.requestDraw(null)
        break
      }

      case 'playhead': {
        const ms = xToTime(point.x, vp)
        options.setPlayhead(ms)
        const x = timeToX(ms, vp)
        const height = options.size().height
        // 播放头是细线：只重绘「上一次位置 ∪ 这一次位置」两条窄带
        const dirty = computeDirtyRect(
          drag.lastPlayheadX === null ? null : { x: drag.lastPlayheadX - 6, y: 0, w: 12, h: height },
          { x: x - 6, y: 0, w: 12, h: height },
          bounds(),
          2,
        )
        drag.lastPlayheadX = x
        if (dirty) options.renderer.requestDraw(dirty)
        break
      }

      case 'dragging':
      case 'resizing-left':
      case 'resizing-right': {
        const original = drag.original
        if (!original || !drag.row || !drag.itemId) break
        const rawDeltaMs = dx / pxPerMs
        // `Alt` 临时关闭吸附（docs/13 §4.7）；吸附阈值按**像素**换算成毫秒
        const snapOn = options.snapEnabled() && !event.altKey
        const snap = (value: number): { value: number; snappedTo: 'grid' | 'target' | null } =>
          snapOn
            ? snapToTargets(value, {
                gridMs: options.gridMs(),
                targets: drag?.snapTargets ?? [],
                thresholdMs: snapThresholdMs(),
              })
            : { value, snappedTo: null }
        const sourceDurationMs = options.sourceDurationMs(original) ?? undefined
        // 拖动时允许做极短片段（校验会报 short_segment），但绝不允许出现负时长
        const minDurationMs = 10

        if (drag.mode === 'dragging') {
          const snapped = snap(original.timelineStartMs + rawDeltaMs)
          options.patchLocal(drag.itemId, { timelineStartMs: Math.max(0, Math.round(snapped.value)) })
          hintText.value = snapped.snappedTo === 'target'
            ? '吸附到相邻边界'
            : snapped.snappedTo === 'grid'
              ? '吸附到网格'
              : `拖动 ${Math.round(rawDeltaMs)} ms`
        } else if (drag.mode === 'resizing-left') {
          const snapped = snap(original.timelineStartMs + rawDeltaMs)
          // ★ 拖左边缘：resizeLeftEdge 同时改 timelineStartMs 与 srcInMs（反向补偿），
          //   保证 `timelineStartMs - srcInMs` 不变 ⇒ 音频内容绝对位置不变。
          const result = resizeLeftEdge(original, snapped.value, { minDurationMs, sourceDurationMs })
          options.patchLocal(drag.itemId, {
            timelineStartMs: result.item.timelineStartMs,
            srcInMs: result.item.srcInMs,
          })
          hintText.value = result.clamped
            ? '已到片段头部（裁剪点不能越过终点）'
            : '拖左边缘：内容绝对位置不变（srcIn 反向补偿）'
        } else {
          const originalEnd = original.timelineStartMs + itemDurationMs(original)
          const snapped = snap(originalEnd + rawDeltaMs)
          const result = resizeRightEdge(original, snapped.value, { minDurationMs, sourceDurationMs })
          options.patchLocal(drag.itemId, { srcOutMs: result.item.srcOutMs })
          hintText.value = result.clamped ? '已到片段尾部（源文件到头了）' : '拖右边缘：只改 srcOutMs'
        }

        const current = options.itemById(drag.itemId)
        if (current && drag.row) drag.lastDirty = drawItemDirty(current, drag.row)
        break
      }

      case 'selecting': {
        marquee.value = normalizeRect({
          x: drag.startLocalX,
          y: drag.startLocalY,
          w: dx,
          h: dy,
        })
        options.renderer.requestDraw(null)
        break
      }

      default:
        break
    }
  }

  function onPointerUp(event: PointerEvent): void {
    const context = drag
    drag = null
    state.value = 'idle'
    if (!context) return

    const target = event.currentTarget as Element | null
    try {
      target?.releasePointerCapture?.(event.pointerId)
    } catch {
      /* 忽略 */
    }

    if (context.mode === 'dragging' || context.mode === 'resizing-left' || context.mode === 'resizing-right') {
      if (context.moved && context.before.length) {
        const label = context.mode === 'dragging'
          ? '拖动片段'
          : context.mode === 'resizing-left'
            ? '拖动左边缘（改裁剪点）'
            : '拖动右边缘（改终点）'
        // 一次性提交：一条撤销命令 + 一次批量落库（docs/13 §4.8）
        options.commit(label, context.before)
      }
      hintText.value = ''
      options.renderer.requestDraw(null)
      return
    }

    if (context.mode === 'selecting') {
      const rect = marquee.value
      marquee.value = null

      if (!rect || !context.moved) {
        // 单击空白 = 定位播放头（docs/13 §4.6）
        if (!context.loopMode) options.setPlayhead(context.startTimeMs)
        hintText.value = ''
        options.renderer.requestDraw(null)
        return
      }

      const vp = options.viewport()
      const fromMs = xToTime(rect.x, vp)
      const toMs = xToTime(rect.x + rect.w, vp)
      const ids: Id[] = []
      for (const row of options.layout().rows) {
        if (row.top > rect.y + rect.h || row.top + row.height < rect.y) continue
        const list = options.itemsByTrack().get(row.trackId)
        if (!list) continue
        for (const item of list) {
          const end = item.timelineStartMs + itemDurationMs(item)
          if (end < fromMs || item.timelineStartMs > toMs) continue
          if (rectsIntersect(itemRect(item, row, vp), rect)) ids.push(item.id)
        }
      }

      if (context.loopMode || ids.length === 0) {
        const a = Math.min(fromMs, toMs)
        const b = Math.max(fromMs, toMs)
        options.setLoop(a, b)
        hintText.value = `循环区间 ${Math.round(a)} → ${Math.round(b)} ms`
      } else {
        options.selectMany(ids, context.additive)
        hintText.value = `已选中 ${ids.length} 段`
      }
      options.renderer.requestDraw(null)
      return
    }

    hintText.value = ''
    options.renderer.requestDraw(null)
  }

  function onPointerLeave(): void {
    if (!drag) hover.value = null
  }

  /** 双击片段 = 播放头定位到它的起点并选中（快速定位） */
  function onDoubleClick(event: MouseEvent): void {
    const point = localPoint(event)
    options.ensureSortedIndex()
    const hit = hitTestTimeline({
      x: point.x,
      y: point.y,
      layout: options.layout(),
      viewport: options.viewport(),
      itemsByTrack: options.itemsByTrack(),
    })
    if (hit.kind === 'item' && hit.itemId) {
      const item = options.itemById(hit.itemId)
      if (item) options.setPlayhead(item.timelineStartMs)
      options.select(hit.itemId, 'replace')
    } else {
      options.setPlayhead(hit.timeMs)
    }
    options.renderer.requestDraw(null)
  }

  /**
   * 滚轮（docs/13 §4.6）：
   *   · `Ctrl/Cmd + 滚轮` → 以鼠标位置为锚点缩放（`zoomAround`，锚点像素不动）
   *   · `Shift + 滚轮`    → 水平平移
   *   · 普通滚轮          → 纵向滚动轨道区
   */
  function onWheel(event: WheelEvent): void {
    const point = localPoint(event)
    if (event.ctrlKey || event.metaKey) {
      options.zoomAtX(Math.pow(1.0016, -event.deltaY), point.x)
    } else if (event.shiftKey) {
      options.panByPx(event.deltaY !== 0 ? event.deltaY : event.deltaX)
    } else {
      options.scrollTracksBy(event.deltaY, Math.max(options.size().height, options.layout().contentHeight))
    }
    event.preventDefault()
    options.renderer.requestDraw(null)
  }

  /**
   * 键盘（返回 true = 已消费）。输入框内一律不抢键（`isEditableTarget`，docs/12 §9.3 同口径）。
   *   `Space` 播放/暂停；`←/→` ±10 ms（`Shift` ±1 ms、`Ctrl` ±100 ms，docs/13 §4.7）
   *   `Ctrl+Z` / `Ctrl+Shift+Z` 撤销重做；`Esc` 取消；`F` 适配整章；`+/-` 缩放
   */
  function onKeydown(event: KeyboardEvent): boolean {
    if (isEditableTarget(event.target)) return false
    if (matchEvent(event, 'Ctrl+Shift+Z') || matchEvent(event, 'Ctrl+Y')) {
      options.redo()
      return true
    }
    if (matchEvent(event, 'Ctrl+Z')) {
      options.undo()
      return true
    }
    if (matchEvent(event, 'Space')) {
      options.togglePlay()
      return true
    }
    if (matchEvent(event, 'ArrowLeft')) {
      options.nudge(event.shiftKey ? -1 : event.ctrlKey ? -100 : -10)
      return true
    }
    if (matchEvent(event, 'ArrowRight')) {
      options.nudge(event.shiftKey ? 1 : event.ctrlKey ? 100 : 10)
      return true
    }
    if (matchEvent(event, 'Escape')) {
      cancel()
      options.clearSelection()
      options.clearLoop()
      options.renderer.requestDraw(null)
      return true
    }
    if (matchEvent(event, 'Home')) {
      options.setPlayhead(0)
      options.renderer.requestDraw(null)
      return true
    }
    if (matchEvent(event, 'f')) {
      options.fitChapter()
      options.renderer.requestDraw(null)
      return true
    }
    if (matchEvent(event, '=') || matchEvent(event, '+')) {
      options.zoomAtX(1.25, timeToX(options.playhead(), options.viewport()))
      options.renderer.requestDraw(null)
      return true
    }
    if (matchEvent(event, '-')) {
      options.zoomAtX(0.8, timeToX(options.playhead(), options.viewport()))
      options.renderer.requestDraw(null)
      return true
    }
    return false
  }

  function cancel(): void {
    const original = drag?.original
    if (original) {
      // 中断拖动：还原到按下时的快照（不产生撤销记录）
      options.patchLocal(original.id, {
        timelineStartMs: original.timelineStartMs,
        srcInMs: original.srcInMs,
        srcOutMs: original.srcOutMs,
      })
    }
    drag = null
    marquee.value = null
    state.value = 'idle'
    hintText.value = ''
    options.renderer.requestDraw(null)
  }

  return {
    state,
    hover,
    marquee,
    cursor,
    statusText,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onDoubleClick,
    onWheel,
    onKeydown,
    cancel,
  }
}
