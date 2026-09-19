/**
 * Novel Studio · 项目包 / 任务包领域服务（`package:*` 7 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/20 §4   `package:*` 7 个通道的契约（返回 `{taskId}` 的都是长任务）
 *   · docs/03 §8   `.nsp` 项目包（manifest 字段、导入规则）
 *   · docs/03 §9   `.nst` 任务包（task.json、回传包变体、合并规则表）
 *   · docs/11 §6.2–§6.5（导出选项、回收报告、增量下发）
 *   · docs/21 §6   `packages` 表（历史列表与「上次合并报告」的数据来源）
 *
 * ### 分工：服务管「能不能做」，任务管「怎么做」
 *   本层的三件事：
 *     1. **跨字段校验**（项目/书籍/配音员是否存在、配音员是否属于该书项目、有没有可下发的角色、
 *        包文件是否存在、`contents` / `recordSettings` 结构是否合法）—— 这些必须在
 *        **入队之前**就报错：任务失败与「点了没反应」在 UI 上是两种完全不同的体验，
 *        而入队后才失败的校验要等调度器跑到才知道；
 *     2. **入队**（真正的导出 / 导入 / 合并在 `package.tasks.ts`）；
 *     3. **两个同步查询**：`inspect`（只读 manifest，不解压全部）与历史列表。
 *
 * ### `inspect` 为什么在这里而不是任务里
 *   它是「读 manifest 给用户看」的一次性轻动作（几百毫秒），做成任务会让用户为了看
 *   一个包的摘要还得去任务中心等结果。因此它走同步路径，但仍受 zip 防护约束
 *   （`openZip` + 条目配额），并且**不解压音频**。
 *
 * ### 错误码纪律（docs/22 §5）
 *   只使用 `src/shared/messages.ts` 里已存在的 key：
 *   `NOT_FOUND` / `INVALID_PAYLOAD` / `FILE_NOT_FOUND` / `PACKAGE_INVALID` /
 *   `PACKAGE_VERSION_TOO_NEW` / `TASK_QUEUE_UNAVAILABLE` / `DB_NOT_OPEN` / `CONFLICT`。
 *   不新造 key —— 新 key 在 UI 上没有文案，用户只会看到一个代号。
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { statSync } from 'node:fs'

import { AppError } from '../../../../shared/errors.ts'
import type {
  Id,
  NspManifest,
  NstManifest,
  PackageHistoryEntry,
  TaskPackageMergeReport,
} from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import {
  CHECKSUMS_FILE,
  MANIFEST_FILE,
  NSP_CONTENT_LABELS,
  NSP_CONTENT_PRESETS,
  TASK_FILE,
  parseManifestJson,
  peekFormatVersion,
} from './manifest.ts'
import { listSlotEntries } from './nst.ts'
import { openZip } from './zip/reader.ts'
import { toHistoryEntry, type PackageRepo } from './repositories/package.repo.ts'
import { resolveNspContents, type PackageTaskLog, type PackageTasks } from './package.tasks.ts'

export interface PackageServiceDeps {
  getDb: () => DbLike | null
  repo: () => PackageRepo
  /** 任务集：真正的导出 / 导入 / 合并都在里面 */
  tasks: PackageTasks
  /** 配音员姓名（历史列表的 `actorName`）；查不到给 null，**不编一个假名字** */
  actorName: (actorId: Id) => string | null
  log: PackageTaskLog
}

export interface PackageInspectResult {
  kind: 'nsp' | 'nst'
  formatVersion: number
  summary: string
}

export interface PackageService {
  exportProject(projectId: Id, options: Record<string, unknown>): Promise<{ taskId: Id }>
  importProject(path: string, options: Record<string, unknown>): Promise<{ taskId: Id }>
  exportTask(bookId: Id, actorId: Id, options: Record<string, unknown>): Promise<{ taskId: Id }>
  mergeTask(projectId: Id, path: string): Promise<{ taskId: Id }>
  inspect(path: string): Promise<PackageInspectResult>
  listHistory(projectId: Id): Promise<PackageHistoryEntry[]>
  lastMergeReport(projectId: Id): Promise<TaskPackageMergeReport | null>
}

export function createPackageService(deps: PackageServiceDeps): PackageService {
  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'package' } })
    return db
  }

  /** 项目必须存在且未删除（写错 id 与已删项目是两种不同的错误，但用户要做的都是「选另一个项目」） */
  function requireProject(projectId: Id): void {
    const row = requireDb().prepare(`SELECT id, deleted_at FROM projects WHERE id = ?`).get(projectId) as
      | { id: string; deleted_at: number | null }
      | undefined
    if (!row || row.deleted_at !== null) {
      throw new AppError('NOT_FOUND', { details: { entity: 'project', id: projectId } })
    }
  }

  function requireBook(bookId: Id): { id: string; project_id: string; title: string } {
    const row = requireDb()
      .prepare(`SELECT id, project_id, title FROM books WHERE id = ? AND deleted_at IS NULL`)
      .get(bookId) as { id: string; project_id: string; title: string } | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'book', id: bookId } })
    return row
  }

  // -------------------------------------------------------------------------
  // 入队
  // -------------------------------------------------------------------------

  async function exportProject(projectId: Id, options: Record<string, unknown>): Promise<{ taskId: Id }> {
    requireProject(projectId)
    // 提前校验选项：`contents` 写错的时候用户应该立刻看到「选项不对」，
    // 而不是等任务跑起来再失败（还会在历史里留一条失败行）
    const contents = resolveNspContents(options.contents)
    const enabled = (Object.keys(NSP_CONTENT_LABELS) as Array<keyof typeof NSP_CONTENT_LABELS>).filter(
      (k) => contents[k],
    )
    deps.log.info('package.exportProjectRequested', {
      event: 'package.exportProjectRequested',
      projectId,
      contents: enabled.join(','),
    })
    return deps.tasks.enqueueExportProject(projectId, options)
  }

  async function importProject(path: string, options: Record<string, unknown>): Promise<{ taskId: Id }> {
    // 文件存在性交给任务层统一判定（`FILE_NOT_FOUND`），这里只做「参数本身是否可用」的检查
    if (typeof path !== 'string' || path.trim() === '') {
      throw new AppError('INVALID_PAYLOAD', { details: { field: 'path', expected: 'non-empty string' } })
    }
    return deps.tasks.enqueueImportProject(path, options)
  }

  async function exportTask(bookId: Id, actorId: Id, options: Record<string, unknown>): Promise<{ taskId: Id }> {
    const db = requireDb()
    const book = requireBook(bookId)
    const actor = db.prepare(`SELECT id, project_id FROM voice_actors WHERE id = ?`).get(actorId) as
      | { id: string; project_id: string }
      | undefined
    if (!actor) throw new AppError('NOT_FOUND', { details: { entity: 'voice_actor', id: actorId } })
    if (actor.project_id !== book.project_id) {
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          field: 'actorId',
          reason: 'actor-not-in-book-project',
          actorId,
          bookId,
          hint: '配音员属于别的项目，不能给这本书下发任务包',
        },
      })
    }
    // 没有显式指定角色时，配音员必须已经绑定至少一个角色：
    // 否则导出的会是一个「空任务包」，而用户会以为下发成功了（docs/11 §6.1）
    const requested = options.characterIds
    if (!Array.isArray(requested) || requested.length === 0) {
      const bound = db
        .prepare(`SELECT COUNT(*) AS n FROM character_voice_bindings WHERE actor_id = ?`)
        .get(actorId) as { n: number }
      if (bound.n === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            field: 'actorId',
            reason: 'actor-has-no-bound-character',
            actorId,
            bookId,
            hint: '先在角色面板把角色分配给该配音员，或在 options.characterIds 里指定角色',
          },
        })
      }
    }
    return deps.tasks.enqueueExportTask(bookId, actorId, options)
  }

  async function mergeTask(projectId: Id, path: string): Promise<{ taskId: Id }> {
    requireProject(projectId)
    if (typeof path !== 'string' || path.trim() === '') {
      throw new AppError('INVALID_PAYLOAD', { details: { field: 'path', expected: 'non-empty string' } })
    }
    return deps.tasks.enqueueMergeTask(projectId, path)
  }

  // -------------------------------------------------------------------------
  // inspect（只读 manifest，不解压音频）
  // -------------------------------------------------------------------------

  function requireFile(path: string): string {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new AppError('INVALID_PAYLOAD', { details: { field: 'path', expected: 'non-empty string' } })
    }
    const abs = resolve(path)
    let ok = false
    try {
      ok = statSync(abs).isFile()
    } catch {
      ok = false
    }
    if (!ok) throw new AppError('FILE_NOT_FOUND', { params: { path: abs }, details: { path: abs } })
    return abs
  }

  async function inspect(path: string): Promise<PackageInspectResult> {
    const abs = requireFile(path)
    // 读整份包只为拿 manifest：受 `openZip` 的条目配额保护，且不会解压音频条目
    const reader = openZip(await readFile(abs), { strict: false })
    try {
      if (reader.violations.some((v) => v.kind === 'zip64')) {
        throw new AppError('PACKAGE_INVALID', {
          details: {
            reason: 'zip64-unsupported',
            hint: '4 GiB 以上的包需要 ZIP64 支持（当前实现不支持）',
          },
        })
      }
      const hasManifest = reader.has(MANIFEST_FILE)
      const hasTask = reader.has(TASK_FILE)
      if (!hasManifest && !hasTask) {
        throw new AppError('PACKAGE_INVALID', {
          details: {
            reason: 'manifest-missing',
            expected: [MANIFEST_FILE, TASK_FILE],
            entries: reader.listEntries().length,
          },
        })
      }
      const source = hasManifest ? MANIFEST_FILE : TASK_FILE
      const text = reader.readText(source)
      let raw: unknown
      try {
        raw = JSON.parse(text) as unknown
      } catch (e) {
        throw new AppError('PACKAGE_INVALID', {
          cause: e,
          details: { reason: 'json-parse-failed', path: source, chars: text.length },
        })
      }
      const peek = peekFormatVersion(raw)
      if (peek.format !== 'nsp' && peek.format !== 'nst') {
        throw new AppError('PACKAGE_INVALID', {
          details: { reason: 'format-mismatch', expected: ['nsp', 'nst'], actual: peek.format },
        })
      }
      // 用与导入/合并**同一条**校验路径：inspect 说「能读」而导入说「不能读」是最坏的组合
      const manifest = parseManifestJson(text, peek.format)
      const kind = peek.format
      const formatVersion = manifest.formatVersion
      if (kind === 'nsp') {
        return { kind, formatVersion, summary: summarizeNsp(manifest as NspManifest, reader) }
      }
      const nst = manifest as NstManifest
      const slots = listSlotEntries(reader)
      const returned = slots.entries.length
      return {
        kind,
        formatVersion,
        summary:
          `任务包 · 格式 v${formatVersion} · 配音员「${nst.assignee.name}」 · ` +
          `${nst.lines.length} 行 / ${nst.characters.length} 个角色 · ` +
          (returned > 0
            ? `**已回传 ${returned} 个音频槽位**（可回收合并）`
            : '尚无可回收的音频（下发状态）') +
          ` · linesHash ${shortHash(nst.linesHash)}`,
      }
    } finally {
      reader.close()
    }
  }

  function summarizeNsp(manifest: NspManifest, reader: ReturnType<typeof openZip>): string {
    const included = (Object.keys(NSP_CONTENT_LABELS) as Array<keyof typeof NSP_CONTENT_LABELS>)
      .filter((k) => manifest.contents[k])
      .map((k) => NSP_CONTENT_LABELS[k])
    const excluded = (Object.keys(NSP_CONTENT_LABELS) as Array<keyof typeof NSP_CONTENT_LABELS>)
      .filter((k) => !manifest.contents[k])
      .map((k) => NSP_CONTENT_LABELS[k])
    const isPreset = (name: 'full' | 'standard' | 'slim'): boolean =>
      (Object.keys(manifest.contents) as Array<keyof typeof manifest.contents>).every(
        (k) => manifest.contents[k] === NSP_CONTENT_PRESETS[name][k],
      )
    const preset = isPreset('full') ? '完整' : isPreset('standard') ? '标准' : isPreset('slim') ? '精简' : '自定义'
    return (
      `项目包 · 格式 v${manifest.formatVersion} · 项目「${manifest.project.name}」 · ` +
      `章节 ${manifest.counts.chapters} / 行 ${manifest.counts.lines} / 片段 ${manifest.counts.segments} · ` +
      `${manifest.files} 个文件 · 未压缩 ${formatBytes(manifest.uncompressedBytes)} · ` +
      `内容清单：${preset}（含 ${included.join('、') || '无'}；不含 ${excluded.join('、') || '无'}） · ` +
      `校验和文件：${reader.has(CHECKSUMS_FILE) ? '有' : '缺失'}`
    )
  }

  // -------------------------------------------------------------------------
  // 历史与上次合并报告
  // -------------------------------------------------------------------------

  async function listHistory(projectId: Id): Promise<PackageHistoryEntry[]> {
    requireProject(projectId)
    const rows = await deps.repo().listByProject(projectId)
    // actorName 由本层补：仓储只认识 packages 表，join voice_actors 是领域知识
    return rows.map((r) => toHistoryEntry(r, r.actorId === null ? null : deps.actorName(r.actorId)))
  }

  async function lastMergeReport(projectId: Id): Promise<TaskPackageMergeReport | null> {
    requireProject(projectId)
    const row = await deps.repo().lastMerge(projectId)
    return row?.report ?? null
  }

  return { exportProject, importProject, exportTask, mergeTask, inspect, listHistory, lastMergeReport }
}

function shortHash(hash: string): string {
  return hash.length > 8 ? `${hash.slice(0, 8)}…` : hash
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.max(0, bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = i === 0 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)
  return `${text} ${units[i]}`
}
