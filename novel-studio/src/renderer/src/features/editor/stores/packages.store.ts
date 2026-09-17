/**
 * 画本编辑域 · 任务包导出 / 回收合并状态（docs/11 §6.2–§6.5）
 * ============================================================================
 * 关键约束（写在最前面，避免踩）：
 *   1. 导出与合并都是**长任务**：只拿 taskId，进度交给 TaskProgressCard
 *      （docs/04 §2.4：禁止自建进度 UI），完成后由本 store 去取结果。
 *   2. `linesHash` 是任务包与画本之间唯一的「是否变更」判据（docs/03 §9）：
 *      不一致 → PACKAGE_LINES_CHANGED，必须提示人工确认，并给出「仅重发变更行」的增量导出。
 *   3. `PACKAGE_TASK_READONLY`（info 级）：画本来自任务包且尚未合并时，编辑入口只读。
 *      只读判定放在本 store（readonly），由视图下发给各组件，组件不各自判断。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import type {
  Id,
  PackageHistoryEntry,
  TaskPackageMergeReport,
} from '@shared/types.ts'

/** 任务包的录音建议（对应 NstManifest.recordSettings，docs/03 §9） */
export interface NstRecordSettings {
  sampleRate: number
  bitDepth: number
  channels: number
  fileNameTemplate: string
  recommendGainDb: number
  targetPeakDb: number
}

/** 导出选项（docs/11 §6.2 的勾选项 + 范围过滤） */
export interface NstExportOptions extends Record<string, unknown> {
  /** 包含上下文（前后各 1 行，帮助入戏） */
  includeContext: boolean
  /** 包含参考音（对手戏片段；会显著增大包体积） */
  includeReference: boolean
  /** 包含发音提示与备注 */
  includeNotes: boolean
  /** 允许该配音员看到其它角色的词（默认关，只看自己的更专注） */
  allowOtherCharacterLines: boolean
  /** 按角色过滤（空 = 该配音员绑定的全部角色） */
  characterIds: Id[]
  /** 按章节范围过滤（空 = 全书） */
  chapterIds: Id[]
  /** 增量下发：只包含相对上次下发发生变更的行（docs/11 §6.5） */
  onlyChangedLines: boolean
  fileNameTemplate: string
  recordSettings: NstRecordSettings
}

export const DEFAULT_NST_RECORD_SETTINGS: NstRecordSettings = {
  sampleRate: 48000,
  bitDepth: 24,
  channels: 1,
  // docs/03 §9 的示例值
  fileNameTemplate: '{lineId}_{take}.wav',
  recommendGainDb: -6,
  targetPeakDb: -6,
}

export const DEFAULT_NST_EXPORT_OPTIONS: NstExportOptions = {
  includeContext: true,
  includeReference: false,
  includeNotes: true,
  allowOtherCharacterLines: false,
  characterIds: [],
  chapterIds: [],
  onlyChangedLines: false,
  fileNameTemplate: DEFAULT_NST_RECORD_SETTINGS.fileNameTemplate,
  recordSettings: DEFAULT_NST_RECORD_SETTINGS,
}

/** `package:inspect` 的结果 */
export interface PackageInspectResult {
  path: string
  kind: 'nsp' | 'nst'
  formatVersion: number
  summary: string
}

/** 任务包模式：画本来自任务包且未合并时只读（docs/11 §6.3） */
export interface TaskModeState {
  active: boolean
  packageId: Id | null
  actorName: string | null
  /** 下发时的画本哈希，回收时用于比对 */
  linesHash: string | null
  /** 是否已合并回本项目（合并后解除只读） */
  merged: boolean
  /** 包里涉及的行数（提示「只读范围」用） */
  lineCount: number
}

export const usePackagesStore = defineStore('editor/packages', () => {
  const projectId = ref<Id | null>(null)

  /** 导出任务 */
  const exportTaskId = ref<Id | null>(null)
  const exportOptions = ref<NstExportOptions>({ ...DEFAULT_NST_EXPORT_OPTIONS })
  const lastExportActorId = ref<Id | null>(null)
  /** 最近一次导出完成的包信息（「打开文件夹」用它） */
  const lastExport = ref<{ filePath: string; actorName: string; lineCount: number; hasReference: boolean } | null>(null)

  /** 导入 / 合并任务 */
  const inspectResult = ref<PackageInspectResult | null>(null)
  const mergeTaskId = ref<Id | null>(null)
  const mergeReport = ref<TaskPackageMergeReport | null>(null)
  const history = ref<PackageHistoryEntry[]>([])
  const busy = ref(false)
  const lastError = ref<unknown>(null)

  const taskMode = ref<TaskModeState>({
    active: false,
    packageId: null,
    actorName: null,
    linesHash: null,
    merged: false,
    lineCount: 0,
  })

  /** 只读：任务模式且未合并（docs/11 §6.3 防误操作） */
  const readonly = computed(() => taskMode.value.active && !taskMode.value.merged)

  /** 画本已变更（linesHash 不一致）—— 必须人工确认才能继续归位 */
  const linesChanged = computed(() => mergeReport.value?.linesChanged === true)

  /** 回收报告里需要人工处理的行数（缺漏 + 未知 + 损坏 + 校验失败） */
  const pendingCount = computed(() => {
    const report = mergeReport.value
    if (!report) return 0
    return report.missing.length + report.unknown.length + report.corrupted + report.checksumFailed
  })

  function setProjectId(id: Id | null): void {
    projectId.value = id
  }

  function setExportOptions(patch: Partial<NstExportOptions>): void {
    exportOptions.value = { ...exportOptions.value, ...patch }
  }

  function resetExportOptions(): void {
    exportOptions.value = { ...DEFAULT_NST_EXPORT_OPTIONS }
  }

  /** 导出任务包（docs/11 §6.2）：返回 taskId，进度由 TaskProgressCard 显示 */
  async function exportTask(bookId: Id, actorId: Id): Promise<Id | null> {
    busy.value = true
    lastError.value = null
    try {
      const res = await call('package:exportTask', {
        bookId,
        actorId,
        options: { ...exportOptions.value },
      }) as { taskId: Id }
      exportTaskId.value = res.taskId
      lastExportActorId.value = actorId
      return res.taskId
    } catch (error) {
      lastError.value = error
      return null
    } finally {
      busy.value = false
    }
  }

  /** 读取包摘要（不解压全部，只读 manifest） */
  async function inspect(path: string): Promise<PackageInspectResult | null> {
    busy.value = true
    lastError.value = null
    try {
      const res = await call('package:inspect', { path }) as { kind: 'nsp' | 'nst'; formatVersion: number; summary: string }
      inspectResult.value = { path, kind: res.kind, formatVersion: res.formatVersion, summary: res.summary }
      return inspectResult.value
    } catch (error) {
      lastError.value = error
      inspectResult.value = null
      return null
    } finally {
      busy.value = false
    }
  }

  /** 回收合并（docs/11 §6.4）：返回 taskId */
  async function mergeTask(path: string): Promise<Id | null> {
    if (!projectId.value) return null
    busy.value = true
    lastError.value = null
    try {
      const res = await call('package:mergeTask', { projectId: projectId.value, path }) as { taskId: Id }
      mergeTaskId.value = res.taskId
      return res.taskId
    } catch (error) {
      lastError.value = error
      return null
    } finally {
      busy.value = false
    }
  }

  /** 合并任务结束后取报告（先取任务结果，取不到再退回 package:lastMergeReport） */
  async function fetchMergeReport(taskId?: Id | null): Promise<TaskPackageMergeReport | null> {
    const id = taskId ?? mergeTaskId.value
    let report: TaskPackageMergeReport | null = null
    if (id) {
      report = await callSafe('task:result', { taskId: id }) as TaskPackageMergeReport | null
    }
    if (!report && projectId.value) {
      report = await callSafe('package:lastMergeReport', { projectId: projectId.value }) as TaskPackageMergeReport | null
    }
    if (report) mergeReport.value = report
    return mergeReport.value
  }

  async function loadLastMergeReport(): Promise<TaskPackageMergeReport | null> {
    if (!projectId.value) return null
    const report = await callSafe('package:lastMergeReport', { projectId: projectId.value }) as TaskPackageMergeReport | null
    if (report) mergeReport.value = report
    return report
  }

  async function loadHistory(): Promise<PackageHistoryEntry[]> {
    if (!projectId.value) return []
    const list = await callSafe('package:listHistory', { projectId: projectId.value }) as PackageHistoryEntry[] ?? []
    history.value = list
    // 历史上最近一次导出/合并的时间线倒序（主进程已按时间倒序时这里保持原样）
    return list
  }

  /** 记录导出完成后的包信息（对话框在任务成功回调里调用） */
  function noteExportDone(info: { filePath: string; actorName: string; lineCount: number; hasReference: boolean }): void {
    lastExport.value = info
    void loadHistory()
  }

  /** 进入任务包模式（配音员侧导入后调用；只读直到合并完成） */
  function enterTaskMode(state: Partial<TaskModeState>): void {
    taskMode.value = { ...taskMode.value, active: true, merged: false, ...state }
  }

  function markTaskModeMerged(): void {
    taskMode.value = { ...taskMode.value, merged: true }
  }

  function exitTaskMode(): void {
    taskMode.value = { active: false, packageId: null, actorName: null, linesHash: null, merged: false, lineCount: 0 }
  }

  function reset(): void {
    inspectResult.value = null
    mergeTaskId.value = null
    mergeReport.value = null
    exportTaskId.value = null
    lastExport.value = null
  }

  return {
    projectId, exportTaskId, exportOptions, lastExportActorId, lastExport,
    inspectResult, mergeTaskId, mergeReport, history, busy, lastError, taskMode,
    readonly, linesChanged, pendingCount,
    setProjectId, setExportOptions, resetExportOptions,
    exportTask, inspect, mergeTask, fetchMergeReport, loadLastMergeReport, loadHistory,
    noteExportDone, enterTaskMode, markTaskModeMerged, exitTaskMode, reset,
  }
})
