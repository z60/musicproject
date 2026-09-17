/**
 * Novel Studio · Prompt 模板库
 * ============================================================================
 * 设计依据：
 *   · docs/06 §6.1   PromptTemplate 结构（id / version / purpose / system / userTemplate /
 *                    outputSchema / examples）
 *   · docs/06 §6.2   说话人复核 `attribution_review`（System 与 User 原文照录）
 *   · docs/06 §6.3   情绪与语速标注 `emotion_tag`
 *   · docs/06 §6.4   第一层防护：明确要求「只输出 JSON」+ 给出输出格式示例 + 少样本
 *
 * 调用时务必把 `id + version` 与结果一起记录（docs/06 §6.1）：
 * 这样「同样的输入为什么结果不同」才有得追溯，缓存键也才稳定（usage.ts computeAiCacheKey）。
 */

import { AppError } from '../../errors.ts'
import { EMOTIONS } from '../../constants.ts'
import type { JsonSchema } from '../types.ts'
import { schemaFromShape, type Shape, type StructuredSchema } from '../structured.ts'
import { renderMessages, renderPrompt } from './render.ts'

// ============================================================================
// 类型（docs/06 §6.1）
// ============================================================================

export type PromptPurpose = 'attribution_review' | 'emotion_tag' | 'canvas_struct' | 'character_extract'

export interface PromptTemplate {
  id: string
  /** 每次修改递增；与结果一起记录，便于回溯（docs/06 §6.1） */
  version: number
  purpose: PromptPurpose
  system: string
  /** 含 `{{变量}}` 占位 */
  userTemplate: string
  outputSchema: JsonSchema
  /** 少样本：用于提高格式服从度（docs/06 §6.4 第一层防护） */
  examples?: Array<{ input: string; output: string }>
}

// ============================================================================
// §6.2 说话人复核
// ============================================================================

export interface AttributionReviewVars {
  /** 角色列表：[{ name, aliases, desc }] */
  characters: Array<{ name: string; aliases?: string; desc?: string }>
  /** 上下文行：[{ index, text }]，index 从 1 开始 */
  context: Array<{ index: number; text: string }>
  lineIndex: number
  text: string
  lineId: string
}

/** 说话人复核的输出形状（docs/06 §6.2 的输出格式） */
export const ATTRIBUTION_REVIEW_SHAPE: Shape = {
  lineId: { type: 'string', description: '必须原样回填待判定行的 lineId' },
  speaker: { type: 'string', description: '角色名，或 "narration" 表示旁白' },
  confidence: { type: 'number', min: 0, max: 1 },
  reason: { type: 'string', maxLength: 40, required: false, description: '不超过 20 字' },
}

export const ATTRIBUTION_REVIEW_TEMPLATE: PromptTemplate = {
  id: 'attribution_review',
  version: 1,
  purpose: 'attribution_review',
  system: [
    '你是一个中文有声书制作助手。你的任务是判断一句台词/旁白归属于哪个角色。',
    '只依据给定的上下文与角色列表判断，不要编造角色。',
    '如果依据不足，把 speaker 设为 "narration" 并把 confidence 设为 0。',
    '必须只输出 JSON，不要输出任何解释性文字。',
  ].join('\n'),
  userTemplate: [
    '## 角色列表',
    '{{#each characters}}',
    '- {{name}}（别名：{{aliases}}）；性格：{{desc}}',
    '{{/each}}',
    '',
    '## 上下文',
    '{{#each context}}',
    '{{index}}. {{text}}',
    '{{/each}}',
    '',
    '## 待判定行',
    '行号：{{lineIndex}}',
    '内容：{{text}}',
    '',
    '## 输出格式',
    '{"lineId":"{{lineId}}","speaker":"角色名或 narration","confidence":0.0,"reason":"不超过20字"}',
  ].join('\n'),
  outputSchema: schemaFromShape(ATTRIBUTION_REVIEW_SHAPE, { name: 'attribution_review' }).jsonSchema,
  examples: [
    {
      input: '## 待判定行\n行号：12\n内容：我萧炎，从来不会认输。',
      output: '{"lineId":"line-12","speaker":"萧炎","confidence":0.92,"reason":"引导语明确指名"}',
    },
  ],
}

// ============================================================================
// §6.3 情绪与语速标注
// ============================================================================

export interface EmotionTagVars {
  /** 可选情绪（默认取 constants.EMOTIONS，与全应用保持一致） */
  emotions?: readonly string[]
  /** 待标注句子：[{ lineId, text }] */
  lines: Array<{ lineId: string; text: string }>
}

export const EMOTION_TAG_SHAPE: Shape = {
  lineId: { type: 'string' },
  emotion: { type: 'string', enum: EMOTIONS },
  intensity: { type: 'integer', min: 1, max: 5 },
  speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
  reason: { type: 'string', maxLength: 80, required: false },
}

export const EMOTION_TAG_TEMPLATE: PromptTemplate = {
  id: 'emotion_tag',
  version: 1,
  purpose: 'emotion_tag',
  system: [
    '你是中文有声书的配音指导。为给定句子标注情绪与语速，用于指导配音演员。',
    `情绪只能从给定列表中选择；语速只能是 slow/normal/fast。`,
    '必须只输出 JSON 数组，不要输出任何解释性文字。',
  ].join('\n'),
  userTemplate: [
    '## 可选情绪',
    '{{emotionList}}',
    '',
    '## 句子列表',
    '{{#each lines}}',
    '{{index}}. [lineId={{lineId}}] {{text}}',
    '{{/each}}',
    '',
    '## 输出格式',
    '[{"lineId":"xxx","emotion":"决绝","intensity":4,"speed":"fast","reason":"..."}]',
  ].join('\n'),
  // 根节点是数组（docs/06 §6.3 的输出就是 JSON 数组）
  outputSchema: schemaFromShape(EMOTION_TAG_SHAPE, { name: 'emotion_tag', root: 'array' }).jsonSchema,
  examples: [
    {
      input: '1. [lineId=xxx] 我萧炎，从来不会认输。',
      output: '[{"lineId":"xxx","emotion":"决绝","intensity":4,"speed":"fast","reason":"情绪爆发"}]',
    },
  ],
}

// ============================================================================
// 注册表
// ============================================================================

/** 已实现（含版本号）的模板表 */
export const PROMPT_TEMPLATES: Readonly<Record<'attribution_review' | 'emotion_tag', PromptTemplate>> = {
  attribution_review: ATTRIBUTION_REVIEW_TEMPLATE,
  emotion_tag: EMOTION_TAG_TEMPLATE,
}

/** 所有模板的 `id@version` 清单（写入 ai_cache / 用量记录用的标签） */
export function listPromptVersions(): Array<{ id: string; version: number; purpose: PromptPurpose }> {
  return Object.values(PROMPT_TEMPLATES).map((t) => ({ id: t.id, version: t.version, purpose: t.purpose }))
}

/** 取模板。未实现的 purpose 明确抛 NOT_IMPLEMENTED，而不是返回空模板 */
export function getPromptTemplate(purpose: PromptPurpose): PromptTemplate {
  if (purpose === 'attribution_review' || purpose === 'emotion_tag') return PROMPT_TEMPLATES[purpose]
  throw new AppError('NOT_IMPLEMENTED', { params: { feature: `Prompt 模板 ${purpose}` } })
}

/**
 * 模板对应的结构化 schema（直接喂给 structured.ts 的 callStructured）。
 *
 * **不加重载**：只用一个 `PromptPurpose` 签名。
 * 曾经写成三条重载（把 `canvas_struct | character_extract` 合成一条），
 * 结果调用点传入 `PromptPurpose` 这种联合实参时，编译器无法把它分配到任何单条重载上，
 * 直接报 TS2769「No overload matches this call」—— 而语义上本来就该接受全部 purpose。
 * 未实现的 purpose 在运行时明确抛 NOT_IMPLEMENTED（与 getPromptTemplate 一致）。
 */
export function getStructuredSchema(purpose: PromptPurpose): StructuredSchema {
  switch (purpose) {
    case 'attribution_review':
      return schemaFromShape(ATTRIBUTION_REVIEW_SHAPE, { name: 'attribution_review' })
    case 'emotion_tag':
      return schemaFromShape(EMOTION_TAG_SHAPE, { name: 'emotion_tag', root: 'array' })
    default:
      throw new AppError('NOT_IMPLEMENTED', { params: { feature: `结构化 schema ${purpose}` } })
  }
}

// ============================================================================
// 便捷渲染：直接产出可发给 Provider 的 messages
// ============================================================================

/**
 * 渲染「说话人复核」的 messages。
 * 上下文行会**显式**放进 prompt —— 这是 Dify 侧「每次新建会话」模式的前提
 * （docs/06 §3.4：不能依赖 conversation_id 携带上下文）。
 */
export function buildAttributionReviewMessages(
  vars: AttributionReviewVars,
  options: { includeExamples?: boolean; onMissing?: (name: string) => void } = {},
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return renderMessages(ATTRIBUTION_REVIEW_TEMPLATE, { ...vars }, options)
}

/** 渲染「情绪与语速标注」的 messages */
export function buildEmotionTagMessages(
  vars: EmotionTagVars,
  options: { includeExamples?: boolean; onMissing?: (name: string) => void } = {},
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const emotions = vars.emotions ?? EMOTIONS
  return renderMessages(
    EMOTION_TAG_TEMPLATE,
    { lines: vars.lines, emotionList: emotions.join(', ') },
    options,
  )
}

/** 只渲染 user 部分（调试/预览用） */
export function previewUserPrompt(purpose: PromptPurpose, vars: Record<string, unknown>): string {
  const template = getPromptTemplate(purpose)
  return renderPrompt(template.userTemplate, vars)
}
