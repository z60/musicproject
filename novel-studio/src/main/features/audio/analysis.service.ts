/**
 * Novel Studio · 分析服务（`analysis:metrics` / `analysis:peaks` / `analysis:noiseProfile`）
 * ============================================================================
 * 设计依据：
 *   · docs/05 §8「响度测量」、§11.3「峰值金字塔（LOD 100/10/1 peaks/s）」
 *   · docs/12 §11「设备自检的测量项」（底噪、峰值、RMS、削波）
 *   · docs/20 §4.x `analysis:*` 三个通道的请求/响应
 *
 * ### 三个通道各自的定位
 *   · `metrics`   —— 「这段音频什么水平」：时长、采样率、声道、峰值、RMS、LUFS。
 *     结果**按文件大小 + mtime 缓存**在 `audio_metrics` 表里（同一段音频会被 UI 反复问）。
 *   · `peaks`     —— 「画波形」：按 peaksPerSec 抽取 min/max 包络（`shared/audio/peaks.ts`）。
 *     不缓存：它依赖 peaksPerSec / 时间范围，缓存收益低、失效逻辑复杂。
 *   · `noiseProfile` —— 「这段静音里的底噪是多少」：取区间 RMS 并给出建议噪声门。
 *
 * ### 哪些测量值可能为 null（如实返回，不编造）
 *   · `lufs` / `lra` / `truePeakDb` 需要 ffmpeg 的 `loudnorm` / `ebur128` 两遍法测量
 *     （docs/05 §8）。**没有 ffmpeg 或没接线时它们是 `null`** —— 而不是拿峰值冒充响度。
 *   · 定位方式：`{ path }` 或 `{ segmentId }`（后者查 `voice_segments.file_path`）。
 */

import { AppError } from '../../../shared/errors.ts'
import type { AudioMetrics, Id } from '../../../shared/types.ts'
import { computePeaks } from '../../../shared/audio/peaks.ts'
import { computeRmsDb, linearToDb, sliceSamples, SILENCE_FLOOR_DB } from '../../../shared/audio/pcm.ts'
import type { DbLike } from '../../infra/db/types.ts'
import type { Logger } from '../../infra/log/index.ts'
import { readAudioFile, resolveAudioPath, toProjectRelative } from './audio-file.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { AudioProjectScope } from './project-scope.ts'
import type { AudioMetricsRepo } from './repositories/audio-metrics.repo.ts'

/** 定位一段音频（契约允许两种写法，二选一） */
export interface AudioLocator {
  path?: string
  segmentId?: Id
}

export interface AnalysisServiceDeps {
  getDb: () => DbLike | null
  /** `{userData}/projects`（项目目录的父目录） */
  projectRoot: () => string
  /**
   * 音频路径 → 所属项目（库里的相对路径是相对 `{projectRoot}/{projectId}` 的，
   * 见 `project-scope.ts` 的说明；少了它就会读错目录，docs/91 §5.2.19）
   */
  scope: AudioProjectScope
  /** 测量缓存仓储（按当前 db 现取） */
  metricsRepo: () => AudioMetricsRepo
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface PeaksResult {
  peaks: number[]
  channels: number
  totalPeaks: number
}

export interface NoiseProfileResult {
  rmsDb: number
  suggestedNf: number
}

export interface AnalysisService {
  metrics(locator: AudioLocator): Promise<AudioMetrics>
  peaks(locator: AudioLocator & { peaksPerSec: number; fromMs?: number; toMs?: number }): Promise<PeaksResult>
  noiseProfile(segmentId: Id, startMs: number, endMs: number): Promise<NoiseProfileResult>
}

/**
 * 建议噪声门 = 底噪 RMS + 6 dB。
 *
 * 为什么是 +6：噪声门要**高于**底噪才不会把底噪本身当成语音（+3 太贴，稍有起伏就漏；
 * +12 会把气声剪掉）。6 dB 是「底噪之上一个明显台阶」，与 docs/05 §8 的降噪建议一致。
 */
export const NOISE_GATE_MARGIN_DB = 6

export function createAnalysisService(deps: AnalysisServiceDeps): AnalysisService {
  /**
   * 解析出「要分析哪个文件」。
   *
   * 契约里 `path` 与 `segmentId` 都是可选的 —— 两个都没给就没法定位，
   * 这里明确抛 `INVALID_PAYLOAD`（而不是猜一个文件：猜错会把别的行/别的书的电平显示给用户）。
   *
   * 返回值里**一定带上 projectId**：库里的 `file_path` 是相对项目目录的，
   * 只拼 `projectRoot` 会拼到项目外的同名路径（那是 docs/91 §5.2.19 的真问题）。
   */
  async function resolveTarget(
    locator: AudioLocator,
  ): Promise<{ root: string; relativePath: string; absolutePath: string }> {
    const projectRoot = deps.projectRoot()
    if (locator.path !== undefined && locator.path !== null && locator.path !== '') {
      const projectId = await deps.scope.projectIdOfPath(locator.path)
      const root = projectAudioRoot(projectRoot, projectId)
      const absolutePath = resolveAudioPath(root, locator.path)
      return { root, relativePath: toProjectRelative(root, absolutePath), absolutePath }
    }
    if (locator.segmentId) {
      const db = deps.getDb()
      if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'analysis' } })
      const row = db
        .prepare(`SELECT file_path FROM voice_segments WHERE id = ?`)
        .get(locator.segmentId) as { file_path: string } | undefined
      if (!row) {
        throw new AppError('NOT_FOUND', { details: { entity: 'voice_segment', segmentId: locator.segmentId } })
      }
      const projectId = await deps.scope.projectIdOfSegment(locator.segmentId)
      const root = projectAudioRoot(projectRoot, projectId)
      return { root, relativePath: row.file_path, absolutePath: resolveAudioPath(root, row.file_path) }
    }
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        op: 'analysis',
        reason: 'no-locator',
        hint: '必须给 path 或 segmentId 之一（契约里两者都是可选的，但不能都不给）',
      },
    })
  }

  return {
    async metrics(locator) {
      const target = await resolveTarget(locator)
      const file = await readAudioFile(target.root, target.relativePath)

      // 缓存命中判据：路径 + 大小 + mtime（三者都对才复用，见 audio-metrics.repo.ts 的注释）
      const repo = deps.metricsRepo()
      const cached = await repo.get(file.relativePath, file.fileSize, file.mtime)
      if (cached) return cached

      const peakDb = file.mono.length > 0 ? computePeakLinearToDb(file.mono) : null
      const rmsDb = file.mono.length > 0 ? clampSilence(computeRmsDb(file.mono)) : null

      const metrics: AudioMetrics = {
        filePath: file.relativePath,
        fileSize: file.fileSize,
        mtime: file.mtime,
        durationMs:
          file.format.sampleRate > 0 ? Math.round((file.mono.length / file.format.sampleRate) * 1000) : 0,
        peakDb,
        // 真实峰值需要 4 倍过采样（ffmpeg ebur128 才有）；没有 ffmpeg 就如实留 null
        truePeakDb: null,
        rmsDb,
        // LUFS / LRA 同样需要 ffmpeg 的 loudnorm/ebur128 两遍法（docs/05 §8）
        lufs: null,
        lra: null,
        sampleRate: file.format.sampleRate,
        channels: file.format.channels,
        measuredAt: Date.now(),
      }
      await repo.put(metrics)
      deps.log?.info?.('analysis.metrics', {
        event: 'analysis.metrics',
        path: metrics.filePath,
        durationMs: metrics.durationMs,
        peakDb,
        rmsDb,
      })
      return metrics
    },

    async peaks(locator) {
      const target = await resolveTarget(locator)
      const file = await readAudioFile(target.root, target.relativePath)
      let samples = file.mono
      if (locator.fromMs !== undefined || locator.toMs !== undefined) {
        const from = Math.max(0, locator.fromMs ?? 0)
        const to =
          locator.toMs ?? (file.format.sampleRate > 0 ? (samples.length / file.format.sampleRate) * 1000 : 0)
        samples = sliceSamples(samples, from, to, file.format.sampleRate)
      }
      const raw = computePeaks(samples, {
        peaksPerSec: locator.peaksPerSec,
        sampleRate: file.format.sampleRate,
      })
      // 契约里 peaks 是 number[]；`computePeaks` 给的是 int16（min/max 交替），
      // 这里换算成 [-1,1] 的归一化幅度 —— 渲染侧的 waveform-transform 就是按这个口径写的
      const peaks: number[] = new Array(raw.length)
      for (let i = 0; i < raw.length; i++) peaks[i] = Number(((raw[i] as number) / 32767).toFixed(4))
      return {
        peaks,
        channels: file.format.channels,
        // 每桶两个点（min/max）→ 桶数 = 总点数 / 2
        totalPeaks: Math.floor(peaks.length / 2),
      }
    },

    async noiseProfile(segmentId, startMs, endMs) {
      const target = await resolveTarget({ segmentId })
      const file = await readAudioFile(target.root, target.relativePath)
      const from = Math.max(0, Math.min(startMs, endMs))
      const to = Math.max(from, Math.max(startMs, endMs))
      if (to <= from) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'analysis:noiseProfile', reason: 'empty-range', startMs, endMs },
        })
      }
      const slice = sliceSamples(file.mono, from, to, file.format.sampleRate)
      if (slice.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'analysis:noiseProfile', reason: 'range-out-of-file', startMs, endMs },
        })
      }
      const rmsDb = clampSilence(computeRmsDb(slice))
      return {
        rmsDb,
        suggestedNf: round1(rmsDb + NOISE_GATE_MARGIN_DB),
      }
    },
  }
}

/**
 * 数字静音的 RMS 是 `-Infinity`（`linearToDb(0)`）—— 这里夹到 {@link SILENCE_FLOOR_DB}。
 *
 * 为什么不直接把 -Infinity 发给渲染侧：
 *   1. `JSON.stringify(-Infinity)` 会变成 **`null`** —— 界面拿到 null、`toFixed` 直接崩；
 *   2. 底噪「无信号」和「-100 dBFS 以下」在工程上是一件事，给一个有限值更好比较与显示。
 * 这个下限常量来自 `shared/audio/pcm.ts`（`SILENCE_FLOOR_DB`），全仓库同一口径。
 */
function clampSilence(db: number): number {
  if (!Number.isFinite(db)) return SILENCE_FLOOR_DB
  return db < SILENCE_FLOOR_DB ? SILENCE_FLOOR_DB : db
}

/** 峰值（线性）→ dBFS */
function computePeakLinearToDb(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number)
    if (v > peak) peak = v
  }
  return round1(linearToDb(peak))
}

function round1(v: number): number {
  return Number.isFinite(v) ? Number(v.toFixed(1)) : v
}
