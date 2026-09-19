/**
 * Novel Studio · 对轨仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6 `arrangements` / `arrangement_items`（含 `version`：整体重排 +1）
 *   · docs/13 §4 「一份方案 = 一条 arrangement + 它的 items」
 *   · docs/13 §6 「方案可复制、可删除、每章有一个默认方案」
 *
 * ### 三条必须由仓储保证的不变量（DDL 帮不上忙）
 *   1. **每章至多一个默认方案**：`is_default` 上没有唯一约束，`setDefault` 必须在一个
 *      事务里先清零该章其它方案。否则「默认方案」会随机取到一条（导出用哪份就说不清了）。
 *   2. **items 全量替换是原子的**：整体重排 = 删掉旧的、写入新的，中间失败会让方案变成
 *      空的时间线（用户会以为「录音丢了」）。所以 `replaceItems` 必须在一个事务里。
 *   3. **同一方案内 item 的唯一键是 lineId**：一条画本行在同一方案里只能出现一次
 *      （`arrangement_items` 没有这个约束，重复会让渲染时同一句念两遍）。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Arrangement, ArrangementItem, Id } from '../../../../shared/types.ts'

export interface ArrangementRepo {
  listByChapter(chapterId: Id): Promise<Arrangement[]>
  get(arrangementId: Id): Promise<Arrangement | null>
  /** 该章的默认方案（没有则 null） */
  getDefault(chapterId: Id): Promise<Arrangement | null>
  create(input: {
    chapterId: Id
    name: string
    strategy: Arrangement['strategy']
    isDefault?: boolean
  }): Promise<Arrangement>
  /** 复制方案（含全部 items）；副本的 `isDefault` 恒为 false */
  duplicate(arrangementId: Id, name: string): Promise<Arrangement>
  remove(arrangementId: Id): Promise<boolean>
  /** 设为该章默认（同章其它方案清零） */
  setDefault(arrangementId: Id): Promise<boolean>
  /** 整体重排后写回：更新时间/策略/总时长，并把 version +1 */
  updateSummary(
    arrangementId: Id,
    patch: { strategy?: Arrangement['strategy']; totalDurationMs?: number; name?: string; bumpVersion?: boolean },
  ): Promise<Arrangement>

  listItems(arrangementId: Id): Promise<ArrangementItem[]>
  getItem(itemId: Id): Promise<ArrangementItem | null>
  /** 全量替换（整体重排 / 重置）；**在一个事务里** */
  replaceItems(arrangementId: Id, items: readonly ArrangementItem[], opts?: { trackId?: string }): Promise<ArrangementItem[]>
  updateItem(itemId: Id, patch: Partial<Omit<ArrangementItem, 'id' | 'arrangementId'>>): Promise<ArrangementItem>
  /** 批量更新（拖拽结束一次性落库）；返回真正被改动的条数 */
  updateItems(updates: ReadonlyArray<{ itemId: Id; patch: Partial<Omit<ArrangementItem, 'id' | 'arrangementId'>> }>): Promise<number>
  /** 删除某行/某片段相关的 item（重绑与解绑后清掉过期的时间线） */
  removeByLines(lineIds: readonly Id[]): Promise<number>
  removeBySegment(segmentId: Id): Promise<number>
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准）
// ---------------------------------------------------------------------------

export function createMemoryArrangementRepo(seed?: {
  arrangements?: Arrangement[]
  items?: ArrangementItem[]
  now?: () => number
}): ArrangementRepo {
  const arrangements = new Map<Id, Arrangement>()
  const items = new Map<Id, ArrangementItem>()
  const now = seed?.now ?? (() => Date.now())
  let seq = 0
  for (const a of seed?.arrangements ?? []) arrangements.set(a.id, { ...a })
  for (const it of seed?.items ?? []) items.set(it.id, { ...it })

  function cloneArrangement(a: Arrangement): Arrangement {
    return { ...a }
  }
  function cloneItem(it: ArrangementItem): ArrangementItem {
    return { ...it }
  }
  function requireArrangement(id: Id): Arrangement {
    const a = arrangements.get(id)
    if (!a) throw new AppError('NOT_FOUND', { details: { entity: 'arrangement', id } })
    return a
  }
  const itemsOf = (arrangementId: Id): ArrangementItem[] =>
    [...items.values()]
      .filter((it) => it.arrangementId === arrangementId)
      .sort((a, b) => a.timelineStartMs - b.timelineStartMs || a.orderInTrack - b.orderInTrack)

  return {
    async listByChapter(chapterId) {
      return [...arrangements.values()]
        .filter((a) => a.chapterId === chapterId)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt)
        .map(cloneArrangement)
    },

    async get(arrangementId) {
      const a = arrangements.get(arrangementId)
      return a ? cloneArrangement(a) : null
    },

    async getDefault(chapterId) {
      const found = [...arrangements.values()].find((a) => a.chapterId === chapterId && a.isDefault)
      return found ? cloneArrangement(found) : null
    },

    async create(input) {
      const id = `arr-${++seq}`
      const ts = now()
      const arrangement: Arrangement = {
        id,
        chapterId: input.chapterId,
        name: input.name,
        isDefault: input.isDefault ?? false,
        strategy: input.strategy,
        totalDurationMs: 0,
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      }
      if (arrangement.isDefault) {
        for (const a of arrangements.values()) if (a.chapterId === input.chapterId) a.isDefault = false
      }
      arrangements.set(id, arrangement)
      return cloneArrangement(arrangement)
    },

    async duplicate(arrangementId, name) {
      const src = requireArrangement(arrangementId)
      const id = `arr-${++seq}`
      const ts = now()
      const copy: Arrangement = {
        ...src,
        id,
        name,
        isDefault: false,
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      }
      arrangements.set(id, copy)
      for (const it of itemsOf(arrangementId)) {
        const itemId = `item-${++seq}`
        items.set(itemId, { ...it, id: itemId, arrangementId: id })
      }
      return cloneArrangement(copy)
    },

    async remove(arrangementId) {
      if (!arrangements.has(arrangementId)) return false
      arrangements.delete(arrangementId)
      for (const [id, it] of [...items]) if (it.arrangementId === arrangementId) items.delete(id)
      return true
    },

    async setDefault(arrangementId) {
      const target = arrangements.get(arrangementId)
      if (!target) return false
      for (const a of arrangements.values()) if (a.chapterId === target.chapterId) a.isDefault = false
      target.isDefault = true
      return true
    },

    async updateSummary(arrangementId, patch) {
      const a = requireArrangement(arrangementId)
      const next: Arrangement = {
        ...a,
        ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
        ...(patch.totalDurationMs !== undefined ? { totalDurationMs: patch.totalDurationMs } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        version: patch.bumpVersion ? a.version + 1 : a.version,
        updatedAt: now(),
      }
      arrangements.set(arrangementId, next)
      return cloneArrangement(next)
    },

    async listItems(arrangementId) {
      return itemsOf(arrangementId).map(cloneItem)
    },

    async getItem(itemId) {
      const it = items.get(itemId)
      return it ? cloneItem(it) : null
    },

    async replaceItems(arrangementId, next, opts) {
      requireArrangement(arrangementId)
      const trackId = opts?.trackId
      for (const [id, it] of [...items]) {
        if (it.arrangementId !== arrangementId) continue
        if (trackId !== undefined && it.trackId !== trackId) continue
        items.delete(id)
      }
      for (const it of next) items.set(it.id, { ...it, arrangementId })
      return itemsOf(arrangementId).map(cloneItem)
    },

    async updateItem(itemId, patch) {
      const it = items.get(itemId)
      if (!it) throw new AppError('NOT_FOUND', { details: { entity: 'arrangement_item', itemId } })
      const next: ArrangementItem = { ...it, ...patch }
      items.set(itemId, next)
      return cloneItem(next)
    },

    async updateItems(updates) {
      let count = 0
      for (const { itemId, patch } of updates) {
        const it = items.get(itemId)
        if (!it) continue
        items.set(itemId, { ...it, ...patch })
        count++
      }
      return count
    },

    async removeByLines(lineIds) {
      const set = new Set(lineIds)
      let count = 0
      for (const [id, it] of [...items]) {
        if (set.has(it.lineId)) {
          items.delete(id)
          count++
        }
      }
      return count
    },

    async removeBySegment(segmentId) {
      let count = 0
      for (const [id, it] of [...items]) {
        if (it.segmentId === segmentId) {
          items.delete(id)
          count++
        }
      }
      return count
    },
  }
}

/** 事务里用的 SQL 版本需要的辅助（内存实现不需要，导出给 sqlite 实现复用接口） */
