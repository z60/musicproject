/**
 * 测试 · 音频域（`analysis:*` / `device:*`）
 * ============================================================================
 * 设计依据：docs/05 §8/§11、docs/12 §11、docs/20 §4.5
 *
 * ### 为什么用真 WAV 文件 + 真 SQLite
 *   `analysis:*` 的整个价值就是「把盘上那段音频的真实测量值报出来」。用假数据测
 *   只能证明「函数被调用了」，证明不了**测量口径**：
 *   · 位深 16/24/32 的解码路径各不一样（32 位是 float，不是 int）
 *   · 峰值/RMS 的 dB 换算一旦搞反（线性 vs dB），UI 上就是「-0.0 dB 满电平」
 *   · 多声道下混写错会把左右声道当成两个样本 → 时长差一倍
 *
 *   所以这里用 `shared/audio/*` 的**写盘函数**造真文件（44 字节头 + PCM），
 *   再用服务读回来比对；测量缓存也要验证「同文件不重复测、内容变了要重测」。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat, DeviceSelfTestResult } from '../../src/shared/types.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToFloat32LE, float32ToInt16LE, float32ToInt24LE } from '../../src/shared/audio/pcm.ts'
import { createAnalysisService, NOISE_GATE_MARGIN_DB } from '../../src/main/features/audio/analysis.service.ts'
import { createDeviceService, suggestSelfTestFix } from '../../src/main/features/audio/device.service.ts'
import { createTakeService } from '../../src/main/features/audio/take.service.ts'
import { createSqliteTakeRepo } from '../../src/main/features/audio/repositories/take.repo.sqlite.ts'
import { createMemoryTakeRepo } from '../../src/main/features/audio/repositories/take.repo.ts'
import { createMemoryVoiceSegmentRepo } from '../../src/main/features/audio/repositories/voice-segment.repo.ts'
import { createSqliteAudioMetricsRepo } from '../../src/main/features/audio/repositories/audio-metrics.repo.ts'
import { createAudioProjectScope } from '../../src/main/features/audio/project-scope.ts'
import { createRecordService } from '../../src/main/features/audio/record.service.ts'
import { createSqliteRecordingSessionRepo } from '../../src/main/features/audio/repositories/recording-session.repo.sqlite.ts'
import { createSqliteVoiceSegmentRepo } from '../../src/main/features/audio/repositories/voice-segment.repo.ts'
import { createSettingsStore } from '../../src/main/settings.ts'
import { createAudioHandlers } from '../../src/main/ipc/handlers/audio.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'

// ---------------------------------------------------------------------------
// 测试台：真临时目录 + 真 WAV + 真库
// ---------------------------------------------------------------------------

/** 库内音频相对路径的基准是 {projectRoot}/{projectId}（docs/03 §2） */
const PROJECT_ID = 'p1'

interface Harness {
  root: string
  db: DatabaseSync
  analysis: ReturnType<typeof createAnalysisService>
  device: ReturnType<typeof createDeviceService>
  settings: ReturnType<typeof createSettingsStore>
  handlers: ReturnType<typeof createAudioHandlers>
  cleanup: () => void
}

function makeWav(opts: { format: AudioFormat; seconds: number; amplitude: number; silentFrom?: number }): Buffer {
  const frames = Math.round(opts.format.sampleRate * opts.seconds)
  const channels: Float32Array[] = []
  for (let c = 0; c < opts.format.channels; c++) {
    const ch = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const ms = (i / opts.format.sampleRate) * 1000
      ch[i] = opts.silentFrom !== undefined && ms >= opts.silentFrom ? 0 : opts.amplitude
    }
    channels.push(ch)
  }
  // 交织
  const interleaved = new Float32Array(frames * opts.format.channels)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < opts.format.channels; c++) {
      interleaved[i * opts.format.channels + c] = channels[c]![i] as number
    }
  }
  const payload =
    opts.format.bitDepth === 16
      ? float32ToInt16LE(interleaved)
      : opts.format.bitDepth === 24
        ? float32ToInt24LE(interleaved)
        : float32ToFloat32LE(interleaved)
  return Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: opts.format }), payload])
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-audio-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike

  // 真机启动时会 `ensureDefault` 建一个默认项目（契约里没有 project:create 通道）。
  // 音频路径的基准是 `{projectRoot}/{projectId}`，所以测试台也必须先有这个项目
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)

  const settings = createSettingsStore({
    db: dbLike,
    pathDefaults: {
      projectRoot: root,
      exportDir: join(root, 'exports'),
      ffmpegPath: null,
      modelDir: join(root, 'models'),
      cacheDir: join(root, 'cache'),
      backupDir: join(root, 'backups'),
    },
  })

  const scope = createAudioProjectScope({ getDb: () => dbLike })

  const analysis = createAnalysisService({
    getDb: () => dbLike,
    projectRoot: () => root,
    scope,
    metricsRepo: () => createSqliteAudioMetricsRepo(dbLike),
  })
  const device = createDeviceService({ settings: () => settings })
  // take / record 服务在本文件里只为了让 handler 工厂的依赖齐全
  // （它们自己的测试在 take-service.test.ts / record-service.test.ts）
  const take = createTakeService({
    projectRoot: () => root,
    scope,
    takeRepo: () => createMemoryTakeRepo(),
    segmentRepo: () => createMemoryVoiceSegmentRepo(),
    lineChapterId: async () => 'c1',
  })
  const record = createRecordService({
    projectRoot: () => root,
    scope,
    sessionRepo: () => createSqliteRecordingSessionRepo(dbLike),
    takeRepo: () => createSqliteTakeRepo(dbLike),
    segmentRepo: () => createSqliteVoiceSegmentRepo(dbLike),
    lineChapterId: async () => 'c1',
    lineCharCounts: async () => [],
  })

  return {
    root,
    db,
    analysis,
    device,
    settings,
    handlers: createAudioHandlers({ analysis, device, take, record, log: { info: () => {}, warn: () => {} } }),
    cleanup: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function call(h: Harness, channel: string, payload: unknown): Promise<unknown> {
  const spec = h.handlers.find((x) => x.channel === channel)
  assert.ok(spec, `没有登记 ${channel}`)
  const schema = schemaFor(channel)
  assert.ok(schema, `契约里没有 ${channel} 的 schema`)
  return await spec.run(schema.parse(payload) as never, {} as never)
}

function writeWavFile(h: Harness, relativePath: string, buf: Buffer): string {
  const abs = join(h.root, PROJECT_ID, relativePath)
  // 子目录要显式创建（真机上这些目录由录音/切片流程创建；测试里直接造文件）
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buf)
  return abs
}

/** 往库里插一条 voice_segments（analysis 的 segmentId 定位路径要用） */
function seedSegment(h: Harness, id: string, relativePath: string): void {
  h.db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
             VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  h.db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
             VALUES ('c1', 'b1', 1, '章', 'chapter', '正文', 2, 0, 2, 'none', 0, 1, 1)`)
  h.db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('l1', 'c1', 'b1', 0, '台词', 0, 2, 500, 'recorded', 0, '[]', 0, 1, 1, 1)`)
  h.db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, created_at, updated_at)
             VALUES ('${id}', 'l1', 'c1', '${relativePath}', 0, 1000, 1000, 1, 1)`)
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

describe('音频域 · analysis:metrics', () => {
  it('16/24/32 三种位深都能读，且时长/峰值/RMS 口径一致', async () => {
    const h = await harness()
    try {
      // 0.5 幅度正弦？不用正弦：常数 0.5 的峰值与 RMS 都是 -6.02 dB，便于精确断言
      for (const bitDepth of [16, 24, 32] as const) {
        const format: AudioFormat = { sampleRate: 48000, bitDepth, channels: 1 }
        const rel = `takes/amp-${bitDepth}.wav`
        writeWavFile(h, rel, makeWav({ format, seconds: 0.1, amplitude: 0.5 }))

        const m = await h.analysis.metrics({ path: rel })
        assert.equal(m.sampleRate, 48000)
        assert.equal(m.channels, 1)
        assert.ok(Math.abs(m.durationMs - 100) <= 2, `时长应约 100ms，实际 ${m.durationMs}`)
        assert.ok(Math.abs((m.peakDb ?? 0) - -6) <= 0.2, `峰值应约 -6 dBFS，实际 ${m.peakDb}`)
        assert.ok(Math.abs((m.rmsDb ?? 0) - -6) <= 0.2, `常数信号的 RMS 也应约 -6 dBFS，实际 ${m.rmsDb}`)
        // LUFS / 真峰值需要 ffmpeg 两遍法；没接线就如实为空（不是 0、不是猜的）
        assert.equal(m.lufs, null)
        assert.equal(m.truePeakDb, null)
      }
    } finally {
      h.cleanup()
    }
  })

  it('多声道下混不会把时长算成两倍', async () => {
    const h = await harness()
    try {
      const format: AudioFormat = { sampleRate: 44100, bitDepth: 16, channels: 2 }
      writeWavFile(h, 'takes/stereo.wav', makeWav({ format, seconds: 0.2, amplitude: 0.25 }))
      const m = await h.analysis.metrics({ path: 'takes/stereo.wav' })
      assert.equal(m.channels, 2)
      assert.ok(Math.abs(m.durationMs - 200) <= 3, `双声道 0.2s 应当是 200ms，实际 ${m.durationMs}`)
    } finally {
      h.cleanup()
    }
  })

  it('测量结果按「路径 + 大小 + mtime」缓存；文件换了内容必须重测', async () => {
    const h = await harness()
    try {
      const format: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }
      const abs = writeWavFile(h, 'takes/cache.wav', makeWav({ format, seconds: 0.05, amplitude: 0.5 }))
      const first = await h.analysis.metrics({ path: 'takes/cache.wav' })
      assert.ok(Math.abs((first.peakDb ?? 0) - -6) <= 0.2)

      // 同内容再问一次 → 命中缓存（measuredAt 不变）
      const again = await h.analysis.metrics({ path: 'takes/cache.wav' })
      assert.equal(again.measuredAt, first.measuredAt, '同文件同样大小/mtime 应命中缓存')

      // 换内容（幅度 0.1 → 峰值约 -20 dB），并把 mtime 改掉，模拟「重录覆盖同名文件」
      writeFileSync(abs, makeWav({ format, seconds: 0.05, amplitude: 0.1 }))
      const future = new Date(Date.now() + 5000)
      utimesSync(abs, future, future)
      const third = await h.analysis.metrics({ path: 'takes/cache.wav' })
      assert.notEqual(third.measuredAt, first.measuredAt, '内容变了必须重测')
      assert.ok(Math.abs((third.peakDb ?? 0) - -20) <= 0.5, `重测后峰值应约 -20 dBFS，实际 ${third.peakDb}`)
    } finally {
      h.cleanup()
    }
  })

  it('segmentId 定位：查 voice_segments 的 file_path；不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      const format: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }
      writeWavFile(h, 'segments/s1.wav', makeWav({ format, seconds: 0.1, amplitude: 0.5 }))
      seedSegment(h, 'seg1', 'segments/s1.wav')

      const m = await h.analysis.metrics({ segmentId: 'seg1' })
      assert.equal(m.filePath, 'segments/s1.wav', '落库口径应是项目根相对路径')

      await assert.rejects(
        () => h.analysis.metrics({ segmentId: 'ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('两个定位参数都不给 → INVALID_PAYLOAD；文件不存在 → FILE_NOT_FOUND；非 WAV → INVALID_PAYLOAD', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.analysis.metrics({}),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.analysis.metrics({ path: 'takes/nope.wav' }),
        (e: unknown) => e instanceof AppError && e.key === 'FILE_NOT_FOUND',
      )
      const mp3 = join(h.root, PROJECT_ID, 'takes/mp3.mp3')
      mkdirSync(dirname(mp3), { recursive: true })
      writeFileSync(mp3, Buffer.from('ID3 fake mp3 bytes'))
      await assert.rejects(
        () => h.analysis.metrics({ path: 'takes/mp3.mp3' }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
        '非 WAV 必须明确报「不支持」而不是返回一堆 null 假装测过',
      )
    } finally {
      h.cleanup()
    }
  })

  it('handler 层：analysis:metrics / analysis:peaks / analysis:noiseProfile 都走通契约', async () => {
    const h = await harness()
    try {
      const format: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }
      writeWavFile(h, 'segments/s2.wav', makeWav({ format, seconds: 0.2, amplitude: 0.5, silentFrom: 100 }))
      seedSegment(h, 'seg2', 'segments/s2.wav')

      const metrics = (await call(h, 'analysis:metrics', { segmentId: 'seg2' })) as { durationMs: number }
      assert.ok(Math.abs(metrics.durationMs - 200) <= 3)

      const peaks = (await call(h, 'analysis:peaks', { segmentId: 'seg2', peaksPerSec: 100 })) as {
        peaks: number[]
        totalPeaks: number
        channels: number
      }
      assert.equal(peaks.channels, 1)
      assert.ok(peaks.totalPeaks >= 18 && peaks.totalPeaks <= 22, `0.2s × 100/s ≈ 20 个桶，实际 ${peaks.totalPeaks}`)
      assert.equal(peaks.peaks.length, peaks.totalPeaks * 2, '每桶两个点（min/max）')
      assert.ok(peaks.peaks.every((p) => p >= -1 && p <= 1), '幅度必须归一化到 [-1,1]')
      assert.ok(peaks.peaks.some((p) => Math.abs(p) > 0.4), '有信号的部分应出现 0.5 幅度的峰值')

      // 静音区间（100ms 之后）的底噪 + 建议噪声门
      const noise = (await call(h, 'analysis:noiseProfile', { segmentId: 'seg2', startMs: 120, endMs: 190 })) as {
        rmsDb: number
        suggestedNf: number
      }
      assert.ok(noise.rmsDb < -80, `静音段 RMS 应当很低，实际 ${noise.rmsDb}`)
      assert.ok(Math.abs(noise.suggestedNf - (noise.rmsDb + NOISE_GATE_MARGIN_DB)) < 0.11)

      // 区间为空 → 明确报错
      await assert.rejects(
        () => call(h, 'analysis:noiseProfile', { segmentId: 'seg2', startMs: 150, endMs: 150 }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// device
// ---------------------------------------------------------------------------

describe('音频域 · device:*', () => {
  it('偏好写进设置；label 快照能被 list 读回；空 label 不覆盖已有快照', async () => {
    const h = await harness()
    try {
      assert.deepEqual(await call(h, 'device:list', undefined), { devices: [], preferred: null })

      await call(h, 'device:savePreference', { deviceId: 'dev-1', label: 'USB 麦克风' })
      const first = (await call(h, 'device:list', undefined)) as {
        devices: Array<{ deviceId: string; label: string; isDefault: boolean }>
        preferred: string | null
      }
      assert.equal(first.preferred, 'dev-1')
      assert.deepEqual(first.devices.map((d) => `${d.deviceId}:${d.label}:${d.isDefault}`), [
        'dev-1:USB 麦克风:true',
      ])

      // 未授权时渲染侧只能给空 label：不能把好快照抹掉
      await call(h, 'device:savePreference', { deviceId: 'dev-1', label: '   ' })
      const second = (await call(h, 'device:list', undefined)) as { devices: Array<{ label: string }> }
      assert.equal(second.devices[0]?.label, 'USB 麦克风', '空 label 不该覆盖已有快照')

      // 空 deviceId → 拒绝
      await assert.rejects(
        () => call(h, 'device:savePreference', { deviceId: '   ', label: 'x' }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })

  it('自检结果落库，并按四项检查补一条建议', async () => {
    const h = await harness()
    try {
      const withSignal: DeviceSelfTestResult = {
        hasSignal: true,
        clipping: false,
        droppedFrames: 0,
        noiseFloorDb: -60,
        peakDb: -12,
        rmsDb: -24,
        requestedSampleRate: 48000,
        actualSampleRate: 48000,
        latencyMs: 12,
        suggestion: null,
      }
      await call(h, 'device:selfTestResult', { result: withSignal })
      assert.equal(h.settings.current().audio.lastSelfTest?.suggestion, null, '一切正常就不该编一条建议')

      const clipping = { ...withSignal, clipping: true }
      await call(h, 'device:selfTestResult', { result: clipping })
      assert.ok(h.settings.current().audio.lastSelfTest?.suggestion?.includes('削波'))

      const noSignal = { ...withSignal, hasSignal: false }
      assert.ok(suggestSelfTestFix(noSignal)?.includes('没有检测到输入信号'))
      const dropped = { ...withSignal, droppedFrames: 3 }
      assert.ok(suggestSelfTestFix(dropped)?.includes('丢帧'))
      const noisy = { ...withSignal, noiseFloorDb: -30 }
      assert.ok(suggestSelfTestFix(noisy)?.includes('底噪偏高'))
      const rateMismatch = { ...withSignal, actualSampleRate: 44100 }
      assert.ok(suggestSelfTestFix(rateMismatch)?.includes('采样率'))
    } finally {
      h.cleanup()
    }
  })
})
