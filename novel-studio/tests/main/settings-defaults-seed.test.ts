/**
 * 契约 · 出厂默认值必须与 `002_seed.sql` 逐项一致
 * ============================================================================
 * 同一个「默认值」在本仓库有**两处**表述：
 *   ① `src/main/settings.ts` 的 `buildDefaultSettings()`（内存树的初值 / `settings:reset` 的还原目标）
 *   ② `src/main/infra/db/migrations/002_seed.sql`（迁移时 `INSERT OR IGNORE` 进库的行）
 *
 * 真实库上 ② 会覆盖 ①（`loadFromDb` 里库值优先），于是**两者不一致时，「默认值是多少」
 * 就取决于有没有跑过迁移** —— 单测（内存库、不跑迁移）与真机得到两种答案。
 *
 * 修 §5.2.7 时实测出 **16/74 项**不一致（`export.format` mp3↔m4a、`recording.maxSessionMinutes`
 * 240↔120、`advanced.keepBackups` 7↔10、`ai.model` mock↔''、`mixing.duckReleaseMs` 400↔600 …）。
 *
 * 为什么以 ② 为准：`002_seed.sql` 是**已发布的迁移**，内容 hash 固定在
 * `MIGRATION_ENTRIES` 里，改了会导致启动时 hash 校验失败（迁移纪律：已发布不可修改）。
 * 因此代码必须跟着 seed 走，本测试就是那条「必须同步」的自动检查。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { buildDefaultSettings, getByPath } from '../../src/main/settings.ts'

const SEED_PATH = 'src/main/infra/db/migrations/002_seed.sql'

/** 从 002_seed.sql 里抽 `INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('k', 'v', 0, …)` */
function parseSeedSettings(sql: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const re =
    /INSERT OR IGNORE INTO settings\(key, value, is_secret, updated_at\) VALUES \('([^']+)', '([\s\S]*?)', \d+, /g
  for (const m of sql.matchAll(re)) {
    // SQL 里单引号用 '' 转义
    const raw = m[2]!.replace(/''/g, "'")
    try {
      out.set(m[1]!, JSON.parse(raw))
    } catch {
      out.set(m[1]!, `<NOT-JSON: ${raw}>`)
    }
  }
  return out
}

const seed = parseSeedSettings(readFileSync(SEED_PATH, 'utf8'))

/** 与真机同形的路径默认值（这 4 个由运行时解析，seed 不预置） */
const PATH_DEFAULTS = {
  projectRoot: 'C:\\ud\\projects',
  exportDir: 'C:\\ud\\exports',
  ffmpegPath: null,
  modelDir: 'C:\\res\\models',
  cacheDir: 'C:\\ud\\cache',
  backupDir: 'C:\\ud\\backups',
}

const defaults = buildDefaultSettings({ paths: PATH_DEFAULTS }) as unknown as Record<string, unknown>

describe('默认值 · 代码与 seed 迁移必须一致', () => {
  it('解析非空（防止正则失效导致本测试变成空转）', () => {
    assert.ok(
      seed.size >= 60,
      `从 ${SEED_PATH} 只解析出 ${seed.size} 条设置预设 —— 解析正则可能已失效，` +
        `否则本测试会「看起来全绿但其实什么都没比对」`,
    )
  })

  it('逐项比对：seed 里预置的每一项都要等于 buildDefaultSettings 的值', () => {
    const mismatches: string[] = []
    for (const [key, seedValue] of seed) {
      const codeValue = getByPath(defaults, key)
      if (JSON.stringify(seedValue) !== JSON.stringify(codeValue)) {
        mismatches.push(`  ${key}\n      seed : ${JSON.stringify(seedValue)}\n      code : ${JSON.stringify(codeValue)}`)
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `以下默认值两边不一致（真机上以 seed 为准，因为库里已有这些行）：\n${mismatches.join('\n')}\n\n` +
        `修法：改 src/main/settings.ts 的 buildDefaultSettings() 去匹配 ${SEED_PATH}。\n` +
        `不要改 seed —— 它是已发布的迁移，hash 固定（改内容会导致启动校验失败）。`,
    )
  })

  it('seed 预置的键都真实存在于默认值树里（防拼错键名）', () => {
    const unknown = [...seed.keys()].filter((key) => getByPath(defaults, key) === undefined)
    assert.deepEqual(unknown, [], `这些键在 seed 里有、但在 buildDefaultSettings 里找不到：${unknown.join(', ')}`)
  })
})
