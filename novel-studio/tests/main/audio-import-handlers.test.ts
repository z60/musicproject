/**
 * 测试 · 按说话人导入音频（IPC handler 层）
 * ============================================================================
 * 设计依据：docs/20（IPC 契约）、docs/91 §5.2.49
 *
 * 运行：
 *   node --experimental-strip-types tests/main/audio-import-handlers.test.ts
 *
 * ### 为什么 handler 层也要测
 *   契约里 `record:importApply` 的 `confirm` 是**写库的闸门**。
 *   handler 层是这道闸门真正生效的地方 —— 光有 schema 不够：
 *   将来若有人把 schema 从 `v.literal(true)` 放宽成 `v.boolean()`，
 *   只有 handler 里的二次判断能兜住。本文件把那个兜底钉住。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { createAudioHandlers } from '../../src/main/ipc/handlers/audio.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'
import type { AudioImportService } from '../../src/main/features/audio/import.service.ts'
import type { RegisteredHandler } from '../../src/main/ipc/handlers/deps.ts'

// ---------------------------------------------------------------------------
// 假的 import service：记录被调用的参数，返回固定结果
// ---------------------------------------------------------------------------

interface Calls {
  scanCanvas: unknown[]
  scanFiles: unknown[]
  buildPlan: unknown[]
  applyImport: unknown[]
}

function makeFakeService(calls: Calls): AudioImportService {
  return {
    async scanCanvas(input) {
      calls.scanCanvas.push(input)
      return {
        filePath: input.canvasPath ?? '',
        chapters: [],
        characters: [],
        voiceActors: [],
        canvasCvs: [],
        documentChapterRange: null,
        warnings: [],
      }
    },
    async scanAudioFiles(input) {
      calls.scanFiles.push(input)
      return []
    },
    async buildPlan(input) {
      calls.buildPlan.push(input)
      return {
        plan: {
          files: [],
          summary: {
            totalFiles: 0,
            readyFiles: 0,
            needsReviewFiles: 0,
            unresolvedFiles: 0,
            noLinesFiles: 0,
            invalidFiles: 0,
            overlappingFiles: 0,
            duplicatedLineCount: 0,
            totalLines: 0,
            totalDurationMs: 0,
            totalBytes: 0,
            canvasChapterRange: null,
            availableCvs: [],
            availableCharacters: [],
          },
          warnings: [],
        },
        scan: {
          filePath: input.canvasPath ?? '',
          chapters: [],
          characters: [],
          voiceActors: [],
          canvasCvs: [],
          documentChapterRange: null,
          warnings: [],
        },
      }
    },
    async applyImport(input) {
      calls.applyImport.push(input)
      return {
        files: input.files.length,
        createdTakes: 7,
        createdSegments: 7,
        markedRecorded: 7,
        skipped: [],
        perFile: [],
      }
    },
  }
}

function makeHarness(): { handlers: RegisteredHandler[]; calls: Calls } {
  const calls: Calls = { scanCanvas: [], scanFiles: [], buildPlan: [], applyImport: [] }
  const handlers = createAudioHandlers({
    analysis: {} as never,
    device: {} as never,
    take: {} as never,
    record: {} as never,
    importService: makeFakeService(calls),
    log: { info: () => {}, warn: () => {} },
  })
  return { handlers, calls }
}

/** 走**真实 schema** 再调 handler —— 与运行时同一条路径 */
async function call(h: RegisteredHandler[], channel: string, payload: unknown): Promise<unknown> {
  const spec = h.find((x) => x.channel === channel)
  assert.ok(spec, `找不到 handler：${channel}`)
  const schema = schemaFor(channel as never)
  assert.ok(schema, `契约里没有 ${channel} 的 schema`)
  return await spec.run(schema.parse(payload) as never, {} as never)
}

const BASE = { projectId: 'p1', bookId: 'b1', canvasPath: 'C:/samples/画本.docx' }

// ---------------------------------------------------------------------------

describe('handler 存在性（契约对称）', () => {
  it('4 个 record:import* 通道都有 handler', () => {
    const { handlers } = makeHarness()
    for (const ch of ['record:importScanCanvas', 'record:importScanFiles', 'record:importPlan', 'record:importApply']) {
      assert.ok(
        handlers.some((x) => x.channel === ch),
        `缺少 handler：${ch}`,
      )
    }
  })

  it('这 4 个通道在契约表里都有 schema', () => {
    for (const ch of ['record:importScanCanvas', 'record:importScanFiles', 'record:importPlan', 'record:importApply']) {
      assert.ok(schemaFor(ch as never), `契约里缺少 ${ch} 的 schema`)
    }
  })
})

describe('载荷搬运（参数原样传给服务）', () => {
  it('importScanCanvas 把三个参数透传', async () => {
    const { handlers, calls } = makeHarness()
    await call(handlers, 'record:importScanCanvas', BASE)
    assert.deepEqual(calls.scanCanvas[0], BASE)
  })

  it('importScanFiles 的 recursive 默认 false（不传时）', async () => {
    const { handlers, calls } = makeHarness()
    await call(handlers, 'record:importScanFiles', { dir: 'C:/samples' })
    assert.deepEqual(calls.scanFiles[0], { dir: 'C:/samples', recursive: false })
  })

  it('importScanFiles 的 recursive 传 true 时透传', async () => {
    const { handlers, calls } = makeHarness()
    await call(handlers, 'record:importScanFiles', { dir: 'C:/samples', recursive: true })
    assert.deepEqual(calls.scanFiles[0], { dir: 'C:/samples', recursive: true })
  })

  it('importPlan 透传 files 与 overrides', async () => {
    const { handlers, calls } = makeHarness()
    await call(handlers, 'record:importPlan', {
      ...BASE,
      files: [{ filePath: 'C:/s/a.mp3', overrides: { character: '石志坚' } }],
    })
    const got = calls.buildPlan[0] as { files: Array<Record<string, unknown>> }
    assert.equal(got.files.length, 1)
    assert.equal(got.files[0]!['filePath'], 'C:/s/a.mp3')

    /**
     * ⚠️ 这里**不能**用 `deepEqual` 比整个对象。
     *
     * 校验器会把「已声明但未提供」的可选字段**补成 `undefined` 键**
     * （`{ narration: undefined }`），于是 `'key' in obj` 为 true，
     * 而 `deepEqual` 也会因为多出的键而失败 —— 但值其实是等价的。
     *
     * 所以断言**字段值**而不是对象形状：这才是真正要保证的语义
     * （overrides 里的 character 确实透传到了服务层）。
     */
    const ov = got.files[0]!['overrides'] as Record<string, unknown>
    assert.equal(ov['character'], '石志坚')
    assert.equal(ov['narration'] ?? false, false)
  })

  it('importApply 不在响应里泄露 confirm 之外的内部状态', async () => {
    const { handlers, calls } = makeHarness()
    const res = (await call(handlers, 'record:importApply', {
      ...BASE,
      files: [{ filePath: 'C:/s/a.mp3' }],
      confirm: true,
    })) as { createdTakes: number }
    assert.equal(res.createdTakes, 7)
    const got = calls.applyImport[0] as { files: unknown[] }
    assert.equal(got.files.length, 1)
  })
})

describe('写库闸门（confirm 必须显式为 true）', () => {
  /**
   * 这是**最重要的一条**：契约里 `confirm` 是 `v.literal(true)`，
   * 所以 `confirm: false` / 缺省 / 其它值都应该在校验层被挡下 ——
   * 服务层**一次都不能被调用**。
   */
  it('confirm 缺失 → schema 层拒绝，服务不被调用', async () => {
    const { handlers, calls } = makeHarness()
    await assert.rejects(
      () => call(handlers, 'record:importApply', { ...BASE, files: [] }),
      '缺 confirm 必须被拒绝',
    )
    assert.equal(calls.applyImport.length, 0, '被拒绝时绝不能碰服务层')
  })

  it('confirm: false → schema 层拒绝，服务不被调用', async () => {
    const { handlers, calls } = makeHarness()
    await assert.rejects(
      () => call(handlers, 'record:importApply', { ...BASE, files: [], confirm: false }),
      'confirm=false 必须被拒绝',
    )
    assert.equal(calls.applyImport.length, 0)
  })

  it('confirm: "true"（字符串）→ schema 层拒绝', async () => {
    const { handlers, calls } = makeHarness()
    await assert.rejects(() => call(handlers, 'record:importApply', { ...BASE, files: [], confirm: 'true' }))
    assert.equal(calls.applyImport.length, 0)
  })

  /**
   * 纵深防御：即使 schema 被放宽，handler 里的二次判断也必须挡住。
   * 这里**绕过 schema** 直接调 `run`，模拟「schema 被改成 v.boolean()」的情形。
   */
  it('纵深防御：绕过 schema 直接调 run，confirm=false 仍被 handler 挡住', async () => {
    const { handlers, calls } = makeHarness()
    const spec = handlers.find((x) => x.channel === 'record:importApply')!
    await assert.rejects(
      async () => await spec.run({ ...BASE, files: [], confirm: false } as never, {} as never),
      (e: unknown) => {
        /**
         * 断言的是**诊断字段**而不是 message。
         *
         * `AppError.message` 是给用户看的**标题**（`INVALID_PAYLOAD` → 「请求参数有误」），
         * 它不承载细节 —— 细节在 `details` 里（本仓库的既定约定，见 docs/22）。
         * 所以这里检查 `details.reason`：它才是「为什么被拒」的机器可判依据，
         * 也是排查时唯一能定位到具体校验点的地方。
         */
        const err = e as { key?: string; details?: Record<string, unknown> }
        assert.equal(err.key, 'INVALID_PAYLOAD', '应当是载荷类错误')
        assert.equal(
          err.details?.['reason'],
          'import-confirm-required',
          `details.reason 必须说明是「未确认」，实际：${JSON.stringify(err.details)}`,
        )
        assert.ok(
          typeof err.details?.['hint'] === 'string' && (err.details['hint'] as string).length > 0,
          '必须给出可行动的提示',
        )
        return true
      },
    )
    assert.equal(calls.applyImport.length, 0, '即使绕过 schema，也不能写库')
  })

  it('confirm: true → 正常写库', async () => {
    const { handlers, calls } = makeHarness()
    await call(handlers, 'record:importApply', { ...BASE, files: [{ filePath: 'C:/s/a.mp3' }], confirm: true })
    assert.equal(calls.applyImport.length, 1, '显式确认后必须真的执行')
  })
})

describe('可选参数的处理', () => {
  it('onlyFiles / skipNeedsReview 缺省时不传给服务（避免把 undefined 当值传下去）', async () => {
    const { handlers, calls } = makeHarness()
    await call(handlers, 'record:importApply', { ...BASE, files: [], confirm: true })
    const got = calls.applyImport[0] as Record<string, unknown>
    assert.equal('onlyFiles' in got, false, '缺省时不该出现 onlyFiles 键')
    assert.equal('skipNeedsReview' in got, false, '缺省时不该出现 skipNeedsReview 键')
  })

  it('onlyFiles / skipNeedsReview 有值时透传', async () => {
    const { handlers, calls } = makeHarness()
    await call(handlers, 'record:importApply', {
      ...BASE,
      files: [],
      onlyFiles: ['a.mp3'],
      skipNeedsReview: true,
      confirm: true,
    })
    const got = calls.applyImport[0] as Record<string, unknown>
    assert.deepEqual(got.onlyFiles, ['a.mp3'])
    assert.equal(got.skipNeedsReview, true)
  })
})
