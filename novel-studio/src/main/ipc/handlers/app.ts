/**
 * 应用与系统域 handler（10 个通道）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §4.1
 *
 * 本层只做「编排 + 校验 + 兜底」，真正的能力由 deps.env / deps.diagnostics 提供
 * （见 deps.ts）。这样 handler 能在没有 Electron 的环境里被单测。
 *
 * 类型说明：用 `h('通道名', ...)` 工厂构造。编译器会**从契约推断** req/res 类型，
 * 因此 `req.url` / `req.path` 这类字段访问有确切类型（不必手写泛型，也不会退化成 unknown）。
 */

import { IPC_CHANNELS } from '../../../shared/ipc.ts'
import { h, voidSchema } from './deps.ts'

/** 只允许 http/https，其余一律拒绝（docs/02 §3 全局硬化） */
function assertSafeExternalUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`不是合法的地址：${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只允许打开 http/https 链接，收到的是 ${parsed.protocol}`)
  }
  return parsed.toString()
}

export const appHandlers = [
  h('app:getInfo', voidSchema, (_req, deps) => deps.env.getInfo()),

  h('app:getPaths', voidSchema, (_req, deps) => deps.env.getPaths()),

  h('app:getCapabilities', voidSchema, (_req, deps) => deps.capabilities.getCapabilities()),

  h(
    'app:openExternal',
    async (req, deps) => {
      const safe = assertSafeExternalUrl(req.url)
      await deps.env.openExternal(safe)
      return { ok: true }
    },
    { fallbackKey: 'INTERNAL' },
  ),

  h('app:showItemInFolder', (req, deps) => {
    deps.env.showItemInFolder(req.path)
    return { ok: true }
  }),

  h('app:openFolderDialog', async (req, deps) => {
    const path = await deps.env.pickFolder({
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.defaultPath !== undefined ? { defaultPath: req.defaultPath } : {}),
    })
    return { path }
  }),

  h('app:openFileDialog', async (req, deps) => {
    const paths = await deps.env.pickFiles({
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.filters !== undefined ? { filters: req.filters } : {}),
      ...(req.multi !== undefined ? { multi: req.multi } : {}),
    })
    return { paths }
  }),

  h('app:saveFileDialog', async (req, deps) => {
    const path = await deps.env.pickSavePath({
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.defaultPath !== undefined ? { defaultPath: req.defaultPath } : {}),
      ...(req.filters !== undefined ? { filters: req.filters } : {}),
    })
    return { path }
  }),

  h(
    'app:diagnostics',
    voidSchema,
    async (_req, deps) => {
      const result = await deps.diagnostics.export()
      deps.log.info('ipc.app.diagnostics.exported', { reportPath: result.reportPath })
      return result
    },
    { fallbackKey: 'APP_DIAGNOSTICS_EXPORTED' },
  ),

  h('app:quit', (req, deps) => {
    // force=false 时由 bootstrap 侧拦截未完成操作（录音中、任务进行中，见 docs/01 §11）
    deps.env.quit(req.force === true)
    return { ok: true }
  }),
]

/**
 * 自检：本模块登记的通道都必须存在于契约中，且不能重复。
 * 由 handlers/index.ts 的注册流程调用。
 */
export function assertAppHandlersSane(): void {
  const seen = new Set<string>()
  for (const spec of appHandlers) {
    if (!IPC_CHANNELS.includes(spec.channel)) {
      throw new Error(`[ipc] app handler 登记了契约中不存在的通道：${spec.channel}`)
    }
    if (seen.has(spec.channel)) {
      throw new Error(`[ipc] app handler 重复登记通道：${spec.channel}`)
    }
    seen.add(spec.channel)
  }
}
