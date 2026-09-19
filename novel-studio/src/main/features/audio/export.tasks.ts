/**
 * Novel Studio · 导出渲染任务（`export:chapter` / `export:book` / `export:m4b`）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §3   渲染管线：片段 → 轨道 → 总线 → 母带（本文件做前两段与母带响度）
 *   · docs/15 §5.1 响度两遍法（先测量，再用测得值施加增益 + 限幅）
 *   · docs/15 §5.2 M4B（`ffmetadata` 章节 + `-map_chapters 1`）
 *   · docs/15 §5.3 文件命名模板与覆盖策略（skip / overwrite / rename）
 *   · docs/04 §2.2 并发键 `ffmpeg`
 *
 * ### 本轮的实现边界（**必须**如实说明，见 docs/91 §5.2.25）
 *   已实现：人声总线渲染（`buildMixFilterGraph`）→ loudnorm 两遍法 → 按参数编码 →
 *   写 `export_jobs` 行（批量行 + 章节行）→ 可选合并 M4B。
 *   **未接入**：混音方案里的 **BGM / 音效轨与闪避（ducking）**。
 *   遇到「方案里配了音乐/音效轨」时**明确拒绝导出**而不是静默丢掉它们 ——
 *   用户配了 BGM 却导出一版没音乐的成品，比导出失败更难发现。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import type { ExportParams, Id, MixProject, TaskKind } from '../../../shared/types.ts'
import { AUDIO_DEFAULTS } from '../../../shared/constants.ts'
import { fnv1a64Hex } from '../../../shared/audio/process.ts'
import { parseLoudnormJson, computeGainDb } from '../../../shared/audio/loudness.ts'
import { buildMixFilterGraph, type MixItemInput } from '../../../shared/ffmpeg/filters.ts'
import {
  buildChapterExportCommand,
  buildLoudnessApplyCommand,
  buildLoudnessMeasureCommand,
  buildM4bCommand,
  buildMixRenderCommand,
  formatCommandForDisplay,
  generateConcatList,
  generateFfmetadata,
  type FfmpegRunner,
} from '../../../shared/ffmpeg/commands.ts'
import { projectAudioRoot } from './audio-root.ts'
import { chapterJobId } from './export.service.ts'
import type { ExportJobRepo } from './repositories/export-job.repo.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { Logger } from '../../infra/log/index.ts'
import type { TaskQueue } from '../../infra/queue/queue.ts'
import type { TaskContext, TaskSpec } from '../../infra/queue/types.ts'

export interface ExportTaskPayload {
  bookId: Id
  /** 显式章节（空 = 整本） */
  chapterIds?: Id[]
  mixProjectId: Id | null
  params: ExportParams
  /** 整本导出时是否顺带产出 M4B */
  makeM4b: boolean
  /** 只产出 M4B（`export:m4b`）：跳过逐章编码，直接用已有产物列表 */
  m4bOnly?: boolean
}

export interface ExportTaskResult {
  jobId: Id
  bookId: Id
  chapters: Array<{ chapterId: Id; output: string; status: string }>
  m4bPath: string | null
  failed: number
  skipped: number
}

/** 导出参数的指纹（幂等与断点续传依据，docs/21 §6 的 `params_hash`） */
export function paramsHashOf(params: ExportParams): string {
  return fnv1a64Hex(JSON.stringify(normalizeParams(params)))
}

/**
 * 只取影响**产物内容**的字段：`outputDir` 与 `overwrite` 不参与指纹 ——
 * 否则「换个导出目录」会被当成「参数变了」而整本重跑。
 */
function normalizeParams(params: ExportParams): Record<string, unknown> {
  return {
    format: params.format,
    mp3Bitrate: params.mp3Bitrate,
    m4bBitrate: params.m4bBitrate,
    targetLufs: params.targetLufs,
    sampleRate: params.sampleRate,
    truePeakDb: params.truePeakDb,
    lra: params.lra,
    headSilenceMs: params.headSilenceMs,
    tailSilenceMs: params.tailSilenceMs,
    fileNameTemplate: params.fileNameTemplate,
    metadata: params.metadata,
    splitM4bEvery: params.splitM4bEvery,
  }
}

/**
 * 文件命名模板：`{chapterIndex:03}_{chapterTitle}`。
 *
 * 标题里的 `\ / : * ? " < > |` 一律替换成 `_`：这些字符在 Windows 上会让**创建文件直接失败**，
 * 而失败发生在「这一章已经渲染完之后」，代价很高。
 */
export function renderFileName(template: string, vars: { chapterIndex: number; chapterTitle: string }): string {
  const safeTitle = vars.chapterTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
  return template
    .replace(/\{chapterIndex:(\d+)\}/g, (_m, width: string) => String(vars.chapterIndex).padStart(Number(width), '0'))
    .replace(/\{chapterIndex\}/g, String(vars.chapterIndex))
    .replace(/\{chapterTitle\}/g, safeTitle)
}

export interface ExportTasksDeps {
  getDb: () => DbLike | null
  queue?: TaskQueue
  ffmpeg: FfmpegRunner
  projectRoot: () => string
  repo: () => ExportJobRepo
  log: Logger
}

export interface ExportTasks {
  enqueueChapter(chapterIds: readonly Id[], mixProjectId: Id | null, params: ExportParams): Promise<{ taskId: Id }>
  enqueueBook(bookId: Id, mixProjectId: Id | null, params: ExportParams, makeM4b: boolean): Promise<{ taskId: Id }>
  enqueueM4b(bookId: Id, chapterIds: readonly Id[], params: ExportParams): Promise<{ taskId: Id }>
  taskSpecs(): Array<TaskSpec<unknown, unknown>>
  runNow(payload: ExportTaskPayload, ctx: TaskContext): Promise<ExportTaskResult>
}

interface ChapterRow {
  chapterId: Id
  seq: number
  title: string
  arrangementId: Id | null
  mixProjectId: Id | null
}

export function createExportTasks(deps: ExportTasksDeps): ExportTasks {
  const log = deps.log
  const newJobId = (): Id => `job_${globalThis.crypto.randomUUID()}`

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'export' } })
    return db
  }
  /** 章节 + 它当前的对轨方案与混音方案 */
  function loadChapters(payload: ExportTaskPayload): ChapterRow[] {
    const db = requireDb()
    const marks = payload.chapterIds && payload.chapterIds.length > 0 ? payload.chapterIds.map(() => '?').join(', ') : null
    const sql =
      `SELECT c.id AS chapter_id, c.seq, c.title,
              (SELECT id FROM arrangements a WHERE a.chapter_id = c.id AND a.is_default = 1 LIMIT 1) AS arrangement_id
         FROM chapters c WHERE c.book_id = ?` +
      (marks ? ` AND c.id IN (${marks})` : '') +
      ` ORDER BY c.seq ASC`
    const rows = (
      marks ? db.prepare(sql).all(payload.bookId, ...payload.chapterIds!) : db.prepare(sql).all(payload.bookId)
    ) as Array<{ chapter_id: string; seq: number; title: string; arrangement_id: string | null }>
    return rows.map((r) => ({
      chapterId: r.chapter_id,
      seq: r.seq,
      title: r.title,
      arrangementId: r.arrangement_id,
      mixProjectId: payload.mixProjectId,
    }))
  }

  /** 混音方案：整批只能一个，且必须属于被导出的某一章 */
  function loadMixProject(mixProjectId: Id | null): MixProject | null {
    if (!mixProjectId) return null
    const db = requireDb()
    const row = db.prepare(`SELECT chapter_id, tracks FROM mix_projects WHERE id = ?`).get(mixProjectId) as
      | { chapter_id: string; tracks: string }
      | undefined
    if (!row) {
      throw new AppError('NOT_FOUND', { details: { entity: 'mix_project', id: mixProjectId } })
    }
    let tracks: MixProject['tracks'] = []
    try {
      tracks = JSON.parse(row.tracks) as MixProject['tracks']
    } catch {
      tracks = []
    }
    return { id: mixProjectId, chapterId: row.chapter_id, tracks } as MixProject
  }

  /**
   * 本轮的边界检查：混音方案里有音乐/音效轨时**明确拒绝**。
   *
   * 为什么不「跳过它们继续导」：用户配了 BGM，导出成品里却没有音乐 ——
   * 这种错误用户要听完一整章才发现，而且会以为是「素材没导入成功」。
   */
  function assertNoMusicTracks(project: MixProject | null): void {
    if (!project) return
    const withAsset = project.tracks.filter(
      (t) => (t.kind === 'music' || t.kind === 'sfx') && (t.music?.assetId ?? '') !== '',
    )
    if (withAsset.length > 0) {
      throw new AppError('NOT_IMPLEMENTED', {
        params: { feature: '导出中的 BGM / 音效轨' },
        details: {
          op: 'export',
          reason: 'music-tracks-not-mixed-yet',
          tracks: withAsset.map((t) => t.name),
          hint: '当前渲染管线只混人声总线；请先把这些轨的素材清空，或等待混音总线接入（docs/91 §5.2.25）',
        },
      })
    }
  }

  /** 一章的渲染输入（时间线 → 片段文件） */
  function loadItems(arrangementId: Id): { items: MixItemInput[]; paths: string[]; durationMs: number } {
    const db = requireDb()
    const rows = db
      .prepare(
        `SELECT i.segment_id, i.src_in_ms, i.src_out_ms, i.timeline_start_ms, i.fade_in_ms, i.fade_out_ms,
                s.file_path, s.processed_path
           FROM arrangement_items i
           JOIN voice_segments s ON s.id = i.segment_id
          WHERE i.arrangement_id = ?
          ORDER BY i.timeline_start_ms ASC, i.order_in_track ASC`,
      )
      .all(arrangementId) as Array<{
      segment_id: string
      src_in_ms: number
      src_out_ms: number
      timeline_start_ms: number
      fade_in_ms: number
      fade_out_ms: number
      file_path: string
      processed_path: string | null
    }>
    const items: MixItemInput[] = []
    const paths: string[] = []
    let end = 0
    rows.forEach((r, index) => {
      items.push({
        inputIndex: index,
        srcInMs: r.src_in_ms,
        srcOutMs: r.src_out_ms,
        timelineStartMs: r.timeline_start_ms,
        fadeInMs: r.fade_in_ms,
        fadeOutMs: r.fade_out_ms,
        gainDb: 0,
      })
      // 处理过的文件优先（与预览、验收同一份输入）
      paths.push(r.processed_path ?? r.file_path)
      end = Math.max(end, r.timeline_start_ms + (r.src_out_ms - r.src_in_ms) + r.fade_in_ms + r.fade_out_ms)
    })
    return { items, paths, durationMs: end }
  }

  async function ffmpegRun(
    command: string[],
    ctx: TaskContext,
    op: string,
  ): Promise<{ command: string[]; elapsedMs: number }> {
    let result: Awaited<ReturnType<FfmpegRunner['execute']>>
    try {
      result = await deps.ffmpeg.execute(command, { signal: ctx.signal, cwd: ctx.tempDir })
    } catch (e) {
      throw new AppError('EXPORT_FFMPEG_FAILED', {
        cause: e,
        params: { code: 'ENOENT' },
        details: {
          op,
          reason: 'ffmpeg-not-found',
          command: formatCommandForDisplay(command),
          hint: '未找到 ffmpeg：请在设置里指定路径（docs/02 §5）',
        },
      })
    }
    if (result.exitCode !== 0) {
      throw new AppError('EXPORT_FFMPEG_FAILED', {
        params: { code: String(result.exitCode) },
        details: {
          op,
          exitCode: result.exitCode,
          command: formatCommandForDisplay(result.command),
          stderr: result.stderr.slice(-2000),
        },
      })
    }
    return { command: result.command, elapsedMs: result.elapsedMs }
  }

  async function runExport(payload: ExportTaskPayload, ctx: TaskContext): Promise<ExportTaskResult> {
    const db = requireDb()
    const repo = deps.repo()
    const params = payload.params
    const hash = paramsHashOf(params)
    const jobId = ctx.taskId || newJobId()

    const book = db.prepare(`SELECT project_id, title FROM books WHERE id = ?`).get(payload.bookId) as
      | { project_id: string; title: string }
      | undefined
    if (!book) throw new AppError('NOT_FOUND', { details: { entity: 'book', bookId: payload.bookId } })
    const projectId = book.project_id
    const root = projectAudioRoot(deps.projectRoot(), projectId)
    const mixProject = loadMixProject(payload.mixProjectId)
    // 边界：BGM/音效轨未接入渲染管线（见文件头）
    assertNoMusicTracks(mixProject)

    const chapters = loadChapters(payload)
    if (chapters.length === 0) {
      throw new AppError('NOT_FOUND', {
        details: { entity: 'chapter', bookId: payload.bookId, hint: '这本书没有可导出的章节' },
      })
    }

    // 批量行（chapter_id IS NULL）：报告与「上次导出」都读它
    const batchCreatedAt = Date.now()
    await repo.insert({
      id: jobId,
      projectId,
      bookId: payload.bookId,
      chapterId: null,
      mixProjectId: payload.mixProjectId,
      arrangementId: chapters[0]!.arrangementId,
      params: JSON.stringify(params),
      paramsHash: hash,
      outputPath: null,
      outputSize: null,
      measuredLufs: null,
      measuredTpDb: null,
      adjustedGainDb: null,
      durationMs: null,
      status: 'running',
      error: null,
      warnings: [],
      startedAt: batchCreatedAt,
      finishedAt: null,
      createdAt: batchCreatedAt,
    })

    const results: ExportTaskResult['chapters'] = []
    let failed = 0
    let skipped = 0
    let m4bPath: string | null = null
    const batchWarnings: string[] = []
    const chapterOutputs: string[] = []
    /** 每章渲染出来的真实时长（M4B 章节时间戳要用它） */
    const chapterDurations = new Map<Id, number>()

    for (const [index, chapter] of chapters.entries()) {
      if (ctx.isAborted()) {
        batchWarnings.push(`已取消：完成 ${results.length}/${chapters.length} 章（已完成的结果保留）`)
        break
      }
      ctx.report(index / chapters.length, `导出 ${chapter.title}`)
      const rowId = chapterJobId(jobId, chapter.seq)
      const startedAt = Date.now()
      const warnings: string[] = []

      if (!chapter.arrangementId) {
        failed++
        await repo.insert({
          id: rowId,
          projectId,
          bookId: payload.bookId,
          chapterId: chapter.chapterId,
          mixProjectId: payload.mixProjectId,
          arrangementId: null,
          params: JSON.stringify(params),
          paramsHash: hash,
          outputPath: null,
          outputSize: null,
          measuredLufs: null,
          measuredTpDb: null,
          adjustedGainDb: null,
          durationMs: null,
          status: 'failed',
          error: JSON.stringify({ key: 'MIX_ARRANGEMENT_EMPTY', message: '该章还没有对轨方案' }),
          warnings: ['没有对轨方案：先做自动对轨再导出'],
          startedAt,
          finishedAt: Date.now(),
          createdAt: startedAt,
        })
        results.push({ chapterId: chapter.chapterId, output: '', status: 'failed' })
        continue
      }

      // 输出路径（命名模板 + 覆盖策略）
      const fileName = `${renderFileName(params.fileNameTemplate, {
        chapterIndex: chapter.seq,
        chapterTitle: chapter.title,
      })}.${params.format}`
      const relativeOut = join(params.outputDir, fileName)
      const chapterRelDir = params.metadata.title ? join(params.outputDir, params.metadata.title) : params.outputDir
      const outPath = join(chapterRelDir, fileName)

      // 幂等：同章 + 同参数指纹 + 已有产物 + overwrite=skip → 跳过
      if (params.overwrite === 'skip') {
        const done = await repo.findSucceeded(chapter.chapterId, hash)
        if (done?.outputPath) {
          const exists = await stat(done.outputPath).then(
            () => true,
            () => false,
          )
          if (exists) {
            skipped++
            results.push({ chapterId: chapter.chapterId, output: done.outputPath, status: 'skipped' })
            chapterOutputs.push(done.outputPath)
            log.info('export.chapterSkipped', {
              event: 'export.chapterSkipped',
              jobId,
              chapterId: chapter.chapterId,
              output: done.outputPath,
            })
            continue
          }
        }
      }

      try {
        // ① 渲染人声总线到中间 WAV（cache/tmp/{taskId}/）
        const { items, paths, durationMs } = loadItems(chapter.arrangementId)
        chapterDurations.set(chapter.chapterId, durationMs)
        if (items.length === 0) {
          throw new AppError('MIX_ARRANGEMENT_EMPTY', {
            details: { op: 'export', chapterId: chapter.chapterId, arrangementId: chapter.arrangementId },
          })
        }
        const renderDir = join(root, 'cache', 'tmp', `export-${jobId}`)
        await mkdir(renderDir, { recursive: true })
        const renderedRel = `cache/tmp/export-${jobId}/${chapter.seq}.wav`
        const renderedAbs = join(root, renderedRel)
        const graph = buildMixFilterGraph({
          items,
          chapterDurationMs: durationMs,
          headSilenceMs: params.headSilenceMs,
          outputLabel: 'voice',
        })
        await ffmpegRun(
          buildMixRenderCommand({
            inputs: paths.map((p) => join(root, p)),
            filterGraph: graph,
            outputLabel: 'voice',
            output: renderedAbs,
            sampleRate: params.sampleRate,
            channels: AUDIO_DEFAULTS.channels,
          }),
          ctx,
          'export:render',
        )

        // ② 响度两遍法：先测（pass1），再用测得值施加增益 + 限幅
        const measure = await deps.ffmpeg
          .execute(
            buildLoudnessMeasureCommand({
              input: renderedAbs,
              targetLufs: params.targetLufs,
              truePeakDb: params.truePeakDb,
              lra: params.lra,
            }),
            { signal: ctx.signal },
          )
          .catch((e: unknown) => {
            throw new AppError('EXPORT_FFMPEG_FAILED', {
              cause: e,
              params: { code: 'ENOENT' },
              details: { op: 'export:measure', reason: 'ffmpeg-not-found' },
            })
          })
        if (measure.exitCode !== 0) {
          throw new AppError('EXPORT_FFMPEG_FAILED', {
            params: { code: String(measure.exitCode) },
            details: {
              op: 'export:measure',
              chapterId: chapter.chapterId,
              stderr: measure.stderr.slice(-1500),
              command: formatCommandForDisplay(measure.command),
            },
          })
        }
        const measured = parseLoudnormJson(measure.stderr)
        if (!measured) {
          throw new AppError('EXPORT_FFMPEG_FAILED', {
            params: { code: 'PARSE' },
            details: {
              op: 'export:measure',
              reason: 'loudnorm-output-unparsable',
              chapterId: chapter.chapterId,
              stderr: measure.stderr.slice(-800),
            },
          })
        }
        const gainDb = computeGainDb(measured.inputI, params.targetLufs)
        const appliedRel = `cache/tmp/export-${jobId}/${chapter.seq}-loudness.wav`
        const appliedAbs = join(root, appliedRel)
        await ffmpegRun(
          buildLoudnessApplyCommand({
            input: renderedAbs,
            output: appliedAbs,
            gainDb,
            truePeakDb: params.truePeakDb,
          }),
          ctx,
          'export:loudness',
        )

        // ③ 编码落盘
        await mkdir(dirname(outPath), { recursive: true })
        if (params.overwrite === 'rename') {
          // 「重命名」策略：同目录已有同名文件时加序号（不覆盖用户已有产物）
          let candidate = outPath
          let n = 1
          while (await stat(candidate).then(() => true, () => false)) {
            candidate = outPath.replace(/(\.[^.]+)$/, ` (${n++})$1`)
          }
          warnings.push('按「重命名」策略避开了同名文件')
          await ffmpegRun(
            buildChapterExportCommand({
              input: appliedAbs,
              output: candidate,
              format: params.format,
              mp3Bitrate: params.mp3Bitrate,
              m4aBitrate: params.m4bBitrate,
              sampleRate: params.sampleRate,
              channels: AUDIO_DEFAULTS.channels,
              metadata: {
                ...params.metadata,
                title: params.metadata.title ?? chapter.title,
              },
            }),
            ctx,
            'export:encode',
          )
          chapterOutputs.push(candidate)
          const size = await stat(candidate).then((s) => s.size, () => null)
          await repo.insert({
            id: rowId,
            projectId,
            bookId: payload.bookId,
            chapterId: chapter.chapterId,
            mixProjectId: payload.mixProjectId,
            arrangementId: chapter.arrangementId,
            params: JSON.stringify(params),
            paramsHash: hash,
            outputPath: candidate,
            outputSize: size,
            measuredLufs: measured.inputI,
            measuredTpDb: measured.inputTp,
            adjustedGainDb: gainDb,
            durationMs,
            status: 'succeeded',
            error: null,
            warnings,
            startedAt,
            finishedAt: Date.now(),
            createdAt: startedAt,
          })
          results.push({ chapterId: chapter.chapterId, output: candidate, status: 'succeeded' })
          continue
        }

        await ffmpegRun(
          buildChapterExportCommand({
            input: appliedAbs,
            output: outPath,
            format: params.format,
            mp3Bitrate: params.mp3Bitrate,
            m4aBitrate: params.m4bBitrate,
            sampleRate: params.sampleRate,
            channels: AUDIO_DEFAULTS.channels,
            metadata: { ...params.metadata, title: params.metadata.title ?? chapter.title },
          }),
          ctx,
          'export:encode',
        )
        const size = await stat(outPath).then((s) => s.size, () => null)
        if (params.overwrite === 'overwrite') warnings.push('按「覆盖」策略改写了同名文件')
        await repo.insert({
          id: rowId,
          projectId,
          bookId: payload.bookId,
          chapterId: chapter.chapterId,
          mixProjectId: payload.mixProjectId,
          arrangementId: chapter.arrangementId,
          params: JSON.stringify(params),
          paramsHash: hash,
          outputPath: outPath,
          outputSize: size,
          measuredLufs: measured.inputI,
          measuredTpDb: measured.inputTp,
          adjustedGainDb: gainDb,
          durationMs,
          status: 'succeeded',
          error: null,
          warnings,
          startedAt,
          finishedAt: Date.now(),
          createdAt: startedAt,
        })
        chapterOutputs.push(outPath)
        results.push({ chapterId: chapter.chapterId, output: outPath, status: 'succeeded' })
        log.info('export.chapterDone', {
          event: 'export.chapterDone',
          jobId,
          chapterId: chapter.chapterId,
          output: outPath,
          durationMs,
          measuredLufs: measured.inputI,
          gainDb,
          sizeBytes: size,
          relativeOut,
        })
      } catch (e) {
        // 失败隔离：一章失败不影响其它章（docs/14 §7.1 的同一原则）
        failed++
        const key = e instanceof AppError ? e.key : 'INTERNAL'
        const message = e instanceof Error ? e.message : String(e)
        await repo.insert({
          id: rowId,
          projectId,
          bookId: payload.bookId,
          chapterId: chapter.chapterId,
          mixProjectId: payload.mixProjectId,
          arrangementId: chapter.arrangementId,
          params: JSON.stringify(params),
          paramsHash: hash,
          outputPath: null,
          outputSize: null,
          measuredLufs: null,
          measuredTpDb: null,
          adjustedGainDb: null,
          durationMs: null,
          status: 'failed',
          error: JSON.stringify({ key, message, details: e instanceof AppError ? e.details : null }),
          warnings: [message],
          startedAt,
          finishedAt: Date.now(),
          createdAt: startedAt,
        })
        results.push({ chapterId: chapter.chapterId, output: '', status: 'failed' })
        log.warn('export.chapterFailed', {
          event: 'export.chapterFailed',
          jobId,
          chapterId: chapter.chapterId,
          key,
          message,
        })
      }
    }

    // ④ M4B（可选）：用已产出的 WAV 无损合并 + ffmetadata 章节
    if ((payload.makeM4b || payload.m4bOnly) && chapterOutputs.length > 0 && chapterOutputs.length === chapters.length) {
      try {
        const m4bDir = params.metadata.title
          ? join(params.outputDir, params.metadata.title)
          : params.outputDir
        m4bPath = join(m4bDir, `${book.title}.m4b`)
        await mkdir(dirname(m4bPath), { recursive: true })
        const listRel = `cache/tmp/export-${jobId}/concat.txt`
        const metaRel = `cache/tmp/export-${jobId}/chapters.ffmetadata`
        const listAbs = join(root, listRel)
        const metaAbs = join(root, metaRel)
        // concat 列表用**无损中间产物**（loudness 处理后的 wav）而不是 mp3，避免二次编码
        const wavOutputs = chapters.map((c) => join(root, `cache/tmp/export-${jobId}/${c.seq}-loudness.wav`))
        await writeFile(listAbs, generateConcatList(wavOutputs), 'utf8')
        // 章节时间戳用**每章渲染时的真实时长**（`chapterDurations`）：编造的时长会让
        // 播放器的章节列表与音频内容错位 —— 那比没有章节更糟
        const ffChapters = chapters.map((c) => ({
          title: c.title,
          durationMs: chapterDurations.get(c.chapterId) ?? 0,
        }))
        await writeFile(
          metaAbs,
          generateFfmetadata(ffChapters, {
            title: params.metadata.title ?? book.title,
            artist: params.metadata.artist ?? undefined,
          }),
          'utf8',
        )
        await ffmpegRun(
          buildM4bCommand({
            listFile: listAbs,
            metadataFile: metaAbs,
            output: m4bPath,
            m4bBitrate: params.m4bBitrate,
            sampleRate: params.sampleRate,
            channels: AUDIO_DEFAULTS.channels,
          }),
          ctx,
          'export:m4b',
        )
        log.info('export.m4bDone', { event: 'export.m4bDone', jobId, path: m4bPath })
      } catch (e) {
        m4bPath = null
        batchWarnings.push(`M4B 合并失败：${e instanceof Error ? e.message : String(e)}`)
        log.warn('export.m4bFailed', {
          event: 'export.m4bFailed',
          jobId,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    } else if (payload.makeM4b && chapterOutputs.length !== chapters.length) {
      batchWarnings.push('有章节未成功导出，已跳过 M4B 合并（避免产出不完整的整本文件）')
    }

    const finishedAt = Date.now()
    const batchStatus = failed > 0 ? (failed === chapters.length ? 'failed' : 'succeeded') : 'succeeded'
    const m4bSize = m4bPath ? await stat(m4bPath).then((s) => s.size, () => null) : null
    await repo.update(jobId, {
      status: batchStatus,
      outputPath: m4bPath ?? params.outputDir,
      outputSize: m4bSize,
      warnings: batchWarnings,
      finishedAt,
    })
    ctx.report(1, '导出完成')
    log.info('export.batchDone', {
      event: 'export.batchDone',
      jobId,
      bookId: payload.bookId,
      chapters: chapters.length,
      failed,
      skipped,
      m4b: m4bPath !== null,
    })
    return { jobId, bookId: payload.bookId, chapters: results, m4bPath, failed, skipped }
  }

  return {
    async enqueueChapter(chapterIds, mixProjectId, params) {
      if (!deps.queue) {
        throw new AppError('TASK_QUEUE_UNAVAILABLE', {
          details: { op: 'export:chapter', reason: 'queue-not-injected' },
        })
      }
      if (chapterIds.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'export:chapter', reason: 'empty-chapter-ids' },
        })
      }
      const db = requireDb()
      const row = db.prepare(`SELECT book_id FROM chapters WHERE id = ?`).get(chapterIds[0]!) as
        | { book_id: string }
        | undefined
      if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'chapter', id: chapterIds[0] } })
      const task = await deps.queue.enqueue(
        'export.chapter',
        { bookId: row.book_id, chapterIds: [...chapterIds], mixProjectId, params, makeM4b: false },
        {},
      )
      log.info('export.enqueued', {
        event: 'export.enqueued',
        taskId: task.taskId,
        kind: 'export.chapter',
        chapters: chapterIds.length,
      })
      return { taskId: task.taskId }
    },

    async enqueueBook(bookId, mixProjectId, params, makeM4b) {
      if (!deps.queue) {
        throw new AppError('TASK_QUEUE_UNAVAILABLE', {
          details: { op: 'export:book', reason: 'queue-not-injected' },
        })
      }
      const task = await deps.queue.enqueue('export.book', { bookId, mixProjectId, params, makeM4b }, {})
      log.info('export.enqueued', { event: 'export.enqueued', taskId: task.taskId, kind: 'export.book', makeM4b })
      return { taskId: task.taskId }
    },

    async enqueueM4b(bookId, chapterIds, params) {
      if (!deps.queue) {
        throw new AppError('TASK_QUEUE_UNAVAILABLE', {
          details: { op: 'export:m4b', reason: 'queue-not-injected' },
        })
      }
      const task = await deps.queue.enqueue(
        'export.book',
        { bookId, chapterIds: [...chapterIds], mixProjectId: null, params, makeM4b: true, m4bOnly: true },
        {},
      )
      log.info('export.enqueued', {
        event: 'export.enqueued',
        taskId: task.taskId,
        kind: 'export.book(m4bOnly)',
        chapters: chapterIds.length,
      })
      return { taskId: task.taskId }
    },

    runNow: (payload, ctx) => runExport(payload, ctx),

    taskSpecs() {
      const spec: TaskSpec<ExportTaskPayload, ExportTaskResult> = {
        kind: 'export.book' as TaskKind,
        concurrencyKey: 'ffmpeg',
        priority: 0,
        // 同一批参数的整本导出不重复排队（用户连点两次「导出」不该跑两遍）
        dedupeKey: (payload) =>
          `export:${payload.bookId}:${(payload.chapterIds ?? []).join(',')}:${paramsHashOf(payload.params)}`,
        run: (ctx, payload) => runExport(payload, ctx),
      }
      const chapterSpec: TaskSpec<ExportTaskPayload, ExportTaskResult> = {
        kind: 'export.chapter' as TaskKind,
        concurrencyKey: 'ffmpeg',
        priority: 0,
        dedupeKey: (payload) =>
          `export-ch:${(payload.chapterIds ?? []).join(',')}:${paramsHashOf(payload.params)}`,
        run: (ctx, payload) => runExport(payload, ctx),
      }
      return [spec as TaskSpec<unknown, unknown>, chapterSpec as TaskSpec<unknown, unknown>]
    },
  }
}

/** 供测试与报告使用：文件命名模板（导出给单测直接断言） */
export { renderFileName as renderExportFileName }
