/**
 * Novel Studio · 处理域的任务（`audio.process`，docs/14 §7）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §7.1 批量流程：解析目标集合 → 去重键 → 并发执行（失败隔离）→ 汇总报告
 *   · docs/14 §7.2 取消语义：停止派发 + kill ffmpeg；**已完成的结果保留**（不回滚）
 *   · docs/14 §7.3 失败必须能「查看命令」（命令进错误详情与日志）
 *   · docs/03 §6    `processed/{segmentId}.{presetHash}.wav`；换预设 = 换文件，旧文件保留
 *   · docs/04 §2.2  并发键 `ffmpeg`
 *
 * ### 为什么任务体自己读库、自己解析预设
 *   任务可能在入队后过一会儿才跑（队列持久化，甚至跨重启）。载荷里塞一份链虽然也能跑，
 *   但「用户在排队期间改了预设」就会静默用旧参数、而 UI 显示的是新预设。所以载荷只带
 *   `presetId`（或显式链）+ 目标 id，运行期再解析。
 *
 * ### 失败隔离是硬要求（docs/14 §7.1）
 *   一个片段失败不能中断整批：逐片段 `try/catch`，失败进报告，继续下一个。
 *   整批抛错会把「124 个片段里第 3 个坏掉」变成「一个都没处理」。
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { AppError, isCancelKey } from '../../../shared/errors.ts'
import type { Id, ProcessChain, ProcessScope, TaskKind } from '../../../shared/types.ts'
import { buildProcessFilterGraph } from '../../../shared/ffmpeg/filters.ts'
import { buildProcessCommand, formatCommandForDisplay } from '../../../shared/ffmpeg/commands.ts'
import type { FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import { AUDIO_DEFAULTS } from '../../../shared/constants.ts'
import { chainHash, isProcessChainEmpty } from '../../../shared/audio/process.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { Logger } from '../../infra/log/index.ts'
import type { TaskQueue } from '../../infra/queue/queue.ts'
import type { TaskContext, TaskSpec } from '../../infra/queue/types.ts'

/** 单次处理任务的载荷（**不含链本身**，除非用户是「临时调参试听/应用」） */
export interface ProcessTaskPayload {
  /** 显式目标（`scope: 'segment'` 时用） */
  segmentIds: Id[]
  scope: ProcessScope
  /** 角色 / 章节 / 书 id（按 scope 解释；契约 `process:batchApply` 的 `ids` 数组落到这里） */
  scopeIds?: Id[]
  presetId?: Id | null
  /** 显式链（与 presetId 二选一；两者都给时 presetId 优先） */
  chain?: ProcessChain | null
  /** 试听/单片段场景下的时长限制（毫秒）；不传 = 处理全长 */
  previewMs?: number
}

export interface ProcessFailure {
  segmentId: Id
  reason: string
  /** 完整命令行（docs/14 §7.3「查看命令」必须能复制到终端复现） */
  command: string
  /** ffmpeg 的 stderr 尾部（排障用） */
  stderr?: string
}

export interface ProcessTaskReport {
  total: number
  done: number
  skipped: number
  failed: number
  failures: ProcessFailure[]
  cancelled: boolean
  presetHash: string
}

export interface ProcessTasksDeps {
  getDb: () => DbLike | null
  queue?: TaskQueue
  ffmpeg: FfmpegRunner
  /** `{userData}/projects`（音频路径的父目录） */
  projectRoot: () => string
  /** 预设/显式链 → 具体链（由 `preset.service` 提供，避免本文件直接依赖预设仓储） */
  resolveChain: (presetId?: Id | null, chain?: ProcessChain | null) => Promise<ProcessChain>
  log: Logger
}

export interface ProcessTasks {
  enqueueApply(payload: ProcessTaskPayload): Promise<{ taskId: Id }>
  taskSpecs(): Array<TaskSpec<unknown, unknown>>
  /** 供测试与服务层直接调用（不起队列） */
  runNow(payload: ProcessTaskPayload, ctx: TaskContext): Promise<ProcessTaskReport>
}

/** 目标片段（`resolveTargets` 的产物） */
export interface ProcessTarget {
  segmentId: Id
  lineId: Id
  chapterId: Id
  filePath: string
  processedPath: string | null
  presetHash: string | null
}

export function createProcessTasks(deps: ProcessTasksDeps): ProcessTasks {
  const log = deps.log

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'process' } })
    return db
  }

  /**
   * 按范围解析要处理的片段。
   *
   * 没有成品行的画本行**不算失败**：它根本无可处理之物（还没录），
   * 把它算进失败会让报告一片红，掩盖真正的问题。
   */
  function resolveTargets(payload: ProcessTaskPayload): ProcessTarget[] {
    const db = requireDb()
    const select = `SELECT s.id AS segment_id, s.line_id, s.chapter_id, s.file_path,
                           s.processed_path, s.preset_hash
                      FROM voice_segments s
                      JOIN canvas_lines l ON l.id = s.line_id
                      JOIN chapters c ON c.id = l.chapter_id`
    type Row = {
      segment_id: string
      line_id: string
      chapter_id: string
      file_path: string
      processed_path: string | null
      preset_hash: string | null
    }
    let rows: Row[]
    switch (payload.scope) {
      case 'segment': {
        if (payload.segmentIds.length === 0) return []
        const marks = payload.segmentIds.map(() => '?').join(', ')
        rows = db.prepare(`${select} WHERE s.id IN (${marks})`).all(...payload.segmentIds) as Row[]
        break
      }
      case 'chapter': {
        const ids = requireScopeIds(payload, 'chapter')
        rows = db.prepare(`${select} WHERE s.chapter_id IN (${marks(ids)})`).all(...ids) as Row[]
        break
      }
      case 'character': {
        const ids = requireScopeIds(payload, 'character')
        rows = db.prepare(`${select} WHERE l.character_id IN (${marks(ids)})`).all(...ids) as Row[]
        break
      }
      case 'book': {
        const ids = requireScopeIds(payload, 'book')
        rows = db
          .prepare(`${select} JOIN books b ON b.id = c.book_id WHERE b.id IN (${marks(ids)})`)
          .all(...ids) as Row[]
        break
      }
      default:
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'process', reason: 'unknown-scope', scope: payload.scope },
        })
    }
    return rows.map((r) => ({
      segmentId: r.segment_id,
      lineId: r.line_id,
      chapterId: r.chapter_id,
      filePath: r.file_path,
      processedPath: r.processed_path,
      presetHash: r.preset_hash,
    }))
  }

  async function runProcess(payload: ProcessTaskPayload, ctx: TaskContext): Promise<ProcessTaskReport> {
    const db = requireDb()
    const chain = await deps.resolveChain(payload.presetId ?? null, payload.chain ?? null)
    const hash = chainHash(chain)
    // 空链也要跑：它把格式统一成 s32/48k（docs/14 §13「仅修剪」预设就是这种）
    const filterGraph = buildProcessFilterGraph({
      chain,
      sampleRate: AUDIO_DEFAULTS.sampleRate,
      channels: AUDIO_DEFAULTS.channels,
    })
    const targets = resolveTargets(payload)
    const report: ProcessTaskReport = {
      total: targets.length,
      done: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      cancelled: false,
      presetHash: hash,
    }
    if (targets.length === 0) {
      log.warn('process.noTargets', {
        event: 'process.noTargets',
        scope: payload.scope,
        note: '范围内没有任何已录片段（voice_segments 为空）：不是失败，只是没什么可做',
      })
      ctx.report(1, '无目标')
      return report
    }

    // 音频根 = `{projectRoot}/{projectId}`（与 ns-media 协议同一基准，docs/91 §5.2.19）
    const projectId = await projectIdOfChapter(db, targets[0]!.chapterId)
    const root = join(deps.projectRoot(), projectId)
    const tmpDir = ctx.tempDir || join(root, 'cache', 'tmp', ctx.taskId)

    let index = 0
    for (const target of targets) {
      // 取消语义：停止派发新任务，**已完成的结果保留**（docs/14 §7.2）
      if (ctx.isAborted()) {
        report.cancelled = true
        break
      }
      index++
      const srcAbs = join(root, target.filePath)
      const outRel = `processed/${target.segmentId}.${hash}.wav`
      const outAbs = join(root, outRel)

      // 幂等（docs/14 §7.1）：processed_path 与 preset_hash 都一致 → 跳过，不重跑
      if (target.processedPath === outRel && target.presetHash === hash) {
        report.skipped++
        ctx.report(index / targets.length, `跳过 ${target.segmentId}`)
        continue
      }

      const command = buildProcessCommand({
        input: srcAbs,
        output: outAbs,
        filter: filterGraph,
        sampleRate: AUDIO_DEFAULTS.sampleRate,
        channels: AUDIO_DEFAULTS.channels,
        ...(payload.previewMs && payload.previewMs > 0 ? { previewMs: payload.previewMs } : {}),
      })
      try {
        await mkdir(dirname(outAbs), { recursive: true })
        await mkdir(tmpDir, { recursive: true })
        const result = await deps.ffmpeg.execute(command, {
          signal: ctx.signal,
          cwd: tmpDir,
          onProgressLine: (line) => {
            const seconds = parseProgressLine(line)
            if (seconds !== null) {
              ctx.report(index / targets.length, `处理 ${target.segmentId} ${seconds.toFixed(1)}s`)
            }
          },
        })
        if (result.exitCode !== 0) {
          throw new AppError('EXPORT_FFMPEG_FAILED', {
            params: { code: String(result.exitCode) },
            details: {
              op: 'process',
              segmentId: target.segmentId,
              exitCode: result.exitCode,
              command: formatCommandForDisplay(result.command),
              stderr: result.stderr.slice(-2000),
            },
          })
        }
        // 两列一起写：只写 processed_path 而漏掉 preset_hash 会让「跳过」判断永远不成立
        db.prepare(
          `UPDATE voice_segments SET processed_path = ?, preset_hash = ?, updated_at = ? WHERE id = ?`,
        ).run(outRel, hash, Date.now(), target.segmentId)
        report.done++
        ctx.report(index / targets.length, `完成 ${target.segmentId}`)
        log.info('process.segmentDone', {
          event: 'process.segmentDone',
          segmentId: target.segmentId,
          processedPath: outRel,
          presetHash: hash,
        })
      } catch (e) {
        // 失败隔离：记一条、继续下一个（docs/14 §7.1）。取消是例外：它要停下整批
        const cancelled = e instanceof AppError && isCancelKey(e.key)
        report.failed++
        report.failures.push({
          segmentId: target.segmentId,
          reason: cancelled ? '任务被取消' : e instanceof Error ? e.message : String(e),
          command: formatCommandForDisplay(command),
          ...(e instanceof AppError && typeof e.details?.stderr === 'string' ? { stderr: e.details.stderr } : {}),
        })
        log.warn('process.segmentFailed', {
          event: 'process.segmentFailed',
          segmentId: target.segmentId,
          reason: e instanceof Error ? e.message : String(e),
          command: formatCommandForDisplay(command),
        })
        if (cancelled) {
          report.cancelled = true
          break
        }
      }
    }

    ctx.report(1, report.cancelled ? '已取消' : '完成')
    log.info('process.taskDone', {
      event: 'process.taskDone',
      presetHash: hash,
      emptyChain: isProcessChainEmpty(chain),
      total: report.total,
      done: report.done,
      skipped: report.skipped,
      failed: report.failed,
      cancelled: report.cancelled,
    })
    return report
  }

  return {
    async enqueueApply(payload) {
      if (!deps.queue) {
        throw new AppError('TASK_QUEUE_UNAVAILABLE', {
          details: { op: 'process:apply', reason: 'queue-not-injected' },
        })
      }
      // 先解析一次链：**入队前**就报出「预设不存在」这类错误，
      // 而不是让用户在任务中心里看到一个几秒后才失败的任务
      const chain = await deps.resolveChain(payload.presetId ?? null, payload.chain ?? null)
      const hash = chainHash(chain)
      const task = await deps.queue.enqueue('audio.process', { ...payload, chain }, {})
      log.info('process.enqueued', {
        event: 'process.enqueued',
        taskId: task.taskId,
        scope: payload.scope,
        targets: payload.segmentIds.length,
        presetId: payload.presetId ?? null,
        presetHash: hash,
      })
      return { taskId: task.taskId }
    },

    runNow: (payload, ctx) => runProcess(payload, ctx),

    taskSpecs() {
      // 幂等键只能是「入队时就能确定」的东西：载荷里始终带着解析后的链（见 enqueueApply），
      // 所以这里算指纹是稳的；多目标批量不做去重（不同范围的批量本来就该各跑一次）
      const spec: TaskSpec<ProcessTaskPayload, ProcessTaskReport> = {
        kind: 'audio.process' as TaskKind,
        concurrencyKey: 'ffmpeg',
        priority: 0,
        dedupeKey: (payload) => {
          if (payload.scope !== 'segment' || payload.segmentIds.length !== 1 || !payload.chain) return undefined
          return `process:${payload.segmentIds[0]}:${chainHash(payload.chain)}`
        },
        run: (ctx, payload) => runProcess(payload, ctx),
      }
      return [spec as TaskSpec<unknown, unknown>]
    },
  }
}

/** `?` 占位串（IN 子句） */
function marks(ids: readonly Id[]): string {
  return ids.map(() => '?').join(', ')
}

/**
 * 非 segment 范围必须有 ids。
 *
 * 为什么不做「没给 ids 就处理全部」：那会把「按范围批量处理」变成「一键处理整本书」，
 * 而用户以为只处理了一章 —— 事后无法解释为什么几百个片段都被重写了。
 */
function requireScopeIds(payload: ProcessTaskPayload, scope: ProcessScope): Id[] {
  const ids = payload.scopeIds ?? []
  if (ids.length === 0) {
    throw new AppError('INVALID_PAYLOAD', {
      details: { op: 'process', reason: 'scope-ids-missing', scope },
    })
  }
  return ids
}

/** `-progress pipe:1` 的 `out_time_us=123456` 行 → 秒（不是该格式则 null） */
export function parseProgressLine(line: string): number | null {
  const match = /^out_time_us=(\d+)$/.exec(line.trim())
  if (!match) return null
  return Number(match[1]) / 1_000_000
}

/** 章节所属项目（音频路径的基准） */
async function projectIdOfChapter(db: DbLike, chapterId: Id): Promise<Id> {
  const row = db
    .prepare(
      `SELECT b.project_id AS project_id
         FROM chapters c JOIN books b ON b.id = c.book_id
        WHERE c.id = ?`,
    )
    .get(chapterId) as { project_id: string | null } | undefined
  if (!row?.project_id) {
    throw new AppError('NOT_FOUND', { details: { entity: 'chapter', chapterId } })
  }
  return row.project_id
}
