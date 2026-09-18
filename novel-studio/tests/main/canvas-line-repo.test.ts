/**
 * 画本行写入（SQLite）· 往返测试
 * ============================================================================
 * 为什么必须单独测这一层：`canvas_lines` 有 **29 列**，而 INSERT 是手写的裸 SQL。
 * 列序写错、JSON 列漏序列化、0/1 与 boolean 混用 —— **这些都不会报错**，
 * 只会把数据悄悄写歪（比如 `char_start` 与 `char_end` 互换、`is_title` 恒为 0）。
 * 所以这里做「写进去 → 读回来 → 每个字段都比一遍」的往返断言。
 *
 * 用真 SQLite + 真实迁移：本章节的正确性全在 SQL 里。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createSqliteCanvasLineRepo } from '../../src/main/features/book/canvas/repositories/canvas-line.repo.sqlite.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { CanvasLine } from '../../src/shared/types.ts'

async function makeDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', 'C:/tmp/p1', 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '第1章', 'chapter', '正文', 2, 0, 2, 'none', 0, 1, 1)`)
  return db
}

/** 一行「所有字段都非默认值」的标题行：任何列错位都会在往返里暴露 */
const sampleLine = (): CanvasLine => ({
  id: 'line-1',
  chapterId: 'c1',
  bookId: 'b1',
  seq: 0,
  speakerType: 'narration',
  characterId: null,
  kind: 'narration',
  text: '第一章 起点',
  sourceText: '第一章 起点',
  charStart: 7,
  charEnd: 9,
  emotion: '平静',
  emotionIntensity: 3,
  speed: 'slow',
  gainDb: -1.5,
  pauseAfterMs: 700,
  pauseInline: [1, 3],
  pronunciation: 'qi3 dian3',
  note: '念白',
  state: 'draft',
  confidence: 0.75,
  candidates: [{ characterId: 'ch1', name: '张三', score: 0.9 }],
  decidedBy: 'rule',
  needsReview: true,
  flags: ['title', 'manual'],
  isTitle: true,
  rev: 2,
  createdAt: 111,
  updatedAt: 222,
})

describe('画本行写入（SQLite）· 列映射往返', () => {
  it('29 列全部原样往返（列序错位 / JSON 漏序列化都会在这里红）', async () => {
    const db = await makeDb()
    const repo = createSqliteCanvasLineRepo(db as unknown as DbLike)
    const line = sampleLine()

    await repo.insert(line)
    const back = await repo.findTitleLine('c1')

    assert.ok(back, '应能读回刚插入的标题行')
    // 逐字段比对（`deepEqual` 会一次性给出差异，比逐条 assert.equal 更好排查）
    assert.deepEqual(back, line)
  })

  it('findTitleLine 只认未删除的标题行，且取 seq 最小者', async () => {
    const db = await makeDb()
    const repo = createSqliteCanvasLineRepo(db as unknown as DbLike)

    await repo.insert({ ...sampleLine(), id: 'l-other', isTitle: false, seq: 5 })
    assert.equal(await repo.findTitleLine('c1'), null, '没有标题行 → null')

    await repo.insert({ ...sampleLine(), id: 'l-t2', isTitle: true, seq: 9, text: '后面的标题行' })
    await repo.insert({ ...sampleLine(), id: 'l-t1', isTitle: true, seq: 0, text: '前面的标题行' })

    const found = await repo.findTitleLine('c1')
    assert.equal(found?.id, 'l-t1', '取 seq 最小的那行（顺序必须确定）')

    // 软删除后不再可见
    db.exec(`UPDATE canvas_lines SET deleted_at = 1 WHERE id = 'l-t1'`)
    assert.equal((await repo.findTitleLine('c1'))?.id, 'l-t2')
  })

  it('countLines 只数未删除的行', async () => {
    const db = await makeDb()
    const repo = createSqliteCanvasLineRepo(db as unknown as DbLike)

    await repo.insert({ ...sampleLine(), id: 'l1', isTitle: false, seq: 1 })
    await repo.insert({ ...sampleLine(), id: 'l2', isTitle: false, seq: 2 })
    assert.equal(await repo.countLines('c1'), 2)

    db.exec(`UPDATE canvas_lines SET deleted_at = 1 WHERE id = 'l2'`)
    assert.equal(await repo.countLines('c1'), 1)
  })

  it('shiftSeqDown 把所有未删除行的 seq +1（为章首插入腾位）', async () => {
    const db = await makeDb()
    const repo = createSqliteCanvasLineRepo(db as unknown as DbLike)

    await repo.insert({ ...sampleLine(), id: 'l1', isTitle: false, seq: 0 })
    await repo.insert({ ...sampleLine(), id: 'l2', isTitle: false, seq: 1 })
    await repo.insert({ ...sampleLine(), id: 'l3', isTitle: false, seq: 2 })
    db.exec(`UPDATE canvas_lines SET deleted_at = 1 WHERE id = 'l2'`)

    await repo.shiftSeqDown('c1')

    const rows = db.prepare(`SELECT id, seq FROM canvas_lines`).all() as Array<{
      id: string
      seq: number
    }>
    // 用「id → seq」映射比较，不用数组顺序：l2 是软删除行，shiftSeqDown **不该动它**，
    // 于是 l1 与 l2 会同为 seq 1 —— 这时 `ORDER BY seq` 的顺序是未定义的，
    // 拿数组比会得到时绿时红的测试。
    const byId = new Map(rows.map((r) => [r.id, r.seq]))
    assert.deepEqual(
      [...byId.entries()].sort(),
      [
        ['l1', 1],
        ['l2', 1],
        ['l3', 3],
      ],
      'l1/l3（未删除）都 +1；已删除的 l2 不动',
    )
  })

  it('updateText 只改正文与 updated_at', async () => {
    const db = await makeDb()
    const repo = createSqliteCanvasLineRepo(db as unknown as DbLike)
    await repo.insert(sampleLine())

    await repo.updateText('line-1', '改过的标题')

    const row = db.prepare(`SELECT text, note, updated_at FROM canvas_lines WHERE id = 'line-1'`).get() as {
      text: string
      note: string
      updated_at: number
    }
    assert.equal(row.text, '改过的标题')
    assert.equal(row.note, '念白', '其它列不该被动')
    assert.ok(row.updated_at > 222, 'updated_at 应刷新')
  })
})
