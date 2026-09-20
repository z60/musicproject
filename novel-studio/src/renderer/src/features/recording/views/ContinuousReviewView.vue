<!--
  Novel Studio · 连续录制切片确认（docs/12 §4.3 / §4.4 / §10）
  ============================================================================
  设计依据：
    · docs/12 §4.3 —— 停止后主进程按「定稿 WAV → VAD → 边界精修 → 过滤 → DP 匹配」
      产出候选切片；渲染进程只负责**确认**，不自行推进任何切片逻辑。
    · docs/12 §4.4 —— 这一页决定连续录制好不好用，因此必须齐全：
      切片列表 + 波形/画本行对照 + 未匹配两侧并排（手工绑定/解绑）+
      逐条确认 / 仅接受高置信 / 全部拒绝 / 重切（原始会话永不删除）。
    · docs/20 §7  —— 分析进度只来自 `record:sliceProgress`（订阅在 continuous.store
      的 init() 里，页面卸载时 dispose）。
    · docs/12 §9.1 —— 键盘语义在本页与录音页不同：本页 `Enter` = 接受当前切片、
      `Delete` = 拒绝，因此**不复用** useShortcuts 的录音键位表（它的 Enter 是开始录音），
      而是注册本页自己的键盘处理，并同样用 `isEditableTarget` 守卫输入框。

  一个故意不做的事：本页**不**创建采集图。要重新连续录制就回录音页（同一个
  AudioContext 不应该被两个页面同时持有）。所以 ContinuousControls 的「开始」在这里
  是「回到录音页」，而不是就地开录。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { CanvasLine, Character, VadSlice } from '@shared/types.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { formatDb, formatDuration, formatInt, formatPercent } from '@/shared/lib/format.ts'
import { isEditableTarget } from '@/shared/lib/shortcuts.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useUiStore } from '@/app/store/ui.store.ts'
import ContinuousControls from '../components/ContinuousControls.vue'
import SliceReviewPanel from '../components/SliceReviewPanel.vue'
import SliceTimeline from '../components/SliceTimeline.vue'
import { useContinuousStore } from '../stores/continuous.store.ts'
import { useRecordingStore } from '../stores/recording.store.ts'

/** 与 SliceTimeline 的 props 结构一致（时间线对照用的最小字段集） */
interface TimelineLine {
  id: string
  seq: number
  speakerName: string
  text: string
}

const router = useRouter()
const session = useSessionStore()
const settings = useSettingsStore()
const ui = useUiStore()
const store = useContinuousStore()
const recording = useRecordingStore()

const lines = ref<CanvasLine[]>([])
const characters = ref<Character[]>([])
const loading = ref(false)
/** 时间线上的播放头（点击定位后由页面持有；真实播放仍由切片列表的 <audio> 负责） */
const playheadMs = ref<number | null>(null)
/** 接受动作的结论（主进程返回的统计） */
const acceptMessage = ref('')

/** VAD 参数（重切时提交给主进程，docs/12 §4.4「重做切片(调参)」） */
const vadDraft = ref({ silenceDb: -45, minSilenceMs: 350, minSpeechMs: 120 })
/** 高置信阈值取自设置 `canvas.autoAcceptConfidence`（与画本归属判定同源，docs/06 §5.2） */
const threshold = computed(() => settings.settings?.canvas?.autoAcceptConfidence ?? 0.85)

const chapterId = computed(() => session.chapterId)
const hasSession = computed(() => store.sessionId !== null || recording.sessionId !== null)

// ---------------------------------------------------------------------------
// 画本行与说话人（对照与手工绑定都要用真实文本 + 名字，不给用户看 id）
// ---------------------------------------------------------------------------

const characterNames = computed(() => {
  const map = new Map<string, string>()
  for (const character of characters.value) map.set(character.id, character.name)
  return map
})

const speakerOf = computed(() => (line: CanvasLine): string => {
  if (line.speakerType === 'narration') return '旁白'
  if (line.characterId) return characterNames.value.get(line.characterId) ?? '未知角色'
  return '未指定角色'
})

function shortText(line: CanvasLine, max = 28): string {
  return line.text.length > max ? `${line.text.slice(0, max)}…` : line.text
}

/** lineId → `42 萧炎：我萧炎…`（切片列表与时间线共用） */
const lineLabels = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {}
  for (const line of lines.value) {
    result[line.id] = `${line.seq} ${speakerOf.value(line)}：${shortText(line)}`
  }
  return result
})

const lineOptions = computed(() => lines.value.map(line => ({ id: line.id, label: lineLabels.value[line.id] ?? line.id })))

const timelineLines = computed<TimelineLine[]>(() => lines.value.map(line => ({
  id: line.id,
  seq: line.seq,
  speakerName: speakerOf.value(line),
  text: line.text,
})))

/** 未匹配切片（左）与未录行（右）并排显示，两条都用同一份文本来源 */
const unmatchedSliceRows = computed<VadSlice[]>(() => {
  const rows: VadSlice[] = []
  for (const index of store.unmatchedSlices) {
    const found = store.slices.find(slice => slice.sliceIndex === index)
    if (found) rows.push(found)
  }
  return rows
})

const unrecordedLineRows = computed(() => store.unrecordedLines
  .map(id => lines.value.find(line => line.id === id) ?? null)
  .filter((line): line is CanvasLine => line !== null))

async function loadLines(): Promise<void> {
  const id = chapterId.value
  if (!id) return
  loading.value = true
  try {
    const [page, actors] = await Promise.all([
      call('canvas:getChapter', { chapterId: id }),
      session.bookId ? callSafe('character:list', { bookId: session.bookId }) : Promise.resolve(null),
    ])
    lines.value = page.lines ?? []
    characters.value = actors ?? []
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// 切片与匹配（会话已有切片时直接沿用；没有则提示去录音页）
// ---------------------------------------------------------------------------

async function ensureAnalysis(): Promise<void> {
  if (!store.sessionId) return
  if (!store.hasResult) await store.runSlice()
  if (chapterId.value) await store.runMatch(chapterId.value)
}

async function reslice(): Promise<void> {
  if (!store.sessionId) return
  const ok = await store.reslice({
    silenceDb: vadDraft.value.silenceDb,
    minSilenceMs: vadDraft.value.minSilenceMs,
    minSpeechMs: vadDraft.value.minSpeechMs,
  })
  if (ok && chapterId.value) await store.runMatch(chapterId.value)
}

async function acceptHigh(): Promise<void> {
  store.acceptHighConfidence(threshold.value)
  await submitAccept()
}

async function acceptAll(): Promise<void> {
  store.acceptAll()
  await submitAccept()
}

/** 把已勾选的切片交给主进程生成 takes/segments（record:acceptSlices） */
async function submitAccept(): Promise<void> {
  const result = await store.accept()
  acceptMessage.value = result
    ? `已接受：生成 take ${formatInt(result.createdTakes)} 个、片段 ${formatInt(result.createdSegments)} 个`
    : '没有可接受的切片（未匹配的画本行无法生成片段）'
}

// ---------------------------------------------------------------------------
// 手工绑定（未匹配切片 ↔ 未录行）
// ---------------------------------------------------------------------------

function bindSliceToLine(index: number, event: Event): void {
  const lineId = (event.target as HTMLSelectElement).value
  if (!lineId) {
    store.unbind(index)
    return
  }
  store.bind(index, lineId)
}

function bindLineToSlice(lineId: string, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === '') return
  store.bind(Number(value), lineId)
}

function unbindSlice(index: number): void {
  store.unbind(index)
}

// ---------------------------------------------------------------------------
// 键盘操作（本页语义：↑↓ 移动 / Enter 接受 / Delete 拒绝 / Ctrl+Shift+Enter 仅接受高置信）
// ---------------------------------------------------------------------------

function onKeydown(event: KeyboardEvent): void {
  // 输入框/下拉里打字时不抢键（docs/12 §9.1 的通用纪律）
  if (isEditableTarget(event.target)) return

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      store.moveSelection(1)
      syncPlayheadToSelection()
      break
    case 'ArrowUp':
      event.preventDefault()
      store.moveSelection(-1)
      syncPlayheadToSelection()
      break
    case 'Enter':
      event.preventDefault()
      if (event.ctrlKey && event.shiftKey) {
        void acceptHigh()
        break
      }
      if (event.ctrlKey) {
        void acceptAll()
        break
      }
      // 只能接受「能定位到画本行」的切片：否则按 Enter 什么都不会发生，必须给出解释
      if (store.lineOf(store.selectedIndex) === null) {
        acceptMessage.value = '当前切片还没有匹配到画本行：请先手工绑定，或按 Delete 拒绝'
        break
      }
      store.setAccept(store.selectedIndex, true)
      break
    case 'Delete':
    case 'Backspace':
      event.preventDefault()
      store.setAccept(store.selectedIndex, false)
      break
    default:
      break
  }
}

function syncPlayheadToSelection(): void {
  const slice = store.selected
  if (slice) playheadMs.value = slice.startMs
}

/** 切片列表选中某条 → 选中并同步播放头 */
function onPanelSelect(index: number): void {
  store.select(index)
  syncPlayheadToSelection()
}

/** 时间线点击选中 */
function onTimelineSelect(index: number): void {
  onPanelSelect(index)
}

/** 时间线点击定位 */
function onTimelineSeek(ms: number): void {
  playheadMs.value = ms
}

// ---------------------------------------------------------------------------
// 生命周期（订阅 record:sliceProgress 在 store.init 里完成）
// ---------------------------------------------------------------------------

onMounted(async () => {
  store.init()
  ui.setCapturingShortcuts(true)
  globalThis.addEventListener?.('keydown', onKeydown, true)
  // 高置信阈值来自设置，必须先加载设置再渲染（否则会用兜底阈值误导用户）
  await settings.load()
  await loadLines()
  vadDraft.value = {
    silenceDb: store.vad.silenceDb,
    minSilenceMs: store.vad.minSilenceMs,
    minSpeechMs: store.vad.minSpeechMs,
  }
  await ensureAnalysis()
})

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('keydown', onKeydown, true)
  ui.setCapturingShortcuts(false)
  store.dispose()
})

// ---------------------------------------------------------------------------
// 展示用派生
// ---------------------------------------------------------------------------

const progressPercent = computed(() => formatPercent(store.progressRatio, 0))
const selectedSlice = computed(() => store.selected)
const canSubmitAccept = computed(() => store.acceptedCount > 0 && !store.accepting)

function backToRecording(): void {
  void router.push({ path: '/recording', query: { mode: 'continuous' } })
}

function goAlignment(): void {
  void router.push('/alignment')
}
</script>

<template>
  <div class="ns-review-page">
    <header class="ns-review-page__header">
      <div>
        <h2 class="ns-review-page__title">连续录制切片确认</h2>
        <p class="ns-review-page__subtitle">
          {{ session.breadcrumb || '（未选择章节）' }} ·
          共 {{ formatInt(store.totalSlices) }} 个切片 · 已接受 {{ formatInt(store.acceptedCount) }} ·
          未匹配 {{ formatInt(store.unmatchedCount) }} · 缺录 {{ formatInt(store.unrecordedCount) }} 行 ·
          切片总时长 {{ formatDuration(store.totalDurationMs) }}
        </p>
      </div>
      <div class="ns-review-page__header-actions">
        <button type="button" class="ns-review-page__button" @click="backToRecording">回录音页</button>
        <button type="button" class="ns-review-page__button" :disabled="!canSubmitAccept" @click="submitAccept">
          {{ store.accepting ? '提交中…' : `接受已勾选（${formatInt(store.acceptedCount)}）` }}
        </button>
        <button type="button" class="ns-review-page__button is-primary" :disabled="store.acceptedCount === 0" @click="goAlignment">
          去对轨
        </button>
      </div>
    </header>

    <LoadingBlock v-if="loading" text="正在读取画本行…" :rows="4" />

    <EmptyState
      v-else-if="!hasSession"
      title="没有可确认的连续录制会话"
      description="切片确认针对「刚刚停止的连续录制」。请回到录音页选择连续录制模式，录完之后会自动进入本页。"
      icon="🎬"
      action-text="去录音页"
      @action="backToRecording"
    />

    <template v-else>
      <!-- 分析进度（record:sliceProgress） -->
      <section class="ns-review-page__card">
        <div class="ns-review-page__progress-head">
          <span>
            VAD 分析进度：{{ progressPercent }}（{{ formatDuration(store.progress.analyzedMs) }} /
            {{ formatDuration(store.progress.totalMs) }}）
          </span>
          <span v-if="store.analyzing || store.matching" class="ns-review-page__badge">进行中</span>
          <span v-else class="ns-review-page__badge is-done">已就绪</span>
        </div>
        <div class="ns-review-page__progress">
          <div class="ns-review-page__progress-bar" :style="{ width: progressPercent }" />
        </div>

        <div class="ns-review-page__vad">
          <label class="ns-review-page__field">
            <span>静音阈值 {{ formatDb(vadDraft.silenceDb, 0) }}</span>
            <input v-model.number="vadDraft.silenceDb" type="range" min="-70" max="-20" step="1">
          </label>
          <label class="ns-review-page__field">
            <span>最短静音 {{ vadDraft.minSilenceMs }} ms</span>
            <input v-model.number="vadDraft.minSilenceMs" type="range" min="120" max="1200" step="10">
          </label>
          <label class="ns-review-page__field">
            <span>最短语音 {{ vadDraft.minSpeechMs }} ms</span>
            <input v-model.number="vadDraft.minSpeechMs" type="range" min="60" max="800" step="10">
          </label>
          <button type="button" class="ns-review-page__button" :disabled="store.analyzing" @click="reslice">
            用新参数重切
          </button>
          <button type="button" class="ns-review-page__button" :disabled="store.analyzing" @click="ensureAnalysis">
            重新匹配画本行
          </button>
        </div>
        <p class="ns-review-page__note">
          重切依赖「原始会话 WAV 永不删除」：参数调坏了可以反复重切，不会丢素材（docs/12 §4.4）。
        </p>
      </section>

      <!-- 连续录制控制条（本页不建采集图：开始 = 回录音页） -->
      <ContinuousControls
        :state="recording.state"
        :duration-ms="recording.durationMs"
        :marks="recording.marks"
        :speech-run-count="store.totalSlices"
        :silence="false"
        :clip-events="recording.clipEvents"
        :slice-available="store.hasResult"
        :analyzing="store.analyzing"
        :show-slice-entry="false"
        @start="backToRecording"
      />

      <!-- 主区：左侧切片列表 / 右侧波形对照 -->
      <div class="ns-review-page__columns">
        <SliceReviewPanel
          class="ns-review-page__column"
          :project-id="session.projectId ?? ''"
          :line-labels="lineLabels"
          :line-options="lineOptions"
          :threshold="threshold"
          :disabled="store.accepting"
          @select="onPanelSelect"
          @request-reslice="reslice"
        />

        <div class="ns-review-page__column">
          <SliceTimeline
            :slices="store.slices"
            :lines="timelineLines"
            :matches="store.matches"
            :manual-bindings="store.manualBindings"
            :selected-index="store.selectedIndex"
            :playhead-ms="playheadMs"
            @select="onTimelineSelect"
            @seek="onTimelineSeek"
          />

          <p v-if="selectedSlice" class="ns-review-page__note">
            当前选中：第 {{ selectedSlice.sliceIndex + 1 }} 片
            （{{ formatDuration(selectedSlice.startMs, { showMs: true }) }} →
            {{ formatDuration(selectedSlice.endMs, { showMs: true }) }}，
            RMS {{ formatDb(selectedSlice.rmsDb) }}，峰值 {{ formatDb(selectedSlice.peakDb) }}）
            · 快捷键：↑↓ 移动 / Enter 接受 / Delete 拒绝 / Ctrl+Shift+Enter 仅接受高置信
          </p>

          <p v-if="acceptMessage" class="ns-review-page__result">{{ acceptMessage }}</p>
        </div>
      </div>

      <!-- 未匹配切片 ↔ 未录行：并排，逐条手工绑定 -->
      <section class="ns-review-page__card">
        <h3 class="ns-review-page__card-title">未匹配切片 与 未录画本行</h3>
        <div class="ns-review-page__pairs">
          <div class="ns-review-page__pair">
            <h4 class="ns-review-page__pair-title">
              未匹配切片（{{ formatInt(unmatchedSliceRows.length) }}）
            </h4>
            <ul v-if="unmatchedSliceRows.length" class="ns-review-page__list">
              <li v-for="slice in unmatchedSliceRows" :key="slice.id">
                <div class="ns-review-page__list-main">
                  <button
                    type="button"
                    class="ns-review-page__link"
                    @click="store.select(slice.sliceIndex); syncPlayheadToSelection()"
                  >
                    #{{ slice.sliceIndex + 1 }}
                  </button>
                  <span>
                    {{ formatDuration(slice.startMs, { showMs: true }) }} →
                    {{ formatDuration(slice.endMs, { showMs: true }) }}
                  </span>
                  <span class="ns-review-page__muted">RMS {{ formatDb(slice.rmsDb) }}</span>
                </div>
                <div class="ns-review-page__list-actions">
                  <select
                    class="ns-review-page__select"
                    :value="store.lineOf(slice.sliceIndex) ?? ''"
                    @change="bindSliceToLine(slice.sliceIndex, $event)"
                  >
                    <option value="">绑定到画本行…</option>
                    <option v-for="option in lineOptions" :key="option.id" :value="option.id">
                      {{ option.label }}
                    </option>
                  </select>
                  <button
                    type="button"
                    class="ns-review-page__link"
                    :disabled="!store.isManual(slice.sliceIndex)"
                    @click="unbindSlice(slice.sliceIndex)"
                  >
                    解绑
                  </button>
                </div>
                <p v-if="store.isManual(slice.sliceIndex)" class="ns-review-page__muted">
                  已手工绑定：{{ lineLabels[store.lineOf(slice.sliceIndex) ?? ''] ?? '（未知行）' }}
                </p>
              </li>
            </ul>
            <p v-else class="ns-review-page__muted">所有切片都已匹配到画本行。</p>
          </div>

          <div class="ns-review-page__pair">
            <h4 class="ns-review-page__pair-title">
              未录画本行（{{ formatInt(unrecordedLineRows.length) }}）
            </h4>
            <ul v-if="unrecordedLineRows.length" class="ns-review-page__list">
              <li v-for="line in unrecordedLineRows" :key="line.id">
                <div class="ns-review-page__list-main">
                  <span class="ns-review-page__seq">{{ line.seq }}</span>
                  <span class="ns-review-page__speaker">{{ speakerOf(line) }}</span>
                  <span>{{ shortText(line) }}</span>
                </div>
                <div class="ns-review-page__list-actions">
                  <select class="ns-review-page__select" @change="bindLineToSlice(line.id, $event)">
                    <option value="">把某个切片绑到这行…</option>
                    <option v-for="slice in store.slices" :key="slice.id" :value="slice.sliceIndex">
                      #{{ slice.sliceIndex + 1 }}（{{ formatDuration(slice.endMs - slice.startMs) }}）
                    </option>
                  </select>
                </div>
              </li>
            </ul>
            <p v-else class="ns-review-page__muted">画本行都已录到。</p>
          </div>
        </div>
        <p class="ns-review-page__note">
          手工绑定会立即把该切片标为「接受」；绑定只影响本次确认的归属，边界仍以主进程的切片结果为准。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ns-review-page { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow-y: auto; }
.ns-review-page__header { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; justify-content: space-between; }
.ns-review-page__title { margin: 0; font-size: 18px; color: var(--ns-text-primary, #303133); }
.ns-review-page__subtitle { margin: 4px 0 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-review-page__header-actions { display: flex; gap: 8px; }
.ns-review-page__button { padding: 5px 12px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 13px; color: var(--ns-text-regular, #606266); cursor: pointer; }
.ns-review-page__button:hover:not(:disabled) { border-color: var(--ns-primary, #409eff); color: var(--ns-primary, #409eff); }
.ns-review-page__button.is-primary { border-color: var(--ns-primary, #409eff); background: var(--ns-primary, #409eff); color: #fff; }
.ns-review-page__button:disabled { cursor: not-allowed; opacity: 0.5; }
.ns-review-page__card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-elevated, #fff); }
.ns-review-page__card-title { margin: 0; font-size: 14px; color: var(--ns-text-primary, #303133); }
.ns-review-page__progress-head { display: flex; gap: 10px; align-items: center; font-size: 12px; color: var(--ns-text-regular, #606266); }
.ns-review-page__badge { padding: 1px 6px; border-radius: 3px; background: rgb(64 158 255 / 12%); color: var(--ns-primary, #409eff); }
.ns-review-page__badge.is-done { background: rgb(103 194 58 / 12%); color: var(--ns-success, #67c23a); }
.ns-review-page__progress { height: 6px; overflow: hidden; border-radius: 3px; background: var(--ns-fill, #ebeef5); }
.ns-review-page__progress-bar { height: 100%; background: var(--ns-primary, #409eff); transition: width 0.12s linear; }
.ns-review-page__vad { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
.ns-review-page__field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-review-page__field input { width: 160px; }
.ns-review-page__columns { display: grid; grid-template-columns: minmax(320px, 5fr) minmax(360px, 7fr); gap: 12px; align-items: start; }
.ns-review-page__column { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ns-review-page__pairs { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
.ns-review-page__pair { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--ns-border-light, #e4e7ed); border-radius: 6px; background: var(--ns-bg-subtle, #fafafa); }
.ns-review-page__pair-title { margin: 0; font-size: 13px; color: var(--ns-text-primary, #303133); }
.ns-review-page__list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; list-style: none; }
.ns-review-page__list li { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--ns-border-light, #e4e7ed); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 12px; color: var(--ns-text-regular, #606266); }
.ns-review-page__list-main { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.ns-review-page__list-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ns-review-page__select { max-width: 260px; padding: 3px 6px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 3px; font-size: 12px; }
.ns-review-page__link { padding: 0; border: 0; background: transparent; font-size: 12px; color: var(--ns-primary, #409eff); cursor: pointer; }
.ns-review-page__link:disabled { color: var(--ns-text-placeholder, #c0c4cc); cursor: not-allowed; }
.ns-review-page__seq { font-variant-numeric: tabular-nums; color: var(--ns-text-secondary, #909399); }
.ns-review-page__speaker { color: var(--ns-primary, #409eff); }
.ns-review-page__muted { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-review-page__note { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-review-page__result { margin: 0; padding: 6px 10px; border-radius: 4px; background: rgb(64 158 255 / 10%); font-size: 12px; color: var(--ns-primary, #409eff); }
</style>
