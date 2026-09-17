/**
 * Novel Studio · 向量缓存（docs/06 §7.1）
 * ============================================================================
 * 设计依据：
 *   · docs/06 §7.1  Embedding 缓存键 = `sha256(modelId + '|' + text)`，
 *                   命中走 `line_embeddings`（按 content_hash）
 *   · docs/06 §5.5  「文本被人工编辑 → content_hash 变化 → 该行向量作废 → **仅重算该行**」；
 *                   「换 embedding 模型 → **全项目重算**（向量空间不可比）」
 *   · docs/06 §5.5  「调阈值只需重跑判定，不需要重新 embedding（向量复用是关键优化）」
 *
 * 本文件只做「按 content_hash 命中」这一件事，不含任何判定逻辑。
 * 存储是注入式的：生产走 SQLite 的 `line_embeddings` 表；测试用 `createMemoryEmbeddingCache()`。
 */

import { AppError } from '../../errors.ts'
import { computeEmbeddingContentHash } from '../usage.ts'
import type { EmbeddingProvider } from '../types.ts'

export interface EmbeddingCacheRecord {
  /** `sha256(modelId + '|' + text)` */
  contentHash: string
  modelId: string
  dim: number
  vector: Float32Array
  createdAt: number
}

export interface EmbeddingCacheStore {
  get(contentHash: string): EmbeddingCacheRecord | null | undefined
  put(record: EmbeddingCacheRecord): void
  /** 清空某个模型的全部向量（换模型时必须调用；docs/06 §5.5） */
  clearModel?(modelId: string): void | Promise<void>
}

export interface MemoryEmbeddingCacheOptions {
  now?: () => number
  maxEntries?: number
}

/** 内存版向量缓存（测试 / 单次任务内的会话缓存） */
export function createMemoryEmbeddingCache(
  options: MemoryEmbeddingCacheOptions = {},
): EmbeddingCacheStore & { size(): number; keys(): string[] } {
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries ?? 200_000
  const map = new Map<string, EmbeddingCacheRecord>()

  return {
    get(contentHash) {
      return map.get(contentHash) ?? null
    },
    put(record) {
      if (map.size >= maxEntries && !map.has(record.contentHash)) {
        const first = map.keys().next()
        if (!first.done) map.delete(first.value)
      }
      map.set(record.contentHash, { ...record, createdAt: record.createdAt || now() })
    },
    clearModel(modelId) {
      for (const [k, v] of map) if (v.modelId === modelId) map.delete(k)
    },
    size: () => map.size,
    keys: () => [...map.keys()],
  }
}

// ============================================================================
// 二进制编解码（可直接落 SQLite BLOB）
// ============================================================================

/** Float32Array → base64（宿主字节序；同平台读写一致即可） */
export function float32ToBase64(vector: Float32Array): string {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)).toString('base64')
}

export function float32FromBase64(text: string, dim?: number): Float32Array {
  const buf = Buffer.from(text, 'base64')
  const out = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  assertDim(out, dim)
  return out
}

/** 显式小端序：跨平台迁移/备份场景用（Float32Array 本身跟随宿主字节序） */
export function float32ToBase64LE(vector: Float32Array): string {
  const buf = Buffer.alloc(vector.length * 4)
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4)
  return buf.toString('base64')
}

export function float32FromBase64LE(text: string, dim?: number): Float32Array {
  const buf = Buffer.from(text, 'base64')
  const out = new Float32Array(Math.floor(buf.length / 4))
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  assertDim(out, dim)
  return out
}

function assertDim(vector: Float32Array, dim?: number): void {
  if (dim !== undefined && vector.length !== dim) {
    throw new AppError('INVALID_PAYLOAD', {
      details: { reason: 'embedding-dim-mismatch', expected: dim, actual: vector.length },
    })
  }
}

// ============================================================================
// 缓存包装层
// ============================================================================

export interface EmbeddingCacheStats {
  hits: number
  misses: number
  /** 实际送去计算的文本数（= misses - 批内重复数） */
  computed: number
  /** contentHash → 出现次数（**只存哈希不存文本**，避免把作品正文留在统计结构里） */
  byHash: Map<string, number>
}

export interface CachingEmbeddingOptions {
  now?: () => number
  /** 命中/未命中统计回调（埋点用；只有数字，没有文本 —— docs/06 §9） */
  onStats?: (stats: EmbeddingCacheStats) => void
  /**
   * 批内去重（默认 true）。同一批里出现重复文本只算一次 ——
   * 章节里重复台词很常见，这是白捡的加速。
   */
  dedupeWithinBatch?: boolean
}

export type CachingEmbeddingProvider = EmbeddingProvider & {
  stats(): EmbeddingCacheStats
  resetStats(): void
}

/**
 * 给任意 `EmbeddingProvider` 套上「按 content_hash 命中」的缓存层。
 *
 * ```ts
 * const cached = createCachingEmbeddingProvider(inner, createMemoryEmbeddingCache())
 * await cached.embed(['第一句', '第一句'])   // 只算 1 次
 * await cached.embed(['第一句'])            // 直接命中，0 次计算
 * ```
 *
 * @throws `INVALID_PAYLOAD` 缓存里的向量维度与当前模型不一致
 *         —— 这是「换了模型但没清缓存」的典型症状，必须显式失败而不是硬用旧向量（docs/06 §5.5）
 */
export function createCachingEmbeddingProvider(
  inner: EmbeddingProvider,
  store: EmbeddingCacheStore,
  options: CachingEmbeddingOptions = {},
): CachingEmbeddingProvider {
  const now = options.now ?? Date.now
  const dedupe = options.dedupeWithinBatch !== false
  let stats: EmbeddingCacheStats = { hits: 0, misses: 0, computed: 0, byHash: new Map() }

  const embedFn = async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    if (signal?.aborted) {
      const err = new Error('向量化已取消')
      err.name = 'AbortError'
      throw err
    }

    const out: Array<Float32Array | null> = new Array(texts.length).fill(null)
    /** 本批需要计算的项：hash + 该 hash 覆盖的所有下标 */
    const pending: Array<{ text: string; hash: string; indices: number[] }> = []
    const pendingIndexByHash = new Map<string, number>()

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]
      const hash = computeEmbeddingContentHash(inner.modelId, text)
      stats.byHash.set(hash, (stats.byHash.get(hash) ?? 0) + 1)

      const cached = store.get(hash)
      if (cached) {
        if (cached.dim !== inner.dim || cached.vector.length !== inner.dim) {
          throw new AppError('INVALID_PAYLOAD', {
            details: {
              reason: 'embedding-cache-dim-mismatch',
              cachedModel: cached.modelId,
              cachedDim: cached.dim,
              currentModel: inner.modelId,
              currentDim: inner.dim,
            },
          })
        }
        out[i] = cached.vector
        stats.hits++
        continue
      }

      stats.misses++
      const existing = dedupe ? pendingIndexByHash.get(hash) : undefined
      if (existing !== undefined) {
        pending[existing].indices.push(i)
      } else {
        pendingIndexByHash.set(hash, pending.length)
        pending.push({ text, hash, indices: [i] })
      }
    }

    if (pending.length > 0) {
      const vectors = await inner.embed(pending.map((p) => p.text), signal)
      if (vectors.length !== pending.length) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { reason: 'embedding-count-mismatch', requested: pending.length, returned: vectors.length },
        })
      }
      stats.computed += vectors.length

      pending.forEach((item, idx) => {
        const vector = vectors[idx]
        if (!vector || vector.length !== inner.dim) {
          throw new AppError('INVALID_PAYLOAD', {
            details: { reason: 'embedding-dim-mismatch', expected: inner.dim, actual: vector?.length ?? 0 },
          })
        }
        for (const i of item.indices) out[i] = vector
        store.put({
          contentHash: item.hash,
          modelId: inner.modelId,
          dim: inner.dim,
          vector,
          createdAt: now(),
        })
      })
    }

    options.onStats?.(stats)
    return out as Float32Array[]
  }

  return {
    modelId: inner.modelId,
    dim: inner.dim,
    embed: embedFn,
    healthCheck: () => inner.healthCheck(),
    stats: () => stats,
    resetStats: () => {
      stats = { hits: 0, misses: 0, computed: 0, byHash: new Map() }
    },
  }
}
