/**
 * 测试 · 录音起点：倒计时返回值必须被兑现 + 会话镜像必须随新会话清零
 * ============================================================================
 * 真机事故 docs/91 §5.2.45（两条都是「界面静默失灵」类）：
 *
 *  1. `useRecordCountdown.request(totalMs)` 的契约：`totalMs <= 0` 返回 **false**，
 *     意思是「不需要倒计时，调用方必须**立即**开录」。两个录音视图都忽略了返回值 →
 *     用户把倒计时设为 0（想跳过等待）后，点「录制」**完全没反应**（真机复现）。
 *
 *  2. `recording.store` 的 `setSession()` 不清零 `durationMs / framesWritten /
 *     droppedFrames`（它们是 `applyStatus` 的 **max 合并**，`reset()` 又只在放弃时调用）
 *     → 第二段开始瞬间 `durationMs` 还带着上一段的值，「录满 3 秒仍无信号」检查在
 *     t=0 误触发（真机日志：每条会话开头都有一条 `recording.noSignal`）。
 *
 * 这组是**源码级**约束（两个视图是 .vue、store 依赖 Pinia，无法在 Node 里实例化），
 * 与 `record-pipe.test.ts` 同一套做法：剥注释后做断言，并支持「故意打破」反向验证。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const REC_VIEW = join(process.cwd(), 'src/renderer/src/features/recording/views/RecordingView.vue')
const TASK_VIEW = join(process.cwd(), 'src/renderer/src/features/recording/views/TaskRecordingView.vue')
const STORE = join(process.cwd(), 'src/renderer/src/features/recording/stores/recording.store.ts')

/** 剥掉块注释与行注释（注释里会引用"错误写法"本身，必须先剥再断言，否则守卫假红） */
function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

describe('录音起点 · 倒计时返回值必须被兑现（docs/91 §5.2.45）', () => {
  it('RecordingView：countdown.request 的返回值要接住，false = 立即开录', () => {
    const src = strip(readFileSync(REC_VIEW, 'utf8'))
    assert.match(src, /const\s+counting\s*=\s*countdown\.request\(/, '必须接收返回值')
    assert.match(src, /if\s*\(!counting\)\s*(?:void\s+)?beginRecording\(\)/, 'false 时必须立即开录（0 秒倒计时 = 点录制即开始）')
  })

  it('TaskRecordingView：同一个坑，同样要接住', () => {
    const src = strip(readFileSync(TASK_VIEW, 'utf8'))
    assert.match(src, /const\s+counting\s*=\s*countdown\.request\(/, '必须接收返回值')
    assert.match(src, /if\s*\(!counting\)\s*(?:void\s+)?beginRecording\(\)/, 'false 时必须立即开录')
  })
})

describe('录音起点 · 会话镜像必须随新会话清零（docs/91 §5.2.45）', () => {
  it('setSession 里 durationMs / framesWritten / droppedFrames 必须归零', () => {
    const src = strip(readFileSync(STORE, 'utf8'))
    const seg = src.slice(src.indexOf('function setSession'), src.indexOf('function setLine'))
    assert.ok(seg.length > 0, 'setSession 存在')
    assert.match(seg, /durationMs\.value\s*=\s*0/, 'durationMs 必须归零（max 合并 + reset 只在放弃时调用，会串段）')
    assert.match(seg, /framesWritten\.value\s*=\s*0/, 'framesWritten 必须归零')
    assert.match(seg, /droppedFrames\.value\s*=\s*0/, 'droppedFrames 必须归零')
  })
})
