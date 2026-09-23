/**
 * Novel Studio · 书籍导入：追加到已有书籍（把多份画本文件合成一本）
 * ============================================================================
 * 需求：导入时可选「导入到已有书籍」，把本文件的章节接到目标书末尾，
 * 而不是每次都新建一本书（例：第1-20章 + 第21-40章 合成同一本）。
 * 这里用 :memory: SQLite 跑真实的 commitImport，覆盖：
 *   · 不新建书、返回同一个 bookId
 *   · seq 顺延、charCount/chapterCount 累加、书名不变
 *   · startOffset/endOffset 叠加已有正文长度（全书绝对坐标）
 *   · 目标书不存在时报 NOT_FOUND，且不得静默新建
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { createBookService } from '../../src/main/features/book/import/book.service.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { Logger } from '../../src/main/infra/log/index.ts'
import type { ChapterDraft } from '../../src/shared/types.ts'

function silentLogger(): Logger {
  const noop = (): void => undefined
  const stub = {
    level: 'info' as const,
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
  return stub as unknown as Logger
}

function draft(title: string, text: string, start: number): ChapterDraft {
  return {
    tempId: 'd-' + title,
    index: 0,
    title,
    rawText: text,
    charCount: text.length,
    estimatedDurationMs: 0,
    kind: 'chapter',
    volumeIndex: null,
    startOffset: start,
    endOffset: start + text.length,
    included: true,
  }
}

async function setup(): Promise<{ root: string; db: DatabaseSync; service: ReturnType<typeof createBookService> }> {
  const root = mkdtempSync(join(tmpdir(), 'ns-append-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  const service = createBookService({ getDb: () => db as unknown as DbLike, projectRoot: root, log: silentLogger() })
  return { root, db, service }
}

describe('书籍导入 · 追加到已有书籍', () => {
  it('带 targetBookId：不新建书、seq 顺延、字数累加、偏移叠加、书名不变', async () => {
    const { root, db, service } = await setup()
    try {
      const projectId = 'proj-append'
      const first = await service.commitImport({
        projectId,
        bookMeta: { title: '穿书后我捡到了反派', narrator: '旁白' },
        source: { type: 'txt', path: null, encoding: 'utf-8', contentHash: 'hash-part-1' },
        drafts: [draft('第1章 甲', 'AAAA', 0), draft('第2章 乙', 'BBBBB', 4)],
      })
      assert.equal(first.chapterCount, 2)

      const second = await service.commitImport({
        projectId,
        bookMeta: { title: '会被忽略的书名' },
        source: { type: 'txt', path: null, encoding: 'utf-8', contentHash: 'hash-part-2' },
        drafts: [draft('第3章 丙', 'CCC', 0), draft('第4章 丁', 'DDDD', 3)],
        targetBookId: first.bookId,
      })
      assert.equal(second.bookId, first.bookId, '追加不新建书：返回同一个 bookId')
      assert.equal(second.chapterCount, 2, '返回的是本次追加的章数')

      const book = await service.get(first.bookId)
      assert.equal(book.title, '穿书后我捡到了反派', '追加不覆盖原书名')
      assert.equal(book.chapterCount, 4, '章数累加')
      assert.equal(book.charCount, 4 + 5 + 3 + 4, '字数累加')

      const chapters = await service.listChapters(first.bookId)
      assert.deepEqual(chapters.map(c => c.seq), [1, 2, 3, 4], 'seq 顺延')
      assert.deepEqual(chapters.map(c => c.title), ['第1章 甲', '第2章 乙', '第3章 丙', '第4章 丁'])
      // 偏移是全书绝对坐标：追加章节要叠加已有正文长度（4+5=9）
      assert.equal(chapters[2]!.startOffset, 9)
      assert.equal(chapters[2]!.endOffset, 12)
      assert.equal(chapters[3]!.startOffset, 12)
      assert.equal(chapters[3]!.endOffset, 16)
    } finally {
      rmSync(root, { recursive: true, force: true })
      db.close()
    }
  })

  it('目标书籍不存在 → NOT_FOUND，且不会静默新建一本', async () => {
    const { root, db, service } = await setup()
    try {
      const projectId = 'proj-append-2'
      await assert.rejects(
        () => service.commitImport({
          projectId,
          bookMeta: { title: 'X' },
          source: { type: 'txt', path: null, encoding: 'utf-8', contentHash: 'h-x' },
          drafts: [draft('第1章 甲', 'AAAA', 0)],
          targetBookId: 'book-does-not-exist',
        }),
        (err: unknown) => (err as { key?: string }).key === 'NOT_FOUND',
      )
      const books = await service.list(projectId)
      assert.equal(books.length, 0, '不能因为追加失败就新建一本书')
    } finally {
      rmSync(root, { recursive: true, force: true })
      db.close()
    }
  })
})
