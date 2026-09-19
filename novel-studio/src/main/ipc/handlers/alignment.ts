/**
 * Novel Studio · IPC handler · 对轨域（`alignment:*` 19 个通道）
 * ============================================================================
 * 设计依据：docs/20 §4.6、docs/13 §3–§7
 *
 * 与其它域同一套纪律：
 *   1. **载荷校验在注册层**（`IPC_REQ_SCHEMAS`）；跨字段约束（两条 item 必须同方案、
 *      跨章绑定必须拒绝）在服务层挡。
 *   2. **逻辑在服务层**：本文件只做 req → 服务调用的翻译。
 *   3. `alignment:issueKindLabels` 是**纯常量查询**，不查库 —— 它是渲染侧的文案来源，
 *      在库打不开时也应该能回答（否则校验面板连标签都显示不出来）。
 */

import type { AlignmentService } from '../../features/audio/alignment.service.ts'
import { h, voidSchema, type RegisteredHandler } from './deps.ts'

export interface AlignmentHandlerDeps {
  alignment: AlignmentService
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createAlignmentHandlers(deps: AlignmentHandlerDeps): RegisteredHandler[] {
  return [
    h('alignment:listArrangements', async (req) => deps.alignment.listArrangements(req.chapterId)),

    h('alignment:create', async (req) => deps.alignment.create(req.chapterId, req.name, req.strategy)),

    h('alignment:duplicate', async (req) => deps.alignment.duplicate(req.arrangementId, req.name)),

    h('alignment:delete', async (req) => deps.alignment.remove(req.arrangementId)),

    h('alignment:setDefault', async (req) => deps.alignment.setDefault(req.arrangementId)),

    h('alignment:get', async (req) => deps.alignment.get(req.arrangementId)),

    h('alignment:autoArrange', async (req) => {
      return deps.alignment.autoArrange(
        req.arrangementId,
        req.strategy,
        req.preserveLocked,
        req.defaultPauseMs,
      )
    }),

    h('alignment:updateItem', async (req) => deps.alignment.updateItem(req.itemId, req.patch)),

    h('alignment:batchUpdateItems', async (req) => deps.alignment.batchUpdateItems(req.updates)),

    h('alignment:validate', async (req) => deps.alignment.validate(req.arrangementId)),

    h('alignment:resolveOverlap', async (req) => {
      return deps.alignment.resolveOverlap(req.arrangementId, req.itemIdA, req.itemIdB, req.strategy)
    }),

    h('alignment:resetTrack', async (req) => deps.alignment.resetTrack(req.arrangementId, req.trackId)),

    h('alignment:resetAll', async (req) => deps.alignment.resetAll(req.arrangementId)),

    h('alignment:autoMatchSegments', async (req) => {
      return deps.alignment.autoMatchSegments(req.chapterId, req.useAsr === true)
    }),

    h('alignment:bindSegment', async (req) => {
      return deps.alignment.bindSegment(req.lineId, req.segmentId, req.srcInMs, req.srcOutMs)
    }),

    h('alignment:unbindSegment', async (req) => deps.alignment.unbindSegment(req.lineId)),

    h('alignment:issueKindLabels', voidSchema, async () => deps.alignment.issueKindLabels()),

    h('alignment:previewRender', async (req) => {
      return deps.alignment.previewRender(req.arrangementId, req.mixProjectId, req.startMs, req.durationMs)
    }),

    // `alignment:forcedAlign` 需要「强制对齐」引擎（ASR 时间戳或 HMM 对齐），
    // 本仓库没有实现也没有可注入的 provider —— 由服务层抛 `AI_FORCED_ALIGN_UNAVAILABLE`
    // 说明「能力不可用」。见 alignment.service.ts 文件头的说明。
    h('alignment:forcedAlign', async (req) => deps.alignment.forcedAlign(req.lineId, req.segmentId)),
  ]
}

/** 本域实现的通道（与上面的数组一一对应） */
export const ALIGNMENT_CHANNELS: readonly string[] = [
  'alignment:listArrangements',
  'alignment:create',
  'alignment:duplicate',
  'alignment:delete',
  'alignment:setDefault',
  'alignment:get',
  'alignment:autoArrange',
  'alignment:updateItem',
  'alignment:batchUpdateItems',
  'alignment:validate',
  'alignment:resolveOverlap',
  'alignment:resetTrack',
  'alignment:resetAll',
  'alignment:autoMatchSegments',
  'alignment:bindSegment',
  'alignment:unbindSegment',
  'alignment:issueKindLabels',
  'alignment:previewRender',
  'alignment:forcedAlign',
]
