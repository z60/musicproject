/**
 * 测试 · 「补丁里的 undefined」规则（跨仓储的静默数据损坏）
 * ============================================================================
 * 设计依据：docs/20 §1.2（载荷校验器的物化行为）、docs/91 §5.2.4
 *
 * ### 这条规则为什么值得单独一个测试文件
 *   IPC 载荷校验器（`infra/validate` 的 `ObjectSchema._parse`）会**遍历 shape 的每个键**
 *   并把结果写出来 —— 于是 `{ patch: { title: 'x' } }` 经过校验后，`patch` 里
 *   `kind` / `volumeTitle` 这些**用户没给的键也在**，值是 `undefined`。
 *
 *   仓储若照单全写，就会：
 *     · `UPDATE chapters SET kind = NULL` → 宽列 NOT NULL 报错（用户看到「未预期的错误」）
 *     · 可空列被**静默清空**（只改标点却把情绪/备注抹掉）
 *     · `'text' in patch` 恒真 → 「这条改过文本吗」判断失效（顺手作废向量、误记人工确认）
 *
 *   内存实现更危险：它没有约束，错得无声无息，还会让「以内存实现为基准」的测试通过。
 *   所以本文件对**四个仓储 × 两个实现**都钉一遍，并且先证明前提（校验器确实物化）——
 *   否则将来校验器改了行为，这里会静默变成一条什么都没测的测试。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import type { CanvasLine, CanvasLinePatch, Chapter, Book } from '../../src/shared/types.ts'
import { definedKeys, dropUndefined, hasAnyDefinedKey } from '../../src/shared/util/drop-undefined.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'
import {
  createMemoryChapterRepo,
} from '../../src/main/features/book/import/repositories/chapter.repo.ts'
import { createSqliteChapterRepo } from '../../src/main/features/book/import/repositories/chapter.repo.sqlite.ts'
import {
  createMemoryBookRepo,
} from '../../src/main/features/book/import/repositories/book.repo.ts'
import { createSqliteBookRepo } from '../../src/main/features/book/import/repositories/book.repo.sqlite.ts'
import {
  createMemoryCanvasRepo,
  isHumanEditablePatch,
  type CanvasRepo,
} from '../../src/main/features/book/canvas/repositories/canvas.repo.ts'
import { createSqliteCanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.sqlite.ts'

// ---------------------------------------------------------------------------
// ① 规则本身
// ---------------------------------------------------------------------------

describe('补丁里的 undefined：规则本身', () => {
  it('dropUndefined 丢掉 undefined，但保留 null（null 是「明确清空」）', () => {
    const patch = { text: undefined, note: '备注', emotion: null, kind: undefined }
    assert.deepEqual(dropUndefined(patch), { note: '备注', emotion: null })
    assert.deepEqual(dropUndefined({}), {})
    // 不修改入参（调用方可能复用）
    const src = { a: undefined, b: 1 }
    dropUndefined(src)
    assert.ok('a' in src)
  })

  it('definedKeys / hasAnyDefinedKey 按**值**判断，不看键是否存在', () => {
    const patch = { text: undefined, note: 'x', characterId: null } as CanvasLinePatch
    assert.deepEqual(definedKeys(patch).sort(), ['characterId', 'note'])
    assert.equal(hasAnyDefinedKey(patch, ['text', 'kind']), false)
    assert.equal(hasAnyDefinedKey(patch, ['text', 'note']), true)
    assert.equal(hasAnyDefinedKey(patch, ['characterId']), true, 'null 是「明确给出」（清空说话人）')
  })

  it('isHumanEditablePatch：没给的键不算「改过」（否则只改停顿也会被记成人工确认）', () => {
    // 只有 undefined 的补丁 = 什么都没改
    assert.equal(isHumanEditablePatch({ text: undefined, kind: undefined, characterId: undefined }), false)
    assert.equal(isHumanEditablePatch({}), false)
    // 真正给出值（含明确清空的 null）才算改过
    assert.equal(isHumanEditablePatch({ text: '改了' }), true)
    assert.equal(isHumanEditablePatch({ characterId: null }), true)
    assert.equal(isHumanEditablePatch({ note: '备注' }), true, 'note 属于可编辑字段')
  })
})

// ---------------------------------------------------------------------------
// ② 前提：校验器确实会把「没给的键」物化成 undefined
// ---------------------------------------------------------------------------

describe('补丁里的 undefined：前提（校验器的物化行为）', () => {
  it('chapter:update 校验后，patch 里没给的键也在（值为 undefined）', () => {
    const parsed = schemaFor('chapter:update')!.parse({ chapterId: 'c1', patch: { title: '新标题' } }) as {
      patch: Record<string, unknown>
    }
    assert.ok('kind' in parsed.patch, '前提失效：校验器不再物化可选键，本文件的其余测试需重新审视')
    assert.equal(parsed.patch.kind, undefined)
    assert.equal(parsed.patch.title, '新标题')
  })

  it('canvas:updateLine 校验后同理（patch 里带着一堆 undefined）', () => {
    const parsed = schemaFor('canvas:updateLine')!.parse({ lineId: 'l1', patch: { note: 'x' } }) as {
      patch: Record<string, unknown>
    }
    assert.ok('text' in parsed.patch)
    assert.equal(parsed.patch.text, undefined)
    assert.equal(parsed.patch.note, 'x')
  })
})

// ---------------------------------------------------------------------------
// ③ 章节仓储（真机 bug：只改标题 → NOT NULL constraint failed: chapters.kind）
// ---------------------------------------------------------------------------

const chapter = (over: Partial<Chapter> = {}): Chapter => ({
  id: 'c1',
  bookId: 'b1',
  seq: 1,
  title: '第一章',
  kind: 'chapter',
  volumeSeq: null,
  volumeTitle: null,
  charCount: 10,
  startOffset: 0,
  endOffset: 10,
  canvasState: 'none',
  lineCount: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

async function sqliteDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', 'C:/tmp/p1', 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  return db
}

describe('补丁里的 undefined：章节仓储', () => {
  /** 模拟「用户只改标题」：patch 里带着 kind/volumeTitle 的 undefined */
  const onlyTitle = { title: '改过的标题', kind: undefined, volumeTitle: undefined } as Partial<Chapter>

  it('SQLite：只给 title 时不得把 kind 写成 NULL（否则宽列 NOT NULL 直接报错）', async () => {
    const db = await sqliteDb()
    try {
      const repo = createSqliteChapterRepo(db as unknown as DbLike)
      await repo.insertMany([{ chapter: chapter(), rawText: '原文', text: '正文' }])

      const updated = await repo.update('c1', onlyTitle)
      assert.equal(updated.title, '改过的标题')
      assert.equal(updated.kind, 'chapter', 'kind 是 NOT NULL：写成 NULL 就是真机上那条「未预期的错误」')
      assert.equal(updated.volumeTitle, null)
      assert.equal(updated.seq, 1)
    } finally {
      db.close()
    }
  })

  it('内存：同一补丁不得把 kind 变成 undefined（内存实现的错更隐蔽）', async () => {
    const repo = createMemoryChapterRepo([{ chapter: chapter(), rawText: '原文', text: '正文' }])
    const updated = await repo.update('c1', onlyTitle)
    assert.equal(updated.title, '改过的标题')
    assert.equal(updated.kind, 'chapter')
    assert.ok(!('kind' in updated) || updated.kind !== undefined)
  })

  it('两个实现的更新结果一致（防「第二套行为」）', async () => {
    const db = await sqliteDb()
    try {
      const sqlite = createSqliteChapterRepo(db as unknown as DbLike)
      const memory = createMemoryChapterRepo()
      await sqlite.insertMany([{ chapter: chapter(), rawText: '原文', text: '正文' }])
      await memory.insertMany([{ chapter: chapter(), rawText: '原文', text: '正文' }])

      const patch = { title: '改过的标题', kind: undefined, volumeTitle: '第一卷' } as Partial<Chapter>
      const a = await sqlite.update('c1', patch)
      const b = await memory.update('c1', patch)
      // `updatedAt` 归一后再比：SQLite 实现会盖当前时间，内存实现不动时间戳
      // （这是两个实现**已知**的差异，与本次要验证的规则无关，见 docs/91）
      assert.deepEqual({ ...a, updatedAt: 0 }, { ...b, updatedAt: 0 })
      assert.equal(a.volumeTitle, '第一卷', '真正给出的值必须写进去')
      assert.deepEqual((await sqlite.findById('c1'))?.kind, (await memory.findById('c1'))?.kind)
    } finally {
      db.close()
    }
  })

  it('null 仍然照写（volumeTitle 清空是明确意图）', async () => {
    const db = await sqliteDb()
    try {
      const repo = createSqliteChapterRepo(db as unknown as DbLike)
      await repo.insertMany([{ chapter: chapter({ volumeTitle: '旧卷名' }), rawText: '原文', text: '正文' }])
      const updated = await repo.update('c1', { volumeTitle: null })
      assert.equal(updated.volumeTitle, null)
      assert.equal(updated.kind, 'chapter')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ④ 书籍仓储
// ---------------------------------------------------------------------------

const CANON: Book = {
  id: 'b1',
  projectId: 'p1',
  title: '书',
  author: null,
  narrator: '旁白',
  language: 'zh-CN',
  sourceType: 'txt',
  sourcePath: null,
  encoding: null,
  contentHash: 'h1',
  charCount: 0,
  chapterCount: 1,
  coverPath: null,
  createdAt: 1,
  updatedAt: 1,
}

describe('补丁里的 undefined：书籍仓储', () => {
  it('SQLite：只给 title 时不得把 source_type/content_hash 写成 NULL', async () => {
    const db = await sqliteDb()
    try {
      const repo = createSqliteBookRepo(db as unknown as DbLike)
      await repo.insert({ ...CANON, id: 'b2', title: '旧', sourceType: 'pdf', contentHash: 'h2', createdAt: 2, updatedAt: 2 })

      const updated = await repo.update('b2', { title: '新', sourceType: undefined, contentHash: undefined })
      assert.equal(updated.title, '新')
      assert.equal(updated.sourceType, 'pdf')
      assert.equal(updated.contentHash, 'h2', 'content_hash 是 NOT NULL + UNIQUE：写成 NULL 会直接报错')
    } finally {
      db.close()
    }
  })

  it('内存与 SQLite 结果一致', async () => {
    const db = await sqliteDb()
    try {
      const sqlite = createSqliteBookRepo(db as unknown as DbLike)
      const memory = createMemoryBookRepo()
      await sqlite.insert({ ...CANON, id: 'b3', contentHash: 'h3' })
      await memory.insert({ ...CANON, id: 'b3', contentHash: 'h3' })

      const patch = { title: '新', narrator: undefined, sourceType: undefined }
      // 同上：`updatedAt` 归一（SQLite 盖时间戳，内存实现不动）
      assert.deepEqual(
        { ...(await sqlite.update('b3', patch)), updatedAt: 0 },
        { ...(await memory.update('b3', patch)), updatedAt: 0 },
      )
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ⑤ 画本行仓储（真机 bug：改备注把正文写成 NULL）
// ---------------------------------------------------------------------------

const line = (over: Partial<CanvasLine> = {}): CanvasLine => ({
  id: 'l1',
  chapterId: 'c1',
  bookId: 'b1',
  seq: 0,
  speakerType: 'narration',
  characterId: null,
  kind: 'narration',
  text: '正文',
  sourceText: null,
  charStart: 0,
  charEnd: 0,
  emotion: '平静',
  emotionIntensity: 3,
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
  ...over,
})

/** 画本行的 `chapter_id` 是外键（ON DELETE CASCADE）→ 库里必须先有章节 */
async function canvasDbs(): Promise<{ db: DatabaseSync; sqlite: CanvasRepo; memory: CanvasRepo }> {
  const db = await sqliteDb()
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '章', 'chapter', '正文', 2, 0, 2, 'none', 0, 1, 1)`)
  return {
    db,
    sqlite: createSqliteCanvasRepo(db as unknown as DbLike),
    memory: createMemoryCanvasRepo(),
  }
}

describe('补丁里的 undefined：画本行仓储', () => {
  it('SQLite：只给 note 时不得把 text 写成 NULL（宽列 NOT NULL 报错）', async () => {
    const { db, sqlite } = await canvasDbs()
    try {
      await sqlite.insertLines([line()])
      const updated = await sqlite.updateLine('l1', {
        text: undefined,
        kind: undefined,
        speakerType: undefined,
        note: '只改备注',
      })
      assert.equal(updated.note, '只改备注')
      assert.equal(updated.text, '正文')
      assert.equal(updated.kind, 'narration')
      assert.equal(updated.emotion, '平静', '没给的字段必须保持原值，不能被清空')
    } finally {
      db.close()
    }
  })

  it('两个实现结果一致（含「没给的字段不动」这条语义）', async () => {
    const { db, sqlite, memory } = await canvasDbs()
    try {
      await sqlite.insertLines([line()])
      await memory.insertLines([line()])
      const patch: CanvasLinePatch = {
        text: undefined,
        kind: undefined,
        characterId: null,
        note: 'x',
      }

      const a = await sqlite.updateLine('l1', patch)
      const b = await memory.updateLine('l1', patch)
      // `updatedAt` 是「当下」时刻，两个实现各自取一次 → 归一后再比其余字段
      assert.deepEqual({ ...a, updatedAt: 0 }, { ...b, updatedAt: 0 })
      assert.equal(a.text, '正文')
      assert.equal(a.characterId, null, 'null 是明确清空，要写进去')
    } finally {
      db.close()
    }
  })

  it('批量更新同一补丁：两条路径都不得清空未给出的字段', async () => {
    const { db, sqlite } = await canvasDbs()
    try {
      await sqlite.insertLines([line({ id: 'a', seq: 0 }), line({ id: 'b', seq: 1 })])
      const n = await sqlite.batchUpdate([
        { lineId: 'a', patch: { text: undefined, note: '甲' } },
        { lineId: 'b', patch: { text: undefined, note: '乙' } },
      ])
      assert.equal(n, 2)
      const all = await sqlite.listLines('c1')
      assert.deepEqual(all.map((l) => `${l.note}:${l.text}`), ['甲:正文', '乙:正文'])
    } finally {
      db.close()
    }
  })
})
