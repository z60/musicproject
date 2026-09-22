/**
 * 对轨域 · 校验结果与「一条一条处理」引导模式
 * ============================================================================
 * 设计依据：docs/13-功能域-对轨.md
 *   · §5   11 种 `AlignIssueKind`；按类型分组、点击跳转、引导模式（类似待确认队列）
 *   · §5   `wrong_order` 值得单独强调：轨内时间顺序与画本 seq 相反 ⇒ 几乎一定是**错绑**，
 *          所以它在引导队列里**排在最前面**，并带独立标签（docs/13 §5 原文）。
 *   · §4.3 跨轨重叠（≤ maxCrossTrackOverlapMs 属正常对话）与长间隙（多半是缺录）
 *          需要**不同视觉等级** —— 由本文件的 `severity` 字段承担。
 *
 * 数据来源只有一处：`alignment:validate`（校验算法在主进程 `shared/arrange/validate.ts`）。
 * 渲染进程**不自己重算**校验结论，否则会出现「报告说没问题、导出却被拦住」。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AlignIssueKind, ArrangementValidation, Id } from '@shared/types.ts'
import { isBlockingIssue } from '@shared/arrange/validate.ts'
import { callTyped, callTypedSafe, useArrangementStore } from './arrangement.store.ts'

/** 视觉/处理等级：blocking 必修、warning 建议、info 提示 */
export type IssueSeverity = 'blocking' | 'warning' | 'info'

/** 兜底中文标签。主进程的 `alignment:issueKindLabels` 可用时以它为准（文案唯一来源） */
export const ISSUE_KIND_FALLBACK_LABELS: Record<AlignIssueKind, string> = {
  missing_line: '缺录（画本行没有录音）',
  unarranged_line: '有录音但未排布（重新自动排布即可归位）',
  orphan_segment: '孤儿片段（画本行已删除）',
  same_track_overlap: '同轨重叠（必须消解）',
  cross_track_overlap_warn: '跨轨重叠过大',
  long_gap: '过长静音（可能缺录一行）',
  short_segment: '片段过短',
  long_segment: '片段过长',
  silent_segment: '片段是静音',
  clipped_segment: '片段削波',
  file_missing: '音频文件丢失',
  wrong_order: '顺序颠倒（疑似错绑）',
}

/** 全部 issue 类型的固定展示顺序（分组顺序稳定，用户才记得住） */
export const ISSUE_KIND_ORDER: AlignIssueKind[] = [
  'wrong_order',
  'same_track_overlap',
  'missing_line',
  'unarranged_line',
  'file_missing',
  'cross_track_overlap_warn',
  'long_gap',
  'silent_segment',
  'clipped_segment',
  'short_segment',
  'long_segment',
  'orphan_segment',
]

/** 一条可点击的问题（校验报告与引导模式都消费它） */
export interface ValidationIssueRow {
  /** 稳定键：kind + itemId/lineId，用于「已跳过」集合与列表 key */
  key: string
  kind: AlignIssueKind
  label: string
  /** 主进程给的原文（禁止 UI 自拼校验结论） */
  message: string
  lineId: Id | null
  itemId: Id | null
  /** 时间线上的位置（点它就能跳过去；拿不到时为 null） */
  timeMs: number | null
  lineSeq: number | null
  severity: IssueSeverity
  /** 是否阻断级（缺录 / 同轨重叠 / 文件丢失：导出预检会拦） */
  blocking: boolean
}

function severityOf(kind: AlignIssueKind): IssueSeverity {
  if (kind === 'wrong_order') return 'blocking'
  if (isBlockingIssue(kind)) return 'blocking'
  if (kind === 'orphan_segment') return 'info'
  // 跨轨重叠过大 / 长间隙 / 静音 / 削波 / 过短过长 —— 都是「建议处理」
  return 'warning'
}

export const useValidationStore = defineStore('alignment/validation', () => {
  const arrangement = useArrangementStore()

  const result = ref<ArrangementValidation | null>(null)
  const loading = ref(false)
  const lastError = ref<unknown>(null)
  const kindLabels = ref<Record<string, string>>({ ...ISSUE_KIND_FALLBACK_LABELS })
  /** 已跳过的引导项（S 键）：不消失，只是不再排到队首 */
  const skippedKeys = ref<string[]>([])

  // ── 引导模式（docs/13 §5「一条一条处理」） ───────────────────────────────
  const guideActive = ref(false)
  const guideIndex = ref(0)

  /** 把 `alignment:validate` 的返回拍平成可点击的行（含时间线位置） */
  function buildRows(validation: ArrangementValidation | null): ValidationIssueRow[] {
    if (!validation) return []
    const rows: ValidationIssueRow[] = []
    const seen = new Set<string>()

    const push = (kind: AlignIssueKind, message: string, lineId: Id | null, itemId: Id | null): void => {
      const key = `${kind}:${itemId ?? lineId ?? rows.length}`
      if (seen.has(key)) return
      seen.add(key)
      const item = arrangement.itemById(itemId)
      // 优先用 item 的起点；没有 item 时退到该行已有的 item（缺录行没有 item，位置为 null）
      const fallbackItem = item ?? arrangement.items.find(i => i.lineId === lineId) ?? null
      rows.push({
        key,
        kind,
        label: kindLabels.value[kind] ?? ISSUE_KIND_FALLBACK_LABELS[kind] ?? kind,
        message,
        lineId,
        itemId,
        timeMs: fallbackItem ? fallbackItem.timelineStartMs : null,
        lineSeq: arrangement.lineById.get(lineId ?? '')?.seq ?? null,
        severity: severityOf(kind),
        // `blocking` 严格等于「导出预检会拦」（shared/arrange/validate.ts 的 isBlockingIssue），
        // 而 wrong_order 只是「优先级最高、必须人工看一眼」，不阻断导出。
        blocking: isBlockingIssue(kind),
      })
    }

    // 1) 首选主进程给的 issues（带中文原文；kind 齐全）
    for (const issue of validation.issues ?? []) {
      push(issue.kind, issue.message, issue.lineId, issue.itemId)
    }

    // 2) 兼容：后端只回聚合数组（issues 为空）时，也要能列出并跳转。
    //    消息文案仍取自主进程聚合数据，不编造结论。
    if (rows.length === 0) {
      for (const lineId of validation.missingLines ?? []) {
        push('missing_line', '该画本行还没有录音（缺录）', lineId, null)
      }
      for (const lineId of validation.unarrangedLines ?? []) {
        push('unarranged_line', '该画本行有录音但不在当前方案里', lineId, null)
      }
      for (const a of validation.sameTrackOverlaps ?? []) {
        push('same_track_overlap', `同轨两段重叠 ${Math.round(a.overlapMs)} ms`, null, a.b)
      }
      for (const a of validation.crossTrackOverlaps ?? []) {
        if (a.level !== 'warning') continue // 正常对话不报
        push('cross_track_overlap_warn', `跨轨重叠 ${Math.round(a.overlapMs)} ms 超过上限`, null, a.b)
      }
      for (const g of validation.longGaps ?? []) {
        push('long_gap', `该行之后有 ${(g.gapMs / 1000).toFixed(1)} s 无人说话`, g.afterLineId, null)
      }
      for (const segmentId of validation.shortSegments ?? []) {
        const item = arrangement.items.find(i => i.segmentId === segmentId) ?? null
        push('short_segment', '片段过短', item?.lineId ?? null, item?.id ?? null)
      }
      for (const segmentId of validation.longSegments ?? []) {
        const item = arrangement.items.find(i => i.segmentId === segmentId) ?? null
        push('long_segment', '片段过长', item?.lineId ?? null, item?.id ?? null)
      }
    }

    // 3) 排序：wrong_order 永远第一（错绑优先级最高），其后 blocking → warning → info
    const rank = (row: ValidationIssueRow): number => {
      if (row.kind === 'wrong_order') return 0
      return row.severity === 'blocking' ? 1 : row.severity === 'warning' ? 2 : 3
    }
    const orderIndex = (kind: AlignIssueKind): number => ISSUE_KIND_ORDER.indexOf(kind)
    rows.sort((a, b) => rank(a) - rank(b) || orderIndex(a.kind) - orderIndex(b.kind))
    return rows
  }

  const rows = computed<ValidationIssueRow[]>(() => buildRows(result.value))

  /** 按 kind 分组（UI 用折叠面板展示，docs/13 §5） */
  const groups = computed(() => {
    const map = new Map<AlignIssueKind, ValidationIssueRow[]>()
    for (const row of rows.value) {
      const list = map.get(row.kind)
      if (list) list.push(row)
      else map.set(row.kind, [row])
    }
    return ISSUE_KIND_ORDER
      .filter(kind => map.has(kind))
      .map(kind => ({
        kind,
        label: kindLabels.value[kind] ?? ISSUE_KIND_FALLBACK_LABELS[kind] ?? kind,
        severity: severityOf(kind),
        rows: map.get(kind) as ValidationIssueRow[],
      }))
  })

  const totalCount = computed(() => rows.value.length)
  const blockingCount = computed(() => rows.value.filter(r => r.blocking).length)
  const wrongOrderCount = computed(() => rows.value.filter(r => r.kind === 'wrong_order').length)
  const missingCount = computed(() => rows.value.filter(r => r.kind === 'missing_line').length)
  const hasResult = computed(() => result.value !== null)
  const clean = computed(() => hasResult.value && rows.value.length === 0)

  /** 引导队列：跳过项沉底，其余按优先级（wrong_order 在前） */
  const guideQueue = computed(() => {
    const skipped = new Set(skippedKeys.value)
    const pending = rows.value.filter(r => !skipped.has(r.key))
    const done = rows.value.filter(r => skipped.has(r.key))
    return [...pending, ...done]
  })

  const currentGuideRow = computed<ValidationIssueRow | null>(() => guideQueue.value[guideIndex.value] ?? null)
  const guideProgress = computed(() => ({
    index: Math.min(guideIndex.value + 1, guideQueue.value.length),
    total: guideQueue.value.length,
    skipped: skippedKeys.value.length,
  }))

  /**
   * 跑校验。`alignment:validate` 同时返回聚合数组与 issues；
   * 顺带尝试取一次 issueKindLabels（文案唯一来源），失败就用兜底标签。
   */
  async function validate(arrangementId: Id): Promise<ArrangementValidation | null> {
    loading.value = true
    try {
      const [res, labels] = await Promise.all([
        callTyped<ArrangementValidation>('alignment:validate', { arrangementId }),
        callTypedSafe<Record<string, string>>('alignment:issueKindLabels', undefined),
      ])
      result.value = res
      if (labels) kindLabels.value = { ...ISSUE_KIND_FALLBACK_LABELS, ...labels }
      lastError.value = null
      // 结果集变了，引导位置要收敛，否则会指到不存在的行
      guideIndex.value = Math.min(guideIndex.value, Math.max(0, rows.value.length - 1))
      return res
    } catch (error) {
      lastError.value = error
      return null
    } finally {
      loading.value = false
    }
  }

  function clear(): void {
    result.value = null
    skippedKeys.value = []
    guideIndex.value = 0
    guideActive.value = false
  }

  // ── 引导模式操作（↑/↓ 切换、Enter 采用建议、S 跳过） ────────────────────

  function startGuide(): void {
    guideActive.value = true
    guideIndex.value = 0
  }

  function stopGuide(): void {
    guideActive.value = false
  }

  function next(): void {
    guideIndex.value = Math.min(guideIndex.value + 1, Math.max(0, guideQueue.value.length - 1))
  }

  function prev(): void {
    guideIndex.value = Math.max(0, guideIndex.value - 1)
  }

  /** 跳过当前项（S 键）：仍然留在列表里，只是沉到队尾 */
  function skipCurrent(): void {
    const row = currentGuideRow.value
    if (!row) return
    if (!skippedKeys.value.includes(row.key)) skippedKeys.value = [...skippedKeys.value, row.key]
    next()
  }

  function unskipAll(): void {
    skippedKeys.value = []
    guideIndex.value = 0
  }

  /** 点报告里的一条：跳到时间线并选中（位置由视图负责滚动与选中） */
  function focusRow(key: string): ValidationIssueRow | null {
    const index = guideQueue.value.findIndex(r => r.key === key)
    if (index >= 0) guideIndex.value = index
    return guideQueue.value[index] ?? null
  }

  function isSkipped(key: string): boolean {
    return skippedKeys.value.includes(key)
  }

  return {
    result, loading, lastError, kindLabels,
    rows, groups, totalCount, blockingCount, wrongOrderCount, missingCount,
    hasResult, clean,
    guideActive, guideIndex, guideQueue, currentGuideRow, guideProgress,
    skippedKeys,
    validate, clear,
    startGuide, stopGuide, next, prev, skipCurrent, unskipAll, focusRow, isSkipped,
  }
})

export type ValidationStore = ReturnType<typeof useValidationStore>
