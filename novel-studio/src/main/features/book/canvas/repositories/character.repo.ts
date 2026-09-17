/**
 * Novel Studio · 角色与原型向量仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §4   characters / character_voice_bindings / character_centroids
 *   · docs/03 §5.3 原型向量：sum_vector + sample_count 支持可逆增量
 *   · docs/03 §5.2 必须记录 model_id（换模型 = 全部重算）
 *   · docs/11 §4.6 角色禁止物理删除，只允许归档
 *
 * 生产实现（`createSqliteCharacterRepo(db)`）落在同目录；本文件给出接口 + 内存实现，
 * 内存实现精确复刻「按 model_id 分空间」与「归档不删除」两条语义。
 *
 * 零第三方依赖。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { Character, Id, Timestamp } from '../../../../../shared/types.ts'
import { accumulatorCentroid, accumulatorFrom } from '../../../../../shared/canvas/vector.ts'

// ============================================================================
// 类型
// ============================================================================

/** 角色原型向量记录（对应 character_centroids 一行，docs/21 §4） */
export interface CharacterCentroidRecord {
  characterId: Id
  modelId: string
  dim: number
  /** 未归一化的 Σ(归一化行向量)：支持可逆增量（docs/03 §5.3） */
  sumVector: Float32Array
  sampleCount: number
  /** 归一化后的 sum/count：读取时直接用 */
  centroid: Float32Array
  updatedAt: Timestamp
}

export interface CharacterRepo {
  listByBook(bookId: Id, opts?: { includeArchived?: boolean }): Promise<Character[]>
  get(characterId: Id): Promise<Character | null>
  /** 插入或更新（按 id） */
  upsert(character: Character): Promise<Character>
  /** 批量写入（一个事务） */
  upsertMany(characters: Character[]): Promise<number>
  /** 归档/恢复（禁止物理删除，docs/11 §4.6） */
  setArchived(characterId: Id, archived: boolean): Promise<Character>
  /** 记录某角色的原型向量（按 characterId + modelId 唯一） */
  upsertCentroid(record: CharacterCentroidRecord): Promise<void>
  getCentroid(characterId: Id, modelId: string): Promise<CharacterCentroidRecord | null>
  listCentroids(bookId: Id, modelId?: string): Promise<CharacterCentroidRecord[]>
  /** 换模型时清掉旧空间的原型（docs/06 §5.5：向量空间不可比） */
  deleteCentroidsByModel(modelId: string): Promise<number>
}

// ============================================================================
// 内存实现
// ============================================================================

/** 创建内存角色仓储（供测试与演示） */
export function createMemoryCharacterRepo(seed?: {
  characters?: Character[]
  centroids?: CharacterCentroidRecord[]
  now?: () => Timestamp
}): CharacterRepo {
  const characters = new Map<Id, Character>()
  const centroids = new Map<string, CharacterCentroidRecord>()
  const now = seed?.now ?? (() => Date.now())
  const key = (characterId: Id, modelId: string): string => `${characterId}::${modelId}`

  for (const c of seed?.characters ?? []) characters.set(c.id, cloneCharacter(c))
  for (const r of seed?.centroids ?? []) centroids.set(key(r.characterId, r.modelId), cloneCentroid(r))

  return {
    async listByBook(bookId, opts) {
      const includeArchived = opts?.includeArchived ?? false
      return [...characters.values()]
        .filter((c) => c.bookId === bookId && (includeArchived || !c.isArchived))
        .map(cloneCharacter)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    },

    async get(characterId) {
      const c = characters.get(characterId)
      return c ? cloneCharacter(c) : null
    },

    async upsert(character) {
      const exists = characters.get(character.id)
      const next: Character = {
        ...cloneCharacter(character),
        createdAt: exists?.createdAt ?? character.createdAt ?? now(),
        updatedAt: now(),
      }
      characters.set(next.id, next)
      return cloneCharacter(next)
    },

    async upsertMany(incoming) {
      for (const c of incoming) {
        const exists = characters.get(c.id)
        characters.set(c.id, {
          ...cloneCharacter(c),
          createdAt: exists?.createdAt ?? c.createdAt ?? now(),
          updatedAt: now(),
        })
      }
      return incoming.length
    },

    async setArchived(characterId, archived) {
      const c = characters.get(characterId)
      if (!c) throw new AppError('NOT_FOUND', { details: { entity: 'character', characterId } })
      c.isArchived = archived
      c.updatedAt = now()
      return cloneCharacter(c)
    },

    async upsertCentroid(record) {
      const acc = accumulatorFrom(record.sumVector, record.sampleCount)
      const derived = accumulatorCentroid(acc)
      centroids.set(key(record.characterId, record.modelId), {
        ...cloneCentroid(record),
        dim: acc.dim,
        sampleCount: derived.sampleCount,
        centroid: derived.centroid,
        updatedAt: record.updatedAt || now(),
      })
    },

    async getCentroid(characterId, modelId) {
      const r = centroids.get(key(characterId, modelId))
      return r ? cloneCentroid(r) : null
    },

    async listCentroids(bookId, modelId) {
      const out: CharacterCentroidRecord[] = []
      for (const r of centroids.values()) {
        if (modelId && r.modelId !== modelId) continue
        const c = characters.get(r.characterId)
        if (!c || c.bookId !== bookId || c.isArchived) continue
        out.push(cloneCentroid(r))
      }
      return out
    },

    async deleteCentroidsByModel(modelId) {
      let n = 0
      for (const [k, r] of centroids) {
        if (r.modelId === modelId) {
          centroids.delete(k)
          n++
        }
      }
      return n
    },
  }
}

function cloneCharacter(c: Character): Character {
  return { ...c, aliases: [...c.aliases] }
}

function cloneCentroid(r: CharacterCentroidRecord): CharacterCentroidRecord {
  return {
    ...r,
    sumVector: Float32Array.from(r.sumVector),
    centroid: Float32Array.from(r.centroid),
  }
}

/** 便捷构造：直接从已确认的行向量批量计算某角色的原型（全量重算，docs/03 §5.3） */
export function buildCentroidRecord(input: {
  characterId: Id
  modelId: string
  sumVector: Float32Array
  sampleCount: number
  now?: Timestamp
}): CharacterCentroidRecord {
  const acc = accumulatorFrom(input.sumVector, input.sampleCount)
  const derived = accumulatorCentroid(acc)
  return {
    characterId: input.characterId,
    modelId: input.modelId,
    dim: acc.dim,
    sumVector: derived.sumVector,
    sampleCount: derived.sampleCount,
    centroid: derived.centroid,
    updatedAt: input.now ?? Date.now(),
  }
}
