/**
 * Novel Studio · 处理预设仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `preset.repo.ts`（接口 + 内存实现）—— 行为基准
 *   · docs/21 §6 `process_presets`：`chain` / `tags` 是 JSON 文本，`project_id` 可空（NULL = 全局）
 *
 * ### 与内存实现必须一致的两条
 *   1. `list(projectId)` = 全局（`project_id IS NULL`）∪ 该项目，按 `sort_order` 排序；
 *      传 null 时**只**取全局 —— 不能把「没有项目」当成「所有项目」。
 *   2. 内置预设不在库里，`update`/`remove` 拿到 `builtin = 1` 的行时必须抛 `FORBIDDEN`
 *      （库里理论上不会有 builtin 行；真有的话，多半是历史数据或手工导入，
 *      拒绝编辑比默默改坏它安全）。
 */

import { AppError } from '../../../../shared/errors.ts'
import type { Id, ProcessChain, ProcessPreset } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import type { PresetRepo, ProcessPresetInput } from './preset.repo.ts'
import { cloneChain, normalizeChain } from './preset.repo.ts'

/**
 * 解析库里的链（JSON 文本 → 完整链）。
 *
 * 补齐逻辑放在 `preset.repo.ts` 的 `normalizeChain` 里：内存实现与 SQLite 实现
 * **必须**对同一份旧 JSON 得到同样的链，否则「同一份预设导入内存库能跑、进 SQLite 就炸」。
 */
export function parseChain(raw: string, presetId = ''): ProcessChain {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new AppError('PROCESS_PRESET_INVALID', {
      cause: e,
      params: { name: presetId || '(未命名)' },
      details: { op: 'preset:read', reason: 'chain-not-json', presetId },
    })
  }
  return normalizeChain(parsed, presetId)
}

const PRESET_COLUMNS: readonly string[] = [
  'id',
  'project_id',
  'name',
  'description',
  'builtin',
  'chain',
  'tags',
  'sort_order',
  'created_at',
  'updated_at',
]

const SELECT_PRESET = `SELECT ${PRESET_COLUMNS.join(', ')} FROM process_presets`

interface PresetRow {
  id: string
  project_id: string | null
  name: string
  description: string | null
  builtin: number
  chain: string
  tags: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

export function presetFromRow(row: PresetRow): ProcessPreset {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    builtin: row.builtin === 1,
    chain: parseChain(row.chain, row.id),
    tags: parseTags(row.tags),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 解析库里的链。
 *
 * 库里的 JSON 可能是**旧版本写的**（少了后来新增的字段），所以这里做一次
 * 「按默认链补齐」：缺字段会让 `buildChainFilter` 直接抛 `Cannot read properties of undefined`
 * —— 那是用户点「应用预设」时才炸，而错误信息与预设名毫无关系。
 */
function parseTags(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export function createSqlitePresetRepo(db: DbLike, opts?: { newId?: () => Id; now?: () => number }): PresetRepo {
  const now = opts?.now ?? (() => Date.now())
  const newId = opts?.newId ?? (() => `preset-${globalThis.crypto.randomUUID()}`)

  function readOne(id: Id): ProcessPreset {
    const row = db.prepare(`${SELECT_PRESET} WHERE id = ?`).get(id) as PresetRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'process_preset', id } })
    return presetFromRow(row)
  }

  function insertOne(input: ProcessPresetInput, id: Id, ts: number): void {
    db.prepare(
      `INSERT INTO process_presets (${PRESET_COLUMNS.join(', ')})
       VALUES (${PRESET_COLUMNS.map(() => '?').join(', ')})`,
    ).run(
      id,
      input.projectId,
      input.name,
      input.description ?? null,
      0,
      JSON.stringify(input.chain),
      JSON.stringify(input.tags ?? []),
      input.sortOrder ?? 100,
      ts,
      ts,
    )
  }

  return {
    async list(projectId) {
      const rows = (
        projectId === null
          ? db
              .prepare(`${SELECT_PRESET} WHERE project_id IS NULL ORDER BY sort_order ASC, created_at ASC`)
              .all()
          : db
              .prepare(
                `${SELECT_PRESET} WHERE project_id IS NULL OR project_id = ?
                  ORDER BY sort_order ASC, created_at ASC`,
              )
              .all(projectId)
      ) as PresetRow[]
      return rows.map(presetFromRow)
    },

    async get(id) {
      const row = db.prepare(`${SELECT_PRESET} WHERE id = ?`).get(id) as PresetRow | undefined
      return row ? presetFromRow(row) : null
    },

    async create(input) {
      const id = newId()
      insertOne(input, id, now())
      return readOne(id)
    },

    async update(id, patch) {
      const cur = readOne(id)
      if (cur.builtin) {
        throw new AppError('PERMISSION_DENIED', {
          details: { op: 'preset:update', reason: 'builtin-readonly', id, hint: '内置预设不可编辑，请另存为副本' },
        })
      }
      const next = {
        projectId: patch.projectId !== undefined ? patch.projectId : cur.projectId,
        name: patch.name ?? cur.name,
        description: patch.description !== undefined ? patch.description : cur.description,
        chain: patch.chain !== undefined ? cloneChain(patch.chain) : cur.chain,
        tags: patch.tags ?? cur.tags,
        sortOrder: patch.sortOrder ?? cur.sortOrder,
      }
      db.prepare(
        `UPDATE process_presets
            SET project_id = ?, name = ?, description = ?, chain = ?, tags = ?, sort_order = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        next.projectId,
        next.name,
        next.description,
        JSON.stringify(next.chain),
        JSON.stringify(next.tags),
        next.sortOrder,
        now(),
        id,
      )
      return readOne(id)
    },

    async remove(id) {
      const row = db.prepare(`SELECT builtin FROM process_presets WHERE id = ?`).get(id) as
        | { builtin: number }
        | undefined
      if (!row) return false
      if (row.builtin === 1) {
        throw new AppError('PERMISSION_DENIED', {
          details: { op: 'preset:delete', reason: 'builtin-readonly', id, hint: '内置预设不可删除' },
        })
      }
      const r = db.prepare(`DELETE FROM process_presets WHERE id = ?`).run(id) as { changes?: number }
      return (r.changes ?? 0) > 0
    },

    async createMany(inputs) {
      const ts = now()
      const ids: Id[] = []
      for (const input of inputs) {
        const id = newId()
        insertOne(input, id, ts)
        ids.push(id)
      }
      return ids.map(readOne)
    },
  }
}
