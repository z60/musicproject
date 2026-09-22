/**
 * 测试 · peakPairsToEnvelope（take 预览波形的数据解析）
 * ============================================================================
 * 真机事故 docs/91 §5.2.47：波形区要显示"当前选中／刚录制的 take"，
 * 但渲染进程 CSP 是 `connect-src 'self'`，`fetch('ns-media://…')` 被拦掉 ——
 * 所以数据必须走主进程 `analysis:peaks`（契约：**min/max 交替、归一化 [-1,1]**）。
 * 这个纯函数负责把契约载荷切成可绘制的 min/max 列。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { peakPairsToEnvelope } from '../../src/renderer/src/shared/lib/waveform-transform.ts'

describe('peakPairsToEnvelope（analysis:peaks → min/max 列）', () => {
  it('min/max 交替解析（不是把每个值当成一条独立柱子）', () => {
    const out = peakPairsToEnvelope([-0.5, 0.5, -0.2, 0.8])
    assert.deepEqual(out, [
      { min: -0.5, max: 0.5 },
      { min: -0.2, max: 0.8 },
    ])
  })

  it('空数组 / 只有一个值（缺 max）→ 不产生列', () => {
    assert.deepEqual(peakPairsToEnvelope([]), [])
    assert.deepEqual(peakPairsToEnvelope([0.3]), [], '奇数长度：最后一个未成对的值必须丢弃')
  })

  it('奇数长度只丢最后一个未成对的值', () => {
    const out = peakPairsToEnvelope([0.1, 0.2, 0.3])
    assert.deepEqual(out, [{ min: 0.1, max: 0.2 }])
  })

  it('越界值夹到 [-1,1]（画布只在 [-1,1] 上有定义）', () => {
    const out = peakPairsToEnvelope([-3, 4, -1.5, 0.25])
    assert.deepEqual(out, [
      { min: -1, max: 1 },
      { min: -1, max: 0.25 },
    ])
  })

  it('缺值按 0 处理（不产生 NaN）', () => {
    const sparse: number[] = []
    sparse[1] = 0.6 // 第 0 位是空洞
    const out = peakPairsToEnvelope(sparse)
    assert.deepEqual(out, [{ min: 0, max: 0.6 }])
  })
})
