/**
 * Novel Studio · 画本域的任务（`canvas:generate` 与 `canvas:recomputeAttribution`）
 * ============================================================================
 * 设计依据：
 *   · docs/11 §8「章节超长（>5000 行）分批处理 + 进度」；§2「生成前自动打快照」
 *   · docs/04 §2.2 并发/优先级/幂等；`canvas.generate` 与 embedding 并列（分钟级）
 *   · docs/06 §5.5 重算（复用已存向量 / 换模型必须全量）
 *
 * ### 为什么单开一层而不是直接写在 handler 里
 *   两个通道都返回 `{ taskId }` —— 真正的活在队列里跑。而 `HandlerDeps.tasks`
 *   **只能读任务、不能入队**（见 `ipc/handlers/deps.ts` 的 `TaskPort`）。
 *   入队需要持有 `TaskQueue`，这与导入域的做法一致（`book.service` 的 `enqueueImport`）。
 *
 * ### 为什么任务体自己读库，而不是把章节正文塞进载荷
 *   任务可能在入队后过一会儿才跑，甚至跨重启（队列是持久化的）。
 *   把几千字的正文塞进载荷既浪费存储，又会让「用户在这期间改了正文」变成静默的过期数据。
 *   所以载荷只带 id 与选项，正文在 `run` 里现取。
 *
 * ### 事务与并发
 *   `generateChapter` 内部通过 `canvasRepo.replaceChapterLines` 写库（它自己开事务）；
 *   本层**不再套事务**（SQLite 不支持嵌套 `BEGIN`），只负责「跑完之后更新章节的画本状态」。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { CanvasGenerateOptions, Id, TaskKind } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import type { Logger } from '../../../infra/log/index.ts'
import type { TaskQueue } from '../../../infra/queue/queue.ts'
import type { TaskSpec } from '../../../infra/queue/types.ts'
import { createSqliteChapterRepo } from '../import/repositories/chapter.repo.sqlite.ts'
import { createSqliteCanvasRepo } from './repositories/canvas.repo.sqlite.ts'
import { createSqliteCharacterRepo } from './repositories/character.repo.sqlite.ts'
import { buildCentroidRecord } from './repositories/character.repo.ts'
import type { LineEmbeddingRecord } from './repositories/canvas.repo.ts'
import { createCanvasFeature, type CanvasFeature } from './index.ts'

/** 生成任务的载荷（**不含正文**，见文件头第 2 条） */
export interface CanvasGenerateTaskPayload {
  chapterId: Id
  options: CanvasGenerateOptions
  /** 覆盖 CANVAS_DEFAULTS 的限制（由 handler 从 settings.canvas 映射过来） */
  limits?: {
    maxLineChars?: number
    shortLineChars?: number
    maxNarrationRun?: number
    maxDialogueRun?: number
  }
}

/** 重算任务的载荷 */
export interface CanvasRecomputeTaskPayload {
  chapterId: Id
  scope: 'low_confidence' | 'all' | 'selection'
  lineIds?: Id[]
  options: CanvasGenerateOptions
  /**
   * 是否允许覆盖人工判定。**默认 false**：契约里没有这个字段，
   * 渲染侧也从不传 —— 默认「人工结果永不覆盖」（docs/11 §3）。
   */
  overwriteHuman?: boolean
}

/**
 * 原型向量重建任务的载荷（`character:rebuildCentroid`）。
 *
 * 入队由 `character.service` 负责（那里已经持有队列），载荷形状放在这里是为了
 * 「入队方」与「任务体」用的是**同一个类型**，避免两处各写一份字段名。
 */
export interface CentroidTaskPayload {
  bookId: Id
  /** 要重建的角色 id（服务层已校验过存在性） */
  characterIds: Id[]
}

export interface CanvasTasksDeps {
  getDb: () => DbLike | null
  /** 队列；不传时两个通道抛 TASK_QUEUE_UNAVAILABLE（与导入域同款降级） */
  queue?: TaskQueue
  log: Logger
  /** 生成用的限制（来自 settings.canvas，可省） */
  limits?: CanvasGenerateTaskPayload['limits']
  /** 每批处理行数（默认 200，docs/11 §8） */
  batchSize?: number
}

export interface CanvasTasks {
  enqueueGenerate(chapterId: Id, options: CanvasGenerateOptions): Promise<{ taskId: Id }>
  enqueueRecompute(payload: CanvasRecomputeTaskPayload): Promise<{ taskId: Id }>
  taskSpecs(): Array<TaskSpec<unknown, unknown>>
}

export function createCanvasTasks(deps: CanvasTasksDeps): CanvasTasks {
  const log = deps.log

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'canvas' } })
    return db
  }

  function requireQueue(): TaskQueue {
    if (!deps.queue) {
      throw new AppError('TASK_QUEUE_UNAVAILABLE', { details: { reason: 'canvas-queue-unavailable' } })
    }
    return deps.queue
  }

  /**
   * 按**当前**数据库句柄现建画本域（库可能在「从备份恢复」后换掉）。
   *
   * provider 刻意传 `null`：生产环境没有 ONNX 实现（`ports.ts` 的 embedding 能力探测
   * 恒为不可用），传 null 会走规则判定并给出 `CANVAS_EMBEDDING_UNAVAILABLE` 警告 ——
   * 这与 `docs/06 §8`「绝不因为模型缺失就阻断用户」一致。
   */
  function feature(): CanvasFeature {
    const db = requireDb()
    return createCanvasFeature({
      canvasRepo: createSqliteCanvasRepo(db),
      characterRepo: createSqliteCharacterRepo(db),
      embedProvider: null,
      llmReviewer: null,
      ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
      log: {
        info: (event, fields) => log.info(event, fields),
        warn: (event, fields) => log.warn(event, fields),
        error: (event, fields) => log.error(event, fields),
      },
    })
  }

  /**
   * 生成完成后把「章节的画本状态 / 行数」写回 `chapters`。
   *
   * 为什么必须写：章节列表页显示的就是这两列（`Chapter.canvasState` / `Chapter.lineCount`），
   * 不写的话用户生成完画本，回到列表看到的仍是「未生成 / 0 行」。
   * 注意这两个字段**不在** `CanvasRepo` 的职责里（那是章节表），所以这里用章节仓储。
   */
  async function syncChapterCanvasState(chapterId: Id): Promise<void> {
    const db = requireDb()
    const chapters = createSqliteChapterRepo(db)
    const canvasRepo = createSqliteCanvasRepo(db)
    const lineCount = await canvasRepo.countByChapter(chapterId)
    await chapters.update(chapterId, {
      canvasState: lineCount > 0 ? 'generated' : 'none',
      lineCount,
    })
  }

  return {
    async enqueueGenerate(chapterId, options) {
      const q = requireQueue()
      // 入队前先确认章节存在：否则用户会拿到一个「排上队但注定失败」的任务
      const chapter = await createSqliteChapterRepo(requireDb()).findById(chapterId)
      if (!chapter) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: chapterId } })

      const res = await q.enqueue(
        'canvas.generate',
        { chapterId, options, ...(deps.limits ? { limits: deps.limits } : {}) },
        {
          priority: 0, // 用户交互触发
          projectId: chapter.bookId, // 队列按项目统计用（章节的所属书）
          // 同一章重复点「生成」应当合并成一个任务，而不是排队跑两遍
          dedupeKey: `canvas.generate:${chapterId}`,
        },
      )
      log.info('canvas.generate.enqueued', {
        event: 'canvas.generate.enqueued',
        taskId: res.taskId,
        chapterId,
        deduped: res.deduped,
      })
      return { taskId: res.taskId }
    },

    async enqueueRecompute(payload) {
      const q = requireQueue()
      const chapter = await createSqliteChapterRepo(requireDb()).findById(payload.chapterId)
      if (!chapter) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: payload.chapterId } })

      const res = await q.enqueue('canvas.recompute', payload, {
        priority: 0,
        projectId: chapter.bookId,
      })
      log.info('canvas.recompute.enqueued', {
        event: 'canvas.recompute.enqueued',
        taskId: res.taskId,
        chapterId: payload.chapterId,
        scope: payload.scope,
      })
      return { taskId: res.taskId }
    },

    taskSpecs(): Array<TaskSpec<unknown, unknown>> {
      return [
        {
          kind: 'canvas.generate' as TaskKind,
          // 生成会调 embedding（并发上限 1，避免内存爆）与写库；这里按 embedding 串行
          concurrencyKey: 'embedding',
          priority: 0,
          // 重新生成不是幂等操作（会替换整章行），失败不自动重试
          maxAttempts: 1,
          run: async (ctx, payload) => {
            const p = payload as CanvasGenerateTaskPayload
            const db = requireDb()
            const chapter = await createSqliteChapterRepo(db).findById(p.chapterId)
            if (!chapter) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: p.chapterId } })
            const text = (await createSqliteChapterRepo(db).getText(p.chapterId))?.text ?? ''

            ctx.report(0.05, 'load')
            const result = await feature().generateChapter({
              bookId: chapter.bookId,
              chapterId: p.chapterId,
              chapterTitle: chapter.title,
              chapterText: text,
              options: p.options,
              ...(p.limits ? { limits: p.limits } : {}),
              // 节奏预设目前没有持久化字段（settings.canvas 里没有），用标准节奏
              tempoFactor: 1,
              // 章首标题念白行走独立的 `chapter:inserTitleLine` 通道，生成时不重复插入
              includeTitleLine: false,
              snapshot: true, // docs/11 §2 FR-2.4.7：生成前自动打快照
              signal: ctx.signal,
              onProgress: (progress) => ctx.report(progress.ratio, progress.stage),
            })

            await syncChapterCanvasState(p.chapterId)
            // 生成报告落库（表在 003 迁移里）：`canvas:getGenerateReport` 要读它。
            // 为什么在这里写而不是让 handler 写：报告是**生成任务的产物**，
            // 任务跑完才算数（handler 那边只拿到 taskId）。失败不阻断任务 ——
            // 报告丢失只影响「这次是怎么切的」这类展示，行已经写好了。
            try {
              await createSqliteCanvasRepo(db).saveGenerateReport(result.report)
            } catch (e) {
              log.warn('canvas.generate.reportSaveFailed', {
                event: 'canvas.generate.reportSaveFailed',
                chapterId: p.chapterId,
                reason: e instanceof Error ? e.message : String(e),
              })
            }
            log.info('canvas.generate.done', {
              event: 'canvas.generate.done',
              chapterId: p.chapterId,
              lines: result.lines.length,
              snapshotId: result.snapshotId,
              warnings: result.warnings.length,
            })
            // 任务结果：渲染侧 `task:finished` 之后会重新加载画本，报告由 getGenerateReport 取
            return {
              chapterId: p.chapterId,
              lineCount: result.lines.length,
              snapshotId: result.snapshotId,
              canvasState: result.canvasState,
              warnings: result.warnings,
            }
          },
        },

        {
          kind: 'canvas.recompute' as TaskKind,
          concurrencyKey: 'embedding',
          priority: 0,
          maxAttempts: 1,
          run: async (ctx, payload) => {
            const p = payload as CanvasRecomputeTaskPayload
            const db = requireDb()
            const chapter = await createSqliteChapterRepo(db).findById(p.chapterId)
            if (!chapter) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: p.chapterId } })

            ctx.report(0.05, 'load')
            const result = await feature().recomputeAttribution({
              bookId: chapter.bookId,
              chapterId: p.chapterId,
              scope: p.scope,
              ...(p.lineIds ? { lineIds: p.lineIds } : {}),
              options: p.options,
              // 刻意**不**传 `chapterText`：不给正文时走「复用已存向量」路径
              // （docs/06 §5.5「调阈值只重跑判定，不需重新 embedding」）。
              // 传正文会重新分句，从而把用户手工改过的文本覆盖回原文 ——
              // 而重算的心智是「只改归属，不改内容」。
              overwriteHuman: p.overwriteHuman ?? false,
              signal: ctx.signal,
              onProgress: (progress) => ctx.report(progress.ratio, progress.stage),
            })

            await syncChapterCanvasState(p.chapterId)
            log.info('canvas.recompute.done', {
              event: 'canvas.recompute.done',
              chapterId: p.chapterId,
              updated: result.updated,
              skippedHuman: result.skippedHuman,
              lowConfidence: result.lowConfidence,
            })
            return result
          },
        },

        {
          kind: 'character.centroid' as TaskKind,
          // 只是读向量、算平均值、写原型：与 embedding 串行（同一批模型资源）
          concurrencyKey: 'embedding',
          // 后台维护任务：用户交互触发的生成/重算应当排在它前面（docs/04 §2.2）
          priority: 1,
          maxAttempts: 1,
          run: async (ctx, payload) => {
            const p = payload as CentroidTaskPayload
            const db = requireDb()
            const canvasRepo = createSqliteCanvasRepo(db)
            const characterRepo = createSqliteCharacterRepo(db)

            let updated = 0
            let skipped = 0
            let samples = 0
            const modelIds = new Set<string>()
            const total = p.characterIds.length

            for (let i = 0; i < total; i++) {
              const characterId = p.characterIds[i]!
              ctx.report(total === 0 ? 1 : (i + 1) / total, `rebuild:${characterId}`)
              const embeddings = await canvasRepo.listEmbeddingsByCharacter(characterId)
              if (embeddings.length === 0) {
                // 没有向量是**正常情况**：生产环境没有 ONNX 实现时 line_embeddings 就是空的
                // （docs/91 §3）。这不是失败 —— 报错会让用户以为「重建坏了」。
                skipped++
                continue
              }
              // 按 modelId 分组：不同模型的向量空间不可比，混着加会得到一个无意义的原型
              // （docs/06 §5.5 换模型必须全量重算）
              const groups = new Map<string, LineEmbeddingRecord[]>()
              for (const e of embeddings) {
                const list = groups.get(e.modelId)
                if (list) list.push(e)
                else groups.set(e.modelId, [e])
              }
              for (const [modelId, list] of groups) {
                const dim = list[0]!.dim
                if (list.some((e) => e.dim !== dim || e.vector.length !== dim)) {
                  log.warn('character.centroid.dimMismatch', {
                    event: 'character.centroid.dimMismatch',
                    characterId,
                    modelId,
                  })
                  continue
                }
                const sum = new Float32Array(dim)
                for (const e of list) {
                  for (let k = 0; k < dim; k++) sum[k] += e.vector[k]!
                }
                const record = buildCentroidRecord({
                  characterId,
                  modelId,
                  sumVector: sum,
                  sampleCount: list.length,
                  now: Date.now(),
                })
                await characterRepo.upsertCentroid(record)
                updated++
                samples += list.length
                modelIds.add(modelId)
              }
            }

            log.info('character.centroid.done', {
              event: 'character.centroid.done',
              bookId: p.bookId,
              characters: total,
              updated,
              skipped,
              samples,
              modelIds: [...modelIds],
            })
            // 返回值说明「做了什么、跳过了多少」：模型缺失时 skipped=全部，
            // 渲染侧据此提示「装好模型后再重建」，而不是显示一个空洞的「成功」
            return { bookId: p.bookId, characters: total, updated, skipped, samples, modelIds: [...modelIds] }
          },
        },
      ]
    },
  }
}
