/**
 * 书籍导入域 · 导入向导状态（docs/10 §7 / §7.1 的 7 步状态机）
 * ============================================================================
 * 为什么要把「向导的全部中间态」放进一个 store，而不是留在组件里：
 *   docs/10 §7.1 的硬性要求是「**每一步都可后退，后退不丢已解析的数据**」。
 *   解析一次 100 MB 的 TXT 要几十秒，用户在第 5 步发现规则不对想回第 3 步改，
 *   如果状态挂在组件上（组件卸载即销毁），回去就得重解析 —— 这是不可接受的。
 *   因此：源、编码选择、清洗开关、分章规则、草稿章、勾选、人工改名/合并/删除
 *   全部驻留本 store；切步骤只改 `step` 这一个数字。
 *
 * 契约说明（重要）：
 *   · 渲染进程的 `shared/lib/ipc.ts` 只显式声明了 app:* 通道，其余通道走索引签名，
 *     因此 `call()` 的入参/返回都是 unknown。本文件据此**显式声明**用到的载荷与
 *     响应形状（唯一来源仍是 `src/shared/ipc.ts`），避免到处写 as any。
 *   · `book:previewSplit` 的契约只声明 `{ drafts, cleanReport, encoding }`，
 *     而主进程实现（`src/main/features/book/import/import.service.ts` 的
 *     `ImportPreview`）是它的**超集**（contentHash / suspicious / totalChars / title…）。
 *     这里按可选字段读取：有就用，没有就降级，绝不自己算哈希（docs/10 §9 明确
 *     哈希由后端给出，渲染进程不得自行 sha256）。
 *
 * 内部纪律：
 *   · 本 store 只做「状态 + IPC 数据获取 + 纯本地草稿变换」；
 *     流程编排（步骤守卫、防抖重算预览、去重三选一、任务通道）在
 *     `composables/useImportFlow.ts`。
 *   · 所有耗时操作都通过 `call()`（错误由 error-bus 兑现，docs/22 §6.2）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { AppError } from '@shared/errors.ts'
import { BUILTIN_RULE_SETS, ENCODING_CANDIDATES, IMPORT_LIMITS, VAD_DEFAULTS } from '@shared/constants.ts'
import type {
  BookSourceType,
  ChapterDraft,
  ChapterKind,
  ChapterRule,
  ChapterRuleSet,
  CleanReport,
  EncodingDetection,
  ImportFileProbe,
} from '@shared/types.ts'
import type { CleanOptions, CleanReportDetail } from '@shared/text/clean.ts'

// ============================================================================
// 对外类型
// ============================================================================

/** 向导步骤（docs/10 §7.1） */
export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** 来源形态（与 BookSourceType 不同：docx/pdf/txt 都归 'file'） */
export type SourceMode = 'file' | 'paste' | 'url'

export interface WizardStepDef {
  step: WizardStep
  title: string
  /** 步骤条上的短提示（说明这一步在干什么、什么时候可以跳过） */
  tip: string
}

/** docs/10 §7.1 的七步定义（视图的步骤条与「下一步为什么禁用」都读它） */
export const WIZARD_STEPS: WizardStepDef[] = [
  { step: 1, title: '选择来源', tip: '文件 / 粘贴文本 / URL，支持把文件拖进窗口' },
  { step: 2, title: '解析与编码确认', tip: '确认编码与解析结果；失败时停在这里等你处理' },
  { step: 3, title: '分章规则', tip: '勾选内置规则或写自定义正则，实时看「切出 N 章」' },
  { step: 4, title: '清洗报告', tip: '清洗删了什么必须看得见，可逐项关闭或查看被删内容' },
  { step: 5, title: '章节列表', tip: '改名 / 合并 / 拆分 / 排序 / 勾选，右侧抽屉预览正文' },
  { step: 6, title: '确认导入', tip: '书名、作者、封面、去重检查' },
  { step: 7, title: '完成', tip: '进度 → 结果摘要 → 进入章节列表或生成画本' },
]

/**
 * 清洗开关的可下发给主进程的键（键名以 src/shared/text/clean.ts 的 CleanOptions 为准）。
 *
 * 显式 `.filter()` 掉 `undefined` 是**必须**的：映射类型在 vue-tsc 的 SFC 编译环境下
 * 会被放宽，`CleanOptions[K]` 可能被解析成 `boolean | undefined` 之外的宽松形态，
 * 于是下标结果退化成 `string | undefined`，`Record<CleanOptionKey, boolean>` 直接报
 * TS2344「Type 'string | undefined' does not satisfy the constraint」。
 * 过滤后类型被钉死为字面量联合，不再随上下文漂移。
 */
export type CleanOptionKey = ({
  [K in keyof CleanOptions]: CleanOptions[K] extends boolean | undefined ? K : never
}[keyof CleanOptions]) & string

export interface CleanOptionDef {
  key: CleanOptionKey
  label: string
  hint: string
  /** true = docs/10 §5.2 的「谨慎处理」（默认关闭，开启需明确确认） */
  caution: boolean
}

/**
 * 清洗开关清单。
 * 必须先清洗（docs/10 §5.1，默认全开）＋ 谨慎处理（§5.2，默认关闭）。
 * `protectPureDigitLines` 不是清洗项而是**规则冲突的补丁**：
 * §5.1 的「去页码行」会把 §6.2 `cn-loose` 的纯数字章节标题一起删掉，
 * 因此选定允许纯数字标题的规则集时必须打开它（见 import.service.ts 的同名注释）。
 */
export const CLEAN_OPTION_DEFS: CleanOptionDef[] = [
  { key: 'removeAdLines', label: '站点广告行', hint: '命中「请记住本站 / 最新章节」等关键词的行', caution: false },
  { key: 'removeNavLines', label: '页尾导航行', hint: '上一章 / 目录 / 下一章 组合行', caution: false },
  { key: 'removeUrlWatermark', label: '网址水印', hint: '行内 URL 且整行较短', caution: false },
  { key: 'removeDuplicateLines', label: '重复行（±5 行窗口）', hint: '分页导致的重复段落', caution: false },
  { key: 'removePageNumberLines', label: '页码行', hint: '第 12 页 / - 12 - / 纯数字行', caution: false },
  { key: 'removeZeroWidth', label: '零宽与双向控制字符', hint: 'U+200B~U+200F、U+202A~U+202E、U+FEFF（非首位）', caution: false },
  { key: 'normalizeFullWidthSpace', label: '全角空格归一', hint: 'U+3000 → 空格，并压缩连续空格', caution: false },
  { key: 'normalizeNbsp', label: '不换行空格归一', hint: '&nbsp; 与 U+00A0 → 空格', caution: false },
  { key: 'collapseBlankLines', label: '多余空行压缩', hint: '连续 3 个以上换行压成 2 个', caution: false },
  { key: 'trimLines', label: '行首尾空白', hint: '每行 trim()', caution: false },
  { key: 'removeNonAdjacentDuplicates', label: '非相邻重复行去重', hint: '可能误删作者有意重复的排比句', caution: true },
  { key: 'mergeHardWrappedLines', label: '合并硬换行段落', hint: '可能把本该独立成行的对白合起来', caution: true },
  { key: 'removeBracketContent', label: '去除括号内容', hint: '会删掉作者注释与音效提示', caution: true },
  { key: 'traditionalToSimplified', label: '繁简转换', hint: '改变原文；主进程未注入转换器时会被跳过并告警', caution: true },
]

/** 无匹配时的备选分章策略（docs/10 §6.4） */
export type FallbackStrategy = 'none' | 'blank-blocks' | 'length' | 'single' | 'auto'

export const FALLBACK_LABELS: Array<{ value: FallbackStrategy; label: string; hint: string }> = [
  { value: 'none', label: '不使用（继续调规则）', hint: '保持 0 章结果，直到规则能匹配上' },
  { value: 'blank-blocks', label: '按空行分块', hint: '在连续空行处切分，块太短则与相邻合并' },
  { value: 'length', label: '按长度均分', hint: '每约 3000 字在最近的句末标点处切一刀' },
  { value: 'single', label: '整本一章', hint: '适用于短篇；标题自动生成' },
  { value: 'auto', label: '自动选择', hint: '由主进程判断（有稳定空行结构则按空行，否则按长度）' },
]

export interface BookMetaDraft {
  title: string
  author: string
  narrator: string
  language: string
  coverPath: string | null
}

export interface DuplicateHit {
  bookId: string | null
}

export interface ImportOutcome {
  bookId: string | null
  chapterCount: number
  /** 走任务通道时的任务 id（无则为 null） */
  taskId: string | null
  elapsedMs: number
}

/** 「已删除草稿」抽屉用的记录（docs/10 §7.1 允许删除，但必须能恢复） */
export interface RemovedDraftRecord {
  draft: ChapterDraft
  /** 删除前在列表中的位置，恢复时插回原处 */
  at: number
}

// ---------------------------------------------------------------------------
// 载荷/响应形状（唯一来源 src/shared/ipc.ts；见文件头「契约说明」）
// ---------------------------------------------------------------------------

interface PreviewSplitPayload {
  filePath?: string
  text?: string
  ruleSetId?: string | null
  cleanOptions?: Record<string, boolean>
}

interface PreviewSplitResult {
  drafts: ChapterDraft[]
  cleanReport: CleanReport
  encoding: string
  // ---- 以下为主进程实现的超集字段（缺失时降级，不报错） ----
  contentHash?: string
  suspicious?: boolean
  totalChars?: number
  title?: string | null
  byteLength?: number
  split?: {
    strategy?: string
    matchedRuleIds?: string[]
    candidateCount?: number
    mergedCount?: number
    warnings?: Array<{ code: string; message: string }>
  }
}

interface CommitImportPayload {
  projectId: string
  bookMeta: { title: string; author?: string | null; narrator?: string; language?: string; coverPath?: string | null }
  source: { type: BookSourceType; path?: string | null; encoding?: string | null; contentHash: string }
  drafts: ChapterDraft[]
}

interface CommitImportResult {
  bookId: string
  chapterCount: number
}

// ============================================================================
// 纯函数工具（可被视图/组件复用）
// ============================================================================

/** 朗读语速（字/秒）→ 估算时长；默认用 VAD_DEFAULTS.charsPerSecond = 4.2（docs/10 §6.6） */
export function estimateDurationMs(charCount: number, charsPerSecond: number = VAD_DEFAULTS.charsPerSecond): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0
  const rate = Number.isFinite(charsPerSecond) && charsPerSecond > 0 ? charsPerSecond : VAD_DEFAULTS.charsPerSecond
  return Math.round((charCount / rate) * 1000)
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }

/** 中文数字 → 数值（支持「十二」「二十三」「一千零二十」「两」） */
function parseChineseNumber(text: string): number | null {
  if (!text) return null
  let total = 0
  let section = 0
  let digit = 0
  let seen = false
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]!
      seen = true
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch]!
      seen = true
      if (unit === 10000) {
        section = (section + (digit || 0)) * unit
        total += section
        section = 0
      } else {
        section += (digit || 1) * unit
      }
      digit = 0
    } else {
      return null
    }
  }
  if (!seen) return null
  return total + section + digit
}

/**
 * 从章标题里抽出章节号（docs/10 §7.1「章节号规范化：识别一二三 / 123 / 零一二」）。
 * 识别不出返回 null（调用方按「无号」排到末尾，绝不猜）。
 */
export function extractChapterNumber(title: string): number | null {
  if (!title) return null
  // 先看阿拉伯数字（第 12 章 / 12 / 012）
  const ascii = /(\d{1,6})/.exec(title)
  if (ascii) {
    const n = Number(ascii[1])
    if (Number.isFinite(n)) return n
  }
  // 再看中文数字：取「第…章」之间，或去掉「第/章/回/节/卷」后的连续中文数字
  const bracket = /第\s*([零〇一二三四五六七八九十百千万两]+)\s*[章节回卷部篇]/.exec(title)
  if (bracket) {
    const n = parseChineseNumber(bracket[1]!)
    if (n !== null) return n
  }
  const plain = /([零〇一二三四五六七八九十百千万两]{1,10})/.exec(title)
  if (plain) return parseChineseNumber(plain[1]!)
  return null
}

/** 简易 id（crypto.randomUUID 在部分上下文不可用，必须有回退） */
export function createLocalId(prefix: string): string {
  const cryptoObj = globalThis.crypto
  const uuid = typeof cryptoObj?.randomUUID === 'function'
    ? cryptoObj.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}_${uuid.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`
}

const KIND_ORDER: Record<ChapterKind, number> = { front: 0, volume: 1, chapter: 2, extra: 3, back: 4 }

/** 按「章号 → 类型 → 原标题」排序（regex 切出来的顺序可能是乱的，docs/10 §7.1） */
export function compareDraftByTitleNumber(a: ChapterDraft, b: ChapterDraft): number {
  const na = extractChapterNumber(a.title)
  const nb = extractChapterNumber(b.title)
  if (na !== null && nb !== null && na !== nb) return na - nb
  if (na === null && nb !== null) return 1
  if (na !== null && nb === null) return -1
  if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  return a.title.localeCompare(b.title, 'zh-Hans-CN')
}

/** 句末标点（本地备选分章的切点判断，与 src/shared/text/chapter-split.ts 口径一致） */
const SENTENCE_END_RE = /[。！？…；!?;][”’」』】）)]?/

/**
 * 本地备选分章（docs/10 §6.4），**仅用于「粘贴文本」来源**。
 *
 * 为什么要有这一份：`book:previewSplit` 的载荷里没有 fallback 参数，
 * 而权威实现在主进程（`src/shared/text/chapter-split.ts`，它 import 了 node:perf_hooks，
 * 渲染进程不可用）。粘贴文本的正文就在手边，因此本策略在渲染侧实现，
 * 让「切换策略立刻看结果」这条要求对粘贴来源真正成立；
 * 文件来源没有正文可切，只能把策略存下来交给导入任务执行。
 */
export function splitTextLocally(
  text: string,
  strategy: Exclude<FallbackStrategy, 'none'>,
  opts: { titlePrefix?: string; charsPerChunk?: number; minBlockChars?: number } = {},
): ChapterDraft[] {
  const source = (text ?? '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return []

  const prefix = opts.titlePrefix ?? '第{n}部分'
  const makeDraft = (index: number, title: string, raw: string, start: number): ChapterDraft => {
    const trimmed = raw.trim()
    return {
      tempId: createLocalId('draft'),
      index,
      title,
      rawText: trimmed,
      charCount: trimmed.length,
      estimatedDurationMs: estimateDurationMs(trimmed.length),
      kind: 'chapter',
      volumeIndex: null,
      startOffset: start,
      endOffset: start + raw.length,
      included: true,
    }
  }

  if (strategy === 'single') {
    return [makeDraft(0, prefix.replace('{n}', '1'), source, 0)]
  }

  const blocks: Array<{ text: string; start: number }> = []
  if (strategy === 'blank-blocks') {
    const minBlock = opts.minBlockChars ?? 100
    const re = /\n{2,}/g
    let cursor = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      blocks.push({ text: source.slice(cursor, m.index), start: cursor })
      cursor = m.index + m[0].length
    }
    blocks.push({ text: source.slice(cursor), start: cursor })
    // 块太短 → 与相邻块合并（docs/10 §6.4）
    const merged: Array<{ text: string; start: number }> = []
    for (const block of blocks) {
      const prev = merged[merged.length - 1]
      if (prev && (prev.text.trim().length < minBlock || block.text.trim().length < minBlock)) {
        prev.text = `${prev.text}\n\n${block.text}`
      } else {
        merged.push({ ...block })
      }
    }
    const filtered = merged.filter(b => b.text.trim().length > 0)
    return filtered.map((b, i) => makeDraft(i, prefix.replace('{n}', String(i + 1)), b.text, b.start))
  }

  // 按长度均分：在目标位置之后最近的句末标点处切（找不到就硬切）
  const chunk = Math.max(200, opts.charsPerChunk ?? 3000)
  let start = 0
  let index = 0
  while (start < source.length) {
    let end = Math.min(source.length, start + chunk)
    if (end < source.length) {
      const tail = source.slice(end, Math.min(source.length, end + 300))
      const hit = SENTENCE_END_RE.exec(tail)
      if (hit) end += hit.index + hit[0].length
    }
    const piece = source.slice(start, end)
    if (piece.trim()) {
      blocks.push({ text: piece, start })
      index++
    }
    start = end
  }
  return blocks.map((b, i) => makeDraft(i, prefix.replace('{n}', String(i + 1)), b.text, b.start))
}

/** 从主进程返回的 cleanReport 里取「超集」详情（缺失返回 null，不猜） */
function asCleanReportDetail(report: CleanReport | null): CleanReportDetail | null {
  if (!report) return null
  const candidate = report as Partial<CleanReportDetail>
  return Array.isArray(candidate.removedLines) ? (candidate as CleanReportDetail) : null
}

// ============================================================================
// Store
// ============================================================================

export const useImportStore = defineStore('book/import', () => {
  // ---- 步骤 ----
  const step = ref<WizardStep>(1)
  /** 已完成过一次解析（用于「上一步不丢数据」的提示与步骤条状态） */
  const parsedOnce = ref(false)

  // ---- Step 1 来源 ----
  const mode = ref<SourceMode>('file')
  const filePath = ref<string | null>(null)
  const fileName = ref('')
  const probe = ref<ImportFileProbe | null>(null)
  const pasteText = ref('')
  const url = ref('')

  // ---- Step 2 编码与解析 ----
  const detection = ref<EncodingDetection | null>(null)
  const selectedEncoding = ref('')
  const drafts = ref<ChapterDraft[]>([])
  const cleanReport = ref<CleanReport | null>(null)
  const cleanReportDetail = ref<CleanReportDetail | null>(null)
  const parsedEncoding = ref('')
  const contentHash = ref('')
  const suspiciousSplit = ref(false)
  const splitWarnings = ref<string[]>([])
  const totalChars = ref(0)
  const parsedTitle = ref('')
  const previewBusy = ref(false)
  const previewError = ref<{ key: string; message: string } | null>(null)
  const detectBusy = ref(false)

  // ---- Step 3 分章规则 ----
  const ruleSets = ref<ChapterRuleSet[]>([])
  const activeRuleSetId = ref<string>(BUILTIN_RULE_SETS[0]?.id ?? 'builtin:cn-standard')
  /** 可编辑副本（内置集只读，改动会派生出 builtin=false 的副本） */
  const ruleSetDraft = ref<ChapterRuleSet | null>(null)
  /** 被用户取消勾选的规则 id（契约的 ChapterRule 没有 enabled 字段，因此单独记） */
  const disabledPatternIds = ref<string[]>([])
  /** 已落库到主进程的规则集 id（previewSplit 只接受 id，所以改动必须先保存） */
  const persistedRuleSetId = ref<string | null>(null)
  const ruleSetDirty = ref(false)
  const ruleSetNotice = ref('')
  const ruleSetsLoaded = ref(false)
  const fallbackStrategy = ref<FallbackStrategy>('none')

  // ---- Step 4 清洗 ----
  const cleanOptions = ref<Record<CleanOptionKey, boolean>>(buildDefaultCleanOptions())

  // ---- Step 5 人工干预 ----
  const removedDrafts = ref<RemovedDraftRecord[]>([])
  const previewDraftId = ref<string | null>(null)
  /** 用户是否动过草稿（改名/合并/拆分/删除/排序/勾选）：决定提交走哪条通道 */
  const draftsEdited = ref(false)

  // ---- Step 6 确认 ----
  const bookMeta = ref<BookMetaDraft>({ title: '', author: '', narrator: '', language: 'zh-CN', coverPath: null })
  const duplicate = ref<DuplicateHit | null>(null)
  const duplicateChecked = ref(false)
  const duplicateAcknowledged = ref(false)
  const projectId = ref<string | null>(null)
  const projectHint = ref('')
  const committing = ref(false)

  // ---- Step 7 结果 ----
  const outcome = ref<ImportOutcome | null>(null)
  const taskId = ref<string | null>(null)
  const commitError = ref<{ key: string; message: string } | null>(null)
  /** 最近一次失败的原样错误（供 composable 交给 error-bus 兑现并附重试回调） */
  const lastError = ref<unknown>(null)
  /** 成功后要跳转的目标书籍（Step7 的「进入章节列表」用它） */
  const sessionBookIdHint = ref<string | null>(null)

  function buildDefaultCleanOptions(): Record<CleanOptionKey, boolean> {
    const out = {} as Record<CleanOptionKey, boolean>
    for (const def of CLEAN_OPTION_DEFS) out[def.key] = !def.caution
    return out
  }

  // ---------------------------------------------------------------------------
  // 派生状态
  // ---------------------------------------------------------------------------

  const stepDef = computed(() => WIZARD_STEPS.find(s => s.step === step.value) ?? WIZARD_STEPS[0]!)

  /**
   * 该来源能否走「解析预览」。
   * `book:previewSplit` 只接受 filePath / text，**没有 URL 入参**，
   * 因此 URL 来源无法预览（契约缺口）：步骤 2~5 直接跳过，靠任务通道导入。
   */
  const canPreview = computed(() => mode.value === 'file' || mode.value === 'paste')

  /** 有正文在手（粘贴来源才能本地做备选分章） */
  const hasLocalText = computed(() => mode.value === 'paste' && pasteText.value.trim().length > 0)

  const sourceType = computed<BookSourceType>(() => {
    if (mode.value === 'paste') return 'paste'
    if (mode.value === 'url') return 'url'
    const ext = fileName.value.toLowerCase().split('.').pop() ?? ''
    if (ext === 'docx') return 'docx'
    if (ext === 'pdf') return 'pdf'
    return 'txt'
  })

  /** 有效规则集（去掉被取消勾选的规则） */
  const effectiveRuleSet = computed<ChapterRuleSet | null>(() => {
    const set = ruleSetDraft.value
    if (!set) return null
    const disabled = new Set(disabledPatternIds.value)
    return { ...set, patterns: set.patterns.filter(p => !disabled.has(p.id)) }
  })

  const ruleSetPreviewError = computed(() => validateRuleSetPatterns(effectiveRuleSet.value))

  const includedDrafts = computed(() => drafts.value.filter(d => d.included))
  const includedCount = computed(() => includedDrafts.value.length)
  const totalDraftChars = computed(() => drafts.value.reduce((sum, d) => sum + d.charCount, 0))
  const includedChars = computed(() => includedDrafts.value.reduce((sum, d) => sum + d.charCount, 0))
  const includedDurationMs = computed(() => includedDrafts.value.reduce((sum, d) => sum + d.estimatedDurationMs, 0))
  const removedDraftCount = computed(() => removedDrafts.value.length)

  /** 单章异常长（docs/10 §6.3 CHAPTER_SPLIT_SUSPICIOUS 的启发式） */
  const longestDraft = computed(() => drafts.value.reduce<ChapterDraft | null>(
    (max, d) => (!max || d.charCount > max.charCount ? d : max),
    null,
  ))

  const needsUserEncodingChoice = computed(() => {
    const d = detection.value
    if (!d) return false
    return d.needsUserChoice || d.confidence < 0.7
  })

  /** 编码被用户改过（与主进程解析结果不一致时要在 UI 说明，别让用户以为是生效了） */
  const encodingDiffersFromParsed = computed(
    () => !!selectedEncoding.value && !!parsedEncoding.value && selectedEncoding.value !== parsedEncoding.value,
  )

  /** 文件大小上限（优先用设置里的值：settings.import.maxFileSizeBytes，失败回退常量） */
  const maxFileSizeBytes = ref(IMPORT_LIMITS.maxFileSizeBytes)
  const fileTooLarge = computed(() => {
    const size = probe.value?.sizeBytes ?? 0
    return size > 0 && size > maxFileSizeBytes.value
  })

  const canCommit = computed(() => {
    if (committing.value) return false
    if (!bookMeta.value.title.trim()) return false
    // 缺少项目上下文时**必须**判为不能提交，与上面的 blockReason（第 6 步）保持一致。
    // 原来漏了这一条，于是按钮可点、`buildCommitPayload()` 却返回 null，
    // 最终只报一句与事实不符的「后台任务执行失败」（真机事故 docs/91 §5.2.4）。
    if (!projectId.value) return false
    if (!canPreview.value) return true
    return includedCount.value > 0 || fallbackStrategy.value !== 'none'
  })

  // ---------------------------------------------------------------------------
  // 步骤
  // ---------------------------------------------------------------------------

  function goTo(next: WizardStep): void {
    // 只改 step：草稿、编码选择、清洗开关、规则与勾选全部留在 store（docs/10 §7.1）
    step.value = next
  }

  /** 当前步未完成必填项的原因（返回 null 表示可以往下走）——绝不静默禁用按钮 */
  const blockReason = computed<string | null>(() => {
    switch (step.value) {
      case 1:
        if (mode.value === 'file' && !filePath.value) return '还没有选择文件：点「选择文件」或把文件拖进虚线框'
        if (mode.value === 'paste' && pasteText.value.trim().length === 0) return '粘贴文本为空：把小说正文粘贴到文本框'
        if (mode.value === 'url' && !/^https?:\/\//i.test(url.value.trim())) return '请填写以 http:// 或 https:// 开头的网页地址'
        if (mode.value === 'file' && fileTooLarge.value) return '文件超过大小上限，请调整「设置 → 导入」的上限或换一个小文件'
        return null
      case 2:
        if (!canPreview.value) return '该来源不支持解析预览，将直接进入确认导入'
        if (previewBusy.value) return '正在解析，请稍候（大文件可能需要几十秒）'
        if (!drafts.value.length) return '还没有可用的解析结果，请先完成解析'
        if (!selectedEncoding.value) return '编码识别不确定，请在上方选择一种编码'
        return null
      case 3:
        if (ruleSetPreviewError.value) return ruleSetPreviewError.value
        if (fallbackStrategy.value === 'none' && !drafts.value.length) {
          return '当前规则切不出任何章节：请调整规则，或选择一种备选分章方式'
        }
        return null
      case 4:
        if (previewBusy.value) return '正在按新的清洗开关重算，请稍候'
        return null
      case 5:
        if (!drafts.value.length && fallbackStrategy.value === 'none') return '章节列表为空，请回到第 3 步调整规则'
        if (!includedCount.value && drafts.value.length > 0) return '一章都没勾选：至少勾选一章再继续'
        return null
      case 6:
        if (!bookMeta.value.title.trim()) return '请填写书名'
        if (!projectId.value) return '缺少项目上下文：请先在书架选择一本书，或确认「设置 → 路径」里的项目根目录可用'
        if (duplicate.value && !duplicateAcknowledged.value) return '检测到可能重复的书籍，请选择「打开已有书籍」/「作为副本导入」/「取消」'
        if (!canCommit.value) return '当前条件还不足以导入'
        return null
      default:
        return null
    }
  })

  const canGoNext = computed(() => blockReason.value === null && step.value < 7)
  const canGoPrev = computed(() => step.value > 1)

  // ---------------------------------------------------------------------------
  // Step 1：来源
  // ---------------------------------------------------------------------------

  function setMode(next: SourceMode): void {
    mode.value = next
    // 换来源形态不丢别的来源已填的内容（用户来回切不会白填）
    if (next !== 'file') probe.value = null
  }

  function setFilePath(path: string, nextProbe: ImportFileProbe | null = null): void {
    filePath.value = path
    fileName.value = path.split(/[\\/]/).pop() ?? path
    probe.value = nextProbe
    // 换文件后旧的解析结果一律作废（否则会把上一本书的草稿带进新书）
    invalidateParse()
  }

  function setPasteText(text: string): void {
    pasteText.value = text
    if (drafts.value.length) invalidateParse()
  }

  function setUrl(next: string): void {
    url.value = next
  }

  function invalidateParse(): void {
    drafts.value = []
    cleanReport.value = null
    cleanReportDetail.value = null
    detection.value = null
    selectedEncoding.value = ''
    parsedEncoding.value = ''
    contentHash.value = ''
    removedDrafts.value = []
    parsedOnce.value = false
    previewError.value = null
    duplicate.value = null
    duplicateChecked.value = false
    duplicateAcknowledged.value = false
    if (step.value > 1 && step.value < 7) step.value = 1
  }

  async function runProbe(): Promise<ImportFileProbe | null> {
    if (!filePath.value) return null
    try {
      const result = await call('book:probeFile', { filePath: filePath.value }) as ImportFileProbe
      probe.value = result
      return result
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2：编码与解析
  // ---------------------------------------------------------------------------

  async function detectEncoding(): Promise<EncodingDetection | null> {
    if (!filePath.value) {
      detection.value = null
      return null
    }
    detectBusy.value = true
    try {
      const result = await call('book:detectEncoding', { filePath: filePath.value }) as EncodingDetection
      detection.value = result
      selectedEncoding.value = result.encoding
      return result
    } catch {
      detection.value = null
      return null
    } finally {
      detectBusy.value = false
    }
  }

  /**
   * 用户选定编码。
   * ⚠️ 契约缺口：`book:previewSplit` 的载荷没有 encoding 字段（docs/10 §4.3 要求
   * 「点选即重新解码」），而主进程 schema 对未声明字段是 strip，传了也无效。
   * 因此这里只记录选择：它会写进 `book:commitImport` 的 `source.encoding` 元数据，
   * 界面同时明确提示「主进程仍按嗅探结果解码」，不给用户假象。
   */
  function selectEncoding(encoding: string): void {
    selectedEncoding.value = encoding
  }

  /** 预览用载荷：previewSplit 只接受 filePath / text / ruleSetId / cleanOptions */
  function buildPreviewPayload(ruleSetId: string | null): PreviewSplitPayload {
    const payload: PreviewSplitPayload = {
      ruleSetId,
      cleanOptions: { ...cleanOptions.value },
    }
    if (mode.value === 'file' && filePath.value) payload.filePath = filePath.value
    else payload.text = pasteText.value
    return payload
  }

  /**
   * 解析预览（docs/10 §3 的 ⑤⑥⑦）。
   * 这是整个向导唯一的重计算入口：改规则、改清洗开关、换编码后都重跑它。
   * 失败时**保留已有草稿**并把错误留在 previewError，由 Step2/3 显示原因。
   */
  async function runPreview(): Promise<boolean> {
    if (!canPreview.value) {
      previewError.value = {
        key: 'PREVIEW_UNSUPPORTED_SOURCE',
        message: 'URL 来源没有解析预览通道（book:previewSplit 不接受 url），将直接按选定规则导入。',
      }
      return false
    }

    previewBusy.value = true
    try {
      const ruleSetId = await ensureRuleSetPersisted()
      const result = await call(
        'book:previewSplit',
        buildPreviewPayload(ruleSetId),
        { onError: 'silent' },
      ) as PreviewSplitResult

      applyPreviewResult(result)
      parsedOnce.value = true
      previewError.value = null
      return true
    } catch (error) {
      handlePreviewFailure(error)
      return false
    } finally {
      previewBusy.value = false
    }
  }

  function applyPreviewResult(result: PreviewSplitResult): void {
    drafts.value = Array.isArray(result.drafts) ? result.drafts.map(normalizeDraft) : []
    cleanReport.value = result.cleanReport ?? null
    cleanReportDetail.value = asCleanReportDetail(result.cleanReport ?? null)
    parsedEncoding.value = result.encoding ?? ''
    if (result.encoding && !selectedEncoding.value) selectedEncoding.value = result.encoding
    // 哈希由后端给出（docs/10 §9）；契约没有该字段时留空，界面明确说明「跳过去重检查」
    contentHash.value = typeof result.contentHash === 'string' ? result.contentHash : ''
    suspiciousSplit.value = result.suspicious === true
    suspiciousSplit.value = suspiciousSplit.value || needsSuspiciousHeuristic(drafts.value)
    totalChars.value = typeof result.totalChars === 'number'
      ? result.totalChars
      : drafts.value.reduce((sum, d) => sum + d.charCount, 0)
    parsedTitle.value = result.title ?? ''
    splitWarnings.value = (result.split?.warnings ?? []).map(w => w.message).filter(Boolean)
    removedDrafts.value = []
    // 重新解析 = 人工干预作废（旧草稿已整体替换），标记也要跟着清
    draftsEdited.value = false
    if (!bookMeta.value.title.trim() && parsedTitle.value) bookMeta.value.title = parsedTitle.value
  }

  /** 章数异常少 / 单章异常长 → 提示检查规则（docs/10 §10 CHAPTER_SPLIT_SUSPICIOUS） */
  function needsSuspiciousHeuristic(list: ChapterDraft[]): boolean {
    if (!list.length) return false
    const longest = list.reduce((max, d) => Math.max(max, d.charCount), 0)
    return list.length <= 2 && longest > 200_000
  }

  function normalizeDraft(draft: ChapterDraft): ChapterDraft {
    return {
      ...draft,
      tempId: draft.tempId || createLocalId('draft'),
      included: draft.included !== false,
      charCount: Number.isFinite(draft.charCount) ? draft.charCount : (draft.rawText ?? '').length,
      estimatedDurationMs: Number.isFinite(draft.estimatedDurationMs) && draft.estimatedDurationMs > 0
        ? draft.estimatedDurationMs
        : estimateDurationMs(draft.charCount ?? (draft.rawText ?? '').length),
    }
  }

  function handlePreviewFailure(error: unknown): void {
    const key = typeof (error as { key?: unknown })?.key === 'string' ? String((error as { key: string }).key) : 'UNKNOWN'
    const message = typeof (error as { message?: unknown })?.message === 'string'
      ? String((error as { message: string }).message)
      : '解析失败'
    previewError.value = { key, message }
    if (key === 'NO_CHAPTER_MATCHED') {
      // docs/10 §10：这不是失败而是「请选择分章方式」——给用户一个可选的备选策略
      if (hasLocalText.value && fallbackStrategy.value === 'none') fallbackStrategy.value = 'blank-blocks'
    }
  }

  /** 用本地备选策略切草稿（仅粘贴来源；见 splitTextLocally 的注释） */
  function applyLocalFallback(strategy: Exclude<FallbackStrategy, 'none'> = 'blank-blocks'): boolean {
    if (!hasLocalText.value) return false
    const local = splitTextLocally(pasteText.value, strategy, {
      charsPerChunk: 3000,
      minBlockChars: 100,
    })
    if (!local.length) return false
    drafts.value = local
    cleanReport.value = cleanReport.value ?? {
      removedAdLines: 0,
      removedDuplicateLines: 0,
      removedPageNumberLines: 0,
      removedZeroWidthChars: 0,
      normalizedNewlines: 0,
      suspiciousLines: [],
      remainingChars: local.reduce((sum, d) => sum + d.charCount, 0),
    }
    totalChars.value = drafts.value.reduce((sum, d) => sum + d.charCount, 0)
    removedDrafts.value = []
    previewError.value = null
    parsedOnce.value = true
    return true
  }

  // ---------------------------------------------------------------------------
  // Step 3：分章规则
  // ---------------------------------------------------------------------------

  async function loadRuleSets(): Promise<ChapterRuleSet[]> {
    const loaded = await callSafe('book:ruleSets', undefined)
    const list = Array.isArray(loaded) && loaded.length ? loaded : BUILTIN_RULE_SETS
    ruleSets.value = list
    ruleSetsLoaded.value = true
    const current = list.find(s => s.id === activeRuleSetId.value) ?? list[0]
    if (current) selectRuleSet(current.id)
    return list
  }

  function selectRuleSet(id: string): void {
    const set = ruleSets.value.find(s => s.id === id)
    if (!set) return
    activeRuleSetId.value = id
    // 编辑副本：内置集在保存时会被派生为自定义副本，原内置集永不被改写（docs/10 §6.2）
    ruleSetDraft.value = { ...set, patterns: set.patterns.map(p => ({ ...p })) }
    disabledPatternIds.value = []
    persistedRuleSetId.value = set.builtin ? null : set.id
    ruleSetDirty.value = false
    ruleSetNotice.value = ''
  }

  function markRuleSetDirty(): void {
    ruleSetDirty.value = true
    persistedRuleSetId.value = null
  }

  /** 取消/恢复某条规则的勾选（ChapterRule 没有 enabled 字段，因此单独维护禁用表） */
  function togglePatternEnabled(ruleId: string): void {
    const disabled = new Set(disabledPatternIds.value)
    if (disabled.has(ruleId)) disabled.delete(ruleId)
    else disabled.add(ruleId)
    disabledPatternIds.value = [...disabled]
    markRuleSetDirty()
  }

  /** 更新某条规则（内置集只读 → 自动派生自定义副本） */
  function updatePattern(ruleId: string, patch: Partial<ChapterRule>): void {
    const editable = ensureEditableSet('修改规则内容')
    if (!editable) return
    ruleSetDraft.value = {
      ...editable,
      patterns: editable.patterns.map(p => (p.id === ruleId ? { ...p, ...patch } : p)),
    }
    markRuleSetDirty()
  }

  function addPattern(pattern?: Partial<ChapterRule>): ChapterRule {
    const editable = ensureEditableSet('新增自定义正则')
    const created: ChapterRule = {
      id: pattern?.id ?? createLocalId('rule'),
      linePattern: pattern?.linePattern ?? '第[零一二三四五六七八九十百千万两0-9]+章.*',
      maxLineLength: pattern?.maxLineLength ?? 40,
      requireBlankAround: pattern?.requireBlankAround ?? false,
      titleGroup: pattern?.titleGroup ?? 0,
      kind: pattern?.kind ?? 'chapter',
    }
    if (editable) {
      ruleSetDraft.value = { ...editable, patterns: [...editable.patterns, created] }
      markRuleSetDirty()
    }
    return created
  }

  function removePattern(ruleId: string): void {
    const editable = ensureEditableSet('删除规则')
    if (!editable) return
    ruleSetDraft.value = { ...editable, patterns: editable.patterns.filter(p => p.id !== ruleId) }
    disabledPatternIds.value = disabledPatternIds.value.filter(id => id !== ruleId)
    markRuleSetDirty()
  }

  function setAllowNumericOnly(value: boolean): void {
    const editable = ensureEditableSet('切换「允许纯数字标题」')
    if (!editable) return
    ruleSetDraft.value = { ...editable, allowNumericOnly: value }
    // 纯数字标题与「去页码行」天然冲突（docs/10 §5.1 vs §6.2），这里联动保护
    cleanOptions.value = { ...cleanOptions.value, protectPureDigitLines: value }
    markRuleSetDirty()
  }

  function renameRuleSet(name: string): void {
    const editable = ensureEditableSet('重命名规则集')
    if (!editable) return
    ruleSetDraft.value = { ...editable, name }
    markRuleSetDirty()
  }

  /** 内置集禁改：任何修改都派生成 builtin=false 的副本 */
  function ensureEditableSet(reason: string): ChapterRuleSet | null {
    const current = ruleSetDraft.value
    if (!current) return null
    if (!current.builtin) return current
    const forked: ChapterRuleSet = {
      ...current,
      id: createLocalId('custom'),
      name: `${current.name}·自定义`,
      builtin: false,
      patterns: current.patterns.map(p => ({ ...p })),
    }
    ruleSets.value = [...ruleSets.value, forked]
    ruleSetDraft.value = forked
    activeRuleSetId.value = forked.id
    persistedRuleSetId.value = null
    ruleSetNotice.value = `内置规则集不可修改，已创建自定义副本「${forked.name}」（${reason}）`
    return forked
  }

  /**
   * `book:previewSplit` 只接受 ruleSetId，因此改动过的规则集必须先 `book:saveRuleSet` 落库。
   * 返回可用于预览的 id；保存失败返回 null（由调用方按「仍用原规则集」处理并告知用户）。
   */
  async function ensureRuleSetPersisted(): Promise<string | null> {
    const effective = effectiveRuleSet.value
    if (!effective) return activeRuleSetId.value
    if (persistedRuleSetId.value) return persistedRuleSetId.value
    if (!ruleSetDirty.value && effective.builtin) return effective.id

    const toSave: ChapterRuleSet = {
      ...effective,
      // 永不用内置 id 保存：内置集是全局共享的（chapter_rule_sets.project_id = NULL）
      id: effective.builtin ? createLocalId('custom') : effective.id,
      name: effective.builtin ? `${effective.name}·自定义` : effective.name,
      builtin: false,
    }
    try {
      const saved = await call('book:saveRuleSet', { ruleSet: toSave }, { onError: 'silent' }) as ChapterRuleSet
      const stored = saved ?? toSave
      persistedRuleSetId.value = stored.id
      ruleSetDirty.value = false
      ruleSetDraft.value = { ...stored, patterns: stored.patterns.map(p => ({ ...p })) }
      activeRuleSetId.value = stored.id
      if (!ruleSets.value.some(s => s.id === stored.id)) ruleSets.value = [...ruleSets.value, stored]
      return stored.id
    } catch {
      ruleSetNotice.value = '自定义规则未能保存到主进程，本次预览仍按原规则集计算。'
      return null
    }
  }

  async function saveRuleSetAs(name: string): Promise<ChapterRuleSet | null> {
    const effective = effectiveRuleSet.value
    if (!effective) return null
    const payload: ChapterRuleSet = {
      ...effective,
      id: createLocalId('custom'),
      name: name.trim() || '我的规则集',
      builtin: false,
    }
    try {
      const saved = await call('book:saveRuleSet', { ruleSet: payload }) as ChapterRuleSet
      const stored = saved ?? payload
      ruleSets.value = [...ruleSets.value.filter(s => s.id !== stored.id), stored]
      activeRuleSetId.value = stored.id
      ruleSetDraft.value = { ...stored, patterns: stored.patterns.map(p => ({ ...p })) }
      persistedRuleSetId.value = stored.id
      ruleSetDirty.value = false
      ruleSetNotice.value = `已保存自定义规则集「${stored.name}」`
      return stored
    } catch {
      return null
    }
  }

  async function deleteRuleSet(id: string): Promise<boolean> {
    const target = ruleSets.value.find(s => s.id === id)
    if (!target) return false
    if (target.builtin) {
      ruleSetNotice.value = '内置规则集不可删除。'
      return false
    }
    const result = await callSafe('book:deleteRuleSet', { id })
    if (!result?.ok) return false
    ruleSets.value = ruleSets.value.filter(s => s.id !== id)
    if (activeRuleSetId.value === id) {
      const fallback = ruleSets.value[0]
      if (fallback) selectRuleSet(fallback.id)
    }
    ruleSetNotice.value = `已删除规则集「${target.name}」`
    return true
  }

  function setFallbackStrategy(strategy: FallbackStrategy): void {
    fallbackStrategy.value = strategy
    if (strategy !== 'none' && hasLocalText.value && !drafts.value.length) {
      applyLocalFallback(strategy)
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4：清洗
  // ---------------------------------------------------------------------------

  function setCleanOption(key: CleanOptionKey, value: boolean): void {
    cleanOptions.value = { ...cleanOptions.value, [key]: value }
    // 谨慎项的开关状态要在界面上一直可见（docs/10 §5.2），这里不做任何隐式联动
  }

  function resetCleanOptions(): void {
    cleanOptions.value = buildDefaultCleanOptions()
  }

  const enabledCleanCount = computed(() => CLEAN_OPTION_DEFS.filter(d => cleanOptions.value[d.key]).length)

  const removedLineCount = computed(() => {
    const r = cleanReport.value
    if (!r) return 0
    return r.removedAdLines + r.removedDuplicateLines + r.removedPageNumberLines + r.removedZeroWidthChars
  })

  // ---------------------------------------------------------------------------
  // Step 5：草稿人工干预（全部本地变换，不落库；提交时才写入，docs/10 §3 ⑧）
  // ---------------------------------------------------------------------------

  function findDraftIndex(tempId: string): number {
    return drafts.value.findIndex(d => d.tempId === tempId)
  }

  function updateDraft(tempId: string, patch: Partial<ChapterDraft>): void {
    const index = findDraftIndex(tempId)
    if (index < 0) return
    const current = drafts.value[index]!
    const next: ChapterDraft = { ...current, ...patch }
    if (patch.rawText !== undefined && patch.charCount === undefined) {
      next.charCount = patch.rawText.length
      next.estimatedDurationMs = estimateDurationMs(next.charCount)
    }
    drafts.value = drafts.value.map((d, i) => (i === index ? next : d))
    draftsEdited.value = true
  }

  function setDraftTitle(tempId: string, title: string): void {
    updateDraft(tempId, { title })
  }

  function toggleDraftIncluded(tempId: string): void {
    const draft = drafts.value.find(d => d.tempId === tempId)
    if (!draft) return
    updateDraft(tempId, { included: !draft.included })
  }

  function setAllIncluded(included: boolean): void {
    drafts.value = drafts.value.map(d => ({ ...d, included }))
    draftsEdited.value = true
  }

  function invertIncluded(): void {
    drafts.value = drafts.value.map(d => ({ ...d, included: !d.included }))
    draftsEdited.value = true
  }

  function moveDraft(from: number, to: number): void {
    const list = [...drafts.value]
    if (from < 0 || from >= list.length) return
    const target = Math.min(list.length - 1, Math.max(0, to))
    const [item] = list.splice(from, 1)
    if (!item) return
    list.splice(target, 0, item)
    drafts.value = reindex(list)
    draftsEdited.value = true
  }

  function moveDraftBy(tempId: string, delta: number): void {
    const from = findDraftIndex(tempId)
    if (from < 0) return
    moveDraft(from, from + delta)
  }

  /** 按「标题里的章节号」排序（docs/10 §7.1：正则切出来的顺序可能是乱的） */
  function sortByTitleNumber(): void {
    drafts.value = reindex([...drafts.value].sort(compareDraftByTitleNumber))
    draftsEdited.value = true
  }

  function reindex(list: ChapterDraft[]): ChapterDraft[] {
    return list.map((d, i) => ({ ...d, index: i }))
  }

  function removeDraft(tempId: string): void {
    const index = findDraftIndex(tempId)
    if (index < 0) return
    const draft = drafts.value[index]!
    removedDrafts.value = [{ draft, at: index }, ...removedDrafts.value]
    drafts.value = reindex(drafts.value.filter((_, i) => i !== index))
    if (previewDraftId.value === tempId) previewDraftId.value = null
    draftsEdited.value = true
  }

  function restoreDraft(tempId: string): void {
    const record = removedDrafts.value.find(r => r.draft.tempId === tempId)
    if (!record) return
    const list = [...drafts.value]
    const at = Math.min(list.length, Math.max(0, record.at))
    list.splice(at, 0, record.draft)
    drafts.value = reindex(list)
    removedDrafts.value = removedDrafts.value.filter(r => r.draft.tempId !== tempId)
    draftsEdited.value = true
  }

  function restoreAllDrafts(): void {
    for (const record of [...removedDrafts.value]) restoreDraft(record.draft.tempId)
  }

  /**
   * 批量前缀/后缀增删（docs/10 §7.1「统一加『斗破苍穹·』」）。
   * `mode='remove'` 只删除确实存在的固定前后缀，不做模糊匹配 —— 批量改名必须可预期。
   */
  function applyTitleAffix(affix: string, position: 'prefix' | 'suffix', action: 'add' | 'remove', onlyIncluded = true): number {
    const value = affix ?? ''
    if (!value) return 0
    let changed = 0
    drafts.value = drafts.value.map(d => {
      if (onlyIncluded && !d.included) return d
      let title = d.title
      if (action === 'add') {
        title = position === 'prefix' ? `${value}${title}` : `${title}${value}`
      } else if (position === 'prefix' && title.startsWith(value)) {
        title = title.slice(value.length)
      } else if (position === 'suffix' && title.endsWith(value)) {
        title = title.slice(0, title.length - value.length)
      }
      if (title === d.title) return d
      changed++
      return { ...d, title }
    })
    if (changed > 0) draftsEdited.value = true
    return changed
  }

  /** 预览期合并多章（提交时作为一个 draft 落库；持久化章节的合并走 chapter:merge） */
  function mergeDrafts(tempIds: string[], title: string): ChapterDraft | null {
    const ids = new Set(tempIds)
    const picked = drafts.value.filter(d => ids.has(d.tempId))
    if (picked.length < 2) return null
    const firstIndex = drafts.value.findIndex(d => ids.has(d.tempId))
    const text = picked.map(d => d.rawText).join('\n\n')
    const merged: ChapterDraft = {
      ...picked[0]!,
      tempId: picked[0]!.tempId,
      title: title.trim() || picked[0]!.title,
      rawText: text,
      charCount: text.length,
      estimatedDurationMs: estimateDurationMs(text.length),
      startOffset: Math.min(...picked.map(d => d.startOffset)),
      endOffset: Math.max(...picked.map(d => d.endOffset)),
      included: picked.some(d => d.included),
      index: firstIndex < 0 ? picked[0]!.index : firstIndex,
    }
    const rest = drafts.value.filter(d => !ids.has(d.tempId))
    const list = [...rest]
    list.splice(Math.max(0, firstIndex), 0, merged)
    drafts.value = reindex(list)
    draftsEdited.value = true
    return merged
  }

  /** 预览期拆分（offsets 相对该章 rawText；docs/10 §7.1 的「拆分」） */
  function splitDraft(tempId: string, offsets: number[]): ChapterDraft[] | null {
    const index = findDraftIndex(tempId)
    if (index < 0) return null
    const draft = drafts.value[index]!
    const clean = [...new Set(offsets)]
      .map(o => Math.round(o))
      .filter(o => o > 0 && o < draft.rawText.length)
      .sort((a, b) => a - b)
    if (!clean.length) return null

    const pieces: Array<{ start: number; end: number }> = []
    let cursor = 0
    for (const offset of clean) {
      pieces.push({ start: cursor, end: offset })
      cursor = offset
    }
    pieces.push({ start: cursor, end: draft.rawText.length })

    const created = pieces
      .map(({ start, end }, i) => {
        const raw = draft.rawText.slice(start, end)
        return {
          ...draft,
          tempId: createLocalId('draft'),
          index: draft.index + i,
          title: `${draft.title}（${i + 1}/${pieces.length}）`,
          rawText: raw,
          charCount: raw.length,
          estimatedDurationMs: estimateDurationMs(raw.length),
          startOffset: draft.startOffset + start,
          endOffset: draft.startOffset + end,
          included: draft.included,
        } satisfies ChapterDraft
      })
      .filter(p => p.rawText.trim().length > 0)

    if (!created.length) return null
    const list = [...drafts.value]
    list.splice(index, 1, ...created)
    drafts.value = reindex(list)
    draftsEdited.value = true
    return created
  }

  function setPreviewDraft(tempId: string | null): void {
    previewDraftId.value = tempId
  }

  const previewDraft = computed(() => drafts.value.find(d => d.tempId === previewDraftId.value) ?? null)

  // ---------------------------------------------------------------------------
  // Step 6：书目元数据、去重、提交
  // ---------------------------------------------------------------------------

  function setBookMeta(patch: Partial<BookMetaDraft>): void {
    bookMeta.value = { ...bookMeta.value, ...patch }
    if (patch.title !== undefined) duplicateAcknowledged.value = false
  }

  /** 书名默认值：解析出的标题 → 文件名 → 粘贴时的时间戳名（docs/10 §8.5） */
  function ensureDefaultBookMeta(): void {
    if (bookMeta.value.title.trim()) return
    if (parsedTitle.value) {
      bookMeta.value.title = parsedTitle.value
      return
    }
    if (mode.value === 'file' && fileName.value) {
      bookMeta.value.title = fileName.value.replace(/\.[^.]+$/, '')
      return
    }
    if (mode.value === 'url') {
      try {
        const parsed = new URL(url.value)
        bookMeta.value.title = parsed.hostname + parsed.pathname.replace(/\/$/, '')
        return
      } catch {
        /* 非法 URL 交给步骤守卫提示 */
      }
    }
    bookMeta.value.title = `未命名作品 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
  }

  function setProjectContext(id: string | null, hint = ''): void {
    projectId.value = id
    projectHint.value = hint
  }

  function setMaxFileSizeBytes(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) maxFileSizeBytes.value = bytes
  }

  /** 去重检测（docs/10 §9）。哈希缺失时不做静默判断，而是明确告知「本次跳过去重」。 */
  async function checkDuplicate(): Promise<'ok' | 'hit' | 'skipped'> {
    duplicateChecked.value = true
    if (!contentHash.value || !projectId.value) {
      duplicate.value = null
      return 'skipped'
    }
    const result = await callSafe('book:findDuplicate', {
      contentHash: contentHash.value,
      projectId: projectId.value,
    })
    if (result?.exists) {
      duplicate.value = { bookId: result.bookId ?? null }
      duplicateAcknowledged.value = false
      return 'hit'
    }
    duplicate.value = null
    return 'ok'
  }

  function acknowledgeDuplicate(): void {
    duplicateAcknowledged.value = true
  }

  function clearDuplicate(): void {
    duplicate.value = null
    duplicateChecked.value = false
    duplicateAcknowledged.value = false
  }

  /** 组装 book:commitImport 载荷（含人工干预后的草稿） */
  function buildCommitPayload(): CommitImportPayload | null {
    if (!projectId.value) return null
    const included = drafts.value.filter(d => d.included)
    return {
      projectId: projectId.value,
      bookMeta: {
        title: bookMeta.value.title.trim(),
        author: bookMeta.value.author.trim() || null,
        narrator: bookMeta.value.narrator.trim() || undefined,
        language: bookMeta.value.language.trim() || 'zh-CN',
        coverPath: bookMeta.value.coverPath,
      },
      source: {
        type: sourceType.value,
        path: mode.value === 'file' ? filePath.value : mode.value === 'url' ? url.value : null,
        encoding: selectedEncoding.value || null,
        // 哈希由主进程计算（docs/10 §9）；缺失时留空字符串，主进程按自身规则重算
        contentHash: contentHash.value,
      },
      drafts: included,
    }
  }

  /**
   * 走 `book:commitImport` 直接入库（唯一能携带人工改名/合并/删除结果的通道）。
   * @returns bookId；命中重复返回 null 并通过重复面板呈现
   */
  async function commitImport(): Promise<CommitImportResult | null> {
    const payload = buildCommitPayload()
    if (!payload) {
      // **绝不静默返回 null**：调用方（useImportFlow.submit）在没有 lastError 时只能报
      // 一句笼统且与事实不符的「后台任务执行失败」，把真实原因（缺项目上下文 / 缺书名）
      // 彻底埋掉 —— 这正是真机事故里用户看到的东西（docs/91 §5.2.4）。
      // 这里把原因写进 commitError（界面内联展示）与 lastError（error-bus 弹窗）。
      // 目前 `buildCommitPayload()` 唯一返回 null 的原因就是缺 projectId；
      // 若将来新增别的空缺条件，请在这里补上对应的原因文案（不要退回笼统提示）。
      const reason = '缺少项目上下文：请先在书架打开一本书，或重启应用以重建默认项目'
      commitError.value = { key: 'INVALID_PAYLOAD', message: reason }
      lastError.value = AppError.of('INVALID_PAYLOAD', {
        details: { reason: 'commit-payload-incomplete', why: reason },
      })
      return null
    }
    committing.value = true
    commitError.value = null
    try {
      return await call('book:commitImport', payload, { onError: 'silent' }) as CommitImportResult
    } catch (error) {
      const key = typeof (error as { key?: unknown })?.key === 'string' ? String((error as { key: string }).key) : 'UNKNOWN'
      commitError.value = {
        key,
        message: typeof (error as { message?: unknown })?.message === 'string'
          ? String((error as { message: string }).message)
          : '导入失败',
      }
      lastError.value = error
      if (key === 'DUPLICATE_BOOK') duplicate.value = { bookId: findDuplicateBookId(error) }
      return null
    } finally {
      committing.value = false
    }
  }

  function findDuplicateBookId(error: unknown): string | null {
    const details = (error as { details?: Record<string, unknown> })?.details
    const id = details?.bookId
    return typeof id === 'string' ? id : null
  }

  /** 走任务通道时的选项（主进程 ImportRequest 的字段子集，见 import.service.ts） */
  function buildTaskOptions(duplicatePolicy: 'error' | 'open-existing' | 'copy'): Record<string, unknown> {
    return {
      ruleSet: effectiveRuleSet.value ?? undefined,
      fallback: fallbackStrategy.value === 'none' ? undefined : fallbackStrategy.value,
      cleanOptions: { ...cleanOptions.value },
      title: bookMeta.value.title.trim() || undefined,
      author: bookMeta.value.author.trim() || undefined,
      narrator: bookMeta.value.narrator.trim() || undefined,
      language: bookMeta.value.language.trim() || undefined,
      duplicatePolicy,
      persist: true,
    }
  }

  function markTaskStarted(nextTaskId: string): void {
    taskId.value = nextTaskId
  }

  function setOutcome(result: ImportOutcome): void {
    outcome.value = result
    if (result.bookId) sessionBookIdHint.value = result.bookId
  }

  function setCommitError(key: string, message: string): void {
    commitError.value = { key, message }
  }

  function clearCommitError(): void {
    commitError.value = null
  }

  // ---------------------------------------------------------------------------
  // 全量重置（开始一次新的导入）
  // ---------------------------------------------------------------------------

  function reset(): void {
    step.value = 1
    parsedOnce.value = false
    mode.value = 'file'
    filePath.value = null
    fileName.value = ''
    probe.value = null
    pasteText.value = ''
    url.value = ''
    detection.value = null
    selectedEncoding.value = ''
    drafts.value = []
    cleanReport.value = null
    cleanReportDetail.value = null
    parsedEncoding.value = ''
    contentHash.value = ''
    suspiciousSplit.value = false
    splitWarnings.value = []
    totalChars.value = 0
    parsedTitle.value = ''
    previewError.value = null
    disabledPatternIds.value = []
    persistedRuleSetId.value = null
    ruleSetDirty.value = false
    ruleSetNotice.value = ''
    fallbackStrategy.value = 'none'
    cleanOptions.value = buildDefaultCleanOptions()
    removedDrafts.value = []
    previewDraftId.value = null
    draftsEdited.value = false
    bookMeta.value = { title: '', author: '', narrator: '', language: 'zh-CN', coverPath: null }
    duplicate.value = null
    duplicateChecked.value = false
    duplicateAcknowledged.value = false
    committing.value = false
    outcome.value = null
    taskId.value = null
    commitError.value = null
    sessionBookIdHint.value = null
  }

  return {
    // 步骤
    step, stepDef, parsedOnce, goTo, blockReason, canGoNext, canGoPrev,
    // 来源
    mode, filePath, fileName, probe, pasteText, url, sourceType, canPreview, hasLocalText,
    setMode, setFilePath, setPasteText, setUrl, runProbe, invalidateParse,
    maxFileSizeBytes, setMaxFileSizeBytes, fileTooLarge,
    // 编码与解析
    detection, selectedEncoding, detectBusy, detectEncoding, selectEncoding,
    needsUserEncodingChoice, encodingDiffersFromParsed,
    drafts, cleanReport, cleanReportDetail, parsedEncoding, contentHash, suspiciousSplit, splitWarnings,
    totalChars, parsedTitle, previewBusy, previewError, runPreview, applyLocalFallback,
    // 规则
    ruleSets, ruleSetsLoaded, activeRuleSetId, ruleSetDraft, effectiveRuleSet, disabledPatternIds,
    ruleSetDirty, ruleSetNotice, ruleSetPreviewError, fallbackStrategy,
    loadRuleSets, selectRuleSet, togglePatternEnabled, updatePattern, addPattern, removePattern,
    setAllowNumericOnly, renameRuleSet, saveRuleSetAs, deleteRuleSet, ensureRuleSetPersisted,
    setFallbackStrategy,
    // 清洗
    cleanOptions, setCleanOption, resetCleanOptions, enabledCleanCount, removedLineCount,
    // 草稿
    includedDrafts, includedCount, totalDraftChars, includedChars, includedDurationMs,
    longestDraft, removedDrafts, removedDraftCount,
    updateDraft, setDraftTitle, toggleDraftIncluded, setAllIncluded, invertIncluded,
    moveDraft, moveDraftBy, sortByTitleNumber, removeDraft, restoreDraft, restoreAllDrafts,
    applyTitleAffix, mergeDrafts, splitDraft, previewDraftId, previewDraft, setPreviewDraft, draftsEdited,
    // 确认与提交
    bookMeta, setBookMeta, ensureDefaultBookMeta, projectId, projectHint, setProjectContext,
    duplicate, duplicateChecked, duplicateAcknowledged, checkDuplicate, acknowledgeDuplicate, clearDuplicate,
    canCommit, committing, commitImport, buildCommitPayload, buildTaskOptions,
    taskId, markTaskStarted, outcome, setOutcome, commitError, setCommitError, clearCommitError,
    lastError, sessionBookIdHint,
    // 其它
    reset,
  }
})

/**
 * 客户端正则预检（docs/10 §6.5）。
 *
 * 权威实现是 `src/shared/text/chapter-split.ts` 的 `validateLinePattern`，
 * 但它 `import { performance } from 'node:perf_hooks'` —— 渲染进程不能引入 Node 内置模块，
 * 因此这里保留一份**同判定顺序的轻量预检**（空/超长 → 编译 → 嵌套量词 → 有界重复过大），
 * 目的只是让用户在本页立刻看到「正则非法」，最终以主进程校验为准。
 */
export function validateLinePatternLocal(pattern: string): { ok: boolean; error?: string; unsafe?: boolean } {
  if (typeof pattern !== 'string' || !pattern.trim()) return { ok: false, error: '正则表达式不能为空' }
  if (pattern.length > 2000) return { ok: false, error: `正则过长（${pattern.length} 字符，上限 2000）` }
  let source = pattern
  let flags = ''
  for (;;) {
    const m = /^\(\?([ims]+)\)/.exec(source)
    if (!m) break
    for (const ch of m[1]!) if ('imsu'.includes(ch) && !flags.includes(ch)) flags += ch
    source = source.slice(m[0].length)
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, flags)
  } catch (e) {
    return { ok: false, error: `正则语法错误：${e instanceof Error ? e.message : String(e)}` }
  }
  const quantifiedGroup = /\(((?:\\.|[^()\\])*)\)(?:[*+]|\{\d+,\d*\})/g
  let m: RegExpExecArray | null
  while ((m = quantifiedGroup.exec(source)) !== null) {
    if (/[*+?]|\{\d+,\d*\}/.test(m[1] ?? '')) {
      return { ok: false, unsafe: true, error: `存在嵌套量词（如 (a+)+ / (.*)*）：「(${m[1] ?? ''})」` }
    }
  }
  const bounded = /\{\s*(\d+)\s*(?:,\s*(\d*)\s*)?\}/g
  while ((m = bounded.exec(source)) !== null) {
    const min = Number(m[1])
    const max = m[2] === undefined || m[2] === '' ? min : Number(m[2])
    if (min > 1000 || max > 1000) return { ok: false, unsafe: true, error: `重复次数上限过大（{${m[1]},${m[2] ?? ''}}）` }
  }
  return { ok: true }
}

/** 校验整个规则集，返回第一条错误（供步骤守卫用） */
export function validateRuleSetPatterns(set: ChapterRuleSet | null): string | null {
  if (!set) return null
  if (!set.patterns.length) return '规则集里一条规则都没有：至少启用一条规则，或改用备选分章方式'
  for (const pattern of set.patterns) {
    const result = validateLinePatternLocal(pattern.linePattern)
    if (!result.ok) return `规则「${pattern.id}」无效：${result.error ?? '未知问题'}`
  }
  return null
}

/** 勾选/未勾选规则 id 的展示辅助（视图侧读 enabledRuleIds 判断勾选态） */
export function enabledRuleIds(set: ChapterRuleSet | null, disabled: readonly string[]): string[] {
  if (!set) return []
  const off = new Set(disabled)
  return set.patterns.filter(p => !off.has(p.id)).map(p => p.id)
}

/** 编码候选兜底：主进程没给候选中时用 constants 的 ENCODING_CANDIDATES（docs/10 §4.1 第 6 条） */
export function fallbackEncodingCandidates(): Array<{ encoding: string; score: number; preview: string }> {
  return ENCODING_CANDIDATES.map((encoding, index) => ({ encoding, score: Math.max(0, 1 - index * 0.1), preview: '' }))
}
