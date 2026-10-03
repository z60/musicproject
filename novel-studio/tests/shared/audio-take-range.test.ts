/**
 * Novel Studio · take 的源文件播放区间（真机反馈：「CV 音导入后无法播放」）
 * ============================================================================
 * 「按说话人导入」的 take 指向整段源文件：音频在第 `srcInMs` 毫秒，**不是第 0 毫秒**。
 * 这两条口径必须有测试钉住，否则播放侧会悄悄退化成「从文件开头放」。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  sourceMsToSeconds,
  takeRangeDuration,
  takeSourceRange,
} from '../../src/shared/audio/take-range.ts'

describe('take 的源文件播放区间', () => {
  it('导入的 take：区间是 srcInMs ~ srcOutMs（音频在文件中间）', () => {
    const range = takeSourceRange({
      srcInMs: 739_980,
      srcOutMs: 745_340,
      trimmedInMs: 0,
      trimmedOutMs: 5_360,
      durationMs: 5_360,
    })
    assert.deepEqual(range, { startMs: 739_980, endMs: 745_340 })
    assert.equal(takeRangeDuration({ srcInMs: 739_980, srcOutMs: 745_340, trimmedOutMs: 5_360 }), 5_360)
  })

  it('本地录制的 take：srcInMs=0，只有修剪值时行为与以前一致', () => {
    assert.deepEqual(takeSourceRange({ srcInMs: 0, trimmedInMs: 1_200, trimmedOutMs: 8_400, durationMs: 9_600 }), {
      startMs: 1_200,
      endMs: 8_400,
    })
    assert.deepEqual(takeSourceRange({ trimmedInMs: 500, durationMs: 3_000 }), { startMs: 500, endMs: 3_500 })
  })

  it('连续录制的切片：源内偏移 + 段内修剪相加', () => {
    assert.deepEqual(takeSourceRange({ srcInMs: 60_000, trimmedInMs: 300, trimmedOutMs: 2_000 }), {
      startMs: 60_300,
      endMs: 62_000,
    })
  })

  it('缺 trimmedOutMs 时退回 durationMs；再缺则退回 srcOutMs（它是源内坐标，不再加 srcIn）', () => {
    assert.deepEqual(takeSourceRange({ srcInMs: 1_000, trimmedInMs: 0, durationMs: 4_000 }), {
      startMs: 1_000,
      endMs: 5_000,
    })
    assert.deepEqual(takeSourceRange({ srcInMs: 1_000, srcOutMs: 7_000 }), { startMs: 1_000, endMs: 7_000 })
  })

  it('脏数据（空/负数/NaN/全零）也给出非空区间，调用方不必再补边界', () => {
    for (const take of [
      {},
      { srcInMs: null, trimmedInMs: null, durationMs: null },
      { srcInMs: -5, trimmedInMs: -5, trimmedOutMs: -1 },
      { srcInMs: Number.NaN, durationMs: 0 },
      { srcInMs: 500, srcOutMs: 100 },
    ]) {
      const range = takeSourceRange(take)
      assert.ok(range.endMs > range.startMs, `区间必须非空：${JSON.stringify(take)}`)
      assert.ok(range.startMs >= 0)
    }
  })

  it('sourceMsToSeconds 把源内毫秒钳进区间（seek 不会落到区间外）', () => {
    const take = { srcInMs: 10_000, srcOutMs: 12_000, trimmedOutMs: 2_000 }
    assert.equal(sourceMsToSeconds(take, 0), 10)
    assert.equal(sourceMsToSeconds(take, 11_000), 11)
    assert.equal(sourceMsToSeconds(take, 99_999), 11.999, '钳到 endMs - 1ms，而不是越界')
  })
})
