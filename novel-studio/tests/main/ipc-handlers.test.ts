/**
 * IPC handler 层测试（不需要 Electron / SQLite / 网络）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §10 测试要点
 *
 * 这组测试的价值：handler 层是「业务与传输的接缝」，最容易出现
 * 「登记了契约里没有的通道」「重复登记」「少实现一个通道却没人发现」这类问题。
 * 这里用**假注册器 + 假依赖**把它钉住，因此无需 Electron 即可运行。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { IPC_CHANNELS } from '../../src/shared/ipc.ts'
import { ALL_HANDLERS, listImplementedChannels, registerAllHandlers, selfCheckHandlers } from '../../src/main/ipc/handlers/index.ts'
import type { HandlerDeps, RegistrarLike } from '../../src/main/ipc/handlers/index.ts'

// ---------------------------------------------------------------------------
// 假实现
// ---------------------------------------------------------------------------

interface RecordedCall {
  channel: string
  fallbackKey?: string
}

function createFakeRegistrar(): { registrar: RegistrarLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const registrar: RegistrarLike = {
    register(channel, _schema, _run, options) {
      calls.push(options.fallbackKey !== undefined
        ? { channel, fallbackKey: options.fallbackKey }
        : { channel })
    },
  }
  return { registrar, calls }
}

/** 记录调用的假服务集合 */
interface Spies {
  openExternal: string[]
  showItemInFolder: string[]
  quit: boolean[]
  settingsSet: Array<Record<string, unknown>>
  setSecret: Array<{ key: string; value: string }>
  emitted: Array<{ event: string; payload: unknown }>
  logInfo: string[]
  cancelTask: string[]
}

function createFakeDeps(): { deps: HandlerDeps; spies: Spies } {
  const spies: Spies = {
    openExternal: [],
    showItemInFolder: [],
    quit: [],
    settingsSet: [],
    setSecret: [],
    emitted: [],
    logInfo: [],
    cancelTask: [],
  }

  const noopLog = {
    level: 'info' as const,
    setLevel: () => void 0,
    error: (event: string) => { spies.logInfo.push(`error:${event}`) },
    warn: (event: string) => { spies.logInfo.push(`warn:${event}`) },
    info: (event: string) => { spies.logInfo.push(`info:${event}`) },
    debug: () => void 0,
    trace: () => void 0,
    errorFields: () => void 0,
    child: () => noopLog,
    write: () => void 0,
    addSink: () => void 0,
    setEntryListener: () => void 0,
    recent: () => [],
  }

  const deps = {
    log: noopLog,
    env: {
      getInfo: () => ({
        version: '0.1.0', electron: '31.0.0', node: '20.0.0', chrome: '126',
        platform: 'win32', arch: 'x64', isPackaged: false, portable: false,
      }),
      getPaths: () => ({
        userData: 'C:/u', projectRoot: 'C:/u/projects', exportDir: 'C:/u/exports',
        cacheDir: 'C:/u/cache', logDir: 'C:/u/logs', backupDir: 'C:/u/backups',
        modelDir: 'C:/r/models', resourceDir: 'C:/r',
      }),
      openExternal: async (url: string) => { spies.openExternal.push(url) },
      showItemInFolder: (p: string) => { spies.showItemInFolder.push(p) },
      pickFolder: async () => 'C:/picked',
      pickFiles: async () => ['C:/a.txt', 'C:/b.txt'],
      pickSavePath: async () => 'C:/out.mp3',
      quit: (force: boolean) => { spies.quit.push(force) },
    },
    capabilities: {
      getCapabilities: async () => ({
        ffmpeg: { version: '6.1', available: true, path: 'C:/ffmpeg.exe', filters: ['loudnorm'], missing: [], encoders: ['libmp3lame'] },
        models: [],
        secureStorage: true,
        embedding: { modelId: 'bge-small-zh-v1.5', dim: 512, available: true },
      }),
      refresh: async () => ({ ffmpeg: { version: '6.1', available: true, path: null, filters: [], missing: [], encoders: [] }, models: [], secureStorage: true, embedding: { modelId: 'x', dim: 512, available: false } }),
    },
    settings: {
      getAll: () => ({}) as never,
      get: () => ({}) as never,
      set: (patch: Record<string, unknown>) => {
        spies.settingsSet.push(patch)
        return { changedKeys: Object.keys(patch) }
      },
      setSecret: (key: string, value: string) => { spies.setSecret.push({ key, value }) },
      reset: () => void 0,
    },
    tasks: {
      list: () => [],
      get: (id: string) => (id === 't1' ? { id: 't1', kind: 'book.import', status: 'running' } as never : null),
      cancel: (id: string) => { spies.cancelTask.push(id); return true },
      retry: (id: string) => (id === 't1' ? { taskId: 't2' } : null),
      clearFinished: () => 3,
      result: () => ({ done: true }),
    },
    db: {
      backup: async () => ({ path: 'C:/u/backups/b.db' }),
      listBackups: () => [],
      restore: async () => void 0,
      integrityCheck: () => ({ ok: true, errors: [] }),
      stats: () => ({ sizeBytes: 1024, schemaVersion: 2, tables: [{ name: 'books', rows: 1 }] }),
    },
    diagnostics: { export: async () => ({ reportPath: 'C:/u/diag.zip' }) },
    provider: { test: async () => ({ ok: true, message: 'ok', latencyMs: 42 }) },
    events: {
      emit: (event: string, payload: unknown) => { spies.emitted.push({ event, payload }) },
    },
  } as unknown as HandlerDeps

  return { deps, spies }
}

/** 按通道取 handler 并执行 */
async function invoke(channel: string, payload: unknown, deps: HandlerDeps): Promise<unknown> {
  const spec = ALL_HANDLERS.find(h => h.channel === channel)
  assert.ok(spec, `未找到通道的 handler：${channel}`)
  const raw = spec.schema.parse(payload)
  return await spec.run(raw as never, deps)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('handler 自检', () => {
  it('每个登记的通道都存在于契约中', () => {
    const check = selfCheckHandlers()
    assert.deepEqual(check.unknown, [], `登记了契约外的通道：\n${check.unknown.join('\n')}`)
  })

  it('没有重复登记的通道', () => {
    const check = selfCheckHandlers()
    assert.deepEqual(check.duplicates, [], `重复登记：\n${check.duplicates.join('\n')}`)
  })

  it('strict 模式在有问题时抛错（好的时候不抛）', () => {
    assert.doesNotThrow(() => selfCheckHandlers(true))
  })

  it('登记表非空且通道名唯一', () => {
    assert.ok(ALL_HANDLERS.length > 0)
    const channels = ALL_HANDLERS.map(h => h.channel)
    assert.equal(new Set(channels).size, channels.length)
  })

  it('每个 handler 都提供了 schema 与 run', () => {
    for (const h of ALL_HANDLERS) {
      assert.equal(typeof h.schema?.parse, 'function', `${h.channel} 缺少 schema.parse`)
      assert.equal(typeof h.run, 'function', `${h.channel} 缺少 run`)
    }
  })

  it('未实现的通道清单准确（missing = 契约 - 已实现）', () => {
    const check = selfCheckHandlers()
    assert.equal(check.missing.length, IPC_CHANNELS.length - check.implemented.length)
    for (const m of check.missing) {
      assert.ok(!check.implemented.includes(m), `${m} 不应同时出现在已实现与未实现清单里`)
    }
  })
})

describe('registerAllHandlers', () => {
  it('把全部 handler 交给注册器，且通道名与清单一致', () => {
    const { registrar, calls } = createFakeRegistrar()
    const { deps } = createFakeDeps()
    const result = registerAllHandlers(registrar, deps)

    assert.equal(calls.length, ALL_HANDLERS.length)
    assert.deepEqual(calls.map(c => c.channel).sort(), listImplementedChannels())
    assert.equal(result.implemented.length, ALL_HANDLERS.length)
  })

  it('透传 fallbackKey（错误兜底第二级要用它）', () => {
    const { registrar, calls } = createFakeRegistrar()
    const { deps } = createFakeDeps()
    registerAllHandlers(registrar, deps)

    const dbRestore = calls.find(c => c.channel === 'db:restore')
    assert.equal(dbRestore?.fallbackKey, 'DB_RESTORE_FAILED')
    const providerTest = calls.find(c => c.channel === 'settings:testProvider')
    assert.equal(providerTest?.fallbackKey, 'PROVIDER_UNAVAILABLE')
  })

  it('写日志记录注册数量（便于启动时发现覆盖不足）', () => {
    const { registrar } = createFakeRegistrar()
    const { deps, spies } = createFakeDeps()
    registerAllHandlers(registrar, deps)
    assert.ok(spies.logInfo.some(e => e === 'info:ipc.handlers.registered'))
  })
})

describe('app 域行为', () => {
  it('app:getInfo 返回运行环境信息', async () => {
    const { deps } = createFakeDeps()
    const info = await invoke('app:getInfo', undefined, deps) as { version: string; node: string }
    assert.equal(info.version, '0.1.0')
    assert.ok(info.node)
  })

  it('app:openExternal 只允许 http/https', async () => {
    const { deps, spies } = createFakeDeps()

    await invoke('app:openExternal', { url: 'https://example.com/x' }, deps)
    assert.equal(spies.openExternal.length, 1)

    // file:// 必须被拒（否则可被利用读本地文件）
    await assert.rejects(() => invoke('app:openExternal', { url: 'file:///C:/secret.txt' }, deps))
    // javascript: 必须被拒
    await assert.rejects(() => invoke('app:openExternal', { url: 'javascript:alert(1)' }, deps))
    // 非法 URL 必须被拒
    await assert.rejects(() => invoke('app:openExternal', { url: 'not a url' }, deps))

    assert.equal(spies.openExternal.length, 1, '被拒的调用不应触达 env.openExternal')
  })

  it('app:showItemInFolder 透传路径', async () => {
    const { deps, spies } = createFakeDeps()
    await invoke('app:showItemInFolder', { path: 'C:/u/exports/a.mp3' }, deps)
    assert.deepEqual(spies.showItemInFolder, ['C:/u/exports/a.mp3'])
  })

  it('文件对话框返回可选路径', async () => {
    const { deps } = createFakeDeps()
    assert.deepEqual(await invoke('app:openFolderDialog', {}, deps), { path: 'C:/picked' })
    assert.deepEqual(await invoke('app:openFileDialog', { multi: true }, deps), { paths: ['C:/a.txt', 'C:/b.txt'] })
    assert.deepEqual(await invoke('app:saveFileDialog', {}, deps), { path: 'C:/out.mp3' })
  })

  it('app:quit 区分强制与非强制', async () => {
    const { deps, spies } = createFakeDeps()
    await invoke('app:quit', {}, deps)
    await invoke('app:quit', { force: true }, deps)
    assert.deepEqual(spies.quit, [false, true])
  })

  it('app:diagnostics 返回诊断包路径并记日志', async () => {
    const { deps, spies } = createFakeDeps()
    const r = await invoke('app:diagnostics', undefined, deps) as { reportPath: string }
    assert.equal(r.reportPath, 'C:/u/diag.zip')
    assert.ok(spies.logInfo.includes('info:ipc.app.diagnostics.exported'))
  })

  it('app:getCapabilities 走能力端口（不直接探测）', async () => {
    const { deps } = createFakeDeps()
    const caps = await invoke('app:getCapabilities', undefined, deps) as { ffmpeg: { available: boolean } }
    assert.equal(caps.ffmpeg.available, true)
  })
})

describe('settings 域行为', () => {
  it('settings:set 写入并广播 settings:changed', async () => {
    const { deps, spies } = createFakeDeps()
    const r = await invoke('settings:set', { patch: { 'audio.sampleRate': 48000 } }, deps) as { changedKeys: string[] }
    assert.deepEqual(r.changedKeys, ['audio.sampleRate'])
    const evt = spies.emitted.find(e => e.event === 'settings:changed')
    assert.ok(evt, '必须广播改变，否则各 store 不知道要响应')
  })

  it('settings:setSecret 不把值写进日志', async () => {
    const { deps, spies } = createFakeDeps()
    await invoke('settings:setSecret', { key: 'ai.apiKey', value: 'sk-super-secret-value' }, deps)

    assert.deepEqual(spies.setSecret, [{ key: 'ai.apiKey', value: 'sk-super-secret-value' }])
    const leaked = spies.logInfo.filter(line => line.includes('sk-super-secret-value'))
    assert.deepEqual(leaked, [], `密钥泄露到日志：${leaked.join(', ')}`)
  })

  it('settings:testProvider 失败时返回 ok:false 而不是抛错（设置页要展示原因）', async () => {
    const { deps } = createFakeDeps()
    const failing = {
      ...deps,
      provider: { test: async () => { throw new Error('401 Unauthorized') } },
    } as HandlerDeps
    const r = await invoke('settings:testProvider', { provider: {} }, failing) as { ok: boolean; message: string }
    assert.equal(r.ok, false)
    assert.match(r.message, /401/)
  })

  it('settings:reset 广播变更', async () => {
    const { deps, spies } = createFakeDeps()
    await invoke('settings:reset', {}, deps)
    assert.ok(spies.emitted.some(e => e.event === 'settings:changed'))
  })
})

describe('task 域行为', () => {
  it('task:get 对不存在的任务抛错（由 registry 兜底成 TASK_NOT_FOUND）', async () => {
    const { deps } = createFakeDeps()
    await assert.rejects(() => invoke('task:get', { taskId: 'nope' }, deps))
  })

  it('task:get 返回已有任务', async () => {
    const { deps } = createFakeDeps()
    const t = await invoke('task:get', { taskId: 't1' }, deps) as { id: string }
    assert.equal(t.id, 't1')
  })

  it('task:cancel 记录日志并返回是否受理', async () => {
    const { deps, spies } = createFakeDeps()
    const r = await invoke('task:cancel', { taskId: 't1' }, deps) as { ok: boolean }
    assert.equal(r.ok, true)
    assert.deepEqual(spies.cancelTask, ['t1'])
  })

  it('task:retry 对不可重试的任务抛错', async () => {
    const { deps } = createFakeDeps()
    await assert.rejects(() => invoke('task:retry', { taskId: 'nope' }, deps))
    assert.deepEqual(await invoke('task:retry', { taskId: 't1' }, deps), { taskId: 't2' })
  })

  it('task:clearFinished 返回清理数量', async () => {
    const { deps } = createFakeDeps()
    assert.deepEqual(await invoke('task:clearFinished', undefined, deps), { cleared: 3 })
  })
})

describe('db 域行为', () => {
  it('db:restore 会记 warn 级日志（破坏性操作要可审计）', async () => {
    const { deps, spies } = createFakeDeps()
    await invoke('db:restore', { path: 'C:/u/backups/old.db' }, deps)
    assert.ok(spies.logInfo.includes('warn:ipc.db.restore.start'))
    assert.ok(spies.logInfo.includes('warn:ipc.db.restore.done'))
  })

  it('db:integrityCheck 失败时记 error 日志', async () => {
    const { deps, spies } = createFakeDeps()
    const broken = { ...deps, db: { ...deps.db, integrityCheck: () => ({ ok: false, errors: ['page 3 corrupt'] }) } } as HandlerDeps
    const r = await invoke('db:integrityCheck', undefined, broken) as { ok: boolean; errors: string[] }
    assert.equal(r.ok, false)
    assert.ok(spies.logInfo.includes('error:ipc.db.integrityCheck.failed'))
  })

  it('db:stats 返回表统计', async () => {
    const { deps } = createFakeDeps()
    const s = await invoke('db:stats', undefined, deps) as { tables: Array<{ name: string }> }
    assert.deepEqual(s.tables.map(t => t.name), ['books'])
  })
})

describe('日志与能力域行为', () => {
  it('log:subscribe 调整日志级别', async () => {
    const { deps } = createFakeDeps()
    const r = await invoke('log:subscribe', { level: 'debug' }, deps) as { ok: boolean }
    assert.equal(r.ok, true)
  })

  it('ffmpeg:capabilities 只返回 ffmpeg 部分', async () => {
    const { deps } = createFakeDeps()
    const caps = await invoke('ffmpeg:capabilities', undefined, deps) as { version: string; filters: string[] }
    assert.equal(caps.version, '6.1')
    assert.deepEqual(caps.filters, ['loudnorm'])
  })
})

describe('契约完整性：handler 层不得擅自扩展契约', () => {
  it('handler 数量不超过契约通道总数', () => {
    assert.ok(ALL_HANDLERS.length <= IPC_CHANNELS.length)
  })

  it('listImplementedChannels 是 ALL_HANDLERS 通道的有序去重子集', () => {
    const fromList = listImplementedChannels()
    const fromArray = [...new Set(ALL_HANDLERS.map(h => h.channel))].sort()
    assert.deepEqual(fromList, fromArray)
    for (const c of fromList) assert.ok(IPC_CHANNELS.includes(c as never), `${c} 不在契约中`)
  })
})
