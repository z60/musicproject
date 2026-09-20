/**
 * 测试 · 录音倒计时（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.37）：「录音点击录制没有开始」。
 *
 * 根因：主录音页与任务包录音页各写了一份 `setInterval`，两份都**只把数字减到 0、
 * 把遮罩关掉，从来没调用过开始录音**。而默认设置就是倒计时 3 秒
 * （`audio.countdownMs = 3000`，`src/main/settings.ts`）——于是按录制键：
 * 遮罩数 3→2→1→消失，采集图一直没建，录音永远不开始。
 *
 * 这组测试钉的就是「归零必须真的开录」这一步。被测 composable 只依赖 `vue`
 * （不 import 任何项目内模块），因此能在 Node 里跑。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { useRecordCountdown } from '../../src/renderer/src/features/recording/composables/useRecordCountdown.ts'

/** 假定时器：手动推进时间，测试不依赖真实时钟 */
function fakeScheduler() {
  let handle = 0
  const jobs = new Map<number, () => void>()
  return {
    setInterval: (fn: () => void) => {
      handle += 1
      jobs.set(handle, fn)
      return handle as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (h: ReturnType<typeof setInterval>) => {
      jobs.delete(h as unknown as number)
    },
    /** 推进 n 拍 */
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) for (const fn of [...jobs.values()]) fn()
    },
    get pending() {
      return jobs.size
    },
  }
}

describe('录音倒计时：归零必须真的开始录音', () => {
  it('倒计时归零 → 调用 onElapsed（事故的直接回归）', () => {
    const sched = fakeScheduler()
    let started = 0
    const cd = useRecordCountdown({ onElapsed: () => { started++ }, stepMs: 100, scheduler: sched })

    assert.equal(cd.request(3000), true, '有倒计时时长时应当进入倒计时')
    assert.equal(cd.visible.value, true)
    assert.equal(cd.seconds.value, 3)
    assert.equal(started, 0, '还没到点，不能开始')

    sched.tick(30)
    assert.equal(started, 1, '归零必须开录 —— 旧实现就是漏了这一步')
    assert.equal(cd.visible.value, false, '遮罩要收起')
    assert.equal(cd.seconds.value, 0)
    assert.equal(sched.pending, 0, '定时器必须停掉')
  })

  it('倒计时期间每拍更新剩余秒数', () => {
    const sched = fakeScheduler()
    const cd = useRecordCountdown({ onElapsed: () => undefined, stepMs: 100, scheduler: sched })
    cd.request(3000)
    sched.tick()
    assert.equal(cd.seconds.value, 2.9)
    sched.tick(9)
    assert.equal(Math.round(cd.seconds.value * 10) / 10, 2)
  })

  it('设置里倒计时为 0 → 不进倒计时（调用方立即开录）', () => {
    const sched = fakeScheduler()
    let started = 0
    const cd = useRecordCountdown({ onElapsed: () => { started++ }, scheduler: sched })
    assert.equal(cd.request(0), false, '0 = 不倒计时，返回 false 让调用方立刻开始')
    assert.equal(cd.visible.value, false)
    assert.equal(started, 0, '不该由倒计时组件去开录')
    assert.equal(sched.pending, 0)
  })

  it('用户按键取消 → 立刻开录（不是取消本次录制）', () => {
    const sched = fakeScheduler()
    let started = 0
    const cd = useRecordCountdown({ onElapsed: () => { started++ }, stepMs: 100, scheduler: sched })
    cd.request(3000)
    cd.cancelAndBegin()
    assert.equal(started, 1)
    assert.equal(cd.visible.value, false)
    assert.equal(sched.pending, 0, '取消后不能再留着定时器')
    sched.tick(50)
    assert.equal(started, 1, '定时器已清，不该再触发第二次')
  })

  it('onElapsed 每次倒计时只触发一次（tick 与取消同时到达也不会开录两次）', () => {
    const sched = fakeScheduler()
    let started = 0
    const cd = useRecordCountdown({ onElapsed: () => { started++ }, stepMs: 100, scheduler: sched })
    cd.request(3000)
    sched.tick(30)
    cd.cancelAndBegin()
    sched.tick(30)
    assert.equal(started, 1)
  })

  it('stop() 只清理，不触发开录（卸载 / 放弃本次录制）', () => {
    const sched = fakeScheduler()
    let started = 0
    const cd = useRecordCountdown({ onElapsed: () => { started++ }, stepMs: 100, scheduler: sched })
    cd.request(3000)
    cd.stop()
    assert.equal(started, 0, 'stop 不该开录')
    assert.equal(cd.visible.value, false)
    assert.equal(sched.pending, 0)
    sched.tick(50)
    assert.equal(started, 0)
  })

  it('重复 request 不会叠加定时器（按两下录制键）', () => {
    const sched = fakeScheduler()
    let started = 0
    const cd = useRecordCountdown({ onElapsed: () => { started++ }, stepMs: 100, scheduler: sched })
    cd.request(3000)
    cd.request(3000)
    assert.equal(sched.pending, 1, '旧定时器必须先清掉')
    sched.tick(30)
    assert.equal(started, 1, '只开录一次')
  })

  it('没在倒计时时 cancelAndBegin 不误开录', () => {
    const sched = fakeScheduler()
    let started = 0
    const cd = useRecordCountdown({ onElapsed: () => { started++ }, scheduler: sched })
    cd.cancelAndBegin()
    assert.equal(started, 0)
  })
})
