/**
 * Novel Studio · PDF 解析器（docs/10 §8.3）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §2 表格：PDF → `pdf.parser.ts`（pdfjs-dist），仅文本层；无文本层 → 明确拒绝
 *   · §3 第 ④ 步：逐页 extractText → 合并（插入页分隔标记）
 *   · §8.3 实现要点与「坑」表：
 *       - 无文本层（扫描版）→ 抛 PDF_NO_TEXT_LAYER，**绝不产出一本空书**
 *       - 按坐标还原行：用 transform[5]（y）分组，容差 2~3 px；组内按 x 排序，
 *         用 hasEOL 或间距判断是否加空格
 *       - 页眉页脚：跨页重复出现的短行 → 自动识别并移除
 *       - 双栏排版：x 分布呈双峰 → 按栏切分再合并（否则文字会交错）
 *       - 连字符断词：行尾 `-` 且下行首为小写字母 → 合并
 *       - 中英文混排空格：可选，默认不做以免破坏文本
 *       - 页码行：单独成行的数字 → 移除
 *       - 质量提示：可读性指标（乱码比例 / 行平均长度 / 异常空行比例）
 *   · §10 错误码：PDF_NO_TEXT_LAYER / PDF_ENCRYPTED / PDF_PARSE_LOW_QUALITY
 *
 * 零第三方依赖：PDF 的压缩流解析必须靠库。生产环境用 `pdfjs-dist`：
 *
 * ```ts
 * import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
 * const extractor: PdfTextExtractor = {
 *   getDocument: (params) => pdfjs.getDocument(params) as unknown as { promise: Promise<PdfDocumentProxy> },
 * }
 * const result = await parsePdf({ buffer, extractor })
 * ```
 *
 * 未注入提取器时抛 `NOT_IMPLEMENTED`（并说明注入方式）——用 PDF_NO_TEXT_LAYER
 * 会把「没装依赖」谎报成「这是扫描件」，那是错误的诊断。
 *
 * 坐标几何相关的算法（y 分组、双栏检测、页眉页脚去重、连字符合并、质量评估）
 * 都是**纯函数**，可脱离 pdfjs 独立测试。
 */

import { AppError } from '../../../../../shared/errors.ts'
import { normalizeNewlines, stripBom } from '../../../../../shared/text/encoding.ts'

// ============================================================================
// 注入接口（与 pdfjs-dist 的形状对齐）
// ============================================================================

/** pdfjs 的 TextItem（只声明用得到的字段） */
export interface PdfTextItem {
  str: string
  /** [a, b, c, d, e, f]：e = x，f = y */
  transform: number[]
  width?: number
  height?: number
  hasEOL?: boolean
}

export interface PdfTextContent {
  items: PdfTextItem[]
}

export interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>
}

export interface PdfDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
}

/** PDF 文本提取器（注入式）。生产环境用 pdfjs-dist 的 getDocument。 */
export interface PdfTextExtractor {
  getDocument(params: {
    data: Uint8Array
    useWorkerFetch?: boolean
    isEvalSupported?: boolean
    password?: string
  }): { promise: Promise<PdfDocumentProxy> }
}

// ============================================================================
// 中间结构
// ============================================================================

/** 还原出来的一行（含几何信息，便于双栏/页眉页脚判定） */
export interface PdfLine {
  text: string
  /** 行内文本块的 y 坐标（PDF 坐标系，越大越靠上） */
  y: number
  /** 行内最小 x */
  x: number
  /** 行内最大 x + 宽度 */
  x2: number
  /** 该行在页面中的序号（已排序，0 起） */
  order: number
  /** 是否被识别为页眉/页脚并移除 */
  removed?: boolean
  /** 行来源：左栏 / 右栏 / 单栏 */
  column?: 'left' | 'right' | 'single'
}

export interface PdfPageLines {
  pageNumber: number
  lines: PdfLine[]
  /** 双栏检测结果 */
  layout: PdfLayout
  /** 该页是否被判定为无文本层 */
  empty: boolean
}

export interface PdfLayout {
  columns: 1 | 2
  /** 双栏时的分栏 x 坐标（左栏 < splitX ≤ 右栏） */
  splitX: number | null
  confidence: number
}

export interface PdfQualityMetrics {
  /** U+FFFD 等替换字符占比 */
  replacementRatio: number
  /** 行平均字数 */
  averageLineChars: number
  /** 空行占比 */
  blankLineRatio: number
  /** 汉字占比（合理排版的中文书应较高） */
  cjkRatio: number
  /** 连字符断词合并次数 */
  mergedHyphenLines: number
  /** 被判定为页眉/页脚并移除的行数 */
  removedHeaderFooterLines: number
}

export interface PdfQuality {
  lowQuality: boolean
  metrics: PdfQualityMetrics
  reasons: string[]
}

export interface PdfParseResult {
  text: string
  pageCount: number
  pages: PdfPageLines[]
  quality: PdfQuality
  /** 每页文本在 text 中的起始偏移（不插入可见分隔标记，见 parsePdf 注释） */
  pageStartOffsets: number[]
  warnings: string[]
}

export interface PdfParseOptions {
  /** y 坐标分组容差（px，默认 3，docs/10 §8.3「容差 2~3 px」） */
  yTolerance?: number
  /** 行内空格判定：水平间距超过 该比例 × 字高 就补空格（默认 0.3） */
  spaceGapRatio?: number
  /** 双栏检测：中间空白带最小宽度占比（默认 0.06） */
  columnGapRatio?: number
  /** 页眉/页脚：短行上限字数（默认 40） */
  headerFooterMaxChars?: number
  /** 页眉/页脚：跨页重复率阈值（默认 0.6） */
  headerFooterRepeatRatio?: number
  /** 页眉/页脚：只检查每页前后各几行（默认 3） */
  headerFooterScanLines?: number
  /** 无文本层阈值：全文抽取字符数低于它即拒绝（默认 20） */
  minTextChars?: number
  /** 页与页之间插入的分隔标记（默认 ''，理由见 parsePdf 注释） */
  pageSeparator?: string
  /** 是否做双栏检测与按栏重排（默认 true；排版诡异的 PDF 可关） */
  detectColumns?: boolean
  password?: string
}

// ============================================================================
// 纯函数：坐标 → 行（docs/10 §8.3）
// ============================================================================

/**
 * 按 y 坐标把文本块聚合成行（docs/10 §8.3「按坐标还原行」）。
 *
 * 算法：
 *   1. 丢掉空字符串块（PDF 常见的占位）
 *   2. **先做双栏检测**：双栏页里同一 y 上左右两栏都有文字块，必须按栏分开分组，
 *      否则两栏会粘成一行（文字交错）
 *   3. 每栏内按 y 从大到小排序（PDF 的 y 向上增长），|Δy| ≤ yTolerance 归为同一行
 *   4. 行内按 x 从小到大排序；`hasEOL` 或「水平间距 > spaceGapRatio × 字高」时补空格，
 *      但两边都是汉字时不补（中文排版本来就没有词间空格）
 *   5. 阅读顺序：左栏全部 → 右栏全部 → 跨栏行
 *
 * @param items 单页的 textContent.items
 * @param options yTolerance / spaceGapRatio；`detectColumns: false` 可强制单栏
 * @returns 还原出的行（已按阅读顺序编号）
 */
export function groupItemsIntoLines(items: PdfTextItem[], options?: PdfParseOptions): PdfLine[] {
  const yTolerance = options?.yTolerance ?? 3
  const spaceGapRatio = options?.spaceGapRatio ?? 0.3
  const usable = items.filter((it) => typeof it.str === 'string' && it.str.trim().length > 0)
  if (usable.length === 0) return []

  const decorated = usable.map((it) => {
    const [a = 1, , , d = 1, e = 0, f = 0] = it.transform
    const height = Math.abs(it.height ?? d) || 1
    const width = it.width ?? Math.abs(a) * it.str.length
    return { item: it, x: e, y: f, width, height }
  })

  const layout = options?.detectColumns === false ? { columns: 1 as const, splitX: null, confidence: 0 } : detectColumns(items, options)
  const splitX = layout.columns === 2 ? layout.splitX : null

  const partitions: Array<{ column: PdfLine['column']; nodes: typeof decorated }> =
    splitX === null
      ? [{ column: 'single', nodes: decorated }]
      : [
          { column: 'left', nodes: decorated.filter((n) => n.x + n.width <= splitX) },
          { column: 'right', nodes: decorated.filter((n) => n.x >= splitX) },
          // 跨栏的行（表头、通栏标题）：单独一组，排在最后
          { column: 'single', nodes: decorated.filter((n) => n.x + n.width > splitX && n.x < splitX) },
        ]

  const lines: PdfLine[] = []
  for (const partition of partitions) {
    if (partition.nodes.length === 0) continue
    const sorted = [...partition.nodes].sort((p, q) => q.y - p.y || p.x - q.x)
    const groups: Array<typeof sorted> = []
    for (const node of sorted) {
      const current = groups[groups.length - 1]
      if (current && Math.abs(current[0]!.y - node.y) <= yTolerance) {
        current.push(node)
        continue
      }
      groups.push([node])
    }
    for (const group of groups) {
      group.sort((p, q) => p.x - q.x)
      let text = ''
      let prevEnd: number | null = null
      let prevChar = ''
      let minX = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      for (const node of group) {
        const gap = prevEnd === null ? 0 : node.x - prevEnd
        const nextFirst = node.item.str[0] ?? ''
        const needSpace =
          prevEnd !== null &&
          (node.item.hasEOL === true || gap > spaceGapRatio * Math.max(node.height, 1)) &&
          gap > 0 &&
          // 中英混排空格默认不做（docs/10 §8.3）：两边都是汉字时不补
          !(isCjkChar(prevChar) && isCjkChar(nextFirst)) &&
          // 行内被拆开的连字符单词（`inter-` + `national`）不补空格，
          // 否则会破坏后续的「连字符断词合并」
          !(prevChar === '-' && /^[a-z]/.test(nextFirst))
        if (needSpace && text.length > 0 && !text.endsWith(' ')) text += ' '
        text += node.item.str
        prevEnd = node.x + node.width
        prevChar = node.item.str[node.item.str.length - 1] ?? ''
        minX = Math.min(minX, node.x)
        maxX = Math.max(maxX, prevEnd)
      }
      const trimmed = text.replace(/\s+$/, '')
      if (trimmed.trim().length === 0) continue
      lines.push({
        text: trimmed,
        y: group[0]!.y,
        x: Number.isFinite(minX) ? minX : 0,
        x2: Number.isFinite(maxX) ? maxX : 0,
        order: lines.length,
        column: partition.column,
      })
    }
  }
  return lines
}

function isCjkChar(ch: string): boolean {
  if (ch.length === 0) return false
  const cp = ch.codePointAt(0) ?? 0
  return (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
}

// ============================================================================
// 纯函数：双栏检测（docs/10 §8.3）
// ============================================================================

/** 水平跨度（双栏直方图的输入） */
export interface HSpan {
  x: number
  x2: number
}

/**
 * 双栏检测的通用实现：在水平跨度分布里找一条贯穿的「空白竖带」。
 *
 * 做法：把水平范围分成 40 个区间做直方图，在中间 30%~70% 区域找最长的空区间串；
 * 空串宽度达标、且两侧各占 ≥25% 的跨度，才判为双栏。
 *
 * @param spans 元素（文本块或行）的水平跨度
 * @param options columnGapRatio
 */
export function detectColumnSplitFromSpans(spans: readonly HSpan[], options?: PdfParseOptions): PdfLayout {
  const single: PdfLayout = { columns: 1, splitX: null, confidence: 0 }
  if (spans.length < 4) return single
  const minX = Math.min(...spans.map((s) => s.x))
  const maxX = Math.max(...spans.map((s) => s.x2))
  const width = maxX - minX
  if (width <= 0) return single

  const bins = 40
  const histogram = new Array<number>(bins).fill(0)
  for (const span of spans) {
    const from = Math.max(0, Math.min(bins - 1, Math.floor(((span.x - minX) / width) * bins)))
    const to = Math.max(0, Math.min(bins - 1, Math.ceil(((span.x2 - minX) / width) * bins) - 1))
    for (let b = from; b <= to; b++) histogram[b] = (histogram[b] ?? 0) + 1
  }

  const minGapBins = Math.max(1, Math.round((options?.columnGapRatio ?? 0.06) * bins))
  let bestStart = -1
  let bestLength = 0
  for (let start = Math.floor(bins * 0.3); start < Math.floor(bins * 0.7); start++) {
    if ((histogram[start] ?? 0) !== 0) continue
    let length = 0
    while (start + length < bins && (histogram[start + length] ?? 0) === 0) length++
    if (length > bestLength) {
      bestLength = length
      bestStart = start
    }
    start += length
  }
  if (bestStart < 0 || bestLength < minGapBins) return single

  const splitX = minX + ((bestStart + bestLength / 2) / bins) * width
  const left = spans.filter((s) => s.x2 <= splitX).length
  const right = spans.filter((s) => s.x >= splitX).length
  if (left < spans.length * 0.25 || right < spans.length * 0.25) return single

  const balance = 1 - Math.abs(left - right) / (left + right)
  return { columns: 2, splitX, confidence: Number((0.6 + 0.4 * balance).toFixed(3)) }
}

/**
 * 双栏检测（docs/10 §8.3：「检测 x 坐标分布呈双峰 → 按栏切分再合并，否则文字会交错」）。
 *
 * ⚠ 应针对**文本块**调用（`textContent.items`）：双栏页里同一 y 上左右两栏都有文字块，
 * 若先按 y 聚成行会先把两栏粘在一起，之后再拆就晚了
 * （groupItemsIntoLines 内部就是这么做的）。
 *
 * @param items 单页 textContent.items
 * @param options columnGapRatio
 * @returns columns / splitX / confidence
 */
export function detectColumns(items: readonly PdfTextItem[], options?: PdfParseOptions): PdfLayout {
  const spans: HSpan[] = []
  for (const it of items) {
    if (typeof it.str !== 'string' || it.str.trim().length === 0) continue
    const [a = 1, , , , e = 0] = it.transform
    const width = it.width ?? Math.abs(a) * it.str.length
    spans.push({ x: e, x2: e + width })
  }
  return detectColumnSplitFromSpans(spans, options)
}

// ============================================================================
// 纯函数：页眉/页脚跨页去重（docs/10 §8.3）
// ============================================================================

/**
 * 归一化行文本用于「跨页相同」比较：只去空白，**不**把数字抹成通配符。
 *
 * 为什么：早期版本把数字统一成 `#`，结果「第1页的正文…」与「第2页的正文…」被当成
 * 重复行删掉了（真实缺陷）。页码类差异交给 `removePageNumberLines` 处理；
 * 页眉页脚只做「完全相同短行」的跨页去重 —— 宁可漏删，不可误删正文
 * （docs/10 §5.3「不要静默删用户的东西」）。
 */
export function normalizeForRepeat(text: string): string {
  return text.replace(/\s+/g, '').trim()
}

/**
 * 跨页重复的页眉/页脚识别与移除（docs/10 §8.3）。
 *
 * 判定：只看每页开头/结尾各 N 行（默认 3），同一个**完全相同**（去空白后）的短行
 * 在 ≥ repeatRatio（默认 0.6）的页面上出现，且行长度 ≤ maxChars（默认 40）→ 标记 removed。
 *
 * 说明：不做「数字抹平」式归一（页码差异交给 removePageNumberLines），
 * 这样「第1页的正文…」这类会变数字的正文绝不被误删。
 *
 * @param pages 各页的行
 * @param options headerFooterScanLines / headerFooterRepeatRatio / headerFooterMaxChars
 * @returns 处理后的页面（不修改入参）与每页移除行数
 */
export function removeRepeatingHeadersFooters(
  pages: PdfPageLines[],
  options?: PdfParseOptions,
): { pages: PdfPageLines[]; removedByPage: number[] } {
  const scan = options?.headerFooterScanLines ?? 3
  const repeatRatio = options?.headerFooterRepeatRatio ?? 0.6
  const maxChars = options?.headerFooterMaxChars ?? 40
  if (pages.length < 2) return { pages: pages.map((p) => ({ ...p, lines: p.lines.map((l) => ({ ...l })) })), removedByPage: pages.map(() => 0) }

  const counts = new Map<string, number>()
  for (const page of pages) {
    const candidates = [...page.lines.slice(0, scan), ...page.lines.slice(-scan)]
    const seen = new Set<string>()
    for (const line of candidates) {
      if (line.text.length > maxChars) continue
      const key = normalizeForRepeat(line.text)
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const threshold = Math.max(2, Math.ceil(pages.length * repeatRatio))
  const repeated = new Set([...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k))
  const removedByPage: number[] = []
  const out = pages.map((page) => {
    let removed = 0
    const lines = page.lines.map((line) => {
      const key = normalizeForRepeat(line.text)
      if (key.length > 0 && line.text.length <= maxChars && repeated.has(key)) {
        removed++
        return { ...line, removed: true }
      }
      return { ...line }
    })
    removedByPage.push(removed)
    return { ...page, lines: lines.filter((l) => !l.removed) }
  })
  return { pages: out, removedByPage }
}

// ============================================================================
// 纯函数：连字符断词合并 / 页码行（docs/10 §8.3）
// ============================================================================

/**
 * 合并被连字符断开的英文单词（docs/10 §8.3：「行尾 `-` 且下行首为小写字母 → 合并」）。
 * 只处理 ASCII 单词，中文行不受影响。
 * @returns 合并后的行数组与合并次数
 */
export function mergeHyphenatedLines(lines: PdfLine[]): { lines: PdfLine[]; merged: number } {
  const out: PdfLine[] = []
  let merged = 0
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!
    const next = lines[i + 1]
    const endsHyphen = /[A-Za-z]-$/.test(cur.text)
    const nextStartsLower = next !== undefined && /^[a-z]/.test(next.text)
    if (endsHyphen && nextStartsLower) {
      out.push({ ...cur, text: cur.text.slice(0, -1) + next.text, x2: next.x2 })
      merged++
      i++ // 吃掉下一行
      continue
    }
    out.push({ ...cur })
  }
  return { lines: out, merged }
}

/** 移除单独成行的页码（纯数字或 - 12 - 形式，docs/10 §8.3） */
export function removePageNumberLines(lines: PdfLine[]): { lines: PdfLine[]; removed: number } {
  const kept: PdfLine[] = []
  let removed = 0
  for (const line of lines) {
    const t = line.text.trim()
    if (/^[0-9]{1,5}$/.test(t) || /^[-—–－]{1,2}\s*[0-9]{1,5}\s*[-—–－]{1,2}$/.test(t) || /^第\s*[0-9]{1,5}\s*页$/.test(t)) {
      removed++
      continue
    }
    kept.push(line)
  }
  return { lines: kept, removed }
}

// ============================================================================
// 纯函数：可读性指标（docs/10 §8.3「PDF 必须给出质量提示」）
// ============================================================================

/**
 * 计算解析质量指标并给出低质量判定（docs/10 §8.3 末段与 §10 PDF_PARSE_LOW_QUALITY）。
 *
 * 指标：连续乱码（替换字符）比例、行平均字数、异常空行比例、汉字占比。
 * 判定：替换字符 > 2% / 行平均字数 < 6 / 空行占比 > 40% 任一命中即低质量。
 *
 * @param pages 处理后的页面
 * @param mergedHyphenLines 连字符合并次数（用于指标）
 * @param removedHeaderFooterLines 页眉页脚移除行数
 */
export function assessPdfQuality(
  pages: PdfPageLines[],
  mergedHyphenLines = 0,
  removedHeaderFooterLines = 0,
): PdfQuality {
  const allLines = pages.flatMap((p) => p.lines)
  const totalChars = allLines.reduce((s, l) => s + l.text.length, 0)
  const replacement = (allLines.map((l) => l.text).join('').match(/\uFFFD/g) ?? []).length
  const cjk = (allLines.map((l) => l.text).join('').match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
  const blank = allLines.filter((l) => l.text.trim().length === 0).length
  const replacementRatio = totalChars > 0 ? replacement / totalChars : 0
  const averageLineChars = allLines.length > 0 ? totalChars / allLines.length : 0
  const blankLineRatio = allLines.length > 0 ? blank / allLines.length : 0
  const cjkRatio = totalChars > 0 ? cjk / totalChars : 0

  const reasons: string[] = []
  if (replacementRatio > 0.02) reasons.push(`替换字符（乱码）占比 ${(replacementRatio * 100).toFixed(1)}%`)
  if (averageLineChars > 0 && averageLineChars < 6) reasons.push(`行平均字数仅 ${averageLineChars.toFixed(1)} 字`)
  if (blankLineRatio > 0.4) reasons.push(`异常空行占比 ${(blankLineRatio * 100).toFixed(0)}%`)

  return {
    lowQuality: reasons.length > 0,
    metrics: {
      replacementRatio: Number(replacementRatio.toFixed(4)),
      averageLineChars: Number(averageLineChars.toFixed(2)),
      blankLineRatio: Number(blankLineRatio.toFixed(4)),
      cjkRatio: Number(cjkRatio.toFixed(4)),
      mergedHyphenLines,
      removedHeaderFooterLines,
    },
    reasons,
  }
}

// ============================================================================
// 主入口
// ============================================================================

/** 判断 pdfjs 的异常是否为「需要密码」 */
function isPasswordError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const name = (e as { name?: unknown }).name
  if (name === 'PasswordException') return true
  const message = (e as { message?: unknown }).message
  return typeof message === 'string' && /password|encrypt/i.test(message)
}

/**
 * 解析 PDF（docs/10 §8.3）。
 *
 * 页面处理顺序：extractText → 按 y 还原行 → 双栏检测与重排 → 跨页页眉页脚去重
 * → 连字符断词合并 → 页码行移除 → 质量评估。
 *
 * 关于「页分隔标记」（docs/10 §3 第 ④ 步提到）：默认**不插入**可见标记
 * （`pageSeparator: ''`），因为插进去的标记会被当作正文念出来、并干扰分章；
 * 页边界改由 `pageStartOffsets` 与 `pages[]` 提供，需要标记时可显式传入。
 *
 * @param input.buffer PDF 字节
 * @param input.extractor 注入的文本提取器（生产环境用 pdfjs-dist）；未注入时抛 NOT_IMPLEMENTED
 * @returns 全文、页数、逐页行结构、质量报告、页起始偏移与警告
 * @throws AppError `NOT_IMPLEMENTED`：未注入提取器（说明如何注入 pdfjs-dist）
 * @throws AppError `PDF_ENCRYPTED`：文档需要密码
 * @throws AppError `PDF_NO_TEXT_LAYER`：文本层为空或极少（扫描件）
 * @throws AppError `TASK_CANCELLED`：signal 已中止
 */
export async function parsePdf(input: {
  buffer: Buffer
  extractor?: PdfTextExtractor
  options?: PdfParseOptions
  signal?: AbortSignal
}): Promise<PdfParseResult> {
  const { buffer, extractor, options, signal } = input
  if (signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage: 'parsePdf' } })
  if (!extractor) {
    throw new AppError('NOT_IMPLEMENTED', {
      params: { feature: 'PDF 解析（未注入 pdfjs-dist）' },
      details: {
        injection: '生产环境用 pdfjs-dist：{ getDocument: (params) => pdfjs.getDocument(params) }',
      },
    })
  }

  let doc: PdfDocumentProxy
  try {
    doc = await extractor.getDocument({
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      useWorkerFetch: false,
      isEvalSupported: false,
      password: options?.password,
    }).promise
  } catch (e) {
    if (isPasswordError(e)) {
      throw new AppError('PDF_ENCRYPTED', { cause: e })
    }
    // 契约里没有 PDF_CORRUPT 之类的码，这里用 INVALID_PAYLOAD 并写清原因（见最终报告的契约缺口）
    throw new AppError('INVALID_PAYLOAD', {
      cause: e,
      details: { reason: 'PDF 结构无法解析（文件可能损坏或不是真正的 PDF）' },
    })
  }

  const warnings: string[] = []
  const rawPages: PdfPageLines[] = []
  let totalChars = 0

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage: 'parsePdf', pageNumber } })
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()
    const items = content.items ?? []
    const textChars = items.reduce((s, it) => s + (typeof it.str === 'string' ? it.str.trim().length : 0), 0)
    totalChars += textChars
    const lines = groupItemsIntoLines(items, options)
    const layout = detectColumns(items, options)
    rawPages.push({ pageNumber, lines, layout, empty: lines.length === 0 })
  }

  // 无文本层：整本几乎没有可提取文字（docs/10 §8.3 与 §10 PDF_NO_TEXT_LAYER）
  const minTextChars = options?.minTextChars ?? 20
  if (totalChars < minTextChars) {
    throw new AppError('PDF_NO_TEXT_LAYER', {
      details: { pages: doc.numPages, extractedChars: totalChars, minTextChars },
    })
  }
  const emptyPages = rawPages.filter((p) => p.empty).length
  if (emptyPages > 0) warnings.push(`${emptyPages} 页没有可提取的文字（可能是插图页）`)

  // 跨页页眉页脚 → 连字符 → 页码行
  const { pages: deduped, removedByPage } = removeRepeatingHeadersFooters(rawPages, options)
  const removedHeaderFooterLines = removedByPage.reduce((a, b) => a + b, 0)
  let mergedHyphenLines = 0
  const processed: PdfPageLines[] = []
  for (const page of deduped) {
    const hyphen = mergeHyphenatedLines(page.lines)
    const noPageNum = removePageNumberLines(hyphen.lines)
    mergedHyphenLines += hyphen.merged
    processed.push({ ...page, lines: noPageNum.lines })
  }

  // 组装全文（页间用空行分隔；默认不插可见标记）
  const separator = options?.pageSeparator ?? ''
  const parts: string[] = []
  const pageStartOffsets: number[] = []
  let cursor = 0
  for (const page of processed) {
    pageStartOffsets.push(cursor)
    const chunk = page.lines.map((l) => l.text).join('\n')
    parts.push(chunk)
    cursor += chunk.length + (separator ? separator.length + 2 : 2)
  }
  const text = normalizeNewlines(stripBom(parts.join(separator ? `\n${separator}\n` : '\n\n')))

  const quality = assessPdfQuality(processed, mergedHyphenLines, removedHeaderFooterLines)
  if (quality.lowQuality) {
    warnings.push(
      `PDF 解析质量较低（${quality.reasons.join('；')}），建议改用 TXT 版本或人工检查分章结果。`,
    )
  }
  const doubleColumnPages = processed.filter((p) => p.layout.columns === 2).length
  if (doubleColumnPages > 0) {
    warnings.push(`检测到 ${doubleColumnPages} 页为双栏排版，已按栏重排以保证阅读顺序`)
  }

  return {
    text,
    pageCount: doc.numPages,
    pages: processed,
    quality,
    pageStartOffsets,
    warnings,
  }
}
