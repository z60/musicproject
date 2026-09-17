/**
 * Novel Studio · AI Provider 适配测试
 * ============================================================================
 * 设计文档：docs/06-AI抽象层与向量判定.md §3.2 / §3.3 / §3.4、§8 降级矩阵、§10 Provider 适配
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/ai-providers.test.ts
 *
 * 本文件守护（全部**不联网**，HttpClient 一律注入 fake）：
 *   · MockProvider 的确定性（同输入 ⇒ 同输出）
 *   · LocalEchoProvider 永不抛错且明确表示「无法判定」
 *   · Dify 请求体形状（response_mode=blocking / query / inputs / user）
 *   · **Dify 批量判定默认新建会话**（不传 conversation_id，避免上下文污染）
 *   · allowCloud=false 时**一个请求都不发**且抛 PROVIDER_CLOUD_DISABLED
 *   · OpenAI 兼容的响应解析（正常 / 缺 choices / usage 缺失）
 *   · FallbackProvider 的切换与熔断（连续 5 次 → 熔断 5 分钟，状态可读）
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AppError, isAppError } from '../../src/shared/errors.ts'
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  HealthStatus,
  HttpClient,
  HttpRequest,
  HttpResponse,
  ProviderKind,
} from '../../src/shared/ai/types.ts'
import { MockProvider } from '../../src/shared/ai/providers/mock.ts'
import { LocalEchoProvider, isUndeterminedResultText } from '../../src/shared/ai/providers/local-echo.ts'
import {
  DifyProvider,
  buildDifyChatRequest,
  deriveAnonymousUserId,
  foldMessagesToQuery,
} from '../../src/shared/ai/providers/dify.ts'
import {
  OpenAICompatibleProvider,
  buildOpenAIChatRequest,
  joinApiPath,
  parseOpenAIChatResponse,
} from '../../src/shared/ai/providers/openai-compatible.ts'
import { FallbackProvider, createFallbackChain } from '../../src/shared/ai/providers/fallback.ts'
import { resolveProvider } from '../../src/shared/ai/factory.ts'
import type { AiSettings } from '../../src/shared/ai/types.ts'

// ---------------------------------------------------------------------------
// 测试脚手架：注入式 HttpClient（记录请求、返回脚本化响应）
// ---------------------------------------------------------------------------

interface RecordedRequest extends HttpRequest {
  rawBody: string
}

class FakeHttpClient implements HttpClient {
  readonly requests: RecordedRequest[] = []
  private responses: Array<HttpResponse | (() => HttpResponse) | Error> = []
  private defaultResponse: HttpResponse = { status: 200, ok: true, json: {} }

  /** 按调用顺序排队响应；用完后回落到默认响应 */
  queue(...res: Array<HttpResponse | (() => HttpResponse) | Error>): this {
    this.responses.push(...res)
    return this
  }

  setDefault(res: HttpResponse): this {
    this.defaultResponse = res
    return this
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push({ ...req, rawBody: req.body === undefined ? '' : JSON.stringify(req.body) })
    const next = this.responses.shift()
    if (!next) return this.defaultResponse
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next() : next
  }

  /** 解析第 n 个请求的 JSON 体 */
  body(n = 0): Record<string, unknown> {
    const raw = this.requests[n]?.rawBody
    assert.ok(raw, `第 ${n} 个请求没有 body`)
    return JSON.parse(raw) as Record<string, unknown>
  }
}

function jsonResponse(json: unknown, status = 200): HttpResponse {
  return { status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json) }
}

const msgs: ChatMessage[] = [{ role: 'user', content: '请判断这句台词属于谁' }]
const baseOpts: ChatOptions = { allowCloud: true, purpose: 'attribution_review' }

// ---------------------------------------------------------------------------
// MockProvider
// ---------------------------------------------------------------------------

describe('MockProvider · 确定性假数据', () => {
  it('同输入两次调用返回完全相同的文本与用量', async () => {
    const p = new MockProvider()
    const a = await p.chat(msgs, baseOpts)
    const b = await p.chat(msgs, baseOpts)
    assert.equal(a.text, b.text)
    assert.equal(a.provider, 'mock')
    assert.deepEqual(a.usage, b.usage)
  })

  it('不同输入产生不同文本（哈希指纹变化）', async () => {
    const p = new MockProvider()
    const a = await p.chat([{ role: 'user', content: '台词 A' }], baseOpts)
    const b = await p.chat([{ role: 'user', content: '台词 B' }], baseOpts)
    assert.notEqual(a.text, b.text)
  })

  it('Mock 不联网：即使 allowCloud=true 也不会触碰 HttpClient（构造时根本不持有）', async () => {
    const p = new MockProvider({ model: 'mock-test' })
    const res = await p.chat(msgs, { ...baseOpts, allowCloud: true })
    assert.equal(res.model, 'mock-test')
    assert.equal(res.provider, 'mock')
    assert.ok(res.text.length > 0)
  })

  it('健康探测可用且明确说明是本地假数据', async () => {
    const st = await new MockProvider().healthCheck()
    assert.equal(st.ok, true)
    assert.match(st.message, /Mock/)
  })

  it('可按 purpose 注入固定应答（演示与回放用）', async () => {
    const p = new MockProvider({ responses: { attribution_review: '{"ok":true}' } })
    const res = await p.chat(msgs, baseOpts)
    assert.equal(res.text, '{"ok":true}')
  })
})

// ---------------------------------------------------------------------------
// LocalEchoProvider
// ---------------------------------------------------------------------------

describe('LocalEchoProvider · 永远兜底', () => {
  it('不抛错，且返回明确的「无法判定」', async () => {
    const p = new LocalEchoProvider()
    const res = await p.chat(msgs, { allowCloud: false })
    assert.equal(res.provider, 'local')
    const parsed = JSON.parse(res.text) as Record<string, unknown>
    assert.equal(parsed.undetermined, true)
    assert.equal(parsed.confidence, 0)
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0)
    assert.equal(isUndeterminedResultText(res.text), true)
  })

  it('allowCloud=false 时也不抛错（它本来就不外发）', async () => {
    const res = await new LocalEchoProvider().chat(msgs, { allowCloud: false })
    assert.equal(LocalEchoProvider.isUndetermined(res.text), true)
  })

  it('携带 schema 时仍返回合法 JSON 且带 unable 标记', async () => {
    const res = await new LocalEchoProvider().chat(msgs, {
      allowCloud: false,
      jsonSchema: { type: 'object', properties: { speaker: { type: 'string' } } },
    })
    const parsed = JSON.parse(res.text) as Record<string, unknown>
    assert.equal(parsed.undetermined, true)
    assert.equal(parsed.schemaRequested, 'object')
  })

  it('健康探测恒为 ok（它是「永远可用」的那一层）', async () => {
    const st = await new LocalEchoProvider().healthCheck()
    assert.equal(st.ok, true)
  })
})

// ---------------------------------------------------------------------------
// Dify 请求构建（docs/06 §3.4 差异表）
// ---------------------------------------------------------------------------

describe('DifyProvider · 请求体与响应解析', () => {
  it('请求体含 query / inputs / response_mode=blocking / user', async () => {
    const http = new FakeHttpClient().setDefault(
      jsonResponse({ event: 'message', answer: '萧炎', conversation_id: 'c-1', metadata: {} }),
    )
    const p = new DifyProvider({
      baseUrl: 'https://api.dify.ai',
      apiKey: 'app-test-key',
      model: 'dify-default',
      inputs: { project: '斗破苍穹' },
      http,
    })

    const res = await p.chat(
      [
        { role: 'system', content: '你是中文有声书助手' },
        { role: 'user', content: '判断：我萧炎，从来不会认输。' },
      ],
      baseOpts,
    )

    assert.equal(http.requests.length, 1)
    assert.equal(http.requests[0].url, 'https://api.dify.ai/v1/chat-messages')
    assert.equal(http.requests[0].method, 'POST')
    assert.equal(http.requests[0].headers?.authorization, 'Bearer app-test-key')
    const body = http.body(0)
    assert.equal(body.response_mode, 'blocking')
    assert.equal(body.user, deriveAnonymousUserId('app-test-key'))
    assert.deepEqual(body.inputs, { project: '斗破苍穹' })
    assert.match(String(body.query), /\[user\]/)
    assert.match(String(body.query), /你是中文有声书助手/)
    assert.equal(res.text, '萧炎')
  })

  it('批量逐行判定默认新建会话：请求体里**没有** conversation_id', async () => {
    const http = new FakeHttpClient().setDefault(
      jsonResponse({ event: 'message', answer: 'ok', conversation_id: 'c-should-not-stick' }),
    )
    const p = new DifyProvider({ baseUrl: 'https://api.dify.ai', apiKey: 'app-k', http })

    await p.chat(msgs, baseOpts)
    await p.chat(msgs, baseOpts)
    await p.chat(msgs, baseOpts)

    assert.equal(http.requests.length, 3)
    for (let i = 0; i < 3; i++) {
      assert.equal('conversation_id' in http.body(i), false, `第 ${i + 1} 次调用不应携带 conversation_id`)
    }
    // 也不应该把响应里的会话 id 记下来污染后续判定
    assert.equal(p.currentConversationId, null)
  })

  it('显式 reuseConversation=true 时才复用并记住会话', async () => {
    const http = new FakeHttpClient()
      .queue(jsonResponse({ event: 'message', answer: '第一轮', conversation_id: 'c-42' }))
      .setDefault(jsonResponse({ event: 'message', answer: '第二轮', conversation_id: 'c-42' }))

    const p = new DifyProvider({ baseUrl: 'https://api.dify.ai', apiKey: 'app-k', http })
    await p.chat(msgs, { ...baseOpts, reuseConversation: true })
    assert.equal(p.currentConversationId, 'c-42')

    await p.chat(msgs, { ...baseOpts, reuseConversation: true })
    assert.equal(http.body(1).conversation_id, 'c-42')

    p.resetConversation()
    assert.equal(p.currentConversationId, null)
  })

  it('模型名取自 metadata.model.name（差异表第 2 行）', async () => {
    const http = new FakeHttpClient().setDefault(
      jsonResponse({
        event: 'message',
        answer: '{}',
        conversation_id: 'c',
        metadata: { model: { name: 'qwen-max', provider: 'tongyi' }, usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
      }),
    )
    const p = new DifyProvider({ baseUrl: 'https://api.dify.ai', apiKey: 'app-k', model: 'fallback-name', http })
    const res = await p.chat(msgs, baseOpts)
    assert.equal(res.model, 'qwen-max')
    assert.deepEqual(res.usage, { promptTokens: 11, completionTokens: 3, totalTokens: 14 })
  })

  it('baseUrl 已带 /v1 时不会拼成 /v1/v1', () => {
    assert.equal(joinApiPath('https://api.dify.ai/v1', '/v1/chat-messages'), 'https://api.dify.ai/v1/chat-messages')
    assert.equal(joinApiPath('https://api.dify.ai/', '/v1/chat-messages'), 'https://api.dify.ai/v1/chat-messages')
  })

  it('答案缺失（既无 answer 也无 outputs）→ PROVIDER_UNAVAILABLE', async () => {
    const http = new FakeHttpClient().setDefault(jsonResponse({ event: 'message', metadata: {} }))
    const p = new DifyProvider({ baseUrl: 'https://api.dify.ai', apiKey: 'app-k', http })
    await assert.rejects(
      () => p.chat(msgs, baseOpts),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE',
    )
  })

  it('event=error 时抛 PROVIDER_UNAVAILABLE（不把错误当答案）', async () => {
    const http = new FakeHttpClient().setDefault(jsonResponse({ event: 'error', status: 400, code: 'invalid_param' }))
    const p = new DifyProvider({ baseUrl: 'https://api.dify.ai', apiKey: 'app-k', http })
    await assert.rejects(
      () => p.chat(msgs, baseOpts),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE',
    )
  })

  it('foldMessagesToQuery 把 system 折叠成前缀、其余按角色拼装', () => {
    const q = foldMessagesToQuery([
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
    ])
    assert.match(q, /^S1\n\nS2\n\n/)
    assert.match(q, /\[user\] U1/)
    assert.match(q, /\[assistant\] A1/)
  })

  it('buildDifyChatRequest 只传 conversation_id 时才带该字段', () => {
    const cfg = { baseUrl: 'https://api.dify.ai', apiKey: 'app-k', http: new FakeHttpClient() }
    const fresh = buildDifyChatRequest(msgs, baseOpts, cfg, null)
    assert.equal('conversation_id' in (fresh.body as Record<string, unknown>), false)
    const reuse = buildDifyChatRequest(msgs, { ...baseOpts, reuseConversation: true }, cfg, 'c-9')
    assert.equal((reuse.body as Record<string, unknown>).conversation_id, 'c-9')
  })
})

// ---------------------------------------------------------------------------
// allowCloud 隐私红线
// ---------------------------------------------------------------------------

describe('隐私红线 · allowCloud=false', () => {
  it('Dify：不发任何请求且抛 PROVIDER_CLOUD_DISABLED', async () => {
    const http = new FakeHttpClient()
    const p = new DifyProvider({ baseUrl: 'https://api.dify.ai', apiKey: 'app-k', http })
    await assert.rejects(
      () => p.chat(msgs, { allowCloud: false, purpose: 'attribution_review' }),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_CLOUD_DISABLED',
    )
    assert.equal(http.requests.length, 0, '被隐私设置拦截时绝不能发出任何网络请求')
  })

  it('OpenAI 兼容：同样一个请求都不发', async () => {
    const http = new FakeHttpClient()
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5', http })
    await assert.rejects(
      () => p.chat(msgs, { allowCloud: false }),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_CLOUD_DISABLED',
    )
    assert.equal(http.requests.length, 0)
  })
})

// ---------------------------------------------------------------------------
// OpenAI 兼容
// ---------------------------------------------------------------------------

describe('OpenAICompatibleProvider · 构建与解析', () => {
  it('请求打到 {baseUrl}/v1/chat/completions 并原样透传 messages', async () => {
    const http = new FakeHttpClient().setDefault(
      jsonResponse({ model: 'qwen2.5:7b', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
    )
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5', http })
    await p.chat(msgs, baseOpts)
    assert.equal(http.requests[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
    const body = http.body(0)
    assert.equal(body.model, 'qwen2.5')
    assert.deepEqual(body.messages, [{ role: 'user', content: '请判断这句台词属于谁' }])
  })

  it('解析 choices[0].message.content 与 usage', () => {
    const cfg = { baseUrl: 'http://x', model: 'cfg-model', http: new FakeHttpClient() }
    const parsed = parseOpenAIChatResponse(
      jsonResponse({
        model: 'real-model',
        choices: [{ message: { content: '{"speaker":"萧炎"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      }),
      cfg,
    )
    assert.equal(parsed.text, '{"speaker":"萧炎"}')
    assert.equal(parsed.model, 'real-model')
    assert.deepEqual(parsed.usage, { promptTokens: 30, completionTokens: 12, totalTokens: 42 })
    assert.equal(parsed.finishReason, 'stop')
  })

  it('usage 缺失时返回 undefined（不伪造 token 数）', () => {
    const cfg = { baseUrl: 'http://x', model: 'cfg-model', http: new FakeHttpClient() }
    const parsed = parseOpenAIChatResponse(
      jsonResponse({ choices: [{ message: { content: 'hi' } }] }),
      cfg,
    )
    assert.equal(parsed.usage, undefined)
    assert.equal(parsed.model, 'cfg-model', '模型名缺失时回落到配置值')
  })

  it('缺 choices → PROVIDER_UNAVAILABLE（让降级链接手）', () => {
    const cfg = { baseUrl: 'http://x', model: 'm', http: new FakeHttpClient() }
    assert.throws(
      () => parseOpenAIChatResponse(jsonResponse({ error: 'boom' }), cfg),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE',
    )
  })

  it('choices 为空数组 / content 为空也拒绝', () => {
    const cfg = { baseUrl: 'http://x', model: 'm', http: new FakeHttpClient() }
    assert.throws(
      () => parseOpenAIChatResponse(jsonResponse({ choices: [] }), cfg),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE',
    )
    assert.throws(
      () => parseOpenAIChatResponse(jsonResponse({ choices: [{ message: {} }] }), cfg),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE',
    )
  })

  it('content 为分段数组时拼接（网关常见形态）', () => {
    const cfg = { baseUrl: 'http://x', model: 'm', http: new FakeHttpClient() }
    const parsed = parseOpenAIChatResponse(
      jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }] } }] }),
      cfg,
    )
    assert.equal(parsed.text, 'abcd')
  })

  it('HTTP 401 → PROVIDER_UNAVAILABLE（鉴权问题，重试是噪音）', async () => {
    const http = new FakeHttpClient().setDefault({ status: 401, ok: false, json: { error: 'unauthorized' } })
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://x', model: 'm', apiKey: 'sk-x', http })
    await assert.rejects(
      () => p.chat(msgs, baseOpts),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE' && e.retryable === false,
    )
  })

  it('HTTP 503 → PROVIDER_UNAVAILABLE 且可重试', async () => {
    const http = new FakeHttpClient().setDefault({ status: 503, ok: false, json: {} })
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://x', model: 'm', http })
    await assert.rejects(
      () => p.chat(msgs, baseOpts),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_UNAVAILABLE' && e.retryable === true,
    )
  })

  it('带 jsonSchema 时附加 response_format: json_object', () => {
    const req = buildOpenAIChatRequest(msgs, { ...baseOpts, jsonSchema: { type: 'object' } }, {
      baseUrl: 'http://x',
      model: 'm',
      http: new FakeHttpClient(),
    })
    assert.deepEqual((req.body as Record<string, unknown>).response_format, { type: 'json_object' })
  })
})

// ---------------------------------------------------------------------------
// FallbackProvider
// ---------------------------------------------------------------------------

class ScriptedProvider implements AIProvider {
  readonly kind: ProviderKind
  calls = 0
  readonly received: ChatOptions[] = []
  /** 脚本队列：长度 > 1 时逐个出队，剩最后一项则重复使用（模拟「一直失败」） */
  private script: Array<'ok' | Error>

  constructor(kind: ProviderKind, script: Array<'ok' | Error>) {
    this.kind = kind
    this.script = script
  }

  push(...items: Array<'ok' | Error>): void {
    this.script.push(...items)
  }

  /** 直接替换整条脚本（用于「冷却结束后恢复正常」这类场景） */
  reset(...items: Array<'ok' | Error>): void {
    this.script = items
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, message: `${this.kind} 可用` }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    this.calls++
    this.received.push(opts)
    const next = this.script.length > 1 ? this.script.shift() : this.script[0]
    if (next instanceof Error) throw next
    return {
      text: `${this.kind}:${messages.length}`,
      model: `${this.kind}-model`,
      provider: this.kind,
      latencyMs: 1,
    }
  }
}

describe('FallbackProvider · 降级与熔断', () => {
  it('首个 Provider 失败时自动切到下一个，并在结果里如实标注 provider', async () => {
    const primary = new ScriptedProvider('dify', [new AppError('PROVIDER_UNAVAILABLE')])
    const fb = new FallbackProvider([primary, new LocalEchoProvider()])

    const res = await fb.chat(msgs, baseOpts)
    assert.equal(res.provider, 'local')
    assert.equal(primary.calls, 1)
    const route = fb.getLastRoute()
    assert.deepEqual(
      route.map((r) => `${r.provider}:${r.outcome}`),
      ['dify:error', 'local:success'],
    )
  })

  it('连续 5 次失败后熔断，getCircuitState() 反映状态与剩余时间', async () => {
    let now = 1_000_000
    const primary = new ScriptedProvider('dify', [new AppError('PROVIDER_TIMEOUT')])
    const fb = new FallbackProvider([primary, new LocalEchoProvider()], {
      failureThreshold: 5,
      cooldownMs: 5 * 60_000,
      now: () => now,
    })

    for (let i = 0; i < 5; i++) {
      const res = await fb.chat(msgs, baseOpts)
      assert.equal(res.provider, 'local', `第 ${i + 1} 次应降级到兜底`)
    }

    const state = fb.getCircuitState()
    assert.equal(state.provider, 'dify')
    assert.equal(state.state, 'open')
    assert.equal(state.untilTs, now + 5 * 60_000)
    assert.equal(state.remainingMs, 5 * 60_000)
    assert.equal(state.consecutiveFailures, 5)
    assert.equal(state.lastErrorKey, 'PROVIDER_TIMEOUT')

    // 熔断期间不再调用首个 provider
    const callsAtOpen = primary.calls
    for (let i = 0; i < 3; i++) await fb.chat(msgs, baseOpts)
    assert.equal(primary.calls, callsAtOpen, '熔断期间不得再调用首个 Provider')
    assert.equal(fb.getStats().skippedDueToCircuit, 3)

    // 冷却中：剩余时间递减
    now += 3 * 60_000
    assert.equal(fb.getCircuitState().remainingMs, 2 * 60_000)

    // 冷却结束：半开试探，重新调用
    now += 2 * 60_000 + 1
    assert.equal(fb.getCircuitState().state, 'closed')
    await fb.chat(msgs, baseOpts)
    assert.equal(primary.calls, callsAtOpen + 1, '冷却结束后允许一次试探')
  })

  it('熔断后一旦成功即恢复（失败计数清零）', async () => {
    let now = 0
    const primary = new ScriptedProvider('openai-compatible', [new AppError('PROVIDER_TIMEOUT')])
    const fb = new FallbackProvider([primary, new MockProvider()], {
      failureThreshold: 2,
      cooldownMs: 1000,
      now: () => now,
    })

    await fb.chat(msgs, baseOpts)
    await fb.chat(msgs, baseOpts)
    assert.equal(fb.getCircuitState().state, 'open')

    // 冷却结束后让主 Provider 恢复正常
    now = 2000
    primary.reset('ok')
    const res = await fb.chat(msgs, baseOpts)
    assert.equal(res.provider, 'openai-compatible')
    assert.equal(fb.getCircuitState().state, 'closed')
    assert.equal(fb.getCircuitState().consecutiveFailures, 0)
  })

  it('取消类错误立即冒泡，不计入熔断、不降级（docs/22 取消不是错误）', async () => {
    const primary = new ScriptedProvider('dify', [new AppError('PROVIDER_ABORTED')])
    const fallback = new LocalEchoProvider()
    const fb = new FallbackProvider([primary, fallback])

    await assert.rejects(
      () => fb.chat(msgs, baseOpts),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_ABORTED',
    )
    assert.equal(fb.getCircuitState().consecutiveFailures, 0)
  })

  it('PROVIDER_CLOUD_DISABLED 直接冒泡且不计入熔断（这是用户设置，不是故障）', async () => {
    const primary = new ScriptedProvider('dify', [new AppError('PROVIDER_CLOUD_DISABLED')])
    const fb = new FallbackProvider([primary, new LocalEchoProvider()])
    await assert.rejects(
      () => fb.chat(msgs, { allowCloud: false }),
      (e: unknown) => isAppError(e) && e.key === 'PROVIDER_CLOUD_DISABLED',
    )
    assert.equal(fb.getCircuitState().consecutiveFailures, 0)
  })

  it('chain 里恒有兜底：createFallbackChain 不会重复追加 LocalEcho', () => {
    const chain = createFallbackChain(new MockProvider())
    assert.deepEqual(chain.chain, ['mock', 'local'])
    const localOnly = createFallbackChain(new LocalEchoProvider())
    assert.deepEqual(localOnly.chain, ['local'])
  })

  it('全部失败的极端情况：抛主 Provider 的语义键，并带链路诊断（脱敏）', async () => {
    const a = new ScriptedProvider('dify', [new AppError('PROVIDER_UNAVAILABLE')])
    const b = new ScriptedProvider('openai-compatible', [new AppError('PROVIDER_UNAVAILABLE')])
    const fb = new FallbackProvider([a, b], { failureThreshold: 99 })
    await assert.rejects(
      () => fb.chat(msgs, baseOpts),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PROVIDER_UNAVAILABLE')
        assert.deepEqual(e.details?.chain, ['dify', 'openai-compatible'])
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

const baseSettings: AiSettings = {
  provider: 'mock',
  baseUrl: '',
  model: 'mock-1',
  timeoutMs: 60_000,
  maxConcurrency: 2,
  allowSendTextToCloud: false,
}

describe('resolveProvider · 降级链组装', () => {
  it('mock → [mock, local]，且末尾永远是兜底', () => {
    const p = resolveProvider(baseSettings) as FallbackProvider
    assert.deepEqual(p.chain, ['mock', 'local'])
  })

  it('local → [local]（不会重复追加）', () => {
    const p = resolveProvider({ ...baseSettings, provider: 'local' }) as FallbackProvider
    assert.deepEqual(p.chain, ['local'])
  })

  it('dify 配置缺失时不静默降级：链上挂着会明确报错的占位 Provider', async () => {
    const p = resolveProvider({ ...baseSettings, provider: 'dify', baseUrl: '' }) as FallbackProvider
    assert.deepEqual(p.chain, ['dify', 'local'])
    const health = await p.getCircuitStates()
    assert.equal(health[0].provider, 'dify')
    // 调用会失败（配置不全），降级到兜底并如实返回 provider='local'
    const res = await p.chat(msgs, { allowCloud: true })
    assert.equal(res.provider, 'local')
    assert.equal(p.getStats().failures, 1)
  })

  it('openai-compatible 有 baseUrl 时走真实 Provider（HttpClient 可注入）', async () => {
    const http = new FakeHttpClient().setDefault(
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    )
    const p = resolveProvider(
      { ...baseSettings, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5' },
      { http },
    )
    const res = await p.chat(msgs, { allowCloud: true })
    assert.equal(res.provider, 'openai-compatible')
    assert.equal(http.requests[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
  })

  it('未登记的 provider 值抛 INVALID_PAYLOAD（而不是悄悄用 mock）', () => {
    assert.throws(
      () => resolveProvider({ ...baseSettings, provider: 'nope' as never }),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })
})
