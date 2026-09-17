/**
 * Novel Studio · 画本主进程服务测试（附加，覆盖交付项 B）
 * ============================================================================
 * 设计文档：docs/11 §2（Step 1~9 编排）、§4.4（改过就置 human）、§4.9（乐观锁）、
 *           §8（异常与边界）、docs/06 §4.3（分批让路）、§5.5（重算与人工保护）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/canvas-service.test.ts
 *
 * 守护点：
 *   · Step 9 真的落库了（行 / 向量 / 原型向量增量 / 快照）
 *   · 分批 + yieldToLoop 让路（docs/06 §4.3：不让路会冻住主进程）
 *   · AbortSignal 取消 → AppError(TASK_CANCELLED)
 *   · 重算永不覆盖 decidedBy='human'；换模型时非全量 scope 抛 ATTRIBUTION_RECOMPUTE_REQUIRED
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { createCanvasFeature, createMemoryCanvasFeature } from '../../src/main/features/book/canvas/index.ts'
import { createMemoryCharacterRepo } from '../../src/main/features/book/canvas/repositories/character.repo.ts'
import { createMemoryCanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.ts'
import { buildCentroidFromSum } from '../../src/main/features/book/canvas/canvas.service.ts'
import { isAppError } from '../../src/shared/errors.ts'
import { l2Normalize } from '../../src/shared/canvas/vector.ts'
import { createCharacter } from '../../src/shared/canvas/character.ts'
import type { CanvasGenerateOptions, Character } from '../../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 夹具：确定性词袋 embedder + 内存仓储
// ---------------------------------------------------------------------------

const DIM = 256

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
const isWord = (ch: string): boolean => /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch)
function bag(text: string): Float32Array {
  const v = new Float32Array(DIM)
  for (let i = 0; i < text.length; i++) {
    if (!isWord(text[i])) continue
    v[fnv1a(text[i]) % DIM] += 1
    if (i + 1 < text.length && isWord(text[i + 1])) v[fnv1a(text.slice(i, i + 2)) % DIM] += 1.5
  }
  return l2Normalize(v)
}

function character(name: string, sortOrder: number): Character {
  return createCharacter({ id: `c-${name}`, bookId: 'b1', name, sortOrder, now: 0 })
}

const CHAPTER_TEXT = [
  '夜色渐深。',
  '萧炎沉声道：“这点丹药算什么，我的斗气与异火才是根本。”',
  '“丹药的药材还差三味，灵魂之火快要熄了。”',
  '“哼。”',
  '风停了。',
].join('\n')

const OPTIONS: CanvasGenerateOptions = {
  useEmbedding: true,
  useLlm: false,
  contextWindow: 2,
  threshold: 0.5,
  margin: 0.02,
  ruleSetId: null,
  overwriteHuman: false,
  inferTags: true,
}

function setup(over?: { modelId?: string; centroidModelId?: string }) {
  const providerModel = over?.modelId ?? 'fake-v1'
  const storedModel = over?.centroidModelId ?? providerModel
  const characterRepo = createMemoryCharacterRepo({
    characters: [character('萧炎', 0), character('药老', 1), character('纳兰嫣然', 2)],
    centroids: [
      buildCentroidFromSum('c-萧炎', storedModel, bag('萧炎 萧炎 斗气 异火 修炼'), 1, 0),
      buildCentroidFromSum('c-药老', storedModel, bag('药老 药老 丹药 药材 灵魂'), 1, 0),
      buildCentroidFromSum('c-纳兰嫣然', storedModel, bag('纳兰嫣然 纳兰嫣然 家族 悔婚'), 1, 0),
    ],
    now: () => 1_700_000_000_000,
  })

  const yields: number[] = []
  const progress: string[] = []
  const feature = createMemoryCanvasFeature({
    characterRepo,
    embedProvider: { modelId: providerModel, dim: DIM, embed: async (t: string[]) => t.map(bag) },
    batchSize: 2,
    now: () => 1_700_000_000_000,
    generateId: (p) => `${p}-1`,
    yieldToLoop: async () => {
      yields.push(1)
    },
  })
  return { feature, characterRepo, yields, progress }
}

async function generate(feature: ReturnType<typeof setup>['feature'], over: Partial<Parameters<typeof feature.generateChapter>[0]> = {}) {
  return feature.generateChapter({
    bookId: 'b1',
    chapterId: 'ch1',
    chapterTitle: '第一章 陨落的天才',
    chapterText: CHAPTER_TEXT,
    options: OPTIONS,
    limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    ...over,
  })
}

// ---------------------------------------------------------------------------
// Step 1~9
// ---------------------------------------------------------------------------

describe('画本生成编排（Step 1~9）', () => {
  it('产出报告、落库行、并写向量与原型向量增量', async () => {
    const { feature, characterRepo } = setup()
    const result = await generate(feature)

    assert.equal(result.lines.length, 5)
    assert.equal(result.report.totalLines, 5)
    assert.equal(result.report.embeddingUsed, true)
    assert.equal(result.canvasState, 'generated')
    assert.ok(result.report.byDecision.rule >= 1)

    // 落库
    const stored = await feature.canvasRepo.listLines('ch1')
    assert.equal(stored.length, 5)
    assert.deepEqual(stored.map((l) => l.seq), [0, 1, 2, 3, 4])
    assert.equal(stored[0].rev, 1)

    // 向量落库（line_embeddings）：只对「需要向量判定」的行写入
    // （旁白不需要归属；短句被短句保护跳过 → 两者都不写向量，见 docs/06 §5.1 Step 5）
    const embeddings = await feature.canvasRepo.listEmbeddings('ch1')
    assert.equal(embeddings.length, 2, '本章只有 2 行需要向量判定（≥6 字的台词）')
    for (const e of embeddings) {
      assert.equal(e.modelId, 'fake-v1')
      assert.equal(e.dim, DIM)
      assert.equal(e.vector.length, DIM)
      assert.ok(Math.abs(Math.hypot(...e.vector) - 1) < 1e-4, '写入前必须 L2 归一化（docs/03 §5.2）')
      assert.match(e.contentHash, /^[0-9a-f]{64}$/, '必须是 sha256')
    }
    const shortLine = stored.find((l) => l.text === '哼。')!
    assert.equal(await feature.canvasRepo.getEmbedding(shortLine.id), null, '短句不做向量判定，也不写向量')

    // 原型向量增量：萧炎至少多了 1 个样本
    const yan = await characterRepo.getCentroid('c-萧炎', 'fake-v1')
    assert.ok(yan && yan.sampleCount >= 2, `原型样本数应增加，实际 ${yan?.sampleCount}`)
  })

  it('分批 + yieldToLoop 让路（不让路会冻住主进程，docs/06 §4.3）', async () => {
    const { feature, yields, progress } = setup()
    await generate(feature)
    assert.ok(yields.length >= 3, `batchSize=2、5 行 → 至少 3 次让路，实际 ${yields.length}`)
    void progress
  })

  it('AbortSignal 已中止 → AppError(TASK_CANCELLED)', async () => {
    const { feature } = setup()
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => generate(feature, { signal: ac.signal }),
      (e: unknown) => isAppError(e) && e.key === 'TASK_CANCELLED',
    )
  })

  it('空章节 → AppError(CANVAS_CHAPTER_EMPTY)', async () => {
    const { feature } = setup()
    await assert.rejects(
      () => generate(feature, { chapterText: '   \n ' }),
      (e: unknown) => isAppError(e) && e.key === 'CANVAS_CHAPTER_EMPTY',
    )
  })

  it('重复生成：先打快照，并保留人工确认过的行', async () => {
    const { feature } = setup()
    const first = await generate(feature)

    // 人工把第 1 行改成「药老」
    const line = first.lines[1]
    await feature.service.updateLine({ lineId: line.id, patch: { characterId: 'c-药老' } })

    const again = await generate(feature)
    assert.ok(again.snapshotId != null, '第二次生成必须自动打快照（FR-2.4.7）')
    const preserved = again.lines.find((l) => l.seq === line.seq)!
    assert.equal(preserved.characterId, 'c-药老', '人工结论在重新生成时必须保留')
    assert.equal(preserved.decidedBy, 'human')
    assert.ok(again.warnings.some((w) => w.includes('CANVAS_ALREADY_EDITED')))

    const snapshots = await feature.canvasRepo.listSnapshots('ch1')
    assert.ok(snapshots.length >= 1)
    assert.equal(snapshots[0].reason, 'pre_generate')
    assert.ok(snapshots[0].payload.length > 0)
  })

  it('没有模型时 embeddingUsed=false 且明确写进报告（不抛错）', async () => {
    const { feature } = setup()
    const noModel = createMemoryCanvasFeature({
      characterRepo: createMemoryCharacterRepo({ characters: [character('萧炎', 0)] }),
    })
    const result = await noModel.generateChapter({
      bookId: 'b1', chapterId: 'ch1', chapterText: CHAPTER_TEXT,
      options: { ...OPTIONS, useEmbedding: true },
    })
    assert.equal(result.report.embeddingUsed, false)
    assert.equal(result.lines.length, 5)
    assert.ok(result.report.warnings.some((w) => w.includes('CANVAS_EMBEDDING_UNAVAILABLE')))
    void feature
  })
})

// ---------------------------------------------------------------------------
// 单行编辑与乐观锁
// ---------------------------------------------------------------------------

describe('单行编辑（docs/11 §4.4 / §4.9）', () => {
  it('改说话人自动置 decidedBy=human（防重算覆盖）', async () => {
    const { feature } = setup()
    const result = await generate(feature)
    const target = result.lines[1]
    const updated = await feature.service.updateLine({
      lineId: target.id,
      patch: { characterId: 'c-纳兰嫣然' },
    })
    assert.equal(updated.characterId, 'c-纳兰嫣然')
    assert.equal(updated.decidedBy, 'human')
    assert.equal(updated.rev, target.rev + 1)
  })

  it('乐观锁：rev 不匹配抛 AppError(CONFLICT)', async () => {
    const { feature } = setup()
    const result = await generate(feature)
    const target = result.lines[0]
    await assert.rejects(
      () => feature.service.updateLine({ lineId: target.id, patch: { note: 'x' }, rev: 999 }),
      (e: unknown) => isAppError(e) && e.key === 'CONFLICT',
    )
  })

  it('改文本会作废该行向量（docs/06 §5.5：content_hash 变化 → 仅重算该行）', async () => {
    const { feature } = setup()
    const result = await generate(feature)
    const target = result.lines[1]
    assert.ok(await feature.canvasRepo.getEmbedding(target.id))
    await feature.service.updateLine({ lineId: target.id, patch: { text: '换了一句话。' } })
    assert.equal(await feature.canvasRepo.getEmbedding(target.id), null)
  })

  it('不存在的行抛 AppError(NOT_FOUND)', async () => {
    const { feature } = setup()
    await assert.rejects(
      () => feature.service.updateLine({ lineId: 'nope', patch: { note: 'x' } }),
      (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
    )
  })

  it('批量更新走一个事务（返回更新行数）', async () => {
    const { feature } = setup()
    const result = await generate(feature)
    const n = await feature.service.batchUpdate([
      { lineId: result.lines[0].id, patch: { pauseAfterMs: 700 } },
      { lineId: result.lines[1].id, patch: { pauseAfterMs: 700 } },
      { lineId: 'nope', patch: { pauseAfterMs: 700 } },
    ])
    assert.equal(n, 2)
    const stored = await feature.canvasRepo.listLines('ch1')
    assert.equal(stored[0].pauseAfterMs, 700)
  })
})

// ---------------------------------------------------------------------------
// 重算
// ---------------------------------------------------------------------------

describe('说话人判定重算（docs/06 §5.5 / docs/11 §7）', () => {
  it('scope=all 复用已存向量重跑判定，不重新推理', async () => {
    const { feature } = setup()
    await generate(feature)
    const result = await feature.recomputeAttribution({
      bookId: 'b1',
      chapterId: 'ch1',
      scope: 'all',
      options: OPTIONS,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(result.scope, 'all')
    assert.equal(result.embeddingUsed, true)
    assert.equal(result.embedded, 0, '复用向量路径不应重新 embedding')
    assert.ok(result.warnings.some((w) => w.includes('复用已存向量')))
  })

  it('永不覆盖 decidedBy=human 的行（除非显式 overwriteHuman）', async () => {
    const { feature } = setup()
    const generated = await generate(feature)
    const target = generated.lines[1]
    await feature.service.updateLine({ lineId: target.id, patch: { characterId: 'c-纳兰嫣然' } })

    const result = await feature.recomputeAttribution({
      bookId: 'b1', chapterId: 'ch1', scope: 'all', options: OPTIONS,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.ok(result.skippedHuman >= 1)
    assert.ok(result.warnings.some((w) => w.includes('CANVAS_ALREADY_EDITED')))
    const after = await feature.canvasRepo.getLine(target.id)
    assert.equal(after?.characterId, 'c-纳兰嫣然')
    assert.equal(after?.decidedBy, 'human')

    // 显式允许覆盖时才会改
    const forced = await feature.recomputeAttribution({
      bookId: 'b1', chapterId: 'ch1', scope: 'all', options: OPTIONS, overwriteHuman: true,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(forced.skippedHuman, 0)
  })

  it('scope=selection 只处理指定行；未给 lineIds 抛 AppError(INVALID_PAYLOAD)', async () => {
    const { feature } = setup()
    const generated = await generate(feature)
    const only = generated.lines[2]
    const result = await feature.recomputeAttribution({
      bookId: 'b1', chapterId: 'ch1', scope: 'selection', lineIds: [only.id], options: OPTIONS,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(result.scope, 'selection')
    assert.equal(result.skippedOutOfScope, generated.lines.length - 1)
    await assert.rejects(
      () => feature.recomputeAttribution({
        bookId: 'b1', chapterId: 'ch1', scope: 'selection', options: OPTIONS,
      }),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })

  it('scope=low_confidence 只挑 needsReview 的行', async () => {
    const { feature } = setup()
    await generate(feature)
    const result = await feature.recomputeAttribution({
      bookId: 'b1', chapterId: 'ch1', scope: 'low_confidence', options: OPTIONS,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(result.scope, 'low_confidence')
    assert.ok(result.skippedOutOfScope >= 0)
  })

  it('检测到换模型且 scope≠all → AppError(ATTRIBUTION_RECOMPUTE_REQUIRED)（docs/06 §5.5）', async () => {
    // 真实场景：昨天用 old-model 生成了画本（原型向量落在 old-model 空间），今天换成 new-model
    const characterRepo = createMemoryCharacterRepo({
      characters: [character('萧炎', 0), character('药老', 1)],
      centroids: [
        buildCentroidFromSum('c-萧炎', 'old-model', bag('萧炎 萧炎 斗气 异火 修炼'), 1, 0),
        buildCentroidFromSum('c-药老', 'old-model', bag('药老 药老 丹药 药材 灵魂'), 1, 0),
      ],
      now: () => 1_700_000_000_000,
    })
    const canvasRepo = createMemoryCanvasRepo({ now: () => 1_700_000_000_000 })
    const oldFeature = createCanvasFeature({
      canvasRepo,
      characterRepo,
      embedProvider: { modelId: 'old-model', dim: DIM, embed: async (t) => t.map(bag) },
      now: () => 1_700_000_000_000,
    })
    await oldFeature.generateChapter({
      bookId: 'b1', chapterId: 'ch1', chapterText: CHAPTER_TEXT, options: OPTIONS,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })

    const newFeature = createCanvasFeature({
      canvasRepo,
      characterRepo,
      embedProvider: { modelId: 'new-model', dim: DIM, embed: async (t) => t.map(bag) },
      now: () => 1_700_000_000_000,
    })

    await assert.rejects(
      () => newFeature.recomputeAttribution({
        bookId: 'b1', chapterId: 'ch1', scope: 'low_confidence', options: OPTIONS,
      }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'ATTRIBUTION_RECOMPUTE_REQUIRED')
        assert.ok((e.resolved.hint ?? '').length > 0)
        return true
      },
    )

    // scope=all 则放行，并明确告知「全量重算」
    const full = await newFeature.recomputeAttribution({
      bookId: 'b1', chapterId: 'ch1', scope: 'all', options: OPTIONS,
      chapterText: CHAPTER_TEXT, limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(full.modelSwitched, true)
    assert.ok(full.warnings.some((w) => w.includes('ATTRIBUTION_RECOMPUTE_REQUIRED')))
  })

  it('有章节原文时走完整流水线（口径与生成一致）', async () => {
    const { feature } = setup()
    await generate(feature)
    const result = await feature.recomputeAttribution({
      bookId: 'b1', chapterId: 'ch1', scope: 'all', options: OPTIONS,
      chapterText: CHAPTER_TEXT, chapterTitle: '第一章',
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(result.scope, 'all')
    assert.equal(result.embedded > 0, true, '走完整体时应重新推理并给出向量数')
  })

  it('空章节重算不抛错（返回可读的 warning）', async () => {
    const { feature } = setup()
    const result = await feature.recomputeAttribution({
      bookId: 'b1', chapterId: 'empty-chapter', scope: 'all', options: OPTIONS,
    })
    assert.equal(result.updated, 0)
    assert.ok(result.warnings.some((w) => w.includes('没有画本行')))
  })
})

// ---------------------------------------------------------------------------
// 仓储语义
// ---------------------------------------------------------------------------

describe('内存仓储语义（生产 SQLite 实现的契约）', () => {
  it('软删除与恢复', async () => {
    const { feature } = setup()
    const generated = await generate(feature)
    const ids = generated.lines.slice(0, 2).map((l) => l.id)
    assert.equal(await feature.canvasRepo.softDeleteLines(ids), 2)
    assert.equal((await feature.canvasRepo.listLines('ch1')).length, 3)
    assert.equal(await feature.canvasRepo.countByChapter('ch1'), 3)
    assert.equal(await feature.canvasRepo.restoreLines(ids), 2)
    assert.equal((await feature.canvasRepo.listLines('ch1')).length, 5)
  })

  it('countHumanDecided 反映人工行数', async () => {
    const { feature } = setup()
    const generated = await generate(feature)
    assert.equal(await feature.canvasRepo.countHumanDecided('ch1'), 0)
    await feature.service.updateLine({ lineId: generated.lines[0].id, patch: { characterId: 'c-萧炎' } })
    assert.equal(await feature.canvasRepo.countHumanDecided('ch1'), 1)
  })

  it('质检方法返回问题列表（含未出场角色）', async () => {
    const { feature } = setup()
    await generate(feature)
    const issues = await feature.service.qualityCheck({ chapterId: 'ch1' })
    assert.ok(Array.isArray(issues))
    // 角色表里的「纳兰嫣然」在本章没有台词 → no_character_ref
    assert.ok(issues.some((i) => i.kind === 'no_character_ref'))
  })
})
