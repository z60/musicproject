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
function fakePort(): RecordPortLike & {
  send(samples: Float32Array): void
  /** 按原始载荷投递（用于测试"认不出的形状"/类型化数组视图） */
  deliver(payload: unknown): void
  closed: boolean
  started: boolean
} {
  const listeners: Array<(e: { data: unknown }) => void> = []
  return {
    closed: false,
    started: false,
    on(_event, listener) {
      listeners.push(listener)
    },
    start() {
      this.started = true
    },
    close() {
      this.closed = true
    },
    deliver(payload) {
      for (const l of listeners) l({ data: payload })
    },
    send(samples) {
      const buf = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)
      this.deliver({ frames: samples.length, data: buf })
    },
  }
}

interface Harness {
  root: string
  db: DatabaseSync
  record: RecordService
  handlers: ReturnType<typeof createAudioHandlers>
  events: Array<{ event: string; payload: Record<string, unknown> }>
  /** 服务写出的日志（用于断言"失败必须可见"这类不变量，docs/91 §5.2.41~§5.2.43） */
  logs: Array<{ level: string; event: string; data: Record<string, unknown> }>
  cleanup: () => void
}

async function harness(opts?: {
  freeBytes?: number
  markLineRecorded?: (lineId: string) => Promise<{ from: never; to: never; changed: boolean } | null>
}): Promise<Harness> {
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
  const logs: Array<{ level: string; event: string; data: Record<string, unknown> }> = []

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
    ...(opts?.markLineRecorded ? { markLineRecorded: opts.markLineRecorded } : {}),
    log: {
      info: (event, data) => logs.push({ level: 'info', event, data: data ?? {} }),
      warn: (event, data) => logs.push({ level: 'warn', event, data: data ?? {} }),
      error: (event, data) => logs.push({ level: 'error', event, data: data ?? {} }),
    },
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
    logs,
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
      // 声称累计发了 48000 帧，实际只写了 9600 帧 → 差额必须被记成丢帧。
      // **要连续两次采样**才算确认（单次可能只是"数据还在途中"，见下一条用例）
      await h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, claimedFrames: 48000 })
      await h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, claimedFrames: 48000 })

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

  /**
   * 丢帧核对的口径（真机事故 docs/91 §5.2.41 复查时补）：
   * 端口（数据）与 record:meter（声称值）是两条独立通道，到达顺序不保证。
   */
  it('单次采样有缺口只是「在途」，不计丢帧（否则健康会话开头就报丢帧 2304）', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)

      // 声称发了 9600 帧，但数据还没到主进程（在途）
      await h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, claimedFrames: 9600 })
      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.equal(result.session.droppedFrames, 0, '在途块补齐前不得计入丢帧')
    } finally {
      h.cleanup()
    }
  })

  it('缺口持续存在时确认为丢帧，且同一次丢失只累计一次', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)

      const meter = (claimedFrames: number) =>
        h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, claimedFrames })
      await meter(9600) // 第一次：未知是否在途
      await meter(9600) // 第二次：缺口依旧 → 确认 9600
      await meter(9600) // 第三、四次：不能重复累加
      await meter(9600)

      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.equal(result.session.droppedFrames, 9600, '持续缺口只应计一次（不随采样次数累加）')
    } finally {
      h.cleanup()
    }
  })

  it('缺口扩大（又丢一块）时只累加新增部分', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)

      const meter = (claimedFrames: number) =>
        h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, claimedFrames })
      await meter(9600)
      await meter(9600) // 确认 9600
      await meter(19200) // 又丢一块（还没确认）
      await meter(19200) // 确认到 19200

      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.equal(result.session.droppedFrames, 19200, '缺口扩大只累加新增的那一块')
    } finally {
      h.cleanup()
    }
  })

  it('缺口被追上（数据到达）后清零，后续不再算丢帧', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)

      await h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, claimedFrames: 9600 })
      // 数据补上（写盘 9600 帧）→ 缺口归零
      port.send(block(0.2, 0.5))
      await h.record.onMeter({ sessionId: prepared.sessionId, rmsDb: -6, peakDb: -6, claimedFrames: 9600 })
      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.equal(result.session.droppedFrames, 0, '在途补齐后不得留下丢帧')
    } finally {
      h.cleanup()
    }
  })

  /**
   * 真机事故 docs/91 §5.2.42：
   * 端口已 attached、渲染侧一直在发，但主进程 `written` 恒为 0 ——
   * 因为 `MessagePortMain` 在 `start()` 之前**把消息一直排队**。
   * 端口有两条绑定路径（先到会话 / 先到端口），两条都必须 start()。
   */
  it('端口排队时不该 start()，被会话认领后必须 start()（否则一条块都收不到）', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      h.record.attachIncomingPort(port)
      assert.equal(port.started, false, '还没有 ready 会话：端口只是排队，不该动它')

      // prepare 会认领排队的端口（"端口先于会话到达"这条路径）
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      assert.equal(port.started, true, 'MessagePortMain 必须先 start() 才会投递消息')

      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.equal(result.session.droppedFrames, 0, 'start() 之后数据必须真的写进去')
      assert.ok((result.session.durationMs ?? 0) >= 190, `时长应约 200ms，实际 ${result.session.durationMs}`)
    } finally {
      h.cleanup()
    }
  })

  it('端口晚于会话到达时（直接绑定）同样必须 start()', async () => {
    const h = await harness()
    try {
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      const port = fakePort()
      h.record.attachIncomingPort(port)
      assert.equal(port.started, true, '有 ready 会话时端口被立即绑定 → 必须 start()')

      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.ok((result.session.durationMs ?? 0) >= 190, `时长应约 200ms，实际 ${result.session.durationMs}`)
    } finally {
      h.cleanup()
    }
  })

  it('端口载荷是类型化数组视图（而非 ArrayBuffer）时同样要写盘', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)

      // 模拟 Electron 反序列化后给出的 Uint8Array 视图（§5.2.41 的 `instanceof` 判断会把它丢掉）
      const samples = block(0.2, 0.5)
      const bytes = new Uint8Array(samples.buffer.slice(0))
      port.deliver({ frames: samples.length, data: bytes })

      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.ok((result.session.durationMs ?? 0) >= 190, `视图形态也必须被解释成音频，实际 ${result.session.durationMs}ms`)
      assert.equal(result.session.droppedFrames, 0)
    } finally {
      h.cleanup()
    }
  })

  /**
   * 真机事故 docs/91 §5.2.43：发送侧一旦带 transfer 列表，主进程收到的
   * `event.data` **恒为 null**（事件照发、渲染侧不报错）。这种"消息到了但载荷是空"
   * 的情况必须留下日志，否则又是"录了 3 秒、盘上 0 字节、什么都没有"。
   */
  it('消息体是 null 时必须记 record.portMessage.nullPayload（不许静默丢弃）', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)

      port.deliver(null)
      port.deliver(null) // 只报一次
      const nullLogs = h.logs.filter((l) => l.event === 'record.portMessage.nullPayload')
      assert.equal(nullLogs.length, 1, '必须报一次、且只报一次')
      assert.equal(nullLogs[0]!.level, 'error')
      assert.equal(nullLogs[0]!.data.sessionId, prepared.sessionId)
      assert.deepEqual(nullLogs[0]!.data.received, { kind: 'null' })

      // 空载荷不该影响会话：随后来的正常块照样写盘
      port.send(block(0.2, 0.5))
      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.ok((result.session.durationMs ?? 0) >= 190, '空载荷之后正常的块仍然要写进去')
    } finally {
      h.cleanup()
    }
  })

  it('认不出的载荷形状要记 record.portMessage.unsupported（带类型描述）', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)

      port.deliver({ frames: 9600, data: 'not-a-buffer' })
      const bad = h.logs.filter((l) => l.event === 'record.portMessage.unsupported')
      assert.equal(bad.length, 1, '认不出的形状必须报一次')
      assert.equal(bad[0]!.level, 'error')
      assert.equal((bad[0]!.data.received as { kind?: string }).kind, 'string', '要说明收到的是什么类型')
    } finally {
      h.cleanup()
    }
  })

  it('第一个有效块要记 record.portFirstBlock（端口真的在投递的正面证据）', async () => {
    const h = await harness()
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.2, 0.5))
      port.send(block(0.2, 0.5))

      const first = h.logs.filter((l) => l.event === 'record.portFirstBlock')
      assert.equal(first.length, 1, '只记第一个块')
      assert.equal(first[0]!.data.frames, 9600)
      assert.equal(first[0]!.data.bytes, 9600 * 4)
    } finally {
      h.cleanup()
    }
  })

  /**
   * 真机事故 docs/91 §5.2.44：录音保存成功了，但**画本行状态从没被推进成 recorded**，
   * 于是画本表格没有 ✓、章节进度 recorded_count 恒为 0、QC 统计「已录行 0」，
   * 用户看到的就是「点击停止没有把当前录制的保存」。
   */
  it('录完一行后必须把画本行推进到 recorded（docs/12 §3.3）', async () => {
    const marked: Array<{ lineId: string; state: string }> = []
    const h = await harness({
      markLineRecorded: async (lineId) => {
        const before = h.db.prepare(`SELECT state FROM canvas_lines WHERE id = ?`).get(lineId) as { state: string }
        h.db.prepare(`UPDATE canvas_lines SET state = 'recorded' WHERE id = ?`).run(lineId)
        marked.push({ lineId, state: before.state })
        return { from: before.state as never, to: 'recorded' as never, changed: true }
      },
    })
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.3, 0.5))
      const result = await h.record.stop(prepared.sessionId, 'l1')

      assert.ok(result.take, '先要有 take')
      assert.deepEqual(marked, [{ lineId: 'l1', state: 'draft' }], '必须对刚录的那一行调用一次')
      const row = h.db.prepare(`SELECT state FROM canvas_lines WHERE id = 'l1'`).get() as { state: string }
      assert.equal(row.state, 'recorded', '画本行状态要真的落库')
      assert.equal(
        h.logs.filter((l) => l.event === 'record.lineRecorded').length,
        1,
        '要有 record.lineRecorded 日志（可检索）',
      )
    } finally {
      h.cleanup()
    }
  })

  it('太短没有 take 时不得推进行状态（避免把没录上的行标成已录）', async () => {
    const marked: string[] = []
    const h = await harness({
      markLineRecorded: async (lineId) => {
        marked.push(lineId)
        return null
      },
    })
    try {
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      // 一个块都没有 → tooShort → 不产 take
      const result = await h.record.stop(prepared.sessionId, 'l1')
      assert.equal(result.take, null)
      assert.deepEqual(marked, [], '没有 take 就不该标已录')
    } finally {
      h.cleanup()
    }
  })

  it('没有注入 markLineRecorded 时要记 unwired 警告（这类静默缺口必须可见）', async () => {
    const h = await harness()
    try {
      // harness 默认注入了 markLineRecorded？—— 没有的话走 unwired 分支
      const port = fakePort()
      const prepared = await h.record.prepare({ projectId: PROJECT_ID, chapterId: 'c1', mode: 'line_by_line', format: FORMAT })
      h.record.attachIncomingPort(port)
      await h.record.attachPort(prepared.sessionId)
      await h.record.start(prepared.sessionId)
      port.send(block(0.3, 0.5))
      await h.record.stop(prepared.sessionId, 'l1')
      const wired = h.logs.some((l) => l.event === 'record.lineRecorded')
      const unwired = h.logs.some((l) => l.event === 'record.lineRecorded.unwired')
      assert.ok(wired || unwired, '要么真的推进了状态，要么明确报"没接线"——不许什么都不说')
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
