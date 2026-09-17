/**
 * 基础设施 · 数据库出口
 * ============================================================================
 * 见 docs/04 §1。生产装配：bootstrap/app-lifecycle.ts 的 openDatabase 步骤
 * 动态 import better-sqlite3 并 `nodeFsPort` 之外的 DB 端口在这里汇总。
 */

export {
  applyPragmas,
  execPragma,
  PRAGMA_STATEMENTS,
  readPragma,
  type ApplyPragmasResult,
} from './pragma.ts'

export {
  asDbError,
  batchInsert,
  batchUpdate,
  inTransaction,
  tx,
  txImmediate,
  type BatchInsertOptions,
} from './tx.ts'

export {
  assertMigrationListSane,
  computeMigrationHash,
  createReadOnlyState,
  currentSchemaVersion,
  enterReadOnlyOnMigrationFailure,
  getMeta,
  migrate,
  setMeta,
  type Migration,
  type MigrateOptions,
  type MigrateResult,
  type ReadOnlyModeState,
} from './migrate.ts'

export {
  backupDatabase,
  backupFileName,
  dbStats,
  describeBackup,
  integrityCheck,
  listBackupFiles,
  preMigrateBackupFileName,
  pruneBackupRecords,
  quickCheckpoint,
  restoreDatabase,
  writeJsonAtomic,
  type BackupDatabaseOptions,
  type BackupResult,
  type DbStatsResult,
  type IntegrityResult,
  type RestoreOptions,
  type RestoreResult,
} from './backup.ts'

export {
  MIGRATION_ENTRIES,
  latestSchemaVersion,
  loadMigrations,
  readMigrationSql,
  type MigrationEntry,
} from './migrations/index.ts'

export {
  readSqliteCode,
  sqlStringLiteral,
  type DbLike,
  type OpenDatabaseFn,
  type StatementLike,
} from './types.ts'
