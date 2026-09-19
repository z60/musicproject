/**
 * Novel Studio · 录音服务（`record:*` 12 个通道，主进程侧）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §2    会话生命周期（prepare → attachPort → start → pause/resume → stop / abort）
 *   · docs/12 §3.2  「一次按键 → 一次成品」：定稿 → 静音修剪 → 生成 take → 建成品
 *   · docs/12 §3.3  最短录音保护（< 150 ms 视为误触，**不生成 take**）
 *   · docs/12 §4.3  连续录制：停止后 VAD 切片 → 与画本行匹配 → 人工确认（`acceptSlices`）
 *   · docs/12 §8.2  补录（punch-in）：pre/post 与本次录音拼接
 *   · docs/05 §2    采集侧恒为 float32，落盘位深由设置决定
 *   · docs/05 §9    崩溃恢复：会话文件先落盘，头部长度占位由 recovery 修复
 *
 * ### 采样怎么到达主进程
 *   渲染进程用 `MessageChannel` 把 AudioWorklet 的交错 float32 块经 preload
 *   （`ipcRenderer.postMessage('record:port', null, [port])`）转给主进程。
 *   主进程只有一个入口 `attachIncomingPort(port)`（`src/main/index.ts` 在收到
 *   `record:port` 时调用）。**端口到达 ≠ 归哪个会话**：`attachPort(sessionId)`
 *   才是渲染侧「这个信道归这个会话」的声明。两侧顺序颠倒时早到的端口/块会被排队
 *   （端口按 FIFO 认领，块最多缓冲 1 秒），超出缓冲的部分记进 `dropped_frames`
 *   —— 那是 P0 指标（docs/12 §13 要求恒为 0），宁可记下来，也不静默丢。
 *
 * ### 本服务**不**做的事（如实记录，见 docs/91 §5.2.20）
 *   · 不做 ASR：`record:matchSlices` 的 `useAsr` 会被接受，但结果是时长对齐，
 *     日志里明确记 `record.asrUnavailable`，不伪造识别结果。
 *   · 不做重采样：补录要求「会话格式 == 被补录 take 格式」，不一致直接报错。
 *   · 不改写 take 文件做修剪（`record:optimizeTrim` 只**报建议区间**），落地交给处理链。
 */

import { rmSync, statfsSync } from 'node:fs'

import { AppError } from '../../../shared/errors.ts'
import type {
  AudioFormat,
  Id,
  RecordStopResult,
  RecordingMode,
  RecordingSession,
  SliceMatch,
  Take,
  TrimOptions,
  VadOptions,
  VadSlice,
  VoiceSegment,
} from '../../../shared/types.ts'
import { RECORD_LIMITS } from '../../../shared/constants.ts'
import {
  computePeakDb,
  computeRmsDb,
  float32LEToFloat32,
  int16LEToFloat32,
  int24LEToFloat32,
} from '../../../shared/audio/pcm.ts'
import { detectSlices } from '../../../shared/audio/vad.ts'
import { computeTrimRange, defaultTrimOptions } from '../../../shared/audio/trim.ts'
import { matchSlicesToLines } from '../../../shared/audio/match.ts'
import type { Logger } from '../../infra/log/index.ts'
import {
  copyAudioFile,
  readWavPayload,
  resolveAudioPath,
  slicePayload,
  writeWavPayload,
} from './audio-file.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { AudioProjectScope } from './project-scope.ts'
import { createSessionWriter, type SessionWriter } from './session-writer.ts'
import type { RecordingSessionRepo } from './repositories/recording-session.repo.ts'
import type { TakeRepo } from './repositories/take.repo.ts'
import type { VoiceSegmentRepo } from './repositories/voice-segment.repo.ts'

/** 端口未认领前最多缓冲的帧数（约 1 秒 @48k），超出计丢帧 */
export const PRE_ATTACH_BUFFER_FRAMES = 48_000

/** 采集块（渲染侧发来的是**交错** float32） */
export interface PcmBlock {
  frames: number
  data: ArrayBuffer
}

/** 会话的运行时状态（**不进库**：重启后采集侧已不存在，库里的 status 才是权威） */
interface LiveSession {
  session: RecordingSession
  writer: SessionWriter
  state: 'ready' | 'recording' | 'paused' | 'closed'
  port: RecordPortLike | null
  /** `attachPort` 之前到达的块 */
  pending: Float32Array[]
  pendingFrames: number
  droppedFrames: number
  /** 补录上下文（punch-in 用） */
  punch?: {
    takeId: Id
    headPayload: Buffer
    tailPayload: Buffer
    format: AudioFormat
    srcInMs: number
    srcOutMs: number
    preRollMs: number
    postRollMs: number
  }
}

/**
 * 端口的最小接口。
 *
 * 为什么不直接用 Electron 的 `MessagePortMain`：那会让本服务在 Node 测试里无法构造。
 * 这里只依赖「能收 message、能 close」这一小面；真机上 Electron 的端口天然满足。
 */
export interface RecordPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  close?(): void
}

/**
 * 切片结果的存储。
 *
 * 为什么不建表：契约里没有「列切片」的通道，切片只是**一次会话的中间结果**，
 * 会话结束就没有读者。建表要多一份迁移与一致性责任，却没有任何通道能查到它。
 * 进程重启后重跑 `record:slice` 即可（原始会话文件永不自动删）。
 */
export interface SliceStore {
  set(sessionId: Id, slices: VadSlice[]): void
  get(sessionId: Id): VadSlice[] | undefined
}

export function createMemorySliceStore(): SliceStore {
  const map = new Map<Id, VadSlice[]>()
  return {
    set(sessionId, list) {
      map.set(sessionId, list)
    },
    get(sessionId) {
      return map.get(sessionId)
    },
  }
}

export interface RecordServiceDeps {
  /** `{userData}/projects`（项目目录的父目录） */
  projectRoot: () => string
  scope: AudioProjectScope
  sessionRepo: () => RecordingSessionRepo
  takeRepo: () => TakeRepo
  segmentRepo: () => VoiceSegmentRepo
  /** 画本行的章节 id（写 take/segment 时要） */
  lineChapterId: (lineId: Id) => Promise<Id | null>
  /** 某一章画本行的文本长度（匹配切片时估算期望时长） */
  lineCharCounts: (chapterId: Id) => Promise<Array<{ lineId: Id; charCount: number }>>
  slicesStore?: SliceStore
  /** 录音设置（VAD/trim 的默认值来源） */
  audioSettings?: () => { vad?: Partial<VadOptions>; trim?: Partial<TrimOptions> } | undefined
  /** 磁盘可用空间（默认 `statfsSync`；测试可注入） */
  freeBytes?: (dir: string) => number
  /** 事件推送（record:status / record:level / record:sliceProgress） */
  events?: { emit(event: string, payload: Record<string, unknown>): void }
  newId?: (prefix: string) => Id
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface RecordService {
  prepare(req: {
    projectId: Id
    chapterId: Id | null
    mode: RecordingMode
    format: AudioFormat
    deviceId?: string | null
    actorId?: Id | null
    deviceLabel?: string | null
  }): Promise<{ sessionId: Id; warnings: string[] }>
  /** 端口到达（`src/main/index.ts` 在 `record:port` 上调用） */
  attachIncomingPort(port: RecordPortLike): void
  attachPort(sessionId: Id): Promise<{ ok: boolean }>
  start(sessionId: Id): Promise<{ ok: boolean }>
  pause(sessionId: Id): Promise<{ ok: boolean }>
  resume(sessionId: Id): Promise<{ ok: boolean }>
  stop(sessionId: Id, lineId: Id | null, trim?: TrimOptions): Promise<RecordStopResult>
  abort(sessionId: Id, keepFile: boolean): Promise<{ ok: boolean }>
  punchIn(req: {
    lineId: Id
    srcInMs: number
    srcOutMs: number
    preRollMs: number
    postRollMs: number
  }): Promise<{ sessionId: Id }>
  slice(sessionId: Id, vad: VadOptions): Promise<{ slices: VadSlice[] }>
  matchSlices(req: {
    sessionId: Id
    chapterId: Id
    slices: VadSlice[]
    useAsr?: boolean
  }): Promise<{ matches: SliceMatch[]; unmatchedSlices: number[]; unrecordedLines: Id[] }>
  acceptSlices(sessionId: Id, accepted: SliceMatch[]): Promise<{ createdTakes: number; createdSegments: number }>
  optimizeTrim(takeId: Id, options: TrimOptions): Promise<{ trimmedInMs: number; trimmedOutMs: number }>
  /** 单向通道 `record:mark` */
  onMark(payload: { sessionId: Id; kind: 'cut' | 'retake' | 'note'; atMs: number }): Promise<void>
  /** 单向通道 `record:meter`（用于丢帧核对；电平本身以渲染侧为准） */
  onMeter(payload: { sessionId: Id; rmsDb: number; peakDb: number; frames: number }): Promise<void>
  /** 退出/关窗时收敛所有会话（不留 open 的文件句柄） */
  closeAll(reason: string): void
}

export function createRecordService(deps: RecordServiceDeps): RecordService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`)
  const now = deps.now ?? (() => Date.now())
  const slices = deps.slicesStore ?? createMemorySliceStore()
  const log = deps.log
  const live = new Map<Id, LiveSession>()
  /** 早于会话到达的端口（渲染侧在某些时序下会先 attach 再 attachPort） */
  const pendingPorts: RecordPortLike[] = []
  const freeBytes = deps.freeBytes ?? defaultFreeBytes

  /** 项目内绝对路径（`{projectRoot}/{projectId}/{relative}`，与 ns-media 协议一致） */
  const absOf = (projectId: Id, relative: string): string =>
    resolveAudioPath(projectAudioRoot(deps.projectRoot(), projectId), relative)

  function requireLive(sessionId: Id): LiveSession {
    const s = live.get(sessionId)
    if (!s) {
      throw new AppError('NOT_FOUND', {
        details: {
          entity: 'record_session(live)',
          sessionId,
          hint: '会话不在活跃表里：可能应用重启过（采集侧已不存在），请重新开始一次录音',
        },
      })
    }
    return s
  }

  function durationOf(s: LiveSession): number {
    const rate = s.session.format.sampleRate
    return rate > 0 ? Math.round((s.writer.framesWritten / rate) * 1000) : 0
  }

  function emitStatus(s: LiveSession, state: string): void {
    deps.events?.emit('record:status', {
      sessionId: s.session.id,
      state,
      framesWritten: s.writer.framesWritten,
      durationMs: durationOf(s),
      droppedFrames: s.droppedFrames,
      diskFreeBytes: freeBytes(deps.projectRoot()),
    })
  }

  /** 采集块到达：写盘或缓冲。异常只记日志，不让它冒进 Electron 的事件回调 */
  function feed(s: LiveSession, interleaved: Float32Array): void {
    const channels = Math.max(1, s.session.format.channels)
    const frames = Math.floor(interleaved.length / channels)
    if (s.state === 'recording') {
      if (s.port === null) {
        if (s.pendingFrames + frames > PRE_ATTACH_BUFFER_FRAMES) {
          // 缓冲已满：这一段真的丢了。记进 dropped_frames（P0 指标）而不是假装无事
          s.droppedFrames += frames
          return
        }
        s.pending.push(interleaved)
        s.pendingFrames += frames
        return
      }
      try {
        s.writer.append(interleaved)
      } catch (e) {
        log?.error?.('record.writeFailed', {
          event: 'record.writeFailed',
          sessionId: s.session.id,
          reason: e instanceof Error ? e.message : String(e),
        })
        s.state = 'closed'
        s.droppedFrames += frames
      }
      return
    }
    // ready/paused/closed 期间的块：采集侧此时不该发；真发了就是渲染侧的问题，
    // 计入丢帧让它可见（ready 阶段还可能是「倒计时里提前开麦」，同样值得发现）
    if (s.state !== 'ready') s.droppedFrames += frames
  }

  function flushPending(s: LiveSession): void {
    if (s.pending.length === 0) return
    for (const block of s.pending) {
      try {
        s.writer.append(block)
      } catch (e) {
        log?.warn?.('record.pendingDropped', {
          event: 'record.pendingDropped',
          sessionId: s.session.id,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    }
    s.pending = []
    s.pendingFrames = 0
  }

  function bindPort(s: LiveSession, port: RecordPortLike): void {
    s.port = port
    port.on('message', (e) => {
      try {
        const block = e.data as PcmBlock | null
        if (!block || typeof block !== 'object' || !(block.data instanceof ArrayBuffer)) return
        feed(s, new Float32Array(block.data))
      } catch (err) {
        log?.error?.('record.portMessageFailed', {
          event: 'record.portMessageFailed',
          sessionId: s.session.id,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /** 写/更新该行的成品片段（与 `take.service` 同一套文件与库语义） */
  async function materializeSegment(lineId: Id, take: Take): Promise<VoiceSegment> {
    const chapterId = await deps.lineChapterId(lineId)
    if (!chapterId) throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId } })
    const projectId = await deps.scope.projectIdOfLine(lineId)
    const root = projectAudioRoot(deps.projectRoot(), projectId)
    const segments = deps.segmentRepo()
    const existing = await segments.getByLine(lineId)
    const segmentId = existing?.id ?? newId('seg')
    const relative = `segments/${segmentId}.wav`

    await copyAudioFile(root, take.filePath, relative)
    const file = await readWavPayload(root, relative)
    const measured = measure(decodeMono(file.payload, file.format), file.format.sampleRate)
    const ts = now()
    const segment: VoiceSegment = {
      id: segmentId,
      lineId,
      chapterId,
      takeId: take.id,
      filePath: relative,
      processedPath: null,
      presetHash: null,
      srcInMs: take.srcInMs,
      srcOutMs: take.srcOutMs,
      durationMs: measured.durationMs,
      peakDb: measured.peakDb,
      rmsDb: measured.rmsDb,
      lufs: null,
      flags: [],
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    }
    const saved = await segments.upsertByLine(segment)
    log?.info?.('record.segmentMaterialized', {
      event: 'record.segmentMaterialized',
      lineId,
      takeId: take.id,
      segmentId: saved.id,
      filePath: saved.filePath,
      durationMs: saved.durationMs,
    })
    return saved
  }

  return {
    async prepare(req) {
      const warnings: string[] = []
      const format = req.format

      // ① 磁盘预检（docs/12 §2 约束 3）：不足时明确 DISK_FULL，而不是「录到一半满了」
      const required = RECORD_LIMITS.requiredFreeBytes
      const dir = deps.projectRoot()
      const free = freeBytes(dir)
      if (free >= 0 && free < required) {
        throw new AppError('DISK_FULL', {
          details: {
            op: 'record:prepare',
            need: required,
            free,
            hint: `录音前要求至少 ${Math.round(required / 1024 / 1024)} MB 可用空间`,
          },
        })
      }
      if (free < 0) {
        warnings.push('无法读取可用磁盘空间：录音仍会开始，但这段时间里空间不足只会在写盘失败时才发现。')
      }
      if (format.bitDepth === 16) {
        warnings.push('当前落盘位深为 16 位：增益失误的余量较小（docs/05 §2.5 建议 24/32 位）。')
      }

      const sessionId = newId('sess')
      const relative = `recordings/${sessionId}.wav`
      const session: RecordingSession = {
        id: sessionId,
        projectId: req.projectId,
        chapterId: req.chapterId,
        mode: req.mode,
        actorId: req.actorId ?? null,
        filePath: relative,
        format,
        durationMs: 0,
        peakDb: null,
        rmsDb: null,
        gainDb: 0,
        deviceLabel: req.deviceLabel ?? null,
        deviceId: req.deviceId ?? null,
        droppedFrames: 0,
        status: 'active',
        marks: [],
        startedAt: now(),
        finishedAt: null,
      }
      // 先落库、再开文件：反过来的话，开文件成功而入库失败会留下一个没人认领的 WAV
      // （清理按会话记录来，它既不会被清理也不会被使用）
      const saved = await deps.sessionRepo().insert(session)
      const writer = createSessionWriter({ filePath: absOf(req.projectId, relative), format })
      const state: LiveSession = {
        session: saved,
        writer,
        state: 'ready',
        port: null,
        pending: [],
        pendingFrames: 0,
        droppedFrames: 0,
      }
      live.set(sessionId, state)

      const waiting = pendingPorts.shift()
      if (waiting) {
        bindPort(state, waiting)
        warnings.push('采集端口先于会话建立到达：已自动绑定（正常顺序是 prepare → 端口 → attachPort）。')
      }

      log?.info?.('record.prepared', {
        event: 'record.prepared',
        sessionId,
        mode: req.mode,
        filePath: relative,
        format,
        freeBytes: free,
      })
      return { sessionId, warnings }
    },

    attachIncomingPort(port) {
      for (const s of live.values()) {
        if (s.state === 'ready' && s.port === null) {
          bindPort(s, port)
          return
        }
      }
      pendingPorts.push(port)
      log?.warn?.('record.portUnclaimed', {
        event: 'record.portUnclaimed',
        pending: pendingPorts.length,
        note: '没有处于 ready 的会话：端口先排队，attachPort 按 FIFO 认领',
      })
    },

    async attachPort(sessionId) {
      const s = requireLive(sessionId)
      if (s.port !== null) return { ok: true }
      const waiting = pendingPorts.shift()
      if (!waiting) {
        // 没有端口就明确报错，否则用户会遇到「进度条在走、音量条在动、文件永远是空的」
        // ——那种状态没有任何日志能指向原因
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'record:attachPort',
            reason: 'no-port-received',
            sessionId,
            hint: 'preload 的 attachRecordPort 没把 MessagePort 送达主进程（检查 preload 是否重新构建）',
          },
        })
      }
      bindPort(s, waiting)
      if (s.pending.length > 0 && s.state === 'recording') flushPending(s)
      return { ok: true }
    },

    async start(sessionId) {
      const s = requireLive(sessionId)
      if (s.state === 'closed') {
        throw new AppError('INVALID_PAYLOAD', { details: { op: 'record:start', reason: 'session-closed', sessionId } })
      }
      s.state = 'recording'
      emitStatus(s, 'recording')
      log?.info?.('record.started', { event: 'record.started', sessionId })
      return { ok: true }
    },

    async pause(sessionId) {
      const s = requireLive(sessionId)
      if (s.state !== 'recording') {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'record:pause', reason: 'not-recording', sessionId, state: s.state },
        })
      }
      s.state = 'paused'
      emitStatus(s, 'paused')
      return { ok: true }
    },

    async resume(sessionId) {
      const s = requireLive(sessionId)
      if (s.state !== 'paused') {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'record:resume', reason: 'not-paused', sessionId, state: s.state },
        })
      }
      s.state = 'recording'
      flushPending(s)
      emitStatus(s, 'recording')
      return { ok: true }
    },

    async stop(sessionId, lineId, trim) {
      const s = requireLive(sessionId)
      if (s.state === 'closed') {
        throw new AppError('INVALID_PAYLOAD', { details: { op: 'record:stop', reason: 'session-closed', sessionId } })
      }
      // ① 定稿文件（回填头部长度）并断开采集端口
      const finalized = s.writer.finalize()
      s.state = 'closed'
      try {
        s.port?.close?.()
      } catch {
        /* 端口关不掉不影响文件：随渲染进程一起回收 */
      }
      s.port = null

      const projectId = s.session.projectId
      const root = projectAudioRoot(deps.projectRoot(), projectId)
      const rate = s.session.format.sampleRate

      // ② 测量（峰值/RMS 落在会话上，UI 与质检都用它）
      const payload = await readWavPayload(root, s.session.filePath)
      const mono = decodeMono(payload.payload, payload.format)
      const measured = measure(mono, rate)

      // ③ 定稿入库
      let session = await deps.sessionRepo().finalize(sessionId, {
        status: 'finalized',
        durationMs: measured.durationMs,
        peakDb: measured.peakDb,
        rmsDb: measured.rmsDb,
        droppedFrames: s.droppedFrames,
        finishedAt: now(),
      })
      if (s.droppedFrames > 0) {
        log?.warn?.('record.droppedFrames', {
          event: 'record.droppedFrames',
          sessionId,
          droppedFrames: s.droppedFrames,
          note: 'docs/12 §13：dropped_frames 非 0 即 P0 缺陷，必须能从这个字段复现',
        })
      }

      // ④ 没有归属行（连续/素材模式）：会话到此为止，take 由切片确认产生
      if (!lineId) {
        live.delete(sessionId)
        deps.events?.emit('record:status', {
          sessionId,
          state: 'done',
          framesWritten: finalized.frames,
          durationMs: measured.durationMs,
          droppedFrames: s.droppedFrames,
          diskFreeBytes: freeBytes(deps.projectRoot()),
        })
        return { session, take: null, segment: null }
      }

      // ⑤ 最短录音保护（docs/12 §3.3）：误触不产出 take，否则 take 列表会被垃圾塞满
      if (measured.durationMs < RECORD_LIMITS.minTakeMs) {
        log?.warn?.('record.tooShort', {
          event: 'record.tooShort',
          sessionId,
          lineId,
          durationMs: measured.durationMs,
          minTakeMs: RECORD_LIMITS.minTakeMs,
        })
        live.delete(sessionId)
        deps.events?.emit('record:status', {
          sessionId,
          state: 'done',
          framesWritten: finalized.frames,
          durationMs: measured.durationMs,
          droppedFrames: s.droppedFrames,
          diskFreeBytes: freeBytes(deps.projectRoot()),
        })
        return { session, take: null, segment: null }
      }

      const takeId = newId('take')
      const takeRelative = `takes/${lineId}/${takeId}.wav`
      const options = resolveTrim(trim, deps.audioSettings?.()?.trim)
      const format = s.session.format
      const flags: string[] = []
      let note: string | null = null

      if (s.punch) {
        // ⑥ 补录：拼接 [被补录 take 的前段] + [本次录音] + [后段]
        const punch = s.punch
        assertSameFormat(punch.format, format, 'record:stop(punch_in)')
        const recorded = slicePayload(payload.payload, format, 0, measured.durationMs)
        await writeWavPayload(root, takeRelative, format, [punch.headPayload, recorded, punch.tailPayload])
        flags.push('punch_in')
        note = `补录自 take ${punch.takeId}（区间 ${punch.srcInMs}~${punch.srcOutMs} ms，pre ${punch.preRollMs} ms / post ${punch.postRollMs} ms）`
      } else if (options.enabled) {
        // ⑦ 静音修剪（docs/05 §5.3）：区间在**会话**上算，写进 take 文件。
        //    全静音时 computeTrimRange 会打 all_silence —— 这里**不抛 TRIM_FAILED**：
        //    用户刚念完的一段不该因为「全是静音」而丢失，保留整段并打标更安全（docs/91 §5.2.20）
        const range = computeTrimRange(mono, { ...options, sampleRate: rate })
        if (range.flags.includes('all_silence')) {
          flags.push('all_silence')
          log?.warn?.('record.trimAllSilence', {
            event: 'record.trimAllSilence',
            sessionId,
            lineId,
            note: '整段都在修剪阈值以下：保留完整录音并给 take 打 all_silence 标，不做修剪',
          })
          await copyAudioFile(root, s.session.filePath, takeRelative)
        } else {
          await writeWavPayload(root, takeRelative, format, [
            slicePayload(payload.payload, format, range.inMs, range.outMs),
          ])
        }
      } else {
        await copyAudioFile(root, s.session.filePath, takeRelative)
      }

      const takePayload = await readWavPayload(root, takeRelative)
      const takeMeasured = measure(decodeMono(takePayload.payload, takePayload.format), rate)
      if (takeMeasured.peakDb !== null && takeMeasured.peakDb >= -0.5) flags.push('clip')
      const partIndex = (await deps.takeRepo().maxPartIndex(lineId)) + 1
      const ts = now()

      const take: Take = {
        id: takeId,
        lineId,
        sessionId,
        filePath: takeRelative,
        partIndex,
        // srcIn/Out 是「在会话文件里的区间」；修剪后 take 文件本身从 0 开始
        srcInMs: 0,
        srcOutMs: measured.durationMs,
        trimmedInMs: 0,
        trimmedOutMs: takeMeasured.durationMs,
        durationMs: takeMeasured.durationMs,
        peakDb: takeMeasured.peakDb,
        rmsDb: takeMeasured.rmsDb,
        lufs: null, // LUFS 需要 ffmpeg 两遍法（docs/05 §8）；未接线时如实为空
        gainDb: 0,
        format,
        source: 'local',
        packageId: null,
        flags,
        isSelected: false,
        note,
        recordedAt: ts,
        createdAt: ts,
      }
      const inserted = await deps.takeRepo().insert(take)

      // ⑧ 自动设为成品（docs/12 §3.2「一次按键 → 一次成品」；重录时覆盖成品，旧 take 保留）
      const segment = await materializeSegment(lineId, inserted)
      await deps.takeRepo().setSelected(lineId, takeId)

      live.delete(sessionId)
      deps.events?.emit('record:status', {
        sessionId,
        state: 'done',
        framesWritten: finalized.frames,
        durationMs: measured.durationMs,
        droppedFrames: s.droppedFrames,
        diskFreeBytes: freeBytes(deps.projectRoot()),
      })

      log?.info?.('record.stopped', {
        event: 'record.stopped',
        sessionId,
        lineId,
        takeId,
        durationMs: measured.durationMs,
        trimmed: options.enabled && !s.punch && !flags.includes('all_silence'),
        partIndex,
        flags,
      })
      session = (await deps.sessionRepo().get(sessionId)) ?? session
      return { session, take: inserted, segment }
    },

    async abort(sessionId, keepFile) {
      const s = live.get(sessionId)
      const stored = s?.session ?? (await deps.sessionRepo().get(sessionId))
      if (!stored) throw new AppError('NOT_FOUND', { details: { entity: 'recording_session', sessionId } })
      if (s) {
        s.writer.close()
        s.state = 'closed'
        try {
          s.port?.close?.()
        } catch {
          /* 忽略 */
        }
        s.port = null
        live.delete(sessionId)
      }
      if (!keepFile) {
        try {
          rmSync(absOf(stored.projectId, stored.filePath), { force: true })
        } catch (e) {
          log?.warn?.('record.abortFileRemoveFailed', {
            event: 'record.abortFileRemoveFailed',
            sessionId,
            path: stored.filePath,
            reason: e instanceof Error ? e.message : String(e),
          })
        }
      }
      await deps.sessionRepo().finalize(sessionId, {
        status: 'aborted',
        durationMs: 0,
        peakDb: null,
        rmsDb: null,
        droppedFrames: s?.droppedFrames ?? stored.droppedFrames,
        finishedAt: now(),
      })
      log?.info?.('record.aborted', { event: 'record.aborted', sessionId, keepFile })
      return { ok: true }
    },

    async punchIn(req) {
      // ① 补录目标：该行当前成品；没有选中则退到最新一条 take
      const takes = await deps.takeRepo().listByLine(req.lineId)
      const target = takes.find((t) => t.isSelected) ?? takes[takes.length - 1] ?? null
      if (!target) {
        throw new AppError('NOT_FOUND', {
          details: {
            entity: 'take',
            lineId: req.lineId,
            hint: '补录需要一个已有 take 作底：这一行还没有录音，请先正常录一遍',
          },
        })
      }
      if (req.srcOutMs <= req.srcInMs) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'record:punchIn', reason: 'empty-range', srcInMs: req.srcInMs, srcOutMs: req.srcOutMs },
        })
      }
      const projectId = await deps.scope.projectIdOfLine(req.lineId)
      const root = projectAudioRoot(deps.projectRoot(), projectId)
      const targetPayload = await readWavPayload(root, target.filePath)
      const head = slicePayload(targetPayload.payload, targetPayload.format, 0, req.srcInMs)
      const tail = slicePayload(targetPayload.payload, targetPayload.format, req.srcOutMs, targetPayload.durationMs)

      const sessionId = newId('sess')
      const relative = `recordings/${sessionId}.wav`
      const session: RecordingSession = {
        id: sessionId,
        projectId,
        chapterId: await deps.lineChapterId(req.lineId),
        mode: 'punch_in',
        actorId: null,
        filePath: relative,
        format: targetPayload.format,
        durationMs: 0,
        peakDb: null,
        rmsDb: null,
        gainDb: 0,
        deviceLabel: null,
        deviceId: null,
        droppedFrames: 0,
        status: 'active',
        marks: [],
        startedAt: now(),
        finishedAt: null,
      }
      const saved = await deps.sessionRepo().insert(session)
      const writer = createSessionWriter({ filePath: absOf(projectId, relative), format: targetPayload.format })
      const state: LiveSession = {
        session: saved,
        writer,
        state: 'ready',
        port: null,
        pending: [],
        pendingFrames: 0,
        droppedFrames: 0,
        punch: {
          takeId: target.id,
          headPayload: head,
          tailPayload: tail,
          format: targetPayload.format,
          srcInMs: req.srcInMs,
          srcOutMs: req.srcOutMs,
          preRollMs: req.preRollMs,
          postRollMs: req.postRollMs,
        },
      }
      live.set(sessionId, state)
      const waiting = pendingPorts.shift()
      if (waiting) bindPort(state, waiting)

      log?.info?.('record.punchInPrepared', {
        event: 'record.punchInPrepared',
        sessionId,
        lineId: req.lineId,
        targetTakeId: target.id,
        srcInMs: req.srcInMs,
        srcOutMs: req.srcOutMs,
        headBytes: head.length,
        tailBytes: tail.length,
      })
      return { sessionId }
    },

    async slice(sessionId, vad) {
      const stored = await deps.sessionRepo().get(sessionId)
      if (!stored) throw new AppError('NOT_FOUND', { details: { entity: 'recording_session', sessionId } })
      const root = projectAudioRoot(deps.projectRoot(), stored.projectId)
      const payload = await readWavPayload(root, stored.filePath)
      const mono = decodeMono(payload.payload, payload.format)
      const rate = payload.format.sampleRate

      // 整段低于门限时 `detectSlices` 抛 VAD_NO_SPEECH_FOUND（docs/05 §4.2 的设计选择：
      // 宁可让用户调参，也不要把噪声当语音切出一堆垃圾）。原样上抛，会话文件保留。
      const ranges = detectSlices(mono, { ...vad, sampleRate: rate })
      const converted: VadSlice[] = ranges.map((r, index) => ({
        id: `${sessionId}:s${index}`,
        sessionId,
        sliceIndex: index,
        startMs: r.startMs,
        endMs: r.endMs,
        rmsDb: Number.isFinite(r.rmsDb) ? clamp100(r.rmsDb) : null,
        peakDb: Number.isFinite(r.peakDb) ? clamp100(r.peakDb) : null,
        matchedLine: null,
        matchScore: null,
        accepted: false,
        flags: [...r.flags],
      }))
      slices.set(sessionId, converted)
      deps.events?.emit('record:sliceProgress', {
        sessionId,
        analyzedMs: stored.durationMs,
        totalMs: stored.durationMs,
      })
      log?.info?.('record.sliced', {
        event: 'record.sliced',
        sessionId,
        count: converted.length,
        speechMs: converted.reduce((sum, x) => sum + (x.endMs - x.startMs), 0),
      })
      return { slices: converted }
    },

    async matchSlices(req) {
      const list = req.slices.length > 0 ? req.slices : (slices.get(req.sessionId) ?? [])
      if (list.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'record:matchSlices',
            reason: 'no-slices',
            sessionId: req.sessionId,
            hint: '先调用 record:slice 得到切片，再匹配',
          },
        })
      }
      const lines = await deps.lineCharCounts(req.chapterId)
      if (lines.length === 0) {
        throw new AppError('NOT_FOUND', {
          details: { entity: 'canvas_line', chapterId: req.chapterId, hint: '该章没有画本行，无法匹配连续录音' },
        })
      }
      const vad = deps.audioSettings?.()?.vad ?? {}
      const charsPerSecond = vad.charsPerSecond ?? 5
      const result = matchSlicesToLines(
        list.map((s) => ({ sliceIndex: s.sliceIndex, startMs: s.startMs, endMs: s.endMs })),
        lines,
        { charsPerSecond },
      )

      // 把匹配写回切片（matchedLine / matchScore），供确认页显示
      const byIndex = new Map(result.matches.map((m) => [m.sliceIndex, m] as const))
      slices.set(
        req.sessionId,
        list.map((s) => {
          const m = byIndex.get(s.sliceIndex)
          return m ? { ...s, matchedLine: m.lineId, matchScore: m.confidence } : { ...s, matchedLine: null, matchScore: null }
        }),
      )

      if (req.useAsr) {
        // 没有 ASR 实现：不伪造识别结果，只把「用的其实是时长对齐」记清楚
        log?.warn?.('record.asrUnavailable', {
          event: 'record.asrUnavailable',
          sessionId: req.sessionId,
          note: 'useAsr=true，但本仓库没有 ASR 实现：返回的是时长对齐结果（docs/91 §5.2.20）',
        })
      }
      log?.info?.('record.matched', {
        event: 'record.matched',
        sessionId: req.sessionId,
        chapterId: req.chapterId,
        matched: result.matches.length,
        unmatchedSlices: result.unmatchedSlices.length,
        unrecordedLines: result.unrecordedLines.length,
        scale: result.scale,
      })
      return {
        matches: result.matches,
        unmatchedSlices: result.unmatchedSlices,
        unrecordedLines: result.unrecordedLines,
      }
    },

    async acceptSlices(sessionId, accepted) {
      const stored = await deps.sessionRepo().get(sessionId)
      if (!stored) throw new AppError('NOT_FOUND', { details: { entity: 'recording_session', sessionId } })
      const list = slices.get(sessionId) ?? []
      const projectId = stored.projectId
      const root = projectAudioRoot(deps.projectRoot(), projectId)
      const src = await readWavPayload(root, stored.filePath)
      const rate = src.format.sampleRate

      let createdTakes = 0
      let createdSegments = 0
      for (const match of accepted) {
        const slice = list.find((s) => s.sliceIndex === match.sliceIndex)
        if (!slice) {
          throw new AppError('INVALID_PAYLOAD', {
            details: {
              op: 'record:acceptSlices',
              reason: 'unknown-slice',
              sliceIndex: match.sliceIndex,
              hint: '切片不在本次会话的结果里：先 record:slice，再按它返回的 sliceIndex 提交',
            },
          })
        }
        // 已有成品 → **跳过**（连续录制的确认是批量补录；覆盖会让用户之前的成品消失）。
        // 要替换成品请用 take 列表的「设为成品」，那是一次明确的单选动作。
        const existing = await deps.segmentRepo().getByLine(match.lineId)
        if (existing) {
          log?.warn?.('record.acceptSlices.skipExisting', {
            event: 'record.acceptSlices.skipExisting',
            sessionId,
            lineId: match.lineId,
            existingSegmentId: existing.id,
          })
          continue
        }
        // 行必须属于同一个项目：否则会把音频写进另一个项目目录（跨项目引用是最难查的错）
        const lineProject = await deps.scope.projectIdOfLine(match.lineId)
        if (lineProject !== projectId) {
          throw new AppError('INVALID_PAYLOAD', {
            details: {
              op: 'record:acceptSlices',
              reason: 'cross-project-line',
              lineId: match.lineId,
              sessionProjectId: projectId,
              lineProjectId: lineProject,
            },
          })
        }

        const takeId = newId('take')
        const relative = `takes/${match.lineId}/${takeId}.wav`
        await writeWavPayload(root, relative, src.format, [
          slicePayload(src.payload, src.format, slice.startMs, slice.endMs),
        ])
        const partPayload = await readWavPayload(root, relative)
        const measured = measure(decodeMono(partPayload.payload, partPayload.format), rate)
        const partIndex = (await deps.takeRepo().maxPartIndex(match.lineId)) + 1
        const ts = now()
        const take: Take = {
          id: takeId,
          lineId: match.lineId,
          sessionId,
          filePath: relative,
          partIndex,
          srcInMs: slice.startMs,
          srcOutMs: slice.endMs,
          trimmedInMs: 0,
          trimmedOutMs: measured.durationMs,
          durationMs: measured.durationMs,
          peakDb: measured.peakDb,
          rmsDb: measured.rmsDb,
          lufs: null,
          gainDb: 0,
          format: src.format,
          source: 'local',
          packageId: null,
          flags: match.confidence < 0.5 ? ['low_confidence'] : [],
          isSelected: false,
          note: `连续录制切片 ${slice.sliceIndex}（置信度 ${match.confidence.toFixed(2)}）`,
          recordedAt: ts,
          createdAt: ts,
        }
        const inserted = await deps.takeRepo().insert(take)
        createdTakes++
        await materializeSegment(match.lineId, inserted)
        await deps.takeRepo().setSelected(match.lineId, takeId)
        createdSegments++
      }

      slices.set(
        sessionId,
        list.map((s) => (accepted.some((a) => a.sliceIndex === s.sliceIndex) ? { ...s, accepted: true } : s)),
      )
      log?.info?.('record.slicesAccepted', {
        event: 'record.slicesAccepted',
        sessionId,
        requested: accepted.length,
        createdTakes,
        createdSegments,
      })
      return { createdTakes, createdSegments }
    },

    async optimizeTrim(takeId, options) {
      const take = await deps.takeRepo().get(takeId)
      if (!take) throw new AppError('NOT_FOUND', { details: { entity: 'take', takeId } })
      const projectId = await deps.scope.projectIdOfTake(takeId)
      const root = projectAudioRoot(deps.projectRoot(), projectId)
      const payload = await readWavPayload(root, take.filePath)
      const mono = decodeMono(payload.payload, payload.format)
      // 区间是**相对 take 文件**的（`trimmed_in/out_ms` 的语义，docs/21 §6）
      const range = computeTrimRange(mono, { ...options, sampleRate: payload.format.sampleRate })
      if (range.flags.includes('all_silence')) {
        log?.warn?.('record.trimOptimizeAllSilence', {
          event: 'record.trimOptimizeAllSilence',
          takeId,
          note: '整段低于阈值：返回完整区间并保留原文件（不做破坏性修剪）',
        })
      }
      // 契约的响应只有两个数字，所以这里**不改文件、只报建议区间**：
      // 真正落地属于处理链（process:*，docs/14），一处操作只改一个东西
      log?.info?.('record.trimOptimized', {
        event: 'record.trimOptimized',
        takeId,
        trimmedInMs: range.inMs,
        trimmedOutMs: range.outMs,
        sourceDurationMs: payload.durationMs,
      })
      return { trimmedInMs: Math.round(range.inMs), trimmedOutMs: Math.round(range.outMs) }
    },

    async onMark(payload) {
      const s = live.get(payload.sessionId)
      if (!s) return
      const next = [...s.session.marks, { kind: payload.kind, atMs: Math.max(0, Math.round(payload.atMs)) }]
      s.session = { ...s.session, marks: next }
      try {
        await deps.sessionRepo().setMarks(payload.sessionId, next)
      } catch (e) {
        // 标记写库失败不该打断录音：内存里已记录，停止时会随会话一起落库
        log?.warn?.('record.markPersistFailed', {
          event: 'record.markPersistFailed',
          sessionId: payload.sessionId,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    },

    async onMeter(payload) {
      const s = live.get(payload.sessionId)
      if (!s) return
      // 电平以渲染侧为准（它才是采集方）。主进程只用序号核对「声称发了多少帧」与
      // 「实际落盘多少帧」的差额 —— 差额就是丢帧，这是 P0 指标唯一的独立证据
      const accounted = s.writer.framesWritten + s.pendingFrames
      const gap = Math.floor(payload.frames) - accounted
      if (gap > 0) {
        s.droppedFrames += gap
        log?.warn?.('record.frameGap', {
          event: 'record.frameGap',
          sessionId: payload.sessionId,
          claimed: payload.frames,
          written: s.writer.framesWritten,
          pending: s.pendingFrames,
          gap,
        })
      }
    },

    closeAll(reason) {
      for (const [sessionId, s] of live) {
        try {
          // 不 finalize：进程要退出了，把文件留成「头部未回填」的状态，
          // 由下次启动的 recovery 按文件大小修复（docs/05 §9）
          s.writer.close()
          s.port?.close?.()
        } catch (e) {
          log?.warn?.('record.closeFailed', {
            event: 'record.closeFailed',
            sessionId,
            reason: e instanceof Error ? e.message : String(e),
          })
        }
        live.delete(sessionId)
      }
      pendingPorts.length = 0
      log?.info?.('record.closedAll', { event: 'record.closedAll', reason })
    },
  }
}

// ---------------------------------------------------------------------------
// 纯工具
// ---------------------------------------------------------------------------

/** 采集到的交错 PCM → 单声道 Float32（分析/测量用；不写回文件） */
export function decodeMono(payload: Buffer, format: AudioFormat): Float32Array {
  const interleaved = decodeInterleaved(payload, format)
  if (format.channels <= 1) return interleaved
  const frames = Math.floor(interleaved.length / format.channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < format.channels; c++) sum += interleaved[i * format.channels + c] ?? 0
    out[i] = sum / format.channels
  }
  return out
}

function decodeInterleaved(payload: Buffer, format: AudioFormat): Float32Array {
  switch (format.bitDepth) {
    case 16:
      return int16LEToFloat32(payload)
    case 24:
      return int24LEToFloat32(payload)
    case 32:
      return float32LEToFloat32(payload)
    default:
      throw new AppError('INVALID_PAYLOAD', {
        details: { op: 'record:decode', reason: 'unsupported-bit-depth', bitDepth: format.bitDepth },
      })
  }
}

export function measure(
  samples: Float32Array,
  sampleRate: number,
): { durationMs: number; peakDb: number | null; rmsDb: number | null } {
  if (samples.length === 0) return { durationMs: 0, peakDb: null, rmsDb: null }
  return {
    durationMs: sampleRate > 0 ? Math.round((samples.length / sampleRate) * 1000) : 0,
    peakDb: computePeakDb(samples),
    rmsDb: clamp100(computeRmsDb(samples)),
  }
}

function clamp100(db: number): number {
  if (!Number.isFinite(db)) return -100
  return db < -100 ? -100 : db
}

function defaultFreeBytes(dir: string): number {
  try {
    const st = statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    // 拿不到就返回 -1（调用方据此给「无法预检」的告警），绝不假装空间充足
    return -1
  }
}

function resolveTrim(trim: TrimOptions | undefined, fallback: Partial<TrimOptions> | undefined): TrimOptions {
  const base = defaultTrimOptions()
  return {
    enabled: trim?.enabled ?? fallback?.enabled ?? base.enabled,
    thresholdDb: trim?.thresholdDb ?? fallback?.thresholdDb ?? base.thresholdDb,
    headPaddingMs: trim?.headPaddingMs ?? fallback?.headPaddingMs ?? base.headPaddingMs,
    tailPaddingMs: trim?.tailPaddingMs ?? fallback?.tailPaddingMs ?? base.tailPaddingMs,
  }
}

function assertSameFormat(a: AudioFormat, b: AudioFormat, op: string): void {
  if (a.sampleRate !== b.sampleRate || a.bitDepth !== b.bitDepth || a.channels !== b.channels) {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        op,
        reason: 'format-mismatch',
        existing: a,
        session: b,
        hint: '补录会话的格式必须与被补录的 take 一致；不一致请先统一录音设置（不做隐式重采样）',
      },
    })
  }
}
