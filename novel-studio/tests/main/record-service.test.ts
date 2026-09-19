/**
 * 测试 · 录音域（`record:*` 12 个通道）
 * ============================================================================
 * 设计依据：docs/12 §2/§3.2/§3.3/§4.3/§8.2、docs/05 §2/§5.3/§9、docs/20 §4.5
 *
 * ### 这组测试覆盖什么、**不覆盖**什么（如实说明）
 *   覆盖：会话落库与文件（先落库再开文件）、采集块写盘与头部回填、
 *   端口认领顺序（先到先认领 / 缺席时明确报错）、定稿测量、静音修剪、
 *   最短录音保护、补录拼接（前段 + 本次 + 后段）、VAD 切片 → 匹配 → 接受、
 *   `optimizeTrim` 只报区间不改文件、标记与丢帧的单向通道。
 *
 *   **不覆盖**：Electron 的 `MessagePortMain` 与真实麦克风。Node 里没有
 *   `MessagePortMain`，所以端口用一个「能 on('message') 的对象」替代（`fakePort`），
 *   真实链路（preload 的 `ipcRenderer.postMessage` 转移端口）只能在真机验证，
 *   已记入 docs/91 §4 的未验证清单 —— 不在这里假装测过。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat, Take, TrimOptions, VadOptions } from '../../src/shared/types.ts'
import { VAD_DEFAULTS } from '../../src/shared/constants.ts'
import { parseWavHeader } from '../../src/shared/audio/wav.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createAudioProjectScope } from '../../src/main/features/audio/project-scope.ts'
import {
  createRecordService,
  type RecordPortLike,
  type RecordService,
} from '../../src/main/features/audio/record.service.ts'
import { createSqliteRecordingSessionRepo } from '../../src/main/features/audio/repositories/recording-session.repo.sqlite.ts'
import { createSqliteTakeRepo } from '../../src/main/features/audio/repositories/take.repo.sqlite.ts'
import { createSqliteVoiceSegmentRepo } from '../../src/main/features/audio/repositories/voice-segment.repo.ts'
import { createAudioHandlers } from '../../src/main/ipc/handlers/audio.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'
import { createAnalysisService } from '../../src/main/features/audio/analysis.service.ts'
import { createDeviceService } from '../../src/main/features/audio/device.service.ts'
import { createTakeService } from '../../src/main/features/audio/take.service.ts'
import { createSqliteAudioMetricsRepo } from '../../src/main/features/audio/repositories/audio-metrics.repo.ts'
import { createSettingsStore } from '../../src/main/settings.ts'

const PROJECT_ID = 'p1'
const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }

/** 假装一个采集端口：只实现本服务用到的那一小面（见文件头说明） */
function fakePort(): RecordPortLike & { send(samples: Float32Array): void; closed: boolean } {
  const listeners: Array<(e: { data: unknown }) => void> = []
  return {
    closed: false,
    on(_event, listener) {
      listeners.push(listener)
    },
    close() {
      this.closed = true
    },
    send(samples) {
      const buf = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)
      for (const l of listeners) l({ data: { frames: samples.length, data: buf } })
    },
  }
}

interface Harness {
  root: string
  db: DatabaseSync
  record: RecordService
  handlers: ReturnType<typeof createAudioHandlers>
  events: Array<{ event: string; payload: Record<string, unknown> }>
  cleanup: () => void
}

async function harness(opts?: { freeBytes?: number }): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-record-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike

  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', '${PROJECT_ID}', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '章', 'chapter', '正文', 2, 0, 2, 'generated', 3, 1, 1)`)
  // 三行：l1 短（匹配用）、l2 中等、l3 长（对齐时应当被跳过的候选）
  const texts: Array<[string, string]> = [
    ['l1', '你好'],
    ['l2', '这是一句比较长的台词用于测试'],
    ['l3', '再加一句'],
  ]
  texts.forEach(([id, text], i) => {
    db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('${id}', 'c1', 'b1', ${i}, '${text}', 0, ${text.length}, 500, 'draft', 0, '[]', 0, 1, 1, 1)`)
  })

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
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []

  let idSeq = 0
  const record = createRecordService({
    projectRoot: () => root,
    scope,
    sessionRepo: () => createSqliteRecordingSessionRepo(dbLike),
    takeRepo: () => createSqliteTakeRepo(dbLike),
    segmentRepo: () => createSqliteVoiceSegmentRepo(dbLike),
    lineChapterId: async (lineId) => {
      const row = db.prepare(`SELECT chapter_id FROM canvas_lines WHERE id = ?`).get(lineId) as
        | { chapter_id: string }
        | undefined
      return row?.chapter_id ?? null
    },
    lineCharCounts: async (chapterId) => {
      const rows = db
        .prepare(`SELECT id, LENGTH(text) AS n FROM canvas_lines WHERE chapter_id = ? ORDER BY seq ASC`)
        .all(chapterId) as Array<{ id: string; n: number }>
      return rows.map((r) => ({ lineId: r.id, charCount: r.n }))
    },
    audioSettings: () => ({ vad: VAD_DEFAULTS, trim: undefined }),
    freeBytes: () => opts?.freeBytes ?? 10 * 1024 * 1024 * 1024,
    events: {
      emit: (event, payload) => {
        events.push({ event, payload })
      },
    },
    newId: (prefix) => `${prefix}-${++idSeq}`,
    now: () => 1_700_000_000_000,
  })

  const analysis = createAnalysisService({
    getDb: () => dbLike,
    projectRoot: () => root,
    scope,
    metricsRepo: () => createSqliteAudioMetricsRepo(dbLike),
  })
  const device = createDeviceService({ settings: () => settings })
  const take = createTakeService({
    projectRoot: () => root,
    scope,
    takeRepo: () => createSqliteTakeRepo(dbLike),
    segmentRepo: () => createSqliteVoiceSegmentRepo(dbLike),
    lineChapterId: async () => 'c1',
  })

  return {
    root,
    db,
    record,
    events,
    handlers: createAudioHandlers({ analysis, device, take, record, log: { info: () => {}, warn: () => {} } }),
    cleanup: () => {
      record.closeAll('test-cleanup')
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

/** 一段可听的「语音」：常数幅度（便于精确断言峰值/RMS） */
function block(seconds: number, amplitude: number, format = FORMAT): Float32Array {
  const frames = Math.round(format.sampleRate * seconds)
  const out = new Float32Array(frames * format.channels)
  out.fill(amplitude)
  return out
}

/** 一段「语音 + 静音」：前 `speechMs` 有声，其余为 0（VAD/修剪用） */
function speechThenSilence(speechMs: number, silenceMs: number, amplitude = 0.5, format = FORMAT): Float32Array {
  const frames = Math.round((format.sampleRate * (speechMs + silenceMs)) / 1000)
  const out = new Float32Array(frames * format.channels)
  const speechFrames = Math.round((format.sampleRate * speechMs) / 1000)
  for (let i = 0; i < speechFrames; i++) out[i] = amplitude
  return out
}

/** 跑一次「准备 → 绑端口 → 开始 → 送块 → 停止」 */
async function recordOnce(
  h: Harness,
  opts: {
    lineId: string | null
    blocks: Float32Array[]
    trim?: TrimOptions
    mode?: 'line_by_line' | 'continuous' | 'punch_in' | 'role' | 'package'
  },
): Promise<Awaited<ReturnType<RecordService['stop']>>> {
  const port = fakePort()
  const prepared = await h.record.prepare({
    projectId: PROJECT_ID,
    chapterId: 'c1',
    mode: opts.mode ?? 'line_by_line',
    format: FORMAT,
  })
  h.record.attachIncomingPort(port)
  await h.record.attachPort(prepared.sessionId)
  await h.record.start(prepared.sessionId)
  for (const b of opts.blocks) port.send(b)
  return await h.record.stop(prepared.sessionId, opts.lineId, opts.trim)
}

const TRIM_ON: TrimOptions = { enabled: true, thresholdDb: -45, headPaddingMs: 50, tailPaddingMs: 50 }

// ---------------------------------------------------------------------------
// 会话生命周期
// ---------------------------------------------------------------------------

describe('录音域 · 会话生命周期', () => {
  it('prepare 建会话 + 建文件（先落库再开文件）；磁盘不足直接 DISK_FULL', async () => {
    const h = await harness()
    try {
      const prepared = await h.record.prepare({
        projectId: PROJECT_ID,
        chapterId: 'c1',
        mode: 'line_by_line',
        format: FORMAT,
      })
      const row = h.db
        .prepare(`SELECT status, file_path FROM recording_sessions WHERE id = ?`)
        .get(prepared.sessionId) as { status: string; file_path: string }
      assert.equal(row.status, 'active', '会话必须先落库为 active')
      assert.equal(row.file_path, `recordings/${prepared.sessionId}.wav`)
      // 文件落在 `{projectRoot}/{projectId}/` 下 —— 与 ns-media 协议同一基准
      assert.ok(existsSync(join(h.root, PROJECT_ID, row.file_path)), '会话文件必须已创建（含占位头）')
      h.record.closeAll('t')
    } finally {
      h.cleanup()
    }
  })

  it('磁盘不足 → DISK_FULL（不让用户念到一半才发现）', async () => {
    const h = await harness({ freeBytes: 1024 })
    try {
      await assert.rejects(
        () =>
          h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT }),
        (e: unknown) => e instanceof AppError && e.key === 'DISK_FULL',
      )
    } finally {
      h.cleanup()
    }
  })

  it('attachPort 没有端口 → INVALID_PAYLOAD（而不是「录了但没有文件」）', async () => {
    const h = await harness()
    try {
      const prepared = await h.record.prepare({
        projectId: PROJECT_ID,
        chapterId: 'c1',
        mode: 'line_by_line',
        format: FORMAT,
      })
      await assert.rejects(
        () => h.record.attachPort(prepared.sessionId),
        (e: unknown) =>
          e instanceof AppError && e.key === 'INVALID_PAYLOAD' && e.details?.reason === 'no-port-received',
      )
      // 端口缺席时不该把会话搞得半死不活：abort 仍要能把文件收掉
      await h.record.abort(prepared.sessionId, false)
      assert.equal(
        existsSync(join(h.root, PROJECT_ID, `recordings/${prepared.sessionId}.wav`)),
        false,
        'abort 必须能清理掉这个会话文件',
      )
    } finally {
      h.cleanup()
    }
  })

  it('pause 期间到达的块会计入 dropped_frames；resume 后继续写盘', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({
        projectId: PROJECT_ID,
        chapterId: 'c1',
        mode: 'line_by_line',
        format: FORMAT,
      })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      await h.record.pause(prepared.sessionId)
      port.send(block(0.1, 0.5)) // 暂停期间：不该进文件，但必须可见
      await h.record.resume(prepared.sessionId)
      port.send(block(0.2, 0.5))

      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.equal(result.session.droppedFrames > 0, true, '暂停期间的块必须计入 dropped_frames（P0 指标）')
      // 0.2 + 0.2 秒写进文件（暂停那段没写）
      assert.equal(result.take !== null, true)
      assert.ok(Math.abs((result.take as Take).durationMs - 400) <= 5, `落盘应约 400ms，实际 ${(result.take as Take).durationMs}`)
    } finally {
      h.cleanup()
    }
  })

  it('abort：keepFile=false 删文件、keepFile=true 留文件；会话状态置 aborted', async () => {
    const h = await harness()
    try {
      for (const keepFile of [false, true]) {
        const prepared = await h.record.prepare({
          projectId: PROJECT_ID,
          chapterId: 'c1',
          mode: 'line_by_line',
          format: FORMAT,
        })
        const abs = join(h.root, PROJECT_ID, `recordings/${prepared.sessionId}.wav`)
        await h.record.abort(prepared.sessionId, keepFile)
        assert.equal(existsSync(abs), keepFile, `keepFile=${keepFile} 时文件存在性应为 ${keepFile}`)
        const row = h.db
          .prepare(`SELECT status FROM recording_sessions WHERE id = ?`)
          .get(prepared.sessionId) as { status: string }
        assert.equal(row.status, 'aborted')
      }
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 定稿 → take
// ---------------------------------------------------------------------------

describe('录音域 · 停止与定稿（record:stop）', () => {
  it('写盘 → 头部回填 → 生成 take → 自动设为成品（含 segments 文件）', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, { lineId: 'l1', blocks: [block(0.3, 0.5)] })
      const take = result.take as Take
      assert.ok(take, '正常录音必须产出 take')
      assert.equal(take.durationMs, 300)
      assert.ok(Math.abs((take.peakDb ?? 0) - -6.02) <= 0.1, `0.5 幅度 → 峰值约 -6 dBFS，实际 ${take.peakDb}`)
      assert.equal(result.segment?.takeId, take.id, '成品必须指向这条 take（docs/12 §3.2）')

      // 文件头必须是回填过的（否则播放器按占位长度截断）
      const abs = join(h.root, PROJECT_ID, take.filePath)
      const parsed = parseWavHeader(readFileSync(abs))
      assert.equal(parsed.valid, true)
      assert.equal(parsed.dataBytes, 48000 * 0.3 * 2, 'data 长度字段必须等于真实载荷长度')
      assert.ok(existsSync(join(h.root, PROJECT_ID, result.segment!.filePath)), '成品文件也要落盘')

      // 会话定稿
      const s = h.db
        .prepare(`SELECT status, duration_ms, peak_db FROM recording_sessions WHERE id = ?`)
        .get(take.sessionId) as { status: string; duration_ms: number; peak_db: number }
      assert.equal(s.status, 'finalized')
      assert.equal(s.duration_ms, 300)
      assert.ok(s.peak_db < 0)
    } finally {
      h.cleanup()
    }
  })

  it('最短录音保护：< 150 ms 不产出 take（会话仍定稿保留）', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, { lineId: 'l1', blocks: [block(0.05, 0.5)] })
      assert.equal(result.take, null, '误触不该产出 take（docs/12 §3.3）')
      assert.equal(result.session.status, 'finalized')
      assert.equal(h.db.prepare(`SELECT COUNT(*) AS n FROM takes`).get()!['n'], 0)
    } finally {
      h.cleanup()
    }
  })

  it('没有 lineId（连续录制）：只定稿会话，不产出 take', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, { lineId: null, blocks: [block(0.5, 0.4)], mode: 'continuous' })
      assert.equal(result.take, null)
      assert.equal(result.segment, null)
      assert.equal(result.session.durationMs, 500)
    } finally {
      h.cleanup()
    }
  })

  it('静音修剪：take 只保留有声区间 + padding，会话文件保持完整', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, {
        lineId: 'l2',
        blocks: [speechThenSilence(200, 300)],
        trim: TRIM_ON,
      })
      const take = result.take as Take
      // 200 ms 有声 + 50 ms 尾留白 = 约 250 ms（首留白为 0：起点就是有声）
      assert.ok(Math.abs(take.durationMs - 250) <= 15, `修剪后应约 250ms，实际 ${take.durationMs}`)
      const session = h.db
        .prepare(`SELECT duration_ms, file_path FROM recording_sessions WHERE id = ?`)
        .get(take.sessionId) as { duration_ms: number; file_path: string }
      assert.ok(Math.abs(session.duration_ms - 500) <= 5, '会话文件**不修剪**（原始素材永不自动删，docs/12 §8.1）')
      const sessionAbs = join(h.root, PROJECT_ID, session.file_path)
      assert.equal(parseWavHeader(readFileSync(sessionAbs)).dataBytes, 48000 * 0.5 * 2)
    } finally {
      h.cleanup()
    }
  })

  it('全静音 + 开启修剪：不抛错、保留完整录音并打 all_silence 标（不丢用户的录音）', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, { lineId: 'l1', blocks: [block(0.3, 0)], trim: TRIM_ON })
      const take = result.take as Take
      assert.ok(take, '全静音也要留下 take（用户刚念的那一段不能消失）')
      assert.ok(take.flags.includes('all_silence'))
      assert.equal(take.durationMs, 300, '不做修剪 → 保留整段时长')
    } finally {
      h.cleanup()
    }
  })

  it('削波：峰值 ≥ -0.5 dBFS 时给 take 打 clip 标', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, { lineId: 'l1', blocks: [block(0.3, 1)] })
      assert.ok((result.take as Take).flags.includes('clip'), '满幅录音必须打 clip 标（docs/05 §2.5）')
    } finally {
      h.cleanup()
    }
  })

  it('handler 层：record:prepare → start → stop 走通契约', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = (await call(h, 'record:prepare', {
        projectId: PROJECT_ID,
        chapterId: 'c1',
        mode: 'line_by_line',
        format: FORMAT,
      })) as { sessionId: string; warnings: string[] }
      assert.ok(Array.isArray(prepared.warnings))
      h.record.attachIncomingPort(port)
      await call(h, 'record:attachPort', { sessionId: prepared.sessionId })
      await call(h, 'record:start', { sessionId: prepared.sessionId })
      port.send(block(0.2, 0.5))
      const stopped = (await call(h, 'record:stop', {
        sessionId: prepared.sessionId,
        lineId: 'l3',
        trim: TRIM_ON,
      })) as { take: Take; segment: { id: string } }
      assert.ok(stopped.take)
      assert.ok(stopped.segment)
      assert.equal(stopped.take.lineId, 'l3')

      // 状态事件必须发过（UI 的进度/时长来自它）
      assert.ok(h.events.some((e) => e.event === 'record:status' && e.payload.state === 'recording'))
      assert.ok(h.events.some((e) => e.event === 'record:status' && e.payload.state === 'done'))
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 补录
// ---------------------------------------------------------------------------

describe('录音域 · 补录（record:punchIn）', () => {
  it('拼接顺序 = 前段 + 本次录音 + 后段；新 take 保留原件', async () => {
    const h = await harness()
    try {
      // 先正常录一条 500 ms（幅度 0.5）
      const first = await recordOnce(h, { lineId: 'l1', blocks: [block(0.5, 0.5)] })
      const original = first.take as Take

      // 补录 100~300 ms 这一段（用等幅 0.5 的语音，长度 200 ms）
      const prepared = await h.record.punchIn({
        lineId: 'l1',
        srcInMs: 100,
        srcOutMs: 300,
        preRollMs: 100,
        postRollMs: 200,
      })
      const port = fakePort()
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      const punched = await h.record.stop(prepared.sessionId, 'l1')

      const merged = punched.take as Take
      assert.ok(merged, '补录必须产出 take')
      // 100（前段）+ 200（本次）+ 200（后段）= 500 ms
      assert.ok(Math.abs(merged.durationMs - 500) <= 10, `拼接后应约 500ms，实际 ${merged.durationMs}`)
      assert.ok(merged.flags.includes('punch_in'))
      assert.ok(merged.note?.includes(original.id), 'note 里要写清补录自哪条 take')
      // 原件保留（docs/12 §8.1：任何 take 都不自动删）
      const all = h.db.prepare(`SELECT id FROM takes WHERE line_id = 'l1' AND deleted_at IS NULL`).all()
      assert.equal(all.length, 2, '补录产生新 take，原件保留')
      // 成品指向新 take
      const seg = h.db.prepare(`SELECT take_id FROM voice_segments WHERE line_id = 'l1'`).get() as {
        take_id: string
      }
      assert.equal(seg.take_id, merged.id, '补录结果应当成为新的成品')
    } finally {
      h.cleanup()
    }
  })

  it('没有可补的 take → NOT_FOUND（而不是凭空造一条）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.record.punchIn({ lineId: 'l1', srcInMs: 0, srcOutMs: 100, preRollMs: 0, postRollMs: 0 }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 切片 / 匹配 / 接受
// ---------------------------------------------------------------------------

describe('录音域 · 连续录制（slice → matchSlices → acceptSlices）', () => {
  it('VAD 切片 → 匹配到画本行 → 接受后生成 take 与成品', async () => {
    const h = await harness()
    try {
      // 连续录一段：三句话用静音隔开（每句 400 ms + 静音 400 ms）
      const parts: Float32Array[] = []
      for (let i = 0; i < 3; i++) {
        parts.push(speechThenSilence(400, 400, 0.5))
      }
      const stopped = await recordOnce(h, { lineId: null, blocks: parts, mode: 'continuous' })
      const sessionId = stopped.session.id

      const vad: VadOptions = { ...VAD_DEFAULTS, charsPerSecond: 5 }
      const sliced = await h.record.slice(sessionId, vad)
      assert.ok(sliced.slices.length >= 3, `至少切出 3 片（实际 ${sliced.slices.length}）`)
      for (const s of sliced.slices) {
        assert.equal(s.sessionId, sessionId)
        assert.ok(s.endMs > s.startMs)
      }

      const matched = await h.record.matchSlices({
        sessionId,
        chapterId: 'c1',
        slices: sliced.slices,
      })
      assert.ok(matched.matches.length > 0, '必须能匹配上画本行')
      // 匹配是单调的：行顺序不能回退（否则时间线会自相矛盾）
      const lineOrder = new Map([['l1', 0], ['l2', 1], ['l3', 2]])
      let last = -1
      for (const m of matched.matches) {
        const idx = lineOrder.get(m.lineId) ?? -1
        assert.ok(idx >= last, '匹配顺序必须与行顺序一致')
        last = idx
        assert.ok(m.confidence > 0 && m.confidence <= 1)
      }

      const accepted = await h.record.acceptSlices(
        sessionId,
        matched.matches.filter((m) => m.lineId !== 'l2').slice(0, 2),
      )
      assert.ok(accepted.createdTakes >= 1)
      assert.equal(accepted.createdTakes, accepted.createdSegments, '每条 take 都要生成对应的成品')
      for (const row of h.db.prepare(`SELECT file_path FROM takes`).all() as Array<{ file_path: string }>) {
        assert.ok(existsSync(join(h.root, PROJECT_ID, row.file_path)), `take 文件必须存在：${row.file_path}`)
      }
    } finally {
      h.cleanup()
    }
  })

  it('已有成品的行会被跳过（不覆盖用户之前的成果）', async () => {
    const h = await harness()
    try {
      await recordOnce(h, { lineId: 'l1', blocks: [block(0.3, 0.5)] })
      const before = h.db.prepare(`SELECT take_id FROM voice_segments WHERE line_id = 'l1'`).get() as {
        take_id: string
      }

      const stopped = await recordOnce(h, { lineId: null, blocks: [speechThenSilence(400, 400)], mode: 'continuous' })
      const sliced = await h.record.slice(stopped.session.id, VAD_DEFAULTS)
      const res = await h.record.acceptSlices(stopped.session.id, [
        { sliceIndex: sliced.slices[0]!.sliceIndex, lineId: 'l1', confidence: 0.9 },
      ])
      assert.equal(res.createdTakes, 0)
      const after = h.db.prepare(`SELECT take_id FROM voice_segments WHERE line_id = 'l1'`).get() as {
        take_id: string
      }
      assert.equal(after.take_id, before.take_id, '已有成品不该被连续录制覆盖')
    } finally {
      h.cleanup()
    }
  })

  it('matchSlices 提交了不存在的 sliceIndex → INVALID_PAYLOAD', async () => {
    const h = await harness()
    try {
      const stopped = await recordOnce(h, { lineId: null, blocks: [speechThenSilence(400, 400)], mode: 'continuous' })
      await h.record.slice(stopped.session.id, VAD_DEFAULTS)
      await assert.rejects(
        () => h.record.acceptSlices(stopped.session.id, [{ sliceIndex: 999, lineId: 'l1', confidence: 0.9 }]),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })

  it('没有切片就匹配 → INVALID_PAYLOAD（并提示先切片）', async () => {
    const h = await harness()
    try {
      const stopped = await recordOnce(h, { lineId: null, blocks: [block(0.3, 0.5)], mode: 'continuous' })
      await assert.rejects(
        () => h.record.matchSlices({ sessionId: stopped.session.id, chapterId: 'c1', slices: [] }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 修剪建议 / 单向通道
// ---------------------------------------------------------------------------

describe('录音域 · optimizeTrim 与单向通道', () => {
  it('optimizeTrim 只报建议区间，不改文件', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, { lineId: 'l2', blocks: [speechThenSilence(200, 300)] })
      const take = result.take as Take
      const abs = join(h.root, PROJECT_ID, take.filePath)
      const before = readFileSync(abs)
      const range = await h.record.optimizeTrim(take.id, TRIM_ON)
      assert.ok(range.trimmedOutMs > range.trimmedInMs)
      assert.ok(Math.abs(range.trimmedOutMs - 250) <= 20, `建议终点应约 250ms，实际 ${range.trimmedOutMs}`)
      assert.deepEqual(readFileSync(abs), before, '优化修剪不得改动文件（非破坏性，docs/03 §6）')
    } finally {
      h.cleanup()
    }
  })

  it('record:mark / record:meter 单向通道：标记落库、帧差计入丢帧', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({
        projectId: PROJECT_ID,
        chapterId: 'c1',
        mode: 'line_by_line',
        format: FORMAT,
      })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      await h.record.onMark({ sessionId: prepared.sessionId, kind: 'retake', atMs: 120 })
      // 声称发了 48000 帧，实际只写了 9600 帧 → 差额必须被记成丢帧
      await h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, frames: 48000 })

      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.ok(result.session.droppedFrames > 0, '声明的帧数与落盘帧数的差额必须可见（P0 指标）')
      const marks = JSON.parse(
        (h.db.prepare(`SELECT marks FROM recording_sessions WHERE id = ?`).get(prepared.sessionId) as {
          marks: string
        }).marks,
      ) as Array<{ kind: string; atMs: number }>
      assert.deepEqual(marks, [{ kind: 'retake', atMs: 120 }])
    } finally {
      h.cleanup()
    }
  })

  it('closeAll 关掉文件句柄后，未定稿的会话文件仍在盘上（交给 recovery 修头）', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({
        projectId: PROJECT_ID,
        chapterId: 'c1',
        mode: 'line_by_line',
        format: FORMAT,
      })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      h.record.closeAll('quit')
      const abs = join(h.root, PROJECT_ID, `recordings/${prepared.sessionId}.wav`)
      assert.ok(existsSync(abs), '会话文件必须留在盘上（永不自动删）')
      assert.ok(readFileSync(abs).length >= 44 + 48000 * 0.2 * 2)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 路径基准（真问题回归）
// ---------------------------------------------------------------------------

describe('录音域 · 路径基准', () => {
  it('会话/take/成品文件都落在 {projectRoot}/{projectId}/ 下（ns-media 协议同一基准）', async () => {
    const h = await harness()
    try {
      const result = await recordOnce(h, { lineId: 'l1', blocks: [block(0.2, 0.5)] })
      const take = result.take as Take
      assert.ok(take.filePath.startsWith('takes/l1/'), '落库路径是项目内相对路径')
      assert.ok(existsSync(join(h.root, PROJECT_ID, take.filePath)), '文件在 {projectRoot}/{projectId}/takes/...')
      assert.equal(existsSync(join(h.root, take.filePath)), false, '不得落在项目目录之外')
      // 会话文件同样
      const session = h.db
        .prepare(`SELECT file_path FROM recording_sessions WHERE id = ?`)
        .get(take.sessionId) as { file_path: string }
      assert.ok(existsSync(join(h.root, PROJECT_ID, session.file_path)))
      assert.equal(existsSync(join(h.root, session.file_path)), false)
    } finally {
      h.cleanup()
    }
  })

  it('重复 stop / 未知会话 → 明确报错（不是静默什么都不做）', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({
        projectId: PROJECT_ID,
        chapterId: 'c1',
        mode: 'line_by_line',
        format: FORMAT,
      })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      await h.record.stop(prepared.sessionId, 'l1')

      await assert.rejects(
        () => h.record.stop(prepared.sessionId, 'l1'),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
        '会话已从活跃表移除：再 stop 必须报「找不到会话」，否则会重复产出 take',
      )
      await assert.rejects(
        () => h.record.pause('sess-ghost'),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('会话库里不存在时 slice → NOT_FOUND（不会去猜一个文件）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.record.slice('sess-ghost', VAD_DEFAULTS),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})
