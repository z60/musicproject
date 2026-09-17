/**
 * 测试 · 内置校验器（src/main/infra/validate）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §1.2「运行时校验」、§5.1「INVALID_PAYLOAD 的 details.issues」
 *
 * 覆盖点：
 *   · 各原语的成功/失败路径，且**失败信息带字段路径**（供 UI/日志定位）
 *   · 嵌套对象、可选字段、`Partial<T>` 语义（.partial()）
 *   · 联合字面量（scope: 'low_confidence'|'all'|'selection'）
 *   · 数组（含元素级路径 `items[1].id`）
 *   · `v.void()`：无载荷通道只接受 undefined
 *   · 契约覆盖：`IPC_CHANNELS` 中每个通道都能取到 schema
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { IPC_CHANNELS } from '../../src/shared/ipc.ts'
import { IPC_REQ_SCHEMAS, schemaChannels, schemaFor } from '../../src/main/ipc/schemas.ts'
import { SchemaError, extractIssues, formatPath, v, type Infer } from '../../src/main/infra/validate/index.ts'

/** 捕获异常（node:assert 的 assert.throws 不返回错误对象，需要断言 issues 时要自己抓） */
function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('期望抛错，但没有抛')
}

describe('原语 · 字符串', () => {
  it('接受正常字符串并拒绝非字符串', () => {
    const s = v.string()
    assert.equal(s.parse('hello'), 'hello')
    assert.throws(() => s.parse(42), /应为字符串，实际是 number/)
    assert.throws(() => s.parse(null), /应为字符串，实际是 null/)
  })

  it('默认拒绝空串，allowEmpty 可放开', () => {
    assert.throws(() => v.string().parse(''), /不能为空字符串/)
    assert.equal(v.string().allowEmpty().parse(''), '')
  })

  it('min / max / regex 约束', () => {
    assert.equal(v.string({ min: 2, max: 5 }).parse('abc'), 'abc')
    assert.throws(() => v.string({ min: 4 }).parse('abc'), /长度至少 4/)
    assert.throws(() => v.string({ max: 2 }).parse('abc'), /长度最多 2/)
    assert.equal(v.string().regex(/^[a-f0-9]+$/).parse('abc123'), 'abc123')
    assert.throws(() => v.string().regex(/^[a-f0-9]+$/).parse('XYZ'), /不符合格式/)
  })
})

describe('原语 · 数字与布尔', () => {
  it('数字：类型、整数、范围、NaN/Infinity', () => {
    assert.equal(v.number().parse(1.5), 1.5)
    assert.throws(() => v.number().parse('1'), /应为数字/)
    assert.throws(() => v.number().int().parse(1.5), /应为整数/)
    assert.throws(() => v.number({ min: 0 }).parse(-1), /不能小于 0/)
    assert.throws(() => v.number({ max: 10 }).parse(11), /不能大于 10/)
    assert.throws(() => v.number().parse(Number.NaN), /有穷数字/)
    assert.throws(() => v.number().parse(Number.POSITIVE_INFINITY), /有穷数字/)
  })

  it('布尔：只接受真正的布尔', () => {
    assert.equal(v.boolean().parse(false), false)
    assert.throws(() => v.boolean().parse(0), /应为布尔值，实际是 number/)
    assert.throws(() => v.boolean().parse('true'), /应为布尔值，实际是 string/)
  })
})

describe('原语 · 字面量与联合', () => {
  it('字面量严格相等（不做类型强转）', () => {
    assert.equal(v.literal('punch_in').parse('punch_in'), 'punch_in')
    assert.throws(() => v.literal(1).parse('1'), /应为 1，实际 "1"/)
  })

  it('联合：命中任一候选即通过；全不命中时报出原因', () => {
    const scope = v.union([v.literal('low_confidence'), v.literal('all'), v.literal('selection')])
    assert.equal(scope.parse('all'), 'all')
    const err = capture(() => scope.parse('bogus')) as SchemaError
    assert.match(err.message, /不匹配任何候选类型/)
    assert.equal(err.issues[0]?.code, 'invalid_union')
    assert.equal(err.issues[0]?.path.length, 0)
  })

  it('enum 是字面量联合的语法糖', () => {
    const theme = v.enum(['light', 'dark', 'system'])
    assert.equal(theme.parse('dark'), 'dark')
    assert.throws(() => theme.parse('blue'), /不匹配任何候选类型/)
  })
})

describe('对象 · 嵌套 / 可选 / Partial / 未知字段', () => {
  const schema = v.object({
    chapterId: v.string(),
    offset: v.optional(v.number().int()),
    filter: v.optional(
      v.object({
        needsReview: v.optional(v.boolean()),
        speakerType: v.optional(v.union([v.literal('narration'), v.literal('character')])),
      }),
    ),
  })

  it('通过正常载荷并保留可选字段', () => {
    assert.deepEqual(schema.parse({ chapterId: 'c1' }), { chapterId: 'c1', offset: undefined, filter: undefined })
    const parsed = schema.parse({ chapterId: 'c1', offset: 10, filter: { needsReview: true, speakerType: 'character' } })
    assert.equal(parsed.offset, 10)
    assert.equal(parsed.filter?.speakerType, 'character')
  })

  it('未声明字段被剔除（IPC 防篡改的第一道）', () => {
    const parsed = schema.parse({ chapterId: 'c1', injected: 'evil', __proto__x: 1 })
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'injected'), false)
  })

  it('嵌套字段的错误路径是点分路径', () => {
    const err = capture(() => schema.parse({ chapterId: 'c1', filter: { needsReview: 'yes' } })) as SchemaError
    assert.equal(err.issues[0]?.path.join('.'), 'filter.needsReview')
    assert.match(err.message, /filter\.needsReview/)
  })

  it('嵌套对象本身的类型错误也带路径', () => {
    const err = capture(() => schema.parse({ chapterId: 'c1', filter: 'x' })) as SchemaError
    assert.equal(err.issues[0]?.path.join('.'), 'filter')
    assert.equal(err.issues[0]?.code, 'invalid_type')
  })

  it('partial() 让全部字段可省略（对应 TS 的 Partial<T>）', () => {
    const patch = v.object({ title: v.string(), author: v.string() }).partial()
    assert.deepEqual(patch.parse({}), { title: undefined, author: undefined })
    assert.equal(patch.parse({ title: '斗破苍穹' }).title, '斗破苍穹')
    assert.throws(() => patch.parse({ title: 42 }), /title/)
  })

  it('strict() 拒绝未声明字段，passthrough() 原样保留', () => {
    assert.throws(() => v.object({ a: v.string() }).strict().parse({ a: 'x', b: 1 }), /未声明字段：b/)
    const kept = v.object({}).passthrough().parse({ anything: 1, nested: { x: 2 } })
    assert.deepEqual(kept, { anything: 1, nested: { x: 2 } })
  })

  it('非对象输入被拒绝（数组 / null / 字符串）', () => {
    assert.throws(() => schema.parse([]), /应为对象，实际是 array/)
    assert.throws(() => schema.parse(null), /应为对象，实际是 null/)
    assert.throws(() => schema.parse('x'), /应为对象，实际是 string/)
  })
})

describe('数组 · 元素路径与长度约束', () => {
  const schema = v.object({
    items: v.array(v.object({ id: v.string(), qty: v.number({ int: true }) }), { max: 3 }),
  })

  it('元素级错误路径形如 items[1].qty', () => {
    const err = capture(() =>
      schema.parse({ items: [{ id: 'a', qty: 1 }, { id: 'b', qty: 1.5 }] }),
    ) as SchemaError
    assert.deepEqual(err.issues[0]?.path, ['items', 1, 'qty'])
    assert.equal(formatPath(err.issues[0]!.path), 'items[1].qty')
    assert.equal(err.issues[0]?.path.join('.'), 'items.1.qty')
  })

  it('数组长度上限与类型校验', () => {
    assert.throws(() => schema.parse({ items: [1, 2, 3, 4].map((n) => ({ id: String(n), qty: n })) }), /数组最多 3 项/)
    assert.throws(() => schema.parse({ items: 'x' }), /应为数组，实际是 string/)
  })

  it('array().length(n) 固定长度', () => {
    assert.deepEqual(v.array(v.number(), {}).length(2).parse([1, 2]), [1, 2])
    assert.throws(() => v.array(v.number()).length(2).parse([1]), /数组至少 2 项/)
  })
})

describe('optional / nullable / default / void / unknown / record', () => {
  it('optional 接受 undefined 但拒绝 null', () => {
    const s = v.optional(v.string())
    assert.equal(s.parse(undefined), undefined)
    assert.throws(() => s.parse(null), /应为字符串，实际是 null/)
  })

  it('nullable 接受 null；与 optional 组合可表达 `T | null | undefined`', () => {
    const s = v.optional(v.nullable(v.string()))
    assert.equal(s.parse(null), null)
    assert.equal(s.parse(undefined), undefined)
    assert.equal(s.parse('x'), 'x')
  })

  it('default 在 undefined 时给默认值', () => {
    assert.equal(v.number().default(50).parse(undefined), 50)
    assert.equal(v.number().default(50).parse(7), 7)
  })

  it('void 只接受 undefined（无载荷通道 NoReq）', () => {
    const s = v.void()
    assert.equal(s.parse(undefined), undefined)
    assert.throws(() => s.parse({}), /该通道无载荷，实际收到 object/)
    assert.throws(() => s.parse(null), /该通道无载荷，实际收到 null/)
  })

  it('unknown 原样通过；record 校验每个值', () => {
    assert.deepEqual(v.unknown().parse({ a: 1 }), { a: 1 })
    const r = v.record(v.string())
    assert.deepEqual(r.parse({ F13: 'stop_and_next' }), { F13: 'stop_and_next' })
    assert.throws(() => r.parse({ F13: 1 }), /F13/)
  })
})

describe('safeParse 与 issues 提取', () => {
  it('safeParse 返回结构化结果，不抛错', () => {
    const ok = v.object({ a: v.string() }).safeParse({ a: 'x' })
    assert.equal(ok.success, true)
    const bad = v.object({ a: v.string() }).safeParse({ a: 1 })
    assert.equal(bad.success, false)
    if (!bad.success) assert.equal(bad.error.issues.length, 1)
  })

  it('extractIssues 把路径拼成点分字符串（供 INVALID_PAYLOAD 的 details）', () => {
    let caught: unknown
    try {
      v.object({ filter: v.object({ needsReview: v.boolean() }) }).parse({ filter: { needsReview: 1 } })
    } catch (e) {
      caught = e
    }
    const issues = extractIssues(caught)
    assert.deepEqual(issues, [{ path: 'filter.needsReview', message: '应为布尔值，实际是 number' }])
  })

  it('extractIssues 对非校验错误返回空数组（不抛错）', () => {
    assert.deepEqual(extractIssues(new Error('boom')), [])
    assert.deepEqual(extractIssues(undefined), [])
  })
})

describe('类型推断（Infer）与 zod 形态兼容', () => {
  it('Infer 能取出解析后的类型（编译期约定，运行期验证取值）', () => {
    const s = v.object({ id: v.string(), n: v.number() })
    type T = Infer<typeof s>
    const value: T = s.parse({ id: 'a', n: 1 })
    assert.equal(value.id, 'a')
  })

  it('错误对象形态与 ZodError 一致（issues 数组，元素含 path/message/code）', () => {
    let caught: unknown
    try {
      v.string().parse(1)
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof SchemaError)
    const issues = (caught as SchemaError).issues
    assert.ok(Array.isArray(issues))
    assert.ok(Array.isArray(issues[0]?.path))
    assert.equal(typeof issues[0]?.message, 'string')
    assert.equal(typeof issues[0]?.code, 'string')
  })
})

describe('契约覆盖：每个 IPC 通道都有可用的 req schema', () => {
  it('IPC_CHANNELS 与 IPC_REQ_SCHEMAS 的键集合完全一致', () => {
    const fromSchemas = schemaChannels()
    assert.deepEqual(fromSchemas, [...IPC_CHANNELS].sort())
    assert.equal(fromSchemas.length, 158, '契约通道数变化时必须同步更新本断言')
  })

  it('每个通道都能取到 schema 且不是 undefined', () => {
    for (const channel of IPC_CHANNELS) {
      assert.ok(schemaFor(channel), `${channel} 缺少 req schema`)
    }
    assert.equal(schemaFor('不存在的通道'), undefined)
  })

  it('嵌套 + 可选 + 联合字面量 + 数组 能被同一张表表达（抽查 4 个真实通道）', () => {
    // 嵌套对象 + 可选 + 联合字面量
    assert.deepEqual(
      IPC_REQ_SCHEMAS['canvas:recomputeAttribution'].parse({ chapterId: 'c', scope: 'low_confidence' }),
      { chapterId: 'c', scope: 'low_confidence', lineIds: undefined },
    )
    // 数组 + 嵌套对象 + 可选
    const dialog = IPC_REQ_SCHEMAS['app:openFileDialog'].parse({
      title: '选择文本',
      filters: [{ name: '文本', extensions: ['txt'] }],
    })
    assert.equal(dialog.filters?.[0]?.extensions[0], 'txt')
    // Partial 语义（book:update 的 patch 全可选：允许空对象，字段值为 undefined）
    const bookPatch = IPC_REQ_SCHEMAS['book:update'].parse({ bookId: 'b', patch: {} }).patch ?? {}
    assert.deepEqual(Object.keys(bookPatch).sort(), ['author', 'coverPath', 'language', 'narrator', 'title'])
    assert.equal(bookPatch.title, undefined)
    // void 通道
    assert.equal(IPC_REQ_SCHEMAS['task:clearFinished'].parse(undefined), undefined)
    assert.throws(() => IPC_REQ_SCHEMAS['task:clearFinished'].parse({}), /无载荷/)
  })

  it('非法载荷在契约 schema 层就被挡住（以 task:list 的 status 闭集为例）', () => {
    assert.throws(() => IPC_REQ_SCHEMAS['task:list'].parse({ status: ['nope'] }), /不匹配任何候选类型/)
    const ok = IPC_REQ_SCHEMAS['task:list'].parse({ status: ['running'], limit: 10 })
    assert.deepEqual(ok.status, ['running'])
  })
})
