/**
 * Novel Studio · 响度标准化单元测试
 * ============================================================================
 * 覆盖 docs/05 §8 / docs/15 §4 §6.2：
 *   · dB ↔ 线性换算（alimiter.limit 是线性值：-1 dBFS → 0.891）
 *   · 增益计算（线性增益法，不用 loudnorm 第二遍）与上限夹紧
 *   · loudnorm JSON 解析：正常 / 缺字段 / 非法 JSON / 静音(-inf) / 尾随逗号
 *   · ebur128 Summary 解析（降级路径）
 *   · 响度容差判定（QC_THRESHOLDS.lufsTolerance = 1.0 LU）与真峰判定
 *
 * 运行：node --experimental-strip-types tests/shared/audio-loudness.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { QC_THRESHOLDS } from '../../src/shared/constants.ts'
import {
  checkLoudness,
  checkTruePeak,
  computeGainDb,
  computeGainDbWithNeighbors,
  parseEbur128Summary,
  parseLoudnormJson,
  truePeakDbToLimitLinear,
} from '../../src/shared/audio/loudness.ts'
// dB ↔ 线性的实现唯一来源是 pcm.ts（audio/index.ts 的 export * 才不会歧义）
import { dbToLinear, linearToDb } from '../../src/shared/audio/pcm.ts'

/** ffmpeg loudnorm print_format=json 的真实输出片段（含前面的解析器日志） */
const LOUDNORM_STDERR = `ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers
Input #0, wav, from 'chapter.wav':
  Duration: 00:12:22.00, bitrate: 1152 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (pcm_s24le (native) -> pcm_s16le (native))
[Parsed_loudnorm_0 @ 000001d8f0a2c040]
{
\t"input_i" : "-15.87",
\t"input_tp" : "-2.10",
\t"input_lra" : "7.40",
\t"input_thresh" : "-26.30",
\t"output_i" : "-15.71",
\t"output_tp" : "-1.00",
\t"output_lra" : "7.40",
\t"output_thresh" : "-25.99",
\t"normalization_type" : "dynamic",
\t"target_offset" : "-0.29"
}
size=N/A time=00:12:22.00 bitrate=N/A speed=  42x
`

const EBUR128_STDERR = `[Parsed_ebur128_0 @ 0x55d1] t: 12.2 M: -14.1 S: -15.0 I: -16.1 LUFS LRA: 6.9 LU
[Parsed_ebur128_0 @ 0x55d1]
Summary:

  Integrated loudness:
    I:         -16.1 LUFS
    Threshold: -26.5 LUFS

  Loudness range:
    LRA:         6.9 LU
    Threshold: -36.5 LUFS
    LRA low:   -21.4 LUFS
    LRA high:  -14.5 LUFS

  True peak:
    Peak:       -1.2 dBFS
`

// ---------------------------------------------------------------------------
// 换算
// ---------------------------------------------------------------------------

describe('响度：dB ↔ 线性', () => {
  it('dbToLinear(-1) ≈ 0.891（alimiter 的 limit 就是它）', () => {
    assert.ok(Math.abs(dbToLinear(-1) - 0.891251) < 1e-6)
    assert.ok(Math.abs(truePeakDbToLimitLinear(-1) - 0.891251) < 1e-6)
    assert.ok(Math.abs(truePeakDbToLimitLinear(-6) - 0.501187) < 1e-6)
  })

  it('边界：-Infinity → 0；0 dB → 1', () => {
    assert.equal(dbToLinear(Number.NEGATIVE_INFINITY), 0)
    assert.equal(dbToLinear(0), 1)
    assert.equal(linearToDb(0), Number.NEGATIVE_INFINITY)
    assert.equal(linearToDb(-1), Number.NEGATIVE_INFINITY)
    assert.ok(Math.abs(linearToDb(0.891251) + 1) < 1e-5)
  })
})

describe('响度：增益计算（线性增益法）', () => {
  it('gainDb = target - measured', () => {
    assert.ok(Math.abs(computeGainDb(-15.87, -16) + 0.13) < 1e-9)
    assert.ok(Math.abs(computeGainDb(-20, -16) - 4) < 1e-9)
    assert.ok(Math.abs(computeGainDb(-12, -16) + 4) < 1e-9)
  })

  it('maxGainDb 会夹紧（避免把噪声底一起抬起来）', () => {
    assert.equal(computeGainDb(-40, -16, 12), 12)
    assert.equal(computeGainDb(-5, -16, 12), -11)
    assert.equal(computeGainDb(-20, -16, 12), 4)
  })

  it('静音章（input_i 非有限）返回 0 dB，由调用方阻断（EXPORT_SILENT_CHAPTER）', () => {
    assert.equal(computeGainDb(Number.NEGATIVE_INFINITY, -16), 0)
    assert.equal(computeGainDb(Number.NaN, -16), 0)
  })

  it('短章用相邻章平均增益校正（docs/05 §8.2）', () => {
    const r = computeGainDbWithNeighbors(-19, -16, [3, 5], { chapterDurationMs: 20_000, shortChapterMs: 60_000 })
    assert.equal(r.corrected, true)
    // 本章实测增益 3 dB（-19 → -16），邻章均值 4 dB → 取两者平均 3.5 dB
    assert.ok(Math.abs(r.gainDb - 3.5) < 1e-9, `短章校正后应为 3.5 dB，实际 ${r.gainDb}`)
    const r2 = computeGainDbWithNeighbors(-19, -16, [3, 5], { chapterDurationMs: 120_000 })
    assert.equal(r2.corrected, false)
    assert.equal(r2.gainDb, 3)
  })
})

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

describe('响度：loudnorm JSON 解析', () => {
  it('正常输出：字段全部解析为 number', () => {
    const m = parseLoudnormJson(LOUDNORM_STDERR)
    assert.ok(m, '应解析成功')
    assert.ok(Math.abs(m!.inputI + 15.87) < 1e-9)
    assert.ok(Math.abs(m!.inputTp + 2.1) < 1e-9)
    assert.ok(Math.abs(m!.inputLra - 7.4) < 1e-9)
    assert.ok(Math.abs(m!.inputThresh + 26.3) < 1e-9)
    assert.ok(Math.abs(m!.targetOffset + 0.29) < 1e-9)
  })

  it('缺字段：缺失项为 NaN，其余照常解析（不抛错）', () => {
    const m = parseLoudnormJson('loudnorm\n{\n "input_i" : "-16.00",\n "input_tp" : "-1.00"\n}\n')
    assert.ok(m)
    assert.equal(m!.inputI, -16)
    assert.equal(m!.inputTp, -1)
    assert.ok(Number.isNaN(m!.inputLra))
    assert.ok(Number.isNaN(m!.inputThresh))
    assert.ok(Number.isNaN(m!.targetOffset))
  })

  it('非法 JSON → null（调用方走 ebur128 降级或抛 EXPORT_FFMPEG_FAILED）', () => {
    assert.equal(parseLoudnormJson('total garbage, no json here'), null)
    assert.equal(parseLoudnormJson('{ "input_i": "-16", '), null)
    assert.equal(parseLoudnormJson(''), null)
    assert.equal(parseLoudnormJson('{ "foo": 1 }'), null, '不含 loudnorm 字段的 JSON 不算测量结果')
  })

  it('尾随逗号（部分构建/日志截断）也能解析', () => {
    const m = parseLoudnormJson('{\n"input_i" : "-16.5",\n"input_tp" : "-1.5",\n}')
    assert.ok(m)
    assert.equal(m!.inputI, -16.5)
  })

  it('静音章：input_i = "-inf" → NaN（不是 Infinity/0，避免误算增益）', () => {
    const m = parseLoudnormJson('{ "input_i" : "-inf", "input_tp" : "-inf", "input_lra" : "0.0", "input_thresh" : "-inf", "target_offset" : "0.0" }')
    assert.ok(m)
    assert.ok(Number.isNaN(m!.inputI))
    assert.ok(Number.isNaN(m!.inputTp))
    assert.equal(m!.inputLra, 0)
  })
})

describe('响度：ebur128 Summary 解析（降级路径）', () => {
  it('解析 I 与 True peak', () => {
    const r = parseEbur128Summary(EBUR128_STDERR)
    assert.ok(r)
    assert.equal(r!.lufs, -16.1)
    assert.equal(r!.truePeakDb, -1.2)
  })

  it('只有 Integrated 段也能解析出 lufs', () => {
    const r = parseEbur128Summary('  Integrated loudness:\n    I:         -23.0 LUFS\n')
    assert.ok(r)
    assert.equal(r!.lufs, -23)
    assert.equal(r!.truePeakDb, null)
  })

  it('无关输出 → null', () => {
    assert.equal(parseEbur128Summary('nothing here'), null)
    assert.equal(parseEbur128Summary(''), null)
  })
})

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

describe('响度：容差判定（QC_THRESHOLDS.lufsTolerance = 1.0 LU）', () => {
  it('|Δ| ≤ 1.0 → ok', () => {
    assert.equal(QC_THRESHOLDS.lufsTolerance, 1.0)
    assert.equal(checkLoudness(-16.1, -16).ok, true)
    assert.equal(checkLoudness(-15.0, -16).ok, true)
    assert.equal(checkLoudness(-17.0, -16).ok, true)
    assert.ok(Math.abs(checkLoudness(-16.1, -16).delta + 0.1) < 1e-9)
    assert.equal(checkLoudness(-16.1, -16).message, undefined)
  })

  it('|Δ| > 1.0 → 不 ok 且带提示文案', () => {
    const r = checkLoudness(-14.8, -16)
    assert.equal(r.ok, false)
    assert.ok(Math.abs(r.delta - 1.2) < 1e-9)
    assert.match(r.message ?? '', /超出容差/)
    assert.match(r.message ?? '', /1\.20 LU/)
  })

  it('自定义容差与无效测量值', () => {
    assert.equal(checkLoudness(-14.8, -16, { tolerance: 1.5 }).ok, true)
    const bad = checkLoudness(Number.NaN, -16)
    assert.equal(bad.ok, false)
    assert.ok(Number.isNaN(bad.delta))
    assert.match(bad.message ?? '', /无效/)
  })

  it('真峰判定：超过目标 → 提示再降 0.5 dB 重渲', () => {
    assert.equal(checkTruePeak(-1.2, -1).ok, true)
    const bad = checkTruePeak(-0.1, -1)
    assert.equal(bad.ok, false)
    assert.ok(Math.abs(bad.excessDb - 0.9) < 1e-9)
    assert.match(bad.message ?? '', /再降 1\.4 dB/)
    assert.equal(checkTruePeak(Number.NaN, -1).ok, false)
  })
})
