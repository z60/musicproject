/**
 * 测试 · 单例 store 的「书作用域」（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.35）：在《我陪魔神历劫》里批量生成画本 → 回书架打开另一本书 →
 * 「章节管理」顶部仍然显示那些进度卡，标题还是 `生成画本：1925adee-3bf1-4179-…`。
 *
 * 根因：`chapters.canvasTasks` 是 `chapterId → taskId` 的界面级登记，切书时不会重建；
 * 派生标题在当前书里查不到该章节，于是回退成 uuid —— 一条属于上一本书的提示，
 * 冒充成了本书的提示。
 *
 * 被测模块刻意不 import 任何项目内模块（`@/` 别名只在 Vite 里生效），因此能在 Node 里跑。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  chapterTitleOrPlaceholder,
  isBookSwitch,
  visibleCanvasTasks,
  type CanvasTaskRecord,
} from '../../src/renderer/src/shared/lib/book-scope.ts'

const task = (chapterId: string, taskId: string, bookId: string): CanvasTaskRecord => ({ chapterId, taskId, bookId })

const BOOK_A = 'book-a'
const BOOK_B = 'book-b'

describe('换书判定：只有书真的变了才清界面级状态', () => {
  it('首次加载不算换书（那时没有状态可丢）', () => {
    assert.equal(isBookSwitch(null, BOOK_A), false)
  })

  it('同一本书刷新不算换书（否则刷新一次就把提示清空了）', () => {
    assert.equal(isBookSwitch(BOOK_A, BOOK_A), false)
  })

  it('换到另一本书才算', () => {
    assert.equal(isBookSwitch(BOOK_A, BOOK_B), true)
  })
})

describe('生成画本进度卡：绝不显示非本书的提示', () => {
  const tasks: CanvasTaskRecord[] = [
    task('a1', 'task-a1', BOOK_A),
    task('a2', 'task-a2', BOOK_A),
    task('b1', 'task-b1', BOOK_B),
  ]

  it('本书只看到本书的任务（事故的直接回归）', () => {
    const shown = visibleCanvasTasks({ tasks, bookId: BOOK_B, chapterIds: ['b1'] })
    assert.deepEqual(shown.map(t => t.chapterId), ['b1'], `实际：${JSON.stringify(shown)}`)
  })

  it('标书名下也只看得到自己的（切回原书时进度卡还在）', () => {
    const shown = visibleCanvasTasks({ tasks, bookId: BOOK_A, chapterIds: ['a1', 'a2'] })
    assert.deepEqual(shown.map(t => t.chapterId), ['a1', 'a2'])
  })

  it('章节已被删除的任务不显示（任务中心仍可查看/取消）', () => {
    const shown = visibleCanvasTasks({ tasks, bookId: BOOK_A, chapterIds: ['a1'] })
    assert.deepEqual(shown.map(t => t.chapterId), ['a1'])
  })

  it('按书过滤是底线：登记属于别的书时，即使章节 id 撞上了也不显示', () => {
    // 真机事故正是「登记表里混着别的书的条目」——不能只靠「章节在不在当前列表里」兜底
    // （列表还没加载完、或章节被删除时，这个兜底是失效的）
    const foreign = [task('shared-id', 'task-x', BOOK_B)]
    const shown = visibleCanvasTasks({ tasks: foreign, bookId: BOOK_A, chapterIds: ['shared-id'] })
    assert.deepEqual(shown, [], `实际：${JSON.stringify(shown)}`)
  })

  it('还没选中书时什么都不显示', () => {
    assert.deepEqual(visibleCanvasTasks({ tasks, bookId: null, chapterIds: ['a1', 'b1'] }), [])
  })

  it('最多显示 limit 条，且取最近的（别把页面撑长）', () => {
    const many: CanvasTaskRecord[] = Array.from({ length: 9 }, (_, i) => task(`a${i}`, `task-${i}`, BOOK_A))
    const shown = visibleCanvasTasks({ tasks: many, bookId: BOOK_A, chapterIds: many.map(t => t.chapterId), limit: 6 })
    assert.equal(shown.length, 6)
    assert.deepEqual(shown.map(t => t.chapterId), ['a3', 'a4', 'a5', 'a6', 'a7', 'a8'], '应当是最近的 6 条')
  })

  it('没有任务时不报错', () => {
    assert.deepEqual(visibleCanvasTasks({ tasks: [], bookId: BOOK_A, chapterIds: [] }), [])
  })
})

describe('章节名：绝不把 uuid 显示给用户', () => {
  it('有标题就用标题', () => {
    assert.equal(chapterTitleOrPlaceholder('第一章 楔子'), '第一章 楔子')
  })

  it('查不到时给「未知章节」，而不是章节 id', () => {
    assert.equal(chapterTitleOrPlaceholder(null), '未知章节')
    assert.equal(chapterTitleOrPlaceholder(undefined), '未知章节')
    assert.equal(chapterTitleOrPlaceholder('   '), '未知章节', '空白标题也不算标题')
  })
})
