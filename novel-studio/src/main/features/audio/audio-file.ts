/**
 * Novel Studio · 音频文件读取与测量（主进程侧）
 * ============================================================================
 * 设计依据：
 *   · docs/05 §2（PCM 与 WAV 口径）、§8（响度测量：loudnorm / ebur128）
 *   · docs/12 §11（设备自检的测量项）
 *   · `src/shared/audio/*`（纯逻辑：WAV 头、PCM 换算、峰值、响度解析）
 *
 * ### 这一层只做「读文件 + 调纯函数」，不做业务
 *   项目里的音频是按**项目根相对路径**存的（`takes/{lineId}/x.wav`、`segments/x.wav`…），
 *   所以统一的入口是 `readAudioFile(projectRoot, relativePath)`：把相对路径拼成绝对路径、
 *   读文件、解析 WAV 头、解码成 Float32（多声道会下混成单声道用于分析）。
 *
 * ### 为什么不解析 mp3/m4a
 *   分析通道（`analysis:*`）当前只支持 **WAV**（录制与导出链路的中间产物都是 WAV，见 docs/05 §2）。
 *   遇到非 WAV 文件时**如实抛 `INVALID_PAYLOAD`**（带 `reason: 'unsupported-format'`），
 *   而不是返回一堆 null 假装测过了 —— 后者会让「电平正常吗」这个问题永远得不到回答。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import type { AudioFormat, Timestamp } from '../../../shared/types.ts'
import { WAV_HEADER_BYTES, parseWavHeader, writeWavHeader } from '../../../shared/audio/wav.ts'
import {
  bytesPerSample,
  computePeakDb,
  computeRmsDb,
  float32LEToFloat32,
  int16LEToFloat32,
  int24LEToFloat32,
  mixdownToMono,
} from '../../../shared/audio/pcm.ts'

export interface ReadAudioFileResult {
  /** 绝对路径 */
  absolutePath: string
  /** 相对项目根的路径（落库口径） */
  relativePath: string
  fileSize: number
  mtime: Timestamp
  format: AudioFormat
  /** 下混为单声道后的采样（分析用；多声道时是各声道平均） */
  mono: Float32Array
  /** 单声道样本数（= 帧数） */
  frames: number
}

/** 相对项目根的路径 → 绝对路径（已经是绝对路径时原样返回） */
export function resolveAudioPath(projectRoot: string, pathOrRelative: string): string {
  if (isAbsolute(pathOrRelative)) return pathOrRelative
  return join(projectRoot, pathOrRelative)
}

/**
 * 绝对路径 → **项目根相对路径**（POSIX 分隔符）。
 *
 * 统一用 `/` 的理由：库里的 `file_path` 列是按 `/` 写的（docs/21：`segments/{id}.wav`），
 * 渲染侧的 `ns-media://` URL 与 `analysis:peaks` 的入参也按这个口径。若这里在 Windows 上
 * 返回 `segments\s1.wav`，同一段音频会出现**两种路径写法** → `audio_metrics` 缓存两份、
 * 按路径查 segment 也可能查不到。所以**一律归一成 `/`**。
 */
export function toProjectRelative(projectRoot: string, absolutePath: string): string {
  const normalizedRoot = projectRoot.replace(/[\\/]+$/, '')
  const rest = absolutePath.startsWith(normalizedRoot)
    ? absolutePath.slice(normalizedRoot.length).replace(/^[\\/]+/, '')
    : absolutePath
  return rest.replace(/\\/g, '/')
}

/** 读一段 WAV 并解码成单声道 Float32（分析/测量用） */
export async function readAudioFile(projectRoot: string, pathOrRelative: string): Promise<ReadAudioFileResult> {
  const absolutePath = resolveAudioPath(projectRoot, pathOrRelative)
  let buf: Buffer
  let info: { size: number; mtimeMs: number }
  try {
    const st = await stat(absolutePath)
    info = { size: st.size, mtimeMs: st.mtimeMs }
    buf = await readFile(absolutePath)
  } catch (e) {
    throw new AppError('FILE_NOT_FOUND', { cause: e, details: { path: absolutePath } })
  }

  const parsed = parseWavHeader(buf)
  if (!parsed.valid || !isWav(buf)) {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        op: 'analysis',
        reason: 'unsupported-format',
        path: absolutePath,
        hint: '分析通道当前只支持 WAV（录制与导出的中间产物都是 WAV，见 docs/05 §2）',
      },
    })
  }

  const dataEnd = Math.min(buf.length, parsed.dataOffset + parsed.dataBytes)
  // `subarray` 给的是 Buffer（Uint8Array 视图）；纯函数收的是 ArrayBuffer 视图，
  // 这里拷成独立 Buffer 既满足类型，也避免把整个文件缓冲区长期持有
  const payload = Buffer.from(buf.subarray(parsed.dataOffset, Math.max(parsed.dataOffset, dataEnd)))
  const interleaved = decodePcm(payload, parsed.format)
  const mono = parsed.format.channels > 1 ? mixdownToMono(interleaved, parsed.format.channels) : interleaved

  return {
    absolutePath,
    relativePath: toProjectRelative(projectRoot, absolutePath),
    fileSize: info.size,
    mtime: Math.round(info.mtimeMs),
    format: parsed.format,
    mono,
    frames: parsed.format.channels > 0 ? Math.floor(mono.length) : 0,
  }
}

function isWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
}

/** 按位深解码 PCM 载荷（WAV 三种位深都有对应纯函数，见 `shared/audio/pcm.ts`） */
function decodePcm(payload: Buffer, format: AudioFormat): Float32Array {
  switch (format.bitDepth) {
    case 16:
      return int16LEToFloat32(payload)
    case 24:
      return int24LEToFloat32(payload)
    case 32:
      return float32LEToFloat32(payload)
    default:
      throw new AppError('INVALID_PAYLOAD', {
        details: { op: 'analysis', reason: 'unsupported-bit-depth', bitDepth: format.bitDepth },
      })
  }
}

/** 一段音频的基本测量结果（`analysis:metrics` 的内容，不含 LUFS —— 那需要 ffmpeg） */
export interface WaveformMeasurement {
  durationMs: number
  peakDb: number | null
  rmsDb: number | null
  /** 单声道峰值是否触顶（|x| ≥ 0.99），自检与质检都要用 */
  clipping: boolean
}

export function measureWaveform(samples: Float32Array, format: AudioFormat): WaveformMeasurement {
  const empty = samples.length === 0
  let clipped = false
  // 逐样本看一次削波（与 docs/05 §2.5 的判定阈值一致：|x| ≥ 0.99）
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] as number) >= 0.99) {
      clipped = true
      break
    }
  }
  return {
    durationMs: format.sampleRate > 0 ? Math.round((samples.length / format.sampleRate) * 1000) : 0,
    peakDb: empty ? null : computePeakDb(samples),
    rmsDb: empty ? null : computeRmsDb(samples),
    clipping: clipped,
  }
}

export { WAV_HEADER_BYTES }

// ---------------------------------------------------------------------------
// 载荷级操作（不解码成 Float32，直接搬 PCM 字节）
// ---------------------------------------------------------------------------
//
// 为什么需要这一组：录音域的落库路径是「会话 WAV → 按区间剪出 take → 拼接补录」，
// 全程只需要搬运 PCM 字节。走 `readAudioFile`（解码成 Float32 再编码回位深）
// 会引入**可避免的精度损失**：24 位 → float32 → 24 位在数学上可逆，
// 但只要中间任何一步做了混音或增益（比如为了分析而下混单声道），
// 写回去的就是被改过的音频。剪裁与拼接必须是无损搬运。

export interface WavPayload {
  format: AudioFormat
  /** 纯 PCM 数据块（不含头） */
  payload: Buffer
  /** 帧数（每声道样本数） */
  frames: number
  durationMs: number
}

/** 读一段 WAV 的**原始 PCM 载荷**（格式必须是 WAV，否则明确报错） */
export async function readWavPayload(projectRoot: string, pathOrRelative: string): Promise<WavPayload> {
  const abs = resolveAudioPath(projectRoot, pathOrRelative)
  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch (e) {
    throw new AppError('FILE_NOT_FOUND', { cause: e, details: { path: abs } })
  }
  return parseWavPayload(buf, abs)
}

function parseWavPayload(buf: Buffer, abs: string): WavPayload {
  if (!isWav(buf)) {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        op: 'audio:readWavPayload',
        reason: 'unsupported-format',
        path: abs,
        hint: '录音与剪裁链路只处理 WAV；其它格式需要先经处理链（ffmpeg）转码',
      },
    })
  }
  const parsed = parseWavHeader(buf)
  const end = Math.min(buf.length, parsed.dataOffset + parsed.dataBytes)
  const payload = Buffer.from(buf.subarray(parsed.dataOffset, Math.max(parsed.dataOffset, end)))
  const blockAlign = parsed.format.channels * bytesPerSample(parsed.format.bitDepth)
  const frames = blockAlign > 0 ? Math.floor(payload.length / blockAlign) : 0
  return {
    format: parsed.format,
    payload,
    frames,
    durationMs: parsed.format.sampleRate > 0 ? Math.round((frames / parsed.format.sampleRate) * 1000) : 0,
  }
}

/**
 * 按毫秒区间切一段载荷（**按帧对齐**）。
 *
 * 对齐不是细节而是必须：截到半个帧会让后面所有采样错位，
 * 播放出来是「整段音频变成噪音」，而文件头是合法的 —— 这种损坏极难从现象反推原因。
 * 区间超过文件范围时按可用范围裁剪（不报错）：调用方可能拿着旧时长。
 */
export function slicePayload(payload: Buffer, format: AudioFormat, startMs: number, endMs: number): Buffer {
  const blockAlign = format.channels * bytesPerSample(format.bitDepth)
  if (blockAlign <= 0) return Buffer.alloc(0)
  const totalFrames = Math.floor(payload.length / blockAlign)
  const startFrame = Math.max(0, Math.min(totalFrames, Math.round((startMs / 1000) * format.sampleRate)))
  const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.round((endMs / 1000) * format.sampleRate)))
  return payload.subarray(startFrame * blockAlign, endFrame * blockAlign)
}

/** 把若干段载荷顺序写出一个 WAV（不重采样、不改位深；格式必须一致） */
export async function writeWavPayload(
  projectRoot: string,
  outRelative: string,
  format: AudioFormat,
  parts: readonly Buffer[],
): Promise<{ absolutePath: string; bytes: number; frames: number; durationMs: number }> {
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)))
  const abs = resolveAudioPath(projectRoot, outRelative)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, Buffer.concat([writeWavHeader({ dataBytes: body.length, format }), body]))
  const blockAlign = format.channels * bytesPerSample(format.bitDepth)
  const frames = blockAlign > 0 ? Math.floor(body.length / blockAlign) : 0
  return {
    absolutePath: abs,
    bytes: body.length + WAV_HEADER_BYTES,
    frames,
    durationMs: format.sampleRate > 0 ? Math.round((frames / format.sampleRate) * 1000) : 0,
  }
}

/** 剪出 `[startMs, endMs)` 区间写成新 WAV（`record:acceptSlices` 与补录的主刀） */
export async function extractWavRange(
  projectRoot: string,
  srcRelative: string,
  outRelative: string,
  startMs: number,
  endMs: number,
): Promise<{ format: AudioFormat; bytes: number; frames: number; durationMs: number; absolutePath: string }> {
  const src = await readWavPayload(projectRoot, srcRelative)
  const slice = slicePayload(src.payload, src.format, startMs, endMs)
  const written = await writeWavPayload(projectRoot, outRelative, src.format, [slice])
  return { format: src.format, ...written }
}

/**
 * 把一段 WAV 拷成另一段 WAV（成品片段是**独立文件**，见 docs/21 §6：`segments/{id}.wav`）。
 *
 * 为什么是「拷贝」而不是「引用 take 的文件路径」：
 *   · take 随时可能被硬删（`take:delete { hard: true }` 会删文件），成品不能跟着消失；
 *   · 处理链（降噪/归一化）的输出要写在 `processed/{id}.{presetHash}.wav`，
 *     而它的输入必须是**稳定**的成品文件，否则 apply → revert 的语义会乱。
 *   代价是磁盘上多一份音频：单行通常几秒，量级可接受（docs/03 §6 的非破坏性约定就是这么换来的）。
 */
export async function copyAudioFile(
  projectRoot: string,
  fromRelative: string,
  toRelative: string,
): Promise<{ absolutePath: string; bytes: number }> {
  const from = resolveAudioPath(projectRoot, fromRelative)
  const to = resolveAudioPath(projectRoot, toRelative)
  const buf = await readFile(from)
  await mkdir(dirname(to), { recursive: true })
  await writeFile(to, buf)
  return { absolutePath: to, bytes: buf.length }
}

export interface ConcatResult {
  format: AudioFormat
  frames: number
  durationMs: number
  bytes: number
}

/**
 * 按给定顺序拼接多个 WAV（同一格式），写出一个新 WAV，返回其格式与总时长。
 *
 * 用于 `take:combineParts`（超长行分段录 → 合并成一个成品，docs/12 §3.3）。
 *
 * ### 为什么要求**格式完全一致**
 *   拼接是「把 PCM 直接接起来」，采样率/位深/声道不同就必须重采样或改位深 ——
 *   那是处理链（ffmpeg）的活，不该在「合并分段」里偷偷做：
 *   偷偷做要么质量受损、要么引入 ffmpeg 依赖。所以格式不一致时**明确报错**
 *   （`reason: 'format-mismatch'`），让用户知道这几段录音的设备/设置不一致。
 *   而同一个会话里录出来的分段天然同格式（用同一份 `settings.audio`），正常路径不会触发它。
 */
export async function concatWavFiles(
  projectRoot: string,
  inputs: readonly string[],
  outRelative: string,
): Promise<ConcatResult> {
  if (inputs.length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { op: 'concatWavFiles', reason: 'no-inputs' } })
  }
  const parts: Array<{ payload: Buffer; format: AudioFormat }> = []
  let expected: AudioFormat | null = null
  for (const rel of inputs) {
    const abs = resolveAudioPath(projectRoot, rel)
    let buf: Buffer
    try {
      buf = await readFile(abs)
    } catch (e) {
      throw new AppError('FILE_NOT_FOUND', { cause: e, details: { path: abs } })
    }
    const parsed = parseWavHeader(buf)
    if (!parsed.valid || !isWav(buf)) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { op: 'concatWavFiles', reason: 'unsupported-format', path: abs },
      })
    }
    if (expected === null) expected = parsed.format
    else if (
      expected.sampleRate !== parsed.format.sampleRate ||
      expected.bitDepth !== parsed.format.bitDepth ||
      expected.channels !== parsed.format.channels
    ) {
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          op: 'concatWavFiles',
          reason: 'format-mismatch',
          expected,
          actual: parsed.format,
          path: abs,
          hint: '分段录音应当同采样率/位深/声道；不一致请先统一录音设置再合并',
        },
      })
    }
    const end = Math.min(buf.length, parsed.dataOffset + parsed.dataBytes)
    parts.push({ payload: Buffer.from(buf.subarray(parsed.dataOffset, Math.max(parsed.dataOffset, end))), format: parsed.format })
  }

  const format = expected as AudioFormat
  const body = Buffer.concat(parts.map((p) => p.payload))
  const outAbs = resolveAudioPath(projectRoot, outRelative)
  await mkdir(dirname(outAbs), { recursive: true })
  await writeFile(outAbs, Buffer.concat([writeWavHeader({ dataBytes: body.length, format }), body]))
  const blockAlign = format.channels * (format.bitDepth === 24 ? 3 : format.bitDepth === 16 ? 2 : 4)
  const frames = blockAlign > 0 ? Math.floor(body.length / blockAlign) : 0
  return {
    format,
    frames,
    durationMs: format.sampleRate > 0 ? Math.round((frames / format.sampleRate) * 1000) : 0,
    bytes: body.length,
  }
}
