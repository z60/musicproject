/**
 * preload 白名单与解包测试（不需要 Electron）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §8「preload 暴露面」、§10 测试要点
 *
 * 这组测试守的是**安全边界**：
 *   · 渲染进程被 XSS 注入后，能否用未登记的通道去够主进程？（必须不能）
 *   · 订阅事件后组件卸载，监听器是否被正确移除？（否则切页面会重复响应）
 *   · MessagePort 不可用时是否明确报错而不是静默丢录音？
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { createPreloadApi, preloadWhitelistSizes } from '../../src/main/preload.ts'
import type { IpcRendererLike } from '../../src/main/infra/electron/types.ts'

// ---------------------------------------------------------------------------
// 假 ipcRenderer：记录全部调用，便于断言
// ---------------------------------------------------------------------------

interface Spy {
  invokes: Array<{ channel: string; args: unknown[] }>
  sends: Array<{ channel: string; args: unknown[] }>
  listeners: Map<string, Array<(e: unknown, ...a: unknown[]) => void>>
  posted: Array<{ channel: string; message: unknown; transfer: unknown[] | undefined }>
  warns: Array<{ event: string; data?: Record<string, unknown> }>
}

function createFakeIpc(opts: { supportsPostMessage?: boolean } = {}): { ipc: IpcRendererLike; spy: Spy } {
  const spy: Spy = {
    invokes: [],
    sends: [],
    listeners: new Map(),
    posted: [],
    warns: [],
  }

  const ipc: IpcRendererLike = {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      spy.invokes.push({ channel, args })
      return { ok: true, data: { channel } }
    },
    send(channel: string, ...args: unknown[]): void {
      spy.sends.push({ channel, args })
    },
    on(channel: string, listener: (event: unknown, ...a: unknown[]) => void): void {
      const list = spy.listeners.get(channel) ?? []
      list.push(listener)
      spy.listeners.set(channel, list)
    },
    off(channel: string, listener: (event: unknown, ...a: unknown[]) => void): void {
      const list = spy.listeners.get(channel) ?? []
      spy.listeners.set(channel, list.filter(l => l !== listener))
    },
  }

  if (opts.supportsPostMessage !== false) {
    ipc.postMessage = (channel: string, message: unknown, transfer?: unknown[]): void => {
      spy.posted.push({ channel, message, transfer })
    }
  }

  return { ipc, spy }
}

function makeApi(opts: { supportsPostMessage?: boolean } = {}) {
  const { ipc, spy } = createFakeIpc(opts)
  const api = createPreloadApi(ipc, {
    ...(opts.supportsPostMessage !== undefined ? { supportsPortTransfer: opts.supportsPostMessage } : {}),
    log: { warn: (event, data) => { spy.warns.push(data ? { event, data } : { event }) } },
  })
  return { api, spy }
}

// ---------------------------------------------------------------------------
// invoke：白名单
// ---------------------------------------------------------------------------

describe('preload.invoke 白名单', () => {
  it('放行契约中的通道并透传载荷', async () => {
    const { api, spy } = makeApi()
    const r = await api.invoke('canvas:getChapter', { chapterId: 'c1' })
    assert.deepEqual(r, { ok: true, data: { channel: 'canvas:getChapter' } })
    assert.equal(spy.invokes.length, 1)
    assert.equal(spy.invokes[0]!.channel, 'canvas:getChapter')
    assert.deepEqual(spy.invokes[0]!.args, [{ chapterId: 'c1' }])
  })

  it('拒绝未登记的通道（安全边界）', async () => {
    const { api, spy } = makeApi()
    await assert.rejects(
      () => api.invoke('evil:doSomething', {}),
      /未登记的 invoke 通道/,
    )
    await assert.rejects(() => api.invoke('app:getInfo2'), /未登记的 invoke 通道/)
    assert.equal(spy.invokes.length, 0, '被拒的通道绝不能触达 ipcRenderer')
  })

  it('无载荷通道也允许调用（载荷为 undefined）', async () => {
    const { api, spy } = makeApi()
    await api.invoke('app:getInfo')
    assert.equal(spy.invokes.length, 1)
    // 仍会带一个 undefined 实参 —— 主进程侧的 schema 对 NoReq 通道接受它。
    // （这里不断言 args 为空数组：那是对 jest 式 mock 的误套用。）
    assert.equal(spy.invokes[0]!.args.length, 1)
    assert.equal(spy.invokes[0]!.args[0], undefined)
  })

  it('返回原始 IpcResult，不在 preload 层解包（解包归渲染侧的 call()）', async () => {
    const { api } = makeApi()
    const r = await api.invoke('app:getInfo') as { ok: boolean; data: unknown }
    assert.equal(r.ok, true)
    assert.ok('data' in r)
  })
})

// ---------------------------------------------------------------------------
// send：单向通道
// ---------------------------------------------------------------------------

describe('preload.send 单向通道', () => {
  it('放行契约中的单向通道', () => {
    const { api, spy } = makeApi()
    api.send('record:meter', { sessionId: 's1', rmsDb: -20, peakDb: -6, frames: 480 })
    assert.equal(spy.sends.length, 1)
    assert.equal(spy.sends[0]!.channel, 'record:meter')
  })

  it('未登记的 send 通道被丢弃并记警告（不抛错，因为调用方没有 Promise 可 catch）', () => {
    const { api, spy } = makeApi()
    api.send('evil:silent', {})
    assert.equal(spy.sends.length, 0, '未登记通道不得触达 ipcRenderer')
    assert.ok(spy.warns.some(w => w.event === 'preload.send.rejected'))
  })

  it('invoke 通道不能当 send 用（两类白名单互不通用）', () => {
    const { api, spy } = makeApi()
    api.send('app:getInfo', {})
    assert.equal(spy.sends.length, 0)
    assert.ok(spy.warns.some(w => w.event === 'preload.send.rejected'))
  })
})

// ---------------------------------------------------------------------------
// on：订阅与取消订阅
// ---------------------------------------------------------------------------

describe('preload.on 事件订阅', () => {
  it('放行契约中的事件并派发载荷', () => {
    const { api, spy } = makeApi()
    const got: unknown[] = []
    api.on('task:progress', p => got.push(p))

    assert.equal(spy.listeners.get('task:progress')?.length, 1)
    // 模拟主进程推送：注意 ipc.on 的回调第一个参数是 event
    const listener = spy.listeners.get('task:progress')![0]!
    listener({}, { taskId: 't1', progress: 0.5 })

    assert.equal(got.length, 1)
    assert.deepEqual(got[0], { taskId: 't1', progress: 0.5 })
  })

  it('返回的取消订阅函数真的移除监听器（防组件卸载后泄漏）', () => {
    const { api, spy } = makeApi()
    const off = api.on('task:progress', () => void 0)
    assert.equal(spy.listeners.get('task:progress')?.length, 1)

    off()
    assert.equal(spy.listeners.get('task:progress')?.length, 0, '取消订阅后监听器必须归零')
  })

  it('多次订阅各自独立取消（前一个不能把后一个也删掉）', () => {
    const { api, spy } = makeApi()
    const off1 = api.on('export:progress', () => void 0)
    api.on('export:progress', () => void 0)
    assert.equal(spy.listeners.get('export:progress')?.length, 2)

    off1()
    assert.equal(spy.listeners.get('export:progress')?.length, 1)
  })

  it('未登记的事件名被拒绝，但返回空函数而不是抛错（不能让组件挂掉）', () => {
    const { api, spy } = makeApi()
    const off = api.on('evil:push', () => void 0)
    assert.equal(typeof off, 'function')
    assert.doesNotThrow(() => off())
    assert.equal(spy.listeners.size, 0, '未登记事件不得注册监听器')
    assert.ok(spy.warns.some(w => w.event === 'preload.on.rejected'))
  })

  it('invoke 通道不能当事件订阅（两类白名单互不通用）', () => {
    const { api, spy } = makeApi()
    api.on('app:getInfo', () => void 0)
    assert.equal(spy.listeners.size, 0)
    assert.ok(spy.warns.some(w => w.event === 'preload.on.rejected'))
  })
})

// ---------------------------------------------------------------------------
// attachRecordPort：录音零拷贝通道
// ---------------------------------------------------------------------------

describe('preload.attachRecordPort', () => {
  it('支持时通过 postMessage 转移端口', () => {
    const { api, spy } = makeApi({ supportsPostMessage: true })
    const fakePort = { id: 'port-1' }
    api.attachRecordPort(fakePort)

    assert.equal(spy.posted.length, 1)
    assert.equal(spy.posted[0]!.channel, 'record:port')
    assert.deepEqual(spy.posted[0]!.transfer, [fakePort], '端口必须放进 transfer 列表才是转移而非拷贝')
  })

  it('不支持时明确抛错（绝不静默丢弃，否则用户录完才发现没声音）', () => {
    const { api, spy } = makeApi({ supportsPostMessage: false })
    assert.throws(() => api.attachRecordPort({}), /不支持 MessagePort 转移/)
    assert.equal(spy.posted.length, 0)
  })
})

// ---------------------------------------------------------------------------
// mediaUrl：音频读取协议
// ---------------------------------------------------------------------------

describe('preload.mediaUrl', () => {
  it('构造 ns-media:// URL 并逐段编码路径', () => {
    const { api } = makeApi()
    assert.equal(
      api.mediaUrl('p1', 'segments/a b.wav'),
      'ns-media://p1/segments/a%20b.wav',
    )
  })

  it('保留路径分隔符（主进程要还原相对路径）', () => {
    const { api } = makeApi()
    assert.equal(
      api.mediaUrl('p1', 'take/line/1.wav'),
      'ns-media://p1/take/line/1.wav',
    )
  })

  it('Windows 反斜杠也归一到正斜杠', () => {
    const { api } = makeApi()
    assert.equal(api.mediaUrl('p1', 'a\\b\\c.wav'), 'ns-media://p1/a/b/c.wav')
  })

  it('projectId 也被编码（防止注入路径分隔符）', () => {
    const { api } = makeApi()
    const url = api.mediaUrl('p/../evil', 'x.wav')
    assert.ok(!url.includes('p/../'), `projectId 未被正确编码：${url}`)
  })

  it('过滤空路径段（双斜杠、首尾斜杠）', () => {
    const { api } = makeApi()
    assert.equal(api.mediaUrl('p1', '//a//b//'), 'ns-media://p1/a/b')
  })
})

// ---------------------------------------------------------------------------
// 白名单规模自检
// ---------------------------------------------------------------------------

describe('preload 白名单规模', () => {
  it('三个白名单都非空，且通道数远大于事件数（符合契约形态）', () => {
    const s = preloadWhitelistSizes()
    assert.ok(s.channels > 100, `通道数异常：${s.channels}`)
    assert.ok(s.events > 0 && s.events < s.channels)
    assert.ok(s.sends > 0 && s.sends < s.events)
  })

  it('暴露面只包含五个方法（不额外泄漏能力）', () => {
    const { api } = makeApi()
    const keys = Object.keys(api).sort()
    assert.deepEqual(keys, ['attachRecordPort', 'invoke', 'mediaUrl', 'on', 'send'])
  })

  it('API 上不存在 ipcRenderer / require / process 之类的泄漏', () => {
    const { api } = makeApi()
    const json = Object.keys(api).join(',')
    for (const forbidden of ['ipcRenderer', 'require', 'process', 'fs', 'electron']) {
      assert.ok(!json.includes(forbidden), `暴露面疑似泄漏：${forbidden}`)
    }
  })
})
