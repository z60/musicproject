/**
 * Novel Studio · 测试期的路径别名解析（`@shared/` 与 `@/`）
 * ============================================================================
 * 为什么需要它：
 *   渲染进程的源码按仓库约定使用别名（`@shared/types.ts`、`@/shared/lib/...`），
 *   那是 Vite 的解析规则。而测试跑在 **Node** 里（`node --experimental-strip-types`），
 *   Node 不读 `tsconfig.json` 的 `paths`，于是「任何引用了别名的渲染侧模块」都无法被单测覆盖 ——
 *   包括 `useCanvasFilter.ts` 这种**纯逻辑但被真机事故砸中过**的文件（docs/91 §5.2.27：
 *   别名 + 值传递导致筛选恒为空，而我们当时连一条能钉住它的测试都写不了）。
 *
 * 这个加载器只做一件事：把两个别名映射到真实文件路径。
 *   · `@shared/x.ts` → `src/shared/x.ts`
 *   · `@/x.ts`       → `src/renderer/src/x.ts`
 * 其它一切（相对路径、node: 内置、第三方包）原样交给 Node 自己的解析。
 *
 * 使用方式：在 Worker 的 `execArgv` 里加 `--import ./scripts/test-alias-loader.mjs`
 * （见 `scripts/run-tests.ts` 的说明）。**改这里要跑一遍全量测试**，
 * 因为所有测试 Worker 都会经过它。
 */

import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** 仓库根（本文件在 scripts/ 下） */
const ROOT = join(here, '..')

const ALIASES = [
  { prefix: '@shared/', target: join(ROOT, 'src/shared/') },
  { prefix: '@/', target: join(ROOT, 'src/renderer/src/') },
]

/** 把别名说明符换成真实的 `file://` URL；不是别名就返回 null（交给 Node） */
export function resolveAlias(specifier) {
  for (const alias of ALIASES) {
    if (!specifier.startsWith(alias.prefix)) continue
    const rest = specifier.slice(alias.prefix.length)
    // 别名只用于源码文件；`@shared/x.ts` 这种带扩展名的写法是仓库约定
    return pathToFileURL(join(alias.target, rest)).href
  }
  return null
}

/**
 * 相对说明符补 `.ts` 后缀。
 *
 * 渲染侧源码里存在省略扩展名的相对 import（Vite 能解析，Node ESM 不能），
 * 例如 `./ipc`。测试期补上即可 —— **这是测试期的解析宽容，不改生产代码**：
 * 生产走 Vite，行为不变。
 */
export function resolveExtensionless(specifier, parentURL) {
  if (!parentURL || !parentURL.startsWith('file:')) return null
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  const last = specifier.split('/').pop() ?? ''
  if (last.includes('.')) return null
  const candidate = join(dirname(fileURLToPath(parentURL)), `${specifier}.ts`)
  return existsSync(candidate) ? pathToFileURL(candidate).href : null
}

/** Node 的模块解析钩子（loader API） */
export async function resolve(specifier, context, nextResolve) {
  const mapped = resolveAlias(specifier) ?? resolveExtensionless(specifier, context.parentURL)
  if (mapped) {
    return nextResolve(mapped, context)
  }
  return nextResolve(specifier, context)
}
