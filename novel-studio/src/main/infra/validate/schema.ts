/**
 * Novel Studio · 极简运行时校验器（zod 的内置替代品）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §1「运行时校验」、§5.1「INVALID_PAYLOAD 契约」、
 *          docs/22-错误码与消息体系.md §6.1（handler 入口校验的必要性）
 *
 * 为什么自己写而不是用 zod：
 *   1. 生产环境（Electron 打包后）本来可以用 zod，但本仓库的**测试与脚本要能被
 *      Node 原生 `--experimental-strip-types` 直接跑**，不允许任何第三方依赖；
 *   2. IPC 载荷校验只用到极少几个原语（对象/字符串/数字/布尔/数组/字面量/联合），
 *      为此引入一个上百 KB 的依赖不划算。
 *
 * 与 zod 的兼容点（**将来可整体替换为 zod**）：
 *   · 调用形态一致：`schema.parse(x)`，失败抛错
 *   · 错误对象带 `issues: Array<{ path, message, code }>`，`path` 为 `(string|number)[]`
 *     —— 与 `ZodError.issues` 同形，`registry.ts` 的 `extractIssues()` 无需改动
 *   · `safeParse(x)` 返回 `{ success: true, data }` / `{ success: false, error }`
 *   · `.optional()` / `.nullable()` / `.partial()` 语义与 zod 相同
 *   · 反推断类型通过 `Infer<typeof schema>` 取得（等价于 `z.infer`）
 *
 * 有意不支持：refine/transform/coerce/discriminatedUnion —— 校验器只管「形状对不对」，
 * 业务规则属于业务层（避免把业务语义藏进 schema）。
 *
 * 实现约束：本文件必须能被 Node 的 `--experimental-strip-types` 直接执行，
 * 因此**不使用参数属性（constructor(private x)）、enum、namespace** 等不可擦除语法。
 */

/** 单个校验问题（与 zod 的 Issue 同形，便于将来替换实现） */
export interface ValidationIssue {
  /** 字段路径，如 ['filter', 'needsReview']；根节点为空数组 */
  path: Array<string | number>
  /** 已本地化的中文说明 */
  message: string
  /** 机器可读的分类（zod 用同一字段放 ZodIssueCode） */
  code: ValidationCode
}

export type ValidationCode =
  | 'invalid_type'
  | 'invalid_literal'
  | 'invalid_union'
  | 'too_small'
  | 'too_big'
  | 'invalid_string'
  | 'unrecognized_keys'

/** 校验失败异常。消息里带完整字段路径，便于日志一行定位。 */
export class SchemaError extends Error {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    const first = issues[0]
    const where = first ? formatPath(first.path) : '<root>'
    super(`载荷校验失败：${where} ${first ? first.message : '未知问题'}（共 ${issues.length} 处）`)
    this.name = 'SchemaError'
    Object.setPrototypeOf(this, SchemaError.prototype)
    this.issues = issues
  }
}

/** 把路径数组格式化成 `filter.needsReview` / `items[3].id` */
export function formatPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return '<root>'
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out === '' ? seg : `.${seg}`
  }
  return out
}

export interface ParseSuccess<T> {
  success: true
  data: T
}
export interface ParseFailure {
  success: false
  error: SchemaError
}
export type SafeParseResult<T> = ParseSuccess<T> | ParseFailure

/** 字符串约束 */
export interface StringOpts {
  min?: number
  max?: number
  regex?: RegExp
  /** 只允许非空（默认 true，空串在 IPC 载荷里几乎总是 bug） */
  nonEmpty?: boolean
}
/** 数字约束 */
export interface NumberOpts {
  int?: boolean
  min?: number
  max?: number
  /** 是否拒绝 NaN/Infinity（默认拒绝） */
  finite?: boolean
}
/** 数组约束 */
export interface ArrayOpts {
  min?: number
  max?: number
}
/** 对象约束 */
export interface ObjectOpts {
  /**
   * 未声明字段的处理：
   *   · 'strip'（默认，与 zod 一致）剔除
   *   · 'strict' 拒绝（报 unrecognized_keys）
   *   · 'passthrough' 原样保留（转发型载荷，如 `options: Record<string, unknown>`）
   */
  unknownKeys?: 'strip' | 'strict' | 'passthrough'
}

/**
 * schema 基类。`_type` 只用于类型推断，运行期恒为 undefined。
 * 不用 `abstract`：Node 的类型剥离对 abstract 成员支持有限，用运行期抛错替代编译期约束。
 */
export class Schema<T> {
  /** @internal 仅用于类型推断（`Infer<>`），运行期不使用 */
  _type?: T

  /** 子类必须覆盖。返回解析结果，问题追加到 issues（不抛错）。 */
  _parse(_value: unknown, _path: Array<string | number>, _issues: ValidationIssue[]): T {
    throw new Error('[validate] 基类 Schema 不可直接使用')
  }

  /** 与 zod 一致：失败抛 SchemaError */
  parse(value: unknown): T {
    const issues: ValidationIssue[] = []
    const out = this._parse(value, [], issues)
    if (issues.length > 0) throw new SchemaError(issues)
    return out
  }

  safeParse(value: unknown): SafeParseResult<T> {
    const issues: ValidationIssue[] = []
    const out = this._parse(value, [], issues)
    if (issues.length > 0) return { success: false, error: new SchemaError(issues) }
    return { success: true, data: out }
  }

  /** 允许 undefined（缺省字段）；`v.object` 的可选字段语义靠它 */
  optional(): Schema<T | undefined> {
    return new OptionalSchema<T>(this)
  }

  /** 允许 null（数据库里的可空列常传 null） */
  nullable(): Schema<T | null> {
    return new NullableSchema<T>(this)
  }

  /** 带默认值：`undefined` 时取默认值（不适用于 null） */
  default(value: T): Schema<T> {
    return new DefaultSchema<T>(this, value)
  }
}

/** 反推断类型（等价 `z.infer<typeof S>`） */
export type Infer<S> = S extends Schema<infer T> ? T : never

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function typeName(x: unknown): string {
  if (x === null) return 'null'
  if (Array.isArray(x)) return 'array'
  return typeof x
}

function show(x: unknown): string {
  try {
    const s = JSON.stringify(x)
    return s === undefined ? String(x) : s
  } catch {
    return String(x)
  }
}

// ---------------------------------------------------------------------------
// 原语实现
// ---------------------------------------------------------------------------

class StringSchema extends Schema<string> {
  readonly opts: StringOpts
  constructor(opts?: StringOpts) {
    super()
    this.opts = opts ?? {}
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): string {
    if (typeof value !== 'string') {
      issues.push({ path: [...path], message: `应为字符串，实际是 ${typeName(value)}`, code: 'invalid_type' })
      return ''
    }
    const nonEmpty = this.opts.nonEmpty ?? true
    if (nonEmpty && value.length === 0) {
      issues.push({ path: [...path], message: '不能为空字符串', code: 'too_small' })
    }
    if (this.opts.min !== undefined && value.length < this.opts.min) {
      issues.push({ path: [...path], message: `长度至少 ${this.opts.min}，实际 ${value.length}`, code: 'too_small' })
    }
    if (this.opts.max !== undefined && value.length > this.opts.max) {
      issues.push({ path: [...path], message: `长度最多 ${this.opts.max}，实际 ${value.length}`, code: 'too_big' })
    }
    if (this.opts.regex && !this.opts.regex.test(value)) {
      issues.push({ path: [...path], message: `不符合格式 ${String(this.opts.regex)}`, code: 'invalid_string' })
    }
    return value
  }

  min(n: number): StringSchema {
    return new StringSchema({ ...this.opts, min: n })
  }
  max(n: number): StringSchema {
    return new StringSchema({ ...this.opts, max: n })
  }
  regex(re: RegExp): StringSchema {
    return new StringSchema({ ...this.opts, regex: re })
  }
  /** 允许空串（默认不允许） */
  allowEmpty(): StringSchema {
    return new StringSchema({ ...this.opts, nonEmpty: false })
  }
}

class NumberSchema extends Schema<number> {
  readonly opts: NumberOpts
  constructor(opts?: NumberOpts) {
    super()
    this.opts = opts ?? {}
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): number {
    if (typeof value !== 'number') {
      issues.push({ path: [...path], message: `应为数字，实际是 ${typeName(value)}`, code: 'invalid_type' })
      return 0
    }
    const finite = this.opts.finite ?? true
    if (finite && !Number.isFinite(value)) {
      issues.push({ path: [...path], message: '必须是有穷数字（不支持 NaN/Infinity）', code: 'invalid_type' })
      return 0
    }
    if (this.opts.int && !Number.isInteger(value)) {
      issues.push({ path: [...path], message: `应为整数，实际 ${value}`, code: 'invalid_type' })
    }
    if (this.opts.min !== undefined && value < this.opts.min) {
      issues.push({ path: [...path], message: `不能小于 ${this.opts.min}，实际 ${value}`, code: 'too_small' })
    }
    if (this.opts.max !== undefined && value > this.opts.max) {
      issues.push({ path: [...path], message: `不能大于 ${this.opts.max}，实际 ${value}`, code: 'too_big' })
    }
    return value
  }

  int(): NumberSchema {
    return new NumberSchema({ ...this.opts, int: true })
  }
  min(n: number): NumberSchema {
    return new NumberSchema({ ...this.opts, min: n })
  }
  max(n: number): NumberSchema {
    return new NumberSchema({ ...this.opts, max: n })
  }
}

class BooleanSchema extends Schema<boolean> {
  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): boolean {
    if (typeof value !== 'boolean') {
      issues.push({ path: [...path], message: `应为布尔值，实际是 ${typeName(value)}`, code: 'invalid_type' })
      return false
    }
    return value
  }
}

class LiteralSchema<T extends string | number | boolean | null> extends Schema<T> {
  readonly expected: T
  constructor(expected: T) {
    super()
    this.expected = expected
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): T {
    if (value !== this.expected) {
      issues.push({
        path: [...path],
        message: `应为 ${show(this.expected)}，实际 ${show(value)}`,
        code: 'invalid_literal',
      })
    }
    return this.expected
  }
}

class ArraySchema<T> extends Schema<T[]> {
  readonly item: Schema<T>
  readonly opts: ArrayOpts
  constructor(item: Schema<T>, opts?: ArrayOpts) {
    super()
    this.item = item
    this.opts = opts ?? {}
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): T[] {
    if (!Array.isArray(value)) {
      issues.push({ path: [...path], message: `应为数组，实际是 ${typeName(value)}`, code: 'invalid_type' })
      return []
    }
    if (this.opts.min !== undefined && value.length < this.opts.min) {
      issues.push({ path: [...path], message: `数组至少 ${this.opts.min} 项，实际 ${value.length}`, code: 'too_small' })
    }
    if (this.opts.max !== undefined && value.length > this.opts.max) {
      issues.push({ path: [...path], message: `数组最多 ${this.opts.max} 项，实际 ${value.length}`, code: 'too_big' })
    }
    const out: T[] = []
    for (let i = 0; i < value.length; i++) out.push(this.item._parse(value[i], [...path, i], issues))
    return out
  }

  min(n: number): ArraySchema<T> {
    return new ArraySchema(this.item, { ...this.opts, min: n })
  }
  max(n: number): ArraySchema<T> {
    return new ArraySchema(this.item, { ...this.opts, max: n })
  }
  /** 固定长度 */
  length(n: number): ArraySchema<T> {
    return new ArraySchema(this.item, { ...this.opts, min: n, max: n })
  }
}

/** 对象形状：字段 → schema。可选字段用 `v.optional(...)` 表达。 */
export type Shape = Record<string, Schema<never> | Schema<unknown>>

type InferShape<S extends Shape> = {
  [K in keyof S]: S[K] extends Schema<infer T> ? T : never
}

class ObjectSchema<S extends Shape> extends Schema<InferShape<S>> {
  readonly shape: S
  readonly opts: ObjectOpts
  constructor(shape: S, opts?: ObjectOpts) {
    super()
    this.shape = shape
    this.opts = opts ?? {}
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): InferShape<S> {
    if (!isPlainObject(value)) {
      issues.push({ path: [...path], message: `应为对象，实际是 ${typeName(value)}`, code: 'invalid_type' })
      return {} as InferShape<S>
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(this.shape)) {
      // 缺字段交给字段 schema 判定（optional → undefined 通过）
      out[key] = this.shape[key]._parse(value[key], [...path, key], issues)
    }
    const extra = Object.keys(value).filter((k) => !(k in this.shape))
    if (extra.length > 0) {
      if (this.opts.unknownKeys === 'strict') {
        issues.push({ path: [...path], message: `存在未声明字段：${extra.join(', ')}`, code: 'unrecognized_keys' })
      } else if (this.opts.unknownKeys === 'passthrough') {
        for (const k of extra) out[k] = value[k]
      }
      // 'strip'（默认）：未声明字段被静默剔除（与 zod 一致，也是 IPC 防篡改的第一道）
    }
    return out as InferShape<S>
  }

  /** 全部字段可省略（对应 TS 的 `Partial<T>`；docs/20 §4.2 的 patch 载荷） */
  partial(): ObjectSchema<{ [K in keyof S]: Schema<Infer<S[K]> | undefined> }> {
    const next: Record<string, Schema<unknown>> = {}
    for (const [k, val] of Object.entries(this.shape)) next[k] = val.optional()
    return new ObjectSchema(next as { [K in keyof S]: Schema<Infer<S[K]> | undefined> }, this.opts)
  }

  /** 允许未声明字段原样通过（转发型载荷，如 `options: Record<string, unknown>`） */
  passthrough(): ObjectSchema<S> {
    return new ObjectSchema(this.shape, { ...this.opts, unknownKeys: 'passthrough' })
  }

  /** 拒绝未声明字段（严格模式） */
  strict(): ObjectSchema<S> {
    return new ObjectSchema(this.shape, { ...this.opts, unknownKeys: 'strict' })
  }
}

class UnionSchema<T> extends Schema<T> {
  readonly options: ReadonlyArray<Schema<T>>
  constructor(options: ReadonlyArray<Schema<T>>) {
    super()
    this.options = options
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): T {
    const collected: ValidationIssue[] = []
    for (const option of this.options) {
      const local: ValidationIssue[] = []
      const out = option._parse(value, path, local)
      if (local.length === 0) return out
      collected.push(...local)
    }
    issues.push({
      path: [...path],
      // 只报前 3 个候选的原因，避免错误信息过载
      message: `不匹配任何候选类型（${collected.slice(0, 3).map((i) => i.message).join('；')}）`,
      code: 'invalid_union',
    })
    return undefined as T
  }
}

class UnknownSchema extends Schema<unknown> {
  override _parse(value: unknown): unknown {
    return value
  }
}

/** `void`：无载荷通道（`NoReq`）。只接受 `undefined`（Electron 不传参即 undefined）。 */
class VoidSchema extends Schema<void> {
  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): void {
    if (value !== undefined) {
      issues.push({ path: [...path], message: `该通道无载荷，实际收到 ${typeName(value)}`, code: 'invalid_type' })
    }
    return undefined
  }
}

class OptionalSchema<T> extends Schema<T | undefined> {
  readonly inner: Schema<T>
  constructor(inner: Schema<T>) {
    super()
    this.inner = inner
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): T | undefined {
    if (value === undefined) return undefined
    return this.inner._parse(value, path, issues)
  }
}

class NullableSchema<T> extends Schema<T | null> {
  readonly inner: Schema<T>
  constructor(inner: Schema<T>) {
    super()
    this.inner = inner
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): T | null {
    if (value === null) return null
    return this.inner._parse(value, path, issues)
  }
}

class DefaultSchema<T> extends Schema<T> {
  readonly inner: Schema<T>
  readonly fallback: T
  constructor(inner: Schema<T>, fallback: T) {
    super()
    this.inner = inner
    this.fallback = fallback
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): T {
    if (value === undefined) return this.fallback
    return this.inner._parse(value, path, issues)
  }
}

/** `Record<string, V>`（如 footPedalMapping、options） */
class RecordSchema<V> extends Schema<Record<string, V>> {
  readonly valueSchema: Schema<V>
  constructor(valueSchema: Schema<V>) {
    super()
    this.valueSchema = valueSchema
  }

  override _parse(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): Record<string, V> {
    if (!isPlainObject(value)) {
      issues.push({ path: [...path], message: `应为键值对象，实际是 ${typeName(value)}`, code: 'invalid_type' })
      return {}
    }
    const out: Record<string, V> = {}
    for (const [k, val] of Object.entries(value)) out[k] = this.valueSchema._parse(val, [...path, k], issues)
    return out
  }
}

// ---------------------------------------------------------------------------
// 工厂（与 zod 的 `z.*` 对应：`v.*`）
// ---------------------------------------------------------------------------

export interface Validator {
  string: (opts?: StringOpts) => StringSchema
  number: (opts?: NumberOpts) => NumberSchema
  boolean: () => BooleanSchema
  literal: <T extends string | number | boolean | null>(value: T) => LiteralSchema<T>
  array: <T>(item: Schema<T>, opts?: ArrayOpts) => ArraySchema<T>
  object: <S extends Shape>(shape: S, opts?: ObjectOpts) => ObjectSchema<S>
  union: <T>(options: ReadonlyArray<Schema<T>>) => UnionSchema<T>
  /** 字面量联合的语法糖：`v.enum(['a','b'])` */
  enum: (values: readonly string[]) => UnionSchema<string>
  unknown: () => UnknownSchema
  /** 无载荷通道（`NoReq`） */
  void: () => VoidSchema
  record: <V>(valueSchema: Schema<V>) => RecordSchema<V>
  optional: <T>(inner: Schema<T>) => OptionalSchema<T>
  nullable: <T>(inner: Schema<T>) => NullableSchema<T>
  /** `union` 的别名（读起来更顺） */
  oneOf: <T>(options: ReadonlyArray<Schema<T>>) => UnionSchema<T>
}

export const v: Validator = {
  string: (opts) => new StringSchema(opts),
  number: (opts) => new NumberSchema(opts),
  boolean: () => new BooleanSchema(),
  literal: (value) => new LiteralSchema(value),
  array: (item, opts) => new ArraySchema(item, opts),
  object: (shape, opts) => new ObjectSchema(shape, opts),
  union: (options) => new UnionSchema(options),
  enum: (values) => new UnionSchema(values.map((value) => new LiteralSchema(value))) as UnionSchema<string>,
  unknown: () => new UnknownSchema(),
  void: () => new VoidSchema(),
  record: (valueSchema) => new RecordSchema(valueSchema),
  optional: (inner) => new OptionalSchema(inner),
  nullable: (inner) => new NullableSchema(inner),
  oneOf: (options) => new UnionSchema(options),
}
