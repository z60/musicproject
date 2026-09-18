<!--
  Novel Studio · take A/B 对比对话框（docs/12 §8.1 / §3.3）
  ============================================================================
  设计依据：
    · docs/12 §3.3 —— 「A/B 对比：多 take 时并排播放或交替播放（左/右声道分离也可，
                        作为高级选项）」
    · docs/12 §8.1 —— 「A/B 对比：并排播放、交替播放、或左右声道分离（高级）」
    · docs/01 §4.3 —— 音频只能走 ns-media://（segmentUrl + 缓存破坏）

  三种模式的语义（切换时必须保持播放位置，否则用户没法比较同一句的语气）：
    · 并排 side      —— 两轨同时播放（听叠加差异、音色差异）
    · 交替 alternate —— 同一区间 A/B 轮换播放（这是分辨「哪一版更好」最有效的方式）
    · 左右分离 split —— A 只走左声道、B 只走右声道（同时听、又互不干扰）

  实现说明：
    · 先进 split 模式时才建 Web Audio 图（MediaElementSource），其余模式直接用 <audio>；
      一旦建过图，元素的声音就只从图里出，因此并排/交替模式也走同一条通路并把声像归中。
    · 播放位置用 <audio>.currentTime 同步，切换模式的瞬间暂停→对齐→恢复播放。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Take } from '@shared/types.ts'
import { mediaUrlWithCacheBust, segmentUrl } from '@/shared/lib/media-url.ts'
import { UNKNOWN, formatDate, formatDb, formatDuration, formatRelativeTime } from '@/shared/lib/format.ts'

type CompareMode = 'side' | 'alternate' | 'split'

const props = withDefaults(defineProps<{
  /** 双向绑定：是否显示 */
  modelValue: boolean
  /** 参与对比的两个 take（顺序即 A / B） */
  takes: Take[]
  projectId: string
  /** 交替播放的切换间隔（毫秒） */
  switchMs?: number
}>(), {
  switchMs: 3000,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 设为成品 */
  select: [takeId: string]
}>()

const mode = ref<CompareMode>('alternate')
const playing = ref(false)
const audioA = ref<HTMLAudioElement | null>(null)
const audioB = ref<HTMLAudioElement | null>(null)
const volumeA = ref(1)
const volumeB = ref(1)
/** 交替播放当前轮到谁 */
const activeSide = ref<'a' | 'b'>('a')
const positionMs = ref(0)

let context: AudioContext | null = null
let sourceA: MediaElementAudioSourceNode | null = null
let sourceB: MediaElementAudioSourceNode | null = null
let pannerA: StereoPannerNode | null = null
let pannerB: StereoPannerNode | null = null
let switchTimer: ReturnType<typeof setInterval> | null = null
let positionTimer: ReturnType<typeof setInterval> | null = null

const takeA = computed(() => props.takes[0] ?? null)
const takeB = computed(() => props.takes[1] ?? null)

function urlOf(take: Take | null): string {
  if (!take) return ''
  const base = segmentUrl(props.projectId, take.filePath)
  return base ? mediaUrlWithCacheBust(base, take.recordedAt) : ''
}

const srcA = computed(() => urlOf(takeA.value))
const srcB = computed(() => urlOf(takeB.value))

/** 建立 Web Audio 图（只在需要左右分离时；此后所有模式都走这条通路） */
function ensureGraph(): boolean {
  if (context && sourceA && sourceB) return true
  const elA = audioA.value
  const elB = audioB.value
  if (!elA || !elB) return false
  const ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext
  if (!ctor) return false
  context = new ctor({ latencyHint: 'playback' })
  try {
    sourceA = context.createMediaElementSource(elA)
    sourceB = context.createMediaElementSource(elB)
  } catch {
    // 同一个元素重复创建 source 会抛错：说明图已经建好了
    return Boolean(context && sourceA && sourceB)
  }
  pannerA = context.createStereoPanner()
  pannerB = context.createStereoPanner()
  sourceA.connect(pannerA).connect(context.destination)
  sourceB.connect(pannerB).connect(context.destination)
  applyMode()
  return true
}

/** 把当前模式落到声像与播放状态上 */
function applyMode(): void {
  if (mode.value === 'split' && !ensureGraph()) return
  if (pannerA) pannerA.pan.value = mode.value === 'split' ? -1 : 0
  if (pannerB) pannerB.pan.value = mode.value === 'split' ? 1 : 0
  syncVolumes()
}

function syncVolumes(): void {
  if (audioA.value) audioA.value.volume = volumeA.value
  if (audioB.value) audioB.value.volume = volumeB.value
}

function currentPositionMs(): number {
  const el = activeSide.value === 'a' ? audioA.value : audioB.value
  return el ? el.currentTime * 1000 : positionMs.value
}

/** 切换模式：暂停 → 对齐位置 → 恢复（docs/12 §3.3 的「切换时保持播放位置」） */
async function changeMode(next: CompareMode): Promise<void> {
  const wasPlaying = playing.value
  const position = currentPositionMs()
  pauseAll()
  mode.value = next
  applyMode()
  applyPosition(position)
  if (wasPlaying) await play()
}

/**
 * 对比模式切换：el-radio-group 的选项值即 CompareMode。
 *
 * 参数收宽：Element Plus 2.14 起事件参数类型为
 * `string | number | boolean | undefined`，精确类型因逆变不可赋值。
 */
function onModeInput(value: string | number | boolean | undefined): void {
  void changeMode(value as CompareMode)
}

function applyPosition(ms: number): void {
  const seconds = Math.max(0, ms / 1000)
  if (audioA.value) audioA.value.currentTime = Math.min(seconds, Math.max(0, (takeA.value?.durationMs ?? 0) / 1000))
  if (audioB.value) audioB.value.currentTime = Math.min(seconds, Math.max(0, (takeB.value?.durationMs ?? 0) / 1000))
  positionMs.value = ms
}

function pauseAll(): void {
  audioA.value?.pause()
  audioB.value?.pause()
  playing.value = false
  stopTimers()
}

function stopTimers(): void {
  if (switchTimer) {
    clearInterval(switchTimer)
    switchTimer = null
  }
  if (positionTimer) {
    clearInterval(positionTimer)
    positionTimer = null
  }
}

async function play(): Promise<void> {
  const elA = audioA.value
  const elB = audioB.value
  if (!elA || !elB) return
  if (mode.value === 'split') ensureGraph()
  if (context?.state === 'suspended') await context.resume().catch(() => undefined)

  playing.value = true
  // 位置对齐：两轨从同一时间点开始，用户听到的才是「同一句」
  applyPosition(positionMs.value)

  if (mode.value === 'side' || mode.value === 'split') {
    await Promise.allSettled([elA.play(), elB.play()])
    if (mode.value === 'side') activeSide.value = 'a'
  } else {
    activeSide.value = 'a'
    await elA.play().catch(() => undefined)
    switchTimer = setInterval(() => {
      void alternate()
    }, props.switchMs)
  }

  positionTimer = setInterval(() => {
    positionMs.value = currentPositionMs()
    const duration = Math.max(takeA.value?.durationMs ?? 0, takeB.value?.durationMs ?? 0)
    if (duration > 0 && positionMs.value >= duration) pauseAll()
  }, 100)
}

/** 交替播放：在同一位置换另一轨 */
async function alternate(): Promise<void> {
  const elA = audioA.value
  const elB = audioB.value
  if (!elA || !elB) return
  const position = currentPositionMs()
  elA.pause()
  elB.pause()
  activeSide.value = activeSide.value === 'a' ? 'b' : 'a'
  const el = activeSide.value === 'a' ? elA : elB
  el.currentTime = Math.max(0, position / 1000)
  await el.play().catch(() => undefined)
}

function close(): void {
  pauseAll()
  emit('update:modelValue', false)
}

/** 对话框显隐：el-dialog 的 update:model-value 载荷为 boolean */
function onVisibleInput(value: boolean): void {
  emit('update:modelValue', value)
}

function pick(takeId: string): void {
  pauseAll()
  emit('select', takeId)
}

watch(mode, (next, prev) => {
  if (next === prev) return
  void changeMode(next)
})

// 打开/关闭：关闭时必须停播（否则关掉对话框还在放声音）
watch(
  () => props.modelValue,
  async (visible) => {
    if (!visible) {
      pauseAll()
      applyPosition(0)
      return
    }
    applyMode()
    syncVolumes()
  },
)

onBeforeUnmount(() => {
  pauseAll()
  try {
    sourceA?.disconnect()
    sourceB?.disconnect()
    pannerA?.disconnect()
    pannerB?.disconnect()
  } catch {
    /* 忽略 */
  }
  void context?.close().catch(() => undefined)
})

/** 单侧指标展示（两列并排，diff 一眼可见） */
function metrics(take: Take | null): Array<{ label: string; value: string }> {
  if (!take) return []
  return [
    { label: '时长', value: formatDuration(take.durationMs, { showMs: true }) },
    { label: '峰值', value: formatDb(take.peakDb) },
    { label: 'RMS', value: formatDb(take.rmsDb) },
    { label: '增益', value: formatDb(take.gainDb) },
    { label: '来源', value: take.source === 'local' ? '本地录制' : take.source === 'package' ? '任务包回收' : '外部导入' },
    { label: '录制时间', value: `${formatDate(take.recordedAt, 'MM-DD HH:mm')}（${formatRelativeTime(take.recordedAt)}）` },
    { label: '标记', value: take.flags.length ? take.flags.join('、') : UNKNOWN },
  ]
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="A/B 对比"
    width="760px"
    append-to-body
    @update:model-value="onVisibleInput"
    @close="close"
  >
    <div class="ns-cmp">
      <div class="ns-cmp__bar">
        <el-radio-group :model-value="mode" size="small" @update:model-value="onModeInput">
          <el-radio-button value="side">并排同时播</el-radio-button>
          <el-radio-button value="alternate">交替播放</el-radio-button>
          <el-radio-button value="split">左 A / 右 B</el-radio-button>
        </el-radio-group>

        <el-button size="small" type="primary" @click="playing ? pauseAll() : play()">
          {{ playing ? '⏸ 暂停' : '▶ 播放' }}
        </el-button>
        <el-button size="small" @click="applyPosition(0)">回到开头</el-button>
        <span class="ns-cmp__position">{{ formatDuration(positionMs, { showMs: true }) }}</span>
        <span v-if="mode === 'alternate'" class="ns-cmp__hint">
          每 {{ (switchMs / 1000).toFixed(1) }} 秒在 A / B 之间切换（当前：{{ activeSide === 'a' ? 'A' : 'B' }}）
        </span>
        <span v-else-if="mode === 'split'" class="ns-cmp__hint">请戴耳机：左耳是 A，右耳是 B</span>
      </div>

      <p v-if="!takeA || !takeB" class="ns-cmp__empty">
        需要选中两个 take 才能对比（在 take 列表里点「加入对比」，选满两个再打开本对话框）。
      </p>

      <div v-else class="ns-cmp__grid">
        <section class="ns-cmp__col" :class="{ 'is-active': mode === 'alternate' && activeSide === 'a' }">
          <header class="ns-cmp__col-head">
            <span class="ns-cmp__label">A</span>
            <span class="ns-cmp__time" :title="formatDate(takeA.recordedAt, 'YYYY-MM-DD HH:mm:ss')">
              {{ formatRelativeTime(takeA.recordedAt) }}
            </span>
            <span v-if="takeA.isSelected" class="ns-cmp__badge">当前成品</span>
          </header>
          <dl class="ns-cmp__metrics">
            <div v-for="item in metrics(takeA)" :key="item.label" class="ns-cmp__metric">
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </div>
          </dl>
          <label class="ns-cmp__volume">
            <span>音量</span>
            <input v-model.number="volumeA" type="range" min="0" max="1" step="0.01" @input="syncVolumes">
          </label>
          <el-button size="small" :disabled="takeA.isSelected" @click="pick(takeA.id)">设为成品</el-button>
        </section>

        <section class="ns-cmp__col" :class="{ 'is-active': mode === 'alternate' && activeSide === 'b' }">
          <header class="ns-cmp__col-head">
            <span class="ns-cmp__label">B</span>
            <span class="ns-cmp__time" :title="formatDate(takeB.recordedAt, 'YYYY-MM-DD HH:mm:ss')">
              {{ formatRelativeTime(takeB.recordedAt) }}
            </span>
            <span v-if="takeB.isSelected" class="ns-cmp__badge">当前成品</span>
          </header>
          <dl class="ns-cmp__metrics">
            <div v-for="item in metrics(takeB)" :key="item.label" class="ns-cmp__metric">
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </div>
          </dl>
          <label class="ns-cmp__volume">
            <span>音量</span>
            <input v-model.number="volumeB" type="range" min="0" max="1" step="0.01" @input="syncVolumes">
          </label>
          <el-button size="small" :disabled="takeB.isSelected" @click="pick(takeB.id)">设为成品</el-button>
        </section>
      </div>

      <!-- 两路播放元素：始终存在于 DOM（Web Audio 的 MediaElementSource 需要元素已挂载） -->
      <audio ref="audioA" class="ns-cmp__audio" :src="srcA" preload="auto" />
      <audio ref="audioB" class="ns-cmp__audio" :src="srcB" preload="auto" />
    </div>
  </el-dialog>
</template>

<style scoped>
.ns-cmp {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ns-cmp__bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-cmp__position {
  font-variant-numeric: tabular-nums;
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-cmp__empty {
  margin: 0;
  padding: 16px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 6px;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
}
.ns-cmp__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.ns-cmp__col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 6px;
}
.ns-cmp__col.is-active {
  border-color: var(--ns-primary, #409eff);
  box-shadow: 0 0 0 2px rgb(64 158 255 / 15%);
}
.ns-cmp__col-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ns-cmp__label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ns-primary, #409eff);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.ns-cmp__time {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-cmp__badge {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 3px;
  background: rgb(103 194 58 / 20%);
  color: var(--ns-success, #67c23a);
  font-size: 11px;
}
.ns-cmp__metrics {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  font-size: 12px;
}
.ns-cmp__metric {
  display: flex;
  gap: 8px;
}
.ns-cmp__metric dt {
  flex: 0 0 68px;
  color: var(--ns-text-secondary, #909399);
}
.ns-cmp__metric dd {
  margin: 0;
  color: var(--ns-text-regular, #606266);
}
.ns-cmp__volume {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-cmp__audio {
  display: none;
}
</style>
