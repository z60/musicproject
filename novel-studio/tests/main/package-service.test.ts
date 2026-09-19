/**
 * 测试 · 项目包 / 任务包域（`package:*` 7 个通道的真实实现）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §8 §9（.nsp / .nst 格式与导入、合并规则）
 *   · docs/11 §6.2–§6.5（导出选项、linesHash、回收归位与报告、增量下发）
 *   · docs/20 §4（`package:*` 通道契约）、docs/21 §6（`packages` 表）
 *
 * ### 测试台
 *   真 SQLite（`node:sqlite` + `migrate(loadMigrations())`）+ 真文件系统（临时目录），
 *   与 `tests/main/export-tasks.test.ts` 同一套做法。**没有假仓储、没有假 zip**：
 *   导出真的写出 `.nsp` / `.nst` 文件（含 `VACUUM INTO` 的数据库快照），
 *   合并真的把 WAV 写到 `takes/` 并入库、真的生成成品片段。
 *
 * ### 覆盖什么
 *   导出项目包（内容清单 / 数据库快照 / 历史行）、导出任务包（作用域、上下文、
 *   参考音、增量下发）、`inspect`（含摘要与错误路径）、导入（解包 + id_map + 项目登记）、
 *   回收合并（归位、未知行、损坏音频、缺校验和、重复去重、重录追加、画本变更、成品采纳）、
 *   历史列表、上次合并报告，以及**队列未注入**与各类非法参数。
 *
 * ### **不覆盖**什么（如实列出，见 docs/91 的未验证项）
 *   · `.nsp` 导入的**业务数据合并**：本轮没有实现；测试只断言「确实没合并」这条边界
 *     （`businessDataMerged=false` + 明确 warning + 新项目下 0 本书）；
 *   · archiver 与 store 两种 ZIP 写入器的字节差异（两者产出同一种合法 ZIP，
 *     断言的是「能被 openZip 读回、checksums 能校验通过」这一共同行为）；
 *   · > 4 GiB 的包（只有 ZIP64 守卫逻辑，没有真造一个 4 GiB 的文件）；
 *   · 合并**中途**失败留下的 `status='failed'` 历史行（需要构造一个「写到一半失败」的
 *     文件系统故障；本轮只在解析阶段前失败，那时还没有历史行）。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { isAppError } from '../../src/shared/errors.ts'
import type { NstManifest } from '../../src/shared/types.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { TaskContext } from '../../src/main/infra/queue/types.ts'
import {
  createPackageTasks,
  type PackageExportProjectResult,
  type PackageExportTaskResult,
  type PackageTasks,
} from '../../src/main/features/book/package/package.tasks.ts'
import { createPackageService, type PackageService } from '../../src/main/features/book/package/package.service.ts'
import { createSqlitePackageRepo } from '../../src/main/features/book/package/repositories/package.repo.sqlite.ts'
import type { PackageRepo } from '../../src/main/features/book/package/repositories/package.repo.ts'
import { createSilentWav } from '../../src/main/features/book/package/wav.ts'
import { sha256Hex, formatChecksumsFile, verifyPackageFromText } from '../../src/main/features/book/package/checksums.ts'
import {
  CHECKSUMS_FILE,
  ID_MAP_FILE,
  MANIFEST_FILE,
  TAKES_FILE,
  TASK_FILE,
} from '../../src/main/features/book/package/manifest.ts'
import { parseTaskPackage } from '../../src/main/features/book/package/nst.ts'
import { openZip } from '../../src/main/features/book/package/zip/reader.ts'
import { createStoreZipWriter } from '../../src/main/features/book/package/zip/writer.ts'

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const PROJECT_ID = 'p1'
const BOOK_ID = 'b1'
const ACTOR_ID = 'actor1'
const OTHER_ACTOR_ID = 'actor2'
const CHAR_XY = 'char-xy'
const CHAR_YL = 'char-yl'

/** 48k/24bit/单声道：与任务包的默认录音建议一致，避免不必要的合规提示 */
const wav = (ms: number): Buffer => createSilentWav({ sampleRate: 48000, bitDepth: 24, durationMs: ms })

interface Harness {
  root: string
  projectRoot: string
  exportDir: string
  db: DatabaseSync
  dbLike: DbLike
  repo: PackageRepo
  tasks: PackageTasks
  service: PackageService
  /** 一个可用的任务上下文（tempDir 已建好） */
  ctx(taskId?: string): TaskContext
  cleanup(): void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-package-service-'))
  const projectRoot = join(root, 'projects')
  const exportDir = join(root, 'exports')
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike
  const rootDir = projectRoot.replace(/\\/g, '/')

  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', '斗破苍穹', '${rootDir}/${PROJECT_ID}', 5, 1, 1)`)
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p2', '别的项目', '${rootDir}/p2', 5, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('${BOOK_ID}', '${PROJECT_ID}', '斗破苍穹', '旁白', 'zh-CN', 'txt', 'h1', 100, 2, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', '${BOOK_ID}', 1, '第一章 陨落的天才', 'chapter', '正文', 10, 0, 10, 'generated', 2, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c2', '${BOOK_ID}', 2, '第二章 药老', 'chapter', '正文', 10, 10, 20, 'generated', 2, 1, 1)`)

  db.exec(`INSERT INTO characters (id, book_id, name, description, default_speed, default_emotion, is_archived, sort_order, created_at, updated_at)
           VALUES ('${CHAR_XY}', '${BOOK_ID}', '萧炎', '少年，语气倔强', 'normal', '平静', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO characters (id, book_id, name, description, is_archived, sort_order, created_at, updated_at)
           VALUES ('${CHAR_YL}', '${BOOK_ID}', '药老', '苍老而威严', 0, 2, 1, 1)`)
  db.exec(`INSERT INTO voice_actors (id, project_id, name, note, created_at, updated_at)
           VALUES ('${ACTOR_ID}', '${PROJECT_ID}', '小林', '录音环境：安静卧室', 1, 1)`)
  db.exec(`INSERT INTO voice_actors (id, project_id, name, created_at, updated_at)
           VALUES ('${OTHER_ACTOR_ID}', '${PROJECT_ID}', '未分配角色的人', 1, 1)`)
  db.exec(`INSERT INTO voice_actors (id, project_id, name, created_at, updated_at)
           VALUES ('actor-elsewhere', 'p2', '别的项目的配音员', 1, 1)`)
  db.exec(`INSERT INTO character_voice_bindings (id, character_id, actor_id, is_primary, created_at)
           VALUES ('cvb1', '${CHAR_XY}', '${ACTOR_ID}', 1, 1)`)

  // 画本行：l1 旁白 / l2 萧炎 / l3 萧炎 / l4 药老
  const lines: Array<{
    id: string
    chapterId: string
    seq: number
    speaker: 'narration' | 'character'
    characterId: string | null
    text: string
    emotion: string | null
    pronunciation: string | null
    note: string | null
  }> = [
    { id: 'l1', chapterId: 'c1', seq: 1, speaker: 'narration', characterId: null, text: '他缓缓抬起头。', emotion: null, pronunciation: null, note: null },
    { id: 'l2', chapterId: 'c1', seq: 2, speaker: 'character', characterId: CHAR_XY, text: '我萧炎，从来不会认输。', emotion: '愤怒', pronunciation: '行(háng)', note: '这里是情绪爆发点，不要喊破音' },
    { id: 'l3', chapterId: 'c2', seq: 1, speaker: 'character', characterId: CHAR_XY, text: '我要变强。', emotion: '坚定', pronunciation: '强(qiáng)', note: '要有决心' },
    { id: 'l4', chapterId: 'c2', seq: 2, speaker: 'character', characterId: CHAR_YL, text: '小子，别冲动。', emotion: '焦急', pronunciation: null, note: null },
  ]
  for (const line of lines) {
    db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, speaker_type, character_id, kind, text,
                                      char_start, char_end, emotion, pause_after_ms, pronunciation, note,
                                      state, needs_review, flags, is_title, rev, created_at, updated_at)
             VALUES ('${line.id}', '${line.chapterId}', '${BOOK_ID}', ${line.seq}, '${line.speaker}',
                     ${line.characterId ? `'${line.characterId}'` : 'NULL'},
                     '${line.speaker === 'narration' ? 'narration' : 'dialogue'}', '${line.text}', 0, ${line.text.length},
                     ${line.emotion ? `'${line.emotion}'` : 'NULL'}, 500,
                     ${line.pronunciation ? `'${line.pronunciation}'` : 'NULL'},
                     ${line.note ? `'${line.note}'` : 'NULL'},
                     'assigned', 0, '[]', 0, 1, 1, 1)`)
  }

  // 项目目录：音频文件（导出要真读盘）
  const audioRoot = join(projectRoot, PROJECT_ID)
  for (const dir of ['segments', 'recordings', 'music']) mkdirSync(join(audioRoot, dir), { recursive: true })
  writeFileSync(join(audioRoot, 'recordings', 'sess-1.wav'), wav(50))
  writeFileSync(join(audioRoot, 'music', 'bgm.mp3'), Buffer.from('not-really-mp3'))
  // 成品片段：l1 / l4（l2、l3 刻意**没有**成品片段，用来验证「回传后设为成品」）
  writeFileSync(join(audioRoot, 'segments', 'seg-l1.wav'), wav(120))
  writeFileSync(join(audioRoot, 'segments', 'seg-l4.wav'), wav(140))
  db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, flags, created_at, updated_at)
           VALUES ('seg-l1', 'l1', 'c1', 'segments/seg-l1.wav', 0, 120, 120, '[]', 1, 1)`)
  db.exec(`INSERT INTO voice_segments (id, line_id, chapter_id, file_path, src_in_ms, src_out_ms, duration_ms, flags, created_at, updated_at)
           VALUES ('seg-l4', 'l4', 'c2', 'segments/seg-l4.wav', 0, 140, 140, '[]', 1, 1)`)

  const repo = createSqlitePackageRepo(dbLike)
  const log = { info: () => {}, warn: () => {} }
  /**
   * 时钟**必须单调递增**：`packages` 的「最近一条」是靠 `created_at DESC, id DESC` 排的，
   * 固定时间戳会让同一个测试里的多次导出撞在一起，增量下发的「上一次包」就变成随机的那一个。
   */
  let clock = 1_700_000_000_000
  const tasks = createPackageTasks({
    getDb: () => dbLike,
    projectRoot: () => projectRoot,
    exportDir: () => exportDir,
    app: () => ({ name: 'Novel Studio', version: '0.0.0-test' }),
    repo: () => repo,
    log,
    now: () => clock++,
  })
  const service = createPackageService({
    getDb: () => dbLike,
    repo: () => repo,
    tasks,
    actorName: (actorId) => {
      const row = dbLike.prepare(`SELECT name FROM voice_actors WHERE id = ?`).get(actorId) as
        | { name: string }
        | undefined
      return row?.name ?? null
    },
    log,
  })

  const tempDir = join(root, 'task-tmp')
  mkdirSync(tempDir, { recursive: true })

  return {
    root,
    projectRoot,
    exportDir,
    db,
    dbLike,
    repo,
    tasks,
    service,
    ctx: (taskId = 'task-test-1') => {
      const controller = new AbortController()
      return {
        taskId,
        kind: 'package.export',
        projectId: PROJECT_ID,
        attempt: 1,
        signal: controller.signal,
        tempDir,
        report() {},
        throwIfAborted() {},
        isAborted: () => false,
        log() {},
      } as unknown as TaskContext
    },
    cleanup: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function entriesOf(path: string): string[] {
  const reader = openZip(readFileSync(path))
  try {
    return reader.listEntries().map((e) => e.name)
  } finally {
    reader.close()
  }
}

/** 读一个 .nst：解析 manifest 并真校验 checksums */
function readNst(path: string): { manifest: NstManifest; entries: string[]; checksumsOk: boolean } {
  const reader = openZip(readFileSync(path))
  try {
    const parsed = parseTaskPackage(reader)
    const verify = verifyPackageFromText(reader, reader.readText(CHECKSUMS_FILE))
    return {
      manifest: parsed.manifest,
      entries: reader.listEntries().map((e) => e.name),
      checksumsOk: verify.mismatch.length === 0 && verify.missing.length === 0 && verify.unreadable.length === 0,
    }
  } finally {
    reader.close()
  }
}

interface ReturnedSlot {
  lineId: string
  takeId: string
  bytes: Buffer
}

/**
 * 造一个「配音员录完回传」的 .nst：沿用下发时的 manifest，把音频填进 `slots/`。
 * 这正是 docs/03 §9 描述的回传包变体（额外带一个 `takes.json` 与完整的 checksums）。
 */
async function writeReturnedPackage(
  target: string,
  manifest: NstManifest,
  slots: readonly ReturnedSlot[],
): Promise<void> {
  const entries: Record<string, Buffer> = {}
  const manifestJson = JSON.stringify(manifest, null, 2)
  const takesJson = JSON.stringify(
    {
      takes: slots.map((s) => ({
        lineId: s.lineId,
        takeId: s.takeId,
        fileName: `${s.takeId}.wav`,
        durationMs: 300,
        peakDb: -6,
        recordedAt: 1_700_000_000_000,
        device: 'USB Mic',
      })),
    },
    null,
    2,
  )
  entries[MANIFEST_FILE] = Buffer.from(manifestJson, 'utf8')
  entries[TASK_FILE] = Buffer.from(manifestJson, 'utf8')
  entries[TAKES_FILE] = Buffer.from(takesJson, 'utf8')
  const checksums = [
    { path: MANIFEST_FILE, hash: sha256Hex(manifestJson) },
    { path: TASK_FILE, hash: sha256Hex(manifestJson) },
    { path: TAKES_FILE, hash: sha256Hex(takesJson) },
  ]
  for (const slot of slots) {
    const path = `slots/${slot.lineId}/${slot.takeId}.wav`
    entries[path] = slot.bytes
    checksums.push({ path, hash: sha256Hex(slot.bytes) })
  }
  entries[CHECKSUMS_FILE] = Buffer.from(formatChecksumsFile(checksums), 'utf8')
  await writeRawEntries(target, entries)
}

/** 造一个「只有指定条目」的包（用于构造损坏 / 缺字段 / 版本过新的异常包） */
async function writeRawEntries(target: string, entries: Record<string, Buffer | string>): Promise<void> {
  const zip = createStoreZipWriter()
  for (const [name, value] of Object.entries(entries)) {
    await zip.addFile(name, Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'), { store: true })
  }
  await zip.finalize()
  writeFileSync(target, zip.toBuffer())
}

function countRows(h: Harness, sql: string, ...params: unknown[]): number {
  const row = h.dbLike.prepare(sql).get(...params) as { n: number }
  return row.n
}

/** 导出一个 .nsp（返回类型收窄，避免测试里到处写联合类型断言） */
async function exportProject(
  h: Harness,
  options: Record<string, unknown>,
  taskId = 't-nsp',
): Promise<PackageExportProjectResult> {
  const result = await h.tasks.runNowExport({ op: 'project', projectId: PROJECT_ID, options }, h.ctx(taskId))
  assert.equal(result.kind, 'nsp')
  return result as PackageExportProjectResult
}

/** 导出一个 .nst（同上） */
async function exportTask(
  h: Harness,
  options: Record<string, unknown>,
  taskId = 't-nst',
): Promise<PackageExportTaskResult> {
  const result = await h.tasks.runNowExport({ op: 'task', bookId: BOOK_ID, actorId: ACTOR_ID, options }, h.ctx(taskId))
  assert.equal(result.kind, 'nst')
  return result as PackageExportTaskResult
}

/** 导出一个 .nst 并返回它的 manifest（后续「回传 → 合并」都用它） */
async function exportAndReadManifest(h: Harness, taskId: string): Promise<NstManifest> {
  const exported = await exportTask(h, {}, taskId)
  return readNst(exported.filePath).manifest
}

// ---------------------------------------------------------------------------
// ① 导出项目包（.nsp）
// ---------------------------------------------------------------------------

describe('package:exportProject · .nsp 导出', () => {
  it('写出真实 .nsp：数据库快照 + 内容清单生效 + 历史行落库', async () => {
    const h = await harness()
    try {
      const result = await exportProject(h, { contents: 'standard' })
      assert.equal(result.kind, 'nsp')
      assert.ok(result.packageId.startsWith('nsp_'))
      assert.ok(existsSync(result.filePath), '包必须真的在盘上')
      assert.ok(result.bytes > 0, '包不能是 0 字节')
      assert.ok(result.filePath.startsWith(h.exportDir), `默认应落在导出目录，实际 ${result.filePath}`)

      const entries = entriesOf(result.filePath)
      assert.ok(entries.includes(MANIFEST_FILE))
      assert.ok(entries.includes('project.json'))
      assert.ok(entries.includes('database.sqlite'), 'standard 预设带业务库快照')
      assert.ok(entries.includes(CHECKSUMS_FILE))
      assert.ok(entries.includes('audio/segments/seg-l1.wav'), '成品片段必须进包')
      assert.ok(entries.includes('audio/segments/seg-l4.wav'))
      assert.ok(!entries.some((e) => e.startsWith('audio/recordings/')), 'standard 不含原始录音（docs/03 §8）')

      // 快照必须是真的 SQLite 文件（VACUUM INTO 的产物），不是随便一段字节
      const reader = openZip(readFileSync(result.filePath))
      const snapshot = reader.readEntry('database.sqlite')
      const manifest = JSON.parse(reader.readText(MANIFEST_FILE)) as {
        project: { name: string }
        counts: { chapters: number; lines: number; segments: number }
        contents: { database: boolean; recordings: boolean }
        schemaVersion: number
      }
      reader.close()
      assert.equal(snapshot.subarray(0, 15).toString('utf8'), 'SQLite format 3')
      assert.equal(manifest.project.name, '斗破苍穹')
      assert.deepEqual(manifest.counts, { chapters: 2, lines: 4, segments: 2 })
      assert.equal(manifest.contents.database, true)
      assert.equal(manifest.contents.recordings, false)
      assert.ok(manifest.schemaVersion >= 1)

      // 历史行（docs/11 §6.2 第 5 步：导出必须留痕）
      const history = await h.service.listHistory(PROJECT_ID)
      assert.equal(history.length, 1)
      assert.equal(history[0].direction, 'export')
      assert.equal(history[0].kind, 'nsp')
      assert.equal(history[0].filePath, result.filePath)
      assert.equal(history[0].stats?.chapters, 2)
      assert.equal(history[0].stats?.bytes, result.bytes)
    } finally {
      h.cleanup()
    }
  })

  it('full 预设带上原始录音与素材；关掉的类别列在 skipped 里；未知选项被报告', async () => {
    const h = await harness()
    try {
      const full = await exportProject(h, { contents: 'full' }, 't-full')
      const fullEntries = entriesOf(full.filePath)
      assert.ok(fullEntries.includes('audio/recordings/sess-1.wav'))
      assert.ok(fullEntries.includes('audio/music/bgm.mp3'))
      assert.deepEqual(full.skipped, [], 'full 预设不该跳过大项')

      const slim = await exportProject(h, { contents: 'slim' }, 't-slim')
      const slimEntries = entriesOf(slim.filePath)
      assert.ok(!slimEntries.includes('audio/music/bgm.mp3'), 'slim 不含素材')
      assert.ok(slimEntries.includes('audio/segments/seg-l1.wav'), 'slim 仍带成品片段')
      assert.ok(
        slim.skipped.some((s) => s.includes('music')),
        `关掉的类别必须列出来（否则用户以为导全了）：${JSON.stringify(slim.skipped)}`,
      )
      // 同名包不覆盖：第二次默认路径会加序号（历史行指向的包不能被悄悄换掉）
      assert.notEqual(slim.filePath, full.filePath)
      assert.ok(slim.warnings.some((w) => w.includes('同名包')), JSON.stringify(slim.warnings))

      const odd = await exportProject(h, { contents: 'slim', nonSense: true }, 't-odd')
      assert.ok(odd.warnings.some((w) => w.includes('nonSense')))
    } finally {
      h.cleanup()
    }
  })

  it('导出选项非法 / 项目不存在时明确报错（服务层在入队前就拦住）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.tasks.runNowExport({ op: 'project', projectId: PROJECT_ID, options: { contents: '巨大' } }, h.ctx()),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () =>
          h.tasks.runNowExport(
            { op: 'project', projectId: PROJECT_ID, options: { contents: { database: 'yes' } } },
            h.ctx(),
          ),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
      // 拼错的 key（`recording` 少了 s）必须报错而不是静默按默认值导：
      // 否则用户以为带上了原始录音，换机恢复时才发现没带
      await assert.rejects(
        () =>
          h.tasks.runNowExport(
            { op: 'project', projectId: PROJECT_ID, options: { contents: { recording: true } } },
            h.ctx(),
          ),
        (e: unknown) => {
          assert.ok(isAppError(e))
          assert.equal(e.key, 'INVALID_PAYLOAD')
          assert.deepEqual(e.details?.unknown, ['recording'])
          return true
        },
      )
      await assert.rejects(
        () => h.tasks.runNowExport({ op: 'project', projectId: 'ghost', options: {} }, h.ctx()),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.exportProject('ghost', {}),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.exportProject(PROJECT_ID, { contents: 'nope' }),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// ② 导出任务包（.nst）
// ---------------------------------------------------------------------------

describe('package:exportTask · .nst 导出', () => {
  it('作用域 = 配音员绑定的角色；上下文/情绪/发音/备注带出；历史行记 actorId 与 linesHash', async () => {
    const h = await harness()
    try {
      const result = await exportTask(h, {})
      assert.equal(result.kind, 'nst')
      assert.equal(result.lines, 2, '只含萧炎的两行（药老没有绑定给小林）')
      assert.equal(result.characters, 1)
      assert.ok(result.filePath.endsWith('.nst'))
      assert.ok(existsSync(result.filePath))

      const pkg = readNst(result.filePath)
      assert.equal(pkg.checksumsOk, true, 'checksums.sha256 必须真能校验通过')
      assert.ok(pkg.entries.includes(TASK_FILE), 'task.json 是配音端唯一必读文件')
      assert.deepEqual(
        pkg.manifest.lines.map((l) => l.id),
        ['l2', 'l3'],
      )
      // 上下文按 docs/03 §9 的口径渲染成「（说话人）文本」
      assert.equal(pkg.manifest.lines[0].prevLine, null)
      assert.equal(pkg.manifest.lines[0].nextLine, '（萧炎）我要变强。')
      assert.equal(pkg.manifest.lines[0].emotion, '愤怒')
      assert.equal(pkg.manifest.lines[0].pronunciation, '行(háng)')
      assert.equal(pkg.manifest.lines[0].note, '这里是情绪爆发点，不要喊破音')
      assert.equal(pkg.manifest.lines[1].emotion, '坚定')
      assert.equal(pkg.manifest.lines[0].characterName, '萧炎')
      assert.equal(pkg.manifest.assignee.name, '小林')
      assert.equal(pkg.manifest.recordSettings.sampleRate, 48000)

      // slots/ 是空目录（导出态），回传时才被填充
      const reader = openZip(readFileSync(result.filePath))
      const withDirs = reader.listEntries({ includeDirectories: true }).map((e) => e.name)
      reader.close()
      assert.ok(withDirs.includes('slots/'), '导出包要留一个空 slots/ 目录')

      const history = await h.service.listHistory(PROJECT_ID)
      assert.equal(history.length, 1)
      assert.equal(history[0].actorId, ACTOR_ID)
      assert.equal(history[0].actorName, '小林', 'actorName 由服务层从 voice_actors 补上')
      assert.equal(history[0].linesHash, result.linesHash)
      assert.equal(history[0].stats?.lines, 2)
      assert.equal(history[0].stats?.characters, 1)
    } finally {
      h.cleanup()
    }
  })

  it('选项：关掉上下文/备注/发音提示；允许看其它角色；显式指定角色；类型不对则报错', async () => {
    const h = await harness()
    try {
      const bare = await exportTask(
        h,
        { includeContext: false, includeNotes: false, includePronunciation: false },
      )
      for (const line of readNst(bare.filePath).manifest.lines) {
        assert.equal(line.prevLine, null)
        assert.equal(line.nextLine, null)
        assert.equal(line.note, null)
        assert.equal(line.pronunciation, null)
        assert.ok(line.text.length > 0, '文本永远保留')
      }

      const all = await exportTask(h, { allowOtherCharacterLines: true }, 't-all')
      assert.equal(all.lines, 4, '允许看其它角色的词时下发全书的行（含旁白）')
      assert.equal(all.characters, 2)

      const onlyYao = await exportTask(h, { characterIds: [CHAR_YL] }, 't-yl')
      assert.equal(onlyYao.lines, 1, '显式指定角色时以它为准（哪怕没绑定给这个配音员）')
      const yaoPkg = readNst(onlyYao.filePath)
      assert.equal(yaoPkg.manifest.lines[0].id, 'l4')
      assert.equal(yaoPkg.manifest.lines[0].characterName, '药老')

      await assert.rejects(
        () =>
          h.tasks.runNowExport(
            { op: 'task', bookId: BOOK_ID, actorId: ACTOR_ID, options: { includeContext: 'yes' } },
            h.ctx(),
          ),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () =>
          h.tasks.runNowExport(
            { op: 'task', bookId: BOOK_ID, actorId: ACTOR_ID, options: { recordSettings: { sampleRate: '48k' } } },
            h.ctx(),
          ),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () =>
          h.tasks.runNowExport(
            { op: 'task', bookId: BOOK_ID, actorId: ACTOR_ID, options: { chapterIds: ['ghost-chapter'] } },
            h.ctx(),
          ),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })

  it('参考音：对手戏行的成品片段进 reference/，并标 hasReference；没有对手戏时如实警告', async () => {
    const h = await harness()
    try {
      const result = await exportTask(
        h,
        { allowOtherCharacterLines: true, includeReference: true },
      )
      const pkg = readNst(result.filePath)
      const refs = pkg.entries.filter((e) => e.startsWith('reference/'))
      assert.ok(refs.length > 0, `对手戏有成品片段时应产出参考音，实际条目：${JSON.stringify(pkg.entries)}`)
      assert.equal(result.referenceFiles, refs.length)
      const flagged = pkg.manifest.lines.filter((l) => l.hasReference).map((l) => l.id)
      // l2 的上一行是旁白 l1（有片段），l3 的下一行是药老 l4（有片段）
      assert.ok(flagged.includes('l3'), `带参考音的行必须 hasReference=true，实际：${JSON.stringify(flagged)}`)

      // 默认作用域（只有萧炎的行）里不存在对手戏 → 不能假装有参考音
      const noRef = await exportTask(h, { includeReference: true }, 't-noref')
      assert.equal(noRef.referenceFiles, 0)
      assert.ok(
        noRef.warnings.some((w) => w.includes('参考音') && w.includes('对手戏')),
        JSON.stringify(noRef.warnings),
      )
    } finally {
      h.cleanup()
    }
  })

  it('增量下发（onlyChangedLines）：只含变更行，但 linesHash 仍是完整作用域', async () => {
    const h = await harness()
    try {
      const first = await exportTask(h, {})
      assert.equal(first.lines, 2)

      h.dbLike.prepare(`UPDATE canvas_lines SET text = ? WHERE id = ?`).run('我必须变强。', 'l3')

      const incremental = await exportTask(h, { onlyChangedLines: true }, 't-inc')
      assert.equal(incremental.lines, 1, '增量包只含改过的那一行')
      const incPkg = readNst(incremental.filePath)
      assert.deepEqual(
        incPkg.manifest.lines.map((l) => l.id),
        ['l3'],
      )
      assert.equal(incPkg.manifest.characters.length, 1, '角色表仍是完整作用域（回收要靠它对齐范围）')

      // 哈希必须与「同一份画本的全量导出」一致：否则回收时必然误报「画本已变更」
      const full = await exportTask(h, {}, 't-full')
      assert.equal(incremental.linesHash, full.linesHash)
      assert.notEqual(incremental.linesHash, first.linesHash, '画本变了，哈希必须变')

      // 没有任何变化时明确报 CONFLICT，而不是产出一个空包
      await assert.rejects(
        () =>
          h.tasks.runNowExport(
            { op: 'task', bookId: BOOK_ID, actorId: ACTOR_ID, options: { onlyChangedLines: true } },
            h.ctx('t-inc2'),
          ),
        (e: unknown) => isAppError(e) && e.key === 'CONFLICT',
      )
    } finally {
      h.cleanup()
    }
  })

  it('跨字段校验：书/配音员不存在、配音员属于别的项目、没有绑定角色', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.service.exportTask('ghost-book', ACTOR_ID, {}),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.exportTask(BOOK_ID, 'ghost-actor', {}),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.exportTask(BOOK_ID, 'actor-elsewhere', {}),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
      // 任务层同样的判定（任务可能被重试或直接调度，不能只靠服务层把关）
      await assert.rejects(
        () => h.tasks.runNowExport({ op: 'task', bookId: BOOK_ID, actorId: 'actor-elsewhere', options: {} }, h.ctx()),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.service.exportTask(BOOK_ID, OTHER_ACTOR_ID, {}),
        (e: unknown) => {
          assert.ok(isAppError(e))
          assert.equal(e.key, 'INVALID_PAYLOAD')
          assert.equal(e.details?.reason, 'actor-has-no-bound-character')
          return true
        },
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// ③ inspect
// ---------------------------------------------------------------------------

describe('package:inspect · 读包摘要', () => {
  it('nsp / nst / 回传包都能读出 kind、formatVersion 与摘要', async () => {
    const h = await harness()
    try {
      const nsp = await exportProject(h, { contents: 'standard' })
      const nspInfo = await h.service.inspect(nsp.filePath)
      assert.equal(nspInfo.kind, 'nsp')
      assert.equal(nspInfo.formatVersion, 1)
      assert.ok(nspInfo.summary.includes('项目包'))
      assert.ok(nspInfo.summary.includes('斗破苍穹'))
      assert.ok(nspInfo.summary.includes('校验和文件：有'))
      assert.ok(nspInfo.summary.includes('标准'), `内容清单预设应被识别：${nspInfo.summary}`)

      const nst = await exportTask(h, {})
      const nstInfo = await h.service.inspect(nst.filePath)
      assert.equal(nstInfo.kind, 'nst')
      assert.equal(nstInfo.formatVersion, 1)
      assert.ok(nstInfo.summary.includes('小林'))
      assert.ok(nstInfo.summary.includes('尚无可回收的音频'), '下发态要能一眼看出来')

      const manifest = readNst(nst.filePath).manifest
      const returnedPath = join(h.root, 'returned.nst')
      await writeReturnedPackage(returnedPath, manifest, [{ lineId: 'l2', takeId: 't1', bytes: wav(300) }])
      const returnedInfo = await h.service.inspect(returnedPath)
      assert.equal(returnedInfo.kind, 'nst')
      assert.ok(returnedInfo.summary.includes('已回传 1 个音频槽位'), returnedInfo.summary)
    } finally {
      h.cleanup()
    }
  })

  it('错误路径：文件不存在 / 不是包 / 版本过新 / 缺少 manifest', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.service.inspect(join(h.root, '没有这个文件.nsp')),
        (e: unknown) => isAppError(e) && e.key === 'FILE_NOT_FOUND',
      )

      const notZip = join(h.root, 'not-a-package.nsp')
      writeFileSync(notZip, Buffer.from('这不是 zip，只是一段文本', 'utf8'))
      await assert.rejects(
        () => h.service.inspect(notZip),
        (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
      )

      const tooNew = join(h.root, 'too-new.nsp')
      await writeRawEntries(tooNew, { [TASK_FILE]: JSON.stringify({ format: 'nsp', formatVersion: 99 }) })
      await assert.rejects(
        () => h.service.inspect(tooNew),
        (e: unknown) => {
          assert.ok(isAppError(e))
          assert.equal(e.key, 'PACKAGE_VERSION_TOO_NEW')
          assert.equal(e.params.version, '99', 'UI 要靠这个参数渲染「请升级应用」')
          return true
        },
      )

      const noManifest = join(h.root, 'empty.nsp')
      await writeRawEntries(noManifest, { 'other.txt': 'x' })
      await assert.rejects(
        () => h.service.inspect(noManifest),
        (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// ④ 导入项目包（.nsp）
// ---------------------------------------------------------------------------

describe('package:importProject · .nsp 导入', () => {
  it('解包到新项目目录、写 id_map.json、登记项目行；**明确报告业务数据未合并**', async () => {
    const h = await harness()
    try {
      const exported = await exportProject(h, { contents: 'standard' })
      const result = await h.tasks.runNowImport({ path: exported.filePath, options: {} }, h.ctx('t-import'))

      assert.notEqual(result.projectId, PROJECT_ID, '导入必须换新的 projectId（docs/03 §8 规则 3）')
      assert.ok(existsSync(result.projectDir))
      for (const rel of [
        MANIFEST_FILE,
        'project.json',
        'database.sqlite',
        'audio/segments/seg-l1.wav',
        ID_MAP_FILE,
      ]) {
        assert.ok(existsSync(join(result.projectDir, rel)), `${rel} 应该被解包出来`)
      }
      assert.ok(result.writtenFiles > 0)
      assert.equal(result.businessDataMerged, false)
      assert.ok(
        result.warnings.some((w) => w.includes('业务数据')),
        '未实现的边界必须出现在结果里，而不是静默成功',
      )

      // id_map.json（docs/03 §8 规则 3：存于导入结果目录，供任务包回传时二次翻译）
      const idMap = JSON.parse(readFileSync(join(result.projectDir, ID_MAP_FILE), 'utf8')) as {
        format: string
        projectId: { from: string; to: string }
        remapped: boolean
        entities: Record<string, string>
      }
      assert.equal(idMap.format, 'nsp-id-map')
      assert.equal(idMap.projectId.to, result.projectId)
      assert.equal(idMap.remapped, true, '本地已有同名 project id → 应做整体重映射')
      assert.equal(result.remapped, true)

      // 项目行登记了（否则导入的项目在列表里根本看不见）
      const project = h.dbLike
        .prepare(`SELECT name, root_dir FROM projects WHERE id = ?`)
        .get(result.projectId) as { name: string; root_dir: string } | undefined
      assert.ok(project, '导入必须登记 projects 行')
      assert.equal(project.name, '斗破苍穹')
      assert.equal(project.root_dir, result.projectDir)

      // 业务数据**确实没有**合并（本轮公开的边界，测试把它钉住）
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM books WHERE project_id = ?`, result.projectId), 0)

      const history = await h.service.listHistory(result.projectId)
      assert.equal(history.length, 1)
      assert.equal(history[0].direction, 'import')
      assert.equal(history[0].filePath, exported.filePath)
      assert.equal(history[0].stats?.businessDataMerged, 0)
    } finally {
      h.cleanup()
    }
  })

  it('导入的错误路径：文件不存在 / 不是包 / 拿任务包当项目包 / 版本过新；失败不留半个项目目录', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.tasks.runNowImport({ path: join(h.root, '没有.nsp'), options: {} }, h.ctx()),
        (e: unknown) => isAppError(e) && e.key === 'FILE_NOT_FOUND',
      )

      const junk = join(h.root, 'junk.nsp')
      writeFileSync(junk, Buffer.from('随便一段文本', 'utf8'))
      await assert.rejects(
        () => h.tasks.runNowImport({ path: junk, options: {} }, h.ctx()),
        (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
      )

      // 任务包（.nst）冒充项目包：manifest 的 format 校验会拦住它
      const nst = await exportTask(h, {}, 't-nst-for-import')
      await assert.rejects(
        () => h.tasks.runNowImport({ path: nst.filePath, options: {} }, h.ctx('t-2')),
        (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
      )

      const tooNew = join(h.root, 'nsp-too-new.nsp')
      await writeRawEntries(tooNew, {
        [MANIFEST_FILE]: JSON.stringify({ format: 'nsp', formatVersion: 99 }),
      })
      await assert.rejects(
        () => h.tasks.runNowImport({ path: tooNew, options: {} }, h.ctx('t-3')),
        (e: unknown) => isAppError(e) && e.key === 'PACKAGE_VERSION_TOO_NEW',
      )

      // 失败的导入不能留下半成品目录（staging 目录必须是空的）
      mkdirSync(h.projectRoot, { recursive: true })
      const leftovers = readdirSync(h.projectRoot).filter((n) => n.includes('.importing-'))
      assert.deepEqual(leftovers, [], '导入失败必须清掉 staging 目录')
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM projects`), 2, '失败的导入不该登记项目')
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// ⑤ 回收合并（.nst）
// ---------------------------------------------------------------------------

describe('package:mergeTask · .nst 回收合并', () => {
  it('归位：真写 take 文件 + 入 takes 表 + 生成成品片段 + 报告落库可读回', async () => {
    const h = await harness()
    try {
      const manifest = await exportAndReadManifest(h, 't-export')
      const returned = join(h.root, 'returned.nst')
      const takeBytes = wav(300)
      await writeReturnedPackage(returned, manifest, [{ lineId: 'l2', takeId: 't1', bytes: takeBytes }])

      const report = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: returned }, h.ctx('t-merge'))

      assert.equal(report.packageId, manifest.packageId)
      assert.equal(report.placed, 1, 'l2 应被归位')
      assert.deepEqual(report.missing, ['l3'], '没回传的行要列出来（配音员漏录）')
      assert.deepEqual(report.unknown, [])
      assert.equal(report.corrupted, 0)
      assert.equal(report.checksumFailed, 0)
      assert.equal(report.adopted, 1, 'l2 原本没有成品片段 → 应被设为成品（docs/11 §6.4）')
      assert.equal(report.actorName, '小林')

      // 文件真的落盘了，内容与回传的一致
      const takePath = join(h.projectRoot, PROJECT_ID, 'takes', 'l2', 't1.wav')
      assert.ok(existsSync(takePath), 'take 音频必须真的写到 takes/{lineId}/{takeId}.wav')
      assert.equal(Buffer.compare(readFileSync(takePath), takeBytes), 0)

      // takes 表真的有行，并带 package_id 溯源
      const take = h.dbLike
        .prepare(
          `SELECT line_id, source, package_id, sample_rate, bit_depth, channels, duration_ms, peak_db
             FROM takes WHERE id = ?`,
        )
        .get('t1') as Record<string, unknown> | undefined
      assert.ok(take, 'take 必须入库')
      assert.equal(take.line_id, 'l2')
      assert.equal(take.source, 'package')
      assert.equal(take.package_id, manifest.packageId)
      assert.equal(take.sample_rate, 48000)
      assert.equal(take.bit_depth, 24)
      assert.equal(take.channels, 1)
      assert.equal(take.duration_ms, 300)
      assert.equal(take.peak_db, -6)

      // 成品片段：新建 segments 文件与 voice_segments 行
      const segment = h.dbLike
        .prepare(`SELECT id, file_path, take_id, duration_ms FROM voice_segments WHERE line_id = ?`)
        .get('l2') as Record<string, unknown> | undefined
      assert.ok(segment, '原本没有成品片段的行被回传后应生成 voice_segments 行')
      assert.equal(segment.take_id, 't1')
      assert.ok(existsSync(join(h.projectRoot, PROJECT_ID, String(segment.file_path))), '片段文件必须在盘上')

      // 报告落库 + lastMergeReport 读回
      const rows = await h.repo.listByProject(PROJECT_ID)
      const mergeRow = rows.find((r) => r.direction === 'merge')
      assert.ok(mergeRow, '合并必须留历史行')
      assert.equal(mergeRow.status, 'done')
      assert.deepEqual(mergeRow.report, report)
      assert.equal(mergeRow.stats?.placed, 1)
      assert.equal(mergeRow.actorId, ACTOR_ID)
      assert.equal(mergeRow.linesHash, manifest.linesHash)

      const last = await h.service.lastMergeReport(PROJECT_ID)
      assert.deepEqual(last, report)
    } finally {
      h.cleanup()
    }
  })

  it('未知 lineId 不入库；损坏音频跳过计数；缺 checksums 也能合并', async () => {
    const h = await harness()
    try {
      const manifest = await exportAndReadManifest(h, 't-export')

      const mixed = join(h.root, 'mixed.nst')
      await writeReturnedPackage(mixed, manifest, [
        { lineId: 'l2', takeId: 't1', bytes: wav(200) },
        { lineId: 'ghost-line', takeId: 't9', bytes: wav(200) },
      ])
      const report = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: mixed }, h.ctx())
      assert.equal(report.placed, 1)
      assert.deepEqual(report.unknown, ['ghost-line'], '画本里没有的行不进库，但要写进报告')
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM takes WHERE line_id = ?`, 'ghost-line'), 0)

      // 损坏音频：跳过并计数，其余照常归位（docs/03 §8 导入规则 2）
      const broken = join(h.root, 'broken.nst')
      await writeReturnedPackage(broken, manifest, [
        { lineId: 'l3', takeId: 't2', bytes: Buffer.from('这不是 WAV') },
        { lineId: 'l2', takeId: 't3', bytes: wav(150) },
      ])
      const report2 = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: broken }, h.ctx('t-2'))
      assert.equal(report2.corrupted, 1)
      assert.equal(report2.placed, 1)
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM takes WHERE id = ?`, 't2'), 0)

      // 没有 checksums.sha256 的包：不整体失败，只是跳过逐文件校验
      const noChecksums = join(h.root, 'no-checksums.nst')
      await writeRawEntries(noChecksums, {
        [TASK_FILE]: JSON.stringify(manifest),
        'slots/l2/t4.wav': wav(120),
      })
      const report3 = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: noChecksums }, h.ctx('t-3'))
      assert.equal(report3.placed, 1)
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM takes WHERE id = ?`, 't4'), 1)
    } finally {
      h.cleanup()
    }
  })

  it('重复回传去重、同 takeId 不同内容追加（绝不覆盖旧 take）', async () => {
    const h = await harness()
    try {
      const manifest = await exportAndReadManifest(h, 't-export')
      const contentA = wav(300)
      const same = join(h.root, 'same.nst')
      await writeReturnedPackage(same, manifest, [{ lineId: 'l2', takeId: 't1', bytes: contentA }])

      const first = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: same }, h.ctx())
      assert.equal(first.placed, 1)
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM takes WHERE line_id = ?`, 'l2'), 1)

      // 同一个包再合一次 → 内容哈希相同 → 去重（docs/11 §6.4 第 4 步）
      const again = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: same }, h.ctx('t-2'))
      assert.equal(again.placed, 0)
      assert.equal(again.duplicateTakes, 1)
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM takes WHERE line_id = ?`, 'l2'), 1, '不应重复入库')

      // 同 takeId 但内容不同（重录）→ 追加为新 take，旧文件与旧行都留着
      const contentB = wav(320)
      const rerecorded = join(h.root, 'rerecorded.nst')
      await writeReturnedPackage(rerecorded, manifest, [{ lineId: 'l2', takeId: 't1', bytes: contentB }])
      const third = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: rerecorded }, h.ctx('t-3'))
      assert.equal(third.placed, 1, '重录应作为新 take 追加，而不是被当成重复')
      assert.equal(countRows(h, `SELECT COUNT(*) AS n FROM takes WHERE line_id = ?`, 'l2'), 2)
      const written = h.dbLike
        .prepare(`SELECT id, file_path FROM takes WHERE line_id = ? ORDER BY created_at, id`)
        .all('l2') as Array<{ id: string; file_path: string }>
      for (const w of written) {
        assert.ok(existsSync(join(h.projectRoot, PROJECT_ID, w.file_path)), `${w.file_path} 必须在盘上`)
      }
      assert.equal(
        Buffer.compare(readFileSync(join(h.projectRoot, PROJECT_ID, 'takes', 'l2', 't1.wav')), contentA),
        0,
        '旧 take 的文件绝不能被覆盖',
      )
    } finally {
      h.cleanup()
    }
  })

  it('画本已变更（linesHash 不一致）：仍按 lineId 归位，并给出差异计数', async () => {
    const h = await harness()
    try {
      const manifest = await exportAndReadManifest(h, 't-export')
      const returned = join(h.root, 'changed.nst')
      await writeReturnedPackage(returned, manifest, [{ lineId: 'l2', takeId: 't1', bytes: wav(300) }])

      // 导演侧改了画本（l3 文本），但没有重发任务包
      h.dbLike.prepare(`UPDATE canvas_lines SET text = ? WHERE id = ?`).run('我必须变强！', 'l3')

      const report = await h.tasks.runNowMerge({ projectId: PROJECT_ID, path: returned }, h.ctx())
      assert.equal(report.linesChanged, true, 'linesHash 不一致必须被发现')
      assert.ok(report.diffCount >= 1)
      assert.equal(report.placed, 1, '画本变了也要尽力归位，不能把配音员的活儿丢掉')
    } finally {
      h.cleanup()
    }
  })

  it('合并的错误路径：项目不存在 / 包不存在 / 包不属于本项目 / 版本过新', async () => {
    const h = await harness()
    try {
      const manifest = await exportAndReadManifest(h, 't-export')
      const returned = join(h.root, 'returned.nst')
      await writeReturnedPackage(returned, manifest, [{ lineId: 'l2', takeId: 't1', bytes: wav(200) }])

      await assert.rejects(
        () => h.tasks.runNowMerge({ projectId: 'ghost', path: returned }, h.ctx()),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => h.tasks.runNowMerge({ projectId: PROJECT_ID, path: join(h.root, '没有.nst') }, h.ctx()),
        (e: unknown) => isAppError(e) && e.key === 'FILE_NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.mergeTask('ghost', returned),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
      // 服务层自己的校验（不需要队列）：空路径直接拒掉
      await assert.rejects(
        () => h.service.mergeTask(PROJECT_ID, '   '),
        (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
      )

      // 别的项目的包：拒绝合并（否则可能把音频归到 id 巧合相同的行上）
      const foreign = join(h.root, 'foreign.nst')
      await writeReturnedPackage(
        foreign,
        { ...manifest, source: { ...manifest.source, projectId: 'p2' } },
        [{ lineId: 'l2', takeId: 't1', bytes: wav(200) }],
      )
      await assert.rejects(
        () => h.tasks.runNowMerge({ projectId: PROJECT_ID, path: foreign }, h.ctx('t-2')),
        (e: unknown) => {
          assert.ok(isAppError(e))
          assert.equal(e.key, 'INVALID_PAYLOAD')
          assert.equal(e.details?.reason, 'package-project-mismatch')
          return true
        },
      )

      const tooNew = join(h.root, 'nst-too-new.nst')
      await writeRawEntries(tooNew, { [TASK_FILE]: JSON.stringify({ ...manifest, formatVersion: 99 }) })
      await assert.rejects(
        () => h.tasks.runNowMerge({ projectId: PROJECT_ID, path: tooNew }, h.ctx('t-3')),
        (e: unknown) => isAppError(e) && e.key === 'PACKAGE_VERSION_TOO_NEW',
      )

      // 以上都在「建历史行之前」失败（读包/校验阶段）→ 不该留下合并历史行；
      // 用户看到的是任务中心里的失败记录，而不是一条内容为空的「已合并」
      const mergeRows = (await h.repo.listByProject(PROJECT_ID)).filter((r) => r.direction === 'merge')
      assert.deepEqual(mergeRows, [])
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// ⑥ 历史、报告与队列
// ---------------------------------------------------------------------------

describe('package:listHistory / lastMergeReport / 队列', () => {
  it('历史按时间倒序；没有合并记录时 lastMergeReport 为 null；项目不存在报 NOT_FOUND', async () => {
    const h = await harness()
    try {
      assert.equal(await h.service.lastMergeReport(PROJECT_ID), null, '没有合并过 → null（不是空报告）')
      assert.deepEqual(await h.service.listHistory(PROJECT_ID), [])

      h.dbLike
        .prepare(
          `INSERT INTO packages (id, project_id, kind, direction, file_path, status, created_at)
           VALUES ('old', ?, 'nsp', 'export', '/tmp/old.nsp', 'done', 100)`,
        )
        .run(PROJECT_ID)
      h.dbLike
        .prepare(
          `INSERT INTO packages (id, project_id, kind, direction, actor_id, file_path, status, created_at)
           VALUES ('new', ?, 'nst', 'export', ?, '/tmp/new.nst', 'done', 200)`,
        )
        .run(PROJECT_ID, ACTOR_ID)

      const list = await h.service.listHistory(PROJECT_ID)
      assert.deepEqual(
        list.map((e) => e.id),
        ['new', 'old'],
        '必须按时间倒序（UI 直接展示，不再排序）',
      )
      assert.equal(list[0].actorName, '小林')
      assert.equal(list[1].actorName, null, '项目包没有配音员 → null，不编一个名字')

      await assert.rejects(
        () => h.service.listHistory('ghost'),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => h.service.lastMergeReport('ghost'),
        (e: unknown) => isAppError(e) && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('队列未注入时，4 个长任务通道都抛 TASK_QUEUE_UNAVAILABLE（不假装成功）', async () => {
    const h = await harness()
    try {
      const tasksWithoutQueue = createPackageTasks({
        getDb: () => h.dbLike,
        projectRoot: () => h.projectRoot,
        exportDir: () => h.exportDir,
        app: () => ({ name: 'Novel Studio', version: '0' }),
        repo: () => h.repo,
        log: { info: () => {}, warn: () => {} },
      })
      const expectQueueError = (e: unknown): boolean => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'TASK_QUEUE_UNAVAILABLE')
        return true
      }
      await assert.rejects(() => tasksWithoutQueue.enqueueExportProject(PROJECT_ID, {}), expectQueueError)
      await assert.rejects(() => tasksWithoutQueue.enqueueExportTask(BOOK_ID, ACTOR_ID, {}), expectQueueError)
      await assert.rejects(() => tasksWithoutQueue.enqueueImportProject('x.nsp', {}), expectQueueError)
      await assert.rejects(() => tasksWithoutQueue.enqueueMergeTask(PROJECT_ID, 'x.nst'), expectQueueError)
    } finally {
      h.cleanup()
    }
  })

  it('taskSpecs 覆盖三个 kind（否则入队只会得到 unknown-task-kind）', async () => {
    const h = await harness()
    try {
      const kinds = h.tasks.taskSpecs().map((s) => s.kind)
      assert.deepEqual([...kinds].sort(), ['package.export', 'package.import', 'package.merge'])
    } finally {
      h.cleanup()
    }
  })
})
