/**
 * Novel Studio · 纯 Node ZIP 读取与解压防护测试（docs/03 §8 导入规则 5）
 * ============================================================================
 * 运行：
 *   node --experimental-strip-types tests/main/package-zip.test.ts
 *
 * 本文件的关键设计：**手写 ZIP 字节流**（见下面的 buildZip），
 * 完全不使用仓库自己的 writer，也不使用任何第三方 zip 库 ——
 * 这样 `openZip()` 才是被「外部构造的真实 ZIP」验证的，
 * 而不是被自家写入器验证（否则 CRC/偏移写错会一起错、一起通过）。
 *
 * 覆盖：
 *   · store(0) 与 deflate(8) 两种压缩方法都能列条目、读回内容
 *   · 目录条目单独处理
 *   · 防护：路径穿越 / 绝对路径 / 符号链接 / 条目数超限 / 总解压大小超限 /
 *           压缩比异常（zip bomb）/ 加密条目 / CRC 不匹配 / 截断 / 无 EOCD
 *   · 非严格模式（导入流程用）：违规条目跳过并记录，其余照常读取
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { deflateRawSync } from 'node:zlib'

import { isAppError } from '../../src/shared/errors.ts'
import {
  DEFAULT_MAX_COMPRESSION_RATIO,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES,
  crc32,
  normalizeEntryName,
  openZip,
  type ZipReaderOptions,
} from '../../src/main/features/book/package/zip/reader.ts'
import { createStoreZipWriter } from '../../src/main/features/book/package/zip/writer.ts'

// ---------------------------------------------------------------------------
// 独立参考实现：CRC32（不用 reader 的，避免循环验证）
// ---------------------------------------------------------------------------

function refCrc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// 手工构造 ZIP 字节流
// ---------------------------------------------------------------------------

interface TestEntry {
  name: string
  data: Buffer
  /** 0 = store（默认），8 = deflate */
  method?: 0 | 8
  /** 覆盖写进「中央目录」的 CRC（造校验失败用） */
  crcOverride?: number
  /** unix 模式（写进外部属性高 16 位）；目录默认 0o40755，文件 0o100644 */
  unixMode?: number
  /** 覆盖通用标志位（bit0 = 加密） */
  flags?: number
  /** 覆盖本地头里的压缩后大小（造截断用） */
  compressedSizeOverride?: number
}

/**
 * 按 ZIP 规范手工拼字节：本地头 → 数据 → 中央目录 → EOCD。
 * 每个字段的偏移都能在规范里对上，便于读者核对本实现的正确性。
 */
function buildZip(entries: TestEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8')
    const method = e.method ?? 0
    const payload = method === 8 ? deflateRawSync(e.data) : e.data
    const crc = e.crcOverride ?? refCrc32(e.data)
    const isDir = e.name.endsWith('/')

    // ---- 本地头（30 字节）+ 名字 + 数据 ----
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地头签名
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(e.flags ?? 0x0800, 6) // UTF-8 名字
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x2800, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.compressedSizeOverride ?? payload.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    const localFull = Buffer.concat([local, nameBytes, payload])

    // ---- 中央目录条目（46 字节）+ 名字 ----
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // version made by: unix(3).30
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(e.flags ?? 0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x2800, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    const unixMode = e.unixMode ?? (isDir ? 0o40755 : 0o100644)
    central.writeUInt32LE((unixMode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)

    localParts.push(localFull)
    centralParts.push(Buffer.concat([central, nameBytes]))
    offset += localFull.length
  }

  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, cd, eocd])
}

const STORE_ZIP = buildZip([
  { name: 'manifest.json', data: Buffer.from('{"format":"nst"}', 'utf8') },
  { name: 'note.txt', data: Buffer.from('存储方式：store', 'utf8') },
  { name: 'slots/', data: Buffer.alloc(0) },
])

const DEFLATE_ZIP = buildZip([
  { name: 'big.txt', data: Buffer.from('重复内容用以验证 deflate 解压。'.repeat(500), 'utf8'), method: 8 },
])

// ---------------------------------------------------------------------------
// 基本读取
// ---------------------------------------------------------------------------

describe('ZIP 读取 · store 与 deflate', () => {
  it('store(0)：能列出条目并按名读回内容', () => {
    const zip = openZip(STORE_ZIP)
    assert.deepEqual(
      zip.listEntries().map((e) => e.name),
      ['manifest.json', 'note.txt'],
      '目录条目默认不出现',
    )
    assert.equal(zip.readText('manifest.json'), '{"format":"nst"}')
    assert.equal(zip.readText('note.txt'), '存储方式：store')
    assert.equal(zip.getEntry('note.txt')?.compressionMethod, 0)
    assert.equal(zip.getEntry('note.txt')?.uncompressedSize, Buffer.byteLength('存储方式：store'))
    assert.equal(zip.declaredEntries, 3)
  })

  it('目录条目可通过 includeDirectories 列出，且 unix 模式被正确解析', () => {
    const zip = openZip(STORE_ZIP)
    const all = zip.listEntries({ includeDirectories: true })
    assert.deepEqual(all.map((e) => e.name), ['manifest.json', 'note.txt', 'slots/'])
    const dir = zip.listEntries({ includeDirectories: true }).find((e) => e.name === 'slots/')
    assert.equal(dir?.isDirectory, true)
    assert.equal(dir?.isSymlink, false)
    assert.equal((dir?.unixMode ?? 0) & 0o40000, 0o40000, '应解析出目录位')
  })

  it('deflate(8)：inflateRawSync 正确解压，且长度与中央目录声明一致', () => {
    const raw = '重复内容用以验证 deflate 解压。'.repeat(500)
    const zip = openZip(DEFLATE_ZIP)
    const entry = zip.getEntry('big.txt')
    assert.equal(entry?.compressionMethod, 8)
    assert.ok((entry?.compressedSize ?? 0) < (entry?.uncompressedSize ?? 0), 'deflate 应确实变小')
    assert.equal(zip.readText('big.txt'), raw)
    assert.equal(zip.totalBytesRead, Buffer.byteLength(raw))
  })

  it('readEntry 的 CRC32 与独立参考实现一致', () => {
    const zip = openZip(DEFLATE_ZIP)
    const data = zip.readEntry('big.txt')
    assert.equal(refCrc32(data), crc32(data), '两处 CRC 实现必须一致')
  })

  it('has / getEntry / readEntry 对不存在的条目给出明确错误', () => {
    const zip = openZip(STORE_ZIP)
    assert.equal(zip.has('nope.txt'), false)
    assert.equal(zip.getEntry('nope.txt'), null)
    assert.throws(
      () => zip.readEntry('nope.txt'),
      (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID' && e.details?.reason === 'entry-not-found',
    )
  })

  it('自研 writer 与手工字节流的读取结果一致（交叉验证，防止两边一起写错）', async () => {
    const writer = createStoreZipWriter()
    await writer.addFile('manifest.json', Buffer.from('{"format":"nst"}', 'utf8'))
    await writer.addFile('note.txt', Buffer.from('存储方式：store', 'utf8'))
    await writer.addDirectory('slots')
    await writer.finalize()

    const zip = openZip(writer.toBuffer())
    assert.deepEqual(
      zip.listEntries().map((e) => e.name),
      ['manifest.json', 'note.txt'],
    )
    assert.equal(zip.readText('note.txt'), '存储方式：store')
    // 与手工构造的包对照
    const hand = openZip(STORE_ZIP)
    assert.equal(zip.readText('manifest.json'), hand.readText('manifest.json'))
  })
})

// ---------------------------------------------------------------------------
// 防护
// ---------------------------------------------------------------------------

describe('ZIP 防护 · 路径穿越与符号链接', () => {
  it('拒绝路径穿越条目（strict 默认抛 PACKAGE_INVALID）', () => {
    const evil = buildZip([{ name: '../evil.txt', data: Buffer.from('x') }])
    assert.throws(
      () => openZip(evil),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_INVALID')
        assert.equal(e.details?.reason, 'zip-defense-violation')
        const violations = e.details?.violations as Array<{ kind: string }>
        assert.equal(violations[0].kind, 'path-traversal')
        return true
      },
    )
  })

  it('拒绝绝对路径与盘符开头', () => {
    for (const name of ['/etc/passwd', 'C:/Windows/system32/x.txt', '\\\\server\\share\\x.txt']) {
      const evil = buildZip([{ name, data: Buffer.from('x') }])
      assert.throws(
        () => openZip(evil),
        (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
        `${name} 应被拒绝`,
      )
    }
  })

  it('拒绝符号链接条目（unix 模式 0xA000）', () => {
    const evil = buildZip([{ name: 'link.txt', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 }])
    assert.throws(
      () => openZip(evil),
      (e: unknown) => {
        assert.ok(isAppError(e))
        const violations = e.details?.violations as Array<{ kind: string }>
        assert.equal(violations.some((v) => v.kind === 'symlink'), true)
        return true
      },
    )
  })

  it('拒绝加密条目（flags bit0）', () => {
    const evil = buildZip([{ name: 'secret.txt', data: Buffer.from('x'), flags: 0x0801 }])
    assert.throws(
      () => openZip(evil),
      (e: unknown) => {
        assert.ok(isAppError(e))
        const violations = e.details?.violations as Array<{ kind: string }>
        assert.equal(violations.some((v) => v.kind === 'encrypted'), true)
        return true
      },
    )
  })

  it('非严格模式：违规条目被跳过并记录，其余条目照常可读（导入流程用）', () => {
    const zip = buildZip([
      { name: 'ok.txt', data: Buffer.from('normal') },
      { name: '../../escape.txt', data: Buffer.from('evil') },
    ])
    const reader = openZip(zip, { strict: false })
    assert.deepEqual(reader.listEntries().map((e) => e.name), ['ok.txt'])
    assert.equal(reader.violations.length, 1)
    assert.equal(reader.violations[0].kind, 'path-traversal')
    assert.equal(reader.readText('ok.txt'), 'normal')
    assert.throws(
      () => reader.readEntry('../../escape.txt'),
      (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
    )
  })

  it('normalizeEntryName 的判定表', () => {
    assert.equal(normalizeEntryName('a/b/c.txt'), 'a/b/c.txt')
    assert.equal(normalizeEntryName('a\\b\\c.txt'), 'a/b/c.txt')
    assert.equal(normalizeEntryName('slots/line-1/'), 'slots/line-1/')
    assert.equal(normalizeEntryName('./a.txt'), 'a.txt')
    assert.equal(normalizeEntryName('../a.txt'), null)
    assert.equal(normalizeEntryName('a/../../b.txt'), null)
    assert.equal(normalizeEntryName('/abs.txt'), null)
    assert.equal(normalizeEntryName('D:evil.txt'), null)
    assert.equal(normalizeEntryName('a\u0000b.txt'), null)
    assert.equal(normalizeEntryName(''), null)
  })
})

describe('ZIP 防护 · 条目数 / 总大小 / zip bomb', () => {
  it('条目数超限被拒（默认上限 50000，测试用小上限）', () => {
    const many = buildZip(
      Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from(String(i)) })),
    )
    assert.throws(
      () => openZip(many, { maxEntries: 3 }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        const violations = e.details?.violations as Array<{ kind: string }>
        assert.equal(violations.some((v) => v.kind === 'entry-count'), true)
        return true
      },
    )
    // 放宽上限即可正常打开
    assert.equal(openZip(many, { maxEntries: 10 }).listEntries().length, 5)
  })

  it('默认上限就是 docs/03 §8 规定的 50000 条 / 50 GB，且 50001 条真的会被拦住', () => {
    assert.equal(DEFAULT_MAX_ENTRIES, 50_000)
    assert.equal(DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES, 50 * 1024 ** 3)
    assert.equal(DEFAULT_MAX_COMPRESSION_RATIO, 1000)

    // 造 50001 个空条目（EOCD 的条目数是 16 位，50001 仍在范围内）
    const entries: TestEntry[] = Array.from({ length: DEFAULT_MAX_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      data: Buffer.alloc(0),
    }))
    const many = buildZip(entries)
    assert.throws(
      () => openZip(many),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_INVALID')
        const violations = e.details?.violations as Array<{ kind: string; message: string }>
        assert.equal(violations.some((v) => v.kind === 'entry-count'), true)
        return true
      },
    )
  })

  it('总解压大小超限被拒（自定义小上限）', () => {
    const zip = buildZip([
      { name: 'a.bin', data: Buffer.alloc(4096) },
      { name: 'b.bin', data: Buffer.alloc(4096) },
    ])
    assert.throws(
      () => openZip(zip, { maxTotalUncompressedBytes: 5000 }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        const violations = e.details?.violations as Array<{ kind: string }>
        assert.equal(violations.some((v) => v.kind === 'total-size'), true)
        return true
      },
    )
  })

  it('读取过程中累计超限也会被拦住（防声明值造假）', () => {
    const zip = buildZip([
      { name: 'a.bin', data: Buffer.alloc(3000) },
      { name: 'b.bin', data: Buffer.alloc(3000) },
    ])
    const reader = openZip(zip, { maxTotalUncompressedBytes: 4000, strict: false })
    // 单条声明都小于上限，所以打开时不算违规；累计读取后超限
    assert.throws(
      () => {
        reader.readEntry('a.bin')
        reader.readEntry('b.bin')
      },
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_INVALID')
        return true
      },
    )
  })

  it('压缩比异常（zip bomb）被默认阈值拦住，也会被更严的自定义阈值拦住', () => {
    // 4 MB 的零字节 deflate 后只有几 KB，压缩比超过 1000:1
    const bomb = buildZip([{ name: 'bomb.bin', data: Buffer.alloc(4 * 1024 * 1024), method: 8 }])
    assert.throws(
      () => openZip(bomb),
      (e: unknown) => {
        assert.ok(isAppError(e))
        const violations = e.details?.violations as Array<{ kind: string }>
        assert.equal(violations.some((v) => v.kind === 'compression-ratio'), true)
        return true
      },
      '默认 1000:1 的阈值应拦住 4 MB 全零的典型 zip bomb',
    )

    // 压缩比正常的条目（近似随机的字节）不该被误判
    const noisy = Buffer.alloc(2 * 1024 * 1024)
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 2654435761) % 251
    const normal = buildZip([{ name: 'noise.bin', data: noisy, method: 8 }])
    assert.doesNotThrow(() => openZip(normal), '压缩比 ~1:1 的数据不应被误判为炸弹')

    // 更严的阈值下同样的数据会被拦住
    assert.throws(
      () => openZip(normal, { maxCompressionRatio: 0.5, minSizeForRatioCheck: 1024 }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        const violations = e.details?.violations as Array<{ kind: string }>
        assert.equal(violations.some((v) => v.kind === 'compression-ratio'), true)
        return true
      },
    )
  })

  it('小条目不受压缩比检查（避免正常的小文件被误判）', () => {
    // 100 字节全零 → deflate 后极小，压缩比很高，但体积低于 minSizeForRatioCheck
    const tiny = buildZip([{ name: 'tiny.bin', data: Buffer.alloc(100), method: 8 }])
    assert.doesNotThrow(() => openZip(tiny))
  })

  it('inflateRawSync 的 maxOutputLength 兜底：声明值造假也不会撑爆内存', () => {
    // 真数据 1 MB 全零，但中央目录把 uncompressedSize 谎报成 100 字节
    const bomb = buildZip([{ name: 'liar.bin', data: Buffer.alloc(1024 * 1024), method: 8 }])
    const cdOffset = bomb.readUInt32LE(bomb.length - 22 + 16)
    bomb.writeUInt32LE(100, cdOffset + 24) // uncompressedSize 谎报
    const reader = openZip(bomb, { strict: false, verifyCrc: false })
    assert.throws(
      () => reader.readEntry('liar.bin'),
      (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
    )
  })
})

describe('ZIP 结构异常', () => {
  it('没有 EOCD 的字节流被拒', () => {
    assert.throws(
      () => openZip(Buffer.from('这不是一个 zip 文件，只是一段普通文本。'.repeat(10), 'utf8')),
      (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID' && e.details?.reason === 'eocd-not-found',
    )
  })

  it('数据被截断（中央目录声明的压缩后大小超出文件实际长度）被拒', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('0123456789') }])
    // 改中央目录里的 compressedSize（偏移 20）而不是本地头：
    // 提取时以中央目录为准，所以这里才是真实生效的位置
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16)
    zip.writeUInt32LE(9999, cdOffset + 20)
    const reader = openZip(zip, { strict: false })
    assert.throws(
      () => reader.readEntry('a.txt'),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.details?.reason, 'entry-data-truncated')
        return true
      },
    )
  })

  it('CRC 不匹配被拒（PACKAGE_CHECKSUM_MISMATCH），errors.ts 的语义键可被 UI 用上', () => {
    const bad = buildZip([{ name: 'a.txt', data: Buffer.from('hello'), crcOverride: 0xdeadbeef }])
    const reader = openZip(bad)
    assert.throws(
      () => reader.readEntry('a.txt'),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_CHECKSUM_MISMATCH')
        assert.equal(e.details?.reason, 'entry-crc-mismatch')
        return true
      },
    )
    // 关掉 CRC 校验（例如上游已经用 sha256 校验过）就能读回来
    const noVerify = openZip(bad, { verifyCrc: false })
    assert.equal(noVerify.readText('a.txt'), 'hello')
  })

  it('文件名解码：UTF-8 中文名可正确列出', () => {
    const zip = buildZip([{ name: '音频/第1章.wav', data: Buffer.from('x') }])
    const names = openZip(zip).listEntries().map((e) => e.name)
    assert.deepEqual(names, ['音频/第1章.wav'])
  })

  it('close 之后读取被拒（防止误用一个已释放的读取器）', () => {
    const zip = openZip(STORE_ZIP)
    zip.close()
    assert.throws(
      () => zip.readEntry('note.txt'),
      (e: unknown) => isAppError(e) && e.details?.reason === 'reader-closed',
    )
  })

  it('选项对象可复用：同一份字节在严格/非严格模式下的行为差异被记录', () => {
    const zip = buildZip([{ name: 'ok.txt', data: Buffer.from('ok') }])
    const strictOptions: ZipReaderOptions = { strict: true }
    assert.doesNotThrow(() => openZip(zip, strictOptions))
    assert.equal(openZip(zip, { ...strictOptions, strict: false }).violations.length, 0)
  })
})
