/**
 * Novel Studio · 重叠检测与消解（docs/05 §5.2 / docs/13 §4.3）
 * ============================================================================
 * 本项目最易做错的一处：**必须区分同轨与跨轨**。
 *
 * | 类型 | 判定 | 默认动作 |
 * |------|------|----------|
 * | 同轨重叠 | 同 `trackId` 内区间相交 | **必须消解**（同一人不能同时说两句） |
 * | 跨轨 · 正常对话 | 相交 ≤ maxCrossTrackOverlapMs（默认 3000 ms） | 保留（更自然） |
 * | 跨轨 · 疑似异常 | 相交 > maxCrossTrackOverlapMs | 列入报告（level='warning'） |
 * | 无人说话的空隙 | 全轨合并后仍有 > 5 s 的空隙（非章头章尾） | 报告（多半是缺录了一行） |
 *
 * 「跨轨正常对话」也出现在 crossTrack 数组里（level='normal'），
 * 但**不会**出现在 issues 中 —— UI 据此区分「提示」与「告警」。
 *
 * 失败语义：不抛异常；调用方据报告决定是否阻断（`MIX_ARRANGEMENT_EMPTY` 等）。
 */

import { ARRANGE_DEFAULTS } from '../constants.ts'
import type { ArrangementItem, ArrangeStrategy, Id, TrackId } from '../types.ts'
import { itemDurationMs } from './layout.ts'

export interface OverlapOptions {
  /** 跨轨重叠在此范围内视为正常对话，默认 3000 ms */
  maxCrossTrackOverlapMs?: number
  /** 非章头章尾的「无人说话」空隙超过此值告警，默认 5000 ms */
  maxGapMs?: number
  /** 消解后两段之间的最小间隙，默认 50 ms */
  minGapMs?: number
}

export interface SameTrackOverlapInfo {
  a: Id
  b: Id
  overlapMs: number
  trackId: TrackId
}

export interface CrossTrackOverlapInfo {
  a: Id
  b: Id
  overlapMs: number
  /** normal = 正常对话（保留）；warning = 超出上限，建议串行化 */
  level: 'normal' | 'warning'
}

export interface LongGapInfo {
  /** 空隙之前那一句的 lineId（UI 显示「这一行之后空了 6.2 秒」） */
  afterLineId: Id
  afterItemId: Id
  gapMs: number
  trackId: TrackId
}

export interface OverlapReport {
  sameTrack: SameTrackOverlapInfo[]
  crossTrack: CrossTrackOverlapInfo[]
  longGaps: LongGapInfo[]
}

interface Span {
  item: ArrangementItem
  start: number
  end: number
}

function toSpans(items: ArrangementItem[]): Span[] {
  return items.map(item => {
    const start = item.timelineStartMs
    return { item, start, end: start + itemDurationMs(item) }
  })
}

/** 相交时长（不相交返回 0） */
export function overlapMsOf(
  a: { timelineStartMs: number } & { srcInMs: number; srcOutMs: number; fadeInMs: number; fadeOutMs: number },
  b: { timelineStartMs: number } & { srcInMs: number; srcOutMs: number; fadeInMs: number; fadeOutMs: number },
): number {
  const aStart = a.timelineStartMs
  const aEnd = aStart + itemDurationMs(a)
  const bStart = b.timelineStartMs
  const bEnd = bStart + itemDurationMs(b)
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/**
 * 重叠与长空隙检测。
 *
 * 实现用「扫描线 + 活动集」：复杂度 O(n log n + k)，1000 个 item 也不会卡住 UI 线程。
 *
 * @throws 不抛异常
 */
export function detectOverlaps(items: ArrangementItem[], opts: OverlapOptions = {}): OverlapReport {
  const maxCrossTrack = opts.maxCrossTrackOverlapMs ?? ARRANGE_DEFAULTS.maxCrossTrackOverlapMs
  const maxGap = opts.maxGapMs ?? ARRANGE_DEFAULTS.maxGapMs
  const spans = toSpans(items).sort((x, y) => x.start - y.start || x.end - y.end)

  const sameTrack: SameTrackOverlapInfo[] = []
  const crossTrack: CrossTrackOverlapInfo[] = []
  const active: Span[] = []

  for (const cur of spans) {
    // 过期项（end <= cur.start）先出队
    for (let i = active.length - 1; i >= 0; i--) {
      if ((active[i] as Span).end <= cur.start) active.splice(i, 1)
    }
    for (const other of active) {
      const overlap = Math.min(cur.end, other.end) - Math.max(cur.start, other.start)
      if (overlap <= 0) continue
      if (cur.item.trackId === other.item.trackId) {
        sameTrack.push({ a: other.item.id, b: cur.item.id, overlapMs: overlap, trackId: cur.item.trackId })
      } else {
        crossTrack.push({
          a: other.item.id,
          b: cur.item.id,
          overlapMs: overlap,
          level: overlap <= maxCrossTrack ? 'normal' : 'warning',
        })
      }
    }
    active.push(cur)
  }

  // 长空隙：全轨合并后仍无人说话的时间段（非章头章尾）
  const longGaps: LongGapInfo[] = []
  let cursorEnd = -1
  let owner: Span | null = null
  for (const cur of spans) {
    if (cursorEnd < 0) {
      cursorEnd = cur.end
      owner = cur
      continue
    }
    if (cur.start > cursorEnd) {
      const gap = cur.start - cursorEnd
      if (owner && gap > maxGap) {
        longGaps.push({
          afterLineId: owner.item.lineId,
          afterItemId: owner.item.id,
          gapMs: gap,
          trackId: owner.item.trackId,
        })
      }
    }
    if (cur.end > cursorEnd) {
      cursorEnd = cur.end
      owner = cur
    }
  }

  sameTrack.sort((a, b) => b.overlapMs - a.overlapMs)
  crossTrack.sort((a, b) => b.overlapMs - a.overlapMs)
  longGaps.sort((a, b) => b.gapMs - a.gapMs)
  return { sameTrack, crossTrack, longGaps }
}

/** `tighten` 策略下与前一段的紧贴间隙（docs/13 §4.3：start_b = end_a + 20 ms） */
export const TIGHTEN_GAP_MS = 20

export interface OverlapResolution {
  /** 新的 items 数组（未改动时返回原引用的浅拷贝） */
  items: ArrangementItem[]
  strategy: ArrangeStrategy
  /** 实际改动明细（供 undo 栈与 UI 提示） */
  changes: Array<{
    itemId: Id
    kind: 'move' | 'trim-tail' | 'none'
    deltaMs: number
    reason: string
  }>
}

export interface ResolveOverlapOptions extends OverlapOptions {
  /**
   * `tighten` 需要「把前一段的尾部静音修剪掉」——静音扫描必须在 PCM 域做
   * （见 `audio/trim.ts` 的 computeTrimRange）。调用方把扫到的可修剪毫秒数传进来；
   * 不传则不修剪（只做紧贴），并在 changes 里说明原因。
   */
  trimTailMs?: number
}

function indexOfItem(items: ArrangementItem[], ref: Id | ArrangementItem): number {
  if (typeof ref === 'string') return items.findIndex(i => i.id === ref)
  return items.findIndex(i => i.id === ref.id)
}

/**
 * 消解一处重叠（docs/13 §4.3 的 4 种策略）。
 *
 * | 策略 | 行为 |
 * |------|------|
 * | `serialize`       | `start_b = end_a + minGapMs`（默认 50）——通用 |
 * | `keep`            | 不动，只记录 —— 有意做对话交叠（群戏、抢话） |
 * | `compress-pause`  | 把 b 之前的留白压到 0：`start_b = end_a`（比 serialize 紧），不想改变节奏时用 |
 * | `tighten`         | `start_b = end_a + 20 ms`，并（尽力）修剪 a 的尾部静音 —— 快节奏 |
 *
 * 约定：`a` 是时间上靠前的那一段（若调用方传反了，会自动交换并按时间先后处理）。
 *
 * @throws 不抛异常；找不到 item 时返回未改动的结果（changes 为空）
 */
export function resolveOverlap(
  items: ArrangementItem[],
  a: Id | ArrangementItem,
  b: Id | ArrangementItem,
  strategy: ArrangeStrategy,
  opts: ResolveOverlapOptions = {},
): OverlapResolution {
  const minGapMs = opts.minGapMs ?? ARRANGE_DEFAULTS.minGapMs
  const ia = indexOfItem(items, a)
  const ib = indexOfItem(items, b)
  if (ia < 0 || ib < 0 || ia === ib) {
    return { items: [...items], strategy, changes: [] }
  }

  const itemA = items[ia] as ArrangementItem
  const itemB = items[ib] as ArrangementItem
  // 统一成「前者 a、后者 b」（按起点排序）
  const [first, second] = itemA.timelineStartMs <= itemB.timelineStartMs ? [itemA, itemB] : [itemB, itemA]

  const next = [...items]
  const changes: OverlapResolution['changes'] = []
  const endA = first.timelineStartMs + itemDurationMs(first)

  const moveTo = (target: ArrangementItem, startMs: number, reason: string): void => {
    const idx = next.findIndex(i => i.id === target.id)
    const old = target.timelineStartMs
    const rounded = Math.max(0, Math.round(startMs))
    next[idx] = { ...target, timelineStartMs: rounded }
    changes.push({ itemId: target.id, kind: 'move', deltaMs: rounded - old, reason })
  }

  switch (strategy) {
    case 'keep':
      // 有意交叠：什么都不做（UI 上给「我知道，别动」的语义）
      changes.push({ itemId: second.id, kind: 'none', deltaMs: 0, reason: 'keep：保留交叠（有意做对话交叠）' })
      break

    case 'serialize':
      moveTo(second, endA + minGapMs, `serialize：后一段移到前一段结束 + ${minGapMs} ms 最小留白`)
      break

    case 'compress-pause':
      // 先把留白压到 0（贴着前一段结束），比 serialize 更紧凑；
      // 若 b 完全被 a 覆盖（b 在前且被 a 包住）则贴齐仍相交，退回 serialize。
      if (second.timelineStartMs + itemDurationMs(second) <= endA) {
        moveTo(second, endA + minGapMs, 'compress-pause：后一段被完全覆盖，退回串行化')
      } else {
        moveTo(second, endA, 'compress-pause：把两段之间的留白压到 0（紧贴前一段结束）')
      }
      break

    case 'tighten': {
      // 先修剪 a 的尾部静音（PCM 域扫描结果由调用方传入），再算 a 的新结束点 ——
      // 顺序反了会出现「b 贴到了旧的 end_a」而留下 40 ms 空档。
      let endAfterTrim = endA
      const trimTailMs = opts.trimTailMs
      if (typeof trimTailMs === 'number' && trimTailMs > 0) {
        const idx = next.findIndex(i => i.id === first.id)
        const target = next[idx] as ArrangementItem
        const body = Math.max(0, target.srcOutMs - target.srcInMs - trimTailMs)
        const applied = Math.max(0, target.srcOutMs - target.srcInMs - body)
        if (applied > 0) {
          next[idx] = { ...target, srcOutMs: target.srcOutMs - applied }
          endAfterTrim = first.timelineStartMs + itemDurationMs(next[idx] as ArrangementItem)
          changes.push({
            itemId: target.id,
            kind: 'trim-tail',
            deltaMs: -applied,
            reason: 'tighten：修剪前一段尾部静音（PCM 域扫描结果）',
          })
        }
      } else {
        changes.push({
          itemId: first.id,
          kind: 'none',
          deltaMs: 0,
          reason: 'tighten：未提供 trimTailMs（尾部静音扫描需在 PCM 域做，见 audio/trim.ts）',
        })
      }
      moveTo(second, endAfterTrim + TIGHTEN_GAP_MS, `tighten：紧贴前一段结束 + ${TIGHTEN_GAP_MS} ms`)
      break
    }

    default:
      changes.push({ itemId: second.id, kind: 'none', deltaMs: 0, reason: `未知策略 ${String(strategy)}，未改动` })
  }

  return { items: next, strategy, changes }
}

/**
 * 一键消解全部同轨重叠（批量操作 = 一次撤销，docs/13 §4.8）。
 *
 * 实现要点：**每轮只消解时间上最靠前的一处冲突，然后重新检测**。
 * 不能「按原始位置排序后一次遍历」—— 后移一段会改变与下一段的先后关系，
 * 一次遍历会把该后移的那一段反而往前挪（本项目实测过的 bug）。
 *
 * @throws 不抛异常；返回最终 items 与全部改动明细
 */
export function resolveAllSameTrackOverlaps(
  items: ArrangementItem[],
  strategy: ArrangeStrategy = 'serialize',
  opts: OverlapOptions = {},
): OverlapResolution {
  const minGapMs = opts.minGapMs ?? ARRANGE_DEFAULTS.minGapMs
  const maxCrossTrack = opts.maxCrossTrackOverlapMs ?? ARRANGE_DEFAULTS.maxCrossTrackOverlapMs
  const maxGapMs = opts.maxGapMs ?? ARRANGE_DEFAULTS.maxGapMs
  let current = [...items]
  const changes: OverlapResolution['changes'] = []

  // keep 是有意保留交叠，批量消解对它没有意义
  if (strategy === 'keep') {
    return { items: current, strategy, changes: [] }
  }

  // 每次消解都严格把某一段往后推，因此轮数有上界；上限只是防御性兜底
  const maxRounds = items.length + 2
  for (let round = 0; round < maxRounds; round++) {
    const report = detectOverlaps(current, {
      maxCrossTrackOverlapMs: maxCrossTrack,
      maxGapMs,
    })
    if (report.sameTrack.length === 0) break

    // 取「涉及的最早起点」最小的一处冲突
    const startOf = (id: Id): number => current.find(i => i.id === id)?.timelineStartMs ?? Number.POSITIVE_INFINITY
    const next = [...report.sameTrack].sort(
      (x, y) => Math.min(startOf(x.a), startOf(x.b)) - Math.min(startOf(y.a), startOf(y.b)),
    )[0] as SameTrackOverlapInfo

    const res = resolveOverlap(current, next.a, next.b, strategy, { ...opts, minGapMs })
    if (res.changes.every(c => c.kind === 'none')) break // 无法再推进（防御死循环）
    current = res.items
    changes.push(...res.changes)
  }
  return { items: current, strategy, changes }
}
