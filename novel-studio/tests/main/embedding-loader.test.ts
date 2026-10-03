/**
 * Novel Studio · 本地 ONNX 向量模型加载器（降级路径）
 * ============================================================================
 * 本测试环境没有模型文件、也不加载原生模块，验证的是**降级语义**：
 * 模型缺失时必须返回 `available:false + reason`，绝不抛错（docs/06 §8）。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { loadLocalEmbeddingProvider } from '../../src/main/features/ai/embedding-loader.ts'

describe('本地 ONNX 向量模型加载器', () => {
  it('模型文件不存在 → 不抛错，返回「不可用 + 原因」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-embed-'))
    try {
      const result = await loadLocalEmbeddingProvider({ modelsDir: dir })
      assert.equal(result.available, false)
      assert.equal(result.provider, null)
      assert.match(String(result.reason), /不存在/)
      assert.equal(result.modelId, 'bge-small-zh-v1.5')
      assert.equal(result.dim, 512)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
