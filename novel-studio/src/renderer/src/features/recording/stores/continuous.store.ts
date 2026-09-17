/**
 * 录音域 · 连续录制的切片与匹配 store
 * ============================================================================
 * 设计依据：
 *   · docs/12 §4.3 —— 停止后：定稿会话 WAV → VAD 帧级分析 → 边界精修 → 过滤 → DP 匹配
 *   · docs/12 §4.4 —— 切片确认界面：切片列表 + 波形/画本行对照 + 未匹配两侧并排 +
 *                     逐条确认 / 仅接受高置信 / 全部拒绝 / 重切（原始会话永不删除）
 *   · docs/05 §4.3 —— 边界精修（头回退 80 ms、尾保留 200 ms）；过短丢弃；过长标记
 *   · docs/20 §7   —— 进度事件 `record:sliceProgress`（analyzedMs / totalMs）
 *
 * 一条重要的诚实边界（写代码时不要绕过去）：
 *   `record:acceptSlices` 的载荷只有 `SliceMatch[]`（sliceIndex + lineId + confidence），
 *   **不带边界**。因此界面上「手动拆分/合并切片」只改变本次确认时的对照显示
 *   （`needsReslice` 会被置位并明确提示）；要让主进程按新边界落盘必须走
 *   `record:slice`/重切。这里不做假装成功的实现。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { callSafe, on } from '@/shared/lib/ipc.ts'
import type { IpcEventPayload } from '@shared/ipc.ts'
import { VAD_DEFAULTS } from '@shared/constants.ts'
import type { SliceMatch, VadOptions, VadSlice } from '@shared/types.ts'

export type SliceProgressPayload = IpcEventPayload<'record:sliceProgress'>

interface MatchResult {
  matches: SliceMatch[]
  unmatchedSlices: number[]
  unrecordedLines: string[]
}

interface AcceptResult {
  createdTakes: number
  createdSegments: number
}

export const useContinuousStore = defineStore('recording/continuous', () => {
  const sessionId = ref<string | null>(null)
  /** VAD 参数（可在确认页调整后重切） */
  const vad = ref<VadOptions>({ ...VAD_DEFAULTS })
  const useAsr = ref(false)

  const slices = ref<VadSlice[]>([])
  const matches = ref<SliceMatch[]>([])
  const unmatchedSlices = ref<number[]>([])
  const unrecordedLines = ref<string[]>([])
  /** 手工绑定：sliceIndex → lineId（覆盖 DP 匹配结果） */
  const manualBindings = ref<Record<number, string>>({})
  /** 每条切片的接受状态：sliceIndex → boolean（默认「匹配成功即接受」） */
  const acceptance = ref<Record<number, boolean>>({})

  const selectedIndex = ref(0)
  const analyzing = ref(false)
  const matching = ref(false)
  const accepting = ref(false)
  const progress = ref<{ analyzedMs: number; totalMs: number }>({ analyzedMs: 0, totalMs: 0 })
  const createdTakes = ref(0)
  const createdSegments = ref(0)
  const lastError = ref<unknown>(null)
  /** 本地拆分/合并后置位：接受前必须提示「边界改动需要重切才落盘」 */
  const needsReslice = ref(false)

  let unsubscribe: (() => void) | null = null

  const totalSlices = computed(() => slices.value.length)
  const totalDurationMs = computed(() => slices.value.reduce((sum, s) => sum + Math.max(0, s.endMs - s.startMs), 0))
  const selected = computed<VadSlice | null>(() => slices.value.find(s => s.sliceIndex === selectedIndex.value) ?? null)
  const acceptedCount = computed(() => slices.value.filter(s => acceptance.value[s.sliceIndex] === true).length)
  const unmatchedCount = computed(() => unmatchedSlices.value.length)
  const unrecordedCount = computed(() => unrecordedLines.value.length)
  const hasResult = computed(() => slices.value.length > 0)
  const progressRatio = computed(() => {
    const { analyzedMs, totalMs } = progress.value
    if (!(totalMs > 0)) return 0
    return Math.min(1, Math.max(0, analyzedMs / totalMs))
  })

  function matchOf(sliceIndex: number): SliceMatch | null {
    return matches.value.find(m => m.sliceIndex === sliceIndex) ?? null
  }

  /** 最终归属行：手工绑定 > DP 匹配 */
  function lineOf(sliceIndex: number): string | null {
    return manualBindings.value[sliceIndex] ?? matchOf(sliceIndex)?.lineId ?? null
  }

  function scoreOf(sliceIndex: number): number | null {
    return matchOf(sliceIndex)?.confidence ?? null
  }

  function isManual(sliceIndex: number): boolean {
    return manualBindings.value[sliceIndex] !== undefined
  }

  function isAccepted(sliceIndex: number): boolean {
    return acceptance.value[sliceIndex] === true
  }

  /** 高置信切片（≥ 阈值）——「仅接受高置信」用；阈值来自设置 canvas.autoAcceptConfidence */
  function isHighConfidence(sliceIndex: number, threshold: number): boolean {
    const score = scoreOf(sliceIndex)
    return score !== null && score >= threshold && lineOf(sliceIndex) !== null
  }

  function setSession(nextSessionId: string): void {
    sessionId.value = nextSessionId
  }

  function setVad(next: VadOptions): void {
    vad.value = { ...next }
  }

  function patchVad(patch: Partial<VadOptions>): void {
    vad.value = { ...vad.value, ...patch }
  }

  function setSlices(next: VadSlice[]): void {
    slices.value = [...next].sort((a, b) => a.sliceIndex - b.sliceIndex)
    // 默认策略（docs/12 §4.4「高置信自动接受，低置信进待确认」）：
    // 有匹配行的先默认接受，未匹配的一律待确认，避免误把多余切片写成 take。
    const nextAcceptance: Record<number, boolean> = {}
    for (const slice of slices.value) {
      nextAcceptance[slice.sliceIndex] = slice.accepted || slice.matchedLine !== null
    }
    acceptance.value = nextAcceptance
    needsReslice.value = false
    if (selectedIndex.value >= slices.value.length) selectedIndex.value = 0
  }

  async function runSlice(): Promise<boolean> {
    if (!sessionId.value) return false
    analyzing.value = true
    progress.value = { analyzedMs: 0, totalMs: 0 }
    try {
      const result = (await callSafe('record:slice', { sessionId: sessionId.value, vad: vad.value })) as
        | { slices: VadSlice[] }
        | null
      if (!result) return false
      setSlices(result.slices ?? [])
      matches.value = []
      unmatchedSlices.value = []
      unrecordedLines.value = []
      manualBindings.value = {}
      return true
    } finally {
      analyzing.value = false
    }
  }

  /** 用新参数重切（原始会话仍在，docs/12 §4.4「反复重切」） */
  async function reslice(patch: Partial<VadOptions> = {}): Promise<boolean> {
    patchVad(patch)
    return await runSlice()
  }

  async function runMatch(chapterId: string): Promise<boolean> {
    if (!sessionId.value) return false
    matching.value = true
    try {
      const result = (await callSafe('record:matchSlices', {
        sessionId: sessionId.value,
        chapterId,
        slices: slices.value,
        useAsr: useAsr.value,
      })) as MatchResult | null
      if (!result) return false
      matches.value = result.matches ?? []
      unmatchedSlices.value = result.unmatchedSlices ?? []
      unrecordedLines.value = result.unrecordedLines ?? []
      // 匹配结果回来后重新计算默认接受状态
      const next: Record<number, boolean> = {}
      for (const slice of slices.value) {
        next[slice.sliceIndex] = lineOf(slice.sliceIndex) !== null
      }
      acceptance.value = next
      return true
    } finally {
      matching.value = false
    }
  }

  /**
   * 接受：把「已勾选且能定位到画本行」的切片交给主进程生成 takes/segments。
   * 返回主进程的统计（createdTakes / createdSegments）。
   */
  async function accept(): Promise<AcceptResult | null> {
    if (!sessionId.value) return null
    const accepted: SliceMatch[] = []
    for (const slice of slices.value) {
      if (!isAccepted(slice.sliceIndex)) continue
      const lineId = lineOf(slice.sliceIndex)
      if (!lineId) continue
      accepted.push({ sliceIndex: slice.sliceIndex, lineId, confidence: scoreOf(slice.sliceIndex) ?? 0 })
    }
    if (!accepted.length) return null

    accepting.value = true
    try {
      const result = (await callSafe('record:acceptSlices', { sessionId: sessionId.value, accepted })) as AcceptResult | null
      if (!result) return null
      createdTakes.value = result.createdTakes
      createdSegments.value = result.createdSegments
      return result
    } finally {
      accepting.value = false
    }
  }

  /** 仅接受高置信（docs/12 §4.4 的接受策略） */
  function acceptHighConfidence(threshold: number): number {
    let changed = 0
    const next: Record<number, boolean> = { ...acceptance.value }
    for (const slice of slices.value) {
      const ok = isHighConfidence(slice.sliceIndex, threshold)
      if (next[slice.sliceIndex] !== ok) changed++
      next[slice.sliceIndex] = ok
    }
    acceptance.value = next
    return changed
  }

  /** 全部拒绝（保留原始会话，什么都不写库） */
  function rejectAll(): void {
    const next: Record<number, boolean> = {}
    for (const slice of slices.value) next[slice.sliceIndex] = false
    acceptance.value = next
  }

  function acceptAll(): void {
    const next: Record<number, boolean> = {}
    for (const slice of slices.value) next[slice.sliceIndex] = lineOf(slice.sliceIndex) !== null
    acceptance.value = next
  }

  function toggleAccept(sliceIndex: number): void {
    acceptance.value = { ...acceptance.value, [sliceIndex]: !isAccepted(sliceIndex) }
  }

  function setAccept(sliceIndex: number, value: boolean): void {
    acceptance.value = { ...acceptance.value, [sliceIndex]: value }
  }

  function bind(sliceIndex: number, lineId: string): void {
    manualBindings.value = { ...manualBindings.value, [sliceIndex]: lineId }
    // 手工绑定后该切片默认接受（用户刚刚明确指定了归属）
    setAccept(sliceIndex, true)
    // 该行不再算「未录」
    unrecordedLines.value = unrecordedLines.value.filter(id => id !== lineId)
    unmatchedSlices.value = unmatchedSlices.value.filter(i => i !== sliceIndex)
  }

  function unbind(sliceIndex: number): void {
    const next = { ...manualBindings.value }
    delete next[sliceIndex]
    manualBindings.value = next
  }

  function select(sliceIndex: number): void {
    selectedIndex.value = sliceIndex
  }

  /** 键盘上下移动选择（ContinuousReviewView 里用，注意 isEditableTarget 守卫） */
  function moveSelection(delta: number): void {
    if (!slices.value.length) return
    const current = slices.value.findIndex(s => s.sliceIndex === selectedIndex.value)
    const nextIndex = Math.min(slices.value.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
    selectedIndex.value = slices.value[nextIndex]!.sliceIndex
  }

  /**
   * 本地合并两片（VAD 把一句话切两半时用）：只改本次确认的显示与时长统计。
   * 真正落盘需要重切 —— 因此置位 needsReslice 并在 UI 上明确说明。
   */
  function mergeWithNext(sliceIndex: number): boolean {
    const list = slices.value
    const index = list.findIndex(s => s.sliceIndex === sliceIndex)
    if (index < 0 || index >= list.length - 1) return false
    const first = list[index]!
    const second = list[index + 1]!
    const merged: VadSlice = {
      ...first,
      endMs: second.endMs,
      peakDb: maxNullable(first.peakDb, second.peakDb),
      flags: [...new Set([...first.flags, ...second.flags])],
    }
    slices.value = [...list.slice(0, index), merged, ...list.slice(index + 2)]
    needsReslice.value = true
    return true
  }

  /** 本地拆分（两句被粘一起时用）：在给定时间点一分为二 */
  function splitAt(sliceIndex: number, atMs: number): boolean {
    const list = slices.value
    const index = list.findIndex(s => s.sliceIndex === sliceIndex)
    if (index < 0) return false
    const slice = list[index]!
    if (atMs <= slice.startMs + 30 || atMs >= slice.endMs - 30) return false
    const left: VadSlice = { ...slice, endMs: atMs }
    const right: VadSlice = { ...slice, startMs: atMs, id: `${slice.id}-b` }
    slices.value = [...list.slice(0, index), left, right, ...list.slice(index + 1)]
    needsReslice.value = true
    return true
  }

  function setProgress(payload: SliceProgressPayload): void {
    if (!payload || typeof payload !== 'object') return
    if (sessionId.value && payload.sessionId !== sessionId.value) return
    if (!sessionId.value) sessionId.value = payload.sessionId
    progress.value = { analyzedMs: payload.analyzedMs ?? 0, totalMs: payload.totalMs ?? 0 }
  }

  function init(): void {
    if (unsubscribe) return
    const off = on('record:sliceProgress', (raw) => setProgress(raw as SliceProgressPayload))
    unsubscribe = off
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  function reset(): void {
    sessionId.value = null
    slices.value = []
    matches.value = []
    unmatchedSlices.value = []
    unrecordedLines.value = []
    manualBindings.value = {}
    acceptance.value = {}
    selectedIndex.value = 0
    progress.value = { analyzedMs: 0, totalMs: 0 }
    createdTakes.value = 0
    createdSegments.value = 0
    needsReslice.value = false
    vad.value = { ...VAD_DEFAULTS }
  }

  return {
    sessionId, vad, useAsr,
    slices, matches, unmatchedSlices, unrecordedLines, manualBindings, acceptance,
    selectedIndex, analyzing, matching, accepting, progress, createdTakes, createdSegments,
    lastError, needsReslice,
    totalSlices, totalDurationMs, selected, acceptedCount, unmatchedCount, unrecordedCount,
    hasResult, progressRatio,
    matchOf, lineOf, scoreOf, isManual, isAccepted, isHighConfidence,
    setSession, setVad, patchVad, setSlices, runSlice, reslice, runMatch, accept,
    acceptHighConfidence, rejectAll, acceptAll, toggleAccept, setAccept, bind, unbind,
    select, moveSelection, mergeWithNext, splitAt, setProgress, init, dispose, reset,
  }
})

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}
