/**
 * Novel Studio · 章节仓库（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/03-数据模型与存储.md / docs/21-数据字典与SQL.md
 *   · docs/10-功能域-书籍导入.md §1「出口物：一个 book + N 个 chapter
 *     （含 rawText 与清洗后文本）」、§3 第 ⑧ 步「事务写 books + chapters」
 *
 * ⚠ 契约缺口（已在最终报告中说明，未擅自修改 shared/types.ts）：
 *   `Chapter`（src/shared/types.ts）里**没有** rawText / text 字段，
 *   而 docs/10 §1 明确要求章节保存「rawText 与清洗后文本」。
 *   推测上游把章节文本放在单独的 `chapter_texts` 表（docs/21）。
 *   因此本仓库用 `ChapterWithText` 把「章元数据 + 两种文本」一起传入，
 *   存储层据此决定写哪张表 —— 不改契约类型，也不丢文本。
 */

import type { Book, Chapter, Id } from '../../../../../shared/types.ts'
import { AppError } from '../../../../../shared/errors.ts'
import { dropUndefined } from '../../../../../shared/util/drop-undefined.ts'
import type { BookRepo } from './book.repo.ts'
import { createMemoryBookRepo } from './book.repo.ts'

// ============================================================================
// 类型
// ============================================================================

/**
 * 写入章节时的完整载荷：元数据（Chapter，契约类型）+ 两种文本。
 * · rawText：清洗**前**的正文，用于「查看被删内容」与回溯（docs/10 §5.3）
 * · text：清洗**后**的正文，分章与后续画本生成都用它
 */
export interface ChapterWithText {
  chapter: Chapter
  rawText: string
  text: string
}

export interface ChapterListOptions {
  limit?: number
  offset?: number
  /** 只看某一章之后（按 seq） */
  afterSeq?: number
}

export interface ChapterText {
  rawText: string
  text: string
}

export interface ChapterRepo {
  /** 批量插入（一个事务内调用，见 import.service 的 withTransaction） */
  insertMany(items: readonly ChapterWithText[]): Promise<void>
  /** 按 id 取章节 */
  findById(id: Id): Promise<Chapter | null>
  /** 取某书的章节（按 seq 升序） */
  listByBook(bookId: Id, options?: ChapterListOptions): Promise<Chapter[]>
  /** 取某书的章节数 */
  countByBook(bookId: Id): Promise<number>
  /** 取章节文本（rawText + 清洗后文本） */
  getText(chapterId: Id): Promise<ChapterText | null>
  /** 局部更新章节元数据 */
  update(id: Id, patch: Partial<Omit<Chapter, 'id' | 'bookId'>>): Promise<Chapter>
  /** 更新章节文本（人工编辑后） */
  updateText(chapterId: Id, patch: Partial<ChapterText>): Promise<void>
  /** 删除某书全部章节（返回删除条数） */
  deleteByBook(bookId: Id): Promise<number>
  /** 按 id 批量删除（返回删除条数） */
  deleteByIds(ids: readonly Id[]): Promise<number>
  /**
   * 按 id 批量**软删除**（置 `deleted_at`，返回影响条数）。
   *
   * 为什么章节管理必须用软删除而不是 `deleteByIds`：docs/21 §「软删除」明确
   * **音频相关实体禁物理删除**。`chapters → canvas_lines → voice_segments` 都是
   * `ON DELETE CASCADE`，物理删一章会把它的画本行与**录音片段**一起级联删掉，
   * 那是不可恢复的用户数据。软删除后行还在、录音还在，可以恢复。
   *
   * `deleteByIds` / `deleteByBook`（物理删除）只用于「整本书被删除且用户确认删音频」这类
   * 显式场景 —— 那条路径由 `book:delete` 的 `deleteAudio` 参数把关。
   */
  softDeleteByIds(ids: readonly Id[]): Promise<number>
  /** 下一个可用 seq（追加章节用） */
  nextSeq(bookId: Id): Promise<number>
}

export interface MemoryChapterRepoExtras {
  all(): ChapterWithText[]
  clear(): void
}

export type MemoryChapterRepo = ChapterRepo & MemoryChapterRepoExtras

// ============================================================================
// 内存实现
// ============================================================================

/**
 * 创建内存章节仓库（测试 / 无数据库场景）。
 * @param seed 初始数据
 * @returns ChapterRepo + 调试方法
 * @throws AppError `CONFLICT`：同一本书内 seq 重复
 */
export function createMemoryChapterRepo(seed: readonly ChapterWithText[] = []): MemoryChapterRepo {
  const byId = new Map<Id, ChapterWithText>()
  for (const item of seed) byId.set(item.chapter.id, { ...item, chapter: { ...item.chapter } })

  /**
   * 软删除标记（章节 id → 删除时间）。
   *
   * 为什么用侧表而不是给 `Chapter` 加字段：领域类型 `Chapter` 里**故意没有** `deletedAt`
   * （删除状态是存储层的事，见 docs/03 §「软删除」），上层拿到的章节不该带这个字段。
   * SQLite 实现用 `deleted_at` 列 + 读取时过滤；这里用侧表复刻同一语义 ——
   * 两个实现必须给出同样的可见性，否则以内存实现为基准的测试会与真机行为分叉。
   */
  const deletedAt = new Map<Id, number>()
  const alive = (id: Id): boolean => byId.has(id) && !deletedAt.has(id)

  return {
    async insertMany(items: readonly ChapterWithText[]): Promise<void> {
      // 先整体校验再写入，保证「要么全成功要么全不写」（与事务语义一致）
      const seenIds = new Set<Id>()
      const seenSeq = new Set<string>()
      for (const item of items) {
        const { chapter } = item
        if (byId.has(chapter.id) || seenIds.has(chapter.id)) {
          throw new AppError('CONFLICT', { details: { reason: 'chapter id 重复', id: chapter.id } })
        }
        const seqKey = `${chapter.bookId}:${chapter.seq}`
        if (seenSeq.has(seqKey)) {
          throw new AppError('CONFLICT', {
            details: { reason: '同一本书内 seq 重复', bookId: chapter.bookId, seq: chapter.seq },
          })
        }
        seenIds.add(chapter.id)
        seenSeq.add(seqKey)
      }
      for (const item of items) {
        byId.set(item.chapter.id, { chapter: { ...item.chapter }, rawText: item.rawText, text: item.text })
      }
    },

    async findById(id: Id): Promise<Chapter | null> {
      const item = alive(id) ? byId.get(id) : undefined
      return item ? { ...item.chapter } : null
    },

    async listByBook(bookId: Id, options?: ChapterListOptions): Promise<Chapter[]> {
      let items = [...byId.values()].filter((i) => i.chapter.bookId === bookId && alive(i.chapter.id))
      if (options?.afterSeq !== undefined) items = items.filter((i) => i.chapter.seq > options.afterSeq!)
      items.sort((a, b) => a.chapter.seq - b.chapter.seq)
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? items.length
      return items.slice(offset, offset + limit).map((i) => ({ ...i.chapter }))
    },

    async countByBook(bookId: Id): Promise<number> {
      let n = 0
      for (const item of byId.values()) if (item.chapter.bookId === bookId && alive(item.chapter.id)) n++
      return n
    },

    async getText(chapterId: Id): Promise<ChapterText | null> {
      const item = alive(chapterId) ? byId.get(chapterId) : undefined
      return item ? { rawText: item.rawText, text: item.text } : null
    },

    async update(id: Id, patch: Partial<Omit<Chapter, 'id' | 'bookId'>>): Promise<Chapter> {
      const item = alive(id) ? byId.get(id) : undefined
      if (!item) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id } })
      // 只应用**真正给出**的键（`undefined` = 没给）。直接 spread 会把没给的可选字段
      // 静默写成 undefined —— 内存实现没有 NOT NULL 约束，错得比 SQLite 更隐蔽
      // （SQLite 那边会直接报错，见 chapter.repo.sqlite.ts 的同款注释）
      const next: Chapter = {
        ...item.chapter,
        ...dropUndefined(patch),
        id: item.chapter.id,
        bookId: item.chapter.bookId,
      }
      byId.set(id, { ...item, chapter: next })
      return { ...next }
    },

    async updateText(chapterId: Id, patch: Partial<ChapterText>): Promise<void> {
      const item = alive(chapterId) ? byId.get(chapterId) : undefined
      if (!item) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: chapterId } })
      byId.set(chapterId, {
        ...item,
        rawText: patch.rawText ?? item.rawText,
        text: patch.text ?? item.text,
      })
    },

    async deleteByBook(bookId: Id): Promise<number> {
      let removed = 0
      for (const [id, item] of [...byId]) {
        if (item.chapter.bookId === bookId) {
          byId.delete(id)
          deletedAt.delete(id)
          removed++
        }
      }
      return removed
    },

    async deleteByIds(ids: readonly Id[]): Promise<number> {
      let removed = 0
      for (const id of ids) {
        if (byId.delete(id)) {
          deletedAt.delete(id)
          removed++
        }
      }
      return removed
    },

    async softDeleteByIds(ids: readonly Id[]): Promise<number> {
      const now = Date.now()
      let removed = 0
      for (const id of ids) {
        if (!alive(id)) continue
        deletedAt.set(id, now)
        removed++
      }
      return removed
    },

    async nextSeq(bookId: Id): Promise<number> {
      let max = 0
      for (const item of byId.values()) {
        if (item.chapter.bookId === bookId && alive(item.chapter.id)) max = Math.max(max, item.chapter.seq)
      }
      return max + 1
    },

    // ---- 调试用 ----
    all(): ChapterWithText[] {
      return [...byId.values()].map((i) => ({ chapter: { ...i.chapter }, rawText: i.rawText, text: i.text }))
    },
    clear(): void {
      byId.clear()
    },
  }
}

/** 一组仓库（便于注入与测试） */
export interface Repos {
  books: BookRepo
  chapters: ChapterRepo
}

/**
 * 创建内存仓库组合（测试用）。
 * @param seed 可选的初始数据
 */
export function createMemoryRepos(seed?: {
  books?: readonly Book[]
  chapters?: readonly ChapterWithText[]
}): Repos {
  return {
    books: createMemoryBookRepo(seed?.books ?? []),
    chapters: createMemoryChapterRepo(seed?.chapters ?? []),
  }
}
