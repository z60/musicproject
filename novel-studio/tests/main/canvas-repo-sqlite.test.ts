/**
 * 画本行仓储（SQLite）· 往返与**行为一致性**
 * ============================================================================
 * 两件事一起测：
 *   ① **列映射往返**：`canvas_lines` 29 列、`line_embeddings` 的 BLOB 向量、
 *      `canvas_snapshots` 的 gzip payload —— 写进去再读回来逐字段比。
 *      列序错位、JSON 漏序列化、Float32 字节序/对齐搞错，**都不会报错**，只会把数据写歪。
 *   ② **与内存实现行为一致**：`canvas.repo.ts` 的接口注释写着「内存实现是行为基准，
 *      生产实现不引入第二套行为」。所以同一串操作分别跑在内存版与 SQLite 版上，
 *      断言两者结果相同 —— 这比逐条抄断言更能抓出「两边语义漂移」。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createMemoryCanvasRepo, type CanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.ts'
import { createSqliteCanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.sqlite.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { CanvasLine, CanvasGenerateReport } from '../../src/shared/types.ts'

async function sqliteRepo(): Promise<{ repo: CanvasRepo; db: DatabaseSync }> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', 'C:/tmp/p1', 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 2, 1, 1)`)
  for (const id of ['c1', 'c2']) {
    db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
             VALUES ('${id}', 'b1', ${id === 'c1' ? 1 : 2}, '章', 'chapter', '正文', 2, 0, 2, 'none', 0, 1, 1)`)
  }
  // 画本行的 `character_id` 是外键（ON DELETE SET NULL）——样例行用了角色 id，
  // 所以库里必须先有角色，否则 INSERT 会被 FK 拦住（真机上也会这样，这是好事）
  db.exec(`INSERT INTO characters (id, book_id, name, is_archived, sort_order, created_at, updated_at)
           VALUES ('ch1', 'b1', '张三', 0, 0, 1, 1)`)
  return { repo: createSqliteCanvasRepo(db as unknown as DbLike), db }
}

/** 一行「所有字段都非默认值」——任何列错位都会在往返里暴露 */
const sampleLine = (over: Partial<CanvasLine> = {}): CanvasLine => ({
  id: 'l1',
  chapterId: 'c1',
  bookId: 'b1',
  seq: 0,
  speakerType: 'character',
  characterId: 'ch1',
  kind: 'dialogue',
  text: '「你好。」',
  sourceText: '你好。',
  charStart: 10,
  charEnd: 14,
  emotion: '平静',
  emotionIntensity: 3,
  speed: 'slow',
  gainDb: -1.5,
  pauseAfterMs: 700,
  pauseInline: [1, 3],
  pronunciation: 'ni3 hao3',
  note: '备注',
  state: 'assigned',
  confidence: 0.75,
  candidates: [{ characterId: 'ch1', name: '张三', score: 0.9 }],
  decidedBy: 'rule',
  needsReview: true,
  flags: ['suspect'],
  isTitle: false,
  rev: 1,
  createdAt: 111,
  updatedAt: 222,
  ...over,
})

// ---------------------------------------------------------------------------
// ① 列映射往返
// ---------------------------------------------------------------------------

describe('画本行仓储（SQLite）· 列映射往返', () => {
  it('29 列逐字段往返（含 JSON 列与 0/1 布尔列）', async () => {
    const { repo } = await sqliteRepo()
    const line = sampleLine()

    await repo.insertLines([line])
    const back = (await repo.listLines('c1'))[0]

    assert.ok(back, '应能读回刚插入的行')
    // `updatedAt` 由仓储在插入时盖成当前时间（与内存实现一致），所以把它归一后再比其余 28 列
    assert.deepEqual({ ...back, updatedAt: 0 }, { ...line, updatedAt: 0 }, '写入后读回必须逐字段完全一致')
    assert.ok(back.updatedAt > 222, 'updatedAt 应是插入时刻，而不是调用方给的值')
  })

  it('listLines 按 seq 升序且只含未删除行；countByChapter / countHumanDecided 同步', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([
      sampleLine({ id: 'a', seq: 2 }),
      sampleLine({ id: 'b', seq: 0, decidedBy: 'human' }),
      sampleLine({ id: 'c', seq: 1, decidedBy: null }),
      sampleLine({ id: 'd', seq: 3, chapterId: 'c2' }),
    ])

    assert.deepEqual((await repo.listLines('c1')).map((l) => l.id), ['b', 'c', 'a'])
    assert.deepEqual((await repo.listLines('c2')).map((l) => l.id), ['d'], '不能串章')
    assert.equal(await repo.countByChapter('c1'), 3)
    assert.equal(await repo.countHumanDecided('c1'), 1)

    await repo.softDeleteLines(['c'])
    assert.deepEqual((await repo.listLines('c1')).map((l) => l.id), ['b', 'a'])
    assert.equal(await repo.countByChapter('c1'), 2)

    assert.equal(await repo.restoreLines(['c']), 1, '软删除可恢复')
    assert.equal(await repo.countByChapter('c1'), 3)
  })

  it('空数组的批量操作是安全的 no-op', async () => {
    const { repo } = await sqliteRepo()
    assert.equal(await repo.insertLines([]), 0)
    assert.equal(await repo.softDeleteLines([]), 0)
    assert.equal(await repo.restoreLines([]), 0)
    assert.equal(await repo.batchUpdate([]), 0)
  })
})

// ---------------------------------------------------------------------------
// ①.5 生成报告（003 迁移的表；一章一行）
// ---------------------------------------------------------------------------

const sampleReport = (over: Partial<CanvasGenerateReport> = {}): CanvasGenerateReport => ({
  chapterId: 'c1',
  totalLines: 3,
  byKind: { dialogue: 2, narration: 1, inner: 0, sfx_note: 0 },
  bySpeaker: [
    { characterId: 'ch1', name: '张三', lines: 2, chars: 12 },
    { characterId: null, name: '旁白', lines: 1, chars: 5 },
  ],
  byDecision: { rule: 2, vector: 1, llm: 0, human: 0 },
  lowConfidence: 1,
  unmatchedQuote: 0,
  tooLong: 0,
  elapsedMs: 42,
  embeddingUsed: false,
  llmUsed: false,
  warnings: ['CANVAS_EMBEDDING_UNAVAILABLE'],
  ...over,
})

describe('画本行仓储（SQLite）· 生成报告', () => {
  it('往返：嵌套结构（byKind/bySpeaker/byDecision/warnings）逐字段不丢', async () => {
    const { repo } = await sqliteRepo()
    const report = sampleReport()

    await repo.saveGenerateReport(report)
    const back = await repo.getGenerateReport('c1')

    assert.deepEqual(back, report, '报告是嵌套结构，漏序列化某一层不会报错、只会让 UI 少显示')
    assert.equal(back?.embeddingUsed, false, 'embeddingUsed 必须如实（模型缺失时 UI 要显著告知）')
  })

  it('一章一行：再次保存是整行覆盖，不会堆出多份', async () => {
    const { repo, db } = await sqliteRepo()
    await repo.saveGenerateReport(sampleReport({ totalLines: 3 }))
    await repo.saveGenerateReport(sampleReport({ totalLines: 9, elapsedMs: 100 }))

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM canvas_generate_reports WHERE chapter_id = 'c1'`)
      .get() as { n: number }
    assert.equal(rows.n, 1, '契约只有 { chapterId } → 报告，没有 id/历史；堆副本只会让人分不清哪份是本次的')
    assert.equal((await repo.getGenerateReport('c1'))?.totalLines, 9)
  })

  it('没有报告时返回 null（不是编造的空报告），章节不同不串号', async () => {
    const { repo } = await sqliteRepo()
    assert.equal(await repo.getGenerateReport('c1'), null, 'null 的语义是「还没生成过」')
    await repo.saveGenerateReport(sampleReport())
    assert.equal(await repo.getGenerateReport('c2'), null)
  })

  it('标量冗余列与 payload 在同一条语句里写入（不会分叉）', async () => {
    const { repo, db } = await sqliteRepo()
    await repo.saveGenerateReport(sampleReport({ totalLines: 7, lowConfidence: 2, embeddingUsed: true, llmUsed: true, elapsedMs: 88 }))

    const row = db
      .prepare(`SELECT total_lines, low_confidence, embedding_used, llm_used, elapsed_ms FROM canvas_generate_reports WHERE chapter_id = 'c1'`)
      .get() as { total_lines: number; low_confidence: number; embedding_used: number; llm_used: number; elapsed_ms: number }
    assert.deepEqual(
      // `node:sqlite` 返回的行对象原型不是 `Object.prototype`，深比较前摊平成普通对象
      { ...row },
      {
        total_lines: 7,
        low_confidence: 2,
        embedding_used: 1,
        llm_used: 1,
        elapsed_ms: 88,
      },
    )
  })

  it('坏掉的 payload 返回 null 而不是让画本打不开', async () => {
    const { repo, db } = await sqliteRepo()
    await repo.saveGenerateReport(sampleReport())
    db.prepare(`UPDATE canvas_generate_reports SET payload = '{' WHERE chapter_id = 'c1'`).run()
    assert.equal(await repo.getGenerateReport('c1'), null)
  })

  it('与内存实现一致（同样的保存—读取—覆盖序列）', async () => {
    const { repo: sqlite } = await sqliteRepo()
    const memory = createMemoryCanvasRepo()

    async function scenario(repo: CanvasRepo) {
      const before = await repo.getGenerateReport('c1')
      await repo.saveGenerateReport(sampleReport({ totalLines: 3 }))
      await repo.saveGenerateReport(sampleReport({ totalLines: 9, embeddingUsed: true }))
      return { before, after: await repo.getGenerateReport('c1') }
    }

    assert.deepEqual(await scenario(sqlite), await scenario(memory))
  })

  it('保存时深拷贝：改调用方持有的对象不会污染已存的报告', async () => {
    const { repo } = await sqliteRepo()
    const report = sampleReport()
    await repo.saveGenerateReport(report)
    report.warnings.push('后来加的')
    report.bySpeaker.push({ characterId: null, name: '幽灵', lines: 0, chars: 0 })

    const back = await repo.getGenerateReport('c1')
    assert.deepEqual(back?.warnings, ['CANVAS_EMBEDDING_UNAVAILABLE'])
    assert.equal(back?.bySpeaker.length, 2)
  })
})

// ---------------------------------------------------------------------------
// ② 乐观锁 / 归一化 / 软删除 / shiftSeq
// ---------------------------------------------------------------------------

describe('画本行仓储（SQLite）· 写入语义', () => {
  it('updateLine：rev 不匹配抛 CONFLICT（并带上期望/实际），匹配则 rev+1', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([sampleLine()])

    await assert.rejects(
      () => repo.updateLine('l1', { text: '改' }, 99),
      (e: unknown) => {
        const err = e as { key?: string; details?: Record<string, unknown> }
        assert.equal(err.key, 'CONFLICT')
        assert.equal(err.details?.['expectedRev'], 99)
        assert.equal(err.details?.['actualRev'], 1, '实际 rev 要带上，UI 才能提示「已被改动」')
        return true
      },
    )

    const updated = await repo.updateLine('l1', { text: '改' }, 1)
    assert.equal(updated.text, '改')
    assert.equal(updated.rev, 2, '成功更新要推进 rev')
  })

  it('updateLine：不存在的行 → NOT_FOUND', async () => {
    const { repo } = await sqliteRepo()
    await assert.rejects(() => repo.updateLine('nope', { text: 'x' }), { key: 'NOT_FOUND' })
  })

  it('CHECK 约束的归一化：confidence 夹 0..1、emotionIntensity 夹 1..5、pauseAfterMs 负值归 0', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([sampleLine()])

    const a = await repo.updateLine('l1', { confidence: 5, emotionIntensity: 99, pauseAfterMs: -100 })
    assert.equal(a.confidence, 1, '超上界的置信度夹到 1（而不是让 CHECK 抛错）')
    assert.equal(a.emotionIntensity, 5)
    assert.equal(a.pauseAfterMs, 0)

    const b = await repo.updateLine('l1', { confidence: -3, emotionIntensity: 0, pauseAfterMs: 12.5 })
    assert.equal(b.confidence, 0)
    assert.equal(b.emotionIntensity, 1)
    assert.equal(b.pauseAfterMs, 12.5)
  })

  it('batchUpdate：跳过不存在/已删除的行，返回实际更新数，且推进 rev', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([sampleLine({ id: 'a', seq: 0 }), sampleLine({ id: 'b', seq: 1 })])
    await repo.softDeleteLines(['b'])

    const n = await repo.batchUpdate([
      { lineId: 'a', patch: { text: 'A' } },
      { lineId: 'b', patch: { text: 'B' } }, // 已软删除 → 跳过
      { lineId: 'ghost', patch: { text: 'C' } }, // 不存在 → 跳过
    ])

    assert.equal(n, 1)
    const [a] = await repo.listLines('c1')
    assert.equal(a?.text, 'A')
    assert.equal(a?.rev, 2)
  })

  it('shiftSeq：整章未删除行的 seq 整体加 delta（章首插入腾位用）', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([
      sampleLine({ id: 'a', seq: 0 }),
      sampleLine({ id: 'b', seq: 1 }),
      sampleLine({ id: 'd', seq: 0, chapterId: 'c2' }),
    ])

    assert.equal(await repo.shiftSeq('c1', 1), 2)
    assert.deepEqual((await repo.listLines('c1')).map((l) => `${l.id}:${l.seq}`), ['a:1', 'b:2'])
    assert.equal((await repo.listLines('c2'))[0]?.seq, 0, '别的章不受影响')
  })

  it('shiftSeq：给出 seqGreaterThan 时只挪插入点之后的尾巴（章中间插入腾位）', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([
      sampleLine({ id: 'a', seq: 0 }),
      sampleLine({ id: 'b', seq: 1 }),
      sampleLine({ id: 'c', seq: 2 }),
      sampleLine({ id: 'd', seq: 3 }),
    ])

    // 在 seq=1 之后插 2 行：只有 c/d 让位
    assert.equal(await repo.shiftSeq('c1', 2, { seqGreaterThan: 1 }), 2)
    assert.deepEqual(
      (await repo.listLines('c1')).map((l) => `${l.id}:${l.seq}`),
      ['a:0', 'b:1', 'c:4', 'd:5'],
      '插入点之前的行必须原地不动（否则会与新增行撞 seq，朗读顺序静默错乱）',
    )

    // 边界：seqGreaterThan 大于所有行的 seq → 空操作
    assert.equal(await repo.shiftSeq('c1', 2, { seqGreaterThan: 99 }), 0)
    assert.deepEqual((await repo.listLines('c1')).map((l) => l.seq), [0, 1, 4, 5])
  })

  it('replaceChapterLines：旧行软删除 + 新行插入（一个事务）', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([sampleLine({ id: 'old', seq: 0 })])

    const res = await repo.replaceChapterLines('c1', [sampleLine({ id: 'new1', seq: 0 }), sampleLine({ id: 'new2', seq: 1 })])

    assert.deepEqual(res, { deleted: 1, inserted: 2 })
    assert.deepEqual((await repo.listLines('c1')).map((l) => l.id), ['new1', 'new2'])
  })
})

// ---------------------------------------------------------------------------
// ③ 向量与快照
// ---------------------------------------------------------------------------

describe('画本行仓储（SQLite）· 向量与快照', () => {
  it('向量按 BLOB 往返，Float32 精度不丢', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([sampleLine()])
    const vector = Float32Array.from([0.5, -0.25, 0.125, 1, 0])

    await repo.upsertEmbedding({
      lineId: 'l1',
      modelId: 'bge-small-zh-v1.5',
      dim: vector.length,
      vector,
      contentHash: 'sha256:abc',
      contextScope: 2,
      createdAt: 5,
    })

    const back = await repo.getEmbedding('l1')
    assert.ok(back)
    assert.deepEqual([...back.vector], [...vector], 'Float32 值必须逐位相同')
    assert.equal(back.modelId, 'bge-small-zh-v1.5')
    assert.equal(back.contentHash, 'sha256:abc')
    assert.equal(back.contextScope, 2)

    // upsert 覆盖同一行
    await repo.upsertEmbedding({ ...back, contentHash: 'sha256:changed' })
    assert.equal((await repo.getEmbedding('l1'))?.contentHash, 'sha256:changed')

    assert.deepEqual((await repo.listEmbeddings('c1')).map((e) => e.lineId), ['l1'])
    assert.deepEqual(await repo.listEmbeddings('c2'), [], '不串章')

    await repo.deleteEmbedding('l1')
    assert.equal(await repo.getEmbedding('l1'), null)
  })

  it('快照：payload = 当时存活行（按 seq 升序），gzip 往返可读，列表按时间倒序', async () => {
    const { repo } = await sqliteRepo()
    await repo.insertLines([
      sampleLine({ id: 'b', seq: 1, text: '第二行' }),
      sampleLine({ id: 'a', seq: 0, text: '第一行' }),
      sampleLine({ id: 'gone', seq: 2, text: '已删除' }),
    ])
    await repo.softDeleteLines(['gone'])

    const snap = await repo.createSnapshot({ chapterId: 'c1', label: '生成前', reason: 'pre_generate' })
    assert.equal(snap.payload.length, 2, '快照只含当时存活的行')
    assert.deepEqual(snap.payload.map((l) => l.id), ['a', 'b'], '按 seq 升序')
    assert.equal(snap.reason, 'pre_generate')

    const got = await repo.getSnapshot(snap.id)
    assert.ok(got)
    assert.deepEqual(got.payload.map((l) => l.text), ['第一行', '第二行'], 'gzip payload 必须能读回来')

    const list = await repo.listSnapshots('c1')
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, snap.id)
  })
})

// ---------------------------------------------------------------------------
// ④ 与内存实现行为一致（同一串操作跑两个实现）
// ---------------------------------------------------------------------------

describe('画本行仓储 · SQLite 与内存实现行为一致', () => {
  /** 同一串操作，分别在两个实现上跑，返回可比对的结果快照 */
  async function runScenario(repo: CanvasRepo) {
    await repo.insertLines([
      sampleLine({ id: 'a', seq: 0, text: '甲' }),
      sampleLine({ id: 'b', seq: 1, text: '乙' }),
      sampleLine({ id: 'c', seq: 2, text: '丙' }),
    ])

    const conflict = await repo
      .updateLine('a', { text: '甲改' }, 99)
      .then(() => 'no-error')
      .catch((e: unknown) => (e as { key?: string }).key)

    const normalized = await repo.updateLine('b', { confidence: 9, emotionIntensity: 9, pauseAfterMs: -1 }, 1)
    const batch = await repo.batchUpdate([
      { lineId: 'c', patch: { text: '丙改' } },
      { lineId: 'ghost', patch: { text: 'x' } },
    ])
    await repo.softDeleteLines(['a'])
    await repo.shiftSeq('c1', 10)
    // 带下界的挪动也要两个实现一致（章中间插入的路径）
    const boundedShift = await repo.shiftSeq('c1', 100, { seqGreaterThan: 1 })
    const tail = (await repo.listLines('c1')).map((l) => `${l.id}:${l.seq}`)

    return {
      conflict,
      normalized: {
        confidence: normalized.confidence,
        emotionIntensity: normalized.emotionIntensity,
        pauseAfterMs: normalized.pauseAfterMs,
        rev: normalized.rev,
      },
      batch,
      boundedShift,
      list: (await repo.listLines('c1')).map((l) => `${l.id}:${l.seq}:${l.text}:${l.rev}`),
      tail,
      count: await repo.countByChapter('c1'),
    }
  }

  it('同一串操作在两个实现上产生相同结果（防「第二套行为」）', async () => {
    const { repo: sqlite } = await sqliteRepo()
    const memory = createMemoryCanvasRepo()

    const fromSqlite = await runScenario(sqlite)
    const fromMemory = await runScenario(memory)

    assert.deepEqual(fromSqlite, fromMemory)
  })

  /**
   * 整章替换两次。
   *
   * **生成画本用的 id 是确定性的**（`{chapterId}-L{seq:05d}`，见 canvas.service.ts），
   * 所以「重新生成同一章」时新行与旧行 **id 完全相同**。
   * 内存实现靠 Map 覆盖「碰巧」通过；而 SQLite 的 `canvas_lines.id` 是**主键** ——
   * 如果实现只是「软删旧行再插入」，第二次就会 UNIQUE 冲突。
   * 这条场景同时钉住「两个实现行为一致」与「重新生成必须能成功」。
   */
  async function runReplaceScenario(repo: CanvasRepo) {
    const round = (tag: string) => [
      sampleLine({ id: 'c1-L00000', seq: 0, text: `${tag}：第一行` }),
      sampleLine({ id: 'c1-L00001', seq: 1, text: `${tag}：第二行` }),
    ]
    const first = await repo.replaceChapterLines('c1', round('第一轮'))
    const second = await repo.replaceChapterLines('c1', round('第二轮'))
    return {
      first,
      second,
      list: (await repo.listLines('c1')).map((l) => `${l.id}:${l.seq}:${l.text}:${l.rev}`),
      count: await repo.countByChapter('c1'),
    }
  }

  it('整章替换两次（id 相同）必须成功，且两个实现结果一致', async () => {
    const { repo: sqlite } = await sqliteRepo()
    const memory = createMemoryCanvasRepo()

    const fromSqlite = await runReplaceScenario(sqlite)
    const fromMemory = await runReplaceScenario(memory)

    assert.deepEqual(fromSqlite, fromMemory)
    assert.deepEqual(fromSqlite.list, ['c1-L00000:0:第二轮：第一行:1', 'c1-L00001:1:第二轮：第二行:1'])
  })

  /**
   * 这是「原地更新而不是删除重建」的**理由**：指向该行的录音与向量是
   * `ON DELETE CASCADE`，一旦物理删除就一起没了（磁盘音频变孤儿）。
   * 用 `line_embeddings` 做替身最省事：它同样是 CASCADE 外键，
   * 只要替换后它还在，就证明那一步没有发生物理删除。
   */
  it('整章替换不得物理删除旧行（CASCADE 会连带销毁录音/向量元数据）', async () => {
    const { repo, db } = await sqliteRepo()
    await repo.replaceChapterLines('c1', [sampleLine({ id: 'c1-L00000', seq: 0 })])
    await repo.upsertEmbedding({
      lineId: 'c1-L00000',
      modelId: 'm',
      dim: 2,
      vector: Float32Array.from([1, 0]),
      contentHash: 'h',
      contextScope: 2,
      createdAt: 1,
    })

    // 重新生成同一章：id 相同
    await repo.replaceChapterLines('c1', [sampleLine({ id: 'c1-L00000', seq: 0, text: '重新生成' })])

    const emb = db.prepare(`SELECT COUNT(*) AS n FROM line_embeddings WHERE line_id = 'c1-L00000'`).get() as {
      n: number
    }
    assert.equal(emb.n, 1, '行还在 → 向量（以及同样 CASCADE 的 takes/voice_segments）不会被连带删除')
    assert.equal((await repo.listLines('c1'))[0]?.text, '重新生成', '内容要被新一轮替换')
  })
})
