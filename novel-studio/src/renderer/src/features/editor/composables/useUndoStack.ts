/**
 * 画本编辑 · 撤销/重做（命令模式）
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md §4.8
 *   > · 命令模式，每个变更是一个命令对象（UpdateLine、AssignSpeaker、
 *   >   MergeCharacters、BatchUpdate）。
 *   > · 栈深 ≥ 100；Ctrl+Z / Ctrl+Shift+Z。
 *   > · 撤销一个「批量操作」= 一次性撤销整批（不是逐行）。
 *   > · 编辑立即进内存 + 进撤销栈，防抖 500 ms 后批量写库。
 *
 * 为什么不做成「快照整章」：一章 5000 行，每次按键存一份快照会让内存爆掉；
 * 命令模式只存「这一行改了什么」，撤销批量操作时也只是一条命令里带 N 行差异。
 *
 * 本文件不碰 IPC、不碰 DOM：只维护两个栈，并暴露 handleKeydown 供 useCanvasKeyboard 复用。
 * 「撤销要写库」这件事由命令自身的 undo()/redo() 实现（canvas.store 里负责）。
 */

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { matchEvent, parseShortcut } from '@/shared/lib/shortcuts.ts'
import type { ParsedShortcut } from '@/shared/lib/shortcuts.ts'

/** 单条撤销命令 */
export interface UndoCommand {
  /** 唯一 id（诊断与调试用） */
  id: string
  /** 展示名（如「指派说话人」「批量设置情绪」），撤销栈提示条与快捷键面板都用它 */
  label: string
  /** 撤销：把内存与库都还原到命令执行前 */
  undo: () => void | Promise<void>
  /** 重做：再次应用（execute() 时第一次执行也走它） */
  redo: () => void | Promise<void>
  /** 影响行数（批量命令填写，UI 显示「撤销整批（N 行）」） */
  affected?: number
  /**
   * 合并键：连续同类命令在 mergeWindowMs 内合并为一条。
   * 典型场景：同一行的连续文本输入最终只留一条撤销记录（否则按 100 次 Ctrl+Z 才能退回去）。
   */
  mergeKey?: string
  /** 入栈时间 */
  at: number
}

export type UndoDirection = 'undo' | 'redo'

export interface UseUndoStackOptions {
  /** 栈深，docs/11 §4.8 要求 ≥ 100 */
  capacity?: number
  /** 失败回调：命令的 undo/redo 抛错时调用（写库失败不该静默吞掉） */
  onError?: (error: unknown, command: UndoCommand, direction: UndoDirection) => void
  /** 命令合并窗口（毫秒）；0 表示不合并 */
  mergeWindowMs?: number
  /** 现在时间（可注入，便于测试） */
  now?: () => number
}

export interface UseUndoStack {
  /** 可撤销命令（栈顶在末尾） */
  undoStack: Ref<UndoCommand[]>
  /** 可重做命令 */
  redoStack: Ref<UndoCommand[]>
  canUndo: ComputedRef<boolean>
  canRedo: ComputedRef<boolean>
  /** 栈顶命令名（按钮 tooltip：「撤销 指派说话人」） */
  undoLabel: ComputedRef<string>
  redoLabel: ComputedRef<string>
  /** 当前栈深（UI 显示「撤销栈 12/100」） */
  depth: ComputedRef<number>
  capacity: ComputedRef<number>
  /** 正在执行 undo/redo（防止连点导致栈错乱） */
  busy: Ref<boolean>
  /** 入栈（命令已经执行过了，只记录） */
  push: (command: Omit<UndoCommand, 'id' | 'at'> & { id?: string }) => UndoCommand
  /** 执行并入栈（正常编辑路径用它） */
  execute: (command: Omit<UndoCommand, 'id' | 'at'> & { id?: string }) => Promise<boolean>
  undo: () => Promise<boolean>
  redo: () => Promise<boolean>
  /** 清空（切换章节时调用，避免撤销到别的章的行） */
  clear: () => void
  setCapacity: (next: number) => void
  /** Ctrl+Z / Ctrl+Shift+Z；返回 true 表示已消费该按键 */
  handleKeydown: (event: KeyboardEvent) => boolean
  /** 撤销历史标签（倒序，供「历史」面板显示） */
  history: ComputedRef<string[]>
}

const DEFAULTS: { capacity: number; mergeWindowMs: number } = { capacity: 100, mergeWindowMs: 600 }

/** Ctrl+Z（撤销）/ Ctrl+Y 或 Ctrl+Shift+Z（重做） */
export const UNDO_SHORTCUT = 'Ctrl+Z'
export const REDO_SHORTCUTS: ParsedShortcut[] = [
  parseShortcut('Ctrl+Shift+Z'),
  parseShortcut('Ctrl+Y'),
]

let seq = 0
function nextId(): string {
  seq += 1
  return `cmd_${Date.now().toString(36)}_${seq}`
}

/**
 * 创建一个撤销栈。**不要**在组件外把它当全局单例用 ——
 * 画本编辑域只有 canvas.store 持有它，其他组件通过 store 的 undo()/redo() 使用。
 */
export function useUndoStack(options: UseUndoStackOptions = {}): UseUndoStack {
  let limit = Math.max(1, Math.floor(options.capacity ?? DEFAULTS.capacity))
  const mergeWindowMs = Math.max(0, options.mergeWindowMs ?? DEFAULTS.mergeWindowMs)
  const now = options.now ?? (() => Date.now())

  const undoStack = ref<UndoCommand[]>([])
  const redoStack = ref<UndoCommand[]>([])
  const busy = ref(false)

  const canUndo = computed(() => undoStack.value.length > 0 && !busy.value)
  const canRedo = computed(() => redoStack.value.length > 0 && !busy.value)
  const undoLabel = computed(() => undoStack.value[undoStack.value.length - 1]?.label ?? '')
  const redoLabel = computed(() => redoStack.value[redoStack.value.length - 1]?.label ?? '')
  const depth = computed(() => undoStack.value.length)
  const capacity = computed(() => limit)
  const history = computed(() => [...undoStack.value].reverse().map(c => c.label))

  /** 超出容量时丢最旧的（不是丢最新的 —— 用户最近的操作最可能想撤销） */
  function trim(): void {
    if (undoStack.value.length > limit) {
      undoStack.value = undoStack.value.slice(undoStack.value.length - limit)
    }
  }

  function push(command: Omit<UndoCommand, 'id' | 'at'> & { id?: string }): UndoCommand {
    const at = now()
    const full: UndoCommand = {
      id: command.id ?? nextId(),
      label: command.label,
      undo: command.undo,
      redo: command.redo,
      at,
      ...(command.affected !== undefined ? { affected: command.affected } : {}),
      ...(command.mergeKey !== undefined ? { mergeKey: command.mergeKey } : {}),
    }

    // 合并：栈顶同类命令且在时间窗口内 → 保留旧命令的 undo（回到最初状态），采用新命令的 redo
    const top = undoStack.value[undoStack.value.length - 1]
    if (top && full.mergeKey && top.mergeKey === full.mergeKey && at - top.at <= mergeWindowMs) {
      const merged: UndoCommand = { ...top, redo: full.redo, at, label: full.label }
      undoStack.value = [...undoStack.value.slice(0, -1), merged]
    } else {
      undoStack.value = [...undoStack.value, full]
    }

    // 新操作产生后，重做链必然失效
    if (redoStack.value.length) redoStack.value = []
    trim()
    return full
  }

  async function execute(command: Omit<UndoCommand, 'id' | 'at'> & { id?: string }): Promise<boolean> {
    const full = push(command)
    try {
      await full.redo()
      return true
    } catch (error) {
      // 执行失败：把命令从栈里摘掉，避免出现「撤销一个从未生效的操作」
      undoStack.value = undoStack.value.filter(c => c.id !== full.id)
      options.onError?.(error, full, 'redo')
      return false
    }
  }

  async function undo(): Promise<boolean> {
    if (busy.value) return false
    const command = undoStack.value[undoStack.value.length - 1]
    if (!command) return false

    busy.value = true
    try {
      await command.undo()
      undoStack.value = undoStack.value.slice(0, -1)
      redoStack.value = [...redoStack.value, command]
      return true
    } catch (error) {
      // 撤销失败：命令留在栈上（用户可重试），并明确报错，绝不假装成功
      options.onError?.(error, command, 'undo')
      return false
    } finally {
      busy.value = false
    }
  }

  async function redo(): Promise<boolean> {
    if (busy.value) return false
    const command = redoStack.value[redoStack.value.length - 1]
    if (!command) return false

    busy.value = true
    try {
      await command.redo()
      redoStack.value = redoStack.value.slice(0, -1)
      undoStack.value = [...undoStack.value, command]
      trim()
      return true
    } catch (error) {
      options.onError?.(error, command, 'redo')
      return false
    } finally {
      busy.value = false
    }
  }

  function clear(): void {
    undoStack.value = []
    redoStack.value = []
  }

  function setCapacity(next: number): void {
    limit = Math.max(1, Math.floor(next))
    trim()
  }

  /** 全局快捷键：Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做（docs/11 §4.8） */
  function handleKeydown(event: KeyboardEvent): boolean {
    if (matchEvent(event, REDO_SHORTCUTS[0]!) || matchEvent(event, REDO_SHORTCUTS[1]!)) {
      void redo()
      return true
    }
    if (matchEvent(event, UNDO_SHORTCUT)) {
      void undo()
      return true
    }
    return false
  }

  return {
    undoStack, redoStack,
    canUndo, canRedo, undoLabel, redoLabel, depth, capacity, busy,
    push, execute, undo, redo, clear, setCapacity, handleKeydown, history,
  }
}
