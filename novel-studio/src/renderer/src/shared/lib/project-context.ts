/**
 * 渲染进程 · 导入用「项目上下文」的判定规则（纯函数）
 * ============================================================================
 * 契约里**没有**「当前项目」通道，而 `book:commitImport` / `book:importFile` /
 * `book:importText` / `book:importUrl` 都要求 `projectId` 必填。
 * 渲染进程能推断项目的来源只有两处：当前选中的书籍、书架里的书。
 *
 * ### 这里修的是一个死锁（真机事故 docs/91 §5.2.4）
 *
 * 原先「书架为空」时被判定成**没有项目上下文**，界面提示用户
 * 「请先到书架导入或打开一本书」—— 而书架是空的，这是循环指令：
 *
 *     导入需要项目 → 项目需要书 → 书需要导入
 *
 * 于是**全新安装永远导入不了第一本书**，用户点「开始导入」只得到一个
 * 与事实不符的「后台任务执行失败」。
 *
 * 而主进程在启动期就已经 `ensureDefault` 建好了默认项目（真机日志 `book.project.ready`），
 * 并且 `project.repo.ts` 头部明确论证过：**项目是基础设施，不是用户可见的概念**。
 * 所以书架为空时必须落到那个默认项目上，而不是把用户挡在门外。
 *
 * ### 为什么放 shared/lib、且只用相对 import
 * 本文件要能被 `tests/renderer` 以 `node --experimental-strip-types` 直接加载 ——
 * 测试运行器**不解析** `@/` / `@shared/` 别名（现有 renderer 测试都只用相对路径）。
 * 判定规则抽成纯函数就是为了让它可测：这个 bug 正是一条**逻辑**缺口，
 * 留在 composable 里（依赖 pinia / IPC）就永远测不到。
 */

import { DEFAULT_PROJECT_ID } from '../../../../shared/constants.ts'

/** 判定所需的最小输入（只要两个字段，调用方无需交出整本书） */
export interface ProjectContextInput {
  /** 当前选中书籍所属的项目（`session.projectId`） */
  sessionProjectId: string | null
  /** 书架上的书；只需 `title`（进提示文案）与 `projectId` */
  books: ReadonlyArray<{ title: string; projectId: string | null }>
}

export interface ProjectContextDecision {
  /** 一定给出一个可用项目：要么来自书籍，要么是默认项目 */
  projectId: string
  /** 给用户看的说明（空串表示无需说明） */
  hint: string
}

/**
 * 决定导入要写进哪个项目。优先级：
 *   1. 当前选中的书籍所属项目
 *   2. 书架里第一本带项目的书
 *   3. **默认项目**（书架为空时；见文件头部的死锁说明）
 */
export function decideProjectContext(input: ProjectContextInput): ProjectContextDecision {
  const selected = input.sessionProjectId?.trim()
  if (selected) return { projectId: selected, hint: '' }

  for (const book of input.books) {
    const id = book.projectId?.trim()
    if (id) {
      return {
        projectId: id,
        hint: `当前未选中书籍，已使用书架中「${book.title}」所属的项目`,
      }
    }
  }

  return {
    projectId: DEFAULT_PROJECT_ID,
    hint: '书架还是空的：这本书会导入到默认项目，导入完成后就会出现在书架里',
  }
}
