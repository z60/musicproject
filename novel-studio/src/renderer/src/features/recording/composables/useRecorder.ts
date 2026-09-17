/**
 * 录音域 · 录音编排（核心）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §2   —— 会话生命周期：prepare → attachPort → start / pause / resume /
 *                     stop / abort；**状态机由主进程权威，本文件绝不自行推进状态**
 *   · docs/05 §2.1 —— 采样格式协商：`AudioContext({ sampleRate })` 只是请求值，
 *                     必须读回 `ctx.sampleRate` 确认并落库（否则时长与时间线会算错）
 *   · docs/05 §2.2 —— AudioWorklet 采集器（**四条硬性约束照此实现**：复制样本、
 *                     转移 ArrayBuffer、50 ms 包、永远 return true）
 *   · docs/05 §2.3 —— 渲染 → 主的零拷贝传输（MessagePort 直连，控制指令仍走 invoke）
 *   · docs/05 §2.5 —— 输入增益在写盘前施加；削波检测连续 ≥3 样本 |x| ≥ 0.99
 *   · docs/05 §11.3—— 实时波形：从采集块算 min/max，环形缓冲保留最近 5 秒
 *   · docs/12 §12  —— 设备中途拔出 → 立即停止 → 定稿已录部分 → 提示已保存多少
 *   · docs/12 §6.1 —— 「录 5 秒并回放」自检（useDeviceSelfTest）
 *   · docs/20 §7   —— 高频电平 ≤ 20/s，用单向 `send`（可丢弃），不用 invoke
 *   · docs/20 §8   —— preload 暴露面白名单
 *
 * ── 为什么 worklet 源码是模板字符串 ─────────────────────────────────────────
 *   docs/05 §2.2 的采集器要跑在 AudioWorkletGlobalScope。常规做法是
 *   `audioWorklet.addModule(new URL('./x.ts', import.meta.url))`，但那要求打包器把
 *   .ts 当资源解析（vite 需要插件支持），本仓库没有这样的配置。
 *   因此把源码写成模板字符串 → Blob → ObjectURL 加载：自包含、不依赖打包器资源解析。
 *   代价是这段 worklet 代码没有类型检查，所以它必须逐字对照文档实现。
 *
 * ── 关于 window.api 的一处例外（全仓库唯一）─────────────────────────────────
 *   项目规定「禁止 window.api.invoke」（docs/22 §6.2），本文件所有控制指令都走
 *   `call/send`。但把音频 MessagePort 交给主进程**只能**用 preload 暴露的
 *   `api.attachRecordPort(port)`（docs/20 §8 白名单项，实现是
 *   `ipcRenderer.postMessage('record:port', null, [port])`）。
 *   为把这个例外限制在一处，只有 `attachMainPort()` 会通过
 *   `globalThis.window?.api?.attachRecordPort` 取用这一个方法；组件与 store 一律不碰 window.api。
 */

import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { call, callSafe, send } from '@/shared/lib/ipc.ts'
import { reportError } from '@/shared/lib/error-bus.ts'
import { AppError } from '@shared/errors.ts'
import { formatBytes, formatDurationLong } from '@/shared/lib/format.ts'
import { AUDIO_DEFAULTS, RECORD_LIMITS, TRIM_DEFAULTS } from '@shared/constants.ts'
import type { IpcSendPayload } from '@shared/ipc.ts'
import type {
  AudioFormat,
  DeviceSelfTestResult,
  RecordPrepareResult,
  RecordStopResult,
  RecordingMode,
  TrimOptions,
} from '@shared/types.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useRecordingStore } from '../stores/recording.store.ts'
import { useLevelMeter } from './useLevelMeter.ts'
import type { UseLevelMeterReturn } from './useLevelMeter.ts'

// ---------------------------------------------------------------------------
// AudioWorklet 采集器（docs/05 §2.2 逐字实现）
// ---------------------------------------------------------------------------

/** 处理器名：`new AudioWorkletNode(ctx, PCM_WORKLET_PROCESSOR)` 必须与 registerProcessor 一致 */
export const PCM_WORKLET_PROCESSOR = 'pcm-capture'

export const PCM_CAPTURE_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    var packMs = (options && options.processorOptions && options.processorOptions.packMs) || 50
    // 目标包大小：sampleRate * 0.05（50 ms）。128 帧一块太小，每块一次 IPC 会打满消息队列
    this.packFrames = Math.max(128, Math.round(sampleRate * (packMs / 1000)))
    this.acc = []
    this.accFrames = 0
    this.port.onmessage = (event) => {
      var data = event && event.data
      // 停止前把不足一包的样本补发出去，避免丢掉最后几十毫秒
      if (data && data.type === 'flush') this.flush()
    }
  }

  process(inputs, outputs) {
    var ch = inputs[0] && inputs[0][0]
    // 硬性约束 4：无输入（静默期）也不能 return false —— 返回 false 会让处理器被回收
    if (!ch || ch.length === 0) return true
    // 硬性约束 1：必须 copy，inputs 的底层 buffer 会被引擎复用
    this.acc.push(new Float32Array(ch))
    this.accFrames += ch.length
    if (this.accFrames >= this.packFrames) this.flush()
    // 硬性约束 4：永远返回 true，除非要销毁
    return true
  }

  flush() {
    if (this.accFrames === 0) return
    var total = new Float32Array(this.accFrames)
    var off = 0
    for (var i = 0; i < this.acc.length; i++) {
      var b = this.acc[i]
      total.set(b, off)
      off += b.length
    }
    this.acc = []
    this.accFrames = 0
    // 硬性约束 2：postMessage 必须转移 ArrayBuffer（第二个参数），否则是结构化克隆拷贝
    this.port.postMessage({ type: 'pcm', frames: total.length, data: total.buffer }, [total.buffer])
  }
}

registerProcessor('${PCM_WORKLET_PROCESSOR}', PcmCaptureProcessor)
`

/** 电平上报节流：≤ 20 次/秒（docs/20 §7） */
const METER_MIN_INTERVAL_MS = 50
/** 静音汇点增益：接上 destination 才能保证 worklet 被持续拉取，又不会真的出声 */
const SILENT_GAIN = 0.0001

// ---------------------------------------------------------------------------
// 共用底层：AudioContext / worklet / 错误映射
// ---------------------------------------------------------------------------

interface CaptureGraph {
  context: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  gain: GainNode
  node: AudioWorkletNode
  sink: GainNode
  requestedSampleRate: number
  actualSampleRate: number
  /** 复用的判断依据：设备与采样率都没变时不必重新打开麦克风 */
  deviceId: string | null
}

function createAudioContext(requestedSampleRate: number): AudioContext | null {
  const ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext
  if (!ctor) return null
  // latencyHint: 'interactive' —— 录音图要求低延迟（docs/05 §11.1）
  return new ctor({ sampleRate: requestedSampleRate, latencyHint: 'interactive' })
}

/** Blob → ObjectURL → addModule（自包含加载，见文件头说明） */
async function loadPcmWorklet(context: AudioContext): Promise<void> {
  const blob = new Blob([PCM_CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' })
  const url = globalThis.URL.createObjectURL(blob)
  try {
    await context.audioWorklet.addModule(url)
  } finally {
    // 模块加载完成后立刻回收 ObjectURL，避免长期占用内存
    globalThis.URL.revokeObjectURL(url)
  }
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

/** 麦克风错误 → 消息表语义键（绝不自己拼错误文案） */
function micErrorKey(error: unknown): 'DEVICE_PERMISSION' | 'DEVICE_UNAVAILABLE' {
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'DEVICE_PERMISSION'
  return 'DEVICE_UNAVAILABLE'
}

/** 拆掉一条采集图（节点断开 + 轨道停止 + 关闭 AudioContext） */
async function teardownGraph(graph: CaptureGraph): Promise<void> {
  try {
    graph.node.port.onmessage = null
    graph.source.disconnect()
    graph.gain.disconnect()
    graph.node.disconnect()
    graph.sink.disconnect()
  } catch {
    /* 断开失败不影响后续释放 */
  }
  for (const track of graph.stream.getTracks()) track.stop()
  await graph.context.close().catch(() => undefined)
}

// ---------------------------------------------------------------------------
// useRecorder
// ---------------------------------------------------------------------------

export interface PrepareOptions {
  projectId: string
  chapterId: string | null
  mode: RecordingMode
  lineId?: string | null
  actorId?: string | null
  deviceId?: string | null
  /** 不传则用设置里的 audio.sampleRate / bitDepth / channels（落盘格式） */
  format?: AudioFormat
}

export interface StopOptions {
  lineId?: string | null
  trim?: TrimOptions
}

export interface RedoOptions extends StopOptions {
  /** 重录需要重新 prepare，必须给项目上下文（通常由录音页传当前 projectId） */
  projectId: string
  chapterId: string | null
  mode: RecordingMode
  actorId?: string | null
  deviceId?: string | null
}

export interface PunchInRequest {
  lineId: string
  srcInMs: number
  srcOutMs: number
  preRollMs: number
  postRollMs: number
}

export interface UseRecorderReturn {
  /** 采集侧本地状态（只描述渲染进程的采集图，不代表会话语义） */
  captureState: Ref<'idle' | 'acquiring' | 'ready' | 'failed'>
  requestedSampleRate: Ref<number>
  actualSampleRate: Ref<number>
  /** 请求与实际采样率不一致（docs/05 §2.1 的踩坑点，必须提示重采样） */
  sampleRateMismatch: ComputedRef<boolean>
  meter: UseLevelMeterReturn
  /** 已转投给主进程的采集块数/帧数（与 framesWritten 对照可发现丢块） */
  forwardedBlocks: Ref<number>
  forwardedFrames: Ref<number>
  /** 麦克风流（监听直通复用同一条流，docs/05 §11.2） */
  micStream: ShallowRef<MediaStream | null>
  /** 采集图建立后的 AudioContext（监听图复用它，避免两个上下文争设备） */
  captureContext: ShallowRef<AudioContext | null>
  prepare: (options: PrepareOptions) => Promise<RecordPrepareResult | null>
  start: () => Promise<boolean>
  pause: () => Promise<boolean>
  resume: () => Promise<boolean>
  stop: (options?: StopOptions) => Promise<RecordStopResult | null>
  abort: (keepFile?: boolean) => Promise<boolean>
  /** 丢弃本次并立刻重录（Ctrl+R / 踏板 redo，docs/12 §9.1） */
  redo: (options: RedoOptions) => Promise<boolean>
  /** 补录：建会话与采集图但**不立刻开录**，调用方播完 pre-roll 再 start()（docs/12 §8.2） */
  punchIn: (request: PunchInRequest) => Promise<string | null>
  /** 录制中打标记（单向、可丢弃） */
  mark: (kind: 'cut' | 'retake' | 'note') => void
  /** 注册实时采集块消费者（LiveWaveform 用），返回解除函数 */
  onPcmBlock: (handler: (samples: Float32Array, sampleRate: number) => void) => () => void
  /** 手动释放采集资源（离开页面时调用） */
  releaseCapture: () => Promise<void>
}

export function useRecorder(): UseRecorderReturn {
  const store = useRecordingStore()
  const settingsStore = useSettingsStore()
  const meter = useLevelMeter({ peakDecayDbPerSec: 24 })

  const captureState = ref<'idle' | 'acquiring' | 'ready' | 'failed'>('idle')
  const requestedSampleRate = ref<number>(AUDIO_DEFAULTS.sampleRate)
  const actualSampleRate = ref<number>(AUDIO_DEFAULTS.sampleRate)
  const forwardedBlocks = ref(0)
  const forwardedFrames = ref(0)
  const micStream = shallowRef<MediaStream | null>(null)
  const captureContext = shallowRef<AudioContext | null>(null)

  let graph: CaptureGraph | null = null
  let mainPort: MessagePort | null = null
  let blockHandlers: Array<(samples: Float32Array, sampleRate: number) => void> = []
  /** 采集块是否转投主进程：**由主进程状态驱动**（见下方 watch） */
  let capturing = false
  let lastMeterSentAt = 0
  let noSignalReported = false
  let deviceLostHandled = false
  let pendingFlushResolve: (() => void) | null = null

  const sampleRateMismatch = computed(
    () => requestedSampleRate.value > 0 && actualSampleRate.value > 0 && requestedSampleRate.value !== actualSampleRate.value,
  )

  // ── 状态机镜像：只有主进程说「recording」才真正转发样本 ────────────────────
  //     docs/20 §7「主进程权威，渲染进程只镜像」：
  //     如果这里乐观地把 capturing 置 true，就会出现「主进程还在 preparing、
  //     渲染进程已经狂发样本」的丢帧窗口。
  watch(
    () => store.state,
    (state) => {
      capturing = state === 'recording'
      if (state === 'idle' || state === 'done' || state === 'failed') noSignalReported = false
    },
    { immediate: true },
  )

  /** droppedFrames 恒为 0（docs/12 §13）：一旦非 0 必须提示，这是 P0 缺陷 */
  watch(
    () => store.droppedFrames,
    (dropped) => {
      if (dropped <= 0) return
      // 消息表里没有「丢帧」这一码（见汇报中的契约缺口），因此：
      // 1) 静默记日志（可查、可上报）；2) 界面上的红色警示条由 RecordingView 常驻显示。
      reportError(
        AppError.of('INTERNAL', {
          severity: 'error',
          action: 'contact_support',
          details: { invariant: 'droppedFrames === 0', droppedFrames: dropped, sessionId: store.sessionId },
        }),
        { event: 'recording.droppedFrames', silent: true, detailOverride: `丢帧 ${dropped}（采集完整性被破坏，P0）` },
      )
    },
  )

  // ── 采集图 ────────────────────────────────────────────────────────────────

  /** 唯一允许碰 window.api 的地方：把 MessagePort 交给主进程（docs/20 §8 白名单） */
  function attachMainPort(): MessagePort | null {
    try {
      const channel = new MessageChannel()
      const api = (globalThis as unknown as { window?: { api?: { attachRecordPort?: (p: MessagePort) => void } } }).window?.api
      if (!api?.attachRecordPort) {
        reportError(AppError.of('INTERNAL', { details: { reason: 'preload 未暴露 attachRecordPort' } }), {
          event: 'recording.attachPort.unavailable',
          detailOverride: '当前 preload 没有暴露音频端口通道，音频样本无法送出（需要重新构建 preload）。',
        })
        return null
      }
      // port1 留在渲染进程，port2 转给主进程（零拷贝通道，docs/05 §2.3）
      api.attachRecordPort(channel.port2)
      return channel.port1
    } catch (error) {
      reportError(error, { event: 'recording.attachPort.failed' })
      return null
    }
  }

  function closeMainPort(): void {
    try {
      mainPort?.close()
    } catch {
      /* 关闭失败无所谓：端口会随渲染进程一起回收 */
    }
    mainPort = null
  }

  /** 采集块到达：算电平 → 推给波形 → 转投主进程 → 20 Hz 上报电平 */
  function handlePcmBlock(samples: Float32Array, sampleRate: number): void {
    const sample = meter.pushBlock(samples, sampleRate)
    store.applyLocalMeter({
      rmsDb: sample.rmsDb,
      peakDb: sample.peakDb,
      clipping: sample.clipping,
      clipEvents: meter.clipEvents.value,
      overloadBlocks: meter.overloadBlocks.value,
    })

    // 波形消费者先拿数据 —— 转投主进程会把 ArrayBuffer 转移（detach）掉
    for (const handler of blockHandlers) handler(samples, sampleRate)

    // 只在主进程说「正在录」时转发（暂停期间不写盘，docs/12 §2）
    if (capturing) {
      if (mainPort) {
        // 硬性约束 2：转投时同样转移 ArrayBuffer（零拷贝）
        mainPort.postMessage({ type: 'pcm', frames: samples.length, data: samples.buffer }, [samples.buffer])
      }
      forwardedBlocks.value += 1
      forwardedFrames.value += samples.length

      const now = Date.now()
      if (store.sessionId && now - lastMeterSentAt >= METER_MIN_INTERVAL_MS) {
        lastMeterSentAt = now
        const payload: IpcSendPayload<'record:meter'> = {
          sessionId: store.sessionId,
          rmsDb: sample.rmsDb,
          peakDb: sample.peakDb,
          frames: samples.length,
        }
        send('record:meter', payload)
      }

      // 录满 3 秒仍无信号 → 强提示（不自动停止，docs/12 §12）
      if (!noSignalReported && store.durationMs >= 3000 && !meter.signalDetected.value) {
        noSignalReported = true
        reportError(AppError.of('RECORD_NO_SIGNAL', { params: { seconds: 3 } }), {
          event: 'recording.noSignal',
          action: 'open_settings',
        })
      }
    }

    // flush 的等待者：收到块即说明 worklet 已把缓冲吐出
    if (pendingFlushResolve) {
      const resolve = pendingFlushResolve
      pendingFlushResolve = null
      resolve()
    }
  }

  /**
   * 建立采集图：getUserMedia → 数字增益 → AudioWorklet → 静音汇点。
   * 增益放在 worklet **之前**：docs/05 §2.5 明确「写盘前施加数字增益」，
   * 这样电平表、削波检测与落盘峰值三者口径一致。
   */
  async function acquireCapture(deviceId: string | null, format: AudioFormat): Promise<boolean> {
    // 设备与采样率都没变时复用已有采集图：逐行录制连录 50 行时不必每行重开麦克风
    if (graph && captureState.value === 'ready' && graph.deviceId === deviceId && graph.requestedSampleRate === format.sampleRate) {
      return true
    }
    await releaseCapture()
    captureState.value = 'acquiring'

    const media = globalThis.navigator?.mediaDevices
    if (!media?.getUserMedia) {
      captureState.value = 'failed'
      reportError(AppError.of('DEVICE_UNAVAILABLE', { params: { device: deviceId ?? '默认输入设备' } }), {
        event: 'recording.getUserMedia.unsupported',
        detailOverride: '当前环境不支持音频采集接口（getUserMedia 不可用）。',
      })
      return false
    }

    const audio = settingsStore.audio
    const context = createAudioContext(format.sampleRate)
    if (!context) {
      captureState.value = 'failed'
      reportError(AppError.of('DEVICE_UNAVAILABLE', { params: { device: deviceId ?? '默认输入设备' } }), {
        event: 'recording.audioContext.unsupported',
        detailOverride: '当前环境不支持 Web Audio（AudioContext 不可用）。',
      })
      return false
    }

    requestedSampleRate.value = format.sampleRate

    let stream: MediaStream
    try {
      stream = await media.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: format.channels,
          echoCancellation: audio?.echoCancellation ?? false,
          // 采集侧一律关掉浏览器自己的降噪：它是为通话设计的，会改变音色（docs/12 §7 的坑）
          noiseSuppression: false,
          autoGainControl: audio?.agcEnabled ?? false,
        },
        video: false,
      })
    } catch (error) {
      captureState.value = 'failed'
      await context.close().catch(() => undefined)
      reportError(AppError.of(micErrorKey(error), { cause: error, params: { device: deviceId ?? '默认输入设备' } }), {
        event: 'recording.getUserMedia.denied',
        // retryFn 契约是「重试一次，无返回值」；acquireCapture 返回 boolean（是否拿到流），
        // 用 async 形态吞掉返回值（Promise<boolean> 不能赋给 Promise<void>）。
        retryFn: async () => {
          await acquireCapture(deviceId, format)
        },
      })
      return false
    }

    try {
      await loadPcmWorklet(context)
      // docs/05 §2.1：sampleRate 只是「请求值」，必须读回实际值
      actualSampleRate.value = context.sampleRate

      const source = context.createMediaStreamSource(stream)
      const gain = context.createGain()
      gain.gain.value = dbToLinear(audio?.inputGainDb ?? 0)
      const node = new AudioWorkletNode(context, PCM_WORKLET_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [format.channels],
        processorOptions: { packMs: AUDIO_DEFAULTS.packMs },
      })
      const sink = context.createGain()
      sink.gain.value = SILENT_GAIN

      source.connect(gain)
      gain.connect(node)
      node.connect(sink)
      sink.connect(context.destination)

      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; data?: ArrayBuffer } | null
        if (!data || data.type !== 'pcm' || !data.data) return
        handlePcmBlock(new Float32Array(data.data), context.sampleRate)
      }

      graph = {
        context, stream, source, gain, node, sink,
        requestedSampleRate: format.sampleRate,
        actualSampleRate: context.sampleRate,
        deviceId,
      }
      captureContext.value = context
      micStream.value = stream
      captureState.value = 'ready'

      // 设备热插拔（docs/12 §12）：中途拔出 → 先定稿保住已录素材，再提示
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => { void handleDeviceLost() })
      }

      if (context.state === 'suspended') await context.resume().catch(() => undefined)
      return true
    } catch (error) {
      captureState.value = 'failed'
      for (const track of stream.getTracks()) track.stop()
      await context.close().catch(() => undefined)
      reportError(error, { event: 'recording.captureGraph.failed' })
      return false
    }
  }

  async function releaseCapture(): Promise<void> {
    const current = graph
    graph = null
    micStream.value = null
    captureContext.value = null
    if (!current) return
    await teardownGraph(current)
    if (captureState.value === 'ready') captureState.value = 'idle'
  }

  /** 停止前把 worklet 里不足一包的样本冲出来（最多等 250 ms，绝不阻塞停止） */
  async function flushWorklet(): Promise<void> {
    const node = graph?.node
    if (!node) return
    await new Promise<void>((resolve) => {
      pendingFlushResolve = resolve
      try {
        node.port.postMessage({ type: 'flush' })
      } catch {
        pendingFlushResolve = null
        resolve()
        return
      }
      globalThis.setTimeout(() => {
        if (pendingFlushResolve) {
          pendingFlushResolve = null
          resolve()
        }
      }, 250)
    })
  }

  /** 设备中途断开：立即停止录音并定稿已录部分（顺序不能反，反了会丢素材） */
  async function handleDeviceLost(): Promise<void> {
    if (deviceLostHandled) return
    deviceLostHandled = true
    if (!store.sessionId) return
    reportError(
      AppError.of('DEVICE_LOST', { params: { duration: formatDurationLong(store.durationMs) } }),
      { event: 'recording.deviceLost' },
    )
    try {
      await stop({ lineId: store.lineId })
    } catch {
      /* 停止失败已由 error-bus 兑现；此处不要再抛出去打断 UI */
    }
  }

  // ── 会话控制（全部只是「请求主进程」，状态等 record:status 事件）──────────

  /** 默认裁剪参数：来自设置（audio.autoTrim / trimThresholdDb / trimPaddingMs） */
  function defaultTrim(): TrimOptions {
    const audio = settingsStore.audio
    return {
      enabled: audio?.autoTrim ?? TRIM_DEFAULTS.enabled,
      thresholdDb: audio?.trimThresholdDb ?? TRIM_DEFAULTS.thresholdDb,
      headPaddingMs: audio?.trimPaddingMs ?? TRIM_DEFAULTS.headPaddingMs,
      // 设置里只有一个 trimPaddingMs（首尾共用），缺失时用 docs/05 §5.3 的尾留白
      tailPaddingMs: audio?.trimPaddingMs ?? TRIM_DEFAULTS.tailPaddingMs,
    }
  }

  /** 落盘格式（采集侧恒为 float32，这里说的是写盘格式，docs/05 §2.1） */
  function resolveFormat(explicit?: AudioFormat): AudioFormat {
    if (explicit) return explicit
    const audio = settingsStore.audio
    return {
      sampleRate: audio?.sampleRate ?? AUDIO_DEFAULTS.sampleRate,
      bitDepth: audio?.bitDepth ?? AUDIO_DEFAULTS.fileBitDepth,
      channels: audio?.channels ?? AUDIO_DEFAULTS.channels,
    }
  }

  /**
   * 预检 + 建会话 + 建采集图 + 绑端口。
   * 磁盘空间：主进程在 preparing 阶段也会查（不足时返回 DISK_FULL）；这里额外用
   * **上一次会话上报的 diskFreeBytes** 提前拦住，避免白打断用户（docs/12 §2 约束 3）。
   */
  async function prepare(options: PrepareOptions): Promise<RecordPrepareResult | null> {
    const format = resolveFormat(options.format)

    if (store.diskFreeBytes > 0 && store.diskShortfallBytes > 0) {
      reportError(AppError.of('DISK_FULL', { params: { need: formatBytes(store.diskShortfallBytes) } }), {
        event: 'recording.preflight.diskLow',
        action: 'open_folder',
      })
      return null
    }

    let prepared: RecordPrepareResult
    try {
      prepared = (await call('record:prepare', {
        projectId: options.projectId,
        chapterId: options.chapterId,
        mode: options.mode,
        format,
        deviceId: options.deviceId ?? null,
        actorId: options.actorId ?? null,
      })) as RecordPrepareResult
    } catch (error) {
      // 已由 call() 交给 error-bus（磁盘不足 / 设备占用等错误码由主进程给出）
      store.setError(error)
      return null
    }

    store.setSession(prepared.sessionId, options.mode, options.chapterId, prepared.warnings ?? [])
    store.setLine(options.lineId ?? null)

    const ok = await acquireCapture(options.deviceId ?? null, format)
    if (!ok) {
      // 采集图没建起来：会话已创建，必须显式放弃，否则主进程会留一个空会话文件
      await callSafe('record:abort', { sessionId: prepared.sessionId, keepFile: false })
      store.reset()
      return null
    }

    deviceLostHandled = false
    mainPort = attachMainPort()
    await callSafe('record:attachPort', { sessionId: prepared.sessionId })
    return prepared
  }

  async function start(): Promise<boolean> {
    const sessionId = store.sessionId
    if (!sessionId) return false
    try {
      await call('record:start', { sessionId })
      return true
    } catch (error) {
      store.setError(error)
      return false
    }
  }

  async function pause(): Promise<boolean> {
    const sessionId = store.sessionId
    if (!sessionId) return false
    try {
      await call('record:pause', { sessionId })
      return true
    } catch (error) {
      store.setError(error)
      return false
    }
  }

  async function resume(): Promise<boolean> {
    const sessionId = store.sessionId
    if (!sessionId) return false
    try {
      await call('record:resume', { sessionId })
      return true
    } catch (error) {
      store.setError(error)
      return false
    }
  }

  async function stop(options: StopOptions = {}): Promise<RecordStopResult | null> {
    const sessionId = store.sessionId
    if (!sessionId) return null

    // 先把 worklet 里剩余样本冲出去，再让主进程定稿（否则会丢掉最后几十毫秒）
    await flushWorklet()

    try {
      const result = (await call('record:stop', {
        sessionId,
        lineId: options.lineId ?? store.lineId ?? undefined,
        trim: options.trim ?? defaultTrim(),
      })) as RecordStopResult
      store.setStopResult(result)
      return result
    } catch (error) {
      store.setError(error)
      return null
    } finally {
      // 无论成功失败都要停掉采集：继续采下去只会产生「没有会话可写」的噪音
      await releaseCapture()
    }
  }

  /** 放弃会话：删除会话文件（keepFile 默认 false），并彻底清掉本地采集资源 */
  async function abort(keepFile = false): Promise<boolean> {
    const sessionId = store.sessionId
    if (!sessionId) {
      await releaseCapture()
      store.reset()
      return false
    }
    const result = await callSafe('record:abort', { sessionId, keepFile })
    await releaseCapture()
    closeMainPort()
    deviceLostHandled = false
    meter.reset(actualSampleRate.value)
    forwardedBlocks.value = 0
    forwardedFrames.value = 0
    store.reset()
    return result?.ok ?? false
  }

  /**
   * 丢弃并重录（docs/12 §9.1）：
   *   · 正在录 → abort 掉本次（用户明确要求丢弃，不生成 take）
   *   · 空闲   → 直接为同一行重新准备并开始（旧 take 一律保留，docs/12 §8.1）
   */
  async function redo(options: RedoOptions): Promise<boolean> {
    const lineId = options.lineId ?? store.lineId
    if (store.isRecording || store.isPaused) {
      await abort(false)
    }
    const prepared = await prepare({
      projectId: options.projectId,
      chapterId: options.chapterId,
      mode: options.mode,
      lineId,
      actorId: options.actorId ?? null,
      deviceId: options.deviceId ?? null,
    })
    if (!prepared) return false
    return await start()
  }

  /**
   * 补录（punch-in，docs/12 §8.2）：
   * 只建会话与采集图，**不立刻开始录** —— 调用方先播 pre-roll（默认 2 s），
   * 到补录点再调 `start()`；pre/post-roll 的拼接由主进程完成。
   */
  async function punchIn(request: PunchInRequest): Promise<string | null> {
    try {
      const result = (await call('record:punchIn', {
        lineId: request.lineId,
        srcInMs: request.srcInMs,
        srcOutMs: request.srcOutMs,
        preRollMs: request.preRollMs,
        postRollMs: request.postRollMs,
      })) as { sessionId: string }

      store.setSession(result.sessionId, 'punch_in', store.chapterId, [])
      store.setLine(request.lineId)

      const ok = await acquireCapture(settingsStore.audio?.defaultInputDeviceId ?? null, resolveFormat())
      if (!ok) {
        await callSafe('record:abort', { sessionId: result.sessionId, keepFile: false })
        store.reset()
        return null
      }
      deviceLostHandled = false
      mainPort = attachMainPort()
      await callSafe('record:attachPort', { sessionId: result.sessionId })
      return result.sessionId
    } catch (error) {
      store.setError(error)
      return null
    }
  }

  /** 录制中打标记：时间点以主进程上报的 durationMs 为准（渲染侧不自己计时） */
  function mark(kind: 'cut' | 'retake' | 'note'): void {
    const sessionId = store.sessionId
    if (!sessionId) return
    const atMs = store.durationMs
    send('record:mark', { sessionId, kind, atMs })
    store.addMark(kind, atMs)
  }

  function onPcmBlock(handler: (samples: Float32Array, sampleRate: number) => void): () => void {
    blockHandlers = [...blockHandlers, handler]
    return () => {
      blockHandlers = blockHandlers.filter(h => h !== handler)
    }
  }

  // 离开页面时释放采集资源（不 abort：录音文件由主进程负责写完）
  onScopeDispose(() => {
    blockHandlers = []
    closeMainPort()
    void releaseCapture()
  })

  return {
    captureState, requestedSampleRate, actualSampleRate, sampleRateMismatch,
    meter, forwardedBlocks, forwardedFrames, micStream, captureContext,
    prepare, start, pause, resume, stop, abort, redo, punchIn, mark,
    onPcmBlock, releaseCapture,
  }
}

// ---------------------------------------------------------------------------
// 设备自检（docs/12 §6.1「录 5 秒并回放」）
// ---------------------------------------------------------------------------

export interface SelfTestOptions {
  durationMs?: number
  deviceId?: string | null
  sampleRate?: number
  channels?: 1 | 2
}

export interface UseDeviceSelfTestReturn {
  running: Ref<boolean>
  elapsedMs: Ref<number>
  capturedFrames: Ref<number>
  requestedSampleRate: Ref<number>
  actualSampleRate: Ref<number>
  latencyMs: Ref<number | null>
  result: ShallowRef<DeviceSelfTestResult | null>
  meter: UseLevelMeterReturn
  start: (options?: SelfTestOptions) => Promise<DeviceSelfTestResult | null>
  /** 提前结束（录满时长会自动结束） */
  stop: () => void
  /** 回放刚才采集的音频（纯渲染侧 AudioBuffer，不落盘，docs/12 §6.1「录 5 秒并回放」） */
  play: () => Promise<boolean>
  release: () => Promise<void>
}

/**
 * 自检：采集 → 电平/底噪/削波统计 → 采样率与延迟实测 → 回放。
 * 结论文案**取自消息表**（不自己拼「听不到声音」这类错误描述，docs/22 §6.2）。
 */
export function useDeviceSelfTest(): UseDeviceSelfTestReturn {
  const meter = useLevelMeter({ noiseWindowMs: 3000 })
  const running = ref(false)
  const elapsedMs = ref(0)
  const capturedFrames = ref(0)
  const requestedSampleRate = ref<number>(AUDIO_DEFAULTS.sampleRate)
  const actualSampleRate = ref<number>(AUDIO_DEFAULTS.sampleRate)
  const latencyMs = ref<number | null>(null)
  const result = shallowRef<DeviceSelfTestResult | null>(null)

  let graph: CaptureGraph | null = null
  let chunks: Float32Array[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let startedAt = 0
  let durationMs = 5000

  async function release(): Promise<void> {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    const current = graph
    graph = null
    if (current) await teardownGraph(current)
  }

  /** docs/12 §6.2：可读出的只有 baseLatency + outputLatency，输入延迟无法直接读 → 标注为估算 */
  function computeLatency(context: AudioContext): number | null {
    const base = Number(context.baseLatency ?? 0)
    const output = Number((context as AudioContext & { outputLatency?: number }).outputLatency ?? 0)
    const total = base + output
    return total > 0 ? Math.round(total * 1000) : null
  }

  /** 结论里的错误类描述一律取消息表 */
  function describe(key: 'RECORD_NO_SIGNAL' | 'RECORD_CLIPPING', params?: Record<string, string | number>): string {
    const resolved = AppError.of(key, params ? { params } : undefined).resolved
    return resolved.hint ? `${resolved.title}：${resolved.hint}` : resolved.title
  }

  /**
   * 汇总自检结论，检查项与 docs/12 §6.1 一一对应：
   *   1. 是否有信号（RMS > -50 dBFS）  2. 是否削波  3. 是否丢帧
   *   4. 底噪水平（滑动 3 秒 10 分位） 5. 实际采样率 vs 请求采样率
   */
  function buildResult(): DeviceSelfTestResult {
    const expectedFrames = Math.round((actualSampleRate.value * Math.max(1, elapsedMs.value)) / 1000)
    const dropped = Math.max(0, expectedFrames - capturedFrames.value)
    const hasSignal = meter.signalDetected.value
    const clipping = meter.clipEvents.value > 0 || meter.overloadBlocks.value > 0

    const suggestions: string[] = []
    if (!hasSignal) suggestions.push(describe('RECORD_NO_SIGNAL', { seconds: Math.round(elapsedMs.value / 1000) }))
    if (clipping) suggestions.push(describe('RECORD_CLIPPING', { count: meter.clipEvents.value }))
    if (requestedSampleRate.value !== actualSampleRate.value) {
      suggestions.push(
        `请求 ${requestedSampleRate.value} Hz，设备实际 ${actualSampleRate.value} Hz；请按实际采样率记录并在采集后重采样。`,
      )
    }
    if (dropped > 0) suggestions.push(`本次采集缺少约 ${dropped} 帧样本，请检查设备与系统负载后重试自检。`)
    if (meter.noiseFloorHigh.value) suggestions.push('底噪偏高，建议在处理链中启用降噪，并把噪声底设为实测值。')

    return {
      hasSignal,
      clipping,
      droppedFrames: dropped,
      noiseFloorDb: meter.noiseFloorDb.value,
      peakDb: meter.peakDb.value,
      rmsDb: meter.rmsDb.value,
      requestedSampleRate: requestedSampleRate.value,
      actualSampleRate: actualSampleRate.value,
      latencyMs: latencyMs.value,
      suggestion: suggestions.length ? suggestions.join(' ') : null,
    }
  }

  async function start(options: SelfTestOptions = {}): Promise<DeviceSelfTestResult | null> {
    await release()
    meter.reset()
    chunks = []
    capturedFrames.value = 0
    elapsedMs.value = 0
    result.value = null
    durationMs = options.durationMs ?? 5000
    requestedSampleRate.value = options.sampleRate ?? AUDIO_DEFAULTS.sampleRate

    const media = globalThis.navigator?.mediaDevices
    if (!media?.getUserMedia) {
      reportError(AppError.of('DEVICE_UNAVAILABLE', { params: { device: options.deviceId ?? '默认输入设备' } }), {
        event: 'selfTest.unsupported',
      })
      return null
    }

    const context = createAudioContext(requestedSampleRate.value)
    if (!context) {
      reportError(AppError.of('DEVICE_UNAVAILABLE', { params: { device: options.deviceId ?? '默认输入设备' } }), {
        event: 'selfTest.noAudioContext',
      })
      return null
    }

    let stream: MediaStream
    try {
      stream = await media.getUserMedia({
        audio: {
          ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
          channelCount: options.channels ?? 1,
          // 自检要看到设备的真实情况，因此关闭一切浏览器侧处理
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      })
    } catch (error) {
      await context.close().catch(() => undefined)
      reportError(AppError.of(micErrorKey(error), { cause: error, params: { device: options.deviceId ?? '默认输入设备' } }), {
        event: 'selfTest.getUserMedia.failed',
      })
      return null
    }

    try {
      await loadPcmWorklet(context)
      actualSampleRate.value = context.sampleRate
      latencyMs.value = computeLatency(context)

      const source = context.createMediaStreamSource(stream)
      const gain = context.createGain()
      gain.gain.value = 1
      const node = new AudioWorkletNode(context, PCM_WORKLET_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [options.channels ?? 1],
        processorOptions: { packMs: AUDIO_DEFAULTS.packMs },
      })
      const sink = context.createGain()
      sink.gain.value = SILENT_GAIN
      source.connect(gain)
      gain.connect(node)
      node.connect(sink)
      sink.connect(context.destination)

      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; data?: ArrayBuffer } | null
        if (!data || data.type !== 'pcm' || !data.data) return
        const samples = new Float32Array(data.data)
        // 留下副本用于回放与底噪统计（这里不转投，所以不需要 transfer）
        chunks.push(samples)
        capturedFrames.value += samples.length
        meter.pushBlock(samples, context.sampleRate)
      }

      graph = {
        context, stream, source, gain, node, sink,
        requestedSampleRate: requestedSampleRate.value,
        actualSampleRate: context.sampleRate,
        deviceId: options.deviceId ?? null,
      }
      if (context.state === 'suspended') await context.resume().catch(() => undefined)

      running.value = true
      startedAt = Date.now()
      timer = setInterval(() => { elapsedMs.value = Date.now() - startedAt }, 100)

      // 录满时长（或用户手动 stop）后收尾
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!running.value || Date.now() - startedAt >= durationMs) {
            clearInterval(check)
            resolve()
          }
        }, 100)
      })

      elapsedMs.value = Math.min(durationMs, Date.now() - startedAt)
      const summary = buildResult()
      result.value = summary
      running.value = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      return summary
    } catch (error) {
      running.value = false
      reportError(error, { event: 'selfTest.captureFailed' })
      return null
    }
  }

  function stop(): void {
    running.value = false
  }

  async function play(): Promise<boolean> {
    const context = graph?.context
    if (!context || !chunks.length) return false
    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    if (total === 0) return false
    const buffer = context.createBuffer(1, total, context.sampleRate)
    const channel = buffer.getChannelData(0)
    let offset = 0
    for (const chunk of chunks) {
      channel.set(chunk, offset)
      offset += chunk.length
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.start()
    return true
  }

  onScopeDispose(() => { void release() })

  return {
    running, elapsedMs, capturedFrames, requestedSampleRate, actualSampleRate, latencyMs,
    result, meter, start, stop, play, release,
  }
}

/** 会话时长上限（docs/12 §12「单会话默认上限 4 小时」），UI 公示用 */
export const SESSION_LIMIT_MINUTES = RECORD_LIMITS.defaultMaxSessionMinutes
