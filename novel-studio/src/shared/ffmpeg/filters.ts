/**
 * Novel Studio · ffmpeg 滤镜图构建（纯字符串，零依赖、不调用 ffmpeg）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §3  滤镜图构建（固定顺序）
 *   · docs/14 §3.1 三处必须实测确认的参数（makeup 单位 / alimiter.limit 单位 / afftdn 参数）
 *   · docs/05 §7.2 分批 amix 与层级合并
 *   · docs/05 §7.4 BGM 与音效（loop / fade / apad / atrim）
 *   · docs/05 §7.5 ducking（sidechaincompress）
 *
 * ★★★ 「漏了就出大问题」的三个参数（每个都有踩坑史，单测断言它们必须出现）★★★
 *   1. `amix=normalize=0` —— 不加会被默认按 1/N 衰减，音量暴跌
 *   2. `apad=whole_dur={章节时长}` —— 不加会导致 amix 以最短输入结束（「混出来只有前几秒」的头号原因）
 *   3. `adelay={ms}|{ms}` —— 单声道也要写**两个**值（只写一个在某些版本只作用于第一声道）
 *
 * 失败语义：本文件只做字符串拼装。非法参数一律「夹到合法范围」并继续（不抛异常），
 *          唯一例外：`buildMusicTrackFilters` 在 loop=true 却没给 sourceFrames 时抛
 *          `FILTER_UNSUPPORTED`（aloop 必须先知道样本数，docs/05 §7.4）。
 */

import { AUDIO_DEFAULTS } from '../constants.ts'
import { AppError } from '../errors.ts'
import type { DuckingConfig, EqBand, MusicTrackConfig, ProcessChain } from '../types.ts'
import { dbToLinear } from '../audio/pcm.ts'

/** 圆整到 4 位小数并去掉多余的 0（滤镜串要短且稳定，便于快照比对） */
export function fmtNum(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '0'
  const fixed = v.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** 毫秒 → 秒的滤镜参数（最多 3 位小数，足够 1 ms 精度） */
export function fmtSec(ms: number): string {
  return fmtNum((Number.isFinite(ms) ? ms : 0) / 1000, 3)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * acompressor 的 `makeup` 单位换算（docs/14 §3.1 第 1 项）。
 *
 * 文档要求「必须实测确认」：ffmpeg 官方文档里 `makeup` 默认值是 1.0（线性倍数），
 * 因此这里按 **dB → 线性** 换算；若实测发现某个构建把它当 dB，
 * 调用 `buildChainFilter(chain, { makeupUnit: 'db' })` 即可切回原样输出。
 *
 * @returns 线性增益（2 dB → 1.2599）
 */
export function makeupDbToLinear(makeupDb: number): number {
  return dbToLinear(makeupDb)
}

/** 说明当前实现采用的假设（能力探测/自检日志里带上它，便于现场排查） */
export const ACOMPRESSOR_MAKEUP_UNIT: 'linear' | 'db' = 'linear'

/** alimiter 的 limit 是线性值（docs/14 §3.1 第 2 项）：-1 dBFS → 0.891 */
export function limiterLimitLinear(limitDb: number): number {
  return dbToLinear(limitDb)
}

/** afftdn 参数拼装（docs/14 §3.1 第 3 项：版本差异大，能力探测后再启用） */
export function buildAfftdnFilter(denoise: ProcessChain['denoise']): string {
  const parts = [`nr=${fmtNum(clamp(denoise.nr, 0.01, 97), 2)}`, `nf=${fmtNum(clamp(denoise.nf, -80, -20), 2)}`]
  if (denoise.tn) parts.push('tn=1')
  return `afftdn=${parts.join(':')}`
}

/** 单个 EQ 段 → 滤镜串（统一用 t=q，避免用户看到「带宽/八度」两套语义，docs/05 §6.1） */
export function buildEqFilter(band: EqBand): string {
  switch (band.type) {
    case 'lowpass':
      return `lowpass=f=${fmtNum(band.freq, 1)}`
    case 'highpass':
      return `highpass=f=${fmtNum(band.freq, 1)}:poles=1`
    case 'lowshelf':
      return `equalizer=f=${fmtNum(band.freq, 1)}:t=l:w=${fmtNum(band.q)}:g=${fmtNum(band.gainDb)}`
    case 'highshelf':
      return `equalizer=f=${fmtNum(band.freq, 1)}:t=h:w=${fmtNum(band.q)}:g=${fmtNum(band.gainDb)}`
    case 'peak':
    default:
      return `equalizer=f=${fmtNum(band.freq, 1)}:t=q:w=${fmtNum(band.q)}:g=${fmtNum(band.gainDb)}`
  }
}

export interface ChainFilterOptions {
  /** acompressor.makeup 的单位假设，默认 linear（见 ACOMPRESSOR_MAKEUP_UNIT） */
  makeupUnit?: 'linear' | 'db'
  /** 是否输出修补后置的局部门控（declick / silenceFill），默认 true */
  includeRepairGates?: boolean
}

/**
 * 处理链 → 滤镜串（docs/14 §3）。
 *
 * **执行顺序固定，不可调换**（docs/14 §2.1）：
 *   ① 修补前置（去 DC / 极性反转）
 *   ② 高通
 *   ③ 降噪      ← 必须在 EQ/压缩之前：压缩会把噪声一起抬起来
 *   ④ 去齿音    ← 必须在压缩之前：避免压缩器被齿音瞬态误触发
 *   ⑤ EQ
 *   ⑥ 压缩
 *   ⑦ 限幅
 *   ⑧ 修补后置（declick / 静音填充 / 变速）
 *
 * 全关时返回空串（调用方据此决定「仅格式统一」或跳过处理，docs/14 §13）。
 *
 * @throws 不抛异常（参数越界一律夹紧）
 */
export function buildChainFilter(chain: ProcessChain, opts: ChainFilterOptions = {}): string {
  const f: string[] = []

  // ① 修补前置
  if (chain.repair.dcOffset) f.push('highpass=f=10:poles=1')
  if (chain.repair.polarityInvert) f.push('aeval=val(0)*-1:c=same')

  // ② 高通
  if (chain.highpass.enabled) {
    f.push(`highpass=f=${fmtNum(chain.highpass.freq, 1)}:poles=${chain.highpass.poles}`)
  }

  // ③ 降噪
  if (chain.denoise.enabled) f.push(buildAfftdnFilter(chain.denoise))

  // ④ 去齿音
  if (chain.deesser.enabled) {
    const d = chain.deesser
    f.push(`deesser=i=${fmtNum(clamp(d.intensity, 0, 1))}:f=${fmtNum(clamp(d.freq, 0, 1))}`)
  }

  // ⑤ EQ（只取 enabled 的段，保持用户排序）
  for (const band of chain.eq) {
    if (!band.enabled) continue
    f.push(buildEqFilter(band))
  }

  // ⑥ 压缩
  if (chain.compressor.enabled) {
    const c = chain.compressor
    const parts = [
      `threshold=${fmtNum(c.thresholdDb)}dB`,
      `ratio=${fmtNum(clamp(c.ratio, 1, 20))}`,
      `attack=${fmtNum(clamp(c.attackMs, 0.01, 2000), 2)}`,
      `release=${fmtNum(clamp(c.releaseMs, 0.01, 9000), 2)}`,
    ]
    if (c.makeupDb) {
      parts.push(
        opts.makeupUnit === 'db'
          ? `makeup=${fmtNum(c.makeupDb)}dB`
          : `makeup=${fmtNum(makeupDbToLinear(c.makeupDb), 6)}`,
      )
    }
    f.push(`acompressor=${parts.join(':')}`)
  }

  // ⑦ 限幅（limit 是线性值！）
  if (chain.limiter.enabled) {
    const l = chain.limiter
    f.push(
      `alimiter=limit=${fmtNum(limiterLimitLinear(l.limitDb), 6)}` +
        `:attack=${fmtNum(clamp(l.attackMs, 0.1, 80), 2)}` +
        `:release=${fmtNum(clamp(l.releaseMs, 1, 8000), 2)}`,
    )
  }

  // ⑧ 修补后置
  if (opts.includeRepairGates !== false) {
    for (const d of chain.repair.declick) {
      // 精确的 5~20 ms 边缘淡化在 PCM 域修补里做（infra/media/repair.ts）；
      // 这里只做时间门控，避免把整个流做 afade（那会把其它段落也淡掉）
      f.push(buildGateFilter(d.atMs, d.atMs + d.lengthMs))
    }
    for (const s of chain.repair.silenceFill) {
      f.push(buildGateFilter(s.startMs, s.endMs))
    }
  }
  if (chain.repair.tempo.enabled) {
    // atempo 超出 0.5~2 会明显失真（docs/14 §6：UI 只给 0.9~1.1）
    f.push(`atempo=${fmtNum(clamp(chain.repair.tempo.factor, 0.5, 2), 4)}`)
  }

  return f.join(',')
}

/** 时间区间置零门控（修补工具用） */
export function buildGateFilter(startMs: number, endMs: number): string {
  const from = fmtSec(Math.max(0, Math.min(startMs, endMs)))
  const to = fmtSec(Math.max(startMs, endMs))
  return `volume=enable='between(t,${from},${to})':volume=0`
}

/**
 * 处理链的完整滤镜图（docs/14 §3.2 内部工作格式统一）。
 *
 * 输入 → aresample → aformat(s32, mono) → 处理链
 * ★ 处理链内部格式统一为 s32le @48k，否则各片段格式不一致会让后续 amix 失败。
 *
 * @throws 不抛异常
 */
export function buildProcessFilterGraph(input: {
  chain: ProcessChain
  sampleRate?: number
  channels?: 1 | 2
  /** 源采样率不等于目标时插入 aresample（总是插入更安全） */
  forceResample?: boolean
}): string {
  const sampleRate = input.sampleRate ?? AUDIO_DEFAULTS.sampleRate
  const channels = input.channels ?? AUDIO_DEFAULTS.channels
  const layout = channels === 2 ? 'stereo' : 'mono'
  const head = [`aresample=${sampleRate}`, `aformat=sample_fmts=s32:channel_layouts=${layout}`]
  const chain = buildChainFilter(input.chain)
  return [...head, ...(chain ? [chain] : [])].join(',')
}

// ============================================================================
// 混音（docs/05 §7.1 §7.2）
// ============================================================================

export interface MixItemInput {
  /** 输入流序号（对应命令里 -i 的顺序） */
  inputIndex: number
  /** 源片段内的裁剪窗口 */
  srcInMs: number
  srcOutMs: number
  /** 在章节时间线上的位置 */
  timelineStartMs: number
  fadeInMs: number
  fadeOutMs: number
  /** 该 item 自己的增益（混音不做归一化，音量全靠它） */
  gainDb?: number
}

export interface MixFilterInput {
  items: MixItemInput[]
  /** 章节总时长（毫秒）。**必须**用于 apad=whole_dur，否则 amix 只出前几秒 */
  chapterDurationMs: number
  /** 分批大小，默认 32（docs/05 §7.1 方案 B） */
  batchSize?: number
  /** 输出标签，默认 'voice' */
  outputLabel?: string
  /** 章首静音：加到每个 item 的 adelay 上 */
  headSilenceMs?: number
}

const labelify = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_')

/**
 * 分批混音滤镜图（docs/05 §7.2 方案 B 展开）。
 *
 * 结构：
 *   第 1 层：每个 item → `atrim → asetpts → afade → [volume] → adelay → apad=whole_dur`（独立延迟流）
 *   第 2 层：每 32 个一组 → `amix=inputs=N:normalize=0:dropout_transition=0`
 *   第 3 层：各组递归合并（组数 > 32 时再分批，O(log N) 层）
 *
 * ★ `normalize=0`、`apad=whole_dur=`、`adelay={ms}|{ms}` 三处必须有单测断言（防误删）。
 *
 * @throws 不抛异常；items 为空时返回只做重命名的空图（调用方应先抛 `MIX_ARRANGEMENT_EMPTY`）
 */
export function buildMixFilterGraph(input: MixFilterInput): string {
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? AUDIO_DEFAULTS.mixBatchSize))
  const outputLabel = labelify(input.outputLabel ?? 'voice')
  const chapterSec = fmtNum(Math.max(0, input.chapterDurationMs) / 1000, 6)
  const headSilenceMs = Math.max(0, input.headSilenceMs ?? 0)
  const lines: string[] = []

  // ---- 第 1 层：每个 item 一条独立流 ----
  const itemLabels: string[] = []
  input.items.forEach((item, i) => {
    const label = `a${i}`
    const srcInSec = fmtSec(Math.max(0, item.srcInMs))
    const srcOutSec = fmtSec(Math.max(item.srcInMs, item.srcOutMs))
    const bodySec = Math.max(0, (item.srcOutMs - item.srcInMs) / 1000)
    const parts = [
      `atrim=start=${srcInSec}:end=${srcOutSec}`,
      'asetpts=PTS-STARTPTS',
    ]
    if (item.fadeInMs > 0) parts.push(`afade=t=in:st=0:d=${fmtSec(item.fadeInMs)}`)
    if (item.fadeOutMs > 0) {
      parts.push(`afade=t=out:st=${fmtNum(bodySec - item.fadeOutMs / 1000, 6)}:d=${fmtSec(item.fadeOutMs)}`)
    }
    if (item.gainDb) parts.push(`volume=${fmtNum(item.gainDb)}dB`)
    const delayMs = Math.round(Math.max(0, item.timelineStartMs) + headSilenceMs)
    // ★ 单声道也写两个值（版本差异，写一个可能只作用于第一声道）
    parts.push(`adelay=${delayMs}|${delayMs}`)
    // ★ 补齐到章节总长，否则 amix 以最短输入结束
    parts.push(`apad=whole_dur=${chapterSec}`)
    lines.push(`[${item.inputIndex}:a]${parts.join(',')}[${label}]`)
    itemLabels.push(label)
  })

  if (itemLabels.length === 0) {
    // 空图：仍然给出一个合法的输出标签，便于上层统一处理
    lines.push(`anullsrc=r=48000:cl=mono,atrim=0:${chapterSec},asetpts=PTS-STARTPTS[${outputLabel}]`)
    return lines.join(';\n')
  }

  // ---- 第 2 层：分批 amix ----
  const batchLabels: string[] = []
  for (let start = 0; start < itemLabels.length; start += batchSize) {
    const group = itemLabels.slice(start, start + batchSize)
    const label = `g${batchLabels.length}`
    if (group.length === 1) {
      lines.push(`[${group[0]}]anull[${label}]`)
    } else {
      lines.push(
        `${group.map(l => `[${l}]`).join('')}amix=inputs=${group.length}:normalize=0:dropout_transition=0[${label}]`,
      )
    }
    batchLabels.push(label)
  }

  // ---- 第 3 层：层级合并（组数 > batchSize 时递归） ----
  let current = batchLabels
  while (current.length > 1) {
    const next: string[] = []
    for (let start = 0; start < current.length; start += batchSize) {
      const group = current.slice(start, start + batchSize)
      if (group.length === 1) {
        next.push(group[0] as string)
        continue
      }
      const label = `m${next.length}_${current.length}`
      lines.push(`${group.map(l => `[${l}]`).join('')}amix=inputs=${group.length}:normalize=0:dropout_transition=0[${label}]`)
      next.push(label)
    }
    current = next
  }

  const last = current[0] as string
  lines.push(`[${last}]anull[${outputLabel}]`)
  return lines.join(';\n')
}

/**
 * 总线合成（docs/05 §7.3）：voice / music / sfx 三条总线 → master。
 *
 * ★ 同样必须 `normalize=0`（否则总线一多音量就掉）。
 *
 * @throws 不抛异常；总线为空时返回空串
 */
export function buildBusMixFilter(input: {
  buses: Array<{ label: string; gainDb?: number }>
  outputLabel?: string
  masterGainDb?: number
  /** 主总线限幅（真峰兜底在响度阶段做，这里只是保险） */
  limiter?: { enabled: boolean; limitDb: number; attackMs: number; releaseMs: number }
}): string {
  const outputLabel = labelify(input.outputLabel ?? 'mixed')
  const streams: string[] = []
  const lines: string[] = []
  input.buses.forEach((bus, i) => {
    const label = labelify(bus.label)
    if (bus.gainDb) {
      const out = `bus${i}`
      lines.push(`[${label}]volume=${fmtNum(bus.gainDb)}dB[${out}]`)
      streams.push(`[${out}]`)
    } else {
      streams.push(`[${label}]`)
    }
  })
  if (streams.length === 0) return ''

  const mixOut = 'busmix'
  if (streams.length === 1) {
    lines.push(`${streams[0]}anull[${mixOut}]`)
  } else {
    lines.push(`${streams.join('')}amix=inputs=${streams.length}:normalize=0:dropout_transition=0[${mixOut}]`)
  }
  const tail: string[] = []
  if (input.masterGainDb) tail.push(`volume=${fmtNum(input.masterGainDb)}dB`)
  if (input.limiter?.enabled) {
    tail.push(
      `alimiter=limit=${fmtNum(limiterLimitLinear(input.limiter.limitDb), 6)}` +
        `:attack=${fmtNum(input.limiter.attackMs, 2)}:release=${fmtNum(input.limiter.releaseMs, 2)}`,
    )
  }
  if (tail.length > 0) {
    lines.push(`[${mixOut}]${tail.join(',')}[${outputLabel}]`)
  } else {
    lines.push(`[${mixOut}]anull[${outputLabel}]`)
  }
  return lines.join(';\n')
}

/**
 * Solo 语义（docs/05 §7.3）：任一轮轨 solo 时其他轨静音，
 * **但侧链源（人声总线）始终有效**，否则 ducking 会失效导致 BGM 不降。
 *
 * @throws 不抛异常
 */
export function resolveSoloMutes(
  tracks: Array<{ id: string; kind: 'voice' | 'music' | 'sfx'; isMute: boolean; isSolo: boolean }>,
): { audible: string[]; muted: string[]; sidechainSourceActive: boolean; anySolo: boolean } {
  const anySolo = tracks.some(t => t.isSolo)
  const audible: string[] = []
  const muted: string[] = []
  for (const t of tracks) {
    const effectiveMute = anySolo ? !t.isSolo : t.isMute
    if (effectiveMute) muted.push(t.id)
    else audible.push(t.id)
  }
  const sidechainSourceActive = tracks.some(t => t.kind === 'voice')
  return { audible, muted, sidechainSourceActive, anySolo }
}

// ============================================================================
// 自动闪避（docs/05 §7.5 / docs/14 §9）
// ============================================================================

/**
 * 由「下潜量」反推 sidechaincompress 的 ratio。
 *
 * 推导：0 dBFS 的侧链输入在 threshold（dB）之上的部分按 (1 - 1/ratio) 压缩，
 * 因此 `下潜量 ≈ |thresholdDb| × (1 - 1/ratio)` → `ratio = 1 / (1 - amount/|threshold|)`。
 * 例：threshold=-30 dB、amount=12 dB → ratio ≈ 1.667。
 *
 * @throws 不抛异常；参数不合理时返回默认 8
 */
export function duckRatioForAmount(amountDb: number, thresholdDb: number): number {
  const depth = Math.abs(amountDb)
  const thr = Math.abs(thresholdDb)
  if (!(thr > 0) || !(depth >= 0) || depth >= thr) return 8
  return clamp(1 / (1 - depth / thr), 1, 20)
}

/**
 * ducking 滤镜串（docs/05 §7.5）。
 *
 * ★ `threshold` 是**线性 0~1**，不是 dB（docs/14 §9 常见错误第 2 条）：
 *   -30 dB → 0.0316。写成 `threshold=-30` 会让 BGM 永远不下潜。
 *
 * @throws 不抛异常
 */
export function buildDuckingFilter(
  config: DuckingConfig,
  opts: { ratio?: number; deriveRatioFromAmount?: boolean; levelSc?: number } = {},
): string {
  const thresholdLinear = clamp(dbToLinear(config.thresholdDb), 0.00097563, 1)
  const ratio =
    opts.ratio ??
    (opts.deriveRatioFromAmount ? duckRatioForAmount(config.amountDb, config.thresholdDb) : 8)
  const parts = [
    `threshold=${fmtNum(thresholdLinear, 6)}`,
    `ratio=${fmtNum(clamp(ratio, 1, 20))}`,
    `attack=${fmtNum(clamp(config.attackMs, 0.01, 2000), 2)}`,
    `release=${fmtNum(clamp(config.releaseMs, 0.01, 9000), 2)}`,
    // makeup 固定 1（增益统一在轨道级处理）+ level_sc=1（侧链不额外缩放）
    'makeup=1',
    `level_sc=${fmtNum(opts.levelSc ?? 1)}`,
  ]
  return `sidechaincompress=${parts.join(':')}`
}

/**
 * ducking 完整子图：`[music][voice]sidechaincompress=...[ducked]`。
 * 调用方需要先 `asplit` 人声总线作为侧链源（docs/05 §7.5）。
 *
 * @throws 不抛异常
 */
export function buildDuckingGraph(input: {
  musicLabel: string
  sidechainLabel: string
  outputLabel: string
  config: DuckingConfig
  opts?: { ratio?: number; deriveRatioFromAmount?: boolean }
}): string {
  if (!input.config.enabled) {
    return `[${labelify(input.musicLabel)}]anull[${labelify(input.outputLabel)}]`
  }
  return (
    `[${labelify(input.musicLabel)}][${labelify(input.sidechainLabel)}]` +
    `${buildDuckingFilter(input.config, input.opts)}[${labelify(input.outputLabel)}]`
  )
}

// ============================================================================
// BGM / 音效轨（docs/05 §7.4）
// ============================================================================

export interface MusicFilterOptions {
  /** loop=true 时必须提供：源文件总帧数（先用 ffprobe/astats 探测，docs/05 §7.4） */
  sourceFrames?: number
  sampleRate?: number
  /** 轨道级增益（dB） */
  gainDb?: number
  /** 是否补到章节总长，默认 true（不补的话总线 amix 会被它截短） */
  padToChapter?: boolean
}

/**
 * BGM / 音效轨滤镜串（docs/05 §7.4）：loop → atrim（窗口）→ 淡化 → 增益 → apad。
 *
 * ★ 时间基准说明：这里把窗口裁到 `[0, dur]` 并 `asetpts=PTS-STARTPTS`，
 *   淡化时间因此是「流内相对时间」。调用方随后用 `adelay={startMs}|{startMs}` 放置——
 *   这与文档里的「st 用绝对时间（含前导静音）」**等价**，但更不容易写错。
 *
 * @throws `FILTER_UNSUPPORTED` —— loop=true 但没给 `sourceFrames`
 *         （`aloop` 必须先知道样本数；或改用命令级 `-stream_loop -1`）
 */
export function buildMusicTrackFilters(
  config: MusicTrackConfig,
  chapterDurationMs: number,
  opts: MusicFilterOptions = {},
): string {
  const chapterMs = Math.max(0, chapterDurationMs)
  const startMs = Math.max(0, config.startMs)
  const endMs = config.endMs === null ? chapterMs : Math.max(startMs, config.endMs)
  const durSec = Math.max(0, (endMs - startMs) / 1000)
  const parts: string[] = []

  if (config.loop) {
    // -1 = 无限循环；size 必须是源文件的帧数
    const frames = opts.sourceFrames
    if (!frames || frames <= 0) {
      throw new AppError('FILTER_UNSUPPORTED', {
        params: { filter: 'aloop（需要先探测源文件样本数）' },
        details: { assetId: config.assetId, hint: '可用 ffprobe 取 sample_count，或改用 -stream_loop -1' },
      })
    }
    parts.push(`aloop=loop=-1:size=${Math.floor(frames)}`)
  }

  // 长度不足靠 apad 补、长度超出靠 atrim 截（order：先截窗口，再补总长）
  parts.push(`atrim=start=0:end=${fmtNum(durSec, 6)}`)
  parts.push('asetpts=PTS-STARTPTS')

  if (config.fadeInMs > 0) {
    // st 是绝对时间（含前导静音）：这里流已从 0 开始，等价于文档写法
    parts.push(`afade=t=in:st=0:d=${fmtSec(config.fadeInMs)}`)
  }
  if (config.fadeOutMs > 0) {
    const st = Math.max(0, durSec - config.fadeOutMs / 1000)
    parts.push(`afade=t=out:st=${fmtNum(st, 6)}:d=${fmtSec(config.fadeOutMs)}`)
  }
  if (opts.gainDb) parts.push(`volume=${fmtNum(opts.gainDb)}dB`)
  if (opts.padToChapter !== false) parts.push(`apad=whole_dur=${fmtNum(chapterMs / 1000, 6)}`)

  return parts.join(',')
}

/**
 * BGM/音效轨的完整输入链（含 adelay 放置），便于命令构建直接复用。
 *
 * @throws `FILTER_UNSUPPORTED`（同 buildMusicTrackFilters）
 */
export function buildMusicTrackGraph(input: {
  inputLabel: string
  outputLabel: string
  config: MusicTrackConfig
  chapterDurationMs: number
  opts?: MusicFilterOptions
}): string {
  const chain = buildMusicTrackFilters(input.config, input.chapterDurationMs, input.opts)
  const delayMs = Math.round(Math.max(0, input.config.startMs))
  return (
    `[${labelify(input.inputLabel)}]${chain},adelay=${delayMs}|${delayMs}` +
    `[${labelify(input.outputLabel)}]`
  )
}

/**
 * 头尾静音补齐（docs/15 §3 步骤 6）。
 *
 * @throws 不抛异常
 */
export function buildHeadTailSilence(input: {
  label: string
  headSilenceMs: number
  tailSilenceMs: number
  chapterDurationMs: number
}): string {
  const parts: string[] = []
  if (input.headSilenceMs > 0) {
    const ms = Math.round(input.headSilenceMs)
    parts.push(`adelay=${ms}|${ms}`)
  }
  const targetSec = fmtNum(Math.max(0, input.chapterDurationMs) / 1000, 6)
  if (input.tailSilenceMs >= 0) parts.push(`apad=whole_dur=${targetSec}`)
  if (parts.length === 0) return `[${labelify(input.label)}]anull[${labelify(input.label)}_out]`
  return `[${labelify(input.label)}]${parts.join(',')}[${labelify(input.label)}_out]`
}
