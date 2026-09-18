/**
 * Novel Studio · IPC handler · 章节管理域（`chapter:*`，9 个通道）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §4.2、docs/10 §7.2、docs/91 §5.2.8
 *
 * 与 `handlers/book.ts` 同一套纪律：
 *   1. **载荷校验在注册层**（`IPC_REQ_SCHEMAS`）—— 这里拿到 `req` 已是校验过的形状，
 *      不再重复判断类型；但**业务边界**（如「合并至少 2 章」「拆分偏移必须在章内」）
 *      必须在服务层挡，因为 schema 只能表达形状、表达不了跨字段语义。
 *   2. **逻辑在服务层**（`chapter.service.ts`），这里只做转发。
 *   3. 不接 `AbortSignal`：本域全是短操作（读/写几行 SQLite），没有长任务。
 *
 * `h()` 工厂让 `req` 的字段类型**从契约推断**；写成对象字面量会让 `req` 退化成
 * `unknown`（TS18046）。详见 `handlers/deps.ts` 的注释。
 */

import type { ChapterService } from '../../features/book/chapter/chapter.service.ts'
import { h, type RegisteredHandler } from './deps.ts'

export function createChapterHandlers(chapter: ChapterService): RegisteredHandler[] {
  return [
    // ── 读 ─────────────────────────────────────────────────────────────────
    h('chapter:list', async (req) => {
      // 书不存在 / 没有章节都返回 []（界面的空态文案是「这本书还没有章节」）
      return chapter.list(req.bookId)
    }),

    h('chapter:get', async (req) => {
      return chapter.get(req.chapterId)
    }),

    h('chapter:stats', async (req) => {
      return chapter.stats(req.chapterId)
    }),

    // ── 单章编辑 ───────────────────────────────────────────────────────────
    h('chapter:update', async (req) => {
      return chapter.update(req.chapterId, req.patch)
    }),

    // ── 顺序 ───────────────────────────────────────────────────────────────
    h('chapter:reorder', async (req) => {
      return chapter.reorder(req.bookId, req.orderedIds)
    }),

    // ── 合并 / 拆分（破坏性：调用方必须先过确认框，见 ChapterMergeDialog）─────
    h('chapter:merge', async (req) => {
      return chapter.merge(req.chapterIds, req.title)
    }),

    h('chapter:split', async (req) => {
      // `atOffsets` 是**全书绝对偏移**（消费方 chapters.store 已做换算）
      return chapter.split(req.chapterId, req.atOffsets)
    }),

    // ── 删除（软删除，见 chapter.service 的注释）────────────────────────────
    h('chapter:delete', async (req) => {
      return chapter.remove(req.chapterId)
    }),

    // ── 章首标题念白行 ─────────────────────────────────────────────────────
    // 通道名里的 `inser` 是**历史拼写**（契约里就这么定的，改动会让已发布的
    // 通道名与文档/白名单全线失配），不要「顺手修正」。
    h('chapter:inserTitleLine', async (req) => {
      return chapter.insertTitleLine(req.chapterId)
    }),
  ]
}

/** 本域实现的通道名（与上面的数组一一对应；供自检与覆盖度统计） */
export const CHAPTER_CHANNELS: readonly string[] = [
  'chapter:list',
  'chapter:get',
  'chapter:update',
  'chapter:reorder',
  'chapter:merge',
  'chapter:split',
  'chapter:delete',
  'chapter:stats',
  'chapter:inserTitleLine',
]
