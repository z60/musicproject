/**
 * Novel Studio · 引号与对白解析测试
 * ============================================================================
 * 设计文档：docs/11-功能域-画本编辑.md §2.2（引号与对白解析，Step 2）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/text-quote.test.ts
 *
 * 覆盖点：
 *   · 嵌套引号（「」包在“”里）按最内层优先配对
 *   · 引号不配对 → unbalanced
 *   · 破折号对白（——对白）
 *   · 引导语位置：前 / 后 / 中间，以及说话人预填
 *   · 音效提示、心理描写、纯叙述
 *   · stripQuotes / quoteDepthMap
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { QUOTE_PAIRS } from '../../src/shared/constants.ts'
import {
  ALL_QUOTE_CHARS,
  QUOTE_STYLE_LABELS,
  collectQuoteSpans,
  detectQuoteStyle,
  extractCue,
  parseQuote,
  quoteDepthMap,
  stripQuotes,
} from '../../src/shared/text/quote.ts'

describe('引号族（constants.QUOTE_PAIRS）', () => {
  it('引号族标签与字符表齐备', () => {
    assert.equal(QUOTE_PAIRS.length, QUOTE_STYLE_LABELS.length)
    assert.deepEqual(QUOTE_STYLE_LABELS, ['“”', '「」', '『』', '""', '‘’'])
    assert.ok(ALL_QUOTE_CHARS.includes('“'))
    assert.ok(ALL_QUOTE_CHARS.includes('」'))
    // 去重后不会重复列出直引号
    assert.equal(new Set(ALL_QUOTE_CHARS).size, ALL_QUOTE_CHARS.length)
  })
})

describe('引号配对（docs/11 §2.2 第 1 步）', () => {
  it('嵌套引号按最内层优先记录，深度正确', () => {
    const text = '他说：“他问我「你叫什么名字」。”'
    const { spans, unbalanced } = collectQuoteSpans(text)
    assert.equal(unbalanced, false)
    assert.equal(spans.length, 2)
    // 最内层（「」）先闭合，因此排在最前
    assert.equal(spans[0]!.style, '「」')
    assert.equal(spans[0]!.text, '你叫什么名字')
    assert.equal(spans[0]!.depth, 2)
    assert.equal(spans[1]!.style, '“”')
    assert.equal(spans[1]!.text, '他问我「你叫什么名字」。')
    assert.equal(spans[1]!.depth, 1)
    assert.equal(detectQuoteStyle(spans), '“”')
  })

  it('三引号族混用也能配对', () => {
    const text = '「他说『好』就走了」'
    const { spans, unbalanced } = collectQuoteSpans(text)
    assert.equal(unbalanced, false)
    assert.deepEqual(
      spans.map((s) => s.style),
      ['『』', '「」'],
    )
    assert.deepEqual(
      spans.map((s) => s.depth),
      [2, 1],
    )
  })

  it('直引号（开=闭同为 "）靠「先判闭合再判开启」配对', () => {
    const { spans, unbalanced } = collectQuoteSpans('He said "hello" loudly')
    assert.equal(unbalanced, false)
    assert.equal(spans.length, 1)
    assert.equal(spans[0]!.style, '""')
    assert.equal(spans[0]!.text, 'hello')
  })

  it('游离的闭引号 → unbalanced', () => {
    const r = collectQuoteSpans('他说”你好')
    assert.equal(r.unbalanced, true)
    assert.equal(r.spans.length, 0)
  })

  it('未闭合的开引号 → unbalanced，且记录在 unclosed 里', () => {
    const r = collectQuoteSpans('“你好，我是李明。')
    assert.equal(r.unbalanced, true)
    assert.equal(r.spans.length, 0)
    assert.equal(r.unclosed.length, 1)
    assert.equal(r.unclosed[0]!.style, '“”')
    assert.equal(r.unclosed[0]!.text, '你好，我是李明。')
    assert.equal(r.unclosed[0]!.closeIndex, -1)
  })

  it('quoteDepthMap 标出引号内外的位置', () => {
    const text = 'a“b，c”d'
    const depth = quoteDepthMap(text)
    assert.equal(depth.length, text.length)
    assert.equal(depth[0], 0) // a
    assert.ok(depth[1]! > 0) // 开引号本身
    assert.ok(depth[2]! > 0 && depth[4]! > 0) // 引号内的 b 与 ，
    assert.equal(depth[6], 0) // 闭引号之后回到 0
  })
})

describe('对白解析（docs/11 §2.2）', () => {
  it('有引号 → dialogue，text 为剥离引号后的可录文本', () => {
    const r = parseQuote('他说：“你好，我来了。”')
    assert.equal(r.kind, 'dialogue')
    assert.equal(r.quoteStyle, '“”')
    assert.equal(r.text, '你好，我来了。')
    assert.equal(r.unbalanced, false)
  })

  it('多处顶层引号按顺序拼接', () => {
    const r = parseQuote('「你好」「再见」')
    assert.equal(r.kind, 'dialogue')
    assert.equal(r.text, '你好再见')
  })

  it('不配对引号仍按台词处理，并标 unbalanced', () => {
    const r = parseQuote('“你好，我是李明。')
    assert.equal(r.kind, 'dialogue')
    assert.equal(r.text, '你好，我是李明。')
    assert.equal(r.unbalanced, true)
  })

  it('破折号对白（——对白）→ dialogue，quoteStyle 为 null', () => {
    const r = parseQuote('——你好，我是李明。')
    assert.equal(r.kind, 'dialogue')
    assert.equal(r.text, '你好，我是李明。')
    assert.equal(r.quoteStyle, null)
    assert.equal(r.unbalanced, false)
  })

  it('音效提示 → sfx_note', () => {
    const square = parseQuote('【音效：门吱呀一声】')
    assert.equal(square.kind, 'sfx_note')
    assert.equal(square.text, '音效：门吱呀一声')

    const paren = parseQuote('（音效：远处传来雷声）')
    assert.equal(paren.kind, 'sfx_note')
    assert.equal(paren.text, '远处传来雷声')
  })

  it('心理描写（无引号）→ inner', () => {
    const r = parseQuote('他心里想着，明天一定要早点起床。')
    assert.equal(r.kind, 'inner')
    assert.equal(r.text, '他心里想着，明天一定要早点起床。')
  })

  it('纯叙述 → narration（含「整行以引导语结尾」）', () => {
    assert.equal(parseQuote('他慢慢走回家。').kind, 'narration')
    const r = parseQuote('他说道。')
    assert.equal(r.kind, 'narration')
    assert.equal(r.cue!.verb, '说道')
  })
})

describe('引导语位置与说话人预填（docs/11 §2.2 第 2~3 步）', () => {
  it('引导语在前：他说道：“你好。”', () => {
    const r = parseQuote('他说道：“你好。”')
    assert.equal(r.cue!.verb, '说道')
    assert.equal(r.cue!.position, 'before')
    assert.equal(r.cue!.speakerHint, '他')
  })

  it('引导语在后：“你好。”他说道。', () => {
    const r = parseQuote('“你好。”他说道。')
    assert.equal(r.cue!.verb, '说道')
    assert.equal(r.cue!.position, 'after')
    assert.equal(r.cue!.speakerHint, '他')
  })

  it('引导语在中间：“你好，”他说道，“我走了。”', () => {
    const r = parseQuote('“你好，”他说道，“我走了。”')
    assert.equal(r.cue!.verb, '说道')
    assert.equal(r.cue!.position, 'middle')
    assert.equal(r.cue!.speakerHint, '他')
    assert.equal(r.text, '你好，我走了。')
  })

  it('多字引导动词优先（低声说道 而不是 说道）', () => {
    const r = parseQuote('贾维斯低声说道：“收到。”')
    assert.equal(r.cue!.verb, '低声说道')
    assert.equal(r.cue!.speakerHint, '贾维斯')
    assert.equal(r.cue!.position, 'before')
  })

  it('拿不准说话人时返回 null（不给 UI 错误的预填）', () => {
    const r = parseQuote('他看着她慢慢地说道：“好。”')
    assert.equal(r.cue!.verb, '说道')
    assert.equal(r.cue!.speakerHint, null, '动词前是长句而不是人名时应返回 null')
  })

  it('无引导动词时 cue 为 null', () => {
    const r = parseQuote('“天亮了。”')
    assert.equal(r.cue, null)
  })

  it('extractCue 可直接调用（UI 实时预览）', () => {
    const text = '“好。”他点头道。'
    const { spans } = collectQuoteSpans(text)
    const cue = extractCue(text, spans)
    assert.equal(cue!.verb, '道')
    assert.equal(cue!.position, 'after')
  })
})

describe('stripQuotes', () => {
  it('去掉所有引号字符（含不配对的），不动引号内的文字', () => {
    assert.equal(stripQuotes('“你好”他说'), '你好他说')
    assert.equal(stripQuotes('「他说『好』」'), '他说好')
    assert.equal(stripQuotes('没有引号'), '没有引号')
    assert.equal(stripQuotes('“未闭合'), '未闭合')
  })

  it('去掉引号后仍保留标点与空格', () => {
    assert.equal(stripQuotes('“你好，”他说。'), '你好，他说。')
  })
})
