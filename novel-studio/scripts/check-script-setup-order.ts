/**
 * Novel Studio · `<script setup>` 声明顺序自检（防 TDZ）
 * ============================================================================
 * ### 它守的是什么
 *   `watch(..., { immediate: true })` 与 `watchEffect(...)` 在 **setup 期间立刻执行**
 *   （immediate 时连取值函数也会先跑一次），它们调用的函数体同样在那一刻执行。
 *   一旦这些代码引用了**声明在它们后面**的 `const` / `let`，就会踩暂时性死区：
 *
 *     ReferenceError: Cannot access 'playing' before initialization
 *
 *   真机症状（用户报的）：点开「画本编辑」整页报错（被 ErrorBoundary 兜住显示
 *   「页面显示出现异常」）——因为 `LineEditorDrawer.vue` 的
 *   `watch(() => props.line?.id, syncFields, { immediate: true })` 调用的 `syncFields()`
 *   里写了 `playing` / `metrics` / `playbackHint` / `flagDraft`，而这四个 ref 声明在它之后。
 *
 *   `tsc` / `vue-tsc` **抓不到**这类问题（类型上没问题），运行时才炸，而且只在
 *   打开那个组件时才炸 —— 所以需要一条静态检查。
 *
 * ### 判据（刻意保守，宁可少报也不假报）
 *   · 只看**列 0** 的 `watch` / `watchEffect`（顶层注册；写在 `onMounted` 里的不在此列，
 *     那时 ref 早已初始化，不构成 TDZ）
 *   · 展开它调用的**顶层函数**（最多 4 层，防环），因为函数体也在那一刻执行
 *   · 只有 `const` / `let` / `class` 声明才算（`function` 声明会提升，`var` 是 undefined 而非 TDZ）
 *   · 字符串与注释先剔除，避免把文本里的名字算进来
 *
 * ### 已知局限（如实记录）
 *   它**不**分析「顶层语句里读 `.value`」这类更宽的写法（例如
 *   `const a = computed(() => b.value)` 里 `b` 声明在后面是**合法**的，因为 computed 是惰性的）。
 *   要覆盖那一类需要真正的语义分析，那属于 TypeScript 的活；这里只钉住已经害过人的那种形状。
 *
 * ### 怎么豁免
 *   确实合法但被误报时，在被报的 eager 区域那一行加 `// setup-order-ok` 注释并写清理由。
 *
 * 用法：
 *   node --experimental-strip-types scripts/check-script-setup-order.ts
 *   node --experimental-strip-types scripts/check-script-setup-order.ts --verbose
 *
 * 退出码：0 = 通过；1 = 发现问题
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src', 'renderer', 'src')
const VERBOSE = process.argv.includes('--verbose')
const ALLOW_MARKER = 'setup-order-ok'

// ---------------------------------------------------------------------------
// 扫描文件
// ---------------------------------------------------------------------------

function walkVue(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkVue(full, out)
    else if (name.endsWith('.vue')) out.push(full)
  }
  return out
}

// ---------------------------------------------------------------------------
// `<script setup>` 解析
// ---------------------------------------------------------------------------

interface ScriptSetup {
  text: string
  /** 正文第 0 行对应的**文件行号**（1 基） */
  firstLine: number
  lines: string[]
}

function scriptSetup(src: string): ScriptSetup | null {
  const m = /<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/i.exec(src)
  if (!m) return null
  const tagEnd = m.index + m[0]!.indexOf('>') + 1
  const newlines = (src.slice(0, tagEnd).match(/\n/g) ?? []).length
  return { text: m[1]!, firstLine: newlines + 1, lines: m[1]!.split('\n') }
}

type DeclKind = 'const' | 'function' | 'var'

/** 顶层声明（列 0）：名字 → { 行号, 种类 } */
function topLevelDecls(s: ScriptSetup): Map<string, { line: number; kind: DeclKind }> {
  const out = new Map<string, { line: number; kind: DeclKind }>()
  s.lines.forEach((line, i) => {
    const m = /^(?:export\s+)?(const|let|var|class|async\s+function|function)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (!m) return
    const kw = m[1]!.includes('function') ? 'function' : m[1]!
    const kind: DeclKind = kw === 'function' ? 'function' : kw === 'var' ? 'var' : 'const'
    out.set(m[2]!, { line: s.firstLine + i, kind })
  })
  return out
}

/** 顶层语句区块：`名字 → { 起行, 止行, 正文 }`（止行 = 下一个列 0 的非注释行之前） */
function topLevelBlocks(s: ScriptSetup): Map<string, { from: number; to: number; text: string }> {
  const starts: Array<{ name: string | null; index: number }> = []
  s.lines.forEach((line, i) => {
    const trimmed = line.trim()
    const isContinuation =
      trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    if (isContinuation || /^\s/.test(line)) return
    const m = /^(?:export\s+)?(?:const|let|var|function|async\s+function)\s+([A-Za-z_$][\w$]*)/.exec(line)
    starts.push({ name: m ? m[1]! : null, index: i })
  })

  const out = new Map<string, { from: number; to: number; text: string }>()
  starts.forEach((start, k) => {
    if (!start.name) return
    const endIndex = k + 1 < starts.length ? starts[k + 1]!.index - 1 : s.lines.length - 1
    out.set(start.name, {
      from: s.firstLine + start.index,
      to: s.firstLine + endIndex,
      text: s.lines.slice(start.index, endIndex + 1).join('\n'),
    })
  })
  return out
}

/** 导入的绑定名（setup 执行前已初始化，不在 TDZ 范围内） */
function importedNames(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]/gm)) {
    const clause = m[1]!
    for (const named of clause.matchAll(/\{([\s\S]*?)\}/g)) {
      for (const part of named[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim().replace(/^type\s+/, '') ?? ''
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
      }
    }
    const defaults = clause.replace(/\{[\s\S]*?\}/, '').split(',').map((x) => x.trim()).filter(Boolean)
    for (const d of defaults) if (/^[A-Za-z_$][\w$]*$/.test(d)) out.add(d)
  }
  return out
}

/** 文本里的标识符（剔除注释、字符串、模板串与属性访问） */
function identifiers(text: string): Set<string> {
  const cleaned = text
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  const out = new Set<string>()
  for (const m of cleaned.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g)) out.add(m[2]!)
  return out
}

/** 立刻执行的区域：列 0 的 `watch{immediate:true}` / `watchEffect` 调用 */
function eagerRegions(s: ScriptSetup, decls: Map<string, { line: number; kind: DeclKind }>): Array<{
  from: number
  to: number
  label: string
  text: string
  allowed: boolean
}> {
  const out: Array<{ from: number; to: number; label: string; text: string; allowed: boolean }> = []
  const lineOf = (index: number): number => s.firstLine + (s.text.slice(0, index).match(/\n/g) ?? []).length

  for (const m of s.text.matchAll(/\bwatch(?:Effect)?\s*\(/g)) {
    const start = m.index!
    // 只认**列 0** 的注册（顶层）。写在 onMounted / 函数体里的 watch 不在 setup 期间执行，
    // 那时所有 ref 都已初始化，不构成 TDZ —— 把它们算进来只会得到假红。
    const lineStart = s.text.lastIndexOf('\n', start) + 1
    if (/[^\s]/.test(s.text.slice(lineStart, start))) continue

    let depth = 0
    let end = start
    for (let i = start; i < s.text.length; i++) {
      const ch = s.text[i]!
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const call = s.text.slice(start, end + 1)
    const isWatchEffect = /^watchEffect/.test(m[0]!)
    if (!isWatchEffect && !/immediate\s*:\s*true/.test(call)) continue
    const allowed = call.includes(ALLOW_MARKER)
    out.push({
      from: lineOf(start),
      to: lineOf(end),
      label: isWatchEffect ? 'watchEffect' : 'watch{immediate:true}',
      text: call,
      allowed,
    })
    void decls
  }
  return out
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface Finding {
  file: string
  line: number
  label: string
  names: string[]
}

function checkFile(file: string): Finding[] {
  const s = scriptSetup(readFileSync(file, 'utf8'))
  if (!s) return []
  const decls = topLevelDecls(s)
  const blocks = topLevelBlocks(s)
  const imports = importedNames(s.text)
  const findings: Finding[] = []

  for (const region of eagerRegions(s, decls)) {
    if (region.allowed) continue

    // eager 区域引用的标识符 → 展开它调用的顶层函数体（最多 4 层，防环）
    const queue = [...identifiers(region.text)]
    const closure = new Set<string>(queue)
    const seenFunctions = new Set<string>()
    for (let depth = 0; depth < 4; depth++) {
      const next: string[] = []
      for (const name of queue) {
        if (seenFunctions.has(name)) continue
        seenFunctions.add(name)
        const block = blocks.get(name)
        // 只展开声明在 eager 区域**之前**的函数；声明在之后的会自己作为违规被报出来
        if (!block || block.from > region.from) continue
        for (const id of identifiers(block.text)) {
          closure.add(id)
          next.push(id)
        }
      }
      queue.length = 0
      queue.push(...next)
    }

    const hits: string[] = []
    for (const name of closure) {
      if (imports.has(name)) continue
      const decl = decls.get(name)
      if (!decl) continue
      // `function` 声明会提升；`var` 是 undefined 而不是 TDZ —— 只报 const/let/class
      if (decl.kind !== 'const') continue
      if (decl.line <= region.from) continue
      hits.push(`${name}（声明在 ${decl.line} 行）`)
    }
    if (hits.length > 0) {
      findings.push({ file, line: region.from, label: region.label, names: hits.sort() })
    }
  }
  return findings
}

const files = walkVue(SRC)
const findings: Finding[] = []
for (const file of files) findings.push(...checkFile(file))

console.log('')
console.log('='.repeat(78))
console.log(`[check-setup-order] 扫描 ${files.length} 个 .vue 的 <script setup>（只看列 0 的 watch/watchEffect）`)
console.log('='.repeat(78))

if (VERBOSE) {
  for (const f of files) {
    const s = scriptSetup(readFileSync(f, 'utf8'))
    if (!s) continue
    console.log(`  ${relative(ROOT, f)}：${topLevelDecls(s).size} 个顶层声明`)
  }
  console.log('')
}

if (findings.length > 0) {
  console.error('[check-setup-order] 发现 setup 期间就会执行、却引用了后面才声明的 const：')
  for (const f of findings) {
    console.error(`  ✗ ${relative(ROOT, f.file)}:${f.line} ${f.label} → ${f.names.join('、')}`)
    console.error('      immediate/watchEffect 在 setup 期间立刻执行；请把注册移到这些声明之后，')
    console.error(`      或确认合法后在该行加 \`// ${ALLOW_MARKER}\` 注释说明理由。`)
  }
  console.error('')
  console.error('  这类错误 tsc/vue-tsc 抓不到，运行时表现为整页 Cannot access xxx before initialization。')
  console.error('')
  process.exit(1)
}

console.log('[check-setup-order] 通过 ✓（没有在 setup 期间访问尚未初始化的 const 绑定）')
