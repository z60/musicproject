/**
 * Novel Studio · 电平 / 响度表引擎（docs/12 §10、docs/14 §10、docs/15 §9）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §9 —— 混音台「表头」：通道条 BusMeter（峰值 + RMS + 削波）与总线
 *     LoudnessMeter（EBU 风格：短期 / 积分 / 真峰三行，刻度 -40~0 LUFS）
 *   · docs/12 §10 —— 录音页的实时电平（峰值 + 有效值 + 削波指示），同一套口径
 *   · docs/04 §2.4 —— 实时刷新类 UI 不许各自造轮子
 *
 * 三条硬性约束（本文件存在的全部理由）：
 *   1. **不许堆 DOM 柱**。所有表头都是「一个 Canvas + 每帧重绘」，
 *      或复用 shared/ui/LevelMeter.vue（纯 CSS 两条 + 锁存削波）。绘制过程
 *      不创建任何节点，因此 20 个表头同时跑也不会让布局引擎忙起来。
 *
 *   2. **计算与渲染分离**。电平的「弹道」（峰值保持衰减、RMS 起振/释放、
 *      削波锁存、积分响度累加）全部是纯函数 `advanceMeterState()`；
 *      Canvas 绘制只读 state 画像素。纯函数可以脱离 Canvas / Vue 单测
 *      （docs/14 §14 的表头类测试都依赖这一点）。
 *
 *   3. **统一节流**：全应用只有**一个** rAF 循环，被注册的表头依次 tick；
 *      Vue 响应式状态最多每 50 ms（20 次/秒）发布一次，其余帧只写 Canvas。
 *
 *      为什么必须节流（而不是每个表头各自 setState）：
 *        混音台一屏可能有 1 个主控表 + 12 个通道条表 + 3 个响度行，
 *        若每个表头在 60 fps 里各自 `ref.value = {...}`，就是 ~1000 次/秒的
 *        setState。每次 setState 会写入响应式依赖并触发**整棵子树**的
 *        patch/diff（Vue 只是把更新批到 microtask，并不能免掉依赖收集与 vdom diff）。
 *        实际表现是：拖推子掉帧、数字读数乱跳、表头颜色闪。
 *      而人对**视觉平滑**的需求是每帧级的（所以 Canvas 每帧画），
 *      对**数字读数**的需求只有 ~20 Hz（所以 Vue 状态 20 Hz 发布）。
 *      两者分开之后，每帧的计算成本只剩几次浮点运算。
 */

import { onScopeDispose, readonly, shallowRef } from 'vue'
import type { Ref } from 'vue'
import { formatDb } from '@/shared/lib/format.ts'
import { themeColor } from '@/shared/lib/canvas-theme.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** Vue 侧读数的发布间隔：20 次/秒（见文件头第 3 条） */
export const METER_PUBLISH_INTERVAL_MS = 50

/** 表头默认显示区间（dBFS） */
export const DEFAULT_MIN_DB = -60
export const DEFAULT_MAX_DB = 0

/** 峰值保持线：先停留，再按此速度下落 */
export const PEAK_HOLD_MS = 1500
export const PEAK_HOLD_DECAY_DB_PER_SEC = 20

/** RMS 条的起振/释放时间常数（快起慢落，接近硬件表头手感） */
export const RMS_ATTACK_MS = 30
export const RMS_RELEASE_MS = 320

/** 无信号输入时读数回落速度（避免表头「冻」在旧值上骗人） */
export const IDLE_DECAY_DB_PER_SEC = 30

/** 削波判定阈值（dBFS）：docs/12 §3.3 要求 -0.1 dB 即视为削波 */
export const CLIP_THRESHOLD_DB = -0.1

/** 一个 RMS 帧最长按多久计算弹道（防止切回标签页时一帧跳到底） */
const MAX_FRAME_DT_MS = 200

// ---------------------------------------------------------------------------
// 纯函数：电平弹道
// ---------------------------------------------------------------------------

/** 一次采样的原始电平（dBFS）；null 表示「本次没有数据」 */
export interface MeterLevels {
  rmsDb: number | null
  peakDb: number | null
}

/** 表头状态（纯数据，可序列化、可单测） */
export interface MeterState {
  /** 平滑后的有效值（dBFS） */
  rmsDb: number | null
  /** 瞬时峰值（dBFS） */
  peakDb: number | null
  /** 峰值保持读数（dBFS），到点后下落 */
  peakHoldDb: number | null
  peakHoldSinceMs: number
  /** 削波锁存：一旦发生就亮，直到 clearClip（docs/12 §3.3） */
  clipping: boolean
  /** 本次是否有真实信号（用于「未采样」与「静音」的区分） */
  active: boolean
  /** 近似短期响度（LUFS，见 approxShortTermLufs） */
  shortTermLufs: number | null
  /** 近似积分响度（LUFS，能量均值 + 绝对门限） */
  integratedLufs: number | null
  /** 积分累加的块数（诊断用） */
  integratedBlocks: number
  /** 最后一次收到信号的时间戳 */
  updatedAtMs: number
}

export interface BallisticsOptions {
  minDb?: number
  maxDb?: number
  /** 削波判定阈值 */
  clipDb?: number
  rmsAttackMs?: number
  rmsReleaseMs?: number
  peakHoldMs?: number
  peakHoldDecayDbPerSec?: number
  /** 是否累加积分响度（只有总线响度表需要） */
  integrate?: boolean
}

/** 空的表头状态 */
export function createMeterState(nowMs = 0): MeterState {
  return {
    rmsDb: null,
    peakDb: null,
    peakHoldDb: null,
    peakHoldSinceMs: 0,
    clipping: false,
    active: false,
    shortTermLufs: null,
    integratedLufs: null,
    integratedBlocks: 0,
    updatedAtMs: nowMs,
  }
}

/** dB → 0~1 的显示比例（-∞ 归 0；越界收敛） */
export function ratioOfDb(db: number | null | undefined, minDb: number, maxDb: number): number {
  if (db === null || db === undefined) return 0
  if (!Number.isFinite(db)) return 0
  const span = maxDb - minDb
  if (!(span > 0)) return 0
  return Math.min(1, Math.max(0, (db - minDb) / span))
}

/** 显示比例 → dB（画刻度、反向读值时用） */
export function dbOfRatio(ratio: number, minDb: number, maxDb: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  return minDb + clamped * (maxDb - minDb)
}

/** 对数式刻度（电平表习惯：-60/-50/-40/-30/-24/-18/-12/-6/-3/0） */
export const DEFAULT_METER_TICKS = [-60, -50, -40, -30, -24, -18, -12, -6, -3, 0] as const

/** 在区间内按步长生成刻度（步长为 0 或区间非法时返回空数组） */
export function meterTicks(minDb: number, maxDb: number, step = 6): number[] {
  if (!(step > 0) || !(maxDb > minDb)) return []
  const out: number[] = []
  for (let db = Math.ceil(minDb / step) * step; db <= maxDb + 1e-6; db += step) {
    out.push(Number(db.toFixed(3)))
  }
  return out
}

/**
 * 一极点平滑：`tau` 是时间常数（毫秒）。
 * 用指数形式保证「不同帧率下观感一致」——线性插值会让 30 fps 与 60 fps 的表头手感不同。
 */
function smoothDb(prev: number | null, next: number, dtMs: number, tauMs: number): number {
  if (!Number.isFinite(next)) return prev ?? Number.NEGATIVE_INFINITY
  if (prev === null || !Number.isFinite(prev)) return next
  if (!(tauMs > 0)) return next
  const alpha = 1 - Math.exp(-dtMs / tauMs)
  return prev + (next - prev) * alpha
}

/**
 * 近似短期响度（LUFS）。
 * ============================================================================
 * 注意：这是**近似值，只用于实时视觉反馈**。
 *   EBU R128 的短期响度要求 K 加权（两级 shelving + highpass）后在 3 s 窗口上
 *   积分，并由 ffmpeg 的 `ebur128`/`loudnorm` 给出。渲染进程里我们没有 K 加权
 *   滤波器（也不该在这里做重 DSP），因此用「宽频 RMS - 0.691 dB」近似：
 *      LUFS = -0.691 + 10*log10( Σ (K加权均方) )
 *   对旁白这类以中频为主的素材，宽带 RMS 与 K 加权 RMS 的差通常在 ±1.5 LU 内。
 *   权威值一律取 docs/05 §8 的两遍法测量（mix:measureLoudness / analysis:metrics）。
 */
export function approxShortTermLufs(rmsDb: number | null | undefined): number | null {
  if (rmsDb === null || rmsDb === undefined) return null
  if (!Number.isFinite(rmsDb)) return null
  return rmsDb - 0.691
}

/** 响度表显示区间（LUFS）：docs/15 §9 要求 -40~0 */
export const LUFS_MIN = -40
export const LUFS_MAX = 0

/** LUFS → 0~1 显示比例（同样刻度口径，供 Canvas 与读数共用） */
export function ratioOfLufs(lufs: number | null | undefined): number {
  return ratioOfDb(lufs, LUFS_MIN, LUFS_MAX)
}

/**
 * 推进一步表头状态（**纯函数**）。
 *
 * 语义细节：
 *   · `levels` 两个字段都是 null → 视为「没有数据」：读数按 IDLE_DECAY 回落，
 *     `active=false`，而**削波锁存保持不变**（它必须等用户点掉）。
 *   · RMS 用「快起慢落」：起振 30 ms、释放 320 ms（硬件表头手感，也让读数可读）。
 *   · 峰值保持：出现新峰值时刷新起点，停留 `peakHoldMs` 后按
 *     `peakHoldDecayDbPerSec` 下落（0 dB/s 表示不回落的表头可传 0）。
 *   · 积分响度：只累加 > -70 LUFS 的块（EBU 绝对门限），并做能量平均。
 */
export function advanceMeterState(
  prev: MeterState,
  levels: MeterLevels,
  dtMs: number,
  options: BallisticsOptions = {},
): MeterState {
  const minDb = options.minDb ?? DEFAULT_MIN_DB
  const maxDb = options.maxDb ?? DEFAULT_MAX_DB
  const clipDb = options.clipDb ?? CLIP_THRESHOLD_DB
  const dt = Math.min(MAX_FRAME_DT_MS, Math.max(0, Number.isFinite(dtMs) ? dtMs : 0))

  const rawRms = Number.isFinite(levels.rmsDb as number) ? (levels.rmsDb as number) : null
  const rawPeak = Number.isFinite(levels.peakDb as number) ? (levels.peakDb as number) : null
  const active = rawRms !== null || rawPeak !== null

  // ── RMS：有数据时按快起慢落平滑；无数据时向区间下界释放 ──
  let rmsDb: number | null
  if (rawRms !== null) {
    const tau = prev.rmsDb !== null && rawRms < prev.rmsDb
      ? (options.rmsReleaseMs ?? RMS_RELEASE_MS)
      : (options.rmsAttackMs ?? RMS_ATTACK_MS)
    const next = smoothDb(prev.rmsDb, rawRms, dt, tau)
    rmsDb = Number.isFinite(next) ? next : null
  } else if (prev.rmsDb !== null) {
    const floor = minDb - 6
    const dropped = prev.rmsDb - (IDLE_DECAY_DB_PER_SEC * dt) / 1000
    rmsDb = dropped <= floor ? null : dropped
  } else {
    rmsDb = null
  }

  // ── 峰值：瞬时；无数据时同样回落（避免「冻表」） ──
  let peakDb: number | null
  if (rawPeak !== null) {
    peakDb = rawPeak
  } else if (prev.peakDb !== null) {
    const floor = minDb - 6
    const dropped = prev.peakDb - (IDLE_DECAY_DB_PER_SEC * dt) / 1000
    peakDb = dropped <= floor ? null : dropped
  } else {
    peakDb = null
  }

  // ── 峰值保持：刷新起点 → 停留 → 下落 ──
  const holdMs = options.peakHoldMs ?? PEAK_HOLD_MS
  const decay = options.peakHoldDecayDbPerSec ?? PEAK_HOLD_DECAY_DB_PER_SEC
  let peakHoldDb = prev.peakHoldDb
  let peakHoldSinceMs = prev.peakHoldSinceMs
  if (peakDb !== null && (peakHoldDb === null || peakDb >= peakHoldDb)) {
    peakHoldDb = peakDb
    peakHoldSinceMs = prev.updatedAtMs
  } else if (peakHoldDb !== null) {
    const heldForMs = prev.updatedAtMs > 0 ? Math.max(0, prev.updatedAtMs - peakHoldSinceMs) : 0
    if (heldForMs > holdMs && decay > 0) {
      const floor = minDb - 6
      const dropped = peakHoldDb - (decay * dt) / 1000
      peakHoldDb = dropped <= floor ? null : dropped
    }
  }

  // ── 削波锁存：只有 clearClip（外部把 clipping 置 false）才清 ──
  const clipping = prev.clipping
    || (peakDb !== null && peakDb >= clipDb)
    || (rawPeak !== null && rawPeak >= maxDb)

  const shortTermLufs = approxShortTermLufs(rmsDb)

  // ── 积分响度：EBU 绝对门限 -70 LUFS，能量均值 ──
  let integratedLufs = prev.integratedLufs
  let integratedBlocks = prev.integratedBlocks
  if (options.integrate && shortTermLufs !== null && shortTermLufs > -70) {
    const prevEnergy = integratedLufs === null
      ? 0
      : Math.pow(10, integratedLufs / 10) * integratedBlocks
    const total = prevEnergy + Math.pow(10, shortTermLufs / 10)
    integratedBlocks = integratedBlocks + 1
    integratedLufs = 10 * Math.log10(total / integratedBlocks)
  }

  return {
    rmsDb,
    peakDb,
    peakHoldDb,
    peakHoldSinceMs,
    clipping,
    active,
    shortTermLufs,
    integratedLufs,
    integratedBlocks,
    updatedAtMs: prev.updatedAtMs + dt,
  }
}

// ---------------------------------------------------------------------------
// 电平来源：push（主进程 / 分析结果）与 Web Audio（预听时实时分析）
// ---------------------------------------------------------------------------

/** 各表头的推送值（key = 表头 id）。组件不传 getLevels 时读这里 */
const pushedLevels = new Map<string, MeterLevels>()

/**
 * 各表头的「即时读数源」（key = 表头 id）。
 * 与 push 的区别：push 是别人算好塞进来（4~20 Hz 的事件/实测值），
 * provider 是**由统一 rAF 循环按帧去拉**（例如 Web Audio 分析器）。
 * 有了它，生产者不需要自己再起一个 rAF 或 setInterval —— 这是「统一驱动」的关键。
 */
const levelProviders = new Map<string, () => MeterLevels>()

/** 推送一次电平（高频、可丢弃；由实测指标 analysis:metrics 等驱动） */
export function pushMeterLevels(id: string, levels: MeterLevels): void {
  pushedLevels.set(id, levels)
}

/** 清掉推送值（停止播放 / 切换章节时调用，避免残留旧电平） */
export function clearMeterLevels(id?: string): void {
  if (id) pushedLevels.delete(id)
  else pushedLevels.clear()
}

/** 挂一个按帧拉取的读数源；返回解绑函数 */
export function setMeterLevelProvider(id: string, read: () => MeterLevels): () => void {
  levelProviders.set(id, read)
  return () => {
    if (levelProviders.get(id) === read) levelProviders.delete(id)
  }
}

/** 读一次当前值（provider 优先于 push） */
export function readPushedLevels(id: string): MeterLevels {
  const provider = levelProviders.get(id)
  if (provider) return provider()
  return pushedLevels.get(id) ?? { rmsDb: null, peakDb: null }
}

/**
 * 用「实测指标」点亮一个表头（静态电平）。
 * 场景：混音台里用户点「采样轨道电平」后，用 `analysis:metrics` 的
 * rms/peak 值给每条轨一个**静态**指示，用来横向比较各轨响度是否失衡。
 * 注意：这不是实时电平——主进程没有 `mix:level` 事件（见报告里的契约缺口）。
 */
export function pushStaticLevels(id: string, rmsDb: number | null, peakDb: number | null): void {
  pushMeterLevels(id, { rmsDb, peakDb })
}

// ---------------------------------------------------------------------------
// Web Audio 实时分析（预听时）
// ---------------------------------------------------------------------------

let sharedContext: AudioContext | null = null
/** 同一个 <audio> 不能创建两次 MediaElementSource（会抛 InvalidStateError） */
const analyserByElement = new WeakMap<HTMLMediaElement, AnalyserLevels>()

export interface AnalyserLevels {
  /** 读一次电平均值（dBFS） */
  read: () => MeterLevels
  /** 断开与恢复（切歌/停止播放时） */
  suspend: () => void
  resume: () => void
  dispose: () => void
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (sharedContext) return sharedContext
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    sharedContext = new Ctor()
    return sharedContext
  } catch {
    // 没有可用的音频设备（罕见：无声卡/被系统禁用）→ 表头退化为「无信号」。
    // 这里刻意不弹提示：没有音频设备时用户已经能从「播不出声」感知到问题，
    // 再弹一条只会刷屏（docs/22 §7 的展示策略）。
    return null
  }
}

/**
 * 给一个 <audio> 接上分析器，返回电平读取器。
 * 失败（无 AudioContext / 元素已被其它分析器占用）返回 null，调用方退化为「无信号」。
 */
export function attachAnalyser(element: HTMLMediaElement): AnalyserLevels | null {
  const existing = analyserByElement.get(element)
  if (existing) return existing

  const ctx = getAudioContext()
  if (!ctx) return null

  let source: MediaElementAudioSourceNode
  let analyser: AnalyserNode
  try {
    source = ctx.createMediaElementSource(element)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)
    // 必须再接回 destination，否则 createMediaElementSource 之后**没有声音**
    // （这是 Web Audio 最经典的坑：接了 source 就切断了元素的默认输出路径）。
    analyser.connect(ctx.destination)
  } catch {
    return null
  }

  const buffer = new Float32Array(analyser.fftSize)

  const handle: AnalyserLevels = {
    read(): MeterLevels {
      analyser.getFloatTimeDomainData(buffer)
      let sumSquares = 0
      let peak = 0
      for (let i = 0; i < buffer.length; i++) {
        const v = buffer[i] ?? 0
        sumSquares += v * v
        const abs = Math.abs(v)
        if (abs > peak) peak = abs
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, buffer.length))
      return {
        rmsDb: rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY,
        peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
      }
    },
    suspend(): void {
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined)
    },
    resume(): void {
      // 浏览器要求用户手势后才能 resume；播放按钮就是那个手势
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    },
    dispose(): void {
      try {
        source.disconnect()
        analyser.disconnect()
      } catch {
        /* 已断开，忽略 */
      }
      analyserByElement.delete(element)
    },
  }

  analyserByElement.set(element, handle)
  return handle
}

// ---------------------------------------------------------------------------
// Canvas 渲染（每帧调用，纯绘制）
// ---------------------------------------------------------------------------

export interface MeterCanvasFrame {
  ctx: CanvasRenderingContext2D
  /** CSS 像素宽高（已由 prepareCanvas 处理 DPR） */
  width: number
  height: number
}

/**
 * 准备画布：按 devicePixelRatio 调整后备缓冲，并返回 CSS 像素尺寸的上下文。
 * 不做这一步的话，高分屏上表头会糊（Canvas 默认 1:1 位图被拉伸）。
 */
export function prepareCanvas(canvas: HTMLCanvasElement | null): MeterCanvasFrame | null {
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 1))
  const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1))
  const dpr = Math.min(3, Math.max(1, (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1))
  const backingWidth = Math.round(width * dpr)
  const backingHeight = Math.round(height * dpr)
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth
    canvas.height = backingHeight
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, width, height }
}

export interface BarMeterDrawOptions {
  minDb?: number
  maxDb?: number
  orientation?: 'horizontal' | 'vertical'
  /** RMS 条颜色 */
  color?: string
  /** 峰值保持线颜色 */
  peakColor?: string
  /** 刻度线（画在条上，帮助读数） */
  ticks?: readonly number[]
  /** 是否画削波指示条 */
  clipIndicator?: boolean
}

const COLOR_LOW = 'rgb(103 194 58 / 85%)'
const COLOR_MID = 'rgb(230 162 60 / 90%)'
const COLOR_HIGH = 'rgb(245 108 108 / 95%)'

/**
 * 画一条电平条（Canvas 自绘）。
 * 颜色分区与 shared/ui/LevelMeter 保持一致：>-6 dBFS 黄、>-1 dBFS 红。
 */
export function drawBarMeter(
  frame: MeterCanvasFrame,
  state: MeterState,
  options: BarMeterDrawOptions = {},
): void {
  const { ctx, width, height } = frame
  const minDb = options.minDb ?? DEFAULT_MIN_DB
  const maxDb = options.maxDb ?? DEFAULT_MAX_DB
  const vertical = options.orientation === 'vertical'

  ctx.clearRect(0, 0, width, height)

  // 底槽
  ctx.fillStyle = 'rgb(0 0 0 / 8%)'
  ctx.fillRect(0, 0, width, height)

  const span = Math.max(1, maxDb - minDb)
  const length = vertical ? height : width

  // RMS 条
  const rmsRatio = ratioOfDb(state.rmsDb, minDb, maxDb)
  if (rmsRatio > 0) {
    const size = Math.max(1, length * rmsRatio)
    const gradient = vertical
      ? ctx.createLinearGradient(0, height, 0, 0)
      : ctx.createLinearGradient(0, 0, width, 0)
    gradient.addColorStop(0, options.color ?? COLOR_LOW)
    gradient.addColorStop(Math.min(0.95, 1 - 6 / span), options.color ?? COLOR_MID)
    gradient.addColorStop(1, options.color ?? COLOR_HIGH)
    ctx.fillStyle = gradient
    if (vertical) ctx.fillRect(0, height - size, width, size)
    else ctx.fillRect(0, 0, size, height)
  }

  // 刻度（只画在条的范围内，避免视觉噪音）
  ctx.fillStyle = 'rgb(0 0 0 / 18%)'
  for (const tick of options.ticks ?? DEFAULT_METER_TICKS) {
    if (tick < minDb || tick > maxDb) continue
    const ratio = (tick - minDb) / span
    if (vertical) {
      const y = Math.round(height - ratio * height)
      ctx.fillRect(0, Math.min(height - 1, y), width, 1)
    } else {
      const x = Math.round(ratio * width)
      ctx.fillRect(Math.min(width - 1, x), 0, 1, height)
    }
  }

  // 峰值保持线（2 px，比 RMS 条更醒目）
  const holdRatio = ratioOfDb(state.peakHoldDb, minDb, maxDb)
  if (state.peakHoldDb !== null && holdRatio > 0) {
    ctx.fillStyle = options.peakColor ?? themeColor('--ns-text-primary', 'rgb(48 49 51 / 90%)')
    if (vertical) {
      const y = Math.max(0, Math.min(height - 2, height - holdRatio * height - 1))
      ctx.fillRect(0, y, width, 2)
    } else {
      const x = Math.max(0, Math.min(width - 2, holdRatio * width - 1))
      ctx.fillRect(x, 0, 2, height)
    }
  }

  // 削波指示
  if (options.clipIndicator !== false && state.clipping) {
    ctx.fillStyle = 'rgb(245 108 108)'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = 'rgb(255 255 255)'
    ctx.font = '10px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('CLIP', width / 2, height / 2)
  }
}

/**
 * 画 EBU 风格响度表（短期 / 积分 / 真峰三行，刻度 -40~0 LUFS）。
 * docs/15 §9：与 BusMeter 的区别在于纵轴是 LUFS 且带目标线。
 */
export function drawLoudnessMeter(
  frame: MeterCanvasFrame,
  input: {
    shortTermLufs: number | null
    integratedLufs: number | null
    truePeakDb: number | null
    targetLufs: number
    /** 真峰上限（dBTP），用于画红线 */
    truePeakLimitDb: number
    lra?: number | null
  },
): void {
  const { ctx, width, height } = frame
  ctx.clearRect(0, 0, width, height)

  const rows = 3
  const gap = 3
  const rowHeight = Math.max(6, (height - gap * (rows - 1)) / rows)
  const labelWidth = 26
  const barLeft = labelWidth
  const barWidth = Math.max(10, width - labelWidth)
  const span = LUFS_MAX - LUFS_MIN

  // 刻度网格（每 5 LUFS 一条）
  ctx.strokeStyle = 'rgb(0 0 0 / 12%)'
  ctx.lineWidth = 1
  for (let lufs = LUFS_MIN; lufs <= LUFS_MAX; lufs += 5) {
    const x = Math.round(barLeft + ((lufs - LUFS_MIN) / span) * barWidth) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }

  const rowY = (index: number): number => index * (rowHeight + gap)

  const drawRow = (
    index: number,
    label: string,
    ratio: number,
    color: string,
    extra?: { limitRatio?: number; limitColor?: string },
  ): void => {
    const y = rowY(index)
    ctx.fillStyle = 'rgb(0 0 0 / 7%)'
    ctx.fillRect(barLeft, y, barWidth, rowHeight)
    if (ratio > 0) {
      ctx.fillStyle = color
      ctx.fillRect(barLeft, y, Math.max(1, barWidth * ratio), rowHeight)
    }
    if (extra?.limitRatio !== undefined) {
      ctx.fillStyle = extra.limitColor ?? 'rgb(245 108 108)'
      const x = Math.max(barLeft, Math.min(barLeft + barWidth - 1, barLeft + extra.limitRatio * barWidth))
      ctx.fillRect(x, y, 1, rowHeight)
    }
    ctx.fillStyle = 'rgb(96 98 102)'
    ctx.font = '9px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 2, y + rowHeight / 2)
  }

  drawRow(0, 'S', ratioOfLufs(input.shortTermLufs), 'rgb(64 158 255 / 80%)')
  drawRow(1, 'I', ratioOfLufs(input.integratedLufs), 'rgb(103 194 58 / 80%)', {
    limitRatio: ratioOfLufs(input.targetLufs),
    limitColor: 'rgb(230 162 60)',
  })

  // 真峰行：dBTP 直接映射到 -40~0（与 LUFS 同刻度，便于一眼比较）
  drawRow(2, 'TP', ratioOfDb(input.truePeakDb, LUFS_MIN, LUFS_MAX), 'rgb(245 108 108 / 80%)', {
    limitRatio: ratioOfDb(input.truePeakLimitDb, LUFS_MIN, LUFS_MAX),
    limitColor: 'rgb(48 49 51)',
  })
}

/** 表头读数文案（统一口径，避免每个组件自己拼「-∞」） */
export function meterReadout(state: MeterState): string {
  return `RMS ${formatDb(state.rmsDb === Number.NEGATIVE_INFINITY ? null : state.rmsDb)} / PK ${formatDb(state.peakDb)}`
}

// ---------------------------------------------------------------------------
// 统一 rAF 循环 + 表头注册
// ---------------------------------------------------------------------------

interface Registration {
  id: string
  readLevels: () => MeterLevels
  live: MeterState
  publishState: (state: MeterState) => void
  frame: ((frame: MeterCanvasFrame, state: MeterState) => void) | null
  canvas: () => HTMLCanvasElement | null
  options: BallisticsOptions
  lastPublishAt: number
  /** 无 Canvas 时也要节流绘制（readLevels 的成本可能是 FFT 读取） */
  enabled: () => boolean
}

const registry = new Map<string, Registration>()
let rafId: number | null = null
let lastFrameTs = 0
let visibilityBound = false

function canUseRaf(): boolean {
  return typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function'
}

function tick(entry: Registration, dtMs: number, ts: number): void {
  if (!entry.enabled()) return

  entry.live = advanceMeterState(entry.live, entry.readLevels(), dtMs, entry.options)

  // ① 渲染：每帧都画（视觉平滑靠它）
  if (entry.frame) {
    const frame = prepareCanvas(entry.canvas())
    if (frame) entry.frame(frame, entry.live)
  }

  // ② 读数：最多 20 次/秒发布到 Vue（避免全表重渲染，见文件头第 3 条）
  if (ts - entry.lastPublishAt >= METER_PUBLISH_INTERVAL_MS) {
    entry.lastPublishAt = ts
    entry.publishState(entry.live)
  }
}

function loop(ts: number): void {
  const dt = lastFrameTs > 0 ? Math.max(0, ts - lastFrameTs) : 16
  lastFrameTs = ts
  for (const entry of registry.values()) tick(entry, dt, ts)
  rafId = registry.size > 0 && canUseRaf() ? requestAnimationFrame(loop) : null
  if (rafId === null) lastFrameTs = 0
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    // 窗口不可见时停掉循环：混音台的表头不该在后台烧 CPU
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
      lastFrameTs = 0
    }
  } else {
    ensureLoop()
  }
}

function ensureLoop(): void {
  if (!canUseRaf()) return
  if (typeof document !== 'undefined' && document.hidden) return
  if (!visibilityBound) {
    document?.addEventListener?.('visibilitychange', onVisibilityChange)
    visibilityBound = true
  }
  if (rafId === null && registry.size > 0) {
    lastFrameTs = 0
    rafId = requestAnimationFrame(loop)
  }
}

// ---------------------------------------------------------------------------
// 对外 composable
// ---------------------------------------------------------------------------

export interface UseMeterOptions {
  /** 表头唯一 id（同一 id 重复注册会覆盖前一个，用于「一个表头一个 id」） */
  id: string
  /**
   * 额外的电平来源。不传则读 `pushMeterLevels(id, ...)` 的推送值，
   * 因此「主进程结果」与「Web Audio 分析器」可以共用同一套表头组件。
   */
  getLevels?: () => MeterLevels
  minDb?: number
  maxDb?: number
  clipDb?: number
  /** 是否累加积分响度（总线响度表专用） */
  integrate?: boolean
  /** 每帧渲染回调（Canvas 自绘）；不传则只维护读数 */
  render?: (frame: MeterCanvasFrame, state: MeterState) => void
  /** 画布取值函数（render 存在时必须提供；用函数是为了容忍 ref 尚未挂载） */
  canvas?: () => HTMLCanvasElement | null
  /** 是否启用（默认启用）；返回 false 时不 tick，可用于「未选中轨」省电 */
  enabled?: () => boolean
}

export interface MeterHandle {
  /** 节流后的表头状态（20 Hz 更新） */
  state: Readonly<Ref<MeterState>>
  /** 清削波锁存（面板上的「削波」按钮接这里） */
  clearClip: () => void
  /** 清积分响度累加（重新开始测量） */
  resetIntegrated: () => void
  /** 当前是否已注册进 rAF 循环 */
  registered: Readonly<Ref<boolean>>
}

/**
 * 注册一个表头。**必须在组件 setup 内调用**（依赖 onScopeDispose 注销）。
 *
 * 用法（通道条）：
 * ```ts
 * const canvasRef = ref<HTMLCanvasElement | null>(null)
 * const meter = useMeter({
 *   id: `track:${props.track.id}`,
 *   canvas: () => canvasRef.value,
 *   render: (frame, state) => drawBarMeter(frame, state, { minDb: -60, maxDb: 0 }),
 * })
 * ```
 */
export function useMeter(options: UseMeterOptions): MeterHandle {
  const state = shallowRef<MeterState>(createMeterState())
  const registered = shallowRef(false)

  const entry: Registration = {
    id: options.id,
    readLevels: options.getLevels ?? (() => readPushedLevels(options.id)),
    live: createMeterState(),
    publishState: (next) => { state.value = next },
    frame: options.render ?? null,
    canvas: options.canvas ?? (() => null),
    options: {
      minDb: options.minDb,
      maxDb: options.maxDb,
      clipDb: options.clipDb,
      integrate: options.integrate,
    },
    lastPublishAt: 0,
    enabled: options.enabled ?? (() => true),
  }

  registry.set(options.id, entry)
  ensureLoop()
  registered.value = true

  const handle: MeterHandle = {
    state: readonly(state) as Readonly<Ref<MeterState>>,
    clearClip: () => {
      entry.live = { ...entry.live, clipping: false }
      state.value = entry.live
    },
    resetIntegrated: () => {
      entry.live = { ...entry.live, integratedLufs: null, integratedBlocks: 0 }
      state.value = entry.live
    },
    registered: readonly(registered) as Readonly<Ref<boolean>>,
  }

  onScopeDispose(() => {
    // 只删自己那一条：id 可能已被新实例覆盖（例如 key 变化导致的 remount 顺序）
    if (registry.get(options.id) === entry) registry.delete(options.id)
    registered.value = false
    if (registry.size === 0) {
      if (rafId !== null && canUseRaf()) cancelAnimationFrame(rafId)
      rafId = null
      lastFrameTs = 0
    }
  })

  return handle
}

/** 供测试/诊断：当前注册的表头 id 列表 */
export function listRegisteredMeters(): string[] {
  return [...registry.keys()]
}
