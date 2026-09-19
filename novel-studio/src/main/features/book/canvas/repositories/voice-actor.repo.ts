/**
 * Novel Studio · 配音员仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §4   `voice_actors` / `character_voice_bindings`
 *   · docs/11 §6.1 「一个配音员可担任多个角色；一个角色可有主配音员 + 备选」
 *   · docs/11 §6.1 「分工视图：按配音员汇总行数/字数/预估时长，用于均衡分配」
 *
 * ### 为什么绑定（binding）也归这个仓储
 *   绑定是「角色 ↔ 配音员」的关系，两边都不是它的所有者；把它放在任一侧都会让
 *   另一侧的实现跟着变。放在这里，`character:merge` 之类的操作就不需要关心绑定表。
 *
 * ### 删除语义
 *   `voiceActor:delete` 是**物理删除**（表里没有软删除列，契约也没有回收站）。
 *   它**不会**碰画本行 —— 角色（character）仍然在，只是不再有配音员。
 *   与「角色禁止物理删除」（docs/11 §4.6）不冲突：角色被台词引用，配音员不被内容引用。
 *
 * 零第三方依赖：内存实现是**行为基准**（乐观的 SQLite 实现要与它逐条一致）。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { ActorWorkload, Id, Timestamp, VoiceActor } from '../../../../../shared/types.ts'

// ============================================================================
// 类型
// ============================================================================

/** 角色 ↔ 配音员绑定（对应 `character_voice_bindings` 一行） */
export interface CharacterBinding {
  characterId: Id
  actorId: Id
  isPrimary: boolean
}

/** 分工负载的原始输入：某角色有多少行、多少字、多少已录（毫秒） */
export interface WorkloadLineInput {
  characterId: Id | null
  /** 可读字数（标点不计，调方用 `countReadableChars` 算好） */
  chars: number
  recordedMs?: number | null
}

export interface VoiceActorRepo {
  listByProject(projectId: Id): Promise<VoiceActor[]>
  get(actorId: Id): Promise<VoiceActor | null>
  /** 插入或更新（按 id）；`createdAt` 保留原值 */
  upsert(actor: VoiceActor): Promise<VoiceActor>
  /**
   * 物理删除（连带解除绑定，`ON DELETE CASCADE`），返回删除的绑定数。
   *
   * 为什么返回绑定数：调用方（服务层）要把它写进日志 ——
   * 「删掉一个配音员顺带解除了 3 个角色绑定」是用户事后会问的事。
   */
  remove(actorId: Id): Promise<{ deletedBindings: number }>

  /** 绑定（`isPrimary=true` 时把该角色的其它主绑定降级为备选） */
  bind(characterId: Id, actorId: Id, isPrimary?: boolean): Promise<CharacterBinding>
  /** 解绑；返回是否真的删掉了一行 */
  unbind(characterId: Id, actorId: Id): Promise<boolean>
  /**
   * 给定角色集合的全部绑定（`voiceActor:bindings { bookId }` 的实现路径：
   * 服务层先取该书的角色 id，再问这里）。
   *
   * 为什么不直接收 `bookId`：角色→书 的归属是**角色仓储**的事，
   * 让配音员仓储去 join `characters` 会把两个仓储的职责揉在一起，
   * 也会让内存实现被迫依赖「调用方先塞了角色」这种隐性前提。
   */
  listBindings(characterIds: readonly Id[]): Promise<CharacterBinding[]>
  /**
   * 把某角色的全部绑定改挂到另一个角色（**角色合并**用），返回迁移的绑定数。
   *
   * 为什么必须有它：合并会把源角色归档，而归档角色的绑定在界面上看不见 ——
   * 不迁绑定的话，用户会看到「合并之后配音员凭空消失」（数据还在，但没人找得到）。
   *
   * 冲突处理：目标角色已经有**主**绑定时，迁过来的绑定一律降级为**备选** ——
   * 「一个角色只有一个主配音员」这条不变式优先于「保留源的主次标记」。
   */
  rebindCharacter(fromCharacterId: Id, toCharacterId: Id): Promise<number>
  /** 某角色的绑定（主绑定在前） */
  listBindingsByCharacter(characterId: Id): Promise<CharacterBinding[]>
}

// ============================================================================
// 内存实现
// ============================================================================

export function createMemoryVoiceActorRepo(seed?: {
  actors?: VoiceActor[]
  bindings?: CharacterBinding[]
  now?: () => Timestamp
}): VoiceActorRepo {
  const actors = new Map<Id, VoiceActor>()
  /** `${characterId}::${actorId}` → 绑定 */
  const bindings = new Map<string, CharacterBinding>()
  const now = seed?.now ?? (() => Date.now())
  const key = (characterId: Id, actorId: Id): string => `${characterId}::${actorId}`

  for (const a of seed?.actors ?? []) actors.set(a.id, cloneActor(a))
  for (const b of seed?.bindings ?? []) bindings.set(key(b.characterId, b.actorId), { ...b })

  /** 主绑定在前，其次按 actorId（保证顺序确定，测试可断言） */
  const sortBindings = (list: CharacterBinding[]): CharacterBinding[] =>
    [...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.actorId.localeCompare(b.actorId))

  return {
    async listByProject(projectId) {
      return [...actors.values()]
        .filter((a) => a.projectId === projectId)
        .map(cloneActor)
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
    },

    async get(actorId) {
      const a = actors.get(actorId)
      return a ? cloneActor(a) : null
    },

    async upsert(actor) {
      const exists = actors.get(actor.id)
      const next: VoiceActor = {
        ...cloneActor(actor),
        createdAt: exists?.createdAt ?? actor.createdAt ?? now(),
        updatedAt: now(),
      }
      actors.set(next.id, next)
      return cloneActor(next)
    },

    async remove(actorId) {
      if (!actors.has(actorId)) {
        throw new AppError('NOT_FOUND', { details: { entity: 'voice_actor', actorId } })
      }
      let deletedBindings = 0
      for (const [k, b] of bindings) {
        if (b.actorId !== actorId) continue
        bindings.delete(k)
        deletedBindings++
      }
      actors.delete(actorId)
      return { deletedBindings }
    },

    async bind(characterId, actorId, isPrimary = false) {
      if (!actors.has(actorId)) {
        throw new AppError('NOT_FOUND', { details: { entity: 'voice_actor', actorId } })
      }
      // 一个角色只有一个「主配音员」：新的主绑定把旧的降级（docs/11 §6.1「主 + 备选」）
      if (isPrimary) {
        for (const [k, b] of bindings) {
          if (b.characterId === characterId && b.isPrimary) bindings.set(k, { ...b, isPrimary: false })
        }
      }
      const next: CharacterBinding = { characterId, actorId, isPrimary }
      bindings.set(key(characterId, actorId), next)
      return { ...next }
    },

    async unbind(characterId, actorId) {
      return bindings.delete(key(characterId, actorId))
    },

    async listBindings(characterIds) {
      const wanted = new Set(characterIds)
      return sortBindings([...bindings.values()].filter((b) => wanted.has(b.characterId))).map((b) => ({ ...b }))
    },

    async rebindCharacter(fromCharacterId, toCharacterId) {
      if (fromCharacterId === toCharacterId) return 0
      const targetHasPrimary = [...bindings.values()].some((b) => b.characterId === toCharacterId && b.isPrimary)
      let moved = 0
      for (const [k, b] of [...bindings]) {
        if (b.characterId !== fromCharacterId) continue
        bindings.delete(k)
        const nextKey = key(toCharacterId, b.actorId)
        const existing = bindings.get(nextKey)
        // 目标角色已经绑了同一个配音员：保留目标那条（并集语义：主绑定优先）
        if (existing) {
          if (b.isPrimary && !targetHasPrimary) bindings.set(nextKey, { ...existing, isPrimary: true })
        } else {
          bindings.set(nextKey, {
            characterId: toCharacterId,
            actorId: b.actorId,
            isPrimary: b.isPrimary && !targetHasPrimary,
          })
        }
        moved++
      }
      return moved
    },

    async listBindingsByCharacter(characterId) {
      return sortBindings([...bindings.values()].filter((b) => b.characterId === characterId)).map((b) => ({ ...b }))
    },
  }
}

function cloneActor(a: VoiceActor): VoiceActor {
  return {
    ...a,
    profile: a.profile
      ? {
          ...a.profile,
          pitchRange: a.profile.pitchRange
            ? ([a.profile.pitchRange[0], a.profile.pitchRange[1]] as [number, number])
            : null,
        }
      : null,
  }
}

// ============================================================================
// 分工负载（纯计算，两个实现共用）
// ============================================================================

/**
 * 按配音员汇总工作量（docs/11 §6.1「分工视图」）。
 *
 * 口径（必须与角色出场统计一致，否则两个面板的数字对不上）：
 *   · `lines` / `chars` 只算**台词行**（`kind='dialogue'` 才算「要录的词」），
 *     但调用方传进来的行已经按角色过滤过，所以这里只按角色累加；
 *   · 一个角色绑多个配音员时，**每个配音员都算全额**（备选也要能录 ——
 *     这不是「分摊」，而是「任选其一都能完成」的工作量视图）；
 *   · `recordedCount` 计已录行数（有实际时长的行）。
 */
export function buildActorWorkload(input: {
  actors: readonly VoiceActor[]
  bindings: readonly CharacterBinding[]
  lines: readonly WorkloadLineInput[]
  /** 字/秒（默认 4.2，与 `VAD_DEFAULTS.charsPerSecond` 一致） */
  charsPerSecond?: number
}): ActorWorkload[] {
  const byCharacter = new Map<Id, { lines: number; chars: number; recordedMs: number; recordedCount: number }>()
  for (const l of input.lines) {
    if (l.characterId == null) continue
    const cur = byCharacter.get(l.characterId) ?? { lines: 0, chars: 0, recordedMs: 0, recordedCount: 0 }
    cur.lines++
    cur.chars += Math.max(0, l.chars)
    const ms = Math.max(0, l.recordedMs ?? 0)
    cur.recordedMs += ms
    if (ms > 0) cur.recordedCount++
    byCharacter.set(l.characterId, cur)
  }

  const charsPerSecond = input.charsPerSecond && input.charsPerSecond > 0 ? input.charsPerSecond : 4.2
  const actorIds = new Set(input.actors.map((a) => a.id))
  const totals = new Map<Id, ActorWorkload>()
  for (const a of input.actors) {
    totals.set(a.id, { actorId: a.id, name: a.name, lines: 0, chars: 0, estimatedDurationMs: 0, recordedCount: 0 })
  }

  for (const [characterId, c] of byCharacter) {
    for (const b of input.bindings) {
      if (b.characterId !== characterId) continue
      if (!actorIds.has(b.actorId)) continue // 绑到了别的项目的配音员：忽略（不该发生）
      const cur = totals.get(b.actorId)!
      cur.lines += c.lines
      cur.chars += c.chars
      cur.recordedCount += c.recordedCount
    }
  }

  const out = [...totals.values()].map((t) => ({
    ...t,
    estimatedDurationMs: Math.round((t.chars / charsPerSecond) * 1000),
  }))
  // 负载高的排前面（均衡分配时先看「谁最重」）
  return out.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))
}
