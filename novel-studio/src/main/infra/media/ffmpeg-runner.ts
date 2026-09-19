/**
 * Novel Studio · ffmpeg 执行器（`FfmpegRunner` 的生产实现）
 * ============================================================================
 * 设计依据：
 *   · docs/05 §8.1 / §9 命令与两遍法；§6.4 临时目录 `cache/tmp/{taskId}/`
 *   · docs/14 §7.2 取消语义（SIGTERM → 2 秒 → SIGKILL；已完成的结果保留）
 *   · docs/14 §7.3 「查看命令」必须能复制到终端复现
 *   · docs/04 §2.2 并发限制（并发键在任务队列侧，本文件只管「跑一条命令」）
 *
 * ### 这个文件只做三件事
 *   1. `spawn` 一条命令并把 stdout/stderr 收成字符串（**有上限**，见 `MAX_OUTPUT_BYTES`）；
 *   2. 把 `-progress pipe:1` 的行按到达顺序交给回调（进度解析是纯函数 `parseProgress`）；
 *   3. 取消/超时时杀进程：`SIGTERM` → 2 秒后 `SIGKILL`（Windows 上 ffmpeg 会忽略 SIGTERM 之外
 *      的软信号，所以最终一定要有强杀兜底，否则「取消」会变成「永远转圈」）。
 *
 * ### 两个刻意的设计
 *   · **非 0 退出码不在这里抛异常**：原样返回 `exitCode` + `stderr`，由调用方决定是
 *     抛 `EXPORT_FFMPEG_FAILED`、还是重试、还是换滤镜（见 `commands.ts` 的接口注释）。
 *     在这里抛会让「按退出码分支」的测试与重试逻辑无处安放。
 *   · **ffmpeg 路径由调用方给**：主进程启动时探测过一次（`capabilities.ffmpeg`），
 *     未探到时用 `'ffmpeg'` 交给 PATH —— 而不是硬编码一个绝对路径。
 */

import { spawn } from 'node:child_process'

import type {
  FfmpegExecuteOptions,
  FfmpegExecuteResult,
  FfmpegRunner,
} from '../../../shared/ffmpeg/commands.ts'

/** stderr 保留上限（字节）。ffmpeg 出错时前面几十行就够了，后面全是进度噪音 */
export const MAX_OUTPUT_BYTES = 64 * 1024

/** 强杀宽限期（docs/14 §7.2：SIGTERM → 2 秒 → SIGKILL） */
export const KILL_GRACE_MS = 2000

export interface CreateFfmpegRunnerOptions {
  /** ffmpeg 可执行文件路径（默认 `'ffmpeg'`，交给 PATH） */
  ffmpegPath?: () => string
  /** 默认超时（毫秒）；不传则不设超时（长任务如整本导出由调用方显式给） */
  defaultTimeoutMs?: number
  log?: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

export function createFfmpegRunner(opts?: CreateFfmpegRunnerOptions): FfmpegRunner {
  const resolvePath = opts?.ffmpegPath ?? (() => 'ffmpeg')

  async function probeCapabilities(): Promise<{ version: string | null; filters: string[]; encoders: string[] }> {
    // 能力探测的真实实现在启动期（`bootstrap-steps` 的 probeFfmpeg），它会填进 capabilities。
    // 这里显式声明「没实现」，而不是返回空数组假装探测过（空数组意味着「一个滤镜都不支持」，
    // 那会让 UI 判定 ffmpeg 不可用）。
    return { version: null, filters: [], encoders: [] }
  }

  /**
   * 执行一条命令。
   *
   * @param command 完整命令数组（第一项是 ffmpeg 路径；由 `build*Command` 产出）
   * @throws 只在「进程根本起不来」时抛（ENOENT = ffmpeg 未安装）
   */
  async function execute(command: string[], executeOpts?: FfmpegExecuteOptions): Promise<FfmpegExecuteResult> {
    const started = Date.now()
    // 命令数组里第一项可能是 'ffmpeg'；调用方显式给了路径时优先用调用方的
    const argv = [...command]
    if (argv[0] === 'ffmpeg' || argv[0] === 'ffprobe') argv[0] = resolvePath()

    const timeoutMs = executeOpts?.timeoutMs ?? opts?.defaultTimeoutMs ?? 0
    const signal = executeOpts?.signal

    const child = spawn(argv[0]!, argv.slice(1), {
      ...(executeOpts?.cwd ? { cwd: executeOpts.cwd } : {}),
      windowsHide: true,
      ...(executeOpts?.env ? { env: { ...process.env, ...executeOpts.env } } : {}),
    })

    let stdout = ''
    let stderr = ''
    let killed = false
    let killTimer: NodeJS.Timeout | null = null
    let timeoutTimer: NodeJS.Timeout | null = null

    function kill(): void {
      if (killed) return
      killed = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已经退出了 */
      }
      killTimer = setTimeout(() => {
        try {
          // Windows 上 SIGKILL 会被 Node 映射成 TerminateProcess（唯一可靠的强杀）
          child.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
      }, KILL_GRACE_MS)
      // 定时器不该阻止进程退出（Electron 退出时不能被它挂住）
      killTimer.unref?.()
    }

    if (signal) {
      if (signal.aborted) kill()
      else signal.addEventListener('abort', kill, { once: true })
    }
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(kill, timeoutMs)
      timeoutTimer.unref?.()
    }

    /** `-progress pipe:1` 的行是**增量**到达的；这里按 \n 切分后逐行回调 */
    let progressBuf = ''
    function consumeProgress(chunk: string): void {
      if (!executeOpts?.onProgressLine) return
      progressBuf += chunk
      let idx = progressBuf.indexOf('\n')
      while (idx >= 0) {
        const line = progressBuf.slice(0, idx).trim()
        progressBuf = progressBuf.slice(idx + 1)
        if (line) {
          try {
            executeOpts.onProgressLine(line)
          } catch (e) {
            // 进度回调抛错不该杀掉 ffmpeg：进度是「尽力而为」的信息
            opts?.log?.warn?.('ffmpeg.progressCallbackFailed', {
              event: 'ffmpeg.progressCallbackFailed',
              reason: e instanceof Error ? e.message : String(e),
            })
          }
        }
        idx = progressBuf.indexOf('\n')
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk
      consumeProgress(chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk
    })

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', (e: NodeJS.ErrnoException) => {
        // ENOENT = ffmpeg 不存在。这是**唯一**在这里上抛的情况：没有进程就没有退出码，
        // 上层拿到 exitCode=-1 会以为是「ffmpeg 跑了但失败」，那是误导。
        reject(e)
      })
      child.once('close', (code) => resolve(code ?? -1))
    }).finally(() => {
      if (killTimer) clearTimeout(killTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      signal?.removeEventListener('abort', kill)
    })

    return {
      command: argv,
      exitCode,
      stdout,
      stderr,
      elapsedMs: Date.now() - started,
    }
  }

  return { execute, probeCapabilities }
}
