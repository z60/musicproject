/**
 * Novel Studio · 录音上下文窗口（当前行前后各 2 行 + 当前行）
 * ============================================================================
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { buildLineContext } from '../../src/shared/canvas/context-window.ts'

const L = (...ids: string[]) => ids.map(id => ({ id }))

describe('录音上下文窗口', () => {
  const lines = L('a', 'b', 'c', 'd', 'e', 'f', 'g')

  it('中间行：前 2 + 当前 + 后 2', () => {
    const ctx = buildLineContext(lines, 3)
    assert.deepEqual(ctx.map(x => x.line.id), ['b', 'c', 'd', 'e', 'f'])
    assert.deepEqual(ctx.map(x => x.offset), [-2, -1, 0, 1, 2])
    assert.deepEqual(ctx.map(x => x.current), [false, false, true, false, false])
  })

  it('边界自动截断（首行/末行）', () => {
    assert.deepEqual(buildLineContext(lines, 0).map(x => x.line.id), ['a', 'b', 'c'])
    assert.deepEqual(buildLineContext(lines, 6).map(x => x.line.id), ['e', 'f', 'g'])
  })

  it('越界/非法下标 → 空数组', () => {
    assert.deepEqual(buildLineContext(lines, -1), [])
    assert.deepEqual(buildLineContext(lines, 7), [])
    assert.deepEqual(buildLineContext(lines, 1.5), [])
  })

  it('可自定义前后行数；0 表示只要当前行', () => {
    assert.deepEqual(buildLineContext(lines, 3, 0, 0).map(x => x.line.id), ['d'])
    assert.deepEqual(buildLineContext(lines, 3, 1, 3).map(x => x.line.id), ['c', 'd', 'e', 'f', 'g'])
  })
})
