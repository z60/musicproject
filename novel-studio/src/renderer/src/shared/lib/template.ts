/**
 * Novel Studio · 导出命名模板（纯逻辑，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §5.3 —— 命名与目录：
 *       模板占位符 `{bookTitle}` `{author}` `{chapterIndex}` `{chapterIndex:03}`
 *       `{chapterTitle}` `{narrator}` `{date}`；
 *       文件名清洗：去掉 `\ / : * ? " < > |` 与控制字符；**UTF-8 字节数截断到 120**；
 *       冲突自动加 `_2`。
 *   · docs/15 §5.5 —— 导出向导 Step 2/Step 5 需要实时预览「将生成哪些文件」。
 *
 * 为什么预览逻辑必须与主进程一致，而且要放在共享位置：
 *   用户在向导里看到 `001_第1章.mp3`，实际导出却叫 `001_第1章_.mp3` 或写到别处，
 *   是最容易被投诉的一类 bug。因此命名规则做成**可单测的纯函数**，
 *   主进程写文件、渲染进程预览都用它（见 tests/renderer/template.test.ts）。
 *
 * 注意：本文件为了能被 `node --experimental-strip-types` 直接执行，
 * 对共享常量的引用走**相对路径 + .ts 扩展名**（等价于渲染侧的 `@shared/constants.ts`，
 * 见 package.json 的 import-ext 说明）。
 */

import { EXPORT_DEFAULTS } from '../../../../shared/constants.ts'

// ---------------------------------------------------------------------------
// 占位符
// ---------------------------------------------------------------------------

export interface TemplatePlaceholder {
  token: string
  label: string
  /** 示例值，用于向导里的预览提示 */
  sample: string
}

/** 支持的占位符（顺序即 UI 上的展示顺序） */
export const TEMPLATE_PLACEHOLDERS: readonly TemplatePlaceholder[] = [
  { token: 'bookTitle', label: '书名', sample: '斗破苍穹' },
  { token: 'author', label: '作者', sample: '天蚕土豆' },
  { token: 'chapterIndex', label: '章节序号（1 起）', sample: '1' },
  { token: 'chapterIndex:03', label: '章节序号（补零到 3 位）', sample: '001' },
  { token: 'chapterTitle', label: '章节标题', sample: '第1章 陨落的天才' },
  { token: 'volumeTitle', label: '卷名（如有）', sample: '第一卷' },
  { token: 'narrator', label: '旁白/朗读人', sample: 'AI 播讲' },
  { token: 'date', label: '导出日期', sample: '2024-05-01' },
  { token: 'format', label: '格式（mp3/wav/m4a）', sample: 'mp3' },
  { token: 'totalChapters', label: '总章数', sample: '120' },
] as const

/** 默认模板（与 settings.export.fileNameTemplate 默认值同源） */
export const DEFAULT_FILE_NAME_TEMPLATE = EXPORT_DEFAULTS.fileNameTemplate
/** 默认章标题模板（`第{index}章 {title}`） */
export const DEFAULT_CHAPTER_TITLE_TEMPLATE = EXPORT_DEFAULTS.chapterTitleTemplate

export interface TemplateContext {
  bookTitle?: string | null
  author?: string | null
  /** 章节序号（**1 起**，用于 `{chapterIndex:03}`） */
  chapterIndex?: number | null
  chapterTitle?: string | null
  volumeTitle?: string | null
  narrator?: string | null
  date?: Date | number | string | null
  format?: string | null
  totalChapters?: number | null
  /** 别名：`{index}`（章标题模板用） */
  index?: number | null
  /** 别名：`{title}`（章标题模板用） */
  title?: string | null
}

/** 单个占位符：`{name}` 或 `{name:03}` */
const TOKEN_RE = /\{([A-Za-z][A-Za-z0-9_]*)(?::([^}]*))?\}/g

export interface TemplateToken {
  /** 原文，如 `{chapterIndex:03}` */
  raw: string
  name: string
  /** 冒号后的格式说明，如 `03` */
  formatSpec: string | null
  /** 是否为已知占位符（未知的在渲染时**原样保留**，便于用户发现写错了） */
  known: boolean
  start: number
  end: number
}

/** 拆解模板里的占位符（用于高亮、校验与预览） */
export function parseTemplate(template: string | null | undefined): TemplateToken[] {
  if (typeof template !== 'string' || !template) return []
  const tokens: TemplateToken[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(template)) !== null) {
    const name = m[1] ?? ''
    tokens.push({
      raw: m[0],
      name,
      formatSpec: m[2] ?? null,
      known: isKnownPlaceholder(name),
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return tokens
}

const KNOWN_NAMES = new Set([
  'bookTitle', 'author', 'chapterIndex', 'chapterTitle', 'volumeTitle',
  'narrator', 'date', 'format', 'totalChapters', 'index', 'title',
])

export function isKnownPlaceholder(name: string): boolean {
  return KNOWN_NAMES.has(name)
}

/** 未知占位符清单（向导里给黄色提示，但不阻断导出） */
export function unknownPlaceholders(template: string): string[] {
  return [...new Set(parseTemplate(template).filter(t => !t.known).map(t => t.name))]
}

function padNumber(value: number, spec: string | null): string {
  const text = String(Math.trunc(value))
  if (!spec) return text
  // `:03` → 补零到 3 位；`:3` 也接受（等价于 03）；其他格式说明忽略（保持宽容）
  const digits = /^0*(\d+)$/.exec(spec.trim())
  if (!digits) return text
  const width = Number(digits[1])
  if (!Number.isFinite(width) || width <= 0) return text
  return text.padStart(width, '0')
}

function formatDateToken(value: TemplateContext['date']): string {
  if (value === null || value === undefined) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const p2 = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`
}

function resolvePlaceholder(name: string, ctx: TemplateContext, formatSpec: string | null): string | null {
  switch (name) {
    case 'bookTitle': return ctx.bookTitle ?? null
    case 'author': return ctx.author ?? null
    case 'chapterIndex': {
      const v = ctx.chapterIndex
      return v === null || v === undefined ? null : padNumber(Number(v), formatSpec)
    }
    case 'index': {
      const v = ctx.index ?? ctx.chapterIndex
      return v === null || v === undefined ? null : padNumber(Number(v), formatSpec)
    }
    case 'chapterTitle': return ctx.chapterTitle ?? null
    case 'title': return ctx.title ?? ctx.chapterTitle ?? null
    case 'volumeTitle': return ctx.volumeTitle ?? null
    case 'narrator': return ctx.narrator ?? null
    case 'date': return formatDateToken(ctx.date)
    case 'format': return ctx.format ?? null
    case 'totalChapters': return ctx.totalChapters === null || ctx.totalChapters === undefined
      ? null
      : String(ctx.totalChapters)
    default: return null
  }
}

/**
 * 渲染模板（**不**做文件名清洗，纯替换）。
 * 规则：
 *   · 已知占位符 → 取值（值为 null/undefined → 空串，避免出现 `null` 字样）；
 *   · 未知占位符 → **原样保留** `{foo}`（用户能一眼看到写错了，而不是静默丢掉）；
 *   · 非法输入（null/非字符串）→ 返回空串，不抛错。
 */
export function renderTemplate(template: string | null | undefined, ctx: TemplateContext): string {
  if (typeof template !== 'string' || !template) return ''
  return template.replace(TOKEN_RE, (raw, name: string, spec: string | null) => {
    if (!isKnownPlaceholder(name)) return raw
    const value = resolvePlaceholder(name, ctx, spec ?? null)
    return value ?? ''
  })
}

/** 模板里出现的、值为空的占位符（向导里提示「该项为空将留白」） */
export function emptyPlaceholders(template: string, ctx: TemplateContext): string[] {
  return [...new Set(
    parseTemplate(template)
      .filter(t => t.known && !resolvePlaceholder(t.name, ctx, t.formatSpec))
      .map(t => t.name),
  )]
}

// ---------------------------------------------------------------------------
// 文件名清洗（docs/15 §5.3）
// ---------------------------------------------------------------------------

/** Windows 与 POSIX 双平台都不允许出现在文件名里的字符 + 控制字符 */
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g
/** 保留名（Windows）—— 单独出现时会被系统拒写，统一加前缀 `_` */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** UTF-8 字节数上限（docs/15 §5.3：截断到 120） */
export const MAX_FILE_NAME_BYTES = 120

/** 按 UTF-8 字节数截断（不切断多字节字符；中文 1 字 = 3 字节） */
export function truncateUtf8(input: string, maxBytes: number): string {
  if (!(maxBytes > 0)) return ''
  // 先看字节数，超了才逐字符累加（避免长文件的 O(n) 多次编码）
  if (utf8ByteLength(input) <= maxBytes) return input
  let out = ''
  let used = 0
  for (const ch of input) {
    const size = utf8ByteLength(ch)
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}

/** UTF-8 字节长度（不依赖 Buffer/TextEncoder，纯计算，Node 与浏览器一致） */
export function utf8ByteLength(input: string): number {
  let bytes = 0
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * 清洗单个文件名（不含目录分隔符）。
 *   1. 去掉非法字符与控制字符；
 *   2. 合并连续空白与连续下划线（`第1章  陨落` → `第1章 陨落`）；
 *   3. 去掉结尾的 `.` 与空格（Windows 会拒写 `x.`）；
 *   4. 保留名加前缀 `_`；
 *   5. UTF-8 截断到 120 字节（保扩展名优先：先按扩展名切分，截断主体后拼回）。
 */
export function sanitizeFileName(name: string | null | undefined, opts: { maxBytes?: number } = {}): string {
  if (typeof name !== 'string') return ''
  const maxBytes = opts.maxBytes ?? MAX_FILE_NAME_BYTES

  let cleaned = name
    .replace(ILLEGAL_CHARS_RE, '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/_{2,}/g, '_')
    .trim()

  // 去掉结尾的点与空格
  cleaned = cleaned.replace(/[. ]+$/g, '')

  if (!cleaned) return ''

  // 保留名（con / nul / lpt1 …）
  if (RESERVED_NAMES.test(cleaned)) cleaned = `_${cleaned}`

  // 扩展名单独保留，避免把 `.mp3` 截掉
  const dot = cleaned.lastIndexOf('.')
  const hasExt = dot > 0 && dot < cleaned.length - 1 && cleaned.length - dot <= 8
  const base = hasExt ? cleaned.slice(0, dot) : cleaned
  const ext = hasExt ? cleaned.slice(dot) : ''

  const extBytes = utf8ByteLength(ext)
  const baseLimit = Math.max(1, maxBytes - extBytes)
  const trimmedBase = truncateUtf8(base, baseLimit).replace(/[. ]+$/g, '')

  return `${trimmedBase}${ext}`
}

/**
 * 清洗一个相对路径：逐段清洗，丢掉空段与 `.`，**拒绝 `..`**（防止导出写到目录外）。
 * 返回以 `/` 分隔的相对路径（调用方负责与 exportDir 拼接）。
 */
export function sanitizeRelativePath(path: string | null | undefined): string {
  if (typeof path !== 'string' || !path) return ''
  return path
    .split(/[\\/]+/)
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.')
    .map(segment => (segment === '..' ? '' : sanitizeFileName(segment)))
    .filter(Boolean)
    .join('/')
}

// ---------------------------------------------------------------------------
// 组合：预览「将生成的文件」
// ---------------------------------------------------------------------------

export interface FileNamePreview {
  /** 相对导出目录的路径（已清洗），如 `斗破苍穹/001_第1章 陨落的天才.mp3` */
  relativePath: string
  /** 只有文件名，便于列表显示 */
  fileName: string
  /** 目录部分（可为空串） */
  dir: string
  /** 渲染后是否出现了未知占位符（出现则说明模板写错了） */
  unknownTokens: string[]
  /** 是否触发了重名加序号（`_2`） */
  renamed: boolean
}

/**
 * 生成一个章节的导出文件名（= 主进程实际写盘用的口径）。
 * `ext` 若不传，则从 `ctx.format` 推导（mp3/wav/m4a）。
 *
 * 关键实现选择：**先把模板按 `/` 拆段、再渲染、再逐段清洗**。
 * 反例（早期实现踩过）：先整体渲染再按 `/` 拆段，则章节标题里的 `/`（如「第1章: 陨落/天才?」）
 * 会凭空多出一层目录，等于把用户的脏数据变成了路径结构。
 */
export function buildFileName(
  template: string | null | undefined,
  ctx: TemplateContext,
  ext?: string,
): FileNamePreview {
  const tmpl = template || DEFAULT_FILE_NAME_TEMPLATE
  const unknownTokens = unknownPlaceholders(tmpl)
  const extension = (ext ?? ctx.format ?? '').replace(/^\./, '')

  const segments = tmpl
    .split(/[\\/]+/)
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => sanitizeFileName(renderTemplate(segment, ctx)))
    .filter(Boolean)

  if (!segments.length) segments.push('untitled') // 模板被清洗成空（如 `...`）时的兜底名

  if (extension) {
    const last = segments.length - 1
    const current = segments[last] as string
    if (!current.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
      segments[last] = sanitizeFileName(`${current}.${extension}`) || `untitled.${extension}`
    }
  }

  const relativePath = segments.join('/')
  const idx = relativePath.lastIndexOf('/')
  return {
    relativePath,
    fileName: idx >= 0 ? relativePath.slice(idx + 1) : relativePath,
    dir: idx >= 0 ? relativePath.slice(0, idx) : '',
    unknownTokens,
    renamed: false,
  }
}

/**
 * 批量预览 + 重名消解（docs/15 §5.3：冲突自动加 `_2`）。
 * 注意：重名判断在**同一目录内**进行，不同目录同名不算冲突。
 *
 * `ctx` 只排除逐章变化的 `chapterIndex` / `chapterTitle`（这两个由章节列表提供），
 * **不排除 `volumeTitle`** —— 章节列表里 `volumeTitle` 是可选的，用户需要在
 * 「全局模板上下文」里给一个默认卷名，逐章值优先（下面的 `?? null` 写法保留了这一点）。
 * 早期这里把 `volumeTitle` 也 Omit 掉了，导致调用方传 `volumeTitle` 直接报 TS2353。
 */
export function buildFileNames(
  template: string | null | undefined,
  chapters: Array<{ chapterIndex: number; chapterTitle: string; volumeTitle?: string | null }>,
  ctx: Omit<TemplateContext, 'chapterIndex' | 'chapterTitle'> & { ext?: string } = {},
): FileNamePreview[] {
  const used = new Set<string>()
  const out: FileNamePreview[] = []

  for (const chapter of chapters) {
    const preview = buildFileName(template, {
      ...ctx,
      chapterIndex: chapter.chapterIndex,
      chapterTitle: chapter.chapterTitle,
      volumeTitle: chapter.volumeTitle ?? null,
    }, ctx.ext)

    const key = preview.relativePath.toLowerCase()
    if (!used.has(key)) {
      used.add(key)
      out.push(preview)
      continue
    }

    // 加 `_2`、`_3` … 直到不冲突
    const dot = preview.fileName.lastIndexOf('.')
    const base = dot > 0 ? preview.fileName.slice(0, dot) : preview.fileName
    const extPart = dot > 0 ? preview.fileName.slice(dot) : ''
    const dirLower = preview.dir.toLowerCase()
    let n = 2
    let candidate = ''
    do {
      candidate = `${base}_${n}${extPart}`
      n++
    } while (used.has((dirLower ? `${dirLower}/` : '') + candidate.toLowerCase()) && n < 1000)

    const relativePath = preview.dir ? `${preview.dir}/${candidate}` : candidate
    used.add(relativePath.toLowerCase())
    out.push({ ...preview, relativePath, fileName: candidate, renamed: true })
  }

  return out
}

/** 章标题渲染（`chapterTitleTemplate` = `第{index}章 {title}`） */
export function buildChapterTitle(
  template: string | null | undefined,
  ctx: { index: number; title: string },
): string {
  const tmpl = template || DEFAULT_CHAPTER_TITLE_TEMPLATE
  return renderTemplate(tmpl, { index: ctx.index, title: ctx.title, chapterIndex: ctx.index, chapterTitle: ctx.title })
    .replace(/\s{2,}/g, ' ')
    .trim()
}
