/**
 * Novel Studio · 导出质检（QC）store
 * ============================================================================
 * 设计依据：
 *   · docs/15 §6.1 —— 渲染前预检（数据来自库，快）：
 *       阻断项（缺录行 / 未分配说话人 / 磁盘空间）必须处理；
 *       警告项（孤儿片段 / 削波标记 / 片段过短过长 / 章节时长异常 / 输出已存在）可「已知悉，继续」。
 *   · docs/15 §6.2 —— 渲染后实测（复核 `export:verify`：重新测量成品的响度与真峰）。
 *   · docs/22 §7   —— 批量任务的失败**汇总成一条**；本 store 不发提示，
 *       只负责状态与「已知悉」集合（提示一律由 error-bus 兑现）。
 *
 * 为什么预检结果单独一个 store：
 *   1. 预检结果带「已知悉」的例外集合（用户勾掉警告后继续），生命周期与导出参数不同；
 *   2. 预检结果必须能被**作废**（`invalidate`）：任何影响导出结果的参数变化都要清掉它，
 *      否则就会出现「拿旧预检结果导出新参数」的最坏情况（docs/15 §6.1 的前提是「渲染前」）。
 *   3. 复核结果（`export:verify`）与预检结果都是「质检产物」，放在一起便于报告面板使用。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call } from '@/shared/lib/ipc.ts'
import type { IpcReq, IpcRes } from '@shared/ipc.ts'
import type { QcPreCheckResult } from '@shared/types.ts'

// ---------------------------------------------------------------------------
// 契约类型（唯一来源是 src/shared/ipc.ts；渲染侧的 ipc.ts 契约是部分声明 + 索引签名，
// 因此这里的入参/出参用共享契约固定下来，再在 call 处做一次收窄断言）
// ---------------------------------------------------------------------------

/** `export:preCheck` 的入参 */
export type QcPreCheckRequest = IpcReq<'export:preCheck'>
/** `export:preCheck` 的出参（QcPreCheckResult） */
export type QcPreCheckResponse = IpcRes<'export:preCheck'>
/** `export:verify` 的出参（逐章重新测量的响度与真峰） */
export type QcVerifyResponse = IpcRes<'export:verify'>

/** 预检条目（阻断项与警告项同构） */
export type QcIssue = QcPreCheckResult['blockers'][number]
/** 预检统计 */
export type QcStats = QcPreCheckResult['stats']
/** 严重度：阻断 / 警告 */
export type QcSeverity = 'blocker' | 'warning'

/**
 * 「已知悉」集合的键。
 * 必须把 kind + 章节 + 行 + 文案一起入键：同一个 kind 会在很多章上重复出现
 * （120 章都缺同一行），若只用 kind 做键，勾掉一条会把全部同类警告一起勾掉。
 */
export function qcIssueKey(issue: QcIssue, severity: QcSeverity): string {
  return [severity, issue.kind, issue.chapterId ?? '-', issue.lineId ?? '-', issue.message].join('|')
}

/** 复核结果里的一章 */
export type QcVerifyChapter = QcVerifyResponse['chapters'][number]

export const useQcStore = defineStore('mixing/qc', () => {
  // ── 渲染前预检 ───────────────────────────────────────────────────────────
  const preCheck = ref<QcPreCheckResult | null>(null)
  const running = ref(false)
  /** 预检完成时间（UI 显示「刚刚检查过」，并按此判断结果是否新鲜） */
  const checkedAt = ref<number | null>(null)
  /** 产出该结果时的范围描述（如「全书 120 章」），参数变化后用于提示「上次检查的是别的范围」 */
  const checkedScope = ref<string>('')
  /** 已「已知悉」的警告（键 = qcIssueKey） */
  const acknowledged = ref<string[]>([])
  const lastError = ref<unknown>(null)

  // ── 渲染后复核 ───────────────────────────────────────────────────────────
  const verify = ref<QcVerifyResponse | null>(null)
  const verifyRunning = ref(false)
  const verifiedAt = ref<number | null>(null)
  /** 复核对应的 jobId（换任务后旧复核结果必须失效） */
  const verifiedJobId = ref<string | null>(null)

  // ── 派生 ─────────────────────────────────────────────────────────────────
  const blockers = computed<QcIssue[]>(() => preCheck.value?.blockers ?? [])
  const warnings = computed<QcIssue[]>(() => preCheck.value?.warnings ?? [])
  const stats = computed<QcStats | null>(() => preCheck.value?.stats ?? null)
  const hasResult = computed(() => preCheck.value !== null)
  const acknowledgedSet = computed(() => new Set(acknowledged.value))

  /** 还没被「已知悉」的警告 */
  const pendingWarnings = computed<QcIssue[]>(() =>
    warnings.value.filter(w => !acknowledgedSet.value.has(qcIssueKey(w, 'warning'))),
  )

  /**
   * 能否进入第 7 步（执行）：阻断项必须为 0，且每条警告都已明确「已知悉」。
   * 之所以要求逐条确认而不是「一键全部知悉」：docs/15 §6.1 的警告大多是
   * 「这章可能对轨错了」这类需要人看一眼的项，一次全勾等于没检查。
   * （仍提供「全部已知悉」按钮，但需要用户主动点。）
   */
  const canProceed = computed(() =>
    hasResult.value && !running.value && blockers.value.length === 0 && pendingWarnings.value.length === 0,
  )

  /** 缺录比例（0~1），用于 stats 的进度条 */
  const recordedRatio = computed(() => {
    const s = stats.value
    if (!s || s.lines <= 0) return null
    return Math.min(1, Math.max(0, s.recordedLines / s.lines))
  })

  // ── 动作 ─────────────────────────────────────────────────────────────────

  /**
   * 跑一次渲染前预检（docs/15 §6.1）。
   * IPC 失败交给 error-bus（`call` 默认已兑现提示），这里只记录错误并返回 false，
   * 调用方不需要 try/catch。
   */
  async function run(request: QcPreCheckRequest, scopeLabel = ''): Promise<boolean> {
    running.value = true
    try {
      const result = await call('export:preCheck', request) as QcPreCheckResponse
      preCheck.value = result
      checkedAt.value = Date.now()
      checkedScope.value = scopeLabel
      // 换了参数/范围后的新结果，「已知悉」必须重新确认
      acknowledged.value = []
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = error
      return false
    } finally {
      running.value = false
    }
  }

  /** 标记一条警告为「已知悉」 */
  function acknowledge(issue: QcIssue): void {
    const key = qcIssueKey(issue, 'warning')
    if (!acknowledged.value.includes(key)) acknowledged.value = [...acknowledged.value, key]
  }

  function revokeAcknowledge(issue: QcIssue): void {
    const key = qcIssueKey(issue, 'warning')
    acknowledged.value = acknowledged.value.filter(k => k !== key)
  }

  /** 全部已知悉（用户主动点击，「继续」前的一道显式动作） */
  function acknowledgeAll(): void {
    acknowledged.value = warnings.value.map(w => qcIssueKey(w, 'warning'))
  }

  function isAcknowledged(issue: QcIssue): boolean {
    return acknowledgedSet.value.has(qcIssueKey(issue, 'warning'))
  }

  /**
   * 作废预检结果（参数/范围/混音方案变化时调用）。
   * 只清预检，不清复核：复核针对的是**已经导出的成品**，与向导参数无关。
   */
  function invalidate(): void {
    preCheck.value = null
    checkedAt.value = null
    checkedScope.value = ''
    acknowledged.value = []
  }

  /** 导出后的成品复核（docs/15 §6.2「渲染后实测」） */
  async function runVerify(jobId: string): Promise<boolean> {
    verifyRunning.value = true
    try {
      const result = await call('export:verify', { jobId }) as QcVerifyResponse
      verify.value = result
      verifiedAt.value = Date.now()
      verifiedJobId.value = jobId
      return true
    } catch (error) {
      lastError.value = error
      return false
    } finally {
      verifyRunning.value = false
    }
  }

  /** 复核结果是否是当前任务的（换任务后旧结果不能显示） */
  function verifyFor(jobId: string | null): QcVerifyResponse | null {
    if (!jobId || verifiedJobId.value !== jobId) return null
    return verify.value
  }

  /** 清掉复核结果（开始新一轮导出时调用） */
  function clearVerify(): void {
    verify.value = null
    verifiedAt.value = null
    verifiedJobId.value = null
    verifyRunning.value = false
  }

  /** 全部清空（离开向导/切换书籍时调用） */
  function reset(): void {
    preCheck.value = null
    checkedAt.value = null
    checkedScope.value = ''
    acknowledged.value = []
    running.value = false
    lastError.value = null
    clearVerify()
  }

  return {
    // 状态
    preCheck, running, checkedAt, checkedScope, acknowledged, lastError,
    verify, verifyRunning, verifiedAt, verifiedJobId,
    // 派生
    blockers, warnings, stats, hasResult, pendingWarnings, canProceed, recordedRatio,
    // 动作
    run, acknowledge, revokeAcknowledge, acknowledgeAll, isAcknowledged,
    invalidate, runVerify, verifyFor, clearVerify, reset,
  }
})
