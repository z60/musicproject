/**
 * Novel Studio · AI 调用观测：缓存键、用量记录与成本估算
 * ============================================================================
 * 设计依据：
 *   · docs/06 §7.1  缓存键（ai_cache / line_embeddings 的 content_hash）
 *   · docs/06 §7.2  成本控制策略（批量提交、预估消耗、明确告知）
 *   · docs/06 §7.3  用量记录（AiUsageRecord）
 *   · docs/06 §9    隐私：只记长度、耗时、状态码，绝不记请求/响应正文
 *
 * 本文件零第三方依赖：sha256 走 node:crypto，stableStringify 自己实现
 * （不引入 fast-json-stable-stringify）。
 */

import { createHash } from 'node:crypto'

import type { ChatUsage, ProviderKind } from './types.ts'

// ============================================================================
// 稳定序列化与哈希
// ============================================================================

/**
 * 稳定序列化：对象键按字典序递归输出，保证「同样的内容 → 同样的字符串 → 同样的哈希」。
 *
 * 为什么不能直接用 JSON.stringify：JS 对象键顺序在跨进程 / 跨版本读回时不保证一致，
 * 缓存键一旦抖动就会**永远命不中**，成本控制直接失效（docs/06 §7.1）。
 */
export function stableStringify(value: unknown): string {
  return stringifyValue(value, new Set<unknown>())
}

function stringifyValue(v: unknown, seen: Set<unknown>): string {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v as number) ? String(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (t === 'bigint') return JSON.stringify(String(v))
  if (t === 'undefined') return 'null'
  if (t === 'function' || t === 'symbol') return 'null'

  const obj = v as object
  // 循环引用：直接标记，避免抛错让整条链路失败
  if (seen.has(obj)) return '"[circular]"'
  seen.add(obj)

  let out: string
  if (Array.isArray(obj)) {
    out = `[${obj.map((x) => stringifyValue(x, seen)).join(',')}]`
  } else if (obj instanceof Date) {
    out = JSON.stringify(obj.toISOString())
  } else if (obj instanceof Uint8Array) {
    // 二进制不进 JSON：只取长度与哈希，避免把音频塞进缓存键
    out = `"[bytes:${obj.byteLength}:${sha256Hex(obj).slice(0, 16)}]"`
  } else {
    const keys = Object.keys(obj as Record<string, unknown>).sort()
    out = `{${keys
      .map((k) => `${JSON.stringify(k)}:${stringifyValue((obj as Record<string, unknown>)[k], seen)}`)
      .join(',')}}`
  }

  seen.delete(obj)
  return out
}

/** sha256 十六进制小写（docs/06 §7.1 的缓存键都用它） */
export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash('sha256')
  if (typeof data === 'string') h.update(data, 'utf8')
  else h.update(data)
  return h.digest('hex')
}

/** 短哈希：日志与诊断标签用（8 字符足够区分，不泄露内容） */
export function shortHash(data: string | Uint8Array, len = 8): string {
  return sha256Hex(data).slice(0, Math.max(1, Math.min(64, len)))
}

// ============================================================================
// 缓存键（docs/06 §7.1）
// ============================================================================

export interface AiCacheKeyInput {
  /** 模板 id，如 'attribution_review' */
  promptId: string
  /** 模板版本号；与结果一起记录，便于回答「同样的输入为什么结果不同」（docs/06 §6.1） */
  version: number
  /** 模型名（provider 侧实际使用的名字） */
  model: string
  /** 本次输入集合（行 id、文本、角色表…）—— 会被稳定序列化后再哈希 */
  inputs: unknown
  /** 可选的额外种子（如阈值、角色表版本） */
  extra?: string
}

/**
 * `ai_cache` 的键：`sha256(promptId + '|' + version + '|' + model + '|' + 输入集合的稳定哈希)`
 * （docs/06 §7.1 表格第 2、3 行）
 */
export function computeAiCacheKey(input: AiCacheKeyInput): string {
  const inputsHash = sha256Hex(stableStringify(input.inputs))
  const parts = [input.promptId, String(input.version), input.model, inputsHash]
  if (input.extra) parts.push(input.extra)
  return sha256Hex(parts.join('|'))
}

/** embedding 的 content_hash：`sha256(modelId + '|' + text)`（docs/06 §7.1） */
export function computeEmbeddingContentHash(modelId: string, text: string): string {
  return sha256Hex(`${modelId}|${text}`)
}

// ============================================================================
// 缓存存储抽象（ai_cache 表）
// ============================================================================

export interface AiCacheEntry {
  cacheKey: string
  purpose: string
  model: string
  provider: ProviderKind
  /** 原始返回（**不写日志**） */
  response: string
  createdAt: number
  hits: number
}

/**
 * `ai_cache` 的存储接口。生产由 repository 落到 SQLite；
 * 测试与缓存预热可直接用 `createMemoryAiCache()`。
 */
export interface AiCacheStore {
  get(cacheKey: string): AiCacheEntry | null
  put(entry: AiCacheEntry): void
  /** 命中时 `hits++`（用于分析哪些提示词值得固化，docs/06 §7.1） */
  hit(cacheKey: string): void
}

/** TTL：30 天（docs/06 §7.1） */
export const AI_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface MemoryAiCacheOptions {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
}

/** 内存版 ai_cache：用于测试，以及「单次任务内」的会话级缓存 */
export function createMemoryAiCache(options: MemoryAiCacheOptions = {}): AiCacheStore & {
  size(): number
  keys(): string[]
  /** 便于 stats 断言：命中/未命中计数 */
  stats(): { hits: number; misses: number }
} {
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? AI_CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? 5000
  const map = new Map<string, AiCacheEntry>()
  let hits = 0
  let misses = 0

  return {
    get(cacheKey) {
      const e = map.get(cacheKey)
      if (!e) {
        misses++
        return null
      }
      if (ttl > 0 && now() - e.createdAt > ttl) {
        map.delete(cacheKey)
        misses++
        return null
      }
      hits++
      return e
    },
    put(entry) {
      if (map.size >= maxEntries) {
        // 简单 LRU：淘汰最早插入的一条（Map 保证插入序）
        const first = map.keys().next()
        if (!first.done) map.delete(first.value)
      }
      map.set(entry.cacheKey, entry)
    },
    hit(cacheKey) {
      const e = map.get(cacheKey)
      if (e) e.hits++
    },
    size: () => map.size,
    keys: () => [...map.keys()],
    stats: () => ({ hits, misses }),
  }
}

// ============================================================================
// 用量记录（docs/06 §7.3）
// ============================================================================

export interface AiUsageRecord {
  id: string
  projectId: string | null
  purpose: string
  provider: ProviderKind
  model: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  /** 后续人工是否采纳（回填，用于评估质量）；未回填为 null */
  accepted: number | null
  createdAt: number
}

export interface CreateUsageInput {
  id: string
  projectId?: string | null
  purpose: string
  provider: ProviderKind
  model: string
  usage?: ChatUsage
  latencyMs: number
  now?: () => number
}

/** 构造一条用量记录：usage 缺失时按 0 记（本地 Provider 没有 token 概念） */
export function createUsageRecord(input: CreateUsageInput): AiUsageRecord {
  return {
    id: input.id,
    projectId: input.projectId ?? null,
    purpose: input.purpose,
    provider: input.provider,
    model: input.model,
    promptTokens: input.usage?.promptTokens ?? 0,
    completionTokens: input.usage?.completionTokens ?? 0,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    accepted: null,
    createdAt: (input.now ?? Date.now)(),
  }
}

/**
 * 回填「人工是否采纳」。返回新对象（记录本身不原地改，便于直接写库/发 IPC）。
 * `accepted` 语义：1 = 采纳，0 = 未采纳，null = 尚未判定。
 */
export function withAccepted(record: AiUsageRecord, accepted: 0 | 1 | null): AiUsageRecord {
  return { ...record, accepted }
}

/** 采纳率统计（docs/06 §5.4 的核心指标在画本侧，这里只做 AI 维度的汇总） */
export function summarizeUsage(records: readonly AiUsageRecord[]): {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  avgLatencyMs: number
  decided: number
  accepted: number
  acceptRate: number | null
  byPurpose: Record<string, number>
  byProvider: Record<string, number>
} {
  let promptTokens = 0
  let completionTokens = 0
  let latencyMs = 0
  let decided = 0
  let accepted = 0
  const byPurpose: Record<string, number> = {}
  const byProvider: Record<string, number> = {}

  for (const r of records) {
    promptTokens += r.promptTokens
    completionTokens += r.completionTokens
    latencyMs += r.latencyMs
    if (r.accepted !== null) {
      decided++
      if (r.accepted === 1) accepted++
    }
    byPurpose[r.purpose] = (byPurpose[r.purpose] ?? 0) + 1
    byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1
  }

  return {
    calls: records.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    latencyMs,
    avgLatencyMs: records.length ? latencyMs / records.length : 0,
    decided,
    accepted,
    acceptRate: decided ? accepted / decided : null,
    byPurpose,
    byProvider,
  }
}

// ============================================================================
// 成本估算（docs/06 §7.2「显示预估消耗」）
// ============================================================================

/** 每 1000 token 的美元单价 */
export interface ModelPricing {
  inputPer1k: number
  outputPer1k: number
  /** 币种标签，仅用于展示 */
  currency: 'USD'
}

/**
 * 内置价目表（**只用于估算**，可能过时；用户可在设置里覆盖）。
 * 未登记的模型按 `UNKNOWN_PRICING` 处理并在 UI 标注「费用未知」。
 */
export const BUILTIN_PRICING: Readonly<Record<string, ModelPricing>> = {
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006, currency: 'USD' },
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01, currency: 'USD' },
  'gpt-3.5-turbo': { inputPer1k: 0.0005, outputPer1k: 0.0015, currency: 'USD' },
  'qwen-plus': { inputPer1k: 0.0004, outputPer1k: 0.0012, currency: 'USD' },
  'deepseek-chat': { inputPer1k: 0.00014, outputPer1k: 0.00028, currency: 'USD' },
}

export const UNKNOWN_PRICING: ModelPricing = { inputPer1k: 0, outputPer1k: 0, currency: 'USD' }

export interface CostEstimate {
  model: string
  pricing: ModelPricing
  /** 价目表里是否有这个模型（false 时费用不可信，UI 必须提示） */
  known: boolean
  promptTokens: number
  completionTokens: number
  inputCost: number
  outputCost: number
  totalCost: number
  formatted: string
}

/** 成本估算：`cost = prompt/1000*in + completion/1000*out` */
export function estimateCost(
  model: string,
  usage: { promptTokens: number; completionTokens: number },
  pricingTable: Readonly<Record<string, ModelPricing>> = BUILTIN_PRICING,
): CostEstimate {
  const found = pricingTable[model]
  const pricing = found ?? UNKNOWN_PRICING
  const inputCost = (usage.promptTokens / 1000) * pricing.inputPer1k
  const outputCost = (usage.completionTokens / 1000) * pricing.outputPer1k
  const totalCost = inputCost + outputCost
  return {
    model,
    pricing,
    known: Boolean(found),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    inputCost,
    outputCost,
    totalCost,
    formatted: formatCost(totalCost, found ? undefined : '未知费用'),
  }
}

/** 美元金额格式化：小额用 4 位小数，够小而可读 */
export function formatCost(usd: number, suffix?: string): string {
  const v = Number.isFinite(usd) ? Math.max(0, usd) : 0
  const text = v === 0 ? '$0' : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`
  return suffix ? `${text}（${suffix}）` : text
}

/**
 * 粗略 token 估算（docs/06 §7.2 的「预估消耗」必需，且**不联网**）。
 *
 * 规则（刻意保守，宁可高估）：
 *   · 中日韩字符 ≈ 1 token/字（bge 与多数中文分词器都是这个量级）
 *   · 其它字符 ≈ 4 字符/token（英文常见经验值）
 *   · 每条消息 +4 token 的角色/分隔开销
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0x3400 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
      (code >= 0xac00 && code <= 0xd7af) // 韩文
    ) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk + other / 4) + 4
}

/** 一组消息的 prompt token 估算 */
export function estimatePromptTokens(messages: readonly { content: string }[]): number {
  let sum = 0
  for (const m of messages) sum += estimateTokens(m.content)
  return sum
}

/** 单行对白发送前的长度截断（docs/06 §7.2「单行 > 200 字截断并标注」） */
export const MAX_LINE_CHARS_SENT = 200

export function truncateForSending(text: string, maxChars = MAX_LINE_CHARS_SENT): {
  text: string
  truncated: boolean
} {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}…（已截断，原 ${text.length} 字）`, truncated: true }
}

// ============================================================================
// 隐私辅助（docs/06 §9）
// ============================================================================

/** 日志里允许出现的请求摘要：**只有长度、方法、主机**，绝无正文与 API Key */
export interface SanitizedRequestLog {
  method: string
  /** 只保留 origin + pathname，剥掉 query（可能带 key） */
  endpoint: string
  bodyBytes: number
  hasAuth: boolean
}

export function sanitizeRequestForLog(req: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}): SanitizedRequestLog {
  let endpoint = req.url
  try {
    const u = new URL(req.url)
    endpoint = `${u.origin}${u.pathname}`
  } catch {
    endpoint = '(invalid-url)'
  }
  const headers = req.headers ?? {}
  return {
    method: req.method ?? 'POST',
    endpoint,
    bodyBytes: req.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(req.body) ?? '', 'utf8'),
    hasAuth: Object.keys(headers).some((k) => k.toLowerCase() === 'authorization'),
  }
}

/**
 * 诊断包/日志的安全响应摘要：只给长度与状态，**不含响应正文**（docs/06 §9）。
 */
export function sanitizeResponseForLog(res: { status: number; text?: string }): {
  status: number
  textChars: number
} {
  return { status: res.status, textChars: res.text?.length ?? 0 }
}
