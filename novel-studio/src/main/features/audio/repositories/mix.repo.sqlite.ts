/**
 * Novel Studio · 混音方案仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `mix.repo.ts`（接口 + 内存实现）—— 行为基准
 *   · docs/21 §6 `mix_projects`：`tracks` / `master` / `title_reading` 是 JSON 文本
 *
 * ### 三条与内存实现一致的语义
 *   1. `tracks` 里的 `mixProjectId` 以**宿主方案**为准（整份提交可能带旧 id）；
 *   2. `save` 时 `isDefault` **不可由整份提交改写**（它是「每章唯一」的一部分，
 *      只能通过 `setDefault` 改）——否则一次防抖保存就能把默认方案改没；
 *   3. `version` 每次保存 +1（导出 `paramsHash` 的成分）。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, MixMaster, MixProject, MixTrack } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import { withTransactionAsync } from '../../../infra/db/with-transaction.ts'
import type { MixProjectRepo } from './mix.repo.ts'

const PROJECT_COLUMNS: readonly string[] = [
  'id',
  'chapter_id',
  'arrangement_id',
  'name',
  'is_default',
  'tracks',
  'master',
  'head_silence_ms',
  'tail_silence_ms',
  'title_reading',
  'version',
  'created_at',
  'updated_at',
]

const SELECT_PROJECT = `SELECT ${PROJECT_COLUMNS.join(', ')} FROM mix_projects`

interface ProjectRow {
  id: string
  chapter_id: string
  arrangement_id: string
  name: string
  is_default: number
  tracks: string
  master: string
  head_silence_ms: number
  tail_silence_ms: number
  title_reading: string | null
  version: number
  created_at: number
  updated_at: number
}

/** 默认母带（docs/15 §2；与 `EXPORT_DEFAULTS.truePeakDb` 一致） */
export const DEFAULT_MASTER: MixMaster = {
  targetLufs: -16,
  truePeakDb: -1,
  lra: 11,
  limiterEnabled: true,
  sampleRate: 48000,
  channels: 1,
}

export function mixProjectFromRow(row: ProjectRow): MixProject {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    arrangementId: row.arrangement_id,
    name: row.name,
    isDefault: row.is_default === 1,
    tracks: parseTracks(row.tracks, row.id),
    master: parseMaster(row.master),
    headSilenceMs: row.head_silence_ms,
    tailSilenceMs: row.tail_silence_ms,
    titleReading: parseTitleReading(row.title_reading),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseTracks(raw: string, hostId: Id): MixTrack[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t, index) => ({
        id: String(t['id'] ?? `track-${index}`),
        // 宿主以**方案**为准：整份提交可能带着旧 id（复制方案后最容易出现）
        mixProjectId: hostId,
        kind: (t['kind'] === 'music' || t['kind'] === 'sfx' ? t['kind'] : 'voice') as MixTrack['kind'],
        refId: typeof t['refId'] === 'string' ? t['refId'] : null,
        name: String(t['name'] ?? `轨道 ${index + 1}`),
        gainDb: numOr(t['gainDb'], 0),
        pan: numOr(t['pan'], 0),
        isMute: t['isMute'] === true,
        isSolo: t['isSolo'] === true,
        presetId: typeof t['presetId'] === 'string' ? t['presetId'] : null,
        sortOrder: numOr(t['sortOrder'], index),
        music: t['music'] && typeof t['music'] === 'object' ? (t['music'] as MixTrack['music']) : null,
      }))
  } catch {
    // 坏 JSON 当成「没有轨道」而不是抛：抛会让整份方案读不出来，用户连界面都打不开
    return []
  }
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseMaster(raw: string): MixMaster {
  try {
    const parsed = JSON.parse(raw) as Partial<MixMaster>
    return {
      targetLufs: numOr(parsed.targetLufs, DEFAULT_MASTER.targetLufs),
      truePeakDb: numOr(parsed.truePeakDb, DEFAULT_MASTER.truePeakDb),
      lra: numOr(parsed.lra, DEFAULT_MASTER.lra),
      limiterEnabled: parsed.limiterEnabled !== false,
      sampleRate: parsed.sampleRate === 44100 ? 44100 : 48000,
      channels: parsed.channels === 2 ? 2 : 1,
    }
  } catch {
    return { ...DEFAULT_MASTER }
  }
}

function parseTitleReading(raw: string | null): MixProject['titleReading'] {
  if (!raw) return { enabled: false, lineId: null, tailPauseMs: 500 }
  try {
    const parsed = JSON.parse(raw) as Partial<MixProject['titleReading']>
    return {
      enabled: parsed.enabled === true,
      lineId: typeof parsed.lineId === 'string' ? parsed.lineId : null,
      tailPauseMs: numOr(parsed.tailPauseMs, 500),
    }
  } catch {
    return { enabled: false, lineId: null, tailPauseMs: 500 }
  }
}

export function createSqliteMixProjectRepo(
  db: DbLike,
  opts?: { newId?: (prefix: string) => Id; now?: () => number },
): MixProjectRepo {
  const now = opts?.now ?? (() => Date.now())
  const newId = opts?.newId ?? ((prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`)

  function getProject(id: Id): MixProject | null {
    const row = db.prepare(`${SELECT_PROJECT} WHERE id = ?`).get(id) as ProjectRow | undefined
    return row ? mixProjectFromRow(row) : null
  }

  function readOne(id: Id): MixProject {
    const found = getProject(id)
    if (!found) throw new AppError('NOT_FOUND', { details: { entity: 'mix_project', id } })
    return found
  }

  function insert(project: MixProject, ts: number): void {
    db.prepare(
      `INSERT INTO mix_projects (${PROJECT_COLUMNS.join(', ')})
       VALUES (${PROJECT_COLUMNS.map(() => '?').join(', ')})`,
    ).run(
      project.id,
      project.chapterId,
      project.arrangementId,
      project.name,
      project.isDefault ? 1 : 0,
      JSON.stringify(project.tracks.map((t) => ({ ...t, mixProjectId: project.id }))),
      JSON.stringify(project.master),
      Math.round(project.headSilenceMs),
      Math.round(project.tailSilenceMs),
      JSON.stringify(project.titleReading),
      project.version,
      ts,
      ts,
    )
  }

  return {
    async listByChapter(chapterId) {
      const rows = db
        .prepare(`${SELECT_PROJECT} WHERE chapter_id = ? ORDER BY is_default DESC, created_at ASC`)
        .all(chapterId) as ProjectRow[]
      return rows.map(mixProjectFromRow)
    },

    async get(mixProjectId) {
      const row = db.prepare(`${SELECT_PROJECT} WHERE id = ?`).get(mixProjectId) as ProjectRow | undefined
      return row ? mixProjectFromRow(row) : null
    },

    async getDefault(chapterId) {
      const row = db
        .prepare(`${SELECT_PROJECT} WHERE chapter_id = ? AND is_default = 1 LIMIT 1`)
        .get(chapterId) as ProjectRow | undefined
      return row ? mixProjectFromRow(row) : null
    },

    async create(input) {
      const id = newId('mix')
      const ts = now()
      const isDefault = input.isDefault ?? false
      const project: MixProject = {
        id,
        chapterId: input.chapterId,
        arrangementId: input.arrangementId,
        name: input.name,
        isDefault,
        tracks: input.tracks.map((t) => ({ ...t, mixProjectId: id })),
        master: { ...input.master },
        headSilenceMs: input.headSilenceMs,
        tailSilenceMs: input.tailSilenceMs,
        titleReading: { ...input.titleReading },
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      }
      return withTransactionAsync(
        db,
        () => {
          insert(project, ts)
          if (isDefault) {
            db.prepare(`UPDATE mix_projects SET is_default = 0 WHERE chapter_id = ? AND id <> ?`).run(
              input.chapterId,
              id,
            )
          }
          return readOne(id)
        },
        { eventPrefix: 'mix.create' },
      )
    },

    async save(mixProject) {
      const cur = readOne(mixProject.id)
      const ts = now()
      return withTransactionAsync(
        db,
        () => {
          db.prepare(
            `UPDATE mix_projects
                SET chapter_id = ?, arrangement_id = ?, name = ?, tracks = ?, master = ?,
                    head_silence_ms = ?, tail_silence_ms = ?, title_reading = ?, version = ?, updated_at = ?
              WHERE id = ?`,
          ).run(
            mixProject.chapterId,
            mixProject.arrangementId,
            mixProject.name,
            JSON.stringify(mixProject.tracks.map((t) => ({ ...t, mixProjectId: mixProject.id }))),
            JSON.stringify(mixProject.master),
            Math.round(mixProject.headSilenceMs),
            Math.round(mixProject.tailSilenceMs),
            JSON.stringify(mixProject.titleReading),
            // version 由主进程递增：渲染侧提交的是它读到的那一份
            cur.version + 1,
            ts,
            mixProject.id,
          )
          return readOne(mixProject.id)
        },
        { eventPrefix: 'mix.save' },
      )
    },

    async duplicate(mixProjectId, name) {
      const src = readOne(mixProjectId)
      const id = newId('mix')
      const ts = now()
      const copy: MixProject = {
        ...src,
        id,
        name,
        isDefault: false,
        tracks: src.tracks.map((t, index) => ({ ...t, id: newId(`track${index}`), mixProjectId: id })),
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      }
      return withTransactionAsync(
        db,
        () => {
          insert(copy, ts)
          return readOne(id)
        },
        { eventPrefix: 'mix.duplicate' },
      )
    },

    async remove(mixProjectId) {
      // `mix_tracks`（遗留关系表）也要清：不清的话 music:delete 的引用检查会读到幽灵行
      return withTransactionAsync(
        db,
        () => {
          db.prepare(`DELETE FROM mix_tracks WHERE mix_project_id = ?`).run(mixProjectId)
          const r = db.prepare(`DELETE FROM mix_projects WHERE id = ?`).run(mixProjectId) as { changes?: number }
          return (r.changes ?? 0) > 0
        },
        { eventPrefix: 'mix.remove' },
      )
    },

    async setDefault(mixProjectId) {
      const target = getProject(mixProjectId)
      if (!target) return false
      return withTransactionAsync(
        db,
        () => {
          db.prepare(`UPDATE mix_projects SET is_default = 0 WHERE chapter_id = ?`).run(target.chapterId)
          db.prepare(`UPDATE mix_projects SET is_default = 1 WHERE id = ?`).run(mixProjectId)
          return true
        },
        { eventPrefix: 'mix.setDefault' },
      )
    },
  }
}
