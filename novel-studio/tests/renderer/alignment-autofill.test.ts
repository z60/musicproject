/**
 * 回归 · 对轨页在「已录音但还没有排布」时不能把整章报成缺录
 * ============================================================================
 * 真机现象：第一章 87 行**全部录完**（voice_segments 87/87），对轨页却显示
 * 「缺录 87 行」。查库确认 arrangements / arrangement_items 都是 0 ——
 * 界面上的缺录计数是按「方案条目」算的，没有方案就把每一行都算成缺录。
 *
 * 修复两条：
 *   1. 缺录计数不再只看 items：有 take / 已录状态的只是「未排布」，不是缺录；
 *   2. 打开对轨页时，若本章有录音却没有方案（或方案为空），自动建默认方案并自动排布 ——
 *      只在「空方案」时跑，绝不覆盖用户已经排好的时间线。
 *
 * 这里用**源码级断言**守这两条：渲染侧 store 依赖 window.api / pinia，Node 环境里
 * 起不来（与 tests/renderer 下其它 store 相关测试同一取舍）。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STORE = readFileSync(
  join(ROOT, 'src/renderer/src/features/alignment/stores/arrangement.store.ts'),
  'utf8',
)

describe('对轨页 · 缺录判定与自动排布', () => {
  it('缺录计数把「有 take / 已录状态」排除，不再只看方案条目', () => {
    const start = STORE.indexOf('const missingLineCount')
    assert.ok(start >= 0, '找不到 missingLineCount')
    const block = STORE.slice(start, start + 900)
    assert.match(block, /takeByLine\.value\.has\(line\.id\)/, '有 take 的行不能算缺录')
    assert.match(block, /line\.state === 'recorded'/, '已录状态的行不能算缺录')
    assert.ok(
      /hasItem\.has\(line\.id\)\) continue/.test(block),
      '已经排进方案的行仍然要先跳过',
    )
  })

  it('loadChapter 在有录音但没有方案时自动建默认方案', () => {
    assert.match(STORE, /if \(!target && takes\.value\.length > 0\)/, '缺方案且有录音要自动建')
    assert.match(STORE, /callTyped<Arrangement>\('alignment:create'/, '要真的创建方案')
  })

  it('空方案且有录音时自动排布（否则录好的片段不会出现在时间线上）', () => {
    assert.match(
      STORE,
      /if \(items\.value\.length === 0 && takes\.value\.length > 0\)/,
      '只在空方案时自动排布',
    )
    assert.match(STORE, /await autoArrange\(/, '要真的调用自动排布')
  })

  it('自动排布的条件里没有「items 非空」——绝不覆盖用户已排好的时间线', () => {
    assert.ok(
      !/items\.value\.length > 0[\s\S]{0,120}await autoArrange\(/.test(STORE),
      'items 非空时不得自动排布',
    )
  })
})
