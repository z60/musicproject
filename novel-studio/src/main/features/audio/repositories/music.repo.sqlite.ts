/**
 * Novel Studio · 素材仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `music.repo.ts`（接口 + 内存实现）—— 行为基准
 *   · docs/21 §6 `music_assets`：`tags` 是 JSON 文本、`loopable` 是 0/1、
 *     `duration_ms/sample_rate/channels/peak_db/lufs` 可空（导入时可能还没探测）
 *
 * ### 列清单单一来源
 *   `ASSET_COLUMNS` 同时用于 SELECT 与 INSERT（本项目在 take 仓储上真被列序错位坑过一次，
 *   见 docs/91 §5.2.18）。`saveMetrics` 的列是显式写的，只动那五列。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, MusicAsset } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import type { MusicAssetInput, MusicAssetMetricsPatch, MusicAssetRepo } from './music.repo.ts'

const ASSET_COLUMNS: readonly string[] = [
  'id',
  'project_id',
  'kind',
  'name',
  'file_path',
  'original_name',
  'duration_ms',
  'sample_rate',
  'channels',
  'peak_db',
  'lufs',
  'loopable',
  'tags',
  'note',
  'license_note',
  'created_at',
]

const SELECT_ASSET = `SELECT ${ASSET_COLUMNS.join(', ')} FROM music_assets`

interface AssetRow {
  id: string
  project_id: string
  kind: string
  name: string
  file_path: string
  original_name: string | null
  duration_ms: number | null
  sample_rate: number | null
  channels: number | null
  peak_db: number | null
  lufs: number | null
  loopable: number
  tags: string | null
  note: string | null
  license_note: string | null
  created_at: number
}

export function musicAssetFromRow(row: AssetRow): MusicAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as MusicAsset['kind'],
    name: row.name,
    filePath: row.file_path,
    originalName: row.original_name,
    durationMs: row.duration_ms,
    sampleRate: row.sample_rate,
    channels: row.channels,
    peakDb: row.peak_db,
    lufs: row.lufs,
    loopable: row.loopable === 1,
    tags: parseTags(row.tags),
    note: row.note,
    licenseNote: row.license_note,
    createdAt: row.created_at,
  }
}

function parseTags(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export function createSqliteMusicAssetRepo(
  db: DbLike,
  opts?: { newId?: (prefix: string) => Id; now?: () => number },
): MusicAssetRepo {
  const now = opts?.now ?? (() => Date.now())
  const newId = opts?.newId ?? ((prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`)

  function readOne(assetId: Id): MusicAsset {
    const row = db.prepare(`${SELECT_ASSET} WHERE id = ?`).get(assetId) as AssetRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'music_asset', assetId } })
    return musicAssetFromRow(row)
  }

  return {
    async list(projectId, kind) {
      const sql =
        kind === undefined
          ? `${SELECT_ASSET} WHERE project_id = ? ORDER BY created_at ASC, name ASC`
          : `${SELECT_ASSET} WHERE project_id = ? AND kind = ? ORDER BY created_at ASC, name ASC`
      const rows = (
        kind === undefined ? db.prepare(sql).all(projectId) : db.prepare(sql).all(projectId, kind)
      ) as AssetRow[]
      return rows.map(musicAssetFromRow)
    },

    async get(assetId) {
      const row = db.prepare(`${SELECT_ASSET} WHERE id = ?`).get(assetId) as AssetRow | undefined
      return row ? musicAssetFromRow(row) : null
    },

    async insert(input: MusicAssetInput) {
      const id = newId('music')
      db.prepare(
        `INSERT INTO music_assets (${ASSET_COLUMNS.join(', ')})
         VALUES (${ASSET_COLUMNS.map(() => '?').join(', ')})`,
      ).run(
        id,
        input.projectId,
        input.kind,
        input.name,
        input.filePath,
        input.originalName ?? null,
        input.durationMs ?? null,
        input.sampleRate ?? null,
        input.channels ?? null,
        input.peakDb ?? null,
        input.lufs ?? null,
        input.loopable ? 1 : 0,
        JSON.stringify(input.tags ?? []),
        input.note ?? null,
        input.licenseNote ?? null,
        now(),
      )
      return readOne(id)
    },

    async saveMetrics(assetId, patch: MusicAssetMetricsPatch) {
      const r = db
        .prepare(
          `UPDATE music_assets
              SET duration_ms = ?, sample_rate = ?, channels = ?, peak_db = ?, lufs = ?
            WHERE id = ?`,
        )
        .run(patch.durationMs, patch.sampleRate, patch.channels, patch.peakDb, patch.lufs, assetId) as {
        changes?: number
      }
      if ((r.changes ?? 0) === 0) {
        throw new AppError('NOT_FOUND', { details: { entity: 'music_asset', assetId } })
      }
      return readOne(assetId)
    },

    async remove(assetId) {
      const r = db.prepare(`DELETE FROM music_assets WHERE id = ?`).run(assetId) as { changes?: number }
      return (r.changes ?? 0) > 0
    },
  }
}
