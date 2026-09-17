/**
 * 基础设施 · 路径解析与文件名清洗
 * ============================================================================
 * 设计依据：
 *   · docs/04 §3「路径解析必须强制校验结果落在项目目录内（防 .. 逃逸）」
 *   · docs/03 §2「数据库中只存相对路径；绝对路径只在运行时由 paths.ts 拼接」
 *   · docs/02 §3「ns-media:// 协议 handler 内必须校验路径位于 projectRoot/{projectId}/ 之下」
 *   · docs/05 §9.3「文件名清洗：去特殊字符、UTF-8 字节截断 120、同名加 _2」
 *
 * 本模块是整个应用**唯一**允许把「相对路径 → 绝对路径」的地方。
 * 任何其它模块自己拼路径都是缺陷：那会绕过这里的逃逸校验。
 */

import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { AppError } from '../../../shared/errors.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 文件名默认上限（UTF-8 字节；docs/05 §9.3） */
export const DEFAULT_MAX_FILENAME_BYTES = 120

/** Windows/跨平台非法文件名字符（docs/05 §9.3） */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g
/** 控制字符（0x00-0x1F 与 0x7F） */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
/** 项目目录下用户素材所在子目录：清理时必须白名单保护（docs/04 §3 启动清理规则） */
export const USER_ASSET_DIRS = [
  'recordings',
  'takes',
  'segments',
  'processed',
  'music',
  'exports',
  'packages',
] as const

/** 导出命名模板支持的占位符（docs/05 §9.3） */
export const TEMPLATE_VARS = ['bookTitle', 'chapterIndex', 'chapterTitle', 'narrator', 'date'] as const
export type TemplateVar = (typeof TEMPLATE_VARS)[number]

// ---------------------------------------------------------------------------
// 逃逸校验（铁律）
// ---------------------------------------------------------------------------

/**
 * 判断相对路径是否为「编码后的逃逸尝试」。
 *
 * 原理：文件系统**不会**把 `%2f` 当作分隔符，所以 `..%2f..%2fetc/passwd` 落到磁盘上
 * 只是一个奇怪的文件名。但这类输入 100% 来自注入/拼接 bug，且一旦上游某处多做了一次
 * `decodeURIComponent`，就会真的逃逸。因此策略是**宁可拒绝**：
 * 若百分号解码后**新增了**分隔符、`..` 或 NUL，则判定为逃逸。
 *
 * 注意：`a%20b`（解码后只是空格）是合法文件名，不会被拒。
 */
function isPercentEncodedEscape(rel: string): boolean {
  if (!rel.includes('%')) return false
  let decoded = rel
  for (let round = 0; round < 3; round++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      // 非法百分号编码（如 `%zz`）：不是逃逸手法，作为普通文件名放过
      return false
    }
    if (next === decoded) return false
    if (/[\\/\u0000]/.test(next) || next.split(/[\\/]/).some((s) => s === '..')) return true
    decoded = next
  }
  // 多层编码后仍未收敛：保守拒绝
  return true
}

/** 是否是绝对路径（POSIX / Windows 盘符 / UNC / 文件 URL） */
export function isAbsoluteLike(p: string): boolean {
  if (p.length === 0) return false
  if (isAbsolute(p)) return true
  if (/^[a-zA-Z]:/.test(p)) return true // C:foo（无斜杠的盘符相对路径同样危险）
  if (p.startsWith('\\\\') || p.startsWith('//')) return true // UNC
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return true // file:// data: 等 scheme
  return false
}

function escapeError(details: Record<string, unknown>): AppError {
  // 见 docs/04 §3：命中逃逸一律 PATH_ESCAPE_BLOCKED，不进 UI toast（用户无法行动）
  return new AppError('PATH_ESCAPE_BLOCKED', { details })
}

/**
 * 把「项目内相对路径」规范化，并拒绝一切逃逸手法。
 * 返回以 `/` 分隔的相对路径（不含前导分隔符）。
 */
export function normalizeRelPath(relPath: string, opts?: { field?: string }): string {
  const field = opts?.field ?? 'relPath'
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw escapeError({ [field]: relPath, reason: 'empty' })
  }
  if (relPath.includes('\u0000')) {
    throw escapeError({ [field]: relPath, reason: 'nul-byte' })
  }
  if (isAbsoluteLike(relPath)) {
    throw escapeError({ [field]: relPath, reason: 'absolute-path' })
  }
  if (isPercentEncodedEscape(relPath)) {
    throw escapeError({ [field]: relPath, reason: 'percent-encoded-escape' })
  }

  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
  for (const seg of segments) {
    if (seg === '..') throw escapeError({ [field]: relPath, reason: 'parent-segment' })
  }
  if (segments.length === 0) throw escapeError({ [field]: relPath, reason: 'empty' })
  return segments.join('/')
}

/**
 * 断言绝对路径确实位于某个根目录之内（`..` 与同前缀陷阱都要挡住）。
 * `root` 本身会被规范化，`/a/bc` 不会被误判为在 `/a/b` 内。
 */
export function assertInsideRoot(absPath: string, root: string, details?: Record<string, unknown>): string {
  const normRoot = normalize(resolve(root))
  const normAbs = normalize(resolve(absPath))
  if (normAbs === normRoot) return normAbs
  const withSep = normRoot.endsWith(sep) ? normRoot : normRoot + sep
  if (!normAbs.startsWith(withSep)) {
    throw escapeError({ ...details, root: normRoot, resolved: normAbs })
  }
  return normAbs
}

// ---------------------------------------------------------------------------
// 项目路径
// ---------------------------------------------------------------------------

/**
 * 解析「projects/{projectId}/ 下的相对路径」为绝对路径。
 *
 * @param projectId 项目 ID（UUID）。不接受分隔符/`..`（否则可跨项目读取）
 * @param relPath   数据库里存的相对路径，如 `recordings/abc.wav`
 * @param projectRoot projects 目录（即 `{userData}/projects`），不是某个项目目录
 * @returns 绝对路径，**已断言**落在 `{projectRoot}/{projectId}/` 之内
 *
 * @example
 * resolveProjectPath('p1', 'segments/a.wav', 'C:/data/projects')
 * // → 'C:\\data\\projects\\p1\\segments\\a.wav'
 */
export function resolveProjectPath(projectId: string, relPath: string, projectRoot: string): string {
  if (typeof projectId !== 'string' || !isSafeId(projectId)) {
    throw escapeError({ projectId, reason: 'invalid-project-id' })
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new AppError('APP_CONFIG_INVALID', { details: { field: 'projectRoot' } })
  }
  const rel = normalizeRelPath(relPath)
  const dir = projectDir(projectId, projectRoot)
  return assertInsideRoot(join(dir, rel), dir, { projectId, relPath })
}

/** 某个项目的根目录（绝对路径）。projectId 同样要过 ID 白名单。 */
export function projectDir(projectId: string, projectRoot: string): string {
  if (!isSafeId(projectId)) throw escapeError({ projectId, reason: 'invalid-project-id' })
  return join(resolve(projectRoot), projectId)
}

/** ID 白名单：UUID/nanoid 语义，禁止任何路径分隔符与点号（`..` 因此不可能通过） */
export function isSafeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id)
}

/** 资源（模型/ffmpeg）所在目录：开发与打包两种根自动切换（docs/02 §5） */
export interface ResourceRootOptions {
  isPackaged: boolean
  /** 打包后：`process.resourcesPath`（extraResources 落点） */
  resourcesPath?: string | null
  /** 开发期：仓库根目录（`resources/` 的父目录） */
  devRoot?: string | null
}

/**
 * 解析随包资源路径。
 * 打包：`{resourcesPath}/{rel}`；开发：`{devRoot}/resources/{rel}`。
 */
export function resolveResourcePath(rel: string, opts: ResourceRootOptions): string {
  const relNorm = normalizeRelPath(rel, { field: 'rel' })
  const root = resourceRoot(opts)
  return assertInsideRoot(join(root, relNorm), root, { rel })
}

/** 资源根目录（不含具体文件）。打包后 = resourcesPath；开发期 = {devRoot}/resources */
export function resourceRoot(opts: ResourceRootOptions): string {
  if (opts.isPackaged) {
    if (!opts.resourcesPath) {
      // 缺 resourcesPath 说明启动顺序装配错了（应在 bootstrap 里由 process.resourcesPath 注入）
      throw new AppError('APP_CONFIG_INVALID', { details: { field: 'resourcesPath', isPackaged: true } })
    }
    return resolve(opts.resourcesPath)
  }
  if (!opts.devRoot) {
    throw new AppError('APP_CONFIG_INVALID', { details: { field: 'devRoot', isPackaged: false } })
  }
  return join(resolve(opts.devRoot), 'resources')
}

/**
 * 绝对路径 → 入库用的相对路径（**永远**用 `/` 分隔，docs/03 §2）。
 * 不在 root 之下时抛 PATH_ESCAPE_BLOCKED（宁可报错，也不要存一个换机就失效的绝对路径）。
 */
export function toRelativePath(absPath: string, root: string): string {
  const normRoot = normalize(resolve(root))
  const normAbs = normalize(resolve(absPath))
  if (normAbs === normRoot) return '.'
  const inside = assertInsideRoot(normAbs, normRoot, { absPath, root })
  const rel = inside.slice(normRoot.length).replace(/^[\\/]+/, '')
  return rel.split(/[\\/]+/).filter(Boolean).join('/')
}

// ---------------------------------------------------------------------------
// 文件名清洗
// ---------------------------------------------------------------------------

/**
 * 清洗文件名（**不是路径**：分隔符会被替换掉，因此天然不会逃逸）。
 *
 * 规则（docs/05 §9.3）：
 *   1. 去掉 `\ / : * ? " < > |` 与控制字符
 *   2. 去掉首尾空白与结尾的 `.`（Windows 上 `a.` 无法创建）
 *   3. 按 UTF-8 字节数截断到 `maxBytes`（默认 120），且不切断多字节字符；
 *      截断时保留扩展名（导出成品的 `.mp3` 不能被吃掉）
 *   4. 空名回退为 `untitled`
 *   5. 传了 `existing` 时，同名冲突加 `_2`、`_3`…
 *
 * @param name     原始文件名（可含扩展名）
 * @param maxBytes UTF-8 字节上限，默认 120
 * @param existing 已存在的文件名集合（用于冲突去重）
 */
export function sanitizeFileName(name: string, maxBytes = DEFAULT_MAX_FILENAME_BYTES, existing?: Iterable<string>): string {
  const cleaned = cleanFileName(name, maxBytes)
  if (!existing) return cleaned
  return dedupeFileName(cleaned, existing)
}

/** 只做「清洗 + 截断」，不做冲突去重 */
export function cleanFileName(name: string, maxBytes = DEFAULT_MAX_FILENAME_BYTES): string {
  const raw = typeof name === 'string' ? name : ''
  // 只取最后一段（防止有人把路径当名字传进来）
  const lastSegment = raw.split(/[\\/]+/).filter(Boolean).pop() ?? ''
  let base = lastSegment.replace(ILLEGAL_FILENAME_CHARS, '_').replace(CONTROL_CHARS, '').trim()
  base = base.replace(/[. ]+$/, '').trim()
  if (base.length === 0) base = 'untitled'
  if (base === '.' || base === '..') base = 'untitled'

  const limit = Math.max(8, Math.floor(maxBytes))
  if (Buffer.byteLength(base, 'utf8') <= limit) return base

  // 拆扩展名：只保留「.xxx」形式且扩展名本身不太长的情况
  const dot = base.lastIndexOf('.')
  let ext = ''
  let stem = base
  if (dot > 0 && base.length - dot <= 12) {
    ext = base.slice(dot)
    stem = base.slice(0, dot)
  }
  const extBytes = Buffer.byteLength(ext, 'utf8')
  const stemBudget = Math.max(1, limit - extBytes)
  const truncated = truncateUtf8(stem, stemBudget)
  return (truncated.length > 0 ? truncated : 'untitled') + ext
}

/** 按 UTF-8 字节数截断字符串，且不产生半个字符（代理对也不会被劈开） */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  // Array.from 按码点切分，避免把一个 emoji/生僻字劈成两半
  const points = Array.from(text)
  let out = ''
  let used = 0
  for (const ch of points) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}

/**
 * 同名冲突加 `_2`（第二份）、`_3`…（docs/05 §9.3）。
 * 扩展名保持在末尾：`a.mp3` → `a_2.mp3`。
 */
export function dedupeFileName(name: string, existing: Iterable<string>): string {
  const taken = existing instanceof Set ? (existing as Set<string>) : new Set(existing)
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0
  const stem = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  for (let i = 2; i < 10000; i++) {
    const candidate = `${stem}_${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  // 理论上到不了这里；到了说明调用方把 10000 个同名文件塞进了一个目录
  throw new AppError('INTERNAL', { details: { reason: 'filename-dedupe-exhausted', name } })
}

// ---------------------------------------------------------------------------
// 导出命名模板
// ---------------------------------------------------------------------------

export interface TemplateVars {
  bookTitle?: string
  chapterIndex?: number
  chapterTitle?: string
  narrator?: string
  date?: string | Date
}

export interface ExpandTemplateOptions {
  /**
   * 未知占位符的处理（默认 `keep` 原样保留）：
   *   · 'keep'  保留 `{foo}` —— 用户能立刻看出模板写错了，比静默变空好
   *   · 'empty' 替换为空串
   */
  onUnknown?: 'keep' | 'empty'
  /** 缺值时的替代文本（默认空串，而不是 '-'：文件名里 '-' 更常见） */
  fallback?: string
  /** `{date}` 未传时的取值（默认当前时间） */
  now?: Date
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)(?::(0?)(\d+))?\}/g

/**
 * 展开导出命名模板（docs/05 §9.3）。
 *
 * 支持 `{bookTitle}`、`{chapterIndex}`、`{chapterIndex:03}`（补零）、`{chapterTitle}`、
 * `{narrator}`、`{date}`。占位符内可含 `:0N` 指定最小宽度并用 0 补足。
 *
 * 说明：**只做单遍替换**，替换进去的值不会被再次解析（防止书名里的 `{}` 造成二次注入）。
 */
export function expandTemplate(template: string, vars: TemplateVars, opts?: ExpandTemplateOptions): string {
  const onUnknown = opts?.onUnknown ?? 'keep'
  const fallback = opts?.fallback ?? ''
  const rawDate = vars.date ?? opts?.now ?? new Date()
  // date 允许直接给字符串（调用方可能已经格式化好，或来自导出参数 metadata.date）
  const dateValue = rawDate instanceof Date ? formatDate(rawDate) : String(rawDate)
  const resolved: Record<string, string> = {
    bookTitle: vars.bookTitle ?? fallback,
    chapterTitle: vars.chapterTitle ?? fallback,
    narrator: vars.narrator ?? fallback,
    date: dateValue,
    chapterIndex: vars.chapterIndex === undefined ? fallback : String(vars.chapterIndex),
  }

  const out = template.replace(PLACEHOLDER_RE, (whole, key: string, _zero: string, width: string) => {
    let value = resolved[key]
    if (value === undefined) {
      // 未知占位符：可能是笔误，也可能是将来新增的（如 chapterIndex 之外的序号）
      return onUnknown === 'keep' ? whole : ''
    }
    if (width && value !== '' && /^\d+$/.test(value)) {
      value = value.padStart(Number(width), '0')
    }
    return value
  })
  return out
}

/** `YYYY-MM-DD`（模板只用到日期粒度；时区取本地时区，用户看到的就是自己的日期） */
export function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---------------------------------------------------------------------------
// 保护路径（清理白名单）
// ---------------------------------------------------------------------------

/**
 * 是否为「绝不能删」的路径：项目根、模型目录、数据库文件、用户素材目录（docs/04 §3）。
 * 供 safeRemove / cleanup 白名单使用。
 */
export function isProtectedPath(absPath: string, opts: { projectRoot?: string; modelDir?: string; dbPath?: string; userDataDir?: string }): boolean {
  const target = normalize(resolve(absPath))
  const roots: string[] = []
  if (opts.projectRoot) roots.push(normalize(resolve(opts.projectRoot)))
  if (opts.modelDir) roots.push(normalize(resolve(opts.modelDir)))
  if (opts.userDataDir) roots.push(normalize(resolve(opts.userDataDir)))
  if (roots.some((r) => r === target)) return true
  if (opts.dbPath) {
    const db = normalize(resolve(opts.dbPath))
    if (target === db) return true
    // WAL / SHM / 备份副本（-wal、-shm、.pre-restore-*）同样是主库的一部分
    if (target.startsWith(db)) return true
  }
  return false
}

/** 是否位于用户素材子目录内（清理缓存时必须放过，docs/04 §3 规则 2） */
export function isUserAssetPath(absPath: string, projectRoot: string): boolean {
  const target = normalize(resolve(absPath))
  const root = normalize(resolve(projectRoot))
  if (!target.startsWith(root)) return false
  const rel = target.slice(root.length).replace(/^[\\/]+/, '')
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  // projects/{id}/{assets...}
  return segments.some((s) => (USER_ASSET_DIRS as readonly string[]).includes(s))
}
