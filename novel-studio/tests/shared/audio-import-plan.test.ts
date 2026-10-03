/**
 * 测试 · 按说话人导入音频：说话人解析与导入规划
 * ============================================================================
 * 设计依据：docs/12-功能域-录音.md、docs/91 §5.2.1
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/audio-import-plan.test.ts
 *
 * ### 数据从哪来
 *   画本用**合成 fixture**（不依赖外部 .docx，CI 可完整复现），
 *   但**名字映射关系与章节分布照真实样本设计**（docs/91 §5.2.1 有原始统计）：
 *
 *   | 文件名 CV token | 画本里的 CV | 关系 | 期望解析结果 |
 *   |----------------|------------|------|-------------|
 *   | `德钦`          | `德钦`      | 相等 | exact / 置信度 1 |
 *   | `月光`          | `月光_深白色` | 前缀 | prefix / 0.9（**需人工确认**） |
 *   | `兔小舟`        | `兔小舟`    | 相等 | exact |
 *   | `语心草`        | `语心草`    | 相等 | exact（旁白） |
 *   | `春哥拿大顶`     | `春哥拿大顶` | 相等 | exact / 8 个角色（**多角色**） |
 *   | `春哥那个哥`     | —           | 对不上 | **unresolved**（用户笔误，保留为负例） |
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  buildCvIndex,
  buildImportPlan,
  decideTarget,
  matchSpeaker,
  parseAudioFileName,
} from '../../src/shared/audio-import/index.ts'
import { parseCanvasText } from '../../src/shared/canvas/index.ts'

// ---------------------------------------------------------------------------
// 画本 fixture
// ---------------------------------------------------------------------------

const CANVAS_FROM = 2127
const CANVAS_TO = 2300

/**
 * 角色 → 有台词的章节。
 *
 * 章节号与分布是**照真实音频文件的区间反推**的：真实文件名写的是
 * `2127-2300`、`2221-2240`、`2226-2300`、`2251-2255`，所以画本必须覆盖
 * **2127~2300**。若 fixture 只放两三章，那些文件必然落到「区间不在画本里」，
 * 真正的匹配逻辑就测不到（第一版就踩了这个：一堆用例期望 ready 却拿到 no-lines）。
 *
 * 分布尽量**贴近真实**：真实的 `春哥拿大顶` 在画本里配了 **8 个角色**
 * （邵毅天/罗文/戴灵芝/老院长/陈志超/管家/沈璧/雷洛），这里都建出来，
 * 好让「多角色」路径测到真正的多角色。
 */
const CHARACTER_CHAPTERS: Record<string, number[]> = {
  石玉凤: [2127, 2130, 2200, 2225, 2226, 2300],
  石志坚: [2221, 2222, 2223, 2230, 2235, 2240],
  女龙套2: [2226, 2227],
  木瓜: [2228, 2229],
  方艺华: [2251, 2252, 2253, 2254, 2255],
  // 春哥拿大顶 名下的 8 个角色（与真实画本一致）
  邵毅天: [2221],
  罗文: [2221, 2222, 2223, 2224],
  戴灵芝: [2222],
  老院长: [2225],
  陈志超: [2226],
  管家: [2230],
  沈璧: [2235],
  雷洛: [2240],
}

/** 角色 → CV（与角色表一致） */
const CHARACTER_CV: Record<string, string> = {
  石玉凤: '德钦',
  石志坚: '月光_深白色',
  女龙套2: '兔小舟',
  木瓜: '兔小舟',
  方艺华: '语心草',
  邵毅天: '春哥拿大顶',
  罗文: '春哥拿大顶',
  戴灵芝: '春哥拿大顶',
  老院长: '春哥拿大顶',
  陈志超: '春哥拿大顶',
  管家: '春哥拿大顶',
  沈璧: '春哥拿大顶',
  雷洛: '春哥拿大顶',
}

/** 参与 fixture 的角色（顺序即角色表顺序） */
const FIXTURE_CHARACTERS = Object.keys(CHARACTER_CHAPTERS)

/**
 * 生成一个「角色表」文本块（表头 + 若干条目），形态与 mammoth 抽出的一致：
 * **一格一行 + 格间空行**。
 *
 * ⚠️ 章末那张小角色表也必须用这个函数生成**完整的 6 列结构**。
 *    第一版手写了 2 个 cell（`序号` 后面直接跟 `CV`？不，连表头都没写全），
 *    解析器认不出表头，于是那几格（`德钦` / `石玉凤` / `1`）全被当成旁白 ——
 *    每章凭空多出 4 句旁白，自检立刻红。
 *    这也说明**fixture 必须与真实文档结构一致**，否则测的是假的。
 */
function rosterBlock(rows: Array<[string, string, string, string]>): string[] {
  const out: string[] = []
  const cell = (s: string) => {
    out.push(s)
    out.push('')
  }
  for (const h of ['序号', 'CV', '角色名', '角色描述', '台词数', '音色']) cell(h)
  rows.forEach(([cv, character, desc, count], i) => {
    cell(String(i + 1))
    cell(cv)
    cell(character)
    cell(desc)
    cell(count)
    cell('')
  })
  return out
}

function buildCanvasText(): string {
  const out: string[] = []

  // ── 主角色表 ──────────────────────────────────────────────────────────────
  // 角色表由 FIXTURE_CHARACTERS 派生（保证与 CHARACTER_CHAPTERS 不会漂移）
  const rows: Array<[string, string, string, string]> = FIXTURE_CHARACTERS.map((character) => [
    CHARACTER_CV[character]!,
    character,
    '',
    String(CHARACTER_CHAPTERS[character]!.length),
  ])
  out.push(...rosterBlock(rows))

  // 章号 → 该章有哪些角色
  const byChapter = new Map<number, string[]>()
  for (const [character, chapters] of Object.entries(CHARACTER_CHAPTERS)) {
    for (const ch of chapters) {
      const list = byChapter.get(ch)
      if (list) list.push(character)
      else byChapter.set(ch, [character])
    }
  }

  // ── 正文 ──────────────────────────────────────────────────────────────────
  for (let ch = CANVAS_FROM; ch <= CANVAS_TO; ch++) {
    out.push(`第${ch}章`)
    // 群白：验证「群白既不算旁白、也不算对白」
    out.push(`【异口同声】“第${ch}章众人齐声。”`)
    // 旁白：每章 1 句
    out.push(`这是第${ch}章的旁白。`)
    for (const character of byChapter.get(ch) ?? []) {
      out.push(`【${CHARACTER_CV[character]}-${character}】“第${ch}章 ${character} 的台词。”`)
    }
    // 章末小角色表（真实画本每章都有；也是解析器最容易吃掉正文的地方）
    out.push(...rosterBlock([['德钦', '石玉凤', '', '1']]))
  }

  return out.join('\n')
}

const CANVAS = parseCanvasText(buildCanvasText())

/** 把文件名做成规划输入 */
function makeInputs(names: readonly string[]) {
  return names.map((n) => {
    const r = parseAudioFileName(n)
    return {
      filePath: `C:/samples/${n}`,
      fileName: n,
      sizeBytes: 1_000_000,
      parsed: r.ok ? r.value : null,
      parseError: r.ok ? null : { reason: r.reason, detail: r.detail },
    }
  })
}

// ---------------------------------------------------------------------------
// fixture 自检（先证明 fixture 本身是对的，否则后面的断言都不可信）
// ---------------------------------------------------------------------------

describe('fixture 自检', () => {
  it('画本解析出全部章节与角色表', () => {
    assert.equal(CANVAS.chapters.length, CANVAS_TO - CANVAS_FROM + 1)
    assert.equal(CANVAS.chapters[0], CANVAS_FROM)
    assert.equal(CANVAS.chapters[CANVAS.chapters.length - 1], CANVAS_TO)
    assert.equal(
      CANVAS.roster.length,
      FIXTURE_CHARACTERS.length,
      `角色表应当 ${FIXTURE_CHARACTERS.length} 条，实际 ${CANVAS.roster.length}`,
    )
  })

  it('旁白每章恰好 1 句，且群白没有被算成旁白', () => {
    const narration = CANVAS.lines.filter((l) => l.kind === 'narration')
    const group = CANVAS.lines.filter((l) => l.kind === 'group')
    assert.equal(narration.length, CANVAS_TO - CANVAS_FROM + 1)
    assert.equal(group.length, CANVAS_TO - CANVAS_FROM + 1, '每章 1 句群白')
  })

  it('每个角色的台词数与 CHARACTER_CHAPTERS 一致', () => {
    for (const [character, chapters] of Object.entries(CHARACTER_CHAPTERS)) {
      const hit = CANVAS.lines.filter(
        (l) => l.kind === 'dialogue' && l.owners.some((o) => o.character === character),
      )
      assert.equal(hit.length, chapters.length, `${character} 的台词数`)
    }
  })
})

// ---------------------------------------------------------------------------
// CV 索引
// ---------------------------------------------------------------------------

describe('CV 索引建立', () => {
  it('从角色表建立 CV → 角色列表（同一 CV 的多角色全部保留）', () => {
    const index = buildCvIndex(CANVAS.roster)
    const tu = index.byNormalized.get('兔小舟')
    assert.ok(tu, '兔小舟 应在索引里')
    assert.deepEqual(tu!.characters.sort(), ['女龙套2', '木瓜'].sort())
  })

  it('CV 为空的行不建索引（避免用空键互相覆盖）', () => {
    const index = buildCvIndex([
      { cv: '', character: '甲', description: null, lineCount: null, sourceLine: 0 },
      { cv: '  ', character: '乙', description: null, lineCount: null, sourceLine: 1 },
      { cv: '丙', character: '丁', description: null, lineCount: null, sourceLine: 2 },
    ])
    assert.equal(index.all.length, 1)
    assert.equal(index.all[0]!.name, '丙')
  })
})

// ---------------------------------------------------------------------------
// 说话人匹配
// ---------------------------------------------------------------------------

describe('说话人匹配（真实映射关系）', () => {
  const index = buildCvIndex(CANVAS.roster)

  it('完全相等 → exact / 置信度 1', () => {
    for (const cv of ['德钦', '兔小舟', '语心草', '春哥拿大顶']) {
      const r = matchSpeaker(cv, index)
      assert.equal(r.method, 'exact', cv)
      assert.equal(r.confidence, 1, cv)
      assert.equal(r.matched?.name, cv)
      assert.equal(r.reason, null, 'exact 不该有警告')
    }
  })

  /**
   * 真实样本最关键的一条：文件名写 `月光`，画本里是 `月光_深白色`。
   * 必须能补全，**但置信度不能给满分** —— 缩写可能撞名，要人工确认。
   */
  it('缩写（文件名是画本 CV 的前缀）→ prefix / 置信度 0.9 / 带提醒', () => {
    const r = matchSpeaker('月光', index)
    assert.equal(r.method, 'prefix')
    assert.equal(r.confidence, 0.9)
    assert.equal(r.matched?.name, '月光_深白色', '必须补全成画本里的全名')
    assert.ok(r.reason, '前缀匹配必须给出提醒，让用户确认')
    assert.match(r.reason!, /月光_深白色/)
  })

  it('包含关系 → contains / 置信度 0.7（文件名把全名写全又多写了后缀）', () => {
    const r = matchSpeaker('月光_深白色-重录', index)
    assert.equal(r.method, 'contains')
    assert.equal(r.confidence, 0.7)
    assert.equal(r.matched?.name, '月光_深白色')
  })

  /**
   * 真机历史：用户一度把 CV 写成 `春哥那个哥`，而画本里是 `春哥拿大顶`。
   * 必须 unresolved —— **绝不能硬猜**：猜错会把音频绑到错误角色，
   * 且静默流到对轨与成品。
   */
  it('完全对不上 → unresolved，且明确不猜', () => {
    const r = matchSpeaker('春哥那个哥', index)
    assert.equal(r.method, 'unresolved')
    assert.equal(r.confidence, 0)
    assert.equal(r.matched, null)
    assert.ok(r.reason)
    assert.match(r.reason!, /找不到/)
  })

  it('单字 token 不参与前缀匹配（否则「李」会命中一堆人）', () => {
    const idx = buildCvIndex([
      { cv: '李四', character: 'A', description: null, lineCount: null, sourceLine: 0 },
      { cv: '李五', character: 'B', description: null, lineCount: null, sourceLine: 1 },
    ])
    assert.equal(matchSpeaker('李', idx).method, 'unresolved', '单字前缀风险太大，应拒绝而不是乱匹配')
  })

  it('前缀命中多个候选时 → unresolved 并列出候选（不猜）', () => {
    const idx = buildCvIndex([
      { cv: '月光_深白色', character: 'A', description: null, lineCount: null, sourceLine: 0 },
      { cv: '月光_浅白色', character: 'B', description: null, lineCount: null, sourceLine: 1 },
    ])
    const r = matchSpeaker('月光', idx)
    assert.equal(r.method, 'unresolved')
    assert.equal(r.alternatives.length, 2, '必须把候选交给用户挑')
  })

  it('空 CV token → unresolved（不抛错）', () => {
    const r = matchSpeaker('', index)
    assert.equal(r.method, 'unresolved')
    assert.ok(r.reason)
  })

  it('画本没有角色表时 → unresolved 且说明原因', () => {
    const r = matchSpeaker('任何人', buildCvIndex([]))
    assert.equal(r.method, 'unresolved')
    assert.match(r.reason!, /角色表/)
  })
})

// ---------------------------------------------------------------------------
// 目标判定
// ---------------------------------------------------------------------------

describe('目标判定（决定绑定到哪些行）', () => {
  const index = buildCvIndex(CANVAS.roster)

  it('角色 token 命中角色表 → 绑定该角色', () => {
    const t = decideTarget('unknown', '石玉凤', CANVAS.roster, matchSpeaker('德钦', index))
    assert.equal(t.kind, 'character')
    assert.equal(t.character, '石玉凤')
    assert.equal(t.cvName, '德钦')
  })

  it('旁白标记 → kind 为 narration（不看角色表）', () => {
    const t = decideTarget('narration', '旁白', CANVAS.roster, matchSpeaker('语心草', index))
    assert.equal(t.kind, 'narration')
    assert.equal(t.cvName, '语心草')
  })

  it('多角色且 CV 配了多个角色 → 不能绑单一角色', () => {
    const t = decideTarget('multiRole', '多角色', CANVAS.roster, matchSpeaker('兔小舟', index))
    assert.equal(t.kind, 'multiRole')
    assert.equal(t.character, null, '多角色不能绑单一角色')
    assert.equal(t.cvName, '兔小舟')
  })

  it('标了多角色但 CV 只配 1 个角色 → 收敛为该角色', () => {
    const idx = buildCvIndex([{ cv: '甲', character: '乙', description: null, lineCount: null, sourceLine: 0 }])
    const t = decideTarget('multiRole', '多角色', CANVAS.roster, matchSpeaker('甲', idx))
    assert.equal(t.kind, 'cv-single-role')
    assert.equal(t.character, '乙')
  })


  /**
   * `cvOnly`：文件名只给了一个名字（`2201-2300-珊瑚水月`）。
   *
   * 真机样本里这种最多（24 个文件有 11 个）。它是「这个 CV 在这一段里的所有行」，
   * 所以判定与「角色 token 没命中角色表」一致，但文案必须说清是「只给了 CV」——
   * 否则用户会去找一个根本不存在的角色名。
   */
  it('cvOnly 且 CV 配了多个角色 → multiRole（按该 CV 的行匹配）', () => {
    const t = decideTarget('cvOnly', null, CANVAS.roster, matchSpeaker('兔小舟', index))
    assert.equal(t.kind, 'multiRole')
    assert.equal(t.character, null)
    assert.equal(t.cvName, '兔小舟')
    assert.match(t.explanation, /只给了 CV/)
  })

  it('cvOnly 且 CV 只配 1 个角色 → 收敛为该角色', () => {
    const idx = buildCvIndex([{ cv: '甲', character: '乙', description: null, lineCount: null, sourceLine: 0 }])
    const t = decideTarget('cvOnly', null, CANVAS.roster, matchSpeaker('甲', idx))
    assert.equal(t.kind, 'cv-single-role')
    assert.equal(t.character, '乙')
    assert.match(t.explanation, /只给了 CV/)
  })

  it('cvOnly 但 CV 匹配不上 → unknown（可人工修正，不能消失）', () => {
    const t = decideTarget('cvOnly', null, CANVAS.roster, matchSpeaker('查无此人', index))
    assert.equal(t.kind, 'unknown')
    assert.match(t.explanation, /只给了 CV/)
  })

  /**
   * 未解析路径的负例。
   *
   * ⚠️ 这里**故意用一个画本里不存在的 CV 名**。曾经用的是 `春哥那个哥`，
   * 但那是用户命名时的笔误（已更正为 `春哥拿大顶`）—— 真实的 CV 名是能匹配上的，
   * 所以不能拿它当负例。负例必须是一个**真的对不上**的名字。
   *
   * 判据：标为多角色 + CV 一个角色都没匹配上 → 必须返回 `unknown` 走人工确认。
   * 曾经返回 `multiRole`，导致文件被归为「无行」而**从界面上消失**，
   * 用户只会觉得「导入漏了文件」。
   */
  it('标了多角色但 CV 完全匹配不上 → unknown（可人工修正，不能消失）', () => {
    const cv = matchSpeaker('查无此人', index)
    assert.equal(cv.method, 'unresolved')
    const t = decideTarget('multiRole', '多角色', CANVAS.roster, cv)
    assert.equal(t.kind, 'unknown', '必须能进入人工确认，而不是被当成「无行」')
    assert.equal(t.cvName, null)
  })

  /**
   * 真机笔误的历史用例（保留）：用户一度把 CV 写成 `春哥那个哥`，
   * 而画本里是 `春哥拿大顶`。当时解析器正确地报了 unresolved ——
   * 这条用例锁住「对不上就老实说对不上」这个行为，防止将来有人加激进模糊匹配。
   */
  it('历史笔误「春哥那个哥」仍应 unresolved（说明不做激进模糊匹配）', () => {
    const cv = matchSpeaker('春哥那个哥', index)
    assert.equal(cv.method, 'unresolved', '中文名的模糊匹配风险太大：宁可让人工确认')
    assert.equal(cv.matched, null)
  })

  it('更正后的真实 CV「春哥拿大顶」→ exact，且列出它名下的全部角色', () => {
    const cv = matchSpeaker('春哥拿大顶', index)
    assert.equal(cv.method, 'exact', '改名后必须能精确匹配')
    assert.equal(cv.confidence, 1)
    assert.equal(cv.matched?.characters.length, 8, '真实画本里这个 CV 配了 8 个角色')
    assert.deepEqual(
      cv.matched!.characters.slice().sort(),
      ['罗文', '邵毅天', '戴灵芝', '老院长', '陈志超', '管家', '沈璧', '雷洛'].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// 导入规划（端到端）
// ---------------------------------------------------------------------------

describe('导入规划（端到端）', () => {
  const REAL_NAMES = [
    '2221-2240-石志坚-月光.mp3',
    '2226-2300-多角色-兔小舟.mp3',
    '2251-2255-旁白-语心草.mp3',
  ] as const

  it('三个可解析的真实文件名都进入计划且状态合理', () => {
    const plan = buildImportPlan(makeInputs(REAL_NAMES), CANVAS)
    assert.equal(plan.files.length, 3)

    const shi = plan.files.find((f) => f.fileName.includes('石志坚'))!
    assert.equal(shi.status, 'needs-review', '月光 → 月光_深白色 是缩写，需确认')
    assert.equal(shi.target?.character, '石志坚')
    assert.equal(shi.lineCount, 6, '石志坚在 2221~2240 里有 6 句')

    const tu = plan.files.find((f) => f.fileName.includes('兔小舟'))!
    assert.equal(tu.status, 'ready')
    assert.equal(tu.target?.kind, 'multiRole')
    assert.equal(tu.lineCount, 4, '兔小舟多角色模式取该 CV 全部行（女龙套2 两句 + 木瓜 两句）')

    const narr = plan.files.find((f) => f.fileName.includes('旁白'))!
    assert.equal(narr.status, 'ready')
    assert.equal(narr.target?.kind, 'narration')
    assert.equal(narr.lineCount, 5, '2251~2255 共 5 章，每章 1 句旁白')
  })

  it('多角色模式会选中该 CV 名下所有角色的行', () => {
    const plan = buildImportPlan(makeInputs(['2226-2300-多角色-兔小舟.mp3']), CANVAS)
    const f = plan.files[0]!
    // 女龙套2 在 2226,2227；木瓜在 2228,2229
    const chapters = Object.keys(f.linesByChapter).map(Number).sort((a, b) => a - b)
    assert.deepEqual(chapters, [2226, 2227, 2228, 2229])
  })

  it('角色模式只选该角色的行（不会串到同 CV 的其它角色）', () => {
    // 兔小舟 配了 女龙套2 与 木瓜；按角色「木瓜」导入时只应有木瓜的 2 句
    const inputs = makeInputs(['2226-2300-多角色-兔小舟.mp3']).map((i) => ({
      ...i,
      overrideCharacter: '木瓜',
    }))
    const plan = buildImportPlan(inputs, CANVAS)
    assert.equal(plan.files[0]!.lineCount, 2)
    assert.deepEqual(Object.keys(plan.files[0]!.linesByChapter).map(Number).sort((a, b) => a - b), [2228, 2229])
  })

  /**
   * 人工「按 CV」修正必须以 CV 为准。
   *
   * 曾经的缺陷：选了 CV 仍落到 `decideTarget(parsed.speakerKind, parsed.characterToken, …)`，
   * 而它优先信**文件名里的角色** —— 于是「按 CV」选了别的 CV 也不生效，
   * 导入的还是原角色的行（真机反馈「选择 CV 出现错误」）。
   */
  it('人工按 CV 修正时以 CV 为准（文件名里的角色 token 不再覆盖它）', () => {
    const inputs = makeInputs(['2127-2300-石志坚-月光.mp3']).map((i) => ({ ...i, overrideCv: '德钦' }))
    const plan = buildImportPlan(inputs, CANVAS)
    const f = plan.files[0]!
    assert.equal(f.cvResolution?.matched?.name, '德钦')
    assert.equal(f.target?.kind, 'cv-single-role', '选了 CV 就该按 CV 收敛，而不是被文件名里的角色拦住')
    assert.equal(f.target?.character, '石玉凤', '德钦 在画本里配的是石玉凤')
  })

  /**
   * 区间越界必须提示，而不是默默按交集导入 ——
   * 后者会让用户以为「全导进去了」。真实样本 `2127-2300` vs 画本 `2201-2300`。
   */
  it('区间超出画本范围时给出提示并统计缺失章节数', () => {
    // 用一个小画本（只有 2201~2300）来复现真实样本的越界
    const small = parseCanvasText(
      buildCanvasText()
        .split('\n')
        .filter((l) => {
          const m = /^第(\d+)章$/.exec(l)
          return !m || (Number(m[1]) >= 2201 && Number(m[1]) <= 2300)
        })
        .join('\n'),
    )
    const plan = buildImportPlan(makeInputs(['2127-2300-石玉凤-德钦.mp3']), small)
    const f = plan.files[0]!
    assert.equal(f.range?.from, 2127)
    assert.equal(f.chaptersMissingInCanvas.length, 74, '2127~2200 共 74 章不在画本里')
    assert.ok(
      f.notes.some((n) => /不在画本范围/.test(n)),
      `应提示区间越界，实际 notes=${JSON.stringify(f.notes)}`,
    )
    // 区间内的 2201~2300 仍能匹配到石玉凤的行（2130/2200 不在，2225/2226/2300 在）
    assert.equal(f.lineCount, 3, '石玉凤在 2225/2226/2300 各 1 句')
  })

  it('文件名不合法 → invalid-name，且不抛错', () => {
    const plan = buildImportPlan(makeInputs(['readme.txt', '没有区间.mp3']), CANVAS)
    assert.equal(plan.files.length, 2)
    for (const f of plan.files) assert.equal(f.status, 'invalid-name')
    assert.equal(plan.summary.invalidFiles, 2)
    assert.ok(plan.warnings.some((w) => /命名不符合约定/.test(w)))
  })

  /**
   * 说话人对不上时必须仍然出现在计划里（needs-review），
   * 否则用户看不到这个文件、也无处修正 —— 一个真实存在的音频就这么消失了。
   *
   * 用**故意写错的 CV 名**构造这个场景（真实样本里的 CV 名都能匹配上）。
   */
  it('说话人无法判定 → needs-review（不能从界面消失）', () => {
    const plan = buildImportPlan(makeInputs(['2221-2250-多角色-查无此人.mp3']), CANVAS)
    const f = plan.files[0]!
    assert.equal(f.status, 'needs-review', `实际 ${f.status}`)
    assert.equal(f.target?.kind, 'unknown')
    assert.ok(
      f.notes.some((n) => /指定角色|指定 CV/.test(n)),
      '必须告诉用户该怎么办',
    )
  })

  /**
   * 更正后的真实文件名：`2221-2250-多角色-春哥拿大顶.mp3`。
   *
   * 这条是**用户更正命名之后的回归**：CV 名写对了就应该完全自动解析成功，
   * 而且因为是多角色，应当把该 CV 名下**全部角色**的行都收进来。
   */
  it('更正后的真实文件名 → ready，且收该 CV 名下全部角色的行', () => {
    const plan = buildImportPlan(makeInputs(['2221-2250-多角色-春哥拿大顶.mp3']), CANVAS)
    const f = plan.files[0]!
    assert.equal(f.status, 'ready', `CV 名写对就该自动就绪，实际 ${f.status}；notes=${JSON.stringify(f.notes)}`)
    assert.equal(f.cvResolution?.method, 'exact')
    assert.equal(f.target?.kind, 'multiRole')
    assert.equal(f.target?.cvName, '春哥拿大顶')
    // 该 CV 名下 8 个角色，在 2221~2250 区间内的台词：
    // 邵毅天 2221(1) + 罗文 2221~2224(4) + 戴灵芝 2222(1) + 老院长 2225(1)
    // + 陈志超 2226(1) + 管家 2230(1) + 沈璧 2235(1) + 雷洛 2240(1) = 11
    assert.equal(f.lineCount, 11, '多角色应把该 CV 名下所有角色的行都收进来')
    assert.equal(f.overlappingLineCount, 0)
  })

  it('人工修正：指定角色后状态变为 ready 并选到该角色的行', () => {
    // 春哥拿大顶 配的是「罗文」，在 2221~2224 各 1 句
    const inputs = makeInputs(['2221-2250-多角色-春哥拿大顶.mp3']).map((i) => ({
      ...i,
      overrideCharacter: '罗文',
    }))
    const plan = buildImportPlan(inputs, CANVAS)
    const f = plan.files[0]!
    assert.equal(f.status, 'ready', '人工指定后不该再要求确认')
    assert.equal(f.target?.character, '罗文')
    assert.equal(f.lineCount, 4)
    assert.ok(f.notes.some((n) => /人工指定/.test(n)))
  })

  it('人工修正：强制旁白', () => {
    const inputs = makeInputs(['2221-2250-多角色-春哥拿大顶.mp3']).map((i) => ({
      ...i,
      overrideNarration: true,
    }))
    const plan = buildImportPlan(inputs, CANVAS)
    assert.equal(plan.files[0]!.target?.kind, 'narration')
    assert.equal(plan.files[0]!.lineCount, 30, '2221~2250 共 30 章，每章 1 句旁白')
  })

  it('同一行被多个文件覆盖时给出重复提示', () => {
    // 用石志坚：他在 2221/2222/2223 有台词，两个区间都覆盖到，
    // 于是同一批行被两个文件命中（石玉凤在 2221~2230 没有行，用她会得到 0 行、测不到重叠）
    const inputs = makeInputs(['2221-2230-石志坚-月光.mp3', '2221-2230-石志坚-月光-重录.mp3'])
    const plan = buildImportPlan(inputs, CANVAS)
    assert.ok(
      plan.warnings.some((w) => /多个音频文件覆盖/.test(w)),
      `应提示重复覆盖，实际 warnings=${JSON.stringify(plan.warnings)}`,
    )
    // 两个文件互相重叠：两者都会收到「多 take」提示。
    // 状态上只有一个被标成 `duplicate-lines`（先出现的那个保持它原本的状态），
    // 因为状态表达的是「这个文件的主要问题」，而不是「它是否参与重叠」。
    for (const f of plan.files) {
      assert.ok(
        f.notes.some((n) => /多 take/.test(n)),
        `${f.fileName} 应提示与别的文件重叠；实际 notes=${JSON.stringify(f.notes)}`,
      )
    }
    assert.equal(plan.summary.overlappingFiles, 2, '两个文件都参与了重叠')
    assert.equal(plan.summary.duplicatedLineCount, 4, '石志坚在 2221/2222/2223/2230 各 1 句，4 行被两个文件争用')
  })

  it('汇总数字与文件状态一致', () => {
    const plan = buildImportPlan(makeInputs([...REAL_NAMES, 'readme.txt']), CANVAS)
    const s = plan.summary
    assert.equal(s.totalFiles, 4)
    assert.equal(
      s.readyFiles + s.needsReviewFiles + s.unresolvedFiles + s.noLinesFiles + s.invalidFiles,
      4,
      '每个文件恰好归入一个**状态**类别（overlappingFiles 是正交维度，不参与这个加总）',
    )
    assert.equal(s.availableCharacters.length, FIXTURE_CHARACTERS.length, '角色表里的角色数')
    assert.ok(s.totalBytes > 0)
    // 这三个文件区间互不重叠（2221-2240 / 2226-2300 / 2251-2255）
    // 后两个的区间确实重叠，但命中的**行**不同（兔小舟 vs 旁白），所以不算重复覆盖
    assert.equal(s.duplicatedLineCount, 0, '没有同一行被多个文件覆盖')
  })

  it('计划可被 JSON 序列化（渲染进程要通过 IPC 拿到它）', () => {
    const plan = buildImportPlan(makeInputs(REAL_NAMES), CANVAS)
    const round = JSON.parse(JSON.stringify(plan))
    assert.equal(round.files.length, plan.files.length)
    assert.equal(round.summary.totalLines, plan.summary.totalLines)
    assert.deepEqual(round.summary.canvasChapterRange, plan.summary.canvasChapterRange)
  })

  it('空文件列表 → 空计划，不抛错', () => {
    const plan = buildImportPlan([], CANVAS)
    assert.equal(plan.files.length, 0)
    assert.equal(plan.summary.totalFiles, 0)
    assert.equal(plan.summary.totalLines, 0)
  })
})
// ---------------------------------------------------------------------------
// 手工修正：文件名解析不出的文件也能「自己选区间 + 角色/CV」
// ---------------------------------------------------------------------------

/**
 * 真机需求：「以后解析不出的可以在处理里自己选择哪个 CV 或者角色」。
 *
 * 关键点：**光选人不够** —— 没有章节区间就不知道这个文件覆盖哪些章，
 * 也就选不出行。所以区间也必须能人工补（UI 默认填画本的章节范围）。
 */
describe('手工修正：解析不出的文件补区间 + 说话人', () => {
  /** 一个怎么都解析不出的名字（既没有章号，也没有「角色-CV」结构） */
  const BAD = '最终版-配音-勿删.mp3'
  const base = () => makeInputs([BAD])[0]!

  it('名字解析不出又没有人工区间 → 仍是 invalid-name，range 为 null', () => {
    const plan = buildImportPlan([base()], CANVAS)
    assert.equal(plan.files[0]!.status, 'invalid-name')
    assert.equal(plan.files[0]!.range, null)
  })

  it('人工补区间 + 指定角色 → 按该区间选行，状态 ready（并且保留「文件名不合法」的事实）', () => {
    const plan = buildImportPlan(
      [{ ...base(), fromChapter: 2221, toChapter: 2240, overrideCharacter: '石志坚' }],
      CANVAS,
    )
    const f = plan.files[0]!
    assert.deepEqual(f.range, { from: 2221, to: 2240 })
    assert.equal(f.status, 'ready')
    assert.equal(f.target?.character, '石志坚')
    assert.equal(f.lineCount, 6, '石志坚在 2221~2240 里有 6 句')
    assert.ok(f.parseError, '文件名不合法要如实保留（说明这些行是人工兜的）')
    assert.ok(
      f.notes.some((n) => n.includes('人工指定的章节区间')),
      `notes 里要写清「按人工区间处理」，实际：${JSON.stringify(f.notes)}`,
    )
  })

  it('人工补区间 + 指定 CV → 按该 CV 的行匹配', () => {
    const plan = buildImportPlan(
      [{ ...base(), fromChapter: 2221, toChapter: 2240, overrideCv: '德钦' }],
      CANVAS,
    )
    const f = plan.files[0]!
    assert.equal(f.status, 'ready')
    assert.equal(f.target?.character, '石玉凤', '德钦只配石玉凤 → 收敛到该角色')
  })

  it('只补区间、不指定说话人 → needs-review（还能继续指定）', () => {
    const plan = buildImportPlan([{ ...base(), fromChapter: 2251, toChapter: 2255 }], CANVAS)
    assert.equal(plan.files[0]!.status, 'needs-review')
  })

  it('区间不完整 / 颠倒 / 非正数 → 当作没给（宁可拒绝，也不静默选错范围）', () => {
    const patches = [
      { fromChapter: 2221 },
      { toChapter: 2240 },
      { fromChapter: 2240, toChapter: 2221 },
      { fromChapter: 0, toChapter: 10 },
      { fromChapter: 1.5, toChapter: 10 },
    ]
    for (const patch of patches) {
      const plan = buildImportPlan([{ ...base(), overrideCharacter: '石志坚', ...patch }], CANVAS)
      assert.equal(plan.files[0]!.status, 'invalid-name', JSON.stringify(patch))
      assert.equal(plan.files[0]!.range, null, JSON.stringify(patch))
    }
  })
})
