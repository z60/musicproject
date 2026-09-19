/**
 * Novel Studio · 是否该弹「已降级为规则判定」的提示
 * ============================================================================
 * 设计依据：docs/11 §2.4「`embeddingUsed=false` 必须显著提示」、docs/91 §5.2.15（真机反馈）
 *
 * ### 为什么抽成纯函数（而不是写在 watch 里）
 *   这条判断有**三个**条件，少一个就会出问题，而它们都很容易被无意改掉：
 *     1. 报告存在，且 `embeddingUsed === false`（确实降级了）
 *     2. 报告来自**本次会话里刚跑完的那次生成**（`isFresh`）
 *     3. 这一章还没提示过（同一章只弹一次）
 *
 *   真机上踩过的坑正是漏了第 2 条：只要报告是降级的，**点开任意一章**都会弹一次
 *   「未启用语义判定」——用户连续翻几章就被弹几次，以为系统出错了。
 *   打开章节看到的**历史报告**不是新消息：报告面板里本来就有红条与
 *   「语义判定：未启用（规则判定）」，工具条上还有常驻徽标。
 */
import type { Id } from '@shared/types.ts'

export interface EmbeddingNoticeInput {
  /** 当前章节的生成报告（可能还没生成过） */
  report: { chapterId: Id; embeddingUsed: boolean } | null
  /** 报告是否来自「本次会话里刚跑完的生成任务」 */
  isFresh: boolean
  /** 已经提示过的章节 id（同一章只提示一次） */
  warnedChapterId: Id | null
}

/** 是否应当弹提示（true 时由调用方去 error-bus 报 `CANVAS_EMBEDDING_UNAVAILABLE`） */
export function shouldWarnEmbeddingDegraded(input: EmbeddingNoticeInput): boolean {
  const { report, isFresh, warnedChapterId } = input
  if (!report) return false
  if (report.embeddingUsed) return false
  if (!isFresh) return false
  return warnedChapterId !== report.chapterId
}

/**
 * 是否该在界面上**常驻**显示降级徽标（工具条）。
 *
 * 与上面那条不同：徽标不打扰人，所以「历史报告是降级的」照样要显示 ——
 * 用户翻到一章规则判定生成的画本时，应当一眼看到「语义判定：未启用」，
 * 而不是靠一次性的弹窗记住。
 */
export function shouldShowDegradedBadge(report: { embeddingUsed: boolean } | null): boolean {
  return report !== null && report.embeddingUsed === false
}
