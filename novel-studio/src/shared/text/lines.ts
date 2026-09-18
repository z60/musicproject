/**
 * 文本行统计（`chapters.line_count` 的唯一口径）
 * ============================================================================
 * 为什么单独成模块：`line_count` 在两处被写入 ——
 *   · 导入域（`import.service.ts` / `book.service.ts` 的 `buildChapterFromDraft`）
 *   · 章节管理域（拆分 / 合并后重算）
 * 如果两边各写一份统计口径，同一个字段就会出现「导入时算一种、拆分后算另一种」的漂移，
 * 而这种漂移在 UI 上只表现为「行数看着不太对」，极难发现。
 *
 * 口径：**非空行数**（`trim()` 后有内容才算一行）。
 * 不是 `split('\n').length` —— 原文里的连续空行、尾随换行都不该被算成内容行。
 */

/** 非空行数（章节 `line_count` 的口径） */
export function countNonEmptyLines(text: string): number {
  let n = 0
  for (const line of text.split('\n')) if (line.trim().length > 0) n++
  return n
}
