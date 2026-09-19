/**
 * 画本编辑域 · 筛选（按说话人 / 情绪 / 状态 / 类型 / 标志位 / 待确认）
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md §4.7
 *   > 筛选后（例如「说话人=unknown 且 kind=dialogue」）可执行批量操作……
 *
 * 三个必须做对的地方：
 *   1. 筛选结果**只影响显示与批量作用范围**，不影响数据本身（绝不因为筛选而少写库）。
 *   2. 软删除行（flags 含 `deleted`）默认不显示 —— 否则合并旁白之后表格里全是重复行。
 *   3. 「作用范围」必须在批量条上写清楚：筛选后有多少行会被改（docs/11 §4.7 要求影响行数预览）。
 *
 * 本文件不碰 IPC、不持有行数据：把 `lines` 传进来即可，方便在视图与批量条之间共享同一份筛选。
 */

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { CanvasLine, Id, LineKind, LineState } from '@shared/types.ts'
import { EMOTIONS, LINE_KIND_LABELS, LINE_STATE_LABELS } from '@shared/constants.ts'
import { CANVAS_FLAG_LABELS } from '../stores/canvas.store.ts'

/** 说话人维度的特殊取值（除角色 id 之外） */
export const SPEAKER_ANY = 'all'
export const SPEAKER_UNKNOWN = 'unknown'
export const SPEAKER_NARRATION = 'narration'

export interface CanvasFilter {
  /** 'all' = 不限；'unknown' = 未分配；'narration' = 旁白；其余为角色 id */
  speaker: string
  /** null = 不限 */
  emotion: string | null
  /** null = 不限 */
  state: LineState | null
  /** null = 不限 */
  kind: LineKind | null
  /** 必须同时包含这些标志位 */
  flags: string[]
  /** true = 只看待确认；false = 只看已确认；null = 不限 */
  needsReview: boolean | null
  /** 文本关键字（行文本或原文片段） */
  keyword: string
  /** 是否显示软删除行（默认否） */
  includeDeleted: boolean
}

export interface CanvasFilterCounts {
  /** 数据总行数 */
  total: number
  /** 筛选后可见行数（= 批量操作作用范围） */
  shown: number
  /** 被筛掉的行数 */
  hidden: number
  /** 其中被软删除的 */
  deleted: number
  byKind: Record<string, number>
  byState: Record<string, number>
  /** 筛选结果里的待确认行数 */
  needsReview: number
}

export interface UseCanvasFilter {
  filter: Ref<CanvasFilter>
  filtered: ComputedRef<CanvasLine[]>
  counts: ComputedRef<CanvasFilterCounts>
  /** 是否处于「有筛选」状态（批量条只在有筛选或选中时出现） */
  isActive: ComputedRef<boolean>
  /** 人类可读的筛选摘要（批量条上写「作用范围」用） */
  summary: ComputedRef<string[]>
  /** 数据里实际出现过的标志位（下拉选项用，避免列出一堆用不上的） */
  flagOptions: ComputedRef<Array<{ value: string; label: string }>>
  kindOptions: Array<{ value: LineKind; label: string }>
  stateOptions: Array<{ value: LineState; label: string }>
  emotionOptions: readonly string[]
  set: (patch: Partial<CanvasFilter>) => void
  reset: () => void
  /** 判断单行是否命中（表格行渲染时也可能用） */
  matches: (line: CanvasLine) => boolean
  /** 只保留仍存在的选中项（筛选变化后清理选中集） */
  pruneSelection: (selected: Set<Id>) => Set<Id>
}

function createFilter(): CanvasFilter {
  return {
    speaker: SPEAKER_ANY,
    emotion: null,
    state: null,
    kind: null,
    flags: [],
    needsReview: null,
    keyword: '',
    includeDeleted: false,
  }
}

/**
 * 行数据的来源。**推荐传 getter**（`() => canvas.lines`）。
 *
 * ⚠️ 这里曾经只收「Ref 或普通数组」，并用 `computed(() => Array.isArray(source) ? source : source.value)`
 * 归一 —— 这条写法有个**静默的致命缺陷**（真机事故，docs/91 §5.2.27）：
 * Pinia 的 setup store 会把 `ref` 解包，所以 `canvas.lines` 拿到的是**当时的那个数组对象**。
 * `computed(() => source)` 的求值体**不读任何响应式属性**，因此它永远不会重新求值；
 * 而 `canvas.load()` 是 `lines.value = collected`（**整体重赋值**），旧数组对象永远是空的。
 * 结果：表格恒显示「当前筛选下没有行」，而库里 85 行都在。
 *
 * 现在的规则：
 *   · `() => CanvasLine[]`（推荐）—— 每次求值都重新读 store，**跟随重赋值与增删**；
 *   · `Ref` / `ComputedRef` —— 正常工作；
 *   · 普通数组 —— 只是**一次性快照**（无法响应式），开发期给一条 warn 指明正确写法。
 */
export type CanvasLineSource =
  | Ref<CanvasLine[]>
  | ComputedRef<CanvasLine[]>
  | (() => CanvasLine[])
  | CanvasLine[]

let warnedPlainArray = false

/**
 * @param source 行数据来源，见 {@link CanvasLineSource}。内部统一归一成 `ComputedRef`。
 */
export function useCanvasFilter(source: CanvasLineSource): UseCanvasFilter {
  const lines = computed<CanvasLine[]>(() => {
    if (typeof source === 'function') return source()
    if (Array.isArray(source)) {
      // 普通数组没有响应式能力：只在开发期提示一次，不静默地给出「永远是空的」视图
      if (!warnedPlainArray && typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
        warnedPlainArray = true
        console.warn(
          '[useCanvasFilter] 传入的是普通数组，它只是快照、不会跟随 store 更新。' +
            '请改传 getter：useCanvasFilter(() => canvas.lines)',
        )
      }
      return source
    }
    return source.value
  })
  const filter = ref<CanvasFilter>(createFilter())

  const kindOptions = (Object.keys(LINE_KIND_LABELS) as LineKind[]).map(value => ({
    value,
    label: LINE_KIND_LABELS[value] ?? value,
  }))
  const stateOptions = (Object.keys(LINE_STATE_LABELS) as LineState[]).map(value => ({
    value,
    label: LINE_STATE_LABELS[value] ?? value,
  }))

  function matches(line: CanvasLine): boolean {
    const f = filter.value

    if (!f.includeDeleted && line.flags.includes('deleted')) return false

    if (f.speaker !== SPEAKER_ANY) {
      if (f.speaker === SPEAKER_UNKNOWN) {
        if (!(line.kind === 'dialogue' && !line.characterId)) return false
      } else if (f.speaker === SPEAKER_NARRATION) {
        if (line.speakerType !== 'narration') return false
      } else if (line.characterId !== f.speaker) {
        return false
      }
    }

    if (f.emotion !== null) {
      if (f.emotion === '__none__') {
        if (line.emotion) return false
      } else if (line.emotion !== f.emotion) {
        return false
      }
    }

    if (f.state !== null && line.state !== f.state) return false
    if (f.kind !== null && line.kind !== f.kind) return false
    if (f.needsReview !== null && line.needsReview !== f.needsReview) return false

    if (f.flags.length) {
      for (const flag of f.flags) {
        if (!line.flags.includes(flag)) return false
      }
    }

    if (f.keyword.trim()) {
      const keyword = f.keyword.trim().toLowerCase()
      const haystack = `${line.text}\n${line.sourceText ?? ''}`.toLowerCase()
      if (!haystack.includes(keyword)) return false
    }

    return true
  }

  const filtered = computed(() => lines.value.filter(matches))

  const counts = computed<CanvasFilterCounts>(() => {
    const all = lines.value
    const shown = filtered.value
    const byKind: Record<string, number> = {}
    const byState: Record<string, number> = {}
    let needsReview = 0
    for (const line of shown) {
      byKind[line.kind] = (byKind[line.kind] ?? 0) + 1
      byState[line.state] = (byState[line.state] ?? 0) + 1
      if (line.needsReview) needsReview += 1
    }
    return {
      total: all.length,
      shown: shown.length,
      hidden: all.length - shown.length,
      deleted: all.filter(l => l.flags.includes('deleted')).length,
      byKind,
      byState,
      needsReview,
    }
  })

  const isActive = computed(() => {
    const f = filter.value
    return f.speaker !== SPEAKER_ANY
      || f.emotion !== null
      || f.state !== null
      || f.kind !== null
      || f.flags.length > 0
      || f.needsReview !== null
      || Boolean(f.keyword.trim())
      || f.includeDeleted
  })

  const summary = computed<string[]>(() => {
    const f = filter.value
    const parts: string[] = []
    if (f.speaker !== SPEAKER_ANY) {
      parts.push(f.speaker === SPEAKER_UNKNOWN ? '说话人=未分配'
        : f.speaker === SPEAKER_NARRATION ? '说话人=旁白'
          : '指定角色')
    }
    if (f.emotion !== null) parts.push(f.emotion === '__none__' ? '情绪=未设' : `情绪=${f.emotion}`)
    if (f.kind !== null) parts.push(`类型=${LINE_KIND_LABELS[f.kind] ?? f.kind}`)
    if (f.state !== null) parts.push(`状态=${LINE_STATE_LABELS[f.state] ?? f.state}`)
    if (f.needsReview !== null) parts.push(f.needsReview ? '仅待确认' : '仅已确认')
    for (const flag of f.flags) parts.push(`标记=${CANVAS_FLAG_LABELS[flag] ?? flag}`)
    if (f.keyword.trim()) parts.push(`关键字「${f.keyword.trim()}」`)
    if (f.includeDeleted) parts.push('含已删除')
    return parts
  })

  const flagOptions = computed(() => {
    const present = new Set<string>()
    for (const line of lines.value) {
      for (const flag of line.flags) present.add(flag)
    }
    // 数据里没出现过的也列出常用的（用户可能是想筛「一个都没有」）
    for (const flag of ['too_long', 'quote_unmatched', 'locked', 'deleted']) present.add(flag)
    return [...present]
      .sort()
      .map(value => ({ value, label: CANVAS_FLAG_LABELS[value] ?? value }))
  })

  function set(patch: Partial<CanvasFilter>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function reset(): void {
    filter.value = createFilter()
  }

  /** 筛选变化后，把已经被筛掉的选中项移除（避免批量操作改了看不见的行） */
  function pruneSelection(selected: Set<Id>): Set<Id> {
    const visible = new Set(filtered.value.map(l => l.id))
    const next = new Set<Id>()
    for (const id of selected) {
      if (visible.has(id)) next.add(id)
    }
    return next
  }

  return {
    filter,
    filtered,
    counts,
    isActive,
    summary,
    flagOptions,
    kindOptions,
    stateOptions,
    emotionOptions: EMOTIONS,
    set,
    reset,
    matches,
    pruneSelection,
  }
}
