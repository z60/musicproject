/**
 * Novel Studio · 重叠检测/消解 + 对轨校验单元测试
 * ============================================================================
 * 覆盖 docs/13 §4.3 §5：
 *   · 同轨重叠必须被检出（同一人不能同时说两句）
 *   · 跨轨 ≤ 3000 ms 视为正常对话，**不得**报错
 *   · 4 种消解策略（serialize / keep / compress-pause / tighten）结果正确
 *   · 长空隙（> 5 s「无人说话」）检出
 *   · 11 种校验 issue 都能被构造出来并检出，重点是 wrong_order（错绑检测）
 *
 * 运行：node --experimental-strip-types tests/shared/arrange-overlap.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { ARRANGE_DEFAULTS } from '../../src/shared/constants.ts'
import {
  TIGHTEN_GAP_MS,
  detectOverlaps,
  overlapMsOf,
  resolveAllSameTrackOverlaps,
  resolveOverlap,
} from '../../src/shared/arrange/overlap.ts'
import { prioritizeIssues, validateArrangement } from '../../src/shared/arrange/validate.ts'
import type { ArrangementItem, TrackId } from '../../src/shared/types.ts'

const NARRATION: TrackId = 'narration'
const CHAR_A: TrackId = 'char-a'
const CHAR_B: TrackId = 'char-b'

/** 造 item：默认 1000 ms 时长、无淡化（数字干净，便于断言） */
function mk(
  id: string,
  trackId: TrackId,
  timelineStartMs: number,
  srcOutMs = 1000,
): ArrangementItem {
  return {
    id,
    arrangementId: 'arr-1',
    segmentId: `seg-${id}`,
    lineId: `line-${id}`,
    trackId,
    timelineStartMs,
    srcInMs: 0,
    srcOutMs,
    fadeInMs: 0,
    fadeOutMs: 0,
    locked: false,
    orderInTrack: 0,
    overlapWith: null,
  }
}

// ---------------------------------------------------------------------------
// 检测
// ---------------------------------------------------------------------------

describe('重叠检测：同轨 vs 跨轨（docs/13 §4.3）', () => {
  it('同轨相交 → sameTrack，且明确标记 trackId', () => {
    const items = [mk('a', CHAR_A, 0), mk('b', CHAR_A, 800)]
    const r = detectOverlaps(items)
    assert.equal(r.sameTrack.length, 1)
    assert.equal(r.sameTrack[0]!.overlapMs, 200)
    assert.equal(r.sameTrack[0]!.trackId, CHAR_A)
    assert.equal(r.crossTrack.length, 0)
  })

  it('同轨接触但不重叠（end == start）→ 不算重叠', () => {
    const r = detectOverlaps([mk('a', CHAR_A, 0), mk('b', CHAR_A, 1000)])
    assert.equal(r.sameTrack.length, 0)
  })

  it('跨轨重叠 3000 ms 以内 → level=normal（正常对话，不误报）', () => {
    const items = [
      mk('n1', NARRATION, 0, 4000),
      mk('a1', CHAR_A, 1000, 3000), // 与旁白重叠 3000 ms，正好在上限
      mk('b1', CHAR_B, 2000, 2000),
    ]
    const r = detectOverlaps(items)
    assert.equal(r.sameTrack.length, 0)
    assert.ok(r.crossTrack.length > 0, '相交必须被记录（UI 要画交叠高亮）')
    assert.ok(r.crossTrack.every(o => o.level === 'normal'), '上限内的跨轨交叠不得升级为 warning')
  })

  it('跨轨重叠超过 3000 ms → level=warning', () => {
    const items = [mk('n1', NARRATION, 0, 8000), mk('a1', CHAR_A, 1000, 4000)]
    const r = detectOverlaps(items)
    const warn = r.crossTrack.filter(o => o.level === 'warning')
    assert.equal(warn.length, 1)
    assert.equal(warn[0]!.overlapMs, 4000)
  })

  it('上限可配置（maxCrossTrackOverlapMs）', () => {
    const items = [mk('n1', NARRATION, 0, 8000), mk('a1', CHAR_A, 1000, 4000)]
    const r = detectOverlaps(items, { maxCrossTrackOverlapMs: 5000 })
    assert.ok(r.crossTrack.every(o => o.level === 'normal'))
  })

  it('长空隙：全轨合并后 > 5000 ms 无人说话 → longGaps', () => {
    const items = [
      mk('n1', NARRATION, 0), // 0~1000
      mk('a1', CHAR_A, 1000), // 1000~2000（同一时刻另一轨在说，覆盖 1000~2000）
      mk('n2', NARRATION, 8000), // 与前面空出 6000 ms
    ]
    const r = detectOverlaps(items)
    assert.equal(r.longGaps.length, 1)
    assert.equal(r.longGaps[0]!.gapMs, 6000)
    assert.equal(r.longGaps[0]!.afterItemId, 'a1', '空隙归属「结束最晚」的那一段')
  })

  it('长空隙：被别的轨覆盖的间隔不算空隙', () => {
    const items = [
      mk('n1', NARRATION, 0), // 0~1000
      mk('a1', CHAR_A, 2500), // 2500~3500
      mk('b1', CHAR_B, 1500, 1000), // 1500~2500 填补了空档
    ]
    const r = detectOverlaps(items)
    assert.equal(r.longGaps.length, 0, '1500~2500 有人说话，不是空隙')
  })

  it('overlapMsOf 边界：不相交返回 0', () => {
    assert.equal(overlapMsOf(mk('a', NARRATION, 0), mk('b', CHAR_A, 1000)), 0)
    assert.equal(overlapMsOf(mk('a', NARRATION, 0), mk('b', CHAR_A, 500)), 500)
  })

  it('检测顺序稳定：同 trackId 的 a/b 按时间先后给出', () => {
    const r = detectOverlaps([mk('late', CHAR_A, 800), mk('early', CHAR_A, 0)])
    assert.deepEqual([r.sameTrack[0]!.a, r.sameTrack[0]!.b], ['early', 'late'])
  })
})

// ---------------------------------------------------------------------------
// 消解策略
// ---------------------------------------------------------------------------

describe('重叠消解：4 种策略（docs/13 §4.3）', () => {
  /** a: 0~1000，b: 800~1800 → 相交 200 ms */
  const base = (): ArrangementItem[] => [mk('a', CHAR_A, 0), mk('b', CHAR_A, 800)]
  const startOf = (items: ArrangementItem[], id: string): number =>
    (items.find(i => i.id === id) as ArrangementItem).timelineStartMs

  it('serialize：后一段移到「前一段结束 + 最小留白 50 ms」', () => {
    const r = resolveOverlap(base(), 'a', 'b', 'serialize')
    assert.equal(startOf(r.items, 'b'), 1050)
    assert.equal(r.changes[0]!.deltaMs, 250)
    // 消解后必须真的不再重叠
    assert.equal(overlapMsOf(r.items[0]!, r.items[1]!), 0)
    assert.equal(detectOverlaps(r.items).sameTrack.length, 0)
  })

  it('keep：保留交叠（有意做对话交叠），位置不变', () => {
    const r = resolveOverlap(base(), 'a', 'b', 'keep')
    assert.equal(startOf(r.items, 'b'), 800)
    assert.equal(r.changes[0]!.kind, 'none')
    assert.equal(overlapMsOf(r.items[0]!, r.items[1]!), 200)
  })

  it('compress-pause：把留白压到 0（贴着前一段结束，比 serialize 更紧）', () => {
    const r = resolveOverlap(base(), 'a', 'b', 'compress-pause')
    assert.equal(startOf(r.items, 'b'), 1000, '紧贴 end_a，间隙 0')
    assert.equal(overlapMsOf(r.items[0]!, r.items[1]!), 0)
  })

  it('compress-pause：后一段被完全覆盖时退回串行化（贴齐仍相交）', () => {
    const items = [mk('a', CHAR_A, 0, 3000), mk('b', CHAR_A, 500, 1000)] // b 完全在 a 内部
    const r = resolveOverlap(items, 'a', 'b', 'compress-pause')
    assert.equal(startOf(r.items, 'b'), 3050)
    assert.equal(overlapMsOf(r.items[0]!, r.items[1]!), 0)
  })

  it('tighten：紧贴 end_a + 20 ms，并可修剪前一段尾部静音', () => {
    const r = resolveOverlap(base(), 'a', 'b', 'tighten')
    assert.equal(startOf(r.items, 'b'), 1000 + TIGHTEN_GAP_MS)
    // 未提供 trimTailMs（PCM 扫描结果）→ 不修剪，但要在 changes 里说明
    assert.ok(r.changes.some(c => c.reason.includes('未提供 trimTailMs')))
  })

  it('tighten + trimTailMs：前一段尾部被修剪（时长变短，尾部让位）', () => {
    const r = resolveOverlap(base(), 'a', 'b', 'tighten', { trimTailMs: 40 })
    const a = r.items.find(i => i.id === 'a') as ArrangementItem
    assert.equal(a.srcOutMs, 960)
    assert.ok(r.changes.some(c => c.kind === 'trim-tail' && c.deltaMs === -40))
    assert.equal(startOf(r.items, 'b'), 960 + TIGHTEN_GAP_MS)
  })

  it('传入顺序颠倒（b 在前）也能正确消解', () => {
    const r = resolveOverlap(base(), 'b', 'a', 'serialize')
    assert.equal(startOf(r.items, 'b'), 1050, '无论参数顺序如何，都是「后一段」被后移')
  })

  it('找不到 item 或传了同一个 → 原样返回，不抛错', () => {
    const items = base()
    assert.deepEqual(resolveOverlap(items, 'a', 'nope', 'serialize').changes, [])
    assert.deepEqual(resolveOverlap(items, 'a', 'a', 'serialize').changes, [])
  })

  it('不修改原数组（撤销栈依赖纯函数语义）', () => {
    const items = base()
    resolveOverlap(items, 'a', 'b', 'serialize')
    assert.equal(items[1]!.timelineStartMs, 800, '原对象不得被就地修改')
  })

  it('批量消解：3 段互相重叠 → 全部解开且间隙 >= 50 ms', () => {
    const items = [mk('a', CHAR_A, 0), mk('b', CHAR_A, 500), mk('c', CHAR_A, 900)]
    const r = resolveAllSameTrackOverlaps(items, 'serialize')
    assert.equal(detectOverlaps(r.items).sameTrack.length, 0)
    const sorted = [...r.items].sort((x, y) => x.timelineStartMs - y.timelineStartMs)
    assert.deepEqual(sorted.map(i => i.timelineStartMs), [0, 1050, 2100])
    // 链式冲突会级联推动（第 3 段可能被推两次），changes 是供撤销用的差异清单
    assert.ok(r.changes.length >= 2, `至少两次移动，实际 ${r.changes.length}`)
    assert.ok(r.changes.every(c => c.kind === 'move'))
  })

  it('批量消解只动同一轨道，不影响别的轨', () => {
    const items = [mk('a', CHAR_A, 0), mk('b', CHAR_A, 800), mk('n', NARRATION, 800)]
    const r = resolveAllSameTrackOverlaps(items, 'serialize')
    assert.equal((r.items.find(i => i.id === 'n') as ArrangementItem).timelineStartMs, 800)
  })
})

// ---------------------------------------------------------------------------
// 校验（11 种 issue）
// ---------------------------------------------------------------------------

describe('对轨校验（docs/13 §5）：11 种 issue', () => {
  const lineOf = (id: string, seq: number, trackId: TrackId, segmentId: string | null = `seg-${id}`) => ({
    lineId: `line-${id}`,
    seq,
    trackId,
    segmentId,
  })

  it('missing_line：画本有行、没有 item（缺录）', () => {
    const v = validateArrangement({
      items: [mk('a', NARRATION, 0)],
      lines: [lineOf('a', 1, NARRATION), lineOf('b', 2, NARRATION)],
    })
    assert.deepEqual(v.missingLines, ['line-b'])
    assert.ok(v.issues.some(i => i.kind === 'missing_line'))
  })

  it('orphan_segment：item 的画本行已被删除', () => {
    const v = validateArrangement({
      items: [mk('a', NARRATION, 0), mk('ghost', NARRATION, 5000)],
      lines: [lineOf('a', 1, NARRATION)],
    })
    assert.deepEqual(v.orphanSegments, ['seg-ghost'])
    assert.ok(v.issues.some(i => i.kind === 'orphan_segment'))
  })

  it('same_track_overlap：同轨重叠（阻断级）', () => {
    const v = validateArrangement({
      items: [mk('a', CHAR_A, 0), mk('b', CHAR_A, 800)],
      lines: [lineOf('a', 1, CHAR_A), lineOf('b', 2, CHAR_A)],
    })
    assert.equal(v.sameTrackOverlaps.length, 1)
    assert.equal(v.sameTrackOverlaps[0]!.overlapMs, 200)
    assert.ok(v.issues.some(i => i.kind === 'same_track_overlap'))
  })

  it('cross_track_overlap_warn：跨轨 > 3000 ms 才报，<= 3000 ms 不报', () => {
    const okCase = validateArrangement({
      items: [mk('n', NARRATION, 0, 4000), mk('a', CHAR_A, 1000, 3000)],
      lines: [lineOf('n', 1, NARRATION), lineOf('a', 2, CHAR_A)],
    })
    assert.equal(okCase.issues.filter(i => i.kind === 'cross_track_overlap_warn').length, 0)
    assert.equal(okCase.crossTrackOverlaps[0]!.level, 'normal')

    const warnCase = validateArrangement({
      items: [mk('n', NARRATION, 0, 8000), mk('a', CHAR_A, 1000, 4000)],
      lines: [lineOf('n', 1, NARRATION), lineOf('a', 2, CHAR_A)],
    })
    assert.equal(warnCase.issues.filter(i => i.kind === 'cross_track_overlap_warn').length, 1)
  })

  it('long_gap：非首尾的 > 5 s 无人说话', () => {
    const v = validateArrangement({
      items: [mk('a', NARRATION, 0), mk('b', NARRATION, 8000)],
      lines: [lineOf('a', 1, NARRATION), lineOf('b', 2, NARRATION)],
    })
    assert.equal(v.longGaps.length, 1)
    assert.equal(v.longGaps[0]!.gapMs, 7000)
    assert.ok(v.issues.some(i => i.kind === 'long_gap'))
  })

  it('short_segment / long_segment：< 200 ms / > 60 s', () => {
    const v = validateArrangement({
      items: [mk('a', NARRATION, 0, 150), mk('b', NARRATION, 5000, 61_000)],
      lines: [lineOf('a', 1, NARRATION), lineOf('b', 2, NARRATION)],
    })
    assert.deepEqual(v.shortSegments, ['seg-a'])
    assert.deepEqual(v.longSegments, ['seg-b'])
    assert.ok(v.issues.some(i => i.kind === 'short_segment'))
    assert.ok(v.issues.some(i => i.kind === 'long_segment'))
  })

  it('silent_segment / clipped_segment / file_missing：来自片段元数据', () => {
    const v = validateArrangement({
      items: [mk('a', NARRATION, 0), mk('b', NARRATION, 5000), mk('c', NARRATION, 10_000)],
      lines: [lineOf('a', 1, NARRATION), lineOf('b', 2, NARRATION), lineOf('c', 3, NARRATION)],
      segments: [
        { segmentId: 'seg-a', durationMs: 1000, rmsDb: -72 },
        { segmentId: 'seg-b', durationMs: 1000, rmsDb: -20, peakDb: -0.02, flags: ['clip'] },
        { segmentId: 'seg-c', durationMs: 1000, rmsDb: -20, fileExists: false },
      ],
    })
    assert.ok(v.issues.some(i => i.kind === 'silent_segment'))
    assert.ok(v.issues.some(i => i.kind === 'clipped_segment'))
    assert.ok(v.issues.some(i => i.kind === 'file_missing'))
  })

  it('★★ wrong_order：轨内时间顺序与画本 seq 顺序相反 → 检出错绑', () => {
    // line 20 的内容（seg-20）被绑到了时间线 0，line 10 被放到了 8000 ms
    const items: ArrangementItem[] = [
      { ...mk('x', NARRATION, 0), lineId: 'line-20', segmentId: 'seg-20' },
      { ...mk('y', NARRATION, 8000), lineId: 'line-10', segmentId: 'seg-10' },
    ]
    const v = validateArrangement({
      items,
      lines: [
        { lineId: 'line-10', seq: 10, trackId: NARRATION, segmentId: 'seg-10' },
        { lineId: 'line-20', seq: 20, trackId: NARRATION, segmentId: 'seg-20' },
      ],
    })
    const wrong = v.issues.filter(i => i.kind === 'wrong_order')
    assert.equal(wrong.length, 1, '必须检出 1 处顺序颠倒')
    assert.equal(wrong[0]!.lineId, 'line-20', '报告「画本在后、时间线在前」的那一行')
    assert.match(wrong[0]!.message, /疑似错绑/)
    assert.ok(v.warnings.some(w => w.includes('错绑嫌疑 1 处')))
  })

  it('wrong_order 只在**同一轨**内比较（跨轨交错不算错绑）', () => {
    const items = [
      { ...mk('x', CHAR_A, 0), lineId: 'line-1' },
      { ...mk('y', NARRATION, 100), lineId: 'line-2' },
    ]
    const v = validateArrangement({
      items,
      lines: [
        { lineId: 'line-1', seq: 1, trackId: CHAR_A, segmentId: 'seg-x' },
        { lineId: 'line-2', seq: 2, trackId: NARRATION, segmentId: 'seg-y' },
      ],
    })
    assert.equal(v.issues.filter(i => i.kind === 'wrong_order').length, 0)
  })

  it('顺序正常（同轨时间随 seq 递增）不报 wrong_order', () => {
    const v = validateArrangement({
      items: [mk('a', NARRATION, 0), mk('b', NARRATION, 2000)],
      lines: [lineOf('a', 1, NARRATION), lineOf('b', 2, NARRATION)],
    })
    assert.equal(v.issues.filter(i => i.kind === 'wrong_order').length, 0)
  })

  it('totalDurationMs 用 computeChapterDuration（渲染侧同一函数）', () => {
    const v = validateArrangement({
      items: [mk('a', NARRATION, 0), mk('b', NARRATION, 2000)],
      lines: [lineOf('a', 1, NARRATION), lineOf('b', 2, NARRATION)],
      opts: { tailSilenceMs: 1500 },
    })
    assert.equal(v.totalDurationMs, 3000 + 1500)
  })

  it('阻断级问题排在最前（引导模式「一条一条处理」）', () => {
    const v = validateArrangement({
      items: [mk('a', CHAR_A, 0), mk('b', CHAR_A, 800), mk('c', CHAR_A, 9000, 150)],
      lines: [lineOf('a', 1, CHAR_A), lineOf('b', 2, CHAR_A), lineOf('c', 3, CHAR_A), lineOf('d', 4, CHAR_A)],
    })
    const ordered = prioritizeIssues(v)
    assert.equal(ordered[0]!.kind, 'missing_line', '缺录是阻断项，排第一')
    assert.ok(v.issues.length >= 4)
    assert.ok(v.warnings.length === v.issues.length)
    assert.equal(ARRANGE_DEFAULTS.minSegmentMs, 200)
  })
})
