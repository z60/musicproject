/**
 * Novel Studio · 表格里「说话人（CV）」「角色名」两列的下拉选项（纯逻辑）
 * ============================================================================
 * 两列回答两个不同的问题（docs/11 §4.2）：
 *   · 说话人（CV）  = **谁来念** → 选项按 CV 组织（一个 CV 一行，或按「CV（角色）」展开）
 *   · 角色名        = **演的是谁** → 选项就是角色表
 *
 * ### 为什么两列最终写的是同一个字段
 * 画本行只存 `characterId`（角色）＋ `speakerType`；**CV 是从角色的绑定推出来的**
 * （docs/11 §6.1）。所以「选 CV」在数据上必然落成「选这个 CV 名下的某个角色」——
 * 一个 CV 名下有几个角色时，选项必须写成「语心草（方艺华）」「语心草（苏幼薇）」，
 * 否则用户选了 CV 也说不清到底是哪个角色。这是数据模型决定的，不是界面偷懒。
 *
 * ### 旁白是唯一的例外：它的选项值永远是 `null`
 * 角色表里有一行「旁白」（为了挂 CV 绑定，见 narration-role.ts），但**台词行不指向它** ——
 * 旁白行始终是 `speaker_type='narration' AND character_id IS NULL`。
 * 如果这里给旁白选项塞上角色 id，`assignSpeaker` 会把 `speakerType` 翻成 `'character'`，
 * 于是录音页的「按角色录制 · 旁白」、对轨的旁白轨、混音的旁白通道条全都会认不出这些行
 * （真机回归面比收益大得多）。所以旁白选项一律 `characterId = null`，
 * 只是**标签**上把读它的人（CV）显示出来。
 */

import type { Id } from '../types.ts'
import { isNarrationRoleName } from './narration-role.ts'

export interface PickerCharacter {
  id: Id
  name: string
  aliases?: readonly string[]
}

export interface PickerBinding {
  characterId: Id
  actorId: Id
  isPrimary?: boolean
}

export interface PickerActor {
  id: Id
  name: string
}

export type SpeakerPickerGroup = 'cv' | 'role' | 'narration'

export interface SpeakerPickerOption {
  /** 选项值：角色 id；`null` = 旁白（旁白永远是 null，见文件头） */
  characterId: Id | null
  /** 主标签：CV 模式是 CV 名，角色模式是角色名 */
  label: string
  /** 右侧的浅色说明：CV 模式写角色名（或「未绑定 CV」），角色模式写别名 */
  hint: string
  group: SpeakerPickerGroup
  /** 搜索文本（小写，label + hint + 别名） */
  search: string
}

function option(input: {
  characterId: Id | null
  label: string
  hint?: string
  group: SpeakerPickerGroup
  extra?: readonly string[]
}): SpeakerPickerOption {
  const hint = input.hint ?? ''
  const search = [input.label, hint, ...(input.extra ?? [])].join(' ').toLowerCase()
  return { characterId: input.characterId, label: input.label, hint, group: input.group, search }
}

/** 书里有没有「旁白」角色 —— 决定旁白选项是「某个 CV 读的旁白」还是裸的「旁白」 */
function narrationRoleOf(characters: readonly PickerCharacter[]): PickerCharacter | null {
  return characters.find((c) => isNarrationRoleName(c.name)) ?? null
}

/**
 * 「说话人（CV）」列：**按 CV 组织**。
 *
 * 规则：
 *   · 一个 CV 只负责一个角色 → 标签就是 CV 名（最常见，一眼看清）
 *   · 一个 CV 负责多个角色 → 每个角色一条「CV（角色名）」
 *   · 角色没有任何 CV       → 兜底列出角色名（否则这些行在 CV 列里选不到东西）
 *   · 旁白                  → 值为 null；绑了 CV 就写「CV（旁白）」，没绑就写「旁白」
 */
export function buildCvPickerOptions(input: {
  characters: readonly PickerCharacter[]
  bindings: readonly PickerBinding[]
  actors: readonly PickerActor[]
}): SpeakerPickerOption[] {
  const narration = narrationRoleOf(input.characters)
  const byId = new Map(input.characters.map((c) => [c.id, c]))
  const rolesByActor = new Map<Id, PickerCharacter[]>()
  for (const binding of input.bindings) {
    const character = byId.get(binding.characterId)
    if (!character) continue
    const list = rolesByActor.get(binding.actorId) ?? []
    // 同一个角色对同一个 CV 有多条绑定时不重复（绑定表理论上唯一，这里防御一下）
    if (!list.some((c) => c.id === character.id)) list.push(character)
    rolesByActor.set(binding.actorId, list)
  }

  const options: SpeakerPickerOption[] = []
  const covered = new Set<Id>()
  const actors = [...input.actors].sort((a, b) => a.name.localeCompare(b.name))
  for (const actor of actors) {
    const roles = (rolesByActor.get(actor.id) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    if (roles.length === 0) continue
    const narrationRole = roles.find((r) => isNarrationRoleName(r.name)) ?? null
    const named = roles.filter((r) => !isNarrationRoleName(r.name))
    const multi = roles.length > 1
    if (narrationRole) {
      options.push(option({
        characterId: null,
        label: multi ? `${actor.name}（旁白）` : actor.name,
        hint: '旁白',
        group: 'narration',
      }))
      covered.add(narrationRole.id)
    }
    if (named.length === 1 && !narrationRole) {
      const role = named[0]!
      options.push(option({ characterId: role.id, label: actor.name, hint: role.name, group: 'cv' }))
    } else {
      for (const role of named) {
        options.push(option({
          characterId: role.id,
          label: multi || narrationRole ? `${actor.name}（${role.name}）` : actor.name,
          hint: multi || narrationRole ? '' : role.name,
          group: 'cv',
        }))
      }
    }
    for (const role of roles) covered.add(role.id)
  }

  // 没有任何 CV 的角色：直接列角色名，否则这些行在 CV 列里根本选不到
  for (const character of input.characters) {
    if (covered.has(character.id)) continue
    if (isNarrationRoleName(character.name)) continue // 旁白单独处理（值为 null）
    options.push(option({
      characterId: character.id,
      label: character.name,
      hint: '未绑定 CV',
      group: 'role',
      extra: character.aliases,
    }))
  }

  const narrationBound = narration ? covered.has(narration.id) : false
  if (!narrationBound) {
    options.push(option({
      characterId: null,
      label: '旁白',
      hint: narration ? '未绑定 CV' : '无角色',
      group: 'narration',
    }))
  }
  return options
}

/**
 * 「角色名」列：选项就是角色表。
 *
 * 旁白固定排第一（角色表里它的 `sortOrder = -1`），值为 `null` —— 理由见文件头。
 */
export function buildRolePickerOptions(input: {
  characters: readonly PickerCharacter[]
}): SpeakerPickerOption[] {
  const options: SpeakerPickerOption[] = [
    option({ characterId: null, label: '旁白', hint: '无角色', group: 'narration' }),
  ]
  for (const character of input.characters) {
    if (isNarrationRoleName(character.name)) continue // 旁白已经在上面的固定项里
    options.push(
      option({
        characterId: character.id,
        label: character.name,
        hint: character.aliases?.length ? character.aliases.join('/') : '',
        group: 'role',
        extra: character.aliases,
      }),
    )
  }
  return options
}

/** 关键字过滤（label / hint / 别名都参与；空关键字原样返回） */
export function filterSpeakerOptions(
  options: readonly SpeakerPickerOption[],
  keyword: string,
): SpeakerPickerOption[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return [...options]
  return options.filter((o) => o.search.includes(kw))
}
