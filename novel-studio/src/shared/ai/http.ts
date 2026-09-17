/**
 * Novel Studio · 内置 HTTP 客户端与错误映射
 * ============================================================================
 * 设计依据：
 *   · docs/06 §3.4  鉴权头差异（Dify 用应用级 Key，OpenAI 用 sk-...）
 *   · docs/06 §9    隐私：日志只记长度/耗时/状态码，绝不含正文与 API Key
 *   · docs/22       PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT / PROVIDER_NETWORK_ERROR / PROVIDER_ABORTED
 *
 * 这里用的是 Node 18+ 的全局 `fetch`，**不引入 undici 等第三方包**。
 * Provider 只依赖 `types.ts` 里的 `HttpClient` 接口，因此测试可以注入 fake，
 * 完全不需要网络。
 */

import { AppError, wrapUnknown } from '../errors.ts'
import type { HttpClient, HttpRequest, HttpResponse } from './types.ts'
import { DEFAULT_TIMEOUT_MS } from './types.ts'
import { sanitizeRequestForLog, sanitizeResponseForLog } from './usage.ts'

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
  status: number
  ok: boolean
  headers?: { forEach(cb: (v: string, k: string) => void): void }
  text(): Promise<string>
}>

export interface FetchHttpClientOptions {
  /** 注入 fetch（测试/Electron 各版本差异兜底）；默认取全局 fetch */
  fetchImpl?: FetchLike
  defaultTimeoutMs?: number
  /** 每完成一次请求的回调，参数**已脱敏**（docs/06 §9） */
  onRequest?: (log: { request: ReturnType<typeof sanitizeRequestForLog>; response: ReturnType<typeof sanitizeResponseForLog>; latencyMs: number }) => void
}

/**
 * 基于全局 fetch 的 HttpClient 实现。
 *
 * 错误映射（全部经 `wrapUnknown`，因此 ECONNRESET/ENOTFOUND 等 errno 会被
 * errors.ts 的 SYSTEM_ERRNO_MAP 自动转成语义键）：
 *   · 调用方 signal 已中止 → PROVIDER_ABORTED（取消不是错误）
 *   · 超时              → PROVIDER_TIMEOUT
 *   · 其它网络异常      → PROVIDER_NETWORK_ERROR / PROVIDER_UNAVAILABLE
 */
export function createFetchHttpClient(options: FetchHttpClientOptions = {}): HttpClient {
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
      if (typeof fetchImpl !== 'function') {
        throw new AppError('PROVIDER_UNAVAILABLE', {
          details: { reason: 'runtime-fetch-missing' },
        })
      }

      const timeoutMs = req.timeoutMs ?? defaultTimeout
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal

      const headers: Record<string, string> = { ...(req.headers ?? {}) }
      let body: string | undefined
      if (req.body !== undefined) {
        body = JSON.stringify(req.body)
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json'
        }
      }

      const started = Date.now()
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await fetchImpl(req.url, {
          method: req.method ?? 'POST',
          headers,
          body,
          signal,
        })
      } catch (e) {
        if (req.signal?.aborted) throw new AppError('PROVIDER_ABORTED', { cause: e })
        if (timeoutSignal.aborted) {
          throw new AppError('PROVIDER_TIMEOUT', { cause: e, details: { timeoutMs } })
        }
        throw wrapUnknown(e, 'PROVIDER_NETWORK_ERROR')
      }

      const text = await res.text().catch(() => '')
      let json: unknown
      if (text) {
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
      }

      const out: HttpResponse = {
        status: res.status,
        ok: res.ok,
        json,
        text,
      }

      options.onRequest?.({
        request: sanitizeRequestForLog({ url: req.url, method: req.method, headers, body: req.body }),
        response: sanitizeResponseForLog({ status: res.status, text }),
        latencyMs: Date.now() - started,
      })

      return out
    },
  }
}

/**
 * HTTP 状态码 → 业务错误。
 *
 * 注意：**绝不把响应正文塞进错误详情**（可能回显用户作品文本，违反 docs/06 §9）。
 */
export function assertHttpOk(res: HttpResponse, providerLabel: string): void {
  if (res.status >= 200 && res.status < 300) return

  const status = res.status
  // 429/5xx 属临时故障，可重试；401/403/400 属配置问题，重试只是噪音
  const retryable = status === 429 || status >= 500
  const details: Record<string, unknown> = { provider: providerLabel, status }
  if (status === 401 || status === 403) details.reason = 'auth'
  else if (status === 404) details.reason = 'endpoint-not-found'
  else if (status === 429) details.reason = 'rate-limited'
  else if (status >= 500) details.reason = 'server-error'
  else details.reason = 'bad-request'

  throw new AppError('PROVIDER_UNAVAILABLE', { details, retryable })
}

/** 把注入的 fake HttpClient 也纳入同一套状态码语义（Provider 内部统一调用它） */
export function expectJsonObject(res: HttpResponse, providerLabel: string): Record<string, unknown> {
  assertHttpOk(res, providerLabel)
  if (!res.json || typeof res.json !== 'object' || Array.isArray(res.json)) {
    throw new AppError('PROVIDER_UNAVAILABLE', {
      details: { provider: providerLabel, reason: 'non-json-response' },
    })
  }
  return res.json as Record<string, unknown>
}
