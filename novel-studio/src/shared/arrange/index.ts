/**
 * Novel Studio · 对轨算法（零依赖汇总导出）
 * ============================================================================
 * 设计依据：
 *   · docs/05-音频管线.md §5（§5.1 数据模型、§5.2 自动排布、§5.3 静音修剪、§5.4 手动微调）
 *   · docs/13-功能域-对轨.md §4（排布算法）§4.3（同轨/跨轨）§4.7（微调陷阱）§5（校验）
 *
 * 本目录只做纯算法（时间轴与数值），不碰文件系统、不碰 ffmpeg、不碰数据库。
 */

export * from './layout.ts'
export * from './overlap.ts'
export * from './manual.ts'
export * from './validate.ts'

export type { ArrangeLineInput, ExistingItemState, AutoArrangeInput, AutoArrangeResult } from './layout.ts'
export type {
  OverlapOptions,
  OverlapReport,
  OverlapResolution,
  ResolveOverlapOptions,
  SameTrackOverlapInfo,
  CrossTrackOverlapInfo,
  LongGapInfo,
} from './overlap.ts'
export type { NudgeMode, SnapOptions, SnapResult, EditResult } from './manual.ts'
export type { ValidateArrangementInput, ValidateLineInput, ValidateSegmentInput } from './validate.ts'
