/**
 * Novel Studio · 「说话人（CV）」「角色名」两列下拉选项（纯逻辑）
 * ============================================================================
 * 覆盖真机反馈：「画本编辑的主视图里说话人需要选择 CV，角色需要选择角色名」。
 * 两条口径必须有测试钉住，否则界面一改就会悄悄退化回「只有角色名」。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  buildCvPickerOptions,
  buildRolePickerOptions,
  filterSpeakerOptions,
} from '../../src/shared/canvas/speaker-options.ts'

const CHARACTERS = [
  { id: 'c-pb', name: '旁白' },
  { id: 'c-fyh', name: '方艺华', aliases: ['小花'] },
  { id: 'c-syw', name: '苏幼薇' },
  { id: 'c-lm', name: '路人甲' },
]
const ACTORS = [
  { id: 'a-yxc', name: '语心草' },
  { id: 'a-tyk', name: '鱼头一颗糖' },
  { id: 'a-idle', name: '还没接活的人' },
]
const BINDINGS = [
  { characterId: 'c-fyh', actorId: 'a-yxc', isPrimary: true },
  { characterId: 'c-syw', actorId: 'a-yxc' },
  { characterId: 'c-pb', actorId: 'a-tyk', isPrimary: true },
]

describe('说话人（CV）列的下拉选项', () => {
  it('一个 CV 一个角色 → 标签就是 CV 名，说明里带角色名', () => {
    const options = buildCvPickerOptions({ characters: CHARACTERS, bindings: BINDINGS, actors: ACTORS })
    const single = options.find((o) => o.label === '鱼头一颗糖')
    assert.equal(single?.hint, '旁白', '「鱼头一颗糖」到底是哪个角色，必须在选项里写清')
    assert.equal(single?.group, 'narration')
    assert.equal(single?.characterId, null, '旁白选项的值必须是 null（否则说话人会从旁白变成角色）')
  })

  it('一个 CV 多个角色 → 每个角色一条「CV（角色名）」（否则选了 CV 也不知道是哪个角色）', () => {
    const options = buildCvPickerOptions({ characters: CHARACTERS, bindings: BINDINGS, actors: ACTORS })
    // CV 按名字排序（ICU：鱼 yú 在 语 yǔ 之前）
    assert.deepEqual(
      options.map((o) => o.label),
      ['鱼头一颗糖', '语心草（方艺华）', '语心草（苏幼薇）', '路人甲'],
    )
    assert.deepEqual(
      options.map((o) => o.characterId),
      [null, 'c-fyh', 'c-syw', 'c-lm'],
      '旁白那条的值是 null，其余是角色 id',
    )
  })

  it('没有 CV 的角色也列出来（写成角色名 + 未绑定 CV），否则这些行在 CV 列里选不到', () => {
    const options = buildCvPickerOptions({ characters: CHARACTERS, bindings: BINDINGS, actors: ACTORS })
    const unbound = options.find((o) => o.characterId === 'c-lm')
    assert.equal(unbound?.label, '路人甲')
    assert.equal(unbound?.hint, '未绑定 CV')
  })

  it('没接过活的 CV 不出现在列表里；书里已有「旁白」角色时不再单列无角色的旁白', () => {
    const options = buildCvPickerOptions({ characters: CHARACTERS, bindings: BINDINGS, actors: ACTORS })
    assert.ok(!options.some((o) => o.label.includes('还没接活')), '没有任何角色的 CV 选了也没用')
    // 旁白由「鱼头一颗糖」负责 → 它出现在 CV 那一条里（hint=旁白），不再多出一条裸的「旁白」
    assert.equal(options.filter((o) => o.characterId === null).length, 1, '旁白只有一条（值为 null）')
    assert.equal(options.filter((o) => o.hint === '旁白').length, 1, '旁白只出现一次')
  })

  it('书里还没有「旁白」角色时，旁白回落成 characterId=null', () => {
    const options = buildCvPickerOptions({ characters: CHARACTERS.slice(1), bindings: BINDINGS, actors: ACTORS })
    const pb = options.find((o) => o.characterId === null)
    assert.equal(pb?.label, '旁白')
    assert.equal(pb?.group, 'narration')
  })
})

describe('角色名列的下拉选项', () => {
  it('旁白排最前，其余按角色表顺序；别名进 hint 与搜索', () => {
    const options = buildRolePickerOptions({ characters: CHARACTERS })
    assert.deepEqual(options.map((o) => o.label), ['旁白', '方艺华', '苏幼薇', '路人甲'])
    assert.equal(options.find((o) => o.label === '方艺华')?.hint, '小花')
    assert.equal(filterSpeakerOptions(options, '小花').map((o) => o.label).join(), '方艺华')
  })

  it('没有「旁白」角色时补一条 characterId=null 的旁白', () => {
    const options = buildRolePickerOptions({ characters: CHARACTERS.slice(1) })
    assert.deepEqual(options.map((o) => o.label), ['旁白', '方艺华', '苏幼薇', '路人甲'])
    assert.equal(options[0]!.characterId, null)
  })
})

describe('选项搜索', () => {
  it('空关键字原样返回；CV 与角色名都能搜到（含「CV（角色）」这种复合标签）', () => {
    const options = buildCvPickerOptions({ characters: CHARACTERS, bindings: BINDINGS, actors: ACTORS })
    assert.equal(filterSpeakerOptions(options, '  ').length, options.length)
    assert.deepEqual(
      filterSpeakerOptions(options, '语心草').map((o) => o.characterId),
      ['c-fyh', 'c-syw'],
    )
    assert.deepEqual(
      filterSpeakerOptions(options, '苏幼薇').map((o) => o.characterId),
      ['c-syw'],
      '搜角色名也要能搜到（界面上的标签是「语心草（苏幼薇）」）',
    )
  })
})
