/**
 * Novel Studio · 章节管理服务（`chapter:*` 域，9 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/10 §7.2（章节列表要显示什么：序号/标题/字数/画本状态/录音完成度）
 *   · docs/03 §「软删除」（音频相关实体禁物理删除）、docs/21 §「chapters 表」（seq 1 起、允许非连续）
 *   · docs/20 §4（契约）、docs/91 §5.2.8（本域实现时拍板的语义，尤其是文档未规定处）
 *
 * ### 分层
 *   本文件只做**业务逻辑**：handler 层（`ipc/handlers/chapter.ts`）只调它。
 *   不 import electron、不读全局状态 —— db 句柄由装配层用 `getDb` 注入，
 *   于是测试可以拿内存仓储 + 假画本写入器把 9 个操作全跑一遍（见
 *   `tests/main/chapter-service.test.ts`）。
 *
 * ### 三条贯穿全局的纪律
 *   1. **多写操作必须在一个事务里**（`withTransactionAsync`）—— 否则会出现「章节删了但文本没并进来」
 *      这类半成品，用户在界面上只看到「顺序怪怪的」，根本查不出来。
 *   2. **画本行是用户成果，不能静默销毁**：`merge` / `split` 会改变章节边界，
 *      而已有画本行的 `charStart/charEnd`（章内偏移）与行序都会失效。
 *      文档**没有规定**行迁移算法，所以本实现**拒绝**在已有画本行时合并/拆分
 *      （`INVALID_PAYLOAD`），而不是自己发明一套「看起来合理」的迁移。
 *   3. **删章节是软删除**（`docs/21`：音频相关实体禁物理删除）。
 *      `chapters → canvas_lines → voice_segments` 全是 `ON DELETE CASCADE`，
 *      物理删一章会顺手把录音**元数据**级联删掉（磁盘文件变孤儿、界面再也找不回来）。
 */

import { AppError } from '../../../../shared/errors.ts'
import { countNonEmptyLines } from '../../../../shared/text/lines.ts'
import type { CanvasLine, Chapter, ChapterProgress, Id, Timestamp } from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import type { Logger } from '../../../infra/log/index.ts'
import { withTransactionAsync } from '../../../infra/db/with-transaction.ts'
import {
  createSqliteChapterRepo,
  type SqliteChapterRepo,
} from '../import/repositories/chapter.repo.sqlite.ts'
/** 列表行：章节元数据 + 进度概览（契约 `chapter:list` 的 res） */
export type ChapterListRow = Chapter & { progress: ChapterProgress | null }

/**
 * 画本行写入端口。
 *
 * 为什么用**端口**而不是直接 import 画本仓储：`inserTitleLine` 是这 9 个通道里唯一
 * 需要写 `canvas_lines` 的，而画本域自己的 SQLite 仓储尚未落地（当前只有内存实现，
 * 且 `canvas:*` 通道仍是占位）。把它收敛成一个 5 个方法的小端口，好处是：
 *   · 章节域可以完整单测（注入假实现）；
 *   · 将来画本域落地 SQLite 仓储时，只要实现这个端口即可接上，不必改章节域。
 * 实现见 `features/book/canvas/repositories/canvas-line.repo.sqlite.ts`。
 */
export interface CanvasLineWriter {
  /** 该章未删除的画本行数 */
  countLines(chapterId: Id): Promise<number>
  /** 该章已有的「标题念白行」（`is_title = 1`），没有则 null */
  findTitleLine(chapterId: Id): Promise<CanvasLine | null>
  /** 把该章未删除行的 `seq` 整体 +1（为插到章首腾位置） */
  shiftSeqDown(chapterId: Id): Promise<void>
  /** 插入一行（**事务由调用方负责**） */
  insert(line: CanvasLine): Promise<void>
  /** 更新某行正文（幂等复用已有标题行时用） */
  updateText(lineId: Id, text: string): Promise<void>
}

export interface ChapterServiceDeps {
  getDb: () => DbLike | null
  log: Logger
  /** id 生成（测试可注入确定性实现） */
  newId?: () => Id
  /** 时间源（测试可注入） */
  now?: () => Timestamp
  canvasLines: CanvasLineWriter
}

export interface ChapterService {
  list(bookId: Id): Promise<ChapterListRow[]>
  get(chapterId: Id): Promise<Chapter>
  update(chapterId: Id, patch: Partial<Pick<Chapter, 'title' | 'kind' | 'volumeTitle'>>): Promise<Chapter>
  reorder(bookId: Id, orderedIds: readonly Id[]): Promise<{ ok: boolean }>
  merge(chapterIds: readonly Id[], title: string): Promise<Chapter>
  split(chapterId: Id, atOffsets: readonly number[]): Promise<Chapter[]>
  remove(chapterId: Id): Promise<{ ok: boolean }>
  stats(chapterId: Id): Promise<ChapterProgress>
  insertTitleLine(chapterId: Id): Promise<CanvasLine>
  /** 把整本书的 seq 重写为 1..N（拆分/删除后调用；也是单测入口） */
  renumber(bookId: Id): Promise<void>
}

/** 合并后章节之间的连接符（与导入预览期的 `mergeDrafts` 保持一致） */
const MERGE_JOINER = '\n\n'

export function createChapterService(deps: ChapterServiceDeps): ChapterService {
  const log = deps.log
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  const now = deps.now ?? (() => Date.now())

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) {
      // 与导入域口径一致：库没打开时所有操作都不可用（而不是抛个语焉不详的内部错误）
      throw new AppError('DB_NOT_OPEN', { details: { feature: 'chapter' } })
    }
    return db
  }

  const repo = (): SqliteChapterRepo => createSqliteChapterRepo(requireDb())

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /** 取章节，不存在（或已软删除）→ NOT_FOUND */
  async function requireChapter(chapterId: Id): Promise<Chapter> {
    const chapter = await repo().findById(chapterId)
    if (!chapter) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: chapterId } })
    return chapter
  }

  /**
   * 把整本书的 seq 重写为 1..N。
   *
   * 为什么需要：`seq` 虽然「允许非连续」（docs/21），但**拆分/插入新章后必须重写** ——
   * 否则新章会与后续章节撞 seq；而 DDL **没有** `UNIQUE(book_id, seq)`，
   * 数据库不会报错，只会在 `ORDER BY seq` 时给出不确定的顺序。
   * 渲染侧的 store 也明确期待「seq 由服务端权威重排」（`chapters.store.ts`）。
   */
  async function renumber(bookId: Id): Promise<void> {
    const r = repo()
    const list = await r.listByBook(bookId) // seq 升序
    for (let i = 0; i < list.length; i++) {
      const want = i + 1
      if (list[i]!.seq !== want) await r.update(list[i]!.id, { seq: want })
    }
  }

  /**
   * 按**显式顺序**把 seq 写成 1..N。
   *
   * 与 {@link renumber} 的区别：`renumber` 是「读出来（`ORDER BY seq`）再重写」，
   * 只在当前 seq **互不相同**时才可靠。拆分新插入的章节会临时与后续章节撞号，
   * 此时 `ORDER BY seq` 的顺序是未定义的 —— 必须由调用方给出确定的顺序。
   */
  async function applyOrder(bookId: Id, orderedIds: readonly Id[]): Promise<void> {
    const r = repo()
    for (let i = 0; i < orderedIds.length; i++) {
      await r.update(orderedIds[i]!, { seq: i + 1 })
    }
    void bookId
  }

  /**
   * 从 `fromSeq` 起重算 `charCount` / `startOffset` / `endOffset`。
   *
   * 合并与拆分都会改变「哪段正文属于哪一章」，而这些偏移是**全书字符偏移**
   * （`docs/21`），必须跟着重算，否则 §「拆分」之后所有后续章节的偏移都会漂。
   * 只从受影响的位置往后算（前面的章节没变），避免为一次拆分写全表。
   */
  async function relayoutFrom(bookId: Id, fromSeq: number): Promise<void> {
    const r = repo()
    const list = await r.listByBook(bookId)
    let cursor = 0
    for (const c of list) {
      if (c.seq < fromSeq) {
        cursor = c.endOffset
        continue
      }
      const text = await r.getText(c.id)
      const len = text?.text.length ?? c.charCount
      const start = cursor
      const end = start + len
      if (c.charCount !== len || c.startOffset !== start || c.endOffset !== end) {
        await r.update(c.id, { charCount: len, startOffset: start, endOffset: end })
      }
      cursor = end
    }
  }

  /**
   * 前置校验：这些章节**不能已经有画本行**。
   *
   * 合并/拆分会让已有画本行的「章内偏移」与行序失效，而文档没有规定迁移规则。
   * 与其发明一套（并静默搬运用户的录音成果），不如明确拒绝并说明原因 ——
   * 用户可以先在画本里处理，再回来合并/拆分。
   */
  async function assertNoCanvasLines(chapters: readonly Chapter[]): Promise<void> {
    const withLines: string[] = []
    for (const c of chapters) {
      if (c.canvasState !== 'none' || c.lineCount > 0) withLines.push(c.id)
      else if ((await deps.canvasLines.countLines(c.id)) > 0) withLines.push(c.id)
    }
    if (withLines.length > 0) {
      // 用专门的错误码而不是笼统的 INVALID_PAYLOAD：这是**用户可理解、可行动**的拒绝
      // （「先去画本里处理」），而不是「你的参数不合法」这种开发向的提示。
      throw new AppError('CHAPTER_HAS_CANVAS_LINES', {
        params: { count: String(withLines.length) },
        details: { chapterIds: withLines, operation: 'merge-or-split' },
      })
    }
  }

  // ---------------------------------------------------------------------------
  // 读
  // ---------------------------------------------------------------------------

  /**
   * 章节列表（seq 升序）+ 每章进度。
   *
   * 书不存在或没有章节时返回 `[]`（与 `book:list` 的宽松口径一致）——
   * 界面的空态文案是「这本书还没有章节」，抛 NOT_FOUND 反而会让空态变成报错。
   */
  async function list(bookId: Id): Promise<ChapterListRow[]> {
    const r = repo()
    const [chapters, progress] = await Promise.all([r.listByBook(bookId), r.listProgressByBook(bookId)])
    const byId = new Map(progress.map((p) => [p.chapterId, p]))
    return chapters.map((c) => ({ ...c, progress: byId.get(c.id) ?? null }))
  }

  async function get(chapterId: Id): Promise<Chapter> {
    return requireChapter(chapterId)
  }

  async function stats(chapterId: Id): Promise<ChapterProgress> {
    const progress = await repo().getProgress(chapterId)
    if (!progress) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: chapterId } })
    return progress
  }

  // ---------------------------------------------------------------------------
  // 单章编辑
  // ---------------------------------------------------------------------------

  /**
   * 改标题 / 类型 / 卷名。
   *
   * `volumeTitle` 的空串会**归一到 null**：领域类型是 `string | null`，
   * 而 UI 的「清除卷名」发的是空串 —— 库里存 `''` 会让「有没有设过卷名」变得难以判断
   * （`volume_title IS NOT NULL` 这种查询会得到意料之外的结果）。
   */
  async function update(
    chapterId: Id,
    patch: Partial<Pick<Chapter, 'title' | 'kind' | 'volumeTitle'>>,
  ): Promise<Chapter> {
    const normalized: Partial<Pick<Chapter, 'title' | 'kind' | 'volumeTitle'>> = { ...patch }
    if (normalized.volumeTitle !== undefined) {
      const v = normalized.volumeTitle
      normalized.volumeTitle = typeof v === 'string' && v.trim() === '' ? null : (v as string | null)
    }
    if (normalized.title !== undefined && normalized.title.trim() === '') {
      throw new AppError('INVALID_PAYLOAD', { details: { reason: 'chapter-title-empty', chapterId } })
    }
    return repo().update(chapterId, normalized)
  }

  // ---------------------------------------------------------------------------
  // 顺序
  // ---------------------------------------------------------------------------

  /**
   * 重排：按 `orderedIds` 的顺序把 seq 重写为 1..N。
   *
   * **必须校验集合完全相等**：契约的 schema 允许空数组、重复 id、甚至别的书的 id
   * （`v.array(Id)` 没有 min，也没有去重）。若不校验，会出现
   * 「一部分章节没被重排、seq 出现重复」这种静默错误 —— DDL 没有唯一约束，数据库不会拦。
   */
  async function reorder(bookId: Id, orderedIds: readonly Id[]): Promise<{ ok: boolean }> {
    const r = repo()
    const current = await r.listByBook(bookId)
    const currentIds = new Set(current.map((c) => c.id))
    const incoming = new Set(orderedIds)

    const missing = [...currentIds].filter((id) => !incoming.has(id))
    const extra = [...incoming].filter((id) => !currentIds.has(id))
    const dup = orderedIds.length !== incoming.size
    if (missing.length > 0 || extra.length > 0 || dup) {
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          reason: 'reorder-id-set-mismatch',
          bookId,
          missing,
          extra,
          duplicate: dup,
          hint: 'orderedIds 必须是这本书**全部**章节的 id（不重不漏）',
        },
      })
    }

    const db = requireDb()
    await withTransactionAsync(
      db,
      async () => {
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i]!
        const chapter = current.find((c) => c.id === id)!
        if (chapter.seq !== i + 1) await r.update(id, { seq: i + 1 })
      }
      },
      { log, eventPrefix: 'chapter.tx' },
    )
    return { ok: true }
  }

  // ---------------------------------------------------------------------------
  // 合并 / 拆分
  // ---------------------------------------------------------------------------

  /**
   * 合并若干章为一章。
   *
   * 语义（docs/91 §5.2.8 决策 4；先例是导入预览期的 `mergeDrafts`）：
   *   · 至少 2 章，且必须同属一本书；
   *   · 顺序由 **seq** 决定（不以入参顺序为准）；
   *   · 幸存者 = seq 最小的那一章（保住它的 id、卷信息与画本状态），标题取入参 `title`；
   *   · 正文按 `\n\n` 连接（先例同此），`charCount` / `lineCount` / 偏移按结果重算；
   *   · 其余章节**软删除**；
   *   · 任一章已有画本行 → 拒绝（见 `assertNoCanvasLines`）。
   */
  async function merge(chapterIds: readonly Id[], title: string): Promise<Chapter> {
    if (chapterIds.length < 2) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { reason: 'merge-needs-at-least-2', count: chapterIds.length },
      })
    }

    const r = repo()
    const unique = [...new Set(chapterIds)]
    const loaded: Chapter[] = []
    for (const id of unique) loaded.push(await requireChapter(id))

    const bookId = loaded[0]!.bookId
    const foreign = loaded.filter((c) => c.bookId !== bookId).map((c) => c.id)
    if (foreign.length > 0) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { reason: 'merge-cross-book', bookId, foreign, hint: '只能合并同一本书内的章节' },
      })
    }
    await assertNoCanvasLines(loaded)

    const ordered = [...loaded].sort((a, b) => a.seq - b.seq)
    const survivor = ordered[0]!
    const removed = ordered.slice(1)

    const parts: string[] = []
    for (const c of ordered) {
      const text = await r.getText(c.id)
      parts.push(text?.text ?? '')
    }
    const mergedText = parts.join(MERGE_JOINER)

    const db = requireDb()
    const updated = await withTransactionAsync(
      db,
      async () => {
        // 文本与元数据一起写：两者必须同生共死（分开写会留下「标题改了但文本没并」的中间态）
        await r.updateText(survivor.id, { rawText: mergedText, text: mergedText })
        const next = await r.update(survivor.id, {
          title: title.trim(),
          charCount: mergedText.length,
          lineCount: countNonEmptyLines(mergedText),
        })
        await r.softDeleteByIds(removed.map((c) => c.id))
        await renumber(bookId)
        await relayoutFrom(bookId, next.seq)
        return next
      },
      { log, eventPrefix: 'chapter.tx' },
    )

    log.info('chapter.merged', {
      event: 'chapter.merged',
      bookId,
      survivorId: survivor.id,
      mergedIds: removed.map((c) => c.id),
      chars: mergedText.length,
    })
    return (await r.findById(updated.id)) ?? updated
  }

  /**
   * 拆分一章。
   *
   * ⚠️ `atOffsets` 是**全书文本的绝对偏移**（`Chapter.startOffset` 的坐标系），
   * 不是章内相对偏移 —— 契约与文档都没写明，唯一的定义性证据是消费方
   * `chapters.store.ts`：它先把对话框收集的「章内偏移」加上 `startOffset` 才发过来。
   * 详见 docs/91 §5.2.8 决策 2。
   *
   * 结果：第 1 片**复用原章**（保住它的 id 与外部引用），其余为新建章节。
   * 返回**全部片段**（含第 1 片）—— 与导入预览期 `splitDraft()` 的先例一致。
   */
  async function split(chapterId: Id, atOffsets: readonly number[]): Promise<Chapter[]> {
    const r = repo()
    const chapter = await requireChapter(chapterId)
    const text = (await r.getText(chapterId))?.text ?? ''
    await assertNoCanvasLines([chapter])

    // 绝对偏移 → 章内偏移（同一套坐标系），并做边界校验
    const locals = [...new Set(atOffsets)]
      .map((o) => Math.round(o) - chapter.startOffset)
      .filter((o) => o > 0 && o < text.length)
      .sort((a, b) => a - b)
    if (locals.length === 0) {
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          reason: 'split-offsets-invalid',
          chapterId,
          startOffset: chapter.startOffset,
          endOffset: chapter.endOffset,
          textLength: text.length,
          hint: 'atOffsets 是全书绝对偏移，且必须严格落在本章 (startOffset, endOffset) 内',
        },
      })
    }

    // 切片（按章内偏移切，保证片与片之间不丢字符）
    const pieces: string[] = []
    let from = 0
    for (const at of locals) {
      pieces.push(text.slice(from, at))
      from = at
    }
    pieces.push(text.slice(from))

    // 空片段（只有空白）没有意义，丢弃 —— 先例：import.store 的 splitDraft
    const kept = pieces.filter((p) => p.trim().length > 0)
    if (kept.length < 2) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { reason: 'split-produces-no-content', chapterId, pieces: pieces.length },
      })
    }

    const baseSeq = chapter.seq
    const db = requireDb()
    const created = await withTransactionAsync(
      db,
      async () => {
        const ts = now()
        // 先记下「这一章前后各有哪些章」—— 拆分后要按这个显式顺序重写 seq，
        // 不能依赖 `ORDER BY seq`（新插入的章会临时撞号，排序结果不确定）
        const beforeSplit = await r.listByBook(chapter.bookId)
        const idsBefore = beforeSplit.filter((c) => c.seq < baseSeq).map((c) => c.id)
        const idsAfter = beforeSplit.filter((c) => c.seq > baseSeq).map((c) => c.id)

        // 第 1 片：复用原章
        await r.updateText(chapter.id, { rawText: kept[0]!, text: kept[0]! })
        await r.update(chapter.id, {
          charCount: kept[0]!.length,
          lineCount: countNonEmptyLines(kept[0]!),
          // 正文被改过 ⇒ 画本状态回到「未生成」（此时必然没有画本行，见上面的前置校验）
          canvasState: 'none',
        })

        // 其余片段：新章（沿用原章的 kind / 卷归属；标题按先例加序号后缀）
        const rows = kept.slice(1).map((piece, i) => ({
          // 临时 seq：只要不与「重写前的顺序」冲突即可，真正的顺序由 applyOrder 决定
          seq: baseSeq + 1000 + i,
          piece,
          title: `${chapter.title}（${i + 2}/${kept.length}）`,
        }))
        const newChapters: Chapter[] = rows.map((row) => ({
          id: newId(),
          bookId: chapter.bookId,
          seq: row.seq,
          title: row.title,
          kind: chapter.kind,
          volumeSeq: chapter.volumeSeq,
          volumeTitle: chapter.volumeTitle,
          charCount: row.piece.length,
          startOffset: 0, // 由 relayoutFrom 统一重算
          endOffset: 0,
          canvasState: 'none',
          lineCount: countNonEmptyLines(row.piece),
          createdAt: ts,
          updatedAt: ts,
        }))
        await r.insertMany(
          newChapters.map((c, i) => ({ chapter: c, rawText: rows[i]!.piece, text: rows[i]!.piece })),
        )
        // 显式顺序：前面的章 → 原章（第 1 片）→ 新片 → 后面的章
        await applyOrder(chapter.bookId, [
          ...idsBefore,
          chapter.id,
          ...newChapters.map((c) => c.id),
          ...idsAfter,
        ])
        await relayoutFrom(chapter.bookId, baseSeq)

        const out: Chapter[] = []
        for (const c of [chapter, ...newChapters]) out.push((await r.findById(c.id)) ?? c)
        return out
      },
      { log, eventPrefix: 'chapter.tx' },
    )

    log.info('chapter.split', {
      event: 'chapter.split',
      chapterId,
      pieces: created.length,
      atOffsets: locals.length,
    })
    return created
  }

  // ---------------------------------------------------------------------------
  // 删除
  // ---------------------------------------------------------------------------

  /**
   * 删除一章（**软删除**）。
   *
   * 为什么不是物理删除：`docs/21` §「软删除」写着「音频相关实体禁物理删除」。
   * 物理删会沿 `chapters → canvas_lines → voice_segments` 的 `ON DELETE CASCADE`
   * 把录音**元数据**一起销毁（磁盘文件还在，但界面再也找不回来）。
   * 软删除后读路径（都过滤 `deleted_at IS NULL`）立刻看不到它，
   * 用户看到的效果与「删掉了」一致，但数据可恢复。
   */
  async function remove(chapterId: Id): Promise<{ ok: boolean }> {
    const chapter = await requireChapter(chapterId)
    const r = repo()
    const db = requireDb()
    await withTransactionAsync(
      db,
      async () => {
        await r.softDeleteByIds([chapterId])
        await renumber(chapter.bookId)
        await relayoutFrom(chapter.bookId, chapter.seq)
      },
      { log, eventPrefix: 'chapter.tx' },
    )
    log.info('chapter.removed', { event: 'chapter.removed', chapterId, bookId: chapter.bookId })
    return { ok: true }
  }

  // ---------------------------------------------------------------------------
  // 章首标题念白行
  // ---------------------------------------------------------------------------

  /**
   * 在章首插入「标题念白行」（docs/15 §「章首标题念白」）。
   *
   * 语义：
   *   · 行内容 = 章节标题；`kind='narration'`、`isTitle=true`、`speakerType='narration'`；
   *   · `seq = 0`，该章已有行的 `seq` 整体 +1（与生成路径的编号一致：标题行占 0，正文从 1 起 ——
   *     先例见 `shared/canvas/attribution.ts` 的标题行构造）；
   *   · **幂等**：已有标题行时更新其正文并返回它，不会点两次变两行；
   *     但该行若被人工改过（`decidedBy = 'human'`）则**不覆盖**（docs/11 §3「人工结果永不覆盖」）。
   */
  async function insertTitleLine(chapterId: Id): Promise<CanvasLine> {
    const chapter = await requireChapter(chapterId)
    const title = chapter.title.trim()
    if (title === '') {
      throw new AppError('INVALID_PAYLOAD', { details: { reason: 'chapter-title-empty', chapterId } })
    }

    const existing = await deps.canvasLines.findTitleLine(chapterId)
    if (existing) {
      if (existing.decidedBy === 'human' || existing.text === title) return existing
      const db0 = requireDb()
      await withTransactionAsync(db0, () => deps.canvasLines.updateText(existing.id, title), {
        log,
        eventPrefix: 'chapter.tx',
      })
      return { ...existing, text: title, updatedAt: now() }
    }

    const ts = now()
    const line: CanvasLine = {
      id: newId(),
      chapterId,
      bookId: chapter.bookId,
      seq: 0,
      speakerType: 'narration',
      characterId: null,
      kind: 'narration',
      text: title,
      sourceText: title,
      // 标题行不占用正文偏移（先例：attribution.ts 的标题行 charStart/charEnd = 0）
      charStart: 0,
      charEnd: 0,
      emotion: null,
      emotionIntensity: null,
      speed: null,
      gainDb: null,
      pauseAfterMs: 500,
      pauseInline: null,
      pronunciation: null,
      note: null,
      state: 'draft',
      confidence: null,
      candidates: null,
      decidedBy: null,
      needsReview: false,
      flags: [],
      isTitle: true,
      rev: 1,
      createdAt: ts,
      updatedAt: ts,
    }

    const db = requireDb()
    await withTransactionAsync(
      db,
      async () => {
        await deps.canvasLines.shiftSeqDown(chapterId)
        await deps.canvasLines.insert(line)
        // 章节的画本状态与行数跟着变（否则列表页会显示「未生成 / 0 行」，
        // 而实际上已经有标题行了）
        await repo().update(chapterId, {
          canvasState: chapter.canvasState === 'none' ? 'generated' : chapter.canvasState,
          lineCount: await deps.canvasLines.countLines(chapterId),
        })
      },
      { log, eventPrefix: 'chapter.tx' },
    )

    log.info('chapter.titleLine.inserted', { event: 'chapter.titleLine.inserted', chapterId, lineId: line.id })
    return line
  }

  return { list, get, update, reorder, merge, split, remove, stats, insertTitleLine, renumber }
}
