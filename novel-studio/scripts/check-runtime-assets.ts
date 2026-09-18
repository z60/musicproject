/**
 * Novel Studio · 运行时资源复制插件自检（`npm run check:assets`）
 * ============================================================================
 * 它验证一件事：**`RUNTIME_ASSET_DIRS` 声明的资源，真的会被复制到运行时能读到的位置。**
 *
 * ### 为什么需要这个脚本（真实踩过三次坑）
 *   迁移 SQL 是运行时用 `readFileSync(join(dirname(import.meta.url), file))` 读的。
 *   这条路径错一次，应用就「能开窗口、但一张业务表都没有」，而且**极难排查**：
 *
 *     · 第一次：`to = 'main/infra/db/migrations'` → `out/main/main/infra/...`（多套一层）
 *     · 第二次：`to = 'infra/db/migrations'` → 路径**看着像源码树**，但产物里没有这一层
 *     · 真相：electron-vite 把整个主进程**内联成单个** `out/main/index.js`，
 *       于是被内联的 `dirname(import.meta.url)` **就是 outDir 本身**。
 *       真机日志实证：`ENOENT …\out\main\001_init.sql`（文件名在 out/main 下）
 *
 *   两次都是「配置看起来对、运行时读不到」。所以判据不能是「读配置文本」，
 *   必须是**真的执行复制、再用运行时的读回公式读一次**。
 *
 * ### 为什么要绕过 esbuild（本环境的关键技巧）
 *   `npm run build` 走 electron-vite → 先用 esbuild 把 electron.vite.config.ts
 *   打包成一个临时 bundle。本仓库的验证环境**禁止 spawn**（esbuild 起不来，EPERM），
 *   于是配置根本加载不到、插件的 `writeBundle` 也永远跑不起来
 *   —— `npm run check:config` 因此长期是「无法自验的盲区」。
 *
 *   但 Node 22 的 `--experimental-strip-types` 能**直接 import 这个 .ts**：
 *   esbuild 那一步被完全跳过，插件对象可以拿出来单独调用。
 *   于是本脚本能在没有 esbuild 的环境里验证插件的**真实行为**。
 *
 * ### 判据（三条，都是「行为」而不是「文本」）
 *   1. 插件存在、挂的是 `writeBundle`（dev 与 build 都走 vite 插件）
 *   2. 执行后，每个 .sql 都出现在 `<outDir>/<to>` 下，且**内容与源文件逐字节一致**
 *   3. 目标目录必须等于 `<outDir>` 本身 —— 因为运行时按 `<outDir>/<file>` 查找
 *
 * 退出码：0 = 通过；1 = 失败（会打印实际落点与期望落点）
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'

import config from '../electron.vite.config.ts'

const ROOT = process.cwd()

interface CopyAssetPlugin {
  name?: string
  writeBundle?: (this: { info(msg: string): void }, options: { dir?: string }) => void
}

function main(): void {
  console.log('='.repeat(78))
  console.log('[check-assets] 验证运行时资源会被复制到「运行时读得到」的位置')
  console.log('='.repeat(78))

  const mainCfg = (config as { main?: { plugins?: unknown[] } }).main
  if (!mainCfg) {
    console.error('  ✗ 配置里没有 main 段')
    process.exitCode = 1
    return
  }

  const plugins = (mainCfg.plugins ?? []) as CopyAssetPlugin[]
  const plugin = plugins.find((p) => String(p.name).includes('copy-runtime-assets'))
  if (!plugin) {
    console.error(`  ✗ 没找到 copy-runtime-assets 插件（实际插件：${plugins.map((p) => p.name).join(', ') || '无'}）`)
    console.error('    — 少了它，迁移 SQL 不会进产物 → 应用能开窗口但没有任何表')
    process.exitCode = 1
    return
  }
  if (typeof plugin.writeBundle !== 'function') {
    console.error('  ✗ 插件没有 writeBundle —— dev 与 build 都不会触发复制')
    process.exitCode = 1
    return
  }
  console.log(`  ✓ 插件存在：${plugin.name}（挂在 writeBundle）`)

  // 从配置里读出 main.build.outDir，作为「运行时 dirname(import.meta.url)」的期望值
  const outDirCfg = (mainCfg as { build?: { outDir?: string } }).build?.outDir ?? 'out/main'

  const tmpOut = mkdtempSync(join(tmpdir(), 'ns-assets-'))
  let failed = 0
  try {
    const logs: string[] = []
    plugin.writeBundle.call({ info: (m: string) => logs.push(m) }, { dir: tmpOut })

    for (const l of logs) console.log(`    ${l}`)
    console.log('')

    // 源文件清单（作为期望）
    const srcDir = resolve(ROOT, 'src/main/infra/db/migrations')
    const expected = readdirSync(srcDir).filter((n) => n.endsWith('.sql'))

    console.log('  每个文件的两处对账（内容 + 落点）：')
    for (const name of expected) {
      const got = join(tmpOut, name)
      if (!existsSync(got)) {
        console.error(`    ✗ ${name} 没有出现在 <outDir> 下 —— 运行时读不到`)
        failed++
        continue
      }
      const a = readFileSync(got)
      const b = readFileSync(join(srcDir, name))
      if (!a.equals(b)) {
        console.error(`    ✗ ${name} 内容与源文件不一致（复制损坏？）`)
        failed++
        continue
      }
      console.log(`    ✓ ${name}  ${statSync(got).size} B  内容逐字节一致`)
    }

    // 判据 3：目标必须就是 outDir —— 不能出现任何多余层级
    const stray = readdirSync(tmpOut, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    if (stray.length > 0) {
      console.error(`    ✗ <outDir> 下出现了多余目录：${stray.join(', ')}`)
      console.error('      — 运行时按 <outDir>/<file> 查找，放进子目录就永远读不到')
      console.error(`      — 期望 to 解析为 <outDir>（${normalize(resolve(ROOT, outDirCfg))}）本身`)
      failed++
    } else {
      console.log('    ✓ 没有多余层级：to 解析结果正好是 <outDir>')
    }
  } finally {
    rmSync(tmpOut, { recursive: true, force: true })
  }

  console.log('')
  console.log('='.repeat(78))
  if (failed === 0) {
    console.log('[check-assets] 通过 ✓ 迁移 SQL 会被放到运行时能读到的位置')
  } else {
    console.log(`[check-assets] 失败（${failed} 项）`)
    console.log('[check-assets] 先读产物里 migrationsDir 的实际取值，再改 RUNTIME_ASSET_DIRS')
  }
  console.log('='.repeat(78))
  process.exitCode = failed === 0 ? 0 : 1
}

main()
