/**
 * 回归 · Provider 解析（「测试连接」为什么必须只测主 Provider）
 * ============================================================================
 * 修复前的两个问题：
 *   1. `settings:testProvider` 在主进程里是个直接抛 `NOT_IMPLEMENTED` 的桩 —— 设置页
 *      「测试连接」永远失败，用户看到的却是一句「功能未实现」。
 *   2. 即使拿降级链去测也不对：`FallbackProvider.healthCheck()` 的语义是 `some(ok)`，
 *      而链尾**永远**有 LocalEcho（`ok: true`）→ 无论云端地址/密钥是否正确，
 *      都会显示「连接成功」。那等于没有测试。
 *
 * 因此新增 `resolvePrimaryProvider()`：只解析用户真正配置的那一个 Provider。
 * 这组测试同时钉住「降级链会假成功」这个反面，防止有人又把两者混用。
 *
 * 全程用注入的假 HttpClient，不联网。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { resolveProvider, resolvePrimaryProvider } from '../../src/shared/ai/factory.ts'
import { FallbackProvider } from '../../src/shared/ai/providers/fallback.ts'
import type { AiSettings, HttpClient, HttpRequest, HttpResponse } from '../../src/shared/ai/types.ts'

const OPENAI: AiSettings = {
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:7b-instruct',
  timeoutMs: 5000,
  maxConcurrency: 2,
  allowSendTextToCloud: true,
}

function fakeHttp(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>): HttpClient {
  return { request: async (req) => await handler(req) }
}

const OK_HTTP = fakeHttp(() => ({ status: 200, ok: true, json: { data: [] } }))
const DEAD_HTTP = fakeHttp(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') })

describe('resolvePrimaryProvider · 只解析主 Provider', () => {
  it('可达的 OpenAI 兼容端点 → ok: true，并命中 /v1/models（baseUrl 已带 /v1 不重复）', async () => {
    const seen: string[] = []
    const http = fakeHttp((req) => {
      seen.push(req.url)
      return { status: 200, ok: true, json: { data: [] } }
    })
    const primary = resolvePrimaryProvider(OPENAI, { http })

    assert.equal(primary.kind, 'openai-compatible')
    const status = await primary.healthCheck()
    assert.equal(status.ok, true, status.message)
    assert.deepEqual(seen, ['http://127.0.0.1:11434/v1/models'], 'baseUrl 已含 /v1 时不得拼成 /v1/v1')
  })

  it('不可达的端点 → ok: false 且带上原因（这正是「测试连接」要显示的东西）', async () => {
    const status = await resolvePrimaryProvider(OPENAI, { http: DEAD_HTTP }).healthCheck()
    assert.equal(status.ok, false)
    assert.match(status.message, /ECONNREFUSED/)
  })

  it('未填服务地址 → Misconfigured，明确说「尚未填写」而不是假装可用', async () => {
    const status = await resolvePrimaryProvider(
      { ...OPENAI, baseUrl: '' },
      { http: OK_HTTP },
    ).healthCheck()
    assert.equal(status.ok, false)
    assert.match(status.message, /尚未填写/)
  })

  it('Dify 未填应用密钥 → Misconfigured', async () => {
    const status = await resolvePrimaryProvider(
      { ...OPENAI, provider: 'dify', baseUrl: 'http://dify.local' },
      { http: OK_HTTP, apiKey: null },
    ).healthCheck()
    assert.equal(status.ok, false)
    assert.match(status.message, /密钥/)
  })

  it('mock / local 主 Provider 自身都是可用的', async () => {
    assert.equal((await resolvePrimaryProvider({ ...OPENAI, provider: 'mock' }, { http: OK_HTTP }).healthCheck()).ok, true)
    assert.equal((await resolvePrimaryProvider({ ...OPENAI, provider: 'local' }, { http: OK_HTTP }).healthCheck()).ok, true)
  })
})

describe('降级链的 healthCheck 不能用来做「测试连接」', () => {
  it('主 Provider 不可达时降级链仍报 ok: true（被 LocalEcho 兜住）', async () => {
    const chain = resolveProvider(OPENAI, { http: DEAD_HTTP })
    assert.ok(chain instanceof FallbackProvider, 'resolveProvider 应返回降级链')
    assert.deepEqual(chain.chain, ['openai-compatible', 'local'], '链尾永远是 LocalEcho')

    const chainStatus = await chain.healthCheck()
    // 这条断言记录的是**反例**：混用两者会让「测试连接」永远显示成功。
    assert.equal(chainStatus.ok, true, '降级链会因为 LocalEcho 恒 ok，所以不能拿它做连通性测试')

    const primaryStatus = await resolvePrimaryProvider(OPENAI, { http: DEAD_HTTP }).healthCheck()
    assert.equal(primaryStatus.ok, false, '主 Provider 才是「测试连接」该看的那个')
  })

  it('local Provider 的链只有它自己（不重复追加兜底）', () => {
    const chain = resolveProvider({ ...OPENAI, provider: 'local' }, { http: OK_HTTP })
    assert.ok(chain instanceof FallbackProvider)
    assert.deepEqual(chain.chain, ['local'])
  })
})
