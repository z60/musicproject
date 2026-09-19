/**
 * Novel Studio · ffmpeg 命令行构建（纯字符串数组，零依赖、不调用 ffmpeg）
 * ============================================================================
 * 设计依据：
 *   · docs/05 §8.1 两遍法响度（measure → gain → alimiter）
 *   · docs/05 §9.1 分章导出 MP3/WAV/M4A；§9.2 M4B（chapters.txt / list.txt）
 *   · docs/15 §3 渲染管线；§5.1 命令要点；§5.2 M4B
 *
 * ★ 为什么是「命令构建 + 注入执行器」而不是直接调用 ffmpeg：
 *   1. 命令数组是纯数据，可以在无 ffmpeg、无网络的环境里被单测覆盖（本仓库就是这种环境）；
 *   2. 用户点「查看命令」时要把完整命令行复制到终端复现问题（docs/14 §7.3）；
 *   3. 执行策略（并发限制、取消、进度、stderr 解析）与命令内容解耦。
 *
 * FfmpegRunner 只是接口 —— 生产实现放 `infra/ffmpeg/runner.ts`（spawn 或 fluent-ffmpeg），
 * 本文件不 import 任何第三方包、不 spawn 任何进程。
 */

import { EXPORT_DEFAULTS } from '../constants.ts'
import type { ExportFormat, ExportMetadata } from '../types.ts'
import { fmtNum, limiterLimitLinear } from './filters.ts'

// ============================================================================
// 执行器接口（依赖注入点）
// ============================================================================

export interface FfmpegExecuteOptions {
  /** 超时（毫秒）；超时后由实现负责 kill（SIGTERM → 2 s → SIGKILL） */
  timeoutMs?: number
  /** `-progress pipe:1` 的实时进度回调（见 parse.ts 的 parseProgress） */
  onProgressLine?: (line: string) => void
  /** 取消信号；取消不是错误，应抛 TASK_CANCELLED */
  signal?: AbortSignal
  /** 工作目录（临时文件统一在 cache/tmp/{taskId}/ 下，docs/05 §6.4） */
  cwd?: string
  /** 环境变量（例如 ffmpeg 定位） */
  env?: Record<string, string>
}

export interface FfmpegExecuteResult {
  /** 实际执行的完整命令（用于「查看命令」与日志） */
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  elapsedMs: number
}

/**
 * ffmpeg 执行器（生产实现在 `infra/ffmpeg/runner.ts`）。
 *
 * 约定：
 *   · 非 0 退出码不在这里抛业务异常，而是原样返回 `exitCode` 与 `stderr`，
 *     由调用方决定抛 `EXPORT_FFMPEG_FAILED` / `FILTER_UNSUPPORTED` 还是重试；
 *   · 被取消时抛 `TASK_CANCELLED`（不是错误，UI 不弹提示）；
 *   · 找不到 ffmpeg 二进制时抛 `INTERNAL` 并带 `details.hint`（提示用户到设置页配置路径）。
 */
export interface FfmpegRunner {
  execute(command: string[], opts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult>
  /** 能力探测：`-version` + `-filters` + `-encoders`（可选，缺省时 UI 显示「未探测」） */
  probeCapabilities?(): Promise<{ version: string | null; filters: string[]; encoders: string[] }>
}

/** 命令转成可复制的字符串（Windows 下用双引号包住含空格的参数） */
export function formatCommandForDisplay(command: string[]): string {
  return command
    .map(a => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
}

/** 命令里是否包含某段（测试与自检用） */
export function commandIncludes(command: string[], fragment: string): boolean {
  return command.some(a => a.includes(fragment))
}

function base(ffmpegPath?: string): string[] {
  return [ffmpegPath ?? 'ffmpeg', '-hide_banner', '-nostdin']
}

// ============================================================================
// 分章导出（docs/05 §9.1 / docs/15 §5.1）
// ============================================================================

export interface ChapterExportCommandInput {
  /** 混音后的中间 WAV（cache/tmp/{taskId}/chapter-{id}.wav） */
  input: string
  output: string
  format: ExportFormat
  /** MP3 码率，默认 192k（docs/05 §12） */
  mp3Bitrate?: 128 | 192 | 256 | 320
  /** M4A 码率，默认 192k */
  m4aBitrate?: 64 | 96 | 128 | 192 | 192
  /** 输出采样率：MP3 默认 44.1 kHz（老设备兼容性更好） */
  sampleRate?: 44100 | 48000
  channels?: 1 | 2
  metadata?: ExportMetadata
  chapterIndex?: number
  chapterTotal?: number
  /** 封面图片路径（jpeg/png），以 attached_pic 方式嵌入 */
  coverPath?: string | null
  /** 覆盖已有文件（-y）；默认 true（覆盖策略由上层决定，见 docs/15 §6.1） */
  overwrite?: boolean
  /** 限制线程数（默认留给系统 2 个核，避免 UI 卡） */
  threadCount?: number
  /** 响度处理滤镜串（若已在渲染阶段施加则不必传） */
  audioFilters?: string
  ffmpegPath?: string
}

/**
 * 分章导出命令（MP3 / WAV / M4A）。
 *
 * 必须写死的三个参数（漏了就是 bug）：
 *   · `-write_xing 1`   —— 否则 MP3 时长显示不准、seek 困难
 *   · `-id3v2_version 3` —— 最兼容的 ID3 版本
 *   · `-movflags +faststart`（M4A）—— moov 前置
 *
 * @throws 不抛异常；参数越界按默认值处理
 */
export function buildChapterExportCommand(input: ChapterExportCommandInput): string[] {
  const cmd = base(input.ffmpegPath)
  cmd.push('-loglevel', 'error', '-nostats')
  if (input.overwrite !== false) cmd.push('-y')
  cmd.push('-i', input.input)

  const metadata = input.metadata ?? {}
  const hasCover = Boolean(input.coverPath)
  if (hasCover && input.format === 'mp3') cmd.push('-i', input.coverPath as string)

  if (hasCover && input.format === 'mp3') {
    cmd.push('-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic')
  }

  switch (input.format) {
    case 'mp3': {
      cmd.push('-c:a', 'libmp3lame', '-b:a', `${input.mp3Bitrate ?? EXPORT_DEFAULTS.mp3Bitrate}k`)
      cmd.push('-ar', String(input.sampleRate ?? EXPORT_DEFAULTS.mp3SampleRate))
      // ★ 不加 -write_xing 会让时长显示不准、seek 困难
      cmd.push('-write_xing', '1')
      // ★ ID3v2.3 兼容性最好（某些播放器对 v2.4 敏感）
      cmd.push('-id3v2_version', '3')
      break
    }
    case 'm4a': {
      cmd.push('-c:a', 'aac', '-b:a', `${input.m4aBitrate ?? 192}k`)
      cmd.push('-ar', String(input.sampleRate ?? EXPORT_DEFAULTS.mp3SampleRate))
      // ★ moov 前置：边下边播与部分播放器必需
      cmd.push('-movflags', '+faststart')
      break
    }
    case 'wav':
    default: {
      cmd.push('-c:a', 'pcm_s24le')
      cmd.push('-ar', String(input.sampleRate ?? 48000))
      break
    }
  }

  cmd.push('-ac', String(input.channels ?? 1))
  if (input.audioFilters) cmd.push('-af', input.audioFilters)
  if (input.threadCount && input.threadCount > 0) cmd.push('-threads', String(Math.floor(input.threadCount)))

  for (const [key, value] of metadataPairs(metadata, input.chapterIndex, input.chapterTotal)) {
    cmd.push('-metadata', `${key}=${value}`)
  }

  cmd.push(input.output)
  return cmd
}

/** 元数据键值对（顺序稳定，便于快照比对；docs/15 §5.1 的模板） */
export function metadataPairs(
  metadata: ExportMetadata,
  chapterIndex?: number,
  chapterTotal?: number,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const add = (k: string, v: string | undefined | null): void => {
    if (v !== undefined && v !== null && v !== '') pairs.push([k, v])
  }
  add('title', metadata.title)
  add('artist', metadata.artist)
  add('album', metadata.album)
  add('album_artist', metadata.narrator)
  if (chapterIndex !== undefined && chapterTotal !== undefined) {
    pairs.push(['track', `${chapterIndex}/${chapterTotal}`])
  } else if (chapterIndex !== undefined) {
    pairs.push(['track', String(chapterIndex)])
  }
  // 空串视为「未设置」，回落到 Audiobook（避免写出空的 genre 标签）
  add('genre', metadata.genre || 'Audiobook')
  add('date', metadata.date)
  pairs.push(['comment', '由 Novel Studio 制作'])
  return pairs
}

// ============================================================================
// 响度（docs/05 §8.1 / docs/15 §4）
// ============================================================================

export interface LoudnessMeasureCommandInput {
  input: string
  targetLufs: number
  truePeakDb: number
  lra: number
  ffmpegPath?: string
}

/**
 * Pass 1：响度测量（`loudnorm ... print_format=json -f null -`）。
 *
 * 输出 JSON 在 **stderr**，用 `parse.ts` 的 `parseLoudnormJson()` 解析。
 *
 * @throws 不抛异常
 */
export function buildLoudnessMeasureCommand(input: LoudnessMeasureCommandInput): string[] {
  const cmd = base(input.ffmpegPath)
  cmd.push('-nostats', '-i', input.input)
  cmd.push(
    '-af',
    `loudnorm=I=${fmtNum(input.targetLufs)}:TP=${fmtNum(input.truePeakDb)}:LRA=${fmtNum(input.lra)}:print_format=json`,
  )
  cmd.push('-f', 'null', '-')
  return cmd
}

export interface LoudnessApplyCommandInput {
  input: string
  output: string
  /** = target_I - input_i（线性增益，docs/05 §8.1） */
  gainDb: number
  /** 真峰目标（dBTP），默认 -1；alimiter 的 limit 是线性值 */
  truePeakDb?: number
  limiterAttackMs?: number
  limiterReleaseMs?: number
  sampleRate?: number
  channels?: 1 | 2
  overwrite?: boolean
  ffmpegPath?: string
}

/**
 * Pass 2：施加增益（`volume={gainDb}dB,alimiter=limit=...`）。
 *
 * ★ 用线性 `volume` 而不是 `loudnorm` 第二遍：后者是动态归一化，会压动态、
 *   逐章结果不齐；有声书要的是章间一致（docs/05 §8.1）。
 * ★ `alimiter` 只做采样级限幅，**不是真峰限幅** —— 真峰靠 Pass 3 复核
 *   （超了抛 `EXPORT_TRUE_PEAK_EXCEEDED`，再降 0.5 dB 重渲）。
 *
 * @throws 不抛异常
 */
export function buildLoudnessApplyCommand(input: LoudnessApplyCommandInput): string[] {
  const cmd = base(input.ffmpegPath)
  cmd.push('-loglevel', 'error', '-nostats')
  if (input.overwrite !== false) cmd.push('-y')
  cmd.push('-i', input.input)
  const limit = fmtNum(limiterLimitLinear(input.truePeakDb ?? EXPORT_DEFAULTS.truePeakDb), 6)
  const af =
    `volume=${fmtNum(input.gainDb)}dB,` +
    `alimiter=limit=${limit}:attack=${fmtNum(input.limiterAttackMs ?? 5, 2)}:release=${fmtNum(input.limiterReleaseMs ?? 80, 2)}`
  cmd.push('-af', af)
  cmd.push('-c:a', 'pcm_s24le')
  cmd.push('-ar', String(input.sampleRate ?? 48000))
  cmd.push('-ac', String(input.channels ?? 1))
  cmd.push(input.output)
  return cmd
}

/** Pass 3：复核（重新测量成品；偏差 > 0.5 LU 则微调一次） */
export function buildLoudnessVerifyCommand(input: LoudnessMeasureCommandInput): string[] {
  return buildLoudnessMeasureCommand(input)
}

// ============================================================================
// M4B（docs/05 §9.2 / docs/15 §5.2）
// ============================================================================

export interface M4bCommandInput {
  /** concat 列表文件（generateConcatList 产出） */
  listFile: string
  /** 章节元数据文件（generateFfmetadata 产出） */
  metadataFile: string
  output: string
  m4bBitrate?: 64 | 96 | 128 | 192
  sampleRate?: 44100 | 48000
  channels?: 1 | 2
  overwrite?: boolean
  threadCount?: number
  ffmpegPath?: string
}

/**
 * 整本合并 M4B 命令。
 *
 * ★ `-map_metadata 1 -map_chapters 1` 必须同时存在：不加 `-map_chapters 1`
 *   则章节信息全部丢失（「M4B 没有章节」的最常见原因，docs/15 §5.2）。
 * ★ `-movflags +faststart`：moov 前置，边下边播与部分播放器必需。
 *
 * @throws 不抛异常
 */
export function buildM4bCommand(input: M4bCommandInput): string[] {
  const cmd = base(input.ffmpegPath)
  cmd.push('-loglevel', 'error', '-nostats')
  if (input.overwrite !== false) cmd.push('-y')
  cmd.push('-f', 'concat', '-safe', '0', '-i', input.listFile)
  cmd.push('-i', input.metadataFile)
  cmd.push('-map_metadata', '1')
  cmd.push('-map_chapters', '1')
  cmd.push('-c:a', 'aac', '-b:a', `${input.m4bBitrate ?? EXPORT_DEFAULTS.m4bBitrate}k`)
  cmd.push('-ar', String(input.sampleRate ?? EXPORT_DEFAULTS.mp3SampleRate))
  cmd.push('-ac', String(input.channels ?? 1))
  cmd.push('-movflags', '+faststart')
  if (input.threadCount && input.threadCount > 0) cmd.push('-threads', String(Math.floor(input.threadCount)))
  cmd.push(input.output)
  return cmd
}

/** 仅检查/读取现有 M4B（验收用：章节数、时长、容器格式） */
export function buildM4bProbeCommand(input: { file: string; ffprobePath?: string }): string[] {
  return [
    input.ffprobePath ?? 'ffprobe',
    '-hide_banner',
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_chapters',
    input.file,
  ]
}

// ============================================================================
// 处理链命令（docs/14 §2/§3，`process:*`）
// ============================================================================

export interface ProcessCommandInput {
  input: string
  output: string
  /** 处理链产出的滤镜串（`buildChainFilter`）；空串 = 只做格式统一 */
  filter: string
  sampleRate?: 44100 | 48000
  channels?: 1 | 2
  /** 输出位深（处理结果默认 24 位，docs/05 §2.5） */
  bitDepth?: 16 | 24
  /**
   * 只处理源文件的 `[0, 前 N 毫秒]`（试听用，docs/14 §10「试听 10 秒」）。
   * 不传 = 处理全长。
   */
  previewMs?: number
  overwrite?: boolean
  ffmpegPath?: string
}

/**
 * 处理链命令（`process:apply` / `process:preview` 的实际执行方案）。
 *
 * ★ 三个必须写死的参数（漏了就会出真问题）：
 *   · `-map_metadata -1`：**丢掉源文件的元数据**。中间产物的元数据会随
 *     concat/amix 带进最终音频，导致「听众看到的是上一次导出的标题」。
 *   · `-vn`：源里若带了封面/图片流，不加会被当成视频流处理失败。
 *   · `-c:a pcm_s16le|pcm_s24le` + `-f wav`：处理产物必须是**无损中间格式**，
 *     否则「处理 → 对轨 → 导出」会经历两次有损编码（docs/14 §2.2）。
 *
 * `filter` 为空串时命令退化为「格式统一」（仅修剪预设就是这种，docs/14 §13）。
 *
 * @throws 不抛异常；参数越界按默认值处理
 */
export function buildProcessCommand(input: ProcessCommandInput): string[] {
  const cmd = base(input.ffmpegPath)
  cmd.push('-loglevel', 'error', '-nostats')
  if (input.overwrite !== false) cmd.push('-y')
  // ★ previewMs 用 `-t`（限制**输入**读取时长）而不是 `-ss`：试听要的是「前 N 毫秒」，
  //   放在 -i 之前是最省的写法（ffmpeg 读到 N 毫秒就停止拉流）
  if (input.previewMs && input.previewMs > 0) cmd.push('-t', fmtNum(input.previewMs / 1000, 3))
  cmd.push('-i', input.input)
  cmd.push('-vn')
  if (input.filter) cmd.push('-af', input.filter)
  cmd.push('-ar', String(input.sampleRate ?? 48000))
  cmd.push('-ac', String(input.channels ?? 1))
  cmd.push('-c:a', (input.bitDepth ?? 24) === 16 ? 'pcm_s16le' : 'pcm_s24le')
  cmd.push('-f', 'wav')
  cmd.push('-map_metadata', '-1')
  cmd.push(input.output)
  return cmd
}

// ============================================================================
// 混音渲染命令（docs/15 §3）
// ============================================================================

export interface MixRenderCommandInput {
  /** 输入文件列表（按 inputIndex 顺序） */
  inputs: string[]
  /** 完整 filter_complex（buildMixFilterGraph 产出） */
  filterGraph: string
  /** 要映射的输出标签，默认 [voice] */
  outputLabel?: string
  output: string
  sampleRate?: 44100 | 48000
  /** 中间格式统一为 pcm_s32le（docs/15 §3.1） */
  sampleFmt?: string
  channels?: 1 | 2
  /** 只渲染前 N 秒（预览用，docs/13 §6.2） */
  durationMs?: number
  threadCount?: number
  overwrite?: boolean
  ffmpegPath?: string
}

/**
 * 渲染一轨/一章的混音命令（filter_complex 版）。
 *
 * @throws 不抛异常
 */
export function buildMixRenderCommand(input: MixRenderCommandInput): string[] {
  const cmd = base(input.ffmpegPath)
  cmd.push('-loglevel', 'error', '-nostats')
  if (input.overwrite !== false) cmd.push('-y')
  for (const file of input.inputs) cmd.push('-i', file)
  cmd.push('-filter_complex', input.filterGraph)
  cmd.push('-map', `[${(input.outputLabel ?? 'voice').replace(/[\[\]]/g, '')}]`)
  cmd.push('-c:a', 'pcm_s24le')
  cmd.push('-ar', String(input.sampleRate ?? 48000))
  cmd.push('-ac', String(input.channels ?? 1))
  if (input.sampleFmt) cmd.push('-sample_fmt', input.sampleFmt)
  if (input.durationMs && input.durationMs > 0) cmd.push('-t', fmtNum(input.durationMs / 1000, 3))
  if (input.threadCount && input.threadCount > 0) cmd.push('-threads', String(Math.floor(input.threadCount)))
  cmd.push(input.output)
  return cmd
}

/** 带 `-progress pipe:1` 的命令（进度解析用；插在输出文件之前） */
export function withProgress(command: string[]): string[] {
  const out = [...command]
  const insertAt = out.length - 1
  out.splice(insertAt, 0, '-progress', 'pipe:1')
  return out
}

// ============================================================================
// 章节元数据与 concat 列表（docs/05 §9.2）
// ============================================================================

export interface FfmetadataChapter {
  title: string
  durationMs: number
}

export interface FfmetadataBookMeta {
  title?: string
  artist?: string
  album?: string
  narrator?: string
  genre?: string
  date?: string
  comment?: string
}

/** ffmetadata 值的转义：`\` `=` `;` `#` 与换行必须以反斜杠转义，否则解析出错 */
export function escapeFfmetadataValue(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([=;#])/g, '\\$1')
    .replace(/\r?\n/g, '\\\n')
}

/**
 * 生成 ffmetadata 章节文件（docs/05 §9.2 步骤 1）。
 *
 * ★ 三条硬性要求（都有单测）：
 *   1. 首行必须是 `;FFMETADATA1`
 *   2. 每章 `TIMEBASE=1/1000`，START/END 是**毫秒整数**
 *   3. START/END **严格连续无缝**：上一章 END == 下一章 START
 *      —— 用累积整型加法计算，避免逐章四舍五入产生 1 ms 缝隙（部分播放器跳转会错位）
 *
 * @throws 不抛异常；时长为 0（或负）的章节被跳过，且不会破坏后续章节的连续性
 */
export function generateFfmetadata(
  chapters: FfmetadataChapter[],
  bookMeta: FfmetadataBookMeta = {},
): string {
  const lines: string[] = [';FFMETADATA1']
  const addMeta = (key: string, value: string | undefined): void => {
    if (value === undefined || value === null || value === '') return
    lines.push(`${key}=${escapeFfmetadataValue(value)}`)
  }
  addMeta('title', bookMeta.title)
  addMeta('artist', bookMeta.artist)
  addMeta('album', bookMeta.album)
  addMeta('album_artist', bookMeta.narrator)
  addMeta('genre', bookMeta.genre ?? 'Audiobook')
  addMeta('date', bookMeta.date)
  addMeta('comment', bookMeta.comment ?? '由 Novel Studio 制作')

  let cursor = 0 // 累积整数毫秒（绝不重新从浮点算起）
  for (const chapter of chapters) {
    const durationMs = Math.round(chapter.durationMs)
    if (!Number.isFinite(durationMs) || durationMs < 1) continue
    const start = cursor
    const end = cursor + durationMs // 整数加法：END 恒等于下一章 START
    lines.push('[CHAPTER]')
    lines.push('TIMEBASE=1/1000')
    lines.push(`START=${start}`)
    lines.push(`END=${end}`)
    lines.push(`title=${escapeFfmetadataValue(chapter.title)}`)
    cursor = end
  }
  return `${lines.join('\n')}\n`
}

/**
 * 解析 ffmetadata（自检/单测用；真实校验仍以 ffprobe 为准）。
 *
 * @throws 不抛异常；格式不符时返回空章节列表
 */
export function parseFfmetadata(text: string): {
  meta: Record<string, string>
  chapters: Array<{ title: string; startMs: number; endMs: number }>
} {
  const meta: Record<string, string> = {}
  const chapters: Array<{ title: string; startMs: number; endMs: number }> = []
  let current: { title: string; startMs: number; endMs: number } | null = null
  const unescape = (v: string): string => v.replace(/\\(.)/g, '$1')

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || line.startsWith(';')) continue
    if (line === '[CHAPTER]') {
      if (current) chapters.push(current)
      current = { title: '', startMs: 0, endMs: 0 }
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const value = unescape(line.slice(eq + 1))
    if (current) {
      const ci = current as { title: string; startMs: number; endMs: number }
      if (key === 'TIMEBASE') continue
      if (key === 'START') ci.startMs = Number(value)
      else if (key === 'END') ci.endMs = Number(value)
      else if (key === 'title') ci.title = value
      else (current as unknown as Record<string, string>)[key] = value
    } else {
      meta[key] = value
    }
  }
  if (current) chapters.push(current)
  return { meta, chapters }
}

/** 校验章节连续性（生成后自检；真实校验用 ffprobe -show_chapters） */
export function verifyChapterContinuity(chapters: Array<{ startMs: number; endMs: number }>): {
  ok: boolean
  gaps: Array<{ atIndex: number; gapMs: number }>
} {
  const gaps: Array<{ atIndex: number; gapMs: number }> = []
  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1] as { startMs: number; endMs: number }
    const cur = chapters[i] as { startMs: number; endMs: number }
    if (cur.startMs !== prev.endMs) gaps.push({ atIndex: i, gapMs: cur.startMs - prev.endMs })
  }
  if (chapters.length > 0 && (chapters[0] as { startMs: number }).startMs !== 0) {
    gaps.push({ atIndex: 0, gapMs: (chapters[0] as { startMs: number }).startMs })
  }
  return { ok: gaps.length === 0, gaps }
}

/**
 * 生成 concat demuxer 列表（docs/05 §9.2 步骤 2）。
 *
 * ★ 路径统一用正斜杠（Windows 反斜杠在 concat 文件里虽然安全，但容易与转义规则混淆）；
 *   单引号按 `'\''` 转义（doc 明确要求）。
 *
 * @throws 不抛异常；路径为空字符串时跳过
 */
export function generateConcatList(files: string[]): string {
  const lines: string[] = []
  for (const f of files) {
    if (!f) continue
    const normalized = f.replace(/\\/g, '/')
    const escaped = normalized.replace(/'/g, "'\\''")
    lines.push(`file '${escaped}'`)
  }
  return `${lines.join('\n')}\n`
}

/** 解析 concat 列表（自检/单测用） */
export function parseConcatList(text: string): string[] {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('file ')) continue
    const body = line.slice(5).trim()
    if (body.startsWith("'") && body.endsWith("'")) {
      out.push(body.slice(1, -1).replace(/'\\''/g, "'"))
    } else {
      out.push(body)
    }
  }
  return out
}
