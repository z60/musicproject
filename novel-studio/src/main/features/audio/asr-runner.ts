/**
 * Novel Studio · ASR 引擎调用（「音频转文字」的真正那一步）
 * ============================================================================
 * 设计依据：docs/05 §7（语音识别）、docs/12 §4.3、docs/91 §5.2.63
 *
 * 真机需求：「需要音频转文字 记录每段文字的位置后分割 导入速度无所谓」。
 * 本模块把它变成现实：**调外部 whisper 引擎，拿回每段文字 + 起止毫秒**。
 *
 * ## 引擎怎么找（按优先级）
 *   1. 设置里的显式路径：`asr.binaryPath` / `asr.modelPath`；
 *   2. 随应用分发的资源：`resources/bin/whisper-cli.exe` + `resources/models/whisper/ggml-*.bin`；
 *   3. 都找不到 → `availability()` 返回 ok:false 并说明**缺什么、放哪里**（不抛错）。
 *
 * ## 三条纪律
 *   ① **不抛错**：识别失败只记日志 + 返回 null，调用方退回 VAD 路径；
 *   ② **16 kHz 单声道**：whisper 家族只吃 16 kHz 单声道，先用 ffmpeg 转一遍；
 *   ③ **输出形状松耦合**：JSON 交给纯函数 `parseAsrOutput()`（三种形状都认）。
 *
 * ## 为什么不做成「内置模型」
 *   模型动辄上百 MB、许可证各异；本项目的既有约定是「模型放 resources/models/、
 *   清单在 models.json」（docs/21 §16）。这里只负责**调用**，不负责下载。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseAsrOutput, type AsrOutputShape, type AsrToken } from '../../../shared/audio/asr-output.ts'
import type { AsrSegment } from '../../../shared/audio/text-match.ts'
import type { FfmpegRunner } from '../../../shared/ffmpeg/commands.ts'
import type { Logger } from '../../infra/log/index.ts'

/** 一次识别需要的外部输入（全部由装配层现取，便于测试替换） */
export interface AsrRunnerDeps {
  ffmpeg: FfmpegRunner
  /** ffmpeg 是否可用（不可用就没法转 16 kHz —— whisper 的硬要求） */
  ffmpegAvailable: () => boolean
  /** 解析 `resources/` 下的相对路径（bin/ 与 models/ 都在它下面） */
  resourcePath: (relative: string) => string
  /** 读设置（每次现取：用户可能刚在设置里填了路径） */
  settings: () => {
    binaryPath?: string | null
    modelPath?: string | null
    language?: string | null
    threads?: number | null
    modelId?: string | null
  }
  /** 默认的 whisper 可执行文件名；不传时按平台取 whisper-cli[.exe] */
  binaryName?: string
  /** 跑进程（默认 node:child_process.spawn；测试注入假实现） */
  spawn?: AsrSpawn
  /** 读文本文件（默认 fs.readFileSync utf8；测试注入） */
  readTextFile?: (path: string) => string
  /** 临时目录根（默认 os.tmpdir） */
  tempRoot?: string
  /** 存在性判断（测试注入；默认 fs.existsSync） */
  exists?: (path: string) => boolean
  /** 列目录（默认 fs.readdirSync；用于「配置的模型不在时挑一个 ggml-*.bin」） */
  listDir?: (path: string) => string[]
  /** 文件大小（默认 fs.statSync；用于判掉下载到一半的模型） */
  sizeOf?: (path: string) => number
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

/** 跑一次子进程并拿到退出码（测试注入假实现，不需要真的装 whisper） */
export type AsrSpawn = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number | null; stderr?: string }>

export interface AsrAvailability {
  ok: boolean
  /** 不可用的原因（UI 直接显示，含「把文件放哪里」的指引） */
  reason: string | null
  binary: string | null
  model: string | null
}

export interface AsrTranscribeResult {
  segments: AsrSegment[]
  /**
   * token 级时间戳（whisper.cpp `-ojf`）。**对齐精度全靠它**：
   * 只有整段的时间时，「一行文字横跨两段」就会切错（真机症状：长句尾音丢失）。
   * 引擎不给 token 时为空数组，调用方退回按段对齐。
   */
  tokens: AsrToken[]
  /** 输出形状（whisper.cpp / openai-whisper / plain），记日志用 */
  shape: AsrOutputShape
  /** 识别耗时（毫秒，仅用于日志） */
  elapsedMs: number
}

export interface AsrRunner {
  availability(): AsrAvailability
  /**
   * 识别一段音频。**不抛错**：引擎缺失/超时/解析失败都返回 null，
   * 调用方据此退回 VAD 路径（导入不该因为识别失败而失败）。
   */
  transcribe(input: { absolutePath: string; durationMs?: number }): Promise<AsrTranscribeResult | null>
}

/** 默认的 whisper.cpp 可执行文件名（发布时把二进制放进 resources/bin） */
function defaultBinaryName(): string {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
}

export function createAsrRunner(deps: AsrRunnerDeps): AsrRunner {
  const spawn = deps.spawn ?? defaultSpawn
  const readTextFile = deps.readTextFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const exists = deps.exists ?? ((path: string) => existsSync(path))
  const sizeOf = deps.sizeOf ?? ((path: string): number => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  })
  const listDir = deps.listDir ?? ((path: string): string[] => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  })
  const binaryName = deps.binaryName ?? defaultBinaryName()

  function resolveBinary(): string | null {
    const configured = deps.settings().binaryPath?.trim()
    if (configured) return configured
    // 轮询两个常见名字：新版叫 whisper-cli，老版叫 main
    const candidates = [
      deps.resourcePath('bin/' + binaryName),
      deps.resourcePath('bin/main.exe'),
      deps.resourcePath('bin/main'),
    ]
    return candidates.find((p) => exists(p)) ?? null
  }

  function resolveModel(): string | null {
    const configured = deps.settings().modelPath?.trim()
    if (configured) return configured
    const dir = deps.resourcePath('models/whisper')
    const modelId = deps.settings().modelId?.trim() || 'ggml-base.bin'
    const candidate = deps.resourcePath('models/whisper/' + modelId)
    if (exists(candidate) && sizeOf(candidate) >= 20 * 1024 * 1024) return candidate
    /**
     * 配置的那个模型不在时**退一步扫目录**：用户常常只丢了一个模型进来
     * （例如只下载了 ggml-small.bin，而设置的默认值是 ggml-base.bin），
     * 这时若直接判「不可用」，用户会以为「装了也没用」。
     * 优先级：small > medium > base > large > 其它 ggml 文件（精度优先，导入慢一点无所谓）。
     */
    /**
     * 只认**像样的**模型文件（≥ 20 MB）：下载中途的残file（半截 ggml）会让 whisper 直接失败，
     * 而那时用户看到的是「按停顿估计」—— 比「没有模型」更难查。
     */
    const MIN_MODEL_BYTES = 20 * 1024 * 1024
    const bins = listDir(dir).filter(
      (n) => n.startsWith('ggml-') && n.endsWith('.bin') && sizeOf(join(dir, n)) >= MIN_MODEL_BYTES,
    )
    if (bins.length === 0) return null
    const preferred = ['ggml-small.bin', 'ggml-medium.bin', 'ggml-base.bin', 'ggml-large-v3.bin']
    for (const name of preferred) {
      if (bins.includes(name)) return deps.resourcePath('models/whisper/' + name)
    }
    return deps.resourcePath('models/whisper/' + bins.sort()[0]!)
  }

  function availability(): AsrAvailability {
    const binary = resolveBinary()
    const model = resolveModel()
    if (binary && model) return { ok: true, reason: null, binary, model }
    const missing: string[] = []
    if (!binary) {
      missing.push('识别引擎（把 whisper-cli 放到 ' + deps.resourcePath('bin/' + binaryName) + '，或在设置里填 asr.binaryPath）')
    }
    if (!model) {
      missing.push('识别模型（把 ggml 模型放到 ' + deps.resourcePath('models/whisper/ggml-base.bin') + '，或在设置里填 asr.modelPath）')
    }
    return { ok: false, reason: '缺少' + missing.join('、'), binary: binary ?? null, model: model ?? null }
  }

  return {
    availability,
    async transcribe(input) {
      const started = Date.now()
      const ready = availability()
      if (!ready.ok) {
        deps.log?.info?.('asr.unavailable', { event: 'asr.unavailable', reason: ready.reason })
        return null
      }
      if (!deps.ffmpegAvailable()) {
        deps.log?.warn?.('asr.ffmpegUnavailable', {
          event: 'asr.ffmpegUnavailable',
          note: 'whisper 只吃 16 kHz 单声道，没有 ffmpeg 就没法转 —— 退回 VAD 切句',
        })
        return null
      }

      const dir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'ns-asr-'))
      const wavPath = join(dir, 'input-16k.wav')
      const outBase = join(dir, 'out')
      try {
        // ① 转 16 kHz 单声道（whisper 的硬要求）
        //
        // ★ `argv[0]` **必须**是 `'ffmpeg'`：`FfmpegRunner.execute()` 是按第一项分派二进制的
        //   （`'ffmpeg'` → 探测到的路径，`'ffprobe'` → 同目录派生）。
        //   这里曾经直接传参数数组，于是 spawn 的「命令」变成了 `-hide_banner`，
        //   真机日志就是 `asr.failed: spawn -hide_banner ENOENT` —— 每个文件都退回 VAD，
        //   用户看到的是「装了 whisper 也没用、长句尾音对不上」。
        const convert = await deps.ffmpeg.execute([
          'ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', input.absolutePath,
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath,
        ])
        if (convert.exitCode !== 0) {
          deps.log?.warn?.('asr.convertFailed', {
            event: 'asr.convertFailed',
            code: convert.exitCode,
            stderr: String(convert.stderr ?? '').slice(0, 400),
          })
          return null
        }

        /**
         * ② 识别。参数（whisper.cpp）：
         *   `-m` 模型 / `-f` 16 kHz WAV / `-l` 语言 / `-of` 输出前缀 / `-np` 不打进度条；
         *   `-ojf` = 输出 **full JSON**：除了每段文字，还给**每个 token 的起止毫秒**。
         *   这是「长句尾音丢失」的根治手段 —— 只有整段的时间时，一行文字横跨两段就必然切错。
         *   老版本没有 `-ojf` 时下面会退回 `-oj`（按段对齐，仍然可用）。
         */
        const settings = deps.settings()
        const baseArgs: string[] = [
          '-m', ready.model!,
          '-f', wavPath,
          '-l', settings.language?.trim() || 'zh',
        ]
        if (settings.threads && settings.threads > 0) baseArgs.push('-t', String(settings.threads))
        let outBaseFinal = outBase
        let run = await spawn(ready.binary!, [...baseArgs, '-ojf', '-of', outBase, '-np'])
        if (run.code !== 0) {
          deps.log?.warn?.('asr.fullJsonUnsupported', {
            event: 'asr.fullJsonUnsupported',
            code: run.code,
            stderr: String(run.stderr ?? '').slice(0, 200),
            note: '识别引擎可能不支持 -ojf，退回 -oj（按段对齐）',
          })
          outBaseFinal = outBase + '-plain'
          run = await spawn(ready.binary!, [...baseArgs, '-oj', '-of', outBaseFinal, '-np'])
        }
        if (run.code !== 0) {
          deps.log?.warn?.('asr.runFailed', {
            event: 'asr.runFailed',
            code: run.code,
            stderr: String(run.stderr ?? '').slice(0, 400),
          })
          return null
        }

        // ③ 解析（whisper.cpp 把 JSON 写在 <outBase>.json）
        const jsonPath = outBaseFinal + '.json'
        let raw = ''
        try {
          raw = readTextFile(jsonPath)
        } catch {
          deps.log?.warn?.('asr.outputMissing', { event: 'asr.outputMissing', path: jsonPath })
          return null
        }
        const parsed = parseAsrOutput(raw)
        if (parsed.segments.length === 0) {
          deps.log?.warn?.('asr.noSegments', {
            event: 'asr.noSegments',
            shape: parsed.shape,
            warnings: parsed.warnings,
          })
          return null
        }
        const elapsedMs = Date.now() - started
        deps.log?.info?.('asr.transcribed', {
          event: 'asr.transcribed',
          shape: parsed.shape,
          segments: parsed.segments.length,
          // token 数=0 说明引擎只给了整段的时间（按段对齐，长句会粗一点）
          tokens: parsed.tokens.length,
          elapsedMs,
          binary: ready.binary,
          model: ready.model,
        })
        return { segments: parsed.segments, tokens: parsed.tokens, shape: parsed.shape, elapsedMs }
      } catch (e) {
        deps.log?.warn?.('asr.failed', {
          event: 'asr.failed',
          reason: e instanceof Error ? e.message : String(e),
        })
        return null
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 临时目录清理失败不影响导入 */
        }
      }
    },
  }
}

/** 默认实现：用 node:child_process 跑子进程（收集 stderr 前若干字节用于诊断） */
async function defaultSpawn(
  command: string,
  args: readonly string[],
): Promise<{ code: number | null; stderr?: string }> {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve) => {
    const child = spawn(command, [...args], { windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })
    child.on('error', (e) => resolve({ code: null, stderr: e.message + '\n' + stderr }))
    child.on('close', (code) => resolve({ code, stderr }))
  })
}
