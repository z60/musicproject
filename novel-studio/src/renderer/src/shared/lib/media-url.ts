/**
 * Novel Studio · ns-media:// URL 构造（客户端侧纯逻辑）
 * ============================================================================
 * 设计依据：docs/01 §4.3 数据所有权 ——
 *   > 音频访问协议：注册自定义协议 `ns-media://<projectId>/<relativePath>`，
 *   > 主进程 handler 做**路径规范化校验**（必须落在该项目目录内，拒绝 `..`），
 *   > 避免直接暴露任意文件读取。
 *
 * 两侧的职责分工（务必看清，别把校验搬到渲染进程）：
 *   ┌ 渲染进程（本文件）────────────────────────────────────────────────┐
 *   │ · 只做「拼 URL」：把 projectId 与相对路径编码进 ns-media://        │
 *   │ · 顺手做**参数卫生**（拒绝绝对路径 / `..` / 空段 / 盘符），         │
 *   │   目的是尽早暴露调用方 bug，而不是安全边界                        │
 *   └────────────────────────────────────────────────────────────────────┘
 *   ┌ 主进程（infra/media/protocol.ts）──────────────────────────────────┐
 *   │ · 解析 URL → 取 projectId → 查项目根目录                            │
 *   │ · path.resolve 后必须仍在项目根目录内（startsWith 校验 + 分隔符补齐）│
 *   │ · 拒绝 `..`、绝对路径、符号链接逃逸；不通过则 404 且记 PATH_ESCAPE_BLOCKED │
 *   │ · 这是**唯一**的安全边界：即使渲染进程被注入也读不到项目外的文件    │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * 另注：preload 也暴露了 `window.api.mediaUrl(projectId, relPath)`（docs/20 §8），
 * 运行期两处口径必须一致；本文件存在是为了让 store / composable 不直接碰 window，
 * 也让 URL 规则可被单测覆盖。
 */

/** 自定义协议名（主进程 protocol.registerSchemesAsPrivileged 里注册的就是它） */
export const MEDIA_SCHEME = 'ns-media'

export interface MediaUrlParts {
  projectId: string
  /** 相对项目根目录的路径（已规范化，`/` 分隔） */
  relativePath: string
}

/** 路径不合法（绝对路径、含 `..`、空段等）时抛出，便于尽早发现调用方 bug */
export class MediaPathError extends Error {
  readonly relativePath: string
  constructor(relativePath: string, reason: string) {
    super(`非法媒体相对路径（${reason}）：${relativePath}`)
    this.name = 'MediaPathError'
    this.relativePath = relativePath
  }
}

/**
 * 规范化相对路径：
 *   · 反斜杠统一成 `/`（领域模型里路径恒为 `/` 分隔，见 types.ts 注释）；
 *   · 去掉协议前缀、前导 `./`、重复分隔符；
 *   · 拒绝：空路径、绝对路径（`/x`、`C:\x`、`\\server\share`）、任何 `..` 段。
 */
export function normalizeRelativePath(relativePath: string | null | undefined): string {
  if (typeof relativePath !== 'string') throw new MediaPathError(String(relativePath), '不是字符串')
  const unified = relativePath.replace(/\\/g, '/').trim()
  if (!unified) throw new MediaPathError(relativePath, '路径为空')
  if (unified.startsWith('//')) throw new MediaPathError(relativePath, 'UNC 路径')
  if (/^[A-Za-z]:/.test(unified)) throw new MediaPathError(relativePath, '带盘符的绝对路径')
  if (unified.startsWith('/')) throw new MediaPathError(relativePath, '绝对路径')

  const segments = unified.split('/')
  const out: string[] = []
  for (const raw of segments) {
    const segment = raw.trim()
    if (!segment || segment === '.') continue
    if (segment === '..') throw new MediaPathError(relativePath, '包含 .. 段')
    // 控制字符一律拒绝（部分文件系统会静默截断）
    if (/[\u0000-\u001f]/.test(segment)) throw new MediaPathError(relativePath, '含控制字符')
    out.push(segment)
  }
  if (!out.length) throw new MediaPathError(relativePath, '规范化后为空')

  return out.join('/')
}

function encodeSegment(segment: string): string {
  // encodeURIComponent 不编码 `!'()*`，其中 `'` 与 `()` 在部分解析器里会带来麻烦
  return encodeURIComponent(segment).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * 构造 `ns-media://<projectId>/<relativePath>`。
 * 非法路径抛 MediaPathError；不想处理异常时用 `tryBuildMediaUrl`。
 */
export function buildMediaUrl(projectId: string, relativePath: string): string {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new MediaPathError(relativePath, 'projectId 为空')
  }
  const normalized = normalizeRelativePath(relativePath)
  const path = normalized.split('/').map(encodeSegment).join('/')
  return `${MEDIA_SCHEME}://${encodeSegment(projectId.trim())}/${path}`
}

/** 构造失败返回 null（用于「尽力而为」的场景，如列表渲染时的容错） */
export function tryBuildMediaUrl(projectId: string | null | undefined, relativePath: string | null | undefined): string | null {
  if (!projectId || !relativePath) return null
  try {
    return buildMediaUrl(projectId, relativePath)
  } catch {
    return null
  }
}

/** 是否为 ns-media 协议的 URL（<audio>/<img> 的 src 绑定前判断） */
export function isMediaUrl(url: unknown): boolean {
  return typeof url === 'string' && url.startsWith(`${MEDIA_SCHEME}://`)
}

/** 反解 URL（调试面板用；失败返回 null） */
export function parseMediaUrl(url: string): MediaUrlParts | null {
  if (!isMediaUrl(url)) return null
  const rest = url.slice(`${MEDIA_SCHEME}://`.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  try {
    return {
      projectId: decodeURIComponent(rest.slice(0, slash)),
      relativePath: rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/'),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 领域便捷构造（避免每个组件自己拼 recordings/xxx.wav）
// ---------------------------------------------------------------------------

/** 录音会话 WAV：`recordings/{sessionId}.wav`（docs/12 §2） */
export function recordingUrl(projectId: string, sessionId: string): string | null {
  return tryBuildMediaUrl(projectId, `recordings/${sessionId}.wav`)
}

/** 片段文件（take / voice_segment 的 filePath 本身即相对项目根的路径） */
export function segmentUrl(projectId: string, filePath: string | null | undefined): string | null {
  return tryBuildMediaUrl(projectId, filePath ?? null)
}

/** 处理链派生文件（processedPath） */
export function processedUrl(projectId: string, processedPath: string | null | undefined): string | null {
  return tryBuildMediaUrl(projectId, processedPath ?? null)
}

/** 封面图（coverPath 可能是相对路径；绝对路径由主进程单独处理） */
export function coverUrl(projectId: string, coverPath: string | null | undefined): string | null {
  return tryBuildMediaUrl(projectId, coverPath ?? null)
}

/**
 * 可供 `<audio src>` 使用的 URL：带缓存破坏参数。
 * 场景：重新录制同一会话后文件名不变，浏览器会命中旧缓存导致「听了半天还是旧音频」。
 */
export function mediaUrlWithCacheBust(url: string, version: number | string): string {
  if (!isMediaUrl(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}v=${encodeURIComponent(String(version))}`
}
