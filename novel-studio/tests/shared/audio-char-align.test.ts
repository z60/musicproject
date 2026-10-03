/**
 * 测试 · 逐字单调对齐（`char-align.ts`）
 * ============================================================================
 * 真机需求：「2221 章里 【…如果是的话，这也太打脸了！】的后面没了」。
 *
 * 这个文件钉住四类「改了不会报错、只会切错音频」的情况：
 *   ① 一行文字**横跨两个识别单位**（长句）→ 尾音必须还在；
 *   ② 两行文字被并进**同一个识别单位**（短句连读）→ 要在单位内部切开；
 *   ③ 画本里有、音频里没念的行 → 只能跳过它，**不能让后面的行整体错位**；
 *   ④ 识别输出是繁体（whisper `zh` 的常态）→ 折叠后仍要高命中。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { alignCharsMonotone, foldVariants, type TimedText } from '../../src/shared/audio/char-align.ts'

describe('繁简折叠', () => {
  it('常见繁体字折成简体；未知字原样保留', () => {
    assert.equal(foldVariants('承認失敗'), '承认失败')
    assert.equal(foldVariants('這也太大臉了'), '这也太大脸了')
    assert.equal(foldVariants('邵大亨'), '邵大亨', '本来就不是繁体字的不动')
    assert.equal(foldVariants(''), '')
  })
})

describe('逐字单调对齐', () => {
  it('一行横跨两个单位：首字与尾字都算在它自己头上（尾音不会没）', () => {
    const units: TimedText[] = [
      { text: '邵大亨聞言', startMs: 3400, endMs: 4500 },
      { text: '心裡咯噔一聲', startMs: 4600, endMs: 6100 },
      { text: '手中端著的茶水差點見出來', startMs: 6200, endMs: 9800 },
      // ↓ 一行文字横跨两个识别单位：前半句在上一单位，后半句在这个单位
      { text: '猜測石志堅是不是要讓他兌現諾言', startMs: 10000, endMs: 14000 },
      { text: '當眾承認失敗', startMs: 14100, endMs: 15800 },
      { text: '如果是的話那這也太打臉了', startMs: 16500, endMs: 19000 },
      { text: '邵大亨劉真雄等人表情很不自然這是在故意炫耀嗎', startMs: 19300, endMs: 24000 },
    ]
    const lines = [
      { lineId: 'L1', text: '邵大亨闻言，心里咯噔一声，手中端着茶水差点溅出，猜测石志坚是不是要让他兑现诺言，当众承认失败！如果是的话，这也太打脸了！' },
      { lineId: 'L2', text: '邵大亨，刘真雄等人表情很不自然，这是在故意炫耀吗？' },
    ]
    const r = alignCharsMonotone(units, lines)
    const l1 = r.spans[0]!
    // 识别把「溅出」听成「見出來」这类改不过来的同音/形近错，命中率不可能 100%；这里要的是「几乎全中」
    assert.ok(
      l1.coverage >= 0.88,
      '长句应当几乎整行命中（实际 ' + l1.matchedChars + '/' + l1.totalChars + '）',
    )
    assert.ok(l1.firstMs! <= 4000, '首字落在第一个单位里')
    assert.ok(l1.lastMs! >= 18500, '尾字必须落在最后那个单位里（真机症状就是这里没了）')
    assert.equal(l1.endHintMs, 19300, '右界 = 最后一个命中单位的下一个单位起点')
    assert.ok(r.matchRatio > 0.8)
    assert.deepEqual(r.unmatchedUnits, [])
  })

  it('两行被并进同一个单位：按「下一行首字」在单位内部切开', () => {
    // 一个单位里连着念了两行
    const units: TimedText[] = [{ text: '甲乙丙丁戊己庚辛', startMs: 0, endMs: 8000 }]
    const lines = [
      { lineId: 'L1', text: '甲乙丙丁' },
      { lineId: 'L2', text: '戊己庚辛' },
    ]
    const r = alignCharsMonotone(units, lines)
    const [l1, l2] = [r.spans[0]!, r.spans[1]!]
    assert.equal(l1.coverage, 1)
    assert.equal(l2.coverage, 1)
    assert.equal(l1.lastUnit, l2.firstUnit, '两行确实落在同一个单位里')
    assert.ok(l1.lastMs! < l2.firstMs!, '后一行的首字一定晚于前一行的尾字')
    assert.equal(r.matchRatio, 1)
  })

  it('画本里有、音频里没念的行：跳过它，后面的行不能跟着错位', () => {
    const units: TimedText[] = [
      { text: '第一句台词', startMs: 0, endMs: 3000 },
      // 第二行（画本里有）音频里根本没念 —— 中间什么都没有
      { text: '第三句台词', startMs: 9000, endMs: 12000 },
      { text: '第四句台词', startMs: 13000, endMs: 16000 },
    ]
    const lines = [
      { lineId: 'L1', text: '第一句台词' },
      { lineId: 'L2', text: '第二句台词' },
      { lineId: 'L3', text: '第三句台词' },
      { lineId: 'L4', text: '第四句台词' },
    ]
    const r = alignCharsMonotone(units, lines)
    /**
     * 「第二句台词」和「第三句台词」共享了 4/5 个字，所以「第一行对上前两个单位」
     * 与「第二行对上前两个单位」是**并列最优**（总命中数一样）—— 算法不承诺具体归属。
     * 真正必须成立的是：没念的那一行不能把后面的行带偏。
     */
    assert.equal(r.spans[2]!.coverage, 1, '错位会在这里暴露：第三行必须整行对上')
    assert.equal(r.spans[3]!.coverage, 1)
    assert.ok(Math.abs(r.spans[2]!.firstMs! - 9000) < 1500, '第三行的首字必须落在 9s 那个单位里')
    assert.ok(Math.abs(r.spans[3]!.firstMs! - 13000) < 1500)
    // 前两行一共只能认领第一个单位的 5 个字：一个字都不能多（多出来就是从后面偷的）
    assert.equal(r.spans[0]!.matchedChars + r.spans[1]!.matchedChars, 5)
    assert.equal(r.spans[0]!.firstUnit, 0)
    assert.equal(r.spans[0]!.lastUnit !== null || r.spans[1]!.firstUnit === 0, true)
    assert.ok(r.matchRatio > 0.6)
  })

  it('识别输出是繁体时照样高命中（折繁比对）', () => {
    const units: TimedText[] = [
      { text: '邵大亨承認失敗當眾承認', startMs: 0, endMs: 4000 },
      { text: '如果是的話那這也太打臉了', startMs: 4000, endMs: 8000 },
    ]
    const lines = [{ lineId: 'L1', text: '邵大亨承认失败，当众承认！如果是的话，那这也太打脸了' }]
    const r = alignCharsMonotone(units, lines)
    assert.equal(r.spans[0]!.coverage, 1, '繁体不改字形也要全命中')
    assert.equal(r.matchRatio, 1)
  })

  it('输入为空 → 空结果（不抛错）', () => {
    const empty = alignCharsMonotone([], [{ lineId: 'L1', text: '甲' }])
    assert.equal(empty.spans.length, 1)
    assert.equal(empty.spans[0]!.coverage, 0)
    assert.equal(empty.matchRatio, 0)
    assert.deepEqual(empty.unmatchedUnits, [])
    assert.deepEqual(alignCharsMonotone([{ text: '甲', startMs: 0, endMs: 1 }], []).spans, [])
  })

  it('超过动态规划上限时退回贪心（不抛错，简单情况仍然全对）', () => {
    const units: TimedText[] = [
      { text: '甲乙丙', startMs: 0, endMs: 1000 },
      { text: '丁戊己', startMs: 1000, endMs: 2000 },
    ]
    const lines = [
      { lineId: 'L1', text: '甲乙丙' },
      { lineId: 'L2', text: '丁戊己' },
    ]
    const r = alignCharsMonotone(units, lines, { maxDpCells: 1 })
    assert.equal(r.matchRatio, 1)
    assert.equal(r.spans[0]!.lastUnit, 0)
    assert.equal(r.spans[1]!.firstUnit, 1)
  })
})
