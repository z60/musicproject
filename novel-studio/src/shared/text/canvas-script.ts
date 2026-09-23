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
 * 有引号就取到闭合引号（没有闭合就取到行尾）；没有引号就取到下一个【或行尾。
 */
export function extractSpeech(
  text: string,
  from: number,
): { speech: string; end: number; quoted: boolean } {
  let i = from
  while (i < text.length && /\s/.test(text[i] ?? '')) i++
  const open = text[i]
  const close = open === undefined ? undefined : QUOTE_CLOSE[open]
  if (open !== undefined && close !== undefined) {
    const closeIdx = text.indexOf(close, i + 1)
    if (closeIdx >= 0) {
      return { speech: text.slice(i + 1, closeIdx).trim(), end: closeIdx + 1, quoted: true }
    }
    return { speech: text.slice(i + 1).trim(), end: text.length, quoted: true }
  }
  const nextTag = text.indexOf('【', i)
  const end = nextTag >= 0 ? nextTag : text.length
  return { speech: text.slice(i, end).trim(), end, quoted: false }
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

/**
 * 是否是角色表表头。
 * 只校验**前 6 列前缀**（序号 / CV / 角色名 / 性别 / 角色描述 / 台词数）：
 * 空列被丢掉时，表头可能只剩 6 列（音色、年龄没了），按整体 8 列校验会整张漏掉。
 */
export function isCanvasTableHeader(cells: readonly string[]): boolean {
  const required = CANVAS_CHARACTER_TABLE_HEADER.slice(0, 6)
  if (cells.length < required.length) return false
  for (let k = 0; k < required.length; k++) {
    if (cells[k] !== required[k]) return false
  }
  return true
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

/** 8 个单元格 → 角色（角色名为空则丢弃） */
function pushCharacter(cells: readonly string[], out: CanvasScriptCharacter[]): void {
  const name = (cells[2] ?? '').trim()
  if (name.length === 0) return
  const cell = (k: number): string => (cells[k] ?? '').trim()
  out.push({
    name,
    cv: cell(1).length > 0 ? cell(1) : null,
    gender: cell(3).length > 0 ? cell(3) : null,
    description: cell(4).length > 0 ? cell(4) : null,
    lineCountText: cell(5).length > 0 ? cell(5) : null,
    voiceType: cell(6).length > 0 ? cell(6) : null,
    ageText: cell(7).length > 0 ? cell(7) : null,
  })
}

/** 扫描「每格一行」形态的角色表，返回表格结束后的下标 */
function scanCellTable(lines: readonly string[], start: number, out: CanvasScriptCharacter[]): number {
  const end = cellTableEnd(lines, start)
  for (let i = start + CANVAS_CHARACTER_TABLE_HEADER.length; i < end; i += CANVAS_CHARACTER_TABLE_HEADER.length) {
    const cells = Array.from({ length: CANVAS_CHARACTER_TABLE_HEADER.length }, (_, k) =>
      (lines[i + k] ?? '').trim(),
    )
    pushCharacter(cells, out)
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
export function parseCanvasScript(
  text: string,
  options: { chapterTitle?: string } = {},
): CanvasScriptChapter {
  const lines = normalizeNewlines(text).split('\n')
  const outLines: CanvasScriptLine[] = []
  const characters: CanvasScriptCharacter[] = []

  let offset = 0
  let i = 0
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const trimmed = raw.trim()

    // 表格形态一：每格一行
    if (trimmed === CANVAS_CHARACTER_TABLE_HEADER[0] && isCellHeaderAt(lines, i)) {
      const end = scanCellTable(lines, i, characters)
      for (let k = i; k < end; k++) offset += (lines[k] ?? '').length + 1
      i = end
      continue
    }

    // 表格形态二：整行 pipe 连接
    const firstRow = splitCanvasTableRow(trimmed)
    if (firstRow && isCanvasTableHeader(firstRow)) {
      let j = i + 1
      while (j < lines.length) {
        const row = splitCanvasTableRow((lines[j] ?? '').trim())
        if (!row || !/^\d+$/.test(row[0] ?? '')) break
        pushCharacter(row, characters)
        j++
      }
      for (let k = i; k < j; k++) offset += (lines[k] ?? '').length + 1
      i = j
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

        const { speaker, cv } = splitSpeakerTag(tag)
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

    // 形态二：整行 pipe 连接（列数不固定，见 splitCanvasTableRow 说明）
    const pipe = splitCanvasTableRow(trimmed)
    if (pipe && isCanvasTableHeader(pipe)) {
      let j = i + 1
      while (j < lines.length) {
        const row = splitCanvasTableRow((lines[j] ?? '').trim())
        if (!row || !/^\d+$/.test(row[0] ?? '')) break
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
    if (pipeCells && isCanvasTableHeader(pipeCells)) {
      let j = i + 1
      while (j < lines.length) {
        const row = splitCanvasTableRow((lines[j] ?? '').trim())
        if (!row || !/^\d+$/.test(row[0] ?? '')) break
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
