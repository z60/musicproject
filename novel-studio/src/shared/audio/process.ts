/**
 * Novel Studio · 处理链的判定与指纹（纯逻辑，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §2.1 处理顺序固定；§3 链 → 滤镜串
 *   · docs/14 §7.1 `dedupeKey = process:{segmentId}:{presetHash}`（幂等）
 *   · docs/03 §6 `processed/{segmentId}.{presetHash}.wav` —— 指纹要进文件名
 *
 * ### 为什么指纹必须自己算，而且必须**稳定**
 *   `presetHash` 同时是三件事的判据：文件名的一部分、跳过重复处理的去重键、
 *   以及「当前成品是不是用这条链处理的」。只要它不稳定（键序不同、浮点格式不同），
 *   就会出现「同样的预设每次处理都写一个新文件」和「已经处理过却每次都重跑」。
 *   所以这里用**显式键序**的序列化，而不是 `JSON.stringify(chain)` —— 后者依赖对象
 *   字面量的键序：从数据库读回来的链（JSON.parse）与代码里构造的链，键序可能不同。
 *
 * ### 为什么不用 node:crypto
 *   本模块被 `src/shared/**` 引用（渲染进程也会用到「链是否为空」这类判断），
 *   而渲染进程里 `node:crypto` 不可用。FNV-1a 64 位在这里足够：它只用来做**内容指纹**
 *   （不是安全用途），碰撞概率对「几百条预设」这个量级可以忽略。
 */

import type { ProcessChain } from '../types.ts'

/** 链里所有会进滤镜串的字段（顺序固定 = 指纹稳定） */
const CHAIN_KEYS = [
  'repair.polarityInvert',
  'repair.dcOffset',
  'highpass.enabled',
  'highpass.freq',
  'highpass.poles',
  'denoise.enabled',
  'denoise.nr',
  'denoise.nf',
  'denoise.tn',
  'deesser.enabled',
  'deesser.intensity',
  'deesser.freq',
  'eq',
  'compressor.enabled',
  'compressor.thresholdDb',
  'compressor.ratio',
  'compressor.attackMs',
  'compressor.releaseMs',
  'compressor.makeupDb',
  'limiter.enabled',
  'limiter.limitDb',
  'limiter.attackMs',
  'limiter.releaseMs',
  'repair.declick',
  'repair.silenceFill',
  'repair.tempo.enabled',
  'repair.tempo.factor',
] as const

/**
 * 空链（什么都不处理）——`buildChainFilter` 对空链返回空串。
 *
 * 只有全部开关都关、且没有任何 EQ 段/修补区间时才为空；
 * `tempo.factor` 这种「关了也有值」的字段不参与判定（关着就不生效）。
 */
export function isProcessChainEmpty(chain: ProcessChain): boolean {
  if (chain.highpass.enabled) return false
  if (chain.denoise.enabled) return false
  if (chain.deesser.enabled) return false
  if (chain.compressor.enabled) return false
  if (chain.limiter.enabled) return false
  if (chain.repair.dcOffset || chain.repair.polarityInvert) return false
  if (chain.repair.tempo.enabled) return false
  if (chain.repair.declick.length > 0) return false
  if (chain.repair.silenceFill.length > 0) return false
  if (chain.eq.some((b) => b.enabled)) return false
  return true
}

/** 链里启用的 EQ 段数（UI 摘要与日志用） */
export function enabledEqBandCount(chain: ProcessChain): number {
  return chain.eq.filter((b) => b.enabled).length
}

/** 链的稳定序列化（显式键序；数字统一去掉浮点尾巴，避免 0.30000000000000004 这种差异） */
export function canonicalChain(chain: ProcessChain): string {
  const parts: string[] = []
  const eq = chain.eq.map((b) =>
    [b.id, b.type, num(b.freq), num(b.gainDb), num(b.q), b.enabled ? 1 : 0].join(':'),
  )
  const declick = chain.repair.declick.map((d) => `${num(d.atMs)}-${num(d.lengthMs)}`)
  const silence = chain.repair.silenceFill.map((s) => `${num(s.startMs)}-${num(s.endMs)}`)
  const values: Record<string, unknown> = {
    'repair.polarityInvert': chain.repair.polarityInvert,
    'repair.dcOffset': chain.repair.dcOffset,
    'highpass.enabled': chain.highpass.enabled,
    'highpass.freq': num(chain.highpass.freq),
    'highpass.poles': chain.highpass.poles,
    'denoise.enabled': chain.denoise.enabled,
    'denoise.nr': num(chain.denoise.nr),
    'denoise.nf': num(chain.denoise.nf),
    'denoise.tn': chain.denoise.tn,
    'deesser.enabled': chain.deesser.enabled,
    'deesser.intensity': num(chain.deesser.intensity),
    'deesser.freq': num(chain.deesser.freq),
    eq: eq.join('|'),
    'compressor.enabled': chain.compressor.enabled,
    'compressor.thresholdDb': num(chain.compressor.thresholdDb),
    'compressor.ratio': num(chain.compressor.ratio),
    'compressor.attackMs': num(chain.compressor.attackMs),
    'compressor.releaseMs': num(chain.compressor.releaseMs),
    'compressor.makeupDb': num(chain.compressor.makeupDb),
    'limiter.enabled': chain.limiter.enabled,
    'limiter.limitDb': num(chain.limiter.limitDb),
    'limiter.attackMs': num(chain.limiter.attackMs),
    'limiter.releaseMs': num(chain.limiter.releaseMs),
    'repair.declick': declick.join('|'),
    'repair.silenceFill': silence.join('|'),
    'repair.tempo.enabled': chain.repair.tempo.enabled,
    'repair.tempo.factor': num(chain.repair.tempo.factor),
  }
  for (const key of CHAIN_KEYS) parts.push(`${key}=${String(values[key])}`)
  return parts.join(';')
}

/**
 * 链指纹（12 位十六进制）。
 *
 * 用途：`processed/{segmentId}.{presetHash}.wav`、`dedupeKey`、以及
 * 「当前 processed_path 用的还是不是这条链」（docs/03 §6）。
 */
export function chainHash(chain: ProcessChain): string {
  return fnv1a64Hex(canonicalChain(chain)).slice(0, 12)
}

/** FNV-1a 64 位（用 BigInt，结果 16 位十六进制） */
export function fnv1a64Hex(text: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n
  const FNV_PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  let hash = FNV_OFFSET
  // 逐字节：UTF-16 的 charCode 会漏掉非 BMP 字符的差异，所以按 UTF-8 字节走
  const bytes = utf8Bytes(text)
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

function utf8Bytes(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return out
}

/** 数字规范化：去掉浮点尾巴（0.1+0.2 之类不该产生两个不同的指纹） */
function num(v: number): string {
  if (!Number.isFinite(v)) return '0'
  return String(Number(v.toFixed(6)))
}
