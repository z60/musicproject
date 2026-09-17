/**
 * Novel Studio · 手动微调单元测试
 * ============================================================================
 * 覆盖 docs/05 §5.4 / docs/13 §4.7：
 *   ★★ 拖左边缘：`timelineStartMs` 与 `srcInMs` 必须**同步反向补偿**，
 *      保证「音频内容的绝对位置不变」（这是最容易写错的一行代码）
 *   · 拖右边缘只改 srcOutMs
 *   · 拖动整体只改 timelineStartMs
 *   · 吸附：网格 / 相邻边界 / 画本行边界
 *   · 微调步进：±10 ms / ±1 ms / ±100 ms
 *
 * 运行：node --experimental-strip-types tests/shared/arrange-manual.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  NUDGE_STEPS,
  applyItemPatch,
  contentOffsetMs,
  intersects,
  moveItem,
  moveItemTo,
  moveMany,
  nudge,
  resetToAuto,
  resizeLeftEdge,
  resizeRightEdge,
  snapToTargets,
} from '../../src/shared/arrange/manual.ts'
import { itemDurationMs } from '../../src/shared/arrange/layout.ts'
import type { ArrangementItem } from '../../src/shared/types.ts'

function mk(partial: Partial<ArrangementItem> = {}): ArrangementItem {
  return {
    id: 'item-1',
    arrangementId: 'arr-1',
    segmentId: 'seg-1',
    lineId: 'line-1',
    trackId: 'char-a',
    timelineStartMs: 1000,
    srcInMs: 500,
    srcOutMs: 2500,
    fadeInMs: 5,
    fadeOutMs: 5,
    locked: false,
    orderInTrack: 0,
    overlapWith: null,
    ...partial,
  }
}

/**
 * 「内容绝对位置不变」的可观测定义：
 * 源片段内任意一点 t（毫秒）在时间线上的位置 = timelineStartMs + (t - srcInMs)
 * → 只要 `timelineStartMs - srcInMs` 恒定，内容就没跑。
 */
function timelinePosOfContent(item: ArrangementItem, srcTimeMs: number): number {
  return item.timelineStartMs + (srcTimeMs - item.srcInMs)
}

// ---------------------------------------------------------------------------
// 拖左边缘（关键单测）
// ---------------------------------------------------------------------------

describe('手动微调：拖左边缘（resizeLeftEdge）★关键陷阱', () => {
  it('向右拖 300 ms：timelineStartMs +300 且 srcInMs +300（内容绝对位置不变）', () => {
    const before = mk()
    const contentPosBefore = timelinePosOfContent(before, 1200) // 内容 1.2 s 处
    const r = resizeLeftEdge(before, 1300)

    assert.equal(r.item.timelineStartMs, 1300, '起点按拖动结果移动')
    assert.equal(r.item.srcInMs, 800, '裁剪点必须同步 +300（反向补偿）')
    assert.equal(r.clamped, false)
    assert.equal(r.appliedDeltaMs, 300)
    // ★ 不变量：内容是「被裁掉左边」，而不是「整段被搬走」
    assert.equal(contentOffsetMs(r.item), contentOffsetMs(before), 'timelineStartMs - srcInMs 必须恒定')
    assert.equal(timelinePosOfContent(r.item, 1200), contentPosBefore, '内容 1.2 s 处的时间线位置不变')
  })

  it('向左拖 400 ms：timelineStartMs -400 且 srcInMs -400', () => {
    const before = mk()
    const r = resizeLeftEdge(before, 600)
    assert.equal(r.item.timelineStartMs, 600)
    assert.equal(r.item.srcInMs, 100, '裁剪点回退 400 ms，内容位置不变')
    assert.equal(contentOffsetMs(r.item), contentOffsetMs(before))
  })

  it('向左拖到 srcInMs = 0 为止（不能读到片段头之前）', () => {
    const before = mk({ timelineStartMs: 1000, srcInMs: 500 })
    const r = resizeLeftEdge(before, 100) // 想再往左 900 ms，但 srcInMs 只够 500
    assert.equal(r.item.srcInMs, 0, 'srcInMs 夹到 0')
    assert.equal(r.item.timelineStartMs, 500, '时间线随之只移动 500 ms')
    assert.equal(r.clamped, true, '被夹紧必须回报，UI 可提示「已到片段头」')
    assert.equal(contentOffsetMs(r.item), contentOffsetMs(before), '夹紧后内容位置仍不变')
  })

  it('向右拖到 srcOutMs 为止（minDurationMs 约束）', () => {
    const before = mk({ timelineStartMs: 1000, srcInMs: 500, srcOutMs: 2500 })
    // 想拖到 3400（+2400），但 srcIn 最多到 srcOut - 100 = 2400 → delta 夹到 1900
    const r = resizeLeftEdge(before, 3400, { minDurationMs: 100 })
    assert.equal(r.item.srcInMs, 2400, 'srcInMs 最多到 srcOutMs - minDurationMs')
    assert.equal(r.item.timelineStartMs, 2900)
    assert.equal(r.clamped, true)
    assert.equal(r.appliedDeltaMs, 1900)
    assert.ok(r.item.srcOutMs - r.item.srcInMs >= 100, '裁剪后必须还剩 minDurationMs')
    assert.equal(contentOffsetMs(r.item), contentOffsetMs(before), '夹紧后内容位置仍不变')
  })

  it('不会把时间线拖到负数', () => {
    const before = mk({ timelineStartMs: 100, srcInMs: 900 })
    const r = resizeLeftEdge(before, -500)
    assert.ok(r.item.timelineStartMs >= 0)
    assert.equal(r.item.timelineStartMs, 0)
  })

  it('sourceDurationMs 约束：srcInMs 不能超过源文件长度', () => {
    const before = mk({ timelineStartMs: 0, srcInMs: 0, srcOutMs: 2000 })
    const r = resizeLeftEdge(before, 5000, { sourceDurationMs: 3000, minDurationMs: 0 })
    assert.ok(r.item.srcInMs <= 3000)
    assert.equal(r.clamped, true)
  })

  it('不修改原对象（撤销栈要求纯函数）', () => {
    const before = mk()
    resizeLeftEdge(before, 1500)
    assert.equal(before.timelineStartMs, 1000)
    assert.equal(before.srcInMs, 500)
  })

  it('连续多次拖左边缘，内容位置始终不变（累计误差为 0）', () => {
    let cur = mk()
    const anchor = timelinePosOfContent(cur, 900)
    for (const target of [1100, 1400, 900, 1600, 1200]) {
      cur = resizeLeftEdge(cur, target).item
      assert.equal(timelinePosOfContent(cur, 900), anchor, `拖到 ${target} 后内容位置漂移了`)
    }
    assert.equal(cur.timelineStartMs, 1200)
    assert.equal(cur.srcInMs, 700)
  })

  it('对比反例：只改 timelineStartMs（moveItem）会让内容位移 —— 这正是要避免的错误语义', () => {
    const before = mk()
    const wrong = moveItemTo(before, 1300).item
    assert.equal(wrong.srcInMs, 500, '错误实现：srcInMs 没动')
    assert.notEqual(timelinePosOfContent(wrong, 1200), timelinePosOfContent(before, 1200), '内容被搬走了 300 ms')
    const right = resizeLeftEdge(before, 1300).item
    assert.equal(timelinePosOfContent(right, 1200), timelinePosOfContent(before, 1200))
  })
})

// ---------------------------------------------------------------------------
// 拖动整体 / 右边缘
// ---------------------------------------------------------------------------

describe('手动微调：拖动整体与右边缘', () => {
  it('moveItem 只改 timelineStartMs', () => {
    const r = moveItem(mk(), -400)
    assert.equal(r.item.timelineStartMs, 600)
    assert.equal(r.item.srcInMs, 500, '裁剪点不动')
    assert.equal(r.item.srcOutMs, 2500)
    assert.equal(r.appliedDeltaMs, -400)
  })

  it('moveItemTo 语义等同（拖动结束提交）', () => {
    const r = moveItemTo(mk(), 1234)
    assert.equal(r.item.timelineStartMs, 1234)
    assert.equal(r.appliedDeltaMs, 234)
  })

  it('moveItem 夹到 >= 0 并回报 clamped', () => {
    const r = moveItem(mk({ timelineStartMs: 100 }), -500)
    assert.equal(r.item.timelineStartMs, 0)
    assert.equal(r.appliedDeltaMs, -100)
    assert.equal(r.clamped, true)
  })

  it('resizeRightEdge 只改 srcOutMs（timelineStartMs 不动）', () => {
    const before = mk() // 1000 起，内容 2000 ms 长，时间线终点 3000
    const r = resizeRightEdge(before, 3500)
    assert.equal(r.item.timelineStartMs, 1000, '起点不动')
    assert.equal(r.item.srcInMs, 500)
    assert.equal(r.item.srcOutMs, 3000, '终点 +500 → srcOut 2500 + 500')
    assert.equal(r.item.timelineStartMs + (r.item.srcOutMs - r.item.srcInMs), 3500)
  })

  it('resizeRightEdge 不能越过起点（minDurationMs）', () => {
    const r = resizeRightEdge(mk(), 500, { minDurationMs: 200 }) // 想缩到 500，但至少留 200 ms
    assert.equal(r.item.srcOutMs - r.item.srcInMs, 200, '正好留 200 ms')
    assert.equal(r.item.timelineStartMs + (r.item.srcOutMs - r.item.srcInMs), 1200)
    assert.equal(r.clamped, true)
  })

  it('resizeRightEdge 受 sourceDurationMs 限制', () => {
    const r = resizeRightEdge(mk(), 99_999, { sourceDurationMs: 2600 })
    assert.equal(r.item.srcOutMs, 2600)
    assert.equal(r.clamped, true)
  })
})

// ---------------------------------------------------------------------------
// 吸附
// ---------------------------------------------------------------------------

describe('手动微调：吸附（网格 / 边界 / 画本行边界）', () => {
  it('网格：给了 gridMs 就总是吸到最近网格点', () => {
    assert.equal(snapToTargets(1123, { gridMs: 100, targets: [] }).value, 1100)
    assert.equal(snapToTargets(1123, { gridMs: 100, targets: [] }).snappedTo, 'grid')
    assert.equal(snapToTargets(1180, { gridMs: 500, targets: [] }).value, 1000)
  })

  it('目标（相邻 item 边界）在阈值内优先吸附', () => {
    const r = snapToTargets(1120, { targets: [1150], thresholdMs: 100 })
    assert.equal(r.value, 1150)
    assert.equal(r.snappedTo, 'target')
    assert.equal(r.deltaMs, 30)
  })

  it('超出阈值的目标不吸附（否则想微调会被拽走）', () => {
    const r = snapToTargets(1120, { targets: [1400], thresholdMs: 100 })
    assert.equal(r.value, 1120)
    assert.equal(r.snappedTo, null)
    assert.deepEqual(r, { value: 1120, snappedTo: null, deltaMs: 0 })
  })

  it('网格与目标同时命中时取更近者；平局取目标', () => {
    assert.equal(snapToTargets(1130, { gridMs: 100, targets: [1140], thresholdMs: 100 }).value, 1140)
    assert.equal(snapToTargets(1150, { gridMs: 100, targets: [1150], thresholdMs: 100 }).value, 1150)
  })

  it('画本行边界吸附（阈值默认 100 ms）', () => {
    const r = snapToTargets(2090, { targets: [2000, 2400] })
    assert.equal(r.value, 2000)
    assert.equal(r.snappedTo, 'target')
    // 距离 110 ms（> 默认阈值 100）时就不吸了
    assert.equal(snapToTargets(2110, { targets: [2000, 2400] }).snappedTo, null)
  })

  it('没有任何候选时原样返回', () => {
    assert.deepEqual(snapToTargets(1123, { targets: [] }), { value: 1123, snappedTo: null, deltaMs: 0 })
  })
})

// ---------------------------------------------------------------------------
// 键盘微调
// ---------------------------------------------------------------------------

describe('手动微调：nudge 三种步进（docs/13 §4.7）', () => {
  it('±10 ms（普通）、±1 ms（Shift/细）、±100 ms（Ctrl/粗）', () => {
    assert.deepEqual([NUDGE_STEPS.fine, NUDGE_STEPS.normal, NUDGE_STEPS.coarse], [1, 10, 100])
    assert.equal(nudge(mk(), 1).item.timelineStartMs, 1010)
    assert.equal(nudge(mk(), -1).item.timelineStartMs, 990)
    assert.equal(nudge(mk(), 1, true).item.timelineStartMs, 1001, 'Shift：1 ms')
    assert.equal(nudge(mk(), -1, 'fine').item.timelineStartMs, 999)
    assert.equal(nudge(mk(), 1, 'coarse').item.timelineStartMs, 1100, 'Ctrl：100 ms')
    assert.equal(nudge(mk(), -1, 'coarse').item.timelineStartMs, 900)
    assert.equal(nudge(mk(), -1, false).item.timelineStartMs, 990, '默认 10 ms')
  })

  it('多步：nudge(item, 3) = +30 ms', () => {
    assert.equal(nudge(mk(), 3).item.timelineStartMs, 1030)
    assert.equal(nudge(mk(), -3, 'coarse').item.timelineStartMs, 700)
  })

  it('nudge 只改位置，不动裁剪点', () => {
    const r = nudge(mk(), 1, 'coarse')
    assert.equal(r.item.srcInMs, 500)
    assert.equal(r.item.srcOutMs, 2500)
  })
})

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

describe('手动微调：批量与补丁', () => {
  it('moveMany：只动选中的、未锁定的项', () => {
    const items = [mk({ id: 'a' }), mk({ id: 'b', locked: true }), mk({ id: 'c' })]
    const r = moveMany(items, ['a', 'b', 'c'], 100)
    assert.equal(r.items[0]!.timelineStartMs, 1100)
    assert.equal(r.items[1]!.timelineStartMs, 1000, '锁定项默认不跟随')
    assert.equal(r.items[2]!.timelineStartMs, 1100)
    assert.deepEqual(r.movedIds, ['a', 'c'])
    const forced = moveMany(items, ['b'], 100, { includeLocked: true })
    assert.equal(forced.items[1]!.timelineStartMs, 1100)
  })

  it('applyItemPatch：只给 timelineStartMs 时按「拖动整体」处理', () => {
    const next = applyItemPatch(mk(), { timelineStartMs: 1300 })
    assert.equal(next.timelineStartMs, 1300)
    assert.equal(next.srcInMs, 500)
  })

  it('applyItemPatch：只给 srcInMs 时按「拖左边缘」处理（内容不动）', () => {
    const before = mk()
    const next = applyItemPatch(before, { srcInMs: 800 })
    assert.equal(next.srcInMs, 800)
    assert.equal(next.timelineStartMs, 1300, '起点同步后移，内容绝对位置不变')
    assert.equal(contentOffsetMs(next), contentOffsetMs(before))
  })

  it('applyItemPatch：locked / fade 字段', () => {
    const next = applyItemPatch(mk(), { locked: true, fadeInMs: 20, fadeOutMs: -5 })
    assert.equal(next.locked, true)
    assert.equal(next.fadeInMs, 20)
    assert.equal(next.fadeOutMs, 0, '负淡化夹到 0')
  })

  it('resetToAuto：回到自动排布的位置与裁剪点', () => {
    const auto = mk({ timelineStartMs: 2000, srcInMs: 0, srcOutMs: 3000, fadeInMs: 5, fadeOutMs: 5 })
    const edited = mk({ timelineStartMs: 5000, srcInMs: 400, srcOutMs: 2000, locked: true })
    const r = resetToAuto(edited, auto)
    assert.equal(r.timelineStartMs, 2000)
    assert.equal(r.srcInMs, 0)
    assert.equal(r.srcOutMs, 3000)
    assert.equal(r.locked, true, '锁定状态是人工意图，重置位置不应解锁')
    assert.equal(r.id, 'item-1')
  })

  it('intersects：与 itemDurationMs 一致（拖动时命中检测复用）', () => {
    const a = mk({ timelineStartMs: 0, srcInMs: 0, srcOutMs: 1000, fadeInMs: 0, fadeOutMs: 0 })
    assert.equal(itemDurationMs(a), 1000)
    assert.equal(intersects(a, mk({ timelineStartMs: 500, srcInMs: 0, srcOutMs: 1000, fadeInMs: 0, fadeOutMs: 0 })), true)
    assert.equal(intersects(a, mk({ timelineStartMs: 1000, srcInMs: 0, srcOutMs: 1000, fadeInMs: 0, fadeOutMs: 0 })), false)
  })

  it('contentOffsetMs 就是不变量本身', () => {
    assert.equal(contentOffsetMs({ timelineStartMs: 1300, srcInMs: 800 }), 500)
  })
})
