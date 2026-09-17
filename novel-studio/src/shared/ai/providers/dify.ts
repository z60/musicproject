/**
 * Novel Studio · Dify Provider
 * ============================================================================
 * 设计依据：docs/06 §3.4「Dify 适配要点」差异表 —— 本文件逐行落实那张表：
 *
 * | 差异     | Dify                                              | 本实现 |
 * |----------|---------------------------------------------------|--------|
 * | 对话接口 | `POST /v1/chat-messages`（query+inputs+conversation_id+user） | buildDifyChatRequest |
 * | 响应形态 | `answer` 字段；模型名在 `metadata.model.name`        | parseDifyChatResponse |
 * | 会话     | 传 `conversation_id` 维持上下文；也可每次新建        | ChatOptions.reuseConversation（**默认新建**） |
 * | 阻塞模式 | 必须 `response_mode: 'blocking'` 才是同步返回        | 恒定写入 |
 * | 鉴权     | `Authorization: Bearer {app-xxx}`（应用级 Key）      | config.apiKey |
 * | 输入变量 | 通过 `inputs` 传工作流变量                           | config.inputs |
 *
 * **上下文污染警告（docs/06 §3.4 原文）**：Dify 的 `conversation_id` 会累积上下文，
 * 用在批量逐行判定时会导致「第 500 行的判定被第 1 行影响」。
 * 因此 `reuseConversation` 默认为 **false**：批量判定每次新建会话，
 * 把上下文**显式**放进 prompt（见 prompts/templates.ts 的 `attribution_review`）。
 *
 * 与 docs 的一处不一致（已在报告里记录）：§3.4 差异表写 `/v1/chat-messages`，
 * 而同节的示例代码写 `${baseUrl}/chat-messages`。本实现按「差异表」为准，
 * 并在 baseUrl 已带 `/v1` 时自动去重（见 joinApiPath）。
 */

import { AppError } from '../../errors.ts'
import { expectJsonObject } from '../http.ts'
import { sha256Hex } from '../usage.ts'
import { joinApiPath } from './openai-compatible.ts'
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

export interface DifyConfig {
  /** 例如 `https://api.dify.ai`（也可直接写 `https://api.dify.ai/v1`） */
  baseUrl: string
  /** Dify **应用级** Key（`app-xxx`），不是账号 Key */
  apiKey: string
  /** Fallback 用的模型名：Dify 的模型名在响应里，取不到时才用它 */
  model?: string
  /**
   * 工作流变量（`inputs`）。Dify 的 Chatflow/Workflow 需要在这里传定义好的变量，
   * 例如 `{ project: '斗破苍穹', chapter: '第1章' }`。
   */
  inputs?: Record<string, unknown>
  /**
   * 稳定的**匿名**用户标识（docs/06 §3.4：不传真实身份）。
   * 默认由 API Key 指纹派生，保证同一安装稳定、且不泄露任何个人信息。
   */
  userId?: string
  timeoutMs?: number
  http: HttpClient
  headers?: Record<string, string>
}

/** 匿名 user id：sha256(apiKey) 前 16 位。稳定、不可逆、不含身份信息 */
export function deriveAnonymousUserId(apiKey: string): string {
  return `ns-${sha256Hex(apiKey).slice(0, 16)}`
}

/**
 * 把 messages 折叠成单个 `query`（docs/06 §3.4 的适配策略）。
 * system 作为前缀，其余按角色拼装 —— Dify 没有 messages 数组概念。
 */
export function foldMessagesToQuery(messages: ChatMessage[]): string {
  const systems = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')
  const head = systems.map((m) => m.content).join('\n\n')
  const body = rest.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
  return head ? `${head}\n\n${body}` : body
}

/**
 * 构建 `POST {baseUrl}/v1/chat-messages` 请求（纯函数）。
 *
 * `conversation_id` 的处理是本文件最关键的一行：
 *   · `opts.reuseConversation !== true`（默认）→ **完全不写该字段**，即每次新建会话
 *   · `reuseConversation === true` 且有历史 → 带上，维持单轮持续追问的上下文
 */
export function buildDifyChatRequest(
  messages: ChatMessage[],
  opts: ChatOptions,
  config: DifyConfig,
  conversationId: string | null = null,
): HttpRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    ...(config.headers ?? {}),
  }

  const body: Record<string, unknown> = {
    query: foldMessagesToQuery(messages),
    inputs: config.inputs ?? {},
    // 阻塞模式：Dify 只有 blocking 才是同步返回（差异表第 5 行）
    response_mode: 'blocking',
    user: config.userId ?? deriveAnonymousUserId(config.apiKey),
  }
  if (opts.reuseConversation === true && conversationId) {
    body.conversation_id = conversationId
  }

  return {
    url: joinApiPath(config.baseUrl, '/v1/chat-messages'),
    method: 'POST',
    headers,
    body,
    timeoutMs: opts.timeoutMs ?? config.timeoutMs,
    signal: opts.signal,
  }
}

export interface ParsedDifyResponse {
  text: string
  model: string
  usage?: ChatUsage
  conversationId: string | null
  messageId: string | null
  event: string | null
}

/**
 * 解析 Dify 响应（纯函数）：
 *   · 正文取自 `answer`（缺失时退化到工作流形态 `data.outputs`，见差异表第 2 行）
 *   · 模型名取自 `metadata.model.name`（差异表第 2 行）
 *   · usage 取自 `metadata.usage`
 *   · `conversation_id` 回传，供 reuseConversation 模式续接
 */
export function parseDifyChatResponse(res: HttpResponse, config: DifyConfig): ParsedDifyResponse {
  const body = expectJsonObject(res, 'dify')

  const event = typeof body.event === 'string' ? body.event : null
  if (event === 'error') {
    throw new AppError('PROVIDER_UNAVAILABLE', {
      details: {
        provider: 'dify',
        reason: 'dify-error-event',
        status: typeof body.status === 'number' ? body.status : res.status,
      },
    })
  }

  const metadata = (body.metadata ?? {}) as Record<string, unknown>
  const modelInfo = (metadata.model ?? {}) as Record<string, unknown>
  const model =
    (typeof modelInfo.name === 'string' && modelInfo.name) ||
    (typeof body.model === 'string' && body.model) ||
    config.model ||
    'dify'

  let text: string | null = typeof body.answer === 'string' ? body.answer : null
  if (text === null) {
    // Workflow 应用返回 data.outputs；取其中第一个字符串值，够用且不猜结构
    const data = body.data as Record<string, unknown> | undefined
    const outputs = data?.outputs as Record<string, unknown> | undefined
    if (outputs && typeof outputs === 'object') {
      const firstString = Object.values(outputs).find((v) => typeof v === 'string')
      if (typeof firstString === 'string') text = firstString
    }
  }
  if (text === null) {
    throw new AppError('PROVIDER_UNAVAILABLE', {
      details: { provider: 'dify', reason: 'missing-answer', event },
    })
  }

  return {
    text,
    model,
    usage: parseDifyUsage(metadata.usage),
    conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : null,
    messageId: typeof body.message_id === 'string' ? body.message_id : null,
    event,
  }
}

export function parseDifyUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined
  const completion = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined
  const total = typeof u.total_tokens === 'number' ? u.total_tokens : undefined
  if (prompt === undefined && completion === undefined && total === undefined) return undefined
  const p = prompt ?? 0
  const c = completion ?? 0
  return { promptTokens: p, completionTokens: c, totalTokens: total ?? p + c }
}

export class DifyProvider implements AIProvider {
  readonly kind = 'dify' as const
  private readonly config: DifyConfig
  /** 仅在 `reuseConversation: true` 时被写入 */
  private conversationId: string | null = null

  constructor(config: DifyConfig) {
    this.config = config
  }

  /** 当前持有的会话 id（批量判定模式下应恒为 null） */
  get currentConversationId(): string | null {
    return this.conversationId
  }

  /** 手动丢弃会话（用户点「重新开始对话」时用） */
  resetConversation(): void {
    this.conversationId = null
  }

  async healthCheck(): Promise<HealthStatus> {
    const started = Date.now()
    try {
      const res = await this.config.http.request({
        url: joinApiPath(this.config.baseUrl, '/v1/parameters'),
        method: 'GET',
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        timeoutMs: this.config.timeoutMs,
      })
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, message: `Dify 应用可达（${this.config.baseUrl}）`, latencyMs: Date.now() - started }
      }
      return {
        ok: false,
        message: res.status === 401 || res.status === 403 ? '应用密钥无效或已过期' : `服务返回 ${res.status}`,
        latencyMs: Date.now() - started,
      }
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : 'Dify 服务不可达',
        latencyMs: Date.now() - started,
      }
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    // 隐私红线：allowCloud=false 时**直接抛错且不发任何网络请求**（docs/06 §8/§9）
    if (!opts.allowCloud) {
      throw new AppError('PROVIDER_CLOUD_DISABLED', {
        details: { provider: this.kind, purpose: opts.purpose ?? null },
      })
    }

    const reuse = opts.reuseConversation === true
    const started = Date.now()
    const req = buildDifyChatRequest(messages, opts, this.config, reuse ? this.conversationId : null)
    const res = await this.config.http.request(req)
    const parsed = parseDifyChatResponse(res, this.config)

    // 只有显式要求复用时才记住会话；批量判定路径下永远保持 null，
    // 避免「某一次调用偶然开了会话」污染后续所有判定（docs/06 §3.4）。
    if (reuse && parsed.conversationId) this.conversationId = parsed.conversationId

    return {
      text: parsed.text,
      usage: parsed.usage,
      model: parsed.model,
      provider: this.kind,
      latencyMs: Date.now() - started,
    }
  }
}
