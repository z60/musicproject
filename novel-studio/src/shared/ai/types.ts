/**
 * Novel Studio · AI Provider 抽象层 · 类型契约
 * ============================================================================
 * 设计依据：
 *   · docs/06-AI抽象层与向量判定.md §2   三层能力划分（L1 规则 / L2 向量 / L3 LLM）
 *   · docs/06 §3.1   Provider 接口定义（本文件是它的落地版本）
 *   · docs/06 §3.4   Dify 与 OpenAI 兼容的差异表
 *   · docs/06 §8     降级矩阵：任何一层的失败都不能阻断流程
 *   · docs/06 §9     隐私：任何外发前必须检查 allowCloud
 *
 * 约束（务必遵守）：
 *   · 本层**不 import 任何第三方包**，也不 import `src/shared/audio/**` 或
 *     `src/shared/canvas/**`（那两个目录由其它工作流负责，避免耦合与冲突）。
 *   · 网络发送一律通过注入的 `HttpClient`；本文件只描述契约，不做 IO。
 *   · 所有对外错误一律 `AppError` + `messages.ts` 里已登记的语义键。
 *   · 本文件是**唯一可以同时被主进程与渲染进程 import 的 AI 模块**：
 *     它只有类型与常量，不依赖 `node:*`。其余模块（Provider / structured / usage /
 *     embedding）都用到了 `node:crypto` 或 `Buffer`，属于主进程专用。
 */

import type { AppSettings } from '../types.ts'

// ============================================================================
// 设置
// ============================================================================

/** `settings.ai` 的领域别名（docs/04 §8.2） */
export type AiSettings = AppSettings['ai']

/**
 * Provider 种类（docs/06 §3.1）。
 *
 * 与 `AppSettings['ai']['provider']` 的取值保持一致：
 *   · `mock`              —— 确定性假数据，开发与测试用（绝不用于真实作品）
 *   · `local`             —— 本地降级占位（返回「无法判定」，不抛错）
 *   · `openai-compatible` —— Ollama / vLLM / LM Studio / 各类兼容网关
 *   · `dify`              —— Dify 应用（chat-messages / workflows）
 *
 * 用「从设置推断」的写法可保证两边永远同步：settings 增删取值时这里会立刻编译报错。
 */
export type ProviderKind = AiSettings['provider']

// ============================================================================
// JSON Schema（轻量版）
// ============================================================================

/**
 * 轻量 JSON Schema。
 *
 * 为什么不直接用 zod 的类型：本层要求「零第三方依赖」才能在受限环境下被
 * `node --experimental-strip-types` 直接执行（见 package.json 的 comments.import-ext）。
 * 真实实现仍可把 zod 的 `toJSONSchema()` 结果喂进来，业务代码零改动。
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  /** type='object' 时使用 */
  properties?: Record<string, JsonSchema>
  /** type='object' 时使用 */
  required?: readonly string[]
  additionalProperties?: boolean
  /** type='array' 时使用 */
  items?: JsonSchema
  minItems?: number
  maxItems?: number
  /** 枚举白名单（docs/06 §6.4 第三层防护） */
  enum?: readonly (string | number | boolean | null)[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  description?: string
}

// ============================================================================
// 对话
// ============================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  /** 要求返回严格 JSON；实现方需尽力保证（如 OpenAI 的 response_format） */
  jsonSchema?: JsonSchema
  signal?: AbortSignal
  /** 用于日志与成本归因（只记标签，绝不记正文，docs/06 §9） */
  purpose?: string
  /**
   * 是否允许把内容发送到云端；**false 时必须直接抛 PROVIDER_CLOUD_DISABLED，
   * 且不得发出任何网络请求**（docs/06 §8 降级矩阵 + §9 隐私）。
   */
  allowCloud: boolean
  /**
   * 【Dify 专用】是否复用会话（携带上一次的 `conversation_id`）。
   *
   * **默认 false = 每次新建会话**。原因是 docs/06 §3.4 明确警告：Dify 的
   * `conversation_id` 会累积上下文，批量逐行判定时会导致**上下文污染**
   * （第 500 行的判定被第 1 行影响）。只有「单轮持续追问」的交互场景才应置 true。
   */
  reuseConversation?: boolean
  /** 覆盖 Provider 的默认超时（毫秒） */
  timeoutMs?: number
  /** 诊断标签（如批次序号）；进日志但不含正文 */
  requestTag?: string
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatResult {
  text: string
  usage?: ChatUsage
  model: string
  /** 真正作答的 Provider（降级链里可能是兜底的那个，UI 据此提示「已降级」） */
  provider: ProviderKind
  latencyMs: number
}

export interface HealthStatus {
  ok: boolean
  message: string
  latencyMs?: number
}

export interface AIProvider {
  readonly kind: ProviderKind
  /** 健康探测（设置页「测试连接」用） */
  healthCheck(): Promise<HealthStatus>
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult>
  /** 流式（可选）。未实现时 `undefined`，调用方必须回落到 `chat`。 */
  chatStream?(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>
}

// ============================================================================
// 向量（L2）
// ============================================================================

/**
 * 本地/云端 embedding 的统一契约（docs/06 §3.1）。
 *
 * 注意：**不要** import `src/shared/canvas/**` 或 `src/shared/audio/**` 里的同名类型 ——
 * 结构相同即可，重复定义是为了让两个工作流可以并行推进而不互相阻塞。
 */
export interface EmbeddingProvider {
  readonly modelId: string
  readonly dim: number
  /** 返回的向量必须已 L2 归一化（点积即余弦，见 docs/06 §5.2） */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  healthCheck(): Promise<{ ok: boolean; message: string }>
}

// ============================================================================
// HTTP（注入式，便于在无网络环境下测试）
// ============================================================================

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  /** 会被 JSON.stringify 后作为请求体 */
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers?: Record<string, string>
  /** 已解析的 JSON；解析失败时为 undefined */
  json?: unknown
  /** 原始文本。**只用于解析与长度统计，绝不写进日志**（docs/06 §9） */
  text?: string
}

/**
 * HTTP 客户端接口。
 *
 * 生产实现：`createFetchHttpClient()`（Node 18+ 内置 `fetch`，无需 third-party）。
 * 测试实现：直接注入一个记录请求体的 fake（本仓库的 ai-providers.test.ts 就这么做）。
 */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
}

// ============================================================================
// 常量
// ============================================================================

/** 默认超时：连接 10 s / 首字节 60 s（docs/22 PROVIDER_TIMEOUT 的 dev 说明） */
export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** 「本地无法判定」的标记文案：LocalEchoProvider 与降级链共用（docs/06 §3.3） */
export const UNDETERMINED_MARKER = 'undetermined'

/**
 * 判定结果里的「无法判定」语义。
 * 降级时**返回它而不是抛错**，这样调用方可以走「规则 + 人工」路径（docs/06 §8）。
 */
export interface UndeterminedAnswer {
  undetermined: true
  reason: string
  /** 固定 0，便于调用方统一按置信度过滤 */
  confidence: 0
}

export function isUndeterminedAnswer(v: unknown): v is UndeterminedAnswer {
  return (
    typeof v === 'object' && v !== null &&
    (v as { undetermined?: unknown }).undetermined === true
  )
}
