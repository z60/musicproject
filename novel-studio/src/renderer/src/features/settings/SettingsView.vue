<!--
  Novel Studio · 设置页（分类设置，docs/04 §8.2）
  ============================================================================
  设计依据：
    · docs/04 §8.2 —— 设置项清单与分组（路径 / 音频 / 录音 / 画本 / 混音 / 导出 /
      AI / 外观 / 高级）。本页把「高级」拆成「日志与诊断」和「备份」两个入口，
      因为这两件事是**动作**（体检、导出诊断包、备份、恢复），不只是几个开关。
    · docs/04 §8.3 —— 影响面大的项不能热改：采样率/位深、ffmpeg 路径、模型目录
      都标注了「影响新录音/重启后生效」，并说明后果。
    · docs/22 §7   —— `action=open_settings` 的语义：带 `?focus=<code>` 进来时，
      要**高亮并滚动到**相关设置项。本页支持三种 focus 取值：
        ① 数字编号（E200005）② 语义键（MODEL_MISSING）③ 设置键（ai.apiKey / mixing.targetLufs）。
      说明条的文案全部取自消息表（@shared/messages.ts），页面自己**不写错误文案**，
      只写「已定位到哪一项」的定位提示。
    · docs/02 §5.1 —— 能力探测：ffmpeg 缺失滤镜 / 模型缺失 / 无输入设备时，
      控件必须**禁用或隐藏**，并说明原因，而不是等用户点了才报错。
    · docs/11 §4.9 —— 保存失败必须明说「修改仍在内存中」（AutoSaveIndicator 负责）。

  读写纪律（重要）：
    设置项的读写**只**经 useSettingsStore() 的 load() / patch() / reset() / setSecret()。
    patch() 内部会 `settings:set` 并在成功后**重新拉取**（主进程可能做归一化/联动），
    因此本页的操作顺序是「先乐观改内存 → patch → 以主进程返回的值为准」。
    失败时内存里的改动刻意保留：AutoSaveIndicator 的「你的修改仍在内存中」才是真话。
-->

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import AutoSaveIndicator from '@/shared/ui/AutoSaveIndicator.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import ProviderSettings from './ProviderSettings.vue'
import ModelStatusPanel from './ModelStatusPanel.vue'
import DiagnosticsPanel from './DiagnosticsPanel.vue'
import BackupPanel from './BackupPanel.vue'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useUiStore } from '@/app/store/ui.store.ts'
import { callSafe } from '@/shared/lib/ipc.ts'
import { isAppError } from '@shared/errors.ts'
import { getMessage, listAllCodes } from '@shared/messages.ts'
import { formatBytes, formatLufs } from '@/shared/lib/format.ts'
import {
  DEFAULT_RECORDING_SHORTCUTS,
  eventToShortcutString,
  findConflicts,
  formatShortcut,
  parseShortcut,
} from '@/shared/lib/shortcuts.ts'
import type { ShortcutBinding } from '@/shared/lib/shortcuts.ts'
import { buildFileNames, renderTemplate, unknownPlaceholders } from '@/shared/lib/template.ts'
import {
  ARRANGE_DEFAULTS,
  AUDIO_DEFAULTS,
  CANVAS_DEFAULTS,
  EMOTIONS,
  EXPORT_DEFAULTS,
  LOUDNESS_TARGETS,
  RECORD_LIMITS,
  TEMPO_PRESETS,
  TRIM_DEFAULTS,
  VAD_DEFAULTS,
} from '@shared/constants.ts'
import type { AppPaths, AppSettings, AudioDeviceInfo, RecordingMode } from '@shared/types.ts'
import type { DeepPartial } from '@shared/ipc.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'

// ============================================================================
// 分类
// ============================================================================

type SectionId =
  | 'paths' | 'audio' | 'recording' | 'canvas' | 'mixing'
  | 'export' | 'ai' | 'appearance' | 'diagnostics' | 'backup'

interface SectionDef {
  id: SectionId
  label: string
  icon: string
  /** 一句话说明这个分类管什么（左侧导航的第二行） */
  summary: string
  /** 「恢复默认」要传的 keys（settings:reset 的 keys 是可选的） */
  resetKeys: string[]
}

const SECTIONS: SectionDef[] = [
  { id: 'paths', label: '路径', icon: '📁', summary: '项目 / 导出 / 缓存 / 备份 / 模型 / ffmpeg', resetKeys: ['paths'] },
  { id: 'audio', label: '音频', icon: '🎚', summary: '采集格式、输入设备、增益与修剪', resetKeys: ['audio'] },
  { id: 'recording', label: '录音', icon: '🎙', summary: '默认模式、快捷键、脚踏板、VAD', resetKeys: ['recording'] },
  { id: 'canvas', label: '画本', icon: '📝', summary: '说话人判定阈值与默认留白', resetKeys: ['canvas'] },
  { id: 'mixing', label: '混音', icon: '🎛', summary: '目标响度、真峰、闪避、对轨容差', resetKeys: ['mixing'] },
  { id: 'export', label: '导出', icon: '📤', summary: '格式、码率、命名模板', resetKeys: ['export'] },
  { id: 'ai', label: 'AI', icon: '🤖', summary: '服务商、隐私、模型、嵌入与 ASR', resetKeys: ['ai', 'embedding', 'asr'] },
  { id: 'appearance', label: '外观', icon: '🎨', summary: '主题、语言、编辑密度', resetKeys: ['ui'] },
  { id: 'diagnostics', label: '日志与诊断', icon: '🩺', summary: '日志级别、能力探测、数据库体检、诊断包', resetKeys: ['advanced'] },
  { id: 'backup', label: '备份', icon: '💾', summary: '自动备份策略与恢复', resetKeys: ['advanced'] },
]

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const ui = useUiStore()

const active = ref<SectionId>('paths')
const formRoot = ref<HTMLElement | null>(null)

/**
 * 设置对象（模板里用 `s.audio.xxx`）。
 *
 * 类型上是 `AppSettings`（**非空**）而不是 `AppSettings | null`：
 * 模板里 90+ 处 `s.xxx` 直接取属性，若声明成可空，每个读取点都会报
 * TS18047「'__VLS_ctx.s' is possibly 'null'」（实测至少两处报错，其余被 vue-tsc
 * 的上报上限压住，改动一点就会冒出来）。
 *
 * 「还没读完」用独立的 `loaded` 表达（模板里 `v-if="!loaded"` 显示骨架屏），
 * 语义完全没变：未加载时 `loaded === false`，模板整块不渲染，占位对象不会被读到。
 * 这里刻意**不伪造数据**：占位只在静态类型层存在，加载中不会有人读到它。
 */
const s = computed<AppSettings>(() => settings.settings ?? ({} as AppSettings))
/** 设置是否已从主进程读回（false → 骨架屏） */
const loaded = computed(() => settings.settings !== null)

// ============================================================================
// 保存状态（统一在这里维护，子面板通过 saveState 事件汇总过来）
// ============================================================================

const saveStatus = ref<SaveStatus>('idle')
const savedAt = ref<number | null>(null)
const saveError = ref<string | null>(null)
/** 最后一次 patch 的内容：「重试」要重放的就是它 */
const lastPatch = ref<DeepPartial<AppSettings> | null>(null)

function errorText(error: unknown): string | null {
  return isAppError(error) ? error.resolved.title : null
}

async function runPatch(patch: DeepPartial<AppSettings>): Promise<void> {
  saveStatus.value = 'saving'
  saveError.value = null
  try {
    await settings.patch(patch)
    saveStatus.value = 'saved'
    savedAt.value = Date.now()
  } catch (error) {
    // 失败提示已由 error-bus 给出（call 的默认策略）；这里只把状态挂到指示器上
    saveStatus.value = 'error'
    saveError.value = errorText(error)
  }
}

async function save(patch: DeepPartial<AppSettings>): Promise<void> {
  lastPatch.value = patch
  await runPatch(patch)
}

async function retrySave(): Promise<void> {
  if (lastPatch.value) {
    await runPatch(lastPatch.value)
    return
  }
  await reloadSettings()
}

/** 放弃修改：重新从主进程读取，内存里的改动被覆盖（docs/11 §4.9 的回滚语义） */
async function revertSave(): Promise<void> {
  saveStatus.value = 'saving'
  try {
    await settings.load(true)
    saveStatus.value = 'saved'
    savedAt.value = Date.now()
    saveError.value = null
  } catch {
    saveStatus.value = 'error'
  }
}

async function reloadSettings(): Promise<void> {
  saveStatus.value = 'saving'
  try {
    await settings.load(true)
    await loadPaths()
    saveStatus.value = 'saved'
    savedAt.value = Date.now()
    saveError.value = null
  } catch (error) {
    saveStatus.value = 'error'
    saveError.value = errorText(error)
  }
}

/** 子面板的保存状态并入底部指示器 */
function onChildSaveState(state: { status: SaveStatus; error?: string | null }): void {
  saveStatus.value = state.status
  if (state.status === 'saved') savedAt.value = Date.now()
  if (state.status === 'error') saveError.value = state.error ?? null
}

/**
 * 整组保存：表单直接 v-model 到 store 里的对象（乐观 UI），
 * 变更后把**整组**作为 patch 交回主进程 —— 这样主进程能一次性做归一化与联动校验。
 */
function saveGroup(group: keyof AppSettings): void {
  const current = settings.settings
  if (!current) return
  void save({ [group]: { ...current[group] } } as DeepPartial<AppSettings>)
}

function isHl(key: string): boolean {
  return highlightKeys.value.includes(key)
}

// ============================================================================
// 路径：选择目录 / 文件，以及 app:getPaths 的实际生效值
// ============================================================================

const pathsInfo = ref<AppPaths | null>(null)

async function loadPaths(): Promise<void> {
  const loaded = await callSafe('app:getPaths', undefined)
  if (loaded) pathsInfo.value = loaded as AppPaths
}

type PathKey = 'projectRoot' | 'exportDir' | 'ffmpegPath' | 'modelDir' | 'cacheDir' | 'backupDir'

/**
 * 保存**单个**路径字段（路径输入框的 `@change`）。
 *
 * 为什么不再用 `saveGroup('paths')`：输入框被清空时 `v-model` 给出的是**空串**，
 * 而空串既不是合法路径、也不是 schema 眼里的「未设置」。原来的写法会把这一个空串
 * 混进整组一起提交 —— 该项校验不过，整组就被拒收，**连刚选好的其它目录一起白改**。
 *
 * 归一规则（与 `AppSettings` 的类型保持一致）：
 *   · 可空字段（`paths.ffmpegPath` / `paths.modelDir`，类型即 `string | null`）
 *     清空 → `null`，表示「用随应用分发的默认位置」
 *   · 其余路径字段类型是 `string`，不允许为空 → 清空时回落成**当前生效值**（不再覆盖）
 */
function savePathField(key: PathKey): void {
  const current = settings.settings
  if (!current) return

  const raw = String(current.paths[key] ?? '').trim()
  const nullable = key === 'ffmpegPath' || key === 'modelDir'
  const fallback = nullable ? null : (pathsInfo.value?.[key] ?? '')
  const next: string | null = raw || fallback

  // 空且连生效值都拿不到（`app:getPaths` 还没回来）：不提交 —— 宁可不改，
  // 也不能把 `''` 这种非法值写进设置树。
  if (next === '') return

  ;(current.paths as Record<string, unknown>)[key] = next
  void save({ paths: { [key]: next } } as DeepPartial<AppSettings>)
}

async function pickFolder(key: PathKey, title: string): Promise<void> {
  const current = settings.settings
  if (!current) return
  const result = await callSafe('app:openFolderDialog', {
    title,
    defaultPath: current.paths[key] ?? undefined,
  })
  const picked = (result as { path: string | null } | null)?.path
  if (!picked) return
  current.paths[key] = picked // 乐观：失败时改动仍留在内存里
  void save({ paths: { [key]: picked } } as DeepPartial<AppSettings>)
}

async function pickFfmpegPath(): Promise<void> {
  const current = settings.settings
  if (!current) return
  // 不加扩展名过滤：macOS / Linux 的 ffmpeg 没有扩展名，加了就把文件藏起来了
  const result = await callSafe('app:openFileDialog', {
    title: '选择 ffmpeg 可执行文件',
    multi: false,
  })
  const picked = (result as { paths: string[] } | null)?.paths?.[0]
  if (!picked) return
  current.paths.ffmpegPath = picked
  void save({ paths: { ffmpegPath: picked } })
}

async function pickCoverPath(): Promise<void> {
  const current = settings.settings
  if (!current) return
  const result = await callSafe('app:openFileDialog', {
    title: '选择封面图片',
    multi: false,
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  })
  const picked = (result as { paths: string[] } | null)?.paths?.[0]
  if (!picked) return
  current.export.coverPath = picked
  void save({ export: { coverPath: picked } })
}

/** 清除封面（空串与 null 都表示「没有封面」，这里用 null 与类型保持一致） */
function clearCoverPath(): void {
  const current = settings.settings
  if (!current) return
  current.export.coverPath = null
  void save({ export: { coverPath: null } })
}

async function reveal(path: string | null | undefined): Promise<void> {
  if (!path) return
  await callSafe('app:showItemInFolder', { path })
}

// ============================================================================
// 音频：设备列表与能力门控
// ============================================================================

const devices = ref<AudioDeviceInfo[]>([])
const devicesBusy = ref(false)
const preferredDeviceId = ref<string | null>(null)

const inputDevices = computed(() => devices.value.filter(d => d.kind === 'audioinput'))

/**
 * 「跟随系统默认设备」这个选项的绑定值。
 *
 * **运行时它就是 `null`** —— 后端用 `null` 表示「不指定设备」，语义不能改成 `''`。
 * 这里只是把类型收敛到 `el-option` 的 `value` prop 允许的范围内（它不接受 `null`）。
 * 断言放在脚本里而不是模板里：模板表达式按 JS 解析，写不了 TS 断言
 * （`check:template-types` 专门拦这类写法）。
 */
const FOLLOW_SYSTEM_DEVICE = null as unknown as string

async function loadDevices(): Promise<void> {
  devicesBusy.value = true
  try {
    const result = await callSafe('device:list', undefined) as
      | { devices: AudioDeviceInfo[]; preferred: string | null }
      | null
    if (result) {
      devices.value = result.devices
      preferredDeviceId.value = result.preferred
    }
  } finally {
    devicesBusy.value = false
  }
}

/** ffmpeg 是否就绪（缺失滤镜 → 禁用相关控件，docs/02 §5.1） */
const ffmpegReady = computed(() => settings.ffmpegReady)
const missingFilters = computed(() => settings.missingFilters)

function filterBlocked(filter: string): boolean {
  return !ffmpegReady.value || missingFilters.value.includes(filter)
}

const loudnessBlocked = computed(() => filterBlocked('loudnorm'))
const limiterBlocked = computed(() => filterBlocked('alimiter'))
const duckingBlocked = computed(() => filterBlocked('sidechaincompress'))
const mp3Blocked = computed(() => {
  const encoders = settings.capabilities?.ffmpeg.encoders ?? []
  return !ffmpegReady.value || (encoders.length > 0 && !encoders.includes('libmp3lame'))
})
const aacBlocked = computed(() => {
  const encoders = settings.capabilities?.ffmpeg.encoders ?? []
  return !ffmpegReady.value || (encoders.length > 0 && !encoders.includes('aac'))
})

function gotoSection(id: SectionId): void {
  active.value = id
}

// ============================================================================
// 录音：按键捕获 + 冲突检测 + 脚踏板
// ============================================================================

type ShortcutField = 'stopKey' | 'nextLineKey' | 'redoKey' | 'playKey'

const KEY_FIELDS: Array<{ field: ShortcutField; label: string; hint: string; defaultId: string }> = [
  { field: 'stopKey', label: '开始 / 停止录音', hint: '默认 Space：录音中按一次即停止并保存本行。', defaultId: 'record.toggle' },
  { field: 'nextLineKey', label: '下一行', hint: '默认 ↓：切到下一画本行（未录的行会高亮提示）。', defaultId: 'line.next' },
  { field: 'redoKey', label: '丢弃并重录', hint: '默认 Ctrl+R：丢弃当前行的 take 并立即重录。', defaultId: 'record.redo' },
  { field: 'playKey', label: '播放当前 take', hint: '默认 P：播放当前行已录内容，用于回听确认。', defaultId: 'take.play' },
]

const RECORDING_MODES: Array<{ value: RecordingMode; label: string; hint: string }> = [
  { value: 'line_by_line', label: '逐行录制', hint: '一行一条 take，最稳；重录单行代价最小，推荐新手。' },
  { value: 'continuous', label: '连续录制（后期切片）', hint: '一口气读完整章，再用 VAD 切片匹配到行；需要可靠的切片参数。' },
  { value: 'role', label: '按角色集中录制', hint: '同一角色的台词排在一起，减少配音员切换声线的次数。' },
  { value: 'punch_in', label: '插入补录', hint: '只补某行的一小段，不重录整行。' },
  { value: 'package', label: '任务包录制', hint: '按 .nst 任务包录制，用于线下配音员回收素材。' },
]

const PEDAL_ACTIONS: Array<{ id: string; label: string }> = [
  { id: 'record.toggle', label: '开始 / 停止录音' },
  { id: 'line.next', label: '下一行' },
  { id: 'line.prev', label: '上一行' },
  { id: 'record.redo', label: '丢弃并重录' },
  { id: 'take.play', label: '播放当前 take' },
]

const PEDAL_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  PEDAL_ACTIONS.map(item => [item.id, item.label]),
)

/** 正在捕获键位的字段（聚焦后按键即回填） */
const activeCaptureField = ref<string | null>(null)
/** 非法键位提示（界面校验提示，不是错误文案，因此不走 error-bus） */
const keyError = ref<string | null>(null)
/** 踏板测试的最近一次按键 */
const pedalTestKey = ref<string | null>(null)
const pedalTestHint = ref('')

function defaultShortcutOf(id: string): string {
  return DEFAULT_RECORDING_SHORTCUTS.find(binding => binding.id === id)?.shortcut ?? ''
}

/** 四个可配置键位组成同一作用域（recording）的绑定表，用于冲突检测 */
const keyboardBindings = computed<ShortcutBinding[]>(() => {
  const recording = settings.settings?.recording
  if (!recording) return []
  return KEY_FIELDS.map(item => ({
    id: `recording.${item.field}`,
    shortcut: recording[item.field],
    label: item.label,
    scope: 'recording',
  }))
})

const keyboardConflicts = computed(() => findConflicts(keyboardBindings.value))

/** 踏板映射同样做冲突检测（两个动作映射到同一个键位） */
const pedalBindings = computed<ShortcutBinding[]>(() => {
  const mapping = settings.settings?.recording.footPedalMapping ?? {}
  return Object.entries(mapping).map(([action, key]) => ({
    id: `pedal.${action}`,
    shortcut: key,
    label: PEDAL_ACTION_LABELS[action] ?? action,
    scope: 'pedal',
  }))
})

const pedalConflicts = computed(() => findConflicts(pedalBindings.value))

function keyIssue(field: ShortcutField): string | null {
  const value = settings.settings?.recording[field]
  if (!value) return '尚未设置：这一行的快捷键为空，录音时会没有任何反应。'
  if (!parseShortcut(value).valid) return `无法识别的键位：${value}`
  const id = `recording.${field}`
  const hit = keyboardConflicts.value.find(conflict => conflict.items.some(item => item.id === id))
  if (hit) {
    const others = hit.items.filter(item => item.id !== id).map(item => item.label ?? item.id)
    return `与「${others.join('、')}」冲突（都是 ${hit.display}）：录制时会互相抢键。`
  }
  return null
}

/**
 * 键盘捕获：聚焦后按键 → eventToShortcutString → 回填（docs/12 §9.1）。
 *
 * 参数类型是 `Event | KeyboardEvent` 而不是 `KeyboardEvent`：模板里
 * `@keydown.prevent="captureKey($event, ...)"` 的 `$event` 在 vue-tsc 下推断为
 * `Event | KeyboardEvent`（不同 Element Plus 版本会变），声明成 `KeyboardEvent` 会报
 * TS2345「Argument of type 'Event | KeyboardEvent' is not assignable」。
 * 函数体内收窄一次，之后仍按 KeyboardEvent 使用。
 */
function captureKey(raw: Event | KeyboardEvent, field: ShortcutField): void {
  const event = raw as KeyboardEvent
  // 纯修饰键不构成键位，等真正的主键
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process'].includes(event.key)) return
  const combo = eventToShortcutString(event)
  if (!combo) {
    keyError.value = `这个键（${event.key}）认不出来，请换一个：支持字母 / 数字 / F1~F24 / 方向键 / 空格 / 加减号等。`
    return
  }
  keyError.value = null
  activeCaptureField.value = null
  const recording = settings.settings?.recording
  if (recording) recording[field] = combo // 乐观：失败时改动仍在内存里
  void save({ recording: { [field]: combo } } as DeepPartial<AppSettings>)
}

function resetKeyField(field: ShortcutField, defaultId: string): void {
  const value = defaultShortcutOf(defaultId)
  if (!value) return
  const recording = settings.settings?.recording
  if (recording) recording[field] = value
  keyError.value = null
  void save({ recording: { [field]: value } } as DeepPartial<AppSettings>)
}

/** 脚踏板映射表编辑：整表替换（主进程按 Record 合并） */
function pedalMapping(): Record<string, string> {
  return { ...(settings.settings?.recording.footPedalMapping ?? {}) }
}

function commitPedalMapping(next: Record<string, string>): void {
  const recording = settings.settings?.recording
  if (recording) recording.footPedalMapping = next
  void save({ recording: { footPedalMapping: next } })
}

const pedalRows = computed(() => Object.entries(settings.settings?.recording.footPedalMapping ?? {})
  .map(([action, key]) => ({ action, key })))

const availablePedalActions = computed(() => PEDAL_ACTIONS.filter(
  action => !(action.id in (settings.settings?.recording.footPedalMapping ?? {})),
))

function addPedalRow(): void {
  const next = availablePedalActions.value[0]
  if (!next) return
  // 脚踏板最常用 F13（避让键盘按键），先给个能用的起点
  commitPedalMapping({ ...pedalMapping(), [next.id]: 'F13' })
}

function setPedalKey(action: string, key: string): void {
  commitPedalMapping({ ...pedalMapping(), [action]: key })
}

/** 脚踏板映射的按键捕获：认不出的键位就保持原值，不要写进去一个空串（参数收宽理由同 captureKey） */
function capturePedalKey(raw: Event | KeyboardEvent, action: string): void {
  const event = raw as KeyboardEvent
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process'].includes(event.key)) return
  const combo = eventToShortcutString(event)
  if (!combo) return
  setPedalKey(action, combo)
}

function removePedalRow(action: string): void {
  const next = pedalMapping()
  delete next[action]
  commitPedalMapping(next)
}

/** 踏板测试：按下踏板上的键，看它被识别成什么、映射到哪个动作（参数收宽理由同 captureKey） */
function testPedal(raw: Event | KeyboardEvent): void {
  const event = raw as KeyboardEvent
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process'].includes(event.key)) return
  const combo = eventToShortcutString(event)
  if (!combo) {
    pedalTestKey.value = null
    pedalTestHint.value = `这个键（${event.key}）认不出来，无法作为踏板映射。`
    return
  }
  pedalTestKey.value = combo
  const mapping = pedalMapping()
  const hit = Object.entries(mapping).find(([, key]) => parseShortcut(key).canonical === parseShortcut(combo).canonical)
  pedalTestHint.value = hit
    ? `已识别：${formatShortcut(combo)} → ${PEDAL_ACTION_LABELS[hit[0]] ?? hit[0]}`
    : `已识别：${formatShortcut(combo)}，但还没有动作映射到这个键位。`
}

/** VAD 一整块保存（字段之间有联动校验，交给主进程统一做） */
function saveVad(): void {
  const vad = settings.settings?.recording.vad
  if (!vad) return
  void save({ recording: { vad: { ...vad } } })
}

// ============================================================================
// 导出：命名模板实时预览（docs/15 §5.3 / §5.5）
// ============================================================================

/** 预览用的示例章节：故意带一个含非法字符的标题，让「文件名清洗」可见 */
const SAMPLE_CHAPTERS = [
  { chapterIndex: 1, chapterTitle: '陨落的天才', volumeTitle: '第一卷' },
  { chapterIndex: 2, chapterTitle: '斗气大陆', volumeTitle: '第一卷' },
  { chapterIndex: 12, chapterTitle: '第12章 测试/文件名?', volumeTitle: null },
]

const filePreview = computed(() => {
  const current = settings.settings
  if (!current) return []
  return buildFileNames(current.export.fileNameTemplate, SAMPLE_CHAPTERS, {
    bookTitle: '示例书名',
    author: '示例作者',
    narrator: '示例播讲',
    volumeTitle: '第一卷',
    date: new Date(),
    format: current.export.format,
    totalChapters: 120,
    ext: current.export.format,
  })
})

const unknownTokens = computed(() => unknownPlaceholders(settings.settings?.export.fileNameTemplate ?? ''))

/**
 * 未知占位符的展示文本。
 *
 * ⚠️ **为什么在 script 里算，而不是直接在模板里 `map(...).join()`**：
 * 把 token 包成 `{name}` 需要出现「右花括号紧跟右花括号」的两个字符，
 * 而 Vue 的插值分词器**在遇到那对字符时就认为 `{{ }}` 结束了**，
 * 于是表达式被从中间截断（留下一个未闭合的模板字符串）→ 编译报
 * `Error parsing JavaScript expression: Unexpected token, expected "}"`，
 * 整个构建失败。字符串拼接放在这里就完全绕开了分词器的这一层。
 */
const unknownTokensHint = computed(() => unknownTokens.value.map((token) => '{' + token + '}').join('、'))

const chapterTitlePreview = computed(() => renderTemplate(
  settings.settings?.export.chapterTitleTemplate ?? EXPORT_DEFAULTS.chapterTitleTemplate,
  { index: 12, title: '陨落的天才', chapterIndex: 12, chapterTitle: '陨落的天才' },
))

const m4bSplitWarning = computed(() => {
  const every = settings.settings?.export.splitM4bEvery ?? 0
  return every > 0 && every > EXPORT_DEFAULTS.m4bChapterWarnThreshold
})

// ============================================================================
// 外观
// ============================================================================

const THEME_OPTIONS: Array<{ value: AppSettings['ui']['theme']; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const DENSITY_OPTIONS: Array<{ value: AppSettings['ui']['editorDensity']; label: string; hint: string }> = [
  { value: 'compact', label: '紧凑', hint: '一屏看更多行，适合长章节逐行校对。' },
  { value: 'normal', label: '标准', hint: '默认密度。' },
  { value: 'relaxed', label: '宽松', hint: '行高更大，适合触控板与长时间阅读。' },
]

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English（界面文案可能不完整）' },
]

function onThemeChange(): void {
  const mode = settings.settings?.ui.theme
  if (!mode) return
  ui.setTheme(mode) // 立刻改 <html data-theme>，避免等 IPC 往返导致闪一下
  void save({ ui: { theme: mode } })
}

// ============================================================================
// focus 定位（docs/22 §7 的 action=open_settings 语义）
// ============================================================================

interface FocusTarget {
  section: SectionId
  /** 需要高亮的设置键；空串表示只切分类 */
  anchor: string
}

/** 数字编号 → 语义键（编号由 messages.ts 声明顺序确定性派生） */
const CODE_TO_KEY: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const item of listAllCodes()) map[item.code] = item.key
  return map
})()

/** 语义键 → 具体设置项（消息表里的 action=open_settings 都应当能落到这里） */
const MESSAGE_TARGETS: Record<string, FocusTarget> = {
  DEVICE_UNAVAILABLE: { section: 'audio', anchor: 'audio.defaultInputDeviceId' },
  DEVICE_PERMISSION: { section: 'audio', anchor: 'audio.defaultInputDeviceId' },
  RECORD_NO_SIGNAL: { section: 'audio', anchor: 'audio.inputGainDb' },
  RECORD_CLIPPING: { section: 'audio', anchor: 'audio.inputGainDb' },
  RECORD_MONITOR_FEEDBACK: { section: 'audio', anchor: 'audio.monitorGainDb' },
  VAD_NO_SPEECH_FOUND: { section: 'recording', anchor: 'recording.vad.silenceDb' },
  TRIM_FAILED: { section: 'audio', anchor: 'audio.trimThresholdDb' },
  FILE_TOO_LARGE: { section: 'paths', anchor: 'import.maxFileSizeBytes' },
  FILTER_UNSUPPORTED: { section: 'diagnostics', anchor: 'diagnostics.ffmpeg' },
  EXPORT_OUTPUT_NOT_WRITABLE: { section: 'paths', anchor: 'paths.exportDir' },
  EXPORT_LOUDNESS_OUT_OF_RANGE: { section: 'mixing', anchor: 'mixing.targetLufs' },
  EXPORT_TRUE_PEAK_EXCEEDED: { section: 'mixing', anchor: 'mixing.truePeakDb' },
  EXPORT_M4B_TOO_MANY_CHAPTERS: { section: 'export', anchor: 'export.splitM4bEvery' },
  EXPORT_METADATA_WRITE_FAILED: { section: 'export', anchor: 'export.writeMetadata' },
  MIX_TARGET_CONFLICT: { section: 'mixing', anchor: 'mixing.targetLufs' },
  MIX_DUCKING_SIDECHAIN_MISSING: { section: 'mixing', anchor: 'mixing.duckAmountDb' },
  CANVAS_EMBEDDING_UNAVAILABLE: { section: 'ai', anchor: 'embedding.modelId' },
  CANVAS_LLM_UNAVAILABLE: { section: 'ai', anchor: 'ai.provider' },
  ATTRIBUTION_RECOMPUTE_REQUIRED: { section: 'ai', anchor: 'embedding.modelId' },
  ATTRIBUTION_LOW_ACCURACY: { section: 'canvas', anchor: 'canvas.attributionThreshold' },
  MODEL_MISSING: { section: 'ai', anchor: 'ai.models' },
  MODEL_CHECKSUM_MISMATCH: { section: 'ai', anchor: 'ai.models' },
  MODEL_LOAD_FAILED: { section: 'ai', anchor: 'ai.models' },
  MODEL_OOM: { section: 'ai', anchor: 'embedding.batchSize' },
  PROVIDER_UNAVAILABLE: { section: 'ai', anchor: 'ai.baseUrl' },
  PROVIDER_TIMEOUT: { section: 'ai', anchor: 'ai.timeoutMs' },
  PROVIDER_NETWORK_ERROR: { section: 'ai', anchor: 'ai.baseUrl' },
  PROVIDER_CIRCUIT_OPEN: { section: 'ai', anchor: 'ai.provider' },
  PROVIDER_CLOUD_DISABLED: { section: 'ai', anchor: 'ai.allowSendTextToCloud' },
  APP_SECRET_DECRYPT_FAILED: { section: 'ai', anchor: 'ai.apiKey' },
  APP_SECURE_STORAGE_UNAVAILABLE: { section: 'ai', anchor: 'ai.apiKey' },
  APP_CONFIG_INVALID: { section: 'diagnostics', anchor: 'diagnostics.info' },
  DISK_FULL: { section: 'paths', anchor: 'paths.cacheDir' },
  DB_BUSY: { section: 'diagnostics', anchor: 'diagnostics.db' },
  DB_CORRUPT: { section: 'backup', anchor: 'backup.list' },
  DB_BACKUP_FAILED: { section: 'backup', anchor: 'backup.list' },
  DB_RESTORE_FAILED: { section: 'backup', anchor: 'backup.list' },
  TASK_QUEUE_FULL: { section: 'diagnostics', anchor: 'diagnostics.info' },
  ENCODING_UNCERTAIN: { section: 'paths', anchor: 'import.maxFileSizeBytes' },
  PDF_NO_TEXT_LAYER: { section: 'paths', anchor: 'import.maxFileSizeBytes' },
}

/** 消息段 → 兜底分类（表里没写死的语义键靠它落到一个合理的分类） */
const SEGMENT_FALLBACK: Record<string, SectionId> = {
  RECORD: 'audio',
  BOOK: 'paths',
  EXPORT: 'export',
  CANVAS: 'canvas',
  AI: 'ai',
  DATA: 'backup',
  TASK: 'diagnostics',
  APP: 'diagnostics',
  GENERIC: 'diagnostics',
  INTERNAL: 'diagnostics',
}

const SETTING_ROOT_SECTION: Record<string, SectionId> = {
  paths: 'paths',
  import: 'paths',
  audio: 'audio',
  recording: 'recording',
  canvas: 'canvas',
  mixing: 'mixing',
  export: 'export',
  ai: 'ai',
  embedding: 'ai',
  asr: 'ai',
  ui: 'appearance',
  advanced: 'diagnostics',
}

const highlightKeys = ref<string[]>([])
const focusMark = ref<string | null>(null)
const focusMessage = ref<ReturnType<typeof getMessage> | null>(null)
const focusSettingKey = ref<string | null>(null)
const focusUnknown = ref<string | null>(null)

/** 是否是「已登记的语义键」（getMessage 对未知键会回退到 INTERNAL） */
function isKnownMessageKey(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(value) && getMessage(value).key === value
}

function targetOfMessageKey(key: string): FocusTarget {
  const explicit = MESSAGE_TARGETS[key]
  if (explicit) return explicit
  const segment = getMessage(key).segment
  return { section: SEGMENT_FALLBACK[segment] ?? 'diagnostics', anchor: '' }
}

async function scrollToAnchor(anchor: string): Promise<void> {
  await nextTick()
  await nextTick()
  const root = formRoot.value
  if (!root || !anchor) return
  const el = root.querySelector(`[data-anchor="${anchor}"]`)
  if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/**
 * 应用 `?focus=`。
 * 三种取值都支持：数字编号 / 语义键 / 设置键（或分类名）。
 */
async function applyFocus(raw: unknown): Promise<void> {
  const value = typeof raw === 'string' ? raw.trim() : ''
  focusMark.value = value || null
  focusMessage.value = null
  focusSettingKey.value = null
  focusUnknown.value = null
  highlightKeys.value = []
  if (!value) return

  let target: FocusTarget | null = null

  const byCode = CODE_TO_KEY[value.toUpperCase()]
  if (byCode) {
    target = targetOfMessageKey(byCode)
    focusMessage.value = getMessage(byCode)
  } else if (isKnownMessageKey(value)) {
    target = targetOfMessageKey(value)
    focusMessage.value = getMessage(value)
  } else {
    const root = value.split('.')[0] ?? ''
    const section = SETTING_ROOT_SECTION[root]
    if (section) {
      target = { section, anchor: value }
      focusSettingKey.value = value
    } else {
      const bySection = SECTIONS.find(item => item.id === value)
      if (bySection) target = { section: bySection.id, anchor: '' }
    }
  }

  if (!target) {
    focusUnknown.value = value
    return
  }

  active.value = target.section
  if (target.anchor) {
    highlightKeys.value = [target.anchor]
    await scrollToAnchor(target.anchor)
  }
}

/** 顶部定位说明条：错误文案全部取自消息表，页面只补「定位到哪里」 */
const focusBanner = computed(() => {
  if (!focusMark.value) return null
  const sectionLabel = SECTIONS.find(item => item.id === active.value)?.label ?? ''

  if (focusUnknown.value) {
    return {
      tone: 'muted',
      title: `无法识别的定位标记「${focusUnknown.value}」`,
      detail: '已打开设置首页，请从左侧分类里手动查找。',
      hint: '定位标记通常形如 E400012（提示里的错误编号）、MODEL_MISSING（语义键）或 ai.apiKey（设置键）。',
    }
  }

  const message = focusMessage.value
  if (message) {
    return {
      tone: message.severity,
      title: `因错误「${message.title}」（${message.code}）跳到此处`,
      detail: message.detail ?? '',
      hint: `${message.hint ?? ''}已定位到「${sectionLabel}」分类中的相关设置项。`,
    }
  }

  return {
    tone: 'info',
    title: `已定位到设置项 ${focusSettingKey.value ?? ''}`,
    detail: `所在分类：${sectionLabel}`,
    hint: '改动即时生效；失败时底部会提示「修改仍在内存中」。',
  }
})

async function clearFocus(): Promise<void> {
  highlightKeys.value = []
  // 去掉 query 里的 focus：路由变化会再次触达 applyFocus，并把定位状态清干净
  await router.replace({ path: '/settings' })
}

// ============================================================================
// 恢复默认（二次确认）
// ============================================================================

const resetVisible = ref(false)
const resetScope = ref<'section' | 'all'>('section')
const resetBusy = ref(false)

const resetKeys = computed<string[]>(() => {
  if (resetScope.value === 'all') return []
  return SECTIONS.find(item => item.id === active.value)?.resetKeys ?? []
})

const resetTitle = computed(() => (resetScope.value === 'all' ? '恢复全部默认设置？' : '恢复本分类默认设置？'))

const resetDetails = computed<string[]>(() => {
  const scope = resetScope.value === 'all'
    ? '全部分组（路径 / 音频 / 录音 / 画本 / 混音 / 导出 / AI / 外观 / 高级）'
    : `「${SECTIONS.find(item => item.id === active.value)?.label ?? ''}」分类（${resetKeys.value.join('、')}）`
  return [
    `将被重置的范围：${scope}`,
    '已录制的音频、画本内容与导出成品**不受影响**：这里只重置设置项。',
    'API Key 等敏感项不在重置范围内，需要单独在「AI」分类里清除。',
    '重置后如需回到重置前的状态，只能手动改回来；建议先记下要改的几项。',
  ]
})

function openReset(scope: 'section' | 'all'): void {
  resetScope.value = scope
  resetVisible.value = true
}

async function confirmReset(): Promise<void> {
  resetBusy.value = true
  saveStatus.value = 'saving'
  try {
    await settings.reset(resetKeys.value.length ? resetKeys.value : undefined)
    saveStatus.value = 'saved'
    savedAt.value = Date.now()
    saveError.value = null
    resetVisible.value = false
  } catch (error) {
    saveStatus.value = 'error'
    saveError.value = errorText(error)
  } finally {
    resetBusy.value = false
  }
}

// ============================================================================
// 生命周期
// ============================================================================

watch(() => route.query.focus, (value) => { void applyFocus(value) }, { immediate: true })

onMounted(() => {
  void loadPaths()
  void loadDevices()
})

// 只读展示用的小工具（模板里算一次，避免在模板里堆表达式）
const tempoHint = computed(() => TEMPO_PRESETS.map(item => `${item.label} ×${item.factor}`).join(' / '))
const loudnessHint = computed(() => LOUDNESS_TARGETS.map(item => `${item.label}`).join('；'))
const sampleRateHint = computed(() => `默认 ${AUDIO_DEFAULTS.sampleRate} Hz（docs/05 §12）；改这里**只影响新录音**，已有 WAV 不会被重采样。`)
const bitDepthHint = computed(() => `采集固定用 float32（${AUDIO_DEFAULTS.captureBitDepth}），这里决定**落盘**位深，默认 ${AUDIO_DEFAULTS.fileBitDepth}。32 位浮点可救增益失误，代价是文件更大。`)
</script>

<template>
  <div class="ns-settings">
    <!-- ── 页头 ─────────────────────────────────────────────────────── -->
    <header class="ns-settings__head">
      <div>
        <h1 class="ns-settings__heading">设置</h1>
        <p class="ns-settings__sub">
          改动即时保存；影响新录制、新导出或需要重启才生效的项，都在下面标了出来。
        </p>
      </div>
      <div class="ns-settings__head-actions">
        <el-button size="small" :loading="settings.loading" @click="reloadSettings">重新读取</el-button>
        <el-button size="small" type="danger" plain @click="openReset('all')">恢复全部默认</el-button>
      </div>
    </header>

    <!-- ── focus 定位说明条（文案来自消息表）────────────────────────── -->
    <div v-if="focusBanner" class="ns-focus" :class="`ns-focus--${focusBanner.tone}`" role="status">
      <div class="ns-focus__body">
        <strong class="ns-focus__title">{{ focusBanner.title }}</strong>
        <p v-if="focusBanner.detail" class="ns-focus__detail">{{ focusBanner.detail }}</p>
        <p v-if="focusBanner.hint" class="ns-focus__hint">{{ focusBanner.hint }}</p>
      </div>
      <el-button size="small" @click="clearFocus">清除定位</el-button>
    </div>

    <div class="ns-settings__body">
      <!-- ── 左：分类导航 ──────────────────────────────────────────── -->
      <nav class="ns-settings__nav" aria-label="设置分类">
        <button
          v-for="item in SECTIONS"
          :key="item.id"
          type="button"
          class="ns-settings__nav-item"
          :class="{ 'is-active': active === item.id }"
          @click="active = item.id"
        >
          <span class="ns-settings__nav-icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="ns-settings__nav-text">
            <strong>{{ item.label }}</strong>
            <small>{{ item.summary }}</small>
          </span>
        </button>
      </nav>

      <!-- ── 右：表单 ──────────────────────────────────────────────── -->
      <section ref="formRoot" class="ns-settings__form">
        <LoadingBlock v-if="!loaded" variant="skeleton" text="正在读取设置…" :rows="6" />

        <el-form v-else label-width="200px" label-position="left">
          <!-- ============ 路径 ============ -->
          <template v-if="active === 'paths'">
            <h2 class="ns-section__title">路径</h2>

            <el-form-item label="项目目录" :class="{ 'ns-field--hl': isHl('paths.projectRoot') }" data-anchor="paths.projectRoot">
              <div class="ns-inline">
                <el-input v-model="s.paths.projectRoot" class="ns-input" @change="savePathField('projectRoot')" />
                <el-button @click="pickFolder('projectRoot', '选择项目根目录')">选择目录</el-button>
                <el-button :disabled="!s.paths.projectRoot" @click="reveal(s.paths.projectRoot)">打开</el-button>
              </div>
              <p class="ns-hint">
                所有项目、录音与画本都放在这里（<strong>这是唯一允许保存绝对路径的地方</strong>，docs/03 §2）。
                <el-tag size="small" type="warning" effect="plain">重启后生效</el-tag>
              </p>
            </el-form-item>

            <el-form-item label="导出目录" :class="{ 'ns-field--hl': isHl('paths.exportDir') }" data-anchor="paths.exportDir">
              <div class="ns-inline">
                <el-input v-model="s.paths.exportDir" class="ns-input" @change="savePathField('exportDir')" />
                <el-button @click="pickFolder('exportDir', '选择导出目录')">选择目录</el-button>
                <el-button :disabled="!s.paths.exportDir" @click="reveal(s.paths.exportDir)">打开</el-button>
              </div>
              <p class="ns-hint">导出成品（MP3 / WAV / M4B）的默认目录；导出向导里仍可临时改。</p>
            </el-form-item>

            <el-form-item label="ffmpeg 可执行文件" :class="{ 'ns-field--hl': isHl('paths.ffmpegPath') }" data-anchor="paths.ffmpegPath">
              <div class="ns-inline">
                <el-input
                  v-model="s.paths.ffmpegPath"
                  class="ns-input"
                  placeholder="留空则使用随应用分发的 ffmpeg"
                  @change="savePathField('ffmpegPath')"
                />
                <el-button @click="pickFfmpegPath">选择文件</el-button>
                <el-button :disabled="!s.paths.ffmpegPath" @click="reveal(s.paths.ffmpegPath)">打开</el-button>
              </div>
              <p class="ns-hint">
                <el-tag size="small" :type="ffmpegReady ? 'success' : 'danger'">
                  {{ ffmpegReady ? `已探测到 ffmpeg ${settings.capabilities?.ffmpeg.version ?? ''}` : '未探测到可用的 ffmpeg' }}
                </el-tag>
                自定义路径优先于内置（docs/02 §5.1）。混音与导出依赖 ffmpeg：
                缺失时相关控件会被禁用，能力详情见
                <el-button link type="primary" size="small" @click="gotoSection('diagnostics')">日志与诊断</el-button>。
              </p>
            </el-form-item>

            <el-form-item label="模型目录" :class="{ 'ns-field--hl': isHl('paths.modelDir') }" data-anchor="paths.modelDir">
              <div class="ns-inline">
                <el-input
                  v-model="s.paths.modelDir"
                  class="ns-input"
                  placeholder="留空则使用随应用分发的模型目录"
                  @change="savePathField('modelDir')"
                />
                <el-button @click="pickFolder('modelDir', '选择模型目录')">选择目录</el-button>
                <el-button :disabled="!s.paths.modelDir" @click="reveal(s.paths.modelDir)">打开</el-button>
              </div>
              <p class="ns-hint">
                语义向量与语音识别模型的根目录（whisper / embedding 子目录）。
                <el-tag size="small" type="warning" effect="plain">重启后生效</el-tag>
                模型逐个文件的状态与修复指引在
                <el-button link type="primary" size="small" @click="gotoSection('ai')">AI 分类</el-button>。
              </p>
            </el-form-item>

            <el-form-item label="缓存目录" :class="{ 'ns-field--hl': isHl('paths.cacheDir') }" data-anchor="paths.cacheDir">
              <div class="ns-inline">
                <el-input v-model="s.paths.cacheDir" class="ns-input" @change="savePathField('cacheDir')" />
                <el-button @click="pickFolder('cacheDir', '选择缓存目录')">选择目录</el-button>
                <el-button :disabled="!s.paths.cacheDir" @click="reveal(s.paths.cacheDir)">打开</el-button>
              </div>
              <p class="ns-hint">
                波形峰值、处理链预览、向量缓存的落盘位置，可以随时清理（清理只影响重新计算的速度）。
                建议放在系统盘之外，避免把系统盘写满。
              </p>
            </el-form-item>

            <el-form-item label="备份目录" :class="{ 'ns-field--hl': isHl('paths.backupDir') }" data-anchor="paths.backupDir">
              <div class="ns-inline">
                <el-input v-model="s.paths.backupDir" class="ns-input" @change="savePathField('backupDir')" />
                <el-button @click="pickFolder('backupDir', '选择备份目录')">选择目录</el-button>
                <el-button :disabled="!s.paths.backupDir" @click="reveal(s.paths.backupDir)">打开</el-button>
              </div>
              <p class="ns-hint">
                数据库备份文件的存放位置；备份策略与恢复在
                <el-button link type="primary" size="small" @click="gotoSection('backup')">备份分类</el-button>。
              </p>
            </el-form-item>

            <!-- 实际生效值：来自 app:getPaths，是主进程**真正**在用的路径 -->
            <div class="ns-panel">
              <h3 class="ns-panel__title">实际生效路径（app:getPaths）</h3>
              <p class="ns-panel__note">
                这是主进程当前真正使用的路径，可能与上面的设置不同（未设置时回落默认值、便携版会重定向到程序目录）。
              </p>
              <dl v-if="pathsInfo" class="ns-kv">
                <div class="ns-kv__row"><dt>用户数据目录</dt><dd><span class="ns-mono">{{ pathsInfo.userData }}</span><el-button size="small" link @click="reveal(pathsInfo.userData)">打开</el-button></dd></div>
                <div class="ns-kv__row"><dt>项目根目录</dt><dd><span class="ns-mono">{{ pathsInfo.projectRoot }}</span><el-button size="small" link @click="reveal(pathsInfo.projectRoot)">打开</el-button></dd></div>
                <div class="ns-kv__row"><dt>导出目录</dt><dd><span class="ns-mono">{{ pathsInfo.exportDir }}</span><el-button size="small" link @click="reveal(pathsInfo.exportDir)">打开</el-button></dd></div>
                <div class="ns-kv__row"><dt>缓存目录</dt><dd><span class="ns-mono">{{ pathsInfo.cacheDir }}</span><el-button size="small" link @click="reveal(pathsInfo.cacheDir)">打开</el-button></dd></div>
                <div class="ns-kv__row"><dt>日志目录</dt><dd><span class="ns-mono">{{ pathsInfo.logDir }}</span><el-button size="small" link @click="reveal(pathsInfo.logDir)">打开</el-button></dd></div>
                <div class="ns-kv__row"><dt>备份目录</dt><dd><span class="ns-mono">{{ pathsInfo.backupDir }}</span><el-button size="small" link @click="reveal(pathsInfo.backupDir)">打开</el-button></dd></div>
                <div class="ns-kv__row"><dt>模型目录</dt><dd><span class="ns-mono">{{ pathsInfo.modelDir }}</span><el-button size="small" link @click="reveal(pathsInfo.modelDir)">打开</el-button></dd></div>
                <div class="ns-kv__row"><dt>资源目录</dt><dd><span class="ns-mono">{{ pathsInfo.resourceDir }}</span><el-button size="small" link @click="reveal(pathsInfo.resourceDir)">打开</el-button></dd></div>
              </dl>
              <p v-else class="ns-panel__note">正在读取…</p>
            </div>

            <!-- 导入上限：消息表里 FILE_TOO_LARGE / ENCODING_UNCERTAIN 指向「设置 -> 导入」，
                 本页把它放在「路径」分类下（同一个文件域），避免多出一个顶层分类。 -->
            <div class="ns-panel" data-anchor="import.maxFileSizeBytes">
              <h3 class="ns-panel__title">导入上限</h3>
              <el-form-item label="单文件大小上限" :class="{ 'ns-field--hl': isHl('import.maxFileSizeBytes') }">
                <el-input-number
                  v-model="s.import.maxFileSizeBytes"
                  :min="1048576"
                  :max="4294967296"
                  :step="1048576"
                  controls-position="right"
                  @change="saveGroup('import')"
                />
                <span class="ns-unit">字节（≈ {{ formatBytes(s.import.maxFileSizeBytes) }}；默认 200 MB）</span>
                <p class="ns-hint">超过上限的文件会被拒绝导入（提示里会带上本文档的上限值）。</p>
              </el-form-item>

              <el-form-item label="网址抓取页数上限" :class="{ 'ns-field--hl': isHl('import.maxUrlPages') }" data-anchor="import.maxUrlPages">
                <el-input-number
                  v-model="s.import.maxUrlPages"
                  :min="1"
                  :max="500"
                  controls-position="right"
                  @change="saveGroup('import')"
                />
                <span class="ns-unit">页（默认 50）</span>
              </el-form-item>

              <el-form-item label="抓取间隔" :class="{ 'ns-field--hl': isHl('import.fetchDelayMs') }" data-anchor="import.fetchDelayMs">
                <el-input-number
                  v-model="s.import.fetchDelayMs"
                  :min="200"
                  :max="10000"
                  :step="100"
                  controls-position="right"
                  @change="saveGroup('import')"
                />
                <span class="ns-unit">毫秒（默认 1500）：礼貌抓取，调小容易被站点拒绝</span>
              </el-form-item>
            </div>
          </template>

          <!-- ============ 音频 ============ -->
          <template v-else-if="active === 'audio'">
            <h2 class="ns-section__title">音频</h2>
            <p class="ns-section__note">
              这一组影响**新录音的采集与落盘**：改采样率/位深不会重采样已有文件，
              旧素材保持原样（docs/05 §12）。
            </p>

            <el-form-item label="采样率" :class="{ 'ns-field--hl': isHl('audio.sampleRate') }" data-anchor="audio.sampleRate">
              <el-select v-model="s.audio.sampleRate" class="ns-input" @change="saveGroup('audio')">
                <el-option label="44100 Hz（CD 规格，导出 MP3 常用）" :value="44100" />
                <el-option label="48000 Hz（推荐，与视频/ffmpeg 默认一致）" :value="48000" />
              </el-select>
              <p class="ns-hint">{{ sampleRateHint }}</p>
            </el-form-item>

            <el-form-item label="位深" :class="{ 'ns-field--hl': isHl('audio.bitDepth') }" data-anchor="audio.bitDepth">
              <el-select v-model="s.audio.bitDepth" class="ns-input" @change="saveGroup('audio')">
                <el-option label="16 bit（体积最小）" :value="16" />
                <el-option label="24 bit（推荐：动态余量充足）" :value="24" />
                <el-option label="32 bit 浮点（可救增益失误，体积最大）" :value="32" />
              </el-select>
              <p class="ns-hint">{{ bitDepthHint }}</p>
            </el-form-item>

            <el-form-item label="通道数">
              <el-tag type="info" effect="plain">单声道（channels = 1）</el-tag>
              <p class="ns-hint">
                有声书采集固定单声道：双声道只会让文件翻倍，而且「两个通道录什么」在业务上是歧义的
                （真正的立体声要留到混音阶段）。设置里保留该字段以便兼容既有工程，但不提供切换入口。
              </p>
              <p v-if="s.audio.channels !== 1" class="ns-hint ns-hint--warn">
                当前工程记录的通道数是 {{ s.audio.channels }}（由旧版本或外部工具写入），建议改回单声道。
              </p>
            </el-form-item>

            <el-form-item label="默认输入设备" :class="{ 'ns-field--hl': isHl('audio.defaultInputDeviceId') }" data-anchor="audio.defaultInputDeviceId">
              <div class="ns-inline">
                <el-select
                  v-model="s.audio.defaultInputDeviceId"
                  class="ns-input"
                  :disabled="inputDevices.length === 0"
                  @change="saveGroup('audio')"
                >
                  <el-option label="跟随系统默认设备" :value="FOLLOW_SYSTEM_DEVICE" />
                  <el-option
                    v-for="device in inputDevices"
                    :key="device.deviceId"
                    :label="device.isDefault ? `${device.label}（系统默认）` : device.label"
                    :value="device.deviceId"
                  />
                </el-select>
                <el-button :loading="devicesBusy" @click="loadDevices">重新检测</el-button>
                <el-button @click="router.push('/recording/diagnostics')">设备自检</el-button>
              </div>
              <p class="ns-hint">
                <template v-if="inputDevices.length">
                  共 {{ inputDevices.length }} 个输入设备；主进程记录的偏好设备：{{ preferredDeviceId || '（未记录）' }}。
                </template>
                <template v-else>
                  没有检测到输入设备，下拉已禁用：请检查麦克风是否被系统禁音、是否被其他程序独占，
                  或到「设备诊断」跑一次自检（会检测信号、削波与丢帧）。
                </template>
              </p>
            </el-form-item>

            <el-form-item label="输入增益" :class="{ 'ns-field--hl': isHl('audio.inputGainDb') }" data-anchor="audio.inputGainDb">
              <el-slider
                v-model="s.audio.inputGainDb"
                class="ns-slider"
                :min="-24"
                :max="24"
                :step="0.5"
                show-input
                @change="saveGroup('audio')"
              />
              <p class="ns-hint">
                建议把峰值控制在 -12 dBFS ~ -6 dBFS：太低会淹没在底噪里，太高会在激动处削波（不可逆）。
                削波提示由录音页给出，这里只定基线。
              </p>
            </el-form-item>

            <el-form-item label="自动增益（AGC）" :class="{ 'ns-field--hl': isHl('audio.agcEnabled') }" data-anchor="audio.agcEnabled">
              <el-switch v-model="s.audio.agcEnabled" @change="saveGroup('audio')" />
              <p class="ns-hint">
                建议关闭：AGC 会把底噪一起抬上来，切片门限（VAD）与响度判定都会变得不稳定。
                手动设定增益 + 录音页的电平表更可控。
              </p>
            </el-form-item>

            <el-form-item label="监听" :class="{ 'ns-field--hl': isHl('audio.monitorEnabled') }" data-anchor="audio.monitorEnabled">
              <el-switch v-model="s.audio.monitorEnabled" @change="saveGroup('audio')" />
              <span class="ns-unit">录音时把输入回放到耳机</span>
              <p class="ns-hint">
                外放监听会造成啸叫（真机提示会由主进程给出）；监听一律经耳机，并注意监听延迟。
              </p>
            </el-form-item>

            <el-form-item label="监听音量" :class="{ 'ns-field--hl': isHl('audio.monitorGainDb') }" data-anchor="audio.monitorGainDb">
              <el-slider
                v-model="s.audio.monitorGainDb"
                class="ns-slider"
                :min="-24"
                :max="12"
                :step="1"
                show-input
                :disabled="!s.audio.monitorEnabled"
                @change="saveGroup('audio')"
              />
              <p class="ns-hint">只在开启监听时有效；监听音量过高容易形成回声环路。</p>
            </el-form-item>

            <el-form-item label="录音倒计时" :class="{ 'ns-field--hl': isHl('audio.countdownMs') }" data-anchor="audio.countdownMs">
              <el-input-number
                v-model="s.audio.countdownMs"
                :min="0"
                :max="10000"
                :step="500"
                controls-position="right"
                @change="saveGroup('audio')"
              />
              <span class="ns-unit">毫秒（0 = 不倒数；建议 1000~3000 留出吸气时间）</span>
            </el-form-item>

            <el-form-item label="自动修剪" :class="{ 'ns-field--hl': isHl('audio.autoTrim') }" data-anchor="audio.autoTrim">
              <el-switch v-model="s.audio.autoTrim" @change="saveGroup('audio')" />
              <p class="ns-hint">
                停止录音后自动去掉首尾静音，只保留自然收尾（docs/05 §5.3）。
                原始文件始终保留，修剪只影响绑定到画本行的片段。
              </p>
            </el-form-item>

            <el-form-item label="修剪门限" :class="{ 'ns-field--hl': isHl('audio.trimThresholdDb') }" data-anchor="audio.trimThresholdDb">
              <el-input-number
                v-model="s.audio.trimThresholdDb"
                :min="-80"
                :max="-20"
                :step="1"
                controls-position="right"
                :disabled="!s.audio.autoTrim"
                @change="saveGroup('audio')"
              />
              <span class="ns-unit">dBFS（默认 {{ TRIM_DEFAULTS.thresholdDb }}）</span>
            </el-form-item>

            <el-form-item label="修剪留白" :class="{ 'ns-field--hl': isHl('audio.trimPaddingMs') }" data-anchor="audio.trimPaddingMs">
              <el-input-number
                v-model="s.audio.trimPaddingMs"
                :min="0"
                :max="2000"
                :step="10"
                controls-position="right"
                :disabled="!s.audio.autoTrim"
                @change="saveGroup('audio')"
              />
              <span class="ns-unit">
                毫秒（默认首 {{ TRIM_DEFAULTS.headPaddingMs }} / 尾 {{ TRIM_DEFAULTS.tailPaddingMs }}）
                留白太少会吃掉字头爆破音 p/b/t/d
              </span>
            </el-form-item>

            <el-form-item label="回声消除" :class="{ 'ns-field--hl': isHl('audio.echoCancellation') }" data-anchor="audio.echoCancellation">
              <el-switch v-model="s.audio.echoCancellation" @change="saveGroup('audio')" />
              <p class="ns-hint">
                建议关闭：浏览器级回声消除会引入处理延迟与频谱损失，录有声书不需要它；
                只有在必须用扬声器外放监听时才临时打开。
              </p>
            </el-form-item>

            <div class="ns-panel">
              <h3 class="ns-panel__title">采集参数（由主进程固定，不可在此修改）</h3>
              <dl class="ns-kv">
                <div class="ns-kv__row"><dt>采集包大小</dt><dd>{{ AUDIO_DEFAULTS.packMs }} ms（128 帧太小会打满消息队列，50 ms 是延迟与开销的平衡点）</dd></div>
                <div class="ns-kv__row"><dt>元数据冲刷间隔</dt><dd>{{ AUDIO_DEFAULTS.fsyncIntervalMs }} ms（崩溃后据此补 WAV 头）</dd></div>
                <div class="ns-kv__row"><dt>混音分批大小</dt><dd>{{ AUDIO_DEFAULTS.mixBatchSize }}（滤镜图过大会让命令行超长、内存爆）</dd></div>
              </dl>
            </div>
          </template>

          <!-- ============ 录音 ============ -->
          <template v-else-if="active === 'recording'">
            <h2 class="ns-section__title">录音</h2>

            <el-form-item label="默认录音模式" :class="{ 'ns-field--hl': isHl('recording.defaultMode') }" data-anchor="recording.defaultMode">
              <el-select v-model="s.recording.defaultMode" class="ns-input" @change="saveGroup('recording')">
                <el-option
                  v-for="mode in RECORDING_MODES"
                  :key="mode.value"
                  :label="mode.label"
                  :value="mode.value"
                />
              </el-select>
              <p class="ns-hint">
                {{ RECORDING_MODES.find(mode => mode.value === s.recording.defaultMode)?.hint ?? '' }}
                录音页里仍可临时切换模式。
              </p>
            </el-form-item>

            <!-- 按键捕获：聚焦后按键即回填 -->
            <div class="ns-panel" data-anchor="recording.keys">
              <h3 class="ns-panel__title">快捷键</h3>
              <p class="ns-panel__note">
                点一下输入框，然后按下想要的键：允许单键（空格、方向键）与组合键（Ctrl+R、Shift+P）。
                <strong>录音页会接管全局快捷键</strong>，因此这里配的键在其他页面不生效。
              </p>

              <el-form-item
                v-for="item in KEY_FIELDS"
                :key="item.field"
                :label="item.label"
                :class="{ 'ns-field--hl': isHl(`recording.${item.field}`) }"
                :data-anchor="`recording.${item.field}`"
              >
                <div class="ns-inline">
                  <el-input
                    :model-value="formatShortcut(s.recording[item.field])"
                    class="ns-key"
                    readonly
                    :placeholder="activeCaptureField === item.field ? '请按下新键位…' : '点击后按键'"
                    @focus="activeCaptureField = item.field"
                    @blur="activeCaptureField = null"
                    @keydown.prevent="captureKey($event, item.field)"
                  />
                  <el-button @click="resetKeyField(item.field, item.defaultId)">
                    恢复默认（{{ formatShortcut(defaultShortcutOf(item.defaultId)) }}）
                  </el-button>
                </div>
                <p class="ns-hint">{{ item.hint }}</p>
                <p v-if="keyIssue(item.field)" class="ns-hint ns-hint--warn">{{ keyIssue(item.field) }}</p>
              </el-form-item>

              <p v-if="activeCaptureField" class="ns-hint ns-hint--active">
                正在捕获键位（{{ KEY_FIELDS.find(item => item.field === activeCaptureField)?.label }}）：
                按 Esc 取消。
              </p>
              <p v-if="keyError" class="ns-hint ns-hint--warn">{{ keyError }}</p>
            </div>

            <!-- 脚踏板 -->
            <div class="ns-panel" data-anchor="recording.pedal">
              <h3 class="ns-panel__title">脚踏板</h3>
              <el-form-item label="启用脚踏板" :class="{ 'ns-field--hl': isHl('recording.footPedalEnabled') }" data-anchor="recording.footPedalEnabled">
                <el-switch v-model="s.recording.footPedalEnabled" @change="saveGroup('recording')" />
                <p class="ns-hint">
                  脚踏板以键盘设备的形式出现（常见是 F13~F15 或可编程的字母键），
                  因此必须在这里做映射；映射只在启用后生效。
                </p>
              </el-form-item>

              <el-form-item label="动作映射" :class="{ 'ns-field--hl': isHl('recording.footPedalMapping') }" data-anchor="recording.footPedalMapping">
                <div class="ns-pedal">
                  <div v-for="row in pedalRows" :key="row.action" class="ns-pedal__row">
                    <span class="ns-pedal__action">{{ PEDAL_ACTION_LABELS[row.action] ?? row.action }}</span>
                    <el-input
                      :model-value="formatShortcut(row.key)"
                      class="ns-key ns-key--sm"
                      readonly
                      placeholder="点击后踩一下踏板"
                      @keydown.prevent="capturePedalKey($event, row.action)"
                    />
                    <el-button size="small" type="danger" plain @click="removePedalRow(row.action)">移除</el-button>
                  </div>

                  <p v-if="!pedalRows.length" class="ns-panel__note">
                    还没有映射。点下面的「添加动作」开始，例如把「开始 / 停止录音」映射到 F13。
                  </p>

                  <el-button size="small" :disabled="!availablePedalActions.length" @click="addPedalRow">
                    添加动作（{{ availablePedalActions.length }} 个可选）
                  </el-button>

                  <p v-for="conflict in pedalConflicts" :key="conflict.canonical" class="ns-hint ns-hint--warn">
                    映射冲突：{{ conflict.items.map(item => item.label ?? item.id).join(' 与 ') }}
                    都是 {{ conflict.display }}，踩下去时只有一个动作会生效。
                  </p>
                </div>
              </el-form-item>

              <el-form-item label="踏板测试">
                <div class="ns-inline">
                  <el-input
                    class="ns-key"
                    readonly
                    :model-value="pedalTestKey ? formatShortcut(pedalTestKey) : ''"
                    placeholder="点这里，然后踩一下踏板"
                    @keydown.prevent="testPedal($event)"
                  />
                  <span class="ns-unit">{{ pedalTestHint || '用来确认踏板发出的键位与你映射的是否一致' }}</span>
                </div>
              </el-form-item>
            </div>

            <!-- VAD -->
            <div class="ns-panel" data-anchor="recording.vad">
              <h3 class="ns-panel__title">VAD 切片（连续录制时把整段切成行）</h3>
              <p class="ns-panel__note">
                默认值来自 docs/05 §4.2；改动会直接影响「连续录制 + 切片匹配」的结果。
                门限越松（越高）越容易把气声当语音，越紧越容易吃掉字头。
              </p>

              <el-form-item label="启用切片" :class="{ 'ns-field--hl': isHl('recording.vad.enabled') }" data-anchor="recording.vad.enabled">
                <el-switch v-model="s.recording.vad.enabled" @change="saveVad" />
                <span class="ns-unit">关闭后连续录制只能手工切分</span>
              </el-form-item>

              <el-form-item label="静音门限" :class="{ 'ns-field--hl': isHl('recording.vad.silenceDb') }" data-anchor="recording.vad.silenceDb">
                <el-input-number
                  v-model="s.recording.vad.silenceDb"
                  :min="-80"
                  :max="-10"
                  :step="1"
                  controls-position="right"
                  :disabled="!s.recording.vad.enabled"
                  @change="saveVad"
                />
                <span class="ns-unit">dBFS（默认 {{ VAD_DEFAULTS.silenceDb }}）：低于它算静音</span>
              </el-form-item>

              <el-form-item label="最小静音时长" :class="{ 'ns-field--hl': isHl('recording.vad.minSilenceMs') }" data-anchor="recording.vad.minSilenceMs">
                <el-input-number
                  v-model="s.recording.vad.minSilenceMs"
                  :min="50"
                  :max="3000"
                  :step="10"
                  controls-position="right"
                  :disabled="!s.recording.vad.enabled"
                  @change="saveVad"
                />
                <span class="ns-unit">毫秒（默认 {{ VAD_DEFAULTS.minSilenceMs }}）：连续静音超过它才断句，太小会把句内停顿切开</span>
              </el-form-item>

              <el-form-item label="最小语音时长" :class="{ 'ns-field--hl': isHl('recording.vad.minSpeechMs') }" data-anchor="recording.vad.minSpeechMs">
                <el-input-number
                  v-model="s.recording.vad.minSpeechMs"
                  :min="20"
                  :max="1000"
                  :step="10"
                  controls-position="right"
                  :disabled="!s.recording.vad.enabled"
                  @change="saveVad"
                />
                <span class="ns-unit">毫秒（默认 {{ VAD_DEFAULTS.minSpeechMs }}）：短于此的当作噪声丢弃</span>
              </el-form-item>

              <el-form-item label="切片时长范围" :class="{ 'ns-field--hl': isHl('recording.vad.minSliceMs') }" data-anchor="recording.vad.minSliceMs">
                <div class="ns-inline">
                  <el-input-number
                    v-model="s.recording.vad.minSliceMs"
                    :min="50"
                    :max="5000"
                    :step="10"
                    controls-position="right"
                    :disabled="!s.recording.vad.enabled"
                    @change="saveVad"
                  />
                  <span class="ns-unit">~</span>
                  <el-input-number
                    v-model="s.recording.vad.maxSliceMs"
                    :min="1000"
                    :max="120000"
                    :step="1000"
                    controls-position="right"
                    :disabled="!s.recording.vad.enabled"
                    @change="saveVad"
                  />
                  <span class="ns-unit">毫秒（默认 {{ VAD_DEFAULTS.minSliceMs }} ~ {{ VAD_DEFAULTS.maxSliceMs }}）</span>
                </div>
                <p class="ns-hint">超过最大时长的切片会被强制切开，通常意味着画本行过长，建议先拆行。</p>
              </el-form-item>

              <el-form-item label="起点回退" :class="{ 'ns-field--hl': isHl('recording.vad.headRollbackMs') }" data-anchor="recording.vad.headRollbackMs">
                <el-input-number
                  v-model="s.recording.vad.headRollbackMs"
                  :min="0"
                  :max="500"
                  :step="10"
                  controls-position="right"
                  :disabled="!s.recording.vad.enabled"
                  @change="saveVad"
                />
                <span class="ns-unit">毫秒（默认 {{ VAD_DEFAULTS.headRollbackMs }}）：向前多留一点，避免吃掉爆字头</span>
              </el-form-item>

              <el-form-item label="尾部保留" :class="{ 'ns-field--hl': isHl('recording.vad.tailKeepMs') }" data-anchor="recording.vad.tailKeepMs">
                <el-input-number
                  v-model="s.recording.vad.tailKeepMs"
                  :min="0"
                  :max="1000"
                  :step="10"
                  controls-position="right"
                  :disabled="!s.recording.vad.enabled"
                  @change="saveVad"
                />
                <span class="ns-unit">毫秒（默认 {{ VAD_DEFAULTS.tailKeepMs }}）：保留自然收尾的气口</span>
              </el-form-item>

              <el-form-item label="自动噪声底" :class="{ 'ns-field--hl': isHl('recording.vad.autoNoiseFloor') }" data-anchor="recording.vad.autoNoiseFloor">
                <el-switch v-model="s.recording.vad.autoNoiseFloor" @change="saveVad" />
                <p class="ns-hint">
                  开启后按前几秒的环境噪声自动抬高门限（噪声底 + 12 dB）；
                  在空调/风扇环境下更稳，但录音开头若正好有人说话会估错，此时请关掉并手填门限。
                </p>
              </el-form-item>

              <el-form-item label="估算语速" :class="{ 'ns-field--hl': isHl('recording.vad.charsPerSecond') }" data-anchor="recording.vad.charsPerSecond">
                <el-input-number
                  v-model="s.recording.vad.charsPerSecond"
                  :min="1"
                  :max="12"
                  :step="0.1"
                  :precision="1"
                  controls-position="right"
                  @change="saveVad"
                />
                <span class="ns-unit">字/秒（默认 {{ VAD_DEFAULTS.charsPerSecond }}）：只用于估算画本行期望时长与进度</span>
              </el-form-item>
            </div>

            <el-form-item label="单次录音时长上限" :class="{ 'ns-field--hl': isHl('recording.maxSessionMinutes') }" data-anchor="recording.maxSessionMinutes">
              <el-input-number
                v-model="s.recording.maxSessionMinutes"
                :min="1"
                :max="1440"
                controls-position="right"
                @change="saveGroup('recording')"
              />
              <span class="ns-unit">分钟（默认 {{ RECORD_LIMITS.defaultMaxSessionMinutes }}）</span>
              <p class="ns-hint">
                到达上限会自动停止并保存（防止忘了停导致单个 WAV 过大）。
                单条 take 短于 {{ RECORD_LIMITS.minTakeMs }} ms 视为误触会被忽略，
                超过 {{ RECORD_LIMITS.warnTakeMs / 1000 }} 秒会提示确认；
                开始录音前主进程要求至少 {{ formatBytes(RECORD_LIMITS.requiredFreeBytes) }} 可用磁盘空间。
              </p>
            </el-form-item>
          </template>

          <!-- ============ 画本 ============ -->
          <template v-else-if="active === 'canvas'">
            <h2 class="ns-section__title">画本</h2>
            <p class="ns-section__note">
              阈值越松（越低）越容易把旁白判成对白、把 A 角色判成 B 角色；
              越紧则更多行进入待确认队列。改完建议先在一个章节上试生成一次再批量跑。
            </p>

            <el-form-item label="归属判定阈值" :class="{ 'ns-field--hl': isHl('canvas.attributionThreshold') }" data-anchor="canvas.attributionThreshold">
              <el-slider v-model="s.canvas.attributionThreshold" class="ns-slider" :min="0.3" :max="0.95" :step="0.01" show-input @change="saveGroup('canvas')" />
              <p class="ns-hint">相似度低于此值就不判给任何角色，进待确认队列（默认 {{ CANVAS_DEFAULTS.attributionThreshold }}）。</p>
            </el-form-item>

            <el-form-item label="Top1/Top2 最小差值" :class="{ 'ns-field--hl': isHl('canvas.attributionMargin') }" data-anchor="canvas.attributionMargin">
              <el-slider v-model="s.canvas.attributionMargin" class="ns-slider" :min="0" :max="0.3" :step="0.01" show-input @change="saveGroup('canvas')" />
              <p class="ns-hint">两个候选太接近时不自动判定（默认 {{ CANVAS_DEFAULTS.attributionMargin }}）：差值太小说明证据不足。</p>
            </el-form-item>

            <el-form-item label="上下文窗口" :class="{ 'ns-field--hl': isHl('canvas.contextWindow') }" data-anchor="canvas.contextWindow">
              <el-input-number v-model="s.canvas.contextWindow" :min="0" :max="10" controls-position="right" @change="saveGroup('canvas')" />
              <span class="ns-unit">行（默认 {{ CANVAS_DEFAULTS.contextWindow }}）：判定时带上前后各 N 行作为上下文</span>
            </el-form-item>

            <el-form-item label="自动接受置信度" :class="{ 'ns-field--hl': isHl('canvas.autoAcceptConfidence') }" data-anchor="canvas.autoAcceptConfidence">
              <el-slider v-model="s.canvas.autoAcceptConfidence" class="ns-slider" :min="0.5" :max="1" :step="0.01" show-input @change="saveGroup('canvas')" />
              <p class="ns-hint">高于此值才允许「一键确认高置信」（默认 {{ CANVAS_DEFAULTS.autoAcceptConfidence }}）。</p>
            </el-form-item>

            <el-form-item label="默认句末留白" :class="{ 'ns-field--hl': isHl('canvas.defaultPauseAfterMs') }" data-anchor="canvas.defaultPauseAfterMs">
              <el-input-number v-model="s.canvas.defaultPauseAfterMs" :min="0" :max="3000" :step="50" controls-position="right" @change="saveGroup('canvas')" />
              <span class="ns-unit">毫秒（默认 {{ CANVAS_DEFAULTS.defaultPauseAfterMs }}）</span>
              <p class="ns-hint">
                真正落盘的留白仍按标点推断（句号 500 / 感叹问号 450 / 省略号 700 / 段落 900，见 docs/11 §2.3）；
                全局节奏预设：{{ tempoHint }}，可在画本页按章套用，这里只设兜底值。
              </p>
            </el-form-item>

            <el-form-item label="默认情绪" :class="{ 'ns-field--hl': isHl('canvas.defaultEmotion') }" data-anchor="canvas.defaultEmotion">
              <el-select v-model="s.canvas.defaultEmotion" class="ns-input" @change="saveGroup('canvas')">
                <el-option v-for="emotion in EMOTIONS" :key="emotion" :label="emotion" :value="emotion" />
              </el-select>
              <p class="ns-hint">未推断出情绪时的兜底值（默认「{{ CANVAS_DEFAULTS.defaultEmotion }}」）；角色的默认情绪优先。</p>
            </el-form-item>

            <el-form-item label="单行字数上限" :class="{ 'ns-field--hl': isHl('canvas.maxLineChars') }" data-anchor="canvas.maxLineChars">
              <el-input-number v-model="s.canvas.maxLineChars" :min="20" :max="600" :step="10" controls-position="right" @change="saveGroup('canvas')" />
              <span class="ns-unit">字（默认 {{ CANVAS_DEFAULTS.maxLineChars }}）：超过会标记为「过长」，录音时容易忘词</span>
            </el-form-item>

            <el-form-item label="连续旁白告警" :class="{ 'ns-field--hl': isHl('canvas.maxNarrationRun') }" data-anchor="canvas.maxNarrationRun">
              <el-input-number v-model="s.canvas.maxNarrationRun" :min="1" :max="100" controls-position="right" @change="saveGroup('canvas')" />
              <span class="ns-unit">行（默认 {{ CANVAS_DEFAULTS.maxNarrationRun }}）：连续这么多行旁白可疑，多半是漏判了引号</span>
            </el-form-item>

            <el-form-item label="短句阈值" :class="{ 'ns-field--hl': isHl('canvas.shortLineChars') }" data-anchor="canvas.shortLineChars">
              <el-input-number v-model="s.canvas.shortLineChars" :min="1" :max="30" controls-position="right" @change="saveGroup('canvas')" />
              <span class="ns-unit">字（默认 {{ CANVAS_DEFAULTS.shortLineChars }}）：短于此长度不做向量判定（「嗯」「对」这类向量不可靠）</span>
            </el-form-item>
          </template>

          <!-- ============ 混音 ============ -->
          <template v-else-if="active === 'mixing'">
            <h2 class="ns-section__title">混音</h2>

            <el-form-item label="目标响度" :class="{ 'ns-field--hl': isHl('mixing.targetLufs') }" data-anchor="mixing.targetLufs">
              <el-select v-model="s.mixing.targetLufs" class="ns-input" :disabled="loudnessBlocked" @change="saveGroup('mixing')">
                <el-option
                  v-for="item in LOUDNESS_TARGETS"
                  :key="item.id"
                  :label="`${item.label} · LRA ${item.lra}`"
                  :value="item.lufs"
                />
              </el-select>
              <p class="ns-hint">
                可选目标：{{ loudnessHint }}。当前值 {{ formatLufs(s.mixing.targetLufs) }}。
                <template v-if="loudnessBlocked">
                  <el-tag size="small" type="warning">控件已禁用：ffmpeg 缺少 loudnorm 滤镜</el-tag>
                  <el-button link type="primary" size="small" @click="gotoSection('diagnostics')">查看能力探测</el-button>
                </template>
              </p>
            </el-form-item>

            <el-form-item label="真峰上限" :class="{ 'ns-field--hl': isHl('mixing.truePeakDb') }" data-anchor="mixing.truePeakDb">
              <el-input-number
                v-model="s.mixing.truePeakDb"
                :min="-6"
                :max="0"
                :step="0.1"
                :precision="1"
                controls-position="right"
                :disabled="limiterBlocked"
                @change="saveGroup('mixing')"
              />
              <span class="ns-unit">dBTP（默认 {{ EXPORT_DEFAULTS.truePeakDb }}）</span>
              <p class="ns-hint">
                编码后的真峰不能超过 0 dBTP，否则部分播放器会削波；留 -1 是安全余量。
                <template v-if="limiterBlocked">
                  <el-tag size="small" type="warning">控件已禁用：ffmpeg 缺少 alimiter 滤镜</el-tag>
                </template>
              </p>
            </el-form-item>

            <el-form-item label="章首静音" :class="{ 'ns-field--hl': isHl('mixing.headSilenceMs') }" data-anchor="mixing.headSilenceMs">
              <el-input-number v-model="s.mixing.headSilenceMs" :min="0" :max="5000" :step="50" controls-position="right" @change="saveGroup('mixing')" />
              <span class="ns-unit">毫秒（默认 {{ EXPORT_DEFAULTS.headSilenceMs }}）</span>
            </el-form-item>

            <el-form-item label="章尾静音" :class="{ 'ns-field--hl': isHl('mixing.tailSilenceMs') }" data-anchor="mixing.tailSilenceMs">
              <el-input-number v-model="s.mixing.tailSilenceMs" :min="0" :max="10000" :step="100" controls-position="right" @change="saveGroup('mixing')" />
              <span class="ns-unit">毫秒（默认 {{ EXPORT_DEFAULTS.tailSilenceMs }}）：留出「翻页」的呼吸感</span>
            </el-form-item>

            <el-form-item label="音乐默认增益" :class="{ 'ns-field--hl': isHl('mixing.defaultMusicGainDb') }" data-anchor="mixing.defaultMusicGainDb">
              <el-input-number v-model="s.mixing.defaultMusicGainDb" :min="-40" :max="0" :step="0.5" :precision="1" controls-position="right" @change="saveGroup('mixing')" />
              <span class="ns-unit">dB：新加入的 BGM 轨初始音量（人声不动）</span>
            </el-form-item>

            <el-form-item label="闪避深度" :class="{ 'ns-field--hl': isHl('mixing.duckAmountDb') }" data-anchor="mixing.duckAmountDb">
              <el-input-number
                v-model="s.mixing.duckAmountDb"
                :min="0"
                :max="30"
                :step="0.5"
                :precision="1"
                controls-position="right"
                :disabled="duckingBlocked"
                @change="saveGroup('mixing')"
              />
              <span class="ns-unit">dB：有人声时音乐压低多少</span>
              <p v-if="duckingBlocked" class="ns-hint ns-hint--warn">
                控件已禁用：ffmpeg 缺少 sidechaincompress 滤镜，自动闪避无法生效（会自动退化为普通叠加）。
              </p>
            </el-form-item>

            <el-form-item label="闪避启动 / 释放" :class="{ 'ns-field--hl': isHl('mixing.duckAttackMs') }" data-anchor="mixing.duckAttackMs">
              <div class="ns-inline">
                <el-input-number v-model="s.mixing.duckAttackMs" :min="1" :max="500" controls-position="right" :disabled="duckingBlocked" @change="saveGroup('mixing')" />
                <span class="ns-unit">/</span>
                <el-input-number v-model="s.mixing.duckReleaseMs" :min="20" :max="2000" :step="10" controls-position="right" :disabled="duckingBlocked" @change="saveGroup('mixing')" />
                <span class="ns-unit">毫秒（启动太快会「抽气」，释放太慢会压住下一句）</span>
              </div>
            </el-form-item>

            <el-form-item label="跨轨重叠容差" :class="{ 'ns-field--hl': isHl('mixing.maxCrossTrackOverlapMs') }" data-anchor="mixing.maxCrossTrackOverlapMs">
              <el-input-number v-model="s.mixing.maxCrossTrackOverlapMs" :min="0" :max="20000" :step="100" controls-position="right" @change="saveGroup('mixing')" />
              <span class="ns-unit">毫秒（默认 {{ ARRANGE_DEFAULTS.maxCrossTrackOverlapMs }}）：此范围内视为正常对话交叠</span>
            </el-form-item>

            <el-form-item label="最长静音告警" :class="{ 'ns-field--hl': isHl('mixing.maxGapMs') }" data-anchor="mixing.maxGapMs">
              <el-input-number v-model="s.mixing.maxGapMs" :min="500" :max="60000" :step="500" controls-position="right" @change="saveGroup('mixing')" />
              <span class="ns-unit">毫秒（默认 {{ ARRANGE_DEFAULTS.maxGapMs }}）：非章头章尾的静音超过它就告警，多半是缺录了一行</span>
            </el-form-item>
          </template>

          <!-- ============ 导出 ============ -->
          <template v-else-if="active === 'export'">
            <h2 class="ns-section__title">导出</h2>

            <el-form-item label="默认格式" :class="{ 'ns-field--hl': isHl('export.format') }" data-anchor="export.format">
              <el-select v-model="s.export.format" class="ns-input" @change="saveGroup('export')">
                <el-option label="MP3（兼容性最好，适合分发）" value="mp3" :disabled="mp3Blocked" />
                <el-option label="WAV（无损，交付/二次加工用）" value="wav" :disabled="!ffmpegReady" />
                <el-option label="M4A / M4B（带章节，适合有声书）" value="m4a" :disabled="aacBlocked" />
              </el-select>
              <p class="ns-hint">
                <template v-if="mp3Blocked || aacBlocked">
                  灰掉的项是因为当前 ffmpeg 缺少对应编码器：
                  <el-tag v-if="mp3Blocked" size="small" type="warning">缺少 libmp3lame（MP3）</el-tag>
                  <el-tag v-if="aacBlocked" size="small" type="warning">缺少 aac（M4A/M4B）</el-tag>
                </template>
                <template v-else>三种格式的编码器都已就绪。</template>
              </p>
            </el-form-item>

            <el-form-item label="MP3 码率" :class="{ 'ns-field--hl': isHl('export.mp3Bitrate') }" data-anchor="export.mp3Bitrate">
              <el-select v-model="s.export.mp3Bitrate" class="ns-input ns-input--sm" @change="saveGroup('export')">
                <el-option v-for="rate in [128, 192, 256, 320]" :key="rate" :label="`${rate} kbps`" :value="rate" />
              </el-select>
              <span class="ns-unit">默认 {{ EXPORT_DEFAULTS.mp3Bitrate }} kbps；单人朗读 128 已够，音乐多的作品用 192+</span>
            </el-form-item>

            <el-form-item label="M4B 码率" :class="{ 'ns-field--hl': isHl('export.m4bBitrate') }" data-anchor="export.m4bBitrate">
              <el-select v-model="s.export.m4bBitrate" class="ns-input ns-input--sm" @change="saveGroup('export')">
                <el-option v-for="rate in [64, 96, 128, 192]" :key="rate" :label="`${rate} kbps`" :value="rate" />
              </el-select>
              <span class="ns-unit">默认 {{ EXPORT_DEFAULTS.m4bBitrate }} kbps（AAC 比 MP3 更省码率）</span>
            </el-form-item>

            <!-- 命名模板 + 实时预览（docs/15 §5.3 / §5.5） -->
            <div class="ns-panel" data-anchor="export.naming">
              <h3 class="ns-panel__title">文件命名模板</h3>
              <el-form-item label="文件名模板" :class="{ 'ns-field--hl': isHl('export.fileNameTemplate') }">
                <el-input
                  v-model="s.export.fileNameTemplate"
                  class="ns-input ns-input--wide"
                  placeholder="{bookTitle}/{chapterIndex:03}_{chapterTitle}"
                  @change="saveGroup('export')"
                />
                <p class="ns-hint">
                  可用占位符：{bookTitle} {author} {chapterIndex} {chapterIndex:03} {chapterTitle}
                  {volumeTitle} {narrator} {date} {format} {totalChapters}；
                  用 <code>/</code> 分隔可以直接生成子目录。非法字符会被清洗，UTF-8 超过 120 字节会截断。
                </p>
                <p v-if="unknownTokens.length" class="ns-hint ns-hint--warn">
                  未知占位符 {{ unknownTokensHint }}：导出时会**原样保留**，
                  多半是拼错了，请对照上面的列表改掉。
                </p>
              </el-form-item>

              <el-form-item label="命名预览">
                <div class="ns-preview">
                  <p class="ns-preview__note">按示例书《示例书名》的 3 个章节实时预览（第 3 个标题里故意带了 / 和 ?）：</p>
                  <ul class="ns-preview__list">
                    <li v-for="item in filePreview" :key="item.relativePath">
                      <span class="ns-mono">{{ item.relativePath }}</span>
                      <el-tag v-if="item.renamed" size="small" type="warning" effect="plain">重名已加序号</el-tag>
                    </li>
                  </ul>
                </div>
              </el-form-item>

              <el-form-item label="章节标题模板" :class="{ 'ns-field--hl': isHl('export.chapterTitleTemplate') }" data-anchor="export.chapterTitleTemplate">
                <el-input
                  v-model="s.export.chapterTitleTemplate"
                  class="ns-input ns-input--wide"
                  placeholder="第{index}章 {title}"
                  @change="saveGroup('export')"
                />
                <p class="ns-hint">
                  写进音频元数据的章节名（M4B 章节列表、播放器显示）。
                  预览：<strong>{{ chapterTitlePreview }}</strong>
                </p>
              </el-form-item>
            </div>

            <el-form-item label="写入元数据" :class="{ 'ns-field--hl': isHl('export.writeMetadata') }" data-anchor="export.writeMetadata">
              <el-switch v-model="s.export.writeMetadata" @change="saveGroup('export')" />
              <p class="ns-hint">书名、作者、朗读人、封面、章节列表；关闭后播放器里只会显示文件名。</p>
            </el-form-item>

            <el-form-item label="封面图片" :class="{ 'ns-field--hl': isHl('export.coverPath') }" data-anchor="export.coverPath">
              <div class="ns-inline">
                <el-input v-model="s.export.coverPath" class="ns-input" placeholder="留空则不写入封面" @change="saveGroup('export')" />
                <el-button @click="pickCoverPath">选择图片</el-button>
                <el-button :disabled="!s.export.coverPath" @click="reveal(s.export.coverPath)">打开</el-button>
                <el-button :disabled="!s.export.coverPath" @click="clearCoverPath">清除</el-button>
              </div>
              <p class="ns-hint">建议 JPEG / PNG；封面过大（> 2 MB）会让部分播放器加载变慢。</p>
            </el-form-item>

            <el-form-item label="M4B 每卷章数" :class="{ 'ns-field--hl': isHl('export.splitM4bEvery') }" data-anchor="export.splitM4bEvery">
              <el-input-number v-model="s.export.splitM4bEvery" :min="0" :max="500" controls-position="right" @change="saveGroup('export')" />
              <span class="ns-unit">章（0 = 不拆分）</span>
              <p class="ns-hint" :class="{ 'ns-hint--warn': m4bSplitWarning }">
                超过 {{ EXPORT_DEFAULTS.m4bChapterWarnThreshold }} 章时，部分播放器的章节列表会异常
                （跳章错位、只显示前若干章），建议按卷或每 100~200 章拆成一个 M4B。
                <template v-if="m4bSplitWarning">
                  当前设置每 {{ s.export.splitM4bEvery }} 章一卷，超过建议阈值，请确认这是有意的。
                </template>
              </p>
            </el-form-item>
          </template>

          <!-- ============ AI ============ -->
          <template v-else-if="active === 'ai'">
            <h2 class="ns-section__title">AI</h2>
            <ProviderSettings :highlight-keys="highlightKeys" @save-state="onChildSaveState" />
            <ModelStatusPanel
              class="ns-settings__sub-panel"
              :models="settings.capabilities?.models ?? []"
              :embedding="settings.capabilities?.embedding ?? null"
              :model-dir="s.paths.modelDir ?? pathsInfo?.modelDir ?? ''"
              :highlight-keys="highlightKeys"
              @refresh="settings.refreshCapabilities()"
              @save-state="onChildSaveState"
            />
          </template>

          <!-- ============ 外观 ============ -->
          <template v-else-if="active === 'appearance'">
            <h2 class="ns-section__title">外观</h2>

            <el-form-item label="主题" :class="{ 'ns-field--hl': isHl('ui.theme') }" data-anchor="ui.theme">
              <el-select v-model="s.ui.theme" class="ns-input ns-input--sm" @change="onThemeChange">
                <el-option v-for="item in THEME_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <p class="ns-hint">
                主题会立即应用到整个界面（写入 &lt;html data-theme&gt;）；「跟随系统」会在系统切换深浅色时自动跟随。
              </p>
            </el-form-item>

            <el-form-item label="界面语言" :class="{ 'ns-field--hl': isHl('ui.language') }" data-anchor="ui.language">
              <el-select v-model="s.ui.language" class="ns-input ns-input--sm" @change="saveGroup('ui')">
                <el-option v-for="item in LANGUAGE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <p class="ns-hint">错误提示与术语表跟随语言设置；切换后需要刷新页面才能全部生效。</p>
            </el-form-item>

            <el-form-item label="编辑密度" :class="{ 'ns-field--hl': isHl('ui.editorDensity') }" data-anchor="ui.editorDensity">
              <el-select v-model="s.ui.editorDensity" class="ns-input ns-input--sm" @change="saveGroup('ui')">
                <el-option
                  v-for="item in DENSITY_OPTIONS"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
              <p class="ns-hint">{{ DENSITY_OPTIONS.find(item => item.value === s.ui.editorDensity)?.hint ?? '' }}</p>
            </el-form-item>
          </template>

          <!-- ============ 日志与诊断 ============ -->
          <template v-else-if="active === 'diagnostics'">
            <h2 class="ns-section__title">日志与诊断</h2>
            <DiagnosticsPanel
              :paths="pathsInfo"
              :highlight-keys="highlightKeys"
              @refresh="settings.refreshCapabilities()"
              @save-state="onChildSaveState"
            />
          </template>

          <!-- ============ 备份 ============ -->
          <template v-else>
            <h2 class="ns-section__title">备份</h2>
            <BackupPanel
              :backup-dir="s.paths.backupDir || pathsInfo?.backupDir || ''"
              :highlight-keys="highlightKeys"
              @save-state="onChildSaveState"
            />
          </template>
        </el-form>
      </section>
    </div>

    <!-- ── 底部：保存状态与重置 ─────────────────────────────────────── -->
    <footer class="ns-settings__foot">
      <AutoSaveIndicator
        :status="saveStatus"
        :saved-at="savedAt"
        :error-text="saveError"
        @retry="retrySave"
        @revert="revertSave"
      />
      <div class="ns-settings__foot-actions">
        <el-button size="small" :loading="settings.saving" @click="reloadSettings">放弃修改并重新读取</el-button>
        <el-button size="small" type="warning" plain @click="openReset('section')">恢复本分类默认</el-button>
      </div>
    </footer>

    <ConfirmDialog
      v-model="resetVisible"
      type="danger"
      :title="resetTitle"
      message="恢复默认只会改设置项，不会动你的作品数据。"
      :details="resetDetails"
      confirm-keyword="恢复默认"
      confirm-text="恢复默认"
      :loading="resetBusy"
      @confirm="confirmReset"
    />
  </div>
</template>

<style scoped>
.ns-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}
.ns-settings__head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
}
.ns-settings__heading {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 20px;
}
.ns-settings__sub {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-settings__head-actions {
  display: flex;
  gap: 8px;
}

/* focus 说明条：颜色随 severity 变化（info/warning/error/fatal） */
.ns-focus {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 12px;
  border-left: 4px solid var(--ns-primary, #409eff);
  border-radius: 6px;
  background: rgb(64 158 255 / 10%);
}
.ns-focus--warning {
  border-left-color: var(--ns-warning, #e6a23c);
  background: rgb(230 162 60 / 12%);
}
.ns-focus--error,
.ns-focus--fatal {
  border-left-color: var(--ns-danger, #f56c6c);
  background: rgb(245 108 108 / 12%);
}
.ns-focus--muted {
  border-left-color: var(--ns-text-secondary, #909399);
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-focus__title {
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-focus__detail,
.ns-focus__hint {
  margin: 4px 0 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
}
.ns-focus__hint {
  color: var(--ns-text-secondary, #909399);
}

.ns-settings__body {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.ns-settings__nav {
  display: flex;
  flex: 0 0 236px;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
  position: sticky;
  top: 0;
}
.ns-settings__nav-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 7px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ns-settings__nav-item:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-settings__nav-item.is-active {
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}
.ns-settings__nav-icon {
  width: 18px;
  flex: 0 0 auto;
  text-align: center;
}
.ns-settings__nav-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ns-settings__nav-text small {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.4;
}
.ns-settings__form {
  flex: 1;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-settings__sub-panel {
  margin-top: 14px;
}
.ns-section__title {
  margin: 0 0 8px;
  color: var(--ns-text-primary, #303133);
  font-size: 16px;
}
.ns-section__note {
  margin: 0 0 12px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-panel {
  margin: 6px 0 18px;
  padding: 10px 12px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-panel__title {
  margin: 0 0 6px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-panel__note {
  margin: 0 0 8px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  width: 100%;
}
.ns-input {
  width: 380px;
  max-width: 100%;
}
.ns-input--sm {
  width: 200px;
}
.ns-input--wide {
  width: 520px;
  max-width: 100%;
}
.ns-slider {
  width: 420px;
  max-width: 100%;
}
.ns-key {
  width: 240px;
  font-family: ui-monospace, Consolas, monospace;
}
.ns-key--sm {
  width: 170px;
}
.ns-unit {
  margin-left: 10px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-hint {
  width: 100%;
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-hint--warn {
  color: var(--ns-warning, #e6a23c);
}
.ns-hint--active {
  color: var(--ns-primary, #409eff);
}
.ns-field--hl :deep(.el-form-item__label) {
  color: var(--ns-primary, #409eff);
}
.ns-field--hl {
  border-radius: 6px;
  outline: 2px solid rgb(64 158 255 / 45%);
  outline-offset: 2px;
  background: rgb(64 158 255 / 6%);
}
.ns-kv {
  margin: 0;
}
.ns-kv__row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.7;
}
.ns-kv__row dt {
  flex: 0 0 120px;
  color: var(--ns-text-secondary, #909399);
}
.ns-kv__row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ns-text-regular, #606266);
  word-break: break-all;
}
.ns-mono {
  font-family: ui-monospace, Consolas, monospace;
}
.ns-pedal {
  width: 100%;
}
.ns-pedal__row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.ns-pedal__action {
  flex: 0 0 150px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
.ns-preview {
  width: 100%;
}
.ns-preview__note {
  margin: 0 0 6px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-preview__list {
  margin: 0;
  padding-left: 18px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.9;
}
.ns-settings__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
  position: sticky;
  bottom: 0;
}
.ns-settings__foot-actions {
  display: flex;
  gap: 8px;
}
</style>
