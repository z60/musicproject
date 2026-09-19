/**
 * Novel Studio · 混音服务（`mix:*` 7 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §2  混音方案（轨道 + 母带 + 首尾静音 + 章首念白），每章可有多个方案、一个默认
 *   · docs/15 §5.1 响度两遍法（先用 loudnorm 分析得到 inputI/Tp/Lra/Thresh，再施加增益）
 *   · docs/05 §8  响度测量
 *
 * ### 这一层做什么
 *   `mix:*` 只负责**方案的读写**与**响度测量**；真正的渲染（把轨道混成一条音轨）
 *   属于导出域（`export:*`，尚未实现）—— 所以这里没有「渲染」通道，
 *   唯一的任务入口是 `alignment:previewRender`（只做人声总线）。
 *
 * ### 保存时的校验（不是「多余防御」，每一条都对应一种真会发生的坏状态）
 *   1. **方案引用的对轨方案必须属于同一章**：否则渲染出来是「这章的混音、那章的时间线」；
 *   2. **音乐/音效轨必须指向本项目已存在的素材**：否则渲染到一半才发现素材被删了；
 *   3. **轨道 id 不能重复**：重复 id 会让渲染时的 `-map` 映射到同一条流（结果是「少了一条轨」）；
 *   4. **presetId 必须存在**：否则处理链解析会在渲染时抛错。
 *   这些校验都在**保存时**做，而不是等渲染 —— 那时用户已经等了很久。
 *
 * ### 响度测量为什么要 ffmpeg
 *   `loudnorm` 的第一遍会输出 `input_i/input_tp/input_lra/input_thresh`，
 *   这是**唯一**能得到标准 LUFS 的途径（自己算需要 K 加权滤波器与门限），
 *   本仓库不去手写那一套（自算的 LUFS 与专业工具对不上，比不给更糟）。
 *   没装 ffmpeg 时明确报错，不返回一堆假数字。
 */

import { join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import { EXPORT_DEFAULTS } from '../../../shared/constants.ts'
import type { Id, LoudnessMeasurement, MixProject, MixTrack } from '../../../shared/types.ts'
import { parseLoudnormJson } from '../../../shared/audio/loudness.ts'
import { buildLoudnessMeasureCommand, formatCommandForDisplay, type FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { MixProjectRepo } from './repositories/mix.repo.ts'
import { DEFAULT_MASTER } from './repositories/mix.repo.sqlite.ts'
import type { AudioProjectScope } from './project-scope.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { Logger } from '../../infra/log/index.ts'

export interface MixServiceDeps {
  getDb: () => DbLike | null
  /** `{userData}/projects` */
  projectRoot: () => string
  repo: () => MixProjectRepo
  scope: AudioProjectScope
  ffmpeg: FfmpegRunner
  /** 对轨方案 → 它属于哪一章（保存时校验用） */
  arrangementChapterId: (arrangementId: Id) => Promise<Id | null>
  newId?: (prefix: string) => Id
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface MixService {
  listProjects(chapterId: Id): Promise<MixProject[]>
  get(mixProjectId: Id): Promise<MixProject>
  save(mixProject: MixProject): Promise<MixProject>
  create(chapterId: Id, arrangementId: Id, name: string): Promise<MixProject>
  duplicate(mixProjectId: Id, name: string): Promise<MixProject>
  remove(mixProjectId: Id): Promise<{ ok: boolean }>
  measureLoudness(
    locator: { path?: string; segmentId?: Id },
    targetLufs?: number,
  ): Promise<LoudnessMeasurement>
}

/** 新建混音方案时的默认人声轨（docs/15 §2：方案里至少要有一条人声轨才有意义） */
export function defaultVoiceTrack(mixProjectId: Id, id: Id): MixTrack {
  return {
    id,
    mixProjectId,
    kind: 'voice',
    refId: null,
    name: '人声',
    gainDb: 0,
    pan: 0,
    isMute: false,
    isSolo: false,
    presetId: null,
    sortOrder: 0,
    music: null,
  }
}

export function createMixService(deps: MixServiceDeps): MixService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`)

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'mix' } })
    return db
  }

  /**
   * 保存前的校验（见文件头）。**抛错而不是修正**：静默修正会让用户看到的配置
   * 与实际存下去的不是一回事，而渲染结果会「莫名其妙」。
   */
  async function validateProject(project: MixProject): Promise<void> {
    if (!project.chapterId || !project.arrangementId) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { op: 'mix:save', reason: 'missing-reference', chapterId: project.chapterId, arrangementId: project.arrangementId },
      })
    }
    const chapterOfArrangement = await deps.arrangementChapterId(project.arrangementId)
    if (!chapterOfArrangement) {
      throw new AppError('NOT_FOUND', { details: { entity: 'arrangement', id: project.arrangementId } })
    }
    if (chapterOfArrangement !== project.chapterId) {
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          op: 'mix:save',
          reason: 'arrangement-chapter-mismatch',
          chapterId: project.chapterId,
          arrangementId: project.arrangementId,
          arrangementChapterId: chapterOfArrangement,
          hint: '混音方案只能引用本章的对轨方案（否则会渲染出「这章的混音 + 那章的时间线」）',
        },
      })
    }

    const ids = new Set<string>()
    for (const track of project.tracks) {
      if (!track.id) {
        throw new AppError('INVALID_PAYLOAD', { details: { op: 'mix:save', reason: 'track-without-id' } })
      }
      if (ids.has(track.id)) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'mix:save',
            reason: 'duplicate-track-id',
            trackId: track.id,
            hint: '轨道 id 重复会让渲染时映射到同一条流（表现为「少了一条轨」）',
          },
        })
      }
      ids.add(track.id)
    }

    const db = requireDb()
    // 音乐/音效轨：素材必须存在且属于同一个项目（跨项目引用是最难查的错）
    const assetIds = project.tracks
      .filter((t) => (t.kind === 'music' || t.kind === 'sfx') && t.music?.assetId)
      .map((t) => t.music!.assetId)
    for (const assetId of [...new Set(assetIds)]) {
      const row = db.prepare(`SELECT project_id FROM music_assets WHERE id = ?`).get(assetId) as
        | { project_id: string }
        | undefined
      if (!row) {
        throw new AppError('NOT_FOUND', {
          details: { entity: 'music_asset', assetId, hint: '轨道引用的素材不存在（可能已被删除）' },
        })
      }
      // 项目归属：混音方案挂在章节 → 书 → 项目上
      const chapterProject = db
        .prepare(
          `SELECT b.project_id AS project_id FROM chapters c JOIN books b ON b.id = c.book_id WHERE c.id = ?`,
        )
        .get(project.chapterId) as { project_id: string } | undefined
      if (chapterProject && row.project_id !== chapterProject.project_id) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'mix:save',
            reason: 'asset-project-mismatch',
            assetId,
            assetProjectId: row.project_id,
            chapterProjectId: chapterProject.project_id,
          },
        })
      }
    }

    const presetIds = project.tracks.map((t) => t.presetId).filter((x): x is Id => Boolean(x))
    for (const presetId of [...new Set(presetIds)]) {
      const row = db.prepare(`SELECT id FROM process_presets WHERE id = ?`).get(presetId)
      if (!row) {
        throw new AppError('NOT_FOUND', {
          details: { entity: 'process_preset', id: presetId, hint: '轨道引用的处理预设不存在（可能已被删除）' },
        })
      }
    }
  }

  return {
    async listProjects(chapterId) {
      return deps.repo().listByChapter(chapterId)
    },

    async get(mixProjectId) {
      const project = await deps.repo().get(mixProjectId)
      if (!project) throw new AppError('NOT_FOUND', { details: { entity: 'mix_project', id: mixProjectId } })
      return project
    },

    async save(mixProject) {
      const existing = await deps.repo().get(mixProject.id)
      if (!existing) throw new AppError('NOT_FOUND', { details: { entity: 'mix_project', id: mixProject.id } })
      await validateProject(mixProject)
      const saved = await deps.repo().save(mixProject)
      deps.log?.info?.('mix.saved', {
        event: 'mix.saved',
        mixProjectId: saved.id,
        tracks: saved.tracks.length,
        version: saved.version,
        targetLufs: saved.master.targetLufs,
      })
      return saved
    },

    async create(chapterId, arrangementId, name) {
      const trimmed = name.trim()
      if (!trimmed) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'mix:create', reason: 'empty-name', hint: '混音方案名不能为空' },
        })
      }
      const chapterOfArrangement = await deps.arrangementChapterId(arrangementId)
      if (!chapterOfArrangement) {
        throw new AppError('NOT_FOUND', { details: { entity: 'arrangement', id: arrangementId } })
      }
      if (chapterOfArrangement !== chapterId) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'mix:create',
            reason: 'arrangement-chapter-mismatch',
            chapterId,
            arrangementId,
            arrangementChapterId: chapterOfArrangement,
          },
        })
      }
      const existing = await deps.repo().listByChapter(chapterId)
      const created = await deps.repo().create({
        chapterId,
        arrangementId,
        name: trimmed,
        // 新建即带一条人声轨：空方案在混音台里是一片空白，用户不知道该加什么
        tracks: [defaultVoiceTrack('', newId('track'))],
        master: { ...DEFAULT_MASTER },
        headSilenceMs: EXPORT_DEFAULTS.headSilenceMs,
        tailSilenceMs: EXPORT_DEFAULTS.tailSilenceMs,
        titleReading: { enabled: false, lineId: null, tailPauseMs: 500 },
        isDefault: existing.length === 0,
      })
      deps.log?.info?.('mix.created', {
        event: 'mix.created',
        mixProjectId: created.id,
        chapterId,
        arrangementId,
        isDefault: created.isDefault,
      })
      return created
    },

    async duplicate(mixProjectId, name) {
      const src = await deps.repo().get(mixProjectId)
      if (!src) throw new AppError('NOT_FOUND', { details: { entity: 'mix_project', id: mixProjectId } })
      const copy = await deps.repo().duplicate(mixProjectId, name.trim() || `${src.name} 副本`)
      deps.log?.info?.('mix.duplicated', {
        event: 'mix.duplicated',
        from: mixProjectId,
        to: copy.id,
        tracks: copy.tracks.length,
      })
      return copy
    },

    async remove(mixProjectId) {
      const target = await deps.repo().get(mixProjectId)
      if (!target) throw new AppError('NOT_FOUND', { details: { entity: 'mix_project', id: mixProjectId } })
      const ok = await deps.repo().remove(mixProjectId)
      // 删掉默认方案后自动改指最早创建的那份（否则该章会「没有默认」，导出找不到方案）
      if (ok && target.isDefault) {
        const rest = await deps.repo().listByChapter(target.chapterId)
        if (rest.length > 0) {
          await deps.repo().setDefault(rest[0]!.id)
          deps.log?.info?.('mix.defaultReassigned', {
            event: 'mix.defaultReassigned',
            chapterId: target.chapterId,
            mixProjectId: rest[0]!.id,
          })
        }
      }
      deps.log?.info?.('mix.removed', { event: 'mix.removed', mixProjectId, ok })
      return { ok }
    },

    async measureLoudness(locator, targetLufs) {
      // 定位与 analysis 同一套规则：`path` 与 `segmentId` 二选一，都不能不给
      let absolute: string
      if (locator.path) {
        const projectId = await deps.scope.projectIdOfPath(locator.path)
        absolute = join(projectAudioRoot(deps.projectRoot(), projectId), locator.path)
      } else if (locator.segmentId) {
        const db = requireDb()
        const row = db
          .prepare(`SELECT file_path, processed_path FROM voice_segments WHERE id = ?`)
          .get(locator.segmentId) as { file_path: string; processed_path: string | null } | undefined
        if (!row) {
          throw new AppError('NOT_FOUND', {
            details: { entity: 'voice_segment', segmentId: locator.segmentId },
          })
        }
        const projectId = await deps.scope.projectIdOfSegment(locator.segmentId)
        const rel = row.processed_path ?? row.file_path
        absolute = join(projectAudioRoot(deps.projectRoot(), projectId), rel)
      } else {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'mix:measureLoudness',
            reason: 'no-locator',
            hint: '必须给 path 或 segmentId 之一（契约里两者都是可选的，但不能都不给）',
          },
        })
      }

      // 目标响度：调用方没给就用导出默认母带的目标（-16 LUFS，有声书标准）
      const command = buildLoudnessMeasureCommand({
        input: absolute,
        targetLufs: targetLufs ?? DEFAULT_MASTER.targetLufs,
        truePeakDb: DEFAULT_MASTER.truePeakDb,
        lra: DEFAULT_MASTER.lra,
      })
      let result: Awaited<ReturnType<FfmpegRunner['execute']>>
      try {
        result = await deps.ffmpeg.execute(command, {})
      } catch (e) {
        throw new AppError('EXPORT_FFMPEG_FAILED', {
          cause: e,
          params: { code: 'ENOENT' },
          details: {
            op: 'mix:measureLoudness',
            reason: 'ffmpeg-not-found',
            command: formatCommandForDisplay(command),
            hint: '响度测量需要 ffmpeg 的 loudnorm：请在设置里指定 ffmpeg 路径（docs/02 §5）',
          },
        })
      }
      if (result.exitCode !== 0) {
        throw new AppError('EXPORT_FFMPEG_FAILED', {
          params: { code: String(result.exitCode) },
          details: {
            op: 'mix:measureLoudness',
            exitCode: result.exitCode,
            command: formatCommandForDisplay(result.command),
            stderr: result.stderr.slice(-2000),
          },
        })
      }
      // loudnorm 的分析结果走 stderr（`[Parsed_loudnorm_0 @ …] { … }`）
      const parsed = parseLoudnormJson(result.stderr)
      if (!parsed) {
        // 解析不出来就是「没测到」，绝不能拿 0 或峰值冒充：那会让用户以为响度合格
        throw new AppError('EXPORT_FFMPEG_FAILED', {
          params: { code: 'PARSE' },
          details: {
            op: 'mix:measureLoudness',
            reason: 'loudnorm-output-unparsable',
            command: formatCommandForDisplay(result.command),
            stderr: result.stderr.slice(-1000),
            hint: 'ffmpeg 版本可能不支持 loudnorm 的 JSON 输出（需要 4.1+）',
          },
        })
      }
      const measurement: LoudnessMeasurement = {
        inputI: parsed.inputI,
        inputTp: parsed.inputTp,
        inputLra: parsed.inputLra,
        inputThresh: parsed.inputThresh,
        targetOffset: parsed.targetOffset,
      }
      deps.log?.info?.('mix.loudnessMeasured', {
        event: 'mix.loudnessMeasured',
        inputI: measurement.inputI,
        inputTp: measurement.inputTp,
        inputLra: measurement.inputLra,
        targetOffset: measurement.targetOffset,
      })
      return measurement
    },
  }
}

