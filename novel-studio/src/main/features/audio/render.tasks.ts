/**
 * Novel Studio · 对轨预览渲染任务（`audio.render`，docs/13 §7）
 * ============================================================================
 * 设计依据：
 *   · docs/13 §7「预览渲染：只渲染时间线的一段（10~30 秒），用于快速试听」
 *   · docs/15 §3 渲染管线（本任务只做**人声总线**这一段）
 *   · docs/04 §2.2 并发键 `ffmpeg`
 *
 * ### 这个任务的边界（不写清就会被当成「混音已经能用」）
 *   它把一条 `arrangement` 的片段按时间线位置混成一条人声预览 WAV，落在
 *   `cache/tmp/`。**不做**：BGM / 音效 / 闪避 / 总线增益 / 母带响度 / 分章导出
 *   —— 那些属于混音与导出域（`mix:*` / `export:*`，尚未实现）。
 *   所以预览听起来「干」是设计使然；导出必须等混音域落地。
 *
 * ### 为什么输入用 `processed_path` 优先
 *   docs/03 §6：处理链的产物是**派生但被采用**的（用户点过「应用预设」）。
 *   预览与最终导出必须用同一份输入，否则「预览听着好、导出变了」——
 *   那是最难解释的一类问题。
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import type { Id, TaskKind } from '../../../shared/types.ts'
import {
  buildArrangementRenderCommand,
  clampPreviewDuration,
  type RenderItemInput,
} from '../../../shared/ffmpeg/arrangement-render.ts'
import { formatCommandForDisplay, type FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { Logger } from '../../infra/log/index.ts'
import type { TaskQueue } from '../../infra/queue/queue.ts'
import type { TaskContext, TaskSpec } from '../../infra/queue/types.ts'
import { projectAudioRoot } from './audio-root.ts'

/** 预览渲染任务的载荷（**不含渲染出来的文件**：它是任务的产物，不是输入） */
export interface ArrangementRenderPayload {
  arrangementId: Id
  /** 混音方案（暂未使用：BGM/闪避在混音域，见文件头边界说明） */
  mixProjectId?: Id | null
  startMs: number
  durationMs: number
}

export interface ArrangementRenderResult {
  /** 项目内相对路径（渲染侧拼 `ns-media://`） */
  path: string
  durationMs: number
  itemCount: number
  skippedTracks: string[]
  command: string
}

export interface RenderTasksDeps {
  getDb: () => DbLike | null
  queue?: TaskQueue
  ffmpeg: FfmpegRunner
  projectRoot: () => string
  log: Logger
}

export interface RenderTasks {
  enqueuePreview(payload: ArrangementRenderPayload): Promise<{ taskId: Id }>
  taskSpecs(): Array<TaskSpec<unknown, unknown>>
  /** 供测试直接跑（不起队列） */
  runNow(payload: ArrangementRenderPayload, ctx: TaskContext): Promise<ArrangementRenderResult>
}

export function createRenderTasks(deps: RenderTasksDeps): RenderTasks {
  const log = deps.log

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'alignment.render' } })
    return db
  }

  /** 解析「该用哪个文件」：处理过的优先（见文件头第 2 条） */
  function resolveItemInputs(db: DbLike, arrangementId: Id): {
    projectId: Id
    items: RenderItemInput[]
    segmentIds: Id[]
  } {
    const arrangement = db
      .prepare(`SELECT chapter_id FROM arrangements WHERE id = ?`)
      .get(arrangementId) as { chapter_id: string } | undefined
    if (!arrangement) {
      throw new AppError('NOT_FOUND', { details: { entity: 'arrangement', id: arrangementId } })
    }
    const projectRow = db
      .prepare(
        `SELECT b.project_id AS project_id
           FROM chapters c JOIN books b ON b.id = c.book_id
          WHERE c.id = ?`,
      )
      .get(arrangement.chapter_id) as { project_id: string } | undefined
    if (!projectRow?.project_id) {
      throw new AppError('NOT_FOUND', { details: { entity: 'chapter', id: arrangement.chapter_id } })
    }

    const rows = db
      .prepare(
        `SELECT i.id, i.segment_id, i.track_id, i.timeline_start_ms, i.src_in_ms, i.src_out_ms,
                i.fade_in_ms, i.fade_out_ms,
                s.file_path AS file_path, s.processed_path AS processed_path
           FROM arrangement_items i
           JOIN voice_segments s ON s.id = i.segment_id
          WHERE i.arrangement_id = ?
          ORDER BY i.timeline_start_ms ASC, i.order_in_track ASC`,
      )
      .all(arrangementId) as Array<{
      id: string
      segment_id: string
      track_id: string
      timeline_start_ms: number
      src_in_ms: number
      src_out_ms: number
      fade_in_ms: number
      fade_out_ms: number
      file_path: string
      processed_path: string | null
    }>

    const items: RenderItemInput[] = rows.map((r) => ({
      // 绝对路径由调用方（runProcess）用项目根拼；这里先放相对路径，稍后替换
      path: r.processed_path ?? r.file_path,
      trackId: r.track_id,
      timelineStartMs: r.timeline_start_ms,
      srcInMs: r.src_in_ms,
      srcOutMs: r.src_out_ms,
      fadeInMs: r.fade_in_ms,
      fadeOutMs: r.fade_out_ms,
    }))
    return { projectId: projectRow.project_id, items, segmentIds: rows.map((r) => r.segment_id) }
  }
  async function runRender(
    payload: ArrangementRenderPayload,
    ctx: TaskContext,
  ): Promise<ArrangementRenderResult> {
    const db = requireDb()
    const durationMs = clampPreviewDuration(payload.durationMs)
    const startMs = Math.max(0, Math.round(payload.startMs))
    const resolved = resolveItemInputs(db, payload.arrangementId)
    if (resolved.items.length === 0) {
      // 空时间线渲染出来是「一段静音」，那比报错更容易让用户以为「音频没了」
      throw new AppError('MIX_ARRANGEMENT_EMPTY', {
        details: { op: 'alignment:previewRender', arrangementId: payload.arrangementId },
      })
    }

    const root = projectAudioRoot(deps.projectRoot(), resolved.projectId)
    const outRel = `cache/tmp/preview-${payload.arrangementId}-${startMs}-${durationMs}.wav`
    const outAbs = join(root, outRel)
    const items: RenderItemInput[] = resolved.items.map((it) => ({
      ...it,
      path: join(root, it.path),
    }))
    const command = buildArrangementRenderCommand({
      items,
      output: outAbs,
      startMs,
      durationMs,
    })
    if (command.length === 0) {
      throw new AppError('MIX_ARRANGEMENT_EMPTY', {
        details: { op: 'alignment:previewRender', arrangementId: payload.arrangementId, reason: 'all-items-zero-length' },
      })
    }

    await mkdir(dirname(outAbs), { recursive: true })
    const started = Date.now()
    let result: Awaited<ReturnType<FfmpegRunner['execute']>>
    try {
      result = await deps.ffmpeg.execute(command, {
        signal: ctx.signal,
        cwd: ctx.tempDir || dirname(outAbs),
        onProgressLine: () => ctx.report(0.5, '渲染中'),
      })
    } catch (e) {
      throw new AppError('EXPORT_FFMPEG_FAILED', {
        cause: e,
        params: { code: 'ENOENT' },
        details: {
          op: 'alignment:previewRender',
          reason: 'ffmpeg-not-found',
          command: formatCommandForDisplay(command),
          hint: '未找到 ffmpeg：请在设置里指定路径，或把 ffmpeg 放进资源目录（docs/02 §5）',
        },
      })
    }
    if (result.exitCode !== 0) {
      throw new AppError('EXPORT_FFMPEG_FAILED', {
        params: { code: String(result.exitCode) },
        details: {
          op: 'alignment:previewRender',
          arrangementId: payload.arrangementId,
          exitCode: result.exitCode,
          command: formatCommandForDisplay(result.command),
          stderr: result.stderr.slice(-2000),
        },
      })
    }
    ctx.report(1, '完成')
    log.info('alignment.previewRendered', {
      event: 'alignment.previewRendered',
      arrangementId: payload.arrangementId,
      path: outRel,
      itemCount: items.length,
      startMs,
      durationMs,
      elapsedMs: Date.now() - started,
    })
    return {
      path: outRel,
      durationMs,
      itemCount: items.length,
      skippedTracks: [],
      command: formatCommandForDisplay(result.command),
    }
  }

  return {
    async enqueuePreview(payload) {
      if (!deps.queue) {
        throw new AppError('TASK_QUEUE_UNAVAILABLE', {
          details: { op: 'alignment:previewRender', reason: 'queue-not-injected' },
        })
      }
      // 入队前先校验「有东西可渲染」：否则任务会在几秒后失败，用户只看到一个红点
      const db = requireDb()
      const resolved = resolveItemInputs(db, payload.arrangementId)
      if (resolved.items.length === 0) {
        throw new AppError('MIX_ARRANGEMENT_EMPTY', {
          details: { op: 'alignment:previewRender', arrangementId: payload.arrangementId },
        })
      }
      const task = await deps.queue.enqueue('audio.render', payload, {})
      log.info('alignment.previewQueued', {
        event: 'alignment.previewQueued',
        taskId: task.taskId,
        arrangementId: payload.arrangementId,
        itemCount: resolved.items.length,
      })
      return { taskId: task.taskId }
    },

    runNow: (payload, ctx) => runRender(payload, ctx),

    taskSpecs() {
      const spec: TaskSpec<ArrangementRenderPayload, ArrangementRenderResult> = {
        kind: 'audio.render' as TaskKind,
        concurrencyKey: 'ffmpeg',
        priority: 0,
        // 同一个窗口的预览复用：用户连点两次「预览」不该排队跑两遍
        dedupeKey: (payload) =>
          `render:${payload.arrangementId}:${Math.round(payload.startMs)}:${clampPreviewDuration(payload.durationMs)}`,
        run: (ctx, payload) => runRender(payload, ctx),
      }
      return [spec as TaskSpec<unknown, unknown>]
    },
  }
}
