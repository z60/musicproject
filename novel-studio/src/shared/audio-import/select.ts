/**
 * Novel Studio · 按说话人导入音频：选行（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/12-功能域-录音.md、docs/91 §5.2.49
 *
 * ## 这个模块为什么必须单独存在
 *
 * 「按说话人导入」要做两件事，用的是**两套不同的数据源**：
 *
 * ```
 *   预览（规划）        用**文档行**（刚解析出来的 docx，画本可能还没入库）
 *   实际导入（落库）    用**数据库行**（canvas_lines 表，画本已入库）
 * ```
 *
 * 如果这两步各写一套「哪些行属于这个说话人」的判断，
 * **「预览说 90 行、实际导入 40 行」这种不一致必然发生** ——
 * 而它极难发现：两边都在跑、都不报错，只是数量对不上，
 * 用户要等到录音界面上少了一堆行才会察觉。
 *
 * 所以选行逻辑**只有这一份**，作用在 `LineRef`（文档行与数据库行的公共形态）上。
 *
 * ## 四种目标的选行语义（与 `resolve.ts` 的 `decideTarget` 一一对应）
 *
 * | 目标 | 选哪些行 |
 * |------|---------|
 * | `character` / `cv-single-role` | 该**角色**在区间内的对白行 |
 * | `multiRole` | 该 **CV** 在区间内的全部对白行（可能跨多个角色） |
 * | `narration` | 区间内的**纯旁白**行（**不含群白**） |
 * | `unknown` | 不选（交人工确认） |
 *
 * ⚠️ **旁白 ≠ 群白**：`【异口同声】"…"` 是多人齐声的一**句对白**，
 * 与单人旁白不是一回事。把群白算进旁白会让旁白音轨多出不该有的句子，
 * 而这种错误在试听时很容易被忽略（都像"叙述"）。
 *
 * 本目录禁止引入任何第三方依赖。
 */

import type { CanvasParsedLine, LineRef } from '../canvas/docx-canvas.ts'
import { normalizeName } from '../canvas/docx-canvas.ts'
import type { SpeakerTarget } from './resolve.ts'

/** 章节区间的闭合表示 */
export interface ChapterSpan {
  from: number
  to: number
}

/**
 * 把超大的章节区间截断到一个安全上限。
 *
 * 为什么需要：文件名里的区间是**人写的**，可能写成 `1-999999`（真的出现过），
 * 直接按它遍历会把整本书都算进来，既慢又会让「命中行数」变得毫无意义。
 * 真实画本一本书不会超过 2000 章（`maxChapters` 默认值）。
 */
export function clampSpan(span: ChapterSpan, maxChapters = 2000): ChapterSpan {
  if (span.to < span.from) return { from: span.from, to: span.from }
  const width = span.to - span.from + 1
  if (width <= maxChapters) return span
  return { from: span.from, to: span.from + maxChapters - 1 }
}

/**
 * 取某个说话目标在指定章节集合内应当导入的行。
 *
 * @param lines    候选行（文档行或数据库行的数组）
 * @param target   说话目标（由 `decideTarget` 得出）
 * @param chapters 允许的章节号集合（调用方已按区间算好；**传 `null` 表示不限**）
 */
export function selectLinesForTarget<T extends LineRef>(
  lines: readonly T[],
  target: SpeakerTarget,
  chapters: ReadonlySet<number> | null,
): T[] {
  const inRange = (l: LineRef): boolean => chapters === null || chapters.has(l.chapterNo)

  switch (target.kind) {
    case 'narration':
      // 只取 `kind === 'narration'`。群白（`group`）**不算旁白** —— 见文件头说明。
      return lines.filter((l) => l.kind === 'narration' && inRange(l))

    case 'character':
    case 'cv-single-role': {
      const charKey = normalizeName(target.character ?? '')
      if (charKey.length === 0) return []
      return lines.filter(
        (l) => l.kind === 'dialogue' && inRange(l) && l.owners.some((o) => normalizeName(o.character) === charKey),
      )
    }

    case 'multiRole': {
      // 用**解析到的 CV 全名**去匹配。
      // 不能用文件名 token 反推：`月光` 会被补全成 `月光_深白色`，
      // 反推就永远匹配不上，表现为「解析显示成功、却一行都选不到」。
      const cvKey = normalizeName(target.cvName ?? '')
      if (cvKey.length === 0) return []
      return lines.filter(
        (l) => l.kind === 'dialogue' && inRange(l) && l.owners.some((o) => normalizeName(o.cv) === cvKey),
      )
    }

    default:
      // `unknown`：说话人没判出来，不选任何行（由 UI 让用户指定后重算）
      return []
  }
}

/**
 * 按章节号集合过滤（保持原顺序）。
 *
 * 单独抽出来是因为「区间 → 章节集合」的转换要在多处复用，
 * 而**把它写错一次就会整体偏移**（例如用了 `>=from && <to` 漏掉末章）。
 */
export function chaptersInSpan(chapterNos: Iterable<number>, span: ChapterSpan): number[] {
  const from = Math.min(span.from, span.to)
  const to = Math.max(span.from, span.to)
  const out: number[] = []
  for (const c of chapterNos) {
    if (c >= from && c <= to) out.push(c)
  }
  return out.sort((a, b) => a - b)
}

/** 从文档行里取章节号集合（供 `buildImportPlan` 与 service 共用） */
export function chapterSetOf(lines: readonly CanvasParsedLine[]): Set<number> {
  const s = new Set<number>()
  for (const l of lines) s.add(l.chapterNo)
  return s
}
