/**
 * 测试 · 预设域（`preset:*` 6 个通道）
 * ============================================================================
 * 设计依据：docs/14 §4、docs/21 §6、docs/14 §7.1（预设是处理任务的输入）
 *
 * ### 为什么用真 SQLite
 *   预设的 `chain` 是 JSON 文本、`tags` 是 JSON 数组、`project_id` 可空（NULL = 全局）。
 *   这三处都是「看起来能跑、换一个驱动就错」的地方：
 *   · JSON 往返后链必须仍然完整（少字段会让「应用预设」时才炸）；
 *   · `project_id IS NULL` 的全局语义（写成 `!= ?` 就把全局预设漏掉了）；
 *   · 内置预设**不在库里**，必须由服务层合并（否则用户会看到「内置预设消失了」）。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import type { ProcessChain, ProcessPreset } from '../../src/shared/types.ts'
import { BUILTIN_PRESETS } from '../../src/shared/constants.ts'
import { chainHash } from '../../src/shared/audio/process.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { normalizeChain } from '../../src/main/features/audio/repositories/preset.repo.ts'
import { createSqlitePresetRepo } from '../../src/main/features/audio/repositories/preset.repo.sqlite.ts'
import { createPresetService, extractPresetList, type PresetService } from '../../src/main/features/audio/preset.service.ts'

const PROJECT_ID = 'p1'

function chain(patch: Partial<ProcessChain> = {}): ProcessChain {
  return normalizeChain({ ...patch })
}

interface Harness {
  root: string
  db: DatabaseSync
  preset: PresetService
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ns-preset-'))
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  const dbLike = db as unknown as DbLike
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'proj', '${root.replace(/\\/g, '/')}', 4, 1, 1)`)

  let seq = 0
  const preset = createPresetService({
    repo: () => createSqlitePresetRepo(dbLike, { newId: () => `preset-${++seq}`, now: () => 1_700_000_000_000 }),
    now: () => 1_700_000_000_000,
  })
  return {
    root,
    db,
    preset,
    cleanup: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const ACTIVE = chain({
  highpass: { enabled: true, freq: 80, poles: 2 },
  compressor: { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 },
})

describe('预设域 · 列表与 CRUD', () => {
  it('list = 内置（只读常量）+ 库里的行；全局与项目级并集', async () => {
    const h = await harness()
    try {
      const builtinCount = BUILTIN_PRESETS.length
      const empty = await h.preset.list(PROJECT_ID)
      assert.equal(empty.length, builtinCount, '没有用户预设时应当只有内置项')
      assert.equal(empty[0]!.builtin, true)

      await h.preset.create({ projectId: PROJECT_ID, name: '我的旁白', description: null, chain: ACTIVE, tags: ['旁白'], sortOrder: 100 })
      await h.preset.create({ projectId: null, name: '全局通用', description: null, chain: chain(), tags: [], sortOrder: 90 })

      const mine = await h.preset.list(PROJECT_ID)
      assert.equal(mine.length, builtinCount + 2)
      const names = mine.map((p) => p.name)
      assert.ok(names.includes('我的旁白') && names.includes('全局通用'))

      // 另一个项目只看到全局项
      const other = await h.preset.list('p2')
      assert.equal(other.length, builtinCount + 1)
      assert.ok(other.some((p) => p.name === '全局通用'))
      assert.ok(!other.some((p) => p.name === '我的旁白'), '项目级预设不能泄漏到别的项目')

      // 不传 projectId = 只取全局
      const global = await h.preset.list(null)
      assert.equal(global.length, builtinCount + 1)
    } finally {
      h.cleanup()
    }
  })

  it('create → update → delete：链 JSON 往返后仍然完整（能直接构建滤镜）', async () => {
    const h = await harness()
    try {
      const created = await h.preset.create({
        projectId: PROJECT_ID,
        name: '测试预设',
        description: '说明',
        chain: ACTIVE,
        tags: ['a', 'b'],
        sortOrder: 100,
      })
      assert.equal(created.builtin, false)
      assert.equal(created.projectId, PROJECT_ID)
      assert.deepEqual(created.tags, ['a', 'b'])

      const updated = await h.preset.update(created.id, { name: '改名了', tags: ['c'] })
      assert.equal(updated.name, '改名了')
      assert.deepEqual(updated.tags, ['c'])
      assert.equal(updated.chain.compressor.enabled, true, '改名字不该动链')
      assert.equal(chainHash(updated.chain), chainHash(ACTIVE))

      const removed = await h.preset.remove(created.id)
      assert.equal(removed.ok, true)
      const after = await h.preset.list(PROJECT_ID)
      assert.ok(!after.some((p) => p.id === created.id))
    } finally {
      h.cleanup()
    }
  })

  it('链里的字段缺了也不会炸：落库前先补齐（旧文件导入的链最常见）', async () => {
    const h = await harness()
    try {
      const partial = { highpass: { enabled: true, freq: 90, poles: 2 } } as unknown as ProcessChain
      const created = await h.preset.create({
        projectId: PROJECT_ID,
        name: '残缺链',
        description: null,
        chain: partial,
        tags: [],
        sortOrder: 100,
      })
      assert.equal(created.chain.highpass.enabled, true)
      assert.equal(created.chain.compressor.enabled, false, '缺失的段必须补齐为「关闭」')
      assert.deepEqual(created.chain.eq, [])
      assert.ok(chainHash(created.chain).length === 12)
    } finally {
      h.cleanup()
    }
  })

  it('内置预设不可改、不可删（docs/14 §4：改动请另存副本）', async () => {
    const h = await harness()
    try {
      const id = BUILTIN_PRESETS[0]!.id
      await assert.rejects(
        () => h.preset.update(id, { name: '改内置' }),
        (e: unknown) => e instanceof AppError && e.key === 'PERMISSION_DENIED',
      )
      await assert.rejects(
        () => h.preset.remove(id),
        (e: unknown) => e instanceof AppError && e.key === 'PERMISSION_DENIED',
      )
      // 不存在的 id 是 NOT_FOUND（与「内置只读」区分开，UI 提示才准确）
      await assert.rejects(
        () => h.preset.update('preset-ghost', { name: 'x' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
      const listed = await h.preset.list(PROJECT_ID)
      assert.ok(listed.some((p) => p.id === id && p.builtin))
    } finally {
      h.cleanup()
    }
  })

  it('空名字被拒绝（列表里会出现一排无法区分的项）', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.preset.create({ projectId: PROJECT_ID, name: '   ', description: null, chain: ACTIVE, tags: [], sortOrder: 100 }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })
})

describe('预设域 · 导入导出', () => {
  it('导出 → 导入往返：链与标签一致；重名自动改名（导入是追加，不覆盖）', async () => {
    const h = await harness()
    try {
      const original = await h.preset.create({
        projectId: PROJECT_ID,
        name: '同事的预设',
        description: '来自同事',
        chain: ACTIVE,
        tags: ['同事'],
        sortOrder: 120,
      })
      const outPath = join(h.root, 'presets.json')
      const exported = await h.preset.exportTo([original.id, BUILTIN_PRESETS[0]!.id], outPath)
      assert.equal(exported.path, outPath)
      const file = JSON.parse(readFileSync(outPath, 'utf8')) as {
        version: number
        presets: Array<{ name: string; chain: ProcessChain; chainHash?: string }>
      }
      assert.equal(file.presets.length, 2)
      assert.equal(file.presets[0]!.chainHash, chainHash(ACTIVE))

      const result = await h.preset.importFrom(outPath, { projectId: PROJECT_ID })
      assert.equal(result.imported, 2)
      assert.deepEqual(result.warnings, [], '往返导入不该有告警')

      const list = await h.preset.list(PROJECT_ID)
      const imported = list.filter((p) => p.name.startsWith('同事的预设') && !p.builtin)
      assert.equal(imported.length, 2, '同名的两条：原有一条 + 导入的一条（自动改名）')
      assert.ok(imported.some((p) => p.name === '同事的预设 (2)'))
      const reimported = imported.find((p) => p.name === '同事的预设 (2)')!
      assert.equal(chainHash(reimported.chain), chainHash(ACTIVE))
      assert.deepEqual(reimported.tags, ['同事'])
    } finally {
      h.cleanup()
    }
  })

  it('导入容错：坏条目跳过并给告警，好条目照常导入（不整份拒绝）', async () => {
    const h = await harness()
    try {
      const path = join(h.root, 'partial.json')
      writeFileSync(
        path,
        JSON.stringify({
          version: 99,
          presets: [
            { name: '好的', chain: ACTIVE },
            { description: '没有名字', chain: ACTIVE },
            { name: '链是字符串', chain: 'not-an-object' },
            { name: '空链', chain: {} },
          ],
        }),
        'utf8',
      )
      const result = await h.preset.importFrom(path, { projectId: PROJECT_ID })
      assert.equal(result.imported, 2, '「好的」与「空链」应当导入成功')
      assert.ok(result.warnings.some((w) => w.includes('缺少 name')))
      assert.ok(result.warnings.some((w) => w.includes('链是字符串')))
      assert.ok(result.warnings.some((w) => w.includes('空处理链')), '空链要提示（可能不是本意）')
      assert.ok(result.warnings.some((w) => w.includes('版本 99')), '高版本文件要给提示，但不拒绝')
    } finally {
      h.cleanup()
    }
  })

  it('导入/导出的错误路径要说人话：不是绝对路径、后缀不对、文件不存在、没有预设', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => h.preset.importFrom('relative/presets.json'),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.preset.exportTo([BUILTIN_PRESETS[0]!.id], join(h.root, 'presets.txt')),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.preset.importFrom(join(h.root, 'nope.json')),
        (e: unknown) => e instanceof AppError && e.key === 'FILE_NOT_FOUND',
      )
      const bad = join(h.root, 'bad.json')
      writeFileSync(bad, '{ this is not json', 'utf8')
      await assert.rejects(
        () => h.preset.importFrom(bad),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      const emptyish = join(h.root, 'empty.json')
      writeFileSync(emptyish, JSON.stringify({ version: 1, presets: [] }), 'utf8')
      await assert.rejects(
        () => h.preset.importFrom(emptyish),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.preset.exportTo(['preset-ghost'], join(h.root, 'x.json')),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
    } finally {
      h.cleanup()
    }
  })

  it('extractPresetList 兼容裸数组与 {presets:[]}（同事发来的文件格式五花八门）', () => {
    assert.equal(extractPresetList([{ name: 'a' }]).length, 1)
    assert.equal(extractPresetList({ presets: [{ name: 'a' }] }).length, 1)
    assert.equal(extractPresetList({ nope: true }).length, 0)
    assert.equal(extractPresetList(null).length, 0)
  })
})

describe('预设域 · 链解析（process:* 的输入）', () => {
  it('presetId 优先；两者都不给 → INVALID_PAYLOAD；不存在 → NOT_FOUND', async () => {
    const h = await harness()
    try {
      const builtin = await h.preset.resolveChain(BUILTIN_PRESETS[0]!.id, null)
      assert.equal(builtin.presetId, BUILTIN_PRESETS[0]!.id)
      assert.equal(chainHash(builtin.chain), chainHash(BUILTIN_PRESETS[0]!.chain))

      const created = await h.preset.create({
        projectId: PROJECT_ID,
        name: '链',
        description: null,
        chain: ACTIVE,
        tags: [],
        sortOrder: 100,
      })
      const byId = await h.preset.resolveChain(created.id, chain())
      assert.equal(chainHash(byId.chain), chainHash(ACTIVE), 'presetId 与 chain 同时给时必须用 presetId')

      const inline = await h.preset.resolveChain(null, ACTIVE)
      assert.equal(inline.presetId, null)
      assert.equal(chainHash(inline.chain), chainHash(ACTIVE))

      await assert.rejects(
        () => h.preset.resolveChain(null, null),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => h.preset.resolveChain('preset-ghost', null),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

describe('预设域 · 内置预设自身', () => {
  it('内置预设的链都能构建出滤镜串；「仅修剪」只做限幅与格式统一（常量与 002_seed 一致）', async () => {
    const { buildChainFilter } = await import('../../src/shared/ffmpeg/filters.ts')
    assert.ok(BUILTIN_PRESETS.length >= 6)
    for (const preset of BUILTIN_PRESETS as ProcessPreset[]) {
      const text = buildChainFilter(preset.chain)
      assert.equal(typeof text, 'string')
      if (preset.id === 'builtin:trim-only') {
        // docs/14 §13 的「仅修剪」= 只统一格式与峰值：**没有**高通/降噪/去齿音/EQ/压缩，
        // 只留一个限幅（把峰值压到 -1 dB）。这是有意的，不是「空链」
        assert.ok(text.includes('alimiter='), `仅修剪应当只做限幅，实际：${text}`)
        assert.ok(!text.includes('highpass') && !text.includes('afftdn') && !text.includes('acompressor'))
      } else {
        assert.ok(text.length > 0, `${preset.name} 的链不该是空的`)
      }
      assert.equal(chainHash(preset.chain).length, 12)
    }
  })

  it('内置预设 id 在 002_seed 里都能查到（常量与种子漂移会表现为「列表里两条同一个名字」）', async () => {
    const h = await harness()
    try {
      const rows = h.db
        .prepare(`SELECT id, builtin FROM process_presets WHERE builtin = 1`)
        .all() as Array<{ id: string; builtin: number }>
      const seeded = new Set(rows.map((r) => r.id))
      for (const preset of BUILTIN_PRESETS) {
        assert.ok(seeded.has(preset.id), `${preset.id} 只在常量里、不在种子里 → 列表与「实际生效的」会分叉`)
      }
      // 列表不能出现重复 id（第一版实现就是常量 + 库里各来一份，共 14 条）
      const listed = await h.preset.list(PROJECT_ID)
      const ids = listed.map((p) => p.id)
      assert.equal(new Set(ids).size, ids.length, `列表里有重复预设：${ids.join(', ')}`)
      assert.equal(listed.length, BUILTIN_PRESETS.length)
    } finally {
      h.cleanup()
    }
  })
})
