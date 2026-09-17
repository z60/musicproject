/**
 * Novel Studio · 画本生成编排（主进程）
 * ============================================================================
 * 设计依据：
 *   · docs/11 §2   生成流程 Step 1 ~ Step 9（本文件负责编排与 Step 9 落库）
 *   · docs/11 §8   异常与边界（模型缺失 → 规则判定 + 明确提示；角色表为空 → 先抽取）
 *   · docs/06 §4.3 批量推理必须 `yieldToLoop()` 让路，否则 UI 卡死
 *   · docs/06 §5.5 换模型必须全量重算；人工行永不覆盖
 *   · docs/03 §5.2 向量写入前必须 L2 归一化；必须记录 model_id 与 content_hash
 *
 * 依赖注入（无网络环境下不可直接 new）：
 *   · EmbeddingProvider（生产：OnnxEmbeddingProvider，onnxruntime-node + bge-small-zh-v1.5）
 *   · LlmReviewer（生产：AIProvider.chat + 结构化输出校验）
 *   · CanvasRepo / CharacterRepo（生产：better-sqlite3 实现）
 * 两者缺一即可用（显式降级并写进 report.warnings），绝不抛错阻断用户。
 */

import { createHash } from 'node:crypto'

import { AppError } from '../../../../shared/errors.ts'
import { CANVAS_DEFAULTS } from '../../../../shared/constants.ts'
import type {
  CanvasGenerateOptions,
  CanvasGenerateReport,
  CanvasLine,
  CanvasLinePatch,
  ChapterCanvasState,
  Id,
  QualityIssue,
  Timestamp,
} from '../../../../shared/types.ts'
import {
  attributeByVector,
  buildContext,
  buildGenerateReport,
  classifyKind,
  countReadableChars,
  generateCanvas,
  inferPause,
  inferTags,
  qualityCheck,
  resolveSpeakerHint,
  splitToLines,
  type AttributionLine,
  type CanvasCharacterRef,
  type CanvasGenerateDraft,
  type CanvasLimits,
  type EmbeddingProvider,
  type LineDecision,
  type LlmReviewer,
  type QualityCheckOptions,
  type QualitySegmentRef,
} from '../../../../shared/canvas/index.ts'
import { computeCentroid } from '../../../../shared/canvas/vector.ts'
import type { CanvasRepo } from './repositories/canvas.repo.ts'
import type { CharacterCentroidRecord, CharacterRepo } from './repositories/character.repo.ts'

// ============================================================================
// 依赖与请求类型
// ============================================================================

export interface CanvasServiceDeps {
  canvasRepo: CanvasRepo
  characterRepo: CharacterRepo
  /** 注入式向量提供者；不注入 → 规则判定 + report.embeddingUsed=false */
  embedProvider?: EmbeddingProvider | null
  /** 注入式 LLM 复核；不注入 → 低置信行全部进待确认队列 */
  llmReviewer?: LlmReviewer | null
  /**
   * 让出事件循环。ONNX 推理是同步阻塞的（docs/06 §4.3），
   * 默认实现用 `setImmediate`，生产可换成窗口级调度器（例如忙时降频）。
   */
  yieldToLoop?: () => Promise<void>
  now?: () => Timestamp
  /** 行/快照 id 生成（生产：nanoid；测试：确定性 id） */
  generateId?: (prefix: string) => Id
  /** 每批处理的行数（默认 200；docs/11 §8「章节超长 分批处理 + 进度」） */
  batchSize?: number
  /**
   * 片段引用来源（recorded_missing 质检用）。
   * 生产：查 voice_segments 并用 `fs.existsSync(relativeToProjectRoot(filePath))` 填 `exists`。
   */
  listSegments?: (chapterId: Id) => Promise<QualitySegmentRef[]>
  log?: {
    info?: (event: string, fields?: Record<string, unknown>) => void
    warn?: (event: string, fields?: Record<string, unknown>) => void
    error?: (event: string, fields?: Record<string, unknown>) => void
  }
}

export interface GenerateChapterRequest {
  bookId: Id
  chapterId: Id
  chapterTitle?: string
  /** 章节原文（清洗后的正文） */
  chapterText: string
  options: CanvasGenerateOptions
  /** 全局节奏系数（TEMPO_PRESETS.factor） */
  tempoFactor?: number
  /** 是否生成章首标题念白行（docs/15 §7） */
  includeTitleLine?: boolean
  /** 覆盖 CANVAS_DEFAULTS 的限制 */
  limits?: CanvasLimits
  /** 生成前自动打快照（默认 true，docs/11 §2 FR-2.4.7） */
  snapshot?: boolean
  signal?: AbortSignal
  /** 进度回调（主进程转 TaskProgressEvent，docs/04 §2） */
  onProgress?: (progress: { stage: string; ratio: number; done: number; total: number }) => void
}

export interface GenerateChapterResult {
  chapterId: Id
  lines: CanvasLine[]
  report: CanvasGenerateReport
  snapshotId: Id | null
  /** 章节画本状态（供 chapters.canvas_state 更新） */
  canvasState: ChapterCanvasState
  warnings: string[]
}

export interface UpdateLineRequest {
  lineId: Id
  patch: CanvasLinePatch
  /** 乐观锁（docs/11 §4.9） */
  rev?: number
}

export interface QualityCheckRequest {
  chapterId: Id
  opts?: QualityCheckOptions
}

// ============================================================================
// 服务
// ============================================================================

export interface CanvasService {
  generateChapter(req: GenerateChapterRequest): Promise<GenerateChapterResult>
  /** 质检（返回问题列表；不落库） */
  qualityCheck(req: QualityCheckRequest): Promise<QualityIssue[]>
  /** 单行更新：改过就自动置 decidedBy='human'（docs/11 §4.4） */
  updateLine(req: UpdateLineRequest): Promise<CanvasLine>
  /** 批量更新（一个事务） */
  batchUpdate(patches: Array<{ lineId: Id; patch: CanvasLinePatch }>): Promise<number>
  /** 重算单章判定用：把行还原成判定视图（供 attribution.service 复用） */
  rebuildAttributionView(chapterId: Id): Promise<{ lines: AttributionLine[]; characters: CanvasCharacterRef[] }>
}

const DEFAULT_BATCH_SIZE = 200

/** 默认让路实现：`setImmediate` 让事件循环跑一轮（主进程才能响应 IPC） */
export function defaultYieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 把「判定给某角色且置信度达标」的行向量按角色分组（供原型向量增量更新）。
 *
 * 为什么要有置信度门槛：把判错的行也喂进原型，会让原型被自己的错误带偏
 * （docs/03 §5.3 的「剔除离群」解决的是历史数据，这里解决的是增量入口）。
 */
export function accumulateCentroidsForLines(
  lines: Array<{ characterId: Id | null; confidence: number | null; vector: Float32Array | null }>,
  threshold: number,
): Map<Id, Float32Array[]> {
  const out = new Map<Id, Float32Array[]>()
  for (const l of lines) {
    if (!l.characterId || !l.vector) continue
    if (l.confidence == null || l.confidence < threshold) continue
    const list = out.get(l.characterId) ?? []
    list.push(l.vector)
    out.set(l.characterId, list)
  }
  return out
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('TASK_CANCELLED', { details: { reason: signal.reason ?? 'aborted' } })
  }
}

/** 判定文本的缓存键（docs/06 §7.1：sha256(modelId + '|' + 判定文本)） */
export function contentHashOf(modelId: string, text: string): string {
  return createHash('sha256').update(`${modelId}|${text}`).digest('hex')
}

/**
 * 创建画本服务。
 *
 * Step 1~8 在 `shared/canvas/attribution.ts` 里完成（纯逻辑、可单测）；
 * 本文件负责 Step 9（分批落库 + 更新原型向量 + 统计报告）与主进程生命周期事项
 * （AbortSignal 取消、分批让路、进度上报、快照）。
 */
export function createCanvasService(deps: CanvasServiceDeps): CanvasService {
  const now = deps.now ?? (() => Date.now())
  const yieldToLoop = deps.yieldToLoop ?? defaultYieldToLoop
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE)
  let idCounter = 0
  const generateId = deps.generateId ?? ((prefix: string) => `${prefix}-${++idCounter}`)

  /** 角色表 + 原型向量 → 判定用的角色引用 */
  async function loadCharacterRefs(bookId: Id, modelId: string): Promise<CanvasCharacterRef[]> {
    const characters = await deps.characterRepo.listByBook(bookId, { includeArchived: false })
    const centroids = await deps.characterRepo.listCentroids(bookId, modelId)
    const byId = new Map(centroids.map((c) => [c.characterId, c]))
    return characters.map((c) => {
      const rec = byId.get(c.id)
      return {
        id: c.id,
        name: c.name,
        aliases: c.aliases,
        description: c.description,
        centroid: rec ? Float32Array.from(rec.centroid) : null,
      }
    })
  }

  /** Step 9：把草稿行落库（分批 + 让路 + 可取消） */
  async function persistLines(
    drafts: CanvasGenerateDraft[],
    req: GenerateChapterRequest,
  ): Promise<CanvasLine[]> {
    const ts = now()
    const out: CanvasLine[] = []
    for (let start = 0; start < drafts.length; start += batchSize) {
      throwIfAborted(req.signal)
      const slice = drafts.slice(start, start + batchSize)
      for (const d of slice) {
        out.push({
          id: d.id,
          chapterId: d.chapterId,
          bookId: d.bookId,
          seq: d.seq,
          speakerType: d.speakerType,
          characterId: d.characterId,
          kind: d.kind,
          text: d.text,
          sourceText: d.sourceText,
          charStart: d.charStart,
          charEnd: d.charEnd,
          emotion: d.emotion,
          emotionIntensity: d.emotionIntensity,
          speed: d.speed,
          gainDb: d.gainDb,
          pauseAfterMs: d.pauseAfterMs,
          pauseInline: d.pauseInline,
          pronunciation: d.pronunciation,
          note: d.note,
          state: d.state,
          confidence: d.confidence,
          candidates: d.candidates,
          decidedBy: d.decidedBy,
          needsReview: d.needsReview,
          flags: d.flags,
          isTitle: d.isTitle,
          rev: 1,
          createdAt: ts,
          updatedAt: ts,
        })
      }
      await yieldToLoop()
      req.onProgress?.({
        stage: `写入画本行 ${Math.min(start + batchSize, drafts.length)}/${drafts.length}`,
        ratio: drafts.length === 0 ? 1 : Math.min(1, (start + batchSize) / drafts.length),
        done: Math.min(start + batchSize, drafts.length),
        total: drafts.length,
      })
    }
    return out
  }

  /** Step 9：写 line_embeddings + 增量更新 character_centroids（docs/06 §5.1 Step 8） */
  async function persistVectors(
    drafts: CanvasGenerateDraft[],
    modelId: string | null,
    options: CanvasGenerateOptions,
  ): Promise<void> {
    if (modelId == null) return
    const withVectors = drafts.filter((d) => d.vector != null)
    if (withVectors.length === 0) return

    for (let start = 0; start < withVectors.length; start += batchSize) {
      const slice = withVectors.slice(start, start + batchSize)
      for (const d of slice) {
        await deps.canvasRepo.upsertEmbedding({
          lineId: d.id,
          modelId,
          dim: d.vector!.length,
          vector: d.vector!,
          contentHash: contentHashOf(modelId, d.text),
          contextScope: options.contextWindow ?? CANVAS_DEFAULTS.contextWindow,
          createdAt: now(),
        })
      }
      await yieldToLoop()
    }

    // 原型向量增量：只把「判定为某角色且置信度达标」的行计入该角色样本
    const threshold = options.threshold ?? CANVAS_DEFAULTS.attributionThreshold
    for (const [characterId, vectors] of accumulateCentroidsForLines(
      withVectors.map((d) => ({ characterId: d.characterId, confidence: d.confidence, vector: d.vector })),
      threshold,
    )) {
      const existing = await deps.characterRepo.getCentroid(characterId, modelId)
      const dim = existing?.dim ?? vectors[0].length
      const sum = existing ? Float32Array.from(existing.sumVector) : new Float32Array(dim)
      let count = existing?.sampleCount ?? 0
      for (const v of vectors) {
        if (v.length !== dim) continue
        for (let i = 0; i < dim; i++) sum[i] += v[i]
        count++
      }
      const record = buildCentroidFromSum(characterId, modelId, sum, count, now())
      await deps.characterRepo.upsertCentroid(record)
    }
  }

  return {
    async generateChapter(req) {
      const startedAt = now()
      throwIfAborted(req.signal)
      if (!req.chapterText || req.chapterText.trim().length === 0) {
        throw new AppError('CANVAS_CHAPTER_EMPTY', { details: { chapterId: req.chapterId } })
      }

      const modelId = req.options.useEmbedding === true ? deps.embedProvider?.modelId ?? null : null
      const [existing, characters] = await Promise.all([
        deps.canvasRepo.listLines(req.chapterId),
        loadCharacterRefs(req.bookId, modelId ?? '__none__'),
      ])

      // 生成前自动打快照（docs/11 §2 / FR-2.4.7）
      let snapshotId: Id | null = null
      if (req.snapshot !== false && existing.length > 0) {
        const snap = await deps.canvasRepo.createSnapshot({
          id: generateId('snap'),
          chapterId: req.chapterId,
          label: '生成前自动快照',
          reason: 'pre_generate',
          now: now(),
        })
        snapshotId = snap.id
      }

      // 需要全部向量时，这里要保证角色原型是最新的（docs/03 §5.3：冷启动 → 首轮迭代）
      const refsWithCentroids = await ensureCentroidsForCharacters(characters, existing, modelId)

      req.onProgress?.({ stage: '切句与规则粗筛', ratio: 0.05, done: 0, total: 0 })
      const { lines: drafts, report } = await generateCanvas({
        chapterId: req.chapterId,
        bookId: req.bookId,
        chapterTitle: req.chapterTitle,
        chapterText: req.chapterText,
        characters: refsWithCentroids,
        options: req.options,
        tempoFactor: req.tempoFactor,
        embed: req.options.useEmbedding ? deps.embedProvider ?? undefined : undefined,
        llm: req.options.useLlm ? deps.llmReviewer ?? undefined : undefined,
        signal: req.signal,
        existingLines: existing,
        idFactory: (seq) => `${req.chapterId}-L${String(seq).padStart(5, '0')}`,
        includeTitleLine: req.includeTitleLine,
        limits: req.limits,
        now,
      })

      req.onProgress?.({ stage: '写入画本行', ratio: 0.5, done: 0, total: drafts.length })
      const persisted = await persistLines(drafts, req)
      await deps.canvasRepo.replaceChapterLines(req.chapterId, persisted)
      await persistVectors(drafts, modelId, req.options)

      const elapsedMs = now() - startedAt
      const finalReport: CanvasGenerateReport = {
        ...report,
        totalLines: persisted.length,
        elapsedMs,
      }
      const warnings = [...finalReport.warnings]
      if (finalReport.lowConfidence > 0) {
        warnings.push(`CANVAS_ATTRIBUTION_LOW_CONFIDENCE: ${finalReport.lowConfidence} 行需要人工确认`)
      }

      const canvasState: ChapterCanvasState = 'generated'
      deps.log?.info?.('canvas.generate.done', {
        chapterId: req.chapterId,
        lines: persisted.length,
        embeddingUsed: finalReport.embeddingUsed,
        llmUsed: finalReport.llmUsed,
        elapsedMs,
      })

      return {
        chapterId: req.chapterId,
        lines: persisted,
        report: { ...finalReport, warnings },
        snapshotId,
        canvasState,
        warnings,
      }
    },

    async qualityCheck(req) {
      const lines = await deps.canvasRepo.listLines(req.chapterId)
      const bookId = lines[0]?.bookId
      const characters = bookId ? await deps.characterRepo.listByBook(bookId, { includeArchived: false }) : []
      // 片段文件是否存在由调用方注入（docs/11 §5 recorded_missing）
      const segments: QualitySegmentRef[] = deps.listSegments
        ? await deps.listSegments(req.chapterId)
        : []
      return qualityCheck(lines, characters, segments, req.opts)
    },

    async updateLine(req) {
      const patch: CanvasLinePatch = { ...req.patch }
      // 改过说话人/文本 → 自动置人工确认（docs/11 §4.4「强制标记」）
      if (patch.decidedBy == null) {
        const touched =
          'characterId' in patch || 'speakerType' in patch || 'text' in patch || 'kind' in patch
        if (touched) patch.decidedBy = 'human'
      }
      const updated = await deps.canvasRepo.updateLine(req.lineId, patch, req.rev)
      // 文本改了 → 该行向量作废（docs/06 §5.5：content_hash 变化 → 仅重算该行）
      if ('text' in patch) await deps.canvasRepo.deleteEmbedding(req.lineId)
      return updated
    },

    async batchUpdate(patches) {
      return deps.canvasRepo.batchUpdate(patches)
    },

    async rebuildAttributionView(chapterId) {
      const lines = await deps.canvasRepo.listLines(chapterId)
      const bookId = lines[0]?.bookId ?? ''
      const refs = await loadCharacterRefs(bookId, deps.embedProvider?.modelId ?? '__none__')
      return { lines: toAttributionLines(lines), characters: refs }
    },
  }

  /** 角色没有原型时，用「已判定给该角色的历史行向量」现算一个原型（docs/03 §5.3 冷启动） */
  async function ensureCentroidsForCharacters(
    refs: CanvasCharacterRef[],
    existingLines: CanvasLine[],
    modelId: string | null,
  ): Promise<CanvasCharacterRef[]> {
    if (refs.length === 0) return refs
    const missing = refs.filter((r) => !r.centroid || r.centroid.length === 0)
    if (missing.length === 0) return refs

    // 有历史行时：用「已判定给该角色的行」在已有向量空间里做原型（比合成文本更准）
    const chapterId = existingLines[0]?.chapterId ?? ''
    const embeddings = modelId && chapterId ? await deps.canvasRepo.listEmbeddings(chapterId) : []
    const byLine = new Map(embeddings.map((e) => [e.lineId, e.vector]))
    const samplesByCharacter = new Map<Id, Float32Array[]>()
    for (const l of existingLines) {
      if (!l.characterId) continue
      const v = byLine.get(l.id)
      if (!v) continue
      const list = samplesByCharacter.get(l.characterId) ?? []
      list.push(v)
      samplesByCharacter.set(l.characterId, list)
    }

    return refs.map((r) => {
      if (r.centroid && r.centroid.length > 0) return r
      const samples = samplesByCharacter.get(r.id) ?? []
      if (samples.length === 0) return r
      const { centroid } = computeCentroid(samples, { outlierThreshold: 0.3 })
      return { ...r, centroid }
    })
  }
}

/** 从累加和构造原型记录（导出以便测试直接复用） */
export function buildCentroidFromSum(
  characterId: Id,
  modelId: string,
  sumVector: Float32Array,
  sampleCount: number,
  now: Timestamp,
): CharacterCentroidRecord {
  const dim = sumVector.length
  const centroid = new Float32Array(dim)
  if (sampleCount > 0) {
    const inv = 1 / sampleCount
    let norm = 0
    for (let i = 0; i < dim; i++) {
      centroid[i] = sumVector[i] * inv
      norm += centroid[i] * centroid[i]
    }
    norm = Math.sqrt(norm)
    if (norm > 1e-8) for (let i = 0; i < dim; i++) centroid[i] /= norm
  }
  return {
    characterId,
    modelId,
    dim,
    sumVector: Float32Array.from(sumVector),
    sampleCount,
    centroid,
    updatedAt: now,
  }
}

/**
 * 把已落库的画本行还原成判定视图（recompute 用；docs/06 §5.5 的「只重跑判定、不重新 embedding」）。
 *
 * 已知限制（**必须向用户说明**）：`canvas_lines` 里没有存段落/场景信息，
 * 因此这条路径把所有行视为同一场景（`sceneIndex=0`）——「场景内角色过滤」会退化为
 * 「全部已出场角色」。需要与生成完全一致的口径时，请在 recompute 时提供章节原文
 * （见 `RecomputeRequest.chapterText`），那条路径会重新分句，场景划分与生成时一致。
 */
export function toAttributionLines(lines: CanvasLine[]): AttributionLine[] {
  const ordered = [...lines].sort((a, b) => a.seq - b.seq)
  return ordered.map((l) => {
    // 行里没存 cue：用 sourceText 重跑一次规则粗筛（成本可忽略，比重新分句安全）
    const cls = classifyKind(l.sourceText ?? l.text)
    return {
      id: l.id,
      seq: l.seq,
      kind: l.kind,
      text: l.text,
      sourceText: l.sourceText ?? l.text,
      cue: cls.cue,
      cueSpeaker: null,
      charStart: l.charStart,
      charEnd: l.charEnd,
      paragraphIndex: 0,
      sceneIndex: 0,
      startsParagraph: false,
      endsParagraph: false,
      quoteUnmatched: l.flags.includes('quote_unmatched'),
      tooLong: countReadableChars(l.text) > CANVAS_DEFAULTS.maxLineChars,
    }
  })
}

/** 供 attribution.service 复用：复用已存向量做单行判定（不重新 embedding 的路径） */
export function decideByStoredVector(
  lines: AttributionLine[],
  index: number,
  vector: Float32Array,
  centroids: Array<{ characterId: Id; name: string; vector: Float32Array }>,
  opts: { threshold: number; margin: number; contextWindow?: number },
): LineDecision {
  const line = lines[index]
  const ctx = buildContext(lines, index, opts.contextWindow ?? CANVAS_DEFAULTS.contextWindow)
  ctx.vector = vector
  const decision = attributeByVector(ctx, centroids, { threshold: opts.threshold, margin: opts.margin })
  if (decision.accepted && decision.characterId) {
    return {
      lineId: line.id,
      characterId: decision.characterId,
      name: decision.name,
      speakerType: 'character',
      confidence: decision.confidence,
      candidates: decision.candidates,
      decidedBy: 'vector',
      needsReview: false,
      reason: '复用语义向量重算',
      vector: decision,
      shortLineProtected: false,
    }
  }
  return {
    lineId: line.id,
    characterId: null,
    name: null,
    speakerType: 'narration',
    confidence: decision.confidence,
    candidates: decision.candidates,
    decidedBy: 'rule',
    needsReview: line.kind === 'dialogue' || line.kind === 'inner',
    reason: '向量未达阈值，待人工确认',
    vector: decision,
    shortLineProtected: false,
  }
}

/** 供上层复用的停顿/情绪推断（画本行局部编辑时无需重跑整个流水线） */
export { inferPause, inferTags, resolveSpeakerHint, splitToLines, buildGenerateReport }
export type { EmbeddingProvider }
