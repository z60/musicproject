/**
 * 启动编排 · 过期临时文件与缓存清理（docs/04 §3 启动清理规则）
 * ============================================================================
 * 设计依据：
 *   · docs/04 §3「启动清理规则（严格顺序）」：
 *       1. 先跑**崩溃恢复**（修复 .tmp/*.wav 并入库），这些文件**不能**被当垃圾删
 *       2. 再清理「超过 24 小时且不在恢复清单内」的 .tmp 内容
 *       3. 再清理缓存（按 TTL）
 *   · docs/01 §10「5 必须在 6 之前」（顺序由 app-lifecycle.ts 保证）
 *
 * 三道保护（**缺一不可**，任何一道失效都可能删掉用户两小时的录音）：
 *   1. **恢复清单白名单**：`recovery.manifest` 里的路径永不删
 *   2. **用户素材目录保护**：`recordings/ takes/ segments/ processed/ music/ exports/ packages/`
 *      下的任何文件都不删（`isUserAssetPath`）
 *   3. **受保护根**：项目根、模型目录、数据库（含 -wal/-shm）永不删（`isProtectedPath`）
 * 另外：只删除「最后修改时间早于 24 小时」的文件 —— 正在写入的文件不会被动到。
 */

import { promises as fsp } from 'node:fs'
import { join, normalize, resolve } from 'node:path'

import { isProtectedPath, isUserAssetPath } from '../infra/fs/index.ts'
import { pruneOldLogs } from '../infra/log/index.ts'

/** 默认保护窗口：24 小时（docs/04 §3 规则 2） */
export const DEFAULT_TEMP_MAX_AGE_MS = 24 * 3600 * 1000
/** 缓存 TTL：转码中间产物 3 天（docs/04 §4） */
export const DEFAULT_CACHE_TTL_MS = 3 * 24 * 3600 * 1000

export interface CleanupDeps {
  /** 要清理的临时目录根（如 userData 下的 cache/tmp、各项目目录的 .tmp、任务临时根） */
  dirs: readonly string[]
  log: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
    error: (event: string, fields: Record<string, unknown>) => void
  }
  /** 项目根（`{userData}/projects`），用于用户素材判定 */
  projectRoot?: string
  modelDir?: string
  dbPath?: string
  userDataDir?: string
  /** 恢复清单：这些路径**绝不删除**（docs/04 §3 规则 1） */
  protectedPaths?: readonly string[]
  /** 过期阈值（默认 24h） */
  maxAgeMs?: number
  now?: () => number
  /** 只报告不删除（预演；启动自检与测试用） */
  dryRun?: boolean
  /** 递归深度上限（防符号链接环） */
  maxDepth?: number
}

export interface CleanupReport {
  scannedDirs: number
  scannedFiles: number
  deletedFiles: number
  /** 因「在恢复清单内」而跳过 */
  skippedProtected: number
  /** 因「属于用户素材目录」而跳过 */
  skippedUserAssets: number
  /** 因「还不够旧」而跳过 */
  skippedFresh: number
  /** 删除失败（多半是被占用） */
  failed: number
  freedBytes: number
  warnings: string[]
  elapsedMs: number
  dryRun: boolean
}

/**
 * 清理过期临时文件（docs/04 §3 规则 2）。
 *
 * **调用时机**：必须在 `recoverRecordings()` 之后（docs/01 §10：5 在 6 之前）。
 * 函数内部也会再次校验恢复清单，形成双保险。
 */
export async function cleanupStaleTemps(deps: CleanupDeps): Promise<CleanupReport> {
  const started = deps.now ? deps.now() : Date.now()
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS
  const dryRun = deps.dryRun === true
  const protectedSet = new Set((deps.protectedPaths ?? []).map((p) => normalize(resolve(p)).toLowerCase()))
  const report: CleanupReport = {
    scannedDirs: 0,
    scannedFiles: 0,
    deletedFiles: 0,
    skippedProtected: 0,
    skippedUserAssets: 0,
    skippedFresh: 0,
    failed: 0,
    freedBytes: 0,
    warnings: [],
    elapsedMs: 0,
    dryRun,
  }

  const now = started
  const maxDepth = deps.maxDepth ?? 6

  for (const dir of deps.dirs) {
    if (!dir) continue
    // 目标目录本身也不能是受保护根（否则「清理 cache 目录」会误伤）
    if (dir === deps.userDataDir || dir === deps.projectRoot) {
      report.warnings.push(`跳过受保护目录：${dir}`)
      continue
    }
    report.scannedDirs++
    await walk(dir, 0)
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true }) as never
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ENOENT') report.warnings.push(`读取目录失败：${dir}（${code ?? String(e)}）`)
      return
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue // 不跟随符号链接（防越界删除）
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      report.scannedFiles++

      // ── 保护 1：恢复清单 ────────────────────────────────────────────────
      if (protectedSet.has(normalize(resolve(full)).toLowerCase())) {
        report.skippedProtected++
        continue
      }
      // ── 保护 2：用户素材目录 ────────────────────────────────────────────
      if (deps.projectRoot && isUserAssetPath(full, deps.projectRoot)) {
        report.skippedUserAssets++
        continue
      }
      // ── 保护 3：受保护根（项目根/模型目录/数据库）────────────────────────
      if (
        isProtectedPath(full, {
          projectRoot: deps.projectRoot,
          modelDir: deps.modelDir,
          dbPath: deps.dbPath,
          userDataDir: deps.userDataDir,
        })
      ) {
        report.skippedProtected++
        continue
      }

      let size = 0
      let mtimeMs = 0
      try {
        const st = await fsp.stat(full)
        size = st.size
        mtimeMs = st.mtimeMs
      } catch {
        continue
      }
      if (now - mtimeMs < maxAgeMs) {
        report.skippedFresh++
        continue
      }

      if (dryRun) {
        report.deletedFiles++
        report.freedBytes += size
        continue
      }
      try {
        await fsp.rm(full, { force: true })
        report.deletedFiles++
        report.freedBytes += size
      } catch (e) {
        report.failed++
        report.warnings.push(`删除失败：${full}（${String(e)}）`)
      }
    }
  }

  report.elapsedMs = (deps.now ? deps.now() : Date.now()) - started
  deps.log.info('cleanup.temps.done', {
    event: 'cleanup.temps.done',
    scannedDirs: report.scannedDirs,
    deleted: report.deletedFiles,
    skippedProtected: report.skippedProtected,
    skippedUserAssets: report.skippedUserAssets,
    skippedFresh: report.skippedFresh,
    failed: report.failed,
    freedBytes: report.freedBytes,
    dryRun,
  })
  if (report.failed > 0) {
    // 部分文件被占用是正常现象（下次启动会再试），用 TEMP_CLEANUP_PARTIAL 语义键提示
    deps.log.warn('cleanup.temps.partial', { event: 'cleanup.temps.partial', count: report.failed })
  }
  return report
}

export interface CacheCleanupDeps extends CleanupDeps {
  /** 缓存目录与各自 TTL */
  caches: ReadonlyArray<{ dir: string; ttlMs?: number }>
  /** 日志目录（顺带按保留期清理，docs/04 §5.1：保留 14 天） */
  logDir?: string
  logRetentionDays?: number
}

/** 清理缓存（docs/04 §3 规则 3、§4 各缓存的 TTL） */
export async function cleanupCaches(deps: CacheCleanupDeps): Promise<CleanupReport> {
  const merged: CleanupReport = {
    scannedDirs: 0,
    scannedFiles: 0,
    deletedFiles: 0,
    skippedProtected: 0,
    skippedUserAssets: 0,
    skippedFresh: 0,
    failed: 0,
    freedBytes: 0,
    warnings: [],
    elapsedMs: 0,
    dryRun: deps.dryRun === true,
  }
  const now = deps.now ? deps.now() : Date.now()
  for (const cache of deps.caches) {
    const report = await cleanupStaleTemps({
      ...deps,
      dirs: [cache.dir],
      maxAgeMs: cache.ttlMs ?? DEFAULT_CACHE_TTL_MS,
    })
    merged.scannedDirs += report.scannedDirs
    merged.scannedFiles += report.scannedFiles
    merged.deletedFiles += report.deletedFiles
    merged.skippedProtected += report.skippedProtected
    merged.skippedUserAssets += report.skippedUserAssets
    merged.skippedFresh += report.skippedFresh
    merged.failed += report.failed
    merged.freedBytes += report.freedBytes
    merged.warnings.push(...report.warnings)
    merged.elapsedMs += report.elapsedMs
  }
  if (deps.logDir && deps.dryRun !== true) {
    const removed = pruneOldLogs(deps.logDir, deps.logRetentionDays ?? 14, now)
    if (removed > 0) {
      merged.deletedFiles += removed
      deps.log.info('cleanup.logs.pruned', { event: 'cleanup.logs.pruned', removed })
    }
  }
  return merged
}

/**
 * 组装默认清理目标（生产装配用）。
 * 顺序：项目临时目录 → 全局缓存临时 → 任务临时根。
 */
export function defaultCleanupTargets(opts: {
  userDataDir: string
  projectRoot: string
  projectIds?: readonly string[]
}): string[] {
  const targets: string[] = [join(opts.userDataDir, 'cache', 'tmp')]
  for (const id of opts.projectIds ?? []) targets.push(join(opts.projectRoot, id, '.tmp'))
  return targets
}
