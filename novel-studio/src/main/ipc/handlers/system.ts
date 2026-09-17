/**
 * 设置 / 任务 / 数据库 / 日志 / 能力 五个域的 handler
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §4.10
 *
 * 这些域的共同特点：都是「系统能力」，不含作品业务逻辑，
 * 因此可以直接对着 deps 里的 port 实现，无需等待业务服务就绪。
 *
 * 类型说明：一律用 `h('通道名', ...)` 工厂构造，编译器**从契约推断** req/res 类型。
 * 直接写对象字面量会让 `req` 退化成 `unknown`（TS18046）。
 */

import { AppError } from '../../../shared/errors.ts'
import { IPC_CHANNELS } from '../../../shared/ipc.ts'
import { h, voidSchema } from './deps.ts'

// ============================================================================
// settings（5 个通道）
// ============================================================================

export const settingsHandlers = [
  h('settings:get', (req, deps) => deps.settings.get(req?.keys)),

  h(
    'settings:set',
    (req, deps) => {
      const result = deps.settings.set(req.patch)
      // 变更必须广播，否则各 store 不知道要响应（docs/04 §8.3）
      deps.events.emit('settings:changed', { changedKeys: result.changedKeys })
      deps.log.info('ipc.settings.changed', { changedKeys: result.changedKeys })
      return result
    },
    { fallbackKey: 'APP_CONFIG_INVALID' },
  ),

  h(
    'settings:setSecret',
    (req, deps) => {
      deps.settings.setSecret(req.key, req.value)
      // 绝不在日志里记录 value（docs/04 §5.2）
      deps.log.info('ipc.settings.secretSet', { key: req.key })
      return { ok: true }
    },
    { fallbackKey: 'APP_SECURE_STORAGE_UNAVAILABLE' },
  ),

  h(
    'settings:testProvider',
    async (req, deps) => {
      // 健康探测失败不抛错，而是返回 ok:false + message（设置页要展示原因）
      try {
        return await deps.provider.test(req.provider)
      } catch (e) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        }
      }
    },
    { fallbackKey: 'PROVIDER_UNAVAILABLE' },
  ),

  h('settings:reset', (req, deps) => {
    deps.settings.reset(req?.keys)
    deps.events.emit('settings:changed', { changedKeys: req?.keys ?? ['*'] })
    return { ok: true }
  }),
]

// ============================================================================
// task（6 个通道，见 docs/04 §2.2）
// ============================================================================

export const taskHandlers = [
  h('task:list', async (req, deps) =>
    // 队列的持久化端口是异步的（见 deps.ts TaskPort 的说明）
    await deps.tasks.list({
      ...(req?.status !== undefined ? { status: req.status } : {}),
      ...(req?.kind !== undefined ? { kind: req.kind } : {}),
      ...(req?.limit !== undefined ? { limit: req.limit } : {}),
    }),
  ),

  h(
    'task:get',
    async (req, deps) => {
      const task = await deps.tasks.get(req.taskId)
      if (!task) {
        // 用语义键抛错（而不是裸 Error）：UI 才能拿到「找不到任务」的标题/hint
        throw new AppError('TASK_NOT_FOUND', { details: { taskId: req.taskId } })
      }
      return task
    },
    { fallbackKey: 'TASK_NOT_FOUND' },
  ),

  h('task:cancel', async (req, deps) => {
    const ok = await deps.tasks.cancel(req.taskId)
    deps.log.info('ipc.task.cancel', { taskId: req.taskId, accepted: ok })
    return { ok }
  }),

  h(
    'task:retry',
    async (req, deps) => {
      const result = await deps.tasks.retry(req.taskId)
      if (!result) {
        // 队列只保留本会话的参数：上一次运行遗留的 interrupted 任务无法重试
        throw new AppError('TASK_FAILED', {
          details: { taskId: req.taskId, reason: 'not-retryable', hint: '请在界面上重新发起该操作' },
        })
      }
      return result
    },
    { fallbackKey: 'TASK_FAILED' },
  ),

  h('task:clearFinished', voidSchema, async (_req, deps) => ({
    cleared: await deps.tasks.clearFinished(),
  })),

  h(
    'task:result',
    async (req, deps) => await deps.tasks.result(req.taskId),
    { fallbackKey: 'TASK_NOT_FOUND' },
  ),
]

// ============================================================================
// db（5 个通道，见 docs/04 §1.3、docs/21 §15）
// ============================================================================

export const dbHandlers = [
  h(
    'db:backup',
    voidSchema,
    async (_req, deps) => {
      const result = await deps.db.backup()
      deps.log.info('ipc.db.backup.done', { path: result.path })
      return result
    },
    { fallbackKey: 'DB_BACKUP_FAILED' },
  ),

  h('db:listBackups', voidSchema, async (_req, deps) => await deps.db.listBackups()),

  h(
    'db:restore',
    async (req, deps) => {
      // 恢复是有破坏性的：前后各记一条，便于事后审计
      deps.log.warn('ipc.db.restore.start', { path: req.path })
      await deps.db.restore(req.path)
      deps.log.warn('ipc.db.restore.done', { path: req.path })
      return { ok: true }
    },
    { fallbackKey: 'DB_RESTORE_FAILED' },
  ),

  h(
    'db:integrityCheck',
    voidSchema,
    async (_req, deps) => {
      const result = await deps.db.integrityCheck()
      if (!result.ok) {
        deps.log.error('ipc.db.integrityCheck.failed', { errors: result.errors })
      }
      return result
    },
    { fallbackKey: 'DB_CORRUPT' },
  ),

  h('db:stats', voidSchema, async (_req, deps) => await deps.db.stats()),
]

// ============================================================================
// log（1 个通道）与 ffmpeg 能力（1 个通道）
// ============================================================================

export const logHandlers = [
  h('log:subscribe', (req, deps) => {
    // 1) 调级别：诊断面板可以打开到 debug/trace（docs/04 §5.1）
    deps.log.setLevel(req.level)
    // 2) 把日志流接到事件端口：`log:entry` 是契约里的事件（docs/20 §4.11）。
    //    订阅者只存在一个（诊断面板是单例），重复订阅时后一次覆盖前一次即可，
    //    避免每开一次面板就多一个监听器（内存泄漏 + 重复推送）。
    deps.log.setEntryListener((record) => {
      deps.events.emit('log:entry', {
        ts: record.ts,
        level: record.level,
        event: record.event,
        ...(record.data !== undefined ? { data: record.data } : {}),
      })
    })
    deps.log.info('ipc.log.subscribe', { level: req.level })
    return { ok: true }
  }),
]

export const capabilityHandlers = [
  h('ffmpeg:capabilities', voidSchema, async (_req, deps) => {
    const caps = await deps.capabilities.getCapabilities()
    return caps.ffmpeg
  }),
]

// ============================================================================
// 自检
// ============================================================================

/** 合并后的系统域 handler，供 handlers/index.ts 注册 */
export const systemHandlers = [
  ...settingsHandlers,
  ...taskHandlers,
  ...dbHandlers,
  ...logHandlers,
  ...capabilityHandlers,
]

export function assertSystemHandlersSane(): void {
  const seen = new Set<string>()
  for (const spec of systemHandlers) {
    if (!IPC_CHANNELS.includes(spec.channel)) {
      throw new Error(`[ipc] 系统域 handler 登记了契约中不存在的通道：${spec.channel}`)
    }
    if (seen.has(spec.channel)) {
      throw new Error(`[ipc] 系统域 handler 重复登记通道：${spec.channel}`)
    }
    seen.add(spec.channel)
  }
}
