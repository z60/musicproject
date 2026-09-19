/**
 * Novel Studio · 配音员仓储（SQLite 实现）
 * ============================================================================
 * 设计依据：
 *   · `voice-actor.repo.ts`（接口 + 内存实现）—— 行为基准，本文件把同样的语义翻成 SQL
 *   · docs/21 §4  `voice_actors` / `character_voice_bindings`
 *   · docs/11 §6.1 主/备绑定；分工视图按配音员汇总
 *
 * ### 与内存实现必须一致的三条（都有对应测试）
 *   1. **`profile` 是 JSON 列**：`null` 与「空对象」不同 —— 读回时 `null` 仍是 `null`，
 *      写 `null` 要写 SQL NULL（写成字符串 `'null'` 会让读回变成真值）。
 *   2. **`created_at` 保留原值**：`upsert` 只刷新 `updated_at`。
 *   3. **主绑定的唯一性**：`bind(isPrimary=true)` 要把该角色原有的主绑定降级为备选，
 *      否则一个角色会出现两个「主配音员」（UI 取第一个，用户看到的是随机的那个）。
 *      表上没有「每角色至多一个主绑定」的约束，所以这件事只能由实现负责。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { Id, Timestamp, VoiceActor, VoiceProfile } from '../../../../../shared/types.ts'
import type { DbLike } from '../../../../infra/db/types.ts'
import { withTransactionAsync } from '../../../../infra/db/with-transaction.ts'
import type { CharacterBinding, VoiceActorRepo } from './voice-actor.repo.ts'

interface VoiceActorRow {
  id: string
  project_id: string
  name: string
  contact: string | null
  note: string | null
  profile: string | null
  created_at: number
  updated_at: number
}

interface BindingRow {
  character_id: string
  actor_id: string
  is_primary: number
}

const SELECT_ACTOR = `
  SELECT id, project_id, name, contact, note, profile, created_at, updated_at
    FROM voice_actors
`

const ACTOR_COLUMNS = ['id', 'project_id', 'name', 'contact', 'note', 'profile', 'created_at', 'updated_at'] as const

/** JSON 列 ↔ `VoiceProfile | null`（坏数据退化为 null，不让一行坏 JSON 炸掉整个列表） */
function parseProfile(raw: string | null): VoiceProfile | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const p = parsed as Partial<VoiceProfile>
    return {
      samplePath: p.samplePath ?? null,
      gender: (p.gender ?? 'unknown') as VoiceProfile['gender'],
      pitchRange: Array.isArray(p.pitchRange) && p.pitchRange.length === 2
        ? ([p.pitchRange[0] as number, p.pitchRange[1] as number] as [number, number])
        : null,
      speechRate: typeof p.speechRate === 'number' ? p.speechRate : null,
    }
  } catch {
    return null
  }
}

function actorFromRow(row: VoiceActorRow): VoiceActor {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    contact: row.contact,
    note: row.note,
    profile: parseProfile(row.profile),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function actorToParams(a: VoiceActor): unknown[] {
  return [
    a.id,
    a.projectId,
    a.name,
    a.contact,
    a.note,
    a.profile === null ? null : JSON.stringify(a.profile),
    a.createdAt,
    a.updatedAt,
  ]
}

export function createSqliteVoiceActorRepo(db: DbLike): VoiceActorRepo {
  const now = (): Timestamp => Date.now()

  /** 主绑定在前，其次按 actorId（与内存实现同一个比较器，保证顺序一致） */
  function sortBindings(rows: BindingRow[]): CharacterBinding[] {
    return rows
      .map((r) => ({ characterId: r.character_id, actorId: r.actor_id, isPrimary: r.is_primary === 1 }))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.actorId.localeCompare(b.actorId))
  }

  function upsertImpl(a: VoiceActor): VoiceActor {
    const existing = db.prepare(`SELECT created_at FROM voice_actors WHERE id = ?`).get(a.id) as
      | { created_at: number }
      | undefined
    const next: VoiceActor = {
      ...a,
      createdAt: existing?.created_at ?? a.createdAt ?? now(),
      updatedAt: now(),
    }
    const sets = ACTOR_COLUMNS.map((c) => `${c} = ?`).join(', ')
    db.prepare(
      `INSERT INTO voice_actors (${ACTOR_COLUMNS.join(', ')})
       VALUES (${ACTOR_COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${sets}`,
    ).run(...actorToParams(next), ...actorToParams(next))
    return next
  }

  return {
    async listByProject(projectId: Id): Promise<VoiceActor[]> {
      const rows = db
        .prepare(`${SELECT_ACTOR} WHERE project_id = ?`)
        .all(projectId) as VoiceActorRow[]
      return rows
        .map(actorFromRow)
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
    },

    async get(actorId: Id): Promise<VoiceActor | null> {
      const row = db.prepare(`${SELECT_ACTOR} WHERE id = ?`).get(actorId) as VoiceActorRow | undefined
      return row ? actorFromRow(row) : null
    },

    async upsert(actor: VoiceActor): Promise<VoiceActor> {
      return upsertImpl(actor)
    },

    async remove(actorId: Id): Promise<{ deletedBindings: number }> {
      const exists = db.prepare(`SELECT 1 AS x FROM voice_actors WHERE id = ?`).get(actorId)
      if (!exists) throw new AppError('NOT_FOUND', { details: { entity: 'voice_actor', actorId } })
      return withTransactionAsync(
        db,
        () => {
          const r = db.prepare(`DELETE FROM character_voice_bindings WHERE actor_id = ?`).run(actorId) as {
            changes?: number
          }
          db.prepare(`DELETE FROM voice_actors WHERE id = ?`).run(actorId)
          return { deletedBindings: r.changes ?? 0 }
        },
        { eventPrefix: 'voiceActor.tx' },
      )
    },

    async bind(characterId: Id, actorId: Id, isPrimary = false): Promise<CharacterBinding> {
      const actor = db.prepare(`SELECT 1 AS x FROM voice_actors WHERE id = ?`).get(actorId)
      if (!actor) throw new AppError('NOT_FOUND', { details: { entity: 'voice_actor', actorId } })

      const ts = now()
      return withTransactionAsync(
        db,
        () => {
          // 一个角色只有一个主配音员：先降级旧的，再写新的（见文件头第 3 条）
          if (isPrimary) {
            db.prepare(
              `UPDATE character_voice_bindings SET is_primary = 0
                WHERE character_id = ? AND actor_id <> ?`,
            ).run(characterId, actorId)
          }
          const existing = db
            .prepare(`SELECT id FROM character_voice_bindings WHERE character_id = ? AND actor_id = ?`)
            .get(characterId, actorId) as { id: string } | undefined
          if (existing) {
            db.prepare(`UPDATE character_voice_bindings SET is_primary = ? WHERE id = ?`).run(
              isPrimary ? 1 : 0,
              existing.id,
            )
          } else {
            db.prepare(
              `INSERT INTO character_voice_bindings (id, character_id, actor_id, is_primary, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            ).run(globalThis.crypto.randomUUID(), characterId, actorId, isPrimary ? 1 : 0, ts)
          }
          return { characterId, actorId, isPrimary }
        },
        { eventPrefix: 'voiceActor.tx' },
      )
    },

    async unbind(characterId: Id, actorId: Id): Promise<boolean> {
      const r = db
        .prepare(`DELETE FROM character_voice_bindings WHERE character_id = ? AND actor_id = ?`)
        .run(characterId, actorId) as { changes?: number }
      return (r.changes ?? 0) > 0
    },

    async listBindings(characterIds: readonly Id[]): Promise<CharacterBinding[]> {
      if (characterIds.length === 0) return []
      const ph = characterIds.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT character_id, actor_id, is_primary FROM character_voice_bindings
            WHERE character_id IN (${ph})`,
        )
        .all(...characterIds) as BindingRow[]
      return sortBindings(rows)
    },

    async rebindCharacter(fromCharacterId: Id, toCharacterId: Id): Promise<number> {
      if (fromCharacterId === toCharacterId) return 0
      return withTransactionAsync(
        db,
        () => {
          const targetPrimary = db
            .prepare(`SELECT 1 AS x FROM character_voice_bindings WHERE character_id = ? AND is_primary = 1`)
            .get(toCharacterId)
          const from = db
            .prepare(
              `SELECT actor_id, is_primary FROM character_voice_bindings WHERE character_id = ?`,
            )
            .all(fromCharacterId) as Array<{ actor_id: string; is_primary: number }>
          if (from.length === 0) return 0

          // 先删源（避免 UNIQUE(character_id, actor_id) 冲突），再按冲突规则插入
          db.prepare(`DELETE FROM character_voice_bindings WHERE character_id = ?`).run(fromCharacterId)
          for (const row of from) {
            const exists = db
              .prepare(`SELECT id, is_primary FROM character_voice_bindings WHERE character_id = ? AND actor_id = ?`)
              .get(toCharacterId, row.actor_id) as { id: string; is_primary: number } | undefined
            const wantPrimary = row.is_primary === 1 && targetPrimary === undefined
            if (exists) {
              // 目标已有同一配音员的绑定：只在「目标没有主绑定」时把它升为主
              if (wantPrimary && exists.is_primary !== 1) {
                db.prepare(`UPDATE character_voice_bindings SET is_primary = 1 WHERE id = ?`).run(exists.id)
              }
              continue
            }
            db.prepare(
              `INSERT INTO character_voice_bindings (id, character_id, actor_id, is_primary, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            ).run(globalThis.crypto.randomUUID(), toCharacterId, row.actor_id, wantPrimary ? 1 : 0, now())
          }
          return from.length
        },
        { eventPrefix: 'voiceActor.tx' },
      )
    },

    async listBindingsByCharacter(characterId: Id): Promise<CharacterBinding[]> {
      const rows = db
        .prepare(`SELECT character_id, actor_id, is_primary FROM character_voice_bindings WHERE character_id = ?`)
        .all(characterId) as BindingRow[]
      return sortBindings(rows)
    },
  }
}
