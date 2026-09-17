/**
 * Novel Studio · 结构化输出三层防护测试（docs/06 §6.4、§10）
 * ============================================================================
 * 运行：
 *   node --experimental-strip-types tests/shared/ai-structured.test.ts
 *
 * 本文件守护：
 *   · **20+ 种坏 JSON** 都能被解析层容错或经修复轮救回（围栏 / 废话 / 尾随逗号 /
 *     注释 / 截断 / 缺字段 / 枚举越界 / 幻觉 lineId / null / 空串 / 嵌套错误 …）
 *   · 修复轮会把**错误信息回传**给模型（第二次调用的 messages 里能看到错误）
 *   · 3 轮修复后仍失败 → 抛 `AI_INVALID_OUTPUT`（带 attempts 参数）
 *   · 语义层：schema 校验 + 枚举白名单 + **ID 存在性校验**（拒绝模型编造 lineId）
 *   · 提示层：自动注入「只输出 JSON」，且不修改调用方传入的数组
 *   · 缓存命中时一次调用都不发；LocalEcho 的「无法判定」不浪费修复轮
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { isAppError } from '../../src/shared/errors.ts'
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, HealthStatus } from '../../src/shared/ai/types.ts'
import {
  applyPromptLayer,
  callStructured,
  callStructuredValue,
  checkExpectedIds,
  collectIdValues,
  extractJson,
  schemaFromShape,
  stripCodeFence,
  stripTrailingCommas,
} from '../../src/shared/ai/structured.ts'
import { getStructuredSchema } from '../../src/shared/ai/prompts/templates.ts'
import type { StructuredSchema } from '../../src/shared/ai/structured.ts'
import { LocalEchoProvider } from '../../src/shared/ai/providers/local-echo.ts'
import { createMemoryAiCache, estimateCost, summarizeUsage } from '../../src/shared/ai/usage.ts'
import { AiBudget, UNLIMITED_BUDGET, estimateConsumption } from '../../src/shared/ai/budget.ts'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

class ScriptedChatProvider implements AIProvider {
  readonly kind = 'mock' as const
  readonly calls: Array<{ messages: ChatMessage[]; opts: ChatOptions }> = []
  private replies: string[]

  constructor(replies: string[]) {
    this.replies = replies
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, message: 'ok' }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    this.calls.push({ messages: messages.map((m) => ({ ...m })), opts })
    const text = this.replies.length > 1 ? (this.replies.shift() as string) : (this.replies[0] ?? '')
    return { text, model: 'scripted', provider: this.kind, latencyMs: 3, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  }
}

/**
 * 说话人复核的输出形状（与 templates.ts 的 `ATTRIBUTION_REVIEW_SHAPE` 一致）。
 * 显式声明是为了让 `callStructuredValue` 能推断出 `T` —— 否则 T 退化成 unknown，
 * 后面 `v.lineId` 就会报 TS18046。
 */
interface AttributionReview {
  lineId: string
  speaker: string
  confidence: number
  reason?: string
}

const attribution = getStructuredSchema('attribution_review') as StructuredSchema<AttributionReview>
const emotionTag = getStructuredSchema('emotion_tag')

const GOOD_ATTRIBUTION =
  '{"lineId":"L1","speaker":"萧炎","confidence":0.91,"reason":"引导语明确指名"}'
const GOOD_EMOTION = '[{"lineId":"L1","emotion":"决绝","intensity":4,"speed":"fast","reason":"爆发"}]'

const baseMessages: ChatMessage[] = [{ role: 'user', content: '判断归属' }]
const baseOpts = { allowCloud: true, expectedIds: ['L1', 'L2'] as const }

// ---------------------------------------------------------------------------
// 20+ 种坏 JSON
// ---------------------------------------------------------------------------

interface BadCase {
  label: string
  bad: string
  /** 期望修复后返回的合法值 */
  good: string
  schema: typeof attribution | typeof emotionTag
  /**
   * 期望在第几次调用成功：
   *   · 1 = **解析层**就救回来了（围栏、废话、尾随逗号、注释、截断、BOM）
   *   · 2 = 解析层拿到合法 JSON 但**语义层**不通过，需要一轮修复
   */
  expectAttempts: 1 | 2
}

const BAD_JSON_CASES: BadCase[] = [
  { label: 'markdown 代码围栏（json 标记）', bad: '```json\n' + GOOD_ATTRIBUTION + '\n```', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: 'markdown 代码围栏（无语言标记）', bad: '```\n' + GOOD_ATTRIBUTION + '\n```', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '未闭合的代码围栏', bad: '```json\n' + GOOD_ATTRIBUTION, good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '前置废话', bad: '好的，以下是判定结果：\n' + GOOD_ATTRIBUTION, good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '后置废话', bad: GOOD_ATTRIBUTION + '\n希望有帮助！', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '前后都有废话', bad: '分析中……\n' + GOOD_ATTRIBUTION + '\n（以上）', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '对象尾随逗号', bad: '{"lineId":"L1","speaker":"萧炎","confidence":0.9,"reason":"x",}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: 'JSON 内 // 注释', bad: '{\n// 这是判定\n"lineId":"L1","speaker":"萧炎","confidence":0.9,"reason":"x"\n}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: 'JSON 内 /* */ 注释', bad: '{"lineId":"L1","speaker":"萧炎",/*c*/"confidence":0.9,"reason":"x"}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '被截断（缺右花括号）', bad: '{"lineId":"L1","speaker":"萧炎","confidence":0.9', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '带 BOM', bad: '\uFEFF' + GOOD_ATTRIBUTION, good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 1 },
  { label: '纯文本、没有 JSON', bad: '这句台词应该属于萧炎。', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: 'JSON null', bad: 'null', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: '空字符串', bad: '', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: '缺必填字段（无 speaker）', bad: '{"lineId":"L1","confidence":0.9}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: 'confidence 被写成字符串', bad: '{"lineId":"L1","speaker":"萧炎","confidence":"0.9"}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: 'confidence 超出 0~1', bad: '{"lineId":"L1","speaker":"萧炎","confidence":1.7}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: '嵌套错误（reason 是对象）', bad: '{"lineId":"L1","speaker":"萧炎","confidence":0.9,"reason":{"why":"x"}}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: '幻觉 lineId（不在输入集合内）', bad: '{"lineId":"L-999","speaker":"萧炎","confidence":0.9}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: 'lineId 被写成数字', bad: '{"lineId":123,"speaker":"萧炎","confidence":0.9}', good: GOOD_ATTRIBUTION, schema: attribution, expectAttempts: 2 },
  { label: '数组根：返回对象而非数组', bad: '{"lineId":"L1","emotion":"决绝","intensity":4,"speed":"fast"}', good: GOOD_EMOTION, schema: emotionTag, expectAttempts: 2 },
  { label: '数组尾随逗号', bad: '[{"lineId":"L1","emotion":"决绝","intensity":4,"speed":"fast"},]', good: GOOD_EMOTION, schema: emotionTag, expectAttempts: 1 },
  { label: '枚举越界（emotion 不在白名单）', bad: '[{"lineId":"L1","emotion":"暴躁","intensity":4,"speed":"fast"}]', good: GOOD_EMOTION, schema: emotionTag, expectAttempts: 2 },
  { label: '枚举越界（speed 非 slow/normal/fast）', bad: '[{"lineId":"L1","emotion":"决绝","intensity":4,"speed":"quickly"}]', good: GOOD_EMOTION, schema: emotionTag, expectAttempts: 2 },
  { label: 'intensity 越界（0）', bad: '[{"lineId":"L1","emotion":"决绝","intensity":0,"speed":"fast"}]', good: GOOD_EMOTION, schema: emotionTag, expectAttempts: 2 },
  { label: '数组第二项含幻觉 lineId', bad: '[{"lineId":"L1","emotion":"决绝","intensity":4,"speed":"fast"},{"lineId":"L-X","emotion":"平静","intensity":2,"speed":"normal"}]', good: GOOD_EMOTION, schema: emotionTag, expectAttempts: 2 },
]

describe('结构化输出 · 坏 JSON 全谱系（≥20 种）', () => {
  it(`共 ${BAD_JSON_CASES.length} 种坏 JSON，全部能经「解析容错 + 修复轮」救回`, async () => {
    const parseLayerSaved: string[] = []
    const repairSaved: string[] = []

    for (const c of BAD_JSON_CASES) {
      const provider = new ScriptedChatProvider([c.bad, c.good])
      const res = await callStructured(provider, baseMessages, c.schema, {
        ...baseOpts,
        maxRepairRounds: 2,
        purpose: c.schema.name,
      })
      assert.equal(res.attempts, c.expectAttempts, `[${c.label}] 成功所需调用次数不符`)
      assert.equal(res.repaired, c.expectAttempts > 1, `[${c.label}] repaired 标记不符`)
      assert.equal(provider.calls.length, c.expectAttempts, `[${c.label}] 调用次数不符`)
      const first = res.value as { lineId?: string } | Array<{ lineId?: string }>
      const lineId = Array.isArray(first) ? first[0].lineId : first.lineId
      assert.equal(lineId, 'L1', `[${c.label}] 取值不符`)

      if (c.expectAttempts === 1) parseLayerSaved.push(c.label)
      else repairSaved.push(c.label)
    }

    // 两类都要有足够的样本，否则这个测试就退化成「只测了一种路径」
    assert.ok(parseLayerSaved.length >= 10, `解析层直接救回的案例偏少：${parseLayerSaved.length}`)
    assert.ok(repairSaved.length >= 10, `靠修复轮救回的案例偏少：${repairSaved.length}`)
    assert.ok(BAD_JSON_CASES.length >= 20, '坏 JSON 案例数必须 ≥ 20')
  })

  it('修复轮把错误信息回传（第 2 次调用的 messages 里带原答案与错误清单）', async () => {
    const provider = new ScriptedChatProvider(['{"lineId":"L1","confidence":0.9}', GOOD_ATTRIBUTION])
    await callStructured(provider, baseMessages, attribution, { ...baseOpts, maxRepairRounds: 1 })

    const second = provider.calls[1].messages
    assert.equal(second.length, baseMessages.length + 1 + 2, '应追加 assistant(原答案) + user(修复要求)')
    const last = second[second.length - 1]
    const assistant = second[second.length - 2]
    assert.equal(assistant.role, 'assistant')
    assert.match(assistant.content, /confidence/)
    assert.equal(last.role, 'user')
    assert.match(last.content, /不符合要求/)
    assert.match(last.content, /speaker/, '错误清单里应指出缺失的字段')
  })

  it('提示层注入「只输出 JSON」且不改动调用方数组', async () => {
    const provider = new ScriptedChatProvider([GOOD_ATTRIBUTION])
    const input: ChatMessage[] = [{ role: 'user', content: '判断归属' }]
    await callStructured(provider, input, attribution, baseOpts)

    assert.equal(input.length, 1, '调用方数组不得被修改')
    const sent = provider.calls[0].messages
    assert.equal(sent[0].role, 'system')
    assert.match(sent[0].content, /只输出一个 JSON/)
    assert.match(sent[0].content, /lineId/, '提示层应内联 schema')

    const layered = applyPromptLayer([{ role: 'system', content: '原有设定' }], attribution)
    assert.match(layered[0].content, /^原有设定/, '已有 system 消息应保留在最前')
    assert.equal(applyPromptLayer(input, attribution, false).length, 1, '可关闭提示层')
  })

  it('始终返回坏内容 → 修复 3 轮后抛 AI_INVALID_OUTPUT（并带 attempts）', async () => {
    const provider = new ScriptedChatProvider(['这不是 JSON'])
    await assert.rejects(
      () => callStructured(provider, baseMessages, attribution, { ...baseOpts, maxRepairRounds: 3 }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'AI_INVALID_OUTPUT')
        assert.equal(e.params.attempts, 4)
        assert.equal(e.retryable, true)
        assert.equal((e.details?.errors as string[]).length > 0, true)
        return true
      },
    )
    assert.equal(provider.calls.length, 4, '1 次首答 + 3 轮修复')
  })

  it('maxRepairRounds=0 时只调用一次', async () => {
    const provider = new ScriptedChatProvider(['nope'])
    await assert.rejects(
      () => callStructured(provider, baseMessages, attribution, { ...baseOpts, maxRepairRounds: 0 }),
      (e: unknown) => isAppError(e) && e.key === 'AI_INVALID_OUTPUT' && e.params.attempts === 1,
    )
    assert.equal(provider.calls.length, 1)
  })
})

// ---------------------------------------------------------------------------
// 解析层纯函数
// ---------------------------------------------------------------------------

describe('解析层 · extractJson / stripCodeFence / stripTrailingCommas', () => {
  it('提取首个可解析的 JSON（跳过前面不合法的花括号）', () => {
    const r = extractJson('说明：{这不是 JSON} 然后 {"a":1} 结束')
    assert.equal(r.ok, true)
    assert.deepEqual(r.value, { a: 1 })
  })

  it('字符串里的花括号不会被误判为结构（带转义的引号）', () => {
    const r = extractJson('{"text":"他说：\\"别过来{\\"","n":2}')
    assert.equal(r.ok, true)
    assert.deepEqual(r.value, { text: '他说："别过来{"', n: 2 })
  })

  it('数组根同样可提取', () => {
    const r = extractJson('结果如下 [1,2,3] 完毕')
    assert.equal(r.ok, true)
    assert.deepEqual(r.value, [1, 2, 3])
  })

  it('截断的 JSON 自动补全括号', () => {
    const r = extractJson('[{"a":1},{"b":[1,2')
    assert.equal(r.ok, true)
    assert.deepEqual(r.value, [{ a: 1 }, { b: [1, 2] }])
  })

  it('空串与纯废话返回 ok:false（不静默返回 null）', () => {
    assert.equal(extractJson('').ok, false)
    assert.equal(extractJson('这句话里没有结构化数据').ok, false)
  })

  it('stripCodeFence 处理未闭合围栏', () => {
    assert.equal(stripCodeFence('```json\n{"a":1}'), '{"a":1}')
    assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}')
  })

  it('stripTrailingCommas 不动字符串内部的逗号', () => {
    assert.equal(stripTrailingCommas('{"a":"x,}",}'), '{"a":"x,}"}')
  })
})

// ---------------------------------------------------------------------------
// 语义层
// ---------------------------------------------------------------------------

describe('语义层 · schema / 枚举 / ID 存在性', () => {
  it('schemaFromShape 校验类型、必填、长度与区间', () => {
    const schema = schemaFromShape({
      name: { type: 'string', maxLength: 5 },
      score: { type: 'number', min: 0, max: 1 },
      tag: { type: 'string', enum: ['a', 'b'] },
    })
    const bad = schema.validate({ name: '太长了啊啊啊', score: 2, tag: 'c' })
    assert.equal(bad.ok, false)
    if (!bad.ok) {
      assert.equal(bad.errors.length, 3)
      assert.match(bad.errors.join('\n'), /超过上限/)
      assert.match(bad.errors.join('\n'), /大于最大值/)
      assert.match(bad.errors.join('\n'), /不在允许取值内/)
    }
    assert.equal(schema.validate({ name: 'ok', score: 0.5, tag: 'a' }).ok, true)
  })

  it('可选字段缺失不算错，null 与非 null 语义正确', () => {
    const schema = schemaFromShape({
      a: { type: 'string', required: false },
      b: { type: 'string', nullable: true },
    })
    assert.equal(schema.validate({ b: null }).ok, true)
    assert.equal(schema.validate({ b: 'x' }).ok, true)
    assert.equal(schema.validate({}).ok, false, 'b 是必填（但可为 null）')
  })

  it('数组根 schema（emotion_tag）要求 JSON 数组', () => {
    assert.equal(emotionTag.validate([{ lineId: 'L1', emotion: '决绝', intensity: 3, speed: 'fast' }]).ok, true)
    assert.equal(emotionTag.validate({ lineId: 'L1' }).ok, false)
    const badEnum = emotionTag.validate([{ lineId: 'L1', emotion: '暴躁', intensity: 3, speed: 'fast' }])
    assert.equal(badEnum.ok, false)
  })

  it('ID 存在性校验：编造的 lineId 被拒绝，嵌套数组也覆盖', () => {
    assert.deepEqual(checkExpectedIds({ lineId: 'L1' }, ['lineId'], ['L1', 'L2']), [])
    const errs = checkExpectedIds({ lineId: 'L9' }, ['lineId'], ['L1'])
    assert.equal(errs.length, 1)
    assert.match(errs[0], /疑似模型编造/)

    const nested = checkExpectedIds({ items: [{ lineId: 'L1' }, { lineId: 'L7' }] }, ['lineId'], ['L1'])
    assert.equal(nested.length, 1)
    assert.equal(collectIdValues({ items: [{ lineId: 'L1' }, { lineId: 'L7' }] }, ['lineId']).length, 2)

    assert.deepEqual(checkExpectedIds({ lineId: 'anything' }, ['lineId'], undefined), [], '不给 expectedIds 时跳过校验')
  })

  it('未标记 idFields 的 schema 不做 ID 校验（如纯情绪标注）', () => {
    const schema = schemaFromShape({ mood: { type: 'string' } }, { name: 'mood' })
    assert.deepEqual(schema.idFields, [])
  })
})

// ---------------------------------------------------------------------------
// 缓存 / 兜底 / 用量 / 预算
// ---------------------------------------------------------------------------

describe('结构化调用 · 缓存与兜底协作', () => {
  it('ai_cache 命中时一次调用都不发，且 attempts=0 / cached=true', async () => {
    const cache = createMemoryAiCache()
    const provider = new ScriptedChatProvider([GOOD_ATTRIBUTION])

    const first = await callStructured(provider, baseMessages, attribution, { ...baseOpts, cache, promptVersion: 1 })
    assert.equal(first.cached, false)
    assert.equal(first.attempts, 1)
    assert.equal(cache.size(), 1)

    const second = await callStructured(provider, baseMessages, attribution, { ...baseOpts, cache, promptVersion: 1 })
    assert.equal(second.cached, true)
    assert.equal(second.attempts, 0)
    assert.equal(provider.calls.length, 1, '第二次不应再调用 Provider')
    assert.deepEqual(second.value, first.value)
  })

  it('LocalEcho 的「无法判定」直接抛 PROVIDER_UNAVAILABLE，不白跑修复轮', async () => {
    const echo = new LocalEchoProvider()
    let calls = 0
    const counting: AIProvider = {
      kind: 'local',
      healthCheck: () => echo.healthCheck(),
      chat: async (m, o) => {
        calls++
        return echo.chat(m, o)
      },
    }
    await assert.rejects(
      () => callStructured(counting, baseMessages, attribution, { ...baseOpts, maxRepairRounds: 3 }),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE' && e.details?.reason === 'undetermined',
    )
    assert.equal(calls, 1)
  })

  it('callStructuredValue 直接返回校验后的值', async () => {
    const provider = new ScriptedChatProvider([GOOD_ATTRIBUTION])
    const v = await callStructuredValue(provider, baseMessages, attribution, baseOpts)
    assert.equal(v.lineId, 'L1')
    assert.equal(v.speaker, '萧炎')
  })
})

describe('用量与预算（docs/06 §7）', () => {
  it('每次真实调用都会回调一条用量记录（accepted 初始为 null，可回填）', async () => {
    const provider = new ScriptedChatProvider(['不是 JSON', GOOD_ATTRIBUTION])
    const records: Array<{ purpose: string; promptTokens: number; accepted: number | null }> = []
    let n = 0
    await callStructured(provider, baseMessages, attribution, {
      ...baseOpts,
      maxRepairRounds: 1,
      onUsage: (r) => records.push({ purpose: r.purpose, promptTokens: r.promptTokens, accepted: r.accepted }),
      newId: () => `u-${++n}`,
    })
    assert.equal(records.length, 2)
    assert.equal(records[0].purpose, 'attribution_review')
    assert.equal(records[0].promptTokens, 10)
    assert.equal(records[0].accepted, null)

    const summary = summarizeUsage([
      { id: '1', projectId: null, purpose: 'attribution_review', provider: 'mock', model: 'm', promptTokens: 10, completionTokens: 5, latencyMs: 100, accepted: 1, createdAt: 0 },
      { id: '2', projectId: null, purpose: 'attribution_review', provider: 'mock', model: 'm', promptTokens: 20, completionTokens: 5, latencyMs: 200, accepted: 0, createdAt: 0 },
    ])
    assert.equal(summary.calls, 2)
    assert.equal(summary.totalTokens, 40)
    assert.equal(summary.avgLatencyMs, 150)
    assert.equal(summary.acceptRate, 0.5)
  })

  it('成本估算：未登记模型标注「未知费用」而不是假装 0 元', () => {
    const known = estimateCost('gpt-4o-mini', { promptTokens: 1000, completionTokens: 1000 })
    assert.equal(known.known, true)
    assert.equal(known.totalCost > 0, true)
    const unknown = estimateCost('某本地模型', { promptTokens: 1000, completionTokens: 1000 })
    assert.equal(unknown.known, false)
    assert.match(unknown.formatted, /未知费用/)
  })

  it('默认不限预算，但始终能给出预估消耗（docs/06 §7.2）', () => {
    assert.deepEqual(UNLIMITED_BUDGET, { maxCalls: null, maxTokens: null })
    const budget = new AiBudget()
    const est = estimateConsumption({ lines: 500, avgCharsPerLine: 30, contextLines: 2, batchSize: 20, model: 'gpt-4o-mini' })
    assert.equal(est.batches, 25)
    assert.equal(est.calls, 25)
    // 每行都要带上前后 2 行上下文，因此实际发送字数 = 500 × 30 × 5
    assert.equal(est.sentChars, 75_000)
    assert.equal(est.totalTokens > 0, true)
    assert.match(est.summary, /500 行/)
    assert.equal(budget.snapshot().limits.maxCalls, null)
    assert.equal(budget.canCall({ calls: 999, tokens: 10_000_000 }).ok, true)
  })

  it('设置上限后 canCall 拒绝并给出可读原因（不抛错，交调用方决定）', () => {
    const budget = new AiBudget({ limits: { maxCalls: 2, maxTokens: 100 } })
    budget.record({ promptTokens: 40, completionTokens: 10, totalTokens: 50 })
    assert.equal(budget.canCall().ok, true)
    budget.record({ promptTokens: 40, completionTokens: 10, totalTokens: 50 })
    const denied = budget.canCall()
    assert.equal(denied.ok, false)
    if (!denied.ok) {
      assert.equal(denied.reason, 'calls')
      assert.match(denied.message, /调用次数上限/)
    }
    const snap = budget.snapshot()
    assert.equal(snap.used.totalTokens, 100)
    assert.equal(snap.exceeded, true)
    assert.equal(snap.ratio.calls, 1)
  })
})
