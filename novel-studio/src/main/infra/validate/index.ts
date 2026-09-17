/**
 * 主进程 · 载荷校验器出口
 * ============================================================================
 * 见 docs/20-IPC契约.md §1.2「运行时校验」。
 *
 * 用法（与 zod 一致，将来可整体替换）：
 *   import { v, type Infer } from '../../infra/validate/index.ts'
 *   const ReqSchema = v.object({ chapterId: v.string(), limit: v.optional(v.number().int()) })
 *   type Req = Infer<typeof ReqSchema>
 *   const req = ReqSchema.parse(raw)      // 失败抛 SchemaError（issues 带字段路径）
 *
 * 约定：**只做形状校验**。业务规则（范围、存在性、权限）写在 handler 里，
 * 这样错误码才能给出「该怎么办」的提示（docs/22 §4）。
 */

export {
  Schema,
  SchemaError,
  formatPath,
  v,
  type ArrayOpts,
  type Infer,
  type NumberOpts,
  type ObjectOpts,
  type ParseFailure,
  type ParseSuccess,
  type SafeParseResult,
  type Shape,
  type StringOpts,
  type ValidationCode,
  type ValidationIssue,
} from './schema.ts'

import { SchemaError, type ValidationIssue } from './schema.ts'

/** 校验失败时的 details（进日志，不进 UI；与 errors.ts 的 details 约定一致） */
export interface PayloadIssuesDetails {
  issues: Array<{ path: string; message: string }>
}

/**
 * 从任意异常里提取 issues（zod 的 ZodError 与本仓库的 SchemaError 同形）。
 * registry.ts 调用它构造 INVALID_PAYLOAD 的 details。
 */
export function extractIssues(e: unknown): Array<{ path: string; message: string }> {
  const raw = e instanceof SchemaError
    ? e.issues
    : ((e as { issues?: unknown } | null)?.issues as unknown)
  if (!Array.isArray(raw)) return []
  return (raw as ValidationIssue[]).slice(0, 20).map((i) => ({
    path: Array.isArray(i?.path) ? i.path.join('.') : '',
    message: typeof i?.message === 'string' ? i.message : 'unknown',
  }))
}
