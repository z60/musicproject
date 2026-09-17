/**
 * Novel Studio · 网页（URL）解析器（docs/10 §8.4）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §2 表格：URL → `web.parser.ts`（cheerio + undici）
 *   · §3：URL 单页上限 5 MB、总页数上限 50
 *   · §8.4 抓取流程 8 步：SSRF 检查 → 抓取 → 嗅探编码 → 提取标题 →
 *          contentSelectors 依次尝试 → 去 removeSelectors → <p>/<br> 转行 →
 *          可选跟随 nextPageSelectors（限同域、页数上限）→ 每页记录 URL 与抓取时间
 *   · §8.4 礼貌与合规：默认请求间隔 1.5 s（可配 0.5~5 s）带随机抖动；
 *          遵守 robots.txt（默认检查）；403/429 立即停止；不做登录墙/付费墙/验证码绕过
 *   · §10 错误码：FETCH_FAILED / FETCH_BLOCKED / FETCH_FORBIDDEN_TARGET / FETCH_TOO_MANY_PAGES
 *
 * 零第三方依赖：
 *   · HTTP 用运行时自带的 `fetch`（Node 18+ 内置 undici），无需 import。
 *   · HTML 解析走注入式 `HtmlExtractor`（生产环境用 cheerio）；
 *     未注入时用内置的 `regexHtmlExtractor`（纯正则近似实现，能力有限但真实可用，
 *     不是「返回空数组」的假实现）。
 */

import { Buffer } from 'node:buffer'

import { IMPORT_LIMITS } from '../../../../../shared/constants.ts'
import { AppError } from '../../../../../shared/errors.ts'
import {
  createDecoder,
  detectEncoding,
  normalizeNewlines,
  stripBom,
  type Decoder,
} from '../../../../../shared/text/encoding.ts'

// ============================================================================
// 站点规则（docs/10 §8.4）
// ============================================================================

/** 站点抓取规则（docs/10 §8.4 的 SiteRule） */
export interface SiteRule {
  id: string
  name: string
  /** 支持的域名，支持 `*.example.org` 通配 */
  matchHosts: string[]
  /** 正文选择器，依次尝试取第一个非空结果 */
  contentSelectors: string[]
  /** 需要移除的选择器（广告、页脚、script…） */
  removeSelectors: string[]
  /** 标题选择器（如 `h1.bookname`、`meta[property=og:title]`） */
  titleSelector: string
  /** 「下一章/下一页」链接选择器 */
  nextPageSelectors: string[]
  /** 站点固定编码（有的老站不声明 charset） */
  charsetHint?: string
}

/**
 * HTML 抽取器（注入式）。生产环境用 cheerio：
 * ```ts
 * import * as cheerio from 'cheerio'
 * const extractor: HtmlExtractor = {
 *   selectText: (html, sel) => cheerio.load(html)(sel).first().text().trim(),
 *   selectAttr: (html, sel, attr) => cheerio.load(html)(sel).first().attr(attr) ?? null,
 *   extractBodyText: (html, remove) => {
 *     const $ = cheerio.load(html)
 *     for (const sel of remove) $(sel).remove()
 *     return $('body').find('p, br, div, h1, h2, h3, h4, li').map((_, el) => $(el).text()).get().join('\n')
 *   },
 * }
 * ```
 */
export interface HtmlExtractor {
  /** 取第一个匹配元素的纯文本；无匹配返回 '' */
  selectText(html: string, selector: string): string
  /** 取第一个匹配元素的属性；无匹配返回 null */
  selectAttr(html: string, selector: string, attr: string): string | null
  /** 移除 removeSelectors 后取正文文本（按 <p>/<br> 转行） */
  extractBodyText(html: string, removeSelectors: string[]): string
}

// ============================================================================
// 纯函数：HTML → 文本
// ============================================================================

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…', middot: '·',
}

/** 解码 HTML 实体（数字 + 常见命名） */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (/^#x/i.test(body)) {
      const cp = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * 把选择器（简化语法：`tag` / `.class` / `#id` / `tag.class`）编译成删除用正则。
 *
 * 说明：正则删元素无法正确处理同名标签嵌套（`<div>…<div>…</div>…</div>`），
 * 因此这是**注入 cheerio 前的退化实现**；生产路径请注入 cheerio。
 * @returns 正则；无法识别的选择器返回 null（会被跳过并记 warning）
 */
export function compileRemoveSelector(selector: string): RegExp | null {
  const sel = selector.trim()
  if (sel.length === 0) return null
  const tag = /^[a-zA-Z][\w-]*/.exec(sel)?.[0]
  const cls = /\.([\w-]+)/.exec(sel)?.[1]
  const id = /#([\w-]+)/.exec(sel)?.[1]
  if (!tag && !cls && !id) return null
  const tagPart = tag ?? '[a-zA-Z][\\w-]*'
  const attrs: string[] = []
  if (cls) attrs.push(`class="[^"]*\\b${cls}\\b[^"]*"`)
  if (id) attrs.push(`id="${id}"`)
  const attrPart = attrs.length > 0 ? `(?=[^>]*${attrs.join('|')})` : ''
  try {
    return new RegExp(`<(${tagPart})\\b[^>]*${attrPart}[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi')
  } catch {
    return null
  }
}

export interface HtmlToTextOptions {
  removeSelectors?: string[]
  /** 是否把 <br> 当换行（默认 true） */
  breakOnBr?: boolean
}

/**
 * HTML → 纯文本（无依赖实现，docs/10 §8.4 第 5~6 步）。
 *
 * 处理：去注释/script/style → 去 removeSelectors → 块级标签与 <br> 转换行 →
 * 去剩余标签 → 解实体 → 逐行 trim → 压缩多余空行。
 * @returns 纯文本（换行已归一）
 */
export function htmlToText(html: string, options?: HtmlToTextOptions): string {
  const breakOnBr = options?.breakOnBr ?? true
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
  for (const selector of options?.removeSelectors ?? []) {
    const re = compileRemoveSelector(selector)
    if (re) body = body.replace(re, '')
  }
  body = body.replace(/<(?:p|div|section|article|h[1-6]|li|tr|blockquote)\b[^>]*>/gi, '\n')
  if (breakOnBr) body = body.replace(/<br\s*\/?>/gi, '\n')
  body = body.replace(/<[^>]*>/g, '')
  const text = decodeEntities(body)
  return normalizeNewlines(text)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .filter((l, i, arr) => !(l.length === 0 && arr[i - 1] === ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 内置的退化抽取器（未注入 cheerio 时使用）。
 * 只有 `selectText`/`selectAttr` 是正则近似：能处理绝大多数「取第一个匹配元素」的场景，
 * 复杂选择器（`:nth-child`、属性组合等）不支持 —— 会返回空串而不是抛错。
 */
export function createRegexHtmlExtractor(): HtmlExtractor {
  return {
    selectText(html: string, selector: string): string {
      const el = firstElement(html, selector)
      return el ? htmlToText(el) : ''
    },
    selectAttr(html: string, selector: string, attr: string): string | null {
      const el = firstElement(html, selector)
      if (!el) return null
      const m = new RegExp(`\\b${escapeRegExp(attr)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(el)
      if (!m) return null
      return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
    },
    extractBodyText(html: string, removeSelectors: string[]): string {
      return htmlToText(html, { removeSelectors })
    },
  }
}

/** 内置退化抽取器实例（等价于 createRegexHtmlExtractor()） */
export const regexHtmlExtractor: HtmlExtractor = createRegexHtmlExtractor()

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 取第一个匹配元素的外层 HTML（简化选择器：tag / .class / #id） */
function firstElement(html: string, selector: string): string | null {
  const sel = selector.trim()
  const tag = /^[a-zA-Z][\w-]*/.exec(sel)?.[0] ?? '[a-zA-Z][\\w-]*'
  const cls = /\.([\w-]+)/.exec(sel)?.[1]
  const id = /#([\w-]+)/.exec(sel)?.[1]
  const attrs: string[] = []
  if (cls) attrs.push(`class="[^"]*\\b${cls}\\b[^"]*"`)
  if (id) attrs.push(`id="${id}"`)
  const attrPart = attrs.length > 0 ? `(?=[^>]*${attrs.join('|')})` : ''
  let re: RegExp
  try {
    re = new RegExp(`<(${tag})\\b[^>]*${attrPart}[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i')
  } catch {
    return null
  }
  const m = re.exec(html)
  return m ? m[0] : null
}

// ============================================================================
// 站点规则匹配
// ============================================================================

export interface ExtractHtmlInput {
  html: string
  /** 命中的站点规则（无则只用通用规则） */
  rule?: SiteRule | null
  /** HTML 抽取器（生产环境用 cheerio） */
  extractor?: HtmlExtractor
}

export interface ExtractHtmlResult {
  /** 标题（规则选择器 → h1 → og:title → <title>） */
  title: string | null
  /** 正文纯文本 */
  body: string
  /** 命中的正文选择器（null = 退化为整页提取） */
  usedSelector: string | null
  warnings: string[]
}

/**
 * 从一个 HTML 文档里抽取标题与正文（docs/10 §8.4 第 3~6 步）。
 *
 * 供两处复用：URL 抓取（parseWeb 每页调用）与本地 `.html` 文件导入
 * （文件没有 URL 语义，不能走 SSRF 与 robots 流程）。
 *
 * @param input.html 已解码的 HTML
 * @param input.rule 站点规则（可空）
 * @param input.extractor 抽取器（可空 → 用内置正则退化实现）
 * @returns 标题、正文、命中的选择器与警告
 */
export function extractFromHtml(input: ExtractHtmlInput): ExtractHtmlResult {
  const extractor = input.extractor ?? regexHtmlExtractor
  const warnings: string[] = []
  const rule = input.rule ?? null
  const html = input.html

  // 标题
  let title: string | null = null
  if (rule?.titleSelector) {
    const byText = extractor.selectText(html, rule.titleSelector).trim()
    const byAttr = extractor.selectAttr(html, rule.titleSelector, 'content')
    title = byText || (byAttr ? byAttr.trim() : '') || null
  }
  if (!title) {
    const h1 = extractor.selectText(html, 'h1').trim()
    const og = extractor.selectAttr(html, 'meta[property="og:title"]', 'content')
    const docTitle = extractor.selectText(html, 'title').trim()
    title = (h1 || og || docTitle || '').trim() || null
  }

  // 正文：contentSelectors 依次尝试，全部失败退化为整页提取（减去 removeSelectors）
  const removeSelectors = rule?.removeSelectors ?? ['script', 'style', 'noscript']
  let body = ''
  let usedSelector: string | null = null
  for (const selector of rule?.contentSelectors ?? []) {
    const candidate = extractor.selectText(html, selector).trim()
    if (candidate.length > 0) {
      body = candidate
      usedSelector = selector
      break
    }
  }
  if (!body) {
    body = extractor.extractBodyText(html, removeSelectors).trim()
    if (rule && rule.contentSelectors.length > 0) {
      warnings.push(`未命中正文选择器（${rule.contentSelectors.join(' / ')}），已退化为整页提取`)
    }
  }
  return { title, body: normalizeNewlines(body), usedSelector, warnings }
}

/**
 * 主机名匹配（支持 `*.example.org` 通配）
 * @param host 目标主机名（小写，不含端口）
 * @param pattern 规则里的主机模式
 */
export function matchHost(host: string, pattern: string): boolean {
  const h = host.toLowerCase()
  const p = pattern.toLowerCase().trim()
  if (p === h) return true
  if (p.startsWith('*.')) {
    const suffix = p.slice(2)
    return h === suffix || h.endsWith(`.${suffix}`)
  }
  return false
}

/**
 * 找到匹配该主机的站点规则（docs/10 §8.4 第 3~4 步）
 * @param url 目标 URL（字符串或 URL）
 * @param rules 规则表（内置 + 用户自定义）
 * @returns 命中的规则；没有匹配返回 null（调用方退化为整页 body 提取）
 */
export function resolveSiteRule(url: string | URL, rules: readonly SiteRule[]): SiteRule | null {
  const host = (typeof url === 'string' ? new URL(url) : url).hostname.toLowerCase()
  for (const rule of rules) {
    if (rule.matchHosts.some((pattern) => matchHost(host, pattern))) return rule
  }
  return null
}

// ============================================================================
// SSRF 防护（docs/10 §8.4 第 1 步、§10 FETCH_FORBIDDEN_TARGET）
// ============================================================================

/** 解析点分十进制 IPv4；非法返回 null */
export function parseIPv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number.parseInt(part, 10)
    if (n < 0 || n > 255) return null
    out.push(n)
  }
  return out
}

/** 私有/保留 IPv4 网段（docs/10 §8.4：拒内网/环回/链路本地） */
export function isPrivateIPv4(ip: number[]): boolean {
  const [a = 0, b = 0] = ip
  if (a === 0) return true // 0.0.0.0/8
  if (a === 127) return true // 环回
  if (a === 10) return true // 私有
  if (a === 172 && b >= 16 && b <= 31) return true // 私有
  if (a === 192 && b === 168) return true // 私有
  if (a === 169 && b === 254) return true // 链路本地（云元数据 169.254.169.254）
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 与 192.0.2.0/24（文档用）
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a >= 224) return true // 组播与保留
  return false
}

/** 私有/保留 IPv6（未压缩写法已归一为小写） */
export function isPrivateIPv6(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (host.startsWith('fe80')) return true // 链路本地 fe80::/10
  if (host.startsWith('fec0')) return true // 站点本地（已废弃）
  if (/^f[cd]/.test(host)) return true // 唯一本地 fc00::/7
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (mapped?.[1]) {
    const v4 = parseIPv4(mapped[1])
    if (v4 && isPrivateIPv4(v4)) return true
  }
  return false
}

/** 内网/保留域名 */
export function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true
  return false
}

export interface UrlSafetyResult {
  safe: boolean
  reason?: string
  /** 归一化后的 URL（安全时给出） */
  url?: URL
}

/**
 * URL 安全校验（SSRF 防护，docs/10 §8.4 第 1 步）。
 *
 * 拒绝：非 http(s)（file://、ftp://、data:…）、带凭据的 URL、
 * 环回/私有/链路本地/CGNAT/保留地址（127/8、10/8、172.16/12、192.168/16、
 * 169.254/16、::1、fc00::/7、fe80::/10、::ffff:内网 v4…）、
 * localhost / *.local / *.internal / *.home.arpa。
 *
 * @param rawUrl 用户输入的地址
 * @returns safe 与（不安全时的）原因；安全时附带归一化 URL
 */
export function checkUrlSafety(rawUrl: string): UrlSafetyResult {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { safe: false, reason: 'URL 格式无法解析' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: `只允许 http/https，收到 ${url.protocol}` }
  }
  if (url.username || url.password) {
    return { safe: false, reason: '不允许带用户名密码的 URL' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isPrivateHostname(host)) return { safe: false, reason: `内网/本机主机名 ${host}` }
  const v4 = parseIPv4(host)
  if (v4) {
    if (isPrivateIPv4(v4)) return { safe: false, reason: `私有/保留 IPv4 ${host}` }
    return { safe: true, url }
  }
  if (host.includes(':')) {
    if (isPrivateIPv6(host)) return { safe: false, reason: `私有/保留 IPv6 ${host}` }
    return { safe: true, url }
  }
  return { safe: true, url }
}

/**
 * 校验并在不安全时抛业务异常（docs/10 §10 FETCH_FORBIDDEN_TARGET）
 * @throws AppError `FETCH_FORBIDDEN_TARGET`
 * @throws AppError `FETCH_FAILED`（URL 本身无法解析）
 */
export function assertSafeUrl(rawUrl: string): URL {
  const result = checkUrlSafety(rawUrl)
  if (result.safe && result.url) return result.url
  if (result.reason === 'URL 格式无法解析') {
    throw new AppError('FETCH_FAILED', { params: { reason: result.reason } })
  }
  throw new AppError('FETCH_FORBIDDEN_TARGET', { details: { url: rawUrl, reason: result.reason } })
}

// ============================================================================
// robots.txt（docs/10 §8.4「遵守 robots.txt（默认检查）」）
// ============================================================================

export interface RobotsRules {
  /** 命中的 User-agent 组 */
  matchedAgent: string | null
  allow: string[]
  disallow: string[]
}

/**
 * 解析 robots.txt（简化实现：支持 `User-agent` / `Allow` / `Disallow`，
 * 路径支持 `*` 通配与 `$` 结尾锚定；不支持 Sitemap、Crawl-delay 等扩展）。
 * @param text robots.txt 内容
 * @param userAgent 我们的 UA 标记（用于挑选最匹配的组）
 */
export function parseRobotsTxt(text: string, userAgent = 'novel-studio'): RobotsRules {
  const lines = normalizeNewlines(text).split('\n')
  interface Group { agents: string[]; allow: string[]; disallow: string[] }
  const groups: Group[] = []
  let current: Group | null = null
  let lastWasAgent = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line.length === 0) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    if (!current) continue
    lastWasAgent = false
    if (key === 'allow') current.allow.push(value)
    else if (key === 'disallow') current.disallow.push(value)
  }
  const ua = userAgent.toLowerCase()
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)))
  const wildcard = groups.find((g) => g.agents.includes('*'))
  const picked = specific ?? wildcard
  if (!picked) return { matchedAgent: null, allow: [], disallow: [] }
  return {
    matchedAgent: specific ? picked.agents.join(',') : '*',
    allow: picked.allow,
    disallow: picked.disallow.filter((d) => d.length > 0),
  }
}

function robotsPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.split('*').map(escapeRegExp).join('[\\s\\S]*')
  const anchored = escaped.endsWith('\\$') ? escaped.slice(0, -2) + '$' : escaped + '[\\s\\S]*'
  return new RegExp(`^${anchored}`)
}

/**
 * 判断路径是否被 robots.txt 允许（最长匹配优先，同长度时 Allow 优先，与主流实现一致）。
 * @param rules parseRobotsTxt 的结果
 * @param path 请求路径（含 query）
 */
export function isAllowedByRobots(rules: RobotsRules, path: string): boolean {
  const target = path.length > 0 ? path : '/'
  let bestLen = -1
  let bestAllow = true
  const consider = (patterns: string[], allow: boolean): void => {
    for (const pattern of patterns) {
      if (!robotsPatternToRegex(pattern).test(target)) continue
      const len = pattern.replace(/[*$]/g, '').length
      if (len > bestLen || (len === bestLen && allow)) {
        bestLen = len
        bestAllow = allow
      }
    }
  }
  consider(rules.allow, true)
  consider(rules.disallow, false)
  return bestLen < 0 ? true : bestAllow
}

// ============================================================================
// HTTP 抓取
// ============================================================================

/** 运行时 fetch 的最小接口（Node 18+ 自带 fetch，无需第三方库） */
export interface FetchResponseLike {
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; redirect?: 'manual' | 'follow'; signal?: AbortSignal },
) => Promise<FetchResponseLike>

/** 抓取时使用的 UA（docs/10 §8.4：使用真实 UA 并说明用途） */
export const DEFAULT_USER_AGENT =
  'NovelStudio/0.1 (audiobook production tool; contact: local user) Mozilla/5.0 (compatible)'

export interface FetchedPage {
  url: string
  status: number
  /** 最终 URL（跟随重定向后） */
  finalUrl: string
  bytes: number
  fetchedAt: number
  body: Buffer
  contentType: string | null
}

export interface WebParseInput {
  url: string
  rules?: readonly SiteRule[]
  extractor?: HtmlExtractor
  fetchImpl?: FetchLike
  /** 请求间隔（毫秒，默认 IMPORT_LIMITS.fetchDelayMs = 1500；docs/10 §8.4 建议 0.5~5 s） */
  delayMs?: number
  /** 页数上限（默认 IMPORT_LIMITS.maxUrlPages = 50） */
  maxPages?: number
  /** 单页字节上限（默认 IMPORT_LIMITS.maxUrlPageBytes = 5 MB） */
  maxPageBytes?: number
  /** 重定向上限（默认 IMPORT_LIMITS.maxRedirects = 5） */
  maxRedirects?: number
  /** 是否跟随「下一章」（默认 true） */
  followNextPage?: boolean
  /** 是否检查 robots.txt（默认 true；用户强制忽略需在 UI 勾选确认） */
  respectRobots?: boolean
  /** 注入型解码器（iconv-lite） */
  decoders?: Record<string, Decoder>
  signal?: AbortSignal
  onPage?: (info: { page: number; url: string; chars: number }) => void
  /** 注入 sleep / random / now（测试用） */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

export interface WebPageRecord {
  url: string
  fetchedAt: number
  title: string | null
  chars: number
  status: number
}

export interface WebParseResult {
  text: string
  /** 首页标题（书名） */
  title: string | null
  encoding: string
  ruleId: string | null
  pages: WebPageRecord[]
  warnings: string[]
}

// ============================================================================
// 主入口
// ============================================================================

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function throwIfAborted(signal?: AbortSignal, stage = 'parseWeb'): void {
  if (signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage } })
}

/** 抓取一个 URL，手动跟随重定向（每一跳都做 SSRF 校验，docs/10 §8.4） */
async function fetchWithRedirects(
  startUrl: string,
  input: WebParseInput,
  maxRedirects: number,
  maxPageBytes: number,
): Promise<FetchedPage> {
  const fetchImpl: FetchLike | undefined =
    input.fetchImpl ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as FetchLike) : undefined)
  if (!fetchImpl) {
    throw new AppError('FETCH_FAILED', {
      params: { reason: '当前运行环境没有可用的 fetch 实现' },
      details: { injection: '生产环境用 Node 内置 fetch 或 undici：{ fetchImpl: (url, init) => undici.request(url, init) }' },
    })
  }
  const now = input.now ?? Date.now
  let current = assertSafeUrl(startUrl)
  let redirects = 0
  for (;;) {
    throwIfAborted(input.signal, 'fetch')
    const response = await fetchImpl(current.toString(), {
      method: 'GET',
      headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: input.signal,
    })
    // 403 / 429 → 立即停止（docs/10 §8.4 与 §10 FETCH_BLOCKED）
    if (response.status === 403 || response.status === 429) {
      throw new AppError('FETCH_BLOCKED', { params: { status: String(response.status) }, details: { url: current.toString() } })
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new AppError('FETCH_FAILED', { params: { reason: `HTTP ${response.status} 但没有 Location` } })
      }
      redirects++
      if (redirects > maxRedirects) {
        throw new AppError('FETCH_FAILED', {
          params: { reason: `重定向超过 ${maxRedirects} 次` },
          details: { url: current.toString() },
        })
      }
      const next = new URL(location, current)
      assertSafeUrl(next.toString())
      current = next
      continue
    }
    if (response.status >= 400) {
      throw new AppError('FETCH_FAILED', {
        params: { reason: `HTTP ${response.status}` },
        details: { url: current.toString() },
      })
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > maxPageBytes) {
      throw new AppError('FETCH_FAILED', {
        params: { reason: `单页体积 ${(buf.length / 1024 / 1024).toFixed(1)} MB 超过上限 ${(maxPageBytes / 1024 / 1024).toFixed(0)} MB` },
        details: { url: current.toString() },
      })
    }
    return {
      url: startUrl,
      finalUrl: current.toString(),
      status: response.status,
      bytes: buf.length,
      fetchedAt: now(),
      body: buf,
      contentType: response.headers.get('content-type'),
    }
  }
}

/** 从 Content-Type 或站点规则里取编码提示 */
function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)
  return m?.[1] ?? null
}

/** 解码页面字节：优先站点规则/Content-Type 的 charset，否则走编码嗅探（docs/10 §8.4 第 2 步） */
function decodePage(page: FetchedPage, hint: string | null, decoders?: Record<string, Decoder>): { html: string; encoding: string } {
  if (hint) {
    const decoder = createDecoder(hint, decoders)
    if (decoder) {
      const text = decoder(page.body)
      if (text !== null) return { html: text, encoding: hint }
    }
  }
  const detection = detectEncoding(page.body, { decoders })
  const decoder = createDecoder(detection.encoding, decoders)
  if (!decoder) {
    throw new AppError('ENCODING_DECODE_FAILED', { details: { encoding: detection.encoding, url: page.finalUrl } })
  }
  const text = decoder(page.body)
  if (text === null) {
    throw new AppError('ENCODING_DECODE_FAILED', { details: { encoding: detection.encoding, url: page.finalUrl } })
  }
  return { html: text, encoding: detection.encoding }
}

/**
 * 抓取并解析网页（docs/10 §8.4）。
 *
 * 流程：SSRF 检查 → robots.txt（默认）→ 抓取首页 → 嗅探编码 → 提取标题 →
 * 按站点规则依次尝试 contentSelectors → 去 removeSelectors → 取正文 →
 * 可选跟随「下一章」（限同域、页数上限）→ 汇总文本与逐页记录。
 *
 * @param input.url 起始 URL（章节页或目录页）
 * @param input.rules 站点规则表；命中则按其选择器抽取
 * @param input.extractor HTML 抽取器（生产环境用 cheerio）；未注入时用内置正则退化实现
 * @param input.fetchImpl HTTP 实现（默认运行时 fetch）
 * @returns 文本、标题、编码、命中的规则、逐页记录、警告
 * @throws AppError `FETCH_FORBIDDEN_TARGET`（SSRF 拦截）
 * @throws AppError `FETCH_BLOCKED`（403/429 或 robots.txt 禁止）
 * @throws AppError `FETCH_FAILED`（超时/DNS/5xx/体积超限/URL 解析失败）
 * @throws AppError `FETCH_TOO_MANY_PAGES`（超过页数上限）
 * @throws AppError `ENCODING_DECODE_FAILED`（页面编码无法解码）
 * @throws AppError `TASK_CANCELLED`（signal 已中止）
 */
export async function parseWeb(input: WebParseInput): Promise<WebParseResult> {
  const warnings: string[] = []
  const extractor = input.extractor ?? regexHtmlExtractor
  if (!input.extractor) {
    warnings.push('未注入 cheerio 抽取器，当前使用内置的正则退化实现（复杂选择器可能失效）')
  }
  const startUrl = assertSafeUrl(input.url)
  const maxPages = input.maxPages ?? IMPORT_LIMITS.maxUrlPages
  const maxPageBytes = input.maxPageBytes ?? IMPORT_LIMITS.maxUrlPageBytes
  const maxRedirects = input.maxRedirects ?? IMPORT_LIMITS.maxRedirects
  const delayMs = clamp(input.delayMs ?? IMPORT_LIMITS.fetchDelayMs, 0, 10_000)
  const sleep = input.sleep ?? defaultSleep
  const random = input.random ?? Math.random
  const rule = input.rules ? resolveSiteRule(startUrl, input.rules) : null
  const sameHost = startUrl.hostname

  // robots.txt（docs/10 §8.4 礼貌与合规）
  if (input.respectRobots ?? true) {
    const robotsUrl = new URL('/robots.txt', startUrl).toString()
    try {
      assertSafeUrl(robotsUrl)
      const robotsPage = await fetchWithRedirects(robotsUrl, input, maxRedirects, maxPageBytes)
      const robots = parseRobotsTxt(robotsPage.body.toString('utf8'))
      const path = `${startUrl.pathname}${startUrl.search}`
      if (!isAllowedByRobots(robots, path)) {
        throw new AppError('FETCH_BLOCKED', {
          params: { status: 'robots.txt 禁止抓取' },
          details: { url: startUrl.toString(), matchedAgent: robots.matchedAgent },
        })
      }
    } catch (e) {
      if (e instanceof AppError && (e.key === 'FETCH_BLOCKED' || e.key === 'TASK_CANCELLED')) throw e
      // robots.txt 取不到（404/网络问题）按「允许」处理，仅记一条日志级警告
      warnings.push('未能读取 robots.txt，按允许抓取处理')
    }
  }

  const pages: WebPageRecord[] = []
  const texts: string[] = []
  let nextUrl: string | null = startUrl.toString()
  let firstTitle: string | null = null
  let encoding = 'UTF-8'
  let pageIndex = 0

  while (nextUrl) {
    throwIfAborted(input.signal)
    if (pageIndex >= maxPages) {
      throw new AppError('FETCH_TOO_MANY_PAGES', {
        params: { count: pageIndex, max: maxPages },
        details: { nextUrl },
      })
    }
    if (pageIndex > 0) {
      // 礼貌间隔：默认 1.5 s，带 ±20% 抖动（docs/10 §8.4）
      const jitter = 1 + (random() - 0.5) * 0.4
      await sleep(Math.round(delayMs * jitter))
    }
    const page = await fetchWithRedirects(nextUrl, input, maxRedirects, maxPageBytes)
    const hint = rule?.charsetHint ?? charsetFromContentType(page.contentType)
    const decoded = decodePage(page, hint, input.decoders)
    encoding = decoded.encoding
    const html = stripBom(decoded.html)

    // 标题与正文（与本地 HTML 文件导入共用同一套抽取逻辑）
    const extracted = extractFromHtml({ html, rule, extractor: input.extractor })
    for (const w of extracted.warnings) warnings.push(`第 ${pageIndex + 1} 页：${w}`)
    const title = extracted.title
    if (firstTitle === null) firstTitle = title
    const normalizedBody = extracted.body

    texts.push(normalizedBody)
    pages.push({
      url: page.finalUrl,
      fetchedAt: page.fetchedAt,
      title,
      chars: normalizedBody.length,
      status: page.status,
    })
    input.onPage?.({ page: pageIndex + 1, url: page.finalUrl, chars: normalizedBody.length })
    pageIndex++

    // 跟随「下一章」（docs/10 §8.4 第 7 步：限制同域）
    if (input.followNextPage ?? true) {
      nextUrl = null
      for (const selector of rule?.nextPageSelectors ?? []) {
        const href = extractor.selectAttr(html, selector, 'href')
        if (!href) continue
        const resolved = new URL(href, page.finalUrl)
        if (resolved.hostname !== sameHost) {
          warnings.push(`「下一章」链接指向其它域名（${resolved.hostname}），已停止跟随`)
          break
        }
        // 同一页面自指的死循环保护
        if (pages.some((p) => p.url === resolved.toString())) {
          warnings.push('「下一章」链接回到已抓取过的页面，已停止跟随')
          break
        }
        const safety = checkUrlSafety(resolved.toString())
        if (!safety.safe) {
          warnings.push(`「下一章」链接不安全（${safety.reason}），已停止跟随`)
          break
        }
        nextUrl = resolved.toString()
        break
      }
    }
  }

  if (pages.length === 0) {
    throw new AppError('FETCH_FAILED', { params: { reason: '没有抓取到任何内容' } })
  }
  const text = texts.filter((t) => t.length > 0).join('\n\n')
  if (text.trim().length === 0) {
    throw new AppError('FETCH_FAILED', {
      params: { reason: '页面正文为空（可能需要登录或由脚本渲染）' },
      details: { url: startUrl.toString() },
    })
  }

  return { text, title: firstTitle, encoding, ruleId: rule?.id ?? null, pages, warnings }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
