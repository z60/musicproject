/**
 * 基础设施 · 连接级 PRAGMA
 * ============================================================================
 * 设计依据：docs/04 §1.1 / docs/21 §1（每次打开连接都要执行）
 *
 * ```sql
 * PRAGMA journal_mode = WAL;      -- 读写并发；崩溃安全性好
 * PRAGMA synchronous = NORMAL;    -- WAL 下的性能/安全平衡点
 * PRAGMA foreign_keys = ON;       -- 默认是关的，必须显式开启
 * PRAGMA busy_timeout = 5000;     -- 5s 后报可重试错误，而不是抛 SQLITE_BUSY
 * PRAGMA temp_store = MEMORY;
 * PRAGMA cache_size = -64000;     -- 约 64 MB 页缓存
 * PRAGMA mmap_size = 268435456;   -- 256 MB 内存映射（大库查询提速）
 * ```
 *
 * 为什么必须显式设置 `foreign_keys`：SQLite 的外键默认**关闭**，
 * 忘记开会导致 `ON DELETE CASCADE` 静默失效——删书不删章节，数据越积越脏。
 * 为什么 `synchronous=NORMAL`：WAL 下 NORMAL 只在 checkpoint 时 fsync，
 * 进程崩溃不丢数据（只有断电丢最近几个事务），比 FULL 快一个数量级。
 */

import { AppError, wrapUnknown } from '../../../shared/errors.ts'
import type { DbLike } from './types.ts'
import { readSqliteCode } from './types.ts'

/** 必须执行的 PRAGMA 清单（顺序有讲究：WAL 先于 synchronous） */
export const PRAGMA_STATEMENTS: readonly string[] = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'temp_store = MEMORY',
  'cache_size = -64000',
  'mmap_size = 268435456',
]

export interface ApplyPragmasResult {
  applied: Array<{ statement: string; result: unknown }>
  /** 返回结果与期望不符的项（例如 WAL 无法启用：网络盘/只读文件系统） */
  degraded: Array<{ statement: string; expected: string; actual: unknown }>
}

/**
 * 对连接应用全部 PRAGMA。
 *
 * 失败即抛 `DB_CORRUPT` 语义的致命错误？——不是：PRAGMA 失败多数是「环境不支持」
 * （网络盘不支持 mmap、只读库无法切 WAL），应当降级并记日志，让上层决定是否继续。
 * 因此这里返回 `degraded` 列表，只有**完全无法执行任何 PRAGMA**（连接已坏）才抛错。
 */
export function applyPragmas(db: DbLike): ApplyPragmasResult {
  const applied: ApplyPragmasResult['applied'] = []
  const degraded: ApplyPragmasResult['degraded'] = []
  let lastError: unknown = null

  for (const statement of PRAGMA_STATEMENTS) {
    try {
      const result = execPragma(db, statement)
      applied.push({ statement, result })
      const check = verifyPragma(statement, result)
      if (check) degraded.push(check)
    } catch (e) {
      lastError = e
      degraded.push({ statement, expected: 'succeeded', actual: String(e) })
    }
  }

  if (applied.length === 0 && lastError) {
    // 一条都执行不了 → 连接本身就是坏的，不能再带着它跑（docs/22 §6 兜底原则）
    throw new AppError('DB_CORRUPT', {
      cause: lastError,
      details: { reason: 'pragmas-all-failed', sqliteCode: readSqliteCode(lastError) },
    })
  }
  return { applied, degraded }
}

/** 优先用驱动的 `pragma()`（better-sqlite3 有返回值），否则退化为 `exec` */
export function execPragma(db: DbLike, statement: string): unknown {
  if (typeof db.pragma === 'function') return db.pragma(statement)
  try {
    // `journal_mode = WAL` 这类设置型 PRAGMA 用 exec 也能生效（只是拿不到返回行）
    db.exec(`PRAGMA ${statement};`)
    return undefined
  } catch (e) {
    throw wrapUnknown(e)
  }
}

/** 读取单个 PRAGMA 的当前值（诊断用） */
export function readPragma(db: DbLike, name: string): unknown {
  try {
    if (typeof db.pragma === 'function') return db.pragma(name)
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
    return row ? Object.values(row)[0] : undefined
  } catch {
    return undefined
  }
}

/** 校验关键 PRAGMA 是否真的生效（WAL 在只读/网络盘上会静默退化成 delete 模式） */
function verifyPragma(statement: string, result: unknown): ApplyPragmasResult['degraded'][number] | null {
  const name = statement.split('=')[0].trim()
  const expected = statement.split('=')[1]?.trim() ?? ''
  const actual = Array.isArray(result)
    ? (result[0] as Record<string, unknown> | undefined)?.[name]
    : result
  if (actual === undefined) return null
  if (name === 'journal_mode') {
    const actualStr = String(actual).toLowerCase()
    if (actualStr !== 'wal') return { statement, expected: 'wal', actual }
    return null
  }
  const norm = (v: unknown): string => String(v).toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (norm(actual) !== norm(expected) && String(actual) !== expected) {
    return { statement, expected, actual }
  }
  return null
}
