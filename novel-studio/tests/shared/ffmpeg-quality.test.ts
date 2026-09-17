/**
 * Novel Studio · 导出质检单元测试
 * ============================================================================
 * 覆盖 docs/15 §6.1 §6.2 与 docs/05 §10：
 *   · 预检：阻断项（缺录行 / 说话人未分配 / 磁盘不足）与警告项（孤儿片段 / 削波 /
 *     片段过短过长 / 章节时长异常 / 响度极端偏差）必须分开
 *   · 后检：章间响度差检测、静音章检测（阻断）、真峰、时长一致性、异常长静音、削波
 *
 * 运行：node --experimental-strip-types tests/shared/ffmpeg-quality.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { QC_THRESHOLDS } from '../../src/shared/constants.ts'
import {
  computeChapterLufsSpread,
  postCheck,
  preCheck,
  summarizeExportReport,
  type QcPreCheckLine,
} from '../../src/shared/ffmpeg/quality.ts'
import type { ExportChapterResult } from '../../src/shared/types.ts'

function line(partial: Partial<QcPreCheckLine> & { lineId: string; seq: number }): QcPreCheckLine {
  return {
    chapterId: 'ch-1',
    chapterTitle: '第1章 陨落的天才',
    speakerType: 'narration',
    characterId: null,
    hasSegment: true,
    segmentDurationMs: 1200,
    ...partial,
  }
}

function chapterResult(partial: Partial<ExportChapterResult> & { chapterIndex: number }): ExportChapterResult {
  return {
    chapterId: `ch-${partial.chapterIndex}`,
    title: `第${partial.chapterIndex}章`,
    durationMs: 600_000,
    measuredLufs: -16,
    measuredTpDbfs: -1.2,
    targetLufs: -16,
    adjustedGainDb: 0,
    output: `00${partial.chapterIndex}.mp3`,
    sizeBytes: 1024,
    skipped: false,
    warnings: [],
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// 渲染前预检
// ---------------------------------------------------------------------------

describe('渲染前预检（docs/15 §6.1）', () => {
  it('一切正常：无阻断、无警告', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1 }), line({ lineId: 'l2', seq: 2 })],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
    })
    assert.deepEqual(r.blockers, [])
    assert.deepEqual(r.warnings, [])
    assert.equal(r.stats.lines, 2)
    assert.equal(r.stats.recordedLines, 2)
    assert.equal(r.stats.missingLines, 0)
    assert.equal(r.stats.totalDurationMs, 600_000)
  })

  it('★ 缺录行是**阻断**项', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1 }), line({ lineId: 'l2', seq: 2, hasSegment: false })],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
    })
    assert.equal(r.blockers.length, 1)
    assert.equal(r.blockers[0]!.kind, 'missing_lines')
    assert.equal(r.blockers[0]!.lineId, 'l2')
    assert.match(r.blockers[0]!.message, /第 2 行还没有录音/)
    assert.equal(r.stats.missingLines, 1)
  })

  it('allowPartialExport=true 时缺录行降级为警告（「仅导出已录部分」）', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1, hasSegment: false })],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
      opts: { allowPartialExport: true },
    })
    assert.equal(r.blockers.length, 0)
    assert.equal(r.warnings[0]!.kind, 'missing_lines')
  })

  it('★ 说话人未分配是**阻断**项（台词行没有 characterId）', () => {
    const r = preCheck({
      lines: [
        line({ lineId: 'l1', seq: 1, speakerType: 'character', characterId: null }),
        line({ lineId: 'l2', seq: 2, speakerType: 'character', characterId: 'char-x' }),
      ],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
    })
    assert.ok(r.blockers.some(b => b.kind === 'unassigned_speaker'))
    assert.equal(r.blockers.filter(b => b.kind === 'unassigned_speaker').length, 1)
  })

  it('★ 磁盘空间不足是**阻断**项（附带需要/可用数值）', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1 })],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
      disk: { freeBytes: 100 * 1024 * 1024, requiredBytes: 800 * 1024 * 1024 },
    })
    const disk = r.blockers.find(b => b.kind === 'disk_full')
    assert.ok(disk)
    assert.match(disk!.message, /800 MB/)
    assert.match(disk!.message, /100 MB/)
  })

  it('孤儿片段 / take 削波 / 片段过短过长 都是**警告**（不阻断导出）', () => {
    const r = preCheck({
      lines: [
        line({ lineId: 'l1', seq: 1, takeFlags: ['clip'] }),
        line({ lineId: 'l2', seq: 2, segmentDurationMs: 120 }),
        line({ lineId: 'l3', seq: 3, segmentDurationMs: 61_000 }),
      ],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
      orphanSegments: [{ segmentId: 'seg-x', lineId: 'l-deleted', chapterId: 'ch-1' }],
    })
    assert.deepEqual(r.blockers, [])
    const kinds = r.warnings.map(w => w.kind)
    assert.deepEqual(kinds.sort(), ['orphan_segment', 'segment_too_long', 'segment_too_short', 'take_clipped'])
    assert.equal(r.stats.cutCount, 1)
  })

  it('章节时长异常（< 10 s 或 > 2 h）是警告', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1 })],
      chapters: [
        { chapterId: 'ch-1', title: '很短', durationMs: 3000 },
        { chapterId: 'ch-2', title: '很长', durationMs: 3 * 3600_000 },
      ],
    })
    assert.equal(r.warnings.filter(w => w.kind === 'chapter_too_short').length, 1)
    assert.equal(r.warnings.filter(w => w.kind === 'chapter_too_long').length, 1)
    assert.equal(r.stats.totalDurationMs, 3000 + 3 * 3600_000)
  })

  it('全书响度极端偏差（> 6 LU）只报一次，避免刷屏', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1 })],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
      measuredLufs: [-16, -16.2, -30, -28],
      targetLufs: -16,
    })
    assert.equal(r.warnings.filter(w => w.kind === 'loudness_outlier').length, 1)
  })

  it('输出文件已存在是**提示**（info），既不阻断也不当警告', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1 })],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
      existingOutputs: ['exports/斗破苍穹/001_第1章.mp3'],
    })
    assert.deepEqual(r.blockers, [])
    assert.deepEqual(r.warnings, [])
    assert.equal(r.infos.length, 1)
    assert.equal(r.infos[0]!.kind, 'output_exists')
  })

  it('片段 RMS 过低（< -60 dBFS）是警告', () => {
    const r = preCheck({
      lines: [line({ lineId: 'l1', seq: 1, rmsDb: -72 })],
      chapters: [{ chapterId: 'ch-1', title: '第1章', durationMs: 600_000 }],
    })
    assert.ok(r.warnings.some(w => w.kind === 'segment_silent'))
  })
})

// ---------------------------------------------------------------------------
// 渲染后实测质检
// ---------------------------------------------------------------------------

describe('渲染后实测质检（docs/15 §6.2）', () => {
  const base = {
    expectedDurationMs: 742_000,
    actualDurationMs: 742_100,
    measuredLufs: -16.1,
    targetLufs: -16,
    measuredTpDbfs: -1.2,
    targetTpDbfs: -1,
    rmsDb: -20,
  }

  it('一切正常：passed=true 且没有 issue', () => {
    const r = postCheck(base)
    assert.equal(r.passed, true)
    assert.deepEqual(r.issues, [])
  })

  it('★ 整章静音（RMS < -60 dBFS）是**阻断**（渲染失败）', () => {
    const r = postCheck({ ...base, rmsDb: -80, measuredLufs: -70 })
    assert.equal(r.passed, false)
    const issue = r.issues.find(i => i.kind === 'silent_chapter')
    assert.ok(issue)
    assert.equal(issue!.severity, 'blocker')
    assert.match(issue!.message, /渲染失败/)
  })

  it('★ 响度无法测量（input_i = -inf → null）也是阻断', () => {
    const r = postCheck({ ...base, measuredLufs: null })
    assert.equal(r.passed, false)
    assert.equal(r.issues[0]!.kind, 'loudness_unmeasurable')
    assert.equal(r.issues[0]!.severity, 'blocker')
  })

  it('成品不可播放（ffprobe 读不出）是阻断', () => {
    const r = postCheck({ ...base, playable: false })
    assert.equal(r.passed, false)
    assert.equal(r.issues[0]!.kind, 'not_playable')
  })

  it('响度偏差 > 1.0 LU 是警告（超阈值应先自动微调一次）', () => {
    const ok = postCheck({ ...base, measuredLufs: -16.9 })
    assert.equal(ok.passed, true)
    assert.equal(ok.issues.length, 0, '|Δ| = 0.9 LU 在容差内')

    const bad = postCheck({ ...base, measuredLufs: -14.5 })
    const issue = bad.issues.find(i => i.kind === 'loudness_deviation')
    assert.ok(issue)
    assert.equal(issue!.severity, 'warning')
    assert.match(issue!.message, /1\.50 LU/)
    assert.equal(bad.passed, true, '响度偏差只警告，不阻断')
  })

  it('真峰超过目标 → 警告并给出「再降多少 dB」', () => {
    const r = postCheck({ ...base, measuredTpDbfs: -0.2 })
    const issue = r.issues.find(i => i.kind === 'true_peak_exceeded')
    assert.ok(issue)
    assert.match(issue!.message, /再降 1\.3 dB/)
    assert.equal(postCheck({ ...base, measuredTpDbfs: -1.05 }).issues.length, 0, '容差内不报')
  })

  it('★ 章间响度差 > 1.5 LU → 警告（整本听感不齐）', () => {
    const ok = postCheck({ ...base, chapterLufsSpread: 1.4 })
    assert.equal(ok.issues.filter(i => i.kind === 'chapter_lufs_spread').length, 0)
    const bad = postCheck({ ...base, chapterLufsSpread: 2.3 })
    const issue = bad.issues.find(i => i.kind === 'chapter_lufs_spread')
    assert.ok(issue)
    assert.match(issue!.message, /2\.30 LU/)
    assert.equal(issue!.severity, 'warning')
  })

  it('时长偏差 > 1 s → 警告（可能有片段丢失）', () => {
    const ok = postCheck({ ...base, actualDurationMs: 742_900 })
    assert.equal(ok.issues.filter(i => i.kind === 'duration_mismatch').length, 0)
    const bad = postCheck({ ...base, actualDurationMs: 738_000 })
    const issue = bad.issues.find(i => i.kind === 'duration_mismatch')
    assert.ok(issue)
    assert.match(issue!.message, /相差 4000 ms/)
  })

  it('异常长静音（非章头章尾、> 10 s）→ 警告；章头章尾的长静音不算', () => {
    const bad = postCheck({
      ...base,
      longSilences: [{ startMs: 300_000, endMs: 315_000 }],
      headSilenceMs: 500,
      tailSilenceMs: 1500,
    })
    const issue = bad.issues.find(i => i.kind === 'long_silence')
    assert.ok(issue)
    assert.match(issue!.message, /15\.0 s/)

    const headTail = postCheck({
      ...base,
      longSilences: [
        { startMs: 0, endMs: 12_000 },
        { startMs: 730_000, endMs: 742_000 },
      ],
      headSilenceMs: 500,
      tailSilenceMs: 1500,
    })
    assert.equal(headTail.issues.filter(i => i.kind === 'long_silence').length, 0)
  })

  it('削波样本 > 0 → 警告', () => {
    const r = postCheck({ ...base, clippedSamples: 12 })
    const issue = r.issues.find(i => i.kind === 'clipping')
    assert.ok(issue)
    assert.match(issue!.message, /12 处/)
  })
})

// ---------------------------------------------------------------------------
// 章间响度差与报告汇总
// ---------------------------------------------------------------------------

describe('章间响度差（docs/15 §6.2：≤ 1.5 LU）', () => {
  it('极差在阈值内 → ok', () => {
    assert.equal(QC_THRESHOLDS.chapterLufsSpread, 1.5)
    const r = computeChapterLufsSpread([
      chapterResult({ chapterIndex: 1, measuredLufs: -16.1 }),
      chapterResult({ chapterIndex: 2, measuredLufs: -15.2 }),
      chapterResult({ chapterIndex: 3, measuredLufs: -16.4 }),
    ])
    assert.ok(Math.abs(r.spread - 1.2) < 1e-9)
    assert.equal(r.ok, true)
    assert.equal(r.measured, 3)
    assert.equal(r.min, -16.4)
    assert.equal(r.max, -15.2)
  })

  it('极差超过 1.5 LU → 不 ok', () => {
    const r = computeChapterLufsSpread([
      chapterResult({ chapterIndex: 1, measuredLufs: -16.0 }),
      chapterResult({ chapterIndex: 2, measuredLufs: -13.9 }),
    ])
    assert.ok(Math.abs(r.spread - 2.1) < 1e-9)
    assert.equal(r.ok, false)
  })

  it('跳过 skipped 与响度缺失的章节（它们不参与极差）', () => {
    const r = computeChapterLufsSpread([
      chapterResult({ chapterIndex: 1, measuredLufs: -16.0 }),
      chapterResult({ chapterIndex: 2, measuredLufs: -16.1 }),
      chapterResult({ chapterIndex: 3, measuredLufs: null }),
      chapterResult({ chapterIndex: 4, measuredLufs: -30, skipped: true }),
    ])
    assert.equal(r.measured, 2)
    assert.ok(Math.abs(r.spread - 0.1) < 1e-9)
    assert.equal(r.ok, true)
  })

  it('有效章数 < 2 → spread=0 且 ok（单章无法谈「章间」）', () => {
    const r = computeChapterLufsSpread([chapterResult({ chapterIndex: 1, measuredLufs: -16 })])
    assert.equal(r.spread, 0)
    assert.equal(r.ok, true)
    assert.equal(r.measured, 1)
  })
})

describe('导出报告汇总（docs/05 §10.3）', () => {
  it('统计成功/跳过/失败/警告数与总时长', () => {
    const summary = summarizeExportReport([
      chapterResult({ chapterIndex: 1 }),
      chapterResult({ chapterIndex: 2, warnings: ['w1', 'w2'] }),
      chapterResult({ chapterIndex: 3, skipped: true }),
      chapterResult({ chapterIndex: 4, output: '' }),
    ])
    assert.equal(summary.total, 4)
    assert.equal(summary.succeeded, 2)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.failed, 1)
    assert.equal(summary.warnings, 2)
    assert.equal(summary.totalDurationMs, 2_400_000)
  })
})
