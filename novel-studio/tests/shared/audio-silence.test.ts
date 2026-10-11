/**
 * 测试 · 静音区间（ffmpeg `silencedetect` 解析 + 边界吸附）
 * ============================================================================
 * 真机需求（第三次复报）：「音频的最后还是有下一段的杂音【众】，我需要**治本**的方法」。
 *
 * 治本的那一半就是这里：边界要落在**音频真实的静音**里，而不是只信识别的时间戳
 * （whisper 把那个「众」报在 36900，而音频里它从 37138 才开始）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  nearestSilenceCenter,
  parseSilencedetect,
  snapBoundaryToSilence,
} from '../../src/shared/audio/silence.ts'

describe('silencedetect 解析', () => {
  it('成对的 silence_start / silence_end（单位是秒）', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 3.52',
      '[silencedetect @ 0x1] silence_end: 3.86 | silence_duration: 0.34',
      '[silencedetect @ 0x1] silence_start: 36.399',
      '[silencedetect @ 0x1] silence_end: 37.138 | silence_duration: 0.739',
    ].join('\n')
    assert.deepEqual(parseSilencedetect(stderr), [
      { startMs: 3520, endMs: 3860 },
      { startMs: 36399, endMs: 37138 },
    ])
  })

  it('文件开头就是静音（只有 silence_end）→ 起点按 0 算', () => {
    assert.deepEqual(parseSilencedetect('[silencedetect @ 0x1] silence_end: 1.25 | silence_duration: 1.25'), [
      { startMs: 0, endMs: 1250 },
    ])
  })

  it('文件结尾是静音（只有 silence_start）→ 用给出的总时长收尾；没给就丢掉', () => {
    const line = '[silencedetect @ 0x1] silence_start: 210.5'
    assert.deepEqual(parseSilencedetect(line, 213_000), [{ startMs: 210_500, endMs: 213_000 }])
    assert.deepEqual(parseSilencedetect(line), [])
  })

  it('没有静音 / 垃圾输入都不抛错', () => {
    assert.deepEqual(parseSilencedetect(''), [])
    assert.deepEqual(parseSilencedetect('frame=  100 fps=0.0 q=-0.0 size=N/A'), [])
  })
})

describe('边界吸附到静音', () => {
  it('取「静音 ∩ 窗口」最长那段的中心', () => {
    const silences = [
      { startMs: 36_399, endMs: 37_138 },
      { startMs: 20_000, endMs: 20_100 },
    ]
    // 窗口 = [上一行认出来的话结束, 下一行认出来的话开始]
    assert.equal(snapBoundaryToSilence(36_260, 36_900, silences), 36_650)
  })

  it('窗口完全落在静音里 → 取窗口中心（不越界）', () => {
    assert.equal(snapBoundaryToSilence(1000, 1100, [{ startMs: 0, endMs: 9000 }]), 1050)
  })

  it('窗口里没有静音 → null（调用方保留识别给的边界）', () => {
    assert.equal(snapBoundaryToSilence(1000, 1100, [{ startMs: 2000, endMs: 3000 }]), null)
    assert.equal(snapBoundaryToSilence(1000, 1100, []), null)
  })


describe('退路：找最近的够长静音', () => {
  it('取离边界最近的、且够长的静音中心', () => {
    const silences = [
      { startMs: 10_000, endMs: 10_050 }, // 太短（50ms），不算
      { startMs: 36_399, endMs: 37_138 }, // 739ms：距离 36000 是 399ms
      { startMs: 20_000, endMs: 20_900 },
    ]
    assert.equal(nearestSilenceCenter(36_000, silences), 36_769, '(36399+37138)/2 = 36768.5 → 四舍五入')
  })

  it('距离相同取更长的；都太远就返回 null', () => {
    assert.equal(
      nearestSilenceCenter(1000, [
        { startMs: 0, endMs: 900 },
        { startMs: 1100, endMs: 1600 },
      ]),
      450,
      '两侧距离相同（各 100ms）：取更长的那个（左边 900ms > 右边 500ms）',
    )
    assert.equal(nearestSilenceCenter(1000, [{ startMs: 5000, endMs: 6000 }]), null)
    assert.equal(nearestSilenceCenter(1000, []), null)
  })
})
  it('退化窗口（上界 ≤ 下界）→ null', () => {
    assert.equal(snapBoundaryToSilence(1000, 1000, [{ startMs: 0, endMs: 9000 }]), null)
    assert.equal(snapBoundaryToSilence(1200, 1000, [{ startMs: 0, endMs: 9000 }]), null)
  })
})
