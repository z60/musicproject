/**
 * Novel Studio · 文本编码嗅探与解码
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md
 *   · §4.1 判定顺序（BOM → 严格 UTF-8 → 嗅探 → 中文场景修正 → 打分 → 让用户选）
 *   · §4.1 第 5 步 打分规则（汉字/中文标点 +2、ASCII 可见 +1、控制字符 -10、U+FFFD -20）
 *   · §4.2 为什么必须把 GBK 升级到 GB18030（中文小说导入最容易踩的坑）
 *   · §4.3 EncodingDetection 接口与 needsUserChoice 语义
 *   · §4.4 常见异常（ï»¿ / ???? / 混合编码 / 锟斤拷）
 *
 * 零第三方依赖：
 *   · 判定逻辑（BOM、严格 UTF-8 校验、合理字符打分、GBK→GB18030 升级）全部自实现。
 *   · 解码走 Node 内置的 WHATWG `TextDecoder`：utf-8 / utf-16le / utf-16be 必然可用；
 *     gb18030 / big5 / shift_jis / euc-kr 在 full-ICU 构建（Node 官方二进制默认）下也可用。
 *   · 若运行环境缺该编码（small-icu 构建、UTF-32 等），`createDecoder` 返回 null，
 *     此时由调用方注入实现 —— 生产环境用 `iconv-lite`：
 *       const decoder: Decoder = (buf) => iconv.decode(buf, 'gb18030')
 *     注入入口：`detectEncoding(buf, { decoders: { GB18030: decoder } })`
 *               与 `txt.parser.ts` 的 `input.decoder`。
 */

import { Buffer } from 'node:buffer'

import type { EncodingDetection } from '../types.ts'
import { BOM_TABLE, ENCODING_CANDIDATES, ENCODING_UPGRADE } from '../constants.ts'

// ============================================================================
// 类型
// ============================================================================

/**
 * 解码器：把字节解成字符串；返回 null 表示「本环境不支持该编码」。
 * 约定：解码器不抛异常，非法字节自行替换（UTF-8 用 U+FFFD），以便打分环节识别乱码。
 *
 * `stream`（可选）用于**大文件分块解码**（docs/10 §8.1：50 MB 以上建议分块解码后拼接）：
 * 调用方按块喂入，解码器内部保持跨块状态，因此多字节字符在块边界被切开也不会出错。
 * 注入型解码器（iconv-lite）若不提供 `stream`，则只对 UTF-8 / UTF-16 做边界对齐，
 * 其它编码退化为整块解码（见 txt.parser.ts 的说明）。
 */
export interface Decoder {
  (buf: Buffer): string | null
  /** 流式解码；flush=true 时冲刷残留字节。未提供则调用方按块对齐规则处理 */
  stream?: (buf: Buffer, flush?: boolean) => string | null
}

/**
 * 启发式嗅探器（可选注入）。生产环境用 `chardet`：
 *   const sniffer: EncodingSniffer = { detect: (buf) => chardet.detect(buf) }
 * chardet 返回 `{ encoding: string; confidence: number } | null`，这里统一成数组（可给多个候选）。
 */
export interface EncodingSniffer {
  detect(buf: Buffer): Array<{ encoding: string; confidence: number }> | null
}

export interface DetectOptions {
  /** 候选编码列表，默认 `ENCODING_CANDIDATES`；GBK/GB2312 会自动按 ENCODING_UPGRADE 升级为 GB18030 */
  candidates?: readonly string[]
  /** 打分只取前 N 字节（默认 64 KB，docs/10 §4.1 第 3 步取前 512 KB，这里取更小值以省内存） */
  sampleBytes?: number
  /** 预览片段截取字符数（默认 200，docs/10 §4.3 的「前 200 字预览」） */
  previewChars?: number
  /** 注入解码器（按编码名覆盖内置实现，例如 iconv-lite） */
  decoders?: Record<string, Decoder>
  /** 注入启发式嗅探器（生产环境用 chardet） */
  sniffer?: EncodingSniffer
  /** 置信度阈值，低于它则 needsUserChoice=true（默认 0.7，docs/10 §4.3） */
  confidenceThreshold?: number
}

/** 单次打分的明细，便于测试与排查（不进入 EncodingDetection，避免污染契约类型） */
export interface ScoreMetrics {
  /** 参与打分的字符数（码点计） */
  chars: number
  score: number
  cjk: number
  asciiVisible: number
  control: number
  replacement: number
}

// ============================================================================
// 常量
// ============================================================================

/** 默认取样的前缀字节数（编码判定只依赖前缀，见 docs/10 §4.1 第 3 步） */
export const DEFAULT_SAMPLE_BYTES = 64 * 1024

/** 预览字符数（docs/10 §4.3） */
export const DEFAULT_PREVIEW_CHARS = 200

/** 不确信阈值（docs/10 §4.3：confidence < 0.7 时高亮提示用户确认） */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7

/** 无可用解码器时 preview 里的说明（不编造内容，如实告知） */
export const NO_DECODER_NOTE = '（本环境无此编码的解码器，无法生成预览；可注入 iconv-lite 实现）'

/** 汉字区间（含扩展 A/B 与兼容表意文字） */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2ebef],
]

/** 中文标点与常见全角符号（docs/10 §4.1 第 5 步「中文标点 +2」） */
const CN_PUNCT = new Set(
  Array.from('，。、；：？！“”‘’（）《》〈〉【】「」『』〔〕—…·～￥％＃＠＆＊＋－／＝'),
)

/**
 * 简体专用高频字（用于 GB18030 / Big5 的脚本判别，docs/10 §4.1 第 4 步
 * 「若候选为 Big5 但文本中出现简体常用字高频特征 → 尝试 GB18030 并比较合理字符比例」）。
 * 只收「简体有、繁体无（或极少见）」的字，宁可少收也不要误判。
 */
const SIMPLIFIED_MARKERS = '这个们说时为国会发后里对开无与书车东门见马长话间问题点样记让边听飞风岁岛币贝页华书写语认识别经历严师归处备'
/** 繁体专用高频字 */
const TRADITIONAL_MARKERS = '這個們說時為國會發後裡對開無與書車東門見馬長話間問題點樣記讓邊聽飛風歲島幣貝頁華書寫語認識別經歷嚴師歸處備'

/** 控制字符（除 \n \t \r）与 U+FFFD 的扣分（docs/10 §4.1 第 5 步） */
const PENALTY_CONTROL = -10
const PENALTY_REPLACEMENT = -20
const BONUS_CJK = 2
const BONUS_ASCII_VISIBLE = 1

/** 嗅探先验的等价权重（置信度 1.0 时相当于 2 分，即一个汉字） */
const PRIOR_WEIGHT = 2

/** 简体/繁体特征字的权重与上限（中文场景判别项，docs/10 §4.1 第 4 步） */
const AFFINITY_WEIGHT = 3
const AFFINITY_CAP = 60

/** 领先程度达到「每字 2 分」（一个汉字的满分）即视为判别充分 */
const GAP_FULL_SCORE = 2

// ============================================================================
// 小工具
// ============================================================================

/** 把 Uint8Array / Buffer 统一成 Buffer（零拷贝视图） */
function toBuffer(input: Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(input)) return input
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 编码名归一：去空白/下划线、统一大写，并套用 ENCODING_UPGRADE（GBK→GB18030） */
export function normalizeEncodingName(name: string): string {
  const cleaned = name.trim().replace(/[_\s]/g, '-')
  const upgrade = ENCODING_UPGRADE[cleaned] ?? ENCODING_UPGRADE[cleaned.toUpperCase()] ?? ENCODING_UPGRADE[cleaned.toLowerCase()]
  const base = upgrade ?? cleaned
  const upper = base.toUpperCase()
  switch (upper) {
    case 'UTF8':
    case 'UTF-8':
      return 'UTF-8'
    case 'UTF-16':
    case 'UTF16':
    case 'UTF-16LE':
      return 'UTF-16LE'
    case 'UTF-16BE':
      return 'UTF-16BE'
    case 'UTF-32LE':
      return 'UTF-32LE'
    case 'UTF-32BE':
      return 'UTF-32BE'
    case 'GB18030':
    case 'GBK':
    case 'GB2312':
    case 'X-GBK':
      // docs/10 §4.2：GBK/GB2312 一律升级为 GB18030（GBK 是 GB18030 的子集）
      return 'GB18030'
    case 'BIG5':
    case 'BIG-5':
      return 'Big5'
    case 'SHIFT-JIS':
    case 'SHIFTJIS':
    case 'SJIS':
      return 'Shift_JIS'
    case 'EUC-KR':
      return 'EUC-KR'
    default:
      return base
  }
}

// ============================================================================
// BOM（docs/10 §4.1 第 1 步）
// ============================================================================

export interface BomMatch {
  encoding: string
  bomLength: number
}

/**
 * 按 `BOM_TABLE` 顺序匹配 BOM（顺序即优先级：FF FE 00 00 必须在 FF FE 之前）。
 * @returns 命中则返回编码与 BOM 字节长度，否则 null
 */
export function matchBom(bytes: Uint8Array): BomMatch | null {
  for (const entry of BOM_TABLE) {
    if (bytes.length < entry.bytes.length) continue
    let hit = true
    for (let i = 0; i < entry.bytes.length; i++) {
      if (bytes[i] !== entry.bytes[i]) {
        hit = false
        break
      }
    }
    if (!hit) continue
    // docs/10 §4.1：FF FE 后随非 00 才是 UTF-16LE —— UTF-32LE 已在上一条被截走，
    // 但 FF FE 00 xx（xx≠00）不是合法 UTF-32LE，回退为 UTF-16LE。
    if (entry.encoding === 'UTF-32LE' && bytes.length >= 4 && bytes[3] !== 0x00) continue
    return { encoding: entry.encoding, bomLength: entry.bytes.length }
  }
  return null
}

// ============================================================================
// 严格 UTF-8 校验（docs/10 §4.1 第 2 步）
// ============================================================================

/**
 * 严格 UTF-8 字节校验：拒绝过长编码、代理区码点、越界码点、截断序列。
 * 只做字节层校验（不解码），因此可以安全地跑在 200 MB 文件上。
 * @returns true = 全程无非法序列（可以按 UTF-8 解码）
 */
export function isStrictUtf8(bytes: Uint8Array): boolean {
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]!
    if (b < 0x80) {
      i++
      continue
    }
    let need: number
    let cp: number
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1
      cp = b & 0x1f
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2
      cp = b & 0x0f
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3
      cp = b & 0x07
    } else {
      // 0x80~0xC1、0xF5~0xFF 一律非法
      return false
    }
    if (i + need >= bytes.length) return false
    for (let k = 1; k <= need; k++) {
      const t = bytes[i + k]!
      if ((t & 0xc0) !== 0x80) return false
      cp = (cp << 6) | (t & 0x3f)
    }
    if (cp > 0x10ffff) return false
    if (cp >= 0xd800 && cp <= 0xdfff) return false
    if (need === 2 && cp < 0x800) return false
    if (need === 3 && cp < 0x10000) return false
    i += need + 1
  }
  return true
}

// ============================================================================
// UTF-16 无 BOM 的结构启发式（docs/10 §4.1 的补充信号）
// ============================================================================

export interface Utf16Guess {
  encoding: 'UTF-16LE' | 'UTF-16BE'
  nulRatio: number
  parityRatio: number
}

/**
 * 无 BOM 的 UTF-16 判定：ASCII 字符在 UTF-16 里占 2 字节，其中一个是 0x00。
 * UTF-16LE 的 ASCII 是「低位在前」→ 0x00 落在**奇数**下标；UTF-16BE 则落在偶数下标。
 * 若 0x00 占比 ≥ 10% 且 ≥ 80% 的 0x00 落在同一奇偶位，即判为对应端序。
 *
 * 说明：docs/10 §4.1 只写了「BOM 是 UTF-16 的最强信号」，但现实中确有被去掉 BOM 的
 * UTF-16 文本（记事本「另存为 Unicode」后再被工具处理）。该启发式必须在「严格 UTF-8
 * 校验」之前跑，因为含大量 0x00 的字节流本身是合法 UTF-8，会被误判成 UTF-8。
 */
export function guessUtf16ByNulParity(bytes: Uint8Array): Utf16Guess | null {
  if (bytes.length < 8) return null
  let nulEven = 0
  let nulOdd = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x00) continue
    if (i % 2 === 0) nulEven++
    else nulOdd++
  }
  const nulTotal = nulEven + nulOdd
  const nulRatio = nulTotal / bytes.length
  if (nulRatio < 0.1) return null
  const parityRatio = Math.max(nulEven, nulOdd) / nulTotal
  if (parityRatio < 0.8) return null
  return {
    // 0x00 在奇位 → UTF-16LE（低位字节在前）
    encoding: nulOdd > nulEven ? 'UTF-16LE' : 'UTF-16BE',
    nulRatio,
    parityRatio,
  }
}

// ============================================================================
// 解码器
// ============================================================================

/** WHATWG 标签映射（Node 的 TextDecoder 接受这些标签；GBK/GB2312 会归一到 gbk，效果等价 GB18030 子集） */
const TEXT_DECODER_LABELS: Record<string, string> = {
  'UTF-8': 'utf-8',
  'UTF-16LE': 'utf-16le',
  'UTF-16BE': 'utf-16be',
  GB18030: 'gb18030',
  Big5: 'big5',
  'Shift_JIS': 'shift_jis',
  'EUC-KR': 'euc-kr',
}

/**
 * 内置解码器：仅依赖 Node 的 `TextDecoder`（WHATWG Encoding 标准）。
 *
 * | 编码 | 内置支持 |
 * |------|----------|
 * | UTF-8 / UTF-16LE / UTF-16BE | 必然可用（Node 核心要求） |
 * | GB18030 / Big5 / Shift_JIS / EUC-KR | full-ICU 构建可用（Node 官方二进制默认） |
 * | UTF-32LE / UTF-32BE | **不可用** → 返回 null |
 *
 * @returns 解码器；返回 null 表示本环境不支持（见 NO_DECODER_NOTE），
 *          生产环境应注入 `iconv-lite` 实现。
 */
export function createBuiltinDecoder(encoding: string): Decoder | null {
  const name = normalizeEncodingName(encoding)
  const label = TEXT_DECODER_LABELS[name]
  if (!label) return null
  let decoder: InstanceType<typeof TextDecoder>
  try {
    // fatal=false：非法字节替换为 U+FFFD，交给打分环节识别（而不是直接抛错）
    decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true })
  } catch {
    return null
  }
  // 独立的流式实例：分块解码时保持跨块状态（docs/10 §8.1）
  let streaming: InstanceType<typeof TextDecoder>
  try {
    streaming = new TextDecoder(label, { fatal: false, ignoreBOM: true })
  } catch {
    streaming = decoder
  }
  const fn = ((buf: Buffer): string | null => {
    try {
      return decoder.decode(buf)
    } catch {
      return null
    }
  }) as Decoder
  fn.stream = (buf: Buffer, flush = false): string | null => {
    try {
      return streaming.decode(buf, { stream: !flush })
    } catch {
      return null
    }
  }
  return fn
}

/**
 * 取得某编码的解码器：注入的 decoders 优先，其次内置 `TextDecoder`。
 * @param encoding 编码名（GBK/GB2312 会被归一为 GB18030）
 * @param decoders 注入表（例如 `{ GB18030: (buf) => iconv.decode(buf, 'gb18030') }`）
 * @returns 解码器，或 null（本环境不支持且未注入 → 调用方应抛 ENCODING_DECODE_FAILED）
 */
export function createDecoder(encoding: string, decoders?: Record<string, Decoder>): Decoder | null {
  const name = normalizeEncodingName(encoding)
  // 注入表里写 GBK / gbk 也算数：它们解码目标就是 GB18030（docs/10 §4.2）
  const injected =
    decoders?.[name] ??
    decoders?.[encoding] ??
    decoders?.[encoding.toUpperCase()] ??
    (name === 'GB18030' ? decoders?.['GBK'] ?? decoders?.['gbk'] : undefined)
  if (injected) return injected
  return createBuiltinDecoder(name)
}

// ============================================================================
// 合理字符打分（docs/10 §4.1 第 5 步）
// ============================================================================

function isCjk(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

/**
 * 计算「合理字符得分」（docs/10 §4.1 第 5 步）：
 *   汉字 / 中文标点 +2，ASCII 可见 +1，控制字符（除 \n \t） -10，U+FFFD -20，其他 0。
 * @param text 已解码文本（可含 U+FFFD）
 * @returns 明细；score 为累计得分
 */
export function scoreText(text: string): ScoreMetrics {
  let chars = 0
  let score = 0
  let cjk = 0
  let asciiVisible = 0
  let control = 0
  let replacement = 0
  for (const ch of text) {
    chars++
    const cp = ch.codePointAt(0)!
    if (cp === 0xfffd) {
      replacement++
      score += PENALTY_REPLACEMENT
      continue
    }
    if (cp === 0x0a || cp === 0x09 || cp === 0x0d) continue
    if (cp < 0x20 || cp === 0x7f) {
      control++
      score += PENALTY_CONTROL
      continue
    }
    if (isCjk(cp) || CN_PUNCT.has(ch)) {
      cjk++
      score += BONUS_CJK
      continue
    }
    if (cp >= 0x20 && cp <= 0x7e) {
      asciiVisible++
      score += BONUS_ASCII_VISIBLE
      continue
    }
  }
  return { chars, score, cjk, asciiVisible, control, replacement }
}

/** 脚本判别：简体特征字命中数 - 繁体特征字命中数（docs/10 §4.1 第 4 步） */
export function scriptAffinity(text: string): { simplified: number; traditional: number; net: number } {
  let simplified = 0
  let traditional = 0
  for (const ch of text) {
    if (SIMPLIFIED_MARKERS.includes(ch)) simplified++
    else if (TRADITIONAL_MARKERS.includes(ch)) traditional++
  }
  return { simplified, traditional, net: simplified - traditional }
}

// ============================================================================
// 主入口：detectEncoding（docs/10 §4.1）
// ============================================================================

interface CandidateScore {
  encoding: string
  /** 排序用总分 = 合理字符得分 + 脚本修正 + 嗅探先验加成 */
  score: number
  /** 纯文本「纯净度」= 合理字符得分 / 理论上限（乱码会迅速掉到 1 以下） */
  purity: number
  /** 参与打分的字符数（用于把领先优势折算成「分/字」） */
  chars: number
  preview: string
  available: boolean
}

function makeCandidate(
  encoding: string,
  sample: Buffer,
  decoders: Record<string, Decoder> | undefined,
  previewChars: number,
  prior: number,
): CandidateScore {
  const unavailable: CandidateScore = {
    encoding,
    score: Number.NEGATIVE_INFINITY,
    purity: 0,
    chars: 0,
    preview: NO_DECODER_NOTE,
    available: false,
  }
  const decoder = createDecoder(encoding, decoders)
  if (!decoder) return unavailable
  let text: string | null
  try {
    text = decoder(sample)
  } catch {
    text = null
  }
  if (text === null) return unavailable
  const metrics = scoreText(text)
  const plausibleMax = Math.max(1, BONUS_CJK * metrics.cjk + BONUS_ASCII_VISIBLE * metrics.asciiVisible)
  const purity = clamp(metrics.score / plausibleMax, 0, 1)
  let score = metrics.score
  // 简体/繁体特征修正：GB18030 候选看简体特征，Big5 候选看繁体特征（docs/10 §4.1 第 4 步）。
  // 这是中文场景下 GB18030 与 Big5 的**决定性判别项**，因此权重高于单个字符得分。
  const affinity = scriptAffinity(text)
  const affinityAdj = Math.max(-AFFINITY_CAP, Math.min(AFFINITY_CAP, affinity.net * AFFINITY_WEIGHT))
  if (encoding === 'GB18030') score += affinityAdj
  else if (encoding === 'Big5') score -= affinityAdj
  score += prior * PRIOR_WEIGHT
  const preview = text.replace(/^\uFEFF/, '').slice(0, previewChars)
  return { encoding, score, purity, chars: metrics.chars, preview, available: true }
}

/**
 * 编码嗅探（docs/10 §4.1 的 6 步判定顺序）。
 *
 * 判定顺序：
 *   1. BOM（最强信号，顺带得到 bomLength）
 *   2. 无 BOM 的 UTF-16 结构启发式（0x00 奇偶分布，见 guessUtf16ByNulParity）
 *   3. 严格 UTF-8 校验（全程合法且无 U+FFFD → UTF-8）
 *   4. 候选评分（含嗅探器注入、GBK→GB18030 升级、简体/繁体特征修正）
 *   5. 不确信（confidence < 阈值）→ needsUserChoice = true，由 UI 让用户选（docs/10 §4.3）
 *
 * @param buf 原始字节（至少包含前缀若干字节即可判定）
 * @param options 可选：候选列表、采样字节数、预览长度、注入解码器/嗅探器、置信度阈值
 * @returns EncodingDetection（永远不会抛错；无法判定时返回最佳候选 + needsUserChoice=true）
 */
export function detectEncoding(buf: Uint8Array | Buffer, options?: DetectOptions): EncodingDetection {
  const bytes = toBuffer(buf)
  const previewChars = options?.previewChars ?? DEFAULT_PREVIEW_CHARS
  const threshold = options?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  const sampleBytes = options?.sampleBytes ?? DEFAULT_SAMPLE_BYTES
  const sample = bytes.length > sampleBytes ? bytes.subarray(0, sampleBytes) : bytes

  // ① BOM
  const bom = matchBom(bytes)
  if (bom) {
    const cand = makeCandidate(bom.encoding, sample.subarray(bom.bomLength), options?.decoders, previewChars, 1)
    return {
      encoding: bom.encoding,
      confidence: cand.available ? 1 : 0.5,
      candidates: [{ encoding: cand.encoding, score: cand.available ? cand.score : 0, preview: cand.preview }],
      bomLength: bom.bomLength,
      // BOM 判定本身是确定的；但若本环境没有该编码的解码器，流程必须让用户介入
      // （换来源 / 注入解码器），否则下一步必然 ENCODING_DECODE_FAILED。
      needsUserChoice: !cand.available,
    }
  }

  // 空文件：合法 UTF-8（调用方应在上游拦截「空文件」）
  if (bytes.length === 0) {
    return { encoding: 'UTF-8', confidence: 1, candidates: [], bomLength: 0, needsUserChoice: false }
  }

  // ② 无 BOM 的 UTF-16
  const utf16 = guessUtf16ByNulParity(bytes)
  if (utf16) {
    const cand = makeCandidate(utf16.encoding, sample, options?.decoders, previewChars, 0)
    const utf8Cand = makeCandidate('UTF-8', sample, options?.decoders, previewChars, 0)
    if (cand.available && cand.score > 0 && cand.score > utf8Cand.score) {
      return {
        encoding: utf16.encoding,
        confidence: clamp(0.8 + utf16.parityRatio * 0.15, 0, 0.95),
        candidates: [{ encoding: cand.encoding, score: cand.score, preview: cand.preview }],
        bomLength: 0,
        needsUserChoice: false,
      }
    }
  }

  // ③ 严格 UTF-8
  if (isStrictUtf8(bytes)) {
    const decoder = createDecoder('UTF-8', options?.decoders)
    const text = decoder ? decoder(sample) ?? '' : ''
    const metrics = scoreText(text)
    const preview = text.replace(/^\uFEFF/, '').slice(0, previewChars)
    if (metrics.replacement === 0) {
      return {
        encoding: 'UTF-8',
        confidence: 0.98,
        candidates: [{ encoding: 'UTF-8', score: metrics.score, preview }],
        bomLength: 0,
        needsUserChoice: false,
      }
    }
    // 字节合法但文本里已有 U+FFFD：多半是「被错误转码过一次」的产物（docs/10 §4.4「锟斤拷」）
    return {
      encoding: 'UTF-8',
      confidence: 0.6,
      candidates: [{ encoding: 'UTF-8', score: metrics.score, preview }],
      bomLength: 0,
      needsUserChoice: true,
    }
  }

  // ④ 候选评分
  const priors = new Map<string, number>()
  const sniffed = options?.sniffer?.detect(sample) ?? null
  if (sniffed) {
    for (const item of sniffed) {
      if (!item || typeof item.encoding !== 'string') continue
      const name = normalizeEncodingName(item.encoding)
      const conf = clamp(Number(item.confidence) || 0, 0, 1)
      priors.set(name, Math.max(priors.get(name) ?? 0, conf))
    }
  }
  // 候选表：嗅探结果在前（有先验），再补 ENCODING_CANDIDATES（保序去重）
  const ordered: string[] = []
  for (const name of priors.keys()) ordered.push(name)
  for (const name of options?.candidates ?? ENCODING_CANDIDATES) {
    const norm = normalizeEncodingName(name)
    if (!ordered.includes(norm)) ordered.push(norm)
  }

  const scored: CandidateScore[] = []
  for (const name of ordered) {
    scored.push(makeCandidate(name, sample, options?.decoders, previewChars, priors.get(name) ?? 0))
  }

  const usable = scored.filter((c) => c.available)
  if (usable.length === 0) {
    // 一个可用的解码器都没有：如实返回，让用户/调用方处理（不假装成功）
    return {
      encoding: normalizeEncodingName(ordered[0] ?? 'UTF-8'),
      confidence: 0,
      candidates: scored.slice(0, 3).map((c) => ({ encoding: c.encoding, score: 0, preview: c.preview })),
      bomLength: 0,
      needsUserChoice: true,
    }
  }

  const ranked = [...usable].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // 并列时用候选顺序（ENCODING_CANDIDATES 里 GB18030 在 Big5 之前，符合中文场景优先）
    return ordered.indexOf(a.encoding) - ordered.indexOf(b.encoding)
  })
  const best = ranked[0]!
  const second = ranked[1]

  // 置信度 = 纯净度 × (0.6 + 0.4 × 领先程度)
  //   · 纯净度：乱码会产生大量 U+FFFD/控制字符，纯净度立刻掉下来
  //   · 领先程度：把「与次优的分差」折算成「分/字」，每字领先 2 分（一个汉字的满分）即视为充分
  const perCharLead = second ? (best.score - second.score) / Math.max(1, best.chars) : Number.POSITIVE_INFINITY
  const lead = clamp(perCharLead / GAP_FULL_SCORE, 0, 1)
  let confidence = clamp(best.purity * (0.6 + 0.4 * lead), 0, 1)
  if (best.score <= 0) confidence = 0
  // 只有一个可用候选时不要给满信心
  if (!second) confidence = Math.min(confidence, best.purity)

  const needsUserChoice = best.score <= 0 || confidence < threshold

  return {
    encoding: best.encoding,
    confidence: Number(confidence.toFixed(4)),
    candidates: ranked.slice(0, 3).map((c) => ({
      encoding: c.encoding,
      score: Number.isFinite(c.score) ? Math.round(c.score) : 0,
      preview: c.preview,
    })),
    bomLength: 0,
    needsUserChoice,
  }
}

// ============================================================================
// 文本归一化辅助
// ============================================================================

/**
 * 剥离文本开头的 BOM（U+FEFF）。
 * 字节层的 BOM 由 `matchBom` 给出长度，解码后通常表现为首个 U+FEFF；
 * docs/10 §4.4：「文件开头是 ï»¿」= 被当成 UTF-8 读的 BOM，必须剥离。
 * @param text 已解码文本
 * @returns 去掉首个 U+FEFF 的文本（只有开头那个，正文中的零宽不在这里处理，见 clean.ts）
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 统一换行：`\r\n | \r` → `\n`（docs/10 §3 第 ③ 步）。
 * @param text 任意换行风格的文本
 * @returns 全部为 `\n` 的文本
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r/g, '\n')
}

/**
 * 与 `normalizeNewlines` 相同，但返回替换次数（清洗报告需要 `normalizedNewlines`，docs/10 §5.3）。
 * @returns text = 归一化结果，replaced = 被替换的换行符个数
 */
export function normalizeNewlinesWithCount(text: string): { text: string; replaced: number } {
  let replaced = 0
  const out = text.replace(/\r\n|\r/g, () => {
    replaced++
    return '\n'
  })
  return { text: out, replaced }
}
