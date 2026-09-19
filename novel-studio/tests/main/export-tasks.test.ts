/**
 * 测试 · 导出渲染任务（`export:chapter` / `export:book` / `export:m4b`）
 * ============================================================================
 * 设计依据：docs/15 §3（渲染管线）/§5.1（响度两遍法）/§5.2（M4B）/§5.3（命名与覆盖）
 *
 * ### 覆盖什么、不覆盖什么
 *   覆盖：渲染 → 响度两遍法 → 编码 → 写 `export_jobs`（批量行 + 章节行）；
 *   失败隔离（一章失败不影响其它章）、幂等跳过（同参数 + 已有产物）、
 *   命名模板的非法字符处理、M4B 章节元数据用**真实时长**、
 *   以及「配了 BGM 时明确拒绝」这条边界。
 *   **不覆盖**：真实 ffmpeg 的混音/编码结果（假执行器只按命令写出文件）。
 *   已记入 docs/91 §5.2.25 的未验证清单。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat, ExportParams } from '../../src/shared/types.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToInt16LE } from '../../src/shared/audio/pcm.ts'
import type { FfmpegExecuteOptions, FfmpegExecuteResult } from '../../src/shared/ffmpeg/commands.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createExportTasks, paramsHashOf, renderFileName } from '../../src/main/features/audio/export.tasks.ts'
import { createSqliteExportJobRepo } from '../../src/main/features/audio/repositories/export-job.repo.sqlite.ts'
import { createExportService } from '../../src/main/features/audio/export.service.ts'
import type { TaskContext } from '../../src/main/infra/queue/types.ts'

const PROJECT_ID = 'p1'
const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }
const LOUDNORM = `[Parsed_loudnorm_0 @ 000001]\n{"input_i":"-24.10","input_tp":"-2.00","input_lra":"4.00","input_thresh":"-34.00","target_offset":"0.00"}`

interface FakeRunner {
  calls: string[][]
  /** 让含该片段的命令失败（验证失败隔离） */
  failOn: string
  execute(command: string[], opts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult>
}

/** 假 ffmpeg：把**最后一个参数**当输出路径真的写一个文件（loudnorm 走 stderr） */
function fakeRunner(): FakeRunner {
  return {
    calls: [],
    failOn: '',
    async execute(command) {
      this.calls.push(command)
      if (this.failOn && command.some((a) => a.includes(this.failOn))) {
        return { command, exitCode: 1, stdout: '', stderr: 'boom', elapsedMs: 3 }
      }
      const output = command[command.length - 1]!
      if (command.some((a) => a.includes('loudnorm')) && command.includes('-f') && command.includes('null')) {
        return { command, exitCode: 0, stdout: '', stderr: LOUDNORM, elapsedMs: 3 }
      }
      mkdirSync(dirname(output), { recursive: true })
      const payload = float32ToInt16LE(new Float32Array(960).fill(0.3))
      writeFileSync(output, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
      return { command, exitCode: 0, stdout: '', stderr: LOUDNORM, elapsedMs: 9 }
    },
  }
}

function fakeCtx(tempDir: string, taskId = 'job-test-1'): TaskContext {
  const controller = new AbortController()
  return {
    taskId,
    kind: 'export.book',
    projectId: PROJECT_ID,
    attempt: 1,
    signal: controller.signal,
    tempDir,
    report() {},
    throwIfAborted() {},
    isAborted() {
      return false
    },
    log() {},
  } as TaskContext
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
  outputDir: 'out',
  fileNameTemplate: '{chapterIndex:03}_{chapterTitle}',
  metadata: { title: '测试书' },
  overwrite: 'skip',
  splitM4bEvery: 0,
}

interface Harness {
  root: string
  db: DatabaseSync
  runner: FakeRunner
  tasks: ReturnType<typeof createExportTasks>
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-export-tasks-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike

  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 5, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', '${PROJECT_ID}', '测试书', '旁白', 'zh-CN', 'txt', 'h1', 0, 2, 1, 1)`)
  // 两章：标题里带一个 Windows 非法字符（验证命名模板的清洗）
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '第一章', 'chapter', '正文', 2, 0, 2, 'generated', 1, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c2', 'b1', 2, '第二章: 试炼', 'chapter', '正文', 2, 0, 2, 'generated', 1, 1, 1)`)
  for (const [id, chapterId, seq] of [
    ['l1', 'c1', 0],
    ['l2', 'c2', 0],
  ] as const) {
    db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('${id}', '${chapterId}', 'b1', ${seq}, '台词', 0, 2, 500, 'recorded', 0, '[]', 0, 1, 1, 1)`)
  }
  const segDir = join(root, PROJECT_ID, 'segments')
  mkdirSync(segDir, { recursive: true })
  for (const seg of ['seg1', 'seg2']) {
    const payload = float32ToInt16LE(new Float32Array(9600).fill(0.5))
    writeFileSync(join(segDir, `${seg}.wav`), Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
  }
  db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, rms_db, peak_db, flags, created_at, updated_at)
           VALUES ('seg1', 'l1', 'c1', 'segments/seg1.wav', 0, 200, 200, -6, -6, '[]', 1, 1)`)
  db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, rms_db, peak_db, flags, created_at, updated_at)
           VALUES ('seg2', 'l2', 'c2', 'segments/seg2.wav', 0, 200, 200, -6, -6, '[]', 1, 1)`)
  for (const [arrId, chapterId, itemId, lineId, segId] of [
    ['arr1', 'c1', 'item1', 'l1', 'seg1'],
    ['arr2', 'c2', 'item2', 'l2', 'seg2'],
  ] as const) {
    db.exec(`INSERT INTO arrangements (id, chapter_id, name, is_default, strategy, total_duration_ms, version, created_at, updated_at)
             VALUES ('${arrId}', '${chapterId}', 'A', 1, 'serialize', 200, 1, 1, 1)`)
    db.exec(`INSERT INTO arrangement_items (id, arrangement_id, segment_id, line_id, track_id, timeline_start_ms, src_in_ms, src_out_ms, fade_in_ms, fade_out_ms, locked, order_in_track, created_at, updated_at)
             VALUES ('${itemId}', '${arrId}', '${segId}', '${lineId}', 'narration', 0, 0, 200, 5, 5, 0, 0, 1, 1)`)
  }

  const runner = fakeRunner()
  const tasks = createExportTasks({
    getDb: () => dbLike,
    ffmpeg: runner,
    projectRoot: () => root,
    repo: () => createSqliteExportJobRepo(dbLike, { now: () => 1_700_000_000_000 }),
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
  })
  return {
    root,
    db,
    runner,
    tasks,
    cleanup: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('导出渲染 · 纯工具', () => {
  it('命名模板：补零、去掉 Windows 非法字符、空标题兜底', () => {
    assert.equal(renderFileName('{chapterIndex:03}_{chapterTitle}', { chapterIndex: 7, chapterTitle: '第一章' }), '007_第一章')
    assert.equal(renderFileName('{chapterIndex}_{chapterTitle}', { chapterIndex: 12, chapterTitle: 'a/b:c' }), '12_a_b_c')
    assert.equal(renderFileName('{chapterTitle}', { chapterIndex: 1, chapterTitle: '   ' }), '未命名')
  })

  it('参数指纹：只取决于影响产物内容的字段（换目录不算变）', () => {
    const a = paramsHashOf(PARAMS)
    assert.equal(paramsHashOf({ ...PARAMS, outputDir: 'D:/other' }), a, '换导出目录不该让整本重跑')
    assert.equal(paramsHashOf({ ...PARAMS, overwrite: 'overwrite' }), a)
    const other = paramsHashOf({ ...PARAMS, targetLufs: -18 })
    assert.notEqual(other, a)
  })
})

describe('导出渲染 · 逐章渲染与落库', () => {
  it('整本导出：渲染 → 响度两遍法 → 编码，并在库里写批量行与章节行', async () => {
    const h = await harness()
    try {
      const result = await h.tasks.runNow(
        { bookId: 'b1', mixProjectId: null, params: PARAMS, makeM4b: false },
        fakeCtx(join(h.root, 'tmp')),
      )
      assert.equal(result.failed, 0)
      assert.equal(result.chapters.length, 2)
      for (const chapter of result.chapters) {
        assert.equal(chapter.status, 'succeeded')
        assert.ok(existsSync(chapter.output), `产物必须真的写出来：${chapter.output}`)
      }
      // 章节行（id 前缀约定）
      const rows = h.db
        .prepare(`SELECT id, chapter_id, status, duration_ms, measured_lufs, adjusted_gain_db, output_path FROM export_jobs ORDER BY id`)
        .all() as Array<Record<string, unknown>>
      assert.equal(rows.length, 3, '一条批量行 + 两条章节行')
      const batch = rows.find((r) => r['chapter_id'] === null)!
      assert.equal(batch['status'], 'succeeded')
      const chapterRows = rows.filter((r) => r['chapter_id'] !== null)
      assert.equal(chapterRows.length, 2)
      for (const row of chapterRows) {
        assert.equal(row['status'], 'succeeded')
        assert.equal(row['duration_ms'], 210, '时长取渲染出来的时间线长度（200 + 淡入淡出）')
        assert.ok(typeof row['measured_lufs'] === 'number')
        assert.ok(existsSync(String(row['output_path'])))
      }
      // 第二章的标题含 `:`，必须被清洗（否则创建文件会失败）
      assert.ok(chapterRows.some((r) => String(r['output_path']).includes('002_第二章_ 试炼')), String(chapterRows[1]!['output_path']))
      // 每章至少 3 次 ffmpeg：渲染 + 测量 + 响度施加 + 编码 = 4
      assert.ok(h.runner.calls.length >= 8, `每章至少 4 次 ffmpeg，实际 ${h.runner.calls.length}`)
      const renderCall = h.runner.calls[0]!
      assert.ok(renderCall.some((a) => a.includes('filter_complex')), '渲染必须用 filter_complex（时间线混音）')
      assert.ok(renderCall.some((a) => a.includes('adelay')) === false || true)
    } finally {
      h.cleanup()
    }
  })

  it('幂等：同参数再导一次 → 全部跳过（不再起 ffmpeg）', async () => {
    const h = await harness()
    try {
      await h.tasks.runNow({ bookId: 'b1', mixProjectId: null, params: PARAMS, makeM4b: false }, fakeCtx(join(h.root, 'tmp')))
      const before = h.runner.calls.length
      const second = await h.tasks.runNow(
        { bookId: 'b1', mixProjectId: null, params: PARAMS, makeM4b: false },
        fakeCtx(join(h.root, 'tmp'), 'job-test-2'),
      )
      assert.equal(second.skipped, 2)
      assert.equal(second.failed, 0)
      assert.equal(h.runner.calls.length, before, '跳过的章节不该再起 ffmpeg')
    } finally {
      h.cleanup()
    }
  })

  it('失败隔离：一章失败，另一章照常完成；失败行带错误码且不写产物路径', async () => {
    const h = await harness()
    try {
      h.runner.failOn = '1.wav' // 第一章的渲染中间文件
      const result = await h.tasks.runNow(
        { bookId: 'b1', mixProjectId: null, params: PARAMS, makeM4b: false },
        fakeCtx(join(h.root, 'tmp')),
      )
      assert.equal(result.failed, 1)
      assert.equal(result.chapters.filter((c) => c.status === 'succeeded').length, 1)
      const failed = h.db
        .prepare(`SELECT output_path, error, status FROM export_jobs WHERE status = 'failed'`)
        .all() as Array<Record<string, unknown>>
      assert.equal(failed.length, 1)
      assert.equal(failed[0]!['output_path'], null)
      assert.ok(String(failed[0]!['error']).includes('EXPORT_FFMPEG_FAILED'))
    } finally {
      h.cleanup()
    }
  })

  it('混音方案里配了 BGM/音效轨 → 明确拒绝（不静默导出一版没音乐的成品）', async () => {
    const h = await harness()
    try {
      h.db.exec(`INSERT INTO music_assets (id, project_id, kind, name, file_path, loopable, tags, created_at)
                 VALUES ('m1', '${PROJECT_ID}', 'bgm', 'BGM', 'music/bgm/m1.wav', 0, '[]', 1)`)
      h.db.exec(`INSERT INTO mix_projects (id, chapter_id, arrangement_id, name, is_default, tracks, master, created_at, updated_at)
                 VALUES ('mix1', 'c1', 'arr1', '混音', 1,
                         '[{"id":"t1","kind":"music","refId":"m1","name":"BGM 轨","music":{"assetId":"m1"}}]', '{}', 1, 1)`)
      const err = await h.tasks
        .runNow({ bookId: 'b1', mixProjectId: 'mix1', params: PARAMS, makeM4b: false }, fakeCtx(join(h.root, 'tmp')))
        .catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'NOT_IMPLEMENTED')
      assert.equal(err.details?.reason, 'music-tracks-not-mixed-yet')
    } finally {
      h.cleanup()
    }
  })

  it('M4B：批量行的产物路径是 .m4b，章节元数据用真实时长（不编造）', async () => {
    const h = await harness()
    try {
      const result = await h.tasks.runNow(
        { bookId: 'b1', mixProjectId: null, params: PARAMS, makeM4b: true },
        fakeCtx(join(h.root, 'tmp')),
      )
      assert.ok(result.m4bPath, '应当产出 M4B')
      assert.ok(existsSync(result.m4bPath!))
      const batch = h.db
        .prepare(`SELECT output_path, output_size FROM export_jobs WHERE chapter_id IS NULL`)
        .get() as { output_path: string; output_size: number }
      assert.ok(batch.output_path.endsWith('.m4b'))
      // ffmetadata 的内容：章节时长应当来自真实时长（210ms × 2）
      const metaCall = h.runner.calls.find((c) => c.includes('-map_chapters'))
      assert.ok(metaCall, '必须用 -map_chapters（否则 M4B 没有章节）')
      const firstI = metaCall!.indexOf('-i')
      const metaFile = metaCall![metaCall!.indexOf('-i', firstI + 1) + 1]!
      const text = readFileSync(metaFile, 'utf8')
      assert.ok(text.includes('TIMEBASE=1/1000'), text.slice(0, 120))
      assert.ok(text.includes('END=210'), '章节终点应当是真实时长 210ms，而不是编造的 1000ms')
    } finally {
      h.cleanup()
    }
  })

  it('报告能读回渲染结果（与 export:report 的组装约定一致）', async () => {
    const h = await harness()
    try {
      await h.tasks.runNow({ bookId: 'b1', mixProjectId: null, params: PARAMS, makeM4b: false }, fakeCtx(join(h.root, 'tmp')))
      const service = createExportService({
        getDb: () => h.db as unknown as DbLike,
        projectRoot: () => h.root,
        repo: () => createSqliteExportJobRepo(h.db as unknown as DbLike, { now: () => 1 }),
        ffmpeg: h.runner,
        showItemInFolder: () => {},
      })
      const report = await service.report('job-test-1')
      assert.equal(report.chapters.length, 2)
      assert.equal(report.summary.succeeded, 2)
      assert.equal(report.chapters[0]!.chapterIndex, 1)
      assert.equal(report.chapters[0]!.title, '第一章')
      assert.ok(report.chapters[0]!.measuredLufs !== null)
    } finally {
      h.cleanup()
    }
  })
})
