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

  /**
   * 真机回归（2221 章，用户复报）：
   * 「【石志坚笑了，端起茶杯饮一口，看向众人。】的切割有问题，而且还有一些下一句的音放上一句里面了」。
   *
   * 现场是：whisper 把第 9 行的开头听成了「實至間端起了茶杯」，逐字比对认不出来（字全不一样），
   * 于是它们成了「谁都没认领的夹层」。旧实现把夹层整段塞给第 8 行 —— 用户听到的就是
   * 第 8 行的 take 里带着第 9 行的开头，而第 9 行只剩 2.4 秒。
   */
  it('真机回归：下一行没被认出来的开头不许塞给上一行（严格）', () => {
    const segments: AsrSegment[] = [
      {
        startMs: 0,
        endMs: 9000,
        text: '有邵大亨和劉真雄開口其他人也跟著附和實至間端起了茶杯引了一口看向了眾人',
      },
    ]
    const tokens = [
      { text: '有邵大亨和劉真雄開口', startMs: 0, endMs: 1500 },
      { text: '其他人也跟著附和', startMs: 1500, endMs: 2900 },
      // 逗号 token 自己横跨 520ms（真机里就是这样），停顿要按「真字→真字」量
      { text: ',', startMs: 3200, endMs: 3720 },
      { text: '實至間', startMs: 3720, endMs: 4600 },
      { text: '端起了茶杯', startMs: 4600, endMs: 5600 },
      { text: '引了', startMs: 5600, endMs: 6000 },
      { text: '一口', startMs: 6100, endMs: 6600 },
      { text: '看向了眾人', startMs: 6600, endMs: 7600 },
    ]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        { lineId: 'L8', text: '有邵大亨和刘真雄开口，其他人也跟着附和。' },
        { lineId: 'L9', text: '石志坚笑了，端起茶杯饮一口，看向众人。' },
      ],
      durationMs: 9000,
    })
    const l8 = r.ranges[0]!
    const l9 = r.ranges[1]!
    assert.ok(l8.endMs <= 3720, '上一行的右界不能越过那 520ms 的停顿（实际 ' + l8.endMs + '）')
    assert.equal(l9.startMs, l8.endMs, '两行必须无缝相接')
    assert.ok(l9.endMs - l9.startMs >= 5000, '第 9 行要拿回自己的开头（旧实现只剩 2.4 秒）')
    assert.ok(
      l8.reasons.some((x) => /夹层切点/.test(x)),
      '右界依据要写进 reasons，便于抽查',
    )
    assert.ok(r.usable)
  })

  /**
   * 反过来的一半：夹层确实是**前一行没被识别出来的尾音**时（真机：轉動著悲伸），
   * 它必须留在前一行 —— 否则就是另一个方向的错位（前一行尾音没了）。
   * 这里靠「识别段边界在夹层之后」判定。
   */
  it('真机回归：前一行没被认出来的尾音要留在前一行', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 2400, text: '石志堅捏著茶杯轉動著悲伸。' },
      { startMs: 2510, endMs: 3400, text: '邵大亨等人愣住了' },
    ]
    const tokens = [
      { text: '石志堅捏著茶杯', startMs: 0, endMs: 1200 },
      { text: '轉動', startMs: 1200, endMs: 1600 },
      { text: '著', startMs: 1600, endMs: 1800 },
      { text: '悲', startMs: 1800, endMs: 2000 },
      { text: '伸', startMs: 2000, endMs: 2200 },
      { text: '。', startMs: 2200, endMs: 2400 },
      { text: '邵大亨等人愣住了', startMs: 2510, endMs: 3400 },
    ]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        { lineId: 'L20', text: '石志坚捏着茶杯转动杯身：' },
        { lineId: 'L21', text: '邵大亨等人愣住了' },
      ],
      durationMs: 3400,
    })
    assert.ok(r.ranges[0]!.endMs >= 2400, '尾音（轉動著悲伸）必须留在前一行')
    assert.equal(r.ranges[1]!.startMs, r.ranges[0]!.endMs)
    assert.equal(r.ranges[1]!.endMs, 3400)
    assertInvariants(r.ranges, 2, 3400)
  })
  /**
   * 真机回归（2221 章 seq 32 → 33）：夹层（没对上的行）不许吃掉下一行的**句子开头**。
   * 现场：第 33 行的「实际上，作为香港最大的电影公司」是 S11 段的第一句，而它第一个**命中**的字
   * 在 99429 —— 旧实现让夹层一直吃到 99429，于是第 33 行丢了 1.4 秒开头。
   */
  it('真机回归：夹层不许越过下一行的句子起点（段头像下一行时）', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 3000, text: '第一句台词。' },
      { startMs: 4000, endMs: 9000, text: '實至間捏著茶杯轉動' },
    ]
    const tokens = [
      { text: '第一句台词', startMs: 0, endMs: 2000 },
      { text: '。', startMs: 2000, endMs: 2400 },
      // S1 的段头「實至間」（石志坚的误识）—— 下一行的开头，但下一行只认得出「捏著茶杯」
      { text: '實至間', startMs: 4000, endMs: 4900 },
      { text: '捏著茶杯', startMs: 5000, endMs: 6000 },
      { text: '轉動', startMs: 6000, endMs: 6800 },
    ]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '第一句台词。' },
        { lineId: 'L2', text: '第二句台词。' }, // 录音里没念 → 只能插值
        { lineId: 'L3', text: '石志坚捏着茶杯转动杯身。' },
      ],
      durationMs: 9000,
    })
    assert.equal(r.ranges[1]!.endMs, 4000, '夹层最多到段头（4000），不能吃到下一行第一个命中字（~5100）')
    assert.equal(r.ranges[2]!.startMs, 4000, '下一行要拿回自己的句子开头')
    assert.ok(r.ranges[1]!.endMs - r.ranges[1]!.startMs >= 120, '插值行也要有非空区间，不能是 1ms')
    assertInvariants(r.ranges, 3, 9000)
  })

  /**
   * 反过来：段头那几个单位明明更像**没对上的那几行**（就是它们的音频），就不设这个上界。
   * 否则会把它们本来就该有的时间送给下一行。
   */
  it('段头更像没对上的那一行时，不设上界（夹层保留到下一行第一个命中字）', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 3000, text: '第一句台词。' },
      { startMs: 4000, endMs: 9000, text: '第二句台詞實至間捏著茶杯' },
    ]
    const tokens = [
      { text: '第一句台词', startMs: 0, endMs: 2000 },
      { text: '。', startMs: 2000, endMs: 2400 },
      // 段头就是「第二句台词」—— 它是 L2 的音频（只是没被逐字认出来）
      { text: '第二句台詞', startMs: 4000, endMs: 5200 },
      { text: '實至間捏著茶杯', startMs: 6000, endMs: 7200 },
    ]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '第一句台词。' },
        { lineId: 'L2', text: '第二句台词。' },
        { lineId: 'L3', text: '石志坚捏着茶杯转动杯身。' },
      ],
      durationMs: 9000,
    })
    assert.ok(r.ranges[1]!.endMs > 4000, '段头是 L2 自己的音频，夹层不该被 4000 截断')
    assert.equal(r.ranges[2]!.startMs, r.ranges[1]!.endMs)
    assertInvariants(r.ranges, 3, 9000)
  })
  /**
   * 真机回归（2221 章，用户第三次复报）：
   * 「【石志坚笑了…】音频的最后有下一段的杂音【众】，该音不应该出现」。
   *
   * 现场：右界原来取的是下一行第一个命中字的**中心**（多字 token 里那个字的中点），
   * 于是把下一句开头「众」的起音切进了上一行。修法有两条：
   *   ① 锚点一律用字的**起点**（firstBoundaryMs）而不是字中心；
   *   ② 再加一道硬约束：右界绝不越过「下一行第一个命中单位的起点」。
   */
  it('真机回归：右界不许切进下一行第一个字的里面（「众」起音）', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 2000, text: '第一句台词。' },
      { startMs: 2200, endMs: 5000, text: '众人心中一凉' },
    ]
    const tokens = [
      { text: '第一句台词', startMs: 0, endMs: 1200 },
      { text: '。', startMs: 1200, endMs: 1600 },
      // 下一行第一个命中单位是**一个字以上的 token**：起点 2200（字中心会是 2350）
      { text: '众人心中一凉', startMs: 2200, endMs: 3400 },
    ]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '第一句台词。' },
        { lineId: 'L2', text: '众人心中一凉。' },
      ],
      durationMs: 5000,
    })
    assert.equal(r.ranges[0]!.endMs, 2200, '右界必须落在「众」的起点，而不是这个字的中心 2350')
    assert.equal(r.ranges[1]!.startMs, 2200, '下一行从「众」的起点开始，才能听见完整的那一下')
    assertInvariants(r.ranges, 2, 5000)
  })
  /**
   * 真机回归（2221 章，第四次复报 —— 这次是**音频侧**的证据）：
   * 「音频的最后还是有下一段的杂音【众】，我需要治本的方法」。
   *
   * 真机实测（应用用的 base 模型）：
   *   · 识别把下一句的「众」报在 36900（于是边界也落在 36900/36990）；
   *   · 但音频里那个字其实从 **37138** 才开始（静音区间 36399~37138 是 ffmpeg 量出来的）；
   *   · 于是「上一行」的 take 末尾离下一句开头只有 148~238ms ——
   *     播放器又是按 timeupdate（~250ms）停的，冲过头就把那个字放出来了。
   *
   * 治本：把边界吸附到**静音区间的中心**，给两边都留出几百毫秒余量。
   */
  it('真机回归：边界吸附到音频量出来的静音（「众」起音再也不在上一行）', () => {
    // 两段：停顿「。」属于上一段，「眾」起新段 —— 于是识别只给到 36900
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 36_500, text: '端起茶杯饮一口看向众人。' },
      { startMs: 36_900, endMs: 40_000, text: '眾人心中一凉' },
    ]
    const tokens = [
      { text: '一', startMs: 34_550, endMs: 34_640 },
      { text: '口', startMs: 34_940, endMs: 34_940 },
      { text: '看', startMs: 35_330, endMs: 35_510 },
      { text: '向', startMs: 35_510, endMs: 35_700 },
      { text: '眾', startMs: 35_890, endMs: 36_080 },
      { text: '人', startMs: 36_080, endMs: 36_260 }, // ← 上一行自己认出来的「人」结束在 36260
      { text: '。', startMs: 36_260, endMs: 36_900 },
      { text: '眾', startMs: 36_900, endMs: 37_080 }, // ← 识别说下一行的「众」从 36900 开始
      { text: '人', startMs: 37_080, endMs: 37_260 },
      { text: '心', startMs: 37_260, endMs: 37_440 },
    ]
    // ffmpeg 量出来的：这段停顿是 36399~37138 —— 37.138s 才是「众」真正的起点
    const silences = [{ startMs: 36_399, endMs: 37_138 }]
    const input = {
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '端起茶杯饮一口，看向众人。' },
        { lineId: 'L2', text: '众人心中一凉。' },
      ],
      durationMs: 40_000,
    }
    const raw = alignLinesToAsr(input)
    const snapped = alignLinesToAsr({ ...input, silences })
    assert.equal(raw.ranges[0]!.endMs, 36_900, '只靠识别时边界会贴到 36900（离真正的字只剩 238ms）')
    assert.equal(snapped.ranges[0]!.endMs, 36_650, '吸附后落在静音中心（36399~37138 与窗口交集的中点）')
    assert.equal(snapped.ranges[1]!.startMs, 36_650)
    assert.ok(37_138 - raw.ranges[0]!.endMs <= 250, '识别给的边界只离真正的字 238ms（播放器一冲就露出来）')
    assert.ok(37_138 - snapped.ranges[0]!.endMs >= 400, '吸附后到下一句第一个字至少留 400ms 余量')
    assert.ok(snapped.ranges[0]!.endMs >= 36_260, '不会切进上一行自己认出来的话')
    assert.ok(snapped.ranges[0]!.endMs <= 36_900, '也不会把下一行认出来的话留下')
    assert.ok(
      snapped.ranges[0]!.reasons.some((x) => /吸附到静音/.test(x)),
      '右界依据要写进 reasons',
    )
    assertInvariants(snapped.ranges, 2, 40_000)
  })
  /**
   * 真机回归（2221 章，第五次复报：「切的太多了，在【众人】的众就断了」）：
   *
   * 这次是**识别把边界切在上一行自己的字里面**：small 模型把「看向众人」的
   * 「眾人」拆成 35500/35700 与 36000/36400 两对，DP 把后一对判给了下一行，
   * 于是上一行的右界落在 36000 —— 正好切在它自己的「众」上。
   *
   * 音频实测（34.5~38.5s 的语音串）：上一行的「看向众人」一直说到 **36400**，
   * 句末停顿是 **36400~37138**，下一句真正的「众人」从 **37138** 才开始。
   * 所以正解是「吸到那个停顿里」，而 token 给出的窗口 [35700, 36000] 里根本没有静音 ——
   * 这正是退路（nearestSilenceCenter）存在的理由。
   */
  it('真机回归：token 窗口里没有静音时，按音频找最近的停顿（不再切在上一行自己的字里）', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 36_000, text: '端起茶杯饮一口看向众人。' },
      { startMs: 36_000, endMs: 46_000, text: '眾人心中一凉' },
    ]
    const tokens = [
      { text: '看', startMs: 35_200, endMs: 35_290 },
      { text: '向', startMs: 35_290, endMs: 35_400 },
      { text: '了', startMs: 35_400, endMs: 35_500 },
      { text: '眾', startMs: 35_500, endMs: 35_570 },
      { text: '人', startMs: 35_700, endMs: 35_700 },
      { text: '。', startMs: 35_950, endMs: 36_000 },
      // ↓ 识别把这一对判给了下一行，于是上一行右界落在 36000（切在自己的「众」上）
      { text: '眾', startMs: 36_000, endMs: 36_200 },
      { text: '人', startMs: 36_200, endMs: 36_400 },
      { text: '心', startMs: 36_400, endMs: 36_600 },
      { text: '中', startMs: 36_800, endMs: 36_800 },
      { text: '一', startMs: 36_940, endMs: 37_000 },
      { text: '涼', startMs: 37_000, endMs: 37_570 },
    ]
    // 音频量出来的句末停顿（34.5~38.5s 只有这一段够长）
    const silences = [{ startMs: 36_400, endMs: 37_138 }]
    const input = {
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '看向众人。' },
        { lineId: 'L2', text: '众人心中一凉。' },
      ],
      durationMs: 46_000,
    }
    const raw = alignLinesToAsr(input)
    const snapped = alignLinesToAsr({ ...input, silences })
    assert.equal(raw.ranges[0]!.endMs, 36_000, '只靠识别时右界落在 36000 —— 上一行的「众人」正说到 36400')
    assert.equal(snapped.ranges[0]!.endMs, 36_769, '吸附后落在句末停顿 36400~37138 的中心')
    assert.equal(snapped.ranges[1]!.startMs, 36_769)
    assert.ok(snapped.ranges[0]!.endMs > 36_400, '上一行自己的话（说到 36400）必须完整')
    assert.ok(37_138 - snapped.ranges[0]!.endMs >= 300, '下一句真正的字（37138）还留 300ms 以上余量')
    assertInvariants(snapped.ranges, 2, 46_000)
  })
  /**
   * 真机复报（2221 章旁白第 13 行「石志坚像是会读心术，目光灼灼，」）：
   *
   * whisper-small 的那一段（68–78s）里挤了**两句话**，段尾 token 被压缩 ——
   * 识别报「邵」在 77.03s，而窗口复听证明它真正的开口是 74.17s。
   * 于是上一行（15 字）被排成 7.44s（2.0 字/秒），末尾混进了下一句的前 1.6s。
   * 音频里 72.90–74.17s 有一段 1.26s 的句末停顿 —— 真正的边界在那儿。
   *
   * 修法：本行**明显过长**（超过本文件语速估出的 1.5 倍）时，把右界改到它后半段里
   * 最长的那段停顿（落在停顿里，不切字）；只会往前挪，绝不会让本行多吞音频。
   */
  it('真机回归：识别段尾 token 被压缩导致「本行过长」时，右界改到后面的停顿里', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 7_440, text: '石志坚像是会读心术，目光灼灼，邵大亨等人被石志坚问得无比惭愧。' },
      { startMs: 7_440, endMs: 12_010, text: '邵大亨等人被石志坚问得无比惭愧。' },
      { startMs: 12_010, endMs: 18_010, text: '众人心中一凉，差点忘了这家伙手中有大杀器。' },
    ]
    const tokens = [
      // L1：前 10 字说到 4200，随后是一段停顿（4200~5100），再说「目光灼灼，」
      ...['石', '志', '坚', '像', '是', '会', '读', '心', '术', '，'].map((t, i) => ({
        text: t,
        startMs: i * 500,
        endMs: i * 500 + 450,
      })),
      { text: '，', startMs: 4_150, endMs: 4_200 },
      { text: '目', startMs: 5_200, endMs: 5_300 },
      { text: '光', startMs: 5_500, endMs: 5_600 },
      { text: '灼', startMs: 6_000, endMs: 6_100 },
      { text: '灼', startMs: 6_300, endMs: 6_400 },
      { text: '，', startMs: 6_700, endMs: 7_000 },
      // L2：识别把它的第一句从 7440 报起（真实开口更早 —— 这里就是被压缩的那一段）
      ...[
        '邵', '大', '亨', '等', '人', '被', '石', '志',
        '坚', '问', '得', '无', '比', '惭', '愧', '。',
      ].map((t, i) => ({ text: t, startMs: 7_440 + i * 160, endMs: 7_440 + i * 160 + 150 })),
      // L3
      ...['众', '人', '心', '中', '一', '凉', '，', '差', '点', '忘', '了', '这', '家', '伙', '手', '中', '有', '大', '杀', '器', '。'].map(
        (t, i) => ({ text: t, startMs: 12_010 + i * 280, endMs: 12_010 + i * 280 + 260 }),
      ),
    ]
    const silences = [{ startMs: 4_200, endMs: 5_100 }]
    const input = {
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '石志坚像是会读心术，目光灼灼，' },
        { lineId: 'L2', text: '邵大亨等人被石志坚问得无比惭愧。' },
        { lineId: 'L3', text: '众人心中一凉，差点忘了这家伙手中有大杀器。' },
      ],
      durationMs: 18_010,
    }
    const raw = alignLinesToAsr(input)
    assert.equal(raw.matchedCount, 3)
    assert.equal(raw.ranges[0]!.endMs, 7_440, '只靠识别时右界贴着下一行的首字（7440）—— 本行 15 字却占了 7.44s')

    const fixed = alignLinesToAsr({ ...input, silences })
    assert.ok(
      fixed.ranges[0]!.endMs >= 4_200 && fixed.ranges[0]!.endMs <= 5_100,
      '右界必须落在那段停顿里，实际 ' + fixed.ranges[0]!.endMs,
    )
    assert.ok(fixed.ranges[0]!.endMs < 7_440, '必须往前挪（下一句的开头不许留在本行）')
    assert.equal(fixed.ranges[1]!.startMs, fixed.ranges[0]!.endMs, '下一行起点跟着前移，边界仍然无缝')
    assert.ok(
      fixed.ranges[0]!.reasons.some((x) => /明显过长/.test(x)),
      '依据要写进 reasons：' + fixed.ranges[0]!.reasons.join('；'),
    )
    assertInvariants(fixed.ranges, 3, 18_010)
  })

  it('语速正常的行即使内部有停顿也不动（不误伤）', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 4_300, text: '石志坚像是会读心术，目光灼灼，' },
      { startMs: 4_300, endMs: 8_600, text: '邵大亨等人被石志坚问得无比惭愧。' },
      { startMs: 8_600, endMs: 13_000, text: '众人心中一凉，差点忘了这家伙手中有大杀器。' },
    ]
    const flat = (startMs: number, chars: string[], step: number) =>
      chars.map((t, i) => ({ text: t, startMs: startMs + i * step, endMs: startMs + i * step + step - 40 }))
    const tokens = [
      ...flat(0, ['石', '志', '坚', '像', '是', '会', '读', '心', '术', '，', '目', '光', '灼', '灼', '，'], 280),
      ...flat(4_300, ['邵', '大', '亨', '等', '人', '被', '石', '志', '坚', '问', '得', '无', '比', '惭', '愧', '。'], 260),
      ...flat(8_600, ['众', '人', '心', '中', '一', '凉', '，', '差', '点', '忘', '了', '这', '家', '伙', '手', '中', '有', '大', '杀', '器', '。'], 200),
    ]
    // 一段 500ms 的停顿落在第一行内部（语气停顿，不是句间边界）
    const silences = [{ startMs: 2_000, endMs: 2_500 }]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '石志坚像是会读心术，目光灼灼，' },
        { lineId: 'L2', text: '邵大亨等人被石志坚问得无比惭愧。' },
        { lineId: 'L3', text: '众人心中一凉，差点忘了这家伙手中有大杀器。' },
      ],
      durationMs: 13_000,
      silences,
    })
    assert.equal(r.ranges[0]!.endMs, 4_300, '语速正常（15 字 / 4.3s）就不该被动，停顿时长只有 500ms')
  })

  /**
   * 真机复报（2221 章旁白第 13 行 = 第 13 条旁白，同一次导入的第 13/14 行也一并复报）：
   *
   * 「画本有、这段录音里没念」的行只能给**占位音**（并进复核清单）。老实现把占位区间
   * 排在 45.76–46.40s —— 前半是上一句「…怎么办？」的尾音（说到 45.87s），
   * 后半才是 45.87–47.17s 那段停顿。于是用户试听「邵大亨等人一脸诧异。」，
   * 听到的是**上一句的结尾** —— 只能报「音频和文本错误」。
   *
   * 修法：占位组优先整组放进附近的停顿里（占位音是干净静音），前一行顺延吃到停顿起点。
   */
  it('真机回归：没对上的行的占位音放进停顿里（不再混进上一句尾音/下一句开头）', () => {
    const segments: AsrSegment[] = [
      { startMs: 0, endMs: 45_360, text: '众人心中一凉差点忘了这家伙手中有大杀器' },
      { startMs: 46_000, endMs: 52_000, text: '轰地一声犹如惊雷' },
    ]
    const l1Chars = ['众', '人', '心', '中', '一', '凉', '，', '差', '点', '忘', '了', '这', '家', '伙', '手', '中', '有', '大', '杀', '器']
    const l4Chars = ['轰', '地', '一', '声', '，', '犹', '如', '惊', '雷', '。']
    const tokens = [
      ...l1Chars.map((t, i) => ({ text: t, startMs: i * 2_200, endMs: i * 2_200 + 1_800 })),
      // 一个谁都没认领的单位（识别把上一句的问号听成了别的），它就是「上一行右界的下一单位起点」
      { text: '?', startMs: 45_360, endMs: 45_500 },
      // 下一行（对上了）的第一个单位从 46.00s 起
      ...l4Chars.map((t, i) => ({ text: t, startMs: 46_000 + i * 600, endMs: 46_000 + i * 600 + 500 })),
    ]
    const silences = [{ startMs: 45_873, endMs: 47_174 }]
    const r = alignLinesToAsr({
      segments,
      tokens,
      lines: [
        { lineId: 'L1', text: '众人心中一凉，差点忘了这家伙手中有大杀器' },
        { lineId: 'L2', text: '邵大亨等人一脸诧异。' },
        { lineId: 'L3', text: '石志坚继续道：' },
        { lineId: 'L4', text: '轰地一声，犹如惊雷。' },
      ],
      durationMs: 52_000,
      silences,
    })
    assert.equal(r.unclaimedLines, 2, 'L2/L3 在录音里没有 — 它们只能拿占位音')
    assert.ok(r.ranges[1]!.startMs >= 45_873, '占位行必须落在停顿里，实际 ' + r.ranges[1]!.startMs)
    assert.ok(r.ranges[2]!.endMs <= 47_174, '占位行不许越过停顿（否则带进下一句开头）')
    assert.ok(r.ranges[1]!.endMs > r.ranges[1]!.startMs)
    assert.ok(r.ranges[2]!.endMs > r.ranges[2]!.startMs)
    assertInvariants(r.ranges, 4, 52_000)
  })

  it('没有识别结果时返回空 + 不可用（调用方据此退回 VAD）', () => {
    const r = alignLinesToAsr({ segments: [], lines: LINES, durationMs: 15_000 })
    assert.deepEqual(r.ranges, [])
    assert.equal(r.usable, false)
    assert.deepEqual(r.needsReview, ['L1', 'L2', 'L3'])
  })
})
