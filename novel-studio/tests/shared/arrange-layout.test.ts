/**
 * Novel Studio · 自动排布单元测试
 * ============================================================================
 * 覆盖 docs/05 §5.2 / docs/13 §4.2 §4.3 §11：
 *   · 按 (track, seq) 排序与 cursor 递推
 *   · 留白三级优先级：行级 > 角色级 > 章节级
 *   · locked 的 item 位置不变（自动重排后仍不变）
 *   · 缺录行留占位且 cursor 不动
 *   · computeChapterDuration 与排布结果一致（渲染侧必须复用同一个函数）
 *
 * 运行：node --experimental-strip-types tests/shared/arrange-layout.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { ARRANGE_DEFAULTS } from '../../src/shared/constants.ts'
import {
  autoArrange,
  computeChapterDuration,
  itemDurationMs,
  itemEndMs,
  orderTracks,
  resolvePauseAfterMs,
  type ArrangeLineInput,
} from '../../src/shared/arrange/layout.ts'
import type { ArrangementItem, TrackId } from '../../src/shared/types.ts'

const NARRATION: TrackId = 'narration'
const CHAR_A: TrackId = 'char-a'
const CHAR_B: TrackId = 'char-b'

/**
 * 造一行（默认 1000 ms 片段、源区间 0~1000）。
 *
 * 注意：`ArrangeLineInput` **没有** fadeInMs/fadeOutMs —— 淡化时长是排布阶段
 * 由 `autoArrange({ defaultFadeMs })`（默认 5 ms）统一决定的产物，写在 item 上，
 * 不是画本行的输入属性。想让某行保留已有淡化值，请走 `existing: { fadeInMs }`。
 */
function line(partial: Partial<ArrangeLineInput> & { lineId: string; seq: number; trackId: TrackId }): ArrangeLineInput {
  return {
    segmentId: `seg-${partial.lineId}`,
    srcInMs: 0,
    srcOutMs: 1000,
    ...partial,
  }
}

function item(partial: Partial<ArrangementItem> & { id: string; lineId: string; trackId: TrackId }): ArrangementItem {
  return {
    arrangementId: 'arr-1',
    segmentId: `seg-${partial.lineId}`,
    timelineStartMs: 0,
    srcInMs: 0,
    srcOutMs: 1000,
    fadeInMs: 5,
    fadeOutMs: 5,
    locked: false,
    orderInTrack: 0,
    overlapWith: null,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// 用时与总时长
// ---------------------------------------------------------------------------

describe('排布：item 用时与章节总时长', () => {
  it('itemDurationMs = (srcOut - srcIn) + fadeIn + fadeOut（docs/13 §4.2）', () => {
    assert.equal(itemDurationMs({ srcInMs: 0, srcOutMs: 1000, fadeInMs: 5, fadeOutMs: 5 }), 1010)
    assert.equal(itemDurationMs({ srcInMs: 200, srcOutMs: 1000, fadeInMs: 5, fadeOutMs: 5 }), 810)
    assert.equal(itemDurationMs({ srcInMs: 1000, srcOutMs: 1000, fadeInMs: 5, fadeOutMs: 5 }), 10)
    assert.equal(itemDurationMs({ srcInMs: 1200, srcOutMs: 1000, fadeInMs: 0, fadeOutMs: 0 }), 0)
  })

  it('computeChapterDuration = 最后一个 item 的结束 + tailSilenceMs', () => {
    const items = [
      item({ id: 'a', lineId: 'l1', trackId: NARRATION, timelineStartMs: 0 }),
      item({ id: 'b', lineId: 'l2', trackId: CHAR_A, timelineStartMs: 5000 }),
    ]
    assert.equal(itemEndMs(items[1]!), 6010)
    assert.equal(computeChapterDuration(items, 1500), 7510)
    assert.equal(computeChapterDuration([], 1500), 1500)
  })
})

// ---------------------------------------------------------------------------
// 排序与递推
// ---------------------------------------------------------------------------

describe('排布：顺序与 cursor 递推', () => {
  it('旁白恒为第一轨，其余按首次出场顺序（docs/13 §4.1）', () => {
    const lines = [
      line({ lineId: 'l5', seq: 5, trackId: CHAR_B }),
      line({ lineId: 'l1', seq: 1, trackId: NARRATION }),
      line({ lineId: 'l3', seq: 3, trackId: CHAR_A }),
    ]
    assert.deepEqual(orderTracks(lines), [NARRATION, CHAR_A, CHAR_B])
  })

  it('按 seq 排布：start_{i+1} = end_i + pause（默认 500 ms）', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'l1', seq: 1, trackId: NARRATION }),
        line({ lineId: 'l2', seq: 2, trackId: NARRATION }),
        line({ lineId: 'l3', seq: 3, trackId: NARRATION }),
      ],
    })
    assert.equal(items.length, 3)
    assert.deepEqual(items.map(i => i.timelineStartMs), [0, 1510, 3020])
    assert.deepEqual(items.map(i => i.orderInTrack), [0, 1, 2])
    // cursor 递推：0 + 1010 + 500 = 1510
    assert.equal(itemEndMs(items[0]!), 1010)
  })

  it('乱序输入（seq 与数组顺序不一致）也按 seq 排', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'l3', seq: 3, trackId: NARRATION }),
        line({ lineId: 'l1', seq: 1, trackId: NARRATION }),
        line({ lineId: 'l2', seq: 2, trackId: NARRATION }),
      ],
    })
    assert.deepEqual(items.map(i => i.lineId), ['l1', 'l2', 'l3'])
    assert.deepEqual(items.map(i => i.timelineStartMs), [0, 1510, 3020])
  })

  it('多轨按画本 seq 全局串行：角色音落在它该在的位置（不各自从 0 开始）', () => {
    // 回归：曾经「每条轨道各自从 0 开始」，渲染是 adelay + amix（绝对时间），
    // 于是角色第一句会和旁白第一句**同时播**——真机表现「叶海本该在中间，却跑到最前面」。
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'n1', seq: 1, trackId: NARRATION }),
        line({ lineId: 'a1', seq: 2, trackId: CHAR_A }),
        line({ lineId: 'n2', seq: 3, trackId: NARRATION }),
        line({ lineId: 'a2', seq: 4, trackId: CHAR_A }),
      ],
    })
    const narr = items.filter(i => i.trackId === NARRATION)
    const charA = items.filter(i => i.trackId === CHAR_A)
    // n1(0) → a1(1510) → n2(3020) → a2(4530)
    assert.deepEqual(narr.map(i => i.timelineStartMs), [0, 3020])
    assert.deepEqual(charA.map(i => i.timelineStartMs), [1510, 4530], '角色音必须在中间，不能跑到最前面')
    // 轨内顺序号仍按各轨自增
    assert.deepEqual(charA.map(i => i.orderInTrack), [0, 1])
  })

  it('★★ 角色第一次出场在第 N 句 → 它的起点等于前 N-1 句的总时长（真机「叶海跑到最前面」）', () => {
    const lines = [
      line({ lineId: 'n1', seq: 1, trackId: NARRATION }),
      line({ lineId: 'n2', seq: 2, trackId: NARRATION }),
      line({ lineId: 'a1', seq: 3, trackId: CHAR_A }),
      line({ lineId: 'n3', seq: 4, trackId: NARRATION }),
    ]
    const { items } = autoArrange({ arrangementId: 'arr-1', lines })
    const yehai = items.find(i => i.lineId === 'a1')!
    // 两句旁白各 1010 ms + 两次留白 500 ms = 3020
    assert.equal(yehai.timelineStartMs, 3020, '叶海应出现在中间，而不是 0')
    assert.ok(yehai.timelineStartMs > 0)
  })

  it('片段裁剪点参与用时计算', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'l1', seq: 1, trackId: NARRATION, srcInMs: 300, srcOutMs: 1300 }),
        line({ lineId: 'l2', seq: 2, trackId: NARRATION }),
      ],
    })
    assert.equal(itemDurationMs(items[0]!), 1010)
    assert.equal(items[1]!.timelineStartMs, 1510)
  })
})

// ---------------------------------------------------------------------------
// 留白三级优先级
// ---------------------------------------------------------------------------

describe('排布：留白三级优先级（行级 > 角色级 > 章节级）', () => {
  it('行级 pauseAfterMs 生效', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'l1', seq: 1, trackId: NARRATION, pauseAfterMs: 900 }),
        line({ lineId: 'l2', seq: 2, trackId: NARRATION }),
      ],
    })
    assert.equal(items[1]!.timelineStartMs, 1010 + 900)
  })

  it('行级缺失时用角色级', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'l1', seq: 1, trackId: CHAR_A, pauseAfterMs: null, characterPauseMs: 250 }),
        line({ lineId: 'l2', seq: 2, trackId: CHAR_A }),
      ],
    })
    assert.equal(items[1]!.timelineStartMs, 1260)
  })

  it('行级 > 角色级 > 章节级 逐级回退', () => {
    const DEF = ARRANGE_DEFAULTS.defaultPauseMs
    const mk = (l: ArrangeLineInput | null, def = DEF): number => resolvePauseAfterMs(l, def)
    assert.equal(mk(line({ lineId: 'x', seq: 1, trackId: NARRATION, pauseAfterMs: 900, characterPauseMs: 250 })), 900)
    assert.equal(mk(line({ lineId: 'x', seq: 1, trackId: NARRATION, pauseAfterMs: null, characterPauseMs: 250 })), 250)
    assert.equal(mk(line({ lineId: 'x', seq: 1, trackId: NARRATION })), DEF, '章节级默认 500 ms')
    // 首行之前不留白（章首静音在混音阶段补）；这里刻意传一个非 0 的章节默认值，
    // 证明「null 行 → 0」优先于章节级默认，而不是碰巧因为默认值是 0 才通过。
    assert.equal(mk(null, 500), 0, '首行之前不留白（章首静音在混音阶段补）')
  })

  it('章节级默认值可被输入覆盖', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      defaultPauseMs: 200,
      lines: [
        line({ lineId: 'l1', seq: 1, trackId: NARRATION }),
        line({ lineId: 'l2', seq: 2, trackId: NARRATION }),
      ],
    })
    assert.equal(items[1]!.timelineStartMs, 1210)
  })
})

// ---------------------------------------------------------------------------
// locked 与缺录
// ---------------------------------------------------------------------------

describe('排布：locked 与缺录行', () => {
  it('locked 的 item 位置原样保留，后续 item 从它的结束继续推进', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'l1', seq: 1, trackId: NARRATION }),
        line({
          lineId: 'l2',
          seq: 2,
          trackId: NARRATION,
          existing: { id: 'item-2', timelineStartMs: 8000, locked: true },
        }),
        line({ lineId: 'l3', seq: 3, trackId: NARRATION }),
      ],
    })
    assert.equal(items[1]!.timelineStartMs, 8000, 'locked 的位置不能被自动排布改掉')
    assert.equal(items[1]!.locked, true)
    assert.equal(items[1]!.id, 'item-2', 'id 必须沿用（撤销栈与 UI 选中依赖）')
    // cursor 从 locked 的结束继续：8000 + 1010 = 9010，再 +500 = 9510
    assert.equal(items[2]!.timelineStartMs, 9510)
  })

  it('未锁定的 item 会被重新排布（人工拖过的位置不算数）', () => {
    const { items } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({
          lineId: 'l1',
          seq: 1,
          trackId: NARRATION,
          existing: { id: 'item-1', timelineStartMs: 9999, locked: false, fadeInMs: 20, fadeOutMs: 30 },
        }),
      ],
    })
    assert.equal(items[0]!.timelineStartMs, 0)
    assert.equal(items[0]!.fadeInMs, 20, '淡化参数属于人工设置，应保留')
    assert.equal(itemDurationMs(items[0]!), 1050)
  })

  it('缺录行：记 gap 且 cursor 不动（绝不插静音片段占位）', () => {
    const { items, gaps } = autoArrange({
      arrangementId: 'arr-1',
      lines: [
        line({ lineId: 'l1', seq: 1, trackId: NARRATION }),
        line({ lineId: 'l2', seq: 2, trackId: NARRATION, segmentId: null }),
        line({ lineId: 'l3', seq: 3, trackId: NARRATION }),
      ],
    })
    assert.equal(items.length, 2)
    assert.deepEqual(gaps, [{ lineId: 'l2', trackId: NARRATION, seq: 2 }])
    // 缺录行不留白、不推进 cursor：l3 紧接 l1 之后（1510），而不是 3020
    assert.equal(items[1]!.lineId, 'l3')
    assert.equal(items[1]!.timelineStartMs, 1510)
  })

  it('全部缺录 → items 为空、totalDurationMs 只有尾静音', () => {
    const r = autoArrange({
      arrangementId: 'arr-1',
      lines: [line({ lineId: 'l1', seq: 1, trackId: NARRATION, segmentId: null })],
      tailSilenceMs: 1500,
    })
    assert.equal(r.items.length, 0)
    assert.equal(r.totalDurationMs, 1500)
  })

  it('srcOutMs 会被夹在片段长度内（防越界读）', () => {
    const r = autoArrange({
      arrangementId: 'arr-1',
      lines: [line({ lineId: 'l1', seq: 1, trackId: NARRATION, srcInMs: 0, srcOutMs: 99999, segmentDurationMs: 2000 })],
    })
    assert.equal(r.items[0]!.srcOutMs, 2000)
  })
})

// ---------------------------------------------------------------------------
// 与渲染侧的一致性（docs/15 §3.2）
// ---------------------------------------------------------------------------

describe('排布：computeChapterDuration 与排布结果一致（渲染侧唯一来源）', () => {
  it('autoArrange 的 totalDurationMs == computeChapterDuration(items, tailMs)', () => {
    const lines: ArrangeLineInput[] = []
    for (let i = 0; i < 87; i++) {
      lines.push(
        line({
          lineId: `l${i + 1}`,
          seq: i + 1,
          trackId: i % 3 === 0 ? NARRATION : i % 3 === 1 ? CHAR_A : CHAR_B,
          srcOutMs: 800 + (i % 7) * 120,
          pauseAfterMs: i % 5 === 0 ? 900 : null,
        }),
      )
    }
    const r = autoArrange({ arrangementId: 'arr-1', lines, tailSilenceMs: 1500 })
    assert.equal(r.items.length, 87)
    assert.equal(
      r.totalDurationMs,
      computeChapterDuration(r.items, 1500),
      '时间线显示的总时长必须与渲染侧算出来的完全一致',
    )
    // 手算校验：每轨各自的 cursor 最大值 + 尾静音
    const narr = r.items.filter(i => i.trackId === NARRATION)
    const last = narr[narr.length - 1]!
    const maxEnd = Math.max(...r.items.map(i => i.timelineStartMs + itemDurationMs(i)))
    assert.equal(r.totalDurationMs, maxEnd + 1500)
    assert.ok(itemEndMs(last) <= maxEnd)
  })

  it('同一批 items 传入不同 tailSilenceMs 只影响尾部', () => {
    const r = autoArrange({
      arrangementId: 'arr-1',
      lines: [line({ lineId: 'l1', seq: 1, trackId: NARRATION })],
    })
    const base = computeChapterDuration(r.items, 0)
    assert.equal(computeChapterDuration(r.items, 500), base + 500)
    assert.equal(computeChapterDuration(r.items, 1500), base + 1500)
  })
})
