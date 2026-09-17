/**
 * Novel Studio · 画本功能域入口（主进程）
 * ============================================================================
 * 设计依据：docs/11 §2（生成流程）、§5（质检）、§7（IPC 动作）、docs/06 §5（判定与重算）
 *
 * 用法（IPC handler 里）：
 * ```ts
 * const canvas = createCanvasFeature({
 *   canvasRepo: createSqliteCanvasRepo(db),
 *   characterRepo: createSqliteCharacterRepo(db),
 *   embedProvider: onnxEmbedding,      // 模型缺失时传 null → 自动规则降级
 *   llmReviewer: aiProviderReviewer,   // 可选
 *   listSegments: async (chapterId) => { ... },   // 质检用，需 fs.existsSync
 * })
 * await canvas.service.generateChapter({ ... })
 * ```
 *
 * 一处创建、处处复用：service 与 attributionService 共享同一批仓储与 provider，
 * 避免「生成用一个模型、重算用另一个模型」这种向量空间错乱（docs/06 §5.5）。
 */

import { AppError } from '../../../../shared/errors.ts'
import {
  createCanvasService,
  type CanvasService,
  type CanvasServiceDeps,
  type GenerateChapterRequest,
  type GenerateChapterResult,
} from './canvas.service.ts'
import {
  createAttributionService,
  type AttributionService,
  type RecomputeRequest,
  type RecomputeResult,
} from './attribution.service.ts'
import {
  createMemoryCanvasRepo,
  isHumanEditablePatch,
  type CanvasRepo,
  type CanvasSnapshot,
  type LineEmbeddingRecord,
} from './repositories/canvas.repo.ts'
import {
  buildCentroidRecord,
  createMemoryCharacterRepo,
  type CharacterCentroidRecord,
  type CharacterRepo,
} from './repositories/character.repo.ts'

export interface CanvasFeature {
  service: CanvasService
  attributionService: AttributionService
  canvasRepo: CanvasRepo
  characterRepo: CharacterRepo
  /** 生成一章（Step 1~9） */
  generateChapter(req: GenerateChapterRequest): Promise<GenerateChapterResult>
  /** 重算判定（scope: low_confidence | all | selection） */
  recomputeAttribution(req: RecomputeRequest): Promise<RecomputeResult>
}

/**
 * 组装画本功能域（依赖注入）。
 *
 * 失败时抛 AppError('INVALID_PAYLOAD')（缺仓储）。
 * provider 缺省是**合法**的：缺 embedding → 规则判定 + `embeddingUsed=false`（docs/06 §8）。
 */
export function createCanvasFeature(deps: CanvasServiceDeps): CanvasFeature {
  if (!deps?.canvasRepo || !deps?.characterRepo) {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        op: 'createCanvasFeature',
        reason: 'missing-repo',
        hint: '需要 canvasRepo 与 characterRepo（见 docs/21 §5）',
      },
    })
  }
  const service = createCanvasService(deps)
  const attributionService = createAttributionService({
    canvasRepo: deps.canvasRepo,
    characterRepo: deps.characterRepo,
    embedProvider: deps.embedProvider,
    llmReviewer: deps.llmReviewer,
    now: deps.now,
    log: deps.log,
    yieldToLoop: deps.yieldToLoop,
    batchSize: deps.batchSize,
  })

  return {
    service,
    attributionService,
    canvasRepo: deps.canvasRepo,
    characterRepo: deps.characterRepo,
    generateChapter: (req) => service.generateChapter(req),
    recomputeAttribution: (req) => attributionService.recompute(req),
  }
}

/**
 * 测试/演示用的装配：只补齐未提供的仓储（生产用 SQLite 实现替换即可）。
 * 注意：传入的 canvasRepo / characterRepo 会被尊重（不会被空内存实现顶掉）。
 */
export function createMemoryCanvasFeature(
  deps?: Omit<CanvasServiceDeps, 'canvasRepo' | 'characterRepo'> & {
    canvasRepo?: CanvasRepo
    characterRepo?: CharacterRepo
  },
): CanvasFeature {
  return createCanvasFeature({
    ...(deps ?? {}),
    canvasRepo: deps?.canvasRepo ?? createMemoryCanvasRepo(),
    characterRepo: deps?.characterRepo ?? createMemoryCharacterRepo(),
  })
}

export {
  createCanvasService,
  createAttributionService,
  createMemoryCanvasRepo,
  createMemoryCharacterRepo,
  buildCentroidRecord,
  isHumanEditablePatch,
}
export type {
  CanvasService,
  CanvasServiceDeps,
  GenerateChapterRequest,
  GenerateChapterResult,
  AttributionService,
  RecomputeRequest,
  RecomputeResult,
  CanvasRepo,
  CanvasSnapshot,
  LineEmbeddingRecord,
  CharacterRepo,
  CharacterCentroidRecord,
}

// 主进程对外只需要这三个（IPC 契约见 docs/20 §4.3/§4.4）
export type {
  QualityIssue,
  CanvasGenerateReport,
  CanvasLine,
  ChapterCanvasState,
} from '../../../../shared/types.ts'
