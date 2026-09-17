/**
 * 录音域 · 快捷键绑定与冲突处理（FR-3.12 / docs/12 §9）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §9.1 —— 默认快捷键表（Space/Enter、Ctrl+R、↓/↑、→、P、Shift+P、M、
 *                     N、Ctrl+Z、Ctrl+M、Ctrl+↓）—— 唯一来源是
 *                     `shared/lib/shortcuts.ts` 的 DEFAULT_RECORDING_SHORTCUTS
 *   · docs/12 §9.3 —— 录音页激活时**接管**全局快捷键，并拦截可能误触的系统级快捷键
 *                     （如 `Ctrl+W` 关闭窗口）：防止误关导致录音中断
 *   · docs/04 §8.2 —— 用户覆盖项存 `settings.recording.stopKey / nextLineKey /
 *                     redoKey / playKey`
 *   · docs/12 §10  —— ShortcutHelper（快捷键速查，可呼出）；冲突用 `findConflicts` 标红
 *
 * 关于 `Ctrl+R` 的取舍（两份文档在这里打架，这里给出明确口径）：
 *   docs/12 §9.1 把 `Ctrl+R` 定义为「丢弃并重录」，而 Chromium 用 `Ctrl+R` 刷新页面。
 *   口径：**空闲时按文档执行「丢弃并重录」；录音中（recording/paused/finalizing）
 *   连同 `F5`/`Ctrl+Shift+R` 一起拦截**（刷新会丢掉正在录的会话，代价远大于少一个快捷键）。
 *   真正的窗口关闭拦截应在主进程做（`app:beforeQuit` 事件已存在，docs/20 §4.11），
 *   渲染侧的 preventDefault 只能尽力而为 —— 见汇报里的说明。
 */

import { computed, onScopeDispose, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import {
  DEFAULT_RECORDING_SHORTCUTS,
  eventToShortcutString,
  findConflicts,
  formatShortcut,
  isEditableTarget,
  matchAny,
  parseShortcut,
} from '@/shared/lib/shortcuts.ts'
import type { ShortcutBinding, ShortcutConflict } from '@/shared/lib/shortcuts.ts'
import { useUiStore } from '@/app/store/ui.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'

/** 速查面板里一行的展示模型（含冲突标记与「已被用户改动」标记） */
export interface ShortcutRow {
  id: string
  label: string
  /** 实际生效的键位串 */
  shortcut: string
  /** 展示串（`Ctrl+Shift+P`） */
  display: string
  /** 是否命中冲突（同一键位绑了多个功能） */
  conflict: boolean
  /** 是否被用户设置覆盖 */
  overridden: boolean
}

/** 永远拦截的「关窗」类快捷键（录音页接管期间） */
const ALWAYS_BLOCKED = ['ctrl+w', 'meta+w', 'ctrl+shift+w', 'ctrl+f4', 'alt+f4']
/** 录音中额外拦截的「刷新/重载」类快捷键（会丢掉正在录的会话） */
const RELOAD_BLOCKED = ['ctrl+r', 'meta+r', 'f5', 'ctrl+shift+r', 'meta+shift+r']

/** 用户设置项 → 快捷键绑定 id（docs/04 §8.2 的四个可配键） */
const SETTING_OVERRIDES: Array<{ settingKey: 'stopKey' | 'nextLineKey' | 'redoKey' | 'playKey'; bindingId: string }> = [
  { settingKey: 'stopKey', bindingId: 'record.toggle' },
  { settingKey: 'nextLineKey', bindingId: 'line.next' },
  { settingKey: 'redoKey', bindingId: 'record.redo' },
  { settingKey: 'playKey', bindingId: 'take.play' },
]

export interface UseShortcutsOptions {
  /** 命中绑定后回调（id 见 DEFAULT_RECORDING_SHORTCUTS） */
  onAction: (actionId: string) => void
  /** 是否处于「整段忙碌」状态（录音中/暂停/定稿）—— 决定是否拦截刷新类快捷键 */
  isBusy?: () => boolean
  /** 是否允许触发（默认始终允许） */
  enabled?: () => boolean
}

export interface UseShortcutsReturn {
  /** 生效的绑定（默认值 + 用户覆盖） */
  bindings: ComputedRef<ShortcutBinding[]>
  conflicts: ComputedRef<ShortcutConflict[]>
  /** 速查面板的行（含展示串与冲突标记） */
  rows: ComputedRef<ShortcutRow[]>
  /** 被拦截的快捷键提示（docs/12 §9.3：「录音中已拦截关闭」） */
  blockedNotice: Ref<string>
  /** 记录被覆盖过的绑定 id（速查面板上标「已自定义」） */
  overriddenIds: ComputedRef<string[]>
  enable: () => void
  disable: () => void
  /** 某个动作的展示串（按钮上显示快捷键提示用） */
  displayOf: (actionId: string) => string
  /** 把键盘事件回写成键位串（踏板测试/自定义快捷键界面用） */
  captureShortcut: (event: { key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }) => string
  /** 修改某个绑定（写设置；只支持四个可配键） */
  setOverride: (actionId: string, shortcut: string) => Promise<boolean>
  /** 恢复默认 */
  clearOverride: (actionId: string) => Promise<boolean>
  clearBlockedNotice: () => void
}

export function useShortcuts(options: UseShortcutsOptions): UseShortcutsReturn {
  const uiStore = useUiStore()
  const settingsStore = useSettingsStore()

  const blockedNotice = ref('')
  let enabled = false

  /** 用户覆盖表：binding id → 键位串 */
  const overrideMap = computed<Record<string, string>>(() => {
    const recording = settingsStore.recording
    const result: Record<string, string> = {}
    if (!recording) return result
    for (const item of SETTING_OVERRIDES) {
      const value = recording[item.settingKey]
      if (typeof value === 'string' && value.trim()) result[item.bindingId] = value
    }
    return result
  })

  const bindings = computed<ShortcutBinding[]>(() =>
    DEFAULT_RECORDING_SHORTCUTS.map(binding => {
      const override = overrideMap.value[binding.id]
      return override ? { ...binding, shortcut: override } : binding
    }),
  )

  const overriddenIds = computed(() => Object.keys(overrideMap.value))

  const conflicts = computed(() => findConflicts(bindings.value))
  const conflictIds = computed(() => {
    const ids = new Set<string>()
    for (const conflict of conflicts.value) {
      for (const item of conflict.items) ids.add(item.id)
    }
    return ids
  })

  const rows = computed<ShortcutRow[]>(() =>
    bindings.value.map(binding => ({
      id: binding.id,
      label: binding.label ?? binding.id,
      shortcut: binding.shortcut,
      display: formatShortcut(binding.shortcut),
      conflict: conflictIds.value.has(binding.id),
      overridden: overriddenIds.value.includes(binding.id),
    })),
  )

  function displayOf(actionId: string): string {
    const binding = bindings.value.find(b => b.id === actionId)
    return binding ? formatShortcut(binding.shortcut) : ''
  }

  function isBlocked(canonical: string): 'close' | 'reload' | null {
    if (ALWAYS_BLOCKED.includes(canonical)) return 'close'
    if (options.isBusy?.() && RELOAD_BLOCKED.includes(canonical)) return 'reload'
    return null
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!enabled) return
    if (options.enabled && !options.enabled()) return

    const canonical = eventToShortcutString({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    })

    // 1) 关窗/刷新类：先于「输入框保护」判定 —— 焦点在输入框里也不能让窗口被误关
    const blocked = canonical ? isBlocked(canonical) : null
    if (blocked) {
      event.preventDefault()
      event.stopPropagation()
      blockedNotice.value = blocked === 'close'
        ? `已拦截 ${formatShortcut(canonical)}：录音页接管快捷键期间不会关闭窗口（docs/12 §9.3）`
        : `录音中已拦截 ${formatShortcut(canonical)}：刷新会中断本次录音，请先停止`
      return
    }

    // 2) 输入框里打字不抢键（docs/12 §9.1 的通用纪律）
    if (isEditableTarget(event.target)) return

    // 3) 命中绑定 → 交给页面处理
    const binding = matchAny(event, bindings.value)
    if (!binding) return
    event.preventDefault()
    event.stopPropagation()
    options.onAction(binding.id)
  }

  function enable(): void {
    if (enabled) return
    enabled = true
    // capture 阶段注册：抢在内层组件（例如 <audio> 的默认空格行为）之前
    globalThis.addEventListener?.('keydown', onKeydown, true)
    // 录音页激活 → 接管全局快捷键（AppShell / 其他页据此让路）
    uiStore.setCapturingShortcuts(true)
  }

  function disable(): void {
    if (!enabled) return
    enabled = false
    globalThis.removeEventListener?.('keydown', onKeydown, true)
    uiStore.setCapturingShortcuts(false)
  }

  function captureShortcut(event: { key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): string {
    return eventToShortcutString(event)
  }

  async function setOverride(actionId: string, shortcut: string): Promise<boolean> {
    const item = SETTING_OVERRIDES.find(o => o.bindingId === actionId)
    if (!item) return false
    const parsed = parseShortcut(shortcut)
    if (!parsed.valid) return false
    await settingsStore.patch({ recording: { [item.settingKey]: shortcut } }).catch(() => undefined)
    return true
  }

  async function clearOverride(actionId: string): Promise<boolean> {
    const item = SETTING_OVERRIDES.find(o => o.bindingId === actionId)
    if (!item) return false
    const fallback = DEFAULT_RECORDING_SHORTCUTS.find(b => b.id === actionId)?.shortcut
    if (!fallback) return false
    await settingsStore.patch({ recording: { [item.settingKey]: fallback } }).catch(() => undefined)
    return true
  }

  function clearBlockedNotice(): void {
    blockedNotice.value = ''
  }

  onScopeDispose(disable)

  return {
    bindings, conflicts, rows, blockedNotice, overriddenIds,
    enable, disable, displayOf, captureShortcut, setOverride, clearOverride, clearBlockedNotice,
  }
}
