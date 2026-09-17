<!--
  Novel Studio · 主控（docs/15 §9 MasterStrip、§4 响度标准化）
  ============================================================================
  主控只放「影响成品整体」的东西：目标响度、真峰、LRA、限幅、采样率/声道、头尾静音，
  以及**响度实测 + 增益推导**。

  为什么必须把「为什么建议这个增益」摊开写（docs/15 §4）：
    标准化不是「按一个预设就完事」。实际流程是
      Pass 1 测 input_i / input_tp / input_lra（loudnorm print_format=json）
      Pass 2 gainDb = 目标响度 − input_i（**线性 volume**，不是 loudnorm 二遍动态归一）
      Pass 3 复测验证
    用户看到「建议 +3.2 dB」时必须能自己核对这条算式，否则他只能选择相信工具 ——
    而这一步恰恰是最影响成品质量的（章间响度不齐是听众最容易听出来的问题）。
    因此下方的推导表把每一步的中间量都列了出来。

  MIX_TARGET_CONFLICT（响度与真峰目标冲突）：
    需要限幅器额外压掉 > 3 dB 时给出警告 —— loudnorm 二遍会压动态、逐章不齐，
    大幅压限则是直接失真。此时给一个「一键下调目标响度」的动作，而不是只弹个警告。

  说明：主进程没有 `mix:level` 实时电平事件，总表头由 MixerView 用 BusMeter 渲染
  （meterId = MASTER_METER_ID），预听时由 AbCompareBar 的 usePreview 推送实测电平。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMixStore, PEAK_REDUCTION_WARN_DB } from '../stores/mix.store.ts'
import type { LoudnessTargetRef } from '../stores/mix.store.ts'
import { useProcessChainStore } from '../stores/processChain.store.ts'
import { EXPORT_DEFAULTS, LOUDNESS_TARGETS, QC_THRESHOLDS } from '@shared/constants.ts'
import type { Id } from '@shared/types.ts'
import {
  formatDb,
  formatDbfs,
  formatLra,
  formatLufs,
  formatLu,
  formatRelativeTime,
  formatSampleRate,
  formatDuration,
} from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  /** 默认测量口径：整章口径更准（渲前 30 秒），单片段口径更快 */
  defaultMeasureScope?: 'chapter' | 'segment'
}>(), {
  defaultMeasureScope: 'chapter',
})

const emit = defineEmits<{
  /** MIX_TARGET_CONFLICT 的 action = open_settings：去设置页调整默认响度/真峰目标 */
  'open-settings': []
}>()

const mix = useMixStore()
const chain = useProcessChainStore()

onMounted(() => {
  if (!chain.segmentIndex.length) void chain.loadSegmentIndex()
})

const master = computed(() => mix.master)

/** 标准目标的一行提示（把 LOUDNESS_TARGETS 直接念出来，避免用户去翻文档） */
const targetHint = computed(() => (
  `LUFS；可选 ${LOUDNESS_TARGETS.map(item => `${item.label} ${item.lufs}`).join(' / ')}`
))

const savedText = computed(() => formatRelativeTime(mix.savedAt))

/** 目标响度：命中标准目标时下拉显示标准项，否则显示「自定义」 */
const targetSelectValue = computed(() => mix.matchedTargetId ?? 'custom')

const TARGET_OPTIONS = computed(() => [
  ...LOUDNESS_TARGETS.map(item => ({
    value: item.id,
    label: item.label,
    hint: `对应 LRA ${item.lra} LU`,
  })),
  { value: 'custom', label: '自定义…', hint: '非标准目标（如客户指定 -18 LUFS）' },
])

function applyTarget(value: unknown): void {
  const id = String(value ?? '')
  if (id === 'custom') return
  mix.applyLoudnessTargetPreset(id)
}

function setTargetLufs(value: unknown): void {
  const lufs = Number(value)
  if (!Number.isFinite(lufs)) return
  mix.patchMaster({ targetLufs: Math.min(-6, Math.max(-30, lufs)) })
}

function setTruePeak(value: unknown): void {
  const db = Number(value)
  if (!Number.isFinite(db)) return
  mix.patchMaster({ truePeakDb: Math.min(0, Math.max(-6, db)) })
}

function setLra(value: unknown): void {
  const lra = Number(value)
  if (!Number.isFinite(lra)) return
  mix.patchMaster({ lra: Math.min(30, Math.max(1, lra)) })
}

/** el-switch 的载荷是三态（boolean / string / number），这里只认「明确打开」*/
function onLimiterChange(value: boolean | string | number): void {
  mix.patchMaster({ limiterEnabled: value === true })
}

/** el-radio-group 的载荷是组内 el-radio-button 的 value：44100 / 48000 */
function onSampleRateChange(value: 44100 | 48000): void {
  mix.patchMaster({ sampleRate: Number(value) === 44100 ? 44100 : 48000 })
}

/** el-radio-group 的载荷是组内 el-radio-button 的 value：1 / 2 */
function onChannelsChange(value: 1 | 2): void {
  mix.patchMaster({ channels: Number(value) === 2 ? 2 : 1 })
}

// ── 响度测量（docs/15 §4 Pass 1）──────────────────────────────────────────
const measureScope = ref<'chapter' | 'segment'>(props.defaultMeasureScope)
const measureSegmentId = ref<string | null>(null)

/** el-radio-group 的载荷是组内 el-radio-button 的 value：'chapter' / 'segment' */
function onMeasureScopeChange(value: 'chapter' | 'segment'): void {
  measureScope.value = String(value) === 'segment' ? 'segment' : 'chapter'
}

/** el-select 的载荷是所选片段的 segmentId（el-option :value="item.segmentId"；清空时给空值）*/
function onMeasureSegmentChange(value: Id | null): void {
  measureSegmentId.value = value ?? null
}

const measureTarget = computed<LoudnessTargetRef | null>(() => {
  if (measureScope.value === 'segment') {
    const id = measureSegmentId.value
    if (!id) return null
    const label = chain.segmentIndex.find(item => item.segmentId === id)?.label ?? id.slice(0, 8)
    return { kind: 'segment', id, label }
  }
  // 章节口径才是「成品会是什么响度」的正确口径（docs/15 §8）
  return { kind: 'chapter', id: mix.currentId, label: '整章预览（前 30 秒）' }
})

const canMeasure = computed(() => measureTarget.value !== null && !mix.measuring)

async function measure(): Promise<void> {
  const target = measureTarget.value
  if (!target) return
  await mix.measureLoudness(target)
}

/** 推导表（每一项都对应 docs/15 §4 的一步，用户可自行核对） */
const derivationRows = computed(() => {
  const d = mix.loudnessDerivation
  if (!d) return []
  return [
    { step: '① 实测输入响度 input_i', value: formatLufs(d.inputI), note: 'loudnorm print_format=json 的 input_i' },
    { step: '② 目标响度', value: formatLufs(d.targetLufs), note: '成品要被归一到的积分响度' },
    { step: '③ 建议增益 = ② − ①', value: `${formatDb(d.gainDb)} dB`, note: '线性 volume，不做动态归一（保动态、章间齐）' },
    { step: '④ 预测真峰 = input_tp + ③', value: formatDbfs(d.predictedTpDb), note: `实测 input_tp ${formatDbfs(d.inputTp)}` },
    { step: '⑤ 需限幅压掉', value: `${formatDb(d.peakReductionDb)} dB`, note: `真峰目标 ${formatDbfs(master.value.truePeakDb)}；超过 ${PEAK_REDUCTION_WARN_DB} dB 视为冲突` },
  ]
})

/** 一键把目标响度下调到刚好不再冲突的值（冲突提示里的建议动作） */
function relaxTarget(): void {
  const d = mix.loudnessDerivation
  if (!d) return
  const delta = d.peakReductionDb - PEAK_REDUCTION_WARN_DB
  mix.patchMaster({ targetLufs: Number((master.value.targetLufs - Math.max(0.1, delta)).toFixed(1)) })
}

const measuredAt = computed(() => {
  if (!mix.loudness) return null
  return mix.loudnessTarget?.label ?? '上次测量'
})
</script>

<template>
  <section class="ns-master">
    <header class="ns-master__head">
      <div>
        <h3>主控</h3>
        <p class="ns-hint">
          这里是成品的整体口径：目标响度决定「多响」，真峰决定「会不会削顶」，两者必须相容。
        </p>
      </div>
      <el-tag size="small" type="info">{{ formatSampleRate(master.sampleRate) }}</el-tag>
    </header>

    <!-- 目标响度 -->
    <div class="ns-master__row">
      <span class="ns-label">目标响度</span>
      <el-select
        :model-value="targetSelectValue"
        size="small"
        class="ns-master__select"
        @change="applyTarget"
      >
        <el-option v-for="item in TARGET_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-input-number
        :model-value="master.targetLufs"
        :min="-30"
        :max="-6"
        :step="0.5"
        size="small"
        controls-position="right"
        @change="setTargetLufs"
      />
      <span class="ns-hint">{{ targetHint }}</span>
    </div>

    <!-- 真峰与 LRA -->
    <div class="ns-master__row">
      <span class="ns-label">真峰上限</span>
      <el-input-number
        :model-value="master.truePeakDb"
        :min="-6"
        :max="0"
        :step="0.1"
        :precision="1"
        size="small"
        controls-position="right"
        @change="setTruePeak"
      />
      <span class="ns-hint">dBTP；默认 {{ EXPORT_DEFAULTS.truePeakDb }}，用 alimiter 兜底并以复测为准</span>
    </div>

    <div class="ns-master__row">
      <span class="ns-label">LRA 目标</span>
      <el-input-number
        :model-value="master.lra"
        :min="1"
        :max="30"
        :step="1"
        size="small"
        controls-position="right"
        @change="setLra"
      />
      <span class="ns-hint">LU；有声书通常 8~12（过大说明动态失控，过小说明压得太死）</span>
    </div>

    <!-- 限幅 / 采样率 / 声道 -->
    <div class="ns-master__row">
      <span class="ns-label">限幅器</span>
      <el-switch
        :model-value="master.limiterEnabled"
        size="small"
        @change="onLimiterChange"
      />
      <span class="ns-hint">
        关掉后真峰只能靠增益与素材本身保证；有声书成品建议保持开启
      </span>
    </div>

    <div class="ns-master__row">
      <span class="ns-label">采样率</span>
      <el-radio-group
        :model-value="master.sampleRate"
        size="small"
        @change="onSampleRateChange"
      >
        <el-radio-button :value="44100">44.1 kHz</el-radio-button>
        <el-radio-button :value="48000">48 kHz</el-radio-button>
      </el-radio-group>
      <span class="ns-hint">MP3 常用 44.1 kHz；WAV 交付建议 48 kHz（与内部工作格式一致，避免重采样）</span>
    </div>

    <div class="ns-master__row">
      <span class="ns-label">声道</span>
      <el-radio-group
        :model-value="master.channels"
        size="small"
        @change="onChannelsChange"
      >
        <el-radio-button :value="1">单声道</el-radio-button>
        <el-radio-button :value="2">立体声</el-radio-button>
      </el-radio-group>
      <span class="ns-hint">纯人声单声道更省空间也更稳；带 BGM/音效且做了声像时选立体声</span>
    </div>

    <!-- MIX_TARGET_CONFLICT：响度与真峰目标冲突 -->
    <el-alert
      v-if="mix.targetConflict"
      class="ns-master__conflict"
      type="warning"
      :closable="false"
      show-icon
      title="响度与峰值目标冲突"
      :description="mix.targetConflict.suggestion"
    >
      <div class="ns-master__conflict-ops">
        <el-button size="small" type="warning" @click="relaxTarget">下调目标响度</el-button>
        <el-button size="small" @click="emit('open-settings')">去设置页改默认目标</el-button>
      </div>
    </el-alert>

    <!-- 响度测量 -->
    <section class="ns-master__measure">
      <header class="ns-master__measure-head">
        <h4>响度实测</h4>
        <el-radio-group
          :model-value="measureScope"
          size="small"
          @change="onMeasureScopeChange"
        >
          <el-radio-button value="chapter">整章口径</el-radio-button>
          <el-radio-button value="segment">单片段</el-radio-button>
        </el-radio-group>
      </header>

      <p class="ns-hint">
        整章口径会先渲染一段章节预览（前 30 秒）再测量 —— 这才是「成品会是什么响度」的正确口径
        （预听与最终渲染可能不一致，docs/15 §8）。单片段口径快，适合快速判断某条录音是不是特别响/特别轻。
      </p>

      <div v-if="measureScope === 'segment'" class="ns-master__row">
        <el-select
          :model-value="measureSegmentId"
          size="small"
          filterable
          clearable
          placeholder="选择片段"
          class="ns-master__select"
          @change="onMeasureSegmentChange"
        >
          <el-option
            v-for="item in chain.segmentIndex"
            :key="item.segmentId"
            :label="item.label"
            :value="item.segmentId"
          />
        </el-select>
        <el-button size="small" @click="chain.loadSegmentIndex(true)">刷新片段索引</el-button>
      </div>

      <div class="ns-master__row">
        <el-button size="small" type="primary" :loading="mix.measuring" :disabled="!canMeasure" @click="measure">
          测量响度
        </el-button>
        <el-button size="small" :disabled="!mix.loudness" @click="mix.clearLoudness()">清除结果</el-button>
        <span v-if="measuredAt" class="ns-hint">口径：{{ measuredAt }}</span>
        <span v-else-if="mix.measuring" class="ns-hint">正在渲染/测量…</span>
      </div>

      <div v-if="mix.loudness" class="ns-master__measure-grid">
        <div class="ns-master__measure-card">
          <span class="ns-label">输入积分响度 input_i</span>
          <strong>{{ formatLufs(mix.loudness.inputI) }}</strong>
        </div>
        <div class="ns-master__measure-card">
          <span class="ns-label">输入真峰 input_tp</span>
          <strong>{{ formatDbfs(mix.loudness.inputTp) }}</strong>
        </div>
        <div class="ns-master__measure-card">
          <span class="ns-label">输入响度范围 input_lra</span>
          <strong>{{ formatLra(mix.loudness.inputLra) }}</strong>
        </div>
        <div class="ns-master__measure-card">
          <span class="ns-label">门限 input_thresh</span>
          <strong>{{ formatDbfs(mix.loudness.inputThresh) }}</strong>
        </div>
        <div class="ns-master__measure-card">
          <span class="ns-label">目标偏移 target_offset</span>
          <strong>{{ formatLu(mix.loudness.targetOffset) }}</strong>
        </div>
        <div class="ns-master__measure-card">
          <span class="ns-label">实测时长 / 采样率</span>
          <strong>
            {{ formatDuration(mix.loudnessMetric?.durationMs) }} ·
            {{ formatSampleRate(mix.loudnessMetric?.sampleRate ?? null) }}
          </strong>
        </div>
      </div>
      <p v-else class="ns-hint">还没有测量结果：点「测量响度」后这里会显示 input_i / input_tp / input_lra 等实测值。</p>

      <!-- 为什么建议这个增益：逐步推导 -->
      <div v-if="derivationRows.length" class="ns-master__derive">
        <h5>为什么建议这个增益</h5>
        <ul>
          <li v-for="row in derivationRows" :key="row.step">
            <span class="ns-master__derive-step">{{ row.step }}</span>
            <strong>{{ row.value }}</strong>
            <span class="ns-hint">{{ row.note }}</span>
          </li>
        </ul>
        <p :class="mix.targetConflict ? 'ns-master__warn' : 'ns-hint'">
          {{ mix.loudnessDerivation?.suggestion }}
        </p>
        <p class="ns-hint">
          复测口径：导出前会用同一套测量再验一次，偏差超过
          {{ QC_THRESHOLDS.lufsTolerance }} LU 会微调一次（docs/15 §4 Pass 3）
        </p>
      </div>
    </section>

    <p v-if="!mix.current" class="ns-hint">未选择混音方案：先在上面选择或新建一个方案</p>
    <p v-else class="ns-hint">
      方案：{{ mix.current.name }} · 轨道 {{ mix.tracks.length }} 条 · 最后保存：{{ savedText }}
    </p>
  </section>
</template>

<style scoped>
.ns-master { display: flex; flex-direction: column; gap: 8px; }
.ns-master__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ns-master h3 { margin: 0; font-size: 14px; color: var(--ns-text-primary, #303133); }
.ns-master h4 { margin: 0; font-size: 12.5px; color: var(--ns-text-primary, #303133); }
.ns-master h5 { margin: 0 0 4px; font-size: 12px; color: var(--ns-text-primary, #303133); }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-label { min-width: 86px; color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-master__row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-master__select { width: 200px; }
.ns-master__conflict { margin: 0; }
.ns-master__conflict-ops { display: flex; gap: 6px; margin-top: 6px; }
.ns-master__measure {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-subtle, #fafafa);
}
.ns-master__measure-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ns-master__measure-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.ns-master__measure-card {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-elevated, #fff);
}
.ns-master__measure-card strong { color: var(--ns-text-primary, #303133); font: 600 12px/1.2 ui-monospace, Consolas, monospace; }
.ns-master__derive { padding-top: 4px; border-top: 1px dashed var(--ns-border, #dcdfe6); }
.ns-master__derive ul { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.ns-master__derive li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.ns-master__derive-step { min-width: 168px; color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-master__derive strong { color: var(--ns-primary, #409eff); font: 600 12px/1 ui-monospace, Consolas, monospace; }
.ns-master__warn { margin: 0; color: var(--ns-warning, #e6a23c); font-size: 11.5px; line-height: 1.5; }
</style>
