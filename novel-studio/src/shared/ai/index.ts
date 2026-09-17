/**
 * Novel Studio · AI Provider 抽象层（对外统一出口）
 * ============================================================================
 * 设计依据：docs/06-AI抽象层与向量判定.md
 *
 * 目录结构：
 *   types.ts              契约（AIProvider / EmbeddingProvider / ChatOptions / HttpClient …）
 *   http.ts               内置 fetch 实现与 HTTP 状态码 → 业务错误映射
 *   providers/            mock / local-echo / openai-compatible / dify / fallback
 *   factory.ts            resolveProvider（按 settings.ai.provider 组装降级链）
 *   structured.ts         结构化输出三层防护（提示 / 解析 / 语义 + 修复轮）
 *   usage.ts              缓存键、用量记录、成本估算、脱敏辅助
 *   budget.ts             调用预算与预估消耗
 *   prompts/              模板与渲染
 *   embedding/            确定性伪向量（测试）/ ONNX 骨架 / 向量缓存
 *
 * 模块边界：本目录**不 import** `src/shared/audio/**` 与 `src/shared/canvas/**`，
 * 也不 import 任何第三方包（受限环境要能用 `node --experimental-strip-types` 直接跑测试）。
 *
 * ⚠ 进程边界（接 IPC 时注意）：
 *   · `types.ts` 只用类型，**渲染进程可以直接 import**（`import type { ChatOptions } from '@/shared/ai/types.ts'`）。
 *   · 其余模块用了 `node:crypto` / `Buffer`（sha256、base64、脱敏日志），属于**主进程专用**：
 *     Provider、预算、缓存、prompt 渲染都应在主进程执行，渲染侧只通过 IPC 拿结果与用量。
 *     渲染进程整包 import 本 index 会在打包阶段因为 node: 内置模块报错。
 */

export * from './types.ts'
export * from './http.ts'
export * from './usage.ts'
export * from './budget.ts'
export * from './structured.ts'
export * from './factory.ts'

export * from './providers/mock.ts'
export * from './providers/local-echo.ts'
export * from './providers/openai-compatible.ts'
export * from './providers/dify.ts'
export * from './providers/fallback.ts'

export * from './prompts/render.ts'
export * from './prompts/templates.ts'

export * from './embedding/deterministic.ts'
export * from './embedding/cache.ts'
export * from './embedding/onnx-provider.ts'
