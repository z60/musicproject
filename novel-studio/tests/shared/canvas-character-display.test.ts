/**
 * Novel Studio · 说话人显示名（有 CV 显示 CV，否则角色名）
 * ============================================================================
 * 画本导入把 CV 写进角色备注（`CV：xxx｜音色：…｜年龄：…`）；绑定配音员后优先用配音员名。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  isPlaceholderCvName,
  normalizeCvName,
  parseCvFromNote,
  speakerDisplayName,
} from '../../src/shared/canvas/character-display.ts'

describe('角色备注里的 CV 解析', () => {
  it('画本导入的备注格式', () => {
    assert.equal(parseCvFromNote('CV：嬉小天｜音色：青叔音｜年龄：25'), '嬉小天')
    assert.equal(parseCvFromNote('音色：青叔音｜CV：墨澜'), '墨澜')
    assert.equal(parseCvFromNote('CV: 嬉小天'), '嬉小天')
  })

  it('没有 CV / 空备注 / null → null', () => {
    assert.equal(parseCvFromNote('音色：青叔音'), null)
    assert.equal(parseCvFromNote(''), null)
    assert.equal(parseCvFromNote(null), null)
    assert.equal(parseCvFromNote(undefined), null)
    assert.equal(parseCvFromNote('CV：'), null)
  })

  it('正文里的「CV老师」不会被误当成 CV', () => {
    assert.equal(parseCvFromNote('建议CV老师先看看下一章'), null)
  })
})

describe('说话人显示名', () => {
  it('有 CV 显示 CV，没有 CV 显示角色名', () => {
    assert.equal(speakerDisplayName('杨浩', '嬉小天'), '嬉小天')
    assert.equal(speakerDisplayName('杨浩', null), '杨浩')
    assert.equal(speakerDisplayName('杨浩', ''), '杨浩')
  })

describe('CV 名归一与占位判定（voiceActor:syncFromCanvas 用它去重）', () => {
  it('空白与大小写差异视为同一个配音员', () => {
    assert.equal(normalizeCvName('阿翼爱热闹 '), normalizeCvName('阿翼爱热闹'))
    assert.equal(normalizeCvName('阿 翼 爱 热 闹'), normalizeCvName('阿翼爱热闹'))
    assert.equal(normalizeCvName('CV-Amy'), normalizeCvName('cv-amy'))
    assert.equal(normalizeCvName(null), '')
  })

  it('占位 CV 不建配音员（否则 CV 表里全是「未知」）', () => {
    for (const name of ['未知', '未知角色', '待定', '—', '-', '暂无', 'N/A', ' ']) {
      assert.equal(isPlaceholderCvName(name), true, `${name} 应被当成占位`)
    }
    for (const name of ['阿翼爱热闹', '鱼头一颗糖', '旁白']) {
      assert.equal(isPlaceholderCvName(name), false, `${name} 是真实 CV`)
    }
  })
})
})
