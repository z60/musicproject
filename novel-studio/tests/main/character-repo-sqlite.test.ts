/**
 * 角色与原型向量仓储（SQLite）· 往返 + 与内存实现的一致性
 * ============================================================================
 * 三条语义各有对应测试（见实现文件头部）：
 *   ① 归档 ≠ 删除（`listByBook` 默认过滤、`listCentroids` 总是过滤归档）
 *   ② `upsert` 保留 `created_at`、刷新 `updated_at`
 *   ③ `centroid` 一律由 `sum_vector + sample_count` 重新推导（不采信调用方）
 *
 * 再加上「同一串操作两个实现结果一致」——内存实现是行为基准，
 * 这层是唯一能自动发现「两边语义漂移」的手段。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import {
  createMemoryCharacterRepo,
  type CharacterRepo,
} from '../../src/main/features/book/canvas/repositories/character.repo.ts'
import { createSqliteCharacterRepo } from '../../src/main/features/book/canvas/repositories/character.repo.sqlite.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { Character } from '../../src/shared/types.ts'

async function sqliteRepo(): Promise<{ repo: CharacterRepo; db: DatabaseSync }> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', 'C:/tmp/p1', 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  return { repo: createSqliteCharacterRepo(db as unknown as DbLike), db }
}

const character = (over: Partial<Character> = {}): Character => ({
  id: 'ch1',
  bookId: 'b1',
  name: '张三',
  aliases: ['小张', '老三'],
  gender: 'male',
  ageGroup: 'young',
  description: '主角',
  note: '备注',
  color: '#AABBCC',
  defaultSpeed: 'slow',
  defaultEmotion: '平静',
  defaultGainDb: -2,
  defaultPauseMs: 300,
  isArchived: false,
  sortOrder: 10,
  createdAt: 111,
  updatedAt: 222,
  ...over,
})

describe('角色仓储（SQLite）· 字段往返', () => {
  it('逐字段往返（别名来自 character_aliases 表，0/1 归档列照旧）', async () => {
    const { repo } = await sqliteRepo()
    await repo.upsert(character())

    const got = await repo.get('ch1')
    assert.ok(got)
    // `updatedAt` 由仓储刷新为当前时间、`aliases` 一律归一化后排序（拼音序），
    // 其余逐字段一致
    const expected = character({ aliases: ['老三', '小张'] })
    assert.deepEqual({ ...got, updatedAt: 0 }, { ...expected, updatedAt: 0 })
    assert.ok(got.updatedAt > 222, 'updatedAt 应刷新')
    assert.equal(got.createdAt, 111, 'createdAt 必须保留调用方给的值（首次插入）')
  })

  it('别名以 character_aliases 表为权威：JSON 列坏掉不影响读取', async () => {
    const { repo, db } = await sqliteRepo()
    await repo.upsert(character())
    // JSON 列是历史列（只写不读）。把它写坏**不应该**影响别名 ——
    // 权威在关系表里，而关系表还能撑住「按别名反查」与「别名唯一」这两件事
    db.exec(`UPDATE characters SET aliases = '{坏掉的 JSON' WHERE id = 'ch1'`)

    const got = await repo.get('ch1')
    assert.deepEqual(got?.aliases, ['老三', '小张'], '别名应按名称排序返回，且与 JSON 列无关')
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM character_aliases WHERE character_id = 'ch1'`).get() as { n: number }).n,
      2,
    )
  })

  it('别名整集替换：新增走插入、删除走删除，重复项被规范化掉', async () => {
    const { repo, db } = await sqliteRepo()
    await repo.upsert(character())

    // 去掉「老三」、加上「阿三」与重复/空白的「 阿三 」
    const saved = await repo.upsert(character({ aliases: ['小张', '阿三', ' 阿三 ', '  '] }))
    assert.deepEqual(saved.aliases, ['阿三', '小张'], '空串与重复项（含两侧空白）都要归一掉')

    const rows = db
      .prepare(`SELECT alias FROM character_aliases WHERE character_id = 'ch1' ORDER BY alias`)
      .all() as Array<{ alias: string }>
    assert.deepEqual(rows.map((r) => r.alias), ['小张', '阿三'], '被删掉的别名必须真的从表里消失')

    // 再存一次同样的集合 → 幂等（不会重复插入，UNIQUE 也不会炸）
    await repo.upsert(character({ aliases: ['小张', '阿三'] }))
    assert.deepEqual((await repo.get('ch1'))?.aliases, ['阿三', '小张'])
  })

  it('listAliases：整本书一次取全（含归档角色），用于别名冲突检测', async () => {
    const { repo } = await sqliteRepo()
    await repo.upsert(character())
    await repo.upsert(character({ id: 'ch2', name: '李四', aliases: ['四哥'], isArchived: true }))

    const all = await repo.listAliases('b1')
    assert.deepEqual(
      all.map((a) => `${a.characterId}:${a.alias}`).sort(),
      ['ch1:小张', 'ch1:老三', 'ch2:四哥'].sort(),
      '归档角色的别名也要在（否则合并时可能默默与之冲突）',
    )
    assert.deepEqual(await repo.listAliases('b2'), [])
  })

  it('upsert 保留已有 created_at；upsertMany 是批量', async () => {
    const { repo } = await sqliteRepo()
    const first = await repo.upsert(character({ createdAt: 1000 }))
    const again = await repo.upsert({ ...first, name: '张三改', createdAt: 9999 })
    assert.equal(again.createdAt, 1000, '已有行的 created_at 不能被入参覆盖')
    assert.equal(again.name, '张三改')

    const n = await repo.upsertMany([
      character({ id: 'ch2', name: '李四', sortOrder: 20 }),
      character({ id: 'ch3', name: '王五', sortOrder: 5 }),
    ])
    assert.equal(n, 2)
  })
})

describe('角色仓储（SQLite）· 归档不删除', () => {
  it('归档后 listByBook 默认看不到，includeArchived 能看到；行仍在库里', async () => {
    const { repo, db } = await sqliteRepo()
    await repo.upsert(character({ id: 'ch1' }))
    await repo.upsert(character({ id: 'ch2', name: '李四' }))

    await repo.setArchived('ch1', true)

    assert.deepEqual((await repo.listByBook('b1')).map((c) => c.id), ['ch2'])
    assert.deepEqual((await repo.listByBook('b1', { includeArchived: true })).map((c) => c.id).sort(), ['ch1', 'ch2'])
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM characters`).get() as { n: number }
    assert.equal(rows.n, 2, '归档是标记，不是物理删除（docs/11 §4.6）')

    await repo.setArchived('ch1', false)
    assert.equal((await repo.listByBook('b1')).length, 2)
  })

  it('listByBook 按 sortOrder 再按名字排序，不存在的角色 setArchived → NOT_FOUND', async () => {
    const { repo } = await sqliteRepo()
    await repo.upsertMany([
      character({ id: 'a', name: '乙', sortOrder: 2 }),
      character({ id: 'b', name: '甲', sortOrder: 1 }),
      character({ id: 'c', name: '丙', sortOrder: 2 }),
    ])
    // sortOrder 相同（2）时按名字比较：丙 < 乙（拼音 bing < yi，码点 U+4E19 < U+4E59 也一致）
    assert.deepEqual((await repo.listByBook('b1')).map((c) => c.id), ['b', 'c', 'a'])

    await assert.rejects(() => repo.setArchived('nope', true), { key: 'NOT_FOUND' })
  })
})

describe('角色仓储（SQLite）· 原型向量', () => {
  it('centroid 由 sum+count 重新推导，不采信调用方给的值', async () => {
    const { repo } = await sqliteRepo()
    await repo.upsert(character())

    // 故意给一个错误的 centroid：实现必须忽略它并重新算
    await repo.upsertCentroid({
      characterId: 'ch1',
      modelId: 'm1',
      dim: 2,
      sumVector: Float32Array.from([3, 0]),
      sampleCount: 3,
      centroid: Float32Array.from([999, 999]),
      updatedAt: 500,
    })

    const got = await repo.getCentroid('ch1', 'm1')
    assert.ok(got)
    assert.deepEqual([...got.centroid], [1, 0], 'sum=[3,0] / count=3 → 归一化 [1,0]')
    assert.equal(got.sampleCount, 3)
    assert.deepEqual([...got.sumVector], [3, 0])
    assert.equal(got.updatedAt, 500)
  })

  it('同 (角色, 模型) 幂等 upsert；按模型分空间；listCentroids 过滤归档角色', async () => {
    const { repo } = await sqliteRepo()
    await repo.upsert(character({ id: 'ch1' }))
    await repo.upsert(character({ id: 'ch2', name: '李四' }))

    await repo.upsertCentroid({
      characterId: 'ch1', modelId: 'm1', dim: 2, sumVector: Float32Array.from([1, 0]),
      sampleCount: 1, centroid: Float32Array.from([1, 0]), updatedAt: 1,
    })
    await repo.upsertCentroid({
      characterId: 'ch1', modelId: 'm1', dim: 2, sumVector: Float32Array.from([0, 2]),
      sampleCount: 2, centroid: Float32Array.from([0, 1]), updatedAt: 2,
    })
    await repo.upsertCentroid({
      characterId: 'ch2', modelId: 'm1', dim: 2, sumVector: Float32Array.from([0, 1]),
      sampleCount: 1, centroid: Float32Array.from([0, 1]), updatedAt: 1,
    })
    await repo.upsertCentroid({
      characterId: 'ch2', modelId: 'm2', dim: 2, sumVector: Float32Array.from([1, 1]),
      sampleCount: 1, centroid: Float32Array.from([1, 1]), updatedAt: 1,
    })

    assert.equal((await repo.getCentroid('ch1', 'm1'))?.sampleCount, 2, '同键覆盖而不是新增')
    assert.deepEqual((await repo.listCentroids('b1', 'm1')).map((r) => r.characterId).sort(), ['ch1', 'ch2'])
    assert.deepEqual((await repo.listCentroids('b1', 'm2')).map((r) => r.characterId), ['ch2'])
    assert.equal((await repo.listCentroids('b1')).length, 3, '不给 modelId = 全部模型')

    await repo.setArchived('ch2', true)
    assert.deepEqual((await repo.listCentroids('b1')).map((r) => r.characterId), ['ch1'], '归档角色的原型不参与判定')
  })

  it('deleteCentroidsByModel 只清指定模型空间', async () => {
    const { repo } = await sqliteRepo()
    await repo.upsert(character({ id: 'ch1' }))
    for (const modelId of ['m1', 'm2']) {
      await repo.upsertCentroid({
        characterId: 'ch1', modelId, dim: 2, sumVector: Float32Array.from([1, 0]),
        sampleCount: 1, centroid: Float32Array.from([1, 0]), updatedAt: 1,
      })
    }
    assert.equal(await repo.deleteCentroidsByModel('m1'), 1)
    assert.equal(await repo.getCentroid('ch1', 'm1'), null)
    assert.ok(await repo.getCentroid('ch1', 'm2'), '别的模型空间不受影响')
  })
})

describe('角色仓储 · SQLite 与内存实现行为一致', () => {
  async function runScenario(repo: CharacterRepo) {
    await repo.upsertMany([
      character({ id: 'a', name: '乙', sortOrder: 2 }),
      character({ id: 'b', name: '甲', sortOrder: 1 }),
      character({ id: 'c', name: '丙', sortOrder: 2 }),
    ])
    await repo.setArchived('a', true)
    await repo.upsertCentroid({
      characterId: 'b', modelId: 'm1', dim: 2, sumVector: Float32Array.from([3, 4]),
      sampleCount: 5, centroid: Float32Array.from([0, 0]), updatedAt: 7,
    })
    await repo.upsertCentroid({
      characterId: 'b', modelId: 'm2', dim: 2, sumVector: Float32Array.from([1, 0]),
      sampleCount: 1, centroid: Float32Array.from([0, 0]), updatedAt: 8,
    })

    const list = await repo.listByBook('b1')
    const all = await repo.listByBook('b1', { includeArchived: true })
    const c1 = await repo.getCentroid('b', 'm1')
    return {
      list: list.map((c) => `${c.id}:${c.name}:${c.sortOrder}:${c.isArchived}`),
      all: all.map((c) => `${c.id}:${c.isArchived}`),
      centroids: (await repo.listCentroids('b1')).map((r) => `${r.characterId}:${r.modelId}:${r.sampleCount}`).sort(),
      centroid: c1 ? { dim: c1.dim, sum: [...c1.sumVector], cen: [...c1.centroid], n: c1.sampleCount } : null,
      deleted: await repo.deleteCentroidsByModel('m2'),
      afterDelete: (await repo.listCentroids('b1')).length,
    }
  }

  it('同一串操作产生相同结果（含原型向量的派生与排序）', async () => {
    const { repo: sqlite } = await sqliteRepo()
    const memory = createMemoryCharacterRepo()

    const fromSqlite = await runScenario(sqlite)
    const fromMemory = await runScenario(memory)

    assert.deepEqual(fromSqlite, fromMemory)
  })
})
