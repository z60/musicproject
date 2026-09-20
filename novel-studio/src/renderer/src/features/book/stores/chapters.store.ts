/**
 * 书籍导入域 · 章节管理状态（docs/10 §7.2「导入完成后」）
 * ============================================================================
 * 职责：
 *   · 章节列表（`chapter:list`，含 `progress` 视图数据）；
 *   · 单章编辑（改名 / 改类型 / 改卷名）、批量操作（拖拽与上下移排序、合并、拆分、删除）；
 *   · 「生成画本」（`canvas:generate`）的任务登记 —— 进度 UI 一律交给全局 TaskProgressCard
 *     （docs/04 §2.4 禁止自建进度 UI）。
 *
 * 一致性策略：
 *   · 改名/改类型/排序 = **乐观更新 + 失败回滚**（用户立刻看到结果，失败不留假状态）；
 *   · 合并/拆分/删除 = 服务端返回权威结果后 `load()` 重取（章节边界与字数是主进程算的，
 *     本地推演没有意义，宁可多一次 IPC 也不要显示错的字数）。
 *
 * 章节正文读取（重要缺口）：
 *   契约里**没有任何通道能读回章节正文**（`chapter:get` 只有元数据，
 *   `canvas:getChapter` 返回的是画本行）。因此 ChapterMergeDialog 的边界预览对
 *   「已入库章节」只能显示「正文不可读」并仍允许合并（详见该组件的注释）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { CANVAS_DEFAULTS, VAD_DEFAULTS } from '@shared/constants.ts'
import type {
  ActorWorkload,
  CanvasGenerateOptions,
  Chapter,
  ChapterCanvasState,
  ChapterKind,
  ChapterProgress,
} from '@shared/types.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { estimateDurationMs } from '@/features/book/stores/import.store.ts'

/** 章节列表行（`chapter:list` 的响应元素） */
export type ChapterRow = Chapter & { progress: ChapterProgress | null }

export const CHAPTER_KIND_LABELS: Record<ChapterKind, string> = {
  chapter: '正文',
  front: '前言',
  back: '后记',
  extra: '番外',
  volume: '卷',
}

export const CHAPTER_KIND_OPTIONS: Array<{ value: ChapterKind; label: string }> = (
  ['chapter', 'front', 'back', 'extra', 'volume'] as ChapterKind[]
).map(value => ({ value, label: CHAPTER_KIND_LABELS[value] }))

/** 画本状态（docs/10 §7.2：未生成 / 已生成 / 部分录音 / 已完成） */
export const CANVAS_STATE_LABELS: Record<ChapterCanvasState, string> = {
  none: '未生成',
  generated: '已生成',
  edited: '已编辑',
  done: '已完成',
}

export const CANVAS_STATE_TYPES: Record<ChapterCanvasState, 'info' | 'primary' | 'warning' | 'success'> = {
  none: 'info',
  generated: 'primary',
  edited: 'warning',
  done: 'success',
}

export interface ChapterStatsSummary {
  count: number
  chars: number
  estimatedDurationMs: number
  /** 已完成录音时长（v_chapter_progress.audio_ms 汇总） */
  recordedMs: number
  canvasNone: number
  canvasDone: number
}

export const useChaptersStore = defineStore('book/chapters', () => {
  const rows = ref<ChapterRow[]>([])
  const loading = ref(false)
  const lastError = ref<unknown>(null)
  const bookId = ref<string | null>(null)
  /** 顶栏搜索带过来的关键词（路由 query ?q=，见 TopBar.vue） */
  const keyword = ref('')
  /** 正在写库的章节 id */
  const busyIds = ref<string[]>([])
  /**
   * 已提交的「生成画本」任务：chapterId → { taskId, bookId }。
   *
   * 为什么每个任务都要带 `bookId`：这张表是**界面级**登记（章节管理用它渲染进度卡），
   * 而 store 是单例、切书时不会重建 —— 不带 bookId 就会把上一本书的任务显示到本书的
   * 章节管理里，而 `chapterTitleOf` 在本书里找不到那个章节，只能回退成 uuid，
   * 于是界面上出现「生成画本：1925adee-…」这种**非本书的提示**（真机反馈 docs/91 §5.2.35）。
   */
  const canvasTasks = ref<Record<string, { taskId: string; bookId: string }>>({})
  const workloads = ref<ActorWorkload[]>([])
  const workloadLoading = ref(false)

  // ---------------------------------------------------------------------------
  // 派生
  // ---------------------------------------------------------------------------

  const visibleRows = computed<ChapterRow[]>(() => {
    const query = keyword.value.trim().toLowerCase()
    if (!query) return rows.value
    return rows.value.filter(row =>
      row.title.toLowerCase().includes(query)
      || (row.volumeTitle ?? '').toLowerCase().includes(query),
    )
  })

  const stats = computed<ChapterStatsSummary>(() => {
    let chars = 0
    let recordedMs = 0
    let canvasNone = 0
    let canvasDone = 0
    for (const row of rows.value) {
      chars += row.charCount
      recordedMs += row.progress?.audioMs ?? 0
      if (row.canvasState === 'none') canvasNone++
      if (row.canvasState === 'done') canvasDone++
    }
    return {
      count: rows.value.length,
      chars,
      estimatedDurationMs: estimateDurationMs(chars),
      recordedMs,
      canvasNone,
      canvasDone,
    }
  })

  const volumeTitles = computed<string[]>(() => {
    const set = new Set<string>()
    for (const row of rows.value) if (row.volumeTitle) set.add(row.volumeTitle)
    return [...set]
  })

  const runningCanvasTaskIds = computed<string[]>(() =>
    Object.values(canvasTasks.value).map(task => task.taskId))

  /** 单章预估时长（字数 / 4.2 字每秒，docs/10 §6.6） */
  function durationOf(row: ChapterRow): number {
    return estimateDurationMs(row.charCount, VAD_DEFAULTS.charsPerSecond)
  }

  /** 录音完成度（recordedCount / lineCount） */
  function progressOf(chapterId: string): ChapterProgress | null {
    return rows.value.find(r => r.id === chapterId)?.progress ?? null
  }

  function isBusy(chapterId: string): boolean {
    return busyIds.value.includes(chapterId)
  }

  function setBusy(chapterId: string, busy: boolean): void {
    busyIds.value = busy
      ? [...new Set([...busyIds.value, chapterId])]
      : busyIds.value.filter(id => id !== chapterId)
  }

  function getById(chapterId: string): ChapterRow | null {
    return rows.value.find(r => r.id === chapterId) ?? null
  }

  function setKeyword(value: string): void {
    keyword.value = value
  }

  // ---------------------------------------------------------------------------
  // 读取
  // ---------------------------------------------------------------------------

  async function load(nextBookId: string): Promise<ChapterRow[]> {
    /**
     * 换书时丢掉上一本书的**配音员分工**（它按 bookId 算，留着就是别的书的数字）。
     *
     * 画本任务登记（`canvasTasks`）不清：每条都带 bookId，由 `currentBookCanvasTasks`
     * 按当前书过滤 —— 这样切回原书时进度卡还在，而本书永远不会显示别的书的任务。
     */
    if (bookId.value !== null && bookId.value !== nextBookId) {
      workloads.value = []
      // 行级忙碌态也是上一本书的章节 id，留着没有意义（换书后那些行根本不在列表里）
      busyIds.value = []
    }
    bookId.value = nextBookId
    loading.value = true
    try {
      const list = await call('chapter:list', { bookId: nextBookId })
      rows.value = Array.isArray(list)
        ? (list as ChapterRow[]).map(row => ({ ...row, progress: row.progress ?? null }))
        : []
      lastError.value = null
      return rows.value
    } catch (error) {
      lastError.value = error
      return rows.value
    } finally {
      loading.value = false
    }
  }

  async function reload(): Promise<void> {
    if (bookId.value) await load(bookId.value)
  }

  // ---------------------------------------------------------------------------
  // 单章编辑
  // ---------------------------------------------------------------------------

  function patchLocal(chapterId: string, patch: Partial<Chapter>): void {
    rows.value = rows.value.map(row => (row.id === chapterId ? { ...row, ...patch } : row))
  }

  /**
   * 更新章节（改名 / 改类型 / 改卷名）。
   * 乐观更新 + 失败回滚，返回服务端返回的章节（失败为 null，原因由 error-bus 给出）。
   */
  async function updateChapter(
    chapterId: string,
    patch: Partial<Pick<Chapter, 'title' | 'kind' | 'volumeTitle'>>,
  ): Promise<Chapter | null> {
    const index = rows.value.findIndex(r => r.id === chapterId)
    if (index < 0) return null
    const before = rows.value[index]!
    setBusy(chapterId, true)
    patchLocal(chapterId, patch)
    try {
      const updated = await call('chapter:update', { chapterId, patch }) as Chapter
      const next = updated ?? { ...before, ...patch }
      patchLocal(chapterId, next)
      return next
    } catch (error) {
      lastError.value = error
      patchLocal(chapterId, before)
      return null
    } finally {
      setBusy(chapterId, false)
    }
  }

  function rename(chapterId: string, title: string): Promise<Chapter | null> {
    const next = title.trim()
    if (!next) return Promise.resolve(null)
    return updateChapter(chapterId, { title: next })
  }

  function setKind(chapterId: string, kind: ChapterKind): Promise<Chapter | null> {
    return updateChapter(chapterId, { kind })
  }

  function setVolumeTitle(chapterId: string, volumeTitle: string): Promise<Chapter | null> {
    const value = volumeTitle.trim()
    return updateChapter(chapterId, { volumeTitle: value })
  }

  // ---------------------------------------------------------------------------
  // 排序
  // ---------------------------------------------------------------------------

  /**
   * 按给定顺序重排（拖拽 / 上移下移）。`chapter:reorder` 只返回 ok，
   * 因此本地按新顺序重算 seq（界面立刻正确），失败则整体回滚。
   */
  async function reorder(orderedIds: string[]): Promise<boolean> {
    if (!bookId.value) return false
    const before = rows.value
    const map = new Map(before.map(row => [row.id, row]))
    const next = orderedIds
      .map(id => map.get(id))
      .filter((row): row is ChapterRow => !!row)
      .map((row, i) => ({ ...row, seq: i + 1 }))
    if (next.length !== before.length) return false

    rows.value = next
    try {
      await call('chapter:reorder', { bookId: bookId.value, orderedIds })
      return true
    } catch (error) {
      lastError.value = error
      rows.value = before
      return false
    }
  }

  /** 上移/下移 delta 位（边界返回 false，不静默） */
  async function moveBy(chapterId: string, delta: number): Promise<boolean> {
    const index = rows.value.findIndex(r => r.id === chapterId)
    if (index < 0) return false
    const target = index + delta
    if (target < 0 || target >= rows.value.length) return false
    const ids = rows.value.map(r => r.id)
    const [moved] = ids.splice(index, 1)
    if (!moved) return false
    ids.splice(target, 0, moved)
    return await reorder(ids)
  }

  // ---------------------------------------------------------------------------
  // 合并 / 拆分 / 删除
  // ---------------------------------------------------------------------------

  /** 合并多章（docs/10 §7.1）；成功后重取列表（章边界与字数由主进程权威给出） */
  async function merge(chapterIds: string[], title: string): Promise<Chapter | null> {
    if (chapterIds.length < 2) return null
    try {
      const merged = await call('chapter:merge', { chapterIds, title }) as Chapter
      await reload()
      return merged
    } catch (error) {
      lastError.value = error
      return null
    }
  }

  /**
   * 拆分一章（docs/10 §7.1）。
   * `atOffsets` 是**章节正文内的偏移**，而 `chapter:split` 的语义与
   * `Chapter.startOffset`（相对全书文本）一致，因此这里统一换算成全书偏移，
   * 避免主进程实现变更时出现「切在别处」的隐性错误。
   */
  async function split(chapterId: string, atOffsets: number[]): Promise<Chapter[] | null> {
    const row = getById(chapterId)
    if (!row) return null
    const base = row.startOffset ?? 0
    const absolute = [...new Set(atOffsets)]
      .map(offset => Math.round(offset) + base)
      .filter(offset => offset > row.startOffset && offset < row.endOffset)
      .sort((a, b) => a - b)
    if (!absolute.length) return null
    try {
      const created = await call('chapter:split', { chapterId, atOffsets: absolute }) as Chapter[]
      await reload()
      return created
    } catch (error) {
      lastError.value = error
      return null
    }
  }

  /** 删除章节（破坏性操作，调用方必须先过 ConfirmDialog） */
  async function remove(chapterId: string): Promise<boolean> {
    const index = rows.value.findIndex(r => r.id === chapterId)
    if (index < 0) return false
    const before = rows.value[index]!
    setBusy(chapterId, true)
    rows.value = rows.value.filter(r => r.id !== chapterId)
    try {
      await call('chapter:delete', { chapterId })
      // seq 需要以服务端为准重排
      await reload()
      return true
    } catch (error) {
      lastError.value = error
      const list = [...rows.value]
      list.splice(Math.min(index, list.length), 0, before)
      rows.value = list
      return false
    } finally {
      setBusy(chapterId, false)
    }
  }

  // ---------------------------------------------------------------------------
  // 生成画本（docs/11 的入口）
  // ---------------------------------------------------------------------------

  /**
   * 生成选项：阈值/边界/上下文窗口等**一律读设置**（docs/06 §5.2），
   * 不在代码里硬编码默认值 —— 用户在设置里改了阈值，这里的按钮行为要跟着变。
   * `overwriteHuman` 恒为 false：docs/11 明确「永不覆盖人工确认过的行」。
   */
  function defaultGenerateOptions(): CanvasGenerateOptions {
    const settings = useSettingsStore()
    const canvas = settings.settings?.canvas
    return {
      useEmbedding: settings.embeddingReady,
      useLlm: false,
      contextWindow: canvas?.contextWindow ?? CANVAS_DEFAULTS.contextWindow,
      threshold: canvas?.attributionThreshold ?? CANVAS_DEFAULTS.attributionThreshold,
      margin: canvas?.attributionMargin ?? CANVAS_DEFAULTS.attributionMargin,
      ruleSetId: null,
      overwriteHuman: false,
      inferTags: true,
    }
  }

  /**
   * 批量生成画本：逐章提交（`canvas:generate` 的载荷是单章），
   * 每章登记一个 taskId，进度全部交给全局 TaskProgressCard。
   * 返回成功提交的章节数；失败逐条静默收集（由调用方汇总提示，避免刷屏）。
   */
  async function generateCanvas(
    chapterIds: string[],
    options?: CanvasGenerateOptions,
  ): Promise<{ submitted: number; failed: string[] }> {
    const opts = options ?? defaultGenerateOptions()
    const failed: string[] = []
    let submitted = 0
    for (const chapterId of chapterIds) {
      try {
        const result = await call('canvas:generate', { chapterId, options: opts }, { onError: 'silent' }) as { taskId: string }
        if (result?.taskId) {
          canvasTasks.value = {
            ...canvasTasks.value,
            [chapterId]: { taskId: result.taskId, bookId: bookId.value ?? '' },
          }
          submitted++
        } else {
          failed.push(chapterId)
        }
      } catch {
        failed.push(chapterId)
      }
    }
    return { submitted, failed }
  }

  /** 某章已提交的生成任务 id（视图据此渲染 TaskProgressCard） */
  function taskIdOf(chapterId: string): string | null {
    return canvasTasks.value[chapterId]?.taskId ?? null
  }

  /**
   * **当前这本书**已提交的生成任务（视图渲染进度卡用）。
   *
   * 按 `bookId` 过滤是刻意的：没有这道过滤，切书后「章节管理」会把上一本书的
   * 「生成画本」提示继续显示出来（真机反馈 docs/91 §5.2.35）。
   */
  const currentBookCanvasTasks = computed<Array<{ chapterId: string; taskId: string }>>(() => {
    const id = bookId.value
    if (!id) return []
    return Object.entries(canvasTasks.value)
      .filter(([, task]) => task.bookId === id)
      .map(([chapterId, task]) => ({ chapterId, taskId: task.taskId }))
  })

  function clearCanvasTask(chapterId: string): void {
    const next = { ...canvasTasks.value }
    delete next[chapterId]
    canvasTasks.value = next
  }

  // ---------------------------------------------------------------------------
  // 配音员分工概览（docs/10 §7.2：配合 11/07）
  // ---------------------------------------------------------------------------

  async function loadWorkload(targetBookId?: string): Promise<ActorWorkload[]> {
    const id = targetBookId ?? bookId.value
    if (!id) return []
    workloadLoading.value = true
    try {
      const list = await call('voiceActor:workload', { bookId: id }) as ActorWorkload[]
      workloads.value = Array.isArray(list) ? list : []
      return workloads.value
    } catch {
      workloads.value = []
      return []
    } finally {
      workloadLoading.value = false
    }
  }

  /** 静默刷新某一章的进度（录音完成后回到本页时用） */
  async function refreshProgress(chapterId: string): Promise<void> {
    const progress = await callSafe('chapter:stats', { chapterId })
    if (!progress) return
    rows.value = rows.value.map(row => (row.id === chapterId ? { ...row, progress } : row))
  }

  function reset(): void {
    rows.value = []
    bookId.value = null
    keyword.value = ''
    canvasTasks.value = {}
    workloads.value = []
    busyIds.value = []
    lastError.value = null
  }

  return {
    rows, loading, lastError, bookId, keyword, busyIds, canvasTasks, workloads, workloadLoading,
    visibleRows, stats, volumeTitles, runningCanvasTaskIds, currentBookCanvasTasks,
    durationOf, progressOf, isBusy, getById, setKeyword,
    load, reload, updateChapter, rename, setKind, setVolumeTitle,
    reorder, moveBy, merge, split, remove,
    defaultGenerateOptions, generateCanvas, taskIdOf, clearCanvasTask,
    loadWorkload, refreshProgress, reset,
  }
})
