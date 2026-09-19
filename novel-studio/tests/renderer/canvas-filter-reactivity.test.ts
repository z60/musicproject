/**
 * 测试 · 画本筛选的响应式（真机事故回归）
 * ============================================================================
 * 事故（docs/91 §5.2.27）：点开任意章节，画本表格恒显示
 * 「当前筛选下没有行。可以放宽筛选条件，或切换章节。」，而库里那一章有 85 行。
 *
 * 根因：`useCanvasFilter(canvas.lines)` 传的是**值**。Pinia 的 setup store 会把 `ref` 解包，
 * 所以 `canvas.lines` 是「取用那一刻的数组对象」；composable 里
 * `computed(() => source)` 的求值体**不读任何响应式属性** → 永不重新求值；
 * 而 `canvas.load()` 是 `lines.value = collected`（**整体重赋值**）→ 捕获到的旧数组永远是空的。
 *
 * 这组测试把「getter 必须跟随重赋值与增删」钉死，同时也钉住「普通数组只是快照」这一事实
 * （避免有人把它当成响应式来源）。用真的 `vue` 响应式系统，不 mock。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { computed, nextTick, reactive, ref } from 'vue'

import type { CanvasLine } from '../../src/shared/types.ts'
import { useCanvasFilter, SPEAKER_ANY } from '../../src/renderer/src/features/editor/composables/useCanvasFilter.ts'

function line(id: string, patch: Partial<CanvasLine> = {}): CanvasLine {
  return {
    id,
    chapterId: 'c1',
    bookId: 'b1',
    seq: 0,
    speakerType: 'narration',
    characterId: null,
    kind: 'narration',
    text: id,
    emotion: null,
    speed: null,
    gainDb: null,
    pauseAfterMs: 500,
    needsReview: false,
    state: 'draft',
    flags: [],
    isTitle: false,
    rev: 1,
    ...patch,
  } as CanvasLine
}

describe('画本筛选 · 响应式来源', () => {
  it('getter 来源：store 整体重赋值后必须跟上（事故的直接回归）', async () => {
    // 模拟 Pinia setup store：`lines` 是 ref，解包后是一个数组
    const store = reactive({ lines: [] as CanvasLine[] })
    const filter = useCanvasFilter(() => store.lines)

    assert.equal(filter.filtered.value.length, 0, '初始为空是对的')

    // `canvas.load()` 的行为：整体重赋值
    store.lines = [line('a'), line('b')]
    await nextTick()
    assert.equal(filter.filtered.value.length, 2, '重赋值后筛选结果必须跟上（旧实现在这里是 0）')

    // 再换一章（又一次重赋值）
    store.lines = [line('c')]
    await nextTick()
    assert.equal(filter.filtered.value.length, 1)

    // 站内改动（整章替换/追加）也要跟上
    store.lines = [...store.lines, line('d'), line('e')]
    await nextTick()
    assert.equal(filter.filtered.value.length, 3)
  })

  it('ref 来源：重赋值与 push 都跟上', async () => {
    const lines = ref<CanvasLine[]>([line('a')])
    const filter = useCanvasFilter(lines)
    assert.equal(filter.filtered.value.length, 1)

    lines.value = [line('b'), line('c')]
    await nextTick()
    assert.equal(filter.filtered.value.length, 2)

    lines.value.push(line('d'))
    await nextTick()
    assert.equal(filter.filtered.value.length, 3)
  })

  it('computed 来源：跟随上游变化', async () => {
    const all = ref<CanvasLine[]>([line('a'), line('b')])
    const needReview = ref(false)
    const source = computed(() => all.value.filter((l) => l.needsReview === needReview.value))
    const filter = useCanvasFilter(source)
    assert.equal(filter.filtered.value.length, 0)

    all.value = [line('a', { needsReview: true }), line('b')]
    needReview.value = true
    await nextTick()
    assert.equal(filter.filtered.value.length, 1)
  })

  it('普通数组只是**快照**（不是响应式来源）—— 传它就会得到「永远不变」的视图', () => {
    const store = reactive({ lines: [] as CanvasLine[] })
    const filter = useCanvasFilter(store.lines) // 故意传值
    store.lines = [line('a'), line('b')]
    // 这正是旧实现的行为：捕获的数组对象不会因为 store 换了数组而更新
    assert.equal(filter.filtered.value.length, 0, '快照行为必须被记录下来，别让下一个人以为它能用')
  })
})

describe('画本筛选 · 筛选语义（getter 来源下）', () => {
  it('默认筛选不隐藏任何行；各筛选条件按预期生效', async () => {
    const store = reactive({
      lines: [
        line('a', { state: 'draft', needsReview: true }),
        line('b', { state: 'recorded', speakerType: 'character', characterId: 'ch1', kind: 'dialogue' }),
        line('c', { flags: ['deleted'] }),
      ],
    })
    const filter = useCanvasFilter(() => store.lines)
    assert.equal(filter.filter.value.speaker, SPEAKER_ANY)
    // 软删除行默认不显示（includeDeleted 默认 false）
    assert.equal(filter.filtered.value.length, 2)
    assert.deepEqual(filter.filtered.value.map((l) => l.id), ['a', 'b'])

    filter.set({ needsReview: true })
    assert.deepEqual(filter.filtered.value.map((l) => l.id), ['a'])

    filter.set({ needsReview: null, state: 'recorded' })
    assert.deepEqual(filter.filtered.value.map((l) => l.id), ['b'])

    filter.set({ state: null, speaker: 'ch1' })
    assert.deepEqual(filter.filtered.value.map((l) => l.id), ['b'])

    filter.reset()
    assert.equal(filter.filtered.value.length, 2)
    assert.equal(filter.counts.value.total, 2)
    assert.equal(filter.counts.value.deleted, 1)
  })
})
