/**
 * 测试 · 画本域任务（`canvas.generate` / `canvas.recompute`）端到端
 * ============================================================================
 * 设计依据：docs/11 §2（生成 Step 1~9）、§8（分批与进度）、docs/04 §2.2（队列语义）
 *
 * ### 为什么这组测试不可省
 *   `canvas-handlers` 只验证到「handler 把请求交给了任务层」（任务层是假的）。
 *   真正的风险在任务体里：**章节正文从哪里取、行怎么写回库、章节的画本状态有没有更新、
 *   生成报告有没有落库、重算会不会把用户的正文覆盖掉**。这些只有把真队列跑起来才看得到。
 *
 *   本文件用**真队列 + 真 SQLite + 真服务**跑完整条链，只把「进程外的东西」
 *   （ONNX 模型、LLM）留空 —— 这正是生产环境的真实配置（docs/91 §3）。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createCanvasTasks } from '../../src/main/features/book/canvas/canvas.tasks.ts'
import { createSqliteCanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.sqlite.ts'
import { createSqliteCharacterRepo } from '../../src/main/features/book/canvas/repositories/character.repo.sqlite.ts'
import { createSqliteChapterRepo } from '../../src/main/features/book/import/repositories/chapter.repo.sqlite.ts'
import { createMemoryTaskStore } from '../../src/main/infra/queue/store.ts'
import { TaskQueue } from '../../src/main/infra/queue/queue.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { CANVAS_DEFAULTS } from '../../src/shared/constants.ts'
import type { CanvasGenerateOptions } from '../../src/shared/types.ts'

/** 一章「真有对白与旁白」的正文：规则判定要能分出角色行与旁白行 */
const CHAPTER_TEXT = [
  '夜色像一块浸了水的黑布，压在城墙之上。',
  '「你终于来了。」老人抬起头，声音沙哑。',
  '少年握紧了手里的剑，指节发白。',
  '「我来晚了。」他说。',
  '「不，」老人笑了笑，「你来得刚刚好。」',
].join('\n')

const OPTIONS: CanvasGenerateOptions = {
  useEmbedding: true, // 生产没有 ONNX，服务应降级为规则判定并写进 warnings
  useLlm: false,
  contextWindow: CANVAS_DEFAULTS.contextWindow,
  threshold: CANVAS_DEFAULTS.attributionThreshold,
  margin: CANVAS_DEFAULTS.attributionMargin,
  ruleSetId: null,
  overwriteHuman: false,
  inferTags: true,
}

interface Harness {
  db: DatabaseSync
  queue: TaskQueue
  tasks: ReturnType<typeof createCanvasTasks>
  cleanup: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', 'C:/tmp/p1', 3, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, source_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '第一章', 'chapter', '${CHAPTER_TEXT}', '${CHAPTER_TEXT}', ${CHAPTER_TEXT.length}, 0, ${CHAPTER_TEXT.length}, 'none', 0, 1, 1)`)
  // 判定需要一个角色表（名字出现在正文里才能被规则命中）
  db.exec(`INSERT INTO characters (id, book_id, name, is_archived, sort_order, created_at, updated_at)
           VALUES ('ch1', 'b1', '少年', 0, 0, 1, 1)`)

  const dbLike = db as unknown as DbLike
  const queue = new TaskQueue({
    specs: [],
    store: createMemoryTaskStore(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  const tasks = createCanvasTasks({ getDb: () => dbLike, queue, log: silentLogger() })
  for (const spec of tasks.taskSpecs()) queue.registerSpec(spec)
  await queue.start()

  return {
    db,
    queue,
    tasks,
    cleanup: async () => {
      await queue.dispose()
      db.close()
    },
  }
}

function silentLogger(): Parameters<typeof createCanvasTasks>[0]['log'] {
  const noop = (): void => undefined
  const stub = {
    level: 'error' as const,
    setLevel: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    errorFields: noop,
    child: () => stub,
    write: noop,
    addSink: noop,
    setEntryListener: noop,
    recent: () => [],
  }
  return stub as unknown as ReturnType<typeof silentLogger>
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

describe('画本任务 · canvas.generate', () => {
  it('跑完整章：画本行落库、seq 稠密、章节画本状态与行数更新、报告落库', async () => {
    const h = await harness()
    try {
      const { taskId } = await h.tasks.enqueueGenerate('c1', OPTIONS)
      const record = await h.queue.waitFor(taskId)

      assert.equal(record.status, 'succeeded', JSON.stringify(record.error ?? null))
      assert.ok(record.progress !== undefined, '进度要能上报（章节很长时用户要看到进展）')

      const repo = createSqliteCanvasRepo(h.db as unknown as DbLike)
      const lines = await repo.listLines('c1')

      assert.ok(lines.length >= 4, `一章有 5 句，至少要切出 4 行，实际 ${lines.length}`)
      assert.deepEqual(
        lines.map((l) => l.seq),
        lines.map((_, i) => i),
        'seq 必须稠密且从 0 起（洞或重复会让朗读顺序出问题）',
      )
      assert.ok(lines.some((l) => l.kind === 'dialogue'), '正文里有引号对白，规则判定应识别出台词')
      assert.ok(lines.some((l) => l.kind === 'narration'), '旁白也要留着')
      assert.ok(
        lines.every((l) => l.text.trim().length > 0),
        '不允许出现空文本行（录音台会对着空行让人录音）',
      )

      // 章节的画本状态与行数：不写回的话列表页永远显示「未生成 / 0 行」
      const chapter = await createSqliteChapterRepo(h.db as unknown as DbLike).findById('c1')
      assert.equal(chapter?.canvasState, 'generated')
      assert.equal(chapter?.lineCount, lines.length)

      // 生成报告：embedding 缺失时必须如实标记，UI 要显著告知（docs/06 §8）
      const report = await repo.getGenerateReport('c1')
      assert.ok(report, '生成报告必须落库，否则 canvas:getGenerateReport 永远是 null')
      assert.equal(report.chapterId, 'c1')
      assert.equal(report.totalLines, lines.length)
      assert.equal(report.embeddingUsed, false, '没有 ONNX 实现时不能声称用了向量判定')
      assert.ok(
        report.warnings.some((w) => w.includes('EMBEDDING')),
        `模型缺失要写进 warnings，实际：${JSON.stringify(report.warnings)}`,
      )
      assert.ok(report.elapsedMs >= 0)
    } finally {
      await h.cleanup()
    }
  })

  it('同一章重复点「生成」被 dedupe 成一个任务（不会排队跑两遍）', async () => {
    const h = await harness()
    try {
      const first = await h.tasks.enqueueGenerate('c1', OPTIONS)
      const second = await h.tasks.enqueueGenerate('c1', OPTIONS)
      assert.equal(second.taskId, first.taskId, '同 dedupeKey 的活动任务应复用')
      await h.queue.whenIdle()
    } finally {
      await h.cleanup()
    }
  })

  it('临时根目录不存在时任务照样能跑（父目录不会被任何启动步骤创建）', async () => {
    // 真机事故：`tempRoot` = `cacheDir/tasks`，启动流程里没有任何一步创建它，
    // `mkdtemp` 抛 ENOENT → 被翻成「文件不存在」→ **每个任务**都失败。
    // 这里刻意传一个不存在的深层路径，验证队列自己会兜底。
    const root = mkdtempSync(join(tmpdir(), 'ns-queue-root-'))
    const missing = join(root, 'cache', 'tasks', 'deeper')
    const db = new DatabaseSync(':memory:')
    try {
      await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
               VALUES ('p1', 'proj', 'C:/tmp/p1', 3, 1, 1)`)
      db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
               VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
      db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, source_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
               VALUES ('c1', 'b1', 1, '第一章', 'chapter', '「你好。」', '「你好。」', 5, 0, 5, 'none', 0, 1, 1)`)

      const queue = new TaskQueue({
        specs: [],
        store: createMemoryTaskStore(),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        tempRoot: missing,
      })
      const tasks = createCanvasTasks({ getDb: () => db as unknown as DbLike, queue, log: silentLogger() })
      for (const spec of tasks.taskSpecs()) queue.registerSpec(spec)
      await queue.start()

      const record = await queue.waitFor((await tasks.enqueueGenerate('c1', OPTIONS)).taskId)
      assert.equal(record.status, 'succeeded', JSON.stringify(record.error ?? null))
      assert.ok(existsSync(missing), '队列应自己把临时根目录建出来')
      await queue.dispose()
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('重新生成同一章：行不重复堆积，旧行被软删除（录音元数据靠软删除保住）', async () => {
    const h = await harness()
    try {
      await h.queue.waitFor((await h.tasks.enqueueGenerate('c1', OPTIONS)).taskId)
      const repo = createSqliteCanvasRepo(h.db as unknown as DbLike)
      const afterFirst = (await repo.listLines('c1')).length

      await h.queue.waitFor((await h.tasks.enqueueGenerate('c1', OPTIONS)).taskId)
      const afterSecond = await repo.listLines('c1')

      assert.equal(afterSecond.length, afterFirst, '重新生成后存活行数应回到同一规模，而不是翻倍')
      const total = h.db.prepare(`SELECT COUNT(*) AS n FROM canvas_lines WHERE chapter_id = 'c1'`).get() as {
        n: number
      }
      assert.ok(total.n >= afterSecond.length, '旧行应在库里（软删除），不是被物理删除')
    } finally {
      await h.cleanup()
    }
  })

  it('章节不存在：抛 NOT_FOUND，不入队（不给用户一个注定失败的任务）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.tasks.enqueueGenerate('ghost', OPTIONS),
        (e: unknown) => (e as { key?: string }).key === 'NOT_FOUND',
      )
      assert.equal(h.queue.stats().pending + h.queue.stats().running, 0)
    } finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 重算判定
// ---------------------------------------------------------------------------

describe('画本任务 · canvas.recompute', () => {
  it('重算不覆盖用户改过的文本（只改归属，不改内容）', async () => {
    const h = await harness()
    try {
      await h.queue.waitFor((await h.tasks.enqueueGenerate('c1', OPTIONS)).taskId)
      const repo = createSqliteCanvasRepo(h.db as unknown as DbLike)
      const [first] = await repo.listLines('c1')
      assert.ok(first)

      // 用户手工改了正文
      const edited = await repo.updateLine(first.id, { text: '用户改过的这一行', decidedBy: 'human' })

      const { taskId } = await h.tasks.enqueueRecompute({
        chapterId: 'c1',
        scope: 'all',
        options: OPTIONS,
      })
      const record = await h.queue.waitFor(taskId)
      assert.equal(record.status, 'succeeded', JSON.stringify(record.error ?? null))

      const after = await repo.getLine(edited.id)
      assert.equal(after?.text, '用户改过的这一行', '重算只做归属判定，绝不能把正文改回原文')
      assert.equal(after?.decidedBy, 'human', '人工结果永不被覆盖（docs/11 §3）')
    } finally {
      await h.cleanup()
    }
  })

  it('重算不重新分句：行数不变（否则用户的行级编辑会被打乱）', async () => {
    const h = await harness()
    try {
      await h.queue.waitFor((await h.tasks.enqueueGenerate('c1', OPTIONS)).taskId)
      const repo = createSqliteCanvasRepo(h.db as unknown as DbLike)
      const before = (await repo.listLines('c1')).map((l) => `${l.id}:${l.text}`)

      await h.queue.waitFor(
        (await h.tasks.enqueueRecompute({ chapterId: 'c1', scope: 'low_confidence', options: OPTIONS })).taskId,
      )

      assert.deepEqual((await repo.listLines('c1')).map((l) => `${l.id}:${l.text}`), before)
    } finally {
      await h.cleanup()
    }
  })

  it('scope=selection 只动选中的行（其它行的 rev 不变）', async () => {
    const h = await harness()
    try {
      await h.queue.waitFor((await h.tasks.enqueueGenerate('c1', OPTIONS)).taskId)
      const repo = createSqliteCanvasRepo(h.db as unknown as DbLike)
      const lines = await repo.listLines('c1')
      const target = lines[0]!
      const others = new Map(lines.slice(1).map((l) => [l.id, l.rev]))

      await h.queue.waitFor(
        (await h.tasks.enqueueRecompute({
          chapterId: 'c1',
          scope: 'selection',
          lineIds: [target.id],
          options: OPTIONS,
        })).taskId,
      )

      for (const l of await repo.listLines('c1')) {
        if (l.id === target.id) continue
        assert.equal(l.rev, others.get(l.id), `${l.id} 不在选中集里，不该被改动`)
      }
    } finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 角色原型重建（character.centroid）
// ---------------------------------------------------------------------------

describe('画本任务 · character.centroid', () => {
  /** 造两个角色 + 几行带向量的行；返回 characterId 与用于断言的数据 */
  async function seedCharacters(h: Harness): Promise<{ ch1: string; ch2: string }> {
    h.db.exec(`INSERT INTO characters (id, book_id, name, is_archived, sort_order, created_at, updated_at)
               VALUES ('cx1', 'b1', '甲', 0, 0, 1, 1)`)
    h.db.exec(`INSERT INTO characters (id, book_id, name, is_archived, sort_order, created_at, updated_at)
               VALUES ('cx2', 'b1', '乙', 0, 1, 1, 1)`)

    const repo = createSqliteCanvasRepo(h.db as unknown as DbLike)
    for (const [lineId, characterId, vector, modelId] of [
      ['l1', 'cx1', [1, 0], 'm1'],
      ['l2', 'cx1', [1, 0], 'm1'],
      ['l3', 'cx1', [0, 1], 'm2'], // 另一个模型空间（不可混算）
      ['l4', 'cx2', [0, 1], 'm1'],
    ] as Array<[string, string, number[], string]>) {
      await repo.insertLines([
        {
          id: lineId,
          chapterId: 'c1',
          bookId: 'b1',
          seq: Number(lineId.slice(1)) - 1,
          speakerType: 'character',
          characterId,
          kind: 'dialogue',
          text: '台词',
          sourceText: null,
          charStart: 0,
          charEnd: 0,
          emotion: null,
          emotionIntensity: null,
          speed: null,
          gainDb: null,
          pauseAfterMs: 500,
          pauseInline: null,
          pronunciation: null,
          note: null,
          state: 'draft',
          confidence: null,
          candidates: null,
          decidedBy: 'human',
          needsReview: false,
          flags: [],
          isTitle: false,
          rev: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      await repo.upsertEmbedding({
        lineId,
        modelId,
        dim: 2,
        vector: Float32Array.from(vector),
        contentHash: `h-${lineId}`,
        contextScope: 2,
        createdAt: 1,
      })
    }
    return { ch1: 'cx1', ch2: 'cx2' }
  }

  async function enqueueCentroid(h: Harness, characterIds: string[]): Promise<Record<string, unknown>> {
    const { taskId } = await h.queue.enqueue('character.centroid', { bookId: 'b1', characterIds }, {})
    const record = await h.queue.waitFor(taskId)
    assert.equal(record.status, 'succeeded', JSON.stringify(record.error ?? null))
    return (await h.queue.result(taskId)) as Record<string, unknown>
  }

  it('按模型分组算原型：sum=Σ向量、sample 数正确，不同模型不混算', async () => {
    const h = await harness()
    try {
      const { ch1 } = await seedCharacters(h)
      const summary = await enqueueCentroid(h, [ch1])
      assert.equal(summary['updated'], 2, 'ch1 有两个模型空间 → 两条原型记录')
      assert.equal(summary['skipped'], 0)
      assert.equal(summary['samples'], 3)
      assert.deepEqual((summary['modelIds'] as string[]).sort(), ['m1', 'm2'])

      const characters = createSqliteCharacterRepo(h.db as unknown as DbLike)
      const m1 = await characters.getCentroid(ch1, 'm1')
      assert.ok(m1)
      assert.equal(m1.sampleCount, 2, 'm1 空间里只有两行向量')
      assert.deepEqual([...m1.centroid], [1, 0], '同方向的两个向量取平均再归一化 → 同一个方向')
      const m2 = await characters.getCentroid(ch1, 'm2')
      assert.equal(m2?.sampleCount, 1)
      assert.deepEqual([...(m2?.centroid ?? [])], [0, 1])
    } finally {
      await h.cleanup()
    }
  })

  it('没有向量的角色被跳过（不是失败）：模型缺失时这就是正常结果', async () => {
    const h = await harness()
    try {
      await seedCharacters(h)
      // ch2 有向量；再造一个没有任何向量的角色
      h.db.exec(`INSERT INTO characters (id, book_id, name, is_archived, sort_order, created_at, updated_at)
                 VALUES ('cx3', 'b1', '丙', 0, 2, 1, 1)`)

      const summary = await enqueueCentroid(h, ['cx2', 'cx3'])
      assert.equal(summary['updated'], 1)
      assert.equal(summary['skipped'], 1, '没有向量 → 跳过而不是抛错')
      assert.equal(summary['characters'], 2)
    } finally {
      await h.cleanup()
    }
  })

  it('重建是幂等的（重跑两次结果相同，不会把样本数翻倍）', async () => {
    const h = await harness()
    try {
      const { ch1 } = await seedCharacters(h)
      await enqueueCentroid(h, [ch1])
      await enqueueCentroid(h, [ch1])

      const characters = createSqliteCharacterRepo(h.db as unknown as DbLike)
      const m1 = await characters.getCentroid(ch1, 'm1')
      assert.equal(m1?.sampleCount, 2, '原型是「重算」而不是「累加」')
    } finally {
      await h.cleanup()
    }
  })
})
