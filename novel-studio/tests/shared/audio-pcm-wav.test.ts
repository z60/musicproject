/**
 * Novel Studio · PCM / WAV 单元测试
 * ============================================================================
 * 覆盖 docs/05 §2.4 §2.5 §3 §12：
 *   · 字节/帧/时长换算
 *   · 24-bit 与 float32 互转往返（容差）
 *   · 削波计数（连续 >= 3 个 |x| >= 0.99 计一次）
 *   · 静音返回 -Infinity（不是 0、不是 NaN）
 *   · WAV 头写入 → 解析 往返一致
 *   · 崩溃恢复四种情形：有 meta / 无 meta / data 声明超实际 / 文件 < 44 字节
 *
 * 运行：node --experimental-strip-types tests/shared/audio-pcm-wav.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  CLIP_THRESHOLD,
  bytesPerFrame,
  bytesPerSample,
  computeCrestFactorDb,
  computePeakDb,
  computeRmsDb,
  dbToLinear,
  deinterleaveChannels,
  detectClipping,
  durationMsToFrames,
  fileSizeToFrames,
  float32ToInt16LE,
  float32ToInt24LE,
  framesToDurationMs,
  interleaveChannels,
  int16LEToFloat32,
  int24LEToFloat32,
  linearToDb,
  mixdownToMono,
} from '../../src/shared/audio/pcm.ts'
import {
  WAV_HEADER_BYTES,
  parseWavHeader,
  repairWavHeader,
  writeWavHeader,
} from '../../src/shared/audio/wav.ts'
import type { AudioFormat } from '../../src/shared/types.ts'

const FMT_24: AudioFormat = { sampleRate: 48000, bitDepth: 24, channels: 1 }
const FMT_32F: AudioFormat = { sampleRate: 48000, bitDepth: 32, channels: 1 }
const FMT_STEREO_16: AudioFormat = { sampleRate: 44100, bitDepth: 16, channels: 2 }

/** 生成一段确定性信号（不用随机，保证测试可复现） */
function sine(freq: number, amp: number, seconds: number, sampleRate = 48000): Float32Array {
  const n = Math.round(seconds * sampleRate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

// ---------------------------------------------------------------------------
// 换算
// ---------------------------------------------------------------------------

describe('PCM 字节与帧换算', () => {
  it('bytesPerSample：16→2 / 24→3 / 32(float32)→4', () => {
    assert.equal(bytesPerSample(16), 2)
    assert.equal(bytesPerSample(24), 3)
    // 32 位是 float32，也是 4 字节
    assert.equal(bytesPerSample(32), 4)
  })

  it('bytesPerFrame 把声道数算进去', () => {
    assert.equal(bytesPerFrame(FMT_24), 3)
    assert.equal(bytesPerFrame(FMT_32F), 4)
    assert.equal(bytesPerFrame(FMT_STEREO_16), 4)
  })

  it('时长 ↔ 帧数换算往返一致（整数毫秒）', () => {
    assert.equal(durationMsToFrames(1000, 48000), 48000)
    assert.equal(durationMsToFrames(20, 48000), 960) // VAD 帧长 20 ms = 960 样本
    assert.equal(framesToDurationMs(960, 48000), 20)
    assert.equal(framesToDurationMs(durationMsToFrames(742000, 48000), 48000), 742000)
    assert.equal(durationMsToFrames(-5, 48000), 0, '负时长按 0 处理')
  })

  it('fileSizeToFrames 按 (size-44)/bytesPerFrame 向下取整，且小于 44 字节返回 0', () => {
    assert.equal(fileSizeToFrames(WAV_HEADER_BYTES + 300, FMT_24), 100)
    assert.equal(fileSizeToFrames(WAV_HEADER_BYTES + 301, FMT_24), 100)
    assert.equal(fileSizeToFrames(10, FMT_24), 0)
  })
})

// ---------------------------------------------------------------------------
// 量化往返
// ---------------------------------------------------------------------------

describe('float32 ↔ int16 / int24 互转', () => {
  it('24-bit 往返误差 < 1e-6 量级（真实误差为 1/2^23）', () => {
    const src = sine(1000, 0.8, 0.01)
    const back = int24LEToFloat32(float32ToInt24LE(src))
    assert.equal(back.length, src.length, '样本数必须一致（3 字节/样本）')
    let maxErr = 0
    for (let i = 0; i < src.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((src[i] as number) - (back[i] as number)))
    }
    assert.ok(maxErr < 1e-6, `24-bit 往返最大误差 ${maxErr} 应小于 1e-6`)
  })

  it('24-bit 边界值不溢出：+1 → 0x7FFFFF、-1 → 0x800000', () => {
    const src = new Float32Array([1, -1, 0])
    const buf = float32ToInt24LE(src)
    assert.equal(buf.length, 9)
    assert.deepEqual([...buf.subarray(0, 3)], [0xff, 0xff, 0x7f])
    assert.deepEqual([...buf.subarray(3, 6)], [0x00, 0x00, 0x80])
    assert.deepEqual([...buf.subarray(6, 9)], [0x00, 0x00, 0x00])
    const back = int24LEToFloat32(buf)
    assert.ok(Math.abs((back[0] as number) - 1) < 1e-6)
    assert.ok(Math.abs((back[1] as number) + 1) < 1e-6)
  })

  it('16-bit 往返误差 < 1e-4，且小端字节序正确', () => {
    const src = new Float32Array([0.5, -0.5])
    const buf = float32ToInt16LE(src)
    assert.equal(buf.length, 4)
    assert.equal(buf.readInt16LE(0), 16384) // 0.5*32767 四舍五入
    assert.equal(buf.readInt16LE(2), -16384)
    const back = int16LEToFloat32(buf)
    assert.ok(Math.abs((back[0] as number) - 0.5) < 1e-4)
    assert.ok(Math.abs((back[1] as number) + 0.5) < 1e-4)
  })
})

describe('声道交织 / 解交织', () => {
  it('交织后解交织完全还原', () => {
    const l = new Float32Array([1, 2, 3])
    const r = new Float32Array([-1, -2, -3])
    const i = interleaveChannels([l, r])
    assert.deepEqual([...i], [1, -1, 2, -2, 3, -3])
    const [ll, rr] = deinterleaveChannels(i, 2)
    assert.deepEqual([...(ll as Float32Array)], [1, 2, 3])
    assert.deepEqual([...(rr as Float32Array)], [-1, -2, -3])
  })

  it('降为单声道取等权平均（对应 pan=mono|c0=0.5*c0+0.5*c1）', () => {
    const mono = mixdownToMono(new Float32Array([1, 0, 0.5, 0.5]), 2)
    assert.deepEqual([...mono], [0.5, 0.5])
  })
})

// ---------------------------------------------------------------------------
// 电平与削波
// ---------------------------------------------------------------------------

describe('峰值 / RMS / 削波', () => {
  it('静音返回 -Infinity（明确处理，不是 0 也不是 NaN）', () => {
    assert.equal(computePeakDb(new Float32Array(0)), Number.NEGATIVE_INFINITY)
    assert.equal(computeRmsDb(new Float32Array(0)), Number.NEGATIVE_INFINITY)
    assert.equal(computePeakDb(new Float32Array([0, 0, 0])), Number.NEGATIVE_INFINITY)
    assert.equal(computeRmsDb(new Float32Array([0, 0, 0])), Number.NEGATIVE_INFINITY)
    assert.equal(computeCrestFactorDb(new Float32Array([0, 0])), 0)
  })

  it('满幅正弦：峰值 ≈ 0 dBFS、RMS ≈ -3.01 dBFS', () => {
    const s = sine(1000, 1, 0.05)
    assert.ok(Math.abs(computePeakDb(s) - 0) < 0.01, `峰值 ${computePeakDb(s)}`)
    assert.ok(Math.abs(computeRmsDb(s) - -3.0103) < 0.02, `RMS ${computeRmsDb(s)}`)
  })

  it('削波：连续 >= 3 个 |x| >= 0.99 才计一次，孤立的 2 个不算', () => {
    // 3 连击 → 1 次
    assert.equal(detectClipping(new Float32Array([0.5, 0.995, 0.995, 0.995, 0.2])), 1)
    // 2 连击 → 0 次
    assert.equal(detectClipping(new Float32Array([0.5, 0.995, 0.995, 0.2])), 0)
    // 一段长过载（10 个样本）只计 1 次（3 个一组：3,3,3 → 1 次后清零，剩 1 个不构成）
    assert.equal(detectClipping(new Float32Array(10).fill(1)), 3)
    // 阈值可调：0.5 阈值下 [0.6,0.6,0.6] 也算一次
    assert.equal(detectClipping(new Float32Array([0.6, 0.6, 0.6]), { threshold: 0.5 }), 1)
    assert.equal(detectClipping(new Float32Array([0.6, 0.6, 0.6])), 0)
    // 恰好等于阈值 0.99 也算（>=）
    assert.equal(detectClipping(new Float32Array([CLIP_THRESHOLD, CLIP_THRESHOLD, CLIP_THRESHOLD])), 1)
    // 不连续的两组 → 2 次
    assert.equal(
      detectClipping(new Float32Array([0.99, 0.99, 0.99, 0.1, 0.99, 0.99, 0.99])),
      2,
    )
  })

  it('dB ↔ 线性换算：dBToLinear(-1) ≈ 0.891251', () => {
    assert.ok(Math.abs(dbToLinear(-1) - 0.891251) < 1e-6)
    assert.ok(Math.abs(dbToLinear(-6) - 0.501187) < 1e-6)
    assert.equal(dbToLinear(Number.NEGATIVE_INFINITY), 0)
    assert.equal(linearToDb(0), Number.NEGATIVE_INFINITY)
    assert.ok(Math.abs(linearToDb(dbToLinear(-3.5)) + 3.5) < 1e-9)
  })
})

// ---------------------------------------------------------------------------
// WAV 头
// ---------------------------------------------------------------------------

describe('WAV 头写入与解析', () => {
  it('写出 44 字节标准头，字段与 RIFF 规范一致', () => {
    const header = writeWavHeader({ dataBytes: 48000 * 3, format: FMT_24 })
    assert.equal(header.length, WAV_HEADER_BYTES)
    assert.equal(header.toString('ascii', 0, 4), 'RIFF')
    assert.equal(header.toString('ascii', 8, 12), 'WAVE')
    assert.equal(header.toString('ascii', 12, 16), 'fmt ')
    assert.equal(header.readUInt32LE(16), 16)
    assert.equal(header.readUInt16LE(20), 1, '24-bit PCM 的格式标签是 1')
    assert.equal(header.readUInt16LE(22), 1)
    assert.equal(header.readUInt32LE(24), 48000)
    assert.equal(header.readUInt32LE(28), 48000 * 3, 'byteRate = sampleRate * blockAlign')
    assert.equal(header.readUInt16LE(32), 3, 'blockAlign')
    assert.equal(header.readUInt16LE(34), 24)
    assert.equal(header.toString('ascii', 36, 40), 'data')
    assert.equal(header.readUInt32LE(40), 144000)
    assert.equal(header.readUInt32LE(4), 36 + 144000)
  })

  it('bitDepth=32 写 IEEE float 标签（3），不是整型 PCM', () => {
    const header = writeWavHeader({ dataBytes: 0, format: FMT_32F })
    assert.equal(header.readUInt16LE(20), 3)
    assert.equal(header.readUInt16LE(34), 32)
    assert.equal(header.readUInt16LE(32), 4)
  })

  it('写入 → 解析往返一致（含立体声 44.1k）', () => {
    for (const fmt of [FMT_24, FMT_32F, FMT_STEREO_16]) {
      const header = writeWavHeader({ dataBytes: 123456, format: fmt })
      const body = Buffer.alloc(123456)
      const parsed = parseWavHeader(Buffer.concat([header, body]))
      assert.equal(parsed.valid, true, parsed.reason)
      assert.equal(parsed.dataBytes, 123456)
      assert.equal(parsed.dataOffset, WAV_HEADER_BYTES)
      assert.deepEqual(parsed.format, fmt)
    }
  })

  it('文件小于 44 字节 → valid=false 且给出原因', () => {
    const parsed = parseWavHeader(Buffer.alloc(20))
    assert.equal(parsed.valid, false)
    assert.match(parsed.reason ?? '', /小于 44 字节/)
    assert.equal(parsed.dataBytes, 0)
  })

  it('data 声明长度超过实际大小 → valid=false，dataBytes 按实际裁剪', () => {
    const header = writeWavHeader({ dataBytes: 100000, format: FMT_24 })
    const parsed = parseWavHeader(Buffer.concat([header, Buffer.alloc(3000)]))
    assert.equal(parsed.valid, false)
    assert.equal(parsed.dataBytes, 3000)
    assert.match(parsed.reason ?? '', /data 块声明/)
  })

  it('非 WAV 数据 → valid=false', () => {
    const parsed = parseWavHeader(Buffer.alloc(100, 0x41))
    assert.equal(parsed.valid, false)
    assert.match(parsed.reason ?? '', /RIFF/)
  })
})

// ---------------------------------------------------------------------------
// 崩溃恢复（docs/05 §3）
// ---------------------------------------------------------------------------

describe('崩溃恢复：repairWavHeader', () => {
  it('情形 1：meta 存在 → 用 meta.framesWritten 定稿头', () => {
    const frames = 48000 // 1 秒
    const fileSize = WAV_HEADER_BYTES + frames * 3
    const r = repairWavHeader({ fileSizeBytes: fileSize, meta: { format: FMT_24, framesWritten: frames } })
    assert.equal(r.usedFallback, false)
    assert.equal(r.recoverable, true)
    assert.equal(r.frames, frames)
    assert.equal(r.header.readUInt32LE(40), frames * 3)
    assert.equal(r.header.readUInt32LE(4), 36 + frames * 3)
  })

  it('情形 2：meta 缺失 → 按 (fileSize-44)/bytesPerFrame 反推，并标记用了兜底', () => {
    const r = repairWavHeader({ fileSizeBytes: WAV_HEADER_BYTES + 900, meta: null })
    assert.equal(r.usedFallback, true)
    assert.equal(r.format.bitDepth, 24, 'meta 缺失时用兜底格式 48k/24bit/mono')
    assert.equal(r.frames, 300)
    assert.equal(r.header.readUInt32LE(40), 900)
  })

  it('情形 3：data 声明超过实际大小（头大身子小）→ 以文件为准取 min', () => {
    // meta 说写了 100000 帧，文件实际只有 1000 帧
    const r = repairWavHeader({
      fileSizeBytes: WAV_HEADER_BYTES + 3000,
      meta: { format: FMT_24, framesWritten: 100000 },
    })
    assert.equal(r.frames, 1000, '必须取文件实际可用帧数')
    assert.equal(r.header.readUInt32LE(40), 3000)
    assert.match(r.reason ?? '', /已按文件为准裁剪/)
  })

  it('情形 4：文件 < 44 字节 → recoverable=false（只有头没有素材，不产出 0 秒文件）', () => {
    const r = repairWavHeader({ fileSizeBytes: 20, meta: null })
    assert.equal(r.recoverable, false)
    assert.equal(r.frames, 0)
    assert.equal(r.usedFallback, true)
    assert.match(r.reason ?? '', /只有头没有素材/)
    assert.equal(r.header.length, WAV_HEADER_BYTES, '仍要给出合法头，便于 UI 展示元信息')
  })

  it('恢复后的头能被 parseWavHeader 正常解析（补头副本必须可播放）', () => {
    const frames = 24000
    const r = repairWavHeader({
      fileSizeBytes: WAV_HEADER_BYTES + frames * 3,
      meta: { format: FMT_24, framesWritten: frames },
    })
    const parsed = parseWavHeader(Buffer.concat([r.header, Buffer.alloc(frames * 3)]))
    assert.equal(parsed.valid, true, parsed.reason)
    assert.equal(parsed.dataBytes, frames * 3)
    assert.equal(parsed.format.bitDepth, 24)
  })
})
