/**
 * Novel Studio · 角色抽取与角色表工具
 * ============================================================================
 * 设计依据：
 *   · docs/11 §4.6  角色表（自动抽取：引导语前主语、高频称谓、jieba 词性 nr）
 *   · docs/06 §5.1 Step 3  角色名抽取（规则 + 词频，L1）
 *   · docs/06 §8    角色表为空时先跑抽取生成候选，提示用户确认
 *   · docs/11 §6.1  CharacterStats 出场统计（行数/字数/预估时长）
 *
 * 三种信号（强度递减）：
 *   1. 引导语前 2~6 字窗口的人名 —— 最可靠（`萧炎沉声道：`）
 *   2. 高频称谓（老X / 小X / X儿 / X兄 / X长老 / X大人 …）—— 次之，噪声较多，靠词频过滤
 *   3. jieba 词性 nr —— **注入式分词器**，未注入时只用前两种（无网络环境下不引入 jieba）
 *
 * 零第三方依赖：只 import Node 内置与本仓库 src/shared/.ts。
 */

import { AppError } from '../errors.ts'
import { VAD_DEFAULTS } from '../constants.ts'
import type {
  AgeGroup,
  CanvasLinePatch,
  Character,
  CharacterCandidate,
  CharacterStats,
  Gender,
  Id,
  Timestamp,
} from '../types.ts'
import {
  CUE_VERBS,
  INNER_CUE_VERBS,
  NON_NAME_TOKENS,
  countReadableChars,
  guessNameFromWindow,
  matchCue,
} from './attribution.ts'

// ============================================================================
// 注入式分词器（信号 3）
// ============================================================================

/** 分词结果项：`pos` 用结巴的词性标注体系（人名 = `nr` / `nrt`） */
export interface Token {
  word: string
  pos?: string
}

/**
 * 分词器接口（**注入式**）。
 * 生产实现：`nodejieba` / `@node-rs/jieba` 的 `tag(text)`（词性标注，人名是 `nr`、音译人名是 `nrt`）。
 * 未注入时本模块只用信号 1 与信号 2 —— 这是无网络环境下的明确降级路径，不会静默返回空结果。
 */
export interface Tokenizer {
  tokenize(text: string): Token[]
}

// ============================================================================
// 抽取
// ============================================================================

export interface ExtractCharacterOptions {
  /** 最少出现次数（默认 2：出现一次的多半是噪声） */
  minOccurrences?: number
  /** 候选上限（默认 200，与 docs/03 §5.1「单项目 5~200 个角色」一致） */
  maxCandidates?: number
  /** 注入式分词器；不注入则跳过信号 3 */
  tokenizer?: Tokenizer
  /** 首次出现的章节标题（写进 CharacterCandidate.firstChapterTitle） */
  chapterTitle?: string | null
  /** 额外停用词（如作品里的地名、功法名被误抽时） */
  stopwords?: string[]
}

/** 称谓模式下「不是人名的后续字」：`老抚须笑道` 里的「老抚」就是这么冒出来的 */
const NON_NAME_FOLLOWING = new Set(
  '抚皱抬低摇点叹笑哭走站看听想说道问答是在把被让给对从往向和与的了着过来去起下上出进开关里外前后中大小多少好坏新旧真假的都不没会能要可'.split(''),
)

/** 称谓模式（docs/11 §4.6「高频称谓」） */
const APPELLATION_PATTERNS: ReadonlyArray<{
  id: string
  regex: RegExp
  build: (m: RegExpExecArray) => string
  /** 命中即丢弃（高频非人名组合） */
  stop: readonly string[]
}> = [
  {
    id: 'lao',
    regex: /老([\u4e00-\u9fa5])/g,
    build: (m) => `老${m[1]}`,
    stop: ['老师', '老实', '老虎', '老板', '老家', '老天', '老娘', '老汉', '老年', '老远', '老早', '老友'],
  },
  {
    id: 'xiao',
    regex: /小([\u4e00-\u9fa5])/g,
    build: (m) => `小${m[1]}`,
    stop: ['小时', '小心', '小声', '小说', '小孩', '小镇', '小巷', '小屋', '小山', '小溪', '小路', '小院', '小事', '小伙', '小组', '小节', '小时'],
  },
  {
    id: 'er',
    regex: /([\u4e00-\u9fa5])儿/g,
    build: (m) => `${m[1]}儿`,
    stop: ['女儿', '儿子', '孩儿', '这儿', '那儿', '一会儿', '点几'],
  },
  {
    id: 'xiong',
    regex: /([\u4e00-\u9fa5])兄/g,
    build: (m) => `${m[1]}兄`,
    stop: ['兄弟', '老兄', '诸兄'],
  },
  {
    id: 'zuncheng',
    regex: /([\u4e00-\u9fa5]{1,2})(长老|大人|前辈|姑娘|少爷|公子|小姐|夫人|道友|师兄|师姐|师妹|宗主|掌门|阁下|前辈|师叔|师尊)/g,
    build: (m) => `${m[1]}${m[2]}`,
    stop: ['这位长老', '一位长老'],
  },
]

/**
 * 从章节（或全书）文本抽取候选角色（docs/11 §4.6 / docs/06 Step 3）。
 *
 * 返回值按出现次数降序，已做：停用词过滤、代词过滤、称谓 → 别名归并。
 * 这是给**人工确认**用的候选列表，不是最终角色表——docs/06 §8 明确要求「提示用户确认后再判定」。
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')（text 不是字符串）。
 */
export function extractCharacterCandidates(
  text: string,
  opts?: ExtractCharacterOptions,
): CharacterCandidate[] {
  if (typeof text !== 'string') {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'extractCharacterCandidates' } })
  }
  const minOccurrences = Math.max(1, opts?.minOccurrences ?? 2)
  const maxCandidates = Math.max(1, opts?.maxCandidates ?? 200)
  const stopwords = new Set<string>([...NON_NAME_TOKENS, ...(opts?.stopwords ?? [])])

  /** 名字 → 记录（positions 用于跨信号去重：同一个位置只算一次） */
  const hits = new Map<
    string,
    { positions: Set<string>; viaCue: number; viaAppellation: number; viaNer: number; aliases: Set<string> }
  >()
  const appellations = new Map<string, number>()
  const bump = (name: string, via: 'cue' | 'appellation' | 'ner', key: string): void => {
    if (name.length < 2) return
    if (stopwords.has(name)) return
    if (!/^[\u4e00-\u9fa5A-Za-z·]+$/.test(name)) return
    const rec = hits.get(name) ?? {
      positions: new Set<string>(),
      viaCue: 0,
      viaAppellation: 0,
      viaNer: 0,
      aliases: new Set<string>(),
    }
    if (!rec.positions.has(key)) {
      rec.positions.add(key)
      if (via === 'cue') rec.viaCue += 1
      else if (via === 'appellation') rec.viaAppellation += 1
      else rec.viaNer += 1
    }
    hits.set(name, rec)
  }

  // ---- 信号 1：引导语前 2~6 字窗口的人名 ----
  const cueVerbs = [...CUE_VERBS, ...INNER_CUE_VERBS].sort((a, b) => b.length - a.length)
  const cueRe = new RegExp(
    `([\\u4e00-\\u9fa5]{1,6}?)(?:${cueVerbs.map(escapeRe).join('|')})(?:道|着|了一声)?\\s*[：:，,。]`,
    'g',
  )
  for (const m of text.matchAll(cueRe)) {
    const window = m[1]
    const at = m.index ?? 0
    const name = guessNameFromWindow(window)
    // 用字符偏移做去重键：同一处出现的名字被「引导语」和「称谓」两条信号同时命中时只算一次
    if (name) bump(name, 'cue', `at@${at}`)
    // 窗口里可能同时出现「药老皱眉」这种带修饰语的形态，做一次最长后缀尝试
    if (name && window.length > name.length) {
      const extra = guessNameFromWindow(window.slice(0, window.length - name.length))
      if (extra && extra !== name) bump(extra, 'cue', `cue-sub@${at}`)
    }
  }

  // ---- 信号 2：高频称谓 ----
  for (const pattern of APPELLATION_PATTERNS) {
    pattern.regex.lastIndex = 0
    for (const m of text.matchAll(pattern.regex)) {
      const word = pattern.build(m as unknown as RegExpExecArray)
      if (pattern.stop.includes(word)) continue
      if (stopwords.has(word)) continue
      // 「老X / 小X」后面跟着动词/助词时几乎都不是人名（老抚须笑道 → 老抚）
      if (pattern.id === 'lao' || pattern.id === 'xiao') {
        if (NON_NAME_FOLLOWING.has(m[1])) continue
      }
      appellations.set(word, (appellations.get(word) ?? 0) + 1)
      bump(word, 'appellation', `at@${m.index ?? 0}`)
    }
  }

  // ---- 信号 3：jieba 词性 nr（注入式；未注入则跳过） ----
  if (opts?.tokenizer) {
    const paragraphs = text.split(/\n+/)
    paragraphs.forEach((paragraph, pi) => {
      if (paragraph.trim().length === 0) return
      let tokens: Token[] = []
      try {
        tokens = opts.tokenizer!.tokenize(paragraph)
      } catch {
        // 分词器坏了不能把抽取整体搞挂（L1 必须无条件可用，docs/06 §2）
        return
      }
      tokens.forEach((t, ti) => {
        if (!t || typeof t.word !== 'string') return
        if (t.pos === 'nr' || t.pos === 'nrt') bump(t.word, 'ner', `ner@${pi}:${ti}`)
      })
    })
  }

  // ---- 称谓归并：小炎子/老张/炎儿 若能归到某个全名，则作为别名而不是独立角色 ----
  for (const word of appellations.keys()) {
    const core = word.replace(/^[老小]/, '').replace(/(儿|兄|长老|大人|前辈|姑娘|少爷|公子|小姐|夫人|道友|师兄|师姐|师妹|宗主|掌门|阁下)$/, '')
    if (core.length === 0) continue
    let owner: string | null = null
    for (const name of hits.keys()) {
      if (name === word) continue
      if (name.includes(word) || word.includes(name)) {
        owner = name
        break
      }
      if (name.includes(core) || (core.length > 1 && name.includes(core[0]) && hits.get(name)!.viaCue > 0)) {
        owner = name
        break
      }
    }
    if (!owner) continue // 归不到任何全名 → 它本身就是一个候选（上方已 bump）
    const rec = hits.get(owner)!
    const aliasRec = hits.get(word)
    if (aliasRec) {
      rec.aliases.add(word)
      // 把称谓的出现位置并到全名下：既保留计数，又避免「同一个词既是候选又是别名」
      for (const pos of aliasRec.positions) rec.positions.add(`${pos}->alias`)
      rec.viaAppellation += aliasRec.viaAppellation
      hits.delete(word)
    }
  }

  // ---- 过滤与排序 ----
  const out: CharacterCandidate[] = []
  for (const [name, rec] of hits) {
    const count = rec.positions.size
    // 只出现一次且不是引导语里出现的，大概率是噪声
    if (count < minOccurrences && rec.viaCue === 0) continue
    out.push({
      name,
      aliases: [...rec.aliases],
      occurrences: count,
      firstChapterTitle: opts?.chapterTitle ?? null,
    })
  }
  out.sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name))
  return out.slice(0, maxCandidates)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ============================================================================
// 角色表小工具
// ============================================================================

/** 名字/别名 → 角色（精确优先，其次最长包含匹配） */
export function resolveCharacterByName(characters: Character[], name: string): Character | null {
  const key = name.trim()
  if (key.length === 0) return null
  for (const c of characters) {
    if (c.name === key || c.aliases.includes(key)) return c
  }
  let best: { c: Character; len: number } | null = null
  for (const c of characters) {
    for (const k of [c.name, ...c.aliases]) {
      if (k.length >= 2 && key.includes(k) && (!best || k.length > best.len)) best = { c, len: k.length }
    }
  }
  return best ? best.c : null
}

export interface AliasConflict {
  alias: string
  otherId: Id
  otherName: string
  message: string
}

/**
 * 给角色添加别名（纯函数，返回新对象）。
 *
 * - 别名与自身名字相同、或已存在 → `added=false`（不报错）
 * - 与其它角色的名字/别名冲突 → 默认**不加**，在 `conflict` 里返回（`force=true` 才强行加）
 * - 冲突码语义：CHARACTER_MERGE_CONFLICT（docs/11 §8「合并角色时有同名别名冲突」）
 */
export function addAlias(
  character: Character,
  alias: string,
  opts?: { allCharacters?: Character[]; force?: boolean; now?: Timestamp },
): { character: Character; added: boolean; conflict: AliasConflict | null } {
  const key = alias.trim()
  const noop = { character, added: false, conflict: null }
  if (key.length === 0 || key === character.name || character.aliases.includes(key)) return noop

  for (const other of opts?.allCharacters ?? []) {
    if (other.id === character.id) continue
    if (other.name === key || other.aliases.includes(key)) {
      const conflict: AliasConflict = {
        alias: key,
        otherId: other.id,
        otherName: other.name,
        message: `别名「${key}」已属于角色「${other.name}」`,
      }
      if (!opts?.force) return { character, added: false, conflict }
      return {
        character: { ...character, aliases: [...character.aliases, key], updatedAt: opts?.now ?? Date.now() },
        added: true,
        conflict,
      }
    }
  }

  return {
    character: { ...character, aliases: [...character.aliases, key], updatedAt: opts?.now ?? Date.now() },
    added: true,
    conflict: null,
  }
}

/** 移除别名（纯函数） */
export function removeAlias(character: Character, alias: string, now?: Timestamp): Character {
  const key = alias.trim()
  if (!character.aliases.includes(key)) return character
  return { ...character, aliases: character.aliases.filter((a) => a !== key), updatedAt: now ?? Date.now() }
}

/** 归档/恢复角色（docs/11 §4.6：禁止物理删除，只允许归档，否则破坏既有引用） */
export function archiveCharacter(character: Character, archived = true, now?: Timestamp): Character {
  return { ...character, isArchived: archived, updatedAt: now ?? Date.now() }
}

// ============================================================================
// 合并（docs/11 §4.6「合并」/ §8「同名别名冲突」）
// ============================================================================

export interface MergeCharactersInput {
  target: Character
  sources: Character[]
  /** 全部台词引用（用于迁移统计与补丁生成） */
  lines: Array<{ id: Id; characterId: Id | null }>
  /** 是否保留源角色的别名（默认 true；false 时只迁移名字） */
  keepAliases?: boolean
  /** 全量角色表（用于别名冲突检测）；不传则跳过冲突检测 */
  allCharacters?: Character[]
  now?: Timestamp
  /** true 时冲突直接抛 AppError('CHARACTER_MERGE_CONFLICT') */
  strict?: boolean
}

export interface MergeConflict {
  kind: 'self_merge' | 'duplicate_source' | 'alias_collision'
  alias: string | null
  otherId: Id | null
  otherName: string | null
  message: string
}

export interface MergeCharactersResult {
  /** 无冲突时为 true；有冲突时调用方应先让用户解决再落库 */
  ok: boolean
  /** 合并后的目标角色（纯新对象，未落库） */
  target: Character
  /** 需要迁移的台词补丁（迁移后 decidedBy='human'：这是人工动作，重算不得覆盖） */
  linePatches: Array<{ lineId: Id; patch: CanvasLinePatch }>
  movedLines: number
  mergedAliases: string[]
  /** 需要归档的源角色 id（不物理删除） */
  archivedSourceIds: Id[]
  conflicts: MergeConflict[]
}

/**
 * 角色合并：迁移台词与别名，返回冲突清单。
 *
 * 关键约定（docs/11 §4.6 与 docs/06 §5.5）：
 *   · 台词迁移后 `decidedBy='human'` —— 合并是人工动作，重算不得把它改回去
 *   · 源角色**归档**而不是删除（保留既有引用，可恢复）
 *   · 别名冲突不静默丢弃：`conflicts` 里列清楚（UI 必须展示「将影响 N 行」预览）
 *
 * 失败时抛 AppError('CHARACTER_MERGE_CONFLICT')（strict=true 且存在冲突时；
 * params.count = 冲突数）或 AppError('INVALID_PAYLOAD')（target 缺失）。
 */
export function mergeCharacters(input: MergeCharactersInput): MergeCharactersResult {
  if (!input?.target) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'mergeCharacters', reason: 'missing-target' } })
  }
  const now = input.now ?? Date.now()
  const keepAliases = input.keepAliases ?? true
  const conflicts: MergeConflict[] = []

  const sourceIds = new Set<Id>()
  for (const s of input.sources) {
    if (s.id === input.target.id) {
      conflicts.push({
        kind: 'self_merge', alias: null, otherId: s.id, otherName: s.name,
        message: `角色「${s.name}」不能与自己合并`,
      })
      continue
    }
    if (sourceIds.has(s.id)) {
      conflicts.push({
        kind: 'duplicate_source', alias: null, otherId: s.id, otherName: s.name,
        message: `角色「${s.name}」在待合并列表中重复出现`,
      })
      continue
    }
    sourceIds.add(s.id)
  }

  const mergedAliases: string[] = []
  const aliasSet = new Set(input.target.aliases)
  const pushAlias = (alias: string): void => {
    const key = alias.trim()
    if (key.length === 0 || key === input.target.name || aliasSet.has(key) || mergedAliases.includes(key)) return
    const other = (input.allCharacters ?? []).find(
      (c) => c.id !== input.target.id && !sourceIds.has(c.id) && (c.name === key || c.aliases.includes(key)),
    )
    if (other) {
      conflicts.push({
        kind: 'alias_collision', alias: key, otherId: other.id, otherName: other.name,
        message: `别名「${key}」与角色「${other.name}」冲突`,
      })
      return
    }
    aliasSet.add(key)
    mergedAliases.push(key)
  }

  for (const s of input.sources) {
    if (!sourceIds.has(s.id)) continue
    if (keepAliases) {
      for (const a of s.aliases) pushAlias(a)
      pushAlias(s.name)
    }
  }

  const linePatches: Array<{ lineId: Id; patch: CanvasLinePatch }> = []
  for (const line of input.lines) {
    if (line.characterId != null && sourceIds.has(line.characterId)) {
      linePatches.push({
        lineId: line.id,
        patch: { characterId: input.target.id, decidedBy: 'human', needsReview: false },
      })
    }
  }

  const target: Character = {
    ...input.target,
    aliases: [...input.target.aliases, ...mergedAliases],
    updatedAt: now,
  }

  const ok = conflicts.length === 0
  if (!ok && input.strict) {
    throw new AppError('CHARACTER_MERGE_CONFLICT', {
      params: { count: conflicts.length },
      details: { conflicts: conflicts.map((c) => c.message) },
    })
  }

  return {
    ok,
    target,
    linePatches,
    movedLines: linePatches.length,
    mergedAliases,
    archivedSourceIds: [...sourceIds],
    conflicts,
  }
}

// ============================================================================
// 拆分（合并的逆操作）
// ============================================================================

export interface SplitCharacterInput {
  character: Character
  parts: Array<{
    name: string
    aliases?: string[]
    /** 归到该部分的台词（由 UI 勾选或按章拆分） */
    lineIds?: Id[]
    description?: string | null
  }>
  now?: Timestamp
  /** 生成新角色 id（默认 `${源id}-s${序号}`；生产实现用 nanoid/uuid） */
  idFactory?: (index: number) => Id
}

export interface SplitCharacterResult {
  /** 源角色（拆分后默认归档；若仍有台词归属则保持启用） */
  source: Character
  created: Character[]
  linePatches: Array<{ lineId: Id; patch: CanvasLinePatch }>
}

/**
 * 角色拆分：把一个人物（如被误合并的「萧炎/炎帝」）拆成多个角色。
 * 与 {@link mergeCharacters} 对称：台词补丁同样标记 `decidedBy='human'`。
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')（未传 parts 或为空）。
 */
export function splitCharacter(input: SplitCharacterInput): SplitCharacterResult {
  if (!input?.character) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'splitCharacter', reason: 'missing-character' } })
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'splitCharacter', reason: 'empty-parts' } })
  }
  const now = input.now ?? Date.now()
  const idFactory = input.idFactory ?? ((i: number) => `${input.character.id}-s${i + 1}`)

  const created: Character[] = input.parts.map((p, i) => ({
    id: idFactory(i),
    bookId: input.character.bookId,
    name: p.name,
    aliases: p.aliases ?? [],
    gender: input.character.gender,
    ageGroup: input.character.ageGroup,
    description: p.description ?? input.character.description,
    note: null,
    color: input.character.color,
    defaultSpeed: input.character.defaultSpeed,
    defaultEmotion: input.character.defaultEmotion,
    defaultGainDb: input.character.defaultGainDb,
    defaultPauseMs: input.character.defaultPauseMs,
    isArchived: false,
    sortOrder: input.character.sortOrder + i + 1,
    createdAt: now,
    updatedAt: now,
  }))

  const linePatches: Array<{ lineId: Id; patch: CanvasLinePatch }> = []
  input.parts.forEach((p, i) => {
    for (const lineId of p.lineIds ?? []) {
      linePatches.push({ lineId, patch: { characterId: created[i].id, decidedBy: 'human', needsReview: false } })
    }
  })

  return {
    source: input.character,
    created,
    linePatches,
  }
}

// ============================================================================
// 出场统计（docs/11 §4.6「出场统计」/ docs/20 §4.4 character:stats）
// ============================================================================

export interface CharacterStatsLine {
  characterId: Id | null
  text: string
  /** 已有成品片段时给出实际时长（毫秒）；没有则只按字数估算 */
  recordedMs?: number | null
}

/**
 * 统计角色出场：行数、字数、预估时长、已录时长。
 * 预估时长用 `VAD_DEFAULTS.charsPerSecond`（docs/05 §4.2 的中文朗读语速），
 * 与录音页的期望时长口径保持一致。
 */
export function buildCharacterStats(characterId: Id, lines: CharacterStatsLine[]): CharacterStats {
  let count = 0
  let chars = 0
  let recordedMs = 0
  for (const l of lines) {
    if (l.characterId !== characterId) continue
    count++
    chars += countReadableChars(l.text)
    recordedMs += Math.max(0, l.recordedMs ?? 0)
  }
  const charsPerSecond = VAD_DEFAULTS.charsPerSecond > 0 ? VAD_DEFAULTS.charsPerSecond : 4.2
  return {
    characterId,
    lines: count,
    chars,
    estimatedDurationMs: Math.round((chars / charsPerSecond) * 1000),
    recordedMs,
  }
}

/** 创建角色的工厂（默认值集中在这里，UI 与测试都用它，避免各处手写默认值） */
export function createCharacter(partial: {
  id: Id
  bookId: Id
  name: string
  aliases?: string[]
  gender?: Gender | null
  ageGroup?: AgeGroup | null
  description?: string | null
  color?: string | null
  sortOrder?: number
  now?: Timestamp
}): Character {
  const now = partial.now ?? Date.now()
  return {
    id: partial.id,
    bookId: partial.bookId,
    name: partial.name,
    aliases: partial.aliases ?? [],
    gender: partial.gender ?? null,
    ageGroup: partial.ageGroup ?? null,
    description: partial.description ?? null,
    note: null,
    color: partial.color ?? null,
    defaultSpeed: null,
    defaultEmotion: null,
    defaultGainDb: null,
    defaultPauseMs: null,
    isArchived: false,
    sortOrder: partial.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  }
}

/** 供 main 层复用的引导语匹配入口（避免上层直接依赖 attribution.ts 的细节） */
export { matchCue }
