/**
 * 测试 · 导出向导「单选某一章」+ 事件绑定纪律（真机事故回归）
 * ============================================================================
 * 真机反馈：「导出向导模块里无法单选某一章」。
 *
 * 根因不是选择逻辑，而是**模板绑定写法**：章节勾选写成了
 *
 *     @update:model-value="onToggleChapterInput(row.id)"      <- 点不动
 *
 * 而 onToggleChapterInput 是「把 chapterId 柯里化进处理器」的**工厂函数**（返回一个处理器）。
 * Vue 只把「裸标识符 / 成员表达式」当处理器，**带调用的表达式一律编译成内联语句** ——
 * 工厂被调用、返回的处理器被丢掉，于是勾选框点了没有任何反应。
 *
 * 这组测试盯两件事：
 *   ① 导出向导要能**单选某一章**（勾选走内联箭头；另有「仅此」一键只选该章）；
 *   ② **全仓扫描**：不许再把「返回处理器的函数」直接当事件绑定用（这一类 bug 的通用护栏）。
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

const RENDERER_SRC = join(process.cwd(), 'src/renderer/src')
const read = (relativePath: string): string => readFileSync(join(process.cwd(), relativePath), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.vue')) out.push(full)
  }
  return out
}

const FACTORY_DECL = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*[^;{}\n]*=>/g
const CALLED_BINDING = /@[\w:.-]+="\s*([A-Za-z_$][\w$]*)\s*\(/g

/** 声明里「返回一个函数」的函数名（function foo(...): (x: T) => void） */
function handlerFactories(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(FACTORY_DECL)) if (match[1]) names.push(match[1])
  return names
}

/** 模板里「直接调用某个标识符」的事件绑定：@click="fn(...)"（内联箭头不算） */
function calledHandlers(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = []
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(CALLED_BINDING)) {
      if (match[1]) out.push({ name: match[1], line: index + 1 })
    }
  })
  return out
}

const VIEW = 'src/renderer/src/features/mixing/views/ExportWizardView.vue'
const STORE = 'src/renderer/src/features/mixing/stores/export.store.ts'

describe('导出向导：单选某一章', () => {
  it('勾选框用内联箭头把 row.id 固定进处理器（不能调用工厂再当处理器）', () => {
    const view = read(VIEW)
    assert.match(
      view,
      /@update:model-value="\(value\) => onToggleChapter\(row\.id, value\)"/,
      '章节勾选必须写成内联箭头；写成 onToggleChapterInput(row.id) 会「点了没反应」',
    )
    // 只看模板：脚本/注释里会讲到那个坏写法（讲清楚为什么不能这么写）
    const template = view.slice(view.indexOf('<template>'))
    assert.doesNotMatch(
      template,
      /@update:model-value="onToggleChapter\(/,
      '不要再回到「调用工厂再当处理器」的写法',
    )
  })

  it('每行有「仅此」= 只选这一章（一次点击完成单选）', () => {
    const view = read(VIEW)
    assert.match(view, /onSelectOnly\(row\)/, '每行要有「仅此」按钮')
    assert.match(view, /store\.selectOnlyChapter/, '按钮要接到 store 的单选动作上')
    const store = read(STORE)
    assert.match(store, /function selectOnlyChapter\(id: Id\): void/)
    assert.match(
      store,
      /selectedChapterIds\.value = chapters\.value\.some\(c => c\.id === id\) \? \[id\] : \[\]/,
      '单选 = 只留这一章（不在列表里就是空）',
    )
    assert.match(store, /toggleChapter, selectOnlyChapter,/, '要导出给视图用')
  })
})

describe('事件绑定纪律：不许把「返回处理器的函数」直接当绑定用', () => {
  it('护栏本身有效（拿真机那段坏写法自检）', () => {
    const bad = [
      'function onToggleChapterInput(chapterId: string): (value: boolean) => void {',
      '  return (value: boolean): void => {}',
      '}',
      '<el-checkbox @update:model-value="onToggleChapterInput(row.id)" />',
    ].join('\n')
    assert.deepEqual(handlerFactories(bad), ['onToggleChapterInput'])
    assert.deepEqual(
      calledHandlers(bad).map(c => c.name),
      ['onToggleChapterInput'],
      '这种写法必须能被扫出来',
    )
  })

  it('全仓 .vue 扫描：没有「工厂函数被当事件处理器」的写法', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER_SRC)) {
      const text = readFileSync(file, 'utf8')
      const factories = new Set(handlerFactories(text))
      if (factories.size === 0) continue
      for (const usage of calledHandlers(text)) {
        if (!factories.has(usage.name)) continue
        offenders.push(relative(process.cwd(), file).replace(/\\/g, '/') + ':' + usage.line + ' -> ' + usage.name + '(...)')
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Vue 只把裸标识符/成员表达式当处理器；带调用的表达式会被当成内联语句、返回值被丢掉。' +
        '请改成内联箭头：@event="(v) => fn(id, v)"\n' +
        offenders.join('\n'),
    )
  })
})