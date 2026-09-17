/**
 * Novel Studio · 说话人判定重算编排（主进程）
 * ============================================================================
 * 设计依据：
 *   · docs/06 §5.5 重算与增量：
 *       - 调阈值 → 只重跑「判定」，**不需要重新 embedding**（向量可复用是关键优化）
 *       - 人工改了说话人 → decided_by='human'，**永不自动覆盖**
 *       - 换 embedding 模型 → 向量空间不可比，**必须全项目重算**（并给出耗时预估）
 *   · docs/11 §7   canvas.recomputeAttribution（scope: low_confidence | all | selection）
 *   · docs/11 §3   decidedBy 缺了会导致「重算覆盖人工修改」——本域最恼人的 bug
 *   · docs/04 §2   任务进度（onProgress → TaskProgressEvent）
 *
 * 两条路径：
 *   1. 有 `chapterText` → 复用 `generateCanvas` 全量重跑（与生成口径完全一致）
 *   2. 没有 `chapterText` → 用已落库的 `line_embeddings` 复用向量只重跑判定
 *      （docs/06 §5.5 的「调阈值是秒级的」这条优化；阈值变更不必重新推理）
 */

import { AppError } from '../../../../shared/errors.ts'
import { CANVAS_DEFAULTS } from '../../../../shared/constants.ts'
import type { CanvasGenerateOptions, CanvasLinePatch, Id } from '../../../../shared/types.ts'
import {
  CONSECUTIVE_BONUS_DEFAULT,
  applyRulePostProcess,
  attributeByVector,
  buildContext,
  describeVectorReason,
  generateCanvas,
  type AttributionLine,
  type CanvasCharacterRef,
  type LineDecision,
} from '../../../../shared/canvas/index.ts'
import type { CanvasRepo } from './repositories/canvas.repo.ts'
import {
  defaultYieldToLoop,
  decideByStoredVector,
  toAttributionLines,
  type CanvasServiceDeps,
} from './canvas.service.ts'

// ============================================================================
// 类型
// ============================================================================

export type RecomputeScope = 'low_confidence' | 'all' | 'selection'

export interface RecomputeRequest {
  bookId: Id
  chapterId: Id
  scope: RecomputeScope
  /** scope='selection' 时必填 */
  lineIds?: Id[]
  /**
   * 重算用的选项。`embeddings.ts` 无网络环境下阈值/窗口由调用方给（默认取 CANVAS_DEFAULTS）。
   */
  options: CanvasGenerateOptions
  /**
   * 章节原文。给了 → 走完整流水线（场景划分、上下文、停顿都与生成一致）；
   * 不给 → 复用已存向量只重跑判定（更快，但场景过滤退化为全书角色）。
   */
  chapterText?: string | null
  chapterTitle?: string
  /** 覆盖 CANVAS_DEFAULTS.contextWindow 等 */
  limits?: { contextWindow?: number; attributionThreshold?: number; attributionMargin?: number }
  /** 显式允许覆盖人工确认过的行（默认 false：**永不覆盖**） */
  overwriteHuman?: boolean
  signal?: AbortSignal
  onProgress?: (progress: { stage: string; ratio: number; done: number; total: number }) => void
}

export interface RecomputeResult {
  chapterId: Id
  scope: RecomputeScope
  /** 实际改动的行数 */
  updated: number
  /** 因为 decidedBy='human' 而跳过的行数（必须回报给 UI，否则用户以为没生效） */
  skippedHuman: number
  /** 不在本次范围内而跳过的行数 */
  skippedOutOfScope: number
  /** 重新向量化的行数（走完整体；复用路径为 0） */
  embedded: number
  /** 重算后仍处于待确认的行数 */
  lowConfidence: number
  embeddingUsed: boolean
  llmUsed: boolean
  /** 是否检测到 embedding 模型变更（docs/06 §5.5） */
  modelSwitched: boolean
  patches: Array<{ lineId: Id; patch: CanvasLinePatch }>
  warnings: string[]
  elapsedMs: number
}

export interface AttributionService {
  recompute(req: RecomputeRequest): Promise<RecomputeResult>
}

// ============================================================================
// 实现
// ============================================================================

/**
 * 创建重算服务。
 *
 * 关键保证（这是我们最不想出的 bug，docs/11 §3）：
 *   **`decidedBy === 'human'` 的行在任何 scope 下都不会被自动改写**，除非显式 `overwriteHuman: true`。
 */
export function createAttributionService(
  deps: Pick<CanvasServiceDeps, 'canvasRepo' | 'characterRepo' | 'embedProvider' | 'llmReviewer' | 'now' | 'log'> & {
    yieldToLoop?: () => Promise<void>
    batchSize?: number
  },
): AttributionService {
  const now = deps.now ?? (() => Date.now())
  const yieldToLoop = deps.yieldToLoop ?? defaultYieldToLoop
  const batchSize = Math.max(1, deps.batchSize ?? 200)

  async function loadRefs(bookId: Id, modelId: string): Promise<CanvasCharacterRef[]> {
    const characters = await deps.characterRepo.listByBook(bookId, { includeArchived: false })
    const centroids = await deps.characterRepo.listCentroids(bookId, modelId)
    const byId = new Map(centroids.map((c) => [c.characterId, c]))
    return characters.map((c) => ({
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      description: c.description,
      centroid: byId.get(c.id) ? Float32Array.from(byId.get(c.id)!.centroid) : null,
    }))
  }

  async function selectTargets(
    req: RecomputeRequest,
    lines: Awaited<ReturnType<CanvasRepo['listLines']>>,
  ): Promise<{ targets: Set<Id>; skippedHuman: number; skippedOutOfScope: number }> {
    const targets = new Set<Id>()
    let skippedHuman = 0
    let skippedOutOfScope = 0

    if (req.scope === 'selection' && (!req.lineIds || req.lineIds.length === 0)) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { op: 'recompute', reason: 'scope=selection 时必须提供 lineIds' },
      })
    }
    const selection = new Set(req.lineIds ?? [])

    for (const line of lines) {
      const inScope =
        req.scope === 'all' ||
        (req.scope === 'low_confidence' && line.needsReview) ||
        (req.scope === 'selection' && selection.has(line.id))
      if (!inScope) {
        skippedOutOfScope++
        continue
      }
      if (line.decidedBy === 'human' && req.overwriteHuman !== true) {
        skippedHuman++
        continue
      }
      targets.add(line.id)
    }
    return { targets, skippedHuman, skippedOutOfScope }
  }

  function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AppError('TASK_CANCELLED', { details: { reason: signal.reason ?? 'aborted' } })
  }

  return {
    async recompute(req) {
      const startedAt = now()
      throwIfAborted(req.signal)

      const lines = await deps.canvasRepo.listLines(req.chapterId)
      if (lines.length === 0) {
        return {
          chapterId: req.chapterId,
          scope: req.scope,
          updated: 0,
          skippedHuman: 0,
          skippedOutOfScope: 0,
          embedded: 0,
          lowConfidence: 0,
          embeddingUsed: false,
          llmUsed: false,
          modelSwitched: false,
          patches: [],
          warnings: ['本章还没有画本行，无需重算'],
          elapsedMs: now() - startedAt,
        }
      }

      const { targets, skippedHuman, skippedOutOfScope } = await selectTargets(req, lines)
      const warnings: string[] = []
      if (skippedHuman > 0) {
        warnings.push(
          `CANVAS_ALREADY_EDITED: 有 ${skippedHuman} 行是人工确认的，本次重算保留它们（decided_by=human 永不覆盖）`,
        )
      }

      const providerModelId = deps.embedProvider?.modelId ?? null

      // ---- 模型切换检测（docs/06 §5.5：向量空间不可比） ----
      let modelSwitched = false
      if (providerModelId) {
        const stored = await deps.characterRepo.listCentroids(req.bookId)
        const otherModels = new Set(stored.filter((c) => c.modelId !== providerModelId).map((c) => c.modelId))
        if (otherModels.size > 0) {
          modelSwitched = true
          if (req.scope !== 'all') {
            // 换模型必须全量重算：非 all 的 scope 直接拒绝，并把耗时预估交给 UI（docs/06 §5.5）
            const etaMinutes = Math.max(1, Math.round(lines.length / 600))
            throw new AppError('ATTRIBUTION_RECOMPUTE_REQUIRED', {
              params: { eta: `约 ${etaMinutes} 分钟` },
              details: { chapterId: req.chapterId, storedModels: [...otherModels], currentModel: providerModelId },
            })
          }
          warnings.push(
            'ATTRIBUTION_RECOMPUTE_REQUIRED: 检测到语义模型已更换，本次为全量重算（旧向量空间的结果已作废）',
          )
        }
      }

      const threshold = req.limits?.attributionThreshold ?? req.options.threshold ?? CANVAS_DEFAULTS.attributionThreshold
      const margin = req.limits?.attributionMargin ?? req.options.margin ?? CANVAS_DEFAULTS.attributionMargin
      const contextWindow = req.limits?.contextWindow ?? req.options.contextWindow ?? CANVAS_DEFAULTS.contextWindow

      let decisions = new Map<Id, LineDecision>()
      let embeddingUsed = false
      let llmUsed = false
      let embedded = 0

      if (req.chapterText && req.chapterText.trim().length > 0) {
        // ---- 路径 1：完整流水线（口径与生成完全一致） ----
        const refs = await loadRefs(req.bookId, providerModelId ?? '__none__')
        const { lines: drafts, report } = await generateCanvas({
          chapterId: req.chapterId,
          bookId: req.bookId,
          chapterTitle: req.chapterTitle,
          chapterText: req.chapterText,
          characters: refs,
          options: { ...req.options, overwriteHuman: req.overwriteHuman === true },
          embed: req.options.useEmbedding ? deps.embedProvider ?? undefined : undefined,
          llm: req.options.useLlm ? deps.llmReviewer ?? undefined : undefined,
          signal: req.signal,
          existingLines: lines,
          limits: req.limits,
          now,
        })
        embeddingUsed = report.embeddingUsed
        llmUsed = report.llmUsed
        embedded = drafts.filter((d) => d.vector != null).length
        // 行 id 与库里的行按 seq 对齐（生成时 id 由 chapterId+seq 决定，顺序稳定）
        const bySeq = new Map(lines.map((l) => [l.seq, l]))
        drafts.forEach((d) => {
          const target = bySeq.get(d.seq)
          if (!target) return
          decisions.set(target.id, {
            lineId: target.id,
            characterId: d.characterId,
            name: d.characterName,
            speakerType: d.speakerType,
            confidence: d.confidence ?? 0,
            candidates: d.candidates ?? [],
            decidedBy: d.decidedBy ?? 'rule',
            needsReview: d.needsReview,
            reason: d.attributionReason,
            vector: null,
            shortLineProtected: d.flags.includes('short_line'),
          })
        })
      } else {
        // ---- 路径 2：复用已存向量，只重跑判定（阈值调整的秒级路径） ----
        const modelId = providerModelId ?? '__none__'
        const refs = await loadRefs(req.bookId, modelId)
        const centroids = refs
          .filter((r) => r.centroid && r.centroid.length > 0)
          .map((r) => ({ characterId: r.id, name: r.name, vector: r.centroid! }))
        const view: AttributionLine[] = toAttributionLines(lines)
        const embeddings = await deps.canvasRepo.listEmbeddings(req.chapterId)
        const byLine = new Map(embeddings.map((e) => [e.lineId, e.vector]))
        if (centroids.length > 0) {
          warnings.push('复用已存向量重算（未重新推理）：场景内角色过滤退化为全部已出场角色')
        } else {
          warnings.push('CANVAS_EMBEDDING_UNAVAILABLE: 没有可用的角色原型向量，本次只跑规则判定')
        }

        const partial: LineDecision[] = []
        for (let i = 0; i < view.length; i += batchSize) {
          throwIfAborted(req.signal)
          const slice = view.slice(i, i + batchSize)
          slice.forEach((line, k) => {
            const index = i + k
            const vector = byLine.get(line.id) ?? null
            if (centroids.length === 0 || !vector) {
              partial.push({
                lineId: line.id,
                characterId: null,
                name: null,
                speakerType: 'narration',
                confidence: 0,
                candidates: [],
                decidedBy: 'rule',
                needsReview: line.kind === 'dialogue' || line.kind === 'inner',
                reason: vector ? '缺少角色原型向量' : '没有已存向量（该行未做过语义判定）',
                vector: null,
                shortLineProtected: false,
              })
              return
            }
            embeddingUsed = true
            partial.push(
              decideByStoredVector(view, index, vector, centroids, { threshold, margin, contextWindow }),
            )
          })
          await yieldToLoop()
          req.onProgress?.({
            stage: `复用向量重算 ${Math.min(i + batchSize, view.length)}/${view.length}`,
            ratio: view.length === 0 ? 1 : Math.min(1, (i + batchSize) / view.length),
            done: Math.min(i + batchSize, view.length),
            total: view.length,
          })
        }

        // 规则后处理（连续对白 / 引导语 / 短句保护 / 场景过滤）仍要跑，否则重算结果与生成不一致
        const processed = applyRulePostProcess(partial, view, {
          characters: refs,
          threshold,
          margin,
          shortLineChars: CANVAS_DEFAULTS.shortLineChars,
          consecutiveBonus: CONSECUTIVE_BONUS_DEFAULT,
          sceneFilter: false, // 本路径无场景信息（见 toAttributionLines 的说明）
          embeddingAvailable: embeddingUsed,
        })
        processed.forEach((d) => decisions.set(d.lineId, d))
      }

      // ---- 生成补丁：只对范围内的行、且真的变了才写 ----
      const patches: Array<{ lineId: Id; patch: CanvasLinePatch }> = []
      for (const line of lines) {
        if (!targets.has(line.id)) continue
        const d = decisions.get(line.id)
        if (!d) continue
        const patch: CanvasLinePatch = {}
        const speakerChanged =
          line.characterId !== d.characterId ||
          line.speakerType !== d.speakerType
        if (speakerChanged) {
          patch.characterId = d.characterId
          patch.speakerType = d.speakerType
          patch.confidence = d.confidence
          patch.candidates = d.candidates
          patch.decidedBy = d.decidedBy
          patch.needsReview = d.needsReview
        } else if (line.needsReview !== d.needsReview) {
          patch.needsReview = d.needsReview
        }
        if (Object.keys(patch).length === 0) continue
        patches.push({ lineId: line.id, patch })
      }

      // 分批写库 + 让路（主进程不能长时间独占事件循环）
      let updated = 0
      for (let i = 0; i < patches.length; i += batchSize) {
        throwIfAborted(req.signal)
        const slice = patches.slice(i, i + batchSize)
        updated += await deps.canvasRepo.batchUpdate(slice)
        await yieldToLoop()
      }

      const lowConfidence = [...decisions.values()].filter(
        (d) => targets.has(d.lineId) && d.needsReview,
      ).length

      const elapsedMs = now() - startedAt
      deps.log?.info?.('canvas.recompute.done', {
        chapterId: req.chapterId,
        scope: req.scope,
        updated,
        skippedHuman,
        embeddingUsed,
        elapsedMs,
      })

      return {
        chapterId: req.chapterId,
        scope: req.scope,
        updated,
        skippedHuman,
        skippedOutOfScope,
        embedded,
        lowConfidence,
        embeddingUsed,
        llmUsed,
        modelSwitched,
        patches,
        warnings,
        elapsedMs,
      }
    },
  }
}

/** 供 UI 显示「为什么这么判」：把一次向量判定翻译成中文（复用 shared 的实现） */
export { describeVectorReason }

/** 供上层复用的单行判定（画本编辑器里「用语义再判一次这一行」） */
export function attributeOneLine(
  lines: AttributionLine[],
  index: number,
  vector: Float32Array,
  centroids: Array<{ characterId: Id; name: string; vector: Float32Array }>,
  opts: { threshold?: number; margin?: number; contextWindow?: number },
): LineDecision {
  const line = lines[index]
  const ctx = buildContext(lines, index, opts.contextWindow ?? CANVAS_DEFAULTS.contextWindow)
  ctx.vector = vector
  const decision = attributeByVector(ctx, centroids, {
    threshold: opts.threshold ?? CANVAS_DEFAULTS.attributionThreshold,
    margin: opts.margin ?? CANVAS_DEFAULTS.attributionMargin,
  })
  return {
    lineId: line.id,
    characterId: decision.characterId,
    name: decision.name,
    speakerType: decision.accepted ? 'character' : 'narration',
    confidence: decision.confidence,
    candidates: decision.candidates,
    decidedBy: decision.accepted ? 'vector' : 'rule',
    needsReview: !decision.accepted,
    reason: describeVectorReason(decision),
    vector: decision,
    shortLineProtected: false,
  }
}
