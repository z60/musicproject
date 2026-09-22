<!--
  Novel Studio · 录音主界面（三种模式共用外壳，docs/12 §3.1 / §4.1 / §6.1 / §8.2 / §9 / §10）
  ============================================================================
  · 布局与录制循环（§3.1/§3.2）：顶状态与进度、左当前行与上下文、中波形+电平、右 take 列表、
    底部走带；行 → 倒计时（设置 audio.countdownMs）→ 采集 → 停录定稿 → 跳下一个未录行。
  · 连续模式（§4.1）同外壳换控制条，停止后跑 VAD 切片并进确认页；磁盘预检（§6.1）用
    requiredFreeBytes，只信主进程上报的 diskFreeBytes；droppedFrames 恒应为 0（§13），
    非 0 即 P0 常驻醒目；单行过长/会话超限告警（§3.3/§12）；补录 pre-roll 2 s（§8.2）。
  · 页面激活接管全局快捷键（§9.3），卸载复位。编排全部在本页，组件只渲染 + 抛事件。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AppSettings, CanvasLine, Character, RecordingMode, Take } from '@shared/types.ts'
import { RECORD_LIMITS, VAD_DEFAULTS } from '@shared/constants.ts'
import { AppError } from '@shared/errors.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { reportError } from '@/shared/lib/error-bus.ts'
import {
  UNKNOWN, formatBytes, formatDb, formatDuration, formatInt, formatProgressRatio,
} from '@/shared/lib/format.ts'
import { mediaUrlWithCacheBust, segmentUrl } from '@/shared/lib/media-url.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import LevelMeter from '@/shared/ui/LevelMeter.vue'
import ContinuousControls from '../components/ContinuousControls.vue'
import CountdownOverlay from '../components/CountdownOverlay.vue'
import LinePromptCard from '../components/LinePromptCard.vue'
import LiveWaveform from '../components/LiveWaveform.vue'
import MonitorPanel from '../components/MonitorPanel.vue'
import ShortcutHelper from '../components/ShortcutHelper.vue'
import TakeCompareDialog from '../components/TakeCompareDialog.vue'
import TakeFlagsPanel from '../components/TakeFlagsPanel.vue'
import TakeList from '../components/TakeList.vue'
import TransportBar from '../components/TransportBar.vue'
import { useMonitor } from '../composables/useMonitor.ts'
import { usePedal } from '../composables/usePedal.ts'
import { useRecordCountdown } from '../composables/useRecordCountdown.ts'
import { useRecorder } from '../composables/useRecorder.ts'
import { useShortcuts } from '../composables/useShortcuts.ts'
import { useContinuousStore } from '../stores/continuous.store.ts'
import { useDeviceStore } from '../stores/device.store.ts'
import { useRecordingStore } from '../stores/recording.store.ts'
import { useTakesStore } from '../stores/takes.store.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useUiStore } from '@/app/store/ui.store.ts'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const settings = useSettingsStore()
const ui = useUiStore()
const recording = useRecordingStore()
const takes = useTakesStore()
const devices = useDeviceStore()
const continuous = useContinuousStore()
const recorder = useRecorder()
const monitor = useMonitor()
/** 子组件 defineExpose 的结构类型（不依赖组件类型推导） */
interface WaveformExposed {
  pushBlock: (samples: Float32Array, sampleRate?: number) => void
  reset: () => void
  /** take 预览（docs/91 §5.2.46 / §5.2.47）：peaks 为 min/max 交替、归一化 [-1,1] */
  showPeaks: (peaks: ArrayLike<number>, totalMs: number) => void
  clearTake: () => void
}
interface TakeListExposed { player: HTMLAudioElement | null; stop: () => void }
const mode = ref<RecordingMode>(route.query.mode === 'continuous' ? 'continuous' : 'line_by_line')
const lines = ref<CanvasLine[]>([])
const characters = ref<Character[]>([])
const loading = ref(false)
const currentIndex = ref(0)
const activeFlags = ref<string[]>([])
const pageNotice = ref('')
const showShortcuts = ref(false)
const compareOpen = ref(false)
const comparePicks = ref<string[]>([])
const confirmDiscard = ref(false)
const autoNext = ref(true)
/** onPcmBlock 的解除函数（卸载必须调用，否则采集块会继续推给已销毁的波形组件） */
let offPcm: (() => void) | null = null
const waveformRef = ref<WaveformExposed | null>(null)
const takeListRef = ref<TakeListExposed | null>(null)
const PRE_ROLL_MS = 2000
const POST_ROLL_MS = 1000
const punchTakeId = ref<string | null>(null)
const punchInMs = ref(0)
const punchOutMs = ref(0)
const currentLine = computed<CanvasLine | null>(() => lines.value[currentIndex.value] ?? null)
const prevLine = computed<CanvasLine | null>(() => (currentIndex.value > 0 ? lines.value[currentIndex.value - 1] ?? null : null))
const nextLine = computed<CanvasLine | null>(() => lines.value[currentIndex.value + 1] ?? null)
const charsPerSecond = computed(() => settings.recording?.vad?.charsPerSecond ?? VAD_DEFAULTS.charsPerSecond)
const deviceOptions = computed(() => devices.inputs)
const characterNames = computed(() => new Map(characters.value.map(character => [character.id, character])))
function speakerNameOf(line: CanvasLine | null): string {
  if (!line || line.speakerType === 'narration') return '旁白'
  if (line.characterId) return characterNames.value.get(line.characterId)?.name ?? '未知角色'
  return '未指定角色'
}
const lineProgressText = computed(() => (lines.value.length ? `${currentIndex.value + 1}/${lines.value.length}` : ''))
const recordedLineCount = computed(() => lines.value.filter(line => (takes.byLine[line.id] ?? []).length > 0).length)
const currentTakes = computed<Take[]>(() => (currentLine.value ? takes.takesOf(currentLine.value.id) : []))
const visibleTakes = computed<Take[]>(() => (currentLine.value ? takes.visibleOf(currentLine.value.id) : []))
const selectedTake = computed<Take | null>(() => (currentLine.value ? takes.selectedOf(currentLine.value.id) : null))
const currentPunchTake = computed<Take | null>(() => (punchTakeId.value ? takes.findTake(punchTakeId.value) : null))
/** 磁盘预检与会话告警（docs/12 §6.1 / §3.3 / §12）：告警里空串 = 不显示 */
const requiredFreeBytes = RECORD_LIMITS.requiredFreeBytes
const diskKnown = computed(() => recording.diskFreeBytes > 0)
const diskOk = computed(() => !diskKnown.value || recording.diskFreeBytes >= requiredFreeBytes)
const diskText = computed(() => {
  if (!diskKnown.value) return `磁盘空间尚未上报：开始录音时主进程会预检（要求至少 ${formatBytes(requiredFreeBytes)} 可用）。`
  if (diskOk.value) return `磁盘可用 ${formatBytes(recording.diskFreeBytes)}（要求 ≥ ${formatBytes(requiredFreeBytes)}）`
  return `磁盘可用 ${formatBytes(recording.diskFreeBytes)}，还差 ${formatBytes(requiredFreeBytes - recording.diskFreeBytes)}：请先清理空间，否则长录音会中途写失败。`
})
const maxSessionMinutes = computed(() => settings.recording?.maxSessionMinutes ?? RECORD_LIMITS.defaultMaxSessionMinutes)
const warningTexts = computed(() => [
  !diskKnown.value ? '主进程尚未上报可用空间：record:prepare 会再检查一次，并把结论放进会话告警。' : '',
  recording.warnings.length ? `主进程预检告警：${recording.warnings.join('；')}` : '',
  recording.isRecording && recording.durationMs > RECORD_LIMITS.warnTakeMs
    ? `本行已录 ${formatDuration(recording.durationMs)}（超过 ${formatDuration(RECORD_LIMITS.warnTakeMs)}）：多半是忘了停，停止时会再次确认（docs/12 §3.3）。` : '',
  recording.durationMs > maxSessionMinutes.value * 60_000 * 0.9
    ? `会话接近时长上限（${formatInt(maxSessionMinutes.value)} 分钟），请及时停止并保存。` : '',
  recording.clipFlagRecommended
    ? `削波事件已累计 ${formatInt(recording.clipEvents)} 次（> 20）：建议降低增益重录，停止后可在右侧给该 take 打「削波」标记（docs/05 §2.5）。` : '',
].filter(Boolean))
async function loadAll(): Promise<void> {
  const chapterId = session.chapterId
  if (!chapterId) return
  loading.value = true
  try {
    const [page, chars] = await Promise.all([
      call('canvas:getChapter', { chapterId }),
      session.bookId ? callSafe('character:list', { bookId: session.bookId }) : Promise.resolve(null),
    ])
    lines.value = page.lines ?? []
    characters.value = chars ?? []
  } finally { loading.value = false }
  // 起录时定位到第一个未录行（docs/12 §3.3）
  const firstUnrecorded = lines.value.findIndex(line => (takes.byLine[line.id] ?? []).length === 0)
  currentIndex.value = firstUnrecorded > 0 ? firstUnrecorded : 0
}
watch(currentLine, (line) => {
  if (!line) return
  recording.setLine(line.id)
  void takes.loadByLine(line.id)
})

// ── take 预览波形（docs/91 §5.2.46 / §5.2.47）────────────────────────────────
// 未录音时，波形区显示 take（试录版本）的整段波形；没有 take 时为空。
// 数据来源必须是主进程的 `analysis:peaks`（契约：min/max 交替、归一化 [-1,1]）——
// 渲染进程 CSP 是 `connect-src 'self'`，`fetch('ns-media://…')` 会被拦掉（docs/91 §5.2.47）。
//
// 「刚录完的那一段」用 `pinnedTakeId` 钉住：停止后即使 autoNext 自动跳到了下一行，
// 波形区也继续显示刚录的 take；**用户主动改行**（下一行/上一行/跳过）时才解除并跟随新行。
let pinnedTakeId: string | null = null
function releasePinnedTake(): void {
  pinnedTakeId = null
}
const TAKE_PEAKS_PER_SEC = 100
async function loadTakePeaks(take: Take): Promise<void> {
  try {
    const result = await callSafe('analysis:peaks', { path: take.filePath, peaksPerSec: TAKE_PEAKS_PER_SEC })
    const peaks = result?.peaks
    if (!peaks?.length) { waveformRef.value?.clearTake(); return }
    const totalPeaks = result?.totalPeaks ?? Math.floor(peaks.length / 2)
    // 时间轴右端 = 桶数 / 每秒桶数（与传进来的 peaks 自洽）
    waveformRef.value?.showPeaks(peaks, Math.max(1, Math.round((totalPeaks / TAKE_PEAKS_PER_SEC) * 1000)))
  } catch {
    // 文件缺失/读取失败：回到空态（试听那条路会由 TakeList 走 error-bus 提示）
    waveformRef.value?.clearTake()
  }
}
/** 显示某条 take 的波形并钉住它（停止后调用） */
async function showAndPinTake(take: Take): Promise<void> {
  pinnedTakeId = take.id
  await loadTakePeaks(take)
}
watch([currentLine, selectedTake], ([line, take]) => {
  if (recording.isRecording || recording.isPaused) return
  // 钉住的刚录 take：自动跳行不清、不换（只有用户主动改行才解除）
  if (pinnedTakeId && take?.id !== pinnedTakeId) return
  if (!take || !line) { waveformRef.value?.clearTake(); return }
  void loadTakePeaks(take)
})
/** 录音中禁止改行（会误导，docs/12 §3.3）；返回 false 时已把原因写进页面提示 */
function canJump(): boolean {
  if (recording.canNavigateLines) return true
  pageNotice.value = '录音中不能改行：请先停止本次录音（docs/12 §3.3）。'
  return false
}
function moveLine(delta: number): void {
  if (!canJump()) return
  releasePinnedTake()
  const next = currentIndex.value + delta
  if (next >= 0 && next < lines.value.length) currentIndex.value = next
}
/** 下一行 = 下一个未录行（不是序号 +1），避免在已录区域反复跳（docs/12 §3.3） */
function nextUnrecordedLine(): void {
  if (!canJump()) return
  for (let i = currentIndex.value + 1; i < lines.value.length; i++) {
    if ((takes.byLine[lines.value[i]!.id] ?? []).length === 0) { currentIndex.value = i; return }
  }
  moveLine(1)
}
function skipLine(): void {
  moveLine(1)
  pageNotice.value = '已跳过该行（本轮跳过不改变画本状态，可回头再录）。'
}
/** 修剪参数取设置（docs/04 §8.2）；录音流程：prepare → start → stop */
function trimOptions() {
  const audio = settings.audio
  return {
    enabled: audio?.autoTrim ?? true, thresholdDb: audio?.trimThresholdDb ?? -45,
    headPaddingMs: audio?.trimPaddingMs ?? 100, tailPaddingMs: audio?.trimPaddingMs ?? 120,
  }
}
async function prepareSession(): Promise<boolean> {
  const projectId = session.projectId
  if (!projectId) { pageNotice.value = '没有可用的项目：请先在书架里打开一本书。'; return false }
  if (!diskOk.value) { pageNotice.value = '磁盘空间不足，已阻止开始录音。'; return false }
  const lineId = mode.value === 'continuous' ? null : currentLine.value?.id ?? null
  const result = await recorder.prepare({
    projectId, chapterId: session.chapterId, mode: mode.value, lineId, actorId: session.actorId ?? null,
    deviceId: devices.preferredId ?? settings.audio?.defaultInputDeviceId ?? null,
  })
  if (!result) return false
  recording.setSession(result.sessionId, mode.value, session.chapterId, result.warnings ?? [])
  // 连续模式把会话交给切片 store（停止后的切片/匹配都挂在它上面）
  if (mode.value === 'continuous') continuous.setSession(result.sessionId)
  return true
}
async function beginRecording(): Promise<void> {
  // 开始新的一段：解除"刚录 take"的钉住，波形交回实时流
  releasePinnedTake()
  if (await prepareSession()) await recorder.start()
}
/**
 * 倒计时（docs/12 §3.2）：逻辑在 `useRecordCountdown` 里（只此一份，可单测）。
 * **归零后必须真的开始录音** —— 真机事故（docs/91 §5.2.37）就是这里只关遮罩不开录。
 */
const countdown = useRecordCountdown({ onElapsed: () => { void beginRecording() } })
const countdownVisible = countdown.visible
const countdownSeconds = countdown.seconds
function requestRecord(): void {
  if (!diskOk.value) { pageNotice.value = '磁盘空间不足：请清理后重试（预检要求见上方提示）。'; return }
  /**
   * ⚠️ 返回值必须兑现（真机事故 docs/91 §5.2.45）：
   * `countdown.request(0)` 返回 **false = 设置里没有倒计时，调用方要立即开录**。
   * 以前这里忽略了返回值 → 用户把倒计时设为 0（想跳过等待）后，点「录制」**完全没反应**。
   */
  const counting = countdown.request(settings.audio?.countdownMs ?? 0)
  if (!counting) void beginRecording()
}
async function onCountdownCancel(): Promise<void> {
  countdown.cancelAndBegin()
}
/** 录制键的唯一入口：录音中 → 停；暂停中 → 继续；倒计时中 → 立刻开始；否则起录 */
async function toggleRecord(): Promise<void> {
  if (recording.isRecording) { await stopRecording(); return }
  if (recording.isPaused) { await recorder.resume(); return }
  if (countdownVisible.value) { countdown.cancelAndBegin(); return }
  requestRecord()
}
async function stopRecording(): Promise<void> {
  const lineId = mode.value === 'continuous' ? null : currentLine.value?.id ?? null
  const result = await recorder.stop({ lineId, trim: trimOptions() })
  if (!result) return
  recording.setStopResult(result)
  if (result.take) takes.addTake(result.take)
  if (lineId) await takes.loadByLine(lineId)
  if (mode.value === 'continuous') { await openSliceReview(); return }
  if (autoNext.value) nextUnrecordedLine()
  /**
   * 停止后**把刚录的 take 显示到波形区并钉住**（真机反馈 docs/91 §5.2.47：
   * 「点击停止后该段录音没有加载入试录版本」）。
   * 顺序很重要：先让 autoNext 跳行（它会触发 watcher 想清空），再钉住显示，
   * 这样即使自动跳到了下一行，用户仍然能看到刚录完那一段的波形。
   */
  if (result.take) void showAndPinTake(result.take)
}
/** 连续模式停止后：VAD 切片 → 与画本行匹配 → 进确认页（docs/12 §4.3） */
async function openSliceReview(): Promise<void> {
  if (!continuous.sessionId) { pageNotice.value = '没有可确认的连续录制会话。'; return }
  const sliced = continuous.hasResult || (await continuous.runSlice())
  if (sliced && session.chapterId) await continuous.runMatch(session.chapterId)
  void router.push('/recording/continuous')
}
async function redoRecording(): Promise<void> {
  const projectId = session.projectId
  if (!projectId) return
  await recorder.redo({
    projectId, chapterId: session.chapterId, mode: mode.value, actorId: session.actorId ?? null,
    lineId: mode.value === 'continuous' ? null : currentLine.value?.id ?? null,
    deviceId: devices.preferredId ?? null, trim: trimOptions(),
  })
}
function markRecording(): void { recorder.mark('cut'); recording.addMark('cut', recording.durationMs) }
function noteMark(): void { recorder.mark('note'); recording.addMark('note', recording.durationMs) }
/** 「这段重来」标记（N / 踏板 retake_mark）：切片确认时会重点提示 */
function retakeMark(): void {
  recorder.mark('retake')
  recording.addMark('retake', recording.durationMs)
  pageNotice.value = `已在 ${formatDuration(recording.durationMs, { showMs: true })} 处标记「这段重来」，切片确认时会重点提示。`
}
async function discardSession(): Promise<void> {
  confirmDiscard.value = false
  await recorder.abort(false)
  recording.reset()
  continuous.reset()
  pageNotice.value = '本次录音已丢弃（未生成 take）。'
}
// 补录（punch-in，docs/12 §8.2）：pre-roll / post-roll 默认值，区间来自 TakeList 的 punch-range
/** 点走带栏的「补录」：区间默认取当前成品的修剪区间，用户可在 TakeList 展开区里改 */
function openPunchIn(): void {
  const take = selectedTake.value
  if (!take) { pageNotice.value = '补录需要先选中一个 take（预卷要播放原片段才能接上语气）。'; return }
  punchTakeId.value = take.id
  punchInMs.value = take.trimmedInMs
  punchOutMs.value = take.trimmedOutMs
  void startPunchIn()
}
function onPunchRange(payload: { takeId: string; srcInMs: number; srcOutMs: number }): void {
  punchTakeId.value = payload.takeId
  punchInMs.value = payload.srcInMs
  punchOutMs.value = payload.srcOutMs
}
/**
 * 用 TakeList 暴露的**同一个** <audio> 播 take（P 试听与补录 pre-roll 共用，docs/12 §7）：
 * 同时只该有一路试听，且该元素已挂在监听图上，另建一个会绕开监听音量。
 * 取舍：TakeList 的 playingId 不跟踪这里，列表上的「停止」只在用户从列表点试听时出现。
 */
async function playTake(take: Take, fromMs: number): Promise<boolean> {
  const element = takeListRef.value?.player ?? null
  const base = session.projectId ? segmentUrl(session.projectId, take.filePath) : null
  if (!element || !base) return false
  element.src = mediaUrlWithCacheBust(base, take.recordedAt)
  element.currentTime = Math.max(0, fromMs / 1000)
  try {
    await element.play()
    return true
  } catch (error) {
    // 播放失败是真实故障（文件缺失/被移动），按消息表上报（docs/22 §6.2）
    reportError(AppError.of('TAKE_SRC_MISSING', { cause: error }), { event: 'recording.preview.failed' })
    return false
  }
}

/** 试听当前 take（P / docs/12 §9.1） */
async function playCurrentTake(): Promise<void> {
  const take = selectedTake.value ?? currentTakes.value[0] ?? null
  if (take) await playTake(take, take.trimmedInMs)
}

/**
 * 补录（docs/12 §8.2）：建会话与采集图（不立刻开录）→ 播 pre-roll →
 * pre-roll 到点再 start()，用户能听见前一句的尾巴，语气才接得上。
 * 区间来自 TakeList 的 punch-range（它已经提供区间输入），这里只补 pre/post-roll 默认值。
 */
async function startPunchIn(): Promise<void> {
  const take = currentPunchTake.value ?? selectedTake.value
  const lineId = currentLine.value?.id
  if (!take || !lineId) { pageNotice.value = '补录需要先选中一个 take（预卷要播原片段才能接上语气）。'; return }
  if (punchOutMs.value - punchInMs.value < RECORD_LIMITS.minTakeMs) {
    pageNotice.value = `补录区间太短（至少 ${RECORD_LIMITS.minTakeMs} ms）：请在该 take 的展开区里设定补录区间。`
    return
  }
  const sessionId = await recorder.punchIn({
    lineId, srcInMs: punchInMs.value, srcOutMs: punchOutMs.value,
    preRollMs: PRE_ROLL_MS, postRollMs: POST_ROLL_MS,
  })
  if (!sessionId) return
  recording.setSession(sessionId, 'punch_in', session.chapterId, [])
  const played = await playTake(take, Math.max(0, punchInMs.value - PRE_ROLL_MS))
  if (!played) pageNotice.value = '预卷音频不可用（take 文件可能已被移动），已跳过预卷直接开录。'
  else await new Promise<void>((resolve) => setTimeout(resolve, PRE_ROLL_MS))
  takeListRef.value?.player?.pause()
  await recorder.start()
}
/** 试听走监听图（docs/12 §7「监听已有轨道」）；take 与监听设置（docs/12 §7 / docs/05 §11.2） */
function onPlayerReady(element: HTMLAudioElement): void { monitor.attachElement(element) }
async function onSelectTake(takeId: string): Promise<void> {
  const lineId = currentLine.value?.id
  if (lineId) await takes.setSelected(lineId, takeId).catch(() => undefined)
}
function onRemoveTake(takeId: string, hard: boolean): void { void takes.remove(takeId, hard) }
function onFlagTake(takeId: string, flag: string): void { void takes.toggleFlag(takeId, flag) }
function onActiveFlagsChange(flags: string[]): void { activeFlags.value = flags }
function onCombineTakes(takeIds: string[]): void {
  const lineId = currentLine.value?.id
  if (lineId) void takes.combineParts(lineId, takeIds)
}
function onCompare(takeIdA: string, takeIdB: string): void {
  comparePicks.value = [takeIdA, takeIdB]
  compareOpen.value = true
}
watch(() => recording.isRecording, (active) => monitor.setRecordingActive(active))
async function patchAudio(patch: Partial<AppSettings['audio']>): Promise<void> {
  await settings.patch({ audio: patch }).catch(() => undefined)
}
/** 监听开关（顶栏按钮传 !monitor.enabled，面板传自身值，同一入口写设置） */
async function onMonitorEnabled(value: boolean): Promise<void> {
  monitor.setEnabled(value)
  await patchAudio({ monitorEnabled: value })
}
async function onMonitorGain(gainDb: number): Promise<void> {
  monitor.setGainDb(gainDb)
  await patchAudio({ monitorGainDb: gainDb })
}
async function onEchoCancellation(value: boolean): Promise<void> {
  monitor.setEchoCancellation(value)
  await patchAudio({ echoCancellation: value })
}
/**
 * 直通与「录音时自动降低监听」是**会话级运行时开关**：AppSettings.audio 里没有这两个字段，
 * 因此不写设置、不假装持久化。
 */
function onPassThrough(value: boolean): void {
  monitor.setPassThrough(value)
  if (value) pageNotice.value = '已开启麦克风直通：必须戴耳机，否则容易啸叫（docs/12 §7）。'
}
async function onInputGain(event: Event): Promise<void> {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) await patchAudio({ inputGainDb: value })
}
async function onDeviceChange(event: Event): Promise<void> {
  const deviceId = (event.target as HTMLSelectElement).value
  if (!deviceId) return
  const label = devices.devices.find(d => d.deviceId === deviceId)?.label ?? deviceId
  if (await devices.savePreference(deviceId, label)) await patchAudio({ defaultInputDeviceId: deviceId })
}
/** 快捷键与脚踏板（docs/12 §9；动作 id 见 shared/lib/shortcuts.ts） */
/** 走带栏「下一行」按钮（用户主动）→ 先解除刚录 take 的钉住 */
function nextUnrecordedByUser(): void {
  releasePinnedTake()
  nextUnrecordedLine()
}
const nextLineOrJump = (): void => {
  // 用户主动改行 → 解除"刚录 take"的钉住，波形跟随新行（无 take 时清空）
  releasePinnedTake()
  if (mode.value === 'continuous') moveLine(1)
  else nextUnrecordedLine()
}
const shortcutActions: Record<string, () => void> = {
  'record.toggle': () => void toggleRecord(), 'record.toggleAlt': () => void toggleRecord(),
  'record.redo': () => void redoRecording(), 'line.next': nextLineOrJump, 'line.nextAlt': nextLineOrJump,
  'line.prev': () => moveLine(-1), 'line.prevAlt': () => moveLine(-1), 'line.skip': () => skipLine(),
  'record.mark': () => markRecording(), 'continuous.retake': () => retakeMark(),
  'take.play': () => void playCurrentTake(), 'take.undoSelect': () => void takes.undoSelect(),
  'monitor.toggle': () => void onMonitorEnabled(!monitor.enabled.value), 'paragraph.next': () => moveLine(10),
}
const pedalActions: Record<string, () => void> = {
  stop_and_next: () => void stopRecording(), toggle: () => void toggleRecord(),
  redo: () => void redoRecording(), mark: () => markRecording(), retake_mark: () => retakeMark(),
  next_line: () => moveLine(1), prev_line: () => moveLine(-1), skip: () => skipLine(),
}
const shortcuts = useShortcuts({
  onAction: (actionId) => shortcutActions[actionId]?.(),
  isBusy: () => recording.isRecording || recording.isPaused || recording.isFinalizing,
})
const pedal = usePedal({
  onAction: (actionId) => pedalActions[actionId]?.(),
  enabled: () => settings.recording?.footPedalEnabled ?? false,
})
/** 按钮上显示的快捷键提示（唯一来源是 useShortcuts.displayOf，不写死键位） */
const shortcutHints = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {}
  for (const id of [
    'record.toggle', 'record.redo', 'line.next', 'line.prev', 'line.skip', 'take.play',
    'record.mark', 'continuous.retake', 'take.undoSelect', 'monitor.toggle',
  ]) result[id] = shortcuts.displayOf(id)
  return result
})
onMounted(async () => {
  recording.init()
  continuous.init()
  await settings.load()
  void devices.refresh()
  void pedal.start()
  shortcuts.enable()
  ui.setCapturingShortcuts(true)
  // 采集块 → 实时波形（组件不自己做采集，避免两处各建一条图）
  offPcm = recorder.onPcmBlock((samples, sampleRate) => waveformRef.value?.pushBlock(samples, sampleRate))
  monitor.setEnabled(settings.audio?.monitorEnabled ?? false)
  monitor.setGainDb(settings.audio?.monitorGainDb ?? -6)
  if (settings.audio?.agcEnabled) pageNotice.value = '注意：AGC 已启用，会自动改变表演动态（docs/05 §2.5），录音时建议关闭。'
  await loadAll()
  if (currentLine.value) {
    recording.setLine(currentLine.value.id)
    await takes.loadByLine(currentLine.value.id)
  }
})
onBeforeUnmount(() => {
  countdown.stop()
  offPcm?.(); offPcm = null
  pedal.dispose()
  shortcuts.disable()
  ui.setCapturingShortcuts(false)
  monitor.dispose()
  recording.dispose()
  continuous.dispose()
  void recorder.releaseCapture()
})
</script>

<template>
  <div class="ns-rec">
    <!-- 顶部：模式切换 / 章节与行进度 / 设备 / 增益 / 监听（docs/12 §3.1） -->
    <header class="ns-rec__head">
      <div>
        <h2 class="ns-rec__title">{{ session.breadcrumb || '录音' }}</h2>
        <p class="ns-rec__sub">
          行进度 {{ lineProgressText || UNKNOWN }} · 章进度 {{ formatProgressRatio(recordedLineCount, lines.length) }} ·
          {{ recording.isRecording ? '录制中' : recording.isPaused ? '已暂停' : '空闲' }}
          · 已录 {{ formatDuration(recording.durationMs, { showMs: true }) }}
        </p>
      </div>
      <div class="ns-rec__row">
        <button type="button" class="ns-rec__mode" :class="{ 'is-on': mode === 'line_by_line' }"
          :disabled="recording.isRecording || recording.isPaused" @click="mode = 'line_by_line'">逐行</button>
        <button type="button" class="ns-rec__mode" :class="{ 'is-on': mode === 'continuous' }"
          :disabled="recording.isRecording || recording.isPaused" @click="mode = 'continuous'">连续</button>
        <button type="button" class="ns-rec__mode" @click="router.push('/recording/task')">任务包</button>
        <button type="button" class="ns-rec__mode" @click="router.push('/recording/continuous')">切片确认</button>
      </div>
      <div class="ns-rec__row">
        <label class="ns-rec__field"><span>输入设备</span>
          <select class="ns-rec__control" :value="devices.preferredId ?? settings.audio?.defaultInputDeviceId ?? ''"
            @change="onDeviceChange">
            <option value="">跟随系统默认</option>
            <option v-for="device in deviceOptions" :key="device.deviceId" :value="device.deviceId">
              {{ device.label }}{{ device.isDefault ? '（默认）' : '' }}
            </option>
          </select>
        </label>
        <label class="ns-rec__field"><span>输入增益 {{ formatDb(settings.audio?.inputGainDb ?? 0, 0) }}</span>
          <input class="ns-rec__range" type="range" min="-24" max="24" step="1"
            :value="settings.audio?.inputGainDb ?? 0" @change="onInputGain">
        </label>
        <button type="button" class="ns-rec__btn" :title="shortcutHints['monitor.toggle']"
          @click="onMonitorEnabled(!monitor.enabled.value)">
          监听：{{ monitor.enabled.value ? '开' : '关' }}
        </button>
        <button type="button" class="ns-rec__btn" @click="showShortcuts = true">快捷键</button>
        <button type="button" class="ns-rec__btn" @click="router.push('/recording/diagnostics')">设备诊断</button>
      </div>
    </header>

    <!-- 醒目告警区：丢帧是 P0，绝不折叠（docs/12 §13） -->
    <p v-if="recording.hasDroppedFrames" class="ns-rec__p0">
      丢帧 {{ formatInt(recording.droppedFrames) }} 帧：录音会话中的丢帧恒应为 0（docs/12 §13）。
      请立即停止录音，检查设备连接与系统负载后重录；该计数会写进会话元数据。
    </p>
    <p class="ns-rec__disk" :class="{ 'is-low': !diskOk }">{{ diskText }}</p>
    <p v-for="(text, index) in warningTexts" :key="index" class="ns-rec__warn">{{ text }}</p>
    <p v-if="shortcuts.blockedNotice.value" class="ns-rec__note">
      {{ shortcuts.blockedNotice.value }}
      <button type="button" class="ns-rec__link" @click="shortcuts.clearBlockedNotice()">知道了</button>
    </p>
    <p v-if="pageNotice" class="ns-rec__note">{{ pageNotice }}</p>

    <!-- 本章没有画本行时只给一句引导：录音的前提是画本已生成（docs/11） -->
    <p v-if="!loading && !lines.length" class="ns-rec__note">本章还没有画本行：请先在画本编辑页生成画本，再回来录音。</p>

    <!-- 主区：左（当前行）/ 中（波形 + 电平）/ 右（take 列表） -->
    <div v-else class="ns-rec__layout">
      <section class="ns-rec__col">
        <LinePromptCard :line="currentLine" :prev-line="prevLine" :next-line="nextLine"
          :speaker-name="speakerNameOf(currentLine)" :line-progress="lineProgressText" :take-count="currentTakes.length"
          :estimated-duration-ms="currentLine ? Math.round(currentLine.text.length / charsPerSecond * 1000) : null"
          :chars-per-second="charsPerSecond" :has-selected-take="selectedTake !== null" @edit="router.push('/canvas')" />
        <ContinuousControls v-if="mode === 'continuous'" :state="recording.state" :duration-ms="recording.durationMs"
          :marks="recording.marks" :speech-run-count="recorder.meter.speechRunCount.value"
          :silence="recorder.meter.silence.value" :clip-events="recorder.meter.clipEvents.value"
          :slice-available="continuous.hasResult" :analyzing="continuous.analyzing"
          @start="toggleRecord" @stop="stopRecording" @mark="markRecording" @retake="retakeMark"
          @note="noteMark" @discard="confirmDiscard = true" @open-slices="openSliceReview" />      </section>

      <section class="ns-rec__col">
        <LiveWaveform ref="waveformRef" :active="recording.isRecording" :paused="recording.isPaused"
          :sample-rate="recorder.actualSampleRate.value" :duration-ms="recording.durationMs" :height="120"
          :clipping="recorder.meter.clipping.value || recording.clipping" />
        <div class="ns-rec__col">
          <LevelMeter :rms-db="recorder.meter.rmsDb.value" :peak-db="recorder.meter.peakDb.value" :height="14"
            :clipping="recorder.meter.clipping.value" label="输入电平（采集侧）"
            @clear-clip="recorder.meter.clearClip(); recording.clearClip()" />
          <p class="ns-rec__note">
            采集格式 {{ formatInt(recorder.requestedSampleRate.value) }} Hz 请求 /
            {{ formatInt(recorder.actualSampleRate.value) }} Hz 实际 · 已转发 {{ formatInt(recorder.forwardedFrames.value) }} 帧
            <template v-if="recorder.sampleRateMismatch.value">—— 不一致：按实际采样率落盘并重采样（docs/05 §2.1）</template>
          </p>
        </div>
        <MonitorPanel :enabled="monitor.enabled.value" :gain-db="monitor.gainDb.value"
          :pass-through="monitor.passThrough.value" :echo-cancellation="monitor.echoCancellation.value"
          :recording-active="recording.isRecording" :latency-ms="monitor.latencyMs.value"
          :auto-lower-while-recording="monitor.autoLowerWhileRecording.value"
          :feedback-risk="monitor.feedbackRisk.value" :attached-count="monitor.attachedCount.value"
          :capture-ready="recorder.captureState.value === 'ready'" @update:enabled="onMonitorEnabled"
          @update:gain-db="onMonitorGain" @update:pass-through="onPassThrough" @test-tone="monitor.playTestTone"
          @update:echo-cancellation="onEchoCancellation" @open-diagnostics="router.push('/recording/diagnostics')"
          @update:auto-lower-while-recording="monitor.setAutoLower($event)" />
      </section>

      <section class="ns-rec__col">
        <TakeList ref="takeListRef" :takes="visibleTakes" :selected-id="selectedTake?.id ?? null" show-source
          :project-id="session.projectId ?? ''" :loading="takes.loading" :active-flags="activeFlags"
          :punch-in-ms="punchInMs" :punch-out-ms="punchOutMs" @select="onSelectTake" @remove="onRemoveTake"
          :can-combine-parts="currentLine ? takes.canCombineParts(currentLine.id) : false"
          @flag="onFlagTake" @combine="onCombineTakes" @compare="onCompare" @punch-range="onPunchRange"
          @player-ready="onPlayerReady" />
        <TakeFlagsPanel :take="selectedTake ?? (currentTakes[0] ?? null)" :takes="currentTakes"
          :active-flags="activeFlags" @update:active-flags="onActiveFlagsChange" />
        <button type="button" class="ns-rec__btn" :disabled="!selectedTake" @click="openPunchIn">补录选中 take（pre-roll 2 s / post-roll 1 s）</button>
      </section>
    </div>

    <!-- 底部走带（逐行模式） -->
    <TransportBar v-if="mode === 'line_by_line'" :state="recording.state" :mode="mode" :auto-next="autoNext"
      :duration-ms="recording.durationMs" :line-progress="lineProgressText" :disk-low="!diskOk"
      :take-count="currentTakes.length" :has-selected-take="selectedTake !== null" :shortcuts="shortcutHints"
      :countdown-ms="settings.audio?.countdownMs ?? 0" :can-punch-in="selectedTake !== null"
      :has-punch-range="punchOutMs > punchInMs" @record="toggleRecord" @stop="stopRecording" @skip="skipLine"
      @pause="recorder.pause" @resume="recorder.resume" @prev="moveLine(-1)" @next="nextUnrecordedByUser"
      @redo="redoRecording" @mark="markRecording" @punch-in="openPunchIn" @help="showShortcuts = true"
      @update:countdown-ms="patchAudio({ countdownMs: $event })" @update:auto-next="autoNext = $event" />

    <!-- 预卷与试听共用 TakeList 的播放元素（已挂监听图），因此这里不需要额外 <audio> -->
    <TakeCompareDialog v-model="compareOpen" :project-id="session.projectId ?? ''" @select="onSelectTake"
      :takes="comparePicks.length ? currentTakes.filter(t => comparePicks.includes(t.id)) : currentTakes" />
    <ShortcutHelper v-model="showShortcuts" />
    <ConfirmDialog v-model="confirmDiscard" title="丢弃本次录音？" type="warning" confirm-text="丢弃"
      message="未定稿的会话文件会被删除；已生成的 take 不受影响。" @confirm="discardSession" />
    <CountdownOverlay :visible="countdownVisible" :seconds="countdownSeconds"
      cancel-hint="按任意键立刻开始录音" @cancel="onCountdownCancel" />  </div>
</template>

<style scoped>
/* 紧凑写法：每条规则一行，避免样式表喧宾夺主 */
.ns-rec { display: flex; flex-direction: column; gap: 10px; padding: 14px; overflow-y: auto; }
.ns-rec__head { display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: flex-start; justify-content: space-between; }
.ns-rec__row, .ns-rec__field { display: flex; gap: 6px 10px; align-items: center; }
.ns-rec__field { flex-direction: column; gap: 2px; align-items: stretch; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-rec__col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ns-rec__title { margin: 0; font-size: 18px; color: var(--ns-text-primary, #303133); } .ns-rec__sub { margin: 4px 0 0; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--ns-text-secondary, #909399); }
.ns-rec__mode { padding: 4px 12px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 14px; background: var(--ns-bg-elevated); font-size: 12px; color: var(--ns-text-regular, #606266); cursor: pointer; } .ns-rec__mode.is-on { border-color: var(--ns-primary, #409eff); background: var(--ns-primary, #409eff); color: #fff; }
.ns-rec__mode:disabled, .ns-rec__btn:disabled { cursor: not-allowed; opacity: 0.5; }
.ns-rec__control { padding: 4px 8px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 12px; } .ns-rec__range { width: 130px; }
.ns-rec__btn { padding: 5px 12px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 13px; color: var(--ns-text-regular, #606266); cursor: pointer; }
.ns-rec__btn:hover:not(:disabled) { border-color: var(--ns-primary, #409eff); color: var(--ns-primary, #409eff); }
.ns-rec__btn.is-primary { border-color: var(--ns-primary, #409eff); background: var(--ns-primary, #409eff); color: #fff; }
.ns-rec__link { padding: 0 4px; border: 0; background: transparent; font-size: 12px; color: var(--ns-primary, #409eff); cursor: pointer; }
.ns-rec__note { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); } .ns-rec__warn { margin: 0; padding: 6px 10px; border-radius: 4px; background: rgb(230 162 60 / 12%); font-size: 12px; color: var(--ns-warning, #e6a23c); }
.ns-rec__p0 { margin: 0; padding: 10px 14px; border: 2px solid var(--ns-danger, #f56c6c); border-radius: 6px; background: rgb(245 108 108 / 12%); font-size: 13px; font-weight: 600; color: var(--ns-danger, #f56c6c); }
.ns-rec__disk { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); } .ns-rec__disk.is-low { padding: 6px 10px; border-radius: 4px; background: rgb(245 108 108 / 10%); color: var(--ns-danger, #f56c6c); }
.ns-rec__layout { display: grid; grid-template-columns: minmax(300px, 5fr) minmax(320px, 5fr) minmax(300px, 5fr); gap: 12px; align-items: start; }
</style>
