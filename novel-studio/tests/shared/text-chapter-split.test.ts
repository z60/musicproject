/**
 * Novel Studio · 分章测试
 * ============================================================================
 * 设计文档：docs/10-功能域-书籍导入.md §6（分章）与 §7.1（章节号规范化 / 人工干预）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/text-chapter-split.test.ts
 *
 * 覆盖点（对应 docs/10 §11 测试要点的「分章 / 误切防护」）：
 *   · 「第X章」「楔子/番外」「卷」三种标题
 *   · 误切防护：正文里的「他翻开第三章」不得被切；超过 maxLineLength 的行不得被切
 *   · 数字编号规范化：「一二三」「123」「零一二」
 *   · 无匹配 → 备选策略（按空行 / 按长度 / 整本一章）
 *   · 灾难性回溯正则被拒绝（RULE_PATTERN_UNSAFE）
 *   · 两候选间距过近被合并
 *   · 首章（前言）与末章处理、章节号倒退告警
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import type { ChapterRuleSet } from '../../src/shared/types.ts'
import { BUILTIN_RULE_SETS } from '../../src/shared/constants.ts'
import { AppError } from '../../src/shared/errors.ts'
import {
  assertLinePatternSafe,
  chooseFallbackStrategy,
  estimateDurationMs,
  inspectSplitSuspicion,
  isSplitSuspicious,
  mergeDrafts,
  normalizePatternFlags,
  parseChapterIndex,
  parseChineseNumber,
  sortDraftsByTitleIndex,
  splitAsSingleChapter,
  splitByBlankBlocks,
  splitByLength,
  splitChapters,
  splitChaptersDetailed,
  splitDraftAt,
  validateLinePattern,
} from '../../src/shared/text/chapter-split.ts'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const CN_STANDARD: ChapterRuleSet = BUILTIN_RULE_SETS.find((s) => s.id === 'builtin:cn-standard')!
const CN_LOOSE: ChapterRuleSet = BUILTIN_RULE_SETS.find((s) => s.id === 'builtin:cn-loose')!

/** 造一段正文（默认 220 字，超过末章合并阈值 200） */
function body(chars = 220, seed = '他站在山巅，望着远方的云海。'): string {
  let out = ''
  while (out.length < chars) out += seed
  return out.slice(0, chars)
}

/** 断言草稿的偏移与原文严格对应 */
function assertOffsets(text: string, drafts: ReturnType<typeof splitChapters>): void {
  for (const d of drafts) {
    assert.equal(text.slice(d.startOffset, d.endOffset), d.rawText, `第 ${d.index} 章偏移与原文不符`)
    assert.equal(d.charCount, d.rawText.length)
  }
  for (let i = 0; i + 1 < drafts.length; i++) {
    assert.ok(drafts[i]!.endOffset <= drafts[i + 1]!.startOffset, '章节区间不得重叠')
  }
}

// ---------------------------------------------------------------------------
// 基本切章
// ---------------------------------------------------------------------------

describe('基本切章（docs/10 §6.2 §6.3）', () => {
  const text = [
    `第一章 陨落的天才`,
    body(220),
    '',
    `第二章 风起`,
    body(220, '风声穿过山谷，卷起满地落叶。'),
    '',
    `第三章 归途`,
    body(220, '他背起行囊，踏上归途。'),
  ].join('\n')

  it('三章被正确切出，标题与结构正确', () => {
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 3)
    assert.deepEqual(
      drafts.map((d) => d.title),
      ['第一章 陨落的天才', '第二章 风起', '第三章 归途'],
    )
    assert.deepEqual(drafts.map((d) => d.kind), ['chapter', 'chapter', 'chapter'])
    assert.deepEqual(drafts.map((d) => d.index), [1, 2, 3])
    assert.deepEqual(drafts.map((d) => d.included), [true, true, true])
    assertOffsets(text, drafts)
    // 章区间首尾相接，全文不丢字
    assert.equal(drafts[0]!.startOffset, 0)
    assert.equal(drafts[drafts.length - 1]!.endOffset, text.length)
    const total = drafts.reduce((s, d) => s + d.charCount, 0)
    assert.equal(total, text.length)
  })

  it('预估时长按 VAD_DEFAULTS.charsPerSecond = 4.2 估算', () => {
    const drafts = splitChapters(text, CN_STANDARD)
    for (const d of drafts) {
      assert.equal(d.estimatedDurationMs, Math.round((d.charCount / 4.2) * 1000))
    }
    assert.equal(estimateDurationMs(42), 10000)
    assert.equal(estimateDurationMs(42, 2), 21000)
  })

  it('英文章节标题（constants 里写的 `(?i)` 内联标志）也能匹配', () => {
    const en = [`Chapter 1 The Beginning`, body(220), '', `Chapter 2 Rising`, body(220, 'The wind rose again.')].join(
      '\n',
    )
    // 契约里 en-chapter 写的是 (?i)chapter\s+[\dIVXLC]+\.?.*，JS 引擎不支持内联标志，需转换
    assert.deepEqual(normalizePatternFlags('(?i)chapter\\s+[\\dIVXLC]+\\.?.*'), {
      source: 'chapter\\s+[\\dIVXLC]+\\.?.*',
      flags: 'i',
    })
    const drafts = splitChapters(en, CN_STANDARD)
    assert.equal(drafts.length, 2)
    assert.deepEqual(
      drafts.map((d) => d.title),
      ['Chapter 1 The Beginning', 'Chapter 2 Rising'],
    )
  })

  it('括号型标题（【第X章 …】）可切', () => {
    const t = [`【第一章 开始】`, body(220), '', `【第二章 继续】`, body(220, '日子一天天过去。')].join('\n')
    const drafts = splitChapters(t, CN_STANDARD)
    assert.equal(drafts.length, 2)
    assert.equal(drafts[0]!.title, '【第一章 开始】')
  })
})

// ---------------------------------------------------------------------------
// 楔子 / 番外 / 卷
// ---------------------------------------------------------------------------

describe('楔子 / 番外 / 卷（docs/10 §6.2）', () => {
  it('楔子与番外被识别为 extra 类型', () => {
    const text = [
      '楔子 一滴血',
      body(220, '很久以前，这片土地上落下一滴血。'),
      '',
      '第一章 开始',
      body(220),
      '',
      '番外一 后日谈',
      body(220, '多年以后，他们又回到了那座山。'),
    ].join('\n')
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 3)
    assert.deepEqual(
      drafts.map((d) => d.title),
      ['楔子 一滴血', '第一章 开始', '番外一 后日谈'],
    )
    assert.deepEqual(drafts.map((d) => d.kind), ['extra', 'chapter', 'extra'])
    assertOffsets(text, drafts)
  })

  it('卷标题默认只作层级标记：不切章，但写入 volumeIndex 与 volumes', () => {
    const text = [
      '第二卷 风起云涌',
      '',
      '第一章 开始',
      body(220),
      '',
      '第二章 继续',
      body(220, '风越来越大。'),
    ].join('\n')
    const result = splitChaptersDetailed(text, CN_STANDARD)
    assert.equal(result.drafts.length, 2, '卷不产章')
    assert.equal(result.volumes.length, 1)
    assert.equal(result.volumes[0]!.index, 1)
    assert.equal(result.volumes[0]!.title, '第二卷 风起云涌')
    assert.deepEqual(result.drafts.map((d) => d.volumeIndex), [1, 1])
    // 卷标题留在正文里，不丢字
    assert.equal(result.drafts[0]!.startOffset, 0)
    assert.ok(result.drafts[0]!.rawText.startsWith('第二卷 风起云涌'))
    assertOffsets(text, result.drafts)
  })

  it('卷标题前后没有空行时不切（requireBlankAround 生效）', () => {
    const text = ['第二卷 风起云涌', '正文紧接着上来。', '第一章 开始', body(220)].join('\n')
    const result = splitChaptersDetailed(text, CN_STANDARD)
    assert.equal(result.volumes.length, 0, '没有空行包围时不应识别为卷标题')
  })

  it('emitVolumes=true 时卷标题单独成章', () => {
    const text = ['第二卷 风起云涌', '', '第一章 开始', body(220)].join('\n')
    const result = splitChaptersDetailed(text, CN_STANDARD, { emitVolumes: true, tailMinChars: 100 })
    assert.equal(result.drafts.length, 2)
    assert.equal(result.drafts[0]!.kind, 'volume')
    assert.equal(result.drafts[0]!.volumeIndex, 1)
  })

  it('规则集 allowNumericOnly 时纯数字标题可切（且必须前后空行）', () => {
    const text = ['12', '', body(220), '', '13', '', body(220, '时间过得很快。')].join('\n')
    const drafts = splitChapters(text, CN_LOOSE)
    assert.equal(drafts.length, 2)
    assert.deepEqual(
      drafts.map((d) => d.title),
      ['12', '13'],
    )
    // cn-standard 不允许纯数字标题
    assert.equal(splitChapters(text, CN_STANDARD).length, 0)
  })
})

// ---------------------------------------------------------------------------
// 误切防护（docs/10 §6.3）
// ---------------------------------------------------------------------------

describe('误切防护（宁可漏切、不可错切）', () => {
  it('正文中的「他翻开第三章」不被切', () => {
    const text = [
      '第一章 开始',
      body(220),
      '他翻开第三章，发现里面写着一段很久以前的故事。',
      body(220, '于是他合上书，望向窗外。'),
    ].join('\n')
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 1, '正文里的引用不得被当成章节标题')
    assert.equal(drafts[0]!.title, '第一章 开始')
    assert.ok(drafts[0]!.rawText.includes('他翻开第三章'))
  })

  it('以「第三章」开头但超过 maxLineLength(40) 的行不被切', () => {
    const longLine = '第三章的内容在他看来不过是' + '无病呻吟的废话'.repeat(6)
    assert.ok(longLine.length > 40)
    const text = ['第一章 开始', body(220), longLine, body(220, '窗外的雨停了。')].join('\n')
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 1)
  })

  it('两个候选间距 < 50 字时后者视为误切并合并（不丢字）', () => {
    const text = [
      '第一章 开始',
      '短',
      '第二章 名字',
      body(300, '漫长的旅程就此展开。'),
      '',
      '第三章 结尾',
      body(300, '故事在这里画上句号。'),
    ].join('\n')
    const result = splitChaptersDetailed(text, CN_STANDARD)
    assert.equal(result.mergedCount, 1)
    assert.equal(result.drafts.length, 2)
    assert.deepEqual(
      result.drafts.map((d) => d.title),
      ['第一章 开始', '第三章 结尾'],
    )
    assert.ok(result.drafts[0]!.rawText.includes('第二章 名字'), '被合并的标题仍在正文里，不能丢字')
    assert.ok(result.warnings.some((w) => w.code === 'merged-candidate'))
    assertOffsets(text, result.drafts)
  })

  it('章节号倒退只告警不阻止（可能是上下部或倒叙）', () => {
    const text = [
      '第三章 前尘',
      body(220),
      '',
      '第二章 旧事',
      body(220, '往事如烟。'),
    ].join('\n')
    const result = splitChaptersDetailed(text, CN_STANDARD)
    assert.equal(result.drafts.length, 2)
    assert.ok(result.warnings.some((w) => w.code === 'index-regression'))
  })
})

// ---------------------------------------------------------------------------
// 首章 / 末章
// ---------------------------------------------------------------------------

describe('首章与末章处理（docs/10 §6.3）', () => {
  it('首个边界之前不足 200 字时丢弃（多为书名/作者）', () => {
    const text = ['《测试小说》', '作者：某人', '', '第一章 开始', body(300)].join('\n')
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.title, '第一章 开始')
    assert.equal(drafts[0]!.startOffset, text.indexOf('第一章'))
  })

  it('首个边界之前超过 200 字时保留为「前言」', () => {
    const preface = body(260, '这是一段很长的序言，作者在这里交代了世界观。')
    const text = [preface, '', '第一章 开始', body(300)].join('\n')
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 2)
    assert.equal(drafts[0]!.title, '前言')
    assert.equal(drafts[0]!.kind, 'front')
    assert.equal(drafts[0]!.startOffset, 0)
    // 前言区间是「首个章节边界之前的全部文本」（含其后的空行），trim 后即序言正文
    assert.equal(drafts[0]!.rawText, text.slice(0, drafts[0]!.endOffset))
    assert.equal(drafts[0]!.rawText.trim(), preface)
  })

  it('末章正文不足 200 字时并入上一章', () => {
    const text = ['第一章 长长的正文', body(400), '', '第二章 尾声', '短'].join('\n')
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 1)
    assert.ok(drafts[0]!.rawText.includes('第二章 尾声'), '合并后标题仍在正文里')
    assert.equal(drafts[drafts.length - 1]!.endOffset, text.length)
  })

  it('末章正文足够长时保留为独立一章', () => {
    const text = ['第一章 正文', body(400), '', '第二章 尾声', body(260, '一切都结束了。')].join('\n')
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 2)
  })
})

// ---------------------------------------------------------------------------
// 章节号规范化（docs/10 §7.1）
// ---------------------------------------------------------------------------

describe('章节号规范化（docs/10 §7.1）', () => {
  it('中文数字：一 / 十 / 二十三 / 一百零八 / 一万二千三百四十五', () => {
    assert.equal(parseChineseNumber('一'), 1)
    assert.equal(parseChineseNumber('十'), 10)
    assert.equal(parseChineseNumber('十二'), 12)
    assert.equal(parseChineseNumber('二十三'), 23)
    assert.equal(parseChineseNumber('一百零八'), 108)
    assert.equal(parseChineseNumber('一万二千三百四十五'), 12345)
    assert.equal(parseChineseNumber('两'), 2)
  })

  it('逐字位写法：「一二三」→123、「零一二」→12', () => {
    assert.equal(parseChineseNumber('一二三'), 123)
    assert.equal(parseChineseNumber('零一二'), 12)
    assert.equal(parseChineseNumber('〇一'), 1)
  })

  it('阿拉伯数字与非法输入', () => {
    assert.equal(parseChineseNumber('123'), 123)
    assert.equal(parseChineseNumber('012'), 12)
    assert.equal(parseChineseNumber('十二个'), null)
    assert.equal(parseChineseNumber(''), null)
  })

  it('从标题里解析章节号', () => {
    assert.equal(parseChapterIndex('第一章 陨落的天才'), 1)
    assert.equal(parseChapterIndex('第12章'), 12)
    assert.equal(parseChapterIndex('第十二章'), 12)
    assert.equal(parseChapterIndex('第一百零八章'), 108)
    assert.equal(parseChapterIndex('第五回 三英战吕布'), 5)
    assert.equal(parseChapterIndex('第二卷 风起'), 2)
    assert.equal(parseChapterIndex('番外三'), 3)
    assert.equal(parseChapterIndex('【第一章 开始】'), 1)
    assert.equal(parseChapterIndex('一二三'), 123)
    assert.equal(parseChapterIndex('零一二'), 12)
    assert.equal(parseChapterIndex('12 开始'), 12)
    assert.equal(parseChapterIndex('楔子'), null)
    assert.equal(parseChapterIndex('序章'), null)
    assert.equal(parseChapterIndex('大结局'), null)
  })
})

// ---------------------------------------------------------------------------
// 无匹配 → 备选策略（docs/10 §6.4）
// ---------------------------------------------------------------------------

describe('无匹配时的备选策略（docs/10 §6.4 / §10 NO_CHAPTER_MATCHED）', () => {
  /** 没有任何章节标记的连续文本 */
  const plain = Array.from({ length: 12 }, (_, i) => body(200, `第${i}段的内容就这样一直写下去，没有小标题。`)).join('')

  it('splitChapters 默认不猜：返回空数组，并给出 no-match 告警', () => {
    const result = splitChaptersDetailed(plain, CN_STANDARD)
    assert.equal(result.drafts.length, 0)
    assert.equal(result.strategy, 'none')
    assert.ok(result.warnings.some((w) => w.code === 'no-match'))
    assert.equal(result.candidateCount, 0)
  })

  it('按长度均分：每块不超限、标题自动生成、偏移连续', () => {
    const drafts = splitByLength(plain, { charsPerChunk: 300 })
    assert.ok(drafts.length > 1)
    assert.equal(drafts[0]!.title, '第1部分')
    assert.equal(drafts[1]!.title, '第2部分')
    assert.equal(drafts[0]!.startOffset, 0)
    assert.equal(drafts[drafts.length - 1]!.endOffset, plain.length)
    for (const d of drafts) assert.ok(d.charCount <= 400, `块过大：${d.charCount}`)
    assertOffsets(plain, drafts)
  })

  it('按空行块：连续 2+ 空行处切分，过短的块并入前一块', () => {
    const text = [
      body(300, '第一块的内容。'),
      '',
      '',
      body(300, '第二块的内容。'),
      '',
      '',
      body(300, '第三块的内容。'),
    ].join('\n')
    const drafts = splitByBlankBlocks(text, { minBlockChars: 100 })
    assert.equal(drafts.length, 3)
    assertOffsets(text, drafts)
    // 标题取块首行（≤30 字时）
    assert.ok(drafts[0]!.title.length > 0)

    const shortTail = [body(300), '', '', '短'].join('\n')
    const merged = splitByBlankBlocks(shortTail, { minBlockChars: 100 })
    assert.equal(merged.length, 1, '过短的块应并入前一块')
  })

  it('整本一章', () => {
    const drafts = splitAsSingleChapter(plain)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.charCount, plain.length)
    assert.equal(splitAsSingleChapter('').length, 0)
  })

  it('自动挑选策略：稳定空行结构走 blank-blocks，否则走 length', () => {
    const structured = [body(300), '', '', body(300), '', '', body(300)].join('\n')
    assert.equal(chooseFallbackStrategy(structured), 'blank-blocks')
    assert.equal(chooseFallbackStrategy(plain), 'length')
  })

  it('fallback 选项可直接在 splitChapters 里生效', () => {
    const drafts = splitChapters(plain, CN_STANDARD, { fallback: 'length', fallbackOptions: { charsPerChunk: 400 } })
    assert.ok(drafts.length > 1)
    const result = splitChaptersDetailed(plain, CN_STANDARD, { fallback: 'single' })
    assert.equal(result.strategy, 'single')
    assert.equal(result.drafts.length, 1)
  })

  it('分章结果可疑判定（docs/10 §10 CHAPTER_SPLIT_SUSPICIOUS）', () => {
    const huge = splitAsSingleChapter(body(50_000))
    const s = inspectSplitSuspicion(huge)
    assert.equal(s.suspicious, true)
    assert.match(s.reasons.join('；'), /仅切出 1 章/)
    assert.equal(isSplitSuspicious(splitByLength(body(9000), { charsPerChunk: 3000 })), false)
  })
})

// ---------------------------------------------------------------------------
// 正则安全校验（docs/10 §6.5）
// ---------------------------------------------------------------------------

describe('正则安全校验（docs/10 §6.5）', () => {
  it('拒绝嵌套量词 (a+)+ / (.*)* / (a+){2,}', () => {
    for (const bad of ['(a+)+', '(.*)*', '(a+){2,}', '(第[一二三]+)+章']) {
      const v = validateLinePattern(bad)
      assert.equal(v.ok, false, `${bad} 应被拒绝`)
      assert.equal(v.code, 'RULE_PATTERN_UNSAFE', bad)
      assert.match(v.error ?? '', /嵌套量词|回溯/)
    }
  })

  it('拒绝被量词包裹的可空择一分支 (a|)* / (|a)+', () => {
    for (const bad of ['(a|)*', '(|a)+']) {
      const v = validateLinePattern(bad)
      assert.equal(v.ok, false, `${bad} 应被拒绝`)
      assert.equal(v.code, 'RULE_PATTERN_UNSAFE')
    }
  })

  it('拒绝过大的有界重复', () => {
    const v = validateLinePattern('a{1,100000}')
    assert.equal(v.ok, false)
    assert.equal(v.code, 'RULE_PATTERN_UNSAFE')
  })

  it('语法错误 / 空 / 超长 → RULE_PATTERN_INVALID', () => {
    assert.equal(validateLinePattern('(unclosed').code, 'RULE_PATTERN_INVALID')
    assert.equal(validateLinePattern('').code, 'RULE_PATTERN_INVALID')
    assert.equal(validateLinePattern('   ').code, 'RULE_PATTERN_INVALID')
    assert.equal(validateLinePattern('a'.repeat(2001)).code, 'RULE_PATTERN_INVALID')
  })

  it('内置规则与常见自定义规则全部通过校验', () => {
    for (const set of BUILTIN_RULE_SETS) {
      for (const p of set.patterns) {
        const v = validateLinePattern(p.linePattern)
        assert.equal(v.ok, true, `内置规则 ${set.id}/${p.id} 未通过校验：${v.error}`)
      }
    }
    assert.equal(validateLinePattern('第[一二三四五六七八九十0-9]+章.*').ok, true)
    assert.equal(validateLinePattern('^\\s*第\\d{1,4}章\\s*$').ok, true)
  })

  it('assertLinePatternSafe 抛 AppError（语义键正确）', () => {
    assert.throws(
      () => assertLinePatternSafe('(a+)+'),
      (e: unknown) => e instanceof AppError && e.key === 'RULE_PATTERN_UNSAFE',
    )
    assert.throws(
      () => assertLinePatternSafe('(unclosed'),
      (e: unknown) => e instanceof AppError && e.key === 'RULE_PATTERN_INVALID',
    )
    assert.doesNotThrow(() => assertLinePatternSafe('第[0-9]+章.*'))
  })

  it('规则集里混入不安全正则时：拒绝该条，其余规则照常工作', () => {
    const dirty: ChapterRuleSet = {
      id: 'custom:test',
      name: '含危险规则',
      builtin: false,
      allowNumericOnly: false,
      patterns: [
        { id: 'evil', linePattern: '(第[0-9]+章)+', maxLineLength: 40, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
        { id: 'good', linePattern: '卷[0-9]+.*', maxLineLength: 30, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
      ],
    }
    const text = ['卷1 起', body(220), '', '卷2 承', body(220, '事情继续发展。')].join('\n')
    const result = splitChaptersDetailed(text, dirty)
    assert.equal(result.drafts.length, 2)
    assert.ok(result.warnings.some((w) => w.code === 'pattern-unsafe' && w.ruleId === 'evil'))
    assert.deepEqual(result.matchedRuleIds, ['good'])
  })

  it('titleGroup 可以只取捕获组作为标题', () => {
    const ruleSet: ChapterRuleSet = {
      id: 'custom:group',
      name: '取捕获组',
      builtin: false,
      allowNumericOnly: false,
      patterns: [
        { id: 'grp', linePattern: '^==\\s*(.+?)\\s*==$', maxLineLength: 40, requireBlankAround: false, titleGroup: 1, kind: 'chapter' },
      ],
    }
    const text = ['== 第一章 起 ==', body(220), '', '== 第二章 承 ==', body(220, '继续。')].join('\n')
    const drafts = splitChapters(text, ruleSet)
    assert.equal(drafts.length, 2)
    assert.deepEqual(
      drafts.map((d) => d.title),
      ['第一章 起', '第二章 承'],
    )
  })
})

// ---------------------------------------------------------------------------
// 人工干预辅助（docs/10 §7.1 Step 5）
// ---------------------------------------------------------------------------

describe('人工干预：合并 / 拆分 / 排序', () => {
  const text = [
    '第一章 A',
    body(300),
    '',
    '第二章 B',
    body(300, '继续前进。'),
    '',
    '第三章 C',
    body(300, '终点在望。'),
  ].join('\n')

  it('合并相邻章节：区间取并集，不丢字', () => {
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(drafts.length, 3)
    const merged = mergeDrafts(drafts, [1, 2], '第一、二章 合并')
    assert.ok(merged)
    assert.equal(merged!.length, 2)
    assert.equal(merged![0]!.title, '第一、二章 合并')
    assert.equal(merged![0]!.rawText, drafts[0]!.rawText + drafts[1]!.rawText)
    assert.deepEqual(merged!.map((d) => d.index), [1, 2])
    assert.equal(merged![1]!.rawText, drafts[2]!.rawText)
  })

  it('合并非连续或不存在的章节返回 null', () => {
    const drafts = splitChapters(text, CN_STANDARD)
    assert.equal(mergeDrafts(drafts, [1, 3]), null)
    assert.equal(mergeDrafts(drafts, [99]), null)
  })

  it('拆分章节：偏移与标题正确，越界拆分点被忽略', () => {
    const drafts = splitChapters(text, CN_STANDARD)
    const target = drafts[0]!
    const parts = splitDraftAt(target, [100, -5, 99999])
    assert.ok(parts)
    assert.equal(parts!.length, 2)
    assert.equal(parts![0]!.title, target.title)
    assert.equal(parts![1]!.title, `${target.title}（2）`)
    assert.equal(parts![0]!.rawText.length, 100)
    assert.equal(parts![0]!.startOffset, target.startOffset)
    assert.equal(parts![1]!.endOffset, target.endOffset)
    assert.equal(splitDraftAt(target, []), null)
    assert.equal(splitDraftAt(target, [0, target.rawText.length]), null)
  })

  it('按标题数字排序：解析不出数字的排在后面且保持相对顺序', () => {
    const drafts = splitChapters(text, CN_STANDARD)
    const shuffled = [drafts[2]!, drafts[0]!, drafts[1]!]
    const sorted = sortDraftsByTitleIndex(shuffled)
    assert.deepEqual(
      sorted.map((d) => d.title),
      ['第一章 A', '第二章 B', '第三章 C'],
    )
    assert.deepEqual(sorted.map((d) => d.index), [1, 2, 3])
  })
})
