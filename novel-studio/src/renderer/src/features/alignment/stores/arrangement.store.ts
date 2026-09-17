/**
 * 对轨域 · 方案与 items（含脏标记、批量提交与独立撤销栈）
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md
 *   · §2   数据模型（Arrangement / ArrangementItem）
 *   · §4.1 轨道构成：旁白轨固定第一，其余按出场；BGM/音效轨来自 BusKind（混音域）
 *   · §4.6 性能：1000 个 item 下拖动 ≥ 30 fps —— 因此本 store 用
 *          `shallowRef` + 显式索引（Map）而不是深层响应式大数组
 *   · §4.7 手动微调（拖左边缘的语义陷阱在 useTimelineInteraction 里实现）
 *   · §4.8 撤销/重做：**对轨有独立 undo 栈（≥50 步）**，批量操作算一条命令
 *   · §7   多方案：一个章节可以有多个 arrangement，切换视图整体切换
 *   · §11  异常：文件丢失 / 画本改过 / 方案被导出引用
 * 算法实现依据：docs/05 §5.2（自动排布）、§5.3（静音修剪）、§5.4（手动微调）
 *
 * 三条纪律：
 *   1. **时间/裁剪的算术一律复用 `@shared/arrange/`**（`itemDurationMs` /
 *      `moveItemTo` / `resizeLeftEdge` / `resizeRightEdge` / `applyItemPatch`），
 *      渲染侧绝不自己写第二份，否则时间线显示与 ffmpeg 渲染结果会差出 10 ms × N
 *      （docs/05 §5.2 明确要求 `itemDurationMs` 是唯一来源）。
 *   2. 拖动过程中**只改内存**（`patchLocalInPlace`），松手才经
 *      `createBatchQueue` → `alignment:batchUpdateItems` 落库（一次事务）；
 *      `Ctrl+S` 强制冲刷。失败必须让用户看到「改动仍在内存中」（docs/11 §4.9）。
 *   3. 每个会改变 items 的用户操作都要产生**一条** undo 命令（批量消解 = 一条），
 *      undo/redo 只做「本地还原 + 重新入批量队列」，不再调一次业务 IPC。
 */

import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type {
  Arrangement,
  ArrangementItem,
  ArrangementItemPatch,
  ArrangeStrategy,
  CanvasLine,
  Chapter,
  Character,
  Id,
  MixProject,
  Take,
  TrackId,
} from '@shared/types.ts'
import { NARRATION_TRACK_ID } from '@shared/types.ts'
import { ARRANGE_DEFAULTS, TRIM_DEFAULTS } from '@shared/constants.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { reportError } from '@/shared/lib/error-bus.ts'
import { createBatchQueue } from '@/shared/lib/editable-debounce.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import { computeChapterDuration, itemDurationMs, itemEndMs } from '@shared/arrange/layout.ts'
import { moveItem, resizeLeftEdge } from '@shared/arrange/manual.ts'
import { detectOverlaps, resolveOverlap as resolveOverlapPure } from '@shared/arrange/overlap.ts'
import { useTimelineStore } from './timeline.store.ts'

// ---------------------------------------------------------------------------
// 契约收口：渲染进程本地 IpcContract 用索引签名把 res 抹成了 unknown
// ---------------------------------------------------------------------------
/**
 * 类型化 invoke。
 *
 * 背景（这是本次实现发现的契约不一致，务必看清）：
 *   `src/renderer/src/shared/lib/ipc.ts` 里的 `IpcContract` 只有若干显式通道 +
 *   一条 `[channel: string]: { req: unknown; res: unknown }` 的索引签名，
 *   因此 `keyof IpcContract` 退化成 `string`，`call('alignment:get', …)` 的返回
 *   类型是 `unknown`（不是 `src/shared/ipc.ts` 里那份真契约的 `{ arrangement, items }`）。
 *   为「不绕过 call()」（禁止 window.api.*）且不在每个调用点写 `as unknown as X`，
 *   在这里集中收口一次，并把真实返回类型写在泛型上。
 *   上游把 IpcContract 换成从 `@shared/ipc.ts` 生成的真实契约后，这两个小函数可以直接删掉。
 */
export async function callTyped<T>(channel: string, payload?: unknown): Promise<T> {
  return await call(channel, payload) as unknown as T
}

/** 同上，但失败返回 null（用于「这类数据没有也能用」的上下文加载，如角色配色） */
export async function callTypedSafe<T>(channel: string, payload?: unknown): Promise<T | null> {
  const result = await callSafe(channel, payload)
  return (result ?? null) as unknown as T | null
}

// ---------------------------------------------------------------------------
// 展示类型
// ---------------------------------------------------------------------------

/** 轨道种类（docs/13 §4.1：旁白 / 角色 / BGM / 音效） */
export type TrackKind = 'narration' | 'character' | 'music' | 'sfx' | 'unknown'

/** 一条轨道的视图模型（渲染在 TrackHeader，颜色用于 Canvas 片段） */
export interface TrackView {
  trackId: TrackId
  /** 中文名：旁白 / 角色名 / 「未识别轨道」 */
  name: string
  kind: TrackKind
  /** 片段填充色（角色色优先，缺省按调色板分配） */
  color: string
  characterId: Id | null
  /** 角色被归档后仍有 item（docs/13 §11）：轨道头要标注，但仍可播放 */
  isArchived: boolean
  itemCount: number
  /** 该轨最后一个 item 的结束时间（状态条显示用） */
  endMs: number
}

/** 片段音频来源（试听与波形 peaks 都用它；拿不到就返回 null，绝不猜路径） */
export interface SegmentSource {
  /** 缓存键：processed 与原始文件分开缓存 */
  key: string
  segmentId: Id
  lineId: Id
  /** 相对项目根的路径（ns-media:// 与 analysis:peaks 都用相对路径） */
  path: string
  isProcessed: boolean
  /** 源文件时长（用于夹紧 srcIn/srcOut 与右边缘拖动） */
  durationMs: number | null
}

/** 一条待提交的改动（批量队列的元素） */
export interface ItemChange {
  itemId: Id
  patch: ArrangementItemPatch
}

/**
 * 预演结果的一条改动。
 *
 * 必须带上 `kind`：`'move' | 'resize' | 'noop'` 之类的语义区分决定了 UI 该怎么描述
 * （「移动 +120 ms」vs「缩短 80 ms」）。早期这里把 `kind` 丢掉了，导致
 * `useOverlapResolver` 里的 `c.kind === 'move'` 报 TS2339。
 */
export interface OverlapPreviewChange {
  /** 与 `shared/arrange/overlap.ts` 的 changes.kind 一致 */
  kind: 'move' | 'trim-tail' | 'none'
  itemId: Id
  deltaMs: number
  reason: string
}

/** 撤销命令：只存「受影响 item 的前后快照」，批量操作也只是一条 */
export interface AlignmentCommand {
  id: string
  /** 展示名（「拖动片段」「批量消解重叠 5 处」…） */
  label: string
  /** 受影响 item 数（UI 显示「撤销整批（N 段）」） */
  affected: number
  before: ArrangementItem[]
  after: ArrangementItem[]
  at: number
}

/** 撤销栈深度：docs/13 §4.8 要求 ≥50 */
export const UNDO_CAPACITY = 60

/** 批量提交的合并窗口：拖动结束后的多次微调合并成一次 IPC（docs/13 §11「限制批量操作提交频率」） */
const COMMIT_FLUSH_MS = 400

/** 默认轨道配色（角色没有 color 时按调色板分配，纯展示用） */
export const TRACK_PALETTE = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#9254de', '#13c2c2', '#fa8c16', '#2f54eb'] as const
export const NARRATION_COLOR = '#8a94a6'

function nextCommandId(): string {
  return `align_cmd_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** 合并同一 item 的多条 patch（后者覆盖前者的同名字段） */
function mergeChanges(list: ItemChange[]): ItemChange[] {
  const map = new Map<Id, ArrangementItemPatch>()
  const order: Id[] = []
  for (const change of list) {
    const existing = map.get(change.itemId)
    if (existing) map.set(change.itemId, { ...existing, ...change.patch })
    else {
      map.set(change.itemId, { ...change.patch })
      order.push(change.itemId)
    }
  }
  return order.map(itemId => ({ itemId, patch: map.get(itemId) as ArrangementItemPatch }))
}

/** 从两个 items 数组算出「最小 patch 集合」（撤销命令与批量提交共用） */
function diffItems(before: ArrangementItem[], after: ArrangementItem[]): ItemChange[] {
  const beforeById = new Map(before.map(i => [i.id, i]))
  const changes: ItemChange[] = []
  for (const item of after) {
    const old = beforeById.get(item.id)
    if (!old) continue
    const patch: ArrangementItemPatch = {}
    if (item.timelineStartMs !== old.timelineStartMs) patch.timelineStartMs = item.timelineStartMs
    if (item.srcInMs !== old.srcInMs) patch.srcInMs = item.srcInMs
    if (item.srcOutMs !== old.srcOutMs) patch.srcOutMs = item.srcOutMs
    if (item.fadeInMs !== old.fadeInMs) patch.fadeInMs = item.fadeInMs
    if (item.fadeOutMs !== old.fadeOutMs) patch.fadeOutMs = item.fadeOutMs
    if (item.locked !== old.locked) patch.locked = item.locked
    if (Object.keys(patch).length) changes.push({ itemId: item.id, patch })
  }
  return changes
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useArrangementStore = defineStore('alignment/arrangement', () => {
  const timeline = useTimelineStore()

  // ── 方案（docs/13 §7） ──────────────────────────────────────────────────
  const arrangements = ref<Arrangement[]>([])
  const arrangement = ref<Arrangement | null>(null)
  const loading = ref(false)
  const lastError = ref<unknown>(null)

  // ── items（浅引用 + 显式索引，见文件头纪律 2） ──────────────────────────
  const items = shallowRef<ArrangementItem[]>([])
  /** itemId → item */
  const itemsById = shallowRef<Map<Id, ArrangementItem>>(new Map())
  /** trackId → items（按 timelineStartMs 升序，供命中检测二分查找） */
  const itemsByTrack = shallowRef<Map<TrackId, ArrangementItem[]>>(new Map())
  /** 轨道顺序因原地拖动而可能失序，命中检测前按需重建（见 ensureSortedIndex） */
  const indexDirty = ref(false)
  /** 拖动中每帧原地改 item，用它驱动状态条等 UI 重算（不换数组身份，避免 O(n) 每帧） */
  const dragRevision = ref(0)

  // ── 上下文（画本行 / 角色 / take / 混音方案） ───────────────────────────
  const chapter = ref<Chapter | null>(null)
  const lines = shallowRef<CanvasLine[]>([])
  const characters = shallowRef<Character[]>([])
  const takes = shallowRef<Take[]>([])
  const mixProjects = ref<MixProject[]>([])
  /** lineId → 画本行（命中检测、Inspector、校验都要用） */
  const lineById = shallowRef<Map<Id, CanvasLine>>(new Map())
  /** lineId → take（段落音频文件的唯一可得来源，见 resolveSource 的说明） */
  const takeByLine = shallowRef<Map<Id, Take>>(new Map())
  /** segmentId → processedPath（process:listApplied 的结果，试听「处理后」用） */
  const processedBySegment = shallowRef<Map<Id, string>>(new Map())

  /** 「自动排布基线」：重置单个片段 / 单轨时回到这里 */
  const autoBaseline = shallowRef<Map<Id, ArrangementItem>>(new Map())

  // ── 撤销栈（独立于画本编辑域的撤销栈，docs/13 §4.8） ────────────────────
  const undoStack = shallowRef<AlignmentCommand[]>([])
  const redoStack = shallowRef<AlignmentCommand[]>([])

  // ── 保存状态（AutoSaveIndicator 三态 + 失败必须可见） ───────────────────
  const saveStatus = ref<SaveStatus>('idle')
  const lastSavedAt = ref<number | null>(null)
  const lastErrorText = ref<string | null>(null)

  // ── 索引重建 ────────────────────────────────────────────────────────────

  function rebuildIndexes(next: ArrangementItem[], markSorted = true): void {
    const byId = new Map<Id, ArrangementItem>()
    const byTrack = new Map<TrackId, ArrangementItem[]>()
    for (const item of next) {
      byId.set(item.id, item)
      const list = byTrack.get(item.trackId)
      if (list) list.push(item)
      else byTrack.set(item.trackId, [item])
    }
    if (markSorted) {
      for (const list of byTrack.values()) {
        list.sort((a, b) => a.timelineStartMs - b.timelineStartMs || a.orderInTrack - b.orderInTrack)
      }
      indexDirty.value = false
    }
    itemsById.value = byId
    itemsByTrack.value = byTrack
  }

  /** 用新数组整体替换 items（保持响应式身份变化，供 computed 重算） */
  function setItems(next: ArrangementItem[], markSorted = true): void {
    items.value = next
    rebuildIndexes(next, markSorted)
  }

  /**
   * 命中检测前的按需重建排序索引。
   * 拖动时 item 是**原地**改的（性能），所以轨内顺序可能暂时失序；
   * 二分查找要求有序，因此在触摸索引前先确保一次。
   */
  function ensureSortedIndex(): void {
    if (!indexDirty.value) return
    rebuildIndexes(items.value, true)
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  function itemById(id: Id | null | undefined): ArrangementItem | null {
    if (!id) return null
    return itemsById.value.get(id) ?? null
  }

  function trackItems(trackId: TrackId): ArrangementItem[] {
    return itemsByTrack.value.get(trackId) ?? []
  }

  function lineOf(item: ArrangementItem | null): CanvasLine | null {
    if (!item) return null
    return lineById.value.get(item.lineId) ?? null
  }

  /** 画本行文本前 N 字（docs/13 §4.6：item 上叠加行号与文本首 10 字） */
  function lineLabel(item: ArrangementItem, maxChars = 10): string {
    const line = lineOf(item)
    if (!line) return ''
    const text = (line.text ?? '').replace(/\s+/g, ' ').trim()
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  }

  function lineSeq(item: ArrangementItem): number | null {
    return lineOf(item)?.seq ?? null
  }

  /**
   * 片段音频来源解析。
   *
   * ★ 契约现状（本次实现发现的缺口，已按「不造假数据」处理）：
   *   IPC 里**没有**「按章节列出 voice_segments」的通道（`take:listByChapter` 返回的是
   *   Take，其主键是 takeId 而不是 segmentId）。因此这里用「lineId → take」映射把
   *   item 的 segmentId 关联到实际音频文件；拿不到 take 时返回 null —— 时间线上不画波形、
   *   试听按钮禁用，并在 Inspector 里说明「该片段没有可用的音频文件」。
   *   处理后的文件（processed_path）来自 `process:listApplied({ segmentIds })`。
   */
  function resolveSource(item: ArrangementItem | null, preferProcessed = false): SegmentSource | null {
    if (!item) return null
    const processedPath = processedBySegment.value.get(item.segmentId) ?? null
    if (preferProcessed && processedPath) {
      return {
        key: `seg:${item.segmentId}:processed`,
        segmentId: item.segmentId,
        lineId: item.lineId,
        path: processedPath,
        isProcessed: true,
        durationMs: takeByLine.value.get(item.lineId)?.durationMs ?? null,
      }
    }
    const take = takeByLine.value.get(item.lineId)
    if (!take) return null
    return {
      key: `seg:${item.segmentId}:raw`,
      segmentId: item.segmentId,
      lineId: item.lineId,
      path: take.filePath,
      isProcessed: false,
      durationMs: Number.isFinite(take.durationMs) ? take.durationMs : null,
    }
  }

  // ── 轨道视图模型（docs/13 §4.1） ────────────────────────────────────────

  const tracks = computed<TrackView[]>(() => {
    const list = items.value
    const seen = new Map<TrackId, TrackView>()
    const characterById = new Map(characters.value.map(c => [c.id, c]))
    /** 角色 → 调色板下标（一次算好，避免每个 item 都 findIndex 一遍） */
    const characterIndex = new Map<Id, number>()
    characters.value.forEach((c, index) => characterIndex.set(c.id, index))

    for (const item of list) {
      const existing = seen.get(item.trackId)
      const end = itemEndMs(item)
      if (existing) {
        existing.itemCount += 1
        if (end > existing.endMs) existing.endMs = end
        continue
      }
      const kind: TrackKind = item.trackId === NARRATION_TRACK_ID
        ? 'narration'
        : /^bgm/i.test(item.trackId)
          ? 'music'
          : /^sfx/i.test(item.trackId)
            ? 'sfx'
            : 'character'
      // 轨道名：旁白 / 角色名 / 未识别（绝不编造角色名）
      const character = kind === 'character' ? characterById.get(item.trackId) ?? null : null
      const charIndex = character ? characterIndex.get(character.id) ?? 0 : seen.size
      const color = kind === 'narration'
        ? NARRATION_COLOR
        : character?.color ?? TRACK_PALETTE[Math.max(0, charIndex) % TRACK_PALETTE.length] ?? TRACK_PALETTE[0]
      seen.set(item.trackId, {
        trackId: item.trackId,
        name: kind === 'narration'
          ? '旁白'
          : character?.name ?? (kind === 'music' ? 'BGM' : kind === 'sfx' ? '音效' : '未识别轨道'),
        kind,
        color,
        characterId: character?.id ?? null,
        isArchived: character?.isArchived ?? false,
        itemCount: 1,
        endMs: end,
      })
    }

    // 出场顺序：画本 seq 最小的排前面（layout.ts 的 orderTracks 同口径）；无行信息时按时间
    const firstSeq = new Map<TrackId, number>()
    for (const item of list) {
      const seq = lineSeq(item) ?? Number.MAX_SAFE_INTEGER
      const cur = firstSeq.get(item.trackId)
      if (cur === undefined || seq < cur) firstSeq.set(item.trackId, seq)
    }

    const preferred = timeline.trackOrderPreference
    const result = [...seen.values()]
    result.sort((a, b) => {
      if (a.trackId === NARRATION_TRACK_ID) return -1
      if (b.trackId === NARRATION_TRACK_ID) return 1
      const ia = preferred.indexOf(a.trackId)
      const ib = preferred.indexOf(b.trackId)
      if (ia >= 0 || ib >= 0) {
        if (ia < 0) return 1
        if (ib < 0) return -1
        if (ia !== ib) return ia - ib
      }
      const sa = firstSeq.get(a.trackId) ?? Number.MAX_SAFE_INTEGER
      const sb = firstSeq.get(b.trackId) ?? Number.MAX_SAFE_INTEGER
      if (sa !== sb) return sa - sb
      return a.trackId < b.trackId ? -1 : 1
    })
    return result
  })

  /** 章节总时长：与导出/渲染同一口径（docs/05 §5.2 要求唯一来源） */
  const totalDurationMs = computed(() => computeChapterDuration(items.value, 0))

  const currentArrangementId = computed(() => arrangement.value?.id ?? null)

  /** 主选中 item（Inspector 与底部状态条） */
  const selectedItem = computed<ArrangementItem | null>(() => {
    // 依赖 dragRevision：原地拖动后状态条要跟着变
    void dragRevision.value
    return itemsById.value.get(timeline.primarySelectedId ?? '') ?? null
  })

  const selectedItems = computed<ArrangementItem[]>(() => {
    void dragRevision.value
    return timeline.selectedIds
      .map(id => itemsById.value.get(id))
      .filter((item): item is ArrangementItem => Boolean(item))
  })

  /** 设置项里的阈值（视图会把 settings store 的值写进来；缺省用 ARRANGE_DEFAULTS） */
  const maxCrossTrackOverlapMs = ref<number>(ARRANGE_DEFAULTS.maxCrossTrackOverlapMs)
  const maxGapMs = ref<number>(ARRANGE_DEFAULTS.maxGapMs)

  /** 同轨重叠 / 跨轨重叠 / 长间隙（供 OverlapResolver 与状态条用，算法在 shared） */
  const overlapReport = computed(() => detectOverlaps(items.value, {
    maxCrossTrackOverlapMs: maxCrossTrackOverlapMs.value,
    maxGapMs: maxGapMs.value,
  }))

  function setThresholds(next: { maxCrossTrackOverlapMs?: number; maxGapMs?: number }): void {
    if (typeof next.maxCrossTrackOverlapMs === 'number') maxCrossTrackOverlapMs.value = next.maxCrossTrackOverlapMs
    if (typeof next.maxGapMs === 'number') maxGapMs.value = next.maxGapMs
  }

  /** 该方案是否已被混音导出引用（docs/13 §11：改动后需重新渲染） */
  const referencedByMixProjects = computed(() => {
    const id = currentArrangementId.value
    if (!id) return []
    return mixProjects.value.filter(p => p.arrangementId === id)
  })

  /** 缺录行数（底部状态条与校验按钮上的角标） */
  const missingLineCount = computed(() => {
    const hasItem = new Set(items.value.map(i => i.lineId))
    let count = 0
    for (const line of lines.value) if (!hasItem.has(line.id)) count += 1
    return count
  })

  // ── 批量提交（docs/13 §11：限制提交频率；§4.8：微调进内存 + 防抖批量提交） ──

  const batch = createBatchQueue<ItemChange>(
    async (list) => {
      const updates = mergeChanges(list)
      if (!updates.length) return
      saveStatus.value = 'saving'
      try {
        await callTyped<{ updated: number }>('alignment:batchUpdateItems', { updates })
        saveStatus.value = 'saved'
        lastSavedAt.value = Date.now()
        lastErrorText.value = null
      } catch (error) {
        saveStatus.value = 'error'
        const appError = reportError(error, {
          event: 'alignment.autosaveFailed',
          detailOverride: '对轨改动仍在内存中（尚未写入数据库）。可点「重试」重新保存。',
          retryFn: () => flushNow(),
          action: 'retry',
        })
        lastErrorText.value = appError.message
        // 交给 createBatchQueue 的 onError：这里已经兑现过提示，onError 只做记账，避免双弹
        throw error
      }
    },
    {
      flushMs: COMMIT_FLUSH_MS,
      maxBatch: 400,
      onError: () => {
        /* 已在 commit 内兑现（error-bus 去重），此处不再重复提示 */
      },
    },
  )

  /**
   * 未落库改动数（AutoSaveIndicator / 离开拦截用它）。
   * 注意 `batch.size()` 不是响应式数据，因此这里以 `saveStatus` 为触发点：
   * 状态一变化就会重算，读数只用于展示「有 N 处待提交」的概数。
   */
  const pendingCount = computed(() => (
    saveStatus.value === 'dirty' || saveStatus.value === 'saving' ? Math.max(1, batch.size()) : batch.size()
  ))

  /** 把改动排进批量队列（内存里已经生效，落库是防抖的） */
  function enqueueChanges(changes: ItemChange[]): void {
    if (!changes.length) return
    for (const change of changes) batch.add(change)
    saveStatus.value = 'dirty'
  }

  /** 立即落库（Ctrl+S / 切换章节 / 提交前） */
  async function flushNow(): Promise<void> {
    if (saveStatus.value === 'error' && lastErrorText.value) {
      // 重试路径：清掉错误态再冲一次
      saveStatus.value = 'dirty'
    }
    await batch.flush()
    if (saveStatus.value === 'dirty') saveStatus.value = 'saved'
  }

  // ── 撤销/重做（独立栈，docs/13 §4.8） ───────────────────────────────────

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const undoLabel = computed(() => undoStack.value[undoStack.value.length - 1]?.label ?? '')
  const redoLabel = computed(() => redoStack.value[redoStack.value.length - 1]?.label ?? '')
  const undoDepth = computed(() => undoStack.value.length)

  function pushCommand(label: string, before: ArrangementItem[], after: ArrangementItem[]): void {
    const affected = diffItems(before, after).length
    if (affected === 0) return
    const command: AlignmentCommand = {
      id: nextCommandId(),
      label,
      affected,
      before: before.map(i => ({ ...i })),
      after: after.map(i => ({ ...i })),
      at: Date.now(),
    }
    const next = [...undoStack.value, command]
    undoStack.value = next.length > UNDO_CAPACITY ? next.slice(next.length - UNDO_CAPACITY) : next
    redoStack.value = [] // 新操作让重做链失效
  }

  /** 用快照替换 items 中的对应项（撤销/重做与本地改造都走它） */
  function applySnapshot(snapshot: ArrangementItem[]): ItemChange[] {
    const snapshotById = new Map(snapshot.map(i => [i.id, i]))
    const before = items.value
    const next = before.map(item => {
      const replacement = snapshotById.get(item.id)
      return replacement ? { ...replacement } : item
    })
    setItems(next)
    return diffItems(before, next)
  }

  async function undo(): Promise<boolean> {
    const command = undoStack.value[undoStack.value.length - 1]
    if (!command) return false
    enqueueChanges(applySnapshot(command.before))
    undoStack.value = undoStack.value.slice(0, -1)
    redoStack.value = [...redoStack.value, command]
    timeline.setHint(`已撤销：${command.label}`)
    return true
  }

  async function redo(): Promise<boolean> {
    const command = redoStack.value[redoStack.value.length - 1]
    if (!command) return false
    enqueueChanges(applySnapshot(command.after))
    redoStack.value = redoStack.value.slice(0, -1)
    undoStack.value = [...undoStack.value, command]
    timeline.setHint(`已重做：${command.label}`)
    return true
  }

  function clearUndo(): void {
    undoStack.value = []
    redoStack.value = []
  }

  // ── 本地编辑（拖动中 / 键盘微调 / Inspector 提交） ───────────────────────

  /**
   * 原地改一个 item（**不落库、不进撤销栈**）。
   * 拖动时每帧调用：不能换数组身份，否则 1000 个 item 的派生 computed 每帧全量重算，
   * 直接违背 docs/13 §4.6 的「1000 items 拖动 ≥ 30 fps」。
   */
  function patchLocalInPlace(itemId: Id, patch: ArrangementItemPatch): ArrangementItem | null {
    const item = itemsById.value.get(itemId)
    if (!item) return null
    const deltaStart = patch.timelineStartMs !== undefined ? patch.timelineStartMs - item.timelineStartMs : 0
    Object.assign(item, patch)
    if (deltaStart !== 0) indexDirty.value = true
    dragRevision.value += 1
    return item
  }

  /**
   * 提交一组改动：进撤销栈（一条命令）+ 进批量队列（一次事务）。
   * `before` 由调用方在拖动开始时抓取（拖动过程中 item 是原地改的，事后取不回旧值）。
   */
  function commitChanges(label: string, before: ArrangementItem[]): void {
    if (!before.length) return
    const after: ArrangementItem[] = []
    for (const old of before) {
      const current = itemsById.value.get(old.id)
      if (current) after.push({ ...current })
    }
    pushCommand(label, before, after)
    enqueueChanges(diffItems(before, after))
    // 拖动可能打乱轨内顺序，提交后重建一次有序索引
    setItems(items.value)
  }

  /** 单条 item 的立即写入（Inspector 的数值编辑走这里：`alignment:updateItem`） */
  async function updateItemNow(itemId: Id, patch: ArrangementItemPatch, label = '修改片段属性'): Promise<ArrangementItem | null> {
    const before = itemById(itemId)
    if (!before) return null
    const updated = await callTyped<ArrangementItem>('alignment:updateItem', { itemId, patch })
    const previous = { ...before }
    const next = items.value.map(item => (item.id === itemId ? { ...updated } : item))
    setItems(next)
    pushCommand(label, [previous], [{ ...updated }])
    return updated
  }

  /** 键盘微调（±10ms / Shift ±1ms / Ctrl ±100ms，docs/13 §4.7） */
  function nudgeSelected(deltaMs: number): void {
    const targets = selectedItems.value
    if (!targets.length) return
    const before = targets.map(i => ({ ...i }))
    for (const item of targets) {
      if (item.locked) continue
      patchLocalInPlace(item.id, { timelineStartMs: moveItem(item, deltaMs).item.timelineStartMs })
    }
    commitChanges(`微调 ${deltaMs > 0 ? '+' : ''}${deltaMs} ms`, before)
  }

  /** 锁定 / 解锁（docs/13 §4.7） */
  async function setLocked(itemId: Id, locked: boolean): Promise<void> {
    await updateItemNow(itemId, { locked }, locked ? '锁定片段' : '解锁片段')
  }

  function setLockedMany(itemIds: Id[], locked: boolean): void {
    const before = itemIds
      .map(id => itemsById.value.get(id))
      .filter((i): i is ArrangementItem => Boolean(i))
      .map(i => ({ ...i }))
    for (const item of before) patchLocalInPlace(item.id, { locked })
    commitChanges(locked ? `锁定 ${before.length} 段` : `解锁 ${before.length} 段`, before)
  }

  /**
   * 重置单个片段为自动排布结果（docs/13 §4.7「重置」）。
   * 基线来自最近一次自动排布/重置/加载，没有基线时退回「轨内前一段之后」。
   */
  function resetItemToAuto(itemId: Id): void {
    const item = itemById(itemId)
    if (!item) return
    const before = [{ ...item }]
    const baseline = autoBaseline.value.get(itemId)
    if (baseline) {
      patchLocalInPlace(itemId, {
        timelineStartMs: baseline.timelineStartMs,
        srcInMs: baseline.srcInMs,
        srcOutMs: baseline.srcOutMs,
        fadeInMs: baseline.fadeInMs,
        fadeOutMs: baseline.fadeOutMs,
        orderInTrack: baseline.orderInTrack,
      })
    }
    commitChanges('重置为自动排布', before)
  }

  /**
   * 快速静音修剪（docs/05 §5.3）。
   *
   * ★ 契约缺口：主进程没有为 **arrangement item** 暴露静音修剪通道
   *   （`record:optimizeTrim` 作用于 take，改的是 take 的裁剪点，不是 item 的 srcIn/srcOut）。
   *   因此这里用 `analysis:peaks`（100 peaks/s ⇒ 10 ms 分辨率）在前端做一次
   *   「快速修剪」：找 srcIn 之后第一个幅度超过阈值的 peak、srcOut 之前最后一个，
   *   再按 `TRIM_DEFAULTS.headPaddingMs/tailPaddingMs` 留白。结果作为普通 patch 提交，
   *   可撤销、可再手工微调；若需要样本级精度，应在上游补一个 item 级修剪通道。
   */
  async function trimItemSilence(itemId: Id): Promise<boolean> {
    const item = itemById(itemId)
    if (!item) return false
    const source = resolveSource(item, false)
    if (!source) return false
    const peaksPerSec = 100
    const res = await callTypedSafe<{ peaks: number[]; channels: number; totalPeaks: number }>('analysis:peaks', {
      segmentId: source.segmentId,
      peaksPerSec,
    })
    if (!res || !res.peaks.length) return false

    const threshold = Math.pow(10, TRIM_DEFAULTS.thresholdDb / 20)
    const bucketMs = 1000 / peaksPerSec
    let firstIndex = -1
    let lastIndex = -1
    for (let i = 0; i < res.peaks.length; i++) {
      const value = Math.abs(res.peaks[i] ?? 0)
      if (value > threshold) {
        if (firstIndex < 0) firstIndex = i
        lastIndex = i
      }
    }
    if (firstIndex < 0 || lastIndex < 0) return false

    const headMs = Math.max(0, firstIndex * bucketMs - TRIM_DEFAULTS.headPaddingMs)
    const tailMs = (lastIndex + 1) * bucketMs + TRIM_DEFAULTS.tailPaddingMs
    const sourceDurationMs = source.durationMs
    const targetOut = Number.isFinite(sourceDurationMs)
      ? Math.min(tailMs, sourceDurationMs as number)
      : tailMs
    const minDuration = ARRANGE_DEFAULTS.minSegmentMs
    // ★ 起点必须按「拖左边缘」语义：timelineStartMs 与 srcInMs **反向补偿**，
    //   内容在时间线上的绝对位置不变（docs/05 §5.4 / docs/13 §4.7 都单独标注过）。
    const targetStart = item.timelineStartMs + (headMs - item.srcInMs)
    const left = resizeLeftEdge(item, targetStart, {
      minDurationMs: minDuration,
      sourceDurationMs: Number.isFinite(sourceDurationMs) ? (sourceDurationMs as number) : undefined,
    })
    const before = [{ ...item }]
    patchLocalInPlace(itemId, {
      timelineStartMs: left.item.timelineStartMs,
      srcInMs: left.item.srcInMs,
      srcOutMs: Math.max(left.item.srcInMs + minDuration, Math.round(targetOut)),
    })
    commitChanges('裁剪静音', before)
    return true
  }

  // ── 方案级操作（IPC） ───────────────────────────────────────────────────

  async function loadArrangements(chapterId: Id): Promise<Arrangement[]> {
    const list = await callTyped<Arrangement[]>('alignment:listArrangements', { chapterId })
    arrangements.value = list
    return list
  }

  function applyLoadedItems(next: ArrangementItem[], baseline = true): void {
    setItems(next)
    if (baseline) autoBaseline.value = new Map(next.map(i => [i.id, { ...i }]))
    timeline.pruneSelection(new Set(next.map(i => i.id)))
    timeline.setDuration(computeChapterDuration(next, 0))
  }

  async function loadArrangement(arrangementId: Id): Promise<void> {
    loading.value = true
    try {
      const res = await callTyped<{ arrangement: Arrangement; items: ArrangementItem[] }>('alignment:get', { arrangementId })
      arrangement.value = res.arrangement
      applyLoadedItems(res.items)
      clearUndo()
      saveStatus.value = 'idle'
      lastSavedAt.value = null
      lastErrorText.value = null
      lastError.value = null
    } catch (error) {
      lastError.value = error
    } finally {
      loading.value = false
    }
  }

  /** 上下文加载：画本行 / 角色 / take / 混音方案 / 处理后路径 */
  async function loadContext(chapterId: Id): Promise<void> {
    // 先要章节，才知道 bookId（character:list 需要它）
    const chapterRes = await callTyped<Chapter>('chapter:get', { chapterId })
    const [linesRes, characterList, takeList, mixes] = await Promise.all([
      callTyped<{ lines: CanvasLine[]; total: number }>('canvas:getChapter', { chapterId }),
      // 角色列表是「有更好、没有也能用」的上下文（缺了轨道会显示「未识别轨道」）
      callTypedSafe<Character[]>('character:list', { bookId: chapterRes.bookId, includeArchived: true }),
      callTypedSafe<Take[]>('take:listByChapter', { chapterId }),
      callTypedSafe<MixProject[]>('mix:listProjects', { chapterId }),
    ])

    chapter.value = chapterRes
    lines.value = linesRes.lines ?? []
    lineById.value = new Map(lines.value.map(l => [l.id, l]))
    characters.value = characterList ?? []
    takes.value = takeList ?? []
    // 同一行可能有多个 take：优先 isSelected（录音域写入的权威选择）
    const byLine = new Map<Id, Take>()
    for (const take of takes.value) {
      const current = byLine.get(take.lineId)
      if (!current || (take.isSelected && !current.isSelected)) byLine.set(take.lineId, take)
    }
    takeByLine.value = byLine
    mixProjects.value = mixes ?? []
  }

  /** 载入处理后路径（试听「处理后」用；失败不影响主流程，静默回落原始文件） */
  async function loadProcessedPaths(segmentIds: Id[]): Promise<void> {
    if (!segmentIds.length) return
    const res = await callTypedSafe<Array<{ segmentId: Id; processedPath: string | null; presetHash: string | null }>>(
      'process:listApplied',
      { segmentIds },
    )
    if (!res) return
    const map = new Map(processedBySegment.value)
    for (const row of res) if (row.processedPath) map.set(row.segmentId, row.processedPath)
    processedBySegment.value = map
  }

  /**
   * 一次到位地加载整章（视图挂载时调用）：
   * 上下文 → 方案列表 → 选中默认方案（或第一个）→ items。
   */
  async function loadChapter(chapterId: Id, preferredArrangementId: Id | null = null): Promise<void> {
    loading.value = true
    try {
      await loadContext(chapterId)
      const list = await loadArrangements(chapterId)
      const target = preferredArrangementId
        ? list.find(a => a.id === preferredArrangementId)
        : (list.find(a => a.isDefault) ?? list[0])
      if (!target) {
        arrangement.value = null
        applyLoadedItems([])
        return
      }
      await loadArrangement(target.id)
      // 只对当前方案用到的片段查 processed 路径（避免一次查全章的片段）
      const segmentIds = [...new Set(items.value.map(i => i.segmentId))]
      void loadProcessedPaths(segmentIds.slice(0, 500))
    } catch (error) {
      lastError.value = error
      throw error
    } finally {
      loading.value = false
    }
  }

  async function selectArrangement(arrangementId: Id): Promise<void> {
    await flushNow() // 切方案前先把当前改动落库（否则改动会丢）
    await loadArrangement(arrangementId)
    timeline.clearSelection()
    timeline.setPlayhead(0)
  }

  async function createArrangement(name: string, strategy: ArrangeStrategy): Promise<Arrangement | null> {
    const chapterId = arrangement.value?.chapterId ?? chapter.value?.id
    if (!chapterId) return null
    await flushNow()
    const created = await callTyped<Arrangement>('alignment:create', { chapterId, name, strategy })
    arrangements.value = [...arrangements.value, created]
    await loadArrangement(created.id)
    return created
  }

  async function duplicateArrangement(name: string): Promise<Arrangement | null> {
    const current = arrangement.value
    if (!current) return null
    await flushNow()
    const created = await callTyped<Arrangement>('alignment:duplicate', { arrangementId: current.id, name })
    arrangements.value = [...arrangements.value, created]
    await loadArrangement(created.id)
    return created
  }

  async function deleteArrangement(): Promise<boolean> {
    const current = arrangement.value
    if (!current) return false
    await callTyped<{ ok: boolean }>('alignment:delete', { arrangementId: current.id })
    arrangements.value = arrangements.value.filter(a => a.id !== current.id)
    const fallback = arrangements.value.find(a => a.isDefault) ?? arrangements.value[0] ?? null
    if (fallback) await loadArrangement(fallback.id)
    else {
      arrangement.value = null
      applyLoadedItems([])
    }
    return true
  }

  async function setDefaultArrangement(): Promise<boolean> {
    const current = arrangement.value
    if (!current) return false
    await callTyped<{ ok: boolean }>('alignment:setDefault', { arrangementId: current.id })
    arrangements.value = arrangements.value.map(a => ({ ...a, isDefault: a.id === current.id }))
    arrangement.value = { ...current, isDefault: true }
    return true
  }

  /**
   * 自动对轨（docs/13 §4.2 / §4.4）。
   * `preserveLocked` 为真时主进程不移动 locked 的 item（FR-4.8）。
   */
  async function autoArrange(opts: {
    strategy?: ArrangeStrategy
    preserveLocked?: boolean
    defaultPauseMs?: number
  } = {}): Promise<{ updated: number }> {
    const current = arrangement.value
    if (!current) return { updated: 0 }
    await flushNow()
    const strategy = opts.strategy ?? current.strategy
    const before = items.value.map(i => ({ ...i }))
    const res = await callTyped<{ items: ArrangementItem[]; totalDurationMs: number }>('alignment:autoArrange', {
      arrangementId: current.id,
      strategy,
      preserveLocked: opts.preserveLocked ?? true,
      defaultPauseMs: opts.defaultPauseMs ?? ARRANGE_DEFAULTS.defaultPauseMs,
    })
    applyLoadedItems(res.items)
    autoBaseline.value = new Map(res.items.map(i => [i.id, { ...i }]))
    arrangement.value = { ...current, strategy, totalDurationMs: res.totalDurationMs }
    pushCommand('自动对轨', before, res.items)
    return { updated: res.items.length }
  }

  /**
   * IPC 返回的 items 合并策略。
   *
   * ★ 契约缺口：`alignment:resetTrack` / `alignment:resolveOverlap` 的返回都写作
   *   `{ items: ArrangementItem[] }`，但没有说明这是「全量 items」还是「仅受影响的 items」。
   *   这里做**防御式合并**：返回数量与当前一致 → 视为全量替换；否则按 id 合并进当前数组，
   *   既不丢数据也不会把整章 items 换成局部结果。
   */
  function mergeItemsResult(returned: ArrangementItem[]): ArrangementItem[] {
    if (returned.length === 0) return items.value
    if (returned.length === items.value.length) return returned
    const byId = new Map(returned.map(i => [i.id, i]))
    return items.value.map(item => byId.get(item.id) ?? item)
  }

  /** 重置整轨为自动排布（docs/13 §4.7） */
  async function resetTrack(trackId: TrackId): Promise<void> {
    const current = arrangement.value
    if (!current) return
    await flushNow()
    const before = items.value.map(i => ({ ...i }))
    const res = await callTyped<{ items: ArrangementItem[] }>('alignment:resetTrack', {
      arrangementId: current.id,
      trackId,
    })
    const merged = mergeItemsResult(res.items ?? [])
    setItems(merged)
    pushCommand(`重置轨道（${trackId}）`, before, merged)
  }

  /** 重置全部（docs/13 §4.7） */
  async function resetAll(): Promise<void> {
    const current = arrangement.value
    if (!current) return
    await flushNow()
    const before = items.value.map(i => ({ ...i }))
    const res = await callTyped<{ items: ArrangementItem[] }>('alignment:resetAll', { arrangementId: current.id })
    const merged = mergeItemsResult(res.items ?? [])
    setItems(merged)
    autoBaseline.value = new Map(merged.map(i => [i.id, { ...i }]))
    pushCommand('重置全部为自动排布', before, merged)
  }

  /**
   * 消解一处重叠（逐条处理，docs/13 §4.3）。
   * 同轨重叠必须消解；`keep` 是「有意保留交叠」，也走这里（主进程只记录不动位置）。
   */
  async function resolveOverlapPair(itemIdA: Id, itemIdB: Id, strategy: ArrangeStrategy): Promise<boolean> {
    const current = arrangement.value
    if (!current) return false
    const before = items.value.map(i => ({ ...i }))
    const res = await callTyped<{ items: ArrangementItem[] }>('alignment:resolveOverlap', {
      arrangementId: current.id,
      itemIdA,
      itemIdB,
      strategy,
    })
    const merged = mergeItemsResult(res.items ?? [])
    setItems(merged)
    pushCommand(`消解重叠（${strategy}）`, before, merged)
    return true
  }

  /**
   * 「全部按同策略处理」（docs/13 §4.3 + §4.8：**一次撤销 = 整批**）。
   *
   * 契约缺口：没有批量消解通道，因此这里逐对调用 `alignment:resolveOverlap`。
   * 为了不让「一次撤销只回退一处」，撤销命令由视图侧包一层：
   * `beginBatch()` 抓快照 → N 次 resolveOverlapPair（内部不各自入栈）→ `endBatch()` 入一条命令。
   */
  async function resolveAllOverlaps(strategy: ArrangeStrategy): Promise<number> {
    const current = arrangement.value
    if (!current) return 0
    const before = items.value.map(i => ({ ...i }))
    let handled = 0
    // 每轮重新检测：消解一处会改变与下一处的先后关系（shared/arrange/overlap.ts 的实现说明）
    for (let round = 0; round < items.value.length + 2; round++) {
      const report = detectOverlaps(items.value, {
        maxCrossTrackOverlapMs: maxCrossTrackOverlapMs.value,
        maxGapMs: maxGapMs.value,
      })
      const first = report.sameTrack[0]
      if (!first) break
      const currentItems = items.value
      const res = await callTyped<{ items: ArrangementItem[] }>('alignment:resolveOverlap', {
        arrangementId: current.id,
        itemIdA: first.a,
        itemIdB: first.b,
        strategy,
      })
      const merged = mergeItemsResult(res.items ?? [])
      // 主进程没有真的移动任何东西（例如 keep 策略 / 已到边界）→ 停止，避免死循环
      if (diffItems(currentItems, merged).length === 0) break
      setItems(merged)
      handled += 1
    }
    const after = items.value.map(i => ({ ...i }))
    pushCommand(`批量消解重叠（${strategy}，${handled} 处）`, before, after)
    return handled
  }

  /** 纯本地预演（不落库）：给 OverlapResolver 显示「按该策略会怎么动」 */
  function previewResolution(itemIdA: Id, itemIdB: Id, strategy: ArrangeStrategy): OverlapPreviewChange[] {
    const res = resolveOverlapPure(items.value, itemIdA, itemIdB, strategy, {
      minGapMs: ARRANGE_DEFAULTS.minGapMs,
      maxCrossTrackOverlapMs: maxCrossTrackOverlapMs.value,
      maxGapMs: maxGapMs.value,
    })
    // 保留 kind：UI 用它区分「移动」与「只裁剪尾部」，不能只剩 deltaMs
    return res.changes.map(c => ({ kind: c.kind, itemId: c.itemId, deltaMs: c.deltaMs, reason: c.reason }))
  }

  /** item 的时长（含淡入淡出，docs/13 §4.2 口径） */
  function durationOf(item: ArrangementItem): number {
    return itemDurationMs(item)
  }

  function dispose(): void {
    batch.cancel()
    clearUndo()
  }

  return {
    // 方案
    arrangements, arrangement, loading, lastError, currentArrangementId,
    loadArrangements, loadArrangement, loadChapter, loadContext, loadProcessedPaths,
    selectArrangement, createArrangement, duplicateArrangement, deleteArrangement, setDefaultArrangement,
    referencedByMixProjects, mixProjects,
    // items
    items, itemsById, itemsByTrack, itemById, trackItems, ensureSortedIndex, durationOf,
    totalDurationMs, missingLineCount, overlapReport,
    // 上下文
    chapter, lines, lineById, characters, takes, takeByLine, processedBySegment,
    lineOf, lineLabel, lineSeq, resolveSource, tracks,
    // 阈值
    maxCrossTrackOverlapMs, maxGapMs, setThresholds,
    // 选择
    selectedItem, selectedItems,
    // 本地编辑
    patchLocalInPlace, commitChanges, updateItemNow, nudgeSelected, setLocked, setLockedMany,
    resetItemToAuto, trimItemSilence, dragRevision,
    // 方案级操作
    autoArrange, resetTrack, resetAll, resolveOverlapPair, resolveAllOverlaps, previewResolution,
    // 撤销
    undo, redo, canUndo, canRedo, undoLabel, redoLabel, undoDepth, clearUndo,
    // 保存
    saveStatus, lastSavedAt, lastErrorText, pendingCount, flushNow, enqueueChanges,
    dispose,
  }
})

export type ArrangementStore = ReturnType<typeof useArrangementStore>
