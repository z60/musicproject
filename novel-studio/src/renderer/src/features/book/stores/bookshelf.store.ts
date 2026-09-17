/**
 * 书籍导入域 · 书架状态（docs/10 §7 的 BookshelfView 数据层）
 * ============================================================================
 * 职责：
 *   · 拉取/缓存 `book:list`；本地做搜索、排序、两种视图；
 *   · 重命名（`book:update`）与删除（`book:delete`）走**乐观更新 + 失败回滚**：
 *     docs/10 §10 要求「删除/重命名失败要能看到原因」，因此回滚必须把界面改回原样，
 *     错误本身交给 error-bus（`call()` 默认已兑现，这里 catch 只为回滚本地状态）。
 *
 * 关于 projectId：
 *   `book:list` 的 `projectId` 是可选的；不传即「全部项目」——
 *   书架是「第一屏」，此时可能还没有选中任何书（session.book 为空），
 *   若强依赖当前书的 projectId 就会显示空书架。因此书架不传 projectId。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { VAD_DEFAULTS } from '@shared/constants.ts'
import type { Book } from '@shared/types.ts'
import { estimateDurationMs } from '@/features/book/stores/import.store.ts'

export type BookSortKey = 'recent' | 'title' | 'chapters'
export type BookViewMode = 'card' | 'compact'

export interface BookSortOption {
  value: BookSortKey
  label: string
}

export const BOOK_SORT_OPTIONS: BookSortOption[] = [
  { value: 'recent', label: '最近导入' },
  { value: 'title', label: '书名' },
  { value: 'chapters', label: '章数' },
]

export const useBookshelfStore = defineStore('book/bookshelf', () => {
  const books = ref<Book[]>([])
  const loading = ref(false)
  const lastError = ref<unknown>(null)
  /** 正在写库的书籍 id（卡片上显示 loading，避免重复点击） */
  const busyIds = ref<string[]>([])

  // ---- 浏览态（本地 UI 状态，不进数据库） ----
  const keyword = ref('')
  const sortBy = ref<BookSortKey>('recent')
  const viewMode = ref<BookViewMode>('card')

  // ---------------------------------------------------------------------------
  // 派生
  // ---------------------------------------------------------------------------

  /** 搜索：按书名或作者（大小写不敏感） */
  const filteredBooks = computed<Book[]>(() => {
    const query = keyword.value.trim().toLowerCase()
    if (!query) return books.value
    return books.value.filter(book =>
      book.title.toLowerCase().includes(query)
      || (book.author ?? '').toLowerCase().includes(query),
    )
  })

  const sortedBooks = computed<Book[]>(() => {
    const list = [...filteredBooks.value]
    switch (sortBy.value) {
      case 'title':
        return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
      case 'chapters':
        return list.sort((a, b) => b.chapterCount - a.chapterCount || b.createdAt - a.createdAt)
      case 'recent':
      default:
        return list.sort((a, b) => b.createdAt - a.createdAt)
    }
  })

  const totalChars = computed(() => books.value.reduce((sum, b) => sum + b.charCount, 0))
  const totalChapters = computed(() => books.value.reduce((sum, b) => sum + b.chapterCount, 0))
  const totalDurationMs = computed(() => books.value.reduce((sum, b) => sum + estimateDurationMs(b.charCount), 0))
  const isEmpty = computed(() => !loading.value && books.value.length === 0)
  const noMatch = computed(() => !loading.value && books.value.length > 0 && sortedBooks.value.length === 0)

  /** 每本书的预估时长（章数与字数都存在 book 上，字数按 4.2 字/秒换算，docs/10 §6.6） */
  function durationOf(book: Book): number {
    return estimateDurationMs(book.charCount, VAD_DEFAULTS.charsPerSecond)
  }

  function isBusy(bookId: string): boolean {
    return busyIds.value.includes(bookId)
  }

  function setBusy(bookId: string, busy: boolean): void {
    busyIds.value = busy
      ? [...new Set([...busyIds.value, bookId])]
      : busyIds.value.filter(id => id !== bookId)
  }

  // ---------------------------------------------------------------------------
  // 读取
  // ---------------------------------------------------------------------------

  async function load(): Promise<Book[]> {
    loading.value = true
    try {
      // 不传 projectId = 全部项目（见文件头注释）
      const list = await call('book:list', {})
      books.value = Array.isArray(list) ? (list as Book[]) : []
      lastError.value = null
      return books.value
    } catch (error) {
      lastError.value = error
      return books.value
    } finally {
      loading.value = false
    }
  }

  /** 静默刷新：导入完成后回到书架时用，失败不打断（错误已在别处兑现） */
  async function refreshQuietly(): Promise<void> {
    const list = await callSafe('book:list', {})
    if (Array.isArray(list)) books.value = list as Book[]
  }

  function getById(bookId: string): Book | null {
    return books.value.find(b => b.id === bookId) ?? null
  }

  // ---------------------------------------------------------------------------
  // 写入
  // ---------------------------------------------------------------------------

  /**
   * 重命名 / 改作者 / 改旁白 / 换封面（`book:update`）。
   * 乐观更新：先改本地（用户立刻看到），失败回滚到旧对象并抛出，让调用方决定后续
   * （error-bus 已由 call() 兑现提示）。
   */
  async function updateBook(
    bookId: string,
    patch: Partial<Pick<Book, 'title' | 'author' | 'narrator' | 'language' | 'coverPath'>>,
  ): Promise<Book | null> {
    const index = books.value.findIndex(b => b.id === bookId)
    if (index < 0) return null
    const before = books.value[index]!

    setBusy(bookId, true)
    books.value = books.value.map((b, i) => (i === index ? { ...b, ...patch } : b))
    try {
      const updated = await call('book:update', { bookId, patch }) as Book
      const next = updated ?? { ...before, ...patch }
      books.value = books.value.map(b => (b.id === bookId ? next : b))
      return next
    } catch (error) {
      // 回滚（docs/10 §10：失败必须看得见，且界面不能停留在假状态）
      books.value = books.value.map((b, i) => (i === index ? before : b))
      lastError.value = error
      return null
    } finally {
      setBusy(bookId, false)
    }
  }

  /** 重命名（乐观 + 回滚）；返回更新后的书或 null */
  async function rename(bookId: string, title: string): Promise<Book | null> {
    const next = title.trim()
    const current = getById(bookId)
    if (!current) return null
    if (!next || next === current.title) return current
    return await updateBook(bookId, { title: next })
  }

  /** 删除书籍；`deleteAudio` 由确认对话框的选项决定（docs/10 §10 破坏性操作要二次确认） */
  async function remove(bookId: string, deleteAudio = false): Promise<boolean> {
    const index = books.value.findIndex(b => b.id === bookId)
    if (index < 0) return false
    const before = books.value[index]!

    setBusy(bookId, true)
    try {
      await call('book:delete', { bookId, deleteAudio })
      books.value = books.value.filter(b => b.id !== bookId)
      return true
    } catch (error) {
      lastError.value = error
      // 删除失败：把书放回原位置（顺序也要还原）
      const list = [...books.value]
      list.splice(Math.min(index, list.length), 0, before)
      books.value = list
      return false
    } finally {
      setBusy(bookId, false)
    }
  }

  /** 在文件夹中显示（`app:showItemInFolder`）；路径由调用方决定（源文件优先，其次项目根） */
  async function reveal(path: string | null | undefined): Promise<boolean> {
    if (!path) return false
    const result = await callSafe('app:showItemInFolder', { path })
    return result?.ok ?? false
  }

  // ---------------------------------------------------------------------------
  // 浏览态
  // ---------------------------------------------------------------------------

  function setKeyword(value: string): void {
    keyword.value = value
  }

  function setSortBy(value: BookSortKey): void {
    sortBy.value = value
  }

  function setViewMode(value: BookViewMode): void {
    viewMode.value = value
  }

  function resetView(): void {
    keyword.value = ''
    sortBy.value = 'recent'
    viewMode.value = 'card'
  }

  return {
    books, loading, lastError, busyIds,
    keyword, sortBy, viewMode,
    filteredBooks, sortedBooks, totalChars, totalChapters, totalDurationMs, isEmpty, noMatch,
    durationOf, isBusy,
    load, refreshQuietly, getById, updateBook, rename, remove, reveal,
    setKeyword, setSortBy, setViewMode, resetView,
  }
})
