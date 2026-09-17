/**
 * Novel Studio · 相对 import 层级自动修正
 * ============================================================================
 * 为什么需要这个脚本：
 *   本仓库有一个硬约定 —— `src/shared`、`scripts`、`tests` 内部的相对 import
 *   必须带 `.ts` 扩展名（这些文件要被 Node 直接执行）。而一旦目录层级较深
 *   （如 `src/main/features/book/import/parsers/` 到 `src/shared` 需要 5 级），
 *   手写 `../../..` 极易数错，而且错了之后**类型检查不一定立刻发现**
 *   （Vite 别名能兜住的场景下尤其隐蔽），要到运行时才炸。
 *
 *   实现期已经因此踩过多次：`install.ts`、`registry.ts`、`error-handler.ts`、
 *   `handlers/`、`parsers/`、`template.ts` 都出现过层级数错。
 *
 * 做法：对每个文件，逐个 import 目标**用实际文件系统探测**正确层级，
 *      然后重写。因此它不依赖人工数数，也不会把正确的改错。
 *
 * 用法：
 *   node --experimental-strip-types scripts/fix-relative-imports.ts           # 预览（不写盘）
 *   node --experimental-strip-types scripts/fix-relative-imports.ts --write   # 实际修正
 *   node --experimental-strip-types scripts/fix-relative-imports.ts --check   # 有错则 exit 1（CI）
 *
 * 退出码：0 = 无需修改或已修正；1 = --check 且有错
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const WRITE = process.argv.includes('--write')
const CHECK = process.argv.includes('--check')

/**
 * 需要精确层级的顶层目录。
 * 只处理这些 —— 同目录内的 `./xxx` 相对引用不涉及层级，不需要探测。
 */
const TOP_DIRS = ['shared', 'infra', 'ipc', 'bootstrap', 'features', 'types', 'scripts', 'tests']

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

/**
 * 探测：从 fromDir 出发，几级 `../` 才能到达**顶层的** `<root>/<target>/`。
 *
 * 关键坑（已踩）：光用 `existsSync(base)` 判断会出错 ——
 * 渲染进程也有自己的 `src/renderer/src/shared/` 目录，
 * 从 `src/renderer/src/shared/lib/` 出发的 2 级路径会命中它，于是被误判为「正确」，
 * 实际却指向了错误的模块（顶层 `src/shared` 与渲染进程的 `shared` 是完全不同的东西）。
 *
 * 因此判据加严：目标目录**必须含 index.ts**（barrel），
 * 或指定文件存在（带 `.ts` 补全）。渲染进程的 `shared/` 没有 index.ts，会被排除。
 */
function probeDepth(fromDir: string, target: string, rest?: string): number | null {
  for (let n = 1; n <= 8; n++) {
    const base = resolve(fromDir, '../'.repeat(n) + target)

    // 1) 精确到文件（带 .ts 补全）—— 最可靠
    if (rest) {
      const asFile = rest.endsWith('.ts') ? rest : `${rest}.ts`
      if (existsSync(join(base, asFile))) return n
    }
    // 2) 目录且含 index.ts（barrel）
    if (existsSync(base) && existsSync(join(base, 'index.ts'))) return n
  }
  return null
}

interface Fix {
  file: string
  line: number
  from: string
  to: string
}

const files = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'scripts')),
  ...walk(join(ROOT, 'tests')),
]

const fixes: Fix[] = []
const unresolved: string[] = []

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const dir = dirname(file)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  // 匹配 from '((../)+)(target)/(rest)'
  const re = /from\s+'((?:\.\.\/)+)([a-zA-Z][\w-]*)\/([^']+)'/g

  let m: RegExpExecArray | null
  const replacements: Array<{ index: number; length: number; value: string }> = []

  while ((m = re.exec(text)) !== null) {
    const [full, , target, rest] = m
    if (!TOP_DIRS.includes(target)) continue

    const correct = probeDepth(dir, target, rest)
    if (correct === null) {
      const line = text.slice(0, m.index).split('\n').length
      unresolved.push(`${rel}:${line} 无法为 ${target}/ 找到正确层级（目标可能不存在）`)
      continue
    }

    const want = `from '${'../'.repeat(correct)}${target}/${rest}'`
    if (want !== full) {
      const line = text.slice(0, m.index).split('\n').length
      fixes.push({ file: rel, line, from: full, to: want })
      replacements.push({ index: m.index, length: full.length, value: want })
    }
  }

  if (replacements.length > 0 && WRITE) {
    // 从后往前替换，避免索引位移
    let out = text
    for (const r of replacements.sort((a, b) => b.index - a.index)) {
      out = out.slice(0, r.index) + r.value + out.slice(r.index + r.length)
    }
    writeFileSync(file, out, 'utf8')
  }

  void lines
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('='.repeat(78))
console.log(`[fix-imports] 扫描 ${files.length} 个文件`)

if (unresolved.length > 0) {
  console.log(`\n无法解析的目标（${unresolved.length} 处，需人工确认）：`)
  for (const u of unresolved.slice(0, 20)) console.log(`  ?? ${u}`)
  if (unresolved.length > 20) console.log(`  ?? …还有 ${unresolved.length - 20} 处`)
}

if (fixes.length === 0) {
  console.log('\n[fix-imports] 所有相对 import 层级正确 ✓')
  console.log('='.repeat(78))
  process.exit(0)
}

console.log(`\n需要修正的层级（${fixes.length} 处）：`)
for (const f of fixes.slice(0, 40)) {
  console.log(`  ${f.file}:${f.line}`)
  console.log(`      ${f.from}`)
  console.log(`   -> ${f.to}`)
}
if (fixes.length > 40) console.log(`  …还有 ${fixes.length - 40} 处`)

console.log('')
if (WRITE) {
  console.log(`[fix-imports] 已修正 ${fixes.length} 处`)
  console.log('='.repeat(78))
  process.exit(0)
}
if (CHECK) {
  console.error(`[fix-imports] 存在 ${fixes.length} 处层级错误，请运行 npm run fix:imports`)
  console.log('='.repeat(78))
  process.exit(1)
}
console.log('[fix-imports] 这是预览模式，未写盘。加 --write 实际修正。')
console.log('='.repeat(78))
