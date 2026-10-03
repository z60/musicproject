/**
 * 任务进度事件链路 · 源码级防回归（docs/91 §5.2.62）
 * ============================================================================
 * 真机反馈：「任务栏的进度条无法实时变化」。
 *
 * 根因不在生产者也不在消费者，而在**中间的装配**：
 *   · `createEventEmitter` 写好了却从来没人构造；
 *   · `new TaskQueue(...)` 没接事件出口 ⇒ `ctx.report()` / `task:finished` 全丢。
 * 两边各自都有测试，唯独「中间那一行」没人看 —— 所以这里盯住它。
 *
 * 三个必须同时成立的接线点：
 *   1. 入口构造发射器，并把它交给 `buildHandlerDeps({ events })`；
 *   2. `ports.ts` 把队列的事件出口接到该发射器上（progress + finished）；
 *   3. `tasks.store` 能接纳「列表刷新之后才入队」的新任务（否则任务栏里看不到它）。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('任务进度事件链路（装配层）', () => {
  it('入口真的构造了事件发射器，并交给 buildHandlerDeps', () => {
    const src = read('src/main/index.ts')
    assert.match(src, /createEventEmitter\(/, '没有构造发射器 → 所有任务进度都推不出去')
    assert.match(src, /buildHandlerDeps\(\{/, '装配入口不见了')
    assert.match(src, /events,/, 'buildHandlerDeps 必须拿到 events（否则队列的事件出口是 undefined）')
  })

  it('队列的事件出口接到 task:progress / task:finished', () => {
    const src = read('src/main/ports.ts')
    assert.match(src, /QueueEventSink/, '没有给 TaskQueue 接事件出口')
    assert.match(src, /events: queueEvents/, 'TaskQueue 构造时必须传 events（真机事故就是漏了这一行）')
    assert.match(src, /emit\('task:progress'/, '进度事件没有发射')
    assert.match(src, /emit\(\s*'task:finished'/, '终态事件没有发射')
    assert.match(src, /durable: true/, 'task:finished 必须 durable（窗口不在时不许丢）')
  })

  it('任务栏能接纳「刷新之后才入队」的新任务', () => {
    const src = read('src/renderer/src/app/store/tasks.store.ts')
    assert.match(src, /records\.value = \[/, '新任务必须补进 records，否则任务栏里看不到它')
    assert.match(src, /state\.kind/, '补进列表时要用事件里的 kind（标签才对）')
  })
})
