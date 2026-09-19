/**
 * 测试 · 响应式行来源的归一（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.27）：点开画本编辑的**任意章节**，表格恒显示
 * 「当前筛选下没有行。可以放宽筛选条件，或切换章节。」，而库里那一章有 85 行。
 *
 * 根因：`useCanvasFilter(canvas.lines)` 传的是**值**。Pinia 的 setup store 会把 `ref` 解包，
 * 所以 `canvas.lines` 是「取用那一刻的数组对象」；`computed(() => source)` 的求值体
 * 不读任何响应式属性 → 永不重新求值；而 `canvas.load()` 是 `lines.value = collected`
 * （**整体重赋值**）→ 捕获到的旧数组永远是空的。
 *
 * 这组测试钉的就是那条归一逻辑（现位于 `shared/lib/reactive-list.ts`，刻意不 import 任何
 * 项目内模块，因此能在 Node 里被直接覆盖）。用真的 `vue` 响应式系统，不 mock。
 *
 * 说明：筛选**语义**（关键词/状态/说话人过滤）在 `useCanvasFilter.ts` 里，该文件引用了
 * `@shared/` 别名，Node 测试跑不了（别名只在 Vite 里生效）—— 这里不假装覆盖了它。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { computed, nextTick, reactive, ref } from 'vue'

import { useReactiveList } from '../../src/renderer/src/shared/lib/reactive-list.ts'

interface Row {
  id: string
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }))

describe('响应式行来源 · getter（事故的直接回归）', () => {
  it('store 整体重赋值后必须跟上（旧实现恒为空）', async () => {
    // 模拟 Pinia setup store：`lines` 是 ref，访问 `store.lines` 拿到解包后的数组
    const store = reactive({ lines: [] as Row[] })
    const list = useReactiveList(() => store.lines)

    assert.equal(list.value.length, 0, '初始为空是对的')

    // `canvas.load()` 的行为：整体重赋值
    store.lines = rows('a', 'b')
    await nextTick()
    assert.equal(list.value.length, 2, '重赋值后必须跟上（旧实现在这里是 0 → 表格显示「没有行」）')

    // 再切一章（又一次重赋值）
    store.lines = rows('c')
    await nextTick()
    assert.equal(list.value.length, 1)

    // 站内改动（整章替换/追加）
    store.lines = [...store.lines, { id: 'd' }, { id: 'e' }]
    await nextTick()
    assert.equal(list.value.length, 3)
  })

  it('getter 里做的派生（过滤/排序）也会重算', async () => {
    const store = reactive({ lines: [...rows('a', 'b'), { id: 'skip' }] })
    const list = useReactiveList(() => store.lines.filter((r) => r.id !== 'skip'))
    assert.equal(list.value.length, 2)
    store.lines = [...store.lines, { id: 'c' }]
    await nextTick()
    assert.equal(list.value.length, 3)
  })
})

describe('响应式行来源 · ref / computed', () => {
  it('ref：重赋值与 push 都跟上', async () => {
    const source = ref<Row[]>(rows('a'))
    const list = useReactiveList(source)
    assert.equal(list.value.length, 1)

    source.value = rows('b', 'c')
    await nextTick()
    assert.equal(list.value.length, 2)

    source.value.push({ id: 'd' })
    await nextTick()
    assert.equal(list.value.length, 3)
  })

  it('computed：跟随上游变化', async () => {
    const all = ref<Row[]>(rows('a', 'b'))
    const onlyB = ref(false)
    const list = useReactiveList(computed(() => (onlyB.value ? all.value.filter((r) => r.id === 'b') : all.value)))
    assert.equal(list.value.length, 2)

    onlyB.value = true
    await nextTick()
    assert.deepEqual(list.value.map((r) => r.id), ['b'])

    all.value = rows('x', 'y')
    await nextTick()
    assert.deepEqual(list.value.map((r) => r.id), [])
  })
})

describe('响应式行来源 · 普通数组只是快照（必须被记录下来）', () => {
  it('传值不会跟随 store 更新 —— 这正是事故的成因', async () => {
    const store = reactive({ lines: [] as Row[] })
    const list = useReactiveList(store.lines) // 故意传值
    store.lines = rows('a', 'b')
    await nextTick()
    assert.equal(list.value.length, 0, '快照行为必须被钉住，别让下一个人以为它能用')
  })

  it('传普通数组时仍返回快照、不抛错（生产环境静默）', () => {
    const list = useReactiveList(rows('a'))
    assert.equal(list.value.length, 1)
  })
})
