/**
 * 测试 · 试听链路的 CSP 与精确错误码（真机事故回归）
 * ============================================================================
 * 真机事故：对轨页点播放报
 *   「发生了未预期的错误 / 无法加载片段音频：imports/…wav / 原因链：TypeError: Failed to fetch」。
 *
 * 两条独立的因：
 *   ① **CSP 拦了自定义协议的 fetch**：试听走 `fetch('ns-media://…')` + `decodeAudioData`，
 *      而 `fetch` 受 **connect-src** 管辖（media-src 只管 <audio>/<video> 元素）——
 *      当时只写了 `connect-src 'self'`，请求没发出去就被拦掉，Chromium 只给一句 `Failed to fetch`；
 *   ② 捕获处只 `reportError(原始错误)`，落到 INTERNAL 兜底码，界面上看不出「是哪一步坏的」。
 *
 * 这组测试把两件事都钉住（源码级断言：CSP 是 <meta>，没法在 Node 里真跑浏览器）。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const read = (relativePath: string): string => readFileSync(join(process.cwd(), relativePath), 'utf8')
const INDEX_HTML = 'src/renderer/index.html'
const SCHEDULER = 'src/renderer/src/features/alignment/composables/usePlaybackScheduler.ts'
const VIEW = 'src/renderer/src/features/alignment/views/AlignmentView.vue'
const PANEL = 'src/renderer/src/features/alignment/components/TextReferencePanel.vue'

/** 取出 CSP 里某个指令的内容（没写就是空串） */
function directive(csp: string, name: string): string {
  const match = new RegExp(name + "([^;]*)").exec(csp)
  return match?.[1]?.trim() ?? ''
}

describe('试听链路：CSP 必须放行 ns-media', () => {
  it('connect-src 允许 ns-media:（fetch 受 connect-src 管辖，漏了就是 Failed to fetch）', () => {
    const csp = read(INDEX_HTML)
    assert.match(csp, /http-equiv="Content-Security-Policy"/)
    const connect = directive(csp, 'connect-src')
    assert.match(connect, /'self'/)
    assert.match(connect, /ns-media:/, '对轨试听要 fetch(ns-media://…)：connect-src 必须允许它')
  })

  it('media-src 允许 ns-media: 与 blob:（<audio> 与录音试听走它们）', () => {
    const media = directive(read(INDEX_HTML), 'media-src')
    assert.match(media, /ns-media:/)
    assert.match(media, /blob:/)
  })
})

describe('试听链路：失败要报精确错误码，不落到兜底', () => {
  it('加载片段失败时抛 MEDIA_FETCH_FAILED（带路径与 URL）', () => {
    const src = read(SCHEDULER)
    assert.match(src, /new AppError\('MEDIA_FETCH_FAILED'/)
    assert.match(src, /params: \{ path: source\.path \}/)
    assert.doesNotMatch(
      src,
      /reportError\(error, \{\s*\n\s*event: 'alignment\.playback\.decodeFailed'/,
      '不要再把原始错误直接丢给 reportError（会变 INTERNAL 兜底码）',
    )
  })
})

describe('试听链路：空格从「指定位置」开始播放', () => {
  it('视图在**窗口级**接管 Space（焦点不在画布时也能按），且不与画布重复触发', () => {
    const view = read(VIEW)
    assert.match(view, /matchEvent\(event, 'Space'\)/)
    // 用字符串而不是正则：这里的问号与括号转义容易写错，而断言本身要表达的只是一件事
    assert.ok(
      view.includes("closest?.('.ns-tl-canvas')"),
      '画布已处理时要让开，否则一次按键切两次',
    )
    assert.match(view, /void onTogglePlay\(\)/)
  })

  it('文本参照里点一行会把播放头挪到那一行（随后按空格就从这里播）', () => {
    const panel = read(PANEL)
    assert.match(panel, /timeline\.setPlayhead\(row\.startMs\)/)
    assert.match(panel, /timeline\.setPlayhead\(row\.startMs\)[\s\S]{0,120}playback\.setCurrentMs\(row\.startMs\)/)
  })


  it('单击片段（没有拖动）= 选中它并把播放头放到它的起点', () => {
    const src = read('src/renderer/src/features/alignment/composables/useTimelineInteraction.ts')
    assert.ok(
      src.includes('options.setPlayhead(clicked.timelineStartMs)'),
      '单击片段要定位播放头，否则「选中这一句再按空格」播的还是上一次的位置',
    )
    assert.match(
      src,
      /context\.mode === 'dragging' && context\.itemId/,
      '只在单击（未拖动）时定位：拖动过就说明用户在意的是位置微调',
    )
  })

  it('空格播放从播放头开始（play(playheadMs)），不是从 0', () => {
    const view = read(VIEW)
    assert.match(view, /await scheduler\.play\(timeline\.playheadMs\)/)
  })

describe('对轨：播放位置要跟着音频时间走', () => {
  it('rAF 每帧把播放头写回时间线（不能只更新 playback.currentMs）', () => {
    const src = read(SCHEDULER)
    assert.ok(
      src.includes('options.setPlayheadMs(current)'),
      '播放时画布画的是 timeline.playheadMs；只写 currentMs 的话播放头会冻住',
    )
    assert.ok(
      !src.includes('playback.setCurrentMs(current)'),
      '不要退回「只更新内部 currentMs」的写法',
    )
  })

  it('播放中视口跟随播放头（followPlayhead 开关 + ensureTimeVisible）', () => {
    const view = read(VIEW)
    assert.match(view, /if \(playback\.isPlaying && timeline\.followPlayhead\) timeline\.ensureTimeVisible\(ms\)/)
    assert.match(view, /timeline\.toggleFollowPlayhead\(\)/, '状态条要有开关，能关掉跟随')
    const store = read('src/renderer/src/features/alignment/stores/timeline.store.ts')
    assert.match(store, /function toggleFollowPlayhead\(next\?: boolean\): void/)
    assert.match(store, /snapEnabled, gridMs, followPlayhead, toggleFollowPlayhead,/, '开关要导出给视图')
  })
})
  it('画布消费掉的键要 preventDefault（否则空格会滚动页面）', () => {
    const canvas = read('src/renderer/src/features/alignment/components/TimelineCanvas.vue')
    assert.match(canvas, /if \(interaction\.onKeydown\(event\)\) event\.preventDefault\(\)/)
  })
})