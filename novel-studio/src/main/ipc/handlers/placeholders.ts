/**
 * IPC handler · 未实现通道的显式占位
 * ============================================================================
 * 设计依据：docs/20 §10「契约完整性」、docs/01 §13.2「第二级兜底：边界包裹」
 *
 * ### 为什么要给未实现的通道注册占位，而不是「不注册」
 *   1. **契约完整性可自检**：`assertContractParity()` 要求「契约里有的通道全部有 handler」。
 *      不注册会让自检永远红，于是自检形同虚设。
 *   2. **不写假实现**：占位 handler **抛 `NOT_IMPLEMENTED`**，并带上
 *      `params.feature = 通道名`，UI 能明确显示「该功能将在后续版本提供」。
 *      绝不返回 `[]` / `{}` —— 那会让 UI 显示「0 本书」「导出成功」这种真假难辨的状态。
 *   3. **参数仍被校验**：占位 handler 用的也是契约 schema，所以「参数写错」与
 *      「功能没实现」这两种失败能被区分开（前者 INVALID_PAYLOAD，后者 NOT_IMPLEMENTED）。
 *
 * 领域层实现落位后，只要把对应通道从本文件覆盖掉即可（`handlers/index.ts` 的
 * `ALL_HANDLERS` 里出现过的通道不会生成占位）。
 */

import { AppError } from '../../../shared/errors.ts'
import { IPC_CHANNELS } from '../../../shared/ipc.ts'
import type { IpcChannel } from '../../../shared/ipc.ts'
import type { RegisteredHandler, SchemaLike } from './deps.ts'

/** 只允许传入契约里真实存在的通道（防止拿裸字符串生成占位） */
function toIpcChannels(list: readonly string[]): readonly IpcChannel[] {
  return list as readonly IpcChannel[]
}
import { IPC_REQ_SCHEMAS } from '../schemas.ts'

/** 该通道的契约 schema（每个通道都有，见 tests/main/ipc-contract.test.ts） */
function schemaForChannel(channel: string): SchemaLike<unknown> {
  const schema = (IPC_REQ_SCHEMAS as Record<string, SchemaLike<unknown>>)[channel]
  if (!schema) {
    // 契约新增通道但忘了补 schema：这里直接炸，而不是悄悄放行任意载荷
    throw new AppError('INTERNAL', {
      details: {
        kind: 'IPC_SCHEMA_MISSING',
        channel,
        hint: '请在 src/main/ipc/schemas.ts 的 IPC_REQ_SCHEMAS 中补上该通道的 req schema',
      },
    })
  }
  return schema
}

/**
 * 为「尚未实现」的通道生成占位 handler。
 *
 * @param implemented 已经有真实实现的通道（来自 ALL_HANDLERS）
 * @param opts.only    只生成这些通道的占位（默认：契约里除去 implemented 的全部）
 */
export function createPlaceholderHandlers(
  implemented: readonly string[],
  opts?: { only?: readonly string[] },
): RegisteredHandler[] {
  const done = new Set(implemented)
  // `opts.only` 的接口类型是 `readonly string[]`（调用方可能传任意字符串），
  // 这里收敛成 IpcChannel，令下面的 `channel` 能装进 RegisteredHandler。
  const targets: readonly IpcChannel[] =
    opts?.only !== undefined ? toIpcChannels(opts.only) : IPC_CHANNELS.filter((c) => !done.has(c))
  return targets.map((channel) => ({
    channel,
    schema: schemaForChannel(channel),
    // 「功能尚未提供」不是错误（docs/20 §5.2.1：severity: 'info'），
    // 但必须是**明确的**未实现，而不是空数据
    fallbackKey: 'NOT_IMPLEMENTED',
    run: (): never => {
      throw new AppError('NOT_IMPLEMENTED', {
        params: { feature: channel },
        details: {
          channel,
          reason: 'handler-not-implemented',
          hint: '该通道已在契约中登记但领域层尚未实现；实现后从占位列表移除',
        },
      })
    },
  }))
}

/** 契约里所有通道（供自检与统计） */
export function allContractChannels(): string[] {
  return [...IPC_CHANNELS]
}
