/**
 * Novel Studio · 处理服务（`process:*` 5 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §10 试听：只处理前 10 秒（`process:preview` 返回**相对项目根**的路径）
 *   · docs/14 §13 空链 = 只统一格式（不跳过）
 *   · docs/03 §6  非破坏：`processed` 是派生文件，原件永不被改写；`revert` 只解绑
 *   · docs/14 §7.1 真正的批量执行在任务队列（`process.tasks.ts`）
 *
 * ### 三层分工（不要混）
 * | 层 | 负责 |
 * |----|------|
 * | 本文件 | 通道语义：试听渲染、查询已应用、解绑（revert）、把 apply/batchApply 变成任务 |
 * | `process.tasks.ts` | 批量执行、失败隔离、幂等、取消、写 `processed_path` |
 * | `shared/ffmpeg/*` | 命令与滤镜串（纯函数，可单测） |
 *
 * ### 试听为什么单独实现而不复用任务
 *   试听是**交互动作**（用户拖动参数、点一下就要听到），进队列意味着排队等待、
 *   而且会在任务中心里堆出一串「试听」记录。它写的是 `cache/tmp/` 下的临时文件，
 *   不落 `processed_path`、不改库 —— 这正是「试听」与「应用」的区别。
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import type { Id, ProcessChain, ProcessScope } from '../../../shared/types.ts'
import { AUDIO_DEFAULTS } from '../../../shared/constants.ts'
import { buildProcessFilterGraph } from '../../../shared/ffmpeg/filters.ts'
import { buildProcessCommand, formatCommandForDisplay, type FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import { chainHash, enabledEqBandCount, isProcessChainEmpty } from '../../../shared/audio/process.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { Logger } from '../../infra/log/index.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { ProcessTasks } from './process.tasks.ts'

/** 试听渲染时长上限（docs/14 §10：默认 10 秒） */
export const PREVIEW_MS_DEFAULT = 10_000
/** 试听渲染时长上限的上限（防止渲染侧传一个「整段」把试听变成正式渲染） */
export const PREVIEW_MS_MAX = 60_000

export interface ProcessServiceDeps {
  getDb: () => DbLike | null
  /** `{userData}/projects` */
  projectRoot: () => string
  tasks: ProcessTasks
  ffmpeg: FfmpegRunner
  resolveChain: (presetId?: Id | null, chain?: ProcessChain | null) => Promise<ProcessChain>
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
  now?: () => number
}

export interface ProcessService {
  preview(segmentId: Id, chain: ProcessChain, durationMs?: number): Promise<{ path: string }>
  apply(segmentId: Id, presetId?: Id | null, chain?: ProcessChain | null): Promise<{ taskId: Id }>
  batchApply(
    scope: ProcessScope,
    ids: readonly Id[],
    presetId?: Id | null,
    chain?: ProcessChain | null,
  ): Promise<{ taskId: Id }>
  listApplied(
    segmentIds: readonly Id[],
  ): Promise<Array<{ segmentId: Id; processedPath: string | null; presetHash: string | null }>>
  revert(segmentId: Id): Promise<{ ok: boolean }>
}

export function createProcessService(deps: ProcessServiceDeps): ProcessService {
  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'process' } })
    return db
  }

  /** 片段 → 音频根与源文件（顺带拿到所属项目：路径基准是 `{projectRoot}/{projectId}`） */
  function segmentSource(segmentId: Id): {
    root: string
    /** 相对项目根的源路径（**优先用已处理的文件**：连续处理两次时第二次应当基于上一次的结果？不 —— 见下） */
    relative: string
    chapterId: Id
    processedPath: string | null
    presetHash: string | null
  } {
    const db = requireDb()
    const row = db
      .prepare(
        `SELECT s.file_path, s.processed_path, s.preset_hash, s.chapter_id,
                b.project_id AS project_id
           FROM voice_segments s
           JOIN canvas_lines l ON l.id = s.line_id
           JOIN chapters c ON c.id = l.chapter_id
           JOIN books b ON b.id = c.book_id
          WHERE s.id = ?`,
      )
      .get(segmentId) as
      | {
          file_path: string
          processed_path: string | null
          preset_hash: string | null
          chapter_id: string
          project_id: string
        }
      | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'voice_segment', segmentId } })
    return {
      root: projectAudioRoot(deps.projectRoot(), row.project_id),
      // ★ 永远基于**原始成品**处理，而不是上一次的处理结果：
      //   否则「换预设」会变成「在已处理的音频上再处理一遍」（降噪叠加、限幅叠加），
      //   听起来像「越处理越糊」，而且 revert 之后无法回到干净状态（docs/03 §6 非破坏）
      relative: row.file_path,
      chapterId: row.chapter_id,
      processedPath: row.processed_path,
      presetHash: row.preset_hash,
    }
  }

  return {
    async preview(segmentId, chain, durationMs) {
      const src = segmentSource(segmentId)
      const requested = durationMs ?? PREVIEW_MS_DEFAULT
      if (!Number.isFinite(requested) || requested <= 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'process:preview', reason: 'invalid-duration', durationMs: requested },
        })
      }
      const previewMs = Math.min(PREVIEW_MS_MAX, Math.round(requested))
      const hash = chainHash(chain)
      const outRel = `cache/tmp/preview-${segmentId}-${hash}.wav`
      const outAbs = join(src.root, outRel)
      const filterGraph = buildProcessFilterGraph({
        chain,
        sampleRate: AUDIO_DEFAULTS.sampleRate,
        channels: AUDIO_DEFAULTS.channels,
      })
      const command = buildProcessCommand({
        input: join(src.root, src.relative),
        output: outAbs,
        filter: filterGraph,
        sampleRate: AUDIO_DEFAULTS.sampleRate,
        channels: AUDIO_DEFAULTS.channels,
        previewMs,
      })

      await mkdir(dirname(outAbs), { recursive: true })
      let result: Awaited<ReturnType<FfmpegRunner['execute']>>
      try {
        result = await deps.ffmpeg.execute(command, {})
      } catch (e) {
        // ffmpeg 根本起不来（未安装 / 路径错）：这是**环境问题**，与「参数不对」要分开报，
        // 否则用户会去调 EQ 而不是去装 ffmpeg
        throw new AppError('EXPORT_FFMPEG_FAILED', {
          cause: e,
          params: { code: 'ENOENT' },
          details: {
            op: 'process:preview',
            reason: 'ffmpeg-not-found',
            segmentId,
            command: formatCommandForDisplay(command),
            hint: '未找到 ffmpeg：请在设置里指定路径，或把 ffmpeg 放进资源目录（docs/02 §5）',
          },
        })
      }
      if (result.exitCode !== 0) {
        throw new AppError('EXPORT_FFMPEG_FAILED', {
          params: { code: String(result.exitCode) },
          details: {
            op: 'process:preview',
            segmentId,
            exitCode: result.exitCode,
            command: formatCommandForDisplay(result.command),
            stderr: result.stderr.slice(-2000),
          },
        })
      }
      deps.log?.info?.('process.previewed', {
        event: 'process.previewed',
        segmentId,
        path: outRel,
        previewMs,
        presetHash: hash,
        emptyChain: isProcessChainEmpty(chain),
        eqBands: enabledEqBandCount(chain),
        elapsedMs: result.elapsedMs,
      })
      return { path: outRel }
    },

    async apply(segmentId, presetId, chain) {
      // 链先解析一次：不存在的预设要在**入队前**报错（见 process.tasks 的说明）
      const resolved = await deps.resolveChain(presetId ?? null, chain ?? null)
      // 片段存在性也提前校验：否则会入队一个「跑起来才发现片段没了」的任务
      segmentSource(segmentId)
      const { taskId } = await deps.tasks.enqueueApply({
        segmentIds: [segmentId],
        scope: 'segment',
        presetId: presetId ?? null,
        chain: resolved,
      })
      deps.log?.info?.('process.applyQueued', {
        event: 'process.applyQueued',
        taskId,
        segmentId,
        presetId: presetId ?? null,
        presetHash: chainHash(resolved),
      })
      return { taskId }
    },

    async batchApply(scope, ids, presetId, chain) {
      if (ids.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'process:batchApply',
            reason: 'empty-ids',
            scope,
            hint: '批量处理必须有目标；空目标多半是界面上没选中任何项',
          },
        })
      }
      const resolved = await deps.resolveChain(presetId ?? null, chain ?? null)
      const payload =
        scope === 'segment'
          ? { segmentIds: [...ids], scope, presetId: presetId ?? null, chain: resolved }
          : { segmentIds: [] as Id[], scope, scopeIds: [...ids], presetId: presetId ?? null, chain: resolved }
      const { taskId } = await deps.tasks.enqueueApply(payload)
      deps.log?.info?.('process.batchQueued', {
        event: 'process.batchQueued',
        taskId,
        scope,
        targets: ids.length,
        presetId: presetId ?? null,
        presetHash: chainHash(resolved),
      })
      return { taskId }
    },

    async listApplied(segmentIds) {
      if (segmentIds.length === 0) return []
      const db = requireDb()
      const marks = segmentIds.map(() => '?').join(', ')
      const rows = db
        .prepare(`SELECT id, processed_path, preset_hash FROM voice_segments WHERE id IN (${marks})`)
        .all(...segmentIds) as Array<{ id: string; processed_path: string | null; preset_hash: string | null }>
      return rows.map((r) => ({
        segmentId: r.id,
        processedPath: r.processed_path,
        presetHash: r.preset_hash,
      }))
    },

    async revert(segmentId) {
      const db = requireDb()
      // 只解绑，**不删文件**：派生文件可能被对轨/混音引用（它们的路径存在别的表里），
      // 删掉会让「导出到一半」失败。清理由保留策略负责（docs/03 §2 的 7 天规则）
      const r = db
        .prepare(`UPDATE voice_segments SET processed_path = NULL, preset_hash = NULL, updated_at = ? WHERE id = ?`)
        .run(deps.now?.() ?? Date.now(), segmentId) as { changes?: number }
      const ok = (r.changes ?? 0) > 0
      if (ok) {
        deps.log?.info?.('process.reverted', {
          event: 'process.reverted',
          segmentId,
          note: '只解绑 processed_path/preset_hash，派生文件保留（非破坏，docs/03 §6）',
        })
      }
      return { ok }
    },
  }
}
