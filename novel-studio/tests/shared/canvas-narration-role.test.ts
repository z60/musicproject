/**
 * Novel Studio · 「旁白」角色名识别（voiceActor:syncFromCanvas / 质检 / 分工负载的共用口径）
 * ============================================================================
 * 旁白在角色表里有一行（为了能挂 CV 绑定），但旁白行的 `character_id` 恒为 null。
 * 名字识别必须**归一化**：画本表格里可能写成「旁 白」。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  isNarrationRoleName,
  NARRATION_ROLE_NAME,
  NARRATION_ROLE_NOTE,
  NARRATION_ROLE_SORT_ORDER,
} from '../../src/shared/canvas/narration-role.ts'

describe('旁白角色识别', () => {
  it('常量本身与归一化写法都认（空白 / 大小写不敏感）', () => {
    assert.equal(isNarrationRoleName(NARRATION_ROLE_NAME), true)
    assert.equal(isNarrationRoleName(' 旁白 '), true)
    assert.equal(isNarrationRoleName('旁 白'), true)
  })

  it('普通角色名不是旁白', () => {
    for (const name of ['萧炎', '旁白甲', '旁白配音员', 'Narrator', '', null, undefined]) {
      assert.equal(isNarrationRoleName(name), false, `${String(name)} 不该被当成旁白角色`)
    }
  })

  it('系统备注与排序常量是稳定的（用户会看到备注）', () => {
    assert.equal(NARRATION_ROLE_NOTE, '系统角色：整本书的旁白')
    assert.ok(NARRATION_ROLE_SORT_ORDER < 0, '旁白排在角色表最前')
  })
})
