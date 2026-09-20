/**
 * bootstrap 启动顺序与执行器测试（不需要 Electron / SQLite）
 * ============================================================================
 * 设计依据：docs/01-系统架构.md §10「启动顺序（必须严格）」、§11「关闭与崩溃语义」
 *
 * 这组测试守的是**数据安全**，不是形式：
 *   docs/01 §10 明确写了「5 必须在 6 之前（不能把待修复的 .tmp 当垃圾删掉 ——
 *   这会直接导致用户录音丢失）」。顺序被调换不会报错，只会静默丢数据，
 *   因此必须由测试钉住。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  BOOT_STEPS,
  formatBootReport,
  runBootSequence,
  validateBootOrder,
  validateBootPlan,
  type BootStep,
  type BootStepId,
} from '../../src/main/bootstrap/index.ts'

/** 取某步在默认序列里的下标 */
function idx(id: BootStepId): number {
  return BOOT_STEPS.findIndex(s => s.id === id)
}

describe('启动顺序：必须成立的先后关系', () => {
  it('默认顺序通过全部校验', () => {
    assert.deepEqual(validateBootOrder(), [])
  })

  it('日志初始化先于打开数据库（否则数据库出问题无日志可查）', () => {
    assert.ok(idx('init-logger') < idx('open-database'))
  })

  it('崩溃恢复先于临时文件清理（否则待修复的 .tmp 被当垃圾删掉，用户录音丢失）', () => {
    assert.ok(
      idx('recover-crashed-recordings') < idx('cleanup-temp-and-cache'),
      '这条一旦反了，后果不是报错而是静默丢录音',
    )
  })

  it('迁移先于完整性检查、开库先于迁移', () => {
    assert.ok(idx('open-database') < idx('run-migrations'))
    assert.ok(idx('run-migrations') < idx('integrity-check'))
  })

  it('媒体协议与 IPC handler 都先于渲染进程加载', () => {
    assert.ok(idx('register-media-protocol') < idx('load-renderer'))
    assert.ok(idx('register-ipc-handlers') < idx('load-renderer'))
  })

  it('窗口创建晚于 handler 注册（首屏请求不能落在空注册表上）', () => {
    assert.ok(idx('register-ipc-handlers') < idx('create-main-window'))
  })

  it('检测到顺序被调换时给出明确原因', () => {
    // 故意把清理提到恢复之前 —— 这正是最危险的那种「优化」
    const swapped: BootStep[] = [
      ...BOOT_STEPS.filter(s => s.id !== 'cleanup-temp-and-cache' && s.id !== 'recover-crashed-recordings'),
    ]
    const cleanIdx = swapped.findIndex(s => s.id === 'register-media-protocol')
    swapped.splice(cleanIdx, 0, BOOT_STEPS.find(s => s.id === 'cleanup-temp-and-cache')!)
    const recIdx = swapped.findIndex(s => s.id === 'load-renderer')
    swapped.splice(recIdx, 0, BOOT_STEPS.find(s => s.id === 'recover-crashed-recordings')!)

    const issues = validateBootOrder(swapped)
    assert.ok(issues.length > 0, '调换顺序必须被检出')
    assert.ok(
      issues.some(i => i.detail.includes('录音丢失')),
      `报错应说明后果，实际：${issues.map(i => i.detail).join(' / ')}`,
    )
  })

  it('缺步骤会被检出', () => {
    const missing = BOOT_STEPS.filter(s => s.id !== 'recover-crashed-recordings')
    const issues = validateBootPlan(missing)
    assert.ok(issues.some(i => i.rule === 'required-step' && i.detail.includes('recover-crashed-recordings')))
  })

  it('子集校验不要求关键步骤齐全（执行器只传几步时不应被拒）', () => {
    // 这是实现期踩过的坑：把「关键步骤齐全」混进顺序校验，
    // 会导致 runBootSequence 拿到子集就直接拒绝执行。
    const subset = BOOT_STEPS.slice(0, 5)
    assert.deepEqual(validateBootOrder(subset), [], '子集不应有顺序问题')
    assert.ok(validateBootPlan(subset).length > 0, '完整计划校验才该报缺步骤')
  })

  it('完整计划校验另外要求每条 rationale 存在', () => {
    const noRationale: BootStep[] = BOOT_STEPS.map(s =>
      s.id === 'detect-ffmpeg' ? { ...s, rationale: '' } : s,
    )
    const issues = validateBootPlan(noRationale)
    assert.ok(issues.some(i => i.rule === 'rationale' && i.detail.includes('detect-ffmpeg')))
  })

  it('默认完整计划通过全部校验', () => {
    assert.deepEqual(validateBootPlan(), [])
  })

  it('重复步骤会被检出', () => {
    const dup = [...BOOT_STEPS, BOOT_STEPS[0]!]
    const issues = validateBootOrder(dup)
    assert.ok(issues.some(i => i.rule === 'no-duplicate'))
  })
})

describe('启动顺序：步骤元信息', () => {
  it('每个步骤都有 rationale（不许有「不知道为什么在这」的步骤）', () => {
    for (const s of BOOT_STEPS) {
      assert.ok(s.rationale && s.rationale.length > 8, `${s.id} 缺少 rationale`)
    }
  })

  it('关键步骤必须是阻塞且致命的', () => {
    const fatal: BootStepId[] = ['open-database', 'run-migrations', 'register-media-protocol', 'register-ipc-handlers']
    for (const id of fatal) {
      const step = BOOT_STEPS.find(s => s.id === id)!
      assert.equal(step.blocking, true, `${id} 应为阻塞步骤`)
      assert.equal(step.fatalOnFailure, true, `${id} 失败时应中止启动`)
    }
  })

  it('耗时步骤不应阻塞开窗（模型校验、ffmpeg 探测、后台维护）', () => {
    for (const id of ['verify-models', 'detect-ffmpeg', 'background-maintenance'] as BootStepId[]) {
      const step = BOOT_STEPS.find(s => s.id === id)!
      assert.equal(step.blocking, false, `${id} 不应阻塞启动`)
      assert.equal(step.fatalOnFailure, false, `${id} 失败应降级而不是中止`)
    }
  })

  it('崩溃恢复失败不致命（要尽力带病启动，让用户能看到已恢复的素材）', () => {
    const step = BOOT_STEPS.find(s => s.id === 'recover-crashed-recordings')!
    assert.equal(step.fatalOnFailure, false)
  })
})

describe('runBootSequence 执行器', () => {
  it('按顺序执行并按顺序记录结果', async () => {
    const order: string[] = []
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 5),
      handlers: Object.fromEntries(
        BOOT_STEPS.slice(0, 5).map(s => [s.id, () => { order.push(s.id) }]),
      ),
    })

    assert.deepEqual(order, BOOT_STEPS.slice(0, 5).map(s => s.id))
    assert.equal(report.steps.length, 5)
    assert.equal(report.abortedAt, null)
    assert.ok(report.steps.every(s => s.ok))
  })

  it('未提供实现的步骤记为 skipped，而不是假装成功', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 3),
      handlers: { 'init-logger': () => void 0 },
    })
    const skipped = report.steps.filter(s => s.skipped)
    assert.equal(skipped.length, 2)
    assert.ok(skipped.every(s => s.error?.includes('未提供')))
  })

  it('致命步骤失败时中止，并指出中止点', async () => {
    let migrationsRan = false
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 6),
      handlers: {
        'single-instance-lock': () => void 0,
        'resolve-paths': () => void 0,
        'init-logger': () => void 0,
        'open-database': () => { throw new Error('SQLITE_CANTOPEN') },
        'run-migrations': () => { migrationsRan = true },
        'integrity-check': () => void 0,
      },
    })

    assert.equal(report.abortedAt, 'open-database')
    const dbStep = report.steps.find(s => s.id === 'open-database')!
    assert.equal(dbStep.ok, false)
    assert.match(dbStep.error!, /SQLITE_CANTOPEN/)
    // 致命失败会立刻 break —— 后续步骤既不执行也不记录在报告里
    assert.equal(migrationsRan, false, '中止后不得继续执行任何后续步骤')
    assert.equal(report.steps.length, 4, '中止点之后的步骤不应出现在报告里')
  })

  it('中止点必须是失败的那个致命步骤本身', async () => {
    for (const id of ['open-database', 'run-migrations', 'register-media-protocol', 'register-ipc-handlers'] as BootStepId[]) {
      const report = await runBootSequence({
        steps: BOOT_STEPS,
        handlers: Object.fromEntries(
          BOOT_STEPS.map(s => [s.id, s.id === id ? () => { throw new Error(`fail:${id}`) } : () => void 0]),
        ),
      })
      assert.equal(report.abortedAt, id, `在 ${id} 抛错时应中止于此`)
      assert.match(report.steps.at(-1)!.error!, new RegExp(`fail:${id}`))
    }
  })

  it('非致命步骤失败会继续执行后续步骤', async () => {
    const executed: string[] = []
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(6, 10),  // 崩溃恢复 → 清理 → 模型 → ffmpeg
      handlers: {
        'recover-crashed-recordings': () => { executed.push('recover') },
        'cleanup-temp-and-cache': () => { executed.push('cleanup'); throw new Error('EACCES') },
        'verify-models': () => { executed.push('models') },
        'detect-ffmpeg': () => { executed.push('ffmpeg') },
      },
    })

    assert.deepEqual(executed, ['recover', 'cleanup', 'models', 'ffmpeg'], '非致命失败必须继续')
    assert.equal(report.abortedAt, null)
    assert.equal(report.steps.find(s => s.id === 'cleanup-temp-and-cache')!.ok, false)
  })

  it('把各步产出汇总进 ctx.values（后续步骤要用前序结果）', async () => {
    let seen: unknown = null
    await runBootSequence({
      steps: BOOT_STEPS.slice(0, 3),
      handlers: {
        'single-instance-lock': () => ({ locked: true }),
        'resolve-paths': (ctx) => {
          seen = ctx.values.locked
          return { userData: 'C:/u' }
        },
        'init-logger': (ctx) => {
          assert.equal(ctx.values.userData, 'C:/u')
        },
      },
    })
    assert.equal(seen, true)
  })

  it('顺序非法时拒绝执行（宁可不起，也不带病启动）', async () => {
    const bad: BootStep[] = [
      { id: 'cleanup-temp-and-cache', label: 'x', blocking: false, fatalOnFailure: false, rationale: 'test' },
      { id: 'recover-crashed-recordings', label: 'y', blocking: true, fatalOnFailure: false, rationale: 'test' },
    ]
    let anyRun = false
    const report = await runBootSequence({
      steps: bad,
      handlers: { 'cleanup-temp-and-cache': () => { anyRun = true }, 'recover-crashed-recordings': () => { anyRun = true } },
    })
    assert.equal(anyRun, false)
    assert.match(report.steps[0]!.error!, /启动顺序校验失败/)
  })

  it('每步记录耗时', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 2),
      handlers: {
        'single-instance-lock': () => void 0,
        'resolve-paths': async () => { await new Promise(r => setTimeout(r, 5)) },
      },
    })
    const paths = report.steps.find(s => s.id === 'resolve-paths')!
    assert.ok(paths.elapsedMs >= 4, `耗时应被记录，实际 ${paths.elapsedMs}ms`)
  })

  // -------------------------------------------------------------------------
  // 降级状态（docs/91 §5.2.1 / §8）：迁移失败进只读时报告不能显示 [ok]
  // -------------------------------------------------------------------------
  it('步骤返回 readOnly 时标成降级，而不是伪装成 [ok]', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 5),
      handlers: {
        'single-instance-lock': () => void 0,
        'resolve-paths': () => void 0,
        'init-logger': () => void 0,
        'open-database': () => void 0,
        // 这就是 run-migrations 在迁移失败时的真实返回形状
        'run-migrations': () => ({ readOnly: true, reason: 'DB_MIGRATION_FAILED' }),
      },
    })
    const step = report.steps.find(s => s.id === 'run-migrations')!
    assert.equal(step.ok, true, '步骤本身没抛错，ok 仍为 true')
    assert.equal(step.degraded, true, '迁移失败进只读必须被标成降级')
    assert.match(step.degradedReason ?? '', /DB_MIGRATION_FAILED/)
    assert.equal(report.abortedAt, null, '降级不是中止')
  })

  it('步骤可用显式 degraded 标记降级并给出原因', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 2),
      handlers: {
        'single-instance-lock': () => void 0,
        'resolve-paths': () => ({ degraded: true, degradedReason: '磁盘只读' }),
      },
    })
    const step = report.steps.find(s => s.id === 'resolve-paths')!
    assert.equal(step.ok, true)
    assert.equal(step.degraded, true)
    assert.equal(step.degradedReason, '磁盘只读')
  })

  it('正常步骤不带降级标记', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 1),
      handlers: { 'single-instance-lock': () => ({ hasLock: true }) },
    })
    assert.equal(report.steps[0]!.degraded, undefined)
    assert.equal(report.steps[0]!.degradedReason, undefined)
  })
})

describe('启动报告格式', () => {
  it('每步一行，便于 grep', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 3),
      handlers: {
        'single-instance-lock': () => void 0,
        'init-logger': () => { throw new Error('disk full') },
      },
    })
    const lines = formatBootReport(report)
    assert.ok(lines[0]!.includes('启动耗时'))
    assert.ok(lines.some(l => l.includes('[ok  ]') && l.includes('single-instance-lock')))
    assert.ok(lines.some(l => l.includes('[skip]')))
    assert.ok(lines.some(l => l.includes('[FAIL]') && l.includes('disk full')))
  })

  it('中止时在报告里明确标出', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 5),
      handlers: {
        'single-instance-lock': () => void 0,
        'resolve-paths': () => void 0,
        'init-logger': () => void 0,
        'open-database': () => { throw new Error('boom') },
      },
    })
    const lines = formatBootReport(report)
    assert.ok(lines.some(l => l.includes('启动在中止于：open-database')))
  })

  it('降级步骤显示成 [DEGR] 并带原因，不再伪装成 [ok  ]', async () => {
    const report = await runBootSequence({
      steps: BOOT_STEPS.slice(0, 5),
      handlers: {
        'single-instance-lock': () => void 0,
        'resolve-paths': () => void 0,
        'init-logger': () => void 0,
        'open-database': () => void 0,
        'run-migrations': () => ({
          readOnly: true,
          reason: 'DB_MIGRATION_FAILED',
          degraded: true,
          degradedReason: '迁移失败，已进入只读模式：DB_MIGRATION_FAILED',
        }),
      },
    })
    const lines = formatBootReport(report)
    const line = lines.find(l => l.includes('run-migrations'))!
    assert.ok(line.includes('[DEGR]'), `降级必须是独立状态，实际：${line}`)
    assert.ok(line.includes('只读'), `应带降级原因，实际：${line}`)
    assert.ok(!line.includes('[ok  ]'), '降级不能显示成普通成功')
    // 其余正常步骤仍是 [ok  ]
    assert.ok(lines.some(l => l.includes('[ok  ]') && l.includes('open-database')))
  })
})
