/**
 * 测试 · 混音域（`mix:*` 7 个通道）
 * ============================================================================
 * 设计依据：docs/15 §2（方案与轨道）、§5.1（响度两遍法）、docs/21 §6（mix_projects）
 *
 * ### 为什么这组测试的重点是「保存时的校验」
 *   混音方案是**整份提交**的（渲染侧防抖 500ms 后提交整份 JSON），所以坏状态不会在
 *   单条编辑时被发现，而是在渲染时才爆。这里逐条守住四种「渲染时才炸」的引用错误：
 *   跨章对轨方案、素材不存在/跨项目、轨道 id 重复、预设不存在。
 *   同时验证 version 递增、`isDefault` 不能被整份提交改写（否则一次防抖保存就能把默认改没）。
 *
 * ### 响度测量
 *   `loudnorm` 的 JSON 在 **stderr**：测试用假执行器按真实格式回放，验证
 *   「解析成功 → 返回数值」「解析失败 → 明确报错、不拿 0 冒充」「没装 ffmpeg → 明确报错」。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat, MixProject } from '../../src/shared/types.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToInt16LE } from '../../src/shared/audio/pcm.ts'
import type { FfmpegExecuteOptions, FfmpegExecuteResult } from '../../src/shared/ffmpeg/commands.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createAudioProjectScope } from '../../src/main/features/audio/project-scope.ts'
import { createMixService, defaultVoiceTrack } from '../../src/main/features/audio/mix.service.ts'
import { createSqliteMixProjectRepo } from '../../src/main/features/audio/repositories/mix.repo.sqlite.ts'
import { createMixHandlers, MIX_CHANNELS } from '../../src/main/ipc/handlers/mix.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'

const PROJECT_ID = 'p1'
const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }

/** 真 loudnorm 输出的形状（`[Parsed_loudnorm_0 @ …]` 后面跟一个 JSON 对象） */
const LOUDNORM_OK = `[Parsed_loudnorm_0 @ 000001] 
{
	"input_i" : "-21.35",
	"input_tp" : "-3.12",
	"input_lra" : "6.80",
	"input_thresh" : "-31.90",
	"output_i" : "-16.02",
	"output_tp" : "-1.20",
	"output_lra" : "6.10",
	"output_thresh" : "-26.50",
	"normalization_type" : "dynamic",
	"target_offset" : "0.35"
}`

interface FakeRunner {
  calls: string[][]
  stderr: string
  throwEnoent: boolean
  failNext: boolean
  execute(command: string[], opts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult>
}

function fakeRunner(): FakeRunner {
  return {
    calls: [],
    stderr: LOUDNORM_OK,
    throwEnoent: false,
    failNext: false,
    async execute(command, _opts) {
      this.calls.push(command)
      if (this.throwEnoent) {
        const e = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      if (this.failNext) return { command, exitCode: 1, stdout: '', stderr: 'boom', elapsedMs: 2 }
      return { command, exitCode: 0, stdout: '', stderr: this.stderr, elapsedMs: 8 }
    },
  }
}

interface Harness {
  root: string
  db: DatabaseSync
  runner: FakeRunner
  service: ReturnType<typeof createMixService>
  handlers: ReturnType<typeof createMixHandlers>
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-mix-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike

  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p2', 'other', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', '${PROJECT_ID}', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 2, 1, 1)`)
  for (const id of ['c1', 'c2']) {
    db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
             VALUES ('${id}', 'b1', ${id === 'c1' ? 1 : 2}, '章', 'chapter', '正文', 2, 0, 2, 'generated', 1, 1, 1)`)
  }
  db.exec(`INSERT INTO arrangements (id, chapter_id, name, is_default, strategy, total_duration_ms, version, created_at, updated_at)
           VALUES ('arr1', 'c1', 'A', 1, 'serialize', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO arrangements (id, chapter_id, name, is_default, strategy, total_duration_ms, version, created_at, updated_at)
           VALUES ('arr2', 'c2', 'B', 1, 'serialize', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
           VALUES ('l1', 'c1', 'b1', 0, '台词', 0, 2, 500, 'recorded', 0, '[]', 0, 1, 1, 1)`)
  // 素材：本项目一条、别的项目一条（用来验证跨项目引用被拒绝）
  for (const [id, projectId, kind] of [
    ['m1', PROJECT_ID, 'bgm'],
    ['m2', 'p2', 'bgm'],
  ] as const) {
    const rel = `music/${kind}/${id}.wav`
    const abs = join(root, projectId, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const payload = float32ToInt16LE(new Float32Array(4800).fill(0.5))
    writeFileSync(abs, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
    db.exec(`INSERT INTO music_assets (id, project_id, kind, name, file_path, loopable, tags, created_at)
             VALUES ('${id}', '${projectId}', '${kind}', '${id}', '${rel}', 0, '[]', 1)`)
  }
  // 片段（响度测量用；processed_path 优先）
  for (const rel of ['segments/seg1.wav', 'processed/seg1.p1.wav']) {
    const abs = join(root, PROJECT_ID, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const payload = float32ToInt16LE(new Float32Array(4800).fill(0.5))
    writeFileSync(abs, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
  }
  db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, processed_path, preset_hash, src_in_ms, src_out_ms, duration_ms, flags, created_at, updated_at)
           VALUES ('seg1', 'l1', 'c1', 'segments/seg1.wav', 'processed/seg1.p1.wav', 'p1', 0, 100, 100, '[]', 1, 1)`)
  // 预设
  db.exec(`INSERT INTO process_presets (id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at)
           VALUES ('preset-x', NULL, '测试预设', NULL, 0, '{}', '[]', 100, 1, 1)`)

  const runner = fakeRunner()
  let seq = 0
  const scope = createAudioProjectScope({ getDb: () => dbLike })
  const service = createMixService({
    getDb: () => dbLike,
    projectRoot: () => root,
    repo: () => createSqliteMixProjectRepo(dbLike, { newId: (prefix) => `${prefix}-${++seq}`, now: () => 1_700_000_000_000 }),
    scope,
    ffmpeg: runner,
    arrangementChapterId: async (arrangementId) => {
      const row = db.prepare(`SELECT chapter_id FROM arrangements WHERE id = ?`).get(arrangementId) as
        | { chapter_id: string }
        | undefined
      return row?.chapter_id ?? null
    },
    newId: (prefix) => `${prefix}-${++seq}`,
  })

  return {
    root,
    db,
    runner,
    service,
    handlers: createMixHandlers({ mix: service, log: { info: () => {}, warn: () => {} } }),
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

/** 造一条音乐轨（引用素材 m1） */
function musicTrack(id: string, assetId = 'm1', mixProjectId = 'mix-host'): MixProject['tracks'][number] {
  return {
    id,
    mixProjectId,
    kind: 'music',
    refId: assetId,
    name: 'BGM',
    gainDb: -21,
    pan: 0,
    isMute: false,
    isSolo: false,
    presetId: null,
    sortOrder: 1,
    music: {
      assetId,
      startMs: 0,
      endMs: null,
      loop: true,
      fadeInMs: 1000,
      fadeOutMs: 2000,
      ducking: { enabled: true, amountDb: -12, thresholdDb: -30, attackMs: 20, releaseMs: 400, mode: 'envelope' },
    },
  }
}

// ---------------------------------------------------------------------------
// 方案管理
// ---------------------------------------------------------------------------

describe('混音域 · 方案管理', () => {
  it('create：带一条默认人声轨、第一个方案成为默认、首尾静音取导出默认', async () => {
    const h = await harness()
    try {
      const created = await h.service.create('c1', 'arr1', '方案 A')
      assert.equal(created.isDefault, true, '该章第一个混音方案必须是默认')
      assert.equal(created.tracks.length, 1)
      assert.equal(created.tracks[0]!.kind, 'voice')
      assert.equal(created.tracks[0]!.mixProjectId, created.id, '轨道的宿主 id 必须写对')
      assert.equal(created.headSilenceMs, 500)
      assert.equal(created.tailSilenceMs, 1500)
      assert.equal(created.master.targetLufs, -16)
      assert.equal(created.version, 1)
      assert.equal((await h.service.create('c1', 'arr1', '方案 B')).isDefault, false)
    } finally {
      h.cleanup()
    }
  })

  it('create：跨章的对轨方案、空名字、不存在的对轨方案都被拒绝', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.service.create('c1', 'arr2', '错章'),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.service.create('c1', 'arr1', '   '),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.service.create('c1', 'arr-ghost', '没方案'),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('duplicate 连轨道一起复制（新 id）、副本不是默认；delete 默认后自动改指', async () => {
    const h = await harness()
    try {
      const a = await h.service.create('c1', 'arr1', 'A')
      const saved = await h.service.save({ ...a, tracks: [...a.tracks, musicTrack('t2')] })
      const copy = await h.service.duplicate(a.id, 'A 副本')
      assert.equal(copy.isDefault, false)
      assert.equal(copy.tracks.length, 2)
      assert.equal(copy.tracks.every((t) => t.mixProjectId === copy.id), true)
      const originalIds = new Set(saved.tracks.map((t) => t.id))
      assert.equal(copy.tracks.some((t) => originalIds.has(t.id)), false, '副本的轨道 id 必须重新生成')

      const b = await h.service.create('c1', 'arr1', 'B')
      await h.db.prepare(`UPDATE mix_projects SET is_default = 1 WHERE id = ?`).run(b.id)
      await h.db.prepare(`UPDATE mix_projects SET is_default = 0 WHERE id = ?`).run(a.id)
      await h.service.remove(b.id)
      const listed = await h.service.listProjects('c1')
      assert.equal(listed.filter((p) => p.isDefault).length, 1, '删掉默认方案后必须自动改指一个')
    } finally {
      h.cleanup()
    }
  })

  it('delete 会清掉遗留的 mix_tracks 行（否则素材引用检查会读到幽灵行）', async () => {
    const h = await harness()
    try {
      const p = await h.service.create('c1', 'arr1', 'A')
      h.db.exec(`INSERT INTO mix_tracks (id, mix_project_id, kind, ref_id, name, created_at, updated_at)
                 VALUES ('ghost', '${p.id}', 'music', 'm1', '幽灵轨', 1, 1)`)
      await h.service.remove(p.id)
      const left = h.db.prepare(`SELECT COUNT(*) AS n FROM mix_tracks WHERE mix_project_id = ?`).get(p.id) as {
        n: number
      }
      assert.equal(left.n, 0)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 保存与校验
// ---------------------------------------------------------------------------

describe('混音域 · mix:save 的校验（每一条都对应一种渲染时才炸的状态）', () => {
  it('保存成功：version+1、updatedAt 由主进程决定、轨道的宿主 id 被改写为方案 id', async () => {
    const h = await harness()
    try {
      const created = await h.service.create('c1', 'arr1', 'A')
      const saved = await h.service.save({
        ...created,
        name: '改名了',
        // 故意带一个错的宿主 id（复制方案后最容易出现）
        tracks: [{ ...created.tracks[0]!, mixProjectId: 'wrong-id' }],
      })
      assert.equal(saved.version, 2)
      assert.equal(saved.name, '改名了')
      assert.equal(saved.tracks[0]!.mixProjectId, created.id)
      assert.equal(saved.createdAt, created.createdAt, 'createdAt 不能被整份提交改掉')
    } finally {
      h.cleanup()
    }
  })

  it('isDefault 不能被整份提交改写（一次防抖保存不能把默认方案改没）', async () => {
    const h = await harness()
    try {
      const a = await h.service.create('c1', 'arr1', 'A')
      await h.service.create('c1', 'arr1', 'B')
      // A 是默认；提交时把它标成 false
      const saved = await h.service.save({ ...a, isDefault: false })
      assert.equal(saved.isDefault, true, 'isDefault 只能通过 setDefault 改')
    } finally {
      h.cleanup()
    }
  })

  it('跨章对轨方案 / 轨道 id 重复 / 素材不存在 / 素材跨项目 / 预设不存在 全部拒绝', async () => {
    const h = await harness()
    try {
      const p = await h.service.create('c1', 'arr1', 'A')
      const failWith = async (project: MixProject, why: string): Promise<void> => {
        const err = await h.service.save(project).catch((e: unknown) => e)
        assert.ok(err instanceof AppError, `${why}：期望明确报错，实际 ${String(err)}`)
      }
      await failWith({ ...p, arrangementId: 'arr2' }, '跨章对轨方案')
      await failWith({ ...p, tracks: [p.tracks[0]!, { ...musicTrack('t2'), id: p.tracks[0]!.id }] }, '轨道 id 重复')
      await failWith({ ...p, tracks: [...p.tracks, musicTrack('t3', 'm-ghost')] }, '素材不存在')
      await failWith({ ...p, tracks: [...p.tracks, musicTrack('t4', 'm2')] }, '素材跨项目')
      await failWith(
        { ...p, tracks: [...p.tracks, { ...musicTrack('t5'), presetId: 'preset-ghost' }] },
        '预设不存在',
      )
      // 全部失败之后方案还是干净的（version 没有因为失败而 +1）
      const after = await h.service.get(p.id)
      assert.equal(after.version, 1)
      assert.equal(after.tracks.length, 1)
    } finally {
      h.cleanup()
    }
  })

  it('保存不存在的方案 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      const p = await h.service.create('c1', 'arr1', 'A')
      await assert.rejects(
        () => h.service.save({ ...p, id: 'mix-ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('handler 层：mix:create → get → save → listProjects → delete 走通契约', async () => {
    const h = await harness()
    try {
      const created = (await call(h, 'mix:create', {
        chapterId: 'c1',
        arrangementId: 'arr1',
        name: '契约方案',
      })) as MixProject
      const got = (await call(h, 'mix:get', { mixProjectId: created.id })) as MixProject
      assert.equal(got.id, created.id)
      const saved = (await call(h, 'mix:save', { mixProject: { ...got, tracks: [...got.tracks, musicTrack('t9', 'm1', got.id)] } })) as MixProject
      assert.equal(saved.tracks.length, 2)
      const list = (await call(h, 'mix:listProjects', { chapterId: 'c1' })) as MixProject[]
      assert.equal(list.length, 1)
      const removed = (await call(h, 'mix:delete', { mixProjectId: created.id })) as { ok: boolean }
      assert.equal(removed.ok, true)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 响度测量
// ---------------------------------------------------------------------------

describe('混音域 · mix:measureLoudness', () => {
  it('解析 loudnorm 的 JSON（在 stderr）→ 返回数值；segmentId 优先用处理后文件', async () => {
    const h = await harness()
    try {
      const measurement = await h.service.measureLoudness({ segmentId: 'seg1' }, -16)
      assert.ok(Math.abs(measurement.inputI - -21.35) < 0.01)
      assert.ok(Math.abs(measurement.inputTp - -3.12) < 0.01)
      assert.ok(Math.abs(measurement.inputLra - 6.8) < 0.01)
      assert.ok(Math.abs(measurement.targetOffset - 0.35) < 0.01)
      const command = h.runner.calls[0]!
      assert.ok(command.some((a) => a.includes('loudnorm')), '必须走 loudnorm（自算 LUFS 与专业工具对不上）')
      assert.ok(command[command.indexOf('-i') + 1]!.endsWith(join('processed', 'seg1.p1.wav')), '有处理后文件时用它')
      assert.ok(command.some((a) => a.includes('print_format=json')), '分析结果要以 JSON 输出（解析器认这个格式）')
    } finally {
      h.cleanup()
    }
  })

  it('两个定位参数都不给 → INVALID_PAYLOAD；片段不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.service.measureLoudness({}),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.service.measureLoudness({ segmentId: 'seg-ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
      // path 定位：项目内相对路径（走 project-scope 解析）
      const m = await h.service.measureLoudness({ path: 'segments/seg1.wav' })
      assert.ok(Number.isFinite(m.inputI))
    } finally {
      h.cleanup()
    }
  })

  it('没装 ffmpeg → EXPORT_FFMPEG_FAILED(ffmpeg-not-found)；解析不出 → 明确报错而不是返回 0', async () => {
    const h = await harness()
    try {
      h.runner.throwEnoent = true
      const err = await h.service.measureLoudness({ segmentId: 'seg1' }).catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'EXPORT_FFMPEG_FAILED')
      assert.equal(err.details?.reason, 'ffmpeg-not-found')

      h.runner.throwEnoent = false
      h.runner.stderr = 'no json here'
      const err2 = await h.service.measureLoudness({ segmentId: 'seg1' }).catch((e: unknown) => e)
      assert.ok(err2 instanceof AppError)
      assert.equal(err2.details?.reason, 'loudnorm-output-unparsable')

      h.runner.stderr = 'x'
      h.runner.failNext = true
      const err3 = await h.service.measureLoudness({ segmentId: 'seg1' }).catch((e: unknown) => e)
      assert.ok(err3 instanceof AppError)
      assert.equal(err3.key, 'EXPORT_FFMPEG_FAILED')
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 纯工具与接线
// ---------------------------------------------------------------------------

describe('混音域 · 工具与接线', () => {
  it('defaultVoiceTrack：一条可用的人声轨（不带素材、增益 0）', () => {
    const track = defaultVoiceTrack('mix-1', 'track-1')
    assert.equal(track.mixProjectId, 'mix-1')
    assert.equal(track.kind, 'voice')
    assert.equal(track.music, null)
    assert.equal(track.gainDb, 0)
    assert.equal(track.presetId, null)
  })

  it('通道清单与契约 schema 一一对应', () => {
    assert.equal(MIX_CHANNELS.length, 7)
    for (const channel of MIX_CHANNELS) {
      assert.ok(schemaFor(channel), `契约里没有 ${channel} 的 schema`)
    }
  })
})
