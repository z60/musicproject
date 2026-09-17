<!--
  Novel Studio · 处理链编辑器（docs/14 §2 处理链、§4.3 参数五要素、§5 噪声轮廓、§6 修补工具）
  ============================================================================
  固定执行顺序（docs/14 §2.1，**不可调换**，因此本组件不提供上移/下移）：
    ① 修补（前置：去 DC / 极性）② 高通 ③ 降噪 ④ 去齿音 ⑤ EQ ⑥ 压缩 ⑦ 限幅 ⑧ 修补（后置：declick / 静音填充 / 变速）
  顺序本身就是需求：降噪必须在 EQ/压缩之前（压缩会先抬小信号，把噪声一起抬起来），
  去齿音必须在压缩之前（否则压缩器会被 s/sh 瞬态误触发）。理由直接显示在模块头上，
  避免用户以为是「忘了做拖拽排序」。

  参数 UI 五要素（docs/14 §4.3）逐条落地：
    ① 滑块 + 数字输入        → FaderControl（它同时提供两者，且数值可精调）
    ② 单位与范围提示          → FaderControl 的 hint 直接来自 PARAM_SPECS（如「降噪量 0.01~97 dB，建议 6~18」）
    ③ 双击恢复默认            → FaderControl 的双击复位（默认值取自 PARAM_SPECS.defaultValue）
    ④ EQ 响应曲线可视化       → EqCurveCanvas（可拖动控制点）
    ⑤ A/B 试听按钮            → 每个模块头的「A/B 试听」→ store.previewSingleModule（内部走 process:preview）

  能力探测（docs/14 §3.1）：ffmpeg 缺失或缺少滤镜时，模块**禁用**并在原地说明原因，
  而不是等用户点了才报错。数据源与设置页同一条 `ffmpeg:capabilities`。

  交互约定（整个 mixing 域统一）：业务组件直接调 store，只有纯受控的展示组件（EqCurveCanvas）
  才用 props/emits。因此本组件没有一堆「上抛事件」。
-->

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import FaderControl from './FaderControl.vue'
import EqCurveCanvas from './EqCurveCanvas.vue'
import { useProcessChainStore } from '../stores/processChain.store.ts'
import {
  CHAIN_MODULES,
  PARAM_SPECS,
  moduleSummary,
} from '../stores/processChain.store.ts'
import type { ChainModuleKey, ParamKey } from '../stores/processChain.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { usePresetsStore } from '../stores/presets.store.ts'
import { formatDb } from '@/shared/lib/format.ts'
import type { EqBand, Id } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  /** EQ 曲线高度：主控栏较窄时视图可以传小一点（默认 220） */
  curveHeight?: number
}>(), {
  curveHeight: 220,
})

const emit = defineEmits<{
  /** 用户想把当前链套用到多个片段：由视图打开 PresetApplyDialog（属于视图级的对话框） */
  'apply-request': []
  /** 用户点了「查看批量报告」 */
  'report-request': []
}>()

const chain = useProcessChainStore()
const settings = useSettingsStore()
const presets = usePresetsStore()

onMounted(() => {
  // 已探测过就不重复请求（store 内部有缓存）
  void chain.loadFfmpegCapabilities()
  void chain.loadSegmentIndex()
})

// ── 试听目标片段（A/B 试听必须有落点，docs/14 §10）────────────────────────
const targetSegmentId = ref<string | null>(null)

watch(() => chain.segmentIndex, (index) => {
  if (!targetSegmentId.value && index.length) targetSegmentId.value = index[0]?.segmentId ?? null
}, { immediate: true })

const selectedSegmentLabel = computed(() => {
  const hit = chain.segmentIndex.find(item => item.segmentId === targetSegmentId.value)
  return hit?.label ?? '（未选择片段）'
})

/** 试听目标片段：el-select 的 change 载荷即选项值（SegmentRef.segmentId，类型 Id），清空时为 null */
function onTargetSegmentChange(value: Id | null): void {
  targetSegmentId.value = value ?? null
}

// ── 能力探测提示（docs/14 §3.1）───────────────────────────────────────────
const capabilityAlert = computed<string | null>(() => {
  // chain store 与 settings store 读的是同一份 ffmpeg:capabilities；
  // 未探测完（都还是 null）时不下结论，避免「一进页面全部变灰」。
  const missing = chain.missingFilters.length ? chain.missingFilters : settings.missingFilters
  const unavailable = chain.ffmpegCaps
    ? !chain.ffmpegAvailable
    : settings.capabilities
      ? !settings.ffmpegReady
      : false
  if (unavailable) {
    return '本机未检测到可用的 ffmpeg：处理相关的模块已禁用。可到设置页配置 ffmpeg 路径后重新探测。'
  }
  if (missing.length) {
    return `当前 ffmpeg 构建缺少滤镜：${missing.join('、')}。依赖它们的模块已禁用（其余模块不受影响）。`
  }
  return null
})

function isBlocked(key: ChainModuleKey): boolean {
  if (chain.ffmpegCaps === null) return false
  return !chain.isModuleAvailable(key)
}

function blockReason(key: ChainModuleKey): string {
  return chain.moduleUnavailableReason(key) ?? ''
}

function enabledOf(key: ChainModuleKey): boolean {
  return chain.activeModules.includes(key)
}

/**
 * 哪些模块必须**始终展开**参数区：
 *   · EQ：空链时它是「未启用」状态（eq 里没有启用频段），若不展开就永远没有入口新增频段；
 *   · 修补：它是一组独立工具（去 DC / 极性 / declick / 静音填充 / 变速），
 *     store 的模块开关只能「全关」，不能「全开」（开一个会改变声音），
 *     所以直接用每个工具自己的开关，模块头不放总开关。
 */
function alwaysOpen(key: ChainModuleKey): boolean {
  return key === 'eq' || key === 'repair'
}

function showBody(key: ChainModuleKey): boolean {
  if (isBlocked(key)) return false
  return alwaysOpen(key) || enabledOf(key)
}

// ── 参数行（数据驱动，避免为 13 个参数写 13 段重复模板）──────────────────
interface ParamRow {
  key: ParamKey
  value: number
  label: string
  min: number
  max: number
  step: number
  defaultValue: number
  unit: string
  hint: string
  precision: number
}

function row(key: ParamKey, value: number): ParamRow {
  const spec = PARAM_SPECS[key]
  return {
    key,
    value,
    label: spec.label,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    defaultValue: spec.defaultValue,
    unit: spec.unit,
    hint: spec.hint,
    precision: spec.precision ?? 2,
  }
}

function rowsOf(key: ChainModuleKey): ParamRow[] {
  const current = chain.chain
  switch (key) {
    case 'highpass':
      return [row('highpassFreq', current.highpass.freq)]
    case 'denoise':
      return [row('denoiseNr', current.denoise.nr), row('denoiseNf', current.denoise.nf)]
    case 'deesser':
      return [row('deesserIntensity', current.deesser.intensity), row('deesserFreq', current.deesser.freq)]
    case 'compressor':
      return [
        row('compressorThreshold', current.compressor.thresholdDb),
        row('compressorRatio', current.compressor.ratio),
        row('compressorAttack', current.compressor.attackMs),
        row('compressorRelease', current.compressor.releaseMs),
        row('compressorMakeup', current.compressor.makeupDb),
      ]
    case 'limiter':
      return [
        row('limiterLimit', current.limiter.limitDb),
        row('limiterAttack', current.limiter.attackMs),
        row('limiterRelease', current.limiter.releaseMs),
      ]
    case 'repair':
      return [row('tempoFactor', current.repair.tempo.factor)]
    default:
      return []
  }
}

function commitParam(key: ParamKey, value: number): void {
  chain.commit((draft) => {
    switch (key) {
      case 'highpassFreq': draft.highpass.freq = value; break
      case 'denoiseNr': draft.denoise.nr = value; break
      case 'denoiseNf': draft.denoise.nf = value; break
      case 'deesserIntensity': draft.deesser.intensity = value; break
      case 'deesserFreq': draft.deesser.freq = value; break
      case 'compressorThreshold': draft.compressor.thresholdDb = value; break
      case 'compressorRatio': draft.compressor.ratio = value; break
      case 'compressorAttack': draft.compressor.attackMs = value; break
      case 'compressorRelease': draft.compressor.releaseMs = value; break
      case 'compressorMakeup': draft.compressor.makeupDb = value; break
      case 'limiterLimit': draft.limiter.limitDb = value; break
      case 'limiterAttack': draft.limiter.attackMs = value; break
      case 'limiterRelease': draft.limiter.releaseMs = value; break
      case 'tempoFactor':
        draft.repair.tempo.factor = value
        // 改了系数就说明要用它，否则用户会以为「填了没生效」
        draft.repair.tempo.enabled = true
        break
      default: break
    }
  })
}

// ── 模块开关 ──────────────────────────────────────────────────────────────
function setModuleEnabled(key: ChainModuleKey, enabled: boolean): void {
  if (enabled && isBlocked(key)) return
  chain.setModuleEnabled(key, enabled)
}

/** 模块总开关：el-switch 的载荷是 boolean | string | number，按模块 key 逐项固定处理器 */
function onModuleSwitchInput(key: ChainModuleKey): (value: boolean | string | number) => void {
  return (value: boolean | string | number): void => {
    setModuleEnabled(key, value === true)
  }
}

/** 降噪「跟随噪声底」（tn）：el-switch 的载荷是 boolean | string | number */
function onDenoiseTnSwitchInput(value: boolean | string | number): void {
  chain.commit((draft) => { draft.denoise.tn = value === true })
}

/** 高通极数：打开即 2 极（12 dB/oct），关闭回到 1 极 */
function onHighpassPolesSwitchInput(value: boolean | string | number): void {
  chain.commit((draft) => { draft.highpass.poles = value === true ? 2 : 1 })
}

/** 模块头的一句话小结（折叠状态下也能看清参数） */
function summaryOf(key: ChainModuleKey): string {
  return moduleSummary(chain.chain, key)
}

// ── EQ 频段 ───────────────────────────────────────────────────────────────
function eqRows(band: EqBand): ParamRow[] {
  return [row('eqFreq', band.freq), row('eqGain', band.gainDb), row('eqQ', band.q)]
}

function commitEqRow(bandId: string, key: ParamKey, value: number): void {
  const patch: Partial<EqBand> = key === 'eqFreq'
    ? { freq: value }
    : key === 'eqGain' ? { gainDb: value } : { q: value }
  chain.patchEqBand(bandId, patch)
}

/** EQ 频段类型：el-select 的载荷即选项值（peak / lowshelf / highshelf / lowpass / highpass，即 EqBand['type']） */
function onBandTypeChange(bandId: string): (value: EqBand['type']) => void {
  return (value: EqBand['type']): void => {
    chain.patchEqBand(bandId, { type: value })
  }
}

/** EQ 频段开关：el-switch 的载荷是 boolean | string | number */
function onBandEnabledSwitchInput(bandId: string): (value: boolean | string | number) => void {
  return (value: boolean | string | number): void => {
    chain.patchEqBand(bandId, { enabled: value === true })
  }
}

const eqError = ref<string | null>(null)

function addEqBand(): void {
  const band = chain.addEqBand({ freq: 1000, gainDb: 0, q: 1 })
  eqError.value = band ? null : '新增频段失败，请重试'
}

// ── 修补工具（docs/14 §6）─────────────────────────────────────────────────
const declickAtMs = ref(0)
const declickLengthMs = ref(8)
const silenceStartMs = ref(0)
const silenceEndMs = ref(500)

function addDeclick(): void {
  chain.addDeclick(Math.max(0, declickAtMs.value), Math.max(1, declickLengthMs.value))
}

function addSilenceFill(): void {
  if (!(silenceEndMs.value > silenceStartMs.value)) {
    eqError.value = '静音填充的结束时间必须大于开始时间'
    return
  }
  chain.addSilenceFill(silenceStartMs.value, silenceEndMs.value)
}

/** 修补工具开关（去 DC / 极性反转 / 变速）：el-switch 的载荷是 boolean | string | number */
function onDcOffsetSwitchInput(value: boolean | string | number): void {
  chain.commit((draft) => { draft.repair.dcOffset = value === true })
}

function onPolarityInvertSwitchInput(value: boolean | string | number): void {
  chain.commit((draft) => { draft.repair.polarityInvert = value === true })
}

function onTempoEnabledSwitchInput(value: boolean | string | number): void {
  chain.commit((draft) => { draft.repair.tempo.enabled = value === true })
}

/** declick 时刻：el-input-number 的载荷是 number | undefined（清空时为 undefined） */
function onDeclickAtInput(value: number | undefined): void {
  declickAtMs.value = Number(value ?? 0)
}

/** declick 长度：el-input-number 的载荷是 number | undefined，默认 8 ms */
function onDeclickLengthInput(value: number | undefined): void {
  declickLengthMs.value = Number(value ?? 8)
}

/** 静音填充起止：el-input-number 的载荷是 number | undefined */
function onSilenceStartInput(value: number | undefined): void {
  silenceStartMs.value = Number(value ?? 0)
}

function onSilenceEndInput(value: number | undefined): void {
  silenceEndMs.value = Number(value ?? 0)
}

// ── 噪声轮廓采样（docs/14 §5）────────────────────────────────────────────
const noiseStartMs = ref(0)
const noiseEndMs = ref(500)

async function sampleNoise(): Promise<void> {
  const segmentId = targetSegmentId.value
  if (!segmentId) return
  await chain.sampleNoiseProfile(segmentId, noiseStartMs.value, noiseEndMs.value)
}

/** 噪声采样区间：el-input-number 的载荷是 number | undefined */
function onNoiseStartInput(value: number | undefined): void {
  noiseStartMs.value = Number(value ?? 0)
}

function onNoiseEndInput(value: number | undefined): void {
  noiseEndMs.value = Number(value ?? 0)
}

// ── A/B 试听（五要素第 ⑤ 条）与套用 ──────────────────────────────────────
async function previewModule(key: ChainModuleKey): Promise<void> {
  const segmentId = targetSegmentId.value
  if (!segmentId) return
  await chain.previewSingleModule(key, segmentId)
}

async function previewWholeChain(): Promise<void> {
  const segmentId = targetSegmentId.value
  if (!segmentId) return
  await chain.openAbCompare(segmentId, { label: `整链：${selectedSegmentLabel.value}` })
}

const appliedPresetName = computed(() => {
  const preset = presets.getById(chain.appliedPresetId)
  return preset ? preset.name : '临时链（未保存为预设）'
})
</script>

<template>
  <section class="ns-chain">
    <header class="ns-chain__head">
      <div class="ns-chain__title">
        <h3>处理链</h3>
        <p class="ns-chain__sub">
          {{ chain.origin.label }} · 当前来源：{{ appliedPresetName }}
          <el-tag v-if="chain.dirty" size="small" type="warning">有未应用的改动</el-tag>
        </p>
      </div>
      <div class="ns-chain__ops">
        <el-button size="small" :disabled="!targetSegmentId" @click="previewWholeChain">整链 A/B 试听</el-button>
        <el-button size="small" :disabled="!chain.dirty" @click="chain.revertToBaseline()">放弃改动</el-button>
        <el-button size="small" @click="chain.resetChain()">全部重置</el-button>
        <el-button size="small" type="primary" @click="emit('apply-request')">套用到…</el-button>
        <el-button size="small" text @click="emit('report-request')">批量报告</el-button>
      </div>
    </header>

    <el-alert
      v-if="capabilityAlert"
      class="ns-chain__alert"
      type="warning"
      :closable="false"
      show-icon
      :title="capabilityAlert"
    />
    <el-alert
      v-if="chain.isEmpty"
      class="ns-chain__alert"
      type="info"
      :closable="false"
      show-icon
      title="处理链全关：这条链只做格式统一与峰值控制，不会改变音色"
    />

    <div class="ns-chain__target">
      <span class="ns-label">试听目标片段</span>
      <el-select
        :model-value="targetSegmentId"
        size="small"
        filterable
        placeholder="先载入片段索引"
        @change="onTargetSegmentChange"
      >
        <el-option
          v-for="item in chain.segmentIndex"
          :key="item.segmentId"
          :label="item.label"
          :value="item.segmentId"
        />
      </el-select>
      <el-button size="small" :loading="chain.segmentIndexLoading" @click="chain.loadSegmentIndex(true)">
        {{ chain.segmentIndex.length ? '刷新片段索引' : '载入片段索引' }}
      </el-button>
      <span v-if="!chain.segmentIndex.length" class="ns-hint">
        A/B 试听需要真实片段（A 用原素材、B 用 process:preview 真渲染）
      </span>
    </div>

    <!-- 固定顺序模块列表（docs/14 §2.1）-->
    <div class="ns-chain__modules">
      <article
        v-for="module in CHAIN_MODULES"
        :key="module.key"
        class="ns-module"
        :class="{ 'is-off': !enabledOf(module.key), 'is-blocked': isBlocked(module.key) }"
      >
        <header class="ns-module__head">
          <span class="ns-module__order">{{ module.order }}</span>
          <div class="ns-module__meta">
            <h4>{{ module.label }}</h4>
            <p class="ns-module__rationale">{{ module.rationale }}</p>
            <p class="ns-module__summary">{{ summaryOf(module.key) }}</p>
          </div>
          <el-switch
            v-if="module.key !== 'repair'"
            :model-value="enabledOf(module.key)"
            :disabled="isBlocked(module.key)"
            size="small"
            @change="onModuleSwitchInput(module.key)"
          />
        </header>

        <p v-if="isBlocked(module.key)" class="ns-module__blocked">{{ blockReason(module.key) }}</p>

        <div v-if="showBody(module.key)" class="ns-module__body">
          <!-- EQ：曲线可视化（五要素第 ④ 条）+ 每段的滑块/数字输入 -->
          <template v-if="module.key === 'eq'">
            <EqCurveCanvas
              :bands="chain.chain.eq"
              :selected-id="null"
              :height="props.curveHeight"
              @add-band="(freq, gainDb) => chain.addEqBand({ freq, gainDb, type: 'peak' })"
              @update-band="(id, patch) => chain.patchEqBand(id, patch)"
              @toggle-band="(id) => { const band = chain.chain.eq.find(b => b.id === id); if (band) chain.patchEqBand(id, { enabled: !band.enabled }) }"
              @remove-band="(id) => chain.removeEqBand(id)"
            />
            <div class="ns-eq-bands">
              <div v-for="band in chain.chain.eq" :key="band.id" class="ns-eq-band">
                <div class="ns-eq-band__head">
                  <el-select
                    :model-value="band.type"
                    size="small"
                    @change="onBandTypeChange(band.id)"
                  >
                    <el-option label="峰值" value="peak" />
                    <el-option label="低架" value="lowshelf" />
                    <el-option label="高架" value="highshelf" />
                    <el-option label="低通" value="lowpass" />
                    <el-option label="高通" value="highpass" />
                  </el-select>
                  <el-switch
                    :model-value="band.enabled"
                    size="small"
                    @change="onBandEnabledSwitchInput(band.id)"
                  />
                  <el-button size="small" text type="danger" @click="chain.removeEqBand(band.id)">删除</el-button>
                </div>
                <div class="ns-params">
                  <FaderControl
                    v-for="parameter in eqRows(band)"
                    :key="`${band.id}-${parameter.key}`"
                    :model-value="parameter.value"
                    :min="parameter.min"
                    :max="parameter.max"
                    :step="parameter.step"
                    :default-value="parameter.defaultValue"
                    :label="parameter.label"
                    :unit="parameter.unit"
                    :hint="parameter.hint"
                    :precision="parameter.precision"
                    compact
                    :height="110"
                    @change="(value) => commitEqRow(band.id, parameter.key, value)"
                  />
                </div>
              </div>
              <div class="ns-eq-bands__foot">
                <el-button size="small" @click="addEqBand">新增频段</el-button>
                <span v-if="!chain.chain.eq.length" class="ns-hint">
                  还没有频段：双击曲线空白处即可新增峰值点
                </span>
              </div>
            </div>
          </template>

          <!-- 修补：前置（去 DC / 极性）+ 后置（declick / 静音填充 / 变速），docs/14 §6 -->
          <template v-else-if="module.key === 'repair'">
            <p class="ns-hint">
              修补是一组独立工具，各自开关（模块头不设总开关：一次打开全部工具会改变声音）
            </p>
            <div class="ns-repair__row">
              <el-switch
                :model-value="chain.chain.repair.dcOffset"
                size="small"
                active-text="去 DC 偏移"
                @change="onDcOffsetSwitchInput"
              />
              <el-switch
                :model-value="chain.chain.repair.polarityInvert"
                size="small"
                active-text="极性反转"
                @change="onPolarityInvertSwitchInput"
              />
              <el-switch
                :model-value="chain.chain.repair.tempo.enabled"
                size="small"
                active-text="变速"
                @change="onTempoEnabledSwitchInput"
              />
              <el-button size="small" text @click="chain.setModuleEnabled('repair', false)">
                关闭全部修补
              </el-button>
            </div>

            <div class="ns-params">
              <FaderControl
                v-for="parameter in rowsOf('repair')"
                :key="parameter.key"
                :model-value="parameter.value"
                :min="parameter.min"
                :max="parameter.max"
                :step="parameter.step"
                :default-value="parameter.defaultValue"
                :label="parameter.label"
                :unit="parameter.unit"
                :hint="parameter.hint"
                :precision="parameter.precision"
                compact
                :height="110"
                :disabled="!chain.chain.repair.tempo.enabled"
                disabled-reason="先打开「变速」开关再调系数"
                @change="(value) => commitParam(parameter.key, value)"
              />
            </div>

            <div class="ns-repair__block">
              <h5>爆音修补（declick）</h5>
              <p class="ns-hint">在指定时刻挖掉一小段并交叉淡化，用于修掉「啪」的一声（docs/14 §6）</p>
              <div class="ns-repair__inputs">
                <el-input-number
                  :model-value="declickAtMs"
                  :min="0"
                  :step="10"
                  size="small"
                  controls-position="right"
                  @change="onDeclickAtInput"
                />
                <span class="ns-hint">ms 处的</span>
                <el-input-number
                  :model-value="declickLengthMs"
                  :min="1"
                  :max="100"
                  size="small"
                  controls-position="right"
                  @change="onDeclickLengthInput"
                />
                <span class="ns-hint">ms（1~100）</span>
                <el-button size="small" @click="addDeclick">添加</el-button>
              </div>
              <ul v-if="chain.chain.repair.declick.length" class="ns-list">
                <li v-for="(item, index) in chain.chain.repair.declick" :key="`dc-${index}-${item.atMs}`">
                  <span>{{ item.atMs }} ms（{{ item.lengthMs }} ms）</span>
                  <el-button size="small" text type="danger" @click="chain.removeDeclick(index)">移除</el-button>
                </li>
              </ul>
            </div>

            <div class="ns-repair__block">
              <h5>静音填充</h5>
              <p class="ns-hint">把一段意外静音补上环境声底噪，避免「突然断掉」的听感</p>
              <div class="ns-repair__inputs">
                <el-input-number
                  :model-value="silenceStartMs"
                  :min="0"
                  :step="50"
                  size="small"
                  controls-position="right"
                  @change="onSilenceStartInput"
                />
                <span class="ns-hint">~</span>
                <el-input-number
                  :model-value="silenceEndMs"
                  :min="0"
                  :step="50"
                  size="small"
                  controls-position="right"
                  @change="onSilenceEndInput"
                />
                <span class="ns-hint">ms</span>
                <el-button size="small" @click="addSilenceFill">添加</el-button>
              </div>
              <ul v-if="chain.chain.repair.silenceFill.length" class="ns-list">
                <li v-for="(item, index) in chain.chain.repair.silenceFill" :key="`sf-${index}-${item.startMs}`">
                  <span>{{ item.startMs }} ~ {{ item.endMs }} ms</span>
                  <el-button size="small" text type="danger" @click="chain.removeSilenceFill(index)">移除</el-button>
                </li>
              </ul>
            </div>
          </template>

          <!-- 其余模块：参数行 + 单模块 A/B 试听 -->
          <template v-else>
            <div class="ns-params">
              <FaderControl
                v-for="parameter in rowsOf(module.key)"
                :key="parameter.key"
                :model-value="parameter.value"
                :min="parameter.min"
                :max="parameter.max"
                :step="parameter.step"
                :default-value="parameter.defaultValue"
                :label="parameter.label"
                :unit="parameter.unit"
                :hint="parameter.hint"
                :precision="parameter.precision"
                compact
                :height="110"
                @change="(value) => commitParam(parameter.key, value)"
              />
            </div>
            <el-switch
              v-if="module.key === 'denoise'"
              :model-value="chain.chain.denoise.tn"
              size="small"
              active-text="跟随噪声底（tn）"
              @change="onDenoiseTnSwitchInput"
            />
            <el-switch
              v-if="module.key === 'highpass'"
              :model-value="chain.chain.highpass.poles === 2"
              size="small"
              active-text="2 极（12 dB/oct）"
              @change="onHighpassPolesSwitchInput"
            />
          </template>

          <div class="ns-module__actions">
            <el-button size="small" :disabled="!targetSegmentId" @click="previewModule(module.key)">
              A/B 试听本模块
            </el-button>
            <span class="ns-hint">只保留本模块、其余全关，用来判断它到底贡献了什么（docs/14 §10）</span>
          </div>
        </div>
      </article>
    </div>

    <!-- 噪声轮廓采样（docs/14 §5）：把实测底噪填进 denoise.nf -->
    <section class="ns-noise">
      <h4>噪声轮廓采样</h4>
      <p class="ns-hint">
        选一段「纯噪声」（没人说话的静音段），系统实测其 RMS 并给出建议的噪声底 nf。
        手动猜 nf 是降噪效果差的最常见原因。
      </p>
      <div class="ns-noise__inputs">
        <el-input-number
          :model-value="noiseStartMs"
          :min="0"
          :step="50"
          size="small"
          controls-position="right"
          @change="onNoiseStartInput"
        />
        <span class="ns-hint">~</span>
        <el-input-number
          :model-value="noiseEndMs"
          :min="0"
          :step="50"
          size="small"
          controls-position="right"
          @change="onNoiseEndInput"
        />
        <span class="ns-hint">ms（在「{{ selectedSegmentLabel }}」上采样）</span>
        <el-button size="small" :loading="chain.noiseSampling" :disabled="!targetSegmentId" @click="sampleNoise">
          采样噪声轮廓
        </el-button>
      </div>
      <div v-if="chain.noiseProfile" class="ns-noise__result">
        <span>
          已采样：实测底噪 {{ formatDb(chain.noiseProfile.rmsDb) }} dBFS ·
          建议 nf {{ chain.noiseProfile.suggestedNf }} dBFS
        </span>
        <el-button size="small" type="primary" @click="chain.adoptSuggestedNoiseFloor()">采用建议值</el-button>
      </div>
    </section>

    <p v-if="eqError" class="ns-error">{{ eqError }}</p>
  </section>
</template>

<style scoped>
.ns-chain { display: flex; flex-direction: column; gap: 10px; }
.ns-chain__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ns-chain h3 { margin: 0; font-size: 14px; color: var(--ns-text-primary, #303133); }
.ns-chain h4 { margin: 0; font-size: 12.5px; color: var(--ns-text-primary, #303133); }
.ns-chain h5 { margin: 0 0 2px; font-size: 12px; color: var(--ns-text-primary, #303133); }
.ns-chain__sub { display: flex; align-items: center; gap: 6px; margin: 2px 0 0; color: var(--ns-text-secondary, #909399); font-size: 11px; }
.ns-chain__ops { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-chain__alert { margin: 0; }
.ns-chain__target {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-subtle, #fafafa);
}
.ns-label { color: var(--ns-text-regular, #606266); font-size: 12px; white-space: nowrap; }
.ns-hint { color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-chain__modules { display: flex; flex-direction: column; gap: 8px; }
.ns-module { border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-elevated, #fff); }
.ns-module.is-off { opacity: 0.72; }
.ns-module.is-blocked { border-style: dashed; }
.ns-module__head { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; }
.ns-module__order {
  flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%;
  background: var(--ns-fill, #ebeef5); color: var(--ns-text-regular, #606266);
  font: 600 11px/18px ui-monospace, Consolas, monospace; text-align: center;
}
.ns-module__meta { flex: 1; min-width: 0; }
.ns-module__meta h4 { margin: 0; font-size: 12.5px; color: var(--ns-text-primary, #303133); }
.ns-module__rationale,
.ns-module__summary { margin: 2px 0 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.45; }
.ns-module__summary { color: var(--ns-text-regular, #606266); font-family: ui-monospace, Consolas, monospace; }
.ns-module__blocked { margin: 0 10px 8px; color: var(--ns-warning, #e6a23c); font-size: 11px; }
.ns-module__body { display: flex; flex-direction: column; gap: 8px; padding: 0 10px 10px; }
.ns-params { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px 10px; }
.ns-module__actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ns-eq-bands { display: flex; flex-direction: column; gap: 8px; }
.ns-eq-band {
  padding: 6px 8px; border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 6px; background: var(--ns-bg-subtle, #fafafa);
}
.ns-eq-band__head,
.ns-eq-bands__foot { display: flex; align-items: center; gap: 8px; }
.ns-eq-band__head { margin-bottom: 6px; }
.ns-repair__row { display: flex; flex-wrap: wrap; gap: 14px; }
.ns-repair__block { padding: 6px 8px; border: 1px dashed var(--ns-border, #dcdfe6); border-radius: 6px; }
.ns-repair__inputs,
.ns-noise__inputs,
.ns-noise__result { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.ns-list { margin: 6px 0 0; padding-left: 16px; color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ns-noise {
  padding: 8px 10px; border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 6px; background: var(--ns-bg-subtle, #fafafa);
}
.ns-noise__result { color: var(--ns-success, #67c23a); font-size: 11.5px; }
.ns-error { margin: 0; color: var(--ns-danger, #f56c6c); font-size: 11.5px; }
</style>
