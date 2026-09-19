/**
 * Novel Studio · 素材服务（`music:*` 4 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §8 素材管理：导入即**托管**（复制到 `projects/{id}/music/{kind}/`）、
 *     自动读取时长/采样率/峰值、按项目隔离、授权提示
 *   · docs/03 §2  相对路径基准是 `{projectRoot}/{projectId}`（与 `ns-media://` 一致）
 *   · docs/21 §6  `music_assets`
 *
 * ### 三条设计决定
 *   1. **导入 = 复制，不是引用**（docs/14 §8 的原话：避免源文件被移动）。
 *      引用源路径的话，用户一整理素材目录，所有 BGM 轨就全哑了。
 *   2. **探测用「解码成临时 WAV 再测量」**：`analysis:*` 只认 WAV，而素材绝大多数是
 *      mp3/m4a/flac/ogg。与其为每种容器写解析器，不如让 ffmpeg 解码成单声道 WAV，
 *      再用同一套测量代码（峰值/RMS 口径与全仓库一致）。**WAV 素材不经过 ffmpeg**
 *      —— 少一步就少一个「没装 ffmpeg 就不能探测 WAV」的伪依赖。
 *   3. **删除先删文件、再删行**：反过来的话，删行成功而删文件失败会留下一个
 *      「谁也找不到的孤儿文件」；先删文件失败则整个操作失败（行还在，状态一致）。
 *      被混音轨引用时**拒绝删除**并列出引用它的轨道名（渲染侧的提示就是这么写的）。
 */

import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import type { AudioMetrics, Id, MusicAsset } from '../../../shared/types.ts'
import { formatCommandForDisplay, type FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import type { Logger } from '../../infra/log/index.ts'
import { readAudioFile, resolveAudioPath } from './audio-file.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { MusicAssetRepo } from './repositories/music.repo.ts'
import type { DbLike } from '../../infra/db/types.ts'

/** 允许导入的容器（docs/14 §8）；其余格式明确拒绝，不做「猜扩展名」 */
export const SUPPORTED_MUSIC_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] as const

/** 探测时解码的目标采样率/声道（测量口径与 analysis 一致：48k 单声道） */
export const PROBE_SAMPLE_RATE = 48_000

export interface MusicServiceDeps {
  getDb: () => DbLike | null
  /** `{userData}/projects` */
  projectRoot: () => string
  repo: () => MusicAssetRepo
  /** 素材根目录所属项目（导入时要建目录） */
  projectExists: (projectId: Id) => Promise<boolean>
  ffmpeg: FfmpegRunner
  newId?: (prefix: string) => Id
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface MusicService {
  importFiles(projectId: Id, files: readonly string[], kind: 'bgm' | 'sfx'): Promise<MusicAsset[]>
  list(projectId: Id, kind?: 'bgm' | 'sfx'): Promise<MusicAsset[]>
  probe(assetId: Id): Promise<AudioMetrics>
  remove(assetId: Id): Promise<{ ok: boolean }>
}

export function createMusicService(deps: MusicServiceDeps): MusicService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`)
  const now = deps.now ?? (() => Date.now())

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'music' } })
    return db
  }

  /** 素材的绝对路径（`{projectRoot}/{projectId}/{music/...}`） */
  function absOf(asset: Pick<MusicAsset, 'projectId' | 'filePath'>): string {
    return resolveAudioPath(projectAudioRoot(deps.projectRoot(), asset.projectId), asset.filePath)
  }

  /**
   * 测量一个音频文件（素材的「自动读取元数据」）。
   *
   * WAV 直接量；其它容器用 ffmpeg 解码成 48k 单声道 WAV 落到 `cache/tmp/` 再量。
   * 临时文件用完就删（素材可能有几十 MB，留着就是磁盘泄漏）。
   */
  async function measureFile(
    projectId: Id,
    absolutePath: string,
    label: string,
  ): Promise<{ durationMs: number; peakDb: number | null; rmsDb: number | null; sampleRate: number; channels: number }> {
    const ext = extname(absolutePath).slice(1).toLowerCase()
    const root = projectAudioRoot(deps.projectRoot(), projectId)
    if (ext === 'wav') {
      const rel = absolutePath.slice(root.length).replace(/^[\\/]+/, '')
      const file = await readAudioFile(root, rel)
      return {
        durationMs: file.format.sampleRate > 0 ? Math.round((file.frames / file.format.sampleRate) * 1000) : 0,
        peakDb: measurePeak(file.mono),
        rmsDb: measureRms(file.mono),
        sampleRate: file.format.sampleRate,
        channels: file.format.channels,
      }
    }

    const tempRel = `cache/tmp/probe-${newId('m')}.wav`
    const tempAbs = join(root, tempRel)
    await mkdir(dirname(tempAbs), { recursive: true })
    const command = [
      'ffmpeg',
      '-loglevel',
      'error',
      '-nostats',
      '-y',
      '-i',
      absolutePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(PROBE_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      tempAbs,
    ]
    try {
      let result: Awaited<ReturnType<FfmpegRunner['execute']>>
      try {
        result = await deps.ffmpeg.execute(command, {})
      } catch (e) {
        throw new AppError('EXPORT_FFMPEG_FAILED', {
          cause: e,
          params: { code: 'ENOENT' },
          details: {
            op: 'music:probe',
            reason: 'ffmpeg-not-found',
            file: label,
            command: formatCommandForDisplay(command),
            hint: '非 WAV 素材需要 ffmpeg 解码才能测量：请在设置里指定 ffmpeg 路径（docs/02 §5）',
          },
        })
      }
      if (result.exitCode !== 0) {
        throw new AppError('UNSUPPORTED_FORMAT', {
          params: { name: label },
          details: {
            op: 'music:probe',
            file: label,
            exitCode: result.exitCode,
            command: formatCommandForDisplay(result.command),
            stderr: result.stderr.slice(-1000),
          },
        })
      }
      const file = await readAudioFile(root, tempRel)
      return {
        durationMs: file.format.sampleRate > 0 ? Math.round((file.frames / file.format.sampleRate) * 1000) : 0,
        peakDb: measurePeak(file.mono),
        rmsDb: measureRms(file.mono),
        // 源文件的真实规格需要 ffprobe；这里如实返回**解码后**的规格（48k 单声道）
        sampleRate: file.format.sampleRate,
        channels: file.format.channels,
      }
    } finally {
      await rm(tempAbs, { force: true }).catch(() => {
        /* 临时文件清不掉不影响测量结果 */
      })
    }
  }

  function measurePeak(samples: Float32Array): number | null {
    if (samples.length === 0) return null
    let peak = 0
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i] as number)
      if (v > peak) peak = v
    }
    if (peak <= 0) return -100
    return Math.round(20 * Math.log10(peak) * 10) / 10
  }

  function measureRms(samples: Float32Array): number | null {
    if (samples.length === 0) return null
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += (samples[i] as number) ** 2
    const rms = Math.sqrt(sum / samples.length)
    if (rms <= 0) return -100
    return Math.round(20 * Math.log10(rms) * 10) / 10
  }

  /**
   * 引用该素材的混音轨。
   *
   * 两处都要查（DDL 里同时存在关系表与 JSON 列）：
   *   · `mix_tracks`（关系表，带 `ref_id`，也有 `music_config` JSON）；
   *   · `mix_projects.tracks`（整份方案的 JSON —— `mix:save` 写的就是它）。
   * 只查一处会出现「界面把素材换成别的了，但 JSON 里还留着 id」这种漏网，
   * 于是删素材就真的把还在引用的文件删掉了。
   */
  function referencingTracks(assetId: Id): Array<{ trackId: Id; name: string; where: string }> {
    const db = requireDb()
    const out: Array<{ trackId: Id; name: string; where: string }> = []
    const relational = db
      .prepare(
        `SELECT t.id AS track_id, t.name
           FROM mix_tracks t
          WHERE t.ref_id = ?
             OR (t.music_config IS NOT NULL AND t.music_config LIKE ?)`,
      )
      .all(assetId, `%"assetId":"${assetId}"%`) as Array<{ track_id: string; name: string }>
    for (const r of relational) out.push({ trackId: r.track_id, name: r.name, where: 'mix_tracks' })

    const projects = db
      .prepare(`SELECT id, name FROM mix_projects WHERE tracks LIKE ?`)
      .all(`%"assetId":"${assetId}"%`) as Array<{ id: string; name: string }>
    for (const p of projects) out.push({ trackId: p.id, name: p.name, where: 'mix_projects.tracks' })
    return out
  }

  return {
    async importFiles(projectId, files, kind) {
      if (files.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'music:import', reason: 'no-files', hint: '没有要导入的文件' },
        })
      }
      if (!(await deps.projectExists(projectId))) {
        throw new AppError('NOT_FOUND', {
          details: { entity: 'project', projectId, hint: '项目不存在：素材必须归属一个项目（按项目隔离）' },
        })
      }
      const repo = deps.repo()
      const imported: MusicAsset[] = []

      for (const file of files) {
        const ext = extname(file).slice(1).toLowerCase()
        if (!SUPPORTED_MUSIC_EXTENSIONS.includes(ext as (typeof SUPPORTED_MUSIC_EXTENSIONS)[number])) {
          throw new AppError('UNSUPPORTED_FORMAT', {
            params: { name: basename(file) },
            details: {
              op: 'music:import',
              file,
              reason: 'unsupported-extension',
              supported: [...SUPPORTED_MUSIC_EXTENSIONS],
            },
          })
        }
        let sourceInfo: { size: number }
        try {
          sourceInfo = await stat(file)
        } catch (e) {
          throw new AppError('FILE_NOT_FOUND', { cause: e, details: { op: 'music:import', file } })
        }
        if (!sourceInfo.size) {
          throw new AppError('UNSUPPORTED_FORMAT', {
            params: { name: basename(file) },
            details: { op: 'music:import', file, reason: 'empty-file' },
          })
        }

        // 先落盘、再入库：反过来的话，入库成功而复制失败会留下一条指向不存在文件的记录
        const assetId = newId('music')
        const filePath = `music/${kind}/${assetId}.${ext}`
        const dest = resolveAudioPath(projectAudioRoot(deps.projectRoot(), projectId), filePath)
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(file, dest)

        const name = basename(file, extname(file))
        let asset: MusicAsset
        try {
          asset = await repo.insert({
            projectId,
            kind,
            name,
            filePath,
            originalName: basename(file),
            tags: [],
            loopable: false,
          })
        } catch (e) {
          // 入库失败要把刚复制的文件清掉，否则留下一个没人认领的素材
          await rm(dest, { force: true }).catch(() => {})
          throw e
        }

        // 元数据尽力而为：测不出来（没装 ffmpeg / 损坏文件）不该让导入失败 —— 文件已经托管好了，
        // 用户仍能在列表里看到它，只是指标为空（界面上会显示「未探测」）
        try {
          const measured = await measureFile(projectId, dest, name)
          asset = await repo.saveMetrics(asset.id, {
            durationMs: measured.durationMs,
            sampleRate: measured.sampleRate,
            channels: measured.channels,
            peakDb: measured.peakDb,
            lufs: null,
          })
        } catch (e) {
          deps.log?.warn?.('music.metadataFailed', {
            event: 'music.metadataFailed',
            assetId: asset.id,
            file: name,
            reason: e instanceof Error ? e.message : String(e),
            note: '导入本身已成功（文件已托管）：指标留空，用户可稍后重试「探测」',
          })
        }
        imported.push(asset)
        deps.log?.info?.('music.imported', {
          event: 'music.imported',
          assetId: asset.id,
          projectId,
          kind,
          filePath,
          bytes: sourceInfo.size,
        })
      }
      return imported
    },

    async list(projectId, kind) {
      return deps.repo().list(projectId, kind)
    },

    async probe(assetId) {
      const repo = deps.repo()
      const asset = await repo.get(assetId)
      if (!asset) throw new AppError('NOT_FOUND', { details: { entity: 'music_asset', assetId } })
      const abs = absOf(asset)
      let info: { size: number; mtimeMs: number }
      try {
        info = await stat(abs)
      } catch (e) {
        throw new AppError('FILE_NOT_FOUND', {
          cause: e,
          details: { op: 'music:probe', assetId, filePath: asset.filePath },
        })
      }
      const measured = await measureFile(asset.projectId, abs, asset.name)
      const updated = await repo.saveMetrics(assetId, {
        durationMs: measured.durationMs,
        sampleRate: measured.sampleRate,
        channels: measured.channels,
        peakDb: measured.peakDb,
        lufs: null,
      })
      deps.log?.info?.('music.probed', {
        event: 'music.probed',
        assetId,
        durationMs: measured.durationMs,
        peakDb: measured.peakDb,
        rmsDb: measured.rmsDb,
      })
      const metrics: AudioMetrics = {
        filePath: asset.filePath,
        fileSize: info.size,
        mtime: Math.round(info.mtimeMs),
        durationMs: measured.durationMs,
        peakDb: measured.peakDb,
        // 真实峰值需要 4 倍过采样（ffmpeg ebur128）；没有就是没有，不拿峰值冒充
        truePeakDb: null,
        rmsDb: measured.rmsDb,
        lufs: updated.lufs,
        lra: null,
        sampleRate: measured.sampleRate,
        channels: measured.channels,
        measuredAt: now(),
      }
      return metrics
    },

    async remove(assetId) {
      const repo = deps.repo()
      const asset = await repo.get(assetId)
      if (!asset) throw new AppError('NOT_FOUND', { details: { entity: 'music_asset', assetId } })
      const used = referencingTracks(assetId)
      if (used.length > 0) {
        // 删文件会让引用它的轨道在渲染时突然没有素材（而且是「渲染到一半才报错」）
        throw new AppError('CONFLICT', {
          details: {
            op: 'music:delete',
            reason: 'asset-in-use',
            assetId,
            tracks: used.slice(0, 10),
            count: used.length,
            hint: '先把这些轨道上的素材换掉或清空，再删除素材',
          },
        })
      }
      // 先删文件、再删行（见文件头第 3 条）
      const abs = absOf(asset)
      try {
        await rm(abs, { force: true })
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          throw new AppError('PERMISSION_DENIED', {
            cause: e,
            details: { op: 'music:delete', assetId, filePath: asset.filePath },
          })
        }
      }
      const ok = await repo.remove(assetId)
      deps.log?.info?.('music.removed', {
        event: 'music.removed',
        assetId,
        filePath: asset.filePath,
        ok,
      })
      return { ok }
    },
  }
}
