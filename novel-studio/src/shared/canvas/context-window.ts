/**
 * Novel Studio · 录音上下文窗口（当前行前后各 N 行，纯逻辑）
 * ============================================================================
 * 配音员看着当前行录，需要**前后各若干行**做语气衔接；当前行也要出现在上下文里并被框出，
 * 否则眼睛在提示卡与上下文之间来回找。「取哪几行」抽成纯函数，行为可单测。
 *
 * 关键点：`currentIndex` 是**整章**里的下标，不是筛选后工作集的下标。
 * 按角色录制时工作集被筛过，若用工作集下标取上下文，会把别的角色相邻行漏掉。
 */

export interface LineContextItem<T> {
  line: T
  /** 相对当前行的偏移：-2 / -1 / 0 / +1 / +2 */
  offset: number
  /** 是否当前录制行（界面据此加框） */
  current: boolean
}

/**
 * 取 `currentIndex` 前后各 `before` / `after` 行（含当前行）。
 * `currentIndex` 越界返回空数组；数组边界自动截断。
 */
export function buildLineContext<T>(
  lines: readonly T[],
  currentIndex: number,
  before = 2,
  after = 2,
): Array<LineContextItem<T>> {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= lines.length) return []
  const out: Array<LineContextItem<T>> = []
  for (let k = currentIndex - Math.max(0, before); k <= currentIndex + Math.max(0, after); k++) {
    const line = lines[k]
    if (line === undefined) continue
    out.push({ line, offset: k - currentIndex, current: k === currentIndex })
  }
  return out
}
