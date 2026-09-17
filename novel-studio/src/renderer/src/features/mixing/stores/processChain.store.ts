/**
 * Novel Studio · 处理链与批量处理 store（docs/14 §2~§7）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §2   处理链模型（ProcessChain 七个模块）
 *   · docs/14 §2.1 **固定执行顺序**：修补前置 → 高通 → 降噪 → 去齿音 → EQ → 压缩 → 限幅 → 修补后置
 *   · docs/14 §3.1 能力探测 → 「UI 据此隐藏控件，而不是等用户点了才报错」
 *   · docs/14 §4.3 每个参数的五要素：滑块 + 数字输入 / 单位与范围 / 双击复原 /
 *                  EQ 曲线可视化 / A/B 试听
 *   · docs/14 §5   噪声轮廓采样（把 RMS 填进 nf）
 *   · docs/14 §7   批量处理与失败隔离 + 报告（§7.3 要能「查看命令」）
 *
 * 这个 store 管三件事：
 *   1. **当前编辑的处理链**（工作副本）+ 它的来源（哪条轨 / 哪个片段）
 *   2. **套用范围解析**（segment / character / chapter / book → segmentId 列表）
 *   3. **批量任务与报告**（taskId、失败明细、重试、回退）
 *
 * 与 presets.store 的分工：本文件只管「一条链」；预设的增删改查在
 * presets.store.ts。两者不互相 import，组件负责把它们接起来（避免循环依赖）。
 */

import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppCapabilities,
  AudioMetrics,
  EqBand,
  Id,
  ProcessChain,
  ProcessPreset,
  ProcessScope,
  TaskRecord,
} from '@shared/types.ts'
import { createEmptyChain } from '@shared/constants.ts'
import { call, callSafe, callCollecting } from '@/shared/lib/ipc.ts'
import { reportBatchFailures, reportError } from '@/shared/lib/error-bus.ts'
import { tryBuildMediaUrl } from '@/shared/lib/media-url.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import {
  DEFAULT_PREVIEW_DURATION_MS,
  extractBatchResult,
  extractPathFromTaskResult,
  measurePreviewFile,
  renderProcessedPreview,
  waitForTask,
} from '@/features/mixing/composables/usePreview.ts'

// ---------------------------------------------------------------------------
// 纯函数：链的克隆 / 规整 / 摘要
// ---------------------------------------------------------------------------

/** 深拷贝一条处理链（编辑器永远改副本，避免直接改到预设对象） */
export function cloneChain(chain: ProcessChain): ProcessChain {
  return {
    highpass: { ...chain.highpass },
    denoise: { ...chain.denoise },
    deesser: { ...chain.deesser },
    eq: chain.eq.map(band => ({ ...band })),
    compressor: { ...chain.compressor },
    limiter: { ...chain.limiter },
    repair: {
      dcOffset: chain.repair.dcOffset,
      polarityInvert: chain.repair.polarityInvert,
      declick: chain.repair.declick.map(item => ({ ...item })),
      silenceFill: chain.repair.silenceFill.map(item => ({ ...item })),
      tempo: { ...chain.repair.tempo },
    },
  }
}

export function emptyChain(): ProcessChain {
  return createEmptyChain()
}

/** 参数规格：UI 的「滑块 + 数字输入 + 单位与范围提示 + 双击复原」全部读它（docs/14 §4.3） */
export interface ParamSpec {
  label: string
  min: number
  max: number
  step: number
  defaultValue: number
  unit: string
  /** ② 单位与范围提示，例如「降噪量 0.01~97 dB，建议 6~18」 */
  hint: string
  precision?: number
}

const DEFAULTS = createEmptyChain()

export const PARAM_SPECS = {
  highpassFreq: {
    label: '截止频率', min: 20, max: 300, step: 1, defaultValue: 70, unit: 'Hz',
    hint: '高通 20~300 Hz，男声建议 70~90，女声建议 90~120', precision: 0,
  },
  denoiseNr: {
    label: '降噪量', min: 0.01, max: 97, step: 0.5, defaultValue: DEFAULTS.denoise.nr, unit: 'dB',
    hint: '降噪量 0.01~97 dB，建议 6~18（越大越干净也越容易吃字）', precision: 2,
  },
  denoiseNf: {
    label: '噪声底', min: -80, max: -20, step: 1, defaultValue: DEFAULTS.denoise.nf, unit: 'dBFS',
    hint: '噪声底 -80~-20 dBFS，建议先用「采样噪声轮廓」实测填入', precision: 1,
  },
  deesserIntensity: {
    label: '强度', min: 0, max: 1, step: 0.05, defaultValue: DEFAULTS.deesser.intensity, unit: '',
    hint: '强度 0~1，建议 0.3~0.7（过高会让人声发闷）', precision: 2,
  },
  deesserFreq: {
    label: '中心频率', min: 0, max: 1, step: 0.05, defaultValue: DEFAULTS.deesser.freq, unit: '',
    hint: '去齿音中心频率 0~1（0=低、1=高），中文齿音多在 0.5 附近', precision: 2,
  },
  eqFreq: {
    label: '频率', min: 20, max: 20000, step: 1, defaultValue: 1000, unit: 'Hz',
    hint: '频率 20 Hz~20 kHz（对数轴显示）', precision: 0,
  },
  eqGain: {
    label: '增益', min: -18, max: 18, step: 0.5, defaultValue: 0, unit: 'dB',
    hint: '增益 -18~+18 dB；EQ 曲线区可直接拖动控制点', precision: 1,
  },
  eqQ: {
    label: 'Q 值', min: 0.1, max: 10, step: 0.1, defaultValue: 1, unit: '',
    hint: 'Q 0.1~10（滚筒/Q 越大越窄）；滚轮可调', precision: 2,
  },
  compressorThreshold: {
    label: '阈值', min: -60, max: 0, step: 1, defaultValue: DEFAULTS.compressor.thresholdDb, unit: 'dB',
    hint: '压缩阈值 -60~0 dB，旁白建议 -20~-16', precision: 0,
  },
  compressorRatio: {
    label: '压缩比', min: 1, max: 20, step: 0.5, defaultValue: DEFAULTS.compressor.ratio, unit: ':1',
    hint: '压缩比 1:1~20:1，有声书建议 2:1~4:1', precision: 1,
  },
  compressorAttack: {
    label: '启动', min: 0.5, max: 200, step: 0.5, defaultValue: DEFAULTS.compressor.attackMs, unit: 'ms',
    hint: '启动 0.5~200 ms（太快会削掉字头，太慢压不住瞬态）', precision: 1,
  },
  compressorRelease: {
    label: '释放', min: 10, max: 3000, step: 10, defaultValue: DEFAULTS.compressor.releaseMs, unit: 'ms',
    hint: '释放 10~3000 ms（太短会有「抽气」感）', precision: 0,
  },
  compressorMakeup: {
    label: '补偿增益', min: 0, max: 24, step: 0.5, defaultValue: DEFAULTS.compressor.makeupDb, unit: 'dB',
    hint: '补偿增益 0~24 dB；docs/14 §3.1 建议改在链尾用 volume 更可控', precision: 1,
  },
  limiterLimit: {
    label: '限幅上限', min: -12, max: 0, step: 0.1, defaultValue: DEFAULTS.limiter.limitDb, unit: 'dBFS',
    hint: '限幅上限 -12~0 dBFS；有声书成品建议 -1（写作 dB，ffmpeg 侧会转线性）', precision: 1,
  },
  limiterAttack: {
    label: '启动', min: 1, max: 100, step: 1, defaultValue: DEFAULTS.limiter.attackMs, unit: 'ms',
    hint: '限幅启动 1~100 ms', precision: 0,
  },
  limiterRelease: {
    label: '释放', min: 5, max: 1000, step: 5, defaultValue: DEFAULTS.limiter.releaseMs, unit: 'ms',
    hint: '限幅释放 5~1000 ms', precision: 0,
  },
  tempoFactor: {
    label: '变速系数', min: 0.9, max: 1.1, step: 0.005, defaultValue: 1, unit: '×',
    hint: '变速 0.9~1.1 ×；超出会明显失真（docs/14 §6 的救急范围）', precision: 3,
  },
} satisfies Record<string, ParamSpec>

export type ParamKey = keyof typeof PARAM_SPECS

/** 取回默认值（③ 双击滑块复原用） */
export function defaultOf(key: ParamKey): number {
  return PARAM_SPECS[key].defaultValue
}

function clampTo(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 规整处理链：把越界值夹回范围（docs/14 §13「参数越界 → UI 层限制范围，
 * 主进程再校验一次」）。编辑器每次改动都过一遍，避免滑块抖出 NaN 污染链。
 */
export function sanitizeChain(chain: ProcessChain): ProcessChain {
  const next = cloneChain(chain)
  next.highpass.freq = clampTo(next.highpass.freq, 20, 300)
  next.highpass.poles = next.highpass.poles === 1 ? 1 : 2
  next.denoise.nr = clampTo(next.denoise.nr, 0.01, 97)
  next.denoise.nf = clampTo(next.denoise.nf, -80, -20)
  next.deesser.intensity = clampTo(next.deesser.intensity, 0, 1)
  next.deesser.freq = clampTo(next.deesser.freq, 0, 1)
  next.eq = next.eq.map(band => ({
    ...band,
    freq: clampTo(band.freq, 20, 20000),
    gainDb: clampTo(band.gainDb, -18, 18),
    q: clampTo(band.q, 0.1, 10),
  }))
  next.compressor.thresholdDb = clampTo(next.compressor.thresholdDb, -60, 0)
  next.compressor.ratio = clampTo(next.compressor.ratio, 1, 20)
  next.compressor.attackMs = clampTo(next.compressor.attackMs, 0.5, 200)
  next.compressor.releaseMs = clampTo(next.compressor.releaseMs, 10, 3000)
  next.compressor.makeupDb = clampTo(next.compressor.makeupDb, 0, 24)
  next.limiter.limitDb = clampTo(next.limiter.limitDb, -12, 0)
  next.limiter.attackMs = clampTo(next.limiter.attackMs, 1, 100)
  next.limiter.releaseMs = clampTo(next.limiter.releaseMs, 5, 1000)
  next.repair.tempo.factor = clampTo(next.repair.tempo.factor, 0.9, 1.1)
  next.repair.declick = next.repair.declick
    .filter(item => Number.isFinite(item.atMs) && Number.isFinite(item.lengthMs) && item.lengthMs > 0)
    .map(item => ({ atMs: Math.max(0, item.atMs), lengthMs: clampTo(item.lengthMs, 1, 100) }))
  next.repair.silenceFill = next.repair.silenceFill
    .filter(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
    .map(item => ({ startMs: Math.max(0, item.startMs), endMs: Math.max(0, item.endMs) }))
  return next
}

// ---------------------------------------------------------------------------
// 模块元数据（固定执行顺序 + 所需滤镜）
// ---------------------------------------------------------------------------

export type ChainModuleKey = 'repair' | 'highpass' | 'denoise' | 'deesser' | 'eq' | 'compressor' | 'limiter'

export interface ChainModuleMeta {
  key: ChainModuleKey
  /** 执行序号：① 修补前置 ② 高通 ③ 降噪 ④ 去齿音 ⑤ EQ ⑥ 压缩 ⑦ 限幅 ⑧ 修补后置 */
  order: number
  /** UI 上的固定顺序标签（docs/14 §2.1：不可调换） */
  label: string
  /** 为什么在这个位置（把文档里的理由带到 UI 上，避免用户以为顺序可调） */
  rationale: string
  /** 该模块依赖的 ffmpeg 滤镜（缺失则禁用控件并说明原因，docs/14 §3.1） */
  filters: string[]
  /** 是否已启用（决定模块头的开关状态） */
  isEnabled: (chain: ProcessChain) => boolean
}

/**
 * 固定执行顺序表。
 * 顺序本身就是需求（docs/14 §2.1），因此这里没有「拖动排序」的入口，
 * UI 也不提供上移/下移 —— 顺序错了效果会明显变差：
 *   · 降噪必须在 EQ/压缩之前（压缩会先抬小信号，把噪声一起抬起来）；
 *   · 去齿音必须在压缩之前（否则压缩器会被齿音瞬态误触发）。
 */
export const CHAIN_MODULES: readonly ChainModuleMeta[] = [
  {
    key: 'repair',
    order: 1,
    label: '修补（前置：去 DC / 极性 · 后置：declick / 静音填充 / 变速）',
    rationale: '前置修补在链首（DC 与极性是素材问题），后置修补在链尾（爆音与时长改动不该被后续模块再处理）',
    filters: ['highpass', 'aeval', 'afade', 'atempo'],
    isEnabled: (chain) => chain.repair.dcOffset
      || chain.repair.polarityInvert
      || chain.repair.declick.length > 0
      || chain.repair.silenceFill.length > 0
      || chain.repair.tempo.enabled,
  },
  {
    key: 'highpass',
    order: 2,
    label: '高通',
    rationale: '先去掉低频隆隆声与桌面震动，后面的模块才不会把噪声一起放大',
    filters: ['highpass'],
    isEnabled: (chain) => chain.highpass.enabled,
  },
  {
    key: 'denoise',
    order: 3,
    label: '降噪',
    rationale: '必须在 EQ/压缩之前：压缩会提升小信号（含噪声），压缩后再降噪更难且更容易吃字',
    filters: ['afftdn'],
    isEnabled: (chain) => chain.denoise.enabled,
  },
  {
    key: 'deesser',
    order: 4,
    label: '去齿音',
    rationale: '必须在压缩之前：否则压缩器会被 s/sh 瞬态误触发，压完又放开反而更刺',
    filters: ['deesser'],
    isEnabled: (chain) => chain.deesser.enabled,
  },
  {
    key: 'eq',
    order: 5,
    label: 'EQ',
    rationale: '在降噪与去齿音之后塑造音色（此时噪声与齿音已经处理过）',
    filters: ['equalizer'],
    isEnabled: (chain) => chain.eq.some(band => band.enabled),
  },
  {
    key: 'compressor',
    order: 6,
    label: '压缩',
    rationale: '控制动态，让整章响度更一致（有声书最影响听感的一步）',
    filters: ['acompressor'],
    isEnabled: (chain) => chain.compressor.enabled,
  },
  {
    key: 'limiter',
    order: 7,
    label: '限幅',
    rationale: '链尾兜底，防止峰值超标（成品真峰要求见 docs/15 §4）',
    filters: ['alimiter'],
    isEnabled: (chain) => chain.limiter.enabled,
  },
]

export function moduleMeta(key: ChainModuleKey): ChainModuleMeta {
  const found = CHAIN_MODULES.find(m => m.key === key)
  if (!found) throw new Error(`未知的处理链模块：${key}`)
  return found
}

/** 当前链启用了哪些模块（用于「处理链全关」提示，docs/14 §13） */
export function enabledModuleKeys(chain: ProcessChain): ChainModuleKey[] {
  return CHAIN_MODULES.filter(m => m.isEnabled(chain)).map(m => m.key)
}

export function isChainEmpty(chain: ProcessChain): boolean {
  return enabledModuleKeys(chain).length === 0
}

/** 单个模块的参数摘要（折叠状态下的标题行） */
export function moduleSummary(chain: ProcessChain, key: ChainModuleKey): string {
  switch (key) {
    case 'highpass':
      return chain.highpass.enabled
        ? `${chain.highpass.freq} Hz / ${chain.highpass.poles} 极`
        : '未启用'
    case 'denoise':
      return chain.denoise.enabled
        ? `nr=${chain.denoise.nr} dB, nf=${chain.denoise.nf} dBFS${chain.denoise.tn ? ', 跟踪' : ''}`
        : '未启用'
    case 'deesser':
      return chain.deesser.enabled
        ? `i=${chain.deesser.intensity}, f=${chain.deesser.freq}`
        : '未启用'
    case 'eq': {
      const active = chain.eq.filter(b => b.enabled)
      if (!active.length) return '无启用频段'
      return `${active.length} 段：${active.slice(0, 3).map(b => `${b.freq}Hz ${b.gainDb > 0 ? '+' : ''}${b.gainDb}dB`).join('、')}${active.length > 3 ? '…' : ''}`
    }
    case 'compressor':
      return chain.compressor.enabled
        ? `${chain.compressor.ratio}:1, ${chain.compressor.thresholdDb} dB, ${chain.compressor.attackMs}/${chain.compressor.releaseMs} ms`
        : '未启用'
    case 'limiter':
      return chain.limiter.enabled ? `${chain.limiter.limitDb} dBFS` : '未启用'
    case 'repair': {
      const parts: string[] = []
      if (chain.repair.dcOffset) parts.push('去 DC')
      if (chain.repair.polarityInvert) parts.push('极性反转')
      if (chain.repair.declick.length) parts.push(`declick×${chain.repair.declick.length}`)
      if (chain.repair.silenceFill.length) parts.push(`静音填充×${chain.repair.silenceFill.length}`)
      if (chain.repair.tempo.enabled) parts.push(`变速 ${chain.repair.tempo.factor}×`)
      return parts.length ? parts.join(' · ') : '未启用'
    }
    default:
      return ''
  }
}

/** 整条链的一句话摘要（预设列表、应用确认框里显示） */
export function summarizeChain(chain: ProcessChain): string {
  const keys = enabledModuleKeys(chain)
  if (!keys.length) return '不做处理（仅统一格式与峰值）'
  return keys
    .map(key => `${moduleMeta(key).label.split('（')[0]} ${moduleSummary(chain, key)}`)
    .join(' · ')
}

/** 链的稳定签名：用于「参数未变则跳过」（docs/14 §7.1 的 dedupeKey 口径） */
export function chainSignature(chain: ProcessChain): string {
  return JSON.stringify(chain)
}

// ---------------------------------------------------------------------------
// 批量处理报告（docs/14 §7.3）
// ---------------------------------------------------------------------------

export interface BatchProcessFailure {
  segmentId: Id
  label: string
  code: string
  message: string
  /** ffmpeg 命令行（有就显示「查看命令」，没有就不显示 —— docs/14 §7.3） */
  commandLine: string | null
}

export interface BatchProcessReport {
  taskId: Id | null
  total: number
  succeeded: number
  skipped: number
  failed: number
  cancelled: boolean
  failures: BatchProcessFailure[]
  finishedAt: number | null
}

function emptyReport(taskId: Id | null = null): BatchProcessReport {
  return { taskId, total: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: false, failures: [], finishedAt: null }
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * 把任务结果解析成报告。
 * 主进程的 result 是 unknown，这里做**防御式解析**：字段缺失时退化为 0，
 * 明细缺失时至少保留合计，绝不因为形状不符而让报告面板崩掉。
 */
export function parseBatchReport(result: unknown, taskId: Id | null = null): BatchProcessReport {
  const raw = extractBatchResult(result)
  if (!raw || typeof raw !== 'object') return emptyReport(taskId)
  const record = raw as Record<string, unknown>
  const failuresRaw = Array.isArray(record.failures) ? record.failures : []

  return {
    taskId: str(record.taskId) ?? taskId,
    total: num(record.total),
    succeeded: num(record.succeeded ?? record.success ?? record.ok),
    skipped: num(record.skipped),
    failed: num(record.failed),
    cancelled: record.cancelled === true || record.status === 'cancelled',
    finishedAt: num(record.finishedAt, Date.now()),
    failures: failuresRaw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .slice(0, 500)
      .map((item) => ({
        segmentId: str(item.segmentId) ?? '',
        label: str(item.label) ?? str(item.segmentId) ?? '（未知片段）',
        code: str(item.code) ?? 'TASK_FAILED',
        message: str(item.message) ?? '',
        commandLine: str(item.commandLine) ?? str(item.command) ?? null,
      })),
  }
}

// ---------------------------------------------------------------------------
// 片段索引（套用范围解析 + A/B 原素材定位）
// ---------------------------------------------------------------------------

export interface SegmentRef {
  segmentId: Id
  lineId: Id
  characterId: Id | null
  /** 对轨轨 id（TrackId，字符串） */
  trackId: string | null
  /** 原始素材（take 文件）的项目内相对路径，用于 A/B 的「原始」一侧 */
  sourcePath: string | null
  label: string
}

export interface ScopeTargets {
  scope: ProcessScope
  ids: Id[]
  /** 只用于展示的预览（前若干条），避免把 2000 条全渲染出来 */
  preview: string[]
  resolvedAt: number
}

// ---------------------------------------------------------------------------
// A/B 对比状态（docs/14 §10）
// ---------------------------------------------------------------------------

export interface AbState {
  enabled: boolean
  mode: 'chain' | 'ducking'
  segmentId: Id | null
  label: string
  originalUrl: string | null
  originalLevels: { rmsDb: number | null; peakDb: number | null } | null
  processedUrl: string | null
  processedLevels: { rmsDb: number | null; peakDb: number | null } | null
  loading: boolean
  side: 'A' | 'B'
  /** 盲听：隐藏 A/B 标签（docs/14 §10 的列表盲听） */
  blind: boolean
  remembered: 'A' | 'B' | null
  error: unknown
}

function emptyAb(): AbState {
  return {
    enabled: false,
    mode: 'chain',
    segmentId: null,
    label: '',
    originalUrl: null,
    originalLevels: null,
    processedUrl: null,
    processedLevels: null,
    loading: false,
    side: 'A',
    blind: false,
    remembered: null,
    error: null,
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export interface ChainOrigin {
  kind: 'scratch' | 'track' | 'segment'
  id: Id | null
  label: string
}

export const useProcessChainStore = defineStore('mixing/processChain', () => {
  // ── 当前编辑的处理链 ────────────────────────────────────────────────────
  const chain = ref<ProcessChain>(emptyChain())
  const origin = ref<ChainOrigin>({ kind: 'scratch', id: null, label: '临时链' })
  const appliedPresetId = ref<Id | null>(null)
  /** 载入时的基线快照（用于「放弃改动」与「有未应用的改动」判断） */
  const baselineSnapshot = ref<ProcessChain>(emptyChain())
  const baseline = computed(() => chainSignature(baselineSnapshot.value))

  const dirty = computed(() => chainSignature(chain.value) !== baseline.value)
  const isEmpty = computed(() => isChainEmpty(chain.value))
  const activeModules = computed(() => enabledModuleKeys(chain.value))
  const summary = computed(() => summarizeChain(chain.value))

  // ── ffmpeg 能力（docs/14 §3.1）────────────────────────────────────────
  const ffmpegCaps = shallowRef<AppCapabilities['ffmpeg'] | null>(null)
  const capsLoading = ref(false)

  const missingFilters = computed(() => ffmpegCaps.value?.missing ?? [])
  const ffmpegAvailable = computed(() => ffmpegCaps.value?.available ?? false)

  /** 某个滤镜是否可用（未知视为可用：不因为「还没探测」就禁用整个界面） */
  function isFilterAvailable(filter: string): boolean {
    if (!ffmpegCaps.value) return true
    if (!ffmpegCaps.value.available) return false
    if (missingFilters.value.includes(filter)) return false
    const known = ffmpegCaps.value.filters ?? []
    // filters 列表为空说明探测没跑全，此时只按 missing 判断
    if (!known.length) return true
    return known.includes(filter)
  }

  /** 模块是否可用（依赖的滤镜全都在） */
  function isModuleAvailable(key: ChainModuleKey): boolean {
    return moduleMeta(key).filters.every(filter => isFilterAvailable(filter))
  }

  /** 模块被禁用的原因（UI 上必须说明原因，而不是等用户点了才报错） */
  function moduleUnavailableReason(key: ChainModuleKey): string | null {
    if (!ffmpegCaps.value) return null
    if (!ffmpegAvailable.value) return '本机未检测到可用的 ffmpeg，无法执行该处理（可到设置页配置路径后重新探测）'
    const blocked = moduleMeta(key).filters.filter(filter => !isFilterAvailable(filter))
    if (!blocked.length) return null
    return `当前 ffmpeg 构建缺少滤镜：${blocked.join('、')}（已按能力探测结果禁用该模块）`
  }

  async function loadFfmpegCapabilities(force = false): Promise<void> {
    if (ffmpegCaps.value && !force) return
    capsLoading.value = true
    try {
      const caps = await call('ffmpeg:capabilities', undefined) as AppCapabilities['ffmpeg']
      ffmpegCaps.value = caps ?? null
    } finally {
      capsLoading.value = false
    }
  }

  // ── 链的编辑 ──────────────────────────────────────────────────────────
  function loadChain(next: ProcessChain, nextOrigin: ChainOrigin, presetId: Id | null = null): void {
    const sanitized = sanitizeChain(next)
    chain.value = sanitized
    origin.value = nextOrigin
    appliedPresetId.value = presetId
    baselineSnapshot.value = cloneChain(sanitized)
    ab.value = { ...emptyAb(), blind: ab.value.blind }
    clearPreviewCache()
  }

  function loadFromPreset(preset: ProcessPreset, nextOrigin: ChainOrigin): void {
    loadChain(preset.chain, { ...nextOrigin, label: preset.name }, preset.id)
  }

  /** 提交改动：所有编辑动作都必须走这里（规整 + 标记脏 + 让预览缓存失效） */
  function commit(mutator: (draft: ProcessChain) => void, options: { invalidatePreview?: boolean } = {}): void {
    const draft = cloneChain(chain.value)
    mutator(draft)
    chain.value = sanitizeChain(draft)
    if (options.invalidatePreview !== false) {
      // 参数变了，之前的预览产物不再对应本次参数 → 清缓存，避免「听了半天是旧参数」
      clearPreviewCache()
    }
  }

  function resetChain(): void {
    commit((draft) => {
      const base = emptyChain()
      draft.highpass = base.highpass
      draft.denoise = base.denoise
      draft.deesser = base.deesser
      draft.eq = base.eq
      draft.compressor = base.compressor
      draft.limiter = base.limiter
      draft.repair = base.repair
    })
    appliedPresetId.value = null
  }

  /** 恢复为载入时的基线（放弃改动；参数级回滚不需要重新探测能力） */
  function revertToBaseline(): void {
    chain.value = cloneChain(baselineSnapshot.value)
    clearPreviewCache()
  }

  /** 把当前链记为新的基线（「应用」成功之后调用） */
  function markApplied(): void {
    baselineSnapshot.value = cloneChain(chain.value)
  }

  function setModuleEnabled(key: ChainModuleKey, enabled: boolean): void {
    commit((draft) => {
      switch (key) {
        case 'highpass': draft.highpass.enabled = enabled; break
        case 'denoise': draft.denoise.enabled = enabled; break
        case 'deesser': draft.deesser.enabled = enabled; break
        case 'compressor': draft.compressor.enabled = enabled; break
        case 'limiter': draft.limiter.enabled = enabled; break
        case 'eq':
          // EQ 的「开关」= 整组频段启用/禁用；关掉时保留参数便于一键恢复
          draft.eq = draft.eq.map(band => ({ ...band, enabled }))
          break
        case 'repair':
          draft.repair.dcOffset = enabled ? draft.repair.dcOffset : false
          draft.repair.polarityInvert = enabled ? draft.repair.polarityInvert : false
          draft.repair.tempo.enabled = enabled ? draft.repair.tempo.enabled : false
          if (!enabled) {
            draft.repair.declick = []
            draft.repair.silenceFill = []
          }
          break
        default: break
      }
    })
  }

  // ── EQ 频段 ───────────────────────────────────────────────────────────
  function addEqBand(partial: Partial<EqBand> = {}): EqBand {
    const band: EqBand = {
      id: `eq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: partial.type ?? 'peak',
      freq: clampTo(partial.freq ?? 1000, 20, 20000),
      gainDb: clampTo(partial.gainDb ?? 0, -18, 18),
      q: clampTo(partial.q ?? 1, 0.1, 10),
      enabled: partial.enabled ?? true,
    }
    commit((draft) => { draft.eq = [...draft.eq, band] })
    return band
  }

  function patchEqBand(id: string, patch: Partial<EqBand>, options: { invalidatePreview?: boolean } = {}): void {
    commit((draft) => {
      draft.eq = draft.eq.map(band => (band.id === id ? { ...band, ...patch } : band))
    }, options)
  }

  function removeEqBand(id: string): void {
    commit((draft) => { draft.eq = draft.eq.filter(band => band.id !== id) })
  }

  function setEqBands(bands: EqBand[], options: { invalidatePreview?: boolean } = {}): void {
    commit((draft) => { draft.eq = bands.map(band => ({ ...band })) }, options)
  }

  // ── 修补工具（docs/14 §6）─────────────────────────────────────────────
  function addDeclick(atMs: number, lengthMs = 8): void {
    commit((draft) => { draft.repair.declick = [...draft.repair.declick, { atMs, lengthMs }] })
  }

  function removeDeclick(index: number): void {
    commit((draft) => { draft.repair.declick = draft.repair.declick.filter((_, i) => i !== index) })
  }

  function addSilenceFill(startMs: number, endMs: number): void {
    if (!(endMs > startMs)) return
    commit((draft) => { draft.repair.silenceFill = [...draft.repair.silenceFill, { startMs, endMs }] })
  }

  function removeSilenceFill(index: number): void {
    commit((draft) => { draft.repair.silenceFill = draft.repair.silenceFill.filter((_, i) => i !== index) })
  }

  // ── 噪声轮廓采样（docs/14 §5）─────────────────────────────────────────
  const noiseProfile = ref<{
    segmentId: Id
    startMs: number
    endMs: number
    rmsDb: number
    suggestedNf: number
    sampledAt: number
  } | null>(null)
  const noiseSampling = ref(false)

  /**
   * 采样一段「纯噪声」的底噪。
   * 主进程返回 `{ rmsDb, suggestedNf }`（docs/14 §5：推荐在 PCM 域直接算 RMS，
   * 不需要 ffmpeg，因而这里失败也不会因为「没有 ffmpeg」而不可用）。
   */
  async function sampleNoiseProfile(segmentId: Id, startMs: number, endMs: number): Promise<boolean> {
    if (!(endMs > startMs)) return false
    noiseSampling.value = true
    try {
      const res = await call('analysis:noiseProfile', { segmentId, startMs, endMs }) as {
        rmsDb: number
        suggestedNf: number
      }
      if (!res) return false
      noiseProfile.value = {
        segmentId,
        startMs,
        endMs,
        rmsDb: res.rmsDb,
        suggestedNf: res.suggestedNf,
        sampledAt: Date.now(),
      }
      return true
    } catch {
      // call() 已经按 error-bus 兑现过提示，这里只回滚状态
      return false
    } finally {
      noiseSampling.value = false
    }
  }

  /** 「采用建议值」：把采样到的 nf 写进降噪模块（docs/14 §5 第 3 步） */
  function adoptSuggestedNoiseFloor(): void {
    const profile = noiseProfile.value
    if (!profile) return
    commit((draft) => {
      draft.denoise.enabled = true
      draft.denoise.nf = clampTo(profile.suggestedNf, -80, -20)
    })
  }

  // ── 片段索引与套用范围 ────────────────────────────────────────────────
  const segmentIndex = ref<SegmentRef[]>([])
  const segmentIndexLoading = ref(false)
  const segmentIndexChapterId = ref<Id | null>(null)
  const scopeTargets = ref<ScopeTargets | null>(null)
  const scopeResolving = ref(false)
  const scopeCharacterId = ref<Id | null>(null)

  /** 章节的原素材路径（A/B 的「原始」一侧） */
  function sourcePathOf(segmentId: Id): string | null {
    return segmentIndex.value.find(item => item.segmentId === segmentId)?.sourcePath ?? null
  }

  function segmentsOfCharacter(characterId: Id | null): SegmentRef[] {
    if (!characterId) return []
    return segmentIndex.value.filter(item => item.characterId === characterId)
  }

  /**
   * 载入「片段索引」：把对轨 item 与画本行、take 文件对齐。
   *
   * 为什么要自己拼：IPC 契约里没有 `segment:listByChapter`，
   * 能拿到 segmentId 的地方只有 `alignment:get()` 的 items。
   * 于是：items → lineId → (画本行的 characterId / take 的 filePath)。
   * 这三份数据都是**只读**用途（解析套用范围、给 A/B 找原素材），不修改对轨域任何状态。
   */
  async function loadSegmentIndex(force = false): Promise<SegmentRef[]> {
    const session = useSessionStore()
    const chapterId = session.chapterId
    if (!chapterId) {
      segmentIndex.value = []
      return []
    }
    if (!force && segmentIndexChapterId.value === chapterId && segmentIndex.value.length) {
      return segmentIndex.value
    }

    segmentIndexLoading.value = true
    try {
      const arrangements = await callSafe('alignment:listArrangements', { chapterId }) as
        Array<{ id: Id; isDefault: boolean }> | null
      const arrangementId = arrangements?.find(a => a.isDefault)?.id ?? arrangements?.[0]?.id ?? null
      if (!arrangementId) {
        segmentIndex.value = []
        segmentIndexChapterId.value = chapterId
        return []
      }

      const [detail, linesPage, takes] = await Promise.all([
        call('alignment:get', { arrangementId }) as Promise<{ items: Array<{ segmentId: Id; lineId: Id; trackId: string }> }>,
        session.bookId
          ? callSafe('canvas:getChapter', { chapterId, limit: 5000 }) as Promise<{ lines: Array<{ id: Id; seq: number; characterId: Id | null; text: string }> } | null>
          : Promise.resolve(null),
        callSafe('take:listByChapter', { chapterId }) as Promise<Array<{ lineId: Id; filePath: string; isSelected: boolean }> | null>,
      ])

      const lineById = new Map<Id, { seq: number; characterId: Id | null; text: string }>()
      for (const line of linesPage?.lines ?? []) {
        lineById.set(line.id, { seq: line.seq, characterId: line.characterId, text: line.text })
      }

      const takeByLine = new Map<Id, string>()
      for (const take of takes ?? []) {
        if (take.isSelected || !takeByLine.has(take.lineId)) takeByLine.set(take.lineId, take.filePath)
      }

      const characterNames = new Map<Id, string>()
      if (session.bookId) {
        const characters = await callSafe('character:list', { bookId: session.bookId }) as
          Array<{ id: Id; name: string }> | null
        for (const character of characters ?? []) characterNames.set(character.id, character.name)
      }

      segmentIndex.value = (detail?.items ?? []).map((item) => {
        const line = lineById.get(item.lineId)
        const speaker = line?.characterId
          ? (characterNames.get(line.characterId) ?? '角色')
          : '旁白'
        return {
          segmentId: item.segmentId,
          lineId: item.lineId,
          characterId: line?.characterId ?? null,
          trackId: item.trackId ?? null,
          sourcePath: takeByLine.get(item.lineId) ?? null,
          label: `#${line?.seq ?? '?'} ${speaker}${line?.text ? `：${line.text.slice(0, 12)}` : ''}`,
        }
      })
      segmentIndexChapterId.value = chapterId
      return segmentIndex.value
    } finally {
      segmentIndexLoading.value = false
    }
  }

  /**
   * 解析套用范围 → segmentId 列表（docs/14 §4.2「应用范围」+ §7.1 第 1 步）。
   * book 范围要逐章取对轨方案，因此这里按需加载并把结果缓存起来供「将处理 N 个片段」预览。
   */
  async function resolveScope(
    scope: ProcessScope,
    options: { characterId?: Id | null; segmentIds?: Id[] } = {},
  ): Promise<ScopeTargets> {
    scopeResolving.value = true
    try {
      const session = useSessionStore()
      const characterId = options.characterId ?? scopeCharacterId.value

      if (scope === 'segment') {
        const ids = (options.segmentIds ?? []).slice(0, 5)
        scopeTargets.value = {
          scope,
          ids,
          preview: segmentIndex.value.filter(s => ids.includes(s.segmentId)).map(s => s.label),
          resolvedAt: Date.now(),
        }
        return scopeTargets.value
      }

      if (scope === 'character') {
        const matched = segmentsOfCharacter(characterId)
        scopeTargets.value = {
          scope,
          ids: matched.map(item => item.segmentId),
          preview: matched.slice(0, 30).map(item => item.label),
          resolvedAt: Date.now(),
        }
        return scopeTargets.value
      }

      if (scope === 'chapter') {
        const index = await loadSegmentIndex()
        scopeTargets.value = {
          scope,
          ids: index.map(item => item.segmentId),
          preview: index.slice(0, 30).map(item => item.label),
          resolvedAt: Date.now(),
        }
        return scopeTargets.value
      }

      // book：逐章解析。章数多时成本高，因此只在用户显式选择「全书」时才做。
      const chapters = session.bookId
        ? await callSafe('chapter:list', { bookId: session.bookId }) as Array<{ id: Id; title: string }> | null
        : null
      const labels: string[] = []
      const ids: Id[] = []
      for (const chapter of chapters ?? []) {
        const arrangements = await callSafe('alignment:listArrangements', { chapterId: chapter.id }) as
          Array<{ id: Id; isDefault: boolean }> | null
        const arrangementId = arrangements?.find(a => a.isDefault)?.id ?? arrangements?.[0]?.id ?? null
        if (!arrangementId) continue
        const detail = await callSafe('alignment:get', { arrangementId }) as
          { items: Array<{ segmentId: Id }> } | null
        for (const item of detail?.items ?? []) {
          ids.push(item.segmentId)
          if (labels.length < 30) labels.push(`${chapter.title} · ${item.segmentId.slice(0, 6)}`)
        }
      }
      scopeTargets.value = { scope, ids, preview: labels, resolvedAt: Date.now() }
      return scopeTargets.value
    } finally {
      scopeResolving.value = false
    }
  }

  // ── 套用（单片段 / 批量）──────────────────────────────────────────────
  const applying = ref(false)
  const batchTaskId = ref<Id | null>(null)
  const report = ref<BatchProcessReport>(emptyReport())

  /** 单片段套用：成功返回 taskId */
  async function applyToSegment(segmentId: Id, presetId: Id | null = null): Promise<Id | null> {
    applying.value = true
    try {
      const res = await call('process:apply', {
        segmentId,
        ...(presetId ? { presetId } : { chain: chain.value }),
      }) as { taskId: Id }
      return res?.taskId ?? null
    } catch {
      return null
    } finally {
      applying.value = false
    }
  }

  /**
   * 批量套用（docs/14 §7）。
   * 主进程会按 `process:{segmentId}:{presetHash}` 做幂等去重，重复点不会重跑。
   */
  async function batchApply(input: {
    scope: ProcessScope
    ids?: Id[]
    presetId?: Id | null
    /** 任务结束前是否把处理链标记为已应用 */
    chain?: ProcessChain
  }): Promise<Id | null> {
    applying.value = true
    try {
      const ids = input.ids ?? scopeTargets.value?.ids ?? []
      const useChain = input.chain ?? chain.value
      const res = await call('process:batchApply', {
        scope: input.scope,
        ids,
        ...(input.presetId ? { presetId: input.presetId } : { chain: useChain }),
      }) as { taskId: Id }
      const taskId = res?.taskId ?? null
      batchTaskId.value = taskId
      report.value = emptyReport(taskId)
      if (taskId && !input.presetId) markApplied()
      return taskId
    } catch {
      return null
    } finally {
      applying.value = false
    }
  }

  /** 任务结束后把结果解析成报告（由 BatchProcessReport 在 taskId 终态时调用） */
  async function collectReport(taskId: Id): Promise<BatchProcessReport> {
    const snapshot = await callSafe('task:get', { taskId }) as TaskRecord | null
    const parsed = parseBatchReport(snapshot?.result, taskId)
    if (snapshot && (snapshot.status === 'cancelled' || snapshot.status === 'interrupted')) {
      parsed.cancelled = true
    }
    report.value = parsed
    return parsed
  }

  /** 重试失败项：逐条重试，失败用 reportBatchFailures 汇总（不刷 N 条提示） */
  async function retryFailures(): Promise<number> {
    const failures = report.value.failures
    if (!failures.length) return 0
    const sink: Array<{ label: string; code: string; message: string }> = []
    let ok = 0
    for (const failure of failures) {
      if (!failure.segmentId) continue
      const result = await callCollecting('process:apply', {
        segmentId: failure.segmentId,
        chain: chain.value,
      }, sink, failure.label)
      if (result.ok) ok += 1
    }
    reportBatchFailures({
      total: failures.length,
      ok,
      failed: sink.length,
      samples: sink,
      retryFn: () => { void retryFailures() },
    })
    if (sink.length === 0) {
      report.value = { ...report.value, failures: [], failed: 0, succeeded: report.value.succeeded + ok }
    }
    return ok
  }

  /** 单条回退（docs/14 §7.3 的「回退」）：删掉 processed_path 引用，回到原始 */
  async function revertSegment(segmentId: Id): Promise<boolean> {
    const res = await callSafe('process:revert', { segmentId }) as { ok: boolean } | null
    if (res?.ok) {
      report.value = {
        ...report.value,
        failures: report.value.failures.filter(item => item.segmentId !== segmentId),
      }
      return true
    }
    return false
  }

  /** 查询已处理状态（processed_path / preset_hash），A/B 与列表中都要显示 */
  async function listApplied(segmentIds: Id[]): Promise<Map<Id, { processedPath: string | null; presetHash: string | null }>> {
    const map = new Map<Id, { processedPath: string | null; presetHash: string | null }>()
    if (!segmentIds.length) return map
    const res = await callSafe('process:listApplied', { segmentIds }) as
      Array<{ segmentId: Id; processedPath: string | null; presetHash: string | null }> | null
    for (const item of res ?? []) {
      map.set(item.segmentId, { processedPath: item.processedPath, presetHash: item.presetHash })
    }
    return map
  }

  // ── A/B 对比（docs/14 §10）───────────────────────────────────────────
  const ab = ref<AbState>(emptyAb())

  // ── 章节预览渲染（docs/15 §8：长章节只渲前 30 秒）─────────────────────
  //    必须声明在 clearPreviewCache() 之前：该函数会被**更早**的 loadChain() 调用，
  //    而 const 有暂时性死区 —— 声明在后会在首次「载入链」时抛 ReferenceError。
  const previewTaskId = ref<Id | null>(null)
  const previewRendering = ref(false)
  const previewError = shallowRef<unknown>(null)

  function patchAb(patch: Partial<AbState>): void {
    ab.value = { ...ab.value, ...patch }
  }

  /**
   * 打开 A/B 对比：渲染「原始 vs 当前处理链」的两段音频。
   * A 侧直接用片段原素材（take 文件）→ ns-media URL，不需要 ffmpeg；
   * B 侧必须真渲染（process:preview），这也是 docs/15 §8 强调的「渲染预览才是正确验证手段」。
   */
  async function openAbCompare(segmentId: Id, options: { label?: string; durationMs?: number } = {}): Promise<void> {
    const session = useSessionStore()
    await loadSegmentIndex()
    const refInfo = segmentIndex.value.find(item => item.segmentId === segmentId)
    const sourcePath = refInfo?.sourcePath ?? null

    patchAb({
      enabled: true,
      mode: 'chain',
      segmentId,
      label: options.label ?? refInfo?.label ?? segmentId.slice(0, 8),
      originalUrl: buildOriginalUrl(sourcePath, session.projectId),
      originalLevels: null,
      processedUrl: null,
      processedLevels: null,
      loading: true,
      side: 'A',
      error: null,
      remembered: null,
    })

    const result = await renderProcessedPreview({
      segmentId,
      chain: chain.value,
      durationMs: options.durationMs ?? DEFAULT_PREVIEW_DURATION_MS,
      debounceMs: 0,
      projectId: session.projectId,
    })

    if (result.superseded) return

    if (!result.url) {
      patchAb({ loading: false, error: result.error })
      return
    }

    // 实测 B 侧电平：真实的响度/峰值来自 analysis:metrics，而不是随便动一动的假动画
    const metrics: AudioMetrics | null = result.path ? await measurePreviewFile(result.path) : null

    patchAb({
      loading: false,
      processedUrl: result.url,
      processedLevels: metrics
        ? { rmsDb: metrics.rmsDb ?? null, peakDb: metrics.peakDb ?? null }
        : null,
      error: null,
    })

    // A 侧也测一次（原素材是项目内相对路径，主进程能直接读）
    if (sourcePath) {
      const originalMetrics = await measurePreviewFile(sourcePath)
      if (originalMetrics) {
        patchAb({ originalLevels: { rmsDb: originalMetrics.rmsDb ?? null, peakDb: originalMetrics.peakDb ?? null } })
      }
    }
  }

  function buildOriginalUrl(sourcePath: string | null, projectId: Id | null): string | null {
    return resolveMediaUrl(projectId, sourcePath)
  }

  function closeAbCompare(): void {
    ab.value = emptyAb()
  }

  /**
   * 清空「预览产物」相关的状态。
   *
   * 调用时机（本文件共 4 处）：换链（loadChain）、提交参数（commit）、
   * 回退基线（revertToBaseline）、整体复位（reset）。
   * 语义是「链变了 → 之前的渲染结果与 A/B 测量不再对应当前参数」，
   * 因此必须一并清掉：预览任务号、预览错误，以及 A/B 里的测量值。
   * 不清会让用户对着旧参数的音频评判新参数（docs/15 §8 的「错觉陷阱」）。
   */
  function clearPreviewCache(): void {
    previewTaskId.value = null
    previewError.value = null
    previewRendering.value = false
    ab.value = emptyAb()
  }

  /**
   * 「记住选择」（docs/14 §10 的列表盲听）：
   *   · 选 A（原始更好）→ 回退该片段的处理结果（process:revert）；
   *   · 选 B（处理后更好）→ 用当前链重新套用一次（process:apply）。
   * 这就是「把胜出的一侧写入 take/segment 的选择」在当前契约下的落地方式：
   * 胜出侧决定了 voice_segments.processed_path 是保留还是清空。
   */
  async function rememberAbSide(side: 'A' | 'B'): Promise<boolean> {
    const segmentId = ab.value.segmentId
    if (!segmentId) return false
    if (side === 'A') {
      const ok = await revertSegment(segmentId)
      if (ok) patchAb({ remembered: 'A' })
      return ok
    }
    const taskId = await applyToSegment(segmentId)
    if (taskId) {
      patchAb({ remembered: 'B' })
      return true
    }
    return false
  }

  /**
   * 处理链「逐步启用」试听（docs/14 §10）：只启用指定模块、其余全关，
   * 用来判断某个模块到底贡献了什么（教学与排障用）。
   */
  async function previewSingleModule(key: ChainModuleKey, segmentId: Id): Promise<void> {
    const only = emptyChain()
    switch (key) {
      case 'highpass': only.highpass.enabled = true; break
      case 'denoise': only.denoise.enabled = true; break
      case 'deesser': only.deesser.enabled = true; break
      case 'eq': only.eq = chain.value.eq.map(band => ({ ...band })); break
      case 'compressor': only.compressor.enabled = true; break
      case 'limiter': only.limiter.enabled = true; break
      case 'repair': only.repair = cloneChain(chain.value).repair; break
      default: break
    }
    const session = useSessionStore()
    const sourcePath = sourcePathOf(segmentId)
    patchAb({
      enabled: true,
      mode: 'chain',
      segmentId,
      label: `${moduleMeta(key).label.split('（')[0]} 单模块试听`,
      originalUrl: buildOriginalUrl(sourcePath, session.projectId),
      originalLevels: null,
      processedUrl: null,
      processedLevels: null,
      loading: true,
      side: 'A',
      error: null,
      remembered: null,
    })

    const result = await renderProcessedPreview({
      segmentId,
      chain: only,
      debounceMs: 0,
      projectId: session.projectId,
    })
    if (result.superseded) return
    if (!result.url) {
      patchAb({ loading: false, error: result.error })
      return
    }
    const metrics = result.path ? await measurePreviewFile(result.path) : null
    patchAb({
      loading: false,
      processedUrl: result.url,
      processedLevels: metrics ? { rmsDb: metrics.rmsDb ?? null, peakDb: metrics.peakDb ?? null } : null,
    })
  }

  // ── 章节预览渲染（docs/15 §8：长章节只渲前 30 秒）─────────────────────
  /**
   * 渲染章节预览（`alignment:previewRender`）并返回产物路径。
   * 混音侧的「响度实测」与「ducking 开关对比」都需要一个真实的渲染产物，
   * 而 IPC 契约里**没有** `mix:previewRender`（docs/15 §10 列了但契约未实现，
   * 见汇报）；可用的替代就是对轨域的区间预览渲染通道。
   */
  async function renderChapterPreview(input: {
    arrangementId: Id
    mixProjectId: Id | null
    startMs?: number
    durationMs?: number
  }): Promise<{ path: string | null; taskId: Id | null; error: unknown }> {
    previewRendering.value = true
    previewError.value = null
    try {
      const res = await call('alignment:previewRender', {
        arrangementId: input.arrangementId,
        mixProjectId: input.mixProjectId,
        startMs: input.startMs ?? 0,
        durationMs: input.durationMs ?? DEFAULT_PREVIEW_DURATION_MS,
      }) as { taskId: Id }
      const taskId = res?.taskId ?? null
      previewTaskId.value = taskId
      if (!taskId) return { path: null, taskId: null, error: null }

      const finished = await waitForTask(taskId)
      const path = extractPathFromTaskResult(finished.result)
      if (!path) previewError.value = finished.error ?? new Error('预览渲染任务未返回产物路径')
      return { path, taskId, error: finished.error }
    } catch (error) {
      previewError.value = error
      return { path: null, taskId: null, error }
    } finally {
      previewRendering.value = false
    }
  }

  // ── 状态复位（切换章节）──────────────────────────────────────────────
  function reset(): void {
    chain.value = emptyChain()
    origin.value = { kind: 'scratch', id: null, label: '临时链' }
    appliedPresetId.value = null
    baselineSnapshot.value = emptyChain()
    segmentIndex.value = []
    segmentIndexChapterId.value = null
    scopeTargets.value = null
    noiseProfile.value = null
    ab.value = emptyAb()
    report.value = emptyReport()
    batchTaskId.value = null
    clearPreviewCache()
  }

  /** 把 IPC 异常交给 error-bus 的兜底入口（组件里少数需要显式报错的地方用它） */
  function reportFailure(error: unknown, event: string): void {
    reportError(error, { event })
  }

  return {
    // 链
    chain, origin, appliedPresetId, dirty, isEmpty, activeModules, summary,
    loadChain, loadFromPreset, commit, resetChain, revertToBaseline, markApplied,
    setModuleEnabled, addEqBand, patchEqBand, removeEqBand, setEqBands,
    addDeclick, removeDeclick, addSilenceFill, removeSilenceFill,
    // 能力探测
    ffmpegCaps, capsLoading, missingFilters, ffmpegAvailable,
    isFilterAvailable, isModuleAvailable, moduleUnavailableReason, loadFfmpegCapabilities,
    // 噪声轮廓
    noiseProfile, noiseSampling, sampleNoiseProfile, adoptSuggestedNoiseFloor,
    // 片段索引与范围
    segmentIndex, segmentIndexLoading, scopeTargets, scopeResolving, scopeCharacterId,
    loadSegmentIndex, resolveScope, sourcePathOf, segmentsOfCharacter,
    // 套用与报告
    applying, batchTaskId, report,
    applyToSegment, batchApply, collectReport, retryFailures, revertSegment, listApplied,
    // A/B
    ab, openAbCompare, closeAbCompare, rememberAbSide, previewSingleModule, patchAb,
    // 章节预览
    previewTaskId, previewRendering, previewError, renderChapterPreview,
    reset, reportFailure,
  }
})

/** 小工具：拼 ns-media URL（失败返回 null，调用方按「无原素材」处理） */
function resolveMediaUrl(projectId: Id | null, relativePath: string | null): string | null {
  return tryBuildMediaUrl(projectId, relativePath)
}
