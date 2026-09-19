/**
 * Novel Studio · IPC handler · 素材域（`music:*` 4 个通道）
 * ============================================================================
 * 设计依据：docs/20 §4.7、docs/14 §8
 *
 * 纪律与其它域一致：载荷校验在注册层（`IPC_REQ_SCHEMAS`），逻辑在服务层。
 *
 * ⚠️ 契约里**没有** `music:update` 通道 —— 素材的「重命名 / 标签 / 备注 / 授权说明」
 *   目前只能在渲染侧会话内编辑（见 `MusicLibraryPanel.vue` 的说明）。这里不偷偷加一个
 *   写库入口，那样会让「改了但刷新就没了」变成更难查的问题。
 */

import type { MusicService } from '../../features/audio/music.service.ts'
import { h, type RegisteredHandler } from './deps.ts'

export interface MusicHandlerDeps {
  music: MusicService
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createMusicHandlers(deps: MusicHandlerDeps): RegisteredHandler[] {
  return [
    h('music:import', async (req) => deps.music.importFiles(req.projectId, req.files, req.kind)),

    h('music:list', async (req) => deps.music.list(req.projectId, req.kind)),

    h('music:probe', async (req) => deps.music.probe(req.assetId)),

    h('music:delete', async (req) => deps.music.remove(req.assetId)),
  ]
}

/** 本域实现的通道（与上面的数组一一对应） */
export const MUSIC_CHANNELS: readonly string[] = [
  'music:import',
  'music:list',
  'music:probe',
  'music:delete',
]
