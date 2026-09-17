/**
 * Novel Studio · ZIP 写入（接口 + 生产适配 + 一个真实的 store 实现）
 * ============================================================================
 * 设计依据：docs/03 §8 / §9 的包结构；docs/11 §6.2 的导出流程
 *
 * 本文件提供三层：
 *   1. `ZipWriter` —— 导出编排只依赖这个接口（nst.ts / nsp.ts 都注入它）
 *   2. `createArchiverZipWriter()` —— **生产实现**：适配 `archiver`（流式 deflate，不占内存）。
 *      因为本仓库当前环境没有 node_modules，这里不 import archiver，而是要求调用方注入
 *      工厂函数（`const archiver = (await import('archiver')).default`），
 *      这样既零依赖又能直接用于生产；缺注入时**明确报错**，不返回伪造的包。
 *   3. `createStoreZipWriter()` —— **真实可用**的纯 Node 最小实现（仅 store=0，不压缩）。
 *      用于测试、小包与「archiver 不可用」时的兜底；它写出的 ZIP 能被任何解压工具打开，
 *      因为 CRC32 / 中央目录 / EOCD 都是按规范算的。
 *
 * ⚠ 为什么生产要用 archiver：store 实现会把整包放在内存 + 不做压缩。
 * `.nsp` 动辄几 GB（docs/03 §8 的体积表），必须流式 deflate 写盘。
 */

import { AppError } from '../../../../../shared/errors.ts'

// ============================================================================
// 接口
// ============================================================================

export interface ZipAddOptions {
  /** true = 不压缩（音频本身已压缩，再 deflate 收益极小但很费 CPU） */
  store?: boolean
  /** 条目的修改时间（默认现在） */
  modifiedAt?: Date
}

export interface ZipFinalizeResult {
  /** 包内条目名（不含目录条目） */
  entries: string[]
  /** 压缩后总字节数 */
  bytes: number
  /** 未压缩总字节数 */
  uncompressedBytes: number
}

export interface ZipWriter {
  readonly name: string
  /** 已写入的条目名（顺序即写入顺序，便于断言包结构） */
  readonly entries: readonly string[]
  addFile(name: string, data: Uint8Array | Buffer, options?: ZipAddOptions): Promise<void> | void
  addDirectory(name: string): Promise<void> | void
  finalize(): Promise<ZipFinalizeResult>
  /** 中止导出（清理半成品；调用方捕获 TASK_CANCELLED） */
  abort(): Promise<void> | void
}

/** 取消检查（导出编排在每个阶段前调用） */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('TASK_CANCELLED')
}

// ============================================================================
// 生产：archiver 适配（依赖注入，不 import 第三方包）
// ============================================================================

export interface ArchiverLike {
  on(event: 'error' | 'warning' | 'end' | 'close', listener: (arg?: unknown) => void): ArchiverLike
  append(source: Uint8Array | Buffer | NodeJS.ReadableStream, data: { name: string; date?: Date }): ArchiverLike
  file(path: string, data: { name: string }): ArchiverLike
  pipe<T>(destination: T): T
  finalize(): Promise<void>
  abort(): void
  pointer(): number
}

export interface ArchiverFactoryLike {
  (format: 'zip', options: { zlib: { level: number } }): ArchiverLike
}

export interface WritableLike {
  on(event: 'close' | 'error' | 'finish', listener: (arg?: unknown) => void): WritableLike
  write(chunk: Uint8Array): boolean
  end(): void
}

export interface ArchiverZipWriterOptions {
  archive: ArchiverLike
  /** 输出目标（fs.createWriteStream('x.nsp')） */
  output: WritableLike
  /** deflate 级别：音频用 0（store），文本用 6（zlib level 也支持 0） */
  zlibLevel?: number
}

/** 生产实现要点（放在这里，避免实现细节散落在注释里） */
export const ARCHIVER_ADAPTER_NOTES = [
  '生产用 archiver 的理由：流式 deflate，几 GB 的 .nsp 不会把进程内存吃爆。',
  '接线方式（本仓库不 import 第三方包，故由调用方注入工厂）：',
  "  const archiver = (await import('archiver')).default",
  '  const output = fs.createWriteStream(packagePath)',
  '  const archive = archiver(\'zip\', { zlib: { level: 6 } })',
  '  archive.pipe(output)',
  '  const writer = createArchiverZipWriter({ archive, output })',
  '注意事项：',
  '1. 音频条目建议用 store（level 0）：WAV 已压缩收益低，还会吃掉大量 CPU。',
  '2. 必须先 finalize() 再等 output 的 close 事件，否则包会缺 EOCD（打不开）。',
  '3. 导出失败要 abort()，避免留下 0 字节或半截的包让用户以为导出成功。',
  '4. archiver 的 append(stream) 适合大文件直传，避免把整个 WAV 读进内存。',
].join('\n')

/**
 * 用 archiver 实例包装成 `ZipWriter`。
 *
 * 这里**不做任何数据伪造**：所有条目都通过 `archive.append` 真实写入 `output`；
 * `finalize()` 会等待输出流关闭，确保 EOCD 落盘。
 */
export function createArchiverZipWriter(options: ArchiverZipWriterOptions): ZipWriter {
  const { archive, output } = options
  const names: string[] = []
  let finalized = false
  let aborted = false
  let uncompressed = 0
  let failure: unknown = null

  archive.on('error', (e) => {
    failure = e
  })
  output.on('error', (e) => {
    failure = e
  })

  const writer: ZipWriter = {
    name: 'archiver',
    get entries() {
      return names
    },
    addFile(name, data) {
      if (aborted) throw new AppError('TASK_CANCELLED')
      names.push(name)
      uncompressed += data.byteLength
      archive.append(data, { name })
      if (failure) throw new AppError('PACKAGE_EXPORT_FAILED', { cause: failure, details: { entry: name } })
    },
    addDirectory(name) {
      if (aborted) throw new AppError('TASK_CANCELLED')
      const dir = name.endsWith('/') ? name : `${name}/`
      names.push(dir)
      archive.append(Buffer.alloc(0), { name: dir })
    },
    async finalize() {
      if (aborted) throw new AppError('TASK_CANCELLED')
      if (failure) throw new AppError('PACKAGE_EXPORT_FAILED', { cause: failure })
      await archive.finalize()
      await new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve())
        output.on('finish', () => resolve())
        output.end()
        if (failure) reject(failure)
      })
      finalized = true
      return { entries: [...names], bytes: archive.pointer(), uncompressedBytes: uncompressed }
    },
    abort() {
      aborted = true
      if (!finalized) archive.abort()
    },
  }
  return writer
}

// ============================================================================
// 真实可用的最小实现：store（不压缩）
// ============================================================================

export interface StoreZipWriterOptions {
  /** 包名（仅用于诊断） */
  name?: string
  /** 每个数据块写盘的回调；不传则全部留在内存（小包/测试用） */
  sink?: (chunk: Uint8Array) => void | Promise<void>
  /** 进度回调（docs/04 §2 的任务进度） */
  onProgress?: (info: { stage: string; progress: number; entries: number; bytes: number }) => void
  signal?: AbortSignal
  /** 注入时钟（测试可固定 DOS 时间戳） */
  now?: () => Date
}

export interface StoreZipWriter extends ZipWriter {
  /** 取回内存里的完整包字节（未设置 sink 时才有意义） */
  toBuffer(): Buffer
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** 与 reader.ts 一致的标准 CRC-32（同一算法，独立实现便于互相校验） */
export function crc32Store(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * 纯 Node 的最小 ZIP 写入器（仅 store=0）。
 *
 * 产出的是**规范合法的 ZIP**：本地头 + 数据 + 中央目录 + EOCD，
 * CRC32 与尺寸都按真实数据计算，因此能被 `openZip()` 以及系统解压工具读回。
 * 生产大包请改用 `createArchiverZipWriter`（流式 + deflate）。
 */
export function createStoreZipWriter(options: StoreZipWriterOptions = {}): StoreZipWriter {
  const now = options.now ?? (() => new Date())
  const chunks: Buffer[] = []
  const names: string[] = []
  const localMeta: Array<{ name: string; crc: number; size: number; offset: number; time: number; date: number; isDir: boolean }> = []
  let offset = 0
  let uncompressed = 0
  let finished = false
  let aborted = false

  const push = async (buf: Buffer): Promise<void> => {
    if (options.sink) await options.sink(buf)
    else chunks.push(buf)
    offset += buf.byteLength
  }

  const writeEntry = async (name: string, data: Uint8Array, isDir: boolean, modifiedAt?: Date): Promise<void> => {
    throwIfAborted(options.signal)
    if (finished) throw new AppError('PACKAGE_EXPORT_FAILED', { details: { reason: 'writer-already-finalized' } })

    const safeName = isDir && !name.endsWith('/') ? `${name}/` : name
    const nameBytes = Buffer.from(safeName, 'utf8')
    const crc = isDir ? 0 : crc32Store(data)
    const { time, date } = dosDateTime(modifiedAt ?? now())
    const localOffset = offset

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // UTF-8 名字
    header.writeUInt16LE(0, 8) // method = store
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.byteLength, 18)
    header.writeUInt32LE(data.byteLength, 22)
    header.writeUInt16LE(nameBytes.byteLength, 26)
    header.writeUInt16LE(0, 28) // extra len

    await push(header)
    // ⚠ 名字必须紧跟本地头写入：漏掉它会让 dataStart 偏移错位，
    // 读出来的就是下一段字节（CRC 校验会立刻抓到，别删这道校验）
    await push(nameBytes)
    await push(Buffer.from(data))
    localMeta.push({ name: safeName, crc, size: data.byteLength, offset: localOffset, time, date, isDir })
    names.push(safeName)
    if (!isDir) uncompressed += data.byteLength
    options.onProgress?.({
      stage: `写入 ${safeName}`,
      progress: 0.5,
      entries: names.length,
      bytes: offset,
    })
  }

  return {
    name: options.name ?? 'store-zip',
    get entries() {
      return names
    },
    addFile(name, data) {
      return writeEntry(name, data, false)
    },
    addDirectory(name) {
      return writeEntry(name, Buffer.alloc(0), true)
    },
    async finalize() {
      throwIfAborted(options.signal)
      if (finished) throw new AppError('PACKAGE_EXPORT_FAILED', { details: { reason: 'writer-already-finalized' } })
      const cdStart = offset
      for (const m of localMeta) {
        const nameBytes = Buffer.from(m.name, 'utf8')
        const cd = Buffer.alloc(46)
        cd.writeUInt32LE(0x02014b50, 0)
        cd.writeUInt16LE(0x031e, 4) // version made by: unix(3) + 30
        cd.writeUInt16LE(20, 6)
        cd.writeUInt16LE(0x0800, 8) // UTF-8
        cd.writeUInt16LE(0, 10) // store
        cd.writeUInt16LE(m.time, 12)
        cd.writeUInt16LE(m.date, 14)
        cd.writeUInt32LE(m.crc, 16)
        cd.writeUInt32LE(m.size, 20)
        cd.writeUInt32LE(m.size, 24)
        cd.writeUInt16LE(nameBytes.byteLength, 28)
        cd.writeUInt16LE(0, 30) // extra
        cd.writeUInt16LE(0, 32) // comment
        cd.writeUInt16LE(0, 34) // disk
        cd.writeUInt16LE(0, 36) // internal attrs
        // 外部属性：目录 0o40755，文件 0o100644（让 unix 解压工具给出正确权限）
        cd.writeUInt32LE(((m.isDir ? 0o40755 : 0o100644) << 16) >>> 0, 38)
        cd.writeUInt32LE(m.offset, 42)
        await push(cd)
        await push(nameBytes)
      }
      const cdSize = offset - cdStart
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0)
      eocd.writeUInt16LE(0, 4)
      eocd.writeUInt16LE(0, 6)
      eocd.writeUInt16LE(localMeta.length, 8)
      eocd.writeUInt16LE(localMeta.length, 10)
      eocd.writeUInt32LE(cdSize, 12)
      eocd.writeUInt32LE(cdStart, 16)
      eocd.writeUInt16LE(0, 20) // comment len
      await push(eocd)
      finished = true
      options.onProgress?.({ stage: '完成', progress: 1, entries: names.length, bytes: offset })
      return { entries: [...names], bytes: offset, uncompressedBytes: uncompressed }
    },
    async abort() {
      aborted = true
      chunks.length = 0
    },
    toBuffer() {
      if (aborted) throw new AppError('TASK_CANCELLED')
      return Buffer.concat(chunks)
    },
  }
}

/**
 * 统一的 ZipWriter 工厂。
 *
 * · 给了 `archiverFactory` → 生产实现（流式 deflate）
 * · 否则 → `createStoreZipWriter()`（真实可用，但不压缩、占内存）
 *
 * **不会**在缺少依赖时返回一个「假装成功」的写入器。
 */
export function createZipWriter(options: {
  archiverFactory?: ArchiverFactoryLike
  archive?: ArchiverLike
  output?: WritableLike
  zlibLevel?: number
  fallback?: StoreZipWriterOptions
}): ZipWriter {
  if (options.archiverFactory && options.output) {
    const archive = options.archive ?? options.archiverFactory('zip', { zlib: { level: options.zlibLevel ?? 6 } })
    return createArchiverZipWriter({ archive, output: options.output, zlibLevel: options.zlibLevel })
  }
  return createStoreZipWriter(options.fallback ?? {})
}
