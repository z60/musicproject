/**
 * 基础设施 · 哈希与稳定序列化
 * ============================================================================
 * 设计依据：
 *   · docs/04 §3「sha256File / sha256Buffer：导入去重、缓存键、包校验」
 *   · docs/04 §4「缓存键 = sha256(...)，其中嵌入文件 mtime/size」
 *   · docs/13 §9.4「paramsHash / outputHash 是导出断点续传的依据」
 *
 * `stableStringify` 是**所有幂等键的基础**：对象字面量顺序不同会导致 JSON 不同，
 * 若直接用 JSON.stringify 生成哈希，同一份参数会算出两个键，缓存与断点续传全部失效。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { AppError } from '../../../shared/errors.ts'

const HEX = 'hex' as const

/** 内存缓冲的 sha256（十六进制小写） */
export function sha256Buffer(data: Uint8Array | string): string {
  const h = createHash('sha256')
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
  return h.digest(HEX)
}

/**
 * 文件内容的 sha256（**流式**，不把整个文件读进内存）。
 * 大音频文件（几百 MB）必须走这条路径，否则主进程内存会瞬间飙高。
 */
export async function sha256File(
  filePath: string,
  opts?: { onProgress?: (bytes: number) => void; chunkBytes?: number },
): Promise<string> {
  const h = createHash('sha256')
  let total = 0
  const stream = createReadStream(filePath, { highWaterMark: opts?.chunkBytes ?? 1024 * 1024 })
  await new Promise<void>((resolvePromise, reject) => {
    stream.on('data', (chunk) => {
      h.update(chunk)
      total += chunk.length
      opts?.onProgress?.(total)
    })
    stream.on('error', (e) => reject(new AppError('FILE_NOT_FOUND', { cause: e, details: { path: filePath } })))
    stream.on('end', () => resolvePromise())
  })
  return h.digest(HEX)
}

/**
 * 文件指纹：`sha256(内容)`（带缓存友好参数）。
 * 波形峰值、质量测量等缓存用 `sha256(path + size + mtimeMs)` 即可，无需读内容（docs/04 §4）。
 */
export async function fileFingerprint(
  filePath: string,
  extra?: string | number,
): Promise<{ hash: string; sizeBytes: number; mtimeMs: number }> {
  const st = await stat(filePath)
  const parts: Array<string | number> = [filePath, st.size, Math.floor(st.mtimeMs)]
  if (extra !== undefined) parts.push(extra)
  return { hash: sha256Buffer(stableStringify(parts)), sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs) }
}

/**
 * 键排序 + 递归规范化的 JSON 序列化。
 *
 * 与 `JSON.stringify` 的差异：
 *   · 对象键按字典序输出（同一份数据永远同一串）
 *   · 忽略 `undefined` 值的键（`{a:undefined}` 与 `{}` 等价，避免无意义的新键）
 *   · `Date` → ISO 字符串；`Map`/`Set` → 排序后的数组（保证确定性）
 *   · 循环引用直接抛错（缓存键必须有限，否则是 bug）
 */
export function stableStringify(value: unknown): string {
  return stringify(value, new Set<unknown>())
}

function stringify(value: unknown, seen: Set<unknown>): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null'
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)
  if (t === 'bigint') return JSON.stringify(String(value))
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null'

  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value instanceof Uint8Array) return JSON.stringify(sha256Buffer(value))

  if (seen.has(value)) {
    throw new AppError('INTERNAL', { details: { reason: 'stableStringify:circular' } })
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stringify(item, seen)).join(',')}]`
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      return `{${entries.map(([k, v]) => `${JSON.stringify(String(k))}:${stringify(v, seen)}`).join(',')}}`
    }
    if (value instanceof Set) {
      const items = [...value].map((item) => stringify(item, seen)).sort()
      return `[${items.join(',')}]`
    }
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k], seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

/** 幂等键：`cacheKey('asr', modelId, textHash)` → sha256 十六进制 */
export function cacheKey(...parts: unknown[]): string {
  return sha256Buffer(stableStringify(parts.length === 1 ? parts[0] : parts))
}

/** 导出参数的 paramsHash（docs/05 §9.4：改了第 30 章只重渲第 30 章） */
export function paramsHash(parts: unknown): string {
  return sha256Buffer(stableStringify(parts))
}
