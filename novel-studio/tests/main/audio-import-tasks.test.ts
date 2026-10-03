/**
 * 测试 · 按说话人导入音频的**后台任务**（`import.tasks.ts`）
 * ============================================================================
 * 真机需求：「我需要这个导入变为后台的一个任务，成品出来的速度慢点没事」。
 *
 * 这里钉住四件事（都是「改了不会报错、只会在真机上表现成怪事」的地方）：
 *   1. 入队用**固定 kind**（写错字符串 → 队列找不到规格，任务永远不跑）；
 *   2. `dedupeKey` 按书去重（重复点导入不能排队跑两遍 —— 那是重复写 take 的根源）；
 *   3. `run` 把**每个文件**的进度报出去（否则进度条永远是 0%）；
 *   4. 取消信号透传给服务层，且 `maxAttempts === 1`（写库不幂等，不自动重试）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  AUDIO_IMPORT_TASK_KIND,
  createAudioImportTasks,
  type AudioImportTaskPayload,
} from '../../src/main/features/audio/import.tasks.ts'
import type { AudioImportService } from '../../src/main/features/audio/import.service.ts'
import type { TaskContext, TaskSpec } from '../../src/main/infra/queue/types.ts'
import type { AudioImportApplyResult } from '../../src/shared/types.ts'

const PAYLOAD: AudioImportTaskPayload = {
  projectId: 'p1',
  bookId: 'b1',
  files: [{ filePath: 'C:/a.mp3' }, { filePath: 'C:/b.mp3' }],
  onlyFiles: ['a.mp3'],
}

function emptyResult(): AudioImportApplyResult {
  return {
    files: 0,
    createdTakes: 0,
    createdSegments: 0,
    markedRecorded: 0,
    skipped: [],
    perFile: [],
  } as unknown as AudioImportApplyResult
}

function makeHarness(overrides: { service?: Partial<AudioImportService> } = {}) {
  const enqueued: Array<{ kind: string; payload: unknown; opts: Record<string, unknown> }> = []
  const applied: Array<Record<string, unknown>> = []
  const progress: Array<{ ratio: number; stage: string }> = []

  const service = {
    applyImport: async (input: Record<string, unknown>) => {
      applied.push(input)
      const onProgress = input.onProgress as
        | ((d: number, t: number, f: string, phase: 'copy' | 'split' | 'write') => void)
        | undefined
      // 与真实服务同序：copy → split → write（每个文件三次）
      for (const [done, name] of [[1, 'a.mp3'], [2, 'b.mp3']] as Array<[number, string]>) {
        onProgress?.(done, 2, name, 'copy')
        onProgress?.(done, 2, name, 'split')
        onProgress?.(done, 2, name, 'write')
      }
      return emptyResult()
    },
    ...overrides.service,
  } as unknown as AudioImportService

  const queue = {
    enqueue: async (kind: string, payload: unknown, opts: Record<string, unknown>) => {
      enqueued.push({ kind, payload, opts })
      return { taskId: 'task-1', deduped: false }
    },
    registerSpec: () => undefined,
  }

  const tasks = createAudioImportTasks({
    service,
    queue: queue as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })

  const ctx = {
    taskId: 'task-1',
    kind: AUDIO_IMPORT_TASK_KIND,
    projectId: 'b1',
    attempt: 1,
    signal: new AbortController().signal,
    tempDir: 'C:/tmp',
    report: (ratio: number, stage?: string) => progress.push({ ratio, stage: stage ?? '' }),
    throwIfAborted: () => undefined,
    isAborted: () => false,
    log: () => undefined,
  } as unknown as TaskContext

  const spec = tasks.taskSpecs()[0] as TaskSpec<AudioImportTaskPayload, AudioImportApplyResult>
  return { tasks, enqueued, applied, progress, queue, ctx, spec }
}

describe('导入任务：入队', () => {
  it('用固定 kind + 按「书 + 批次指纹」去重', async () => {
    const h = makeHarness()
    const res = await h.tasks.enqueueApply(PAYLOAD)
    assert.equal(res.taskId, 'task-1')
    assert.equal(h.enqueued.length, 1)
    assert.equal(h.enqueued[0]!.kind, AUDIO_IMPORT_TASK_KIND)
    assert.equal(h.enqueued[0]!.kind, 'audioImport.apply')
    assert.equal(h.enqueued[0]!.opts.projectId, 'b1')
    const key = String(h.enqueued[0]!.opts.dedupeKey)
    assert.ok(key.startsWith('audioImport.apply:b1:'), `去重键要带上批次指纹：${key}`)
  })

  /**
   * 真机需求：「导入一批可以继续导入」。
   *
   * 去重键如果只按书（`audioImport.apply:{bookId}`），那么「上一批还在跑、用户改了勾选
   * 再点导入」会命中同一条活动任务 —— 新选的文件**一个都不会导**，界面还是那条旧任务。
   */
  it('同一批连点两次 → 同样的去重键（幂等）', async () => {
    const a = makeHarness()
    const b = makeHarness()
    await a.tasks.enqueueApply(PAYLOAD)
    await b.tasks.enqueueApply({ ...PAYLOAD, files: [...PAYLOAD.files] })
    assert.equal(a.enqueued[0]!.opts.dedupeKey, b.enqueued[0]!.opts.dedupeKey,
      '文件名集合相同（顺序不同）应当视为同一批')
  })

  it('换了一批文件 → 不同的去重键（能排队继续导入）', async () => {
    const a = makeHarness()
    const b = makeHarness()
    await a.tasks.enqueueApply(PAYLOAD)
    await b.tasks.enqueueApply({ ...PAYLOAD, files: [{ filePath: 'C:/c.mp3' }], onlyFiles: ['c.mp3'] })
    assert.notEqual(a.enqueued[0]!.opts.dedupeKey, b.enqueued[0]!.opts.dedupeKey,
      '换了一批文件必须新建任务，否则新选的文件会被运行中的旧任务吞掉')
  })

  it('没有文件就不入队（空任务只会污染任务中心）', async () => {
    const h = makeHarness()
    await assert.rejects(() => h.tasks.enqueueApply({ ...PAYLOAD, files: [] }))
    assert.equal(h.enqueued.length, 0)
  })

  it('没有队列时明确报 TASK_QUEUE_UNAVAILABLE（与画本域同一降级口径）', async () => {
    const service = { applyImport: async () => emptyResult() } as unknown as AudioImportService
    const tasks = createAudioImportTasks({
      service,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    await assert.rejects
      (() => tasks.enqueueApply(PAYLOAD),
      (e: unknown) => (e as { key?: string }).key === 'TASK_QUEUE_UNAVAILABLE')
  })
})

describe('导入任务：执行', () => {
  it('规格声明：串行并发键 + 不自动重试（写 take 不幂等）', () => {
    const h = makeHarness()
    assert.equal(h.spec.kind, 'audioImport.apply')
    assert.equal(h.spec.concurrencyKey, 'audio-import')
    assert.equal(h.spec.maxAttempts, 1)
  })

  it('逐文件 + 分阶段上报进度（否则进度条永远不动）', async () => {
    const h = makeHarness()
    await h.spec.run(h.ctx, PAYLOAD)
    // 每个文件三个阶段：copy / split / write —— 同一个文件内部也会推进两次
    assert.deepEqual(
      h.progress.map((p) => Number(p.ratio.toFixed(3))),
      [0.175, 0.4, 0.5, 0.675, 0.9, 1],
    )
    assert.match(h.progress[0]!.stage, /1\/2：a\.mp3 · 复制\/转码/)
    assert.match(h.progress[1]!.stage, /1\/2：a\.mp3 · 切句/)
    assert.match(h.progress[5]!.stage, /2\/2：b\.mp3 · 写入 take/)
  })

  it('把画本路径、onlyFiles、取消信号一起透传给服务层', async () => {
    const h = makeHarness()
    await h.spec.run(h.ctx, { ...PAYLOAD, skipNeedsReview: true })
    const input = h.applied[0]!
    assert.equal(input.projectId, 'p1')
    assert.equal(input.bookId, 'b1')
    assert.deepEqual(input.onlyFiles, ['a.mp3'])
    assert.equal(input.skipNeedsReview, true)
    assert.equal(input.signal, h.ctx.signal, '取消信号必须透传，否则任务取消后还在写库')
  })

  it('run 的返回值就是任务结果（渲染侧 task:result 直接拿它渲染结果表）', async () => {
    const h = makeHarness()
    const result = await h.spec.run(h.ctx, PAYLOAD)
    assert.deepEqual(result, emptyResult())
  })
})
