/**
 * Novel Studio · 项目包 / 任务包历史仓储（`packages`，接口 + 内存实现）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §8  `.nsp` 项目包格式（导入规则 1~5：版本校验、逐文件校验、ID 重映射、
 *                音频重写目录、解压防护）
 *   · docs/03 §9  `.nst` 任务包格式与**合并规则表**（linesHash 不一致 / 多 take / 缺漏 /
 *                未知 lineId / 音质异常）
 *   · docs/11 §6.2–§6.5 导出选项、`linesHash` 口径、回收报告（必须落到 UI）、增量下发
 *   · docs/21 §6  `packages` 表：`kind ∈ nsp|nst`、`direction ∈ export|import|merge`、
 *                `status ∈ pending|running|done|failed`，`manifest`/`stats`/`report` 三个 JSON 列
 *   · docs/20 §4  `package:*` 7 个通道的契约（`listHistory` 返回 `PackageHistoryEntry[]`）
 *
 * ### 这一张表为什么同时承载「导出 / 导入 / 合并」三件事
 *   `direction` 决定语义，行结构完全一样：
 *   · `export`：`.nsp`（kind=nsp）或 `.nst`（kind=nst）的导出记录；
 *   · `import`：`.nsp` 的导入记录（`file_path` 是**来源包**，新项目 id 记在 `stats` 里）；
 *   · `merge` ：`.nst` 回收合并记录（`report` 列就是 `TaskPackageMergeReport`）。
 *   分成三张表会让「这个包到底来过没有」变成三次查询，也会让 UI 的历史列表要合并三个来源。
 *
 * ### 为什么 JSON 列在这里是**解析后的对象**而不是字符串
 *   与 `export-job.repo.ts` 的 `warnings: string[]` 同一取舍：调用方（服务、UI）要的是
 *   结构而不是文本，序列化只属于 SQLite 实现那一层。这样内存实现与 SQLite 实现
 *   行为一致，测试可以在两者之间切换而不改断言。
 *
 * ### 为什么失败/进行中的行也要落库
 *   `status='failed'` 的行留着，用户才能在历史里看到「那次导出为什么没成功」；
 *   `pending`/`running` 的行则是崩溃后「有任务没收尾」的证据（docs/04 §2.2 的重启语义）。
 */

import { AppError } from '../../../../../shared/errors.ts'
import type {
  Id,
  PackageHistoryEntry,
  TaskPackageMergeReport,
  Timestamp,
} from '../../../../../shared/types.ts'

/** 与 DDL 的 CHECK 一致 */
export type PackageKind = 'nsp' | 'nst'
export type PackageDirection = 'export' | 'import' | 'merge'
export type PackageStatus = 'pending' | 'running' | 'done' | 'failed'

/** `stats` 列的形状：只放数字（docs/21 §6 的注释就是「行数/文件数/体积」） */
export type PackageStats = Record<string, number>

export interface PackageRow {
  id: Id
  projectId: Id
  kind: PackageKind
  direction: PackageDirection
  /** 任务包的收件配音员；项目包为 null */
  actorId: Id | null
  /** 任务包所属书籍；项目包为 null */
  bookId: Id | null
  /**
   * 绝对路径。
   * · export/merge：包文件本身；
   * · import    ：**来源包**的路径（导入产物在 `{projectRoot}/{新 projectId}/`）。
   */
  filePath: string
  /** `.nst` 的画本快照哈希（回收时比对，docs/03 §9） */
  linesHash: string | null
  /** 解析后的 manifest（`.nsp` → NspManifest；`.nst` → NstManifest） */
  manifest: unknown
  stats: PackageStats | null
  status: PackageStatus
  /** 解析后的回收报告（只有 direction='merge' 的行会有） */
  report: TaskPackageMergeReport | null
  createdAt: Timestamp
  finishedAt: Timestamp | null
}

/** 可改字段：新建行后只会改「状态/统计/报告/结束时间」 */
export interface PackagePatch {
  filePath?: string
  linesHash?: string | null
  manifest?: unknown
  stats?: PackageStats | null
  status?: PackageStatus
  report?: TaskPackageMergeReport | null
  finishedAt?: Timestamp | null
}

export interface PackageRepo {
  insert(row: PackageRow): Promise<PackageRow>
  update(id: Id, patch: PackagePatch): Promise<PackageRow>
  get(id: Id): Promise<PackageRow | null>
  /** 历史列表：按时间**倒序**（UI 直接展示，不再排序） */
  listByProject(projectId: Id, limit?: number): Promise<PackageRow[]>
  /**
   * 该项目最近一次带报告的合并（`package:lastMergeReport` 的唯一数据来源）。
   *
   * 为什么不复用 `listByProject` 再过滤：报告可能是几百行的大对象，
   * 而「上次合并」只需要一行 —— 让 SQL 去挑，别把整段历史读进内存。
   */
  lastMerge(projectId: Id): Promise<PackageRow | null>
}

/**
 * 行 → `PackageHistoryEntry`（契约的返回类型）。
 *
 * `actorName` 需要 `voice_actors`，仓储**不做 join**（它只认识 packages 表）；
 * 由服务层用注入的 `actorName()` 补上。内存实现因此不需要造假的演员名。
 */
export function toHistoryEntry(row: PackageRow, actorName: string | null): PackageHistoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    direction: row.direction,
    actorId: row.actorId,
    actorName,
    filePath: row.filePath,
    linesHash: row.linesHash,
    stats: row.stats,
    report: row.report,
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------------------
// 内存实现（行为基准）
// ---------------------------------------------------------------------------

export function createMemoryPackageRepo(
  seed?: { rows?: PackageRow[]; now?: () => number },
): PackageRepo {
  const items = new Map<Id, PackageRow>()
  const now = seed?.now ?? (() => Date.now())
  for (const r of seed?.rows ?? []) items.set(r.id, cloneRow(r))

  /** 时间相同时按 id 兜底排序，保证「倒序」是全序（否则测试会偶发不稳定） */
  const byNewestFirst = (a: PackageRow, b: PackageRow): number =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

  return {
    async insert(row) {
      if (items.has(row.id)) {
        throw new AppError('CONFLICT', { details: { entity: 'package', id: row.id } })
      }
      const next = cloneRow({ ...row, createdAt: row.createdAt || now() })
      items.set(next.id, next)
      return cloneRow(next)
    },

    async update(id, patch) {
      const cur = items.get(id)
      if (!cur) throw new AppError('NOT_FOUND', { details: { entity: 'package', id } })
      const next: PackageRow = {
        ...cur,
        ...patch,
        // `manifest`/`stats`/`report` 允许显式置 null（例如把失败行的报告清掉）
        manifest: patch.manifest !== undefined ? patch.manifest : cur.manifest,
        stats: patch.stats !== undefined ? patch.stats : cur.stats,
        report: patch.report !== undefined ? patch.report : cur.report,
        linesHash: patch.linesHash !== undefined ? patch.linesHash : cur.linesHash,
        finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
      }
      items.set(id, next)
      return cloneRow(next)
    },

    async get(id) {
      const row = items.get(id)
      return row ? cloneRow(row) : null
    },

    async listByProject(projectId, limit) {
      return [...items.values()]
        .filter((r) => r.projectId === projectId)
        .sort(byNewestFirst)
        .slice(0, Math.max(1, Math.floor(limit ?? 200)))
        .map(cloneRow)
    },

    async lastMerge(projectId) {
      const found = [...items.values()]
        .filter((r) => r.projectId === projectId && r.direction === 'merge' && r.report !== null)
        .sort(byNewestFirst)[0]
      return found ? cloneRow(found) : null
    },
  }
}

/** 深拷贝：内存实现必须交出快照，否则调用方改一下就把「库里的行」改了 */
function cloneRow(r: PackageRow): PackageRow {
  return {
    ...r,
    manifest: r.manifest === null ? null : structuredCloneSafe(r.manifest),
    stats: r.stats ? { ...r.stats } : null,
    report: r.report ? { ...r.report, missing: [...r.report.missing], unknown: [...r.report.unknown] } : null,
  }
}

/**
 * `manifest` 是任意 JSON。
 * 用 `structuredClone` 会拒绝函数/Proxy（导入的 manifest 里不该有，但一旦有就是
 * 一个莫名其妙的 DataCloneError）；退化成 JSON 往返更宽容，也仍然与 SQLite 的行为一致
 * —— SQLite 那条路径本来就是 JSON 往返。
 */
function structuredCloneSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return value
  }
}
