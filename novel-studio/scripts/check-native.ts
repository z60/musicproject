/**
 * Novel Studio · 在 Electron 里验证原生模块能否加载（**唯一的权威验证**）
 * ============================================================================
 * 为什么需要它：
 *   原生模块的 ABI 是否匹配，**没有离线判据**。
 *   我们试过并否决了两种「看起来能行」的办法：
 *
 *     1. 读 `.node` 的 PE 可选头 `MajorImageVersion` —— 实测该字段是 0，
 *        Node 原生模块根本不把 NODE_MODULE_VERSION 放在那里（编译器默认值）。
 *     2. 在 Node 里 `require()` 一下看是否报错 —— **也不可靠**：
 *        better-sqlite3 的入口带降级逻辑（原生绑定加载失败时不必然抛错），
 *        实测 Node（ABI 127）加载 Electron 版（ABI 125）的二进制**成功返回**，
 *        这一路把「ABI 不匹配」这个事实完全掩盖了。
 *
 *   剩下唯一可信的做法：**在 Electron 运行时里真的 require 一次，把结果打出来**。
 *   本脚本就是这么做的 —— 用 `electron --no-sandbox -i` 跑一段脚本。
 *
 * 用法：
 *   node --experimental-strip-types scripts/check-native.ts
 *
 * 退出码：0 = 全部可加载；1 = 有模块加载失败（会打印原始错误）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()

/** 需要在 Electron 里验证的模块（按「打开应用必需」的顺序） */
const MODULES = ['better-sqlite3'] as const

function electronBinary(): string | null {
  const pkgDir = join(ROOT, 'node_modules', 'electron')
  if (process.platform === 'win32') {
    const exe = join(pkgDir, 'dist', 'electron.exe')
    return existsSync(exe) ? exe : null
  }
  const pathTxt = join(pkgDir, 'path.txt')
  if (!existsSync(pathTxt)) return null
  const rel = readFileSync(pathTxt, 'utf8').trim()
  const full = join(pkgDir, 'dist', rel)
  return existsSync(full) ? full : null
}

/**
 * 要在 Electron 里执行的探针脚本。
 *
 * ### 为什么用**绝对路径** require
 *   探针文件写在系统临时目录（`os.tmpdir()`），而 Node 的模块解析是
 *   「从当前文件所在目录逐级往上找 node_modules」。临时目录下没有 node_modules，
 *   于是会报 `Cannot find module 'better-sqlite3'` ——
 *   **这个报错看起来像 ABI 问题，其实完全不是**，很容易被误判（我第一次就踩了）。
 *
 *   所以这里把模块的绝对路径直接嵌进探针源码，用 `require(absPath)` 加载，
 *   不再依赖任何解析规则。
 *
 * ### 必须自己 exit
 *   Electron 会一直等着应用退出；不显式 `app.exit()` 会让命令永久挂住（且看不到输出）。
 */
function probeSource(modules: ReadonlyArray<{ name: string; absPath: string }>): string {
  return `
const { app } = require('electron')
const targets = ${JSON.stringify(modules)}
const out = []
let failed = 0
for (const t of targets) {
  try {
    // 真的把原生绑定用起来：开一个内存库并跑一条 SQL。
    // 只 require 不足以证明可用（better-sqlite3 的入口带降级逻辑）。
    const mod = require(t.absPath)
    let detail = 'require 成功'
    if (t.name === 'better-sqlite3') {
      const db = new mod(':memory:')
      const row = db.prepare('select sqlite_version() as v').get()
      detail = '可用，SQLite ' + row.v
      db.close()
    }
    out.push('OK   ' + t.name + ' — ' + detail)
  } catch (e) {
    failed++
    out.push('FAIL ' + t.name + ' — ' + String(e && e.message ? e.message : e).split('\\n')[0])
  }
}
process.stdout.write('\\n===PROBE_BEGIN===\\n' + out.join('\\n') + '\\n===PROBE_END===\\n')
app.exit(failed === 0 ? 0 : 1)
`
}

function main(): void {
  console.log('='.repeat(78))
  console.log('[check-native] 在 Electron 里验证原生模块（ABI 的唯一权威判据）')
  console.log('='.repeat(78))

  const exe = electronBinary()
  if (!exe) {
    console.error('[check-native] 找不到 Electron 二进制。先执行：npm run ensure:electron')
    process.exitCode = 1
    return
  }
  console.log(`  Electron 可执行文件：${exe}`)

  // 先把每个模块的绝对路径解析出来；模块不存在时**直接说清楚**，
  // 而不是把它混进「ABI 问题」里（两者处理方式完全不同）
  const targets: Array<{ name: string; absPath: string }> = []
  for (const name of MODULES) {
    const dir = join(ROOT, 'node_modules', name)
    if (!existsSync(join(dir, 'package.json'))) {
      console.error(`  ✗ ${name}：node_modules/${name} 不存在，先执行 npm install`)
      process.exitCode = 1
      return
    }
    targets.push({ name, absPath: dir })
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ns-native-probe-'))
  const probe = join(tmp, 'probe.cjs')
  writeFileSync(probe, probeSource(targets))

  // `--no-sandbox` 只影响这个一次性探针进程，不影响应用自身的沙箱配置。
  // ELECTRON_RUN_AS_NODE 必须**清掉**：它会让 Electron 以纯 Node 模式启动，
  // 那样测出来的是 Node 的 ABI，等于什么都没验证。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const r = spawnSync(exe, ['--no-sandbox', probe], { cwd: ROOT, encoding: 'utf8', env, timeout: 60_000 })

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
    const body = stdout.slice(begin + '===PROBE_BEGIN==='.length, end).trim()
    for (const line of body.split('\n')) console.log(`  ${line}`)
  } else {
    console.error('  ✗ 探针没有产生预期输出，原始输出如下：')
    console.error(stdout.slice(0, 1500))
    if (r.stderr) console.error(String(r.stderr).slice(0, 1500))
  }

  console.log('')
  console.log('='.repeat(78))
  if (r.status === 0) {
    console.log('[check-native] 全部可用 ✓ 现在可以 npm run dev')
  } else {
    console.log(`[check-native] 有模块不可用（退出码 ${String(r.status)}）`)
    console.log('[check-native] 若报 NODE_MODULE_VERSION 不一致 → 跑 npm run fetch:native-prebuild')
  }
  console.log('='.repeat(78))
  process.exitCode = r.status === 0 ? 0 : 1
}

if (process.argv[1] && process.argv[1].endsWith('check-native.ts')) main()
