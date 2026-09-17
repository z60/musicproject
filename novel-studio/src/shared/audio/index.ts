/**
 * Novel Studio · 音频数学与格式（零依赖汇总导出）
 * ============================================================================
 * 设计依据：docs/05-音频管线.md（§2 采集落盘、§3 崩溃恢复、§4 VAD、§5 修剪、
 *           §8 响度、§11.3 波形峰值）
 *
 * 本目录只允许依赖 Node 内置模块与 `src/shared/.ts`；
 * 任何 ffmpeg 调用都在 `src/shared/ffmpeg/` 下以「命令构建 + 注入执行器」的形式存在。
 */

export * from './pcm.ts'
export * from './wav.ts'
export * from './vad.ts'
export * from './trim.ts'
export * from './loudness.ts'
export * from './peaks.ts'

// 类型需要显式 type 导出（Node 的 --experimental-strip-types 会擦除类型）
export type { VadFrame, VadSliceRange, VadOptionsExt } from './vad.ts'
export type { TrimRange, TrimOptionsExt } from './trim.ts'
export type { ParsedLoudness } from './loudness.ts'
export type { PeaksMeta, SerializedPeaks } from './peaks.ts'
export type { WavHeaderParseResult, RepairWavHeaderInput, RepairWavHeaderResult } from './wav.ts'
