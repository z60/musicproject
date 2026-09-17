/**
 * 渲染进程纯逻辑测试 · 波形坐标换算
 * ============================================================================
 * 覆盖 docs/13 §4.5/§4.6（时间线缩放、LOD 3 级、脏矩形重绘）与 docs/05 §11.3/§11.4：
 *   · 时间 ↔ 像素互逆（含缩放锚点不动）
 *   · LOD 选择（100 / 10 / 1 peaks/s）
 *   · peaks 索引映射的边界（首尾、越界、空数据）
 *   · 脏矩形计算不越界、相同区域返回 null
 *   · min/max 包络抽取（不能抽样丢瞬态）
 *
 * 运行：node --experimental-strip-types tests/renderer/waveform-transform.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_PX_PER_PEAK,
  TIMELINE_ZOOM_LIMITS,
  amplitudeToDbfs,
  amplitudeToY,
  buildEnvelope,
  chooseLod,
  clampTime,
  clipRect,
  computeDirtyRect,
  computeVisiblePeaks,
  dbfsToAmplitude,
  durationToWidth,
  expandRect,
  fitPxPerMs,
  intersectRect,
  isTimeRangeVisible,
  normalizeRect,
  peaksBucketMs,
  peaksIndexAtTime,
  peaksIndexRange,
  rectsIntersect,
  shouldSwitchLod,
  timeAtPeaksIndex,
  timeRangeToDirtyRect,
  timeToX,
  unionRect,
  viewportDurationMs,
  viewportEndMs,
  xToTime,
  zoomAround,
} from '../../src/renderer/src/shared/lib/waveform-transform.ts'

const VP = { pxPerMs: 0.02, scrollMs: 10_000 } // 20 px/s，视口左边缘在 10 s

// ---------------------------------------------------------------------------
// 时间 ↔ 像素
// ---------------------------------------------------------------------------

test('timeToX / xToTime 互逆', () => {
  for (const ms of [10_000, 12_345, 60_000, 3_600_000]) {
    const x = timeToX(ms, VP)
    assert.ok(Math.abs(xToTime(x, VP) - ms) < 1e-9, `${ms} 应可逆`)
  }
  assert.equal(timeToX(10_000, VP), 0) // 视口左边缘
  assert.equal(timeToX(11_000, VP), 20) // 1 s → 20 px
  assert.equal(xToTime(20, VP), 11_000)
  assert.equal(timeToX(9_000, VP), -20) // 视口左侧为负，交由裁剪处理
})

test('时长与视口换算', () => {
  assert.equal(durationToWidth(5_000, VP), 100)
  assert.equal(viewportDurationMs(1000, VP), 50_000)
  assert.equal(viewportEndMs(1000, VP), 60_000)
  assert.equal(viewportDurationMs(1000, { pxPerMs: 0, scrollMs: 0 }), 0)
  assert.equal(clampTime(-100, 60_000), 0)
  assert.equal(clampTime(99_999, 60_000), 60_000)
  assert.equal(clampTime(Number.NaN, 60_000), 0)
})

test('isTimeRangeVisible：视口外的片段被剔除', () => {
  assert.equal(isTimeRangeVisible(9_000, 11_000, 1000, VP), true) // 跨左边界
  assert.equal(isTimeRangeVisible(59_500, 61_000, 1000, VP), true) // 跨右边界（视口右=60 s）
  assert.equal(isTimeRangeVisible(0, 5_000, 1000, VP), false) // 全在左侧
  assert.equal(isTimeRangeVisible(70_000, 80_000, 1000, VP), false) // 全在右侧
})

test('zoomAround：锚点像素位置在缩放前后保持不变', () => {
  const anchor = 12_000
  const anchorXBefore = timeToX(anchor, VP)
  const zoomed = zoomAround(VP, 2, anchor, TIMELINE_ZOOM_LIMITS)
  assert.equal(zoomed.pxPerMs, 0.04)
  assert.ok(Math.abs(timeToX(anchor, zoomed) - anchorXBefore) < 1e-9)
  // 缩放受上下限约束
  const tooBig = zoomAround(VP, 1e6, anchor, TIMELINE_ZOOM_LIMITS)
  assert.equal(tooBig.pxPerMs, TIMELINE_ZOOM_LIMITS.maxPxPerMs)
  const tooSmall = zoomAround(VP, 1e-9, anchor, TIMELINE_ZOOM_LIMITS)
  assert.equal(tooSmall.pxPerMs, TIMELINE_ZOOM_LIMITS.minPxPerMs)
})

test('fitPxPerMs：整章适配，且不会算出 0 / Infinity', () => {
  // 30 分钟铺满 1000px
  const fitted = fitPxPerMs(1_800_000, 1000, TIMELINE_ZOOM_LIMITS)
  assert.ok(Math.abs(fitted - 1000 / 1_800_000) < 1e-12)
  assert.equal(fitPxPerMs(0, 1000, TIMELINE_ZOOM_LIMITS), TIMELINE_ZOOM_LIMITS.minPxPerMs)
  assert.equal(fitPxPerMs(1000, 0, TIMELINE_ZOOM_LIMITS), TIMELINE_ZOOM_LIMITS.minPxPerMs)
  assert.equal(fitPxPerMs(1, 1e9, TIMELINE_ZOOM_LIMITS), TIMELINE_ZOOM_LIMITS.maxPxPerMs)
})

// ---------------------------------------------------------------------------
// LOD
// ---------------------------------------------------------------------------

test('chooseLod：按缩放级别在 100 / 10 / 1 peaks/s 之间切换', () => {
  // 整章总览：0.0005 px/ms = 0.5 px/s → 只能取 1 peaks/s
  assert.equal(chooseLod(0.0005), 1)
  // 常规编辑：0.02 px/ms = 20 px/s → 10 peaks/s（每 peak 2 px）
  assert.equal(chooseLod(0.02), 10)
  // 样本级：0.2 px/ms = 200 px/s → 100 peaks/s
  assert.equal(chooseLod(0.2), 100)
  // 临界点：正好 0.5 px/peak 时保留该档
  assert.equal(chooseLod(MIN_PX_PER_PEAK / 1000), 1)
  assert.equal(chooseLod((MIN_PX_PER_PEAK * 10) / 1000), 10)
  // 非单调/非法输入：取最粗档而不是抛错或返回 0
  assert.equal(chooseLod(0), 1)
  assert.equal(chooseLod(-1), 1)
  assert.equal(chooseLod(Number.NaN), 1)
})

test('chooseLod 单调：缩放越大，档位不会变细', () => {
  let prev = chooseLod(0)
  for (const pxPerMs of [0.0001, 0.0005, 0.002, 0.02, 0.05, 0.2, 1]) {
    const lod = chooseLod(pxPerMs)
    assert.ok(lod >= prev, `${pxPerMs} 的档位 ${lod} 不应小于前一档 ${prev}`)
    prev = lod
  }
})

test('shouldSwitchLod：临界点附近有迟滞，不抖动', () => {
  // 当前 10，缩放刚好落在 10 与 100 的临界点上 → 不切换
  const boundary = (MIN_PX_PER_PEAK * 100) / 1000
  assert.equal(chooseLod(boundary), 100)
  assert.equal(shouldSwitchLod(10, boundary, 0.15), false)
  // 明显超出临界点 → 切换
  assert.equal(shouldSwitchLod(10, boundary * 1.5, 0.15), true)
  // 已经是理想档位 → 永不切换
  assert.equal(shouldSwitchLod(100, boundary, 0.15), false)
})

// ---------------------------------------------------------------------------
// peaks 索引映射
// ---------------------------------------------------------------------------

test('peaksIndexAtTime：边界与越界收敛', () => {
  assert.equal(peaksIndexAtTime(0, 10, 100), 0)
  assert.equal(peaksIndexAtTime(99, 10, 100), 0)
  assert.equal(peaksIndexAtTime(100, 10, 100), 1)
  assert.equal(peaksIndexAtTime(999, 10, 100), 9)
  assert.equal(peaksIndexAtTime(1000, 10, 100), 10)
  // 超出数据范围 → 收敛到最后一个下标（绘制时不会读到 undefined）
  assert.equal(peaksIndexAtTime(9_999_999, 10, 100), 99)
  // 负数 → 0
  assert.equal(peaksIndexAtTime(-500, 10, 100), 0)
  // 空数据 / 非法 peaksPerSec → -1（调用方据此跳过绘制）
  assert.equal(peaksIndexAtTime(100, 10, 0), -1)
  assert.equal(peaksIndexAtTime(100, 0, 100), -1)
  assert.equal(peaksIndexAtTime(Number.NaN, 10, 100), 0)
  // 100 peaks/s
  assert.equal(peaksIndexAtTime(1000, 100, 1000), 100)
})

test('timeAtPeaksIndex / peaksBucketMs：与下标映射互为逆运算', () => {
  assert.equal(peaksBucketMs(100), 10)
  assert.equal(peaksBucketMs(10), 100)
  assert.equal(peaksBucketMs(1), 1000)
  assert.equal(peaksBucketMs(0), 0)
  assert.equal(timeAtPeaksIndex(5, 10), 500)
  assert.equal(peaksIndexAtTime(timeAtPeaksIndex(5, 10), 10, 100), 5)
  assert.equal(timeAtPeaksIndex(-3, 10), 0)
})

test('peaksIndexRange：闭区间、裁剪与「完全在数据之外」', () => {
  const r = peaksIndexRange(0, 500, 10, 100)
  assert.deepEqual(r, { from: 0, to: 5, count: 6 })

  // 左端越界（负数）→ 裁剪到 0
  const leftOverflow = peaksIndexRange(-5000, 500, 10, 100)
  assert.equal(leftOverflow.from, 0)
  assert.equal(leftOverflow.to, 5)

  // 右端越界 → 裁剪到最后一个下标
  const rightOverflow = peaksIndexRange(0, 999_999, 10, 100)
  assert.equal(rightOverflow.from, 0)
  assert.equal(rightOverflow.to, 99)
  assert.equal(rightOverflow.count, 100)

  // 完全在数据之后
  assert.deepEqual(peaksIndexRange(20_000, 30_000, 10, 100), { from: -1, to: -1, count: 0 })
  // 空数据
  assert.deepEqual(peaksIndexRange(0, 1000, 10, 0), { from: -1, to: -1, count: 0 })
  // from > to 时自动交换
  assert.deepEqual(peaksIndexRange(500, 0, 10, 100), { from: 0, to: 5, count: 6 })
})

test('computeVisiblePeaks：视口 + overscan 都纳入', () => {
  const vp = { pxPerMs: 0.02, scrollMs: 10_000 } // 20 px/s
  const r = computeVisiblePeaks({ viewport: vp, viewportWidth: 1000, peaksPerSec: 10, totalPeaks: 10_000, overscanPx: 100 })
  // 视口覆盖 10 s ~ 60 s，overscan 各 5 s → 5 s ~ 65 s；10 peaks/s → 50 ~ 650
  assert.equal(r.from, 50)
  assert.equal(r.to, 650)
  assert.equal(r.count, 601)
  // 无 overscan 且刚好覆盖 10 s：10 s ~ 20 s → 100 ~ 200
  const exact = computeVisiblePeaks({ viewport: vp, viewportWidth: 200, peaksPerSec: 10, totalPeaks: 10_000, overscanPx: 0 })
  assert.equal(exact.from, 100)
  assert.equal(exact.to, 200)
})

// ---------------------------------------------------------------------------
// 脏矩形
// ---------------------------------------------------------------------------

const BOUNDS = { x: 0, y: 0, w: 800, h: 400 }

test('computeDirtyRect：相同区域不重绘；合并后不越界', () => {
  const a = { x: 100, y: 10, w: 50, h: 20 }
  // 完全相同的区域（含浮点抖动）→ null
  assert.equal(computeDirtyRect({ ...a }, { x: 100.2, y: 10.2, w: 50.2, h: 20.2 }, BOUNDS), null)
  assert.equal(computeDirtyRect(null, null, BOUNDS), null)

  // 从旧位置拖到新位置：要覆盖两块区域的并集，且带 pad
  const moved = computeDirtyRect({ x: 100, y: 10, w: 50, h: 20 }, { x: 300, y: 10, w: 50, h: 20 }, BOUNDS, 2)
  assert.deepEqual(moved, { x: 98, y: 8, w: 254, h: 24 })
  assert.ok(moved!.x >= BOUNDS.x && moved!.y >= BOUNDS.y)
  assert.ok(moved!.x + moved!.w <= BOUNDS.x + BOUNDS.w)
  assert.ok(moved!.y + moved!.h <= BOUNDS.y + BOUNDS.h)
})

test('computeDirtyRect / clipRect：越界被裁剪，完全在外为 null', () => {
  const clipped = computeDirtyRect(null, { x: -100, y: -50, w: 300, h: 100 }, BOUNDS, 0)
  assert.deepEqual(clipped, { x: 0, y: 0, w: 200, h: 50 })

  const outside = computeDirtyRect(null, { x: 5000, y: 5000, w: 100, h: 100 }, BOUNDS, 0)
  assert.equal(outside, null)

  assert.equal(clipRect({ x: 900, y: 0, w: 10, h: 10 }, BOUNDS), null)
  assert.deepEqual(clipRect({ x: 700, y: 380, w: 200, h: 100 }, BOUNDS), { x: 700, y: 380, w: 100, h: 20 })
})

test('矩形工具：相交 / 并集 / 扩张 / 归一化', () => {
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true)
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false)
  assert.deepEqual(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 })
  assert.equal(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }), null)
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 5, h: 5 }), { x: 0, y: 0, w: 25, h: 10 })
  assert.deepEqual(unionRect(null, null), null)
  assert.deepEqual(unionRect(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 })
  assert.deepEqual(expandRect({ x: 10, y: 10, w: 10, h: 10 }, 3), { x: 7, y: 7, w: 16, h: 16 })
  assert.deepEqual(normalizeRect({ x: 100, y: 100, w: -40, h: -20 }), { x: 60, y: 80, w: 40, h: 20 })
})

test('timeRangeToDirtyRect：把时间区间转成屏幕矩形（带裁剪）', () => {
  const rect = timeRangeToDirtyRect({
    fromMs: 11_000, toMs: 13_000, viewport: VP, y: 40, h: 30, bounds: BOUNDS, pad: 2,
  })
  // 11 s → 20 px，13 s → 60 px；带 pad=2 → x=18, w=44
  assert.deepEqual(rect, { x: 18, y: 38, w: 44, h: 34 })

  // 完全在视口左侧 → null（不需要重绘）
  assert.equal(timeRangeToDirtyRect({
    fromMs: 0, toMs: 1_000, viewport: VP, y: 0, h: 10, bounds: BOUNDS, pad: 0,
  }), null)
})

// ---------------------------------------------------------------------------
// 包络与幅度
// ---------------------------------------------------------------------------

test('buildEnvelope：每列取 min/max 而不是抽样（不丢瞬态）', () => {
  // 1000 个 peak，只有一个尖峰
  const peaks = new Float32Array(1000)
  peaks[500] = 0.9
  const vp = { pxPerMs: 0.001, scrollMs: 0 } // 1 px/ms → 1 列吃 10 个 peak（10 peaks/s → 100 ms/peak）
  const cols = buildEnvelope({
    peaks, fromIndex: 0, toIndex: 999, viewport: vp, xStartPx: 0, xEndPx: 99, bucketMs: 100,
  })
  assert.equal(cols.length, 100)
  // 尖峰落在第 500 个 peak（50 s ~ 50.1 s）→ x = 50
  const hit = cols.find(c => c.x === 50)
  assert.ok(hit, '应包含覆盖尖峰的列')
  // Float32Array 存 0.9 会有精度误差，用容差比较
  assert.ok(Math.abs(hit!.max - 0.9) < 1e-6, `实际 ${hit!.max}`)
  assert.equal(hit!.fromIndex, 500)
  assert.equal(hit!.toIndex, 509) // 1 px = 1 ms = 10 个 peak（10 peaks/s）
  // 其它列的极值为 0
  assert.equal(cols.find(c => c.x === 10)!.max, 0)
  assert.equal(cols.find(c => c.x === 10)!.min, 0)
})

test('buildEnvelope：非法输入返回空数组而不是抛错', () => {
  const peaks = new Float32Array(10)
  assert.deepEqual(buildEnvelope({ peaks, fromIndex: 5, toIndex: 2, viewport: VP, xStartPx: 0, xEndPx: 10, bucketMs: 100 }), [])
  assert.deepEqual(buildEnvelope({ peaks, fromIndex: -1, toIndex: 5, viewport: VP, xStartPx: 0, xEndPx: 10, bucketMs: 100 }), [])
  assert.deepEqual(buildEnvelope({ peaks, fromIndex: 0, toIndex: 5, viewport: VP, xStartPx: 0, xEndPx: 10, bucketMs: 0 }), [])
})

test('幅度换算：dBFS ↔ 幅度 ↔ 像素', () => {
  assert.equal(dbfsToAmplitude(0), 1)
  assert.ok(Math.abs(dbfsToAmplitude(-6) - 0.5011872336272722) < 1e-12)
  assert.equal(dbfsToAmplitude(-200), 0)
  assert.equal(dbfsToAmplitude(Number.NEGATIVE_INFINITY), 0)
  assert.equal(amplitudeToDbfs(0), Number.NEGATIVE_INFINITY)
  assert.ok(Math.abs(amplitudeToDbfs(1)) < 1e-12)

  // 像素映射：中心为零线，向上为正
  assert.equal(amplitudeToY(0, 50, 40), 50)
  assert.equal(amplitudeToY(1, 50, 40), 10)
  assert.equal(amplitudeToY(-1, 50, 40), 90)
  assert.equal(amplitudeToY(5, 50, 40), 10) // 越界幅度被夹住
})
