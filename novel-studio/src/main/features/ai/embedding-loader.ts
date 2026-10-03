/**
 * Novel Studio · 本地 ONNX 向量模型加载器（主进程）
 * ============================================================================
 * 设计依据：docs/06 §4「本地 Embedding（L2）」
 *
 * 为什么单独一层：`shared/ai/embedding/onnx-provider.ts` 是**纯逻辑**（可在无 node_modules 的测试
 * 环境里跑），而真正加载 `onnxruntime-node` / `@xenova/transformers` 只能在主进程做。
 * 本文件负责「找模型文件 → 动态 import 原生模块 → 包装成注入接口 → 自检」。
 *
 * 失败语义：**绝不抛错**。模型文件缺失 / 原生模块加载失败 / 自检不过，都返回 `available:false`
 * 并带一句人话原因；上层据此降级为规则判定（docs/06 §8「绝不因为模型缺失就阻断用户」）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  createOnnxEmbeddingProvider,
  type OnnxSessionLike,
  type OnnxTensorLike,
  type PoolingMode,
  type TokenizerLike,
} from '../../../shared/ai/embedding/onnx-provider.ts'
import type { EmbeddingProvider } from '../../../shared/ai/types.ts'

export interface EmbeddingLoadResult {
  provider: EmbeddingProvider | null
  available: boolean
  modelId: string
  dim: number
  /** 不可用原因（人话）；可用时为 null */
  reason: string | null
}

export interface LoadLocalEmbeddingOptions {
  /** `resources/models` 目录 */
  modelsDir: string
  modelId?: string
  dim?: number
  pooling?: PoolingMode
  maxLength?: number
  threads?: number
  log?: { info?: (event: string, fields?: Record<string, unknown>) => void }
}

/** 把 @xenova/transformers 的分词器包装成本域注入接口 */
function wrapTokenizer(raw: {
  (texts: string[], options?: Record<string, unknown>): Promise<{
    input_ids: { data: ArrayLike<number>; dims: number[] }
    attention_mask: { data: ArrayLike<number>; dims: number[] }
    token_type_ids?: { data: ArrayLike<number>; dims: number[] }
  }>
}): TokenizerLike {
  return {
    encode: async (texts, o) => {
      const enc = await raw(texts, { padding: true, truncation: true, max_length: o.maxLength })
      const batch = enc.input_ids.dims[0] ?? texts.length
      const seq = enc.input_ids.dims[1] ?? 1
      return {
        inputIds: enc.input_ids.data,
        attentionMask: enc.attention_mask.data,
        ...(enc.token_type_ids ? { tokenTypeIds: enc.token_type_ids.data } : {}),
        dims: [batch, seq],
      }
    },
  }
}

/** 把 onnxruntime-node 的会话包装成本域注入接口（feeds 里本来就是真实 ort.Tensor） */
function wrapSession(session: unknown): OnnxSessionLike {
  const s = session as {
    inputNames: readonly string[]
    outputNames: readonly string[]
    run(feeds: Record<string, unknown>): Promise<Record<string, { type: string; data: unknown; dims: readonly number[] }>>
  }
  return {
    inputNames: s.inputNames,
    outputNames: s.outputNames,
    run: async (feeds) => {
      const out = await s.run(feeds as unknown as Record<string, unknown>)
      const mapped: Record<string, OnnxTensorLike> = {}
      for (const [name, tensor] of Object.entries(out)) {
        mapped[name] = {
          type: tensor.type === 'int64' ? 'int64' : 'float32',
          data: tensor.data as BigInt64Array | Float32Array,
          dims: tensor.dims,
        }
      }
      return mapped
    },
  }
}

/** 尝试加载本地向量模型。**不抛错**：任何问题都收敛成 `available:false + reason`。 */
async function doLoadLocalEmbeddingProvider(
  opts: LoadLocalEmbeddingOptions,
): Promise<EmbeddingLoadResult> {
  const modelId = opts.modelId ?? 'bge-small-zh-v1.5'
  const dim = opts.dim ?? 512
  const dir = join(opts.modelsDir, 'embedding', modelId)
  const modelPath = join(dir, 'model.onnx')

  if (!existsSync(modelPath)) {
    return { provider: null, available: false, modelId, dim, reason: '本地向量模型不存在：' + modelPath }
  }

  try {
    const ort = await import('onnxruntime-node')
    const tf = await import('@xenova/transformers')
    // 只允许本地模型，避免「以为在本地跑，其实偷偷下载」
    tf.env.localModelPath = join(opts.modelsDir, 'embedding')
    tf.env.allowRemoteModels = false
    tf.env.allowLocalModels = true

    const session = await ort.InferenceSession.create(modelPath, {
      intraOpNumThreads: Math.max(1, Math.min(opts.threads ?? 4, 8)),
    })
    const tokenizer = await tf.AutoTokenizer.from_pretrained(modelId)

    const provider = createOnnxEmbeddingProvider({
      modelId,
      dim,
      pooling: opts.pooling ?? 'cls',
      maxLength: opts.maxLength ?? 512,
      modelPath,
      session: wrapSession(session),
      tokenizer: wrapTokenizer(tokenizer as unknown as Parameters<typeof wrapTokenizer>[0]),
      tensors: {
        create: (type, data, dims) => {
          const tensor = new ort.Tensor(type, data as never, dims)
          return { type, data: tensor.data as BigInt64Array | Float32Array, dims: tensor.dims }
        },
      },
    })

    const health = await provider.healthCheck()
    if (!health.ok) {
      return { provider: null, available: false, modelId, dim, reason: '自检未通过：' + health.message }
    }
    opts.log?.info?.('ai.embedding.loaded', { event: 'ai.embedding.loaded', modelId, dim, modelPath })
    return { provider, available: true, modelId, dim, reason: null }
  } catch (e) {
    return {
      provider: null,
      available: false,
      modelId,
      dim,
      reason: '加载失败：' + (e instanceof Error ? e.message : String(e)),
    }
  }
}
/**
 * 进程内缓存：启动期能力探测与 ports 的画本判定都要用同一个 provider。
 * 不缓存会让模型被加载两次（两份 ONNX 会话 + 两份内存）。
 * 键含 modelsDir 与 modelId；`reason` 也一起缓存（缺失模型时不必反复探盘）。
 */
const loadCache = new Map<string, Promise<EmbeddingLoadResult>>()

/**
 * 尝试加载本地向量模型。**不抛错**：任何问题都收敛成 `available:false + reason`。
 */
export function loadLocalEmbeddingProvider(opts: LoadLocalEmbeddingOptions): Promise<EmbeddingLoadResult> {
  const key = `${opts.modelsDir}|${opts.modelId ?? 'bge-small-zh-v1.5'}`
  const hit = loadCache.get(key)
  if (hit) return hit
  const pending = doLoadLocalEmbeddingProvider(opts)
  loadCache.set(key, pending)
  return pending
}

