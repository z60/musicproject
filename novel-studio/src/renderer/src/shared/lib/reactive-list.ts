/**
 * Novel Studio · 响应式行来源的归一（**纯逻辑，无路径别名**）
 * ============================================================================
 * 真机事故（docs/91 §5.2.27）：
 *   画本编辑点开任意章节，表格恒显示「当前筛选下没有行。可以放宽筛选条件，或切换章节。」，
 *   而库里那一章有 85 行。
 *
 * 根因：调用方把**值**传进了筛选 composable —— `useCanvasFilter(canvas.lines)`。
 * Pinia 的 setup store 会把 `ref` 解包，所以 `canvas.lines` 是「取用那一刻的数组对象」；
 * 而 `computed(() => source)` 的求值体**不读任何响应式属性**，于是永不重新求值，
 * 而 `canvas.load()` 是 `lines.value = collected`（**整体重赋值**）——
 * 捕获到的旧数组永远是空的，视图也就永远是空的。
 *
 * 修法：允许传 getter（`() => canvas.lines`），并在这里把三种来源统一归一。
 * **这个文件刻意不 import 任何项目内模块**（只有 `vue`）：它是纯逻辑，
 * 因此可以在 Node 里被单测直接覆盖 —— 只有能被测到，才可能被钉住。
 */

import { computed, type ComputedRef, type Ref } from 'vue'

/**
 * 行数据的来源：
 *   · `() => T[]`（**推荐**）—— 每次求值都重新读 store，跟随重赋值与增删；
 *   · `Ref<T[]>` / `ComputedRef<T[]>` —— 正常工作；
 *   · `T[]` —— 只是**一次性快照**（不是响应式来源），开发期会有一次 warn 指明正确写法。
 */
export type ReactiveArraySource<T> = Ref<T[]> | ComputedRef<T[]> | (() => T[]) | T[]

let warnedPlainArray = false

/** 开发期提示：普通数组是快照，不是响应式来源（只在开发环境、每次进程只提示一次） */
function warnPlainArrayOnce(): void {
  if (warnedPlainArray) return
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
  if (!env?.DEV) return
  warnedPlainArray = true
  console.warn(
    '[useReactiveList] 传入的是普通数组，它只是快照、不会跟随 store 更新。' +
      '请改传 getter：useReactiveList(() => store.items)',
  )
}

/**
 * 把三种来源归一成一个 `ComputedRef`。
 *
 * @throws 不抛异常
 */
export function useReactiveList<T>(source: ReactiveArraySource<T>): ComputedRef<T[]> {
  return computed<T[]>(() => {
    if (typeof source === 'function') return source()
    if (Array.isArray(source)) {
      warnPlainArrayOnce()
      return source
    }
    return source.value
  })
}
