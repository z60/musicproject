/**
 * Novel Studio · IPC handler · 书籍导入域（`book:*`，15 个通道）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §4.2、docs/10-功能域-书籍导入.md
 *
 * ### 这一层只做三件事
 *   1. **载荷校验**：由 `IPC_REQ_SCHEMAS` 在注册层统一做（见 ipc/schemas.ts），
 *      所以这里拿到 `req` 已经是校验过的形状，不再重复判断类型。
 *   2. **调服务**：真正逻辑在 `book.service.ts`（它再往下调 `import.service.ts`）。
 *   3. **取消语义**：`AbortSignal` 从哪来？—— 本域是「短操作」（探测/检测都是读文件头），
 *      不接 signal；异步导入走队列，取消由 `task:cancel` 负责。因此这里不造 signal。
 *
 * ### 为什么用 `h()` 工厂而不是对象字面量
 *   `h('book:list', ...)` 让 `req` 的字段类型**从契约推断**出来。
 *   直接写对象字面量会让 `req` 退化成 `unknown`，每个字段访问都报 TS18046。
 *   详见 ipc/handlers/deps.ts 的注释。
 */

import { AppError } from '../../../shared/errors.ts'
import type { Book, ChapterDraft, Id } from '../../../shared/types.ts'
import type { BookService } from '../../features/book/import/book.service.ts'
import { h, type HandlerDeps, type RegisteredHandler } from './deps.ts'

/** 本域需要的服务（由 ports.ts 装配后经 HandlerDeps 传进来会形成循环依赖，故显式注入） */
export interface BookHandlerDeps {
  book: BookService
}

/**
 * 组装本域全部 handler。
 *
 * @param deps 本域服务
 * @param handlerDeps 通用依赖（日志等）—— 由 `registerAllHandlers` 在注册时提供，
 *                    因此这里不直接用它，保留参数是为了与其它域的签名一致。
 */
export function createBookHandlers(book: BookService): RegisteredHandler[] {
  return [
    // ── 书籍列表 / 详情 / 修改 / 删除 ────────────────────────────────────────
    h('book:list', async (req) => {
      // 契约的 `projectId` 是可选的：不给就列全部（见 project.repo.ts 关于「项目是基础设施」的说明）
      return book.list(req?.projectId)
    }),

    h('book:get', async (req) => {
      return book.get(req.bookId)
    }),

    h('book:update', async (req) => {
      return book.update(req.bookId, req.patch)
    }),

    h('book:delete', async (req) => {
      return book.remove(req.bookId, req.deleteAudio)
    }),

    // ── 导入流程：探测 → 检测编码 → 预览分章 → 落库 ─────────────────────────
    h('book:probeFile', async (req) => {
      return book.probeFile(req.filePath)
    }),

    h('book:detectEncoding', async (req) => {
      return book.detectEncoding(req.filePath, req.sampleBytes)
    }),

    h('book:previewSplit', async (req) => {
      // 契约要求 filePath / text 至少给一个；两个都没给是调用方错误，明确报出来
      if (!req.filePath && !req.text) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { reason: 'previewSplit 需要 filePath 或 text 之一' },
        })
      }
      return book.previewSplit({
        ...(req.filePath ? { filePath: req.filePath } : {}),
        ...(req.text ? { text: req.text } : {}),
        ruleSetId: req.ruleSetId ?? null,
        ...(req.cleanOptions ? { cleanOptions: req.cleanOptions } : {}),
        ...(req.importMode ? { importMode: req.importMode } : {}),
      })
    }),

    h('book:commitImport', async (req) => {
      return book.commitImport({
        projectId: req.projectId,
        bookMeta: req.bookMeta,
        source: req.source,
        drafts: req.drafts as ChapterDraft[],
        ...(req.importMode ? { importMode: req.importMode } : {}),
      })
    }),

    h('book:findDuplicate', async (req) => {
      return book.findDuplicate(req.contentHash, req.projectId)
    }),

    // ── 规则集 ─────────────────────────────────────────────────────────────
    h('book:ruleSets', async () => {
      return book.ruleSets.list()
    }),

    h('book:saveRuleSet', async (req) => {
      return book.ruleSets.save(req.ruleSet)
    }),

    h('book:deleteRuleSet', async (req) => {
      return { ok: await book.ruleSets.remove(req.id) }
    }),

    // ── 异步导入（走任务队列，返回 taskId）──────────────────────────────────
    h('book:importFile', async (req) => {
      return book.importFile(req.projectId, req.filePath, req.options)
    }),

    h('book:importText', async (req) => {
      return book.importText(req.projectId, req.text, req.title, req.options)
    }),

    h('book:importUrl', async (req) => {
      return book.importUrl(req.projectId, req.url, req.options)
    }),
  ]
}

/** 本域实现的通道名（供自检与 coverage 统计；与上面数组必须一一对应） */
export const BOOK_CHANNELS: readonly string[] = [
  'book:list',
  'book:get',
  'book:update',
  'book:delete',
  'book:probeFile',
  'book:detectEncoding',
  'book:previewSplit',
  'book:commitImport',
  'book:findDuplicate',
  'book:ruleSets',
  'book:saveRuleSet',
  'book:deleteRuleSet',
  'book:importFile',
  'book:importText',
  'book:importUrl',
]

// 类型再导出，便于上层装配时引用（避免各处 import 深路径）
export type { Book, Id }
export type { HandlerDeps }
