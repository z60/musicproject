/**
 * Novel Studio · 「按说话人导入音频」的**后台任务**（docs/04 §2、docs/12 §3.5）
 * ============================================================================
 * 为什么必须是任务（真机需求：「我需要这个导入变为后台的一个任务，成品出来的速度慢点没事」）：
 *
 *   · 一个文件要「解码 → 逐帧能量包络 → VAD → 把语音片铺满每一行 → 写 take/segment」，
 *     真机样本最大 30 MB / 74 章；几十个文件就是几分钟。
 *   · 同步调用时渲染进程只能一直转圈，用户不能离开向导、也看不到「到底卡在哪一个文件」。
 *   · 做成任务后：可以关掉向导（任务中心继续跑）、进度按文件推进、失败能重试、
 *     与其它长任务共用同一套进度 UI 与取消语义（docs/04 §2.4 禁止自建进度 UI）。
 *
 * 为什么 `maxAttempts: 1`：导入会**写 take**，而且不保证幂等（同一文件重跑会再产生一批
 * take，虽然只把「本来没有成品」的行设为成品）。自动重试可能在用户不知情时写两遍 ——
 * 宁可失败后由用户在任务中心显式重试。
 *
 * 为什么 `concurrencyKey` 固定成一把锁：逐帧能量与 WAV 读写都是 CPU/磁盘密集，
 * 并发跑两个只会在磁盘上互相拖慢，还会让两个任务同时写同一批行。
 */

import { createHash } from 'node:crypto'

import { AppError } from '../../../shared/errors.ts'
import type { AudioImportApplyResult, AudioImportFileRequest, Id, TaskKind } from '../../../shared/types.ts'
import type { Logger } from '../../infra/log/index.ts'
import type { TaskQueue } from '../../infra/queue/queue.ts'
import type { TaskSpec } from '../../infra/queue/types.ts'
import type { AudioImportPhase, AudioImportService } from './import.service.ts'

/**
 * 每个阶段完成时该文件「已做完多少」（0~1）。
 *
 * 份额是按真机耗时分布取的：转码/复制大文件占不少时间（35%），
 * 解码 + 逐帧能量 + VAD + 铺行最慢（到 80%），写 take 收尾（100%）。
 * 数值不需要精确 —— 它只决定进度条的推进节奏，别让它在某一步长时间不动即可。
 */
const PHASE_FRACTION: Record<AudioImportPhase, number> = {
  copy: 0.35,
  split: 0.8,
  write: 1,
}

const PHASE_LABEL: Record<AudioImportPhase, string> = {
  copy: '复制/转码',
  split: '切句（解码 + 逐帧能量 + VAD）',
  write: '写入 take',
}

/** 任务类型名（放在这里而不是散落各处，避免字符串写错后任务静默不跑） */
export const AUDIO_IMPORT_TASK_KIND = 'audioImport.apply' as const

export interface AudioImportTaskPayload {
  projectId: Id
  bookId: Id
  canvasPath?: string
  files: AudioImportFileRequest[]
  onlyFiles?: string[]
  skipNeedsReview?: boolean
}

export interface AudioImportTasks {
  /** 入队一次导入；返回任务 id（渲染侧据此订阅进度并在完成时取 `task:result`） */
  enqueueApply(payload: AudioImportTaskPayload): Promise<{ taskId: Id }>
  /** 任务规格（装配层注册进队列） */
  taskSpecs(): Array<TaskSpec<unknown, unknown>>
}

/**
 * 批次指纹：**文件名集合**（+ 只导哪些 + 是否跳过需确认）。
 *
 * 为什么去重键要带它：原来只按书去重（`audioImport.apply:{bookId}`），
 * 于是「上一批还在跑，用户改了勾选再点导入」会命中同一个活动任务 ——
 * 新选的文件**一个都不会导**，而界面显示的还是那条正在跑的任务（静默丢数据）。
 *
 * 带指纹后：
 *   · 同一批连点两次 → 仍然只有一条任务（幂等）；
 *   · 换了一批文件 → 新任务排队（串行执行），真机需求「导入一批可以继续导入」。
 */
function batchKey(payload: AudioImportTaskPayload): string {
  const names = payload.files
    .map((f) => f.filePath.replace(/\\/g, '/').split('/').pop() ?? f.filePath)
    .slice()
    .sort()
  const only = [...(payload.onlyFiles ?? [])].slice().sort()
  const raw = `${names.join('|')}#${only.join('|')}#${payload.skipNeedsReview === true ? 1 : 0}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

export interface AudioImportTasksDeps {
  service: AudioImportService
  /** 不传时 `enqueueApply` 抛 TASK_QUEUE_UNAVAILABLE（与画本域同一降级口径） */
  queue?: TaskQueue
  log: Pick<Logger, 'info' | 'warn' | 'error'>
}

export function createAudioImportTasks(deps: AudioImportTasksDeps): AudioImportTasks {
  const log = deps.log

  function requireQueue(): TaskQueue {
    if (!deps.queue) {
      throw new AppError('TASK_QUEUE_UNAVAILABLE', { details: { reason: 'audio-import-queue-unavailable' } })
    }
    return deps.queue
  }

  return {
    async enqueueApply(payload) {
      const queue = requireQueue()
      if (payload.files.length === 0) {
        throw new AppError('INVALID_PAYLOAD', { details: { reason: 'import-without-files' } })
      }
      const res = await queue.enqueue(AUDIO_IMPORT_TASK_KIND, payload, {
        priority: 0,
        projectId: payload.bookId,
        // 同一本书重复点「导入」应合并成一条，而不是排队跑两遍（重复写 take 的根源）
        dedupeKey: `${AUDIO_IMPORT_TASK_KIND}:${payload.bookId}:${batchKey(payload)}`,
      })
      log.info('audioImport.enqueued', {
        event: 'audioImport.enqueued',
        taskId: res.taskId,
        bookId: payload.bookId,
        files: payload.files.length,
        deduped: res.deduped,
      })
      return { taskId: res.taskId }
    },

    taskSpecs() {
      return [
        {
          kind: AUDIO_IMPORT_TASK_KIND as TaskKind,
          // 逐帧能量 + WAV 读写都是 CPU/磁盘密集：串行跑，别互相抢盘
          concurrencyKey: 'audio-import',
          priority: 0,
          // 写 take 不保证幂等，不自动重试（见文件头）
          maxAttempts: 1,
          run: async (ctx, payload) => {
            const p = payload as AudioImportTaskPayload
            const total = p.files.length
            const result: AudioImportApplyResult = await deps.service.applyImport({
              projectId: p.projectId,
              bookId: p.bookId,
              ...(p.canvasPath ? { canvasPath: p.canvasPath } : {}),
              files: p.files,
              ...(p.onlyFiles ? { onlyFiles: p.onlyFiles } : {}),
              ...(p.skipNeedsReview !== undefined ? { skipNeedsReview: p.skipNeedsReview } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              onProgress: (done, fileTotal, fileName, phase) => {
                const denominator = Math.max(1, fileTotal || total)
                /**
                 * 文件内份额：转码 35% / 切句 80% / 写完 100%。
                 *
                 * 只报「第几个文件」时，一个 125 MB 的文件会让进度条停在同一个百分比
                 * 好几分钟 —— 用户看到的就是「进度条无法实时变化」（真机反馈）。
                 * 切成阶段后，同一个文件内部也会推进两次。
                 */
                const phaseFraction = PHASE_FRACTION[phase] ?? 1
                const base = Math.max(0, done - 1) / denominator
                ctx.report(
                  Math.min(1, base + phaseFraction / denominator),
                  `正在导入 ${done}/${denominator}：${fileName} · ${PHASE_LABEL[phase]}`,
                )
              },
            })
            log.info('audioImport.done', {
              event: 'audioImport.done',
              taskId: ctx.taskId,
              files: result.files,
              createdTakes: result.createdTakes,
              createdSegments: result.createdSegments,
              skipped: result.skipped.length,
            })
            return result
          },
        },
      ]
    },
  }
}
