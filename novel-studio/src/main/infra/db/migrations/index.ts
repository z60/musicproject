/**
 * 基础设施 · 迁移清单
 * ============================================================================
 * 设计依据：docs/21 §13「迁移脚本骨架」、docs/03 §7「迁移与版本化」
 *
 * ```ts
 * export const MIGRATIONS: Migration[] = [
 *   { version: 1, name: 'init', hash: 'sha256:...', sql: initSql },
 *   { version: 2, name: 'seed', hash: 'sha256:...', sql: seedSql },
 * ]
 * ```
 *
 * 关于 `hash`：它是 SQL 文本（LF 归一化后）的 sha256，**发布后不可修改**。
 * 改了内容 → migrate.ts 的校验失败 → 拒绝启动（docs/21 §13 纪律 1）。
 * 需要改结构请新增 003_*.sql。
 *
 * 关于 SQL 的加载方式：.sql 是纯文本资源，**不能**被 `import` 语句引入
 * （Node 与打包器都不认识 .sql 扩展名）。这里用 `readFileSync(import.meta.url 相对路径)`
 * 惰性读取：
 *   · 测试与 `node --experimental-strip-types` 直接跑 → 文件就在旁边，正常
 *   · Electron 打包 → 需在 electron.vite.config.ts 里把 `src/main/infra/db/migrations/*.sql`
 *     作为资源复制到 out 目录（或改为构建期生成 TS 常量）。打包配置不在本次交付范围，
 *     这里以 **清晰的错误信息**暴露该前置条件，而不是静默失败。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppError } from '../../../../shared/errors.ts'
import { computeMigrationHash, type Migration } from '../migrate.ts'

/** 迁移清单的「元信息」（不含 SQL 正文，可在任意环境安全 import） */
export interface MigrationEntry {
  version: number
  name: string
  /** 发布后不可改：SQL(LF) 的 sha256 */
  hash: string
  /** 相对本目录的 SQL 文件名 */
  file: string
}

/**
 * 迁移清单（字面量，含 hash 快照）。
 * 顺序即执行顺序（migrate.ts 仍会按 version 再排一次，防手误写乱）。
 */
export const MIGRATION_ENTRIES: readonly MigrationEntry[] = [
  {
    version: 1,
    name: 'init',
    hash: 'sha256:e134b617bbaf89d8495849965025ced525b7ac937a6ff0bdcfdb3340a633e0e2',
    file: '001_init.sql',
  },
  {
    version: 2,
    name: 'seed',
    hash: 'sha256:f6b9f4fafa05d8d83927ed0a7d812e5908da389f133af58f32b4fa6c7721c90c',
    file: '002_seed.sql',
  },
  {
    version: 3,
    name: 'canvas_generate_reports',
    hash: 'sha256:6ace9c5c1b384b371f1803fe8baed5f4e6340608a9ba6f466a8d8e7d8e275027',
    file: '003_canvas_generate_reports.sql',
  },
  {
    version: 4,
    name: 'takes_soft_delete',
    hash: 'sha256:5e3b202a73603019ef742e1a19400904a58f69747591c387effb1241a851b1f1',
    file: '004_takes_soft_delete.sql',
  },
  {
    version: 5,
    name: 'export_jobs_duration',
    hash: 'sha256:e69d256a534585e6572639e91ebb7cd5593f8e3133914a9544a122ae6e18d810',
    file: '005_export_jobs_duration.sql',
  },
]

const migrationsDir = dirname(fileURLToPath(import.meta.url))

/** 读取迁移 SQL（LF 归一化：Windows 上 git 可能把它变成 CRLF，而 hash 是按 LF 算的） */
export function readMigrationSql(file: string): string {
  try {
    return readFileSync(join(migrationsDir, file), 'utf8').replace(/\r\n/g, '\n')
  } catch (e) {
    throw new AppError('DB_MIGRATION_FAILED', {
      cause: e,
      details: {
        file,
        migrationsDir,
        reason: 'sql-not-found',
        hint: '打包时需把 src/main/infra/db/migrations/*.sql 复制到 out 目录（见本文件顶部注释）',
      },
    })
  }
}

let cached: Migration[] | null = null

/**
 * 加载迁移清单（含 SQL 正文）。结果被缓存，避免每次启动重复读盘。
 * 同时做一次自检：文件内容与登记的 hash 必须一致（不一致立即抛 DB_MIGRATION_FAILED）。
 */
export function loadMigrations(): Migration[] {
  if (cached) return cached
  cached = MIGRATION_ENTRIES.map((entry) => {
    const sql = readMigrationSql(entry.file)
    const actual = computeMigrationHash(sql)
    if (actual !== entry.hash) {
      throw new AppError('DB_MIGRATION_FAILED', {
        params: { version: String(entry.version) },
        details: {
          file: entry.file,
          declared: entry.hash,
          actual,
          reason: 'hash-mismatch-on-load',
          hint: '已发布的迁移不可修改：请新增一个更高版本的迁移',
        },
      })
    }
    return { version: entry.version, name: entry.name, hash: entry.hash, sql }
  }).sort((a, b) => a.version - b.version)
  return cached
}

/** 最高版本号（`app:getInfo` / 诊断包用） */
export function latestSchemaVersion(): number {
  return MIGRATION_ENTRIES.reduce((max, e) => Math.max(max, e.version), 0)
}

/** 供测试重置缓存（改了文件后需要重新读） */
export function __resetMigrationCache(): void {
  cached = null
}
