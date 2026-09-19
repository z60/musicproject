/**
 * Novel Studio · 角色画像聚合与过滤（移植自开源项目 Online-novel-character-extraction）
 * ============================================================================
 * 来源与许可：
 *   · 上游：https://github.com/wx331406/Online-novel-character-extraction （MIT，见其 LICENSE）
 *   · 移植范围：**统计与聚合部分**（`character_stats.py` / `filter_characters.py` /
 *     `sort_characters.py`）、**章节切分口径**（`split_novel.py` 的 `第X章` 正则）。
 *   · **没有移植**它的 AI 抽取部分（上游用本地 Qwen3-8B 做候选识别）。本仓库不引入
 *     Python / 本地大模型依赖（用户明确选择「零外部依赖：把统计式算法移植成 TS」），
 *     因此候选识别仍用我们自己的规则抽取（`extractCharacterCandidates`），
 *     这里只负责上游那套「聚合 → 取最长描述 → 按出现次数过滤」的后处理。
 *
 * 上游三条关键规则（逐条对应本文件的实现，避免「以为是同一个东西」）：
 *   1. **别名去重且排除自身**（`character_stats.py`）：`别名` 用 `/` 分隔，
 *      去重时**保留首次出现顺序**，并把与角色名相同的项去掉。
 *   2. **描述取最长**（同文件 `best_appearance`）：外貌 / 性格 / 语言 / 特征四类，
 *      同一角色多次出现时**保留最长的那条**（最短的往往是「他」这类片段）。
 *   3. **出现次数不足 3 次直接删除**（`filter_characters.py`）：
 *      `^角色名称:\s+([^\s]+)` 计数 < 3 的文件被删掉。
 *      这条正是「抽取到一堆碎片」的对症规则 —— 碎片很少能稳定出现 3 次以上。
 *
 * 本文件是**纯逻辑**：不碰数据库、不读文件、不联网，因此可被单测直接覆盖。
 */

import type { Id } from '../types.ts'

/**
 * 描述分类。上游的四个字段（外貌/性格/语言/特征）分类保留 ——
 * 它们分别对应「配音选角」关心的四件事：长相、性格、说话方式、特殊标记。
 */
export const CHARACTER_DESCRIPTION_KINDS = ['appearance', 'personality', 'speech', 'feature'] as const
export type CharacterDescriptionKind = (typeof CHARACTER_DESCRIPTION_KINDS)[number]

export type CharacterDescriptions = Record<CharacterDescriptionKind, string | null>

/** 一个角色在**某一章**里的一次观察（由调用方从规则抽取 + 章节正文组装） */
export interface CharacterObservation {
  name: string
  /** 该次观察里识别到的别名（上游按 `/` 分隔；我们按数组传，规则一致） */
  aliases?: string[]
  /** 出现次数（上游 `filter_characters.py` 的计数口径：全书里这个名字出现的次数） */
  occurrences: number
  /** 该角色出现的章节（用于「首见」与「跨章聚合」） */
  chapterId?: Id | null
  chapterTitle?: string | null
  /** 供描述提取用的上下文（通常是首次出现那一章的正文；不给则描述留空） */
  text?: string
  /** 上游的「性别 / 年龄」，取**首个非未知**（我们的规则抽取给不出时保持 null） */
  gender?: string | null
  ageHint?: string | null
}

export interface CharacterProfile {
  name: string
  /** 去重 + 排除自身 + 保序（上游规则 1） */
  aliases: string[]
  /** 全书出现次数（上游规则 3 的判据） */
  occurrences: number
  /** 出现的章节数（比出现次数更能说明「这是个稳定角色」） */
  chapterCount: number
  chapterTitles: string[]
  /** 首次出现的章节标题（没有章节信息时为 null） */
  firstChapterTitle: string | null
  gender: string | null
  ageHint: string | null
  /** 四类描述，各取**最长**（上游规则 2） */
  descriptions: CharacterDescriptions
}

export interface BuildProfileOptions {
  /**
   * 最少出现次数。上游 `filter_characters.py` 的阈值是 **3**：
   * 少于 3 次的「角色」多半是碎片（形容词、动词短语、地名），直接删掉。
   */
  minOccurrences?: number
  /** 最多返回多少个角色（按出现次数降序），防止把整本书的碎片都倒给用户 */
  maxProfiles?: number
  /** 描述提取用的上下文长度上限（字符）—— 避免对几十万字做正则扫描 */
  descriptionWindowChars?: number
}

/** 上游阈值：出现次数 < 3 的角色文件会被删掉 */
export const UPSTREAM_MIN_OCCURRENCES = 3

/**
 * 描述关键词表（本仓库自加，**不在上游**）。
 *
 * 上游的四类描述来自大模型输出（"外貌: …"）；我们不做 AI，于是用「描写句式里的关键词」
 * 近似。这是**明确的降级**：能抓到「长发/身材/英俊」这类明写字眼，
 * 抓不到含蓄描写。宁可少抓也不乱抓（所以只认出现关键词的句子）。
 */
const DESCRIPTION_KEYWORDS: Record<CharacterDescriptionKind, readonly string[]> = {
  appearance: ['长相', '容貌', '面容', '身材', '个子', '身高', '英俊', '漂亮', '美丽', '丑陋', '胖', '瘦', '眼睛', '秀发', '长发', '短发', '皮肤', '穿着', '身披', '年纪', '岁左右', '白发', '脸上'],
  personality: ['性格', '脾气', '为人', '心地', '善良', '狠毒', '冷酷', '温柔', '倔强', '谨慎', '胆小', '勇敢', '狡猾', '沉稳', '暴躁', '内向', '开朗'],
  speech: ['语气', '口音', '嗓音', '说道', '笑道', '低声道', '冷冷地', '嘀咕', '笑道', '吼道', '喃喃'],
  feature: ['标志', '特征', '疤痕', '伤疤', '纹身', '断臂', '瞎', '残废', '戴着', '眉心', '左眼', '右手', '脸上有'],
}

/**
 * 从一段文本里给某个名字抽四类描述（各取最长的一段句子）。
 *
 * 规则（简单、可解释）：
 *   1. 按句号/问号/叹号/换行切句；
 *   2. 只保留**含该名字**的句子；
 *   3. 句子命中某类关键词 → 归入该类；
 *   4. 每类保留**最长**的句子（上游 `best_appearance` 的同款规则）。
 *
 * @throws 不抛异常
 */
export function describeFromText(
  text: string,
  name: string,
  opts: { windowChars?: number } = {},
): CharacterDescriptions {
  const out: CharacterDescriptions = { appearance: null, personality: null, speech: null, feature: null }
  if (typeof text !== 'string' || text.length === 0 || !name) return out
  const window = Math.max(0, opts.windowChars ?? 40_000)
  const scoped = window > 0 && text.length > window ? text.slice(0, window) : text

  const sentences = scoped.split(/[。！？!?\n\r]+/)
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (sentence.length < 4 || sentence.length > 200) continue
    if (!sentence.includes(name)) continue
    for (const kind of CHARACTER_DESCRIPTION_KINDS) {
      const hit = DESCRIPTION_KEYWORDS[kind].some((k) => sentence.includes(k))
      if (!hit) continue
      const cur = out[kind]
      // 上游规则：保留最长的那条（最短的往往是「他」这类片段）
      if (cur === null || sentence.length > cur.length) out[kind] = sentence
    }
  }
  return out
}

/** 别名规范化：去空白、去重（保序）、排除与角色名相同的项（上游规则 1） */
export function normalizeAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of aliases) {
    const alias = (raw ?? '').trim()
    if (!alias) continue
    if (alias === name) continue
    if (seen.has(alias)) continue
    seen.add(alias)
    out.push(alias)
  }
  return out
}

/**
 * 把多次观察聚合成角色画像。
 *
 * 不去重名字相同的多次观察（那是聚合的意义），但**同名的观察必须合并成一条**：
 * 上游把「同一角色的多次提取结果」合并进同一个文件，再逐字段取最优值。
 *
 * @throws 不抛异常
 */
export function buildCharacterProfiles(
  observations: readonly CharacterObservation[],
  opts: BuildProfileOptions = {},
): CharacterProfile[] {
  const byName = new Map<string, CharacterProfile>()
  const aliasesByName = new Map<string, string[]>()

  for (const obs of observations) {
    const name = (obs.name ?? '').trim()
    if (!name) continue
    const prev = byName.get(name)
    const title = obs.chapterTitle ?? null
    const titles = prev ? [...prev.chapterTitles] : []
    if (title && !titles.includes(title)) titles.push(title)

    // 别名：跨观察累计后再统一规范化（上游也是先收进 set 再统一处理）
    const aliasBag = aliasesByName.get(name) ?? []
    aliasBag.push(...(obs.aliases ?? []))
    aliasesByName.set(name, aliasBag)

    const descriptions: CharacterDescriptions = prev
      ? { ...prev.descriptions }
      : { appearance: null, personality: null, speech: null, feature: null }
    if (obs.text) {
      const found = describeFromText(obs.text, name)
      for (const kind of CHARACTER_DESCRIPTION_KINDS) {
        const candidate = found[kind]
        if (!candidate) continue
        const cur = descriptions[kind]
        if (cur === null || candidate.length > cur.length) descriptions[kind] = candidate
      }
    }

    byName.set(name, {
      name,
      aliases: prev?.aliases ?? [],
      // 出现次数按上游口径**累加**（同一角色多次观察的各章计数相加）
      occurrences: (prev?.occurrences ?? 0) + Math.max(0, Math.floor(obs.occurrences)),
      chapterCount: titles.length,
      chapterTitles: titles,
      firstChapterTitle: prev?.firstChapterTitle ?? title,
      // 性别/年龄取**首个非未知**（上游 `if value != '未知' and not gender_found`）
      gender: prev?.gender ?? normalizeUnknown(obs.gender),
      ageHint: prev?.ageHint ?? normalizeUnknown(obs.ageHint),
      descriptions,
    })
  }

  const profiles: CharacterProfile[] = []
  for (const [name, profile] of byName) {
    profiles.push({ ...profile, aliases: normalizeAliases(name, aliasesByName.get(name) ?? []) })
  }

  // 排序：出现次数降序 → 章节数降序 → 首见章节顺序 → 名字（保证结果稳定可测）
  profiles.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      b.chapterCount - a.chapterCount ||
      a.name.localeCompare(b.name),
  )

  const maxProfiles = Math.max(1, opts.maxProfiles ?? 500)
  return profiles.slice(0, maxProfiles)
}

/** 「未知」的多种写法都当成「没有」：上游用的是字面量 `未知` */
function normalizeUnknown(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed === '未知' || trimmed === '不明' || trimmed === '待定' || trimmed === '暂无') return null
  return trimmed
}

export interface FilterProfilesResult {
  kept: CharacterProfile[]
  removed: CharacterProfile[]
}

/**
 * 按出现次数过滤（上游 `filter_characters.py` 的规则：< 3 次删除）。
 *
 * 返回**被删掉的**画像而不只是保留的：调用方要把「过滤掉多少个、典型样本是什么」
 * 如实告诉用户 —— 静默减少候选会让人以为「本来就这么少」。
 *
 * @throws 不抛异常
 */
export function filterCharacterProfiles(
  profiles: readonly CharacterProfile[],
  opts: { minOccurrences?: number } = {},
): FilterProfilesResult {
  const min = Math.max(1, Math.floor(opts.minOccurrences ?? UPSTREAM_MIN_OCCURRENCES))
  const kept: CharacterProfile[] = []
  const removed: CharacterProfile[] = []
  for (const p of profiles) {
    if (p.occurrences >= min) kept.push(p)
    else removed.push(p)
  }
  return { kept, removed }
}

/**
 * 章节切分口径（移植自上游 `split_novel.py`）：
 *   `re.split(r'(\n?第[\u4e00-\u9fa5\d]+章[^\n]*\n)', content)`
 *
 * 本仓库的分章由导入域用更完整的规则（`shared/text/chapter-split.ts`）完成，
 * 这里保留这条正则**只用于「上游口径的对照与测试」**，不要在业务流程里另起一套分章。
 *
 * @throws 不抛异常
 */
export const UPSTREAM_CHAPTER_PATTERN = /(\n?第[\u4e00-\u9fa5\d]+章[^\n]*\n)/g

export function splitChaptersByUpstreamRule(content: string): Array<{ title: string; body: string }> {
  if (typeof content !== 'string' || content.length === 0) return []
  const parts = content.split(UPSTREAM_CHAPTER_PATTERN)
  const out: Array<{ title: string; body: string }> = []
  for (let i = 1; i < parts.length - 1; i += 2) {
    const title = (parts[i] ?? '').trim()
    const body = parts[i + 1] ?? ''
    if (title) out.push({ title, body })
  }
  return out
}
