/**
 * 测试 · 切句 ↔ 画本行的**文本比对**内核（ASR 路线）
 * ============================================================================
 * 设计依据：docs/12 §4.3、docs/13 §8.2、docs/91 §5.2.49
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/audio-text-match.test.ts
 *
 * ### 这组测试要证明的核心价值
 *
 *   纯时长对齐最怕「**多切/少切一句**」：错一句，后面**全部顺移**。
 *   文本比对不怕 —— 它是按内容认领的。
 *   所以下面有一组「**注入顺移**」的用例：明明整体错位，文本比对仍能把
 *   大部分行正确认领回来。这才是接 ASR 的意义所在。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  diceCoefficient,
  durationPrior,
  isAutoAcceptable,
  matchAsrToLines,
  normalizeForCompare,
  orderPrior,
  type AsrSegment,
  type MatchableLine,
} from '../../src/shared/audio/text-match.ts'

// ---------------------------------------------------------------------------
// 归一化与相似度
// ---------------------------------------------------------------------------

describe('文本归一化', () => {
  it('丢掉标点与空白（ASR 不输出标点，画本满是标点）', () => {
    assert.equal(normalizeForCompare('“你好，世界！”'), '你好世界')
    assert.equal(normalizeForCompare('你好 世界'), '你好世界')
    assert.equal(normalizeForCompare('（OS）你听。'), 'os你听')
  })

  it('丢零宽字符、大小写折叠', () => {
    assert.equal(normalizeForCompare('A\u200bB'), 'ab')
  })

  it('空与脏输入不抛错', () => {
    for (const v of ['', '   ', null, undefined, 0]) {
      assert.doesNotThrow(() => normalizeForCompare(v as unknown as string))
    }
  })
})

describe('Dice 系数（字符级多重集）', () => {
  it('完全相同 → 1；完全不相干 → 0', () => {
    assert.equal(diceCoefficient('石志坚', '石志坚'), 1)
    assert.equal(diceCoefficient('甲乙丙', '丁戊己'), 0)
  })

  it('标点差异不影响（归一化后相同）', () => {
    assert.equal(diceCoefficient('“你怕他们？”', '你怕他们'), 1)
  })

  /**
   * 这是 ASR 场景最典型的噪声：**同音字**。
   * 判据必须容忍到「还能认出是同一句」的程度。
   */
  it('同音字仍保持高相似度', () => {
    const s = diceCoefficient('石志坚', '石志间')
    assert.ok(s > 0.6 && s < 1, `同音字相似度应在 (0.6,1)，实际 ${s}`)
  })

  it('口语填充词只造成小幅下降（不该判定为不同句）', () => {
    const s = diceCoefficient('你怕他们', '嗯你怕他们')
    assert.ok(s >= 0.7, `插入一个填充词后仍应 ≥0.7，实际 ${s}`)
  })

  it('完全不同的句子被判低分（防止乱配）', () => {
    const s = diceCoefficient('这是一句完全不同的话', '你怕他们')
    assert.ok(s < 0.34, `不相关句子应低于接受下限，实际 ${s}`)
  })

  it('两侧任一为空 → 0（识别失败时不该乱配）', () => {
    assert.equal(diceCoefficient('', '内容'), 0)
    assert.equal(diceCoefficient('内容', ''), 0)
  })

  it('对称（dice(a,b) === dice(b,a)）', () => {
    const a = '石志坚莞尔一笑'
    const b = '石志间莞尔一笑'
    assert.equal(diceCoefficient(a, b), diceCoefficient(b, a))
  })

  /**
   * ⚠️ 已知局限（写进测试是为了**让它可见**，而不是假装没有）：
   * Dice 用多重集，不计顺序，所以短句换序会被判为完全相同。
   * 真实链路靠「顺序先验 + 时长先验 + 人工确认」兜住，但这确实是本判据的边界。
   */
  it('已知局限：多重集不计顺序，短句换序被判为相同', () => {
    assert.equal(diceCoefficient('甲乙', '乙甲'), 1)
  })
})

// ---------------------------------------------------------------------------
// 先验
// ---------------------------------------------------------------------------

describe('顺序先验', () => {
  it('相对位置一致 → 高分；差得越远分越低', () => {
    // 5 段 / 5 行：第 0 段配第 0 行
    assert.equal(orderPrior(0, 5, 0, 5), 1)
    // 第 0 段配第 4 行 → 最远
    assert.equal(orderPrior(0, 5, 4, 5), 0)
    // 第 2 段配第 2 行
    assert.equal(orderPrior(2, 5, 2, 5), 1)
    // 第 2 段配第 3 行 → 差一格
    assert.ok(orderPrior(2, 5, 3, 5) > 0.5)
  })

  it('单段或单行时不惩罚（没有「顺序」可言）', () => {
    assert.equal(orderPrior(0, 1, 0, 5), 1)
    assert.equal(orderPrior(0, 5, 0, 1), 1)
  })

  it('段数多于行数时（多切了一句）仍给出可用的相对分', () => {
    // 6 段 / 5 行：第 3 段相对位置 0.6，第 3 行 0.5 → 接近
    assert.ok(orderPrior(3, 6, 3, 5) > 0.7)
  })
})

describe('时长先验', () => {
  it('实际时长≈估计时长 → 1', () => {
    // 10 字 @ 5 字/秒 → 2 秒
    assert.equal(durationPrior(2000, 10, 5), 1)
  })

  it('差一倍 → 0.5 左右；差越多越低', () => {
    assert.ok(Math.abs(durationPrior(4000, 10, 5) - 0.5) < 0.01)
    assert.ok(durationPrior(8000, 10, 5) < 0.3)
  })

  it('给不出估计时返回 1（不加权也不惩罚）', () => {
    assert.equal(durationPrior(2000, 10, undefined), 1)
    assert.equal(durationPrior(2000, 10, 0), 1)
    assert.equal(durationPrior(0, 10, 5), 1)
    assert.equal(durationPrior(2000, 0, 5), 1)
  })
})

// ---------------------------------------------------------------------------
// 主匹配
// ---------------------------------------------------------------------------

/** 造一批「行」 */
function lines(texts: readonly string[]): MatchableLine[] {
  return texts.map((t, i) => ({ lineId: `L${i + 1}`, text: t, order: i }))
}

/** 造一批「ASR 段」（每段固定时长，便于控制时长先验） */
function segments(texts: readonly string[], durMs = 1500): AsrSegment[] {
  return texts.map((t, i) => ({ startMs: i * (durMs + 300), endMs: i * (durMs + 300) + durMs, text: t }))
}

describe('段 ↔ 行 配对（理想情况）', () => {
  const L = lines(['你敢自称功夫皇帝', '我倒要看看你有几斤几两', '你也看到现在我出了名', '石生您就别玩我了'])
  const S = segments(['你敢自称功夫皇帝', '我倒要看看你有几斤几两', '你也看到现在我出了名', '石生您就别玩我了'])

  it('完全一致的文本 → 全部配上、相似度 1、可自动通过', () => {
    const r = matchAsrToLines(S, L)
    assert.equal(r.matches.length, 4)
    assert.deepEqual(r.unmatchedSegments, [])
    assert.deepEqual(r.unclaimedLines, [])
    for (const m of r.matches) assert.equal(m.textSimilarity, 1)
    assert.equal(r.quality.countMatched, true)
    assert.equal(r.quality.hadContention, false)
    assert.equal(isAutoAcceptable(r).ok, true, `应当可自动通过：${JSON.stringify(isAutoAcceptable(r).reasons)}`)
  })

  it('配对是按段序号升序返回的', () => {
    const r = matchAsrToLines(S, L)
    assert.deepEqual(
      r.matches.map((m) => m.segmentIndex),
      [0, 1, 2, 3],
    )
  })

  it('每段都给出候选表（供 UI 让用户改配对）', () => {
    const r = matchAsrToLines(S, L)
    assert.equal(r.candidatesBySegment.length, 4)
    for (const list of r.candidatesBySegment) {
      assert.ok(list.length > 0)
      // 候选按得分降序
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i - 1]!.score >= list[i]!.score, '候选必须按得分降序')
      }
    }
  })
})

describe('ASR 噪声下的鲁棒性', () => {
  it('同音字 + 标点丢失仍能正确配对', () => {
    const L = lines(['石志坚莞尔一笑', '你怕他们', '这不是怕不怕的问题'])
    const S = segments(['石志间莞尔一笑', '你怕他们', '这不是怕不帕的问题'])
    const r = matchAsrToLines(S, L)
    assert.equal(r.matches.length, 3, `同音字应当能配上，实际 ${JSON.stringify(r)}`)
    assert.equal(r.quality.countMatched, true)
  })

  it('识别出空文本的段不参与配对（不猜）', () => {
    const L = lines(['第一句台词', '第二句台词'])
    const S = segments(['第一句台词', ''], 1500)
    const r = matchAsrToLines(S, L)
    assert.equal(r.matches.length, 1)
    assert.deepEqual(r.unmatchedSegments, [1], '空文本的那段应当未配对')
    assert.equal(isAutoAcceptable(r).ok, false, '有未配对段时不该自动通过')
  })

  /**
   * ⚠️ **这组是本模块存在的理由**：纯时长对齐在「多切/少切一句」时会整体顺移，
   * 而文本比对按内容认领，能把后面大部分行救回来。
   */
  it('顺序整体顺移时（多切了一句）仍能按内容正确认领', () => {
    const L = lines(['第一行', '第二行', '第三行', '第四行'])
    // 在开头插了一段识别失败的噪声，导致后面**全部顺移一格**
    const S = segments(['啊嗯这个', '第一行', '第二行', '第三行', '第四行'])

    const r = matchAsrToLines(S, L, { orderWeight: 0.25 })
    // 噪声段不该认领任何行（相似度不足）
    const noise = r.matches.find((m) => m.segmentIndex === 0)
    assert.equal(noise, undefined, '识别噪声的段不该认领行')
    assert.deepEqual(
      r.matches.map((m) => m.lineId),
      ['L1', 'L2', 'L3', 'L4'],
      '尽管段序号整体后移一格，仍应按内容认领正确的行',
    )
  })

  it('顺序先验可调：权重设为 0 时完全按文本认领', () => {
    const L = lines(['甲句', '乙句', '丙句'])
    // 段顺序被打乱（ASR 时间轴错乱）
    const S = segments(['丙句', '甲句', '乙句'])
    const r = matchAsrToLines(S, L, { orderWeight: 0 })
    assert.deepEqual(
      r.matches.map((m) => m.lineId),
      ['L3', 'L1', 'L2'],
      'orderWeight=0 时应完全按文本内容配对',
    )
  })
})

describe('争抢与不猜的纪律', () => {
  it('两段文本相同 → 只有一对被认领，另一段未配对（不重复占同一行）', () => {
    const L = lines(['对哈哈哈', '另一句完全不同的台词'])
    const S = segments(['对哈哈哈', '对哈哈哈'])
    const r = matchAsrToLines(S, L)
    const claimed = r.matches.filter((m) => m.lineId === 'L1')
    assert.equal(claimed.length, 1, '同一行只能被认领一次')
    assert.equal(r.matches.length, 1)
    assert.equal(r.unmatchedSegments.length, 1, '多出来的那一句应当未配对，交人工处理')
  })

  it('一行被切成两段 → 一段配上、另一段未配对', () => {
    const L = lines(['这是一句很长很长的台词内容'])
    const S = segments(['这是一句很长', '很长的台词内容'])
    const r = matchAsrToLines(S, L)
    assert.equal(r.matches.length, 1)
    assert.equal(r.unmatchedSegments.length, 1)
    assert.equal(r.quality.hadContention, true, '发生过争抢时应当标记出来')
    assert.equal(isAutoAcceptable(r).ok, false)
  })

  it('相似度全部不足时不硬配（宁可全不配）', () => {
    const L = lines(['甲方说的话', '乙方说的话'])
    const S = segments(['完全无关的内容', '另一段无关内容'])
    const r = matchAsrToLines(S, L)
    assert.deepEqual(r.matches, [])
    assert.equal(r.unmatchedSegments.length, 2)
    assert.equal(r.unclaimedLines.length, 2)
    assert.equal(r.quality.avgSimilarity, 0)
  })

  it('空输入不抛错', () => {
    assert.doesNotThrow(() => matchAsrToLines([], []))
    assert.deepEqual(matchAsrToLines([], []).matches, [])
    assert.deepEqual(matchAsrToLines(segments(['甲']), []).matches, [])
    assert.deepEqual(matchAsrToLines([], lines(['甲'])).matches, [])
  })
})

describe('自动通过的门槛（默认不替用户决定）', () => {
  it('段数少一行 → 不自动通过', () => {
    const L = lines(['甲句', '乙句', '丙句'])
    const S = segments(['甲句', '乙句'])
    const r = matchAsrToLines(S, L)
    const verdict = isAutoAcceptable(r)
    assert.equal(verdict.ok, false)
    assert.ok(
      verdict.reasons.some((x) => /不一致|没有|未/.test(x)),
      `应当说明原因，实际：${JSON.stringify(verdict.reasons)}`,
    )
  })

  it('平均相似度不够 → 不自动通过，并给出具体数字', () => {
    const L = lines(['甲乙丙丁戊己庚辛', '壬癸子丑寅卯辰巳'])
    const S = segments(['甲乙丙丁', '壬癸子丑'])
    const r = matchAsrToLines(S, L)
    const verdict = isAutoAcceptable(r)
    assert.equal(verdict.ok, false)
    assert.ok(verdict.reasons.join(' ').includes('相似度'), JSON.stringify(verdict.reasons))
  })

  it('门槛可调（调用方决定严格程度）', () => {
    const L = lines(['甲乙丙丁戊己庚辛'])
    const S = segments(['甲乙丙丁'])
    const r = matchAsrToLines(S, L)
    // 相似度 8/12 = 0.667
    assert.ok(Math.abs(r.matches[0]!.textSimilarity - 0.6667) < 0.001)

    // ⚠️ `isAutoAcceptable` 有**两道**门槛：单配对下限、以及平均相似度下限。
    //    只调一道是不够的（第一版测试就漏了这点）。
    //    默认平均门槛 0.75 → 0.667 过不了；把它一起放低才允许自动通过。
    assert.equal(isAutoAcceptable(r).ok, false, '默认门槛下不该通过（平均 0.667 < 0.75）')
    assert.equal(isAutoAcceptable(r, { minPerMatchSimilarity: 0.6 }).ok, false, '只清单配对门槛不够')
    assert.equal(
      isAutoAcceptable(r, { minPerMatchSimilarity: 0.6, minAvgSimilarity: 0.6 }).ok,
      true,
      '两道门槛都放低后才允许自动通过',
    )

    // 反向：调高单配对门槛就直接否掉
    assert.equal(
      isAutoAcceptable(r, { minPerMatchSimilarity: 0.9, minAvgSimilarity: 0.6 }).ok,
      false,
    )
  })
})

describe('真实形态：一个文件覆盖多行、含识别噪声', () => {
  /**
   * 模拟真实链路：某角色在一章里有 6 句台词，
   * ASR 识别出 6 段（其中 2 段有同音字、1 段丢了标点、1 段多了填充词）。
   * 期望：全部正确配对，并可自动通过。
   */
  it('6 句台词 + 混合噪声 → 全部正确配对', () => {
    const truth = [
      '扑你个街敢自称功夫皇帝',
      '香港高手辈出',
      '我倒要看看你有几斤几两',
      '你也看到现在我出了名',
      '我现在出门都不得不戴墨镜',
      '都想要同我拼命的',
    ]
    const L = lines(truth)
    const S = segments([
      '扑你个街敢自称功夫皇帝', // 完全一致
      '香港高手辈出', // 完全一致
      '我倒要看看你有几斤几量', // 同音字（两→量）
      '你也看到现在我出了明', // 同音字（名→明）
      '嗯我现在出门都不得不戴墨镜', // 多了填充词「嗯」
      '都想要同我拼命的', // 完全一致
    ])

    const r = matchAsrToLines(S, L, { charsPerSecond: 5 })
    assert.equal(r.matches.length, 6, `应当全部配上，实际 ${JSON.stringify(r.matches)}`)
    assert.deepEqual(r.unmatchedSegments, [])
    assert.deepEqual(r.unclaimedLines, [])
    for (const m of r.matches) {
      assert.equal(m.lineId, `L${m.segmentIndex + 1}`, '第 i 段应当配第 i 行')
    }
    const verdict = isAutoAcceptable(r, { minAvgSimilarity: 0.7 })
    assert.equal(verdict.ok, true, `噪声在可接受范围，应当允许自动通过：${JSON.stringify(verdict.reasons)}`)
  })

  /**
   * 时长先验的价值（第一版测试构型不成立，值得记一笔）。
   *
   * 我一开始想造「两段文本完全相同、只有时长不同」让时长单独决定配对。
   * 但短文本 + 少行数下**做不到**：识别文本对短行的相似度必然更高
   * （短行包含的字更多），文本判据先就把长行排除了。
   * 那时「时长没起作用」不代表时长无用，而是构型本身不成立。
   *
   * 所以改成验证**时长确实参与了打分**：给出语速时，
   * 得分 = 文本·0.6 + 顺序·0.25 + 时长·0.15；不给语速时时长项退化为 1。
   * 这比「编一个刚好能过的例子」更诚实，也更能防回归。
   */
  it('时长先验参与打分：给出语速后得分随「时长与字数的匹配度」变化', () => {
    const L = lines(['一句短语'])
    // 8 字 @ 5 字/秒 = 1.6 秒
    const exact = [{ startMs: 0, endMs: 1600, text: '一句短语' }]
    const tooLong = [{ startMs: 0, endMs: 6400, text: '一句短语' }]

    const rExact = matchAsrToLines(exact, L, { charsPerSecond: 5 })
    const rLong = matchAsrToLines(tooLong, L, { charsPerSecond: 5 })

    // 文本与顺序都一样，只有时长不同 ⇒ 得分必须有差异，且「时长吻合」的更高
    assert.equal(rExact.matches[0]!.textSimilarity, rLong.matches[0]!.textSimilarity)
    assert.ok(
      rExact.matches[0]!.score > rLong.matches[0]!.score,
      `时长吻合的得分应更高：${rExact.matches[0]!.score} vs ${rLong.matches[0]!.score}`,
    )

    // 不给语速 ⇒ 时长项退化为 1，两者得分应相同
    assert.equal(
      matchAsrToLines(exact, L).matches[0]!.score,
      matchAsrToLines(tooLong, L).matches[0]!.score,
      '不给语速时时长不该影响得分',
    )
  })

  /**
   * 时长**不该压过文本**：识别文本明显匹配另一行时，宁可时长奇怪也要按文本配。
   */
  it('文本与时长冲突时，文本优先', () => {
    const L = lines(['这是第一行的内容', '这是第二行的内容'])
    const S: AsrSegment[] = [{ startMs: 0, endMs: 100, text: '这是第二行的内容' }]
    const r = matchAsrToLines(S, L, { charsPerSecond: 5 })
    assert.equal(r.matches.length, 1)
    assert.equal(r.matches[0]!.lineId, 'L2', '文本明确匹配时不该被时长拉走')
  })
})
