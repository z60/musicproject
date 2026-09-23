/**
 * 书籍导入域 · 向导编排（docs/10 §7 / §7.1）
 * ============================================================================
 * 分工（与 stores/import.store.ts 的边界）：
 *   · store  = 数据与本地变换（草稿、编码选择、清洗开关、规则集），无流程决策；
 *   · 本文件 = **流程决策**：步骤守卫与原因、进入某一步要拉什么、改动后 300 ms
 *     重算预览、去重三选一、走哪条提交通道、任务的订阅/取消/重试、完成后的跳转。
 *
 * 三条硬性要求（都在这里兑现）：
 *   1. 「每一步都可后退，后退不丢已解析数据」——`prev()` 只改 step，
 *      重算预览只在**规则/清洗/来源变化**时发生（见 schedulePreview 的调用点）；
 *   2. 「未完成必填项时下一步禁用并说明原因」——`blockReason` 直接来自 store 的守卫，
 *      界面把它显示在按钮旁，绝不静默失败；
 *   3. 失败一定能重试——所有 catch 都走 error-bus 的 `reportError(..., { retryFn })`，
 *      文案与动作来自消息表（docs/22 §6.2），不在本文件里拼中文提示。
 *
 * 契约缺口（在本文件里被显式降级，见各处注释）：
 *   · `book:previewSplit` 只接受 filePath/text —— URL 来源无法预览（跳过 2~5 步）；
 *   · 返回里没有 contentHash —— 取不到时明确告知「本次跳过去重」，不自己算哈希；
 *   · `book:commitImport` 不接受 duplicatePolicy —— 「作为副本导入」只能走
 *     任务通道（importFile/importText/importUrl 的 options 是透传对象）。
 */

import { computed, onScopeDispose, ref } from 'vue'
import type { ComputedRef } from 'vue'
import { useRouter } from 'vue-router'
import { call, callSafe, on } from '@/shared/lib/ipc.ts'
import { reportByKey, reportError } from '@/shared/lib/error-bus.ts'
import { formatBytes } from '@/shared/lib/format.ts'
import { debounce } from '@/shared/lib/editable-debounce.ts'
import { decideProjectContext } from '@/shared/lib/project-context.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useTasksStore } from '@/app/store/tasks.store.ts'
import type { Book, Chapter } from '@shared/types.ts'
import {
  useImportStore,
  WIZARD_STEPS,
  type ImportOutcome,
  type WizardStep,
  type WizardStepDef,
} from '@/features/book/stores/import.store.ts'

/** 解析预览的防抖间隔（docs/10 §6.5：改规则 → 300 ms 后重算并显示「切出 N 章」） */
const PREVIEW_DEBOUNCE_MS = 300

/** 文件选择对话框的过滤器（docs/10 §2：TXT / DOCX / PDF） */
const FILE_FILTERS = [
  { name: '小说文本', extensions: ['txt', 'docx', 'pdf'] },
  { name: '纯文本', extensions: ['txt'] },
  { name: 'Word 文档', extensions: ['docx'] },
  { name: 'PDF', extensions: ['pdf'] },
]

export type SubmitResult = 'task-started' | 'committed' | 'duplicate' | 'failed' | 'blocked'

export interface ImportFlow {
  store: ReturnType<typeof useImportStore>
  steps: WizardStepDef[]
  step: ReturnType<typeof useImportStore>['step']
  blockReason: ReturnType<typeof useImportStore>['blockReason']
  canGoNext: ReturnType<typeof useImportStore>['canGoNext']
  canGoPrev: ReturnType<typeof useImportStore>['canGoPrev']
  /** 正在解析或提交（按钮 loading 用） */
  busy: ComputedRef<boolean>
  projectRootHint: ComputedRef<string>
  init: () => Promise<void>
  next: () => Promise<void>
  prev: () => void
  goto: (step: WizardStep) => void
  pickFile: () => Promise<void>
  onFileDropped: (path: string) => Promise<void>
  onPasteTextChanged: (text: string) => void
  onUrlChanged: (url: string) => void
  runPreviewNow: () => Promise<boolean>
  schedulePreview: () => void
  onSplitOptionsChanged: () => void
  onCleanOptionsChanged: () => void
  reloadEncoding: () => Promise<void>
  onEncodingSelected: (encoding: string) => Promise<void>
  saveRuleSetAs: (name: string) => Promise<void>
  removeRuleSet: (id: string) => Promise<void>
  setCover: () => Promise<void>
  onTargetBookChanged: (id: string | null) => Promise<void>
  submit: () => Promise<SubmitResult>
  openExistingBook: (bookId: string) => Promise<void>
  importAsCopy: () => Promise<SubmitResult>
  cancelDuplicate: () => void
  cancelTask: (taskId: string) => Promise<void>
  retryTask: (taskId: string) => Promise<void>
  goChapters: () => Promise<void>
  goCanvas: () => Promise<void>
  startOver: () => void
  dispose: () => void
}

export function useImportFlow(): ImportFlow {
  const store = useImportStore()
  const router = useRouter()
  const session = useSessionStore()
  const settings = useSettingsStore()
  const tasks = useTasksStore()

  const submitting = ref(false)
  const taskStartedAt = ref<number | null>(null)
  const watchingTaskId = ref<string | null>(null)
  let unwatchFinished: (() => void) | null = null

  const busy = computed(() => store.previewBusy || store.committing || submitting.value)

  const projectRootHint = computed(() => {
    return settings.settings?.paths.projectRoot
      ?? session.paths?.projectRoot
      ?? ''
  })

  // ---------------------------------------------------------------------------
  // 预览（防抖；docs/10 §6.5「实时预览」）
  // ---------------------------------------------------------------------------

  const debouncedPreview = debounce(() => { void store.runPreview() }, PREVIEW_DEBOUNCE_MS)

  async function runPreviewNow(): Promise<boolean> {
    debouncedPreview.cancel()
    return await store.runPreview()
  }

  function schedulePreview(): void {
    debouncedPreview()
  }

  /** 分章规则改动：立即重算（防抖），并保证「切出 N 章」是最新的 */
  function onSplitOptionsChanged(): void {
    schedulePreview()
  }

  /** 清洗开关改动：同样实时重算（docs/10 §7 Step4「改动后实时重算」） */
  function onCleanOptionsChanged(): void {
    schedulePreview()
  }

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------

  async function init(): Promise<void> {
    // 文件大小上限来自设置（settings.import.maxFileSizeBytes），失败回退常量
    await settings.load()
    const limit = settings.settings?.import.maxFileSizeBytes
    if (typeof limit === 'number') store.setMaxFileSizeBytes(limit)
    await resolveProjectContext()
  }

  /**
   * 项目上下文（docs/10 §7 的 Step6 前置）。
   *
   * 契约里没有「当前项目」通道，`projectId` 只能来自当前书籍或书架里的书；
   * **书架为空时不再判定为「没有项目上下文」**，而是落到主进程启动期就已经
   * `ensureDefault` 建好的默认项目上。判定规则抽在 `shared/lib/project-context.ts`
   * （纯函数，有单测）—— 因为这里正是死锁发生的地方：
   *
   *     导入需要项目 → 项目需要书 → 书需要导入
   *
   * 原先书架为空时提示用户「请先到书架导入或打开一本书」，而书架本来就是空的 ——
   * 全新安装永远导入不了第一本书。真机事故见 docs/91 §5.2.4。
   */
  async function resolveProjectContext(): Promise<string> {
    if (session.projectId) {
      store.setProjectContext(session.projectId, '')
      return session.projectId
    }
    const books = await callSafe('book:list', {})
    const list = Array.isArray(books) ? (books as Book[]) : []
    const decision = decideProjectContext({
      sessionProjectId: null,
      books: list.map(b => ({ title: b.title, projectId: b.projectId ?? null })),
    })
    // Step 6 顶部会展示「项目根目录」（生效值，含默认值），所以这里仍要保证路径已加载。
    // 注意：这个路径**只用于展示**，不再是「能否导入」的判据。
    if (!session.paths) await session.loadPaths()
    store.setProjectContext(decision.projectId, decision.hint)
    return decision.projectId
  }

  // ---------------------------------------------------------------------------
  // 步骤导航（进入某一步的副作用都收敛在这里）
  // ---------------------------------------------------------------------------

  function goto(step: WizardStep): void {
    store.goTo(step)
    void onStepEntered(step)
  }

  async function onStepEntered(step: WizardStep): Promise<void> {
    switch (step) {
      case 2:
        // 检测编码（仅文件来源有字节可嗅探）；随后做第一次解析预览
        if (store.canPreview && store.mode === 'file' && store.filePath && !store.detection) {
          await store.detectEncoding()
        }
        if (store.canPreview && !store.drafts.length && !store.previewBusy) {
          await runPreviewNow()
        }
        return
      case 3:
        if (!store.ruleSetsLoaded) await store.loadRuleSets()
        // 回退到第 3 步时**不重算**（docs/10 §7.1：后退不丢已解析数据）
        return
      case 6:
        store.ensureDefaultBookMeta()
        await resolveProjectContext()
        // 「追加到已有书籍」需要目标书列表；去重只对「新建书」有意义（追加不会新建）
        await store.loadBooks()
        if (store.contentHash && !store.appendMode) await store.checkDuplicate()
        return
      default:
        return
    }
  }

  async function next(): Promise<void> {
    if (!store.canGoNext) return
    const current = store.step
    // URL 来源没有预览通道：1 → 6（跳过 2~5，界面会说明原因）
    if (!store.canPreview && current === 1) {
      goto(6)
      return
    }
    goto((current + 1) as WizardStep)
  }

  function prev(): void {
    const current = store.step
    if (current <= 1) return
    // 只在「改过规则/清洗」时才重算；单纯后退不动数据（docs/10 §7.1）
    if (!store.canPreview && current === 6) {
      goto(1)
      return
    }
    goto((current - 1) as WizardStep)
  }

  // ---------------------------------------------------------------------------
  // Step 1：来源
  // ---------------------------------------------------------------------------

  async function pickFile(): Promise<void> {
    const result = await callSafe('app:openFileDialog', {
      title: '选择要导入的小说文件',
      filters: FILE_FILTERS,
      multi: false,
    })
    const path = result?.paths?.[0]
    if (!path) return
    await onFileDropped(path)
  }

  async function onFileDropped(path: string): Promise<void> {
    store.setMode('file')
    store.setFilePath(path)
    await store.runProbe()
    if (store.fileTooLarge) {
      // 上限来自 settings.import.maxFileSizeBytes；文案与动作由消息表给出（FILE_TOO_LARGE）
      reportByKey('FILE_TOO_LARGE', {
        size: formatBytes(store.probe?.sizeBytes ?? 0),
        max: formatBytes(store.maxFileSizeBytes),
      }, { event: 'book.import.fileTooLarge' })
    }
  }

  function onPasteTextChanged(text: string): void {
    store.setPasteText(text)
  }

  function onUrlChanged(url: string): void {
    store.setUrl(url)
  }

  // ---------------------------------------------------------------------------
  // Step 2：编码
  // ---------------------------------------------------------------------------

  async function reloadEncoding(): Promise<void> {
    await store.detectEncoding()
  }

  /**
   * 用户选定编码。
   * ⚠️ 契约缺口：`book:previewSplit` 没有 encoding 入参（主进程 schema 会把未声明字段 strip 掉），
   * 因此这里**重新解析**让用户看到最新结果，同时界面用 `encodingDiffersFromParsed`
   * 明确提示「主进程仍按嗅探结果解码」。不假装用户的选择已经改变了字节解码。
   */
  async function onEncodingSelected(encoding: string): Promise<void> {
    store.selectEncoding(encoding)
    if (store.canPreview) await runPreviewNow()
  }

  // ---------------------------------------------------------------------------
  // Step 3：规则集保存 / 删除
  // ---------------------------------------------------------------------------

  async function saveRuleSetAs(name: string): Promise<void> {
    const saved = await store.saveRuleSetAs(name)
    if (saved) await runPreviewNow()
  }

  async function removeRuleSet(id: string): Promise<void> {
    const removed = await store.deleteRuleSet(id)
    if (removed) await runPreviewNow()
  }

  // ---------------------------------------------------------------------------
  // Step 6：封面与提交
  // ---------------------------------------------------------------------------

  /**
   * 切换「导入到」的目标：null = 新建书籍。
   * 切回新建时要重新跑去重（之前追加模式跳过过），切到追加时清掉去重结果。
   */
  async function onTargetBookChanged(id: string | null): Promise<void> {
    store.setTargetBookId(id)
    if (id) return
    if (store.contentHash) await store.checkDuplicate()
  }

  async function setCover(): Promise<void> {
    const result = await callSafe('app:openFileDialog', {
      title: '选择封面图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      multi: false,
    })
    const path = result?.paths?.[0]
    if (path) store.setBookMeta({ coverPath: path })
  }

  /**
   * 走任务通道（`book:importFile` / `book:importText` / `book:importUrl`）。
   * 只有 URL 来源、或用户确认「作为副本导入」时才用它：
   * 任务通道按**源文件**重新解析，第 5 步的人工改名/合并结果不会被带入
   * （`book:commitImport` 才是携带 drafts 的通道，界面会就此给出警告）。
   */
  async function submitViaTask(duplicatePolicy: 'error' | 'copy'): Promise<SubmitResult> {
    // 缺上下文时**先尝试解析**（现在解析一定会给出项目），只有真的拿不到才拦。
    // 原来这里是「报错 + return blocked」，等于把用户送进死路。
    if (!store.projectId) await resolveProjectContext()
    if (!store.projectId) {
      store.setCommitError('NO_PROJECT', '缺少项目上下文')
      return 'blocked'
    }
    const options = store.buildTaskOptions(duplicatePolicy)
    submitting.value = true
    try {
      let taskId: string | null = null
      if (store.mode === 'url') {
        const result = await call('book:importUrl', {
          projectId: store.projectId,
          url: store.url.trim(),
          options,
        }, { onError: 'silent' }) as { taskId: string }
        taskId = result?.taskId ?? null
      } else if (store.mode === 'paste') {
        const result = await call('book:importText', {
          projectId: store.projectId,
          text: store.pasteText,
          title: store.bookMeta.title.trim(),
          options,
        }, { onError: 'silent' }) as { taskId: string }
        taskId = result?.taskId ?? null
      } else if (store.filePath) {
        const result = await call('book:importFile', {
          projectId: store.projectId,
          filePath: store.filePath,
          options,
        }, { onError: 'silent' }) as { taskId: string }
        taskId = result?.taskId ?? null
      } else {
        store.setCommitError('NO_SOURCE', '缺少导入来源')
        return 'blocked'
      }

      if (!taskId) {
        store.setCommitError('NO_TASK', '主进程没有返回任务编号')
        return 'failed'
      }
      taskStartedAt.value = Date.now()
      store.markTaskStarted(taskId)
      watchTask(taskId)
      goto(7)
      return 'task-started'
    } catch (error) {
      store.setCommitError('TASK_SUBMIT_FAILED', '任务提交失败')
      reportError(error, { event: 'book.import.submitTaskFailed', retryFn: () => { void submit() } })
      return 'failed'
    } finally {
      submitting.value = false
    }
  }

  function watchTask(taskId: string): void {
    unwatchFinished?.()
    watchingTaskId.value = taskId
    unwatchFinished = on('task:finished', (payload) => {
      if (payload.taskId !== taskId) return
      void handleTaskFinished(taskId, payload.status, payload.result, payload.error)
    })
  }

  async function handleTaskFinished(
    taskId: string,
    status: string,
    result: unknown,
    error: unknown,
  ): Promise<void> {
    if (status === 'succeeded') {
      const raw = result ?? await tasks.result<Record<string, unknown>>(taskId)
      store.setOutcome(toOutcome(raw, taskId))
      await adoptBook(store.outcome?.bookId ?? null)
      goto(7)
      return
    }
    if (status === 'cancelled') {
      // 取消不是错误（docs/22：取消类错误直接吞掉），回到确认页让用户重来
      goto(6)
      return
    }
    store.setCommitError('IMPORT_TASK_FAILED', '导入任务失败')
    if (error) {
      reportError(error, { event: 'book.import.taskFailed', retryFn: () => retryTask(taskId) })
    } else {
      reportByKey('TASK_FAILED', { name: '导入书籍' }, {
        event: 'book.import.taskFailed',
        retryFn: () => retryTask(taskId),
      })
    }
  }

  function toOutcome(raw: unknown, taskId: string): ImportOutcome {
    const record = (raw ?? {}) as Record<string, unknown>
    const bookId = typeof record.bookId === 'string' ? record.bookId : null
    const chapterCount = typeof record.chapterCount === 'number' ? record.chapterCount : store.includedCount
    const startedAt = taskStartedAt.value ?? Date.now()
    return { bookId, chapterCount, taskId, elapsedMs: Math.max(0, Date.now() - startedAt) }
  }

  /**
   * Step 6 的「开始导入」。
   * 默认走 `book:commitImport`（唯一能带上第 5 步人工干预结果的通道）；
   * 命中去重且用户选择「作为副本导入」时改走任务通道（见 submitViaTask 的注释）。
   */
  async function submit(): Promise<SubmitResult> {
    if (!store.canCommit) return 'blocked'
    if (store.mode === 'url') return await submitViaTask('error')

    submitting.value = true
    const startedAt = Date.now()
    try {
      const result = await store.commitImport()
      if (result?.bookId) {
        store.setOutcome({
          bookId: result.bookId,
          chapterCount: result.chapterCount ?? store.includedCount,
          taskId: null,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        })
        await adoptBook(result.bookId)
        goto(7)
        return 'committed'
      }
      if (store.duplicate) return 'duplicate'
      // 失败：error-bus 兑现 + 重试按钮（重试就是再跑一次同样的提交）
      if (store.lastError) {
        reportError(store.lastError, {
          event: 'book.import.commitFailed',
          retryFn: () => { void submit() },
        })
      } else {
        reportByKey('TASK_FAILED', { name: '导入书籍' }, {
          event: 'book.import.commitFailed',
          retryFn: () => { void submit() },
        })
      }
      return 'failed'
    } finally {
      submitting.value = false
    }
  }

  /** 命中去重时的「打开已有书籍」（docs/10 §9 三选一，绝不静默选择） */
  async function openExistingBook(bookId: string): Promise<void> {
    await adoptBook(bookId)
    store.clearDuplicate()
    await router.push({ path: '/chapters' })
  }

  /** 命中去重时的「作为副本导入」：只能走任务通道（commitImport 不接受 duplicatePolicy） */
  async function importAsCopy(): Promise<SubmitResult> {
    store.acknowledgeDuplicate()
    return await submitViaTask('copy')
  }

  function cancelDuplicate(): void {
    store.clearDuplicate()
    goto(5)
  }

  async function adoptBook(bookId: string | null): Promise<void> {
    if (!bookId) return
    const book = await callSafe('book:get', { bookId })
    if (book) session.selectBook(book as Book)
  }

  // ---------------------------------------------------------------------------
  // 任务取消 / 重试
  // ---------------------------------------------------------------------------

  async function cancelTask(taskId: string): Promise<void> {
    await tasks.cancel(taskId)
  }

  async function retryTask(taskId: string): Promise<void> {
    const nextTaskId = await tasks.retry(taskId)
    if (!nextTaskId) {
      reportByKey('TASK_FAILED', { name: '导入书籍' }, { event: 'book.import.retryFailed' })
      return
    }
    taskStartedAt.value = Date.now()
    store.markTaskStarted(nextTaskId)
    watchTask(nextTaskId)
  }

  // ---------------------------------------------------------------------------
  // 完成后跳转
  // ---------------------------------------------------------------------------

  async function goChapters(): Promise<void> {
    if (store.outcome?.bookId) await adoptBook(store.outcome.bookId)
    await router.push({ path: '/chapters' })
  }

  /** docs/10 §7.1：Step7 的「生成画本」→ 画本编辑（需要先定位到一章） */
  async function goCanvas(): Promise<void> {
    if (store.outcome?.bookId) {
      await adoptBook(store.outcome.bookId)
      const list = await callSafe('chapter:list', { bookId: store.outcome.bookId })
      const first = Array.isArray(list) ? (list as Array<{ id: string }>)[0] : undefined
      if (first) {
        const chapter = await callSafe('chapter:get', { chapterId: first.id })
        if (chapter) session.selectChapter(chapter as Chapter)
      }
    }
    await router.push({ path: '/canvas' })
  }

  function startOver(): void {
    debouncedPreview.cancel()
    store.reset()
    void resolveProjectContext()
  }

  function dispose(): void {
    debouncedPreview.cancel()
    unwatchFinished?.()
    unwatchFinished = null
  }

  // 组件卸载：取消防抖与任务订阅（否则切页后仍会触发重算/跳转）
  onScopeDispose(dispose)

  return {
    store,
    steps: WIZARD_STEPS,
    step: store.step,
    blockReason: store.blockReason,
    canGoNext: store.canGoNext,
    canGoPrev: store.canGoPrev,
    busy,
    projectRootHint,
    init,
    next,
    prev,
    goto,
    pickFile,
    onFileDropped,
    onPasteTextChanged,
    onUrlChanged,
    runPreviewNow,
    schedulePreview,
    onSplitOptionsChanged,
    onCleanOptionsChanged,
    reloadEncoding,
    onEncodingSelected,
    saveRuleSetAs,
    removeRuleSet,
    setCover,
    onTargetBookChanged,
    submit,
    openExistingBook,
    importAsCopy,
    cancelDuplicate,
    cancelTask,
    retryTask,
    goChapters,
    goCanvas,
    startOver,
    dispose,
  }
}
