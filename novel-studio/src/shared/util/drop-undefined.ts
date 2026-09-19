/**
 * Novel Studio · 丢掉 `undefined` 的补丁键（保留 `null`）
 * ============================================================================
 * 设计依据：docs/20 §1.2（载荷校验器）、docs/91 §5.2.4（真机事故复盘）
 *
 * ### 为什么需要它：校验器会把「没给的键」物化成 `undefined`
 *   `infra/validate` 的 `ObjectSchema._parse` 会**遍历 shape 的每个键**并写入结果
 *   （这样 handler 里 `req.limit === undefined` 是可靠的判断），于是
 *   `schema.parse({ chapterId, patch: { note: 'x' } })` 里的 `patch` 实际是
 *   `{ text: undefined, kind: undefined, characterId: undefined, note: 'x', ... }` ——
 *   **每个可选键都在**，只是值是 `undefined`。
 *
 *   这带来两类静默错误（都真机上出现过）：
 *     1. **写库**：`UPDATE ... SET text = ?, kind = ?` 把没给的列写成 NULL ——
 *        宽列直接 `NOT NULL constraint failed`（用户看到「未预期的错误」），
 *        可空列则**静默清空**（例如只改标点却把情绪、备注抹掉）。
 *     2. **判断**：`'text' in patch` 恒为真 —— 于是「这条改过文本吗」
 *        「这条改过判定字段吗」全部误判（改停顿也会被当成「改过文本」而作废向量、
 *        被记成人工确认）。
 *
 *   所以约定：**领域补丁里 `undefined` = 没给这个字段**（跳过），
 *   `null` = 明确要清空（照写）。这条规则与 `settings.applyPatch` 完全一致。
 *
 * @example
 *   dropUndefined({ text: undefined, note: 'x' })   // → { note: 'x' }
 *   dropUndefined({ characterId: null })            // → { characterId: null }（null 要保留）
 */
export function dropUndefined<T extends object>(patch: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out as T
}

/**
 * 取补丁里**真正给出**的键（值非 `undefined`）。
 *
 * 用于「这个补丁动过哪些字段」这类判断 —— `key in patch` 在
 * 「载荷经过校验器」之后是不可靠的（见上）。
 */
export function definedKeys<T extends object>(patch: T): Array<keyof T & string> {
  const out: Array<keyof T & string> = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out.push(key as keyof T & string)
  }
  return out
}

/** 补丁里是否**真正给出**了其中任意一个键 */
export function hasAnyDefinedKey<T extends object>(patch: T, keys: readonly (keyof T & string)[]): boolean {
  for (const key of keys) {
    if ((patch as Record<string, unknown>)[key] !== undefined) return true
  }
  return false
}
