/**
 * Novel Studio · AI 调用预算控制（docs/06 §7.2）
 * ============================================================================
 * 设计依据：
 *   · docs/06 §7.2「预算上限：设置项：单次任务最大调用次数 / 最大 token
 *                   （默认不限制但**显示预估消耗**）」
 *   · docs/06 §7.2「明确告知：首次调用云端前弹窗：本次将发送约 N 行、约 M 字，是否继续？」
 *   · docs/06 §7.2「批量提交：一次 20 行」
 *
 * 两条纪律：
 *   1. **默认不限制**：`UNLIMITED_BUDGET`；限制是用户主动设的。
 *   2. **必须能显示预估消耗**：即便不限制，也要能算出「这次操作大概要多少次调用、多少 token、多少钱」。
 *
 * ⚠ 契约缺口（已记录在交付报告中）：messages.ts 里**没有**「AI 预算超限」的语义键
 * （6xxx AI 段只有 PROVIDER_*、MODEL_* / AI_INVALID_OUTPUT 等）。
 * 因此本层**不抛错**，只返回结构化的 `{ ok: false, reason }`，
 * 由调用方停止批次并在任务报告里说明。建议后续在 6xxx 段末追加 `AI_BUDGET_EXCEEDED`。
 */

import type { ChatUsage } from './types.ts'
import { estimateCost, estimateTokens, type CostEstimate, type ModelPricing } from './usage.ts'

export interface AiBudgetLimits {
  /** 单任务最大调用次数；null = 不限 */
  maxCalls: number | null
  /** 单任务最大 token（prompt + completion）；null = 不限 */
  maxTokens: number | null
}

/** 默认：不限制（docs/06 §7.2） */
export const UNLIMITED_BUDGET: AiBudgetLimits = { maxCalls: null, maxTokens: null }

// ============================================================================
// 预估消耗
// ============================================================================

export interface EstimateConsumptionInput {
  /** 本次任务要处理的行数 */
  lines: number
  /** 单行平均字数（含上下文的话请用 effectiveCharsPerLine） */
  avgCharsPerLine: number
  /** 上下文行数（前后各 N 行，docs/06 §7.2 默认 2） */
  contextLines?: number
  /** 每批行数，默认 20（docs/06 §7.2） */
  batchSize?: number
  /** 每次调用都要重复的固定开销（角色表 + 说明 + schema），字符数 */
  fixedPromptChars?: number
  /** 单行平均输出字符数（结构化 JSON 比原文长），默认 60 */
  avgOutputCharsPerLine?: number
  /** 用于成本估算的模型名 */
  model?: string
  /** 自定义价目表 */
  pricingTable?: Readonly<Record<string, ModelPricing>>
}

export interface ConsumptionEstimate {
  /** 预计调用次数 */
  calls: number
  batches: number
  /** 实际发送的字符数（用于「明确告知」弹窗：本次将发送约 M 字） */
  sentChars: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: CostEstimate | null
  /** 给用户看的一句话，可直接放进确认弹窗 */
  summary: string
}

/** 单行发送字符数（含上下文）：`chars * (1 + 2*contextLines)` */
export function effectiveCharsPerLine(avgCharsPerLine: number, contextLines = 2): number {
  return avgCharsPerLine * (1 + 2 * Math.max(0, contextLines))
}

/**
 * 预估一次任务的调用次数与 token 消耗（**纯本地计算，不联网**）。
 *
 * 公式：
 *   batches = ceil(lines / batchSize)
 *   promptTokens ≈ Σ estimateTokens(每批内容) + 固定开销
 *   completionTokens ≈ estimateTokens(输出预览)
 */
export function estimateConsumption(input: EstimateConsumptionInput): ConsumptionEstimate {
  const batchSize = Math.max(1, input.batchSize ?? 20)
  const lines = Math.max(0, Math.floor(input.lines))
  const fixed = Math.max(0, input.fixedPromptChars ?? 0)
  const perLine = effectiveCharsPerLine(input.avgCharsPerLine, input.contextLines ?? 2)

  const batches = lines === 0 ? 0 : Math.ceil(lines / batchSize)
  const sentChars = Math.round(lines * perLine)

  let promptTokens = 0
  let completionTokens = 0
  const avgOutputChars = Math.max(0, input.avgOutputCharsPerLine ?? 60)

  for (let i = 0; i < batches; i++) {
    const batchLines = Math.min(batchSize, lines - i * batchSize)
    const promptChars = fixed + batchLines * perLine
    // estimateTokens 的处理单位是「一段文本」：用字符数还原成等价文本长度即可
    promptTokens += estimateTokens('字'.repeat(Math.round(promptChars)))
    completionTokens += estimateTokens('字'.repeat(Math.round(batchLines * avgOutputChars)))
  }

  const totalTokens = promptTokens + completionTokens
  const cost =
    input.model !== undefined
      ? estimateCost(
          input.model,
          { promptTokens, completionTokens },
          input.pricingTable,
        )
      : null

  const summary =
    lines === 0
      ? '本次没有需要处理的行'
      : `本次将处理约 ${lines} 行（约 ${sentChars} 字），预计 ${batches} 次调用、` +
        `${(promptTokens + completionTokens).toLocaleString('en-US')} token` +
        (cost ? `，约 ${cost.formatted}` : '')

  return { calls: batches, batches, sentChars, promptTokens, completionTokens, totalTokens, cost, summary }
}

// ============================================================================
// 预算账本
// ============================================================================

export interface AiBudgetSnapshot {
  limits: AiBudgetLimits
  used: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }
  remaining: { calls: number | null; tokens: number | null }
  /** 已用比例（0~1）；不限时为 null */
  ratio: { calls: number | null; tokens: number | null }
  exceeded: boolean
}

export type BudgetCheck =
  | { ok: true }
  | { ok: false; reason: 'calls' | 'tokens'; used: number; limit: number; message: string }

export interface AiBudgetOptions {
  limits?: AiBudgetLimits
  /** 超限后的回调（UI 提示用；本层不抛错，见文件头契约缺口说明） */
  onExceeded?: (check: Extract<BudgetCheck, { ok: false }>) => void
}

/**
 * 单任务预算账本：调用前后各用一次 ——
 *   `canCall(estimate)` 判断能否继续，`record(usage)` 记账。
 */
export class AiBudget {
  private readonly limits: AiBudgetLimits
  private readonly onExceeded: AiBudgetOptions['onExceeded']
  private used = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  constructor(options: AiBudgetOptions = {}) {
    this.limits = options.limits ?? UNLIMITED_BUDGET
    this.onExceeded = options.onExceeded
  }

  getLimits(): AiBudgetLimits {
    return { ...this.limits }
  }

  getUsed(): AiBudgetSnapshot['used'] {
    return { ...this.used }
  }

  /**
   * 是否还能再调用。
   * @param estimate 本次调用预计消耗（调用次数默认 1，token 可给预估）
   */
  canCall(estimate: { calls?: number; tokens?: number } = {}): BudgetCheck {
    const addCalls = estimate.calls ?? 1
    const addTokens = estimate.tokens ?? 0

    if (this.limits.maxCalls !== null && this.used.calls + addCalls > this.limits.maxCalls) {
      return this.reject('calls', this.used.calls, this.limits.maxCalls)
    }
    if (this.limits.maxTokens !== null && this.used.totalTokens + addTokens > this.limits.maxTokens) {
      return this.reject('tokens', this.used.totalTokens, this.limits.maxTokens)
    }
    return { ok: true }
  }

  private reject(reason: 'calls' | 'tokens', used: number, limit: number): BudgetCheck {
    const message =
      reason === 'calls'
        ? `本次任务已达到调用次数上限（${used}/${limit}），余下的行将退回规则处理`
        : `本次任务已达到 token 上限（${used}/${limit}），余下的行将退回规则处理`
    const check: Extract<BudgetCheck, { ok: false }> = { ok: false, reason, used, limit, message }
    this.onExceeded?.(check)
    return check
  }

  /** 记账一次真实调用（usage 缺失时按 0 token 记，与 usage.ts 一致） */
  record(usage?: ChatUsage | null): void {
    this.used.calls += 1
    this.used.promptTokens += usage?.promptTokens ?? 0
    this.used.completionTokens += usage?.completionTokens ?? 0
    this.used.totalTokens += usage?.totalTokens ?? (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)
  }

  reset(): void {
    this.used = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  }

  snapshot(): AiBudgetSnapshot {
    const remainingCalls =
      this.limits.maxCalls === null ? null : Math.max(0, this.limits.maxCalls - this.used.calls)
    const remainingTokens =
      this.limits.maxTokens === null ? null : Math.max(0, this.limits.maxTokens - this.used.totalTokens)
    return {
      limits: { ...this.limits },
      used: this.getUsed(),
      remaining: { calls: remainingCalls, tokens: remainingTokens },
      ratio: {
        calls:
          this.limits.maxCalls === null || this.limits.maxCalls === 0
            ? null
            : this.used.calls / this.limits.maxCalls,
        tokens:
          this.limits.maxTokens === null || this.limits.maxTokens === 0
            ? null
            : this.used.totalTokens / this.limits.maxTokens,
      },
      exceeded: this.canCall().ok === false,
    }
  }
}

/**
 * 给 UI 的「预估 + 预算状态」合成视图：
 * 即便预算不限，也要能把 `estimate.summary` 显示给用户（docs/06 §7.2）。
 */
export function describeBudget(budget: AiBudget, estimate: ConsumptionEstimate): string {
  const snap = budget.snapshot()
  const limited = snap.limits.maxCalls !== null || snap.limits.maxTokens !== null
  if (!limited) return `${estimate.summary}（未设置上限）`
  const parts: string[] = [estimate.summary]
  if (snap.remaining.calls !== null) parts.push(`剩余可调用 ${snap.remaining.calls} 次`)
  if (snap.remaining.tokens !== null) parts.push(`剩余 token ${snap.remaining.tokens}`)
  return parts.join('；')
}
