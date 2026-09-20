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
  guessNameVariants,
  looksLikePersonName,
  matchCue,
  parseSpeakerLabel,
} from './attribution.ts'
import {
  isRoleTitle,
  looksLikeAppellation,
  looksLikeTransliteratedName,
  normalizeSurname,
  startsWithSurname,
} from './person-name.ts'

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
  /**
   * 是否要求**人名形态证据**（默认 true，见 docs/91 §5.2.32）。
   *
   * 关掉它 = 回到「只要在引导语窗口里出现过就算候选」的旧行为（更全、但会带进一堆常用词）。
   */
  requirePersonEvidence?: boolean
  /**
   * 被形态证据挡掉的候选（用于日志与界面说明；纯函数不自己打日志）。
   *
   * 用法：调用方传入收集器，抽完自己写日志/上报 —— 这样「候选变少了」永远有解释。
   */
  onReject?: (rejected: ReadonlyArray<{ name: string; occurrences: number; reason: string }>) => void
}

/** 形态证据：一个候选凭什么被认为「像角色」。任一成立即通过（还要叠加主语位置证据） */
export type PersonEvidenceKind =
  /** 以常见姓氏开头（含异体归一：沉破天 → 沈破天） */
  | 'surname'
  /** 音译名形态（哈维尔 / 诺顿·阿兰 / 舍沙） */
  | 'transliterated'
  /** 称谓写法（老张 / 小炎子 / 荒老 / 大白猫 / 药老 / X长老） */
  | 'appellation'
  /** 角色称谓表（师尊 / 掌教 / 祖师 / 剑尊 / 冰帝） */
  | 'role_title'
  /** 行首说话人位置——整段就是名字（`无畏：“…”`） */
  | 'speaker_position'
  /** 行首说话人位置——只是名字前缀（`无畏翻了个白眼：“…”`） */
  | 'dialogue_lead'
  /** 注入的分词器把它标成了人名词性（nr / nrt）—— 这是最权威的证据 */
  | 'ner'

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
    // 后缀表与 `person-name.ts` 的 ZUNCHENG_SUFFIXES 保持一致口径（含角色称谓表里的 祖师/掌教），
    // 这样 `顾安祖师` / `晏掌教` 才能作为别名并到正名下，而不是留下一个切片
    regex: /([\u4e00-\u9fa5]{1,2})(长老|大人|前辈|姑娘|少爷|公子|小姐|夫人|道友|师兄|师姐|师妹|宗主|掌门|阁下|师叔|师尊|祖师|掌教|门主|护法|城主|族长)/g,
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
    {
      positions: Set<string>
      viaCue: number
      viaAppellation: number
      viaNer: number
      /** 行首说话人位置命中次数（`无畏：“…”`）—— 最强的人名证据 */
      viaSpeakerPosition: number
      /** 行首说话人位置的**前缀**命中次数（`无畏翻了个白眼：“…”` → 「无畏翻」） */
      viaDialogueLead: number
      aliases: Set<string>
    }
  >()
  const appellations = new Map<string, number>()
  const bump = (name: string, via: 'cue' | 'appellation' | 'ner' | 'speaker' | 'dialogue', key: string): void => {
    if (name.length < 2) return
    if (stopwords.has(name)) return
    if (!/^[\u4e00-\u9fa5A-Za-z·]+$/.test(name)) return
    // 字型检查：窗口规则会把「无奈 / 续开口 / 的丑陋」这种状语、动词碎片当成人名，
    // 必须在这里挡掉（真机反馈见 docs/91 §5.2.14）
    if (!looksLikePersonName(name)) return
    const rec = hits.get(name) ?? {
      positions: new Set<string>(),
      viaCue: 0,
      viaAppellation: 0,
      viaNer: 0,
      viaSpeakerPosition: 0,
      viaDialogueLead: 0,
      aliases: new Set<string>(),
    }
    if (!rec.positions.has(key)) {
      rec.positions.add(key)
      if (via === 'cue') rec.viaCue += 1
      else if (via === 'appellation') rec.viaAppellation += 1
      else if (via === 'speaker') rec.viaSpeakerPosition += 1
      else if (via === 'dialogue') rec.viaDialogueLead += 1
      else rec.viaNer += 1
    }
    hits.set(name, rec)
  }

  // ---- 信号 1：引导语前 2~6 字窗口的人名 ----
  const cueVerbs = [...CUE_VERBS, ...INNER_CUE_VERBS].sort((a, b) => b.length - a.length)
  const cueRe = new RegExp(
    // 窗口里允许间隔号「·」：译名常写成「诺顿·阿兰」，不含它就只能抽到「阿兰」
    `([\\u4e00-\\u9fa5·]{1,6}?)(?:${cueVerbs.map(escapeRe).join('|')})(?:道|着|了一声)?\\s*[：:，,。]`,
    'g',
  )
  for (const m of text.matchAll(cueRe)) {
    const window = m[1]
    const at = m.index ?? 0
    // 一个窗口可能同时是「全名」与「带修饰语的名字」：
    //   `独眼多特冷笑` → 剥掉修饰语后是全名「独眼多特」；`药老皱眉` → 「药老」
    // 所以把「剥完修饰语的整体」与「末尾 3/2 字」都作为候选提交，
    // 再由后面的片段收敛按**出现位置是否被长者覆盖**决定留谁（子串关系不足以判断）。
    for (const candidate of guessNameVariants(window)) {
      bump(candidate, 'cue', `at@${at}`)
    }
  }

  /**
   * ---- 信号 1b：剧本体「名字：「台词」」的行首主语（真机反馈，docs/91 §5.2.30）----
   *
   * 为什么必须单列一条：`无畏：“你瞎啊…”` / `无畏翻了个白眼：“你瞎啊…”` 这种写法
   * **没有任何言语引导语动词**，信号 1 一条都抽不到；而它恰恰是中文网文最常见的对白体之一。
   * 真机实测（《我陪魔神历劫》第 2 章）：整章 726 字、全是这种写法，抽取结果为 **0 个候选**，
   * 用户点「自动抽取」时界面什么都不出现。
   *
   * 解析逻辑与**判定层**共用 `parseSpeakerLabel`（`attribution.ts`）—— 同一套「行首说话人标签」
   * 既要能抽出候选，又要能在生成画本时把台词判给那个人；两处各写一遍必然会漂移。
   * 这里只负责把解析结果登记成候选证据：
   *   · 整段就是名字（`纳兰嫣然：`）→ `speaker`（最强证据：他正在说话）
   *   · 只是名字前缀（`无畏翻了个白眼` → 「无畏」）→ `dialogue`（弱一档）
   */
  let lineStart = 0
  for (const line of text.split('\n')) {
    const parsed = parseSpeakerLabel(line)
    if (parsed) {
      const strong = parsed.hint === parsed.window
      bump(parsed.hint, strong ? 'speaker' : 'dialogue', `dialogue@${lineStart}`)
    }
    lineStart += line.length + 1
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
      /**
       * 「X儿 / X兄」当**后缀词**用时极易命中长词的一部分：`员工兄弟` → 「工兄」、
       * `一会儿` → 「会儿」。判据：捕获到的词若紧跟在另一个汉字后面，就是长词的一部分，
       * 不是独立称谓（`炎儿，你来了` / 换行后的 `张兄` 前面不是汉字，照常保留）。
       * 只对「单字核心 + 后缀」这两个模式生效 —— `老X / 小X / X长老` 是前缀式，不受此限。
       */
      if (pattern.id === 'er' || pattern.id === 'xiong') {
        const before = (m.index ?? 0) > 0 ? text[(m.index ?? 0) - 1] : ''
        if (before && /[\u4e00-\u9fa5]/.test(before)) continue
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
    const core = appellationCore(word)
    const owner = core.length === 0 ? null : findAppellationOwner(word, core, hits)
    if (!owner) {
      /**
       * 归不到任何全名时有两种可能：
       *   · `老张` / `荒老` 本身就是一个称谓式角色 → 留着（形态证据会放行）
       *   · `拜见师尊` / `知道师尊` / `劳烦师尊` 是**动词短语**被尊称模式切出来的 → 丢掉
       *     （真机实测：`师尊` 名下曾挂上 60 多个这种垃圾别名，界面上完全没法看）
       */
      if (!isStandaloneAppellation(word) || isZunchengForm(word)) hits.delete(word)
      continue
    }
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
  /**
   * 一次扫描建立「候选名 → 出现位置」索引。
   *
   * ⚠️ 性能：整本书抽取时正文可达一两百万字、候选上千个。
   * 每个候选各扫一遍全文（`indexOf` 循环）是 O(候选 × 正文)，
   * 后面的「覆盖率」判定又是候选两两比较 —— 实测会让整本书抽取**跑几分钟**（超时）。
   * 所以这里做一次 O(正文) 的扫描，之后所有统计与两两判定都只在位置数组上做。
   */
  const names = [...hits.keys()]
  const positions = indexOccurrences(text, names)

  const observations: Array<{ name: string; rec: (typeof hits) extends Map<string, infer V> ? V : never; pos: number[] }> = []
  for (const [name, rec] of hits) {
    observations.push({ name, rec, pos: positions.get(name) ?? [] })
  }

  // 先按「语料里的实际出现次数」筛一遍（便宜），再做贵的片段收敛 —— 顺序很重要
  const strict = minOccurrences >= 2
  const survived = observations.filter((o) => {
    if (o.pos.length < minOccurrences) return false
    /**
     * 严格模式（默认）再加一条：它必须在正文里**至少有一次不紧跟言语引导语**的出现。
     *
     * 为什么必须有这条：单字引导语（道/说/问）会命中复合词 —— `知道，` `下水道，` `难道，`
     * 于是「要知 / 不知 / 下水」都会被抽出来，而它们**每一次**出现都是复合词的一部分。
     * 真角色则相反：叙述里到处都在提他的名字（`叶海摊摊手` `苏哲点点头`）。
     * 宽松模式（minOccurrences=1）刻意关掉这条，保留「宁可多给也不漏」的行为。
     */
    if (strict && !o.pos.some((p) => isStandaloneAt(text, p, o.name.length))) return false
    return true
  })

  // 片段收敛：把「只是某个更长候选的一部分」的碎片去掉（拉希 ⊂ 拉希德、眼多特 ⊂ 独眼多特）
  const collapsed = collapseCoveredFragments(text, survived)

  /**
   * 简称并入全名：`阿兰` 的绝大多数出现都落在 `诺顿·阿兰` 里 → 它是**别名**而不是另一个角色。
   *
   * 阈值取 0.8 而不是 1.0：简称偶尔会独立出现（`阿兰道：`），
   * 而 1.0 会让它作为独立候选留在列表里，让用户误以为抽出了两个角色。
   * 两个**真正不同**的角色（`林轩` 与 `林轩宇`）覆盖率会明显偏低（各有一半独立出现），不会被并入。
   */
  const merged = mergeShortFormsIntoFullNames(text, collapsed)

  const beforeEvidence = merged.filter((m) => !isPrefixFragmentOfFrequent(m, merged))

  // ---- 人名形态证据（docs/91 §5.2.32）：把常用词挡在候选之外 ----
  const requireEvidence = opts?.requirePersonEvidence !== false
  const kept: Observation[] = []
  const rejected: Array<{ name: string; occurrences: number; reason: string }> = []
  for (const cand of beforeEvidence) {
    if (!requireEvidence) {
      kept.push(cand)
      continue
    }
    const evidence = personEvidenceOf(cand, text)
    if (evidence !== null) {
      kept.push(cand)
      continue
    }
    rejected.push({ name: cand.name, occurrences: cand.pos.length, reason: 'not-person-like' })
  }
  if (rejected.length > 0) opts?.onReject?.(rejected)

  // ---- 异体姓氏归并：`沉破天` 是 `沈破天` 的异体写法 → 并成别名，而不是两个角色 ----
  mergeSurnameVariants(text, kept)

  const out: CharacterCandidate[] = kept
    .map((m) => ({
      name: m.name,
      aliases: [...m.rec.aliases],
      occurrences: m.pos.length,
      firstChapterTitle: opts?.chapterTitle ?? null,
    }))
  // 出现越多越可能是主要角色 → 降序；同次数按名字稳定排序（结果可复现）
  out.sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name))
  return out.slice(0, maxCandidates)
}

/** 候选（名字 + 信号记录 + 出现位置） */
interface Observation {
  name: string
  rec: {
    positions: Set<string>
    viaCue: number
    viaAppellation: number
    viaNer: number
    viaSpeakerPosition: number
    viaDialogueLead: number
    aliases: Set<string>
  }
  pos: number[]
}

/** 称谓的前缀（`老张` / `小炎子` / `大黑` / `阿兰`） */
const APPELLATION_PREFIXES = ['老', '小', '大', '阿'] as const

/** 称谓的后缀（`炎儿` / `张兄` / `荒老` / `景琼师兄` / `晏掌教` / `顾安祖师`） */
const APPELLATION_SUFFIXES: readonly string[] = [
  '儿', '兄', '老', '长老', '大人', '前辈', '姑娘', '少爷', '公子', '小姐', '夫人',
  '道友', '师兄', '师姐', '师妹', '宗主', '掌门', '阁下', '师叔', '师尊', '弟子',
  // 与 `person-name.ts` 的 ZUNCHENG_SUFFIXES 保持同一口径：这些是「角色称谓」，
  // 少一个都会让 `顾安祖师` 这类写法并不到正名下，只能被丢掉
  '祖师', '掌教', '门主', '护法', '城主', '族长', '家主', '尊者', '上人', '真人',
]

/** 去掉称谓前后缀，留下「名字部分」（`景琼师兄` → `景琼`） */
function appellationCore(word: string): string {
  let core = word
  for (const prefix of APPELLATION_PREFIXES) {
    if (core.length > prefix.length && core.startsWith(prefix)) {
      core = core.slice(prefix.length)
      break
    }
  }
  for (const suffix of [...APPELLATION_SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (core.length > suffix.length && core.endsWith(suffix)) {
      core = core.slice(0, core.length - suffix.length)
      break
    }
  }
  return core
}

/**
 * 给一个称谓词找它的「正名」。
 *
 * 判定按可信度从高到低，**必须有证据**，不能凭「字符串包含」就归并：
 *
 *   1. 精确的前后缀组合：`景琼师兄` = `景琼` + 师兄、`小沈` = 小 + `沈`（正名必须是候选）
 *   2. 多字名字部分本身就是候选：`晏掌教` 的 `晏` …不成立；`景琼师叔` 的 `景琼` 成立
 *   3. 单字昵称：`炎儿`/`小炎` → 正名里含这个字（真机回归：`炎儿 → 萧炎`）
 *
 * 反例（必须挡住）：`拜见师尊` / `劳烦师尊` —— 它们是「动词 + 尊称」的短语，
 * 名字部分是动词、也不在候选里，按字符串包含关系会被错误挂到 `师尊` 名下（真机实测 60+ 个）。
 */
function findAppellationOwner(
  word: string,
  core: string,
  hits: Map<string, Observation['rec']>,
): string | null {
  for (const name of hits.keys()) {
    if (name === word) continue
    // 1) 精确的前后缀组合
    if (word.startsWith(name) && APPELLATION_SUFFIXES.includes(word.slice(name.length))) return name
    if (word.endsWith(name) && (APPELLATION_PREFIXES as readonly string[]).includes(word.slice(0, word.length - name.length))) {
      return name
    }
  }
  for (const name of hits.keys()) {
    if (name === word) continue
    // 2) 多字名字部分本身就是候选（`景琼师叔` → 景琼）
    if (core.length >= 2 && name === core) return name
    // 3) 单字昵称（`炎儿` / `小炎` → 萧炎），且正名必须有引导语证据，避免随便沾一个字就并
    if (core.length === 1 && word.length <= 3 && name.includes(core) && hits.get(name)!.viaCue > 0) return name
  }
  return null
}

/**
 * 归不到正名的称谓词，本身能不能作为角色留下？
 *
 * `老张 / 荒老 / 大白猫` 可以（它们就是「某老」「某猫」这种称谓式角色）；
 * `拜见师尊 / 劳烦师尊` 不行 —— 前缀或名字部分不像名字，说明它是被切出来的动词短语。
 */
function isStandaloneAppellation(word: string): boolean {
  const core = appellationCore(word)
  if (core.length === 0) return false
  if (looksLikePersonName(core)) return true
  // `老张` / `小沈` / `大白`：核心 1 字 + 称谓前缀
  if (/^[老小大阿][\u4e00-\u9fa5]$/.test(word)) return true
  // `荒老` / `练老`：核心 1 字 + `X老` 写法
  return /^[\u4e00-\u9fa5]老$/.test(word)
}

/** 「名字 + 尊称」的后缀（`景琼师兄` / `晏掌教`）—— 必须有正名才留，否则就是动词短语切片 */
const ZUNCHENG_SUFFIXES: readonly string[] = [
  '长老', '大人', '前辈', '姑娘', '少爷', '公子', '小姐', '夫人', '道友', '师兄',
  '师姐', '师妹', '宗主', '掌门', '阁下', '师叔', '师尊', '掌教', '祖师',
]

/** 该词是不是「名字 + 尊称」形式（这种形式只有找到正名才允许保留） */
export function isZunchengForm(word: string): boolean {
  return ZUNCHENG_SUFFIXES.some((suffix) => word.length > suffix.length && word.endsWith(suffix))
}

/**
 * 一条候选能不能被当成「人」：**形态证据 + 位置证据**都成立才通过（docs/91 §5.2.32）。
 *
 * 形态证据（任一）：分词器 nr / 行首说话人位置 / 角色称谓 / 称谓写法 / 姓氏开头 / 音译名形态。
 * 位置证据：至少有 5% 的出现在**句首**（至少 1 次）—— 真人名会反复做主语。
 *
 * 为什么非要有形态证据：真机 122 万字抽出的 230 个候选里，`开始(355)`、`上面(354)`、
 * `尽管(245)`、`躬身(106)`、`随口(74)`、`随后轻(29)` 全是**引导语窗口切错的常用词**，
 * 它们的「出现次数」比一半真角色都高 —— 按次数过滤拦不住（`随口问道` 能命中 62 次），
 * 只有形态能拦：这些词没有一个以姓氏开头、也没有一个是音译名形态。
 *
 * 为什么要位置证据（反例）：`马上 / 高兴 / 于是 / 后来` 都以姓氏字开头，
 * 但它们在句首出现的比例很低（`随口` 74 次里只有 1 次），而真人名是 17%~61%。
 *
 * 返回命中的形态证据名（便于 UI 解释「为什么它是候选」）；不通过返回 null。
 */
function personEvidenceOf(cand: Observation, text: string): PersonEvidenceKind | null {
  const name = cand.name
  const shape: PersonEvidenceKind | null =
    cand.rec.viaNer > 0 ? 'ner'
    : cand.rec.viaSpeakerPosition > 0 ? 'speaker_position'
    : cand.rec.viaDialogueLead > 0 ? 'dialogue_lead'
    : isRoleTitle(name) ? 'role_title'
    : looksLikeAppellation(name) ? 'appellation'
    : startsWithSurname(name) ? 'surname'
    : looksLikeTransliteratedName(name) ? 'transliterated'
    : null
  if (shape === null) return null
  /**
   * 位置证据的豁免：分词器 `nr`、行首说话人位置、以及**角色称谓表**里的词。
   *
   * 前两者本身就是「这里是人在说话」的证据；角色称谓是人工维护的窄表（师尊/掌教/剑尊…），
   * 它们在文中多为**称呼语**（`拜见掌教`、`掌教大人`），句首比例天然偏低 ——
   * 真机实测 `掌教` 1398 次里只有 39 次在句首（2.8%），拿 5% 去卡会误杀。
   */
  if (shape === 'ner' || shape === 'speaker_position' || shape === 'role_title') return shape
  return hasEnoughSentenceStart(cand, text) ? shape : null
}

/**
 * 句首出现比例是否够（≥ 5%，且至少 1 次）。
 *
 * 5% 这个量级是实测来的：真机上真角色是 17%~61%（`小丧` 1/6 最低、`姜练` 3261/5304 最高），
 * 而被误抽的常用词是 0%~1.4%（`开始` 0/355、`躬身` 0/106、`随口` 1/74）。
 * 取 5% 既能让只出场几次的小角色过关，又能把常用词的偶然句首出现挡在外面。
 */
function hasEnoughSentenceStart(cand: Observation, text: string): boolean {
  const atStart = cand.pos.filter((p) => p === 0 || SENTENCE_BOUNDARY.has(text[p - 1] ?? '')).length
  if (atStart === 0) return false
  return atStart / Math.max(1, cand.pos.length) >= 0.05
}

/** 句子/段落边界字符（句首判定用） */
const SENTENCE_BOUNDARY = new Set([...'\n。！？…"」』”’'])

/**
 * 异体姓氏归并：`沉破天(253)` 与 `沈破天(233)` 是同一个角色的两种写法。
 *
 * 判据：两个候选**只有首字不同**、其余部分完全相同、且首字是一对已知异体（沉/沈、肖/萧…）。
 * 标准写法的那个留作正名，另一个并成别名（否则用户会看到两个角色，还得手动合并）。
 * 注意这里**不**改出现次数：与「简称并入全名」同一口径，别名不重复计入正名的出现次数。
 */
function mergeSurnameVariants(_text: string, candidates: Observation[]): void {
  const drop = new Set<string>()
  for (const cand of candidates) {
    const normalized = normalizeSurname(cand.name)
    if (normalized === cand.name) continue
    const standard = candidates.find((c) => c.name === normalized)
    if (!standard) continue
    if (!standard.rec.aliases.has(cand.name)) standard.rec.aliases.add(cand.name)
    drop.add(cand.name)
  }
  if (drop.size === 0) return
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (drop.has(candidates[i]!.name)) candidates.splice(i, 1)
  }
}

/** 引导语动词的**首字**集合（判断「名字后面是不是紧跟着言语引导语」用） */
const CUE_VERB_HEADS = new Set(
  [...CUE_VERBS, ...INNER_CUE_VERBS].filter((v) => v.length > 0).map((v) => v[0]!),
)

/** 位置 `pos` 处的 `len` 字是否**不紧跟**言语引导语（`不知道` 里的「不知」紧跟「道」） */
function isStandaloneAt(text: string, pos: number, len: number): boolean {
  return !CUE_VERB_HEADS.has(text[pos + len] ?? '')
}

/**
 * 一次扫描建立「候选名 → 全部出现位置」。
 *
 * 做法：先按**首字**把候评分桶，然后扫一遍正文，只在首字命中时才做 `startsWith` 比较。
 * 候选上千、正文一两百万字时这仍是可行量级（首字命中是小概率事件）。
 */
function indexOccurrences(text: string, names: readonly string[]): Map<string, number[]> {
  const byFirst = new Map<string, string[]>()
  for (const name of names) {
    const first = name[0]!
    const list = byFirst.get(first)
    if (list) list.push(name)
    else byFirst.set(first, [name])
  }
  const out = new Map<string, number[]>()
  for (const name of names) out.set(name, [])
  for (let i = 0; i < text.length; i++) {
    const cands = byFirst.get(text[i]!)
    if (!cands) continue
    for (const name of cands) {
      if (text.startsWith(name, i)) out.get(name)!.push(i)
    }
  }
  return out
}

/**
 * 去掉「完全被更长候选覆盖」的片段。
 *
 * 判据：若候选 X 的**每一次出现**都落在某个更长候选 Y 的出现区间内，
 * 那 X 就不是一个独立的名字，只是 Y 的一部分 → 丢掉 X。
 *
 * 为什么不能简单地「短名是长名子串就丢」：`林轩` 与 `林轩宇` 可能是**两个不同角色**
 * （林轩有 5 次是独立出现的），这种必须都留下。所以要看**出现位置**，不看字符串包含关系。
 */
function collapseCoveredFragments(text: string, candidates: Observation[]): Observation[] {
  void text
  // 长者优先判定（同长度时保留出现次数多的）
  const ordered = [...candidates].sort(
    (a, b) => b.name.length - a.name.length || b.pos.length - a.pos.length || a.name.localeCompare(b.name),
  )
  const kept: Observation[] = []
  for (const cand of ordered) {
    const covered = kept.some((longer) => isFullyCoveredBy(cand, longer))
    if (!covered) kept.push(cand)
  }
  return kept
}

/** 短名的每一次出现是否都落在长名的某个出现区间内 */
function isFullyCoveredBy(short: Observation, long: Observation): boolean {
  return coverageRatio(short, long) >= 1
}

/**
 * 短名的出现里有多大比例落在长名的出现区间内（0~1）。
 *
 * 用途见 `mergeShortFormsIntoFullNames`：覆盖率高（≥0.8）说明短名基本只是长名的一部分，
 * 应当作为别名并入；覆盖率低（两个真角色各有一半独立出现）则必须都保留。
 *
 * 实现走**位置数组 + 二分**，不再扫正文（整本书抽取时正文可达百万字，逐个扫会超时）。
 */
function coverageRatio(short: Observation, long: Observation): number {
  if (short.name === long.name || short.name.length >= long.name.length) return 0
  if (short.pos.length === 0 || long.pos.length === 0) return 0
  let inside = 0
  for (const p of short.pos) {
    // 找最后一个「起点 ≤ p」的长名出现
    let lo = 0
    let hi = long.pos.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (long.pos[mid]! <= p) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    // 覆盖它的那次出现必须延伸到短名之后（`阿兰` 落在 `诺顿·阿兰` 内）
    if (best >= 0 && long.pos[best]! + long.name.length >= p + short.name.length) inside++
  }
  return inside / short.pos.length
}

/**
 * 把「简称」并入更长的全名（`阿兰` → `诺顿·阿兰` 的别名），返回并入后的候选列表。
 *
 * 判据：短名的出现有 ≥80% 落在某个更长候选的出现区间内。
 * 这样既能收掉「同一个人出现两个候选」，又不会把两个真正不同的角色（`林轩` / `林轩宇`）并掉。
 */
function mergeShortFormsIntoFullNames(text: string, candidates: Observation[]): Observation[] {
  void text
  const byLengthDesc = [...candidates].sort(
    (a, b) => b.name.length - a.name.length || b.pos.length - a.pos.length || a.name.localeCompare(b.name),
  )
  const out: Observation[] = []
  for (const cand of byLengthDesc) {
    const owner = out.find(
      (longer) => longer.name.length > cand.name.length && coverageRatio(cand, longer) >= 0.8,
    )
    if (!owner) {
      out.push(cand)
      continue
    }
    // 并入别名（去重；别名本身也不再作为独立候选）
    if (!owner.rec.aliases.has(cand.name)) owner.rec.aliases.add(cand.name)
  }
  return out
}

/**
 * 丢掉「真名的前缀碎片」：`叶海微`（来自 `叶海微笑道`）之于 `叶海`。
 *
 * 判据：X 比 Y 长、Y 是 X 的前缀、且 Y 的出现次数是 X 的 **10 倍以上**。
 * 10 倍这个量级是刻意的：真名在语料里压倒性地多（叶海 9342 : 叶海微 238 ≈ 39 倍），
 * 而两个**真正不同**的角色（`林轩` 10 次 / `林轩宇` 5 次）差值很小，绝不会被误删。
 */
function isPrefixFragmentOfFrequent(cand: Observation, all: readonly Observation[]): boolean {
  return all.some(
    (other) =>
      other !== cand &&
      other.name.length < cand.name.length &&
      cand.name.startsWith(other.name) &&
      other.pos.length >= cand.pos.length * 10,
  )
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
