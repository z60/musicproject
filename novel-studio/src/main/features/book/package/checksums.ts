/**
 * Novel Studio · 包内校验和（逐文件 sha256）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §8 导入规则 2「逐文件校验 checksums.sha256；不匹配的文件**跳过并在报告中列出**，
 *                   不整体失败」
 *   · docs/03 §8 / §9 包结构里的 `checksums.sha256`
 *
 * 文件格式（兼容 `sha256sum` 的输出，便于用户用系统工具手工核对）：
 *   ```
 *   <64 位小写 hex>␠␠<相对路径>
 *   ```
 * 解析时容忍：`*` 二进制标记、多个空格、CRLF、空行、`#` 注释、`路径: hash` 的反向写法。
 *
 * **绝不整体失败**：读不出来的条目记入 `unreadable`，哈希不符记入 `mismatch`，
 * 期望存在但包内缺失记入 `missing`，其余照常返回 `ok` 列表。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

import { AppError, isAppError } from '../../../../shared/errors.ts'
import type { ZipReader } from './zip/reader.ts'

// ============================================================================
// 基本哈希
// ============================================================================

/** sha256 十六进制小写 */
export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash('sha256')
  if (typeof data === 'string') h.update(data, 'utf8')
  else h.update(data)
  return h.digest('hex')
}

/** 大文件（几百 MB 的 WAV）用流式哈希，避免把整个文件读进内存 */
export function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('error', (e) => reject(new AppError('FILE_NOT_FOUND', { params: { name: absPath }, cause: e })))
    stream.on('data', (chunk) => h.update(chunk))
    stream.on('end', () => resolve(h.digest('hex')))
  })
}

/** 十六进制哈希格式校验（用于解析时过滤注释与垃圾行） */
export function isSha256Hex(v: string): boolean {
  return /^[0-9a-f]{64}$/i.test(v)
}

// ============================================================================
// checksums.sha256 文本格式
// ============================================================================

export interface ChecksumEntry {
  /** 包内相对路径（正斜杠） */
  path: string
  hash: string
}

/**
 * 解析 `checksums.sha256`。
 *
 * 支持：
 *   · `hash␠␠path`（sha256sum 标准）
 *   · `hash␠*path`（二进制模式标记）
 *   · `path: hash` / `path␠␠hash`（手工或其它工具生成）
 *   · `#` 开头的注释行、空行
 */
export function parseChecksumsFile(text: string): ChecksumEntry[] {
  const out: ChecksumEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // 反向写法：path: hash
    const reverse = /^(.+?):\s*([0-9a-fA-F]{64})$/.exec(line)
    if (reverse) {
      out.push({ path: normalizePath(reverse[1]), hash: reverse[2].toLowerCase() })
      continue
    }

    // 标准写法：hash [ *]path
    const standard = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line)
    if (standard) {
      out.push({ path: normalizePath(standard[2]), hash: standard[1].toLowerCase() })
      continue
    }

    // 其它写法：path 在前、hash 在后（空格分隔）
    const loose = /^(\S+)[ \t]+([0-9a-fA-F]{64})$/.exec(line)
    if (loose) {
      out.push({ path: normalizePath(loose[1]), hash: loose[2].toLowerCase() })
      continue
    }
    // 完全无法识别 → 忽略该行（不让一行垃圾让整个校验失败）
  }
  return out
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 生成 `checksums.sha256` 文本（按路径排序，保证同样内容产出同样文件） */
export function formatChecksumsFile(entries: readonly ChecksumEntry[]): string {
  return (
    [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((e) => `${e.hash}  ${e.path}`)
      .join('\n') + '\n'
  )
}

export function checksumsToMap(entries: readonly ChecksumEntry[]): Map<string, string> {
  return new Map(entries.map((e) => [e.path, e.hash]))
}

// ============================================================================
// 计算 / 校验
// ============================================================================

/** 计算一个 zip 条目（或内存文件）的哈希 */
export function checksumOfBytes(data: Uint8Array): string {
  return sha256Hex(data)
}

export interface ComputeChecksumsResult {
  entries: ChecksumEntry[]
  /** 读不出来的条目（损坏/被拒），只记录不抛错 */
  unreadable: Array<{ path: string; message: string }>
}

/**
 * 计算包内所有（或指定）条目的 sha256。
 * 单个条目读取失败**不会**让整体失败 —— 记入 `unreadable` 继续算其余条目。
 */
export function computeChecksums(zip: ZipReader, names?: readonly string[]): ComputeChecksumsResult {
  const list = names ?? zip.listEntries().map((e) => e.name)
  const entries: ChecksumEntry[] = []
  const unreadable: Array<{ path: string; message: string }> = []

  for (const name of list) {
    try {
      entries.push({ path: name, hash: checksumOfBytes(zip.readEntry(name)) })
    } catch (e) {
      unreadable.push({ path: name, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { entries, unreadable }
}

export interface VerifyPackageResult {
  /** 校验通过的文件 */
  ok: string[]
  /** 内容与期望不一致的文件（跳过并列报告） */
  mismatch: string[]
  /** 期望存在但包里没有的文件 */
  missing: string[]
  /** 包里有但读不出来（损坏/被安全策略拒绝）的文件 */
  unreadable: string[]
  /** 实际比对过的文件数 */
  checked: number
}

/**
 * 逐文件校验（docs/03 §8 导入规则 2）。
 *
 * **绝不整体失败**：不匹配的文件跳过并列进 `mismatch`，调用方照常导入其余文件。
 * `expected` 支持三种形态：ChecksumEntry[]、Map<path, hash>、或 checksums.sha256 的原文。
 */
export function verifyPackage(
  zip: ZipReader,
  expected: readonly ChecksumEntry[] | ReadonlyMap<string, string> | string,
): VerifyPackageResult {
  const expectedMap =
    typeof expected === 'string'
      ? checksumsToMap(parseChecksumsFile(expected))
      : expected instanceof Map
        ? // `expected instanceof Map` 在只读联合类型上收不窄成 Map<string,string>（TS 限制），
          // 这里显式按「可迭代的 [path, hash] 对」消费，两种形态都适配
          new Map<string, string>(expected as ReadonlyMap<string, string>)
        : checksumsToMap(expected as readonly ChecksumEntry[])

  const result: VerifyPackageResult = { ok: [], mismatch: [], missing: [], unreadable: [], checked: 0 }

  for (const [path, expectedHash] of expectedMap) {
    let actual: string
    try {
      actual = checksumOfBytes(zip.readEntry(path))
    } catch (e) {
      // 分不清「缺文件」和「文件损坏」会让用户没法处理，所以要区分开
      const reason = isAppError(e) && typeof e.details?.reason === 'string' ? e.details.reason : ''
      const isMissing = reason === 'entry-not-found' || reason === 'entry-rejected' || !zip.has(path)
      if (isMissing) result.missing.push(path)
      else result.unreadable.push(path)
      continue
    }
    result.checked++
    if (actual.toLowerCase() === expectedHash.toLowerCase()) result.ok.push(path)
    else result.mismatch.push(path)
  }

  return result
}

/** 便捷入口：直接吃 checksums.sha256 文本 */
export function verifyPackageFromText(zip: ZipReader, checksumsText: string): VerifyPackageResult {
  return verifyPackage(zip, checksumsText)
}

/** 校验结果是否「全部通过」（有任一异常即 false；用于决定是否提示 PACKAGE_CHECKSUM_MISMATCH） */
export function isVerifyClean(r: VerifyPackageResult): boolean {
  return r.mismatch.length === 0 && r.missing.length === 0 && r.unreadable.length === 0
}
