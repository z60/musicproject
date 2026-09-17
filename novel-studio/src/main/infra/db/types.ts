/**
 * 基础设施 · 数据库最小接口
 * ============================================================================
 * 设计依据：
 *   · docs/04 §1.1「better-sqlite3 同步 API；主进程单例」
 *   · docs/02 §2.1「原生模块 ABI：better-sqlite3 必须 electron-rebuild」
 *
 * 为什么这里**不 import better-sqlite3**：
 *   1. 该模块是原生模块，本仓库的测试与脚本要能被 Node 原生执行，不能依赖它；
 *   2. 类型上从 'better-sqlite3' 导入会在无依赖环境直接编译失败。
 * 因此定义仓库自己的最小接口，生产环境把真实的 `Database` 实例直接传进来即可
 * （better-sqlite3 的 API 是它的超集，结构化类型天然兼容）。
 *
 * 生产装配点见 bootstrap/app-lifecycle.ts 的 `openDatabase` 步骤（动态 import）。
 */

/** 预编译语句（better-sqlite3 的 Statement 子集） */
export interface StatementLike {
  /** 写操作：返回影响行数 */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  /** 取单行（无结果返回 undefined） */
  get(...params: unknown[]): unknown
  /** 取多行 */
  all(...params: unknown[]): unknown[]
}

/** 数据库连接（better-sqlite3 的 Database 子集） */
export interface DbLike {
  prepare(sql: string): StatementLike
  exec(sql: string): void
  /** better-sqlite3 特有：`db.pragma('journal_mode = WAL')` */
  pragma?(statement: string): unknown
  /** better-sqlite3 特有：自动 BEGIN/COMMIT/ROLLBACK（嵌套用 savepoint） */
  transaction?<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
  close(): void
  /** 便于日志与错误详情 */
  readonly name?: string
  readonly open?: boolean
}

/** 打开数据库的函数签名（生产实现里动态 import better-sqlite3 并 new Database(path)） */
export type OpenDatabaseFn = (dbPath: string, opts?: { readonly?: boolean }) => Promise<DbLike>

/** SQL 字符串字面量转义（`VACUUM INTO '<path>'` 必须自己转义，SQLite 不支持参数化） */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 把 sqlite 的错误码映射成可读摘要（进 details，不进 UI） */
export function readSqliteCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  // better-sqlite3 的错误信息形如「SQLITE_BUSY: database is locked」
  const msg = (e as { message?: unknown } | null)?.message
  if (typeof msg === 'string') {
    const m = /^(SQLITE_[A-Z_]+)/.exec(msg)
    if (m) return m[1]
  }
  return undefined
}
