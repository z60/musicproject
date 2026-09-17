/**
 * 画本编辑域 · 键盘操作与快捷键（全键盘工作流）
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md
 *   · §4.2 表格视图：键盘上下移动选中行、按候选序号直接指派说话人
 *   · §4.5 待确认队列：数字键 1/2/3 选候选、Enter 确认并下一行、S 跳过、P 播放、Z 撤销、
 *          Ctrl+Enter 把当前角色应用到下面 N 行、Ctrl+Shift+Enter 一键确认高置信
 *   · §4.8 Ctrl+Z / Ctrl+Shift+Z 撤销重做、Ctrl+S 强制落库
 *
 * 两条硬性纪律：
 *   1. 必须用 `isEditableTarget` 判断焦点 —— 用户在输入框里打字时按 S 不能被当成「跳过」。
 *      只放行 Ctrl+S（保存）与 Escape（关闭），这两个在任何焦点下都应该生效。
 *   2. 键位一律走 `parseShortcut` / `matchEvent`（修饰键顺序无关、大小写不敏感），
 *      不在组件里写 `event.key === 'S'` 这种脆弱判断。
 *
 * 队列的键位表直接复用 shared/lib/shortcuts.ts 的 REVIEW_QUEUE_SHORTCUTS，
 * 目的是让「界面上提示的键」与「真正生效的键」永远同源（否则改一处忘一处）。
 */

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import {
  isEditableTarget,
  matchAny,
  parseShortcut,
  REVIEW_QUEUE_SHORTCUTS,
} from '@/shared/lib/shortcuts.ts'
import type { ShortcutBinding } from '@/shared/lib/shortcuts.ts'

export type CanvasKeyboardScope = 'table' | 'script' | 'review'

/** 动作回调：返回 void 即可；抛错不影响其他按键 */
export interface CanvasKeyboardActions {
  'editor.prevLine'?: (extend: boolean) => void
  'editor.nextLine'?: (extend: boolean) => void
  'editor.pageUp'?: () => void
  'editor.pageDown'?: () => void
  'editor.firstLine'?: () => void
  'editor.lastLine'?: () => void
  'editor.selectAll'?: () => void
  'editor.clearSelection'?: () => void
  'editor.openDrawer'?: () => void
  'editor.closeDrawer'?: () => void
  'editor.toggleView'?: () => void
  'editor.showTable'?: () => void
  'editor.showScript'?: () => void
  'editor.showReview'?: () => void
  'editor.save'?: () => void
  'editor.undo'?: () => void
  'editor.redo'?: () => void
  'editor.pick1'?: () => void
  'editor.pick2'?: () => void
  'editor.pick3'?: () => void
  'editor.setNarration'?: () => void
  'review.pick1'?: () => void
  'review.pick2'?: () => void
  'review.pick3'?: () => void
  'review.confirm'?: () => void
  'review.skip'?: () => void
  'review.play'?: () => void
  'review.undo'?: () => void
  'review.applyRun'?: () => void
  'review.acceptHigh'?: () => void
  'review.next'?: () => void
  'review.prev'?: () => void
}

/** 编辑器（表格 / 剧本）通用键位 */
export const EDITOR_SHORTCUTS: ShortcutBinding[] = [
  { id: 'editor.prevLine', shortcut: 'Up', label: '上一行', scope: 'editor' },
  { id: 'editor.nextLine', shortcut: 'Down', label: '下一行', scope: 'editor' },
  { id: 'editor.pageUp', shortcut: 'PageUp', label: '上一屏', scope: 'editor' },
  { id: 'editor.pageDown', shortcut: 'PageDown', label: '下一屏', scope: 'editor' },
  { id: 'editor.firstLine', shortcut: 'Ctrl+Home', label: '跳到首行', scope: 'editor' },
  { id: 'editor.lastLine', shortcut: 'Ctrl+End', label: '跳到末行', scope: 'editor' },
  { id: 'editor.selectAll', shortcut: 'Ctrl+A', label: '全选', scope: 'editor' },
  { id: 'editor.clearSelection', shortcut: 'Escape', label: '取消选择 / 关闭抽屉', scope: 'editor' },
  { id: 'editor.openDrawer', shortcut: 'Enter', label: '打开单行编辑抽屉', scope: 'editor' },
  { id: 'editor.showTable', shortcut: 'Ctrl+1', label: '表格视图', scope: 'editor' },
  { id: 'editor.showScript', shortcut: 'Ctrl+2', label: '剧本视图', scope: 'editor' },
  { id: 'editor.showReview', shortcut: 'Ctrl+3', label: '待确认队列', scope: 'editor' },
  { id: 'editor.pick1', shortcut: '1', label: '指派候选 1', scope: 'editor' },
  { id: 'editor.pick2', shortcut: '2', label: '指派候选 2', scope: 'editor' },
  { id: 'editor.pick3', shortcut: '3', label: '指派候选 3', scope: 'editor' },
  { id: 'editor.setNarration', shortcut: 'N', label: '设为旁白', scope: 'editor' },
  { id: 'editor.save', shortcut: 'Ctrl+S', label: '立即保存', scope: 'editor' },
  { id: 'editor.undo', shortcut: 'Ctrl+Z', label: '撤销', scope: 'editor' },
  { id: 'editor.redo', shortcut: 'Ctrl+Shift+Z', label: '重做', scope: 'editor' },
]

/** 队列额外键位（REVIEW_QUEUE_SHORTCUTS 之外的导航与保存） */
export const REVIEW_EXTRA_SHORTCUTS: ShortcutBinding[] = [
  { id: 'review.prev', shortcut: 'Up', label: '上一行', scope: 'review' },
  { id: 'review.next', shortcut: 'Down', label: '下一行', scope: 'review' },
  { id: 'editor.save', shortcut: 'Ctrl+S', label: '立即保存', scope: 'review' },
  { id: 'editor.undo', shortcut: 'Ctrl+Z', label: '撤销（含批量）', scope: 'review' },
  { id: 'editor.redo', shortcut: 'Ctrl+Shift+Z', label: '重做', scope: 'review' },
  { id: 'editor.showTable', shortcut: 'Ctrl+1', label: '回到表格', scope: 'review' },
  { id: 'editor.showScript', shortcut: 'Ctrl+2', label: '回到剧本', scope: 'review' },
]

/** 任何焦点下都放行的键（输入框里也要能用） */
const ALWAYS_ALLOWED = ['Ctrl+S', 'Escape']

export interface CanvasKeyboardOptions {
  scope: CanvasKeyboardScope | (() => CanvasKeyboardScope)
  actions: CanvasKeyboardActions
  /** 是否启用（抽屉打开、只读、弹窗打开时可关闭部分键） */
  enabled?: () => boolean
  /** 监听目标：默认 window */
  target?: () => EventTarget | null
}

export interface UseCanvasKeyboard {
  /** 手动处理一次按键；返回 true 表示已消费 */
  handleKeydown: (event: KeyboardEvent) => boolean
  attach: () => void
  detach: () => void
  /** 当前作用域的键位表（底部提示行与帮助面板用它，保证与实现同源） */
  bindings: ComputedRef<ShortcutBinding[]>
  /** 取某个动作的展示串，如 `Ctrl+Enter` */
  hint: (id: string) => string
  /** 焦点是否在输入控件里（底部提示行可以据此提示「输入中」） */
  editing: Ref<boolean>
  /** 已消费的按键次数（诊断/调试用） */
  handledCount: Ref<number>
}

export function useCanvasKeyboard(options: CanvasKeyboardOptions): UseCanvasKeyboard {
  const editing = ref(false)
  const handledCount = ref(0)
  let attached: EventTarget | null = null

  const bindings = computed<ShortcutBinding[]>(() => {
    const scope = typeof options.scope === 'function' ? options.scope() : options.scope
    if (scope === 'review') return [...REVIEW_QUEUE_SHORTCUTS, ...REVIEW_EXTRA_SHORTCUTS]
    return EDITOR_SHORTCUTS
  })

  function hint(id: string): string {
    const binding = bindings.value.find(b => b.id === id)
    if (!binding) return ''
    const parsed = parseShortcut(binding.shortcut)
    return parsed.valid ? parsed.display : binding.shortcut
  }

  function isAllowedWhileEditing(event: KeyboardEvent): boolean {
    return ALWAYS_ALLOWED.some(shortcut => matchAny(event, [{ id: 'always', shortcut }]) !== null)
  }

  function handleKeydown(event: KeyboardEvent): boolean {
    editing.value = isEditableTarget(event.target)

    if (options.enabled && !options.enabled()) return false

    // 输入框里只放行保存与关闭（docs/11 §4.5「输入框里不抢键」）
    if (editing.value && !isAllowedWhileEditing(event)) return false

    const binding = matchAny(event, bindings.value)
    if (!binding) return false

    const action = (options.actions as Record<string, ((extend: boolean) => void) | (() => void) | undefined>)[binding.id]
    if (!action) return false

    // 上下键带 Shift = 扩展选择（与表格的 Shift 范围选择一致）
    const wantsExtend = binding.id === 'editor.prevLine' || binding.id === 'editor.nextLine'
      ? event.shiftKey
      : false

    event.preventDefault()
    event.stopPropagation()
    handledCount.value += 1
    try {
      ;(action as (extend: boolean) => void)(wantsExtend)
    } catch {
      // 单个动作失败不该拖垮键盘流（错误本身已由 store / error-bus 兑现）
    }
    return true
  }

  function onKeydown(event: Event): void {
    handleKeydown(event as KeyboardEvent)
  }

  function attach(): void {
    const target = options.target?.() ?? globalThis.window
    if (!target || attached === target) return
    detach()
    target.addEventListener('keydown', onKeydown as EventListener)
    attached = target
  }

  function detach(): void {
    if (!attached) return
    attached.removeEventListener('keydown', onKeydown as EventListener)
    attached = null
  }

  return { handleKeydown, attach, detach, bindings, hint, editing, handledCount }
}
