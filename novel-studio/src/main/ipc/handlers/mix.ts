/**
 * Novel Studio · IPC handler · 混音域（`mix:*` 7 个通道）
 * ============================================================================
 * 设计依据：docs/20 §4.8、docs/15 §2/§5.1
 *
 * 纪律与其它域一致：载荷校验在注册层（`IPC_REQ_SCHEMAS` 的 `MixProjectShape` 已经把
 * 每个数值范围钉住），跨字段的业务校验（对轨方案必须同章、素材/预设必须存在）在服务层。
 *
 * ⚠️ `mix:save` 收的是**整份方案**（渲染侧防抖 500ms 后整份提交），因此这里的 handler
 *   不做任何字段拼装 —— 拼装会让「界面显示的」与「存下去的」产生差异。
 */

import type { MixService } from '../../features/audio/mix.service.ts'
import { h, type RegisteredHandler } from './deps.ts'

export interface MixHandlerDeps {
  mix: MixService
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createMixHandlers(deps: MixHandlerDeps): RegisteredHandler[] {
  return [
    h('mix:listProjects', async (req) => deps.mix.listProjects(req.chapterId)),

    h('mix:get', async (req) => deps.mix.get(req.mixProjectId)),

    h('mix:save', async (req) => deps.mix.save(req.mixProject)),

    h('mix:create', async (req) => deps.mix.create(req.chapterId, req.arrangementId, req.name)),

    h('mix:duplicate', async (req) => deps.mix.duplicate(req.mixProjectId, req.name)),

    h('mix:delete', async (req) => deps.mix.remove(req.mixProjectId)),

    h('mix:measureLoudness', async (req) => {
      return deps.mix.measureLoudness(
        {
          ...(req.path !== undefined && req.path !== null ? { path: req.path } : {}),
          ...(req.segmentId !== undefined && req.segmentId !== null ? { segmentId: req.segmentId } : {}),
        },
        req.targetLufs,
      )
    }),
  ]
}

/** 本域实现的通道（与上面的数组一一对应） */
export const MIX_CHANNELS: readonly string[] = [
  'mix:listProjects',
  'mix:get',
  'mix:save',
  'mix:create',
  'mix:duplicate',
  'mix:delete',
  'mix:measureLoudness',
]
