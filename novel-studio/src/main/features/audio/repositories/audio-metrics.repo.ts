/**
 * Novel Studio · 音频测量缓存仓储（`audio_metrics` 表）
 * ============================================================================
 * 设计依据：docs/21 §6「audio_metrics（按文件路径缓存测量结果）」、docs/05 §8
 *
 * ### 为什么要有缓存
 *   测量一个文件要把它整个读进内存做扫描（几 MB~几十 MB），而 UI 里同一段音频会被
 *   反复问「电平多少」（`analysis:metrics` 在混音台、AB 对比、行编辑抽屉、轨道列表里都会调）。
 *   缓存键是 **文件路径 + 文件大小 + mtime**：三者任一变了就重新测 —— 这正是
 *   「重新录了一条」/「处理链生成了新文件」的判据（内容变了 mtime 必变）。
 *
 * ### 为什么不用「路径」单独做键
 *   `segments/{id}.wav` 这类文件名是**稳定**的：同一行重录会覆盖同名文件。
 *   只按路径缓存会永远返回旧电平 —— 那比不缓存更糟（用户看到的是上个版本的数字）。
 */

import type { AudioMetrics } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'

/** 缓存条目 = `AudioMetrics` + 失效判据（fileSize/mtime 已在类型里） */
export type CachedMetrics = AudioMetrics & { filePath: string }

export interface AudioMetricsRepo {
  /** 命中且未失效时返回缓存的测量结果；否则 null（调用方需要重新测量） */
  get(relativePath: string, fileSize: number, mtime: number): Promise<AudioMetrics | null>
  put(metrics: AudioMetrics): Promise<void>
  /** 删除某文件的缓存（文件被删/被替换时用） */
  remove(relativePath: string): Promise<void>
}

interface AudioMetricsRow {
  file_path: string
  file_size: number
  mtime: number
  duration_ms: number
  peak_db: number | null
  true_peak_db: number | null
  rms_db: number | null
  lufs: number | null
  lra: number | null
  sample_rate: number | null
  channels: number | null
  measured_at: number
}

function fromRow(row: AudioMetricsRow): CachedMetrics {
  return {
    filePath: row.file_path,
    fileSize: row.file_size,
    mtime: row.mtime,
    durationMs: row.duration_ms,
    peakDb: row.peak_db,
    truePeakDb: row.true_peak_db,
    rmsDb: row.rms_db,
    lufs: row.lufs,
    lra: row.lra,
    sampleRate: row.sample_rate,
    channels: row.channels,
    measuredAt: row.measured_at,
  }
}

/** 创建 SQLite 版测量缓存仓储（表在 001_init.sql 里） */
export function createSqliteAudioMetricsRepo(db: DbLike): AudioMetricsRepo {
  return {
    async get(relativePath: string, fileSize: number, mtime: number): Promise<AudioMetrics | null> {
      const row = db
        .prepare(`SELECT * FROM audio_metrics WHERE file_path = ?`)
        .get(relativePath) as AudioMetricsRow | undefined
      if (!row) return null
      // 失效判据：大小或 mtime 变了 → 内容变了 → 缓存作废
      if (row.file_size !== fileSize || row.mtime !== mtime) return null
      return fromRow(row)
    },

    async put(metrics: AudioMetrics): Promise<void> {
      db.prepare(
        `INSERT INTO audio_metrics
           (file_path, file_size, mtime, duration_ms, peak_db, true_peak_db, rms_db, lufs, lra,
            sample_rate, channels, measured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           file_size = excluded.file_size, mtime = excluded.mtime, duration_ms = excluded.duration_ms,
           peak_db = excluded.peak_db, true_peak_db = excluded.true_peak_db, rms_db = excluded.rms_db,
           lufs = excluded.lufs, lra = excluded.lra, sample_rate = excluded.sample_rate,
           channels = excluded.channels, measured_at = excluded.measured_at`,
      ).run(
        metrics.filePath,
        metrics.fileSize,
        metrics.mtime,
        metrics.durationMs,
        metrics.peakDb,
        metrics.truePeakDb,
        metrics.rmsDb,
        metrics.lufs,
        metrics.lra,
        metrics.sampleRate,
        metrics.channels,
        metrics.measuredAt,
      )
    },

    async remove(relativePath: string): Promise<void> {
      db.prepare(`DELETE FROM audio_metrics WHERE file_path = ?`).run(relativePath)
    },
  }
}

/** 内存实现（测试与「无数据库」场景；语义与 SQLite 版一致） */
export function createMemoryAudioMetricsRepo(seed?: { metrics?: AudioMetrics[] }): AudioMetricsRepo {
  const map = new Map<string, AudioMetrics>()
  for (const m of seed?.metrics ?? []) map.set(m.filePath, { ...m })
  return {
    async get(relativePath, fileSize, mtime) {
      const m = map.get(relativePath)
      if (!m || m.fileSize !== fileSize || m.mtime !== mtime) return null
      return { ...m }
    },
    async put(metrics) {
      map.set(metrics.filePath, { ...metrics })
    },
    async remove(relativePath) {
      map.delete(relativePath)
    },
  }
}

/** 供上层构造缓存键时的自检（路径必须是项目根相对路径，避免同文件两种写法各缓存一份） */
export function isRelativeCacheKey(path: string): boolean {
  return !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/')
}
