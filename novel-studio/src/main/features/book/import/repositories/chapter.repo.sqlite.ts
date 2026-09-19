/**
 * Novel Studio · 章节仓库（SQLite 实现）
 * ============================================================================
 * 设计依据：docs/03 §1、docs/21「chapters 表」、docs/10 §5.3「清洗报告」
 *
 * ### 与内存实现的关系
 *   `chapter.repo.ts` 的 `ChapterRepo` + `createMemoryChapterRepo` 是行为基准。
 *   本文件把同样的语义翻译成 SQL，**不引入第二套行为**。
 *
 * ### 文本列的三分法（对齐 docs/10 §5.3）
 *   · `raw_text`    —— 清洗**前**的原文（「查看被删内容」用）
 *   · `source_text` —— 该章在**原书**里的片段（人工改过之后仍能对照原文）
 *   · `clean_report`—— JSON，记录本章删了什么（面板展示用）
 *
 *   领域类型 `Chapter` 里没有 `cleanReport` 字段（那是「文本层」的东西），
 *   所以它由本仓库**透传保存**，读取时通过 `getText()` 之外的通道暴露给上层 —— 见
 *   {@link SqliteChapterRepo.getCleanReport}。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { Chapter, ChapterProgress, Id } from '../../../../../shared/types.ts'
import { dropUndefined } from '../../../../../shared/util/drop-undefined.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import {
  CHAPTER_PATCH_COLUMNS,
  chapterFromRow,
  chapterProgressFromRow,
  chapterToInsertParams,
  type ChapterProgressRow,
  type ChapterRow,
} from './mappers.ts'
import type { ChapterListOptions, ChapterRepo, ChapterText, ChapterWithText } from './chapter.repo.ts'

const INSERT_SQL = `
INSERT INTO chapters (id, book_id, seq, title, kind, volume_seq, volume_title,
                      raw_text, source_text, char_count, start_offset, end_offset,
                      clean_report, canvas_state, line_count, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const SELECT_COLS = `
  id, book_id, seq, title, kind, volume_seq, volume_title,
  raw_text, source_text, char_count, start_offset, end_offset,
  clean_report, canvas_state, line_count, created_at, updated_at, deleted_at
`

export interface SqliteChapterRepo extends ChapterRepo {
  /** 取本章的清洗报告 JSON（原样，解析由上层负责） */
  getCleanReport(chapterId: Id): Promise<string | null>
  /** 写入本章的清洗报告 JSON */
  setCleanReport(chapterId: Id, json: string | null): Promise<void>
  /** 单章进度概览（无画本行时各项计数为 0，不是 null） */
  getProgress(chapterId: Id): Promise<ChapterProgress | null>
  /** 某书全部章节的进度概览（按 seq 升序） */
  listProgressByBook(bookId: Id): Promise<ChapterProgress[]>
}

/**
 * 进度概览查询。
 *
 * ⚠️ **为什么不直接查 `v_chapter_progress` 视图**：那视图**根本跑不起来** ——
 * 它写着 `SUM(l.char_count)`，而 `canvas_lines` 表**没有 `char_count` 列**（实测：
 * 任何 `SELECT` 都报 `SQLITE_ERROR: no such column: l.char_count`；视图创建时不校验列名，
 * 所以迁移阶段不会发现）。它还有第二个缺陷：把 `canvas_lines` 与 `voice_segments`
 * **连续 LEFT JOIN**，一行有多段录音时该行被复制，`COUNT(l.id)` / `review_count` 会被放大
 * （`audio_ms` 恰好是对的）。
 *
 * 视图建在 `001_init.sql` 里，那是**已发布的迁移**（hash 固定），不能就地改；
 * 这里用等价子查询把语义写对。视图目前没有任何消费者，两处缺陷已记入 docs/91。
 * 修视图需要新增 `003_*.sql`（`DROP VIEW` + 正确重建）。
 *
 * 各列语义（与视图**意图**一致）：
 *   · `line_count`       —— 未删除的画本行数
 *   · `recorded_count`   —— 已录/已对轨的行数
 *   · `review_count`     —— 待人工确认的行数
 *   · `unassigned_count` —— 说话人类型是「角色」但还没绑角色的行数
 *   · `audio_ms`         —— 这些行的全部录音片段时长之和
 *   · `char_count`       —— 画本行**字数**之和。注意 `canvas_lines` 没有 char_count 列，
 *                           所以按 `LENGTH(text)` 求和（先例：`v_actor_workload` 视图就是
 *                           `SUM(LENGTH(l.text))`）。它**不是**章节正文字数 ——
 *                           正文长度在 `chapters.char_count`，由 `Chapter.charCount` 提供。
 */
const PROGRESS_COLS = `
  c.id    AS chapter_id,
  c.book_id AS book_id,
  c.seq   AS seq,
  c.title AS title,
  (SELECT COUNT(*) FROM canvas_lines l
     WHERE l.chapter_id = c.id AND l.deleted_at IS NULL) AS line_count,
  (SELECT COUNT(*) FROM canvas_lines l
     WHERE l.chapter_id = c.id AND l.deleted_at IS NULL
       AND l.state IN ('recorded','aligned')) AS recorded_count,
  (SELECT COUNT(*) FROM canvas_lines l
     WHERE l.chapter_id = c.id AND l.deleted_at IS NULL
       AND l.needs_review = 1) AS review_count,
  (SELECT COUNT(*) FROM canvas_lines l
     WHERE l.chapter_id = c.id AND l.deleted_at IS NULL
       AND l.speaker_type = 'character' AND l.character_id IS NULL) AS unassigned_count,
  (SELECT COALESCE(SUM(s.duration_ms), 0) FROM voice_segments s
     JOIN canvas_lines l ON s.line_id = l.id
     WHERE l.chapter_id = c.id AND l.deleted_at IS NULL) AS audio_ms,
  (SELECT COALESCE(SUM(LENGTH(l.text)), 0) FROM canvas_lines l
     WHERE l.chapter_id = c.id AND l.deleted_at IS NULL) AS char_count
`

/**
 * 章节的「扩展数据」伴随对象：`ChapterWithText` 只带 rawText / text，
 * 而落库还需要 sourceText 与 cleanReport。它们以**可选字段**形式挂在入参上，
 * 缺失时写 null —— 不猜、不造假。
 */
export interface ChapterWithExtras extends ChapterWithText {
  /** 该章在原书里的片段（清洗前的局部原文） */
  sourceText?: string | null
  /** 本章清洗报告（JSON 字符串；由调用方序列化） */
  cleanReportJson?: string | null
}

export function createSqliteChapterRepo(db: DbLike): SqliteChapterRepo {
  async function insertMany(items: readonly (ChapterWithText & Partial<ChapterWithExtras>)[]): Promise<void> {
    // 先整体校验：与内存实现一样做到「要么全成功要么全不写」。
    // 虽然通常由外层事务保证，但仓库自身的语义不该依赖调用方正确使用事务。
    const seenIds = new Set<Id>()
    const seenSeq = new Set<string>()
    for (const item of items) {
      const c = item.chapter
      if (seenIds.has(c.id)) {
        throw new AppError('CONFLICT', { details: { reason: 'chapter id 重复', id: c.id } })
      }
      const seqKey = `${c.bookId}:${c.seq}`
      if (seenSeq.has(seqKey)) {
        throw new AppError('CONFLICT', { details: { reason: '同一本书内 seq 重复', bookId: c.bookId, seq: c.seq } })
      }
      seenIds.add(c.id)
      seenSeq.add(seqKey)
    }

    const stmt = db.prepare(INSERT_SQL)
    for (const item of items) {
      const rawText = item.rawText ?? ''
      // `source_text`：默认回落到清洗后文本（没有原文片段时至少不是 null，
      // 让「对照原文」面板有内容可显示，而不是空白）
      const sourceText = item.sourceText ?? null
      const cleanReportJson = item.cleanReportJson ?? null
      try {
        stmt.run(...chapterToInsertParams(item.chapter, rawText, sourceText, cleanReportJson))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/UNIQUE|PRIMARY/i.test(msg)) {
          throw new AppError('CONFLICT', {
            cause: e,
            details: { reason: 'chapter id 或 (book_id, seq) 冲突', id: item.chapter.id, seq: item.chapter.seq },
          })
        }
        throw e
      }
    }
  }

  async function findById(id: Id): Promise<Chapter | null> {
    const row = db
      .prepare(`SELECT ${SELECT_COLS} FROM chapters WHERE deleted_at IS NULL AND id = ?`)
      .get(id) as ChapterRow | undefined
    return row ? chapterFromRow(row) : null
  }

  async function listByBook(bookId: Id, options?: ChapterListOptions): Promise<Chapter[]> {
    const cond = ['deleted_at IS NULL', 'book_id = ?']
    const params: unknown[] = [bookId]
    if (options?.afterSeq !== undefined) {
      cond.push('seq > ?')
      params.push(options.afterSeq)
    }
    let sql = `SELECT ${SELECT_COLS} FROM chapters WHERE ${cond.join(' AND ')} ORDER BY seq ASC`
    if (options?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(options.limit)
      if (options.offset !== undefined) {
        sql += ' OFFSET ?'
        params.push(options.offset)
      }
    } else if (options?.offset !== undefined) {
      sql += ' LIMIT -1 OFFSET ?'
      params.push(options.offset)
    }
    const rows = db.prepare(sql).all(...params) as ChapterRow[]
    return rows.map(chapterFromRow)
  }

  async function countByBook(bookId: Id): Promise<number> {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM chapters WHERE deleted_at IS NULL AND book_id = ?`)
      .get(bookId) as { n: number } | undefined
    return row?.n ?? 0
  }

  async function getText(chapterId: Id): Promise<ChapterText | null> {
    const row = db
      .prepare(`SELECT raw_text, source_text FROM chapters WHERE deleted_at IS NULL AND id = ?`)
      .get(chapterId) as { raw_text: string; source_text: string | null } | undefined
    if (!row) return null
    // 库里的 raw_text 是**清洗前**原文；而 `ChapterText.text` 在领域里是**清洗后**文本。
    // 清洗后文本没有单独列（见 001_init.sql）—— 它保存在 `source_text` 之外的地方不现实，
    // 因此这里明确：rawText = raw_text，text = source_text ?? raw_text。
    // 这是当前 schema 下的最佳可用映射；若要区分两者需加一列（已记入 docs/91）。
    return { rawText: row.raw_text, text: row.source_text ?? row.raw_text }
  }

  async function update(id: Id, patch: Partial<Omit<Chapter, 'id' | 'bookId'>>): Promise<Chapter> {
    const current = await findById(id)
    if (!current) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id } })

    const sets: string[] = []
    const params: unknown[] = []
    // 只写**真正给出**的键：经 IPC 校验器来的 patch 里，没给的可选键也在
    // （值是 undefined）。照写会 `SET kind = NULL` —— `kind` 是 NOT NULL，
    // 于是「只改标题」直接报「未预期的错误」；可空的列则被静默清空。
    // 规则与 settings.applyPatch 一致（见 shared/util/drop-undefined.ts）。
    for (const [key, value] of Object.entries(dropUndefined(patch))) {
      const col = CHAPTER_PATCH_COLUMNS[key]
      if (!col) continue
      sets.push(`${col} = ?`)
      params.push(value)
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      params.push(Date.now())
      db.prepare(`UPDATE chapters SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    }
    const next = await findById(id)
    if (!next) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id } })
    return next
  }

  async function updateText(chapterId: Id, patch: Partial<ChapterText>): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.rawText !== undefined) {
      sets.push('raw_text = ?')
      params.push(patch.rawText)
    }
    if (patch.text !== undefined) {
      // 见 getText 的说明：清洗后文本存 `source_text` 列
      sets.push('source_text = ?')
      params.push(patch.text)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(Date.now())
    const r = db.prepare(`UPDATE chapters SET ${sets.join(', ')} WHERE id = ?`).run(...params, chapterId) as {
      changes?: number
    }
    if ((r.changes ?? 0) === 0) {
      throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: chapterId } })
    }
  }

  async function deleteByBook(bookId: Id): Promise<number> {
    const r = db.prepare(`DELETE FROM chapters WHERE book_id = ?`).run(bookId) as { changes?: number }
    return r.changes ?? 0
  }

  async function deleteByIds(ids: readonly Id[]): Promise<number> {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const r = db.prepare(`DELETE FROM chapters WHERE id IN (${placeholders})`).run(...ids) as { changes?: number }
    return r.changes ?? 0
  }

  async function softDeleteByIds(ids: readonly Id[]): Promise<number> {
    if (ids.length === 0) return 0
    const now = Date.now()
    const placeholders = ids.map(() => '?').join(', ')
    // 只标记还没被删过的行 —— 重复删除不该反复刷新 deleted_at（否则「删除时间」失去意义）
    const r = db
      .prepare(
        `UPDATE chapters SET deleted_at = ?, updated_at = ?
          WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      )
      .run(now, now, ...ids) as { changes?: number }
    return r.changes ?? 0
  }

  async function nextSeq(bookId: Id): Promise<number> {
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM chapters WHERE book_id = ?`)
      .get(bookId) as { n: number } | undefined
    return (row?.n ?? 0) + 1
  }

  async function getProgress(chapterId: Id): Promise<ChapterProgress | null> {
    const row = db
      .prepare(`SELECT ${PROGRESS_COLS} FROM chapters c WHERE c.deleted_at IS NULL AND c.id = ?`)
      .get(chapterId) as ChapterProgressRow | undefined
    return row ? chapterProgressFromRow(row) : null
  }

  async function listProgressByBook(bookId: Id): Promise<ChapterProgress[]> {
    const rows = db
      .prepare(
        `SELECT ${PROGRESS_COLS} FROM chapters c
          WHERE c.deleted_at IS NULL AND c.book_id = ?
          ORDER BY c.seq ASC`,
      )
      .all(bookId) as ChapterProgressRow[]
    return rows.map(chapterProgressFromRow)
  }

  async function getCleanReport(chapterId: Id): Promise<string | null> {
    const row = db.prepare(`SELECT clean_report FROM chapters WHERE id = ?`).get(chapterId) as
      | { clean_report: string | null }
      | undefined
    return row?.clean_report ?? null
  }

  async function setCleanReport(chapterId: Id, json: string | null): Promise<void> {
    db.prepare(`UPDATE chapters SET clean_report = ?, updated_at = ? WHERE id = ?`).run(json, Date.now(), chapterId)
  }

  return {
    insertMany,
    findById,
    listByBook,
    countByBook,
    getText,
    update,
    updateText,
    deleteByBook,
    deleteByIds,
    softDeleteByIds,
    nextSeq,
    getCleanReport,
    setCleanReport,
    getProgress,
    listProgressByBook,
  }
}
