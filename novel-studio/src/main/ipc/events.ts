/**
 * 主进程 · 事件推送（主 → 渲染）
 * ============================================================================
 * 设计依据：docs/20 §2（三种模式）、§4.11（事件流清单）、§7（事件与状态同步约定）
 *           docs/01 §13.3「ipc/events.ts：主进程主动推送的错误走 app:error 事件」
 *
 * 三条必须遵守的约定（docs/20 §7）：
 *   · 主进程权威：状态机以主进程为准，渲染进程只镜像
 *   · 节流：高频事件（电平 ≤20/s、进度 ≤10/s）在**主进程侧**节流，不依赖渲染进程
 *   · **不丢终态**：`task:finished` 必须送达；若发送时窗口不存在，落库，
 *     窗口就绪后补发
 *
 * 「不丢终态」的实现方式：终态事件（`task:finished` / `crash:recovered` /
 * `main:interruptedTasks` / `app:error`）在没有可用窗口时写入**待补发队列**
 * （持久化接口注入，生产落 `app_logs`/`settings`，测试用内存），
 * 窗口 ready 后由 `flushPending()` 一次性补发。
 */

import { AppError, isAppError, toSerialized, wrapUnknown } from '../../shared/errors.ts'
import type { SerializedAppError } from '../../shared/errors.ts'
import { IPC_EVENT_NAMES, isIpcEventName } from '../../shared/ipc.ts'
import type { IpcEventName, IpcEventPayload } from '../../shared/ipc.ts'
import type { WebContentsLike } from '../infra/electron/types.ts'

// ---------------------------------------------------------------------------
// 待补发队列（窗口不存在时的落库接口）
// ---------------------------------------------------------------------------

export interface PendingEvent {
  id: string
  event: string
  payload: unknown
  createdAt: number
}

export interface EventBacklogStore {
  save(entry: PendingEvent): void | Promise<void>
  loadAll(): PendingEvent[] | Promise<PendingEvent[]>
  remove(ids: readonly string[]): void | Promise<void>
}

/** 内存待补发队列（测试与「窗口重建」场景） */
export function createMemoryEventBacklog(maxEntries = 200): EventBacklogStore & { all(): PendingEvent[] } {
  const items: PendingEvent[] = []
  return {
    save(entry) {
      items.push(entry)
      if (items.length > maxEntries) items.splice(0, items.length - maxEntries)
    },
    loadAll() {
      return [...items]
    },
    remove(ids) {
      const wanted = new Set(ids)
      for (let i = items.length - 1; i >= 0; i--) if (wanted.has(items[i].id)) items.splice(i, 1)
    },
    all() {
      return [...items]
    },
  }
}

// ---------------------------------------------------------------------------
// 事件出口
// ---------------------------------------------------------------------------

export interface EventEmitterDeps {
  log?: {
    warn: (event: string, fields: Record<string, unknown>) => void
    debug?: (event: string, fields: Record<string, unknown>) => void
    info?: (event: string, fields: Record<string, unknown>) => void
  }
  /** 待补发队列（不传则「窗口不存在」时事件只记日志） */
  backlog?: EventBacklogStore
  now?: () => number
  makeId?: () => string
}

export interface EmitOptions {
  /**
   * 终态事件（不丢）：窗口不存在时落库待补发（docs/20 §7）。
   * 进度类高频事件**不要**开它，否则会写库写爆。
   */
  durable?: boolean
}

export interface IpcEventEmitter {
  /** 发一个事件（按事件名从契约表推断载荷类型） */
  emit<E extends IpcEventName>(event: E, payload: IpcEventPayload<E>, opts?: EmitOptions): void
  /** 向所有窗口广播同一事件（emit 的别名，语义更清楚时用） */
  broadcast<E extends IpcEventName>(event: E, payload: IpcEventPayload<E>, opts?: EmitOptions): void
  /**
   * 推送错误到 UI（事件 `app:error`）。
   * 注意：**已经通过 invoke 的 {ok:false} 返回给调用方的错误不要再推**（docs/20 §4.11）。
   */
  notifyError(err: unknown, opts?: { durable?: boolean; force?: boolean }): void
  /** 窗口就绪后补发待补发事件（docs/20 §7「不丢终态」） */
  flushPending(): Promise<number>
  /** 当前可投递目标数量（诊断用） */
  targetCount(): number
  /** 待补发条数 */
  pendingCount(): number
}

/** 最小接口校验：事件名必须来自契约表（防止渲染进程订阅到一个永远不发的事件） */
export function assertEventName(event: string): asserts event is IpcEventName {
  if (!isIpcEventName(event)) {
    throw new AppError('INTERNAL', {
      details: {
        kind: 'IPC_EVENT_NAME',
        event,
        known: IPC_EVENT_NAMES.length,
        hint: '事件名必须登记在 src/shared/ipc.ts 的 IpcEventMap 中',
      },
    })
  }
}

/** 终态事件白名单：这些必须送达（docs/20 §7「不丢终态」） */
export const DURABLE_EVENTS: readonly IpcEventName[] = [
  'task:finished',
  'app:error',
  'crash:recovered',
  'main:interruptedTasks',
  'app:beforeQuit',
]

/**
 * 创建事件发射器。
 *
 * @param targets 目标列表或「取目标」的函数（推荐传函数：窗口会重建，列表会过期）
 */
export function createEventEmitter(
  targets: WebContentsLike[] | (() => WebContentsLike[]),
  deps?: EventEmitterDeps,
): IpcEventEmitter {
  const now = deps?.now ?? Date.now
  const makeId = deps?.makeId ?? (() => `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  let pendingCount = 0

  function resolveTargets(): WebContentsLike[] {
    try {
      const list = typeof targets === 'function' ? targets() : targets
      if (!Array.isArray(list)) return []
      return list.filter((wc) => {
        try {
          return Boolean(wc) && !(wc.isDestroyed?.() ?? false)
        } catch {
          return false
        }
      })
    } catch (e) {
      deps?.log?.warn?.('events.resolveTargets.failed', { event: 'events.resolveTargets.failed', reason: String(e) })
      return []
    }
  }

  function deliver(event: string, payload: unknown): number {
    const list = resolveTargets()
    let sent = 0
    for (const wc of list) {
      try {
        wc.send(event, payload)
        sent++
      } catch (e) {
        // 单个窗口失败（正在销毁）不影响其它窗口，也绝不抛给调用方
        deps?.log?.warn?.('events.send.failed', { event: 'events.send.failed', channel: event, reason: String(e) })
      }
    }
    return sent
  }

  function emit<E extends IpcEventName>(event: E, payload: IpcEventPayload<E>, opts?: EmitOptions): void {
    try {
      assertEventName(event)
    } catch (e) {
      // 事件名不合规是开发期问题：记日志但**不丢事件语义**（用未知通道发出去，渲染侧会忽略）
      deps?.log?.warn?.('events.invalidName', { event: 'events.invalidName', name: String(event) })
      return
    }
    const sent = deliver(event, payload)
    const durable = opts?.durable ?? (DURABLE_EVENTS as readonly string[]).includes(event)
    if (sent === 0 && durable) {
      // 窗口不存在（启动早期 / 渲染进程崩溃重建中）→ 落库待补发
      const entry: PendingEvent = { id: makeId(), event, payload, createdAt: now() }
      try {
        void Promise.resolve(deps?.backlog?.save(entry)).then(
          () => {
            pendingCount++
          },
          (e) => {
            deps?.log?.warn?.('events.backlog.saveFailed', { event: 'events.backlog.saveFailed', channel: event, reason: String(e) })
          },
        )
        if (!deps?.backlog) {
          deps?.log?.warn?.('events.dropped', {
            event: 'events.dropped',
            channel: event,
            reason: 'no-window-and-no-backlog',
          })
        }
      } catch (e) {
        deps?.log?.warn?.('events.backlog.saveFailed', { event: 'events.backlog.saveFailed', channel: event, reason: String(e) })
      }
    }
  }

  function notifyError(err: unknown, opts?: { durable?: boolean; force?: boolean }): void {
    const appErr = isAppError(err) ? err : wrapUnknown(err)
    // 取消类错误不推（docs/22 §4：取消不是错误，UI 直接吞掉）
    if (appErr.isCancelled) return
    emit('app:error', appErr.toJSON() as IpcEventPayload<'app:error'>, {
      durable: opts?.durable ?? appErr.severity === 'fatal',
    })
  }

  async function flushPending(): Promise<number> {
    const backlog = deps?.backlog
    if (!backlog) return 0
    let entries: PendingEvent[] = []
    try {
      entries = (await backlog.loadAll()) ?? []
    } catch (e) {
      deps?.log?.warn?.('events.backlog.loadFailed', { event: 'events.backlog.loadFailed', reason: String(e) })
      return 0
    }
    if (entries.length === 0) {
      pendingCount = 0
      return 0
    }
    if (resolveTargets().length === 0) return 0 // 还是没有窗口，继续保持待补发

    const deliveredIds: string[] = []
    let delivered = 0
    for (const entry of entries) {
      // 补发按时间顺序，保证「终态顺序」与产生顺序一致
      const sent = deliver(entry.event, entry.payload)
      if (sent > 0) {
        deliveredIds.push(entry.id)
        delivered++
      }
    }
    try {
      if (deliveredIds.length > 0) await backlog.remove(deliveredIds)
      pendingCount = Math.max(0, entries.length - deliveredIds.length)
    } catch (e) {
      deps?.log?.warn?.('events.backlog.removeFailed', { event: 'events.backlog.removeFailed', reason: String(e) })
    }
    if (delivered > 0) {
      deps?.log?.info?.('events.backlog.flushed', { event: 'events.backlog.flushed', count: delivered })
    }
    return delivered
  }

  return {
    emit,
    broadcast: emit,
    notifyError,
    flushPending,
    targetCount: () => resolveTargets().length,
    pendingCount: () => pendingCount,
  }
}

/** 序列化错误（供 events 之外的地方复用，保持一致性） */
export function serializeError(err: unknown): SerializedAppError {
  return toSerialized(wrapUnknown(err))
}
