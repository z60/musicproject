/**
 * Novel Studio · MockProvider
 * ============================================================================
 * 设计依据：docs/06 §3.2 实现清单（MockProvider：开发/测试/演示；返回可预测的假数据）
 *
 * 契约（测试守护这一点）：
 *   · **同输入 ⇒ 同输出**（对 `messages + 影响行为的选项` 做 sha256 派生，无随机数、无时间参与）
 *   · 不联网、不需要 API Key、不依赖任何模型文件
 *   · 默认 `ai.provider='mock'` 时的开箱可用实现（docs/06 §9「默认不外发」）
 *
 * 不要把它当成真实语义模型：它只会做哈希与字符串拼接。
 */

import type { AIProvider, ChatMessage, ChatOptions, ChatResult, HealthStatus, JsonSchema } from '../types.ts'
import { sha256Hex, shortHash, stableStringify, estimateTokens } from '../usage.ts'

export interface MockProviderOptions {
  /** 展示用的模型名 */
  model?: string
  /**
   * 固定应答表：key 可以是 `purpose`（如 'attribution_review'）或 '*'
   * 命中时直接返回该文本，方便测试与演示构造确定的期望结果。
   */
  responses?: Record<string, string>
  /** 人工制造延迟（毫秒）；默认 0，保证测试快 */
  latencyMs?: number
  /** 每次调用前的钩子（录制回放测试用） */
  onChat?: (info: { messages: ChatMessage[]; opts: ChatOptions }) => void
}

export class MockProvider implements AIProvider {
  readonly kind = 'mock' as const
  private readonly model: string
  private readonly responses: Record<string, string>
  private readonly latencyMs: number
  private readonly onChat: ((info: { messages: ChatMessage[]; opts: ChatOptions }) => void) | undefined

  constructor(options: MockProviderOptions = {}) {
    this.model = options.model ?? 'mock-1'
    this.responses = options.responses ?? {}
    this.latencyMs = options.latencyMs ?? 0
    this.onChat = options.onChat
  }

  /** 设置/覆盖固定应答（演示与测试用） */
  setResponse(key: string, text: string): void {
    this.responses[key] = text
  }

  async healthCheck(): Promise<HealthStatus> {
    const started = Date.now()
    const probe = this.render([{ role: 'user', content: 'health' }], { allowCloud: false })
    return {
      ok: probe.length > 0,
      message: `Mock Provider 可用（本地假数据，不联网）；样例指纹 ${shortHash(probe)}`,
      latencyMs: Date.now() - started,
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const started = Date.now()
    this.onChat?.({ messages, opts })

    const canned = this.pickCanned(opts)
    const text = canned ?? this.render(messages, opts)

    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs))
    }

    const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0)
    return {
      text,
      usage: {
        promptTokens,
        completionTokens: estimateTokens(text),
        totalTokens: promptTokens + estimateTokens(text),
      },
      model: opts.model ?? this.model,
      provider: this.kind,
      latencyMs: Date.now() - started,
    }
  }

  private pickCanned(opts: ChatOptions): string | undefined {
    if (opts.purpose && this.responses[opts.purpose] !== undefined) return this.responses[opts.purpose]
    if (this.responses['*'] !== undefined) return this.responses['*']
    return undefined
  }

  /**
   * 确定性渲染：指纹只由「消息 + 影响输出的选项」决定。
   * `signal` / 时间 / 随机数一律不参与，否则测试会间歇性失败。
   */
  private render(messages: ChatMessage[], opts: ChatOptions): string {
    const fingerprint = shortHash(
      stableStringify({
        messages: messages.map((m) => [m.role, m.content]),
        purpose: opts.purpose ?? null,
        model: opts.model ?? this.model,
        jsonSchema: opts.jsonSchema ?? null,
      }),
      12,
    )

    if (opts.jsonSchema) {
      // 有 schema 时返回一个「形状正确但内容为占位」的 JSON，
      // 让上层结构化链路在 Mock 模式下也能跑通（字段值仍是确定性的）。
      return JSON.stringify(this.fakeBySchema(opts.jsonSchema, fingerprint))
    }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const head = lastUser.replace(/\s+/g, ' ').slice(0, 40)
    return `【Mock#${fingerprint}】${head}`
  }

  /** 按 schema 生成确定性占位值（不追求语义，只保证类型/枚举合法） */
  private fakeBySchema(schema: JsonSchema, fingerprint: string): unknown {
    switch (schema.type) {
      case 'object': {
        const out: Record<string, unknown> = {}
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
          out[key] = this.fakeBySchema(sub, `${fingerprint}:${key}`)
        }
        return out
      }
      case 'array':
        return [this.fakeBySchema(schema.items ?? { type: 'string' }, fingerprint)]
      case 'number':
      case 'integer':
        return schema.minimum ?? 0
      case 'boolean':
        return true
      case 'null':
        return null
      default: {
        if (schema.enum?.length) return schema.enum[0]
        return `mock-${sha256Hex(fingerprint).slice(0, 6)}`
      }
    }
  }
}
