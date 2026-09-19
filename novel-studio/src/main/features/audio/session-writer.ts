/**
 * Novel Studio · 录音会话的流式 WAV 写入器
 * ============================================================================
 * 设计依据：
 *   · docs/05 §2（PCM 与 WAV 口径）、§2.4「写盘格式由设置决定，采集侧恒为 float32」
 *   · docs/05 §9「崩溃恢复：会话文件先落盘、头部随后补」
 *   · docs/12 §2 约束「采集块到达即写盘；禁止在内存里攒整段录音」
 *
 * ### 为什么不能「最后一次性写文件」
 *   连续录制可能是几十分钟（1.42M 字的书按章录）。整段攒在内存里意味着：
 *   一次 GC 抖动就是丢帧，进程崩了整段录音就没了。这里用 `open` + `appendFileSync`
 *   式的顺序写：**每块到达即落盘**，只在头部留一个占位，定稿时回填真实长度。
 *
 * ### 头部占位与回填
 *   先写 44 字节头（data 长度按 0 写），后续顺序追加 PCM；`finalize()` 用
 *   `position` 参数把**真实** data 长度写回头部 —— 不重写整个文件，几十 MB 的录音也是 O(1)。
 *   崩溃现场（进程被强杀）留下的文件 data 长度字段为 0，由 `recovery.ts` 按文件实际大小修复
 *   （`shared/audio/wav.ts` 的 `repairWavHeader`），所以「头部没回填」不等于「录音丢了」。
 *
 * ### 只做一件事
 *   本文件不碰数据库、不碰设置、不做测量：只把「float32 块 → 磁盘上的 WAV」这件事做对。
 *   业务编排在 `record.service.ts`。
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import type { AudioFormat } from '../../../shared/types.ts'
import { bytesPerSample } from '../../../shared/audio/pcm.ts'
import { float32ToFloat32LE, float32ToInt16LE, float32ToInt24LE } from '../../../shared/audio/pcm.ts'
import { WAV_HEADER_BYTES, writeWavHeader } from '../../../shared/audio/wav.ts'

/**
 * WAV 头部里「data 块长度」字段的偏移（RIFF/WAVE 的规范位置）。
 * 不写成魔数散落在代码里：`writeWavHeader` 生成的头与本常量必须一致（有测试对比）。
 */
const DATA_SIZE_OFFSET = 40

export interface SessionWriterOptions {
  /** 绝对路径（由调用方用 `resolveProjectPath` 拼好并校验过） */
  filePath: string
  format: AudioFormat
  /** 写盘时的错误回调（磁盘满 / 权限）；不传则向上抛 */
  onError?: (e: Error) => void
}

export interface SessionWriter {
  readonly filePath: string
  readonly format: AudioFormat
  /** 已写入的帧数（= 每声道样本数） */
  readonly framesWritten: number
  /**
   * 追加一块**交错**的 float32 采样（渲染侧送来的就是交错格式，见 useRecorder）。
   * 采样数不是声道整数倍时截断到整帧 —— 半个帧写进文件会让后续所有采样错位。
   */
  append(interleaved: Float32Array): void
  /** 回填头部长度并关闭文件；返回最终帧数 */
  finalize(): { frames: number; dataBytes: number }
  /** 关闭文件（不保证头部正确；用于 abort） */
  close(): void
}

export function createSessionWriter(opts: SessionWriterOptions): SessionWriter {
  const { filePath, format } = opts
  if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
    throw new AppError('INVALID_PAYLOAD', {
      details: { op: 'record:prepare', reason: 'invalid-sample-rate', sampleRate: format.sampleRate },
    })
  }
  mkdirSync(dirname(filePath), { recursive: true })

  let fd: number | null = openSync(filePath, 'w')
  // 先写占位头：长度字段等定稿时回填（崩溃时由 recovery 按文件大小修复）
  writeSync(fd, writeWavHeader({ dataBytes: 0, format }))
  let frames = 0
  let closed = false

  function encode(interleaved: Float32Array): Buffer {
    switch (format.bitDepth) {
      case 16:
        return float32ToInt16LE(interleaved)
      case 24:
        return float32ToInt24LE(interleaved)
      case 32:
        return float32ToFloat32LE(interleaved)
      default:
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'record:write', reason: 'unsupported-bit-depth', bitDepth: format.bitDepth },
        })
    }
  }

  return {
    filePath,
    format,
    get framesWritten() {
      return frames
    },

    append(interleaved) {
      if (closed || fd === null) {
        throw new AppError('INTERNAL', {
          details: { reason: 'session-writer-closed', filePath },
        })
      }
      const channels = format.channels
      const usable = interleaved.length - (interleaved.length % channels)
      if (usable <= 0) return
      const src = usable === interleaved.length ? interleaved : interleaved.subarray(0, usable)
      try {
        writeSync(fd, encode(src))
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        opts.onError?.(err)
        throw err
      }
      frames += usable / channels
    },

    finalize() {
      if (fd === null) return { frames, dataBytes: frames * format.channels * bytesPerSample(format.bitDepth) }
      const dataBytes = frames * format.channels * bytesPerSample(format.bitDepth)
      try {
        // 只回填 4 字节长度字段（position 写，不动其余内容）
        const sizeBuf = Buffer.alloc(4)
        sizeBuf.writeUInt32LE(dataBytes, 0)
        writeSync(fd, sizeBuf, 0, 4, DATA_SIZE_OFFSET)
        // RIFF 块长度 = 文件总长 - 8；同样回填，避免播放器按占位长度截断
        const riffBuf = Buffer.alloc(4)
        riffBuf.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 0)
        writeSync(fd, riffBuf, 0, 4, 4)
      } finally {
        closeSync(fd)
        fd = null
        closed = true
      }
      return { frames, dataBytes }
    },

    close() {
      if (fd === null) return
      try {
        closeSync(fd)
      } finally {
        fd = null
        closed = true
      }
    },
  }
}

/** 供测试与恢复逻辑复用：data 长度字段的偏移 */
export const WAV_DATA_SIZE_OFFSET = DATA_SIZE_OFFSET
