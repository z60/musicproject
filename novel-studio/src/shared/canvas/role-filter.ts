/**
 * Novel Studio · 画本行按角色筛选（录音「按角色录制」的纯逻辑）
 * ============================================================================
 * 录音主界面与任务包页都要「只走某个角色的行」；抽成纯函数，行为可单测。
 * 口径与任务包页（docs/12 §5）一致：
 *   · 'all'         → 全部行（含旁白）
 *   · 'narration'   → 只旁白
 *   · <characterId> → 只该角色的行（不含旁白）
 * 不认识的 characterId → 返回空数组：明确「这个角色在本章没有行」，
 * 而不是悄悄退化成「全部行」（那会让配音员录到别人角色的台词）。
 */

export const ROLE_FILTER_ALL = 'all'
export const ROLE_FILTER_NARRATION = 'narration'

/** 只要这两个字段，因此不绑死 CanvasLine（便于单测与复用） */
export interface RoleFilterableLine {
  speakerType: string
  characterId: string | null
}

/** 按角色筛选画本行（不改原数组，返回新数组） */
export function filterLinesByRole<T extends RoleFilterableLine>(
  lines: readonly T[],
  roleFilter: string,
): T[] {
  if (roleFilter === ROLE_FILTER_ALL) return [...lines]
  if (roleFilter === ROLE_FILTER_NARRATION) return lines.filter(line => line.speakerType === 'narration')
  return lines.filter(line => line.speakerType !== 'narration' && line.characterId === roleFilter)
}
