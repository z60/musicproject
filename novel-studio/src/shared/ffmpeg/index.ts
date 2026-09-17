/**
 * Novel Studio · ffmpeg 命令构建与解析（零依赖汇总导出）
 * ============================================================================
 * 设计依据：
 *   · docs/02 §5.1 能力探测（必须验证的关键滤镜）
 *   · docs/05 §6 处理链、§7 混音、§8 响度、§9 导出、§10 质检
 *   · docs/14 §3 滤镜图构建、§3.1 三处必须实测确认的参数、§9 ducking
 *   · docs/15 §3 渲染管线、§5 导出、§6 质检
 *
 * ★ 本目录**不调用 ffmpeg**、不 import 任何第三方包：
 *   所有能力都以「命令数组 / 滤镜串 / 解析函数」的纯数据形式给出，
 *   执行通过注入 `FfmpegRunner`（生产实现在 infra/ffmpeg/runner.ts）完成。
 */

export * from './filters.ts'
export * from './commands.ts'
export * from './parse.ts'
export * from './quality.ts'

export type {
  ChainFilterOptions,
  MixItemInput,
  MixFilterInput,
  MusicFilterOptions,
} from './filters.ts'
export type {
  FfmpegRunner,
  FfmpegExecuteOptions,
  FfmpegExecuteResult,
  ChapterExportCommandInput,
  LoudnessMeasureCommandInput,
  LoudnessApplyCommandInput,
  M4bCommandInput,
  MixRenderCommandInput,
  FfmetadataChapter,
  FfmetadataBookMeta,
} from './commands.ts'
export type { FfmpegProgressInfo } from './parse.ts'
export type {
  QcPreCheckInput,
  QcPreCheckLine,
  QcPreCheckChapter,
  QcPreCheckResultExt,
  PostCheckInput,
  PostCheckIssue,
  PostCheckSeverity,
} from './quality.ts'
