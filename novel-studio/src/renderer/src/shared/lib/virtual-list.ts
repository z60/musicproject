/**
 * Novel Studio · 虚拟滚动区间计算（纯逻辑，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/01 §3.2 —— 「大列表（画本行 > 2000）使用虚拟滚动」
 *   · docs/11 §4.2 —— 5000 行下滚动 ≥ 30 fps（虚拟滚动 + 行内纯文本）
 *   · docs/10 §7.1 —— 章节预览表格同样是长列表
 *
 * 只做一件事：给定滚动位置与行高，算出「该渲染哪几行 + 上下要留多少空白」。
 * 组件只需把 `paddingTop / paddingBottom` 加到占位元素上，就能得到正确的滚动条长度。
 *
 * 之所以抽成纯函数：
 *   1. 边界（空列表、不足一屏、滚过头、行高为 0）最容易写错，必须能单测；
 *   2. 表格视图与剧本视图、章节列表、take 列表共用同一套计算。
 */

export interface VisibleRangeInput {
  /** 当前滚动位置（px，调用方需保证是容器的 scrollTop） */
  scrollTop: number
  /** 视口高度（px） */
  viewportHeight: number
  /** 单行高度（px）；不等高行请调用方传入平均行高 */
  rowHeight: number
  /** 总行数 */
  total: number
  /** 上下各多渲染几行（默认 4：滚动时不易露白，又不会让 DOM 膨胀） */
  overscan?: number
  /** 列表顶部额外的固定高度（如表头、分组标题），会从 scrollTop 中扣除 */
  headerOffset?: number
}

export interface VisibleRange {
  /** 需要渲染的第一行（含），空列表为 0 */
  startIndex: number
  /** 需要渲染的最后一行（含），空列表为 -1 */
  endIndex: number
  /** 不含 overscan 的可见区第一行（用于「当前屏内第一行」判断） */
  visibleStartIndex: number
  /** 不含 overscan 的可见区最后一行 */
  visibleEndIndex: number
  /** 渲染区在内容坐标系中的起始偏移（= startIndex * rowHeight），即 paddingTop */
  paddingTop: number
  /** 渲染区之后到内容末尾的空白，即 paddingBottom */
  paddingBottom: number
  /** 全部内容的滚动高度（= total * rowHeight） */
  totalHeight: number
  /** 该次实际渲染的行数（含 overscan，用于诊断） */
  renderCount: number
  /** 归一化后的 scrollTop（负数归 0，超出上限收敛到 maxScrollTop） */
  clampedScrollTop: number
  /** 内容最大可滚动位置 */
  maxScrollTop: number
  /** 入参不合法（行高 ≤ 0 / 视口高度 ≤ 0）时为 true，组件可据此退化为「只渲染少量行」 */
  degenerate: boolean
}

const DEFAULTS = { overscan: 4 }

function safeInt(v: number, fallback = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.floor(v)
}

/** 内容最大滚动位置；无内容时为 0（不要返回负数，否则会把容器顶上去） */
export function maxScrollTop(total: number, rowHeight: number, viewportHeight: number): number {
  const t = Math.max(0, safeInt(total))
  const h = rowHeight > 0 && Number.isFinite(rowHeight) ? rowHeight : 0
  const vh = Math.max(0, viewportHeight && Number.isFinite(viewportHeight) ? viewportHeight : 0)
  return Math.max(0, t * h - vh)
}

/** 把滚动位置收敛到合法范围 */
export function clampScrollTop(
  scrollTop: number,
  total: number,
  rowHeight: number,
  viewportHeight: number,
): number {
  const raw = Number.isFinite(scrollTop) ? scrollTop : 0
  return Math.min(Math.max(0, raw), maxScrollTop(total, rowHeight, viewportHeight))
}

/** 某一行的顶部偏移 */
export function offsetOfIndex(index: number, rowHeight: number): number {
  return Math.max(0, safeInt(index)) * Math.max(0, rowHeight)
}

/** 某个纵向偏移落在第几行（用于点击定位、按 y 取行） */
export function indexAtOffset(y: number, rowHeight: number, total: number, clamp = true): number {
  if (!(rowHeight > 0)) return 0
  const t = Math.max(0, safeInt(total))
  if (t === 0) return -1
  const idx = Math.floor((Number.isFinite(y) ? y : 0) / rowHeight)
  if (!clamp) return idx
  return Math.min(t - 1, Math.max(0, idx))
}

/**
 * 核心：计算可见区间。
 *
 * 语义约定（单测据此固化）：
 *   · `startIndex/endIndex` **闭区间**；
 *   · 列表为空 → `{ startIndex: 0, endIndex: -1, renderCount: 0 }`（这样 `for (i=start; i<=end; i++)` 天然不执行）；
 *   · `endIndex` 允许等于 `startIndex`（只有一行时），不允许越过 `total - 1`；
 *   · 滚过头（scrollTop > maxScrollTop）会被收敛到 maxScrollTop；
 *   · 行高非法（≤0）时 `degenerate = true`，返回一个 1 行的退化区间而不是抛错。
 */
export function computeVisibleRange(input: VisibleRangeInput): VisibleRange {
  const total = Math.max(0, safeInt(input.total))
  const overscan = Math.max(0, safeInt(input.overscan ?? DEFAULTS.overscan))
  const headerOffset = Math.max(0, safeInt(input.headerOffset ?? 0))
  const viewportHeight = Number.isFinite(input.viewportHeight) ? Math.max(0, input.viewportHeight) : 0
  const rowHeightOk = Number.isFinite(input.rowHeight) && input.rowHeight > 0
  const rowHeight = rowHeightOk ? (input.rowHeight as number) : 1

  const totalHeight = total * rowHeight
  const maxScroll = maxScrollTop(total, rowHeight, viewportHeight)
  const clampedScrollTop = clampScrollTop((input.scrollTop ?? 0) - headerOffset, total, rowHeight, viewportHeight)

  if (total === 0) {
    return {
      startIndex: 0,
      endIndex: -1,
      visibleStartIndex: 0,
      visibleEndIndex: -1,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight,
      renderCount: 0,
      clampedScrollTop,
      maxScrollTop: maxScroll,
      degenerate: !rowHeightOk || viewportHeight <= 0,
    }
  }

  const firstVisible = Math.min(total - 1, Math.floor(clampedScrollTop / rowHeight))
  // 视口底部：用 ceil 保证「露出一半的行」也被渲染，否则快速滚动时会看到空白
  const lastVisible = viewportHeight > 0
    ? Math.min(total - 1, Math.max(firstVisible, Math.ceil((clampedScrollTop + viewportHeight) / rowHeight) - 1))
    : firstVisible

  const startIndex = Math.max(0, firstVisible - overscan)
  const endIndex = Math.min(total - 1, lastVisible + overscan)

  return {
    startIndex,
    endIndex,
    visibleStartIndex: firstVisible,
    visibleEndIndex: lastVisible,
    paddingTop: startIndex * rowHeight,
    paddingBottom: Math.max(0, totalHeight - (endIndex + 1) * rowHeight),
    totalHeight,
    renderCount: endIndex >= startIndex ? endIndex - startIndex + 1 : 0,
    clampedScrollTop,
    maxScrollTop: maxScroll,
    degenerate: !rowHeightOk || viewportHeight <= 0,
  }
}

/**
 * 键盘导航用：把某一行滚动到视口内所需的最小 scrollTop 变化。
 * 返回新的 scrollTop（已收敛），调用方直接赋给容器即可。
 *   · 行在视口上方 → 顶到第一行
 *   · 行在视口下方 → 底到最后一个完整可见行
 *   · 已在视口内 → 不动（返回原值，避免「每按一次就跳一下」）
 */
export function computeScrollToIndex(
  index: number,
  input: Omit<VisibleRangeInput, 'scrollTop'> & { currentScrollTop: number; align?: 'nearest' | 'center' | 'start' | 'end' },
): number {
  const total = Math.max(0, safeInt(input.total))
  if (total === 0) return 0
  const rowHeight = Number.isFinite(input.rowHeight) && input.rowHeight > 0 ? input.rowHeight : 1
  const viewportHeight = Number.isFinite(input.viewportHeight) ? Math.max(0, input.viewportHeight) : 0
  const headerOffset = Math.max(0, safeInt(input.headerOffset ?? 0))
  const align = input.align ?? 'nearest'
  const idx = Math.min(total - 1, Math.max(0, safeInt(index)))

  const rowTop = idx * rowHeight
  const rowBottom = rowTop + rowHeight
  const current = clampScrollTop((input.currentScrollTop ?? 0) - headerOffset, total, rowHeight, viewportHeight)

  let next = current
  if (align === 'start') {
    next = rowTop
  } else if (align === 'end') {
    next = rowBottom - viewportHeight
  } else if (align === 'center') {
    next = rowTop - viewportHeight / 2 + rowHeight / 2
  } else {
    if (rowTop < current) next = rowTop
    else if (rowBottom > current + viewportHeight) next = rowBottom - viewportHeight
  }

  // 回到「容器 scrollTop」坐标系：内容坐标 + headerOffset
  return clampScrollTop(next, total, rowHeight, viewportHeight) + headerOffset
}

/** 可见行区间内的序号数组（渲染用；空列表返回空数组） */
export function rangeIndexes(range: VisibleRange): number[] {
  if (range.endIndex < range.startIndex) return []
  const out: number[] = []
  for (let i = range.startIndex; i <= range.endIndex; i++) out.push(i)
  return out
}

/**
 * 按行高数组（不等高行）计算可见区间。
 * 画本剧本视图里，长台词行会折行变高，用等行高的估算会错位，
 * 因此这里提供「前缀和 + 二分」的版本。
 */
export function computeVisibleRangeVariable(input: {
  scrollTop: number
  viewportHeight: number
  /** 每行高度（长度即总行数） */
  rowHeights: readonly number[]
  overscan?: number
}): VisibleRange {
  const heights = input.rowHeights
  const total = heights.length
  const overscan = Math.max(0, safeInt(input.overscan ?? DEFAULTS.overscan))
  const viewportHeight = Number.isFinite(input.viewportHeight) ? Math.max(0, input.viewportHeight) : 0

  // 前缀和：offsets[i] = 第 i 行顶部
  const offsets = new Array<number>(total + 1)
  offsets[0] = 0
  for (let i = 0; i < total; i++) {
    const h = Number.isFinite(heights[i]) && (heights[i] as number) > 0 ? (heights[i] as number) : 0
    offsets[i + 1] = offsets[i]! + h
  }
  const totalHeight = offsets[total] ?? 0
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  const clampedScrollTop = Math.min(Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0), maxScroll)
  const avg = total > 0 ? totalHeight / total : 1

  if (total === 0) {
    return {
      startIndex: 0, endIndex: -1, visibleStartIndex: 0, visibleEndIndex: -1,
      paddingTop: 0, paddingBottom: 0, totalHeight: 0, renderCount: 0,
      clampedScrollTop, maxScrollTop: 0, degenerate: viewportHeight <= 0,
    }
  }

  const binarySearch = (y: number): number => {
    let lo = 0
    let hi = total - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((offsets[mid + 1] ?? 0) > y) { ans = mid; hi = mid - 1 } else { lo = mid + 1 }
    }
    return ans
  }

  const firstVisible = binarySearch(clampedScrollTop)
  const lastVisible = binarySearch(clampedScrollTop + Math.max(1, viewportHeight) - 1)
  const startIndex = Math.max(0, firstVisible - overscan)
  const endIndex = Math.min(total - 1, lastVisible + overscan)

  return {
    startIndex,
    endIndex,
    visibleStartIndex: firstVisible,
    visibleEndIndex: lastVisible,
    paddingTop: offsets[startIndex] ?? 0,
    paddingBottom: Math.max(0, totalHeight - (offsets[endIndex + 1] ?? totalHeight)),
    totalHeight,
    renderCount: endIndex - startIndex + 1,
    clampedScrollTop,
    maxScrollTop: maxScroll,
    degenerate: viewportHeight <= 0 || !Number.isFinite(avg),
  }
}
