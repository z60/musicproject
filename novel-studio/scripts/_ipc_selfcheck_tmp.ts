/**
 * 临时自检脚本（不属于交付物）：用假依赖把全部 handler 注册一遍，验证契约完整性。
 */
import { createInMemoryIpcMain } from '../src/main/ipc/registry.ts'
import { registerAllHandlers } from '../src/main/ipc/index.ts'
import { createMemoryTaskStore, TaskQueue } from '../src/main/infra/queue/index.ts'
import { createLogger, createMemorySink } from '../src/main/infra/log/index.ts'

const sink = createMemorySink(2000)
const log = createLogger({ level: 'debug', sinks: [sink] })

const queue = new TaskQueue({
  specs: [{ kind: 'cache.clean', run: async () => ({ cleaned: 0 }) }],
  store: createMemoryTaskStore(),
  makeTempDir: async () => 'tmp-x',
  removeTempDir: async () => undefined,
})

const ipcMain = createInMemoryIpcMain()

const result = registerAllHandlers(
  {
    log,
    env: {
      getInfo: () => ({
        version: '0.1.0',
        electron: '31.7.0',
        node: '22.20.0',
        chrome: '126',
        platform: 'win32',
        arch: 'x64',
        isPackaged: false,
        portable: false,
      }),
      getPaths: () => ({
        userData: 'C:/ud',
        projectRoot: 'C:/ud/projects',
        exportDir: 'C:/ud/exports',
        cacheDir: 'C:/ud/cache',
        logDir: 'C:/ud/logs',
        backupDir: 'C:/ud/backups',
        modelDir: 'C:/ud/models',
        resourceDir: 'C:/res',
      }),
      openExternal: async () => undefined,
      showItemInFolder: () => undefined,
      pickFolder: async () => null,
      pickFiles: async () => [],
      pickSavePath: async () => null,
      quit: () => undefined,
    },
    capabilities: { getCapabilities: async () => ({ ffmpeg: { version: 'n/a', available: false, path: null, filters: [], missing: [], encoders: [] }, models: [], secureStorage: false, embedding: { modelId: 'none', dim: 0, available: false } }), refresh: async () => ({ ffmpeg: { version: 'n/a', available: false, path: null, filters: [], missing: [], encoders: [] }, models: [], secureStorage: false, embedding: { modelId: 'none', dim: 0, available: false } }) },
    settings: {
      getAll: () => ({}) as never,
      get: () => ({}) as never,
      set: () => ({ changedKeys: ['audio.sampleRate'] }),
      setSecret: () => undefined,
      reset: () => undefined,
    },
    tasks: {
      list: () => queue.list(),
      get: (id: string) => queue.get(id),
      cancel: (id: string) => queue.cancel(id),
      retry: async (id: string) => ({ taskId: await queue.retry(id) }),
      clearFinished: () => queue.clearFinished(),
      result: (id: string) => queue.result(id),
    },
    db: {
      backup: async () => ({ path: 'C:/ud/backups/x.db' }),
      listBackups: () => [],
      restore: async () => undefined,
      integrityCheck: () => ({ ok: true, errors: [] }),
      stats: () => ({ sizeBytes: 1, schemaVersion: 2, tables: [] }),
    },
    diagnostics: { export: async () => ({ reportPath: 'C:/ud/diag.zip' }) },
    provider: { test: async () => ({ ok: true, message: 'ok', latencyMs: 1 }) },
    events: { emit: () => undefined },
  },
  { ipcMain },
)

console.log('implemented', result.implemented, 'placeholders', result.placeholders, 'registered', result.registered, 'expected', result.parity.expected)
console.log('parity ok', result.parity.missing.length === 0 && result.parity.extra.length === 0)

// 真实实现通道：应当真正执行逻辑
console.log('getInfo', JSON.stringify(await ipcMain.invoke('app:getInfo')))
console.log('getPaths', JSON.stringify((await ipcMain.invoke('app:getPaths') as { data: unknown }).data))
console.log('task:list', JSON.stringify(await ipcMain.invoke('task:list', {})))
console.log('task:clearFinished', JSON.stringify(await ipcMain.invoke('task:clearFinished')))
console.log('settings:set', JSON.stringify(await ipcMain.invoke('settings:set', { patch: { audio: { sampleRate: 48000 } } })))
console.log('log:subscribe', JSON.stringify(await ipcMain.invoke('log:subscribe', { level: 'debug' })))
console.log('ffmpeg:capabilities', JSON.stringify(await ipcMain.invoke('ffmpeg:capabilities')))

// 未实现通道：必须 NOT_IMPLEMENTED，而不是空数据
const notImpl = await ipcMain.invoke('canvas:getChapter', { chapterId: 'c1' })
console.log('placeholder', JSON.stringify((notImpl as { error: { code: string; params: unknown } }).error?.code), JSON.stringify((notImpl as { error: { params: unknown } }).error?.params))

// 非法载荷：必须 INVALID_PAYLOAD
const bad = await ipcMain.invoke('canvas:getChapter', { chapterId: 123 })
console.log('invalid', JSON.stringify((bad as { error: { code: string; details?: { issues?: unknown } } }).error?.code), JSON.stringify((bad as { error: { details?: { issues?: unknown } } }).error?.details?.issues))

// void 通道传参：必须被拒
const badVoid = await ipcMain.invoke('app:getInfo', {})
console.log('void rejects', JSON.stringify((badVoid as { error: { code: string } }).error?.code))

// 任务通道：真实队列
const enq = await queue.enqueue('cache.clean', {})
console.log('enqueue', enq.taskId.length > 0)
console.log('task:get', JSON.stringify((await ipcMain.invoke('task:get', { taskId: enq.taskId }) as { data: { kind: string } }).data.kind))
await queue.whenIdle()
console.log('task:result', JSON.stringify((await ipcMain.invoke('task:result', { taskId: enq.taskId }) as { data: unknown }).data))
console.log('task:get missing', JSON.stringify((await ipcMain.invoke('task:get', { taskId: 'nope' }) as { error: { code: string } }).error.code))
