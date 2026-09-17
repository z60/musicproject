/**
 * Novel Studio · 响度标准化（两遍法，docs/05 §8 / docs/15 §4）
 * ============================================================================
 *   Pass 1（测量）: loudnorm=I=-16:TP=-1:LRA=11:print_format=json -f null -  → 解析 JSON
 *   计算增益     : gainDb = target_I - input_i   （**线性增益**，保持动态，不用 loudnorm 第二遍）
 *   Pass 2（施加）: volume={gainDb}dB, alimiter=limit=0.891:attack=5:release=80
 *   Pass 3（复核）: 再测一次，偏差 > 0.5 LU 微调一次
 *
 * 为什么不用 loudnorm 第二遍：它是**动态**归一化（内部有门限与时变增益），会压动态、
 * 逐章结果不齐；有声书要的是「章与章之间一致」，线性增益 + 限幅才可控。
 *
 * 真峰：alimiter 只做采样级限幅，不是真峰。验收标准以第三方测量（ebur128 / loudnorm JSON）为准；
 *       若 output_tp > 目标，调用方应再降 0.5~1 dB 重渲（错误码 EXPORT_TRUE_PEAK_EXCEEDED）。
 *
 * 失败语义：静音章（input_i = -inf）不返回 NaN，而是返回 0 dB 增益，
 *          由调用方按 docs/15 §6.2 抛 `EXPORT_SILENT_CHAPTER`（阻断）。
 */

import { QC_THRESHOLDS } from '../constants.ts'
import type { LoudnessMeasurement } from '../types.ts'
// dB ↔ 线性的实现只有一处（pcm.ts），避免同名导出让 index.ts 的 `export *` 产生歧义
import { dbToLinear } from './pcm.ts'

/** 解析出的响度测量结果（含真峰与门限，字段缺失时为 NaN） */
export interface ParsedLoudness extends LoudnessMeasurement {
  /** input_i 不可解析时为 NaN */
  inputI: number
  inputTp: number
  inputLra: number
  inputThresh: number
  targetOffset: number
}

/** alimiter 的 limit 是线性值（docs/14 §3.1）：-1 dBFS → 0.891 */
export function truePeakDbToLimitLinear(truePeakDb: number): number {
  return dbToLinear(truePeakDb)
}

/**
 * 计算需要施加的增益（dB）。
 *
 * @param measuredI  Pass 1 测得的 input_i（LUFS）
 * @param targetLufs 目标响度（默认 -16 LUFS）
 * @param maxGainDb  增益绝对值上限（给定时会夹紧，用于避免把噪声底抬起来）
 * @returns 线性增益值（dB）。measuredI 非有限（静音章）时返回 0 —— 调用方必须阻断该章
 *
 * @throws 不抛异常；静音章由调用方抛 `EXPORT_SILENT_CHAPTER`
 */
export function computeGainDb(measuredI: number, targetLufs: number, maxGainDb?: number): number {
  if (!Number.isFinite(measuredI) || !Number.isFinite(targetLufs)) return 0
  let gain = targetLufs - measuredI
  if (typeof maxGainDb === 'number' && Number.isFinite(maxGainDb) && maxGainDb >= 0) {
    gain = Math.max(-maxGainDb, Math.min(maxGainDb, gain))
  }
  return gain
}

/**
 * 短章（< 60 s）的响度不稳（受门限影响），用相邻章的平均增益做校正（docs/05 §8.2）。
 *
 * @returns 校正后的增益（dB）；参考增益为空时原样返回
 * @throws 不抛异常
 */
export function computeGainDbWithNeighbors(
  measuredI: number,
  targetLufs: number,
  neighborGains: number[],
  opts: { shortChapterMs?: number; chapterDurationMs?: number; maxGainDb?: number } = {},
): { gainDb: number; corrected: boolean } {
  const gain = computeGainDb(measuredI, targetLufs, opts.maxGainDb)
  const shortMs = opts.shortChapterMs ?? 60_000
  const dur = opts.chapterDurationMs ?? Number.POSITIVE_INFINITY
  const usable = neighborGains.filter(g => Number.isFinite(g))
  if (dur < shortMs && usable.length > 0) {
    const avg = usable.reduce((a, b) => a + b, 0) / usable.length
    // 取两者平均：既照顾本章实测，也向全书平均靠拢（避免单章跳变）
    return { gainDb: (gain + avg) / 2, corrected: true }
  }
  return { gainDb: gain, corrected: false }
}

// ============================================================================
// stderr 解析
// ============================================================================

/** 把 loudnorm JSON 里的字符串数字转成 number；缺失/非数 → 指定的缺省值 */
function pickNumber(obj: Record<string, unknown>, key: string): number | null {
  const raw = obj[key]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase()
    if (t === '-inf' || t === 'inf' || t === 'nan' || t === '') return null
    const v = Number(t)
    return Number.isFinite(v) ? v : null
  }
  return null
}

/** 容忍尾随逗号（某些构建/日志截断会产生 `"a":1,}`）与换行 */
function tryParseJsonLoose(text: string): Record<string, unknown> | null {
  const attempts = [text, text.replace(/,\s*([}\]])/g, '$1')]
  for (const attempt of attempts) {
    try {
      const v = JSON.parse(attempt) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // 继续尝试下一种
    }
  }
  return null
}

/** 提取最后的 `{...}` 块（loudnorm 的 JSON 总是输出在最后，前面还有进度行） */
function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j] as string
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          blocks.push(text.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return blocks
}

/**
 * 解析 `loudnorm ... print_format=json` 输出到 stderr 的测量结果。
 *
 * 容错要求（都有单测）：
 *   · 非法 JSON → 返回 null（调用方抛 `EXPORT_FFMPEG_FAILED` 或改用 ebur128 降级）
 *   · 字段缺失 → 该字段为 NaN（保留 `LoudnessMeasurement` 契约），`input_i` 缺失时 inputI=NaN
 *   · 值为 "-inf" 字符串（静音章）→ NaN，调用方据此抛 `EXPORT_SILENT_CHAPTER`
 *
 * @throws 不抛异常（解析器永不抛错）
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement | null {
  if (!stderr || typeof stderr !== 'string') return null
  const blocks = extractJsonBlocks(stderr)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const obj = tryParseJsonLoose(blocks[i] as string)
    if (!obj) continue
    // loudnorm 的 JSON 一定含 input_i；没有的话说明这是别的 JSON（如 ffprobe 输出）
    if (!('input_i' in obj) && !('input_tp' in obj) && !('target_offset' in obj)) continue
    const num = (key: string): number => pickNumber(obj, key) ?? Number.NaN
    return {
      inputI: num('input_i'),
      inputTp: num('input_tp'),
      inputLra: num('input_lra'),
      inputThresh: num('input_thresh'),
      targetOffset: num('target_offset'),
    }
  }
  return null
}

/**
 * 解析 `ebur128` 的 Summary 输出（loudnorm 不可用时的降级路径，docs/15 §4「降级」）。
 *
 * 匹配 `I: -16.1 LUFS`（Integrated loudness）与 `Peak: -1.2 dBFS`（True peak）。
 *
 * @throws 不抛异常；两者都没匹配到时返回 null
 */
export function parseEbur128Summary(
  stderr: string,
): { lufs: number | null; truePeakDb: number | null } | null {
  if (!stderr || typeof stderr !== 'string') return null
  const lufsMatch = /(?:^|\n)\s*I:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*LUFS/i.exec(stderr)
  const peakMatch = /Peak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dBFS/i.exec(stderr)
  if (!lufsMatch && !peakMatch) return null
  const toNum = (m: RegExpExecArray | null): number | null => {
    if (!m) return null
    const v = Number(m[1])
    return Number.isFinite(v) ? v : null
  }
  return { lufs: toNum(lufsMatch), truePeakDb: toNum(peakMatch) }
}

/**
 * 响度容差判定（docs/05 §10.2、docs/15 §6.2：|Δ| ≤ 1.0 LU）。
 *
 * @param opts.tolerance 自定义容差；缺省用 `QC_THRESHOLDS.lufsTolerance`(1.0)
 * @throws 不抛异常；超容差由调用方决定抛 `EXPORT_LOUDNESS_OUT_OF_RANGE` 还是仅告警
 */
export function checkLoudness(
  measured: number,
  target: number,
  opts: { tolerance?: number; label?: string } = {},
): { ok: boolean; delta: number; message?: string } {
  const tolerance = opts.tolerance ?? QC_THRESHOLDS.lufsTolerance
  if (!Number.isFinite(measured) || !Number.isFinite(target)) {
    return { ok: false, delta: Number.NaN, message: '响度测量值无效（可能整章静音）' }
  }
  const delta = measured - target
  const ok = Math.abs(delta) <= tolerance + 1e-9
  return {
    ok,
    delta,
    message: ok
      ? undefined
      : `响度偏差 ${delta.toFixed(2)} LU 超出容差 ±${tolerance} LU${opts.label ? `（${opts.label}）` : ''}`,
  }
}

/** 真峰判定（≤ 目标真峰才通过） */
export function checkTruePeak(
  measuredTpDb: number,
  targetTpDb: number,
  opts: { toleranceDb?: number } = {},
): { ok: boolean; excessDb: number; message?: string } {
  const tol = opts.toleranceDb ?? 0.05
  if (!Number.isFinite(measuredTpDb)) {
    return { ok: false, excessDb: Number.NaN, message: '真峰测量值无效' }
  }
  const excessDb = measuredTpDb - targetTpDb
  const ok = excessDb <= tol
  return {
    ok,
    excessDb,
    message: ok ? undefined : `真峰 ${measuredTpDb.toFixed(2)} dBTP 超过目标 ${targetTpDb} dBTP，建议再降 ${(excessDb + 0.5).toFixed(1)} dB 重渲`,
  }
}
