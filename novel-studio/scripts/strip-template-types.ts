/**
 * Novel Studio · Vue 模板内联箭头函数「去掉参数类型标注」
 * ============================================================================
 * 设计依据：docs/02（Vue 3 单文件组件）
 *
 * ### 为什么必须去掉
 *   Vue 的模板表达式**不是 TypeScript**：模板编译器只做 JS 解析。
 *   写成 `@change="(patch: { a?: string }) => f(patch)"` 时，`vue-tsc` 会直接报
 *   TS1109「Expression expected」/ TS1005「',' expected」——
 *   而且报错后**整个文件不再做类型检查**，于是真正的类型问题被掩盖。
 *
 *   正确的写法是让类型从组件 props 的事件签名里推断：
 *   `@change="(patch) => f(patch)"`。
 *   类型安全没有损失：事件签名由子组件 `defineEmits` 决定，参数依然是强类型的。
 *
 * ### 为什么不用简单正则
 *   参数类型里会出现 `{ a?: string | null }`、`Partial<EqBand>`、`number[]`、
 *   `Id | null`、`v ?? 0` 等各种形态，`,` 与 `:` 都可能是类型的一部分。
 *   本脚本按**括号配对 + 顶层冒号**定位参数列表，逐字符扫描，不做贪婪匹配。
 *
 * 用法：
 *   node --experimental-strip-types scripts/strip-template-types.ts --check   # 只检查
 *   node --experimental-strip-types scripts/strip-template-types.ts --write   # 就地修复
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const RENDERER = join(ROOT, 'src', 'renderer')

export interface StripResult {
  file: string
  /** 该文件被改写的属性个数 */
  changed: number
  /** 改写后的文本 */
  text: string
}

/** 递归收集 .vue 文件 */
export function listVueFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue
      out.push(...listVueFiles(full))
    } else if (name.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

/** 从 `(` 开始按配对找到 `)`；返回配对右括号的下标，找不到返回 -1 */
function matchParen(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 去掉单个参数列表里的类型标注。
 * `(patch: { a?: string | null })` → `(patch)`
 * `(id: string, n: number)`       → `(id, n)`
 * `()`                            → `()`
 */
export function stripParamTypes(params: string): string {
  if (params.trim() === '') return params
  const parts: string[] = []
  let cur = ''
  let depth = 0
  let angle = 0
  let quote: string | null = null
  for (let i = 0; i < params.length; i++) {
    const ch = params[i]!
    if (quote) {
      cur += ch
      if (ch === '\\') {
        cur += params[i + 1] ?? ''
        i++
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    else if (ch === '<') angle++
    else if (ch === '>') angle = Math.max(0, angle - 1)

    if (ch === ',' && depth === 0 && angle === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)

  const cleaned = parts.map((raw) => {
    const trimmedStart = raw.replace(/^\s*/, '')
    const lead = raw.slice(0, raw.length - trimmedStart.length)
    const trail = raw.replace(/\s*$/, '')
    const tailWs = raw.slice(trail.length)
    const body = trimmedStart.replace(/\s*$/, '')

    // 只处理具有类型标注的参数（含 `ident: type` 形式）
    const colon = findTopLevelColon(body)
    if (colon < 0) return raw
    const namePart = body.slice(0, colon).replace(/\s*$/, '')
    // 形如 `...rest: T[]` 也要正确保留 `...rest`
    if (!/^(\.\.\.)?[A-Za-z_$][\w$]*$/.test(namePart)) return raw
    return `${lead}${namePart}${tailWs}`
  })

  return cleaned.join(',')
}

/** 找参数文本里第一个「顶层」冒号（不在 (){}[] 与 <> 内部） */
function findTopLevelColon(text: string): number {
  let depth = 0
  let angle = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    else if (ch === '<') angle++
    else if (ch === '>') angle = Math.max(0, angle - 1)
    else if (ch === ':' && depth === 0 && angle === 0) return i
  }
  return -1
}

/**
 * 改写一个 .vue 文件的 `<template>` 段：把内联箭头函数的参数类型标注去掉。
 * `<script>` / `<style>` 段一字不动（那里 TS 是合法的）。
 */
export function stripTemplateTypes(source: string): { text: string; changed: number } {
  const tplOpen = source.indexOf('<template>')
  if (tplOpen < 0) return { text: source, changed: 0 }
  // 模板段到最后一个 `</template>`（嵌套 template 时取最外层闭合）
  const tplClose = source.lastIndexOf('</template>')
  if (tplClose < tplOpen) return { text: source, changed: 0 }

  const head = source.slice(0, tplOpen)
  const tpl = source.slice(tplOpen, tplClose)
  const tail = source.slice(tplClose)

  let changed = 0
  let out = ''
  let i = 0
  while (i < tpl.length) {
    // 逐个找 `(`，配对成功后确认紧跟 `=>` —— 那才是箭头函数的参数列表。
    // 非箭头函数调用（如 `f(a, b)`）会原样跳过。
    const paren = tpl.indexOf('(', i)
    if (paren < 0) {
      out += tpl.slice(i)
      break
    }
    const close = matchParen(tpl, paren)
    if (close < 0) {
      out += tpl.slice(i)
      break
    }
    const inner = tpl.slice(paren + 1, close)
    // 必须紧跟 `=>` 才是箭头函数参数
    const after = tpl.slice(close + 1).match(/^\s*=>/)
    if (!after) {
      out += tpl.slice(i, paren + 1)
      i = paren + 1
      continue
    }
    const stripped = stripParamTypes(inner)
    if (stripped !== inner) changed++
    out += tpl.slice(i, paren + 1) + stripped
    i = close
  }

  return { text: head + out + tail, changed }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const diff = args.includes('--diff')
  const only = args.filter((a) => !a.startsWith('--'))
  const check = args.includes('--check') || !write

  const files = listVueFiles(RENDERER).filter(
    (f) => only.length === 0 || only.some((o) => f.includes(o)),
  )
  const results: StripResult[] = []
  let totalChanged = 0

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const { text, changed } = stripTemplateTypes(source)
    if (changed > 0) {
      results.push({ file, changed, text })
      totalChanged += changed
      if (diff) printDiff(file, source, text)
      if (write) writeFileSync(file, text, 'utf8')
    }
  }

  console.log('='.repeat(78))
  console.log(`[strip-template-types] 扫描 ${files.length} 个 .vue 文件`)
  console.log(`[strip-template-types] 含非法类型标注的内联箭头函数：${totalChanged} 处 / ${results.length} 个文件`)
  console.log('='.repeat(78))
  if (results.length > 0 && !diff) {
    for (const r of results.slice(0, 25)) {
      console.log(`  ${relative(ROOT, r.file).split(sep).join('/')}  (${r.changed} 处)`)
    }
    if (results.length > 25) console.log(`  … 其余 ${results.length - 25} 个文件`)
  }

  if (check && totalChanged > 0) {
    console.log('')
    console.log('[strip-template-types] 模板表达式里不允许 TS 类型标注：请运行 npm run fix:template-types')
    process.exit(1)
  }
  console.log('[strip-template-types] 模板内联箭头函数无类型标注 ✓')
}

/** 逐行对比（只打印有差异的行 + 行号），用于人工复核改写是否符合预期 */
function printDiff(file: string, before: string, after: string): void {
  const b = before.split('\n')
  const a = after.split('\n')
  const n = Math.max(b.length, a.length)
  console.log(`--- ${relative(ROOT, file).split(sep).join('/')}`)
  for (let i = 0; i < n; i++) {
    if (b[i] !== a[i]) {
      console.log(`  L${i + 1}`)
      console.log(`    - ${(b[i] ?? '').trim()}`)
      console.log(`    + ${(a[i] ?? '').trim()}`)
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('strip-template-types.ts')) main()
