/**
 * Novel Studio · 处理预设仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6 `process_presets`（`chain` 是 JSON、`tags` 是 JSON 数组、`project_id` 可空）
 *   · docs/14 §4 预设管理：内置预设**不可直接编辑**（用户改动创建副本）、项目隔离
 *
 * ### 内置预设不进库
 *   `BUILTIN_PRESETS`（`shared/constants.ts`）是常量：它们随代码升级而演进
 *   （比如某个滤镜在新 ffmpeg 上被替换），进库就变成了「用户机器上一份 2023 年的旧参数」。
 *   所以 `preset:list` = 常量 + 本仓储的行，且**只读**内置项。
 *   代价：用户不能改内置预设 —— 这正是 docs/14 §4 的规定（改动即创建副本）。
 *
 * ### 项目隔离的两种写法
 *   `project_id IS NULL` 表示全局预设（内置副本/用户自建的全局预设）。
 *   `list(projectId)` 返回「全局 + 该项目」的并集，按 `sort_order` 排序。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, ProcessChain, ProcessPreset, Timestamp } from '../../../../shared/types.ts'

/** 新建/更新预设时的字段（id 与时间戳由仓储填） */
export interface ProcessPresetInput {
  projectId: Id | null
  name: string
  description?: string | null
  chain: ProcessChain
  tags?: string[]
  sortOrder?: number
}

export interface PresetRepo {
  /** 全局（project_id IS NULL）+ 指定项目；projectId 为 null 时只取全局 */
  list(projectId: Id | null): Promise<ProcessPreset[]>
  get(id: Id): Promise<ProcessPreset | null>
  create(input: ProcessPresetInput): Promise<ProcessPreset>
  update(id: Id, patch: Partial<ProcessPresetInput> & { builtin?: false }): Promise<ProcessPreset>
  /**
   * 删除。
   *
   * 返回 `false` 表示「这一行不存在」；抛 `PERMISSION_DENIED` 表示「这是内置预设」
   * —— 内置的不是库里的行，删不掉，也不该让 UI 以为删成功了。
   */
  remove(id: Id): Promise<boolean>
  /** 批量导入（同一事务；返回逐条结果，供 import 的 warnings 使用） */
  createMany(inputs: ProcessPresetInput[]): Promise<ProcessPreset[]>
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准）
// ---------------------------------------------------------------------------

export function createMemoryPresetRepo(seed?: { presets?: ProcessPreset[]; now?: () => Timestamp }): PresetRepo {
  const items = new Map<Id, ProcessPreset>()
  const now = seed?.now ?? (() => Date.now())
  let seq = 0
  for (const p of seed?.presets ?? []) items.set(p.id, clonePreset(p))

  function sortPresets(list: ProcessPreset[]): ProcessPreset[] {
    return [...list].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    )
  }

  function createOne(input: ProcessPresetInput): ProcessPreset {
    const id = `preset-${++seq}-${Math.random().toString(36).slice(2, 8)}`
    const ts = now()
    const preset: ProcessPreset = {
      id,
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      builtin: false,
      chain: cloneChain(input.chain),
      tags: [...(input.tags ?? [])],
      sortOrder: input.sortOrder ?? 100,
      createdAt: ts,
      updatedAt: ts,
    }
    items.set(id, preset)
    return preset
  }

  return {
    async list(projectId) {
      return sortPresets(
        [...items.values()].filter((p) => p.projectId === null || (projectId !== null && p.projectId === projectId)),
      ).map(clonePreset)
    },

    async get(id) {
      const p = items.get(id)
      return p ? clonePreset(p) : null
    },

    async create(input) {
      return clonePreset(createOne(input))
    },

    async update(id, patch) {
      const cur = items.get(id)
      if (!cur) throw new AppError('NOT_FOUND', { details: { entity: 'process_preset', id } })
      if (cur.builtin) {
        throw new AppError('PERMISSION_DENIED', {
          details: { op: 'preset:update', reason: 'builtin-readonly', id, hint: '内置预设不可编辑，请另存为副本' },
        })
      }
      const next: ProcessPreset = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.chain !== undefined ? { chain: cloneChain(patch.chain) } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
        updatedAt: now(),
      }
      items.set(id, next)
      return clonePreset(next)
    },

    async remove(id) {
      const cur = items.get(id)
      if (!cur) return false
      if (cur.builtin) {
        throw new AppError('PERMISSION_DENIED', {
          details: { op: 'preset:delete', reason: 'builtin-readonly', id, hint: '内置预设不可删除' },
        })
      }
      return items.delete(id)
    },

    async createMany(inputs) {
      return inputs.map((input) => clonePreset(createOne(input)))
    },
  }
}

function clonePreset(p: ProcessPreset): ProcessPreset {
  return { ...p, chain: cloneChain(p.chain), tags: [...p.tags] }
}

/** 深拷贝链（EQ 是数组，浅拷贝会让两个预设共享同一段 EQ —— 改一个动两个） */
export function cloneChain(chain: ProcessChain): ProcessChain {
  return {
    highpass: { ...chain.highpass },
    denoise: { ...chain.denoise },
    deesser: { ...chain.deesser },
    eq: chain.eq.map((b) => ({ ...b })),
    compressor: { ...chain.compressor },
    limiter: { ...chain.limiter },
    repair: {
      dcOffset: chain.repair.dcOffset,
      polarityInvert: chain.repair.polarityInvert,
      declick: chain.repair.declick.map((d) => ({ ...d })),
      silenceFill: chain.repair.silenceFill.map((s) => ({ ...s })),
      tempo: { ...chain.repair.tempo },
    },
  }
}

/**
 * 把任意形状的链补成完整链（缺失项一律取「关闭」，不取某个内置预设的参数）。
 *
 * 为什么必须有这一步：库里/导入文件里的 JSON 可能是**旧版本写的**（少了后来新增的字段），
 * 缺字段会让 `buildChainFilter` 直接抛 `Cannot read properties of undefined` ——
 * 那是用户点「应用预设」时才炸，而且错误信息与预设名毫无关系。
 */
export function normalizeChain(parsed: unknown, presetId = ''): ProcessChain {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError('PROCESS_PRESET_INVALID', {
      params: { name: presetId || '(未命名)' },
      details: { op: 'preset:read', reason: 'chain-not-object', presetId },
    })
  }
  const c = parsed as Partial<ProcessChain>
  const repair = (c.repair ?? {}) as Partial<ProcessChain['repair']>
  return {
    highpass: {
      enabled: c.highpass?.enabled ?? false,
      freq: typeof c.highpass?.freq === 'number' ? c.highpass.freq : 80,
      poles: c.highpass?.poles === 1 ? 1 : 2,
    },
    denoise: {
      enabled: c.denoise?.enabled ?? false,
      nr: typeof c.denoise?.nr === 'number' ? c.denoise.nr : 10,
      nf: typeof c.denoise?.nf === 'number' ? c.denoise.nf : -30,
      tn: c.denoise?.tn ?? false,
    },
    deesser: {
      enabled: c.deesser?.enabled ?? false,
      intensity: typeof c.deesser?.intensity === 'number' ? c.deesser.intensity : 0.5,
      freq: typeof c.deesser?.freq === 'number' ? c.deesser.freq : 0.5,
    },
    eq: Array.isArray(c.eq)
      ? c.eq.map((b, i) => ({
          id: String(b?.id ?? `eq${i}`),
          type: (b?.type ?? 'peak') as ProcessChain['eq'][number]['type'],
          freq: typeof b?.freq === 'number' ? b.freq : 1000,
          gainDb: typeof b?.gainDb === 'number' ? b.gainDb : 0,
          q: typeof b?.q === 'number' ? b.q : 1,
          enabled: b?.enabled ?? false,
        }))
      : [],
    compressor: {
      enabled: c.compressor?.enabled ?? false,
      thresholdDb: typeof c.compressor?.thresholdDb === 'number' ? c.compressor.thresholdDb : -18,
      ratio: typeof c.compressor?.ratio === 'number' ? c.compressor.ratio : 2,
      attackMs: typeof c.compressor?.attackMs === 'number' ? c.compressor.attackMs : 10,
      releaseMs: typeof c.compressor?.releaseMs === 'number' ? c.compressor.releaseMs : 200,
      makeupDb: typeof c.compressor?.makeupDb === 'number' ? c.compressor.makeupDb : 0,
    },
    limiter: {
      enabled: c.limiter?.enabled ?? false,
      limitDb: typeof c.limiter?.limitDb === 'number' ? c.limiter.limitDb : -1,
      attackMs: typeof c.limiter?.attackMs === 'number' ? c.limiter.attackMs : 5,
      releaseMs: typeof c.limiter?.releaseMs === 'number' ? c.limiter.releaseMs : 50,
    },
    repair: {
      dcOffset: repair.dcOffset ?? false,
      polarityInvert: repair.polarityInvert ?? false,
      declick: Array.isArray(repair.declick)
        ? repair.declick.map((d) => ({
            atMs: typeof d?.atMs === 'number' ? d.atMs : 0,
            lengthMs: typeof d?.lengthMs === 'number' ? d.lengthMs : 10,
          }))
        : [],
      silenceFill: Array.isArray(repair.silenceFill)
        ? repair.silenceFill.map((s) => ({
            startMs: typeof s?.startMs === 'number' ? s.startMs : 0,
            endMs: typeof s?.endMs === 'number' ? s.endMs : 0,
          }))
        : [],
      tempo: {
        enabled: repair.tempo?.enabled ?? false,
        factor: typeof repair.tempo?.factor === 'number' ? repair.tempo.factor : 1,
      },
    },
  }
}
