/**
 * 回归 · 导入向导的「项目上下文」判定（真机事故 docs/91 §5.2.4）
 * ============================================================================
 * 事故：全新安装（书架为空）时点「开始导入」，
 *   · 界面提示「还没有可用的项目上下文：…请先到书架导入或打开一本书」——而书架就是空的
 *   · 点「开始导入」得到「后台任务执行失败 / 任务「导入书籍」未能完成」
 *   · 库里 `books` / `tasks` 一行都没有（什么都没发生）
 *
 * 根因是**死锁**：契约里没有「当前项目」通道，而导入通道要求 `projectId` 必填；
 * 渲染进程只能从「已选书籍」或「书架里的书」推断项目，于是
 *
 *     导入需要项目 → 项目需要书 → 书需要导入
 *
 * 全新安装永远导入不了第一本书。而主进程启动期就已经 `ensureDefault` 建好了默认项目
 * （真机日志 `book.project.ready {"projectId":"default"}`），项目本就是**基础设施**而非
 * 用户可见概念（见 project.repo.ts 头部的论证）—— 渲染进程只是从没被告知过它。
 *
 * 这些用例锁的正是那条判定规则，尤其是**第 3 条**（书架为空 → 默认项目）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { DEFAULT_PROJECT_ID } from '../../src/shared/constants.ts'
import { decideProjectContext } from '../../src/renderer/src/shared/lib/project-context.ts'

const book = (title: string, projectId: string | null) => ({ title, projectId })

describe('项目上下文 · 三级优先级', () => {
  it('① 已选中书籍 → 用它所属的项目，且无需提示', () => {
    const d = decideProjectContext({
      sessionProjectId: 'proj-a',
      books: [book('别的书', 'proj-b')],
    })
    assert.equal(d.projectId, 'proj-a', '选中的书优先于书架里的第一本')
    assert.equal(d.hint, '', '正常路径不该打扰用户')
  })

  it('② 未选中但有书 → 用书架里第一本带项目的书，并说明来源', () => {
    const d = decideProjectContext({
      sessionProjectId: null,
      books: [book('斗破苍穹', 'proj-b'), book('另一本', 'proj-c')],
    })
    assert.equal(d.projectId, 'proj-b')
    assert.match(d.hint, /斗破苍穹/, '提示里要写清是哪本书，用户才知道为什么')
  })

  it('③ **书架为空 → 落到默认项目**（这条就是本 bug 的修复点）', () => {
    const d = decideProjectContext({ sessionProjectId: null, books: [] })
    assert.equal(d.projectId, DEFAULT_PROJECT_ID)
    assert.notEqual(d.projectId, null, '绝不能再返回 null —— 那会让整个导入流程死锁')
    assert.ok(d.hint.length > 0, '要告诉用户这本书进了默认项目，而不是静默处理')
  })
})

describe('项目上下文 · 边界与脏数据', () => {
  it('books 里有 projectId 为 null 的书 → 跳过它，继续找下一本', () => {
    const d = decideProjectContext({
      sessionProjectId: null,
      books: [book('坏数据', null), book('正常的书', 'proj-b')],
    })
    assert.equal(d.projectId, 'proj-b')
  })

  it('所有书的 projectId 都是 null → 仍然落到默认项目（而不是 null）', () => {
    const d = decideProjectContext({
      sessionProjectId: null,
      books: [book('坏数据一', null), book('坏数据二', null)],
    })
    assert.equal(d.projectId, DEFAULT_PROJECT_ID)
  })

  it('空串 / 全空白的 projectId 等同于缺失', () => {
    const d = decideProjectContext({
      sessionProjectId: '   ',
      books: [book('空白项目', '  ')],
    })
    assert.equal(d.projectId, DEFAULT_PROJECT_ID, '空白 id 不能当成有效项目传给主进程')
  })

  it('列表为空也不是「没有上下文」——返回值永远是可用字符串', () => {
    for (const input of [
      { sessionProjectId: null, books: [] },
      { sessionProjectId: null, books: [book('x', null)] },
    ]) {
      const d = decideProjectContext(input)
      assert.equal(typeof d.projectId, 'string')
      assert.ok(d.projectId.trim().length > 0)
    }
  })
})

describe('项目上下文 · 与主进程的约定一致', () => {
  it('默认项目 id 与主进程 ensureDefault 用的是同一个常量', async () => {
    // 单一来源：main 的 project.repo.ts 从 shared/constants.ts 取，不再各写一份字面量。
    // 这里直接读源码断言，防止有人在 main 侧偷偷改回字面量。
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/main/features/book/import/repositories/project.repo.ts', 'utf8')
    assert.match(src, /import \{ DEFAULT_PROJECT_ID \} from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/constants\.ts'/)
    assert.ok(
      !/export const DEFAULT_PROJECT_ID = ['"]/.test(src),
      'main 侧不得再自己定义一份默认项目 id 字面量',
    )
  })
})
