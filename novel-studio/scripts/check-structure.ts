/**
 * Novel Studio · 结构自检
 * ============================================================================
 * 在没有 typescript / vue / electron 的环境里（本仓库开发机无外网），
 * `tsc` 与打包都跑不了。此时**唯一能做的真实性检查**是：
 *
 *   1. 每个模块能否被 Node 用类型剥离方式真正 import 成功
 *      —— 这能抓到语法错误、import 路径写错、循环依赖、运行时顶层副作用抛错
 *   2. import 图是否遵守分层方向：shared 不得反向依赖 main / renderer
 *   3. shared 内部不得使用路径别名（别名只有 Vite 认识，Node 解析不了）
 *
 * 用法：
 *   node --experimental-strip-types scripts/check-structure.ts
 *   node --experimental-strip-types scripts/check-structure.ts --verbose
 *
 * 退出码：0 = 全部通过；1 = 有问题
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VERBOSE = process.argv.includes('--verbose')

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
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
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * 只对「应当零依赖」的目录做真实 import。
 * 其余目录（main / renderer）会 import electron / vue，在无依赖环境下必然失败，
 * 因此对它们只做静态检查（见 analyzeImports）。
 */
const LOADABLE_ROOTS = ['src/shared', 'src/types']

function isLoadable(file: string): boolean {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  return LOADABLE_ROOTS.some(r => rel.startsWith(r + '/'))
}

// ---------------------------------------------------------------------------
// 静态 import 分析
// ---------------------------------------------------------------------------

interface ImportRef {
  spec: string
  line: number
  kind: 'relative' | 'alias' | 'builtin' | 'external'
}

function analyzeImports(file: string): ImportRef[] {
  const src = readFileSync(file, 'utf8')
  const refs: ImportRef[] = []
  const re = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const spec = m[1]
    const line = src.slice(0, m.index).split('\n').length
    refs.push({ spec, line, kind: classify(spec) })
  }
  // 动态 import
  const dre = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dre.exec(src)) !== null) {
    const spec = m[1]
    const line = src.slice(0, m.index).split('\n').length
    refs.push({ spec, line, kind: classify(spec) })
  }
  return refs
}

/** 把相对 spec 解析成绝对文件路径（考虑 .ts / /index.ts 补全） */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(join(fromFile, '..'), spec)
  const candidates = [base, base + '.ts', join(base, 'index.ts')]
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {
      /* 继续 */
    }
  }
  return null
}

/** shared 出现这些 spec 就是越界（反向依赖） */
const FORBIDDEN_IN_SHARED = ['@main/', '@renderer/', '@/', '/src/main/', '/src/renderer/']

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const problems: string[] = []
const notes: string[] = []

const allTs = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'scripts')),
  ...walk(join(ROOT, 'tests'))
]

type ImportKind = 'relative' | 'alias' | 'builtin' | 'external'

function classify(spec: string): ImportKind {
  if (spec.startsWith('.')) return 'relative'
  if (spec.startsWith('@')) return 'alias'
  if (spec.startsWith('node:')) return 'builtin'
  return 'external'
}

/** 项目内部的路径别名（Vite 认识，Node 不认识，因此 shared/tests/scripts 禁用） */
const PROJECT_ALIASES = ['@/', '@shared/', '@main/', '@renderer/']

function isProjectAlias(spec: string): boolean {
  return PROJECT_ALIASES.some(a => spec === a.slice(0, -1) || spec.startsWith(a))
}

// ── 1. 静态检查：别名、越界、悬空相对路径 ─────────────────────────────────
let checkedImports = 0
for (const file of allTs) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const inShared = rel.startsWith('src/shared/')
  const inTests = rel.startsWith('tests/') || rel.startsWith('scripts/')

  for (const ref of analyzeImports(file)) {
    checkedImports++

    if (inShared && ref.kind === 'alias') {
      // 只报"项目内部别名"误用；node: / 第三方包名不算
      if (isProjectAlias(ref.spec)) {
        problems.push(`${rel}:${ref.line} shared 内不得使用项目别名 import（Node 无法解析）：${ref.spec}`)
      }
      continue
    }
    if (inShared && FORBIDDEN_IN_SHARED.some(f => ref.spec.includes(f))) {
      problems.push(`${rel}:${ref.line} shared 不得依赖主进程/渲染进程：${ref.spec}`)
      continue
    }
    if ((inTests || inShared) && ref.kind === 'alias' && isProjectAlias(ref.spec)) {
      problems.push(`${rel}:${ref.line} 测试/脚本/shared 不得使用项目别名 import（无法直接执行）：${ref.spec}`)
      continue
    }
    if (ref.kind === 'relative') {
      const resolved = resolveRelative(file, ref.spec)
      if (!resolved) {
        problems.push(`${rel}:${ref.line} 相对 import 无法解析：${ref.spec}`)
        continue
      }
      // 只有「要被 Node 直接执行」的文件才要求带 .ts 扩展名：
      //   shared / scripts / tests 会被 run-tests、gen-error-docs 等脚本直接 import。
      // src/main 与 src/renderer 走 vite 打包，扩展名可省（且省掉更符合常见写法）。
      const needsExt = rel.startsWith('src/shared/') || rel.startsWith('scripts/') || rel.startsWith('tests/')
      if (needsExt && !ref.spec.endsWith('.ts')) {
        problems.push(`${rel}:${ref.line} 相对 import 未带 .ts 扩展名（Node 直接执行会失败）：${ref.spec}`)
      }
    }
  }
}

// ── 2. 运行时检查：零依赖模块必须能真的 import ───────────────────────────
const loadable = allTs.filter(isLoadable).filter(f => !f.includes('src/types'))
let loaded = 0
const loadFailures: Array<{ file: string; error: string }> = []

for (const file of loadable) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  // 跳过只导出类型、没有运行时代码的文件（类型剥离后为空模块，import 无害但仍计入）
  try {
    await import(pathToFileURL(file).href)
    loaded++
    if (VERBOSE) console.log(`  ✓ ${rel}`)
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : String(e)
    loadFailures.push({ file: rel, error: msg })
  }
}

for (const f of loadFailures) {
  problems.push(`${f.file} 无法 import：${f.error}`)
}

// ── 3. 编码健康检查 ──────────────────────────────────────────────────────
/**
 * 两类问题分开处理：
 *   · BOM：本项目统一无 BOM。带 BOM 会让 `--experimental-strip-types` 解析
 *     首字符时偶发异常，也会让某些工具把首行当成注释的一部分。
 *   · 半角片假名（U+FF61–U+FF9F）连续出现：UTF-8 文本被按 GBK/CP936 解码再存回去的
 *     典型残留（例如「録音」会变成「骼ｳ髻ｳ」）。这是**真实损坏**的特征。
 *
 * 刻意不检查「锟斤拷」等中文乱码串 —— 那种字符串在
 * `src/shared/text/encoding.ts` 与测试样本里是**故意写的测试数据**（见 docs/10 §4.4），
 * 一律报警会造成大量误报，反而让检查失去可信度。
 *
 * 另外：本文件自身含检测用的特征字符串，必须排除，否则会自报损坏。
 */
const SELF = relative(ROOT, import.meta.filename).replace(/\\/g, '/')
const HALFWIDTH_KATAKANA = /[\uFF61-\uFF9F]{6,}/  // 连续 6 个以上才算残留，避免误判单个特殊符号
const MOJIBAKE_MARKERS = ['髞', '隶ｾ', '髻ｳ', '蟾ｪ', '騾', '閭ｽ', '霑吩']

for (const file of allTs) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  if (rel === SELF) continue

  const buf = readFileSync(file)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push(`${rel} 含 UTF-8 BOM —— 本项目统一无 BOM，请去除`)
  }
  const text = buf.toString('utf8')
  if (HALFWIDTH_KATAKANA.test(text)) {
    problems.push(`${rel} 疑似编码损坏（含连续半角片假名残留，通常是 UTF-8 被按 GBK 解码后存回）`)
    continue
  }
  for (const marker of MOJIBAKE_MARKERS) {
    if (text.includes(marker)) {
      problems.push(`${rel} 疑似编码损坏（含乱码特征「${marker}」）`)
      break
    }
  }
}

// ── 4. 循环依赖粗检（同目录内互相 import）────────────────────────────────
const graph = new Map<string, string[]>()
for (const file of allTs) {
  const deps: string[] = []
  for (const ref of analyzeImports(file)) {
    if (ref.kind !== 'relative') continue
    const resolved = resolveRelative(file, ref.spec)
    if (resolved) deps.push(resolved)
  }
  graph.set(file, deps)
}
const cycles = findCycles(graph)
for (const c of cycles) {
  problems.push(`循环依赖：${c.map(f => relative(ROOT, f).replace(/\\/g, '/')).join(' -> ')}`)
}

function findCycles(g: Map<string, string[]>): string[][] {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []
  const found: string[][] = []

  const visit = (n: string): void => {
    color.set(n, GRAY)
    stack.push(n)
    for (const d of g.get(n) ?? []) {
      const c = color.get(d) ?? WHITE
      if (c === GRAY) {
        const i = stack.indexOf(d)
        if (i >= 0) found.push([...stack.slice(i), d])
      } else if (c === WHITE) {
        visit(d)
      }
    }
    stack.pop()
    color.set(n, BLACK)
  }

  for (const n of g.keys()) if ((color.get(n) ?? WHITE) === WHITE) visit(n)
  return found
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log('')
console.log('='.repeat(78))
console.log(`[check-structure] 扫描 ${allTs.length} 个 TS/Vue 文件，检查 ${checkedImports} 处 import`)
console.log(`[check-structure] 真实 import 成功 ${loaded}/${loadable.length} 个零依赖模块`)
if (notes.length > 0) {
  console.log(`[check-structure] 提示 ${notes.length} 条（不阻断）：`)
  for (const n of notes.slice(0, 20)) console.log(`  · ${n}`)
  if (notes.length > 20) console.log(`  · …还有 ${notes.length - 20} 条`)
}
console.log('='.repeat(78))

if (problems.length > 0) {
  console.error(`[check-structure] 发现 ${problems.length} 个问题：`)
  for (const p of problems.slice(0, 60)) console.error(`  ✗ ${p}`)
  if (problems.length > 60) console.error(`  ✗ …还有 ${problems.length - 60} 个`)
  process.exit(1)
}

console.log('[check-structure] 结构自检通过 ✓')
