/**
 * Novel Studio · 渲染进程结构自检（无 Vue 环境下的主要验证手段）
 * ============================================================================
 * 为什么需要它：
 *   本仓库当前**没有安装** vue / vue-router / pinia / element-plus（无网络），
 *   因此渲染进程代码无法真正编译与渲染。能做的最强验证是「结构 + 引用」静态检查：
 *     1. 每个 .vue 的 SFC 结构是否完整（模板/脚本/样式标签成对、必须是 <script setup lang="ts">）
 *     2. 每个 import 是否指向真实存在的文件（相对路径、`@/`、`@shared/`、index 补全、扩展名补全）
 *     3. 外部依赖是否都在 package.json 里声明（防止写出 'elementplus' 这类拼写错误）
 *     4. 是否违反文档硬性约束：禁止组件直接 `window.api.invoke`（docs/22 §6.2）
 *     5. 汇编「未被任何文件引用的组件」与「被引用但不存在的路径」清单
 *
 * 用法：
 *   node --experimental-strip-types scripts/check-renderer.ts
 *   node --experimental-strip-types scripts/check-renderer.ts --verbose
 *
 * 退出码：0 = 全部通过；1 = 存在阻塞问题（结构错误 / 引用不存在 / 依赖未声明 / 违规调用）。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RENDERER_SRC = join(ROOT, 'src', 'renderer', 'src')
const SHARED_SRC = join(ROOT, 'src', 'shared')
const PKG_PATH = join(ROOT, 'package.json')

const ALIASES: Array<{ prefix: string; dir: string }> = [
  { prefix: '@renderer/', dir: RENDERER_SRC },
  { prefix: '@/', dir: RENDERER_SRC },
  { prefix: '@shared/', dir: SHARED_SRC },
]

/** 允许不带扩展名的别名（Node 侧的仓库约定要求 @shared 带 .ts，这里不强制，只提示） */
const EXTENSIONS = ['.ts', '.tsx', '.vue', '.js', '.mjs', '.json', '.d.ts', '.css', '.scss', '.sass', '.less', '.svg', '.png', '.webp']

interface Issue {
  file: string
  kind: string
  message: string
}

interface FileInfo {
  /** 相对仓库根目录、以 / 分隔 */
  rel: string
  abs: string
  kind: 'vue' | 'ts'
  /** 该文件 import 的模块说明符（已去重） */
  imports: string[]
  /** 是否被其它文件 import */
  used: boolean
  isView: boolean
  isComponent: boolean
  isStore: boolean
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const verbose = process.argv.includes('--verbose')

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function rel(abs: string): string {
  return toPosix(relative(ROOT, abs))
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(abs, out)
    } else if (entry.isFile()) {
      out.push(abs)
    }
  }
  return out
}

function readText(abs: string): string {
  return readFileSync(abs, 'utf8')
}

// ---------------------------------------------------------------------------
// import 提取
// ---------------------------------------------------------------------------

/** 从源码里提取所有静态 import / 动态 import() / export ... from 的说明符 */
function extractImports(code: string): string[] {
  const specs = new Set<string>()

  // import ... from 'x'  |  export ... from 'x'
  const staticRe = /(?:^|[\s;{(])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g
  // import 'x'（副作用导入）
  const sideEffectRe = /(?:^|[\s;{(])import\s*['"]([^'"]+)['"]/g
  // await import('x') / import('x')
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

  for (const re of [staticRe, sideEffectRe, dynamicRe]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      if (m[1]) specs.add(m[1])
    }
  }

  return [...specs]
}

/** 解析说明符 → 实际文件；返回 null 表示解析不到 */
function resolveImport(spec: string, fromAbs: string): string | null {
  // 1) 别名
  for (const alias of ALIASES) {
    if (spec.startsWith(alias.prefix)) {
      const rest = spec.slice(alias.prefix.length)
      return resolveWithExtensions(join(alias.dir, rest))
    }
  }

  // 2) 相对路径
  if (spec.startsWith('.')) {
    return resolveWithExtensions(resolve(dirname(fromAbs), spec))
  }

  // 3) 外部包
  return null
}

/** 依次尝试：原样 → 各扩展名 → 目录下的 index */
function resolveWithExtensions(base: string): string | null {
  const candidates: string[] = [base]

  // 已带扩展名（含 .css/.vue/.json 等任意后缀）时不再追加，避免 `x.css.ts` 这种误判
  const hasExt = /\.[A-Za-z0-9]+$/.test(base)
  if (!hasExt) {
    for (const ext of EXTENSIONS) candidates.push(base + ext)
  }
  // `./x` 可能指向 `./x/index.ts`
  for (const ext of EXTENSIONS) candidates.push(join(base, `index${ext}`))

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function isExternal(spec: string): boolean {
  return !spec.startsWith('.') && !ALIASES.some(a => spec.startsWith(a.prefix))
}

/** 外部包名（`element-plus/dist/x` → `element-plus`；`@scope/pkg/x` → `@scope/pkg`） */
function packageNameOf(spec: string): string {
  const parts = spec.split('/')
  if (spec.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0] ?? spec
}

// ---------------------------------------------------------------------------
// 声明依赖表
// ---------------------------------------------------------------------------

interface Pkg {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function loadDeclaredPackages(): Set<string> {
  const names = new Set<string>([
    // Node 内置与 Electron 运行期注入
    'electron',
    // 子路径导入（vite 注入）
    'vite/client',
  ])
  if (existsSync(PKG_PATH)) {
    const pkg = JSON.parse(readText(PKG_PATH)) as Pkg
    for (const name of Object.keys(pkg.dependencies ?? {})) names.add(name)
    for (const name of Object.keys(pkg.devDependencies ?? {})) names.add(name)
    // Electron 内建模块（渲染进程里也可能 import type）
    for (const extra of ['electron/main', 'electron/renderer', 'electron/common']) names.add(extra)
  }
  return names
}

// ---------------------------------------------------------------------------
// SFC 结构检查
// ---------------------------------------------------------------------------

const VUE_BLOCK_RE = /<\/?(template|script|style)\b[^>]*>/g

/** 去掉注释，避免把注释里出现的 window.api.invoke / ElMessage 当成真实代码 */
function stripComments(code: string): string {
  return code
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function checkVueStructure(abs: string, code: string, issues: Issue[]): void {
  const file = rel(abs)

  // 1) 转义过的注释（`&lt;!--`）会让 SFC 编译器把注释当文本 —— 这是上一轮留下的坑
  if (/^\s*&lt;!--/.test(code)) {
    issues.push({
      file,
      kind: 'sfc-escaped-comment',
      message: '文件开头的注释是 HTML 转义形式（&lt;!--），SFC 编译会失败；请改成 <!-- -->',
    })
  }

  // 2) 顶层块统计。
  //    注意：<template v-if> 这类**嵌套** template 是合法写法，不能当成第二个块。
  //    因此用栈做深度跟踪，只统计深度为 0 的块标签。
  const topLevel: Record<'template' | 'script' | 'style', number> = { template: 0, script: 0, style: 0 }
  const limits: Record<'template' | 'script' | 'style', number> = { template: 0, script: 0, style: 0 }
  const stack: string[] = []
  const blockTags: Array<{ tag: string; attrs: string }> = []
  const unbalanced: string[] = []

  VUE_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = VUE_BLOCK_RE.exec(code)) !== null) {
    const raw = m[0]
    const tag = m[1] as 'template' | 'script' | 'style'
    if (raw.startsWith('</')) {
      const top = stack.pop()
      if (top !== tag) unbalanced.push(`</${tag}>`)
      limits[tag]++
    } else {
      if (stack.length === 0) topLevel[tag]++
      stack.push(tag)
      blockTags.push({ tag, attrs: raw })
      limits[tag]++
    }
  }

  if (unbalanced.length) {
    issues.push({
      file,
      kind: 'sfc-unbalanced',
      message: `标签不配平：${unbalanced.join('、')} 没有对应的开始标签`,
    })
  }
  if (stack.length) {
    issues.push({
      file,
      kind: 'sfc-unbalanced',
      message: `标签不配平：<${stack.join('> <')}> 未闭合`,
    })
  }

  // 3) 必须有 <template> 与 <script setup lang="ts">
  if (topLevel.template === 0) {
    issues.push({ file, kind: 'sfc-missing-template', message: '缺少 <template> 块' })
  }
  if (topLevel.template > 1) {
    issues.push({ file, kind: 'sfc-multiple-template', message: `有 ${topLevel.template} 个顶级 <template> 块，只允许 1 个` })
  }
  if (topLevel.script === 0) {
    issues.push({ file, kind: 'sfc-missing-script', message: '缺少 <script> 块' })
  }
  if (topLevel.script > 1) {
    issues.push({ file, kind: 'sfc-multiple-script', message: `有 ${topLevel.script} 个顶级 <script> 块，只允许 1 个` })
  }

  const scriptTag = blockTags.find(b => b.tag === 'script')
  if (scriptTag) {
    if (!/\bsetup\b/.test(scriptTag.attrs)) {
      issues.push({ file, kind: 'sfc-not-setup', message: '<script> 缺少 setup 属性（本项目统一用 <script setup>）' })
    }
    if (!/\blang\s*=\s*["']ts["']/.test(scriptTag.attrs)) {
      issues.push({ file, kind: 'sfc-not-ts', message: '<script> 缺少 lang="ts"' })
    }
  }

  // 4) 占位内容检查（不允许「待实现」这种空壳组件）
  const templateBody = extractBlock(code, 'template')
  if (templateBody && topLevel.template === 1) {
    const body = templateBody.trim()
    if (!body) {
      issues.push({ file, kind: 'sfc-empty-template', message: '<template> 是空的（不允许占位组件）' })
    } else if (/^(待实现|TODO|todo|占位)/.test(body)) {
      issues.push({ file, kind: 'sfc-placeholder', message: '<template> 是占位内容，必须是真实布局' })
    }
  }

  // 5) defineProps / defineEmits 必须是类型化写法
  const scriptBody = extractBlock(code, 'script') ?? ''
  const propsMatch = /\bdefineProps\s*(<|\()/.exec(scriptBody)
  if (propsMatch && propsMatch[1] === '(') {
    issues.push({
      file,
      kind: 'props-untyped',
      message: 'defineProps 使用了运行时对象字面量，请改成 defineProps<{...}>() 类型化写法',
    })
  }
  const emitsMatch = /\bdefineEmits\s*(<|\()/.exec(scriptBody)
  if (emitsMatch && emitsMatch[1] === '(') {
    issues.push({
      file,
      kind: 'emits-untyped',
      message: 'defineEmits 使用了运行时数组/对象，请改成 defineEmits<{...}>() 类型化写法',
    })
  }
}

function extractBlock(code: string, tag: 'template' | 'script' | 'style'): string | null {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`)
  const open = openRe.exec(code)
  if (!open) return null
  const start = open.index + open[0].length
  const end = code.indexOf(`</${tag}>`, start)
  if (end < 0) return null
  return code.slice(start, end)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const issues: Issue[] = []
  const warnings: Issue[] = []
  const declared = loadDeclaredPackages()

  if (!existsSync(RENDERER_SRC)) {
    console.error(`[check-renderer] 找不到渲染进程目录：${RENDERER_SRC}`)
    process.exit(1)
  }

  const files = walk(RENDERER_SRC).filter(f => f.endsWith('.vue') || f.endsWith('.ts'))
  const infos: FileInfo[] = []
  const byAbs = new Map<string, FileInfo>()

  for (const abs of files) {
    const code = readText(abs)
    const info: FileInfo = {
      rel: rel(abs),
      abs,
      kind: abs.endsWith('.vue') ? 'vue' : 'ts',
      imports: extractImports(code),
      used: false,
      isView: /[\\/]views[\\/]/.test(abs) || /View\.vue$/.test(abs),
      isComponent: abs.endsWith('.vue'),
      isStore: /\.store\.ts$/.test(abs),
    }
    infos.push(info)
    byAbs.set(abs, info)

    if (info.kind === 'vue') checkVueStructure(abs, code, issues)

    // 注释里出现这些词是说明性文字，不算违规
    const codeOnly = stripComments(code)

    // 违规调用：组件/store 直接调 window.api.invoke（docs/22 §6.2 只允许 shared/lib/ipc.ts）
    const isIpcClient = toPosix(abs).endsWith('renderer/src/shared/lib/ipc.ts')
      || toPosix(abs).endsWith('renderer/src/shared/lib/error-bus.ts')
    if (!isIpcClient && /\bwindow\.api\.invoke\b/.test(codeOnly)) {
      issues.push({
        file: info.rel,
        kind: 'direct-ipc',
        message: '直接调用了 window.api.invoke（必须走 shared/lib/ipc.ts 的 call）',
      })
    }
    if (!isIpcClient && /\bwindow\.api\.(send|on)\b/.test(codeOnly)
      && !toPosix(abs).endsWith('renderer/src/shared/lib/task-progress.ts')) {
      warnings.push({
        file: info.rel,
        kind: 'direct-ipc-send',
        message: '直接用了 window.api.send/on，建议改走 shared/lib/ipc.ts 的 send/on 包装',
      })
    }

    // 提示级：组件里自己弹提示（应统一走 error-bus）
    const isAppEntry = toPosix(abs).endsWith('renderer/src/app/main.ts')
    if (!isAppEntry && !isIpcClient && /\bElMessage(Box)?\b/.test(codeOnly)) {
      warnings.push({
        file: info.rel,
        kind: 'direct-message',
        message: '直接用 ElMessage/ElMessageBox 弹提示，消息展示应统一走 error-bus（docs/22 §6.2）',
      })
    }
  }

  // ---- 依赖解析 ----
  const missing: Issue[] = []
  const externalUnknown: Issue[] = []
  const sharedNoExt: Issue[] = []

  for (const info of infos) {
    for (const spec of info.imports) {
      if (isExternal(spec)) {
        if (spec.startsWith('node:')) continue
        const name = packageNameOf(spec)
        if (!declared.has(name) && !declared.has(spec)) {
          externalUnknown.push({
            file: info.rel,
            kind: 'unknown-package',
            message: `未在 package.json 声明的依赖：${spec}`,
          })
        }
        continue
      }

      const resolved = resolveImport(spec, info.abs)
      if (!resolved) {
        missing.push({
          file: info.rel,
          kind: 'unresolved-import',
          message: `import 指向不存在的文件：${spec}`,
        })
        continue
      }

      // @shared 的仓库约定：相对 import 带 .ts 扩展名（package.json comments.import-ext）
      if (spec.startsWith('@shared/') && !spec.endsWith('.ts') && !spec.endsWith('.json')) {
        sharedNoExt.push({
          file: info.rel,
          kind: 'shared-missing-ext',
          message: `@shared 引用建议带 .ts 扩展名（当前：${spec}）`,
        })
      }
      // 渲染侧内部引用：仓库统一写全扩展名（便于静态检查与工具链一致）
      if ((spec.startsWith('@/') || spec.startsWith('@renderer/')) && !/\.[A-Za-z0-9]+$/.test(spec)) {
        sharedNoExt.push({
          file: info.rel,
          kind: 'alias-missing-ext',
          message: `@/ 引用建议写全扩展名（当前：${spec}）`,
        })
      }

      const target = byAbs.get(resolved)
      if (target) target.used = true
      else if (resolved.endsWith('.vue')) {
        // 目标 .vue 未被扫描到（理论上不会发生）
        warnings.push({ file: info.rel, kind: 'resolve-odd', message: `解析到未纳入扫描的文件：${spec}` })
      }
    }
  }

  issues.push(...missing, ...externalUnknown)
  warnings.push(...sharedNoExt)

  // ---- 未使用的组件 ----
  const unusedComponents = infos
    .filter(i => i.kind === 'vue' && !i.used && !/App\.vue$/.test(i.rel))
    .map(i => i.rel)

  // ---- 汇总 ----
  const vueFiles = infos.filter(i => i.kind === 'vue')
  const tsFiles = infos.filter(i => i.kind === 'ts')
  const views = infos.filter(i => i.isView)
  const stores = infos.filter(i => i.isStore)
  const dirs = new Set(infos.map(i => dirname(i.rel)))

  const line = '─'.repeat(78)
  console.log(line)
  console.log('Novel Studio · 渲染进程结构自检')
  console.log(line)
  console.log(`扫描目录        ${rel(RENDERER_SRC)}`)
  console.log(`文件数          ${infos.length}（.vue ${vueFiles.length} / .ts ${tsFiles.length}）`)
  console.log(`组件数          ${vueFiles.length}（其中视图 ${views.length}）`)
  console.log(`store 数        ${stores.length}`)
  console.log(`目录数          ${dirs.size}`)
  console.log(line)

  const groupBy = (list: Issue[]): Map<string, Issue[]> => {
    const map = new Map<string, Issue[]>()
    for (const issue of list) {
      const arr = map.get(issue.kind) ?? []
      arr.push(issue)
      map.set(issue.kind, arr)
    }
    return map
  }

  if (issues.length) {
    console.log(`【问题】${issues.length} 项（阻塞）`)
    for (const [kind, list] of groupBy(issues)) {
      console.log(`  · ${kind}（${list.length}）`)
      for (const issue of (verbose ? list : list.slice(0, 12))) {
        console.log(`      ${issue.file} — ${issue.message}`)
      }
      if (!verbose && list.length > 12) console.log(`      … 其余 ${list.length - 12} 项用 --verbose 查看`)
    }
  } else {
    console.log('【问题】0 项 ✓')
  }

  console.log('')
  if (warnings.length) {
    console.log(`【提示】${warnings.length} 项（不阻塞）`)
    for (const [kind, list] of groupBy(warnings)) {
      console.log(`  · ${kind}（${list.length}）`)
      for (const issue of (verbose ? list : list.slice(0, 8))) {
        console.log(`      ${issue.file} — ${issue.message}`)
      }
      if (!verbose && list.length > 8) console.log(`      … 其余 ${list.length - 8} 项用 --verbose 查看`)
    }
  } else {
    console.log('【提示】0 项 ✓')
  }

  console.log('')
  console.log(`【未被引用的组件】${unusedComponents.length} 个`)
  if (unusedComponents.length) {
    for (const file of (verbose ? unusedComponents : unusedComponents.slice(0, 20))) {
      console.log(`      ${file}`)
    }
    if (!verbose && unusedComponents.length > 20) {
      console.log(`      … 其余 ${unusedComponents.length - 20} 个用 --verbose 查看`)
    }
  }

  console.log('')
  console.log(line)
  console.log(`结果：文件数 ${infos.length} / 组件数 ${vueFiles.length} / store 数 ${stores.length} / 问题数 ${issues.length}`)
  console.log(line)

  if (issues.length) {
    console.error(`[check-renderer] 失败：${issues.length} 项阻塞问题`)
    process.exit(1)
  }
  console.log('[check-renderer] 通过 ✓')
}

main()
