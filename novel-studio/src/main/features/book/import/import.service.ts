/**
 * Novel Studio · 书籍导入编排（docs/10 §3 的八步管线）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §3 管线：
 *       ① 探测源类型（扩展名 + 魔数双重判定）
 *       ② 读取为 Buffer（限流：单文件 200 MB / 单页 5 MB / 50 页）
 *       ③ 解码（嗅探 → 解码 → 统一换行 → 记录 encoding）
 *       ④ 结构化提取（TXT 整段 / DOCX 标题层级 / PDF 逐页 / URL 选择器）
 *       ⑤ 清洗（§5；保留 rawText 便于回溯）
 *       ⑥ 分章（§6；无匹配 → 备选策略；结果可疑 → CHAPTER_SPLIT_SUSPICIOUS）
 *       ⑦ 预览与人工干预（章列表交给 UI，人工结果通过 chapters 参数回传）
 *       ⑧ 入库（事务写 books + chapters；SHA-256 去重；返回 bookId）
 *     任务化：整流程是一个 `book.import` 任务，**每一步都可取消**；
 *     取消时不写入任何数据（入库是最后一步，且在同一事务内）。
 *   · §9 去重与幂等（content_hash；三选一不做静默选择）
 *   · §10 错误码
 *
 * 依赖注入（本文件不 import 任何第三方库）：
 *   · 仓储与事务：`ImportDeps.bookRepo` / `chapterRepo` / `withTransaction`
 *     （生产用 better-sqlite3，测试用 repositories/ 里的内存实现）
 *   · 可选解析库：docxConverter(mammoth) / pdfExtractor(pdfjs) / htmlExtractor(cheerio) / fetchImpl
 *   · 编码：decoders(iconv-lite) / sniffer(chardet)
 */

import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'

import type {
  Book,
  BookSourceType,
  CanvasScriptChapter,
  Chapter,
  ChapterDraft,
  ChapterRuleSet,
  EncodingDetection,
  Id,
  ImportFileProbe,
} from '../../../../shared/types.ts'
import { parseCanvasScript } from '../../../../shared/text/canvas-script.ts'
import { BUILTIN_RULE_SETS, CANVAS_IMPORT_RULE_SET, IMPORT_LIMITS, VAD_DEFAULTS } from '../../../../shared/constants.ts'
import { AppError, formatBytes, resolve, type DisplayableError } from '../../../../shared/errors.ts'
import { createDecoder, detectEncoding, normalizeNewlines, stripBom, type Decoder, type EncodingSniffer } from '../../../../shared/text/encoding.ts'
import {
  inspectSplitSuspicion,
  splitByHeadings,
  splitChaptersDetailed,
  type FallbackStrategy,
  type SplitStrategy,
  type SplitWarning,
} from '../../../../shared/text/chapter-split.ts'
import { cleanText, type CleanOptions, type CleanReportDetail } from '../../../../shared/text/clean.ts'
import type { BookRepo } from './repositories/book.repo.ts'
import type { ChapterRepo, ChapterWithText } from './repositories/chapter.repo.ts'
import { probeFile, type ProbeResult } from './parsers/index.ts'
import { parseDocx, type DocxConverter, type DocxHeading } from './parsers/docx.parser.ts'
import { parsePlain } from './parsers/plain.parser.ts'
import { parsePdf, type PdfParseOptions, type PdfQuality, type PdfTextExtractor } from './parsers/pdf.parser.ts'
import { parseTxt } from './parsers/txt.parser.ts'
import {
  extractFromHtml,
  parseWeb,
  type FetchLike,
  type HtmlExtractor,
  type SiteRule,
  type WebPageRecord,
} from './parsers/web.parser.ts'

// ============================================================================
// 类型
// ============================================================================

/** 管线阶段（用于进度与取消提示） */
export type ImportStage = 'probe' | 'read' | 'decode' | 'extract' | 'clean' | 'split' | 'preview' | 'persist'

export interface ImportProgress {
  stage: ImportStage
  /** 0..1 */
  progress: number
  detail?: string
}

export interface FileSource {
  type: 'file'
  filePath: string
  /** 已读好的字节（剪贴板文件、拖拽内存流）；给了就不再读盘 */
  buffer?: Buffer
  title?: string
  author?: string
  /** UI 编码确认步骤传回的选择（docs/10 §4.3：重新解码不重读文件） */
  encoding?: string
  decoder?: Decoder
  detection?: EncodingDetection
}

export interface PasteSource {
  type: 'paste'
  text: string
  title?: string
  author?: string
}

export interface UrlSource {
  type: 'url'
  url: string
  title?: string
  author?: string
  /** 站点规则（本次导入额外追加，与会叠加到 deps.siteRules 之后） */
  rules?: readonly SiteRule[]
  followNextPage?: boolean
  respectRobots?: boolean
}

export type ImportSource = FileSource | PasteSource | UrlSource

/** 人工干预结果（⑦ 步回传：改名 / 勾选） */
export interface ChapterEdit {
  /** 按 tempId 或 index 定位（二者都行，tempId 优先） */
  tempId?: string
  index?: number
  title?: string
  included?: boolean
}

export interface ImportRequest {
  projectId: Id
  source: ImportSource
  /** 分章规则集（默认 builtin:cn-standard） */
  ruleSet?: ChapterRuleSet
  /** 无匹配时的备选策略；默认 'none'（抛 NO_CHAPTER_MATCHED 交给 UI 选择，docs/10 §6.4） */
  fallback?: FallbackStrategy
  fallbackOptions?: { minBlockChars?: number; charsPerChunk?: number; titlePrefix?: string }
  /** 清洗选项（谨慎项默认关闭，docs/10 §5.2） */
  cleanOptions?: CleanOptions
  /** PDF 解析选项 */
  pdfOptions?: PdfParseOptions
  /** 章节级人工干预（⑦） */
  chapters?: readonly ChapterEdit[]
  /** 单文件上限（默认 IMPORT_LIMITS.maxFileSizeBytes = 200 MB；来自 settings.import） */
  maxFileSizeBytes?: number
  /** 是否入库（默认 true；向导前几步可传 false 只看预览） */
  persist?: boolean
  /**
   * 导入模式：
   *   · 'text'（默认）—— 普通小说；导入后由画本域做说话人判定
   *   · 'canvas' —— 文档**已经是画本**（`【角色-CV】“台词”` + 角色表）：
   *     直接解析成画本行与角色落库，**不再跑判定**（跑了只会把【】标记当正文）
   */
  importMode?: 'text' | 'canvas'
  /** 重复导入策略：error 抛 DUPLICATE_BOOK / open-existing 返回已有 id / copy 作为副本导入 */
  duplicatePolicy?: 'error' | 'open-existing' | 'copy'
  narrator?: string
  language?: string
  /** 书名（覆盖解析出的标题） */
  title?: string
  author?: string
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

export interface ImportPreview {
  sourceType: BookSourceType
  encoding: string | null
  detection: EncodingDetection | null
  /** 清洗前全文（rawText，docs/10 §5「保留原始文本副本」） */
  rawText: string
  /** 清洗后全文 */
  cleanedText: string
  cleanReport: CleanReportDetail
  chapters: ChapterDraft[]
  split: {
    strategy: SplitStrategy
    matchedRuleIds: string[]
    candidateCount: number
    mergedCount: number
    volumes: Array<{ index: number; title: string; startOffset: number }>
    warnings: SplitWarning[]
  }
  /** 分章结果是否可疑（docs/10 §10 CHAPTER_SPLIT_SUSPICIOUS） */
  suspicious: boolean
  totalChars: number
  estimatedDurationMs: number
  contentHash: string
  /** 原始字节数（文件为文件大小；粘贴/URL 为 UTF-8 字节估算） */
  byteLength: number
  fileProbe: ImportFileProbe | null
  headings: DocxHeading[]
  pdfQuality: PdfQuality | null
  webPages: WebPageRecord[]
  title: string | null
}

export interface ImportResult {
  /** 入库后的 book id；persist=false 时为 null（命中「打开已有」时见 duplicate） */
  bookId: Id | null
  preview: ImportPreview
  /** 面向用户的提示（文案与动作全部来自 messages.ts，见 docs/22，不在这里硬编码） */
  notices: DisplayableError[]
  /** 面向开发/日志的警告 */
  warnings: string[]
  /** 命中重复时的已有书籍 id（配合 duplicatePolicy 的「三选一」） */
  duplicate: { bookId: Id } | null
  timings: Partial<Record<ImportStage, number>>
}

/** 事务上下文：只有仓储，不许在事务里做 IO */
export interface ImportTxContext {
  bookRepo: BookRepo
  chapterRepo: ChapterRepo
}

// ---------------------------------------------------------------------------
// 画本导入（文档本身已经是画本：`【角色-CV】“台词”`）
// ---------------------------------------------------------------------------

export interface CanvasImportWriteInput {
  bookId: Id
  chapterId: Id
  chapterTitle: string
  /** 该章解析出来的画本（行 + 角色） */
  script: CanvasScriptChapter
}

/**
 * 画本落库端口（由装配层注入）。
 *
 * 为什么用注入而不是让 import.service 直接依赖画本仓储：
 * 导入算法的职责是「文本 → 结构化结果」，画本/角色属于**另一个域**；
 * 直接依赖会让纯逻辑层被 SQLite 绑死（现有测试都用内存实现跑它）。
 */
export interface CanvasImportPort {
  writeChapter(input: CanvasImportWriteInput): Promise<{ lines: number; characters: number }>
}

export interface ImportDeps {
  bookRepo: BookRepo
  chapterRepo: ChapterRepo
  /**
   * 事务包装：把「写 books + chapters」放进一个事务。
   * 生产实现用 better-sqlite3 的 `db.transaction(...)`；测试可用 createPassthroughTransaction。
   */
  withTransaction: <T>(fn: (tx: ImportTxContext) => Promise<T> | T) => Promise<T>
  /** 读文件（默认 node:fs/promises） */
  readFile?: (filePath: string) => Promise<Buffer>
  /** 取文件大小（默认 node:fs/promises stat） */
  statFile?: (filePath: string) => Promise<{ size: number }>
  /** DOCX 转换器（生产：mammoth） */
  docxConverter?: DocxConverter
  /** PDF 提取器（生产：pdfjs-dist） */
  pdfExtractor?: PdfTextExtractor
  /** HTML 抽取器（生产：cheerio） */
  htmlExtractor?: HtmlExtractor
  /** HTTP 实现（默认运行时 fetch / undici） */
  fetchImpl?: FetchLike
  /** 内置站点规则表 */
  siteRules?: readonly SiteRule[]
  /** 注入型解码器（生产：iconv-lite） */
  decoders?: Record<string, Decoder>
  /** 注入型嗅探器（生产：chardet） */
  sniffer?: EncodingSniffer
  /** 画本落库端口（仅 `importMode: 'canvas'` 时使用；不注入则只导入章节、不写画本） */
  canvasImport?: CanvasImportPort
  /** 摘要实现（默认 node:crypto 的 sha256） */
  sha256?: (data: string | Uint8Array) => string
  /** id 生成（默认 randomUUID） */
  newId?: () => string
  /** 时间源（默认 Date.now） */
  now?: () => number
}

// ============================================================================
// 工具
// ============================================================================

function throwIfAborted(signal?: AbortSignal, stage?: ImportStage): void {
  if (signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { stage } })
}

/** 默认 sha256（Node 内置 crypto，无需第三方库） */
function defaultSha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 非空行数（Chapter.lineCount 的占位口径；真正的画本行数由 docs/11 的切句决定） */
function countNonEmptyLines(text: string): number {
  let n = 0
  for (const line of text.split('\n')) if (line.trim().length > 0) n++
  return n
}

function estimateDurationMs(charCount: number): number {
  return Math.round((charCount / VAD_DEFAULTS.charsPerSecond) * 1000)
}

/** 文件名（去扩展名），作为没给书名时的默认书名 */
function baseName(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(0, idx) : name
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行一次书籍导入（docs/10 §3 的八步管线）。
 *
 * 每一步都会检查 `signal`（取消时不写任何数据）；入库是最后一步，且
 * 「写 books + 写 chapters」在**同一个事务**里（通过注入的 withTransaction）。
 *
 * @param request 导入请求（源、规则集、清洗选项、人工干预、去重策略…）
 * @param deps 依赖（仓储 / 事务 / 可选解析库 / 编解码注入）
 * @returns 预览结果、bookId、提示与警告
 * @throws AppError `INVALID_PAYLOAD`：无法识别的文件类型
 * @throws AppError `FILE_TOO_LARGE`：文件超过上限
 * @throws AppError `ENCODING_DECODE_FAILED`：解码失败或解析结果为空
 * @throws AppError `DOCX_CORRUPT` / `PDF_ENCRYPTED` / `PDF_NO_TEXT_LAYER`
 * @throws AppError `FETCH_FAILED` / `FETCH_BLOCKED` / `FETCH_FORBIDDEN_TARGET` / `FETCH_TOO_MANY_PAGES`
 * @throws AppError `NO_CHAPTER_MATCHED`：无匹配且未指定备选策略（进入策略选择）
 * @throws AppError `RULE_PATTERN_INVALID` / `RULE_PATTERN_UNSAFE`：自定义正则有问题
 * @throws AppError `DUPLICATE_BOOK`：命中重复且策略为 error
 * @throws AppError `TASK_CANCELLED`：取消
 */
export async function runImport(request: ImportRequest, deps: ImportDeps): Promise<ImportResult> {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const sha256 = deps.sha256 ?? defaultSha256
  const warnings: string[] = []
  const notices: DisplayableError[] = []
  const timings: Partial<Record<ImportStage, number>> = {}
  const report = (stage: ImportStage, progress: number, detail?: string): void => {
    request.onProgress?.({ stage, progress, detail })
  }
  const time = async <T>(stage: ImportStage, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = now()
    const out = await fn()
    timings[stage] = (timings[stage] ?? 0) + (now() - t0)
    return out
  }

  const source = request.source
  const fileSource: FileSource | null = source.type === 'file' ? source : null
  const pasteSource: PasteSource | null = source.type === 'paste' ? source : null
  const urlSource: UrlSource | null = source.type === 'url' ? source : null

  // ---- ① 探测源类型（docs/10 §3 第 ① 步） ----
  report('probe', 0)
  let fileProbe: ProbeResult | null = null
  if (fileSource) {
    fileProbe = probeFile({ filePath: fileSource.filePath, buffer: fileSource.buffer })
    if (!fileProbe.parser) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { reason: '无法识别的文件类型', filePath: fileSource.filePath, detected: fileProbe.kind },
      })
    }
  }
  // 文件源：用**探测结果**（而不是 source.type='file'）决定入库的 sourceType ——
  // 'file' 只表示「来自本地文件」，真正的格式是 txt/docx/pdf（见 docs/10 §3 第 ① 步）。
  // 粘贴/URL 源则直接用其自身的 type（'paste' | 'url'）。
  const sourceType: BookSourceType =
    fileSource !== null && fileProbe !== null
      ? fileProbe.kind === 'unknown'
        ? 'txt'
        : fileProbe.kind
      : source.type === 'paste'
        ? 'paste'
        : 'url'

  // ---- ② 读取为 Buffer（限流） ----
  report('read', 0.08)
  let text = ''
  let encoding: string | null = null
  let detection: EncodingDetection | null = null
  let headings: DocxHeading[] = []
  let pdfQuality: PdfQuality | null = null
  let webPages: WebPageRecord[] = []
  let parsedTitle: string | null = null
  let rawByteLength = 0
  const filePath = fileSource?.filePath ?? null

  if (fileSource) {
    const maxFileSizeBytes = request.maxFileSizeBytes ?? IMPORT_LIMITS.maxFileSizeBytes
    const stat = deps.statFile ?? (async (p: string) => ({ size: (await fsStat(p)).size }))
    if (fileSource.buffer) {
      rawByteLength = fileSource.buffer.length
    } else {
      rawByteLength = (await time('read', () => stat(fileSource.filePath))).size
    }
    // 读盘**之前**先按 size 限流（docs/10 §3 第 ② 步）：否则 200 MB 的文件会先被读进内存再报错
    if (rawByteLength > maxFileSizeBytes) {
      throw new AppError('FILE_TOO_LARGE', {
        params: { size: formatBytes(rawByteLength), max: formatBytes(maxFileSizeBytes) },
        details: { filePath: fileSource.filePath, byteLength: rawByteLength, maxBytes: maxFileSizeBytes },
      })
    }
    throwIfAborted(request.signal, 'read')
    const buffer =
      fileSource.buffer ?? (await time('read', async () => (deps.readFile ?? ((p: string) => fsReadFile(p)))(fileSource.filePath)))
    rawByteLength = buffer.length
    // 拿到字节后用魔数复核（防改扩展名，docs/10 §3 第 ① 步）
    const probed = probeFile({ filePath: fileSource.filePath, buffer })
    fileProbe = probed
    for (const w of probed.warnings) warnings.push(w)
    if (!probed.parser) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { reason: '无法识别的文件类型', filePath: fileSource.filePath, detected: probed.kind },
      })
    }
    throwIfAborted(request.signal, 'read')

    // ---- ③④ 解码与结构化提取 ----
    report('decode', 0.2, probed.parser)
    if (probed.parser === 'txt') {
      const parsed = await time('extract', () =>
        parseTxt({
          buffer,
          decoder: fileSource.decoder,
          encoding: fileSource.encoding,
          detection: fileSource.detection,
          decoders: deps.decoders,
          detectOptions: deps.sniffer ? { sniffer: deps.sniffer, decoders: deps.decoders } : { decoders: deps.decoders },
          signal: request.signal,
        }),
      )
      text = parsed.text
      encoding = parsed.encoding
      detection = parsed.detection
      warnings.push(...parsed.warnings)
    } else if (probed.parser === 'docx') {
      const parsed = await time('extract', () =>
        parseDocx({ buffer, converter: deps.docxConverter, signal: request.signal }),
      )
      text = parsed.text
      headings = parsed.headings
      // DOCX 是二进制容器：正文由 mammoth 以 Unicode 提取，落库按 UTF-8。
      // 显式标成 utf-8，避免「预览没有 encoding」在界面被读成「编码未知」。
      encoding = 'utf-8'
      warnings.push(...parsed.warnings)
      if (parsed.converterMessages.length > 0) {
        warnings.push(`DOCX 转换器返回 ${parsed.converterMessages.length} 条消息（详见日志）`)
      }
    } else if (probed.parser === 'pdf') {
      const parsed = await time('extract', () =>
        parsePdf({ buffer, extractor: deps.pdfExtractor, options: request.pdfOptions, signal: request.signal }),
      )
      text = parsed.text
      pdfQuality = parsed.quality
      // 同 DOCX：PDF 文本层由 pdfjs 以 Unicode 提取，没有「文件编码」可选
      encoding = 'utf-8'
      warnings.push(...parsed.warnings)
      if (parsed.quality.lowQuality) notices.push(resolve(new AppError('PDF_PARSE_LOW_QUALITY')))
    } else {
      // 本地 HTML 文件：复用网页正文抽取（文件没有 URL 语义，不走 SSRF/robots 流程）
      const decoded = await time('decode', () => {
        const fromHint = fileSource.encoding ? createDecoder(fileSource.encoding, deps.decoders) : null
        const hinted = fromHint ? fromHint(buffer) : null
        if (hinted !== null) return { html: hinted, encoding: fileSource.encoding ?? 'UTF-8' }
        const found = detectEncoding(buffer, { decoders: deps.decoders })
        const decoder = createDecoder(found.encoding, deps.decoders)
        const decodedText = decoder ? decoder(buffer) : null
        if (decodedText === null) {
          throw new AppError('ENCODING_DECODE_FAILED', { details: { encoding: found.encoding } })
        }
        return { html: decodedText, encoding: found.encoding }
      })
      encoding = decoded.encoding
      const extracted = extractFromHtml({
        html: stripBom(decoded.html),
        rule: null, // 本地文件没有站点规则
        extractor: deps.htmlExtractor,
      })
      text = normalizeNewlines(extracted.body)
      parsedTitle = extracted.title
      warnings.push(...extracted.warnings)
    }
  } else if (pasteSource) {
    // ---- 粘贴文本：直通（docs/10 §8.5） ----
    const parsed = await time('extract', () =>
      parsePlain({
        text: pasteSource.text,
        title: pasteSource.title ?? request.title,
        now,
        signal: request.signal,
      }),
    )
    text = parsed.text
    encoding = parsed.encoding
    // parsePlain 已经处理「用户没给书名 → 未命名作品 + 时间戳」（docs/10 §8.5）
    parsedTitle = parsed.title
    warnings.push(...parsed.warnings)
    rawByteLength = Buffer.byteLength(text, 'utf8')
  } else if (urlSource) {
    // ---- URL（docs/10 §8.4） ----
    report('decode', 0.2, 'web')
    const parsed = await time('extract', () =>
      parseWeb({
        url: urlSource.url,
        rules: [...(deps.siteRules ?? []), ...(urlSource.rules ?? [])],
        extractor: deps.htmlExtractor,
        fetchImpl: deps.fetchImpl,
        respectRobots: urlSource.respectRobots,
        followNextPage: urlSource.followNextPage,
        decoders: deps.decoders,
        signal: request.signal,
        onPage: ({ page, url: pageUrl, chars }) =>
          report('decode', Math.min(0.5, 0.2 + page * 0.02), `第 ${page} 页 ${pageUrl}（${chars} 字）`),
      }),
    )
    text = parsed.text
    encoding = parsed.encoding
    parsedTitle = parsed.title
    webPages = parsed.pages
    warnings.push(...parsed.warnings)
    rawByteLength = Buffer.byteLength(text, 'utf8')
  }
  throwIfAborted(request.signal, 'extract')
  if (text.trim().length === 0) {
    throw new AppError('ENCODING_DECODE_FAILED', { details: { reason: '解析结果为空' } })
  }

  // ---- ⑤ 清洗（docs/10 §5） ----
  report('clean', 0.55)
  const rawText = text
  const ruleSet = request.ruleSet ?? BUILTIN_RULE_SETS[0]!
  const { text: cleanedText, report: cleanReport } = await time('clean', () =>
    cleanText(rawText, {
      ...request.cleanOptions,
      // docs/10 §5.1 的「纯数字页码行」与 §6.2 的「纯数字章节标题」互相冲突：
      // 选中允许纯数字标题的规则集时自动保护纯数字行（详见 clean.ts 的说明）
      protectPureDigitLines: request.cleanOptions?.protectPureDigitLines ?? ruleSet.allowNumericOnly,
    }),
  )
  warnings.push(...cleanReport.warnings)
  if (cleanReport.removedLines.length > 0) {
    notices.push(resolve(new AppError('IMPORT_CLEAN_REMOVED_CONTENT', { params: { lines: cleanReport.removedLines.length } })))
  }
  throwIfAborted(request.signal, 'clean')

  // ---- ⑥ 分章（docs/10 §6） ----
  report('split', 0.7)
  let strategy: SplitStrategy = 'rules'
  let splitWarnings: SplitWarning[] = []
  let matchedRuleIds: string[] = []
  let candidateCount = 0
  let mergedCount = 0
  let volumes: Array<{ index: number; title: string; startOffset: number }> = []
  let drafts: ChapterDraft[] = []

  // 画本导入：章节结构由正文里的「第N章」定义 —— 跳过标题样式（标题层级可能把角色表
  // 里的文本也当标题），并使用专用分章规则集（见 CANVAS_IMPORT_RULE_SET 的说明）。
  const isCanvasImport = request.importMode === 'canvas'
  const effectiveRuleSet = isCanvasImport ? CANVAS_IMPORT_RULE_SET : ruleSet
  if (!isCanvasImport && headings.length > 0) {
    // docs/10 §8.2：DOCX 的标题样式是强章节边界，优先于正则
    drafts = splitByHeadings(cleanedText, headings, { charsPerSecond: VAD_DEFAULTS.charsPerSecond })
    if (drafts.length > 0) strategy = 'headings'
  }
  if (drafts.length === 0) {
    const detailed = await time('split', () =>
      splitChaptersDetailed(cleanedText, effectiveRuleSet, {
        fallback: request.fallback ?? 'none',
        fallbackOptions: request.fallbackOptions,
        charsPerSecond: VAD_DEFAULTS.charsPerSecond,
      }),
    )
    drafts = detailed.drafts
    strategy = detailed.strategy
    splitWarnings = detailed.warnings
    matchedRuleIds = detailed.matchedRuleIds
    candidateCount = detailed.candidateCount
    mergedCount = detailed.mergedCount
    volumes = detailed.volumes
  }
  if (drafts.length === 0) {
    // 规则被安全校验拒绝时，真正的原因是正则，而不是「没匹配到」——不要用
    // NO_CHAPTER_MATCHED 把它盖掉（docs/10 §6.5、§10）
    const unsafe = splitWarnings.find((w) => w.code === 'pattern-unsafe')
    if (unsafe) {
      throw new AppError('RULE_PATTERN_UNSAFE', {
        params: { reason: unsafe.message },
        details: { ruleId: unsafe.ruleId, ruleSetId: ruleSet.id },
      })
    }
    const invalid = splitWarnings.find((w) => w.code === 'pattern-invalid')
    if (invalid) {
      throw new AppError('RULE_PATTERN_INVALID', {
        params: { reason: invalid.message },
        details: { ruleId: invalid.ruleId, ruleSetId: ruleSet.id },
      })
    }
    // docs/10 §10：分章零结果 → 进入策略选择（不是致命错误，但必须让用户决定）
    throw new AppError('NO_CHAPTER_MATCHED', {
      details: { strategy, matchedRuleIds, ruleSetId: effectiveRuleSet.id, candidateCount },
    })
  }

  // ---- ⑦ 预览与人工干预 ----
  report('preview', 0.85)
  drafts = applyChapterEdits(drafts, request.chapters ?? [])

  // 画本模式：逐章解析成「画本行 + 角色」。放在人工干预之后 —— 被取消勾选的章节不白解析。
  // 只在**真正入库**时解析：预览（persist=false）不需要画本行，否则 IPC 载荷会翻倍；
  // 向导提交时 commitImport 会再解析一次。
  if (request.importMode === 'canvas' && request.persist !== false) {
    for (const draft of drafts) {
      draft.canvasScript = parseCanvasScript(draft.rawText, { chapterTitle: draft.title })
    }
  }

  const suspicion = inspectSplitSuspicion(drafts)
  if (suspicion.suspicious) {
    const longest = drafts.reduce((m, d) => Math.max(m, d.charCount), 0)
    notices.push(
      resolve(
        new AppError('CHAPTER_SPLIT_SUSPICIOUS', {
          params: { count: drafts.length, chars: longest },
          details: { reasons: suspicion.reasons },
        }),
      ),
    )
  }
  if (detection?.needsUserChoice) notices.push(resolve(new AppError('ENCODING_UNCERTAIN')))

  const contentHash = sha256(cleanedText)
  const includedDrafts = drafts.filter((d) => d.included)
  const totalChars = includedDrafts.reduce((s, d) => s + d.charCount, 0)
  const sourceTitle = fileSource ? (fileSource.title ?? (filePath ? baseName(filePath) : null)) : parsedTitle
  const title = request.title?.trim() || sourceTitle || null
  const author = request.author?.trim() || (fileSource?.author ?? null)

  const preview: ImportPreview = {
    sourceType,
    encoding,
    detection,
    rawText,
    cleanedText,
    cleanReport,
    chapters: drafts,
    split: { strategy, matchedRuleIds, candidateCount, mergedCount, volumes, warnings: splitWarnings },
    suspicious: suspicion.suspicious,
    totalChars,
    estimatedDurationMs: estimateDurationMs(totalChars),
    contentHash,
    byteLength: rawByteLength,
    fileProbe,
    headings,
    pdfQuality,
    webPages,
    title,
  }

  if (request.persist === false) {
    report('preview', 1)
    return { bookId: null, preview, notices, warnings, duplicate: null, timings }
  }

  // ---- ⑧ 入库（最后一步；一个事务内写 books + chapters） ----
  throwIfAborted(request.signal, 'persist')
  report('persist', 0.95)
  const policy = request.duplicatePolicy ?? 'error'
  const existing = await deps.bookRepo.findByContentHash(contentHash)
  if (existing && policy === 'open-existing') {
    report('persist', 1)
    return { bookId: existing.id, preview, notices, warnings, duplicate: { bookId: existing.id }, timings }
  }
  if (existing && policy === 'error') {
    // docs/10 §9：不做静默选择，把三选一交给 UI
    throw new AppError('DUPLICATE_BOOK', { details: { bookId: existing.id, contentHash } })
  }

  const timestamp = now()
  const bookId = newId()
  const book: Book = {
    id: bookId,
    projectId: request.projectId,
    title: (title ?? '未命名作品').slice(0, 200),
    author,
    narrator: request.narrator ?? '旁白',
    language: request.language ?? 'zh-CN',
    sourceType,
    sourcePath: filePath ?? urlSource?.url ?? null,
    encoding,
    contentHash,
    charCount: cleanedText.length,
    chapterCount: includedDrafts.length,
    coverPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  const scriptByChapterId = new Map<Id, CanvasScriptChapter>()
  const chapterPayload: ChapterWithText[] = includedDrafts.map((draft, i) => {
    const chapter = buildChapter(draft, { bookId, seq: i + 1, timestamp, newId, volumes })
    if (draft.canvasScript) scriptByChapterId.set(chapter.id, draft.canvasScript)
    return {
      chapter,
      // 章级原文：导入阶段与清洗后文本相同（全书级清洗前原文在 preview.rawText，
      // 「查看被删内容」用它）；按行回溯到原始章节属后续增强，不在这里假装能行
      rawText: draft.rawText,
      text: draft.rawText,
    }
  })

  await time('persist', () =>
    deps.withTransaction(async (tx) => {
      // 事务内再查一次，缩小竞态窗口（真实实现还应依赖 content_hash 唯一索引）
      const inTx = await tx.bookRepo.findByContentHash(contentHash)
      if (inTx && policy === 'error') {
        throw new AppError('DUPLICATE_BOOK', { details: { bookId: inTx.id, contentHash } })
      }
      await tx.bookRepo.insert(book)
      await tx.chapterRepo.insertMany(chapterPayload)
    }),
  )

  // ---- ⑧b 画本模式：把解析好的画本行与角色落库 ----
  // 章节已经建好（外键可用），一行一行写；某一章失败不影响其它章已写的内容，
  // 但**绝不静默**：异常原样上抛，由任务层记 failed。
  if (request.importMode === 'canvas' && deps.canvasImport) {
    let writtenLines = 0
    let writtenCharacters = 0
    for (const item of chapterPayload) {
      const script = scriptByChapterId.get(item.chapter.id)
      // 纯角色表（卷首总表）没有台词行，但角色要建 —— 所以两个都为空才跳过
      if (!script || (script.lines.length === 0 && script.characters.length === 0)) continue
      const written = await deps.canvasImport.writeChapter({
        bookId,
        chapterId: item.chapter.id,
        chapterTitle: item.chapter.title,
        script,
      })
      writtenLines += written.lines
      writtenCharacters += written.characters
    }
    warnings.push(`画本导入：写入 ${writtenLines} 行画本、${writtenCharacters} 个角色`)
  }

  report('persist', 1)
  return { bookId, preview, notices, warnings, duplicate: null, timings }
}

// ============================================================================
// 导出的小工具（供 UI 与测试复用）
// ============================================================================

/** 应用人工干预（改名 / 勾选；不改顺序，排序由 UI 的拖拽顺序决定） */
export function applyChapterEdits(drafts: readonly ChapterDraft[], edits: readonly ChapterEdit[]): ChapterDraft[] {
  if (edits.length === 0) return [...drafts]
  const byTempId = new Map<string, ChapterEdit>()
  const byIndex = new Map<number, ChapterEdit>()
  for (const e of edits) {
    if (e.tempId) byTempId.set(e.tempId, e)
    if (typeof e.index === 'number') byIndex.set(e.index, e)
  }
  return drafts.map((d) => {
    const edit = byTempId.get(d.tempId) ?? byIndex.get(d.index)
    if (!edit) return d
    const title = edit.title !== undefined && edit.title.trim().length > 0 ? edit.title : d.title
    return { ...d, title, included: edit.included ?? d.included }
  })
}

/** 草稿 → Chapter 实体（文本随 ChapterWithText 单独传，见 chapter.repo.ts 的契约缺口说明） */
export function buildChapter(
  draft: ChapterDraft,
  ctx: {
    bookId: Id
    seq: number
    timestamp: number
    newId: () => string
    volumes: Array<{ index: number; title: string; startOffset: number }>
  },
): Chapter {
  const volume = draft.volumeIndex !== null ? ctx.volumes.find((v) => v.index === draft.volumeIndex) : undefined
  return {
    id: ctx.newId(),
    bookId: ctx.bookId,
    seq: ctx.seq,
    title: draft.title,
    kind: draft.kind,
    volumeSeq: draft.volumeIndex,
    volumeTitle: volume?.title ?? null,
    charCount: draft.charCount,
    startOffset: draft.startOffset,
    endOffset: draft.endOffset,
    // 画本模式：章节一建好就带着画本（行数用解析结果，而不是「非空段落数」）。
    // 只有**真的解析出画本行**才标 generated；纯角色表（如卷首总表）不算画本。
    canvasState: draft.canvasScript && draft.canvasScript.lines.length > 0 ? 'generated' : 'none',
    lineCount: draft.canvasScript ? draft.canvasScript.lines.length : countNonEmptyLines(draft.rawText),
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  }
}

/** 空操作事务包装：内存仓储（测试）用；**生产必须换成真正的 SQLite 事务** */
export function createPassthroughTransaction(deps: { bookRepo: BookRepo; chapterRepo: ChapterRepo }) {
  return async <T>(fn: (tx: ImportTxContext) => Promise<T> | T): Promise<T> =>
    fn({ bookRepo: deps.bookRepo, chapterRepo: deps.chapterRepo })
}
