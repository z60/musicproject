/**
 * 测试 · 「已降级为规则判定」提示的触发条件
 * ============================================================================
 * 设计依据：docs/11 §2.4、docs/91 §5.2.15（真机反馈：点开任意一章都弹提示）
 *
 * 这组测试的价值在于：**三个条件都很容易被无意改掉**，而改错的表现是
 * 「用户每点开一章就被弹一次提示」（不报错、不影响功能，所以只有真机才看得出来）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  shouldShowDegradedBadge,
  shouldWarnEmbeddingDegraded,
} from '../../src/renderer/src/shared/lib/embedding-notice.ts'

describe('降级提示 · 触发条件', () => {
  it('刚生成完且确实降级 → 弹一次', () => {
    assert.equal(
      shouldWarnEmbeddingDegraded({
        report: { chapterId: 'c1', embeddingUsed: false },
        isFresh: true,
        warnedChapterId: null,
      }),
      true,
    )
  })

  it('**打开章节看历史报告** → 不弹（真机反馈的那条）', () => {
    assert.equal(
      shouldWarnEmbeddingDegraded({
        report: { chapterId: 'c1', embeddingUsed: false },
        isFresh: false,
        warnedChapterId: null,
      }),
      false,
      '报告是历史数据：面板里有红条、工具条上有徽标，不该再弹一次打扰用户',
    )
  })

  it('同一章只弹一次；换到另一章、又刚生成完 → 可以再弹', () => {
    const fresh = { chapterId: 'c1', embeddingUsed: false }
    assert.equal(shouldWarnEmbeddingDegraded({ report: fresh, isFresh: true, warnedChapterId: 'c1' }), false)
    assert.equal(
      shouldWarnEmbeddingDegraded({
        report: { chapterId: 'c2', embeddingUsed: false },
        isFresh: true,
        warnedChapterId: 'c1',
      }),
      true,
    )
  })

  it('没有报告 / 用了向量判定 → 不弹', () => {
    assert.equal(shouldWarnEmbeddingDegraded({ report: null, isFresh: true, warnedChapterId: null }), false)
    assert.equal(
      shouldWarnEmbeddingDegraded({
        report: { chapterId: 'c1', embeddingUsed: true },
        isFresh: true,
        warnedChapterId: null,
      }),
      false,
    )
  })

  it('常驻徽标只看报告本身（历史报告也要显示）', () => {
    assert.equal(shouldShowDegradedBadge({ embeddingUsed: false }), true)
    assert.equal(shouldShowDegradedBadge({ embeddingUsed: true }), false)
    assert.equal(shouldShowDegradedBadge(null), false, '还没生成过时不显示徽标')
  })
})
