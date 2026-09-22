/**
 * AIProvider → LlmReviewer 适配器测试
 * ============================================================================
 * 修复前的状态：`ports.ts` 一直传 `llmReviewer: null`，于是画本编辑器里的
 * 「AI 复核存疑行」勾了也没有任何效果（低置信行全部停在待确认列表）。
 *
 * 这组测试用**可脚本化的假 Provider**（不联网、不依赖 mock 的固定应答）验证：
 *   · 每条待复核行都会按 `attribution_review` 模板发起一次结构化调用
 *   · 返回结果按 lineId 一一对应
 *   · 没有可用 Provider 时返回空数组（降级不是错误）
 *   · 取消必须原样冒泡（attribution.ts 会 rethrow TASK_CANCELLED）
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { createProviderLlmReviewer } from '../../src/main/features/book/canvas/llm-reviewer.ts'
import type { AIProvider, ChatMessage, ChatOptions } from '../../src/shared/ai/types.ts'
import type { LlmReviewRequest } from '../../src/shared/canvas/index.ts'

/** 用脚本决定每次 chat 的返回文本；不联网 */
function scriptedProvider(script: (messages: readonly ChatMessage[], opts: ChatOptions) => string): AIProvider {
  return {
    kind: 'mock',
    async healthCheck() {
      return { ok: true, message: 'scripted', latencyMs: 0 }
    },
    async chat(messages, opts) {
      const text = script(messages, opts)
      return { text, model: 'scripted', provider: 'mock', latencyMs: 1 }
    },
  }
}

function request(overrides: Partial<LlmReviewRequest> = {}): LlmReviewRequest {
  return {
    chapterId: 'c1',
    items: [
      { lineId: 'l1', seq: 1, text: '“我萧炎，从来不会认输。”', kind: 'dialogue', context: ['前文'] },
      { lineId: 'l2', seq: 2, text: '“师父，我做到了。”', kind: 'dialogue', context: ['前文', '后文'] },
    ],
    characters: [{ id: 'x1', name: '萧炎', aliases: ['炎帝'] }],
    ...overrides,
  }
}

describe('createProviderLlmReviewer', () => {
  it('逐条复核并按 lineId 一一对应返回', async () => {
    const calls: string[] = []
    const reviewer = createProviderLlmReviewer({
      getContext: () => ({
        provider: scriptedProvider((_m, opts) => {
          calls.push(String(opts.requestTag))
          return JSON.stringify({ lineId: opts.requestTag, speaker: '萧炎', confidence: 0.91 })
        }),
        allowCloud: false,
        timeoutMs: 1000,
      }),
    })

    const out = await reviewer.reviewBatch(request())
    assert.equal(calls.length, 2, '两条各发起一次调用')
    assert.deepEqual(calls, ['l1', 'l2'])
    assert.deepEqual(out, [
      { lineId: 'l1', speaker: '萧炎', confidence: 0.91 },
      { lineId: 'l2', speaker: '萧炎', confidence: 0.91 },
    ])
  })

  it('没有可用 Provider → 返回空数组（交给上层降级，不抛错）', async () => {
    const reviewer = createProviderLlmReviewer({ getContext: () => null })
    assert.deepEqual(await reviewer.reviewBatch(request()), [])
  })

  it('已取消 → 抛 TASK_CANCELLED（attribution.ts 会继续冒泡，不能吞）', async () => {
    const controller = new AbortController()
    controller.abort()
    const reviewer = createProviderLlmReviewer({
      getContext: () => ({
        provider: scriptedProvider(() => '{"lineId":"l1","speaker":"萧炎","confidence":0.9}'),
        allowCloud: false,
      }),
    })
    await assert.rejects(
      reviewer.reviewBatch(request({ signal: controller.signal })),
      (e: unknown) => (e as { key?: string }).key === 'TASK_CANCELLED',
    )
  })

  it('模型回填错误的 lineId（幻觉 ID）→ 该批失败，不产出错误行', async () => {
    const reviewer = createProviderLlmReviewer({
      getContext: () => ({
        // 永远回填一个不存在的 ID：expectedIds 校验必须拦下
        provider: scriptedProvider(() => '{"lineId":"hallucinated","speaker":"萧炎","confidence":0.9}'),
        allowCloud: false,
      }),
    })
    await assert.rejects(reviewer.reviewBatch(request({ items: [request().items[0]!] })))
  })
})
