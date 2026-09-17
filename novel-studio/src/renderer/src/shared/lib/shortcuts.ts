/**
 * Novel Studio · 快捷键解析与匹配引擎（纯逻辑，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §9.1 —— 默认快捷键表（Space/Enter、Ctrl+R、P、Shift+P、Ctrl+M …）
 *   · docs/12 §9.3 —— 录音页激活时接管全局快捷键（需要「谁优先」的判断）
 *   · docs/11 §4.5 —— 待确认队列全键盘操作（数字键 / Enter / S / P / Z / Ctrl+Enter）
 *   · docs/11 §4.8 —— Ctrl+Z / Ctrl+Shift+Z
 *
 * 为什么自己写而不是用现成库：
 *   · 需求里的键位含 `Shift+P`、`Ctrl+→`、`↓`、`Ctrl+Enter` 这类组合，
 *     且**修饰键顺序必须无关**（用户配置里写成 `Shift+Ctrl+P` 也要能匹配）；
 *   · 录音场景要求「录音中拦截 Ctrl+W」这类必须能静态分析的冲突检测；
 *   · 纯函数才好写单测（见 tests/renderer/shortcuts.test.ts）。
 *
 * 键位规范化口径：
 *   · 主键统一小写：`P` → `p`；单字符直接小写；方向键统一为 `left/right/up/down`。
 *   · 修饰键四种：ctrl / shift / alt / meta；`Cmd`/`Command`/`⌘`/`Win` 全部归到 meta。
 *   · `canonical` 固定顺序 ctrl → shift → alt → meta（顺序无关的等价键会得到同一串）。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ParsedShortcut {
  /** 是否解析成功（不合法时所有匹配都返回 false，绝不抛错） */
  readonly valid: boolean
  /** 原始输入 */
  readonly raw: string
  /** 规范化主键，如 `p`、`space`、`arrowleft`→`left`、`+` */
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly meta: boolean
  /** 失败原因（valid=false 时非空） */
  readonly error: string | null
  /** 规范化串：`ctrl+shift+p`（用于冲突检测与持久化） */
  readonly canonical: string
  /** 展示串：`Ctrl+Shift+P`（用于快捷键速查面板） */
  readonly display: string
}

/** 与 KeyboardEvent 结构兼容的最小子集（便于单测构造假事件） */
export interface KeyEventLike {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

export interface ShortcutBinding {
  /** 绑定标识，如 `record.stop` */
  id: string
  /** 快捷键字符串，如 `Ctrl+R` */
  shortcut: string
  /** 展示名，如「丢弃并重录」 */
  label?: string
  /** 作用域：录音页接管的全局键用 'recording'；'global' 表示任何页面都生效 */
  scope?: string
}

export interface ShortcutConflict {
  canonical: string
  display: string
  items: ShortcutBinding[]
}

// ---------------------------------------------------------------------------
// 名称表
// ---------------------------------------------------------------------------

type ModifierName = 'ctrl' | 'shift' | 'alt' | 'meta'

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', '⌃': 'ctrl',
  shift: 'shift', '⇧': 'shift',
  alt: 'alt', option: 'alt', opt: 'alt', '⌥': 'alt',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', windows: 'meta', '⌘': 'meta',
}

/** 命名键别名 → 规范名（KeyboardEvent.key 的常见写法都在里面） */
const KEY_ALIASES: Record<string, string> = {
  ' ': 'space', space: 'space', spacebar: 'space', 空格: 'space',
  esc: 'escape', escape: 'escape',
  enter: 'enter', return: 'enter',
  tab: 'tab',
  backspace: 'backspace', bs: 'backspace',
  del: 'delete', delete: 'delete',
  ins: 'insert', insert: 'insert',
  up: 'up', down: 'down', left: 'left', right: 'right',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  '↑': 'up', '↓': 'down', '←': 'left', '→': 'right',
  home: 'home', end: 'end',
  pageup: 'pageup', pagedown: 'pagedown', pgup: 'pageup', pgdn: 'pagedown',
  caps: 'capslock', capslock: 'capslock',
  plus: '+', add: '+', 加号: '+',
  minus: '-', subtract: '-', 减号: '-',
  equal: '=', equals: '=',
  comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\',
  semicolon: ';', quote: "'", backquote: '`',
  '[': 'bracketleft', ']': 'bracketright', bracketleft: 'bracketleft', bracketright: 'bracketright',
}

const F_KEY = /^f([1-9]|1[0-9]|2[0-4])$/
const NUMPAD_KEY = /^numpad[0-9]$/

const MODIFIER_ORDER: ModifierName[] = ['ctrl', 'shift', 'alt', 'meta']
const MODIFIER_DISPLAY: Record<ModifierName, string> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 快捷键缺失时展示的占位（与 format.UNKNOWN 的 `—` 有意区分：这里是「没配」而不是「没值」） */
const UNKNOWN_SHORTCUT = '（未设置）'

function invalid(raw: string, error: string): ParsedShortcut {
  return {
    valid: false,
    raw,
    key: '',
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    error,
    canonical: '',
    display: raw || UNKNOWN_SHORTCUT,
  }
}

/**
 * 规范化单个按键名。
 * 返回 null 表示「认不出来」——调用方据此判定非法输入（而不是当成合法键）。
 */
export function normalizeKeyName(name: string): string | null {
  if (typeof name !== 'string') return null
  const raw = name.trim()
  if (!raw) return null

  const lower = raw.toLowerCase()
  const aliased = KEY_ALIASES[lower]
  if (aliased) return aliased
  if (F_KEY.test(lower)) return lower
  if (NUMPAD_KEY.test(lower)) return lower

  // 单字符（字母/数字/符号）一律小写
  if ([...raw].length === 1) return lower

  return null
}

/**
 * 解析快捷键字符串。
 * 支持：`Ctrl+Shift+P`、`cmd+p`（mac 别名）、`Shift+Ctrl+P`（顺序无关）、
 *       `Ctrl++`（主键是加号）、`Ctrl+→`、`Space`、`F13`（脚踏板常用）。
 * 任何非法输入都返回 valid:false，**不抛异常**。
 */
export function parseShortcut(input: string | null | undefined): ParsedShortcut {
  // 单个空格不是「空输入」：KeyboardEvent.key 里空格就是 ' '，用户从事件捕获时存下的就是它
  const raw = typeof input === 'string' ? (input === ' ' ? 'space' : input.trim()) : ''
  if (!raw) return invalid(raw, '快捷键为空')

  const mods: Record<ModifierName, boolean> = { ctrl: false, shift: false, alt: false, meta: false }

  // 主键是「+」时写法是 `Ctrl++`：先摘掉结尾的 `++`
  let body = raw
  let plusKey = false
  if (raw.endsWith('++')) {
    plusKey = true
    body = raw.slice(0, -2)
  } else if (raw === '+') {
    plusKey = true
    body = ''
  }

  let key: string | null = plusKey ? '+' : null

  // 注意：''.split('+') 会得到 ['']，因此必须显式跳过空 body（纯 '+' 的写法）
  const tokens = body ? body.split('+') : []
  for (const tokenRaw of tokens) {
    const token = tokenRaw.trim()
    if (!token) return invalid(raw, `快捷键中存在空的按键片段：${raw}`)

    const mod = MODIFIER_ALIASES[token.toLowerCase()]
    if (mod) {
      mods[mod] = true
      continue
    }

    const normalized = normalizeKeyName(token)
    if (!normalized) return invalid(raw, `无法识别的按键名：${token}`)
    if (key !== null) return invalid(raw, `一个快捷键只能有一个主键：${raw}`)
    key = normalized
  }

  if (key === null) return invalid(raw, `缺少主键：${raw}`)

  const canonical = canonicalize(key, mods)
  return {
    valid: true,
    raw,
    key,
    ctrl: mods.ctrl,
    shift: mods.shift,
    alt: mods.alt,
    meta: mods.meta,
    error: null,
    canonical,
    display: displayOf(key, mods),
  }
}

function canonicalize(key: string, mods: Record<ModifierName, boolean>): string {
  const parts = MODIFIER_ORDER.filter(m => mods[m])
  return [...parts, key].join('+')
}

const KEY_DISPLAY: Record<string, string> = {
  space: 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Del',
  insert: 'Ins',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  capslock: 'CapsLock',
  '+': '+',
  '-': '-',
}

function displayOf(key: string, mods: Record<ModifierName, boolean>): string {
  const parts = MODIFIER_ORDER.filter(m => mods[m]).map(m => MODIFIER_DISPLAY[m])
  const keyText = KEY_DISPLAY[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1))
  return [...parts, keyText].join('+')
}

/** 展示串（用户配置界面、快捷键速查面板唯一入口） */
export function formatShortcut(shortcut: ParsedShortcut | string): string {
  const parsed = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut
  return parsed.valid ? parsed.display : UNKNOWN_SHORTCUT
}

/** 两个快捷键是否等价（修饰键顺序无关） */
export function shortcutEquals(a: ParsedShortcut | string, b: ParsedShortcut | string): boolean {
  const pa = typeof a === 'string' ? parseShortcut(a) : a
  const pb = typeof b === 'string' ? parseShortcut(b) : b
  if (!pa.valid || !pb.valid) return false
  return pa.canonical === pb.canonical
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

/**
 * 事件是否命中快捷键。
 * 规则：
 *   · 大小写不敏感（`P` 与 `p` 等价）；
 *   · 修饰键必须完全一致（`P` 不匹配 `Shift+P`，反之亦然——否则录音页会互相抢键）；
 *   · 事件里认不出的键名（如 `AudioVolumeUp`）不会误命中。
 */
export function matchEvent(event: KeyEventLike | null | undefined, shortcut: ParsedShortcut | string): boolean {
  if (!event || typeof event.key !== 'string') return false
  const parsed = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut
  if (!parsed.valid) return false

  const eventKey = normalizeKeyName(event.key)
  if (!eventKey || eventKey !== parsed.key) return false

  return Boolean(event.ctrlKey) === parsed.ctrl
    && Boolean(event.shiftKey) === parsed.shift
    && Boolean(event.altKey) === parsed.alt
    && Boolean(event.metaKey) === parsed.meta
}

/** 在一组绑定里找命中的第一个（顺序即优先级，先注册的优先） */
export function matchAny(
  event: KeyEventLike | null | undefined,
  bindings: ShortcutBinding[],
): ShortcutBinding | null {
  for (const binding of bindings) {
    if (matchEvent(event, binding.shortcut)) return binding
  }
  return null
}

/** 把事件回写成快捷键串（「踏板测试」「快捷键自定义」界面用） */
export function eventToShortcutString(event: KeyEventLike): string {
  const key = normalizeKeyName(event.key)
  if (!key) return ''
  return canonicalize(key, {
    ctrl: Boolean(event.ctrlKey),
    shift: Boolean(event.shiftKey),
    alt: Boolean(event.altKey),
    meta: Boolean(event.metaKey),
  })
}

// ---------------------------------------------------------------------------
// 冲突检测
// ---------------------------------------------------------------------------

/**
 * 冲突检测（docs/12 §9.3）：
 * 同一作用域内 `canonical` 相同的绑定即为冲突。
 * 不同作用域（如 recording 接管 global）不算冲突，但会被调用方按优先级处理。
 */
export function findConflicts(bindings: ShortcutBinding[]): ShortcutConflict[] {
  const byCanonical = new Map<string, ShortcutBinding[]>()

  for (const binding of bindings) {
    const parsed = parseShortcut(binding.shortcut)
    if (!parsed.valid) continue // 非法键位不参与冲突（由校验 UI 单独报错）
    const list = byCanonical.get(parsed.canonical)
    if (list) {
      if (!list.some(b => b.id === binding.id)) list.push(binding)
    } else {
      byCanonical.set(parsed.canonical, [binding])
    }
  }

  const conflicts: ShortcutConflict[] = []
  for (const [canonical, items] of byCanonical) {
    if (items.length < 2) continue
    // 所有 items 的 canonical 相同，展示串取第一个即可
    conflicts.push({ canonical, display: formatShortcut(items[0]!.shortcut), items })
  }
  return conflicts
}

/** 校验一批绑定，返回「非法键位」清单（配置页保存前调用） */
export function validateBindings(
  bindings: ShortcutBinding[],
): Array<{ id: string; shortcut: string; error: string }> {
  const problems: Array<{ id: string; shortcut: string; error: string }> = []
  for (const binding of bindings) {
    const parsed = parseShortcut(binding.shortcut)
    if (!parsed.valid) {
      problems.push({ id: binding.id, shortcut: binding.shortcut, error: parsed.error ?? '非法快捷键' })
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// 焦点判断（避免在输入框里抢键）
// ---------------------------------------------------------------------------

export interface EditableTargetLike {
  tagName?: string
  isContentEditable?: boolean
  type?: string
  getAttribute?: (name: string) => string | null
}

/**
 * 目标是否是可编辑元素。
 * 待确认队列、章节改名等场景必须先问这个，否则用户打字时按 `S` 会被当成「跳过」。
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as EditableTargetLike
  if (el.isContentEditable) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el.type ?? 'text').toLowerCase()
    // 复选框/按钮类输入不拦截键盘
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(type)
  }
  return false
}

// ---------------------------------------------------------------------------
// 默认键位表（docs/12 §9.1）
// ---------------------------------------------------------------------------

/** 录音页默认快捷键（可被用户设置覆盖；此处只作为初始值） */
export const DEFAULT_RECORDING_SHORTCUTS: ShortcutBinding[] = [
  { id: 'record.toggle', shortcut: 'Space', label: '开始/停止录音', scope: 'recording' },
  { id: 'record.toggleAlt', shortcut: 'Enter', label: '开始/停止录音（备用）', scope: 'recording' },
  { id: 'record.redo', shortcut: 'Ctrl+R', label: '丢弃并重录', scope: 'recording' },
  { id: 'line.next', shortcut: 'Down', label: '下一行', scope: 'recording' },
  { id: 'line.nextAlt', shortcut: 'Ctrl+Right', label: '下一行（备用）', scope: 'recording' },
  { id: 'line.prev', shortcut: 'Up', label: '上一行', scope: 'recording' },
  { id: 'line.prevAlt', shortcut: 'Ctrl+Left', label: '上一行（备用）', scope: 'recording' },
  { id: 'line.skip', shortcut: 'Right', label: '跳过（本轮）', scope: 'recording' },
  { id: 'take.play', shortcut: 'P', label: '播放当前 take', scope: 'recording' },
  { id: 'line.playPrev', shortcut: 'Shift+P', label: '播放上一行', scope: 'recording' },
  { id: 'record.mark', shortcut: 'M', label: '录制中打标记', scope: 'recording' },
  { id: 'continuous.retake', shortcut: 'N', label: '连续录制：标记重来', scope: 'recording' },
  { id: 'take.undoSelect', shortcut: 'Ctrl+Z', label: '撤销上一个 take 选择', scope: 'recording' },
  { id: 'monitor.toggle', shortcut: 'Ctrl+M', label: '切换监听', scope: 'recording' },
  { id: 'paragraph.next', shortcut: 'Ctrl+Down', label: '下一段落', scope: 'recording' },
]

/** 待确认队列键位（docs/11 §4.5，全键盘，目标 3 分钟清 100 行） */
export const REVIEW_QUEUE_SHORTCUTS: ShortcutBinding[] = [
  { id: 'review.pick1', shortcut: '1', label: '选择候选 1', scope: 'review' },
  { id: 'review.pick2', shortcut: '2', label: '选择候选 2', scope: 'review' },
  { id: 'review.pick3', shortcut: '3', label: '选择候选 3', scope: 'review' },
  { id: 'review.confirm', shortcut: 'Enter', label: '确认并下一行', scope: 'review' },
  { id: 'review.skip', shortcut: 'S', label: '跳过', scope: 'review' },
  { id: 'review.play', shortcut: 'P', label: '播放', scope: 'review' },
  { id: 'review.undo', shortcut: 'Z', label: '撤销', scope: 'review' },
  { id: 'review.applyRun', shortcut: 'Ctrl+Enter', label: '应用到下面 N 行', scope: 'review' },
  { id: 'review.acceptHigh', shortcut: 'Ctrl+Shift+Enter', label: '一键确认高置信', scope: 'review' },
]
