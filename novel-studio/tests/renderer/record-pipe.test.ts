/**
 * 测试 · 录音音频通道的接线（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.41）：录音「能开始、电平在动、就是录不进去」，停止时报
 * 「丢帧 135,936 帧」，而那一行永远存不下来。真库/日志证据：
 *
 *     recording_sessions 9 条全部 status=aborted、duration_ms=0、0 个 take
 *     record.frameGap {claimed:2304, written:0, pending:0}   ← 738 次
 *     record.tooShort  {durationMs:0}                        ← 12 次
 *
 * 根因：**渲染进程建的 MessagePort 过不了 contextBridge**。
 * 原来是「渲染进程 `new MessageChannel()` → 把 port2 交给 preload →
 * preload `ipcRenderer.postMessage('record:port', null, [port2])`」，
 * 而包装过的 port 放进 transfer 列表转移不出去 —— 主进程那边既没有
 * `record.portAttached` 也没有 `record.portMissing`（消息压根没到），
 * 于是渲染进程照常"录"，盘上一个字节都不写。而且 `record:attachPort` 的失败
 * 被 `callSafe` 吞掉，界面上没有任何解释。
 *
 * 这组测试是**源码级**约束（渲染层没有运行期单测的条件），钉住三件事：
 *   1. 端口只能在 preload 侧建（渲染进程不许再 new MessageChannel）；
 *   2. 渲染进程只通过 `attachRecordPort()/sendRecordPcm()` 这两个白名单方法送样本；
 *   3. 通道建立失败**不许静默**：必须失败即中止（不能再出现 callSafe 那种吞错写法）。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const RECORDER = join(process.cwd(), 'src/renderer/src/features/recording/composables/useRecorder.ts')
const PRELOAD = join(process.cwd(), 'src/preload/index.ts')

/**
 * 读源码并剥掉「注释」与「worklet 模板字符串」。
 *
 * 必须剥，否则约束会被合法的东西误伤（第一版就是这样假红的）：
 *   · 注释里写着事故经过（`new MessageChannel()`）→ 误判成"渲染进程还在建端口"
 *   · `PCM_CAPTURE_WORKLET_SOURCE` 里的 `this.port.postMessage({type:'pcm'})`
 *     是 AudioWorklet 处理器**自己**往外吐块，跟渲染进程送样本完全是两件事
 */
function readCode(path: string): string {
  let code = readFileSync(path, 'utf8')
  // worklet 源码：从 "export const PCM_CAPTURE_WORKLET_SOURCE = `" 到收尾的反引号
  code = code.replace(/(export const PCM_CAPTURE_WORKLET_SOURCE\s*=\s*`)[\s\S]*?(`\n)/, '$1$2')
  code = code.replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
  code = code.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1') // 行注释（避开 https:// 之类）
  return code
}

describe('录音音频通道 · 端口必须由 preload 创建', () => {
  it('渲染进程不再自己建 MessageChannel（它转移不出去）', () => {
    const recorder = readCode(RECORDER)
    assert.ok(
      !/new MessageChannel\s*\(/.test(recorder),
      '渲染进程 new 出来的 MessagePort 过 contextBridge 后无法转移 —— 主进程永远收不到端口（docs/91 §5.2.41）',
    )
  })

  it('渲染进程只用两个白名单方法送样本', () => {
    const recorder = readCode(RECORDER)
    assert.match(recorder, /attachRecordPort\(\)/, '建立通道必须调用无参的 attachRecordPort()')
    assert.match(recorder, /sendRecordPcm!?\(/, '样本必须经 sendRecordPcm 交给 preload')
    assert.ok(!/\.postMessage\(\s*\{[^}]*type:\s*'pcm'/.test(recorder), '渲染进程不该再自己 postMessage 送 PCM')
  })

  it('preload 侧确实建了通道并把它转移给主进程', () => {
    const preload = readCode(PRELOAD)
    assert.match(preload, /new MessageChannel\(\)|createPortChannel/, '通道要在 preload 侧创建')
    assert.match(preload, /postMessage!?\(\s*'record:port'/, "端口要经 ipcRenderer.postMessage('record:port') 转移")
  })
})

describe('录音音频通道 · 建立失败不许静默', () => {
  it('record:attachPort 不能再用 callSafe 吞掉失败', () => {
    const recorder = readCode(RECORDER)
    assert.ok(
      !/callSafe\(\s*'record:attachPort'/.test(recorder),
      'attachPort 失败必须浮出来并中止录制：以前 callSafe 吞掉它，界面照常"录制中"但永远写不进盘',
    )
    assert.match(recorder, /attachPortWithRetry/, '并要容忍端口与归属两条 IPC 的到达顺序')
  })

  it('通道/附加失败时会放弃会话（不留空文件、不留空记录）', () => {
    const recorder = readCode(RECORDER)
    assert.match(recorder, /abortSession\(/, '失败路径必须 record:abort 并 store.reset()')
    assert.match(recorder, /RECORD_CAPTURE_UNAVAILABLE/, '失败要有精确错误码，不能是 INTERNAL 兜底')
  })

  it('录制中途通道掉线要精确报错（不能继续"静默转发"）', () => {
    const recorder = readCode(RECORDER)
    assert.match(recorder, /forwardBlock\(/, '送样本要经统一的转发函数')
    assert.match(recorder, /try\s*\{[\s\S]*?sendPcm\(/, 'sendPcm 必须被 try/catch 包住（contextBridge 边界可能抛）')
    assert.match(recorder, /pipeLostReported/, '掉线只报一次（否则每 50 ms 一条错误）')
    assert.match(recorder, /recording\.pcmPipeLost/, '掉线要有自己的日志事件名，便于检索')
  })

  /**
   * 真机事故 docs/91 §5.2.44：`claimedFrames` 是**本会话**的累计值，主进程拿它和
   * 本会话已落盘帧数相减算丢帧。不在建通道时清零，第二段录音一开口就会声称
   * "发了上一段那么多帧"，于是弹出巨大的假丢帧 —— 现场数字恰好等于上一段的帧数。
   */
  it('每个会话开始时必须把转投计数清零（否则第二段录音会报假丢帧）', () => {
    const recorder = readCode(RECORDER)
    const attach = recorder.slice(recorder.indexOf('function attachRecordPipe'))
    const body = attach.slice(0, attach.indexOf('\n  }'))
    assert.match(body, /forwardedFrames\.value\s*=\s*0/, 'attachRecordPipe 里必须把 forwardedFrames 清零')
    assert.match(body, /forwardedBlocks\.value\s*=\s*0/, 'forwardedBlocks 也要清零')
  })
})
