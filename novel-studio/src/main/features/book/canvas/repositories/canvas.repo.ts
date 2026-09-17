/**
 * Novel Studio · 画本行仓储（接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/21 §5   canvas_lines / line_embeddings / canvas_snapshots 表结构
 *   · docs/11 §4.9 自动保存与冲突（乐观锁 rev）
 *   · docs/11 §2   「每次生成前自动打快照，可回滚」（FR-2.4.7）
 *   · docs/03 §5.2 「必须记录 model_id 与 content_hash」
 *
 * 这里只定接口 + 内存实现：
 *   · 生产实现（`createSqliteCanvasRepo(db)`）落在同目录，由 better-sqlite3 + 事务完成；
 *     本任务环境下不引入原生依赖，因此先给出可测试的内存实现，接口即落库契约。
 *   · 内存实现是**测试与降级演示**用的：它精确复刻乐观锁、软删除、快照语义。
 *
 * 零第三方依赖。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type { CanvasLine, CanvasLinePatch, Id, Timestamp } from '../../../../../shared/types.ts'

// ============================================================================
// 类型
// ============================================================================

/** 一行向量（对应 line_embeddings，docs/21 §5） */
export interface LineEmbeddingRecord {
  lineId: Id
  modelId: string
  dim: number
  /** 已 L2 归一化的 Float32Array */
  vector: Float32Array
  /** sha256(modelId + '|' + 判定文本)（docs/06 §7.1） */
  contentHash: string
  /** 拼上下文时用的行窗口（默认 2） */
  contextScope: number
  createdAt: Timestamp
}

/** 画本快照（docs/21 §5 canvas_snapshots；生成/重算前自动打） */
export interface CanvasSnapshot {
  id: Id
  chapterId: Id
  label: string | null
  reason: 'pre_generate' | 'manual' | 'pre_restore'
  /** 序列化后的行数据（生产实现与表结构一致） */
  payload: CanvasLine[]
  createdAt: Timestamp
}

export interface ReplaceChapterResult {
  deleted: number
  inserted: number
}

export interface CanvasRepo {
  // ---- 读 ----
  listLines(chapterId: Id): Promise<CanvasLine[]>
  getLine(lineId: Id): Promise<CanvasLine | null>
  countByChapter(chapterId: Id): Promise<number>
  /** 人工确认过的行数（生成前提示「本章已有 N 行人工修改」，docs/11 §8） */
  countHumanDecided(chapterId: Id): Promise<number>

  // ---- 写 ----
  insertLines(lines: CanvasLine[]): Promise<number>
  /** 整章替换（一个事务）：先软删除旧行再插入新行 */
  replaceChapterLines(chapterId: Id, lines: CanvasLine[]): Promise<ReplaceChapterResult>
  /**
   * 更新单行。`expectedRev` 给定时做乐观锁校验，不匹配抛 AppError('CONFLICT')（docs/11 §4.9）。
   * 返回更新后的行；行不存在抛 AppError('NOT_FOUND')。
   */
  updateLine(lineId: Id, patch: CanvasLinePatch, expectedRev?: number): Promise<CanvasLine>
  /** 批量更新（一个事务），返回更新行数；docs/21 的 check 约束在实现里也要保住 */
  batchUpdate(patches: Array<{ lineId: Id; patch: CanvasLinePatch }>): Promise<number>
  /** 软删除（docs/11 §4.7：批量删除是软删除，可恢复） */
  softDeleteLines(lineIds: Id[]): Promise<number>
  restoreLines(lineIds: Id[]): Promise<number>

  // ---- 向量 ----
  upsertEmbedding(record: LineEmbeddingRecord): Promise<void>
  getEmbedding(lineId: Id): Promise<LineEmbeddingRecord | null>
  listEmbeddings(chapterId: Id): Promise<LineEmbeddingRecord[]>
  /** 文本变了要作废该行向量（docs/06 §5.5：content_hash 变化 → 仅重算该行） */
  deleteEmbedding(lineId: Id): Promise<void>

  // ---- 快照 ----
  createSnapshot(input: {
    id?: Id
    chapterId: Id
    label?: string | null
    reason?: CanvasSnapshot['reason']
    now?: Timestamp
  }): Promise<CanvasSnapshot>
  listSnapshots(chapterId: Id): Promise<CanvasSnapshot[]>
  getSnapshot(snapshotId: Id): Promise<CanvasSnapshot | null>
}

// ============================================================================
// 内存实现
// ============================================================================

const HUMAN_EDITABLE_FIELDS: ReadonlyArray<keyof CanvasLinePatch> = [
  'text', 'kind', 'characterId', 'speakerType', 'emotion', 'emotionIntensity',
  'speed', 'gainDb', 'pauseAfterMs', 'pauseInline', 'pronunciation', 'note', 'flags',
]

/**
 * 创建内存画本仓储（供测试与演示）。
 *
 * - 时间戳可用 `now` 注入（测试里固定时间，避免 flaky 断言）
 * - 深拷贝进出：调用方拿到的是副本，改它不会污染仓储（等价于走了一次 SQLite 往返）
 * - 乐观锁、软删除、快照语义与生产实现一致
 */
export function createMemoryCanvasRepo(seed?: { lines?: CanvasLine[]; now?: () => Timestamp }): CanvasRepo {
  const lines = new Map<Id, { line: CanvasLine; deletedAt: Timestamp | null }>()
  const embeddings = new Map<Id, LineEmbeddingRecord>()
  const snapshots = new Map<Id, CanvasSnapshot>()
  const now = seed?.now ?? (() => Date.now())
  let seq = 0
  const nextId = (prefix: string): Id => `${prefix}-${++seq}`

  for (const l of seed?.lines ?? []) lines.set(l.id, { line: cloneLine(l), deletedAt: null })

  const requireLine = (lineId: Id): CanvasLine => {
    const rec = lines.get(lineId)
    if (!rec || rec.deletedAt != null) {
      throw new AppError('NOT_FOUND', { details: { entity: 'canvas_line', lineId } })
    }
    return rec.line
  }

  const applyPatch = (line: CanvasLine, patch: CanvasLinePatch): CanvasLine => {
    const next: CanvasLine = { ...line, ...patch, updatedAt: now() }
    // 保住表上的 CHECK 约束语义（docs/21 §5）
    if (next.confidence != null) {
      next.confidence = Math.max(0, Math.min(1, next.confidence))
      if (!Number.isFinite(next.confidence)) next.confidence = null
    }
    if (next.emotionIntensity != null) {
      next.emotionIntensity = Math.max(1, Math.min(5, Math.round(next.emotionIntensity)))
    }
    if (next.pauseAfterMs == null || !Number.isFinite(next.pauseAfterMs) || next.pauseAfterMs < 0) {
      next.pauseAfterMs = 0
    }
    return next
  }

  /** 插入实现（内部直接调用，避免依赖 `this` 绑定） */
  const insertLinesImpl = async (incoming: CanvasLine[]): Promise<number> => {
    const ts = now()
    for (const l of incoming) {
      lines.set(l.id, {
        line: cloneLine({ ...l, createdAt: l.createdAt || ts, updatedAt: ts }),
        deletedAt: null,
      })
    }
    return incoming.length
  }

  return {
    async listLines(chapterId) {
      return [...lines.values()]
        .filter((r) => r.deletedAt == null && r.line.chapterId === chapterId)
        .map((r) => cloneLine(r.line))
        .sort((a, b) => a.seq - b.seq)
    },

    async getLine(lineId) {
      const rec = lines.get(lineId)
      return rec && rec.deletedAt == null ? cloneLine(rec.line) : null
    },

    async countByChapter(chapterId) {
      return [...lines.values()].filter((r) => r.deletedAt == null && r.line.chapterId === chapterId).length
    },

    async countHumanDecided(chapterId) {
      return [...lines.values()].filter(
        (r) => r.deletedAt == null && r.line.chapterId === chapterId && r.line.decidedBy === 'human',
      ).length
    },

    async insertLines(incoming) {
      return insertLinesImpl(incoming)
    },

    async replaceChapterLines(chapterId, incoming) {
      let deleted = 0
      for (const [, rec] of lines) {
        if (rec.deletedAt == null && rec.line.chapterId === chapterId) {
          rec.deletedAt = now()
          deleted++
        }
      }
      const inserted = await insertLinesImpl(incoming.map((l) => ({ ...l, chapterId })))
      return { deleted, inserted }
    },

    async updateLine(lineId, patch, expectedRev) {
      // 用统一的取行辅助：不存在或已软删除时抛 NOT_FOUND（避免各处重复这段校验）
      requireLine(lineId)
      const rec = lines.get(lineId)!
      if (expectedRev != null && rec.line.rev !== expectedRev) {
        throw new AppError('CONFLICT', {
          details: { entity: 'canvas_line', lineId, expectedRev, actualRev: rec.line.rev },
        })
      }
      const next = applyPatch(rec.line, patch)
      next.rev = rec.line.rev + 1
      rec.line = next
      return cloneLine(next)
    },

    async batchUpdate(patches) {
      let n = 0
      for (const p of patches) {
        const rec = lines.get(p.lineId)
        if (!rec || rec.deletedAt != null) continue
        const next = applyPatch(rec.line, p.patch)
        next.rev = rec.line.rev + 1
        rec.line = next
        n++
      }
      return n
    },

    async softDeleteLines(lineIds) {
      const ts = now()
      let n = 0
      for (const id of lineIds) {
        const rec = lines.get(id)
        if (rec && rec.deletedAt == null) {
          rec.deletedAt = ts
          n++
        }
      }
      return n
    },

    async restoreLines(lineIds) {
      let n = 0
      for (const id of lineIds) {
        const rec = lines.get(id)
        if (rec && rec.deletedAt != null) {
          rec.deletedAt = null
          n++
        }
      }
      return n
    },

    async upsertEmbedding(record) {
      embeddings.set(record.lineId, { ...record, vector: Float32Array.from(record.vector) })
    },

    async getEmbedding(lineId) {
      const r = embeddings.get(lineId)
      return r ? { ...r, vector: Float32Array.from(r.vector) } : null
    },

    async listEmbeddings(chapterId) {
      const out: LineEmbeddingRecord[] = []
      for (const [lineId, r] of embeddings) {
        const rec = lines.get(lineId)
        if (!rec || rec.line.chapterId !== chapterId) continue
        out.push({ ...r, vector: Float32Array.from(r.vector) })
      }
      return out
    },

    async deleteEmbedding(lineId) {
      embeddings.delete(lineId)
    },

    async createSnapshot(input) {
      const snapshot: CanvasSnapshot = {
        id: input.id ?? nextId('snap'),
        chapterId: input.chapterId,
        label: input.label ?? null,
        reason: input.reason ?? 'manual',
        payload: [...lines.values()]
          .filter((r) => r.deletedAt == null && r.line.chapterId === input.chapterId)
          .map((r) => cloneLine(r.line))
          .sort((a, b) => a.seq - b.seq),
        createdAt: input.now ?? now(),
      }
      snapshots.set(snapshot.id, snapshot)
      return { ...snapshot, payload: snapshot.payload.map(cloneLine) }
    },

    async listSnapshots(chapterId) {
      return [...snapshots.values()]
        .filter((s) => s.chapterId === chapterId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => ({ ...s, payload: s.payload.map(cloneLine) }))
    },

    async getSnapshot(snapshotId) {
      const s = snapshots.get(snapshotId)
      return s ? { ...s, payload: s.payload.map(cloneLine) } : null
    },
  }
}

/** 深拷贝一行（避开 Float32Array/引用共享带来的「改了仓储里的数据」这类隐蔽 bug） */
function cloneLine(line: CanvasLine): CanvasLine {
  return {
    ...line,
    candidates: line.candidates ? line.candidates.map((c) => ({ ...c })) : null,
    pauseInline: line.pauseInline ? [...line.pauseInline] : null,
    flags: [...line.flags],
  }
}

/** 供上层判断「哪些字段由人工改过」（docs/11 §4.4：改过就自动置 decidedBy='human'） */
export function isHumanEditablePatch(patch: CanvasLinePatch): boolean {
  return HUMAN_EDITABLE_FIELDS.some((f) => f in patch)
}
