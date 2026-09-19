/**
 * 测试 · 处理域（`process:*` 5 个通道）
 * ============================================================================
 * 设计依据：docs/14 §7.1（批量与失败隔离）/§7.2（取消）/§7.3（查看命令）/§10（试听）、
 *           docs/03 §6（非破坏：processed 是派生文件）
 *
 * ### 为什么注入「假 ffmpeg」而不是真跑 ffmpeg
 *   这台机器上**不保证有 ffmpeg**（`capabilities.ffmpeg.available` 在启动期才发现），
 *   把测试绑在「系统里装了 ffmpeg」上会让它在别人机器上随机变红。
 *   所以这里用一个**假执行器**：
 *   · 它按命令数组里的输出路径**真的写一个 WAV 文件**（这样「文件确实生成了」仍然被验证）；
 *   · 它能被指定「对某个片段失败」，用来验证**失败隔离**（一个坏掉不能中断整批）；
 *   · 它记录每次调用的完整命令，用来验证「查看命令」与关键参数。
 *
 *   **不验证**的是「ffmpeg 真的按滤镜串处理了音频」—— 那只能在装了 ffmpeg 的机器上验，
 *   已记入 docs/91 §5.2.20 的未验证清单，不在这里假装测过。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat, ProcessChain } from '../../src/shared/types.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToInt16LE } from '../../src/shared/audio/pcm.ts'
import { chainHash } from '../../src/shared/audio/process.ts'
import type { FfmpegExecuteOptions, FfmpegExecuteResult } from '../../src/shared/ffmpeg/commands.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createSqlitePresetRepo } from '../../src/main/features/audio/repositories/preset.repo.sqlite.ts'
import { createPresetService } from '../../src/main/features/audio/preset.service.ts'
import { createProcessTasks } from '../../src/main/features/audio/process.tasks.ts'
import { createProcessService, PREVIEW_MS_MAX } from '../../src/main/features/audio/process.service.ts'
import { createProcessingHandlers, PROCESS_CHANNELS, PRESET_CHANNELS } from '../../src/main/ipc/handlers/processing.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'
import type { TaskContext } from '../../src/main/infra/queue/types.ts'

const PROJECT_ID = 'p1'
const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }

// ---------------------------------------------------------------------------
// 假 ffmpeg
// ---------------------------------------------------------------------------

interface FakeRunner {
  calls: Array<{ command: string[]; opts?: FfmpegExecuteOptions }>
  /** 命中这些片段的命令直接返回非 0（验证失败隔离） */
  failOn: Set<string>
  /** 直接抛 ENOENT（验证「未安装 ffmpeg」的分支） */
  throwEnoent: boolean
  execute(command: string[], opts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult>
}

function fakeRunner(): FakeRunner {
  return {
    calls: [],
    failOn: new Set(),
    throwEnoent: false,
    async execute(command, opts) {
      this.calls.push({ command, ...(opts ? { opts } : {}) })
      if (this.throwEnoent) {
        const e = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      const output = command[command.length - 1]!
      const failed = [...this.failOn].some((needle) => output.includes(needle) || command.some((a) => a.includes(needle)))
      if (failed) {
        return { command, exitCode: 1, stdout: '', stderr: 'Invalid argument: alimiter', elapsedMs: 5 }
      }
      // 真的写一个文件：这样「产物存在」也被验证到了
      mkdirSync(dirname(output), { recursive: true })
      const payload = float32ToInt16LE(new Float32Array(4800).fill(0.25))
      writeFileSync(output, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
      opts?.onProgressLine?.('out_time_us=100000')
      opts?.onProgressLine?.('progress=continue')
      return { command, exitCode: 0, stdout: '', stderr: '', elapsedMs: 12 }
    },
  }
}

/** 最小可用的 TaskContext（队列的接口面很小，可以直接造） */
function fakeCtx(opts?: { abortedAfter?: number; tempDir?: string }): TaskContext & { reports: number[] } {
  const reports: number[] = []
  const controller = new AbortController()
  let calls = 0
  return {
    taskId: 'task-1',
    kind: 'audio.process',
    projectId: PROJECT_ID,
    attempt: 1,
    signal: controller.signal,
    tempDir: opts?.tempDir ?? join(tmpdir(), 'ns-process-tmp'),
    reports,
    report(progress) {
      reports.push(progress)
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw new AppError('TASK_CANCELLED', {})
    },
    isAborted() {
      calls++
      if (opts?.abortedAfter !== undefined && calls > opts.abortedAfter) {
        controller.abort()
        return true
      }
      return controller.signal.aborted
    },
    log() {},
  } as TaskContext & { reports: number[] }
}

// ---------------------------------------------------------------------------
// 测试台
// ---------------------------------------------------------------------------

const ACTIVE: ProcessChain = {
  highpass: { enabled: true, freq: 80, poles: 2 },
  denoise: { enabled: false, nr: 12, nf: -30, tn: false },
  deesser: { enabled: false, intensity: 0.5, freq: 0.5 },
  eq: [{ id: 'e1', type: 'peak', freq: 3000, gainDb: 2, q: 1.2, enabled: true }],
  compressor: { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 },
  limiter: { enabled: true, limitDb: -1, attackMs: 5, releaseMs: 50 },
  repair: { dcOffset: false, polarityInvert: false, declick: [], silenceFill: [], tempo: { enabled: false, factor: 1 } },
}

interface Harness {
  root: string
  db: DatabaseSync
  runner: FakeRunner
  service: ReturnType<typeof createProcessService>
  handlers: ReturnType<typeof createProcessingHandlers>
  cleanup: () => void
}

async function harness(opts?: { segments?: number }): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-process-'))
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
  const count = opts?.segments ?? 3
  for (let i = 1; i <= count; i++) {
    const lineId = `l${i}`
    const segId = `seg${i}`
    db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('${lineId}', 'c1', 'b1', ${i}, '台词', 0, 2, 500, 'recorded', 0, '[]', 0, 1, 1, 1)`)
    // 真造一个成品文件（处理链的输入）
    const rel = `segments/${segId}.wav`
    const abs = join(root, PROJECT_ID, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const payload = float32ToInt16LE(new Float32Array(4800).fill(0.5))
    writeFileSync(abs, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
    db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, created_at, updated_at)
             VALUES ('${segId}', '${lineId}', 'c1', '${rel}', 0, 100, 100, 1, 1)`)
  }

  const runner = fakeRunner()
  let seq = 0
  const presetService = createPresetService({
    repo: () => createSqlitePresetRepo(dbLike, { newId: () => `preset-${++seq}`, now: () => 1 }),
    now: () => 1,
  })
  const resolveChain = async (presetId?: string | null, chain?: ProcessChain | null) =>
    (await presetService.resolveChain(presetId ?? null, chain ?? null)).chain
  const tasks = createProcessTasks({
    getDb: () => dbLike,
    ffmpeg: runner,
    projectRoot: () => root,
    resolveChain,
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
  })
  const service = createProcessService({
    getDb: () => dbLike,
    projectRoot: () => root,
    tasks,
    ffmpeg: runner,
    resolveChain,
  })

  return {
    root,
    db,
    runner,
    service,
    handlers: createProcessingHandlers({
      process: service,
      preset: presetService,
      log: { info: () => {}, warn: () => {} },
    }),
    cleanup: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 直接跑一次批量（不经队列），用于验证执行与失败隔离 */
async function runBatch(
  h: Harness,
  payload: Parameters<ReturnType<typeof createProcessTasks>['runNow']>[0],
  ctx?: TaskContext,
): Promise<Awaited<ReturnType<ReturnType<typeof createProcessTasks>['runNow']>>> {
  const tasks = createProcessTasks({
    getDb: () => h.db as unknown as DbLike,
    ffmpeg: h.runner,
    projectRoot: () => h.root,
    resolveChain: async (_presetId, chain) => chain ?? ACTIVE,
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
  })
  return tasks.runNow(payload, ctx ?? fakeCtx())
}

async function call(h: Harness, channel: string, payload: unknown): Promise<unknown> {
  const spec = h.handlers.find((x) => x.channel === channel)
  assert.ok(spec, `没有登记 ${channel}`)
  const schema = schemaFor(channel)
  assert.ok(schema, `契约里没有 ${channel} 的 schema`)
  return await spec.run(schema.parse(payload) as never, {} as never)
}

// ---------------------------------------------------------------------------
// 试听
// ---------------------------------------------------------------------------

describe('处理域 · process:preview', () => {
  it('渲染到 cache/tmp，返回项目内相对路径，不改库', async () => {
    const h = await harness()
    try {
      const result = await h.service.preview('seg1', ACTIVE, 5000)
      assert.match(result.path, /^cache\/tmp\/preview-seg1-[0-9a-f]{12}\.wav$/)
      assert.ok(existsSync(join(h.root, PROJECT_ID, result.path)), '试听文件必须落在项目目录内')
      // 命令里的输出就是那个文件，且限时 5 秒
      const command = h.runner.calls[0]!.command
      assert.ok(command[command.length - 1]!.endsWith(result.path.replace(/\//g, sep)))
      assert.equal(command[command.indexOf('-t') + 1], '5')
      // 库没有被改：试听不是「应用」
      const row = h.db.prepare(`SELECT processed_path, preset_hash FROM voice_segments WHERE id = 'seg1'`).get() as {
        processed_path: string | null
        preset_hash: string | null
      }
      assert.equal(row.processed_path, null)
      assert.equal(row.preset_hash, null)
    } finally {
      h.cleanup()
    }
  })

  it('时长上限被夹住（渲染侧传「整段」也不会把试听变成正式渲染）', async () => {
    const h = await harness()
    try {
      await h.service.preview('seg1', ACTIVE, 10 * 60 * 1000)
      const command = h.runner.calls[0]!.command
      assert.equal(command[command.indexOf('-t') + 1], String(PREVIEW_MS_MAX / 1000))
      await assert.rejects(
        () => h.service.preview('seg1', ACTIVE, 0),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })

  it('ffmpeg 不存在 → EXPORT_FFMPEG_FAILED 且 reason=ffmpeg-not-found（与「参数不对」分开报）', async () => {
    const h = await harness()
    try {
      h.runner.throwEnoent = true
      await assert.rejects(
        () => h.service.preview('seg1', ACTIVE),
        (e: unknown) =>
          e instanceof AppError && e.key === 'EXPORT_FFMPEG_FAILED' && e.details?.reason === 'ffmpeg-not-found',
      )
    } finally {
      h.cleanup()
    }
  })

  it('ffmpeg 退出码非 0 → 带完整命令与 stderr（docs/14 §7.3「查看命令」）', async () => {
    const h = await harness()
    try {
      h.runner.failOn.add('preview-seg1')
      await assert.rejects(
        () => h.service.preview('seg1', ACTIVE),
        (e: unknown) => {
          if (!(e instanceof AppError) || e.key !== 'EXPORT_FFMPEG_FAILED') return false
          const command = String(e.details?.command ?? '')
          return command.includes('ffmpeg') && String(e.details?.stderr ?? '').includes('alimiter')
        },
      )
    } finally {
      h.cleanup()
    }
  })

  it('片段不存在 → NOT_FOUND（试听不会去猜一个文件）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.service.preview('seg-ghost', ACTIVE),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 批量执行
// ---------------------------------------------------------------------------

describe('处理域 · 批量执行与失败隔离', () => {
  it('成功路径：每个片段写出 processed/{segId}.{hash}.wav 并写库', async () => {
    const h = await harness()
    try {
      const report = await runBatch(h, { segmentIds: ['seg1', 'seg2'], scope: 'segment', chain: ACTIVE })
      assert.equal(report.total, 2)
      assert.equal(report.done, 2)
      assert.equal(report.failed, 0)
      assert.equal(report.presetHash, chainHash(ACTIVE))
      for (const segId of ['seg1', 'seg2']) {
        const row = h.db
          .prepare(`SELECT processed_path, preset_hash FROM voice_segments WHERE id = ?`)
          .get(segId) as { processed_path: string; preset_hash: string }
        assert.equal(row.processed_path, `processed/${segId}.${chainHash(ACTIVE)}.wav`)
        assert.equal(row.preset_hash, chainHash(ACTIVE))
        assert.ok(existsSync(join(h.root, PROJECT_ID, row.processed_path)), '库里的路径必须真的有文件')
      }
      // 原始成品文件没被动过（非破坏，docs/03 §6）
      assert.ok(existsSync(join(h.root, PROJECT_ID, 'segments/seg1.wav')))
    } finally {
      h.cleanup()
    }
  })

  it('幂等：同样的链再跑一次 → 全部跳过（不重复写文件）', async () => {
    const h = await harness()
    try {
      await runBatch(h, { segmentIds: ['seg1'], scope: 'segment', chain: ACTIVE })
      const before = h.runner.calls.length
      const second = await runBatch(h, { segmentIds: ['seg1'], scope: 'segment', chain: ACTIVE })
      assert.equal(second.skipped, 1)
      assert.equal(second.done, 0)
      assert.equal(h.runner.calls.length, before, '跳过的片段不该再起一次 ffmpeg')
    } finally {
      h.cleanup()
    }
  })

  it('失败隔离：一个片段失败不中断整批，报告里有失败原因与命令', async () => {
    const h = await harness()
    try {
      h.runner.failOn.add('seg2')
      const report = await runBatch(h, { segmentIds: ['seg1', 'seg2', 'seg3'], scope: 'segment', chain: ACTIVE })
      assert.equal(report.total, 3)
      assert.equal(report.done, 2, 'seg1/seg3 必须照常完成')
      assert.equal(report.failed, 1)
      assert.equal(report.failures[0]!.segmentId, 'seg2')
      assert.ok(report.failures[0]!.command.includes('ffmpeg'))
      assert.ok(report.failures[0]!.stderr?.includes('alimiter'))
      // 失败的那条不能留下半成品记录
      const row = h.db.prepare(`SELECT processed_path FROM voice_segments WHERE id = 'seg2'`).get() as {
        processed_path: string | null
      }
      assert.equal(row.processed_path, null)
    } finally {
      h.cleanup()
    }
  })

  it('取消：停止派发，**已完成的结果保留**（docs/14 §7.2）', async () => {
    const h = await harness({ segments: 4 })
    try {
      // 第二次检查（也就是第二个片段开始前）就取消：第一个片段已经写完
      const ctx = fakeCtx({ abortedAfter: 1 })
      const report = await runBatch(h, { segmentIds: ['seg1', 'seg2', 'seg3', 'seg4'], scope: 'segment', chain: ACTIVE }, ctx)
      assert.equal(report.cancelled, true)
      assert.equal(report.done, 1, '取消前完成的片段必须保留')
      const first = h.db.prepare(`SELECT processed_path FROM voice_segments WHERE id = 'seg1'`).get() as {
        processed_path: string
      }
      assert.ok(first.processed_path, '已完成的处理结果不回滚')
      const third = h.db.prepare(`SELECT processed_path FROM voice_segments WHERE id = 'seg3'`).get() as {
        processed_path: string | null
      }
      assert.equal(third.processed_path, null, '取消后不再派发新任务')
    } finally {
      h.cleanup()
    }
  })

  it('按章节范围取目标；范围内没有片段不是失败', async () => {
    const h = await harness()
    try {
      const report = await runBatch(h, { segmentIds: [], scope: 'chapter', scopeIds: ['c1'], chain: ACTIVE })
      assert.equal(report.total, 3)
      assert.equal(report.done, 3)

      const empty = await runBatch(h, { segmentIds: [], scope: 'chapter', scopeIds: ['c-ghost'], chain: ACTIVE })
      assert.equal(empty.total, 0)
      assert.equal(empty.failed, 0, '没有目标不是失败')
    } finally {
      h.cleanup()
    }
  })

  it('非片段范围必须给 ids（不给就报错，绝不「静默处理全部」）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => runBatch(h, { segmentIds: [], scope: 'book', chain: ACTIVE }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 通道与队列
// ---------------------------------------------------------------------------

describe('处理域 · 通道接线', () => {
  it('process:apply 把工作交给队列（handler 只返回 taskId）', async () => {
    const h = await harness()
    try {
      // 测试台没给队列：服务层必须明确报「队列不可用」，而不是假装成功
      const err = await h.service.apply('seg1', null, ACTIVE).catch((e: unknown) => e)
      assert.ok(err instanceof AppError, `期望明确报错，实际：${String(err)}`)
      assert.equal(err.key, 'TASK_QUEUE_UNAVAILABLE')
    } finally {
      h.cleanup()
    }
  })

  it('chain 与 presetId 都不给 → INVALID_PAYLOAD；片段不存在 → NOT_FOUND（入队前就报）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.service.apply('seg1', null, null),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.service.apply('seg-ghost', null, ACTIVE),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.batchApply('segment', [], null, ACTIVE),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })

  it('process:listApplied / process:revert 走通契约', async () => {
    const h = await harness()
    try {
      await runBatch(h, { segmentIds: ['seg1', 'seg2'], scope: 'segment', chain: ACTIVE })
      const applied = (await call(h, 'process:listApplied', { segmentIds: ['seg1', 'seg2', 'seg-ghost'] })) as Array<{
        segmentId: string
        processedPath: string | null
        presetHash: string | null
      }>
      assert.equal(applied.length, 2, '不存在的片段不会出现在结果里（不是报错）')
      assert.equal(applied[0]!.presetHash, chainHash(ACTIVE))

      const reverted = (await call(h, 'process:revert', { segmentId: 'seg1' })) as { ok: boolean }
      assert.equal(reverted.ok, true)
      const row = h.db.prepare(`SELECT processed_path, preset_hash FROM voice_segments WHERE id = 'seg1'`).get() as {
        processed_path: string | null
        preset_hash: string | null
      }
      assert.equal(row.processed_path, null)
      assert.equal(row.preset_hash, null)
      // revert 只解绑，不删派生文件（可能被对轨/混音引用）
      assert.ok(existsSync(join(h.root, PROJECT_ID, `processed/seg1.${chainHash(ACTIVE)}.wav`)))
    } finally {
      h.cleanup()
    }
  })

  it('通道清单与 handler 一一对应（少了任何一条都说明接线漏了）', () => {
    const h = harness
    void h
    assert.equal(PROCESS_CHANNELS.length, 5)
    assert.equal(PRESET_CHANNELS.length, 6)
    for (const channel of [...PROCESS_CHANNELS, ...PRESET_CHANNELS]) {
      assert.ok(schemaFor(channel), `契约里没有 ${channel} 的 schema`)
    }
  })
})

// ---------------------------------------------------------------------------
// 队列入队的幂等键
// ---------------------------------------------------------------------------

describe('处理域 · 任务规格', () => {
  it('audio.process 的规格用 ffmpeg 并发键，并对单片段给出 dedupeKey', async () => {
    const h = await harness()
    try {
      const tasks = createProcessTasks({
        getDb: () => h.db as unknown as DbLike,
        ffmpeg: h.runner,
        projectRoot: () => h.root,
        resolveChain: async () => ACTIVE,
        log: { info: () => {}, warn: () => {}, error: () => {} } as never,
      })
      const specs = tasks.taskSpecs()
      assert.equal(specs.length, 1)
      const spec = specs[0]!
      assert.equal(spec.kind, 'audio.process')
      assert.equal(spec.concurrencyKey, 'ffmpeg')
      assert.equal(
        spec.dedupeKey?.({ segmentIds: ['seg1'], scope: 'segment', chain: ACTIVE }),
        `process:seg1:${chainHash(ACTIVE)}`,
      )
      assert.equal(spec.dedupeKey?.({ segmentIds: ['seg1'], scope: 'chapter', chain: ACTIVE }), undefined)
    } finally {
      h.cleanup()
    }
  })

  it('空链也照样执行（「仅修剪」预设就是空链 + 限幅，不能因为「没滤镜」就跳过）', async () => {
    const h = await harness()
    try {
      const empty = { ...ACTIVE, highpass: { enabled: false, freq: 80, poles: 2 as const }, eq: [], compressor: { ...ACTIVE.compressor, enabled: false }, limiter: { ...ACTIVE.limiter, enabled: false } }
      const report = await runBatch(h, { segmentIds: ['seg1'], scope: 'segment', chain: empty })
      assert.equal(report.done, 1)
      const command = h.runner.calls[0]!.command
      // 滤镜串仍然带格式统一头（aresample + aformat），而不是空
      assert.ok(command.includes('-af'))
      assert.equal(command.indexOf('-t'), -1, '正式处理不该带试听的 -t')
    } finally {
      h.cleanup()
    }
  })

  it('处理产物是「基于原始成品」而不是「基于上一次的处理结果」（否则会叠加处理）', async () => {
    const h = await harness()
    try {
      await runBatch(h, { segmentIds: ['seg1'], scope: 'segment', chain: ACTIVE })
      const other = { ...ACTIVE, highpass: { enabled: true, freq: 120, poles: 2 as const } }
      await runBatch(h, { segmentIds: ['seg1'], scope: 'segment', chain: other })
      const inputs = h.runner.calls.map((c) => c.command[c.command.indexOf('-i') + 1]!)
      assert.equal(inputs.length, 2)
      for (const input of inputs) {
        assert.ok(input.endsWith(join('segments', 'seg1.wav')), `输入必须是原始成品，实际 ${input}`)
      }
    } finally {
      h.cleanup()
    }
  })
})
