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

import { createPreloadApi, preloadWhitelistSizes } from '../../src/preload/index.ts'
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

/** 假端口对：记录 preload 侧那一半收到的消息（真 MessageChannel 会让 Node 事件循环不退出） */
function fakeChannel(): {
  channel: { port1: unknown; port2: unknown }
  sent: Array<{ message: unknown; transfer?: unknown[] }>
  closed: { port1: boolean }
} {
  const sent: Array<{ message: unknown; transfer?: unknown[] }> = []
  const closed = { port1: false }
  const port1 = {
    postMessage: (message: unknown, transfer?: unknown[]): void => { sent.push({ message, transfer }) },
    close: (): void => { closed.port1 = true },
  }
  return { channel: { port1, port2: { id: 'port-2' } }, sent, closed }
}

function makeApi(opts: { supportsPostMessage?: boolean; withChannel?: boolean } = {}) {
  const { ipc, spy } = createFakeIpc(opts)
  const fake = opts.withChannel ? fakeChannel() : null
  const api = createPreloadApi(ipc, {
    ...(opts.supportsPostMessage !== undefined ? { supportsPortTransfer: opts.supportsPostMessage } : {}),
    ...(fake ? { createPortChannel: () => fake.channel } : {}),
    log: { warn: (event, data) => { spy.warns.push(data ? { event, data } : { event }) } },
  })
  return { api, spy, fake }
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
// attachRecordPort / sendRecordPcm：录音音频通道
// ---------------------------------------------------------------------------

describe('preload.attachRecordPort', () => {
  it('通道在 preload 自己这一侧创建并转移给主进程', () => {
    const { api, spy, fake } = makeApi({ supportsPostMessage: true, withChannel: true })
    api.attachRecordPort()

    assert.equal(spy.posted.length, 1)
    assert.equal(spy.posted[0]!.channel, 'record:port')
    assert.deepEqual(spy.posted[0]!.transfer, [fake!.channel.port2], 'preload 建的 port2 必须转移给主进程')
  })

  it('不支持时明确抛错（绝不静默丢弃，否则用户录完才发现没声音）', () => {
    const { api, spy } = makeApi({ supportsPostMessage: false, withChannel: true })
    assert.throws(() => api.attachRecordPort(), /不支持 MessagePort 转移/)
    assert.equal(spy.posted.length, 0)
  })

  it('sendRecordPcm：通道建立前返回 false（调用方据此中止录制，而不是"录"出空文件）', () => {
    const { api } = makeApi({ supportsPostMessage: true, withChannel: true })
    assert.equal(api.sendRecordPcm(new ArrayBuffer(8), 2), false)
  })

  /**
   * 真机事故 docs/91 §5.2.43：**这条路径上不能带 transfer 列表**。
   *
   * 实测（Electron 31.7.0，真 Electron 跑八种载荷）：preload 侧
   * `postMessage(payload, [transfer])` 一旦带 transfer，主进程收到的 `event.data`
   * 恒为 `null` —— 事件照发、渲染侧不报错，但一块数据都到不了，录音永远是 0 字节。
   * 不带 transfer 时字符串/对象/ArrayBuffer/类型化数组都完整送达（拷贝）。
   */
  it('sendRecordPcm：把样本放进通道，且**不得使用 transfer 列表**', () => {
    const { api, fake } = makeApi({ supportsPostMessage: true, withChannel: true })
    api.attachRecordPort()

    const buffer = new ArrayBuffer(16)
    assert.equal(api.sendRecordPcm(buffer, 4), true)
    assert.equal(fake!.sent.length, 1, '样本必须真的进通道')
    const message = fake!.sent[0]!.message as { type: string; frames: number; data: ArrayBuffer }
    assert.equal(message.type, 'pcm')
    assert.equal(message.frames, 4)
    assert.equal(message.data.byteLength, 16)
    const transfer = fake!.sent[0]!.transfer
    assert.ok(
      transfer === undefined || transfer.length === 0,
      `不得带 transfer 列表（带 transfer 时主进程收到 null，docs/91 §5.2.43）；实际 ${JSON.stringify(transfer)}`,
    )
  })

  it('detachRecordPort：关掉旧通道，之后再送样本返回 false', () => {
    const { api, fake } = makeApi({ supportsPostMessage: true, withChannel: true })
    api.attachRecordPort()
    api.detachRecordPort()
    assert.equal(fake!.closed.port1, true, '端口必须真的关掉（否则会一直挂着）')
    assert.equal(api.sendRecordPcm(new ArrayBuffer(4), 1), false)
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
    assert.deepEqual(keys, ['attachRecordPort', 'detachRecordPort', 'invoke', 'mediaUrl', 'on', 'send', 'sendRecordPcm'])
  })

  it('API 上不存在 ipcRenderer / require / process 之类的泄漏', () => {
    const { api } = makeApi()
    const json = Object.keys(api).join(',')
    for (const forbidden of ['ipcRenderer', 'require', 'process', 'fs', 'electron']) {
      assert.ok(!json.includes(forbidden), `暴露面疑似泄漏：${forbidden}`)
    }
  })
})
