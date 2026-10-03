/**
 * Novel Studio · 画本文本解析（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md、docs/91 §5.2.1（真实样本勘察）
 *
 * ## 真实画本长什么样（由 `样本/重生：崛起香江-画本【第2201章-第2300章】.docx` 归纳）
 *
 * 用 mammoth 抽出纯文本、按行去空之后，结构是：
 *
 * ```
 * 序号          ← 角色表表头开始
 * CV
 * 角色名
 * 角色描述
 * 台词数
 * 音色
 * 1
 * 阿翼爱热闹     ← CV
 * 男龙套3       ← 角色名
 *              ← 角色描述（可能为空）
 * 69           ← 台词数
 * 2
 * 鱼头一颗糖
 * 男龙套2
 * 50
 * …（角色表结束）
 * 第2201章       ← 章节标题
 * 邵大亨得知此事，肺快气炸！            ← 无【】前缀 = 旁白
 * 【阿翼爱热闹-男龙套3】“扑你个街！…”   ← 有【CV-角色】= 对白
 * 【月光_深白色-石志坚】“你红了，多好！”  ← CV 含下划线
 * …（下一章又出现一次角色表，见下）
 * ```
 *
 * ## 四个必须处理的真实细节
 *
 * 1. **角色表可能出现多次。** 样本里第 2201 章之后又出现了一次
 *    `序号/CV/角色名/…` 表头。所以不能「只解析开头那一段」，
 *    要**全文扫描**并合并所有角色表的条目（后出现的同 CV 条目按「并集」处理）。
 *
 * 2. **角色表的列数不固定。** 第二个样本（`穿书后我捡到了反派`）的列是
 *    `序号 | CV | 角色名 | 性别 | 角色描述 | 台词数`，
 *    第一个样本是 `序号 | CV | 角色名 | 角色描述 | 台词数 | 音色`。
 *    所以**不能按固定下标取列**，要先读表头、按表头名定位。
 *
 * 3. **一行的对白可能被拆成多段。** 真实样本里有：
 *    `【奇怪山茶花-李大龙】“…”李大龙摘下墨镜继续苦笑，【奇怪山茶花-李大龙】“…”`
 *    同一行里出现**两次**同一个标记，中间夹着叙述。所以解析一行的对白时
 *    要**取出全部** `【CV-角色】` 标记及其后文本，而不是只取第一个。
 *
 * 4. **对白与旁白混在同一个段落流里**，没有缩进/样式可依（mammoth 抽纯文本
 *    拿不到样式）。判据只能是「有没有 `【…】` 标记」。
 *
 * ## 与画本编辑域的关系
 *   本模块**只解析 docx 的文本形态**，产出「角色表 + 章节 + 行」这样的中间结构。
 *   它不负责落库、不负责说话人向量判定（那在 docs/06）、也不负责切句
 *   （那在 `shared/text/sentence.ts`）。
 *   「按说话人导入音频」需要它回答的唯一问题是：
 *   **某 CV / 某个角色，在第 X~Y 章里到底有哪些行。**
 *
 * 本目录禁止引入任何第三方依赖（读 .docx 的 mammoth 在主进程侧）。
 */

/** 角色表里的一个条目（CV ↔ 角色 的对应关系） */
export interface CanvasRosterEntry {
  /** 配音演员名（表头「CV」列）。可能为空（有的画本只给角色名） */
  cv: string | null
  /** 角色名（表头「角色名」列） */
  character: string
  /** 角色描述（表头「角色描述」列），可能为空 */
  description: string | null
  /** 台词的登记条数（表头「台词数」列）；解析不出时为 null */
  lineCount: number | null
  /** 原文行号（0 基），便于把问题定位回源文件 */
  sourceLine: number
}

/** 一行台词在画本里的归属 */
export interface CanvasLineOwner {
  /** CV（`【CV-…】` 的左半边） */
  cv: string
  /** 角色名（`【…-角色】` 的右半边） */
  character: string
}

/**
 * 一行的说话**段**：一次 `【CV-角色】` 标记及其后的台词。
 *
 * 为什么按「段」而不是「行」建模：
 *   真实样本里有 `【A-B】“x”叙述【A-B】“y”` —— 同一行两次标记、中间夹叙述。
 *   若只取第一个 owner，后半句的对白就丢了；若把整行算成一个说话人，
 *   切句后「哪一句属于谁」又会错。按段建模两者都不会错。
 */
export interface CanvasSpeakerSegment {
  /** 该段说话人；`null` = 群白（`【异口同声】` 这种没有 CV-角色 的标记） */
  owner: CanvasLineOwner | null
  /** 标记的原始文本（含【】），群白时用于回显 */
  markerRaw: string
  /** 该段的台词原文（已去最外层引号） */
  text: string
  /** 标记结束位置**之后**、该段文本开始处的字符偏移（相对 rawText） */
  textStart: number
  /** 该段文本结束处的字符偏移（相对 rawText） */
  textEnd: number
}

/**
 * 画本行的**最小公共形态**。
 *
 * ### 为什么需要它（这一步是「按说话人导入」的关键设计决定）
 *   这个功能要先用**文档行**做预览（画本可能还没导入数据库），
 *   再用**数据库行**做实际落库。如果两边各写一套选行逻辑，
 *   「预览说会导入 90 行、实际只导入了 40 行」这种不一致必然发生，且极难发现。
 *
 *   所以把「一行是什么」抽成这个最小形态，让 `audio-import/select.ts` 的
 *   选行函数对**两种来源**都适用 —— **预览与导入走同一个函数**。
 *
 * 数据库侧（`canvas_lines` 表）的映射：
 *   `sourceLine` ← `seq`（同章内自增，稳定排序）
 *   `kind`       ← `speaker_type` + `kind` 两列推导
 *   `owners`     ← 由 `character_id` 反查角色名与该角色的 CV 名得到
 */
export interface LineRef {
  /** 行在源文本里的序号（数据库侧用 `seq`） */
  sourceLine: number
  /** 章节号 */
  chapterNo: number
  /**
   * 说话类型：
   * - `dialogue` —— 有**至少一个**带 CV-角色 的标记
   * - `group`    —— 只有 `【异口同声】` 这类无 CV-角色 的标记（群白）
   * - `narration`—— 完全没有 `【…】` 标记（旁白）
   */
  kind: 'dialogue' | 'group' | 'narration'
  /** 该行的说话人（去重、按出现顺序）；群白/旁白为空数组 */
  owners: CanvasLineOwner[]
  /** 该行的对白文本（数据库侧用 `text`；旁白为空串） */
  dialogueText: string
}

/** 画本正文里的一行（文档解析产物；比 `LineRef` 多带原文与说话段） */
export interface CanvasParsedLine extends LineRef {
  /** 章节标题原文（如「第2201章」） */
  chapterTitle: string
  /** 该行的说话段（保留顺序与偏移，切句对轨要用） */
  segments: CanvasSpeakerSegment[]
  /** 该行的完整原文（保留标记，便于回显与人工核对） */
  rawText: string
}

export interface ParsedCanvas {
  /** 角色表（合并了全文所有角色表） */
  roster: CanvasRosterEntry[]
  /** 正文行（按出现顺序） */
  lines: CanvasParsedLine[]
  /** 出现的章节号（升序、去重） */
  chapters: number[]
  /**
   * 解析过程中发现的结构问题（不抛错：真实画本总有各种不规范，
   * 让用户看到「哪里没看懂」比整体失败有用）。
   */
  warnings: CanvasParseWarning[]
}

export interface CanvasParseWarning {
  /** 源文本行号（0 基） */
  sourceLine: number
  reason:
    | 'roster-header-missing-cv'
    | 'roster-header-missing-character'
    | 'roster-row-incomplete'
    | 'line-before-first-chapter'
    | 'malformed-speaker-marker'
  detail: string
  /** 触发问题的原文片段（截断） */
  sample: string
}

// ---------------------------------------------------------------------------
// 章节标题
// ---------------------------------------------------------------------------

/**
 * 章节标题识别。
 *
 * 真实样本里出现过三种写法：
 *   · `第2201章`（无标题）
 *   · `第1章 第二本书`（有标题）
 *   · `第5章 元神化身（一）`
 * 还允许 `第 2201 章`（数字两边有空格）。
 *
 * ### ⚠️ 标题部分**必须限制字符集**（测试才暴露出来的严重缺陷）
 *   最早的写法是 `第\s*(\d+)\s*章(?:\s*(.*))?$`。`(.*)` 能匹配任意字符
 *   （`.` 只是不匹配换行），于是：
 *
 *   ```
 *   第1章的第0句旁白。   ← 一句旁白，却被当成章节标题「第1章的第0句旁白。」
 *   ```
 *
 *   后果极其隐蔽：这行被当作章节标题 `continue` 掉，
 *   **整本书的旁白一行都不剩**（实测 96 句 → 0 句），
 *   而章节号与对白行数完全正常 —— 只看摘要发现不了。
 *   真实样本里恰好没有「第N章…」开头的旁白句子，所以是合成 fixture 抓出来的。
 *
 *   现在的判据（四条同时成立才算标题）：
 *     1. 以「第+数字+章」开头，且标题部分与「章」之间要有空白分隔
 *     2. 标题部分**不含句末标点**（。！？；，、）—— 旁白句子必然有
 *     3. 标题部分**不含「的」** ——「第1章的第0句」这种典型旁白措辞
 *     4. 整行长度 ≤ 40 —— 章节标题不会很长，长的一定是正文
 */
const CHAPTER_TITLE_RE = /^第\s*(\d{1,6})\s*章(?:\s+(\S{0,20}(?:\s\S{0,20}){0,3}))?$/

/** 标题里不允许出现的字符（句末标点）与虚词 */
const TITLE_FORBIDDEN = /[。！？；，、]|的/

export function parseChapterTitle(text: string): { chapterNo: number; title: string } | null {
  const t = text.trim()
  if (t.length === 0 || t.length > 40) return null

  const m = CHAPTER_TITLE_RE.exec(t)
  if (!m) return null

  const no = Number(m[1])
  if (!Number.isFinite(no) || no < 1) return null

  const titlePart = (m[2] ?? '').trim()
  if (TITLE_FORBIDDEN.test(titlePart)) return null

  return { chapterNo: no, title: t }
}

/**
 * 从章节**标题**里宽松地取章节号。
 *
 * ### 为什么需要它（与 `parseChapterTitle` 的区别）
 *   `parseChapterTitle` 是**严格**的：要求整行都以章节标题的形式出现、
 *   标题部分不含句末标点与「的」、且长度受限。那是给**画本正文解析**用的 ——
 *   在正文流里必须避免把「第1章的第0句旁白」当成章节标题。
 *
 *   但数据库里的 `chapters.title` **已经确定是标题**（不是从正文流里猜的），
 *   这时严格判据反而会误杀：真实书的标题有 `第2201章 复仇（上）`、
 *   `第 2201 章`、甚至 `Chapter 2201` 之外的各种变体。
 *
 *   所以这里用一个**宽松**的取号器：只要标题里能找到「第…章」就取那个数字。
 *   取不到时返回 null，由调用方决定兜底（例如退回 `seq`）。
 *
 * ### 为什么必须从 title 取号，而不能用 `chapters.seq`
 *   `seq` 是**序号**（第几个章节）：`book.service.ts` 里是 `baseSeq + i`，
 *   `import.service.ts` 里是 `i + 1`。而文件名里的区间是**章节号**。
 *   真实样本那本书的章节号是 2201~2300，而 `seq` 是 1~100 ——
 *   两者完全不重合，用 `seq` 会让「按说话人导入」一个章节都对不上。
 */
export function extractChapterNoFromTitle(title: string): number | null {
  const t = String(title ?? '').trim()
  if (t.length === 0) return null
  // 先走严格判据（覆盖绝大多数真实标题），失败再宽松扫描
  const strict = parseChapterTitle(t)
  if (strict) return strict.chapterNo
  const m = /第\s*(\d{1,6})\s*章/.exec(t)
  if (!m) return null
  const no = Number(m[1])
  return Number.isFinite(no) && no >= 1 ? no : null
}

/**
 * 说话人标记：`【CV-角色】`
 *
 * 真实样本里 CV 与角色都可能含 `_`、`.`、数字、空格：
 *   `【月光_深白色-石志坚】`、`【阿翼爱热闹-男龙套3】`
 * 所以标记体内**不限制字符集**，只要求「有一段、一个 `-`、又一段」。
 * 分隔符同时接受全角 `－`。
 */
const SPEAKER_MARKER_RE = /【([^】]+?)】/g
const SPEAKER_SPLIT_RE = /[-－—]/

/** 把 `【…】` 里的内容拆成 CV 与角色 */
export function splitSpeakerMarker(inner: string): CanvasLineOwner | null {
  const idx = inner.search(SPEAKER_SPLIT_RE)
  if (idx <= 0 || idx >= inner.length - 1) return null
  const cv = inner.slice(0, idx).trim()
  const character = inner.slice(idx + 1).trim()
  if (cv.length === 0 || character.length === 0) return null
  return { cv, character }
}

// ---------------------------------------------------------------------------
// 角色表
// ---------------------------------------------------------------------------

/** 表头里被识别的列名（归一化后比较） */
type RosterColumn = 'seq' | 'cv' | 'character' | 'description' | 'lineCount' | 'other'

function classifyRosterColumn(header: string): RosterColumn {
  const h = header.replace(/\s/g, '')
  if (h === '序号' || h === '编号') return 'seq'
  if (h === 'CV' || h === 'cv' || h === 'Cv' || h === '配音' || h === '配音员' || h === '配音演员') return 'cv'
  if (h === '角色名' || h === '角色') return 'character'
  if (h === '角色描述' || h === '描述') return 'description'
  if (h === '台词数' || h === '台词数量' || h === '句数') return 'lineCount'
  return 'other'
}

/**
 * 尝试把从 `start` 开始的一段识别成角色表**表头**。
 *
 * ### 关键事实（真机踩过两次，两次表现完全不同）
 *   mammoth 抽 .docx 表格时，**每个单元格之间会插入空行**：
 *
 *   ```
 *   L1190 | 序号      ← 表头起点
 *   L1191 | (空行)
 *   L1192 | CV
 *   L1193 | (空行)
 *   L1194 | 角色名
 *   L1195 | (空行)
 *   L1196 | 角色描述
 *   L1197 | (空行)
 *   L1198 | 台词数
 *   L1199 | (空行)
 *   L1200 | 音色
 *   L1201 | (空行)
 *   L1202 | 1         ← 数据首行（也可能还有空行）
 *   ```
 *
 *   **坑 ①**：第一版「跳过空行但按连续下标记列号」→ `角色名`（真实下标 4）
 *   被记成「第 3 列」，`角色描述` 落进同一个槽 → 触发「列名重复」而放弃，
 *   角色表**一条都读不出来**。
 *
 *   **坑 ②（更隐蔽）**：改成记「真实行下标」后，列号成了**绝对下标**
 *   （`seq=1190, cv=1192, char=1194`）。于是「条目跨度」= `max(列号)+1` = **1191**，
 *   荒谬地大；`dataStart` 也可能落在空行上 → 后续每一张表都读到 0 条。
 *   现在列号一律记**相对表头起点的偏移**（0、2、4、6、8、10），跨度才是真实行数。
 *
 * @returns 表头信息（各列的**相对偏移** + 数据首行下标）；不是表头时返回 null
 */
function readRosterHeader(
  lines: readonly string[],
  start: number,
  lookahead = 24,
): { colAt: Map<RosterColumn, number>; headerEnd: number } | null {
  const colAt = new Map<RosterColumn, number>()
  const end = Math.min(lines.length, start + lookahead)

  for (let i = start; i < end; i++) {
    const raw = lines[i]!.trim()
    if (raw.length === 0) continue
    // 表头只由短词构成；遇到长句立刻放弃（那是正文）
    if (raw.length > 8) break

    const col = classifyRosterColumn(raw)
    if (col === 'other') {
      // 「音色」这类未识别的列名也算表头的一部分（占位，避免列错位）。
      // 但表头还没开始就遇到无关短词 → 不是表头。
      if (colAt.size === 0) break
      if (colAt.has('other')) break
      colAt.set('other', i - start) // ← 相对偏移，不是绝对下标
      continue
    }
    // 同名列不可能出现两次 → 说明这不是表头，是正文里的巧合
    if (colAt.has(col)) break
    colAt.set(col, i - start) // ← 相对偏移
  }

  if (!colAt.has('cv') || !colAt.has('character')) return null

  // 数据首行 = 最后一个已识别列之后，**跳过全部空行**后的第一个非空行。
  // 不跳过空行会让 `at(dataStart, …)` 全取到空串 → 该表读 0 条。
  let cursor = start + Math.max(...colAt.values()) + 1
  while (cursor < lines.length && lines[cursor]!.trim().length === 0) cursor++

  return { colAt, headerEnd: cursor }
}

/**
 * 从表头之后按列读取角色条目。
 *
 * ### 为什么不能写死行步长（这一步踩了两次）
 *   mammoth 把表格每格抽成一行，于是「一条目占几行」取决于**该条目有多少格非空**：
 *
 *   ```
 *   电影《重生》主角色表（描述为空）        某一章的小角色表（描述有内容）
 *   L1202 | 1                              L1508 | 1
 *   L1204 | 阿翼爱热闹                       L1510 | 鱼头一颗糖
 *   L1206 | 男龙套3                          L1512 | 洪进宝
 *   L1208 | (空)                             L1514 | 小胖子，武打明星洪金宝
 *   L1210 | 1        ← "音色"列              L1516 | 5        ← 台词数
 *   L1214 | 2        ← 下一条（+12）          L1518 | 2        ← 下一条（+10）
 *   ```
 *
 *   所以「上一条 + 固定步长 = 下一条」是**错的**。真实文档里同一次遍历
 *   就能遇到 8、10、12 等多种间距。第一版按 `firstSeq + 1` 定位下一个条目，
 *   在描述为空时会把「音色」列的数字误当成下一条序号而错位。
 *
 * ### 正确做法：只依赖「序号」列的单调递增
 *   在 seq 列上向后找**下一个纯数字**即为下一条（列顺序保证它先于其它列出现）。
 *   这条规则不假设任何固定间距，描述为空/多行都成立。
 *   没有 seq 列时退化为「CV 与角色名两格都非空」的最近位置。
 *
 * ### 为什么读不动就停（宁少勿滥）
 *   把正文吃进角色表会让「角色 → 行」的匹配整体错位，症状是
 *   「导入的音频和画本对不上」，极难排查。所以宁可少读几条。
 *
 * @returns 消费掉的行数（含条目之间的空行）
 */
function consumeRosterRows(
  lines: readonly string[],
  header: { colAt: Map<RosterColumn, number>; headerEnd: number },
  out: CanvasRosterEntry[],
): number {
  const cvAt = header.colAt.get('cv')!
  const charAt = header.colAt.get('character')!
  const seqAt = header.colAt.get('seq')
  const descAt = header.colAt.get('description')
  const countAt = header.colAt.get('lineCount')

  const dataStart = header.headerEnd
  if (dataStart >= lines.length) return 0

  const at = (rowStart: number, off: number | undefined): string =>
    off === undefined ? '' : (lines[rowStart + off] ?? '').trim()

  if (at(dataStart, cvAt).length === 0 || at(dataStart, charAt).length === 0) return 0

  const maxCol = Math.max(...header.colAt.values())
  const minSpan = maxCol + 1

  /** 某一行起点上的「两格都非空」检查（CV 与角色名） */
  const rowLooksValid = (rowStart: number): boolean =>
    at(rowStart, cvAt).length > 0 &&
    at(rowStart, charAt).length > 0 &&
    at(rowStart, charAt).length <= 24 &&
    parseChapterTitle(at(rowStart, charAt)) === null &&
    parseChapterTitle(at(rowStart, cvAt)) === null

  /**
   * 从 from 起找下一条的起始行。
   *
   * ### ① 必须要求序号递增
   *   最早的实现只找「下一个纯数字」，而正文里数字遍地都是（年份、金额），
   *   于是把整段正文当角色表继续读 —— 真机表现：正文行数从 6823 掉到 2893、
   *   章节只剩 40。所以候选序号必须**正好等于当前序号 + 1**。
   *
   * ### ② 撞上章节标题必须立刻终止
   *   否则条目会越过章节把所有章的表并成一张，正文一行不剩 ——
   *   真机表现：角色表 750 条、正文 0 行。表格不可能跨章。
   *
   * ### ③ 搜索上界 = 上一条实际跨度的 1.5 倍（**本函数最关键的参数**）
   *   曾经用固定的 64 行窗口，结果**越过了正文**：真实画本每章末尾都有一张
   *   小角色表，而它的序号又从 `1` 开始。当当前表的序号恰好也走到 `1` 时，
   *   `1 + 1 = 2` 就会在**下一张表**里成立，中间整段正文被当成角色表吞掉 ——
   *   合成 fixture 实测：12 章 × 8 句旁白**全部消失**（旁白 96 → 0），
   *   而章节号与对白行数却完全正常，只看摘要根本发现不了。
   *
   *   条目跨度由「这一条有几列非空」决定（实测 8/10/12 混杂），
   *   相邻两条不会差出 50%，所以 1.5 倍上界既够宽、又拦得住跨表误跳。
   *
   * @returns 下一条的起始行；找不到返回 -1
   */
  const nextRowStart = (from: number, currentSeq: number | null, lastSpan: number): number => {
    const hardStop = Math.min(lines.length, from + Math.ceil(lastSpan * 1.5) + 2)
    for (let k = from; k < hardStop; k++) {
      const t = (lines[k] ?? '').trim()
      if (t.length === 0) continue

      if (parseChapterTitle(t)) return -1

      if (seqAt !== undefined) {
        const start = k - seqAt
        if (start <= from - minSpan) continue
        if (!/^\d+$/.test(t)) continue
        const seq = Number(t)
        if (currentSeq !== null && seq !== currentSeq + 1) continue
        // 序号对上了但格子不像条目 → 这是别的表/正文里的巧合数字，就此收尾
        if (!rowLooksValid(start)) return -1
        return start
      }

      const start = k - Math.min(cvAt, charAt)
      if (rowLooksValid(start)) return start
    }
    return -1
  }

  let cursor = dataStart
  let added = 0
  let currentSeq: number | null = seqAt !== undefined ? Number(at(cursor, seqAt)) : null
  let lastSpan = minSpan

  while (cursor + maxCol < lines.length) {
    const cv = at(cursor, cvAt)
    const character = at(cursor, charAt)
    if (cv.length === 0 || character.length === 0) break
    if (parseChapterTitle(cv) || parseChapterTitle(character)) break
    if (character.length > 24) break

    if (seqAt !== undefined) {
      const seqRaw = at(cursor, seqAt)
      if (!/^\d+$/.test(seqRaw)) break
    }

    const description = at(cursor, descAt)
    const countRaw = at(cursor, countAt)
    const lineCount = /^\d+$/.test(countRaw) ? Number(countRaw) : null

    out.push({
      cv,
      character,
      description: description.length > 0 ? description : null,
      lineCount,
      sourceLine: cursor + charAt,
    })
    added++
    if (added > 20_000) break

    // 找下一条。
    //
    // ⚠️ **「找不到下一条」不等于出错** —— 最后一条后面本来就没有下一条。
    // 这里必须先把当前条目收下、再尝试找下一条；把「找不到」当成失败会
    // 让每张表都少读最后一条。
    //
    // 搜索起点用**上一条的实际跨度** `lastSpan`，而不是固定的 `minSpan`：
    // 条目的行跨度取决于「这一条有多少列非空」（描述为空→10，有描述→12，
    // 真实文档实测 8/10/12 三种混杂）。从错误的位置起搜会直接跳过下一条的序号，
    // 结果就是「整张表只读出 1 条」—— 这是本函数最后一次修正的 bug。
    const searchFrom = cursor + Math.max(minSpan, lastSpan)
    const next = nextRowStart(searchFrom, currentSeq, lastSpan)
    if (next < 0 || next <= cursor) break

    lastSpan = next - cursor
    cursor = next
    if (seqAt !== undefined) {
      const s = at(cursor, seqAt)
      currentSeq = /^\d+$/.test(s) ? Number(s) : null
    }
  }

  return cursor - dataStart + minSpan
}

/**
 * 解析画本纯文本。
 *
 * @param text 画本正文（已由主进程用 mammoth 从 .docx 抽出）
 */
export function parseCanvasText(text: string): ParsedCanvas {
  const rawLines = String(text ?? '').split(/\r?\n/)
  // 只去首尾空白，**保留空行**：角色表靠「表头 + 连续短行」识别，
  // 而 mammoth 抽表格时每个单元格各占一行、单元格之间可能有空行。
  const lines = rawLines.map((l) => l.trim())

  const roster: CanvasRosterEntry[] = []
  const parsedLines: CanvasParsedLine[] = []
  const warnings: CanvasParseWarning[] = []
  const chapterSet = new Set<number>()

  let currentChapter: { chapterNo: number; title: string } | null = null
  let warnedBeforeChapter = false

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!
    if (text.length === 0) continue

    // ── ① 章节标题 ──────────────────────────────────────────────────────────
    const chapter = parseChapterTitle(text)
    if (chapter) {
      currentChapter = chapter
      chapterSet.add(chapter.chapterNo)
      continue
    }

    // ── ② 角色表 ────────────────────────────────────────────────────────────
    // 先看这里能不能读出一个表头；能的话就把紧随其后的行按列读成条目。
    // 注意：角色表**只出现在正文之前或章与章之间**，但真实样本里它在第 2201 章
    // 之后又出现了一次（且出现很多次），所以这里不做「只认开头」的假设，全文都试。
    const header = readRosterHeader(lines, i)
    if (header) {
      const before = roster.length
      const consumed = consumeRosterRows(lines, header, roster)
      // 只要真的读出了条目，就跳过「表头 + 条目」这一段。
      // 一条都没读出来时**不跳过**（否则会把表头之后的正文行整段吃掉）。
      if (roster.length > before) {
        i = header.headerEnd + consumed - 1
        continue
      }
    }

    // ── ③ 正文行 ────────────────────────────────────────────────────────────
    if (!currentChapter) {
      // 章节标题之前的非角色表内容：可能是书名、目录、说明。只警告一次。
      if (!warnedBeforeChapter) {
        warnedBeforeChapter = true
        warnings.push({
          sourceLine: i,
          reason: 'line-before-first-chapter',
          detail: '在第一个章节标题之前出现了正文内容，已忽略',
          sample: text.slice(0, 60),
        })
      }
      continue
    }

    const markers = [...text.matchAll(SPEAKER_MARKER_RE)]
    if (markers.length === 0) {
      parsedLines.push({
        chapterNo: currentChapter.chapterNo,
        chapterTitle: currentChapter.title,
        sourceLine: i,
        kind: 'narration',
        owners: [],
        segments: [],
        dialogueText: '',
        rawText: text,
      })
      continue
    }

    // 有标记：逐段拆出「说话人 + 台词 + 字符偏移」。
    // owner 为 null 的段是**群白**（`【异口同声】` 这类没有 `CV-角色` 的标记）——
    // 这是真实样本里存在的合法写法，不是畸形标记，所以只归类、不告警。
    const owners: CanvasLineOwner[] = []
    const segments: CanvasSpeakerSegment[] = []
    const seenOwner = new Set<string>()

    for (let k = 0; k < markers.length; k++) {
      const mk = markers[k]!
      const inner = mk[1]!
      const owner = splitSpeakerMarker(inner)
      const textStart = mk.index! + mk[0]!.length
      const textEnd = k + 1 < markers.length ? markers[k + 1]!.index! : text.length
      /**
       * 该段的台词文本：**去标记之后、去掉最外层引号**。
       *
       * ⚠️ 已知局限（如实记录）：`stripQuotes` 只剥**最外层一对**引号，
       * 所以同一行里各段的形态可能不一致 —— 例如
       * `“A！”苦笑，` 保留引号、而 `“B！”` 被剥成 `B！`。
       *
       * 需要区分「台词 / 旁白」时不能只靠这个字段：本模块的 `segments` 保留了
       * 每段在 `rawText` 里的真实偏移（`textStart`/`textEnd`），
       * 要精确切分应当基于 `rawText` 联合偏移来做（docs/91 §5.2.49 有记录）。
       *
       * 注意：**真正落库的画本导入不走这里** —— 它走
       * `src/shared/text/canvas-script.ts` 的 `parseCanvasScript`，
       * 那个解析器按引号切分台词与旁白（见那里的 `extractSpeech`）。
       */
      const segText = stripQuotes(text.slice(textStart, textEnd).trim()).trim()

      if (owner) {
        const key = `${owner.cv}\u0000${owner.character}`
        if (!seenOwner.has(key)) {
          seenOwner.add(key)
          owners.push(owner)
        }
      }

      segments.push({
        owner,
        markerRaw: mk[0]!,
        text: segText,
        textStart,
        textEnd,
      })
    }

    // 全是群白标记（没有任何 CV-角色）→ kind = 'group'，与旁白区分开
    const kind: CanvasParsedLine['kind'] = owners.length > 0 ? 'dialogue' : 'group'

    parsedLines.push({
      chapterNo: currentChapter.chapterNo,
      chapterTitle: currentChapter.title,
      sourceLine: i,
      kind,
      owners,
      segments,
      dialogueText: segments
        .map((s) => s.text)
        .filter((t) => t.length > 0)
        .join(' ')
        .trim(),
      rawText: text,
    })
  }

  return {
    roster: mergeRoster(roster),
    lines: parsedLines,
    chapters: [...chapterSet].sort((a, b) => a - b),
    warnings,
  }
}

/**
 * 合并多次出现的角色表。
 *
 * 真实样本里角色表重复出现（第 2201 章之后又有一次）。同一 CV 的条目可能：
 *   · 完全相同 → 去重
 *   · 不同角色 → 全部保留（一个 CV 配多个角色是常态）
 * 因此键是 `CV + '\u0000' + 角色名`。
 * CV 为空时用角色名当键（否则所有空 CV 条目会互相覆盖）。
 */
function mergeRoster(entries: CanvasRosterEntry[]): CanvasRosterEntry[] {
  const seen = new Set<string>()
  const out: CanvasRosterEntry[] = []
  for (const e of entries) {
    const key = `${e.cv ?? ''}\u0000${e.character}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

/**
 * 去掉对白两侧的引号（中英文都处理）。
 *
 * 真实画本用 `“…”`；但也可能是 `"…"`、`『…』`、`「…」`。
 * 只去**最外层**的一对，不改动内部引号（内部引号可能是台词的一部分）。
 */
export function stripQuotes(text: string): string {
  const t = text.trim()
  const pairs: Array<[string, string]> = [
    ['“', '”'],
    ['"', '"'],
    ['『', '』'],
    ['「', '」'],
    ['‘', '’'],
    ["'", "'"],
  ]
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      return t.slice(open.length, t.length - close.length)
    }
  }
  return t
}

// ---------------------------------------------------------------------------
// 查询辅助（给「按说话人导入」用）
// ---------------------------------------------------------------------------

/**
 * 取某个 CV 在指定章节区间内的所有对白行。
 *
 * @param maxChapters 安全上限：区间写成 `1-999999` 时不要把整个文档都算上
 */
export function linesByCv(
  canvas: ParsedCanvas,
  cv: string,
  range?: { from: number; to: number },
  maxChapters = 2000,
): CanvasParsedLine[] {
  const target = normalizeName(cv)
  const span = range ? Math.min(range.to - range.from + 1, maxChapters) : Infinity
  const hardTo = range ? range.from + span - 1 : Infinity
  return canvas.lines.filter(
    (l) =>
      l.kind === 'dialogue' &&
      (!range || (l.chapterNo >= range.from && l.chapterNo <= hardTo)) &&
      l.owners.some((o) => normalizeName(o.cv) === target),
  )
}

/** 取某个角色在指定章节区间内的所有对白行 */
export function linesByCharacter(
  canvas: ParsedCanvas,
  character: string,
  range?: { from: number; to: number },
  maxChapters = 2000,
): CanvasParsedLine[] {
  const target = normalizeName(character)
  const span = range ? Math.min(range.to - range.from + 1, maxChapters) : Infinity
  const hardTo = range ? range.from + span - 1 : Infinity
  return canvas.lines.filter(
    (l) =>
      l.kind === 'dialogue' &&
      (!range || (l.chapterNo >= range.from && l.chapterNo <= hardTo)) &&
      l.owners.some((o) => normalizeName(o.character) === target),
  )
}

/** 取某章节区间内的旁白行 */
export function narrationLines(
  canvas: ParsedCanvas,
  range: { from: number; to: number },
  maxChapters = 2000,
): CanvasParsedLine[] {
  const hardTo = range.from + Math.min(range.to - range.from + 1, maxChapters) - 1
  return canvas.lines.filter(
    (l) => l.kind === 'narration' && l.chapterNo >= range.from && l.chapterNo <= hardTo,
  )
}

/**
 * 名字归一化（**用于比较**）：去空白、大小写折叠。
 *
 * 与 `filename.ts` 的 `normalizeToken` 保持同一套规则 ——
 * 两边不一致会出现「文件名能解析、却匹配不上角色表」这种诡异现象。
 */
export function normalizeName(name: string): string {
  return String(name ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u3000\s]+/g, '')
    .trim()
    .toLowerCase()
}

/** 画本里出现过的全部 CV（去重、按出现顺序） */
export function listCvs(canvas: ParsedCanvas): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of canvas.lines) {
    for (const o of l.owners) {
      const k = normalizeName(o.cv)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(o.cv)
    }
  }
  return out
}

/** 画本里出现过的全部角色名（去重、按出现顺序） */
export function listCharacters(canvas: ParsedCanvas): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of canvas.lines) {
    for (const o of l.owners) {
      const k = normalizeName(o.character)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(o.character)
    }
  }
  return out
}
