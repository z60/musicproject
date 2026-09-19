/**
 * Novel Studio · Take 仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §6   `takes` 表结构（含 `part_index`：超长行分段录的顺序）
 *   · docs/12 §8.1 「任何 take 都不自动删除（除用户显式清理）」——被替换的也保留
 *   · docs/12 §8.2 软删（文件保留）/ 硬删（删文件）两种删除
 *   · docs/12 §13   多 take：同一行录 5 次全部保留、A/B 可切、**成品唯一**
 *
 * ### 两条必须守住的语义（都有测试）
 *   1. **成品唯一**：`setSelected(lineId, takeId)` 会把该行其它 take 的 `is_selected` 清零。
 *      DDL 上没有「每行至多一个 selected」的约束，所以只能由实现保证 ——
 *      否则 UI 会随机取到一个「成品」（`takes.store.selectedOf` 已经为此写了异常提示）。
 *   2. **软删不出现在列表里**，但行还在（`deleted_at` 由 004 迁移加）。
 *      `listByLine` / `listByChapter` 一律过滤软删。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { AudioFormat, Id, Take, Timestamp } from '../../../../shared/types.ts'

export interface TakeListOptions {
  /** 默认 false：软删的 take 不返回（004 迁移加的 `deleted_at`） */
  includeDeleted?: boolean
}

export interface TakeRepo {
  listByLine(lineId: Id, opts?: TakeListOptions): Promise<Take[]>
  /** 整章（走 canvas_lines 的 chapter_id） */
  listByChapter(chapterId: Id, opts?: TakeListOptions): Promise<Take[]>
  get(takeId: Id, opts?: TakeListOptions): Promise<Take | null>
  /** 插入（id 冲突抛 CONFLICT） */
  insert(take: Take): Promise<Take>
  /** 打标：**整体替换** flags（与契约 `take:flag` 的语义一致） */
  setFlags(takeId: Id, flags: string[]): Promise<Take>
  /**
   * 设为该行的成品：把 `takeId` 置为选中、其余清零；`takeId = null` 表示「取消成品」。
   * 返回被改动的 take 列表（UI 用来就地刷新）。
   */
  setSelected(lineId: Id, takeId: Id | null): Promise<Take[]>
  /** 同一条 line 上已用过的最大 `part_index`（合并/新分段要用它排顺序） */
  maxPartIndex(lineId: Id): Promise<number>
  /** 软删（文件保留、行标记 deleted_at） */
  softDelete(takeId: Id): Promise<boolean>
  /** 硬删（行消失；文件由服务层删） */
  remove(takeId: Id): Promise<boolean>
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准）
// ---------------------------------------------------------------------------

export function createMemoryTakeRepo(seed?: { takes?: Take[]; now?: () => Timestamp }): TakeRepo {
  const items = new Map<Id, { take: Take; deletedAt: Timestamp | null }>()
  const now = seed?.now ?? (() => Date.now())
  for (const t of seed?.takes ?? []) items.set(t.id, { take: cloneTake(t), deletedAt: null })

  const alive = (rec: { take: Take; deletedAt: Timestamp | null } | undefined): boolean =>
    rec !== undefined && rec.deletedAt === null

  const sortTakes = (list: Take[]): Take[] =>
    [...list].sort((a, b) => a.partIndex - b.partIndex || a.recordedAt - b.recordedAt || a.id.localeCompare(b.id))

  return {
    async listByLine(lineId, opts) {
      const include = opts?.includeDeleted ?? false
      return sortTakes(
        [...items.values()]
          .filter((r) => r.take.lineId === lineId && (include || alive(r)))
          .map((r) => cloneTake(r.take)),
      )
    },

    async listByChapter(chapterId, opts) {
      // 内存实现没有 canvas_lines，调用方负责用 `lineIds` 过滤；这里保守地返回全部
      // （与 SQLite 版的差异见 sqlite 实现的注释，测试用 `listByLine` 做行为比对）
      void chapterId
      const include = opts?.includeDeleted ?? false
      return sortTakes([...items.values()].filter((r) => include || alive(r)).map((r) => cloneTake(r.take)))
    },

    async get(takeId, opts) {
      const rec = items.get(takeId)
      if (!rec) return null
      if (rec.deletedAt !== null && !(opts?.includeDeleted ?? false)) return null
      return cloneTake(rec.take)
    },

    async insert(take) {
      if (items.has(take.id)) {
        throw new AppError('CONFLICT', { details: { entity: 'take', id: take.id } })
      }
      const ts = now()
      const next: Take = { ...cloneTake(take), createdAt: take.createdAt || ts }
      items.set(next.id, { take: next, deletedAt: null })
      return cloneTake(next)
    },

    async setFlags(takeId, flags) {
      const rec = items.get(takeId)
      if (!alive(rec)) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
      rec!.take = { ...rec!.take, flags: [...flags] }
      return cloneTake(rec!.take)
    },

    async setSelected(lineId, takeId) {
      const changed: Take[] = []
      for (const [id, rec] of items) {
        if (!alive(rec) || rec.take.lineId !== lineId) continue
        const shouldSelect = id === takeId
        if (rec.take.isSelected === shouldSelect) continue
        rec.take = { ...rec.take, isSelected: shouldSelect }
        changed.push(cloneTake(rec.take))
      }
      // 选中的 take 不存在于该行 → 明确报错（否则「设为成品」会静默什么都不做）
      if (takeId !== null && !items.has(takeId)) {
        throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
      }
      return changed
    },

    async maxPartIndex(lineId) {
      let max = -1
      for (const rec of items.values()) {
        if (!alive(rec) || rec.take.lineId !== lineId) continue
        if (rec.take.partIndex > max) max = rec.take.partIndex
      }
      return max
    },

    async softDelete(takeId) {
      const rec = items.get(takeId)
      if (!alive(rec)) return false
      rec!.deletedAt = now()
      // 软删的 take 不能继续当成品（否则「成品指向一条已移除的 take」）
      if (rec!.take.isSelected) rec!.take = { ...rec!.take, isSelected: false }
      return true
    },

    async remove(takeId) {
      const rec = items.get(takeId)
      if (!rec) return false
      items.delete(takeId)
      return true
    },
  }
}

function cloneTake(t: Take): Take {
  return { ...t, format: { ...t.format } as AudioFormat, flags: [...t.flags] }
}
