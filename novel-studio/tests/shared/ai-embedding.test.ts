/**
 * Novel Studio · 向量层测试（docs/06 §4、§5.5、§7.1、§10）
 * ============================================================================
 * 运行：
 *   node --experimental-strip-types tests/shared/ai-embedding.test.ts
 *
 * 本文件守护：
 *   · 确定性伪向量：已 L2 归一化、同文本同向量、不同文本不同向量、维度正确
 *   · 归一化（NFKC / 大小写 / 空白压缩）确实生效
 *   · 批量与单条结果一致（docs/06 §10 Embedding 一致性）
 *   · 向量缓存：`sha256(modelId + '|' + text)` 命中，**第二次不重算**；批内去重
 *   · 换模型后维度不一致必须显式失败（向量空间不可比，docs/06 §5.5）
 *   · ONNX 骨架：输入名解析、int64 必须 BigInt64Array、批大小 16→8→4→1 降级、
 *     OOM 耗尽抛 MODEL_OOM —— 以及「本环境不实现推理，绝不伪造向量」
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { isAppError } from '../../src/shared/errors.ts'
import {
  createDeterministicEmbeddingProvider,
  deterministicEmbed,
  dotSimilarity,
  fnv1a32,
  isL2Normalized,
  normalizeForEmbedding,
} from '../../src/shared/ai/embedding/deterministic.ts'
import {
  createCachingEmbeddingProvider,
  createMemoryEmbeddingCache,
  float32FromBase64,
  float32FromBase64LE,
  float32ToBase64,
  float32ToBase64LE,
} from '../../src/shared/ai/embedding/cache.ts'
import {
  BATCH_DOWNGRADE_SEQUENCE,
  buildFeeds,
  createOnnxEmbeddingProvider,
  isOomError,
  l2NormalizeInPlace,
  nextBatchSizeOnOom,
  poolCls,
  resolveInputNames,
  runBatchesWithOomDowngrade,
  toInt64Data,
  validateEmbeddingOutput,
} from '../../src/shared/ai/embedding/onnx-provider.ts'
import { computeEmbeddingContentHash } from '../../src/shared/ai/usage.ts'

const A = '我萧炎，从来不会认输。'
const B = '他缓缓抬起头，眼中闪过一丝狠厉。'

function cosine(a: Float32Array, b: Float32Array): number {
  return dotSimilarity(a, b)
}

// ---------------------------------------------------------------------------
// 确定性伪向量
// ---------------------------------------------------------------------------

describe('确定性伪向量 Provider（仅测试用，无语义能力）', () => {
  it('向量维度正确且已 L2 归一化', async () => {
    for (const dim of [8, 64, 512]) {
      const p = createDeterministicEmbeddingProvider({ modelId: `fake-${dim}`, dim })
      const [v] = await p.embed([A])
      assert.equal(v.length, dim, `维度应为 ${dim}`)
      assert.equal(v instanceof Float32Array, true)
      assert.equal(isL2Normalized(v), true, `dim=${dim} 的向量未归一化`)
    }
  })

  it('同文本任意次调用得到逐位相同的向量', async () => {
    const p = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 })
    const [v1] = await p.embed([A])
    const [v2] = await p.embed([A])
    assert.deepEqual([...v1], [...v2])
    // 纯函数版本也应一致
    assert.deepEqual([...deterministicEmbed(A, { modelId: 'fake', dim: 64 })], [...v1])
  })

  it('批量结果与单条结果一致（上下文不污染，docs/06 §10）', async () => {
    const p = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 })
    const single = (await p.embed([A]))[0]
    const [batched] = await p.embed([A, B])
    assert.deepEqual([...single], [...batched])
  })

  it('不同文本得到不同向量（余弦明显小于 1）', async () => {
    const p = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 128 })
    const [va, vb] = await p.embed([A, B])
    assert.notDeepEqual([...va], [...vb])
    assert.ok(cosine(va, vb) < 0.99, `不同文本的余弦 ${cosine(va, vb)} 过高`)
  })

  it('自身余弦恒为 1（归一化正确性的直接证据）', async () => {
    const p = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 })
    const [v] = await p.embed([A])
    assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6)
  })

  it('归一化生效：全角与半角、大小写、连续空白都归一到同一向量', async () => {
    const p = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 })
    assert.equal(normalizeForEmbedding('ＡＢＣ'), 'abc')
    assert.equal(normalizeForEmbedding('我   不   去'), '我 不 去')
    const [full] = await p.embed(['ＡＢＣ'])
    const [half] = await p.embed(['abc'])
    assert.deepEqual([...full], [...half])
    const [spaced] = await p.embed(['我   不   去'])
    const [single] = await p.embed(['我 不 去'])
    assert.deepEqual([...spaced], [...single])
  })

  it('空文本/全空白也会得到范数为 1 的确定性向量（不产生 NaN）', async () => {
    const p = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 16 })
    const [empty] = await p.embed([''])
    const [blank] = await p.embed(['   '])
    assert.equal(isL2Normalized(empty), true)
    assert.equal(isL2Normalized(blank), true)
    assert.equal(empty.every((x) => Number.isFinite(x)), true)
  })

  it('healthCheck 明确写出「仅测试用、无语义能力」', async () => {
    const st = await createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 32 }).healthCheck()
    assert.equal(st.ok, true)
    assert.match(st.message, /仅测试用/)
    assert.match(st.message, /无任何语义能力/)
  })

  it('fnv1a32 是确定性的 32 位无符号整数', () => {
    assert.equal(fnv1a32('abc'), fnv1a32('abc'))
    assert.notEqual(fnv1a32('abc'), fnv1a32('abd'))
    assert.ok(fnv1a32('abc') >= 0 && fnv1a32('abc') <= 0xffffffff)
  })
})

// ---------------------------------------------------------------------------
// 向量缓存
// ---------------------------------------------------------------------------

describe('向量缓存（docs/06 §7.1 / §5.5）', () => {
  it('缓存键就是 sha256(modelId + "|" + text)', () => {
    const store = createMemoryEmbeddingCache()
    const provider = createCachingEmbeddingProvider(
      createDeterministicEmbeddingProvider({ modelId: 'bge-small-zh', dim: 32 }),
      store,
    )
    return provider.embed([A]).then(() => {
      const expected = computeEmbeddingContentHash('bge-small-zh', A)
      assert.deepEqual(store.keys(), [expected])
      assert.match(expected, /^[0-9a-f]{64}$/)
    })
  })

  it('第二次请求同一文本直接命中缓存，不重新计算', async () => {
    const inner = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 })
    const cached = createCachingEmbeddingProvider(inner, createMemoryEmbeddingCache())

    const first = await cached.embed([A, B])
    assert.equal(inner.computedCount, 2, '首次应计算 2 条')
    assert.deepEqual(cached.stats(), { hits: 0, misses: 2, computed: 2, byHash: cached.stats().byHash })

    const second = await cached.embed([A, B])
    assert.equal(inner.computedCount, 2, '第二次不应再计算')
    assert.equal(cached.stats().hits, 2)
    assert.equal(cached.stats().misses, 2)
    assert.equal(cached.stats().computed, 2)
    assert.deepEqual([...second[0]], [...first[0]], '命中缓存的向量必须与首次完全一致')
  })

  it('批内去重：同一批里重复文本只算一次', async () => {
    const inner = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 })
    const cached = createCachingEmbeddingProvider(inner, createMemoryEmbeddingCache())
    const out = await cached.embed([A, A, A, B])
    assert.equal(out.length, 4)
    assert.equal(inner.computedCount, 2, '重复文本只应计算一次')
    assert.deepEqual([...out[0]], [...out[2]])
    assert.equal(cached.stats().misses, 4)
    assert.equal(cached.stats().computed, 2)
  })

  it('关掉批内去重后重复文本各算一次', async () => {
    const inner = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 })
    const cached = createCachingEmbeddingProvider(inner, createMemoryEmbeddingCache(), {
      dedupeWithinBatch: false,
    })
    await cached.embed([A, A])
    assert.equal(inner.computedCount, 2)
  })

  it('换模型后缓存键不同，不会误命中旧模型的向量（docs/06 §5.5 向量空间不可比）', async () => {
    const store = createMemoryEmbeddingCache()
    const oldProvider = createCachingEmbeddingProvider(
      createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 }),
      store,
    )
    await oldProvider.embed([A])
    const keyOld = computeEmbeddingContentHash('fake', A)
    const keyNew = computeEmbeddingContentHash('fake-v2', A)
    assert.notEqual(keyOld, keyNew, 'modelId 参与缓存键，换模型必然不命中')

    const newInner = createDeterministicEmbeddingProvider({ modelId: 'fake-v2', dim: 128 })
    const newProvider = createCachingEmbeddingProvider(newInner, store)
    const [v] = await newProvider.embed([A])
    assert.equal(v.length, 128, '应真实重算而不是拿旧模型的 64 维向量')
    assert.equal(newInner.computedCount, 1)
  })

  it('缓存里维度与当前模型不一致时显式失败（INVALID_PAYLOAD），绝不硬用旧向量', async () => {
    // 模拟「line_embeddings 表里混入了别的模型/损坏的行」这种真实脏数据
    const corrupted = {
      get: () => ({
        contentHash: 'x',
        modelId: 'other-model',
        dim: 128,
        vector: new Float32Array(128),
        createdAt: 0,
      }),
      put: () => {},
    }
    const provider = createCachingEmbeddingProvider(
      createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 64 }),
      corrupted,
    )
    await assert.rejects(
      () => provider.embed([A]),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'INVALID_PAYLOAD')
        assert.equal(e.details?.reason, 'embedding-cache-dim-mismatch')
        return true
      },
    )
  })

  it('clearModel 可清空某模型的向量（换模型必须全量重算）', async () => {
    const inner = createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 32 })
    const store = createMemoryEmbeddingCache()
    const cached = createCachingEmbeddingProvider(inner, store)
    await cached.embed([A, B])
    assert.equal(store.size(), 2)
    store.clearModel?.('fake')
    assert.equal(store.size(), 0)
    await cached.embed([A])
    assert.equal(inner.computedCount, 3, '清空后应重新计算')
  })

  it('Float32Array 的 base64 往返（含显式小端版本）', async () => {
    const [v] = await createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 16 }).embed([A])
    const back = float32FromBase64(float32ToBase64(v), 16)
    assert.deepEqual([...back], [...v])
    const backLE = float32FromBase64LE(float32ToBase64LE(v), 16)
    assert.deepEqual([...backLE], [...v])
    assert.throws(
      () => float32FromBase64(float32ToBase64(v), 32),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })
})

// ---------------------------------------------------------------------------
// ONNX 骨架
// ---------------------------------------------------------------------------

describe('ONNX Provider 骨架 · 只做真实可做的那部分', () => {
  it('本环境不实现推理：明确抛 NOT_IMPLEMENTED，绝不返回伪造向量', () => {
    assert.throws(
      () => createOnnxEmbeddingProvider({ modelId: 'bge-small-zh-v1.5', dim: 512, pooling: 'cls' }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'NOT_IMPLEMENTED')
        assert.match(String(e.details?.notes), /BigInt64Array/)
        assert.equal(e.details?.reason, 'onnx-runtime-unavailable')
        return true
      },
    )
  })

  it('输入张量名从 session.inputNames 读；缺必需输入名 → MODEL_LOAD_FAILED', () => {
    assert.deepEqual(resolveInputNames({ inputNames: ['input_ids', 'attention_mask'] }), {
      inputIds: 'input_ids',
      attentionMask: 'attention_mask',
      tokenTypeIds: null,
    })
    assert.equal(
      resolveInputNames({ inputNames: ['input_ids', 'attention_mask', 'token_type_ids'] }).tokenTypeIds,
      'token_type_ids',
    )
    assert.throws(
      () => resolveInputNames({ inputNames: ['input_ids'] }),
      (e: unknown) => isAppError(e) && e.key === 'MODEL_LOAD_FAILED',
    )
  })

  it('int64 张量数据必须是 BigInt64Array（docs/06 §4.2 踩坑 1）', () => {
    const data = toInt64Data([1, 2, 300])
    assert.equal(data instanceof BigInt64Array, true)
    assert.deepEqual([...data].map(Number), [1, 2, 300])
  })

  it('buildFeeds 只在需要时带上 token_type_ids', () => {
    const created: string[] = []
    const tensors = {
      create(type: 'int64' | 'float32', data: BigInt64Array | Float32Array, dims: readonly number[]) {
        created.push(`${type}:${[...dims].join('x')}:${data instanceof BigInt64Array ? 'i64' : 'f32'}`)
        return { type, data, dims }
      },
    }
    const encoded = { inputIds: [1, 2], attentionMask: [1, 1], dims: [1, 2] as const }

    const without = buildFeeds(encoded, resolveInputNames({ inputNames: ['input_ids', 'attention_mask'] }), tensors)
    assert.deepEqual(Object.keys(without), ['input_ids', 'attention_mask'])

    const withType = buildFeeds(
      { ...encoded, tokenTypeIds: [0, 0] },
      resolveInputNames({ inputNames: ['input_ids', 'attention_mask', 'token_type_ids'] }),
      tensors,
    )
    assert.deepEqual(Object.keys(withType), ['input_ids', 'attention_mask', 'token_type_ids'])
    assert.equal(created.every((c) => c.endsWith('i64')), true, 'int64 张量必须用 BigInt64Array')
  })

  it('CLS 池化取第 0 个 token（bge 必须用 CLS，不是 mean）', () => {
    const hidden = new Float32Array([1, 2, 3, 4, 5, 6]) // 2 token × dim3
    assert.deepEqual([...poolCls(hidden, 3, 0)], [1, 2, 3])
    assert.deepEqual([...poolCls(hidden, 3, 1)], [4, 5, 6])
    assert.throws(
      () => poolCls(new Float32Array([1, 2]), 3),
      (e: unknown) => isAppError(e) && e.key === 'MODEL_LOAD_FAILED',
    )
  })

  it('l2NormalizeInPlace 原地归一化且零向量不产生 NaN', () => {
    const v = l2NormalizeInPlace(new Float32Array([3, 4]))
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6)
    assert.ok(Math.abs(v[1] - 0.8) < 1e-6)
    const zero = l2NormalizeInPlace(new Float32Array([0, 0]))
    assert.equal(zero.every((x) => Number.isFinite(x)), true)
  })

  it('批大小 OOM 降级序列固定为 16 → 8 → 4 → 1，再降返回 null', () => {
    assert.deepEqual([...BATCH_DOWNGRADE_SEQUENCE], [16, 8, 4, 1])
    assert.equal(nextBatchSizeOnOom(16), 8)
    assert.equal(nextBatchSizeOnOom(8), 4)
    assert.equal(nextBatchSizeOnOom(4), 1)
    assert.equal(nextBatchSizeOnOom(1), null)
    assert.equal(nextBatchSizeOnOom(64), 16)
  })

  it('isOomError 能识别常见 OOM 文案', () => {
    assert.equal(isOomError(new Error('std::bad_alloc')), true)
    assert.equal(isOomError(new Error('Failed to allocate memory for tensor')), true)
    assert.equal(isOomError(new Error('input name not found')), false)
  })

  it('runBatchesWithOomDowngrade：OOM 时逐级降级，成功即继续', async () => {
    const batchSizes: number[] = []
    const progress: string[] = []
    const vectors = await runBatchesWithOomDowngrade(
      Array.from({ length: 20 }, (_, i) => `line-${i}`),
      async (batch, size) => {
        batchSizes.push(size)
        if (size > 4) {
          const e = new Error('std::bad_alloc: out of memory')
          throw e
        }
        return batch.map(() => new Float32Array([1, 0]))
      },
      { batchSize: 16, onProgress: (_p, stage) => progress.push(`${stage}`) },
    )
    assert.equal(vectors.length, 20)
    assert.deepEqual(batchSizes, [16, 8, 4, 4, 4, 4, 4], '16/8 失败后应以 4 继续，每批 4 条')
    assert.equal(progress.length, 5)
  })

  it('runBatchesWithOomDowngrade：降到 1 仍 OOM → MODEL_OOM', async () => {
    await assert.rejects(
      () =>
        runBatchesWithOomDowngrade(['a', 'b'], async () => {
          throw new Error('std::bad_alloc')
        }, { batchSize: 16 }),
      (e: unknown) => isAppError(e) && e.key === 'MODEL_OOM',
    )
  })

  it('runBatchesWithOomDowngrade：非 OOM 错误直接抛，不无谓降级', async () => {
    await assert.rejects(
      () =>
        runBatchesWithOomDowngrade(['a'], async () => {
          throw new Error('input name not found')
        }, { batchSize: 16 }),
      (e: unknown) => e instanceof Error && /input name not found/.test(e.message),
    )
  })

  it('validateEmbeddingOutput 能查出维度错误与未归一化', async () => {
    const [v] = await createDeterministicEmbeddingProvider({ modelId: 'fake', dim: 8 }).embed([A])
    assert.equal(validateEmbeddingOutput(v, 8).ok, true)
    const wrongDim = validateEmbeddingOutput(v, 16)
    assert.equal(wrongDim.ok, false)
    assert.match(wrongDim.errors.join(''), /维度应为 16/)
    const notNormalized = validateEmbeddingOutput(new Float32Array([2, 0]), 2)
    assert.equal(notNormalized.ok, false)
    assert.match(notNormalized.errors.join(''), /未 L2 归一化/)
  })
})
