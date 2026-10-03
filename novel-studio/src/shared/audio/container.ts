/**
 * Novel Studio · 音频容器格式探测（零依赖纯逻辑）
 * ============================================================================
 * 设计依据：docs/05 §2（PCM 与 WAV 口径）、docs/91 §5.2.49
 *
 * ## 为什么必须有它（真实缺陷）
 *
 * 「按说话人导入音频」拿到的文件是 **mp3 / m4a / flac**，而项目内其它链路
 * （剪裁、测量、波形、处理链的输入）**只认 WAV** ——
 * `audio-file.ts` 的注释写得很清楚：「遇到非 WAV 文件时如实抛 `INVALID_PAYLOAD`」。
 *
 * 我第一版导入直接把源文件复制进项目、并**把扩展名写成 `.wav`**：
 *
 * ```
 *   imports/{时间戳}-{原名}.wav     ← 文件内容其实是 mp3
 * ```
 *
 * 后果：`readWavPayload` 按内容校验（`RIFF` + `WAVE` 魔数）会抛错，
 * 于是「设为成品 / 测量 / 波形」这些动作全部失败 ——
 * 而**扩展名看起来完全正确**，排查时很容易先怀疑别的地方。
 *
 * 所以：**格式必须按内容判断，不能信扩展名**。
 *
 * ## 真实样本的形态（实测，不是推测）
 *
 * 样本文件夹里 5 个 mp3 **全部以 ID3v2 标签开头**：
 *
 * ```
 *   4944330300000001100F545945520000…   ← "ID3\x03" + 版本 + 大小 + "TYER" 帧
 *   └─ ID3 ─┘
 * ```
 *
 * 也就是说：**MPEG 帧同步（`0xFFEx`）不在文件开头**，
 * 而在 ID3 标签之后。所以探测必须能跳过 ID3 标签，否则会把它们判成「未知格式」。
 *
 * 本目录禁止引入任何第三方依赖。
 */

/** 探测到的容器格式 */
export type AudioContainer =
  | 'wav'
  | 'mp3'
  | 'flac'
  | 'ogg'
  | 'm4a'
  | 'aiff'
  | 'aac'
  | 'wma'
  | 'unknown'

export interface AudioProbeResult {
  container: AudioContainer
  /** 该容器能否被**项目内的音频链路直接读取**（目前只有 WAV 可以） */
  readableAsWav: boolean
  /**
   * 从哪个偏移开始是**真正的音频数据**。
   * MP3 的 ID3v2 标签会在这里被跳过；其它格式通常为 0。
   */
  audioDataOffset: number
  /** 判定依据（便于日志与排查，不猜） */
  evidence: string
}

/** ID3v2 头固定 10 字节；大小字段是 4 个「同步安全」字节（每字节只用低 7 位） */
const ID3_HEADER_BYTES = 10

/**
 * 读 ID3v2 标签总长度（含 10 字节头）。
 *
 * ID3v2 的大小是 **syncsafe integer**：每字节只用低 7 位
 * （这样大小字段本身不会出现 `0xFF`，避免与帧同步混淆）。
 * 按普通 32 位整数读会得到一个偏大的错值。
 *
 * @returns 标签总字节数；不是 ID3v2 或长度非法时返回 0
 */
export function readId3v2Size(buf: Uint8Array): number {
  if (buf.length < ID3_HEADER_BYTES) return 0
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0 // "ID3"
  // 版本号必须不是 0xFF（保留值）
  if (buf[3] === 0xff || buf[4] === 0xff) return 0
  const b = buf[6]!
  const c = buf[7]!
  const d = buf[8]!
  const e = buf[9]!
  if ((b | c | d | e) & 0x80) return 0 // 高位必须是 0（否则不是 syncsafe）
  const size = (b << 21) | (c << 14) | (d << 7) | e
  return ID3_HEADER_BYTES + size
}

function asciiAt(buf: Uint8Array, offset: number, len: number): string {
  if (offset + len > buf.length) return ''
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]!)
  return s
}

/** MPEG 音频帧同步：11 个 1（`0xFF` 后跟高 3 位为 1 的字节） */
function looksLikeMpegFrame(buf: Uint8Array, at: number): boolean {
  if (at + 1 >= buf.length) return false
  if (buf[at] !== 0xff) return false
  return (buf[at + 1]! & 0xe0) === 0xe0
}

/**
 * 按**内容**探测音频容器格式。
 *
 * 判据全部是魔数（不依赖扩展名、不依赖 ffprobe）：
 *
 * | 容器 | 魔数 |
 * |------|------|
 * | WAV  | `RIFF` … `WAVE` |
 * | FLAC | `fLaC` |
 * | OGG  | `OggS` |
 * | M4A  | `ftyp`（偏移 4） |
 * | AIFF | `FORM` … `AIFF`/`AIFC` |
 * | WMA  | GUID `30 26 B2 75 8E 66 CF 11` |
 * | AAC  | `ADTS` 帧同步 `0xFFF`（无 ID3 时） |
 * | MP3  | `ID3` 标签开头，或 MPEG 帧同步 |
 */
export function probeAudioContainer(buf: Uint8Array): AudioProbeResult {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)

  // ── 无损/容器格式：魔数在开头，最直接 ────────────────────────────────────
  if (u8.length >= 12 && asciiAt(u8, 0, 4) === 'RIFF' && asciiAt(u8, 8, 4) === 'WAVE') {
    return { container: 'wav', readableAsWav: true, audioDataOffset: 0, evidence: 'RIFF…WAVE 魔数' }
  }
  if (asciiAt(u8, 0, 4) === 'fLaC') {
    return { container: 'flac', readableAsWav: false, audioDataOffset: 0, evidence: 'fLaC 魔数' }
  }
  if (asciiAt(u8, 0, 4) === 'OggS') {
    return { container: 'ogg', readableAsWav: false, audioDataOffset: 0, evidence: 'OggS 魔数' }
  }
  if (asciiAt(u8, 4, 4) === 'ftyp') {
    return { container: 'm4a', readableAsWav: false, audioDataOffset: 0, evidence: '偏移 4 处 ftyp 盒' }
  }
  if (asciiAt(u8, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(asciiAt(u8, 8, 4))) {
    return { container: 'aiff', readableAsWav: false, audioDataOffset: 0, evidence: 'FORM…AIFF 魔数' }
  }
  // WMA（ASF 容器）GUID 前 8 字节
  const asfGuid = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]
  if (u8.length >= 8 && asfGuid.every((v, i) => u8[i] === v)) {
    return { container: 'wma', readableAsWav: false, audioDataOffset: 0, evidence: 'ASF GUID' }
  }

  // ── MP3：ID3v2 标签开头，或裸 MPEG 帧同步 ────────────────────────────────
  const id3Size = readId3v2Size(u8)
  if (id3Size > 0) {
    // 标签之后应当是帧同步；不是也仍然算 mp3（标签合法就足够判定了）
    const after = id3Size
    const hasSync = looksLikeMpegFrame(u8, after)
    return {
      container: 'mp3',
      readableAsWav: false,
      audioDataOffset: after,
      evidence: hasSync
        ? `ID3v2 标签（${id3Size} 字节）+ 其后 ${after} 处 MPEG 帧同步`
        : `ID3v2 标签（${id3Size} 字节）`,
    }
  }
  // ── ADTS AAC 必须先判（它的帧同步是 mp3 帧同步的**子集**）──────────────
  //     ADTS：`0xFF` + 高 4 位为 1 + **低 2 位为 0**（12 个同步位）
  //     MPEG：`0xFF` + 高 3 位为 1（11 个同步位）
  //     ⇒ `0xFF01` 两者都匹配，但 `0xFFFB`（MPEG layer III）只匹配 MPEG。
  //     所以先按更窄的 ADTS 判，剩下才归 mp3 —— 顺序反了会把 AAC 误判成 mp3。
  //     （第一版就是这个顺序问题，被测试抓出来。）
  if (u8.length >= 2 && u8[0] === 0xff && (u8[1]! & 0xf6) === 0xf0) {
    return { container: 'aac', readableAsWav: false, audioDataOffset: 0, evidence: 'ADTS 帧同步' }
  }

  if (looksLikeMpegFrame(u8, 0)) {
    return { container: 'mp3', readableAsWav: false, audioDataOffset: 0, evidence: '偏移 0 处 MPEG 帧同步' }
  }

  return {
    container: 'unknown',
    readableAsWav: false,
    audioDataOffset: 0,
    evidence: `无法识别的头：${Array.from(u8.subarray(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')}`,
  }
}

/**
 * 该容器能否直接走项目内的音频链路（WAV-only）。
 *
 * 单独抽出来是因为调用方需要「先判断、再给清晰的错误」，
 * 而不是等 `readWavPayload` 抛一个泛化的 `INVALID_PAYLOAD`。
 */
export function isDirectlyReadable(container: AudioContainer): boolean {
  return container === 'wav'
}

/** 面向用户的可读名称（错误提示里用） */
export function containerLabel(container: AudioContainer): string {
  switch (container) {
    case 'wav':
      return 'WAV'
    case 'mp3':
      return 'MP3'
    case 'flac':
      return 'FLAC'
    case 'ogg':
      return 'OGG'
    case 'm4a':
      return 'M4A/AAC'
    case 'aiff':
      return 'AIFF'
    case 'aac':
      return 'AAC'
    case 'wma':
      return 'WMA'
    default:
      return '未知格式'
  }
}
