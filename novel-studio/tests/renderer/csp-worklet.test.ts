/**
 * 测试 · 采集工作线程与 CSP 的耦合（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.40）：「录音点录制→有倒计时→但音录制不进去」。
 * 真库里有 **9 个录音会话全部 0 时长、status=aborted、0 个 take**；同日还弹过
 * 「发生了未预期的错误 / 原因链：`AbortError: The user aborted a request.`」。
 *
 * 根因是一条**跨文件的耦合**：采集用的 AudioWorklet 处理器是这样加载的 ——
 *
 *     Blob(源码) → URL.createObjectURL → audioWorklet.addModule(blob:…)
 *
 * 而渲染进程的 CSP 写的是 `script-src 'self'`（**没有 blob:**）→ addModule 被拦截 →
 * Chromium 报的却是 `AbortError`（看着像"用户取消"）→ 采集图建不起来 →
 * `prepare()` 立刻 `record:abort` → 会话全是 0 时长，而界面上没有一句指向 CSP 的提示。
 *
 * 这类「A 文件的写法要求 B 文件的配置」最容易在重构里断掉，所以钉成源码级断言：
 *   1. 从 blob URL 加载 worklet ⇒ CSP 的 script-src 必须允许 blob:；
 *   2. 同时不许顺手放开 unsafe-inline / unsafe-eval（放开就等于把 CSP 白设了）；
 *   3. worklet 加载失败必须包成 `RECORD_CAPTURE_UNAVAILABLE`（精确报错），
 *      不能让它以 AbortError 的身份被当成"取消"静默吞掉。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const INDEX_HTML = join(process.cwd(), 'src/renderer/index.html')
const RECORDER = join(process.cwd(), 'src/renderer/src/features/recording/composables/useRecorder.ts')

/** 取出 `<meta http-equiv="Content-Security-Policy" content="...">` 里的策略文本 */
function readCsp(): string {
  const html = readFileSync(INDEX_HTML, 'utf8')
  const match = /http-equiv="Content-Security-Policy"[\s\S]*?content="([\s\S]*?)"/.exec(html)
  assert.ok(match, 'index.html 里必须有 CSP meta')
  return match[1]!.replace(/\s+/g, ' ').trim()
}

function directive(csp: string, name: string): string {
  const part = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `) || s === name)
  return part ?? ''
}

describe('采集工作线程（AudioWorklet）与 CSP', () => {
  it('从 blob URL 加载 worklet ⇒ script-src 必须允许 blob:', () => {
    const recorder = readFileSync(RECORDER, 'utf8')
    const usesBlobWorklet = recorder.includes('createObjectURL') && recorder.includes('addModule')
    assert.ok(usesBlobWorklet, '前提变了：采集处理器不再从 Blob URL 加载，请同步检查 CSP 与本文档')

    assert.match(
      directive(readCsp(), 'script-src'),
      /\bblob:/,
      'script-src 缺 blob: 时 audioWorklet.addModule 会被拦截 —— 录音会「有倒计时但录不进任何声音」，' +
        '而 Chromium 报的是 AbortError（像用户取消），排查成本极高（docs/91 §5.2.40）',
    )
  })

  it('worklet 归属 worker 类，worker-src 也要允许 blob:', () => {
    assert.match(directive(readCsp(), 'worker-src'), /\bblob:/)
  })

  it('放开 blob: 的同时不许放开 unsafe-inline / unsafe-eval', () => {
    const scriptSrc = directive(readCsp(), 'script-src')
    assert.ok(!scriptSrc.includes('unsafe-inline'), `script-src 不该有 unsafe-inline：${scriptSrc}`)
    assert.ok(!scriptSrc.includes('unsafe-eval'), `script-src 不该有 unsafe-eval：${scriptSrc}`)
    assert.equal(directive(readCsp(), 'object-src'), "object-src 'none'", 'object-src 必须保持 none')
  })

  it('worklet 加载失败要精确报错，不许以 AbortError 静默通过', () => {
    const recorder = readFileSync(RECORDER, 'utf8')
    assert.match(
      recorder,
      /RECORD_CAPTURE_UNAVAILABLE/,
      'addModule 的失败必须包成 RECORD_CAPTURE_UNAVAILABLE：AbortError 会被错误总线按「取消」吞掉',
    )
  })
})
