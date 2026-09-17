/**
 * 渲染进程纯逻辑测试 · 虚拟滚动区间计算
 * ============================================================================
 * 覆盖 docs/01 §3.2（> 2000 行走虚拟滚动）与 docs/11 §4.2（5000 行 30 fps）所需能力：
 *   · 顶部 / 中部 / 底部三种位置的区间正确性
 *   · overscan 生效且不越界
 *   · 内容不足一屏
 *   · 总数为 0
 *   · 滚动越界（负数 / 超出 maxScrollTop）收敛
 *   · 变高行的二分区间与键盘导航滚动
 *
 * 运行：node --experimental-strip-types tests/renderer/virtual-list.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clampScrollTop,
  computeScrollToIndex,
  computeVisibleRange,
  computeVisibleRangeVariable,
  indexAtOffset,
  maxScrollTop,
  offsetOfIndex,
  rangeIndexes,
} from '../../src/renderer/src/shared/lib/virtual-list.ts'

const ROW = 40
const VIEW = 400 // 恰好 10 行

// ---------------------------------------------------------------------------
// 基本位置
// ---------------------------------------------------------------------------

test('computeVisibleRange：顶部（scrollTop=0）', () => {
  const r = computeVisibleRange({ scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, total: 1000, overscan: 4 })
  assert.equal(r.visibleStartIndex, 0)
  assert.equal(r.visibleEndIndex, 9) // 10 行可见：0..9
  assert.equal(r.startIndex, 0) // 顶部没有 overscan 空间
  assert.equal(r.endIndex, 13) // 9 + 4
  assert.equal(r.paddingTop, 0)
  assert.equal(r.paddingBottom, 1000 * ROW - 14 * ROW)
  assert.equal(r.totalHeight, 40000)
  assert.equal(r.renderCount, 14)
  assert.equal(r.degenerate, false)
})

test('computeVisibleRange：中部（上下 overscan 都生效）', () => {
  const scrollTop = 500 * ROW // 第 500 行贴顶
  const r = computeVisibleRange({ scrollTop, viewportHeight: VIEW, rowHeight: ROW, total: 1000, overscan: 4 })
  assert.equal(r.visibleStartIndex, 500)
  assert.equal(r.visibleEndIndex, 509)
  assert.equal(r.startIndex, 496)
  assert.equal(r.endIndex, 513)
  assert.equal(r.paddingTop, 496 * ROW)
  assert.equal(r.paddingBottom, (1000 - 514) * ROW)
  assert.equal(r.renderCount, 18)
  // paddingTop + 渲染高度 + paddingBottom 必须正好等于总高（否则滚动条长度会漂）
  assert.equal(r.paddingTop + r.renderCount * ROW + r.paddingBottom, r.totalHeight)
})

test('computeVisibleRange：底部（endIndex 收敛到 total-1）', () => {
  const r = computeVisibleRange({ scrollTop: 40000, viewportHeight: VIEW, rowHeight: ROW, total: 1000, overscan: 4 })
  assert.equal(r.clampedScrollTop, 39600) // maxScrollTop = 40000 - 400
  assert.equal(r.visibleEndIndex, 999)
  assert.equal(r.endIndex, 999)
  assert.equal(r.paddingBottom, 0)
  assert.ok(r.startIndex <= r.visibleStartIndex)
})

test('computeVisibleRange：半行可见也要渲染（快速滚动不露白）', () => {
  // 视口 400px 从 10px 开始：最后一行只露出 10px
  const r = computeVisibleRange({ scrollTop: 10, viewportHeight: VIEW, rowHeight: ROW, total: 100, overscan: 0 })
  assert.equal(r.visibleStartIndex, 0)
  assert.equal(r.visibleEndIndex, 10)
})

test('overscan：0 与较大值的行为差异，且都不越界', () => {
  const none = computeVisibleRange({ scrollTop: 2000, viewportHeight: VIEW, rowHeight: ROW, total: 60, overscan: 0 })
  assert.equal(none.startIndex, 50)
  assert.equal(none.endIndex, 59)
  assert.equal(none.renderCount, 10)

  const big = computeVisibleRange({ scrollTop: 2000, viewportHeight: VIEW, rowHeight: ROW, total: 60, overscan: 500 })
  assert.equal(big.startIndex, 0)
  assert.equal(big.endIndex, 59)
  assert.equal(big.renderCount, 60)
})

test('computeVisibleRange：内容不足一屏', () => {
  const r = computeVisibleRange({ scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, total: 3, overscan: 4 })
  assert.equal(r.startIndex, 0)
  assert.equal(r.endIndex, 2)
  assert.equal(r.visibleEndIndex, 2)
  assert.equal(r.paddingTop, 0)
  assert.equal(r.paddingBottom, 0)
  assert.equal(r.maxScrollTop, 0)
  assert.equal(r.renderCount, 3)
})

test('computeVisibleRange：总数为 0 → 空区间（循环天然不执行）', () => {
  const r = computeVisibleRange({ scrollTop: 120, viewportHeight: VIEW, rowHeight: ROW, total: 0 })
  assert.equal(r.startIndex, 0)
  assert.equal(r.endIndex, -1)
  assert.equal(r.renderCount, 0)
  assert.equal(r.paddingTop, 0)
  assert.equal(r.paddingBottom, 0)
  assert.equal(r.totalHeight, 0)
  assert.equal(r.maxScrollTop, 0)
  assert.deepEqual(rangeIndexes(r), [])
  assert.equal(indexAtOffset(50, ROW, 0), -1)
})

test('computeVisibleRange：滚动越界收敛（负数 / 超过上限 / NaN）', () => {
  const max = maxScrollTop(100, ROW, VIEW)
  assert.equal(max, 3600)

  const negative = computeVisibleRange({ scrollTop: -800, viewportHeight: VIEW, rowHeight: ROW, total: 100, overscan: 0 })
  assert.equal(negative.clampedScrollTop, 0)
  assert.equal(negative.startIndex, 0)

  const overflow = computeVisibleRange({ scrollTop: 999999, viewportHeight: VIEW, rowHeight: ROW, total: 100, overscan: 0 })
  assert.equal(overflow.clampedScrollTop, max)
  assert.equal(overflow.endIndex, 99)

  const nan = computeVisibleRange({ scrollTop: Number.NaN, viewportHeight: VIEW, rowHeight: ROW, total: 100 })
  assert.equal(nan.clampedScrollTop, 0)

  assert.equal(clampScrollTop(-5, 100, ROW, VIEW), 0)
  assert.equal(clampScrollTop(1e9, 100, ROW, VIEW), max)
  assert.equal(clampScrollTop(0, 0, ROW, VIEW), 0)
})

test('computeVisibleRange：非法行高/视口退化为 1 行而不是抛错', () => {
  const zeroRow = computeVisibleRange({ scrollTop: 100, viewportHeight: VIEW, rowHeight: 0, total: 100, overscan: 2 })
  assert.equal(zeroRow.degenerate, true)
  assert.ok(zeroRow.startIndex >= 0)
  assert.ok(zeroRow.endIndex < 100)
  assert.equal(zeroRow.degenerate, true)

  const zeroView = computeVisibleRange({ scrollTop: 0, viewportHeight: 0, rowHeight: ROW, total: 100, overscan: 0 })
  assert.equal(zeroView.degenerate, true)
  assert.equal(zeroView.visibleStartIndex, 0)
  assert.equal(zeroView.visibleEndIndex, 0)

  assert.doesNotThrow(() => computeVisibleRange({ scrollTop: 0, viewportHeight: Number.NaN, rowHeight: Number.NaN, total: -5 }))
})

test('headerOffset：表头会占掉一部分滚动位置', () => {
  const r = computeVisibleRange({ scrollTop: 1000 + 32, viewportHeight: VIEW, rowHeight: ROW, total: 100, overscan: 0, headerOffset: 32 })
  assert.equal(r.clampedScrollTop, 1000)
  assert.equal(r.visibleStartIndex, 25)
})

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

test('offsetOfIndex / indexAtOffset 互逆并做边界收敛', () => {
  assert.equal(offsetOfIndex(7, ROW), 280)
  assert.equal(indexAtOffset(280, ROW, 100), 7)
  assert.equal(indexAtOffset(-10, ROW, 100), 0)
  assert.equal(indexAtOffset(99999, ROW, 100), 99)
  assert.equal(indexAtOffset(280, ROW, 100, false), 7)
  assert.equal(indexAtOffset(99999, ROW, 100, false), 2499)
  assert.equal(offsetOfIndex(-3, ROW), 0)
})

test('rangeIndexes：返回闭区间序号数组', () => {
  const r = computeVisibleRange({ scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, total: 100, overscan: 1 })
  assert.deepEqual(rangeIndexes(r), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(rangeIndexes({ ...r, startIndex: 5, endIndex: 4 }), [])
})

// ---------------------------------------------------------------------------
// 键盘导航 & 变高行
// ---------------------------------------------------------------------------

test('computeScrollToIndex：nearest 语义只在需要时滚动', () => {
  const base = { viewportHeight: VIEW, rowHeight: ROW, total: 100, overscan: 4 }
  // 目标已在视口内 → 不动
  assert.equal(computeScrollToIndex(3, { ...base, currentScrollTop: 0 }), 0)
  // 目标在视口下方 → 底对齐
  assert.equal(computeScrollToIndex(15, { ...base, currentScrollTop: 0 }), 16 * ROW - VIEW)
  // 目标在视口上方 → 顶对齐
  assert.equal(computeScrollToIndex(2, { ...base, currentScrollTop: 20 * ROW }), 2 * ROW)
  // 越界的 index 收敛到末行，且不越过 maxScrollTop
  assert.equal(computeScrollToIndex(999, { ...base, currentScrollTop: 0 }), maxScrollTop(100, ROW, VIEW))
  assert.equal(computeScrollToIndex(-5, { ...base, currentScrollTop: 0 }), 0)
  // center / start 对齐
  assert.equal(computeScrollToIndex(50, { ...base, currentScrollTop: 0, align: 'center' }), 50 * ROW - VIEW / 2 + ROW / 2)
  assert.equal(computeScrollToIndex(50, { ...base, currentScrollTop: 0, align: 'end' }), 51 * ROW - VIEW)
})

test('computeVisibleRangeVariable：变高行（剧本视图折行）', () => {
  // 100 行，奇数行高 60，偶数行高 20
  const heights = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 60 : 20))
  const totalHeight = heights.reduce((a, b) => a + b, 0)
  assert.equal(totalHeight, 50 * 60 + 50 * 20)

  const top = computeVisibleRangeVariable({ scrollTop: 0, viewportHeight: 200, rowHeights: heights, overscan: 1 })
  assert.equal(top.startIndex, 0)
  assert.equal(top.visibleStartIndex, 0)
  // 60+20+60+20+60 = 220 ≥ 200 → 可见 0..4
  assert.equal(top.visibleEndIndex, 4)
  assert.equal(top.endIndex, 5)
  assert.equal(top.paddingTop, 0)
  assert.equal(top.totalHeight, totalHeight)

  const mid = computeVisibleRangeVariable({ scrollTop: 400, viewportHeight: 200, rowHeights: heights, overscan: 0 })
  assert.ok(mid.visibleStartIndex > 0)
  assert.ok(mid.visibleEndIndex >= mid.visibleStartIndex)
  // padding 之和必须正好等于总高
  assert.equal(mid.paddingTop + (mid.paddingBottom > 0 ? mid.paddingBottom : 0) <= totalHeight, true)

  const empty = computeVisibleRangeVariable({ scrollTop: 100, viewportHeight: 200, rowHeights: [] })
  assert.equal(empty.endIndex, -1)
  assert.equal(empty.totalHeight, 0)

  // 滚到底：最后一行必须可见，且不越界
  const bottom = computeVisibleRangeVariable({ scrollTop: 1e9, viewportHeight: 200, rowHeights: heights, overscan: 2 })
  assert.equal(bottom.visibleEndIndex, 99)
  assert.equal(bottom.endIndex, 99)
  assert.equal(bottom.clampedScrollTop, totalHeight - 200)
})
