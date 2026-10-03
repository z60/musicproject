/**
 * Novel Studio · 能力探测（ffmpeg / 模型 / embedding）
 * ============================================================================
 * 设计依据：
 *   · docs/02 §5.1「启动时必须验证的 ffmpeg 能力」与探测顺序
 *   · docs/02 §5.2 / docs/03 §2 模型就位校验
 *   · docs/04 §8.2 设置改动后要求「重启生效」还是「重新探测」的边界
 *
 * ### 为什么单独抽一个模块
 *   同一套探测此前只存在于启动步骤里（`bootstrap-steps.ts`），于是设置页的
 *   「重新探测」按钮**没有可调用的东西** —— 它只能重读启动期快照，
 *   用户换了 ffmpeg 路径之后点它，看到的还是旧结果（docs/91 §5.2.51 ④ 第三条）。
 *
 *   现在启动步骤与 `capabilities.refresh()` 走的是**同一个函数**：
 *   「重新探测 = 重跑启动期那两步」不再是一句注释，而是代码事实。
 *
 * ### 三条纪律
 *   1. **清单是权威，代码是兜底**：候选路径与必需滤镜优先取
 *      `resources/models/models.json`（`binaries[]`）；清单缺失/没登记时才用
 *      `paths.ts` 的候选与 `parse.ts` 的 `REQUIRED_FILTERS`。
 *   2. **不抛异常**：探测失败一律收敛成 `available:false`（docs/01 §10 第 9、10 步
 *      「不阻塞开窗」）。只有调用方自己决定要不要把 missing 变成 UI 上的隐藏控件。
 *   3. **解析用 `shared/ffmpeg/parse.ts`**，不在这里再写一份正则 ——
 *      `parseFilters` 曾经因为「三字符标记」写死而在 7.x+ 上匹配 0 行，
 *      两份实现的话就得修两遍。
 */

import { promisify } from 'node:util'

import type { AppCapabilities, FfmpegCapabilities, ModelStatus } from '../shared/types.ts'
import {
  REQUIRED_FILTERS,
  computeCapabilities,
  parseEncoders,
  parseFilters,
  parseVersion,
} from '../shared/ffmpeg/parse.ts'
import { loadLocalEmbeddingProvider, type EmbeddingLoadResult } from './features/ai/embedding-loader.ts'
import type { Logger } from './infra/log/index.ts'
import { ffmpegCandidates } from './paths.ts'
import { binaryCandidates, buildModelStatuses, findBinary, readResourceManifest, type ResourceManifest } from './resource-manifest.ts'

/** ffmpeg 探测超时（与启动期一致：`-version` 10s、`-filters`/`-encoders` 各 15s） */
const VERSION_TIMEOUT_MS = 10_000
const LIST_TIMEOUT_MS = 15_000

/** 「一个都没有」的诚实默认值（未探测 / 探测失败 / 二进制不存在） */
export function unavailableFfmpegCapabilities(): FfmpegCapabilities {
  return { version: '', available: false, path: null, filters: [], missing: [], encoders: [] }
}

export interface CandidateOptions {
  resourceDir: string
  settingsFfmpegPath?: string | null
  manifest?: ResourceManifest
  platform?: NodeJS.Platform
  arch?: string
}

/**
 * ffmpeg 候选路径（顺序：**用户指定 > 随包（清单登记）> 代码兜底 > PATH**）。
 *
 * 为什么清单登记项排在代码兜底之前：清单是「这个包里到底带了什么」的登记表，
 * 它可能与代码的默认约定不同（比如将来真按平台/架构分层）。
 * 代码兜底那一条（`{resourceDir}/bin/ffmpeg(.exe)`）永远保留 —— 清单丢了也不能探测不到。
 *
 * 去重是有意义的：清单登记的通常就是 `bin/ffmpeg{ext}`，与兜底项**完全同一条路径**，
 * 不去重会让「探测不到」时对同一个文件白跑两遍（每遍都带 10~15 秒超时）。
 */
export function resolveFfmpegCandidates(opts: CandidateOptions): string[] {
  const platform = opts.platform ?? process.platform
  const out: string[] = []
  const settingsPath = opts.settingsFfmpegPath?.trim()
  if (settingsPath) out.push(settingsPath)
  if (opts.manifest) {
    out.push(
      ...binaryCandidates(opts.manifest, 'ffmpeg', {
        resourceDir: opts.resourceDir,
        platform,
        ...(opts.arch !== undefined ? { arch: opts.arch } : {}),
      }),
    )
  }
  // settingsFfmpegPath 传 null：用户指定那一条已经在最前面了，避免重复
  out.push(...ffmpegCandidates({ paths: { resourceDir: opts.resourceDir }, settingsFfmpegPath: null, platform }))
  return [...new Set(out)]
}

export interface FfmpegProbeDetail {
  candidates: string[]
  /** 实际使用的必需滤镜清单，以及它来自清单还是代码兜底 */
  requiredFilters: string[]
  requiredFiltersSource: 'manifest' | 'builtin'
  manifestOk: boolean
  manifestError: string | null
}

export interface FfmpegProbeResult {
  capabilities: FfmpegCapabilities
  detail: FfmpegProbeDetail
}

/**
 * 探测 ffmpeg：`-version` 确认可执行 + `-filters` / `-encoders` 确认能力。
 *
 * `-version` 跑得起来但**解析不出版本号**时会换下一个候选（而不是当成可用）：
 * `computeCapabilities` 把「没有版本号」定义为不可用，两者必须一致，
 * 否则会出现 `available:true, version:''` 这种自相矛盾的快照。
 */
export async function probeFfmpeg(opts: CandidateOptions & { log: Logger }): Promise<FfmpegProbeResult> {
  const read = await readResourceManifest(opts.resourceDir)
  if (!read.ok) {
    opts.log.warn('ffmpeg.manifest.unavailable', { event: 'ffmpeg.manifest.unavailable', reason: read.error })
  }
  const entry = findBinary(read.manifest, 'ffmpeg')
  const fromManifest = entry !== null && entry.requiredFilters.length > 0
  const requiredFilters = fromManifest && entry ? entry.requiredFilters : [...REQUIRED_FILTERS]
  const candidates = resolveFfmpegCandidates({ ...opts, manifest: read.manifest })
  const detail: FfmpegProbeDetail = {
    candidates,
    requiredFilters,
    requiredFiltersSource: fromManifest ? 'manifest' : 'builtin',
    manifestOk: read.ok,
    manifestError: read.error,
  }

  const { execFile } = await import('node:child_process')
  const run = promisify(execFile)

  for (const candidate of candidates) {
    try {
      const versionOut = await run(candidate, ['-version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true })
      const version = parseVersion(String(versionOut.stdout))
      if (!version) continue // 跑得起来但不是 ffmpeg（或输出不认识）→ 换下一个候选

      let filters: string[] = []
      let encoders: string[] = []
      try {
        const filtersOut = await run(candidate, ['-hide_banner', '-filters'], { timeout: LIST_TIMEOUT_MS, windowsHide: true })
        filters = parseFilters(String(filtersOut.stdout))
        const encodersOut = await run(candidate, ['-hide_banner', '-encoders'], { timeout: LIST_TIMEOUT_MS, windowsHide: true })
        encoders = parseEncoders(String(encodersOut.stdout))
      } catch (e) {
        // 滤镜列表拿不到时**照样可用**（能跑命令），只是 missing 会偏多 —— 如实记日志
        opts.log.warn('ffmpeg.probe.filtersFailed', { event: 'ffmpeg.probe.filtersFailed', reason: String(e) })
      }

      const caps = computeCapabilities(version, filters, requiredFilters)
      return {
        capabilities: {
          version: caps.version ?? version,
          available: caps.available,
          path: candidate,
          filters,
          missing: caps.missing,
          encoders,
        },
        detail,
      }
    } catch {
      // 这个候选起不来（ENOENT / 超时）→ 换下一个
    }
  }
  return { capabilities: unavailableFfmpegCapabilities(), detail }
}

export interface ModelsProbeResult {
  models: ModelStatus[]
  manifestOk: boolean
  manifestError: string | null
}

/**
 * 校验模型就位（存在 + 体积；**不做 SHA-256**，那是用户显式触发的动作）。
 *
 * 清单里的 `models` 段支持「分组对象」与「扁平数组」两种形态 —— 见 `resource-manifest.ts`。
 */
export async function probeModels(opts: {
  resourceDir: string
  modelDir: string
  log: Logger
}): Promise<ModelsProbeResult> {
  const read = await readResourceManifest(opts.resourceDir)
  if (!read.ok) {
    opts.log.warn('models.manifest.unavailable', { event: 'models.manifest.unavailable', reason: read.error })
  }
  const models = await buildModelStatuses(read.manifest.models, opts.modelDir)
  return { models, manifestOk: read.ok, manifestError: read.error }
}

/** 真实加载一次本地向量模型（文件在 ≠ 能推理；结果有进程内缓存） */
export function loadEmbeddingCapability(modelDir: string): Promise<EmbeddingLoadResult> {
  return loadLocalEmbeddingProvider({ modelsDir: modelDir })
}

export interface RefreshOptions {
  resourceDir: string
  modelDir: string
  settingsFfmpegPath?: string | null
  log: Logger
  /** `safeStorage` 是否可用（由调用方注入，探测本身不碰 Electron） */
  secureStorage: boolean
  platform?: NodeJS.Platform
  arch?: string
}

export interface RefreshResult {
  capabilities: AppCapabilities
  detail: {
    ffmpeg: FfmpegProbeDetail
    models: { total: number; ok: number; missing: string[] }
  }
}

/**
 * 完整重跑一遍能力探测（ffmpeg + 模型 + embedding）。
 *
 * 这是 `capabilities.refresh()` 与启动期两步探测的共同实现 ——
 * 设置页点「重新探测」时跑的就是它，所以「探测结果」与「重启后的结果」不会分叉。
 */
export async function refreshCapabilities(opts: RefreshOptions): Promise<RefreshResult> {
  const ffmpeg = await probeFfmpeg({
    resourceDir: opts.resourceDir,
    settingsFfmpegPath: opts.settingsFfmpegPath ?? null,
    log: opts.log,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.arch !== undefined ? { arch: opts.arch } : {}),
  })
  const models = await probeModels({
    resourceDir: opts.resourceDir,
    modelDir: opts.modelDir,
    log: opts.log,
  })
  const embedding = await loadEmbeddingCapability(opts.modelDir)
  return {
    capabilities: {
      ffmpeg: ffmpeg.capabilities,
      models: models.models,
      secureStorage: opts.secureStorage,
      embedding: { modelId: embedding.modelId, dim: embedding.dim, available: embedding.available },
    },
    detail: {
      ffmpeg: ffmpeg.detail,
      models: {
        total: models.models.length,
        ok: models.models.filter((m) => m.ok).length,
        missing: models.models.filter((m) => !m.exists).map((m) => m.id),
      },
    },
  }
}
