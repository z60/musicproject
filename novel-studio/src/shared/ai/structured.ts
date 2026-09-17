/**
 * Novel Studio · 结构化输出强制与修复（docs/06 §6.4）
 * ============================================================================
 * LLM 返回的 JSON 经常有瑕疵：markdown 代码围栏、前后废话、字段缺失、枚举越界、
 * ID 幻觉、尾随逗号、被截断…… 本文件用**三层防护**把它们挡在业务代码之外：
 *
 *   1. 提示层：明确「只输出 JSON」+ 内联 schema 示例（`applyPromptLayer`）
 *   2. 解析层：容忍围栏 / 前后废话 / 尾随逗号 / 注释 / 截断，提取**首个合法 JSON**
 *   3. 语义层：schema 校验 + 枚举白名单 + **ID 存在性校验**（拒绝模型编造的 lineId）
 *
 * 仍然失败 → 把错误回传给模型修复（默认 3 轮），最终抛 `AI_INVALID_OUTPUT`，
 * 该批次退回规则结果并标记「AI 不可用」，**不阻塞用户**（docs/06 §6.4 失败处理）。
 *
 * 关于「3 轮」：docs/06 §6.4 的示例代码是 `for (attempt = 0; attempt < 3)`（共 3 次调用），
 * 这里取「1 次首答 + 最多 3 轮修复」（更宽松）。如需严格对齐文档，
 * 传 `maxRepairRounds: 2` 即可。
 *
 * 零第三方依赖：用自实现的轻量 schema（`schemaFromShape`）替代 zod；
 * 真实实现的 zod schema 只需包一层 `{ name, jsonSchema, idFields, validate }` 即可接入。
 */

import { randomUUID } from 'node:crypto'

import { AppError } from '../errors.ts'
import { isUndeterminedResultText } from './providers/local-echo.ts'
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, JsonSchema, ProviderKind } from './types.ts'
import {
  computeAiCacheKey,
  createUsageRecord,
  type AiCacheStore,
  type AiUsageRecord,
} from './usage.ts'

// ============================================================================
// 轻量 schema
// ============================================================================

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export interface StructuredSchema<T = unknown> {
  name: string
  /** 传给 Provider 的 JSON Schema（提示层用） */
  jsonSchema: JsonSchema
  /** 需要做存在性校验的字段名（防幻觉 ID）；空数组表示不校验 */
  idFields: readonly string[]
  validate(value: unknown): ValidationResult<T>
}

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export interface FieldSpec {
  type: FieldType
  /** 默认 true；设 false 表示可选 */
  required?: boolean
  /** 允许 null（与 required 正交：required+nullable = 必须出现但可为 null） */
  nullable?: boolean
  /** 枚举白名单（第三层防护的枚举校验） */
  enum?: readonly (string | number | boolean)[]
  /** 数值区间 */
  min?: number
  max?: number
  /** 字符串长度区间 */
  minLength?: number
  maxLength?: number
  /** 数组元素规格 */
  items?: FieldSpec
  /** 嵌套对象规格 */
  shape?: Shape
  /**
   * 该字段的值必须是 `expectedIds` 之一（防幻觉 ID）。
   * `schemaFromShape` 也会自动识别名字像 ID 的字段（lineId / lineIds）。
   */
  idRef?: boolean
  description?: string
}

export type Shape = Record<string, FieldSpec>

export interface SchemaFromShapeOptions {
  name?: string
  /** 覆盖自动识别的 ID 字段 */
  idFields?: readonly string[]
  description?: string
  /**
   * 根节点形态：
   *   · 'object'（默认）—— 如 `attribution_review` 的单行判定
   *   · 'array'         —— 如 `emotion_tag` 的批量标注 `[{lineId, emotion, ...}]`
   */
  root?: 'object' | 'array'
}

/** 默认自动识别为「ID 字段」的名字（模型最容易编造的就是这几类） */
const AUTO_ID_FIELD_PATTERN = /^(lineId|lineIds|segmentId|segmentIds|chapterId|characterId)$/

/**
 * 从「形状」构造轻量 schema（不依赖 zod，便于在受限环境跑测试）。
 *
 * ```ts
 * const schema = schemaFromShape({
 *   lineId: { type: 'string' },
 *   speaker: { type: 'string' },
 *   confidence: { type: 'number', min: 0, max: 1 },
 *   reason: { type: 'string', maxLength: 40, required: false },
 * }, { name: 'attribution_review' })
 * ```
 */
export function schemaFromShape(shape: Shape, options: SchemaFromShapeOptions = {}): StructuredSchema {
  const name = options.name ?? 'anonymous'
  const autoIds = Object.entries(shape)
    .filter(([key, spec]) => spec.idRef === true || AUTO_ID_FIELD_PATTERN.test(key))
    .map(([key]) => key)
  const idFields = [...new Set([...(options.idFields ?? []), ...autoIds])]

  const root = options.root ?? 'object'
  const jsonSchema: JsonSchema =
    root === 'array'
      ? { type: 'array', items: shapeToJsonSchema(shape, options.description), minItems: 0 }
      : shapeToJsonSchema(shape, options.description)

  return {
    name,
    jsonSchema,
    idFields,
    validate(value: unknown): ValidationResult<unknown> {
      const errors: string[] = []
      if (root === 'array') {
        if (!Array.isArray(value)) {
          return { ok: false, errors: [`返回值期望 array（JSON 数组），实际 ${describeType(value)}`] }
        }
        const out = value.map((item, i) => validateObject(item, shape, `[${i}]`, errors, idFields.length > 0))
        if (errors.length) return { ok: false, errors }
        return { ok: true, value: out }
      }
      const out = validateObject(value, shape, '', errors, idFields.length > 0)
      if (errors.length) return { ok: false, errors }
      return { ok: true, value: out }
    },
  }
}

/** 形状 → JSON Schema（提示层要给模型看的东西） */
export function shapeToJsonSchema(shape: Shape, description?: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(shape)) {
    properties[key] = fieldToJsonSchema(spec)
    if (spec.required !== false) required.push(key)
  }
  const schema: JsonSchema = { type: 'object', properties, required, additionalProperties: false }
  if (description) schema.description = description
  return schema
}

function fieldToJsonSchema(spec: FieldSpec): JsonSchema {
  const out: JsonSchema = {}
  switch (spec.type) {
    case 'integer':
      out.type = 'integer'
      break
    case 'number':
      out.type = 'number'
      break
    case 'boolean':
      out.type = 'boolean'
      break
    case 'array':
      out.type = 'array'
      out.items = spec.items ? fieldToJsonSchema(spec.items) : { type: 'string' }
      break
    case 'object':
      out.type = 'object'
      out.properties = spec.shape ? shapeToJsonSchema(spec.shape).properties : {}
      out.required = spec.shape
        ? Object.entries(spec.shape)
            .filter(([, s]) => s.required !== false)
            .map(([k]) => k)
        : []
      out.additionalProperties = false
      break
    default:
      out.type = 'string'
  }
  if (spec.enum?.length) out.enum = spec.enum
  if (spec.min !== undefined) out.minimum = spec.min
  if (spec.max !== undefined) out.maximum = spec.max
  if (spec.minLength !== undefined) out.minLength = spec.minLength
  if (spec.maxLength !== undefined) out.maxLength = spec.maxLength
  if (spec.description) out.description = spec.description
  return out
}

function validateObject(
  value: unknown,
  shape: Shape,
  path: string,
  errors: string[],
  checkIds: boolean,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${at(path)}期望 object，实际 ${describeType(value)}`)
    return {}
  }
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}

  // 未知字段不算错（模型多给字段时我们只忽略，避免无谓的修复轮），但会记录在 value 里
  for (const [key, raw] of Object.entries(record)) {
    if (!(key in shape)) out[key] = raw
  }

  for (const [key, spec] of Object.entries(shape)) {
    const fieldPath = path ? `${path}.${key}` : key
    const present = Object.prototype.hasOwnProperty.call(record, key)
    const v = record[key]

    if (!present || v === undefined) {
      if (spec.required !== false) errors.push(`${at(fieldPath)}缺少必填字段`)
      continue
    }
    if (v === null) {
      if (spec.nullable) {
        out[key] = null
        continue
      }
      errors.push(`${at(fieldPath)}不允许为 null`)
      continue
    }

    const validated = validateField(v, spec, fieldPath, errors, checkIds)
    if (validated !== undefined) out[key] = validated
  }
  return out
}

function validateField(
  v: unknown,
  spec: FieldSpec,
  fieldPath: string,
  errors: string[],
  checkIds: boolean,
): unknown {
  switch (spec.type) {
    case 'string': {
      if (typeof v !== 'string') {
        errors.push(`${at(fieldPath)}期望 string，实际 ${describeType(v)}`)
        return undefined
      }
      if (spec.minLength !== undefined && v.length < spec.minLength) {
        errors.push(`${at(fieldPath)}长度 ${v.length} 小于最短 ${spec.minLength}`)
      }
      if (spec.maxLength !== undefined && v.length > spec.maxLength) {
        errors.push(`${at(fieldPath)}长度 ${v.length} 超过上限 ${spec.maxLength}`)
      }
      if (spec.enum?.length && !spec.enum.includes(v)) {
        errors.push(`${at(fieldPath)}不在允许取值内：${JSON.stringify(spec.enum)}（实际 ${JSON.stringify(v)}）`)
      }
      return v
    }
    case 'number':
    case 'integer': {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`${at(fieldPath)}期望 ${spec.type}，实际 ${describeType(v)}`)
        return undefined
      }
      if (spec.type === 'integer' && !Number.isInteger(v)) {
        errors.push(`${at(fieldPath)}期望整数，实际 ${v}`)
      }
      if (spec.min !== undefined && v < spec.min) errors.push(`${at(fieldPath)}小于最小值 ${spec.min}`)
      if (spec.max !== undefined && v > spec.max) errors.push(`${at(fieldPath)}大于最大值 ${spec.max}`)
      return v
    }
    case 'boolean': {
      if (typeof v !== 'boolean') {
        errors.push(`${at(fieldPath)}期望 boolean，实际 ${describeType(v)}`)
        return undefined
      }
      return v
    }
    case 'array': {
      if (!Array.isArray(v)) {
        errors.push(`${at(fieldPath)}期望 array，实际 ${describeType(v)}`)
        return undefined
      }
      const out: unknown[] = []
      v.forEach((item, i) => {
        const itemPath = `${fieldPath}[${i}]`
        if (spec.items) {
          if (item === null && spec.items.nullable) {
            out.push(null)
            return
          }
          const validated = validateField(item, spec.items, itemPath, errors, checkIds)
          if (validated !== undefined) out.push(validated)
        } else {
          // 未声明 items：至少在需要时对元素做 ID 存在性校验
          if (checkIds && typeof item === 'string' && AUTO_ID_FIELD_PATTERN.test(fieldPath)) out.push(item)
          else out.push(item)
        }
      })
      return out
    }
    case 'object': {
      if (!spec.shape) return v
      return validateObject(v, spec.shape, fieldPath, errors, checkIds)
    }
    default: {
      errors.push(`${at(fieldPath)}未知字段类型 ${String(spec.type)}`)
      return undefined
    }
  }
}

function at(path: string): string {
  return path ? `字段「${path}」` : '返回值'
}

function describeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// ============================================================================
// 第二层：解析容错
// ============================================================================

/** 去掉 markdown 代码围栏（```json ... ``` / ``` ... ``` / 未闭合的围栏） */
export function stripCodeFence(text: string): string {
  const t = text.replace(/^\uFEFF/, '').trim()
  const fenced = /```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/.exec(t)
  if (fenced) return fenced[1].trim()
  // 未闭合的围栏：去掉首行的 ```xxx 即可
  const openOnly = /^```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*)$/.exec(t)
  if (openOnly) return openOnly[1].trim()
  return t
}

/** 去掉字符串外部的 `//`、`/* *\/` 注释（模型偶尔会带上） */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

/** 去掉字符串外部的「尾随逗号」：`,}` / `,]` */
export function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue // 丢掉这个逗号
    }
    out += ch
  }
  return out
}

export interface ExtractResult {
  ok: boolean
  value?: unknown
  /** 实际用于解析的片段（诊断用） */
  snippet?: string
  error?: string
}

/**
 * 从任意文本中提取**首个能解析成功的 JSON 值**。
 *
 * 做法：以每个 `{` / `[` 为候选起点做「带字符串状态」的配平扫描，
 * 依次尝试：原文 → 去尾随逗号 → 去注释 → 自动补全被截断的括号。
 * 全部失败则返回 `{ ok: false }`（由调用方进入修复轮）。
 */
export function extractJson(text: string): ExtractResult {
  const cleaned = stripCodeFence(text ?? '')
  if (!cleaned) return { ok: false, error: '返回内容为空，没有可解析的 JSON' }

  const starts: number[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') starts.push(i)
  }

  const errors: string[] = []
  for (const start of starts) {
    const scan = scanBalanced(cleaned, start)
    const candidates: string[] = []
    if (scan.closed) {
      candidates.push(scan.text)
      candidates.push(stripTrailingCommas(scan.text))
      candidates.push(stripTrailingCommas(stripJsonComments(scan.text)))
    } else {
      // 被截断：补全括号后再试（模型 max_tokens 用尽时的常见形态）
      const closed = scan.text + scan.unclosed.map((c) => (c === '{' ? '}' : ']')).reverse().join('')
      candidates.push(stripTrailingCommas(closed))
    }
    for (const candidate of candidates) {
      try {
        const value = JSON.parse(candidate)
        return { ok: true, value, snippet: candidate }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
  }

  if (!starts.length) return { ok: false, error: '未能从返回内容中提取到 JSON 结构（缺少 { 或 [）' }
  return { ok: false, error: `JSON 解析失败：${errors[0] ?? '未知原因'}` }
}

interface BalancedScan {
  closed: boolean
  text: string
  /** 未闭合的左括号栈（用于自动补全） */
  unclosed: string[]
}

function scanBalanced(text: string, start: number): BalancedScan {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      stack.pop()
      if (stack.length === 0) return { closed: true, text: text.slice(start, i + 1), unclosed: [] }
    }
  }
  return { closed: false, text: text.slice(start), unclosed: stack }
}

// ============================================================================
// 第三层：ID 存在性校验（防幻觉）
// ============================================================================

/** 递归收集对象树里所有 idFields 字段的字符串值（支持 `[{lineId}]` 形态） */
export function collectIdValues(value: unknown, idFields: readonly string[]): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    if (!v || typeof v !== 'object') return
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (idFields.includes(k)) {
        if (typeof child === 'string') out.push(child)
        else if (Array.isArray(child)) {
          for (const c of child) if (typeof c === 'string') out.push(c)
        }
      }
      walk(child)
    }
  }
  walk(value)
  return out
}

/**
 * 校验 ID 是否存在于「本次请求的输入集合」中。
 * 返回错误列表（空数组 = 通过）。未提供 `expectedIds` 时不做校验。
 */
export function checkExpectedIds(
  value: unknown,
  idFields: readonly string[],
  expectedIds?: readonly string[],
): string[] {
  if (!expectedIds || idFields.length === 0) return []
  const allowed = new Set(expectedIds)
  const errors: string[] = []
  for (const id of collectIdValues(value, idFields)) {
    if (!allowed.has(id)) {
      errors.push(`字段「${idFields.join('/')}」的值 ${JSON.stringify(id)} 不在本次输入集合中（疑似模型编造）`)
    }
  }
  return errors
}

// ============================================================================
// 第一层：提示层
// ============================================================================

/** 「只输出 JSON」的硬约束文本（提示层的第一句，永远放最前面） */
export const JSON_ONLY_INSTRUCTION =
  '你必须只输出一个 JSON 值本身。不要输出 markdown 代码围栏，不要输出任何解释、前后缀或多余文字。'

export function buildJsonOnlyInstruction(schema: StructuredSchema | JsonSchema): string {
  const json = 'jsonSchema' in schema ? schema.jsonSchema : schema
  return `${JSON_ONLY_INSTRUCTION}\n必须满足的 JSON Schema：\n${JSON.stringify(json)}`
}

/**
 * 应用提示层：把「只输出 JSON + schema」塞进 messages。
 * 已有 system 消息则追加在其后（保持原有角色设定优先级更高），否则新插一条。
 * **不修改调用方传入的数组**（返回新数组）。
 */
export function applyPromptLayer(
  messages: readonly ChatMessage[],
  schema: StructuredSchema | JsonSchema,
  enabled = true,
): ChatMessage[] {
  const copy = messages.map((m) => ({ ...m }))
  if (!enabled) return copy
  const instruction = buildJsonOnlyInstruction(schema)
  const first = copy[0]
  if (first && first.role === 'system') {
    copy[0] = { role: 'system', content: `${first.content}\n\n${instruction}` }
  } else {
    copy.unshift({ role: 'system', content: instruction })
  }
  return copy
}

/** 修复轮的 user 消息（把错误原样回传，docs/06 §6.4） */
export function buildRepairMessage(errors: readonly string[]): string {
  const list = errors.slice(0, 8).map((e, i) => `${i + 1}. ${e}`).join('\n')
  return `你的输出不符合要求，错误如下：\n${list}\n请只输出合法 JSON，不要任何解释或代码围栏。`
}

// ============================================================================
// 主入口
// ============================================================================

export interface CallStructuredOptions extends Omit<ChatOptions, 'jsonSchema'> {
  /** 允许出现的 ID 集合（防幻觉 ID）；不传则跳过存在性校验 */
  expectedIds?: readonly string[]
  /** 修复轮次数上限，默认 3（即最多 1 + 3 次调用） */
  maxRepairRounds?: number
  /** 是否启用提示层（默认 true） */
  enforceJsonOnly?: boolean
  /** 命中 `ai_cache` 时直接返回，不发请求（docs/06 §7.1） */
  cache?: AiCacheStore
  /** 写入 ai_cache 时用的模板版本号 */
  promptVersion?: number
  /** 用量记录回调（每条真实调用都会回调一次） */
  onUsage?: (record: AiUsageRecord) => void
  projectId?: string | null
  /** 生成用量记录 id 用（测试可注入确定性 id） */
  newId?: () => string
  now?: () => number
  /** 「无法判定」是否直接当不可用抛出（默认 true，避免白跑 3 轮） */
  treatUndeterminedAsUnavailable?: boolean
  /** 每次尝试后的回调（诊断/测试用） */
  onAttempt?: (info: AttemptInfo) => void
}

export interface AttemptInfo {
  attempt: number
  ok: boolean
  errors?: string[]
  textChars: number
  raw: string
}

export interface StructuredCallResult<T> {
  value: T
  /** 实际调用次数（含首答与修复轮） */
  attempts: number
  /** 是否经过修复轮才成功 */
  repaired: boolean
  /** 是否直接命中缓存（此时 attempts = 0） */
  cached: boolean
  raw: string
  /** 最后一次调用的 chat 结果（缓存命中时为 null） */
  chat: ChatResult | null
}

/**
 * 三层防护的结构化调用。失败抛 `AI_INVALID_OUTPUT`（docs/06 §6.4）。
 */
export async function callStructured<T>(
  provider: AIProvider,
  messages: readonly ChatMessage[],
  schema: StructuredSchema<T>,
  opts: CallStructuredOptions,
): Promise<StructuredCallResult<T>> {
  const maxRepairRounds = Math.max(0, opts.maxRepairRounds ?? 3)
  const now = opts.now ?? Date.now
  const newId = opts.newId ?? randomUUID
  const treatUndetermined = opts.treatUndeterminedAsUnavailable !== false

  const baseMessages = applyPromptLayer(messages, schema, opts.enforceJsonOnly !== false)
  const chatOpts: ChatOptions = {
    model: opts.model,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    jsonSchema: schema.jsonSchema,
    signal: opts.signal,
    purpose: opts.purpose ?? schema.name,
    allowCloud: opts.allowCloud,
    reuseConversation: opts.reuseConversation,
    timeoutMs: opts.timeoutMs,
    requestTag: opts.requestTag,
  }

  // ---- 缓存命中：连 1 次调用都不发（docs/06 §7.1） ----
  const cacheKey = opts.cache
    ? computeAiCacheKey({
        promptId: schema.name,
        version: opts.promptVersion ?? 1,
        model: chatOpts.model ?? provider.kind,
        inputs: baseMessages,
        extra: opts.expectedIds ? `${opts.expectedIds.length}` : undefined,
      })
    : null
  if (cacheKey && opts.cache) {
    const hit = opts.cache.get(cacheKey)
    if (hit) {
      const parsed = extractJson(hit.response)
      if (parsed.ok) {
        const validated = schema.validate(parsed.value)
        if (validated.ok) {
          const idErrors = checkExpectedIds(validated.value, schema.idFields, opts.expectedIds)
          if (!idErrors.length) {
            opts.cache.hit(cacheKey)
            return {
              value: validated.value,
              attempts: 0,
              repaired: false,
              cached: true,
              raw: hit.response,
              chat: null,
            }
          }
        }
      }
      // 缓存内容已不可用（模板/schema 变更）：忽略，继续走真实调用
    }
  }

  let convo: ChatMessage[] = baseMessages
  let lastErrors: string[] = ['尚未调用']
  let lastRaw = ''
      // 说明：本轮不需要保留上一次 chat 结果；如需调试可临时加回 `let lastChat`

  for (let round = 0; round <= maxRepairRounds; round++) {
    if (opts.signal?.aborted) throw new AppError('PROVIDER_ABORTED')

    const started = now()
    const chat = await provider.chat(convo, chatOpts)
    /* 记录可选：会话追踪用 */
    lastRaw = chat.text

    opts.onUsage?.(
      createUsageRecord({
        id: newId(),
        projectId: opts.projectId ?? null,
        purpose: chatOpts.purpose ?? schema.name,
        provider: chat.provider as ProviderKind,
        model: chat.model,
        usage: chat.usage,
        latencyMs: chat.latencyMs,
        now,
      }),
    )

    // 「无法判定」是本地兜底的有意回答，不是格式错误：立刻上报不可用，
    // 让上层走规则 + 人工路径，而不是白跑 3 轮修复（docs/06 §8）。
    if (treatUndetermined && isUndeterminedResultText(chat.text)) {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        details: {
          provider: chat.provider,
          reason: 'undetermined',
          purpose: chatOpts.purpose ?? schema.name,
        },
      })
    }

    const parsed = extractJson(chat.text)
    if (parsed.ok) {
      const validated = schema.validate(parsed.value)
      if (validated.ok) {
        const idErrors = checkExpectedIds(validated.value, schema.idFields, opts.expectedIds)
        if (!idErrors.length) {
          opts.onAttempt?.({ attempt: round + 1, ok: true, textChars: chat.text.length, raw: chat.text })
          if (cacheKey && opts.cache) {
            opts.cache.put({
              cacheKey,
              purpose: chatOpts.purpose ?? schema.name,
              model: chat.model,
              provider: chat.provider,
              response: chat.text,
              createdAt: started,
              hits: 0,
            })
          }
          return {
            value: validated.value,
            attempts: round + 1,
            repaired: round > 0,
            cached: false,
            raw: chat.text,
            chat,
          }
        }
        lastErrors = idErrors
      } else {
        lastErrors = validated.errors
      }
    } else {
      lastErrors = [parsed.error ?? '无法提取 JSON']
    }

    opts.onAttempt?.({
      attempt: round + 1,
      ok: false,
      errors: lastErrors,
      textChars: chat.text.length,
      raw: chat.text,
    })

    if (round < maxRepairRounds) {
      convo = [
        ...convo,
        { role: 'assistant', content: chat.text },
        { role: 'user', content: buildRepairMessage(lastErrors) },
      ]
    }
  }

  throw new AppError('AI_INVALID_OUTPUT', {
    params: { attempts: maxRepairRounds + 1 },
    details: {
      schema: schema.name,
      errors: lastErrors.slice(0, 8),
      textChars: lastRaw.length,
    },
  })
}

/** 便捷版：只取校验后的值（不需要 attempts/usage 元信息时用） */
export async function callStructuredValue<T>(
  provider: AIProvider,
  messages: readonly ChatMessage[],
  schema: StructuredSchema<T>,
  opts: CallStructuredOptions,
): Promise<T> {
  const res = await callStructured(provider, messages, schema, opts)
  return res.value
}
