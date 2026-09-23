/**
 * Novel Studio · 章标题里的章节号解析 + 按范围勾选（纯逻辑，渲染进程可用）
 * ============================================================================
 * 为什么单独一份而不是复用 `shared/text/chapter-split.ts`：
 *   · chapter-split 的 `parseChineseNumber` 顶部 `import { performance } from 'node:perf_hooks'`，
 *     渲染进程不能引入 Node 内置模块；
 *   · 导入向导第 5 步要「按章节范围勾选」（第 1~20 章），需要在**没有 Node**、
 *     也没有 `@/` 别名的情况下可单测，因此这里保持零依赖。
 */

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }

/** 中文数字 → 数值（支持「十二」「二十三」「一千零二十」「两」；认不出返回 null） */
export function parseChineseNumber(text: string): number | null {
  if (!text) return null
  let total = 0
  let section = 0
  let digit = 0
  let seen = false
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]!
      seen = true
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch]!
      seen = true
      if (unit === 10000) {
        section = (section + (digit || 0)) * unit
        total += section
        section = 0
      } else {
        section += (digit || 1) * unit
      }
      digit = 0
    } else {
      return null
    }
  }
  if (!seen) return null
  return total + section + digit
}

/**
 * 从章标题里抽出章节号（docs/10 §7.1「章节号规范化：识别一二三 / 123 / 零一二」）。
 * 识别不出返回 null（调用方按「无号」排到末尾，绝不猜）。
 */
export function extractChapterNumber(title: string): number | null {
  if (!title) return null
  // 先看阿拉伯数字（第 12 章 / 12 / 012）
  const ascii = /(\d{1,6})/.exec(title)
  if (ascii) {
    const n = Number(ascii[1])
    if (Number.isFinite(n)) return n
  }
  // 再看中文数字：取「第…章」之间，或去掉「第/章/回/节/卷」后的连续中文数字
  const bracket = /第\s*([零〇一二三四五六七八九十百千万两]+)\s*[章节回卷部篇]/.exec(title)
  if (bracket) {
    const n = parseChineseNumber(bracket[1]!)
    if (n !== null) return n
  }
  const plain = /([零〇一二三四五六七八九十百千万两]{1,10})/.exec(title)
  if (plain) return parseChineseNumber(plain[1]!)
  return null
}

/** 范围勾选只要求这两个字段，因此不用绑死 ChapterDraft（便于单测与复用） */
export interface ChapterRangeDraft {
  title: string
  included: boolean
}

/**
 * 草稿们的章号范围。章号解析不出时按**列表序号**（1 起）回退，保证任何文档都能整段勾选。
 */
export function chapterNumberRange<T extends { title: string }>(
  drafts: readonly T[],
): { min: number; max: number; mapped: number } {
  if (drafts.length === 0) return { min: 0, max: 0, mapped: 0 }
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  drafts.forEach((d, i) => {
    const n = extractChapterNumber(d.title) ?? (i + 1)
    if (n < min) min = n
    if (n > max) max = n
  })
  return { min, max, mapped: drafts.length }
}

/**
 * 按章节号范围勾选：**只**勾选落在 [from, to] 内的草稿，其余一律取消勾选。
 * 未改变的草稿保持**原对象引用**（Pinia/Vue 的渲染依赖引用比较，避免无谓重渲染）。
 * @returns 新的草稿数组与勾选到的数量
 */
export function selectDraftsByChapterRange<T extends ChapterRangeDraft>(
  drafts: readonly T[],
  from: number,
  to: number,
): { drafts: T[]; count: number } {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { drafts: [...drafts], count: 0 }
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  let count = 0
  const next = drafts.map((d, i) => {
    const n = extractChapterNumber(d.title) ?? (i + 1)
    const hit = n >= lo && n <= hi
    if (hit) count++
    return (d.included === hit ? d : { ...d, included: hit }) as T
  })
  return { drafts: next, count }
}
