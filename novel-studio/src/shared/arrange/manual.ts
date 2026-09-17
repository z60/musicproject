/**
 * Novel Studio · 手动微调（docs/05 §5.4 / docs/13 §4.7）
 * ============================================================================
 * ★★ 拖左边缘的语义陷阱（docs/05 §5.4、docs/13 §4.7 都单独标注）★★
 *
 *   只改 `timelineStartMs` → 音频内容会跟着位移（听起来整段被挪走）；
 *   正确语义是「改裁剪点，保持内容绝对位置不变」：
 *
 *     Δ = newTimelineStart - oldTimelineStart
 *     srcInMs'        = srcInMs + Δ        # 反向补偿，内容绝对位置不变
 *     timelineStartMs' = newTimelineStart
 *
 *   不变量：`timelineStartMs - srcInMs` 恒定（内容在时间线上的绝对位置不变）。
 *
 * 本文件是纯函数：输入 item，返回**新的** item，绝不原地修改（撤销栈依赖这一点）。
 *
 * 失败语义：不抛异常；越界一律「夹到合法范围」并回报 `clamped=true`，
 *          调用方（IPC handler）无需再校验。
 */

import type { ArrangementItem, Id } from '../types.ts'
import { itemDurationMs } from './layout.ts'

/** 微调步进（docs/13 §4.7：±10 ms，Shift ±1 ms，Ctrl ±100 ms） */
export const NUDGE_STEPS = { fine: 1, normal: 10, coarse: 100 } as const

export type NudgeMode = boolean | 'coarse' | 'fine' | 'normal'

export interface EditResult {
  item: ArrangementItem
  /** 实际生效的变化量（毫秒） */
  appliedDeltaMs: number
  /** 是否因为边界被夹紧（UI 可给出「已到片段头」的提示） */
  clamped: boolean
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 拖动整体：只改 `timelineStartMs`（内容不动）。
 *
 * @throws 不抛异常；起点被夹到 >= 0
 */
export function moveItem(item: ArrangementItem, deltaMs: number): EditResult {
  const target = Math.max(0, Math.round(item.timelineStartMs + deltaMs))
  const applied = target - item.timelineStartMs
  return {
    item: { ...item, timelineStartMs: target },
    appliedDeltaMs: applied,
    clamped: applied !== Math.round(deltaMs),
  }
}

/** 直接设定位移目标（拖动结束提交时用），语义同 moveItem */
export function moveItemTo(item: ArrangementItem, timelineStartMs: number): EditResult {
  return moveItem(item, Math.round(timelineStartMs) - item.timelineStartMs)
}

/**
 * 拖左边缘（改起点）：**同时**改 `timelineStartMs` 与 `srcInMs`（反向补偿）。
 *
 * 不变量：`timelineStartMs - srcInMs` 不变 → 音频内容的绝对位置不变。
 * 约束：`0 <= srcInMs < srcOutMs`（裁剪点不能越过终点）；可传 `sourceDurationMs` 进一步夹紧。
 *
 * @throws 不抛异常；越界时夹紧并置 `clamped=true`
 */
export function resizeLeftEdge(
  item: ArrangementItem,
  newStartMs: number,
  opts: { sourceDurationMs?: number; minDurationMs?: number } = {},
): EditResult {
  const minDurationMs = Math.max(0, opts.minDurationMs ?? 0)
  const requestedDelta = Math.round(newStartMs) - item.timelineStartMs

  // srcInMs 的下界 0、上界 srcOutMs - minDuration（且不早于 0 的目标时间线）
  const lowBoundDelta = -item.srcInMs
  const highBoundDelta = item.srcOutMs - minDurationMs - item.srcInMs
  let delta = clamp(requestedDelta, lowBoundDelta, Math.max(lowBoundDelta, highBoundDelta))
  // 目标时间线不能为负（回退到 0 之前没有意义）
  if (item.timelineStartMs + delta < 0) delta = -item.timelineStartMs
  // 片段内偏移不能超过源文件长度
  if (typeof opts.sourceDurationMs === 'number') {
    const maxSrcIn = Math.max(0, opts.sourceDurationMs - minDurationMs)
    if (item.srcInMs + delta > maxSrcIn) delta = maxSrcIn - item.srcInMs
  }

  return {
    item: {
      ...item,
      timelineStartMs: item.timelineStartMs + delta,
      // ★ 反向补偿：内容绝对位置不变（timelineStartMs - srcInMs 恒定）
      srcInMs: item.srcInMs + delta,
    },
    appliedDeltaMs: delta,
    clamped: delta !== requestedDelta,
  }
}

/**
 * 拖右边缘（改终点）：只改 `srcOutMs`（`timelineStartMs` 不动）。
 *
 * @throws 不抛异常；越界时夹紧并置 `clamped=true`（`srcOutMs > srcInMs + minDurationMs`）
 */
export function resizeRightEdge(
  item: ArrangementItem,
  newEndMs: number,
  opts: { sourceDurationMs?: number; minDurationMs?: number } = {},
): EditResult {
  const minDurationMs = Math.max(0, opts.minDurationMs ?? 0)
  const currentEnd = item.timelineStartMs + (item.srcOutMs - item.srcInMs)
  const requestedDelta = Math.round(newEndMs) - currentEnd

  let srcOut = item.srcOutMs + requestedDelta
  const lower = item.srcInMs + minDurationMs
  const upper = typeof opts.sourceDurationMs === 'number' ? opts.sourceDurationMs : Number.POSITIVE_INFINITY
  const clampedSrcOut = clamp(srcOut, lower, Math.max(lower, upper))
  const appliedDelta = clampedSrcOut - item.srcOutMs

  return {
    item: { ...item, srcOutMs: clampedSrcOut },
    appliedDeltaMs: appliedDelta,
    clamped: appliedDelta !== requestedDelta,
  }
}

export interface SnapOptions {
  /** 网格：0.1 s / 0.5 s（docs/13 §4.5）；给了就**总是**吸到最近网格点 */
  gridMs?: number
  /** 吸附目标：相邻 item 边界、画本行边界 */
  targets: number[]
  /** 目标吸附阈值，默认 100 ms（超过就不吸，避免「想微调却被拽走」） */
  thresholdMs?: number
}

export interface SnapResult {
  value: number
  /** 吸到了什么：网格 / 目标 / 没吸 */
  snappedTo: 'grid' | 'target' | null
  /** 实际位移（毫秒） */
  deltaMs: number
}

/**
 * 吸附（拖动时按住 Alt 关闭，由调用方决定是否调用本函数）。
 *
 * 规则：目标（相邻边界 / 画本行边界）在阈值内优先，其次是网格；
 *       两者都在范围内时取距离更近者（平局取目标，因为它更有语义）。
 *
 * @throws 不抛异常；没有任何候选时原样返回
 */
export function snapToTargets(value: number, opts: SnapOptions): SnapResult {
  const thresholdMs = opts.thresholdMs ?? 100
  const candidates: Array<{ value: number; kind: 'grid' | 'target' }> = []

  if (typeof opts.gridMs === 'number' && opts.gridMs > 0) {
    candidates.push({ value: Math.round(value / opts.gridMs) * opts.gridMs, kind: 'grid' })
  }
  for (const t of opts.targets) {
    if (!Number.isFinite(t)) continue
    if (Math.abs(t - value) <= thresholdMs) candidates.push({ value: t, kind: 'target' })
  }
  if (candidates.length === 0) return { value, snappedTo: null, deltaMs: 0 }

  let best = candidates[0] as { value: number; kind: 'grid' | 'target' }
  let bestDist = Math.abs(best.value - value)
  for (const c of candidates.slice(1)) {
    const dist = Math.abs(c.value - value)
    if (dist < bestDist || (dist === bestDist && c.kind === 'target' && best.kind === 'grid')) {
      best = c
      bestDist = dist
    }
  }
  return { value: best.value, snappedTo: best.kind, deltaMs: best.value - value }
}

/**
 * 键盘微调（docs/13 §4.7）：
 *   `→` = +10 ms、`Shift+→` = +1 ms、`Ctrl+→` = +100 ms
 *
 * @param deltaMs **步数**（符号表示方向）：`nudge(item, -3)` = -30 ms
 * @param mode    true/'fine' = 1 ms；'coarse' = 100 ms；false/undefined/'normal' = 10 ms
 * @throws 不抛异常；起点夹到 >= 0
 */
export function nudge(item: ArrangementItem, deltaMs: number, mode?: NudgeMode): EditResult {
  const step =
    mode === true || mode === 'fine'
      ? NUDGE_STEPS.fine
      : mode === 'coarse'
        ? NUDGE_STEPS.coarse
        : NUDGE_STEPS.normal
  const steps = Number.isFinite(deltaMs) ? Math.trunc(deltaMs) || (deltaMs > 0 ? 1 : deltaMs < 0 ? -1 : 0) : 0
  return moveItem(item, steps * step)
}

/**
 * 应用一处补丁（IPC `alignment.updateItem` 用）。
 * `timelineStartMs` 与 `srcInMs` 同时出现时按「拖左边缘」语义处理（反向补偿），
 * 避免 UI 传两个字段时把内容挪走。
 *
 * @throws 不抛异常；`fadeInMs/fadeOutMs` 负数会被夹到 0
 */
export function applyItemPatch(
  item: ArrangementItem,
  patch: {
    timelineStartMs?: number
    srcInMs?: number
    srcOutMs?: number
    fadeInMs?: number
    fadeOutMs?: number
    locked?: boolean
  },
  opts: { sourceDurationMs?: number; minDurationMs?: number } = {},
): ArrangementItem {
  const changesStart = patch.timelineStartMs !== undefined
  const changesIn = patch.srcInMs !== undefined
  let next = { ...item }

  if (changesStart && changesIn) {
    // 同时改了起点与裁剪点：先按「拖左边缘」语义做反向补偿（保持内容绝对位置），
    // 再让显式传入的 srcInMs 覆盖（高级用法：位置与裁剪点一起改）
    const keepContent = resizeLeftEdge(item, Math.round(patch.timelineStartMs as number), opts)
    next = {
      ...keepContent.item,
      srcInMs: Math.max(0, Math.round(patch.srcInMs as number)),
    }
  } else if (changesStart) {
    next = moveItemTo(item, patch.timelineStartMs as number).item
  } else if (changesIn) {
    const delta = Math.round(patch.srcInMs as number) - item.srcInMs
    next = resizeLeftEdge(item, item.timelineStartMs + delta, opts).item
  }

  if (patch.srcOutMs !== undefined) {
    const delta = Math.round(patch.srcOutMs) - next.srcOutMs
    const currentEnd = next.timelineStartMs + (next.srcOutMs - next.srcInMs)
    next = resizeRightEdge(next, currentEnd + delta, opts).item
  }
  if (patch.fadeInMs !== undefined) next = { ...next, fadeInMs: Math.max(0, patch.fadeInMs) }
  if (patch.fadeOutMs !== undefined) next = { ...next, fadeOutMs: Math.max(0, patch.fadeOutMs) }
  if (patch.locked !== undefined) next = { ...next, locked: patch.locked }

  return next
}

/**
 * 重置为自动排布结果（docs/13 §4.7「重置」）：位置与裁剪点回到 auto 的产物，
 * 但保留 id 与 locked 之外的一切人工无关信息。
 *
 * @throws 不抛异常
 */
export function resetToAuto(item: ArrangementItem, auto: ArrangementItem): ArrangementItem {
  return {
    ...item,
    timelineStartMs: auto.timelineStartMs,
    srcInMs: auto.srcInMs,
    srcOutMs: auto.srcOutMs,
    fadeInMs: auto.fadeInMs,
    fadeOutMs: auto.fadeOutMs,
    orderInTrack: auto.orderInTrack,
  }
}

/**
 * 批量位移（多选拖动）：整体 Δ，锁定项是否跟随由 `includeLocked` 决定。
 *
 * @throws 不抛异常
 */
export function moveMany(
  items: ArrangementItem[],
  ids: Id[],
  deltaMs: number,
  opts: { includeLocked?: boolean } = {},
): { items: ArrangementItem[]; movedIds: Id[] } {
  const set = new Set(ids)
  const movedIds: Id[] = []
  const next = items.map(it => {
    if (!set.has(it.id)) return it
    if (it.locked && !opts.includeLocked) return it
    movedIds.push(it.id)
    return moveItem(it, deltaMs).item
  })
  return { items: next, movedIds }
}

/**
 * 内容绝对位置不变量检查（单测与调试用）：
 * `timelineStartMs - srcInMs` 恒定即表示「拖动裁剪点时内容没跑」。
 *
 * @throws 不抛异常；带容差比较（浮点）
 */
export function contentOffsetMs(item: Pick<ArrangementItem, 'timelineStartMs' | 'srcInMs'>): number {
  return item.timelineStartMs - item.srcInMs
}

/** 轨道上 item 是否与另一个 item 交叠（含 duration 计算，供 UI 命中检测复用） */
export function intersects(a: ArrangementItem, b: ArrangementItem): boolean {
  const aEnd = a.timelineStartMs + itemDurationMs(a)
  const bEnd = b.timelineStartMs + itemDurationMs(b)
  return a.timelineStartMs < bEnd && b.timelineStartMs < aEnd
}
