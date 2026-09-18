/* 临时：验证「Vue 响应式 Proxy 无法被结构化克隆」这一机制（与 Electron IPC 同一套 V8 序列化） */
import { reactive, ref, toRaw } from 'vue'

const plain = { id: 'd1', title: '第一章', flags: ['a'] }
const rx = reactive({ id: 'd1', title: '第一章', flags: ['a'] })
const listRef = ref([{ id: 'd1', title: '第一章', flags: ['a'] }])

function attempt(label: string, value: unknown): void {
  try {
    structuredClone(value)
    console.log(`✅ ${label} 可克隆`)
  } catch (e) {
    console.log(`❌ ${label} 抛错: ${(e as Error).name}: ${(e as Error).message}`)
  }
}

attempt('普通对象', plain)
attempt('reactive 对象', rx)
attempt('ref 数组', listRef.value)
attempt('ref 数组里的元素（.filter 出来的）', listRef.value.filter((d) => d.id === 'd1'))
attempt('payload.drafts = 响应式元素数组', { drafts: listRef.value.filter((d) => d.id === 'd1') })
attempt('toRaw(reactive) 后', toRaw(rx))
attempt('toRaw(element)', toRaw(listRef.value[0]!))
attempt('JSON 往返（仓库既有 cloneForIpc 的做法）', JSON.parse(JSON.stringify({ drafts: listRef.value })))
