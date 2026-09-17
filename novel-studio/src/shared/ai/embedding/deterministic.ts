/**
 * Novel Studio · 确定性伪向量 Provider（**仅用于测试与 Mock**）
 * ============================================================================
 *
 * ⚠⚠ 重要声明：**这不是语义模型。**
 * 它基于「字符 n-gram 哈希」产生伪向量，**没有任何语义能力**：
 *   · 「高兴」与「开心」在这个空间里几乎正交（哈希不同）
 *   · 它只保证「同一段文本 → 同一向量」与「不同文本 → 几乎必然不同向量」
 * 它的唯一用途是：在**没有 ONNX 模型文件、没有网络**的环境下，
 * 让说话人判定链路（docs/06 §5 Step 5）与向量缓存（§7.1）能端到端跑起来并做回归测试。
 *
 * 生产必须用 `onnx-provider.ts` 描述的真实 bge-small-zh-v1.5（512 维，CLS pooling）。
 * 若把这东西接到真实判定上，判定结果毫无意义 —— 属于「假装实现了 AI」，禁止。
 *
 * 设计要点：
 *   · 纯确定性：只用 FNV-1a 32 位哈希，**不引入随机种子、不依赖时间**，
 *     跨进程 / 跨平台 / 跨 Node 版本结果完全一致（测试可断言向量逐位相等）。
 *   · 输出**已 L2 归一化**，因此点积即余弦（docs/06 §5.2 的 cosine 实现直接可用）。
 */

import type { EmbeddingProvider } from '../types.ts'

export interface DeterministicEmbeddingOptions {
  /** 模型标识，会参与 `content_hash`（docs/06 §7.1） */
  modelId: string
  /** 向量维度；测试常用 64/128，真实模型是 512 */
  dim: number
  /** 参与哈希的 n-gram 长度集合，默认 [1,2,3] */
  ngramSizes?: readonly number[]
  /** 是否做 L2 归一化，默认 true（关掉只用于验证归一化逻辑本身） */
  normalize?: boolean
  /** 人为制造延迟（毫秒），用于验证进度/取消；默认 0 */
  latencyMs?: number
  /** 每次真实计算的钩子（测试用它断言缓存是否命中） */
  onCompute?: (texts: readonly string[], result: Float32Array[]) => void
}

/**
 * 文本归一化：NFKC + 小写 + 压缩空白。
 * 归一化是必须的 —— 否则「我 不 去」与「我不去」会得到完全无关的向量，
 * 缓存键（usage.ts computeEmbeddingContentHash 用的是**原文**）与向量会不一致。
 */
export function normalizeForEmbedding(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** FNV-1a 32 位哈希：确定、无依赖、够快 */
export function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // h *= 16777619，用移位加法避免 32 位精度丢失
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

/**
 * 计算确定性伪向量（已 L2 归一化）。
 *
 * 算法：对每个字符 n-gram `g`（n ∈ ngramSizes）
 *   h = fnv1a32(`${n}#${g}`)
 *   idx = h % dim；符号由 h 的高位决定；权重 1/n
 * 累加后整体 L2 归一化。空文本退化为「由内容哈希决定的单位向量」，保证范数为 1。
 */
export function deterministicEmbed(text: string, options: DeterministicEmbeddingOptions): Float32Array {
  const dim = Math.max(1, Math.floor(options.dim))
  const sizes = options.ngramSizes ?? [1, 2, 3]
  const normalized = normalizeForEmbedding(text)
  const v = new Float32Array(dim)

  for (const n of sizes) {
    if (n <= 0) continue
    if (normalized.length < n) continue
    const weight = 1 / n
    for (let i = 0; i + n <= normalized.length; i++) {
      const gram = normalized.slice(i, i + n)
      if (gram.trim() === '') continue
      const h = fnv1a32(`${n}#${gram}`)
      const idx = h % dim
      const sign = (h & 0x8000) !== 0 ? -1 : 1
      v[idx] += sign * weight
    }
  }

  let norm = 0
  for (let i = 0; i < dim; i++) norm += v[i] * v[i]

  if (norm === 0) {
    // 空文本 / 全空白：给一个由内容哈希决定的单位向量（仍保持确定性）
    const idx = fnv1a32(`empty#${normalized}`) % dim
    v[idx] = 1
    norm = 1
  }

  if (options.normalize !== false) {
    const inv = 1 / Math.sqrt(norm)
    for (let i = 0; i < dim; i++) v[i] *= inv
  }
  return v
}

/** 向量是否已 L2 归一化（容差 1e-5，供测试与自检使用） */
export function isL2Normalized(vector: Float32Array, tolerance = 1e-5): boolean {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  return Math.abs(Math.sqrt(sum) - 1) <= tolerance
}

/** 点积（输入已归一化时即为余弦，docs/06 §5.2） */
export function dotSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** 带自检计数的确定性 Provider（计数字段只用于测试断言缓存是否真的命中） */
export interface DeterministicEmbeddingProvider extends EmbeddingProvider {
  /** 累计真正参与计算的文本条数 */
  readonly computedCount: number
}

/**
 * 创建确定性伪向量 Provider。
 *
 * ```ts
 * const emb = createDeterministicEmbeddingProvider({ modelId: 'fake-bge-small', dim: 64 })
 * const [v] = await emb.embed(['我萧炎，从来不会认输。'])
 * ```
 */
export function createDeterministicEmbeddingProvider(
  options: DeterministicEmbeddingOptions,
): DeterministicEmbeddingProvider {
  const modelId = options.modelId
  const dim = Math.max(1, Math.floor(options.dim))
  let computed = 0

  const embedFn = async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    if (signal?.aborted) {
      const err = new Error('向量化已取消')
      err.name = 'AbortError'
      throw err
    }
    if (options.latencyMs && options.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, options.latencyMs))
    }
    const out = texts.map((t) => deterministicEmbed(t, options))
    computed += out.length
    options.onCompute?.(texts, out)
    return out
  }

  return {
    modelId,
    dim,
    embed: embedFn,
    async healthCheck() {
      const [v] = await embedFn(['健康探测'])
      return {
        ok: v.length === dim && isL2Normalized(v),
        message:
          '确定性伪向量 Provider 可用（**仅测试用**，无任何语义能力；生产请使用本地 ONNX 模型）',
      }
    },
    get computedCount(): number {
      return computed
    },
  }
}
