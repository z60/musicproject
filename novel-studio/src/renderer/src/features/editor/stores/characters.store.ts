/**
 * 画本编辑域 · 角色表与配音员绑定（docs/11 §4.6 / §6.1）
 * ============================================================================
 * 职责：
 *   · 角色 CRUD（character:list / upsert / archive）——禁止物理删除，只归档
 *   · 别名管理（别名参与判定，所以改名或删别名后必须提示重算归属）
 *   · 出场统计（character:stats：行数 / 字数 / 预估时长 / 已录时长）
 *   · 配音员绑定（voiceActor:*，主 / 备）与分工负载（voiceActor:workload）
 *   · 自动抽取候选（character:extract）与原型向量重建（character:rebuildCentroid）
 *   · 合并预览所需的别名冲突与「将影响 N 行」计算
 *
 * 颜色约定：角色色用于剧本视图配色（docs/11 §4.3）。用户没设 color 时按 id 稳定散列取色，
 * 保证同一角色在所有视图里颜色一致（随机色会导致每次刷新都在变）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { describeExtractResult, shouldWidenToBook } from '@/shared/lib/extract-scope.ts'
import type {
  ActorWorkload,
  Character,
  CharacterCandidate,
  CharacterStats,
  Id,
  VoiceActor,
} from '@shared/types.ts'

/** 角色色板（取自主题色系，深浅对比都够用） */
export const CHARACTER_PALETTE = [
  '#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399',
  '#9b59b6', '#16a085', '#d35400', '#2c3e50', '#c0392b',
  '#2980b9', '#8e44ad', '#27ae60', '#f39c12', '#7f8c8d',
] as const

/** 按 id 稳定取色（同一角色永远同一个颜色） */
export function paletteColorOf(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 100000
  return CHARACTER_PALETTE[hash % CHARACTER_PALETTE.length]!
}

export interface CharacterBinding {
  characterId: Id
  actorId: Id
  isPrimary: boolean
}

/** 合并预览：别名冲突与影响行数 */
export interface MergePreview {
  /** 同时存在于两个角色上的别名（合并后需要人工决定保留哪个） */
  aliasConflicts: string[]
  /** 全部会被迁移的别名 */
  movingAliases: string[]
  /** 将影响的行数（由调用方传入当前章或全书统计） */
  affectedLines: number
}

export const useCharactersStore = defineStore('editor/characters', () => {
  const characters = ref<Character[]>([])
  const actors = ref<VoiceActor[]>([])
  const bindings = ref<CharacterBinding[]>([])
  const workload = ref<ActorWorkload[]>([])
  const stats = ref<Record<Id, CharacterStats>>({})
  const candidates = ref<CharacterCandidate[]>([])
  const loading = ref(false)
  const extracting = ref(false)
  /**
   * 上一次「自动抽取」的结果回执（UI 直接显示）。
   *
   * 为什么要有它：抽取可能**一个候选都抽不到**（那本书通篇是剧本体、或本章只有几十字），
   * 只更新候选列表的话界面上毫无变化，用户无法区分「按钮没反应」与「抽不到」。
   */
  const extractNote = ref<string | null>(null)
  const includeArchived = ref(false)
  const bookId = ref<Id | null>(null)
  const projectId = ref<Id | null>(null)
  const lastError = ref<unknown>(null)
  /** 改名 / 增删别名之后置 true：UI 据此提示「需要重算归属」（docs/11 §4.6） */
  const attributionDirty = ref(false)
  /** 原型向量重建任务（TaskProgressCard 用它） */
  const centroidTaskId = ref<Id | null>(null)

  // -------------------------------------------------------------------------
  // 派生
  // -------------------------------------------------------------------------

  /** 未归档角色（自动补全、候选按钮都用它） */
  const activeCharacters = computed(() => characters.value.filter(c => !c.isArchived))

  const characterById = computed(() => {
    const map = new Map<Id, Character>()
    for (const item of characters.value) map.set(item.id, item)
    return map
  })

  const actorById = computed(() => {
    const map = new Map<Id, VoiceActor>()
    for (const item of actors.value) map.set(item.id, item)
    return map
  })

  /** characterId → 绑定（主配音员排前） */
  const bindingsByCharacter = computed(() => {
    const map = new Map<Id, CharacterBinding[]>()
    for (const binding of bindings.value) {
      const list = map.get(binding.characterId) ?? []
      list.push(binding)
      map.set(binding.characterId, list)
    }
    for (const list of map.values()) list.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
    return map
  })

  /** 角色 id → 颜色（剧本视图 / 表格角色色块） */
  const colorByCharacter = computed(() => {
    const map = new Map<Id, string>()
    for (const item of characters.value) map.set(item.id, item.color ?? paletteColorOf(item.id))
    return map
  })

  /** 未绑定配音员的角色数（配音员面板与任务包导出前的提示，docs/11 §6.1） */
  const unboundCount = computed(() =>
    activeCharacters.value.filter(c => (bindingsByCharacter.value.get(c.id) ?? []).length === 0).length)

  /** 角色名（找不到时给「未知角色」，绝不显示 uuid） */
  function nameOf(characterId: Id | null | undefined): string {
    if (!characterId) return '未分配'
    return characterById.value.get(characterId)?.name ?? '未知角色'
  }

  function colorOf(characterId: Id | null | undefined): string {
    if (!characterId) return 'var(--ns-text-secondary, #909399)'
    return colorByCharacter.value.get(characterId) ?? paletteColorOf(characterId)
  }

  function statsOf(characterId: Id): CharacterStats | null {
    return stats.value[characterId] ?? null
  }

  function primaryActorOf(characterId: Id): VoiceActor | null {
    const list = bindingsByCharacter.value.get(characterId) ?? []
    const primary = list.find(b => b.isPrimary) ?? list[0]
    return primary ? actorById.value.get(primary.actorId) ?? null : null
  }

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  async function load(targetBookId?: Id | null, targetProjectId?: Id | null): Promise<void> {
    const bid = targetBookId ?? bookId.value
    if (!bid) return
    /**
     * 换书时丢掉上一本书的**界面级状态**（真机反馈的同一类问题：docs/91 §5.2.35）。
     *
     * store 是单例：不清理的话，切到另一本书后角色面板还会显示上一本书的
     * 「抽取候选」「抽取回执」「建议重算归属」提示与原型重建任务 —— 它们都属于上一本书。
     */
    if (bookId.value !== null && bookId.value !== bid) {
      candidates.value = []
      extractNote.value = null
      attributionDirty.value = false
      centroidTaskId.value = null
    }
    bookId.value = bid
    if (targetProjectId !== undefined) projectId.value = targetProjectId
    loading.value = true
    lastError.value = null
    try {
      const [list, bindingList] = await Promise.all([
        call('character:list', { bookId: bid, includeArchived: includeArchived.value }) as Promise<Character[]>,
        call('voiceActor:bindings', { bookId: bid }) as Promise<CharacterBinding[]>,
      ])
      characters.value = list
      bindings.value = bindingList
      if (projectId.value) {
        actors.value = await call('voiceActor:list', { projectId: projectId.value }) as VoiceActor[]
      }
    } catch (error) {
      lastError.value = error
    } finally {
      loading.value = false
    }
  }

  async function setIncludeArchived(next: boolean): Promise<void> {
    includeArchived.value = next
    await load(bookId.value)
  }

  async function loadActors(): Promise<void> {
    if (!projectId.value) return
    actors.value = await call('voiceActor:list', { projectId: projectId.value }) as VoiceActor[]
  }

  /** 分工视图：按配音员汇总行数 / 字数 / 预估时长（docs/11 §6.1） */
  async function loadWorkload(): Promise<void> {
    if (!bookId.value) return
    workload.value = await callSafe('voiceActor:workload', { bookId: bookId.value }) as ActorWorkload[] ?? []
  }

  async function loadStats(characterId: Id): Promise<CharacterStats | null> {
    const result = await callSafe('character:stats', { characterId }) as CharacterStats | null
    if (result) stats.value = { ...stats.value, [characterId]: result }
    return result
  }

  async function loadAllStats(): Promise<void> {
    const list = characters.value
    const results = await Promise.all(list.map(c => callSafe('character:stats', { characterId: c.id })))
    const next: Record<Id, CharacterStats> = {}
    results.forEach((result, index) => {
      const character = list[index]
      if (result && character) next[character.id] = result as CharacterStats
    })
    stats.value = next
  }

  // -------------------------------------------------------------------------
  // 增删改
  // -------------------------------------------------------------------------

  /** 保存角色（新建或更新）。返回保存后的角色（主进程会回填 id / updatedAt） */
  async function saveCharacter(input: Partial<Character> & { name: string }): Promise<Character | null> {
    if (!bookId.value) return null
    const saved = await call('character:upsert', {
      character: { ...input, bookId: bookId.value },
    }) as Character
    const index = characters.value.findIndex(c => c.id === saved.id)
    if (index >= 0) characters.value[index] = saved
    else characters.value = [...characters.value, saved]

    // 名称 / 别名变了 → 归属判定不再准确，必须提示重算（docs/11 §4.6）
    attributionDirty.value = true
    return saved
  }

  /** 归档 / 恢复（docs/11 §8：有引用时只归档，不物理删除） */
  async function archive(characterId: Id, archived: boolean): Promise<boolean> {
    const res = await call('character:archive', { characterId, archived }) as { ok: boolean }
    const index = characters.value.findIndex(c => c.id === characterId)
    if (index >= 0) {
      const target = characters.value[index]!
      characters.value[index] = { ...target, isArchived: archived }
    }
    return res?.ok ?? false
  }

  // -------------------------------------------------------------------------
  // 合并（docs/11 §4.6）
  // -------------------------------------------------------------------------

  /** 合并预览：别名冲突清单（不做任何写操作，纯计算，供对话框展示） */
  function previewMerge(targetId: Id, sourceIds: Id[]): MergePreview {
    const target = characterById.value.get(targetId)
    const sources = sourceIds.map(id => characterById.value.get(id)).filter((c): c is Character => Boolean(c))
    const allSources = sourceIds.includes(targetId)
      ? sources.filter(c => c.id !== targetId)
      : sources

    const targetAliases = new Set([...(target?.aliases ?? []), target?.name ?? ''])
    const moving: string[] = []
    const conflicts: string[] = []

    for (const source of allSources) {
      for (const alias of source.aliases) {
        if (!alias) continue
        if (!moving.includes(alias)) moving.push(alias)
        if (targetAliases.has(alias) && !conflicts.includes(alias)) conflicts.push(alias)
        targetAliases.add(alias)
      }
      if (targetAliases.has(source.name) && !conflicts.includes(source.name)) conflicts.push(source.name)
      else targetAliases.add(source.name)
    }

    const affectedLines = allSources.reduce((sum, source) => sum + (stats.value[source.id]?.lines ?? 0), 0)
    return { aliasConflicts: conflicts, movingAliases: moving, affectedLines }
  }

  /**
   * 执行合并。主进程返回 movedLines / mergedAliases / conflicts；
   * conflicts 非空时由调用方用 error-bus 报 CHARACTER_MERGE_CONFLICT（不在这里自拼文案）。
   */
  async function mergeCharacters(
    targetId: Id,
    sourceIds: Id[],
    keepAliases = true,
  ): Promise<{ movedLines: number; mergedAliases: string[]; conflicts: string[] }> {
    const res = await call('character:merge', { targetId, sourceIds, keepAliases }) as {
      movedLines: number
      mergedAliases: string[]
      conflicts: string[]
    }
    await load(bookId.value)
    await loadAllStats()
    return res ?? { movedLines: 0, mergedAliases: [], conflicts: [] }
  }

  // -------------------------------------------------------------------------
  // 自动抽取候选（docs/11 §4.6）
  // -------------------------------------------------------------------------

  async function extract(chapterIds?: Id[]): Promise<CharacterCandidate[]> {
    if (!bookId.value) return []
    const chapterScoped = Boolean(chapterIds?.length)
    extracting.value = true
    try {
      let list = await call('character:extract', {
        bookId: bookId.value,
        ...(chapterScoped ? { chapterIds } : {}),
      }) as CharacterCandidate[]
      const found = list.length
      // 本章抽不到候选 → 扩大到全书（docs/11 §4.6；策略与文案见 shared/lib/extract-scope.ts）。
      // 角色表是整本书的产物，盯着一个字数为几十的章节抽是错的范围 ——
      // 真机上这会表现成「点了按钮什么都没发生」。
      const widened = shouldWidenToBook({ chapterScoped, found })
      if (widened) {
        list = await call('character:extract', { bookId: bookId.value }) as CharacterCandidate[]
      }
      extractNote.value = describeExtractResult({
        chapterScoped,
        found,
        widened,
        bookFound: list.length,
      })
      candidates.value = list
      return list
    } finally {
      extracting.value = false
    }
  }

  /** 一键把候选加成角色（别名一起去重） */
  async function addCandidate(candidate: CharacterCandidate): Promise<Character | null> {
    const exists = characters.value.find(c => c.name === candidate.name)
    if (exists) return exists
    const created = await saveCharacter({ name: candidate.name, aliases: [...candidate.aliases] })
    candidates.value = candidates.value.filter(c => c.name !== candidate.name)
    return created
  }

  function dismissCandidate(name: string): void {
    candidates.value = candidates.value.filter(c => c.name !== name)
  }

  // -------------------------------------------------------------------------
  // 配音员绑定（docs/11 §6.1）
  // -------------------------------------------------------------------------

  async function bindActor(characterId: Id, actorId: Id, isPrimary = false): Promise<boolean> {
    const res = await call('voiceActor:bind', { characterId, actorId, isPrimary }) as { ok: boolean }
    await refreshBindings()
    return res?.ok ?? false
  }

  async function unbindActor(characterId: Id, actorId: Id): Promise<boolean> {
    const res = await call('voiceActor:unbind', { characterId, actorId }) as { ok: boolean }
    await refreshBindings()
    return res?.ok ?? false
  }

  async function refreshBindings(): Promise<void> {
    if (!bookId.value) return
    bindings.value = await callSafe('voiceActor:bindings', { bookId: bookId.value }) as CharacterBinding[] ?? []
  }

  // -------------------------------------------------------------------------
  // 原型向量重建（docs/11 §4.6）
  // -------------------------------------------------------------------------

  async function rebuildCentroid(characterIds?: Id[]): Promise<Id | null> {
    if (!bookId.value) return null
    const res = await call('character:rebuildCentroid', {
      bookId: bookId.value,
      ...(characterIds?.length ? { characterIds } : {}),
    }) as { taskId: Id }
    centroidTaskId.value = res.taskId
    return res.taskId
  }

  /** 重算归属完成后清掉「需要重算」提示 */
  function markAttributionFresh(): void {
    attributionDirty.value = false
  }

  function setBookId(id: Id | null): void {
    bookId.value = id
  }

  function setProjectId(id: Id | null): void {
    projectId.value = id
  }

  return {
    characters, actors, bindings, workload, stats, candidates,
    loading, extracting, extractNote, includeArchived, bookId, projectId, lastError,
    attributionDirty, centroidTaskId,
    activeCharacters, characterById, actorById, bindingsByCharacter, colorByCharacter, unboundCount,
    nameOf, colorOf, statsOf, primaryActorOf,
    load, setIncludeArchived, loadActors, loadWorkload, loadStats, loadAllStats,
    saveCharacter, archive,
    previewMerge, mergeCharacters,
    extract, addCandidate, dismissCandidate,
    bindActor, unbindActor, refreshBindings,
    rebuildCentroid, markAttributionFresh,
    setBookId, setProjectId,
  }
})
