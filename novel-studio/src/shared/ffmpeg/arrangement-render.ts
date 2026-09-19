/**
 * Novel Studio · 对轨预览渲染的滤镜图与命令（纯逻辑，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/13 §7 「预览渲染：只渲染时间线的一段（10~30 秒），用于快速试听」
 *   · docs/15 §3 「渲染管线：片段 → 轨道 → 总线 → 母带」的最小子集（只有人声总线）
 *   · docs/05 §7.1 「滤镜图过大会让命令行超长/内存爆」→ 分批渲染的接口留在这里
 *
 * ### 与「混音」的边界（必须说清，否则会被误解成混音已实现）
 *   本文件只做**对轨预览**：把时间线上的片段按各自的位置混成一条人声轨。
 *   **不含** BGM、音效、闪避（ducking）、总线增益、母带响度 —— 那些属于混音域
 *   （docs/15，`mix:*` 尚未实现）。所以预览听起来「干」，这是设计使然，不是 bug。
 *
 * ### 为什么用 adelay + amix 而不是 concat
 *   concat 只能表达「首尾相接」，而时间线上有**重叠**（对话交叠）与**空隙**（留白）。
 *   `adelay` 把每个片段推到它自己的起点，`amix` 再把它们相加 —— 重叠与空隙都自然成立。
 *   `normalize=0` 很关键：默认的 `normalize=1` 会按输入个数自动衰减（2 个输入各减 6 dB），
 *   那会让「预览比导出小一截」，用户会以为自己的增益设置没生效。
 */

import { AUDIO_DEFAULTS } from '../constants.ts'
import type { TrackId } from '../types.ts'
import { fmtNum } from './filters.ts'

/** 参与渲染的一个片段（已解析到绝对路径） */
export interface RenderItemInput {
  /** 音频文件绝对路径 */
  path: string
  trackId: TrackId
  timelineStartMs: number
  srcInMs: number
  srcOutMs: number
  fadeInMs: number
  fadeOutMs: number
}

export interface ArrangementRenderInput {
  items: readonly RenderItemInput[]
  output: string
  /** 只渲染 `[startMs, startMs + durationMs)`（预览窗口） */
  startMs: number
  durationMs: number
  sampleRate?: 44100 | 48000
  channels?: 1 | 2
  /** 输出位深（中间产物默认 24 位） */
  bitDepth?: 16 | 24
  /** 只渲染这些轨道（不传 = 全部） */
  trackIds?: readonly TrackId[]
  overwrite?: boolean
  /** 限制线程数，避免预览把 UI 卡住（默认留 2 个核） */
  threadCount?: number
  ffmpegPath?: string
}

/** 一个片段在滤镜图里的处理段（导出给测试逐段断言） */
export interface RenderItemFilter {
  index: number
  label: string
  filter: string
}

/**
 * 每个片段一条滤镜链（`[i:a]…[a{i}]`）。
 *
 * ★ 三段缺一不可：
 *   1. `atrim` 取源区间（`src_in/src_out` 是**源文件**坐标，docs/13 §4.2）；
 *   2. `asetpts=PTS-STARTPTS` 把时间归零 —— 少了它，第二段之后所有片段的起点都会被
 *      源文件里的偏移带跑（表现为「越往后越晚」）；
 *   3. `adelay` 推到时间线位置（毫秒整数）。
 *
 * @throws 不抛异常；时长为 0 的片段返回 null（调用方跳过）
 */
export function buildItemFilters(item: RenderItemInput, index: number): RenderItemFilter | null {
  const durationMs = item.srcOutMs - item.srcInMs
  if (!(durationMs > 0)) return null
  const parts: string[] = [
    `atrim=start=${fmtNum(item.srcInMs / 1000, 3)}:end=${fmtNum(item.srcOutMs / 1000, 3)}`,
    'asetpts=PTS-STARTPTS',
  ]
  // 淡化时长不能超过片段本身（否则 afade 的起点为负，ffmpeg 会告警并忽略）
  const fadeIn = Math.max(0, Math.min(item.fadeInMs, durationMs / 2))
  const fadeOut = Math.max(0, Math.min(item.fadeOutMs, durationMs / 2))
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${fmtNum(fadeIn / 1000, 3)}`)
  if (fadeOut > 0) {
    parts.push(`afade=t=out:st=${fmtNum((durationMs - fadeOut) / 1000, 3)}:d=${fmtNum(fadeOut / 1000, 3)}`)
  }
  const delay = Math.max(0, Math.round(item.timelineStartMs))
  if (delay > 0) parts.push(`adelay=${delay}:all=1`)
  return { index, label: `a${index}`, filter: parts.join(',') }
}

/**
 * 完整 `-filter_complex`：每个输入一条链 → `amix` → 预览窗口 `atrim`。
 *
 * 顺序敏感：先混音再裁窗口（而不是先裁窗口）—— 裁窗口要在**时间线坐标**上做，
 * 而片段是按时间线位置摆好的，所以裁剪必须放在混完之后。
 *
 * @throws 不抛异常；没有可用片段时返回空串（调用方抛 `MIX_ARRANGEMENT_EMPTY`）
 */
export function buildArrangementFilterGraph(input: ArrangementRenderInput): {
  graph: string
  usedInputs: number[]
} {
  const lanes: string[] = []
  const usedInputs: number[] = []
  let laneIndex = 0
  for (const [i, item] of input.items.entries()) {
    const built = buildItemFilters(item, i)
    if (!built) continue
    usedInputs.push(i)
    lanes.push(`[${i}:a]${built.filter}[${built.label}]`)
    laneIndex++
  }
  if (laneIndex === 0) return { graph: '', usedInputs: [] }

  const mixInputs = usedInputs.map((i) => `[a${i}]`).join('')
  // normalize=0：不按输入个数自动衰减（见文件头）；dropout_transition=0 让先结束的片段立刻消失
  const mix = `${mixInputs}amix=inputs=${laneIndex}:normalize=0:dropout_transition=0[mixed]`
  const from = Math.max(0, input.startMs) / 1000
  const to = (Math.max(0, input.startMs) + Math.max(1, input.durationMs)) / 1000
  const window = `[mixed]atrim=start=${fmtNum(from, 3)}:end=${fmtNum(to, 3)},asetpts=PTS-STARTPTS[out]`
  return { graph: [...lanes, mix, window].join(';'), usedInputs }
}

/**
 * 完整的 ffmpeg 命令。
 *
 * `-t` 同时给一份（等于预览窗口长度）是为了**双保险**：滤镜图已经裁过窗口，
 * 但万一 `atrim` 的时间戳受容器影响（某些 mp3 源），`-t` 能保证输出长度不会失控。
 *
 * @throws 不抛异常；没有可用片段时返回空数组（调用方据此报 `MIX_ARRANGEMENT_EMPTY`）
 */
export function buildArrangementRenderCommand(input: ArrangementRenderInput): string[] {
  const { graph, usedInputs } = buildArrangementFilterGraph(input)
  if (usedInputs.length === 0) return []
  const base = input.ffmpegPath ?? 'ffmpeg'
  const cmd = [base, '-loglevel', 'error', '-nostats']
  if (input.overwrite !== false) cmd.push('-y')
  for (const i of usedInputs) cmd.push('-i', input.items[i]!.path)
  cmd.push('-filter_complex', graph)
  cmd.push('-map', '[out]')
  cmd.push('-t', fmtNum(Math.max(1, input.durationMs) / 1000, 3))
  cmd.push('-ar', String(input.sampleRate ?? AUDIO_DEFAULTS.sampleRate))
  cmd.push('-ac', String(input.channels ?? AUDIO_DEFAULTS.channels))
  cmd.push('-c:a', (input.bitDepth ?? 24) === 16 ? 'pcm_s16le' : 'pcm_s24le')
  cmd.push('-f', 'wav')
  cmd.push('-map_metadata', '-1')
  if (input.threadCount && input.threadCount > 0) cmd.push('-threads', String(Math.floor(input.threadCount)))
  cmd.push(input.output)
  return cmd
}

/** 预览窗口的默认长度（docs/13 §7：10~30 秒，取 20 秒） */
export const PREVIEW_RENDER_DEFAULT_MS = 20_000

/** 预览窗口长度上限（防止「预览」变成整章渲染） */
export const PREVIEW_RENDER_MAX_MS = 120_000

/** 把请求的预览长度夹到合法区间 */
export function clampPreviewDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return PREVIEW_RENDER_DEFAULT_MS
  return Math.min(PREVIEW_RENDER_MAX_MS, Math.round(durationMs))
}
