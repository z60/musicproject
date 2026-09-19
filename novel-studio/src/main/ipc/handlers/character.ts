/**
 * Novel Studio · IPC handler · 角色与配音员域（`character:*` / `voiceActor:*`）
 * ============================================================================
 * 设计依据：docs/20 §4.4（14 个通道）、docs/11 §4.6 / §6.1、docs/06 §8
 *
 * 与 `handlers/canvas.ts` 同一套纪律：
 *   1. **载荷校验在注册层**（`IPC_REQ_SCHEMAS`）；跨字段的业务边界在这里或服务层挡。
 *   2. **逻辑在服务层**：纯算法在 `src/shared/canvas/character.ts`，
 *      编排在 `features/book/canvas/character.service.ts`，这里只做「转成契约形状」。
 *   3. **按当前 db 现取仓储**（服务层拿到的是 `repo()` 工厂）。
 *
 * ⚠️ 这一层最容易犯的错是**把 undefined 当「用户给了」**：请求经过校验器后，
 *   没给的可选键也在（值是 `undefined`）。所以凡是「给了才覆盖」的字段，
 *   判断都必须看**值**（服务层用 `dropUndefined` 统一处理）。
 */

import type { CharacterService, CharacterUpsertInput, VoiceActorUpsertInput } from '../../features/book/canvas/character.service.ts'
import { h, type RegisteredHandler } from './deps.ts'

export interface CharacterHandlerDeps {
  service: CharacterService
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createCharacterHandlers(deps: CharacterHandlerDeps): RegisteredHandler[] {
  /** 服务层用到的可选字段一律「有值才传」，避免 undefined 被当成「显式清空」 */
  function characterInput(req: {
    character: Partial<CharacterUpsertInput> & { bookId: string; name: string }
  }): CharacterUpsertInput {
    const c = req.character
    return {
      ...(c.id !== undefined ? { id: c.id } : {}),
      bookId: c.bookId,
      name: c.name,
      ...(c.aliases !== undefined ? { aliases: c.aliases } : {}),
      ...(c.gender !== undefined ? { gender: c.gender ?? null } : {}),
      ...(c.ageGroup !== undefined ? { ageGroup: c.ageGroup ?? null } : {}),
      ...(c.description !== undefined ? { description: c.description ?? null } : {}),
      ...(c.note !== undefined ? { note: c.note ?? null } : {}),
      ...(c.color !== undefined ? { color: c.color ?? null } : {}),
      ...(c.defaultSpeed !== undefined ? { defaultSpeed: c.defaultSpeed ?? null } : {}),
      ...(c.defaultEmotion !== undefined ? { defaultEmotion: c.defaultEmotion ?? null } : {}),
      ...(c.defaultGainDb !== undefined ? { defaultGainDb: c.defaultGainDb ?? null } : {}),
      ...(c.defaultPauseMs !== undefined ? { defaultPauseMs: c.defaultPauseMs ?? null } : {}),
      ...(c.isArchived !== undefined ? { isArchived: c.isArchived } : {}),
      ...(c.sortOrder !== undefined ? { sortOrder: c.sortOrder } : {}),
    }
  }

  return [
    // ── 角色 ───────────────────────────────────────────────────────────────
    h('character:list', async (req) => {
      return deps.service.list(req.bookId, req.includeArchived !== undefined ? { includeArchived: req.includeArchived } : {})
    }),

    h('character:upsert', async (req) => deps.service.upsertCharacter(characterInput(req))),

    h('character:merge', async (req) => {
      // `sourceIds` 里混进 targetId 是纯错误；服务层会剔除并拒绝「没有有效源」的情况
      return deps.service.merge(req.targetId, req.sourceIds, req.keepAliases)
    }),

    h('character:archive', async (req) => deps.service.archive(req.characterId, req.archived)),

    h('character:extract', async (req) => {
      return deps.service.extract(req.bookId, req.chapterIds)
    }),

    h('character:stats', async (req) => deps.service.stats(req.characterId)),

    h('character:rebuildCentroid', async (req) => {
      return deps.service.rebuildCentroid(req.bookId, req.characterIds)
    }),

    // ── 配音员 ─────────────────────────────────────────────────────────────
    h('voiceActor:list', async (req) => deps.service.listActors(req.projectId)),

    h('voiceActor:upsert', async (req) => {
      const a = req.actor as Partial<VoiceActorUpsertInput> & { projectId: string; name: string }
      const input: VoiceActorUpsertInput = {
        ...(a.id !== undefined ? { id: a.id } : {}),
        projectId: a.projectId,
        name: a.name,
        ...(a.contact !== undefined ? { contact: a.contact ?? null } : {}),
        ...(a.note !== undefined ? { note: a.note ?? null } : {}),
        // `profile` 显式传 `null` 与「没给」不同：前者是「清掉音色档案」
        ...(a.profile !== undefined ? { profile: a.profile ?? null } : {}),
      }
      return deps.service.upsertActor(input)
    }),

    h('voiceActor:delete', async (req) => deps.service.removeActor(req.actorId)),

    h('voiceActor:bind', async (req) => {
      return deps.service.bind(req.characterId, req.actorId, req.isPrimary)
    }),

    h('voiceActor:unbind', async (req) => deps.service.unbind(req.characterId, req.actorId)),

    h('voiceActor:workload', async (req) => deps.service.workload(req.bookId)),

    h('voiceActor:bindings', async (req) => {
      const list = await deps.service.listBindings(req.bookId)
      // 契约里 `isPrimary` 是必填的布尔值：仓储返回的就是布尔，这里显式转一次，
      // 免得将来某个实现回传 0/1 时把它漏进 IPC（`0` 会让 UI 的 `if (isPrimary)` 判错）
      return list.map((b) => ({ characterId: b.characterId, actorId: b.actorId, isPrimary: b.isPrimary === true }))
    }),
  ]
}

/**
 * 本域实现的通道名（与上面的数组**一一对应**）。
 *
 * ⚠️ 与 `handlers/index.ts` 的静态表**不能重名**：启动自检（strict）会直接抛错。
 */
export const CHARACTER_CHANNELS: readonly string[] = [
  'character:list',
  'character:upsert',
  'character:merge',
  'character:archive',
  'character:extract',
  'character:stats',
  'character:rebuildCentroid',
  'voiceActor:list',
  'voiceActor:upsert',
  'voiceActor:delete',
  'voiceActor:bind',
  'voiceActor:unbind',
  'voiceActor:workload',
  'voiceActor:bindings',
]
