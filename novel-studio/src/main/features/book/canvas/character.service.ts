/**
 * Novel Studio · 角色与配音员服务（`character:*` / `voiceActor:*`，共 14 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/11 §4.6  角色表：禁止物理删除（只归档）、合并（含别名冲突）、出场统计、原型重建
 *   · docs/11 §6.1  配音员：主 / 备绑定、分工视图（行数/字数/预估时长）
 *   · docs/06 §8    「角色表为空时先跑抽取生成候选，提示用户确认后再判定」
 *   · docs/20 §4.4  14 个通道的请求/响应契约
 *
 * ### 这一层做什么、不做什么
 *   **纯逻辑全在 `src/shared/canvas/character.ts` 里**（抽取、别名冲突、合并、统计），
 *   本文件只做「读仓储 → 调纯函数 → 写仓储 → 组织返回值」这件编排的事。
 *   这样做的收益已经在本仓库反复出现：纯函数能被快速穷举测试，
 *   而编排层的错误几乎全是「读错了表 / 写错了顺序 / 忘了某个副作用」。
 *
 * ### 三个刻意的取舍（都记在 docs/91）
 *   1. **合并按「先迁移台词、再写角色、最后归档源」执行**：`batchUpdate` 自己开事务
 *      （SQLite 不支持嵌套 BEGIN），所以这里**不能**把它们裹进一个大事务。
 *      中断的后果是「台词已迁移但源角色还没归档」——可重做，且不会丢数据。
 *   2. **合并时源角色的配音员绑定会迁移到目标角色**（否则绑定随源角色一起被归档，
 *      用户在界面上会看到「配音员凭空消失」）。
 *   3. **`character:extract` 会剔除已存在的角色/别名**：那些候选项在界面上点了也只会
 *      no-op（`characters.store.addCandidate` 会直接返回已存在的角色），留着反而让人以为没生效。
 */

import { AppError } from '../../../../shared/errors.ts'
import type {
  ActorWorkload,
  Chapter,
  Character,
  CharacterCandidate,
  CharacterStats,
  Id,
  Timestamp,
  VoiceActor,
} from '../../../../shared/types.ts'
import {
  archiveCharacter,
  buildCharacterStats,
  createCharacter,
  extractCharacterCandidates,
  mergeCharacters as mergeCharactersPure,
} from '../../../../shared/canvas/character.ts'
import { countReadableChars } from '../../../../shared/canvas/attribution.ts'
import { dropUndefined } from '../../../../shared/util/drop-undefined.ts'
import type { TaskQueue } from '../../../infra/queue/queue.ts'
import type { Logger } from '../../../infra/log/index.ts'
import type { CanvasRepo } from './repositories/canvas.repo.ts'
import type { CharacterRepo } from './repositories/character.repo.ts'
import type { VoiceActorRepo } from './repositories/voice-actor.repo.ts'
import { buildActorWorkload, type CharacterBinding } from './repositories/voice-actor.repo.ts'

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

/** 章节文本来源（`character:extract` 用；只依赖两个方法，便于注入假实现） */
export interface ChapterSource {
  listByBook(bookId: Id): Promise<Chapter[]>
  getText(chapterId: Id): Promise<{ rawText: string; text: string } | null>
}

export interface CharacterRepos {
  characters: CharacterRepo
  actors: VoiceActorRepo
  canvas: CanvasRepo
}

export interface CharacterServiceDeps {
  /** **每次调用现取**仓储：库可能在「从备份恢复」后被换成新连接 */
  repo: () => CharacterRepos
  chapters: ChapterSource
  /**
   * 某本书所属项目的全部配音员。
   *
   * 为什么要「全量」而不是只用已绑定的那些：分工视图的意义是**均衡分配**
   * （docs/11 §6.1「避免某人 5000 字、某人 200 字」），一个 0 字的配音员
   * 恰恰是最该被分配的人 —— 只显示有绑定的人会把这张表变成残表。
   */
  listProjectActors: (bookId: Id) => Promise<VoiceActor[]>
  /** 任务队列（`character:rebuildCentroid` 要入队；不传则抛 TASK_QUEUE_UNAVAILABLE） */
  queue?: TaskQueue
  newId?: (prefix: string) => Id
  now?: () => Timestamp
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface CharacterUpsertInput {
  id?: Id
  bookId: Id
  name: string
  aliases?: string[]
  gender?: Character['gender']
  ageGroup?: Character['ageGroup']
  description?: string | null
  note?: string | null
  color?: string | null
  defaultSpeed?: Character['defaultSpeed']
  defaultEmotion?: string | null
  defaultGainDb?: number | null
  defaultPauseMs?: number | null
  isArchived?: boolean
  sortOrder?: number
}

export interface VoiceActorUpsertInput {
  id?: Id
  projectId: Id
  name: string
  contact?: string | null
  note?: string | null
  profile?: VoiceActor['profile']
}

export interface MergeResult {
  movedLines: number
  mergedAliases: string[]
  conflicts: string[]
}

export interface CharacterService {
  list(bookId: Id, opts?: { includeArchived?: boolean }): Promise<Character[]>
  upsertCharacter(input: CharacterUpsertInput): Promise<Character>
  merge(targetId: Id, sourceIds: readonly Id[], keepAliases?: boolean): Promise<MergeResult>
  archive(characterId: Id, archived: boolean): Promise<{ ok: boolean }>
  extract(bookId: Id, chapterIds?: readonly Id[]): Promise<CharacterCandidate[]>
  stats(characterId: Id): Promise<CharacterStats>
  rebuildCentroid(bookId: Id, characterIds?: readonly Id[]): Promise<{ taskId: Id }>

  listActors(projectId: Id): Promise<VoiceActor[]>
  upsertActor(input: VoiceActorUpsertInput): Promise<VoiceActor>
  removeActor(actorId: Id): Promise<{ ok: boolean }>
  bind(characterId: Id, actorId: Id, isPrimary?: boolean): Promise<{ ok: boolean }>
  unbind(characterId: Id, actorId: Id): Promise<{ ok: boolean }>
  listBindings(bookId: Id): Promise<CharacterBinding[]>
  workload(bookId: Id): Promise<ActorWorkload[]>
}

/**
 * `character:extract` 一次最多读入的正文字数。
 *
 * 为什么要有上限：契约允许只给 `bookId`（不限定章节），而真机上存在 412 章的书 ——
 * 全量拼接会在主进程里造出一个几十 MB 的字符串，抽取本身是 O(字数) 的字符扫描，
 * 用户点一下「抽取候选」就要等很久且没有任何进度反馈。截断 + 记日志比卡死好。
 */
export const MAX_EXTRACT_CHARS = 2_000_000

// ---------------------------------------------------------------------------

export function createCharacterService(deps: CharacterServiceDeps): CharacterService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`)
  const now = deps.now ?? (() => Date.now())
  const log = deps.log

  function requireQueue(): TaskQueue {
    if (!deps.queue) {
      throw new AppError('TASK_QUEUE_UNAVAILABLE', { details: { reason: 'character-queue-unavailable' } })
    }
    return deps.queue
  }

  async function requireCharacter(characterId: Id): Promise<Character> {
    const c = await deps.repo().characters.get(characterId)
    if (!c) throw new AppError('NOT_FOUND', { details: { entity: 'character', characterId } })
    return c
  }

  return {
    // ── 角色 ───────────────────────────────────────────────────────────────
    async list(bookId, opts) {
      return deps.repo().characters.listByBook(bookId, opts)
    },

    async upsertCharacter(input) {
      const repo = deps.repo().characters
      const name = (input.name ?? '').trim()
      if (name.length === 0) {
        // 名字是角色的唯一标识（判定、别名、绑定都靠它），空名字必须挡住
        throw new AppError('INVALID_PAYLOAD', { details: { op: 'character:upsert', reason: 'name-empty' } })
      }
      const existing = input.id ? await repo.get(input.id) : null
      if (existing && existing.bookId !== input.bookId) {
        // 不允许把角色挪到别的书：画本行的 (chapter_id, book_id) 是两列，
        // 改了角色所属书会让「角色 → 它的行」这条链跨书，判定与统计都会错
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'character:upsert',
            reason: 'book-mismatch',
            characterId: existing.id,
            expected: existing.bookId,
            got: input.bookId,
          },
        })
      }

      const base =
        existing ??
        createCharacter({ id: input.id ?? newId('ch'), bookId: input.bookId, name, now: now() })
      // 只应用**真正给出**的键：请求经过 IPC 校验器后，没给的可选键也在（值为 undefined）
      const patch = dropUndefined(input as unknown as Record<string, unknown>) as Partial<CharacterUpsertInput>
      const next: Character = {
        ...base,
        ...(patch.gender !== undefined ? { gender: patch.gender ?? null } : {}),
        ...(patch.ageGroup !== undefined ? { ageGroup: patch.ageGroup ?? null } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        ...(patch.note !== undefined ? { note: patch.note ?? null } : {}),
        ...(patch.color !== undefined ? { color: patch.color ?? null } : {}),
        ...(patch.defaultSpeed !== undefined ? { defaultSpeed: patch.defaultSpeed ?? null } : {}),
        ...(patch.defaultEmotion !== undefined ? { defaultEmotion: patch.defaultEmotion ?? null } : {}),
        ...(patch.defaultGainDb !== undefined ? { defaultGainDb: patch.defaultGainDb ?? null } : {}),
        ...(patch.defaultPauseMs !== undefined ? { defaultPauseMs: patch.defaultPauseMs ?? null } : {}),
        ...(patch.isArchived !== undefined ? { isArchived: patch.isArchived } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.aliases !== undefined ? { aliases: patch.aliases ?? [] } : {}),
        name,
        // id / bookId / createdAt 由 base 决定，不接受入参覆盖
      }
      const saved = await repo.upsert(next)
      log?.info?.('character.upserted', {
        event: 'character.upserted',
        characterId: saved.id,
        created: existing === null,
        aliases: saved.aliases.length,
      })
      return saved
    },

    async merge(targetId, sourceIds, keepAliases) {
      const { characters, actors, canvas } = deps.repo()
      const target = await requireCharacter(targetId)

      // 去重 + 剔除自己：契约没禁止把 target 也放进 sourceIds，
      // 而「把自己合并到自己」是纯错误，不该让它走到纯函数里只报个冲突就完事
      const unique = [...new Set(sourceIds)].filter((id) => id !== targetId)
      if (unique.length === 0) {
        throw new AppError('INVALID_PAYLOAD', { details: { op: 'character:merge', reason: 'no-source' } })
      }
      const sources: Character[] = []
      for (const id of unique) {
        const c = await characters.get(id)
        if (!c) throw new AppError('NOT_FOUND', { details: { entity: 'character', characterId: id } })
        sources.push(c)
      }

      const all = await characters.listByBook(target.bookId, { includeArchived: true })
      // 只取源角色名下的行：`mergeCharacters` 只用它们生成补丁（见纯函数注释）
      const lineGroups = await Promise.all(sources.map((s) => canvas.listByCharacter(s.id)))
      const lines = lineGroups.flat().map((l) => ({ id: l.id, characterId: l.characterId }))

      const result = mergeCharactersPure({
        target,
        sources,
        lines,
        ...(keepAliases !== undefined ? { keepAliases } : {}),
        allCharacters: all,
        now: now(),
      })

      // ① 迁移台词（补丁里带 `decidedBy='human'`：合并是人工动作，重算不得覆盖）
      if (result.linePatches.length > 0) await canvas.batchUpdate(result.linePatches)
      // ② 目标角色（含合并进来的别名）
      await characters.upsert(result.target)
      // ③ 源角色归档（不物理删除：既有引用要能恢复）
      for (const id of result.archivedSourceIds) {
        await characters.setArchived(id, true)
        // ④ 绑定迁移：否则「配音员」会随源角色一起被归档到看不见的地方
        const moved = await actors.rebindCharacter(id, targetId)
        if (moved > 0) {
          log?.info?.('character.merge.bindingsMoved', {
            event: 'character.merge.bindingsMoved',
            from: id,
            to: targetId,
            moved,
          })
        }
      }

      const out: MergeResult = {
        movedLines: result.movedLines,
        mergedAliases: result.mergedAliases,
        conflicts: result.conflicts.map((c) => c.message),
      }
      log?.info?.('character.merged', {
        event: 'character.merged',
        targetId,
        sources: result.archivedSourceIds,
        movedLines: out.movedLines,
        mergedAliases: out.mergedAliases,
        conflicts: out.conflicts.length,
      })
      return out
    },

    async archive(characterId, archived) {
      const repo = deps.repo().characters
      const current = await requireCharacter(characterId)
      const next = archiveCharacter(current, archived, now())
      await repo.upsert(next)
      log?.info?.('character.archived', { event: 'character.archived', characterId, archived })
      return { ok: true }
    },

    async extract(bookId, chapterIds) {
      const { characters } = deps.repo()
      const all = await deps.chapters.listByBook(bookId)
      const wanted = chapterIds && chapterIds.length > 0 ? new Set(chapterIds) : null
      const list = (wanted ? all.filter((c) => wanted.has(c.id)) : all).sort((a, b) => a.seq - b.seq)

      let text = ''
      let truncated = false
      /** 逐章保存 {标题, 正文}：抽取后要用它算「每个候选**首次**出现在哪一章」 */
      const perChapter: Array<{ title: string; text: string }> = []
      for (const chapter of list) {
        const body = (await deps.chapters.getText(chapter.id))?.text ?? ''
        if (text.length + body.length > MAX_EXTRACT_CHARS) {
          const kept = body.slice(0, Math.max(0, MAX_EXTRACT_CHARS - text.length))
          text += kept
          perChapter.push({ title: chapter.title, text: kept })
          truncated = true
          break
        }
        text += `\n${body}`
        perChapter.push({ title: chapter.title, text: body })
      }
      if (truncated) {
        log?.warn?.('character.extract.truncated', {
          event: 'character.extract.truncated',
          bookId,
          chapters: list.length,
          maxChars: MAX_EXTRACT_CHARS,
        })
      }

      const candidates = extractCharacterCandidates(text, { chapterTitle: perChapter[0]?.title ?? null })
      /**
       * `firstChapterTitle` 必须真的是**首次出现的那一章**。
       *
       * 真机问题：以前整本书抽取时把「第一章的标题」写给了所有候选，
       * 于是界面上每个候选都显示「首见《第一章 丧尸星》」—— 用户据此判断「这个名字是不是主角」时会误判。
       * 做法：按章顺序扫，给还没定位到的候选找第一次出现，全部定位到就提前结束。
       */
      const unresolved = new Map(candidates.map((c) => [c.name, c]))
      for (const chapter of perChapter) {
        if (unresolved.size === 0) break
        for (const [name, cand] of [...unresolved]) {
          if (chapter.text.includes(name)) {
            cand.firstChapterTitle = chapter.title
            unresolved.delete(name)
          }
        }
      }
      // 截断语料里仍然找不到的（理论上不会发生）保留第一章标题，至少不是 null
      // 已经有同名角色/别名的候选剔掉（点了也是 no-op，留着只会让人以为没生效）
      const known = new Set<string>()
      for (const c of await characters.listByBook(bookId, { includeArchived: true })) {
        known.add(c.name)
        for (const a of c.aliases) known.add(a)
      }
      const fresh = candidates.filter((c) => !known.has(c.name) && !c.aliases.some((a) => known.has(a)))
      log?.info?.('character.extracted', {
        event: 'character.extracted',
        bookId,
        chapters: list.length,
        chars: text.length,
        candidates: candidates.length,
        fresh: fresh.length,
      })
      return fresh
    },

    async stats(characterId) {
      await requireCharacter(characterId)
      const lines = await deps.repo().canvas.listByCharacter(characterId)
      // `recordedMs` 传 null：录音域还没落地（takes/voice_segments 没有写入路径），
      // 所以「已录时长」如实为 0，而不是拿估算时长冒充（docs/12 实现后再接上）
      return buildCharacterStats(
        characterId,
        lines.map((l) => ({ characterId: l.characterId, text: l.text, recordedMs: null })),
      )
    },

    async rebuildCentroid(bookId, characterIds) {
      const queue = requireQueue()
      const list = await deps.repo().characters.listByBook(bookId, { includeArchived: false })
      const ids = characterIds && characterIds.length > 0 ? [...characterIds] : list.map((c) => c.id)
      const known = new Set(list.map((c) => c.id))
      for (const id of ids) {
        if (!known.has(id)) throw new AppError('NOT_FOUND', { details: { entity: 'character', characterId: id } })
      }
      const res = await queue.enqueue(
        'character.centroid',
        { bookId, characterIds: ids },
        { priority: 0, projectId: bookId },
      )
      log?.info?.('character.centroid.enqueued', {
        event: 'character.centroid.enqueued',
        taskId: res.taskId,
        bookId,
        characters: ids.length,
      })
      return { taskId: res.taskId }
    },

    // ── 配音员 ─────────────────────────────────────────────────────────────
    async listActors(projectId) {
      return deps.repo().actors.listByProject(projectId)
    },

    async upsertActor(input) {
      const repo = deps.repo().actors
      const name = (input.name ?? '').trim()
      if (name.length === 0) {
        throw new AppError('INVALID_PAYLOAD', { details: { op: 'voiceActor:upsert', reason: 'name-empty' } })
      }
      const existing = input.id ? await repo.get(input.id) : null
      const base: VoiceActor =
        existing ?? {
          id: input.id ?? newId('va'),
          projectId: input.projectId,
          name,
          contact: null,
          note: null,
          profile: null,
          createdAt: now(),
          updatedAt: now(),
        }
      const patch = dropUndefined(input as unknown as Record<string, unknown>) as Partial<VoiceActorUpsertInput>
      const next: VoiceActor = {
        ...base,
        ...(patch.contact !== undefined ? { contact: patch.contact ?? null } : {}),
        ...(patch.note !== undefined ? { note: patch.note ?? null } : {}),
        // `profile` 用 `in` 判断：显式传 `null` 表示「清掉音色档案」，与「没给」不同
        ...(patch.profile !== undefined ? { profile: patch.profile ?? null } : {}),
        name,
      }
      const saved = await repo.upsert(next)
      log?.info?.('voiceActor.upserted', {
        event: 'voiceActor.upserted',
        actorId: saved.id,
        created: existing === null,
      })
      return saved
    },

    async removeActor(actorId) {
      const { deletedBindings } = await deps.repo().actors.remove(actorId)
      log?.warn?.('voiceActor.removed', {
        event: 'voiceActor.removed',
        actorId,
        deletedBindings,
        note: '物理删除；画本行不受影响，只是角色不再有配音员',
      })
      return { ok: true }
    },

    async bind(characterId, actorId, isPrimary) {
      await requireCharacter(characterId) // 角色不存在时明确报 NOT_FOUND（外键也会拦，但错误更难懂）
      await deps.repo().actors.bind(characterId, actorId, isPrimary ?? false)
      return { ok: true }
    },

    async unbind(characterId, actorId) {
      const ok = await deps.repo().actors.unbind(characterId, actorId)
      return { ok }
    },

    async listBindings(bookId) {
      const { characters, actors } = deps.repo()
      // includeArchived=true：归档角色的绑定仍要返回，否则界面会把「已归档」与「没绑定」混为一谈
      const list = await characters.listByBook(bookId, { includeArchived: true })
      return actors.listBindings(list.map((c) => c.id))
    },

    async workload(bookId) {
      const { characters, actors, canvas } = deps.repo()
      const list = await characters.listByBook(bookId, { includeArchived: true })
      const bindings = await actors.listBindings(list.map((c) => c.id))
      const actorList = await deps.listProjectActors(bookId)

      const lines: Array<{ characterId: Id | null; chars: number; recordedMs: number | null }> = []
      for (const c of list) {
        for (const line of await canvas.listByCharacter(c.id)) {
          lines.push({ characterId: c.id, chars: countReadableChars(line.text), recordedMs: null })
        }
      }
      return buildActorWorkload({ actors: actorList, bindings, lines })
    },
  }
}
