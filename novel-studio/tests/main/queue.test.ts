/**
 * 测试 · 任务队列（src/main/infra/queue）
 * ============================================================================
 * 设计依据：docs/04 §2.2 —— 下面每一条都是文档里写死的语义，不是「实现细节」：
 *   · 优先级：用户交互触发 = 0，后台维护 = 100；越小越先
 *   · 并发控制：每个 concurrencyKey 独立上限（ffmpeg: min(4,cores-1)、whisper: 1、
 *     embedding: 1、db-write: 1）
 *   · 幂等：同 dedupeKey 的活动任务直接返回已有 taskId
 *   · 取消：AbortController 贯穿；取消不是失败（状态必须是 cancelled）
 *   · 重试：仅 retryable 错误；指数退避 1s → 4s；attempts 递增
 *   · 进度：节流到 ≤10 次/秒
 *   · 持久化：启动时把 running/waiting 标记为 interrupted
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AppError } from '../../src/shared/errors.ts'
import type { TaskRecord } from '../../src/shared/types.ts'
import { createMemoryTaskStore } from '../../src/main/infra/queue/store.ts'
import { ProgressThrottle, TaskQueue, defaultConcurrencyCaps } from '../../src/main/infra/queue/queue.ts'
import type { TaskProgressEvent, TaskSpec } from '../../src/main/infra/queue/types.ts'

// ---------------------------------------------------------------------------
// 工具：所有测试都注入假的临时目录与 sleep，避免真的碰磁盘/真的等待
// ---------------------------------------------------------------------------

interface HarnessOptions {
  caps?: Record<string, number>
  maxConcurrent?: number
  maxQueueSize?: number
  retryDelaysMs?: readonly number[]
  progressIntervalMs?: number
  now?: () => number
  store?: ReturnType<typeof createMemoryTaskStore>
  cores?: number
}

/**
 * 创建测试用队列。
 *
 * 调用约定（**必须按顺序**）：
 *   createHarness()                              // 不传参数，用默认集合
 *   createHarness([spec1, spec2])                // 只给 specs
 *   createHarness([], { retryDelaysMs: [...] })  // specs + 选项
 *
 * 早期有 4 处调用写成了 `createHarness([], { retryDelaysMs: [...] })`（把选项放在第一位），
 * 导致 `specs` 收到对象、队列构造抛 `opts.specs is not iterable`。那 4 处已按本约定改正；
 * 这里刻意**不做运行时参数归一**，让类型检查替我们挡住同类错误。
 */
function createHarness(
  specs: unknown[] = [],
  options: HarnessOptions = {},
): {
  queue: TaskQueue
  sleeps: number[]
  progress: TaskProgressEvent[]
  finished: Array<{ taskId: string; status: string }>
  tempDirs: string[]
  removedDirs: string[]
} {
  const sleeps: number[] = []
  const progress: TaskProgressEvent[] = []
  const finished: Array<{ taskId: string; status: string }> = []
  const tempDirs: string[] = []
  const removedDirs: string[] = []
  let clock = 0
  const now = options.now ?? (() => (clock += 1))

  const queue = new TaskQueue({
    ...options,
    specs: specs as never,
    store: options.store ?? createMemoryTaskStore(),
    now,
    caps: options.caps,
    maxConcurrent: options.maxConcurrent,
    maxQueueSize: options.maxQueueSize,
    retryDelaysMs: options.retryDelaysMs,
    progressIntervalMs: options.progressIntervalMs,
    // 只记录等待时长，不真的 sleep（否则测试会慢一个数量级）
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    makeId: (() => {
      let n = 0
      return () => `task-${++n}`
    })(),
    makeTempDir: async (taskId: string) => {
      const dir = `mem-tmp/${taskId}`
      tempDirs.push(dir)
      return dir
    },
    removeTempDir: async (dir: string) => {
      removedDirs.push(dir)
    },
    events: {
      progress: (e) => progress.push(e),
      finished: (e) => finished.push({ taskId: e.taskId, status: e.status }),
    },
  })

  return { queue, sleeps, progress, finished, tempDirs, removedDirs }
}

/** 让调度器推进到没有待处理任务（setImmediate 轮询，避免依赖固定时长） */
async function drain(queue: TaskQueue, maxRounds = 200): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    await new Promise<void>((r) => setImmediate(r))
    const s = queue.stats()
    if (s.running === 0 && s.pending === 0 && s.backoff === 0) return
  }
}

describe('优先级与调度顺序', () => {
  it('同并发键内按优先级升序执行（0 → 50 → 100）', async () => {
    const order: string[] = []
    const make = (kind: string, priority: number) => ({
      kind,
      concurrencyKey: 'db-write',
      priority,
      run: async () => {
        order.push(kind)
        // 让出一次事件循环，确保「同时可调度」这个前提成立
        await new Promise<void>((r) => setTimeout(r, 1))
        return kind
      },
    })
    const q = new TaskQueue({
      specs: [make('low', 100), make('high', 0), make('mid', 50)] as never,
      caps: { 'db-write': 1 },
      makeTempDir: async () => 'mem-tmp/x',
      removeTempDir: async () => undefined,
    })
    await q.start()
    // 一次性入队，避免调度器在入队间隙先跑掉高优先级任务造成假阳性
    await Promise.all([q.enqueue('low', {}), q.enqueue('high', {}), q.enqueue('mid', {})])
    await q.whenIdle()
    assert.deepEqual(order, ['high', 'mid', 'low'])
  })

  it('被并发上限挡住的任务标记为 waiting（UI 可见「排队中」）', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    const q = new TaskQueue({
      specs: [
        {
          kind: 'audio.render',
          concurrencyKey: 'ffmpeg',
          run: async () => {
            await gate
          },
        },
      ] as TaskSpec[],
      caps: { ffmpeg: 1 },
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const first = await q.enqueue('audio.render', {})
    const second = await q.enqueue('audio.render', {})
    await drain(q, 5)
    assert.equal((await q.get(second.taskId))?.status, 'waiting')
    assert.equal(q.stats().running, 1)
    ;(release as (() => void) | null)?.()
    await q.whenIdle()
    assert.equal((await q.get(first.taskId))?.status, 'succeeded')
    assert.equal((await q.get(second.taskId))?.status, 'succeeded')
  })

  it('默认并发上限符合 docs/04 §2.2（whisper/embedding/db-write 为 1，ffmpeg 为 min(4, cores-1)）', () => {
    const caps = defaultConcurrencyCaps(8)
    assert.equal(caps.whisper, 1)
    assert.equal(caps.embedding, 1)
    assert.equal(caps['db-write'], 1)
    assert.equal(caps.ffmpeg, 4)
    assert.equal(defaultConcurrencyCaps(2).ffmpeg, 1)
    assert.equal(defaultConcurrencyCaps(16).ffmpeg, 4)
  })
})

describe('concurrencyKey 互斥', () => {
  it('同 key 串行、不同 key 并行', async () => {
    let activeFfmpeg = 0
    let maxFfmpeg = 0
    let activeEmbedding = 0
    let maxEmbedding = 0
    const q = new TaskQueue({
      specs: [
        {
          kind: 'audio.process',
          concurrencyKey: 'ffmpeg',
          run: async () => {
            activeFfmpeg++
            maxFfmpeg = Math.max(maxFfmpeg, activeFfmpeg)
            await new Promise<void>((r) => setTimeout(r, 5))
            activeFfmpeg--
          },
        },
        {
          kind: 'embedding.batch',
          concurrencyKey: 'embedding',
          run: async () => {
            activeEmbedding++
            maxEmbedding = Math.max(maxEmbedding, activeEmbedding)
            await new Promise<void>((r) => setTimeout(r, 5))
            activeEmbedding--
          },
        },
      ] as TaskSpec[],
      caps: { ffmpeg: 1, embedding: 1 },
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    await q.enqueue('audio.process', {})
    await q.enqueue('audio.process', {})
    await q.enqueue('embedding.batch', {})
    await q.whenIdle()
    assert.equal(maxFfmpeg, 1, 'ffmpeg 键上限为 1 时不得并发')
    assert.equal(maxEmbedding, 1)
  })

  it('不同 key 之间不互相阻塞（work-conserving）', async () => {
    let releaseA: (() => void) | null = null
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    let bRan = false
    const q = new TaskQueue({
      specs: [
        { kind: 'audio.render', concurrencyKey: 'ffmpeg', run: async () => { await gateA } },
        { kind: 'book.import', concurrencyKey: 'db-write', run: async () => { bRan = true } },
      ] as TaskSpec[],
      caps: { ffmpeg: 1, 'db-write': 1 },
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    await q.enqueue('audio.render', {})
    await q.enqueue('book.import', {})
    await drain(q, 10)
    assert.equal(bRan, true, 'ffmpeg 被占满不能让 db-write 任务饿死')
    ;(releaseA as (() => void) | null)?.()
    await q.whenIdle()
  })
})

describe('dedupeKey 幂等', () => {
  it('同 key 的第二次提交返回同一个 taskId，且不新建任务', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    const q = new TaskQueue({
      specs: [
        {
          kind: 'audio.process',
          dedupeKey: (payload: unknown) => `audio.process:${(payload as { segmentId: string }).segmentId}:hash1`,
          run: async () => {
            await gate
          },
        },
      ] as TaskSpec[],
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const first = await q.enqueue('audio.process', { segmentId: 's1' })
    const second = await q.enqueue('audio.process', { segmentId: 's1' })
    assert.equal(second.taskId, first.taskId)
    assert.equal(second.deduped, true)
    assert.equal(first.deduped, false)
    assert.equal((await q.list()).length, 1, '幂等命中时不得新建任务记录')

    // 载荷不同（dedupeKey 不同）→ 新任务
    const third = await q.enqueue('audio.process', { segmentId: 's2' })
    assert.equal(third.deduped, false)
    assert.notEqual(third.taskId, first.taskId)

    ;(release as (() => void) | null)?.()
    await q.whenIdle()
    // 终态之后同 key 再提交 → 允许重跑（新 taskId）
    const fourth = await q.enqueue('audio.process', { segmentId: 's1' })
    assert.equal(fourth.deduped, false)
    assert.notEqual(fourth.taskId, first.taskId)
    await q.whenIdle()
  })

  it('显式 dedupeKey 也可以由调用方提供', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    const q = new TaskQueue({
      specs: [{ kind: 'cache.clean', run: async () => { await gate } }] as never,
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const a = await q.enqueue('cache.clean', {}, { dedupeKey: 'clean-1' })
    const b = await q.enqueue('cache.clean', {}, { dedupeKey: 'clean-1' })
    assert.equal(a.taskId, b.taskId)
    assert.equal(b.deduped, true)
    ;(release as (() => void) | null)?.()
    await q.whenIdle()
  })
})

describe('取消', () => {
  it('取消运行中的任务：signal.aborted 生效且状态为 cancelled（不是 failed）', async () => {
    const harness = createHarness()
    const { queue } = harness
    let sawAborted = false
    const q = new TaskQueue({
      specs: [
        {
          kind: 'asr.transcribe',
          concurrencyKey: 'whisper',
          run: async (ctx) => {
            for (let i = 0; i < 200; i++) {
              if (ctx.isAborted()) sawAborted = true
              ctx.throwIfAborted()
              await new Promise<void>((r) => setTimeout(r, 1))
            }
          },
        },
      ] as TaskSpec[],
      caps: { whisper: 1 },
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('asr.transcribe', {})
    await new Promise<void>((r) => setTimeout(r, 6))
    const accepted = await q.cancel(taskId)
    assert.equal(accepted, true)
    const rec = await q.waitFor(taskId)
    assert.equal(rec.status, 'cancelled')
    assert.equal(sawAborted, true, '任务体内必须能观察到 abort')
    assert.equal(rec.finishedAt !== null, true)
    void queue
  })

  it('取消排队中的任务：立即 cancelled，且不会被执行', async () => {
    let ran = false
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    const q = new TaskQueue({
      specs: [
        { kind: 'audio.render', concurrencyKey: 'ffmpeg', run: async () => { await gate } },
        { kind: 'audio.process', concurrencyKey: 'ffmpeg', run: async () => { ran = true } },
      ] as TaskSpec[],
      caps: { ffmpeg: 1 },
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    await q.enqueue('audio.render', {})
    const second = await q.enqueue('audio.process', {})
    await q.cancel(second.taskId)
    assert.equal((await q.get(second.taskId))?.status, 'cancelled')
    ;(release as (() => void) | null)?.()
    await q.whenIdle()
    assert.equal(ran, false, '已取消的任务不得被执行')
  })

  it('取消终态任务返回 false（幂等，不抛错）；未知任务抛 TASK_NOT_FOUND', async () => {
    const { queue } = createHarness()
    const q = new TaskQueue({
      specs: [{ kind: 'cache.clean', run: async () => 1 }] as never,
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('cache.clean', {})
    await q.whenIdle()
    assert.equal(await q.cancel(taskId), false)
    await assert.rejects(
      () => q.cancel('不存在'),
      (e: unknown) => e instanceof AppError && e.key === 'TASK_NOT_FOUND',
    )
    void queue
  })

  it('cancel 会触发任务自带的 onCancel 清理钩子（且钩子抛错不影响取消结果）', async () => {
    let cleaned = false
    const q = new TaskQueue({
      specs: [
        {
          kind: 'audio.render',
          run: async (ctx) => {
            for (let i = 0; i < 100; i++) {
              ctx.throwIfAborted()
              await new Promise<void>((r) => setTimeout(r, 1))
            }
          },
          onCancel: () => {
            cleaned = true
            throw new Error('清理失败也不该影响状态')
          },
        },
      ] as TaskSpec[],
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('audio.render', {})
    await new Promise<void>((r) => setTimeout(r, 4))
    await q.cancel(taskId)
    const rec = await q.waitFor(taskId)
    assert.equal(rec.status, 'cancelled')
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(cleaned, true)
  })
})

describe('重试与退避', () => {
  it('retryable 错误：退避 1s → 4s，attempts 递增，最终 failed 且带序列化错误', async () => {
    let attempts = 0
    const harness = createHarness([], { retryDelaysMs: [1000, 4000] })
    const q = new TaskQueue({
      specs: [
        {
          kind: 'asr.transcribe',
          maxAttempts: 3,
          run: async () => {
            attempts++
            // 可重试错误（PROVIDER_TIMEOUT 在消息表里 retryable: true）
            throw new AppError('PROVIDER_TIMEOUT')
          },
        },
      ] as TaskSpec[],
      retryDelaysMs: [1000, 4000],
      sleep: async (ms) => {
        harness.sleeps.push(ms)
      },
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('asr.transcribe', {})
    await q.waitFor(taskId)
    assert.equal(attempts, 3, 'maxAttempts=3 时应执行 3 次')
    assert.deepEqual(harness.sleeps, [1000, 4000], '退避序列必须是 1s → 4s')
    const rec = (await q.get(taskId)) as TaskRecord
    assert.equal(rec.status, 'failed')
    assert.equal(rec.attempts, 3)
    const error = JSON.parse(rec.error as string) as { code: string; severity: string; retryable: boolean }
    assert.equal(error.code, 'PROVIDER_TIMEOUT')
    assert.equal(error.retryable, true)
    assert.ok(rec.stage, '失败原因应落到 stage，便于 UI 列表直接展示')
  })

  it('不可重试错误（INVALID_PAYLOAD）不重试，attempts 保持 1', async () => {
    const harness = createHarness()
    let attempts = 0
    const q = new TaskQueue({
      specs: [
        {
          kind: 'book.import',
          maxAttempts: 3,
          run: async () => {
            attempts++
            throw new AppError('INVALID_PAYLOAD')
          },
        },
      ] as TaskSpec[],
      sleep: async (ms) => {
        harness.sleeps.push(ms)
      },
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('book.import', {})
    const rec = await q.waitFor(taskId)
    assert.equal(attempts, 1)
    assert.deepEqual(harness.sleeps, [], '不可重试错误不应进入退避')
    assert.equal(rec.status, 'failed')
    assert.equal(rec.attempts, 1)
  })

  it('首次失败、第二次成功（重试确实会重新执行任务体）', async () => {
    let n = 0
    const q = new TaskQueue({
      specs: [
        {
          kind: 'cache.clean',
          maxAttempts: 2,
          run: async () => {
            n++
            if (n === 1) throw new AppError('DB_BUSY')
            return { ok: true }
          },
        },
      ] as TaskSpec[],
      sleep: async () => undefined,
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('cache.clean', {})
    const rec = await q.waitFor(taskId)
    assert.equal(rec.status, 'succeeded')
    assert.equal(rec.attempts, 2)
    assert.deepEqual(rec.result, { ok: true })
  })

  it('task:retry 语义：重试未落库 payload 的任务时明确抛错，而不是静默不动', async () => {
    const q = new TaskQueue({
      specs: [{ kind: 'cache.clean', run: async () => 1 }] as never,
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('cache.clean', {})
    await q.whenIdle()
    const newId = await q.retry(taskId)
    assert.notEqual(newId, taskId)
    await q.whenIdle()
    assert.equal((await q.get(newId))?.status, 'succeeded')

    await assert.rejects(
      () => q.retry('不存在'),
      (e: unknown) => e instanceof AppError && e.key === 'TASK_NOT_FOUND',
    )
  })
})

describe('进度节流（≤ 10 次/秒）', () => {
  it('1 秒内 report 100 次，最多发出 10 次进度事件', async () => {
    const progress: TaskProgressEvent[] = []
    let clock = 0
    const q = new TaskQueue({
      specs: [
        {
          kind: 'book.import',
          run: async (ctx) => {
            for (let i = 0; i < 100; i++) {
              ctx.report(i / 100, `第 ${i} 章`)
              clock += 10 // 每次上报间隔 10ms → 整段跨度 1000ms
            }
            return 'done'
          },
        },
      ] as TaskSpec[],
      now: () => clock,
      progressIntervalMs: 100,
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
      events: { progress: (e) => progress.push(e), finished: () => undefined },
    })
    await q.start()
    const { taskId } = await q.enqueue('book.import', {})
    await q.waitFor(taskId)
    // 节流窗口 100ms：t=0,100,...,900 共 10 次；完成时补发终态 1 次
    const duringRun = progress.filter((p) => p.progress < 1)
    assert.ok(duringRun.length <= 10, `1 秒内发出 ${duringRun.length} 次，超过 10 次`)
    assert.equal(duringRun.length, 10)
    const last = progress[progress.length - 1]
    assert.equal(last?.progress, 1, '终态必须补发一次，保证 UI 不会停在 90%')
    assert.equal(last?.kind, 'book.import')
  })

  it('ProgressThrottle 独立行为：窗口内只放行一次，窗口外再放行', () => {
    const t = new ProgressThrottle(100)
    assert.equal(t.tryAcquire(0), true)
    for (const now of [1, 9, 50, 99]) assert.equal(t.tryAcquire(now), false)
    assert.equal(t.droppedCount, 4, '被丢弃的次数要能统计（诊断用）')
    assert.equal(t.tryAcquire(100), true)
    assert.equal(t.droppedCount, 0, '放行后丢弃计数清零')
  })
})

describe('启动恢复：running/waiting → interrupted', () => {
  it('start() 会把上次遗留的 running/waiting 标记为 interrupted', async () => {
    const store = createMemoryTaskStore([
      {
        id: 'old-running', kind: 'export.book', status: 'running', priority: 0, projectId: null,
        progress: 0.4, stage: '渲染中', result: null, error: null, attempts: 1, maxAttempts: 1,
        concurrencyKey: 'ffmpeg', dedupeKey: null, createdAt: 1, startedAt: 2, finishedAt: null,
      },
      {
        id: 'old-waiting', kind: 'canvas.generate', status: 'waiting', priority: 50, projectId: 'p1',
        progress: 0, stage: null, result: null, error: null, attempts: 0, maxAttempts: 1,
        concurrencyKey: 'db-write', dedupeKey: null, createdAt: 3, startedAt: null, finishedAt: null,
      },
      {
        id: 'old-done', kind: 'cache.clean', status: 'succeeded', priority: 100, projectId: null,
        progress: 1, stage: '完成', result: '{}', error: null, attempts: 1, maxAttempts: 1,
        concurrencyKey: null, dedupeKey: null, createdAt: 4, startedAt: 4, finishedAt: 9,
      },
    ])
    const q = new TaskQueue({
      specs: [{ kind: 'cache.clean', run: async () => 1 }] as never,
      store,
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    const { interrupted } = await q.start()
    assert.equal(interrupted, 2)
    assert.equal((await q.get('old-running'))?.status, 'interrupted')
    assert.equal((await q.get('old-waiting'))?.status, 'interrupted')
    assert.equal((await q.get('old-done'))?.status, 'succeeded', '终态不能被改动')
    assert.ok((await q.get('old-running'))?.finishedAt !== null)
  })
})

describe('队列边界与查询', () => {
  it('未知任务类型抛 NOT_IMPLEMENTED（而不是静默排队）', async () => {
    const q = new TaskQueue({ specs: [] as never, makeTempDir: async () => 'd', removeTempDir: async () => undefined })
    await q.start()
    await assert.rejects(
      () => q.enqueue('不存在的类型', {}),
      (e: unknown) => e instanceof AppError && e.key === 'NOT_IMPLEMENTED',
    )
  })

  it('队列满抛 TASK_QUEUE_FULL', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    const q = new TaskQueue({
      specs: [{ kind: 'audio.render', concurrencyKey: 'ffmpeg', run: async () => { await gate } }] as never,
      caps: { ffmpeg: 1 },
      maxQueueSize: 2,
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    await q.enqueue('audio.render', {})
    await q.enqueue('audio.render', {})
    await assert.rejects(
      () => q.enqueue('audio.render', {}),
      (e: unknown) => e instanceof AppError && e.key === 'TASK_QUEUE_FULL',
    )
    ;(release as (() => void) | null)?.()
    await q.whenIdle()
  })

  it('list 支持按状态/类型过滤与 limit；clearFinished 只清终态', async () => {
    const q = new TaskQueue({
      specs: [
        { kind: 'cache.clean', run: async () => 1 },
        { kind: 'book.import', run: async () => 2 },
      ] as TaskSpec[],
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    await q.enqueue('cache.clean', {})
    await q.enqueue('book.import', {})
    await q.whenIdle()
    assert.equal((await q.list()).length, 2)
    assert.equal((await q.list({ kind: ['book.import'] })).length, 1)
    assert.equal((await q.list({ status: ['succeeded'] })).length, 2)
    assert.equal((await q.list({ limit: 1 })).length, 1)
    const cleared = await q.clearFinished()
    assert.equal(cleared, 2)
    assert.equal((await q.list()).length, 0)
  })

  it('result：成功可取结果；未成功抛 TASK_FAILED；不存在抛 TASK_NOT_FOUND', async () => {
    const q = new TaskQueue({
      specs: [
        { kind: 'cache.clean', run: async () => ({ cleaned: 7 }) },
        { kind: 'book.import', run: async () => { throw new AppError('FILE_NOT_FOUND') } },
      ] as TaskSpec[],
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const a = await q.enqueue('cache.clean', {})
    const b = await q.enqueue('book.import', {})
    await q.whenIdle()
    assert.deepEqual(await q.result(a.taskId), { cleaned: 7 })
    await assert.rejects(
      () => q.result(b.taskId),
      (e: unknown) => e instanceof AppError && e.key === 'TASK_FAILED',
    )
    await assert.rejects(
      () => q.result('nope'),
      (e: unknown) => e instanceof AppError && e.key === 'TASK_NOT_FOUND',
    )
  })

  it('任务临时目录在结束后被清理（成功与失败都一样）', async () => {
    const created: string[] = []
    const removed: string[] = []
    const q = new TaskQueue({
      specs: [
        { kind: 'cache.clean', run: async () => 1 },
        { kind: 'book.import', run: async () => { throw new AppError('FILE_NOT_FOUND') } },
      ] as TaskSpec[],
      makeTempDir: async (id) => {
        created.push(id)
        return `tmp/${id}`
      },
      removeTempDir: async (dir) => {
        removed.push(dir)
      },
    })
    await q.start()
    await q.enqueue('cache.clean', {})
    await q.enqueue('book.import', {})
    await q.whenIdle()
    assert.equal(created.length, 2)
    assert.equal(removed.length, 2, '成功与失败都要清理临时目录')
  })

  it('dispose() 取消在跑任务并清空队列（应用退出路径）', async () => {
    const q = new TaskQueue({
      specs: [
        {
          kind: 'audio.render',
          run: async (ctx) => {
            for (let i = 0; i < 100; i++) {
              ctx.throwIfAborted()
              await new Promise<void>((r) => setTimeout(r, 1))
            }
          },
        },
      ] as TaskSpec[],
      makeTempDir: async () => 'd',
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('audio.render', {})
    await new Promise<void>((r) => setTimeout(r, 4))
    await q.dispose('app-quit')
    const rec = await q.get(taskId)
    assert.equal(rec?.status, 'cancelled')
    await assert.rejects(
      () => q.enqueue('audio.render', {}),
      (e: unknown) => e instanceof AppError && e.key === 'TASK_FAILED',
    )
  })
})

describe('上下文（TaskContext）', () => {
  it('提供 taskId / kind / attempt / signal / tempDir，并记录日志', async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    let seen: Record<string, unknown> = {}
    const q = new TaskQueue({
      specs: [
        {
          kind: 'book.import',
          run: async (ctx) => {
            seen = {
              taskId: ctx.taskId,
              kind: ctx.kind,
              attempt: ctx.attempt,
              hasSignal: ctx.signal instanceof AbortSignal,
              tempDir: ctx.tempDir,
              projectId: ctx.projectId,
              aborted: ctx.isAborted(),
            }
            ctx.log('book.import.step', { step: 'parse' })
            return 1
          },
        },
      ] as TaskSpec[],
      log: {
        info: (event, fields) => logs.push({ event, fields }),
        warn: () => undefined,
        error: () => undefined,
      },
      makeTempDir: async (id) => `tmp/${id}`,
      removeTempDir: async () => undefined,
    })
    await q.start()
    const { taskId } = await q.enqueue('book.import', {}, { projectId: 'p1' })
    await q.waitFor(taskId)
    assert.equal(seen.taskId, taskId)
    assert.equal(seen.kind, 'book.import')
    assert.equal(seen.attempt, 1)
    assert.equal(seen.hasSignal, true)
    assert.equal(seen.tempDir, `tmp/${taskId}`)
    assert.equal(seen.projectId, 'p1')
    assert.equal(seen.aborted, false)
    assert.ok(logs.some((l) => l.event === 'task.enqueued'))
    assert.ok(logs.some((l) => l.event === 'task.started'))
    assert.ok(logs.some((l) => l.event === 'book.import.step' && l.fields.taskId === taskId))
    assert.ok(logs.some((l) => l.event === 'task.succeeded'))
  })
})
