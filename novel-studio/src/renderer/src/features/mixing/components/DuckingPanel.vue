<!--
  Novel Studio · 自动闪避（docs/14 §9）与开/关对比试听（docs/14 §10）
  ============================================================================
  参数口径（docs/14 §9 的 DuckingConfig）：
    · amountDb     下潜量，默认 -12 dB（BGM 在人声出现时降多少）
    · thresholdDb  触发阈值，默认 -30 dB（人声电平）—— UI 用 dB，
                   但渲染侧 `sidechaincompress.threshold` 是**线性 0~1**，转换在主进程做
    · attackMs     20 ms 起跳
    · releaseMs    400 ms 恢复；**太短会让 BGM 在人声停顿处「抽气」**，比不 duck 还难听
    · mode         'sidechain' = ffmpeg sidechaincompress（真实侧链）
                   'envelope'  = 按画本行时间精确计算（3.0 能力，当前为占位语义）

  MIX_DUCKING_SIDECHAIN_MISSING（必须提前提示，而不是等渲染出来才发现）：
    侧链源用**人声总线**。一旦 Solo 把所有人声压住、或方案里根本没有可用人声轨，
    侧链就没有信号，BGM 不会下潜，成品会「按普通模式混合」。这种情况在面板里直接说清楚。

  「开/关对比」为什么要真渲染两次（store.previewDuckingCompare 已实现）：
    ducking 是混音期效果，渲染进程里模拟不出来；只能渲一遍关、再渲一遍开，
    两段落进 A/B 对比条同一位置切换 —— 这也是 docs/15 §8 强调「以真实渲染为准」的落地。
-->

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import FaderControl from './FaderControl.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { useMixStore } from '../stores/mix.store.ts'
import { formatDb } from '@/shared/lib/format.ts'
import type { DuckingConfig, Id } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  /** 指定要编辑的音乐轨；不传则跟随混音台当前选中的音乐轨 */
  trackId?: Id | null
}>(), {
  trackId: null,
})

const emit = defineEmits<{
  /** 已生成开/关对比 → 视图可以把底部 A/B 对比条高亮出来 */
  'ab-ready': []
}>()

const mix = useMixStore()

/** 编辑目标：默认当前选中的音乐轨，也可以在这里直接切换（多轨 BGM 时很常见） */
const targetId = ref<Id | null>(null)

onMounted(() => {
  targetId.value = props.trackId ?? mix.selectedMusicTrack?.id ?? mix.musicTracks[0]?.id ?? null
})

// 视图显式指定目标轨时跟随（例如从通道条点进来）
watch(() => props.trackId, (next) => {
  if (next) targetId.value = next
})

/** el-select 的载荷是所选音乐轨 id（el-option :value="track.id"；清空时给空值）*/
function onTargetChange(value: Id | null): void {
  targetId.value = value ?? null
}

const targetTrack = computed(() => (
  mix.musicTracks.find(track => track.id === targetId.value)
  ?? mix.selectedMusicTrack
  ?? mix.musicTracks[0]
  ?? null
))

const config = computed<DuckingConfig | null>(() => targetTrack.value?.music?.ducking ?? null)

const configHint = computed(() => (config.value
  ? `当前：${config.value.enabled ? '开' : '关'} · 下潜 ${formatDb(config.value.amountDb)} dB · `
    + `阈值 ${formatDb(config.value.thresholdDb)} dB · ${config.value.attackMs}/${config.value.releaseMs} ms`
  : '该轨还没有闪避配置'))

/** 侧链缺失（docs/14 §9 常见错误 1）：Solo 把人声压住 / 没有人声轨 */
const sidechainMissing = computed(() => (
  config.value?.enabled === true
  && config.value.mode === 'sidechain'
  && (!mix.voiceTracks.length || !mix.voiceAudible)
))

const missingReason = computed(() => {
  if (!mix.voiceTracks.length) return '当前混音方案里没有任何人声轨，侧链压缩没有可用的侧链源。'
  return 'Solo 把所有人声都压住了：侧链源被静音，BGM 不会下潜（已按普通模式混合）。'
})

function patch(patchValue: Partial<DuckingConfig>): void {
  const track = targetTrack.value
  if (!track) return
  mix.patchMusicDucking(track.id, patchValue)
}

/** el-switch 的载荷是三态（boolean / string / number），这里只认「明确打开」*/
function onEnabledChange(value: boolean | string | number): void {
  patch({ enabled: value === true })
}

/**
 * el-radio-group 的载荷是组内 el-radio-button 的 value：'sidechain' / 'envelope'。
 *
 * **但参数必须声明成宽类型**：Element Plus 2.14 起把 `change` /
 * `update:model-value` 的参数类型定为 `string | number | boolean | undefined`，
 * 而函数参数是逆变的 —— 声明成精确联合会让它**不可赋值**给组件的事件签名。
 * 所以收宽 + 体内收窄（收窄后依旧类型安全）。
 */
function onModeChange(value: string | number | boolean | undefined): void {
  patch({ mode: String(value) === 'envelope' ? 'envelope' : 'sidechain' })
}

const compareRunning = computed(() => mix.duckingCompareRunning)
const lastCompare = ref<string | null>(null)

async function runCompare(): Promise<void> {
  const ok = await mix.previewDuckingCompare()
  lastCompare.value = ok
    ? '已生成对比：A = 关闪避 / B = 开闪避（在底部对比条同一位置切换试听）'
    : '对比生成失败：可能是章节还没渲染产物，或方案未保存'
  if (ok) emit('ab-ready')
}

/** 把当前这套闪避参数套用到全部 BGM/SFX 轨（一次配好全章） */
function applyToAll(): void {
  const current = config.value
  const track = targetTrack.value
  if (!current || !track) return
  for (const item of [...mix.musicTracks, ...mix.sfxTracks]) {
    if (item.id === track.id) continue
    mix.patchMusicDucking(item.id, { ...current })
  }
}
</script>

<template>
  <section class="ns-duck">
    <header class="ns-duck__head">
      <div>
        <h3>自动闪避（ducking）</h3>
        <p class="ns-hint">
          人声出现时把 BGM 自动压低，人声停下再恢复。有声书里这是「BGM 不抢人声」唯一靠谱的做法。
        </p>
      </div>
      <el-select
        v-if="mix.musicTracks.length"
        :model-value="targetTrack?.id ?? null"
        size="small"
        class="ns-duck__select"
        @change="onTargetChange"
      >
        <el-option
          v-for="track in mix.musicTracks"
          :key="track.id"
          :label="`${track.name}（${formatDb(track.gainDb)} dB）`"
          :value="track.id"
        />
      </el-select>
    </header>

    <EmptyState
      v-if="!targetTrack || !config"
      size="small"
      icon="🎚️"
      title="没有可配置的音乐轨"
      description="先在混音台新增一条 BGM/音效轨并指定素材，再来配置闪避"
    />

    <template v-else>
      <div class="ns-duck__row">
        <span class="ns-label">启用</span>
        <el-switch
          :model-value="config.enabled"
          size="small"
          @change="onEnabledChange"
        />
        <span class="ns-hint">{{ configHint }}</span>
      </div>

      <div class="ns-duck__row">
        <span class="ns-label">模式</span>
        <el-radio-group
          :model-value="config.mode"
          size="small"
          @change="onModeChange"
        >
          <el-radio-button value="sidechain">侧链压缩</el-radio-button>
          <el-radio-button value="envelope">按画本行包络</el-radio-button>
        </el-radio-group>
        <span class="ns-hint">
          侧链压缩用真实人声总线做侧链（推荐）；包络模式按画本行时间精确计算，适合人声停顿位置固定的稿子
        </span>
      </div>

      <el-alert
        v-if="sidechainMissing"
        class="ns-duck__alert"
        type="warning"
        :closable="false"
        show-icon
        title="自动闪避无法生效：缺少可用的人声侧链信号"
        :description="`${missingReason}可用「按画本行包络」模式，或取消 Solo / 补上人声轨。`"
      />

      <!-- 参数（五要素：滑块 + 数字输入 + 单位范围提示 + 双击复原）-->
      <div class="ns-duck__params">
        <FaderControl
          :model-value="config.amountDb"
          :min="-30"
          :max="0"
          :step="0.5"
          :default-value="mix.duckingDefaults.amountDb"
          label="下潜量"
          unit="dB"
          hint="下潜量 -30~0 dB，默认 -12；下潜太浅会被音乐盖住，太深会听到音乐「掉下去」"
          :precision="1"
          :height="110"
          compact
          @change="(value) => patch({ amountDb: value })"
        />
        <FaderControl
          :model-value="config.thresholdDb"
          :min="-60"
          :max="0"
          :step="1"
          :default-value="mix.duckingDefaults.thresholdDb"
          label="触发阈值"
          unit="dB"
          hint="阈值 -60~0 dB，默认 -30；界面用 dB，主进程会转成 sidechaincompress 需要的线性值"
          :precision="0"
          :height="110"
          compact
          @change="(value) => patch({ thresholdDb: value })"
        />
        <FaderControl
          :model-value="config.attackMs"
          :min="0"
          :max="500"
          :step="5"
          :default-value="mix.duckingDefaults.attackMs"
          label="起跳"
          unit="ms"
          hint="起跳 0~500 ms，默认 20；太慢会漏掉人声的第一个字"
          :precision="0"
          :height="110"
          compact
          @change="(value) => patch({ attackMs: value })"
        />
        <FaderControl
          :model-value="config.releaseMs"
          :min="20"
          :max="2000"
          :step="10"
          :default-value="mix.duckingDefaults.releaseMs"
          label="恢复"
          unit="ms"
          hint="恢复 20~2000 ms，默认 400；太短会「抽气」（人声一停音乐猛冲回来），比不闪避还难听"
          :precision="0"
          :height="110"
          compact
          @change="(value) => patch({ releaseMs: value })"
        />
      </div>

      <div class="ns-duck__ops">
        <el-button size="small" type="primary" :loading="compareRunning" @click="runCompare">
          开/关闪避对比试听
        </el-button>
        <el-button size="small" @click="applyToAll">参数套用到全部 BGM/音效轨</el-button>
        <span class="ns-hint">
          对比会真渲染两遍（关一遍、开一遍），需要几十秒；结果落在底部 A/B 对比条
        </span>
      </div>

      <p v-if="lastCompare" class="ns-duck__result">{{ lastCompare }}</p>
    </template>
  </section>
</template>

<style scoped>
.ns-duck { display: flex; flex-direction: column; gap: 8px; }
.ns-duck__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ns-duck h3 { margin: 0; font-size: 13.5px; color: var(--ns-text-primary, #303133); }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-label { min-width: 62px; color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-duck__select { width: 200px; }
.ns-duck__row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-duck__alert { margin: 0; }
.ns-duck__params { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.ns-duck__ops { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-duck__result { margin: 0; color: var(--ns-success, #67c23a); font-size: 11.5px; }
</style>
