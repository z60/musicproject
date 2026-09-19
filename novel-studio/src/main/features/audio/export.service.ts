/**
 * Novel Studio · 导出服务（`export:*` 8 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §6 导出报告与验收；§6.2 响度验收阈值（`QC_THRESHOLDS`）
 *   · docs/15 §4 导出前预检（QC）：缺录 / 文件丢失 / 同轨重叠 是**阻断项**
 *   · docs/13 §5 对轨校验（复用 `shared/arrange/validate.ts`，不写第二套判定）
 *   · docs/21 §6 `export_jobs`（每章一行记录产物与验收值）
 *
 * ### 本轮实现的范围（如实说明）
 *   已实现：`export:preCheck`（真实预检）、`export:report`（从库里组装报告）、
 *   `export:verify`（对产物做响度验收）、`export:openFolder`、`export:vbrPresets`。
 *   **未实现**：`export:chapter` / `export:book` / `export:m4b` 三个**渲染任务**
 *   —— 它们需要「按混音方案把轨道混成一条音轨」的完整渲染管线（BGM / 闪避 / 母带两遍法），
 *   属于下一轮的工作。这三个通道仍是占位（抛 `NOT_IMPLEMENTED`），不假装能导出。
 *
 * ### 预检为什么必须真的算
 *   「导出到一半才发现第 37 章缺一行」是用户最不能接受的失败方式：他已经等了十几分钟。
 *   预检把四类问题在**点导出之前**列出来，并用 `blockers` / `warnings` 区分
 *   「必须处理」与「知道就行」。
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import { ARRANGE_DEFAULTS, VBR_PRESETS } from '../../../shared/constants.ts'
import type {
  ExportParams,
  ExportReport,
  ExportChapterResult,
  Id,
  QcPreCheckResult,
} from '../../../shared/types.ts'
import { parseLoudnormJson } from '../../../shared/audio/loudness.ts'
import { buildLoudnessMeasureCommand, formatCommandForDisplay, type FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import { validateArrangement, isBlockingIssue } from '../../../shared/arrange/validate.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { ExportJobRepo, ExportJobRow } from './repositories/export-job.repo.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { Logger } from '../../infra/log/index.ts'

export interface ExportServiceDeps {
  getDb: () => DbLike | null
  /** `{userData}/projects` */
  projectRoot: () => string
  repo: () => ExportJobRepo
  ffmpeg: FfmpegRunner
  /** 在文件管理器中定位（Electron shell；测试可传入一个记录调用的假实现） */
  showItemInFolder: (path: string) => void
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface ExportService {
  preCheck(input: {
    bookId: Id
    chapterIds?: readonly Id[]
    mixProjectId: Id | null
    params: ExportParams
  }): Promise<QcPreCheckResult>
  report(jobId: Id): Promise<ExportReport>
  verify(
    jobId: Id,
  ): Promise<{ chapters: Array<{ path: string; measuredLufs: number | null; measuredTp: number | null }> }>
  openFolder(jobId: Id): Promise<{ ok: boolean }>
  vbrPresets(): Promise<Array<{ label: string; value: number }>>
}

/** 章节与画本行的预检输入（一次查出，避免每章一条 SQL） */
interface ChapterForCheck {
  chapterId: Id
  seq: number
  title: string
  lines: Array<{
    lineId: Id
    seq: number
    trackId: string
    hasSegment: boolean
    segmentId: Id | null
    durationMs: number | null
    rmsDb: number | null
    peakDb: number | null
    filePath: string | null
    processedPath: string | null
  }>
}

export function createExportService(deps: ExportServiceDeps): ExportService {
  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'export' } })
    return db
  }

  /** 书 → 项目（音频路径基准） */
  function projectIdOfBook(bookId: Id): Id {
    const row = requireDb().prepare(`SELECT project_id FROM books WHERE id = ?`).get(bookId) as
      | { project_id: string }
      | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'book', bookId } })
    return row.project_id
  }

  /**
   * 一次查出「章节 → 画本行 → 片段」的全貌，供预检使用。
   *
   * 用 LEFT JOIN 而不是 INNER：**缺录的行必须出现在结果里**（它正是预检要报的阻断项）。
   */
  function loadChapters(bookId: Id, chapterIds?: readonly Id[]): ChapterForCheck[] {
    const db = requireDb()
    const marks = chapterIds && chapterIds.length > 0 ? chapterIds.map(() => '?').join(', ') : null
    const sql =
      `SELECT c.id AS chapter_id, c.seq, c.title,
              l.id AS line_id, l.seq AS line_seq, l.speaker_type, l.character_id,
              s.id AS segment_id, s.duration_ms, s.rms_db, s.peak_db, s.file_path, s.processed_path
         FROM chapters c
         LEFT JOIN canvas_lines l ON l.chapter_id = c.id AND l.deleted_at IS NULL
         LEFT JOIN voice_segments s ON s.line_id = l.id
        WHERE c.book_id = ?` +
      (marks ? ` AND c.id IN (${marks})` : '') +
      ` ORDER BY c.seq ASC, l.seq ASC`
    const rows = (
      marks ? db.prepare(sql).all(bookId, ...chapterIds!) : db.prepare(sql).all(bookId)
    ) as Array<{
      chapter_id: string
      seq: number
      title: string
      line_id: string | null
      line_seq: number | null
      speaker_type: string | null
      character_id: string | null
      segment_id: string | null
      duration_ms: number | null
      rms_db: number | null
      peak_db: number | null
      file_path: string | null
      processed_path: string | null
    }>

    const byChapter = new Map<Id, ChapterForCheck>()
    for (const r of rows) {
      let chapter = byChapter.get(r.chapter_id)
      if (!chapter) {
        chapter = { chapterId: r.chapter_id, seq: r.seq, title: r.title, lines: [] }
        byChapter.set(r.chapter_id, chapter)
      }
      if (r.line_id) {
        chapter.lines.push({
          lineId: r.line_id,
          seq: r.line_seq ?? 0,
          trackId: r.speaker_type === 'character' && r.character_id ? r.character_id : 'narration',
          hasSegment: r.segment_id !== null,
          segmentId: r.segment_id,
          durationMs: r.duration_ms,
          rmsDb: r.rms_db,
          peakDb: r.peak_db,
          filePath: r.file_path,
          processedPath: r.processed_path,
        })
      }
    }
    return [...byChapter.values()]
  }

  return {
    async preCheck(input) {
      const chapters = loadChapters(input.bookId, input.chapterIds)
      if (chapters.length === 0) {
        throw new AppError('NOT_FOUND', {
          details: { entity: 'chapter', bookId: input.bookId, hint: '这本书没有章节可导出' },
        })
      }
      const projectId = projectIdOfBook(input.bookId)
      const root = projectAudioRoot(deps.projectRoot(), projectId)
      const blocks: QcPreCheckResult['blockers'] = []
      const warns: QcPreCheckResult['warnings'] = []
      let totalLines = 0
      let recordedLines = 0
      let missingLines = 0
      let totalDurationMs = 0
      let cutCount = 0

      // 混音方案：整批只能用一个（契约如此），它必须属于被导出的某一章
      if (!input.mixProjectId) {
        warns.push({
          kind: 'no_mix_project',
          message: '没有指定混音方案：将按默认母带设置导出（未保存的混音调整不会生效）',
          lineId: null,
          chapterId: null,
        })
      } else {
        const mix = requireDb()
          .prepare(`SELECT chapter_id FROM mix_projects WHERE id = ?`)
          .get(input.mixProjectId) as { chapter_id: string } | undefined
        if (!mix) {
          blocks.push({
            kind: 'mix_project_missing',
            message: '指定的混音方案不存在（可能已被删除）',
            lineId: null,
            chapterId: null,
          })
        }
      }

      for (const chapter of chapters) {
        totalLines += chapter.lines.length
        if (chapter.lines.length === 0) {
          blocks.push({
            kind: 'chapter_empty',
            message: `第 ${chapter.seq} 章「${chapter.title}」还没有画本行（先「生成画本」）`,
            lineId: null,
            chapterId: chapter.chapterId,
          })
          continue
        }

        // 逐行检查：缺录是最常见的阻断项；文件丢失是最贵的（导出到一半才炸）
        for (const line of chapter.lines) {
          if (!line.hasSegment) {
            missingLines++
            blocks.push({
              kind: 'missing_line',
              message: `第 ${chapter.seq} 章第 ${line.seq + 1} 行还没有录音`,
              lineId: line.lineId,
              chapterId: chapter.chapterId,
            })
            continue
          }
          recordedLines++
          totalDurationMs += line.durationMs ?? 0
          const rel = line.processedPath ?? line.filePath ?? ''
          if (!rel) {
            blocks.push({
              kind: 'file_missing',
              message: `第 ${chapter.seq} 章第 ${line.seq + 1} 行的片段没有文件路径`,
              lineId: line.lineId,
              chapterId: chapter.chapterId,
            })
            continue
          }
          // 文件是否真的在盘上：这里只是 `stat`，比等到渲染时才失败便宜得多
          const exists = await stat(join(root, rel)).then(
            () => true,
            () => false,
          )
          if (!exists) {
            blocks.push({
              kind: 'file_missing',
              message: `第 ${chapter.seq} 章第 ${line.seq + 1} 行的音频文件不存在：${rel}`,
              lineId: line.lineId,
              chapterId: chapter.chapterId,
            })
            continue
          }
          if (line.rmsDb !== null && line.rmsDb <= ARRANGE_DEFAULTS.silentRmsDb) {
            warns.push({
              kind: 'silent_segment',
              message: `第 ${chapter.seq} 章第 ${line.seq + 1} 行几乎是静音（${line.rmsDb.toFixed(1)} dBFS）`,
              lineId: line.lineId,
              chapterId: chapter.chapterId,
            })
          }
          if (line.peakDb !== null && line.peakDb >= -0.1) {
            warns.push({
              kind: 'clipped_segment',
              message: `第 ${chapter.seq} 章第 ${line.seq + 1} 行的峰值贴顶（${line.peakDb.toFixed(1)} dBFS），可能削波`,
              lineId: line.lineId,
              chapterId: chapter.chapterId,
            })
          }
          if ((line.durationMs ?? 0) < ARRANGE_DEFAULTS.minSegmentMs) {
            warns.push({
              kind: 'short_segment',
              message: `第 ${chapter.seq} 章第 ${line.seq + 1} 行不足 ${ARRANGE_DEFAULTS.minSegmentMs} ms，可能是误触录音`,
              lineId: line.lineId,
              chapterId: chapter.chapterId,
            })
          }
          // 被切过的片段（对轨里用户拉过边界）计一次「切点」
          if (line.segmentId) cutCount++
        }

        // 同轨重叠：用对轨的校验（唯一口径），只取阻断项
        const arrangement = requireDb()
          .prepare(`SELECT id FROM arrangements WHERE chapter_id = ? AND is_default = 1 LIMIT 1`)
          .get(chapter.chapterId) as { id: string } | undefined
        if (!arrangement) {
          blocks.push({
            kind: 'no_arrangement',
            message: `第 ${chapter.seq} 章「${chapter.title}」还没有对轨方案（先做自动对轨）`,
            lineId: null,
            chapterId: chapter.chapterId,
          })
          continue
        }
        const items = requireDb()
          .prepare(
            `SELECT id, arrangement_id, segment_id, line_id, track_id, timeline_start_ms, src_in_ms,
                    src_out_ms, fade_in_ms, fade_out_ms, locked, order_in_track, overlap_with
               FROM arrangement_items WHERE arrangement_id = ?`,
          )
          .all(arrangement.id) as Array<Record<string, unknown>>
        const validation = validateArrangement({
          items: items.map((r) => ({
            id: String(r['id']),
            arrangementId: String(r['arrangement_id']),
            segmentId: String(r['segment_id']),
            lineId: String(r['line_id']),
            trackId: String(r['track_id']),
            timelineStartMs: Number(r['timeline_start_ms']),
            srcInMs: Number(r['src_in_ms']),
            srcOutMs: Number(r['src_out_ms']),
            fadeInMs: Number(r['fade_in_ms']),
            fadeOutMs: Number(r['fade_out_ms']),
            locked: Number(r['locked']) === 1,
            orderInTrack: Number(r['order_in_track']),
            overlapWith: r['overlap_with'] === null ? null : String(r['overlap_with']),
          })),
          lines: chapter.lines.map((l) => ({
            lineId: l.lineId,
            seq: l.seq,
            trackId: l.trackId,
            chapterId: chapter.chapterId,
            segmentId: l.segmentId,
          })),
          opts: {
            maxCrossTrackOverlapMs: ARRANGE_DEFAULTS.maxCrossTrackOverlapMs,
            maxGapMs: ARRANGE_DEFAULTS.maxGapMs,
            minSegmentMs: ARRANGE_DEFAULTS.minSegmentMs,
            maxSegmentMs: ARRANGE_DEFAULTS.maxSegmentMs,
          },
        })
        for (const issue of validation.issues) {
          if (!isBlockingIssue(issue.kind)) {
            // 警告类（长静音 / 跨轨重叠过大）——报出来但不拦
            warns.push({ kind: issue.kind, message: issue.message, lineId: issue.lineId, chapterId: chapter.chapterId })
            continue
          }
          // 缺录已经逐行报过（更精确到行），这里只报重叠这类「章节级」的阻断项
          if (issue.kind === 'missing_line') continue
          blocks.push({ kind: issue.kind, message: `第 ${chapter.seq} 章：${issue.message}`, lineId: issue.lineId, chapterId: chapter.chapterId })
        }
      }

      const result: QcPreCheckResult = {
        blockers: blocks,
        warnings: warns,
        stats: {
          chapters: chapters.length,
          lines: totalLines,
          recordedLines,
          missingLines,
          totalDurationMs,
          cutCount,
        },
      }
      deps.log?.info?.('export.preChecked', {
        event: 'export.preChecked',
        bookId: input.bookId,
        chapters: chapters.length,
        blockers: blocks.length,
        warnings: warns.length,
        format: input.params.format,
      })
      return result
    },

    async report(jobId) {
      const rows = await deps.repo().listByJob(jobId)
      if (rows.length === 0) {
        throw new AppError('NOT_FOUND', { details: { entity: 'export_job', id: jobId } })
      }
      const batch = rows.find((r) => r.chapterId === null) ?? rows[0]!
      const chapterRows = rows.filter((r) => r.chapterId !== null)
      const db = requireDb()
      const chapters: ExportChapterResult[] = chapterRows.map((row, index) => {
        const meta = db
          .prepare(`SELECT seq, title FROM chapters WHERE id = ?`)
          .get(row.chapterId!) as { seq: number; title: string } | undefined
        const params = parseParams(row.params)
        return {
          // 序号优先取章节自身的 seq（重排后仍然是用户看到的编号）
          chapterIndex: meta?.seq ?? index + 1,
          chapterId: row.chapterId!,
          title: meta?.title ?? '',
          durationMs: row.durationMs ?? 0,
          measuredLufs: row.measuredLufs,
          measuredTpDbfs: row.measuredTpDb,
          targetLufs: params.targetLufs,
          adjustedGainDb: row.adjustedGainDb,
          output: row.outputPath ?? '',
          sizeBytes: row.outputSize,
          skipped: row.status === 'skipped',
          warnings: row.warnings,
        }
      })
      const summary = {
        total: chapters.length,
        succeeded: chapterRows.filter((r) => r.status === 'succeeded').length,
        skipped: chapterRows.filter((r) => r.status === 'skipped').length,
        failed: chapterRows.filter((r) => r.status === 'failed').length,
        warnings: chapterRows.reduce((sum, r) => sum + r.warnings.length, 0),
        // 只累计**有产物**的行：失败章没有产物，把它算进来会让报告的总时长虚高
        totalDurationMs: chapterRows
          .filter((r) => r.status === 'succeeded' || r.status === 'skipped')
          .reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
      }
      const params = parseParams(batch.params)
      const elapsedMs =
        batch.startedAt !== null && batch.finishedAt !== null ? batch.finishedAt - batch.startedAt : 0
      // M4B 的信息只对「整本 + 产出 m4b」的批次有意义：产物路径就是 m4b 本身
      const m4b =
        batch.chapterId === null && batch.outputPath && batch.outputPath.toLowerCase().endsWith('.m4b')
          ? {
              path: batch.outputPath,
              chapters: summary.succeeded,
              sizeBytes: batch.outputSize ?? 0,
              verified: batch.status === 'succeeded',
            }
          : null
      return {
        jobId: batch.id,
        projectId: batch.projectId,
        bookId: batch.bookId,
        mixProjectId: batch.mixProjectId,
        arrangementId: batch.arrangementId,
        startedAt: batch.startedAt ?? batch.createdAt,
        finishedAt: batch.finishedAt,
        elapsedMs,
        params,
        chapters,
        summary,
        m4b,
      } satisfies ExportReport
    },

    async verify(jobId) {
      const rows = await deps.repo().listByJob(jobId)
      if (rows.length === 0) {
        throw new AppError('NOT_FOUND', { details: { entity: 'export_job', id: jobId } })
      }
      const produced = rows.filter((r) => r.chapterId !== null && r.outputPath !== null)
      const chapters: Array<{ path: string; measuredLufs: number | null; measuredTp: number | null }> = []
      for (const row of produced) {
        const params = parseParams(row.params)
        // 用真实的 loudnorm 复测产物：这是验收（docs/15 §6.2），不能拿导出时算的值自我背书
        const command = buildLoudnessMeasureCommand({
          input: row.outputPath!,
          targetLufs: params.targetLufs,
          truePeakDb: params.truePeakDb,
          lra: params.lra,
        })
        let result: Awaited<ReturnType<FfmpegRunner['execute']>>
        try {
          result = await deps.ffmpeg.execute(command, {})
        } catch (e) {
          throw new AppError('EXPORT_FFMPEG_FAILED', {
            cause: e,
            params: { code: 'ENOENT' },
            details: {
              op: 'export:verify',
              reason: 'ffmpeg-not-found',
              command: formatCommandForDisplay(command),
              hint: '验收需要 ffmpeg 的 loudnorm 复测产物（docs/15 §6.2）',
            },
          })
        }
        if (result.exitCode !== 0) {
          throw new AppError('EXPORT_FFMPEG_FAILED', {
            params: { code: String(result.exitCode) },
            details: {
              op: 'export:verify',
              jobId,
              path: row.outputPath,
              stderr: result.stderr.slice(-1000),
            },
          })
        }
        const parsed = parseLoudnormJson(result.stderr)
        if (!parsed) {
          throw new AppError('EXPORT_FFMPEG_FAILED', {
            params: { code: 'PARSE' },
            details: {
              op: 'export:verify',
              reason: 'loudnorm-output-unparsable',
              path: row.outputPath,
              stderr: result.stderr.slice(-500),
            },
          })
        }
        chapters.push({
          path: row.outputPath!,
          measuredLufs: parsed.inputI,
          measuredTp: parsed.inputTp,
        })
        // 把复测值写回该行：报告里显示的就是**验收值**，与导出时的自估值区分开
        await deps.repo().update(row.id, { measuredLufs: parsed.inputI, measuredTpDb: parsed.inputTp })
      }
      deps.log?.info?.('export.verified', {
        event: 'export.verified',
        jobId,
        chapters: chapters.length,
      })
      return { chapters }
    },

    async openFolder(jobId) {
      const job = await deps.repo().get(jobId)
      if (!job) throw new AppError('NOT_FOUND', { details: { entity: 'export_job', id: jobId } })
      if (!job.outputPath) {
        // 没有产物就没有可定位的文件：明确报错，而不是把用户丢到某个目录里自己找
        throw new AppError('NOT_FOUND', {
          details: {
            entity: 'export_output',
            jobId,
            hint: '这次导出还没有产物（可能失败或被跳过）',
          },
        })
      }
      deps.showItemInFolder(job.outputPath)
      deps.log?.info?.('export.folderOpened', { event: 'export.folderOpened', jobId, path: job.outputPath })
      return { ok: true }
    },

    async vbrPresets() {
      // MP3 的 VBR 质量档（`-q:a` 0~9）：值是「质量档」，不是码率
      return VBR_PRESETS.map((p) => ({ label: p.label, value: p.value }))
    },
  }
}

/** 解析任务行里的 params（坏 JSON 不该让整份报告读不出来） */
function parseParams(raw: string): ExportParams {
  try {
    const parsed = JSON.parse(raw) as Partial<ExportParams>
    return {
      format: parsed.format === 'wav' || parsed.format === 'm4a' ? parsed.format : 'mp3',
      mp3Bitrate: parsed.mp3Bitrate ?? 192,
      m4bBitrate: parsed.m4bBitrate ?? 96,
      sampleRate: parsed.sampleRate ?? 44100,
      targetLufs: typeof parsed.targetLufs === 'number' ? parsed.targetLufs : -16,
      truePeakDb: typeof parsed.truePeakDb === 'number' ? parsed.truePeakDb : -1,
      lra: typeof parsed.lra === 'number' ? parsed.lra : 11,
      headSilenceMs: parsed.headSilenceMs ?? 500,
      tailSilenceMs: parsed.tailSilenceMs ?? 1500,
      outputDir: parsed.outputDir ?? '',
      fileNameTemplate: parsed.fileNameTemplate ?? '{chapterIndex:03}_{chapterTitle}',
      metadata: parsed.metadata ?? {},
      overwrite: parsed.overwrite ?? 'skip',
      splitM4bEvery: parsed.splitM4bEvery ?? 0,
    }
  } catch {
    throw new AppError('EXPORT_FFMPEG_FAILED', {
      params: { code: 'PARAMS' },
      details: { op: 'export:report', reason: 'params-not-json' },
    })
  }
}

/** 供任务层复用：整批行与章节行的 id 约定（见 export-job.repo.ts 的说明） */
export function chapterJobId(jobId: Id, chapterIndex: number): Id {
  return `${jobId}#${chapterIndex}`
}

export type { ExportJobRow }
