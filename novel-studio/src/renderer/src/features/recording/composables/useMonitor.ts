/**
 * 录音域 · 监听返送（FR-3.8）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §7   —— 监听配置表（关闭 / 监听已有轨道 / 监听+麦克风直通 / 节拍器）
 *                     必须处理的三个坑：回放被麦克风拾取、echoCancellation 的伪影、
 *                     **监听增益必须独立于录音增益**
 *   · docs/05 §11.2—— 监听图：[参考音/BGM] → GainNode(监听音量) ┐
 *                     [麦克风直通（默认关）] ──────────────────┼→ MonitorGain → destination
 *                     [节拍器/提示音] ────────────────────────┘
 *   · docs/05 §11.1—— 录音图与试听图不能共用；监听属于录音图一侧
 *   · docs/12 §6.2 —— 延迟：`ctx.outputLatency + ctx.baseLatency`（输入延迟只能估算）
 *
 * 三条实现纪律：
 *   1. **监听增益与录音增益彻底分开**：本文件只操作 monitorGain，
 *      采集链的 gain 节点在 useRecorder 里，两者互不可见（docs/12 §7 坑 3）。
 *   2. 麦克风直通**默认关闭**；开启且监听音量偏高时判定为啸叫风险，
 *      并走 error-bus 用 RECORD_MONITOR_FEEDBACK 提示（文案取自消息表）。
 *   3. echoCancellation 是通话型处理，会改变音色：默认关、可配、切换时说清代价。
 */

import { computed, onScopeDispose, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { reportByKey } from '@/shared/lib/error-bus.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'

/** 监听音量高于此值且开了直通 → 判为啸叫风险（dB） */
export const MONITOR_FEEDBACK_RISK_DB = -6
/** 「录音期间自动降低监听音量」的降低量（dB） */
export const MONITOR_RECORD_DUCK_DB = 6
/** 设置写库防抖：拖动音量滑块不能每像素打一次 IPC */
const PERSIST_DEBOUNCE_MS = 400

export interface UseMonitorOptions {
  /**
   * 复用采集图的 AudioContext（推荐）。
   * 同一个设备上开两个 AudioContext 容易互相干扰，因此优先复用；
   * 没有采集图时（例如只在诊断页试听）才自己建一个轻量上下文。
   */
  contextProvider?: () => AudioContext | null
}

export interface UseMonitorReturn {
  enabled: Ref<boolean>
  gainDb: Ref<number>
  /** 麦克风直通（默认关；开启前必须确认用户戴了耳机） */
  passThrough: Ref<boolean>
  /** 回声消除（默认关；开启会略微改变音色） */
  echoCancellation: Ref<boolean>
  /** 录音期间自动降低监听音量（docs/12 §7 对策 1） */
  autoLowerWhileRecording: Ref<boolean>
  recordingActive: Ref<boolean>
  /** 可读出的监听延迟（毫秒，估算值） */
  latencyMs: Ref<number | null>
  /** 当前实际生效的监听音量（含自动降低） */
  effectiveGainDb: ComputedRef<number>
  /** 啸叫风险：开了直通 + 音量偏高 */
  feedbackRisk: ComputedRef<boolean>
  /** 已挂上的参考音元素数量（UI 显示「正在监听 N 路」） */
  attachedCount: Ref<number>
  setEnabled: (value: boolean) => void
  toggle: () => void
  setGainDb: (db: number) => void
  setPassThrough: (value: boolean) => void
  setEchoCancellation: (value: boolean) => void
  setAutoLower: (value: boolean) => void
  setRecordingActive: (value: boolean) => void
  /** 把参考音/上一行试听的 <audio> 挂进监听图 */
  attachElement: (element: HTMLMediaElement) => void
  detachElement: (element: HTMLMediaElement) => void
  /** 麦克风直通（默认不用；useRecorder 的 micStream 传进来） */
  attachStream: (stream: MediaStream | null) => void
  /** 试听提示音（验证监听链路通不通，docs/12 §7 的节拍器/提示音一路） */
  playTestTone: () => void
  dispose: () => void
}

export function useMonitor(options: UseMonitorOptions = {}): UseMonitorReturn {
  const settingsStore = useSettingsStore()

  const audio = settingsStore.audio
  const enabled = ref(audio?.monitorEnabled ?? false)
  const gainDb = ref(audio?.monitorGainDb ?? -6)
  const echoCancellation = ref(audio?.echoCancellation ?? false)
  const passThrough = ref(false)
  const autoLowerWhileRecording = ref(true)
  const recordingActive = ref(false)
  const latencyMs = ref<number | null>(null)
  const attachedCount = ref(0)

  let context: AudioContext | null = null
  let ownsContext = false
  let monitorGain: GainNode | null = null
  let passThroughSource: MediaStreamAudioSourceNode | null = null
  let passThroughGain: GainNode | null = null
  const elementSources = new Map<HTMLMediaElement, MediaElementAudioSourceNode>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let feedbackReported = false

  const effectiveGainDb = computed(() => {
    const duck = autoLowerWhileRecording.value && recordingActive.value ? MONITOR_RECORD_DUCK_DB : 0
    return gainDb.value - duck
  })
  const feedbackRisk = computed(() => passThrough.value && effectiveGainDb.value > MONITOR_FEEDBACK_RISK_DB)

  /**
   * 取监听图用的 AudioContext：优先复用采集图（同一个设备、同一个时钟），
   * 采集图不存在时自己建一个 —— 但**绝不碰**采集链的节点。
   */
  function ensureContext(): AudioContext | null {
    const external = options.contextProvider?.() ?? null
    if (external && external.state !== 'closed') {
      if (context !== external) {
        // 采集图换了（重建会话）→ 旧的自建上下文作废，全部重建
        if (ownsContext) void context?.close().catch(() => undefined)
        context = external
        ownsContext = false
        monitorGain = null
        elementSources.clear()
        attachedCount.value = 0
        passThroughSource = null
        passThroughGain = null
      }
      if (!monitorGain) {
        monitorGain = context.createGain()
        monitorGain.gain.value = dbToLinear(effectiveGainDb.value)
        monitorGain.connect(context.destination)
      }
      return context
    }

    if (context && context.state !== 'closed') return context

    const ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext
    if (!ctor) return null
    context = new ctor({ latencyHint: 'interactive' })
    ownsContext = true
    monitorGain = context.createGain()
    monitorGain.gain.value = dbToLinear(effectiveGainDb.value)
    monitorGain.connect(context.destination)
    return context
  }

  function applyGain(): void {
    const ctx = ensureContext()
    if (!ctx || !monitorGain) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    // 用 setTargetAtTime 而不是直接赋值：避免拖动滑块时的咔哒声
    monitorGain.gain.setTargetAtTime(dbToLinear(effectiveGainDb.value), ctx.currentTime, 0.01)
    refreshLatency()
  }

  function refreshLatency(): void {
    if (!context) {
      latencyMs.value = null
      return
    }
    const base = Number(context.baseLatency ?? 0)
    const output = Number((context as AudioContext & { outputLatency?: number }).outputLatency ?? 0)
    const total = base + output
    // docs/12 §6.2：输入延迟读不到，这里只是「估算值」，UI 上要如实标注
    latencyMs.value = total > 0 ? Math.round(total * 1000) : null
  }

  function dbToLinear(db: number): number {
    return Math.pow(10, db / 20)
  }

  /** 生效条件：启用监听 + 有参考音元素（或直通）时才有输出 */
  function settleEnabled(): void {
    if (!enabled.value) {
      if (monitorGain && context) monitorGain.gain.setTargetAtTime(0, context.currentTime, 0.02)
      return
    }
    applyGain()
  }

  function setEnabled(value: boolean): void {
    enabled.value = value
    if (value) {
      ensureContext()
      applyGain()
    } else {
      settleEnabled()
    }
    schedulePersist()
  }

  function toggle(): void {
    setEnabled(!enabled.value)
  }

  function setGainDb(db: number): void {
    gainDb.value = Math.min(12, Math.max(-40, db))
    applyGain()
    schedulePersist()
    if (feedbackRisk.value) reportFeedbackRisk()
  }

  /**
   * 麦克风直通：默认关，且是啸叫的主要来源（docs/12 §7）。
   * 开启时如果监听音量偏高，立刻用消息表文案提示。
   */
  function setPassThrough(value: boolean): void {
    passThrough.value = value
    if (value) {
      ensureContext()
      applyGain()
      if (feedbackRisk.value) reportFeedbackRisk()
    } else {
      teardownPassThrough()
      feedbackReported = false
    }
  }

  function setEchoCancellation(value: boolean): void {
    // 注意：echoCancellation 是 getUserMedia 的约束，下一次准备采集时才真正生效
    // （采集链路在 useRecorder 里读取 settings.audio.echoCancellation）
    echoCancellation.value = value
    schedulePersist()
  }

  function setAutoLower(value: boolean): void {
    autoLowerWhileRecording.value = value
    applyGain()
  }

  function setRecordingActive(value: boolean): void {
    recordingActive.value = value
    applyGain()
  }

  function attachElement(element: HTMLMediaElement): void {
    const ctx = ensureContext()
    if (!ctx || !monitorGain) return
    try {
      let source = elementSources.get(element)
      if (!source) {
        source = ctx.createMediaElementSource(element)
        elementSources.set(element, source)
      }
      source.disconnect()
      // 只连监听增益，不连 destination：否则会以原始音量再放一遍
      source.connect(monitorGain)
      attachedCount.value = elementSources.size
    } catch {
      /* 同一个元素重复 createMediaElementSource 会抛错；此时它已经挂好了，忽略即可 */
    }
  }

  function detachElement(element: HTMLMediaElement): void {
    const source = elementSources.get(element)
    if (!source) return
    try {
      source.disconnect()
    } catch {
      /* 忽略 */
    }
    elementSources.delete(element)
    attachedCount.value = elementSources.size
  }

  function attachStream(stream: MediaStream | null): void {
    teardownPassThrough()
    if (!stream || !passThrough.value) return
    const ctx = ensureContext()
    if (!ctx || !monitorGain) return
    passThroughSource = ctx.createMediaStreamSource(stream)
    passThroughGain = ctx.createGain()
    // 直通音量固定，不跟监听音量叠加（否则两个滑块会互相影响，这就是 docs/12 §7 坑 3）
    passThroughGain.gain.value = 1
    passThroughSource.connect(passThroughGain)
    passThroughGain.connect(monitorGain)
    applyGain()
  }

  function teardownPassThrough(): void {
    try {
      passThroughSource?.disconnect()
      passThroughGain?.disconnect()
    } catch {
      /* 忽略 */
    }
    passThroughSource = null
    passThroughGain = null
  }

  function reportFeedbackRisk(): void {
    if (feedbackReported) return
    feedbackReported = true
    // 文案取自消息表（RECORD_MONITOR_FEEDBACK），不自己拼
    reportByKey('RECORD_MONITOR_FEEDBACK', undefined, { event: 'recording.monitorFeedback' })
  }

  /** 试听提示音：验证监听链路（1 kHz、250 ms、-12 dBFS） */
  function playTestTone(): void {
    const ctx = ensureContext()
    if (!ctx || !monitorGain) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 1000
    gain.gain.value = 0.25
    osc.connect(gain)
    gain.connect(monitorGain)
    osc.start()
    osc.stop(ctx.currentTime + 0.25)
  }

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      // 监听配置属于设置项（docs/04 §8.2 的 audio 段），由 settings store 落库
      void settingsStore.patch({
        audio: {
          monitorEnabled: enabled.value,
          monitorGainDb: gainDb.value,
          echoCancellation: echoCancellation.value,
        },
      }).catch(() => undefined)
    }, PERSIST_DEBOUNCE_MS)
  }

  // 设置被外部改动（设置页/任务包导入）时同步本地开关
  watch(() => settingsStore.audio, (next) => {
    if (!next) return
    enabled.value = next.monitorEnabled
    gainDb.value = next.monitorGainDb
    echoCancellation.value = next.echoCancellation
    settleEnabled()
  })

  // 音量变化后立刻反映到节点上（含「录音期间自动降低」）
  watch(effectiveGainDb, () => { applyGain() })

  function dispose(): void {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    teardownPassThrough()
    for (const [element, source] of elementSources) {
      try {
        source.disconnect()
      } catch {
        /* 忽略 */
      }
      void element
    }
    elementSources.clear()
    attachedCount.value = 0
    try {
      monitorGain?.disconnect()
    } catch {
      /* 忽略 */
    }
    monitorGain = null
    // 自建的上下文必须关掉；复用的采集图上下文由 useRecorder 负责关闭
    if (ownsContext) void context?.close().catch(() => undefined)
    context = null
    ownsContext = false
  }

  onScopeDispose(dispose)

  return {
    enabled, gainDb, passThrough, echoCancellation, autoLowerWhileRecording, recordingActive,
    latencyMs, effectiveGainDb, feedbackRisk, attachedCount,
    setEnabled, toggle, setGainDb, setPassThrough, setEchoCancellation, setAutoLower, setRecordingActive,
    attachElement, detachElement, attachStream, playTestTone, dispose,
  }
}
