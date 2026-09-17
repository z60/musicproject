/**
 * 录音域 · take（试录版本）数据与选择
 * ============================================================================
 * 设计依据：
 *   · docs/12 §8.1 —— 多 take 管理：**任何 take 都不自动删除**（除用户显式清理）；
 *                     `is_selected` 决定成品，选中后更新 voice_segments.take_id
 *   · docs/12 §3.3 —— 超长行分段录：`partIndex` 记录顺序，合成时按序 concat
 *   · docs/12 §10  —— TakeList（试听/设为成品/删除/打标/合并分段）、TakeFlagsPanel
 *   · docs/12 §13  —— 多 take 测试：同一行录 5 次全部保留、A/B 可切、成品唯一
 *
 * 为什么要有「撤销上一个 take 选择」（Ctrl+Z，docs/12 §9.1）：
 *   逐行录音是高频重复动作，用户选错成品是常态。撤销栈只记录**选择**这一件事，
 *   不做通用 undo（录音本身不可撤销，删掉的 take 也不能靠它找回）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import type { Take, VoiceSegment } from '@shared/types.ts'

/** take 问题标记（docs/12 §8.1 的 flags 取值 + docs/12 §7 的啸叫反馈） */
export interface TakeFlagPreset {
  key: string
  label: string
  /** 是否为「必须重录」级别的问题（UI 用红色，并提示重录） */
  severe: boolean
  hint: string
}

export const TAKE_FLAG_PRESETS: TakeFlagPreset[] = [
  { key: 'clip', label: '削波', severe: true, hint: '输入过载，建议降低增益后重录（docs/05 §2.5）' },
  { key: 'noise', label: '噪声', severe: true, hint: '底噪/环境声过大，可用处理链降噪' },
  { key: 'feedback', label: '啸叫', severe: true, hint: '监听返送被麦克风拾取（docs/12 §7）' },
  { key: 'too_long', label: '过长', severe: false, hint: '多半是忘了停（docs/12 §3.3）' },
  { key: 'too_short', label: '过短', severe: false, hint: '可能是误触或吞字' },
  { key: 'retake', label: '待重录', severe: false, hint: '表演不满意，稍后重录' },
  { key: 'reported', label: '文本有问题', severe: false, hint: '任务包模式下反馈给导演侧（docs/12 §5）' },
]

export interface TakeSelectionUndo {
  lineId: string
  /** 撤销时要选回的 take（可能为 null：此前根本没有成品） */
  previousTakeId: string | null
}

export const useTakesStore = defineStore('recording/takes', () => {
  /** lineId → take 列表（按 partIndex、录制时间排序后的结果缓存在 sortedCache 里） */
  const byLine = ref<Record<string, Take[]>>({})
  const loading = ref(false)
  const lastError = ref<unknown>(null)
  /** 打标筛选：只显示含这些标记的 take（空数组 = 不过滤） */
  const activeFlags = ref<string[]>([])
  /** Ctrl+Z 撤销栈（只存「选择成品」这一种操作） */
  const undoStack = ref<TakeSelectionUndo[]>([])
  /** 正在编辑备注/标记的 take（TakeFlagsPanel 用，避免多个面板同时改同一行） */
  const editingTakeId = ref<string | null>(null)

  const canUndo = computed(() => undoStack.value.length > 0)

  /** 排序：分段按 partIndex 升序，同段位按录制时间升序（docs/12 §3.3） */
  function sortTakes(list: Take[]): Take[] {
    return [...list].sort((a, b) => (a.partIndex - b.partIndex) || (a.recordedAt - b.recordedAt))
  }

  function takesOf(lineId: string): Take[] {
    return sortTakes(byLine.value[lineId] ?? [])
  }

  /** 过滤后的可见 take（TakeList 直接用） */
  function visibleOf(lineId: string): Take[] {
    const list = takesOf(lineId)
    if (!activeFlags.value.length) return list
    return list.filter(t => t.flags.some(f => activeFlags.value.includes(f)))
  }

  /** 当前成品（isSelected 唯一；若数据异常出现多个，取第一个并在 UI 上提示） */
  function selectedOf(lineId: string): Take | null {
    return takesOf(lineId).find(t => t.isSelected) ?? null
  }

  /** 是否存在多个 isSelected（数据异常，docs/12 §13「设为成品唯一」） */
  function hasMultipleSelected(lineId: string): boolean {
    return takesOf(lineId).filter(t => t.isSelected).length > 1
  }

  /** 该行所有 take 的合计时长（过长行的分段合并判断用） */
  function totalDurationOf(lineId: string): number {
    return takesOf(lineId).reduce((sum, t) => sum + (t.durationMs ?? 0), 0)
  }

  /** 是否具备合并分段的条件：同一行 ≥2 个 part（docs/12 §3.3） */
  function canCombineParts(lineId: string): boolean {
    const list = takesOf(lineId)
    return list.length >= 2 && new Set(list.map(t => t.partIndex)).size >= 2
  }

  async function loadByLine(lineId: string): Promise<Take[]> {
    loading.value = true
    try {
      const list = (await callSafe('take:listByLine', { lineId })) as Take[] | null
      byLine.value = { ...byLine.value, [lineId]: sortTakes(list ?? []) }
      return takesOf(lineId)
    } finally {
      loading.value = false
    }
  }

  /** 整章 take 一次性载入（任务包模式的「导出 take 列表」与章节进度统计用） */
  async function loadByChapter(chapterId: string): Promise<Take[]> {
    loading.value = true
    try {
      const list = (await callSafe('take:listByChapter', { chapterId })) as Take[] | null
      const grouped: Record<string, Take[]> = { ...byLine.value }
      for (const take of list ?? []) {
        grouped[take.lineId] = sortTakes([...(grouped[take.lineId] ?? []).filter(t => t.id !== take.id), take])
      }
      byLine.value = grouped
      return list ?? []
    } finally {
      loading.value = false
    }
  }

  /** 录音定稿返回的新 take 直接进内存（避免立刻回查数据库） */
  function addTake(take: Take): void {
    const list = byLine.value[take.lineId] ?? []
    byLine.value = { ...byLine.value, [take.lineId]: sortTakes([...list.filter(t => t.id !== take.id), take]) }
  }

  function replaceTake(take: Take): void {
    addTake(take)
  }

  /**
   * 设为成品：`take:setSelected` 返回更新后的 segment。
   * 乐观更新 isSelected，失败由 error-bus 兑现并把本地状态回滚（不能假装成功）。
   */
  async function setSelected(lineId: string, takeId: string): Promise<VoiceSegment | null> {
    const previous = selectedOf(lineId)
    undoStack.value = [...undoStack.value, { lineId, previousTakeId: previous?.id ?? null }]
    patchLocalSelected(lineId, takeId)
    try {
      const segment = (await call('take:setSelected', { lineId, takeId })) as VoiceSegment
      return segment
    } catch (error) {
      lastError.value = error
      patchLocalSelected(lineId, previous?.id ?? null)
      undoStack.value = undoStack.value.slice(0, -1)
      throw error
    }
  }

  /** 撤销上一次「设为成品」（Ctrl+Z / take.undoSelect） */
  async function undoSelect(): Promise<boolean> {
    const entry = undoStack.value[undoStack.value.length - 1]
    if (!entry) return false
    undoStack.value = undoStack.value.slice(0, -1)
    if (!entry.previousTakeId) return false
    patchLocalSelected(entry.lineId, entry.previousTakeId)
    await callSafe('take:setSelected', { lineId: entry.lineId, takeId: entry.previousTakeId })
    return true
  }

  function patchLocalSelected(lineId: string, takeId: string | null): void {
    const list = byLine.value[lineId]
    if (!list) return
    byLine.value = {
      ...byLine.value,
      [lineId]: list.map(t => ({ ...t, isSelected: takeId !== null && t.id === takeId })),
    }
  }

  /**
   * 删除 take：默认软删（`hard:false`），界面上必须明确「软删可恢复」
   * （docs/12 §8.1：任何 take 都不自动删除，除用户显式清理）。
   */
  async function remove(takeId: string, hard = false): Promise<boolean> {
    const result = await callSafe('take:delete', { takeId, hard })
    if (!result?.ok) return false
    const next: Record<string, Take[]> = {}
    for (const [line, list] of Object.entries(byLine.value)) {
      const filtered = list.filter(t => t.id !== takeId)
      // 软删：本地先从列表移除（主进程侧仍保留，用户可在回收站找回）
      next[line] = filtered
    }
    byLine.value = next
    return true
  }

  /** 打标：整体替换 flags（take:flag 的语义就是「写入这组标记」） */
  async function applyFlags(takeId: string, flags: string[]): Promise<Take | null> {
    const updated = (await callSafe('take:flag', { takeId, flags })) as Take | null
    if (updated) replaceTake(updated)
    return updated
  }

  /** 快捷打标：切换单个标记（TakeList / TakeFlagsPanel 的快捷按钮） */
  async function toggleFlag(takeId: string, flag: string): Promise<Take | null> {
    const current = findTake(takeId)
    if (!current) return null
    const next = current.flags.includes(flag)
      ? current.flags.filter(f => f !== flag)
      : [...current.flags, flag]
    return await applyFlags(takeId, next)
  }

  /** 合并分段：超长行多个 part → 合成一个 take（docs/12 §3.3 的决策） */
  async function combineParts(lineId: string, takeIds: string[]): Promise<string | null> {
    const result = await callSafe('take:combineParts', { lineId, takeIds })
    if (!result?.takeId) return null
    await loadByLine(lineId)
    return result.takeId
  }

  function findTake(takeId: string): Take | null {
    for (const list of Object.values(byLine.value)) {
      const found = list.find(t => t.id === takeId)
      if (found) return found
    }
    return null
  }

  function lineOfTake(takeId: string): string | null {
    for (const [lineId, list] of Object.entries(byLine.value)) {
      if (list.some(t => t.id === takeId)) return lineId
    }
    return null
  }

  function toggleFlagFilter(flag: string): void {
    activeFlags.value = activeFlags.value.includes(flag)
      ? activeFlags.value.filter(f => f !== flag)
      : [...activeFlags.value, flag]
  }

  function setFlagFilters(flags: string[]): void {
    activeFlags.value = [...flags]
  }

  function clearLine(lineId: string): void {
    const { [lineId]: _removed, ...rest } = byLine.value
    byLine.value = rest
  }

  function clear(): void {
    byLine.value = {}
    activeFlags.value = []
    undoStack.value = []
    editingTakeId.value = null
  }

  /** 某一行是否有「同一 part 多个 take」——逐行模式提示「多 take 请选成品」 */
  function needsSelection(lineId: string): boolean {
    const list = takesOf(lineId)
    return list.length > 1 && !list.some(t => t.isSelected)
  }

  return {
    byLine, loading, lastError, activeFlags, undoStack, editingTakeId,
    canUndo,
    takesOf, visibleOf, selectedOf, hasMultipleSelected, totalDurationOf, canCombineParts, needsSelection,
    loadByLine, loadByChapter, addTake, replaceTake, setSelected, undoSelect,
    remove, applyFlags, toggleFlag, combineParts, findTake, lineOfTake,
    toggleFlagFilter, setFlagFilters, clearLine, clear,
  }
})
