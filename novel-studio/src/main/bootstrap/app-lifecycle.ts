/**
 * 启动编排 · 严格的启动顺序（docs/01 §10）
 * ============================================================================
 * ```
 * 1. app.requestSingleInstanceLock()      # 二次启动聚焦已有窗口
 * 2. 解析 userData 与设置（含便携模式判断）
 * 3. 初始化日志（含崩溃捕获）
 * 4. 打开数据库 → 跑迁移 → integrity_check
 * 5. 崩溃恢复：扫描各项目目录下 recordings 子目录的未定稿 WAV → 修复 WAV 头 → 生成 session 记录
 * 6. 清理过期临时文件与孤儿缓存（带白名单保护）
 * 7. 校验模型文件（异步、不阻塞）
 * 8. 探测 ffmpeg（异步）
 * 9. 注册自定义协议 ns-media://
 * 10. 注册 IPC handlers（幂等）
 * 11. 创建主窗口 → 加载渲染进程 → 就绪
 * 12. 后台：自动备份、缓存清理、更新检查（可关）
 * ```
 *
 * **顺序理由（docs/01 §10 原话）**：
 *   · 3 必须在 4 之前（数据库出问题要留日志）
 *   · **5 必须在 6 之前**（不能把待修复的 `.tmp` 当垃圾删掉——这会直接导致用户录音丢失）
 *
 * 因此本文件不是「一个 runStartup() 大函数」，而是：
 *   · `STARTUP_ORDER` 常量：声明顺序（可被自检与测试读取）
 *   · `runStartupSequence(steps)`：**只负责按顺序调用**，同时做顺序自检
 *   · 每一步的实现由调用方（main/index.ts）注入，从而 bootstrap 本身不依赖 Electron
 *
 * 7/8 步按 docs 要求是「异步、不阻塞」：这里启动 Promise 但不 await，
 * 把 Promise 放进 `deferred`，由 `app:getCapabilities` 在使用时 await（避免 UI 启动就卡）。
 */

import { AppError } from '../../shared/errors.ts'
import type { RecoveryReport } from './recovery.ts'
import type { CleanupReport } from './cleanup.ts'

/** 启动步骤名（顺序即执行顺序；改动这里等于改动架构，必须同步 docs/01 §10） */
export const STARTUP_ORDER = [
  'acquireSingleInstanceLock',
  'resolvePaths',
  'initLogging',
  'openDatabase',
  'runMigrations',
  'integrityCheck',
  'recoverCrashed',
  'cleanupTemporaries',
  'verifyModels',
  'probeFfmpeg',
  'registerProtocols',
  'registerHandlers',
  'createWindow',
] as const

export type StartupStepName = (typeof STARTUP_ORDER)[number]

/** 不可跳过的关键步骤（缺失即抛错，防止「悄悄少做一步」） */
export const REQUIRED_STEPS: readonly StartupStepName[] = [
  'acquireSingleInstanceLock',
  'resolvePaths',
  'initLogging',
  'openDatabase',
  'runMigrations',
  'integrityCheck',
  'recoverCrashed',
  'cleanupTemporaries',
  'registerHandlers',
  'createWindow',
]

/** 允许异步、不阻塞的步骤（docs/01 §10：7、8 是「异步、不阻塞」） */
export const NON_BLOCKING_STEPS: readonly StartupStepName[] = ['verifyModels', 'probeFfmpeg']

/**
 * 启动流程可用的最小日志端口。
 *
 * 不直接依赖 `infra/log/logger.ts` 的 `Logger`：bootstrap 层要能在无 Electron、
 * 无文件系统的单测里跑，只约定「三个级别 + 事件名 + 结构化字段」。
 * `error` 是必需的：启动失败必须留下 error 级日志（docs/22 §3 日志分级）。
 */
export interface StartupLogPort {
  info(event: string, fields: Record<string, unknown>): void
  warn(event: string, fields: Record<string, unknown>): void
  error(event: string, fields: Record<string, unknown>): void
}

export interface StartupContext {
  /** 单实例锁结果：false 表示已有实例在跑，**当前进程应立即退出**（不继续后续步骤） */
  hasLock: boolean
  paths?: Record<string, string>
  log?: StartupLogPort
  db?: unknown
  logger?: unknown
  recovery?: RecoveryReport
  cleanup?: CleanupReport
  [key: string]: unknown
}

export interface StartupSteps {
  acquireSingleInstanceLock: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  resolvePaths: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  initLogging: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  openDatabase: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  runMigrations: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  integrityCheck: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  recoverCrashed: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  cleanupTemporaries: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  verifyModels?: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  probeFfmpeg?: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  registerProtocols?: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  registerHandlers: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  createWindow: (ctx: StartupContext) => Promise<StartupContext> | StartupContext
  /** 第 12 步：后台任务（自动备份、缓存清理、更新检查）——全部可关 */
  background?: (ctx: StartupContext) => Promise<void> | void
}

export interface StartupTimelineEntry {
  step: StartupStepName
  startedAt: number
  elapsedMs: number
  /** 'done' | 'skipped' | 'deferred' | 'failed' */
  result: 'done' | 'skipped' | 'deferred' | 'failed'
  error?: string
}

export interface StartupResult {
  ok: boolean
  context: StartupContext
  timeline: StartupTimelineEntry[]
  /** 被异步启动（未 await）的步骤：模型校验、ffmpeg 探测 */
  deferred: Partial<Record<StartupStepName, Promise<unknown>>>
  /** 单实例锁没拿到 → 调用方应直接退出（返回 ok:false, reason='single-instance'） */
  reason?: string
  elapsedMs: number
}

/**
 * 按 docs/01 §10 的顺序执行启动流程。
 *
 * @throws AppError('APP_CONFIG_INVALID') 缺少必需步骤时
 * @throws 任何步骤抛出的异常都会**向上抛**（启动失败必须让调用方决定是退出还是进只读模式），
 *         但时间线会被完整记录，便于诊断「卡在哪一步」。
 */
export async function runStartupSequence(steps: StartupSteps): Promise<StartupResult> {
  assertStepsSane(steps)
  const bootStarted = Date.now()
  const timeline: StartupTimelineEntry[] = []
  const deferred: StartupResult['deferred'] = {}
  let ctx: StartupContext = { hasLock: false }

  for (const step of STARTUP_ORDER) {
    const fn = (steps as unknown as Record<string, ((c: StartupContext) => unknown) | undefined>)[step]
    if (typeof fn !== 'function') {
      timeline.push({ step, startedAt: Date.now(), elapsedMs: 0, result: 'skipped' })
      continue
    }
    const startedAt = Date.now()
    try {
      if ((NON_BLOCKING_STEPS as readonly string[]).includes(step)) {
        // docs/01 §10：7、8 异步、不阻塞 —— 立即返回，把 Promise 留给需要它的调用方 await
        const task = Promise.resolve(fn(ctx)).then((next) => {
          if (next && typeof next === 'object') Object.assign(ctx, next as object)
          return next
        })
        deferred[step as StartupStepName] = task
        timeline.push({ step, startedAt, elapsedMs: Date.now() - startedAt, result: 'deferred' })
        continue
      }

      const next = await fn(ctx)
      if (next && typeof next === 'object') ctx = next as StartupContext
      timeline.push({ step, startedAt, elapsedMs: Date.now() - startedAt, result: 'done' })

      if (step === 'acquireSingleInstanceLock' && ctx.hasLock === false) {
        // 已有实例在运行：本进程的职责就是「聚焦已有窗口然后退出」
        ctx.log?.info?.('app.start.singleInstance', { event: 'app.start.singleInstance' })
        return {
          ok: false,
          context: ctx,
          timeline,
          deferred,
          reason: 'single-instance',
          elapsedMs: Date.now() - bootStarted,
        }
      }
    } catch (e) {
      const appErr = e instanceof AppError ? e : new AppError('INTERNAL', { cause: e })
      timeline.push({
        step,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        result: 'failed',
        error: `${appErr.key}: ${appErr.message}`,
      })
      ctx.log?.error?.('app.start.failed', {
        event: 'app.start.failed',
        step,
        code: appErr.key,
        numericCode: appErr.numericCode,
        elapsedMs: Date.now() - bootStarted,
      })
      throw appErr
    }
  }

  // ── 第 12 步：后台任务（自动备份 / 缓存清理 / 更新检查）───────────────────
  if (steps.background) {
    try {
      await steps.background(ctx)
      timeline.push({ step: 'createWindow', startedAt: Date.now(), elapsedMs: 0, result: 'done' })
    } catch (e) {
      // 后台任务失败不影响应用可用性：记录后继续（docs/01 §6 降级策略）
      ctx.log?.warn?.('app.background.failed', { event: 'app.background.failed', reason: String(e) })
    }
  }

  const result: StartupResult = {
    ok: true,
    context: ctx,
    timeline,
    deferred,
    elapsedMs: Date.now() - bootStarted,
  }
  ctx.log?.info?.('app.start.done', {
    event: 'app.start.done',
    elapsedMs: result.elapsedMs,
    steps: timeline.length,
    slowest: timeline
      .slice()
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 3)
      .map((t) => `${t.step}:${t.elapsedMs}ms`),
  })
  return result
}

/** 启动前自检：必需步骤必须提供；顺序常量不得缺项 */
export function assertStepsSane(steps: StartupSteps): void {
  const missing = REQUIRED_STEPS.filter(
    (name) => typeof (steps as unknown as Record<string, unknown>)[name] !== 'function',
  )
  if (missing.length > 0) {
    throw new AppError('APP_CONFIG_INVALID', {
      details: {
        reason: 'startup-steps-missing',
        missing,
        hint: '启动顺序见 docs/01 §10；缺少必需步骤会导致「悄悄少做一步」的隐性缺陷',
      },
    })
  }
}

/**
 * 顺序不变式自检：`recoverCrashed` 必须早于 `cleanupTemporaries`。
 *
 * 这是本项目**最容易造成用户数据丢失**的一处：先清理会把待修复的 `.wav.tmp`
 * 当垃圾删掉（docs/01 §10）。这里把它固化成可跑的自检，任何重构都不会再踩。
 */
export function assertRecoveryBeforeCleanup(order: readonly string[] = STARTUP_ORDER): void {
  const recoveryIdx = order.indexOf('recoverCrashed')
  const cleanupIdx = order.indexOf('cleanupTemporaries')
  if (recoveryIdx < 0 || cleanupIdx < 0 || recoveryIdx > cleanupIdx) {
    throw new AppError('APP_CONFIG_INVALID', {
      details: {
        reason: 'startup-order-violation',
        rule: 'recoverCrashed 必须早于 cleanupTemporaries（docs/01 §10：5 在 6 之前）',
        order: [...order],
      },
    })
  }
}
