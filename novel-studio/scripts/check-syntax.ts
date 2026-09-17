/**
 * Novel Studio · 源码语法/类型剥离自检
 * ============================================================================
 * 为什么需要它：
 *   `check-structure.ts` 只会**真的 import 零依赖模块**（src/shared、src/types）。
 *   而 `src/main/**` 会 import electron / better-sqlite3，在当前环境（无外网、无依赖）
 *   无法被真正 import，于是那里的**语法错误完全不会被发现**。
 *
 *   实际踩到过：`src/main/bootstrap/cleanup.ts` 有语法错误，导致
 *   `src/main/bootstrap/index.ts` 无法被 import → 引用了它的测试报
 *   「SyntaxError: Expected '{', got 'interface'」，而报错位置指向的是**别的文件**，
 *   排查花了很久。本脚本就是为了让这类问题**一眼可见**。
 *
 * 做法：对每个 .ts/.vue 的 script 段调用 Node 的 `stripTypeScriptTypes`。
 *   它只做类型剥离**不做类型检查**，但**语法错误会抛错** —— 这正是我们要的：
 *   在没有 tsc 的环境下，这是唯一能覆盖全仓库的语法门禁。
 *
 * 用法：
 *   node --experimental-strip-types scripts/check-syntax.ts
 *   node --experimental-strip-types scripts/check-syntax.ts --verbose
 *
 * 退出码：0 = 全部可剥离；1 = 有文件语法错误
 */

import { stripTypeScriptTypes } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const VERBOSE = process.argv.includes('--verbose')

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of entries) {
    if (n === 'node_modules' || n.startsWith('.')) continue
    const f = join(dir, n)
    let st
    try {
      st = statSync(f)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(f, out)
    else if ((n.endsWith('.ts') || n.endsWith('.vue')) && !n.endsWith('.d.ts')) out.push(f)
  }
  return out
}

/** 从 .vue 里取出 <script lang="ts"> 的内容（含行号偏移，便于报错定位） */
function extractVueScript(src: string): { code: string; lineOffset: number } | null {
  const m = /<script[^>]*lang=["']ts["'][^>]*>([\s\S]*?)<\/script>/i.exec(src)
  if (!m) return null
  const before = src.slice(0, m.index)
  const lineOffset = before.split('\n').length
  return { code: m[1] ?? '', lineOffset }
}

const files = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'scripts')), walk(join(ROOT, 'tests')))

interface Failure {
  file: string
  line: number | null
  message: string
}

const failures: Failure[] = []
let checked = 0

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const src = readFileSync(file, 'utf8')

  let code = src
  let lineOffset = 0

  if (file.endsWith('.vue')) {
    const script = extractVueScript(src)
    if (!script) {
      // 没有 script 段的 .vue 只有模板，跳过（模板语法由 check:renderer 负责）
      if (VERBOSE) console.log(`  skip ${rel}（无 <script lang="ts">）`)
      continue
    }
    code = script.code
    lineOffset = script.lineOffset
  }

  checked++
  try {
    stripTypeScriptTypes(code, { mode: 'strip' })
    if (VERBOSE) console.log(`  ok   ${rel}`)
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0] : String(e)
    // Node 的错误信息里常带 ":行:列"，据此换回文件真实行号
    const m = /:(\d+):(\d+)/.exec(message)
    const line = m ? Number(m[1]) + lineOffset : null
    failures.push({ file: rel, line, message })
  }
}

// ── 2. 块注释内二次出现注释起始符的隐患检测 ─────────────────────────────
/**
 * 为什么要查这个（真实踩过的坑，而且这个坑就在本文件里复现过一次）：
 *   `cleanup.ts` 的 JSDoc 里写了 `<projects>` 后跟 `*` 与 `/`（即注释起始符），
 *   于是 Node 的类型剥离解析器**重新进入嵌套块注释**，整个注释永不闭合、
 *   后续内容全被吞掉，最终在很远的地方报 `Expected '{', got 'interface'` ——
 *   报错位置指向的 interface 完全合法，排查被误导了很久。
 *
 * 判据：一个块注释段内如果**再次出现注释起始符，且其后没有注释结束符**，
 *   注释就闭合不了。常见的 `src/shared/` 后跟 `*` 的写法（glob）侥幸能过，
 *   因为那行的结尾会紧接注释自身的结束符 —— 但那是运气，不是安全写法。
 *   统一改写为「星号与斜杠之间留一个空格」，或用 `**` 表示通配。
 *
 * 注：本注释自身刻意**不写出那个两字符起始符**，否则本文件就会触发它要检测的问题。
 */
function findNestedCommentStarts(src: string): number[] {
  const bad: number[] = []
  const lines = src.split('\n')
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (!inBlock) {
      const s = l.indexOf('/*')
      if (s >= 0 && l.indexOf('*/', s + 2) < 0) inBlock = true
      continue
    }
    // 已在块注释内：找注释起始符与结束符
    const extra = l.indexOf('/*')
    const close = l.indexOf('*/')
    if (extra >= 0 && (close < 0 || extra < close)) {
      // 真正的危险 vs 无害的 glob：
      //   · 危险：起始符之后**本行再没有结束符** —— 注释状态被永久续上，
      //     后续所有代码都被当成注释吞掉（`<projects>` 后跟通配再跟 `/.tmp` 就是这种情况）。
      //   · 无害：起始符之后本行还有结束符（如 `src/shared/` 后跟通配加 `.ts`），
      //     注释会在本行正常闭合，只是语义上不够干净。
      // 只把前者算作隐患；后者若也报，会把大量正常 glob 当成问题，检查就没人看了。
      const closeAfterExtra = l.indexOf('*/', extra + 2)
      if (closeAfterExtra < 0) bad.push(i + 1)
    }
    if (close >= 0) inBlock = false
  }
  return bad
}

const commentHazards: Array<{ file: string; lines: number[] }> = []

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const src = readFileSync(file, 'utf8')
  const code = file.endsWith('.vue') ? (extractVueScript(src)?.code ?? '') : src
  const hazards = findNestedCommentStarts(code)
  if (hazards.length > 0) commentHazards.push({ file: rel, lines: hazards })
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('')
console.log('='.repeat(78))
console.log(`[check-syntax] 对 ${checked} 个文件做类型剥离（覆盖 src / scripts / tests）`)

if (failures.length === 0) {
  console.log('[check-syntax] 全部文件语法可剥离 ✓')
} else {
  console.error(`[check-syntax] ${failures.length} 个文件存在语法错误：`)
  for (const f of failures) {
    console.error(`  ✗ ${f.file}${f.line ? `:${f.line}` : ''}`)
    console.error(`      ${f.message}`)
    try {
      const src = readFileSync(join(ROOT, f.file), 'utf8').split('\n')
      const around = f.line ?? 1
      for (let i = Math.max(0, around - 4); i < Math.min(src.length, around + 3); i++) {
        const mark = i + 1 === around ? '>>' : '  '
        console.error(`      ${mark} ${String(i + 1).padStart(4)}: ${src[i]}`)
      }
    } catch {
      /* 忽略读取失败 */
    }
    console.error('')
  }
}

if (commentHazards.length > 0) {
  const total = commentHazards.reduce((s, h) => s + h.lines.length, 0)
  console.error(`[check-syntax] ${total} 处注释隐患：块注释内出现 \`/*\`（会让注释假性嵌套）`)
  for (const h of commentHazards.slice(0, 40)) {
    console.error(`  · ${h.file}:${h.lines.join(',')}`)
  }
  if (commentHazards.length > 40) console.error(`  · …还有 ${commentHazards.length - 40} 个文件`)
  console.error('  修法：把注释里的 `/*` 改写为 `* /`（星号与斜杠之间留一个空格），或避开该写法。')
}
console.log('='.repeat(78))

process.exit(failures.length > 0 ? 1 : 0)
