/**
 * 测试 · 把 VAD 语音片铺满画本行（`allocate.ts`）
 * ============================================================================
 * 设计依据：docs/12 §4.3、docs/05 §4、docs/91 §5.2.49
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/audio-allocate.test.ts
 *
 * ### 这组测试的重点是**不变量**，而不是「某个具体毫秒数」
 *
 *   导入场景不允许有行拿不到音频（否则那行永远显示未录），
 *   所以最该守的是这四条不变量，任何输入都必须成立：
 *
 *     ① **每行都有区间**（除「完全没有语音片」这一种退化情形）
 *     ② **区间按顺序、不重叠**（后一行的起点 ≥ 前一行的终点）
 *     ③ **无缝**（后一行的起点 === 前一行的终点，不丢音频）
 *     ④ **覆盖到最后一片的末尾**（不把音频尾巴丢掉）
 *
 *   具体毫秒数会随算法调整而变，但这四条不能变 —— 所以断言它们。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  allocateLinesToSlices,
  type AllocatableLine,
  type SpeechSlice,
} from '../../src/shared/audio/allocate.ts'

/** 造一批等长语音片，中间留固定静音间隙 */
function slices(count: number, speechMs = 1000, gapMs = 300, startAt = 0): SpeechSlice[] {
  const out: SpeechSlice[] = []
  let t = startAt
  for (let i = 0; i < count; i++) {
    out.push({ startMs: t, endMs: t + speechMs })
    t += speechMs + gapMs
  }
  return out
}

function linesOf(texts: readonly string[]): AllocatableLine[] {
  return texts.map((t, i) => ({ lineId: `L${i + 1}`, text: t }))
}

/** 断言四条不变量 */
function assertInvariants(
  result: ReturnType<typeof allocateLinesToSlices>,
  slices: readonly SpeechSlice[],
  lineCount: number,
  expectedRanges = lineCount,
): void {
  assert.equal(result.ranges.length, expectedRanges, '区间数应等于行数')

  for (let i = 0; i < result.ranges.length; i++) {
    const r = result.ranges[i]!
    assert.ok(r.endMs > r.startMs, `第 ${i} 行区间必须非空：${r.startMs}~${r.endMs}`)
    assert.equal(r.lineId, `L${i + 1}`, '区间顺序必须与行顺序一致')
  }

  for (let i = 1; i < result.ranges.length; i++) {
    const prev = result.ranges[i - 1]!
    const cur = result.ranges[i]!
    assert.ok(cur.startMs >= prev.endMs - 0.001, `第 ${i} 行起点不得早于前一行终点（不得重叠）`)
    assert.ok(
      Math.abs(cur.startMs - prev.endMs) < 0.001,
      `第 ${i} 行起点应等于前一行终点（不得丢音频）：${cur.startMs} vs ${prev.endMs}`,
    )
  }

  if (result.ranges.length > 0) {
    assert.equal(result.ranges[0]!.startMs, slices[0]!.startMs, '第一行应从第一个语音片开始')
    assert.equal(
      result.ranges[result.ranges.length - 1]!.endMs,
      slices[slices.length - 1]!.endMs,
      '最后一行应收到最后一个语音片的末尾',
    )
  }
}

// ---------------------------------------------------------------------------

describe('退化情形：不编造区间', () => {
  it('没有语音片 → 不返回任何区间，全部标为需复核', () => {
    const r = allocateLinesToSlices([], linesOf(['甲', '乙']))
    assert.deepEqual(r.ranges, [], '没有语音片时**不能编造**区间')
    assert.deepEqual(r.needsReview, ['L1', 'L2'])
    assert.ok(
      r.warnings.some((w) => /没有检测到任何语音片/.test(w)),
      `应当说明原因，实际 ${JSON.stringify(r.warnings)}`,
    )
  })

  it('没有画本行 → 空结果 + 提示，不抛错', () => {
    const r = allocateLinesToSlices(slices(3), [])
    assert.deepEqual(r.ranges, [])
    assert.ok(r.warnings.length > 0)
    assert.equal(r.stats.lineCount, 0)
  })

  it('空输入不抛错', () => {
    assert.doesNotThrow(() => allocateLinesToSlices([], []))
  })
})

describe('吸附容忍度上限：不能为了凑停顿把边界拖走几秒', () => {
  /**
   * 真机故障（docs/91 §5.2.59）：「2221 章导入后音和文本没对上，比如旁白的第三行」。
   *
   * 起因：容忍度原本是「本行期望语音时长的一半」，一行期望 6 s 就能把边界拖到 3 s 外的
   * 某个停顿上 —— 结果每行时长与应有时长的比值在 0.34~2.43 之间，用户听到的自然是别人的句子。
   *
   * 这里的两段语音故意让「比例位置（8 s）」离最近的停顿（10 s）有 2 s：
   *   · 默认上限 600 ms → 不吸附，按比例切在 8 s（并标低置信度，进复核清单）
   *   · 把上限调到 4 s  → 复现旧行为：吸附到 10 s 的停顿
   */
  // 2 片 / 3 行（故意不走「一片一行」捷径），权重 3:2:1 → 第 1 行的比例位置在 8 s，
  // 而最近的停顿（片尾/片首）都在 10 s 处 —— 语音坐标上差 2 s。
  const S: SpeechSlice[] = [
    { startMs: 0, endMs: 10_000 },
    { startMs: 14_000, endMs: 20_000 },
  ]
  const L = linesOf(['甲甲甲', '乙乙', '丙'])

  it('远处没有「够近」的停顿 → 按比例硬切（不再跨句搬运音频）', () => {
    const r = allocateLinesToSlices(S, L)
    assert.equal(Math.round(r.ranges[0]!.endMs), 8_000, '应切在按字符比例算出的 8 s 处')
    assert.match(r.ranges[0]!.reasons[0]!, /按文本比例/)
    assert.ok(r.ranges[0]!.confidence < 0.5, '硬切必须标低置信度，进复核清单')
    assert.ok(r.needsReview.includes('L1'))
    assertInvariants(r, S, 3)
  })

  it('调大 maxSnapMs 会重新吸附到远处的停顿（旧行为，仅用于对照）', () => {
    const r = allocateLinesToSlices(S, L, { maxSnapMs: 4_000 })
    assert.equal(Math.round(r.ranges[0]!.endMs), 10_000)
    assert.match(r.ranges[0]!.reasons[0]!, /语音片末尾/)
    assert.ok(r.ranges[0]!.confidence > 0.7)
  })

  it('停顿就在比例位置附近时照样吸附（上限只挡「远跳」，不挡正常精修）', () => {
    const near: SpeechSlice[] = [
      { startMs: 0, endMs: 8_200 },
      { startMs: 9_000, endMs: 16_000 },
    ]
    const r = allocateLinesToSlices(near, L)
    assert.equal(Math.round(r.ranges[0]!.endMs), 8_200, '200 ms 的偏离应当吸附到片尾')
    assert.match(r.ranges[0]!.reasons[0]!, /语音片末尾/)
  })
})

describe('能量低谷精修：慢一点，但要切在真实的换句处', () => {
  /** 逐帧能量：默认 -20 dB（像语音），指定帧给它一个低谷 */
  function envelope(frames: number, dips: Array<[number, number, number]>): { frameMs: number; values: number[] } {
    const values = Array.from({ length: frames }, () => -20)
    for (const [from, to, db] of dips) for (let i = from; i <= to; i++) values[i] = db
    return { frameMs: 20, values }
  }

  it('片边界太远时改用能量低谷当切点（而不是切在字中间）', () => {
    const S: SpeechSlice[] = [{ startMs: 0, endMs: 20_000 }]
    const L = linesOf(['甲甲甲甲甲甲甲甲甲甲', '乙乙乙乙乙乙乙乙乙乙'])
    // 比例位置在 10 s；低谷放在 9.25 s（帧 458~462，在向左的搜索范围内），
    // 取窗口里**离目标最近**的那一帧 → 9250ms
    const energy = envelope(1000, [[458, 462, -60]])
    const withDip = allocateLinesToSlices(S, L, { energy })
    assert.equal(Math.round(withDip.ranges[0]!.endMs), 9_250)
    assert.match(withDip.ranges[0]!.reasons[0]!, /能量低谷/)
    assert.ok(withDip.ranges[0]!.confidence >= 0.5, '切在真实停顿上不该被打成「必须复核」')
  })

  it('没有能量包络时退回按字符比例切（旧行为，对照用）', () => {
    const S: SpeechSlice[] = [{ startMs: 0, endMs: 20_000 }]
    const L = linesOf(['甲甲甲甲甲甲甲甲甲甲', '乙乙乙乙乙乙乙乙乙乙'])
    const r = allocateLinesToSlices(S, L)
    assert.equal(Math.round(r.ranges[0]!.endMs), 10_000)
    assert.match(r.ranges[0]!.reasons[0]!, /按文本比例/)
  })

  it('低谷不够深（没有低于中位 3 dB）就不采用 —— 免得切在字中间', () => {
    const S: SpeechSlice[] = [{ startMs: 0, endMs: 20_000 }]
    const L = linesOf(['甲甲甲甲甲甲甲甲甲甲', '乙乙乙乙乙乙乙乙乙乙'])
    // 全程 -20 dB：没有任何「停顿」可用
    const r = allocateLinesToSlices(S, L, { energy: envelope(1000, []) })
    assert.equal(Math.round(r.ranges[0]!.endMs), 10_000)
    assert.match(r.ranges[0]!.reasons[0]!, /按文本比例/)
  })

  it('时长与字数估算差太远的行会被标出来（上一行切点偏了，这一行被挤出来）', () => {
    const S: SpeechSlice[] = [{ startMs: 0, endMs: 20_000 }]
    // 权重 3 : 1 : 30 —— 中间那行很短，只要上一行的切点偏早，它就会被拉长
    const L = linesOf(['甲甲甲', '乙', '丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙'])
    // 低谷放在 1.2 s（帧 59~61），明显早于第一行的比例位置（1875 ms）
    const energy = envelope(1000, [[59, 61, -60]])
    const r = allocateLinesToSlices(S, L, { energy })
    const second = r.ranges[1]!
    assert.match(second.reasons[0]!, /相差较大，建议复核/, `实际：${second.reasons[0]}`)
    assert.ok(second.confidence < 0.5, '可疑的行必须进复核清单')
    assert.ok(r.needsReview.includes('L2'))
  })
})
describe('一片一行（最理想）', () => {
  const S = slices(3, 1000, 300)
  const L = linesOf(['第一句', '第二句', '第三句'])

  it('片数=行数 → 高置信度、一片一行', () => {
    const r = allocateLinesToSlices(S, L)
    assert.equal(r.stats.oneToOne, true)
    assert.deepEqual(r.warnings, [], '一片一行时不该有任何警告')
    assert.equal(r.stats.avgConfidence > 0.7, true, `平均置信度应较高：${r.stats.avgConfidence}`)
    assertInvariants(r, S, 3)
  })

  it('每行区间覆盖到对应语音片的边界（切得干净）', () => {
    const r = allocateLinesToSlices(S, L)
    // 第 1 行应当从片 0 起点到片 0 末尾（最后一行除外，它收到末尾）
    assert.equal(r.ranges[0]!.startMs, S[0]!.startMs)
    assert.equal(r.ranges[0]!.endMs, S[0]!.endMs, '第 1 行应切在第 1 片末尾')
    assert.match(r.ranges[0]!.reasons[0]!, /语音片末尾/)
  })

  /**
   * ⚠️ **文本长度差异很大**的一片一行 —— 这条是回归测试，不是凑数。
   *
   * 通用路径（按文本长度比例算位置再吸附）有个结构性缺陷：比例是拿**整条**时间轴
   * （含句间静音）算的，而静音不属于任何一行的朗读时长，于是估算位置系统性偏
   * 约**一个间隙**。它在每步吸附后重新同步，所以误差不累积，
   * 但**短行容不下一个间隙**（容差 `max(200, 期望长度×0.5)`，间隙常有 400+ ms）
   * ⇒ 短行吸附失败 ⇒ 被打成低置信度。
   *
   * 真样本实测（`scripts/verify-audio-import-sample.ts`，237 行）：
   * 片数**恰好等于**行数的理想情形下，通用路径仍把 9 行里的 1 行、
   * 40 行里的 15 行、93 行里的 19 行判成低置信度。
   * 而这些行的边界本来就是确定的 —— 第 i 行就是第 i 片。
   *
   * 所以「片数 === 行数」必须走捷径。**删掉那个捷径这条用例立刻红**。
   */
  it('文本长度差异很大时，一片一行仍然全部高置信度（回归：按比例算会漂）', () => {
    // 刻意造「短行紧跟在长行后面」：这是比例漂移最容易失手的地方
    const texts = [
      '甲', // 1 字
      '这是一句相当长的台词，用来把时间轴拉长，让后面的短行按比例算出来必然偏掉。', // 36 字
      '乙', // 1 字
      '这又是一句很长的台词，长度与上一句接近，继续放大比例漂移的幅度。', // 30 字
      '丙', // 1 字
      '丁', // 1 字
    ]
    const slices6: SpeechSlice[] = [
      { startMs: 0, endMs: 400 },
      { startMs: 900, endMs: 9500 },
      { startMs: 10_000, endMs: 10_400 },
      { startMs: 10_900, endMs: 18_000 },
      { startMs: 18_500, endMs: 18_900 },
      { startMs: 19_400, endMs: 19_800 },
    ]
    const r = allocateLinesToSlices(slices6, linesOf(texts))

    assert.equal(r.stats.oneToOne, true)
    assert.equal(r.needsReview.length, 0, `不该有任何行需复核：${r.needsReview.join(', ')}`)
    for (const range of r.ranges) {
      assert.equal(range.confidence, 1, `${range.lineId} 一片一行应当是满置信度`)
    }
    // 每一行都切在自己那一片的末尾
    for (let i = 0; i < slices6.length; i++) {
      assert.equal(r.ranges[i]!.endMs, slices6[i]!.endMs, `第 ${i + 1} 行应切在第 ${i + 1} 片末尾`)
    }
    assertInvariants(r, slices6, texts.length)
  })

  it('片数=行数但片较长时也不退化成按比例切（长行同样满置信度）', () => {
    // 60 片铺 60 行：接近真样本规模（真机最长的一个文件是 93 行）
    const many: SpeechSlice[] = []
    for (let i = 0; i < 60; i++) {
      const start = i * 1000
      many.push({ startMs: start, endMs: start + (i % 3 === 0 ? 300 : 700) })
    }
    // 文本长度在 1~25 字之间起伏（`linesOf` 生成的 lineId 是 L1…L60）
    const manyLines = linesOf(Array.from({ length: 60 }, (_, i) => '字'.repeat(1 + (i % 5) * 6)))
    const r = allocateLinesToSlices(many, manyLines)
    assert.equal(r.stats.oneToOne, true)
    assert.equal(r.needsReview.length, 0, `规模放大后不该出现需复核行：${r.needsReview.length}`)
    assertInvariants(r, many, 60)
  })
})

describe('片数不足（M < N）—— 按文本长度比例切分', () => {
  it('2 片铺 4 行：每行都有区间，且不重叠、无缝', () => {
    const S = slices(2, 2000, 500)
    const L = linesOf(['甲', '乙', '丙', '丁'])
    const r = allocateLinesToSlices(S, L)
    assertInvariants(r, S, 4)
    assert.equal(r.stats.oneToOne, false)
    assert.ok(
      r.warnings.some((w) => /片数不足/.test(w)),
      `应提示片数不足，实际 ${JSON.stringify(r.warnings)}`,
    )
    // 片数不足时边界多半不落在片上 → 应该有行需要复核
    assert.ok(r.needsReview.length > 0, '片数不足时应当有行被标为需复核')
  })

  it('长的行分到更长的区间（按字符数比例）', () => {
    const S = slices(1, 4000, 0)
    const L = linesOf(['短', '这是一句非常非常长的台词内容需要更长时间来念'])
    const r = allocateLinesToSlices(S, L)
    const short = r.ranges[0]!
    const long = r.ranges[1]!
    assert.ok(
      long.endMs - long.startMs > short.endMs - short.startMs,
      '长行应分到更长区间',
    )
  })

  it('字符数相同时区间长度接近相等', () => {
    const S = slices(1, 4000, 0)
    const L = linesOf(['甲甲甲甲', '乙乙乙乙', '丙丙丙丙'])
    const r = allocateLinesToSlices(S, L)
    const lens = r.ranges.map((x) => x.endMs - x.startMs)
    const maxDiff = Math.max(...lens) - Math.min(...lens)
    assert.ok(maxDiff < 50, `等长行的时间区间应当接近，实际差 ${maxDiff}ms`)
  })

  /**
   * ⚠️ **回归测试：每一行都必须至少覆盖一点语音**。
   *
   * 这是「目标位置算在时间轴上」这个缺陷最直观的症状。
   * 构造：10 片各 1000ms 语音 + 500ms 间隙（总时间轴 14500ms），
   * 20 行等长文本 ⇒ 理应每行分到 500ms 语音（半片）。
   *
   * 旧算（`cursor + 剩余时间轴 × 权重占比`）：
   *   第 1 行的 rawEnd = 1/20 × 14500 = 725 → 离片 0 末尾（1000）275ms，
   *   在容差 `max(200, 725×0.5=362)` 之内 ⇒ **吸附到 1000**，把整片语音全吃掉；
   *   第 2 行的 rawEnd = 1000 + 13500/19 = 1710 → 吸附到片 1 **片首**（1500）
   *   ⇒ 第 2 行的区间是 `[1000, 1500]`，**正好是一段纯静音**，一点语音都没有。
   *
   * 新算法（目标算在**语音**坐标上）：
   *   第 1 行目标累计语音 500ms → 片内偏移 500 → 离最近片边界差 500ms 语音
   *   > 容差 `max(150, 250)` ⇒ **不吸附、硬切在 500**；第 2 行目标 1000ms
   *   → 正好落在片 0 末尾 ⇒ 吸附。每行都拿到 500ms 语音。
   */
  it('M<N 等长行：每行都覆盖到语音，不会出现「整段都是静音」的行', () => {
    const S = slices(10, 1000, 500)
    const L = linesOf(Array.from({ length: 20 }, () => '甲甲甲甲'))
    const r = allocateLinesToSlices(S, L)

    assert.equal(r.ranges.length, 20)
    assertInvariants(r, S, 20)

    /** 一行与所有语音片的重叠时长总和 */
    const speechOverlap = (a: number, b: number): number =>
      S.reduce((sum, s) => sum + Math.max(0, Math.min(b, s.endMs) - Math.max(a, s.startMs)), 0)

    const silent: string[] = []
    for (const range of r.ranges) {
      if (speechOverlap(range.startMs, range.endMs) <= 0) {
        silent.push(`${range.lineId}[${range.startMs},${range.endMs}]`)
      }
    }
    assert.deepEqual(silent, [], `这些行整段落在静音里（一点语音都没有）：${silent.join(', ')}`)

    const totalSpeech = 10 * 1000
    const each = totalSpeech / 20
    for (const range of r.ranges) {
      const got = speechOverlap(range.startMs, range.endMs)
      assert.ok(
        Math.abs(got - each) <= 250,
        `${range.lineId} 应覆盖约 ${each}ms 语音，实际 ${got}ms`,
      )
    }
  })

  /**
   * **落在静音上的行必须被明确报出来**。
   *
   * 构造：3 片短语音，彼此间隔**很远**（模拟 VAD 漏检了中间大段语音），
   * 却要铺 12 行 —— 边界必然要在长静音区里划。
   *
   * 实测这一构型下确实会出现 `[400, 5000]` 这种行：它吸附到了下一片的**片首**，
   * 于是整段区间落在 400~5000 的静音里，**一点语音都没有**。
   *
   * 「区间长度 > 0」查不出这个问题（区间照样是正的），用户听到的却是一段空白。
   * 所以必须有专门的原因、一条整体警告，并且这些行**一定**进复核清单。
   */
  it('区间完全落在静音上的行：标注原因 + 警告 + 强制进复核', () => {
    const S: SpeechSlice[] = [
      { startMs: 0, endMs: 400 },
      { startMs: 5000, endMs: 5400 },
      { startMs: 10_000, endMs: 10_400 },
    ]
    const r = allocateLinesToSlices(
      S,
      linesOf(Array.from({ length: 12 }, () => '甲甲甲甲')),
    )

    const overlap = (a: number, b: number): number =>
      S.reduce((sum, s) => sum + Math.max(0, Math.min(b, s.endMs) - Math.max(a, s.startMs)), 0)
    const silent = r.ranges.filter((x) => overlap(x.startMs, x.endMs) <= 0)
    assert.ok(
      silent.length > 0,
      '这个构造下应当确实有行落在静音上（否则用例本身失效）',
    )

    for (const x of silent) {
      assert.ok(
        x.reasons.some((reason) => /静音/.test(reason)),
        `${x.lineId} 应当带上「落在静音上」的原因，实际 ${JSON.stringify(x.reasons)}`,
      )
      assert.ok(r.needsReview.includes(x.lineId), `${x.lineId} 必须进复核清单`)
    }
    assert.ok(
      r.warnings.some((w) => /完全落在静音上/.test(w)),
      `应有一条整体警告，实际 ${JSON.stringify(r.warnings)}`,
    )
    // 区间本身仍然是完整的（不因为「落在静音上」就把这一行删掉）
    assert.equal(r.ranges.length, 12)
    assertInvariants(r, S, 12)
  })
})

describe('片数偏多（M > N）—— 相邻片归并给同一行', () => {
  it('6 片铺 3 行：每行覆盖多个片，仍满足全部不变量', () => {
    const S = slices(6, 800, 200)
    const L = linesOf(['甲', '乙', '丙'])
    const r = allocateLinesToSlices(S, L)
    assertInvariants(r, S, 3)
    assert.ok(
      r.warnings.some((w) => /片数偏多/.test(w)),
      `应提示片数偏多，实际 ${JSON.stringify(r.warnings)}`,
    )
    // 至少有一行跨了多个片
    const multi = r.ranges.some((x) => x.sliceTo > x.sliceFrom)
    assert.equal(multi, true, '片数偏多时应当有行跨多个片')
  })
})

describe('静音间隙归属', () => {
  it('默认把间隙归前一行（念完一句后的停顿属于这一句）', () => {
    const S = slices(2, 1000, 600)
    const L = linesOf(['甲', '乙'])
    const r = allocateLinesToSlices(S, L)
    // 第 1 行应当收到第 1 片末尾（含其后的间隙由下一行起点覆盖）
    assert.equal(r.ranges[0]!.endMs, S[0]!.endMs)
  })

  it("gapOwner='split' 时从片首切点会落在间隙中点", () => {
    const S: SpeechSlice[] = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1600, endMs: 2600 },
    ]
    const L = linesOf(['甲', '乙'])
    const r = allocateLinesToSlices(S, L, { gapOwner: 'split' })
    // 第二行若切在第 2 片开头，则起点应是间隙中点 (1000+1600)/2 = 1300
    const second = r.ranges[1]!
    assert.ok(
      second.startMs === 1300 || second.startMs === 1000,
      `起点应是间隙中点或前片末尾，实际 ${second.startMs}`,
    )
    assertInvariants(r, S, 2)
  })
})

describe('起点偏移（音频前有空白/板声）', () => {
  it('时间轴从第一个语音片开始，不从 0 开始', () => {
    const S = slices(2, 1000, 300, 5000) // 前面 5 秒空白
    const L = linesOf(['甲', '乙'])
    const r = allocateLinesToSlices(S, L)
    assert.equal(r.ranges[0]!.startMs, 5000, '第一行应从第一个语音片开始，不该吃掉前面的空白')
    assertInvariants(r, S, 2)
  })
})

describe('置信度与复核提示', () => {
  it('切在片边界上 → 高置信度', () => {
    const S = slices(3, 1000, 300)
    const r = allocateLinesToSlices(S, linesOf(['甲', '乙', '丙']))
    for (const range of r.ranges.slice(0, -1)) {
      assert.ok(range.confidence >= 0.7, `切在片边界上应高置信度，实际 ${range.confidence}`)
    }
  })

  it('硬切（附近没有片边界）→ 低置信度 + 说明原因', () => {
    // 一片很长（10 秒），要铺 5 行 → 只能在片中间硬切
    const S: SpeechSlice[] = [{ startMs: 0, endMs: 10000 }]
    const r = allocateLinesToSlices(S, linesOf(['甲', '乙', '丙', '丁', '戊']))
    const hardCut = r.ranges.slice(0, -1)
    assert.ok(
      hardCut.some((x) => x.confidence < 0.5),
      '硬切应当给出低置信度',
    )
    assert.ok(
      hardCut.some((x) => x.reasons.some((z) => /按文本比例切分|没有语音片边界/.test(z))),
      '低置信度的行必须说明原因',
    )
  })

  it('VAD 标记可疑片时给出提示', () => {
    const S: SpeechSlice[] = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1300, endMs: 9000, flags: ['too_long'] },
    ]
    const r = allocateLinesToSlices(S, linesOf(['甲', '乙']))
    assert.ok(
      r.warnings.some((w) => /可疑/.test(w)),
      `应提示可疑片，实际 ${JSON.stringify(r.warnings)}`,
    )
  })

  it('低置信度门槛可调', () => {
    const S = slices(2, 2000, 500)
    const L = linesOf(['甲', '乙', '丙', '丁'])
    const loose = allocateLinesToSlices(S, L, { lowConfidenceThreshold: 0.1 })
    const strict = allocateLinesToSlices(S, L, { lowConfidenceThreshold: 0.99 })
    assert.ok(
      strict.needsReview.length >= loose.needsReview.length,
      '门槛越严，需要复核的行应当越多',
    )
  })
})

describe('规模与鲁棒性', () => {
  it('接近真实规模：87 片铺 90 行（真机常态是片数略少）', () => {
    const S = slices(87, 900, 250)
    const L = linesOf(Array.from({ length: 90 }, (_, i) => `第${i + 1}行的台词内容`))
    const r = allocateLinesToSlices(S, L)
    assertInvariants(r, S, 90)
    assert.equal(r.stats.sliceCount, 87)
    assert.equal(r.stats.lineCount, 90)
    // 87 ≠ 90 → **不是**一片一行，而且必须给出提示
    assert.equal(r.stats.oneToOne, false, '片数与行数不同时不应当被标成「一片一行」')
    assert.ok(
      r.warnings.some((w) => /片数不足/.test(w)),
      `片数少于行数时应提示，实际 ${JSON.stringify(r.warnings)}`,
    )
  })

  it('300 片铺 1 行 → 一行吃掉全部', () => {
    const S = slices(300, 100, 50)
    const r = allocateLinesToSlices(S, linesOf(['只有一句']))
    assert.equal(r.ranges.length, 1)
    assert.equal(r.ranges[0]!.startMs, S[0]!.startMs)
    assert.equal(r.ranges[0]!.endMs, S[S.length - 1]!.endMs)
  })

  it('1 片铺 300 行 → 每行都有非零区间', () => {
    const S: SpeechSlice[] = [{ startMs: 0, endMs: 600_000 }]
    const L = linesOf(Array.from({ length: 300 }, (_, i) => `第${i}行`))
    const r = allocateLinesToSlices(S, L)
    assertInvariants(r, S, 300)
    for (const range of r.ranges) assert.ok(range.endMs > range.startMs)
  })

  it('空文本的行不占 0 时长（下限权重 1）', () => {
    const S = slices(1, 3000, 0)
    const L = linesOf(['', '', '正常一句'])
    const r = allocateLinesToSlices(S, L)
    for (const range of r.ranges) {
      assert.ok(range.endMs > range.startMs, `空文本行也要有非零区间：${JSON.stringify(range)}`)
    }
  })

  it('片之间完全无间隙时也满足不变量', () => {
    const S = slices(4, 500, 0)
    const r = allocateLinesToSlices(S, linesOf(['甲', '乙', '丙', '丁']))
    assertInvariants(r, S, 4)
  })

  it('区间是「片下标」有意义（sliceFrom ≤ sliceTo）', () => {
    const S = slices(6, 800, 200)
    const r = allocateLinesToSlices(S, linesOf(['甲', '乙', '丙']))
    for (const range of r.ranges) {
      assert.ok(range.sliceFrom >= 0 && range.sliceFrom < S.length)
      assert.ok(range.sliceTo >= range.sliceFrom && range.sliceTo < S.length)
    }
  })
})
