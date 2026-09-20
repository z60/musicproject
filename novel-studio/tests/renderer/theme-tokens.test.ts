/**
 * 测试 · 深浅色主题的取色纪律（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.39）：深色模式下出现两种读不下去的搭配 ——
 *   · 「白底 + 灰白字」：组件把底色写死成 `#fff`，文字却用 `var(--ns-text-*)`
 *     （深色下文字变浅，底色没变）→ 对比度几乎为零；
 *   · 「黑底 + 深灰字」：Element Plus 的**深色变量表没被引入**
 *     （只 import 了浅色的 `element-plus/dist/index.css`），EP 组件的文字
 *     仍是浅色模式的 #303133 深灰，落在我们自己的深色底上就是看不清。
 *
 * 这组测试盯住三件事（都能在 Node 里跑，不依赖浏览器）：
 *   1. 渲染进程样式里**不许再出现硬编码的浅色底**；
 *   2. 入口必须引入 EP 的深色变量表，且主题变量必须定义在 `html.dark` 里；
 *   3. Canvas 取色的降级行为正确（没有 DOM 时用兜底色，不会返回空串）。
 *
 * 说明：这是**源码级**约束（样式没有运行期单测），因此刻意写成对文件的断言，
 * 而不是假装测了「渲染出来好不好看」。
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

import { readThemeVar, themeColor } from '../../src/renderer/src/shared/lib/canvas-theme.ts'

const RENDERER_SRC = join(process.cwd(), 'src/renderer/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.vue') || name.endsWith('.css')) out.push(full)
  }
  return out
}

/** 样式文件里「硬编码浅色底」的写法（变量回退值 `var(--ns-x, #fff)` 不算） */
const HARDCODED_LIGHT_BG = /background(-color)?:\s*(?:#fff\b|#ffffff\b|white\b|rgba?\(255[\s,]+255[\s,]+255)/i

describe('主题纪律 · 样式里不许硬编码浅色底', () => {
  it('渲染进程的 .vue/.css 全部走 --ns-* 变量', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER_SRC)) {
      const text = readFileSync(file, 'utf8')
      text.split(/\r?\n/).forEach((line, index) => {
        // 变量回退值（`var(--ns-bg-elevated, #fff)`）是允许的：变量一定存在，回退只是防御
        if (/var\(--ns-[a-z-]+,\s*#(?:fff|ffffff|white)/i.test(line)) return
        if (HARDCODED_LIGHT_BG.test(line)) {
          offenders.push(`${relative(process.cwd(), file).replace(/\\/g, '/')}:${index + 1} ${line.trim()}`)
        }
      })
    }
    assert.deepEqual(
      offenders,
      [],
      '深色模式下这些写死的浅色底会变成「白底 + 浅色字」，请改用 var(--ns-bg-elevated) 等变量：\n' +
        offenders.join('\n'),
    )
  })

  it('变量本身在浅色/深色两套里都定义过（否则深色下会继承浅色值）', () => {
    const theme = readFileSync(join(RENDERER_SRC, 'assets/theme.css'), 'utf8')
    const darkBlock = /html\[data-theme='dark'\][\s\S]*?\n}/.exec(theme)?.[0] ?? ''
    assert.ok(darkBlock.length > 0, 'theme.css 里必须有 html[data-theme=\'dark\'] 变量块')
    for (const token of ['--ns-text-primary', '--ns-text-regular', '--ns-text-secondary', '--ns-bg', '--ns-bg-elevated', '--ns-bg-subtle', '--ns-border-light']) {
      assert.ok(theme.includes(`${token}:`), `浅色变量块缺少 ${token}`)
      assert.ok(darkBlock.includes(`${token}:`), `深色变量块缺少 ${token}（深色下会沿用浅色值）`)
    }
  })
})

describe('主题纪律 · Element Plus 的深色变量表必须引入', () => {
  it('入口 import 了 element-plus/theme-chalk/dark/css-vars.css', () => {
    const main = readFileSync(join(RENDERER_SRC, 'app/main.ts'), 'utf8')
    /**
     * 必须断言**import 语句**本身：注释里也写着这个路径（用来解释为什么必须引入），
     * 只做 `includes(路径)` 会被注释骗过 —— 第一次写这条用例时就踩了这个坑。
     */
    assert.match(
      main,
      /^\s*import\s+'element-plus\/theme-chalk\/dark\/css-vars\.css'/m,
      '只 import element-plus/dist/index.css 时，EP 组件在 html.dark 下仍是浅色变量（深灰字）',
    )
  })

  it('切主题时同时设置 data-theme 与 .dark 类名', () => {
    const ui = readFileSync(join(RENDERER_SRC, 'app/store/ui.store.ts'), 'utf8')
    assert.ok(ui.includes('dataset.theme'), '样式层认 data-theme')
    assert.ok(ui.includes("classList.toggle('dark'"), 'Element Plus 的深色变量表认 .dark 类名')
  })
})

describe('Canvas 取色：没有 DOM 时用兜底色，绝不返回空串', () => {
  it('读到变量就用变量', () => {
    const source = { getPropertyValue: (name: string) => (name === '--ns-bg-elevated' ? ' #262727 ' : '') }
    assert.equal(readThemeVar(source, '--ns-bg-elevated', '#ffffff'), '#262727')
  })

  it('变量为空/纯空白 → 用兜底值（空串会把画布涂成透明或黑块）', () => {
    assert.equal(readThemeVar({ getPropertyValue: () => '' }, '--ns-bg-elevated', '#ffffff'), '#ffffff')
    assert.equal(readThemeVar({ getPropertyValue: () => '   ' }, '--ns-bg-elevated', '#ffffff'), '#ffffff')
    assert.equal(readThemeVar(null, '--ns-bg-elevated', '#ffffff'), '#ffffff')
    assert.equal(readThemeVar(undefined, '--ns-bg-elevated', '#ffffff'), '#ffffff')
  })

  it('Node 里没有 document → themeColor 直接给兜底值', () => {
    assert.equal(themeColor('--ns-bg-elevated', '#ffffff'), '#ffffff')
  })
})
