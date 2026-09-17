/**
 * Novel Studio · bootstrap（启动编排）
 * ============================================================================
 * 设计依据：docs/01-系统架构.md §10「启动顺序（必须严格）」、§11「关闭与崩溃语义」
 *
 * ### 为什么启动顺序不能随意调整
 *   docs/01 §10 里有一条注释值得抄在这里，因为它是这套顺序存在的唯一理由：
 *
 *     「3 必须在 4 之前（数据库出问题要留日志）；5 必须在 6 之前
 *      （不能把待修复的 .tmp 当垃圾删掉 —— 这会直接导致用户录音丢失）」
 *
 *   即：**日志先于数据库，崩溃恢复先于临时文件清理**。
 *   这两条一旦调换，后果不是报错，而是静默丢数据。
 *
 * ### 本文件目前的定位
 *   编排需要 Electron 应用对象、真实窗口、真实数据库连接，这些在当前环境（无外网、
 *   无 electron）都无法运行。因此这里做两件事：
 *     1. 把「启动顺序」固化成**可测的步骤表**（`BOOT_STEPS`）与校验函数，
 *         让顺序约束不依赖任何运行时就能被测试保护；
 *     2. 定义装配所需的窄接口与 `BootstrapDeps`，由 `src/main/index.ts` 提供真实实现。
 *
 *   这样即使编排体还没写完，「顺序不许调换」这条规矩也已经被钉住了。
 */

// ---------------------------------------------------------------------------
// 启动步骤表
// ---------------------------------------------------------------------------

/** 启动步骤标识（顺序即数组顺序，见 docs/01 §10） */
export type BootStepId =
  | 'single-instance-lock'
  | 'resolve-paths'
  | 'init-logger'
  | 'open-database'
  | 'run-migrations'
  | 'integrity-check'
  | 'recover-crashed-recordings'
  | 'cleanup-temp-and-cache'
  | 'verify-models'
  | 'detect-ffmpeg'
  | 'register-media-protocol'
  | 'register-ipc-handlers'
  | 'create-main-window'
  | 'load-renderer'
  | 'background-maintenance'

export interface BootStep {
  id: BootStepId
  /** 人可读的步骤名（进启动日志） */
  label: string
  /**
   * 阻塞与否：false 表示可以并行/延后执行，不阻塞开窗。
   * 例如模型校验与 ffmpeg 探测耗时可长，不应该让用户干等。
   */
  blocking: boolean
  /** 失败时是否致命（致命 → 中止启动并给出明确原因） */
  fatalOnFailure: boolean
  /** 该步骤为什么必须在所给位置（供后来者理解，不要靠猜） */
  rationale: string
}

/**
 * 严格启动顺序。**不要重排**——每条 rationale 都对应一个真实的失败模式。
 */
export const BOOT_STEPS: readonly BootStep[] = [
  {
    id: 'single-instance-lock',
    label: '获取单实例锁',
    blocking: true,
    fatalOnFailure: false,
    rationale: '第二次启动应聚焦已有窗口并退出，而不是开两个实例同时写同一个数据库',
  },
  {
    id: 'resolve-paths',
    label: '解析 userData 与设置路径',
    blocking: true,
    fatalOnFailure: true,
    rationale: '后续每一步都要用路径；同时判断便携模式',
  },
  {
    id: 'init-logger',
    label: '初始化日志',
    blocking: true,
    fatalOnFailure: false,
    rationale: '必须早于数据库：数据库出问题时才有日志可查',
  },
  {
    id: 'open-database',
    label: '打开数据库连接并套用 PRAGMA',
    blocking: true,
    fatalOnFailure: true,
    rationale: 'WAL / foreign_keys / busy_timeout 必须在任何读写之前生效',
  },
  {
    id: 'run-migrations',
    label: '执行 schema 迁移',
    blocking: true,
    fatalOnFailure: true,
    rationale: '迁移失败必须中止启动（回滚并进只读模式），不能带着半成品 schema 继续跑',
  },
  {
    id: 'integrity-check',
    label: '数据库完整性检查',
    blocking: true,
    fatalOnFailure: false,
    rationale: '检查失败时进入只读模式并提示恢复备份，而不是直接崩',
  },
  {
    id: 'recover-crashed-recordings',
    label: '崩溃恢复（修复未定稿的录音）',
    blocking: true,
    fatalOnFailure: false,
    rationale: '必须早于临时文件清理：否则待修复的 .tmp 会被当垃圾删掉，用户录音直接丢',
  },
  {
    id: 'cleanup-temp-and-cache',
    label: '清理过期临时文件与缓存',
    blocking: false,
    fatalOnFailure: false,
    rationale: '放在恢复之后；带白名单保护，绝不删用户素材',
  },
  {
    id: 'verify-models',
    label: '校验模型文件（异步）',
    blocking: false,
    fatalOnFailure: false,
    rationale: '模型校验要算 SHA-256，耗时较长；不阻塞开窗，失败只降级功能',
  },
  {
    id: 'detect-ffmpeg',
    label: '探测 ffmpeg 能力（异步）',
    blocking: false,
    fatalOnFailure: false,
    rationale: '同样耗时不阻塞开窗；探测结果决定 UI 隐藏哪些处理控件',
  },
  {
    id: 'register-media-protocol',
    label: '注册 ns-media:// 协议',
    blocking: true,
    fatalOnFailure: true,
    rationale: '必须在渲染进程加载之前注册，否则音频无法读取（且 handler 内做路径校验）',
  },
  {
    id: 'register-ipc-handlers',
    label: '注册 IPC handlers',
    blocking: true,
    fatalOnFailure: true,
    rationale: '渲染进程一挂载就可能发请求；未注册的通道会被 preload 白名单拒绝',
  },
  {
    id: 'create-main-window',
    label: '创建主窗口',
    blocking: true,
    fatalOnFailure: true,
    rationale: '窗口创建要晚于 handler 注册，避免首屏请求落在空注册表上',
  },
  {
    id: 'load-renderer',
    label: '加载渲染进程',
    blocking: true,
    fatalOnFailure: false,
    rationale: '加载失败时通过错误边界与日志报告，而不是白屏无信息',
  },
  {
    id: 'background-maintenance',
    label: '后台维护（自动备份 / 缓存清理 / 更新检查）',
    blocking: false,
    fatalOnFailure: false,
    rationale: '全部可关闭、可延后；不能与启动关键路径争资源',
  },
] as const

// ---------------------------------------------------------------------------
// 顺序约束自检（可测）
// ---------------------------------------------------------------------------

/** 必须保持的先后关系（docs/01 §10 明确点名的两条） */
const REQUIRED_ORDER: ReadonlyArray<{ before: BootStepId; after: BootStepId; why: string }> = [
  {
    before: 'init-logger',
    after: 'open-database',
    why: '数据库出问题要有日志可查',
  },
  {
    before: 'recover-crashed-recordings',
    after: 'cleanup-temp-and-cache',
    why: '先清理会把待修复的 .tmp 当垃圾删掉，导致用户录音丢失',
  },
  {
    before: 'run-migrations',
    after: 'integrity-check',
    why: '迁移后再检查，检查的是最终 schema',
  },
  {
    before: 'open-database',
    after: 'run-migrations',
    why: '没有连接就无法迁移',
  },
  {
    before: 'register-media-protocol',
    after: 'load-renderer',
    why: '协议未注册时渲染进程读不到音频',
  },
  {
    before: 'register-ipc-handlers',
    after: 'load-renderer',
    why: '首屏请求不能落在空注册表上',
  },
]

export interface BootOrderIssue {
  rule: string
  detail: string
}

/**
 * 只校验**相对先后关系**。
 *
 * 与 `validateBootPlan()` 的区别（这个区分很关键）：
 *   · `validateBootOrder()` —— 对**任意子集**都成立。执行器用它，因为测试与
 *     增量装配常只传几步（`BOOT_STEPS.slice(0, 5)`）。
 *   · `validateBootPlan()` —— 额外要求「关键步骤一个都不能少」。用于 CI 与
 *     完整启动前的门禁。
 *
 * 早先版本把两者混在一起，导致「只传 5 步」也被判定为缺步骤而直接拒绝执行 ——
 * 顺序校验不该依赖调用方传了多少步。
 */
export function validateBootOrder(steps: readonly BootStep[] = BOOT_STEPS): BootOrderIssue[] {
  const indexOf = new Map<BootStepId, number>()
  steps.forEach((s, i) => indexOf.set(s.id, i))

  const issues: BootOrderIssue[] = []

  // 1) 不得重复
  const seen = new Set<BootStepId>()
  for (const s of steps) {
    if (seen.has(s.id)) issues.push({ rule: 'no-duplicate', detail: `步骤重复：${s.id}` })
    seen.add(s.id)
  }

  // 2) 先后关系（只对同时出现的两步校验；缺的那一步由 validateBootPlan 负责）
  for (const rule of REQUIRED_ORDER) {
    const a = indexOf.get(rule.before)
    const b = indexOf.get(rule.after)
    if (a === undefined || b === undefined) continue
    if (a >= b) {
      issues.push({
        rule: `${rule.before} < ${rule.after}`,
        detail: `顺序错误：${rule.before}(#${a}) 必须在 ${rule.after}(#${b}) 之前 —— ${rule.why}`,
      })
    }
  }

  return issues
}

/** 必须存在的关键步骤（缺任何一个启动都不完整） */
const REQUIRED_STEPS: readonly BootStepId[] = [
  'init-logger',
  'open-database',
  'run-migrations',
  'recover-crashed-recordings',
  'cleanup-temp-and-cache',
  'register-media-protocol',
  'register-ipc-handlers',
  'create-main-window',
  'load-renderer',
]

/**
 * 完整启动计划校验：顺序 + 关键步骤齐全 + 每条 rationale 存在。
 * 用于 CI 门禁与真实启动前的检查（**不要**用在只传子集的场景）。
 */
export function validateBootPlan(steps: readonly BootStep[] = BOOT_STEPS): BootOrderIssue[] {
  const issues = validateBootOrder(steps)
  const ids = new Set(steps.map(s => s.id))

  for (const id of REQUIRED_STEPS) {
    if (!ids.has(id)) issues.push({ rule: 'required-step', detail: `缺少必需步骤：${id}` })
  }

  for (const s of steps) {
    if (!s.rationale || s.rationale.length < 8) {
      issues.push({ rule: 'rationale', detail: `步骤 ${s.id} 缺少 rationale（不允许有「不知道为什么在这」的步骤）` })
    }
  }

  return issues
}

// ---------------------------------------------------------------------------
// 装配依赖（窄接口，由 src/main/index.ts 提供真实实现）
// ---------------------------------------------------------------------------

/** 单步执行结果（用于启动报告） */
export interface BootStepResult {
  id: BootStepId
  ok: boolean
  skipped: boolean
  elapsedMs: number
  /** 失败原因（已转成可读文本；错误码由调用方记入日志） */
  error?: string
  /** 该步骤产出的、后续步骤需要的值 */
  produced?: Record<string, unknown>
}

export interface BootReport {
  startedAt: number
  finishedAt: number
  steps: BootStepResult[]
  /** 致命失败导致中止时，指出是哪一步 */
  abortedAt: BootStepId | null
}

/** 各步骤的实现（由 index.ts 提供；未提供的步骤会被跳过并记录） */
export interface BootStepHandlers {
  [id: string]: (ctx: BootContext) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
}

/** 启动上下文：携带前序步骤的产出 */
export interface BootContext {
  /** 已产出的值（如 logger、db 句柄、capabilities） */
  values: Record<string, unknown>
  /** 记录一步的结果 */
  record(result: Omit<BootStepResult, 'elapsedMs'> & { elapsedMs?: number }): void
  /** 中止启动 */
  abort(reason: string): never
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/**
 * 按 `steps` 顺序执行。任一 `fatalOnFailure` 的步骤抛错即中止，并返回包含中止点的报告。
 *
 * 注意：**不吞错**。每一步的异常都会：
 *   · 记入 `BootStepResult.error`（进启动报告）
 *   · 若该步 fatal → 立即中止并返回报告，由 index.ts 决定如何提示用户
 */
export async function runBootSequence(options: {
  steps?: readonly BootStep[]
  handlers: BootStepHandlers
  onStepFinish?: (result: BootStepResult) => void
  onStepStart?: (step: BootStep) => void
  now?: () => number
}): Promise<BootReport> {
  const steps = options.steps ?? BOOT_STEPS
  const now = options.now ?? Date.now
  const startedAt = now()

  const orderIssues = validateBootOrder(steps)
  if (orderIssues.length > 0) {
    // 顺序错了就没必要跑 —— 跑了可能真丢数据
    return {
      startedAt,
      finishedAt: now(),
      abortedAt: null,
      steps: [{
        id: 'single-instance-lock',
        ok: false,
        skipped: true,
        elapsedMs: 0,
        error: `启动顺序校验失败：${orderIssues.map(i => i.detail).join('；')}`,
      }],
    }
  }

  const results: BootStepResult[] = []
  let abortedAt: BootStepId | null = null

  const ctx: BootContext = {
    values: {},
    record: (r) => {
      const full: BootStepResult = { elapsedMs: 0, ...r }
      results.push(full)
      options.onStepFinish?.(full)
    },
    abort: (reason: string): never => {
      throw new Error(reason)
    },
  }

  for (const step of steps) {
    const handler = options.handlers[step.id]
    if (!handler) {
      // 未提供实现：记录为跳过而不是假装成功
      const result: BootStepResult = {
        id: step.id,
        ok: true,
        skipped: true,
        elapsedMs: 0,
        error: `未提供 ${step.id} 的实现（跳过）`,
      }
      results.push(result)
      options.onStepFinish?.(result)
      continue
    }

    options.onStepStart?.(step)
    const t0 = now()
    try {
      const produced = await handler(ctx)
      if (produced && typeof produced === 'object') {
        Object.assign(ctx.values, produced)
      }
      const result: BootStepResult = {
        id: step.id,
        ok: true,
        skipped: false,
        elapsedMs: now() - t0,
        ...(produced ? { produced: produced as Record<string, unknown> } : {}),
      }
      results.push(result)
      options.onStepFinish?.(result)
    } catch (e) {
      const result: BootStepResult = {
        id: step.id,
        ok: false,
        skipped: false,
        elapsedMs: now() - t0,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      }
      results.push(result)
      options.onStepFinish?.(result)

      if (step.fatalOnFailure) {
        abortedAt = step.id
        break
      }
    }
  }

  return { startedAt, finishedAt: now(), steps: results, abortedAt }
}

/** 生成可读的启动报告（写日志用；同一条目一行，便于 grep） */
export function formatBootReport(report: BootReport): string[] {
  const lines: string[] = []
  lines.push(`启动耗时 ${report.finishedAt - report.startedAt}ms，共 ${report.steps.length} 步`)
  for (const s of report.steps) {
    const mark = s.skipped ? 'skip' : s.ok ? 'ok  ' : 'FAIL'
    lines.push(`  [${mark}] ${s.id.padEnd(28)} ${String(s.elapsedMs).padStart(5)}ms${s.error ? `  ${s.error}` : ''}`)
  }
  if (report.abortedAt) lines.push(`  ** 启动在中止于：${report.abortedAt} **`)
  return lines
}

// ---------------------------------------------------------------------------
// 各步骤的**具体实现**（本次基础设施交付）
// ---------------------------------------------------------------------------
// 上面是本目录的「声明式启动计划」（顺序表 + 校验 + 执行器）；
// 下面是与之配套的**步骤实现**，二者是同一件事的两个部分：
//   · BOOT_STEPS / validateBootOrder        ——「顺序是什么、为什么是这个顺序」
//   · runStartupSequence / STARTUP_ORDER     ——「按顺序真的把它跑起来」
//   · recovery / cleanup / window-manager    ——「每一步具体做什么」
//
// 关键不变式在两处都做了保护：
//   `assertRecoveryBeforeCleanup()`（本文件下方导出）与 `validateBootOrder()`，
//   任何一个被破坏都会直接抛错，而不是「静默先清理再恢复」把用户录音删掉。

export {
  NON_BLOCKING_STEPS,
  REQUIRED_STEPS,
  STARTUP_ORDER,
  assertRecoveryBeforeCleanup,
  assertStepsSane,
  runStartupSequence,
  type StartupContext,
  type StartupResult,
  type StartupStepName,
  type StartupSteps,
  type StartupTimelineEntry,
} from './app-lifecycle.ts'

export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TEMP_MAX_AGE_MS,
  cleanupCaches,
  cleanupStaleTemps,
  defaultCleanupTargets,
  type CacheCleanupDeps,
  type CleanupDeps,
  type CleanupReport,
} from './cleanup.ts'

export {
  WAV_HEADER_BYTES,
  assertManifestProtected,
  availableFrames,
  buildWavHeader,
  bytesPerFrame,
  findRecoverableFiles,
  formatFromParsed,
  framesToMs,
  looksLikeUserAsset,
  parseWavHeader,
  readRecordingMeta,
  recoverRecordings,
  recoveredPathFor,
  recoveryEventPayload,
  repairWavHeader,
  sessionIdFromTmpName,
  type ParsedWav,
  type RecoveredSessionInput,
  type RecordingMetaFile,
  type RecordingSessionWriter,
  type RecoveryDeps,
  type RecoveryReport,
  type RepairResult,
  type RepairWavOptions,
  type TaskRecoveryPort,
  type WavFormat,
} from './recovery.ts'

export {
  DEFAULT_WINDOW_STATE,
  MEDIA_SCHEME,
  createMemoryWindowStateStore,
  createWindowManager,
  registerMediaProtocol,
  registerMediaSchemePrivileges,
  type MediaProtocolDeps,
  type WindowManager,
  type WindowManagerOptions,
  type WindowState,
  type WindowStateStore,
} from './window-manager.ts'
