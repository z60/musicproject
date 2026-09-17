/**
 * 书籍导入域 · 章节多选（单击 / Shift 范围选 / Ctrl 多选 / 全选 / 反选 / 清空）
 * ============================================================================
 * 为什么要单独抽一个 composable：
 *   章节管理页有 12 个批量操作入口（合并、删除、生成画本、批量改类型……），
 *   如果每个入口都自己维护一份「选了哪些行」，必然出现「表格显示勾了 3 行、
 *   批量删除却删了 5 行」这类事故。因此把选择语义收敛到一处，并配两条纪律：
 *     1. **选择以 id 为真**，不以行号为真 —— 列表会被搜索/过滤/重排，行号随时会变；
 *     2. 过滤后要把「当前不可见的 id」从选择里剪掉（`prune`），
 *        否则用户会对着看不见的行执行批量操作（这是最危险的一类 bug）。
 *
 * 交互约定（桌面软件通例）：
 *   · 单击            → 只选这一行，并把锚点落在这里
 *   · Ctrl/⌘ + 单击    → 切换这一行的选中态
 *   · Shift + 单击     → 从锚点到这里的**区间**（替换原有选择）
 *   · Ctrl+Shift 单击  → 区间**追加**到原有选择
 */

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

export interface SelectionModifiers {
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
}

export interface ChapterSelection {
  /** 已选中的章节 id（顺序 = 用户点选顺序，批量操作按此顺序执行） */
  selectedIds: Ref<string[]>
  selectedCount: ComputedRef<number>
  /** 锚点：Shift 范围选择的起点（-1 表示还没有锚点） */
  anchorIndex: Ref<number>
  hasSelected: ComputedRef<boolean>
  canMerge: ComputedRef<boolean>
  isSelected: (id: string) => boolean
  /** 表格行点击入口：把修饰键一并传进来，语义由本 composable 决定 */
  click: (index: number, modifiers?: SelectionModifiers) => void
  toggle: (id: string) => void
  selectOnly: (id: string) => void
  selectAt: (index: number) => void
  selectRange: (from: number, to: number, additive?: boolean) => void
  selectAll: () => void
  invert: () => void
  clear: () => void
  setSelection: (ids: string[]) => void
  /** 批量操作完成后收起选择（并复位锚点） */
  reset: () => void
  /** 用「当前可见 id」剪掉不可见的选中项（过滤/重排/删除后必须调用） */
  prune: (validIds: readonly string[]) => void
  /** 选中项的序号列表（用于「从第 N 章开始」这类文案） */
  selectedIndexes: (ids: readonly string[]) => number[]
  /** 选中项中的第一项（跳转录音/对轨时定位用） */
  firstSelected: () => string | null
}

/**
 * @param getIds 取「当前顺序下的全部行 id」（必须是最新的：过滤后的可见列表由调用方决定）
 */
export function useChapterSelection(getIds: () => readonly string[]): ChapterSelection {
  const selectedIds = ref<string[]>([])
  const anchorIndex = ref(-1)

  const selectedCount = computed(() => selectedIds.value.length)
  const hasSelected = computed(() => selectedIds.value.length > 0)
  /** 合并至少需要 2 章（docs/10 §7.1） */
  const canMerge = computed(() => selectedIds.value.length >= 2)

  function isSelected(id: string): boolean {
    return selectedIds.value.includes(id)
  }

  function setSelection(ids: string[]): void {
    selectedIds.value = [...new Set(ids)]
  }

  function selectOnly(id: string): void {
    const index = getIds().indexOf(id)
    anchorIndex.value = index
    selectedIds.value = [id]
  }

  function toggle(id: string): void {
    if (isSelected(id)) selectedIds.value = selectedIds.value.filter(x => x !== id)
    else selectedIds.value = [...selectedIds.value, id]
  }

  function selectAt(index: number): void {
    const ids = getIds()
    const id = ids[index]
    if (!id) return
    selectOnly(id)
  }

  function selectRange(from: number, to: number, additive = false): void {
    const ids = getIds()
    if (!ids.length) return
    const start = Math.max(0, Math.min(from, ids.length - 1))
    const end = Math.max(0, Math.min(to, ids.length - 1))
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    const range = ids.slice(lo, hi + 1)
    selectedIds.value = additive ? [...new Set([...selectedIds.value, ...range])] : range
  }

  function click(index: number, modifiers: SelectionModifiers = {}): void {
    const ids = getIds()
    const id = ids[index]
    if (!id) return

    const withRange = modifiers.shift === true
    const withToggle = modifiers.ctrl === true || modifiers.meta === true

    if (withRange) {
      const anchor = anchorIndex.value >= 0 ? anchorIndex.value : index
      // Ctrl+Shift：区间追加；纯 Shift：区间替换原有选择
      selectRange(anchor, index, withToggle)
      return
    }

    if (withToggle) {
      toggle(id)
      anchorIndex.value = index
      return
    }

    anchorIndex.value = index
    selectedIds.value = [id]
  }

  function selectAll(): void {
    selectedIds.value = [...getIds()]
  }

  function invert(): void {
    const selected = new Set(selectedIds.value)
    selectedIds.value = getIds().filter(id => !selected.has(id))
  }

  function clear(): void {
    selectedIds.value = []
  }

  function reset(): void {
    selectedIds.value = []
    anchorIndex.value = -1
  }

  function prune(validIds: readonly string[]): void {
    const valid = new Set(validIds)
    const next = selectedIds.value.filter(id => valid.has(id))
    if (next.length !== selectedIds.value.length) selectedIds.value = next
    if (anchorIndex.value >= validIds.length) anchorIndex.value = -1
  }

  function selectedIndexes(ids: readonly string[]): number[] {
    const selected = new Set(selectedIds.value)
    const out: number[] = []
    ids.forEach((id, index) => {
      if (selected.has(id)) out.push(index)
    })
    return out
  }

  function firstSelected(): string | null {
    const ids = getIds()
    const selected = new Set(selectedIds.value)
    return ids.find(id => selected.has(id)) ?? null
  }

  return {
    selectedIds,
    selectedCount,
    anchorIndex,
    hasSelected,
    canMerge,
    isSelected,
    click,
    toggle,
    selectOnly,
    selectAt,
    selectRange,
    selectAll,
    invert,
    clear,
    setSelection,
    reset,
    prune,
    selectedIndexes,
    firstSelected,
  }
}
