/**
 * 单例 store 的「书作用域」判定（真机事故：章节管理显示了**非本书**的生成画本提示）
 * ============================================================================
 * 事故（docs/91 §5.2.35）：在《我陪魔神历劫》里批量生成画本 → 回书架打开另一本书 →
 * 「章节管理」顶部仍然显示那些进度卡，标题还是 `生成画本：1925adee-3bf1-4179-…`。
 *
 * 根因是**单例 store + 以 chapterId 为键的界面级登记**：
 *   · `chapters.canvasTasks` 是 `chapterId → taskId`，切书时不会重建；
 *   · 派生的面板标题 `chapterTitleOf(chapterId)` 在新书里查不到该章节，回退成了 uuid。
 * 于是一条属于上一本书的提示，冒充成了本书的提示（而且把 uuid 直接暴露给用户）。
 *
 * 本模块把两条规则抽成**纯函数**（不 import 任何项目内模块，因此能在 Node 里直接测）：
 *   ① 换书判定：只有书真的变了才清界面级状态（首次加载不算换书）
 *   ② 进度卡可见性：只显示**当前书**、且章节仍然存在的任务
 */

/** 章节管理里一条「生成画本」任务登记（键是 chapterId，值带任务 id 与所属书） */
export interface CanvasTaskRecord {
  chapterId: string
  taskId: string
  bookId: string
}

/**
 * 是不是**换书**（而不是首次加载或同书刷新）？
 *
 * 只有换书时才需要丢掉上一本书的界面级状态（分工负载、行级忙碌态、抽取候选…）——
 * 首次加载时本来就没有状态可丢，同书刷新更不能丢（否则刷新一次就把提示清空了）。
 */
export function isBookSwitch(current: string | null, next: string): boolean {
  return current !== null && current !== next
}

export interface VisibleCanvasTasksInput {
  /** 全部任务登记（可能含其它书的） */
  tasks: readonly CanvasTaskRecord[]
  /** 当前书 id（null = 还没选中书 → 什么都不显示） */
  bookId: string | null
  /** 当前书里仍然存在的章节 id */
  chapterIds: readonly string[]
  /** 最多显示几条（默认 6：别把页面撑长） */
  limit?: number
}

/**
 * 「章节管理」的生成画本进度卡该显示哪些条目。
 *
 * 两道过滤缺一不可：
 *   · `bookId` —— 不显示别的书的提示（真机事故的直接原因）；
 *   · `chapterIds` —— 章节已被删除时不显示（任务本身仍在任务中心，可查看与取消）。
 */
export function visibleCanvasTasks(input: VisibleCanvasTasksInput): CanvasTaskRecord[] {
  const { tasks, bookId, chapterIds } = input
  if (!bookId) return []
  const limit = Math.max(0, input.limit ?? 6)
  const known = new Set(chapterIds)
  return tasks
    .filter((task) => task.bookId === bookId && known.has(task.chapterId))
    .slice(-limit)
}

/**
 * 给用户看的章节名：查不到就给「未知章节」，**绝不回退成 uuid**
 * （仓库既有约定：不给用户看主键，见 `characters.store.nameOf`）。
 */
export function chapterTitleOrPlaceholder(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim()
  return trimmed.length > 0 ? trimmed : '未知章节'
}
