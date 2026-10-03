/**
 * 测试 · ASR 引擎调用（`asr-runner.ts`）
 * ============================================================================
 * 真机需求：「需要音频转文字 记录每段文字的位置后分割」。
 *
 * 这里用**假进程**（注入 spawn / exists / readTextFile）验证调用链：
 *   ① 引擎与模型都缺时 `availability()` 说清「缺什么、放哪里」；
 *   ② 真的先转 16 kHz 单声道（whisper 的硬要求），再带着模型跑识别；
 *   ③ 任何一步失败都**返回 null**（调用方退回 VAD），绝不把导入搞挂。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { createAsrRunner, type AsrSpawn } from '../../src/main/features/audio/asr-runner.ts'
import type { FfmpegRunner } from '../../src/shared/ffmpeg/commands.ts'

const WHISPER_JSON = JSON.stringify({
  transcription: [
    {
      offsets: { from: 0, to: 4200 },
      text: ' 第一句。',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.5 },
        { text: '第一', offsets: { from: 100, to: 900 }, p: 0.9 },
        { text: '句', offsets: { from: 900, to: 1600 }, p: 0.8 },
      ],
    },
    {
      offsets: { from: 4200, to: 9000 },
      text: ' 第二句。',
      tokens: [{ text: '第二句', offsets: { from: 4200, to: 8000 }, p: 0.7 }],
    },
  ],
})

interface HarnessOptions {
  exists?: (path: string) => boolean
  ffmpegAvailable?: boolean
  ffmpegCode?: number
  spawnResult?: { code: number | null; stderr?: string }
  /** 第一次跑 `-ojf` 的结果（不传就用 `spawnResult`）：用于验证「老引擎不支持 -ojf」的退路 */
  spawnResults?: Array<{ code: number | null; stderr?: string }>
  readTextFile?: (path: string) => string
  settings?: () => { binaryPath?: string | null; modelPath?: string | null; language?: string | null; threads?: number | null; modelId?: string | null }
}

function harness(opts: HarnessOptions = {}) {
  const spawned: Array<{ command: string; args: string[] }> = []
  const ffmpegCalls: string[][] = []
  const readPaths: string[] = []
  const ffmpeg = {
    async execute(command: string[]) {
      ffmpegCalls.push([...command])
      return { exitCode: opts.ffmpegCode ?? 0, stdout: '', stderr: '' }
    },
  } as unknown as FfmpegRunner
  const spawn: AsrSpawn = async (command, args) => {
    const queued = opts.spawnResults?.[spawned.length]
    spawned.push({ command, args: [...args] })
    return queued ?? opts.spawnResult ?? { code: 0 }
  }
  const runner = createAsrRunner({
    ffmpeg,
    ffmpegAvailable: () => opts.ffmpegAvailable ?? true,
    resourcePath: (rel) => 'C:/res/' + rel,
    settings: opts.settings ?? (() => ({ language: 'zh', threads: 4, modelId: 'ggml-small.bin' })),
    exists: opts.exists ?? (() => true),
    // 模型必须「像样」（≥ 20 MB）才认：半截下载的 ggml 会让 whisper 直接失败
    sizeOf: () => 200 * 1024 * 1024,
    listDir: () => [],
    spawn,
    readTextFile: (path: string) => {
      readPaths.push(path)
      return (opts.readTextFile ?? (() => WHISPER_JSON))(path)
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })
  return { runner, spawned, ffmpegCalls, readPaths }
}

describe('ASR 引擎可用性', () => {
  it('二进制与模型都在 → 可用', () => {
    const { runner } = harness()
    const ready = runner.availability()
    assert.equal(ready.ok, true)
    assert.match(ready.binary!, /bin\/whisper-cli/)
    assert.match(ready.model!, /models\/whisper\/ggml-small\.bin/, '模型名取设置里的 modelId')
  })

  it('缺引擎/模型时说明缺什么、放哪里（不抛错）', () => {
    const { runner } = harness({ exists: () => false })
    const ready = runner.availability()
    assert.equal(ready.ok, false)
    assert.match(ready.reason!, /识别引擎/)
    assert.match(ready.reason!, /识别模型/)
    assert.match(ready.reason!, /resources|bin\//)
  })

  it('设置里给了显式路径就用它（优先于 resources）', () => {
    const { runner } = harness({
      exists: () => false,
      settings: () => ({ binaryPath: 'D:/tools/whisper-cli.exe', modelPath: 'D:/models/ggml-medium.bin' }),
    })
    const ready = runner.availability()
    assert.equal(ready.ok, true)
    assert.equal(ready.binary, 'D:/tools/whisper-cli.exe')
    assert.equal(ready.model, 'D:/models/ggml-medium.bin')
  })
})

describe('ASR 识别调用', () => {
  it('先转 16 kHz 单声道，再带模型跑识别，输出解析成段落', async () => {
    const h = harness()
    const res = await h.runner.transcribe({ absolutePath: 'C:/proj/imports/a.wav' })
    assert.ok(res, '识别应当成功')
    // ① ffmpeg 转 16 kHz 单声道（whisper 的硬要求）
    const convert = h.ffmpegCalls[0]!
    /**
     * ★ 命令第一项**必须**是 `'ffmpeg'`：`FfmpegRunner.execute` 是按第一项分派二进制的。
     * 少写它时 spawn 的命令会变成 `-hide_banner`，真机日志是
     * `asr.failed: spawn -hide_banner ENOENT` —— 识别永远失败、全部退回 VAD。
     */
    assert.equal(convert[0], 'ffmpeg', 'argv[0] 必须是 ffmpeg（FfmpegRunner 按第一项分派二进制）')
    assert.ok(convert.includes('-ar') && convert.includes('16000'), '必须转 16 kHz')
    assert.ok(convert.includes('-ac') && convert.includes('1'), '必须下混单声道')
    // ② whisper 参数：-ojf 要 token 级时间戳（长句对齐全靠它）
    const call = h.spawned[0]!
    assert.match(call.args.join(' '), /-m .*ggml-small\.bin/)
    assert.match(call.args.join(' '), /-l zh/)
    assert.match(call.args.join(' '), /-ojf/)
    assert.match(call.args.join(' '), /-t 4/)
    // ③ 结果：段 + token（token 是逐字对齐的精度来源）
    assert.equal(res!.segments.length, 2)
    assert.equal(res!.shape, 'whisper.cpp')
    assert.deepEqual(
      res!.tokens.map((t) => t.text),
      ['第一', '句', '第二句'],
      '特殊标记（[_BEG_]）不进 token 流',
    )
    assert.equal(res!.tokens[0]!.startMs, 100)
  })

  it('引擎不支持 -ojf 时退回 -oj（按段对齐，仍然可用）', async () => {
    const h = harness({ spawnResults: [{ code: 1, stderr: 'unknown argument: -ojf' }, { code: 0 }] })
    const res = await h.runner.transcribe({ absolutePath: 'C:/a.wav' })
    assert.ok(res, '退回 -oj 后仍应成功')
    assert.equal(h.spawned.length, 2)
    assert.match(h.spawned[0]!.args.join(' '), /-ojf/)
    assert.match(h.spawned[1]!.args.join(' '), /-oj(\s|$)/)
    assert.equal(res!.segments.length, 2)
    assert.match(h.readPaths[0]!, /-plain\.json$/, '退回 -oj 后读的是另一个输出前缀，不会拿到半截文件')
  })

  it('引擎缺失 → 直接返回 null（连 ffmpeg 都不该跑）', async () => {
    const h = harness({ exists: () => false })
    const res = await h.runner.transcribe({ absolutePath: 'C:/a.wav' })
    assert.equal(res, null)
    assert.equal(h.ffmpegCalls.length, 0)
    assert.equal(h.spawned.length, 0)
  })

  it('没有 ffmpeg → 返回 null（whisper 只吃 16 kHz）', async () => {
    const h = harness({ ffmpegAvailable: false })
    assert.equal(await h.runner.transcribe({ absolutePath: 'C:/a.wav' }), null)
    assert.equal(h.spawned.length, 0)
  })

  it('识别进程非 0 退出 → 返回 null（导入退回 VAD，不失败）', async () => {
    const h = harness({ spawnResult: { code: 1, stderr: 'boom' } })
    assert.equal(await h.runner.transcribe({ absolutePath: 'C:/a.wav' }), null)
  })

  it('输出文件读不到 / 内容为空 → 返回 null', async () => {
    const missing = harness({
      readTextFile: () => {
        throw new Error('ENOENT')
      },
    })
    assert.equal(await missing.runner.transcribe({ absolutePath: 'C:/a.wav' }), null)
    const empty = harness({ readTextFile: () => JSON.stringify({ transcription: [] }) })
    assert.equal(await empty.runner.transcribe({ absolutePath: 'C:/a.wav' }), null)
  })
})
