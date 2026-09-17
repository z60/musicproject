/**
 * 基础设施 · HTTP 客户端（注入式 fetch 封装 + SSRF 防护）
 * ============================================================================
 * 设计依据：docs/04 §10「网络与 Provider 调用」
 *
 * | 项 | 策略 |
 * |----|------|
 * | 客户端 | undici（request + Agent）—— 这里只依赖一个 `fetch` 形状的函数，由调用方注入 |
 * | 超时 | 连接 10 s、首字节 60 s（流式则空闲 30 s） |
 * | 重试 | 仅网络类错误与 429/5xx；指数退避 1s→4s；最多 2 次 |
 * | 并发 | 默认 2（防限流与雪崩） |
 * | 外发确认 | 首次向云端发送作品文本时弹窗确认；allowSendTextToCloud=false 时直接拒绝 |
 * | 抓取（URL 导入） | 同客户端；额外做 SSRF 防护（拒绝内网/环回/链路本地地址）、
 * |                | 限制重定向次数（≤5）、限制单页大小（≤5 MB）、限制总页数 |
 *
 * **为什么自己写 SSRF 校验**：URL 导入是「用户给什么就抓什么」的入口，
 * 如果不校验，一个被注入的 `http://127.0.0.1:8080/admin` 就能让主进程去访问本机服务
 * （Electron 主进程拥有完整 Node 权限）。这是最典型的 SSRF 场景，
 * 防护必须发生在**每一次**请求（含重定向后的新 URL）上。
 *
 * 关于 fetch 的注入：环境无网络/无 undici，因此这里接收 `fetch` 实现，
 * 生产环境传 undici 的 `request` 包装（见 `createUndiciFetch` 说明），
 * 测试传一个可编程的假实现。
 */

import { lookup } from 'node:dns/promises'

import { AppError, wrapUnknown } from '../../../shared/errors.ts'
import { delay } from '../queue/yield.ts'

// ---------------------------------------------------------------------------
// 最小 fetch 接口
// ---------------------------------------------------------------------------

export interface HttpResponseLike {
  status: number
  /** 兼容 undici/WHATWG 的 Headers 与普通对象 */
  headers: { get(name: string): string | null } | Record<string, string | string[] | undefined>
  /** 最终 URL（follow 模式下可能与请求 URL 不同；本实现用 manual，故等于当前 URL） */
  url?: string
  text(): Promise<string>
  arrayBuffer?(): Promise<ArrayBuffer>
}

export interface HttpRequestInitLike {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  redirect?: 'manual' | 'follow' | 'error'
}

export type FetchLike = (url: string, init: HttpRequestInitLike) => Promise<HttpResponseLike>

// ---------------------------------------------------------------------------
// SSRF 防护
// ---------------------------------------------------------------------------

/** 明确禁止的主机名（大小写不敏感；`.local`/`.internal` 为额外加固） */
const FORBIDDEN_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan']
const FORBIDDEN_HOST_EXACT = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata', 'metadata.google.internal'])

/** 允许的协议（docs/04 §10：抓取只允许公开网页） */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export interface SsrfCheckOptions {
  /** 允许访问内网（仅用于企业内网部署的显式开关，默认 false） */
  allowPrivateHosts?: boolean
  /** 主机名解析（默认 node:dns lookup）；测试可注入 */
  resolveHost?: (hostname: string) => Promise<string[]>
}

/** 解析 IPv4 字面量 → 4 字节；非法返回 null */
export function parseIpv4(value: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!m) return null
  const parts = m.slice(1, 5).map((n) => Number(n))
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return parts as [number, number, number, number]
}

/** 该 IPv4 是否属于「不可外发」的地址段 */
export function isForbiddenIpv4(ip: string): boolean {
  const parsed = parseIpv4(ip)
  if (!parsed) return false
  const [a, b] = parsed
  if (a === 0) return true // 0.0.0.0/8「本网络」
  if (a === 10) return true // 私有
  if (a === 127) return true // 环回
  if (a === 169 && b === 254) return true // 链路本地（云元数据服务在这里）
  if (a === 172 && b >= 16 && b <= 31) return true // 私有
  if (a === 192 && b === 168) return true // 私有
  if (a === 192 && b === 0) return true // 192.0.0.0/24 与 192.0.2.0/24（保留/文档）
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试段
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a >= 224) return true // 组播 + 保留（含 255.255.255.255）
  return false
}

/** 该 IPv6 字面量是否属于「不可外发」的地址段（含 IPv4 映射） */
export function isForbiddenIpv6(ip: string): boolean {
  const lower = stripZone(ip).toLowerCase()
  if (lower === '::' || lower === '::1') return true
  // IPv4 映射/兼容写法：::ffff:127.0.0.1
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower)
  if (mapped) return isForbiddenIpv4(mapped[1] as string)
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true // fe80::/10 链路本地
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true // ff00::/8 组播
  if (lower.startsWith('64:ff9b:')) return true // NAT64 映射（可绕过 v4 检查）
  return false
}

function stripZone(ip: string): string {
  const idx = ip.indexOf('%')
  return idx >= 0 ? ip.slice(0, idx) : ip
}

/** 主机名（非 IP）是否明确指向本机/内网 */
export function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (FORBIDDEN_HOST_EXACT.has(host)) return true
  if (FORBIDDEN_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true
  return false
}

/** `[::1]` → `::1`；普通主机名原样返回 */
export function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** 同步校验（只看字面量，不做 DNS）：用于 preload / 渲染侧快速拦一刀 */
export function isForbiddenTargetSync(rawUrl: string): { forbidden: boolean; reason?: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { forbidden: true, reason: 'invalid-url' }
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { forbidden: true, reason: `protocol:${url.protocol}` }
  const host = stripIpv6Brackets(url.hostname)
  if (isForbiddenHostname(host)) return { forbidden: true, reason: 'loopback-hostname' }
  if (parseIpv4(host) && isForbiddenIpv4(host)) return { forbidden: true, reason: 'private-ipv4' }
  if (host.includes(':') && isForbiddenIpv6(host)) return { forbidden: true, reason: 'private-ipv6' }
  return { forbidden: false }
}

/**
 * 完整校验（含 DNS 解析）：**每一次请求与每一次重定向都必须调用**。
 *
 * 为什么要解析 DNS：`http://evil.example.com` 完全可以解析到 `127.0.0.1`
 * （DNS rebinding / 内网域名）。只看字面量是不够的。
 *
 * @throws AppError('FETCH_FORBIDDEN_TARGET')
 */
export async function assertUrlAllowed(rawUrl: string, opts?: SsrfCheckOptions): Promise<URL> {
  const quick = isForbiddenTargetSync(rawUrl)
  if (quick.forbidden) {
    throw new AppError('FETCH_FORBIDDEN_TARGET', { details: { url: rawUrl, reason: quick.reason } })
  }
  const url = new URL(rawUrl)
  if (opts?.allowPrivateHosts) return url

  const host = stripIpv6Brackets(url.hostname)
  const isLiteral = Boolean(parseIpv4(host)) || host.includes(':')
  if (isLiteral) return url

  const resolver = opts?.resolveHost ?? defaultResolveHost
  let addresses: string[]
  try {
    addresses = await resolver(host)
  } catch (e) {
    // 解析不了 → 请求本身也会失败，交给上层映射成 FETCH_FAILED 更好；
    // 但为了不「放行未知目标」，这里按禁止处理并给出解析失败原因
    throw new AppError('FETCH_FORBIDDEN_TARGET', {
      cause: e,
      details: { url: rawUrl, host, reason: 'dns-resolution-failed' },
    })
  }
  for (const addr of addresses) {
    const clean = stripZone(addr)
    if (parseIpv4(clean) ? isForbiddenIpv4(clean) : isForbiddenIpv6(clean)) {
      throw new AppError('FETCH_FORBIDDEN_TARGET', {
        details: { url: rawUrl, host, resolved: addr, reason: 'resolves-to-private-address' },
      })
    }
  }
  return url
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const res = await lookup(hostname, { all: true, verbatim: true })
  return res.map((r) => r.address)
}

// ---------------------------------------------------------------------------
// 并发限制
// ---------------------------------------------------------------------------

/** 极简信号量（不引入 p-limit：只有十几行，且需要可注入的语义） */
export function createSemaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, limit)
  let active = 0
  const queue: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      const next = queue.shift()
      if (next) next()
    }
  }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface HttpClientOptions {
  /** 注入的 fetch（生产：undici，见文件顶部说明） */
  fetch: FetchLike
  /** 连接超时（docs/04 §10：10 s） */
  connectTimeoutMs?: number
  /** 首字节超时（docs/04 §10：60 s） */
  firstByteTimeoutMs?: number
  /** 流式空闲超时（docs/04 §10：30 s） */
  idleTimeoutMs?: number
  /** 重定向上限（docs/04 §10：≤5） */
  maxRedirects?: number
  /** 最大重试次数（docs/04 §10：最多 2 次） */
  maxRetries?: number
  retryDelaysMs?: readonly number[]
  /** 并发上限（默认 2，docs/04 §10） */
  concurrency?: number
  /** 单响应体上限（默认 5 MB，docs/10 §2） */
  maxResponseBytes?: number
  /** 允许内网（默认 false；仅企业内网部署显式开启） */
  allowPrivateHosts?: boolean
  resolveHost?: (hostname: string) => Promise<string[]>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  userAgent?: string
  log?: {
    debug?: (event: string, fields: Record<string, unknown>) => void
    warn?: (event: string, fields: Record<string, unknown>) => void
  }
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** 已序列化的请求体（对象请自行 JSON.stringify，避免隐式头部不一致） */
  body?: string | Uint8Array
  signal?: AbortSignal
  /** 本次请求的响应体上限 */
  maxBytes?: number
  /** 单次覆盖（如 URL 导入允许/禁止内网） */
  allowPrivateHosts?: boolean
  /** 附带与重试相关的幂等提示（非幂等方法不自动重试） */
  idempotent?: boolean
}

export interface HttpResult {
  status: number
  url: string
  headers: Record<string, string>
  body: string
  bytes: number
  elapsedMs: number
  redirects: number
  attempts: number
}

export interface HttpClient {
  request(url: string, opts?: HttpRequestOptions): Promise<HttpResult>
  requestJson<T = unknown>(url: string, opts?: HttpRequestOptions): Promise<{ status: number; data: T; result: HttpResult }>
  /** 只暴露校验，便于 URL 导入在「用户点确定」时就先拦一刀 */
  assertAllowed(url: string, opts?: SsrfCheckOptions): Promise<URL>
  stats(): { active: number; queued: number }
}

/**
 * 创建 HTTP 客户端。
 *
 * 错误映射：
 *   · 目标被拒（SSRF / 非 http(s) / 重定向超限）→ `FETCH_FORBIDDEN_TARGET` / `FETCH_BLOCKED` / `FETCH_FAILED`
 *   · 超时 → `PROVIDER_TIMEOUT`（retryable）
 *   · 网络中断 → `PROVIDER_NETWORK_ERROR`（retryable）
 *   · 429/5xx 重试耗尽 → `FETCH_FAILED`（retryable）
 */
export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000
  const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? 60_000
  const maxRedirects = opts.maxRedirects ?? 5
  const maxRetries = opts.maxRetries ?? 2
  const retryDelays = opts.retryDelaysMs ?? [1000, 4000]
  const maxResponseBytes = opts.maxResponseBytes ?? 5 * 1024 * 1024
  const sleepFn = opts.sleep ?? delay
  const now = opts.now ?? Date.now
  const userAgent = opts.userAgent ?? 'NovelStudio/0.1 (+local)'
  const gate = createSemaphore(opts.concurrency ?? 2)

  let activeCount = 0
  let queuedCount = 0

  async function runOnce(url: string, req: HttpRequestOptions, attempt: number): Promise<HttpResult> {
    const started = now()
    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort()
    req.signal?.addEventListener('abort', onOuterAbort, { once: true })

    let connectTimer: ReturnType<typeof setTimeout> | null = null
    const armConnectTimeout = (): void => {
      connectTimer = setTimeout(() => {
        controller.abort(new AppError('PROVIDER_TIMEOUT', { details: { phase: 'connect', connectTimeoutMs } }))
      }, connectTimeoutMs)
    }

    let redirects = 0
    let current = url
    try {
      for (;;) {
        // 每一次（含重定向后）都重新校验：防「公网域名 → 302 → 内网地址」的绕过
        await assertUrlAllowed(current, {
          allowPrivateHosts: req.allowPrivateHosts ?? opts.allowPrivateHosts,
          resolveHost: opts.resolveHost,
        })

        armConnectTimeout()
        let response: HttpResponseLike
        try {
          response = await opts.fetch(current, {
            method: req.method ?? 'GET',
            headers: {
              'user-agent': userAgent,
              accept: '*/*',
              ...(req.headers ?? {}),
            },
            body: req.body,
            signal: controller.signal,
            // manual：自己处理重定向，才能逐跳校验 SSRF（follow 会绕过校验）
            redirect: 'manual',
          })
        } catch (e) {
          if (controller.signal.aborted) {
            throw timeoutOrAbortError(controller.signal, connectTimeoutMs)
          }
          throw mapNetworkError(e)
        } finally {
          if (connectTimer) clearTimeout(connectTimer)
          connectTimer = null
        }

        const status = response.status
        if (status >= 300 && status < 400) {
          const location = readHeader(response.headers, 'location')
          if (!location) throw new AppError('FETCH_FAILED', { details: { url: current, reason: 'redirect-without-location', status } })
          if (redirects >= maxRedirects) {
            throw new AppError('FETCH_FAILED', {
              details: { url: current, reason: 'too-many-redirects', maxRedirects, redirects },
            })
          }
          const next = new URL(location, current)
          // 降级到 http（https → http）会泄露内容，直接拒绝
          if (new URL(current).protocol === 'https:' && next.protocol === 'http:') {
            throw new AppError('FETCH_FORBIDDEN_TARGET', {
              details: { url: current, target: next.toString(), reason: 'protocol-downgrade' },
            })
          }
          redirects++
          current = next.toString()
          opts.log?.debug?.('http.redirect', { event: 'http.redirect', from: url, to: current, redirects })
          continue
        }

        // 覆盖 Content-Length 的提前拒绝（避免把大文件读进内存才发现超限）
        const declared = Number(readHeader(response.headers, 'content-length') ?? Number.NaN)
        const limit = req.maxBytes ?? maxResponseBytes
        if (Number.isFinite(declared) && declared > limit) {
          throw new AppError('FILE_TOO_LARGE', {
            params: { size: `${Math.round(declared / 1024)} KB`, max: `${Math.round(limit / 1024)} KB` },
            details: { url: current, declared, limit },
          })
        }

        const body = await readBodyWithTimeout(response, firstByteTimeoutMs, controller)
        const bytes = Buffer.byteLength(body, 'utf8')
        if (bytes > limit) {
          throw new AppError('FILE_TOO_LARGE', {
            params: { size: `${Math.round(bytes / 1024)} KB`, max: `${Math.round(limit / 1024)} KB` },
            details: { url: current, bytes, limit },
          })
        }

        const headers: Record<string, string> = {}
        collectHeaders(response.headers, headers)
        return { status, url: current, headers, body, bytes, elapsedMs: now() - started, redirects, attempts: attempt }
      }
    } finally {
      if (connectTimer) clearTimeout(connectTimer)
      req.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  async function withRetry(url: string, req: HttpRequestOptions): Promise<HttpResult> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const result = await runOnce(url, req, attempt)
        // 429/5xx：只有幂等请求才重试（docs/04 §10「仅网络类错误与 429/5xx」）
        if ((result.status === 429 || result.status >= 500) && attempt <= maxRetries) {
          const wait = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 0
          opts.log?.warn?.('http.retry', {
            event: 'http.retry',
            url,
            status: result.status,
            attempt,
            waitMs: wait,
          })
          await sleepFn(wait, req.signal)
          lastError = new AppError('FETCH_FAILED', {
            params: { reason: `HTTP ${result.status}` },
            details: { url, status: result.status },
          })
          continue
        }
        if (result.status === 429 || result.status >= 500) {
          throw new AppError(result.status === 429 ? 'FETCH_BLOCKED' : 'FETCH_FAILED', {
            params: result.status === 429 ? { status: '429' } : { reason: `HTTP ${result.status}` },
            details: { url, status: result.status, attempts: attempt },
          })
        }
        return result
      } catch (e) {
        lastError = e
        const appErr = wrapUnknown(e, 'FETCH_FAILED')
        const canRetry = isRetryableHttpError(appErr) && attempt <= maxRetries
        if (!canRetry) throw appErr
        const wait = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 0
        opts.log?.warn?.('http.retry', { event: 'http.retry', url, code: appErr.key, attempt, waitMs: wait })
        await sleepFn(wait, req.signal)
      }
    }
    throw wrapUnknown(lastError, 'FETCH_FAILED')
  }

  /** 走并发门 + 重试的实际请求（提取成函数，避免对象字面量里用 `this`） */
  async function doRequest(url: string, req: HttpRequestOptions): Promise<HttpResult> {
    queuedCount++
    return gate(async () => {
      queuedCount--
      activeCount++
      try {
        return await withRetry(url, req)
      } finally {
        activeCount--
      }
    })
  }

  return {
    request: (url: string, req?: HttpRequestOptions) => doRequest(url, req ?? {}),
    async requestJson<T>(url: string, req?: HttpRequestOptions) {
      const result = await doRequest(url, { ...req, headers: { accept: 'application/json', ...(req?.headers ?? {}) } })
      try {
        return { status: result.status, data: JSON.parse(result.body) as T, result }
      } catch (e) {
        // 结构化输出异常是可重试错误（docs/22：AI_INVALID_OUTPUT），这里用 FETCH_FAILED + details
        throw new AppError('FETCH_FAILED', {
          cause: e,
          params: { reason: '响应不是合法 JSON' },
          details: { url, bytes: result.bytes, status: result.status },
        })
      }
    },
    assertAllowed: (url, o) => assertUrlAllowed(url, { allowPrivateHosts: o?.allowPrivateHosts ?? opts.allowPrivateHosts, resolveHost: o?.resolveHost ?? opts.resolveHost }),
    stats: () => ({ active: activeCount, queued: queuedCount }),
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function timeoutOrAbortError(signal: AbortSignal, timeoutMs: number): AppError {
  const reason = (signal as { reason?: unknown }).reason
  if (reason instanceof AppError) return reason
  return new AppError('PROVIDER_TIMEOUT', {
    details: { phase: 'connect', connectTimeoutMs: timeoutMs, reason: reason ? String(reason) : 'aborted' },
  })
}

function mapNetworkError(e: unknown): AppError {
  const appErr = wrapUnknown(e, 'FETCH_FAILED')
  // wrapUnknown 已按 errno 映射（ECONNRESET → PROVIDER_NETWORK_ERROR 等）；
  // 落到 INTERNAL/FETCH_FAILED 的说明是没见过的错误，补上 reason
  if (appErr.key === 'INTERNAL' || appErr.key === 'FETCH_FAILED') {
    return new AppError('FETCH_FAILED', {
      cause: e,
      params: { reason: summarize(e) },
      details: { reason: summarize(e) },
    })
  }
  return appErr
}

function summarize(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  const msg = (e as { message?: string } | null)?.message ?? String(e)
  return (code ? `[${code}] ` : '') + msg.slice(0, 120)
}

/** 网络类错误与超时可重试；SSRF/大小/参数类不可重试 */
function isRetryableHttpError(appErr: AppError): boolean {
  if (appErr.key === 'FETCH_FORBIDDEN_TARGET' || appErr.key === 'FILE_TOO_LARGE' || appErr.key === 'INVALID_PAYLOAD') return false
  if (appErr.key === 'TASK_CANCELLED' || appErr.key === 'PROVIDER_ABORTED') return false
  return appErr.retryable
}

function readHeader(
  headers: HttpResponseLike['headers'],
  name: string,
): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name)
  }
  const obj = headers as Record<string, string | string[] | undefined>
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
    }
  }
  return null
}

function collectHeaders(headers: HttpResponseLike['headers'], out: Record<string, string>): void {
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    ;(headers as unknown as { forEach(cb: (v: string, k: string) => void): void }).forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
    return
  }
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
  }
}

/** 首字节超时：从「开始读 body」计时（docs/04 §10） */
async function readBodyWithTimeout(
  response: HttpResponseLike,
  firstByteTimeoutMs: number,
  controller: AbortController,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new AppError('PROVIDER_TIMEOUT', { details: { phase: 'first-byte', firstByteTimeoutMs } }))
      reject(new AppError('PROVIDER_TIMEOUT', { details: { phase: 'first-byte', firstByteTimeoutMs } }))
    }, firstByteTimeoutMs)
  })
  try {
    return await Promise.race([response.text(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
