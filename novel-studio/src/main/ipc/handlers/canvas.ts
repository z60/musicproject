/**
 * Novel Studio · IPC handler · 画本域（`canvas:*`）
 * ============================================================================
 * 设计依据：docs/20 §4.3、docs/11 §2（生成）/§4（编辑器）/§5（质检）/§8（边界）
 *
 * 与 `handlers/book.ts`、`handlers/chapter.ts` 同一套纪律：
 *   1. **载荷校验在注册层**（`IPC_REQ_SCHEMAS`）——这里拿到的是校验过的形状；
 *      但**跨字段/跨实体的业务边界**必须在这里或服务层挡（schema 表达不了）。
 *   2. **逻辑在服务层**：`canvas.service` / `attribution.service` 已经完整实现，
 *      这里只做「取正文 / 合成选项 / 转任务 / 写章节状态」这类**编排**。
 *   3. **按当前 db 现取**：库可能在「从备份恢复」后被换成新连接，
 *      持有旧连接的仓储会读到已关闭的库，所以每次调用都现建（构造很轻）。
 *
 * 两个通道（`canvas:generate` / `canvas:recomputeAttribution`）返回 `{ taskId }`，
 * 真正的活在队列里跑 —— 见 `canvas.tasks.ts`（`HandlerDeps.tasks` 只能读、不能入队）。
 */

import { AppError } from '../../../shared/errors.ts'
import type { AppSettings, CanvasLine, CanvasLinePatch, Id, QualityIssue } from '../../../shared/types.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CanvasFeature } from '../../features/book/canvas/index.ts'
import type { CanvasTasks } from '../../features/book/canvas/canvas.tasks.ts'
import type { CanvasRepo } from '../../features/book/canvas/repositories/canvas.repo.ts'
import type { SqliteChapterRepo } from '../../features/book/import/repositories/chapter.repo.sqlite.ts'
import { h, type RegisteredHandler } from './deps.ts'

/** 每次调用现取的画本域上下文（库句柄可能已更换） */
export interface CanvasHandlerContext {
  feature: CanvasFeature
  canvasRepo: CanvasRepo
  chapters: SqliteChapterRepo
}

export interface CanvasHandlerDeps {
  ctx: () => CanvasHandlerContext
  tasks: CanvasTasks
  /** 设置里的画本段（合成判定选项与质检阈值） */
  canvasSettings: () => AppSettings['canvas']
  /** 导出文本时的默认目录（`outPath` 省略时用） */
  exportDir: () => string
  log: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
  }
}

/** 快照 reason 的白名单（契约里是裸 string，非法值按 `manual` 处理） */
const SNAPSHOT_REASONS = new Set(['pre_generate', 'manual', 'pre_restore'])

/** 文件名里不能出现的字符（Windows 与 POSIX 各有一批） */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '画本'
}

export function createCanvasHandlers(deps: CanvasHandlerDeps): RegisteredHandler[] {
  /**
   * 合成判定选项（`canvas:recomputeAttribution` 的契约里没有 `options`，
   * 而 `attribution.service` 的 `RecomputeRequest.options` 是必填）。
   *
   * 取值口径：阈值类来自 `settings.canvas`（用户可调）；`useEmbedding` / `useLlm`
   * 固定 `false` —— 生产环境注入的是 `null` provider（没有 ONNX 与 LLM），
   * 传 true 只会得到「不可用」的警告。`overwriteHuman` 固定 `false`：
   * 契约里没有这个字段，默认「人工结果永不覆盖」（docs/11 §3）。
   */
  function synthOptions() {
    const canvas = deps.canvasSettings()
    return {
      useEmbedding: false,
      useLlm: false,
      contextWindow: canvas.contextWindow,
      threshold: canvas.attributionThreshold,
      margin: canvas.attributionMargin,
      ruleSetId: null,
      overwriteHuman: false,
      inferTags: true,
    }
  }

  /** 质检阈值：能从设置里取的就取，其余交给 `qualityCheck` 的默认值 */
  function qualityOpts() {
    const canvas = deps.canvasSettings()
    return {
      maxLineChars: canvas.maxLineChars,
      maxNarrationRun: canvas.maxNarrationRun,
      defaultPauseAfterMs: canvas.defaultPauseAfterMs,
    }
  }

  /** 取章节（不存在则 NOT_FOUND）——多个通道都要这一步 */
  async function requireChapter(ctx: CanvasHandlerContext, chapterId: Id) {
    const chapter = await ctx.chapters.findById(chapterId)
    if (!chapter) throw new AppError('NOT_FOUND', { details: { what: 'chapter', id: chapterId } })
    return chapter
  }

  return [
    // ── 读 ─────────────────────────────────────────────────────────────────
    h('canvas:getChapter', async (req) => {
      const ctx = deps.ctx()
      const all = await ctx.canvasRepo.listLines(req.chapterId)
      const filter = req.filter
      const matched = filter
        ? all.filter((l) => {
            if (filter.needsReview !== undefined && l.needsReview !== filter.needsReview) return false
            if (filter.speakerType !== undefined && l.speakerType !== filter.speakerType) return false
            if (filter.kind !== undefined && l.kind !== filter.kind) return false
            // `characterId: null` 的语义是「未分配」——契约类型是 `Id`，但 schema 允许 null，
            // 界面上「未分配」这一档正是靠它表达（docs/11 §4.2）
            if (filter.characterId !== undefined && l.characterId !== filter.characterId) return false
            return true
          })
        : all

      // `total` 必须是**筛选后**的总数：渲染侧用 `collected >= total` 判断翻页结束，
      // 给错会让待确认队列静默漏行或空转（见 canvas.store 的分页循环）
      const total = matched.length
      // **省略 `limit` = 不分页（返回全部）**：`review.store` 就是这样调用的
      // （`{ filter: { needsReview: true } }`，不带 limit/offset）。
      // 若在这里默认截断，超过该行数的章节会静默丢行。
      const lines =
        req.limit === undefined
          ? matched.slice(req.offset ?? 0)
          : matched.slice(req.offset ?? 0, (req.offset ?? 0) + req.limit)
      return { lines, total }
    }),

    h('canvas:getLine', async (req) => {
      const line = await deps.ctx().canvasRepo.getLine(req.lineId)
      if (!line) throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId: req.lineId } })
      return line
    }),

    /**
     * 本章最近一次的生成报告（docs/11 §2.4）。
     *
     * 从未生成过 → `null`（契约允许，渲染侧显示「还没生成」）。
     * 这里**不再抛占位错误**：报告已落库（003 迁移的 `canvas_generate_reports`），
     * 而以前抛错会被渲染侧的错误总线弹成 toast —— 打开画本编辑器就会看到一个
     * 「功能未提供」的报错（`canvas.store.loadReport` 虽吞掉了异常，但提示已经弹过了）。
     */
    h('canvas:getGenerateReport', async (req) => {
      await requireChapter(deps.ctx(), req.chapterId)
      return deps.ctx().canvasRepo.getGenerateReport(req.chapterId)
    }),

    // ── 写 ─────────────────────────────────────────────────────────────────
    h('canvas:updateLine', async (req) => {
      // 服务层负责：改过判定字段就置 `decidedBy='human'`；文本变了就作废该行向量
      return deps.ctx().feature.service.updateLine({
        lineId: req.lineId,
        patch: req.patch as CanvasLinePatch,
        ...(req.rev !== undefined ? { rev: req.rev } : {}),
      })
    }),

    h('canvas:batchUpdate', async (req) => {
      const lineIds = req.lineIds
      if (!lineIds || lineIds.length === 0) {
        // ⚠️ 契约允许「只给 filter」，但那**没有章节维度** —— 照它做等于「按条件更新全库」。
        // 渲染侧始终传 `lineIds`（canvas.store 的批量动作都带选中行），
        // 所以这里明确拒绝而不是猜一个范围：猜错会静默改动用户没选中的行。
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'canvas:batchUpdate',
            reason: 'lineIds-required',
            hint: '批量更新必须给出 lineIds；只给 filter 无法确定作用范围（契约缺 chapterId）',
          },
        })
      }
      const patch = req.patch as CanvasLinePatch
      const updated = await deps.ctx().feature.service.batchUpdate(
        lineIds.map((lineId) => ({ lineId, patch })),
      )
      return { updated }
    }),

    h('canvas:deleteLine', async (req) => {
      // **软删除**：docs/11 §4.7「批量删除（软删除）/ 恢复」、docs/21「音频相关实体禁物理删除」。
      // 物理删会沿 `voice_segments` 的 CASCADE 销毁录音元数据。
      const n = await deps.ctx().canvasRepo.softDeleteLines([req.lineId])
      return { ok: n > 0 }
    }),

    h('canvas:insertLines', async (req) => {
      const ctx = deps.ctx()
      const chapter = await requireChapter(ctx, req.chapterId)
      // 文本可以含多行：按换行拆成多行插入（契约的返回值就是数组）
      const texts = req.text
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      if (texts.length === 0) {
        throw new AppError('INVALID_PAYLOAD', { details: { op: 'canvas:insertLines', reason: 'empty-text' } })
      }

      const ts = Date.now()
      const lines: CanvasLine[] = texts.map((text, i) => ({
        id: `manual-${req.chapterId}-${ts}-${i}`,
        chapterId: req.chapterId,
        bookId: chapter.bookId,
        seq: req.afterSeq + 1 + i,
        speakerType: req.characterId ? 'character' : 'narration',
        characterId: req.characterId ?? null,
        kind: req.characterId ? 'dialogue' : 'narration',
        text,
        sourceText: null,
        charStart: 0,
        charEnd: 0,
        emotion: null,
        emotionIntensity: null,
        speed: null,
        gainDb: null,
        pauseAfterMs: deps.canvasSettings().defaultPauseAfterMs,
        pauseInline: null,
        pronunciation: null,
        note: null,
        state: 'draft',
        confidence: null,
        candidates: null,
        // 人工插入 = 人工确认过，不该再被自动判定覆盖
        decidedBy: 'human',
        needsReview: false,
        flags: [],
        isTitle: false,
        rev: 1,
        createdAt: ts,
        updatedAt: ts,
      }))

      // 先让「插入点之后的那些行」整体后移，腾出 `texts.length` 个位置。
      // ⚠️ 必须带 `seqGreaterThan`：整章一起挪会把插入点**之前**的行也推到新行之后，
      // 两边撞在同一个 seq 上（该列没有唯一约束，不报错，只是朗读顺序静默错乱）。
      // 没有匹配行时它是空操作，所以不需要先读一遍判断「有没有尾巴」。
      await ctx.canvasRepo.shiftSeq(req.chapterId, texts.length, { seqGreaterThan: req.afterSeq })
      await ctx.canvasRepo.insertLines(lines)
      // 回读一次而不是直接返回构造出来的对象：库可能对字段做了归一化
      // （如 pause_after_ms 等），返回落库后的真值与内存实现保持一致。
      const after = await ctx.canvasRepo.listLines(req.chapterId)
      const ids = new Set(lines.map((n) => n.id))
      return after.filter((l) => ids.has(l.id))
    }),

    // ── 质检与快照 ─────────────────────────────────────────────────────────
    h('canvas:qualityCheck', async (req): Promise<QualityIssue[]> => {
      return deps.ctx().feature.service.qualityCheck({ chapterId: req.chapterId, opts: qualityOpts() })
    }),

    h('canvas:snapshotCreate', async (req) => {
      const ctx = deps.ctx()
      await requireChapter(ctx, req.chapterId)
      const reason = req.reason && SNAPSHOT_REASONS.has(req.reason) ? req.reason : 'manual'
      const snap = await ctx.canvasRepo.createSnapshot({
        chapterId: req.chapterId,
        ...(req.label !== undefined ? { label: req.label } : {}),
        reason: reason as 'manual' | 'pre_generate' | 'pre_restore',
      })
      return { snapshotId: snap.id }
    }),

    // ── 导出文本 ───────────────────────────────────────────────────────────
    h('canvas:exportText', async (req) => {
      const ctx = deps.ctx()
      const chapter = await requireChapter(ctx, req.chapterId)
      const lines = await ctx.canvasRepo.listLines(req.chapterId)

      const body =
        req.format === 'json'
          ? JSON.stringify(lines, null, 2)
          : req.format === 'csv'
            ? // CSV：带表头、字段用双引号包裹并转义内部引号（Excel 兼容）
              ['seq,speaker,kind,text,emotion,pauseAfterMs']
                .concat(
                  lines.map((l) =>
                    [l.seq, l.characterId ?? '旁白', l.kind, l.text, l.emotion ?? '', l.pauseAfterMs]
                      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                      .join(','),
                  ),
                )
                .join('\r\n')
            : // txt：只输出「要录的文本」，这是配音员真正需要的那一份
              lines.map((l) => l.text).join('\n')

      const path =
        req.outPath ??
        join(deps.exportDir(), `${sanitizeFileName(chapter.title)}.画本.${req.format === 'json' ? 'json' : req.format}`)
      // **必须先确保目录存在**：导出目录来自设置，用户可能填了一个还不存在的路径
      // （默认的 `exports` 目录也可能从未被创建过）。不建目录的话 `writeFile` 抛
      // ENOENT，被错误体系翻成「文件不存在」—— 用户对着一个『保存文件』的操作
      // 看到「文件不存在」，完全无法行动（而不是看到「导出目录不可写」）。
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body, 'utf8')
      deps.log.info('canvas.exportedText', {
        event: 'canvas.exportedText',
        chapterId: req.chapterId,
        format: req.format,
        lines: lines.length,
        path,
      })
      return { path }
    }),

    // ── 走任务队列的两个 ───────────────────────────────────────────────────
    h('canvas:generate', async (req) => {
      const ctx = deps.ctx()
      // 先确认章节存在：否则用户拿到的是一个「排上队但注定失败」的任务
      // （`canvas.tasks` 里还有一次同样的校验 —— 任务可能过一会儿才跑，章节可能已被删）
      await requireChapter(ctx, req.chapterId)
      // 已有人工修改时**先提示**（docs/11 §8）：生成会替换整章行，人工判定会被覆盖。
      // 契约只返回 `{ taskId }`（没有「确认」这一步），所以这里只能记录告警 ——
      // 真正的确认在渲染侧（点击前提示），不是在这里偷偷吞掉。
      const humanLines = await ctx.canvasRepo.countHumanDecided(req.chapterId)
      if (humanLines > 0) {
        deps.log.warn('canvas.generate.humanLines', {
          event: 'canvas.generate.humanLines',
          chapterId: req.chapterId,
          humanLines,
        })
      }
      return deps.tasks.enqueueGenerate(req.chapterId, req.options)
    }),

    h('canvas:recomputeAttribution', async (req) => {
      if (req.scope === 'selection' && (!req.lineIds || req.lineIds.length === 0)) {
        // 契约允许 lineIds 可选，但「只重算选中的行」缺了选中集就是无意义的范围
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'canvas:recomputeAttribution', reason: 'selection-without-lineIds' },
        })
      }
      return deps.tasks.enqueueRecompute({
        chapterId: req.chapterId,
        scope: req.scope,
        ...(req.lineIds ? { lineIds: req.lineIds } : {}),
        options: synthOptions(),
      })
    }),
  ]
}

/**
 * 本域实现的通道名（与上面的数组**一一对应**；供自检与覆盖度统计）。
 *
 * 12 个通道全部实现：报告落库位置原本是缺的，现由 `003_canvas_generate_reports.sql`
 * 补上 `canvas_generate_reports` 表（一章一行），因此 `canvas:getGenerateReport`
 * 不再是占位。
 */
export const CANVAS_CHANNELS: readonly string[] = [
  'canvas:getChapter',
  'canvas:getLine',
  'canvas:getGenerateReport',
  'canvas:updateLine',
  'canvas:batchUpdate',
  'canvas:deleteLine',
  'canvas:insertLines',
  'canvas:qualityCheck',
  'canvas:snapshotCreate',
  'canvas:exportText',
  'canvas:generate',
  'canvas:recomputeAttribution',
]
