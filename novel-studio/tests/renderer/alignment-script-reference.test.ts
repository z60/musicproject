/**
 * 测试 · 对轨「文本参照」列表（行装配 / 播放头命中 / 筛选 + 源码接线）
 * ============================================================================
 * 真机需求：「对轨模块 需要添加可以听 并且可以参照文本的功能」。
 *
 * 这里钉住两件事：
 *   ① **纯逻辑**（能测的部分）：画本顺序装配、缺录/无音频的标注、播放头命中、
 *      文本与行号筛选 —— 这些错了会表现为「列表里少几行」或「跟随高亮跳到别的行」；
 *   ② **接线**（读源码断言，与 tests/renderer 其它用例同一套做法）：
 *      对轨视图挂了「文本」页、面板有单行试听并转发 `audition`、
 *      播放按钮**不再**要求 AudioContext 已就绪（否则一开始就是灰的，用户点不到）。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildScriptRows,
  filterScriptRows,
  rowIndexAtTime,
  type ScriptRow,
} from '../../src/renderer/src/features/alignment/composables/useScriptReference.ts'

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function line(id: string, seq: number, text: string, needsReview = false): unknown {
  return { id, seq, text, needsReview }
}

function item(id: string, lineId: string, startMs: number, srcInMs: number, srcOutMs: number): unknown {
  return {
    id,
    arrangementId: 'arr1',
    segmentId: 'seg-' + id,
    lineId,
    trackId: 'main',
    timelineStartMs: startMs,
    srcInMs,
    srcOutMs,
    fadeInMs: 0,
    fadeOutMs: 0,
    locked: false,
    orderInTrack: 0,
    overlapWith: null,
  }
}

function rowsOf(
  lines: unknown[],
  items: unknown[],
  hasAudio: (item: never) => boolean = () => true,
): ScriptRow[] {
  return buildScriptRows({
    lines: lines as never,
    itemByLineId: new Map((items as Array<{ id: string; lineId: string }>).map((i) => [i.lineId, i])) as never,
    hasAudio: hasAudio as never,
  })
}

// ---------------------------------------------------------------------------
// 行装配
// ---------------------------------------------------------------------------

describe('文本参照：按画本顺序装配', () => {
  it('缺录（有行无片段）与无音频（有片段无文件）都保留在清单里，并标出来', () => {
    const rows = rowsOf(
      [line('l3', 3, '第三句'), line('l1', 1, '第一句'), line('l2', 2, '第二句')],
      [item('i1', 'l1', 0, 0, 1000), item('i3', 'l3', 2000, 0, 1500)],
      // 第三句的片段解析不到音频文件
      (i: { lineId: string }) => (i as unknown as { lineId: string }).lineId !== 'l3',
    )
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3], '按 seq 排序，不是按传入顺序')
    assert.deepEqual(rows.map((r) => r.state), ['arranged', 'missing', 'no-audio'])
    assert.equal(rows[1]!.itemId, null)
    assert.equal(rows[1]!.startMs, null)
    assert.equal(rows[2]!.startMs, 2000, '无音频的行仍有时间线位置（能定位）')
  })

  it('起止时间与画布同一口径：start + (srcOut - srcIn + 淡入淡出)', () => {
    const rows = rowsOf([line('l1', 1, '一句')], [item('i1', 'l1', 5000, 1200, 3200)])
    assert.equal(rows[0]!.startMs, 5000)
    assert.equal(rows[0]!.endMs, 5000 + 2000)
  })

  it('原文归一化空白、不截断；画本的「待确认」带到行上', () => {
    const rows = rowsOf([line('l1', 1, '  很长的   一句\n台词  ', true)], [item('i1', 'l1', 0, 0, 10)])
    assert.equal(rows[0]!.text, '很长的 一句 台词')
    assert.equal(rows[0]!.needsReview, true)
  })
})

describe('文本参照：播放头命中哪一行', () => {
  const rows = rowsOf(
    [line('l1', 1, 'A'), line('l2', 2, 'B'), line('l3', 3, 'C')],
    [item('i1', 'l1', 1000, 0, 1000), item('i2', 'l2', 2000, 0, 1000)],
  )

  it('区间是 [起, 止)：起止边界各归一侧', () => {
    assert.equal(rowIndexAtTime(rows, 999), -1)
    assert.equal(rowIndexAtTime(rows, 1000), 0)
    assert.equal(rowIndexAtTime(rows, 1999), 0)
    assert.equal(rowIndexAtTime(rows, 2000), 1, '正好落在下一行起点 → 归下一行')
    assert.equal(rowIndexAtTime(rows, 3000), -1)
  })

  it('没排布的行（缺录）永远不命中', () => {
    assert.equal(rowIndexAtTime(rows, 999_999), -1)
  })

  it('时间重叠时取起点更晚的那一行（跟随播放头要看「刚开始这句」）', () => {
    const overlap = rowsOf(
      [line('l1', 1, 'A'), line('l2', 2, 'B')],
      [item('i1', 'l1', 0, 0, 5000), item('i2', 'l2', 1000, 0, 1000)],
    )
    assert.equal(rowIndexAtTime(overlap, 1500), 1, '0~5000 与 1000~2000 重叠 → 取后开始的那行')
  })
})

describe('文本参照：筛选', () => {
  const rows = rowsOf(
    [line('l1', 1, '石志坚笑了'), line('l2', 2, '众人心中一凉'), line('l12', 12, '旁白一句')],
    [item('i1', 'l1', 0, 0, 10), item('i2', 'l2', 100, 0, 10), item('i12', 'l12', 200, 0, 10)],
  )

  it('空查询返回全部', () => {
    assert.equal(filterScriptRows(rows, '   ').length, 3)
  })

  it('匹配原文（大小写不敏感）', () => {
    assert.deepEqual(filterScriptRows(rows, '众人').map((r) => r.seq), [2])
    assert.deepEqual(filterScriptRows(rows, '石志坚').map((r) => r.seq), [1])
  })

  it('#行号 / 纯数字只按行号筛', () => {
    assert.deepEqual(filterScriptRows(rows, '#12').map((r) => r.seq), [12])
    assert.deepEqual(filterScriptRows(rows, '12').map((r) => r.seq), [12])
  })
})

// ---------------------------------------------------------------------------
// 接线（读源码断言）
// ---------------------------------------------------------------------------

const read = (relative: string): string => readFileSync(join(process.cwd(), relative), 'utf8')

const VIEW = 'src/renderer/src/features/alignment/views/AlignmentView.vue'
const PANEL = 'src/renderer/src/features/alignment/components/TextReferencePanel.vue'

describe('文本参照：接线', () => {
  it('对轨视图里有「文本」页，并挂了面板（试听与跳画本都转发出去）', () => {
    const view = read(VIEW)
    assert.match(view, /TextReferencePanel/)
    assert.match(view, /judgeTab === 'script'/)
    assert.match(view, /@audition="onAuditionLine"/, '单行试听要接到调度器')
    assert.match(view, /@jump-line="onJumpLine"/, '缺录的行要能跳到画本编辑')
  })

  it('★ 播放按钮不再要求 AudioContext 已就绪（否则一开始就是灰的，点不到）', () => {
    const view = read(VIEW)
    assert.doesNotMatch(
      view,
      /:disabled="!scheduler\.isReady/,
      'isReady 只有点过按钮才会 true —— 拿它禁用按钮就成了死锁（真机「对轨听不了」）',
    )
    assert.match(view, /@click="onTogglePlay"/)
    assert.match(view, /onStopPlay/)
  })

  it('默认停在「文本」页，且点列表里的行不会把用户弹到检查器', () => {
    const view = read(VIEW)
    assert.match(view, /judgeTab = ref<JudgeTab>\('script'\)/, '默认页应当是文本参照')
    assert.match(
      view,
      /judgeTab\.value !== 'script'/,
      '文本页里点行（会选中片段）不能触发「切到检查器」',
    )
  })

  it('面板每行有 ▶ 试听、点行会选中并滚动画布、跟随播放头只在播放时滚', () => {
    const panel = read(PANEL)
    assert.match(panel, /emit\('audition', row\.itemId\)/)
    assert.match(panel, /timeline\.select\(row\.itemId\)/)
    assert.match(panel, /ensureTimeVisible/)
    assert.match(panel, /playback\.isPlaying && follow\.value/, '不播放时不要抢用户的滚动')
  })
})
