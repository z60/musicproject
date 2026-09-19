/**
 * 测试 · 导出域（`export:*` 8 个通道中的 5 个已实现通道）
 * ============================================================================
 * 设计依据：docs/15 §4（导出前预检）/§6（报告与验收）、docs/21 §6（export_jobs）
 *
 * ### 这组测试的重点
 *   1. **预检必须真的算**：缺录 / 文件丢失 / 无对轨方案是**阻断项**，静音/削波/过短是
 *      **警告**；两者混在一起会让用户不知道能不能点导出。文件是否在盘上是真 `stat`。
 *   2. **报告从库里组装**：批量行 + 章节行（id 前缀 `{jobId}#{index}`）的约定必须被钉住，
 *      否则报告会静默少几章。
 *   3. **验收是复测产物**：`export:verify` 调 loudnorm 重新测，并把结果写回行 ——
 *      不能拿导出时的自估值自我背书（docs/15 §6.2）。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat, ExportParams } from '../../src/shared/types.ts'
import { VBR_PRESETS } from '../../src/shared/constants.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToInt16LE } from '../../src/shared/audio/pcm.ts'
import type { FfmpegExecuteOptions, FfmpegExecuteResult } from '../../src/shared/ffmpeg/commands.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createExportService, chapterJobId } from '../../src/main/features/audio/export.service.ts'
import { createSqliteExportJobRepo } from '../../src/main/features/audio/repositories/export-job.repo.sqlite.ts'
import { createExportHandlers, EXPORT_CHANNELS } from '../../src/main/ipc/handlers/export.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'

const PROJECT_ID = 'p1'
const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }

const LOUDNORM_STDERR = `[Parsed_loudnorm_0 @ 000001]
{
	"input_i" : "-17.42",
	"input_tp" : "-1.55",
	"input_lra" : "5.20",
	"input_thresh" : "-27.10",
	"target_offset" : "-1.20"
}`

interface FakeRunner {
  calls: string[][]
  stderr: string
  throwEnoent: boolean
  execute(command: string[], opts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult>
}

function fakeRunner(): FakeRunner {
  return {
    calls: [],
    stderr: LOUDNORM_STDERR,
    throwEnoent: false,
    async execute(command) {
      this.calls.push(command)
      if (this.throwEnoent) {
        const e = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      return { command, exitCode: 0, stdout: '', stderr: this.stderr, elapsedMs: 5 }
    },
  }
}

const PARAMS: ExportParams = {
  format: 'mp3',
  mp3Bitrate: 192,
  m4bBitrate: 96,
  sampleRate: 44100,
  targetLufs: -16,
  truePeakDb: -1,
  lra: 11,
  headSilenceMs: 500,
  tailSilenceMs: 1500,
  outputDir: 'C:/export-out',
  fileNameTemplate: '{chapterIndex:03}_{chapterTitle}',
  metadata: {},
  overwrite: 'skip',
  splitM4bEvery: 0,
}

interface Harness {
  root: string
  db: DatabaseSync
  runner: FakeRunner
  service: ReturnType<typeof createExportService>
  handlers: ReturnType<typeof createExportHandlers>
  opened: string[]
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-export-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike

  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 5, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', '${PROJECT_ID}', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 2, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '第一章', 'chapter', '正文', 2, 0, 2, 'generated', 2, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c2', 'b1', 2, '第二章', 'chapter', '正文', 2, 0, 2, 'generated', 1, 1, 1)`)
  // c1：l1 有片段（文件存在）、l2 缺录；c2：l3 有片段但**文件不在盘上**
  for (const [id, chapterId, seq] of [
    ['l1', 'c1', 0],
    ['l2', 'c1', 1],
    ['l3', 'c2', 0],
  ] as const) {
    db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('${id}', '${chapterId}', 'b1', ${seq}, '台词', 0, 2, 500, 'recorded', 0, '[]', 0, 1, 1, 1)`)
  }
  const segDir = join(root, PROJECT_ID, 'segments')
  mkdirSync(segDir, { recursive: true })
  const payload = float32ToInt16LE(new Float32Array(9600).fill(0.5))
  writeFileSync(join(segDir, 'seg1.wav'), Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
  db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, rms_db, peak_db, flags, created_at, updated_at)
           VALUES ('seg1', 'l1', 'c1', 'segments/seg1.wav', 0, 200, 200, -6, -6, '[]', 1, 1)`)
  // seg2 的行在 c2，但**不写文件**：预检要报 file_missing
  db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, rms_db, peak_db, flags, created_at, updated_at)
           VALUES ('seg2', 'l3', 'c2', 'segments/seg2-missing.wav', 0, 200, 200, -6, -6, '[]', 1, 1)`)
  // c1 有默认对轨方案（c2 没有 → 预检应报 no_arrangement）
  db.exec(`INSERT INTO arrangements (id, chapter_id, name, is_default, strategy, total_duration_ms, version, created_at, updated_at)
           VALUES ('arr1', 'c1', 'A', 1, 'serialize', 200, 1, 1, 1)`)
  db.exec(`INSERT INTO arrangement_items (id, arrangement_id, segment_id, line_id, track_id, timeline_start_ms,
                                          src_in_ms, src_out_ms, fade_in_ms, fade_out_ms, locked, order_in_track,
                                          created_at, updated_at)
           VALUES ('item1', 'arr1', 'seg1', 'l1', 'narration', 0, 0, 200, 5, 5, 0, 0, 1, 1)`)

  const runner = fakeRunner()
  const opened: string[] = []
  const service = createExportService({
    getDb: () => dbLike,
    projectRoot: () => root,
    repo: () => createSqliteExportJobRepo(dbLike, { now: () => 1_700_000_000_000 }),
    ffmpeg: runner,
    showItemInFolder: (path) => opened.push(path),
  })

  return {
    root,
    db,
    runner,
    service,
    opened,
    handlers: createExportHandlers({
      export: service,
      // 本文件只测非渲染通道；渲染任务自己的测试在 export-tasks.test.ts
      tasks: {
        enqueueChapter: async () => ({ taskId: 'task-1' }),
        enqueueBook: async () => ({ taskId: 'task-1' }),
        enqueueM4b: async () => ({ taskId: 'task-1' }),
        taskSpecs: () => [],
        runNow: async () => ({ jobId: 'job-1', bookId: 'b1', chapters: [], m4bPath: null, failed: 0, skipped: 0 }),
      } as never,
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

/** 造一行导出任务（模拟渲染任务已经跑过） */
function seedJob(
  h: Harness,
  input: {
    jobId: string
    chapterId?: string | null
    chapterIndex?: number
    status?: 'succeeded' | 'failed' | 'skipped'
    outputPath?: string | null
    durationMs?: number | null
    warnings?: string[]
  },
): void {
  const id = input.chapterId ? chapterJobId(input.jobId, input.chapterIndex ?? 1) : input.jobId
  h.db
    .prepare(
      `INSERT INTO export_jobs (id, project_id, book_id, chapter_id, mix_project_id, arrangement_id, params,
                                params_hash, output_path, output_size, measured_lufs, measured_tp_db,
                                adjusted_gain_db, duration_ms, status, error, warnings, started_at, finished_at, created_at)
       VALUES (?, ?, 'b1', ?, NULL, 'arr1', ?, 'hash1', ?, 1024, -16.2, -1.3, 1.2, ?, ?, NULL, ?, 1000, 2000, 1000)`,
    )
    .run(
      id,
      PROJECT_ID,
      input.chapterId ?? null,
      JSON.stringify(PARAMS),
      input.outputPath ?? null,
      input.durationMs ?? 200,
      input.status ?? 'succeeded',
      JSON.stringify(input.warnings ?? []),
    )
}

// ---------------------------------------------------------------------------
// 预检
// ---------------------------------------------------------------------------

describe('导出域 · export:preCheck', () => {
  it('缺录 / 文件丢失 / 无对轨方案都是**阻断项**；统计口径正确', async () => {
    const h = await harness()
    try {
      const result = await h.service.preCheck({ bookId: 'b1', mixProjectId: null, params: PARAMS })
      const kinds = result.blockers.map((b) => b.kind)
      assert.ok(kinds.includes('missing_line'), 'l2 缺录 → missing_line')
      assert.ok(kinds.includes('file_missing'), 'seg2 的文件不在盘上 → file_missing')
      assert.ok(kinds.includes('no_arrangement'), 'c2 没有对轨方案 → no_arrangement')
      assert.equal(result.stats.chapters, 2)
      assert.equal(result.stats.lines, 3)
      assert.equal(result.stats.recordedLines, 2)
      assert.equal(result.stats.missingLines, 1)
      assert.equal(result.stats.totalDurationMs, 400, '两条已录片段各 200ms')
      // 没有混音方案只是警告（会用默认母带设置）
      assert.ok(result.warnings.some((w) => w.kind === 'no_mix_project'))
      // 阻断项必须带章节/行定位，UI 才能跳过去
      const missing = result.blockers.find((b) => b.kind === 'missing_line')!
      assert.equal(missing.chapterId, 'c1')
      assert.equal(missing.lineId, 'l2')
    } finally {
      h.cleanup()
    }
  })

  it('静音与削波是**警告**而不是阻断项（可以导出，但要让用户知道）', async () => {
    const h = await harness()
    try {
      h.db.exec(`UPDATE voice_segments SET rms_db = -70, peak_db = 0 WHERE id = 'seg1'`)
      const result = await h.service.preCheck({ bookId: 'b1', chapterIds: ['c1'], mixProjectId: null, params: PARAMS })
      assert.ok(result.warnings.some((w) => w.kind === 'silent_segment'))
      assert.ok(result.warnings.some((w) => w.kind === 'clipped_segment'))
      assert.equal(result.blockers.some((b) => b.kind === 'silent_segment'), false)
      assert.equal(result.blockers.some((b) => b.kind === 'clipped_segment'), false)
    } finally {
      h.cleanup()
    }
  })

  it('chapterIds 过滤生效；混音方案不存在 → 阻断；书不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      const only = await h.service.preCheck({ bookId: 'b1', chapterIds: ['c1'], mixProjectId: null, params: PARAMS })
      assert.equal(only.stats.chapters, 1)
      assert.equal(only.stats.missingLines, 1)

      const withMissingMix = await h.service.preCheck({
        bookId: 'b1',
        chapterIds: ['c1'],
        mixProjectId: 'mix-ghost',
        params: PARAMS,
      })
      assert.ok(withMissingMix.blockers.some((b) => b.kind === 'mix_project_missing'))

      await assert.rejects(
        () => h.service.preCheck({ bookId: 'b-ghost', mixProjectId: null, params: PARAMS }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('handler 层：export:preCheck 走通契约（含默认参数）', async () => {
    const h = await harness()
    try {
      const result = (await call(h, 'export:preCheck', {
        bookId: 'b1',
        chapterIds: ['c1'],
        mixProjectId: null,
        params: PARAMS,
      })) as { stats: { chapters: number } }
      assert.equal(result.stats.chapters, 1)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

describe('导出域 · export:report', () => {
  it('批量行 + 章节行（id 前缀）组装成报告；序号取章节 seq、成功/跳过/失败分别统计', async () => {
    const h = await harness()
    try {
      seedJob(h, { jobId: 'job1' })
      seedJob(h, { jobId: 'job1', chapterId: 'c1', chapterIndex: 1, outputPath: 'out/001.mp3', durationMs: 1234, warnings: ['峰值贴顶'] })
      seedJob(h, { jobId: 'job1', chapterId: 'c2', chapterIndex: 2, status: 'failed', outputPath: null })
      const report = await h.service.report('job1')
      assert.equal(report.jobId, 'job1')
      assert.equal(report.chapters.length, 2, '两章的结果都要在报告里')
      assert.equal(report.summary.total, 2)
      assert.equal(report.summary.succeeded, 1)
      assert.equal(report.summary.failed, 1)
      assert.equal(report.summary.warnings, 1)
      assert.equal(report.summary.totalDurationMs, 1234)
      const first = report.chapters.find((c) => c.chapterId === 'c1')!
      assert.equal(first.chapterIndex, 1)
      assert.equal(first.title, '第一章', '标题从 chapters 表取（不冗余存）')
      assert.equal(first.durationMs, 1234)
      assert.equal(first.output, 'out/001.mp3')
      assert.equal(first.sizeBytes, 1024)
      assert.equal(first.targetLufs, -16)
      assert.deepEqual(first.warnings, ['峰值贴顶'])
      assert.equal(report.elapsedMs, 1000, '批量行的 startedAt/finishedAt 决定耗时')
      assert.equal(report.m4b, null)
    } finally {
      h.cleanup()
    }
  })

  it('批量行的产物是 .m4b 时，报告的 m4b 字段才有值', async () => {
    const h = await harness()
    try {
      seedJob(h, { jobId: 'job2', outputPath: 'out/book.m4b' })
      seedJob(h, { jobId: 'job2', chapterId: 'c1', chapterIndex: 1, outputPath: 'out/001.mp3' })
      const report = await h.service.report('job2')
      assert.ok(report.m4b)
      assert.equal(report.m4b!.path, 'out/book.m4b')
      assert.equal(report.m4b!.chapters, 1)
      assert.equal(report.m4b!.verified, true)
    } finally {
      h.cleanup()
    }
  })

  it('jobId 不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.service.report('job-ghost'),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 验收与定位
// ---------------------------------------------------------------------------

describe('导出域 · export:verify / export:openFolder / export:vbrPresets', () => {
  it('verify 复测每个产物（loudnorm）并把验收值写回行', async () => {
    const h = await harness()
    try {
      seedJob(h, { jobId: 'job3' })
      seedJob(h, { jobId: 'job3', chapterId: 'c1', chapterIndex: 1, outputPath: 'out/001.mp3' })
      seedJob(h, { jobId: 'job3', chapterId: 'c2', chapterIndex: 2, outputPath: 'out/002.mp3' })
      const result = await h.service.verify('job3')
      assert.equal(result.chapters.length, 2)
      assert.equal(result.chapters[0]!.path, 'out/001.mp3')
      assert.ok(result.chapters[0]!.measuredLufs !== null)
      assert.ok(Math.abs(result.chapters[0]!.measuredLufs! - -17.42) < 0.01)
      assert.ok(Math.abs(result.chapters[0]!.measuredTp! - -1.55) < 0.01)
      assert.equal(h.runner.calls.length, 2, '每个产物复测一次')
      // 验收值写回库（报告里显示的是验收值，不是导出时的自估值）
      const row = h.db
        .prepare(`SELECT measured_lufs, measured_tp_db FROM export_jobs WHERE id = ?`)
        .get(chapterJobId('job3', 1)) as { measured_lufs: number; measured_tp_db: number }
      assert.ok(Math.abs(row.measured_lufs - -17.42) < 0.01)
      assert.ok(Math.abs(row.measured_tp_db - -1.55) < 0.01)
    } finally {
      h.cleanup()
    }
  })

  it('verify：没装 ffmpeg → EXPORT_FFMPEG_FAILED(ffmpeg-not-found)；没有产物 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      seedJob(h, { jobId: 'job4', chapterId: 'c1', chapterIndex: 1, outputPath: 'out/001.mp3' })
      h.runner.throwEnoent = true
      const err = await h.service.verify('job4').catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'EXPORT_FFMPEG_FAILED')
      assert.equal(err.details?.reason, 'ffmpeg-not-found')

      await assert.rejects(
        () => h.service.verify('job-ghost'),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('openFolder：有产物才定位；没有产物明确报错（不把用户丢到目录里自己找）', async () => {
    const h = await harness()
    try {
      seedJob(h, { jobId: 'job5', outputPath: 'out/book.mp3' })
      const ok = await h.service.openFolder('job5')
      assert.equal(ok.ok, true)
      assert.deepEqual(h.opened, ['out/book.mp3'])

      seedJob(h, { jobId: 'job6', outputPath: null, status: 'failed' })
      const err = await h.service.openFolder('job6').catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'NOT_FOUND')
      assert.equal(err.details?.entity, 'export_output')
    } finally {
      h.cleanup()
    }
  })

  it('vbrPresets：返回 -q:a 档位（值不是码率）；通道清单与契约一致', async () => {
    const h = await harness()
    try {
      const presets = await h.service.vbrPresets()
      assert.equal(presets.length, VBR_PRESETS.length)
      assert.equal(presets[0]!.value, 0)
      assert.ok(presets[0]!.label.includes('V0'))
      assert.equal(EXPORT_CHANNELS.length, 8, '8 个通道全部接线（渲染任务在 export-tasks.test.ts 里测）')
      for (const channel of EXPORT_CHANNELS) {
        assert.ok(schemaFor(channel), `契约里没有 ${channel} 的 schema`)
      }
      // 三个渲染任务**不在**已实现清单里（它们在下一轮，占位清单会如实列出）
      assert.equal(EXPORT_CHANNELS.includes('export:chapter'), true)
      assert.equal(EXPORT_CHANNELS.includes('export:book'), true)
      assert.equal(EXPORT_CHANNELS.includes('export:m4b'), true)
    } finally {
      h.cleanup()
    }
  })
})
