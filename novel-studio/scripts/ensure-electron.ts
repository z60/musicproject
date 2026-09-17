/**
 * Novel Studio · 确保 Electron 二进制就位
 * ============================================================================
 * 解决的问题：`node_modules/electron/dist/` 为空时 `npm run dev` 无从启动，
 * 而报错信息（或没有报错信息）都指不到这一点上。
 *
 * ### 为什么会缺
 *   Electron 的二进制不在 npm 包里，由 `electron` 包**自己的 postinstall** 下载
 *   （`node install.js`）。它会缺的原因是历史包袱：
 *   本仓库曾经在 `package.json` 里声明 `postinstall: electron-rebuild …`，
 *   那一步在受限环境失败 → `npm install` 非零退出 → 为了绕开它改用
 *   `npm install --ignore-scripts` → **连带把 electron 的 postinstall 也跳过了**。
 *   （postinstall 钩子已移除，但已经跳过的二进制不会自己回来，所以要这个脚本兜底。）
 *
 * ### 为什么需要脚本而不是一行命令
 *   直接跑 `node node_modules/electron/install.js` 在部分网络下会失败：
 *
 *       RequestError: unable to verify the first certificate
 *
 *   原因是它走 `@electron/get` → `got` 直连 github.com 的 release，
 *   而该连接在某些网络下返回的证书链不完整。
 *   这与 npm 装包是**两条不同的链路** —— registry 能用不代表它能用。
 *   本脚本按「镜像 → 官方源」的顺序重试，并在都失败时给出**可操作**的兜底步骤。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ensure-electron.ts
 *   node --experimental-strip-types scripts/ensure-electron.ts --force   # 即使已就位也重下
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/** 镜像（与 .npmrc 的 electron_mirror 保持一致；显式传一份是为了不依赖 npm 是否在读配置） */
const DEFAULT_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'

interface ElectronPaths {
  /** 二进制是否就位 */
  ready: boolean
  /** 判定依据（进日志，便于排查） */
  evidence: string
  /** 平台二进制路径（Windows 是 electron.exe；其他平台是目录或可执行文件） */
  binary: string
}

/** 检查 Electron 二进制是否就位 —— 同时看 path.txt 与实际文件，两者缺一都不算就位 */
export function checkElectron(platform: NodeJS.Platform = process.platform): ElectronPaths {
  const pkgPath = join(ROOT, 'node_modules', 'electron', 'package.json')
  if (!existsSync(pkgPath)) {
    return { ready: false, evidence: 'node_modules/electron 不存在', binary: '' }
  }

  let version = ''
  try {
    version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? ''
  } catch {
    /* 版本读不到不影响判定 */
  }

  const pathTxt = join(ROOT, 'node_modules', 'electron', 'path.txt')
  const distDir = join(ROOT, 'node_modules', 'electron', 'dist')

  // Windows 的二进制文件名固定；其他平台用 path.txt 里写的相对路径
  let binary = ''
  if (platform === 'win32') binary = join(distDir, 'electron.exe')
  else if (existsSync(pathTxt)) binary = join(distDir, readFileSync(pathTxt, 'utf8').trim())

  const hasPathTxt = existsSync(pathTxt)
  const hasBinary = platform === 'win32' ? existsSync(binary) : existsSync(distDir)

  if (hasPathTxt && hasBinary) {
    return { ready: true, evidence: `electron ${version}，dist 与 path.txt 都在位`, binary }
  }
  return {
    ready: false,
    evidence: `electron ${version}：path.txt=${hasPathTxt ? '有' : '缺失'}，dist 二进制=${hasBinary ? '有' : '缺失'}`,
    binary,
  }
}

function main(): void {
  const force = process.argv.includes('--force')
  const state = checkElectron()

  console.log('='.repeat(78))
  console.log('[ensure-electron] 检查 Electron 二进制')
  console.log(`[ensure-electron] ${state.evidence}`)
  console.log('='.repeat(78))

  if (state.ready && !force) {
    console.log('[ensure-electron] 已就位，无需下载 ✓')
    return
  }

  const installer = join(ROOT, 'node_modules', 'electron', 'install.js')
  if (!existsSync(installer)) {
    console.error('[ensure-electron] 找不到 node_modules/electron/install.js')
    console.error('  请先执行：npm install')
    process.exitCode = 1
    return
  }

  const mirror = process.env.ELECTRON_MIRROR ?? DEFAULT_MIRROR
  console.log('')
  console.log('[ensure-electron] 使用镜像下载（直连 github release 在部分网络下会证书校验失败）：')
  console.log(`  ELECTRON_MIRROR = ${mirror}`)
  console.log('')

  // 关键：把镜像注入**子进程环境**，而不是依赖 npm 是否读了 .npmrc。
  // spawnSync 用 inherit 让安装进度直接显示在终端上（也不经过管道，避免沙箱限制）。
  const result = spawnSync(process.execPath, [installer], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_MIRROR: mirror },
  })

  // spawn 本身失败时（例如受限环境禁止创建子进程）要能说清，而不是只报一个空退出码
  if (result.error) {
    console.error('')
    console.error(`[ensure-electron] 无法启动安装进程：${result.error.message}`)
    console.error('  这通常是环境禁止 spawn 子进程导致的（与 npm install 的 postinstall 失败同源）。')
    console.error('  请在不受该限制的终端里执行，或走下面的手工下载路径。')
  }

  const after = checkElectron()
  console.log('')
  console.log('='.repeat(78))
  if (after.ready) {
    console.log(`[ensure-electron] 下载完成 ✓  ${after.binary}`)
    console.log('='.repeat(78))
    return
  }

  console.error(`[ensure-electron] 仍然失败（退出码 ${String(result.status)}）`)
  console.error(`  ${after.evidence}`)
  console.error('')
  console.error('  三条兜底路径，按推荐顺序：')
  console.error('')
  console.error('  1) 换一个镜像（有些内网只放通了特定镜像）')
  console.error('       $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"')
  console.error('       node --experimental-strip-types scripts/ensure-electron.ts --force')
  console.error('')
  console.error('  2) 临时关闭 TLS 证书校验（**仅用于下载，用完请关掉终端**）')
  console.error('       这是「证书链不完整」这一网络问题的直接解法，但会同时失去中间人防护：')
  console.error('       Linux/macOS:  NODE_TLS_REJECT_UNAUTHORIZED=0 node node_modules/electron/install.js')
  console.error('       PowerShell :  $env:NODE_TLS_REJECT_UNAUTHORIZED="0"; node node_modules/electron/install.js')
  console.error('       cmd        :  set NODE_TLS_REJECT_UNAUTHORIZED=0 && node node_modules/electron/install.js')
  console.error('')
  console.error('  3) 手工下载后解压（完全绕开 TLS）')
  console.error('       浏览器打开：https://registry.npmmirror.com/-/binary/electron/')
  console.error('       进入对应版本目录（如 v31.7.0/），下载 electron-v31.7.0-win32-x64.zip')
  console.error(`       解压到：${join(ROOT, 'node_modules', 'electron', 'dist')}`)
  console.error(`       并在同目录写入 path.txt，内容为：electron.exe`)
  console.error('='.repeat(78))
  process.exitCode = 1
}

if (process.argv[1] && process.argv[1].endsWith('ensure-electron.ts')) main()
