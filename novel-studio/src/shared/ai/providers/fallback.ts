/**
 * Novel Studio · FallbackProvider（降级链 + 熔断）
 * ============================================================================
 * 设计依据：
 *   · docs/06 §3.3  「依序尝试，失败自动下一个」；熔断状态**必须在 UI 上可见**
 *   · docs/06 §8    降级矩阵：任何一层的失败都不能阻断流程
 *   · messages.ts PROVIDER_CIRCUIT_OPEN：dev 说明写「连续 5 次失败熔断 5 分钟」
 *
 * ⚠ 与 docs/06 §3.3 的一处不一致：该节正文写「连续失败 **3** 次 → 熔断 5 分钟」，
 * 而消息表（messages.ts，编号已冻结、更权威）写「连续 **5** 次」。
 * 本实现按消息表取默认值 5，并通过构造参数暴露 `failureThreshold` 以便对齐。
 *
 * 熔断语义：
 *   · 每个 Provider 独立计数；连续失败达阈值 → open(untilTs = now + cooldownMs)
 *   · open 期间**跳过该 Provider**（链上最后一个永远不跳过，它是「永远兜底」）
 *   · 冷却结束后允许一次试探（半开）：成功即恢复正常，再失败则重新计数
 *   · `getCircuitState()` 提供 UI 需要的 `{ provider, state, untilTs }`（外加剩余毫秒），
 *     严禁静默降级 —— 设置页要显示「Dify：已熔断，剩余 3:12」。
 */

import { AppError, isAppError } from '../../errors.ts'
import { LocalEchoProvider } from './local-echo.ts'
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, HealthStatus, ProviderKind } from '../types.ts'

export type CircuitStateName = 'closed' | 'open'

export interface CircuitState {
  provider: ProviderKind
  state: CircuitStateName
  /** 熔断解除的绝对时间戳（Unix 毫秒）；未熔断时为 null */
  untilTs: number | null
  /** 剩余毫秒（已按当前时间计算，UI 直接用来显示倒计时） */
  remainingMs: number
  consecutiveFailures: number
  /** 最近一次失败的错误键（如 'PROVIDER_TIMEOUT'），只记键不记正文 */
  lastErrorKey: string | null
}

export interface FallbackProviderOptions {
  /** 连续失败多少次熔断。默认 5（见文件头说明） */
  failureThreshold?: number
  /** 熔断时长，默认 5 分钟 */
  cooldownMs?: number
  /** 注入时钟（测试用） */
  now?: () => number
  /** 熔断状态变化回调 —— UI 用它弹「已降级」提示，不许静默 */
  onCircuitChange?: (state: CircuitState) => void
}

interface CircuitRecord {
  consecutiveFailures: number
  untilTs: number | null
  lastErrorKey: string | null
}

export interface RouteAttempt {
  provider: ProviderKind
  /** 'success' | 'error' | 'skipped-circuit' */
  outcome: 'success' | 'error' | 'skipped-circuit'
  errorKey?: string
  latencyMs?: number
}

export class FallbackProvider implements AIProvider {
  private readonly providers: AIProvider[]
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private readonly onCircuitChange: ((state: CircuitState) => void) | undefined
  private readonly circuits = new Map<ProviderKind, CircuitRecord>()
  private lastRoute: RouteAttempt[] = []
  private counters = {
    calls: 0,
    failures: 0,
    successOnPrimary: 0,
    fallbacks: 0,
    skippedDueToCircuit: 0,
  }

  constructor(providers: AIProvider[], options: FallbackProviderOptions = {}) {
    if (providers.length === 0) {
      throw new AppError('INTERNAL', { details: { reason: 'empty-provider-chain' } })
    }
    this.providers = [...providers]
    this.threshold = Math.max(1, options.failureThreshold ?? 5)
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 5 * 60_000)
    this.now = options.now ?? Date.now
    this.onCircuitChange = options.onCircuitChange

    for (const p of this.providers) {
      if (!this.circuits.has(p.kind)) {
        this.circuits.set(p.kind, { consecutiveFailures: 0, untilTs: null, lastErrorKey: null })
      }
    }
  }

  /**
   * 链上「当前生效」的 Provider 类型。
   *
   * docs/06 §3.1 的 `ProviderKind` 没有 'fallback' 这一档，而 `ChatResult.provider`
   * 语义是「真正作答的那个」，因此这里返回链上第一个未熔断者；
   * 每次返回的 `ChatResult.provider` 才是权威答案（降级链下可能是兜底）。
   */
  get kind(): ProviderKind {
    for (const p of this.providers) {
      if (!this.isOpen(p.kind)) return p.kind
    }
    return this.providers[this.providers.length - 1].kind
  }

  /** 链上所有 Provider 的类型（设置页展示用） */
  get chain(): ProviderKind[] {
    return this.providers.map((p) => p.kind)
  }

  /** 最近一次调用的路由轨迹（哪几个被尝试、谁失败、谁最终作答），用于诊断展示 */
  getLastRoute(): RouteAttempt[] {
    return [...this.lastRoute]
  }

  getStats(): typeof this.counters {
    return { ...this.counters }
  }

  /**
   * 主 Provider 的熔断状态（UI 直接读它显示倒计时）。
   * 需要全部状态时用 `getCircuitStates()`。
   */
  getCircuitState(): CircuitState {
    return this.getCircuitStateOf(this.providers[0].kind)
  }

  /** 链上所有 Provider 的熔断状态 */
  getCircuitStates(): CircuitState[] {
    return this.providers.map((p) => this.getCircuitStateOf(p.kind))
  }

  /** 指定 Provider 的熔断状态 */
  getCircuitStateOf(kind: ProviderKind): CircuitState {
    const rec = this.circuits.get(kind) ?? { consecutiveFailures: 0, untilTs: null, lastErrorKey: null }
    const nowTs = this.now()
    const open = rec.untilTs !== null && nowTs < rec.untilTs
    return {
      provider: kind,
      state: open ? 'open' : 'closed',
      untilTs: open ? rec.untilTs : null,
      remainingMs: open && rec.untilTs !== null ? rec.untilTs - nowTs : 0,
      consecutiveFailures: rec.consecutiveFailures,
      lastErrorKey: rec.lastErrorKey,
    }
  }

  /** 手动复位（用户点「立即重试」时用） */
  resetCircuit(kind?: ProviderKind): void {
    for (const [k, rec] of this.circuits) {
      if (kind && k !== kind) continue
      rec.consecutiveFailures = 0
      rec.untilTs = null
      rec.lastErrorKey = null
    }
  }

  private isOpen(kind: ProviderKind): boolean {
    const rec = this.circuits.get(kind)
    if (!rec || rec.untilTs === null) return false
    if (this.now() < rec.untilTs) return true
    // 冷却结束 → 半开试探：清掉熔断标记，但失败计数保留为阈值-1，
    // 这样「刚恢复就再失败」会立刻重新熔断，而不是又要攒满 5 次。
    rec.untilTs = null
    rec.consecutiveFailures = Math.max(0, this.threshold - 1)
    return false
  }

  private recordFailure(kind: ProviderKind, errorKey: string): void {
    const rec = this.circuits.get(kind) ?? { consecutiveFailures: 0, untilTs: null, lastErrorKey: null }
    rec.consecutiveFailures += 1
    rec.lastErrorKey = errorKey
    if (rec.consecutiveFailures >= this.threshold) {
      rec.untilTs = this.now() + this.cooldownMs
      this.onCircuitChange?.(this.getCircuitStateOf(kind))
    }
    this.circuits.set(kind, rec)
  }

  private recordSuccess(kind: ProviderKind): void {
    const rec = this.circuits.get(kind)
    if (!rec) return
    const wasBroken = rec.consecutiveFailures > 0 || rec.untilTs !== null
    rec.consecutiveFailures = 0
    rec.untilTs = null
    if (wasBroken) this.onCircuitChange?.(this.getCircuitStateOf(kind))
  }

  async healthCheck(): Promise<HealthStatus> {
    const results: Array<{ kind: ProviderKind; ok: boolean; message: string; latencyMs?: number }> = []
    for (const p of this.providers) {
      try {
        const st = await p.healthCheck()
        results.push({ kind: p.kind, ok: st.ok, message: st.message, latencyMs: st.latencyMs })
      } catch (e) {
        results.push({ kind: p.kind, ok: false, message: isAppError(e) ? e.key : '探测失败' })
      }
    }
    const ok = results.some((r) => r.ok)
    return {
      ok,
      message: results.map((r) => `${r.kind}:${r.ok ? '可用' : '不可用'}`).join('；'),
      latencyMs: results.reduce((n, r) => n + (r.latencyMs ?? 0), 0),
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    this.counters.calls++
    const attempts: RouteAttempt[] = []
    const errors: AppError[] = []

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]
      const isLastResort = i === this.providers.length - 1

      // 熔断期间跳过（兜底永不跳过：docs/06 §3.3「期间只用兜底」）
      if (!isLastResort && this.isOpen(provider.kind)) {
        this.counters.skippedDueToCircuit++
        attempts.push({ provider: provider.kind, outcome: 'skipped-circuit' })
        continue
      }

      const started = this.now()
      try {
        const result = await provider.chat(messages, opts)
        this.recordSuccess(provider.kind)
        if (i === 0) this.counters.successOnPrimary++
        else this.counters.fallbacks++
        attempts.push({
          provider: provider.kind,
          outcome: 'success',
          latencyMs: this.now() - started,
        })
        this.lastRoute = attempts
        return result
      } catch (e) {
        const err = isAppError(e) ? e : new AppError('PROVIDER_UNAVAILABLE', { cause: e })

        // 取消不是错误：立刻冒泡，不计数、不降级（docs/22 TASK_CANCELLED 纪律）
        if (err.isCancelled) {
          attempts.push({ provider: provider.kind, outcome: 'error', errorKey: err.key })
          this.lastRoute = attempts
          throw err
        }

        // 隐私拦截属于「用户配置」而非「服务故障」，不计入熔断
        if (err.key === 'PROVIDER_CLOUD_DISABLED') {
          attempts.push({ provider: provider.kind, outcome: 'error', errorKey: err.key })
          this.lastRoute = attempts
          throw err
        }

        this.counters.failures++
        this.recordFailure(provider.kind, err.key)
        errors.push(err)
        attempts.push({ provider: provider.kind, outcome: 'error', errorKey: err.key })
      }
    }

    this.lastRoute = attempts
    // 全部失败：抛主 Provider 的错误（保留语义键，UI 才能给出正确动作按钮）
    const primary = errors[0]
    if (primary) {
      throw new AppError(primary.key, {
        params: primary.params,
        retryable: primary.retryable,
        cause: primary,
        details: {
          ...(primary.details ?? {}),
          chain: this.chain,
          attempted: attempts.map((a) => `${a.provider}:${a.outcome}`),
        },
      })
    }
    throw new AppError('PROVIDER_UNAVAILABLE', { details: { chain: this.chain } })
  }
}

/**
 * 便捷构造：`[主 Provider, ..., LocalEchoProvider]` 的降级链。
 * 与 docs/06 §3.3 的示例一致 —— **末尾永远追加 LocalEcho**。
 */
export function createFallbackChain(
  primary: AIProvider | AIProvider[],
  options: FallbackProviderOptions = {},
  bottom: AIProvider = new LocalEchoProvider(),
): FallbackProvider {
  const list = Array.isArray(primary) ? [...primary] : [primary]
  if (list[list.length - 1]?.kind !== bottom.kind) list.push(bottom)
  return new FallbackProvider(list, options)
}
