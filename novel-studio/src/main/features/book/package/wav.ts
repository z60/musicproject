/**
 * Novel Studio · WAV 头解析（纯 Node，用于回传包的音频校验）
 * ============================================================================
 * 用途（docs/03 §9 合并规则 / docs/12 录音规范）：
 *   · 判断回传的音频是不是可用的 WAV（**损坏文件要跳过并记录**，不能让整包失败）
 *   · 读出采样率/位深/声道，与任务包的 `recordSettings` 比对，不符则记入质检查询
 *   · 计算时长（用于「未回传的行」「回传了但太短」的判断）
 *
 * 不做的事：不解码音频、不做响度测量（那属于 docs/05 的音频链路，由 ffmpeg 负责）。
 * 这里只读文件头，因此对几百 MB 的 WAV 也是常量开销。
 */

export interface WavInfo {
  /** 'WAVE_FORMAT_PCM'(1) / 'WAVE_FORMAT_EXTENSIBLE'(0xFFFE) / 其它 */
  audioFormat: number
  sampleRate: number
  channels: number
  /** 位深（fmt 块的 bitsPerSample） */
  bitDepth: number
  /** data 块字节数 */
  dataBytes: number
  /** 时长（毫秒；按 data 块大小估算） */
  durationMs: number
  extensible: boolean
}

/** 是否为 RIFF/WAVE 容器（只需前 12 字节） */
export function looksLikeWav(data: Uint8Array): boolean {
  if (data.byteLength < 12) return false
  return (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && // 'RIFF'
    data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45 // 'WAVE'
  )
}

/**
 * 解析 WAV 头。
 *
 * @returns 解析成功返回信息；不是 WAV 或结构不完整返回 null（调用方据此记为 corrupted）
 */
export function probeWav(data: Uint8Array): WavInfo | null {
  if (!looksLikeWav(data)) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  let offset = 12
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitDepth: number; extensible: boolean } | null = null
  let dataBytes: number | null = null

  while (offset + 8 <= data.byteLength) {
    const id = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > data.byteLength) {
      // 截断的数据块：data 块被截断时按剩余长度算，其它块直接放弃解析
      if (id === 'data') {
        dataBytes = data.byteLength - body
        break
      }
      break
    }

    if (id === 'fmt ' && size >= 16) {
      const audioFormat = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const sampleRate = view.getUint32(body + 4, true)
      const bitDepth = view.getUint16(body + 14, true)
      fmt = { audioFormat, channels, sampleRate, bitDepth, extensible: audioFormat === 0xfffe }
    } else if (id === 'data') {
      dataBytes = size
    }

    // 块大小为奇数时有一个填充字节
    offset = body + size + (size % 2)
    if (fmt && dataBytes !== null) break
  }

  if (!fmt || fmt.channels <= 0 || fmt.sampleRate <= 0) return null
  const bytes = dataBytes ?? Math.max(0, data.byteLength - 44)
  const bytesPerSecond = fmt.sampleRate * fmt.channels * Math.max(1, fmt.bitDepth / 8)
  return {
    audioFormat: fmt.audioFormat,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    dataBytes: bytes,
    durationMs: bytesPerSecond > 0 ? Math.round((bytes / bytesPerSecond) * 1000) : 0,
    extensible: fmt.extensible,
  }
}

export interface WavCompliance {
  ok: boolean
  issues: Array<{ kind: 'not-wav' | 'sample-rate' | 'bit-depth' | 'channels' | 'too-short' | 'empty'; message: string }>
}

/**
 * 与任务包的 `recordSettings` 比对（docs/03 §9）。
 * 只做**提示性**校验：不阻断归位（音频照样入库），但要在质检报告里列出来。
 */
export function checkWavCompliance(
  data: Uint8Array,
  expected: { sampleRate?: number; bitDepth?: number; channels?: number },
  options: { minDurationMs?: number } = {},
): WavCompliance {
  const issues: WavCompliance['issues'] = []
  if (data.byteLength === 0) {
    return { ok: false, issues: [{ kind: 'empty', message: '音频文件是 0 字节' }] }
  }
  const info = probeWav(data)
  if (!info) {
    return { ok: false, issues: [{ kind: 'not-wav', message: '不是可识别的 WAV 文件（文件头损坏）' }] }
  }
  if (expected.sampleRate !== undefined && info.sampleRate !== expected.sampleRate) {
    issues.push({
      kind: 'sample-rate',
      message: `采样率 ${info.sampleRate} Hz 与要求的 ${expected.sampleRate} Hz 不一致`,
    })
  }
  if (expected.bitDepth !== undefined && info.bitDepth !== expected.bitDepth) {
    issues.push({ kind: 'bit-depth', message: `位深 ${info.bitDepth} 与要求的 ${expected.bitDepth} 不一致` })
  }
  if (expected.channels !== undefined && info.channels !== expected.channels) {
    issues.push({ kind: 'channels', message: `声道数 ${info.channels} 与要求的 ${expected.channels} 不一致` })
  }
  const minDurationMs = options.minDurationMs ?? 0
  if (minDurationMs > 0 && info.durationMs < minDurationMs) {
    issues.push({ kind: 'too-short', message: `时长 ${info.durationMs} ms 短于最短要求 ${minDurationMs} ms` })
  }
  return { ok: issues.length === 0, issues }
}

/** 生成一段最小可用的 WAV 字节（测试与占位用；16 位 PCM 单声道） */
export function createSilentWav(options: {
  sampleRate: number
  channels?: number
  bitDepth?: number
  durationMs: number
}): Buffer {
  const channels = options.channels ?? 1
  const bitDepth = options.bitDepth ?? 24
  const bytesPerSample = bitDepth / 8
  const frames = Math.max(1, Math.round((options.durationMs / 1000) * options.sampleRate))
  const dataBytes = frames * channels * bytesPerSample
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(options.sampleRate, 24)
  buf.writeUInt32LE(options.sampleRate * channels * bytesPerSample, 28) // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32) // block align
  buf.writeUInt16LE(bitDepth, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}
