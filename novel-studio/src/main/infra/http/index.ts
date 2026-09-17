/**
 * 基础设施 · HTTP 出口
 * ============================================================================
 * 见 docs/04 §10。
 */

export {
  assertUrlAllowed,
  createHttpClient,
  createSemaphore,
  isForbiddenHostname,
  isForbiddenIpv4,
  isForbiddenIpv6,
  isForbiddenTargetSync,
  parseIpv4,
  stripIpv6Brackets,
  type FetchLike,
  type HttpClient,
  type HttpClientOptions,
  type HttpRequestInitLike,
  type HttpRequestOptions,
  type HttpResponseLike,
  type HttpResult,
  type SsrfCheckOptions,
} from './client.ts'
