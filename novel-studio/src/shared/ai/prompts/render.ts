/**
 * Novel Studio · Prompt 模板渲染
 * ============================================================================
 * 设计依据：docs/06 §6.1 模板管理（`{{变量}}` 占位）、§6.2/§6.3 的两个模板
 *
 * 只实现「够用且可预测」的子集（**刻意不做完整模板引擎**，避免把 prompt 变成代码）：
 *   · `{{var}}`            —— 变量插值，支持 `{{a.b}}` 点路径
 *   · `{{#each list}}...{{/each}}` —— 简单循环（不支持嵌套循环）
 *       循环体内可用 `{{this}}`（元素本身）、`{{field}}`（对象元素字段）、
 *       `{{index}}`（从 1 开始）、`{{index0}}`（从 0 开始）
 *   · `{{#if var}}...{{/if}}` —— 简单条件（真值：非空字符串/非 0/非空数组/true）
 *
 * 铁律：
 *   · **缺失变量渲染成空串**，绝不抛错 —— prompt 少一个变量不该让业务任务失败；
 *     需要发现缺失时传 `onMissing` 回调（会进日志，不含正文）。
 *   · 未闭合的 `{{#each}}` 不吞内容：原样保留，便于在测试里立刻发现模板写错。
 */

export interface RenderPromptOptions {
  /** 缺失变量回调（只记变量名，不记值 —— docs/06 §9 隐私） */
  onMissing?: (varName: string) => void
  /** 缺失变量替换成什么，默认空串 */
  missingPlaceholder?: string
}

/** 渲染变量的取值作用域栈（循环内层优先） */
type Scope = Record<string, unknown>

/**
 * 渲染模板。`vars` 既可以是普通对象，也可以是数组（等价于 `{ this: [...] }`）。
 */
export function renderPrompt(
  template: string,
  vars: Record<string, unknown> | unknown[],
  options: RenderPromptOptions = {},
): string {
  const root: Scope = Array.isArray(vars) ? { this: vars } : { ...vars }
  const missing = options.missingPlaceholder ?? ''

  // 1) 条件块（先做内层，非嵌套）
  let out = template.replace(
    /\{\{#if\s+([\w.$]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, name: string, body: string) => {
      const v = lookup(name, [root])
      return isTruthy(v) ? body : ''
    },
  )

  // 2) each 循环
  out = out.replace(
    /\{\{#each\s+([\w.$]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_m, name: string, body: string) => {
      const list = lookup(name, [root])
      if (!Array.isArray(list) || list.length === 0) return ''
      return list
        .map((item, i) => renderEachBody(body, item, i, [root], options, missing))
        .join('')
    },
  )

  // 3) 剩下的变量插值
  return interpolate(out, [root], options, missing)
}

function renderEachBody(
  body: string,
  item: unknown,
  index: number,
  outerScopes: Scope[],
  options: RenderPromptOptions,
  missing: string,
): string {
  const itemScope: Scope =
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Scope)
      : { this: item }
  // 循环体内也能直接用 {{index}} / {{index0}}
  const scopes: Scope[] = [{ index: index + 1, index0: index, this: item }, itemScope, ...outerScopes]
  return interpolate(body, scopes, options, missing)
}

function interpolate(
  text: string,
  scopes: Scope[],
  options: RenderPromptOptions,
  missing: string,
): string {
  return text.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (whole, name: string) => {
    if (name.startsWith('#') || name.startsWith('/')) return whole // 未闭合的块标记：原样保留
    const v = lookup(name, scopes)
    if (v === undefined || v === null) {
      options.onMissing?.(name)
      return missing
    }
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x))).join(', ')
    return JSON.stringify(v)
  })
}

/** 按作用域栈查找 `a.b.c`；未找到返回 undefined */
export function lookup(path: string, scopes: Scope[]): unknown {
  if (path === '.') path = 'this'
  for (const scope of scopes) {
    const v = lookupIn(scope, path)
    if (v !== undefined) return v
  }
  return undefined
}

function lookupIn(scope: Scope, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = scope
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * 渲染出模板（system + user 两条消息）。
 * 少样本示例（`examples`）会作为额外的 assistant 消息插入，用于提升格式服从度（docs/06 §6.4 第一层防护）。
 */
export function renderMessages(
  template: { system: string; userTemplate: string; examples?: ReadonlyArray<{ input: string; output: string }> },
  vars: Record<string, unknown> | unknown[],
  options: RenderPromptOptions & { includeExamples?: boolean } = {},
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: renderPrompt(template.system, vars, options) },
  ]
  if (options.includeExamples !== false && template.examples?.length) {
    for (const ex of template.examples) {
      messages.push({ role: 'user', content: ex.input })
      messages.push({ role: 'assistant', content: ex.output })
    }
  }
  messages.push({ role: 'user', content: renderPrompt(template.userTemplate, vars, options) })
  return messages
}
