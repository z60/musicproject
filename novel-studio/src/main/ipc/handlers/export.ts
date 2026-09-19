/**
 * Novel Studio · IPC handler · 导出域（`export:*` 8 个通道）
 * ============================================================================
 * 设计依据：docs/20 §4.8、docs/15 §4/§6
 *
 * **实现状态（如实标注）**：本文件注册的 5 个通道（preCheck / report / verify /
 * openFolder / vbrPresets）是真实实现；`export:chapter` / `export:book` / `export:m4b`
 * **仍是占位**（它们需要完整的混音渲染管线，见 `export.service.ts` 的说明），
 * 因此**不在** `EXPORT_CHANNELS` 里 —— 占位清单会如实列出它们。
 */

import type { ExportService } from '../../features/audio/export.service.ts'
import type { ExportTasks } from '../../features/audio/export.tasks.ts'
import { h, voidSchema, type RegisteredHandler } from './deps.ts'

export interface ExportHandlerDeps {
  export: ExportService
  tasks: ExportTasks
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createExportHandlers(deps: ExportHandlerDeps): RegisteredHandler[] {
  return [
    h('export:chapter', async (req) => deps.tasks.enqueueChapter(req.chapterIds, req.mixProjectId, req.params)),

    h('export:book', async (req) => deps.tasks.enqueueBook(req.bookId, req.mixProjectId, req.params, req.makeM4b)),

    h('export:m4b', async (req) => deps.tasks.enqueueM4b(req.bookId, req.chapterIds, req.params)),

    h('export:preCheck', async (req) => {
      return deps.export.preCheck({
        bookId: req.bookId,
        ...(req.chapterIds ? { chapterIds: req.chapterIds } : {}),
        mixProjectId: req.mixProjectId,
        params: req.params,
      })
    }),

    h('export:report', async (req) => deps.export.report(req.jobId)),

    h('export:verify', async (req) => deps.export.verify(req.jobId)),

    h('export:openFolder', async (req) => deps.export.openFolder(req.jobId)),

    h('export:vbrPresets', voidSchema, async () => deps.export.vbrPresets()),
  ]
}

/**
 * 本域**已实现**的通道（与上面的数组一一对应）。
 *
 * `export:chapter` / `export:book` / `export:m4b` 不在其中：它们是渲染任务，
 * 本轮只做了预检、报告、验收与定位（见文件头说明）。
 */
export const EXPORT_CHANNELS: readonly string[] = [
  'export:chapter',
  'export:book',
  'export:m4b',
  'export:preCheck',
  'export:report',
  'export:verify',
  'export:openFolder',
  'export:vbrPresets',
]
