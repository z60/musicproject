/**
 * Novel Studio · 静音修剪（docs/05 §5.3 / FR-4.9）
 * ============================================================================
 * 算法（在 PCM 域做，不依赖 ffmpeg，读片段文件即可，速度快）：
 *   1. 从 srcIn 向后扫，找第一个 |x| > trimThreshold（默认 -45 dBFS）的样本 → 实际起点
 *   2. 从 srcOut 向前扫，同理 → 实际终点
 *   3. 实际起点向前留 headPaddingMs（默认 100 ms，不早于 0）
 *   4. 实际终点向后留 tailPaddingMs（默认 120 ms，不晚于片段尾）
 *
 * 修剪结果写回 `src_in_ms / src_out_ms`，**不修改文件**（非破坏，见 docs/03 §6）。
 *
 * 失败语义：全静音时返回全区间并打 `all_silence` 标记；
 *          调用方（自动修剪按钮 / 任务）据此抛 `TRIM_FAILED`，并保留原文件与手动调整入口。
 */

import { TRIM_DEFAULTS } from '../constants.ts'
import type { TrimOptions } from '../types.ts'
import { dbToLinear, durationMsToFrames, framesToDurationMs } from './pcm.ts'

export interface TrimRange {
  inMs: number
  outMs: number
  /** 'all_silence' = 整段都在阈值以下；'below_min' = 修剪后不足 1 帧；'disabled' = 未启用 */
  flags: string[]
  /** 实际扫描到的有信号区间（未加 padding），便于 UI 显示 */
  rawInMs: number
  rawOutMs: number
  thresholdLinear: number
}

export type TrimOptionsExt = TrimOptions & {
  sampleRate: number
  /** 片段在源文件中的起点（毫秒）。返回值是**片段内相对时间**，与 srcInMs/srcOutMs 同一坐标系 */
  offsetMs?: number
}

/**
 * 计算修剪区间（相对片段起点，毫秒）。
 *
 * @throws 不抛异常。`flags` 含 `all_silence` 时调用方应抛 `TRIM_FAILED`
 *         （文案：该片段可能过短或格式异常，已保留原始文件）。
 */
export function computeTrimRange(samples: Float32Array, opts: TrimOptionsExt): TrimRange {
  const sampleRate = opts.sampleRate > 0 ? opts.sampleRate : 48000
  const totalMs = framesToDurationMs(samples.length, sampleRate)
  const thresholdLinear = dbToLinear(opts.thresholdDb)

  if (!opts.enabled || samples.length === 0) {
    return {
      inMs: 0,
      outMs: totalMs,
      flags: opts.enabled ? ['below_min'] : ['disabled'],
      rawInMs: 0,
      rawOutMs: totalMs,
      thresholdLinear,
    }
  }

  // 1) 从起点向后找第一个超阈样本
  let first = -1
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] as number) > thresholdLinear) {
      first = i
      break
    }
  }
  // 2) 从终点向前找
  let last = -1
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i] as number) > thresholdLinear) {
      last = i
      break
    }
  }

  // 全静音：返回全区间并标记（绝不自动删掉整段素材）
  if (first < 0 || last < first) {
    return {
      inMs: 0,
      outMs: totalMs,
      flags: ['all_silence'],
      rawInMs: 0,
      rawOutMs: totalMs,
      thresholdLinear,
    }
  }

  const rawInMs = framesToDurationMs(first, sampleRate)
  const rawOutMs = framesToDurationMs(last + 1, sampleRate)

  // 3)+4) 按 padding 扩展，且不越界
  let inMs = Math.max(0, rawInMs - Math.max(0, opts.headPaddingMs))
  let outMs = Math.min(totalMs, rawOutMs + Math.max(0, opts.tailPaddingMs))
  if (outMs <= inMs) {
    // 极端短片段：至少保住扫到的区间，最差也要 >= 1 帧
    inMs = Math.min(inMs, rawInMs)
    outMs = Math.max(outMs, Math.min(totalMs, inMs + framesToDurationMs(1, sampleRate)))
  }

  const flags: string[] = []
  if (durationMsToFrames(outMs - inMs, sampleRate) < 1) flags.push('below_min')

  return { inMs, outMs, flags, rawInMs, rawOutMs, thresholdLinear }
}

/**
 * 把修剪结果夹到片段边界内的 [srcInMs, srcOutMs]（对轨写回用）。
 *
 * @throws 不抛异常；返回 null 表示区间非法（调用方抛 `TRIM_FAILED`）
 */
export function clampTrimToSegment(
  range: { inMs: number; outMs: number },
  segment: { srcInMs: number; srcOutMs: number },
): { srcInMs: number; srcOutMs: number } | null {
  const srcInMs = Math.min(Math.max(range.inMs, segment.srcInMs), segment.srcOutMs)
  const srcOutMs = Math.max(Math.min(range.outMs, segment.srcOutMs), srcInMs)
  if (srcOutMs <= srcInMs) return null
  return { srcInMs, srcOutMs }
}

/** 默认修剪参数（与 TRIM_DEFAULTS 对齐，供调用方合并用户设置） */
export function defaultTrimOptions(): TrimOptions {
  return {
    enabled: TRIM_DEFAULTS.enabled,
    thresholdDb: TRIM_DEFAULTS.thresholdDb,
    headPaddingMs: TRIM_DEFAULTS.headPaddingMs,
    tailPaddingMs: TRIM_DEFAULTS.tailPaddingMs,
  }
}
