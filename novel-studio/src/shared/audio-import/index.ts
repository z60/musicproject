/**
 * Novel Studio · 按说话人导入音频（零依赖纯逻辑层）
 * ============================================================================
 * 汇总「按说话人导入音频」用到的纯逻辑：
 *   · filename.ts  文件名解析（章节区间 / 角色 token / CV token）
 *   · resolve.ts   说话人解析（CV token → 画本 CV，含缩写补全与**未解析**出口）
 *   · plan.ts      导入规划（文件 × 画本行 → 可预览、可人工修正的计划）
 *
 * 设计依据：docs/12-功能域-录音.md
 *
 * ### 分层理由
 *   这三件事全部是纯函数，能在主进程、渲染进程（预览）、测试里用**同一份**逻辑。
 *   若把它们写在 service 里，渲染进程做「选完文件立刻预览」时就得再实现一遍，
 *   两份实现必然漂移 —— 而「预览与实际导入不一致」正是这类功能最难查的 bug。
 *
 *   真正需要 Electron / SQLite / 文件系统的部分（读 .docx、探测音频时长、
 *   建 take 落库）都在 `src/main/features/audio/import.service.ts`。
 *
 * 本目录禁止引入任何第三方依赖。
 */

export {
  AUDIO_EXTENSIONS,
  SPEAKER_MARKERS,
  classifySpeakerToken,
  isAudioExtension,
  normalizeToken,
  parseAudioFileName,
  rangeCovers,
  rangeLength,
} from './filename.ts'
export type {
  ChapterRange,
  ParseAudioFileNameResult,
  ParseFailureReason,
  ParsedAudioFileName,
  SpeakerTokenKind,
} from './filename.ts'

export { buildCvIndex, decideTarget, matchSpeaker } from './resolve.ts'
export type {
  CvIndex,
  MatchMethod,
  ResolvedCv,
  SpeakerResolution,
  SpeakerTarget,
} from './resolve.ts'

export { buildImportPlan, canvasChapterRange } from './plan.ts'
export type {
  AudioFileInput,
  FileImportPlan,
  FilePlanStatus,
  ImportPlan,
  ImportPlanSummary,
  PlanOptions,
} from './plan.ts'

export { chapterSetOf, chaptersInSpan, clampSpan, selectLinesForTarget } from './select.ts'
export type { ChapterSpan } from './select.ts'
