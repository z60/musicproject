/**
 * Novel Studio · 按说话人导入音频：说话人解析（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/12-功能域-录音.md、docs/91 §5.2.1（真实样本勘察）
 *
 * ## 这个模块解决什么问题
 *
 * 文件名只给了**两个字符串**（角色 token、CV token），而画本里用的是**全名**。
 * 真实样本里两者的关系并不总是「相等」：
 *
 * | 文件名 CV token | 画本里的 CV | 关系 |
 * |----------------|------------|------|
 * | `德钦`          | `德钦`      | 相等 |
 * | `月光`          | `月光_深白色` | **前缀**（缩写） |
 * | `兔小舟`        | `兔小舟`    | 相等 |
 * | `语心草`        | `语心草`    | 相等 |
 * | `春哥拿大顶`     | `春哥拿大顶` | 相等（配 8 个角色 → 多角色） |
 * | `春哥那个哥`     | —           | **完全对不上**（用户笔误，保留为负例） |
 *
 * 所以解析必须有**置信度分级**，并且最后一级必须是「未解析 → 交人工修正」，
 * 而不是硬猜。硬猜的后果是「导入的音频绑到了错误的角色」——
 * 这比「导入失败」严重得多，因为错误会静默流到对轨与成品里。
 *
 * ## 匹配策略（按置信度从高到低）
 *
 * 1. `exact`       —— 归一化后完全相等
 * 2. `prefix`      —— 一方是另一方的前缀（`月光` ⊂ `月光_深白色`）
 * 3. `contains`    —— 一方包含另一方（如文件名写了 `深白色`）
 * 4. `unresolved`  —— 都没命中 → **必须人工确认**，不自动落库
 *
 * 注意这里**不做编辑距离/拼音等模糊匹配**：中文名的编辑距离很容易把
 * `石志坚` 与 `石志强` 判成同一个，风险远大于收益。真匹配不上就交给人。
 *
 * 本目录禁止引入任何第三方依赖。
 */

import type { CanvasRosterEntry } from '../canvas/docx-canvas.ts'
import { normalizeName } from '../canvas/docx-canvas.ts'
import type { SpeakerTokenKind } from './filename.ts'

/** 匹配到的 CV 在画本里的档案 */
export interface ResolvedCv {
  /** 画本里 CV 的全名（如 `月光_深白色`） */
  name: string
  /** 该 CV 在画本里配过的角色名（按角色表去重） */
  characters: string[]
}

/** 匹配方式（决定是否可以直接自动导入） */
export type MatchMethod = 'exact' | 'prefix' | 'contains' | 'unresolved'

export interface SpeakerResolution {
  /** 文件名里的原始 token */
  rawToken: string
  /** 匹配到的画本对象；未解析时为 null */
  matched: ResolvedCv | null
  method: MatchMethod
  /**
   * 匹配置信度 0~1。
   * - `exact` = 1
   * - `prefix` = 0.9
   * - `contains` = 0.7
   * - `unresolved` = 0
   * 低于 1 时 UI 应提示用户确认（尤其是 prefix，缩写可能撞名）。
   */
  confidence: number
  /** 同分候选（prefix/contains 命中多个时），供 UI 让用户挑 */
  alternatives: ResolvedCv[]
  /** 未解析的原因（给用户看的） */
  reason: string | null
}

/** 一个 CV 的全部信息汇总（由角色表 + 正文共同得出） */
export interface CvIndex {
  /** 归一化名 → 档案 */
  byNormalized: Map<string, ResolvedCv>
  /** 全部 CV（按归一化名去重） */
  all: ResolvedCv[]
}

/**
 * 从角色表建立 CV 索引。
 *
 * 只用角色表（`roster`）而不是正文里的标记，理由：
 *   · 角色表是**作者登记过**的 CV↔角色 对应关系，比正文标记更权威
 *   · 正文标记里出现过 `【无-xxx】` 这种脏数据（真实样本里 CV 位是「无」），
 *     把它当成 CV 会污染匹配结果
 * 但角色表可能不含全部 CV，所以 `matchSpeaker` 会同时尝试正文侧的候选
 * （见 `buildCvIndexFromCanvas` 的 `extraCvs`）。
 */
export function buildCvIndex(roster: readonly CanvasRosterEntry[], extraCvs: readonly string[] = []): CvIndex {
  const byNormalized = new Map<string, ResolvedCv>()

  const upsert = (cvRaw: string | null, character: string | null): void => {
    const cv = (cvRaw ?? '').trim()
    if (cv.length === 0) return
    const key = normalizeName(cv)
    if (key.length === 0) return
    let entry = byNormalized.get(key)
    if (!entry) {
      entry = { name: cv, characters: [] }
      byNormalized.set(key, entry)
    }
    const ch = (character ?? '').trim()
    if (ch.length > 0 && !entry.characters.includes(ch)) entry.characters.push(ch)
  }

  for (const r of roster) upsert(r.cv, r.character)
  for (const cv of extraCvs) upsert(cv, null)

  return { byNormalized, all: [...byNormalized.values()] }
}

/**
 * 把文件名里的 CV token 解析成画本里的 CV。
 *
 * @param token 文件名第二个名字（CV）
 * @param index 由角色表建立的 CV 索引
 */
export function matchSpeaker(token: string, index: CvIndex): SpeakerResolution {
  const raw = String(token ?? '').trim()
  const key = normalizeName(raw)

  const unresolved = (reason: string, alternatives: ResolvedCv[] = []): SpeakerResolution => ({
    rawToken: raw,
    matched: null,
    method: 'unresolved',
    confidence: 0,
    alternatives,
    reason,
  })

  if (key.length === 0) return unresolved('CV 为空')

  // ── ① 完全相等 ────────────────────────────────────────────────────────────
  const exact = index.byNormalized.get(key)
  if (exact) {
    return {
      rawToken: raw,
      matched: exact,
      method: 'exact',
      confidence: 1,
      alternatives: [],
      reason: null,
    }
  }

  if (index.all.length === 0) {
    return unresolved('画本里没有可用的角色表（CV 列），无法匹配')
  }

  // ── ② 前缀：token 是画本 CV 的前缀（`月光` ⊂ `月光_深白色`）──────────────
  //    要求前缀长度 ≥ 2，否则单字前缀（如「李」）会命中一堆人。
  const prefixHits: ResolvedCv[] = []
  if (key.length >= 2) {
    for (const [k, v] of index.byNormalized) {
      if (k.startsWith(key) && k.length > key.length) prefixHits.push(v)
    }
  }
  if (prefixHits.length === 1) {
    return {
      rawToken: raw,
      matched: prefixHits[0]!,
      method: 'prefix',
      confidence: 0.9,
      alternatives: [],
      reason: `文件名里的「${raw}」是画本 CV「${prefixHits[0]!.name}」的缩写，已自动补全（请确认）`,
    }
  }
  if (prefixHits.length > 1) {
    return unresolved(
      `「${raw}」匹配到多个画本 CV（${prefixHits.map((c) => c.name).join('、')}），无法确定是哪一个`,
      prefixHits,
    )
  }

  // ── ③ 包含：画本 CV 是 token 的前缀（文件名写了全名 + 额外后缀）──────────
  const containsHits: ResolvedCv[] = []
  for (const [k, v] of index.byNormalized) {
    if (key.includes(k) && k.length >= 2) containsHits.push(v)
  }
  if (containsHits.length === 1) {
    return {
      rawToken: raw,
      matched: containsHits[0]!,
      method: 'contains',
      confidence: 0.7,
      alternatives: [],
      reason: `文件名里的「${raw}」包含画本 CV「${containsHits[0]!.name}」，已按包含关系匹配（请确认）`,
    }
  }
  if (containsHits.length > 1) {
    return unresolved(
      `「${raw}」包含多个画本 CV（${containsHits.map((c) => c.name).join('、')}），无法确定`,
      containsHits,
    )
  }

  // ── ④ 未解析 ──────────────────────────────────────────────────────────────
  //    明确不猜。真实样本里若 CV 名写错（如把 `春哥拿大顶` 写成 `春哥那个哥`）就走这里 ——
  //    硬猜会静默绑错角色，比导入失败严重得多。
  return unresolved(
    `画本里找不到与「${raw}」对应的 CV（可能写的是别的名字，如艺名/昵称）`,
    [],
  )
}

/**
 * 判定「这个文件是否可以把行自动绑定到单一角色」。
 *
 * 规则（来自真实样本）：
 *   · `character` —— 第一个 token 命中角色表 → 绑定该角色
 *   · `multiRole` —— 该 CV 配了多个角色 → **不能**绑单一角色，要靠每行的
 *                    `character_id` 决定（见 `plan.ts`）
 *   · `narration` —— 旁白 → 绑旁白行
 *   · `cvOnly`   —— 文件名**只给了一个名字**（`2201-2300-珊瑚水月`）：那是 CV，
 *                   覆盖「该 CV 在这一段里的全部行」，角色同样由 CV 反查
 *   · `unknown`   —— 第一个 token 没命中角色表。这时看 CV：
 *                   CV 只配了 1 个角色 → 可以收敛到那个角色（例如用户把
 *                   「角色-CV」写反了，或角色用了别名）；否则不能自动绑定。
 */
export interface SpeakerTarget {
  kind: SpeakerTokenKind | 'cv-single-role'
  /** 要绑定的角色名（`kind='character'` 或收敛成功时有值） */
  character: string | null
  /**
   * 画本里 CV 的**全名**（如 `月光_深白色`）；未解析时为 null。
   *
   * 必须显式带出来：`multiRole` 的选行要靠它去匹配每行的 `owner.cv`，
   * 若靠「文件名 token 反推」就会漏掉 `月光` → `月光_深白色` 这种补全，
   * 结果是「解析显示成功、却一行都选不到」。
   */
  cvName: string | null
  /** 该 CV 在画本里的全部角色 */
  cvCharacters: string[]
  /** 规范化后的说明，UI 直接显示 */
  explanation: string
}

export function decideTarget(
  speakerKind: SpeakerTokenKind,
  /** 角色 token；`cvOnly`（文件名只给了 CV）时为 `null` */
  characterToken: string | null,
  roster: readonly CanvasRosterEntry[],
  cvResolution: SpeakerResolution,
): SpeakerTarget {
  const cvChars = cvResolution.matched?.characters ?? []
  const cvName = cvResolution.matched?.name ?? null

  // 第一个 token 命中角色表 → 直接绑定
  const charKey = normalizeName(characterToken ?? '')
  const rosterCharHit = roster.some((r) => normalizeName(r.character) === charKey)
  if (rosterCharHit && speakerKind !== 'multiRole' && speakerKind !== 'narration') {
    return {
      kind: 'character',
      character: characterToken,
      cvName,
      cvCharacters: cvChars,
      explanation: `按角色「${characterToken}」匹配`,
    }
  }

  if (speakerKind === 'narration') {
    return {
      kind: 'narration',
      character: null,
      cvName,
      cvCharacters: cvChars,
      explanation: `按旁白匹配（CV「${cvName ?? cvResolution.rawToken}」）`,
    }
  }

  if (speakerKind === 'multiRole') {
    if (cvChars.length === 1) {
      // 标了「多角色」但该 CV 只配了 1 个角色 → 实际上能收敛
      return {
        kind: 'cv-single-role',
        character: cvChars[0]!,
        cvName,
        cvCharacters: cvChars,
        explanation: `标为「多角色」，但 CV「${cvName ?? ''}」只配了 1 个角色（${cvChars[0]}），已收敛到该角色`,
      }
    }
    if (cvChars.length > 1) {
      return {
        kind: 'multiRole',
        character: null,
        cvName,
        cvCharacters: cvChars,
        explanation: `多角色：按 CV「${cvName ?? cvResolution.rawToken}」在区间内的全部行匹配（${cvChars.length} 个角色）`,
      }
    }
    // 标了「多角色」，但 CV 一个角色都没匹配上（真实场景：CV 名写错，
    // 如把画本里的「春哥拿大顶」写成「春哥那个哥」）。
    // ⚠️ 这里必须返回 `unknown` 而不是 `multiRole`：`multiRole` 会用
    // `cvName` 去选行，而 `cvName` 是 null，结果「一行都选不到」却又被
    // 归类成「无行」——用户看不到这个文件，也没有地方修正它。
    // 返回 `unknown` 才能让它进入「需人工确认」并给出指定角色的入口。
    return {
      kind: 'unknown',
      character: null,
      cvName,
      cvCharacters: [],
      explanation: `标为「多角色」，但 CV「${cvResolution.rawToken}」在画本里找不到对应记录，无法确定涉及哪些角色`,
    }
  }

  /**
   * `cvOnly`：文件名只给了 CV（真机样本里 24 个文件有 11 个是这种）。
   *
   * 它与「角色 token 没命中角色表」的 `unknown` 处理**完全相同**（都只能看 CV），
   * 单独一支的意义是把说明文案写对：`unknown` 说「角色 token 未命中」会让人
   * 去找一个根本不存在的角色，而这里应当说「文件名只给了 CV」。
   */
  if (speakerKind === 'cvOnly') {
    if (cvChars.length === 1) {
      return {
        kind: 'cv-single-role',
        character: cvChars[0]!,
        cvName,
        cvCharacters: cvChars,
        explanation: `文件名只给了 CV「${cvName ?? cvResolution.rawToken}」（只配 1 个角色 ${cvChars[0]}），按该角色匹配`,
      }
    }
    if (cvChars.length > 1) {
      return {
        kind: 'multiRole',
        character: null,
        cvName,
        cvCharacters: cvChars,
        explanation: `文件名只给了 CV「${cvName ?? cvResolution.rawToken}」：按该 CV 在区间内的全部行匹配（${cvChars.length} 个角色）`,
      }
    }
    return {
      kind: 'unknown',
      character: null,
      cvName,
      cvCharacters: [],
      explanation: `文件名只给了 CV「${cvResolution.rawToken}」，但画本里找不到这个 CV（可能写的是别的名字）`,
    }
  }

  // speakerKind === 'unknown'：第一个 token 没命中角色表
  if (cvChars.length === 1) {
    return {
      kind: 'cv-single-role',
      character: cvChars[0]!,
      cvName,
      cvCharacters: cvChars,
      explanation: `角色 token「${characterToken ?? ''}」未命中角色表，但 CV 只配了 1 个角色（${cvChars[0]}），已收敛`,
    }
  }
  if (cvChars.length > 1) {
    return {
      kind: 'multiRole',
      character: null,
      cvName,
      cvCharacters: cvChars,
      explanation: `角色 token「${characterToken ?? ''}」未命中角色表，且 CV 配了多个角色，按 CV 的全部行匹配`,
    }
  }
  return {
    kind: 'unknown',
    character: null,
    cvName,
    cvCharacters: [],
    explanation: `无法判定说话人（角色 token「${characterToken ?? ''}」与 CV 都未匹配上）`,
  }
}
