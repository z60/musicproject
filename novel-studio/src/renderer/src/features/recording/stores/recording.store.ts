/**
 * 录音域 · 会话状态 store（**主进程权威，本 store 只做镜像**）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §2   —— 会话状态机（idle → preparing → ready → recording ⇄ paused
 *                     → finalizing → done / recovered / failed）
 *   · docs/20 §7   —— 「主进程权威：状态机以主进程为准；渲染进程只镜像，不自行推进」
 *   · docs/12 §6.1 —— 磁盘空间预检（RECORD_LIMITS.requiredFreeBytes）
 *   · docs/12 §12  —— 丢帧恒为 0；非 0 即 P0 缺陷，必须立刻可见
 *   · docs/12 §13  —— 采集完整性：采集样本数 == 写盘样本数
 *
 * 三条纪律（写代码时最容易违反的地方）：
 *   1. **只有 `applyStatus()` 能改 `state`**，而它只接受主进程 `record:status` 事件
 *      的载荷。任何 action（prepare/start/stop…）都不得自行把 state 推到 recording。
 *      这样「UI 以为在录、其实主进程没在写盘」这类事故在结构上就不可能发生。
 *   2. `durationMs / framesWritten / droppedFrames` 用 **max 合并**：事件可能重复或
 *      乱序到达（窗口重建、重连，docs/20 §7），倒退的值一律忽略。
 *   3. 渲染侧算出的电平（useRecorder 的采集块）与主进程 `record:level` 事件都写入
 *      同一组字段：主进程事件优先（它才是写库统计的来源），本地值只在事件缺失时兜底。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { AppError, resolve } from '@shared/errors.ts'
import type { DisplayableError } from '@shared/errors.ts'
import type { MessageKey, MessageParams } from '@shared/messages.ts'
import { RECORD_LIMITS } from '@shared/constants.ts'
import type { IpcEventPayload } from '@shared/ipc.ts'
import type { RecordSessionState, RecordingMode, RecordStopResult } from '@shared/types.ts'
import { on } from '@/shared/lib/ipc.ts'

/** `record:status` 事件载荷（契约唯一来源：src/shared/ipc.ts 的 IpcEventMap） */
export type RecordStatusPayload = IpcEventPayload<'record:status'>
/** `record:level` 事件载荷 */
export type RecordLevelPayload = IpcEventPayload<'record:level'>

/** 录制中的标记（docs/12 §4.1：M 打切点 / N 标记重来） */
export interface RecordMark {
  kind: 'cut' | 'retake' | 'note'
  atMs: number
}

/** 渲染侧本地电平（采集块算出，未过主进程） */
export interface LocalMeter {
  rmsDb: number
  peakDb: number
  clipping: boolean
  /** 连续 ≥3 样本 |x| ≥ 0.99 的事件数（docs/05 §2.5） */
  clipEvents: number
  /** 峰值贴顶（≥ -0.1 dBFS）的块数（docs/12 §12「长时间削波」） */
  overloadBlocks: number
}

/**
 * 取消息表文案（**禁止在组件里自拼错误文案**，docs/22 §6.2）。
 * 放在 store 里集中导出，是为了让 LinePromptCard / MonitorPanel 这类展示组件
 * 也能拿到「标题/正文/建议」三段式文案，而不用各自 import errors.ts。
 */
export function recordingMessage(key: MessageKey, params?: MessageParams): DisplayableError {
  return resolve(AppError.of(key, params ? { params } : undefined))
}

export const useRecordingStore = defineStore('recording/session', () => {
  // ── 会话标识 ──────────────────────────────────────────────────────────────
  const sessionId = ref<string | null>(null)
  const mode = ref<RecordingMode>('line_by_line')
  const chapterId = ref<string | null>(null)
  /** 本次录制归属的行（停止时传给 record:stop） */
  const lineId = ref<string | null>(null)
  /** record:prepare 返回的告警（主进程侧预检结论，原样展示） */
  const warnings = ref<string[]>([])

  // ── 主进程镜像字段（只由 applyStatus 写入）─────────────────────────────────
  const state = ref<RecordSessionState>('idle')
  const framesWritten = ref(0)
  const durationMs = ref(0)
  const droppedFrames = ref(0)
  const diskFreeBytes = ref(0)

  // ── 电平（主进程 record:level 优先，本地兜底）──────────────────────────────
  const rmsDb = ref<number | null>(null)
  const peakDb = ref<number | null>(null)
  const clipping = ref(false)
  const clipEvents = ref(0)
  const overloadBlocks = ref(0)

  // ── 会话过程数据 ──────────────────────────────────────────────────────────
  const marks = ref<RecordMark[]>([])
  const stopResult = ref<RecordStopResult | null>(null)
  const lastError = ref<unknown>(null)
  /**
   * 页面级提示（不是错误：例如「录音中已拦截关闭」，docs/12 §9.3）。
   * 错误一律走 error-bus，这里只放需要在走带栏旁边持续可见的一句话。
   */
  const notice = ref<string>('')

  let unsubscribe: (() => void) | null = null

  // ── 派生状态 ──────────────────────────────────────────────────────────────
  const isIdle = computed(() => state.value === 'idle' || state.value === 'done' || state.value === 'failed' || state.value === 'recovered')
  const isPreparing = computed(() => state.value === 'preparing' || state.value === 'ready')
  const isRecording = computed(() => state.value === 'recording')
  const isPaused = computed(() => state.value === 'paused')
  const isFinalizing = computed(() => state.value === 'finalizing')

  /** 走带栏按钮的可用性完全由状态机决定（docs/12 §2「允许的操作」一列） */
  const canPrepare = computed(() => !isFinalizing.value)
  const canStart = computed(() => !isRecording.value && !isPaused.value && !isFinalizing.value)
  const canPause = computed(() => isRecording.value)
  const canResume = computed(() => isPaused.value)
  const canStop = computed(() => isRecording.value || isPaused.value)
  const canMark = computed(() => isRecording.value)
  /** 录音中改行会误导用户（docs/12 §3.3「录音中改行：禁止」） */
  const canNavigateLines = computed(() => !isRecording.value && !isPaused.value && !isFinalizing.value)

  /** 磁盘不足：还差多少字节（主进程已给过 diskFreeBytes） */
  const diskShortfallBytes = computed(() => Math.max(0, RECORD_LIMITS.requiredFreeBytes - diskFreeBytes.value))
  const diskLow = computed(() => diskFreeBytes.value > 0 && diskShortfallBytes.value > 0)
  /** 丢帧非 0 = P0 缺陷（docs/12 §13），必须常驻提示直到会话结束 */
  const hasDroppedFrames = computed(() => droppedFrames.value > 0)
  /** 削波事件 > 20 → 建议给 take 打 clip 标记（docs/05 §2.5） */
  const clipFlagRecommended = computed(() => clipEvents.value > 20)
  /** 峰值贴顶 > 10 次 → 提示输入过载（docs/12 §12） */
  const overloadSuspected = computed(() => overloadBlocks.value > 10)

  function setSession(nextSessionId: string, nextMode: RecordingMode, nextChapterId: string | null, nextWarnings: string[]): void {
    sessionId.value = nextSessionId
    mode.value = nextMode
    chapterId.value = nextChapterId
    warnings.value = [...nextWarnings]
    marks.value = []
    stopResult.value = null
    /**
     * ⚠️ 会话镜像字段必须**随新会话清零**（真机事故 docs/91 §5.2.45）。
     *
     * `durationMs / framesWritten / droppedFrames` 走 `applyStatus` 的 **max 合并**，
     * `reset()` 又只在"放弃会话"时调用 —— 正常停止后这些值不会归零。
     * 后果：第二段开始瞬间 `store.durationMs` 还带着上一段的几千 ms，
     * `useRecorder` 的「录满 3 秒仍无信号」检查在 t=0 就误触发
     * （真机日志：每条会话开头都有一条 `recording.noSignal`，`droppedFrames`、
     * 削波计数同理会串段）。
     * 状态本身不在这里设 —— 等主进程 `record:status`（store 纪律 1 不受影响）。
     */
    framesWritten.value = 0
    durationMs.value = 0
    droppedFrames.value = 0
    rmsDb.value = null
    peakDb.value = null
    clipping.value = false
    clipEvents.value = 0
    overloadBlocks.value = 0
    // 注意：这里**不设置 state** —— 等主进程的 record:status 事件
  }

  function setLine(nextLineId: string | null): void {
    lineId.value = nextLineId
  }

  /**
   * 镜像主进程状态。单调合并（docs/20 §7 事件幂等）。
   * 窗口重建后本地 sessionId 为空时可以「认领」事件里的 sessionId（docs/20 §7 窗口重建）。
   */
  function applyStatus(payload: RecordStatusPayload): void {
    if (!payload || typeof payload !== 'object') return
    if (sessionId.value && payload.sessionId !== sessionId.value) return // 旧会话的迟到事件
    if (!sessionId.value) sessionId.value = payload.sessionId

    state.value = payload.state
    framesWritten.value = Math.max(framesWritten.value, payload.framesWritten ?? 0)
    durationMs.value = Math.max(durationMs.value, payload.durationMs ?? 0)
    droppedFrames.value = Math.max(droppedFrames.value, payload.droppedFrames ?? 0)
    if (typeof payload.diskFreeBytes === 'number') diskFreeBytes.value = payload.diskFreeBytes

    // 终态/暂停时清掉电平读数，避免用户以为还在采集
    if (payload.state !== 'recording') {
      rmsDb.value = null
      peakDb.value = null
    }
  }

  /** 主进程上报的电平（record:level 事件） */
  function applyLevel(payload: RecordLevelPayload): void {
    if (!payload || typeof payload !== 'object') return
    if (sessionId.value && payload.sessionId !== sessionId.value) return
    rmsDb.value = payload.rmsDb
    peakDb.value = payload.peakDb
    if (payload.clipping) clipping.value = true
  }

  /** 渲染侧采集块的本地电平兜底（useRecorder 每 50 ms 调用一次） */
  function applyLocalMeter(meter: LocalMeter): void {
    rmsDb.value = meter.rmsDb
    peakDb.value = meter.peakDb
    if (meter.clipping) clipping.value = true
    clipEvents.value = meter.clipEvents
    overloadBlocks.value = meter.overloadBlocks
  }

  /** 用户点击清除削波锁存（LevelMeter 的 clearClip 事件） */
  function clearClip(): void {
    clipping.value = false
    clipEvents.value = 0
    overloadBlocks.value = 0
  }

  function addMark(kind: RecordMark['kind'], atMs: number): void {
    marks.value = [...marks.value, { kind, atMs }]
  }

  function setStopResult(result: RecordStopResult | null): void {
    stopResult.value = result
  }

  function setNotice(text: string): void {
    notice.value = text
  }

  function clearNotice(): void {
    notice.value = ''
  }

  function setError(error: unknown): void {
    lastError.value = error
  }

  /** 回到干净状态（开始新会话、放弃会话、离开页面时调用） */
  function reset(): void {
    sessionId.value = null
    state.value = 'idle'
    framesWritten.value = 0
    durationMs.value = 0
    droppedFrames.value = 0
    rmsDb.value = null
    peakDb.value = null
    clipping.value = false
    clipEvents.value = 0
    overloadBlocks.value = 0
    marks.value = []
    stopResult.value = null
    warnings.value = []
    lineId.value = null
    notice.value = ''
  }

  /** 订阅主进程事件（幂等；录音页 onMounted 调，onUnmounted 调 dispose） */
  function init(): void {
    if (unsubscribe) return
    const offStatus = on('record:status', (raw) => applyStatus(raw as RecordStatusPayload))
    const offLevel = on('record:level', (raw) => applyLevel(raw as RecordLevelPayload))
    unsubscribe = () => {
      offStatus()
      offLevel()
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    // 标识
    sessionId, mode, chapterId, lineId, warnings,
    // 主进程镜像
    state, framesWritten, durationMs, droppedFrames, diskFreeBytes,
    // 电平
    rmsDb, peakDb, clipping, clipEvents, overloadBlocks,
    // 过程数据
    marks, stopResult, lastError, notice,
    // 派生
    isIdle, isPreparing, isRecording, isPaused, isFinalizing,
    canPrepare, canStart, canPause, canResume, canStop, canMark, canNavigateLines,
    diskShortfallBytes, diskLow, hasDroppedFrames, clipFlagRecommended, overloadSuspected,
    // 动作（都不推进状态）
    setSession, setLine, applyStatus, applyLevel, applyLocalMeter, clearClip,
    addMark, setStopResult, setNotice, clearNotice, setError, reset,
    init, dispose,
  }
})
