/**
 * Novel Studio · 任务包回收合并测试（**本工作流最关键的一环**）
 * ============================================================================
 * 运行：
 *   node --experimental-strip-types tests/main/package-merge.test.ts
 *
 * 依据：docs/03 §9 合并规则表、docs/11 §6.4 回收合并流程图。
 *
 * 构造的 6 种回收情形（每一种都有独立断言）：
 *   1. 正常归位          —— lineId 存在 → 音频入库为 take
 *   2. linesHash 已变化   —— 计算差异、仍按 lineId 归位、产出 PACKAGE_LINES_CHANGED 级报告
 *   3. 未知 lineId       —— 进 unknown，**不入库**
 *   4. 重复 take         —— 同 line 已有 take → 追加不覆盖；同 takeId 同内容 → 去重
 *   5. 校验失败          —— checksumFailed 计数，跳过不整体失败
 *   6. 损坏文件          —— corrupted 计数，跳过不整体失败
 * 另外守护：missing 列表正确、adopted 计数正确、全套问题混合时仍**绝不整体失败**、
 * 以及「读真实 .nst zip → 合并」的端到端路径。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AppError } from '../../src/shared/errors.ts'
import type { NstLine, NstManifest } from '../../src/shared/types.ts'
import {
  collectPackageTakes,
  mergeTaskPackage,
  mergeTaskPackageFromZip,
  type MergeHooks,
  type MergeSkip,
  type PackageTake,
} from '../../src/main/features/book/package/merge.ts'
import {
  CHECKSUMS_FILE,
  DEFAULT_RECORD_SETTINGS,
  TASK_FILE,
  TAKES_FILE,
  buildNstManifest,
} from '../../src/main/features/book/package/manifest.ts'
import { computeLinesHash, type LinesHashInput } from '../../src/main/features/book/package/nst.ts'
import { createStoreZipWriter } from '../../src/main/features/book/package/zip/writer.ts'
import { openZip } from '../../src/main/features/book/package/zip/reader.ts'
import { createSilentWav, probeWav } from '../../src/main/features/book/package/wav.ts'
import { formatChecksumsFile, sha256Hex } from '../../src/main/features/book/package/checksums.ts'

// ---------------------------------------------------------------------------
// 测试数据与脚手架
// ---------------------------------------------------------------------------

const BOOK_ID = 'book-1'
const XIAO_YAN = 'char-xy'

/** 当前画本（LinesHashInput 形态，够 hash 比对与 lineId 判断用） */
const L1: LinesHashInput = { id: 'L1', text: '他缓缓抬起头。', characterId: null, speakerType: 'narration', emotion: '低沉', pauseAfterMs: 500 }
const L2: LinesHashInput = { id: 'L2', text: '我萧炎，从来不会认输。', characterId: XIAO_YAN, emotion: '愤怒', pauseAfterMs: 600 }
const L3: LinesHashInput = { id: 'L3', text: '小子，别冲动。', characterId: 'char-yl', emotion: '焦急', pauseAfterMs: 400 }
const L4: LinesHashInput = { id: 'L4', text: '这一行没人录。', characterId: null, speakerType: 'narration', emotion: null, pauseAfterMs: 300 }

function nstLine(line: LinesHashInput): NstLine {
  return {
    id: line.id,
    seq: 1,
    chapterTitle: '第1章 陨落的天才',
    characterId: line.characterId ?? null,
    characterName: line.characterId ? '角色' : '旁白',
    text: line.text,
    emotion: line.emotion ?? null,
    emotionIntensity: null,
    speed: null,
    pauseAfterMs: line.pauseAfterMs ?? 0,
    pronunciation: null,
    note: null,
    prevLine: null,
    nextLine: null,
    hasReference: false,
  }
}

function makeManifest(snapshot: LinesHashInput[], linesHash?: string): NstManifest {
  const lines = snapshot.map(nstLine)
  return buildNstManifest({
    packageId: 'pkg-merge-1',
    source: { projectId: 'proj-1', bookId: BOOK_ID, exportedAt: '2026-02-14T10:00:00Z' },
    assignee: { voiceActorId: 'actor-1', name: '小林', note: null },
    recordSettings: DEFAULT_RECORD_SETTINGS,
    characters: [],
    lines,
    linesHash: linesHash ?? computeLinesHash(lines),
  })
}

const WAV = (ms = 300): Buffer =>
  Buffer.from(createSilentWav({ sampleRate: 48000, bitDepth: 24, channels: 1, durationMs: ms }))

function take(lineId: string, takeId: string, bytes: Buffer | null = WAV(), extra: Partial<PackageTake> = {}): PackageTake {
  return {
    lineId,
    takeId,
    fileName: `slots/${lineId}/${takeId}.wav`,
    durationMs: 300,
    peakDb: -6,
    recordedAt: 1700000000000,
    device: 'USB Mic',
    bytes,
    contentHash: bytes ? sha256Hex(bytes) : undefined,
    checksum: 'ok',
    ...extra,
  }
}

interface Spy {
  written: Array<{ lineId: string; takeId: string; filePath: string; contentHash: string; size: number }>
  inserted: Array<{ lineId: string; takeId: string; appendedToExisting: boolean; storedTakeId: string }>
  adopted: Array<{ lineId: string; takeId: string }>
  skipped: MergeSkip[]
  /** 模拟「本地 takes 存储」，用于验证「追加不覆盖」 */
  store: Array<{ lineId: string; takeId: string; contentHash: string }>
}

function makeHooks(existingHashes: Record<string, string> = {}): { hooks: MergeHooks; spy: Spy } {
  const spy: Spy = {
    written: [],
    inserted: [],
    adopted: [],
    skipped: [],
    store: Object.entries(existingHashes).map(([key, contentHash]) => {
      const [lineId, takeId] = key.split('|')
      return { lineId, takeId, contentHash }
    }),
  }

  const hooks: MergeHooks = {
    writeTake: ({ lineId, takeId, bytes, contentHash }) => {
      const filePath = `takes/${lineId}/${takeId}.wav`
      spy.written.push({ lineId, takeId, filePath, contentHash, size: bytes.byteLength })
      return { filePath }
    },
    insertTake: (input) => {
      spy.inserted.push({
        lineId: input.lineId,
        takeId: input.takeId,
        appendedToExisting: input.appendedToExisting,
        storedTakeId: input.takeId,
      })
      // 模拟仓储：追加而不是覆盖（同一 (lineId,takeId) 才覆盖）
      const existingIndex = spy.store.findIndex((t) => t.lineId === input.lineId && t.takeId === input.takeId)
      if (existingIndex >= 0) spy.store[existingIndex] = { lineId: input.lineId, takeId: input.takeId, contentHash: input.contentHash }
      else spy.store.push({ lineId: input.lineId, takeId: input.takeId, contentHash: input.contentHash })
    },
    adoptTake: ({ lineId, takeId }) => {
      spy.adopted.push({ lineId, takeId })
    },
    onSkip: (s) => spy.skipped.push(s),
  }
  return { hooks, spy }
}

// ---------------------------------------------------------------------------
// 情形 1：正常归位
// ---------------------------------------------------------------------------

describe('情形 1 · 正常归位', () => {
  it('lineId 存在 → 音频归位为 take；原本没录音 → 设为成品并计入 adopted', async () => {
    const manifest = makeManifest([L1, L2])
    const { hooks, spy } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1'), take('L2', 't1')],
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })

    assert.deepEqual(result.report, {
      packageId: 'pkg-merge-1',
      actorName: '小林',
      placed: 2,
      missing: [],
      unknown: [],
      checksumFailed: 0,
      corrupted: 0,
      linesChanged: false,
      diffCount: 0,
      duplicateTakes: 0,
      adopted: 2,
    })
    assert.equal(spy.written.length, 2)
    assert.equal(spy.written[0].filePath, 'takes/L1/t1.wav')
    assert.equal(spy.inserted.length, 2)
    assert.equal(spy.inserted[0].appendedToExisting, false)
    assert.deepEqual(spy.adopted.map((a) => a.lineId), ['L1', 'L2'])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.warnings, ['2 行原本没有录音，已把回传的 take 设为成品'])
  })

  it('已经有成品/录音的行不会被自动设为成品', async () => {
    const manifest = makeManifest([L1])
    const { hooks, spy } = makeHooks({ 'L1|t0': sha256Hex(WAV(100)) })
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't2')],
      local: {
        lines: [L1],
        existingTakes: [{ lineId: 'L1', takeId: 't0', contentHash: sha256Hex(WAV(100)) }],
      },
      hooks,
    })
    assert.equal(result.report.placed, 1)
    assert.equal(result.report.adopted, 0)
    assert.deepEqual(spy.adopted, [])
    assert.equal(result.counters.appendedTakes, 1, '该行已有 take → 计入追加')
  })
})

// ---------------------------------------------------------------------------
// 情形 2：linesHash 变化
// ---------------------------------------------------------------------------

describe('情形 2 · linesHash 不一致（画本已变更）', () => {
  it('计算差异、仍按 lineId 归位、报告里给出 diffCount 与警告', async () => {
    // 下发快照里 L2 的文本与现在不同 → 1 处修改
    const snapshot: LinesHashInput[] = [L1, { ...L2, text: '我萧炎，绝不会认输（旧文本）。' }]
    const manifest = makeManifest(snapshot)
    const { hooks } = makeHooks()

    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1'), take('L2', 't1')],
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })

    assert.equal(result.report.linesChanged, true, '应识别出画本已变更（PACKAGE_LINES_CHANGED 的依据）')
    assert.equal(result.report.diffCount, 1)
    assert.deepEqual(result.diff.modified, ['L2'])
    assert.equal(result.report.placed, 2, '画本改了也要尽量归位，不能把配音员的活儿丢掉')
    assert.equal(result.warnings.some((w) => w.includes('画本与下发时有 1 处差异')), true)
  })

  it('差异含新增 / 删除 / 修改时 diffCount 为三者之和', async () => {
    const snapshot = [L1, L2, L3]
    const manifest = makeManifest(snapshot)
    const { hooks } = makeHooks()
    const current = [
      { ...L1, text: '改过的旁白。' }, // 修改
      L2, // 不变
      // L3 被删除
      { id: 'L9', text: '新加的一行。', characterId: null, speakerType: 'narration', emotion: null, pauseAfterMs: 100 }, // 新增
    ]
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1')],
      local: { lines: current, existingTakes: [] },
      hooks,
    })
    assert.deepEqual(result.diff.modified, ['L1'])
    assert.deepEqual(result.diff.removed, ['L3'])
    assert.deepEqual(result.diff.added, ['L9'])
    assert.equal(result.report.diffCount, 3)
    assert.equal(result.report.linesChanged, true)
  })
})

// ---------------------------------------------------------------------------
// 情形 3：未知 lineId
// ---------------------------------------------------------------------------

describe('情形 3 · 未知 lineId', () => {
  it('画本里没有的行 → 进 unknown 且不入库', async () => {
    const manifest = makeManifest([L1])
    const { hooks, spy } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1'), take('L-GHOST', 't1'), take('L-GHOST', 't2')],
      local: { lines: [L1], existingTakes: [] },
      hooks,
    })

    assert.deepEqual(result.report.unknown, ['L-GHOST'], 'unknown 按 lineId 去重')
    assert.equal(result.report.placed, 1, '只有 L1 归位')
    assert.equal(spy.written.length, 1, '未知行的音频不得写盘')
    assert.equal(spy.inserted.length, 1, '未知行不得入库')
    assert.equal(result.skipped.filter((s) => s.reason === 'unknown-line').length, 2)
    assert.equal(result.warnings.some((w) => w.includes('lineId 在本地画本中不存在')), true)
  })
})

// ---------------------------------------------------------------------------
// 情形 4：重复 take
// ---------------------------------------------------------------------------

describe('情形 4 · 重复 take', () => {
  it('同 line 已有 take → 新 take 追加（不覆盖），计入 duplicateTakes', async () => {
    const manifest = makeManifest([L1])
    const oldBytes = WAV(200)
    const { hooks, spy } = makeHooks({ 'L1|t0': sha256Hex(oldBytes) })

    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', WAV(400))],
      local: { lines: [L1], existingTakes: [{ lineId: 'L1', takeId: 't0', contentHash: sha256Hex(oldBytes) }] },
      hooks,
    })

    assert.equal(result.report.placed, 1)
    assert.equal(result.report.duplicateTakes, 1)
    assert.equal(result.counters.appendedTakes, 1)
    assert.equal(result.counters.dedupedTakes, 0)
    assert.equal(result.report.adopted, 0, '原本已有 take，不设为成品')
    // 追加而不是覆盖：旧 take 仍在
    assert.deepEqual(
      spy.store.map((t) => t.takeId).sort(),
      ['t0', 't1'],
      '新 take 必须追加，旧 take 不能被覆盖',
    )
    assert.equal(spy.written[0].filePath, 'takes/L1/t1.wav')
  })

  it('同 line 同 takeId 且内容相同 → 按内容哈希去重（不重复入库）', async () => {
    const manifest = makeManifest([L1])
    const bytes = WAV(300)
    const { hooks, spy } = makeHooks({ 'L1|t1': sha256Hex(bytes) })

    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', bytes)],
      local: { lines: [L1], existingTakes: [{ lineId: 'L1', takeId: 't1', contentHash: sha256Hex(bytes) }] },
      hooks,
    })

    assert.equal(result.report.placed, 0, '去重后不应重复入库')
    assert.equal(result.report.duplicateTakes, 1)
    assert.equal(result.counters.dedupedTakes, 1)
    assert.equal(spy.written.length, 0, '重复内容不应再写一遍盘')
    assert.equal(result.skipped[0].reason, 'duplicate')
    assert.equal(spy.store.length, 1)
  })

  it('同 line 同 takeId 但内容不同 → 视为重录，追加而不是覆盖', async () => {
    const manifest = makeManifest([L1])
    const oldBytes = WAV(300)
    const newBytes = WAV(700)
    const { hooks, spy } = makeHooks({ 'L1|t1': sha256Hex(oldBytes) })

    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', newBytes)],
      local: { lines: [L1], existingTakes: [{ lineId: 'L1', takeId: 't1', contentHash: sha256Hex(oldBytes) }] },
      hooks,
    })

    assert.equal(result.report.placed, 1)
    assert.equal(result.counters.appendedTakes, 1)
    assert.equal(spy.store[0].contentHash, sha256Hex(newBytes), '内容不同应更新为该 take 的新内容')
    assert.equal(result.report.duplicateTakes, 1)
  })

  it('同一次回传里重复两条完全相同的 take → 第二条被去重', async () => {
    const manifest = makeManifest([L1, L2])
    const bytes = WAV(300)
    const { hooks, spy } = makeHooks()
    // 第一次归位后，本地就有了 L1|t1；第二次（内容相同）应被去重
    const existingAfterFirst: Array<{ lineId: string; takeId: string; contentHash: string }> = []
    const localWithDynamicTakes = {
      lines: [L1, L2],
      existingTakes: existingAfterFirst,
    }
    hooks.insertTake = (input) => {
      spy.inserted.push({ lineId: input.lineId, takeId: input.takeId, appendedToExisting: input.appendedToExisting, storedTakeId: input.takeId })
      existingAfterFirst.push({ lineId: input.lineId, takeId: input.takeId, contentHash: input.contentHash })
    }

    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', bytes), take('L1', 't1', bytes)],
      local: localWithDynamicTakes,
      hooks,
    })
    assert.equal(result.report.placed, 1)
    assert.equal(result.counters.dedupedTakes, 1)
    assert.equal(result.report.duplicateTakes, 1)
    assert.equal(spy.inserted.length, 1)
  })
})

// ---------------------------------------------------------------------------
// 情形 5 / 6：校验失败与损坏文件
// ---------------------------------------------------------------------------

describe('情形 5 · 逐文件校验失败', () => {
  it('checksumFailed 计数、跳过该条、其余照常归位（不整体失败）', async () => {
    const manifest = makeManifest([L1, L2])
    const { hooks, spy } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [
        take('L1', 't1', WAV(), { checksum: 'mismatch' }),
        take('L2', 't1', WAV(), { checksum: 'ok' }),
      ],
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })

    assert.equal(result.report.checksumFailed, 1)
    assert.equal(result.report.placed, 1, '其余行照常归位')
    assert.equal(result.report.corrupted, 0)
    assert.equal(spy.written.length, 1)
    assert.equal(result.skipped[0].reason, 'checksum-mismatch')
    assert.equal(result.warnings.some((w) => w.includes('校验不通过')), true)
  })
})

describe('情形 6 · 损坏文件', () => {
  it('音频读不出来（bytes=null）→ corrupted，跳过', async () => {
    const manifest = makeManifest([L1])
    const { hooks, spy } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', null, { checksum: 'unreadable' })],
      local: { lines: [L1], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.corrupted, 1)
    assert.equal(result.report.placed, 0)
    assert.equal(spy.written.length, 0)
    assert.equal(result.skipped[0].reason, 'corrupted')
  })

  it('不是 WAV（文件头损坏）→ corrupted，跳过', async () => {
    const manifest = makeManifest([L1])
    const { hooks } = makeHooks()
    const garbage = Buffer.from('这不是音频，只是乱码'.repeat(10), 'utf8')
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', garbage)],
      local: { lines: [L1], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.corrupted, 1)
    assert.equal(result.skipped[0].message.includes('WAV'), true)
  })

  it('0 字节音频 → corrupted', async () => {
    const manifest = makeManifest([L1])
    const { hooks } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', Buffer.alloc(0))],
      local: { lines: [L1], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.corrupted, 1)
  })

  it('采样率/位深不符 → 照常入库但记入 auditIssues（docs/03 §9：入库但标记）', async () => {
    const manifest = makeManifest([L1])
    const { hooks } = makeHooks()
    const wrongFormat = Buffer.from(createSilentWav({ sampleRate: 44100, bitDepth: 16, channels: 1, durationMs: 300 }))
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1', wrongFormat)],
      local: { lines: [L1], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.placed, 1, '格式不符不该丢掉配音员的录音')
    assert.equal(result.auditIssues.length, 1)
    assert.equal(result.auditIssues[0].issues.length, 2, '采样率与位深各一条')
    assert.equal(result.report.corrupted, 0)
  })

  it('写盘失败只影响该条（write-failed），不影响其余', async () => {
    const manifest = makeManifest([L1, L2])
    const { hooks, spy } = makeHooks()
    const originalWrite = hooks.writeTake as NonNullable<MergeHooks['writeTake']>
    hooks.writeTake = (input) => {
      if (input.lineId === 'L1') throw new Error('磁盘写入失败（模拟）')
      return originalWrite(input)
    }
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1'), take('L2', 't1')],
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.placed, 1)
    assert.equal(result.counters.writeFailed, 1)
    assert.equal(result.skipped.some((s) => s.reason === 'write-failed'), true)
    assert.equal(spy.written.length, 1)
  })
})

// ---------------------------------------------------------------------------
// missing / adopted / 混合场景
// ---------------------------------------------------------------------------

describe('missing 列表与 adopted 计数', () => {
  it('missing = 下发过、本地仍在、但本次没回传的行', async () => {
    const manifest = makeManifest([L1, L2, L3, L4])
    const { hooks } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L2', 't1')],
      // L3 在本地已被删除 → 不该出现在 missing（不需要向配音员催录）
      local: { lines: [L1, L2, L4], existingTakes: [] },
      hooks,
    })
    assert.deepEqual(result.report.missing, ['L1', 'L4'])
    assert.equal(result.report.placed, 1)
  })

  it('adoptWhenNoRecording=false 时不自动设为成品，但音频照常入库', async () => {
    const manifest = makeManifest([L1])
    const { hooks, spy } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1')],
      local: { lines: [L1], existingTakes: [] },
      hooks: { ...hooks, adoptWhenNoRecording: false },
    })
    assert.equal(result.report.placed, 1)
    assert.equal(result.report.adopted, 0)
    assert.deepEqual(spy.adopted, [])
  })

  it('hasSegment 回调优先于 existingTakes 推断（已有成品片段就不再自动设为成品）', async () => {
    const manifest = makeManifest([L1])
    const { hooks, spy } = makeHooks()
    const result = await mergeTaskPackage({
      manifest,
      takes: [take('L1', 't1')],
      local: { lines: [L1], existingTakes: [], hasSegment: () => true },
      hooks,
    })
    assert.equal(result.report.adopted, 0)
    assert.equal(result.report.placed, 1)
    assert.deepEqual(spy.adopted, [])
  })

  it('取消时抛 TASK_CANCELLED（不把它算成失败或跳过）', async () => {
    const controller = new AbortController()
    const manifest = makeManifest([L1])
    const { hooks } = makeHooks()
    controller.abort()
    await assert.rejects(
      () =>
        mergeTaskPackage({
          manifest,
          takes: [take('L1', 't1')],
          local: { lines: [L1], existingTakes: [] },
          hooks: { ...hooks, signal: controller.signal },
        }),
      (e: unknown) => e instanceof AppError && e.key === 'TASK_CANCELLED',
    )
  })
})

describe('混合场景 · 六种情形同时出现也绝不整体失败', () => {
  it('一次回传里同时有正常/未知/重复/校验失败/损坏/画本变更', async () => {
    const snapshot: LinesHashInput[] = [
      L1,
      { ...L2, text: '旧文本' }, // 与现有画本不同 → 画本已变更
      L3,
      L4,
    ]
    const manifest = makeManifest(snapshot)
    const oldBytes = WAV(150)
    const { hooks, spy } = makeHooks({ 'L2|t0': sha256Hex(oldBytes) })

    const result = await mergeTaskPackage({
      manifest,
      takes: [
        take('L1', 't1'), // 正常归位 + adopted
        take('L2', 't1', WAV(500)), // 追加（该行已有 take）
        take('L2', 't0', oldBytes), // 同 takeId 同内容 → 去重
        take('L3', 't1', WAV(), { checksum: 'mismatch' }), // 校验失败
        take('L4', 't1', Buffer.from('坏文件')), // 损坏
        take('L-GHOST', 't1'), // 未知 lineId
      ],
      local: {
        lines: [L1, L2, L3, L4],
        existingTakes: [{ lineId: 'L2', takeId: 't0', contentHash: sha256Hex(oldBytes) }],
      },
      hooks,
    })

    assert.equal(result.report.placed, 2)
    assert.deepEqual(result.report.unknown, ['L-GHOST'])
    assert.equal(result.report.checksumFailed, 1)
    assert.equal(result.report.corrupted, 1)
    assert.equal(result.report.linesChanged, true)
    assert.equal(result.report.diffCount, 1)
    assert.equal(result.report.duplicateTakes, 2, '1 条追加 + 1 条去重')
    assert.equal(result.report.adopted, 1, '只有 L1 原本没有 take')
    assert.deepEqual(result.report.missing, []) // 4 行都出现在包里（哪怕失败或被去重）
    assert.equal(spy.written.length, 2)
    assert.equal(spy.store.some((t) => t.takeId === 't0' && t.contentHash === sha256Hex(oldBytes)), true, '旧 take 未被覆盖')
    assert.equal(result.skipped.length, 4)
    assert.deepEqual(
      result.skipped.map((s) => s.reason).sort(),
      ['checksum-mismatch', 'corrupted', 'duplicate', 'unknown-line'],
    )
    assert.ok(result.warnings.length >= 4, '每类问题都要有可读的警告')
  })
})

// ---------------------------------------------------------------------------
// 端到端：读真实 .nst zip 再合并
// ---------------------------------------------------------------------------

describe('端到端 · 读回传包 zip → 合并', () => {
  async function buildReturnPackage(options: {
    manifest: NstManifest
    takes: Array<{ lineId: string; takeId: string; bytes: Buffer }>
    /** 故意写错的校验和（路径 → 假哈希） */
    corruptChecksumFor?: string
    /** 包内实际不写入这些路径（模拟文件缺失） */
    omitPaths?: string[]
  }): Promise<Buffer> {
    const writer = createStoreZipWriter()
    const manifestJson = JSON.stringify(options.manifest, null, 2)
    await writer.addFile(TASK_FILE, Buffer.from(manifestJson, 'utf8'))
    await writer.addFile(
      TAKES_FILE,
      Buffer.from(
        JSON.stringify({
          takes: options.takes.map((t) => ({
            lineId: t.lineId,
            takeId: t.takeId,
            fileName: `${t.takeId}.wav`,
            durationMs: 300,
            peakDb: -6,
            recordedAt: 1700000000000,
            device: 'USB Mic',
          })),
        }),
        'utf8',
      ),
    )

    const checksums: Array<{ path: string; hash: string }> = [
      { path: TASK_FILE, hash: sha256Hex(manifestJson) },
    ]
    for (const t of options.takes) {
      const path = `slots/${t.lineId}/${t.takeId}.wav`
      if (options.omitPaths?.includes(path)) continue
      await writer.addFile(path, t.bytes)
      checksums.push({
        path,
        hash: options.corruptChecksumFor === path ? sha256Hex('故意写错的哈希') : sha256Hex(t.bytes),
      })
    }
    await writer.addFile(CHECKSUMS_FILE, Buffer.from(formatChecksumsFile(checksums), 'utf8'))
    await writer.addDirectory('slots')
    await writer.finalize()
    return writer.toBuffer()
  }

  it('正常回传：collect 出音频 → 合并归位（含时长/设备元数据）', async () => {
    const manifest = makeManifest([L1, L2])
    const zipBytes = await buildReturnPackage({
      manifest,
      takes: [
        { lineId: 'L1', takeId: 't1', bytes: WAV(250) },
        { lineId: 'L2', takeId: 't1', bytes: WAV(350) },
      ],
    })
    const { hooks, spy } = makeHooks()
    const zip = openZip(zipBytes)

    const collected = collectPackageTakes(zip, manifest, {})
    assert.equal(collected.takes.length, 2)
    assert.equal(collected.corrupted, 0)
    assert.equal(collected.checksumFailed, 0)
    assert.equal(collected.takes[0].durationMs, 300, '时长优先取 takes.json 的元数据')
    assert.equal(collected.takes[0].device, 'USB Mic')

    const result = await mergeTaskPackageFromZip({
      zip,
      manifest,
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.placed, 2)
    assert.equal(result.report.adopted, 2)
    assert.deepEqual(result.report.missing, [])
    assert.deepEqual(result.skipped, [])
    assert.equal(spy.written.length, 2)
    assert.equal(spy.written[0].contentHash, sha256Hex(WAV(250)))
  })

  it('校验和不符的条目在 collect 阶段就被拦下（checksumFailed），其余照常', async () => {
    const manifest = makeManifest([L1, L2])
    const zipBytes = await buildReturnPackage({
      manifest,
      takes: [
        { lineId: 'L1', takeId: 't1', bytes: WAV(250) },
        { lineId: 'L2', takeId: 't1', bytes: WAV(350) },
      ],
      corruptChecksumFor: 'slots/L1/t1.wav',
    })
    const { hooks } = makeHooks()
    const zip = openZip(zipBytes)
    const result = await mergeTaskPackageFromZip({
      zip,
      manifest,
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.checksumFailed, 1)
    assert.equal(result.report.placed, 1)
    assert.deepEqual(result.placed.map((p) => p.lineId), ['L2'])
    assert.equal(result.skipped.some((s) => s.reason === 'checksum-mismatch'), true)
  })

  it('包内音频文件缺失（takes.json 声明了但没有实体）→ 该行进 missing，不整体失败', async () => {
    const manifest = makeManifest([L1, L2])
    const zipBytes = await buildReturnPackage({
      manifest,
      takes: [
        { lineId: 'L1', takeId: 't1', bytes: WAV(250) },
        { lineId: 'L2', takeId: 't1', bytes: WAV(350) },
      ],
      omitPaths: ['slots/L2/t1.wav'],
    })
    const { hooks } = makeHooks()
    const zip = openZip(zipBytes)
    const result = await mergeTaskPackageFromZip({
      zip,
      manifest,
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })
    // L2 的文件根本不在包里 → 扫描时看不到它 → 该行算「未回传」
    assert.deepEqual(result.report.missing, ['L2'])
    assert.equal(result.report.placed, 1)
    assert.equal(result.report.corrupted, 0)
  })

  it('包内音频是乱码 → corrupted，其余行照常归位', async () => {
    const manifest = makeManifest([L1, L2])
    const zipBytes = await buildReturnPackage({
      manifest,
      takes: [
        { lineId: 'L1', takeId: 't1', bytes: Buffer.from('这不是 WAV 文件的内容') },
        { lineId: 'L2', takeId: 't1', bytes: WAV(350) },
      ],
    })
    const { hooks } = makeHooks()
    const zip = openZip(zipBytes)
    const result = await mergeTaskPackageFromZip({
      zip,
      manifest,
      local: { lines: [L1, L2], existingTakes: [] },
      hooks,
    })
    assert.equal(result.report.corrupted, 1)
    assert.equal(result.report.placed, 1)
    assert.deepEqual(result.placed.map((p) => p.lineId), ['L2'])
  })

  it('真实 WAV 经过 zip 往返后仍能被解析出正确的时长', async () => {
    const manifest = makeManifest([L1])
    const zipBytes = await buildReturnPackage({
      manifest,
      takes: [{ lineId: 'L1', takeId: 't1', bytes: WAV(500) }],
    })
    const collected = collectPackageTakes(openZip(zipBytes), manifest, {})
    // takes.json 里声明 300 ms，音频头算出 500 ms —— 优先用声明值，但两者都能拿到
    assert.equal(collected.takes[0].durationMs, 300)
    const info = probeWav(collected.takes[0].bytes as Buffer)
    assert.equal(info?.durationMs, 500)
    assert.equal(info?.sampleRate, 48000)
    assert.equal(info?.bitDepth, 24)
  })
})
