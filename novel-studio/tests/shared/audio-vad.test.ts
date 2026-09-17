/**
 * Novel Studio · VAD 切片单元测试
 * ============================================================================
 * 覆盖 docs/05 §4：
 *   · §4.1 帧级分析 + 噪声底 = 滑动窗口 10 分位（用均值会被语音污染 —— 这里做对照验证）
 *   · §4.2 状态机（连续 minSpeechMs 才算语音 / 连续 minSilenceMs 才切分）
 *   · §4.3 边界精修：起点回退 80 ms、尾部保留 200 ms、过短丢弃、过长标记、< 250 ms 间隔合并
 *   · 全静音 → 空数组且 detectSlices 抛 VAD_NO_SPEECH_FOUND
 *
 * 运行：node --experimental-strip-types tests/shared/audio-vad.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { VAD_DEFAULTS, VAD_SPEECH_MARGIN_DB } from '../../src/shared/constants.ts'
import { AppError } from '../../src/shared/errors.ts'
import {
  estimateNoiseFloorDb,
  detectSlices,
  detectSpeech,
  findSlices,
  frameEnergy,
  summarizeSlices,
  type VadFrame,
} from '../../src/shared/audio/vad.ts'
import type { VadOptions } from '../../src/shared/types.ts'

const SR = 48000
const FRAME_MS = 20

/** 确定性伪噪声（不用 Math.random，保证失败可复现）：均匀分布 ±amp */
function noise(seconds: number, amp = 0.003, seed = 12345): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amp
  }
  return out
}

/** 正弦 burst（200 Hz，避免过零率影响；amp 0.5 → RMS ≈ -9 dB） */
function burst(seconds: number, amp = 0.5, freq = 200): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR)
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 合成测试语料：噪声 - 语音 - 噪声 - 语音 - 噪声 */
const SIGNAL = concat(noise(0.5), burst(1.0), noise(0.8), burst(0.6), noise(0.5))

const OPTS: VadOptions = { ...VAD_DEFAULTS }

/** 手工构造帧序列（用于精确验证边界精修，不受信号生成影响） */
function mkFrames(count: number, rmsDb = -60, peakDb = -58): VadFrame[] {
  return Array.from({ length: count }, () => ({ rmsDb, peakDb, zcr: 0.01 }))
}

function mkSpeech(count: number, ranges: Array<[number, number]>): boolean[] {
  const flags = new Array<boolean>(count).fill(false)
  for (const [from, to] of ranges) for (let i = from; i <= to; i++) flags[i] = true
  return flags
}

// ---------------------------------------------------------------------------
// §4.1 帧级分析与噪声底
// ---------------------------------------------------------------------------

describe('VAD 帧级分析', () => {
  it('frameEnergy：20 ms 帧 = 960 样本，尾部残余样本也成一帧', () => {
    const frames = frameEnergy(concat(noise(0.1), noise(0.005)), { frameMs: FRAME_MS, sampleRate: SR })
    assert.equal(frames.length, 6, '105 ms 应切成 5 帧 + 1 帧残余')
    assert.ok((frames[0] as VadFrame).rmsDb < -40)
    assert.ok((frames[0] as VadFrame).zcr >= 0 && (frames[0] as VadFrame).zcr <= 1)
  })

  it('frameEnergy：空输入返回空数组，不抛错', () => {
    assert.deepEqual(frameEnergy(new Float32Array(0), { frameMs: FRAME_MS, sampleRate: SR }), [])
  })

  it('数字静音帧的 rms/peak 是 -Infinity（不能是 NaN）', () => {
    const frames = frameEnergy(new Float32Array(1920), { frameMs: FRAME_MS, sampleRate: SR })
    assert.equal(frames.length, 2)
    assert.equal((frames[0] as VadFrame).rmsDb, Number.NEGATIVE_INFINITY)
    assert.equal((frames[0] as VadFrame).peakDb, Number.NEGATIVE_INFINITY)
  })

  it('噪声底用 10 分位：不被语音污染（与均值对照）', () => {
    const frames = frameEnergy(SIGNAL, { frameMs: FRAME_MS, sampleRate: SR })
    const floor = estimateNoiseFloorDb(frames, { windowFrames: 150 }) // 3 s 窗口
    const mean = frames.reduce((a, f) => a + (Number.isFinite(f.rmsDb) ? f.rmsDb : -100), 0) / frames.length

    // 噪声实际电平：均匀分布 ±0.003 → RMS ≈ 0.00173 → -55.2 dB
    assert.ok(floor > -62 && floor < -48, `噪声底 ${floor.toFixed(2)} dB 应接近 -55 dB`)
    assert.ok(floor < -45, '噪声底必须在静音门限 -45 以下')
    // 均值被 1.6 s 语音抬高了 6 dB 以上 —— 这正是不能用均值的原因
    assert.ok(mean > floor + 6, `均值 ${mean.toFixed(2)} 应显著高于 10 分位 ${floor.toFixed(2)}`)
  })

  it('噪声底：无帧时返回下限值（-100），不会出现 -Infinity 门限', () => {
    assert.equal(estimateNoiseFloorDb([], { windowFrames: 10 }), -100)
  })
})

// ---------------------------------------------------------------------------
// §4.2 状态机
// ---------------------------------------------------------------------------

describe('VAD 状态机（detectSpeech）', () => {
  const opts = { ...OPTS, marginDb: VAD_SPEECH_MARGIN_DB, frameMs: FRAME_MS, silenceDb: -45 }

  it('孤立短促声（60 ms < minSpeechMs 120 ms）判为噪声（咳嗽、翻页）', () => {
    const frames = mkFrames(20, -60)
    for (let i = 8; i <= 10; i++) frames[i] = { rmsDb: -10, peakDb: -8, zcr: 0.05 }
    const speech = detectSpeech(frames, opts)
    assert.equal(speech.filter(Boolean).length, 0)
  })

  it('够长的语音段（200 ms >= minSpeechMs）整体判为语音', () => {
    const frames = mkFrames(20, -60)
    for (let i = 5; i <= 14; i++) frames[i] = { rmsDb: -10, peakDb: -8, zcr: 0.05 }
    const speech = detectSpeech(frames, opts)
    assert.equal(speech.filter(Boolean).length, 10)
    assert.equal(speech[5], true)
    assert.equal(speech[14], true)
    assert.equal(speech[4], false)
  })

  it('句内停顿（100 ms < minSilenceMs 350 ms）不切分', () => {
    const frames = mkFrames(40, -60)
    for (let i = 5; i <= 24; i++) frames[i] = { rmsDb: -10, peakDb: -8, zcr: 0.05 }
    // 中间 5 帧（100 ms）掉回噪声
    for (let i = 14; i <= 18; i++) frames[i] = { rmsDb: -60, peakDb: -58, zcr: 0.3 }
    const speech = detectSpeech(frames, opts)
    for (let i = 5; i <= 24; i++) assert.equal(speech[i], true, `帧 ${i} 应被判为语音（句内停顿合并）`)
  })

  it('autoNoiseFloor=false 时直接用 silenceDb 当门限', () => {
    const frames = mkFrames(20, -50)
    for (let i = 5; i <= 14; i++) frames[i] = { rmsDb: -40, peakDb: -38, zcr: 0.05 }
    const adaptive = detectSpeech(frames, { ...opts, autoNoiseFloor: true, marginDb: 12 })
    const fixed = detectSpeech(frames, { ...opts, autoNoiseFloor: false, silenceDb: -45 })
    assert.equal(adaptive.filter(Boolean).length, 0, '自适应门限（-50+12=-38）判不出 -40 的段')
    assert.equal(fixed.filter(Boolean).length, 10, '固定门限 -45 能判出')
  })
})

// ---------------------------------------------------------------------------
// §4.3 边界精修
// ---------------------------------------------------------------------------

describe('VAD 边界精修（findSlices）', () => {
  it('起点回退 80 ms、尾部保留 200 ms', () => {
    // 60 帧 = 1200 ms；语音 = 帧 10..19（核心 200~400 ms）
    const frames = mkFrames(60, -60)
    for (let i = 10; i <= 19; i++) frames[i] = { rmsDb: -10, peakDb: -5, zcr: 0.05 }
    const slices = findSlices(frames, mkSpeech(60, [[10, 19]]), {
      ...OPTS,
      frameMs: FRAME_MS,
      noiseFloorDb: -55,
      totalMs: 1200,
    })
    assert.equal(slices.length, 1)
    const s = slices[0]!
    assert.equal(s.startMs, 120, '200 - 80(回退) = 120')
    assert.equal(s.endMs, 600, '400 + 200(尾保留) = 600')
    assert.ok(s.peakDb > -10 && s.peakDb < 0)
  })

  it('回退不越界：切片起点不会小于 0，也不会与上一段重叠', () => {
    const frames = mkFrames(60, -60)
    for (let i = 2; i <= 12; i++) frames[i] = { rmsDb: -10, peakDb: -5, zcr: 0.05 }
    const slices = findSlices(frames, mkSpeech(60, [[2, 12]]), {
      ...OPTS,
      frameMs: FRAME_MS,
      noiseFloorDb: -55,
      totalMs: 1200,
    })
    assert.equal(slices.length, 1)
    assert.equal(slices[0]!.startMs, 0, '40 - 80 → 夹到 0')
    assert.equal(slices[0]!.endMs, 460, '260 + 200 = 460')
  })

  it('过短丢弃：核心 100 ms < minSliceMs 180 ms（咳嗽、椅子声）', () => {
    const frames = mkFrames(60, -60)
    for (let i = 5; i <= 9; i++) frames[i] = { rmsDb: -10, peakDb: -5, zcr: 0.05 }
    const slices = findSlices(frames, mkSpeech(60, [[5, 9]]), {
      ...OPTS,
      frameMs: FRAME_MS,
      noiseFloorDb: -55,
      totalMs: 1200,
    })
    assert.equal(slices.length, 0, '核心只有 100 ms，必须丢弃（padding 不该把咳嗽变成合格切片）')
  })

  it('过静丢弃：核心 RMS 低于噪声底 + 6 dB 的切片被丢弃', () => {
    const frames = mkFrames(60, -60)
    for (let i = 5; i <= 14; i++) frames[i] = { rmsDb: -58, peakDb: -55, zcr: 0.05 } // 噪声底 -60 + 6 = -54，-58 < -54
    const slices = findSlices(frames, mkSpeech(60, [[5, 14]]), {
      ...OPTS,
      frameMs: FRAME_MS,
      noiseFloorDb: -60,
      totalMs: 1200,
    })
    assert.equal(slices.length, 0)
  })

  it('过长标记：核心 > 15 s → flags 含 too_long（不丢弃，进人工确认）', () => {
    const frames = mkFrames(1000, -60)
    for (let i = 0; i <= 900; i++) frames[i] = { rmsDb: -10, peakDb: -5, zcr: 0.05 }
    const slices = findSlices(frames, mkSpeech(1000, [[0, 900]]), {
      ...OPTS,
      frameMs: FRAME_MS,
      noiseFloorDb: -55,
      totalMs: 20000,
    })
    assert.equal(slices.length, 1)
    assert.deepEqual(slices[0]!.flags, ['too_long'])
    assert.ok(slices[0]!.endMs - slices[0]!.startMs > 15000)
  })

  it('间隔 < 250 ms（VAD_BRIDGE_GAP_MS）合并为一段', () => {
    const frames = mkFrames(60, -60)
    for (const [from, to] of [[5, 14] as [number, number], [16, 25] as [number, number]]) {
      for (let i = from; i <= to; i++) frames[i] = { rmsDb: -10, peakDb: -5, zcr: 0.05 }
    }
    const slices = findSlices(frames, mkSpeech(60, [[5, 14], [16, 25]]), {
      ...OPTS,
      frameMs: FRAME_MS,
      noiseFloorDb: -55,
      totalMs: 1200,
    })
    assert.equal(slices.length, 1, '20 ms 的间隔（< 250 ms）必须合并')
    assert.equal(slices[0]!.startMs, 20)
    assert.equal(slices[0]!.endMs, 720)
  })

  it('间隔 300 ms（>= 250 ms）保持两段', () => {
    const frames = mkFrames(60, -60)
    for (const [from, to] of [[5, 14] as [number, number], [30, 39] as [number, number]]) {
      for (let i = from; i <= to; i++) frames[i] = { rmsDb: -10, peakDb: -5, zcr: 0.05 }
    }
    const slices = findSlices(frames, mkSpeech(60, [[5, 14], [30, 39]]), {
      ...OPTS,
      frameMs: FRAME_MS,
      noiseFloorDb: -55,
      totalMs: 1200,
    })
    assert.equal(slices.length, 2)
    assert.ok(slices[0]!.endMs <= slices[1]!.startMs, '两段不得重叠')
  })

  it('全静音 / 无帧 → 空数组（不抛错）', () => {
    assert.deepEqual(findSlices(mkFrames(50, -90), mkSpeech(50, []), { ...OPTS, frameMs: FRAME_MS }), [])
    assert.deepEqual(findSlices([], [], { ...OPTS, frameMs: FRAME_MS }), [])
    assert.deepEqual(findSlices([], [], { ...OPTS, frameMs: FRAME_MS }), [])
  })
})

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

describe('VAD 端到端（detectSlices）', () => {
  it('合成语料切出 2 段，边界落在预期位置 ±40 ms', () => {
    const slices = detectSlices(SIGNAL, { ...OPTS, sampleRate: SR, frameMs: FRAME_MS })
    assert.equal(slices.length, 2, `应切出 2 段，实际 ${slices.length}`)
    assert.ok(Math.abs(slices[0]!.startMs - 420) <= 40, `第 1 段起点 ${slices[0]!.startMs}`)
    assert.ok(Math.abs(slices[0]!.endMs - 1700) <= 40, `第 1 段终点 ${slices[0]!.endMs}`)
    assert.ok(Math.abs(slices[1]!.startMs - 2220) <= 40, `第 2 段起点 ${slices[1]!.startMs}`)
    assert.ok(Math.abs(slices[1]!.endMs - 3100) <= 40, `第 2 段终点 ${slices[1]!.endMs}`)

    const stats = summarizeSlices(slices)
    assert.equal(stats.count, 2)
    assert.equal(stats.tooLong, 0)
    assert.ok(stats.totalMs > 2000 && stats.totalMs < 2600)
    assert.ok(stats.avgRmsDb > -20, '正弦 burst 的平均 RMS 应在 -20 dB 以上')
  })

  it('全静音 → 抛 VAD_NO_SPEECH_FOUND（原始会话必须保留，可调参重切）', () => {
    assert.throws(
      () => detectSlices(noise(2.0, 0.002), { ...OPTS, sampleRate: SR, frameMs: FRAME_MS }),
      (e: unknown) => e instanceof AppError && e.key === 'VAD_NO_SPEECH_FOUND',
    )
  })

  it('极短输入（1 个样本 / 5 ms）不崩，且无语音时抛 VAD_NO_SPEECH_FOUND', () => {
    assert.throws(
      () => detectSlices(new Float32Array(1), { ...OPTS, sampleRate: SR, frameMs: FRAME_MS }),
      (e: unknown) => e instanceof AppError && e.key === 'VAD_NO_SPEECH_FOUND',
    )
    assert.throws(
      () => detectSlices(new Float32Array(Math.round(SR * 0.005)), { ...OPTS, sampleRate: SR, frameMs: FRAME_MS }),
      (e: unknown) => e instanceof AppError && e.key === 'VAD_NO_SPEECH_FOUND',
    )
  })

  it('极短输入含 burst（20 ms < minSliceMs）→ 仍抛 VAD_NO_SPEECH_FOUND（过短丢弃）', () => {
    assert.throws(
      () => detectSlices(burst(0.02, 0.9), { ...OPTS, sampleRate: SR, frameMs: FRAME_MS }),
      (e: unknown) => e instanceof AppError && e.key === 'VAD_NO_SPEECH_FOUND',
    )
  })

  it('VAD 关闭时不做任何判定（调用方直接用整段）—— 本函数不读 enabled，保持纯粹', () => {
    // enabled 由调用方（录制流程）判断；这里确认参数透传不会因 enabled=false 而异常
    const slices = detectSlices(SIGNAL, { ...OPTS, enabled: false, sampleRate: SR, frameMs: FRAME_MS })
    assert.ok(slices.length >= 1)
  })
})
