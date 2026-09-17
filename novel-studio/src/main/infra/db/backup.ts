/**
 * 基础设施 · 备份与恢复
 * ============================================================================
 * 设计依据：docs/21 §15「备份与恢复（SQL）」、docs/03 §7.2 / §10
 *
 * ```sql
 * VACUUM INTO '/path/to/backups/...db';   -- 比复制文件安全：不受 WAL 状态影响
 * PRAGMA integrity_check;                 -- 期望 'ok'
 * PRAGMA foreign_key_check;               -- 期望 0 行
 * PRAGMA wal_checkpoint(TRUNCATE);        -- 变更前快速备份
 * ```
 *
 * **恢复失败的头号原因是旧 WAL 混合**（docs/21 §15 步骤 3）：把备份文件复制到主库位置后，
 * 若旧的 `-wal`/`-shm` 还在，SQLite 会把旧 WAL 里的页重放到新库上 → 直接损坏。
 * 因此恢复流程里删除 `-wal`/`-shm` 是**强制步骤**，不是优化。
 */

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AppError, formatBytes, wrapUnknown } from '../../../shared/errors.ts'
import { atomicWriteFile, sha256Hex } from '../fs/atomic.ts'
import { tx } from './tx.ts'
import { sqlStringLiteral, type DbLike } from './types.ts'

export interface BackupResult {
  path: string
  sizeBytes: number
  schemaVersion: number
  durationMs: number
}

export interface BackupDatabaseOptions {
  /** 备份原因，写入 backups 表（'auto' | 'manual' | 'pre_migrate' | 'pre_restore'） */
  reason?: 'auto' | 'manual' | 'pre_migrate' | 'pre_restore'
  /** 目标目录（不存在会自动创建）。给了 dir 就自动生成文件名。 */
  dir?: string
  now?: () => number
}

/**
 * 备份数据库到 `destPath`。
 *
 * 用 `VACUUM INTO`（docs/21 §15）：它在一个只读事务快照上导出，**不受 WAL 状态影响**，
 * 而直接复制 `.db` 文件会漏掉还在 WAL 里的事务（得到一个「丢了最近修改」的库）。
 */
export async function backupDatabase(db: DbLike, destPath: string, opts?: BackupDatabaseOptions): Promise<BackupResult> {
  const now = opts?.now ?? Date.now
  const started = now()
  const target = opts?.dir ? join(opts.dir, destPath) : destPath
  try {
    await fsp.mkdir(dirname(target), { recursive: true })
    // VACUUM INTO 要求目标文件不存在（否则报错），先清掉半成品
    await fsp.rm(target, { force: true })
    // 注意：VACUUM 不能在事务里执行
    db.exec(`VACUUM INTO ${sqlStringLiteral(target)};`)
  } catch (e) {
    throw new AppError('DB_BACKUP_FAILED', { cause: e, details: { destPath: target } })
  }

  let sizeBytes = 0
  try {
    sizeBytes = (await fsp.stat(target)).size
  } catch {
    throw new AppError('DB_BACKUP_FAILED', { cause: null, details: { destPath: target, reason: 'backup-file-missing' } })
  }
  const schemaVersion = readSchemaVersion(db)
  // 记一笔（backups 表是 docs/21 §10 的一部分；表不存在时忽略，不影响备份本身）
  try {
    db.prepare(
      'INSERT INTO backups(id, file_path, size_bytes, schema_version, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(randomId(), target, sizeBytes, schemaVersion, opts?.reason ?? 'manual', now())
  } catch {
    /* 全新库还没跑迁移（没有 backups 表）→ 允许 */
  }
  return { path: target, sizeBytes, schemaVersion, durationMs: now() - started }
}

/** 备份文件名（docs/03 §2：`novel-studio-2026-02-14T03-00-00.db`） */
export function backupFileName(now: Date, prefix = 'novel-studio'): string {
  const iso = now.toISOString().replace(/[:.]/g, '-').replace('Z', '')
  return `${prefix}-${iso}.db`
}

/** 迁移前备份文件名：`pre-migrate-{from}-{to}-{ts}.db`（docs/03 §7.2） */
export function preMigrateBackupFileName(from: number, to: number, now = new Date()): string {
  return backupFileName(now, `pre-migrate-${from}-${to}`)
}

export interface RestoreOptions {
  /** 主库路径（`{userData}/novel-studio.db`） */
  dbPath: string
  /** 备份文件路径 */
  backupPath: string
  /**
   * 关闭当前连接（**必须**提供：带着打开的连接替换数据库文件会立刻损坏）。
   * 生产实现：db.close()。
   */
  closeDatabase: () => void | Promise<void>
  /** 恢复后重新打开并校验（可选；提供则执行 integrity_check） */
  reopenAndCheck?: (dbPath: string) => Promise<{ ok: boolean; errors: string[] }>
  now?: () => number
  fs?: RestoreFsPort
}

export interface RestoreFsPort {
  copyFile(from: string, to: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, opts: { force?: boolean }): Promise<void>
  stat(path: string): Promise<{ size: number }>
  mkdir(path: string, opts: { recursive?: boolean }): Promise<unknown>
}

const defaultRestoreFs: RestoreFsPort = {
  copyFile: (from, to) => fsp.copyFile(from, to),
  rename: (from, to) => fsp.rename(from, to),
  rm: (p, opts) => fsp.rm(p, opts).then(() => undefined),
  stat: async (p) => ({ size: (await fsp.stat(p)).size }),
  mkdir: (p, opts) => fsp.mkdir(p, opts),
}

export interface RestoreResult {
  restored: boolean
  /** 当前库改名后的保留副本（失败时用它回退） */
  keptCurrentPath: string | null
  removedWalFiles: string[]
  integrity: { ok: boolean; errors: string[] } | null
}

/**
 * 从备份恢复数据库（docs/21 §15 恢复流程）。
 *
 * 步骤（**顺序不可调换**）：
 *   1. 关闭数据库（结束所有任务与队列）
 *   2. 当前库改名保留 `novel-studio.db.pre-restore-{ts}`
 *   3. 复制备份到主库位置；**同时删除同名 `-wal`/`-shm`**
 *   4. 打开连接 → integrity_check → foreign_key_check
 *   5. 失败 → 自动回退到步骤 2 保留的库
 */
export async function restoreDatabase(opts: RestoreOptions): Promise<RestoreResult> {
  const fs = opts.fs ?? defaultRestoreFs
  const now = opts.now ?? Date.now
  const dbPath = opts.dbPath
  const walFiles = [`${dbPath}-wal`, `${dbPath}-shm`]

  if (!opts.closeDatabase) {
    throw new AppError('DB_RESTORE_FAILED', {
      details: { reason: 'missing-closeDatabase', hint: '恢复前必须关闭数据库连接（docs/21 §15 步骤 1）' },
    })
  }
  try {
    await fs.stat(opts.backupPath)
  } catch (e) {
    throw new AppError('DB_RESTORE_FAILED', { cause: e, details: { backupPath: opts.backupPath, reason: 'backup-missing' } })
  }

  // 1) 关闭连接
  try {
    await opts.closeDatabase()
  } catch (e) {
    throw new AppError('DB_RESTORE_FAILED', { cause: e, details: { reason: 'close-failed' } })
  }

  // 2) 保留当前库
  const keptCurrentPath = `${dbPath}.pre-restore-${now()}`
  let keptCurrent = false
  try {
    await fs.rename(dbPath, keptCurrentPath)
    keptCurrent = true
  } catch {
    // 当前库不存在（首次恢复）→ 无需保留
    keptCurrent = false
  }

  // 3) 复制备份 + 删除旧 WAL/SHM（头号损坏原因）
  const removedWalFiles: string[] = []
  try {
    for (const wal of walFiles) {
      try {
        await fs.rm(wal, { force: true })
        removedWalFiles.push(wal)
      } catch {
        /* 不存在即已达成目标 */
      }
    }
    await fs.mkdir(dirname(dbPath), { recursive: true })
    await fs.copyFile(opts.backupPath, dbPath)
  } catch (e) {
    // 复制失败 → 回退
    if (keptCurrent) {
      try {
        await fs.rm(dbPath, { force: true })
        await fs.rename(keptCurrentPath, dbPath)
      } catch {
        /* 回退也失败：把原始错误抛出去，让用户从保留副本手工恢复 */
      }
    }
    throw new AppError('DB_RESTORE_FAILED', { cause: e, details: { reason: 'copy-failed', backupPath: opts.backupPath } })
  }

  // 4) 校验
  let integrity: RestoreResult['integrity'] = null
  if (opts.reopenAndCheck) {
    try {
      integrity = await opts.reopenAndCheck(dbPath)
    } catch (e) {
      integrity = { ok: false, errors: [String(e)] }
    }
    if (!integrity.ok) {
      // 5) 自动回退
      if (keptCurrent) {
        try {
          await fs.rm(dbPath, { force: true })
          await fs.rename(keptCurrentPath, dbPath)
          for (const wal of walFiles) await fs.rm(wal, { force: true }).catch(() => undefined)
        } catch (e) {
          throw new AppError('DB_RESTORE_FAILED', {
            cause: e,
            details: { reason: 'rollback-failed', keptCurrentPath, errors: integrity.errors },
          })
        }
      }
      throw new AppError('DB_RESTORE_FAILED', {
        details: { reason: 'integrity-check-failed', errors: integrity.errors, rolledBack: keptCurrent },
      })
    }
  }

  return { restored: true, keptCurrentPath: keptCurrent ? keptCurrentPath : null, removedWalFiles, integrity }
}

export interface IntegrityResult {
  ok: boolean
  errors: string[]
  /** foreign_key_check 的违规行数（0 = 干净） */
  foreignKeyViolations: number
  checkedAt: number
}

/**
 * `PRAGMA integrity_check` + `PRAGMA foreign_key_check`（docs/21 §15）。
 * 启动顺序里位于「打开数据库 → 迁移」之后（docs/01 §10 第 4 步）。
 */
export function integrityCheck(db: DbLike, now = Date.now()): IntegrityResult {
  const errors: string[] = []
  try {
    const rows = readPragmaRows(db, 'integrity_check') as Array<Record<string, unknown>>
    for (const row of rows) {
      const v = String(Object.values(row)[0] ?? '')
      if (v !== '' && v.toLowerCase() !== 'ok') errors.push(v)
    }
  } catch (e) {
    throw new AppError('DB_CORRUPT', { cause: e, details: { reason: 'integrity_check-failed' } })
  }

  let fkViolations = 0
  try {
    const fkRows = readPragmaRows(db, 'foreign_key_check')
    fkViolations = Array.isArray(fkRows) ? fkRows.length : 0
    if (fkViolations > 0) errors.push(`foreign_key_check 发现 ${fkViolations} 行违规`)
  } catch (e) {
    errors.push(`foreign_key_check 执行失败：${String(e)}`)
  }

  return { ok: errors.length === 0, errors, foreignKeyViolations: fkViolations, checkedAt: now }
}

/** 把 PRAGMA 查询结果统一成行数组（兼容 better-sqlite3 的 pragma() 与 prepare()） */
function readPragmaRows(db: DbLike, name: string): unknown {
  if (typeof db.pragma === 'function') {
    const res = db.pragma(name)
    if (Array.isArray(res)) return res
    if (res && typeof res === 'object') return [res]
    return [{ [name]: res }]
  }
  return db.prepare(`PRAGMA ${name}`).all()
}

/**
 * 快速备份（不需要完整 VACUUM）：`PRAGMA wal_checkpoint(TRUNCATE)`。
 * 用于「变更前怕丢」但不想花时间做整库备份的场景（docs/21 §15）。
 */
export function quickCheckpoint(db: DbLike): void {
  try {
    readPragmaRows(db, 'wal_checkpoint(TRUNCATE)')
  } catch (e) {
    throw new AppError('DB_BACKUP_FAILED', { cause: e, details: { reason: 'wal-checkpoint-failed' } })
  }
}

/** 数据库统计（`db:stats` 通道用） */
export interface DbStatsResult {
  sizeBytes: number
  schemaVersion: number
  tables: Array<{ name: string; rows: number }>
}

export function dbStats(db: DbLike, sizeBytes: number): DbStatsResult {
  const schemaVersion = readSchemaVersion(db)
  const tables: Array<{ name: string; rows: number }> = []
  let names: string[] = []
  try {
    names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>).map((r) => r.name)
  } catch (e) {
    throw new AppError('DB_CORRUPT', { cause: e, details: { reason: 'sqlite_master-unreadable' } })
  }
  for (const name of names) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n?: number } | undefined
      tables.push({ name, rows: Number(row?.n ?? 0) })
    } catch {
      tables.push({ name, rows: -1 }) // -1 = 无法统计（虚拟表等），不假装是 0
    }
  }
  return { sizeBytes, schemaVersion, tables }
}

function readSchemaVersion(db: DbLike): number {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: unknown } | undefined
    const n = Number(row?.value ?? 0)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 一致性写入 + 原子落盘（诊断包/清单小文件用） */
export async function writeJsonAtomic(path: string, data: unknown): Promise<{ path: string; bytes: number; sha256: string }> {
  const text = `${JSON.stringify(data, null, 2)}\n`
  try {
    const res = await atomicWriteFile(path, text)
    return { path: res.path, bytes: res.bytes, sha256: sha256Hex(text) }
  } catch (e) {
    throw wrapUnknown(e)
  }
}

/** 短随机 ID（避免引入 nanoid 依赖；用于 backups.id 这类非业务主键） */
function randomId(): string {
  return sha256Hex(`${Date.now()}-${Math.random()}`).slice(0, 16)
}

/** 备份目录下的已有备份清单（`db:listBackups` 通道用） */
export async function listBackupFiles(backupDir: string): Promise<Array<{ filePath: string; name: string; sizeBytes: number }>> {
  try {
    const entries = await fsp.readdir(backupDir, { withFileTypes: true })
    const out: Array<{ filePath: string; name: string; sizeBytes: number }> = []
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.db')) continue
      const full = join(backupDir, e.name)
      try {
        const st = await fsp.stat(full)
        out.push({ filePath: full, name: basename(full), sizeBytes: st.size })
      } catch {
        /* 读不到就跳过（竞态删除） */
      }
    }
    return out.sort((a, b) => b.name.localeCompare(a.name))
  } catch (e) {
    throw new AppError('DB_BACKUP_FAILED', { cause: e, details: { backupDir } })
  }
}

/** 可读的备份体积（进日志） */
export function describeBackup(r: BackupResult): string {
  return `${basename(r.path)} (${formatBytes(r.sizeBytes)}, schema v${r.schemaVersion}, ${r.durationMs}ms)`
}

/** 在事务里批量登记备份记录（多备份清理时保持一致性） */
export function pruneBackupRecords(db: DbLike, keep: number): number {
  try {
    const rows = db.prepare('SELECT id FROM backups ORDER BY created_at DESC LIMIT -1 OFFSET ?').all(keep) as Array<{ id: string }>
    if (rows.length === 0) return 0
    tx(db, () => {
      const del = db.prepare('DELETE FROM backups WHERE id = ?')
      for (const r of rows) del.run(r.id)
    })
    return rows.length
  } catch {
    return 0
  }
}
