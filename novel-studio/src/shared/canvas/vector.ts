/**
 * Novel Studio · 画本向量基础运算
 * ============================================================================
 * 设计依据：
 *   · docs/06 §5.2  相似度与阈值（归一化后点积即余弦）
 *   · docs/03 §5.2  写入前 L2 归一化、必须记录 model_id / content_hash
 *   · docs/03 §5.3  原型向量的计算与更新（剔除离群 + 重算一次；可逆增量）
 *   · docs/21 §4    character_centroids(sum_vector, sample_count, centroid)
 *
 * 本文件零第三方依赖：只用 Node 内置与本仓库 src/shared/.ts。
 *
 * 三条不变量（全文件共同遵守）：
 *   1. 所有参与比较的向量都必须先 L2 归一化（`l2Normalize`）；`cosine` 对未
 *      归一化的输入有兜底，但兜底比点积慢，属于「防御性正确」而不是常规路径。
 *   2. 所有函数都是纯函数：不修改入参 Float32Array（返回新对象），
 *      这样增量更新可逆、撤销栈可回放（docs/11 §4.8）。
 *   3. 维度不一致一律抛 AppError('INVALID_PAYLOAD')，绝不静默截断
 *      —— 截断会把「换模型后维度变了」这种致命问题藏起来（docs/06 §5.5）。
 */

import { AppError } from '../errors.ts'
import type { Id, SpeakerCandidate } from '../types.ts'

// ============================================================================
// 常量（阈值来源见注释，不要在下游函数里另写魔数）
// ============================================================================

/** 判定「零向量」的模长下限（低于此值没有方向信息） */
export const ZERO_NORM_EPSILON = 1e-8

/** 判定「已经 L2 归一化」的容差：|‖v‖ - 1| ≤ 此值即视为已归一化 */
export const NORMALIZED_TOLERANCE = 1e-3

/** 离群样本剔除阈值：与均值的余弦 < 0.3 视为判定错误的行（docs/03 §5.3） */
export const DEFAULT_OUTLIER_THRESHOLD = 0.3

/** 默认返回的候选数量（docs/11 §4.4：候选列表 Top-3） */
export const DEFAULT_TOP_N = 3

// ============================================================================
// 基础运算
// ============================================================================

/** 维度不一致时的统一异常构造 */
function dimMismatch(op: string, a: number, b: number): AppError {
  return new AppError('INVALID_PAYLOAD', {
    details: { op, dimA: a, dimB: b },
  })
}

function assertSameDim(op: string, a: Float32Array, b: Float32Array): void {
  if (a.length !== b.length) throw dimMismatch(op, a.length, b.length)
  if (a.length === 0) throw new AppError('INVALID_PAYLOAD', { details: { op, reason: 'empty-vector' } })
}

/** 向量模长（L2 范数） */
export function l2Norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

/**
 * L2 归一化，返回**新数组**（不修改入参）。
 *
 * - 零向量（模长 < {@link ZERO_NORM_EPSILON}）原样返回零向量的副本：
 *   调用方拿到后与任何向量做余弦都是 0，不会被误判成「最相似」。
 * - 失败时抛 AppError('INVALID_PAYLOAD')（空向量）。
 */
export function l2Normalize(v: Float32Array): Float32Array {
  if (v.length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'l2Normalize', reason: 'empty-vector' } })
  }
  const n = l2Norm(v)
  const out = new Float32Array(v.length)
  if (n < ZERO_NORM_EPSILON) {
    out.set(v)
    return out
  }
  const inv = 1 / n
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

/** 点积（docs/06 §5.2 的实现；已归一化时它**就是**余弦） */
export function dot(a: Float32Array, b: Float32Array): number {
  assertSameDim('dot', a, b)
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * 余弦相似度。
 *
 * 快路径：两个向量都已 L2 归一化（|‖v‖-1| ≤ {@link NORMALIZED_TOLERANCE}）→ 直接点积。
 * 兜底路径：任一未归一化 → `dot / (‖a‖·‖b‖)`；任一为零向量 → 返回 0
 * （而不是 NaN，NaN 会污染排序与置信度分档）。
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')（维度不一致 / 空向量）。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  assertSameDim('cosine', a, b)

  let s = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    s += x * y
    sa += x * x
    sb += y * y
  }

  const na = Math.sqrt(sa)
  const nb = Math.sqrt(sb)
  if (na < ZERO_NORM_EPSILON || nb < ZERO_NORM_EPSILON) return 0

  const normalizedA = Math.abs(na - 1) <= NORMALIZED_TOLERANCE
  const normalizedB = Math.abs(nb - 1) <= NORMALIZED_TOLERANCE
  if (normalizedA && normalizedB) {
    // 浮点漂移下点积可能略微越界，夹紧到 [-1, 1]，避免置信度 > 1 出现在 UI 上
    return clampUnit(s)
  }
  return clampUnit(s / (na * nb))
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x > 1) return 1
  if (x < -1) return -1
  return x
}

/**
 * 逐维均值。
 *
 * `vectors` 为空、或维度不一致、或存在空向量时抛 AppError('INVALID_PAYLOAD')。
 * 需要「空集合也要有结果」的场景请用 {@link computeCentroid} 并传 `dim`。
 */
export function meanVector(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'meanVector', reason: 'empty-set' } })
  }
  const dim = vectors[0].length
  if (dim === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'meanVector', reason: 'empty-vector' } })
  }
  const acc = new Float32Array(dim)
  for (const v of vectors) {
    if (v.length !== dim) throw dimMismatch('meanVector', dim, v.length)
    for (let i = 0; i < dim; i++) acc[i] += v[i]
  }
  const inv = 1 / vectors.length
  for (let i = 0; i < dim; i++) acc[i] *= inv
  return acc
}

// ============================================================================
// 原型向量（centroid）
// ============================================================================

export interface ComputeCentroidOptions {
  /**
   * 离群剔除阈值：样本与均值的余弦低于此值即剔除（默认 0.3，docs/03 §5.3）。
   * 传 <= -1 或 NaN 表示不剔除。
   */
  outlierThreshold?: number
  /**
   * 输入为空时用于构造零向量的维度。
   * 不传则空输入抛 AppError('INVALID_PAYLOAD')——因为「维度未知的零向量」会让
   * 后续 cosine 直接维度不匹配，不如早点报错。
   */
  dim?: number
}

export interface ComputeCentroidResult {
  /** 已 L2 归一化的原型向量（sampleCount = 0 时为对应维度的零向量） */
  centroid: Float32Array
  /** 实际参与计算的样本数（剔除离群后） */
  sampleCount: number
  /** 被剔除的离群样本数，用于解释「为什么原型和上次不一样」 */
  removedCount: number
  /** 实际生效的离群阈值 */
  outlierThreshold: number
}

/**
 * 计算角色原型向量（docs/03 §5.3）：
 *
 * ```
 * centroid(c) = normalize( mean( normalize(e(line_i)) for line_i ∈ lines(c) ) )
 * ```
 * 并实现「先算均值 → 剔除与均值余弦 < outlierThreshold 的样本（多半是判错的行）
 * → 重算**一次**」的策略（只重算一次，避免迭代剔除把小角色削没）。
 *
 * 细节：
 *   · 每个样本先各自 L2 归一化，因此长句不会因为字多就压过短句。
 *   · 零向量样本直接剔除（无方向信息，留着会把均值拉向原点）。
 *   · 若剔除后为空（极端情况：样本互相都离群），退回「全部样本的均值」并令
 *     `removedCount = 0`，保证函数永不返回无意义的零向量。
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')：空输入且未给 `dim`、维度不一致、空向量。
 */
export function computeCentroid(
  vectors: Float32Array[],
  options?: ComputeCentroidOptions,
): ComputeCentroidResult {
  const threshold = options?.outlierThreshold ?? DEFAULT_OUTLIER_THRESHOLD

  if (vectors.length === 0) {
    const dim = options?.dim
    if (!dim || dim <= 0) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { op: 'computeCentroid', reason: 'empty-set-without-dim' },
      })
    }
    return {
      centroid: new Float32Array(dim),
      sampleCount: 0,
      removedCount: 0,
      outlierThreshold: threshold,
    }
  }

  const normalizeAll = (samples: Float32Array[], op: string): Float32Array[] => {
    const dim = samples[0].length
    const out: Float32Array[] = []
    for (const s of samples) {
      if (s.length !== dim) throw dimMismatch(op, dim, s.length)
      const n = l2Norm(s)
      if (n < ZERO_NORM_EPSILON) continue // 零向量：无方向信息，剔除
      out.push(l2Normalize(s))
    }
    return out
  }

  const samples = normalizeAll(vectors, 'computeCentroid')
  if (samples.length === 0) {
    // 全是零向量：只能给零向量（调用方应把它当作「模型没产出有效向量」处理）
    return {
      centroid: new Float32Array(vectors[0].length),
      sampleCount: 0,
      removedCount: vectors.length,
      outlierThreshold: threshold,
    }
  }

  const mean = meanVector(samples)
  const meanNorm = l2Normalize(mean)

  if (!Number.isFinite(threshold) || threshold <= -1) {
    return {
      centroid: meanNorm,
      sampleCount: samples.length,
      removedCount: 0,
      outlierThreshold: threshold,
    }
  }

  const kept: Float32Array[] = []
  for (const s of samples) {
    if (cosine(s, meanNorm) >= threshold) kept.push(s)
  }

  if (kept.length === 0) {
    // 极端情况（样本两两离群）：不剔除，退回全体均值，保证可解释且非空
    return {
      centroid: meanNorm,
      sampleCount: samples.length,
      removedCount: 0,
      outlierThreshold: threshold,
    }
  }

  return {
    centroid: l2Normalize(meanVector(kept)),
    sampleCount: kept.length,
    removedCount: samples.length - kept.length,
    outlierThreshold: threshold,
  }
}

// ============================================================================
// 可逆增量更新（docs/03 §5.3）
// ============================================================================

/**
 * 可逆累加器：对应 `character_centroids` 的 `sum_vector` + `sample_count`。
 * `sumVector` 存的是**未归一化**的 Σ(已归一化样本)，因此加减法可逆。
 */
export interface CentroidAccumulator {
  dim: number
  /** 未归一化的累加和 Σ(归一化样本) */
  sumVector: Float32Array
  sampleCount: number
}

/** 新建空累加器（全零 sum + count 0） */
export function createAccumulator(dim: number): CentroidAccumulator {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'createAccumulator', dim } })
  }
  return { dim, sumVector: new Float32Array(dim), sampleCount: 0 }
}

/** 从已有 sum_vector + sample_count 还原累加器（例如从 SQLite BLOB 读出后） */
export function accumulatorFrom(
  sumVector: Float32Array,
  sampleCount: number,
): CentroidAccumulator {
  if (sumVector.length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'accumulatorFrom', reason: 'empty-vector' } })
  }
  return { dim: sumVector.length, sumVector: Float32Array.from(sumVector), sampleCount: Math.max(0, sampleCount) }
}

function accumulatorShift(
  acc: CentroidAccumulator,
  vectors: Float32Array[],
  sign: 1 | -1,
  op: string,
): CentroidAccumulator {
  const sum = Float32Array.from(acc.sumVector)
  let count = acc.sampleCount
  for (const v of vectors) {
    if (v.length !== acc.dim) throw dimMismatch(op, acc.dim, v.length)
    const n = l2Norm(v)
    if (n < ZERO_NORM_EPSILON) continue
    const normalized = l2Normalize(v)
    for (let i = 0; i < acc.dim; i++) sum[i] += sign * normalized[i]
    count = Math.max(0, count + sign)
  }
  return { dim: acc.dim, sumVector: sum, sampleCount: count }
}

/** 加入若干样本（返回新累加器，不改入参）。维度不一致抛 AppError('INVALID_PAYLOAD')。 */
export function accumulatorAdd(acc: CentroidAccumulator, vectors: Float32Array[]): CentroidAccumulator {
  return accumulatorShift(acc, vectors, 1, 'accumulatorAdd')
}

/** 减去若干样本（人工改了说话人时把该行向量从旧角色减掉；可逆）。 */
export function accumulatorRemove(acc: CentroidAccumulator, vectors: Float32Array[]): CentroidAccumulator {
  return accumulatorShift(acc, vectors, -1, 'accumulatorRemove')
}

/**
 * 累加器 → 原型向量：`normalize(sum / count)`。
 * `sampleCount < 0` 被夹到 0；count = 0 时返回零向量（调用方应视为「该角色暂无样本」）。
 */
export function accumulatorCentroid(acc: CentroidAccumulator): {
  centroid: Float32Array
  sampleCount: number
  sumVector: Float32Array
} {
  const { sumVector, sampleCount } = acc
  if (sampleCount <= 0) {
    return { centroid: new Float32Array(acc.dim), sampleCount: 0, sumVector: Float32Array.from(sumVector) }
  }
  const mean = new Float32Array(acc.dim)
  const inv = 1 / sampleCount
  for (let i = 0; i < acc.dim; i++) mean[i] = sumVector[i] * inv
  return { centroid: l2Normalize(mean), sampleCount, sumVector: Float32Array.from(sumVector) }
}

export interface IncrementalCentroidDelta {
  /** 新增样本（改到该角色的行） */
  add?: Float32Array[]
  /** 移除样本（从该角色移走的行） */
  remove?: Float32Array[]
}

/**
 * 增量更新原型向量（docs/03 §5.3 的可逆增量）。
 *
 * 与 `computeCentroid(全量样本)` 的结果在浮点容差 1e-5 内一致（见测试），
 * 但代价是 O(δ) 而不是 O(N)——这是「人工改一行说话人」时唯一可接受的成本。
 *
 * 注意：增量更新**不做离群剔除**（剔除需要全量样本）。docs/06 §5.5 规定
 * 「新建/合并角色」类操作走全量重算（{@link computeCentroid}），增量只用于
 * 「单行改派」。
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')（维度不一致 / base 维度与 delta 不一致）。
 */
export function incrementalCentroid(
  base: { sumVector: Float32Array; sampleCount: number } | null,
  delta: IncrementalCentroidDelta,
  options?: { dim?: number },
): { centroid: Float32Array; sampleCount: number; sumVector: Float32Array } {
  const added = delta.add ?? []
  const removed = delta.remove ?? []

  let acc: CentroidAccumulator
  if (base) {
    acc = accumulatorFrom(base.sumVector, base.sampleCount)
  } else {
    const dim = options?.dim ?? added[0]?.length ?? removed[0]?.length ?? 0
    acc = createAccumulator(dim)
  }

  acc = accumulatorAdd(acc, added)
  acc = accumulatorRemove(acc, removed)
  return accumulatorCentroid(acc)
}

// ============================================================================
// 候选排序
// ============================================================================

/** 一个角色的原型向量（从 `character_centroids` JOIN `characters` 得来） */
export interface CentroidEntry {
  characterId: Id
  name: string
  /** 必须已 L2 归一化（写入前归一化是硬约束，docs/03 §5.2） */
  vector: Float32Array
}

/**
 * 对一行向量做「一行 vs N 个角色原型」的余弦排序，返回 Top-N 候选。
 *
 * - 分数降序；同分时按 characterId 稳定排序（保证测试与 UI 可复现）。
 * - 维度不一致的条目**跳过**（换模型后遗留的旧原型不该让整章判定崩掉），
 *   但会体现在返回结果的长度上——调用方可用 `centroids.length` 与结果长度对比。
 * - `topN <= 0` 时返回空数组。
 * - 失败时抛 AppError('INVALID_PAYLOAD')（v 为空向量）。
 */
export function rankCandidates(
  v: Float32Array,
  centroids: CentroidEntry[],
  topN: number = DEFAULT_TOP_N,
): SpeakerCandidate[] {
  if (v.length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'rankCandidates', reason: 'empty-vector' } })
  }
  if (!Number.isFinite(topN) || topN <= 0) return []

  const scored: Array<SpeakerCandidate & { _i: number }> = []
  centroids.forEach((entry, i) => {
    if (entry.vector.length !== v.length) return
    const score = cosine(v, entry.vector)
    if (!Number.isFinite(score)) return
    scored.push({ characterId: entry.characterId, name: entry.name, score, _i: i })
  })

  scored.sort((a, b) => (b.score - a.score) || a.characterId.localeCompare(b.characterId) || (a._i - b._i))

  return scored.slice(0, Math.floor(topN)).map(({ characterId, name, score }) => ({
    characterId,
    name,
    score,
  }))
}
