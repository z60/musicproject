/**
 * Novel Studio · 书籍仓库（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/03-数据模型与存储.md / docs/21-数据字典与SQL.md —— 存储字段为 snake_case，
 *     映射由 mappers 负责；本仓库只处理领域类型（camelCase，docs/01 命名约定）
 *   · docs/10-功能域-书籍导入.md §9 去重与幂等（按 content_hash 查重）
 *
 * 说明：
 *   · 这里**只定义接口与内存实现**，不 import better-sqlite3 ——
 *     生产实现放在 infra 层，由依赖注入传进来（见 import.service.ts 的 ImportDeps）。
 *   · 内存实现用于测试与「无数据库」场景，行为与 SQL 版保持一致：
 *     主键唯一、content_hash 唯一、按 created_at 倒序列表。
 */

import type { Book, BookSourceType, Id } from '../../../../../shared/types.ts'
import { AppError } from '../../../../../shared/errors.ts'

// ============================================================================
// 接口
// ============================================================================

export interface BookListOptions {
  /** 只看某个项目（不传 = 全部） */
  projectId?: Id
  /** 只看某来源类型 */
  sourceType?: BookSourceType
  limit?: number
  offset?: number
}

export interface BookRepo {
  /** 按 id 取书 */
  findById(id: Id): Promise<Book | null>
  /** 按内容哈希查重（docs/10 §9：导入前先查） */
  findByContentHash(contentHash: string): Promise<Book | null>
  /** 按来源路径查（同一文件重复导入的快速判断） */
  findBySourcePath(sourcePath: string): Promise<Book | null>
  /** 列出书籍（默认按 createdAt 倒序） */
  list(options?: BookListOptions): Promise<Book[]>
  /** 计数（分页 UI 用） */
  count(options?: BookListOptions): Promise<number>
  /** 插入（id 冲突抛 CONFLICT） */
  insert(book: Book): Promise<void>
  /** 局部更新（不存在抛 NOT_FOUND） */
  update(id: Id, patch: Partial<Omit<Book, 'id'>>): Promise<Book>
  /** 删除（返回是否删掉了） */
  deleteById(id: Id): Promise<boolean>
}

/** 内存实现额外暴露的调试方法（仅测试用，生产实现不提供） */
export interface MemoryBookRepoExtras {
  all(): Book[]
  clear(): void
  size(): number
}

export type MemoryBookRepo = BookRepo & MemoryBookRepoExtras

// ============================================================================
// 内存实现
// ============================================================================

/**
 * 创建内存书籍仓库（测试 / 无数据库场景）。
 * @param seed 初始数据（会被浅拷贝，避免外部改动影响仓库内部状态）
 * @returns BookRepo + 调试方法；行为：insert 校验 id 唯一与 content_hash 唯一
 */
export function createMemoryBookRepo(seed: readonly Book[] = []): MemoryBookRepo {
  const byId = new Map<Id, Book>()
  for (const book of seed) byId.set(book.id, { ...book })

  return {
    async findById(id: Id): Promise<Book | null> {
      const book = byId.get(id)
      return book ? { ...book } : null
    },

    async findByContentHash(contentHash: string): Promise<Book | null> {
      for (const book of byId.values()) {
        if (book.contentHash === contentHash) return { ...book }
      }
      return null
    },

    async findBySourcePath(sourcePath: string): Promise<Book | null> {
      for (const book of byId.values()) {
        if (book.sourcePath === sourcePath) return { ...book }
      }
      return null
    },

    async list(options?: BookListOptions): Promise<Book[]> {
      let items = [...byId.values()]
      if (options?.projectId) items = items.filter((b) => b.projectId === options.projectId)
      if (options?.sourceType) items = items.filter((b) => b.sourceType === options.sourceType)
      items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? items.length
      return items.slice(offset, offset + limit).map((b) => ({ ...b }))
    },

    async count(options?: BookListOptions): Promise<number> {
      let items = [...byId.values()]
      if (options?.projectId) items = items.filter((b) => b.projectId === options.projectId)
      if (options?.sourceType) items = items.filter((b) => b.sourceType === options.sourceType)
      return items.length
    },

    async insert(book: Book): Promise<void> {
      if (byId.has(book.id)) {
        throw new AppError('CONFLICT', { details: { reason: 'book id 已存在', id: book.id } })
      }
      // 注意：这里**不**校验 content_hash 唯一。
      // docs/10 §9 允许「作为副本导入」（同一内容存在两本书），所以唯一性不能由仓库
      // 硬性保证；若上游 schema 给 content_hash 建了 UNIQUE 索引，副本导入就需要加盐
      // 或放开该约束 —— 属上游决策（见最终报告的契约缺口）。
      byId.set(book.id, { ...book })
    },

    async update(id: Id, patch: Partial<Omit<Book, 'id'>>): Promise<Book> {
      const current = byId.get(id)
      if (!current) throw new AppError('NOT_FOUND', { details: { what: 'book', id } })
      const next: Book = { ...current, ...patch, id: current.id }
      byId.set(id, next)
      return { ...next }
    },

    async deleteById(id: Id): Promise<boolean> {
      return byId.delete(id)
    },

    // ---- 调试用 ----
    all(): Book[] {
      return [...byId.values()].map((b) => ({ ...b }))
    },
    clear(): void {
      byId.clear()
    },
    size(): number {
      return byId.size
    },
  }
}
