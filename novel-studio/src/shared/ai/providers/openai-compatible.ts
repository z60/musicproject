/**
 * Novel Studio · OpenAI 兼容 Provider
 * ============================================================================
 * 设计依据：
 *   · docs/06 §3.2  OpenAICompatibleProvider（Ollama / vLLM / LM Studio / 各类兼容网关）
 *   · docs/06 §3.4  差异表：`POST /v1/chat/completions`（messages）、`choices[0].message.content`
 *   · docs/06 §9    日志不记正文；任何外发前检查 allowCloud
 *
 * 本文件**只做「请求构建」与「响应解析」**，真正的发送交给注入的 `HttpClient`：
 *   · 构建是纯函数（可单测，见 tests/shared/ai-providers.test.ts）
 *   · 发送与超时/重试/错误映射在 http.ts / chat() 里
 * 这样在无网络环境下也能验证契约形状，不会写出「假装发了请求」的实现。
 */

import { AppError } from '../../errors.ts'
import { assertHttpOk, expectJsonObject } from '../http.ts'
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatUsage,
  HealthStatus,
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '../types.ts'

export interface OpenAICompatibleConfig {
  baseUrl: string
  /** Ollama 等本地网关通常不需要；为空时不带 Authorization 头 */
  apiKey?: string | null
  model: string
  timeoutMs?: number
  http: HttpClient
  /** 额外请求头（如自定义租户头） */
  headers?: Record<string, string>
  /**
   * 是否在带 jsonSchema 时附加 `response_format`。
   * 默认 true；某些网关不支持该字段时会直接 400，此时设 false 由提示层兜底（docs/06 §6.4 第一层防护）。
   */
  useResponseFormat?: boolean
}

/** 去掉尾部斜杠，并避免 baseUrl 已含 /v1 时拼出 /v1/v1 */
export function joinApiPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  if (base.endsWith('/v1') && (p === '/v1' || p.startsWith('/v1/'))) {
    return `${base}${p.slice(3)}`
  }
  return `${base}${p}`
}

/**
 * 构建 `POST {baseUrl}/v1/chat/completions` 请求（纯函数，无副作用）。
 *
 * 映射规则：
 *   · `messages` 原样透传（OpenAI 侧无状态，上下文必须全量传，docs/06 §3.4）
 *   · `temperature` / `max_tokens` 仅在显式给出时带上，避免覆盖网关默认值
 *   · 有 `jsonSchema` 且 `useResponseFormat !== false` → `response_format: { type: 'json_object' }`
 *     （注意：这里没有用 `json_schema` 严格模式，因为 Ollama/vLLM 等兼容层支持度不一；
 *       真正的 schema 校验由 structured.ts 的第三层防护负责）
 */
export function buildOpenAIChatRequest(
  messages: ChatMessage[],
  opts: ChatOptions,
  config: OpenAICompatibleConfig,
): HttpRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(config.headers ?? {}),
  }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  const body: Record<string, unknown> = {
    model: opts.model ?? config.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  }
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens
  if (opts.jsonSchema && config.useResponseFormat !== false) {
    body.response_format = { type: 'json_object' }
  }

  return {
    url: joinApiPath(config.baseUrl, '/v1/chat/completions'),
    method: 'POST',
    headers,
    body,
    timeoutMs: opts.timeoutMs ?? config.timeoutMs,
    signal: opts.signal,
  }
}

export interface ParsedOpenAIResponse {
  text: string
  usage?: ChatUsage
  model: string
  /** 上游返回的 finish_reason，便于诊断（截断 vs 正常结束） */
  finishReason?: string
}

/**
 * 解析 `choices[0].message.content` 与 `usage`（纯函数）。
 *
 * 容错点（都是真实网关见过的形态）：
 *   · `content` 是分段数组 `[{type:'text',text}]` → 拼接
 *   · `usage` 缺失 → 返回 undefined（不编造 token 数，成本估算按 0 记）
 *   · `model` 缺失 → 用配置里的模型名
 * 缺 `choices` / 内容为空 → `PROVIDER_UNAVAILABLE`，让降级链接手（docs/06 §8）。
 */
export function parseOpenAIChatResponse(
  res: HttpResponse,
  config: OpenAICompatibleConfig,
): ParsedOpenAIResponse {
  const body = expectJsonObject(res, 'openai-compatible')
  const choices = body.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AppError('PROVIDER_UNAVAILABLE', {
      details: { provider: 'openai-compatible', reason: 'missing-choices' },
    })
  }

  const first = choices[0] as Record<string, unknown>
  const message = (first.message ?? {}) as Record<string, unknown>
  const text = flattenContent(message.content)
  if (text === null) {
    throw new AppError('PROVIDER_UNAVAILABLE', {
      details: { provider: 'openai-compatible', reason: 'empty-content' },
    })
  }

  const model = typeof body.model === 'string' && body.model ? body.model : config.model
  const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : undefined

  return { text, usage: parseOpenAIUsage(body.usage), model, finishReason }
}

/** content 可能是字符串，也可能是分段数组 */
export function flattenContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p === 'object') {
          const t = (p as { text?: unknown }).text
          if (typeof t === 'string') return t
        }
        return ''
      })
      .filter(Boolean)
    return parts.length ? parts.join('') : null
  }
  return null
}

/** `usage` 缺失时返回 undefined（不伪造 token 数） */
export function parseOpenAIUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const prompt = num(u.prompt_tokens ?? u.input_tokens)
  const completion = num(u.completion_tokens ?? u.output_tokens)
  const total = num(u.total_tokens)
  if (prompt === undefined && completion === undefined && total === undefined) return undefined
  const p = prompt ?? 0
  const c = completion ?? 0
  return { promptTokens: p, completionTokens: c, totalTokens: total ?? p + c }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly kind = 'openai-compatible' as const
  private readonly config: OpenAICompatibleConfig

  constructor(config: OpenAICompatibleConfig) {
    this.config = config
  }

  async healthCheck(): Promise<HealthStatus> {
    const started = Date.now()
    try {
      const res = await this.config.http.request({
        url: joinApiPath(this.config.baseUrl, '/v1/models'),
        method: 'GET',
        headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : undefined,
        timeoutMs: this.config.timeoutMs,
      })
      assertHttpOk(res, 'openai-compatible')
      return {
        ok: true,
        message: `服务可达（${this.config.baseUrl}）`,
        latencyMs: Date.now() - started,
      }
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : '服务不可达',
        latencyMs: Date.now() - started,
      }
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    // 隐私红线：不允许外发时直接拒绝，且**一个字节都不发**（docs/06 §9）
    if (!opts.allowCloud) {
      throw new AppError('PROVIDER_CLOUD_DISABLED', {
        details: { provider: this.kind, purpose: opts.purpose ?? null },
      })
    }

    const started = Date.now()
    const req = buildOpenAIChatRequest(messages, opts, this.config)
    const res = await this.config.http.request(req)
    const parsed = parseOpenAIChatResponse(res, this.config)

    return {
      text: parsed.text,
      usage: parsed.usage,
      model: parsed.model,
      provider: this.kind,
      latencyMs: Date.now() - started,
    }
  }
}
