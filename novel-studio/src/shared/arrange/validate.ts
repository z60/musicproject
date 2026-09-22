/**
 * Novel Studio · 对轨校验（docs/13 §5，11 种 issue）
 * ============================================================================
 * | kind | 含义 |
 * |------|------|
 * | missing_line             | 画本行无片段（缺录） |
 * | unarranged_line          | 有片段但不在方案条目里（渲染会丢音频；重新自动排布） |
 * | orphan_segment           | 片段无画本行（画本删过行） |
 * | same_track_overlap       | 同轨重叠（必须修） |
 * | cross_track_overlap_warn | 跨轨重叠过大（> maxCrossTrackOverlapMs） |
 * | long_gap                 | 非首尾的过长静音（> 5 s） |
 * | short_segment            | < 200 ms |
 * | long_segment             | > 60 s |
 * | silent_segment           | RMS < -60 dBFS（录成了静音） |
 * | clipped_segment          | 削波 |
 * | file_missing             | 音频文件丢失 |
 * | wrong_order              | 轨内时间顺序与画本 seq 顺序**相反**（几乎一定是错绑） |
 *
 * ★ `wrong_order` 是抓「人工匹配错误」的高价值检查：
 *   把第 50 行录的内容绑到了第 20 行时，时间线上就会出现「顺序颠倒」。
 *
 * 失败语义：不抛异常（校验本身永不失败）；调用方据 `issues` 决定是否阻断导出
 *           （缺录行 → 预检阻断，见 `ffmpeg/quality.ts` 的 preCheck）。
 */

import { ARRANGE_DEFAULTS } from '../constants.ts'
import type {
  AlignIssueKind,
  ArrangementItem,
  ArrangementValidation,
  Id,
  TrackId,
} from '../types.ts'
import { computeChapterDuration, itemDurationMs } from './layout.ts'
import { detectOverlaps } from './overlap.ts'

/** 校验输入里的画本行（由 repository 层组装，避免算法层依赖数据库） */
export interface ValidateLineInput {
  lineId: Id
  seq: number
  trackId: TrackId
  chapterId?: Id
  /** 已绑定片段；null = 缺录 */
  segmentId?: Id | null
}

/** 校验输入里的片段 */
export interface ValidateSegmentInput {
  segmentId: Id
  lineId?: Id | null
  chapterId?: Id
  durationMs: number
  rmsDb?: number | null
  peakDb?: number | null
  /** 文件是否存在（fs.stat 结果）；undefined = 未检查，不报 file_missing */
  fileExists?: boolean
  flags?: string[]
}

export interface ValidateArrangementInput {
  items: ArrangementItem[]
  /** 该章的全部画本行（含缺录行） */
  lines: ValidateLineInput[]
  /** 该章用到的片段（可选；缺省则不做 silent/clipped/file_missing 检查） */
  segments?: ValidateSegmentInput[]
  opts?: {
    maxCrossTrackOverlapMs?: number
    maxGapMs?: number
    minSegmentMs?: number
    maxSegmentMs?: number
    /** 低于此 RMS 视为静音片段，默认 -60 dBFS */
    silentRmsDb?: number
    /** 削波判定峰值（默认 -0.1 dBFS，即基本贴顶） */
    clipPeakDb?: number
    tailSilenceMs?: number
  }
}

/**
 * 校验一份对轨结果（docs/13 §5）。
 *
 * @throws 不抛异常
 */
export function validateArrangement(input: ValidateArrangementInput): ArrangementValidation {
  const opts = input.opts ?? {}
  const maxCrossTrack = opts.maxCrossTrackOverlapMs ?? ARRANGE_DEFAULTS.maxCrossTrackOverlapMs
  const maxGap = opts.maxGapMs ?? ARRANGE_DEFAULTS.maxGapMs
  const minSegmentMs = opts.minSegmentMs ?? ARRANGE_DEFAULTS.minSegmentMs
  const maxSegmentMs = opts.maxSegmentMs ?? ARRANGE_DEFAULTS.maxSegmentMs
  const silentRmsDb = opts.silentRmsDb ?? ARRANGE_DEFAULTS.silentRmsDb
  const clipPeakDb = opts.clipPeakDb ?? -0.1

  const issues: ArrangementValidation['issues'] = []
  const warnings: string[] = []
  const pushIssue = (kind: AlignIssueKind, message: string, lineId: Id | null, itemId: Id | null): void => {
    issues.push({ kind, message, lineId, itemId })
    warnings.push(message)
  }

  // ---- 1. 缺录行 / 孤儿片段 ------------------------------------------------
  const itemByLine = new Map<Id, ArrangementItem>()
  for (const it of input.items) if (!itemByLine.has(it.lineId)) itemByLine.set(it.lineId, it)
  const lineById = new Map<Id, ValidateLineInput>()
  for (const l of input.lines) lineById.set(l.lineId, l)

  // 「缺录」的权威定义是**没有片段**（voice_segments，见 001_init.sql 的 v_missing_lines
  // 与 export.service.ts）。这里**不能**用「方案里没有条目」来判缺录 —— 那是「还没排布」。
  // 两者混同的后果（真机）：一章 87 行、87 个片段，却因为 arrangements 为空而报「缺录 87 行」。
  const missingLines: Id[] = []
  const unarrangedLines: Id[] = []
  for (const line of input.lines) {
    const hasSegment = line.segmentId != null
    if (!hasSegment) {
      missingLines.push(line.lineId)
      pushIssue('missing_line', `第 ${line.seq} 行还没有录音（缺录）`, line.lineId, null)
    } else if (!itemByLine.has(line.lineId)) {
      unarrangedLines.push(line.lineId)
      pushIssue(
        'unarranged_line',
        `第 ${line.seq} 行有录音但不在当前方案里：重新「自动排布」把它排进时间线，否则导出会漏掉这段音频`,
        line.lineId,
        null,
      )
    }
  }

  const orphanSegments: Id[] = []
  for (const it of input.items) {
    if (!lineById.has(it.lineId)) {
      orphanSegments.push(it.segmentId)
      pushIssue('orphan_segment', '该片段对应的画本行已被删除', it.lineId, it.id)
    }
  }

  // ---- 2. 重叠与长空隙 ----------------------------------------------------
  const report = detectOverlaps(input.items, {
    maxCrossTrackOverlapMs: maxCrossTrack,
    maxGapMs: maxGap,
  })
  const sameTrackOverlaps = report.sameTrack.map(o => ({ a: o.a, b: o.b, overlapMs: o.overlapMs }))
  for (const o of report.sameTrack) {
    const it = input.items.find(x => x.id === o.b)
    pushIssue(
      'same_track_overlap',
      `同一轨道内两段重叠 ${Math.round(o.overlapMs)} ms（同一人不能同时说两句），必须消解`,
      it?.lineId ?? null,
      o.b,
    )
  }
  const crossTrackOverlaps: ArrangementValidation['crossTrackOverlaps'] = report.crossTrack.map(o => ({
    a: o.a,
    b: o.b,
    overlapMs: o.overlapMs,
    level: o.level,
  }))
  for (const o of report.crossTrack) {
    if (o.level !== 'warning') continue // 跨轨 ≤ 3000 ms 属于正常对话，不报错
    const it = input.items.find(x => x.id === o.b)
    pushIssue(
      'cross_track_overlap_warn',
      `跨轨重叠 ${Math.round(o.overlapMs)} ms 超过上限 ${maxCrossTrack} ms，建议串行化`,
      it?.lineId ?? null,
      o.b,
    )
  }
  const longGaps = report.longGaps.map(g => ({ afterLineId: g.afterLineId, gapMs: g.gapMs }))
  for (const g of report.longGaps) {
    pushIssue(
      'long_gap',
      `「${g.afterLineId}」之后有 ${(g.gapMs / 1000).toFixed(1)} s 无人说话，可能缺录了一行`,
      g.afterLineId,
      g.afterItemId,
    )
  }

  // ---- 3. 片段级检查（需要 segments 数据） --------------------------------
  const segById = new Map<Id, ValidateSegmentInput>()
  for (const s of input.segments ?? []) segById.set(s.segmentId, s)

  const shortSegments: Id[] = []
  const longSegments: Id[] = []
  for (const it of input.items) {
    const seg = segById.get(it.segmentId)
    const duration = seg ? seg.durationMs : itemDurationMs(it)
    if (duration < minSegmentMs) {
      shortSegments.push(it.segmentId)
      pushIssue('short_segment', `片段只有 ${Math.round(duration)} ms（< ${minSegmentMs} ms）`, it.lineId, it.id)
    } else if (duration > maxSegmentMs) {
      longSegments.push(it.segmentId)
      pushIssue('long_segment', `片段长达 ${(duration / 1000).toFixed(1)} s（> ${maxSegmentMs / 1000} s）`, it.lineId, it.id)
    }

    if (seg) {
      if (typeof seg.rmsDb === 'number' && Number.isFinite(seg.rmsDb) && seg.rmsDb < silentRmsDb) {
        pushIssue('silent_segment', `片段 RMS ${seg.rmsDb.toFixed(1)} dBFS 低于 ${silentRmsDb} dBFS（像是录成了静音）`, it.lineId, it.id)
      } else if (seg.rmsDb === Number.NEGATIVE_INFINITY) {
        pushIssue('silent_segment', '片段是数字静音（没有任何信号）', it.lineId, it.id)
      }
      const clipped = (seg.flags ?? []).includes('clip') || (typeof seg.peakDb === 'number' && seg.peakDb >= clipPeakDb)
      if (clipped) {
        pushIssue('clipped_segment', `片段存在削波（峰值 ${seg.peakDb === null || seg.peakDb === undefined ? '未知' : seg.peakDb.toFixed(2)} dBFS）`, it.lineId, it.id)
      }
      if (seg.fileExists === false) {
        pushIssue('file_missing', '片段文件不存在（渲染时会跳过，请重新录制或重新定位文件）', it.lineId, it.id)
      }
    }
  }
  // 画本行绑定了片段、但该片段不在 items 里 → 也算孤儿
  for (const line of input.lines) {
    if (line.segmentId && !input.items.some(it => it.segmentId === line.segmentId)) {
      if (!orphanSegments.includes(line.segmentId)) {
        orphanSegments.push(line.segmentId)
        pushIssue('orphan_segment', `第 ${line.seq} 行绑定的片段不在对轨结果中`, line.lineId, null)
      }
    }
  }

  // ---- 4. wrong_order：轨内时间顺序与画本 seq 顺序相反 --------------------
  const wrongOrderItems: ArrangementItem[] = []
  const byTrack = new Map<TrackId, ArrangementItem[]>()
  for (const it of input.items) {
    const list = byTrack.get(it.trackId)
    if (list) list.push(it)
    else byTrack.set(it.trackId, [it])
  }
  for (const [trackId, trackItems] of byTrack) {
    const sorted = [...trackItems].sort((a, b) => {
      const sa = lineById.get(a.lineId)?.seq ?? 0
      const sb = lineById.get(b.lineId)?.seq ?? 0
      return sa - sb
    })
    for (let i = 0; i + 1 < sorted.length; i++) {
      const prev = sorted[i] as ArrangementItem
      const next = sorted[i + 1] as ArrangementItem
      // 画本顺序在前、时间线却在后 → 顺序颠倒（几乎一定是错绑）
      if (next.timelineStartMs < prev.timelineStartMs) {
        wrongOrderItems.push(next)
        const prevSeq = lineById.get(prev.lineId)?.seq ?? -1
        const nextSeq = lineById.get(next.lineId)?.seq ?? -1
        pushIssue(
          'wrong_order',
          `轨道「${trackId}」内第 ${nextSeq} 行的时间位置（${next.timelineStartMs} ms）早于第 ${prevSeq} 行（${prev.timelineStartMs} ms），顺序与画本相反，**疑似错绑**`,
          next.lineId,
          next.id,
        )
      }
    }
  }
  if (wrongOrderItems.length > 0) {
    warnings.push(`检出错绑嫌疑 ${wrongOrderItems.length} 处：请检查这些行的录音内容是否与画本行匹配`)
  }

  return {
    missingLines,
    unarrangedLines,
    orphanSegments,
    sameTrackOverlaps,
    crossTrackOverlaps,
    longGaps,
    shortSegments,
    longSegments,
    issues,
    totalDurationMs: computeChapterDuration(input.items, opts.tailSilenceMs ?? 0),
    warnings,
  }
}

/** 是否是阻断级问题（UI 上红标；预检里对应 blockers） */
export function isBlockingIssue(kind: AlignIssueKind): boolean {
  return (
    kind === 'missing_line' ||
    kind === 'unarranged_line' ||
    kind === 'same_track_overlap' ||
    kind === 'file_missing'
  )
}

/**
 * 只取需要人工处理的问题（按阻断性排序，供「一条一条处理」的引导模式用）。
 *
 * @throws 不抛异常
 */
export function prioritizeIssues(
  validation: ArrangementValidation,
): ArrangementValidation['issues'] {
  const weight = (kind: AlignIssueKind): number => (isBlockingIssue(kind) ? 0 : 1)
  return [...validation.issues].sort((a, b) => weight(a.kind) - weight(b.kind))
}
