/**
 * 基础设施 · 迁移器
 * ============================================================================
 * 设计依据：
 *   · docs/04 §1.3「版本化、单事务、发布后只增不改、跨版本先备份、失败进只读模式」
 *   · docs/21 §13「迁移脚本骨架 + 迁移纪律」
 *   · docs/03 §7「迁移机制 / 迁移前备份 / 兼容策略」
 *
 * 迁移纪律（违反即为缺陷）：
 *   1. 已发布的迁移**永不修改** —— 改了 hash 校验会失败并拒绝启动
 *   2. 每个迁移在**单事务**内完成 —— 失败必须整体回滚，绝不留下半成品 schema
 *   3. 跨版本（≥2 个）先自动备份 —— 用户能从备份一键回退
 *   4. 失败 → 抛 DB_MIGRATION_FAILED（fatal）+ 上层进入只读模式
 */

import { AppError } from '../../../shared/errors.ts'
import { sha256Buffer } from '../fs/hash.ts'
import { asDbError, tx } from './tx.ts'
import type { DbLike } from './types.ts'

/** 迁移定义（与 docs/21 §13 一致；`up` 用于需要数据搬运的场景） */
export interface Migration {
  /** 递增版本号，从 1 开始 */
  version: number
  /** 短名（进日志与备份文件名），如 'init' */
  name: string
  /** SQL 的 sha256，形如 `sha256:ab12...`。发布后不可改。 */
  hash: string
  /** 建表/改表 SQL（与 up 二选一或同时用） */
  sql?: string
  /** 需要 CJS/TS 逻辑的数据搬运（在同一个事务里执行） */
  up?: (db: DbLike) => void
}

export interface MigrateOptions {
  /**
   * 跨 ≥2 个版本时先备份（docs/21 §13 纪律 2）。
   * 抛错即视为「备份失败」→ 中断迁移（没有备份就不敢改 schema）。
   */
  backupBeforeMigrate?: (info: { from: number; to: number; versions: number[] }) => void | Promise<void>
  /** 允许的最大版本数（防御：迁移清单被误改时早失败） */
  maxVersion?: number
  /** 校验 hash（默认 true；仅测试/开发期可关） */
  verifyHashes?: boolean
  log?: (event: string, fields: Record<string, unknown>) => void
}

export interface MigrateResult {
  from: number
  to: number
  applied: number
  /** 实际执行的迁移（版本号 + 名称） */
  appliedMigrations: Array<{ version: number; name: string }>
  /** 是否触发了迁移前备份 */
  backedUp: boolean
}

/** 计算 SQL 的迁移哈希（写入 MIGRATIONS 的字面量必须与此一致） */
export function computeMigrationHash(sql: string): string {
  return `sha256:${sha256Buffer(sql.replace(/\r\n/g, '\n'))}`
}

/** 读取 meta 表的值（表不存在视为「全新库」） */
export function getMeta(db: DbLike, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | undefined
    if (!row) return null
    return row.value === undefined || row.value === null ? null : String(row.value)
  } catch {
    // meta 表还不存在（全新库）——这是正常状态，不是错误
    return null
  }
}

/** 写入 meta 表的值 */
export function setMeta(db: DbLike, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/** 当前 schema 版本（无 meta 表或未初始化时为 0） */
export function currentSchemaVersion(db: DbLike): number {
  const raw = getMeta(db, 'schema_version')
  if (raw === null) return 0
  const n = Number(raw)
  return Number.isFinite(n) ? Math.floor(n) : 0
}

/**
 * 执行迁移。
 *
 * 行为：
 *   1. 读取 `meta.schema_version`，过滤出 `version > current` 的迁移并按版本升序
 *   2. 待执行迁移 **≥2 个**时，先调 `backupBeforeMigrate`（跨版本才需要备份：
 *      单版本失败重启即可，跨版本失败可能跨越了不可逆的结构变更）
 *   3. 逐个在**单事务**里执行 `sql` / `up`，并写入 `meta.schema_version`
 *   4. 任一步失败：事务回滚 + 抛 DB_MIGRATION_FAILED（带 version/name）
 *
 * @returns 迁移结果（from / to / applied / backedUp）
 */
export async function migrate(db: DbLike, migrations: readonly Migration[], opts?: MigrateOptions): Promise<MigrateResult> {
  const log = opts?.log
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  assertMigrationListSane(sorted, opts?.maxVersion)

  const from = currentSchemaVersion(db)
  const pending = sorted.filter((m) => m.version > from)
  if (pending.length === 0) {
    return { from, to: from, applied: 0, appliedMigrations: [], backedUp: false }
  }

  const last = pending[pending.length - 1] as Migration
  if (from > last.version) {
    // 库比程序新：降级打开会读到未知结构，必须明确拒绝（docs/03 §7.3）
    throw new AppError('DB_MIGRATION_FAILED', {
      params: { version: String(from) },
      details: { reason: 'database-newer-than-app', schemaVersion: from, appMaxVersion: last.version },
    })
  }

  // ── 跨版本先备份（docs/21 §13 纪律 2）────────────────────────────────────
  let backedUp = false
  if (pending.length >= 2 && opts?.backupBeforeMigrate) {
    try {
      await opts.backupBeforeMigrate({ from, to: last.version, versions: pending.map((m) => m.version) })
      backedUp = true
    } catch (e) {
      throw new AppError('DB_MIGRATION_FAILED', {
        params: { version: String(last.version) },
        cause: e,
        details: { reason: 'pre-migrate-backup-failed', from, to: last.version },
      })
    }
  }

  const appliedMigrations: MigrateResult['appliedMigrations'] = []
  for (const m of pending) {
    // ── 发布后不可改：SQL 变了就拒绝启动（而不是「照样跑」）────────────────
    if (opts?.verifyHashes !== false && typeof m.sql === 'string') {
      const actual = computeMigrationHash(m.sql)
      if (m.hash !== actual) {
        throw new AppError('DB_MIGRATION_FAILED', {
          params: { version: String(m.version) },
          details: {
            reason: 'hash-mismatch',
            version: m.version,
            name: m.name,
            declared: m.hash,
            actual,
            // 提示怎么修：已发布的迁移只能新增，不能改内容
            hint: '已发布的迁移不可修改：请新增一个更高版本的迁移来修正',
          },
        })
      }
    }

    try {
      // 单事务：SQL 与 up 要么都成功，要么都不生效（docs/04 §1.3）
      tx(db, () => {
        if (m.sql) db.exec(m.sql)
        m.up?.(db)
        setMeta(db, 'schema_version', String(m.version))
      })
    } catch (e) {
      throw new AppError('DB_MIGRATION_FAILED', {
        params: { version: String(m.version) },
        cause: e,
        details: {
          version: m.version,
          name: m.name,
          from,
          sqliteCode: (e as { details?: { sqliteCode?: string } }).details?.sqliteCode,
        },
      })
    }
    appliedMigrations.push({ version: m.version, name: m.name })
    log?.('db.migrate.applied', { event: 'db.migrate.applied', version: m.version, name: m.name })
  }

  return { from, to: last.version, applied: pending.length, appliedMigrations, backedUp }
}

/** 迁移清单自检：版本唯一、递增、hash 格式正确（启动自检会调用它） */
export function assertMigrationListSane(migrations: readonly Migration[], maxVersion = 100_00): void {
  const seen = new Set<number>()
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new AppError('DB_MIGRATION_FAILED', { details: { reason: 'invalid-version', migration: m } })
    }
    if (m.version > maxVersion) {
      throw new AppError('DB_MIGRATION_FAILED', { details: { reason: 'version-out-of-range', version: m.version } })
    }
    if (seen.has(m.version)) {
      throw new AppError('DB_MIGRATION_FAILED', { details: { reason: 'duplicate-version', version: m.version } })
    }
    seen.add(m.version)
    if (!m.name) throw new AppError('DB_MIGRATION_FAILED', { details: { reason: 'missing-name', version: m.version } })
    if (m.sql === undefined && m.up === undefined) {
      throw new AppError('DB_MIGRATION_FAILED', { details: { reason: 'empty-migration', version: m.version } })
    }
    if (typeof m.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(m.hash)) {
      throw new AppError('DB_MIGRATION_FAILED', { details: { reason: 'bad-hash-format', version: m.version, hash: m.hash } })
    }
  }
}

/** 打开迁移失败的库时的只读守卫（docs/04 §1.3：失败进只读模式） */
export interface ReadOnlyModeState {
  readonly: boolean
  reason: string | null
  failedVersion: number | null
}

export function createReadOnlyState(): ReadOnlyModeState {
  return { readonly: false, reason: null, failedVersion: null }
}

/** 把迁移异常转成只读模式状态；非迁移错误原样抛出 */
export function enterReadOnlyOnMigrationFailure(state: ReadOnlyModeState, e: unknown): ReadOnlyModeState {
  const err = asDbError(e, 'DB_MIGRATION_FAILED')
  if (err.key !== 'DB_MIGRATION_FAILED') throw err
  state.readonly = true
  state.reason = err.message
  state.failedVersion = Number(err.params.version ?? 0) || null
  return state
}
