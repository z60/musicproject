/**
 * 测试 · 录音模块的导航与布局 + 任务坞拖动（docs/91 §5.2.72）
 * ============================================================================
 * 这一组对应真机提的四条：
 *
 *  1. 「录完跳下一未录行」取消勾选后**仍然跳行** —— 开关是 :auto-next="true"
 *     硬编码的死值，也没有监听 @update:auto-next；停止后又无条件 currentIndex += 1。
 *  2. 录音模块缺「下一章」按钮；且两个视图都**没有章节 watcher**，
 *     就算切了章，界面还停在上一章的行上（看起来像没反应）。
 *  3. 「最下面录制那块会根据文本多少上下移动」—— TransportBar 是滚动容器里的
 *     普通流内元素，上方行文本一长就被顶下去；必须 sticky 钉在视口底部。
 *  4. 任务坞（TaskProgressDock）只能钉死在右下角，挡住内容也挪不开；要能拖动，
 *     但**初始仍在右下角**，且拖完松手不能顺带触发折叠。
 *
 * 两个录音视图是 .vue、任务坞依赖 Pinia，Node 里实例化不了 —— 与
 * 「record-start.test.ts」同一套做法：剥注释后做**源码级**断言，可反向验证。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const REC_VIEW = join(process.cwd(), 'src/renderer/src/features/recording/views/RecordingView.vue')
const TASK_VIEW = join(process.cwd(), 'src/renderer/src/features/recording/views/TaskRecordingView.vue')
const DOCK = join(process.cwd(), 'src/renderer/src/app/layout/TaskProgressDock.vue')

/** 剥掉块注释与行注释（注释里会引用「错误写法」本身，必须先剥再断言，否则守卫假红） */
function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

/** 只取 <template> 片段：样式/脚本里同名标识不该让模板断言假绿 */
function templateOf(file: string): string {
  const src = strip(readFileSync(file, 'utf8'))
  const start = src.indexOf('<template>')
  // 取**最后一个**闭合标签：模板里还有 <template v-if> 内联片段，取第一个会把根模板截断
  const end = src.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, file + ' 必须有 <template>')
  return src.slice(start, end)
}

function scriptOf(file: string): string {
  const src = strip(readFileSync(file, 'utf8'))
  const start = src.indexOf('<script setup')
  const end = src.lastIndexOf('</script>')
  assert.ok(start >= 0 && end > start, file + ' 必须有 <script setup>')
  return src.slice(start, end)
}

describe('录音 · 「录完跳下一未录行」必须真的生效（docs/91 §5.2.72）', () => {
  for (const [name, file] of [['RecordingView', REC_VIEW], ['TaskRecordingView', TASK_VIEW]] as const) {
    it(name + '：auto-next 不能是硬编码的 true，且要双向绑定', () => {
      const template = templateOf(file)
      assert.doesNotMatch(template, /:auto-next="true"/, '开关被写死成 true —— 用户在界面上根本关不掉')
      assert.match(template, /:auto-next="autoNext"/, '开关要绑到本地状态')
      assert.match(template, /@update:auto-next="autoNext = \$event"/, '勾选框要能改回来（缺监听 = 点了没反应）')
    })
  }

  it('RecordingView：停止后只有勾选时才前进', () => {
    const src = scriptOf(REC_VIEW)
    assert.match(src, /if\s*\(autoNext\.value\)\s*nextUnrecordedLine\(\)/, '未勾选时必须停在当前行')
  })

  it('TaskRecordingView：停止后只有勾选时才前进，且给出可见提示', () => {
    const src = scriptOf(TASK_VIEW)
    const guard = src.slice(src.indexOf('if (autoNext.value)'))
    assert.ok(guard.length > 0, 'stopRecording 里必须有 autoNext 判断')
    assert.match(guard.slice(0, 400), /currentIndex\.value\s*\+=\s*1/, '勾选时才前进一行')
    assert.match(guard.slice(0, 400), /else\s*\{[^}]*pageNotice\.value\s*=/, '未勾选要明说「停住了」，不能静默')
  })
})

describe('录音 · 「下一章」按钮与切章重载（docs/91 §5.2.72）', () => {
  for (const [name, file] of [['RecordingView', REC_VIEW], ['TaskRecordingView', TASK_VIEW]] as const) {
    it(name + '：有按钮、有 goNextChapter、有章节 watcher', () => {
      const template = templateOf(file)
      const script = scriptOf(file)
      assert.match(template, /@click="goNextChapter"/, '模板里要有「下一章」按钮')
      assert.match(template, />\s*下一章\s*→?\s*</, '按钮文案要能看出来是「下一章」')
      assert.match(script, /async function goNextChapter\(\)/, 'goNextChapter 要实现')
      assert.match(script, /chapters\.rows/, '取「下一章」要按书内章节顺序，不能用别的序')
      assert.match(script, /session\.selectChapter\(next\)/, '切章要走 session.selectChapter')
      assert.match(script, /watch\(\(\) => session\.chapterId/, '★ 没有章节 watcher 就等于「切了章界面不变」')
      assert.match(script, /await loadAll\(\)/, '切章后必须重新加载行/take')
    })
  }

  it('RecordingView：切章要清掉上一章的波形与钉住的 take', () => {
    const src = scriptOf(REC_VIEW)
    const watcher = src.slice(src.indexOf('watch(() => session.chapterId'))
    assert.ok(watcher.length > 0, 'watcher 存在')
    const head = watcher.slice(0, watcher.indexOf('await loadAll()'))
    assert.match(head, /releasePinnedTake\(\)/, '不放开钉住的 take，波形会继续显示上一章那一段')
    assert.match(head, /currentIndex\.value\s*=\s*0/, '行号要回到本章开头')
  })

  it('两个视图的 goNextChapter 都要拦住「录音中切章」', () => {
    for (const file of [REC_VIEW, TASK_VIEW]) {
      const src = scriptOf(file)
      const fn = src.slice(src.indexOf('async function goNextChapter()'))
      assert.match(fn.slice(0, 400), /recording\.isRecording/, '录音/暂停中切章会丢音，必须先拦住并提示')
    }
  })
})

describe('录音 · 底部走带不能被文本顶走（docs/91 §5.2.72）', () => {
  it('RecordingView：TransportBar 包在 sticky 容器里', () => {
    const template = templateOf(REC_VIEW)
    const wrap = template.indexOf('ns-rec__transport')
    assert.ok(wrap >= 0, '模板里要有 .ns-rec__transport 容器')
    assert.ok(template.indexOf('<TransportBar', wrap) > wrap, 'TransportBar 必须在容器内')

    const raw = readFileSync(REC_VIEW, 'utf8')
    const css = raw.slice(raw.indexOf('.ns-rec__transport'))
    const rule = css.slice(0, css.indexOf('}'))
    assert.match(rule, /position:\s*sticky/, '★ 流内元素会被上方文本顶下去，必须 sticky')
    assert.match(rule, /bottom:\s*(-?[\d.]+(px)?|0)/, 'sticky 要有 bottom 偏移才吸得住')
    assert.ok(/z-index:\s*\d/.test(rule), '要压在上方内容之上')
    assert.ok(/background:/.test(rule), '要有不透明背景，否则滚动内容会从走带后面透出来')
  })

  it('RecordingView：.ns-rec 不能自己开滚动容器（否则 sticky 绑到它、永远不滚）', () => {
    const raw = readFileSync(REC_VIEW, 'utf8')
    const base = raw.slice(raw.indexOf('.ns-rec {'), raw.indexOf('.ns-rec__transport'))
    assert.ok(base.includes('.ns-rec {'), '找到基础布局规则')
    // 本视图高度是内容高：开了 overflow-y:auto 也永远不会滚，
    // 只会把 sticky 的滚动祖先从外层 .ns-shell__main 抢走 —— 走带照旧被文本顶走
    assert.doesNotMatch(
      base,
      /overflow(-y)?:\s*auto/,
      '★ .ns-rec 一旦成为滚动容器，sticky 就绑在它身上，而它永不滚动',
    )
  })
})

describe('任务坞 · 可拖动，但初始仍在右下角（docs/91 §5.2.72）', () => {
  const src = strip(readFileSync(DOCK, 'utf8'))

  it('默认位置仍是右下角（拖动只是附加能力）', () => {
    const rule = src.slice(src.indexOf('.ns-dock {'), src.indexOf('.ns-dock--collapsed'))
    assert.match(rule, /position:\s*fixed/, '任务坞是浮层')
    assert.match(rule, /right:\s*16px/, '初始右侧')
    assert.match(rule, /bottom:\s*16px/, '初始底部')
  })

  it('按住标题栏能拖：pointer 事件 + 指针捕获', () => {
    assert.match(src, /@pointerdown="onHeadPointerDown"/, '标题栏要能起拖')
    assert.match(src, /@pointermove="onHeadPointerMove"/, '要跟手')
    assert.match(src, /@pointerup="onHeadPointerUp"/, '松手要收尾')
    assert.match(src, /@pointercancel="onHeadPointerUp"/, '手指/笔中断也要收尾，否则会一直粘着鼠标')
    assert.match(src, /setPointerCapture/, '不捕获指针，拖快了就丢事件')
    assert.match(src, /releasePointerCapture/, '结束时要放开捕获')
    assert.match(src, /touch-action:\s*none/, '触屏上不声明 touch-action，拖动会被当成滚动')
  })

  it('拖动后按 left/top 定位，且夹在视口内', () => {
    assert.match(src, /Math\.round\(pos\.value\.left\)/, '拖过之后要用 left 定位')
    assert.match(src, /right:\s*'auto'/, 'left/top 生效时必须放开 right/bottom，否则会互相扯')
    assert.match(src, /bottom:\s*'auto'/, '同上')
    assert.match(src, /function clampPos/, '要夹在视口内，别拖出去找不回来')
    assert.match(src, /innerWidth/, '视口宽度要参与夹取')
    assert.match(src, /innerHeight/, '视口高度要参与夹取')
  })

  it('位置持久化，重启后还在原地', () => {
    assert.match(src, /localStorage\?\.setItem/, '拖动结束要记住位置')
    assert.match(src, /localStorage\?\.getItem/, '启动要恢复位置')
    assert.match(src, /addEventListener\?\.\('resize'/, '窗口变小后要重新夹一次，否则会跑到屏幕外')
  })

  it('拖完松手那一下不算点击（不能顺带折叠）', () => {
    assert.match(src, /@click="onHeadClick"/, '走包装过的点击处理，不再直接 toggleDock')
    assert.doesNotMatch(src, /@click="ui\.toggleDock\(\)"/, '直接绑 toggleDock 就没有「拖动后吞点击」的余地')
    const fn = src.slice(src.indexOf('function onHeadClick'))
    assert.match(fn.slice(0, 300), /if\s*\(suppressClick\)/, '拖动过要吞掉随后的 click')
    assert.match(fn.slice(0, 300), /ui\.toggleDock\(\)/, '没拖动时仍然是折叠/展开')
    assert.match(src, /Math\.abs\(dx\)\s*>\s*4/, '要有 4px 死区，否则轻微手抖就永远折叠不了')
  })
})
