/**
 * Novel Studio · IPC handler · 项目包 / 任务包域（`package:*` 7 个通道）
 * ============================================================================
 * 设计依据：docs/20 §4（通道契约）、docs/03 §8 §9（.nsp / .nst）、docs/11 §6.2–§6.5
 *
 * ### 本层只做「转发」，一行业务判断都不写
 *   与其它域同一条纪律：
 *   · **载荷形状**由注册层的 `IPC_REQ_SCHEMAS`（`src/main/ipc/schemas.ts` 的 `package:*` 条目）
 *     挡住 —— 类型不对在进 handler 之前就返回 `INVALID_PAYLOAD`；
 *   · **跨字段校验**（项目/书籍/配音员是否存在、选项是否合法）在 `package.service.ts`，
 *     那里能抛带 `details` 的 `AppError`，UI 才有可行动的中文提示；
 *   · 真正的执行由任务队列的 `package.export` / `package.import` / `package.merge` 承担。
 *   把判断散到这里，会让「同一件事在 handler 与服务里各判一次、条件还不同」。
 *
 * ### 为什么 handler 里不 try/catch
 *   注册表（`ipc/registry.ts`）已经把抛出的异常包成 `{ ok: false, error }`，
 *   并在日志里留痕（docs/22 §5）。在这里吞掉异常再返回一个自造的失败结构，
 *   会让 `error.code` 与文案体系脱钩 —— 用户看到的是「操作失败」而不是「这个包来自更新版本的应用」。
 *
 * ### 返回值的两个约定
 *   · 4 个长任务通道只返回 `{ taskId }`：进度由 `task:progress` 推（docs/04 §2.4 禁止自建进度 UI）；
 *   · `package:inspect` 是**同步**动作（只读 manifest），返回摘要给 UI 直接显示。
 */

import type { PackageService } from '../../features/book/package/package.service.ts'
import { h, type RegisteredHandler } from './deps.ts'

export interface PackageHandlerDeps {
  pkg: PackageService
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createPackageHandlers(deps: PackageHandlerDeps): RegisteredHandler[] {
  return [
    h('package:exportProject', async (req) => deps.pkg.exportProject(req.projectId, req.options)),

    h('package:importProject', async (req) => deps.pkg.importProject(req.path, req.options)),

    h('package:exportTask', async (req) => deps.pkg.exportTask(req.bookId, req.actorId, req.options)),

    h('package:mergeTask', async (req) => deps.pkg.mergeTask(req.projectId, req.path)),

    h('package:inspect', async (req) => deps.pkg.inspect(req.path)),

    h('package:listHistory', async (req) => deps.pkg.listHistory(req.projectId)),

    h('package:lastMergeReport', async (req) => deps.pkg.lastMergeReport(req.projectId)),
  ]
}

/**
 * 本域**已实现**的通道（与上面的数组一一对应）。
 *
 * ⚠ 与 `EXPORT_CHANNELS` 的差别：导出域仍有 3 个通道是占位（需要完整混音管线），
 * 因此那里的常量只列已实现的子集；本域 7 个通道**都是真实实现**，所以就是全集。
 * 装配测试（`tests/main/ports-wiring.test.ts`）用它断言「这 7 个不再是占位」，
 * 若将来某个通道退回占位，必须把它从这里的数组里删掉（让测试变红是提醒，不是故障）。
 */
export const PACKAGE_CHANNELS: readonly string[] = [
  'package:exportProject',
  'package:importProject',
  'package:exportTask',
  'package:mergeTask',
  'package:inspect',
  'package:listHistory',
  'package:lastMergeReport',
]
