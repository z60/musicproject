/**
 * 对轨域 · 重叠检测与消解（docs/13 §4.3 / §5）
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md
 *   · §4.3 必须区分**同轨重叠（必须消解）**与**跨轨重叠**：
 *        相交 ≤ `maxCrossTrackOverlapMs`（默认 3000 ms）属正常对话，保留；
 *        超过上限才列入报告（`level: 'warning'`）；长间隙（> `maxGapMs`，默认 5 s）
 *        多半是「缺录了一行」，与重叠是**不同的视觉等级**。
 *   · §4.3「逐条处理优先于全局」：每条冲突都能单独选策略（serialize / keep /
 *        compress-pause / tighten），因为「哪句该让」只有人知道。
 *   · §4.8 批量消解 = **一次撤销整批**。
 *
 * 检测与消解算法全部复用 `@shared/arrange/overlap.ts`（主进程用同一份），
 * 本文件只负责：把结果变成 UI 行、把「建议策略的效果」预演出来、把用户的选择落成 IPC。
 */

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { ArrangeStrategy, ArrangementItem, Id } from '@shared/types.ts'
import { ARRANGE_STRATEGY_LABELS } from '@shared/constants.ts'
import { formatDuration } from '@/shared/lib/format.ts'
import { useArrangementStore } from '../stores/arrangement.store.ts'

/** 四种消解策略（顺序即 UI 上的展示顺序：默认项在前） */
export const RESOLVE_STRATEGIES: ArrangeStrategy[] = ['serialize', 'compress-pause', 'tighten', 'keep']

export interface StrategyOption {
  strategy: ArrangeStrategy
  label: string
  /** 该策略「会怎么动」的一句话说明（预演结果） */
  effect: string
}

export interface SameTrackConflictRow {
  key: string
  /** 时间上靠前的一段 */
  a: Id
  b: Id
  trackId: string
  trackName: string
  overlapMs: number
  /** `42 萧炎: 我萧炎…` 这类人类可读标签（行号 + 文本前 10 字） */
  aLabel: string
  bLabel: string
  aStartMs: number
  bStartMs: number
  aEndMs: number
  bEndMs: number
}

export interface CrossTrackConflictRow {
  key: string
  a: Id
  b: Id
  overlapMs: number
  /** normal = 正常对话（保留）；warning = 超出上限（报告 + 建议串行化） */
  level: 'normal' | 'warning'
  aLabel: string
  bLabel: string
  timeMs: number
}

export interface LongGapRow {
  key: string
  afterLineId: Id
  afterItemId: Id | null
  gapMs: number
  /** 跳转位置（前一句的起点） */
  timeMs: number | null
  label: string
}

export interface UseOverlapResolver {
  strategy: Ref<ArrangeStrategy>
  busy: Ref<boolean>
  /** 最近一次操作的结果说明（状态条显示） */
  message: Ref<string>
  sameTrack: ComputedRef<SameTrackConflictRow[]>
  crossTrack: ComputedRef<CrossTrackConflictRow[]>
  /** 只保留 level='warning' 的跨轨重叠（报告里要看的那些） */
  crossTrackWarnings: ComputedRef<CrossTrackConflictRow[]>
  longGaps: ComputedRef<LongGapRow[]>
  counts: ComputedRef<{ sameTrack: number; crossTrackNormal: number; crossTrackWarning: number; longGap: number }>
  /** 四种策略 + 预演效果（弹层里展示） */
  optionsFor: (row: SameTrackConflictRow) => StrategyOption[]
  /** 逐条消解（一条撤销命令） */
  applyPair: (row: SameTrackConflictRow, strategy?: ArrangeStrategy) => Promise<boolean>
  /** 全部按同一策略处理（**一次撤销整批**，docs/13 §4.8） */
  applyAll: (strategy?: ArrangeStrategy) => Promise<number>
  /** 把策略同步为当前方案的策略（打开面板时的初值） */
  syncStrategyFromArrangement: () => void
}

function itemLabel(arrangement: ReturnType<typeof useArrangementStore>, item: ArrangementItem | null): string {
  if (!item) return '（已删除）'
  const seq = arrangement.lineSeq(item)
  const text = arrangement.lineLabel(item, 10)
  return seq === null ? text || item.id : `${seq} ${text}`
}

export function useOverlapResolver(): UseOverlapResolver {
  const arrangement = useArrangementStore()

  const strategy = ref<ArrangeStrategy>('serialize')
  const busy = ref(false)
  const message = ref('')

  const sameTrack = computed<SameTrackConflictRow[]>(() => {
    const trackName = new Map(arrangement.tracks.map(t => [t.trackId, t.name]))
    return arrangement.overlapReport.sameTrack.map((conflict) => {
      const a = arrangement.itemById(conflict.a)
      const b = arrangement.itemById(conflict.b)
      const aEndMs = a ? a.timelineStartMs + arrangement.durationOf(a) : 0
      const bEndMs = b ? b.timelineStartMs + arrangement.durationOf(b) : 0
      return {
        key: `${conflict.a}|${conflict.b}`,
        a: conflict.a,
        b: conflict.b,
        trackId: conflict.trackId,
        trackName: trackName.get(conflict.trackId) ?? conflict.trackId,
        overlapMs: conflict.overlapMs,
        aLabel: itemLabel(arrangement, a),
        bLabel: itemLabel(arrangement, b),
        aStartMs: a?.timelineStartMs ?? 0,
        bStartMs: b?.timelineStartMs ?? 0,
        aEndMs,
        bEndMs,
      }
    })
  })

  const crossTrack = computed<CrossTrackConflictRow[]>(() => {
    return arrangement.overlapReport.crossTrack.map((conflict) => {
      const a = arrangement.itemById(conflict.a)
      const b = arrangement.itemById(conflict.b)
      return {
        key: `${conflict.a}|${conflict.b}`,
        a: conflict.a,
        b: conflict.b,
        overlapMs: conflict.overlapMs,
        level: conflict.level,
        aLabel: itemLabel(arrangement, a),
        bLabel: itemLabel(arrangement, b),
        timeMs: Math.min(a?.timelineStartMs ?? 0, b?.timelineStartMs ?? 0),
      }
    })
  })

  const crossTrackWarnings = computed(() => crossTrack.value.filter(row => row.level === 'warning'))

  const longGaps = computed<LongGapRow[]>(() => {
    return arrangement.overlapReport.longGaps.map((gap) => {
      const item = arrangement.itemById(gap.afterItemId)
      return {
        key: `${gap.afterItemId}|${Math.round(gap.gapMs)}`,
        afterLineId: gap.afterLineId,
        afterItemId: gap.afterItemId ?? null,
        gapMs: gap.gapMs,
        timeMs: item?.timelineStartMs ?? null,
        label: `${formatDuration(gap.gapMs, { showMs: true })} 无人说话（多半缺录了一行）`,
      }
    })
  })

  const counts = computed(() => ({
    sameTrack: sameTrack.value.length,
    crossTrackNormal: crossTrack.value.length - crossTrackWarnings.value.length,
    crossTrackWarning: crossTrackWarnings.value.length,
    longGap: longGaps.value.length,
  }))

  /**
   * 预演：对某个策略算出「谁会被移动多少毫秒」。
   * 用 store 里的**纯函数**版本（不落库、不产生撤销记录），用户点「试试」就能看到后果。
   */
  function optionsFor(row: SameTrackConflictRow): StrategyOption[] {
    return RESOLVE_STRATEGIES.map((candidate) => {
      const changes = arrangement.previewResolution(row.a, row.b, candidate)
      const moved = changes.filter(c => c.kind === 'move' && c.deltaMs !== 0)
      const effect = moved.length
        ? moved
            .map(c => `${itemLabel(arrangement, arrangement.itemById(c.itemId))} 移动 ${c.deltaMs > 0 ? '+' : ''}${Math.round(c.deltaMs)} ms`)
            .join('；')
        : changes[0]?.reason ?? '位置不变（仅记录）'
      return {
        strategy: candidate,
        label: ARRANGE_STRATEGY_LABELS[candidate] ?? candidate,
        effect,
      }
    })
  }

  async function applyPair(row: SameTrackConflictRow, next?: ArrangeStrategy): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      const used = next ?? strategy.value
      await arrangement.flushNow() // 把拖动中的未落库改动先落库，避免消解基于旧位置
      const ok = await arrangement.resolveOverlapPair(row.a, row.b, used)
      message.value = ok
        ? `已按「${ARRANGE_STRATEGY_LABELS[used] ?? used}」消解一处重叠（${Math.round(row.overlapMs)} ms）`
        : '消解未生效'
      return ok
    } finally {
      busy.value = false
    }
  }

  /**
   * 全部按同一策略处理。
   * 撤销语义：store 的 `resolveAllOverlaps` 只在末尾 push **一条**命令，
   * 因此一次 `Ctrl+Z` 就把整批还原（docs/13 §4.8 的硬性要求）。
   */
  async function applyAll(next?: ArrangeStrategy): Promise<number> {
    if (busy.value) return 0
    busy.value = true
    try {
      const used = next ?? strategy.value
      await arrangement.flushNow()
      const handled = await arrangement.resolveAllOverlaps(used)
      message.value = handled
        ? `已按「${ARRANGE_STRATEGY_LABELS[used] ?? used}」消解 ${handled} 处同轨重叠（一次撤销可整体还原）`
        : '没有需要消解的同轨重叠'
      return handled
    } finally {
      busy.value = false
    }
  }

  function syncStrategyFromArrangement(): void {
    const current = arrangement.arrangement?.strategy
    if (current) strategy.value = current
  }

  return {
    strategy,
    busy,
    message,
    sameTrack,
    crossTrack,
    crossTrackWarnings,
    longGaps,
    counts,
    optionsFor,
    applyPair,
    applyAll,
    syncStrategyFromArrangement,
  }
}
