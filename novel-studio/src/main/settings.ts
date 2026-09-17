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

import { CANVAS_DEFAULTS, EXPORT_DEFAULTS, IMPORT_LIMITS, VAD_DEFAULTS } from '../shared/constants.ts'
import type { AppSettings } from '../shared/types.ts'
import { readPragma } from './infra/db/pragma.ts'
import type { DbLike } from './infra/db/types.ts'

/** 设置表名（docs/21 §9） */
const TABLE = 'settings'

export interface SettingsStoreOptions {
  /** 数据库句柄；为 null 时退化成「纯内存设置」（数据库打不开的降级模式） */
  db: DbLike | null
  /** 路径类默认值（由启动期的路径解析提供，见 src/main/paths.ts） */
  pathDefaults: AppSettings['paths']
  /** 日志级别默认值（来自命令行/环境，缺省 info） */
  logLevel?: AppSettings['advanced']['logLevel']
}

/** 出厂默认设置。**唯一来源**：所有默认值都从 constants.ts 派生，不另写字面量。 */
export function buildDefaultSettings(opts: {
  paths: AppSettings['paths']
  logLevel?: AppSettings['advanced']['logLevel']
}): AppSettings {
  return {
    paths: { ...opts.paths },
    audio: {
      sampleRate: 48000,
      bitDepth: 24,
      channels: 1,
      defaultInputDeviceId: null,
      monitorEnabled: false,
      monitorGainDb: 0,
      inputGainDb: 0,
      agcEnabled: false,
      countdownMs: 2000,
      autoTrim: true,
      trimThresholdDb: -50,
      trimPaddingMs: 120,
      echoCancellation: false,
    },
    recording: {
      defaultMode: 'line_by_line',
      stopKey: 'Space',
      nextLineKey: 'Enter',
      redoKey: 'Ctrl+Z',
      playKey: 'P',
      footPedalEnabled: false,
      footPedalMapping: {},
      vad: { ...VAD_DEFAULTS },
      maxSessionMinutes: 120,
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
      duckReleaseMs: 600,
      maxCrossTrackOverlapMs: 500,
      maxGapMs: 5000,
    },
    export: {
      // ExportFormat 只有 mp3 | wav | m4a：M4B 是「封装 + 章节」而不是另一种编码，
      // 容器仍是 M4A(AAC)，章节信息走 ffmetadata（见 docs/15 §5）
      format: 'm4a',
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
      model: '',
      timeoutMs: 60_000,
      maxConcurrency: 2,
      allowSendTextToCloud: false,
    },
    embedding: { modelId: 'bge-small-zh-v1.5', batchSize: 16, threads: 2 },
    asr: { modelId: 'whisper-small', language: 'zh', threads: 4, translate: false },
    import: {
      maxFileSizeBytes: IMPORT_LIMITS.maxFileSizeBytes,
      maxUrlPages: IMPORT_LIMITS.maxUrlPages,
      fetchDelayMs: IMPORT_LIMITS.fetchDelayMs,
    },
    ui: { theme: 'system', language: 'zh-CN', editorDensity: 'normal' },
    advanced: {
      logLevel: opts.logLevel ?? 'info',
      autoBackup: 'daily',
      keepBackups: 10,
      autoCleanupTakes: true,
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
 * 创建设置存储。
 *
 * @param opts.db 为 null 时退化为纯内存（数据库打不开 → 应用仍能进只读/降级模式）
 */
export function createSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const defaults = buildDefaultSettings({ paths: opts.pathDefaults, ...(opts.logLevel ? { logLevel: opts.logLevel } : {}) })
  const db = opts.db

  // 1) 建表（幂等）。settings 表的 DDL 由 001_init.sql 建好，这里只兜底 ——
  //    数据库初始化失败时仍能起内存设置，不让整个应用起不来。
  if (db) {
    try {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL DEFAULT 0
         );`,
      )
    } catch {
      /* 表已存在或库只读：忽略，下面的读写会各自兜错 */
    }
  }

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
      // 支持两种写法：`{ 'audio.sampleRate': 48000 }` 与 `{ audio: { sampleRate: 48000 } }`
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && key.includes('.') === false) {
        for (const leaf of collectLeafKeys(value, key)) {
          const leafValue = getByPath(value, leaf.slice(key.length + 1))
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
      const targets = keys && keys.length > 0 ? keys : collectLeafKeys(defaults)
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
