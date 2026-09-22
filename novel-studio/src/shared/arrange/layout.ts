/**
 * Novel Studio · 自动排布（docs/05 §5.2 / docs/13 §4.2）
 * ============================================================================
 * 算法（顺序即语义，不可调换）：
 *   把整章画本行按 seq **全局排序**，用一个 cursor 逐句往下排：
 *     cursor = headSilenceMs
 *     for line in allLines.sortBy(seq):
 *         seg = segment(line)
 *         if seg == null: continue                    # 缺录 → 记 gap，cursor 不动
 *         dur = (srcOut - srcIn) + fadeIn + fadeOut
 *         start = max(cursor + pauseAfter(prevLine), 0)
 *         if item.locked: start = item.timelineStartMs  # 尊重人工，自动排布不再移动它
 *         write item(start)                            # 轨道 = 车道，不改变时间位置
 *         cursor = start + dur
 *   章节总时长 = 最后一个 item 的结束 + tailSilenceMs
 *
 * ★ **不能**「每条轨道各自从 0 开始」：渲染是 `adelay=timelineStartMs` + `amix`
 *   （src/shared/ffmpeg/arrangement-render.ts），`timelineStartMs` 是绝对时间线位置。
 *   各轨从 0 起会把「角色第一句」和「旁白第一句」叠在一起播 —— 真机表现就是
 *   「叶海本该在中间出现，却跑到了最前面」。
 *
 * 留白优先级（docs/13 §4.2）：行级 `line.pauseAfterMs` > 角色级 > 章节级默认(500 ms)。
 *
 * ★ `computeChapterDuration()` 必须被**渲染侧**（docs/15 §3.2）复用，
 *   否则会出现「时间线显示 12:30，渲染出来 12:28」的不一致。
 *
 * 失败语义：不抛异常；排列为空时由调用方抛 `MIX_ARRANGEMENT_EMPTY`。
 */

import { ARRANGE_DEFAULTS } from '../constants.ts'
import { NARRATION_TRACK_ID, type ArrangementItem, type Id, type TrackId } from '../types.ts'

/** 时间线上的一行（= 画本行 + 它的片段与既有 item 状态） */
export interface ArrangeLineInput {
  lineId: Id
  trackId: TrackId
  /** 画本行序号（全章单调递增，跨轨唯一） */
  seq: number
  /** 已录片段；null = 缺录（记 gap，不占时间线） */
  segmentId: Id | null
  /** 源片段总时长，用于把 srcOutMs 夹在片段内 */
  segmentDurationMs?: number
  srcInMs?: number
  srcOutMs?: number
  /** 行级留白（最高优先级） */
  pauseAfterMs?: number | null
  /** 角色级默认留白（次高优先级） */
  characterPauseMs?: number | null
  /** 既有 item（人工拖过 / 锁过）——locked 时位置原样保留 */
  existing?: ExistingItemState | null
}

/** 既有 item 的人工状态（重排时唯一需要保留下来的东西） */
export interface ExistingItemState {
  id?: Id
  timelineStartMs: number
  locked: boolean
  fadeInMs?: number
  fadeOutMs?: number
  orderInTrack?: number
}

export interface AutoArrangeInput {
  arrangementId: Id
  lines: ArrangeLineInput[]
  /** 章节级默认留白，默认 500 ms（docs/05 §12） */
  defaultPauseMs?: number
  /** 章首静音：**排布阶段默认 0**，头静音在混音阶段统一补（docs/15 §3 步骤 6） */
  headSilenceMs?: number
  /** 章尾静音，默认 0（同上） */
  tailSilenceMs?: number
  /** 防爆音淡化，默认 5 ms */
  defaultFadeMs?: number
  /** id 生成器（测试可注入确定性 id；缺省用 `arr:{lineId}`） */
  idFactory?: (line: ArrangeLineInput, index: number) => Id
}

export interface AutoArrangeResult {
  items: ArrangementItem[]
  totalDurationMs: number
  /** 缺录行（画本有行、没有片段）——validate 会报 missing_line */
  gaps: Array<{ lineId: Id; trackId: TrackId; seq: number }>
  /** 轨道顺序（旁白恒为第一轨，其余按首次出场顺序） */
  trackOrder: TrackId[]
}

/**
 * 单个 item 在时间线上占用的时长。
 *
 * ★ 与 docs/13 §4.2 一致：`dur = (srcOut - srcIn) + fadeIn + fadeOut`。
 *   渲染侧与时间线**必须**用这一个函数算时长，否则两处会差出 10 ms × N。
 *   失败语义：不抛异常；srcOut <= srcIn 时返回 0。
 */
export function itemDurationMs(item: {
  srcInMs: number
  srcOutMs: number
  fadeInMs?: number
  fadeOutMs?: number
}): number {
  const body = Math.max(0, item.srcOutMs - item.srcInMs)
  return body + Math.max(0, item.fadeInMs ?? 0) + Math.max(0, item.fadeOutMs ?? 0)
}

/** item 在时间线上的终点（闭开区间 [start, end)） */
export function itemEndMs(item: { timelineStartMs: number } & Parameters<typeof itemDurationMs>[0]): number {
  return item.timelineStartMs + itemDurationMs(item)
}

/**
 * 章节总时长（docs/15 §3.2）。
 *
 * ★ 渲染侧、时间线、导出预检必须全部调用本函数（唯一来源）。
 * 失败语义：不抛异常；items 为空时返回尾静音（调用方需先抛 `MIX_ARRANGEMENT_EMPTY`）。
 */
export function computeChapterDuration(
  items: Array<Pick<ArrangementItem, 'timelineStartMs' | 'srcInMs' | 'srcOutMs' | 'fadeInMs' | 'fadeOutMs'>>,
  tailSilenceMs = 0,
): number {
  let max = 0
  for (const it of items) {
    const end = it.timelineStartMs + itemDurationMs(it)
    if (end > max) max = end
  }
  return max + Math.max(0, tailSilenceMs)
}

/**
 * 留白解析：行级 > 角色级 > 章节级（docs/13 §4.2）。
 * 失败语义：不抛异常。
 */
export function resolvePauseAfterMs(
  line: ArrangeLineInput | null,
  defaultPauseMs: number,
): number {
  if (!line) return 0
  if (typeof line.pauseAfterMs === 'number' && Number.isFinite(line.pauseAfterMs)) {
    return Math.max(0, line.pauseAfterMs)
  }
  if (typeof line.characterPauseMs === 'number' && Number.isFinite(line.characterPauseMs)) {
    return Math.max(0, line.characterPauseMs)
  }
  return Math.max(0, defaultPauseMs)
}

/** 轨道排序：旁白固定第一轨（视觉稳定），其余按该章首次出场顺序（docs/13 §4.1） */
export function orderTracks(lines: ArrangeLineInput[]): TrackId[] {
  const firstSeq = new Map<TrackId, number>()
  for (const l of lines) {
    const cur = firstSeq.get(l.trackId)
    if (cur === undefined || l.seq < cur) firstSeq.set(l.trackId, l.seq)
  }
  return [...firstSeq.keys()].sort((a, b) => {
    if (a === b) return 0
    if (a === NARRATION_TRACK_ID) return -1
    if (b === NARRATION_TRACK_ID) return 1
    const sa = firstSeq.get(a) ?? 0
    const sb = firstSeq.get(b) ?? 0
    return sa === sb ? (a < b ? -1 : 1) : sa - sb
  })
}

/**
 * 自动排布（docs/05 §5.2 / docs/13 §4.2）。
 *
 * 失败语义：不抛异常。`items` 为空时调用方抛 `MIX_ARRANGEMENT_EMPTY`
 *           （文案：该章节还没有可用的对轨结果）。
 */
export function autoArrange(input: AutoArrangeInput): AutoArrangeResult {
  const defaultPauseMs = input.defaultPauseMs ?? ARRANGE_DEFAULTS.defaultPauseMs
  const headSilenceMs = Math.max(0, input.headSilenceMs ?? 0)
  const tailSilenceMs = Math.max(0, input.tailSilenceMs ?? 0)
  const defaultFadeMs = Math.max(0, input.defaultFadeMs ?? ARRANGE_DEFAULTS.defaultFadeMs)

  const items: ArrangementItem[] = []
  const gaps: AutoArrangeResult['gaps'] = []
  const trackOrder = orderTracks(input.lines)
  let maxCursor = 0

  // ★ 一个**全局 cursor**：整章按画本 seq 串行，不按轨道各自从 0 开始。
  // 轨道只是车道（同一个人只占一条），「台词按画本顺序逐句播出」才是时间轴语义。
  const ordered = [...input.lines].sort((a, b) => a.seq - b.seq)
  const nextOrderInTrack = new Map<TrackId, number>()

  let cursor = headSilenceMs
  let prevLine: ArrangeLineInput | null = null

  for (const line of ordered) {
    // 缺录：留占位（记 gap），cursor 不动 —— 绝不为了「补齐」插入静音片段
    if (!line.segmentId) {
      gaps.push({ lineId: line.lineId, trackId: line.trackId, seq: line.seq })
      continue
    }

    const fadeInMs = line.existing?.fadeInMs ?? defaultFadeMs
    const fadeOutMs = line.existing?.fadeOutMs ?? defaultFadeMs
    const srcInMs = Math.max(0, line.srcInMs ?? 0)
    const srcOutCandidate = line.srcOutMs ?? line.segmentDurationMs ?? srcInMs
    const srcOutMs =
      typeof line.segmentDurationMs === 'number'
        ? Math.min(Math.max(srcOutCandidate, srcInMs), line.segmentDurationMs)
        : Math.max(srcOutCandidate, srcInMs)

    const pauseBeforeMs = resolvePauseAfterMs(prevLine, defaultPauseMs)
    let startMs = Math.max(cursor + pauseBeforeMs, 0)
    // 人工锁定：位置原样保留，自动排布不再移动它（docs/13 §4.2 / FR-4.8）
    if (line.existing?.locked) startMs = Math.max(0, line.existing.timelineStartMs)

    const orderInTrack = nextOrderInTrack.get(line.trackId) ?? 0
    const item: ArrangementItem = {
      id: line.existing?.id ?? input.idFactory?.(line, items.length) ?? `arr:${line.lineId}`,
      arrangementId: input.arrangementId,
      segmentId: line.segmentId,
      lineId: line.lineId,
      trackId: line.trackId,
      timelineStartMs: Math.round(startMs),
      srcInMs: Math.round(srcInMs),
      srcOutMs: Math.round(srcOutMs),
      fadeInMs,
      fadeOutMs,
      locked: line.existing?.locked ?? false,
      orderInTrack: line.existing?.orderInTrack ?? orderInTrack,
      overlapWith: null,
    }
    items.push(item)
    nextOrderInTrack.set(line.trackId, orderInTrack + 1)
    cursor = startMs + itemDurationMs(item)
    if (cursor > maxCursor) maxCursor = cursor
    prevLine = line
  }

  return {
    items,
    totalDurationMs: Math.round(maxCursor + tailSilenceMs),
    gaps,
    trackOrder,
  }
}

/**
 * 轨内重排（解锁后重跑单轨，docs/13 §4.7「解锁并重排」）。
 *
 * ⚠ **只适用于「这一轨独占整条时间线」的场景**（例如把单轨单独渲染出来做对比）。
 * 绝不能拿它去重置多轨方案里的某一轨：时间线位置是**全局绝对时间**，
 * 单轨从 0 排会和其它轨叠在一起（真机事故：角色音跑到最前面）。
 * 多轨方案的单轨重置请走 `alignment.service.ts` 的 `resetTrack` —— 它对全章做全局排布，
 * 只把目标轨的结果写回。
 *
 * @throws 不抛异常；返回只包含该轨的 items（调用方负责合并回整体）
 */
export function rearrangeTrack(
  trackItems: ArrangementItem[],
  lines: ArrangeLineInput[],
  opts: { defaultPauseMs?: number; headSilenceMs?: number; defaultFadeMs?: number } = {},
): ArrangementItem[] {
  const result = autoArrange({
    arrangementId: trackItems[0]?.arrangementId ?? 'track',
    lines: lines.map(l => ({
      ...l,
      existing: l.existing ?? null,
    })),
    defaultPauseMs: opts.defaultPauseMs,
    headSilenceMs: opts.headSilenceMs,
    defaultFadeMs: opts.defaultFadeMs,
  })
  return result.items
}
