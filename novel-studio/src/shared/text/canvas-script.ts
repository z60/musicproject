/**
 * Novel Studio · 画本脚本解析（已经是画本格式的文档）
 * ============================================================================
 * 设计依据：真实样本「样本/进球吧，教练-画本【第1章-第500章】.docx」的格式：
 *
 *   · 台词行：【角色名-CV名】“台词”（CV 可省略，写成 【角色名】“台词”）
 *   · 旁白行：其余非空段落
 *   · 每章末尾有一张**角色表**，列依次是：
 *       序号 / CV / 角色名 / 性别 / 角色描述 / 台词数 / 音色 / 年龄
 *     注意：**空单元格在转文本时会被丢掉**，所以同一张表里各行可能只有 5~8 列，
 *     不能按「正好 8 列 / 正好 8 行」去认（实测样本里 1151 行因此漏切进了正文）。
 *
 * ### 台词不一定独占一行（真机实测的三种形态）
 *   1. 旁白在前：某某皱眉道：【克莱门特-好风长吟】“这场比赛不好踢。”
 *   2. 旁白在后：【弗洛伦蒂诺-天山雪豹】“你们谁能告诉我……”弗洛伦蒂诺沉声问着面前的众人。
 *   3. 带标注：  （OS）【杨浩-嬉小天】“回头问问，看他有没有兴趣来马竞。”
 *   因此解析时按【…】把一行拆成「旁白 / 台词 / 旁白」，并只把**像说话人标记**的
 *   【…】当台词：标记里含 - （角色-CV），或【…】后面紧跟引号。
 *   这样才不会把【贝利法案】、【复仇者联盟】这种正文方括号误当成角色。
 *
 * 角色表在**两种形态**下都要能认：
 *   1. 每个单元格一行（直接解压 word/document.xml 时的形态）
 *   2. 整行 pipe 连接：序号 | CV | 角色名 | ... （mammoth 把 <tr> 转成的单行）
 *
 * 这个模块只做「文本 → 结构化」，不碰数据库、不依赖第三方包，因此可以在
 * node --experimental-strip-types 下直接跑测试。
 */

import type {
  CanvasScriptCharacter,
  CanvasScriptChapter,
  CanvasScriptLine,
} from '../types.ts'
import { normalizeNewlines } from './encoding.ts'

/** 角色表的固定表头（顺序即列顺序） */
export const CANVAS_CHARACTER_TABLE_HEADER = [
  '序号',
  'CV',
  '角色名',
  '性别',
  '角色描述',
  '台词数',
  '音色',
  '年龄',
] as const

/** 把【角色-CV】里的内容拆成 角色名 / CV */
export function splitSpeakerTag(tag: string): { speaker: string; cv: string | null } {
  const idx = tag.indexOf('-')
  if (idx < 0) return { speaker: tag.trim(), cv: null }
  const speaker = tag.slice(0, idx).trim()
  const cv = tag.slice(idx + 1).trim()
  return { speaker, cv: cv.length > 0 ? cv : null }
}

/** 引号开 → 闭 */
const QUOTE_CLOSE: Record<string, string> = {
  '“': '”',
  '「': '」',
  '『': '』',
  '"': '"',
  "'": "'",
}

/**
 * 从 from 起取一段台词。
 *
 * ### 规则
 *   1. 跳过空白
 *   2. **跳过连续出现的 `【…】` 标记** —— 见下面「为什么」
 *   3. 有引号就取到闭合引号（没有闭合就取到行尾）
 *   4. 仍然没有引号，就取到下一个 `【` 或行尾
 *
 * ### 为什么第 2 步是必须的（真实缺陷）
 *   真实画本里有这样的行：
 *
 *   ```
 *   【异口同声】【阡陌丨平凡-男龙套 3】“对！哈哈哈！”【异口同声】【鱼头一颗糖-男龙套2】“对！哈哈哈！”…
 *   ```
 *
 *   `【异口同声】` 是个**群白标记**：它不含 `-`（所以 `looksLikeSpeakerTag` 不认它），
 *   而它后面紧跟的是**另一个 `【`** 而不是引号（所以 `quotedAfter` 也是 false）。
 *   于是旧逻辑走到「取到下一个 `【` 或行尾」这条分支，取到**空串**，
 *   而调用方拿这个空串去做 `pushNarration` —— 结果把 `【异口同声】` 这个**标记本身**
 *   落成了一条旁白行。
 *
 *   一条这样的源行会因此多出 3 条 `【异口同声】` 旁白行（实测），
 *   界面上看起来就是「凭空多出来几行旁白」。
 *
 *   跳掉这些前导标记之后，`probe.quoted` 就能正确反映「后面确实有引号台词」，
 *   调用方也就能把它当成**群白台词**处理，而不是一条垃圾旁白。
 *
 * @returns `speech` 已去空白；`start` 是台词在原文里的起始位置（跳标记之后）
 */
export function extractSpeech(
  text: string,
  from: number,
): { speech: string; end: number; quoted: boolean; start: number } {
  let i = from
  // 跳过空白与连续的【…】标记（只跳「整块标记」，不会吃掉正常文字）
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? '')) i++
    if (text[i] !== '【') break
    const closeIdx = text.indexOf('】', i + 1)
    if (closeIdx < 0) break // 没闭合的【：不再跳，交给下面的分支
    i = closeIdx + 1
  }
  const start = i

  const open = text[i]
  const close = open === undefined ? undefined : QUOTE_CLOSE[open]
  if (open !== undefined && close !== undefined) {
    const closeIdx = text.indexOf(close, i + 1)
    if (closeIdx >= 0) {
      return { speech: text.slice(i + 1, closeIdx).trim(), end: closeIdx + 1, quoted: true, start }
    }
    return { speech: text.slice(i + 1).trim(), end: text.length, quoted: true, start }
  }
  const nextTag = text.indexOf('【', i)
  const end = nextTag >= 0 ? nextTag : text.length
  return { speech: text.slice(i, end).trim(), end, quoted: false, start }
}

/** 一个【…】是不是说话人标记：含 -（角色-CV）或后面紧跟引号 */
export function looksLikeSpeakerTag(tag: string, quotedAfter: boolean): boolean {
  return tag.includes('-') || quotedAfter
}

/** 整段只是一个括号注释（（OS）／（建议CV老师…））→ 返回它本身，否则 null */
export function onlyParenthetical(text: string): string | null {
  const t = text.trim()
  if (t.length >= 2 && /^[（(]/.test(t) && /[）)]$/.test(t)) return t
  return null
}

/** 标注是不是「画外/内心」（（OS）等） */
export function isInnerNote(note: string): boolean {
  return /(^|[^a-z])os([^a-z]|$)/i.test(note) || /内心|画外|心声/.test(note)
}

// ---------------------------------------------------------------------------
// 角色表
// ---------------------------------------------------------------------------

/**
 * 一行 pipe 表格（a | b | ...）→ 各单元格。
 *
 * ⚠️ **不要求列数固定**：mammoth 把 <tr> 转文本时，**空单元格会被丢掉**，
 * 于是同一张角色表里会出现 5 / 6 / 7 / 8 列的不同行（实测样本里 1151 行因此漏切、
 * 直接变成了旁白台词）。这里只要求至少 2 段。
 */
export function splitCanvasTableRow(line: string): string[] | null {
  if (!line.includes('|')) return null
  const cells = line.split('|').map((c) => c.trim())
  return cells.length >= 2 ? cells : null
}

/** 角色表的列位置（按**表头文字**定位，列顺序与列数都可变） */
export interface CharacterTableColumns {
  idx: number | null
  cv: number | null
  name: number | null
  gender: number | null
  description: number | null
  lineCount: number | null
  voice: number | null
  age: number | null
}

/** 表头文字 → 列语义（真机样本里列顺序/列数都不一样，只能按文字认） */
const COLUMN_LABELS: Array<{ key: keyof CharacterTableColumns; labels: readonly string[] }> = [
  { key: 'idx', labels: ['序号'] },
  { key: 'cv', labels: ['CV', 'cv', '配音员', '配音'] },
  { key: 'name', labels: ['角色名', '角色', '人物', '姓名'] },
  { key: 'gender', labels: ['性别'] },
  { key: 'description', labels: ['角色描述', '描述'] },
  { key: 'lineCount', labels: ['台词数', '台词'] },
  { key: 'voice', labels: ['音色'] },
  { key: 'age', labels: ['年龄'] },
]

/**
 * 按**表头文字**解析列位置。
 *
 * 真机样本列数/顺序都不同：
 *   · `序号 | CV | 角色名 | 性别 | 角色描述 | 台词数 | 音色 | 年龄`（8 列，进球吧）
 *   · `序号 | CV | 角色名 | 角色描述 | 台词数 | 音色`（**没有性别**，6 列，崛起香江）
 * 只要认得 CV 与角色名两列就够（其余列缺失时对应字段为 null）。
 */
export function mapCharacterColumns(cells: readonly string[]): CharacterTableColumns | null {
  const norm = cells.map((c) => (c ?? '').trim())
  const out: CharacterTableColumns = {
    idx: null, cv: null, name: null, gender: null, description: null, lineCount: null, voice: null, age: null,
  }
  for (const { key, labels } of COLUMN_LABELS) {
    const at = norm.findIndex((c) => c.length > 0 && labels.some((l) => c === l))
    if (at >= 0) out[key] = at
  }
  // 至少要能定位「CV」与「角色名」，否则不是角色表头（避免把普通含 | 的正文当表）
  if (out.cv === null || out.name === null) return null
  return out
}

/** 固定 8 列形态（「每格一行」）的列位置 */
const FIXED_COLUMNS: CharacterTableColumns = {
  idx: 0, cv: 1, name: 2, gender: 3, description: 4, lineCount: 5, voice: 6, age: 7,
}

/** 是否是角色表表头（按列名识别，不要求固定列数/顺序） */
export function isCanvasTableHeader(cells: readonly string[]): boolean {
  return mapCharacterColumns(cells) !== null
}

/** 角色表：CV 集合与角色名集合，用于判定【A-B】里哪边是角色 */
export interface SpeakerTableContext {
  cvSet: ReadonlySet<string>
  roleSet: ReadonlySet<string>
}

/**
 * 解析说话人标记 `【A-B】`。
 *
 * ⚠️ **两份真机样本的顺序是相反的**：
 *   · 进球吧：`【杨浩-嬉小天】` → 角色名-CV（表里 CV=嬉小天）
 *   · 崛起香江：`【阿翼爱热闹-男龙套3】` → **CV-角色名**（表里 CV=阿翼爱热闹）
 * 所以不能写死顺序，要用**角色表**判断哪边是 CV、哪边是角色名；
 * 表里都查不到时（纯台词书没有角色表）沿用既有假设「角色名-CV名」。
 */
/**
 * 由一批角色（可来自多章的角色表）汇总出说话人消歧上下文。
 *
 * ⚠️ 逐章解析时**必须**先把全书的角色表汇总再传进 `parseCanvasScript`：
 * 真机样本的角色表只在全书最前面的「前言」章里，逐章解析时其它章根本没有表，
 * `【CV-角色】` 的顺序无从判断，角色会被建成 CV。
 */
export function speakerContextOf(
  characters: Iterable<{ name: string; cv: string | null }>,
): SpeakerTableContext {
  const cvSet = new Set<string>()
  const roleSet = new Set<string>()
  for (const c of characters) {
    roleSet.add(c.name)
    if (c.cv) cvSet.add(c.cv)
  }
  return { cvSet, roleSet }
}

export function resolveSpeakerTag(
  tag: string,
  ctx: SpeakerTableContext,
): { speaker: string; cv: string | null } {
  const dash = tag.indexOf('-')
  if (dash < 0) return { speaker: tag.trim(), cv: null }
  const a = tag.slice(0, dash).trim()
  const b = tag.slice(dash + 1).trim()
  if (a.length === 0) return { speaker: b, cv: null }
  if (b.length === 0) return { speaker: a, cv: null }

  const aCv = ctx.cvSet.has(a)
  const bCv = ctx.cvSet.has(b)
  const aRole = ctx.roleSet.has(a)
  const bRole = ctx.roleSet.has(b)

  // ① 一边是 CV、另一边是角色名 → 角色名当说话人，CV 记进 cv
  if (bRole && !aRole && !aCv) return { speaker: b, cv: a } // 【CV-角色】
  if (aRole && !bRole && !bCv) return { speaker: a, cv: b } // 【角色-CV】

  // ② 只有一边在角色表出现 → 它就是角色名
  if (aRole && !bRole) return { speaker: a, cv: b }
  if (bRole && !aRole) return { speaker: b, cv: a }

  // ③ 只有一边是 CV → 另一边就是角色名
  if (aCv && !bCv) return { speaker: b, cv: a }
  if (bCv && !aCv) return { speaker: a, cv: b }

  // ④ 表里查不到：沿用「角色名-CV名」
  return { speaker: a, cv: b }
}

/** 表头是否从第 i 行开始（每格一行的形态） */
function isCellHeaderAt(lines: readonly string[], i: number): boolean {
  for (let k = 0; k < CANVAS_CHARACTER_TABLE_HEADER.length; k++) {
    if ((lines[i + k] ?? '').trim() !== CANVAS_CHARACTER_TABLE_HEADER[k]) return false
  }
  return true
}

/** 「每格一行」形态下，角色表结束后的下标（表头 + 若干组 8 行数据） */
function cellTableEnd(lines: readonly string[], start: number): number {
  let i = start + CANVAS_CHARACTER_TABLE_HEADER.length
  while (i + CANVAS_CHARACTER_TABLE_HEADER.length <= lines.length) {
    if (!/^\d+$/.test((lines[i] ?? '').trim())) break
    i += CANVAS_CHARACTER_TABLE_HEADER.length
  }
  return i
}

/** 一行单元格 → 角色（按列位置取值；角色名为空则丢弃） */
function pushCharacter(
  cells: readonly string[],
  out: CanvasScriptCharacter[],
  cols: CharacterTableColumns,
): void {
  const cell = (k: number | null): string => (k === null ? '' : (cells[k] ?? '').trim())
  const name = cell(cols.name)
  if (name.length === 0) return
  const cv = cell(cols.cv)
  const gender = cell(cols.gender)
  const description = cell(cols.description)
  const lineCount = cell(cols.lineCount)
  const voice = cell(cols.voice)
  const age = cell(cols.age)
  out.push({
    name,
    cv: cv.length > 0 ? cv : null,
    gender: gender.length > 0 ? gender : null,
    description: description.length > 0 ? description : null,
    lineCountText: lineCount.length > 0 ? lineCount : null,
    voiceType: voice.length > 0 ? voice : null,
    ageText: age.length > 0 ? age : null,
  })
}

/** 扫描「每格一行」形态的角色表，返回表格结束后的下标 */
function scanCellTable(lines: readonly string[], start: number, out: CanvasScriptCharacter[]): number {
  const end = cellTableEnd(lines, start)
  for (let i = start + CANVAS_CHARACTER_TABLE_HEADER.length; i < end; i += CANVAS_CHARACTER_TABLE_HEADER.length) {
    const cells = Array.from({ length: CANVAS_CHARACTER_TABLE_HEADER.length }, (_, k) =>
      (lines[i + k] ?? '').trim(),
    )
    pushCharacter(cells, out, FIXED_COLUMNS)
  }
  return end
}

// ---------------------------------------------------------------------------
// 主解析
// ---------------------------------------------------------------------------

/**
 * 解析一章（或任意一段）画本文本。
 *
 * @param options.chapterTitle 该章标题；给了就把「与标题完全相同的第一行旁白」丢掉 ——
 *   与画本生成一致：要不要朗读标题由「插入章首标题念白行」单独决定。
 *
 * 失败语义：**不抛异常**。解析不出来就当普通旁白。
 */
export interface ParseCanvasOptions {
  chapterTitle?: string
  /**
   * 全书角色表上下文（由 `speakerContextOf` 从各章角色表汇总）。
   * 逐章解析时**必须**传，否则 `【CV-角色】` 的顺序无法判断。
   */
  speakerContext?: SpeakerTableContext
}

export function parseCanvasScript(
  text: string,
  options: ParseCanvasOptions = {},
): CanvasScriptChapter {
  const lines = normalizeNewlines(text).split('\n')
  const outLines: CanvasScriptLine[] = []
  const characters: CanvasScriptCharacter[] = []
  /** 角色表占用的行（第二遍要跳过，否则表格数据会变成旁白） */
  const tableLines = new Set<number>()

  // ── Pass 1：先把**角色表**整表收掉 ──────────────────────────────────────
  //    为什么必须先扫一遍：说话人标记是【A-B】，哪边是 CV 要看角色表——
  //    真机两份样本的顺序**相反**（进球吧=角色-CV，崛起香江=CV-角色），
  //    没有表就无法判断。表通常在章末或前言，可能在台词之后。
  {
    let k = 0
    while (k < lines.length) {
      const t = (lines[k] ?? '').trim()
      // 形态一：每格一行（固定 8 列）
      if (t === CANVAS_CHARACTER_TABLE_HEADER[0] && isCellHeaderAt(lines, k)) {
        const end = scanCellTable(lines, k, characters)
        for (let x = k; x < end; x++) tableLines.add(x)
        k = end
        continue
      }
      // 形态二：整行 pipe（按列名识别，列数/顺序可变）
      const header = splitCanvasTableRow(t)
      const cols = header ? mapCharacterColumns(header) : null
      if (header && cols) {
        let j = k + 1
        while (j < lines.length) {
          const row = splitCanvasTableRow((lines[j] ?? '').trim())
          if (!row) break
          const first = row[cols.idx ?? 0] ?? ''
          if (!/^\d+$/.test(first)) break
          pushCharacter(row, characters, cols)
          j++
        }
        for (let x = k; x < j; x++) tableLines.add(x)
        k = j
        continue
      }
      k++
    }
  }

  /** 角色表 → 说话人标记消歧（调用方给的**全书**上下文 + 本章自己的表） */
  const cvSet = new Set<string>(options.speakerContext?.cvSet ?? [])
  const roleSet = new Set<string>(options.speakerContext?.roleSet ?? [])
  for (const c of characters) {
    roleSet.add(c.name)
    if (c.cv) cvSet.add(c.cv)
  }
  const tagContext: SpeakerTableContext = { cvSet, roleSet }

  // ── Pass 2：逐行解析（跳过角色表行）──────────────────────────────────────
  let offset = 0
  let i = 0
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const trimmed = raw.trim()

    if (tableLines.has(i)) {
      offset += raw.length + 1
      i++
      continue
    }

    if (trimmed.length > 0) {
      const leading = raw.length - raw.trimStart().length
      const trimmedStart = offset + leading
      const pushNarration = (part: string, relStart: number): void => {
        const t = part.trim()
        if (t.length === 0) return
        outLines.push({
          speaker: null,
          cv: null,
          text: t,
          kind: 'narration',
          sourceText: trimmed,
          charStart: trimmedStart + relStart,
          charEnd: trimmedStart + relStart + t.length,
        })
      }

      // 按【…】把一行拆成「旁白 / 台词 / 旁白」（见文件头说明）
      const tagRe = /【([^】]+)】/g
      let cursor = 0
      let foundSpeaker = false
      let match: RegExpExecArray | null
      while ((match = tagRe.exec(trimmed)) !== null) {
        const tag = match[1] ?? ''
        const tagStart = match.index
        const tagEnd = tagStart + match[0].length
        const probe = extractSpeech(trimmed, tagEnd)
        if (!looksLikeSpeakerTag(tag, probe.quoted)) continue
        foundSpeaker = true

        const before = trimmed.slice(cursor, tagStart)
        const note = onlyParenthetical(before)
        if (note === null) pushNarration(before, cursor)

        const { speaker, cv } = resolveSpeakerTag(tag, tagContext)
        if (speaker.length > 0 && probe.speech.length > 0) {
          outLines.push({
            speaker,
            cv,
            text: probe.speech,
            kind: note !== null && isInnerNote(note) ? 'inner' : 'dialogue',
            sourceText: trimmed,
            ...(note !== null ? { note } : {}),
            charStart: trimmedStart + tagStart,
            charEnd: trimmedStart + probe.end,
          })
        }

        cursor = probe.end
        tagRe.lastIndex = cursor
      }

      if (!foundSpeaker) {
        pushNarration(trimmed, 0)
      } else {
        pushNarration(trimmed.slice(cursor), cursor)
      }
    }

    offset += raw.length + 1
    i++
  }

  // 章标题行不算台词（见 options.chapterTitle 说明）
  const chapterTitle = options.chapterTitle?.trim()
  if (chapterTitle && outLines.length > 0) {
    const first = outLines[0]!
    if (first.kind === 'narration' && first.text === chapterTitle) outLines.shift()
  }

  // 去重（同一角色会在多个章节表里重复出现）
  const deduped: CanvasScriptCharacter[] = []
  const seen = new Set<string>()
  for (const c of characters) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    deduped.push(c)
  }

  return { characters: deduped, lines: outLines }
}

/**
 * 把角色表从**正文**里抹掉：表头与数据行的可见字符全部替换为空格，**总长度与换行位置完全不变**。
 *
 * 为什么用等长空格而不是删行：
 *   · 画本行的 charStart / charEnd 是相对本章正文的偏移，删行会让所有偏移错位；
 *   · 等长替换后偏移依旧成立，同时「CV / 角色名 / 台词数 不再出现在正文」的目标也达成。
 *
 * 典型用法：先对**原文**调用 parseCanvasScript 拿到角色与画本行，再对同一段原文调用本函数，
 * 用返回的文本作为入库的章节正文（预览与画布正文都不再出现角色表）。
 */
export function blankCanvasCharacterTables(text: string): string {
  const src = normalizeNewlines(text)
  const lines = src.split('\n')
  const blank = (idx: number): void => {
    const line = lines[idx] ?? ''
    if (line.length > 0) lines[idx] = ' '.repeat(line.length)
  }

  let i = 0
  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim()

    // 形态一：每格一行
    if (trimmed === CANVAS_CHARACTER_TABLE_HEADER[0] && isCellHeaderAt(lines, i)) {
      const end = cellTableEnd(lines, i)
      for (let k = i; k < end; k++) blank(k)
      i = end
      continue
    }

    // 形态二：整行 pipe 连接（列数/顺序不固定，按列名识别）
    const pipe = splitCanvasTableRow(trimmed)
    const pipeCols = pipe ? mapCharacterColumns(pipe) : null
    if (pipe && pipeCols) {
      let j = i + 1
      while (j < lines.length) {
        const row = splitCanvasTableRow((lines[j] ?? '').trim())
        if (!row) break
        const first = row[pipeCols.idx ?? 0] ?? ''
        if (!/^\d+$/.test(first)) break
        j++
      }
      for (let k = i; k < j; k++) blank(k)
      i = j
      continue
    }

    i++
  }

  return lines.join('\n')
}

export interface CanvasScriptDetection {
  /** 是否看起来是画本格式 */
  isCanvas: boolean
  /** 含说话人标记的行数 */
  dialogueLines: number
  /** 角色表里的角色数 */
  characterRows: number
  /** 非空段落数 */
  paragraphs: number
}

/**
 * 判断一段文本是否「已经是画本格式」。
 *
 * 判据（保守，宁可让用户手动勾选也不要误判）：
 *   · 至少有一行含**说话人标记**（【角色-CV】，或【角色】后紧跟引号）
 *   · 或者出现了角色表表头（两种形态都算）
 */
export function detectCanvasScript(text: string): CanvasScriptDetection {
  const lines = normalizeNewlines(text).split('\n')
  let dialogueLines = 0
  let characterRows = 0
  let paragraphs = 0

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed.length > 0) paragraphs++

    if (trimmed.includes('【')) {
      const tagRe = /【([^】]+)】/g
      let m: RegExpExecArray | null
      while ((m = tagRe.exec(trimmed)) !== null) {
        const tag = m[1] ?? ''
        const after = trimmed.slice(m.index + m[0].length)
        if (looksLikeSpeakerTag(tag, /^\s*[“「『"']/.test(after))) {
          dialogueLines++
          break
        }
      }
    }

    const pipeCells = splitCanvasTableRow(trimmed)
    const pipeCols = pipeCells ? mapCharacterColumns(pipeCells) : null
    if (pipeCells && pipeCols) {
      let j = i + 1
      while (j < lines.length) {
        const row = splitCanvasTableRow((lines[j] ?? '').trim())
        if (!row) break
        const first = row[pipeCols.idx ?? 0] ?? ''
        if (!/^\d+$/.test(first)) break
        characterRows++
        j++
      }
      continue
    }

    if (trimmed === CANVAS_CHARACTER_TABLE_HEADER[0] && isCellHeaderAt(lines, i)) {
      let j = i + CANVAS_CHARACTER_TABLE_HEADER.length
      while (
        j + CANVAS_CHARACTER_TABLE_HEADER.length <= lines.length &&
        /^\d+$/.test((lines[j] ?? '').trim())
      ) {
        characterRows++
        j += CANVAS_CHARACTER_TABLE_HEADER.length
      }
    }
  }

  return {
    isCanvas: dialogueLines > 0 || characterRows > 0,
    dialogueLines,
    characterRows,
    paragraphs,
  }
}
