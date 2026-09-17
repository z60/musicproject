/**
 * Novel Studio · 静音修剪 + 波形峰值缓存单元测试
 * ============================================================================
 * 覆盖 docs/05 §5.3 §11.3 与 docs/04 §4：
 *   · 从起点向后 / 从终点向前扫第一个超阈样本，再按 padding 扩展且不越界
 *   · 全静音 → 返回全区间并标记 all_silence（调用方抛 TRIM_FAILED）
 *   · 峰值 min/max 对（int16 量化）、NSPK 文件头往返、100→10→1 三级 LOD 降采样
 *
 * 运行：node --experimental-strip-types tests/shared/audio-trim-peaks.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { TRIM_DEFAULTS } from '../../src/shared/constants.ts'
import {
  PEAKS_HEADER_BYTES,
  PEAKS_MAGIC,
  PEAKS_VERSION,
  computePeaks,
  deserializePeaks,
  downsamplePeaks,
  downsampleToLevel,
  peaksStats,
  serializePeaks,
} from '../../src/shared/audio/peaks.ts'
import { clampTrimToSegment, computeTrimRange, defaultTrimOptions } from '../../src/shared/audio/trim.ts'
import type { TrimOptions } from '../../src/shared/types.ts'

const SR = 48000

/** 拼一段信号：前静音 + 正弦 + 后静音，单位毫秒 */
function buildSignal(headMs: number, toneMs: number, tailMs: number, amp = 0.5): Float32Array {
  const total = Math.round(((headMs + toneMs + tailMs) / 1000) * SR)
  const out = new Float32Array(total)
  const from = Math.round((headMs / 1000) * SR)
  const to = Math.round(((headMs + toneMs) / 1000) * SR)
  for (let i = from; i < to; i++) out[i] = amp * Math.sin((2 * Math.PI * 300 * i) / SR)
  return out
}

const TRIM: TrimOptions & { sampleRate: number } = { ...TRIM_DEFAULTS, sampleRate: SR }

// ---------------------------------------------------------------------------
// 静音修剪（docs/05 §5.3）
// ---------------------------------------------------------------------------

describe('静音修剪 computeTrimRange', () => {
  it('默认参数扫描：300/100 ms 留白（阈值 -45 dBFS）', () => {
    // 500 ms 静音 + 1000 ms 正弦 + 500 ms 静音，共 2000 ms
    const s = buildSignal(500, 1000, 500)
    const r = computeTrimRange(s, TRIM)
    assert.equal(r.rawInMs, 500, '第一个超阈样本在 500 ms')
    assert.equal(r.rawOutMs, 1500, '最后一个超阈样本在 1500 ms')
    assert.equal(r.inMs, 400, '500 - 100(headPadding) = 400')
    assert.equal(r.outMs, 1620, '1500 + 120(tailPadding) = 1620')
    assert.deepEqual(r.flags, [])
  })

  it('padding 不越界（首尾都贴边）', () => {
    const s = buildSignal(0, 400, 0) // 整段都是音
    const r = computeTrimRange(s, TRIM)
    assert.equal(r.inMs, 0, '不早于 0')
    assert.equal(r.outMs, 400, '不晚于片段尾')
  })

  it('全静音 → 返回全区间并标记 all_silence（调用方抛 TRIM_FAILED，绝不删素材）', () => {
    const r = computeTrimRange(new Float32Array(SR), TRIM)
    assert.equal(r.inMs, 0)
    assert.equal(r.outMs, 1000)
    assert.ok(r.flags.includes('all_silence'))
  })

  it('低于阈值的微弱底噪不参与修剪（-45 dBFS 门限）', () => {
    const s = buildSignal(200, 400, 200, 0.002) // 0.002 ≈ -54 dBFS，低于门限
    const r = computeTrimRange(s, TRIM)
    assert.ok(r.flags.includes('all_silence'), '微弱底噪不应被当成语音保留')
  })

  it('enabled=false → 原样返回全区间（不做修剪）', () => {
    const s = buildSignal(500, 500, 500)
    const r = computeTrimRange(s, { ...TRIM, enabled: false })
    assert.equal(r.inMs, 0)
    assert.equal(r.outMs, 1500)
    assert.deepEqual(r.flags, ['disabled'])
  })

  it('空输入不抛错', () => {
    const r = computeTrimRange(new Float32Array(0), TRIM)
    assert.equal(r.outMs, 0)
  })

  it('clampTrimToSegment：修剪结果必须落在片段边界内', () => {
    const ok = clampTrimToSegment({ inMs: 400, outMs: 1620 }, { srcInMs: 500, srcOutMs: 1500 })
    assert.deepEqual(ok, { srcInMs: 500, srcOutMs: 1500 })
    assert.equal(clampTrimToSegment({ inMs: 900, outMs: 900 }, { srcInMs: 0, srcOutMs: 1500 }), null)
  })

  it('defaultTrimOptions 与 TRIM_DEFAULTS 一致（100/120 ms、-45 dBFS）', () => {
    const d = defaultTrimOptions()
    assert.equal(d.thresholdDb, -45)
    assert.equal(d.headPaddingMs, 100)
    assert.equal(d.tailPaddingMs, 120)
    assert.equal(d.enabled, true)
  })
})

// ---------------------------------------------------------------------------
// 波形峰值（docs/04 §4 / docs/05 §11.3）
// ---------------------------------------------------------------------------

describe('波形峰值 computePeaks', () => {
  it('100 peaks/s：1 秒 = 100 对，长度 200', () => {
    const s = buildSignal(0, 1000, 0)
    const peaks = computePeaks(s, { peaksPerSec: 100, sampleRate: SR })
    assert.equal(peaks.length, 200)
    assert.ok(Math.abs((peaks[1] as number) / 32767 - 0.5) < 0.01, 'max ≈ 0.5')
    assert.ok(Math.abs((peaks[0] as number) / 32767 + 0.5) < 0.01, 'min ≈ -0.5')
  })

  it('每桶取 min/max：一个瞬时尖峰不会被平均掉', () => {
    const s = new Float32Array(480) // 1 桶 = 480 样本
    s[123] = 1
    const peaks = computePeaks(s, { peaksPerSec: 100, sampleRate: SR })
    assert.equal(peaks.length, 2)
    assert.equal(peaks[1], 32767)
  })

  it('空输入返回空数组；10 peaks/s 时桶数为 1/10', () => {
    assert.equal(computePeaks(new Float32Array(0), { peaksPerSec: 100, sampleRate: SR }).length, 0)
    const peaks = computePeaks(buildSignal(0, 1000, 0), { peaksPerSec: 10, sampleRate: SR })
    assert.equal(peaks.length, 20)
  })
})

describe('波形峰值序列化（NSPK 文件头）', () => {
  const peaks = computePeaks(buildSignal(0, 1000, 0), { peaksPerSec: 100, sampleRate: SR })

  it('文件头严格 32 字节：magic/version/peakPerSec/sampleCount/channels', () => {
    const buf = serializePeaks({ peaks, peaksPerSec: 100, sampleCount: 48000, channels: 1 })
    assert.equal(buf.length, PEAKS_HEADER_BYTES + peaks.length * 2)
    assert.equal(buf.toString('ascii', 0, 4), PEAKS_MAGIC)
    assert.equal(buf.toString('ascii', 0, 4), 'NSPK')
    assert.equal(buf.readUInt16LE(4), PEAKS_VERSION)
    assert.equal(buf.readUInt32LE(8), 100)
    assert.equal(buf.readUInt32LE(12), 48000)
    assert.equal(buf.readUInt16LE(20), 1)
  })

  it('序列化 → 反序列化 完全一致', () => {
    const buf = serializePeaks({ peaks, peaksPerSec: 100, sampleCount: 48000, channels: 2 })
    const back = deserializePeaks(buf)
    assert.ok(back)
    assert.equal(back!.peaksPerSec, 100)
    assert.equal(back!.sampleCount, 48000)
    assert.equal(back!.channels, 2)
    assert.deepEqual([...back!.peaks], [...peaks])
  })

  it('无效缓存返回 null（调用方按缓存失效重算，不报错）', () => {
    assert.equal(deserializePeaks(Buffer.alloc(10)), null)
    assert.equal(deserializePeaks(Buffer.alloc(64)), null)
    const bad = serializePeaks({ peaks, peaksPerSec: 100, sampleCount: 48000, channels: 1 })
    bad.write('XXXX', 0, 'ascii')
    assert.equal(deserializePeaks(bad), null)
    const wrongVer = serializePeaks({ peaks, peaksPerSec: 100, sampleCount: 48000, channels: 1 })
    wrongVer.writeUInt16LE(99, 4)
    assert.equal(deserializePeaks(wrongVer), null)
  })

  it('sampleCount 用 u64 写入（超过 2^32 也不会截断）', () => {
    const big = 0x1_0000_0001
    const buf = serializePeaks({ peaks, peaksPerSec: 100, sampleCount: big, channels: 1 })
    assert.equal(deserializePeaks(buf)!.sampleCount, big)
  })
})

describe('波形峰值 LOD 降采样（100/10/1 peaks/s）', () => {
  const peaks = computePeaks(buildSignal(0, 1000, 0), { peaksPerSec: 100, sampleRate: SR })

  it('100 → 10：桶数变 1/10，且极值不丢', () => {
    const out = downsamplePeaks(peaks, 100, 10)
    assert.equal(out.length, 20)
    const srcMax = Math.max(...[...peaks].filter((_, i) => i % 2 === 1))
    const dstMax = Math.max(...[...out].filter((_, i) => i % 2 === 1))
    assert.equal(dstMax, srcMax, '最大值必须保留（丢失峰值会让波形看起来变矮）')
  })

  it('逐级 100 → 10 → 1：1 秒只剩 1 对', () => {
    const out = downsampleToLevel(peaks, 100, 1)
    assert.equal(out.length, 2)
    assert.ok(Math.abs((out[1] as number) / 32767 - 0.5) < 0.01)
    assert.ok(Math.abs((out[0] as number) / 32767 + 0.5) < 0.01)
  })

  it('非法倍率（to >= from）返回副本，空数组返回空', () => {
    assert.deepEqual([...downsamplePeaks(peaks, 10, 100)], [...peaks])
    assert.equal(downsamplePeaks(new Int16Array(0), 100, 10).length, 0)
  })

  it('peaksStats 给出整体峰值 dB', () => {
    const st = peaksStats(peaks)
    assert.equal(st.pairs, 100)
    assert.ok(Math.abs(st.peakDb + 6.02) < 0.1, `0.5 满幅 → ${st.peakDb.toFixed(2)} dB`)
  })
})
