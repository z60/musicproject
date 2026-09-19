/**
 * 测试 · Take 域（`take:*` 6 个通道）
 * ============================================================================
 * 设计依据：docs/12 §3.3 / §8.1 / §8.2 / §9.1 / §13、docs/03 §6、docs/20 §4.5
 *
 * ### 为什么这组测试必须用真库 + 真文件
 *   take 域的每条语义都同时涉及**库**与**磁盘**：
 *   · 「设为成品」要写 `voice_segments`（对 line_id 唯一）**并且**把音频拷成
 *     `segments/{id}.wav` —— 只测库会漏掉「库里指向一个不存在的文件」这种最糟的状态；
 *   · 「合并分段」要按 partIndex 顺序拼接 PCM —— 顺序错了只有真听/真比对才能发现；
 *   · 「软删」是不出现但文件还在，「硬删」是行与文件都没 —— 两者必须分别验证。
 *   所以这里用真 SQLite（`:memory:` + 真迁移）+ 真临时目录 + 真 WAV（用 shared 的写盘函数造）。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat, Take } from '../../src/shared/types.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToInt16LE } from '../../src/shared/audio/pcm.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createTakeService, type TakeService } from '../../src/main/features/audio/take.service.ts'
import { createSqliteTakeRepo } from '../../src/main/features/audio/repositories/take.repo.sqlite.ts'
import { createSqliteVoiceSegmentRepo } from '../../src/main/features/audio/repositories/voice-segment.repo.ts'
import { createAudioHandlers } from '../../src/main/ipc/handlers/audio.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'
import { createAnalysisService } from '../../src/main/features/audio/analysis.service.ts'
import { createDeviceService } from '../../src/main/features/audio/device.service.ts'
import { createSqliteAudioMetricsRepo } from '../../src/main/features/audio/repositories/audio-metrics.repo.ts'
import { createAudioProjectScope } from '../../src/main/features/audio/project-scope.ts'
import { createRecordService } from '../../src/main/features/audio/record.service.ts'
import { createSqliteRecordingSessionRepo } from '../../src/main/features/audio/repositories/recording-session.repo.sqlite.ts'
import { createSettingsStore } from '../../src/main/settings.ts'

// ---------------------------------------------------------------------------
// 测试台
// ---------------------------------------------------------------------------

const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }

/** 库内音频相对路径的基准是 {projectRoot}/{projectId}（docs/03 §2） */
const PROJECT_ID = 'p1'

interface Harness {
  root: string
  db: DatabaseSync
  take: TakeService
  handlers: ReturnType<typeof createAudioHandlers>
  cleanup: () => void
}

/** 造一段真 WAV：`amplitude` 决定峰值（0.5 → -6 dBFS） */
function wavFile(h: Harness, rel: string, opts: { seconds: number; amplitude: number }): string {
  const frames = Math.round(FORMAT.sampleRate * opts.seconds)
  const samples = new Float32Array(frames).fill(opts.amplitude)
  const payload = float32ToInt16LE(samples)
  const abs = join(h.root, PROJECT_ID, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
  return rel
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-take-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike

  // 最小可用的画本上下文：projects → books → chapters → canvas_lines（takes 有外键）
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '章', 'chapter', '正文', 2, 0, 2, 'generated', 2, 1, 1)`)
  for (const id of ['l1', 'l2']) {
    db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('${id}', 'c1', 'b1', ${id === 'l1' ? 0 : 1}, '台词', 0, 2, 500, 'draft', 0, '[]', 0, 1, 1, 1)`)
  }

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

  const take = createTakeService({
    projectRoot: () => root,
    scope,
    takeRepo: () => createSqliteTakeRepo(dbLike),
    segmentRepo: () => createSqliteVoiceSegmentRepo(dbLike),
    lineChapterId: async (lineId) => {
      const row = db.prepare(`SELECT chapter_id FROM canvas_lines WHERE id = ?`).get(lineId) as
        | { chapter_id: string }
        | undefined
      return row?.chapter_id ?? null
    },
    newId: (() => {
      let n = 0
      return (prefix: string) => `${prefix}-${++n}`
    })(),
    now: () => 1_700_000_000_000,
  })

  const analysis = createAnalysisService({
    getDb: () => dbLike,
    projectRoot: () => root,
    scope,
    metricsRepo: () => createSqliteAudioMetricsRepo(dbLike),
  })
  const device = createDeviceService({ settings: () => settings })

  return {
    root,
    db,
    take,
    handlers: createAudioHandlers({
      analysis,
      device,
      take,
      record: createRecordService({
        projectRoot: () => root,
        scope,
        sessionRepo: () => createSqliteRecordingSessionRepo(dbLike),
        takeRepo: () => createSqliteTakeRepo(dbLike),
        segmentRepo: () => createSqliteVoiceSegmentRepo(dbLike),
        lineChapterId: async () => 'c1',
        lineCharCounts: async () => [],
      }),
      log: { info: () => {}, warn: () => {} },
    }),
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

/** 直接往库里插一条 take（模拟「录完一条」；录音域尚未落地） */
function seedTake(
  h: Harness,
  input: { id: string; lineId?: string; partIndex?: number; seconds?: number; amplitude?: number; recordedAt?: number },
): string {
  const lineId = input.lineId ?? 'l1'
  const rel = wavFile(h, `takes/${lineId}/${input.id}.wav`, {
    seconds: input.seconds ?? 0.2,
    amplitude: input.amplitude ?? 0.5,
  })
  h.db
    .prepare(
      `INSERT INTO takes (id, line_id, file_path, part_index, src_in_ms, src_out_ms, trimmed_in_ms, trimmed_out_ms,
                          duration_ms, gain_db, sample_rate, bit_depth, channels, source, flags, is_selected,
                          recorded_at, created_at)
       VALUES (?, ?, ?, ?, 0, 200, 0, 200, 200, 0, 48000, 16, 1, 'local', '[]', 0, ?, ?)`,
    )
    .run(input.id, lineId, rel, input.partIndex ?? 0, input.recordedAt ?? 1, input.recordedAt ?? 1)
  return rel
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

describe('Take 域 · 列表与打标', () => {
  it('按行取 take，按 partIndex 升序；按章取走 canvas_lines 关联', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 't2', partIndex: 1 })
      seedTake(h, { id: 't1', partIndex: 0 })
      seedTake(h, { id: 't3', lineId: 'l2', partIndex: 0 })

      const line1 = (await call(h, 'take:listByLine', { lineId: 'l1' })) as Take[]
      assert.deepEqual(line1.map((t) => t.id), ['t1', 't2'], '同一行的分段要按 partIndex 排')

      const chapter = (await call(h, 'take:listByChapter', { chapterId: 'c1' })) as Take[]
      assert.deepEqual(chapter.map((t) => t.id).sort(), ['t1', 't2', 't3'], '整章应包含两条 line 的 take')
    } finally {
      h.cleanup()
    }
  })

  it('take:flag 整体替换并去重/去空白；不存在的 take → NOT_FOUND', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 't1' })
      // 契约 schema 会先挡掉空字符串（`v.string().max(32)` 不允许空串），
      // 所以「服务层自己也过滤」这条走服务直调，别绕 schema
      const service = h.take
      const direct = await service.flag('t1', ['clip', ' clip ', '', 'noise'])
      assert.deepEqual(direct.flags, ['clip', 'noise'], '重复项与空白要归一掉（服务层兜底）')

      const updated = (await call(h, 'take:flag', { takeId: 't1', flags: ['clip', 'noise'] })) as Take
      assert.deepEqual(updated.flags, ['clip', 'noise'])

      // 整体替换（不是追加）
      const replaced = (await call(h, 'take:flag', { takeId: 't1', flags: ['reported'] })) as Take
      assert.deepEqual(replaced.flags, ['reported'])

      await assert.rejects(
        () => call(h, 'take:flag', { takeId: 'ghost', flags: ['x'] }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 设为成品
// ---------------------------------------------------------------------------

describe('Take 域 · 设为成品（take:setSelected）', () => {
  it('成品唯一：选中一条会把该行其它 take 的 is_selected 清零', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 't1' })
      seedTake(h, { id: 't2' })

      await call(h, 'take:setSelected', { lineId: 'l1', takeId: 't1' })
      let list = (await call(h, 'take:listByLine', { lineId: 'l1' })) as Take[]
      assert.deepEqual(list.filter((t) => t.isSelected).map((t) => t.id), ['t1'], '有且只有一个成品')

      await call(h, 'take:setSelected', { lineId: 'l1', takeId: 't2' })
      list = (await call(h, 'take:listByLine', { lineId: 'l1' })) as Take[]
      assert.deepEqual(list.filter((t) => t.isSelected).map((t) => t.id), ['t2'], '换成品后旧的必须被清掉')
    } finally {
      h.cleanup()
    }
  })

  it('产出 voice_segments 行 + 真文件（segments/{id}.wav），并写入实测峰值/时长', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 't1', seconds: 0.2, amplitude: 0.5 })
      const segment = (await call(h, 'take:setSelected', { lineId: 'l1', takeId: 't1' })) as {
        id: string
        filePath: string
        takeId: string
        durationMs: number
        peakDb: number | null
        chapterId: string
      }

      assert.equal(segment.takeId, 't1')
      assert.equal(segment.chapterId, 'c1', '成品行要带章节 id（对轨按章组织）')
      assert.ok(segment.filePath.startsWith('segments/'), `成品文件应落在 segments/ 下：${segment.filePath}`)
      assert.ok(existsSync(join(h.root, PROJECT_ID, segment.filePath)), '库里有行，盘上就必须有文件')
      assert.ok(Math.abs(segment.durationMs - 200) <= 3, `0.2s 的音频应约 200ms，实际 ${segment.durationMs}`)
      assert.ok(Math.abs((segment.peakDb ?? 0) - -6) <= 0.3, `0.5 幅度 → 约 -6 dBFS，实际 ${segment.peakDb}`)

      const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM voice_segments WHERE line_id = 'l1'`).get() as { n: number }
      assert.equal(rows.n, 1)
    } finally {
      h.cleanup()
    }
  })

  it('换成品时原地更新同一行（保住 segment id 与 created_at），并作废处理结果', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 't1', amplitude: 0.5 })
      seedTake(h, { id: 't2', amplitude: 0.05 })
      const first = (await call(h, 'take:setSelected', { lineId: 'l1', takeId: 't1' })) as { id: string }

      // 假装对成品做过处理（processed_path + preset_hash）
      h.db
        .prepare(`UPDATE voice_segments SET processed_path = 'processed/${first.id}.abc.wav', preset_hash = 'abc'`)
        .run()

      const second = (await call(h, 'take:setSelected', { lineId: 'l1', takeId: 't2' })) as {
        id: string
        takeId: string
        peakDb: number | null
        processedPath: string | null
        presetHash: string | null
      }
      assert.equal(second.id, first.id, '同一行的成品只有一个 id（对轨项按它关联）')
      assert.equal(second.takeId, 't2')
      assert.equal(second.processedPath, null, '换了音频 → 之前的处理结果必须作废（docs/03 §6）')
      assert.equal(second.presetHash, null)
      assert.ok(Math.abs((second.peakDb ?? 0) - -26) <= 1, `0.05 幅度 → 约 -26 dBFS，实际 ${second.peakDb}`)

      const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM voice_segments WHERE line_id = 'l1'`).get() as { n: number }
      assert.equal(rows.n, 1, 'voice_segments 对 line_id 唯一：不能插出第二行')
    } finally {
      h.cleanup()
    }
  })

  it('take 不属于该行 / take 不存在 → 明确报错（不静默）', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 't1', lineId: 'l2' })
      await assert.rejects(
        () => call(h, 'take:setSelected', { lineId: 'l1', takeId: 't1' }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
        '把别的行的 take 设为这一行的成品会同时破坏两行的成品关系',
      )
      await assert.rejects(
        () => call(h, 'take:setSelected', { lineId: 'l1', takeId: 'ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

describe('Take 域 · 删除（软删 / 硬删）', () => {
  it('软删：列表里消失、文件与行都还在、且不再当成品', async () => {
    const h = await harness()
    try {
      const rel = seedTake(h, { id: 't1' })
      await call(h, 'take:setSelected', { lineId: 'l1', takeId: 't1' })

      const res = (await call(h, 'take:delete', { takeId: 't1' })) as { ok: boolean }
      assert.equal(res.ok, true)

      const list = (await call(h, 'take:listByLine', { lineId: 'l1' })) as Take[]
      assert.deepEqual(list, [], '软删的 take 不出现在列表里')
      assert.equal(existsSync(join(h.root, PROJECT_ID, rel)), true, '软删必须保留文件（docs/12 §8.2）')

      const row = h.db.prepare(`SELECT deleted_at, is_selected FROM takes WHERE id = 't1'`).get() as {
        deleted_at: number | null
        is_selected: number
      }
      assert.notEqual(row.deleted_at, null, '软删 = 标记 deleted_at（004 迁移加的列）')
      assert.equal(row.is_selected, 0, '软删的 take 不能继续当成品')
    } finally {
      h.cleanup()
    }
  })

  it('硬删：行与文件都消失；指向它的成品被解绑但片段文件保留', async () => {
    const h = await harness()
    try {
      const rel = seedTake(h, { id: 't1' })
      const segment = (await call(h, 'take:setSelected', { lineId: 'l1', takeId: 't1' })) as { id: string }

      const res = (await call(h, 'take:delete', { takeId: 't1', hard: true })) as { ok: boolean }
      assert.equal(res.ok, true)
      assert.equal(existsSync(join(h.root, PROJECT_ID, rel)), false, '硬删要删文件')
      const row = h.db.prepare(`SELECT COUNT(*) AS n FROM takes WHERE id = 't1'`).get() as { n: number }
      assert.equal(row.n, 0)

      const seg = h.db.prepare(`SELECT take_id, file_path FROM voice_segments WHERE id = ?`).get(segment.id) as {
        take_id: string | null
        file_path: string
      }
      assert.equal(seg.take_id, null, 'take 没了 → 成品行解绑（ON DELETE SET NULL）')
      assert.ok(existsSync(join(h.root, PROJECT_ID, seg.file_path)), '成品文件是拷贝，不受 take 文件删除影响')
    } finally {
      h.cleanup()
    }
  })

  it('硬删一条已软删的 take：文件也要删掉（否则「彻底删除」名不副实）', async () => {
    const h = await harness()
    try {
      const rel = seedTake(h, { id: 't1' })
      await call(h, 'take:delete', { takeId: 't1' })
      await call(h, 'take:delete', { takeId: 't1', hard: true })
      assert.equal(existsSync(join(h.root, PROJECT_ID, rel)), false)

      await assert.rejects(
        () => call(h, 'take:delete', { takeId: 't1', hard: true }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 合并分段
// ---------------------------------------------------------------------------

describe('Take 域 · 合并分段（take:combineParts）', () => {
  it('按 partIndex 顺序拼接（而不是用户勾选顺序），生成新 take 并设为成品', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 'p0', partIndex: 0, seconds: 0.1, amplitude: 0.5 })
      seedTake(h, { id: 'p1', partIndex: 1, seconds: 0.3, amplitude: 0.05 })

      // 故意把顺序反着传
      const res = (await call(h, 'take:combineParts', { lineId: 'l1', takeIds: ['p1', 'p0'] })) as { takeId: string }
      const merged = (await call(h, 'take:listByLine', { lineId: 'l1' })) as Take[]
      const created = merged.find((t) => t.id === res.takeId)
      assert.ok(created, JSON.stringify(merged.map((t) => t.id)))
      assert.equal(created.durationMs, 400, '0.1s + 0.3s = 0.4s（顺序反了这里也是 400，所以还要看下面的分段标记）')
      assert.ok((created.note ?? '').includes('part 0+1'), `合并说明要写清分段顺序：${created.note}`)
      assert.equal(created.partIndex, 2, '合成结果排在所有分段之后')
      assert.equal(created.isSelected, true, '合并的意图就是得到可用成品')
      assert.ok(created.flags.includes('merged'))

      // 原分段保留（「任何 take 都不自动删除」）
      assert.deepEqual(
        merged.filter((t) => t.id === 'p0' || t.id === 'p1').length,
        2,
        '分段本身必须保留',
      )
      // 成品指向合并结果
      const seg = h.db.prepare(`SELECT take_id FROM voice_segments WHERE line_id = 'l1'`).get() as {
        take_id: string | null
      }
      assert.equal(seg.take_id, res.takeId)
    } finally {
      h.cleanup()
    }
  })

  it('不足两段 / 只给一段 / 同一 partIndex → INVALID_PAYLOAD', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 'p0', partIndex: 0 })
      await assert.rejects(
        () => call(h, 'take:combineParts', { lineId: 'l1', takeIds: ['p0'] }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
        '只有一条 take 时「合并」没有意义',
      )

      seedTake(h, { id: 'p1', partIndex: 0 })
      await assert.rejects(
        () => call(h, 'take:combineParts', { lineId: 'l1', takeIds: ['p0', 'p1'] }),
        (e: unknown) =>
          e instanceof AppError && e.details?.['reason'] === 'same-part-index',
        '同一分段的多次重录应当用「设为成品」，不是合并',
      )
    } finally {
      h.cleanup()
    }
  })

  it('分段格式不一致 → 明确报 format-mismatch（不偷偷重采样）', async () => {
    const h = await harness()
    try {
      seedTake(h, { id: 'p0', partIndex: 0 })
      // 造一条 44.1k 的分段
      const rel = 'takes/l1/p1-44k.wav'
      const format: AudioFormat = { sampleRate: 44100, bitDepth: 16, channels: 1 }
      const payload = float32ToInt16LE(new Float32Array(4410).fill(0.5))
      mkdirSync(dirname(join(h.root, PROJECT_ID, rel)), { recursive: true })
      writeFileSync(join(h.root, PROJECT_ID, rel), Buffer.concat([writeWavHeader({ dataBytes: payload.length, format }), payload]))
      h.db
        .prepare(
          `INSERT INTO takes (id, line_id, file_path, part_index, src_in_ms, src_out_ms, trimmed_in_ms, trimmed_out_ms,
                              duration_ms, gain_db, sample_rate, bit_depth, channels, source, flags, is_selected,
                              recorded_at, created_at)
           VALUES ('p1', 'l1', ?, 1, 0, 100, 0, 100, 100, 0, 44100, 16, 1, 'local', '[]', 0, 1, 1)`,
        )
        .run(rel)

      await assert.rejects(
        () => call(h, 'take:combineParts', { lineId: 'l1', takeIds: ['p0', 'p1'] }),
        (e: unknown) => e instanceof AppError && e.details?.['reason'] === 'format-mismatch',
      )
    } finally {
      h.cleanup()
    }
  })
})
