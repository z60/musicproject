/**
 * Novel Studio · 对轨仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `arrangement.repo.ts`（接口 + 内存实现）—— 行为基准
 *   · docs/21 §6 `arrangements` / `arrangement_items`
 *
 * ### 与内存实现必须一致的三条（都在文件头说明过）
 *   1. 每章至多一个默认方案 —— `setDefault` 在一个事务里先清零同章其它方案；
 *   2. `replaceItems` 全量替换是原子的 —— 删 + 写在一个事务里，中途失败不留空时间线；
 *   3. `version` 只在「整体重排」时 +1（`bumpVersion`），单条改动不动它 ——
 *      version 是导出用的 `paramsHash` 的成分，每次拖动都 +1 会让导出缓存永久失效。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Arrangement, ArrangementItem, Id } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import { withTransactionAsync } from '../../../infra/db/with-transaction.ts'
import type { ArrangementRepo } from './arrangement.repo.ts'

const ARRANGEMENT_COLUMNS: readonly string[] = [
  'id',
  'chapter_id',
  'name',
  'is_default',
  'strategy',
  'total_duration_ms',
  'version',
  'created_at',
  'updated_at',
]

const ITEM_COLUMNS: readonly string[] = [
  'id',
  'arrangement_id',
  'segment_id',
  'line_id',
  'track_id',
  'timeline_start_ms',
  'src_in_ms',
  'src_out_ms',
  'fade_in_ms',
  'fade_out_ms',
  'locked',
  'order_in_track',
  'overlap_with',
  'created_at',
  'updated_at',
]

const SELECT_ARRANGEMENT = `SELECT ${ARRANGEMENT_COLUMNS.join(', ')} FROM arrangements`
const SELECT_ITEM = `SELECT ${ITEM_COLUMNS.join(', ')} FROM arrangement_items`

interface ArrangementRow {
  id: string
  chapter_id: string
  name: string
  is_default: number
  strategy: string
  total_duration_ms: number
  version: number
  created_at: number
  updated_at: number
}

interface ItemRow {
  id: string
  arrangement_id: string
  segment_id: string
  line_id: string
  track_id: string
  timeline_start_ms: number
  src_in_ms: number
  src_out_ms: number
  fade_in_ms: number
  fade_out_ms: number
  locked: number
  order_in_track: number
  overlap_with: string | null
  created_at: number
  updated_at: number
}

export function arrangementFromRow(row: ArrangementRow): Arrangement {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    name: row.name,
    isDefault: row.is_default === 1,
    strategy: row.strategy as Arrangement['strategy'],
    totalDurationMs: row.total_duration_ms,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function itemFromRow(row: ItemRow): ArrangementItem {
  return {
    id: row.id,
    arrangementId: row.arrangement_id,
    segmentId: row.segment_id,
    lineId: row.line_id,
    trackId: row.track_id,
    timelineStartMs: row.timeline_start_ms,
    srcInMs: row.src_in_ms,
    srcOutMs: row.src_out_ms,
    fadeInMs: row.fade_in_ms,
    fadeOutMs: row.fade_out_ms,
    locked: row.locked === 1,
    orderInTrack: row.order_in_track,
    overlapWith: row.overlap_with,
  }
}

export function createSqliteArrangementRepo(
  db: DbLike,
  opts?: { newId?: (prefix: string) => Id; now?: () => number },
): ArrangementRepo {
  const now = opts?.now ?? (() => Date.now())
  const newId = opts?.newId ?? ((prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`)

  function getArrangement(id: Id): Arrangement | null {
    const row = db.prepare(`${SELECT_ARRANGEMENT} WHERE id = ?`).get(id) as ArrangementRow | undefined
    return row ? arrangementFromRow(row) : null
  }

  function requireArrangement(id: Id): Arrangement {
    const found = getArrangement(id)
    if (!found) throw new AppError('NOT_FOUND', { details: { entity: 'arrangement', id } })
    return found
  }

  function readItem(itemId: Id): ArrangementItem {
    const row = db.prepare(`${SELECT_ITEM} WHERE id = ?`).get(itemId) as ItemRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'arrangement_item', itemId } })
    return itemFromRow(row)
  }

  function listItems(arrangementId: Id, trackId?: string): ArrangementItem[] {
    const sql =
      trackId === undefined
        ? `${SELECT_ITEM} WHERE arrangement_id = ? ORDER BY timeline_start_ms ASC, order_in_track ASC`
        : `${SELECT_ITEM} WHERE arrangement_id = ? AND track_id = ? ORDER BY timeline_start_ms ASC, order_in_track ASC`
    const rows = (trackId === undefined ? db.prepare(sql).all(arrangementId) : db.prepare(sql).all(arrangementId, trackId)) as ItemRow[]
    return rows.map(itemFromRow)
  }

  function insertItem(item: ArrangementItem, ts: number): void {
    db.prepare(
      `INSERT INTO arrangement_items (${ITEM_COLUMNS.join(', ')})
       VALUES (${ITEM_COLUMNS.map(() => '?').join(', ')})`,
    ).run(
      item.id,
      item.arrangementId,
      item.segmentId,
      item.lineId,
      item.trackId,
      Math.round(item.timelineStartMs),
      Math.round(item.srcInMs),
      Math.round(item.srcOutMs),
      Math.round(item.fadeInMs),
      Math.round(item.fadeOutMs),
      item.locked ? 1 : 0,
      Math.round(item.orderInTrack),
      item.overlapWith,
      ts,
      ts,
    )
  }

  return {
    async listByChapter(chapterId) {
      const rows = db
        .prepare(`${SELECT_ARRANGEMENT} WHERE chapter_id = ? ORDER BY is_default DESC, created_at ASC`)
        .all(chapterId) as ArrangementRow[]
      return rows.map(arrangementFromRow)
    },

    async get(arrangementId) {
      return getArrangement(arrangementId)
    },

    async getDefault(chapterId) {
      const row = db
        .prepare(`${SELECT_ARRANGEMENT} WHERE chapter_id = ? AND is_default = 1 LIMIT 1`)
        .get(chapterId) as ArrangementRow | undefined
      return row ? arrangementFromRow(row) : null
    },

    async create(input) {
      const id = newId('arr')
      const ts = now()
      const isDefault = input.isDefault ?? false
      db.prepare(
        `INSERT INTO arrangements (${ARRANGEMENT_COLUMNS.join(', ')})
         VALUES (${ARRANGEMENT_COLUMNS.map(() => '?').join(', ')})`,
      ).run(id, input.chapterId, input.name, isDefault ? 1 : 0, input.strategy, 0, 1, ts, ts)
      if (isDefault) {
        // 先建行再清零其它：反过来的话，万一插入失败，该章会变成「一个默认都没有」
        db.prepare(`UPDATE arrangements SET is_default = 0 WHERE chapter_id = ? AND id <> ?`).run(input.chapterId, id)
      }
      return requireArrangement(id)
    },

    async duplicate(arrangementId, name) {
      const src = requireArrangement(arrangementId)
      const id = newId('arr')
      const ts = now()
      return withTransactionAsync(
        db,
        () => {
          db.prepare(
            `INSERT INTO arrangements (${ARRANGEMENT_COLUMNS.join(', ')})
             VALUES (${ARRANGEMENT_COLUMNS.map(() => '?').join(', ')})`,
          ).run(id, src.chapterId, name, 0, src.strategy, src.totalDurationMs, 1, ts, ts)
          const copied = listItems(arrangementId)
          for (const it of copied) insertItem({ ...it, id: newId('item'), arrangementId: id }, ts)
          return requireArrangement(id)
        },
        { eventPrefix: 'arrangement.duplicate' },
      )
    },

    async remove(arrangementId) {
      // items 由 `ON DELETE CASCADE` 带走（外键在应用启动时开启，见 docs/02）
      const r = db.prepare(`DELETE FROM arrangements WHERE id = ?`).run(arrangementId) as { changes?: number }
      return (r.changes ?? 0) > 0
    },

    async setDefault(arrangementId) {
      const target = getArrangement(arrangementId)
      if (!target) return false
      return withTransactionAsync(
        db,
        () => {
          db.prepare(`UPDATE arrangements SET is_default = 0 WHERE chapter_id = ?`).run(target.chapterId)
          db.prepare(`UPDATE arrangements SET is_default = 1 WHERE id = ?`).run(arrangementId)
          return true
        },
        { eventPrefix: 'arrangement.setDefault' },
      )
    },

    async updateSummary(arrangementId, patch) {
      const cur = requireArrangement(arrangementId)
      const next = {
        strategy: patch.strategy ?? cur.strategy,
        totalDurationMs: patch.totalDurationMs ?? cur.totalDurationMs,
        name: patch.name ?? cur.name,
        version: patch.bumpVersion ? cur.version + 1 : cur.version,
      }
      db.prepare(
        `UPDATE arrangements SET strategy = ?, total_duration_ms = ?, name = ?, version = ?, updated_at = ?
          WHERE id = ?`,
      ).run(next.strategy, Math.round(next.totalDurationMs), next.name, next.version, now(), arrangementId)
      return requireArrangement(arrangementId)
    },

    async listItems(arrangementId) {
      return listItems(arrangementId)
    },

    async getItem(itemId) {
      const row = db.prepare(`${SELECT_ITEM} WHERE id = ?`).get(itemId) as ItemRow | undefined
      return row ? itemFromRow(row) : null
    },

    async replaceItems(arrangementId, items, opts) {
      const ts = now()
      return withTransactionAsync(
        db,
        () => {
          requireArrangement(arrangementId)
          if (opts?.trackId === undefined) {
            db.prepare(`DELETE FROM arrangement_items WHERE arrangement_id = ?`).run(arrangementId)
          } else {
            db.prepare(`DELETE FROM arrangement_items WHERE arrangement_id = ? AND track_id = ?`).run(
              arrangementId,
              opts.trackId,
            )
          }
          for (const it of items) insertItem({ ...it, arrangementId }, ts)
          return listItems(arrangementId)
        },
        { eventPrefix: 'arrangement.replaceItems' },
      )
    },

    async updateItem(itemId, patch) {
      const cur = readItem(itemId)
      const next: ArrangementItem = { ...cur, ...patch }
      db.prepare(
        `UPDATE arrangement_items
            SET timeline_start_ms = ?, src_in_ms = ?, src_out_ms = ?, fade_in_ms = ?, fade_out_ms = ?,
                locked = ?, order_in_track = ?, overlap_with = ?, track_id = ?, segment_id = ?,
                line_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        Math.round(next.timelineStartMs),
        Math.round(next.srcInMs),
        Math.round(next.srcOutMs),
        Math.round(next.fadeInMs),
        Math.round(next.fadeOutMs),
        next.locked ? 1 : 0,
        Math.round(next.orderInTrack),
        next.overlapWith,
        next.trackId,
        next.segmentId,
        next.lineId,
        now(),
        itemId,
      )
      return readItem(itemId)
    },

    async updateItems(updates) {
      if (updates.length === 0) return 0
      return withTransactionAsync(
        db,
        () => {
          let changed = 0
          for (const { itemId, patch } of updates) {
            const row = db.prepare(`SELECT id FROM arrangement_items WHERE id = ?`).get(itemId)
            if (!row) continue
            const cur = readItem(itemId)
            const next: ArrangementItem = { ...cur, ...patch }
            db.prepare(
              `UPDATE arrangement_items
                  SET timeline_start_ms = ?, src_in_ms = ?, src_out_ms = ?, fade_in_ms = ?, fade_out_ms = ?,
                      locked = ?, order_in_track = ?, overlap_with = ?, track_id = ?, segment_id = ?,
                      line_id = ?, updated_at = ?
                WHERE id = ?`,
            ).run(
              Math.round(next.timelineStartMs),
              Math.round(next.srcInMs),
              Math.round(next.srcOutMs),
              Math.round(next.fadeInMs),
              Math.round(next.fadeOutMs),
              next.locked ? 1 : 0,
              Math.round(next.orderInTrack),
              next.overlapWith,
              next.trackId,
              next.segmentId,
              next.lineId,
              now(),
              itemId,
            )
            changed++
          }
          return changed
        },
        { eventPrefix: 'arrangement.updateItems' },
      )
    },

    async removeByLines(lineIds) {
      if (lineIds.length === 0) return 0
      const marks = lineIds.map(() => '?').join(', ')
      const r = db.prepare(`DELETE FROM arrangement_items WHERE line_id IN (${marks})`).run(...lineIds) as {
        changes?: number
      }
      return r.changes ?? 0
    },

    async removeBySegment(segmentId) {
      const r = db.prepare(`DELETE FROM arrangement_items WHERE segment_id = ?`).run(segmentId) as { changes?: number }
      return r.changes ?? 0
    },
  }
}
