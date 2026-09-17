/**
 * Novel Studio · 画本质检（FR-2.4.8 / docs/11 §5）
 * ============================================================================
 * 设计依据：
 *   · docs/11 §5  12 种 issue 的定义与交互（一键修复只限安全项）
 *   · docs/11 §2.1  too_long（超过 maxLineChars）
 *   · docs/11 §2.2  引号不配对 → quote_unmatched
 *   · docs/11 §2.3  相邻同角色行 pauseAfterMs=0 会粘连 → no_pause
 *   · docs/06 §5.5  置信度与 decidedBy 的关系（suspicious_speaker 只在非人工时告警）
 *   · constants.ts  POLYPHONE_HINTS / CANVAS_DEFAULTS
 *
 * 零第三方依赖：只 import Node 内置与本仓库 src/shared/.ts。
 * 「片段文件是否存在」由调用方注入（production 用 fs.existsSync 填 `exists`），
 * 本模块不做任何文件系统访问——这样质检在渲染进程也能跑（预览）。
 */

import { AppError } from '../errors.ts'
import { CANVAS_DEFAULTS, POLYPHONE_HINTS } from '../constants.ts'
import type {
  Character,
  DecidedBy,
  Id,
  LineKind,
  LineState,
  QualityIssue,
  QualityIssueKind,
  CanvasLinePatch,
  SpeakerType,
} from '../types.ts'
import { findTopLevelQuoteSpans } from './attribution.ts'

// ============================================================================
// 输入类型
// ============================================================================

/** 质检只需要画本行的一个子集（用 CanvasLine 传入也满足结构） */
export interface QualityCheckLine {
  id: Id
  seq: number
  text: string
  sourceText?: string | null
  kind: LineKind
  speakerType: SpeakerType
  characterId: Id | null
  state: LineState
  pauseAfterMs: number
  confidence: number | null
  decidedBy: DecidedBy | null
  flags?: string[] | null
  pronunciation?: string | null
}

/**
 * 片段引用（recorded_missing 判定用）。
 * `exists` 由调用方注入（生产：`fs.existsSync(path.join(projectRoot, filePath))`）。
 * 不传 segments 时，`recorded_missing` 只报「state=recorded 但没有任何片段」的行。
 */
export interface QualitySegmentRef {
  lineId: Id
  filePath?: string
  exists?: boolean
}

export interface QualityCheckOptions {
  /** 单行最大字数（默认 CANVAS_DEFAULTS.maxLineChars） */
  maxLineChars?: number
  /** 连续旁白上限（默认 15） */
  maxNarrationRun?: number
  /** 连续同一角色对白上限（默认 20） */
  maxDialogueRun?: number
  /** no_pause / 一键修复用的默认停顿（默认 500） */
  defaultPauseAfterMs?: number
  /** suspicious_speaker 的置信度下限（docs/11 §5 定为 0.5） */
  suspiciousConfidence?: number
  /** 多音字表（可覆盖，便于用户扩展，docs/11 §5） */
  polyphoneHints?: ReadonlyArray<{ char: string; readings: readonly string[]; hint: string }>
  /**
   * 是否忽略「高频功能字」多音字（地/了/得/着/为）。
   * 默认 true：这些字几乎每句都有，全报会把质检面板淹掉（docs/11 §5 要求「命中表 + 无消歧线索」才提示）。
   */
  skipCommonPolyphones?: boolean
  /** 判定「相邻」时的最大行距（seq 差）；默认 1（严格相邻） */
  adjacentGap?: number
}

const DEFAULT_SKIP_COMMON = ['地', '了', '得', '着', '为'] as const

// ============================================================================
// 多音字
// ============================================================================

/** 消歧词表：命中即能确定读音（docs/11 §5「命中表 + 上下文中无消歧线索 → 提示」） */
export const POLYPHONE_DISAMBIGUATION: ReadonlyArray<{ char: string; words: Record<string, string> }> = [
  { char: '行', words: { 银行: 'háng', 行业: 'háng', 一行: 'háng', 内行: 'háng', 行走: 'xíng', 行动: 'xíng', 不行: 'xíng', 可行: 'xíng' } },
  { char: '重', words: { 重要: 'zhòng', 重量: 'zhòng', 沉重: 'zhòng', 重复: 'chóng', 重新: 'chóng', 重逢: 'chóng' } },
  { char: '还', words: { 还有: 'hái', 还是: 'hái', 归还: 'huán', 还给: 'huán', 偿还: 'huán' } },
  { char: '长', words: { 长老: 'zhǎng', 长大: 'zhǎng', 成长: 'zhǎng', 长辈: 'zhǎng', 长度: 'cháng', 很长: 'cháng' } },
  { char: '乐', words: { 音乐: 'yuè', 乐器: 'yuè', 快乐: 'lè', 欢乐: 'lè' } },
  { char: '差', words: { 差不多: 'chà', 出差: 'chāi', 差别: 'chā', 差距: 'chā' } },
  { char: '藏', words: { 宝藏: 'zàng', 西藏: 'zàng', 躲藏: 'cáng', 藏身: 'cáng' } },
  { char: '率', words: { 效率: 'lǜ', 率领: 'shuài', 轻率: 'shuài' } },
  { char: '血', words: { 血液: 'xuè', 血型: 'xuè', 流血: 'xiě' } },
  { char: '薄', words: { 薄片: 'báo', 单薄: 'bó', 薄荷: 'bò' } },
  { char: '露', words: { 露面: 'lòu', 露水: 'lù', 露出: 'lù' } },
  { char: '处', words: { 处理: 'chǔ', 相处: 'chǔ', 处所: 'chù', 到处: 'chù' } },
  { char: '为', words: { 作为: 'wéi', 认为: 'wéi', 为了: 'wèi', 因为: 'wèi' } },
  { char: '种', words: { 种类: 'zhǒng', 各种: 'zhǒng', 种植: 'zhòng', 种下: 'zhòng' } },
  { char: '着', words: { 着急: 'zháo', 着装: 'zhuó' } },
  { char: '得', words: { 得到: 'dé', 得意: 'dé' } },
  { char: '地', words: { 土地: 'dì', 地面: 'dì', 地方: 'dì' } },
  { char: '了', words: { 了解: 'liǎo', 了不起: 'liǎo' } },
]

export interface PolyphoneHit {
  char: string
  readings: string[]
  hint: string
  /** 上下文能确定读音时给出建议（可直接写进 pronunciation 字段） */
  suggestedReading: string | null
  /** 命中的消歧词 */
  disambiguator: string | null
}

/**
 * 找出文本里命中的多音字（docs/11 §5）。
 *
 * 返回可读的提示串数组，例如 `行(xíng/háng)：行走 / 行业、银行`。
 * `opts.excludeCommon=true` 时跳过地/了/得/着/为这类高频功能字（默认包含）。
 *
 * 失败不抛错：text 为空时返回空数组。
 */
export function findPolyphoneHints(
  text: string,
  opts?: { excludeCommon?: boolean; table?: QualityCheckOptions['polyphoneHints'] },
): string[] {
  return analyzePolyphones(text, opts).map((h) => `${h.char}(${h.readings.join('/')})：${h.hint}`)
}

/**
 * 多音字分析（比 {@link findPolyphoneHints} 多给「上下文能否确定读音」的信息）。
 * `autoFixIssues` 用它生成发音建议 —— **只给建议，绝不自动改写文本**（docs/11 §5）。
 */
export function analyzePolyphones(
  text: string,
  opts?: { excludeCommon?: boolean; table?: QualityCheckOptions['polyphoneHints'] },
): PolyphoneHit[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const table = opts?.table ?? POLYPHONE_HINTS
  const skipCommon = opts?.excludeCommon === true
  const out: PolyphoneHit[] = []
  for (const entry of table) {
    if (!text.includes(entry.char)) continue
    if (skipCommon && (DEFAULT_SKIP_COMMON as readonly string[]).includes(entry.char)) continue
    const disamb = POLYPHONE_DISAMBIGUATION.find((d) => d.char === entry.char)
    let suggested: string | null = null
    let matchedWord: string | null = null
    if (disamb) {
      for (const [word, reading] of Object.entries(disamb.words)) {
        if (text.includes(word)) {
          suggested = reading
          matchedWord = word
          break
        }
      }
    }
    out.push({
      char: entry.char,
      readings: [...entry.readings],
      hint: entry.hint,
      suggestedReading: suggested,
      disambiguator: matchedWord,
    })
  }
  return out
}

/** 发音提示的建议文本（写进 `pronunciation` 字段） */
export function suggestPronunciation(text: string): string | null {
  const hits = analyzePolyphones(text, { excludeCommon: true })
  if (hits.length === 0) return null
  return hits.map((h) => `${h.char}：${h.suggestedReading ?? h.readings.join('/')}`).join('；')
}

// ============================================================================
// 质检主体
// ============================================================================

/**
 * 画本质检：一次扫出 docs/11 §5 的 12 种问题。
 *
 * 口径说明（必须与 UI 面板的文案一致）：
 *   · `too_long`        可读字数 > maxLineChars（标点不计，与分句口径一致）
 *   · `unassigned`      kind=dialogue 但说话人为空/非角色
 *   · `quote_unmatched` flags 命中，或 sourceText 里引号不配对
 *   · `narration_run`   ≥ maxNarrationRun 连续旁白（每个 run 只报一次，报在首行）
 *   · `dialogue_run`    ≥ maxDialogueRun 连续同一角色对白（同上）
 *   · `no_pause`        相邻同角色行 pauseAfterMs=0（会粘连）
 *   · `suspicious_speaker` 置信度 < 0.5 且 decidedBy ≠ human；或引用了不存在的角色
 *   · `missing_pronunciation` 命中多音字表但未给发音提示
 *   · `recorded_missing` state=recorded 但片段缺失
 *   · `duplicate_text`  相邻两行文本完全相同
 *   · `empty_text`      text 为空
 *   · `no_character_ref` 角色表里有角色从未被任何行引用（lineId/seq 为 null）
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')（lines 不是数组 / characters 不是数组）。
 */
export function qualityCheck(
  lines: QualityCheckLine[],
  characters: Character[],
  segments: QualitySegmentRef[],
  opts?: QualityCheckOptions,
): QualityIssue[] {
  if (!Array.isArray(lines)) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'qualityCheck', reason: 'lines-not-array' } })
  }
  if (!Array.isArray(characters)) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'qualityCheck', reason: 'characters-not-array' } })
  }
  const maxLineChars = opts?.maxLineChars ?? CANVAS_DEFAULTS.maxLineChars
  const maxNarrationRun = opts?.maxNarrationRun ?? CANVAS_DEFAULTS.maxNarrationRun
  const maxDialogueRun = opts?.maxDialogueRun ?? CANVAS_DEFAULTS.maxDialogueRun
  const suspiciousConfidence = opts?.suspiciousConfidence ?? 0.5
  const skipCommon = opts?.skipCommonPolyphones ?? true
  const adjacentGap = Math.max(1, opts?.adjacentGap ?? 1)
  const segmentLines = new Set(segments.filter((s) => s.exists !== false).map((s) => s.lineId))
  const hasSegments = segments.length > 0

  const issues: QualityIssue[] = []
  const push = (
    kind: QualityIssueKind,
    line: QualityCheckLine | null,
    message: string,
    autoFixable = false,
  ): void => {
    issues.push({ kind, lineId: line?.id ?? null, seq: line?.seq ?? null, message, autoFixable })
  }

  const ordered = [...lines].sort((a, b) => a.seq - b.seq)
  const knownCharacters = new Set(characters.map((c) => c.id))
  const referencedCharacters = new Set<Id>()

  // ---- 逐行检查 ----
  for (let i = 0; i < ordered.length; i++) {
    const line = ordered[i]
    const prev = i > 0 && line.seq - ordered[i - 1].seq <= adjacentGap ? ordered[i - 1] : null
    const readable = countReadable(line.text)

    if (line.text.trim().length === 0) {
      push('empty_text', line, `第 ${line.seq + 1} 行文本为空，没法录`)
    }
    if (readable > maxLineChars) {
      push('too_long', line, `第 ${line.seq + 1} 行 ${readable} 字，超过上限 ${maxLineChars} 字（录起来容易忘词、对轨时波形过大）`)
    }
    if (line.kind === 'dialogue' && (line.speakerType !== 'character' || line.characterId == null)) {
      push('unassigned', line, `第 ${line.seq + 1} 行是台词但还没有指派说话人`)
    }
    if (line.characterId != null) {
      referencedCharacters.add(line.characterId)
      if (!knownCharacters.has(line.characterId)) {
        push('suspicious_speaker', line, `第 ${line.seq + 1} 行引用了不存在的角色（可能角色已被删除）`)
      }
    }

    const flagUnmatched = (line.flags ?? []).includes('quote_unmatched')
    const sourceUnmatched = line.sourceText ? isQuoteUnbalanced(line.sourceText) : false
    if (flagUnmatched || sourceUnmatched) {
      push('quote_unmatched', line, `第 ${line.seq + 1} 行引号不配对（多半是分句切错了）`)
    }

    if (
      line.confidence != null &&
      line.confidence < suspiciousConfidence &&
      line.decidedBy !== 'human'
    ) {
      push(
        'suspicious_speaker',
        line,
        `第 ${line.seq + 1} 行归属置信度只有 ${line.confidence.toFixed(2)}，建议人工确认`,
      )
    }

    const poly = analyzePolyphones(line.text, { excludeCommon: skipCommon, table: opts?.polyphoneHints })
    if (poly.length > 0 && (line.pronunciation == null || line.pronunciation.trim() === '')) {
      push(
        'missing_pronunciation',
        line,
        `第 ${line.seq + 1} 行含多音字 ${poly.map((p) => p.char).join('、')} 但没写发音提示`,
        true,
      )
    }

    if (line.state === 'recorded') {
      const missing = hasSegments ? !segmentLines.has(line.id) : false
      if (missing) {
        push('recorded_missing', line, `第 ${line.seq + 1} 行标记为已录，但找不到对应音频片段`)
      }
    }

    if (prev) {
      // 「相邻同角色行 pauseAfterMs=0」：检查的是**前一行**的停顿——它才是决定两句会不会粘在一起的那个值
      const sameSpeaker =
        prev.characterId === line.characterId && prev.speakerType === line.speakerType
      if (sameSpeaker && prev.pauseAfterMs === 0) {
        push('no_pause', prev, `第 ${prev.seq + 1} 行与下一行是同一角色，但停顿为 0（两句会粘在一起）`, true)
      }
      if (prev.text.trim().length > 0 && prev.text.trim() === line.text.trim()) {
        push('duplicate_text', line, `第 ${line.seq + 1} 行与上一行文本完全相同（可能是复制粘贴漏改）`)
      }
    }
  }

  // ---- 连续 run ----
  let runStart = 0
  const flushNarration = (endExclusive: number): void => {
    const len = endExclusive - runStart
    if (len >= maxNarrationRun) {
      const first = ordered[runStart]
      push(
        'narration_run',
        first,
        `第 ${first.seq + 1} 行起连续 ${len} 行旁白（超过 ${maxNarrationRun} 行），可能漏判了对白`,
      )
    }
  }
  runStart = 0
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].kind !== 'narration') {
      flushNarration(i)
      runStart = i + 1
    }
  }
  flushNarration(ordered.length)

  let dlgStart = 0
  const flushDialogue = (endExclusive: number): void => {
    const len = endExclusive - dlgStart
    if (len >= maxDialogueRun) {
      const first = ordered[dlgStart]
      push(
        'dialogue_run',
        first,
        `第 ${first.seq + 1} 行起连续 ${len} 行同一角色（${first.characterId ?? '未指派'}）的对白（超过 ${maxDialogueRun} 行），可能是旁白被误判`,
      )
    }
  }
  dlgStart = 0
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i]
    const sameAsPrev =
      i > dlgStart &&
      cur.kind === 'dialogue' &&
      ordered[i - 1].kind === 'dialogue' &&
      cur.characterId != null &&
      cur.characterId === ordered[i - 1].characterId
    if (!sameAsPrev) {
      flushDialogue(i)
      dlgStart = i
    }
  }
  flushDialogue(ordered.length)

  // ---- 角色表：从未被引用 ----
  for (const c of characters) {
    if (c.isArchived) continue
    if (!referencedCharacters.has(c.id)) {
      push('no_character_ref', null, `角色「${c.name}」在本章从未出场（如已无用可归档）`)
    }
  }

  return issues
}

/** 引号是否不配对（用于 sourceText 兜底判断） */
export function isQuoteUnbalanced(text: string): boolean {
  const opens = countChars(text, ['“', '「', '『', '‘'])
  const closes = countChars(text, ['”', '」', '』', '’'])
  if (opens !== closes) return true
  // 顶层引号段数量与开引号数不一致 → 嵌套/未闭合
  return findTopLevelQuoteSpans(text).length === 0 && opens > 0
}

function countChars(text: string, chars: string[]): number {
  let n = 0
  for (const ch of text) if (chars.includes(ch)) n++
  return n
}

/** 可读字数（汉字/字母/数字，标点不计；与分句口径一致） */
function countReadable(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x4e00 && c <= 0x9fff) || /[A-Za-z0-9]/.test(ch)) n++
  }
  return n
}

// ============================================================================
// 一键修复（只修安全项）
// ============================================================================

export interface AutoFixOptions {
  /** no_pause 补的默认停顿（默认 500） */
  defaultPauseAfterMs?: number
  /** 安全项白名单（默认只有 no_pause / missing_pronunciation） */
  allowedKinds?: readonly QualityIssueKind[]
}

export interface AutoFixPatch {
  lineId: Id
  issueKind: QualityIssueKind
  patch: CanvasLinePatch
  /** 给用户看的说明（UI 在 toast 里显示） */
  note: string
}

export interface AutoFixResult {
  patches: AutoFixPatch[]
  fixed: number
  /** 因为不安全而被跳过的 issue 数 */
  skipped: number
  skippedKinds: QualityIssueKind[]
}

/** 一键修复允许动的两类问题（docs/11 §5：「一键修复仅限安全项」） */
export const SAFE_FIX_KINDS: readonly QualityIssueKind[] = ['no_pause', 'missing_pronunciation']

/**
 * 一键修复：**只修安全项**，并且**不修改入参**——返回补丁列表，由调用方（IPC 层）在一个事务里落库。
 *
 * 安全项：
 *   · `no_pause` → `pauseAfterMs = defaultPauseAfterMs`（纯数值，可撤销）
 *   · `missing_pronunciation` → 写入字典/上下文给出的发音建议（不改文本，只加提示）
 * 其余问题（空文本、超长、未指派、引号不配对…）一律跳过：自动改会错得更离谱。
 *
 * 失败不抛错：lineId 找不到对应行时该条计入 skipped。
 */
export function autoFixIssues(
  lines: QualityCheckLine[],
  issues: QualityIssue[],
  opts?: AutoFixOptions,
): AutoFixResult {
  const allowed = new Set<QualityIssueKind>(opts?.allowedKinds ?? SAFE_FIX_KINDS)
  const defaultPause = opts?.defaultPauseAfterMs ?? CANVAS_DEFAULTS.defaultPauseAfterMs
  const byId = new Map(lines.map((l) => [l.id, l]))
  const patches: AutoFixPatch[] = []
  let skipped = 0
  const skippedKinds = new Set<QualityIssueKind>()

  for (const issue of issues) {
    if (!allowed.has(issue.kind) || issue.lineId == null) {
      skipped++
      skippedKinds.add(issue.kind)
      continue
    }
    const line = byId.get(issue.lineId)
    if (!line) {
      skipped++
      skippedKinds.add(issue.kind)
      continue
    }

    if (issue.kind === 'no_pause') {
      if (line.pauseAfterMs >= defaultPause) {
        skipped++
        skippedKinds.add(issue.kind)
        continue
      }
      patches.push({
        lineId: line.id,
        issueKind: issue.kind,
        patch: { pauseAfterMs: defaultPause },
        note: `第 ${line.seq + 1} 行停顿补为 ${defaultPause} ms`,
      })
      continue
    }

    if (issue.kind === 'missing_pronunciation') {
      const suggestion = suggestPronunciation(line.text)
      if (suggestion == null || suggestion === line.pronunciation) {
        skipped++
        skippedKinds.add(issue.kind)
        continue
      }
      patches.push({
        lineId: line.id,
        issueKind: issue.kind,
        patch: { pronunciation: suggestion },
        note: `第 ${line.seq + 1} 行发音提示建议：${suggestion}`,
      })
      continue
    }

    skipped++
    skippedKinds.add(issue.kind)
  }

  return {
    patches,
    fixed: patches.length,
    skipped,
    skippedKinds: [...skippedKinds],
  }
}
