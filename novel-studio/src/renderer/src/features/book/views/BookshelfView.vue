<!--
  书籍导入域 · 书架（docs/10 §7 的 BookshelfView）
  ============================================================================
  设计依据：
    · docs/10 §7   —— 书架 = 项目列表 + 书籍卡片 + 导入按钮；点卡片进入章节管理
    · docs/10 §7.2 —— 卡片要能一眼看出规模：章数 / 字数 / 预估时长（formatBookSummary）
    · docs/10 §10  —— 删除是破坏性操作，必须二次确认并说清影响范围（含音频是否一并删除）
    · docs/22 §6.2 —— 失败原因与提示统一走 error-bus（store 里的 call() 已兑现），
      本视图只在本地显示「操作未生效、列表已回滚」这一**状态**，不重写错误文案

  职责边界：
    · 列表/搜索/排序/视图模式/重命名/删除 全部在 stores/bookshelf.store.ts；
    · 本文件只做布局、交互与「回滚可见」的呈现。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Book, BookSourceType } from '@shared/types.ts'
import { formatBookSummary, formatCount, formatDate, formatDurationLong, formatInt } from '@/shared/lib/format.ts'
import { coverUrl } from '@/shared/lib/media-url.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { BOOK_SORT_OPTIONS, useBookshelfStore } from '@/features/book/stores/bookshelf.store.ts'

const router = useRouter()
const store = useBookshelfStore()
const session = useSessionStore()

/** 来源类型的展示名（纯界面文案） */
const SOURCE_LABELS: Record<BookSourceType, string> = {
  txt: 'TXT',
  docx: 'DOCX',
  pdf: 'PDF',
  paste: '粘贴',
  url: '网页',
}

// ── 重命名（就地编辑）─────────────────────────────────────────────────────
const renamingId = ref<string | null>(null)
const renameDraft = ref('')

/**
 * 操作未生效时的可见回滚提示。
 * 这里只说「哪一步没生效 + 已还原 + 可重试」，不写失败原因（原因由 error-bus 呈现，docs/22 §6.2）。
 */
const rollbackNotice = ref<{ action: string; hint: string; retry: () => void } | null>(null)

// ── 删除确认 ───────────────────────────────────────────────────────────────
/** 待删除的书；`deleteAudio` 由卡片上的两个入口显式决定（见 openDelete 的注释） */
const pendingDelete = ref<{ book: Book; deleteAudio: boolean } | null>(null)

const deleteVisible = computed({
  get: () => pendingDelete.value !== null,
  set: (value: boolean) => { if (!value) pendingDelete.value = null },
})

const deleteDetails = computed<string[]>(() => {
  const target = pendingDelete.value
  if (!target) return []
  const book = target.book
  const lines = [
    `章节记录：${formatInt(book.chapterCount)} 章`,
    `正文规模：${formatCount(book.charCount)}字`,
    `源文件记录：${book.sourcePath ?? '无（粘贴或网页来源）'}`,
  ]
  lines.push(target.deleteAudio
    ? '音频文件：一并删除（已录音的 wav 片段会从音频目录移除，不可恢复）'
    : '音频文件：保留在音频目录（之后仍可被其它书籍引用）')
  return lines
})

// ── 初始化 ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await store.load()
  // 顶栏/卡片操作要用到项目根目录（「显示在文件夹」的兜底路径）
  void session.loadPaths()
})

// ── 交互 ───────────────────────────────────────────────────────────────────

function onSearchInput(event: Event): void {
  store.setKeyword((event.target as HTMLInputElement).value)
}

function onSortChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'recent' || value === 'title' || value === 'chapters') store.setSortBy(value)
}

/** 点卡片：选中书籍并跳到章节管理（docs/10 §7.2） */
async function openBook(book: Book): Promise<void> {
  session.selectBook(book)
  await router.push({ path: '/chapters' })
}

function startRename(book: Book): void {
  renamingId.value = book.id
  renameDraft.value = book.title
  rollbackNotice.value = null
}

function cancelRename(): void {
  renamingId.value = null
  renameDraft.value = ''
}

async function commitRename(book: Book): Promise<void> {
  const next = renameDraft.value.trim()
  renamingId.value = null
  if (!next || next === book.title) return
  await doRename(book, next)
}

/** 真正写库的那一步（重试按钮复用它，不依赖 renameDraft 的当前值） */
async function doRename(book: Book, next: string): Promise<void> {
  const before = book.title
  const updated = await store.rename(book.id, next)
  if (!updated) {
    // store 已把本地列表回滚到旧对象，这里只把「已还原」这一事实显式说出来
    rollbackNotice.value = {
      action: `重命名《${before}》`,
      hint: `书名已还原为《${before}》`,
      retry: () => { void doRename(book, next) },
    }
    return
  }
  rollbackNotice.value = null
}

/**
 * 打开删除确认。
 * `deleteAudio` 由卡片上的两个入口决定（「删除」/「删除并清除音频」），
 * 因为 ConfirmDialog 不接受额外表单控件 —— 而「音频删不删」又必须让用户显式选择，
 * 所以把选择前置到按钮上，并在对话框明细里写清实际会删什么（docs/10 §10）。
 */
function openDelete(book: Book, deleteAudio: boolean): void {
  rollbackNotice.value = null
  pendingDelete.value = { book, deleteAudio }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  if (!target) return
  const { book, deleteAudio } = target
  const ok = await store.remove(book.id, deleteAudio)
  pendingDelete.value = null
  if (ok) {
    if (session.bookId === book.id) session.selectBook(null)
    rollbackNotice.value = null
    return
  }
  rollbackNotice.value = {
    action: `删除《${book.title}》`,
    hint: '这本书已经被放回书架原位，没有删掉任何数据',
    retry: () => { void store.remove(book.id, deleteAudio) },
  }
}

/** 显示在文件夹：源文件优先，其次项目根目录（书是从项目里导入的） */
async function revealBook(book: Book): Promise<void> {
  if (!session.paths) await session.loadPaths()
  const path = book.sourcePath ?? session.paths?.projectRoot ?? null
  const ok = await store.reveal(path)
  if (!ok) {
    rollbackNotice.value = {
      action: `打开《${book.title}》所在文件夹`,
      hint: path ? `系统没有打开「${path}」` : '这本书没有记录源文件路径，也没有可用的项目根目录',
      retry: () => { void revealBook(book) },
    }
  }
}

function coverOf(book: Book): string | null {
  return coverUrl(book.projectId, book.coverPath)
}

function summaryOf(book: Book): string {
  return formatBookSummary({
    chapters: book.chapterCount,
    chars: book.charCount,
    durationMs: store.durationOf(book),
  })
}
</script>

<template>
  <section class="shelf">
    <!-- 顶部：标题 + 规模汇总 + 导入入口 -->
    <header class="shelf__head">
      <div class="shelf__headline">
        <h2 class="shelf__title">书架</h2>
        <p class="shelf__summary">
          共 {{ formatInt(store.books.length) }} 本 ·
          {{ formatInt(store.totalChapters) }} 章 ·
          {{ formatCount(store.totalChars) }}字 ·
          预估 {{ formatDurationLong(store.totalDurationMs) }}
        </p>
      </div>
      <div class="shelf__head-actions">
        <button type="button" class="ns-btn" :disabled="store.loading" @click="store.load()">
          刷新
        </button>
        <button type="button" class="ns-btn ns-btn--primary" @click="router.push({ path: '/import' })">
          导入书籍
        </button>
      </div>
    </header>

    <!-- 工具条：搜索 / 排序 / 视图模式 -->
    <div class="shelf__toolbar">
      <label class="shelf__search">
        <span class="shelf__search-icon" aria-hidden="true">🔍</span>
        <input
          type="search"
          class="shelf__search-input"
          placeholder="搜索书名或作者"
          :value="store.keyword"
          @input="onSearchInput"
        >
      </label>

      <label class="shelf__field">
        <span>排序</span>
        <select class="shelf__select" :value="store.sortBy" @change="onSortChange">
          <option v-for="option in BOOK_SORT_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <div class="shelf__viewmode" role="group" aria-label="视图模式">
        <button
          type="button"
          class="ns-btn ns-btn--small"
          :class="{ 'ns-btn--active': store.viewMode === 'card' }"
          @click="store.setViewMode('card')"
        >
          卡片
        </button>
        <button
          type="button"
          class="ns-btn ns-btn--small"
          :class="{ 'ns-btn--active': store.viewMode === 'compact' }"
          @click="store.setViewMode('compact')"
        >
          紧凑
        </button>
      </div>
    </div>

    <!-- 回滚可见提示（不是错误文案：原因由 error-bus 展示） -->
    <div v-if="rollbackNotice" class="shelf__notice" role="status">
      <span class="shelf__notice-text">
        {{ rollbackNotice.action }}未生效 —— {{ rollbackNotice.hint }}。
      </span>
      <button type="button" class="ns-btn ns-btn--small" @click="rollbackNotice.retry()">重试</button>
      <button type="button" class="ns-btn ns-btn--small" @click="rollbackNotice = null">知道了</button>
    </div>

    <!-- 加载中：骨架占位，避免布局跳动 -->
    <LoadingBlock v-if="store.loading && !store.books.length" variant="skeleton" :rows="6" text="正在读取书架…" />

    <!-- 空态一：一本书都没有 -->
    <EmptyState
      v-else-if="store.isEmpty"
      title="书架还是空的"
      description="导入一本小说（支持 TXT / DOCX / PDF / 网页 / 直接粘贴正文），导入后就能分章、生成画本并开始录音。"
      icon="📚"
      hint="提示：把文件直接拖进导入向导的虚线框也可以"
      action-text="导入第一本书"
      @action="router.push({ path: '/import' })"
    />

    <!-- 空态二：有书但搜索无结果 -->
    <EmptyState
      v-else-if="store.noMatch"
      title="没有匹配的书籍"
      description="换一个关键词，或清空搜索条件看全部书籍。"
      icon="🔍"
      size="small"
      action-text="清空搜索"
      @action="store.setKeyword('')"
    />

    <!-- 卡片视图 -->
    <div v-else-if="store.viewMode === 'card'" class="shelf__grid">
      <article
        v-for="book in store.sortedBooks"
        :key="book.id"
        class="book-card"
        :class="{ 'book-card--busy': store.isBusy(book.id) }"
        :data-book-id="book.id"
      >
        <button
          type="button"
          class="book-card__body"
          :title="`打开《${book.title}》的章节管理`"
          @click="openBook(book)"
        >
          <div class="book-card__cover">
            <img v-if="coverOf(book)" :src="coverOf(book) ?? ''" :alt="`《${book.title}》封面`" class="book-card__cover-img">
            <span v-else class="book-card__cover-fallback" aria-hidden="true">📖</span>
          </div>
          <div class="book-card__info">
            <h3 class="book-card__title">{{ book.title }}</h3>
            <p class="book-card__author">
              {{ book.author || '佚名' }} · {{ SOURCE_LABELS[book.sourceType] }}
            </p>
            <p class="book-card__summary">{{ summaryOf(book) }}</p>
            <p class="book-card__meta">
              导入于 {{ formatDate(book.createdAt, 'YYYY-MM-DD') }}
              <span v-if="session.bookId === book.id" class="book-card__current">当前</span>
            </p>
          </div>
        </button>

        <!-- 重命名：就地编辑，Enter/blur 提交（单次 book:update，无需防抖） -->
        <div v-if="renamingId === book.id" class="book-card__rename">
          <input
            v-model="renameDraft"
            type="text"
            class="book-card__rename-input"
            maxlength="200"
            :placeholder="book.title"
            @keydown.enter.prevent="commitRename(book)"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename(book)"
          >
        </div>

        <footer class="book-card__ops">
          <button type="button" class="ns-btn ns-btn--small" @click="startRename(book)">重命名</button>
          <button type="button" class="ns-btn ns-btn--small" @click="revealBook(book)">显示在文件夹</button>
          <button type="button" class="ns-btn ns-btn--small" @click="openDelete(book, false)">删除</button>
          <button type="button" class="ns-btn ns-btn--small ns-btn--danger" @click="openDelete(book, true)">
            删除并清除音频
          </button>
        </footer>
      </article>
    </div>

    <!-- 紧凑视图 -->
    <ul v-else class="shelf__list">
      <li
        v-for="book in store.sortedBooks"
        :key="book.id"
        class="shelf-row"
        :class="{ 'shelf-row--busy': store.isBusy(book.id) }"
      >
        <button type="button" class="shelf-row__main" @click="openBook(book)">
          <span class="shelf-row__title">{{ book.title }}</span>
          <span class="shelf-row__author">{{ book.author || '佚名' }}</span>
          <span class="shelf-row__summary">{{ summaryOf(book) }}</span>
          <span class="shelf-row__time">{{ formatDate(book.createdAt, 'YYYY-MM-DD HH:mm') }}</span>
        </button>
        <div class="shelf-row__ops">
          <button type="button" class="ns-btn ns-btn--small" @click="startRename(book)">重命名</button>
          <button type="button" class="ns-btn ns-btn--small" @click="revealBook(book)">文件夹</button>
          <button type="button" class="ns-btn ns-btn--small" @click="openDelete(book, false)">删除</button>
          <button type="button" class="ns-btn ns-btn--small ns-btn--danger" @click="openDelete(book, true)">
            删除并清除音频
          </button>
        </div>
        <div v-if="renamingId === book.id" class="shelf-row__rename">
          <input
            v-model="renameDraft"
            type="text"
            class="book-card__rename-input"
            :placeholder="book.title"
            @keydown.enter.prevent="commitRename(book)"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename(book)"
          >
        </div>
      </li>
    </ul>

    <p v-if="!store.loading && store.books.length" class="shelf__foot">
      共 {{ formatInt(store.sortedBooks.length) }} 本显示中 · 点卡片进入章节管理 ·
      预估时长按全文字数（{{ formatCount(store.totalChars) }}字）与默认朗读语速 4.2 字/秒推算
    </p>

    <!-- 删除确认：输入书名才能删（ConfirmDialog 的 confirmKeyword） -->
    <ConfirmDialog
      v-model="deleteVisible"
      type="danger"
      :title="pendingDelete ? `删除《${pendingDelete.book.title}》？` : '删除书籍？'"
      message="这是一次破坏性操作：书籍、章节记录与画本都会被删除。"
      :details="deleteDetails"
      :confirm-keyword="pendingDelete?.book.title ?? null"
      :loading="pendingDelete ? store.isBusy(pendingDelete.book.id) : false"
      confirm-text="确认删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.shelf {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 20px 28px;
}
.shelf__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}
.shelf__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 20px;
  font-weight: 600;
}
.shelf__summary {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.shelf__head-actions {
  display: flex;
  gap: 8px;
}
.shelf__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.shelf__search {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 160px;
}
.shelf__search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  font-size: 13px;
}
.shelf__field {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
.shelf__select {
  padding: 6px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  font-size: 13px;
}
.shelf__viewmode {
  display: flex;
  gap: 4px;
}
.shelf__notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--ns-warning, #e6a23c);
  border-radius: 6px;
  background: rgb(230 162 60 / 10%);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.shelf__notice-text {
  flex: 1;
}
.shelf__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
.book-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 10px;
  background: var(--ns-bg-elevated, #fff);
  transition: box-shadow 0.15s ease;
}
.book-card:hover {
  box-shadow: 0 4px 16px rgb(0 0 0 / 8%);
}
.book-card--busy {
  opacity: 0.6;
  pointer-events: none;
}
.book-card__body {
  display: flex;
  flex: 1;
  gap: 12px;
  padding: 12px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.book-card__cover {
  display: flex;
  flex: 0 0 64px;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 88px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--ns-fill-light, #f5f7fa);
}
.book-card__cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.book-card__cover-fallback {
  font-size: 26px;
}
.book-card__info {
  min-width: 0;
}
.book-card__title {
  margin: 0;
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.book-card__author,
.book-card__meta {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.book-card__summary {
  margin: 6px 0 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.book-card__current {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--ns-primary, #409eff);
  color: #fff;
  font-size: 11px;
}
.book-card__rename {
  padding: 0 12px 8px;
}
.book-card__rename-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--ns-primary, #409eff);
  border-radius: 4px;
  font-size: 13px;
}
.book-card__ops {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--ns-border-light, #e4e7ed);
}
.shelf__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.shelf-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
}
.shelf-row:last-child {
  border-bottom: 0;
}
.shelf-row--busy {
  opacity: 0.6;
  pointer-events: none;
}
.shelf-row__main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 12px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.shelf-row__title {
  min-width: 140px;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
  font-weight: 500;
}
.shelf-row__author,
.shelf-row__time {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.shelf-row__summary {
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.shelf-row__ops {
  display: flex;
  gap: 6px;
}
.shelf-row__rename {
  flex: 1 0 100%;
}
.shelf__foot {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-btn {
  padding: 6px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn--small {
  padding: 4px 10px;
  font-size: 12px;
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-btn--danger {
  border-color: var(--ns-danger, #f56c6c);
  color: var(--ns-danger, #f56c6c);
}
.ns-btn--active {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
