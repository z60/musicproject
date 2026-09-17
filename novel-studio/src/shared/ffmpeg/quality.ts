/**
 * Novel Studio · 导出质检（渲染前预检 + 渲染后实测）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §6.1 渲染前预检（快速，数据来自库；阻断项 vs 警告项严格分开）
 *   · docs/15 §6.2 渲染后实测质检（可信，来自 ffmpeg 测量）
 *   · docs/05 §10.1 §10.2 同一张表的管线侧表述
 *
 * 「阻断」与「警告」的区别必须严格遵守：
 *   · 阻断（blocker）= 导出了就是错东西（缺录行、说话人未分配、磁盘不足、整章静音、成品不可播放）
 *   · 警告（warning）= 能导出但质量存疑（削波、片段过短、响度偏差、章间不齐）
 *   · 提示（info）    = 需要用户确认（输出文件已存在）
 *
 * 失败语义：本文件不抛异常。预检不通过时由调用方抛
 *           `EXPORT_QCPRECHECK_FAILED`（并在 UI 列出 blockers 让用户确认）。
 */

import { ARRANGE_DEFAULTS, QC_THRESHOLDS } from '../constants.ts'
import type { ExportChapterResult, Id, QcPreCheckResult, SpeakerType } from '../types.ts'

function push<T>(list: T[], item: T): void {
  list.push(item)
}

// ============================================================================
// 渲染前预检（docs/15 §6.1）
// ============================================================================

export interface QcPreCheckLine {
  lineId: Id
  seq: number
  chapterId: Id
  chapterTitle?: string
  speakerType: SpeakerType
  /** 角色行必须有 characterId，否则无法决定用哪条轨（阻断） */
  characterId: Id | null
  /** 是否已有可用片段（processed > segment > take） */
  hasSegment: boolean
  segmentDurationMs?: number
  takeFlags?: string[]
  segmentFlags?: string[]
  rmsDb?: number | null
  peakDb?: number | null
}

export interface QcPreCheckChapter {
  chapterId: Id
  title: string
  durationMs: number
}

export interface QcPreCheckInput {
  lines: QcPreCheckLine[]
  chapters: QcPreCheckChapter[]
  /** 片段有、画本行已删（警告） */
  orphanSegments?: Array<{ segmentId: Id; lineId: Id; chapterId: Id }>
  /** 已存在的输出文件（提示：覆盖 / 跳过 / 改名） */
  existingOutputs?: string[]
  /** 磁盘空间：不足即阻断（混音中间 WAV ≈ 时长 × 288 KB/s，docs/15 §11） */
  disk?: { freeBytes: number; requiredBytes: number }
  /** 全书响度分布（audio_metrics）—— 极端偏差给警告 */
  measuredLufs?: number[]
  targetLufs?: number
  opts?: {
    minSegmentMs?: number
    maxSegmentMs?: number
    /** 章节时长异常阈值 */
    minChapterMs?: number
    maxChapterMs?: number
    /** 全书响度「极端偏差」阈值（LU） */
    extremeLufsDelta?: number
    /** 允许「仅导出已录部分」，此时缺录行降级为警告（docs/15 §6.1） */
    allowPartialExport?: boolean
  }
}

export interface QcPreCheckResultExt extends QcPreCheckResult {
  /** 提示项（不影响导出，但需要用户确认） */
  infos: Array<{ kind: string; message: string; lineId: Id | null; chapterId: Id | null }>
}

/**
 * 渲染前预检（docs/15 §6.1）。
 *
 * 数据全部来自库（不读音频文件），因此必须很快 —— 导出向导第 6 步实时调用。
 *
 * @throws 不抛异常；blockers 非空时调用方抛 `EXPORT_QCPRECHECK_FAILED`
 */
export function preCheck(input: QcPreCheckInput): QcPreCheckResultExt {
  const opts = input.opts ?? {}
  const minSegmentMs = opts.minSegmentMs ?? ARRANGE_DEFAULTS.minSegmentMs
  const maxSegmentMs = opts.maxSegmentMs ?? ARRANGE_DEFAULTS.maxSegmentMs
  const minChapterMs = opts.minChapterMs ?? 10_000
  const maxChapterMs = opts.maxChapterMs ?? 2 * 60 * 60 * 1000
  const extremeLufsDelta = opts.extremeLufsDelta ?? 6
  const targetLufs = input.targetLufs ?? -16

  const blockers: QcPreCheckResultExt['blockers'] = []
  const warnings: QcPreCheckResultExt['warnings'] = []
  const infos: QcPreCheckResultExt['infos'] = []

  let recordedLines = 0
  let missingLines = 0
  let cutCount = 0

  for (const line of input.lines) {
    // 1) 缺录行 —— 阻断（可「仅导出已录部分」时降级为警告）
    if (!line.hasSegment) {
      missingLines++
      const entry = {
        kind: 'missing_lines',
        message: `${line.chapterTitle ? `「${line.chapterTitle}」` : ''}第 ${line.seq} 行还没有录音`,
        lineId: line.lineId,
        chapterId: line.chapterId,
      }
      if (opts.allowPartialExport) push(warnings, entry)
      else push(blockers, entry)
      continue
    }
    recordedLines++

    // 2) 说话人未分配 —— 阻断（不知道用哪条轨，渲染必然出错）
    if (line.speakerType === 'character' && !line.characterId) {
      push(blockers, {
        kind: 'unassigned_speaker',
        message: `${line.chapterTitle ? `「${line.chapterTitle}」` : ''}第 ${line.seq} 行是台词但没有指定角色`,
        lineId: line.lineId,
        chapterId: line.chapterId,
      })
    }

    // 3) take 削波标记 —— 警告（可重录，docs/05 §2.5：> 20 次才打标记）
    const flags = [...(line.takeFlags ?? []), ...(line.segmentFlags ?? [])]
    if (flags.includes('clip')) {
      cutCount++
      push(warnings, {
        kind: 'take_clipped',
        message: `第 ${line.seq} 行存在削波，建议降低输入增益后重录`,
        lineId: line.lineId,
        chapterId: line.chapterId,
      })
    }

    // 4) 片段过短 / 过长 —— 警告
    const duration = line.segmentDurationMs
    if (typeof duration === 'number') {
      if (duration < minSegmentMs) {
        push(warnings, {
          kind: 'segment_too_short',
          message: `第 ${line.seq} 行的片段只有 ${Math.round(duration)} ms（< ${minSegmentMs} ms）`,
          lineId: line.lineId,
          chapterId: line.chapterId,
        })
      } else if (duration > maxSegmentMs) {
        push(warnings, {
          kind: 'segment_too_long',
          message: `第 ${line.seq} 行的片段长达 ${(duration / 1000).toFixed(1)} s（> ${maxSegmentMs / 1000} s）`,
          lineId: line.lineId,
          chapterId: line.chapterId,
        })
      }
    }

    // 5) 片段是静音 —— 警告
    if (typeof line.rmsDb === 'number' && Number.isFinite(line.rmsDb) && line.rmsDb < ARRANGE_DEFAULTS.silentRmsDb) {
      push(warnings, {
        kind: 'segment_silent',
        message: `第 ${line.seq} 行的片段 RMS ${line.rmsDb.toFixed(1)} dBFS，可能录成了静音`,
        lineId: line.lineId,
        chapterId: line.chapterId,
      })
    }
  }

  // 6) 孤儿片段 —— 警告
  for (const orphan of input.orphanSegments ?? []) {
    push(warnings, {
      kind: 'orphan_segment',
      message: '有一个片段对应的画本行已被删除，导出时会跳过',
      lineId: orphan.lineId,
      chapterId: orphan.chapterId,
    })
  }

  // 7) 章节时长异常 —— 警告（可能是对轨错误）
  let totalDurationMs = 0
  for (const ch of input.chapters) {
    totalDurationMs += Math.max(0, ch.durationMs)
    if (ch.durationMs < minChapterMs) {
      push(warnings, {
        kind: 'chapter_too_short',
        message: `「${ch.title}」只有 ${(ch.durationMs / 1000).toFixed(1)} s，可能是对轨错误或漏录`,
        lineId: null,
        chapterId: ch.chapterId,
      })
    } else if (ch.durationMs > maxChapterMs) {
      push(warnings, {
        kind: 'chapter_too_long',
        message: `「${ch.title}」长达 ${(ch.durationMs / 3600_000).toFixed(1)} h，请确认章节切分是否正确`,
        lineId: null,
        chapterId: ch.chapterId,
      })
    }
  }

  // 8) 磁盘空间不足 —— 阻断（预估：混音中间 WAV ≈ 时长 × 288 KB/s）
  if (input.disk && input.disk.freeBytes < input.disk.requiredBytes) {
    push(blockers, {
      kind: 'disk_full',
      message: `可用空间不足：需要约 ${formatMb(input.disk.requiredBytes)}，当前可用 ${formatMb(input.disk.freeBytes)}`,
      lineId: null,
      chapterId: null,
    })
  }

  // 9) 全书响度分布极端偏差 —— 警告
  const lufs = (input.measuredLufs ?? []).filter(v => Number.isFinite(v))
  if (lufs.length > 1) {
    for (const v of lufs) {
      if (Math.abs(v - targetLufs) > extremeLufsDelta) {
        push(warnings, {
          kind: 'loudness_outlier',
          message: `有已测量章节的响度 ${v.toFixed(1)} LUFS 与目标 ${targetLufs} LUFS 相差超过 ${extremeLufsDelta} LU`,
          lineId: null,
          chapterId: null,
        })
        break // 只报一次，避免几十条重复
      }
    }
  }

  // 10) 输出文件已存在 —— 提示（覆盖 / 跳过 / 改名）
  for (const path of input.existingOutputs ?? []) {
    push(infos, {
      kind: 'output_exists',
      message: `输出文件已存在：${path}（将按覆盖策略处理）`,
      lineId: null,
      chapterId: null,
    })
  }

  return {
    blockers,
    warnings,
    infos,
    stats: {
      chapters: input.chapters.length,
      lines: input.lines.length,
      recordedLines,
      missingLines,
      totalDurationMs,
      cutCount,
    },
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

// ============================================================================
// 渲染后实测质检（docs/15 §6.2）
// ============================================================================

export type PostCheckSeverity = 'blocker' | 'warning' | 'info'

export interface PostCheckIssue {
  kind: string
  message: string
  severity: PostCheckSeverity
}

export interface PostCheckInput {
  chapterIndex?: number
  title?: string
  /** 时间线预期时长（computeChapterDuration 的结果） */
  expectedDurationMs: number
  /** 成品实测时长（ffprobe） */
  actualDurationMs: number
  measuredLufs: number | null
  targetLufs: number
  measuredTpDbfs?: number | null
  targetTpDbfs?: number
  /** 整章 RMS（astats） */
  rmsDb?: number | null
  /** 扫描到的静音段（非头尾的才算异常） */
  longSilences?: Array<{ startMs: number; endMs: number }>
  headSilenceMs?: number
  tailSilenceMs?: number
  /** 连续削波样本数（astats Flat factor / peak） */
  clippedSamples?: number
  /** 成品能否被 ffprobe 正确读出（false = 阻断该章） */
  playable?: boolean
  /** 章间响度差（全书视角传入；单章可省略） */
  chapterLufsSpread?: number
  opts?: {
    lufsTolerance?: number
    truePeakToleranceDb?: number
    spreadTolerance?: number
    /** 异常长静音阈值（秒），默认 10 */
    longSilenceSec?: number
    durationToleranceMs?: number
    silentRmsDb?: number
  }
}

/**
 * 渲染后实测质检（docs/15 §6.2）。
 *
 * @throws 不抛异常；`passed=false` 表示存在阻断项，该章应标记失败
 *         （错误码 `EXPORT_SILENT_CHAPTER` / `EXPORT_FFMPEG_FAILED`）
 */
export function postCheck(input: PostCheckInput): { passed: boolean; issues: PostCheckIssue[] } {
  const opts = input.opts ?? {}
  const lufsTolerance = opts.lufsTolerance ?? QC_THRESHOLDS.lufsTolerance
  const tpTolerance = opts.truePeakToleranceDb ?? 0.05
  const spreadTolerance = opts.spreadTolerance ?? QC_THRESHOLDS.chapterLufsSpread
  const longSilenceMs = (opts.longSilenceSec ?? QC_THRESHOLDS.longSilenceSec) * 1000
  const durationToleranceMs = opts.durationToleranceMs ?? QC_THRESHOLDS.durationToleranceMs
  const silentRmsDb = opts.silentRmsDb ?? QC_THRESHOLDS.silentRmsDb
  const label = input.title ?? (input.chapterIndex !== undefined ? `第 ${input.chapterIndex} 章` : '本章')

  const issues: PostCheckIssue[] = []

  // 1) 可播放性 —— 阻断
  if (input.playable === false) {
    push(issues, {
      kind: 'not_playable',
      message: `${label}的成品无法被解析（ffprobe 读不出时长/编码），该章标记失败`,
      severity: 'blocker',
    })
  }

  // 2) 整章静音 —— 阻断（渲染失败的典型表现）
  if (typeof input.rmsDb === 'number' && Number.isFinite(input.rmsDb) && input.rmsDb < silentRmsDb) {
    push(issues, {
      kind: 'silent_chapter',
      message: `${label}整章 RMS ${input.rmsDb.toFixed(1)} dBFS（< ${silentRmsDb} dBFS），说明渲染失败，请检查对轨与素材`,
      severity: 'blocker',
    })
  } else if (input.measuredLufs === null) {
    push(issues, {
      kind: 'loudness_unmeasurable',
      message: `${label}的响度无法测量（多半是整章静音或时长过短），请人工确认`,
      severity: 'blocker',
    })
  }

  // 3) 目标响度偏差 —— 警告（超阈值应先自动微调一次，仍超才提示）
  if (typeof input.measuredLufs === 'number' && Number.isFinite(input.measuredLufs)) {
    const delta = input.measuredLufs - input.targetLufs
    if (Math.abs(delta) > lufsTolerance + 1e-9) {
      push(issues, {
        kind: 'loudness_deviation',
        message: `${label}实测响度 ${input.measuredLufs.toFixed(2)} LUFS，与目标 ${input.targetLufs} LUFS 相差 ${delta.toFixed(2)} LU（容差 ±${lufsTolerance}）`,
        severity: 'warning',
      })
    }
  }

  // 4) 真峰 —— 警告（超过则再降 0.5 dB 重渲一次）
  if (typeof input.measuredTpDbfs === 'number' && Number.isFinite(input.measuredTpDbfs)) {
    const target = input.targetTpDbfs ?? -1
    if (input.measuredTpDbfs > target + tpTolerance) {
      push(issues, {
        kind: 'true_peak_exceeded',
        message: `${label}真峰 ${input.measuredTpDbfs.toFixed(2)} dBTP 超过目标 ${target} dBTP，建议再降 ${(input.measuredTpDbfs - target + 0.5).toFixed(1)} dB 重渲`,
        severity: 'warning',
      })
    }
  }

  // 5) 章间响度差 —— 警告（超出听众会觉得「这章响那章轻」）
  if (typeof input.chapterLufsSpread === 'number' && Number.isFinite(input.chapterLufsSpread)) {
    if (input.chapterLufsSpread > spreadTolerance + 1e-9) {
      push(issues, {
        kind: 'chapter_lufs_spread',
        message: `章间响度差 ${input.chapterLufsSpread.toFixed(2)} LU 超过 ${spreadTolerance} LU，整本听感不齐`,
        severity: 'warning',
      })
    }
  }

  // 6) 时长一致性 —— 警告（可能有片段丢失）
  if (input.expectedDurationMs > 0 && input.actualDurationMs > 0) {
    const diff = Math.abs(input.actualDurationMs - input.expectedDurationMs)
    if (diff > durationToleranceMs) {
      push(issues, {
        kind: 'duration_mismatch',
        message:
          `${label}成品时长 ${(input.actualDurationMs / 1000).toFixed(2)} s 与时间线预期 ` +
          `${(input.expectedDurationMs / 1000).toFixed(2)} s 相差 ${diff} ms（> ${durationToleranceMs} ms），可能有片段丢失`,
        severity: 'warning',
      })
    }
  }

  // 7) 异常长静音 —— 警告（非章头章尾）
  const head = input.headSilenceMs ?? 0
  const tail = input.tailSilenceMs ?? 0
  for (const silence of input.longSilences ?? []) {
    const len = silence.endMs - silence.startMs
    const isHead = silence.startMs <= head + 50
    const isTail = input.actualDurationMs > 0 && silence.endMs >= input.actualDurationMs - tail - 50
    if (len > longSilenceMs && !isHead && !isTail) {
      push(issues, {
        kind: 'long_silence',
        message: `${label}在 ${(silence.startMs / 1000).toFixed(1)} s 处有 ${(len / 1000).toFixed(1)} s 的异常静音（非章头章尾），可能漏录了一行`,
        severity: 'warning',
      })
    }
  }

  // 8) 削波 —— 警告
  if (typeof input.clippedSamples === 'number' && input.clippedSamples > 0) {
    push(issues, {
      kind: 'clipping',
      message: `${label}检出 ${input.clippedSamples} 处连续削波，建议降低目标响度或减小增益`,
      severity: 'warning',
    })
  }

  return { passed: !issues.some(i => i.severity === 'blocker'), issues }
}

/**
 * 章间响度差（docs/15 §6.2：≤ 1.5 LU）。
 *
 * 跳过 `skipped` 与响度缺失（null/NaN）的章节 —— 它们不参与极差计算。
 *
 * @throws 不抛异常；有效章数 < 2 时 return {spread: 0, ok: true}
 */
export function computeChapterLufsSpread(results: ExportChapterResult[]): {
  spread: number
  ok: boolean
  measured: number
  min: number | null
  max: number | null
} {
  const values = results
    .filter(r => !r.skipped)
    .map(r => r.measuredLufs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (values.length < 2) {
    return { spread: 0, ok: true, measured: values.length, min: values[0] ?? null, max: values[0] ?? null }
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spread = max - min
  return { spread, ok: spread <= QC_THRESHOLDS.chapterLufsSpread + 1e-9, measured: values.length, min, max }
}

/**
 * 汇总导出报告（docs/05 §10.3 / docs/15 §6.3）的 summary 段。
 *
 * @throws 不抛异常
 */
export function summarizeExportReport(chapters: ExportChapterResult[]): {
  total: number
  succeeded: number
  skipped: number
  failed: number
  warnings: number
  totalDurationMs: number
} {
  let succeeded = 0
  let skipped = 0
  let failed = 0
  let warnings = 0
  let totalDurationMs = 0
  for (const ch of chapters) {
    if (ch.skipped) skipped++
    else if (ch.output) succeeded++
    else failed++
    warnings += ch.warnings.length
    totalDurationMs += Math.max(0, ch.durationMs)
  }
  return { total: chapters.length, succeeded, skipped, failed, warnings, totalDurationMs }
}
