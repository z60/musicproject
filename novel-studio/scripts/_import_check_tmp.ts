/**
 * 临时自检脚本（不属于交付物）：跨模块 import 一致性检查。
 *
 * 背景：本仓库由多个并行工作流共同产出，容易出现「A 模块 import 了 B 模块里不存在
 * 的类型/值」。类型 import 在运行期会被擦除，所以 `node` 跑测试不会报错，
 * 但 `tsc` 会失败 —— 在没有 tsc 的环境里必须用文本比对兜住。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

const root = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue
      walk(full, out)
    } else if (/\.(ts|mts|cts)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const files = [...walk(join(root, 'src')), ...walk(join(root, 'tests')), ...walk(join(root, 'scripts'))]

/** 收集一个模块导出的名字（含 type/interface/值） */
function exportedNames(file: string): Set<string> {
  const src = readFileSync(file, 'utf8')
  const names = new Set<string>()
  const patterns = [
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|const|let|var|function|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|type|class|const|let|var|function|enum)\s+([A-Za-z_$][\w$]*)/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) names.add(m[1] as string)
  }
  // export { A, B as C } (含 from)
  const reExport = /\bexport\s*(?:type\s*)?\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/g
  let m: RegExpExecArray | null
  while ((m = reExport.exec(src)) !== null) {
    for (const part of (m[1] as string).split(',')) {
      const seg = part.trim()
      if (!seg) continue
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(seg)
      names.add(asMatch ? (asMatch[1] as string) : seg.replace(/^type\s+/, ''))
    }
  }
  // export * from './x.ts' → 递归（一行深度即可）
  const reStar = /\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g
  while ((m = reStar.exec(src)) !== null) {
    const spec = m[1] as string
    if (!spec.endsWith('.ts')) continue
    const target = resolve(dirname(file), spec)
    try {
      for (const n of exportedNames(target)) names.add(n)
    } catch {
      /* ignore */
    }
  }
  return names
}

interface ImportRef {
  from: string
  names: string[]
  typeOnly: boolean
  file: string
  line: number
}

const imports: ImportRef[] = []
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const re = /\bimport\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const spec = m[4] as string
    if (!spec.startsWith('.')) continue // 只检查仓库内相对导入
    const namesPart = m[3] ?? ''
    const names = namesPart
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
      // 别名导入（`A as B`）要校验的是**原始导出名 A**
      .map((s) => s.split(/\s+as\s+/)[0]!.trim())
    if (m[2]) names.push(m[2]) // default import
    imports.push({
      from: spec,
      names,
      typeOnly: Boolean(m[1]),
      file: file.replace(root + '\\', '').replace(/\\/g, '/'),
      line: src.slice(0, m.index).split('\n').length,
    })
  }
}

const cache = new Map<string, Set<string>>()
let problems = 0
for (const imp of imports) {
  const abs = resolve(dirname(join(root, imp.file)), imp.from)
  let exports: Set<string>
  try {
    exports = cache.get(abs) ?? exportedNames(abs)
    cache.set(abs, exports)
  } catch {
    console.log(`MISSING-FILE  ${imp.file}:${imp.line}  ->  ${imp.from}`)
    problems++
    continue
  }
  for (const name of imp.names) {
    if (name === 'default' || name === '*') continue
    if (!exports.has(name)) {
      const rel = abs.replace(root + '\\', '').replace(/\\/g, '/')
      console.log(`MISSING-EXPORT  ${imp.file}:${imp.line}  ${name}  from  ${rel}`)
      problems++
    }
  }
}
console.log(`checked ${imports.length} relative imports across ${files.length} files; problems=${problems}`)
