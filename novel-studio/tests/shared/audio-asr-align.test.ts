/**
 * 测试 · 音频转文字（ASR）→ 每行区间 + ASR 输出解析
 * ============================================================================
 * 真机需求：「需要音频转文字 记录每段文字的位置后分割」。
 *
 * 这里钉住三件事（都是「改了不会报错、只会切错音频」的地方）：
 *   ① 三种 ASR 输出形状都能解析（whisper.cpp 毫秒 / openai-whisper 秒 / 自定义数组）；
 *   ② 配对上的行拿到**那一段的起止**（真正的强制对齐，而不是按字数猜）；
 *   ③ 三条不变量：每行都有区间、按顺序不重叠无缝、覆盖到音频末尾。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { alignLinesToAsr, normalizeAsrSegments } from '../../src/shared/audio/asr-align.ts'
import { parseAsrOutput } from '../../src/shared/audio/asr-output.ts'
import type { AsrSegment } from '../../src/shared/audio/text-match.ts'

function assertInvariants(
  ranges: Array<{ startMs: number; endMs: number }>,
  lines: number,
  durationMs: number,
): void {
  assert.equal(ranges.length, lines, '每行都要有区间')
  for (const r of ranges) assert.ok(r.endMs > r.startMs, `区间必须非空：${JSON.stringify(r)}`)
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(Math.abs(ranges[i]!.startMs - ranges[i - 1]!.endMs) < 0.001, '后一行起点必须等于前一行终点（无缝、不重叠）')
  }
  assert.equal(ranges[ranges.length - 1]!.endMs, durationMs, '最后一行要收到音频末尾')
}

describe('ASR 输出解析：三种形状', () => {
  it('whisper.cpp -oj（offsets 是毫秒）', () => {
    const raw = JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 4200 }, text: ' 第一句。' },
        { offsets: { from: 4200, to: 9000 }, text: ' 第二句。' },
      ],
    })
    const r = parseAsrOutput(raw)
    assert.equal(r.shape, 'whisper.cpp')
    assert.deepEqual(r.segments.map((s) => [s.startMs, s.endMs, s.text]), [
      [0, 4200, '第一句。'],
      [4200, 9000, '第二句。'],
    ])
  })

  it('whisper.cpp -ojf（额外带 tokens[]：token 级时间戳，特殊标记不进比对）', () => {
    const raw = JSON.stringify({
      transcription: [
        {
          offsets: { from: 0, to: 4200 },
          text: ' 第一句。',
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.4 },
            { text: '第一', offsets: { from: 100, to: 900 }, p: 0.9 },
            { text: '句', offsets: { from: 900, to: 1600 }, p: 0.8 },
            { text: '。', offsets: { from: 1600, to: 1600 }, p: 0.5 },
          ],
        },
      ],
    })
    const r = parseAsrOutput(raw)
    assert.equal(r.shape, 'whisper.cpp')
    assert.deepEqual(
      r.tokens.map((t) => [t.text, t.startMs, t.endMs]),
      [
        ['第一', 100, 900],
        ['句', 900, 1600],
        ['。', 1600, 1600],
      ],
    )
  })

  it('openai-whisper --output_format json（start/end 是秒）', () => {
    const raw = JSON.stringify({ segments: [{ start: 1.5, end: 3, text: ' 你好。' }] })
    const r = parseAsrOutput(raw)
    assert.equal(r.shape, 'openai-whisper')
    assert.deepEqual(r.segments.map((s) => [s.startMs, s.endMs]), [[1500, 3000]])
  })

  it('自定义脚本（本项目约定：毫秒 + camelCase）', () => {
    const r = parseAsrOutput(JSON.stringify([{ startMs: 0, endMs: 1000, text: '甲' }]))
    assert.equal(r.shape, 'plain')
    assert.equal(r.segments.length, 1)
  })

  it('非法输入不抛错，返回空 + 原因（由调用方退回 VAD）', () => {
    for (const raw of ['', '不是 JSON', JSON.stringify({ foo: 1 })]) {
      const r = parseAsrOutput(raw)
      assert.equal(r.segments.length, 0)
      assert.equal(r.shape, 'unknown')
      assert.ok(r.warnings.length > 0)
    }
  })
})

describe('分段归一化', () => {
  it('丢掉空文本/零长度，按起点排序', () => {
    const segs = normalizeAsrSegments([
      { startMs: 5000, endMs: 6000, text: '第二' },
      { startMs: 0, endMs: 1000, text: '第一' },
      { startMs: 1000, endMs: 1000, text: '零长度' },
      { startMs: 7000, endMs: 8000, text: '   ' },
    ])
    assert.deepEqual(segs.map((s) => s.text), ['第一', '第二'])
  })
})

describe('按识别文本强制对齐（记录每段文字的位置后分割）', () => {
  const LINES = [
    { lineId: 'L1', text: '邵大亨闻言，心里咯噔一声。' },
    { lineId: 'L2', text: '石志坚冷冷看了众人一眼。' },
    { lineId: 'L3', text: '有邵大亨和刘真雄开口，其他人也跟着附和。' },
  ]

  it('配对上的行，区间就等于那一段识别结果的起止（下一段起点为界）', () => {
    const segments: AsrSegment[] = [
      { startMs: 800, endMs: 5200, text: '邵大亨闻言心里咯噔一声' },
      { startMs: 6000, endMs: 9400, text: '石志坚冷冷看了众人一眼' },
      { startMs: 12000, endMs: 18500, text: '有邵大亨和刘真雄开口其他人也跟着附和' },
    ]
    const r = alignLinesToAsr({ segments, lines: LINES, durationMs: 20_000 })
    assert.equal(r.matchedCount, 3)
    assert.equal(r.unclaimedLines, 0)
    assert.equal(r.usable, true)
    // 第一行从识别段起点开始；到第二段起点结束（句间停顿归前一行）
    assert.equal(r.ranges[0]!.startMs, 800)
    assert.equal(r.ranges[0]!.endMs, 6000)
    assert.equal(r.ranges[1]!.endMs, 12_000)
    assert.equal(r.ranges[2]!.endMs, 20_000)
    assert.match(r.ranges[0]!.reasons[0]!, /识别文本对齐/)
    assertInvariants(r.ranges, LINES.length, 20_000)
  })

  it('识别文本多了标点/少了标点也能配上（归一化比对）', () => {
    const segments: AsrSegment[] = LINES.map((l, i) => ({
      startMs: i * 5000,
      endMs: i * 5000 + 4000,
      text: l.text.replace(/[，。]/g, ''),
    }))
    const r = alignLinesToAsr({ segments, lines: LINES, durationMs: 15_000 })
    assert.equal(r.matchedCount, 3, '去标点后应当全配上')
  })

  it('配不上的行按前后段位置 + 字数插值，并进复核清单；未配对比例过高则判为不可用', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 4000, text: '邵大亨闻言心里咯噔一声' },
      { startMs: 9000, endMs: 13_000, text: '有邵大亨和刘真雄开口其他人也跟着附和' },
    ]
    const r = alignLinesToAsr({ segments, lines: LINES, durationMs: 15_000 })
    assert.equal(r.unclaimedLines, 1, '中间那行没有对应识别段')
    assert.ok(r.needsReview.includes('L2'), '插值出来的行必须进复核清单')
    assert.ok(r.ranges[1]!.endMs > r.ranges[1]!.startMs, '插值也要给出非空区间')
    assertInvariants(r.ranges, LINES.length, 15_000)
    // 未配对占比 1/3 ≤ 0.4 → 仍可用
    assert.equal(r.usable, true)
    const strict = alignLinesToAsr({ segments, lines: LINES, durationMs: 15_000, maxUnmatchedRatio: 0.2 })
    assert.equal(strict.usable, false, '未配对比例超过上限时要判为不可用（调用方退回 VAD）')
  })

  /**
   * 真机回归（2221 章旁白，whisper.cpp `-ojf` 的真实形状）：
   * 「邵大亨闻言…当众承认失败！如果是的话，这也太打脸了！」
   * 这一行横跨两个识别段，后半句在第二段里。旧实现（段 ↔ 行一对一 + 按停顿切）
   * 把尾音切没了 —— 用户报的就是「如果是的话，这也太打脸了！没了」。
   */
  it('一行横跨两个识别段：尾音必须留在本行（2221 章回归）', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 10000, text: '邵大亨聞言心裡咯噔一聲手中端著的茶水差點見出來' },
      { startMs: 10000, endMs: 19000, text: '猜測石志堅是不是要讓他兌現諾言當眾承認失敗如果是的話那這也太打臉了' },
      { startMs: 19000, endMs: 26000, text: '邵大亨劉真雄等人表情很不自然' },
    ]
    const tokens = [
      { text: '邵大亨聞言', startMs: 3400, endMs: 4500 },
      { text: '手中端著的茶水差點見出來', startMs: 6200, endMs: 9800 },
      { text: '猜測石志堅是不是要讓他兌現諾言', startMs: 10000, endMs: 14000 },
      { text: '當眾承認失敗', startMs: 14100, endMs: 15800 },
      { text: '如果是的話', startMs: 16570, endMs: 17100 },
      { text: '那這也太打臉了', startMs: 17480, endMs: 18880 },
      { text: '邵大亨劉真雄等人', startMs: 19000, endMs: 21000 },
    ]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        {
          lineId: 'L1',
          text: '邵大亨闻言，心里咯噔一声，手中端着茶水差点溅出，猜测石志坚是不是要让他兑现诺言，当众承认失败！如果是的话，这也太打脸了！',
        },
        { lineId: 'L2', text: '邵大亨，刘真雄等人表情很不自然' },
      ],
      durationMs: 26_000,
    })
    assert.equal(r.usable, true)
    assert.equal(r.unclaimedLines, 0)
    // 尾音（打脸了）落在 18.9s 之前，本行区间必须盖住它
    assert.ok(r.ranges[0]!.endMs >= 18_880, '尾音不能被切掉（旧实现止步于 15.76s）')
    assert.equal(r.ranges[0]!.startMs, 0, '开头那段也要给第一行')
    assert.equal(r.ranges[1]!.startMs, r.ranges[0]!.endMs)
    assert.ok(
      r.ranges[0]!.reasons.some((x) => /token/.test(x)),
      '用了 token 级时间戳要在原因里写清楚',
    )
    assertInvariants(r.ranges, 2, 26_000)
  })

  it('没有识别结果时返回空 + 不可用（调用方据此退回 VAD）', () => {
    const r = alignLinesToAsr({ segments: [], lines: LINES, durationMs: 15_000 })
    assert.deepEqual(r.ranges, [])
    assert.equal(r.usable, false)
    assert.deepEqual(r.needsReview, ['L1', 'L2', 'L3'])
  })
})
