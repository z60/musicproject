/**
 * 测试 · 素材域（`music:*` 4 个通道）
 * ============================================================================
 * 设计依据：docs/14 §8、docs/21 §6、docs/03 §2（相对路径基准 = `{projectRoot}/{projectId}`）
 *
 * ### 这组测试守的是什么
 *   素材域看起来简单（导入/列表/探测/删除），但每一步都有一个「错了会静默」的坑：
 *   · **导入必须复制**（引用原路径 → 用户一整理目录，所有 BGM 轨失效）；
 *   · **路径基准是项目目录**（少一层 projectId → 渲染进程 `ns-media://` 404，docs/91 §5.2.19）；
 *   · **探测非 WAV 要经 ffmpeg 解码**（直接按 WAV 解析 mp3 会得到「不是 WAV」的假结论）；
 *   · **被混音轨引用的素材不能删**（删了会让渲染到一半才报错）。
 *   所以这里用真 SQLite + 真临时文件，ffmpeg 用假执行器（它真的写出一个 WAV）。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat } from '../../src/shared/types.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToInt16LE } from '../../src/shared/audio/pcm.ts'
import type { FfmpegExecuteOptions, FfmpegExecuteResult } from '../../src/shared/ffmpeg/commands.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createMusicService, SUPPORTED_MUSIC_EXTENSIONS } from '../../src/main/features/audio/music.service.ts'
import { createSqliteMusicAssetRepo } from '../../src/main/features/audio/repositories/music.repo.sqlite.ts'
import { createMusicHandlers, MUSIC_CHANNELS } from '../../src/main/ipc/handlers/music.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'

const PROJECT_ID = 'p1'
const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }

interface FakeRunner {
  calls: string[][]
  throwEnoent: boolean
  failNext: boolean
  execute(command: string[], opts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult>
}

/** 假 ffmpeg：把输出参数指向的文件**真的写成一个 0.5 幅度的 WAV**（-6 dBFS） */
function fakeRunner(): FakeRunner {
  return {
    calls: [],
    throwEnoent: false,
    failNext: false,
    async execute(command, _opts) {
      this.calls.push(command)
      if (this.throwEnoent) {
        const e = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      if (this.failNext) {
        return { command, exitCode: 1, stdout: '', stderr: 'Invalid data found', elapsedMs: 2 }
      }
      const output = command[command.length - 1]!
      mkdirSync(dirname(output), { recursive: true })
      const payload = float32ToInt16LE(new Float32Array(4800).fill(0.5))
      writeFileSync(output, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
      return { command, exitCode: 0, stdout: '', stderr: '', elapsedMs: 5 }
    },
  }
}

interface Harness {
  root: string
  db: DatabaseSync
  runner: FakeRunner
  service: ReturnType<typeof createMusicService>
  handlers: ReturnType<typeof createMusicHandlers>
  /** 造一个「源素材」文件（模拟用户磁盘上的 mp3/wav） */
  makeSource(name: string, opts?: { amplitude?: number; bytes?: number }): string
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-music-'))
  const sourceDir = join(root, 'sources')
  mkdirSync(sourceDir, { recursive: true })
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)

  const runner = fakeRunner()
  let seq = 0
  const service = createMusicService({
    getDb: () => dbLike,
    projectRoot: () => root,
    repo: () => createSqliteMusicAssetRepo(dbLike, { newId: (prefix) => `${prefix}-${++seq}`, now: () => 1 }),
    projectExists: async (projectId) => {
      const row = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId)
      return row !== undefined
    },
    ffmpeg: runner,
    newId: (prefix) => `${prefix}-${++seq}`,
    now: () => 1_700_000_000_000,
  })

  return {
    root,
    db,
    runner,
    service,
    handlers: createMusicHandlers({ music: service, log: { info: () => {}, warn: () => {} } }),
    makeSource(name, opts) {
      const file = join(sourceDir, name)
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      if (ext === 'wav') {
        const payload = float32ToInt16LE(new Float32Array(9600).fill(opts?.amplitude ?? 0.5))
        writeFileSync(file, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
      } else {
        // 非 WAV：写一点假字节（真解析会失败，只有经 ffmpeg 解码才行 —— 正是要验证的路径）
        writeFileSync(file, Buffer.alloc(opts?.bytes ?? 2048, 7))
      }
      return file
    },
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


// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

describe('素材域 · music:import', () => {
  it('导入 = 复制到 music/{kind}/，源文件从此无关；路径相对项目目录', async () => {
    const h = await harness()
    try {
      const src = h.makeSource('bgm.wav', { amplitude: 0.5 })
      const [asset] = await h.service.importFiles(PROJECT_ID, [src], 'bgm')
      assert.ok(asset, '必须返回导入后的素材')
      assert.equal(asset.kind, 'bgm')
      assert.equal(asset.name, 'bgm', '名字取源文件的 basename（不含扩展名）')
      assert.equal(asset.originalName, 'bgm.wav')
      assert.match(asset.filePath, /^music\/bgm\/music-\d+\.wav$/, '落库路径必须是 music/{kind}/{id}.{ext}')
      assert.ok(existsSync(join(h.root, PROJECT_ID, asset.filePath)), '文件必须落在项目目录内')
      assert.equal(existsSync(join(h.root, asset.filePath)), false, '不得落在项目目录之外')

      // 删掉源文件，素材仍然可用（托管的意义）
      rmSync(src, { force: true })
      const list = await h.service.list(PROJECT_ID, 'bgm')
      assert.equal(list.length, 1)
      assert.ok(existsSync(join(h.root, PROJECT_ID, list[0]!.filePath)))
    } finally {
      h.cleanup()
    }
  })

  it('导入时自动测量 WAV（不经过 ffmpeg）：时长/采样率/峰值都写进库', async () => {
    const h = await harness()
    try {
      const src = h.makeSource('voice.wav', { amplitude: 0.5 })
      const [asset] = await h.service.importFiles(PROJECT_ID, [src], 'bgm')
      assert.equal(h.runner.calls.length, 0, 'WAV 素材不该走 ffmpeg（少一个伪依赖）')
      assert.equal(asset!.durationMs, 200, '0.2 秒（9600 帧 @48k）')
      assert.equal(asset!.sampleRate, 48000)
      assert.equal(asset!.channels, 1)
      assert.ok(Math.abs((asset!.peakDb ?? 0) - -6) <= 0.2, `0.5 幅度 → 约 -6 dBFS，实际 ${asset!.peakDb}`)
    } finally {
      h.cleanup()
    }
  })

  it('非 WAV 素材经 ffmpeg 解码后测量（假执行器真的写 WAV）', async () => {
    const h = await harness()
    try {
      const src = h.makeSource('song.mp3')
      const [asset] = await h.service.importFiles(PROJECT_ID, [src], 'sfx')
      assert.equal(h.runner.calls.length, 1, 'mp3 必须经 ffmpeg 解码一次')
      const command = h.runner.calls[0]!
      assert.ok(command.includes('-ac') && command.includes('1'), '解码成单声道（测量口径与 analysis 一致）')
      assert.ok(command.includes('-ar') && command.includes('48000'))
      assert.ok(command[command.length - 1]!.endsWith('.wav'))
      assert.equal(asset!.durationMs, 100, '假执行器写的是 4800 帧 → 100 ms')
      // 临时解码文件必须被清理（素材可能几十 MB，留着就是磁盘泄漏）
      const tempDir = join(h.root, PROJECT_ID, 'cache', 'tmp')
      assert.equal(existsSync(tempDir) ? readdirSync(tempDir).length : 0, 0, '探测用的临时文件必须删掉')
    } finally {
      h.cleanup()
    }
  })

  it('不支持的扩展名、空文件、不存在的文件都明确报错（不做「猜扩展名」）', async () => {
    const h = await harness()
    try {
      const txt = h.makeSource('readme.txt', { bytes: 10 })
      await assert.rejects(
        () => h.service.importFiles(PROJECT_ID, [txt], 'bgm'),
        (e: unknown) => e instanceof AppError && e.key === 'UNSUPPORTED_FORMAT',
      )
      const empty = h.makeSource('empty.mp3', { bytes: 0 })
      await assert.rejects(
        () => h.service.importFiles(PROJECT_ID, [empty], 'bgm'),
        (e: unknown) => e instanceof AppError && e.key === 'UNSUPPORTED_FORMAT',
      )
      await assert.rejects(
        () => h.service.importFiles(PROJECT_ID, [join(h.root, 'nope.mp3')], 'bgm'),
        (e: unknown) => e instanceof AppError && e.key === 'FILE_NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.importFiles('p-ghost', [h.makeSource('x.wav')], 'bgm'),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
      assert.deepEqual(SUPPORTED_MUSIC_EXTENSIONS.includes('flac'), true)
    } finally {
      h.cleanup()
    }
  })

  it('元数据测不出来时导入仍然成功（文件已托管），指标留空而不是抛错', async () => {
    const h = await harness()
    try {
      h.runner.throwEnoent = true
      const [asset] = await h.service.importFiles(PROJECT_ID, [h.makeSource('broken.mp3')], 'bgm')
      assert.ok(asset, '没装 ffmpeg 也要让导入成功（文件已经托管好了）')
      assert.equal(asset!.durationMs, null)
      assert.equal(asset!.peakDb, null)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

describe('素材域 · music:list', () => {
  it('按项目隔离、可按 kind 过滤', async () => {
    const h = await harness()
    try {
      h.db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
                 VALUES ('p2', 'other', '${h.root.replace(/\\/g, '/')}', 4, 1, 1)`)
      await h.service.importFiles(PROJECT_ID, [h.makeSource('a.wav')], 'bgm')
      await h.service.importFiles(PROJECT_ID, [h.makeSource('b.wav')], 'sfx')
      await h.service.importFiles('p2', [h.makeSource('c.wav')], 'bgm')

      const all = await h.service.list(PROJECT_ID)
      assert.equal(all.length, 2, '只返回本项目的素材')
      const bgm = await h.service.list(PROJECT_ID, 'bgm')
      assert.equal(bgm.length, 1)
      assert.equal(bgm[0]!.kind, 'bgm')
      const sfx = await h.service.list(PROJECT_ID, 'sfx')
      assert.equal(sfx.length, 1)
      assert.equal(sfx[0]!.kind, 'sfx')
      assert.equal((await h.service.list('p2')).length, 1)
      assert.equal((await h.service.list('p-ghost')).length, 0)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

describe('素材域 · music:probe', () => {
  it('返回 AudioMetrics 并把结果写回库（列表里就有指标了）', async () => {
    const h = await harness()
    try {
      const [asset] = await h.service.importFiles(PROJECT_ID, [h.makeSource('probe.wav', { amplitude: 0.25 })], 'bgm')
      const metrics = await h.service.probe(asset!.id)
      assert.equal(metrics.filePath, asset!.filePath)
      assert.equal(metrics.durationMs, 200)
      assert.equal(metrics.truePeakDb, null, '真实峰值需要 4 倍过采样；没有就是没有，不拿峰值冒充')
      assert.equal(metrics.lufs, null)
      assert.ok(Math.abs((metrics.peakDb ?? 0) - -12) <= 0.3, `0.25 幅度 → 约 -12 dBFS，实际 ${metrics.peakDb}`)
      assert.ok((metrics.fileSize ?? 0) > 0)
      const row = h.db.prepare(`SELECT duration_ms, peak_db FROM music_assets WHERE id = ?`).get(asset!.id) as {
        duration_ms: number
        peak_db: number
      }
      assert.equal(row.duration_ms, 200, '探测结果要写回库（下次不用再测）')
      assert.ok(row.peak_db < 0)
    } finally {
      h.cleanup()
    }
  })

  it('文件被删掉 → FILE_NOT_FOUND；素材不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      const [asset] = await h.service.importFiles(PROJECT_ID, [h.makeSource('gone.wav')], 'bgm')
      rmSync(join(h.root, PROJECT_ID, asset!.filePath), { force: true })
      await assert.rejects(
        () => h.service.probe(asset!.id),
        (e: unknown) => e instanceof AppError && e.key === 'FILE_NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.probe('music-ghost'),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('非 WAV + 没装 ffmpeg → EXPORT_FFMPEG_FAILED(reason=ffmpeg-not-found)；解码失败 → UNSUPPORTED_FORMAT', async () => {
    const h = await harness()
    try {
      const [asset] = await h.service.importFiles(PROJECT_ID, [h.makeSource('x.mp3')], 'bgm')
      h.runner.throwEnoent = true
      const err = await h.service.probe(asset!.id).catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'EXPORT_FFMPEG_FAILED')
      assert.equal(err.details?.reason, 'ffmpeg-not-found')

      h.runner.throwEnoent = false
      h.runner.failNext = true
      const err2 = await h.service.probe(asset!.id).catch((e: unknown) => e)
      assert.ok(err2 instanceof AppError)
      assert.equal(err2.key, 'UNSUPPORTED_FORMAT')
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

describe('素材域 · music:delete', () => {
  it('删除 = 行 + 文件一起消失', async () => {
    const h = await harness()
    try {
      const [asset] = await h.service.importFiles(PROJECT_ID, [h.makeSource('del.wav')], 'sfx')
      const abs = join(h.root, PROJECT_ID, asset!.filePath)
      const res = await h.service.remove(asset!.id)
      assert.equal(res.ok, true)
      assert.equal(existsSync(abs), false, '文件必须一起删掉（否则越积越多而用户以为删了）')
      assert.equal((await h.service.list(PROJECT_ID)).length, 0)
      await assert.rejects(
        () => h.service.remove(asset!.id),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('被混音轨引用的素材拒绝删除（否则渲染到一半才发现素材没了）', async () => {
    const h = await harness()
    try {
      const [asset] = await h.service.importFiles(PROJECT_ID, [h.makeSource('used.wav')], 'bgm')
      // 先建书、再建章（chapters.book_id 是外键，顺序反了会 FK 失败）
      h.db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
                 VALUES ('b1', '${PROJECT_ID}', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
      h.db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
                 VALUES ('c1', 'b1', 1, '章', 'chapter', '正文', 2, 0, 2, 'generated', 0, 1, 1)`)
      h.db.exec(`INSERT INTO arrangements (id, chapter_id, name, is_default, strategy, total_duration_ms, version, created_at, updated_at)
                 VALUES ('arr1', 'c1', '方案', 1, 'serialize', 0, 1, 1, 1)`)
      // 两种存储都要覆盖：关系表 `mix_tracks`（ref_id / music_config）与
      // `mix_projects.tracks` 整份 JSON（`mix:save` 写的就是它）
      h.db.exec(`INSERT INTO mix_projects (id, chapter_id, arrangement_id, name, is_default, tracks, master, created_at, updated_at)
                 VALUES ('mix1', 'c1', 'arr1', '混音', 1,
                         '[{"id":"t1","kind":"music","refId":"${asset!.id}","name":"BGM 轨","music":{"assetId":"${asset!.id}"}}]',
                         '{}', 1, 1)`)

      const err = await h.service.remove(asset!.id).catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'CONFLICT')
      assert.equal(err.details?.reason, 'asset-in-use')
      assert.deepEqual(err.details?.tracks, [
        { trackId: 'mix1', name: '混音', where: 'mix_projects.tracks' },
      ])
      // 拒绝之后文件与行都还在（不能删一半）
      assert.equal((await h.service.list(PROJECT_ID)).length, 1)
      assert.ok(existsSync(join(h.root, PROJECT_ID, asset!.filePath)))

      // 解除引用后可以删
      h.db.exec(`DELETE FROM mix_projects WHERE id = 'mix1'`)
      assert.equal((await h.service.remove(asset!.id)).ok, true)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 通道接线
// ---------------------------------------------------------------------------

describe('素材域 · 通道接线', () => {
  it('music:import → list → probe → delete 走通契约', async () => {
    const h = await harness()
    try {
      const src = h.makeSource('chain.wav')
      const imported = (await call(h, 'music:import', {
        projectId: PROJECT_ID,
        files: [src],
        kind: 'bgm',
      })) as Array<{ id: string; filePath: string }>
      assert.equal(imported.length, 1)

      const listed = (await call(h, 'music:list', { projectId: PROJECT_ID, kind: 'bgm' })) as Array<{ id: string }>
      assert.equal(listed.length, 1)

      const metrics = (await call(h, 'music:probe', { assetId: imported[0]!.id })) as { durationMs: number }
      assert.equal(metrics.durationMs, 200)

      const removed = (await call(h, 'music:delete', { assetId: imported[0]!.id })) as { ok: boolean }
      assert.equal(removed.ok, true)
    } finally {
      h.cleanup()
    }
  })

  it('通道清单与契约 schema 一一对应', () => {
    assert.equal(MUSIC_CHANNELS.length, 4)
    for (const channel of MUSIC_CHANNELS) {
      assert.ok(schemaFor(channel), `契约里没有 ${channel} 的 schema`)
    }
  })
})
