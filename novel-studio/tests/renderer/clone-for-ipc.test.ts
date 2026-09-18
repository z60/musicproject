/**
 * 回归 · 交给 IPC 的载荷必须是「可结构化克隆」的纯数据（真机事故 docs/91 §5.2.5）
 * ============================================================================
 * 真机现象：
 *
 *     发生了未预期的错误 / 错误编号：「-」
 *     原因链：Error: An object could not be cloned.
 *
 * `-` 是兜底码，真实原因是 Electron IPC 的**结构化克隆**失败：Vue 的
 * `reactive` / `ref` 返回的是 **Proxy**，而 Proxy 不能被序列化。
 *
 * 这几个用例直接用 Node 的 `structuredClone`（与 Electron IPC 同一套 V8 序列化）
 * 复刻失败与修复 —— 这样「为什么必须 cloneForIpc」就变成了可执行的断言，
 * 而不是注释里的一句话。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { reactive, ref } from 'vue'

import { cloneForIpc } from '../../src/renderer/src/shared/lib/clone.ts'

/** 一份「像导入草稿那样」的数据 */
const draft = () => ({
  id: 'd1',
  title: '第一章 陨落的天才',
  included: true,
  rawText: '正文……',
  charCount: 6,
  flags: ['checked'],
})

describe('IPC 载荷 · 响应式对象必须先拍平', () => {
  it('普通对象可以直接结构化克隆（对照组）', () => {
    assert.doesNotThrow(() => structuredClone(draft()))
  })

  it('reactive 对象**不能**结构化克隆 —— 这就是真机报错的原因', () => {
    assert.throws(
      () => structuredClone(reactive(draft())),
      (e: unknown) => {
        assert.equal((e as Error).name, 'DataCloneError')
        assert.match(String((e as Error).message), /could not be cloned/)
        return true
      },
    )
  })

  it('ref 数组、以及从响应式数组 filter 出来的元素同样不能', () => {
    const list = ref([draft(), { ...draft(), id: 'd2' }])
    assert.throws(() => structuredClone(list.value), /could not be cloned/)
    // 关键：这正是 buildCommitPayload 里 `drafts.value.filter(d => d.included)` 的形状
    assert.throws(() => structuredClone(list.value.filter((d) => d.included)), /could not be cloned/)
  })

  it('**真实载荷形状**：未拍平时必然失败，拍平后可克隆', () => {
    const list = ref([draft(), { ...draft(), id: 'd2', included: false }])
    const payload = () => ({
      projectId: 'default',
      bookMeta: { title: '示例书名', author: null },
      source: { type: 'txt' as const, path: 'C:\\x.txt', contentHash: 'abc' },
      drafts: list.value.filter((d) => d.included), // ← 未拍平：Proxy 数组
    })

    assert.throws(() => structuredClone(payload()), /could not be cloned/, '先确认这个形状真的会炸')
    assert.doesNotThrow(() => structuredClone(cloneForIpc(payload())), 'cloneForIpc 之后必须可克隆')
  })
})

describe('cloneForIpc · 语义', () => {
  it('拍平后与原值**深相等**（不改变数据本身）', () => {
    const source = reactive({ a: 1, b: { c: [1, 2, 3] }, d: null })
    assert.deepEqual(cloneForIpc(source), { a: 1, b: { c: [1, 2, 3] }, d: null })
  })

  it('返回的是**脱开响应式**的副本：改原对象不影响结果', () => {
    const source = reactive({ title: '原标题' })
    const frozen = cloneForIpc(source)
    source.title = '改过了'
    assert.equal(frozen.title, '原标题')
  })

  it('草稿数组这种嵌套结构也逐层拍平（元素不再是 Proxy）', () => {
    const list = ref([draft()])
    const cloned = cloneForIpc({ drafts: list.value.filter((d) => d.included) })
    assert.doesNotThrow(() => structuredClone(cloned))
    assert.deepEqual(cloned.drafts, [draft()])
  })

  it('已发布过的一条边界：JSON 不可表达的字段会被丢弃（所以别拿它处理二进制）', () => {
    // 这正是 clone.ts 头部警示「不要把本函数挪进 call() 统一做」的原因：
    // 音频路径用 MessagePort 转移 ArrayBuffer 做零拷贝，硬塞 JSON 往返会毁数据。
    const withBytes = { samples: new Float32Array([1, 2]) }
    const cloned = cloneForIpc(withBytes) as unknown as { samples: Record<string, number> }
    assert.notEqual(cloned.samples, undefined)
    assert.equal(Array.isArray(cloned.samples), false, 'TypedArray 经 JSON 往返会变成普通对象')
  })
})
