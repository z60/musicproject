/**
 * archiver ZIP 适配层的收尾时序测试
 * ============================================================================
 * 设计依据：docs/91 §5.2.26 ③ 记录的真实竞态
 *
 * 症状：产物文件大小正常，却打不开（openZip 报 eocd-not-found）。
 * 根因：适配层在 await archive.finalize() 之后就自己 output.end()，
 *       而那一刻 archiver 有时还没把中央目录 / EOCD 写进输出流 —— end() 之后
 *       到来的写入被丢弃（ERR_STREAM_WRITE_AFTER_END），错误进了内部 failure 却无人检查。
 *
 * 这里用假 archiver / 假输出流把时序钉死，不依赖真实的第三方包：
 *   · 必须在 archiver emit('end') 之后才允许 output.end()
 *   · archiver 的错误必须让 finalize() reject，不能静默产出坏包
 *   · 输出流的错误同理
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  createArchiverZipWriter,
  type ArchiverLike,
  type WritableLike,
} from '../../src/main/features/book/package/zip/writer.ts'

type Listener = (arg?: unknown) => void

/** 假 archiver：记录事件顺序，让测试自己决定何时 emit('end') */
class FakeArchiver implements ArchiverLike {
  readonly appended: string[] = []
  finalized = 0
  aborted = 0
  /** 在 finalize() 内部触发（模拟「同步就写完了」的 archiver） */
  onFinalize: (() => void) | null = null
  readonly events: string[]
  private readonly listeners = new Map<string, Listener[]>()

  constructor(events: string[] = []) {
    this.events = events
  }

  on(event: 'error' | 'warning' | 'end' | 'close', listener: Listener): ArchiverLike {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  append(_source: unknown, data: { name: string }): ArchiverLike {
    this.appended.push(data.name)
    return this
  }

  file(_path: string, data: { name: string }): ArchiverLike {
    this.appended.push(data.name)
    return this
  }

  pipe<T>(destination: T): T {
    return destination
  }

  async finalize(): Promise<void> {
    this.finalized += 1
    this.events.push('archive:finalize')
    this.onFinalize?.()
  }

  abort(): void {
    this.aborted += 1
  }

  pointer(): number {
    return 1024
  }

  emit(event: string, arg?: unknown): void {
    this.events.push('archive:' + event)
    for (const listener of this.listeners.get(event) ?? []) listener(arg)
  }
}

/** 假输出流：end() 时同步 emit('finish')，与 Node 可写流一致（flush 后触发） */
class FakeOutput implements WritableLike {
  readonly chunks: Uint8Array[] = []
  ended = false
  readonly events: string[]
  private readonly listeners = new Map<string, Listener[]>()

  constructor(events: string[] = []) {
    this.events = events
  }

  on(event: 'close' | 'error' | 'finish', listener: Listener): WritableLike {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  write(chunk: Uint8Array): boolean {
    this.chunks.push(chunk)
    return true
  }

  end(): void {
    this.ended = true
    this.events.push('output:end')
    this.emit('finish')
  }

  emit(event: string, arg?: unknown): void {
    this.events.push('output:' + event)
    for (const listener of this.listeners.get(event) ?? []) listener(arg)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('createArchiverZipWriter · 收尾时序', () => {
  it('必须等 archiver emit end 之后才关输出流（否则 EOCD 被截断）', async () => {
    const events: string[] = []
    const archive = new FakeArchiver(events)
    const output = new FakeOutput(events)
    const writer = createArchiverZipWriter({ archive, output })

    writer.addFile('a.txt', Buffer.from('hello'))
    const pending = writer.finalize()

    await tick()
    assert.equal(archive.finalized, 1, '应先调用 archive.finalize()')
    assert.equal(output.ended, false, 'archiver 还没 emit end，绝不能关输出流')

    archive.emit('end')
    const result = await pending

    assert.equal(output.ended, true, 'archiver emit end 后才允许 output.end()')
    assert.ok(
      events.indexOf('archive:end') < events.indexOf('output:end'),
      'end 之前不得关流，事件顺序：' + events.join(' -> '),
    )
    assert.deepEqual(result.entries, ['a.txt'])
    assert.equal(result.bytes, 1024)
    assert.equal(result.uncompressedBytes, 5)
  })

  it('archiver 在 finalize() 内部就 emit end 也不会挂死', async () => {
    const events: string[] = []
    const archive = new FakeArchiver(events)
    const output = new FakeOutput(events)
    archive.onFinalize = () => archive.emit('end')

    const writer = createArchiverZipWriter({ archive, output })
    const result = await writer.finalize()

    assert.equal(output.ended, true)
    assert.deepEqual(result.entries, [])
  })

  it('archiver 报错必须让 finalize() reject，不能静默产出坏包', async () => {
    const events: string[] = []
    const archive = new FakeArchiver(events)
    const output = new FakeOutput(events)
    const writer = createArchiverZipWriter({ archive, output })

    const pending = writer.finalize()
    archive.emit('error', new Error('deflate boom'))

    await assert.rejects(pending, /deflate boom/)
    assert.equal(output.ended, false, '失败后不应假装收尾成功')
  })

  it('输出流报错必须让 finalize() reject', async () => {
    const events: string[] = []
    const archive = new FakeArchiver(events)
    const output = new FakeOutput(events)
    archive.onFinalize = () => {
      archive.emit('end')
      output.emit('error', new Error('disk full'))
    }

    const writer = createArchiverZipWriter({ archive, output })
    await assert.rejects(writer.finalize(), /disk full/)
  })

  it('abort 之后 finalize 抛 TASK_CANCELLED', async () => {
    const archive = new FakeArchiver()
    const output = new FakeOutput()
    const writer = createArchiverZipWriter({ archive, output })
    await writer.abort()
    await assert.rejects(writer.finalize(), (e: unknown) => (e as { key?: string }).key === 'TASK_CANCELLED')
  })
})
