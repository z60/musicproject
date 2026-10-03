/**
 * 测试 · 画本文本解析（docx-canvas）
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md、docs/91 §5.2.1
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/canvas-docx.test.ts
 *
 * ### 为什么用合成的 fixture 而不是读真实 .docx
 *   真实解析链是「mammoth 抽文本 → parseCanvasText 解析文本」。
 *   本测试针对**后半段**（纯逻辑），所以把 mammoth 抽出来的文本形态直接写在
 *   fixture 里 —— 这样测试不依赖外部样本文件、能被 CI 完整复现。
 *   真实 .docx 的端到端验证另有一处（见 docs/91）。
 *
 * ### fixture 必须复现的三个真实特征（都是踩过的坑）
 *   1. **表格每个单元格之间夹着空行**（mammoth 的行为）。
 *      少了它，「角色表解析」会看起来一切正常，上线才炸。
 *   2. **角色描述长度不一** → 条目行距不固定（8/10/12 混杂）。
 *   3. **角色表重复出现**（真实画本每章开头都有一张小角色表）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  extractChapterNoFromTitle,
  listCharacters,
  listCvs,
  linesByCharacter,
  linesByCv,
  narrationLines,
  normalizeName,
  parseCanvasText,
  parseChapterTitle,
  splitSpeakerMarker,
  stripQuotes,
} from '../../src/shared/canvas/docx-canvas.ts'

/**
 * 造一个「像 mammoth 抽出来的」角色表文本。
 *
 * ### 必须严格复现 mammoth 的两条行为（否则 fixture 自己就是错的）
 *   1. **一格一行**，行与行之间没有额外空行。
 *      早期版本「每格后都补一个空行」，导致后面各列整体下移 1 行、
 *      列全部错位 —— 那是 fixture 的错，不是解析器的错（白排查了一轮）。
 *   2. **每一行都要推满 5 格**，空值也要推空串占位。
 *      少了这一格，后续列的相对偏移就全错了。
 *
 *   于是「描述为空」的效果是**连续两个空行**（空值格 + 分隔空行），
 *   这也正是真实文档里条目跨度会在 10/12 之间变化的原因。
 */
function rosterBlock(
  rows: Array<{ seq: number; cv: string; character: string; desc?: string; count?: number; voice?: string }>,
): string {
  const out: string[] = []
  /** 推一格，并补一个空行作为格间分隔 */
  const cell = (s: string) => {
    out.push(s)
    out.push('')
  }

  for (const h of ['序号', 'CV', '角色名', '角色描述', '台词数', '音色']) cell(h)
  for (const r of rows) {
    cell(String(r.seq))
    cell(r.cv)
    cell(r.character)
    cell(r.desc ?? '') // ← 必须推满，空值也要占位
    cell(r.count === undefined ? '' : String(r.count))
    cell(r.voice ?? '')
  }
  return out.join('\n')
}

describe('章节标题解析', () => {
  it('三种真实写法都能识别', () => {
    const cases: Array<[string, number]> = [
      ['第2201章', 2201],
      ['第1章 第二本书', 1],
      ['第5章 元神化身（一）', 5],
      ['第 2201 章', 2201],
    ]
    for (const [text, no] of cases) {
      const r = parseChapterTitle(text)
      assert.ok(r, `「${text}」应被识别为章节标题`)
      assert.equal(r!.chapterNo, no)
      assert.equal(r!.title, text.trim())
    }
  })

  it('非章节标题返回 null', () => {
    for (const t of ['序章', '第一章', '第2201', '2201章', '他说第2201章很好看', '']) {
      assert.equal(parseChapterTitle(t), null, `「${t}」不该被当成章节标题`)
    }
  })
})

/**
 * `extractChapterNoFromTitle` —— 从数据库里的 `chapters.title` 取章节号。
 *
 * ### 为什么它必须宽松，而 `parseChapterTitle` 必须严格
 *   两个函数的用途完全不同，判据也就必须不同：
 *
 *   | 函数 | 输入来源 | 判据 | 为什么 |
 *   |------|---------|------|--------|
 *   | `parseChapterTitle` | **正文流**（一堆句子） | 严格（不得含句末标点/「的」/超长） | 否则「第1章的第0句旁白。」会被当成章节标题，整本书旁白全丢 |
 *   | `extractChapterNoFromTitle` | **已确定是标题**的 `chapters.title` | 宽松（能找到「第N章」就取 N） | 标题可能带副标题、括号、空格等；严格判据会误杀 |
 *
 *   而它存在的**根本原因**是：`chapters.seq` 是**序号**（1…N），
 *   章节号只存在于标题里。误用 `seq` 会让「按说话人导入」在真实书上
 *   一个章节都对不上（真实样本：章节号 2201~2300，seq 1~100）。
 */
describe('从标题取章节号（数据对齐用）', () => {
  it('取得到常见形态的章节号', () => {
    const cases: Array<[string, number]> = [
      ['第2201章', 2201],
      ['第1章 第二本书', 1],
      ['第5章 元神化身（一）', 5],
      ['第 2201 章', 2201],
      ['第2201章 复仇（上）', 2201],
      // 严格判据会因为这些含「的」/句末标点而拒绝，但这里**必须**取到号 ——
      // 数据库里的 title 已经确定是标题，不该按正文流的判据卡它
      ['第99章的番外', 99],
      ['第一百章', null as unknown as number],
    ]
    for (const [title, expected] of cases) {
      const got = extractChapterNoFromTitle(title)
      if (expected === null) {
        assert.equal(got, null, `「${title}」取不到号时应返回 null`)
      } else {
        assert.equal(got, expected, `「${title}」应取到 ${expected}，实际 ${got}`)
      }
    }
  })

  it('取不到号时返回 null（由调用方决定兜底）', () => {
    for (const t of ['序章', '前言', '', '   ', '第一章', 'Chapter 1', '没有编号的标题']) {
      assert.equal(extractChapterNoFromTitle(t), null, `「${t}」不该取出任何号`)
    }
  })

  it('章节号为 0 或超大时返回 null（不是合法章节号）', () => {
    assert.equal(extractChapterNoFromTitle('第0章'), null)
    assert.equal(extractChapterNoFromTitle('第9999999章'), null)
  })

  it('不抛错（脏数据压一遍）', () => {
    for (const t of [null, undefined, 0, {}, []]) {
      assert.doesNotThrow(() => extractChapterNoFromTitle(t as unknown as string))
    }
  })
})

describe('说话人标记解析', () => {  it('CV 与角色都能含下划线/数字/空格', () => {
    const cases: Array<[string, string, string]> = [
      ['月光_深白色-石志坚', '月光_深白色', '石志坚'],
      ['阿翼爱热闹-男龙套3', '阿翼爱热闹', '男龙套3'],
      ['鱼头一颗糖-男龙套 3', '鱼头一颗糖', '男龙套 3'],
    ]
    for (const [inner, cv, ch] of cases) {
      const r = splitSpeakerMarker(inner)
      assert.ok(r, `「${inner}」应能拆分`)
      assert.equal(r!.cv, cv)
      assert.equal(r!.character, ch)
    }
  })

  it('没有分隔符或有一侧为空时返回 null（群白走这条路）', () => {
    for (const inner of ['异口同声', '-石志坚', '石志坚-', '', '']) {
      assert.equal(splitSpeakerMarker(inner), null, `「${inner}」不该被拆成 CV-角色`)
    }
  })

  it('全角连字符也支持', () => {
    const r = splitSpeakerMarker('月光_深白色－石志坚')
    assert.ok(r)
    assert.equal(r!.cv, '月光_深白色')
    assert.equal(r!.character, '石志坚')
  })
})

describe('引用与去引号', () => {
  it('去掉最外层一对引号（中英文/书名号都支持）', () => {
    assert.equal(stripQuotes('“你好”'), '你好')
    assert.equal(stripQuotes('"你好"'), '你好')
    assert.equal(stripQuotes('「你好」'), '你好')
    assert.equal(stripQuotes('『你好』'), '你好')
  })

  it('只去最外层，内部引号保留', () => {
    assert.equal(stripQuotes('“他说“你好”就走了”'), '他说“你好”就走了')
  })

  it('没有引号时原样返回', () => {
    assert.equal(stripQuotes('你好'), '你好')
    assert.equal(stripQuotes(''), '')
  })
})

describe('画本整体解析', () => {
  const CANVAS = [
    '书名：示例小说',
    '',
    rosterBlock([
      { seq: 1, cv: '阿翼爱热闹', character: '男龙套3', count: 69 },
      { seq: 2, cv: '月光_深白色', character: '石志坚', desc: '男主', count: 7 },
      { seq: 3, cv: '语心草', character: '方艺华', desc: '一个很长的角色描述会占两行吗', count: 16 },
    ]),
    '第1章 开局',
    '这是一句旁白。',
    '【阿翼爱热闹-男龙套3】“我是龙套！”',
    '【月光_深白色-石志坚】“我是主角。”石志坚说道，【月光_深白色-石志坚】“第二段台词！”',
    '又一句旁白。',
    '【异口同声】“大家一起说！”',
    '第2章 继续',
    '第二章的旁白。',
    '【语心草-方艺华】“方艺华的台词。”',
  ].join('\n')

  it('角色表解析出全部条目（含单元格间的空行）', () => {
    const canvas = parseCanvasText(CANVAS)
    assert.equal(canvas.roster.length, 3, `实际 ${JSON.stringify(canvas.roster)}`)
    assert.deepEqual(
      canvas.roster.map((r) => [r.cv, r.character]),
      [
        ['阿翼爱热闹', '男龙套3'],
        ['月光_深白色', '石志坚'],
        ['语心草', '方艺华'],
      ],
    )
    assert.equal(canvas.roster[1]!.description, '男主')
    assert.equal(canvas.roster[0]!.lineCount, 69)
  })

  it('章节被正确切分（两个章节号）', () => {
    const canvas = parseCanvasText(CANVAS)
    assert.deepEqual(canvas.chapters, [1, 2])
  })

  it('对白 / 旁白 / 群白三者被正确区分', () => {
    const canvas = parseCanvasText(CANVAS)
    const dialogue = canvas.lines.filter((l) => l.kind === 'dialogue')
    const narration = canvas.lines.filter((l) => l.kind === 'narration')
    const group = canvas.lines.filter((l) => l.kind === 'group')

    // 对白 3 行：龙套1 + 石志坚（一行两段）+ 方艺华1
    assert.equal(dialogue.length, 3, '对白行数')
    // 群白 1 行：【异口同声】没有 CV-角色，单独一类，不算旁白也不算对白
    assert.equal(group.length, 1, '群白行数')
    // 旁白 4 行：第1章 2 句 + 第2章 1 句 = 3；
    // 加上「书名：示例小说」在首个章节标题之前 → 被忽略并告警，不计入
    assert.equal(narration.length, 3, '旁白行数')
    // 三者之和 = 去掉角色表后的全部非空正文行
    assert.equal(dialogue.length + narration.length + group.length, 7)
  })

  /**
   * 真实样本里有一行出现**两次**同一个标记、中间夹叙述：
   * `【A-B】“x”…叙述…【A-B】“y”`
   * 必须按「段」拆开，而不是只取第一个标记（会丢半句）或把整行算一个说话人。
   */
  it('一行多个标记按「段」拆开，且文本与偏移都对得上', () => {
    const canvas = parseCanvasText(CANVAS)
    const line = canvas.lines.find((l) => l.segments.length === 2)
    assert.ok(line, '应当存在一行含两个说话段的台词')

    assert.equal(line!.segments.length, 2)
    assert.equal(line!.segments[0]!.owner?.character, '石志坚')
    assert.equal(line!.segments[1]!.owner?.character, '石志坚')

    // owners 去重：同一说话人只出现一次
    assert.equal(line!.owners.length, 1, '同一说话人的重复标记应去重')

    // 段落文本不能带标记
    assert.equal(line!.segments[0]!.text.includes('【'), false)
    assert.equal(line!.segments[1]!.text.includes('【'), false)

    // 偏移必须能切回原文
    for (const seg of line!.segments) {
      const sliced = line!.rawText.slice(seg.textStart, seg.textEnd)
      assert.ok(sliced.length > 0, '偏移区间不该为空')
      assert.equal(sliced.includes('【'), false, '偏移区间不该包含标记本身')
    }
  })

  it('群白（【异口同声】）的 owner 为 null，且 kind 为 group', () => {
    const canvas = parseCanvasText(CANVAS)
    const group = canvas.lines.find((l) => l.kind === 'group')
    assert.ok(group)
    assert.equal(group!.owners.length, 0)
    assert.equal(group!.segments.length, 1)
    assert.equal(group!.segments[0]!.owner, null)
    assert.equal(group!.segments[0]!.markerRaw, '【异口同声】')
  })

  it('章节标题之前的正文被忽略并给出一次警告', () => {
    const canvas = parseCanvasText(CANVAS)
    const before = canvas.warnings.filter((w) => w.reason === 'line-before-first-chapter')
    assert.equal(before.length, 1, '只警告一次，避免刷屏')
    assert.match(before[0]!.sample, /书名/)
  })

  it('没有警告噪音（群白不再被当成畸形标记）', () => {
    const canvas = parseCanvasText(CANVAS)
    const malformed = canvas.warnings.filter((w) => w.reason === 'malformed-speaker-marker')
    assert.equal(malformed.length, 0, '【异口同声】是合法群白，不该告警')
  })
})

describe('角色表重复出现（真实画本每章都有小表）', () => {
  it('多张角色表被合并，同一 CV 的多个角色全部保留', () => {
    const text = [
      rosterBlock([
        { seq: 1, cv: '兔小舟', character: '女龙套2', count: 3 },
        { seq: 2, cv: '兔小舟', character: '倪舒', count: 2 },
      ]),
      '第1章 甲',
      '【兔小舟-女龙套2】“甲”',
      rosterBlock([
        { seq: 1, cv: '兔小舟', character: '木瓜', count: 1 },
        { seq: 2, cv: '语心草', character: '方艺华', count: 5 },
      ]),
      '第2章 乙',
      '【兔小舟-木瓜】“乙”',
      '【语心草-方艺华】“丙”',
    ].join('\n')

    const canvas = parseCanvasText(text)
    assert.equal(canvas.roster.length, 4, `实际 ${JSON.stringify(canvas.roster.map((r) => r.character))}`)
    assert.deepEqual(canvas.chapters, [1, 2])
    // 正文两条都在
    assert.equal(canvas.lines.filter((l) => l.kind === 'dialogue').length, 3)
  })

  /**
   * ⚠️ 错列防护：这是**合成 fixture 才暴露出来**的一类缺陷。
   *
   * 若 `音色` 列恰好也含连续数字（真实的画本不会，但脏数据 / 别的导出工具会），
   * 那么「找下一个递增数字」就可能落在**错误的列**上：
   *
   * ```
   * 正确的列 (seqAt=0)        指错的列 (seqAt=8)
   * L12 | 1  ← 当前             L12 | 1  ← 当前
   * L22 | 2  ← 递增 ✓           L18 | 1  ← 同值 → 必须判定为错列并跳过
   * ```
   *
   * 没有这条防护时，整张表只读出 1 条（CV 格读到空就停了）。
   * 真机上表现为「角色表条目数莫名其妙地少」，极难定位。
   */
  it('错列防护：后续列里恰好也有连续数字时，仍能读完整张表', () => {
    const text = [
      rosterBlock([
        { seq: 1, cv: 'A', character: 'B', count: 1, voice: '1' },
        { seq: 2, cv: 'C', character: 'D', count: 2, voice: '2' },
        { seq: 3, cv: 'E', character: 'F', count: 3, voice: '3' },
      ]),
      '第1章 甲',
      '旁白。',
    ].join('\n')

    const canvas = parseCanvasText(text)
    assert.equal(
      canvas.roster.length,
      3,
      `音色列含连续数字时仍应读出 3 条，实际 ${canvas.roster.length}：${JSON.stringify(canvas.roster.map((r) => r.character))}`,
    )
    assert.deepEqual(
      canvas.roster.map((r) => r.character),
      ['B', 'D', 'F'],
    )
  })

  it('完全重复的条目被去重', () => {
    const one = rosterBlock([{ seq: 1, cv: 'A', character: 'B', count: 1 }])
    const canvas = parseCanvasText([one, '第1章', '正文', one].join('\n'))
    assert.equal(canvas.roster.length, 1, '相同 CV+角色 的条目只留一条')
  })

  /**
   * ⚠️ 这是最危险的一类 bug：角色表把正文吃掉。
   * 真实踩过两次（一次吃成 750 条角色表 / 0 行正文，一次只吃剩 36 章）。
   * 判据：正文行数必须完整、章节必须一个不少。
   */
  it('角色表不能把正文吃掉（章节数与正文行数完整）', () => {
    const body: string[] = []
    for (let ch = 1; ch <= 12; ch++) {
      body.push(`第${ch}章 标题${ch}`)
      for (let i = 0; i < 8; i++) body.push(`第${ch}章的第${i}句旁白。`)
      body.push(`【月光_深白色-石志坚】“第${ch}章的台词。”`)
      // 章末再放一张小角色表（真实画本就是这样）。
      // ⚠️ 必须 `push(...split('\n'))` 把它的**每一行**展开进数组；
      // 直接 push 整个多行字符串会把它当成一个数组元素，join 之后
      // 下一章的标题就被拼到角色表最后一行上了（排查时白绕了一圈）。
      body.push(...rosterBlock([{ seq: 1, cv: '月光_深白色', character: '石志坚', count: 1 }]).split('\n'))
    }
    const text = [rosterBlock([{ seq: 1, cv: '月光_深白色', character: '石志坚', count: 12 }]), ...body].join('\n')

    const canvas = parseCanvasText(text)
    assert.equal(canvas.chapters.length, 12, `章节应当完整，实际 ${canvas.chapters.join(',')}`)
    assert.equal(canvas.chapters[0], 1)
    assert.equal(canvas.chapters[11], 12)
    const dialogue = canvas.lines.filter((l) => l.kind === 'dialogue')
    assert.equal(dialogue.length, 12, `对白行数应当完整，实际 ${dialogue.length}`)
    const narration = canvas.lines.filter((l) => l.kind === 'narration')
    assert.equal(narration.length, 96, `旁白行数应当完整（12 章 × 8 句），实际 ${narration.length}`)
  })
})

describe('查询辅助', () => {
  const CANVAS = [
    rosterBlock([
      { seq: 1, cv: '月光_深白色', character: '石志坚', count: 3 },
      { seq: 2, cv: '兔小舟', character: '女龙套2', count: 1 },
      { seq: 3, cv: '兔小舟', character: '木瓜', count: 1 },
      { seq: 4, cv: '语心草', character: '方艺华', count: 1 },
    ]),
    '第1章 甲',
    '旁白一。',
    '【月光_深白色-石志坚】“石1”',
    '【兔小舟-女龙套2】“女1”',
    '第2章 乙',
    '旁白二。',
    '【月光_深白色-石志坚】“石2”',
    '【兔小舟-木瓜】“木1”',
    '【语心草-方艺华】“方1”',
  ].join('\n')

  it('linesByCharacter 按角色取行，且受区间限制', () => {
    const canvas = parseCanvasText(CANVAS)
    assert.equal(linesByCharacter(canvas, '石志坚').length, 2)
    assert.equal(linesByCharacter(canvas, '石志坚', { from: 1, to: 1 }).length, 1)
    assert.equal(linesByCharacter(canvas, '石志坚', { from: 2, to: 2 }).length, 1)
    assert.equal(linesByCharacter(canvas, '不存在').length, 0)
  })

  it('linesByCv 按 CV 取行（多角色 CV 会跨角色）', () => {
    const canvas = parseCanvasText(CANVAS)
    assert.equal(linesByCv(canvas, '兔小舟').length, 2, '兔小舟配了两个角色')
    assert.equal(linesByCv(canvas, '月光_深白色').length, 2)
    assert.equal(linesByCv(canvas, '语心草').length, 1)
  })

  it('narrationLines 只取旁白（不含群白）', () => {
    const canvas = parseCanvasText(CANVAS)
    assert.equal(narrationLines(canvas, { from: 1, to: 2 }).length, 2)
  })

  it('区间写成超大值时被 maxChapters 截断（防止把整个文档算进来）', () => {
    const canvas = parseCanvasText(CANVAS)
    // 区间 1-999999 但真文档只有 2 章，截断后仍应正确
    assert.equal(linesByCharacter(canvas, '石志坚', { from: 1, to: 999999 }, 2000).length, 2)
  })

  it('listCvs / listCharacters 去重且稳定', () => {
    const canvas = parseCanvasText(CANVAS)
    assert.deepEqual(listCvs(canvas).sort(), ['兔小舟', '月光_深白色', '语心草'].sort())
    assert.deepEqual(listCharacters(canvas).sort(), ['女龙套2', '木瓜', '方艺华', '石志坚'].sort())
  })

  it('normalizeName 去空白与大小写，保留名字内部结构', () => {
    assert.equal(normalizeName(' 月光_深白色 '), '月光_深白色')
    assert.equal(normalizeName('ABC'), 'abc')
    assert.equal(normalizeName('男龙套 3'), '男龙套3')
  })
})
