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
import { callStructured, schemaFromShape, type StructuredSchema } from '../../../../shared/ai/structured.ts'
import type { AIProvider, ChatMessage } from '../../../../shared/ai/types.ts'
import type { LlmReviewItem, LlmReviewRequest, LlmReviewer } from '../../../../shared/canvas/index.ts'
import type { CharacterExtractor } from './canvas.service.ts'

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


// ============================================================================
// AIProvider → CharacterExtractor（生成画本前的角色抽取）
// ============================================================================

/**
 * 角色抽取的输出 schema：只要一个名字数组。
 * 保持最小面是为了让弱模型也能稳定输出（复杂 schema 会显著提高解析失败率）。
 */
const EXTRACT_SCHEMA = schemaFromShape(
  {
    names: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 24 },
      description: '正文中真正出场的人物名（不含地名 / 组织 / 泛称 / 代词）',
    },
  },
  { name: 'character_extract', description: '从中文小说正文中抽取角色名' },
) as StructuredSchema<{ names: string[] }>

export interface CreateProviderCharacterExtractorOptions {
  /** 每次调用现取 Provider；返回 null 表示当前没有可用配置（返回空数组，不报错） */
  getContext: () => LlmReviewContext | null
  /** 送入模型的正文上限（默认 8000 字，避免超长上下文与费用失控） */
  maxChars?: number
}

/**
 * 用已配置的 AI 服务抽取角色（docs/11 §4.6 的「AI 抽取」路径）。
 *
 * 失败由调用方（`canvas.service`）catch 并降级到规则抽取：这里**不吞错**，
 * 只保证「没有配置时返回空数组」这一种静默降级。
 */
export function createProviderCharacterExtractor(
  options: CreateProviderCharacterExtractorOptions,
): CharacterExtractor {
  const maxChars = Math.max(500, options.maxChars ?? 8000)
  return {
    async extract(req) {
      const ctx = options.getContext()
      if (!ctx) return []

      const text = req.chapterText.slice(0, maxChars)
      const known = req.knownNames.slice(0, 200).join('、')
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: '你是中文小说的角色抽取器。只输出 JSON，不要解释；只抽真正出场的人物名，排除地名/组织/泛称/代词。',
        },
        {
          role: 'user',
          content: [
            known ? `已知角色（不必重复）：${known}` : '已知角色：无',
            '',
            '请从下面的正文中抽取所有出场人物名：',
            text,
          ].join('\n'),
        },
      ]

      const result = await callStructured<{ names: string[] }>(ctx.provider, messages, EXTRACT_SCHEMA, {
        allowCloud: ctx.allowCloud,
        purpose: 'character_extract',
        temperature: 0.1,
        maxTokens: 1024,
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      })

      const raw = Array.isArray(result.value?.names) ? result.value.names : []
      const out: Array<{ name: string }> = []
      const seen = new Set<string>()
      for (const item of raw) {
        const name = typeof item === 'string' ? item.trim() : ''
        if (name.length === 0 || name.length > 24 || seen.has(name)) continue
        seen.add(name)
        out.push({ name })
      }
      return out
    },
  }
}
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
