/**
 * Novel Studio · 「旁白」这个特殊角色（纯逻辑）
 * ============================================================================
 * 为什么旁白也要在角色表里有一行：`character_voice_bindings.character_id` 是指向
 * `characters(id)` 的外键 —— 「这段旁白由 cv 语心草 来配」这句话要落库，
 * 就必须有一个真实的角色行可挂。
 *
 * 但**台词行不指向它**：旁白行的 `speaker_type='narration'` 且 `character_id` 为 null
 * （见 docs/03 §canvas_lines）。改台词行的归属会牵动判定、质检、任务包、对轨的全部口径，
 * 风险远大于收益。所以这里只做两件事：
 *   1. 按名字认出「旁白角色」（`isNarrationRoleName`）；
 *   2. 统计旁白角色时按 `speaker_type='narration'` 的行来算（服务层 + 仓储的
 *      `listNarrationByBook`），而不是按 `character_id`。
 *
 * 副作用：它与「角色不被任何行引用」的质检项天然冲突 —— 旁白角色永远没有
 * `character_id` 指向它的行，所以质检必须跳过它（否则每一章都会报一条假问题）。
 */

import { normalizeCvName } from './character-display.ts'

/** 书内「旁白」角色的名字（UI 与数据层统一用它，避免各处手写字符串） */
export const NARRATION_ROLE_NAME = '旁白'

/**
 * 系统补出来的旁白角色带这条备注。
 *
 * 为什么写备注而不是加列：用户会在角色面板里看到这个角色，他一定会问「这个名字哪来的」——
 * 备注就是答案；同时也让「用户自己建的旁白」与「系统补的」在数据上可分辨。
 */
export const NARRATION_ROLE_NOTE = '系统角色：整本书的旁白'

/** 旁白角色排在角色表最前面（`listByBook` 按 sortOrder 排序） */
export const NARRATION_ROLE_SORT_ORDER = -1

/**
 * 这个名字是不是「旁白角色」。
 *
 * 归一化口径与 CV 名一致（去空白 + ASCII 大小写）：画本表格里写「旁 白」也一样认。
 */
export function isNarrationRoleName(name: string | null | undefined): boolean {
  return normalizeCvName(name) === normalizeCvName(NARRATION_ROLE_NAME)
}
