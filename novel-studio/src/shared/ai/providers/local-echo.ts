/**
 * Novel Studio · LocalEchoProvider（永远兜底）
 * ============================================================================
 * 设计依据：
 *   · docs/06 §3.2  「LocalEchoProvider：降级占位：返回『无法判定』而非报错」
 *   · docs/06 §3.3  降级链末尾「永远追加 LocalEchoProvider」
 *   · docs/06 §8    降级矩阵：LLM 不可达时功能退化为「规则 + 人工」，而不是报错罢工
 *
 * 铁律：**它永不抛错**。
 *   · `allowCloud=false` 也不会抛错（它本来就不外发），只是照常返回「无法判定」。
 *   · 上层拿到 `undetermined: true` 后应退回 L1 规则结果 + 人工队列。
 */

import type { AIProvider, ChatMessage, ChatOptions, ChatResult, HealthStatus } from '../types.ts'
import { isUndeterminedAnswer, UNDETERMINED_MARKER, type UndeterminedAnswer } from '../types.ts'
import { estimateTokens } from '../usage.ts'

export interface LocalEchoProviderOptions {
  /** 无法判定的原因文案（会出现在 UI 的降级提示里，不要写技术名词） */
  reason?: string
  /** 本地无法判定的附加标记（例如 'model-missing' / 'cloud-disabled'） */
  cause?: string
}

export class LocalEchoProvider implements AIProvider {
  readonly kind = 'local' as const
  private readonly reason: string
  private readonly cause: string

  constructor(options: LocalEchoProviderOptions = {}) {
    this.reason = options.reason ?? '本地未启用 AI Provider，无法自动判定'
    this.cause = options.cause ?? 'local-only'
  }

  /** 供调用方直接构造一个「无法判定」答案（不经过 chat 的快捷方式） */
  static undetermined(reason?: string): UndeterminedAnswer {
    return {
      undetermined: true,
      reason: reason ?? '本地未启用 AI Provider，无法自动判定',
      confidence: 0,
    }
  }

  /** 判断一段返回文本是不是「无法判定」（上层据此退回规则结果） */
  static isUndetermined(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    if (!t.includes(UNDETERMINED_MARKER)) return false
    try {
      return isUndeterminedAnswer(JSON.parse(t))
    } catch {
      return false
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      ok: true,
      message: `本地降级占位可用（${this.cause}）：不会判定，只会明确说「无法判定」`,
      latencyMs: 0,
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const started = Date.now()
    const answer = LocalEchoProvider.undetermined(this.reason)

    // 有 schema 时也返回合法 JSON（多余的字段由 schema 校验层忽略/拒绝，
    // 上层应当用 isUndeterminedAnswer 短路，而不是硬套 schema）
    const text = JSON.stringify({
      ...answer,
      ...(opts.jsonSchema ? { schemaRequested: opts.jsonSchema.type ?? 'object' } : {}),
    })

    const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0)
    return {
      text,
      usage: {
        promptTokens,
        completionTokens: estimateTokens(text),
        totalTokens: promptTokens + estimateTokens(text),
      },
      model: 'local-echo',
      provider: this.kind,
      latencyMs: Date.now() - started,
    }
  }
}

/**
 * 便捷判定：任何 Provider 的返回文本是否表示「无法判定」。
 * 放进 structured 链路之前先调用它，能避免把「无法判定」当成校验失败去重试 3 次。
 */
export function isUndeterminedResultText(text: string): boolean {
  return LocalEchoProvider.isUndetermined(text)
}
