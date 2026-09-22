<!--
  Novel Studio · 任务包录音（角色模式，docs/12 §5 / §8.1 / §9.1 / §10）
  ============================================================================
  · docs/12 §5 —— 任务包四条硬约束：只显示该配音员负责的角色行（旁白可开关，默认关）；
    **画本只读**（不能改文本与说话人）；允许录音/重录/标记「文本有问题」/加个人备注；
    顶部显示「[配音员名] · 共 N 行 · 已完成 M 行（%）」。
  · docs/12 §8.1 —— 多 take 全保留、成品唯一；回收件用 source=package 区分。
  · docs/12 §9.1/§12 —— 快捷键走 useShortcuts（默认表 + 用户覆盖）；磁盘预检与丢帧必须可见。
  · 只读语义的落地方式：LinePromptCard 传 readonly，它的 `edit` 事件在这里**明确拒绝并解释原因**；
    `report`（文本有问题）落到 take 的 `reported` 标记 —— 这是仓库里唯一存在的反馈载体
    （TAKE_FLAG_PRESETS 的 reported 就是为任务包定义的，随录毕包的 takes.json 一起导出）。
    主进程目前没有独立的反馈 IPC，页面上如实说明，不假装已提交给导演侧。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CanvasLine, Character, RecordingMode, Take, VoiceActor } from '@shared/types.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { UNKNOWN, formatDb, formatInt, formatProgressRatio } from '@/shared/lib/format.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import CountdownOverlay from '../components/CountdownOverlay.vue'
import LinePromptCard from '../components/LinePromptCard.vue'
import TakeCompareDialog from '../components/TakeCompareDialog.vue'
import TakeFlagsPanel from '../components/TakeFlagsPanel.vue'
import TakeList from '../components/TakeList.vue'
import TransportBar from '../components/TransportBar.vue'
import { useRecordCountdown } from '../composables/useRecordCountdown.ts'
import { useRecorder } from '../composables/useRecorder.ts'
import { useShortcuts } from '../composables/useShortcuts.ts'
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
const recorder = useRecorder()

/** 任务包 id（路由参数可选：手动进入时按角色模式，docs/12 §1 的模式表） */
const packageId = computed(() => (typeof route.params.packageId === 'string' ? route.params.packageId : ''))
const mode = computed<RecordingMode>(() => (packageId.value ? 'package' : 'role'))
const lines = ref<CanvasLine[]>([])
const characters = ref<Character[]>([])
const bindings = ref<Array<{ characterId: string; actorId: string; isPrimary: boolean }>>([])
const loading = ref(false)
const currentIndex = ref(0)
const showNarration = ref(false)
const onlyUnrecorded = ref(false)
const pageNotice = ref('')
const compareOpen = ref(false)
const comparePicks = ref<string[]>([])
const confirmDiscard = ref(false)
const activeFlags = ref<string[]>([])

const actor = computed<VoiceActor | null>(() => session.actor)
const characterNames = computed(() => new Map(characters.value.map(character => [character.id, character.name])))
/** 该配音员负责的角色 id（voiceActor:bindings）；未指定配音员时不筛（全部行都要录） */
const myCharacterIds = computed(() => {
  const actorId = actor.value?.id
  if (!actorId) return null
  const ids = new Set<string>()
  for (const binding of bindings.value) if (binding.actorId === actorId) ids.add(binding.characterId)
  return ids
})
const myLines = computed(() => lines.value.filter((line) => {
  if (line.speakerType === 'narration') return showNarration.value
  const owned = myCharacterIds.value
  return !owned || (line.characterId !== null && owned.has(line.characterId))
}))
const recordedLineIds = computed(() => new Set(Object.keys(takes.byLine).filter(id => (takes.byLine[id] ?? []).length > 0)))
const workLines = computed(() => (onlyUnrecorded.value ? myLines.value.filter(line => !recordedLineIds.value.has(line.id)) : myLines.value))
const currentLine = computed<CanvasLine | null>(() => workLines.value[currentIndex.value] ?? null)
const prevLine = computed<CanvasLine | null>(() => (currentIndex.value > 0 ? workLines.value[currentIndex.value - 1] ?? null : null))
const nextLine = computed<CanvasLine | null>(() => workLines.value[currentIndex.value + 1] ?? null)
const currentTakes = computed<Take[]>(() => (currentLine.value ? takes.takesOf(currentLine.value.id) : []))
const visibleTakes = computed<Take[]>(() => (currentLine.value ? takes.visibleOf(currentLine.value.id) : []))
const selectedTake = computed<Take | null>(() => (currentLine.value ? takes.selectedOf(currentLine.value.id) : null))
const progress = computed(() => ({
  total: myLines.value.length,
  done: myLines.value.filter(line => recordedLineIds.value.has(line.id)).length,
}))
const lineProgressText = computed(() => (workLines.value.length ? `第 ${currentIndex.value + 1}/${workLines.value.length} 行（我的行）` : ''))
function currentLinePosition(): string {
  const line = currentLine.value
  return line ? `全章第 ${line.seq} 行 · ${lineProgressText.value}` : lineProgressText.value
}
function speakerNameOf(line: CanvasLine | null): string {
  if (!line) return ''
  if (line.speakerType === 'narration') return '旁白'
  if (line.characterId) return characterNames.value.get(line.characterId) ?? '未知角色'
  return '未指定角色'
}
const suggestedGainText = computed(() => `${formatDb(settings.audio?.inputGainDb ?? 0, 0)}（目标峰值 -6 dBFS，留 6 dB 余量；docs/05 §2.5）`)

async function loadAll(): Promise<void> {
  const bookId = session.bookId
  const chapterId = session.chapterId
  if (!chapterId) return
  loading.value = true
  try {
    const [page, chars, binds] = await Promise.all([
      call('canvas:getChapter', { chapterId }),
      bookId ? callSafe('character:list', { bookId }) : Promise.resolve(null),
      bookId ? callSafe('voiceActor:bindings', { bookId }) : Promise.resolve(null),
    ])
    lines.value = page.lines ?? []
    characters.value = chars ?? []
    bindings.value = binds ?? []
    await takes.loadByChapter(chapterId)
  } finally { loading.value = false }
}
watch(currentLine, (line) => {
  if (!line) return
  recording.setLine(line.id)
  void takes.loadByLine(line.id)
})

/** 修剪参数取设置（docs/04 §8.2） */
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
  if (recording.diskLow) { pageNotice.value = '磁盘空间不足，已阻止开始录音。'; return false }
  const result = await recorder.prepare({
    projectId, chapterId: session.chapterId, mode: mode.value, lineId: currentLine.value?.id ?? null,
    actorId: actor.value?.id ?? null, deviceId: devices.preferredId ?? settings.audio?.defaultInputDeviceId ?? null,
  })
  if (!result) return false
  recording.setSession(result.sessionId, mode.value, session.chapterId, result.warnings ?? [])
  return true
}
async function beginRecording(): Promise<void> {
  if (await prepareSession()) await recorder.start()
}
/**
 * 倒计时（docs/12 §3.2）：与主录音页共用同一个 composable（真机事故 docs/91 §5.2.37 ——
 * 两份各自写的 setInterval 都只关遮罩、不开录，默认 3 秒倒计时导致「点了录制没反应」）。
 */
const countdown = useRecordCountdown({ onElapsed: () => { void beginRecording() } })
const countdownVisible = countdown.visible
const countdownSeconds = countdown.seconds
async function onCountdownCancel(): Promise<void> {
  countdown.cancelAndBegin()
}
/** 开始前走倒计时（settings.audio.countdownMs；0 = 立即开始，docs/12 §3.2） */
function requestRecord(): void {
  if (recording.diskLow) { pageNotice.value = '磁盘空间不足：请清理后重试。'; return }
  /**
   * ⚠️ 返回值必须兑现（真机事故 docs/91 §5.2.45，与 RecordingView 同一个坑）：
   * `countdown.request(0)` 返回 false = 没有倒计时，**必须立即开录**。
   */
  const counting = countdown.request(settings.audio?.countdownMs ?? 0)
  if (!counting) void beginRecording()
}
async function toggleRecord(): Promise<void> {
  if (recording.isRecording) { await stopRecording(); return }
  if (recording.isPaused) { await recorder.resume(); return }
  if (countdownVisible.value) { countdown.cancelAndBegin(); return }
  requestRecord()
}
async function stopRecording(): Promise<void> {
  const lineId = currentLine.value?.id ?? null
  const result = await recorder.stop({ lineId, trim: trimOptions() })
  if (!result) return
  recording.setStopResult(result)
  if (result.take) takes.addTake(result.take)
  if (lineId) await takes.loadByLine(lineId)
  // 自动跳下一行（任务包里跳过已录行，避免在已录区域来回，docs/12 §3.3）
  if (nextLine.value) currentIndex.value += 1
}
async function redoRecording(): Promise<void> {
  const projectId = session.projectId
  if (!projectId) return
  await recorder.redo({
    projectId, chapterId: session.chapterId, mode: mode.value, actorId: actor.value?.id ?? null,
    lineId: currentLine.value?.id ?? null, deviceId: devices.preferredId ?? null, trim: trimOptions(),
  })
}
function markRecording(): void { recorder.mark('note'); recording.addMark('note', recording.durationMs) }
async function discardSession(): Promise<void> {
  confirmDiscard.value = false
  await recorder.abort(false)
  recording.reset()
  pageNotice.value = '本次录音已丢弃（未生成 take）。'
}
/** 录音中禁止改行；跳行 = 相对当前位置移动 */
function moveLine(delta: number): void {
  if (!recording.canNavigateLines) { pageNotice.value = '录音中不能改行：请先停止本次录音（docs/12 §3.3）。'; return }
  const next = currentIndex.value + delta
  if (next >= 0 && next < workLines.value.length) currentIndex.value = next
}
function goToLine(index: number): void {
  if (index !== currentIndex.value) moveLine(index - currentIndex.value)
}
function skipLine(): void {
  moveLine(1)
  pageNotice.value = '已跳过该行（本轮跳过不影响画本状态，可回头再录）。'
}

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
/** 文本有问题 → take 的 reported 标记（仓库里唯一的反馈载体，见文件头说明） */
async function onReportText(): Promise<void> {
  const take = selectedTake.value ?? currentTakes.value[0] ?? null
  if (!take) {
    pageNotice.value = '还没有 take 可以挂反馈：请先录一条，再用「文本有问题」标记（反馈随录毕包导出）。'
    return
  }
  await takes.applyFlags(take.id, [...new Set([...take.flags, 'reported'])])
  pageNotice.value = '已把该行标记为「文本有问题」，随录毕包的 takes.json 一起交给导演侧。'
}
/** 只读语义：编辑请求必须被明确拒绝并解释原因（不能让用户以为点了没反应） */
function onEditRequest(): void {
  pageNotice.value = '任务模式下画本为只读：不能修改文本与说话人。若文本有问题，请用「文本有问题」标记反馈。'
}
function onPunchRange(): void {
  pageNotice.value = '任务包模式不做区间补录（补录需要原片段的可信边界，属于对轨/逐行模式的能力）。'
}
/** 任务包模式不建监听图（避免配音现场啸叫）：只接收元素，不做挂载 */
function onPlayerReady(): void { /* 有意留空 */ }
async function onCountdownChange(ms: number): Promise<void> {
  await settings.patch({ audio: { countdownMs: ms } }).catch(() => undefined)
}

const shortcutActions: Record<string, () => void> = {
  'record.toggle': () => void toggleRecord(), 'record.toggleAlt': () => void toggleRecord(),
  'record.redo': () => void redoRecording(), 'line.next': () => moveLine(1), 'line.nextAlt': () => moveLine(1),
  'line.prev': () => moveLine(-1), 'line.prevAlt': () => moveLine(-1), 'line.skip': () => skipLine(),
  'record.mark': () => markRecording(), 'take.undoSelect': () => void takes.undoSelect(),
}
const shortcuts = useShortcuts({
  onAction: (actionId) => shortcutActions[actionId]?.(),
  isBusy: () => recording.isRecording || recording.isPaused || recording.isFinalizing,
})
const shortcutHints = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {}
  for (const id of ['record.toggle', 'record.redo', 'line.next', 'line.prev', 'line.skip', 'take.play', 'record.mark']) {
    result[id] = shortcuts.displayOf(id)
  }
  return result
})

onMounted(async () => {
  await settings.load()
  recording.init()
  shortcuts.enable()
  ui.setCapturingShortcuts(true)
  void devices.refresh()
  await loadAll()
  if (currentLine.value) {
    recording.setLine(currentLine.value.id)
    await takes.loadByLine(currentLine.value.id)
  }
})
onBeforeUnmount(() => {
  countdown.stop()
  shortcuts.disable()
  ui.setCapturingShortcuts(false)
  recording.dispose()
  void recorder.releaseCapture()
})
</script>

<template>
  <div class="ns-task">
    <header class="ns-task__head">
      <div>
        <h2 class="ns-task__title">
          {{ actor ? actor.name : '（未指定配音员）' }} · 共 {{ formatInt(progress.total) }} 行 ·
          已完成 {{ formatProgressRatio(progress.done, progress.total) }}
        </h2>
        <p class="ns-task__sub">
          任务包：{{ packageId || '（未指定，按角色模式录音）' }} ·
          章节：{{ session.chapter ? `第 ${session.chapter.seq} 章 ${session.chapter.title}` : '（未选择章节）' }} ·
          章节共 {{ formatInt(session.chapter?.lineCount ?? lines.length) }} 行
        </p>
        <p class="ns-task__sub">
          建议增益：{{ suggestedGainText }} · 当前行：{{ currentLinePosition() || UNKNOWN }}
        </p>
      </div>
      <div class="ns-task__row">
        <button type="button" class="ns-task__btn" @click="router.push('/recording/diagnostics')">设备诊断</button>
        <button type="button" class="ns-task__btn" :disabled="!recording.sessionId" @click="confirmDiscard = true">
          丢弃本次录音
        </button>
      </div>
    </header>

    <p class="ns-task__readonly">
      <strong>任务模式下画本为只读</strong>：不能修改文本与说话人（保证所有配音员拿到的稿子一致）。
      允许的操作：按行录音、重录、标记「文本有问题」、添加个人备注。
    </p>
    <p v-if="recording.warnings.length" class="ns-task__warn">会话告警：{{ recording.warnings.join('；') }}</p>
    <p v-if="recording.hasDroppedFrames" class="ns-task__error">
      丢帧 {{ formatInt(recording.droppedFrames) }} 帧：录音会话中的丢帧恒应为 0，请立即停止并检查设备与系统负载（docs/12 §13）。
    </p>
    <p v-if="recording.diskLow" class="ns-task__error">
      磁盘余量不足：可用 {{ formatInt(recording.diskFreeBytes) }} 字节，还差
      {{ formatInt(recording.diskShortfallBytes) }} 字节，请先清理空间（docs/12 §6.1）。
    </p>
    <p v-if="pageNotice" class="ns-task__sub">{{ pageNotice }}</p>

    <div class="ns-task__toolbar">
      <label class="ns-task__toggle"><input v-model="showNarration" type="checkbox">显示旁白（默认关）</label>
      <label class="ns-task__toggle"><input v-model="onlyUnrecorded" type="checkbox">只看未录行</label>
      <span class="ns-task__sub">我对 {{ formatInt(myLines.length) }} 行负责 · 本行 take {{ formatInt(currentTakes.length) }} 条</span>
    </div>

    <LoadingBlock v-if="loading" text="正在读取画本行…" :rows="5" />
    <EmptyState v-else-if="!workLines.length" title="没有可录的行" icon="📄"
      description="该配音员在当前章节没有负责的角色行。可以打开「显示旁白」看看旁白行，或换一个章节。" />

    <div v-else class="ns-task__layout">
      <section class="ns-task__col">
        <LinePromptCard :line="currentLine" :prev-line="prevLine" :next-line="nextLine" readonly
          :speaker-name="speakerNameOf(currentLine)" :line-progress="currentLinePosition()"
          :take-count="currentTakes.length" :has-selected-take="selectedTake !== null"
          @edit="onEditRequest" @report="onReportText" />
        <ul class="ns-task__lines">
          <li v-for="(line, index) in workLines" :key="line.id"
            :class="{ 'is-current': index === currentIndex, 'is-recorded': recordedLineIds.has(line.id) }">
            <button type="button" class="ns-task__line" @click="goToLine(index)">
              <span class="ns-task__seq">{{ line.seq }}</span>
              <span class="ns-task__speaker">{{ speakerNameOf(line) }}</span>
              <span class="ns-task__text">{{ line.text }}</span>
              <span class="ns-task__state">{{ recordedLineIds.has(line.id) ? '已录' : '未录' }}</span>
            </button>
          </li>
        </ul>
      </section>

      <section class="ns-task__col">
        <TransportBar :state="recording.state" :mode="mode" :auto-next="true" :can-punch-in="false"
          :has-punch-range="false" :duration-ms="recording.durationMs" :disk-low="recording.diskLow"
          :line-progress="currentLinePosition()" :take-count="currentTakes.length" :shortcuts="shortcutHints"
          :has-selected-take="selectedTake !== null" :countdown-ms="settings.audio?.countdownMs ?? 0"
          @record="toggleRecord" @stop="stopRecording" @pause="recorder.pause" @resume="recorder.resume"
          @prev="moveLine(-1)" @next="moveLine(1)" @skip="skipLine" @redo="redoRecording" @mark="markRecording"
          @punch-in="onPunchRange" @update:countdown-ms="onCountdownChange" />
        <TakeList :takes="visibleTakes" :selected-id="selectedTake?.id ?? null" show-source
          :project-id="session.projectId ?? ''" :loading="takes.loading" :active-flags="activeFlags"
          :punch-in-ms="0" :punch-out-ms="0" @select="onSelectTake" @remove="onRemoveTake" @flag="onFlagTake"
          :can-combine-parts="currentLine ? takes.canCombineParts(currentLine.id) : false"
          @combine="onCombineTakes" @compare="onCompare" @punch-range="onPunchRange" @player-ready="onPlayerReady" />
        <TakeFlagsPanel :take="selectedTake ?? (currentTakes[0] ?? null)" :takes="currentTakes"
          :active-flags="activeFlags" @update:active-flags="onActiveFlagsChange" />
        <p class="ns-task__sub">
          录毕包会把全部 takes（含 source=package 的回收件）与 takes.json 一起导出；任何 take 都不会被自动删除。
        </p>
      </section>
    </div>

    <TakeCompareDialog v-model="compareOpen" :project-id="session.projectId ?? ''" @select="onSelectTake"
      :takes="comparePicks.length ? currentTakes.filter(t => comparePicks.includes(t.id)) : currentTakes" />
    <ConfirmDialog v-model="confirmDiscard" title="丢弃本次录音？" type="warning" confirm-text="丢弃"
      message="未定稿的会话文件会被删除，已生成的 take 不受影响。" @confirm="discardSession" />
    <CountdownOverlay :visible="countdownVisible" :seconds="countdownSeconds"
      cancel-hint="按任意键立刻开始录音" @cancel="onCountdownCancel" />
  </div>
</template>

<style scoped>
/* 紧凑写法：每条规则一行 */
.ns-task { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow-y: auto; }
.ns-task__head { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; justify-content: space-between; }
.ns-task__row, .ns-task__toolbar { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
.ns-task__col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ns-task__title { margin: 0; font-size: 18px; color: var(--ns-text-primary, #303133); }
.ns-task__sub { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-task__toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ns-text-regular, #606266); }
.ns-task__btn { padding: 5px 12px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 13px; color: var(--ns-text-regular, #606266); cursor: pointer; }
.ns-task__btn:hover:not(:disabled) { border-color: var(--ns-primary, #409eff); color: var(--ns-primary, #409eff); }
.ns-task__btn:disabled { cursor: not-allowed; opacity: 0.5; }
.ns-task__readonly { margin: 0; padding: 8px 12px; border-left: 3px solid var(--ns-primary, #409eff); border-radius: 4px; background: rgb(64 158 255 / 8%); font-size: 12px; color: var(--ns-text-regular, #606266); }
.ns-task__warn { margin: 0; padding: 6px 10px; border-radius: 4px; background: rgb(230 162 60 / 12%); font-size: 12px; color: var(--ns-warning, #e6a23c); }
.ns-task__error { margin: 0; padding: 6px 10px; border-radius: 4px; background: rgb(245 108 108 / 12%); font-size: 12px; color: var(--ns-danger, #f56c6c); }
.ns-task__layout { display: grid; grid-template-columns: minmax(340px, 6fr) minmax(360px, 5fr); gap: 12px; align-items: start; }
.ns-task__lines { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; max-height: 320px; overflow-y: auto; border: 1px solid var(--ns-border-light, #e4e7ed); border-radius: 6px; list-style: none; }
.ns-task__lines li.is-current .ns-task__line { background: rgb(64 158 255 / 10%); }
.ns-task__lines li.is-recorded .ns-task__state { color: var(--ns-success, #67c23a); }
.ns-task__line { display: flex; gap: 8px; align-items: baseline; width: 100%; padding: 5px 8px; border: 0; background: transparent; font-size: 12px; text-align: left; color: var(--ns-text-regular, #606266); cursor: pointer; }
.ns-task__line:hover { background: var(--ns-fill-light, #f5f7fa); }
.ns-task__seq { min-width: 26px; font-variant-numeric: tabular-nums; color: var(--ns-text-secondary, #909399); }
.ns-task__speaker { flex: 0 0 auto; color: var(--ns-primary, #409eff); } .ns-task__state { flex: 0 0 auto; color: var(--ns-text-secondary, #909399); }
.ns-task__text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
