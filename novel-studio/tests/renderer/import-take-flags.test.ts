/**
 * 测试 · 导入的 take 标记必须在界面上「看得见」（docs/91 §5.2.74）
 * ============================================================================
 * 真机复报（2221 章旁白第 13 行）：「音频和文本错误」。
 *
 * 查库后的事实：那一行的文字在录音里**根本没念**（或者被识别整个漏掉），
 * 导入只能按字数硬切一小段**占位音**，并在 take 上打了 `import-needs-review` ——
 * 但这个标记在录音页从来没有被渲染过：
 *
 *   · `TakeList` 只用 `TAKE_FLAG_PRESETS` 查标签，而 `import-needs-review` 不在里面
 *     → 徽章显示成英文原始键，或者（当时）什么都没显示；
 *   · 用户于是只能看到「这一行的音频不是我这句话」，无从知道「这行音频本来就是个占位」。
 *
 * 这组是**源码级**约束（.vue + Pinia store 在 Node 里实例化不了），
 * 与 `record-start.test.ts` 同一套做法：读源码做断言，可反向验证。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const STORE = join(process.cwd(), 'src/renderer/src/features/recording/stores/takes.store.ts')
const TAKE_LIST = join(process.cwd(), 'src/renderer/src/features/recording/components/TakeList.vue')
const FLAGS_PANEL = join(process.cwd(), 'src/renderer/src/features/recording/components/TakeFlagsPanel.vue')

/** 剥掉块注释与行注释（注释里会引用「错误写法」本身） */
function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

describe('导入标记 · 系统标记要有中文标签与说明', () => {
  const src = strip(readFileSync(STORE, 'utf8'))

  it('SYSTEM_TAKE_FLAGS 覆盖 imported / import-needs-review，且说明写清后果', () => {
    assert.match(src, /SYSTEM_TAKE_FLAGS/, '要有「系统标记」这张表（不进用户可打的预置列表）')
    assert.match(src, /key:\s*'imported'/, '导入切片标记要有标签')
    assert.match(src, /key:\s*'import-needs-review'/, '需确认标记要有标签')
    const seg = src.slice(src.indexOf('SYSTEM_TAKE_FLAGS'))
    assert.match(seg, /label:\s*'[^']*[\u4e00-\u9fa5][^']*'/, '标签必须是中文（英文原始键等于没解释）')
    assert.match(seg, /hint:\s*\n?\s*'[^']*(识别|试听|相邻)/, '说明里要写清「识别没对上、可能带进相邻台词」')
  })

  it('takeFlagLabel / takeFlagHint 先查用户预置，再查系统标记', () => {
    const label = src.slice(src.indexOf('export function takeFlagLabel'), src.indexOf('export function takeFlagHint'))
    assert.match(label, /TAKE_FLAG_PRESETS\.find/, '用户手打的预置优先')
    assert.match(label, /SYSTEM_TAKE_FLAGS\.find/, '预置里没有的（导入标记）要走系统标记表')
    assert.match(label, /\?\?\s*flag/, '两张表都没有时才原样显示')
  })
})

describe('导入标记 · 录音页必须渲染它', () => {
  it('TakeList 用 takeFlagLabel / takeFlagHint，而不是只查预置表', () => {
    const src = strip(readFileSync(TAKE_LIST, 'utf8'))
    assert.match(src, /takeFlagLabel\(flag\)/, '徽章文字走统一取标签函数')
    assert.match(src, /takeFlagHint\(flag\)/, '悬停说明同样')
    assert.doesNotMatch(
      src,
      /TAKE_FLAG_PRESETS\.find\([^)]*\)\?\.label/,
      '★ 只查预置表会让导入标记显示成英文原始键（真机就是这么看不见的）',
    )
    assert.match(src, /isSevereTakeFlag\(flag\)/, '需要处理的标记要标红')
  })

  it('TakeFlagsPanel 的标签/说明/严重度也走同一套函数', () => {
    const src = strip(readFileSync(FLAGS_PANEL, 'utf8'))
    assert.match(src, /return takeFlagLabel\(flag\)/)
    assert.match(src, /return takeFlagHint\(flag\)/)
    assert.match(src, /return isSevereTakeFlag\(flag\)/)
  })
})
