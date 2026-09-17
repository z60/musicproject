/**
 * Novel Studio · 生成 002_seed.sql
 * ============================================================================
 * 设计依据：docs/21 §13（迁移脚本骨架：002_seed.sql = 内置分章规则集、
 *          内置处理预设、默认设置项）
 *
 * 为什么不手抄 JSON：内置规则集与处理预设的**唯一来源**是
 * `src/shared/constants.ts`（BUILTIN_RULE_SETS / BUILTIN_PRESETS）。
 * 手抄一遍必然与代码漂移，因此种子 SQL 由本脚本从常量生成。
 *
 * 用法：
 *   node --experimental-strip-types scripts/gen-seed-sql.ts          # 写入
 *   node --experimental-strip-types scripts/gen-seed-sql.ts --check  # 只校验是否同步
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ARRANGE_DEFAULTS,
  AUDIO_DEFAULTS,
  BUILTIN_PRESETS,
  BUILTIN_RULE_SETS,
  CANVAS_DEFAULTS,
  EXPORT_DEFAULTS,
  IMPORT_LIMITS,
  RECORD_LIMITS,
  VAD_DEFAULTS,
} from '../src/shared/constants.ts'
import { DEFAULT_SETTINGS_SEED } from './seed-settings.ts'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'src', 'main', 'infra', 'db', 'migrations', '002_seed.sql')

/** SQL 字符串字面量转义 */
function q(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${value.replace(/'/g, "''")}'`
}

/** JSON 值 → SQL 字面量（对象/数组用 JSON.stringify） */
function j(value: unknown): string {
  return q(JSON.stringify(value))
}

function buildSeedSql(): string {
  const lines: string[] = []
  lines.push('-- ============================================================================')
  lines.push('-- Novel Studio · 002_seed.sql')
  lines.push('-- ============================================================================')
  lines.push('-- 唯一来源：docs/21-数据字典与SQL.md §13（预置数据）')
  lines.push('--           + src/shared/constants.ts（BUILTIN_RULE_SETS / BUILTIN_PRESETS / 默认值）')
  lines.push('--')
  lines.push('-- 本文件由 scripts/gen-seed-sql.ts 生成，请勿手工编辑：')
  lines.push('--   node --experimental-strip-types scripts/gen-seed-sql.ts')
  lines.push('-- 校验是否与常量同步：')
  lines.push('--   node --experimental-strip-types scripts/gen-seed-sql.ts --check')
  lines.push('--')
  lines.push('-- 迁移纪律（docs/21 §13）：发布后不可修改（migrate.ts 校验 sha256），需要变更请新增迁移。')
  lines.push('-- ============================================================================')
  lines.push('')
  lines.push('-- ---------------------------------------------------------------------------')
  lines.push('-- 1) meta：预置时间戳占位（schema_version 由 migrate.ts 写入，app_version 由启动时')
  lines.push('--    从 package.json 读取后写入 —— 不在这里写死版本号，避免两处维护）')
  lines.push('-- ---------------------------------------------------------------------------')
  lines.push("INSERT OR IGNORE INTO meta(key, value) VALUES ('created_at', CAST(strftime('%s','now') AS INTEGER) * 1000);")
  lines.push("INSERT OR IGNORE INTO meta(key, value) VALUES ('last_backup_at', '0');")
  lines.push("INSERT OR IGNORE INTO meta(key, value) VALUES ('last_integrity_check_at', '0');")
  lines.push('')
  lines.push('-- ---------------------------------------------------------------------------')
  lines.push('-- 2) 内置分章规则集（docs/10 §6.2；project_id = NULL 表示全局）')
  lines.push('-- ---------------------------------------------------------------------------')
  for (const rs of BUILTIN_RULE_SETS) {
    lines.push(
      'INSERT OR IGNORE INTO chapter_rule_sets(id, project_id, name, builtin, definition, created_at, updated_at) VALUES (' +
        [q(rs.id), 'NULL', q(rs.name), rs.builtin ? 1 : 0, j(rs), '0', '0'].join(', ') +
        ');',
    )
  }
  lines.push('')
  lines.push('-- ---------------------------------------------------------------------------')
  lines.push('-- 3) 内置处理预设（docs/14 §4.1；内置预设不可直接编辑，用户改动会创建副本）')
  lines.push('-- ---------------------------------------------------------------------------')
  for (const preset of BUILTIN_PRESETS) {
    lines.push(
      'INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES (' +
        [
          q(preset.id),
          'NULL',
          q(preset.name),
          q(preset.description),
          preset.builtin ? 1 : 0,
          j(preset.chain),
          j(preset.tags),
          String(preset.sortOrder),
          '0',
          '0',
        ].join(', ') +
        ');',
    )
  }
  lines.push('')
  lines.push('-- ---------------------------------------------------------------------------')
  lines.push('-- 4) 默认设置项（docs/04 §8.2）')
  lines.push('--')
  lines.push('--    · key 为点分路径，value 为 JSON（settings 表约定见 docs/21 §2）')
  lines.push('--    · paths.projectRoot / exportDir / cacheDir / backupDir 不在此预置：它们由运行时')
  lines.push('--      从 Electron app.getPath() 推导（换机/便携模式都不同），写死会误导用户')
  lines.push('--    · is_secret = 1 的项（API Key）绝不预置：没有密钥就是没有，预置空值会让')
  lines.push('--      「是否已配置」判断出错（docs/04 §9）')
  lines.push('-- ---------------------------------------------------------------------------')
  const now = "CAST(strftime('%s','now') AS INTEGER) * 1000"
  for (const [key, value] of DEFAULT_SETTINGS_SEED) {
    lines.push(
      `INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES (${q(key)}, ${j(value)}, 0, ${now});`,
    )
  }
  lines.push('')
  lines.push('-- ---------------------------------------------------------------------------')
  lines.push('-- 5) 与常量一致的校验常量（供 settings 服务做范围校验；存库便于诊断包对照）')
  lines.push('-- ---------------------------------------------------------------------------')
  lines.push(
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('seed.defaults_digest', ${j({
      audioDefaults: AUDIO_DEFAULTS,
      vadDefaults: VAD_DEFAULTS,
      canvasDefaults: CANVAS_DEFAULTS,
      arrangeDefaults: ARRANGE_DEFAULTS,
      exportDefaults: EXPORT_DEFAULTS,
      importLimits: IMPORT_LIMITS,
      recordLimits: RECORD_LIMITS,
    })});`,
  )
  lines.push('')
  return lines.join('\n')
}

const sql = buildSeedSql()
const check = process.argv.includes('--check')

if (check) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    console.error('[seed] 未找到 002_seed.sql，请先运行不带 --check 的命令生成')
    process.exit(1)
  }
  // 生成时间戳行在不同运行时会不同，比较时忽略它
  const norm = (t: string): string => t.replace(/\r\n/g, '\n').replace(/strftime\('now'\)[^,)]*\)/g, 'NOW')
  if (norm(current) !== norm(sql)) {
    console.error('[seed] 002_seed.sql 与 constants.ts 不同步，请重新生成')
    process.exit(1)
  }
  console.log('[seed] OK：002_seed.sql 与 constants.ts 同步')
} else {
  writeFileSync(target, sql, 'utf8')
  const bytes = Buffer.byteLength(sql, 'utf8')
  console.log(`[seed] 已写入 ${target}（${sql.split('\n').length} 行 / ${bytes} 字节）`)
}
