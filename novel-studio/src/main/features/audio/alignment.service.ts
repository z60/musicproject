/**
 * Novel Studio · 对轨服务（`alignment:*` 19 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/13 §3.1 自动匹配（片段 ↔ 画本行，DP）/ §3.2 手工绑定与解绑
 *   · docs/13 §4.1 方案（arrangement）的增删复制与「每章一个默认」
 *   · docs/13 §4.2 自动排布（按轨道、留白优先级、锁定保护）
 *   · docs/13 §4.3 重叠消解的 4 种策略；§4.7 重置（单轨 / 全部）
 *   · docs/13 §5   校验（缺录 / 孤儿 / 重叠 / 过长静音 / 静音片段 / 文件丢失…）
 *   · docs/13 §7   预览渲染（任务在 `render.tasks.ts`）
 *
 * ### 这一层只做「读库 → 调纯函数 → 写库」
 *   所有几何计算（排布、移动、消解、校验）都在 `src/shared/arrange/**` 里，
 *   它们已有测试且被渲染侧（时间线拖拽预览）共用。本层**绝不**自己算位置 ——
 *   两套算法一定会漂移，表现为「拖的时候在哪、松手后在哪」不一致。
 *
 * ### 三条落库纪律
 *   1. **整体重排才 +1 version**：version 是导出 `paramsHash` 的成分，
 *      每次拖动都 +1 会让导出缓存永久失效（docs/13 §4.1）。
 *   2. **items 全量替换是原子的**（仓储用事务），中途失败不留空时间线。
 *   3. **绑定/解绑后清掉过期的时间线条目**：否则渲染时会按旧绑定播放，
 *      表现为「改了绑定但导出没变」。
 *
 * ### 关于 `alignment:forcedAlign`（如实记录）
 *   它需要「强制对齐」引擎（ASR 时间戳或 HMM 对齐），本仓库**没有**任何实现，
 *   也没有可注入的 provider。因此本通道不返回 `taskId`，而是抛
 *   `AI_FORCED_ALIGN_UNAVAILABLE`（消息表里已有的键），说明「该能力不可用」。
 *   这比返回一个永远失败的任务 id 诚实：用户点下去就知道是能力缺失，而不是等 30 秒。
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'

import { AppError } from '../../../shared/errors.ts'
import { ALIGN_ISSUE_LABELS, ARRANGE_DEFAULTS } from '../../../shared/constants.ts'
import { NARRATION_TRACK_ID } from '../../../shared/types.ts'
import type {
  AlignIssueKind,
  Arrangement,
  ArrangementItem,
  ArrangementItemPatch,
  ArrangementValidation,
  ArrangeStrategy,
  Id,
  VadOptions,
} from '../../../shared/types.ts'
import { autoArrange, computeChapterDuration, type ArrangeLineInput, type ExistingItemState } from '../../../shared/arrange/layout.ts'
import { applyItemPatch } from '../../../shared/arrange/manual.ts'
import { detectOverlaps, resolveOverlap } from '../../../shared/arrange/overlap.ts'
import { validateArrangement, type ValidateLineInput, type ValidateSegmentInput } from '../../../shared/arrange/validate.ts'
import { matchSlicesToLines } from '../../../shared/audio/match.ts'
import { projectAudioRoot } from './audio-root.ts'
import type { ArrangementRepo } from './repositories/arrangement.repo.ts'
import type { Logger } from '../../infra/log/index.ts'
import type { DbLike } from '../../infra/db/types.ts'

/** 校验时要用的片段信息（由 query 端口提供） */
export interface AlignmentSegmentRow {
  segmentId: Id
  lineId: Id
  chapterId: Id
  filePath: string
  processedPath: string | null
  durationMs: number
  rmsDb: number | null
  peakDb: number | null
  flags: string[]
}

/** 画本行（含轨道与留白） */
export interface AlignmentLineRow {
  lineId: Id
  seq: number
  trackId: string
  charCount: number
  pauseAfterMs: number | null
  characterPauseMs: number | null
  segmentId: Id | null
}

export interface AlignmentServiceDeps {
  getDb: () => DbLike | null
  /** `{userData}/projects` */
  projectRoot: () => string
  repo: () => ArrangementRepo
  /** 画本行查询（含角色轨道） */
  lines: {
    listByChapter(chapterId: Id): Promise<AlignmentLineRow[]>
  }
  /** 片段查询与绑定 */
  segments: {
    listByChapter(chapterId: Id): Promise<AlignmentSegmentRow[]>
    get(segmentId: Id): Promise<AlignmentSegmentRow | null>
    /** 把片段绑到某行（`voice_segments.line_id`）；目标行已占用时返回 'taken' */
    rebind(segmentId: Id, lineId: Id): Promise<'ok' | 'taken' | 'missing'>
    /** 解绑 = 删除该行的片段行（schema 里没有「未绑定的片段」这种状态） */
    unbind(lineId: Id): Promise<boolean>
  }
  /** 渲染任务（`audio.render`） */
  render: {
    enqueuePreview(payload: { arrangementId: Id; mixProjectId: Id | null; startMs: number; durationMs: number }): Promise<{ taskId: Id }>
  }
  /** 录音设置（匹配用的语速） */
  audioSettings?: () => { vad?: Partial<VadOptions> } | undefined
  newId?: (prefix: string) => Id
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface AlignmentService {
  listArrangements(chapterId: Id): Promise<Arrangement[]>
  create(chapterId: Id, name: string, strategy: ArrangeStrategy): Promise<Arrangement>
  duplicate(arrangementId: Id, name: string): Promise<Arrangement>
  remove(arrangementId: Id): Promise<{ ok: boolean }>
  setDefault(arrangementId: Id): Promise<{ ok: boolean }>
  get(arrangementId: Id): Promise<{ arrangement: Arrangement; items: ArrangementItem[] }>
  autoArrange(
    arrangementId: Id,
    strategy: ArrangeStrategy,
    preserveLocked: boolean,
    defaultPauseMs: number,
  ): Promise<{ items: ArrangementItem[]; totalDurationMs: number }>
  updateItem(itemId: Id, patch: ArrangementItemPatch): Promise<ArrangementItem>
  batchUpdateItems(updates: ReadonlyArray<{ itemId: Id; patch: ArrangementItemPatch }>): Promise<{ updated: number }>
  validate(arrangementId: Id): Promise<ArrangementValidation>
  resolveOverlap(
    arrangementId: Id,
    itemIdA: Id,
    itemIdB: Id,
    strategy: ArrangeStrategy,
  ): Promise<{ items: ArrangementItem[] }>
  resetTrack(arrangementId: Id, trackId: string): Promise<{ items: ArrangementItem[] }>
  resetAll(arrangementId: Id): Promise<{ items: ArrangementItem[] }>
  autoMatchSegments(
    chapterId: Id,
    useAsr: boolean,
  ): Promise<{ matches: Array<{ segmentId: Id; lineId: Id; confidence: number }>; unmatchedSegments: Id[]; unrecordedLines: Id[] }>
  bindSegment(lineId: Id, segmentId: Id, srcInMs?: number, srcOutMs?: number): Promise<{ ok: boolean }>
  unbindSegment(lineId: Id): Promise<{ ok: boolean }>
  issueKindLabels(): Promise<Record<AlignIssueKind, string>>
  previewRender(
    arrangementId: Id,
    mixProjectId: Id | null,
    startMs: number,
    durationMs: number,
  ): Promise<{ taskId: Id }>
  /**
   * 强制对齐（`alignment:forcedAlign`）。
   *
   * **本仓库没有强制对齐引擎**（既无 ASR 时间戳，也无 HMM 对齐实现），因此它不返回
   * `taskId`，而是抛 `AI_FORCED_ALIGN_UNAVAILABLE`。契约里 `res` 是 `{ taskId }`，
   * 返回一个「永远失败的任务」比直接说明能力缺失更糟：用户会等半天才看到红点。
   */
  forcedAlign(lineId?: Id, segmentId?: Id): Promise<never>
}

export function createAlignmentService(deps: AlignmentServiceDeps): AlignmentService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`)

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'alignment' } })
    return db
  }

  async function requireArrangement(arrangementId: Id): Promise<Arrangement> {
    const found = await deps.repo().get(arrangementId)
    if (!found) throw new AppError('NOT_FOUND', { details: { entity: 'arrangement', id: arrangementId } })
    return found
  }

  /** 章所属项目（音频路径的基准，docs/91 §5.2.19） */
  function projectIdOfChapter(chapterId: Id): Id {
    const row = requireDb()
      .prepare(
        `SELECT b.project_id AS project_id
           FROM chapters c JOIN books b ON b.id = c.book_id
          WHERE c.id = ?`,
      )
      .get(chapterId) as { project_id: string } | undefined
    if (!row?.project_id) throw new AppError('NOT_FOUND', { details: { entity: 'chapter', chapterId } })
    return row.project_id
  }

  /** 把「画本行 + 既有 item」组装成自动排布的输入（轨道由 speaker_type/character_id 决定） */
  async function buildArrangeInput(
    arrangementId: Id,
    chapterId: Id,
    preserveLocked: boolean,
  ): Promise<ArrangeLineInput[]> {
    const lines = await deps.lines.listByChapter(chapterId)
    const existing = await deps.repo().listItems(arrangementId)
    const byLine = new Map<Id, ArrangementItem>()
    for (const it of existing) byLine.set(it.lineId, it)
    const segments = await deps.segments.listByChapter(chapterId)
    const segById = new Map(segments.map((s) => [s.segmentId, s] as const))

    return lines.map((line) => {
      const item = byLine.get(line.lineId) ?? null
      const seg = line.segmentId ? (segById.get(line.segmentId) ?? null) : null
      /**
       * 既有 item 的人工状态：**只带 locked 与非默认值**。
       *
       * `preserveLocked` 决定「锁定的位置要不要保留」（docs/13 §4.7）：
       * 传 false（重置全部）时连锁定一起丢掉 —— 那正是「重置」的语义。
       */
      const state: ExistingItemState | null = item
        ? {
            id: item.id,
            timelineStartMs: item.timelineStartMs,
            locked: preserveLocked && item.locked,
            fadeInMs: item.fadeInMs,
            fadeOutMs: item.fadeOutMs,
            orderInTrack: item.orderInTrack,
          }
        : null
      return {
        lineId: line.lineId,
        trackId: line.trackId,
        seq: line.seq,
        segmentId: line.segmentId,
        ...(seg ? { segmentDurationMs: seg.durationMs } : {}),
        // 裁剪点以既有 item 为准（用户可能手工拖过边缘），没有就用整段
        srcInMs: item?.srcInMs ?? 0,
        srcOutMs: item?.srcOutMs ?? seg?.durationMs ?? 0,
        pauseAfterMs: line.pauseAfterMs,
        characterPauseMs: line.characterPauseMs,
        existing: state,
      }
    })
  }

  /** 整体重排：算 → 原子替换 → 更新方案摘要（version +1） */
  async function arrangeAll(
    arrangementId: Id,
    strategy: ArrangeStrategy,
    preserveLocked: boolean,
    defaultPauseMs: number,
  ): Promise<{ items: ArrangementItem[]; totalDurationMs: number }> {
    const arrangement = await requireArrangement(arrangementId)
    const repo = deps.repo()
    const input = await buildArrangeInput(arrangementId, arrangement.chapterId, preserveLocked)
    const result = autoArrange({
      arrangementId,
      lines: input,
      defaultPauseMs: defaultPauseMs > 0 ? defaultPauseMs : ARRANGE_DEFAULTS.defaultPauseMs,
      defaultFadeMs: ARRANGE_DEFAULTS.defaultFadeMs,
      idFactory: () => newId('item'),
    })
    const items = await repo.replaceItems(arrangementId, result.items)
    await repo.updateSummary(arrangementId, {
      strategy,
      totalDurationMs: result.totalDurationMs,
      bumpVersion: true,
    })
    if (result.gaps.length > 0) {
      // 缺录不是错误，但必须让用户知道（导出预检会拦）
      deps.log?.warn?.('alignment.autoArrangeGaps', {
        event: 'alignment.autoArrangeGaps',
        arrangementId,
        gaps: result.gaps.length,
        firstLines: result.gaps.slice(0, 5).map((g) => g.lineId),
      })
    }
    deps.log?.info?.('alignment.autoArranged', {
      event: 'alignment.autoArranged',
      arrangementId,
      strategy,
      items: items.length,
      gaps: result.gaps.length,
      totalDurationMs: result.totalDurationMs,
      tracks: result.trackOrder,
    })
    return { items, totalDurationMs: result.totalDurationMs }
  }

  return {
    async listArrangements(chapterId) {
      return deps.repo().listByChapter(chapterId)
    },

    async create(chapterId, name, strategy) {
      const trimmed = name.trim()
      if (!trimmed) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'alignment:create', reason: 'empty-name', hint: '方案名不能为空' },
        })
      }
      // 该章的第一个方案自动成为默认（否则用户建完方案却发现「导出用的是哪份」无从判断）
      const existing = await deps.repo().listByChapter(chapterId)
      const created = await deps.repo().create({
        chapterId,
        name: trimmed,
        strategy,
        isDefault: existing.length === 0,
      })
      deps.log?.info?.('alignment.arrangementCreated', {
        event: 'alignment.arrangementCreated',
        arrangementId: created.id,
        chapterId,
        isDefault: created.isDefault,
      })
      return created
    },

    async duplicate(arrangementId, name) {
      const src = await requireArrangement(arrangementId)
      const trimmed = name.trim() || `${src.name} 副本`
      const copy = await deps.repo().duplicate(arrangementId, trimmed)
      deps.log?.info?.('alignment.arrangementDuplicated', {
        event: 'alignment.arrangementDuplicated',
        from: arrangementId,
        to: copy.id,
      })
      return copy
    },

    async remove(arrangementId) {
      const target = await requireArrangement(arrangementId)
      const ok = await deps.repo().remove(arrangementId)
      // 删掉默认方案后，该章会「没有默认」——导出会找不到方案。
      // 这里自动指定最早创建的那份为默认，避免留下这种状态。
      if (ok && target.isDefault) {
        const rest = await deps.repo().listByChapter(target.chapterId)
        if (rest.length > 0) {
          await deps.repo().setDefault(rest[0]!.id)
          deps.log?.info?.('alignment.defaultReassigned', {
            event: 'alignment.defaultReassigned',
            chapterId: target.chapterId,
            arrangementId: rest[0]!.id,
          })
        }
      }
      deps.log?.info?.('alignment.arrangementRemoved', { event: 'alignment.arrangementRemoved', arrangementId, ok })
      return { ok }
    },

    async setDefault(arrangementId) {
      const ok = await deps.repo().setDefault(arrangementId)
      if (!ok) throw new AppError('NOT_FOUND', { details: { entity: 'arrangement', id: arrangementId } })
      return { ok }
    },

    async get(arrangementId) {
      const arrangement = await requireArrangement(arrangementId)
      const items = await deps.repo().listItems(arrangementId)
      return { arrangement, items }
    },

    async autoArrange(arrangementId, strategy, preserveLocked, defaultPauseMs) {
      return arrangeAll(arrangementId, strategy, preserveLocked, defaultPauseMs)
    },

    async updateItem(itemId, patch) {
      const repo = deps.repo()
      const cur = await repo.getItem(itemId)
      if (!cur) throw new AppError('NOT_FOUND', { details: { entity: 'arrangement_item', itemId } })
      const next = applyItemPatch(cur, patch, { minDurationMs: 1 })
      const updated = await repo.updateItem(itemId, next)
      return updated
    },

    async batchUpdateItems(updates) {
      if (updates.length === 0) return { updated: 0 }
      const repo = deps.repo()
      const normalized: Array<{ itemId: Id; patch: Partial<Omit<ArrangementItem, 'id' | 'arrangementId'>> }> = []
      const missing: Id[] = []
      for (const { itemId, patch } of updates) {
        const cur = await repo.getItem(itemId)
        if (!cur) {
          missing.push(itemId)
          continue
        }
        const next = applyItemPatch(cur, patch, { minDurationMs: 1 })
        normalized.push({
          itemId,
          patch: {
            timelineStartMs: next.timelineStartMs,
            srcInMs: next.srcInMs,
            srcOutMs: next.srcOutMs,
            fadeInMs: next.fadeInMs,
            fadeOutMs: next.fadeOutMs,
            locked: next.locked,
            orderInTrack: patch.orderInTrack ?? next.orderInTrack,
          },
        })
      }
      if (missing.length > 0) {
        // 有失效 id 就整体拒绝：批量改动是「一次拖拽的落库」，
        // 部分成功会让内存态与库里的状态永久不一致
        throw new AppError('NOT_FOUND', {
          details: { entity: 'arrangement_item', itemIds: missing.slice(0, 10), missing: missing.length },
        })
      }
      const updated = await repo.updateItems(normalized)
      return { updated }
    },

    async validate(arrangementId) {
      const arrangement = await requireArrangement(arrangementId)
      const repo = deps.repo()
      const items = await repo.listItems(arrangementId)
      const lines = await deps.lines.listByChapter(arrangement.chapterId)
      const segments = await deps.segments.listByChapter(arrangement.chapterId)
      const projectId = projectIdOfChapter(arrangement.chapterId)
      const root = projectAudioRoot(deps.projectRoot(), projectId)

      const validateLines: ValidateLineInput[] = lines.map((l) => ({
        lineId: l.lineId,
        seq: l.seq,
        trackId: l.trackId,
        chapterId: arrangement.chapterId,
        segmentId: l.segmentId,
      }))
      const validateSegments: ValidateSegmentInput[] = segments.map((s) => {
        // 文件是否存在要真的查盘：库里指向一个不存在的文件是**导出时才炸**的那种问题，
        // 而对轨界面正是最该提前发现它的地方（docs/13 §5 的 file_missing）
        const rel = s.processedPath ?? s.filePath
        let fileExists = false
        try {
          fileExists = statSync(join(root, rel)).isFile()
        } catch {
          fileExists = false
        }
        return {
          segmentId: s.segmentId,
          lineId: s.lineId,
          chapterId: s.chapterId,
          durationMs: s.durationMs,
          rmsDb: s.rmsDb,
          peakDb: s.peakDb,
          flags: s.flags,
          fileExists,
        }
      })
      const validation = validateArrangement({
        items,
        lines: validateLines,
        segments: validateSegments,
        opts: {
          maxCrossTrackOverlapMs: ARRANGE_DEFAULTS.maxCrossTrackOverlapMs,
          maxGapMs: ARRANGE_DEFAULTS.maxGapMs,
          minSegmentMs: ARRANGE_DEFAULTS.minSegmentMs,
          maxSegmentMs: ARRANGE_DEFAULTS.maxSegmentMs,
          silentRmsDb: ARRANGE_DEFAULTS.silentRmsDb,
        },
      })
      deps.log?.info?.('alignment.validated', {
        event: 'alignment.validated',
        arrangementId,
        items: items.length,
        missingLines: validation.missingLines.length,
        unarrangedLines: validation.unarrangedLines.length,
        sameTrackOverlaps: validation.sameTrackOverlaps.length,
        issues: validation.issues.length,
        totalDurationMs: validation.totalDurationMs,
      })
      return validation
    },

    async resolveOverlap(arrangementId, itemIdA, itemIdB, strategy) {
      const repo = deps.repo()
      await requireArrangement(arrangementId)
      const items = await repo.listItems(arrangementId)
      const a = items.find((i) => i.id === itemIdA)
      const b = items.find((i) => i.id === itemIdB)
      if (!a || !b) {
        throw new AppError('NOT_FOUND', {
          details: {
            entity: 'arrangement_item',
            itemIdA,
            itemIdB,
            hint: '两条都要属于这个方案（跨方案的 item 无法一起消解）',
          },
        })
      }
      const resolution = resolveOverlap(items, a, b, strategy, {
        minGapMs: strategy === 'tighten' ? 20 : ARRANGE_DEFAULTS.minGapMs,
      })
      const changed = resolution.changes.filter((c) => c.kind !== 'none')
      if (changed.length > 0) {
        await repo.updateItems(
          resolution.items
            .filter((it) => changed.some((c) => c.itemId === it.id))
            .map((it) => ({
              itemId: it.id,
              patch: { timelineStartMs: it.timelineStartMs, srcOutMs: it.srcOutMs },
            })),
        )
      }
      // 消解后同步方案总时长（否则导出预检会用旧时长算出错误的分章边界）
      const next = await repo.listItems(arrangementId)
      await repo.updateSummary(arrangementId, { totalDurationMs: computeChapterDuration(next) })
      deps.log?.info?.('alignment.overlapResolved', {
        event: 'alignment.overlapResolved',
        arrangementId,
        strategy,
        a: itemIdA,
        b: itemIdB,
        changes: changed.length,
      })
      return { items: next }
    },

    async resetTrack(arrangementId, trackId) {
      const arrangement = await requireArrangement(arrangementId)
      const repo = deps.repo()
      const all = await repo.listItems(arrangementId)
      const trackItems = all.filter((it) => it.trackId === trackId)
      if (trackItems.length === 0) {
        deps.log?.warn?.('alignment.resetEmptyTrack', {
          event: 'alignment.resetEmptyTrack',
          arrangementId,
          trackId,
          note: '该轨没有条目：返回全部条目，不做改动',
        })
        return { items: all }
      }
      // 单轨重排：只**替换**这一轨的条目，但排布必须按**全章全局**算。
      // `timelineStartMs` 是绝对时间线位置（渲染用 adelay + amix），单轨若按自己从 0 排
      // 就会和旁白/其它角色叠在一起（真机：角色音跑到最前面）。
      // 因此对全章跑一次自动排布，只把目标轨的结果写回；其它轨的条目原地不动。
      const lines = await deps.lines.listByChapter(arrangement.chapterId)
      const byLine = new Map(all.map((it) => [it.lineId, it] as const))
      const segments = await deps.segments.listByChapter(arrangement.chapterId)
      const segById = new Map(segments.map((s) => [s.segmentId, s] as const))
      const result = autoArrange({
        arrangementId,
        lines: lines.map((l) => {
          const item = byLine.get(l.lineId) ?? null
          const seg = l.segmentId ? (segById.get(l.segmentId) ?? null) : null
          return {
            lineId: l.lineId,
            trackId: l.trackId,
            seq: l.seq,
            segmentId: l.segmentId,
            ...(seg ? { segmentDurationMs: seg.durationMs } : {}),
            srcOutMs: seg?.durationMs ?? 0,
            pauseAfterMs: l.pauseAfterMs,
            characterPauseMs: l.characterPauseMs,
            // 目标轨：重置就该丢掉人工位置（locked: false → 由全局 cursor 重算）。
            // 其它轨：把它们的**当前位置**当作固定锚点（locked: true），
            // 这样「重置这一轨」得到的是「相对当前时间线，这一轨本该在哪」。
            existing: item
              ? l.trackId === trackId
                ? { id: item.id, timelineStartMs: item.timelineStartMs, locked: false }
                : { id: item.id, timelineStartMs: item.timelineStartMs, locked: true }
              : null,
          } satisfies ArrangeLineInput
        }),
        defaultPauseMs: ARRANGE_DEFAULTS.defaultPauseMs,
        defaultFadeMs: ARRANGE_DEFAULTS.defaultFadeMs,
        idFactory: () => newId('item'),
      })
      // 只写回目标轨的条目（replaceItems 的 trackId 语义 = 删这一轨再写这一轨）
      const items = await repo.replaceItems(
        arrangementId,
        result.items.filter((it) => it.trackId === trackId),
        { trackId },
      )
      await repo.updateSummary(arrangementId, { totalDurationMs: computeChapterDuration(items) })
      deps.log?.info?.('alignment.trackReset', {
        event: 'alignment.trackReset',
        arrangementId,
        trackId,
        items: items.filter((it) => it.trackId === trackId).length,
      })
      return { items }
    },

    async resetAll(arrangementId) {
      const arrangement = await requireArrangement(arrangementId)
      // 「重置全部」= 丢掉所有人工位置（含锁定），按当前策略整体重排。
      // 保留 strategy：重置位置不该悄悄改用户的节奏策略。
      const result = await arrangeAll(arrangementId, arrangement.strategy, false, ARRANGE_DEFAULTS.defaultPauseMs)
      deps.log?.info?.('alignment.allReset', {
        event: 'alignment.allReset',
        arrangementId,
        items: result.items.length,
      })
      return { items: result.items }
    },

    async autoMatchSegments(chapterId, useAsr) {
      const lines = await deps.lines.listByChapter(chapterId)
      if (lines.length === 0) {
        throw new AppError('NOT_FOUND', {
          details: { entity: 'canvas_line', chapterId, hint: '该章还没有画本行，先「生成画本」' },
        })
      }
      const segments = await deps.segments.listByChapter(chapterId)
      const lineById = new Map(lines.map((l) => [l.lineId, l] as const))

      // 「待匹配」= 片段当前绑定的行**不在本章**了（章节被合并/拆分/删行后最常见）。
      // 已经绑在本章行上的片段不需要匹配（那是人工绑定或录完即绑的结果）。
      const orphans = segments.filter((s) => !lineById.has(s.lineId))
      const takenLineIds = new Set(segments.filter((s) => lineById.has(s.lineId)).map((s) => s.lineId))
      const unrecorded = lines.filter((l) => !takenLineIds.has(l.lineId))

      if (useAsr) {
        deps.log?.warn?.('alignment.asrUnavailable', {
          event: 'alignment.asrUnavailable',
          chapterId,
          note: 'useAsr=true，但本仓库没有 ASR 实现：返回的是时长对齐结果（docs/91 §5.2.21）',
        })
      }

      const cps = deps.audioSettings?.()?.vad?.charsPerSecond ?? 5
      const result = matchSlicesToLines(
        orphans.map((s, index) => ({
          sliceIndex: index,
          startMs: 0,
          endMs: Math.max(1, s.durationMs),
        })),
        unrecorded.map((l) => ({ lineId: l.lineId, charCount: l.charCount })),
        { charsPerSecond: cps },
      )
      const matches = result.matches.map((m) => ({
        segmentId: orphans[m.sliceIndex]!.segmentId,
        lineId: m.lineId,
        confidence: m.confidence,
      }))
      const matchedSegmentIds = new Set(matches.map((m) => m.segmentId))
      const matchedLineIds = new Set(matches.map((m) => m.lineId))
      deps.log?.info?.('alignment.segmentsMatched', {
        event: 'alignment.segmentsMatched',
        chapterId,
        orphans: orphans.length,
        unrecordedLines: unrecorded.length,
        matched: matches.length,
        scale: result.scale,
        useAsr,
        asrUsed: false,
      })
      return {
        matches,
        unmatchedSegments: orphans.filter((s) => !matchedSegmentIds.has(s.segmentId)).map((s) => s.segmentId),
        unrecordedLines: unrecorded.filter((l) => !matchedLineIds.has(l.lineId)).map((l) => l.lineId),
      }
    },

    async bindSegment(lineId, segmentId, srcInMs, srcOutMs) {
      const repo = deps.repo()
      const db = requireDb()
      const line = db
        .prepare(`SELECT chapter_id FROM canvas_lines WHERE id = ? AND deleted_at IS NULL`)
        .get(lineId) as { chapter_id: string } | undefined
      if (!line) throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId } })
      const segment = await deps.segments.get(segmentId)
      if (!segment) throw new AppError('NOT_FOUND', { details: { entity: 'voice_segment', segmentId } })
      if (segment.chapterId !== line.chapter_id) {
        // 跨章绑定会让导出的章节边界与音频内容错位，是最难排查的一类问题
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'alignment:bindSegment',
            reason: 'cross-chapter',
            lineId,
            segmentId,
            lineChapterId: line.chapter_id,
            segmentChapterId: segment.chapterId,
          },
        })
      }
      const outcome = await deps.segments.rebind(segmentId, lineId)
      if (outcome === 'taken') {
        throw new AppError('CONFLICT', {
          details: {
            op: 'alignment:bindSegment',
            reason: 'line-already-has-segment',
            lineId,
            segmentId,
            hint: '这一行已经有片段了（voice_segments 对 line_id 唯一）：先解绑再绑定',
          },
        })
      }
      if (outcome !== 'ok') {
        throw new AppError('NOT_FOUND', { details: { entity: 'voice_segment', segmentId } })
      }
      // 绑定变化后，旧的时间线条目必须清掉（否则渲染仍按旧绑定播放）
      const removed = await repo.removeByLines([lineId])
      deps.log?.info?.('alignment.segmentBound', {
        event: 'alignment.segmentBound',
        lineId,
        segmentId,
        removedItems: removed,
        srcInMs: srcInMs ?? null,
        srcOutMs: srcOutMs ?? null,
      })
      return { ok: true }
    },

    async unbindSegment(lineId) {
      const repo = deps.repo()
      const removedItems = await repo.removeByLines([lineId])
      const ok = await deps.segments.unbind(lineId)
      // 库里没有「未绑定的片段」状态（`line_id` NOT NULL UNIQUE），所以解绑就是删行。
      // 音频文件保留在磁盘上（非破坏），但这**不可撤销** —— 必须记清楚。
      deps.log?.warn?.('alignment.segmentUnbound', {
        event: 'alignment.segmentUnbound',
        lineId,
        rowRemoved: ok,
        removedItems,
        note: '解绑 = 删除 voice_segments 行（无「未绑定」状态）；文件保留但记录不可恢复',
      })
      return { ok }
    },

    async issueKindLabels() {
      // 文案的唯一来源在主进程常量里（见 shared/constants.ts 的 ALIGN_ISSUE_LABELS）
      return { ...ALIGN_ISSUE_LABELS }
    },

    async previewRender(arrangementId, mixProjectId, startMs, durationMs) {
      const arrangement = await requireArrangement(arrangementId)
      if (mixProjectId) {
        // 混音方案还没实现（`mix:*` 是占位）：不假装支持，明确告知预览只有人声
        deps.log?.warn?.('alignment.previewIgnoresMixProject', {
          event: 'alignment.previewIgnoresMixProject',
          arrangementId,
          mixProjectId,
          note: '预览渲染当前只做「人声总线」：BGM/闪避/母带属于混音域（尚未实现）',
        })
      }
      const items = await deps.repo().listItems(arrangementId)
      if (items.length === 0) {
        throw new AppError('MIX_ARRANGEMENT_EMPTY', {
          details: { op: 'alignment:previewRender', arrangementId },
        })
      }
      const { taskId } = await deps.render.enqueuePreview({
        arrangementId,
        mixProjectId,
        startMs: Math.max(0, Math.round(startMs)),
        durationMs: Math.max(1, Math.round(durationMs)),
      })
      deps.log?.info?.('alignment.previewRenderQueued', {
        event: 'alignment.previewRenderQueued',
        taskId,
        arrangementId,
        startMs,
        durationMs,
        strategy: arrangement.strategy,
      })
      return { taskId }
    },

    async forcedAlign(lineId, segmentId) {
      deps.log?.warn?.('alignment.forcedAlignUnavailable', {
        event: 'alignment.forcedAlignUnavailable',
        lineId: lineId ?? null,
        segmentId: segmentId ?? null,
        note: '本仓库没有强制对齐引擎（无 ASR 时间戳 / HMM 对齐）：明确抛能力缺失，不返回必然失败的任务',
      })
      throw new AppError('AI_FORCED_ALIGN_UNAVAILABLE', {
        details: {
          op: 'alignment:forcedAlign',
          lineId: lineId ?? null,
          segmentId: segmentId ?? null,
          reason: 'no-forced-alignment-engine',
          hint: '强制对齐需要 ASR 时间戳或 HMM 对齐引擎；当前可用的是「时长对齐」（alignment:autoMatchSegments）',
        },
      })
    },
  }
}

/**
 * 与 `shared/arrange/overlap.ts` 共用的完整重叠报告（供 UI 面板直接展示）。
 *
 * 单独导出而不是塞进服务接口：它是**只读的派生视图**，`alignment:get` 与
 * `alignment:validate` 都已经覆盖了契约要求的形状，这里只是给将来「重叠面板」
 * 一个不用重复实现的入口（同一份 `detectOverlaps`，不做第二套判定）。
 */
export function overlapReportOf(
  items: readonly ArrangementItem[],
  opts?: { maxCrossTrackOverlapMs?: number; maxGapMs?: number },
): ReturnType<typeof detectOverlaps> {
  return detectOverlaps([...items], {
    maxCrossTrackOverlapMs: opts?.maxCrossTrackOverlapMs ?? ARRANGE_DEFAULTS.maxCrossTrackOverlapMs,
    maxGapMs: opts?.maxGapMs ?? ARRANGE_DEFAULTS.maxGapMs,
  })
}
void NARRATION_TRACK_ID
