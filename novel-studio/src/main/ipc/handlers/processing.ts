/**
 * Novel Studio · IPC handler · 处理域与预设域（`process:*` 5 + `preset:*` 6）
 * ============================================================================
 * 设计依据：docs/20 §4.7、docs/14 §4/§7/§10
 *
 * 与其它域同一套纪律：
 *   1. **载荷校验在注册层**（`IPC_REQ_SCHEMAS` 的 `ProcessChainShape` 已经把每个参数
 *      的范围钉住）；跨字段的约束（`presetId` 与 `chain` 二选一、`ids` 不能为空）在服务层挡。
 *   2. **逻辑在服务层**；本文件只做「req → 服务调用」的翻译，不写业务。
 *   3. **契约里的 `preset:create` 载荷是 `Omit<ProcessPreset,'id'|'createdAt'|'updatedAt'|'builtin'>`**
 *      —— `builtin` 由服务端决定（永远是 false），渲染侧就算传了也会被丢弃。
 */

import type { PresetService } from '../../features/audio/preset.service.ts'
import type { ProcessService } from '../../features/audio/process.service.ts'
import { h, type RegisteredHandler } from './deps.ts'

export interface ProcessingHandlerDeps {
  process: ProcessService
  preset: PresetService
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createProcessingHandlers(deps: ProcessingHandlerDeps): RegisteredHandler[] {
  return [
    // ── 处理 ───────────────────────────────────────────────────────────────
    h('process:preview', async (req) => {
      return deps.process.preview(req.segmentId, req.chain, req.durationMs)
    }),

    h('process:apply', async (req) => {
      // `presetId` 与 `chain` 都是可选的，但不能都不给 —— 由服务层抛 INVALID_PAYLOAD
      return deps.process.apply(req.segmentId, req.presetId ?? null, req.chain ?? null)
    }),

    h('process:batchApply', async (req) => {
      return deps.process.batchApply(req.scope, req.ids, req.presetId ?? null, req.chain ?? null)
    }),

    h('process:listApplied', async (req) => deps.process.listApplied(req.segmentIds)),

    h('process:revert', async (req) => deps.process.revert(req.segmentId)),

    // ── 预设 ───────────────────────────────────────────────────────────────
    h('preset:list', async (req) => deps.preset.list(req.projectId ?? null)),

    h('preset:create', async (req) => {
      // `builtin` 恒为 false（内置预设是代码里的常量，不是库里的行，见 preset.repo.ts）：
      // 契约的载荷里本来就没有这个字段，渲染侧也传不了
      return deps.preset.create(req.preset)
    }),

    h('preset:update', async (req) => deps.preset.update(req.id, req.patch)),

    h('preset:delete', async (req) => deps.preset.remove(req.id)),

    h('preset:import', async (req) => deps.preset.importFrom(req.path)),

    h('preset:export', async (req) => deps.preset.exportTo(req.ids, req.path)),
  ]
}

/** 本域实现的通道（与上面的数组一一对应） */
export const PROCESS_CHANNELS: readonly string[] = [
  'process:preview',
  'process:apply',
  'process:batchApply',
  'process:listApplied',
  'process:revert',
]

export const PRESET_CHANNELS: readonly string[] = [
  'preset:list',
  'preset:create',
  'preset:update',
  'preset:delete',
  'preset:import',
  'preset:export',
]

export const PROCESSING_CHANNELS: readonly string[] = [...PROCESS_CHANNELS, ...PRESET_CHANNELS]
