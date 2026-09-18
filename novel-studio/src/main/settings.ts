/**
 * Novel Studio · 设置读写（`settings` 表 ↔ AppSettings）
 * ============================================================================
 * 设计依据：docs/04 §8「设置存储」、docs/21 §9「settings 表」
 *
 * ### 为什么要一个「加载一次、内存持有、写穿（write-through）」的实现
 *   `SettingsPort`（src/main/ipc/handlers/deps.ts）的签名是**同步**的：
 *
 *       getAll(): AppSettings
 *       get(keys?: string[]): AppSettings
 *       set(patch): { changedKeys: string[] }
 *
 *   而 SQLite 读是同步的、写也可以同步 —— 但「每次都查库」会让 `settings:get`
 *   在热路径上反复解析 JSON。因此这里：
 *     · 启动时 `load()` 一次，把整棵设置树放进内存；
 *     · `set()` 先改内存再**同步写穿**到 `settings` 表（一个事务，key 级 upsert）；
 *     · 因此任何时刻读到的都是最新值，且崩溃后重启仍是最后写入的值。
 *
 *   写穿（而不是「延迟批量落盘」）是刻意的：设置项少、写频率极低，
 *   而「改了设置但没生效/丢设置」对用户是不可接受的。
 *
 * ### 与默认值的关系
 *   库里没有的 key 用默认值补齐；`reset(keys)` 把指定 key 恢复成默认。
 *   默认值集中在 {@link buildDefaultSettings}，并且**只依赖 src/shared/constants.ts**
 *   （VAD_DEFAULTS / EXPORT_DEFAULTS / CANVAS_DEFAULTS 等），避免同一份默认值写两处。
 */

import {
  ARRANGE_DEFAULTS,
  CANVAS_DEFAULTS,
  EXPORT_DEFAULTS,
  IMPORT_LIMITS,
  RECORD_LIMITS,
  VAD_DEFAULTS,
} from '../shared/constants.ts'
import type { AppSettings } from '../shared/types.ts'
import { readPragma } from './infra/db/pragma.ts'
import type { DbLike } from './infra/db/types.ts'

/** 设置表名（docs/21 §9） */
const TABLE = 'settings'

/**
 * 引导期**兜底**建表语句。
 *
 * ⚠️ 这张表的所有权属于迁移 `001_init.sql`；这里的 DDL 只是「数据库还没迁移好也要能起
 * 内存设置」的兜底。关键在于它执行的**时机**：本文件由启动第 4 步（open-database）调用，
 * **早于**第 5 步的迁移。因此它的列集合必须与 `001_init.sql` 里的 `settings` **完全一致**：
 * 只要比迁移少一列，迁移里的 `CREATE TABLE IF NOT EXISTS settings` 就会变成空操作
 * （表已存在），紧接着引用该列的 `CREATE INDEX ... ON settings(is_secret)` 就会报
 * `no such column: is_secret` → **整个迁移事务回滚** → 一张业务表都建不出来，
 * 用户看到的是「缺少 books 表」（E70011）。真机事故见 docs/91 §5.2.2。
 *
 * 反过来说：**不要**在这里建任何迁移里没有的表/列，也不要让这张表的形状比迁移"窄"。
 */
export const SETTINGS_BOOTSTRAP_DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);`

/**
 * 迁移依赖、但历史版本的兜底 DDL 可能没建的列。
 *
 * 为什么必须有这个修复：早期版本的兜底 DDL 只建了 `(key, value, updated_at)`，
 * 并且在真机上**已经把 `settings` 落成了那个形状**。`CREATE TABLE IF NOT EXISTS`
 * 无法把已存在的表改回宽形状，于是 `001_init.sql` 会在同一行上**永久失败**
 * （`meta` 建不出来 ⇒ schema_version 恒为 0 ⇒ 每次启动都重试、每次都失败，
 * 重启与重装都无效）。SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以逐列判断后补。
 */
export const SETTINGS_REQUIRED_COLUMNS: readonly { name: string; add: string }[] = [
  {
    name: 'is_secret',
    add: `ALTER TABLE ${TABLE} ADD COLUMN is_secret INTEGER NOT NULL DEFAULT 0`,
  },
]

export interface SettingsStoreOptions {
  /** 数据库句柄；为 null 时退化成「纯内存设置」（数据库打不开的降级模式） */
  db: DbLike | null
  /** 路径类默认值（由启动期的路径解析提供，见 src/main/paths.ts） */
  pathDefaults: AppSettings['paths']
  /** 日志级别默认值（来自命令行/环境，缺省 info） */
  logLevel?: AppSettings['advanced']['logLevel']
}

/**
 * 出厂默认设置。
 *
 * ⚠️ **取值以 `002_seed.sql` 为准**：那份迁移把同样的键预置进库里
 * （`INSERT OR IGNORE INTO settings(...)`），而它是**已发布的迁移**（hash 固定在
 * `MIGRATION_ENTRIES`，改内容会导致启动校验失败）。真实库上 seed 的行会覆盖这里的
 * 默认值（`loadFromDb` 里库值优先），所以两边**必须逐项一致**，否则「默认值是多少」
 * 就取决于有没有跑过迁移 —— 这在单测（内存库、不跑迁移）与真机之间会得到两种答案。
 *
 * `tests/main/settings-defaults-seed.test.ts` 会逐项比对两边，改任意一边都必须同步另一边。
 *
 * 能复用 `src/shared/constants.ts` 的就复用（`VAD_DEFAULTS` / `EXPORT_DEFAULTS` /
 * `CANVAS_DEFAULTS` / `ARRANGE_DEFAULTS` / `RECORD_LIMITS`），其余按 seed 的字面量写。
 */
export function buildDefaultSettings(opts: {
  paths: AppSettings['paths']
  logLevel?: AppSettings['advanced']['logLevel']
}): AppSettings {
  return {
    paths: {
      // 这 4 个由运行时解析（seed 的注释明确说「不在此预置」，见 002_seed.sql 第 44 行）
      projectRoot: opts.paths.projectRoot,
      exportDir: opts.paths.exportDir,
      cacheDir: opts.paths.cacheDir,
      backupDir: opts.paths.backupDir,
      // 这 2 个是**可选覆盖**：null = 用随应用分发/运行时解析的位置
      // （seed 也是把它们预置成 `'null'`，设置页的输入框留空即此意）
      ffmpegPath: null,
      modelDir: null,
    },
    audio: {
      sampleRate: 48000,
      bitDepth: 24,
      channels: 1,
      defaultInputDeviceId: null,
      monitorEnabled: false,
      monitorGainDb: 0,
      inputGainDb: 0,
      agcEnabled: false,
      countdownMs: 3000,
      autoTrim: true,
      trimThresholdDb: -45,
      trimPaddingMs: 100,
      echoCancellation: false,
    },
    recording: {
      defaultMode: 'line_by_line',
      stopKey: 'Space',
      nextLineKey: 'ArrowDown',
      redoKey: 'Ctrl+R',
      playKey: 'P',
      footPedalEnabled: false,
      footPedalMapping: { F13: 'stop_and_next', F14: 'redo' },
      vad: { ...VAD_DEFAULTS },
      maxSessionMinutes: RECORD_LIMITS.defaultMaxSessionMinutes,
    },
    canvas: {
      attributionThreshold: CANVAS_DEFAULTS.attributionThreshold,
      attributionMargin: CANVAS_DEFAULTS.attributionMargin,
      contextWindow: CANVAS_DEFAULTS.contextWindow,
      autoAcceptConfidence: CANVAS_DEFAULTS.autoAcceptConfidence,
      defaultPauseAfterMs: CANVAS_DEFAULTS.defaultPauseAfterMs,
      defaultEmotion: CANVAS_DEFAULTS.defaultEmotion,
      maxLineChars: CANVAS_DEFAULTS.maxLineChars,
      maxNarrationRun: CANVAS_DEFAULTS.maxNarrationRun,
      shortLineChars: CANVAS_DEFAULTS.shortLineChars,
    },
    mixing: {
      targetLufs: -16,
      truePeakDb: EXPORT_DEFAULTS.truePeakDb,
      headSilenceMs: EXPORT_DEFAULTS.headSilenceMs,
      tailSilenceMs: EXPORT_DEFAULTS.tailSilenceMs,
      defaultMusicGainDb: -18,
      duckAmountDb: -12,
      duckAttackMs: 150,
      duckReleaseMs: 400,
      maxCrossTrackOverlapMs: ARRANGE_DEFAULTS.maxCrossTrackOverlapMs,
      maxGapMs: 5000,
    },
    export: {
      // ExportFormat 只有 mp3 | wav | m4a：M4B 是「封装 + 章节」而不是另一种编码，
      // 容器仍是 M4A(AAC)，章节信息走 ffmetadata（见 docs/15 §5）
      format: 'mp3',
      mp3Bitrate: EXPORT_DEFAULTS.mp3Bitrate,
      m4bBitrate: EXPORT_DEFAULTS.m4bBitrate,
      fileNameTemplate: EXPORT_DEFAULTS.fileNameTemplate,
      chapterTitleTemplate: EXPORT_DEFAULTS.chapterTitleTemplate,
      writeMetadata: true,
      coverPath: null,
      splitM4bEvery: 0,
    },
    ai: {
      provider: 'mock',
      baseUrl: '',
      model: 'mock',
      timeoutMs: 60_000,
      maxConcurrency: 2,
      allowSendTextToCloud: false,
    },
    embedding: { modelId: 'bge-small-zh-v1.5', batchSize: 16, threads: 4 },
    asr: { modelId: 'ggml-base.bin', language: 'zh', threads: 4, translate: false },
    import: {
      maxFileSizeBytes: IMPORT_LIMITS.maxFileSizeBytes,
      maxUrlPages: IMPORT_LIMITS.maxUrlPages,
      fetchDelayMs: IMPORT_LIMITS.fetchDelayMs,
    },
    ui: { theme: 'system', language: 'zh-CN', editorDensity: 'normal' },
    advanced: {
      logLevel: opts.logLevel ?? 'info',
      autoBackup: 'daily',
      keepBackups: 7,
      autoCleanupTakes: false,
    },
  }
}

/** 点分路径取值（`'audio.sampleRate'`）；任一层缺失返回 undefined */
export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * 点分路径写值。只写**已存在**的叶子（防拼写错误悄悄塞进一个新 key）。
 * @returns 是否真的写入了（false = 路径不存在，调用方据此报 INVALID_PAYLOAD）
 */
export function setByPath(obj: unknown, path: string, value: unknown): boolean {
  const segs = path.split('.')
  let cur: Record<string, unknown>
  if (obj === null || typeof obj !== 'object') return false
  cur = obj as Record<string, unknown>
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]!]
    if (next === null || typeof next !== 'object') return false
    cur = next as Record<string, unknown>
  }
  const leaf = segs[segs.length - 1]!
  if (!(leaf in cur)) return false
  cur[leaf] = value
  return true
}

/** 深拷贝（设置树只含 JSON 值，structuredClone 足够且比 JSON 往返保真） */
function clone<T>(v: T): T {
  return structuredClone(v)
}

/** 是否是「普通对象」——设置树里的**分组**；数组与 null 都不算（数组是叶子值） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export interface SettingsStore {
  /** 读取全部（深拷贝，调用方改不脏内部状态） */
  getAll(): AppSettings
  /** 按前缀/完整 key 过滤 */
  get(keys?: string[]): AppSettings
  /** 写入补丁（点分 key 的对象树，如 `{ audio: { sampleRate: 44100 } }` 或 `{ 'audio.sampleRate': 44100 }`） */
  set(patch: Record<string, unknown>): { changedKeys: string[] }
  /** 写入**已加密**的密钥值（加密由调用方用 infra/secure 完成） */
  setSecretRaw(key: string, encrypted: string): { changedKeys: string[] }
  /** 读取密钥的密文（不解密；解密在调用方） */
  getSecretRaw(key: string): string | null
  /** 重置为默认值 */
  reset(keys?: string[]): void
  /** 当前值快照（供能力探测等只读场景用） */
  current(): Readonly<AppSettings>
}

/**
 * 确保 `settings` 表存在**且列齐全**（幂等）。三步：
 *
 *   1. `CREATE TABLE IF NOT EXISTS` —— 全新库走这条，直接建成与迁移一致的宽表
 *   2. 读 `PRAGMA table_info` 对照 {@link SETTINGS_REQUIRED_COLUMNS}
 *   3. 缺列则 `ALTER TABLE ... ADD COLUMN` —— 修「历史版本的窄表」
 *
 * 全程吞错是刻意的，且与调用方语义一致：只读库/表被锁时设置应退化成内存值，
 * 而不是把整个启动过程炸掉。真正的结构问题不由这里负责报错 —— 它会在第 5 步迁移里
 * 以精确形式暴露（`no such column: is_secret` → `DB_SCHEMA_INCOMPLETE`，见 shared/errors.ts）。
 */
function ensureSettingsSchema(db: DbLike): void {
  try {
    db.exec(SETTINGS_BOOTSTRAP_DDL)
  } catch {
    /* 表已存在或库只读：忽略，下面的读写会各自兜错 */
  }

  let existing: string[]
  try {
    const rows = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<Record<string, unknown>>
    existing = rows.map((r) => String(r['name'] ?? ''))
  } catch {
    return
  }
  // 表不存在（建表那一步也失败了，例如只读库）→ 没什么可补的
  if (existing.length === 0) return

  for (const col of SETTINGS_REQUIRED_COLUMNS) {
    if (existing.includes(col.name)) continue
    try {
      db.exec(col.add)
    } catch {
      /* 补不上（只读库/被占用）：留给迁移层报精确错误，不在这里吞掉真实原因 */
    }
  }
}

/**
 * 创建设置存储。
 *
 * @param opts.db 为 null 时退化为纯内存（数据库打不开 → 应用仍能进只读/降级模式）
 */
export function createSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const defaults = buildDefaultSettings({ paths: opts.pathDefaults, ...(opts.logLevel ? { logLevel: opts.logLevel } : {}) })
  const db = opts.db

  // 1) 建表 + 补列（幂等）。settings 表的**所有权属于** 001_init.sql，这里只做兜底 ——
  //    数据库还没迁移好时也要能起内存设置，不让整个应用起不来。补列那一步是为了修
  //    「历史版本的窄 settings 表」，否则迁移会永久失败（详见上方常量注释）。
  if (db) ensureSettingsSchema(db)

  const state: { value: AppSettings } = { value: clone(defaults) }

  /** 2) 把库里的值合并进默认树（库里的值优先） */
  function loadFromDb(): void {
    if (!db) return
    try {
      const rows = db.prepare(`SELECT key, value FROM ${TABLE}`).all() as Array<{ key: string; value: string }>
      for (const row of rows) {
        try {
          const parsed: unknown = JSON.parse(row.value)
          // 只覆盖默认树里**已存在**的叶子：老版本残留的 key 不会污染当前结构
          // （`setByPath` 对不存在的路径返回 false，天然实现了这一点）
          //
          // 但**分支级键必须挡住非对象值**：真机库里曾出现 `import = null` 这样的行
          // （成因见 applyPatch 的注释），若照单全收就会把整支设成 null，
          // 启动时 `ports.ts` 读 `import.maxFileSizeBytes` 抛 TypeError —— 而且因为坏值
          // 就在库里，**每次启动都抛**，应用再也起不来。
          // 这里的取舍很明确：宁可忽略一个坏设置（用默认值），也不能让应用起不来。
          if (isPlainObject(getByPath(defaults, row.key)) && !isPlainObject(parsed)) {
            continue
          }
          setByPath(state.value, row.key, parsed)
        } catch {
          /* 单条坏了不影响其余设置：跳过 */
        }
      }
    } catch {
      /* 表不存在/库只读：保持默认值即可 */
    }
  }
  loadFromDb()

  /** 3) 写穿：把一批点分 key 同步写回库 */
  function persist(keys: readonly string[], changed: string[]): void {
    if (!db || changed.length === 0) return
    void keys
    try {
      const stmt = db.prepare(
        `INSERT INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      )
      for (const key of changed) {
        const v = getByPath(state.value, key)
        stmt.run(key, JSON.stringify(v ?? null), Date.now())
      }
    } catch {
      /* 写库失败不回滚内存：用户当次会话仍能看到自己的修改（与「保存失败」提示配套） */
    }
  }

  function collectLeafKeys(root: unknown, prefix = ''): string[] {
    if (root === null || typeof root !== 'object') return [prefix]
    const out: string[] = []
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...collectLeafKeys(v, p))
      else out.push(p)
    }
    return out
  }

  function applyPatch(patch: Record<string, unknown>): string[] {
    const changed: string[] = []
    for (const [key, value] of Object.entries(patch)) {
      // ── `undefined` 一律表示「本次补丁没有提供这一项」，必须跳过 ──────────────
      //
      // 为什么必须在这里挡（真机事故，docs/91 §5.2.3 与 §5.2.7）：
      // IPC 校验层（infra/validate/schema.ts 的 `ObjectSchema._parse`）会把 shape 里
      // **每一个**键都物化进结果 —— 输入里没出现的键就变成 `undefined`。
      //   · 顶层：用户在 UI 上只改一个分组时，补丁其实是「12 个分组全在，其中 11 个 undefined」。
      //     照单全收 → 整支被赋成 undefined → persist 写成 `null` → 下次启动
      //     `loadFromDb` 用 null 覆盖整棵树 → ports.ts 读 import.maxFileSizeBytes 抛
      //     TypeError → **启动永久失败**。
      //   · 分组内：只改一个分组里的**一项**时，补丁是「该分组所有叶子都在，其中大部分
      //     undefined」。照单全收 → 同组其它项**全部被清空**（真机现象：选了导出位置后
      //     再选备份位置，导出位置就没了）。
      //
      // 语义上这两层是同一件事：**补丁里没出现的键 = 不改它**。
      if (value === undefined) continue

      // ── 分组键也不能被 `null` 赋值 ─────────────────────────────────────────
      // 「整支 = null」不是任何 UI 操作能表达的意思：分组只能是对象。
      if (value === null && isPlainObject(getByPath(defaults, key))) continue

      // 支持两种写法：
      //   · `{ audio: { sampleRate: 48000 } }` —— **经 IPC 的唯一写法**（schema 是嵌套对象形状）
      //   · `{ 'audio.sampleRate': 48000 }` —— **仅 store 层**：点分键在 `settings:set` 的
      //     schema 里属未声明键，会被按 strip 静默剥掉（实测 `changed=[]`）。
      //     保留这条分支是为了让 store 的单测与内部调用能直接点着路径改，不要据此以为
      //     渲染进程可以发点分键。
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && key.includes('.') === false) {
        for (const leaf of collectLeafKeys(value, key)) {
          const leafValue = getByPath(value, leaf.slice(key.length + 1))
          // 分组内同理：**叶子是 `undefined` 就跳过**，否则会把同组其它项清空。
          // （`null` 不跳过：对叶子而言 null 是有意义的「用默认值」，见 loadFromDb 的注释。）
          if (leafValue === undefined) continue
          if (setByPath(state.value, leaf, leafValue)) changed.push(leaf)
        }
        continue
      }
      if (setByPath(state.value, key, value)) changed.push(key)
    }
    return changed
  }

  return {
    getAll(): AppSettings {
      return clone(state.value)
    },

    get(keys?: string[]): AppSettings {
      if (!keys || keys.length === 0) return clone(state.value)
      const out = clone(state.value)
      // 过滤：保留命中的前缀分支。实现方式是「重建一棵只含命中 key 的树」，
      // 这样返回类型仍是完整的 AppSettings（调用方无需处理 Partial）。
      const pick = (target: unknown, source: unknown, prefix: string): boolean => {
        if (target === null || typeof target !== 'object' || source === null || typeof source !== 'object') return false
        let hit = false
        for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
          const p = prefix ? `${prefix}.${k}` : k
          const matched = keys.some((want) => want === p || want.startsWith(`${p}.`) || p.startsWith(`${want}.`))
          if (!matched) {
            delete (target as Record<string, unknown>)[k]
            continue
          }
          hit = true
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            pick(v, getByPath(source, p), p)
          }
        }
        return hit
      }
      pick(out, state.value, '')
      return out
    },

    set(patch: Record<string, unknown>): { changedKeys: string[] } {
      const changed = applyPatch(patch)
      persist(changed, changed)
      return { changedKeys: changed }
    },

    setSecretRaw(key: string, encrypted: string): { changedKeys: string[] } {
      const changed = setByPath(state.value, key, encrypted) ? [key] : []
      persist(changed, changed)
      return { changedKeys: changed }
    },

    getSecretRaw(key: string): string | null {
      const v = getByPath(state.value, key)
      return typeof v === 'string' ? v : null
    },

    reset(keys?: string[]): void {
      // 先把可能的**分支名**展开成叶子键：`SECTIONS.resetKeys` 给的就是 `['paths']` /
      // `['audio']` 这类分组名。若按整支写库，settings 表里会多出一行
      // `paths = {整个对象}` —— 与「一行为一个叶子」的表语义不符，读取时还会与叶子行
      // 互相覆盖（`SELECT key, value` 没有 ORDER BY，覆盖顺序不确定）。
      const targets = (keys && keys.length > 0 ? keys : collectLeafKeys(defaults)).flatMap((key) =>
        collectLeafKeys(getByPath(defaults, key), key),
      )
      const changed: string[] = []
      for (const key of targets) {
        const def = getByPath(defaults, key)
        if (setByPath(state.value, key, def)) changed.push(key)
      }
      persist(changed, changed)
    },

    current(): Readonly<AppSettings> {
      return state.value
    },
  }
}

/** 读 schema 版本（诊断面板用；表不存在时返回 0） */
export function readSchemaVersionSafe(db: DbLike | null): number {
  if (!db) return 0
  try {
    const v = Number(readPragma(db, 'user_version'))
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}
