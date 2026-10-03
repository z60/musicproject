/**
 * Novel Studio · 随包资源清单（`resources/models/models.json`）的解析
 * ============================================================================
 * 设计依据：
 *   · docs/02 §5.1 ffmpeg 的分发与探测（目录约定、必须验证的能力）
 *   · docs/02 §5.2 / docs/03 §2 模型目录与登记表
 *   · docs/21 §16 发布前必须填实的登记表（尺寸 / SHA-256 / 许可 / 来源）
 *
 * ### 为什么要有这个文件：清单此前**只有一半、而且是错的**被读
 *   1. `models` 段被 `bootstrap-steps.ts` 的 `verifyModels()` 读，但它要求
 *      `models` 是**数组**，而文件里是**按类型分组的对象**（`whisper` / `embedding`）
 *      ⇒ `entries = []` ⇒ 模型清单恒为空、`capabilities.models` 永远是 `[]`，
 *      设置页的模型面板因此永远「没有模型」，缺文件也不会有人知道。
 *   2. `binaries` 段**完全没有消费者**：候选路径硬编码在 `paths.ts`、
 *      必需滤镜硬编码在 `bootstrap-steps.ts`。
 *
 *   两边不一致时不会有任何东西报错 —— 这正是 docs/91 §5.2.51 ④ 记下的那两条。
 *   本模块把「清单怎么说」收敛成唯一入口，启动期探测与设置页的「重新探测」共用。
 *
 * ### 形态兼容（两种都认，因为两种都真实存在）
 *   · 扁平数组：`{ "models": [ {id, kind, file, …} ] }`
 *   · 分组对象（**当前文件就是这个**）：`{ "models": { "whisper": [...], "embedding": [...] } }`
 *
 * ### 失败语义
 *   读不到 / 解析不了 / 段缺失 → 返回**空清单 + error 文案**，绝不抛异常：
 *   `lite` 构建里根本没有这个文件，而应用没有 ffmpeg、没有模型也必须能启动
 *   （docs/01 §10 第 9、10 步都标注「不阻塞开窗」）。
 *   调用方拿到空清单时用代码里的兜底值，并把 error 如实写进日志。
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import type { ModelStatus } from '../shared/types.ts'

/** 模型登记项（`models.json` 的 `models.*[]`） */
export interface ModelManifestEntry {
  id: string
  kind: 'whisper' | 'embedding'
  /** 相对 `resources/models/` 的路径（如 `whisper/ggml-base.bin`） */
  file: string
  /** 期望体积；未登记时为 null（此时不做体积校验） */
  sizeBytes: number | null
  /** 期望 SHA-256；未填时为 null（启动期不校验，留给用户显式「校验」） */
  sha256: string | null
}

/** 二进制登记项（`models.json` 的 `binaries[]`） */
export interface BinaryManifestEntry {
  id: string
  label: string | null
  /** 相对 `resources/` 的路径模板：`bin/ffmpeg{ext}`（旧的 `{platform}/{arch}` 模板也认） */
  file: string
  sha256: string | null
  /** 缺任何一个就要降级/隐藏对应控件的滤镜；空数组 = 没登记（调用方用代码兜底） */
  requiredFilters: string[]
}

export interface ResourceManifest {
  models: ModelManifestEntry[]
  binaries: BinaryManifestEntry[]
}

export const EMPTY_MANIFEST: ResourceManifest = { models: [], binaries: [] }

export interface ReadManifestResult {
  manifest: ResourceManifest
  /** 清单文件是否存在且解析成功 */
  ok: boolean
  /** 失败原因（给日志用，**不含绝对路径** —— docs/22 §3 的日志纪律） */
  error: string | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 单个模型条目 → 登记项；必要字段缺失（id / file）时返回 null（宁缺勿造） */
function toModelEntry(raw: unknown, groupKind: 'whisper' | 'embedding' | null): ModelManifestEntry | null {
  const r = asRecord(raw)
  if (!r) return null
  const id = asString(r['id'])
  const file = asString(r['file'])
  if (!id || !file) return null
  const kindRaw = asString(r['kind'])
  const kind: 'whisper' | 'embedding' = kindRaw === 'embedding' || groupKind === 'embedding' ? 'embedding' : 'whisper'
  return { id, kind, file, sizeBytes: asNumber(r['sizeBytes']), sha256: asString(r['sha256']) }
}

/**
 * 解析清单。
 *
 * @throws 不抛异常：无法识别的输入得到空清单（`ok=false` 只有 `readResourceManifest` 才报）
 */
export function parseResourceManifest(raw: unknown): ResourceManifest {
  const models: ModelManifestEntry[] = []
  const binaries: BinaryManifestEntry[] = []

  // ── models：三种形态都认（顶层数组 / 扁平数组 / 分组对象）──────────────
  const root = asRecord(raw)
  const modelsRaw = Array.isArray(raw) ? raw : root?.['models']
  if (Array.isArray(modelsRaw)) {
    for (const item of modelsRaw) {
      const e = toModelEntry(item, null)
      if (e) models.push(e)
    }
  } else {
    const grouped = asRecord(modelsRaw)
    if (grouped) {
      for (const [key, value] of Object.entries(grouped)) {
        if (!Array.isArray(value)) continue
        const groupKind = key === 'embedding' ? 'embedding' : key === 'whisper' ? 'whisper' : null
        for (const item of value) {
          const e = toModelEntry(item, groupKind)
          if (e) models.push(e)
        }
      }
    }
  }

  // ── binaries：`{ id, file, requiredFilters[] }` ────────────────────────
  const binariesRaw = root?.['binaries']
  if (Array.isArray(binariesRaw)) {
    for (const item of binariesRaw) {
      const r = asRecord(item)
      if (!r) continue
      const id = asString(r['id'])
      const file = asString(r['file'])
      if (!id || !file) continue
      const filtersRaw = r['requiredFilters']
      const requiredFilters = Array.isArray(filtersRaw)
        ? filtersRaw.map((f) => asString(f)).filter((f): f is string => f !== null)
        : []
      binaries.push({ id, label: asString(r['label']), file, sha256: asString(r['sha256']), requiredFilters })
    }
  }

  return { models, binaries }
}

/**
 * 读并解析 `{resourceDir}/models/models.json`。
 *
 * @throws 不抛异常 —— 失败时返回空清单 + `ok:false` + 原因文案
 */
export async function readResourceManifest(resourceDir: string): Promise<ReadManifestResult> {
  const manifestPath = join(resourceDir, 'models', 'models.json')
  let text: string
  try {
    text = await fsp.readFile(manifestPath, 'utf8')
  } catch {
    return { manifest: EMPTY_MANIFEST, ok: false, error: 'manifest-missing' }
  }
  try {
    return { manifest: parseResourceManifest(JSON.parse(text) as unknown), ok: true, error: null }
  } catch {
    // 计划任务里写过坏 JSON 的情况真实出现过；如实报，不猜
    return { manifest: EMPTY_MANIFEST, ok: false, error: 'manifest-invalid-json' }
  }
}

/**
 * 逐项 stat 模型文件，产出 `ModelStatus[]`（IPC `app:getCapabilities` 直接返回它）。
 *
 * 只做**存在性与体积**校验：SHA-256 要读几十上百 MB，留给用户在设置页显式触发
 * （`actualSha256` 恒为 null 是设计，不是遗漏 —— docs/03 §2）。
 */
export async function buildModelStatuses(
  entries: readonly ModelManifestEntry[],
  modelDir: string,
): Promise<ModelStatus[]> {
  const out: ModelStatus[] = []
  for (const e of entries) {
    const filePath = join(modelDir, e.file)
    let sizeBytes: number | null = null
    try {
      const st = await fsp.stat(filePath)
      sizeBytes = st.size
    } catch {
      sizeBytes = null
    }
    const exists = sizeBytes !== null
    const sizeOk = e.sizeBytes === null || (sizeBytes !== null && sizeBytes === e.sizeBytes)
    out.push({
      id: e.id,
      kind: e.kind,
      filePath,
      exists,
      expectedSha256: e.sha256,
      actualSha256: null,
      sizeBytes,
      ok: exists && sizeOk,
      message: exists
        ? sizeOk
          ? null
          : `文件大小与登记不符（期望 ${e.sizeBytes} 字节，实际 ${sizeBytes}）`
        : '模型文件不存在，请放入 resources/models 或改用 Mock provider',
    })
  }
  return out
}

/**
 * 把清单里的路径模板变成真实路径。
 *
 * 支持的占位符：`{ext}`（Windows `.exe` / 其它平台空串）、`{platform}`、`{arch}`。
 * 旧文档曾规定 `bin/{platform}/{arch}/ffmpeg{ext}`，虽然从未实现过，
 * 但模板里保留这两个占位符意味着**将来真要做分层时改清单就行，不用改代码**。
 */
export function resolveManifestPath(
  template: string,
  opts: { resourceDir: string; platform?: NodeJS.Platform; arch?: string },
): string {
  const platform = opts.platform ?? process.platform
  const ext = platform === 'win32' ? '.exe' : ''
  const filled = template
    .replace(/\{ext\}/g, ext)
    .replace(/\{platform\}/g, platform)
    .replace(/\{arch\}/g, opts.arch ?? process.arch)
  return join(opts.resourceDir, filled)
}

/** 取某个 id 的二进制登记项（大小写不敏感）；没有则 null */
export function findBinary(
  manifest: ResourceManifest,
  id: string,
): BinaryManifestEntry | null {
  const want = id.toLowerCase()
  return manifest.binaries.find((b) => b.id.toLowerCase() === want) ?? null
}

/** 清单里登记的该二进制候选路径（通常是 1 条；没有登记则空数组） */
export function binaryCandidates(
  manifest: ResourceManifest,
  id: string,
  opts: { resourceDir: string; platform?: NodeJS.Platform; arch?: string },
): string[] {
  const entry = findBinary(manifest, id)
  if (!entry) return []
  return [resolveManifestPath(entry.file, opts)]
}
