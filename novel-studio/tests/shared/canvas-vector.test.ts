/**
 * Novel Studio · 画本向量基础运算测试
 * ============================================================================
 * 设计文档：docs/03 §5.2 §5.3、docs/06 §5.2
 *
 * 运行（Node 22.6+ 原生类型剥离，无需任何依赖）：
 *   node --experimental-strip-types tests/shared/canvas-vector.test.ts
 *   （不要用 node --test：受限环境下子进程 spawn 会 EPERM）
 *
 * 守护的不变量：
 *   · 归一化后点积即余弦；未归一化有兜底且结果一致
 *   · 离群样本确实被剔除，且剔除后原型更贴近主流样本
 *   · 增量更新（sum_vector ± 样本）与全量重算在 1e-5 内一致
 *   · 维度不一致必须显式报错，绝不静默截断
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { isAppError } from '../../src/shared/errors.ts'
import {
  DEFAULT_OUTLIER_THRESHOLD,
  accumulatorAdd,
  accumulatorCentroid,
  accumulatorFrom,
  accumulatorRemove,
  computeCentroid,
  cosine,
  createAccumulator,
  dot,
  incrementalCentroid,
  l2Norm,
  l2Normalize,
  meanVector,
  rankCandidates,
  type CentroidEntry,
} from '../../src/shared/canvas/vector.ts'

// ---------------------------------------------------------------------------
// 确定性伪随机（保证测试可复现，不依赖 Math.random）
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成一批确定性向量：以 base 方向为主 + 噪声 */
function makeVectors(count: number, dim: number, seed: number, noise = 0.15): Float32Array[] {
  const rnd = mulberry32(seed)
  const out: Float32Array[] = []
  for (let k = 0; k < count; k++) {
    const v = new Float32Array(dim)
    for (let i = 0; i < dim; i++) v[i] = (rnd() - 0.5) * 2 * noise
    // 主方向：第 0 维给一个稳定偏置，让样本聚在一起
    v[0] += 1
    out.push(l2Normalize(v))
  }
  return out
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  assert.equal(a.length, b.length, '比较的两个向量维度必须一致')
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

// ---------------------------------------------------------------------------
// 归一化与余弦
// ---------------------------------------------------------------------------

describe('向量基础运算：归一化', () => {
  it('归一化后模长为 1，且不修改入参', () => {
    const raw = new Float32Array([3, 4, 0])
    const before = Float32Array.from(raw)
    const n = l2Normalize(raw)
    assert.ok(Math.abs(l2Norm(n) - 1) < 1e-6, '归一化后模长应为 1')
    assert.deepEqual(Array.from(raw), Array.from(before), 'l2Normalize 不得修改入参')
    assert.notEqual(n, raw, '应返回新数组')
  })

  it('零向量原样返回（不做除零），且后续余弦为 0', () => {
    const zero = new Float32Array([0, 0, 0])
    const n = l2Normalize(zero)
    assert.deepEqual(Array.from(n), [0, 0, 0])
    assert.equal(cosine(n, l2Normalize(new Float32Array([1, 2, 3]))), 0)
  })

  it('空向量抛 AppError(INVALID_PAYLOAD)', () => {
    try {
      l2Normalize(new Float32Array(0))
      assert.fail('应当抛错')
    } catch (e) {
      assert.ok(isAppError(e))
      assert.equal(e.key, 'INVALID_PAYLOAD')
    }
  })
})

describe('向量基础运算：余弦', () => {
  it('同向为 1、反向为 -1、正交为 0', () => {
    const a = l2Normalize(new Float32Array([1, 0, 0]))
    assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6, '同向应为 1')
    assert.ok(Math.abs(cosine(a, l2Normalize(new Float32Array([-1, 0, 0]))) + 1) < 1e-6, '反向应为 -1')
    assert.ok(Math.abs(cosine(a, l2Normalize(new Float32Array([0, 1, 0])))) < 1e-6, '正交应为 0')
  })

  it('未归一化输入走兜底路径，结果与归一化后点积一致', () => {
    const rawA = new Float32Array([3, 4, 0])
    const rawB = new Float32Array([6, 8, 0])
    assert.ok(Math.abs(cosine(rawA, rawB) - 1) < 1e-6, '同向未归一化也应为 1')
    assert.ok(Math.abs(dot(l2Normalize(rawA), l2Normalize(rawB)) - cosine(rawA, rawB)) < 1e-6)
  })

  it('零向量参与比较返回 0 而不是 NaN', () => {
    assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 0])), 0)
    assert.ok(Number.isFinite(cosine(new Float32Array([0, 0]), new Float32Array([0, 0]))))
  })

  it('维度不一致抛 AppError(INVALID_PAYLOAD)（绝不静默截断）', () => {
    try {
      cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))
      assert.fail('应当抛错')
    } catch (e) {
      assert.ok(isAppError(e))
      assert.equal(e.key, 'INVALID_PAYLOAD')
      assert.equal((e.details as Record<string, unknown>).dimA, 2)
      assert.equal((e.details as Record<string, unknown>).dimB, 3)
    }
  })
})

describe('向量基础运算：均值', () => {
  it('逐维求平均', () => {
    const m = meanVector([new Float32Array([1, 0]), new Float32Array([0, 1])])
    assert.ok(Math.abs(m[0] - 0.5) < 1e-6 && Math.abs(m[1] - 0.5) < 1e-6)
  })

  it('空集合抛 AppError(INVALID_PAYLOAD)', () => {
    assert.throws(() => meanVector([]), (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD')
  })

  it('样本维度不一致抛 AppError(INVALID_PAYLOAD)', () => {
    assert.throws(
      () => meanVector([new Float32Array([1, 2]), new Float32Array([1, 2, 3])]),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })
})

// ---------------------------------------------------------------------------
// 原型向量：离群剔除
// ---------------------------------------------------------------------------

describe('原型向量：离群剔除（docs/03 §5.3）', () => {
  it('剔除与均值余弦低于阈值的那一条，并重算一次', () => {
    const inliers = makeVectors(10, 8, 42, 0.1) // 同方向的一簇
    const outlier = l2Normalize(new Float32Array([0, 1, 0, 0, 0, 0, 0, 0])) // 正交方向 = 判错的行

    const withOutlier = computeCentroid([...inliers, outlier])
    assert.equal(withOutlier.sampleCount, 10, '应剔掉 1 条离群样本')
    assert.equal(withOutlier.removedCount, 1)
    assert.equal(withOutlier.outlierThreshold, DEFAULT_OUTLIER_THRESHOLD)

    // 剔除后的原型应更贴近主流样本：与离群样本的余弦反而更低
    const fullMean = meanVector([...inliers, outlier].map(l2Normalize))
    const fullCentroid = l2Normalize(fullMean)
    const inlierMean = meanVector(inliers)
    assert.ok(
      cosine(withOutlier.centroid, inlierMean) > cosine(fullCentroid, inlierMean),
      '剔除离群后的原型应更贴近主流方向',
    )
    assert.ok(Math.abs(cosine(withOutlier.centroid, inlierMean) - 1) < 0.01)
  })

  it('样本互相都离群时不剔除到空（退回全体均值）', () => {
    const a = l2Normalize(new Float32Array([1, 0, 0]))
    const b = l2Normalize(new Float32Array([0, 1, 0]))
    const c = l2Normalize(new Float32Array([0, 0, 1]))
    const r = computeCentroid([a, b, c], { outlierThreshold: 0.99 })
    assert.ok(r.sampleCount > 0, '不能返回空原型')
    assert.ok(Math.abs(l2Norm(r.centroid) - 1) < 1e-6, '原型必须已归一化')
  })

  it('threshold <= -1 表示不剔除', () => {
    const inliers = makeVectors(5, 4, 7)
    const outlier = l2Normalize(new Float32Array([0, 1, 0, 0]))
    const r = computeCentroid([...inliers, outlier], { outlierThreshold: -1 })
    assert.equal(r.sampleCount, 6)
    assert.equal(r.removedCount, 0)
  })

  it('空输入 + 指定 dim 返回零向量；未指定 dim 则抛错', () => {
    const r = computeCentroid([], { dim: 8 })
    assert.equal(r.sampleCount, 0)
    assert.equal(r.centroid.length, 8)
    assert.throws(() => computeCentroid([]), (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD')
  })
})

// ---------------------------------------------------------------------------
// 增量更新
// ---------------------------------------------------------------------------

describe('原型向量：可逆增量更新与全量重算一致', () => {
  const dim = 12
  const all = makeVectors(20, dim, 2024, 0.2)

  it('先累加 15 条再加 5 条 == 全量重算 20 条（容差 1e-5）', () => {
    const full = computeCentroid(all, { outlierThreshold: -1 })

    let acc = createAccumulator(dim)
    acc = accumulatorAdd(acc, all.slice(0, 15))
    const partial = accumulatorCentroid(acc)
    const incremental = incrementalCentroid(
      { sumVector: partial.sumVector, sampleCount: partial.sampleCount },
      { add: all.slice(15) },
    )

    assert.equal(incremental.sampleCount, 20)
    assert.ok(
      maxAbsDiff(incremental.centroid, full.centroid) < 1e-5,
      `增量与全量原型不一致：${maxAbsDiff(incremental.centroid, full.centroid)}`,
    )
  })

  it('累加 20 条再减掉 5 条 == 全量重算前 15 条（可逆）', () => {
    const full15 = computeCentroid(all.slice(0, 15), { outlierThreshold: -1 })

    let acc = createAccumulator(dim)
    acc = accumulatorAdd(acc, all)
    acc = accumulatorRemove(acc, all.slice(15))
    const r = accumulatorCentroid(acc)

    assert.equal(r.sampleCount, 15)
    assert.ok(maxAbsDiff(r.centroid, full15.centroid) < 1e-5)
  })

  it('加一条再减同一条可完全还原 sum_vector / count', () => {
    const base = accumulatorAdd(createAccumulator(dim), all.slice(0, 3))
    const after = accumulatorRemove(accumulatorAdd(base, [all[7]]), [all[7]])
    assert.equal(after.sampleCount, base.sampleCount)
    assert.ok(maxAbsDiff(after.sumVector, base.sumVector) < 1e-6)
  })

  it('base 为 null 时从 delta 推断维度；维度冲突抛 AppError(INVALID_PAYLOAD)', () => {
    const fresh = incrementalCentroid(null, { add: [all[0]] })
    assert.equal(fresh.sampleCount, 1)
    assert.equal(fresh.centroid.length, dim)
    assert.throws(
      () => incrementalCentroid(null, { add: [all[0], new Float32Array(dim + 1)] }),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })

  it('accumulatorFrom 还原后可继续增量（模拟从 SQLite 读回 sum_vector）', () => {
    const acc = accumulatorAdd(createAccumulator(dim), all.slice(0, 10))
    const restored = accumulatorFrom(acc.sumVector, acc.sampleCount)
    const next = accumulatorAdd(restored, all.slice(10))
    const full = computeCentroid(all, { outlierThreshold: -1 })
    assert.ok(maxAbsDiff(accumulatorCentroid(next).centroid, full.centroid) < 1e-5)
  })
})

// ---------------------------------------------------------------------------
// 候选排序
// ---------------------------------------------------------------------------

describe('候选排序', () => {
  const centroids: CentroidEntry[] = [
    { characterId: 'c-yan', name: '萧炎', vector: l2Normalize(new Float32Array([1, 0.1, 0, 0])) },
    { characterId: 'c-yao', name: '药老', vector: l2Normalize(new Float32Array([0.1, 1, 0, 0])) },
    { characterId: 'c-mei', name: '美杜莎', vector: l2Normalize(new Float32Array([0, 0, 1, 0.1])) },
  ]

  it('按分数降序并只取 topN', () => {
    const q = l2Normalize(new Float32Array([1, 0.05, 0, 0]))
    const all = rankCandidates(q, centroids, 3)
    assert.equal(all.length, 3)
    assert.equal(all[0].characterId, 'c-yan')
    assert.ok(all[0].score > all[1].score && all[1].score > all[2].score, '必须降序')
    const top1 = rankCandidates(q, centroids, 1)
    assert.equal(top1.length, 1)
    assert.equal(top1[0].name, '萧炎')
  })

  it('维度不一致的条目被跳过而不是抛错（换模型后的旧原型）', () => {
    const dirty: CentroidEntry[] = [
      ...centroids,
      { characterId: 'c-stale', name: '旧模型角色', vector: new Float32Array(8) },
    ]
    const r = rankCandidates(l2Normalize(new Float32Array([1, 0, 0, 0])), dirty, 5)
    assert.equal(r.length, 3)
    assert.ok(!r.some((c) => c.characterId === 'c-stale'))
  })

  it('topN <= 0 返回空；空查询向量抛 AppError(INVALID_PAYLOAD)', () => {
    assert.deepEqual(rankCandidates(l2Normalize(new Float32Array([1, 0, 0, 0])), centroids, 0), [])
    assert.throws(
      () => rankCandidates(new Float32Array(0), centroids, 3),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })
})
