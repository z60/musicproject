/**
 * 测试 · 开发期「热更新没同步」提示
 * ============================================================================
 * 设计依据：docs/91 §5.2.16
 *
 * 守两件事：
 *   1. 「模块绑定失败」类报错在**开发模式**下给出可行动提示（刷新页面试一次）
 *   2. **真实代码缺陷不顺带被掩盖**：TDZ（`Cannot access 'x' before initialization`）
 *      与普通业务报错都不给这个提示 —— 它们刷新也不会消失，属于代码问题。
 *      生产构建里一律不出现（用户看不到开发提示）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { staleModuleHint } from '../../src/renderer/src/shared/lib/stale-module-hint.ts'

describe('开发期提示 · 只在「模块没同步」时报', () => {
  it('开发模式下：漏绑定/模块解析失败 → 给提示，且写清「刷新即可 / 仍报才是代码问题」', () => {
    for (const message of [
      'shouldWarnEmbeddingDegraded is not defined',
      'The requested module "/x.ts" does not provide an export named "foo"',
      'Failed to fetch dynamically imported module: http://localhost:5173/src/x.vue',
    ]) {
      const hint = staleModuleHint({ message, isDev: true })
      assert.ok(hint, `应给提示：${message}`)
      assert.ok(hint.includes('刷新'), '提示必须告诉用户先刷新')
      assert.ok(hint.includes('代码问题'), '提示必须说明「刷新后仍报才是代码问题」，否则会掩盖真 bug')
    }
  })

  it('TDZ（真实代码缺陷）**不给**这个提示', () => {
    const hint = staleModuleHint({ message: "Cannot access 'playing' before initialization", isDev: true })
    assert.equal(hint, null, 'TDZ 是代码 bug（有 check:setup-order 静态拦截），不能说成「刷新就好」')
  })

  it('普通业务报错与生产构建都不给提示', () => {
    assert.equal(staleModuleHint({ message: '文件不存在', isDev: true }), null)
    assert.equal(staleModuleHint({ message: 'foo is not defined', isDev: false }), null, '生产环境不展示开发提示')
    assert.equal(staleModuleHint({ message: '', isDev: true }), null)
  })
})
