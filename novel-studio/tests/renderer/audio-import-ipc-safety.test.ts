/**
 * 按说话人导入音频 · IPC 载荷必须可结构化克隆（防回归，源码级）
 * ============================================================================
 * 真机故障：在「指定说话人」里选了 CV → 点「应用并重新预览」报
 *   「生成预览失败 / 主进程未能完成匹配，详情见日志」
 * 根因：`overrides` 是 Vue 响应式 **Proxy**，直接过 IPC 会抛 `DataCloneError`
 *（结构化克隆不能序列化 Proxy）。没有人工修正时 `overrides` 是空对象，所以一直没暴露。
 * 真机事故同 docs/91 §5.2.5。修法是载荷经 `cloneForIpc`（JSON 往返成纯数据）。
 *
 * 这里用**源码级断言**兜住：store 的单测无法在无 `@/` 别名的测试环境里 import。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('按说话人导入音频 · IPC 载荷安全', () => {
  const src = readFileSync(
    join(ROOT, 'src/renderer/src/features/recording/stores/audio-import.store.ts'),
    'utf8',
  )

  it('importPlan / importStart 的载荷都经过 cloneForIpc', () => {
    assert.match(src, /cloneForIpc\(\{/, '没有 cloneForIpc：响应式 Proxy 会让 IPC 抛 DataCloneError')
    assert.match(src, /'record:importPlan',\s*cloneForIpc\(/, 'importPlan 载荷未 clone')
    // 导入已改为**后台任务**（`record:importStart`）：载荷变大（整批文件 + 人工修正），
    // 更容易踩到 Proxy 序列化问题，这条断言必须跟着走。
    assert.match(src, /'record:importStart',\s*cloneForIpc\(/, 'importStart 载荷未 clone')
  })
})
