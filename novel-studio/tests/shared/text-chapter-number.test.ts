/**
 * Novel Studio · 章号解析与「按章节范围勾选」纯逻辑测试
 * ============================================================================
 * 背景：导入向导第 5 步要「只导入第 1~20 章」这类范围需求。
 * 章号解析与范围勾选抽在 shared/text/chapter-number.ts（零依赖，渲染进程可单测）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  chapterNumberRange,
  extractChapterNumber,
  parseChineseNumber,
  selectDraftsByChapterRange,
} from '../../src/shared/text/chapter-number.ts'

const draft = (title: string, included = true) => ({ title, included })

describe('章号解析', () => {
  it('阿拉伯数字 / 中文数字 / 无号', () => {
    assert.equal(extractChapterNumber('第1章 最离谱的世纪笑话（上）'), 1)
    assert.equal(extractChapterNumber('第 12 章 标题'), 12)
    assert.equal(extractChapterNumber('第十二章 标题'), 12)
    assert.equal(extractChapterNumber('番外三'), 3)
    assert.equal(extractChapterNumber('前言'), null)
    assert.equal(extractChapterNumber(''), null)
  })

  it('中文数字解析', () => {
    assert.equal(parseChineseNumber('二十三'), 23)
    assert.equal(parseChineseNumber('一百零八'), 108)
    assert.equal(parseChineseNumber('十二个'), null)
    assert.equal(parseChineseNumber(''), null)
  })
})

describe('按章节范围勾选', () => {
  const list = () => [draft('第1章 甲'), draft('第2章 乙'), draft('第3章 丙'), draft('第4章 丁')]

  it('只勾选范围内、其余取消', () => {
    const { drafts, count } = selectDraftsByChapterRange(list(), 2, 3)
    assert.equal(count, 2)
    assert.deepEqual(drafts.map(d => d.included), [false, true, true, false])
  })

  it('起止写反也能用（自动交换）', () => {
    const { drafts, count } = selectDraftsByChapterRange(list(), 3, 2)
    assert.equal(count, 2)
    assert.deepEqual(drafts.map(d => d.included), [false, true, true, false])
  })

  it('未改动的草稿保持原对象引用（避免无谓重渲染）', () => {
    const input = list()
    const { drafts } = selectDraftsByChapterRange(input, 1, 4)
    for (let i = 0; i < input.length; i++) assert.equal(drafts[i], input[i])
  })

  it('标题里没有章号时按列表序号回退', () => {
    const input = [draft('前言'), draft('序'), draft('第3节'), draft('尾声')]
    const { drafts, count } = selectDraftsByChapterRange(input, 2, 3)
    assert.equal(count, 2)
    assert.deepEqual(drafts.map(d => d.included), [false, true, true, false])
  })

  it('非法范围不改动任何勾选', () => {
    const input = list()
    const { drafts, count } = selectDraftsByChapterRange(input, Number.NaN, 3)
    assert.equal(count, 0)
    assert.deepEqual(drafts, input)
  })

  it('chapterNumberRange 给出识别到的范围', () => {
    assert.deepEqual(chapterNumberRange(list()), { min: 1, max: 4, mapped: 4 })
    assert.deepEqual(chapterNumberRange([]), { min: 0, max: 0, mapped: 0 })
  })
})
