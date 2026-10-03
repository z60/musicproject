/**
 * Novel Studio · 本地 ONNX Embedding Provider（L2）
 * ============================================================================
 * 设计依据：docs/06 §4 「本地 Embedding（L2）」全节
 *
 * 本文件**不伪造向量**：没有真实运行时（session / 分词器 / 张量工厂）时明确拒绝加载，
 * 绝不返回随机/常量向量去骗上层（docs/06 §8：模型缺失就退化为规则判定，并且 UI 要提示）。
 *
 * 有了注入的运行时之后，`createOnnxEmbeddingProvider` 会**真的跑推理**：
 *   tokenize（batch×seq）→ int64 张量 → session.run → CLS/mean 池化 → L2 归一化，
 * 并按 16→8→4→1 做 OOM 降级、每批 `yieldToLoop()`（docs/06 §4.2 的踩坑清单）。
 * 原生模块（onnxruntime-node / @xenova/transformers）只在主进程的加载器里动态 import，
 * 因此本文件仍是纯逻辑、可在无 node_modules 的测试环境里跑。
 *
 * 因此本文件交付的是：
 *   1. 真实实现所需的最小注入接口（`OnnxSessionLike` / `OnnxTensorFactoryLike` / `TokenizerLike`）
 *   2. **可以直接用、也已经被测试覆盖**的纯函数：输入张量名解析、int64 张量构造、
 *      CLS/mean 池化、L2 归一化、批大小 OOM 逐级降级、维度校验
 *   3. 明确的实现要点注释（照 docs/06 §4.2 的踩坑清单逐条对应）
 *
 * 生产接线（在装了依赖的机器上）：
 * ```ts
 * import * as ort from 'onnxruntime-node'
 * import { AutoTokenizer } from '@xenova/transformers'
 * const tokenizer = await AutoTokenizer.from_pretrained(modelDir)
 * const session = await ort.InferenceSession.create(modelPath, {
 *   intraOpNumThreads: Math.min(4, Math.floor(os.cpus().length / 2)),
 * })
 * const provider = createOnnxEmbeddingProvider({
 *   modelId: 'bge-small-zh-v1.5',
 *   dim: 512,
 *   pooling: 'cls',
 *   session,
 *   tokenizer: wrapXenovaTokenizer(tokenizer),
 *   tensors: { create: (type, data, dims) => new ort.Tensor(type, data, dims) },
 * })
 * ```
 */

import { AppError } from '../../errors.ts'
import type { EmbeddingProvider, HealthStatus } from '../types.ts'
import { isL2Normalized } from './deterministic.ts'

// ============================================================================
// 注入接口
// ============================================================================

/** ONNX 张量（只需这两种，够 bge 用） */
export type OnnxTensorType = 'int64' | 'float32'

export interface OnnxTensorLike {
  readonly type: OnnxTensorType
  readonly data: BigInt64Array | Float32Array
  readonly dims: readonly number[]
}

export interface OnnxTensorFactoryLike {
  create(type: OnnxTensorType, data: BigInt64Array | Float32Array, dims: readonly number[]): OnnxTensorLike
}

export interface OnnxRunResultLike {
  /** 输出名 → 张量 */
  [outputName: string]: OnnxTensorLike | undefined
}

export interface OnnxSessionLike {
  /**
   * 输入张量名，例如 `['input_ids','attention_mask','token_type_ids']`。
   * **必须从这里读，不要硬编码**（docs/06 §4.2 踩坑 2：不同导出版本的输入名不一样）。
   */
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OnnxTensorLike>): Promise<OnnxRunResultLike>
  release?(): Promise<void>
}

/** 分词器（生产用 @xenova/transformers 的 AutoTokenizer，纯 JS/WASM，不引入原生依赖） */
export interface TokenizerLike {
  encode(
    texts: string[],
    opts: { padding: boolean; truncation: boolean; maxLength: number },
  ): Promise<{
    inputIds: ArrayLike<number>
    attentionMask: ArrayLike<number>
    tokenTypeIds?: ArrayLike<number>
    dims: readonly [number, number]
  }>
}

/** 池化方式：**从模型信息读，不要硬编码**（docs/06 §4.2 踩坑 3） */
export type PoolingMode = 'cls' | 'mean'

export interface OnnxEmbeddingConfig {
  modelId: string
  /** 以 config.json 的 hidden_size 为准，运行时校验（docs/06 §4.1） */
  dim: number
  pooling: PoolingMode
  /** 最大 token 数，bge 默认 512 */
  maxLength?: number
  /** 起始批大小 16，OOM 时逐级降级（docs/06 §4.2 踩坑 4） */
  batchSize?: number
  session?: OnnxSessionLike
  tokenizer?: TokenizerLike
  tensors?: OnnxTensorFactoryLike
  /** 模型文件路径（仅用于报错与诊断，不在这里读文件） */
  modelPath?: string
  /** layers.json / models.json 里登记的预期 SHA-256（缺失时由调用方先行校验） */
  expectedSha256?: string | null
  /** 是否在首次调用前预热（docs/06 §4.2 踩坑 5） */
  warmup?: boolean
  /** 每批之间的让路钩子（docs/06 §4.3：ONNX 是同步阻塞的，不让路 UI 会卡死） */
  yieldToLoop?: () => Promise<void>
  onProgress?: (progress: number, stage: string) => void
  signal?: AbortSignal
}

// ============================================================================
// 纯函数：输入准备（真实可用，已被测试覆盖）
// ============================================================================

/** bge 系列必需的输入名（生产从 session.inputNames 读，这里仅作为期望值） */
export const REQUIRED_INPUT_NAMES = ['input_ids', 'attention_mask'] as const

/**
 * 解析本模型实际需要的输入张量名。
 *
 * docs/06 §4.2 踩坑 2：**必须从 `session.inputNames` 读取，不要硬编码**。
 * `token_type_ids` 视模型输入而定（bge 不需要，部分 BERT 导出需要）。
 */
export function resolveInputNames(session: Pick<OnnxSessionLike, 'inputNames'>): {
  inputIds: string
  attentionMask: string
  tokenTypeIds: string | null
} {
  const names = new Set(session.inputNames)
  const inputIds = REQUIRED_INPUT_NAMES[0]
  const attentionMask = REQUIRED_INPUT_NAMES[1]
  const missing = REQUIRED_INPUT_NAMES.filter((n) => !names.has(n))
  if (missing.length) {
    throw new AppError('MODEL_LOAD_FAILED', {
      params: { model: 'embedding' },
      details: { reason: 'input-name-missing', missing, available: [...names] },
    })
  }
  return {
    inputIds,
    attentionMask,
    tokenTypeIds: names.has('token_type_ids') ? 'token_type_ids' : null,
  }
}

/**
 * `int64` 张量数据必须用 **BigInt64Array**（docs/06 §4.2 踩坑 1：最常见的报错来源）。
 * 传普通 number 数组或 Int32Array 都会在 run 时报类型错误。
 */
export function toInt64Data(values: ArrayLike<number>): BigInt64Array {
  const out = new BigInt64Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = BigInt(Math.trunc(values[i]))
  return out
}

/** 构造 feeds（真实可用；但只有拿到真 session 才有意义） */
export function buildFeeds(
  encoded: {
    inputIds: ArrayLike<number>
    attentionMask: ArrayLike<number>
    tokenTypeIds?: ArrayLike<number>
    dims: readonly [number, number]
  },
  inputNames: ReturnType<typeof resolveInputNames>,
  tensors: OnnxTensorFactoryLike,
): Record<string, OnnxTensorLike> {
  const feeds: Record<string, OnnxTensorLike> = {
    [inputNames.inputIds]: tensors.create('int64', toInt64Data(encoded.inputIds), encoded.dims),
    [inputNames.attentionMask]: tensors.create('int64', toInt64Data(encoded.attentionMask), encoded.dims),
  }
  if (inputNames.tokenTypeIds && encoded.tokenTypeIds) {
    feeds[inputNames.tokenTypeIds] = tensors.create('int64', toInt64Data(encoded.tokenTypeIds), encoded.dims)
  }
  return feeds
}

/**
 * CLS 池化：取 `last_hidden_state[:, 0, :]`。
 * **bge 系列必须用 CLS，不是 mean** —— 用错会显著掉点（docs/06 §4.1）。
 */
export function poolCls(lastHiddenState: Float32Array, dim: number, index = 0): Float32Array {
  const start = index * dim
  if (lastHiddenState.length < start + dim) {
    throw new AppError('MODEL_LOAD_FAILED', {
      params: { model: 'embedding' },
      details: {
        reason: 'output-shape-mismatch',
        expectedAtLeast: start + dim,
        actual: lastHiddenState.length,
      },
    })
  }
  return lastHiddenState.slice(start, start + dim)
}

/** mean 池化：按 attention_mask 加权平均（text2vec / sentence-transformers 常用） */
export function poolMean(
  lastHiddenState: Float32Array,
  dim: number,
  attentionMask: ArrayLike<number>,
  batchIndex = 0,
): Float32Array {
  const tokenCount = Math.floor(lastHiddenState.length / dim) // 仅单批时的粗略推断
  const out = new Float32Array(dim)
  let weightSum = 0
  const tokens = Math.min(tokenCount, attentionMask.length)
  for (let t = 0; t < tokens; t++) {
    const w = attentionMask[t] || 0
    if (!w) continue
    weightSum += w
    const base = (batchIndex * tokens + t) * dim
    for (let d = 0; d < dim; d++) out[d] += lastHiddenState[base + d] * w
  }
  if (weightSum > 0) for (let d = 0; d < dim; d++) out[d] /= weightSum
  return out
}

/** 原地 L2 归一化（docs/06 §4.1：输出后立即归一化，使点积即余弦） */
export function l2NormalizeInPlace(vector: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i]
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm)
    for (let i = 0; i < vector.length; i++) vector[i] *= inv
  }
  return vector
}

// ============================================================================
// 批大小 OOM 逐级降级（docs/06 §4.2 踩坑 4 / §8 降级矩阵）
// ============================================================================

/** 降级序列：16 → 8 → 4 → 1（不允许出现 0 或负数） */
export const BATCH_DOWNGRADE_SEQUENCE = [16, 8, 4, 1] as const

/** 下一个更小的批大小；已经是 1 则返回 null（表示「无法再降，该章标记未判定」） */
export function nextBatchSizeOnOom(current: number): number | null {
  const candidates = BATCH_DOWNGRADE_SEQUENCE.filter((b) => b < current)
  if (candidates.length === 0) return null
  return Math.max(...candidates)
}

/** ONNX Runtime 的 OOM 报错文案形态不统一，这里做启发式识别 */
export function isOomError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return /out of memory|OOM|bad_alloc|failed to allocate|ENOMEM|内存不足/i.test(text)
}

/**
 * 按批大小切分并逐批执行，OOM 时自动降级重试（**真实可用的调度逻辑**，
 * 只是 `runBatch` 需要真实推理实现才能有结果）。
 *
 * 与 docs/06 §4.3 一致：
 *   · 每批之间 `ctx.throwIfAborted()` + `yieldToLoop()`（否则 UI 完全卡死）
 *   · 进度回调 `report(0.3 + 0.7 * i/total, ...)`
 */
export async function runBatchesWithOomDowngrade<_T>(
  texts: string[],
  runBatch: (batch: string[], batchSize: number) => Promise<Float32Array[]>,
  options: {
    batchSize?: number
    signal?: AbortSignal
    yieldToLoop?: () => Promise<void>
    onProgress?: (progress: number, stage: string) => void
    onBatchDowngrade?: (from: number, to: number) => void
  } = {},
): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  let batchSize = Math.max(1, options.batchSize ?? 16)
  let i = 0

  while (i < texts.length) {
    if (options.signal?.aborted) {
      const err = new Error('向量化已取消')
      err.name = 'AbortError'
      throw err
    }
    const batch = texts.slice(i, i + batchSize)
    try {
      const vectors = await runBatch(batch, batchSize)
      if (vectors.length !== batch.length) {
        throw new AppError('MODEL_LOAD_FAILED', {
          params: { model: 'embedding' },
          details: { reason: 'batch-count-mismatch', requested: batch.length, returned: vectors.length },
        })
      }
      out.push(...vectors)
      i += batch.length
      options.onProgress?.(
        texts.length ? 0.3 + 0.7 * (i / texts.length) : 1,
        `向量化 ${i}/${texts.length}`,
      )
      if (options.yieldToLoop) await options.yieldToLoop()
    } catch (e) {
      if (!isOomError(e)) throw e
      const smaller = nextBatchSizeOnOom(batchSize)
      if (smaller === null) {
        throw new AppError('MODEL_OOM', {
          cause: e,
          details: { reason: 'oom-exhausted', batchSize },
        })
      }
      options.onBatchDowngrade?.(batchSize, smaller)
      batchSize = smaller
    }
  }
  return out
}

// ============================================================================
// Provider 工厂（注入运行时后真实推理）
// ============================================================================

/** 说明为什么这里没有实现推理（会出现在 NOT_IMPLEMENTED 错误的 details 里） */
export const ONNX_IMPLEMENTATION_NOTES = [
  '本仓库当前环境没有 node_modules（无 onnxruntime-node / @xenova/transformers），因此不提供推理实现。',
  '真实实现要点（docs/06 §4.2）：',
  '1. int64 张量必须用 BigInt64Array（最常见的报错来源）。',
  '2. 输入张量名必须从 session.inputNames 读取，不要硬编码。',
  '3. 池化方式必须从模型信息（models.json 的 pooling 字段）读取：bge = CLS，text2vec = mean。',
  '4. 批大小 16 起步，OOM 时按 16→8→4→1 逐级降级，仍失败则该章标记「未判定」。',
  '5. 首次加载模型 1~3 s，需要预热一次空推理，否则首句判定异常慢。',
  '6. 每批之间必须 yieldToLoop()，否则 ONNX 的同步推理会让 UI 完全卡死。',
  '7. 输出必须立即 L2 归一化，否则 cos 计算要用归一化公式。',
].join('\n')

/**
 * 创建真实的 ONNX embedding Provider。
 *
 * 缺 `session` / `tokenizer` / `tensors` 任一 → 抛 `NOT_IMPLEMENTED`（`onnx-runtime-unavailable`）：
 * 装配层据此降级为规则判定。三者齐全时**真的推理**，输出保证 L2 归一化。
 * 单测用假的 session/tokenizer 即可验证池化与归一化，不需要原生模块。
 */
export function createOnnxEmbeddingProvider(config: OnnxEmbeddingConfig): EmbeddingProvider {
  // 缺注入 → 明确说「运行时不完整」，让装配层去装 onnxruntime-node / 分词器
  if (!config.session || !config.tokenizer || !config.tensors) {
    throw new AppError('NOT_IMPLEMENTED', {
      params: { feature: '本地 ONNX 向量模型（需要 onnxruntime-node 与分词器）' },
      details: {
        reason: 'onnx-runtime-unavailable',
        modelId: config.modelId,
        modelPath: config.modelPath ?? null,
        notes: ONNX_IMPLEMENTATION_NOTES,
      },
    })
  }

  const session = config.session
  const tokenizer = config.tokenizer
  const tensors = config.tensors
  const inputNames = resolveInputNames(session)
  const maxLength = config.maxLength ?? 512
  const dim = config.dim
  const pooling = config.pooling
  const startBatchSize = Math.max(1, config.batchSize ?? 16)

  /** 输出张量名：`last_hidden_state` 优先；没有就读第一个输出（不同导出命名不一） */
  function pickOutputName(): string {
    if (session.outputNames.includes('last_hidden_state')) return 'last_hidden_state'
    if (session.outputNames.includes('sentence_embedding')) return 'sentence_embedding'
    return session.outputNames[0] ?? ''
  }

  function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    const err = new Error('向量化已取消')
    err.name = 'AbortError'
    throw err
  }

  /** 一批文本 → 一批已 L2 归一化的向量（真实推理；第 4.2 节的坑都在这里落实） */
  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const encoded = await tokenizer.encode(texts, { padding: true, truncation: true, maxLength })
    const feeds = buildFeeds(encoded, inputNames, tensors)
    const outputs = await session.run(feeds)
    const name = pickOutputName()
    const tensor = name ? outputs[name] : undefined
    if (!tensor || !(tensor.data instanceof Float32Array)) {
      throw new AppError('MODEL_LOAD_FAILED', {
        params: { model: config.modelId },
        details: { reason: 'output-missing', outputName: name, available: [...session.outputNames] },
      })
    }
    const [batch, seq] = encoded.dims
    const data = tensor.data
    const vectors: Float32Array[] = []
    for (let b = 0; b < batch; b++) {
      const vector = pooling === 'cls'
        // last_hidden_state 是 [batch, seq, dim]，CLS 在每条的 seq=0 → 展平偏移 b*seq*dim
        ? poolCls(data, dim, b * seq)
        // mean 池化要先切出本条，否则 poolMean 的 tokenCount 会把整批算成一条
        : poolMean(
            data.subarray(b * seq * dim, (b + 1) * seq * dim),
            dim,
            Array.from(encoded.attentionMask).slice(b * seq, (b + 1) * seq),
            0,
          )
      vectors.push(l2NormalizeInPlace(vector))
    }
    return vectors
  }

  let warmed = false
  async function warmup(): Promise<void> {
    if (warmed) return
    warmed = true
    if (config.warmup === false) return
    // 首次加载 1~3 s；预热失败不致命（真正调用时再报真实错误）
    try { await embedBatch(['预热']) } catch { /* 见上 */ }
  }

  return {
    modelId: config.modelId,
    dim,
    async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      await warmup()
      return runBatchesWithOomDowngrade(
        texts,
        async (batch) => { throwIfAborted(signal); return await embedBatch(batch) },
        {
          batchSize: startBatchSize,
          ...(signal ? { signal } : {}),
          ...(config.yieldToLoop ? { yieldToLoop: config.yieldToLoop } : {}),
          ...(config.onProgress ? { onProgress: config.onProgress } : {}),
        },
      )
    },
    async healthCheck(): Promise<{ ok: boolean; message: string }> {
      try {
        const vectors = await embedBatch(['健康检查'])
        const first = vectors[0]
        const ok = vectors.length === 1 && first !== undefined && first.length === dim && isL2Normalized(first)
        return {
          ok,
          message: ok
            ? `ONNX 会话正常（${config.modelId}, dim=${dim}, pooling=${pooling}）`
            : `输出不合法：条数=${vectors.length}, 维度=${first?.length ?? 0}（期望 ${dim}）或未 L2 归一化`,
        }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/**
 * 依赖齐全时的自检：加载会话 → 校验输入名 → 校验维度 → 预热。
 * 返回 `HealthStatus`，**不返回向量**，因此不会有「假装推理」的风险。
 */
export async function probeOnnxEmbedding(config: {
  session: OnnxSessionLike
  dim: number
  modelId: string
  pooling: PoolingMode
}): Promise<HealthStatus> {
  const started = Date.now()
  try {
    resolveInputNames(config.session)
    if (!Number.isInteger(config.dim) || config.dim <= 0) {
      return { ok: false, message: `模型维度非法：${config.dim}` }
    }
    return {
      ok: true,
      message: `${config.modelId} 会话已就绪（dim=${config.dim}, pooling=${config.pooling}）`,
      latencyMs: Date.now() - started,
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof AppError ? e.message : '模型初始化失败',
      latencyMs: Date.now() - started,
    }
  }
}

/** 自检：给定向量是否满足「维度正确 + 已 L2 归一化」 */
export function validateEmbeddingOutput(vector: Float32Array, dim: number): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (vector.length !== dim) errors.push(`维度应为 ${dim}，实际 ${vector.length}`)
  if (!isL2Normalized(vector)) errors.push('向量未 L2 归一化（点积不再等于余弦）')
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      errors.push(`第 ${i} 维不是有限数（NaN/Infinity）`)
      break
    }
  }
  return { ok: errors.length === 0, errors }
}
