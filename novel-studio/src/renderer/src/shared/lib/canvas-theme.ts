/**
 * Novel Studio · 画布取色（Canvas 读不了 CSS 变量，只能自己从 `:root` 取）
 * ============================================================================
 * 为什么要有这个文件（真机反馈：深色模式下「有些背景是白的」「有些字是深灰」）：
 *   `assets/theme.css` 用 `--ns-*` 变量区分深浅色，DOM 组件自动跟随；
 *   但 **Canvas / 2D 上下文不认 CSS 变量**，于是画布代码里写死了一批浅色
 *   （`#ffffff` 底色、`rgba(48,49,51,0.9)` 文字），切到深色主题后画布还是白的、
 *   线条还是深灰的。统一走这里读变量，取不到再退回浅色兜底值。
 *
 * 只依赖 `vue` 之外的**标准库**（`globalThis.document` 可选），因此能在 Node 里直接测：
 * 没有 DOM 时返回兜底值（这也是它唯一需要的降级行为）。
 */

/** 可读 CSS 变量的最小接口（`CSSStyleDeclaration` 满足它，测试里给个假的即可） */
export interface CssVarSource {
  getPropertyValue(name: string): string
}

/**
 * 从变量源读一个值；空串/纯空白视为「没取到」→ 返回兜底值。
 *
 * 抽成纯函数是为了让「切主题后到底取到了什么」可测（DOM 在 Node 里不存在）。
 */
export function readThemeVar(source: CssVarSource | null | undefined, name: string, fallback: string): string {
  if (!source || typeof source.getPropertyValue !== 'function') return fallback
  const value = (source.getPropertyValue(name) ?? '').trim()
  return value.length > 0 ? value : fallback
}

/**
 * 从 `<html>` 的计算样式里读主题变量。
 *
 * 每次需要时现取（很便宜），这样用户切深浅色后下一次重绘就是新颜色 ——
 * 不需要把「主题变化」这件事记在画布代码里。
 *
 * DOM 全局用**宽松类型**取：这个文件会被 `tests/renderer` 直接 import（Node 里没有 DOM lib），
 * 写成 `globalThis.document` 在 node 工程的类型检查下会报 TS7017。
 */
export function themeColor(name: string, fallback: string): string {
  const g = globalThis as {
    document?: { documentElement?: unknown }
    getComputedStyle?: (element: unknown) => CssVarSource
  }
  const root = g.document?.documentElement
  if (!root || typeof g.getComputedStyle !== 'function') return fallback
  return readThemeVar(g.getComputedStyle(root), name, fallback)
}
