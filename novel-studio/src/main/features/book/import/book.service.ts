/**
 * Novel Studio · 书籍导入域服务（IPC handler 背后的实现）
 * ============================================================================
 * 设计依据：docs/10-功能域-书籍导入.md（全篇）、docs/21 §3「books/chapters/chapter_rule_sets」
 *
 * ### 本文件的位置
 *   `import.service.ts` 里已经有**完整的导入算法**（探测 → 读取 → 解码 → 清洗 → 分章 → 入库），
 *   它是零 Electron、零 SQLite 依赖的纯逻辑。本文件是**把它接到真实环境上的那一层**：
 *   真实仓储（SQLite）、真实解码器（iconv-lite）、真实文件系统、真实任务队列。
 *
 *   所以这里几乎没有业务逻辑 —— 它的价值在于「不再有任何环节是缺的」。
 *
 * ### 几个必须说清的点
 *   1. **项目（project）是自动确保的**：契约里没有 `project:create`，而 `books.project_id`
 *      是 NOT NULL 外键，因此导入前必须先有项目。见 `project.repo.ts` 的说明。
 *   2. **`book:importFile/Text/Url` 返回 taskId**：契约如此，所以它们真的跑在队列上，
 *      不是假的任务号。进度通过 `task:progress` 事件推给 UI。
 *   3. **解码器显式注入 iconv-lite**：不注入的话，GBK/GB18030 只能识别出编码名、
 *      给不出文本预览（`encoding.ts` 会用 NO_DECODER_NOTE 说明）。iconv-lite 是依赖里有的。
 */

import { promises as fsp } from 'node:fs'

import { AppError } from '../../../../shared/errors.ts'
import { BUILTIN_RULE_SETS } from '../../../../shared/constants.ts'
import type {
  Book,
  Chapter,
  ChapterRuleSet,
  EncodingDetection,
  Id,
  ImportFileProbe,
} from '../../../../shared/types.ts'
import type { CleanOptions, CleanReportDetail } from '../../../../shared/text/clean.ts'
import type { ChapterDraft } from '../../../../shared/types.ts'
import { detectEncoding, type Decoder } from '../../../../shared/text/encoding.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import type { Logger } from '../../../infra/log/index.ts'
import type { TaskSpec } from '../../../infra/queue/types.ts'
import type { TaskQueue } from '../../../infra/queue/queue.ts'
import { createSqliteBookRepo } from './repositories/book.repo.sqlite.ts'
import { createSqliteChapterRepo } from './repositories/chapter.repo.sqlite.ts'
import { createSqliteProjectRepo, type ProjectRepo } from './repositories/project.repo.ts'
import { probeFile as probeFileImpl } from './parsers/index.ts'
import {
  runImport,
  type ImportRequest,
  type ImportPreview,
  type ImportTxContext,
} from './import.service.ts'

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

export interface BookServiceDeps {
  getDb: () => DbLike | null
  /** `{userData}/projects`（项目目录的父目录） */
  projectRoot: string
  log: Logger
  /** 任务队列（importFile/Text/Url 用；不传时这些通道抛 TASK_QUEUE_UNAVAILABLE） */
  queue?: TaskQueue
  /** 项目级覆盖设置里声明的最大文件大小 / 抓取参数 */
  importLimits?: { maxFileSizeBytes?: number }
}

export interface CommitImportRequest {
  projectId: Id
  bookMeta: {
    title: string
    author?: string | null
    narrator?: string
    language?: string
    coverPath?: string | null
  }
  source: {
    type: Book['sourceType']
    path?: string | null
    encoding?: string | null
    contentHash: string
  }
  drafts: ChapterDraft[]
}

export interface ChapterRuleSets {
  list(): Promise<ChapterRuleSet[]>
  save(ruleSet: ChapterRuleSet): Promise<ChapterRuleSet>
  remove(id: string): Promise<boolean>
}

export interface BookService {
  // 只读
  list(projectId?: Id): Promise<Book[]>
  get(bookId: Id): Promise<Book>
  update(bookId: Id, patch: Partial<Pick<Book, 'title' | 'author' | 'narrator' | 'language' | 'coverPath'>>): Promise<Book>
  remove(bookId: Id, deleteAudio?: boolean): Promise<{ ok: boolean }>

  // 导入流程
  probeFile(filePath: string): Promise<ImportFileProbe>
  detectEncoding(filePath: string, sampleBytes?: number): Promise<EncodingDetection>
  previewSplit(input: {
    filePath?: string
    text?: string
    ruleSetId?: string | null
    cleanOptions?: Record<string, boolean>
  }): Promise<{ drafts: ChapterDraft[]; cleanReport: CleanReportDetail; encoding: string }>
  commitImport(req: CommitImportRequest): Promise<{ bookId: Id; chapterCount: number }>
  findDuplicate(contentHash: string, projectId: Id): Promise<{ exists: boolean; bookId: Id | null }>

  // 规则集
  ruleSets: ChapterRuleSets

  // 异步导入（队列）
  importFile(projectId: Id, filePath: string, options?: Record<string, unknown>): Promise<{ taskId: Id }>
  importText(projectId: Id, text: string, title: string, options?: Record<string, unknown>): Promise<{ taskId: Id }>
  importUrl(projectId: Id, url: string, options?: Record<string, unknown>): Promise<{ taskId: Id }>

  /** 确保默认项目存在（启动期调用；也用于导入前的兜底） */
  ensureProject(projectId?: Id | null): Promise<Id>

  /** 队列要用的 TaskSpec（由 ports.ts 合并进 TaskQueue） */
  taskSpecs(): Array<TaskSpec<unknown, unknown>>
  /** 章节读取（画本域会用到；这里先暴露最小面） */
  listChapters(bookId: Id): Promise<Chapter[]>
}

// ---------------------------------------------------------------------------
// 解码器（iconv-lite 注入）
// ---------------------------------------------------------------------------

/**
 * 用 iconv-lite 构造解码器表。
 *
 * ### `Decoder` 是**可调用对象**，不是带字段的对象
 *   `shared/text/encoding.ts` 的定义是：
 *
 *     export interface Decoder {
 *       (buf: Buffer): string | null
 *       stream?: (buf: Buffer, flush?: boolean) => string | null
 *     }
 *
 *   即「一个函数，也可以挂 stream 方法」。最初我写成 `{ encoding, decode }`
 *   这样的普通对象，类型检查直接报 TS2353 —— 那个定义是对的，改成函数即可。
 *   `encoding.ts` 的注释里也给了生产环境的写法：
 *     `const decoder: Decoder = (buf) => iconv.decode(buf, 'gb18030')`
 *
 * ### 为什么要注入
 *   `encoding.ts` 的 BOM / 严格 UTF-8 / 打分逻辑是自实现的，UTF-8 与 UTF-16 用
 *   Node 内置 `TextDecoder` 必然可用；但 **GBK / GB18030 / Big5 在 small-icu 构建下不可用**。
 *   不注入时 `createDecoder` 返回 null，检测结果会带 `NO_DECODER_NOTE`
 *   （「本环境无此编码的解码器」）—— 用户能看到编码名却看不到预览文本。
 *   而 iconv-lite 是依赖里已有的，注进去这条链路才算完整。
 *
 * 动态 import：iconv-lite 是纯 JS 第三方包，放在函数内可以让「没装它」的情况
 * 退回「无解码器」而不是让整个域在模块加载期就炸掉。
 */
async function buildIconvDecoders(): Promise<Record<string, Decoder>> {
  const out: Record<string, Decoder> = {}
  let iconv: typeof import('iconv-lite') | null = null
  try {
    iconv = (await import(/* @vite-ignore */ 'iconv-lite')) as unknown as typeof import('iconv-lite')
  } catch {
    return out
  }
  const ic = iconv
  // 键名同时给大写与规范名：encoding.ts 的 createDecoder 会依次尝试
  // GB18030 / gb18030 / GB18030 / GBK，写全一点更稳
  const encodings = ['gb18030', 'gbk', 'gb2312', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'windows-1252', 'latin1']
  for (const enc of encodings) {
    if (!ic.encodingExists(enc)) continue
    const decoder: Decoder = (buf: Buffer): string | null => {
      try {
        return ic.decode(buf, enc)
      } catch {
        // 解码器抛错时返回 null（契约允许），由上层按「无解码器」处理
        return null
      }
    }
    out[enc] = decoder
    out[enc.toUpperCase()] = decoder
    if (enc === 'gb18030') out['GBK'] = decoder // gbk 的解码目标就是 gb18030（docs/10 §4.2）
  }
  return out
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export function createBookService(deps: BookServiceDeps): BookService {
  const log = deps.log

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { op: 'book' } })
    return db
  }

  /** 每次调用现取仓储：数据库句柄可能在「从备份恢复」后换成新的 */
  function repos(): {
    books: ReturnType<typeof createSqliteBookRepo>
    chapters: ReturnType<typeof createSqliteChapterRepo>
    projects: ProjectRepo
  } {
    const db = requireDb()
    return {
      books: createSqliteBookRepo(db),
      chapters: createSqliteChapterRepo(db),
      projects: createSqliteProjectRepo(db),
    }
  }

  /** 解码器缓存：首次构造有动态 import 成本，之后复用 */
  let decoderCache: Record<string, Decoder> | null = null
  async function decoders(): Promise<Record<string, Decoder>> {
    if (!decoderCache) decoderCache = await buildIconvDecoders()
    return decoderCache
  }

  /**
   * 真实事务包装。
   *
   * better-sqlite3 的 `db.transaction()` 要求回调**同步**，而 `runImport` 的
   * `withTransaction` 签名允许 async。这里用 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`
   * 手工控制：写法更长，但支持 async 回调（`insertMany` 是 async 的）。
   *
   * 用 IMMEDIATE 而不是 DEFERRED：导入是「先读后写」的形状，
   * DEFERRED 会在第一次写时才拿写锁，两个并发导入会在中途死锁/报 BUSY。
   */
  async function withTransaction<T>(fn: (tx: ImportTxContext) => Promise<T> | T): Promise<T> {
    const db = requireDb()
    const tx: ImportTxContext = {
      bookRepo: createSqliteBookRepo(db),
      chapterRepo: createSqliteChapterRepo(db),
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = await fn(tx)
      db.exec('COMMIT')
      return out
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackErr) {
        // 回滚失败意味着连接状态不可信：记下来，别吞掉
        log.warn('book.tx.rollbackFailed', {
          event: 'book.tx.rollbackFailed',
          reason: String(rollbackErr),
          cause: e instanceof Error ? e.message : String(e),
        })
      }
      throw e
    }
  }

  /** 组装 runImport 的依赖（每次调用现取，保证用的是当前库） */
  async function importDeps(): Promise<Parameters<typeof runImport>[1]> {
    const r = repos()
    return {
      bookRepo: r.books,
      chapterRepo: r.chapters,
      withTransaction,
      readFile: (p: string) => fsp.readFile(p),
      statFile: async (p: string) => ({ size: (await fsp.stat(p)).size }),
      decoders: await decoders(),
      sha256: (data) => defaultSha256Hex(data),
      newId: () => randomId(),
      now: () => Date.now(),
    }
  }

  /**
   * 确保默认项目存在。
   *
   * 启动期调一次（让「列书/导入」开箱可用），导入前也会调（防用户删库/换库后失效）。
   * 导出给装配层用，因此它是 `BookService` 接口的一部分。
   */
  async function ensureProject(projectId: Id | null = null): Promise<string> {
    const { projects } = repos()
    const p = await projects.ensureDefault({
      projectId,
      projectRoot: deps.projectRoot,
    })
    return p.id
  }

  // ── 只读 ─────────────────────────────────────────────────────────────────

  async function list(projectId?: Id): Promise<Book[]> {
    const { books } = repos()
    return books.list(projectId ? { projectId } : {})
  }

  async function get(bookId: Id): Promise<Book> {
    const { books } = repos()
    const book = await books.findById(bookId)
    if (!book) throw new AppError('NOT_FOUND', { details: { what: 'book', bookId } })
    return book
  }

  async function update(
    bookId: Id,
    patch: Partial<Pick<Book, 'title' | 'author' | 'narrator' | 'language' | 'coverPath'>>,
  ): Promise<Book> {
    const { books } = repos()
    return books.update(bookId, patch)
  }

  async function remove(bookId: Id, deleteAudio?: boolean): Promise<{ ok: boolean }> {
    const { books } = repos()
    const book = await books.findById(bookId)
    if (!book) throw new AppError('NOT_FOUND', { details: { what: 'book', bookId } })
    // 删书时一并删章节（FK ON DELETE CASCADE 也会做，这里显式删是为了让返回的计数可信）
    const { chapters } = repos()
    const removed = await chapters.deleteByBook(bookId)
    const ok = await books.deleteById(bookId)
    log.info('book.deleted', { event: 'book.deleted', bookId, chapters: removed, deleteAudio: deleteAudio === true })
    // 音频文件的删除属录音域（`deleteAudio` 需要项目目录遍历），这里不假装做了
    if (deleteAudio === true) {
      log.warn('book.deleteAudio.notImplemented', {
        event: 'book.deleteAudio.notImplemented',
        bookId,
        reason: '音频清理属于录音域，本轮未接线（见 docs/91）',
      })
    }
    return { ok }
  }

  // ── 导入流程 ─────────────────────────────────────────────────────────────

  async function probeFile(filePath: string): Promise<ImportFileProbe> {
    const st = await fsp.stat(filePath).catch((e: unknown) => {
      throw new AppError('FILE_NOT_FOUND', { cause: e, details: { filePath } })
    })
    if (!st.isFile()) {
      throw new AppError('INVALID_PAYLOAD', { details: { reason: '不是文件', filePath } })
    }
    // 只需读头部若干字节即可判定类型（见 parsers/index.ts 的二进制嗅探）
    const head = await readHead(filePath, 64 * 1024)
    const probed = probeFileImpl({ filePath, buffer: head })
    log.info('book.probe', { event: 'book.probe', filePath, kind: probed.kind, parser: probed.parser ?? null })
    return probed
  }

  async function detectEncodingOf(filePath: string, sampleBytes?: number): Promise<EncodingDetection> {
    const buf = await readHead(filePath, sampleBytes ?? 64 * 1024)
    // 注入解码器与嗅探器：没有解码器时 GBK 只能给出编码名（会有 NO_DECODER_NOTE 说明）
    const det = detectEncoding(buf, { decoders: await decoders() })
    log.info('book.detectEncoding', {
      event: 'book.detectEncoding',
      filePath,
      encoding: det.encoding,
      confidence: det.confidence,
      needsUserChoice: det.needsUserChoice === true,
    })
    return det
  }

  async function previewSplit(input: {
    filePath?: string
    text?: string
    ruleSetId?: string | null
    cleanOptions?: Record<string, boolean>
  }): Promise<{ drafts: ChapterDraft[]; cleanReport: CleanReportDetail; encoding: string }> {
    const ruleSet = await resolveRuleSet(input.ruleSetId ?? null)
    const projectId = await ensureProject(null)

    const request: ImportRequest = {
      projectId,
      source: input.filePath
        ? { type: 'file', filePath: input.filePath }
        : { type: 'paste', text: input.text ?? '', ...(input.text ? { title: '' } : {}) },
      ruleSet,
      ...(input.cleanOptions ? { cleanOptions: input.cleanOptions as CleanOptions } : {}),
      // 关键：只看预览，不入库（runImport 的原生能力，见 import.service.ts 第 ⑦ 步）
      persist: false,
      duplicatePolicy: 'copy',
    }

    const result = await runImport(request, await importDeps())
    const preview: ImportPreview = result.preview
    log.info('book.previewSplit', {
      event: 'book.previewSplit',
      drafts: preview.chapters.length,
      strategy: preview.split.strategy,
      encoding: preview.encoding,
      chars: preview.totalChars,
    })
    return {
      drafts: preview.chapters,
      cleanReport: preview.cleanReport,
      // 契约里这个字段是非空 string；未检测到编码（如粘文本）时用 'utf-8' 收敛
      encoding: preview.encoding ?? 'utf-8',
    }
  }

  /**
   * 落库已确认的草稿。
   *
   * 与 `runImport` 的区别：这里**不重新解析文本** —— 用户已经在预览界面确认过
   * drafts（可能改了标题、取消了勾选），重新解析会丢掉这些人工干预。
   * 因此本方法只做「drafts → books + chapters」这一步。
   */
  async function commitImport(req: CommitImportRequest): Promise<{ bookId: Id; chapterCount: number }> {
    const { books, chapters, projects } = repos()
    const projectId = await ensureProject(req.projectId)
    void projects

    const included = req.drafts.filter((d) => d.included)
    if (included.length === 0) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { reason: '没有勾选任何章节', drafts: req.drafts.length },
      })
    }

    const now = Date.now()
    const bookId = randomId()
    const totalChars = included.reduce((s, d) => s + d.charCount, 0)

    const book: Book = {
      id: bookId,
      projectId,
      title: req.bookMeta.title.trim().slice(0, 200) || '未命名作品',
      author: req.bookMeta.author ?? null,
      narrator: req.bookMeta.narrator ?? '旁白',
      language: req.bookMeta.language ?? 'zh-CN',
      sourceType: req.source.type,
      sourcePath: req.source.path ?? null,
      encoding: req.source.encoding ?? null,
      contentHash: req.source.contentHash,
      charCount: totalChars,
      chapterCount: included.length,
      coverPath: req.bookMeta.coverPath ?? null,
      createdAt: now,
      updatedAt: now,
    }

    const payload = included.map((draft, i) => ({
      chapter: buildChapterFromDraft(draft, { bookId, seq: i + 1, timestamp: now }),
      rawText: draft.rawText,
      text: draft.rawText,
    }))

    await withTransaction(async (tx) => {
      await tx.bookRepo.insert(book)
      await tx.chapterRepo.insertMany(payload)
    })

    log.info('book.committed', {
      event: 'book.committed',
      bookId,
      projectId,
      chapters: included.length,
      chars: totalChars,
      sourceType: book.sourceType,
    })
    void books
    void chapters
    return { bookId, chapterCount: included.length }
  }

  async function findDuplicate(contentHash: string, projectId: Id): Promise<{ exists: boolean; bookId: Id | null }> {
    const { books } = repos()
    const hit = await books.findByContentHash(contentHash)
    // 只在**同一项目内**算重复（不同项目各自独立，docs/10 §9）
    if (hit && hit.projectId === projectId) return { exists: true, bookId: hit.id }
    return { exists: false, bookId: null }
  }

  // ── 规则集 ───────────────────────────────────────────────────────────────

  const ruleSets: ChapterRuleSets = {
    async list(): Promise<ChapterRuleSet[]> {
      const merged = new Map<string, ChapterRuleSet>()
      for (const b of BUILTIN_RULE_SETS) merged.set(b.id, b)
      const db = deps.getDb()
      if (db) {
        try {
          const rows = db
            .prepare(`SELECT id, definition FROM chapter_rule_sets ORDER BY created_at ASC`)
            .all() as Array<{ id: string; definition: string }>
          for (const row of rows) {
            try {
              const parsed = JSON.parse(row.definition) as ChapterRuleSet
              // 用户保存的规则集**覆盖**同 id 的内置项（允许「改内置」）
              merged.set(parsed.id ?? row.id, parsed)
            } catch {
              log.warn('book.ruleSet.badJson', { event: 'book.ruleSet.badJson', id: row.id })
            }
          }
        } catch (e) {
          // 表不存在/库只读：退回内置集合，不让设置页整片失败
          log.warn('book.ruleSet.loadFailed', { event: 'book.ruleSet.loadFailed', reason: String(e) })
        }
      }
      return [...merged.values()]
    },

    async save(ruleSet: ChapterRuleSet): Promise<ChapterRuleSet> {
      const db = requireDb()
      const now = Date.now()
      const definition = JSON.stringify(ruleSet)
      db.prepare(
        `INSERT INTO chapter_rule_sets (id, project_id, name, builtin, definition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition,
                                       updated_at = excluded.updated_at`,
      ).run(ruleSet.id, null, ruleSet.name, ruleSet.builtin ? 1 : 0, definition, now, now)
      log.info('book.ruleSet.saved', { event: 'book.ruleSet.saved', id: ruleSet.id, name: ruleSet.name })
      return ruleSet
    },

    async remove(id: string): Promise<boolean> {
      const db = requireDb()
      const r = db.prepare(`DELETE FROM chapter_rule_sets WHERE id = ?`).run(id) as { changes?: number }
      const ok = (r.changes ?? 0) > 0
      log.info('book.ruleSet.removed', { event: 'book.ruleSet.removed', id, ok })
      return ok
    },
  }

  async function resolveRuleSet(ruleSetId: string | null): Promise<ChapterRuleSet> {
    const all = await ruleSets.list()
    if (!ruleSetId) return all[0] ?? BUILTIN_RULE_SETS[0]!
    return all.find((r) => r.id === ruleSetId) ?? all[0] ?? BUILTIN_RULE_SETS[0]!
  }

  // ── 异步导入（队列）──────────────────────────────────────────────────────

  function requireQueue(): TaskQueue {
    if (!deps.queue) {
      throw new AppError('NOT_IMPLEMENTED', {
        params: { feature: '异步导入' },
        details: { reason: 'task-queue-unavailable' },
      })
    }
    return deps.queue
  }

  async function enqueueImport(
    kind: 'book.import',
    projectId: Id,
    source: ImportRequest['source'],
    options?: Record<string, unknown>,
  ): Promise<{ taskId: Id }> {
    const q = requireQueue()
    const pid = await ensureProject(projectId)
    const res = await q.enqueue(
      kind,
      { projectId: pid, source, options: options ?? {} },
      { priority: 0, projectId: pid },
    )
    log.info('book.import.enqueued', { event: 'book.import.enqueued', taskId: res.taskId, deduped: res.deduped })
    return { taskId: res.taskId }
  }

  async function importFile(projectId: Id, filePath: string, options?: Record<string, unknown>): Promise<{ taskId: Id }> {
    return enqueueImport('book.import', projectId, { type: 'file', filePath }, options)
  }

  async function importText(
    projectId: Id,
    text: string,
    title: string,
    options?: Record<string, unknown>,
  ): Promise<{ taskId: Id }> {
    return enqueueImport('book.import', projectId, { type: 'paste', text, title }, options)
  }

  async function importUrl(projectId: Id, url: string, options?: Record<string, unknown>): Promise<{ taskId: Id }> {
    return enqueueImport('book.import', projectId, { type: 'url', url }, options)
  }

  /**
   * 队列用的 TaskSpec。
   *
   * 任务体真的调 `runImport`（带进度上报 + 取消检查），因此
   * `task:progress` / `task:succeeded` / `task:failed` 都是真实语义。
   */
  function taskSpecs(): Array<TaskSpec<unknown, unknown>> {
    return [
      {
        kind: 'book.import',
        concurrencyKey: 'db-write', // 写库类任务串行（docs/04 §2.2）
        priority: 0,
        maxAttempts: 1, // 导入不是幂等操作，失败不自动重试（避免重复建书）
        run: async (ctx, payload) => {
          const p = payload as {
            projectId: Id
            source: { type: string; filePath?: string; text?: string; title?: string; url?: string }
            options: Record<string, unknown>
          }
          ctx.report(0.01, 'probe')
          const ruleSet = await resolveRuleSet((p.options.ruleSetId as string | undefined) ?? null)
          const request: ImportRequest = {
            projectId: p.projectId,
            source: p.source as ImportRequest['source'],
            ruleSet,
            ...(p.options.cleanOptions ? { cleanOptions: p.options.cleanOptions as CleanOptions } : {}),
            persist: true,
            // 任务包/批量导入场景默认「作为副本」，避免因为内容相同直接失败
            duplicatePolicy: 'copy',
            signal: ctx.signal,
            onProgress: (prog) => {
              // 把内部阶段映射到 0..1（内部已给 progress，直接用）
              ctx.report(Math.min(1, Math.max(0, prog.progress)), prog.stage)
            },
          }
          const result = await runImport(request, await importDeps())
          ctx.report(1, 'done')
          return { bookId: result.bookId, chapters: result.preview.chapters.length, warnings: result.warnings.length }
        },
      },
    ]
  }

  async function listChapters(bookId: Id): Promise<Chapter[]> {
    const { chapters } = repos()
    return chapters.listByBook(bookId)
  }

  return {
    list,
    get,
    update,
    remove,
    probeFile,
    detectEncoding: detectEncodingOf,
    previewSplit,
    commitImport,
    findDuplicate,
    ruleSets,
    ensureProject,
    importFile,
    importText,
    importUrl,
    taskSpecs,
    listChapters,
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 只读文件头 N 字节（探测类型与编码不需要整个文件） */
async function readHead(filePath: string, bytes: number): Promise<Buffer> {
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

function randomId(): string {
  // 与仓库其它地方一致：用 node:crypto 的 randomUUID
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return globalThis.crypto.randomUUID()
}

function defaultSha256Hex(data: string | Uint8Array): string {
  // 延迟 import 太重；这里用 crypto 的同步版本（Node 内置）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(data).digest('hex')
}

function countNonEmptyLines(text: string): number {
  let n = 0
  for (const line of text.split('\n')) if (line.trim().length > 0) n++
  return n
}

/** drafts → Chapter（与 import.service.ts 的 buildChapter 同语义，但不需要 volumes 上下文） */
function buildChapterFromDraft(
  draft: ChapterDraft,
  ctx: { bookId: Id; seq: number; timestamp: number },
): Chapter {
  return {
    id: randomId(),
    bookId: ctx.bookId,
    seq: ctx.seq,
    title: draft.title,
    kind: draft.kind,
    volumeSeq: draft.volumeIndex,
    // 卷名：draft 里只有 volumeIndex，没有卷标题（卷标题在 split 结果的 volumes 里）。
    // commitImport 收到的是已确认的 drafts，卷标题已丢失 —— 这里保留 null 而不是编一个。
    volumeTitle: null,
    charCount: draft.charCount,
    startOffset: draft.startOffset,
    endOffset: draft.endOffset,
    canvasState: 'none',
    lineCount: countNonEmptyLines(draft.rawText),
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  }
}
