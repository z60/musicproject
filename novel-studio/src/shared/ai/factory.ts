/**
 * Novel Studio · Provider 工厂与降级链组装
 * ============================================================================
 * 设计依据：docs/06 §3.3 工厂与降级链
 *
 * ```ts
 * const provider = resolveProvider(settings.ai)   // 内部已带 FallbackProvider 与 LocalEcho 兜底
 * const res = await provider.chat(msgs, createChatOptions(settings.ai, { purpose: 'attribution_review' }))
 * ```
 *
 * **末尾永远追加 LocalEchoProvider**：没有 AI，用户仍然能完成全流程（docs/06 §1）。
 * 配置不全时不会静默降级 —— 会挂一个「明确报错」的占位 Provider，
 * 让熔断状态与错误码都能出现在设置页上。
 */

import { AppError } from '../errors.ts'
import type { AiSettings, AIProvider, ChatOptions, HealthStatus, HttpClient, ProviderKind } from './types.ts'
import { LocalEchoProvider } from './providers/local-echo.ts'
import { MockProvider } from './providers/mock.ts'
import { DifyProvider } from './providers/dify.ts'
import { OpenAICompatibleProvider } from './providers/openai-compatible.ts'
import { FallbackProvider, type FallbackProviderOptions } from './providers/fallback.ts'
import { createFetchHttpClient } from './http.ts'

export interface ResolveProviderOptions {
  /** 注入 HTTP 客户端（测试用 fake；不传则用内置 fetch 实现） */
  http?: HttpClient
  /**
   * 云端 Provider 的 API Key。
   *
   * ⚠ 契约缺口：`AppSettings['ai']` 里**没有** apiKey 字段（也没有 keyRef），
   * 密钥应由主进程用 `safeStorage` 加密后单独存放（docs/04 §8.2 的「安全存储」），
   * 因此这里由调用方注入，而不是从 settings 里读。
   */
  apiKey?: string | null
  /** Dify 工作流变量（`inputs`） */
  difyInputs?: Record<string, unknown>
  /** Dify 的匿名 user（默认由 API Key 指纹派生） */
  difyUserId?: string
  /** 熔断参数（默认 5 次 / 5 分钟，见 fallback.ts 的说明） */
  circuit?: { failureThreshold?: number; cooldownMs?: number; now?: () => number }
  /** 熔断状态变化回调（UI 必须可见，不许静默降级） */
  onCircuitChange?: FallbackProviderOptions['onCircuitChange']
  /** 覆盖 MockProvider 的固定应答（演示/测试） */
  mockResponses?: Record<string, string>
}

/**
 * 配置不全时的占位 Provider：**如实报错**，而不是假装能用。
 * 连续失败达阈值后会被 FallbackProvider 熔断，于是设置页会显示「已熔断」，
 * 用户能立刻看到是配置问题，而不是「AI 没反应」。
 */
class MisconfiguredProvider implements AIProvider {
  readonly kind: ProviderKind
  private readonly reason: string

  constructor(kind: ProviderKind, reason: string) {
    this.kind = kind
    this.reason = reason
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: false, message: this.reason }
  }

  async chat(): Promise<never> {
    throw new AppError('PROVIDER_UNAVAILABLE', {
      details: { provider: this.kind, reason: 'misconfigured', message: this.reason },
    })
  }
}

/**
 * 只解析**主** Provider（不含 LocalEcho 兜底、不包 FallbackProvider）。
 *
 * 存在的理由（设置页「测试连接」）：`FallbackProvider.healthCheck()` 的语义是
 * `some(ok)`，而链尾永远有 LocalEcho（`ok: true`）—— 直接拿降级链做连通性测试
 * 会**永远显示「连接成功」**，把「云端地址填错/密钥无效」这类问题全部掩盖。
 * 测试连接必须只探用户真正配置的那一个 Provider。
 */
export function resolvePrimaryProvider(settings: AiSettings, options: ResolveProviderOptions = {}): AIProvider {
  const http = options.http ?? createFetchHttpClient()

  switch (settings.provider) {
    case 'dify': {
      if (!settings.baseUrl) return new MisconfiguredProvider('dify', '尚未填写 Dify 服务地址')
      if (!options.apiKey) return new MisconfiguredProvider('dify', '尚未填写 Dify 应用密钥（app-xxx）')
      return new DifyProvider({
        baseUrl: settings.baseUrl,
        apiKey: options.apiKey,
        model: settings.model,
        inputs: options.difyInputs,
        userId: options.difyUserId,
        timeoutMs: settings.timeoutMs,
        http,
      })
    }
    case 'openai-compatible': {
      if (!settings.baseUrl) return new MisconfiguredProvider('openai-compatible', '尚未填写兼容服务地址')
      return new OpenAICompatibleProvider({
        baseUrl: settings.baseUrl,
        apiKey: options.apiKey ?? null,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        http,
      })
    }
    case 'local':
      return new LocalEchoProvider()
    case 'mock':
      return new MockProvider({ model: settings.model, responses: options.mockResponses })
    default:
      throw new AppError('INVALID_PAYLOAD', {
        details: { field: 'ai.provider', value: String(settings.provider) },
      })
  }
}

/**
 * 按 `settings.ai.provider` 组装降级链（docs/06 §3.3）。
 *
 * | provider | 链 |
 * |----------|----|
 * | `dify`              | [Dify, LocalEcho] |
 * | `openai-compatible` | [OpenAICompatible, LocalEcho] |
 * | `local`             | [LocalEcho] |
 * | `mock`              | [Mock, LocalEcho] |
 */
export function resolveProvider(settings: AiSettings, options: ResolveProviderOptions = {}): AIProvider {
  const primary = resolvePrimaryProvider(settings, options)
  const chain: AIProvider[] = [primary]

  // 永远兜底（docs/06 §3.3）
  if (primary.kind !== 'local') chain.push(new LocalEchoProvider())

  return new FallbackProvider(chain, {
    failureThreshold: options.circuit?.failureThreshold,
    cooldownMs: options.circuit?.cooldownMs,
    now: options.circuit?.now,
    onCircuitChange: options.onCircuitChange,
  })
}

/**
 * 由设置生成 ChatOptions。
 *
 * **隐私红线**：`allowCloud` 严格等于 `ai.allowSendTextToCloud`，
 * 默认 false；任何外发路径都必须在 Provider 层再拦一次（docs/06 §9）。
 */
export function createChatOptions(
  settings: AiSettings,
  overrides: Partial<Omit<ChatOptions, 'allowCloud'>> & { allowCloud?: boolean } = {},
): ChatOptions {
  const { allowCloud, ...rest } = overrides
  return {
    temperature: 0.2,
    timeoutMs: settings.timeoutMs,
    model: settings.model || undefined,
    ...rest,
    allowCloud: allowCloud ?? settings.allowSendTextToCloud,
  }
}

/** 设置页「当前链路」摘要：`Dify → 本地兜底` */
export function describeProviderChain(provider: AIProvider): string {
  const chain = provider instanceof FallbackProvider ? provider.chain : [provider.kind]
  return chain.map(providerKindLabel).join(' → ')
}

export function providerKindLabel(kind: ProviderKind): string {
  switch (kind) {
    case 'mock':
      return 'Mock（本地假数据）'
    case 'local':
      return '本地兜底（只报无法判定）'
    case 'openai-compatible':
      return 'OpenAI 兼容'
    case 'dify':
      return 'Dify'
  }
}
