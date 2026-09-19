/**
 * Novel Studio · Take 仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `take.repo.ts`（接口 + 内存实现）—— 行为基准，本文件把同样的语义翻成 SQL
 *   · docs/21 §6 `takes` 表（`part_index` / `is_selected` / `flags`(JSON) / `format` 三列）
 *   · 004 迁移加的 `deleted_at`：软删的 take 不出现在列表里
 *
 * ### 与内存实现必须一致的两条
 *   1. **成品唯一**：`setSelected` 在一个事务里先清零该行所有 take 再置位；
 *   2. **format 是三个列**：读回时组装成 `AudioFormat`，写盘时拆成三列 ——
 *      这是本仓库里唯一「领域对象是对象、库里是散列」的字段，最容易写反。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { AudioFormat, Id, Take } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import { withTransactionAsync } from '../../../infra/db/with-transaction.ts'
import type { TakeListOptions, TakeRepo } from './take.repo.ts'

/**
 * 列清单是**唯一来源**：`SELECT`（两种形态）与 `INSERT` 都由它派生。
 *
 * 为什么联表形态不能复用不带前缀的那份：`takes` 与 `canvas_lines` 都有 `id` 等列，
 * 不加限定符时 SQLite 直接报 `ambiguous column name: id`（本轮测试抓到过）。
 */
const TAKE_COLUMNS: readonly string[] = [
  'id',
  'line_id',
  'session_id',
  'file_path',
  'part_index',
  'src_in_ms',
  'src_out_ms',
  'trimmed_in_ms',
  'trimmed_out_ms',
  'duration_ms',
  'peak_db',
  'rms_db',
  'lufs',
  'gain_db',
  'sample_rate',
  'bit_depth',
  'channels',
  'source',
  'package_id',
  'flags',
  'is_selected',
  'note',
  'recorded_at',
  'created_at',
]

const SELECT_COLS = TAKE_COLUMNS.join(', ')
const SELECT_TAKE = `SELECT ${SELECT_COLS} FROM takes`
/** 与 `canvas_lines` 联表时用：每列都带 `t.` 前缀，避免列名歧义 */
const SELECT_TAKE_FROM_ALIAS = `SELECT ${TAKE_COLUMNS.map((c) => `t.${c}`).join(', ')} FROM takes t`

interface TakeRow {
  id: string
  line_id: string
  session_id: string | null
  file_path: string
  part_index: number
  src_in_ms: number
  src_out_ms: number
  trimmed_in_ms: number
  trimmed_out_ms: number
  duration_ms: number
  peak_db: number | null
  rms_db: number | null
  lufs: number | null
  gain_db: number
  sample_rate: number
  bit_depth: number
  channels: number
  source: string
  package_id: string | null
  flags: string | null
  is_selected: number
  note: string | null
  recorded_at: number
  created_at: number
}

function parseFlags(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function takeFromRow(row: TakeRow): Take {
  const format: AudioFormat = {
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth as AudioFormat['bitDepth'],
    channels: row.channels as AudioFormat['channels'],
  }
  return {
    id: row.id,
    lineId: row.line_id,
    sessionId: row.session_id,
    filePath: row.file_path,
    partIndex: row.part_index,
    srcInMs: row.src_in_ms,
    srcOutMs: row.src_out_ms,
    trimmedInMs: row.trimmed_in_ms,
    trimmedOutMs: row.trimmed_out_ms,
    durationMs: row.duration_ms,
    peakDb: row.peak_db,
    rmsDb: row.rms_db,
    lufs: row.lufs,
    gainDb: row.gain_db,
    format,
    source: row.source as Take['source'],
    packageId: row.package_id,
    flags: parseFlags(row.flags),
    isSelected: row.is_selected === 1,
    note: row.note,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
  }
}

/** 一行 → 24 个插入参数（顺序与 {@link TAKE_COLUMNS} 一致；`format` 拆成三列） */
function takeToParams(t: Take): unknown[] {
  return [
    t.id,
    t.lineId,
    t.sessionId,
    t.filePath,
    t.partIndex,
    t.srcInMs,
    t.srcOutMs,
    t.trimmedInMs,
    t.trimmedOutMs,
    t.durationMs,
    t.peakDb,
    t.rmsDb,
    t.lufs,
    t.gainDb,
    t.format.sampleRate,
    t.format.bitDepth,
    t.format.channels,
    t.source,
    t.packageId,
    JSON.stringify(t.flags ?? []),
    t.isSelected ? 1 : 0,
    t.note,
    t.recordedAt,
    t.createdAt,
  ]
}

export function createSqliteTakeRepo(db: DbLike): TakeRepo {
  const sortTakes = (list: Take[]): Take[] =>
    [...list].sort((a, b) => a.partIndex - b.partIndex || a.recordedAt - b.recordedAt || a.id.localeCompare(b.id))

  function aliveClause(opts?: TakeListOptions): string {
    return (opts?.includeDeleted ?? false) ? '' : ' AND deleted_at IS NULL'
  }

  return {
    async listByLine(lineId: Id, opts?: TakeListOptions): Promise<Take[]> {
      const rows = db
        .prepare(`${SELECT_TAKE} WHERE line_id = ?${aliveClause(opts)} ORDER BY part_index ASC, recorded_at ASC`)
        .all(lineId) as TakeRow[]
      return sortTakes(rows.map(takeFromRow))
    },

    async listByChapter(chapterId: Id, opts?: TakeListOptions): Promise<Take[]> {
      // 章节维度要走 canvas_lines（takes 只有 line_id）：takes → canvas_lines.chapter_id。
      // 列名必须带 `t.` 前缀（两份表都有 id/line_id 之类的列，否则 SQLite 报 ambiguous）
      const includeDeleted = opts?.includeDeleted ?? false
      const rows = db
        .prepare(
          `${SELECT_TAKE_FROM_ALIAS}
             JOIN canvas_lines l ON l.id = t.line_id
            WHERE l.chapter_id = ?${includeDeleted ? '' : ' AND t.deleted_at IS NULL'}
            ORDER BY t.part_index ASC, t.recorded_at ASC`,
        )
        .all(chapterId) as TakeRow[]
      return sortTakes(rows.map(takeFromRow))
    },

    async get(takeId: Id, opts?: TakeListOptions): Promise<Take | null> {
      const alive = (opts?.includeDeleted ?? false) ? '' : ' AND deleted_at IS NULL'
      const row = db.prepare(`${SELECT_TAKE} WHERE id = ?${alive}`).get(takeId) as TakeRow | undefined
      return row ? takeFromRow(row) : null
    },

    async insert(take: Take): Promise<Take> {
      try {
        db.prepare(
          `INSERT INTO takes (${TAKE_COLUMNS.join(', ')})
           VALUES (${TAKE_COLUMNS.map(() => '?').join(', ')})`,
        ).run(...takeToParams(take))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/UNIQUE|PRIMARY/i.test(msg)) {
          throw new AppError('CONFLICT', { cause: e, details: { entity: 'take', id: take.id } })
        }
        throw e
      }
      return take
    },

    async setFlags(takeId: Id, flags: string[]): Promise<Take> {
      const current = db.prepare(`SELECT id FROM takes WHERE id = ? AND deleted_at IS NULL`).get(takeId)
      if (!current) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
      db.prepare(`UPDATE takes SET flags = ? WHERE id = ?`).run(JSON.stringify(flags ?? []), takeId)
      const row = db.prepare(`${SELECT_TAKE} WHERE id = ?`).get(takeId) as TakeRow
      return takeFromRow(row)
    },

    async setSelected(lineId: Id, takeId: Id | null): Promise<Take[]> {
      return withTransactionAsync(
        db,
        () => {
          if (takeId !== null) {
            const exists = db
              .prepare(`SELECT line_id FROM takes WHERE id = ? AND deleted_at IS NULL`)
              .get(takeId) as { line_id: string } | undefined
            if (!exists) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
            if (exists.line_id !== lineId) {
              // 把别的行的 take 设为这一行的成品 → 明确拒绝（否则会同时破坏两行的成品关系）
              throw new AppError('INVALID_PAYLOAD', {
                details: { op: 'take:setSelected', reason: 'take-line-mismatch', lineId, takeId },
              })
            }
          }
          // 先全部清零再置位：DDL 没有「每行至多一个 selected」的约束，这里必须自己保证
          db.prepare(`UPDATE takes SET is_selected = 0 WHERE line_id = ? AND deleted_at IS NULL`).run(lineId)
          if (takeId !== null) {
            db.prepare(`UPDATE takes SET is_selected = 1 WHERE id = ?`).run(takeId)
          }
          const rows = db
            .prepare(`${SELECT_TAKE} WHERE line_id = ? AND deleted_at IS NULL ORDER BY part_index ASC`)
            .all(lineId) as TakeRow[]
          return sortTakes(rows.map(takeFromRow))
        },
        { eventPrefix: 'take.tx' },
      )
    },

    async maxPartIndex(lineId: Id): Promise<number> {
      const row = db
        .prepare(`SELECT MAX(part_index) AS n FROM takes WHERE line_id = ? AND deleted_at IS NULL`)
        .get(lineId) as { n: number | null } | undefined
      return row?.n ?? -1
    },

    async softDelete(takeId: Id): Promise<boolean> {
      const r = db
        .prepare(
          `UPDATE takes SET deleted_at = ?, is_selected = 0
            WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(Date.now(), takeId) as { changes?: number }
      return (r.changes ?? 0) > 0
    },

    async remove(takeId: Id): Promise<boolean> {
      const r = db.prepare(`DELETE FROM takes WHERE id = ?`).run(takeId) as { changes?: number }
      return (r.changes ?? 0) > 0
    },
  }
}
