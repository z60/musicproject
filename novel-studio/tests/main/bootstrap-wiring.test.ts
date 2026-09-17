/**
 * 测试 · 启动装配的纯逻辑部分（路径解析 / 设置存储 / 点分路径）
 * ============================================================================
 * 设计依据：docs/01 §10、docs/03 §2、docs/04 §8.2
 *
 * ### 为什么这些能测、而那些不能
 *   `src/main/index.ts` 与 `bootstrap-steps.ts` 需要真实 Electron、真实数据库、
 *   真实文件系统 —— 本仓库的测试环境都没有，因此它们**测不了**（如实记录在 docs/91 §4）。
 *
 *   但装配里最容易被写错、后果又最隐蔽的那部分其实是**纯计算**：
 *     · 便携模式判定错 → 数据写到系统目录而不是 U 盘，用户「带走」时项目全丢
 *     · `paths` 派生错 → 日志目录与数据库目录不一致，诊断包缺少日志
 *     · 设置的点分路径写错 → 用户改了设置但没生效（而且不报错）
 *     · `reset()` 漏项 → 「恢复默认」看起来成功，实际有一半没恢复
 *
 *   这几件事全部可以脱离 Electron 测，所以本文件把它们钉住。
 */

import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  PORTABLE_DATA_DIR,
  PORTABLE_MARKER,
  ffmpegCandidates,
  isPortableLayout,
  resolveAppPaths,
} from '../../src/main/paths.ts'
import { buildDefaultSettings, createSettingsStore, getByPath, setByPath } from '../../src/main/settings.ts'
import { createAppState } from '../../src/main/app-state.ts'
import { BOOT_STEPS } from '../../src/main/bootstrap/index.ts'
import { CANVAS_DEFAULTS, IMPORT_LIMITS, VAD_DEFAULTS } from '../../src/shared/constants.ts'

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

const PATHS = {
  projectRoot: '/ud/projects',
  exportDir: '/ud/exports',
  ffmpegPath: null,
  modelDir: '/res/models',
  cacheDir: '/ud/cache',
  backupDir: '/ud/backups',
}

describe('路径解析', () => {
  it('非便携模式：全部可写目录都在 userData 下', () => {
    const p = resolveAppPaths(
      { execPath: '/app/novel-studio', userDataDir: '/ud', isPackaged: false, devResourcesDir: '/repo/resources' },
      () => false,
    )
    assert.equal(p.portable, false)
    assert.equal(p.dataRoot, '/ud')
    assert.equal(p.userData, '/ud')
    assert.equal(p.projectRoot, join('/ud', 'projects'))
    assert.equal(p.logDir, join('/ud', 'logs'))
    assert.equal(p.backupDir, join('/ud', 'backups'))
    assert.equal(p.cacheDir, join('/ud', 'cache'))
    assert.equal(p.resourceDir, normalize('/repo/resources'))
  })

  it('便携模式：标记文件存在时数据改放到可执行文件同目录', () => {
    const exists = (q: string): boolean => q === join('/app', PORTABLE_MARKER)
    const p = resolveAppPaths(
      { execPath: '/app/novel-studio', userDataDir: '/ud', isPackaged: false, devResourcesDir: '/repo/resources' },
      exists,
    )
    assert.equal(p.portable, true)
    assert.equal(p.dataRoot, join('/app', PORTABLE_DATA_DIR))
    // 关键：**不再**使用 userData。否则「拷到 U 盘带走」会丢数据。
    assert.notEqual(p.userData, '/ud')
    assert.equal(p.projectRoot, join('/app', PORTABLE_DATA_DIR, 'projects'))
  })

  it('便携模式只看标记文件，不看环境变量', () => {
    assert.equal(isPortableLayout('/app/novel-studio', () => false), false)
    assert.equal(isPortableLayout('/app/novel-studio', () => true), true)
    // exists 抛错时按「非便携」处理（宁可写到标准位置，也不要因探测失败而写错地方）
    assert.equal(
      isPortableLayout('/app/novel-studio', () => {
        throw new Error('EACCES')
      }),
      false,
    )
  })

  it('打包后资源目录取 resourcesPath；未打包取仓库 resources', () => {
    const packaged = resolveAppPaths(
      {
        execPath: '/app/novel-studio',
        userDataDir: '/ud',
        isPackaged: true,
        resourcesPath: '/app/resources',
      },
      () => false,
    )
    assert.equal(packaged.resourceDir, normalize('/app/resources'))
    assert.equal(packaged.modelDir, normalize('/app/resources/models'))
  })

  it('用户覆盖的导出目录与模型目录优先', () => {
    const p = resolveAppPaths(
      {
        execPath: '/app/novel-studio',
        userDataDir: '/ud',
        isPackaged: false,
        devResourcesDir: '/repo/resources',
        exportDirOverride: '/mnt/nas/audio',
        modelDirOverride: '/mnt/models',
      },
      () => false,
    )
    assert.equal(p.exportDir, resolve('/mnt/nas/audio'))
    assert.equal(p.modelDir, resolve('/mnt/models'))
  })

  it('空字符串覆盖视为「没有覆盖」（设置里清空路径不该生成空目录）', () => {
    const p = resolveAppPaths(
      {
        execPath: '/app/novel-studio',
        userDataDir: '/ud',
        isPackaged: false,
        devResourcesDir: '/repo/resources',
        exportDirOverride: '   ',
      },
      () => false,
    )
    assert.equal(p.exportDir, join('/ud', 'exports'))
  })

  it('ffmpeg 候选顺序：用户指定 > 随包 > PATH', () => {
    const c = ffmpegCandidates({
      paths: { resourceDir: '/repo/resources' },
      settingsFfmpegPath: '/opt/ffmpeg/bin/ffmpeg',
      platform: 'linux',
    })
    assert.equal(c[0], '/opt/ffmpeg/bin/ffmpeg')
    assert.equal(c[1], join('/repo', 'resources', 'bin', 'ffmpeg'))
    assert.equal(c[2], 'ffmpeg')
  })

  it('Windows 下候选带 .exe 后缀（否则永远探测不到随包的 ffmpeg）', () => {
    const c = ffmpegCandidates({ paths: { resourceDir: 'C:\\app\\resources' }, platform: 'win32' })
    assert.equal(c[0], 'C:\\app\\resources\\bin\\ffmpeg.exe')
  })
})

// ---------------------------------------------------------------------------
// 点分路径读写
// ---------------------------------------------------------------------------

describe('点分路径读写', () => {
  const tree = { audio: { sampleRate: 48000, nested: { deep: 1 } }, ui: { theme: 'system' } }

  it('取值', () => {
    assert.equal(getByPath(tree, 'audio.sampleRate'), 48000)
    assert.equal(getByPath(tree, 'audio.nested.deep'), 1)
    assert.equal(getByPath(tree, 'audio.missing'), undefined)
    assert.equal(getByPath(tree, 'nothing.at.all'), undefined)
    assert.equal(getByPath(null, 'a.b'), undefined)
  })

  it('写值：只写已存在的叶子（防拼写错误悄悄塞进新 key）', () => {
    const t = structuredClone(tree)
    assert.equal(setByPath(t, 'audio.sampleRate', 44100), true)
    assert.equal(getByPath(t, 'audio.sampleRate'), 44100)

    // 不存在的路径必须返回 false，而不是「创建」它 ——
    // 否则一个拼错的 key 会永远躺在设置树里，谁也发现不了
    assert.equal(setByPath(t, 'audio.sampleRatee', 44100), false)
    assert.equal(setByPath(t, 'audio.deep.missing', 1), false)
    assert.equal(getByPath(t, 'audio.sampleRatee'), undefined)
  })
})

// ---------------------------------------------------------------------------
// 设置存储
// ---------------------------------------------------------------------------

describe('设置存储（无数据库的降级模式）', () => {
  it('默认值来自 constants，且结构完整', () => {
    const d = buildDefaultSettings({ paths: PATHS })
    assert.equal(d.audio.sampleRate, 48000)
    assert.equal(d.export.mp3Bitrate, 192)
    assert.equal(d.export.m4bBitrate, 96)
    // VAD 默认值整棵来自 constants.VAD_DEFAULTS（不在这里重复写字面量）
    assert.deepEqual(d.recording.vad, { ...VAD_DEFAULTS })
    assert.equal(d.canvas.maxLineChars, CANVAS_DEFAULTS.maxLineChars)
    assert.equal(d.canvas.attributionThreshold, CANVAS_DEFAULTS.attributionThreshold)
    assert.equal(d.import.maxFileSizeBytes, IMPORT_LIMITS.maxFileSizeBytes)
    // 默认值必须是「可用的合法配置」：格式是契约允许的枚举值之一
    assert.ok(['mp3', 'wav', 'm4a'].includes(d.export.format))
    assert.ok(['line_by_line', 'continuous', 'role', 'punch_in', 'package'].includes(d.recording.defaultMode))
  })

  it('set 返回变化的 key，并且只影响命中的分支', () => {
    const s = createSettingsStore({ db: null, pathDefaults: PATHS })
    const r = s.set({ 'audio.sampleRate': 44100, 'ui.theme': 'dark' })
    assert.deepEqual(r.changedKeys.sort(), ['audio.sampleRate', 'ui.theme'])
    const all = s.getAll()
    assert.equal(all.audio.sampleRate, 44100)
    assert.equal(all.ui.theme, 'dark')
    // 同层的其它字段不受影响
    assert.equal(all.audio.bitDepth, 24)
  })

  it('set 支持嵌套对象写法（两种写法等价）', () => {
    const a = createSettingsStore({ db: null, pathDefaults: PATHS })
    const b = createSettingsStore({ db: null, pathDefaults: PATHS })
    a.set({ 'audio.sampleRate': 44100 })
    b.set({ audio: { sampleRate: 44100 } })
    assert.deepEqual(a.getAll().audio, b.getAll().audio)
  })

  it('未知 key 被忽略，不会污染设置树', () => {
    const s = createSettingsStore({ db: null, pathDefaults: PATHS })
    const r = s.set({ 'audio.notARealKey': 1, 'nope.deep': 2 })
    assert.deepEqual(r.changedKeys, [])
    assert.equal(getByPath(s.getAll(), 'audio.notARealKey'), undefined)
    assert.equal(getByPath(s.getAll(), 'nope'), undefined)
  })

  it('get(keys) 只返回命中的分支，未命中的分支被移除', () => {
    const s = createSettingsStore({ db: null, pathDefaults: PATHS })
    const only = s.get(['audio'])
    assert.equal(only.audio.sampleRate, 48000)
    // 未命中的分支被**整棵删除**（不是留下空对象）：
    // 留下 `ui: {}` 会让调用方以为「读到了 ui 设置，只是全为空」。
    assert.equal(only.ui, undefined)
    assert.deepEqual(Object.keys(only), ['audio'])
    // 深拷贝：改返回值不影响内部状态
    only.audio.sampleRate = 44100
    assert.equal(s.getAll().audio.sampleRate, 48000)
  })

  it('reset 恢复默认值', () => {
    const s = createSettingsStore({ db: null, pathDefaults: PATHS })
    s.set({ 'audio.sampleRate': 44100, 'ui.theme': 'dark' })
    s.reset(['audio.sampleRate'])
    assert.equal(s.getAll().audio.sampleRate, 48000)
    // 未指定的 key 保持不变
    assert.equal(s.getAll().ui.theme, 'dark')

    s.reset()
    assert.equal(s.getAll().ui.theme, 'system')
  })

  it('set 的返回值是深拷贝，调用方改不脏内部状态', () => {
    const s = createSettingsStore({ db: null, pathDefaults: PATHS })
    const snap = s.getAll()
    snap.advanced.logLevel = 'trace'
    snap.audio.sampleRate = 44100
    assert.notEqual(s.getAll().advanced.logLevel, 'trace')
    assert.equal(s.getAll().audio.sampleRate, 48000)
  })
})

// ---------------------------------------------------------------------------
// electron-vite 入口约定
// ---------------------------------------------------------------------------

/** 仓库根（本文件在 tests/main/ 下） */
const ROOT = resolve(import.meta.dirname, '..', '..')

describe('electron-vite 入口约定（写错的话 npm run dev 起不来）', () => {

  it('三个入口都在 electron-vite 的约定路径上', () => {
    // electron-vite 的解析规则（读它的 dist 得到，不是猜的）：
    //   findLibEntry(root, 'main')     → src/main/{index,main}.{js,ts,mjs,cjs}
    //   findLibEntry(root, 'preload')  → src/preload/{index,preload}.{js,ts,mjs,cjs}
    //   findInput(root, 'renderer')    → src/renderer/index.html
    for (const rel of ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/index.html']) {
      assert.ok(existsSync(join(ROOT, rel)), `缺少 electron-vite 约定的入口：${rel}`)
    }
  })

  it('主进程入口没有被误放进 src/main/preload.ts（preload 不属于主进程目录）', () => {
    // 历史问题：preload 曾经在 src/main/preload.ts，electron-vite 根本不会把它当入口，
    // 症状是「构建产物里没有 preload → 窗口能开但没有 window.api」。
    assert.equal(
      existsSync(join(ROOT, 'src/main/preload.ts')),
      false,
      'src/main/preload.ts 不应该存在；preload 入口必须是 src/preload/index.ts',
    )
  })

  it('全局 __dirname 不出现在主进程入口里（ESM 下不可靠）', () => {
    const src = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    // 注释里提到它没关系，但真实代码（含 `__dirname` 且不在注释行）不行
    const codeLines = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .filter((l) => l.includes('__dirname'))
    assert.deepEqual(codeLines, [], '主进程是 ESM 产物，__dirname 不是语言内建；请用 import.meta.url')
  })

  it('主进程入口确实调用了 registerAllHandlers（否则契约通道一个都没注册）', () => {
    const src = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    assert.ok(src.includes('registerAllHandlers'), '入口必须调用 registerAllHandlers')
    assert.ok(src.includes('runBootSequence'), '入口必须跑启动顺序')
    assert.ok(src.includes('buildHandlerDeps'), '入口必须装配 HandlerDeps')
  })

  it('入口在 whenReady 之后才碰 app.getPath', () => {
    const src = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    const readyAt = src.indexOf('whenReady')
    assert.ok(readyAt > 0, '入口必须 await app.whenReady()：ready 之前调 Electron API 会抛错')

    // 只检查**代码行**里的 .getPath(：注释里出现它（例如说明「必须在 ready 之后」）
    // 不算违规 —— 否则测试会因为解释性注释而误报，而误报会让人干脆删掉注释。
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')
    const getPathAt = code.indexOf('.getPath(')
    assert.ok(
      getPathAt < 0 || code.slice(0, getPathAt).includes('whenReady'),
      'app.getPath 在 whenReady 之前被调用 —— ready 前调用会失败，症状是「应用一闪而过」',
    )
  })

  it('协议权限声明在 whenReady 之前（Electron 硬要求）', () => {
    const strip = (s: string): string =>
      s
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')

    const code = strip(readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8'))
    const readyAt = code.indexOf('await electron.app.whenReady()')
    const privilegesAt = code.indexOf('registerMediaSchemePrivileges(')

    assert.ok(privilegesAt > 0, '入口必须调用 registerMediaSchemePrivileges')
    assert.ok(
      privilegesAt < readyAt,
      '注册协议权限必须在 whenReady **之前** —— ready 之后 Electron 会直接抛错。\n' +
        '真机上第一次启动就撞在这里：启动流程第 11 步（ready 之后）调用它，0ms 就失败。',
    )

    // 反向断言：bootstrap-steps 的步骤都在 ready 之后执行，不该再调用它
    const stepsCode = strip(readFileSync(join(ROOT, 'src/main/bootstrap-steps.ts'), 'utf8'))
    assert.equal(
      stepsCode.includes('registerMediaSchemePrivileges('),
      false,
      'bootstrap-steps 在 ready 之后运行，不能再调用 registerMediaSchemePrivileges（时机要求）',
    )
  })
})

// ---------------------------------------------------------------------------
// 构建产物：运行时需要的非 JS 资源
// ---------------------------------------------------------------------------

describe('迁移 SQL 必须进构建产物', () => {
  /**
   * 防的是一个**静默故障**：
   * 迁移 SQL 是运行时 `readFileSync` 读的，打包器不认识 `.sql`、不会带进 bundle。
   * 少了它，应用照样起窗口，但 `db.opened schemaVersion: 0` —— **一张表都没有**，
   * 而日志里只有一句 `DB_MIGRATION_FAILED`，完全看不出是「文件没被复制」。
   */
  it('electron.vite.config.ts 里挂了复制运行时资源的插件', () => {
    const src = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8')
    assert.ok(src.includes('writeBundle'), '必须挂 writeBundle（dev 与 build 都走 vite 插件）')
    assert.ok(
      src.includes('main/infra/db/migrations'),
      '插件必须把 src/main/infra/db/migrations 复制到 out/main/infra/db/migrations',
    )
  })

  it('迁移 SQL 源文件存在（目录名与插件配置一致）', () => {
    const dir = join(ROOT, 'src', 'main', 'infra', 'db', 'migrations')
    assert.ok(existsSync(dir), '迁移目录不存在')
    const sqls = readdirSync(dir).filter((n) => n.endsWith('.sql'))
    assert.ok(sqls.length >= 2, `期望至少 2 个迁移 SQL，实际 ${sqls.length}`)
    assert.ok(sqls.includes('001_init.sql'), '缺少 001_init.sql')
  })

  it('迁移 SQL 已按 LF 归一化（hash 是按 LF 算的，CRLF 会让校验失败）', () => {
    // hash 不一致会让 migrate 拒绝启动，报「hash-mismatch」——
    // 那看起来像「有人改了已发布的迁移」，实际可能只是文件被 CRLF 化了。
    const dir = join(ROOT, 'src', 'main', 'infra', 'db', 'migrations')
    for (const file of ['001_init.sql', '002_seed.sql']) {
      const sql = readFileSync(join(dir, file), 'utf8')
      assert.ok(sql.length > 1000, `${file} 内容异常小，可能被截断`)
      assert.equal(sql.includes('\r'), false, `${file} 含 CR；hash 是按 LF 算的，会导致校验失败`)
    }
  })
})

// ---------------------------------------------------------------------------
// 启动步骤与 handler 的对应关系
// ---------------------------------------------------------------------------

describe('启动步骤与 handler 一一对应', () => {
  /**
   * 这个断言的价值在于**缺一步不会报错**：
   * `runBootSequence` 对没提供实现的步骤只记一条 `skipped`，然后继续往下跑。
   * 于是「忘了写 open-database 的 handler」这种错误的表现是
   * 「应用起来了，但数据库永远没打开」—— 而不是启动失败。必须静态守住。
   */
  it('BOOT_STEPS 的每个 id 都有对应的 handler 实现，且没有多余键', () => {
    const src = readFileSync(join(ROOT, 'src/main/bootstrap-steps.ts'), 'utf8')
    // handler 表的键都缩进 4 空格（在 `return {` 内）
    const handlerKeys = [...src.matchAll(/^\s{4}'([a-z0-9-]+)':/gm)].map((m) => m[1]!)
    const ids = BOOT_STEPS.map((s) => s.id)

    const missing = ids.filter((id) => !handlerKeys.includes(id))
    const extra = handlerKeys.filter((k) => !(ids as readonly string[]).includes(k))

    assert.deepEqual(missing, [], `这些启动步骤没有 handler（会被静默跳过）：${missing.join(', ')}`)
    assert.deepEqual(extra, [], `handler 表里有不在 BOOT_STEPS 里的键：${extra.join(', ')}`)
    assert.equal(handlerKeys.length, ids.length, 'handler 数量与启动步骤数量必须相等')
  })

  it('恢复必须在清理之前（顺序错了会删掉待修复的录音）', () => {
    const ids = BOOT_STEPS.map((s) => s.id)
    const recoverAt = ids.indexOf('recover-crashed-recordings')
    const cleanupAt = ids.indexOf('cleanup-temp-and-cache')
    assert.ok(recoverAt >= 0 && cleanupAt >= 0, '两个步骤都必须存在')
    assert.ok(
      recoverAt < cleanupAt,
      'recover-crashed-recordings 必须在 cleanup-temp-and-cache 之前 —— docs/01 §10「5 必须在 6 之前」',
    )
  })

  it('日志必须在数据库之前（数据库出问题要留日志）', () => {
    const ids = BOOT_STEPS.map((s) => s.id)
    assert.ok(
      ids.indexOf('init-logger') < ids.indexOf('open-database'),
      'init-logger 必须在 open-database 之前 —— docs/01 §10「3 必须在 4 之前」',
    )
  })
})

describe('启动状态', () => {
  it('未按顺序使用时立刻报错，而不是静默返回 null', () => {
    const state = createAppState()
    // 这条纪律很重要：如果 requirePaths() 返回 null，错误会在几百行之后
    // 以「Cannot read property of null」的形式出现，根因完全看不出来
    assert.throws(() => state.requirePaths(), /启动顺序错误/)
    assert.throws(() => state.requireDb(), /启动顺序错误/)
    assert.throws(() => state.requireSettings(), /启动顺序错误/)
    assert.throws(() => state.requireWindow(), /启动顺序错误/)
  })

  it('日志器未就绪时也能记日志（不抛错、不静默丢弃）', () => {
    const state = createAppState()
    assert.doesNotThrow(() => state.log().error('test.event', { a: 1 }))
    assert.doesNotThrow(() => state.log().errorFields(new Error('x'), 'test.errorFields'))
  })

  it('未打开数据库时不可写', () => {
    const state = createAppState()
    assert.equal(state.canWrite(), false)
  })

  it('只读模式下即使有数据库也不可写', () => {
    const state = createAppState()
    // 直接注入一个假句柄：只验证 canWrite 的判定逻辑，不碰真实 sqlite
    ;(state as unknown as { db: unknown }).db = { prepare: () => ({}) }
    assert.equal(state.canWrite(), true)
    state.readOnly = true
    assert.equal(state.canWrite(), false)
  })

  it('dispose 可重复调用（退出路径可能被触发两次）', async () => {
    const state = createAppState()
    await state.dispose()
    await assert.doesNotReject(() => state.dispose())
  })
})
