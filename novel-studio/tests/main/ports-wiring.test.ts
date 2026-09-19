/**
 * 测试 · 装配层接线（`ports.ts` → `registerAllHandlers` → 真实注册表）
 * ============================================================================
 * 设计依据：docs/01 §10 第 12 步、docs/20 §4（通道清单与自检）、docs/91 §5.2.5
 *
 * ### 为什么值得单独测
 *   `src/main/index.ts` 需要真实 Electron，测不了；但它启动时做的那件事 ——
 *   「`buildHandlerDeps()` 装配 → `registerAllHandlers()` 注册」—— **几乎全都能测**：
 *   只要给一个真实的 `AppState`（真 sqlite + 真设置存储）和一个假的 `ipcMain`。
 *
 *   而这一步错一次的代价很高：
 *     · 域 handler 没被接线 → 通道变成「功能未提供」占位，功能静默不可用
 *     · 通道重名 / 登记了契约外的通道 → 启动自检 `strict` 直接抛错，**应用起不来**
 *     · 契约里有通道既没实现也没占位 → 渲染侧调用时 `No handler registered`
 *     · 任务规格没注册 → 「生成画本」点了没反应（入队时才发现 kind 未知）
 *
 *   真机事故（docs/91 §5.2.5）里出现过「implemented 28 / placeholders 130 / 合计 158
 *   计数对得上、集合对不上」——所以这里的断言全部按**集合**做，不看计数。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { CANVAS_CHANNELS } from '../../src/main/ipc/handlers/canvas.ts'
import { CHAPTER_CHANNELS } from '../../src/main/ipc/handlers/chapter.ts'
import { CHARACTER_CHANNELS } from '../../src/main/ipc/handlers/character.ts'
import { AUDIO_CHANNELS } from '../../src/main/ipc/handlers/audio.ts'
import { PROCESSING_CHANNELS } from '../../src/main/ipc/handlers/processing.ts'
import { ALIGNMENT_CHANNELS } from '../../src/main/ipc/handlers/alignment.ts'
import { MUSIC_CHANNELS } from '../../src/main/ipc/handlers/music.ts'
import { MIX_CHANNELS } from '../../src/main/ipc/handlers/mix.ts'
import { EXPORT_CHANNELS } from '../../src/main/ipc/handlers/export.ts'
import { PACKAGE_CHANNELS } from '../../src/main/ipc/handlers/package.ts'
import { IPC_CHANNELS, IPC_EVENT_NAMES, IPC_SEND_NAMES } from '../../src/shared/ipc.ts'
import type { IpcResult } from '../../src/shared/ipc.ts'
import { createAppState, type AppState } from '../../src/main/app-state.ts'
import { buildHandlerDeps } from '../../src/main/ports.ts'
import { createSettingsStore } from '../../src/main/settings.ts'
import { registerAllHandlers } from '../../src/main/ipc/index.ts'
import { __resetRegistryForTest } from '../../src/main/ipc/registry.ts'
import { selfCheckHandlers } from '../../src/main/ipc/handlers/index.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { IpcMainLike, IpcMainInvokeEventLike } from '../../src/main/infra/electron/types.ts'
import type { Logger } from '../../src/main/infra/log/index.ts'

// ---------------------------------------------------------------------------
// 测试台：真库 + 真设置 + 假 ipcMain
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Wired {
  state: AppState
  /** 已注册通道 → 真实注册表包装后的调用函数（内含 schema 校验与错误包装） */
  invoke: (channel: string, payload?: unknown) => Promise<IpcResult<unknown>>
  registered: string[]
  impl: ReturnType<typeof registerAllHandlers>
  cleanup: () => void
}

function silentLogger(): Logger {
  const noop = (): void => undefined
  const stub = {
    level: 'error' as const,
    setLevel: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    errorFields: noop,
    child: () => stub,
    write: noop,
    addSink: noop,
    setEntryListener: noop,
    recent: () => [],
  }
  return stub as unknown as Logger
}

async function wire(): Promise<Wired> {
  const root = mkdtempSync(join(tmpdir(), 'ns-ports-'))
  const dbPath = join(root, 'novel-studio.db')

  // 真库（node:sqlite 是同一套 SQLite 引擎；better-sqlite3 在 Node 里加载不了）
  const db = new DatabaseSync(dbPath)
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', '${root.replace(/\\/g, '/')}', 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 1, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '第一章', 'chapter', '正文', 2, 0, 2, 'none', 0, 1, 1)`)

  const state = createAppState()
  state.db = db as unknown as DbLike
  state.dbPath = dbPath
  state.paths = {
    userData: root,
    projectRoot: join(root, 'projects'),
    exportDir: join(root, 'exports'),
    cacheDir: join(root, 'cache'),
    logDir: join(root, 'logs'),
    backupDir: join(root, 'backups'),
    modelDir: join(root, 'models'),
    resourceDir: join(root, 'resources'),
    dataRoot: root,
    portable: false,
  }
  state.storeLogger = { logger: silentLogger() } as unknown as AppState['storeLogger']
  state.settings = createSettingsStore({
    db: db as unknown as DbLike,
    pathDefaults: {
      projectRoot: state.paths.projectRoot,
      exportDir: state.paths.exportDir,
      ffmpegPath: null,
      modelDir: state.paths.modelDir,
      cacheDir: state.paths.cacheDir,
      backupDir: state.paths.backupDir,
    },
  })

  const built = buildHandlerDeps({
    state,
    version: '0.0.0-test',
    portable: false,
    openExternal: async () => undefined,
    showItemInFolder: () => undefined,
    pickFolder: async () => null,
    pickFiles: async () => [],
    pickSavePath: async () => null,
    quit: () => undefined,
  })

  // 假 ipcMain：只把「注册进来的监听器」记下来，调用时走注册表的真实包装
  const listeners = new Map<string, (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      listeners.set(channel, listener)
    },
    removeHandler(channel) {
      listeners.delete(channel)
    },
    on() {
      /* 单向通道在别处登记，这里不需要 */
    },
  }

  // 注册表是**模块级单例**（真实应用每个进程只注册一次）。同一进程里跑多个用例
  // 必须先清空登记，否则第二次注册会撞「通道重复注册」——那是应用启动期的门禁，
  // 不是这里要验证的东西。
  __resetRegistryForTest()

  const impl = registerAllHandlers(built.deps, {
    ipcMain,
    placeholderForMissing: true,
    assertParity: true,
    domainHandlers: built.domainHandlers,
  })

  // 真实入口（`src/main/index.ts`）在这一步把队列挂到 state 上，关闭时要用它
  state.queue = built.queue

  return {
    state,
    registered: [...listeners.keys()],
    impl,
    invoke: async (channel, payload) => {
      const listener = listeners.get(channel)
      assert.ok(listener, `通道没有登记监听器：${channel}`)
      return (await listener({} as IpcMainInvokeEventLike, payload)) as IpcResult<unknown>
    },
    cleanup: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// ① 自检与集合完整性
// ---------------------------------------------------------------------------

describe('装配层接线 · 自检与通道集合', () => {
  it('装配 → 注册全程不抛错（strict 自检 = 启动第 12 步的门禁）', async () => {
    const w = await wire()
    try {
      assert.ok(w.state.queue, '装配应产出任务队列（关闭时要用）')
      assert.ok(w.impl.implemented > 0)
      assert.equal(w.impl.registered, IPC_CHANNELS.length, '注册总数必须等于契约总数')
    } finally {
      w.cleanup()
    }
  })

  it('每个契约通道**恰好**一个监听器（既不缺也不重）', async () => {
    const w = await wire()
    try {
      const seen = new Map<string, number>()
      for (const c of w.registered) seen.set(c, (seen.get(c) ?? 0) + 1)
      const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c)
      assert.deepEqual(dup, [], '重复注册会被注册表直接抛错')
      const missing = IPC_CHANNELS.filter((c) => !seen.has(c))
      assert.deepEqual(missing, [], '契约里有、却没登记的通道 = 渲染侧调用时报 No handler registered')
      const extra = w.registered.filter((c) => !(IPC_CHANNELS as readonly string[]).includes(c))
      assert.deepEqual(extra, [], '登记了契约外的通道')
    } finally {
      w.cleanup()
    }
  })

  it('域 handler 集合与占位集合**互不相交**，并集覆盖全部契约通道', async () => {
    const w = await wire()
    try {
      const placeholders = new Set(w.impl.placeholderChannels)
      const domain = new Set(w.registered.filter((c) => !placeholders.has(c)))
      const overlap = [...domain].filter((c) => placeholders.has(c))
      assert.deepEqual(overlap, [], '同一个通道既有实现又有占位 → 看注册顺序决定行为，无法排查')

      const union = new Set([...domain, ...placeholders])
      const uncovered = IPC_CHANNELS.filter((c) => !union.has(c))
      assert.deepEqual(uncovered, [])
      assert.equal(union.size, IPC_CHANNELS.length)
    } finally {
      w.cleanup()
    }
  })

  it('画本域、章节域、角色域、音频域、处理域、对轨域、素材域、混音域、导出域（已实现的 5 个通道）、项目包域都是「真实实现」而不是占位', async () => {
    const w = await wire()
    try {
      const placeholders = new Set(w.impl.placeholderChannels)
      for (const c of [
        ...CANVAS_CHANNELS,
        ...CHAPTER_CHANNELS,
        ...CHARACTER_CHANNELS,
        ...AUDIO_CHANNELS,
        ...PROCESSING_CHANNELS,
        ...ALIGNMENT_CHANNELS,
        ...MUSIC_CHANNELS,
        ...MIX_CHANNELS,
        ...EXPORT_CHANNELS,
        ...PACKAGE_CHANNELS,
      ]) {
        assert.ok(!placeholders.has(c), `${c} 退化成占位 → 功能静默不可用`)
      }
      // 静态自检同样不能报未知/重复
      assert.deepEqual(selfCheckHandlers(true, []).unknown, [])
      assert.deepEqual(w.impl.parity.missing, [])
    } finally {
      w.cleanup()
    }
  })

  it('导入域与画本域的任务规格都注册进了队列（否则入队时才发现 kind 未知）', async () => {
    const w = await wire()
    try {
      const queue = w.state.queue!
      // 入队即验证：未注册 kind 会被队列拒绝
      const gen = await queue.enqueue('canvas.generate', { chapterId: 'c1', options: {} }, {})
      assert.ok(gen.taskId, 'canvas.generate 的规格没注册 → 「生成画本」点了没反应')
      const rec = await queue.enqueue('canvas.recompute', { chapterId: 'c1', scope: 'all' }, {})
      assert.ok(rec.taskId)
      const imp = await queue.enqueue('book.import', { source: { kind: 'paste' } }, {})
      assert.ok(imp.taskId, '导入域规格应仍然注册（接线时别把旧的顶掉）')
      const centroid = await queue.enqueue('character.centroid', { bookId: 'b1', characterIds: [] }, {})
      assert.ok(centroid.taskId, 'character:rebuildCentroid 的规格没注册 → 点了没反应')
      // 项目包导出（.nsp）也是任务：规格没注册的话「导出项目包」只会返回 NOT_IMPLEMENTED
      const pkg = await queue.enqueue('package.export', { op: 'project', projectId: 'p1', options: {} }, {})
      assert.ok(pkg.taskId, 'package.export 的规格没注册 → 导出项目包点了没反应')
    } finally {
      w.cleanup()
    }
  })
})

describe('装配层接线 · 项目包通道真的能跑', () => {
  it('package:listHistory / lastMergeReport / inspect 都走真通道（含标准错误结构）', async () => {
    const w = await wire()
    try {
      // 空历史（刚建的项目）——必须是 []，不是「通道没实现」的失败
      const hist = await w.invoke('package:listHistory', { projectId: 'p1' })
      assert.equal(hist.ok, true, JSON.stringify(hist))
      assert.deepEqual(hist.data, [])

      const report = await w.invoke('package:lastMergeReport', { projectId: 'p1' })
      assert.equal(report.ok, true, JSON.stringify(report))
      assert.equal(report.data, null, '没有合并过 → null（不是空对象报告）')

      // 包文件不存在 → FILE_NOT_FOUND（用户要做的动作是「选对文件」）
      const missing = await w.invoke('package:inspect', {
        path: join(w.state.paths!.userData, '不存在的包.nsp'),
      })
      assert.equal(missing.ok, false)
      assert.equal(missing.error?.code, 'FILE_NOT_FOUND')

      // 项目不存在 → NOT_FOUND（历史列表不能对幽灵项目返回空数组：那看起来像「没有记录」）
      const ghost = await w.invoke('package:listHistory', { projectId: 'ghost' })
      assert.equal(ghost.ok, false)
      assert.equal(ghost.error?.code, 'NOT_FOUND')
    } finally {
      w.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// ③ 画本编辑器的数据面（渲染侧实际调用的通道 vs 主进程实现状态）
// ---------------------------------------------------------------------------

/**
 * 编辑器（含章节列表与相关 store）里出现的通道名。
 *
 * 为什么用**扫源码**而不是手写清单：手写清单会随渲染侧改动过期，
 * 而「编辑器调了一个没人实现的通道」在真机上只表现为某个面板点了没反应 ——
 * 这类缺口必须能被自动发现（docs/91 §5.2.11 记了当时的缺口清单）。
 */
function collectEditorChannels(): string[] {
  const roots = [
    join(ROOT, 'src', 'renderer', 'src', 'features', 'editor'),
    join(ROOT, 'src', 'renderer', 'src', 'features', 'book'),
  ]
  const files: string[] = []
  for (const root of roots) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.vue')) continue
      files.push(join(entry.parentPath ?? root, entry.name))
    }
  }
  const found = new Set<string>()
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    // 只认**看起来像通道名**的字符串字面量：`域:动作`（域与动作都是小写驼峰）
    for (const m of src.matchAll(/['"`]([a-z][a-zA-Z]*:[a-zA-Z][a-zA-Z]*)['"`]/g)) {
      found.add(m[1]!)
    }
  }
  return [...found].sort()
}

/**
 * 编辑器用到、但**当前仍是占位**的通道。
 *
 * 这份清单是「画本编辑器还差什么」的唯一口径；实现掉一个就会让测试变红，
 * 届时把对应项从清单里删掉即可（变红是提醒，不是故障）。
 *
 * 现在它是**空的**：`package:*` 的 5 个（exportTask / inspect / lastMergeReport /
 * listHistory / mergeTask）本轮全部实现，编辑器可见的数据面已经没有占位通道。
 * 「空数组也留着」是刻意的：下一个出现的缺口会以「清单里多了一项」的形式被发现。
 */
const EDITOR_PLACEHOLDER_CHANNELS: string[] = []

describe('装配层接线 · 画本编辑器的数据面', () => {
  it('编辑器用到的通道都存在于契约里（没有拼错的通道名）', async () => {
    const used = collectEditorChannels()
    assert.ok(used.length > 20, `扫到的通道太少（${used.length}），扫描逻辑可能失效了`)

    // 同一个 `域:动作` 命名空间里混着三类东西，只有第一类会注册成 invoke handler：
    //   · invoke 通道（IPC_CHANNELS）—— 要有 handler
    //   · 主→渲染事件（IPC_EVENT_NAMES，如 canvas:progress / task:finished）
    //   · 渲染→主单向通道（IPC_SEND_NAMES，如 record:meter）
    // 另外 Vue 的 `update:modelValue` 之类的 emit 名也长得一样，一并排除。
    const known = new Set<string>([
      ...(IPC_CHANNELS as readonly string[]),
      ...(IPC_EVENT_NAMES as readonly string[]),
      ...(IPC_SEND_NAMES as readonly string[]),
    ])
    const unknown = used.filter((c) => !known.has(c) && !c.startsWith('update:'))
    assert.deepEqual(unknown, [], '编辑器调用了契约里不存在的通道（拼写错误会表现为「点了没反应」）')
  })

  it('除已知未实现域外，编辑器依赖的通道全部已实现', async () => {
    const w = await wire()
    try {
      const placeholders = new Set(w.impl.placeholderChannels)
      // 只看 invoke 通道：事件与单向通道本来就没有 handler
      const stillPlaceholder = collectEditorChannels()
        .filter((c) => (IPC_CHANNELS as readonly string[]).includes(c) && placeholders.has(c))
        .sort()
      assert.deepEqual(
        stillPlaceholder,
        EDITOR_PLACEHOLDER_CHANNELS,
        '画本编辑器的实现状态变了：实现掉某项就把清单里的那一项删掉；新增缺口则说明有通道没人实现',
      )
    } finally {
      w.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// ② 真通道端到端（经过注册表：schema 校验 → handler → 服务 → 仓储）
// ---------------------------------------------------------------------------


describe('装配层接线 · 画本通道真的能跑', () => {
  it('canvas:insertLines → canvas:getChapter → canvas:exportText 全链路', async () => {
    const w = await wire()
    try {
      const ins = await w.invoke('canvas:insertLines', { chapterId: 'c1', afterSeq: 0, text: '甲\n乙' })
      assert.equal(ins.ok, true, JSON.stringify(ins))
      assert.equal((ins.data as unknown[]).length, 2)

      const got = await w.invoke('canvas:getChapter', { chapterId: 'c1' })
      assert.equal(got.ok, true)
      const lines = (got.data as { lines: Array<{ id: string; seq: number; text: string }>; total: number }).lines
      assert.deepEqual(lines.map((l) => l.text), ['甲', '乙'])
      assert.equal((got.data as { total: number }).total, 2)

      const exported = await w.invoke('canvas:exportText', { chapterId: 'c1', format: 'txt' })
      assert.equal(exported.ok, true, JSON.stringify(exported))
      const outPath = (exported.data as { path: string }).path
      assert.ok(
        outPath.startsWith(w.state.paths!.exportDir),
        `导出目录应取设置里的 paths.exportDir=${w.state.paths!.exportDir}，实际=${outPath}`,
      )
      // 目录是**按需创建**的：默认的 exports 目录在真机上常常还不存在，
      // 不创建的话用户会看到「文件不存在」（写入类操作报这个错完全没法行动）
      assert.ok(existsSync(outPath), '导出后文件必须真的在盘上')
    } finally {
      w.cleanup()
    }
  })

  it('画本域的失败走的是标准错误结构（不是抛到 Electron 里的裸异常）', async () => {
    const w = await wire()
    try {
      const res = await w.invoke('canvas:getLine', { lineId: 'ghost' })
      assert.equal(res.ok, false)
      assert.ok(res.error, '失败必须带 error')
      assert.equal(res.error.code, 'NOT_FOUND')
      assert.ok(res.error.message.length > 0, '必须有人话可显示（docs/22）')

      // 载荷非法 → INVALID_PAYLOAD（由注册表在进 handler 之前挡下）
      const bad = await w.invoke('canvas:insertLines', { chapterId: 'c1', afterSeq: -1, text: 'x' })
      assert.equal(bad.ok, false)
      assert.equal(bad.error?.code, 'INVALID_PAYLOAD')
    } finally {
      w.cleanup()
    }
  })

  it('章节域与画本域共用同一套库（章节标题行写进画本行表）', async () => {
    const w = await wire()
    try {
      // 通道名沿用契约里的拼写（`chapter:inserTitleLine` 少了 t，是契约既成事实；
  // 改契约名会让渲染侧与 preload 一起漂移，所以这里跟着契约走）
      const res = await w.invoke('chapter:inserTitleLine', { chapterId: 'c1' })
      assert.equal(res.ok, true, JSON.stringify(res))
      const line = res.data as { isTitle: boolean; seq: number; text: string }
      assert.equal(line.isTitle, true)
      assert.equal(line.seq, 0)
      assert.equal(line.text, '第一章')

      const chapter = await w.invoke('chapter:get', { chapterId: 'c1' })
      assert.equal(chapter.ok, true)
      assert.equal((chapter.data as { lineCount: number }).lineCount, 1, '章节的画本行数要跟着更新')
    } finally {
      w.cleanup()
    }
  })

  it('canvas:generate 通过真队列入队（返回 taskId 而不是占位错误）', async () => {
    const w = await wire()
    try {
      const res = await w.invoke('canvas:generate', {
        chapterId: 'c1',
        options: {
          useEmbedding: false,
          useLlm: false,
          contextWindow: 2,
          threshold: 0.62,
          margin: 0.06,
          ruleSetId: null,
          overwriteHuman: false,
          inferTags: true,
        },
      })
      assert.equal(res.ok, true, JSON.stringify(res))
      assert.ok((res.data as { taskId: string }).taskId)
    } finally {
      w.cleanup()
    }
  })
})
