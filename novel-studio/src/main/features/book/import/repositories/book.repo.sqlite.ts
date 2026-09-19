/**
 * Novel Studio · 书籍仓库（SQLite 实现）
 * ============================================================================
 * 设计依据：docs/03 §1、docs/21「books 表」、docs/10 §9「去重与幂等」
 *
 * ### 与内存实现的关系
 *   `book.repo.ts` 里的 `BookRepo` 接口与 `createMemoryBookRepo` 是**行为基准**：
 *   内存实现的语义（主键唯一、按 created_at 倒序、软删除不出现）在这里逐一对应。
 *   本文件只把同样的语义翻译成 SQL —— 不引入第二套行为。
 *
 * ### 软删除
 *   表里有 `deleted_at`，而 `BookRepo` 接口**没有**软删除概念（`deleteById` 就是删）。
 *   这里的选择是：`list` / `findById` 等**读操作过滤 `deleted_at IS NULL`**，
 *   而 `deleteById` 做**真删除** —— 与内存实现一致（`Map.delete`）。
 *
 *   为什么不做软删除：接口没暴露「回收站」，做成软删除会让「删掉的书还在库里」
 *   这件事对上层不可见，属于偷偷改变语义。要回收站就得先改契约（已记入 docs/91）。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { Book, Id } from '../../../../../shared/types.ts'
import { dropUndefined } from '../../../../../shared/util/drop-undefined.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import {
  BOOK_PATCH_COLUMNS,
  bookFromRow,
  bookToInsertParams,
  type BookRow,
} from './mappers.ts'
import type { BookListOptions, BookRepo } from './book.repo.ts'

const INSERT_SQL = `
INSERT INTO books (id, project_id, title, author, narrator, language, source_type, source_path,
                   source_pages, encoding, content_hash, char_count, chapter_count, cover_path,
                   metadata, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

/** 查询用的公共列（显式列出，避免 SELECT * 在加列后与 row 类型不一致） */
const SELECT_COLS = `
  id, project_id, title, author, narrator, language, source_type, source_path,
  source_pages, encoding, content_hash, char_count, chapter_count, cover_path,
  metadata, created_at, updated_at, deleted_at
`

export function createSqliteBookRepo(db: DbLike): BookRepo {
  /** 组装 list/count 的 WHERE 子句与参数（两处必须一致，故抽出来） */
  function whereOf(options?: BookListOptions): { sql: string; params: unknown[] } {
    const cond: string[] = ['deleted_at IS NULL']
    const params: unknown[] = []
    if (options?.projectId) {
      cond.push('project_id = ?')
      params.push(options.projectId)
    }
    if (options?.sourceType) {
      cond.push('source_type = ?')
      params.push(options.sourceType)
    }
    return { sql: cond.join(' AND '), params }
  }

  async function findById(id: Id): Promise<Book | null> {
    const row = db
      .prepare(`SELECT ${SELECT_COLS} FROM books WHERE deleted_at IS NULL AND id = ?`)
      .get(id) as BookRow | undefined
    return row ? bookFromRow(row) : null
  }

  async function findByContentHash(contentHash: string): Promise<Book | null> {
    // docs/10 §9：同一内容可以「作为副本导入」，因此这里**只取第一条**、不加唯一约束。
    // 顺序固定为 created_at ASC，保证「有多个同哈希时返回哪个」是确定的（便于测试）。
    const row = db
      .prepare(
        `SELECT ${SELECT_COLS} FROM books
         WHERE deleted_at IS NULL AND content_hash = ?
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(contentHash) as BookRow | undefined
    return row ? bookFromRow(row) : null
  }

  async function findBySourcePath(sourcePath: string): Promise<Book | null> {
    const row = db
      .prepare(
        `SELECT ${SELECT_COLS} FROM books
         WHERE deleted_at IS NULL AND source_path = ?
         ORDER BY created_at DESC, id ASC LIMIT 1`,
      )
      .get(sourcePath) as BookRow | undefined
    return row ? bookFromRow(row) : null
  }

  async function list(options?: BookListOptions): Promise<Book[]> {
    const w = whereOf(options)
    // 默认按 createdAt 倒序（与内存实现一致）；加 id 作为稳定次序，
    // 否则同一毫秒创建的两本书在不同查询里顺序可能不同
    let sql = `SELECT ${SELECT_COLS} FROM books WHERE ${w.sql} ORDER BY created_at DESC, id ASC`
    const params = [...w.params]
    if (options?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(options.limit)
      if (options.offset !== undefined) {
        sql += ' OFFSET ?'
        params.push(options.offset)
      }
    } else if (options?.offset !== undefined) {
      // SQLite 的 OFFSET 必须跟 LIMIT；不传 limit 时用 -1 表示「不限制」
      sql += ' LIMIT -1 OFFSET ?'
      params.push(options.offset)
    }
    const rows = db.prepare(sql).all(...params) as BookRow[]
    return rows.map(bookFromRow)
  }

  async function count(options?: BookListOptions): Promise<number> {
    const w = whereOf(options)
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM books WHERE ${w.sql}`)
      .get(...w.params) as { n: number } | undefined
    return row?.n ?? 0
  }

  async function insert(book: Book): Promise<void> {
    try {
      db.prepare(INSERT_SQL).run(...bookToInsertParams(book))
    } catch (e) {
      // 主键冲突 → 与内存实现一致地抛 CONFLICT（而不是裸的 SQLITE_CONSTRAINT）
      const msg = e instanceof Error ? e.message : String(e)
      if (/UNIQUE|PRIMARY/i.test(msg)) {
        throw new AppError('CONFLICT', { cause: e, details: { reason: 'book id 已存在', id: book.id } })
      }
      throw e
    }
  }

  async function update(id: Id, patch: Partial<Omit<Book, 'id'>>): Promise<Book> {
    const current = await findById(id)
    if (!current) throw new AppError('NOT_FOUND', { details: { what: 'book', id } })

    const sets: string[] = []
    const params: unknown[] = []
    // 只写真正给出的键（undefined = 没给）：见 shared/util/drop-undefined.ts
    for (const [key, value] of Object.entries(dropUndefined(patch))) {
      const col = BOOK_PATCH_COLUMNS[key]
      if (!col) continue // 忽略不可改的字段（id/projectId/createdAt…）
      sets.push(`${col} = ?`)
      params.push(value)
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      params.push(Date.now())
      db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    }
    const next = await findById(id)
    if (!next) throw new AppError('NOT_FOUND', { details: { what: 'book', id } })
    return next
  }

  async function deleteById(id: Id): Promise<boolean> {
    // 真删除；chapters 由 ON DELETE CASCADE 一并清掉（docs/21 的 FK 声明）
    const r = db.prepare(`DELETE FROM books WHERE id = ?`).run(id) as { changes?: number }
    return (r.changes ?? 0) > 0
  }

  return { findById, findByContentHash, findBySourcePath, list, count, insert, update, deleteById }
}
