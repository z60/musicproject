/**
 * 画本编辑域 · 待确认队列（docs/11 §4.5「效率关键：3 分钟清 100 行」）
 * ============================================================================
 * 队列来源（三合一，按 id 去重后按 seq 排序）：
 *   1. `needsReview=1`       —— canvas:getChapter({ filter: { needsReview: true } })
 *   2. 质检标记              —— canvas:qualityCheck（带 lineId 的问题）
 *   3. 未分配（dialogue 无角色）—— 从已加载的行里筛（IPC filter 没有 unassigned 选项，见报告）
 *
 * 键盘语义（与 docs/11 §4.5 的图一致，按键映射在 useCanvasKeyboard.ts）：
 *   1/2/3 选候选并直接完成该行（一键一行，才可能 3 分钟 100 行）
 *   Enter 确认当前归属并下一行（把 needsReview 清掉，decidedBy 记为 human）
 *   S 跳过（不改数据，只是本轮不再出现）
 *   P 播放（已录音时试听）
 *   Z 撤销上一步（与 canvas.store 的撤销栈联动，撤销后该行回到队列）
 *   Ctrl+Enter 把当前角色应用到下面 N 行（连续对白的常见场景）
 *   Ctrl+Shift+Enter 一键确认高置信（置信度 ≥ settings.canvas.autoAcceptConfidence）
 *
 * 队列里保存的是 canvas.store 的**同一批行对象引用**，因此表格/抽屉里改了数据，
 * 队列看到的也是最新值，不需要来回同步。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call } from '@/shared/lib/ipc.ts'
import type { CanvasLine, Id, QualityIssue } from '@shared/types.ts'
import { useCanvasStore } from './canvas.store.ts'
import { useSpeakerAssign } from '../composables/useSpeakerAssign.ts'

/** 队列来源开关 */
export interface ReviewQueueSources {
  /** 低置信 / 待确认（needsReview=1） */
  needsReview: boolean
  /** 质检问题行 */
  quality: boolean
  /** dialogue 但说话人为空 */
  unassigned: boolean
}

export interface ReviewQueueProgress {
  /** 本轮开始时的待确认行数 */
  total: number
  /** 已处理（确认 + 跳过）的行数 */
  done: number
  /** 剩余行数 */
  remaining: number
  /** 0~1 */
  ratio: number
  /** 已用时间（毫秒） */
  elapsedMs: number
  /** 剩余预估时间（毫秒）；样本不足时为 null */
  etaMs: number | null
  /** 平均每行耗时（毫秒）；样本不足时为 null */
  perLineMs: number | null
  /** 已确认 / 已跳过 */
  confirmed: number
  skipped: number
}

/** 每行耗时样本达到这个数量才开始给「剩余预估」（否则第一行就会显示出离谱的 ETA） */
const ETA_MIN_SAMPLES = 3

export const useReviewStore = defineStore('editor/review', () => {
  const canvas = useCanvasStore()
  const speaker = useSpeakerAssign()

  const sources = ref<ReviewQueueSources>({ needsReview: true, quality: true, unassigned: true })
  /** 队列（按 seq 升序） */
  const items = ref<CanvasLine[]>([])
  /** 当前下标 */
  const index = ref(0)
  /** 本轮跳过的行（保留在队列里但标记为跳过，UI 上灰掉） */
  const skippedIds = ref<Set<Id>>(new Set())
  const building = ref(false)
  const startedAt = ref<number | null>(null)
  const finishedAt = ref<number | null>(null)
  /** 已确认的行数（用于 ETA 与完成反馈） */
  const confirmedCount = ref(0)
  /** 本轮起始总数（进度分母） */
  const initialTotal = ref(0)
  /** 处理历史（Z 撤销后要把行放回队列） */
  const processed = ref<Array<{ lineId: Id; kind: 'confirm' | 'pick' | 'skip' | 'run' | 'high' }>>([])
  /** Ctrl+Enter 的 N（默认 10 行，可在 UI 上改） */
  const runLength = ref(10)
  const lastError = ref<unknown>(null)

  // -------------------------------------------------------------------------
  // 派生
  // -------------------------------------------------------------------------

  const total = computed(() => items.value.length)
  const current = computed<CanvasLine | null>(() => items.value[index.value] ?? null)
  const currentId = computed<Id | null>(() => current.value?.id ?? null)
  const previous = computed<CanvasLine | null>(() => (index.value > 0 ? items.value[index.value - 1] ?? null : null))
  const nextItem = computed<CanvasLine | null>(() => items.value[index.value + 1] ?? null)

  /** 剩余（不含已跳过的） */
  const remaining = computed(() => items.value.filter(l => !skippedIds.value.has(l.id)).length)
  const skippedCount = computed(() => items.value.filter(l => skippedIds.value.has(l.id)).length)

  /** 当前行在「待处理」里的序号（第 i/N），已跳过的行不占号 */
  const position = computed(() => {
    const line = current.value
    if (!line) return 0
    let n = 0
    for (let i = 0; i <= index.value; i++) {
      const item = items.value[i]
      if (item && !skippedIds.value.has(item.id)) n += 1
    }
    return n
  })

  const isFinished = computed(() => items.value.length === 0 || remaining.value === 0)

  const progress = computed<ReviewQueueProgress>(() => {
    const done = confirmedCount.value + skippedCount.value
    const elapsedMs = startedAt.value ? Date.now() - startedAt.value : 0
    const samples = confirmedCount.value + skippedCount.value
    const perLineMs = samples >= ETA_MIN_SAMPLES && elapsedMs > 0 ? elapsedMs / samples : null
    return {
      total: initialTotal.value || items.value.length,
      done,
      remaining: remaining.value,
      ratio: initialTotal.value ? Math.min(1, done / initialTotal.value) : 0,
      elapsedMs,
      perLineMs,
      etaMs: perLineMs === null ? null : Math.round(perLineMs * remaining.value),
      confirmed: confirmedCount.value,
      skipped: skippedCount.value,
    }
  })

  /** 队列里高置信且尚未人工确认的行（一键确认的目标） */
  const highConfidenceTargets = computed(() =>
    items.value.filter(l =>
      l.decidedBy !== 'human' &&
      l.confidence !== null &&
      l.confidence >= canvas.autoAcceptConfidence &&
      !skippedIds.value.has(l.id)))

  // -------------------------------------------------------------------------
  // 构建队列
  // -------------------------------------------------------------------------

  /**
   * 重建队列。
   * 走主进程拿「权威」的待确认集合（可能包含渲染侧还没加载到的行），
   * 再用 canvas.store 的行对象做映射，保证队列与表格操作的是同一批对象。
   */
  async function build(): Promise<number> {
    const chapterId = canvas.chapterId
    if (!chapterId) {
      items.value = []
      return 0
    }
    building.value = true
    lastError.value = null
    try {
      const ids = new Set<Id>()

      if (sources.value.needsReview) {
        const res = await call('canvas:getChapter', {
          chapterId,
          filter: { needsReview: true },
        }) as { lines: CanvasLine[]; total: number }
        for (const line of res?.lines ?? []) ids.add(line.id)
      }

      if (sources.value.quality) {
        const issues = await call('canvas:qualityCheck', { chapterId }) as QualityIssue[]
        for (const issue of issues ?? []) {
          if (issue.lineId) ids.add(issue.lineId)
        }
      }

      if (sources.value.unassigned) {
        // 说明：canvas:getChapter 的 filter 里没有「未分配」这一项（契约缺口），
        // 因此这一路只能基于已加载的行筛；未加载的章节会提示先加载。
        for (const line of canvas.lines) {
          if (line.kind === 'dialogue' && !line.characterId) ids.add(line.id)
        }
      }

      const byId = canvas.lineById
      const queue: CanvasLine[] = []
      for (const id of ids) {
        const line = byId.get(id)
        // 已软删除的行不进队列（docs/11 §4.7）
        if (!line || line.flags.includes('deleted')) continue
        queue.push(line)
      }
      queue.sort((a, b) => a.seq - b.seq)

      items.value = queue
      index.value = 0
      skippedIds.value = new Set()
      processed.value = []
      confirmedCount.value = 0
      initialTotal.value = queue.length
      startedAt.value = queue.length ? Date.now() : null
      finishedAt.value = null
      return queue.length
    } catch (error) {
      lastError.value = error
      items.value = []
      return 0
    } finally {
      building.value = false
    }
  }

  function setSources(next: Partial<ReviewQueueSources>): void {
    sources.value = { ...sources.value, ...next }
  }

  function setIndex(next: number): void {
    index.value = Math.min(Math.max(0, next), Math.max(0, items.value.length - 1))
  }

  function jumpTo(lineId: Id): void {
    const at = items.value.findIndex(l => l.id === lineId)
    if (at >= 0) index.value = at
  }

  /** 前进到下一行（跳过已跳过的行，避免一直按 S 卡住） */
  function advance(): void {
    if (!items.value.length) {
      index.value = 0
      return
    }
    let next = index.value + 1
    while (next < items.value.length && skippedIds.value.has(items.value[next]!.id)) next += 1
    if (next >= items.value.length) {
      index.value = Math.max(0, items.value.length - 1)
      if (!remaining.value) finishedAt.value = Date.now()
      return
    }
    index.value = next
  }

  /** 从队列移除某行（确认后调用） */
  function removeLine(lineId: Id): void {
    const at = items.value.findIndex(l => l.id === lineId)
    if (at < 0) return
    const nextItems = [...items.value]
    nextItems.splice(at, 1)
    items.value = nextItems
    if (index.value > at) index.value -= 1
    if (index.value >= nextItems.length) index.value = Math.max(0, nextItems.length - 1)
  }

  function insertLineSorted(line: CanvasLine): void {
    if (items.value.some(l => l.id === line.id)) return
    const nextItems = [...items.value, line].sort((a, b) => a.seq - b.seq)
    items.value = nextItems
    const at = nextItems.findIndex(l => l.id === line.id)
    if (at >= 0) index.value = at
  }

  // -------------------------------------------------------------------------
  // 逐行处理
  // -------------------------------------------------------------------------

  /** 选候选（数字键 1/2/3）：直接完成该行 —— 一次按键处理一行 */
  async function pickCandidate(candidateIndex: number): Promise<boolean> {
    const line = current.value
    if (!line) return false
    const result = await speaker.assignByIndex(line, candidateIndex)
    if (!result.ok) return false
    processed.value = [...processed.value, { lineId: line.id, kind: 'pick' }]
    confirmedCount.value += 1
    removeLine(line.id)
    markDoneIfEmpty()
    return true
  }

  /** 选「旁白」选项（候选列表最后一项的快捷入口） */
  async function pickNarration(): Promise<boolean> {
    const line = current.value
    if (!line) return false
    const result = await speaker.setNarration(line)
    if (!result.ok) return false
    processed.value = [...processed.value, { lineId: line.id, kind: 'pick' }]
    confirmedCount.value += 1
    removeLine(line.id)
    markDoneIfEmpty()
    return true
  }

  /** Enter：确认当前归属（清 needsReview + decidedBy=human）并下一行 */
  async function confirmCurrent(): Promise<boolean> {
    const line = current.value
    if (!line) return false
    const ok = await canvas.commitFields(
      line.id,
      { needsReview: false, decidedBy: 'human' },
      '确认归属',
    )
    if (!ok) return false
    processed.value = [...processed.value, { lineId: line.id, kind: 'confirm' }]
    confirmedCount.value += 1
    removeLine(line.id)
    markDoneIfEmpty()
    return true
  }

  /** S：跳过（不改数据） */
  function skipCurrent(): boolean {
    const line = current.value
    if (!line) return false
    skippedIds.value = new Set(skippedIds.value).add(line.id)
    processed.value = [...processed.value, { lineId: line.id, kind: 'skip' }]
    advance()
    markDoneIfEmpty()
    return true
  }

  /** Z：撤销上一步（与撤销栈联动；撤销后把行放回队列） */
  async function undoLast(): Promise<boolean> {
    const ok = await canvas.undo()
    if (!ok) return false
    const last = processed.value[processed.value.length - 1]
    processed.value = processed.value.slice(0, -1)
    if (last) {
      if (last.kind === 'skip') {
        const nextSkipped = new Set(skippedIds.value)
        nextSkipped.delete(last.lineId)
        skippedIds.value = nextSkipped
      } else {
        confirmedCount.value = Math.max(0, confirmedCount.value - 1)
        const line = canvas.lineById.get(last.lineId)
        if (line) insertLineSorted(line)
      }
    }
    finishedAt.value = null
    return true
  }

  /**
   * Ctrl+Enter：把「当前角色」应用到下面 N 行（连续对白常见场景）。
   * 当前行本身也一起确认（它已经是这个角色，只是还挂着待确认）。
   */
  async function applyRunToNext(): Promise<{ applied: number; skipped: number }> {
    const line = current.value
    if (!line) return { applied: 0, skipped: 0 }
    const targets: CanvasLine[] = [line]
    for (let i = index.value + 1; i < items.value.length && targets.length < runLength.value + 1; i++) {
      const item = items.value[i]
      if (!item || skippedIds.value.has(item.id)) continue
      targets.push(item)
    }

    const ok = await canvas.applyBatchPatch(
      targets.map(t => t.id),
      {
        characterId: line.characterId,
        speakerType: line.speakerType,
        decidedBy: 'human',
        needsReview: false,
      },
      `应用到下面 ${targets.length - 1} 行`,
    )
    if (!ok) return { applied: 0, skipped: 0 }

    for (const target of targets) {
      processed.value = [...processed.value, { lineId: target.id, kind: 'run' }]
      confirmedCount.value += 1
      removeLine(target.id)
    }
    markDoneIfEmpty()
    return { applied: targets.length, skipped: 0 }
  }

  /** Ctrl+Shift+Enter：一键确认高置信 */
  async function acceptHighConfidence(): Promise<number> {
    const targets = highConfidenceTargets.value
    if (!targets.length) return 0
    const ok = await canvas.applyBatchPatch(
      targets.map(t => t.id),
      { needsReview: false, decidedBy: 'human' },
      `一键确认高置信（${targets.length} 行）`,
    )
    if (!ok) return 0
    for (const target of targets) {
      processed.value = [...processed.value, { lineId: target.id, kind: 'high' }]
      confirmedCount.value += 1
      removeLine(target.id)
    }
    markDoneIfEmpty()
    return targets.length
  }

  /** 批量指派：把某个角色应用到队列里的多行 */
  async function assignManyInQueue(lineIds: Id[], characterId: Id | null): Promise<boolean> {
    const ok = await canvas.applyBatchPatch(
      lineIds,
      {
        characterId,
        speakerType: characterId ? 'character' : 'narration',
        decidedBy: 'human',
        needsReview: false,
      },
      characterId ? '批量指派说话人' : '批量设为旁白',
    )
    if (!ok) return false
    for (const id of lineIds) {
      processed.value = [...processed.value, { lineId: id, kind: 'pick' }]
      confirmedCount.value += 1
      removeLine(id)
    }
    markDoneIfEmpty()
    return true
  }

  function markDoneIfEmpty(): void {
    if (!items.value.length || remaining.value === 0) finishedAt.value = Date.now()
  }

  /** 重新开始一轮（保留来源设置，重置进度） */
  async function restart(): Promise<number> {
    return build()
  }

  function reset(): void {
    items.value = []
    index.value = 0
    skippedIds.value = new Set()
    processed.value = []
    confirmedCount.value = 0
    initialTotal.value = 0
    startedAt.value = null
    finishedAt.value = null
  }

  function setRunLength(n: number): void {
    runLength.value = Math.min(200, Math.max(1, Math.floor(n)))
  }

  return {
    sources, items, index, skippedIds, building, startedAt, finishedAt,
    confirmedCount, initialTotal, processed, runLength, lastError,
    total, current, currentId, previous, nextItem, remaining, skippedCount,
    position, isFinished, progress, highConfidenceTargets,
    build, setSources, setIndex, jumpTo, advance, removeLine, insertLineSorted,
    pickCandidate, pickNarration, confirmCurrent, skipCurrent, undoLast,
    applyRunToNext, acceptHighConfidence, assignManyInQueue,
    restart, reset, setRunLength,
  }
})
