/**
 * Novel Studio · 导入切句（解码后的 PCM → 每行一段）单元测试
 * ============================================================================
 * 覆盖 docs/91 §5.2.49 ⑮、docs/12 §4.3、docs/05 §4。
 *
 * ### 这一组测的是「整条切句链路里唯一能纯逻辑测通的那一环」
 * 输入是 PCM 数组与行文本，输出是毫秒区间 —— 不需要 ffmpeg、不需要 whisper、
 * 不需要真音频文件。合成信号就是「几段正弦 + 几段静音」。
 *
 * 运行：node --experimental-strip-types tests/shared/audio-split.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { planLineSplits } from '../../src/shared/audio/split.ts'

const RATE = 48_000

/**
 * 造一段「朗读」信号：`blocks` 里每项是 [时长毫秒, 是否说话]。
 *
 * 说话段落用 440 Hz 正弦（振幅 0.5），静音段落填 0。
 * 为什么用正弦而不是随机噪声：VAD 的判据里有过零率，
 * 随机噪声的 ZCR 稳定在 0.5 附近、正弦在低频段更低 —— 两者都能通过语音判定，
 * 但正弦是**确定性**的，参数一变不会出现「这次过、下次不过」。
 */
function makeSignal(blocks: Array<[number, boolean]>): Float32Array {
  const total = blocks.reduce((s, [ms]) => s + Math.round((ms / 1000) * RATE), 0)
  const out = new Float32Array(total)
  let cursor = 0
  for (const [ms, voiced] of blocks) {
    const n = Math.round((ms / 1000) * RATE)
    if (voiced) {
      for (let i = 0; i < n; i++) out[cursor + i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE)
    }
    cursor += n
  }
  return out
}

/** 6 行文本，长度差异明显（用来验证「按文本长度分配」） */
const LINES = [
  { lineId: 'l1', text: '短句。' },
  { lineId: 'l2', text: '这是一句中等长度的台词。' },
  { lineId: 'l3', text: '这是三句里最长的一句台词，用来把时长权重拉开差距。' },
  { lineId: 'l4', text: '又一句。' },
  { lineId: 'l5', text: '中等长度的一句台词。' },
  { lineId: 'l6', text: '最后一句。' },
]

// ---------------------------------------------------------------------------

describe('planLineSplits：VAD 能找到人声时的正常路径', () => {
  it('6 段语音 → 6 行，每行一个有长度的区间', () => {
    const samples = makeSignal([
      [700, true],
      [500, false],
      [700, true],
      [500, false],
      [700, true],
      [500, false],
      [700, true],
      [500, false],
      [700, true],
      [500, false],
      [700, true],
      [900, false],
    ])
    const r = planLineSplits({ samples, sampleRate: RATE, lines: LINES })

    assert.equal(r.method, 'vad')
    assert.equal(r.stats.usedFallback, false)
    assert.equal(r.ranges.length, 6, '每行都要拿到区间')
    assert.equal(r.stats.durationMs, Math.round((samples.length / RATE) * 1000))

    for (const range of r.ranges) {
      assert.ok(range.endMs > range.startMs, `${range.lineId} 的区间必须是正长度`)
    }
  })

  /**
   * 四条不变量 —— 这组断言比「具体毫秒数」稳，也是服务层真正依赖的性质。
   */
  it('不变量：顺序、不重叠、无缝、覆盖到末尾', () => {
    const samples = makeSignal([
      [600, true],
      [400, false],
      [900, true],
      [300, false],
      [500, true],
      [1200, false],
    ])
    const r = planLineSplits({ samples, sampleRate: RATE, lines: LINES })

    assert.equal(r.ranges.length, 6)

    for (let i = 1; i < r.ranges.length; i++) {
      const prev = r.ranges[i - 1]!
      const cur = r.ranges[i]!
      assert.equal(cur.startMs, prev.endMs, `第 ${i} 行的起点必须接上前一行的终点（无缝）`)
      assert.ok(cur.endMs >= cur.startMs, `第 ${i} 行区间不得反向`)
    }

    // 覆盖到「最后一片语音的末尾」（不是文件末尾 —— 尾随静音不该被算进去）
    const lastSliceEnd = r.slices[r.slices.length - 1]!.endMs
    assert.equal(r.ranges[r.ranges.length - 1]!.endMs, lastSliceEnd)
  })

  it('文本长的行分到的时长更多（权重确实生效）', () => {
    const samples = makeSignal([
      [2000, true],
      [600, false],
      [2000, true],
      [600, false],
      [2000, true],
      [600, false],
      [2000, true],
      [600, false],
      [2000, true],
      [600, false],
      [2000, true],
      [600, false],
    ])
    const r = planLineSplits({ samples, sampleRate: RATE, lines: LINES })
    const len = (id: string) => {
      const x = r.ranges.find((v) => v.lineId === id)!
      return x.endMs - x.startMs
    }
    // l3 最长（24 字），l1 最短（3 字）
    assert.ok(len('l3') > len('l1'), `最长行(${len('l3')}ms) 应当比最短行(${len('l1')}ms) 长`)
  })

  it('片数与行数差很多时仍然每行都有区间（87 片 vs 6 行 / 1 片 vs 6 行）', () => {
    const many: Array<[number, boolean]> = []
    for (let i = 0; i < 87; i++) {
      many.push([300, true], [120, false])
    }
    const r1 = planLineSplits({ samples: makeSignal(many), sampleRate: RATE, lines: LINES })
    assert.equal(r1.ranges.length, 6)
    assert.equal(r1.stats.oneToOne, false, '87 片铺 6 行不可能是「一片一行」')
    for (const x of r1.ranges) assert.ok(x.endMs > x.startMs)

    const r2 = planLineSplits({
      samples: makeSignal([
        [3000, true],
        [800, false],
      ]),
      sampleRate: RATE,
      lines: LINES,
    })
    assert.equal(r2.ranges.length, 6, '1 片铺 6 行：必须切开，不能只给第一行')
    for (const x of r2.ranges) assert.ok(x.endMs > x.startMs)
  })
})

// ---------------------------------------------------------------------------

describe('planLineSplits：VAD 找不到人声 → 按整段比例兜底', () => {
  /**
   * 全静音输入。`detectSlices` 会抛 `VAD_NO_SPEECH_FOUND`
   * （录音场景的正确行为），但**导入场景不能失败** —— 用户给的是既成音频。
   */
  const silence = new Float32Array(RATE * 3) // 3 秒纯静音

  it('兜底成 whole-timeline，每行仍有区间，并明确回报 usedFallback', () => {
    const r = planLineSplits({ samples: silence, sampleRate: RATE, lines: LINES })

    assert.equal(r.method, 'whole-timeline', '必须回报走了兜底路径')
    assert.equal(r.stats.usedFallback, true)
    assert.equal(r.ranges.length, 6, '兜底也要保证每行有音频')
    assert.equal(r.warnings.length > 0, true, '必须给用户一条提示（边界不可信）')
    assert.match(r.warnings[0]!, /按比例|边界/)
  })

  it('兜底时区间仍然无缝且覆盖整段（不丢时长）', () => {
    const r = planLineSplits({ samples: silence, sampleRate: RATE, lines: LINES })
    for (let i = 1; i < r.ranges.length; i++) {
      assert.equal(r.ranges[i]!.startMs, r.ranges[i - 1]!.endMs)
    }
    assert.equal(r.ranges[0]!.startMs, 0)
    assert.equal(r.ranges[r.ranges.length - 1]!.endMs, r.stats.durationMs)
  })

  it('noSpeechFallback=none 时如实返回空区间 + 全部需复核（不编造）', () => {
    const r = planLineSplits({
      samples: silence,
      sampleRate: RATE,
      lines: LINES,
      noSpeechFallback: 'none',
    })
    assert.equal(r.method, 'empty')
    assert.deepEqual(r.ranges, [])
    assert.equal(r.needsReview.length, 6, '每一行都必须进复核清单')
    assert.equal(r.stats.usedFallback, false)
  })
})

// ---------------------------------------------------------------------------

describe('planLineSplits：退化输入不编造区间', () => {
  it('0 个采样 → 空区间 + 全部需复核 + 明确提示', () => {
    const r = planLineSplits({ samples: new Float32Array(0), sampleRate: RATE, lines: LINES })
    assert.equal(r.method, 'empty')
    assert.deepEqual(r.ranges, [], '0 采样时给 0ms~0ms 的区间 = 界面显示「已导入 6 行」而全是空文件')
    assert.equal(r.needsReview.length, 6)
    assert.equal(r.stats.durationMs, 0)
    assert.match(r.warnings[0]!, /空的/)
  })

  it('采样率非法（0）时按空处理，不抛错也不产生 NaN', () => {
    const r = planLineSplits({ samples: new Float32Array(RATE), sampleRate: 0, lines: LINES })
    assert.equal(r.method, 'empty')
    assert.equal(r.stats.durationMs, 0)
    assert.deepEqual(r.ranges, [])
  })

  it('没有行 → empty，且不去跑 VAD（省掉一次全量帧分析）', () => {
    const r = planLineSplits({ samples: new Float32Array(RATE * 2), sampleRate: RATE, lines: [] })
    assert.equal(r.method, 'empty')
    assert.deepEqual(r.ranges, [])
    assert.equal(r.stats.sliceCount, 0)
    assert.deepEqual(r.needsReview, [])
  })
})

// ---------------------------------------------------------------------------

describe('planLineSplits：时长以 PCM 长度为准（不依赖 ffprobe）', () => {
  it('durationMs 与样本数严格对应（48000 样本 @48k = 1000ms）', () => {
    const r = planLineSplits({ samples: new Float32Array(RATE), sampleRate: RATE, lines: LINES })
    assert.equal(r.stats.durationMs, 1000)
  })

  it('44.1 kHz 输入同样正确（不是一个只对 48k 成立的实现）', () => {
    const r = planLineSplits({ samples: new Float32Array(44_100), sampleRate: 44_100, lines: LINES })
    assert.equal(r.stats.durationMs, 1000)
  })
})
