/**
 * Novel Studio · 角色与原型向量仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `character.repo.ts`（接口 + 内存实现）—— 行为基准，本文件把同样的语义翻成 SQL
 *   · docs/21 §4  `characters` / `character_centroids`
 *   · docs/03 §5.2/§5.3  原型向量按 `model_id` 分空间；`sum_vector + sample_count` 支持可逆增量
 *   · docs/11 §4.6  角色**禁止物理删除**，只允许归档
 *
 * ### 与内存实现必须一致的三条（都有对应测试）
 *   1. **归档 ≠ 删除**：`setArchived` 只改标记；`listByBook` 默认过滤归档，
 *      `listCentroids` **总是**过滤归档角色（归档角色的原型不参与判定）。
 *   2. **up 语义**：`upsert` 保留原有 `created_at`，`updated_at` 一律刷新为当前时间。
 *   3. **原型的派生**：`centroid` **不采信调用方给的值** —— 一律由
 *      `sum_vector + sample_count` 重新推导（`accumulatorFrom` → `accumulatorCentroid`）。
 *      否则「可逆增量」就失去意义：增量在 `sum_vector` 上做，`centroid` 必须跟着重算。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { Character, Id, Timestamp } from '../../../../../shared/types.ts'
import { accumulatorCentroid, accumulatorFrom } from '../../../../../shared/canvas/vector.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import { withTransactionAsync } from '../../../../infra/db/with-transaction.ts'
import { normalizeAliases, type CharacterCentroidRecord, type CharacterRepo } from './character.repo.ts'

const SELECT_CHARACTER = `
  SELECT id, book_id, name, aliases, gender, age_group, description, note, color,
         default_speed, default_emotion, default_gain_db, default_pause_ms,
         is_archived, sort_order, created_at, updated_at
    FROM characters
`

/**
 * 别名读取：**以 `character_aliases` 表为准**。
 *
 * ### 为什么不是 `characters.aliases` 那个 JSON 列
 *   DDL 里两处都能存别名（JSON 列 + 关系表），只能有一个权威，否则迟早分叉：
 *   `character_aliases` 有 `idx_alias_text(alias)` 与 `UNIQUE(character_id, alias)` ——
 *   说明设计意图是「按别名反查角色 + 别名唯一」，而 JSON 列两者都做不到。
 *   所以权威 = 关系表；JSON 列**只写不读**（保留它是为了不破坏历史库的列结构，
 *   注释里已写明「历史列」）。
 *
 * ### 为什么用两条查询而不是 SQL 聚合
 *   `GROUP_CONCAT` 的排序要套一层子查询才能保证有序，读起来比「取回来在 JS 里分组」
 *   更难核对；而一本书的角色数量级是几十到几百，多一条查询的成本可以忽略。
 */
const SELECT_ALIASES_BY_BOOK = `
  SELECT a.character_id, a.alias
    FROM character_aliases a
    JOIN characters c ON c.id = a.character_id
   WHERE c.book_id = ?
`

const SELECT_ALIASES_BY_CHARACTER = `
  SELECT alias FROM character_aliases WHERE character_id = ?
`

interface CharacterRow {
  id: string
  book_id: string
  name: string
  aliases: string | null
  gender: string | null
  age_group: string | null
  description: string | null
  note: string | null
  color: string | null
  default_speed: string | null
  default_emotion: string | null
  default_gain_db: number | null
  default_pause_ms: number | null
  is_archived: number
  sort_order: number
  created_at: number
  updated_at: number
}

const CHARACTER_COLUMNS: readonly string[] = [
  'id',
  'book_id',
  'name',
  'aliases',
  'gender',
  'age_group',
  'description',
  'note',
  'color',
  'default_speed',
  'default_emotion',
  'default_gain_db',
  'default_pause_ms',
  'is_archived',
  'sort_order',
  'created_at',
  'updated_at',
]

/**
 * 行 → 领域对象。**别名不来自这一行**（权威是 `character_aliases` 表），
 * 由调用方查完后传入 —— 这样「别名只有一个来源」这件事在签名上就看得见。
 */
export function characterFromRow(row: CharacterRow, aliases: string[] = []): Character {
  return {
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    aliases: normalizeAliases(aliases),
    gender: row.gender as Character['gender'],
    ageGroup: row.age_group as Character['ageGroup'],
    description: row.description,
    note: row.note,
    color: row.color,
    defaultSpeed: row.default_speed as Character['defaultSpeed'],
    defaultEmotion: row.default_emotion,
    defaultGainDb: row.default_gain_db,
    defaultPauseMs: row.default_pause_ms,
    isArchived: row.is_archived === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function characterToParams(c: Character): unknown[] {
  return [
    c.id,
    c.bookId,
    c.name,
    // `aliases` 是**历史列**（不参与读取，权威在 character_aliases 表）：
    // 这里仍然写入一份当前值，只为了让用 SQL 手工看库的人不至于看到一片 NULL ——
    // 一旦它和关系表不一致，以关系表为准（读取路径就是这么做的）。
    JSON.stringify(normalizeAliases(c.aliases ?? [])),
    c.gender,
    c.ageGroup,
    c.description,
    c.note,
    c.color,
    c.defaultSpeed,
    c.defaultEmotion,
    c.defaultGainDb,
    c.defaultPauseMs,
    c.isArchived ? 1 : 0,
    c.sortOrder,
    c.createdAt,
    c.updatedAt,
  ]
}

/** BLOB ↔ Float32Array（与 canvas 仓储同款：读回前先拷字节，避免 byteOffset 未对齐） */
function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

function blobToVector(b: Uint8Array): Float32Array {
  const bytes = Uint8Array.from(b)
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4))
}

export function createSqliteCharacterRepo(db: DbLike): CharacterRepo {
  const now = (): Timestamp => Date.now()

  /** 读某角色的别名（权威来源） */
  function aliasesOf(characterId: Id): string[] {
    const rows = db.prepare(SELECT_ALIASES_BY_CHARACTER).all(characterId) as Array<{ alias: string }>
    return rows.map((r) => r.alias)
  }

  /**
   * 用给定集合替换某角色的别名（表为权威）。
   *
   * 为什么是「整集替换」而不是 add/remove 两个方法：
   *   `Character.aliases` 在领域里就是一个数组，调用方（服务层）手里的也是完整数组。
   *   拆成 add/remove 会让「调用方只 add 了新别名、忘了 remove 被删的」变成可能 ——
   *   而整集替换天然幂等，重复调用结果相同。
   * 唯一约束 `UNIQUE(character_id, alias)` 会拦住重复项，所以这里先规范化再去重。
   */
  function replaceAliasesImpl(characterId: Id, aliases: readonly string[]): string[] {
    const wanted = normalizeAliases(aliases)
    const current = aliasesOf(characterId)
    const keep = new Set(wanted)
    for (const alias of current) {
      if (keep.has(alias)) continue
      db.prepare(`DELETE FROM character_aliases WHERE character_id = ? AND alias = ?`).run(characterId, alias)
    }
    const existing = new Set(current)
    for (const alias of wanted) {
      if (existing.has(alias)) continue
      db.prepare(
        `INSERT INTO character_aliases (id, character_id, alias) VALUES (?, ?, ?)
         ON CONFLICT(character_id, alias) DO NOTHING`,
      ).run(globalThis.crypto.randomUUID(), characterId, alias)
    }
    return wanted
  }

  /** 写角色行 + 其别名（一个事务：不能出现「行写进去了、别名没写」） */
  function upsertImpl(c: Character): Character {
    const existing = db.prepare(`SELECT created_at FROM characters WHERE id = ?`).get(c.id) as
      | { created_at: number }
      | undefined
    const next: Character = {
      ...c,
      // 与内存实现一致：created_at 保留原值；没有原值也没有入参时才用当前时间
      createdAt: existing?.created_at ?? c.createdAt ?? now(),
      updatedAt: now(),
    }
    const sets = CHARACTER_COLUMNS.map((col) => `${col} = ?`).join(', ')
    db.prepare(
      `INSERT INTO characters (${CHARACTER_COLUMNS.join(', ')})
       VALUES (${CHARACTER_COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${sets}`,
    ).run(...characterToParams(next), ...characterToParams(next))
    const aliases = replaceAliasesImpl(next.id, next.aliases ?? [])
    return { ...next, aliases }
  }

  return {
    async listByBook(bookId: Id, opts?: { includeArchived?: boolean }): Promise<Character[]> {
      const includeArchived = opts?.includeArchived ?? false
      const sql = includeArchived
        ? `${SELECT_CHARACTER} WHERE book_id = ?`
        : `${SELECT_CHARACTER} WHERE book_id = ? AND is_archived = 0`
      const rows = db.prepare(sql).all(bookId) as CharacterRow[]
      // 别名一次查完再分组（理由见 SELECT_ALIASES_BY_BOOK 的注释）
      const aliasRows = db.prepare(SELECT_ALIASES_BY_BOOK).all(bookId) as Array<{
        character_id: string
        alias: string
      }>
      const byCharacter = new Map<Id, string[]>()
      for (const r of aliasRows) {
        const list = byCharacter.get(r.character_id)
        if (list) list.push(r.alias)
        else byCharacter.set(r.character_id, [r.alias])
      }
      // 排序在 JS 里做：内存实现用的是 `sortOrder` + **`localeCompare`**（按语言规则比较），
      // 而 SQLite 的默认排序是二进制比较 —— 中文名（"张三" vs "李四"）两者结果不同。
      // 为保住「两个实现行为一致」，这里刻意复用同一个比较器而不是交给 `ORDER BY`。
      return rows
        .map((row) => characterFromRow(row, byCharacter.get(row.id) ?? []))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    },

    async get(characterId: Id): Promise<Character | null> {
      const row = db.prepare(`${SELECT_CHARACTER} WHERE id = ?`).get(characterId) as CharacterRow | undefined
      return row ? characterFromRow(row, aliasesOf(characterId)) : null
    },

    async listAliases(bookId: Id): Promise<Array<{ characterId: Id; alias: string }>> {
      const rows = db.prepare(SELECT_ALIASES_BY_BOOK).all(bookId) as Array<{
        character_id: string
        alias: string
      }>
      return rows.map((r) => ({ characterId: r.character_id, alias: r.alias }))
    },

    async upsert(character: Character): Promise<Character> {
      return withTransactionAsync(db, () => upsertImpl(character), { eventPrefix: 'character.tx' })
    },

    async upsertMany(characters: Character[]): Promise<number> {
      if (characters.length === 0) return 0
      // 一个事务（接口注释如此约定）：中途失败不能留下「一半角色写进去了」
      return withTransactionAsync(
        db,
        () => {
          for (const c of characters) upsertImpl(c)
          return characters.length
        },
        { eventPrefix: 'character.tx' },
      )
    },

    async setArchived(characterId: Id, archived: boolean): Promise<Character> {
      const r = db
        .prepare(`UPDATE characters SET is_archived = ?, updated_at = ? WHERE id = ?`)
        .run(archived ? 1 : 0, now(), characterId) as { changes?: number }
      if ((r.changes ?? 0) === 0) {
        throw new AppError('NOT_FOUND', { details: { entity: 'character', characterId } })
      }
      const row = db.prepare(`${SELECT_CHARACTER} WHERE id = ?`).get(characterId) as CharacterRow
      return characterFromRow(row)
    },

    async upsertCentroid(record: CharacterCentroidRecord): Promise<void> {
      // `centroid` 一律由 sum+count 重新推导（不采信调用方）——见文件头第 3 条
      const acc = accumulatorFrom(record.sumVector, record.sampleCount)
      const derived = accumulatorCentroid(acc)
      db.prepare(
        `INSERT INTO character_centroids (character_id, model_id, dim, sum_vector, sample_count, centroid, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(character_id, model_id) DO UPDATE SET
           dim = excluded.dim, sum_vector = excluded.sum_vector, sample_count = excluded.sample_count,
           centroid = excluded.centroid, updated_at = excluded.updated_at`,
      ).run(
        record.characterId,
        record.modelId,
        acc.dim,
        vectorToBlob(derived.sumVector),
        derived.sampleCount,
        vectorToBlob(derived.centroid),
        record.updatedAt || now(),
      )
    },

    async getCentroid(characterId: Id, modelId: string): Promise<CharacterCentroidRecord | null> {
      const row = db
        .prepare(
          `SELECT character_id, model_id, dim, sum_vector, sample_count, centroid, updated_at
             FROM character_centroids WHERE character_id = ? AND model_id = ?`,
        )
        .get(characterId, modelId) as CentroidRow | undefined
      return row ? centroidFromRow(row) : null
    },

    async listCentroids(bookId: Id, modelId?: string): Promise<CharacterCentroidRecord[]> {
      // 归档角色的原型不参与判定（内存实现同款过滤）
      const rows = db
        .prepare(
          `SELECT k.character_id, k.model_id, k.dim, k.sum_vector, k.sample_count, k.centroid, k.updated_at
             FROM character_centroids k
             JOIN characters c ON c.id = k.character_id
            WHERE c.book_id = ? AND c.is_archived = 0 ${modelId ? 'AND k.model_id = ?' : ''}`,
        )
        .all(...(modelId ? [bookId, modelId] : [bookId])) as CentroidRow[]
      return rows.map(centroidFromRow)
    },

    async deleteCentroidsByModel(modelId: string): Promise<number> {
      const r = db.prepare(`DELETE FROM character_centroids WHERE model_id = ?`).run(modelId) as {
        changes?: number
      }
      return r.changes ?? 0
    },
  }
}

interface CentroidRow {
  character_id: string
  model_id: string
  dim: number
  sum_vector: Uint8Array
  sample_count: number
  centroid: Uint8Array
  updated_at: number
}

function centroidFromRow(row: CentroidRow): CharacterCentroidRecord {
  return {
    characterId: row.character_id,
    modelId: row.model_id,
    dim: row.dim,
    sumVector: blobToVector(row.sum_vector),
    sampleCount: row.sample_count,
    centroid: blobToVector(row.centroid),
    updatedAt: row.updated_at,
  }
}
