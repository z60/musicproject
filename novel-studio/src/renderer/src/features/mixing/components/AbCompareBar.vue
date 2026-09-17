<!--
  Novel Studio · A/B 对比条（docs/14 §10 预听与对比、docs/15 §8 试听与预览）
  ============================================================================
  A = 原始（take 原素材，直接 `ns-media://` URL，不需要渲染）
  B = 处理后（`process:preview` 真渲染出来的产物）

  「同一位置切换」是这个组件存在的唯一理由：
    听两段音频的差别时，位置一变人耳就会重新适应，判断立刻失效。
    所以 `usePreview.setSide()` 会先记住 currentTime、换 src、再 seek 回同一毫秒，
    切换才是有意义的（docs/15 §12 的测试要点之一）。

  盲听（docs/14 §10）：勾选后隐藏「原始/处理后」的标签，并**随机**把 A/B 映射成 ①②，
  避免「我知道哪边是处理后的，所以觉得它更好听」的心理暗示。选择完再揭晓。

  三处真实数据，不做假动画：
    · 播放位置/时长 → usePreview 的 audio 元素；
    · 两侧电平（rms/peak）→ 渲染后紧跟 analysis:metrics 的实测值（store 里已测好）；
    · 播放时的电平还会推给 MASTER_METER_ID，让主控表头动起来（混音台里唯一有真实数据的表头）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import FaderControl from './FaderControl.vue'
import { useProcessChainStore } from '../stores/processChain.store.ts'
import { usePreview } from '../composables/usePreview.ts'
import { MASTER_METER_ID } from '../stores/mix.store.ts'
import { formatDb, formatDuration } from '@/shared/lib/format.ts'
import type { PreviewSide } from '../composables/usePreview.ts'

const props = withDefaults(defineProps<{
  /** 播放时把实测电平推给哪个表头（默认主控总线；传空字符串则不推） */
  meterId?: string
}>(), {
  meterId: MASTER_METER_ID,
})

const emit = defineEmits<{
  /** 用户「采用该版本」成功（视图可据此刷新轨道/片段状态提示） */
  resolved: [side: PreviewSide]
}>()

const chain = useProcessChainStore()

/** 预听实例：播放时把实测电平推给主控表头 */
const preview = usePreview({ meterId: props.meterId || null })

const ab = computed(() => chain.ab)
const playing = computed(() => preview.playing.value)
const positionMs = computed(() => preview.positionMs.value)
const durationMs = computed(() => preview.durationMs.value)
const previewLoading = computed(() => preview.loading.value)
const currentSide = computed(() => preview.side.value)

const hint = ref<string | null>(null)
/** 盲听时的随机映射：true 表示「① 实际是 B」 */
const blindSwap = ref(false)

// ── 与 store 的 A/B 状态双向同步 ──────────────────────────────────────────
watch(() => [ab.value.originalUrl, ab.value.processedUrl, ab.value.originalLevels, ab.value.processedLevels], () => {
  preview.setSources(
    ab.value.originalUrl
      ? { url: ab.value.originalUrl, label: 'A · 原始', levels: ab.value.originalLevels }
      : null,
    ab.value.processedUrl
      ? { url: ab.value.processedUrl, label: 'B · 处理后', levels: ab.value.processedLevels }
      : null,
  )
}, { immediate: true, deep: true })

// store 侧要求切到某一侧（例如新的一次对比默认停在 A）时同步过去
watch(() => ab.value.side, (side) => {
  if (side === currentSide.value) return
  void preview.setSide(side, { keepPosition: true, autoplay: playing.value })
})

// 新的对比开始时给出可操作的提示
watch(() => [ab.value.enabled, ab.value.loading], () => {
  if (!ab.value.enabled) {
    hint.value = null
    return
  }
  if (ab.value.loading) hint.value = '正在渲染 B（处理后）…原始素材可以直接听'
  else if (ab.value.processedUrl) hint.value = '可反复切换 A/B 对比；切换会保持同一播放位置'
})

// ── 播放控制 ──────────────────────────────────────────────────────────────
async function togglePlay(): Promise<void> {
  if (!ab.value.originalUrl && !ab.value.processedUrl) {
    hint.value = '两侧都还没有可播放的产物'
    return
  }
  await preview.toggle()
}

async function switchSide(side: PreviewSide): Promise<void> {
  await preview.setSide(side, { keepPosition: true, autoplay: playing.value })
  chain.patchAb({ side })
}

function stop(): void {
  preview.stop()
  preview.seek(0)
}

// 拖动进度：拖动中显示拖动值，松手才真正 seek（避免每帧 seek 造成「跳音」）
const seeking = ref(false)
const seekingMs = ref(0)
const sliderValue = computed(() => (seeking.value ? seekingMs.value : positionMs.value))

function onSliderInput(value: number): void {
  seeking.value = true
  seekingMs.value = value
}

function onSliderChange(value: number): void {
  seeking.value = false
  preview.seek(value)
}

// ── 盲听 ──────────────────────────────────────────────────────────────────
const sideOrder = computed<PreviewSide[]>(() => (
  ab.value.blind && blindSwap.value ? ['B', 'A'] : ['A', 'B']
))

function toggleBlind(): void {
  const next = !ab.value.blind
  // 开启盲听时随机决定 ① 是 A 还是 B（否则「先听到的总是原始」也会形成暗示）
  blindSwap.value = next ? Math.random() < 0.5 : false
  chain.patchAb({ blind: next })
  hint.value = next
    ? '盲听已开启：标签已隐藏，①② 与 A/B 的对应关系已随机打乱；用「采用该版本」时才会揭晓'
    : '盲听已关闭：恢复显示「原始 / 处理后」'
}

function sideText(side: PreviewSide): string {
  if (!ab.value.blind) return side === 'A' ? 'A · 原始' : 'B · 处理后'
  return sideOrder.value.indexOf(side) === 0 ? '①' : '②'
}

function sideLevels(side: PreviewSide): { rmsDb: number | null; peakDb: number | null } | null {
  if (ab.value.blind) return null
  return side === 'A' ? ab.value.originalLevels : ab.value.processedLevels
}

// ── 采用该版本 / 重新生成 / 关闭 ─────────────────────────────────────────
async function adopt(): Promise<void> {
  const side = currentSide.value
  const ok = await chain.rememberAbSide(side)
  if (!ok) {
    hint.value = '采用失败：请检查该片段是否仍有处理任务在跑'
    return
  }
  emit('resolved', side)
  hint.value = side === 'A'
    ? '已采用「原始」：该片段的处理结果已回退'
    : '已采用「处理后」：已用当前处理链重新处理该片段'
  // 采用之后揭晓盲听映射，用户才能知道自己刚才选的是哪一侧
  if (ab.value.blind) hint.value += `（揭晓：① = ${blindSwap.value ? 'B · 处理后' : 'A · 原始'}）`
}

async function regenerate(): Promise<void> {
  if (!ab.value.segmentId) return
  hint.value = '正在用当前处理链重新渲染 B…'
  await chain.openAbCompare(ab.value.segmentId, { label: ab.value.label })
}

function close(): void {
  preview.stop()
  preview.releaseMeter()
  chain.closeAbCompare()
}

onBeforeUnmount(() => {
  preview.stop()
  preview.releaseMeter()
})
</script>

<template>
  <section v-if="ab.enabled" class="ns-ab">
    <div class="ns-ab__label">
      <strong>对比试听</strong>
      <span class="ns-ab__title">{{ ab.blind ? '盲听中（标签已隐藏）' : ab.label }}</span>
      <el-tag v-if="ab.mode === 'ducking'" size="small" type="info">闪避对比</el-tag>
      <span v-if="ab.loading || previewLoading" class="ns-hint">B 侧渲染中…</span>
    </div>

    <div class="ns-ab__sides">
      <el-button
        v-for="side in sideOrder"
        :key="side"
        size="small"
        :type="currentSide === side ? 'primary' : 'default'"
        :disabled="(side === 'A' ? !ab.originalUrl : !ab.processedUrl)"
        @click="switchSide(side)"
      >
        {{ sideText(side) }}
      </el-button>

      <div class="ns-ab__levels">
        <span v-if="ab.blind" class="ns-hint">盲听模式：不显示两侧电平，避免先入为主</span>
        <template v-else>
          <span class="ns-hint">
            A：RMS {{ formatDb(sideLevels('A')?.rmsDb) }} / 峰值 {{ formatDb(sideLevels('A')?.peakDb) }} dBFS
          </span>
          <span class="ns-hint">
            B：RMS {{ formatDb(sideLevels('B')?.rmsDb) }} / 峰值 {{ formatDb(sideLevels('B')?.peakDb) }} dBFS
          </span>
          <span v-if="sideLevels('B')" class="ns-hint">实测值来自 analysis:metrics</span>
        </template>
      </div>
    </div>

    <div class="ns-ab__transport">
      <el-button size="small" :disabled="!ab.originalUrl && !ab.processedUrl" @click="togglePlay">
        {{ playing ? '暂停' : '播放' }}
      </el-button>
      <el-button size="small" :disabled="!playing && positionMs === 0" @click="stop">回到开头</el-button>

      <FaderControl
        class="ns-ab__seek"
        :model-value="sliderValue"
        :min="0"
        :max="Math.max(1000, durationMs)"
        :step="10"
        :default-value="0"
        label="位置"
        unit="ms"
        hint="拖动定位；双击回到开头。A/B 切换会保持同一位置"
        :precision="0"
        :height="90"
        compact
        @update:model-value="onSliderInput"
        @change="onSliderChange"
      />

      <span class="ns-ab__time">{{ formatDuration(positionMs, { showMs: true }) }} / {{ formatDuration(durationMs) }}</span>
    </div>

    <div class="ns-ab__ops">
      <el-button size="small" :type="ab.blind ? 'warning' : 'default'" @click="toggleBlind">
        {{ ab.blind ? '退出盲听' : '盲听模式' }}
      </el-button>
      <el-button size="small" type="primary" @click="adopt">采用该版本（{{ sideText(currentSide) }}）</el-button>
      <el-button size="small" :disabled="!ab.segmentId || ab.loading" @click="regenerate">重新渲染 B</el-button>
      <el-button size="small" text @click="close">关闭对比</el-button>
      <span v-if="ab.remembered" class="ns-hint">上次采用：{{ ab.remembered === 'A' ? '原始' : '处理后' }}</span>
    </div>

    <p v-if="hint" class="ns-ab__hint">{{ hint }}</p>
    <p v-if="ab.error" class="ns-ab__error">
      B 侧渲染失败：可点「重新渲染 B」重试，或先检查 ffmpeg 能力探测结果
    </p>
  </section>
</template>

<style scoped>
.ns-ab {
  position: sticky; bottom: 0; z-index: 12;
  display: flex; flex-direction: column; gap: 6px; padding: 8px 12px;
  border-top: 2px solid var(--ns-primary, #409eff);
  background: var(--ns-bg-elevated, #fff); box-shadow: 0 -4px 14px rgb(0 0 0 / 8%);
}
.ns-ab__label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-ab__label strong { color: var(--ns-text-primary, #303133); font-size: 12.5px; }
.ns-ab__title { color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-ab__sides { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-ab__levels { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.ns-ab__transport { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-ab__seek { min-width: 260px; flex: 1 1 260px; }
.ns-ab__time { color: var(--ns-text-regular, #606266); font: 11px/1 ui-monospace, Consolas, monospace; }
.ns-ab__ops { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ns-ab__hint { margin: 0; color: var(--ns-primary, #409eff); font-size: 11.5px; }
.ns-ab__error { margin: 0; color: var(--ns-danger, #f56c6c); font-size: 11.5px; }
</style>
