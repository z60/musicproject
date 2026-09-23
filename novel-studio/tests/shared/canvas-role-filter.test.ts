/**
 * Novel Studio · 画本行按角色筛选（录音「按角色录制」）
 * ============================================================================
 * 覆盖三种口径与边界：全部 / 只旁白 / 只某角色；未指定角色的行不会被任何角色选中。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  ROLE_FILTER_ALL,
  ROLE_FILTER_NARRATION,
  filterLinesByRole,
} from '../../src/shared/canvas/role-filter.ts'

const N = (id: string) => ({ speakerType: 'narration', characterId: null, id })
const C = (id: string, characterId: string) => ({ speakerType: 'character', characterId, id })

describe('画本行按角色筛选', () => {
  const lines = [
    N('n1'),
    C('a1', 'yang'),
    C('b1', 'li'),
    N('n2'),
    C('a2', 'yang'),
    { speakerType: 'character', characterId: null, id: 'u1' },
  ]

  it('all：全部行', () => {
    assert.equal(filterLinesByRole(lines, ROLE_FILTER_ALL).length, lines.length)
  })

  it('narration：只旁白', () => {
    assert.deepEqual(filterLinesByRole(lines, ROLE_FILTER_NARRATION).map(l => l.id), ['n1', 'n2'])
  })

  it('按 characterId：只该角色（不含旁白、不含未指定）', () => {
    assert.deepEqual(filterLinesByRole(lines, 'yang').map(l => l.id), ['a1', 'a2'])
  })

  it('不认识的 characterId → 空数组（不会退化成全部）', () => {
    assert.deepEqual(filterLinesByRole(lines, 'nobody').map(l => l.id), [])
  })

  it('不改原数组', () => {
    const before = lines.map(l => ({ ...l }))
    filterLinesByRole(lines, 'yang')
    assert.deepEqual(lines, before)
  })
})
