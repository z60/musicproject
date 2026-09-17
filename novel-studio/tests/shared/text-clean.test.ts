/**
 * Novel Studio · 清洗测试
 * ============================================================================
 * 设计文档：docs/10-功能域-书籍导入.md §5（清洗规则）与 §5.3（清洗报告必须可见）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/text-clean.test.ts
 *
 * 覆盖点（对应 docs/10 §11 测试要点的「清洗」）：
 *   · 广告行 / 页尾导航 / 网址水印 / 页码行 各一组
 *   · 零宽字符 / 重复行 / 多余空行 / 全角空格 / 不换行空格
 *   · report 的计数与实际删除条数**完全一致**
 *   · 能列出被删内容（removedLines，供 UI「查看被删内容」逐条恢复，docs/10 §5.3）
 *   · 谨慎项默认关闭、显式开启才生效（docs/10 §5.2）
 *   · suspiciousLines 上限 200（docs/10 §5.3）
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  cleanText,
  isAdLine,
  isNavLine,
  isPageNumberLine,
  isUrlWatermarkLine,
  matchAdKeywords,
  matchNavKeywords,
  stripBracketContent,
  type CleanReportDetail,
  type RemovedLine,
} from '../../src/shared/text/clean.ts'

// ---------------------------------------------------------------------------
// 综合样本
// ---------------------------------------------------------------------------

const RAW = [
  '第一章 开始',
  '天才一秒记住本站地址：www.example.com',
  '他慢慢走进屋子。',
  '\u200B他看了看四周。\uFEFF',
  '上一章 目录 下一章',
  'www.example.com',
  '',
  '第 12 页',
  '',
  '12',
  '',
  '他走进屋子，屋里很安静。',
  '他走进屋子，屋里很安静。',
  '',
  '',
  '',
  '结尾。',
].join('\n')

const reasonCount = (report: CleanReportDetail, reason: RemovedLine['reason']): number =>
  report.removedLines.filter((l) => l.reason === reason).length

describe('清洗综合样本（docs/10 §5.1）', () => {
  const { text, report } = cleanText(RAW)

  it('广告行被删除', () => {
    assert.equal(report.removedAdLines, 1)
    assert.equal(reasonCount(report, 'ad'), 1)
    assert.ok(!text.includes('天才一秒记住'))
    assert.equal(report.removedLines.find((l) => l.reason === 'ad')!.text, '天才一秒记住本站地址：www.example.com')
  })

  it('页尾导航行被删除', () => {
    assert.equal(report.removedByReason.nav, 1)
    assert.ok(!text.includes('上一章'))
  })

  it('网址水印行被删除', () => {
    assert.equal(report.removedByReason['url-watermark'], 1)
    assert.ok(!text.includes('www.example.com'))
  })

  it('页码行被删除（「第 12 页」与纯数字行）', () => {
    assert.equal(report.removedPageNumberLines, 2)
    assert.equal(reasonCount(report, 'page-number'), 2)
    assert.ok(!text.includes('第 12 页'))
  })

  it('零宽字符被移除并计数', () => {
    assert.equal(report.removedZeroWidthChars, 2) // U+200B 与正文中的 U+FEFF
    assert.ok(!text.includes('\u200B'))
    assert.ok(!text.includes('\uFEFF'))
    assert.ok(text.includes('他看了看四周。'))
  })

  it('重复行被删除（±5 行窗口内、长度 > 8）', () => {
    assert.equal(report.removedDuplicateLines, 1)
    assert.equal(reasonCount(report, 'duplicate'), 1)
    assert.equal(text.split('他走进屋子，屋里很安静。').length - 1, 1)
  })

  it('多余空行被压缩（连续 ≥3 个 \\n → 2 个）', () => {
    assert.ok(report.collapsedBlankRuns >= 1)
    assert.ok(!/\n{3,}/.test(text))
  })

  it('计数与 removedLines 完全一致（report 不许说谎）', () => {
    assert.equal(report.removedAdLines, report.removedByReason.ad)
    assert.equal(
      report.removedDuplicateLines,
      report.removedByReason.duplicate + report.removedByReason['non-adjacent-duplicate'],
    )
    assert.equal(report.removedPageNumberLines, report.removedByReason['page-number'])
    const total = Object.values(report.removedByReason).reduce((a, b) => a + b, 0)
    assert.equal(report.removedLines.length, total, 'removedLines 条数必须等于各原因计数之和')
    assert.equal(report.removedLinesTruncated, false)
  })

  it('每一条被删内容都带行号与中文原因（供 UI 展示）', () => {
    for (const line of report.removedLines) {
      assert.ok(line.lineNo >= 1 && line.lineNo <= RAW.split('\n').length)
      assert.ok(line.text.length > 0)
      assert.ok(line.reasonText.length > 0)
    }
  })

  it('remainingChars 等于清洗后文本长度，保留正文', () => {
    assert.equal(report.remainingChars, text.length)
    assert.ok(text.includes('第一章 开始'))
    assert.ok(text.includes('他慢慢走进屋子。'))
    assert.ok(text.includes('结尾。'))
  })
})

// ---------------------------------------------------------------------------
// 判定助手（UI 实时预览也要用）
// ---------------------------------------------------------------------------

describe('单行判定助手', () => {
  it('广告关键词：长行里只命中一个词时不删（避免误删正文）', () => {
    assert.deepEqual(matchAdKeywords('天才一秒记住本站地址'), ['天才一秒记住'])
    assert.equal(isAdLine('天才一秒记住本站地址：www.xxx.com'), true)
    // 长行（> 60 字）里出现「首发」这类词不删，改为进入 suspiciousLines
    const longLine = '他第一次首发上场的时候，全场都沸腾了。' + '那一刻他明白了什么叫作梦想成真。'.repeat(5)
    assert.ok(longLine.length > 60, `测试样本必须 > 60 字，实际 ${longLine.length}`)
    assert.equal(isAdLine(longLine), false)
    const { report } = cleanText(longLine)
    assert.equal(report.removedAdLines, 0)
    assert.equal(report.suspiciousLines.length, 1)
    assert.match(report.suspiciousLines[0]!.reason, /疑似广告行/)
  })

  it('导航行：整行只有导航词或命中 ≥2 个导航词', () => {
    assert.deepEqual(matchNavKeywords('上一章 目录 下一章'), ['上一章', '下一章'])
    assert.equal(isNavLine('上一章 目录 下一章'), true)
    assert.equal(isNavLine('返回目录'), true)
    assert.equal(isNavLine('他翻到下一章看了看'), false) // 正文，只命中一个词且有多余文字
  })

  it('网址水印：行内 URL 且整行 < 60 字', () => {
    assert.equal(isUrlWatermarkLine('www.example.com'), true)
    assert.equal(isUrlWatermarkLine('https://a.example.org/read/1.html'), true)
    // 长正文里的 URL 不算水印（> 60 字）
    const longLine = '他打开 www.example.com 看了很久，然后关掉了浏览器。' + '继续写他未完成的小说，一字一句地改。'.repeat(3)
    assert.ok(longLine.length >= 60)
    assert.equal(isUrlWatermarkLine(longLine), false)
  })

  it('页码行：第 N 页 / - N - / （N）/ 前后空行的纯数字行', () => {
    assert.equal(isPageNumberLine('第 12 页'), true)
    assert.equal(isPageNumberLine('- 12 -'), true)
    assert.equal(isPageNumberLine('（7）', { prevBlank: true, nextBlank: true }), true)
    assert.equal(isPageNumberLine('12', { prevBlank: true, nextBlank: true }), true)
    assert.equal(isPageNumberLine('12', { prevBlank: false, nextBlank: true }), false)
    assert.equal(isPageNumberLine('1234567', { prevBlank: true, nextBlank: true }), false)
    // 纯数字章节标题保护（docs/10 §5.1 与 §6.2 的规则冲突）
    assert.equal(isPageNumberLine('12', { prevBlank: true, nextBlank: true, protectPureDigit: true }), false)
  })

  it('protectPureDigitLines 打开后纯数字行不再被当页码删除', () => {
    const sample = ['', '12', '', '正文内容在这里。'].join('\n')
    assert.equal(cleanText(sample).report.removedPageNumberLines, 1)
    const protectedResult = cleanText(sample, { protectPureDigitLines: true })
    assert.equal(protectedResult.report.removedPageNumberLines, 0)
    assert.ok(protectedResult.text.includes('12'))
  })

  it('stripBracketContent 返回删除后的文本与被删片段', () => {
    const r = stripBracketContent('他说话了（这句话是作者注）然后离开了。')
    assert.equal(r.text, '他说话了然后离开了。')
    assert.deepEqual(r.removed, ['（这句话是作者注）'])
    assert.deepEqual(stripBracketContent('没有括号').removed, [])
  })
})

// ---------------------------------------------------------------------------
// 空格 / 换行归一化
// ---------------------------------------------------------------------------

describe('空格与换行归一化（docs/10 §5.1）', () => {
  it('全角空格、&nbsp;、U+00A0 与连续空格都归一到半角单空格', () => {
    const { text, report } = cleanText('他\u3000说：&nbsp;你好\u00A0\u00A0呀    好')
    assert.equal(text, '他 说： 你好 呀 好')
    assert.ok(report.normalizedSpaces >= 4)
  })

  it('换行归一化计数进 report.normalizedNewlines', () => {
    const { text, report } = cleanText('第一行\r\n第二行\r第三行\n第四行')
    assert.equal(text, '第一行\n第二行\n第三行\n第四行')
    assert.equal(report.normalizedNewlines, 2)
  })

  it('每行 trim（中文排版惯例）', () => {
    const { text } = cleanText('   第一章 开始   \n\t 正文内容  \t')
    assert.equal(text, '第一章 开始\n正文内容')
  })

  it('开关可以关掉：collapseBlankLines=false 时保留连续空行', () => {
    const { text, report } = cleanText('A\n\n\n\nB', { collapseBlankLines: false })
    assert.equal(text, 'A\n\n\n\nB')
    assert.equal(report.collapsedBlankRuns, 0)
    const collapsed = cleanText('A\n\n\n\nB')
    assert.equal(collapsed.text, 'A\n\nB')
    assert.equal(collapsed.report.collapsedBlankRuns, 1)
  })

  it('开关可以关掉：removeZeroWidth=false 时保留零宽字符', () => {
    const { text, report } = cleanText('A\u200BB', { removeZeroWidth: false })
    assert.equal(text, 'A\u200BB')
    assert.equal(report.removedZeroWidthChars, 0)
  })
})

// ---------------------------------------------------------------------------
// 谨慎项（docs/10 §5.2）
// ---------------------------------------------------------------------------

const CAREFUL_TEXT = [
  '他慢慢地走过那条长长的街道，心里想着很多事情，',
  '然后就停下了脚步。',
  '排比句，是要重复的。',
  '',
  '中间隔了几段。',
  '',
  '',
  '',
  '排比句，是要重复的。',
  '他说话了（这句话是作者注）然后离开了。',
].join('\n')

describe('谨慎项默认关闭（docs/10 §5.2）', () => {
  const { text, report } = cleanText(CAREFUL_TEXT)

  it('窗口外的重复行默认保留', () => {
    assert.equal(report.removedByReason['non-adjacent-duplicate'], 0)
    assert.equal(text.split('排比句，是要重复的。').length - 1, 2)
  })

  it('硬换行段落默认不合并', () => {
    assert.equal(report.mergedHardWrapLines, 0)
    assert.ok(text.includes('心里想着很多事情，\n然后就停下了脚步。'))
  })

  it('括号内容默认保留', () => {
    assert.ok(text.includes('（这句话是作者注）'))
    assert.equal(report.removedByReason['bracket-content'], 0)
  })
})

describe('谨慎项显式开启后生效（docs/10 §5.2）', () => {
  it('去除非相邻重复行', () => {
    const { text, report } = cleanText(CAREFUL_TEXT, { removeNonAdjacentDuplicates: true })
    assert.equal(report.removedByReason['non-adjacent-duplicate'], 1)
    assert.equal(text.split('排比句，是要重复的。').length - 1, 1)
    // 计数口径：removedDuplicateLines 含非相邻项
    assert.equal(report.removedDuplicateLines, report.removedByReason['non-adjacent-duplicate'])
  })

  it('合并硬换行段落', () => {
    const { text, report } = cleanText(CAREFUL_TEXT, { mergeHardWrappedLines: true })
    assert.equal(report.mergedHardWrapLines, 1)
    assert.ok(text.includes('心里想着很多事情，然后就停下了脚步。'))
  })

  it('去括号内容：内容与原因都记录在 removedLines 里', () => {
    const { text, report } = cleanText(CAREFUL_TEXT, { removeBracketContent: true })
    assert.equal(report.removedByReason['bracket-content'], 1)
    assert.ok(!text.includes('这句话是作者注'))
    const removed = report.removedLines.find((l) => l.reason === 'bracket-content')!
    assert.equal(removed.text, '（这句话是作者注）')
    assert.equal(text.split('。').length > 1, true)
  })

  it('整行都是括号内容时该行消失，但仍记录被删内容', () => {
    const { text, report } = cleanText(['正文。', '（本章完）', '结尾。'].join('\n'), { removeBracketContent: true })
    assert.equal(report.removedByReason['bracket-content'], 1)
    assert.ok(!text.includes('本章完'))
    assert.ok(text.includes('正文。') && text.includes('结尾。'))
  })

  it('繁简转换需要注入实现：未注入时跳过并给出 warning（不假装成功）', () => {
    const raw = '這是繁體字'
    const skipped = cleanText(raw, { traditionalToSimplified: true })
    assert.equal(skipped.text, raw, '未注入实现时原文必须保持不变')
    assert.equal(skipped.report.warnings.length, 1)
    assert.match(skipped.report.warnings[0]!, /opencc|注入/)

    const converted = cleanText(raw, {
      traditionalToSimplified: true,
      traditionalToSimplifiedConverter: (s) => s.replace('這', '这').replace('體', '体'),
    })
    assert.equal(converted.text, '这是繁体字')
    assert.equal(converted.report.warnings.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 报告上限（docs/10 §5.3）
// ---------------------------------------------------------------------------

describe('报告上限', () => {
  it('suspiciousLines 最多 200 条', () => {
    const longTail = '内容很长很长很长很长很长很长很长很长很长很长很长很长很长。'
    const lines = Array.from(
      { length: 300 },
      (_, i) => `这是第${i}行正文，${longTail}${longTail}其中出现了首发这个词。`,
    )
    assert.ok(lines[0]!.length > 60)
    const { report } = cleanText(lines.join('\n'))
    assert.equal(report.removedAdLines, 0, '长行不该被当广告删除')
    assert.equal(report.suspiciousLines.length, 200)
    assert.ok(report.suspiciousLines.every((l) => l.lineNo >= 1))
  })

  it('maxSuspiciousLines 可配', () => {
    const longTail = '内容很长很长很长很长很长很长很长很长很长很长很长很长很长。'
    const lines = Array.from({ length: 10 }, () => `很长的正文行，里面有首发这个词，${longTail}${longTail}`)
    const { report } = cleanText(lines.join('\n'), { maxSuspiciousLines: 3 })
    assert.equal(report.suspiciousLines.length, 3)
  })

  it('removedLines 超过 maxRemovedLines 时截断，但计数仍然精确', () => {
    const text = Array.from({ length: 5 }, (_, i) => `天才一秒记住本站地址${i}`).join('\n')
    const { report } = cleanText(text, { maxRemovedLines: 2 })
    assert.equal(report.removedAdLines, 5, '计数必须精确')
    assert.equal(report.removedLines.length, 2, '明细被截断')
    assert.equal(report.removedLinesTruncated, true)
  })

  it('空输入不崩', () => {
    const { text, report } = cleanText('')
    assert.equal(text, '')
    assert.equal(report.remainingChars, 0)
    assert.equal(report.removedLines.length, 0)
  })
})
