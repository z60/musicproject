/**
 * 测试 · 区间播放「到点就停」
 * ============================================================================
 * 真机需求（第四次复报）：「音频的最后还是有下一段的杂音【众】，我需要治本的方法」。
 *
 * 其中一半原因在播放侧：判断「播到区间终点了没」原来只靠 `timeupdate`，
 * 而它每 ~250ms 才触发一次 —— take 的终点离下一句第一个字只有 148~238ms 时，
 * 播放一冲过头就把那个字放出来了。这里钉住「轮询、到点立刻暂停」。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { clipToEnd, type ClipAudioElement } from '../../src/renderer/src/shared/lib/media-element.ts'

function fakeAudio(currentTime = 0): ClipAudioElement & { pauseCalls: number; fire(type: string): void } {
  const listeners = new Map<string, Set<() => void>>()
  return {
    currentTime,
    src: '',
    readyState: 0,
    pauseCalls: 0,
    load(): void {},
    async play(): Promise<void> {},
    pause(): void {
      this.pauseCalls += 1
    },
    addEventListener(type: string, fn: () => void): void {
      const set = listeners.get(type) ?? new Set<() => void>()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type: string, fn: () => void): void {
      listeners.get(type)?.delete(fn)
    },
    fire(type: string): void {
      for (const fn of listeners.get(type) ?? []) fn()
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('播放到区间终点就停', () => {
  it('已经在终点之后 → 立刻暂停（不等 timeupdate）', async () => {
    const el = fakeAudio(0.5)
    const stop = clipToEnd(el, 200)
    await sleep(60)
    assert.equal(el.pauseCalls, 1)
    stop()
  })

  it('没到终点不暂停；跨过终点后很快停住（轮询 16ms）', async () => {
    const el = fakeAudio(0)
    const stop = clipToEnd(el, 200)
    await sleep(60)
    assert.equal(el.pauseCalls, 0, '还没到终点，不能停')
    el.currentTime = 0.25 // 越过 200ms
    await sleep(80)
    assert.equal(el.pauseCalls, 1)
    stop()
  })

  it('用户手动暂停 / 放完 → 收摊，不再空转', async () => {
    const el = fakeAudio(0)
    const stop = clipToEnd(el, 10_000)
    el.fire('pause')
    el.currentTime = 99_999
    await sleep(60)
    assert.equal(el.pauseCalls, 0, '已经收摊，不该再调 pause')
    stop()
  })
})
