/**
 * 应用级状态 · 界面壳（跨功能域共享）
 * ============================================================================
 * 设计依据：
 *   · docs/22 §7 —— fatal 级错误必须**阻断**：Modal 不可自动关闭，
 *     且「禁止继续操作」；因此需要一个全局的阻断态供 AppShell 渲染
 *   · docs/04 §2.4 —— 任务进度坞的折叠状态也是壳的状态
 *
 * 这里只放「壳」自己的状态；业务状态一律留在各自功能域的 store。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { DisplayableError } from '@shared/errors.ts'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'ns.ui.v1'

interface PersistedUi {
  sidebarCollapsed: boolean
  dockCollapsed: boolean
  theme: ThemeMode
}

function readPersisted(): PersistedUi {
  const fallback: PersistedUi = { sidebarCollapsed: false, dockCollapsed: false, theme: 'system' }
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as Partial<PersistedUi>) }
  } catch {
    return fallback
  }
}

export const useUiStore = defineStore('app/ui', () => {
  const persisted = readPersisted()

  const sidebarCollapsed = ref(persisted.sidebarCollapsed)
  const dockCollapsed = ref(persisted.dockCollapsed)
  const theme = ref<ThemeMode>(persisted.theme)

  /** 阻断态：fatal 错误后由 app/main.ts 的 onFatal 写入（docs/22 §7） */
  const fatal = ref<DisplayableError | null>(null)
  /** 当前页面是否处于「录音中」——录音页用它接管全局快捷键并拦截关闭窗口（docs/12 §9.3） */
  const capturingShortcuts = ref(false)

  const isBlocked = computed(() => fatal.value !== null)

  function persist(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
        sidebarCollapsed: sidebarCollapsed.value,
        dockCollapsed: dockCollapsed.value,
        theme: theme.value,
      } satisfies PersistedUi))
    } catch {
      /* 忽略 */
    }
  }

  watch([sidebarCollapsed, dockCollapsed, theme], persist, { deep: false })

  function toggleSidebar(force?: boolean): void {
    sidebarCollapsed.value = force ?? !sidebarCollapsed.value
  }

  function toggleDock(force?: boolean): void {
    dockCollapsed.value = force ?? !dockCollapsed.value
  }

  function setTheme(next: ThemeMode): void {
    theme.value = next
    applyTheme(next)
  }

  /** 把主题写到 <html data-theme>，样式层只认这个属性（浅色/深色变量在 assets/theme.css） */
  function applyTheme(mode: ThemeMode = theme.value): void {
    const root = globalThis.document?.documentElement
    if (!root) return
    const resolved = mode === 'system'
      ? (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode
    root.dataset.theme = resolved
    root.classList.toggle('dark', resolved === 'dark') // Element Plus 深色模式类名
  }

  /** fatal 错误：阻断界面（docs/22 §7 要求「禁止继续操作」） */
  function setFatal(error: DisplayableError | null): void {
    fatal.value = error
  }

  function clearFatal(): void {
    fatal.value = null
  }

  function setCapturingShortcuts(active: boolean): void {
    capturingShortcuts.value = active
  }

  return {
    sidebarCollapsed, dockCollapsed, theme,
    fatal, capturingShortcuts, isBlocked,
    toggleSidebar, toggleDock, setTheme, applyTheme,
    setFatal, clearFatal, setCapturingShortcuts,
  }
})
