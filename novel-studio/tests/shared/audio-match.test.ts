/**
 * 测试 · 连续录制切片 ↔ 画本行匹配（纯逻辑）
 * ============================================================================
 * 设计依据：docs/12 §4.3、docs/05 §4.2（charsPerSecond）
 *
 * ### 这组测试要钉住的是「错位的方向」
 *   匹配算法的价值不在「能匹配上」，而在**错了会往哪边错**：
 *   · 漏读一行时，后面的行不能整体错位（那会让用户看到「第 7 行对上了第 8 行的音频」）；
 *   · 多切一片（咳嗽、翻页）时，不能把后面全部行推一位（应当把多出来的切片标成「无归属」）；
 *   · 置信度必须反映真实吻合程度（完全吻合 ~1，偏差大就明显掉下去）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  confidenceOf,
  expectedLineDurationMs,
  matchSlicesToLines,
  type LineForMatch,
  type SliceForMatch,
} from '../../src/shared/audio/match.ts'

const CPS = 5 // 5 字/秒（VAD_DEFAULTS.charsPerSecond）

function slice(index: number, startMs: number, durationMs: number): SliceForMatch {
  return { sliceIndex: index, startMs, endMs: startMs + durationMs }
}

function line(id: string, charCount: number): LineForMatch {
  return { lineId: id, charCount }
}

describe('匹配 · expectedLineDurationMs', () => {
  it('字数 / 语速 = 期望时长；语速非法时按 5 字/秒兜底', () => {
    assert.equal(expectedLineDurationMs(10, { charsPerSecond: 5 }), 2000)
    assert.equal(expectedLineDurationMs(10, { charsPerSecond: 0 }), 2000, '非法语速不能变成 Infinity/NaN')
    assert.equal(expectedLineDurationMs(0, { charsPerSecond: 5 }), 1, '至少有 1ms，避免除零')
    assert.equal(expectedLineDurationMs(10, { charsPerSecond: 5, perLineOverheadMs: 500 }), 2500)
  })
})

describe('匹配 · matchSlicesToLines', () => {
  it('一一对应：时长与期望吻合时全部匹配且置信度高', () => {
    const lines = [line('l1', 10), line('l2', 15), line('l3', 5)] // 2000 / 3000 / 1000 ms
    const slices = [slice(0, 0, 2000), slice(1, 2000, 3000), slice(2, 5000, 1000)]

    const out = matchSlicesToLines(slices, lines, { charsPerSecond: CPS })
    assert.deepEqual(
      out.matches.map((m) => [m.sliceIndex, m.lineId]),
      [
        [0, 'l1'],
        [1, 'l2'],
        [2, 'l3'],
      ],
    )
    assert.deepEqual(out.unmatchedSlices, [])
    assert.deepEqual(out.unrecordedLines, [])
    assert.deepEqual(out.lowConfidenceSlices, [])
    for (const m of out.matches) assert.ok(m.confidence > 0.9, `完全吻合应接近 1，实际 ${m.confidence}`)
    assert.ok(Math.abs(out.scale - 1) < 0.01)
  })

  it('漏读一行：后面的行不错位（跳过那一行，而不是整体平移）', () => {
    // 行长度**必须可区分**，否则「跳过 l2」与「跳过 l1」在时长上等价，测不出错位
    const lines = [line('l1', 10), line('l2', 8), line('l3', 14)] // 2000 / 1600 / 2800 ms
    // 只有两片：第一片对应 l1（2000），第二片对应 l3（2800）——l2 没录
    const slices = [slice(0, 0, 2000), slice(1, 2000, 2800)]

    const out = matchSlicesToLines(slices, lines, { charsPerSecond: CPS })
    const byslice = new Map(out.matches.map((m) => [m.sliceIndex, m.lineId]))
    assert.equal(byslice.get(0), 'l1', '第一片必须对上 l1')
    assert.equal(byslice.get(1), 'l3', '第二片必须对上 l3（不能因为 l2 没录就整体平移）')
    assert.deepEqual(out.unrecordedLines, ['l2'], '没录的行必须是 l2')
  })

  it('多切一片（咳嗽/翻页）：多出来的切片标为无归属，不推挤后面的行', () => {
    const lines = [line('l1', 10), line('l2', 10)] // 2000 / 2000 ms
    const slices = [slice(0, 0, 2000), slice(1, 2000, 120), slice(2, 2120, 2000)]

    const out = matchSlicesToLines(slices, lines, { charsPerSecond: CPS })
    const byslice = new Map(out.matches.map((m) => [m.sliceIndex, m.lineId]))
    assert.equal(byslice.get(0), 'l1')
    assert.equal(byslice.get(2), 'l2')
    assert.deepEqual(out.unmatchedSlices, [1], '120ms 的杂音不该占用一条画本行')
  })

  it('明显不吻合的配对不算匹配 → 回到「没匹配上」（而不是硬塞一条低置信匹配）', () => {
    const lines = [line('l1', 10)] // 期望 2000 ms
    const bad = matchSlicesToLines([slice(0, 0, 9000)], lines, { charsPerSecond: CPS })

    assert.deepEqual(bad.matches, [], '4.5 倍偏差不是「匹配」，是「没找到」')
    assert.deepEqual(bad.unmatchedSlices, [0])
    assert.deepEqual(bad.unrecordedLines, ['l1'])
  })

  it('轻微偏差：接受但列入待复核（置信度落在 [min, review) 之间）', () => {
    const lines = [line('l1', 10)] // 期望 2000 ms
    const out = matchSlicesToLines([slice(0, 0, 3300)], lines, { charsPerSecond: CPS })
    assert.equal(out.matches.length, 1)
    const c = out.matches[0]!.confidence
    assert.ok(c >= 0.35 && c < 0.6, `1.65 倍偏差应在待复核区间，实际 ${c}`)
    assert.deepEqual(out.lowConfidenceSlices, [0])
  })

  it('空输入：不抛异常，全部如实列为未匹配', () => {
    const lines = [line('l1', 10)]
    const noSlices = matchSlicesToLines([], lines, { charsPerSecond: CPS })
    assert.deepEqual(noSlices.matches, [])
    assert.deepEqual(noSlices.unrecordedLines, ['l1'])

    const noLines = matchSlicesToLines([slice(0, 0, 1000)], [], { charsPerSecond: CPS })
    assert.deepEqual(noLines.matches, [])
    assert.deepEqual(noLines.unmatchedSlices, [0])
  })

  it('整体慢一倍：先估语速尺度再对齐（不会因为设定的语速不对就一条都匹配不上）', () => {
    const lines = [line('l1', 8), line('l2', 10), line('l3', 6)] // 1600 / 2000 / 1200 ms
    // 实际语速慢一倍 → 每片时长都是期望的两倍
    const slices = [slice(0, 0, 3200), slice(1, 3200, 4000), slice(2, 7200, 2400)]

    const out = matchSlicesToLines(slices, lines, { charsPerSecond: CPS })
    assert.deepEqual(
      out.matches.map((m) => [m.sliceIndex, m.lineId]),
      [
        [0, 'l1'],
        [1, 'l2'],
        [2, 'l3'],
      ],
      '整段语速偏差应当被估成「尺度」，而不是让每一行都变成「不吻合」',
    )
    assert.ok(out.scale > 1.8 && out.scale < 2.2, `scale 应约 2（供 UI 提示调语速），实际 ${out.scale}`)
    for (const m of out.matches) assert.ok(m.confidence > 0.9, '按尺度校正后应高置信')
  })

  it('只有一两对配对时不估尺度（样本太少，一句超长就会被误判成「语速慢一倍」）', () => {
    const lines = [line('l1', 10), line('l2', 10)]
    const slices = [slice(0, 0, 4000), slice(1, 4000, 4000)]
    const out = matchSlicesToLines(slices, lines, { charsPerSecond: CPS })
    assert.equal(out.scale, 1, '配对不足 MIN_PAIRS_FOR_RATE 时报告 scale=1，由用户自己决定是否调语速')
  })
})

describe('匹配 · confidenceOf', () => {
  it('完全吻合 = 1；容忍边界 = 0.5；越界后迅速趋零', () => {
    assert.equal(confidenceOf(1, 1.6), 1)
    assert.ok(Math.abs(confidenceOf(1.6, 1.6) - 0.5) < 0.005, `边界应约 0.5，实际 ${confidenceOf(1.6, 1.6)}`)
    assert.ok(confidenceOf(4, 1.6) < 0.2)
    assert.ok(confidenceOf(0, 1.6) >= 0, '零比值不能崩（返回有限值）')
  })

  it('对称：比值 r 与 1/r 的置信度相同（用对数比，不用差值）', () => {
    assert.equal(confidenceOf(2, 1.6), confidenceOf(0.5, 1.6))
  })
})
