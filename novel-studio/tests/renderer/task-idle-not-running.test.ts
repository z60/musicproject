/**
 * 「没有任务」不是「正在跑」—— 导出点不动的真根因（docs/91 §5.2.77）
 * ============================================================================
 * 真机反馈：「点完全部知悉后 点击导出没有反应」。
 *
 * 根因链：
 *   1. `useTaskProgress(taskId).status` 在没有任务时**默认 'queued'**；
 *   2. `isRunning` 只判 status ∈ {running,queued,waiting} ⇒ **恒为 true**；
 *   3. 导出编排的 `isBusy = starting || live.isRunning` ⇒ 永远为真；
 *   4. `start()` 开头 `if (isBusy.value) return null` ⇒ 点了「开始导出」被**静默拦下**。
 *
 * 顺带受害的还有：对轨的「预览渲染」提交按钮（`canSubmit` 依赖 !isRunning）永远点不动；
 * 离开导出页也一直被「导出正在进行」的确认框拦着。
 *
 * 源码级断言：这两个模块都 import 了 @/ 别名，测试环境加载不了。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

describe('任务进度 · 没有任务时 isRunning 必须是 false', () => {
  it('isRunning 先看「有没有任务」，再看状态', () => {
    const src = strip(readFileSync(join(ROOT, 'src/renderer/src/shared/lib/task-progress.ts'), 'utf8'))
    const from = src.indexOf('const isRunning = computed')
    assert.ok(from >= 0, '找到 isRunning')
    const seg = src.slice(from, src.indexOf('const isFinished', from))
    assert.match(seg, /state\.value === null/, '★ 缺这一句就会「没有任务也永远进行中」（status 默认 queued）')
    assert.match(seg, /'running'/, '仍然要判真实状态')
  })
})

describe('导出编排 · 不允许静默地不启动', () => {
  const src = strip(
    readFileSync(join(ROOT, 'src/renderer/src/features/mixing/composables/useExportFlow.ts'), 'utf8'),
  )

  it('start() 的每条早退都留下原因（界面上说得出来）', () => {
    const fn = src.slice(src.indexOf('async function start('), src.indexOf('async function mergeM4bOnly'))
    assert.ok(fn.length > 0, '找到 start()')
    assert.match(fn, /startBlockedReason\.value = /, '要有原因这个出口')
    assert.doesNotMatch(fn, /if \(isBusy\.value\) return null/, '★ 静默 return 就是「点了没反应」')
    assert.doesNotMatch(fn, /if \(!bookId \|\| chapterIds\.length === 0\) return null/, '★ 同理')
  })

  it('reason 会暴露给界面', () => {
    assert.match(src, /startBlockedReason,/, 'return 里要带上它')
  })
})

describe('导出向导 · 点了没启动也要有反馈', () => {
  it('onStartExport 会读 flow.startBlockedReason 并写进提示', () => {
    const src = strip(
      readFileSync(join(ROOT, 'src/renderer/src/features/mixing/views/ExportWizardView.vue'), 'utf8'),
    )
    const fn = src.slice(src.indexOf('function onStartExport'), src.indexOf('function onCancelExport'))
    assert.match(fn, /flow\.start\(\)\.then/, '要接住 start() 的结果')
    assert.match(fn, /startBlockedReason\.value/, '没启动成时必须显示原因')
    assert.match(fn, /startBlockedNotice\.value = /, '提示要真的写到界面上')
  })
})
