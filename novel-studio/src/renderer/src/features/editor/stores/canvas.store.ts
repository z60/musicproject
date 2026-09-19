/**
 * 画本编辑域 · 画本行状态（行数据 / 编辑 / 撤销 / 落库 / 质检 / 生成）
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md
 *   · §3    画本行是全系统唯一主轴（录音、对轨、混音、任务包全部挂在 canvas_line 上）
 *   · §4.2  表格视图要能吃住 5000 行（本 store 只做数据，虚拟滚动在 CanvasTable）
 *   · §4.7  批量操作提交用 canvas:batchUpdate（一个事务），一次批量 = 撤销栈里的一条命令
 *   · §4.8  编辑立即进内存 + 进撤销栈；500 ms 防抖批量写库；Ctrl+S / 切章强制 flush
 *   · §4.9  写库失败必须让用户看到「修改仍在内存中」+ 重试（saveStatus/saveError 就是给它用）
 *   · §5    质检：只有安全项允许一键修复（no_pause / missing_pronunciation）
 *
 * 分工：
 *   · 本 store：行数据、选中态、编辑管道（乐观 UI → 撤销命令 → 落库）、质检、生成任务
 *   · composables/useSpeakerAssign.ts：候选列表与指派语义（写动作仍回到本 store）
 *   · stores/review.store.ts：待确认队列（读本 store 的行，写回本 store）
 *   · components/：只管渲染与交互，禁止自己调 IPC
 *
 * 落库策略（严格遵守 docs/11 §4.9）：
 *   文本编辑：组件侧 useEditableField 防抖 500 ms → 调用本 store 的 commitText → 写库
 *   标记编辑：useImmediateField（delayMs=0）→ commitFields → 立即写库
 *   批量操作：commit/applyBatchPatch → canvas:batchUpdate 一个事务；逐条失败由
 *             callCollecting 收集后用 reportBatchFailures 汇总（不刷 N 条提示）
 *   失败一律**不回滚内存**，而是把 saveStatus 置为 error 并保留 pending，等用户重试。
 *
 * 关于 IPC 返回值的类型断言：渲染进程的 shared/lib/ipc.ts 里除少数几个通道外都是
 * 索引签名占位（真实项目由 ipc-contract.ts 生成完整类型），因此这里对返回值做显式断言，
 * 载荷仍然严格按 @shared/ipc.ts 的 IpcContract 形状书写。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { call, callCollecting, on } from '@/shared/lib/ipc.ts'
import { reportBatchFailures } from '@/shared/lib/error-bus.ts'
import { debounce } from '@/shared/lib/editable-debounce.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import { segmentUrl } from '@/shared/lib/media-url.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import { AppError } from '@shared/errors.ts'
import { CANVAS_DEFAULTS, POLYPHONE_HINTS } from '@shared/constants.ts'
import type {
  CanvasGenerateOptions,
  CanvasGenerateReport,
  CanvasLine,
  CanvasLinePatch,
  Id,
  QualityIssue,
  QualityIssueKind,
  Take,
} from '@shared/types.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useUndoStack } from '../composables/useUndoStack.ts'

// ---------------------------------------------------------------------------
// 纯逻辑小工具（不依赖响应式，组件也可直接复用）
// ---------------------------------------------------------------------------

/** 多音字提示（docs/11 §5：只提示、不自动替换，会错得更离谱） */
export interface PolyphoneSuggestion {
  char: string
  readings: string[]
  hint: string
  /** 在文本里的字符索引 */
  index: number
  /** 建议写法：`行(háng)` */
  suggestion: string
}

/** 扫描文本命中的多音字（按出现顺序、按字去重，最多 limit 条） */
export function suggestPronunciations(text: string | null | undefined, limit = 8): PolyphoneSuggestion[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: PolyphoneSuggestion[] = []
  const chars = [...text]
  for (let index = 0; index < chars.length; index++) {
    const ch = chars[index]!
    if (seen.has(ch)) continue
    const hit = POLYPHONE_HINTS.find(item => item.char === ch)
    if (!hit) continue
    seen.add(ch)
    out.push({
      char: hit.char,
      readings: [...hit.readings],
      hint: hit.hint,
      index,
      suggestion: `${hit.char}(${hit.readings[0]})`,
    })
    if (out.length >= limit) break
  }
  return out
}

/** 多音字建议拼成发音提示串（质检 missing_pronunciation 的一键修复用它） */
export function suggestPronunciationText(line: CanvasLine | null | undefined): string | null {
  const suggestions = suggestPronunciations(line?.text, 3)
  if (!suggestions.length) return null
  return suggestions.map(s => s.suggestion).join(' ')
}

/**
 * 画本行标志位的中文说明（表格「提示」列、筛选、批量加减标记共用）。
 * 其中三个是生成/编辑流程写入的，其余来自质检与录音链路：
 *   locked   —— 人工锁定，重算不得覆盖（docs/11 §4.7）
 *   deleted  —— 软删除（docs/11 §4.7：不做物理删除）
 *   merged   —— 相邻旁白合并后的保留行
 */
export const CANVAS_FLAG_LABELS: Record<string, string> = {
  too_long: '过长',
  quote_unmatched: '引号不配对',
  locked: '已锁定（人工）',
  deleted: '已删除（软删除）',
  merged: '已合并旁白',
  short: '短句保护',
  recorded_missing: '录音文件缺失',
  clipped: '削波',
  silent: '疑似静音',
  duplicate: '重复文本',
}

/** 批量操作条里可选的标志位（顺序即展示顺序） */
export const CANVAS_FLAG_OPTIONS: Array<{ value: string; label: string }> = Object.entries(CANVAS_FLAG_LABELS)
  .map(([value, label]) => ({ value, label }))

/** 标志位的短图标（表格里只放一个字符，避免撑宽列） */
export const CANVAS_FLAG_ICONS: Record<string, string> = {
  too_long: '长',
  quote_unmatched: '引',
  locked: '🔒',
  deleted: '🗑',
  merged: '⛓',
  short: '短',
  recorded_missing: '缺',
  clipped: '削',
  silent: '静',
  duplicate: '重',
}

/** 取 patch 涉及字段在行上的当前值（撤销命令的 before 快照） */
function snapshotFields(line: CanvasLine, patch: CanvasLinePatch): CanvasLinePatch {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) {
    out[key] = (line as unknown as Record<string, unknown>)[key] ?? null
  }
  return out as CanvasLinePatch
}

/** 规范化 patch：人工编辑一律写 decidedBy='human'（docs/11 §4.4「强制标记」） */
function withHuman(patch: CanvasLinePatch, human: boolean): CanvasLinePatch {
  return human ? { ...patch, decidedBy: 'human' } : patch
}

function patchKey(patch: CanvasLinePatch): string {
  try {
    return JSON.stringify(patch, Object.keys(patch).sort())
  } catch {
    return `patch_${Object.keys(patch).sort().join(',')}`
  }
}

/** 一次编辑的差异（撤销 / 重做都靠它） */
export interface LineChange {
  lineId: Id
  before: CanvasLinePatch
  after: CanvasLinePatch
}

type SelectMode = 'single' | 'toggle' | 'range'
export type CanvasViewMode = 'table' | 'script' | 'review'

/** 单页拉取上限：超长章节（docs/11 §8）分页拉，避免一次 IPC 回 5000 行卡住主进程 */
const PAGE_SIZE = 2000
const MAX_PAGES = 20

export const useCanvasStore = defineStore('editor/canvas', () => {
  const settings = useSettingsStore()

  /** 画本阈值等默认值：以设置为准，缺失回落 CANVAS_DEFAULTS（docs/06 §5.2） */
  const threshold = computed(() => settings.settings?.canvas.attributionThreshold ?? CANVAS_DEFAULTS.attributionThreshold)
  const defaultPauseMs = computed(() => settings.settings?.canvas.defaultPauseAfterMs ?? CANVAS_DEFAULTS.defaultPauseAfterMs)
  const autoAcceptConfidence = computed(() => settings.settings?.canvas.autoAcceptConfidence ?? CANVAS_DEFAULTS.autoAcceptConfidence)

  // ---- 行数据 -------------------------------------------------------------
  const chapterId = ref<Id | null>(null)
  const lines = ref<CanvasLine[]>([])
  const total = ref(0)
  const loading = ref(false)
  const loadError = ref<unknown>(null)
  /** 已成功加载过的章节 id（避免重复拉取；切章时清空） */
  const loadedChapterId = ref<Id | null>(null)

  // ---- 视图状态（表格 / 剧本 / 队列共享选中行与滚动位置）-------------------
  const activeView = ref<CanvasViewMode>('table')
  const density = ref<'compact' | 'standard'>('standard')
  const activeLineId = ref<Id | null>(null)
  const drawerOpen = ref(false)
  /** 每个视图自己的 scrollTop（切换视图时用来还原） */
  const scrollTops = ref<Record<CanvasViewMode, number>>({ table: 0, script: 0, review: 0 })
  /** 每个视图当前屏内第一行下标（行高不同，用「行」还原位置才准） */
  const topIndexes = ref<Record<CanvasViewMode, number>>({ table: 0, script: 0, review: 0 })

  // ---- 选中态 -------------------------------------------------------------
  const selectedIds = ref<Set<Id>>(new Set())
  /** 范围选择（Shift）的锚点 */
  const anchorId = ref<Id | null>(null)

  // ---- 保存状态（docs/11 §4.9）------------------------------------------
  const saveStatus = ref<SaveStatus>('idle')
  const savedAt = ref<number | null>(null)
  const saveError = ref<unknown>(null)
  /** 尚未落库的改动行数（>0 表示内存里还有东西没写进库） */
  const pendingCount = ref(0)
  /** Ctrl+S / 切章时自增；子组件的 EditableField 监听它做强制 flush */
  const flushSignal = ref(0)
  /** 乐观锁冲突过的行（提示「重新加载」，绝不覆盖别人的修改） */
  const conflictLineIds = ref<Set<Id>>(new Set())

  // ---- 质检 / 生成报告 ----------------------------------------------------
  const issues = ref<QualityIssue[]>([])
  const issuesLoading = ref(false)
  const generateReport = ref<CanvasGenerateReport | null>(null)
  /**
   * `generateReport` 是否来自**本次会话里刚刚跑完的那次生成**。
   *
   * 为什么要区分：报告里 `embeddingUsed=false` 是「已降级为规则判定」的证据，但**打开一章
   * 去看历史报告**时它不是新消息 —— 面板里本来就有红条与「语义判定：未启用（规则判定）」。
   * 早期实现只要报告是降级的就弹一次提示，于是「点开任意一章」都会弹「未启用语义判定」，
   * 连续看几章就一直弹（真机反馈）。现在只有**用户刚点完生成**才弹。
   */
  const reportIsFresh = ref(false)
  const generateTaskId = ref<Id | null>(null)
  const generateProgress = ref<{ stage: string; processed: number; total: number } | null>(null)

  // ---- 试听（抽屉与队列共用同一条音频）-------------------------------------
  const playbackLineId = ref<Id | null>(null)
  const playbackUrl = ref<string | null>(null)
  const playbackDurationMs = ref<number | null>(null)
  const playbackTakeId = ref<Id | null>(null)
  const playbackError = ref<unknown>(null)

  /** 当前项目 id：ns-media:// URL 需要它（由视图在挂载时注入） */
  const projectId = ref<Id | null>(null)

  const undoStack = useUndoStack({
    capacity: 100, // docs/11 §4.8：栈深 ≥ 100
    onError: (error) => {
      saveError.value = error
      saveStatus.value = 'error'
    },
  })

  /** 未落库的 patch（按行合并；同一行的多次编辑只写一次） */
  const pendingPatches = new Map<Id, CanvasLinePatch>()

  // -------------------------------------------------------------------------
  // 索引与派生
  // -------------------------------------------------------------------------

  /** id → 数组下标（虚拟滚动、键盘移动、范围选择都要用） */
  const indexById = computed(() => {
    const map = new Map<Id, number>()
    for (let i = 0; i < lines.value.length; i++) map.set(lines.value[i]!.id, i)
    return map
  })

  const lineById = computed(() => {
    const map = new Map<Id, CanvasLine>()
    for (const line of lines.value) map.set(line.id, line)
    return map
  })

  const lineCount = computed(() => lines.value.length)
  const selectedCount = computed(() => selectedIds.value.size)
  const selectedLines = computed(() => lines.value.filter(l => selectedIds.value.has(l.id)))
  const activeLine = computed(() => (activeLineId.value ? lineById.value.get(activeLineId.value) ?? null : null))
  const activeIndex = computed(() => (activeLineId.value ? indexById.value.get(activeLineId.value) ?? -1 : -1))

  /** 待确认行（needsReview=1），状态栏与队列都用它 */
  const reviewCount = computed(() => lines.value.filter(l => l.needsReview && !l.flags.includes('deleted')).length)
  const unassignedCount = computed(() => lines.value.filter(l => l.kind === 'dialogue' && !l.characterId).length)
  const recordedCount = computed(() => lines.value.filter(l => l.state === 'recorded' || l.state === 'aligned').length)

  /** 行 → 质检问题（表格里给「有问题」图标用） */
  const issuesByLineId = computed(() => {
    const map = new Map<Id, QualityIssue[]>()
    for (const issue of issues.value) {
      if (!issue.lineId) continue
      const list = map.get(issue.lineId) ?? []
      list.push(issue)
      map.set(issue.lineId, list)
    }
    return map
  })
  const issueLineIds = computed(() => new Set(issuesByLineId.value.keys()))
  const issueCounts = computed(() => {
    const map = new Map<QualityIssueKind, number>()
    for (const issue of issues.value) map.set(issue.kind, (map.get(issue.kind) ?? 0) + 1)
    return map
  })

  const hasUnsaved = computed(() => pendingCount.value > 0 || saveStatus.value === 'dirty')

  const statusSummary = computed(() => ({
    total: total.value || lines.value.length,
    loaded: lines.value.length,
    recorded: recordedCount.value,
    review: reviewCount.value,
    unassigned: unassignedCount.value,
    issues: issues.value.length,
  }))

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  /**
   * 加载章节画本行。
   * `force` 用于重新生成之后强制刷新。切章前会先 flush（docs/11 §4.8）。
   *
   * `freshReport` 表示「这次加载紧接着一次**本次会话里刚跑完的生成任务**」——
   * 只有这种报告才值得弹「已降级为规则判定」的提示（见 reportIsFresh）。
   */
  async function load(
    targetChapterId?: Id | null,
    options: { force?: boolean; freshReport?: boolean } = {},
  ): Promise<void> {
    const id = targetChapterId ?? chapterId.value
    if (!id) {
      lines.value = []
      total.value = 0
      loadedChapterId.value = null
      return
    }
    if (!options.force && loadedChapterId.value === id && lines.value.length) return

    await flush()
    chapterId.value = id
    loading.value = true
    loadError.value = null
    try {
      const collected: CanvasLine[] = []
      let offset = 0
      let serverTotal = 0
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await call('canvas:getChapter', {
          chapterId: id,
          offset,
          limit: PAGE_SIZE,
        }) as { lines: CanvasLine[]; total: number }
        const batch = res?.lines ?? []
        collected.push(...batch)
        serverTotal = res?.total ?? collected.length
        offset += batch.length
        if (!batch.length || collected.length >= serverTotal) break
      }
      lines.value = collected
      total.value = serverTotal || collected.length
      loadedChapterId.value = id
    } catch (error) {
      loadError.value = error
      lines.value = []
      total.value = 0
      throw error
    } finally {
      loading.value = false
    }

    // 清掉上一章的编辑态（撤销栈不能跨章撤销，否则会去改别的章的行）
    undoStack.clear()
    pendingPatches.clear()
    pendingCount.value = 0
    selectedIds.value = new Set()
    anchorId.value = null
    activeLineId.value = lines.value[0]?.id ?? null
    conflictLineIds.value = new Set()
    saveStatus.value = 'idle'
    saveError.value = null
    clearPlayback()
    /**
     * 上一章登记的「生成画本」进度卡也要收起来：它属于**上一章**的任务，
     * 留在新章（或另一本书的章）上就是「非本章的生成画本提示」（真机反馈 docs/91 §5.2.35）。
     * 任务本身没有消失 —— 任务中心仍可查看与取消。
     */
    generateTaskId.value = null

    await Promise.all([loadIssueList(), loadReport()])
    // 报告刚读回来就把「是不是刚生成完」记下来：视图的 watch 在刷新后才会跑，
    // 那时它读到的就是这个值（见 reportIsFresh 的注释）
    reportIsFresh.value = options.freshReport === true
  }

  async function ensureLoaded(id?: Id | null): Promise<void> {
    const target = id ?? chapterId.value
    if (!target) return
    if (loadedChapterId.value === target) return
    await load(target)
  }

  async function reload(options: { force?: boolean } = { force: true }): Promise<void> {
    await load(chapterId.value, { force: options.force ?? true })
  }

  // -------------------------------------------------------------------------
  // 选中与视图
  // -------------------------------------------------------------------------

  function setActiveView(view: CanvasViewMode): void {
    if (activeView.value === view) return
    activeView.value = view
  }

  function setScrollTop(view: CanvasViewMode, top: number, topIndex?: number): void {
    scrollTops.value = { ...scrollTops.value, [view]: top }
    if (topIndex !== undefined) topIndexes.value = { ...topIndexes.value, [view]: topIndex }
  }

  function scrollTopOf(view: CanvasViewMode): number {
    return scrollTops.value[view] ?? 0
  }

  function topIndexOf(view: CanvasViewMode): number {
    return topIndexes.value[view] ?? 0
  }

  function setDensity(next: 'compact' | 'standard'): void {
    density.value = next
  }

  function setActiveLine(lineId: Id | null): void {
    activeLineId.value = lineId
  }

  function selectLine(lineId: Id, mode: SelectMode = 'single'): void {
    const index = indexById.value.get(lineId)
    const next = new Set(selectedIds.value)

    if (mode === 'toggle') {
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      anchorId.value = lineId
    } else if (mode === 'range' && anchorId.value !== null) {
      const anchorIndex = indexById.value.get(anchorId.value)
      if (anchorIndex !== undefined && index !== undefined) {
        const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex]
        for (let i = from; i <= to; i++) next.add(lines.value[i]!.id)
      }
    } else {
      next.clear()
      next.add(lineId)
      anchorId.value = lineId
    }

    selectedIds.value = next
    activeLineId.value = lineId
  }

  function selectAll(): void {
    selectedIds.value = new Set(lines.value.map(l => l.id))
  }

  function selectRange(fromIndex: number, toIndex: number): void {
    const [from, to] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
    const next = new Set<Id>()
    for (let i = Math.max(0, from); i <= Math.min(lines.value.length - 1, to); i++) next.add(lines.value[i]!.id)
    selectedIds.value = next
  }

  function clearSelection(): void {
    selectedIds.value = new Set()
    anchorId.value = null
  }

  function selectByLineIds(ids: Id[], mode: SelectMode = 'single'): void {
    if (mode === 'single') {
      selectedIds.value = new Set(ids)
      anchorId.value = ids[0] ?? null
      return
    }
    if (mode === 'toggle') {
      const next = new Set(selectedIds.value)
      for (const id of ids) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      selectedIds.value = next
      return
    }
    selectedIds.value = new Set([...selectedIds.value, ...ids])
  }

  /** 键盘上下移动选中行（docs/11 §4.2「键盘上下移动选中行」） */
  function moveActive(delta: number, extendSelection = false): Id | null {
    if (!lines.value.length) return null
    const current = activeIndex.value
    const next = Math.min(lines.value.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
    const target = lines.value[next]
    if (!target) return null
    if (extendSelection) {
      const anchorIndex = anchorId.value ? indexById.value.get(anchorId.value) ?? next : next
      selectRange(anchorIndex, next)
      activeLineId.value = target.id
    } else {
      selectLine(target.id, 'single')
    }
    return target.id
  }

  function openDrawer(lineId: Id): void {
    activeLineId.value = lineId
    drawerOpen.value = true
  }

  function closeDrawer(): void {
    drawerOpen.value = false
  }

  /** 质检「跳到该行」：选中并（可选）打开抽屉 */
  function focusLine(lineId: Id, options: { openDrawer?: boolean } = {}): void {
    selectLine(lineId, 'single')
    if (options.openDrawer) openDrawer(lineId)
  }

  // -------------------------------------------------------------------------
  // 编辑管道：本地立即生效 → 进撤销栈 → 落库
  // -------------------------------------------------------------------------

  function mergePending(lineId: Id, patch: CanvasLinePatch): void {
    const prev = pendingPatches.get(lineId) ?? {}
    pendingPatches.set(lineId, { ...prev, ...patch })
    pendingCount.value = pendingPatches.size
  }

  /** 把主进程返回的行合并回内存（保住对象引用：其他 store/组件持有同一行对象） */
  function applyServerLine(saved: CanvasLine): void {
    const index = indexById.value.get(saved.id)
    if (index === undefined) return
    const target = lines.value[index]
    if (!target) return
    Object.assign(target, saved)
  }

  function applyPatchLocal(lineId: Id, patch: CanvasLinePatch): void {
    const line = lineById.value.get(lineId)
    if (!line) return
    Object.assign(line, patch)
  }

  /** 构造一次编辑的差异（before 只快照 patch 涉及的字段） */
  function buildChange(line: CanvasLine, patch: CanvasLinePatch, human: boolean): LineChange {
    const after = withHuman(patch, human)
    return { lineId: line.id, before: snapshotFields(line, after), after }
  }

  /** 防抖写库（docs/11 §4.8：500 ms） */
  const flushDebounced = debounce(() => {
    void flush()
  }, 500)

  /** 把改动写进内存与 pending，并按 delayMs 决定何时落库 */
  function stage(changes: Array<{ lineId: Id; patch: CanvasLinePatch }>, delayMs: number): Promise<boolean> {
    for (const change of changes) {
      applyPatchLocal(change.lineId, change.patch)
      mergePending(change.lineId, change.patch)
    }
    if (delayMs <= 0) return flush()
    saveStatus.value = 'dirty'
    flushDebounced()
    return Promise.resolve(true)
  }

  /**
   * 落库一批改动。
   *   · 相同 patch 的多行 → canvas:batchUpdate（一个事务，docs/11 §4.7）
   *   · 不同 patch → 逐条 canvas:updateLine（带 rev 乐观锁），失败用 callCollecting 收集后统一汇总
   *
   * 已知契约缺口：`canvas:batchUpdate` 只返回 `{ updated }`，不回写 rev，
   * 因此批量之后紧接着的单行 updateLine 可能因 rev 过期收到 CONFLICT —— 这里按
   * docs/11 §4.9 的要求处理：不覆盖别人的修改，标出冲突行并重新加载。
   */
  async function persistEntries(entries: Array<{ lineId: Id; patch: CanvasLinePatch }>): Promise<boolean> {
    if (!entries.length) return true
    saveStatus.value = 'saving'

    const groups = new Map<string, Array<{ lineId: Id; patch: CanvasLinePatch }>>()
    for (const entry of entries) {
      const key = patchKey(entry.patch)
      const list = groups.get(key) ?? []
      list.push(entry)
      groups.set(key, list)
    }

    const failures: Array<{ label: string; code: string; message: string }> = []
    let okCount = 0

    for (const group of groups.values()) {
      const first = group[0]!

      if (group.length > 1) {
        const result = await callCollecting(
          'canvas:batchUpdate',
          { lineIds: group.map(g => g.lineId), patch: first.patch },
          failures,
          `批量更新 ${group.length} 行`,
        )
        if (result.ok) {
          okCount += (result.data as { updated: number }).updated ?? group.length
        } else {
          for (const item of group) mergePending(item.lineId, item.patch)
        }
        continue
      }

      const line = lineById.value.get(first.lineId)
      const result = await callCollecting(
        'canvas:updateLine',
        { lineId: first.lineId, patch: first.patch, rev: line?.rev },
        failures,
        `第 ${line?.seq ?? '?'} 行`,
      )
      if (result.ok) {
        okCount += 1
        applyServerLine(result.data as CanvasLine)
        const next = new Set(conflictLineIds.value)
        next.delete(first.lineId)
        conflictLineIds.value = next
      } else {
        mergePending(first.lineId, first.patch)
        if (result.error instanceof AppError && result.error.key === 'CONFLICT') {
          conflictLineIds.value = new Set(conflictLineIds.value).add(first.lineId)
          // 别处改过这一行：读回权威值，避免用户继续在旧值上编辑
          await reloadLine(first.lineId, { silent: true })
        }
      }
    }

    if (failures.length) {
      saveStatus.value = 'error'
      saveError.value = failures[0]
      reportBatchFailures({
        total: entries.length,
        failed: failures.length,
        ok: okCount,
        samples: failures,
        // retryFn 的契约是「重试一次，无返回值」；flush() 返回 boolean（是否全部成功），
        // 这里用 async 形态把它吞掉，避免 TS2322（Promise<boolean> 不能赋给 Promise<void>）。
        retryFn: async () => {
          await flush()
        },
      })
      return false
    }

    saveStatus.value = 'saved'
    savedAt.value = Date.now()
    saveError.value = null
    return true
  }

  /** 立即落库（Ctrl+S、切章节、提交前） */
  async function flush(): Promise<boolean> {
    flushDebounced.cancel()
    if (!pendingPatches.size) {
      if (saveStatus.value === 'dirty') saveStatus.value = 'saved'
      return true
    }
    const entries = [...pendingPatches.entries()].map(([lineId, patch]) => ({ lineId, patch }))
    pendingPatches.clear()
    pendingCount.value = 0
    return persistEntries(entries)
  }

  /**
   * 统一的提交入口。
   * @param changes 差异（before 供撤销用）
   * @param label   撤销栈里显示的名字
   * @param delayMs 0 = 立即写库（文本类防抖已在 useEditableField 里做过）
   */
  async function commit(
    changes: LineChange[],
    label: string,
    options: { delayMs?: number; affected?: number } = {},
  ): Promise<boolean> {
    if (!changes.length) return true
    const delayMs = options.delayMs ?? 0

    // 1) 内存立即生效（乐观 UI）+ 进 pending
    for (const change of changes) {
      applyPatchLocal(change.lineId, change.after)
      mergePending(change.lineId, change.after)
    }

    // 2) 进撤销栈（一次批量 = 一条命令，docs/11 §4.8）
    undoStack.push({
      label,
      affected: options.affected ?? changes.length,
      undo: () => {
        void stage(changes.map(c => ({ lineId: c.lineId, patch: c.before })), 0)
      },
      redo: () => {
        void stage(changes.map(c => ({ lineId: c.lineId, patch: c.after })), 0)
      },
    })

    // 3) 落库
    if (delayMs <= 0) return flush()
    saveStatus.value = 'dirty'
    flushDebounced()
    return true
  }

  // -------------------------------------------------------------------------
  // 对外编辑 API（组件只调这些）
  // -------------------------------------------------------------------------

  /** 改文本（useEditableField 的 write 接这里；500 ms 防抖在组件侧做） */
  async function commitText(lineId: Id, text: string): Promise<string> {
    const line = lineById.value.get(lineId)
    if (!line) return text
    if (line.text === text) return text
    await commit([buildChange(line, { text }, true)], '修改文本', { delayMs: 0 })
    return text
  }

  /** 改标记类字段（情绪/语速/停顿/发音/备注/标志位…）——立即写库 */
  async function commitFields(lineId: Id, patch: CanvasLinePatch, label = '修改行属性'): Promise<boolean> {
    const line = lineById.value.get(lineId)
    if (!line) return false
    return commit([buildChange(line, patch, true)], label, { delayMs: 0 })
  }

  /** 指派说话人（表格 / 抽屉 / 待确认队列共用；decidedBy 强制 human） */
  async function assignSpeaker(
    lineId: Id,
    characterId: Id | null,
    options: { speakerType?: 'narration' | 'character'; needsReview?: boolean; label?: string } = {},
  ): Promise<boolean> {
    const line = lineById.value.get(lineId)
    if (!line) return false
    const speakerType = options.speakerType ?? (characterId ? 'character' : 'narration')
    const patch: CanvasLinePatch = {
      characterId,
      speakerType,
      decidedBy: 'human',
      ...(options.needsReview !== undefined ? { needsReview: options.needsReview } : {}),
    }
    return commit([buildChange(line, patch, false)], options.label ?? '指派说话人', { delayMs: 0 })
  }

  /** 批量：一行一个 patch（撤销仍是一条命令） */
  async function commitBatchChanges(changes: LineChange[], label: string): Promise<{ ok: boolean; updated: number }> {
    const ok = await commit(changes, label, { delayMs: 0, affected: changes.length })
    return { ok, updated: ok ? changes.length : 0 }
  }

  /** 批量：同一 patch 应用到多行 */
  async function applyBatchPatch(lineIds: Id[], patch: CanvasLinePatch, label: string): Promise<boolean> {
    const changes: LineChange[] = []
    for (const id of lineIds) {
      const line = lineById.value.get(id)
      if (!line) continue
      changes.push(buildChange(line, patch, patch.decidedBy === undefined))
    }
    if (!changes.length) return false
    return commit(changes, label, { delayMs: 0, affected: changes.length })
  }

  /** 逐行生成 patch 的批量写（撤销一条命令） */
  async function applyBatchChanges(
    lineIds: Id[],
    build: (line: CanvasLine) => CanvasLinePatch,
    label: string,
  ): Promise<boolean> {
    const changes: LineChange[] = []
    for (const id of lineIds) {
      const line = lineById.value.get(id)
      if (!line) continue
      changes.push(buildChange(line, build(line), true))
    }
    if (!changes.length) return false
    return commit(changes, label, { delayMs: 0, affected: changes.length })
  }

  /** 批量加标志位 */
  async function addFlags(lineIds: Id[], flags: string[], label = '添加标记'): Promise<boolean> {
    return applyBatchChanges(lineIds, line => ({ flags: [...new Set([...line.flags, ...flags])] }), label)
  }

  /** 批量移除标志位 */
  async function removeFlags(lineIds: Id[], flags: string[], label = '移除标记'): Promise<boolean> {
    return applyBatchChanges(lineIds, line => ({ flags: line.flags.filter(f => !flags.includes(f)) }), label)
  }

  /** 软删除 / 恢复（docs/11 §4.7：不做物理删除，避免破坏既有引用） */
  async function setDeleted(lineIds: Id[], deleted: boolean, label = deleted ? '删除行' : '恢复行'): Promise<boolean> {
    return applyBatchChanges(
      lineIds,
      line => ({
        flags: deleted
          ? [...new Set([...line.flags, 'deleted'])]
          : line.flags.filter(f => f !== 'deleted'),
      }),
      label,
    )
  }

  /** 锁定（decidedBy='human' + locked 标志）：防重算覆盖，docs/11 §4.7 */
  async function lockHuman(lineIds: Id[], label = '锁定为人工确认'): Promise<boolean> {
    return applyBatchChanges(
      lineIds,
      line => ({ decidedBy: 'human' as const, flags: [...new Set([...line.flags, 'locked'])] }),
      label,
    )
  }

  /**
   * 批量合并相邻旁白行（docs/11 §4.7：合并后文本用句号连接）。
   * 被并入的行打 `deleted` 软删除标记 —— 这样「撤销整批」能完整还原；
   * 刻意不用 canvas:deleteLine 硬删，因为硬删之后撤销栈无法恢复行内容。
   */
  async function mergeAdjacentNarration(lineIds: Id[]): Promise<{ groups: number; merged: number }> {
    const targets = new Set(lineIds)
    const changes: LineChange[] = []
    let groups = 0
    let merged = 0
    let run: CanvasLine[] = []

    const flushRun = (): void => {
      if (run.length >= 2) {
        groups += 1
        const keeper = run[0]!
        const text = run
          .map(l => l.text.trim().replace(/[。！？；，、\s]+$/g, ''))
          .filter(Boolean)
          .join('。') + '。'
        changes.push(buildChange(keeper, { text, flags: keeper.flags.filter(f => f !== 'deleted') }, true))
        for (const absorbed of run.slice(1)) {
          merged += 1
          changes.push(buildChange(absorbed, { flags: [...new Set([...absorbed.flags, 'deleted'])] }, true))
        }
      }
      run = []
    }

    for (const line of lines.value) {
      const isCandidate = targets.has(line.id) && line.kind === 'narration' && line.speakerType === 'narration'
      if (isCandidate) run.push(line)
      else flushRun()
    }
    flushRun()

    if (!changes.length) return { groups: 0, merged: 0 }
    await commit(changes, `合并相邻旁白（${groups} 组 / ${merged} 行）`, { delayMs: 0, affected: changes.length })
    return { groups, merged }
  }

  // -------------------------------------------------------------------------
  // 撤销 / 重做
  // -------------------------------------------------------------------------

  async function undo(): Promise<boolean> {
    const ok = await undoStack.undo()
    await flush() // 撤销后立刻落库：用户按 Ctrl+Z 就期待库里也是撤销后的状态
    return ok
  }

  async function redo(): Promise<boolean> {
    const ok = await undoStack.redo()
    await flush()
    return ok
  }

  /** Ctrl+S：强制落库（含子组件的 EditableField，靠 flushSignal 通知） */
  async function saveNow(): Promise<boolean> {
    flushSignal.value += 1
    return flush()
  }

  /** 放弃未落库的改动（状态栏「放弃修改」）：从库里读回权威值 */
  async function discardUnsaved(): Promise<void> {
    const ids = [...pendingPatches.keys()]
    pendingPatches.clear()
    pendingCount.value = 0
    for (const id of ids) await reloadLine(id, { silent: true })
    saveStatus.value = 'idle'
    saveError.value = null
    conflictLineIds.value = new Set()
    undoStack.clear()
  }

  /** 重新加载单行（乐观锁冲突后的「重新加载」按钮走这里） */
  async function reloadLine(lineId: Id, options: { silent?: boolean } = {}): Promise<CanvasLine | null> {
    try {
      const fresh = await call('canvas:getLine', { lineId }, options.silent ? { onError: 'silent' } : {}) as CanvasLine
      applyServerLine(fresh)
      pendingPatches.delete(lineId)
      pendingCount.value = pendingPatches.size
      conflictLineIds.value = new Set([...conflictLineIds.value].filter(id => id !== lineId))
      return fresh
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // 质检（docs/11 §5）
  // -------------------------------------------------------------------------

  async function loadIssueList(): Promise<void> {
    const id = chapterId.value
    if (!id) {
      issues.value = []
      return
    }
    issuesLoading.value = true
    try {
      issues.value = await call('canvas:qualityCheck', { chapterId: id }) as QualityIssue[]
    } catch {
      issues.value = []
    } finally {
      issuesLoading.value = false
    }
  }

  /**
   * 一键修复（只做 docs/11 §5 允许的安全项）：
   *   · no_pause              → 补默认停顿
   *   · missing_pronunciation → 用多音字表建议填发音提示（只填提示，不改文本）
   * 其余（too_long / empty_text / unassigned / suspicious_speaker …）不自动改，交给人工。
   */
  async function autoFixIssue(issue: QualityIssue): Promise<boolean> {
    if (!issue.autoFixable || !issue.lineId) return false
    const line = lineById.value.get(issue.lineId)
    if (!line) return false

    if (issue.kind === 'no_pause') {
      return commitFields(line.id, { pauseAfterMs: defaultPauseMs.value }, '质检修复：补默认停顿')
    }
    if (issue.kind === 'missing_pronunciation') {
      const suggestion = suggestPronunciationText(line)
      if (!suggestion) return false
      return commitFields(line.id, { pronunciation: suggestion }, '质检修复：补发音提示')
    }
    return false
  }

  // -------------------------------------------------------------------------
  // 生成画本（docs/11 §2）
  // -------------------------------------------------------------------------

  /** 订阅 canvas:progress（阶段 / 已处理 / 总数）；返回取消函数，视图 onUnmounted 必须调用 */
  function subscribeGenerationProgress(): () => void {
    return on('canvas:progress', (payload) => {
      const p = payload as { chapterId: Id; stage: string; processed: number; total: number }
      if (!p || typeof p.chapterId !== 'string') return
      if (chapterId.value && p.chapterId !== chapterId.value) return
      generateProgress.value = { stage: p.stage, processed: p.processed, total: p.total }
    })
  }

  /** 生成任务：返回 taskId（视图用 TaskProgressCard 订阅进度） */
  async function startGenerate(options: CanvasGenerateOptions): Promise<Id | null> {
    const id = chapterId.value
    if (!id) return null
    await flush()
    const res = await call('canvas:generate', { chapterId: id, options }) as { taskId: Id }
    generateTaskId.value = res.taskId
    generateProgress.value = null
    return res.taskId
  }

  /** 生成报告（docs/11 §2.4）：embeddingUsed=false 时 UI 必须显著告知 */
  async function loadReport(): Promise<CanvasGenerateReport | null> {
    const id = chapterId.value
    if (!id) {
      generateReport.value = null
      return null
    }
    try {
      const report = await call('canvas:getGenerateReport', { chapterId: id }) as CanvasGenerateReport | null
      generateReport.value = report
      return report
    } catch {
      generateReport.value = null
      return null
    }
  }

  /** 重算归属（docs/11 §4.6：重命名 / 删别名后要提示重算） */
  async function recomputeAttribution(
    scope: 'low_confidence' | 'all' | 'selection',
    lineIds?: Id[],
  ): Promise<Id | null> {
    const id = chapterId.value
    if (!id) return null
    await flush()
    const res = await call('canvas:recomputeAttribution', {
      chapterId: id,
      scope,
      ...(lineIds?.length ? { lineIds } : {}),
    }) as { taskId: Id }
    generateTaskId.value = res.taskId
    return res.taskId
  }

  // 生成任务结束后自动刷新行 / 报告 / 质检（TaskProgressCard 只负责显示进度）
  const generateProgressView = useTaskProgress(generateTaskId)
  watch(
    () => generateProgressView.isFinished.value,
    async (finished) => {
      if (!finished) return
      // freshReport：这次刷新出来的报告正是「刚生成」的产物 → 允许弹一次降级提示
      await load(chapterId.value, { force: true, freshReport: true })
    },
  )

  // -------------------------------------------------------------------------
  // 试听（docs/11 §4.4：已录音时直接播放，不必跳到录音页）
  // -------------------------------------------------------------------------

  async function loadPlayback(lineId: Id): Promise<{ url: string; takeId: Id; durationMs: number | null; filePath: string } | null> {
    playbackError.value = null
    playbackLineId.value = lineId
    try {
      const takes = await call('take:listByLine', { lineId }) as Take[]
      const take = takes.find(t => t.isSelected) ?? takes[0] ?? null
      if (!take) {
        playbackUrl.value = null
        playbackTakeId.value = null
        playbackDurationMs.value = null
        return null
      }
      const url = segmentUrl(projectId.value ?? '', take.filePath)
      if (!url) {
        playbackUrl.value = null
        return null
      }
      playbackUrl.value = url
      playbackTakeId.value = take.id
      playbackDurationMs.value = take.durationMs ?? null
      return { url, takeId: take.id, durationMs: take.durationMs ?? null, filePath: take.filePath }
    } catch (error) {
      playbackError.value = error
      playbackUrl.value = null
      return null
    }
  }

  function setProjectId(id: Id | null): void {
    projectId.value = id
  }

  function currentProjectId(): Id | null {
    return projectId.value
  }

  function clearPlayback(): void {
    playbackUrl.value = null
    playbackLineId.value = null
    playbackTakeId.value = null
    playbackDurationMs.value = null
  }

  return {
    // 数据
    chapterId, lines, total, loading, loadError, loadedChapterId,
    lineCount, lineById, indexById, activeLine, activeIndex,
    reviewCount, unassignedCount, recordedCount, statusSummary,
    // 视图
    activeView, density, activeLineId, drawerOpen, selectedIds, anchorId,
    selectedCount, selectedLines,
    setActiveView, setDensity, setActiveLine, setScrollTop, scrollTopOf, topIndexOf,
    selectLine, selectAll, selectRange, clearSelection, selectByLineIds, moveActive,
    openDrawer, closeDrawer, focusLine,
    // 加载
    load, ensureLoaded, reload,
    // 编辑
    commitText, commitFields, commitBatchChanges, applyBatchPatch, applyBatchChanges,
    assignSpeaker, addFlags, removeFlags, setDeleted, lockHuman, mergeAdjacentNarration,
    // 落库
    saveStatus, savedAt, saveError, pendingCount, hasUnsaved, flushSignal, conflictLineIds,
    flush, saveNow, discardUnsaved, reloadLine,
    // 撤销
    undo, redo, canUndo: undoStack.canUndo, canRedo: undoStack.canRedo,
    undoLabel: undoStack.undoLabel, redoLabel: undoStack.redoLabel, undoDepth: undoStack.depth,
    undoCapacity: undoStack.capacity, undoHistory: undoStack.history, undoBusy: undoStack.busy,
    handleUndoKeydown: undoStack.handleKeydown,
    // 质检
    issues, issueLineIds, issuesByLineId, issueCounts, issuesLoading, loadIssueList, autoFixIssue,
    // 生成
    generateReport, generateTaskId, generateProgress, reportIsFresh, startGenerate, loadReport,
    subscribeGenerationProgress, recomputeAttribution,
    // 试听
    playbackLineId, playbackUrl, playbackDurationMs, playbackTakeId, playbackError,
    loadPlayback, clearPlayback, setProjectId, currentProjectId,
    // 只读阈值（UI 标注「刚好过线」用）
    threshold, defaultPauseMs, autoAcceptConfidence,
  }
})
