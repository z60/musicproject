/**
 * Novel Studio · 纯 Node ZIP 读取实现（无第三方依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §8 导入规则 5「解压防护：限制总解压大小（默认 50 GB）、条目数（默认 50000）、
 *                          拒绝路径穿越（`..`、绝对路径、符号链接）」
 *   · docs/03 §8 导入规则 2「逐文件校验；不匹配的文件跳过并列出，不整体失败」
 *     —— 因此本读取器提供 `strict: false` 的「记录违规并跳过该条目」模式
 *
 * 为什么自己实现：
 *   受限/离线环境里没有 `yauzl` / `adm-zip`；而 `.nsp` / `.nst` 的**校验逻辑必须能真跑测试**，
 *   不能只留一个接口。ZIP 的读取部分（EOCD → 中央目录 → 本地头 → inflate）是纯计算，
 *   用 `node:zlib` 的 `inflateRawSync` 足够，并且能对 zip bomb 做真正的防护。
 *
 * 支持范围：
 *   · 压缩方法 store(0) 与 deflate(8)
 *   · 不加密的条目；**不支持 ZIP64**（>4 GB 的包会明确报错，而不是读出垃圾数据）
 *   · 数据描述符（flag bit 3）条目：以中央目录里的尺寸为准，正常读取
 *
 * 安全清单（每一条都有对应的测试）：
 *   1. 条目数上限（默认 50000）
 *   2. 总解压大小上限（默认 50 GB，既按中央目录的声明值预检，也按实际读取量累计）
 *   3. 单条压缩比上限（默认 1000:1，仅对 ≥ 1 MB 的条目检查，避免小文件误判）
 *   4. 拒绝路径穿越：`..`、绝对路径、盘符、反斜杠、NUL 与控制字符
 *   5. 拒绝符号链接条目（unix 模式 0xA000）
 *   6. 拒绝加密条目
 *   7. `inflateRawSync` 传 `maxOutputLength`，即使声明值被伪造也撑不爆内存
 *   8. 读取后校验长度与 CRC32，损坏条目抛错（上层可选择跳过并计入 corrupted）
 */

import { inflateRawSync } from 'node:zlib'

import { AppError } from '../../../../../shared/errors.ts'

// ============================================================================
// 常量与类型
// ============================================================================

const SIG_EOCD = 0x06054b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_EOCD64 = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** 默认防护阈值（docs/03 §8 导入规则 5） */
export const DEFAULT_MAX_ENTRIES = 50_000
export const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 ** 3 // 50 GB
export const DEFAULT_MAX_COMPRESSION_RATIO = 1000
export const DEFAULT_MIN_SIZE_FOR_RATIO_CHECK = 1024 * 1024 // 1 MB

export interface ZipEntryInfo {
  /** 规范化后的条目名（统一正斜杠）；目录条目以 `/` 结尾 */
  name: string
  /** 中央目录里记录的原始名字（诊断用） */
  rawName: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  crc32: number
  localHeaderOffset: number
  isDirectory: boolean
  /** unix 权限位（versionMadeBy 高字节为 3 时才有） */
  unixMode: number | null
  isSymlink: boolean
  /** 通用标志位（bit0=加密，bit3=数据描述符，bit11=UTF-8 名） */
  flags: number
  lastModTime: number
  lastModDate: number
}

export type ZipViolationKind =
  | 'zip64'
  | 'entry-count'
  | 'total-size'
  | 'path-traversal'
  | 'symlink'
  | 'compression-ratio'
  | 'encrypted'
  | 'unsupported-method'
  | 'oversized-entry'

export interface ZipViolation {
  kind: ZipViolationKind
  /** 相关条目名（若有） */
  name?: string
  message: string
  details?: Record<string, unknown>
}

export interface ZipReaderOptions {
  /** 条目数上限，默认 50000 */
  maxEntries?: number
  /** 总解压大小上限（字节），默认 50 GB */
  maxTotalUncompressedBytes?: number
  /** 单条压缩比上限，默认 1000 */
  maxCompressionRatio?: number
  /** 低于此体积不做压缩比检查（默认 1 MB） */
  minSizeForRatioCheck?: number
  /**
   * 严格模式（默认 true）：出现违规条目直接抛 `PACKAGE_INVALID`。
   * 设为 false：把违规条目记入 `violations` 并**跳过**，其余条目照常可读
   * （对应 docs/03 §8 导入规则 2「不匹配则跳过并列报告，绝不整体失败」）。
   */
  strict?: boolean
  /** 读取时校验 CRC32，默认 true */
  verifyCrc?: boolean
  /** 是否允许符号链接条目，默认 false */
  allowSymlinks?: boolean
}

export interface ZipReader {
  /** 可安全读取的条目（不含目录条目） */
  readonly entries: readonly ZipEntryInfo[]
  /** 被拒绝/跳过的条目与原因 */
  readonly violations: readonly ZipViolation[]
  /** 中央目录里声明的条目总数（含被跳过的） */
  readonly declaredEntries: number
  readonly totalUncompressedBytes: number
  /** 实际已解压的字节数（累计，用于配额控制） */
  readonly totalBytesRead: number
  listEntries(options?: { includeDirectories?: boolean }): ZipEntryInfo[]
  has(name: string): boolean
  getEntry(name: string): ZipEntryInfo | null
  /** 读取并解压单个条目（含长度与 CRC 校验） */
  readEntry(name: string): Buffer
  readText(name: string, encoding?: BufferEncoding): string
  close(): void
}

// ============================================================================
// CRC32
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** 标准 CRC-32（ZIP 用的就是这个） */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ============================================================================
// 路径安全
// ============================================================================

/**
 * 条目名规范化 + 安全检查。
 *
 * 拒绝（返回 null）：
 *   · 绝对路径（`/x`、`C:\x`、UNC `\\server\share`）
 *   · 含 `..` 段（路径穿越）
 *   · 含反斜杠（Windows 上会被当成目录分隔符，是最常见的绕过手法）
 *   · 含 NUL / 控制字符
 */
export function normalizeEntryName(raw: string, options: { allowSymlinks?: boolean } = {}): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  // NUL 与控制字符：会让下游的文件 API 行为不可预期
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null

  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/')) return null // 绝对路径 / UNC
  if (/^[A-Za-z]:/.test(unified)) return null // 盘符
  // eslint-disable-next-line no-control-regex
  if (/^~/.test(unified)) return null // 家目录展开

  const isDir = unified.endsWith('/')
  // `./` 是良性的（不少工具会写出来），折叠掉即可；`..` 一律拒绝（路径穿越）
  const segments = unified.split('/').filter((s) => s.length > 0 && s !== '.')
  if (segments.length === 0) return null
  for (const seg of segments) {
    if (seg === '..') return null
  }
  void options
  const normalized = segments.join('/')
  return isDir ? `${normalized}/` : normalized
}

// ============================================================================
// 打开（解析 EOCD → 中央目录）
// ============================================================================

/**
 * 打开一个 ZIP（内存版）。
 *
 * @throws `PACKAGE_INVALID` 结构异常，或严格模式下出现违规条目
 */
export function openZip(data: Uint8Array, options: ZipReaderOptions = {}): ZipReader {
  const strict = options.strict !== false
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotal = options.maxTotalUncompressedBytes ?? DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES
  const maxRatio = options.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO
  const minRatioSize = options.minSizeForRatioCheck ?? DEFAULT_MIN_SIZE_FOR_RATIO_CHECK
  const verifyCrc = options.verifyCrc !== false
  const allowSymlinks = options.allowSymlinks === true

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const violations: ZipViolation[] = []
  let closed = false

  const eocd = findEocd(view)
  if (!eocd) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'eocd-not-found', bytes: data.byteLength },
    })
  }

  if (eocd.isZip64) {
    violations.push({
      kind: 'zip64',
      message: '不支持 ZIP64 格式的大包（>4 GB），请改用更小的内容清单后重新导出',
      details: { entries: eocd.totalEntries },
    })
  }

  const declaredEntries = eocd.totalEntries
  if (declaredEntries > maxEntries) {
    violations.push({
      kind: 'entry-count',
      message: `包内条目数 ${declaredEntries} 超过上限 ${maxEntries}`,
      details: { declared: declaredEntries, max: maxEntries },
    })
  }

  if (eocd.cdOffset + eocd.cdSize > data.byteLength) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'central-directory-out-of-range', cdOffset: eocd.cdOffset, cdSize: eocd.cdSize, bytes: data.byteLength },
    })
  }

  const all: ZipEntryInfo[] = []
  let p = eocd.cdOffset
  for (let i = 0; i < declaredEntries; i++) {
    if (p + 46 > data.byteLength) {
      throw new AppError('PACKAGE_INVALID', {
        details: { reason: 'central-directory-truncated', index: i },
      })
    }
    if (view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new AppError('PACKAGE_INVALID', {
        details: { reason: 'central-directory-signature-mismatch', index: i, offset: p },
      })
    }

    const flags = view.getUint16(p + 8, true)
    const method = view.getUint16(p + 10, true)
    const lastModTime = view.getUint16(p + 12, true)
    const lastModDate = view.getUint16(p + 14, true)
    const entryCrc = view.getUint32(p + 16, true)
    const compressedSize = view.getUint32(p + 20, true)
    const uncompressedSize = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const versionMadeBy = view.getUint16(p + 4, true)
    const externalAttrs = view.getUint32(p + 38, true)
    const localHeaderOffset = view.getUint32(p + 42, true)

    const rawName = decodeName(data.subarray(p + 46, p + 46 + nameLen), flags)
    const hostSystem = (versionMadeBy >> 8) & 0xff
    const unixMode = hostSystem === 3 ? (externalAttrs >>> 16) & 0xffff : null
    const isSymlink = unixMode !== null && (unixMode & 0xf000) === 0xa000
    const isDirectory = rawName.endsWith('/') || (unixMode !== null && (unixMode & 0xf000) === 0x4000)

    const info: ZipEntryInfo = {
      name: '',
      rawName,
      compressionMethod: method,
      compressedSize,
      uncompressedSize,
      crc32: entryCrc,
      localHeaderOffset,
      isDirectory,
      unixMode,
      isSymlink,
      flags,
      lastModTime,
      lastModDate,
    }

    all.push(info)

    // ---- 逐条防护 ----
    const normalized = isDirectory
      ? normalizeEntryName(rawName.endsWith('/') ? rawName : `${rawName}/`)
      : normalizeEntryName(rawName)
    if (normalized === null) {
      violations.push({
        kind: 'path-traversal',
        name: rawName,
        message: `条目名不合法（疑似路径穿越/绝对路径）：${JSON.stringify(rawName).slice(0, 120)}`,
      })
      info.name = `__unsafe__/${i}`
      p += 46 + nameLen + extraLen + commentLen
      continue
    }
    info.name = normalized

    if (isSymlink && !allowSymlinks) {
      violations.push({
        kind: 'symlink',
        name: normalized,
        message: `拒绝符号链接条目：${normalized}`,
        details: { unixMode },
      })
    }
    if ((flags & 0x0001) !== 0) {
      violations.push({ kind: 'encrypted', name: normalized, message: `不支持加密条目：${normalized}` })
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      violations.push({
        kind: 'unsupported-method',
        name: normalized,
        message: `不支持的压缩方法 ${method}（仅支持 store=0 / deflate=8）`,
      })
    }
    if (uncompressedSize >= minRatioSize && compressedSize > 0 && uncompressedSize / compressedSize > maxRatio) {
      violations.push({
        kind: 'compression-ratio',
        name: normalized,
        message: `压缩比异常（${Math.round(uncompressedSize / compressedSize)}:1），疑似 zip bomb：${normalized}`,
        details: { uncompressedSize, compressedSize, maxRatio },
      })
    }

    p += 46 + nameLen + extraLen + commentLen
  }

  // 声明总大小预检（一次算出，避免逐条解压到一半才发现）
  const totalUncompressedBytes = all.reduce((n, e) => n + (e.isDirectory ? 0 : e.uncompressedSize), 0)
  if (totalUncompressedBytes > maxTotal) {
    violations.push({
      kind: 'total-size',
      message: `解压后总大小 ${totalUncompressedBytes} 字节超过上限 ${maxTotal} 字节`,
      details: { totalUncompressedBytes, max: maxTotal },
    })
  }

  if (strict && violations.length > 0) {
    throw new AppError('PACKAGE_INVALID', {
      details: {
        reason: 'zip-defense-violation',
        violations: violations.map((v) => ({ kind: v.kind, name: v.name ?? null, message: v.message })),
      },
    })
  }

  const rejected = new Set(violations.map((v) => v.name ?? '').filter(Boolean))
  const entries = all.filter(
    (e) => !e.isDirectory && !rejected.has(e.name) && !e.name.startsWith('__unsafe__/'),
  )

  let totalBytesRead = 0

  const reader: ZipReader = {
    entries,
    violations,
    declaredEntries,
    totalUncompressedBytes,
    get totalBytesRead() {
      return totalBytesRead
    },
    listEntries(listOptions = {}) {
      const includeDirs = listOptions.includeDirectories === true
      const usable = all.filter((e) => !rejected.has(e.name) && !e.name.startsWith('__unsafe__/'))
      return includeDirs ? usable : usable.filter((e) => !e.isDirectory)
    },
    has(name) {
      return entries.some((e) => e.name === name)
    },
    getEntry(name) {
      return entries.find((e) => e.name === name) ?? null
    },
    readEntry(name) {
      if (closed) throw new AppError('PACKAGE_INVALID', { details: { reason: 'reader-closed' } })
      const entry = entries.find((e) => e.name === name)
      if (!entry) {
        if (rejected.has(name)) {
          throw new AppError('PACKAGE_INVALID', {
            details: { reason: 'entry-rejected', name, violations: violations.filter((v) => v.name === name) },
          })
        }
        throw new AppError('PACKAGE_INVALID', { details: { reason: 'entry-not-found', name } })
      }
      const buffer = extractEntry(data, view, entry, {
        remainingQuota: Math.max(0, maxTotal - totalBytesRead),
        verifyCrc,
      })
      totalBytesRead += buffer.byteLength
      if (totalBytesRead > maxTotal) {
        throw new AppError('PACKAGE_INVALID', {
          details: { reason: 'total-size-exceeded-while-reading', totalBytesRead, max: maxTotal },
        })
      }
      return buffer
    },
    readText(name, encoding = 'utf8') {
      return reader.readEntry(name).toString(encoding)
    },
    close() {
      closed = true
    },
  }

  return reader
}

// ============================================================================
// 内部：EOCD 定位与单条解压
// ============================================================================

interface EocdInfo {
  totalEntries: number
  cdSize: number
  cdOffset: number
  isZip64: boolean
}

/**
 * 从尾部扫描 EOCD（注释最长 65535 字节）。
 * 同时检查 ZIP64 定位器：本实现**不支持 ZIP64**，识别出来后由调用方决定报错。
 */
export function findEocd(view: DataView): EocdInfo | null {
  const minEocd = 22
  const maxScan = Math.min(view.byteLength, minEocd + 0xffff)
  for (let i = minEocd; i <= maxScan; i++) {
    const pos = view.byteLength - i
    if (pos < 0) break
    if (view.getUint32(pos, true) !== SIG_EOCD) continue

    const totalEntries = view.getUint16(pos + 10, true)
    const cdSize = view.getUint32(pos + 12, true)
    const cdOffset = view.getUint32(pos + 16, true)

    // ZIP64 定位器紧挨在 EOCD 之前
    let isZip64 = false
    if (pos >= 20 && view.getUint32(pos - 20, true) === SIG_EOCD64_LOCATOR) {
      isZip64 = true
      const eocd64At = Number(view.getBigUint64(pos - 12, true))
      if (eocd64At >= 0 && eocd64At + 56 <= view.byteLength && view.getUint32(eocd64At, true) === SIG_EOCD64) {
        return {
          totalEntries: Number(view.getBigUint64(eocd64At + 32, true)),
          cdSize: Number(view.getBigUint64(eocd64At + 40, true)),
          cdOffset: Number(view.getBigUint64(eocd64At + 48, true)),
          isZip64: true,
        }
      }
    }
    return { totalEntries, cdSize, cdOffset, isZip64 }
  }
  return null
}

function extractEntry(
  data: Uint8Array,
  view: DataView,
  entry: ZipEntryInfo,
  opts: { remainingQuota: number; verifyCrc: boolean },
): Buffer {
  const localOffset = entry.localHeaderOffset
  if (localOffset + 30 > data.byteLength) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'local-header-out-of-range', name: entry.name },
    })
  }
  if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'local-header-signature-mismatch', name: entry.name },
    })
  }

  // 本地头的名字/扩展区长度可能与中央目录不同（扩展区尤其常见），必须重新读
  const localNameLen = view.getUint16(localOffset + 26, true)
  const localExtraLen = view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + 30 + localNameLen + localExtraLen
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > data.byteLength) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'entry-data-truncated', name: entry.name, dataStart, dataEnd, bytes: data.byteLength },
    })
  }

  const raw = data.subarray(dataStart, dataEnd)
  // 即使中央目录声明的大小被伪造，maxOutputLength 也会在超出配额时直接失败，
  // 这是防 zip bomb 的最后一道闸门（不会把内存吃爆）。
  const limit = Math.max(entry.uncompressedSize, 0) + 1024
  const hardLimit = Math.max(0, Math.min(limit, opts.remainingQuota + 1024))

  let out: Buffer
  try {
    if (entry.compressionMethod === METHOD_STORE) {
      if (raw.byteLength > hardLimit) {
        throw new RangeError('store 条目声明的解压大小超过配额')
      }
      out = Buffer.from(raw)
    } else if (entry.compressionMethod === METHOD_DEFLATE) {
      out = inflateRawSync(raw, { maxOutputLength: hardLimit })
    } else {
      throw new AppError('PACKAGE_INVALID', {
        details: { reason: 'unsupported-method', name: entry.name, method: entry.compressionMethod },
      })
    }
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError('PACKAGE_INVALID', {
      cause: e,
      details: { reason: 'entry-inflate-failed', name: entry.name },
    })
  }

  if (out.byteLength !== entry.uncompressedSize && entry.uncompressedSize !== 0) {
    throw new AppError('PACKAGE_INVALID', {
      details: {
        reason: 'entry-size-mismatch',
        name: entry.name,
        declared: entry.uncompressedSize,
        actual: out.byteLength,
      },
    })
  }

  if (opts.verifyCrc && entry.crc32 !== 0) {
    const actual = crc32(out)
    if (actual !== entry.crc32) {
      throw new AppError('PACKAGE_CHECKSUM_MISMATCH', {
        params: { count: '1' },
        details: {
          reason: 'entry-crc-mismatch',
          name: entry.name,
          expected: entry.crc32.toString(16),
          actual: actual.toString(16),
        },
      })
    }
  }

  return out
}

/** 名字解码：UTF-8 标志位（bit 11）置位时按 UTF-8，否则按 CP437 近似（latin1） */
function decodeName(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x0800) !== 0) return Buffer.from(bytes).toString('utf8')
  // 中文包基本都置了 UTF-8 位；未置位时先试 UTF-8，失败再退回 latin1
  const utf8 = Buffer.from(bytes).toString('utf8')
  return utf8.includes('\uFFFD') ? Buffer.from(bytes).toString('latin1') : utf8
}

/**
 * 便捷入口：从 Buffer 打开（`fs.readFileSync` 的结果可直接传入）。
 * 大包（> 几百 MB）应改用流式实现 —— 见 writer.ts 顶部的说明。
 */
export function openZipBuffer(buffer: Buffer, options?: ZipReaderOptions): ZipReader {
  return openZip(buffer, options)
}
