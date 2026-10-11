/**
 * 导出向导 Step 6 · 「开始导出」不能点了没反应（防回归，源码级）
 * ============================================================================
 * 真机反馈（docs/91 §5.2.76）：
 *
 *   1. 「预检报告里 全部已知悉这个点的位置没有」—— 「全部已知悉」只长在报告里
 *      警告块的表头，而用户站在页脚的「开始导出」旁边找不到可点的东西；
 *   2. 「点击开始导出没有反应」—— 按钮是 disabled，点了什么都不会发生，
 *      页脚只有一句泛泛的「请先完成预检，并处理全部阻断项、确认全部警告」。
 *
 * 修法：把预检的**真实状态**摊到页脚（阻断项 N / 未确认警告 N / 参数变动作废），
 * 并在旁边放「全部已知悉」「开始预检」两个快捷动作；「开始导出」保持可点，
 * 被挡住时由 onStartExport 明确说明差什么。
 *
 * 视图依赖 @/ 别名，测试环境解析不了 —— 与 mixing-payload-safety.test.ts 同一套源码级做法。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 剥掉块注释与行注释（注释里会引用「错误写法」本身，必须先剥再断言） */
function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

function view(): string {
  return readFileSync(join(ROOT, 'src/renderer/src/features/mixing/views/ExportWizardView.vue'), 'utf8')
}

describe('导出向导 · 页脚必须说清「还差什么」', () => {
  it('exportGate 覆盖三种状态（没预检 / 阻断项 / 未确认警告）', () => {
    const src = strip(view())
    const gate = src.slice(src.indexOf('const exportGate'), src.indexOf('const hadPreCheck'))
    assert.ok(gate.length > 0, '找到 exportGate')
    assert.match(gate, /action: 'run'/, '没预检结果时要给「开始预检」')
    assert.match(gate, /action: 'ackAll'/, '有未确认警告时要给「全部已知悉」')
    assert.match(gate, /qc\.blockers\.length/, '阻断项要说数量')
    assert.match(gate, /qc\.pendingWarnings\.length/, '未确认警告要说数量')
  })

  it('页脚同时渲染状态与快捷动作（含「全部已知悉」）', () => {
    const src = strip(view())
    const foot = src.slice(src.indexOf('ns-wiz__foot-issues'), src.indexOf('ns-wiz__foot-actions'))
    assert.match(foot, /exportGate/, '页脚要读 exportGate')
    assert.match(foot, /全部已知悉/, '★ 页脚必须有「全部已知悉」（真机：找不到这个动作点）')
    assert.match(foot, /onAcknowledgeAll/, '按钮要真的接到动作上')
    assert.match(foot, /开始预检/, '没有预检结果时要有「开始预检」')
    assert.match(foot, /startBlockedNotice/, '被挡住时的提示要显示出来')
  })

  it('「开始导出」不再用 canGoNext 禁用（否则点了没反应）', () => {
    const src = strip(view())
    const start = src.indexOf('v-if="store.step === 6"')
    // 切到该按钮元素的结尾：:title 里也含「开始导出」，不能用它当右界
    const btn = src.slice(start, src.indexOf('</el-button>', start))
    assert.ok(btn.length > 0, '找到 Step 6 的按钮')
    assert.doesNotMatch(btn, /:disabled="!canGoNext"/, '★ disabled 会让点击毫无反馈')
    assert.match(btn, /:disabled="!ffmpegReady"/, '只保留「环境不具备」这一种硬禁用')
    assert.match(btn, /@click="onStartExport"/)
  })

  it('onStartExport 被挡住时给出明确反馈，而不是静默返回', () => {
    const src = strip(view())
    const fn = src.slice(src.indexOf('function onStartExport'), src.indexOf('function onCancelExport'))
    assert.ok(fn.length > 0, '找到 onStartExport')
    assert.match(fn, /exportGate\.value/, '先看门槛')
    assert.match(fn, /startBlockedNotice\.value = /, '被挡住时要写下明确提示')
    assert.match(fn, /flow\.start\(\)/, '放行时才真的开始导出')
  })
})

describe('预检报告 · 「已悉」集合的键必须成对', () => {
  it('acknowledgeAll 与 pendingWarnings 用同一个键函数（否则点了全部已知悉仍算未确认）', () => {
    const src = strip(
      readFileSync(join(ROOT, 'src/renderer/src/features/mixing/stores/qc.store.ts'), 'utf8'),
    )
    const all = src.slice(src.indexOf('function acknowledgeAll'), src.indexOf('function isAcknowledged'))
    assert.match(all, /qcIssueKey\(w, 'warning'\)/, '全部已知悉要按同一个键写入')
    const pending = src.slice(src.indexOf('const pendingWarnings'), src.indexOf('const canProceed'))
    assert.match(pending, /qcIssueKey\(w, 'warning'\)/, '未确认判定要用同一个键')
  })
})

describe('预检报告 · 「全部已知悉」入口', () => {
  it('报告里的警告块表头有「全部已知悉」，且接到 qc.acknowledgeAll', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/features/mixing/components/QcPreCheckPanel.vue'),
      'utf8',
    )
    assert.match(src, /qc\.acknowledgeAll\(\)/, '报告里的按钮要接 acknowledgeAll')
    assert.match(src, /pendingWarnings\.length/, '只在还有未确认警告时显示')
  })
})
