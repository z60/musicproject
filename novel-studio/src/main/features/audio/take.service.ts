/**
 * Novel Studio · Take 服务（`take:*` 6 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §8.1 「任何 take 都不自动删除（除用户显式清理）」；§8.2 软删/硬删
 *   · docs/12 §3.3 「超长行分段录 → 按 partIndex 顺序 concat 成一个成品」
 *   · docs/12 §13   多 take：同一行录 5 次全部保留、A/B 可切、**成品唯一**
 *   · docs/12 §9.1  「设为成品」要产生一条 `voice_segments`（对轨的唯一输入）
 *   · docs/03 §6    非破坏性处理：换成品时作废 `processed_path/preset_hash`
 *
 * ### 这个服务的三件事
 *   1. **列 take**（按行 / 按章）—— 纯读，过滤软删
 *   2. **设为成品**：标记 `is_selected` + 把音频**拷**成 `segments/{segmentId}.wav`
 *      + 写/更新 `voice_segments` 行（带实测峰值/RMS）
 *   3. **合并分段**：按 `partIndex` 顺序拼接 → 新 take（原文件不删）→ 直接设为成品
 *
 * ### 为什么设为成品要「拷文件」而不是引用 take 路径
 *   take 可能被硬删（`hard: true` 会删文件），成品不能跟着消失；处理链的输入也必须是
 *   稳定文件（见 `audio-file.copyAudioFile` 的注释）。代价是多一份几秒的音频。
 *
 * ### 软删之后没有「恢复」通道（如实记录）
 *   契约里没有 `take:restore`，所以软删的行只能靠 SQL 或将来新增的通道恢复。
 *   界面上不要承诺「可恢复」，这与 docs/12 §8.2 的原话（文件保留，清理时彻底删除）一致。
 */

import { rm } from 'node:fs/promises'

import { AppError } from '../../../shared/errors.ts'
import type { Id, LineState, Take, VoiceSegment } from '../../../shared/types.ts'
import { computePeakDb, computeRmsDb } from '../../../shared/audio/pcm.ts'
import type { Logger } from '../../infra/log/index.ts'
import {
  concatWavFiles,
  copyAudioFile,
  readAudioFile,
  resolveAudioPath,
} from './audio-file.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { AudioProjectScope } from './project-scope.ts'
import type { TakeRepo } from './repositories/take.repo.ts'
import type { VoiceSegmentRepo } from './repositories/voice-segment.repo.ts'

export interface TakeServiceDeps {
  /** `{userData}/projects`（项目目录的父目录） */
  projectRoot: () => string
  /**
   * 路径 → 所属项目。
   *
   * 必须用它而不是「直接把相对路径拼在 projectRoot 上」：库里的 `file_path` 相对的是
   * `{projectRoot}/{projectId}`，而渲染进程播放走的 `ns-media://{projectId}/{rel}`
   * 也落在同一个目录。少拼一层 projectId 的结果是：主进程读写自己的错路径、播放 404
   * —— 一半能用，最难查（docs/91 §5.2.19）。
   */
  scope: AudioProjectScope
  takeRepo: () => TakeRepo
  segmentRepo: () => VoiceSegmentRepo
  /** 取某行的章节 id（写成品行需要它） */
  lineChapterId: (lineId: Id) => Promise<Id | null>
  /**
   * 成品落库后把画本行推进到 `recorded`（docs/12 §3.3 / docs/01 §210）。
   * 与录音域同一个端口：**有成品 = 这行录过了**，状态机不能只靠录音那一侧维护
   * （真机事故 docs/91 §5.2.44：这条通路以前完全缺失，UI 永远显示未录）。
   */
  markLineRecorded?: (lineId: Id) => Promise<{ from: LineState; to: LineState; changed: boolean } | null>
  newId?: (prefix: string) => Id
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface TakeService {
  listByLine(lineId: Id): Promise<Take[]>
  listByChapter(chapterId: Id): Promise<Take[]>
  setSelected(lineId: Id, takeId: Id): Promise<VoiceSegment>
  remove(takeId: Id, hard?: boolean): Promise<{ ok: boolean }>
  flag(takeId: Id, flags: string[]): Promise<Take>
  combineParts(lineId: Id, takeIds: readonly Id[]): Promise<{ takeId: Id }>
}

export function createTakeService(deps: TakeServiceDeps): TakeService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`)
  const now = deps.now ?? (() => Date.now())

  /** 成品文件路径（docs/21 §6：`segments/{id}.wav`） */
  const segmentPath = (segmentId: Id): string => `segments/${segmentId}.wav`

  /**
   * 把某条 take 设为成品并落库。
   *
   * 步骤刻意固定为：**先拷文件、再量、最后写库**。
   * 反过来的话（先写库再拷文件）一旦拷贝失败，库里就会出现一条指向不存在文件的成品，
   * 对轨与导出都会在更晚的地方炸，而那时已经很难定位原因。
   */
  async function materializeSegment(lineId: Id, take: Take): Promise<VoiceSegment> {
    const chapterId = await deps.lineChapterId(lineId)
    if (!chapterId) {
      throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId } })
    }
    const root = projectAudioRoot(deps.projectRoot(), await deps.scope.projectIdOfLine(lineId))
    const segments = deps.segmentRepo()
    const existing = await segments.getByLine(lineId)
    const segmentId = existing?.id ?? newId('seg')
    const relative = segmentPath(segmentId)

    await copyAudioFile(root, take.filePath, relative)
    const file = await readAudioFile(root, relative)
    const measured = measure(file.mono, file.format.sampleRate)
    const ts = now()

    const segment: VoiceSegment = {
      id: segmentId,
      lineId,
      chapterId,
      takeId: take.id,
      filePath: relative,
      // 换成品 → 之前的处理结果作废（仓储的 upsertByLine 也会强制置空，这里是显式表达）
      processedPath: null,
      presetHash: null,
      srcInMs: take.srcInMs,
      srcOutMs: take.srcOutMs,
      durationMs: measured.durationMs,
      peakDb: measured.peakDb,
      rmsDb: measured.rmsDb,
      lufs: null, // LUFS 需要 ffmpeg 两遍法（docs/05 §8）；没接线时如实为空
      flags: [],
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    }
    const saved = await segments.upsertByLine(segment)
    deps.log?.info?.('take.segmentMaterialized', {
      event: 'take.segmentMaterialized',
      lineId,
      takeId: take.id,
      segmentId: saved.id,
      filePath: saved.filePath,
      durationMs: saved.durationMs,
    })
    /**
     * 画本行 state → recorded（docs/12 §3.3）。失败只记日志：成品已经写好，
     * 不能因为状态没推进就把这次「设为成品」判为失败。
     */
    if (deps.markLineRecorded) {
      try {
        const marked = await deps.markLineRecorded(lineId)
        deps.log?.info?.('take.lineRecorded', {
          event: 'take.lineRecorded',
          lineId,
          takeId: take.id,
          changed: marked?.changed ?? false,
          to: marked?.to ?? null,
        })
      } catch (e) {
        deps.log?.warn?.('take.lineRecorded.failed', {
          event: 'take.lineRecorded.failed',
          lineId,
          takeId: take.id,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    } else {
      deps.log?.warn?.('take.lineRecorded.unwired', {
        event: 'take.lineRecorded.unwired',
        lineId,
        note: '未注入 markLineRecorded：设为成品不会把画本行标成已录（docs/12 §3.3）',
      })
    }
    return saved
  }

  return {
    async listByLine(lineId) {
      return deps.takeRepo().listByLine(lineId)
    },

    async listByChapter(chapterId) {
      return deps.takeRepo().listByChapter(chapterId)
    },

    async setSelected(lineId, takeId) {
      const repo = deps.takeRepo()
      const take = await repo.get(takeId)
      if (!take) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
      if (take.lineId !== lineId) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'take:setSelected',
            reason: 'take-line-mismatch',
            lineId,
            takeId,
            actualLineId: take.lineId,
            hint: '「设为成品」只能选当前这一行的 take；给错行会把两行的成品关系都搞乱',
          },
        })
      }
      // 先落文件与成品行，再改选中标记：中途失败时不会留下「标记了成品但没有片段」
      const segment = await materializeSegment(lineId, take)
      await repo.setSelected(lineId, takeId)
      return segment
    },

    async remove(takeId, hard) {
      const repo = deps.takeRepo()
      // 软删的 take 也在 `get` 之外：硬删一条**已软删**的 take 必须能删掉它的文件，
      // 所以这里连软删行一起读（否则文件会永远留在盘上，而用户以为已经「彻底删除」）
      const take = await repo.get(takeId, { includeDeleted: true })
      if (!take) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })

      if (hard) {
        // 项目归属必须在**删行之前**取：`projectIdOfTake` 是查 `takes` 表的，
        // 行删掉之后就查不到了 —— 那样文件会永远留在盘上，而用户以为「彻底删除」了。
        // （这一条是被 take-service 的硬删用例抓出来的。）
        const projectId = await deps.scope.projectIdOfTake(takeId)
        const removed = await repo.remove(takeId)
        // 先删行、再删文件：行删不掉时不该留下「文件没了、行还在」的残局
        try {
          const root = projectAudioRoot(deps.projectRoot(), projectId)
          await rm(resolveAudioPath(root, take.filePath), { force: true })
        } catch (e) {
          deps.log?.warn?.('take.fileRemoveFailed', {
            event: 'take.fileRemoveFailed',
            takeId,
            path: take.filePath,
            reason: e instanceof Error ? e.message : String(e),
          })
        }
        deps.log?.warn?.('take.removedHard', { event: 'take.removedHard', takeId, filePath: take.filePath })
        return { ok: removed }
      }

      const ok = await repo.softDelete(takeId)
      deps.log?.info?.('take.removedSoft', {
        event: 'take.removedSoft',
        takeId,
        filePath: take.filePath,
        note: '文件保留、行标记 deleted_at；契约里没有恢复通道，恢复只能靠 SQL（docs/91 §5.2.18）',
      })
      return { ok }
    },

    async flag(takeId, flags) {
      const repo = deps.takeRepo()
      const take = await repo.get(takeId)
      if (!take) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
      // 去重 + 去空白：契约没限制重复项，落库前去一次，避免 UI 上出现两个一样的标记
      const next = [...new Set((flags ?? []).map((f) => f.trim()).filter((f) => f.length > 0))]
      return repo.setFlags(takeId, next)
    },

    async combineParts(lineId, takeIds) {
      const repo = deps.takeRepo()
      const all = await repo.listByLine(lineId)
      if (all.length < 2) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'take:combineParts',
            reason: 'need-at-least-two-parts',
            lineId,
            takeCount: all.length,
          },
        })
      }
      const ids = [...new Set(takeIds)]
      const parts = ids.map((id) => all.find((t) => t.id === id)).filter((t): t is Take => t !== undefined)
      if (parts.length < 2) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'take:combineParts',
            reason: 'need-at-least-two-valid-parts',
            lineId,
            requested: ids.length,
            found: parts.length,
          },
        })
      }
      if (new Set(parts.map((t) => t.partIndex)).size < 2) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'take:combineParts',
            reason: 'same-part-index',
            lineId,
            hint: '合并的是「同一行的不同分段」（partIndex 不同）；同一分段的多次重录请改用「设为成品」',
          },
        })
      }
      // 按 partIndex 排序拼接：用户勾选的顺序不算数，**分段顺序**才算（docs/12 §3.3）
      const ordered = [...parts].sort((a, b) => a.partIndex - b.partIndex || a.recordedAt - b.recordedAt)

      const takeId = newId('take')
      const relative = `takes/${lineId}/${takeId}.wav`
      const root = projectAudioRoot(deps.projectRoot(), await deps.scope.projectIdOfLine(lineId))
      const merged = await concatWavFiles(root, ordered.map((t) => t.filePath), relative)
      // 量一遍合并结果（峰值/RMS 要写进 take：A/B 对比与质检都用它）
      const file = await readAudioFile(root, relative)
      const measured = measure(file.mono, file.format.sampleRate)

      const ts = now()
      const newTake: Take = {
        id: takeId,
        lineId,
        sessionId: null,
        filePath: relative,
        // 合成结果排在所有分段之后：分段本身保留（「任何 take 都不自动删除」）
        partIndex: Math.max(...ordered.map((t) => t.partIndex)) + 1,
        srcInMs: 0,
        srcOutMs: merged.durationMs,
        trimmedInMs: 0,
        trimmedOutMs: merged.durationMs,
        durationMs: merged.durationMs,
        peakDb: measured.peakDb,
        rmsDb: measured.rmsDb,
        lufs: null,
        gainDb: ordered[0]!.gainDb,
        format: merged.format,
        source: 'local',
        packageId: null,
        flags: ['merged'],
        isSelected: false,
        note: `合并自 ${ordered.length} 段（part ${ordered.map((t) => t.partIndex).join('+')}）`,
        recordedAt: ts,
        createdAt: ts,
      }
      const inserted = await repo.insert(newTake)

      // 合并的意图就是「得到一条可用的成品」——直接设为选中并生成片段
      await materializeSegment(lineId, inserted)
      await repo.setSelected(lineId, takeId)

      deps.log?.info?.('take.combined', {
        event: 'take.combined',
        lineId,
        takeId,
        parts: ordered.map((t) => t.id),
        durationMs: merged.durationMs,
        partsDurationSum: ordered.reduce((s, t) => s + t.durationMs, 0),
      })
      return { takeId }
    },
  }
}

/** 时长 / 峰值 / RMS（与 `analysis` 服务同一口径：数字静音夹到 -100 dBFS） */
function measure(
  samples: Float32Array,
  sampleRate: number,
): { durationMs: number; peakDb: number | null; rmsDb: number | null } {
  if (samples.length === 0) return { durationMs: 0, peakDb: null, rmsDb: null }
  return {
    durationMs: sampleRate > 0 ? Math.round((samples.length / sampleRate) * 1000) : 0,
    peakDb: computePeakDb(samples),
    rmsDb: clampSilence(computeRmsDb(samples)),
  }
}

function clampSilence(db: number): number {
  if (!Number.isFinite(db)) return -100
  return db < -100 ? -100 : db
}
