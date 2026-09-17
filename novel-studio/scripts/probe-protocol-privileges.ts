/**
 * Novel Studio · 诊断探针：`protocol.registerSchemesAsPrivileged` 的合法调用时机
 * ============================================================================
 * 背景：`register-media-protocol` 这一步在 `app.whenReady()` **之后**执行时立即失败
 * （日志里是 0ms 就抛错，但错误详情被吃掉了，看不出原因）。
 *
 * Electron 文档说明 `registerSchemesAsPrivileged` 应在应用就绪**之前**调用，
 * 但「之后调用到底会怎样」需要实测才能确定 —— 不想凭猜测改启动顺序。
 *
 * 本脚本在**同一个 Electron 进程**里试三次，把每次的真实错误打出来：
 *   A. whenReady 之前  —— 期望成功
 *   B. whenReady 之后  —— 验证是否真的被拒绝
 *   C. 再试一次 after   —— 看是「时机问题」还是「只能调一次」
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-protocol-privileges.ts
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()

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

/** 探针源码：三组调用，逐条记录结果 */
const PROBE = `
const { app, protocol } = require('electron')
const log = []

const SCHEME = {
  scheme: 'ns-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
}

function attempt(label) {
  try {
    protocol.registerSchemesAsPrivileged([SCHEME])
    log.push(label + ' → 成功')
  } catch (e) {
    log.push(label + ' → 抛错: ' + String(e && e.message ? e.message : e).split('\\n')[0])
  }
}

attempt('A. whenReady 之前')

app.whenReady().then(() => {
  attempt('B. whenReady 之后')

  // 换一个没用过的 scheme 再试，区分「时机」与「重复注册」
  try {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'ns-media-probe', privileges: { standard: true, secure: true } },
    ])
    log.push('C. whenReady 之后（新 scheme）→ 成功')
  } catch (e) {
    log.push('C. whenReady 之后（新 scheme）→ 抛错: ' + String(e && e.message ? e.message : e).split('\\n')[0])
  }

  process.stdout.write('\\n===PROBE_BEGIN===\\n' + log.join('\\n') + '\\n===PROBE_END===\\n')
  app.exit(0)
})
`

function main(): void {
  console.log('='.repeat(78))
  console.log('[probe-protocol] registerSchemesAsPrivileged 的调用时机')
  console.log('='.repeat(78))

  const exe = electronBinary()
  if (!exe) {
    console.error('[probe-protocol] 找不到 Electron 二进制')
    process.exitCode = 1
    return
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ns-proto-probe-'))
  const probe = join(tmp, 'probe.cjs')
  writeFileSync(probe, PROBE)

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
    for (const line of stdout.slice(begin + 18, end).trim().split('\n')) console.log(`  ${line}`)
  } else {
    console.error('  探针无预期输出，原始 stdout：')
    console.error(stdout.slice(0, 1200))
    if (r.stderr) console.error(String(r.stderr).slice(0, 1200))
  }
  console.log('='.repeat(78))
}

main()
