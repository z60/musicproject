/**
 * Novel Studio · IPC handler · 音频域（`analysis:*` / `device:*` / `take:*` / `record:*`）
 * ============================================================================
 * 设计依据：docs/20 §4.5、docs/05 §8/§11、docs/12 §11
 *
 * 与其它域同一套纪律：
 *   1. **载荷校验在注册层**（`IPC_REQ_SCHEMAS`）；跨字段的业务边界在服务层挡。
 *   2. **逻辑在服务层**（`*.service.ts`；纯算法在 `src/shared/audio/`）。
 *   3. **按当前 db / 项目根现取**（库与项目根都可能在「从备份恢复」后换掉）。
 *
 * ⚠️ `analysis:metrics` / `analysis:peaks` 的定位参数 `path` 与 `segmentId` **都是可选的**，
 *   但**不能都不给** —— 那属于「schema 表达不了的跨字段约束」，由服务层抛 `INVALID_PAYLOAD`
 *   （猜一个文件比报错更糟：会把别的行的电平显示给用户）。
 *
 * ⚠️ `record:attachPort` 只声明「端口归哪个会话」；MessagePort 的接管在
 *   `src/main/index.ts` 的 `record:port` 监听里（端口是 transferable，不能走 invoke 返回值）。
 */

import type { AnalysisService } from '../../features/audio/analysis.service.ts'
import type { DeviceService } from '../../features/audio/device.service.ts'
import type { RecordService } from '../../features/audio/record.service.ts'
import type { TakeService } from '../../features/audio/take.service.ts'
import { h, voidSchema, type RegisteredHandler } from './deps.ts'

export interface AudioHandlerDeps {
  analysis: AnalysisService
  device: DeviceService
  take: TakeService
  record: RecordService
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createAudioHandlers(deps: AudioHandlerDeps): RegisteredHandler[] {
  return [
    // ── 分析 ───────────────────────────────────────────────────────────────
    h('analysis:metrics', async (req) => {
      return deps.analysis.metrics({
        ...(req.path !== undefined && req.path !== null ? { path: req.path } : {}),
        ...(req.segmentId !== undefined && req.segmentId !== null ? { segmentId: req.segmentId } : {}),
      })
    }),

    h('analysis:peaks', async (req) => {
      return deps.analysis.peaks({
        ...(req.path !== undefined && req.path !== null ? { path: req.path } : {}),
        ...(req.segmentId !== undefined && req.segmentId !== null ? { segmentId: req.segmentId } : {}),
        peaksPerSec: req.peaksPerSec,
        ...(req.fromMs !== undefined ? { fromMs: req.fromMs } : {}),
        ...(req.toMs !== undefined ? { toMs: req.toMs } : {}),
      })
    }),

    h('analysis:noiseProfile', async (req) => {
      return deps.analysis.noiseProfile(req.segmentId, req.startMs, req.endMs)
    }),

    // ── 设备 ───────────────────────────────────────────────────────────────
    h('device:list', voidSchema, () => deps.device.list()),

    h('device:savePreference', async (req) => {
      return deps.device.savePreference(req.deviceId, req.label)
    }),

    h('device:selfTestResult', async (req) => {
      return deps.device.saveSelfTest(req.result)
    }),

    // ── Take ───────────────────────────────────────────────────────────────
    h('take:listByLine', async (req) => deps.take.listByLine(req.lineId)),

    h('take:listByChapter', async (req) => deps.take.listByChapter(req.chapterId)),

    h('take:setSelected', async (req) => {
      return deps.take.setSelected(req.lineId, req.takeId)
    }),

    h('take:delete', async (req) => {
      // 默认软删（文件保留）；`hard: true` 才删文件 —— 见 TakeList 的两个按钮文案
      return deps.take.remove(req.takeId, req.hard === true)
    }),

    h('take:flag', async (req) => deps.take.flag(req.takeId, req.flags)),

    h('take:combineParts', async (req) => {
      return deps.take.combineParts(req.lineId, req.takeIds)
    }),

    // ── 录音 ───────────────────────────────────────────────────────────────
    h('record:prepare', async (req) => {
      return deps.record.prepare({
        projectId: req.projectId,
        chapterId: req.chapterId,
        mode: req.mode,
        format: req.format,
        deviceId: req.deviceId ?? null,
        actorId: req.actorId ?? null,
      })
    }),

    // MessagePort 的**接管**发生在 `record:port`（`src/main/index.ts`），
    // 这里只是渲染侧声明「端口归这个会话」；没有端口时服务层会明确报错
    h('record:attachPort', async (req) => deps.record.attachPort(req.sessionId)),

    h('record:start', async (req) => deps.record.start(req.sessionId)),

    h('record:pause', async (req) => deps.record.pause(req.sessionId)),

    h('record:resume', async (req) => deps.record.resume(req.sessionId)),

    h('record:stop', async (req) => {
      // `lineId` 缺省时是**连续录制**：只定稿会话，take 由切片确认产生（docs/12 §4.3）
      return deps.record.stop(req.sessionId, req.lineId ?? null, req.trim)
    }),

    h('record:abort', async (req) => deps.record.abort(req.sessionId, req.keepFile === true)),

    h('record:punchIn', async (req) => {
      return deps.record.punchIn({
        lineId: req.lineId,
        srcInMs: req.srcInMs,
        srcOutMs: req.srcOutMs,
        preRollMs: req.preRollMs,
        postRollMs: req.postRollMs,
      })
    }),

    h('record:slice', async (req) => deps.record.slice(req.sessionId, req.vad)),

    h('record:matchSlices', async (req) => {
      return deps.record.matchSlices({
        sessionId: req.sessionId,
        chapterId: req.chapterId,
        slices: req.slices,
        useAsr: req.useAsr === true,
      })
    }),

    h('record:acceptSlices', async (req) => deps.record.acceptSlices(req.sessionId, req.accepted)),

    h('record:optimizeTrim', async (req) => deps.record.optimizeTrim(req.takeId, req.options)),
  ]
}

/** 本域当前实现的通道（与上面的数组一一对应） */
export const ANALYSIS_CHANNELS: readonly string[] = [
  'analysis:metrics',
  'analysis:peaks',
  'analysis:noiseProfile',
]

export const DEVICE_CHANNELS: readonly string[] = ['device:list', 'device:savePreference', 'device:selfTestResult']

export const TAKE_CHANNELS: readonly string[] = [
  'take:listByLine',
  'take:listByChapter',
  'take:setSelected',
  'take:delete',
  'take:flag',
  'take:combineParts',
]

export const RECORD_CHANNELS: readonly string[] = [
  'record:prepare',
  'record:attachPort',
  'record:start',
  'record:pause',
  'record:resume',
  'record:stop',
  'record:abort',
  'record:punchIn',
  'record:slice',
  'record:matchSlices',
  'record:acceptSlices',
  'record:optimizeTrim',
]

export const AUDIO_CHANNELS: readonly string[] = [
  ...ANALYSIS_CHANNELS,
  ...DEVICE_CHANNELS,
  ...TAKE_CHANNELS,
  ...RECORD_CHANNELS,
]
