/**
 * Novel Studio · DOCX 解析器（docs/10 §8.2）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §2 表格：DOCX → `docx.parser.ts`（mammoth）
 *   · §3 第 ④ 步：mammoth → HTML/段落数组 → 保留标题层级
 *   · §8.2 实现要点：
 *       - 用 `h1/h2/h3` 与 `Heading 1/2/3` 样式作为**强章节边界**（优先于正则）
 *       - 每个 `<p>` → 一行
 *       - 图片：忽略内容但记录数量，提示「文档含 N 张图片，已忽略」
 *       - 表格：按行用 ` | ` 连接（或跳过并提示）
 *   · §10 错误码：DOCX_CORRUPT
 *
 * 零第三方依赖：`.docx` 本质是 ZIP，解压必须靠库。生产环境用 `mammoth`：
 *
 * ```ts
 * import mammoth from 'mammoth'
 * const converter: DocxConverter = {
 *   convertToHtml: ({ buffer }) => mammoth.convertToHtml({ buffer }),
 * }
 * const result = await parseDocx({ buffer, converter })
 * ```
 *
 * 未注入转换器时抛 `DOCX_CORRUPT`（按要求），绝不返回空结果假装成功。
 * HTML → 结构化文本这一段是纯函数（`htmlToStructuredText`），可独立测试。
 */

import { AppError } from '../../../../../shared/errors.ts'
import { normalizeNewlines, stripBom } from '../../../../../shared/text/encoding.ts'

// ============================================================================
// 类型
// ============================================================================

/**
 * DOCX → HTML 转换器（注入式）。生产环境用 mammoth：
 * `mammoth.convertToHtml({ buffer })` 的返回值与本接口一致（`{ value, messages }`）。
 */
export interface DocxConverter {
  convertToHtml(input: { buffer: Buffer }): Promise<{ value: string; messages?: unknown[] }>
}

export interface DocxParseInput {
  buffer: Buffer
  /** 未注入时抛 DOCX_CORRUPT（并说明需要注入 mammoth） */
  converter?: DocxConverter
  signal?: AbortSignal
}

/** 强章节边界（来自 h1~h6 标题） */
export interface DocxHeading {
  level: number
  title: string
  /** 在返回文本中的偏移 */
  offset: number
}

export interface DocxStructuredResult {
  /** 结构化纯文本（标题行独占一行，前后留空行） */
  text: string
  headings: DocxHeading[]
  paragraphCount: number
  imageCount: number
  tableCount: number
  listItemCount: number
  warnings: string[]
}

export interface DocxParseResult extends DocxStructuredResult {
  /** 转换器返回的原始消息（mammoth 的 warnings 等，只进日志） */
  converterMessages: unknown[]
}

// ============================================================================
// HTML 实体
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
}

/** 解码 HTML 实体（数字实体 + 常见命名实体） */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

// ============================================================================
// HTML → 结构化文本（纯函数，可独立测试）
// ============================================================================

/** 去掉标签，仅留文本 */
function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''))
}

/** 归一化空白（HTML 里的换行/缩进不是排版意图） */
function normalizeInline(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/**
 * 把 mammoth 产出的 HTML 转成结构化纯文本（docs/10 §8.2）。
 *
 * 规则：
 *   · `<h1>`~`<h6>` → 独占一行，**前后各留一个空行**（这样分章规则里的
 *     `requireBlankAround` 才能生效，见 docs/10 §6.2 的 cn-juan 规则）
 *   · `<p>` → 一行；`<br>` → 段内换行
 *   · `<li>` → 一行（保留项目符号前缀，避免丢失结构感）
 *   · `<tr>` → 单元格用 ` | ` 连接成一行（docs/10 §8.2「表格转文本」）
 *   · `<img>` → 计数并忽略内容
 *   · `<script>` / `<style>` → 整段丢弃
 *
 * @param html mammoth 产出的 HTML
 * @returns 结构化文本与统计（标题、段落、图片、表格、列表项）
 */
export function htmlToStructuredText(html: string): DocxStructuredResult {
  const warnings: string[] = []
  let imageCount = 0
  let tableCount = 0
  let listItemCount = 0
  let paragraphCount = 0

  // 先摘掉脚本与样式（内容不是正文）
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 图片计数后移除
  body = body.replace(/<img\b[^>]*>/gi, () => {
    imageCount++
    return ''
  })
  tableCount = (body.match(/<table\b/gi) ?? []).length

  // 统一换行标签：<br> → 特殊标记（段内换行）
  body = body.replace(/<br\s*\/?>/gi, '\u0000')

  const blocks: Array<{ kind: 'heading' | 'text'; level?: number; text: string }> = []

  // 逐个块级标签抽取内容（mammoth 产出的 HTML 结构规整，正则足够且无依赖）
  const blockRe = /<(h[1-6]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  let consumed = false
  while ((m = blockRe.exec(body)) !== null) {
    consumed = true
    const tag = m[1]!.toLowerCase()
    const inner = m[2]!
    if (tag.startsWith('h')) {
      const level = Number.parseInt(tag.slice(1), 10)
      const title = normalizeInline(stripTags(inner))
      if (title.length > 0) blocks.push({ kind: 'heading', level, text: title })
      continue
    }
    if (tag === 'li') {
      listItemCount++
      const text = normalizeInline(stripTags(inner))
      if (text.length > 0) blocks.push({ kind: 'text', text: `- ${text}` })
      continue
    }
    if (tag === 'tr') {
      const cells = [...inner.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((c) => normalizeInline(stripTags(c[1]!)))
        .filter((c) => c.length > 0)
      if (cells.length > 0) blocks.push({ kind: 'text', text: cells.join(' | ') })
      continue
    }
    // <p>
    paragraphCount++
    const parts = inner.split('\u0000').map((p) => normalizeInline(stripTags(p)))
    const text = parts.filter((p) => p.length > 0).join('\n')
    if (text.length > 0) blocks.push({ kind: 'text', text })
  }

  // 兜底：没有任何块级标签时，把整段文本当正文（避免「一片空白」）
  if (!consumed) {
    const text = normalizeInline(stripTags(body.replace(/\u0000/g, '\n')))
    if (text.length > 0) {
      blocks.push({ kind: 'text', text })
      paragraphCount = Math.max(paragraphCount, 1)
      warnings.push('未在文档中找到标准的段落/标题结构，已按整段文本提取')
    }
  }

  // 组装：标题前后留空行
  const lines: string[] = []
  const headings: DocxHeading[] = []
  let offset = 0
  const pushLine = (line: string): void => {
    lines.push(line)
    offset += line.length + 1 // +1 = 换行符
  }
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (lines.length > 0 && lines[lines.length - 1] !== '') pushLine('')
      headings.push({ level: block.level ?? 1, title: block.text, offset })
      pushLine(block.text)
      pushLine('')
    } else {
      pushLine(block.text)
    }
  }

  const text = normalizeNewlines(stripBom(lines.join('\n'))).replace(/\n{3,}/g, '\n\n')
  // 上面的空行归一会让 offset 轻微漂移，按标题文本重算，保证偏移与最终文本一致
  const recomputed: DocxHeading[] = headings.map((h) => {
    const idx = text.indexOf(h.title, Math.max(0, h.offset - 64))
    return { ...h, offset: idx >= 0 ? idx : h.offset }
  })

  if (imageCount > 0) warnings.push(`文档含 ${imageCount} 张图片，已忽略`)
  if (tableCount > 0) warnings.push(`文档含 ${tableCount} 个表格，已按行转换为文本（单元格用 " | " 连接）`)

  return {
    text,
    headings: recomputed,
    paragraphCount,
    imageCount,
    tableCount,
    listItemCount,
    warnings,
  }
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 从 HTML 抽取**标题样式边界**（docs/10 §8.2 的 `Heading 1/2/3`）。
 * mammoth 会把 Word 的标题样式转成 `h1/h2/h3`，因此这里读的就是 h 标签；
 * 保留该函数是为了在只拿到 HTML 片段时也能单独调用。
 * @param html 文档 HTML
 * @returns 标题数组（level + title）
 */
export function extractHeadings(html: string): Array<{ level: number; title: string }> {
  const out: Array<{ level: number; title: string }> = []
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  for (;;) {
    const m = re.exec(html)
    if (!m) break
    const title = normalizeInline(stripTags(m[2]!))
    if (title.length > 0) out.push({ level: Number.parseInt(m[1]!, 10), title })
  }
  return out
}

/**
 * 解析 DOCX（docs/10 §8.2）。
 *
 * 需要注入 `DocxConverter`（生产环境用 mammoth）：`.docx` 是 ZIP 容器，
 * 无第三方库无法真正解压，本模块**不会**用「返回空数组」之类的假实现糊过去。
 *
 * @param input.buffer DOCX 文件字节
 * @param input.converter mammoth 适配器；未注入时抛 `DOCX_CORRUPT`
 * @returns 结构化文本 + 标题边界 + 统计 + 警告
 * @throws AppError `DOCX_CORRUPT`：未注入转换器，或转换器抛错（无法解析文档结构）
 * @throws AppError `TASK_CANCELLED`：signal 已中止
 */
export async function parseDocx(input: DocxParseInput): Promise<DocxParseResult> {
  if (input.signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage: 'parseDocx' } })

  if (!input.converter) {
    // 按要求抛 DOCX_CORRUPT；details 里说清「是没注入转换器」而不是文档坏了
    throw new AppError('DOCX_CORRUPT', {
      params: { paragraphs: 0 },
      details: {
        reason: '未注入 DOCX 转换器',
        injection: '生产环境用 mammoth：{ convertToHtml: ({ buffer }) => mammoth.convertToHtml({ buffer }) }',
      },
    })
  }
  if (input.buffer.length === 0) {
    throw new AppError('DOCX_CORRUPT', { params: { paragraphs: 0 }, details: { reason: '文件内容为空' } })
  }

  let html: string
  let converterMessages: unknown[] = []
  try {
    const converted = await input.converter.convertToHtml({ buffer: input.buffer })
    html = converted.value ?? ''
    converterMessages = converted.messages ?? []
  } catch (e) {
    // docs/10 §10：文档结构异常。此处无法「尽力提取」，如实抛错并带上原因链
    throw new AppError('DOCX_CORRUPT', {
      params: { paragraphs: 0 },
      cause: e,
      details: { reason: '转换器无法解析该文档' },
    })
  }
  if (input.signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage: 'parseDocx' } })

  const structured = htmlToStructuredText(html)
  if (structured.text.trim().length === 0) {
    throw new AppError('DOCX_CORRUPT', {
      params: { paragraphs: structured.paragraphCount },
      details: { reason: '文档中没有可提取的文字内容（可能全是图片）' },
    })
  }
  return { ...structured, converterMessages }
}
