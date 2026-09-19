/**
 * 画本域 IPC handler 测试（真库 + 真仓储 + 真服务，只把「任务队列」换成假的）
 * ============================================================================
 * 设计依据：docs/20 §4.3（canvas 通道清单）、docs/11 §4~§8、docs/01 §10 第 10 步
 *
 * ### 为什么这一层必须单独测
 *   画本域的业务逻辑（`canvas.service` / `attribution.service`）已有测试，
 *   但 handler 层做的是**编排**：取正文、合成选项、转任务、写文件、算分页。
 *   这些判断在服务层测试里**完全覆盖不到**，而且错了也不报错 —— 只会静默丢行、
 *   静默改错范围、静默把文件写到别处。所以这里用真 SQLite（`:memory:`）把
 *   从「一行 JSON 载荷」到「库里/盘上的真实结果」整条路走通。
 *
 * ### 用真库而不是内存仓储的理由
 *   `canvas_lines` 有 29 列、外键、CHECK 约束与 `deleted_at` 软删除语义。
 *   内存实现「碰巧通过」的地方（例如主键冲突、seq 让位）正是真机会炸的地方
 *   （docs/91 §5.2.8 记过同类事故）。这里只把任务队列换成假实现，因为它需要 Electron 之外的运行时。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import { CANVAS_DEFAULTS } from '../../src/shared/constants.ts'
import { IPC_CHANNELS } from '../../src/shared/ipc.ts'
import type { CanvasGenerateOptions, CanvasLine, Id } from '../../src/shared/types.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createSqliteChapterRepo } from '../../src/main/features/book/import/repositories/chapter.repo.sqlite.ts'
import { createSqliteCanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.sqlite.ts'
import { createSqliteCharacterRepo } from '../../src/main/features/book/canvas/repositories/character.repo.sqlite.ts'
import { createCanvasFeature } from '../../src/main/features/book/canvas/index.ts'
import type { CanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.ts'
import type { CanvasTasks } from '../../src/main/features/book/canvas/canvas.tasks.ts'
import {
  CANVAS_CHANNELS,
  createCanvasHandlers,
  type CanvasHandlerDeps,
} from '../../src/main/ipc/handlers/canvas.ts'
import type { RegisteredHandler } from '../../src/main/ipc/handlers/deps.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'

// ---------------------------------------------------------------------------
// 测试台
// ---------------------------------------------------------------------------

interface Enqueued {
  generate: Array<{ chapterId: Id; options: CanvasGenerateOptions }>
  recompute: Array<Parameters<CanvasTasks['enqueueRecompute']>[0]>
}

interface Harness {
  db: DatabaseSync
  repo: CanvasRepo
  handlers: RegisteredHandler[]
  enqueued: Enqueued
  logs: Array<{ level: 'info' | 'warn'; event: string; fields?: Record<string, unknown> }>
  exportDir: string
  cleanup: () => Promise<void>
}

/** 章节标题刻意带非法文件名字符：导出文本要能把它洗干净 */
const TITLE = '第1章/开始*?'

type CanvasSettingsShape = ReturnType<CanvasHandlerDeps['canvasSettings']>

async function harness(over?: { canvas?: Partial<CanvasSettingsShape> }): Promise<Harness> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', 'C:/tmp/p1', 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '${TITLE}', 'chapter', '正文', 2, 0, 2, 'none', 0, 1, 1)`)
  db.exec(`INSERT INTO characters (id, book_id, name, is_archived, sort_order, created_at, updated_at)
           VALUES ('ch1', 'b1', '张三', 0, 0, 1, 1)`)

  const dbLike = db as unknown as DbLike
  const repo = createSqliteCanvasRepo(dbLike)
  const enqueued: Enqueued = { generate: [], recompute: [] }
  const logs: Harness['logs'] = []
  const dir = await mkdtemp(join(tmpdir(), 'ns-canvas-'))

  const canvasSettings = { ...CANVAS_DEFAULTS, ...(over?.canvas ?? {}) }

  const deps: CanvasHandlerDeps = {
    ctx: () => ({
      feature: createCanvasFeature({
        canvasRepo: repo,
        characterRepo: createSqliteCharacterRepo(dbLike),
        embedProvider: null,
        llmReviewer: null,
      }),
      canvasRepo: repo,
      chapters: createSqliteChapterRepo(dbLike),
    }),
    tasks: {
      enqueueGenerate: async (chapterId, options) => {
        enqueued.generate.push({ chapterId, options })
        return { taskId: 'task-gen-1' }
      },
      enqueueRecompute: async (payload) => {
        enqueued.recompute.push(payload)
        return { taskId: 'task-rc-1' }
      },
      taskSpecs: () => [],
    },
    canvasSettings: () => canvasSettings,
    exportDir: () => dir,
    log: {
      info: (event, fields) => logs.push(fields === undefined ? { level: 'info', event } : { level: 'info', event, fields }),
      warn: (event, fields) => logs.push(fields === undefined ? { level: 'warn', event } : { level: 'warn', event, fields }),
    },
  }

  return {
    db,
    repo,
    handlers: createCanvasHandlers(deps),
    enqueued,
    logs,
    exportDir: dir,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 像真实注册器那样调用通道：**先过契约 schema**（`IPC_REQ_SCHEMAS`），再进 handler。
 * 直接用 handler 自己的 `schema` 是错的 —— 域 handler 用 `h(channel, run)` 注册时
 * 那个 schema 是**透传**的，真正的校验在注册器里按通道覆写（见 `ipc/index.ts` 注释）。
 */
async function call(h: Harness, channel: string, payload: unknown): Promise<unknown> {
  const spec = h.handlers.find((x) => x.channel === channel)
  assert.ok(spec, `未找到通道的 handler：${channel}`)
  const schema = schemaFor(channel)
  assert.ok(schema, `契约里没有这个通道的 schema：${channel}`)
  const parsed = schema.parse(payload)
  return await spec.run(parsed as never, {} as never)
}

/** 直接往库里塞行（跳过 handler，用于准备场景） */
async function seedLines(repo: CanvasRepo, lines: Array<Partial<CanvasLine> & { id: string; seq: number }>) {
  const full: CanvasLine[] = lines.map((l) => ({
    chapterId: 'c1',
    bookId: 'b1',
    speakerType: 'narration',
    characterId: null,
    kind: 'narration',
    text: '占位',
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
    decidedBy: null,
    needsReview: false,
    flags: [],
    isTitle: false,
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
    ...l,
  }))
  await repo.insertLines(full)
}

// ---------------------------------------------------------------------------
// 契约与自检
// ---------------------------------------------------------------------------

describe('画本域 handler · 契约面', () => {
  it('CANVAS_CHANNELS 与实际返回的 handler 一一对应', async () => {
    const h = await harness()
    try {
      assert.deepEqual(
        [...CANVAS_CHANNELS].sort(),
        h.handlers.map((x) => x.channel).sort(),
        '导出的通道清单必须与真实注册的 handler 完全一致（少一个就会变成「占位 NOT_IMPLEMENTED」）',
      )
      assert.equal(new Set(CANVAS_CHANNELS).size, CANVAS_CHANNELS.length, '不能重复登记')
    } finally {
      await h.cleanup()
    }
  })

  it('每个通道都在 IPC 契约里，且都带 schema', async () => {
    const h = await harness()
    try {
      for (const c of CANVAS_CHANNELS) {
        assert.ok((IPC_CHANNELS as readonly string[]).includes(c), `${c} 不在契约里`)
        assert.ok(schemaFor(c), `${c} 没有请求 schema`)
      }
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:getGenerateReport 已实现（12 个通道，报告有落库位置）', async () => {
    const h = await harness()
    try {
      assert.equal(CANVAS_CHANNELS.length, 12)
      assert.ok(CANVAS_CHANNELS.includes('canvas:getGenerateReport'))
      assert.ok(h.handlers.some((x) => x.channel === 'canvas:getGenerateReport'))
    } finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

describe('画本域 handler · 读取与筛选', () => {
  it('canvas:getChapter 省略 limit 时返回全部（待确认队列就是这种调用）', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [
        { id: 'l0', seq: 0, needsReview: true },
        { id: 'l1', seq: 1, needsReview: false },
        { id: 'l2', seq: 2, needsReview: true },
      ])

      const res = (await call(h, 'canvas:getChapter', { chapterId: 'c1' })) as { lines: CanvasLine[]; total: number }
      assert.equal(res.lines.length, 3, '不给 limit 就是「全部」，静默截断会让超过阈值的章节丢行')
      assert.equal(res.total, 3)
      assert.deepEqual(res.lines.map((l) => l.seq), [0, 1, 2], '必须按 seq 升序')
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:getChapter 的 total 是**筛选后**的数量（渲染侧用它判断翻页结束）', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [
        { id: 'l0', seq: 0, needsReview: true },
        { id: 'l1', seq: 1, needsReview: false },
        { id: 'l2', seq: 2, needsReview: true },
      ])

      const res = (await call(h, 'canvas:getChapter', {
        chapterId: 'c1',
        filter: { needsReview: true },
        limit: 1,
      })) as { lines: CanvasLine[]; total: number }

      assert.equal(res.total, 2, 'total 若给成未筛选的总数，渲染侧会多翻一页空页/或提前停止')
      assert.deepEqual(res.lines.map((l) => l.id), ['l0'])
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:getChapter 支持 limit/offset 分页与 characterId=null（未分配）', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [
        { id: 'l0', seq: 0, characterId: null },
        { id: 'l1', seq: 1, characterId: 'ch1', speakerType: 'character', kind: 'dialogue' },
        { id: 'l2', seq: 2, characterId: 'ch1', speakerType: 'character', kind: 'dialogue' },
      ])

      const page = (await call(h, 'canvas:getChapter', { chapterId: 'c1', offset: 1, limit: 1 })) as {
        lines: CanvasLine[]
      }
      assert.deepEqual(page.lines.map((l) => l.id), ['l1'])

      const unassigned = (await call(h, 'canvas:getChapter', {
        chapterId: 'c1',
        filter: { characterId: null },
      })) as { lines: CanvasLine[]; total: number }
      assert.deepEqual(unassigned.lines.map((l) => l.id), ['l0'], 'characterId:null 的语义是「未分配」')
      assert.equal(unassigned.total, 1)
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:getLine 行不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => call(h, 'canvas:getLine', { lineId: 'ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:getGenerateReport：从未生成 → null；生成过 → 完整报告；章节不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      // 从未生成：返回 null 而不是抛错 —— 渲染侧 loadReport() 直接调用它，
      // 抛错会被错误总线弹成 toast（打开画本编辑器就报「功能未提供」）
      assert.equal(await call(h, 'canvas:getGenerateReport', { chapterId: 'c1' }), null)

      const report = {
        chapterId: 'c1',
        totalLines: 3,
        byKind: { dialogue: 2, narration: 1, inner: 0, sfx_note: 0 },
        bySpeaker: [{ characterId: 'ch1', name: '张三', lines: 2, chars: 12 }],
        byDecision: { rule: 2, vector: 1, llm: 0, human: 0 },
        lowConfidence: 1,
        unmatchedQuote: 0,
        tooLong: 0,
        elapsedMs: 42,
        embeddingUsed: false,
        llmUsed: false,
        warnings: ['CANVAS_EMBEDDING_UNAVAILABLE'],
      }
      await h.repo.saveGenerateReport(report)

      assert.deepEqual(await call(h, 'canvas:getGenerateReport', { chapterId: 'c1' }), report)
      await assert.rejects(
        () => call(h, 'canvas:getGenerateReport', { chapterId: 'ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

describe('画本域 handler · 写与乐观锁', () => {
  it('canvas:updateLine 改了说话人 → 自动置 decidedBy=human；rev 不匹配 → CONFLICT', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [{ id: 'l0', seq: 0, text: '「你好。」' }])

      const updated = (await call(h, 'canvas:updateLine', {
        lineId: 'l0',
        patch: { characterId: 'ch1', speakerType: 'character', kind: 'dialogue' },
        rev: 1,
      })) as CanvasLine
      assert.equal(updated.decidedBy, 'human', '人工改过判定字段就必须记名，否则会被自动判定覆盖')
      assert.equal(updated.rev, 2)

      await assert.rejects(
        () => call(h, 'canvas:updateLine', { lineId: 'l0', patch: { text: '再来' }, rev: 1 }),
        (e: unknown) => e instanceof AppError && e.key === 'CONFLICT',
        '旧 rev 必须被挡住，否则两人同时改会静默丢改动',
      )
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:updateLine 只改备注时：不得清空正文、不得记成人工确认、不作废向量', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [{ id: 'l0', seq: 0, text: '原正文', kind: 'narration', decidedBy: 'rule' }])
      await h.repo.upsertEmbedding({
        lineId: 'l0',
        modelId: 'm',
        dim: 2,
        vector: Float32Array.from([1, 0]),
        contentHash: 'h',
        contextScope: 2,
        createdAt: 1,
      })

      // 载荷只给了 note —— 但校验器会把其余可选键物化成 undefined（见 patch-undefined.test.ts）
      const updated = (await call(h, 'canvas:updateLine', { lineId: 'l0', patch: { note: '只改备注' } })) as CanvasLine

      assert.equal(updated.note, '只改备注')
      assert.equal(updated.text, '原正文', '未给出的字段被写成 NULL/undefined 就是静默数据损坏')
      assert.equal(updated.kind, 'narration')
      assert.equal(updated.decidedBy, 'rule', '只改备注不该把行记成人工确认（判定字段没动）')
      assert.ok(await h.repo.getEmbedding('l0'), '文本没变就不该作废该行向量（docs/06 §5.5）')
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:batchUpdate 不给 lineIds 直接拒绝（契约缺 chapterId，猜范围会改到用户没选的行）', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [{ id: 'l0', seq: 0 }, { id: 'l1', seq: 1 }])

      await assert.rejects(
        () => call(h, 'canvas:batchUpdate', { patch: { note: 'x' } }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )

      const ok = (await call(h, 'canvas:batchUpdate', {
        lineIds: ['l0', 'l1'],
        patch: { note: '批量' },
      })) as { updated: number }
      assert.equal(ok.updated, 2)
      const lines = await h.repo.listLines('c1')
      assert.deepEqual(lines.map((l) => l.note), ['批量', '批量'])
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:deleteLine 是软删除：列表里没了，但行还在库里（录音元数据靠 CASCADE 挂着）', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [{ id: 'l0', seq: 0 }, { id: 'l1', seq: 1 }])

      const res = (await call(h, 'canvas:deleteLine', { lineId: 'l0' })) as { ok: boolean }
      assert.equal(res.ok, true)
      assert.deepEqual((await h.repo.listLines('c1')).map((l) => l.id), ['l1'])

      const row = h.db.prepare(`SELECT deleted_at FROM canvas_lines WHERE id = 'l0'`).get() as {
        deleted_at: number | null
      }
      assert.ok(row, '物理删了行 → 指向它的 takes/voice_segments 会被 CASCADE 一起销毁')
      assert.notEqual(row.deleted_at, null, '必须是软删除（deleted_at 有值）')

      // 再删一次：已经不存活 → ok=false（不是报错）
      assert.deepEqual(await call(h, 'canvas:deleteLine', { lineId: 'l0' }), { ok: false })
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:insertLines 在章中间插入：只有插入点之后的行让位，新行落在中间', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [
        { id: 'a', seq: 0, text: '甲' },
        { id: 'b', seq: 1, text: '乙' },
        { id: 'c', seq: 2, text: '丙' },
      ])

      const created = (await call(h, 'canvas:insertLines', {
        chapterId: 'c1',
        afterSeq: 1,
        text: '新增一\n新增二',
        characterId: 'ch1',
      })) as CanvasLine[]

      assert.equal(created.length, 2, '按换行拆成两行')
      assert.deepEqual(created.map((l) => l.seq), [2, 3])
      assert.deepEqual(created.map((l) => l.text), ['新增一', '新增二'])
      assert.equal(created[0]?.characterId, 'ch1')
      assert.equal(created[0]?.speakerType, 'character')
      assert.equal(created[0]?.kind, 'dialogue')
      assert.equal(created[0]?.decidedBy, 'human', '人工插入的行不该再被自动判定覆盖')
      assert.equal(created[0]?.needsReview, false)

      const all = await h.repo.listLines('c1')
      assert.deepEqual(
        all.map((l) => `${l.id}:${l.seq}`),
        ['a:0', 'b:1', created[0]!.id + ':2', created[1]!.id + ':3', 'c:4'],
        'seq 必须仍然严格递增（同 seq 会让朗读顺序静默错乱）',
      )
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:insertLines 空白文本 → INVALID_PAYLOAD；章节不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => call(h, 'canvas:insertLines', { chapterId: 'c1', afterSeq: 0, text: '   \n  \n' }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => call(h, 'canvas:insertLines', { chapterId: 'ghost', afterSeq: 0, text: '甲' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 质检 / 快照 / 导出
// ---------------------------------------------------------------------------

describe('画本域 handler · 质检、快照与导出', () => {
  it('canvas:qualityCheck 用设置里的阈值（too_long 能被抓住）', async () => {
    const h = await harness({ canvas: { maxLineChars: 5 } })
    try {
      await seedLines(h.repo, [
        { id: 'long', seq: 0, text: '这是一句特别长的旁白内容' },
        { id: 'ok', seq: 1, text: '短句' },
      ])

      const issues = (await call(h, 'canvas:qualityCheck', { chapterId: 'c1' })) as Array<{
        kind: string
        lineId: string | null
      }>
      assert.ok(Array.isArray(issues))
      assert.ok(
        issues.some((i) => i.kind === 'too_long' && i.lineId === 'long'),
        `阈值没生效：${JSON.stringify(issues)}`,
      )
      assert.ok(!issues.some((i) => i.lineId === 'ok'))
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:snapshotCreate：reason 走白名单；payload 是当时的存活行', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [{ id: 'a', seq: 0 }, { id: 'b', seq: 1 }])

      const res = (await call(h, 'canvas:snapshotCreate', {
        chapterId: 'c1',
        label: '生成前',
        reason: 'not-a-reason',
      })) as { snapshotId: Id }

      const snap = await h.repo.getSnapshot(res.snapshotId)
      assert.ok(snap)
      assert.equal(snap.reason, 'manual', '非法 reason 不该原样落库（reason 有 CHECK 约束）')
      assert.equal(snap.label, '生成前')
      assert.deepEqual(snap.payload.map((l) => l.id), ['a', 'b'])

      // 白名单内的值原样保留
      const ok = (await call(h, 'canvas:snapshotCreate', { chapterId: 'c1', reason: 'pre_generate' })) as {
        snapshotId: Id
      }
      assert.equal((await h.repo.getSnapshot(ok.snapshotId))?.reason, 'pre_generate')
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:exportText：三种格式都能落盘，默认文件名把非法字符洗干净', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [
        { id: 'a', seq: 0, text: '甲', pauseAfterMs: 300 },
        { id: 'b', seq: 1, text: '带"引号"的乙', characterId: 'ch1', speakerType: 'character', kind: 'dialogue' },
      ])

      // 默认路径：exportDir + 章节标题（标题里有 / * ? 三个非法字符）
      const txt = (await call(h, 'canvas:exportText', { chapterId: 'c1', format: 'txt' })) as { path: string }
      assert.ok(txt.path.startsWith(h.exportDir), `默认目录应取设置里的导出位置，实际：${txt.path}`)
      assert.ok(!/[\\/:*?"<>|]/.test(basename(txt.path)), `文件名没洗干净：${txt.path}`)
      assert.ok(basename(txt.path).includes('第1章_开始'), `文件名应基于章节标题：${basename(txt.path)}`)
      const txtBody = await readFile(txt.path, 'utf8')
      assert.deepEqual(txtBody.split('\n'), ['甲', '带"引号"的乙'], 'txt 只输出要录的文本')

      const csv = (await call(h, 'canvas:exportText', {
        chapterId: 'c1',
        format: 'csv',
        outPath: join(h.exportDir, 'out.csv'),
      })) as { path: string }
      const csvBody = await readFile(csv.path, 'utf8')
      assert.equal(csvBody.split('\r\n')[0], 'seq,speaker,kind,text,emotion,pauseAfterMs')
      assert.ok(csvBody.includes('"带""引号""的乙"'), 'CSV 内部引号必须转义成两个引号')

      const json = (await call(h, 'canvas:exportText', {
        chapterId: 'c1',
        format: 'json',
        outPath: join(h.exportDir, 'out.json'),
      })) as { path: string }
      const parsed = JSON.parse(await readFile(json.path, 'utf8')) as CanvasLine[]
      assert.deepEqual(parsed.map((l) => l.id), ['a', 'b'])

      assert.ok(h.logs.some((l) => l.event === 'canvas.exportedText' && l.level === 'info'))
    } finally {
      await h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 两个走队列的通道
// ---------------------------------------------------------------------------

const OPTIONS: CanvasGenerateOptions = {
  useEmbedding: true,
  useLlm: false,
  contextWindow: 2,
  threshold: 0.62,
  margin: 0.06,
  ruleSetId: null,
  overwriteHuman: false,
  inferTags: true,
}

describe('画本域 handler · 任务通道', () => {
  it('canvas:generate 把请求原样交给任务层，并按人工修改情况告警', async () => {
    const h = await harness()
    try {
      await seedLines(h.repo, [{ id: 'a', seq: 0, decidedBy: 'human' }])

      const res = (await call(h, 'canvas:generate', { chapterId: 'c1', options: OPTIONS })) as { taskId: Id }
      assert.equal(res.taskId, 'task-gen-1')
      assert.deepEqual(h.enqueued.generate, [{ chapterId: 'c1', options: OPTIONS }])
      assert.ok(
        h.logs.some((l) => l.event === 'canvas.generate.humanLines' && l.level === 'warn'),
        '本章已有人工修改时必须留下痕迹（生成会替换整章行）',
      )
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:generate 章节不存在 → NOT_FOUND，且**不入队**（避免排一个注定失败的任务）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => call(h, 'canvas:generate', { chapterId: 'ghost', options: OPTIONS }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
      assert.deepEqual(h.enqueued.generate, [])
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:recomputeAttribution：selection 缺 lineIds 直接拒绝；正常路径合成规则判定选项', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => call(h, 'canvas:recomputeAttribution', { chapterId: 'c1', scope: 'selection' }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )

      const res = (await call(h, 'canvas:recomputeAttribution', {
        chapterId: 'c1',
        scope: 'selection',
        lineIds: ['a'],
      })) as { taskId: Id }
      assert.equal(res.taskId, 'task-rc-1')

      const [payload] = h.enqueued.recompute
      assert.ok(payload)
      assert.equal(payload.chapterId, 'c1')
      assert.equal(payload.scope, 'selection')
      assert.deepEqual(payload.lineIds, ['a'])
      assert.equal(payload.options.useEmbedding, false, '生产没有 ONNX 实现，传 true 只会得到「不可用」警告')
      assert.equal(payload.options.useLlm, false)
      assert.equal(payload.options.overwriteHuman, false, '契约没有这个字段 → 默认「人工结果永不覆盖」')
      assert.equal(payload.options.threshold, CANVAS_DEFAULTS.attributionThreshold, '阈值来自 settings.canvas')
      assert.equal(payload.options.margin, CANVAS_DEFAULTS.attributionMargin)
      assert.equal(payload.options.contextWindow, CANVAS_DEFAULTS.contextWindow)
    } finally {
      await h.cleanup()
    }
  })

  it('canvas:recomputeAttribution 阈值取设置而不是常量', async () => {
    const h = await harness({ canvas: { attributionThreshold: 0.9, attributionMargin: 0.2, contextWindow: 5 } })
    try {
      await call(h, 'canvas:recomputeAttribution', { chapterId: 'c1', scope: 'all' })
      const [payload] = h.enqueued.recompute
      assert.equal(payload?.options.threshold, 0.9)
      assert.equal(payload?.options.margin, 0.2)
      assert.equal(payload?.options.contextWindow, 5)
    } finally {
      await h.cleanup()
    }
  })
})
