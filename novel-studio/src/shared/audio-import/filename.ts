/**
 * Novel Studio · 按说话人导入音频：文件名解析（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/12-功能域-录音.md（录音域）、docs/91 §5.2.1（真实样本勘察）
 *
 * ## 命名约定（由真实样本归纳，不是拍脑袋定的）
 *
 * ```
 * 2127-2300-石玉凤-德钦.mp3
 * └──┬───┘ └─┬─┘ └┬┘
 *    │       │    └── 第二个名字 = **CV（配音演员）**
 *    │       └─────── 第一个名字 = **角色名**，或保留标记（多角色 / 旁白）
 *    └─────────────── 章节区间（这个文件覆盖第 2127~2300 章）
 * ```
 *
 * ### 真实交付里混着四种写法（`…/音频` 的 24 个样本全都要认）
 *
 * | 写法 | 例子 | 说明 |
 * |------|------|------|
 * | 区间 + 角色 + CV | `2127-2300-石玉凤-德钦` | 最标准的一种 |
 * | 区间分隔符用 `~` | `2201~2300-蓝刚-匠心茶叙` | 与 `-` 等价（只影响章节区间，不影响名字切分） |
 * | **单章**（没有区间） | `2221-刘真雄-日岳星河` | 区间退化成 `from == to` |
 * | **只写 CV** | `2201-2300-珊瑚水月`、`2001-2300 云湛泊舟` | `speakerKind='cvOnly'`：覆盖「该 CV 在这一段里的全部行」 |
 *
 * ⚠️ 曾经只认第一种，于是真机目录里 **24 个文件只扫出 6 个**（其余被判
 * `no-chapter-range` / `missing-name`），而且**被静默丢掉** —— 用户只看到一个变小的数字。
 * 现在四种都认；仍然认不出的会带着 `parseError` 返回给界面列出来（见 `AudioImportCandidate`）。
 *
 * 真实样本与在画本里的出现情况（用 `【CV-角色】` 标记交叉验证）：
 *
 * | 文件名 | 名字1 | 名字2(CV) | 画本证据 |
 * |--------|-------|-----------|---------|
 * | `2127-2300-石玉凤-德钦` | 角色 石玉凤 | CV 德钦 | `【…-石玉凤】`×9，`【德钦-…】`×9 |
 * | `2221-2240-石志坚-月光` | 角色 石志坚 | CV 月光 | `【…-石志坚】`×274；画本里 CV 全名是 `月光_深白色` |
 * | `2221-2250-多角色-春哥拿大顶` | 标记 多角色 | CV 春哥拿大顶 | `【春哥拿大顶-…】`（配 8 个角色） |
 * | `2226-2300-多角色-兔小舟` | 标记 多角色 | CV 兔小舟 | `【兔小舟-…】`×11 |
 * | `2251-2255-旁白-语心草` | 标记 旁白 | CV 语心草 | `【语心草-方艺华】` |
 *
 * ## 三条从样本里学到的关键事实
 *
 * 1. **名字2 是 CV，不是角色。** 一开始容易猜反（`石志坚` 看起来像角色、
 *    `德钦` 看起来像演员，但也可能反过来）。用 `【CV-角色】` 标记统计后确定：
 *    对 `石玉凤-德钦`，`石玉凤` 出现在标记右半边（角色位）9 次，
 *    `德钦` 出现在标记左半边（CV 位）9 次。**这个顺序是固定的。**
 *
 * 2. **CV 名可能是缩写。** 文件名写 `月光`，画本里写 `月光_深白色`。
 *    所以匹配**不能要求全等** —— 本模块只负责解析出 token，
 *    真正的解析（含前缀/归一化匹配）在 `resolve.ts` 里做，并必须允许人工修正。
 *
 * 3. **`多角色` / `旁白` 是保留标记，不是名字。** 它们表示「这个文件里该 CV
 *    配了多个角色」或「这个文件是旁白」，此时**第二个名字才是 CV**。
 *    注意此时**不能**把文件绑定到单一角色 —— 归属要靠每一行的 `character_id`
 *    与 `speaker_type` 决定（见 `plan.ts`）。
 *
 * ## 为什么把解析单独放一层
 *   它是零依赖纯函数：能在主进程、渲染进程（预览）、测试里用**同一份**逻辑。
 *   若把它写在 service 里，渲染进程做「选文件后立刻预览」时就得再实现一遍，
 *   两份实现必然漂移。
 *
 * 本目录禁止引入任何第三方依赖。
 */

/** 章节区间的来源：文件名里那一段 `2127-2300` */
export interface ChapterRange {
  /** 起始章（含） */
  from: number
  /** 结束章（含）。单个章节号时等于 from */
  to: number
  /** 原始文本，便于回显与日志 */
  raw: string
}

/**
 * 说话人标记：文件名第一个名字的语义。
 *
 * - `character` —— 第一个名字命中了角色（如 `石志坚`）
 * - `multiRole` —— 保留标记「多角色」：该 CV 在这段里配了多个角色
 * - `narration` —— 保留标记「旁白」：这段是旁白
 * - `unknown`   —— 既不是已知标记、也还没来得及查角色表
 *                  （是不是角色由 `resolve.ts` 查库后决定，纯解析层不下结论）
 */
export type SpeakerTokenKind = 'character' | 'multiRole' | 'narration' | 'cvOnly' | 'unknown'

export interface ParsedAudioFileName {
  /** 原文件名（含扩展名） */
  fileName: string
  /** 去掉扩展名的主体 */
  stem: string
  /** 扩展名（小写、不含点）；无扩展名时为空串 */
  ext: string
  /** 章节区间 */
  range: ChapterRange
  /** 第一个名字的语义（保留标记已识别；是否角色待查表） */
  speakerKind: SpeakerTokenKind
  /**
   * 第一个名字的原始文本（保留标记时也是原文，如「多角色」）。
   *
   * `null` = 文件名**只给了一个名字**（`cvOnly`，如 `2201-2300-珊瑚水月`）：
   * 那一个名字是 **CV**，覆盖的是「该 CV 在这一段里的全部行」。
   */
  characterToken: string | null
  /** 第二个名字 = CV（配音演员）的原始文本 */
  cvToken: string
}

/** 解析失败的原因（不抛错：导入要能如实报告「哪些文件没看懂」，而不是整体失败） */
export type ParseFailureReason =
  | 'empty-name'
  | 'no-chapter-range'
  | 'missing-name'
  | 'too-many-parts'
  | 'chapter-range-invalid'

export type ParseAudioFileNameResult =
  | { ok: true; value: ParsedAudioFileName }
  | { ok: false; fileName: string; reason: ParseFailureReason; detail: string }

/** 保留标记：第一个名字是这些时，它不指向某个具体角色 */
export const SPEAKER_MARKERS = {
  /** 该 CV 在这段范围里配了多个角色 */
  multiRole: '多角色',
  /** 这段是旁白 */
  narration: '旁白',
} as const

/** 允许的音频扩展名（与 docs/12 §2 的导入支持范围一致） */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'] as const

/**
 * 解析 `{起始章}-{结束章}-{名字1}-{名字2}.{扩展名}`。
 *
 * ### 名字怎么切分（被测试纠正过一次，务必看清）
 *   规则是「**第一个**分隔符之前 = 角色 token，之后全部 = CV」：
 *
 *   ```
 *   2221-2240-石志坚-月光-深白色.mp3
 *             └─┬─┘ └────┬────┘
 *             角色       CV（可含分隔符）
 *   ```
 *
 *   ⚠️ 曾经写成「用**最后**一个分隔符切」，理由是「CV 名可能含 `-`」。
 *   但那样 `石志坚-月光-深白色` 会切成 角色=`石志坚-月光`、CV=`深白色` —— **反了**，
 *   而且角色 token 含分隔符会让后面的角色表匹配全部落空。
 *   正确语义是：**角色 token 永远是最前面那一段**，其余归 CV。
 *
 * ### 前两段用「贪心」定位数字
 *   不假定数字位数，`\d{1,6}` 覆盖 1~999999 章；两段之间允许全角连字符与空格。
 *
 * ### 为什么解析失败不抛错
 *   导入是一次面对**整个文件夹**的操作，混进一个 `readme.txt`、
 *   一个 `新建文本.txt` 都很正常。抛错会导致「一个坏文件毁掉整批导入」。
 *   所以这里返回带原因的结果对象，由上层汇总成「无法解析」列表给用户修正。
 */
export function parseAudioFileName(fileName: string): ParseAudioFileNameResult {
  const base = String(fileName ?? '')
  const trimmed = base.trim()

  if (trimmed.length === 0) {
    return { ok: false, fileName: base, reason: 'empty-name', detail: '文件名为空' }
  }

  // 只取最后一段路径（调用方可能传全路径）
  const leaf = trimmed.split(/[\\/]/).pop() ?? trimmed

  // 扩展名
  const dot = leaf.lastIndexOf('.')
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf
  const ext = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : ''

  if (stem.length === 0) {
    return { ok: false, fileName: base, reason: 'empty-name', detail: '去掉扩展名后为空' }
  }

  // ── 章节头：区间或单章 ───────────────────────────────────────────────────
  //
  // 真机样本（`…/音频` 24 个文件）里出现的四种写法都必须认：
  //   `2127-2300-石玉凤-德钦`       区间，`-` 分隔
  //   `2201~2300-蓝刚-匠心茶叙`     区间，**`~` 分隔**（样本里有 4 个）
  //   `2221-刘真雄-日岳星河`        **单章**（只有一个章号，没有区间）
  //   `2001-2300 云湛泊舟`          区间后**用空格**接名字
  //
  // 以前只认「数字-数字-」这一种，于是 24 个文件里 18 个被判 no-chapter-range ——
  // 表现就是「扫描只扫出 6 个文件」（真机反馈）。
  const separators = '[-－—~～〜]'
  const m = new RegExp(`^\\s*(\\d{1,6})(?:\\s*${separators}\\s*(\\d{1,6}))?\\s*(.*)$`).exec(stem)
  if (!m || m[3] === undefined || m[3].trim() === '') {
    return {
      ok: false,
      fileName: leaf,
      reason: 'no-chapter-range',
      detail: '开头不是章节号（例：2127-2300-石玉凤-德钦 / 2221-刘真雄-日岳星河 / 2201~2300-蓝刚-匠心茶叙）',
    }
  }

  const from = Number(m[1])
  // 单章写法：第二个数字缺省 → 区间就是这一章
  const to = m[2] === undefined ? from : Number(m[2])
  // 名字前允许 `-`/`~`/空格/下划线（`2001-2300 云湛泊舟` 就是空格）
  const rest = m[3].replace(/^[\s\-－—~～〜_]+/, '').trim()

  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < 1) {
    return {
      ok: false,
      fileName: leaf,
      reason: 'chapter-range-invalid',
      detail: `章节号必须是正整数，实际为 ${m[1]}${m[2] === undefined ? '' : `-${m[2]}`}`,
    }
  }
  if (to < from) {
    return {
      ok: false,
      fileName: leaf,
      reason: 'chapter-range-invalid',
      detail: `结束章（${to}）小于起始章（${from}）`,
    }
  }

  // ── 名字1 / 名字2 ─────────────────────────────────────────────────────────
  // 用**第一个**分隔符切：角色 token 在前，CV 在后。
  //
  // 为什么是「第一个」而不是「最后一个」（这一条被测试纠正过）：
  //   一开始想的是「CV 名可能含分隔符（如 `月光-深白色`），所以用最后一个切」。
  //   但那样 `石志坚-月光-深白色` 会被切成 角色=`石志坚-月光`、CV=`深白色` —— **反了**。
  //   正确的语义是：
  //     · 角色 token 是名字里的**第一段**（永远不含分隔符）
  //     · 其余全部属于 CV（CV 全名可能含 `-`、`_`、`.`）
  //   所以用第一个分隔符切，`石志坚` / `月光-深白色` 才是对的。
  const sepIdx = rest.search(/[-－—]/)

  /**
   * **只给了一个名字**：那个名字是 CV，不是角色。
   *
   * 真机样本里这类最多（24 个文件里有 11 个）：`2201-2300-珊瑚水月`、
   * `2231-2240-鱼头一颗糖`、`2001-2300 云湛泊舟` —— 意思是
   * 「这个 CV 在这一段里的所有行」；角色由画本反查（`resolve.ts` 的 cvOnly 分支）。
   *
   * 唯一的例外：那一个名字是保留标记（`多角色` / `旁白`）—— 标记本身不是人，
   * 缺 CV 就无法导入，明确报错而不是猜。
   */
  if (sepIdx < 0) {
    const single = rest.trim()
    const kind = classifySpeakerToken(single)
    if (single.length === 0 || kind === 'multiRole' || kind === 'narration') {
      return {
        ok: false,
        fileName: leaf,
        reason: 'missing-name',
        detail: `章节区间之后只有一个名字「${single}」，而它既不是角色也不是 CV（保留标记必须再给一个 CV）`,
      }
    }
    return {
      ok: true,
      value: {
        fileName: leaf,
        stem,
        ext,
        range: { from, to, raw: `${from}-${to}` },
        speakerKind: 'cvOnly',
        characterToken: null,
        cvToken: single,
      },
    }
  }

  const characterToken = rest.slice(0, sepIdx).trim()
  const cvToken = rest.slice(sepIdx + 1).trim()

  if (characterToken.length === 0 || cvToken.length === 0) {
    return {
      ok: false,
      fileName: leaf,
      reason: 'missing-name',
      detail: `角色或 CV 为空（角色「${characterToken}」/ CV「${cvToken}」）`,
    }
  }

  return {
    ok: true,
    value: {
      fileName: leaf,
      stem,
      ext,
      range: { from, to, raw: `${from}-${to}` },
      speakerKind: classifySpeakerToken(characterToken),
      characterToken,
      cvToken,
    },
  }
}

/**
 * 判断第一个名字是保留标记还是（可能的）角色名。
 *
 * 注意：返回 `unknown` **不代表「不是角色」** —— 它表示「需要查角色表才能确定」。
 * 纯解析层不该也不可能知道项目里有哪些角色。`resolve.ts` 负责把
 * `unknown` 进一步判定成 `character` 或维持未知（→ 交人工修正）。
 */
export function classifySpeakerToken(token: string): SpeakerTokenKind {
  const t = normalizeToken(token)
  if (t === normalizeToken(SPEAKER_MARKERS.multiRole)) return 'multiRole'
  if (t === normalizeToken(SPEAKER_MARKERS.narration)) return 'narration'
  return 'unknown'
}

/**
 * 名字归一化：用于**比较**，不改变展示用的原文。
 *
 * 处理：去首尾空白、全角空格、大小写折叠、去掉不可见的零宽字符。
 * 样本里 CV 名带下划线（`月光_深白色`），**保留**下划线 ——
 * 它是名字的一部分，前缀匹配由 `resolve.ts` 单独处理。
 */
export function normalizeToken(token: string): string {
  return String(token ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // 零宽字符
    .replace(/[\u3000\s]+/g, ' ') // 全角空格与连续空白归一
    .trim()
    .toLowerCase()
}

/** 判断扩展名是否是支持的音频格式（无扩展名时返回 false） */
export function isAudioExtension(ext: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(String(ext ?? '').toLowerCase())
}

/**
 * 章节区间是否覆盖某章。
 *
 * 单独抽出来是因为**区间语义要被多处复用**（匹配行、统计、UI 高亮），
 * 写错一次就会出现「音频和行对不上」这种极难查的问题。
 */
export function rangeCovers(range: ChapterRange, chapterNo: number): boolean {
  return chapterNo >= range.from && chapterNo <= range.to
}

/** 区间的章节数（含两端）；非法区间返回 0 */
export function rangeLength(range: ChapterRange): number {
  if (range.to < range.from) return 0
  return range.to - range.from + 1
}
