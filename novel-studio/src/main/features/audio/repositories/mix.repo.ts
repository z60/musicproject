/**
 * Novel Studio · 混音方案仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6 `mix_projects`：`tracks` 与 `master` 是 **JSON 列**（整份方案一起存）
 *   · docs/15 §2 「一份混音方案 = 轨道配置 + 母带配置 + 首尾静音 + 章首念白」
 *
 * ### 为什么整份 JSON 存，而不是拆成 mix_tracks 关系表
 *   契约的 `mix:save { mixProject }` 传的就是**整份方案**（渲染侧防抖 500ms 后整份提交），
 *   而每条轨的字段（`music` 里的 ducking 配置、`titleReading`）都是嵌套结构。
 *   拆表意味着每次保存要做「diff → 增删改」三组 SQL，收益只是「能用 SQL 查轨道」——
 *   但目前没有任何通道需要按轨查询（`music:delete` 的引用检查两者都查，见 music.service）。
 *   所以：**JSON 是权威存储**，`mix_tracks` 表保留但不由本仓储写入
 *   （它是早期设计的遗留，删表要发迁移，暂不动）。
 *
 * ### 两条不变量
 *   1. **每章至多一个默认混音方案**：`is_default` 无唯一约束，`setDefault` 必须事务内清零。
 *   2. **`tracks` 里的 track.mixProjectId 必须等于宿主方案 id**：渲染侧整份提交时可能带旧 id，
 *      按宿主覆盖写回，避免出现「方案 A 里存着方案 B 的轨道」。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, MixProject } from '../../../../shared/types.ts'

export interface MixProjectRepo {
  listByChapter(chapterId: Id): Promise<MixProject[]>
  get(mixProjectId: Id): Promise<MixProject | null>
  getDefault(chapterId: Id): Promise<MixProject | null>
  create(input: {
    chapterId: Id
    arrangementId: Id
    name: string
    tracks: MixProject['tracks']
    master: MixProject['master']
    headSilenceMs: number
    tailSilenceMs: number
    titleReading: MixProject['titleReading']
    isDefault?: boolean
  }): Promise<MixProject>
  /** 整份写回（`mix:save`）：version+1、updatedAt 由实现决定 */
  save(mixProject: MixProject): Promise<MixProject>
  duplicate(mixProjectId: Id, name: string): Promise<MixProject>
  remove(mixProjectId: Id): Promise<boolean>
  setDefault(mixProjectId: Id): Promise<boolean>
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准）
// ---------------------------------------------------------------------------

export function createMemoryMixProjectRepo(seed?: { projects?: MixProject[]; now?: () => number }): MixProjectRepo {
  const items = new Map<Id, MixProject>()
  const now = seed?.now ?? (() => Date.now())
  let seq = 0
  for (const p of seed?.projects ?? []) items.set(p.id, clone(p))

  function requireProject(id: Id): MixProject {
    const p = items.get(id)
    if (!p) throw new AppError('NOT_FOUND', { details: { entity: 'mix_project', id } })
    return p
  }

  return {
    async listByChapter(chapterId) {
      return [...items.values()]
        .filter((p) => p.chapterId === chapterId)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt)
        .map(clone)
    },

    async get(mixProjectId) {
      const p = items.get(mixProjectId)
      return p ? clone(p) : null
    },

    async getDefault(chapterId) {
      const found = [...items.values()].find((p) => p.chapterId === chapterId && p.isDefault)
      return found ? clone(found) : null
    },

    async create(input) {
      const id = `mix-${++seq}`
      const ts = now()
      const project: MixProject = {
        id,
        chapterId: input.chapterId,
        arrangementId: input.arrangementId,
        name: input.name,
        isDefault: input.isDefault ?? false,
        tracks: input.tracks.map((t) => ({ ...t, mixProjectId: id })),
        master: { ...input.master },
        headSilenceMs: input.headSilenceMs,
        tailSilenceMs: input.tailSilenceMs,
        titleReading: { ...input.titleReading },
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      }
      if (project.isDefault) {
        for (const p of items.values()) if (p.chapterId === input.chapterId) p.isDefault = false
      }
      items.set(id, project)
      return clone(project)
    },

    async save(mixProject) {
      const cur = requireProject(mixProject.id)
      const next: MixProject = {
        ...cur,
        ...mixProject,
        // 宿主字段以库为准的只有 isDefault（它是「每章唯一」的一部分，不能由整份提交改写）
        isDefault: cur.isDefault,
        tracks: mixProject.tracks.map((t) => ({ ...t, mixProjectId: mixProject.id })),
        version: cur.version + 1,
        createdAt: cur.createdAt,
        updatedAt: now(),
      }
      items.set(next.id, next)
      return clone(next)
    },

    async duplicate(mixProjectId, name) {
      const src = requireProject(mixProjectId)
      const id = `mix-${++seq}`
      const ts = now()
      const copy: MixProject = {
        ...clone(src),
        id,
        name,
        isDefault: false,
        tracks: src.tracks.map((t) => ({ ...t, id: `${t.id}-copy-${seq}`, mixProjectId: id })),
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      }
      items.set(id, copy)
      return clone(copy)
    },

    async remove(mixProjectId) {
      return items.delete(mixProjectId)
    },

    async setDefault(mixProjectId) {
      const target = items.get(mixProjectId)
      if (!target) return false
      for (const p of items.values()) if (p.chapterId === target.chapterId) p.isDefault = false
      target.isDefault = true
      return true
    },
  }
}

function clone(p: MixProject): MixProject {
  return {
    ...p,
    master: { ...p.master },
    titleReading: { ...p.titleReading },
    tracks: p.tracks.map((t) => ({
      ...t,
      music: t.music
        ? { ...t.music, ducking: { ...t.music.ducking } }
        : null,
    })),
  }
}
