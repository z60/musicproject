/**
 * 对轨域 · 「文本参照」列表的数据装配（纯逻辑 + 很薄的 composable）
 * ============================================================================
 * 真机需求：「对轨模块 需要添加可以听 并且可以参照文本的功能」。
 *
 * 对轨这件事本质上是**拿耳朵对着文字**检查：听得见 + 看得见这一行的原文，
 * 才知道音频有没有对上。时间线上只画了波形与「前 10 个字」，看不了整句，
 * 所以这里把「画本行 + 它在时间线上的位置」装配成一张可点、可听、可筛选的清单。
 *
 * 为什么把逻辑放在这里而不是写在 .vue 里：
 *   本仓库的渲染进程没有 DOM 测试环境（tests/renderer 里都是「读源码断言」），
 *   所以**能测的部分要留在纯函数里** —— 行装配、播放头命中、文本筛选都在这里，
 *   .vue 只负责渲染与事件转发。
 *
 * 本文件不碰音频、不碰 IPC：音频由 `usePlaybackScheduler` 播，这里只描述「有哪些行」。
 */

import { computed, type ComputedRef, type Ref } from 'vue'
import type { ArrangementItem, CanvasLine, Id, TrackId } from '@shared/types.ts'
/**
 * ★ 用**相对路径**而不是 `@shared/...`：本模块要被 tests/renderer 直接 import，
 *   而 node 测试运行时没有别名解析（渲染进程里被测试的模块都遵守这条）。
 */
import { itemDurationMs } from '../../../../../shared/arrange/layout.ts'

/** 一行在参照列表里的状态 */
export type ScriptRowState =
  /** 有排布结果、也有音频文件 —— 可以点 ▶ 试听 */
  | 'arranged'
  /** 画本里有这一行，但排布结果里没有（缺录 / 还没自动对轨） */
  | 'missing'
  /** 有排布结果，但解析不到音频文件（录音页没生成片段 / 文件丢了） */
  | 'no-audio'

export interface ScriptRow {
  lineId: Id
  /** 画本行号（章节内序号） */
  seq: number
  /** 画本原文（**不截断** —— 参照文本就是它的意义） */
  text: string
  /** 排布结果里的片段 id；`missing` 时为 null */
  itemId: Id | null
  trackId: TrackId | null
  /** 时间线起止（毫秒）；`missing` 时为 null */
  startMs: number | null
  endMs: number | null
  state: ScriptRowState
  /** 画本自己标了「待确认」（docs/11）—— 顺带在参照列表里提示 */
  needsReview: boolean
}

export interface BuildScriptRowsInput {
  /** 本章画本行（**全部**，不只是有排布结果的） */
  lines: readonly CanvasLine[]
  /** lineId → 排布片段 */
  itemByLineId: ReadonlyMap<Id, ArrangementItem>
  /** 该片段是否有可播放的音频（false → 行内禁用试听并说明原因） */
  hasAudio: (item: ArrangementItem) => boolean
}

/**
 * 按画本顺序装配参照行。
 *
 * ★ 用**画本行**做基准而不是「有排布结果的片段」：缺录的行同样要出现在清单里
 *   （否则用户只会看到「少了几句」，却不知道少了哪几句）。
 */
export function buildScriptRows(input: BuildScriptRowsInput): ScriptRow[] {
  const rows: ScriptRow[] = []
  const sorted = [...input.lines].sort((a, b) => a.seq - b.seq)
  for (const line of sorted) {
    const item = input.itemByLineId.get(line.id) ?? null
    const text = String(line.text ?? '').replace(/\s+/g, ' ').trim()
    if (!item) {
      rows.push({
        lineId: line.id,
        seq: line.seq,
        text,
        itemId: null,
        trackId: null,
        startMs: null,
        endMs: null,
        state: 'missing',
        needsReview: line.needsReview === true,
      })
      continue
    }
    const startMs = Math.max(0, Math.round(item.timelineStartMs))
    const durationMs = Math.max(0, Math.round(itemDurationMs(item)))
    const playable = input.hasAudio(item)
    rows.push({
      lineId: line.id,
      seq: line.seq,
      text,
      itemId: item.id,
      trackId: item.trackId,
      startMs,
      endMs: startMs + durationMs,
      state: playable ? 'arranged' : 'no-audio',
      needsReview: line.needsReview === true,
    })
  }
  return rows
}

/**
 * 播放头此刻落在哪一行（返回下标；没有则 -1）。
 *
 * 时间上重叠时取**起点最晚**的那一行：跟随播放头时，用户想看到的通常是
 * 「刚开始的这一句」，而不是已经放完的上一句。
 */
export function rowIndexAtTime(rows: readonly ScriptRow[], ms: number): number {
  let best = -1
  let bestStart = Number.NEGATIVE_INFINITY
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (row.startMs === null || row.endMs === null) continue
    if (ms < row.startMs || ms >= row.endMs) continue
    if (row.startMs >= bestStart) {
      best = i
      bestStart = row.startMs
    }
  }
  return best
}

/** 文本筛选：空查询返回全部；匹配原文或行号（`#12` / `12` 都行） */
export function filterScriptRows(rows: readonly ScriptRow[], query: string): ScriptRow[] {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return [...rows]
  const seqQuery = q.startsWith('#') ? q.slice(1) : q
  return rows.filter((row) => row.text.toLowerCase().includes(q) || String(row.seq) === seqQuery)
}

export interface ScriptReferenceOptions {
  lines: Ref<readonly CanvasLine[]>
  itemByLineId: Ref<ReadonlyMap<Id, ArrangementItem>>
  hasAudio: (item: ArrangementItem) => boolean
  /** 播放头（毫秒）—— 用来高亮「正在放的那一行」 */
  playheadMs: Ref<number>
  /** 文本筛选词 */
  query: Ref<string>
}

export interface ScriptReferenceApi {
  /** 全部参照行（画本顺序） */
  rows: ComputedRef<ScriptRow[]>
  /** 筛选后的行（渲染用） */
  visibleRows: ComputedRef<ScriptRow[]>
  /** 播放头所在行在 **rows** 里的下标（-1 = 不在任何一行里） */
  activeRowIndex: ComputedRef<number>
  /** 播放头所在行的 lineId */
  activeLineId: ComputedRef<Id | null>
  /** 可试听的行数（状态条用） */
  playableCount: ComputedRef<number>
  /** 缺录 / 无音频的行数 */
  problemCount: ComputedRef<number>
}

export function useScriptReference(options: ScriptReferenceOptions): ScriptReferenceApi {
  const rows = computed<ScriptRow[]>(() =>
    buildScriptRows({
      lines: options.lines.value,
      itemByLineId: options.itemByLineId.value,
      hasAudio: options.hasAudio,
    }),
  )
  const visibleRows = computed<ScriptRow[]>(() => filterScriptRows(rows.value, options.query.value))
  const activeRowIndex = computed<number>(() => rowIndexAtTime(rows.value, options.playheadMs.value))
  const activeLineId = computed<Id | null>(() =>
    activeRowIndex.value >= 0 ? (rows.value[activeRowIndex.value]?.lineId ?? null) : null,
  )
  const playableCount = computed<number>(() => rows.value.filter((row) => row.state === 'arranged').length)
  const problemCount = computed<number>(() => rows.value.filter((row) => row.state !== 'arranged').length)
  return { rows, visibleRows, activeRowIndex, activeLineId, playableCount, problemCount }
}
