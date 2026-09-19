/**
 * 测试 · 对轨域（`alignment:*` 19 个通道）
 * ============================================================================
 * 设计依据：docs/13 §3–§7、docs/21 §6（arrangements / arrangement_items）、
 *           docs/04 §2.2（任务并发键与幂等键）
 *
 * ### 为什么必须用真库
 *   对轨是**写库最密集**的域：一次「自动排布」= 全量替换 items + 方案摘要更新 + version+1。
 *   用假仓储测只能证明「调用顺序」，证明不了：
 *   · `replaceItems` 是原子的（中途失败不留空时间线）；
 *   · 「每章至多一个默认方案」真的只留了一个；
 *   · `UNIQUE(line_id)` 冲突时绑定返回 `taken` 而不是抛原始约束错误。
 *   这些都是 SQL 语义，必须在真 SQLite 上验。
 *
 * ### 为什么注入假 ffmpeg
 *   预览渲染需要真 ffmpeg（见 docs/91 §5.2.20 的说明）。这里用假执行器**真的写文件**，
 *   验证「命令构造 + 输出路径 + 任务语义」，不验证「ffmpeg 真的混出了声音」。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { AudioFormat } from '../../src/shared/types.ts'
import { ALIGN_ISSUE_LABELS, ARRANGE_DEFAULTS } from '../../src/shared/constants.ts'
import { writeWavHeader } from '../../src/shared/audio/wav.ts'
import { float32ToInt16LE } from '../../src/shared/audio/pcm.ts'
import {
  buildArrangementFilterGraph,
  buildArrangementRenderCommand,
  clampPreviewDuration,
  PREVIEW_RENDER_DEFAULT_MS,
  PREVIEW_RENDER_MAX_MS,
} from '../../src/shared/ffmpeg/arrangement-render.ts'
import type { FfmpegExecuteOptions, FfmpegExecuteResult } from '../../src/shared/ffmpeg/commands.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { createAlignmentService, type AlignmentService } from '../../src/main/features/audio/alignment.service.ts'
import { createAlignmentLineQueries, createAlignmentSegmentQueries } from '../../src/main/features/audio/alignment.queries.ts'
import { createSqliteArrangementRepo } from '../../src/main/features/audio/repositories/arrangement.repo.sqlite.ts'
import { createRenderTasks } from '../../src/main/features/audio/render.tasks.ts'
import { createAlignmentHandlers, ALIGNMENT_CHANNELS } from '../../src/main/ipc/handlers/alignment.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'
import type { TaskContext } from '../../src/main/infra/queue/types.ts'

const PROJECT_ID = 'p1'
const FORMAT: AudioFormat = { sampleRate: 48000, bitDepth: 16, channels: 1 }

// ---------------------------------------------------------------------------
// 假 ffmpeg（真写文件）
// ---------------------------------------------------------------------------

interface FakeRunner {
  calls: string[][]
  failNext: boolean
  execute(command: string[], opts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult>
}

function fakeRunner(): FakeRunner {
  return {
    calls: [],
    failNext: false,
    async execute(command, opts) {
      this.calls.push(command)
      if (this.failNext) {
        return { command, exitCode: 1, stdout: '', stderr: 'Invalid argument', elapsedMs: 3 }
      }
      const output = command[command.length - 1]!
      mkdirSync(dirname(output), { recursive: true })
      const payload = float32ToInt16LE(new Float32Array(4800).fill(0.1))
      writeFileSync(output, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
      opts?.onProgressLine?.('out_time_us=100000')
      return { command, exitCode: 0, stdout: '', stderr: '', elapsedMs: 7 }
    },
  }
}

function fakeCtx(tempDir: string): TaskContext {
  const controller = new AbortController()
  return {
    taskId: 'task-render-1',
    kind: 'audio.render',
    projectId: PROJECT_ID,
    attempt: 1,
    signal: controller.signal,
    tempDir,
    report() {},
    throwIfAborted() {},
    isAborted() {
      return controller.signal.aborted
    },
    log() {},
  } as TaskContext
}

// ---------------------------------------------------------------------------
// 测试台
// ---------------------------------------------------------------------------

interface Harness {
  root: string
  db: DatabaseSync
  runner: FakeRunner
  service: AlignmentService
  handlers: ReturnType<typeof createAlignmentHandlers>
  render: ReturnType<typeof createRenderTasks>
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-align-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike

  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', '${PROJECT_ID}', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 2, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '第一章', 'chapter', '正文', 2, 0, 2, 'generated', 3, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c2', 'b1', 2, '第二章', 'chapter', '正文', 2, 0, 2, 'generated', 1, 1, 1)`)
  db.exec(`INSERT INTO characters (id, book_id, name, aliases, created_at, updated_at)
           VALUES ('ch1', 'b1', '萧炎', '[]', 1, 1)`)
  // 三行：旁白 / 角色 / 旁白（后者缺录）
  const lineRows: Array<[string, string, number, string, string | null, number]> = [
    ['l1', 'c1', 0, 'narration', null, 10],
    ['l2', 'c1', 1, 'character', 'ch1', 8],
    ['l3', 'c1', 2, 'narration', null, 12],
  ]
  for (const [id, chapterId, seq, speaker, characterId, chars] of lineRows) {
    db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, speaker_type, character_id, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('${id}', '${chapterId}', 'b1', ${seq}, '${speaker}', ${characterId ? `'${characterId}'` : 'NULL'},
                     '${'字'.repeat(chars)}', 0, ${chars}, 500, 'recorded', 0, '[]', 0, 1, 1, 1)`)
  }
  // 第二章有一行（用来造「孤儿片段」：行不在本章了）
  db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, speaker_type, text, char_start, char_end, pause_after_ms, state, needs_review, flags, is_title, rev, created_at, updated_at)
           VALUES ('l9', 'c2', 'b1', 0, 'narration', '字幕', 0, 2, 500, 'recorded', 0, '[]', 0, 1, 1, 1)`)

  // 片段：seg1 → l1（文件存在）、seg2 → l2（**文件不存在**，用于 file_missing）、
  // seg9 属于 c1 但绑在 c2 的行上（孤儿）
  function writeSegmentFile(rel: string): void {
    const abs = join(root, PROJECT_ID, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const payload = float32ToInt16LE(new Float32Array(4800).fill(0.5))
    writeFileSync(abs, Buffer.concat([writeWavHeader({ dataBytes: payload.length, format: FORMAT }), payload]))
  }
  writeSegmentFile('segments/seg1.wav')
  writeSegmentFile('segments/seg9.wav')
  const segments: Array<[string, string, string, string, number, number]> = [
    ['seg1', 'l1', 'c1', 'segments/seg1.wav', 2000, -20],
    ['seg2', 'l2', 'c1', 'segments/seg2.wav', 1600, -18],
    // 时长取 2200 ms：接近 l3（12 字 ≈ 2400 ms）的期望时长，这样「按时长匹配」才有解
    ['seg9', 'l9', 'c1', 'segments/seg9.wav', 2200, -22],
  ]
  for (const [id, lineId, chapterId, rel, duration, rms] of segments) {
    db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, rms_db, peak_db, flags, created_at, updated_at)
             VALUES ('${id}', '${lineId}', '${chapterId}', '${rel}', 0, ${duration}, ${duration}, ${rms}, -3, '[]', 1, 1)`)
  }

  const runner = fakeRunner()
  const lines = createAlignmentLineQueries(() => dbLike)
  const segs = createAlignmentSegmentQueries(() => dbLike, () => 1)
  const render = createRenderTasks({
    getDb: () => dbLike,
    ffmpeg: runner,
    projectRoot: () => root,
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
  })
  let seq = 0
  const service = createAlignmentService({
    getDb: () => dbLike,
    projectRoot: () => root,
    repo: () =>
      createSqliteArrangementRepo(dbLike, { newId: (prefix) => `${prefix}-${++seq}`, now: () => 1_700_000_000_000 }),
    lines,
    segments: segs,
    render: { enqueuePreview: (payload) => render.enqueuePreview(payload) },
    audioSettings: () => ({ vad: { charsPerSecond: 5 } }),
    newId: (prefix) => `${prefix}-${++seq}`,
  })

  return {
    root,
    db,
    runner,
    service,
    render,
    handlers: createAlignmentHandlers({
      alignment: service,
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

// ---------------------------------------------------------------------------
// 方案（arrangement）
// ---------------------------------------------------------------------------

describe('对轨域 · 方案管理', () => {
  it('create：第一个方案自动成为默认；list 把默认排在前面', async () => {
    const h = await harness()
    try {
      const first = await h.service.create('c1', '方案 A', 'serialize')
      assert.equal(first.isDefault, true, '该章第一个方案必须是默认（否则导出不知道用哪份）')
      const second = await h.service.create('c1', '方案 B', 'tighten')
      assert.equal(second.isDefault, false)
      const list = await h.service.listArrangements('c1')
      assert.equal(list.length, 2)
      assert.equal(list[0]!.id, first.id)
      assert.equal(list[0]!.isDefault, true)
    } finally {
      h.cleanup()
    }
  })

  it('setDefault：同章只留一个默认（DDL 没有这个约束，全靠实现）', async () => {
    const h = await harness()
    try {
      const a = await h.service.create('c1', 'A', 'serialize')
      const b = await h.service.create('c1', 'B', 'serialize')
      await h.service.setDefault(b.id)
      const rows = h.db
        .prepare(`SELECT id, is_default FROM arrangements WHERE chapter_id = 'c1' ORDER BY id`)
        .all() as Array<{ id: string; is_default: number }>
      assert.equal(rows.filter((r) => r.is_default === 1).length, 1, '默认方案必须唯一')
      assert.equal(rows.find((r) => r.is_default === 1)!.id, b.id)
      assert.equal(rows.find((r) => r.id === a.id)!.is_default, 0)
    } finally {
      h.cleanup()
    }
  })

  it('duplicate 连 items 一起复制；副本不是默认；delete 默认方案后自动改指另一份', async () => {
    const h = await harness()
    try {
      const a = await h.service.create('c1', 'A', 'serialize')
      await h.service.autoArrange(a.id, 'serialize', true, ARRANGE_DEFAULTS.defaultPauseMs)
      const copy = await h.service.duplicate(a.id, 'A 副本')
      const { items } = await h.service.get(copy.id)
      assert.equal(items.length, 2, 'items 必须一起复制（seg1/seg2 两条）')
      assert.equal(copy.isDefault, false)
      // 副本的 item id 必须与原件不同（否则删一个会连带删另一个）
      const original = await h.service.get(a.id)
      assert.equal(new Set([...items, ...original.items].map((i) => i.id)).size, items.length + original.items.length)

      const b = await h.service.create('c1', 'B', 'serialize')
      await h.service.setDefault(b.id)
      await h.service.remove(b.id)
      const after = await h.service.listArrangements('c1')
      assert.equal(after.filter((x) => x.isDefault).length, 1, '删掉默认方案后必须自动指定新的默认')
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 自动排布
// ---------------------------------------------------------------------------

describe('对轨域 · 自动排布', () => {
  it('按轨道分组、缺录上行不占时间线、总时长与 version 一起更新', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const result = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      // l1（旁白）+ l2（角色）有片段；l3 缺录 → 只有两条 item
      assert.equal(result.items.length, 2)
      const tracks = new Set(result.items.map((i) => i.trackId))
      assert.deepEqual([...tracks].sort(), ['ch1', 'narration'])
      assert.equal(result.items.every((i) => i.segmentId !== ''), true)
      // 每轨都从 0 开始（两条轨道各自独立）
      for (const track of tracks) {
        const first = result.items.filter((i) => i.trackId === track).sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0]!
        assert.equal(first.timelineStartMs, 0)
      }
      const row = h.db.prepare(`SELECT version, total_duration_ms, strategy FROM arrangements WHERE id = ?`).get(arr.id) as {
        version: number
        total_duration_ms: number
        strategy: string
      }
      assert.equal(row.version, 2, '整体重排必须让 version +1（导出 paramsHash 要用）')
      assert.equal(row.total_duration_ms, result.totalDurationMs)
      assert.equal(row.strategy, 'serialize')
    } finally {
      h.cleanup()
    }
  })

  it('preserveLocked=true 保留锁定位置；resetAll 会丢掉锁定并回到自动位置', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const first = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const item = first.items.find((i) => i.lineId === 'l1')!
      // 手工拖到 5 秒并锁定
      await h.service.updateItem(item.id, { timelineStartMs: 5000, locked: true })

      const second = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const keptLocked = second.items.find((i) => i.lineId === 'l1')!
      assert.equal(keptLocked.timelineStartMs, 5000, '锁定的位置必须原样保留')
      assert.equal(keptLocked.locked, true)

      const reset = await h.service.resetAll(arr.id)
      const afterReset = reset.items.find((i) => i.lineId === 'l1')!
      assert.equal(afterReset.timelineStartMs, 0, '「重置全部」= 丢掉人工位置')
      assert.equal(afterReset.locked, false, '「重置全部」= 连锁定一起丢掉')
    } finally {
      h.cleanup()
    }
  })

  it('单轨重置只动那一轨，其它轨的位置不变', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const first = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const charItem = first.items.find((i) => i.trackId === 'ch1')!
      await h.service.updateItem(charItem.id, { timelineStartMs: 900 })
      const narrationItem = first.items.find((i) => i.trackId === 'narration')!
      await h.service.updateItem(narrationItem.id, { timelineStartMs: 1200 })

      const res = await h.service.resetTrack(arr.id, 'ch1')
      const charAfter = res.items.find((i) => i.trackId === 'ch1')!
      const narrationAfter = res.items.find((i) => i.trackId === 'narration')!
      assert.equal(charAfter.timelineStartMs, 0, '被重置的轨道回到自动位置')
      assert.equal(narrationAfter.timelineStartMs, 1200, '其它轨必须原样不动')
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 单条 / 批量改动
// ---------------------------------------------------------------------------

describe('对轨域 · 单条与批量改动', () => {
  it('updateItem 走 shared/arrange/manual 的语义（改起点不改变内容绝对位置）', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const { items } = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const item = items.find((i) => i.lineId === 'l1')!
      const moved = await h.service.updateItem(item.id, { timelineStartMs: 300 })
      assert.equal(moved.timelineStartMs, 300)
      assert.equal(moved.srcInMs, item.srcInMs, '只改时间不该改裁剪点')
    } finally {
      h.cleanup()
    }
  })

  it('batchUpdateItems 有失效 id 就整体拒绝（部分成功会让内存态与库永久不一致）', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const { items } = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      await assert.rejects(
        () =>
          h.service.batchUpdateItems([
            { itemId: items[0]!.id, patch: { timelineStartMs: 111 } },
            { itemId: 'item-ghost', patch: { timelineStartMs: 222 } },
          ]),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
      const after = await h.service.get(arr.id)
      assert.equal(after.items[0]!.timelineStartMs, 0, '整体拒绝时不能有半截改动落库')

      const ok = await h.service.batchUpdateItems(
        items.map((it, index) => ({ itemId: it.id, patch: { timelineStartMs: 100 + index * 10 } })),
      )
      assert.equal(ok.updated, items.length)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 校验与重叠
// ---------------------------------------------------------------------------

describe('对轨域 · 校验', () => {
  it('缺录行 + 文件丢失都能查出来（file_missing 要真查盘）', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const { items } = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      // 「孤儿片段」是靠**时间线条目**发现的：行被删/移走后，条目还指着已经不存在的行。
      // 这里手工造一条（模拟「排好之后把行删了」——这正是 docs/13 §5 要拦的状态）
      h.db.exec(`INSERT INTO arrangement_items (id, arrangement_id, segment_id, line_id, track_id, timeline_start_ms,
                                                src_in_ms, src_out_ms, fade_in_ms, fade_out_ms, locked, order_in_track,
                                                created_at, updated_at)
                 VALUES ('orphan-item', '${arr.id}', 'seg9', 'l9', 'narration', 8000, 0, 2200, 5, 5, 0, 5, 1, 1)`)
      // 人为把两条 item 推到重叠位置，制造 same_track_overlap
      await h.service.updateItem(items.find((i) => i.trackId === 'narration')!.id, { timelineStartMs: 0 })
      const validation = await h.service.validate(arr.id)
      assert.deepEqual(validation.missingLines, ['l3'], 'l3 没有片段 → 缺录')
      assert.ok(validation.issues.some((i) => i.kind === 'missing_line'))
      assert.deepEqual(validation.orphanSegments, ['seg9'], '条目指向的行不在本章了 → 孤儿片段')
      assert.ok(validation.issues.some((i) => i.kind === 'orphan_segment'))
      // seg2 的文件没写到磁盘上 → file_missing
      assert.ok(
        validation.issues.some((i) => i.kind === 'file_missing'),
        `应当检出文件丢失，实际 issues=${validation.issues.map((i) => i.kind).join(',')}`,
      )
      assert.ok(validation.totalDurationMs > 0)
    } finally {
      h.cleanup()
    }
  })

  it('resolveOverlap：serialize 把后一段推到前一段之后，并同步方案总时长', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const { items } = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const a = items.find((i) => i.lineId === 'l1')!
      const b = items.find((i) => i.lineId === 'l2')!
      // 造重叠：两条都放在 0
      await h.service.updateItem(b.id, { timelineStartMs: 0 })
      const res = await h.service.resolveOverlap(arr.id, a.id, b.id, 'serialize')
      const afterA = res.items.find((i) => i.id === a.id)!
      const afterB = res.items.find((i) => i.id === b.id)!
      const endA = afterA.timelineStartMs + (afterA.srcOutMs - afterA.srcInMs)
      assert.ok(afterB.timelineStartMs >= endA, `serialize 后 b 必须在前一段之后（b=${afterB.timelineStartMs}, endA=${endA}）`)
      const row = h.db.prepare(`SELECT total_duration_ms FROM arrangements WHERE id = ?`).get(arr.id) as {
        total_duration_ms: number
      }
      assert.ok(row.total_duration_ms > 0)
    } finally {
      h.cleanup()
    }
  })

  it('resolveOverlap：keep 策略不动位置（有意做对话交叠）', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const { items } = await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const a = items.find((i) => i.lineId === 'l1')!
      const b = items.find((i) => i.lineId === 'l2')!
      await h.service.updateItem(b.id, { timelineStartMs: 0 })
      const res = await h.service.resolveOverlap(arr.id, a.id, b.id, 'keep')
      assert.equal(res.items.find((i) => i.id === b.id)!.timelineStartMs, 0, 'keep 不该移动任何一段')
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 匹配与绑定
// ---------------------------------------------------------------------------

describe('对轨域 · 匹配与绑定', () => {
  it('autoMatchSegments：孤儿片段按时长匹配到缺录行，三者都要返回', async () => {
    const h = await harness()
    try {
      const result = await h.service.autoMatchSegments('c1', false)
      // 孤儿 seg9（1200ms）对缺录行 l3（12 字 ≈ 2400ms）
      assert.equal(result.matches.length, 1)
      assert.equal(result.matches[0]!.segmentId, 'seg9')
      assert.equal(result.matches[0]!.lineId, 'l3')
      assert.ok(result.matches[0]!.confidence > 0 && result.matches[0]!.confidence <= 1)
      assert.deepEqual(result.unmatchedSegments, [])
      assert.deepEqual(result.unrecordedLines, [])
    } finally {
      h.cleanup()
    }
  })

  it('bindSegment：跨章拒绝、目标行已占用报 CONFLICT、成功时清掉过期时间线条目', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      await h.service.autoArrange(arr.id, 'serialize', true, 500)

      // l2 已经有 seg2 → CONFLICT
      await assert.rejects(
        () => h.service.bindSegment('l2', 'seg9'),
        (e: unknown) => e instanceof AppError && e.key === 'CONFLICT',
      )
      // 跨章：seg 属于 c1，l9 属于 c2 → 只要 segment.chapter_id 与行不同就拒绝
      await assert.rejects(
        () => h.service.bindSegment('l9', 'seg2'),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      // 正常绑定：把 seg9 从 l9 改绑到 l3（c1 的缺录行）
      const before = h.db.prepare(`SELECT COUNT(*) AS n FROM arrangement_items WHERE line_id = 'l3'`).get() as {
        n: number
      }
      assert.equal(before.n, 0)
      const res = await h.service.bindSegment('l3', 'seg9')
      assert.equal(res.ok, true)
      const bound = h.db.prepare(`SELECT line_id FROM voice_segments WHERE id = 'seg9'`).get() as { line_id: string }
      assert.equal(bound.line_id, 'l3')
    } finally {
      h.cleanup()
    }
  })

  it('bindSegment 成功后清掉该行的过期时间线条目（否则渲染还会用旧绑定）', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      await h.service.autoArrange(arr.id, 'serialize', true, 500)
      // 先给 l3 造一条过期 item（模拟「之前绑过、后来解绑了」）
      h.db.exec(`INSERT INTO arrangement_items (id, arrangement_id, segment_id, line_id, track_id, timeline_start_ms,
                                                src_in_ms, src_out_ms, fade_in_ms, fade_out_ms, locked, order_in_track,
                                                created_at, updated_at)
                 VALUES ('stale-1', '${arr.id}', 'seg1', 'l3', 'narration', 0, 0, 1000, 5, 5, 0, 9, 1, 1)`)
      await h.service.bindSegment('l3', 'seg9')
      const left = h.db.prepare(`SELECT COUNT(*) AS n FROM arrangement_items WHERE line_id = 'l3'`).get() as { n: number }
      assert.equal(left.n, 0, '绑定变化后旧条目必须被清掉')
    } finally {
      h.cleanup()
    }
  })

  it('unbindSegment：删掉片段行（schema 没有「未绑定」状态），并清掉时间线条目', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const res = await h.service.unbindSegment('l1')
      assert.equal(res.ok, true)
      const seg = h.db.prepare(`SELECT id FROM voice_segments WHERE id = 'seg1'`).get()
      assert.equal(seg, undefined, '解绑 = 删除 voice_segments 行')
      const items = h.db.prepare(`SELECT COUNT(*) AS n FROM arrangement_items WHERE line_id = 'l1'`).get() as { n: number }
      assert.equal(items.n, 0)
      // 文件保留在磁盘上（非破坏）
      assert.ok(existsSync(join(h.root, PROJECT_ID, 'segments/seg1.wav')))
    } finally {
      h.cleanup()
    }
  })

  it('issueKindLabels：11 种问题的中文文案齐全（与渲染侧兜底表同口径）', async () => {
    const h = await harness()
    try {
      const labels = (await call(h, 'alignment:issueKindLabels', undefined)) as Record<string, string>
      assert.equal(Object.keys(labels).length, 11)
      assert.equal(labels['missing_line'], ALIGN_ISSUE_LABELS.missing_line)
      for (const value of Object.values(labels)) assert.ok(value.length > 0)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 预览渲染
// ---------------------------------------------------------------------------

describe('对轨域 · 预览渲染', () => {
  it('previewRender 需要队列；没有队列时明确报「队列不可用」', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const err = await h.service.previewRender(arr.id, null, 0, 10_000).catch((e: unknown) => e)
      assert.ok(err instanceof AppError, `期望明确报错，实际 ${String(err)}`)
      assert.equal(err.key, 'TASK_QUEUE_UNAVAILABLE')
    } finally {
      h.cleanup()
    }
  })

  it('空方案渲染 → MIX_ARRANGEMENT_EMPTY（渲染一段静音比报错更难查）', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      const err = await h.service.previewRender(arr.id, null, 0, 10_000).catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'MIX_ARRANGEMENT_EMPTY')
    } finally {
      h.cleanup()
    }
  })

  it('渲染任务：真跑（假 ffmpeg）→ 输出文件落在 cache/tmp，命令含 adelay/amix/atrim', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      await h.service.autoArrange(arr.id, 'serialize', true, 500)
      const result = await h.render.runNow(
        { arrangementId: arr.id, startMs: 500, durationMs: 8000 },
        fakeCtx(join(h.root, 'tmp')),
      )
      assert.match(result.path, /^cache\/tmp\/preview-arr-\d+-500-8000\.wav$/)
      assert.ok(existsSync(join(h.root, PROJECT_ID, result.path)), '预览文件必须真的写出来')
      assert.equal(result.itemCount, 2)
      const command = h.runner.calls[0]!
      const graph = command[command.indexOf('-filter_complex') + 1]!
      assert.ok(graph.includes('amix=inputs=2:normalize=0'), '两个输入要相加（不按输入个数衰减）')
      assert.ok(graph.includes('normalize=0'), 'amix 不能按输入个数自动衰减（否则预览比导出小一截）')
      assert.ok(graph.includes('atrim=start=0.5'), '预览窗口要在时间线坐标上裁')
      assert.ok(graph.includes('afade='), '淡化要按 item 的 fadeIn/fadeOut')
      assert.equal(command[command.indexOf('-map') + 1], '[out]')
    } finally {
      h.cleanup()
    }
  })

  it('渲染任务：ffmpeg 非 0 退出 → EXPORT_FFMPEG_FAILED 带完整命令', async () => {
    const h = await harness()
    try {
      const arr = await h.service.create('c1', 'A', 'serialize')
      await h.service.autoArrange(arr.id, 'serialize', true, 500)
      h.runner.failNext = true
      const err = await h.render
        .runNow({ arrangementId: arr.id, startMs: 0, durationMs: 5000 }, fakeCtx(join(h.root, 'tmp')))
        .catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'EXPORT_FFMPEG_FAILED')
      assert.ok(String(err.details?.command ?? '').includes('ffmpeg'))
    } finally {
      h.cleanup()
    }
  })

  it('forcedAlign：明确报能力不可用（不返回必然失败的任务）', async () => {
    const h = await harness()
    try {
      const err = await call(h, 'alignment:forcedAlign', { lineId: 'l1' }).catch((e: unknown) => e)
      assert.ok(err instanceof AppError)
      assert.equal(err.key, 'AI_FORCED_ALIGN_UNAVAILABLE')
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 纯逻辑：渲染命令
// ---------------------------------------------------------------------------

describe('对轨域 · 渲染命令（纯逻辑）', () => {
  const items = [
    { path: 'a.wav', trackId: 'narration', timelineStartMs: 0, srcInMs: 0, srcOutMs: 2000, fadeInMs: 5, fadeOutMs: 5 },
    { path: 'b.wav', trackId: 'ch1', timelineStartMs: 1500, srcInMs: 100, srcOutMs: 1400, fadeInMs: 0, fadeOutMs: 0 },
  ]

  it('每个片段一条链 + amix + 窗口 atrim', () => {
    const { graph, usedInputs } = buildArrangementFilterGraph({ items, output: 'out.wav', startMs: 0, durationMs: 5000 })
    assert.deepEqual(usedInputs, [0, 1])
    assert.ok(graph.includes('[0:a]atrim=start=0:end=2'))
    assert.ok(graph.includes('[1:a]atrim=start=0.1:end=1.4'))
    assert.ok(graph.includes('adelay=1500:all=1'))
    assert.ok(graph.includes('amix=inputs=2:normalize=0'))
    assert.ok(graph.endsWith('[mixed]atrim=start=0:end=5,asetpts=PTS-STARTPTS[out]'))
  })

  it('零长度片段被跳过（不会生成空滤镜段），全零则返回空', () => {
    const withZero = buildArrangementFilterGraph({
      items: [items[0]!, { ...items[1]!, srcOutMs: 100 }],
      output: 'o.wav',
      startMs: 0,
      durationMs: 1000,
    })
    assert.deepEqual(withZero.usedInputs, [0])
    const none = buildArrangementFilterGraph({
      items: [{ ...items[0]!, srcOutMs: 0 }],
      output: 'o.wav',
      startMs: 0,
      durationMs: 1000,
    })
    assert.equal(none.graph, '')
    assert.deepEqual(buildArrangementRenderCommand({ items: [], output: 'o.wav', startMs: 0, durationMs: 1000 }), [])
  })

  it('预览窗口被夹到 [默认值, 上限]；命令带 -t 双保险', () => {
    assert.equal(clampPreviewDuration(0), PREVIEW_RENDER_DEFAULT_MS)
    assert.equal(clampPreviewDuration(Number.NaN), PREVIEW_RENDER_DEFAULT_MS)
    assert.equal(clampPreviewDuration(10 * 60 * 1000), PREVIEW_RENDER_MAX_MS)
    const cmd = buildArrangementRenderCommand({ items, output: 'o.wav', startMs: 0, durationMs: 8000 })
    assert.equal(cmd[cmd.indexOf('-t') + 1], '8')
    assert.deepEqual(cmd.slice(cmd.indexOf('-c:a'), cmd.indexOf('-c:a') + 2), ['-c:a', 'pcm_s24le'])
  })

  it('通道清单与契约 schema 一一对应', () => {
    assert.equal(ALIGNMENT_CHANNELS.length, 19)
    for (const channel of ALIGNMENT_CHANNELS) {
      assert.ok(schemaFor(channel), `契约里没有 ${channel} 的 schema`)
    }
  })
})
