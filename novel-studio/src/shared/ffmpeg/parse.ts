/**
 * Novel Studio · ffmpeg 输出解析与能力探测（纯字符串处理，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/02 §5.1 启动时必须验证的 ffmpeg 能力（`-filters` 输出检查）
 *   · docs/04 §5   结构化日志与进度
 *   · docs/14 §3.1 三处必须实测确认的参数 → 用「能力探测」而不是「写死参数」
 *
 * 为什么要有能力探测：不同 ffmpeg 构建的滤镜集与参数差异很大
 * （`afftdn` 的 nr/nf 范围、`deesser` 是否存在、`loudnorm print_format=json`），
 * 写死参数的结果是「在用户机器上崩」，而探测之后可以隐藏对应控件（docs/14 §3.1）。
 *
 * 失败语义：解析器永不抛异常 —— 解析不出来就返回 null / 空数组，
 *          由调用方决定降级（隐藏控件）还是报错（`FILTER_UNSUPPORTED`）。
 */

import type { FfmpegCapabilities } from '../types.ts'

/** docs/02 §5.1 列出的关键滤镜：缺失则对应功能必须降级或隐藏 */
export const REQUIRED_FILTERS = [
  'loudnorm',
  'afftdn',
  'deesser',
  'equalizer',
  'acompressor',
  'alimiter',
  'sidechaincompress',
  'amix',
  'concat',
  'atempo',
  'highpass',
  'lowpass',
] as const

/** 关键编码器（导出格式决定；缺失则必须换格式或提示用户） */
export const REQUIRED_ENCODERS = ['libmp3lame', 'aac'] as const

export interface FfmpegProgressInfo {
  /** 已处理的输出时间（微秒） */
  outTimeUs?: number
  /** 当前输出大小（字节） */
  totalSize?: number
  /** 处理速度倍率（`1.23x` → 1.23） */
  speed?: number
  /** 当前帧号（视频流居多，音频是 packet 计数，仅作参考） */
  frame?: number
  /** progress=continue | end */
  progress?: 'continue' | 'end'
}

/**
 * 解析 `-progress pipe:1` 的单行输出。
 *
 * 示例输入：
 * ```
 * out_time_us=12345678
 * total_size=4096000
 * speed=1.23x
 * progress=continue
 * ```
 *
 * ★ ffmpeg 的 `out_time_ms` 字段**实际也是微秒**（历史遗留），因此这里把它当 µs 处理；
 *   只有当 `out_time_us` 缺失时才用它兜底。
 *
 * @throws 不抛异常；无关行返回 null
 */
export function parseProgress(line: string): FfmpegProgressInfo | null {
  if (!line || typeof line !== 'string') return null
  const trimmed = line.trim()
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  const key = trimmed.slice(0, eq).trim()
  const raw = trimmed.slice(eq + 1).trim()

  switch (key) {
    case 'out_time_us':
    case 'out_time_ms': {
      const v = Number(raw)
      if (!Number.isFinite(v) || v < 0) return null
      return { outTimeUs: Math.round(v) }
    }
    case 'out_time': {
      const us = parseFfmpegTimeToUs(raw)
      return us === null ? null : { outTimeUs: us }
    }
    case 'total_size': {
      const v = Number(raw)
      return Number.isFinite(v) ? { totalSize: Math.max(0, Math.round(v)) } : null
    }
    case 'speed': {
      const m = /^([\d.]+)\s*x$/i.exec(raw)
      if (!m) return null
      const v = Number(m[1])
      return Number.isFinite(v) ? { speed: v } : null
    }
    case 'frame': {
      const v = Number(raw)
      return Number.isFinite(v) ? { frame: Math.max(0, Math.round(v)) } : null
    }
    case 'progress': {
      if (raw === 'continue' || raw === 'end') return { progress: raw }
      return null
    }
    default:
      return null
  }
}

/** `00:12:22.500000` → 微秒 */
export function parseFfmpegTimeToUs(text: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = Number(m[3])
  if (!Number.isFinite(h + min + sec)) return null
  return Math.round(((h * 60 + min) * 60 + sec) * 1_000_000)
}

/**
 * 把一整段 `-progress` 输出（多行）合并成一个进度对象。
 *
 * @throws 不抛异常；无有效行时返回 null
 */
export function parseProgressOutput(chunk: string): FfmpegProgressInfo | null {
  if (!chunk) return null
  const merged: FfmpegProgressInfo = {}
  let seen = false
  for (const line of chunk.split(/\r?\n/)) {
    const info = parseProgress(line)
    if (!info) continue
    seen = true
    Object.assign(merged, info)
  }
  return seen ? merged : null
}

/**
 * 解析 `ffmpeg -version` 输出的版本号。
 *
 * 例：`ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright (c) 2000-2023 ...` → `6.1.1-full_build-www.gyan.dev`
 *
 * @throws 不抛异常；解析不出返回 null（UI 显示「未探测到 ffmpeg」）
 */
export function parseVersion(stdout: string): string | null {
  if (!stdout || typeof stdout !== 'string') return null
  const m = /ffmpeg version (\S+)/i.exec(stdout)
  if (m && m[1]) return m[1].replace(/[,;]$/, '')
  // 某些构建把版本号藏在配置片段里
  const alt = /^\s*(\d+\.\d+(?:\.\d+)?(?:-\S+)?)\s*$/m.exec(stdout)
  return alt && alt[1] ? alt[1] : null
}

/**
 * 解析 `ffmpeg -filters` 输出的滤镜名列表。
 *
 * 输出形如：
 * ```
 * Filters:
 *   T.. = Timeline support
 *   .S. = Slice threading
 *   ... acompressor       A->A       Audio compressor.
 *   ..C afftdn            A->A       Affine denoise.
 * ```
 * 只取「三字符标记 + 名字」的行，过滤表头与说明行。
 *
 * @throws 不抛异常；无匹配返回空数组
 */
export function parseFilters(stdout: string): string[] {
  if (!stdout || typeof stdout !== 'string') return []
  const names = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const m = /^\s{1,4}([TSC.]{3})\s+([A-Za-z0-9_]+)\s+\S/.exec(line)
    if (!m) continue
    names.add(m[2] as string)
  }
  return [...names].sort()
}

/** 解析 `ffmpeg -encoders` 输出的编码器名列表（形如 ` A....D libmp3lame  libmp3lame MP3`） */
export function parseEncoders(stdout: string): string[] {
  if (!stdout || typeof stdout !== 'string') return []
  const names = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const m = /^\s*([A-Z.]{6})\s+(\S+)\s+\S/.exec(rawLine)
    if (!m) continue
    if (!m[1]?.includes('A') && !m[1]?.includes('V')) continue
    names.add(m[2] as string)
  }
  return [...names].sort()
}

/**
 * 由版本与滤镜列表算出能力（docs/02 §5.1）。
 *
 * @param version `-version` 输出（或已解析的版本串；null/空 = 未探测到 ffmpeg）
 * @param filters 已解析的滤镜名列表
 * @param required 必须存在的滤镜（缺省用 REQUIRED_FILTERS）
 * @throws 不抛异常
 */
export function computeCapabilities(
  version: string | null,
  filters: string[],
  required: readonly string[] = REQUIRED_FILTERS,
): { missing: string[]; available: boolean; version: string | null } {
  const list = Array.isArray(filters) ? filters.map(f => String(f).toLowerCase()) : []
  const set = new Set(list)
  const missing = required.filter(name => !set.has(name.toLowerCase()))
  const hasVersion = typeof version === 'string' && version.trim().length > 0
  return {
    version: hasVersion ? (version as string).trim() : null,
    // 没探测到 ffmpeg（版本为空）时一律视为不可用，UI 应引导用户到设置页配置路径
    available: hasVersion,
    missing,
  }
}

/**
 * 组装完整的 `FfmpegCapabilities`（供 IPC `ffmpeg.capabilities` 直接返回）。
 *
 * @throws 不抛异常
 */
export function buildFfmpegCapabilities(input: {
  versionStdout: string
  filtersStdout: string
  encodersStdout?: string
  path?: string | null
}): FfmpegCapabilities {
  const version = parseVersion(input.versionStdout)
  const filters = parseFilters(input.filtersStdout)
  const encoders = input.encodersStdout ? parseEncoders(input.encodersStdout) : []
  const caps = computeCapabilities(version, filters)
  return {
    version: caps.version ?? '',
    available: caps.available,
    path: input.path ?? null,
    filters,
    missing: caps.missing,
    encoders,
  }
}

/**
 * 解析 `astats` 的关键指标（噪声轮廓采样，docs/14 §5；docs/05 §6.1 的 nf 自动填充）。
 *
 * 真实输出形如（注意标签里带空格与 dB 后缀）：
 * ```
 * Overall
 * Peak level dB: -8.100000
 * RMS level dB: -52.300000
 * Flat factor: 0.000000
 * ```
 *
 * @throws 不抛异常；无匹配返回 null
 */
export function parseAstats(stderr: string): {
  rmsDb: number | null
  peakDb: number | null
  flatFactor: number | null
} | null {
  if (!stderr || typeof stderr !== 'string') return null
  const pick = (label: string): number | null => {
    // 兼容 `RMS level dB:` / `RMS_level:` / `Overall.RMS_level=` 三种写法
    const re = new RegExp(`${label}[\\s_.]*(?:dB)?\\s*[:=]\\s*(-?[\\d.]+|inf|nan)`, 'i')
    const m = re.exec(stderr)
    if (!m) return null
    const v = Number(m[1])
    return Number.isFinite(v) ? v : null
  }
  const rmsDb = pick('RMS[\\s_.]*level')
  const peakDb = pick('Peak[\\s_.]*level')
  const flatFactor = pick('Flat[\\s_.]*factor')
  if (rmsDb === null && peakDb === null && flatFactor === null) return null
  return { rmsDb, peakDb, flatFactor }
}

/**
 * 解析 `ffprobe -print_format json -show_format -show_chapters` 的输出（M4B 验收用）。
 *
 * @throws 不抛异常；JSON 非法时返回 null（调用方抛 `EXPORT_M4B_VERIFY_FAILED`）
 */
export function parseFfprobeJson(stdout: string): {
  durationMs: number | null
  sizeBytes: number | null
  formatName: string | null
  chapters: Array<{ title: string | null; startMs: number; endMs: number }>
} | null {
  if (!stdout) return null
  let obj: unknown
  try {
    obj = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const root = obj as {
    format?: { duration?: string; size?: string; format_name?: string }
    chapters?: Array<{ start_time?: string; end_time?: string; tags?: { title?: string } }>
  }
  const durationSec = Number(root.format?.duration)
  const size = Number(root.format?.size)
  return {
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
    sizeBytes: Number.isFinite(size) ? size : null,
    formatName: root.format?.format_name ?? null,
    chapters: (root.chapters ?? []).map(c => ({
      title: c.tags?.title ?? null,
      startMs: Math.round((Number(c.start_time) || 0) * 1000),
      endMs: Math.round((Number(c.end_time) || 0) * 1000),
    })),
  }
}
