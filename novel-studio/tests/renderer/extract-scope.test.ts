/**
 * 测试 · 角色抽取的范围策略与结果说明（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.30）：画本编辑 → 角色表 →「自动抽取」点了没反应。
 *
 * 界面侧的原因：面板只用**当前章节**当范围，而一章常常抽不到任何人名
 * （楔子 82 字、第 2 章 726 字剧本体），于是候选列表恒为空、也没有任何提示 ——
 * 用户无法区分「按钮坏了」与「抽不到」。
 *
 * 这组测试钉的是修好后的策略：本章抽到 0 个 → 扩大到全书；无论如何都给一句明确回执。
 * 被测模块刻意不 import 任何项目内模块（`@/` 别名只在 Vite 里生效），所以能在 Node 里跑。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  describeExtractResult,
  shouldWidenToBook,
} from '../../src/renderer/src/shared/lib/extract-scope.ts'

describe('抽取范围：本章抽不到就扩大到全书', () => {
  it('本章 0 个候选 → 扩大（事故的直接回归）', () => {
    assert.equal(shouldWidenToBook({ chapterScoped: true, found: 0 }), true)
  })

  it('本章抽到了人就不扩大（尊重章节范围，避免提前透露后文角色）', () => {
    assert.equal(shouldWidenToBook({ chapterScoped: true, found: 1 }), false)
    assert.equal(shouldWidenToBook({ chapterScoped: true, found: 7 }), false)
  })

  it('本来就是全书范围时没有「扩大」这回事', () => {
    assert.equal(shouldWidenToBook({ chapterScoped: false, found: 0 }), false)
  })

  it('负数（脏输入）按 0 处理，不会崩', () => {
    assert.equal(shouldWidenToBook({ chapterScoped: true, found: -3 }), true)
  })
})

describe('抽取结果必须有明确回执（不允许「点了没反应」）', () => {
  it('扩到全书后抽到了人：说明范围变化 + 结果', () => {
    const note = describeExtractResult({ chapterScoped: true, found: 0, widened: true, bookFound: 7 })
    assert.match(note, /本章没抽到/)
    assert.match(note, /扩大到全书/)
    assert.match(note, /7 个/)
  })

  it('本章与全书都没有：给出可执行的下一步', () => {
    const note = describeExtractResult({ chapterScoped: true, found: 0, widened: true, bookFound: 0 })
    assert.match(note, /都没抽到/)
    assert.match(note, /新增角色/)
  })

  it('本章抽到了：报数量，不提扩大', () => {
    const note = describeExtractResult({ chapterScoped: true, found: 2, widened: false, bookFound: 2 })
    assert.equal(note, '本章抽到 2 个候选角色。')
  })

  it('未限制章节时同样报结果；0 个时给下一步', () => {
    assert.equal(
      describeExtractResult({ chapterScoped: false, found: 3, widened: false, bookFound: 3 }),
      '抽到 3 个候选角色。',
    )
    assert.match(
      describeExtractResult({ chapterScoped: false, found: 0, widened: false, bookFound: 0 }),
      /没有抽到候选角色/,
    )
  })

  it('任何一条回执都不为空（UI 直接渲染它）', () => {
    for (const chapterScoped of [true, false]) {
      for (const widened of [true, false]) {
        for (const [found, bookFound] of [[0, 0], [0, 5], [4, 4]]) {
          const note = describeExtractResult({ chapterScoped, found: found!, widened, bookFound: bookFound! })
          assert.ok(note.length > 0, JSON.stringify({ chapterScoped, found, widened, bookFound }))
        }
      }
    }
  })
})
