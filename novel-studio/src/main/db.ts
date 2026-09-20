/**
 * Novel Studio · 数据库打开、迁移与维护（启动顺序第 4~6 步）
 * ============================================================================
 * 设计依据：docs/01 §10 第 4/5/6 步、docs/03 §2、docs/21 §13「迁移纪律」、§15「备份与恢复」
 *
 * ### 为什么 better-sqlite3 用动态 import
 *   本仓库的测试与脚本在**没有原生模块**的环境里跑（纯 Node + 类型剥离）。
 *   静态 `import Database from 'better-sqlite3'` 会让任何 import 本模块的测试在加载期就炸。
 *   因此这里 `await import(...)`，且只在 Electron 主进程启动时执行。
 *   （同一条纪律见 src/main/infra/electron/index.ts 对 electron 的处理。）
 *
 * ### 迁移的三个硬约束（docs/21 §13）
 *   1. **跨 ≥2 个版本必须先备份**（没有备份就不敢改 schema）—— 备份失败即中止迁移
 *   2. **迁移失败进入只读模式**，绝不「改了一半然后继续跑」
 *   3. 迁移 SQL 的 sha256 写进 MIGRATIONS 表，改了老迁移会被 hash 校验拦下
 *
 *   这三条由 `infra/db/migrate.ts` 实现，本文件只负责按顺序调用并落日志。
 */

import { readdirSync, statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { AppError, isAppError } from '../shared/errors.ts'
import {
  applyPragmas,
  backupDatabase,
  backupFileName,
  currentSchemaVersion,
  dbStats,
  integrityCheck,
  latestSchemaVersion,
  listBackupFiles,
  loadMigrations,
  migrate,
  restoreDatabase,
  type ApplyPragmasResult,
  type DbLike,
  type IntegrityResult,
  type MigrateResult,
} from './infra/db/index.ts'
import type { Logger } from './infra/log/index.ts'

// ---------------------------------------------------------------------------
// 打开
// ---------------------------------------------------------------------------

export interface OpenDatabaseOptions {
  /** 主库绝对路径（`<dataRoot>/novel-studio.db`） */
  dbPath: string
  log: Logger
}

export interface OpenedDatabase {
  db: DbLike
  dbPath: string
  /** PRAGMA 应用结果（WAL 是否真的启用、哪些降级了，进诊断包） */
  pragmas: ApplyPragmasResult
}

/**
 * 打开数据库并应用 PRAGMA。
 *
 * @throws AppError('DB_OPEN_FAILED') 原生模块缺失或 ABI 不匹配 / 路径不可写 / 文件损坏
 *
 * ### 这里为什么要「先记日志再抛」
 *   抛出去的是 AppError，它的 `message` 是**给用户看的一句话标题**（「无法打开数据库」），
 *   而真正能定位问题的信息在 `cause` / `causeChain` 里（例如
 *   `NODE_MODULE_VERSION 115 ... requires 125` 这种原生模块 ABI 不匹配）。
 *
 *   上游 `runBootSequence` 只会把错误的 `name: message` 记进启动报告 ——
 *   于是 cause 链到不了日志。在**知道原始错误的地方**记一次 `errorFields`，
 *   是唯一能保证诊断信息不丢的做法（见 docs/91 §5.4 的真实事故）。
 */
export async function openDatabase(opts: OpenDatabaseOptions): Promise<OpenedDatabase> {
  try {
    await fsp.mkdir(dirname(opts.dbPath), { recursive: true })
  } catch (e) {
    throw logAndRethrow(
      new AppError('DB_OPEN_FAILED', {
        cause: e,
        details: { dbPath: opts.dbPath, reason: 'parent-dir-not-creatable' },
      }),
      opts.log,
    )
  }

  let DatabaseCtor: new (path: string) => DbLike
  try {
    const mod = (await import(/* @vite-ignore */ 'better-sqlite3')) as unknown as {
      default?: new (path: string) => DbLike
    }
    const ctor = mod.default ?? (mod as unknown as new (path: string) => DbLike)
    if (typeof ctor !== 'function') throw new Error('better-sqlite3 导出形态异常（没有可调用的构造函数）')
    DatabaseCtor = ctor
  } catch (e) {
    throw logAndRethrow(
      new AppError('DB_OPEN_FAILED', {
        cause: e,
        details: {
          dbPath: opts.dbPath,
          reason: 'native-module-unavailable',
          hint:
            'better-sqlite3 是原生模块，必须针对 Electron 的 ABI 重建：npm run rebuild。' +
            '若 Node 报 NODE_MODULE_VERSION 不一致，就是这个原因。',
        },
      }),
      opts.log,
    )
  }

  let db: DbLike
  try {
    db = new DatabaseCtor(opts.dbPath)
  } catch (e) {
    throw logAndRethrow(
      new AppError('DB_OPEN_FAILED', {
        cause: e,
        details: { dbPath: opts.dbPath, reason: 'constructor-threw' },
      }),
      opts.log,
    )
  }

  const pragmas = applyPragmas(db)
  opts.log.info('db.opened', {
    event: 'db.opened',
    dbPath: opts.dbPath,
    applied: pragmas.applied.length,
    degraded: pragmas.degraded.length,
    schemaVersion: currentSchemaVersion(db),
  })
  for (const d of pragmas.degraded.slice(0, 5)) {
    opts.log.warn('db.pragma.degraded', {
      event: 'db.pragma.degraded',
      statement: d.statement,
      expected: d.expected,
      actual: String(d.actual),
    })
  }
  return { db, dbPath: opts.dbPath, pragmas }
}

/**
 * 记下完整错误信息（含 causeChain / details / numericCode）后再抛出。
 *
 * 存在的唯一理由：**AppError.message 是给用户看的标题，不是诊断信息**。
 * 上游只会转发 `name: message`，所以只在抛出点记一次 log 才能保住 cause 链。
 * 返回 AppError 是为了让调用方写成 `throw logAndRethrow(err, log)` ——
 * 语法上强制「必须抛」，避免有人不小心吞掉它。
 */
function logAndRethrow(e: AppError, log: Logger): AppError {
  log.errorFields(e, 'db.open.failed', {
    code: e.key,
    numericCode: e.numericCode,
    ...(e.details ?? {}),
  })
  return e
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

export interface RunMigrationsResult {
  result: MigrateResult
  schemaVersion: number
  backedUp: boolean
}

/**
 * 执行迁移。跨版本时**先备份**（备份失败即中止 —— 没有备份不敢改 schema）。
 *
 * @throws AppError('DB_MIGRATION_FAILED')
 */
export async function runMigrations(opts: {
  db: DbLike
  backupDir: string
  log: Logger
}): Promise<RunMigrationsResult> {
  const migrations = loadMigrations()
  const target = latestSchemaVersion()
  let backedUp = false

  try {
    const result = await migrate(opts.db, migrations, {
      verifyHashes: true,
      maxVersion: target,
      backupBeforeMigrate: async (info) => {
        await fsp.mkdir(opts.backupDir, { recursive: true })
        const name = `pre-migrate-${info.from}-${info.to}-${backupFileName(new Date())}`
        const out = await backupDatabase(opts.db, name, { reason: 'pre_migrate', dir: opts.backupDir })
        backedUp = true
        opts.log.info('db.migrate.backup', {
          event: 'db.migrate.backup',
          from: info.from,
          to: info.to,
          versions: info.versions.length,
          path: out.path,
          sizeBytes: out.sizeBytes,
        })
      },
      log: (event, fields) => opts.log.info(event, fields),
    })
    const schemaVersion = currentSchemaVersion(opts.db)
    opts.log.info('db.migrated', {
      event: 'db.migrated',
      from: result.from,
      to: result.to,
      applied: result.applied,
      schemaVersion,
      backedUp,
    })
    return { result, schemaVersion, backedUp }
  } catch (e) {
    // **不要把内层诊断信息丢掉。**
    // 踩过的坑：这里原来无条件重建 `new AppError('DB_MIGRATION_FAILED', {
    // details: { from, to, backedUp } })`，于是内层 `readMigrationSql` 抛出的
    // `reason: 'sql-not-found'`（连同 migrationsDir、ENOENT 的绝对路径）被整个覆盖 ——
    // 日志里只剩一个抽象错误码，真实原因（SQL 没被复制到 out 目录）完全不可见。
    //
    // 两条纪律：
    //   1. 内层的 `details` 必须原样保留，本层的上下文补在后面（而不是覆盖）；
    //   2. 已经是「基础设施残缺」类的错误直接往上抛，不再套一层壳。
    if (isAppError(e) && e.key === 'DB_MIGRATION_FAILED' && e.details?.['reason'] === 'sql-not-found') {
      throw e
    }
    const inner = isAppError(e) ? e.details : undefined
    throw new AppError('DB_MIGRATION_FAILED', {
      cause: e,
      details: {
        ...(inner ?? {}),
        from: currentSchemaVersion(opts.db),
        to: target,
        backedUp,
      },
    })
  }
}

export interface CheckIntegrityOptions {
  /** 是否处于只读模式（迁移失败后） */
  readOnly?: boolean
  /** 只读原因（进日志，便于一眼看出「迁移没跑完」） */
  readOnlyReason?: string | null
  /** 本次启动期望的最终 schema 版本（用于区分「全新库待迁移」与「迁移失败」） */
  expectedSchemaVersion?: number
}

/**
 * 完整性与外键检查（启动顺序第 6 步）。
 *
 * **不抛错**：`integrity_check` 报问题时应用仍应能启动（给提示 + 引导从备份恢复）。
 * 把用户直接挡在门外是更糟的选择 —— 他连导出数据的机会都没有。
 *
 * ### 为什么需要 `opts.readOnly`（docs/91 §8 的第二个已知缺陷）
 *   只读模式下 `schemaVersion` 必然是 0（迁移没跑完），但这跟「刚建的全新库」
 *   在日志里长得**一模一样**：都是 `db.integrity.ok schemaVersion: 0`。
 *   于是真机上「迁移根本没跑、一张业务表都没有」这件事被读成了「正常空库」。
 *   只读 + 完整性通过 ≠ 一切正常，必须单独记一条 `db.integrity.degraded`。
 */
export function checkIntegrity(db: DbLike, log: Logger, opts: CheckIntegrityOptions = {}): IntegrityResult {
  const result = integrityCheck(db)
  const schemaVersion = currentSchemaVersion(db)
  if (!result.ok) {
    log.warn('db.integrity.failed', {
      event: 'db.integrity.failed',
      schemaVersion,
      readOnly: opts.readOnly === true,
      errors: result.errors.slice(0, 5),
      foreignKeyViolations: result.foreignKeyViolations,
    })
  } else if (opts.readOnly === true) {
    log.warn('db.integrity.degraded', {
      event: 'db.integrity.degraded',
      readOnly: true,
      reason: opts.readOnlyReason ?? null,
      schemaVersion,
      // 0 → 迁移一条都没应用；>0 → 只应用了一部分就失败了
      schemaState: schemaVersion === 0 ? 'migration-not-applied' : 'partial-schema',
      expectedSchemaVersion: opts.expectedSchemaVersion ?? null,
      hint: '迁移未完成：当前为只读模式，缺表/缺列不是数据损坏',
      foreignKeyViolations: result.foreignKeyViolations,
    })
  } else {
    log.info('db.integrity.ok', {
      event: 'db.integrity.ok',
      schemaVersion,
      // 全新库（schemaVersion 0）本身正常（待迁移），但要显式标出状态，
      // 避免与「迁移失败导致的 0」混为一谈。
      schemaState: schemaVersion === 0 ? 'empty-pending-migration' : 'migrated',
      foreignKeyViolations: result.foreignKeyViolations,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// DbPort（IPC `db:*` 通道的实现）
// ---------------------------------------------------------------------------

export interface DbPortLike {
  backup(): Promise<{ path: string }>
  listBackups(): Array<{
    id: string
    filePath: string
    sizeBytes: number
    schemaVersion: number
    reason: string
    createdAt: number
  }>
  restore(path: string): Promise<void>
  integrityCheck(): { ok: boolean; errors: string[] }
  stats(): { sizeBytes: number; schemaVersion: number; tables: Array<{ name: string; rows: number }> }
}

export interface CreateDbPortOptions {
  /** 当前连接（恢复期间会被关闭再重开，因此是取值函数而不是句柄） */
  getDb: () => DbLike | null
  dbPath: string
  backupDir: string
  log: Logger
  /** 关闭当前连接（恢复流程要求先关；带打开的连接替换库文件会立刻损坏） */
  closeForRestore: () => void
  /** 重新打开连接，返回新句柄（调用方负责更新 getDb 看到的值） */
  reopenAfterRestore: () => Promise<{ ok: boolean; errors: string[] }>
}

/**
 * 创建 `DbPort` 实现。
 *
 * `listBackups()` 在契约里是**同步**签名，因此这里用同步 `readdirSync`
 * 而不是既有的异步 `listBackupFiles`。备份目录很小，且该调用只在
 * 「设置 → 备份」面板打开时发生，同步读不会影响交互。
 */
export function createDbPort(opts: CreateDbPortOptions): DbPortLike {
  return {
    async backup(): Promise<{ path: string }> {
      const db = opts.getDb()
      if (!db) throw new AppError('DB_NOT_OPEN', { details: { op: 'backup' } })
      await fsp.mkdir(opts.backupDir, { recursive: true })
      await pruneBackups(opts.backupDir, opts.log)
      const res = await backupDatabase(db, backupFileName(new Date()), {
        reason: 'manual',
        dir: opts.backupDir,
      })
      opts.log.info('db.backup.done', { event: 'db.backup.done', path: res.path, sizeBytes: res.sizeBytes })
      return { path: res.path }
    },

    listBackups(): ReturnType<DbPortLike['listBackups']> {
      const out: ReturnType<DbPortLike['listBackups']> = []
      try {
        for (const name of readdirSync(opts.backupDir)) {
          if (!name.endsWith('.db')) continue
          const full = join(opts.backupDir, name)
          let sizeBytes = 0
          let createdAt = 0
          try {
            const st = statSync(full)
            sizeBytes = st.size
            createdAt = Math.floor(st.mtimeMs)
          } catch {
            continue
          }
          out.push({
            id: basename(name, '.db'),
            filePath: full,
            sizeBytes,
            // 版本号需要打开库才能读；列表视图不为了它去开连接，交由详情页显示
            schemaVersion: 0,
            reason: name.startsWith('pre-migrate') ? 'pre_migrate' : 'manual',
            createdAt,
          })
        }
      } catch {
        /* 目录不存在 = 还没有任何备份 */
      }
      return out.sort((a, b) => b.createdAt - a.createdAt)
    },

    async restore(path: string): Promise<void> {
      opts.closeForRestore()
      await restoreDatabase({
        backupPath: path,
        dbPath: opts.dbPath,
        closeDatabase: () => undefined, // 上面已关，这里不重复
        reopenAndCheck: () => opts.reopenAfterRestore(),
      })
      opts.log.info('db.restored', { event: 'db.restored', from: path })
    },

    integrityCheck(): { ok: boolean; errors: string[] } {
      const db = opts.getDb()
      if (!db) return { ok: false, errors: ['数据库未打开'] }
      const r = integrityCheck(db)
      return { ok: r.ok, errors: r.errors }
    },

    stats(): { sizeBytes: number; schemaVersion: number; tables: Array<{ name: string; rows: number }> } {
      let sizeBytes = 0
      try {
        sizeBytes = statSync(opts.dbPath).size
      } catch {
        sizeBytes = 0
      }
      const db = opts.getDb()
      if (!db) return { sizeBytes, schemaVersion: 0, tables: [] }
      const s = dbStats(db, sizeBytes)
      return { sizeBytes: s.sizeBytes, schemaVersion: s.schemaVersion, tables: s.tables }
    },
  }
}

/** 备份目录保留上限（超出按时间从旧到新删；docs/21 §15「保留策略」） */
export const MAX_BACKUPS_KEPT = 20

/** 清理多余备份。失败只记日志，绝不让一次备份因为清理失败而失败。 */
async function pruneBackups(backupDir: string, log: Logger): Promise<void> {
  try {
    const files = await listBackupFiles(backupDir)
    if (files.length <= MAX_BACKUPS_KEPT) return
    const sorted = files.slice().sort((a, b) => a.name.localeCompare(b.name))
    const remove = sorted.slice(0, sorted.length - MAX_BACKUPS_KEPT)
    for (const f of remove) {
      await fsp.rm(f.filePath, { force: true })
    }
    log.info('db.backup.pruned', { event: 'db.backup.pruned', removed: remove.length, kept: MAX_BACKUPS_KEPT })
  } catch (e) {
    log.warn('db.backup.pruneFailed', { event: 'db.backup.pruneFailed', reason: String(e) })
  }
}

export { listBackupFiles }
