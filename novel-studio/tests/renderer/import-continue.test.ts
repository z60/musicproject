/**
 * 按说话人导入音频 · 「导入一批之后还能继续导入」（防回归，源码级）
 * ============================================================================
 * 真机反馈：「导入一批可以继续导入」。
 *
 * 三条独立的原因，任何一条都能让「继续导入」变成不可能：
 *   1. `task:progress` / `task:finished` 是**事件**：向导关掉再打开（或刷新页面）时
 *      任务已经结束，晚到的订阅者收不到终态 ⇒ `applyTaskId` 永远留着 ⇒ 按钮一直灰着。
 *      修法：订阅时补查一次 `task:get`（`seedFromRecord`）+ watch 用 `immediate: true`。
 *   2. 去重键只按书 ⇒ 换一批文件时会命中正在跑的旧任务，新文件一个都不导。
 *      修法：去重键带**批次指纹**（`batchKey`）。
 *   3. 「再导一批」把音频文件夹也清了 ⇒ 每次都要重新挑目录。
 *      修法：`resetForAnotherBatch()` 保留目录。
 *
 * 这几处都在 .vue / store / 渲染侧模块里（测试环境没有 `@/` 别名，import 不进来），
 * 所以用源码断言钉住 —— 与 `audio-import-ipc-safety.test.ts` 同一套做法。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('导入音频 · 「继续导入」的三道保障', () => {
  it('晚到的订阅者会补查 task:get（否则任务结束后按钮永远灰着）', () => {
    const src = read('src/renderer/src/shared/lib/task-progress.ts')
    assert.match(src, /seedFromRecord/, '缺少「订阅时补查任务记录」的逻辑')
    assert.match(src, /'task:get'/, '补查必须真的调 task:get')
    assert.match(src, /recordFetched/, '每个任务只查一次，避免反复 IPC')
  })

  it('向导的完成监听是 immediate 的（组件可能在任务结束后才挂载）', () => {
    const src = read('src/renderer/src/features/recording/components/ImportBySpeakerWizard.vue')
    assert.match(src, /immediate: true/, 'watch 必须 immediate，否则挂着 finished 状态不会触发')
    assert.match(src, /useTaskProgress\(computed\(\(\) => store\.applyTaskId\)\)/)
  })

  it('完成页提供「继续导入」（保留音频文件夹），并且真的调用它', () => {
    const wizard = read('src/renderer/src/features/recording/components/ImportBySpeakerWizard.vue')
    const store = read('src/renderer/src/features/recording/stores/audio-import.store.ts')
    assert.match(wizard, /store\.resetForAnotherBatch\(\)/)
    assert.match(store, /function resetForAnotherBatch\(\)/)
    // 保留目录 = 「继续导入」的意义所在
    const fn = /function resetForAnotherBatch\(\)[\s\S]*?\n  \}/.exec(store)?.[0] ?? ''
    assert.ok(fn.length > 0, '没有找到 resetForAnotherBatch 的实现')
    assert.doesNotMatch(fn, /audioDir\.value = null/, '「继续导入」不能把音频文件夹清掉')
  })

  it('去重键带批次指纹（换一批文件不会被运行中的旧任务吞掉）', () => {
    const src = read('src/main/features/audio/import.tasks.ts')
    assert.match(src, /function batchKey\(/, '缺少批次指纹')
    assert.match(src, /dedupeKey: `\$\{AUDIO_IMPORT_TASK_KIND\}:\$\{payload\.bookId\}:\$\{batchKey\(payload\)\}`/)
  })
})
