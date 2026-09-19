/**
 * Novel Studio · 素材仓储（`music_assets`，接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6 `music_assets`（`file_path` 是相对项目根的 `music/{kind}/{id}.{ext}`）
 *   · docs/14 §8 「导入即托管：复制到 `projects/{id}/music/{kind}/`，避免源文件被移动」
 *   · docs/14 §8 「素材按项目隔离」
 *
 * ### 两条必须守住的语义
 *   1. **按项目隔离**：`list(projectId, kind?)` 绝不返回别的项目的素材。
 *      音乐是有版权的，跨项目泄漏素材（并且能被渲染进别人的书）是产品级事故。
 *   2. **删除是「行 + 文件」一起**：行删掉但文件留着会越积越多（而且用户以为删了）；
 *      只删文件不留行会让库指向不存在的文件。所以仓储只删行，**文件由服务层删**，
 *      并且服务层先删文件再删行（顺序见 `music.service.ts` 的说明）。
 *
 * ### 关于「重命名 / 标签 / 备注」
 *   契约里**没有** `music:update` 通道，所以仓储也不提供 update（渲染侧只在本地会话内改，
 *   见 `MusicLibraryPanel.vue` 的说明）。需要持久化时先扩契约，别偷偷在别处写这几列。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, MusicAsset, Timestamp } from '../../../../shared/types.ts'

/** 导入时写入的字段（id / filePath / createdAt 由仓储或服务层决定） */
export interface MusicAssetInput {
  projectId: Id
  kind: 'bgm' | 'sfx'
  name: string
  filePath: string
  originalName?: string | null
  durationMs?: number | null
  sampleRate?: number | null
  channels?: number | null
  peakDb?: number | null
  lufs?: number | null
  loopable?: boolean
  tags?: string[]
  note?: string | null
  licenseNote?: string | null
}

/** 探测结果回写（`music:probe` 把测到的值写回这几列，作为「已探测」的痕迹） */
export interface MusicAssetMetricsPatch {
  durationMs: number | null
  sampleRate: number | null
  channels: number | null
  peakDb: number | null
  lufs: number | null
}

export interface MusicAssetRepo {
  list(projectId: Id, kind?: 'bgm' | 'sfx'): Promise<MusicAsset[]>
  get(assetId: Id): Promise<MusicAsset | null>
  insert(input: MusicAssetInput): Promise<MusicAsset>
  /** 回写探测到的指标（不改其它字段） */
  saveMetrics(assetId: Id, patch: MusicAssetMetricsPatch): Promise<MusicAsset>
  /** 删除行（文件由服务层负责） */
  remove(assetId: Id): Promise<boolean>
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准）
// ---------------------------------------------------------------------------

export function createMemoryMusicAssetRepo(seed?: { assets?: MusicAsset[]; now?: () => Timestamp }): MusicAssetRepo {
  const items = new Map<Id, MusicAsset>()
  const now = seed?.now ?? (() => Date.now())
  let seq = 0
  for (const a of seed?.assets ?? []) items.set(a.id, clone(a))

  return {
    async list(projectId, kind) {
      return [...items.values()]
        .filter((a) => a.projectId === projectId && (kind === undefined || a.kind === kind))
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
        .map(clone)
    },

    async get(assetId) {
      const a = items.get(assetId)
      return a ? clone(a) : null
    },

    async insert(input) {
      const id = `music-${++seq}`
      const asset: MusicAsset = {
        id,
        projectId: input.projectId,
        kind: input.kind,
        name: input.name,
        filePath: input.filePath,
        originalName: input.originalName ?? null,
        durationMs: input.durationMs ?? null,
        sampleRate: input.sampleRate ?? null,
        channels: input.channels ?? null,
        peakDb: input.peakDb ?? null,
        lufs: input.lufs ?? null,
        loopable: input.loopable ?? false,
        tags: [...(input.tags ?? [])],
        note: input.note ?? null,
        licenseNote: input.licenseNote ?? null,
        createdAt: now(),
      }
      items.set(id, asset)
      return clone(asset)
    },

    async saveMetrics(assetId, patch) {
      const a = items.get(assetId)
      if (!a) throw new AppError('NOT_FOUND', { details: { entity: 'music_asset', assetId } })
      const next: MusicAsset = { ...a, ...patch }
      items.set(assetId, next)
      return clone(next)
    },

    async remove(assetId) {
      return items.delete(assetId)
    },
  }
}

function clone(a: MusicAsset): MusicAsset {
  return { ...a, tags: [...a.tags] }
}
