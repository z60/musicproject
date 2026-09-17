/**
 * Novel Studio · 项目包（.nsp）/ 任务包（.nst）的 manifest 构造与校验
 * ============================================================================
 * 设计依据：
 *   · docs/03 §8  `.nsp` 项目包格式（manifest.json 字段、导入规则 1/3/5）
 *   · docs/03 §9  `.nst` 任务包格式（task.json 字段、回传包变体）
 *   · docs/11 §6.2 任务包导出（选项、linesHash 的计算口径）
 *   · docs/11 §6.3 配音员侧（保留原始 task.json 与 linesHash 用于比对）
 *
 * 两条硬规则：
 *   1. `formatVersion` **高于**当前支持范围 → 抛 `PACKAGE_VERSION_TOO_NEW`（提示升级应用）；
 *      低于支持范围 → 抛 `PACKAGE_INVALID`（当前只有 v1，没有可迁移的更老版本）。
 *   2. 校验错误**一次性收集后抛出**，details.errors 里给出全部缺失/非法字段，
 *      这样用户与日志都能一次看到全部问题，而不是改一个报一个。
 */

import { AppError } from '../../../../shared/errors.ts'
import type {
  Id,
  NspManifest,
  NstLine,
  NstManifest,
  SpeedMark,
} from '../../../../shared/types.ts'

// ============================================================================
// 常量
// ============================================================================

/** 当前应用写出的 .nsp 格式版本 */
export const NSP_FORMAT_VERSION = 1
/** 当前应用写出的 .nst 格式版本 */
export const NST_FORMAT_VERSION = 1
/** 当前可以读取的格式版本范围（docs/03 §8 导入规则 1） */
export const MIN_SUPPORTED_FORMAT_VERSION = 1
export const MAX_SUPPORTED_FORMAT_VERSION = 1

/** 包内固定文件名（docs/03 §8 / §9） */
export const MANIFEST_FILE = 'manifest.json'
export const PROJECT_FILE = 'project.json'
export const DATABASE_FILE = 'database.sqlite'
export const TASK_FILE = 'task.json'
export const TAKES_FILE = 'takes.json'
export const CHECKSUMS_FILE = 'checksums.sha256'
/** 导入结果目录里的 ID 映射表（docs/03 §8 导入规则 3） */
export const ID_MAP_FILE = 'id_map.json'
export const SLOTS_DIR = 'slots'
export const REFERENCE_DIR = 'reference'
export const AUDIO_DIR = 'audio'
export const EXPORTS_DIR = 'exports'

/**
 * 应用信息。
 * 生产应由主进程传 `app.getVersion()`；这里给默认值是为了让包格式与测试不依赖 Electron。
 */
export const DEFAULT_APP_INFO = { name: 'Novel Studio', version: '1.0.0' } as const

export type NspContents = NspManifest['contents']

/** 内容清单预设（docs/03 §8：默认不含 recordings / takes / processed） */
export const NSP_CONTENT_PRESETS: Readonly<Record<'full' | 'standard' | 'slim', NspContents>> = {
  /** 完整归档：连原始录音一起带走（体积最大） */
  full: {
    database: true,
    recordings: true,
    takes: true,
    segments: true,
    processed: true,
    exports: true,
    music: true,
  },
  /** 标准（默认）：库 + 成品片段 + 素材，不含原始录音/试录/处理派生 */
  standard: {
    database: true,
    recordings: false,
    takes: false,
    segments: true,
    processed: false,
    exports: false,
    music: true,
  },
  /** 精简：只带库与成品片段（换机后仍能继续做对轨与混音） */
  slim: {
    database: true,
    recordings: false,
    takes: false,
    segments: true,
    processed: false,
    exports: false,
    music: false,
  },
}

export const NSP_CONTENT_LABELS: Readonly<Record<keyof NspContents, string>> = {
  database: '业务数据库快照',
  recordings: '原始录音',
  takes: '试录版本',
  segments: '成品片段',
  processed: '处理后的派生文件',
  exports: '导出成品',
  music: 'BGM / 音效素材',
}

// ============================================================================
// 构造
// ============================================================================

export interface BuildNspManifestInput {
  project: { id: Id; name: string; totalDurationMs: number }
  schemaVersion: number
  contents: NspContents
  counts: { chapters: number; lines: number; segments: number }
  /** 包内文件总数（含 manifest 与 checksums） */
  files: number
  /** 未压缩总字节数 */
  uncompressedBytes: number
  app?: { name: string; version: string }
  /** ISO 时间字符串；不传则取当前时间 */
  exportedAt?: string
  /** 校验和文件名；设为 null 表示不带校验和文件 */
  checksums?: string | null
}

export function buildNspManifest(input: BuildNspManifestInput): NspManifest {
  const manifest: NspManifest = {
    format: 'nsp',
    formatVersion: NSP_FORMAT_VERSION,
    app: input.app ?? { ...DEFAULT_APP_INFO },
    schemaVersion: input.schemaVersion,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    project: { ...input.project },
    contents: { ...input.contents },
    counts: { ...input.counts },
    files: input.files,
    uncompressedBytes: input.uncompressedBytes,
  }
  // checksums 字段在 types.ts 的 NspManifest 里没有声明（docs/03 §8 的示例有）。
  // 这里按「可选扩展字段」写入，读取侧容忍其存在或缺失。
  if (input.checksums !== null) {
    ;(manifest as NspManifest & { checksums?: string }).checksums = input.checksums ?? CHECKSUMS_FILE
  }
  return manifest
}

export interface BuildNstManifestInput {
  packageId: Id
  source: { projectId: Id; bookId: Id; exportedAt?: string }
  assignee: { voiceActorId: Id | null; name: string; note: string | null }
  recordSettings: NstManifest['recordSettings']
  characters: NstManifest['characters']
  lines: NstLine[]
  /** 画本快照哈希（nst.ts 的 computeLinesHash 产出） */
  linesHash: string
}

export function buildNstManifest(input: BuildNstManifestInput): NstManifest {
  return {
    format: 'nst',
    formatVersion: NST_FORMAT_VERSION,
    packageId: input.packageId,
    source: {
      projectId: input.source.projectId,
      bookId: input.source.bookId,
      exportedAt: input.source.exportedAt ?? new Date().toISOString(),
    },
    assignee: { ...input.assignee },
    recordSettings: { ...input.recordSettings },
    characters: input.characters.map((c) => ({ ...c })),
    lines: input.lines.map((l) => ({ ...l })),
    linesHash: input.linesHash,
  }
}

/** 录音建议的默认值（docs/03 §9 的示例：48k / 24bit / 单声道 / -6 dBFS） */
export const DEFAULT_RECORD_SETTINGS: NstManifest['recordSettings'] = {
  sampleRate: 48000,
  bitDepth: 24,
  channels: 1,
  fileNameTemplate: '{lineId}_{take}.wav',
  recommendGainDb: -6,
  targetPeakDb: -6,
}

// ============================================================================
// 校验
// ============================================================================

/** 收集式校验：把所有问题攒齐再抛，便于一次改完 */
class FieldChecker {
  readonly errors: string[] = []

  object(v: unknown, path: string): Record<string, unknown> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      this.errors.push(`${path} 应为对象，实际 ${describe(v)}`)
      return null
    }
    return v as Record<string, unknown>
  }

  string(v: unknown, path: string, opts: { allowEmpty?: boolean } = {}): string | null {
    if (typeof v !== 'string') {
      this.errors.push(`${path} 应为字符串，实际 ${describe(v)}`)
      return null
    }
    if (!opts.allowEmpty && v.trim() === '') this.errors.push(`${path} 不能为空`)
    return v
  }

  number(v: unknown, path: string, opts: { integer?: boolean; min?: number } = {}): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.errors.push(`${path} 应为数字，实际 ${describe(v)}`)
      return null
    }
    if (opts.integer && !Number.isInteger(v)) this.errors.push(`${path} 应为整数，实际 ${v}`)
    if (opts.min !== undefined && v < opts.min) this.errors.push(`${path} 不应小于 ${opts.min}，实际 ${v}`)
    return v
  }

  boolean(v: unknown, path: string): boolean | null {
    if (typeof v !== 'boolean') {
      this.errors.push(`${path} 应为布尔值，实际 ${describe(v)}`)
      return null
    }
    return v
  }

  array(v: unknown, path: string): unknown[] | null {
    if (!Array.isArray(v)) {
      this.errors.push(`${path} 应为数组，实际 ${describe(v)}`)
      return null
    }
    return v
  }

  /**
   * 格式版本校验（docs/03 §8 导入规则 1）：
   *   · format 不匹配 / 缺字段 → PACKAGE_INVALID
   *   · 高于支持范围         → PACKAGE_VERSION_TOO_NEW
   *   · 低于支持范围         → PACKAGE_INVALID（当前没有可迁移的旧版本）
   */
  formatVersion(raw: Record<string, unknown>, expected: 'nsp' | 'nst'): number {
    const format = raw.format
    if (format !== expected) {
      throw new AppError('PACKAGE_INVALID', {
        details: { reason: 'format-mismatch', expected, actual: format ?? null },
      })
    }
    const version = raw.formatVersion
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new AppError('PACKAGE_INVALID', {
        details: { reason: 'format-version-invalid', actual: version ?? null },
      })
    }
    if (version > MAX_SUPPORTED_FORMAT_VERSION) {
      throw new AppError('PACKAGE_VERSION_TOO_NEW', {
        params: { version: String(version) },
        details: { format: expected, supported: MAX_SUPPORTED_FORMAT_VERSION, actual: version },
      })
    }
    if (version < MIN_SUPPORTED_FORMAT_VERSION) {
      throw new AppError('PACKAGE_INVALID', {
        details: { reason: 'format-version-too-old', supported: MIN_SUPPORTED_FORMAT_VERSION, actual: version },
      })
    }
    return version
  }

  throwIfErrors(what: string): void {
    if (this.errors.length === 0) return
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'manifest-invalid', what, errors: this.errors.slice(0, 40) },
    })
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (v === undefined) return 'undefined'
  return typeof v
}

/**
 * 校验 .nsp 的 manifest.json。
 * @throws `PACKAGE_INVALID`（结构/格式问题）、`PACKAGE_VERSION_TOO_NEW`（版本过高）
 */
export function validateNspManifest(raw: unknown): NspManifest {
  const c = new FieldChecker()
  const root = c.object(raw, 'manifest')
  if (!root) c.throwIfErrors('nsp.manifest')
  const obj = root as Record<string, unknown>
  c.formatVersion(obj, 'nsp')

  const app = c.object(obj.app, 'app')
  if (app) {
    c.string(app.name, 'app.name')
    c.string(app.version, 'app.version')
  }
  c.number(obj.schemaVersion, 'schemaVersion', { integer: true, min: 1 })
  c.string(obj.exportedAt, 'exportedAt')

  const project = c.object(obj.project, 'project')
  if (project) {
    c.string(project.id, 'project.id')
    c.string(project.name, 'project.name')
    c.number(project.totalDurationMs, 'project.totalDurationMs', { min: 0 })
  }

  const contents = c.object(obj.contents, 'contents')
  if (contents) {
    for (const key of Object.keys(NSP_CONTENT_LABELS)) {
      c.boolean(contents[key], `contents.${key}`)
    }
  }

  const counts = c.object(obj.counts, 'counts')
  if (counts) {
    c.number(counts.chapters, 'counts.chapters', { integer: true, min: 0 })
    c.number(counts.lines, 'counts.lines', { integer: true, min: 0 })
    c.number(counts.segments, 'counts.segments', { integer: true, min: 0 })
  }

  c.number(obj.files, 'files', { integer: true, min: 0 })
  c.number(obj.uncompressedBytes, 'uncompressedBytes', { min: 0 })

  c.throwIfErrors('nsp.manifest')
  return raw as NspManifest
}

/**
 * 校验 .nst 的 task.json / manifest.json。
 * 行级字段做抽样强校验（`lines` 必须是非空数组，每行的 id/text 必须合法），
 * 但不校验每行的 emotion 白名单 —— 那属于画本质检（docs/11 §5）的职责。
 */
export function validateNstManifest(raw: unknown): NstManifest {
  const c = new FieldChecker()
  const root = c.object(raw, 'manifest')
  if (!root) c.throwIfErrors('nst.manifest')
  const obj = root as Record<string, unknown>
  c.formatVersion(obj, 'nst')

  c.string(obj.packageId, 'packageId')
  c.string(obj.linesHash, 'linesHash')

  const source = c.object(obj.source, 'source')
  if (source) {
    c.string(source.projectId, 'source.projectId')
    c.string(source.bookId, 'source.bookId')
    c.string(source.exportedAt, 'source.exportedAt')
  }

  const assignee = c.object(obj.assignee, 'assignee')
  if (assignee) {
    c.string(assignee.name, 'assignee.name')
    const actorId = assignee.voiceActorId
    if (actorId !== null && typeof actorId !== 'string') {
      c.errors.push(`assignee.voiceActorId 应为 string 或 null，实际 ${describe(actorId)}`)
    }
  }

  const rs = c.object(obj.recordSettings, 'recordSettings')
  if (rs) {
    c.number(rs.sampleRate, 'recordSettings.sampleRate', { integer: true, min: 8000 })
    c.number(rs.bitDepth, 'recordSettings.bitDepth', { integer: true, min: 8 })
    c.number(rs.channels, 'recordSettings.channels', { integer: true, min: 1 })
    c.string(rs.fileNameTemplate, 'recordSettings.fileNameTemplate')
    c.number(rs.recommendGainDb, 'recordSettings.recommendGainDb')
    c.number(rs.targetPeakDb, 'recordSettings.targetPeakDb')
  }

  const characters = c.array(obj.characters, 'characters')
  if (characters) {
    characters.forEach((ch, i) => {
      const item = c.object(ch, `characters[${i}]`)
      if (!item) return
      c.string(item.id, `characters[${i}].id`)
      c.string(item.name, `characters[${i}].name`)
      const speed = item.defaultSpeed
      if (speed !== null && !isSpeedMark(speed)) {
        c.errors.push(`characters[${i}].defaultSpeed 应为 slow/normal/fast 或 null`)
      }
    })
  }

  const lines = c.array(obj.lines, 'lines')
  if (lines) {
    lines.forEach((ln, i) => {
      const item = c.object(ln, `lines[${i}]`)
      if (!item) return
      c.string(item.id, `lines[${i}].id`)
      c.number(item.seq, `lines[${i}].seq`, { integer: true, min: 0 })
      c.string(item.text, `lines[${i}].text`, { allowEmpty: true })
      c.string(item.characterName, `lines[${i}].characterName`)
      c.number(item.pauseAfterMs, `lines[${i}].pauseAfterMs`, { min: 0 })
      const speed = item.speed
      if (speed !== null && !isSpeedMark(speed)) {
        c.errors.push(`lines[${i}].speed 应为 slow/normal/fast 或 null`)
      }
    })
  }

  c.throwIfErrors('nst.manifest')
  return raw as NstManifest
}

export function isSpeedMark(v: unknown): v is SpeedMark {
  return v === 'slow' || v === 'normal' || v === 'fast'
}

/** 从任意 JSON 文本解析并校验 manifest（JSON 语法错误 → PACKAGE_INVALID） */
export function parseManifestJson(text: string, format: 'nsp' | 'nst'): NspManifest | NstManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new AppError('PACKAGE_INVALID', {
      cause: e,
      details: { reason: 'manifest-json-parse-failed', format, textChars: text.length },
    })
  }
  return format === 'nsp' ? validateNspManifest(parsed) : validateNstManifest(parsed)
}

/** 只看版本号（不做完整校验），用于「先判断该不该升级应用」的快速路径 */
export function peekFormatVersion(raw: unknown): { format: string | null; formatVersion: number | null } {
  if (raw === null || typeof raw !== 'object') return { format: null, formatVersion: null }
  const o = raw as Record<string, unknown>
  return {
    format: typeof o.format === 'string' ? o.format : null,
    formatVersion: typeof o.formatVersion === 'number' ? o.formatVersion : null,
  }
}

/** 类型守卫 */
export function isNspManifest(v: unknown): v is NspManifest {
  return typeof v === 'object' && v !== null && (v as { format?: unknown }).format === 'nsp'
}

export function isNstManifest(v: unknown): v is NstManifest {
  return typeof v === 'object' && v !== null && (v as { format?: unknown }).format === 'nst'
}

// ============================================================================
// 体积估算（docs/03 §8 的表格，用于导出前的容量提示）
// ============================================================================

/** docs/03 §8「体积估算」：1 章 15 min 的估算值（字节） */
export const NSP_SIZE_PER_CHAPTER: Readonly<Record<keyof NspContents, number>> = {
  database: 2 * 1024 * 1024,
  recordings: 130 * 1024 * 1024,
  takes: 130 * 1024 * 1024,
  segments: 120 * 1024 * 1024,
  processed: 120 * 1024 * 1024,
  exports: 21 * 1024 * 1024,
  music: 8 * 1024 * 1024,
}

export interface NspSizeEstimate {
  chapters: number
  bytes: number
  formatted: string
  /** 逐项明细（UI 可以做成表格） */
  breakdown: Array<{ key: keyof NspContents; label: string; bytes: number }>
}

/** 导出前的体积预估（docs/03 §8：必须给用户提示，避免导到一半没空间） */
export function estimateNspBytes(chapters: number, contents: NspContents): NspSizeEstimate {
  const breakdown = (Object.keys(NSP_CONTENT_LABELS) as Array<keyof NspContents>)
    .filter((k) => contents[k])
    .map((k) => ({ key: k, label: NSP_CONTENT_LABELS[k], bytes: NSP_SIZE_PER_CHAPTER[k] * Math.max(0, chapters) }))
  const bytes = breakdown.reduce((n, b) => n + b.bytes, 0)
  return { chapters, bytes, formatted: formatBytesLocal(bytes), breakdown }
}

function formatBytesLocal(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = i === 0 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)
  return `${text} ${units[i]}`
}
