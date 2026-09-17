/**
 * Novel Studio · 切句测试
 * ============================================================================
 * 设计文档：docs/11-功能域-画本编辑.md §2.1（切句规则，Step 1）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/text-sentence.test.ts
 *
 * 覆盖点：
 *   · 句末标点切分，引号内不切分（保住台词完整）
 *   · 超长句在逗号处二次切分，且断点取「靠中间」的
 *   · 括号/书名号内部不断开；无可用断点时硬切（不超限）
 *   · 偏移量正确：input.slice(start, end) === text，且片段不重叠、不漏字
 *   · 段落边界（换行）强制断行
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  protectedPositionMap,
  splitSentenceTexts,
  splitSentences,
  type SentencePiece,
} from '../../src/shared/text/sentence.ts'

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

/** 片段必须严格对应原文偏移，且首尾无空白 */
function assertPieces(text: string, pieces: SentencePiece[]): void {
  let prevEnd = 0
  for (const p of pieces) {
    assert.equal(text.slice(p.start, p.end), p.text, `偏移不匹配：${JSON.stringify(p)}`)
    assert.equal(p.text, p.text.trim(), '片段首尾不得残留空白')
    assert.ok(p.end > p.start, '不得出现空片段')
    assert.ok(p.start >= prevEnd, '片段不得重叠且必须按顺序')
    prevEnd = p.end
  }
}

/** 原文里所有非空白字符都必须落在某个片段内（不许漏字） */
function assertNoLoss(text: string, pieces: SentencePiece[]): void {
  const covered = new Array<boolean>(text.length).fill(false)
  for (const p of pieces) {
    for (let i = p.start; i < p.end; i++) covered[i] = true
  }
  for (let i = 0; i < text.length; i++) {
    if (/[\s]/.test(text[i]!)) continue
    assert.ok(covered[i], `第 ${i} 个字符「${text[i]}」没有落进任何片段`)
  }
}

/** 是否含孤立代理项（半截 emoji） */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(i + 1 < s.length && next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 主切分
// ---------------------------------------------------------------------------

describe('主切分与引号保护（docs/11 §2.1）', () => {
  it('句末标点切分：。！？…', () => {
    const text = '天亮了。他走出门！雨停了吗？'
    const pieces = splitSentences(text, { maxLineChars: 120 })
    assert.deepEqual(
      pieces.map((p) => p.text),
      ['天亮了。', '他走出门！', '雨停了吗？'],
    )
    assertPieces(text, pieces)
  })

  it('引号内的逗号与句号都不切（保持台词完整）', () => {
    const quoted = '他说道：“你好，我来了。”然后走了。'
    const pieces = splitSentences(quoted, { maxLineChars: 120 })
    // 引号内的「，」「。」都不构成断点，整段只在结尾断一次 → 1 片
    assert.equal(pieces.length, 1)
    assert.equal(pieces[0]!.text, quoted)
    assertPieces(quoted, pieces)

    // 对照组：去掉引号后同样的标点就会切开，证明「不切」确实是引号保护带来的
    const bare = '他说道：你好，我来了。然后走了。'
    const barePieces = splitSentences(bare, { maxLineChars: 120 })
    assert.deepEqual(
      barePieces.map((p) => p.text),
      ['他说道：你好，我来了。', '然后走了。'],
    )
    assertPieces(bare, barePieces)
  })

  it('引号内的句号不会被切开（即使整句很长）', () => {
    const quoted = '“今天天气不错。我们出门走走吧。”他笑着说。'
    const pieces = splitSentences(quoted, { maxLineChars: 120 })
    assert.equal(pieces.length, 1)
    assert.equal(pieces[0]!.text, quoted)

    const bare = '今天天气不错。我们出门走走吧。他笑着说。'
    assert.equal(splitSentences(bare, { maxLineChars: 120 }).length, 3)
  })

  it('省略号连排时一起归入前一句', () => {
    const text = '他说……然后走了。'
    const pieces = splitSentences(text, { maxLineChars: 120 })
    assert.deepEqual(
      pieces.map((p) => p.text),
      ['他说……', '然后走了。'],
    )
    assertPieces(text, pieces)
  })

  it('段落边界（换行）强制断行', () => {
    const text = '第一句。\n第二句。\n\n第三句。'
    const pieces = splitSentences(text, { maxLineChars: 120 })
    assert.deepEqual(
      pieces.map((p) => p.text),
      ['第一句。', '第二句。', '第三句。'],
    )
    assertPieces(text, pieces)
    assertNoLoss(text, pieces)
  })

  it('行首行尾空白被裁掉，偏移量同步调整', () => {
    const text = '  前面有空格。  后面也有。  '
    const pieces = splitSentences(text, { maxLineChars: 120 })
    assert.equal(pieces[0]!.text, '前面有空格。')
    assert.equal(pieces[0]!.start, 2)
    assert.equal(pieces[1]!.text, '后面也有。')
    assertPieces(text, pieces)
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(splitSentences(''), [])
  })

  it('默认 maxLineChars 取 CANVAS_DEFAULTS（120）', () => {
    const text = 'a'.repeat(200) + '。'
    const pieces = splitSentences(text)
    for (const p of pieces) assert.ok(p.text.length <= 120, `片段超长：${p.text.length}`)
  })
})

// ---------------------------------------------------------------------------
// 二次切分
// ---------------------------------------------------------------------------

describe('超长句二次切分（docs/11 §2.1）', () => {
  /** 4 个 30 字的子句，逗号位于 30 / 61 / 92，句末句号在 123，全长 124 */
  const clause = '一二三四五六七八九十'.repeat(3)
  const longSentence = [clause, clause, clause, clause].join('，') + '。'

  it('在逗号处切开，且断点取靠中间的', () => {
    const pieces = splitSentences(longSentence, { maxLineChars: 100 })
    assert.equal(longSentence.length, 124)
    assert.equal(pieces.length, 2)
    for (const p of pieces) assert.ok(p.text.length <= 100, `片段超长：${p.text.length}`)
    // 断点应落在中间那个逗号之后（61 + 1 = 62）
    assert.equal(pieces[0]!.end, 62)
    assert.ok(pieces[0]!.text.endsWith('，'))
    // 断点位置「合理」：落在整句的中间一带
    const ratio = pieces[0]!.text.length / longSentence.length
    assert.ok(ratio > 0.3 && ratio < 0.7, `断点比例不合理：${ratio}`)
    assertPieces(longSentence, pieces)
    assertNoLoss(longSentence, pieces)
  })

  it('递归切分直到每片都不超限', () => {
    const pieces = splitSentences(longSentence, { maxLineChars: 40 })
    assert.ok(pieces.length >= 4)
    for (const p of pieces) assert.ok(p.text.length <= 40, `片段超长：${p.text.length}`)
    assertPieces(longSentence, pieces)
    assertNoLoss(longSentence, pieces)
  })

  it('括号/书名号内部不作为断点', () => {
    const text = `（${'X'.repeat(30)}，${'Y'.repeat(30)}）。`
    assert.equal(text.length, 64)
    const pieces = splitSentences(text, { maxLineChars: 40 })
    // 括号里的逗号不可用 → 只能硬切
    assert.equal(pieces[0]!.text.length, 40)
    assert.ok(!pieces[0]!.text.endsWith('，'), '不该用括号内的逗号做断点')
    assertPieces(text, pieces)
    assertNoLoss(text, pieces)
  })

  it('没有任何可用断点时硬切（保证不产出超长行）', () => {
    const text = '啊啊啊啊啊啊啊'
    const pieces = splitSentences(text, { maxLineChars: 3 })
    assert.deepEqual(
      pieces.map((p) => p.text),
      ['啊啊啊', '啊啊啊', '啊'],
    )
    assertPieces(text, pieces)
    assertNoLoss(text, pieces)
  })

  it('硬切不会切断代理对（emoji 不被拆开）', () => {
    const text = '😀😀😀😀'
    const pieces = splitSentences(text, { maxLineChars: 3 })
    for (const p of pieces) {
      assert.equal(hasLoneSurrogate(p.text), false, `出现孤立代理项：${JSON.stringify(p.text)}`)
      assert.ok(p.text.length >= 2, '每个片段至少是一个完整码点')
    }
    // 拼接后与原文一致（不丢字、不重复）
    assert.equal(pieces.map((p) => p.text).join(''), text)
    assertPieces(text, pieces)
    assertNoLoss(text, pieces)
  })

  it('超长句尾部的逗号切分会继续递归（多段长文本）', () => {
    const manyClauses = Array.from({ length: 10 }, (_, i) => `第${i}段的内容写得比较长一些`).join('，') + '。'
    const pieces = splitSentences(manyClauses, { maxLineChars: 30 })
    for (const p of pieces) assert.ok(p.text.length <= 30)
    assertPieces(manyClauses, pieces)
    assertNoLoss(manyClauses, pieces)
  })
})

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

describe('辅助 API', () => {
  it('protectedPositionMap 标出引号与括号内部', () => {
    const text = 'a“b”c（d）e'
    const flags = protectedPositionMap(text)
    assert.equal(flags.length, text.length)
    assert.equal(flags[0], false) // a
    assert.equal(flags[1], true) // 开引号
    assert.equal(flags[2], true) // 引号内
    assert.equal(flags[4], false) // c
    assert.equal(flags[5], true) // 开括号
    assert.equal(flags[6], true) // 括号内
    assert.equal(flags[8], false) // e
  })

  it('splitSentenceTexts 只返回文本', () => {
    const texts = splitSentenceTexts('天亮了。他走出门！', 120)
    assert.deepEqual(texts, ['天亮了。', '他走出门！'])
  })

  it('综合样本：偏移、不重叠、不漏字', () => {
    const text = [
      '第一章 开始',
      '他说道：“你好，我来了。”',
      '他慢慢走过那条长长的街道，心里想着很多事情，' + '然后就停下了脚步，继续向前走。'.repeat(6),
      '',
      '他终于到家了。',
    ].join('\n')
    const pieces = splitSentences(text, { maxLineChars: 60 })
    assert.ok(pieces.length > 5)
    for (const p of pieces) assert.ok(p.text.length <= 60)
    assertPieces(text, pieces)
    assertNoLoss(text, pieces)
    // 标题行自身也是一片
    assert.equal(pieces[0]!.text, '第一章 开始')
  })
})
