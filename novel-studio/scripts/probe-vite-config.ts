/**
 * Novel Studio · 诊断探针：在 Electron 里跑 esbuild，验证 electron-vite 配置能否加载
 * ============================================================================
 * ### 为什么需要这个（很绕，但解决一个真实盲区）
 *   `electron-vite` 启动时**先用 esbuild 把 `electron.vite.config.ts` 打成临时 bundle**。
 *   而 esbuild 的原生实现会 fork 一个常驻子进程 —— 在受限环境里这步会
 *   `spawn EPERM`，于是配置里的错误**根本看不到**（连语法错误都报不出来）。
 *
 *   而 Electron 自己是能 spawn 的（它就是靠 spawn 做多进程）。所以：
 *   **借 Electron 的子进程能力来跑 esbuild**，就能在本环境里验证配置。
 *
 * 做法：起一个 Electron 进程，在里面调用 esbuild 的 JS API 打包配置文件。
 * 因为此时进程是 Electron（不是受限的 node 沙箱进程），spawn 可以成功。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-vite-config.ts
 *
 * 退出码：0 = 配置能被 esbuild 成功打包；1 = 打包失败（会打印 esbuild 的定位信息）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function electronBinary(): string | null {
  const pkgDir = join(ROOT, 'node_modules', 'electron')
  if (process.platform === 'win32') {
    const exe = join(pkgDir, 'dist', 'electron.exe')
    return existsSync(exe) ? exe : null
  }
  const pathTxt = join(pkgDir, 'path.txt')
  if (!existsSync(pathTxt)) return null
  const full = join(pkgDir, 'dist', readFileSync(pathTxt, 'utf8').trim())
  return existsSync(full) ? full : null
}

/** 探针：在 Electron 主进程里用 esbuild 打包配置文件，把结果报回来 */
const PROBE = `
const { app } = require('electron')
const path = require('node:path')

async function run() {
  const root = process.env.NS_ROOT
  let out
  try {
    const esbuild = require(path.join(root, 'node_modules', 'esbuild'))
    const result = await esbuild.build({
      entryPoints: [path.join(root, 'electron.vite.config.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      // 与 electron-vite 一致：外部依赖不打包（它会自己 resolve）
      external: [
        'electron-vite', 'vite', '@vitejs/plugin-vue',
        'unplugin-auto-import/vite', 'unplugin-vue-components/vite',
        'unplugin-vue-components/resolvers',
      ],
    })
    const bytes = result.outputFiles && result.outputFiles[0] ? result.outputFiles[0].contents.length : 0
    out = ['OK   配置打包成功，产物 ' + bytes + ' B']
  } catch (e) {
    const lines = ['FAIL 配置打包失败']
    const errs = (e && e.errors) || []
    for (const m of errs) {
      const loc = m.location ? ' @' + m.location.file + ':' + m.location.line + ':' + m.location.column : ''
      lines.push('     ' + m.text + loc)
    }
    if (errs.length === 0) lines.push('     ' + String(e && e.message ? e.message : e).split('\\n')[0])
    out = lines
  }
  process.stdout.write('\\n===PROBE_BEGIN===\\n' + out.join('\\n') + '\\n===PROBE_END===\\n')
  app.exit(out[0].startsWith('OK') ? 0 : 1)
}

app.whenReady().then(run)
`

function main(): void {
  console.log('='.repeat(78))
  console.log('[probe-vite-config] 借 Electron 的 spawn 能力验证 electron-vite 配置')
  console.log('='.repeat(78))

  const exe = electronBinary()
  if (!exe) {
    console.error('  ✗ 找不到 Electron 二进制。先执行：npm run ensure:electron')
    process.exitCode = 1
    return
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ns-vite-cfg-'))
  const probe = join(tmp, 'probe.cjs')
  writeFileSync(probe, PROBE)

  // 必须清掉 ELECTRON_RUN_AS_NODE：它会让 Electron 以纯 Node 模式启动，
  // 那样就失去「借用 Electron 的子进程能力」这个前提，esbuild 依然会 EPERM。
  const { ELECTRON_RUN_AS_NODE: _drop, ...restEnv } = process.env
  void _drop
  const env: NodeJS.ProcessEnv & { NS_ROOT: string } = { ...restEnv, NS_ROOT: ROOT }

  const r = spawnSync(exe, ['--no-sandbox', probe], { cwd: ROOT, encoding: 'utf8', env, timeout: 120_000 })
  if (r.error) {
    console.error(`  ✗ 无法启动 Electron：${r.error.message}`)
    process.exitCode = 1
    return
  }

  const stdout = r.stdout ?? ''
  const begin = stdout.indexOf('===PROBE_BEGIN===')
  const end = stdout.indexOf('===PROBE_END===')
  console.log('')
  if (begin >= 0 && end > begin) {
    for (const line of stdout.slice(begin + 18, end).trim().split('\n')) console.log(`  ${line}`)
  } else {
    console.error('  探针无预期输出，原始 stdout：')
    console.error(stdout.slice(0, 1500))
    if (r.stderr) console.error(String(r.stderr).slice(0, 1500))
  }
  console.log('='.repeat(78))
  process.exitCode = r.status === 0 ? 0 : 1
}

main()
