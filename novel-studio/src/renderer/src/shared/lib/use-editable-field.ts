/**
 * Novel Studio · useEditableField（把 EditableField 接到 Vue 响应式与 error-bus）
 * ============================================================================
 * 设计依据：
 *   · docs/11 §4.9 —— 文本编辑防抖 500 ms 写库（乐观 UI）；失败必须明确提示
 *     「修改仍在内存中」，并给重试；不能假装保存成功
 *   · docs/11 §4.8 —— 编辑立即进内存，Ctrl+S / 切章节强制落库
 *   · docs/22 §6.2 —— 消息展示只允许走 error-bus（本文件是唯一处理自动保存失败的地方）
 *
 * 为什么拆成两个文件：
 *   `editable-debounce.ts` 是**零依赖纯逻辑**（可直接被 node --experimental-strip-types 跑），
 *   本文件才引入 vue。这样「防抖/乐观 UI/回滚」的核心语义可以脱离框架被审阅与测试。
 */

import { onScopeDispose, ref, shallowRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import { EditableField } from './editable-debounce.ts'
import type { EditableFieldHooks, SaveStatus, WriteFn } from './editable-debounce.ts'
import { reportError } from './error-bus.ts'

export interface UseEditableFieldOptions<T> extends Omit<EditableFieldHooks<T>, 'onLocalChange' | 'onStatusChange' | 'onError'> {
  /** 覆盖写库失败时的正文（默认按 docs/11 §4.9 要求说明「修改仍在内存中」） */
  failureDetail?: string
  /** 是否把失败再次上抛（默认 false：已由 error-bus 兑现，避免 unhandledrejection 重复提示） */
  rethrowOnError?: boolean
}

export interface UseEditableField<T> {
  /** 内存中的当前值（乐观 UI） */
  value: Ref<T>
  status: Ref<SaveStatus>
  savedAt: Ref<number | null>
  lastError: ShallowRef<unknown>
  /** 是否有未落库改动 */
  dirty: Readonly<Ref<boolean>>
  /** 立即落库（Ctrl+S、切换章节、提交前调用） */
  flush: () => Promise<void>
  /** 乐观更新 */
  set: (value: T) => void
  update: (updater: (prev: T) => T) => void
  /** 回滚到已落库的值 */
  revert: () => void
  /** 外部数据替换（切章节/重新加载），不留脏标记 */
  reset: (value: T) => void
  /** 重试（失败提示上的按钮接这里） */
  retry: () => Promise<void>
  /** 底层控制器（需要接入撤销栈时用） */
  controller: EditableField<T>
}

/**
 * @param initial 初始值（或取值函数，便于在 store 里延迟读取）
 * @param hooks   写入器与回调；`write` 必须走 shared/lib/ipc.ts 的 call()
 */
export function useEditableField<T>(
  initial: T | (() => T),
  hooks: EditableFieldHooks<T> & UseEditableFieldOptions<T>,
): UseEditableField<T> {
  const initialValue = typeof initial === 'function' ? (initial as () => T)() : initial

  const value = ref(initialValue) as Ref<T>
  const status = ref<SaveStatus>('idle')
  const savedAt = ref<number | null>(null)
  const lastError = shallowRef<unknown>(null)
  /** 是否有未落库改动：由回调同步刷新（computed 无法追踪类的私有字段） */
  const dirty = ref(false)

  const controller = new EditableField<T>(initialValue, {
    ...hooks,
    onLocalChange: (next) => {
      value.value = next
      dirty.value = controller.state.dirty
    },
    onStatusChange: (next) => {
      status.value = next
    },
    onError: (error, pendingValue) => {
      lastError.value = error
      dirty.value = controller.state.dirty
      // 唯一出提示的口子（docs/22 §6.2）。
      // 用 detailOverride 说明「改动仍在内存中」，标题/编号/动作仍来自消息表。
      reportError(error, {
        event: hooks.write.name ? `editor.autosave.${hooks.write.name}` : 'editor.autosaveFailed',
        detailOverride: hooks.failureDetail
          ?? '保存失败，你的修改仍在内存中（尚未写入数据库）。可点「重试」重新保存。',
        retryFn: () => controller.flush(),
        action: 'retry',
      })
      void pendingValue
      if (hooks.rethrowOnError) throw error
    },
    onSaved: (saved) => {
      savedAt.value = Date.now()
      dirty.value = controller.state.dirty
      hooks.onSaved?.(saved)
    },
  })

  // 组件卸载：尽力冲刷未落库的改动（避免切页丢编辑）
  onScopeDispose(() => controller.dispose())

  return {
    value,
    status,
    savedAt,
    lastError,
    /** 有未落库改动（AutoSaveIndicator / 离开拦截用它） */
    dirty,
    flush: () => controller.flush(),
    set: (next: T) => controller.set(next),
    update: (updater: (prev: T) => T) => controller.update(updater),
    revert: () => controller.revert(),
    reset: (next: T) => {
      value.value = next
      controller.reset(next)
    },
    retry: () => controller.retry(),
    controller,
  }
}

/**
 * 「标记类」编辑（下拉/开关/按钮）专用的薄封装（docs/11 §4.9：标记编辑立即写库）。
 * 语义差异只在 delayMs = 0，不需要单独实现。
 */
export function useImmediateField<T>(
  initial: T | (() => T),
  write: WriteFn<T>,
  options: Omit<UseEditableFieldOptions<T>, 'write' | 'delayMs'> = {},
): UseEditableField<T> {
  return useEditableField<T>(initial, { ...options, write, delayMs: 0 })
}
