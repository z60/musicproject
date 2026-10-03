/**
 * Novel Studio · 「解码后的音频 + 匹配到的行」→ 每行的音频区间（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/12 §4.3、docs/05 §4、docs/91 §5.2.49 ⑮
 *
 * ## 这个模块解决的问题
 *
 * 「按说话人导入音频」的文件是**整章连续朗读**（真机样本最大的一个覆盖 74 章），
 * 而落库要落到**每一行**上。中间这一步就是：
 *
 * ```
 *   PCM（单声道）─┐
 *                 ├─→ 语音片（VAD）─→ 每行一段区间 ─→ take 的 srcIn/srcOut
 *   匹配到的行   ─┘
 * ```
 *
 * ## 为什么单独成一个模块（而不是写在 service 里）
 *
 * 因为它是整条链路里**唯一能在没有 ffmpeg / 没有模型时完整测通**的一环：
 * 输入是 PCM 数组与行文本，输出是毫秒区间 —— 纯函数、可复现、可断言不变量。
 * 服务层只负责「把文件解码成 PCM」与「把区间写进 takes」。
 *
 * ## 三个刻意的决定
 *
 * ### 1. VAD 找不到人声时**不退化成失败**，而是按整段比例分
 *   `detectSlices` 在整段都低于门限时抛 `VAD_NO_SPEECH_FOUND`（录音场景的正确行为：
 *   宁可让用户调参重切，也不要产出坏数据）。但**导入场景不一样**：
 *   文件是用户给的既成音频，导入失败他除了换文件别无办法。
 *   所以这里兜底成「把整段当作一个语音片，按文本长度比例分配」，
 *   并**明确标记为兜底**（`method: 'whole-timeline'` + warning）——
 *   用户拿到的每一行都有音频，但会被提示这些边界不可信。
 *
 * ### 2. 时长从 **PCM 长度**算，不依赖 ffprobe
 *   同一份数据算两次会不一致（VAD 用 PCM 长度定时间轴，take 用 ffprobe 的时长）。
 *   导入时我们已经把音频解码成 PCM 了，样本数除以采样率就是最权威的时长。
 *
 * ### 3. 空音频**不编造区间**
 *   0 个样本时返回空 ranges + 全部 `needsReview`，而不是给一堆 `0ms~0ms` 的区间
 *   （那会让界面上显示「已导入 N 行」而实际全是空文件）。
 *
 * 本目录禁止引入任何第三方依赖。
 */

import { VAD_DEFAULTS } from '../constants.ts'
import { AppError } from '../errors.ts'
import type { Id, VadOptions } from '../types.ts'
import {
  allocateLinesToSlices,
  type AllocatableLine,
  type EnergyEnvelope,
  type LineAudioRange,
  type SpeechSlice,
} from './allocate.ts'
import { VAD_FRAME_MS, detectSlices, frameEnergy } from './vad.ts'

/**
 * VAD 找不到人声时的兜底策略。
 *
 * - `'whole-timeline'`（默认）：把整段当一个语音片，按文本长度比例分配。
 *   导入场景的正确选择 —— 用户给的是既成音频，失败了他无路可走。
 * - `'none'`：如实返回空区间 + 全部需复核。留给「不允许猜」的调用方。
 */
export type NoSpeechFallback = 'whole-timeline' | 'none'

export interface SplitPlanInput {
  /** 单声道 PCM（多声道应先下混） */
  samples: Float32Array
  sampleRate: number
  /**
   * 按**应有的朗读顺序**给出的行。
   *
   * ⚠️ 顺序错了这里不会报错，只会把音频切错行 —— 调用方必须保证它来自
   * 按 `(chapterNo, seq)` 排过序的结果（服务层的 `dbLinesAsRefs` 已经排过）。
   */
  lines: readonly AllocatableLine[]
  /**
   * VAD 参数（透传）。**部分指定即可** —— 缺的字段用 `VAD_DEFAULTS` 补齐。
   *
   * 为什么不是「要么全给、要么全不给」：调用方常常只想调一两个参数
   * （例如导入场景把 `minSliceMs` 调小以抓住短促的语气词），
   * 逼它把十个字段都写全，只会让真正想改的那个淹没在样板里。
   */
  vad?: Partial<VadOptions>
  noSpeechFallback?: NoSpeechFallback
  /** 低置信度门槛（透传给 `allocateLinesToSlices`） */
  lowConfidenceThreshold?: number
  /**
   * 是否用逐帧能量包络精修切点（默认 `true`）。
   *
   * 关掉只影响**片边界太远**的那些行（它们会退回「按字符比例切」）——
   * 那是「快但可能不对」的一侧。导入既成音频时应当保持开启。
   */
  refineBoundaries?: boolean
  /** 能量低谷搜索半径上限（毫秒，透传） */
  dipSearchMs?: number
}

export interface SplitPlanStats {
  /** 音频总时长（由 PCM 长度算得） */
  durationMs: number
  /** VAD 切出的语音片数 */
  sliceCount: number
  lineCount: number
  /** 是否一片一行（最理想的情形） */
  oneToOne: boolean
  /** 覆盖到的音频总时长 */
  coveredMs: number
  avgConfidence: number
  /** 是否走了「VAD 没找到人声」的兜底 */
  usedFallback: boolean
}

export interface SplitPlanResult {
  /** 每行一段（顺序与传入的 `lines` 一致；空音频时为 `[]`） */
  ranges: LineAudioRange[]
  /** 需要人工复核的行 id（低置信度 / VAD 片数明显不足 / 兜底） */
  needsReview: Id[]
  /** 给用户看的整体提示（可直接展示） */
  warnings: string[]
  slices: SpeechSlice[]
  /**
   * 用了哪条路径。**必须回报**：`'whole-timeline'` 的边界只是按比例硬切，
   * 与 `'vad'` 的可信度完全不同，UI 与日志都要能区分。
   */
  method: 'vad' | 'whole-timeline' | 'empty'
  stats: SplitPlanStats
}

/**
 * 由 PCM 造逐帧能量包络（帧长与 VAD 一致，20 ms）。
 *
 * 失败/关闭时返回 null —— 精修是**增强**，不该让它把导入搞失败。
 */
function buildEnergyEnvelope(input: SplitPlanInput): EnergyEnvelope | null {
  if (input.refineBoundaries === false) return null
  try {
    const frames = frameEnergy(input.samples, { frameMs: VAD_FRAME_MS, sampleRate: input.sampleRate })
    if (frames.length === 0) return null
    return { frameMs: VAD_FRAME_MS, values: frames.map((f) => f.rmsDb) }
  } catch {
    return null
  }
}

/** PCM 样本数 → 毫秒（采样率非法时返回 0，不抛错） */
function durationOf(samples: Float32Array, sampleRate: number): number {
  if (!(sampleRate > 0) || samples.length === 0) return 0
  return Math.round((samples.length / sampleRate) * 1000)
}

/**
 * 把一段解码好的音频按 VAD 铺满给定的行。
 *
 * @throws 只在 VAD 内部抛出**非** `VAD_NO_SPEECH_FOUND` 的错误时上抛
 *         （那些是参数错误之类的真 bug，不该被兜底掩盖）
 */
export function planLineSplits(input: SplitPlanInput): SplitPlanResult {
  const durationMs = durationOf(input.samples, input.sampleRate)
  const empty = (warnings: string[], method: SplitPlanResult['method']): SplitPlanResult => ({
    ranges: [],
    needsReview: input.lines.map((l) => l.lineId),
    warnings,
    slices: [],
    method,
    stats: {
      durationMs,
      sliceCount: 0,
      lineCount: input.lines.length,
      oneToOne: false,
      coveredMs: 0,
      avgConfidence: 0,
      usedFallback: false,
    },
  })

  if (input.lines.length === 0) return empty(['没有需要分配的行'], 'empty')

  /**
   * 0 个样本（空文件 / 解码出空数组）**不编造区间**。
   *
   * 如果这里给一堆 `0ms~0ms`，服务会照样写 N 条 take，
   * 界面显示「已导入 N 行」而磁盘上全是空文件 —— 比直接报错难查得多。
   */
  if (durationMs <= 0) {
    return empty(['这段音频解出来是空的（0 个采样）—— 无法切句，请检查文件是否损坏'], 'empty')
  }

  // ── ① VAD 切句 ────────────────────────────────────────────────────────────
  let slices: SpeechSlice[]
  let usedFallback = false
  try {
    // 缺省字段用 `VAD_DEFAULTS` 补齐 —— `detectSlices` 要求完整选项
    slices = detectSlices(input.samples, {
      ...VAD_DEFAULTS,
      ...(input.vad ?? {}),
      sampleRate: input.sampleRate,
    })
  } catch (e) {
    const isNoSpeech = e instanceof AppError && e.key === 'VAD_NO_SPEECH_FOUND'
    if (!isNoSpeech) throw e
    const fallback = input.noSpeechFallback ?? 'whole-timeline'
    if (fallback === 'none') {
      return empty(['没有检测到任何人声（VAD 未找到语音片）—— 整段音频可能是静音，或阈值不合适'], 'empty')
    }
    /**
     * 兜底：整段当一个语音片。
     *
     * 这样 `allocateLinesToSlices` 会退化成「按文本长度比例切整段」——
     * 每行都有音频，但边界**不可信**，所以要带上 warning 与 `usedFallback`。
     */
    slices = [{ startMs: 0, endMs: durationMs, flags: ['vad-no-speech-fallback'] }]
    usedFallback = true
  }

  // ── ② 把语音片铺满每一行 ──────────────────────────────────────────────────
  /**
   * 逐帧能量包络：VAD 的片边界太远时，分配器用它找**句间那些没被 VAD 标出的短停顿**。
   *
   * 这是「慢一点没关系，要能对上」的取舍：多一遍 O(采样数) 的逐帧能量计算，
   * 换来切点落在真实换句处，而不是字中间。`refineBoundaries: false` 可关掉（省时间）。
   */
  const energy = buildEnergyEnvelope(input)
  const allocated = allocateLinesToSlices(slices, input.lines, {
    ...(input.lowConfidenceThreshold !== undefined
      ? { lowConfidenceThreshold: input.lowConfidenceThreshold }
      : {}),
    ...(energy ? { energy } : {}),
    ...(input.dipSearchMs !== undefined ? { dipSearchMs: input.dipSearchMs } : {}),
  })

  const warnings = [...allocated.warnings]
  if (usedFallback) {
    warnings.unshift(
      '没有检测到明显的静音间隙（整段像是一口气读完的）—— 已按每行文本长度**按比例**切分，' +
        '这些边界不一定落在句子之间，建议导入后试听确认。',
    )
  }

  return {
    ranges: allocated.ranges,
    needsReview: allocated.needsReview,
    warnings,
    slices,
    method: usedFallback ? 'whole-timeline' : 'vad',
    stats: {
      durationMs,
      sliceCount: slices.length,
      lineCount: input.lines.length,
      oneToOne: allocated.stats.oneToOne,
      coveredMs: allocated.stats.coveredMs,
      avgConfidence: allocated.stats.avgConfidence,
      usedFallback,
    },
  }
}
