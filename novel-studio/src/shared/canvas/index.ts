/**
 * Novel Studio · 画本域共享模块汇总导出
 * ============================================================================
 * 用途：主进程（src/main/features/book/canvas）与渲染进程都只从这里 import，
 * 避免各处散落地写 `canvas/attribution.ts` 这种深路径；也让「这一域到底提供什么能力」一目了然。
 *
 * 分层（docs/06 §2）：
 *   vector.ts      L2 向量基础运算（归一化 / 余弦 / 原型 / 增量 / 排序）——纯数学，零依赖
 *   attribution.ts L1 规则 + L2 判定 + L3 复核编排（说话人判定与画本生成主入口）
 *   character.ts   L1 角色抽取与角色表工具（合并 / 拆分 / 别名 / 统计）
 *   quality.ts     质检与安全自动修复
 *
 * 显式导出（不用 `export *`）：契约一旦被改动能立刻看到谁受影响。
 */

// ---------------------------------------------------------------------------
// 向量基础（vector.ts）
// ---------------------------------------------------------------------------
export {
  DEFAULT_OUTLIER_THRESHOLD,
  DEFAULT_TOP_N,
  NORMALIZED_TOLERANCE,
  ZERO_NORM_EPSILON,
  accumulatorAdd,
  accumulatorCentroid,
  accumulatorFrom,
  accumulatorRemove,
  computeCentroid,
  cosine,
  createAccumulator,
  dot,
  incrementalCentroid,
  l2Norm,
  l2Normalize,
  meanVector,
  rankCandidates,
} from './vector.ts'
export type {
  CentroidAccumulator,
  CentroidEntry,
  ComputeCentroidOptions,
  ComputeCentroidResult,
  IncrementalCentroidDelta,
} from './vector.ts'

// ---------------------------------------------------------------------------
// 说话人判定与画本生成（attribution.ts）
// ---------------------------------------------------------------------------
export {
  CONSECUTIVE_BONUS_DEFAULT,
  CUE_LOOKBACK_DEFAULT,
  CUE_NAME_WINDOW,
  CUE_VERBS,
  EMOTION_LEXICON,
  INNER_CUE_VERBS,
  INNER_MARKERS,
  NON_NAME_TOKENS,
  PAUSE_INLINE_MIN_CHARS,
  PAUSE_INLINE_MIN_SPACING,
  RULE_CONFIDENCE,
  applyRulePostProcess,
  attributeByVector,
  buildContext,
  buildGenerateReport,
  classifyKind,
  countReadableChars,
  describeEmbeddingFailure,
  describeVectorReason,
  findTopLevelQuoteSpans,
  generateCanvas,
  generateCanvasLines,
  guessNameFromWindow,
  inferPause,
  inferTags,
  matchCue,
  matchInnerCue,
  resolveSpeakerHint,
  splitToLines,
} from './attribution.ts'
export type {
  AttributeOptions,
  AttributionLine,
  BuildContextOptions,
  BuildReportInput,
  CanvasCharacterRef,
  CanvasGenerateDraft,
  CanvasGenerateInput,
  CanvasGenerateOutput,
  CanvasLimits,
  ClassifyOptions,
  CueInfo,
  EmbeddingProvider,
  KindClassification,
  LineContext,
  LineDecision,
  LineDraft,
  LlmReviewItem,
  LlmReviewRequest,
  LlmReviewer,
  PauseOptions,
  PauseResult,
  RulePostProcessOptions,
  SplitOptions,
  TagInferenceInput,
  TagInferenceOptions,
  TagInferenceResult,
  VectorDecision,
  VectorReason,
} from './attribution.ts'

// ---------------------------------------------------------------------------
// 角色（character.ts）
// ---------------------------------------------------------------------------
export {
  addAlias,
  archiveCharacter,
  buildCharacterStats,
  createCharacter,
  extractCharacterCandidates,
  mergeCharacters,
  removeAlias,
  resolveCharacterByName,
  splitCharacter,
} from './character.ts'
export type {
  AliasConflict,
  CharacterStatsLine,
  ExtractCharacterOptions,
  MergeCharactersInput,
  MergeCharactersResult,
  MergeConflict,
  SplitCharacterInput,
  SplitCharacterResult,
  Token,
  Tokenizer,
} from './character.ts'

// ---------------------------------------------------------------------------
// 质检（quality.ts）
// ---------------------------------------------------------------------------
export {
  POLYPHONE_DISAMBIGUATION,
  SAFE_FIX_KINDS,
  analyzePolyphones,
  autoFixIssues,
  findPolyphoneHints,
  isQuoteUnbalanced,
  qualityCheck,
  suggestPronunciation,
} from './quality.ts'
export type {
  AutoFixOptions,
  AutoFixPatch,
  AutoFixResult,
  PolyphoneHit,
  QualityCheckLine,
  QualityCheckOptions,
  QualitySegmentRef,
} from './quality.ts'
