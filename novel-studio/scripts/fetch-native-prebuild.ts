/**
 * Novel Studio · 为 Electron 获取原生模块的预编译二进制
 * ============================================================================
 * 解决的问题：`npm run rebuild` 在 Windows 上会走到 `node-gyp` 编译 C++ 源码，
 * 而编译需要 Visual Studio Build Tools + Python。这不是必须的 ——
 * `better-sqlite3` **为 Electron 发布了预编译包**，只是默认的 `electron-rebuild`
 * 不去用它，直接尝试从源码编译，失败就报：
 *
 *     ✖ Rebuild Failed
 *     node-gyp failed to rebuild '...\node_modules\better-sqlite3'
 *
 * ### 为什么不用 `prebuild-install`（它其实已装好）
 *   `prebuild-install <name> --runtime=electron --target=<ver>` 是对的做法，
 *   但它会把两个外部依赖引进来：
 *     · 需要设 `prebuild-install` 的镜像环境变量才不去连 github.com
 *       （而本项目的用户环境对 github.com 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`）；
 *     · 它内部要 spawn 子进程。
 *   本脚本改成**只用 Node 内置能力**：
 *     · `fetch` 下载（Node 18+ 内置）+ `zlib` 解压（内置）+ 自己解析 tar（tar 格式很简单）
 *     这样既绕开 TLS/镜像配置问题，也不依赖任何会 spawn 的工具。
 *
 * ### 安全性：为什么敢自己解 tar
 *   只接受以 `lib/binding/` 或 `build/Release/` 开头的普通文件条目，
 *   拒绝符号链接、硬链接、`..` 路径穿越与绝对路径。
 *   解析失败就明确报错，不猜。
 *
 * 用法：
 *   node --experimental-strip-types scripts/fetch-native-prebuild.ts
 *   node --experimental-strip-types scripts/fetch-native-prebuild.ts --check   # 只检查
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const ROOT = process.cwd()

/** 预编译二进制镜像（与 .npmrc 的 electron_mirror 同一站点） */
const PREBUILD_MIRROR = process.env.NATIVE_PREBUILD_MIRROR ?? 'https://registry.npmmirror.com/-/binary'

/**
 * 需要为 Electron 重建的原生模块。
 *
 * `binding` 是该模块**实际被加载**的 .node 相对路径（由它的 `bindings()` 调用决定，
 * 见各模块源码；写死在这里是有意的 —— 探测错位置会让人以为「已就位」而实际没生效）。
 */
const NATIVE_MODULES = [
  {
    name: 'better-sqlite3',
    /** 模块目录名（npm 包名） */
    dir: 'better-sqlite3',
    /** 运行时真正的 .node 路径（相对模块目录） */
    binding: join('build', 'Release', 'better_sqlite3.node'),
  },
] as const

interface AbiInfo {
  electronVersion: string
  electronAbi: number
  nodeAbi: number
  platform: string
  arch: string
}

/** Agent 工具名到 prebuild 文件名中间段的映射（与 prebuild 的 asset 命名约定一致） */
function abiInfo(): AbiInfo {
  const abi = require('node-abi') as { getAbi(version: string, runtime: string): string | undefined }
  const electronPkg = JSON.parse(
    readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
  ) as { version: string }
  const electronVersion = electronPkg.version
  const eAbi = abi.getAbi(electronVersion, 'electron')
  const nAbi = abi.getAbi(process.versions.node, 'node')
  if (!eAbi) throw new Error(`无法解析 Electron ${electronVersion} 的 ABI 版本`)
  return {
    electronVersion,
    electronAbi: Number(eAbi),
    nodeAbi: Number(nAbi ?? 0),
    platform: process.platform,
    arch: process.arch,
  }
}

/**
 * 读取 .node 文件里记录的 ABI 版本。
 *
 * ### ⚠️ 这个方法已证明**不可靠**，保留它只是为了给出「大概」信息
 *   原以为 Node 原生模块把 `NODE_MODULE_VERSION` 放在 PE 可选头的
 *   `MajorImageVersion`（+44）字段 —— 实测**不是**：
 *
 *       +44 MajorImageVersion = 0
 *       +40 MajorSubsystemVer = 6      ← 不是 ABI
 *       +48 MajorOSVersion    = 6
 *
 *   prebuild 出来的 `better_sqlite3.node` 那些字段全是 0/6（编译器默认值）。
 *   真正的 ABI 校验发生在加载时，比较的是模块里编译进去的常量，
 *   而不是 PE 头。
 *
 *   因此：**不要把这个函数的返回值当作「就位」的依据**。
 *   判断就位用的是{m@link markerPath} 这个 sidecar 文件（见 `isReady`），
 *   真正的最终验证是 `npm run check:native`（在 Electron 里 require 一次）。
 *
 * @returns PE 里的 MajorImageVersion；读不出来返回 null（多数情况就是 null/0）
 */
export function readModuleAbiUnreliable(filePath: string): number | null {
  try {
    const buf = readFileSync(filePath)
    if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null
    const peOff = buf.readUInt32LE(0x3c)
    if (buf.length < peOff + 0x18) return null
    if (buf[peOff] !== 0x50 || buf[peOff + 1] !== 0x45 || buf[peOff + 2] !== 0 || buf[peOff + 3] !== 0) return null
    const optOff = peOff + 24
    const magic = buf.readUInt16LE(optOff)
    if (magic !== 0x10b && magic !== 0x20b) return null
    return buf.readUInt16LE(optOff + 44)
  } catch {
    return null
  }
}

interface TarEntry {
  name: string
  data: Buffer
}

/**
 * 极简 tar 解析器（只处理 ustar 普通文件）。
 *
 * 拒绝：符号链接/硬链接（type 1/2）、目录以外的特殊类型、`..` 与绝对路径。
 * 这不是「防黑客」级别的检查，而是**防止解出来一堆莫名其妙的东西**；
 * 来源是固定镜像，但解析器本身不该假设输入是善意的。
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    // ustar 的 prefix 字段（长路径会拆到 345 处）
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const name = prefix ? `${prefix}/${rawName}` : rawName
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeStr, 8) || 0

    off += 512
    const data = buf.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512

    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '') continue // 跳过非普通文件
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) continue
    out.push({ name, data: Buffer.from(data) })
  }
  return out
}

/**
 * 「就位」的判据：二进制存在 **且** sidecar 标记文件记录的是当前 Electron ABI。
 *
 * 为什么需要 sidecar 而不是直接读 .node：
 *   实测 PE 头里**没有** ABI 信息（`MajorImageVersion` 是 0），
 *   见 {@link readModuleAbiUnreliable} 的说明。既然读不出来，就记录我们自己下载了什么 ——
 *   这比「猜一个数」诚实，也比「只看文件存在」可靠（文件可能存在但属于 Node ABI）。
 *
 * 标记文件写在模块目录里（跟在 node_modules 里，重装依赖会一起消失，符合预期）。
 */
function markerPath(modDir: string): string {
  return join(modDir, '.novel-studio-abi.json')
}

interface AbiMarker {
  abi: number
  electronVersion: string
  asset: string
  fetchedAt: number
}

function readMarker(modDir: string): AbiMarker | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(markerPath(modDir), 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    const m = raw as Partial<AbiMarker>
    return typeof m.abi === 'number' ? (m as AbiMarker) : null
  } catch {
    return null
  }
}

function isReady(modDir: string, bindingRel: string, electronAbi: number): boolean {
  if (!existsSync(join(modDir, bindingRel))) return false
  const marker = readMarker(modDir)
  return marker !== null && marker.abi === electronAbi
}

/** 下载并解出需要的条目。只保留与 `keep` 前缀匹配的文件，避免往 node_modules 里乱写。 */
async function fetchPrebuild(
  assetUrl: string,
  keepPrefixes: readonly string[],
  targetDir: string,
): Promise<Array<{ name: string; bytes: number }>> {
  const res = await fetch(assetUrl)
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}：${assetUrl}`)
  const gz = Buffer.from(await res.arrayBuffer())
  const tar = gunzipSync(gz)

  const written: Array<{ name: string; bytes: number }> = []
  for (const entry of parseTar(tar)) {
    if (!keepPrefixes.some((p) => entry.name.startsWith(p))) continue
    const rel = normalize(entry.name)
    const dest = join(targetDir, rel)
    // 双保险：解出来的路径必须仍在 targetDir 内
    if (!dest.startsWith(targetDir + sep)) continue
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, entry.data)
    written.push({ name: rel, bytes: entry.data.length })
  }
  if (written.length === 0) {
    throw new Error(
      `压缩包内没有匹配 ${keepPrefixes.join(' / ')} 的条目；` +
        `实际条目：${parseTar(tar).map((e) => e.name).slice(0, 8).join(', ')}`,
    )
  }
  return written
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check')
  console.log('='.repeat(78))
  console.log('[native-prebuild] 为 Electron 获取原生模块二进制（不需要 VS Build Tools）')
  console.log('='.repeat(78))

  let abi: AbiInfo
  try {
    abi = abiInfo()
  } catch (e) {
    console.error(`[native-prebuild] 无法确定 ABI 信息：${e instanceof Error ? e.message : String(e)}`)
    console.error('  请先确保 electron 已安装：npm install')
    process.exitCode = 1
    return
  }

  console.log(`  Electron  ${abi.electronVersion}  → ABI ${abi.electronAbi}`)
  console.log(`  本机 Node ${process.versions.node}  → ABI ${abi.nodeAbi}`)
  console.log(`  平台      ${abi.platform}-${abi.arch}`)
  console.log('')

  let allOk = true
  for (const mod of NATIVE_MODULES) {
    const modDir = join(ROOT, 'node_modules', mod.dir)
    if (!existsSync(modDir)) {
      console.log(`  ✗ ${mod.name}：模块目录不存在，先跑 npm install`)
      allOk = false
      continue
    }

    if (isReady(modDir, mod.binding, abi.electronAbi)) {
      const m = readMarker(modDir)
      console.log(`  ✓ ${mod.name}：已就位（Electron ABI ${abi.electronAbi}，${m?.asset ?? ''}）`)
      continue
    }

    // 说明现状：有二进制但没有标记 → 多半是 npm 装的 Node 版（ABI 不匹配）
    const hasBinary = existsSync(join(modDir, mod.binding))
    const marker = readMarker(modDir)
    console.log(
      `  ! ${mod.name}：` +
        (hasBinary
          ? marker
            ? `二进制在，但标记记录的是 ABI ${marker.abi}（需要 ${abi.electronAbi}）`
            : `二进制在，但无法确认它是哪个 ABI 的（多半是 npm 装的 Node 版）`
          : `未找到 .node（${mod.binding}）`),
    )

    if (checkOnly) {
      allOk = false
      continue
    }

    const version = (JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf8')) as { version: string }).version
    const asset = `${mod.name}-v${version}-electron-v${abi.electronAbi}-${abi.platform}-${abi.arch}.tar.gz`
    const url = `${PREBUILD_MIRROR}/${mod.name}/v${version}/${asset}`
    console.log(`    下载 ${asset}`)
    console.log(`      ${url}`)

    let written: Array<{ name: string; bytes: number }>
    try {
      written = await fetchPrebuild(url, ['build/Release/', 'lib/binding/'], modDir)
      for (const w of written) console.log(`      ← ${w.name}  ${w.bytes} B`)
    } catch (e) {
      console.log(`    ✗ ${e instanceof Error ? e.message : String(e)}`)
      console.log(`      可手工下载上面的 URL，解压后把 build/Release/ 下的 .node 放到：`)
      console.log(`      ${dirname(join(modDir, mod.binding))}`)
      allOk = false
      continue
    }

    // 写 sidecar 标记：记录「我们放了哪个 ABI 的二进制进来」。
    // 不写它就无法区分「Electron 版」与「Node 版」—— 两者文件名完全一样。
    const markerData: AbiMarker = {
      abi: abi.electronAbi,
      electronVersion: abi.electronVersion,
      asset,
      fetchedAt: Date.now(),
    }
    writeFileSync(markerPath(modDir), `${JSON.stringify(markerData, null, 2)}\n`)

    if (isReady(modDir, mod.binding, abi.electronAbi)) {
      console.log(`    ✓ 已就位：${mod.binding}`)
      console.log(`      （ABI 是否真的匹配由 Electron 运行时决定，用 npm run check:native 验证）`)
    } else {
      console.log('    ✗ 解压后标记未生效，请检查上面写入的文件')
      allOk = false
    }
  }

  console.log('')
  console.log('='.repeat(78))
  if (allOk) {
    console.log('[native-prebuild] 全部就位 ✓')
    console.log('[native-prebuild] 建议接着跑：npm run check:native   （在 Electron 里真的 require 一次）')
    console.log('[native-prebuild] 通过后即可：npm run dev')
  } else {
    console.log('[native-prebuild] 有模块未就位（见上）。类型检查与测试不受影响。')
    process.exitCode = 1
  }
  console.log('='.repeat(78))
}

if (process.argv[1] && process.argv[1].endsWith('fetch-native-prebuild.ts')) {
  main().catch((e: unknown) => {
    console.error(`[native-prebuild] 意外失败：${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  })
}
