/**
 * 应用级状态 · 当前会话上下文（跨功能域共享）
 * ============================================================================
 * 设计依据：
 *   · docs/01 §3.2 —— 「全局状态用 Pinia，按功能域分 store；
 *     **跨域共享的状态放到 app/store**，禁止 feature 之间互相 import store」
 *   · docs/01 §4.3 —— UI 选择态（当前书/当前章）属于渲染进程本地状态
 *
 * 为什么必须有这一个 store：
 *   书架要记住「上次打开的书」，画本编辑器、录音台、对轨、混音导出都要知道
 *   「当前是哪一章」。如果让 editor 去 import book 的 store，就违反了上面的分层约束；
 *   因此把「当前上下文」上提到应用层，功能域只读取它。
 *
 * 持久化：只把 bookId / chapterId / actorId 落到 localStorage，
 * 目的是重开应用回到原位；数据库才是权威（docs/01 §4.3）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import type { AppPaths, Book, Chapter, VoiceActor } from '@shared/types.ts'

const STORAGE_KEY = 'ns.session.v1'

interface PersistedSession {
  bookId: string | null
  chapterId: string | null
  actorId: string | null
}

function readPersisted(): PersistedSession {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return { bookId: null, chapterId: null, actorId: null }
    const parsed = JSON.parse(raw) as Partial<PersistedSession>
    return {
      bookId: parsed.bookId ?? null,
      chapterId: parsed.chapterId ?? null,
      actorId: parsed.actorId ?? null,
    }
  } catch {
    // localStorage 在隐私模式/沙箱下可能不可用；选择态丢了不影响功能
    return { bookId: null, chapterId: null, actorId: null }
  }
}

export const useSessionStore = defineStore('app/session', () => {
  const persisted = readPersisted()

  /** 当前书籍（完整对象，便于顶栏直接显示书名/章数） */
  const book = ref<Book | null>(null)
  /** 当前章节 */
  const chapter = ref<Chapter | null>(null)
  /** 当前配音员（任务包模式 / 角色模式下使用） */
  const actor = ref<VoiceActor | null>(null)
  /** 应用路径（导出目录、缓存目录…顶栏与设置页都要用） */
  const paths = ref<AppPaths | null>(null)
  const loading = ref(false)

  const bookId = computed(() => book.value?.id ?? persisted.bookId)
  const chapterId = computed(() => chapter.value?.id ?? persisted.chapterId)
  const actorId = computed(() => actor.value?.id ?? persisted.actorId)
  const projectId = computed(() => book.value?.projectId ?? null)
  const hasBook = computed(() => bookId.value !== null)
  const hasChapter = computed(() => chapterId.value !== null)

  function persist(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
        bookId: bookId.value,
        chapterId: chapterId.value,
        actorId: actorId.value,
      } satisfies PersistedSession))
    } catch {
      /* 忽略：写不进去只是记不住位置 */
    }
  }

  /** 选中书籍：自动清掉不属于它的章节选择（避免「章是上一本书的」这种串档 bug） */
  function selectBook(next: Book | null): void {
    book.value = next
    if (!next || (chapter.value && chapter.value.bookId !== next.id)) chapter.value = null
    persist()
  }

  function selectChapter(next: Chapter | null): void {
    chapter.value = next
    if (next) {
      // 章节可能来自「从任何地方跳转」，确保当前书与之匹配
      if (!book.value || book.value.id !== next.bookId) void ensureBook(next.bookId)
    }
    persist()
  }

  function selectActor(next: VoiceActor | null): void {
    actor.value = next
    persist()
  }

  /** 从主进程加载书籍详情（路由进入时用；失败交给 error-bus） */
  async function ensureBook(id: string): Promise<Book | null> {
    if (book.value?.id === id) return book.value
    loading.value = true
    try {
      const loaded = await call('book:get', { bookId: id })
      book.value = loaded
      persist()
      return loaded
    } finally {
      loading.value = false
    }
  }

  /**
   * 会话恢复：应用启动时用持久化的 id 把上下文补齐。
   * 用 callSafe：书可能已被删除，这不是错误，只需静默清掉选择。
   */
  async function restore(): Promise<void> {
    const saved = readPersisted()
    if (saved.bookId) {
      const loaded = await callSafe('book:get', { bookId: saved.bookId })
      if (loaded) book.value = loaded
    }
    if (saved.chapterId) {
      const loaded = await callSafe('chapter:get', { chapterId: saved.chapterId })
      if (loaded) chapter.value = loaded
      else chapter.value = null
    }
    await loadPaths()
  }

  async function loadPaths(): Promise<AppPaths | null> {
    if (paths.value) return paths.value
    const loaded = await callSafe('app:getPaths', undefined)
    if (loaded) paths.value = loaded
    return loaded
  }

  function clear(): void {
    book.value = null
    chapter.value = null
    actor.value = null
    persist()
  }

  /** 供只读展示：`斗破苍穹 · 第 12 章` */
  const breadcrumb = computed(() => {
    const parts: string[] = []
    if (book.value) parts.push(book.value.title)
    if (chapter.value) parts.push(chapter.value.title)
    return parts.join(' · ')
  })

  return {
    book, chapter, actor, paths, loading,
    bookId, chapterId, actorId, projectId,
    hasBook, hasChapter, breadcrumb,
    selectBook, selectChapter, selectActor,
    ensureBook, restore, loadPaths, clear,
  }
})
