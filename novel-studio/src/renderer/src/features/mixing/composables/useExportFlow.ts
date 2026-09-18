/**
 * Novel Studio · 导出流程编排（docs/15 §5.4 / §5.5 Step 7~8）
 * ============================================================================
 * 职责（这是「导出向导」里唯一会真正调导出 IPC 的地方）：
 *   · 开始导出：按范围选择 `export:chapter` / `export:book` / `export:m4b`
 *   · 订阅 `export:progress`（**节流**后落 UI：主进程 ≤10/s，UI 不需要那么细）
 *   · 取消（`task:cancel`）/ 重试（`task:retry`）/ 断点续传说明
 *   · 完成或失败后拉 `export:report`，并用 `reportBatchFailures` 把批量失败**汇总成一条**
 *     （docs/22 §7：逐个失败刷屏是最糟的体验）
 *   · 导出过程中离开页面必须拦下来（路由离开守卫 + beforeunload）
 *
 * 三条纪律：
 *   1. 所有 IPC 失败都交给 error-bus（`call` 默认已兑现），本文件**不自拼错误文案**；
 *      需要展示「哪个环节失败了」时用消息表里的键（`getMessage`）。
 *   2. 进度不自己算：`task:progress` 由 `useTaskProgress` 统一消费（docs/04 §2.4），
 *      本文件只额外消费 `export:progress` 的章级信息（当前章 N/M、速率）。
 *   3. 离开守卫在**任务未结束时**才生效；取消掉的任务不阻塞用户切页。
 */

import { computed, onScopeDispose, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { AppError } from '@shared/errors.ts'
import { getMessage } from '@shared/messages.ts'
import type { Chapter, ExportReport } from '@shared/types.ts'
import type { IpcEventPayload, IpcRes } from '@shared/ipc.ts'
import { call, callSafe, on } from '@/shared/lib/ipc.ts'
import { reportBatchFailures, reportError } from '@/shared/lib/error-bus.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import { sanitizeFileName } from '@/shared/lib/template.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useTasksStore } from '@/app/store/tasks.store.ts'
import { cloneForIpc } from '@/shared/lib/clone.ts'
import { useExportStore } from '../stores/export.store.ts'
import { useQcStore } from '../stores/qc.store.ts'

/** `export:progress` 事件的载荷（唯一来源：src/shared/ipc.ts 的事件契约） */
export type ExportProgressEvent = IpcEventPayload<'export:progress'>

/** UI 上显示的进度快照（`export:progress` 节流后的结果） */
export interface ExportFlowProgress {
  taskId: string
  currentChapter: number
  totalChapters: number
  stage: string
  elapsedMs: number
  etaMs: number | null
  /** 章/秒（主进程给的「实时速率」） */
  speed: number | null
  updatedAt: number
}

/** 跳转目标（预检项上的「去处理」按钮） */
export type ExportJumpTarget = 'canvas' | 'alignment' | 'chapters' | 'settings'

/** `export:progress` 的 UI 节流间隔（主进程已 ≤10/s，这里再降到 5/s，避免无谓重渲染） */
const PROGRESS_THROTTLE_MS = 200

/** 把导出目录与相对路径拼成绝对路径（Electron 在 Windows 上也接受正斜杠） */
export function joinOutputPath(dir: string, relative: string): string {
  const base = dir.replace(/[\\/]+$/, '')
  const rel = relative.replace(/^[\\/]+/, '')
  if (!base) return rel
  if (!rel) return base
  return `${base}/${rel}`
}

/** 从未知形状的任务结果里挖出 jobId（result 可能是 {jobId} / {report:{jobId}} / ExportReport 本身） */
export function extractJobId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  if (typeof record.jobId === 'string') return record.jobId
  const nested = record.report
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).jobId === 'string') {
    return (nested as Record<string, unknown>).jobId as string
  }
  return null
}

export function useExportFlow() {
  const store = useExportStore()
  const qc = useQcStore()
  const tasks = useTasksStore()
  const session = useSessionStore()
  const router = useRouter()

  const { taskId } = storeToRefs(store)

  /** 统一的任务进度（进度卡与「剩余时间」都由它驱动，docs/04 §2.4） */
  const live = useTaskProgress(taskId)

  /** 章级进度（`export:progress` 节流后的快照） */
  const progressEvent = ref<ExportFlowProgress | null>(null)
  /** 正在提交导出请求（点「开始导出」到拿到 taskId 之间） */
  const starting = ref(false)
  /** 拉报告失败（用户可手动重试，报告面板据此给按钮） */
  const reportUnavailable = ref(false)
  /** 离开页面确认框（由视图渲染 ConfirmDialog，v-model 绑这个） */
  const leaveConfirmVisible = ref(false)

  // ── export:progress 订阅 + 节流 ──────────────────────────────────────────

  let offProgress: (() => void) | null = null
  let throttleTimer: ReturnType<typeof setTimeout> | null = null
  let pendingProgress: ExportFlowProgress | null = null
  let lastAppliedAt = 0

  function flushProgress(): void {
    if (!pendingProgress) return
    progressEvent.value = pendingProgress
    pendingProgress = null
    lastAppliedAt = Date.now()
  }

  /** 节流：先到先出，末次一定落地（否则进度会停在 99% 不动） */
  function patchProgress(next: ExportFlowProgress): void {
    pendingProgress = next
    const elapsed = Date.now() - lastAppliedAt
    if (elapsed >= PROGRESS_THROTTLE_MS) {
      if (throttleTimer) {
        clearTimeout(throttleTimer)
        throttleTimer = null
      }
      flushProgress()
      return
    }
    if (throttleTimer) return
    throttleTimer = setTimeout(() => {
      throttleTimer = null
      flushProgress()
    }, PROGRESS_THROTTLE_MS - elapsed)
  }

  function subscribeProgress(id: string): void {
    offProgress?.()
    offProgress = on('export:progress', (payload) => {
      const event = payload as ExportProgressEvent | null
      // 事件是全局广播的：必须以 taskId 过滤，否则「任务中心里别的导出」会串到本页
      if (!event || event.taskId !== id) return
      patchProgress({
        taskId: event.taskId,
        currentChapter: event.currentChapter,
        totalChapters: event.totalChapters,
        stage: event.stage,
        elapsedMs: event.elapsedMs,
        etaMs: event.etaMs,
        speed: event.speed,
        updatedAt: Date.now(),
      })
    })
  }

  function unsubscribeProgress(): void {
    offProgress?.()
    offProgress = null
    if (throttleTimer) {
      clearTimeout(throttleTimer)
      throttleTimer = null
    }
    pendingProgress = null
  }

  // 任务 id 一变（首次开始 / 重试后用新任务）就换订阅目标
  watch(taskId, (id) => {
    if (id) subscribeProgress(id)
    else unsubscribeProgress()
  }, { immediate: true })

  // ── 开始 / 取消 / 重试 / 仅合并 ──────────────────────────────────────────

  /** 任务是否正在跑（离开守卫与按钮禁用都用它） */
  const isBusy = computed(() => starting.value || live.isRunning.value)

  /** 本次导出的范围描述（进度面板顶部显示） */
  const scopeLabel = computed(() => store.rangeLabel)

  /**
   * 开始导出（Step 7 的「开始导出」）。
   * 失败不抛给调用方：`call()` 已经把错误交给 error-bus，这里只把状态收回来。
   */
  async function start(): Promise<string | null> {
    if (isBusy.value) return null
    const bookId = store.bookId
    const chapterIds = cloneForIpc(store.targetChapterIds)
    if (!bookId || chapterIds.length === 0) return null

    starting.value = true
    store.report = null
    reportUnavailable.value = false
    progressEvent.value = null
    qc.clearVerify()

    try {
      const payloadParams = cloneForIpc(store.params)
      const mixProjectId = store.effectiveMixProjectId
      let created: string

      if (store.isBookScope) {
        // 整本导出：逐章 + 可选合并 M4B（docs/15 §5.4 的 export.book 任务）
        const result = await call('export:book', {
          bookId,
          mixProjectId,
          params: payloadParams,
          makeM4b: store.m4b.enabled,
        }) as IpcRes<'export:book'>
        created = result.taskId
      } else {
        // 单章 / 选定章：分章导出（可后续单独合并 M4B）
        const result = await call('export:chapter', {
          chapterIds,
          mixProjectId,
          params: payloadParams,
        }) as IpcRes<'export:chapter'>
        created = result.taskId
      }

      store.setTask(created)
      store.goToStep(7)
      void tasks.refresh({ kind: ['export.chapter', 'export.book'], limit: 20 })
      return created
    } catch (error) {
      // 已由 error-bus 兑现（含「输出目录不可写」「磁盘空间不足」等）
      void error
      return null
    } finally {
      starting.value = false
    }
  }

  /** 仅合并 M4B（已有分章成品时；docs/15 §10 的 `export.m4b`） */
  async function mergeM4bOnly(): Promise<string | null> {
    if (isBusy.value) return null
    const bookId = store.bookId
    const chapterIds = cloneForIpc(store.targetChapterIds)
    if (!bookId || chapterIds.length === 0) return null

    starting.value = true
    try {
      const result = await call('export:m4b', {
        bookId,
        chapterIds,
        params: cloneForIpc(store.params),
      }) as IpcRes<'export:m4b'>
      store.setTask(result.taskId)
      store.goToStep(7)
      return result.taskId
    } catch (error) {
      void error
      return null
    } finally {
      starting.value = false
    }
  }

  /** 取消（docs/15 §5.4：已完成的章会留在 export_jobs 里，重跑时跳过） */
  async function cancel(): Promise<void> {
    const id = store.taskId
    if (!id) return
    try {
      await call('task:cancel', { taskId: id })
      if (progressEvent.value) {
        progressEvent.value = { ...progressEvent.value, stage: '正在取消…' }
      }
    } catch (error) {
      void error
    }
  }

  /** 重试：优先「原任务重试」（主进程会带上断点信息），没有任务时直接重新开始 */
  async function retry(): Promise<void> {
    const id = store.taskId
    if (!id) {
      await start()
      return
    }
    try {
      const result = await call('task:retry', { taskId: id }) as IpcRes<'task:retry'>
      store.setTask(result.taskId)
      store.goToStep(7)
      progressEvent.value = null
      qc.clearVerify()
      reportUnavailable.value = false
    } catch (error) {
      void error
    }
  }

  // ── 报告 ─────────────────────────────────────────────────────────────────

  /**
   * 取 jobId。
   * 1.0 里导出任务与导出入库记录同源，任务结果里就是 jobId 时优先用它；
   * 拿不到就退回 taskId（主进程把两者视为同一 id），这样报告面板永远有东西可查。
   */
  async function resolveJobId(): Promise<string | null> {
    const id = store.taskId
    if (!id) return store.jobId
    const result = await callSafe('task:result', { taskId: id })
    const jobId = extractJobId(result) ?? id
    store.jobId = jobId
    return jobId
  }

  /**
   * 拉导出报告（docs/15 §6.3）。
   * `switchStep = true`（默认）时成功后自动切到第 8 步；取消场景传 false ——
   * 用户此时更需要留在第 7 步看「已取消 + 断点可以续跑」，报告可在页脚点「查看报告」再看。
   */
  async function loadReport(switchStep = true): Promise<ExportReport | null> {
    const jobId = await resolveJobId()
    if (!jobId) return null
    store.reportLoading = true
    try {
      const report = await call('export:report', { jobId }) as IpcRes<'export:report'>
      if (switchStep) store.setReport(report)
      else store.report = report
      reportUnavailable.value = false
      return report
    } catch (error) {
      reportUnavailable.value = true
      void error
      return null
    } finally {
      store.reportLoading = false
    }
  }

  /** 成品复核（docs/15 §6.2 的渲染后实测） */
  async function runVerify(): Promise<void> {
    const jobId = store.jobId ?? store.taskId
    if (!jobId) return
    await qc.runVerify(jobId)
  }

  /**
   * 任务结束后的收尾：拉报告 → 批量失败汇总成一条（docs/22 §7）。
   * 取消不算失败：error-bus 会吞掉取消类错误，这里也不再补提示。
   */
  async function handleFinished(): Promise<void> {
    const status = live.status.value
    if (status === 'cancelled') {
      // 取消不是失败（error-bus 会吞掉取消类错误）：仍然把已完成部分的报告取回来，
      // 但**不切到第 8 步** —— 用户此刻要看的是「已取消，可以续跑」。
      await loadReport(false)
      return
    }

    const report = await loadReport()
    if (report) {
      const { total, succeeded, failed } = report.summary
      if (failed > 0) {
        // 逐章失败原因在报告里没有结构化字段（契约缺口），这里用章节警告 + 消息表的通用键构造明细
        const generic = getMessage('EXPORT_FFMPEG_FAILED')
        const samples = report.chapters
          .filter(c => c.warnings.length > 0)
          .slice(0, 50)
          .map(c => ({
            label: `第${c.chapterIndex}章 ${c.title}`,
            code: generic.code,
            message: c.warnings[0] ?? generic.title,
          }))
        reportBatchFailures({
          total,
          failed,
          ok: succeeded,
          samples,
          // 重试整批：已成功的章会被断点跳过（docs/15 §5.4），因此这里直接重跑是安全的
          retryFn: () => retry(),
        })
      }
      return
    }

    if (status === 'failed' || status === 'interrupted') {
      reportError(live.error.value ?? AppError.of('TASK_FAILED'), {
        event: 'export.taskFailed',
        retryFn: () => retry(),
      })
    }
  }

  watch(live.isFinished, (finished) => {
    if (!finished) return
    void handleFinished()
  })

  // ── 离开页面守卫（docs/15 §5.5 Step 7：导出过程中禁止离开） ───────────────

  let leaveResolver: ((allow: boolean) => void) | null = null

  onBeforeRouteLeave(() => {
    if (!isBusy.value) return true
    // 有任务在跑：弹确认框，等用户回答后再决定是否放行
    leaveConfirmVisible.value = true
    return new Promise<boolean>((resolve) => {
      leaveResolver = resolve
    })
  })

  function confirmLeave(): void {
    leaveConfirmVisible.value = false
    leaveResolver?.(true)
    leaveResolver = null
  }

  function cancelLeave(): void {
    leaveConfirmVisible.value = false
    leaveResolver?.(false)
    leaveResolver = null
  }

  /** 关窗口/刷新：主进程会在启动时把中断的任务标记为 interrupted，这里只给一次原生确认 */
  function onBeforeUnload(event: Event): void {
    if (!isBusy.value) return
    const e = event as BeforeUnloadEvent
    e.preventDefault()
    e.returnValue = ''
  }

  globalThis.addEventListener?.('beforeunload', onBeforeUnload)

  onScopeDispose(() => {
    globalThis.removeEventListener?.('beforeunload', onBeforeUnload)
    unsubscribeProgress()
    leaveResolver?.(false)
    leaveResolver = null
  })

  // ── 完成后的动作（Step 8） ───────────────────────────────────────────────

  /** 打开输出目录：优先 `export:openFolder`（主进程知道 job 的目录），退回系统定位 */
  async function openOutputFolder(): Promise<boolean> {
    const jobId = store.jobId ?? store.taskId
    if (jobId) {
      const result = await callSafe('export:openFolder', { jobId })
      if ((result as IpcRes<'export:openFolder'> | null)?.ok) return true
    }
    const first = store.report?.chapters.find(c => c.output)
    const target = first ? joinOutputPath(store.params.outputDir, first.output) : store.params.outputDir
    if (!target) return false
    const fallback = await callSafe('app:showItemInFolder', { path: target })
    return (fallback as IpcRes<'app:showItemInFolder'> | null)?.ok ?? false
  }

  /**
   * 另存导出报告 JSON（docs/15 §6.3「落盘 export-report.json」）。
   *
   * ⚠️ 契约缺口：没有任何通道接受「把报告写到指定路径」——
   * `export:report` 只接受 jobId，`app:saveFileDialog` 只返回路径、不负责写入。
   * 因此这里：用 saveFileDialog 让用户选路径（桌面能力的正确入口），
   * 然后用渲染进程的下载通道落盘，并在 UI 上说明「权威报告由主进程写在输出目录」。
   */
  async function saveReportJson(): Promise<string | null> {
    const report = store.report
    if (!report) return null
    const defaultName = `${sanitizeFileName(store.bookTitle || 'export')}-export-report.json`

    try {
      const picked = await call('app:saveFileDialog', {
        title: '另存导出报告',
        defaultPath: defaultName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }) as IpcRes<'app:saveFileDialog'>
      if (!picked.path) return null

      store.reportSavePath = picked.path
      const fileName = picked.path.split(/[\\/]+/).pop() || defaultName
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.rel = 'noopener'
      anchor.click()
      // 给浏览器一点时间发起下载再释放，否则大报告可能被截断
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return picked.path
    } catch {
      // 失败已由 error-bus 兑现；不抛出，避免变成 unhandledrejection 再报一次
      return null
    }
  }

  /** 再次导出：清掉任务与报告，保留向导参数（「后退不丢数据」的延伸） */
  function restart(): void {
    store.restartWizard()
    unsubscribeProgress()
    progressEvent.value = null
    reportUnavailable.value = false
  }

  // ── 预检项的「去处理」跳转 ───────────────────────────────────────────────

  /** 路由跳转（失败不刷屏：目标页可能还没就绪，交给 error-bus/边界处理） */
  function safePush(location: RouteLocationRaw): void {
    void Promise.resolve(router.push(location)).catch(() => undefined)
  }

  /**
   * 把当前章节切到目标章。
   * 画本页/对轨页都依赖会话上下文（docs/01 §4.3），因此跳转前必须先切章，
   * 否则会出现「跳到画本页但显示的是另一章」的串档问题。
   * 这里只用会话 store 的公开动作 selectChapter（不直接改它的内部状态）。
   */
  async function focusChapter(chapterId: string | null): Promise<void> {
    if (!chapterId || session.chapterId === chapterId) return
    const chapter = await callSafe('chapter:get', { chapterId }) as Chapter | null
    if (chapter) session.selectChapter(chapter)
  }

  async function jumpToIssue(
    target: ExportJumpTarget,
    options: { chapterId?: string | null; lineId?: string | null } = {},
  ): Promise<void> {
    const chapterId = options.chapterId ?? null
    const lineId = options.lineId ?? null
    if (target === 'settings') {
      safePush({ path: '/settings', query: { focus: 'EXPORT_OUTPUT_NOT_WRITABLE' } })
      return
    }
    if (target === 'chapters') {
      safePush({ path: '/chapters', query: { bookId: store.bookId ?? undefined } })
      return
    }
    await focusChapter(chapterId)
    if (target === 'canvas') {
      // 缺录行 / 未分配说话人都要回到画本页处理（docs/15 §6.1）
      safePush({ path: '/canvas', query: { chapterId: chapterId ?? undefined, lineId: lineId ?? undefined } })
      return
    }
    safePush({ path: '/alignment', query: { chapterId: chapterId ?? undefined } })
  }

  return {
    // 状态
    live, progressEvent, starting, isBusy, scopeLabel, reportUnavailable, leaveConfirmVisible,
    // 动作
    start, mergeM4bOnly, cancel, retry, loadReport, runVerify, openOutputFolder,
    saveReportJson, restart, jumpToIssue,
    // 守卫
    confirmLeave, cancelLeave,
  }
}
