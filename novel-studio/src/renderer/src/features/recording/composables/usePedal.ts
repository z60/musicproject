/**
 * 录音域 · 脚踏板与外部控制（FR-3.12 / docs/12 §9.2）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §9.2 —— 通过 `navigator.getGamepads()` 或键盘映射（多数踏板模拟键盘
 *                     `F13`/`Ctrl` 等）；映射表可配置；**「踏板 = 停止并下一行」是最重要的用法**；
 *                     必须提供「踏板测试」界面（按下 → 显示检测到的键/按钮），
 *                     否则用户配不上会以为软件坏了
 *   · docs/04 §8.2 —— 映射存 `settings.recording.footPedalMapping`（Record<string,string>）
 *   · 种子数据（src/main/infra/db/migrations/002_seed.sql）：
 *                     `{"F13":"stop_and_next","F14":"redo"}` —— 值用的是**动作语义名**，
 *                     不是快捷键绑定 id（两者都是字符串，别混用）
 *   · docs/12 §9.3 —— 踏板触发的动作要和快捷键一样走「页面接管」的路径
 *
 * 为什么踏板映射与快捷键表分开：
 *   快捷键 id（`record.toggle`…）来自 `shared/lib/shortcuts.ts`，语义是「按哪个键做什么」；
 *   踏板动作（`stop_and_next`…）描述的是**外部控制器的一次踩下**，多数踏板只发一个键码，
 *   用户想要的却是「停止并跳到下一行」这种复合语义。所以本文件用自己那套动作名，
 *   由录音页把它翻译成实际调用。
 */

import { computed, onScopeDispose, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { eventToShortcutString, formatShortcut, isEditableTarget, parseShortcut } from '@/shared/lib/shortcuts.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'

/** 踏板可映射的动作（docs/12 §9.2；值是设置里存的字符串） */
export interface PedalActionDef {
  id: string
  label: string
  hint: string
}

export const PEDAL_ACTIONS: PedalActionDef[] = [
  { id: 'stop_and_next', label: '停止并下一行', hint: '边录边推进，配音员最常用的一脚' },
  { id: 'toggle', label: '开始 / 停止录音', hint: '只用踏板完成一次录制' },
  { id: 'redo', label: '丢弃并重录', hint: '表演不满意时立刻重来' },
  { id: 'retake_mark', label: '标记「这段重来」', hint: '连续录制中标记要重录的位置' },
  { id: 'mark', label: '打切点标记', hint: '连续录制中人工切点' },
  { id: 'next_line', label: '下一行（不录音）', hint: '只翻行' },
  { id: 'prev_line', label: '上一行（不录音）', hint: '回到上一行补录' },
  { id: 'skip', label: '跳过（本轮）', hint: '标记待录并前进' },
  { id: 'none', label: '（不使用）', hint: '该键位不触发任何动作' },
]

export interface PedalHit {
  source: 'keyboard' | 'gamepad'
  /** 规范化键位（键盘为 `f13`/`ctrl+shift+p`，手柄为 `gamepad0.b1`） */
  id: string
  /** 展示串（`F13`、`Gamepad0 · 按钮 1`） */
  label: string
  at: number
}

export interface UsePedalOptions {
  /** 命中映射后回调（值是设置里的动作名，见 PEDAL_ACTIONS） */
  onAction: (actionId: string) => void
  /** 是否允许触发（例如录音页不在前台时关掉） */
  enabled?: () => boolean
}

export interface UsePedalReturn {
  /** 踏板测试模式：按下只记录、不触发动作 */
  testing: Ref<boolean>
  /** 测试模式下检测到的按键/按钮（最新的在前） */
  detected: Ref<PedalHit[]>
  lastHit: Ref<PedalHit | null>
  /** 键盘映射（键位 → 动作名） */
  mapping: Ref<Record<string, string>>
  /** 当前已连接的手柄名（没有手柄时给 UI 明确说明） */
  gamepads: Ref<string[]>
  /** 是否有可用的外部控制通道（有手柄，或映射表非空） */
  available: ComputedRef<boolean>
  /** 当前按下的键位/按钮（实时反馈，测试界面用） */
  pressed: Ref<string[]>
  /** 开始监听（录音页 onMounted 调） */
  start: () => void
  dispose: () => void
  startTest: () => void
  stopTest: () => void
  clearDetected: () => void
  setMapping: (canonicalKey: string, actionId: string) => void
  removeMapping: (canonicalKey: string) => void
  resetMapping: () => void
  /** 手动补一条映射（用户按不上踏板时可以直接输入键位） */
  describeKey: (key: string) => string
}

/** 手柄轮询间隔：踏板按下的实时性要求不高，30 ms 足够且几乎不占 CPU */
const GAMEPAD_POLL_MS = 30

export function usePedal(options: UsePedalOptions): UsePedalReturn {
  const settingsStore = useSettingsStore()

  const testing = ref(false)
  const detected = ref<PedalHit[]>([])
  const lastHit = ref<PedalHit | null>(null)
  const gamepads = ref<string[]>([])
  const pressed = ref<string[]>([])
  const mapping = ref<Record<string, string>>({ ...(settingsStore.recording?.footPedalMapping ?? {}) })

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let started = false
  /** 上一帧的手柄按钮状态（用于边沿检测：只在「刚按下」时触发一次） */
  let previousButtons: boolean[][] = []
  let previousAxes: number[][] = []

  const available = computed(() => gamepads.value.length > 0 || Object.keys(mapping.value).length > 0)

  /** 映射表的键统一规范化（种子数据里是 `F13`，事件回写是 `f13`，必须能对上） */
  function normalizeKey(key: string): string {
    const parsed = parseShortcut(key)
    return parsed.valid ? parsed.canonical : key.trim().toLowerCase()
  }

  function lookup(actionKey: string): string | null {
    const normalized = normalizeKey(actionKey)
    for (const [key, action] of Object.entries(mapping.value)) {
      if (normalizeKey(key) === normalized) return action
    }
    return null
  }

  function record(hit: PedalHit): void {
    lastHit.value = hit
    if (testing.value) {
      detected.value = [hit, ...detected.value].slice(0, 30)
      return
    }
    if (options.enabled && !options.enabled()) return
    const action = lookup(hit.id)
    if (!action || action === 'none') return
    options.onAction(action)
  }

  // ── 键盘映射 ──────────────────────────────────────────────────────────────
  function onKeydown(event: KeyboardEvent): void {
    // 输入框里打字不能被踏板逻辑抢走（docs/12 §9.1 的通用纪律）
    if (isEditableTarget(event.target)) return
    const id = eventToShortcutString({ key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey })
    if (!id) return
    if (!pressed.value.includes(id)) pressed.value = [...pressed.value, id]
    // 只处理「已映射的键」或测试模式，避免把普通打字也当成踏板
    if (!testing.value && lookup(id) === null) return
    event.preventDefault()
    record({ source: 'keyboard', id, label: formatShortcut(id), at: Date.now() })
  }

  function onKeyup(event: KeyboardEvent): void {
    const id = eventToShortcutString({ key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey })
    if (!id) return
    pressed.value = pressed.value.filter(k => k !== id)
  }

  // ── 手柄（多数 USB 踏板在手柄模式下就是一个按钮）──────────────────────────
  function pollGamepads(): void {
    const pads = globalThis.navigator?.getGamepads?.() ?? []
    const names: string[] = []
    const stillPressed: string[] = []

    pads.forEach((pad, index) => {
      if (!pad) return
      names.push(pad.id || `手柄 ${index}`)
      const prevButtons = previousButtons[index] ?? []
      const nextButtons: boolean[] = []
      pad.buttons.forEach((button, buttonIndex) => {
        const isPressed = button.pressed || button.value > 0.5
        nextButtons.push(isPressed)
        const id = `gamepad${index}.b${buttonIndex}`
        if (isPressed) stillPressed.push(id)
        if (isPressed && !prevButtons[buttonIndex]) {
          if (testing.value || lookup(id) !== null) {
            record({ source: 'gamepad', id, label: `手柄 ${index} · 按钮 ${buttonIndex}`, at: Date.now() })
          }
        }
      })
      previousButtons[index] = nextButtons

      const prevAxes = previousAxes[index] ?? []
      const nextAxes: number[] = []
      pad.axes.forEach((value, axisIndex) => {
        // 摇杆/部分踏板是轴：只在越过阈值时算一次按下（正负方向各算一个键位）
        const positive = value > 0.5
        const negative = value < -0.5
        nextAxes.push(value)
        const idPositive = `gamepad${index}.axis${axisIndex}+`
        const idNegative = `gamepad${index}.axis${axisIndex}-`
        if (positive) stillPressed.push(idPositive)
        if (negative) stillPressed.push(idNegative)
        const wasPositive = (prevAxes[axisIndex] ?? 0) > 0.5
        const wasNegative = (prevAxes[axisIndex] ?? 0) < -0.5
        if (positive && !wasPositive && (testing.value || lookup(idPositive) !== null)) {
          record({ source: 'gamepad', id: idPositive, label: `手柄 ${index} · 轴 ${axisIndex} 正`, at: Date.now() })
        }
        if (negative && !wasNegative && (testing.value || lookup(idNegative) !== null)) {
          record({ source: 'gamepad', id: idNegative, label: `手柄 ${index} · 轴 ${axisIndex} 负`, at: Date.now() })
        }
      })
      previousAxes[index] = nextAxes
    })

    gamepads.value = names
    pressed.value = [...new Set([...pressed.value.filter(k => !k.startsWith('gamepad')), ...stillPressed])]
    previousButtons = previousButtons.slice(0, pads.length)
    previousAxes = previousAxes.slice(0, pads.length)
  }

  function start(): void {
    if (started) return
    started = true
    globalThis.addEventListener?.('keydown', onKeydown, true)
    globalThis.addEventListener?.('keyup', onKeyup, true)
    // 手柄必须轮询：gamepadconnected 事件在部分踏板/驱动下不可靠
    pollTimer = setInterval(pollGamepads, GAMEPAD_POLL_MS)
    pollGamepads()
  }

  function dispose(): void {
    if (!started) return
    started = false
    globalThis.removeEventListener?.('keydown', onKeydown, true)
    globalThis.removeEventListener?.('keyup', onKeyup, true)
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    pressed.value = []
  }

  function startTest(): void {
    testing.value = true
    detected.value = []
    start()
  }

  function stopTest(): void {
    testing.value = false
  }

  function clearDetected(): void {
    detected.value = []
  }

  async function persist(next: Record<string, string>): Promise<void> {
    mapping.value = next
    await settingsStore.patch({ recording: { footPedalMapping: next } }).catch(() => undefined)
  }

  function setMapping(canonicalKey: string, actionId: string): void {
    void persist({ ...mapping.value, [canonicalKey]: actionId })
  }

  function removeMapping(canonicalKey: string): void {
    const next = { ...mapping.value }
    delete next[canonicalKey]
    void persist(next)
  }

  /** 恢复出厂映射（与种子数据一致：F13 = 停止并下一行） */
  function resetMapping(): void {
    void persist({ F13: 'stop_and_next', F14: 'redo' })
  }

  /** 键位展示（测试界面与映射列表共用） */
  function describeKey(key: string): string {
    if (key.startsWith('gamepad')) {
      const match = /^gamepad(\d+)\.(b|axis)(\d+)([+-])?$/.exec(key)
      if (match) {
        const [, pad, kind, index, sign] = match
        return kind === 'b' ? `手柄 ${pad} · 按钮 ${index}` : `手柄 ${pad} · 轴 ${index} ${sign === '-' ? '负' : '正'}`
      }
      return key
    }
    return formatShortcut(key)
  }

  onScopeDispose(dispose)

  return {
    testing, detected, lastHit, mapping, gamepads, available, pressed,
    start, dispose, startTest, stopTest, clearDetected,
    setMapping, removeMapping, resetMapping, describeKey,
  }
}
