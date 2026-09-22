/**
 * Novel Studio · AIProvider → LlmReviewer 适配器（画本低置信行的 LLM 复核）
 * ============================================================================
 * 设计依据：docs/06 §6.2 / §6.4
 *
 * ### 为什么需要这一层
 *   `shared/canvas/attribution.ts` 的 L3 层要求注入一个 `LlmReviewer`，而 Provider
 *   抽象（`shared/ai`）只提供 `chat`。两边形状不同，必须在主进程把它们接起来；
 *   在此之前 `ports.ts` 一直传 `llmReviewer: null` —— 于是画本编辑器里
 *   「AI 复核存疑行」这个复选框**勾了也没有任何效果**。
 *
 * ### 逐条调用，而不是一次塞一整批
 *   `attribution_review` 模板的输出 schema（`lineId/speaker/confidence`）是**单行**形状，
 *   并且要求「原样回填 lineId」。逐条调用能让 `callStructured` 的 `expectedIds` 校验
 *   每一条的 ID 回填是否正确（幻觉 ID 在这一层就被丢掉，见 docs/06 §6.4 第三层防护）。
 *   批量合并成一个数组 schema 需要改模板与解析，收益不明显、风险更大。
 *
 * ### 失败语义
 *   全部错误原样抛出，由 `attribution.ts` 统一 catch 并降级为
 *   `CANVAS_LLM_UNAVAILABLE` 警告（低置信行进待确认列表）。**只有取消例外**：
 *   `TASK_CANCELLED` 必须继续往上冒泡（attribution.ts 第 2623 行）。
 */

import { AppError } from '../../../../shared/errors.ts'
import { buildAttributionReviewMessages, getStructuredSchema } from '../../../../shared/ai/prompts/templates.ts'
import { callStructured, type StructuredSchema } from '../../../../shared/ai/structured.ts'
import type { AIProvider } from '../../../../shared/ai/types.ts'
import type { LlmReviewItem, LlmReviewRequest, LlmReviewer } from '../../../../shared/canvas/index.ts'

export interface LlmReviewContext {
  provider: AIProvider
  /** 隐私开关：false 时云端 Provider 会直接拒绝外发，**一个字节都不发**（docs/06 §9） */
  allowCloud: boolean
  timeoutMs?: number
}

export interface CreateProviderLlmReviewerOptions {
  /**
   * 每次调用现取（用户可能刚在设置里改了服务商 / 地址 / 隐私开关）。
   * 返回 null 表示当前没有可用 Provider —— 此时**不报错**，直接返回空数组让上层走降级。
   */
  getContext: () => LlmReviewContext | null
}

/** schema 只构造一次（`schemaFromShape` 是纯计算，但没必要每条都重建） */
const REVIEW_SCHEMA = getStructuredSchema('attribution_review') as StructuredSchema<LlmReviewItem>

export function createProviderLlmReviewer(options: CreateProviderLlmReviewerOptions): LlmReviewer {
  return {
    async reviewBatch(req: LlmReviewRequest): Promise<LlmReviewItem[]> {
      const ctx = options.getContext()
      // 没有 Provider ≠ 错误：上层会记一条「LLM 不可用」并让所有低置信行进待确认队列
      if (!ctx) return []

      const out: LlmReviewItem[] = []
      for (const item of req.items) {
        if (req.signal?.aborted) throw new AppError('TASK_CANCELLED')

        const messages = buildAttributionReviewMessages({
          characters: req.characters.map((c) => ({ name: c.name, aliases: c.aliases.join('、') })),
          context: item.context.map((text, index) => ({ index: index + 1, text })),
          lineIndex: item.seq,
          text: item.text,
          lineId: item.lineId,
        })

        const result = await callStructured<LlmReviewItem>(ctx.provider, messages, REVIEW_SCHEMA, {
          allowCloud: ctx.allowCloud,
          purpose: 'attribution_review',
          timeoutMs: ctx.timeoutMs,
          temperature: 0.2,
          // requestTag 进日志/用量归因（不含正文）；同时让可复现的假 Provider 能原样回填
          requestTag: item.lineId,
          signal: req.signal,
          // 语义层校验：模型必须回填本条的 lineId，否则该条作废（docs/06 §6.4）
          expectedIds: [item.lineId],
        })

        out.push({
          lineId: result.value.lineId,
          speaker: result.value.speaker,
          confidence: result.value.confidence,
        })
      }
      return out
    },
  }
}
