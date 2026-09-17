/**
 * Novel Studio · Prompt 模板与渲染测试（docs/06 §6.1 / §6.2 / §6.3 / §6.4）
 * ============================================================================
 * 运行：
 *   node --experimental-strip-types tests/shared/ai-prompts.test.ts
 *
 * 本文件守护：
 *   · `{{var}}` 插值与 `{{#each}}` 循环（含 `{{index}}` / `{{this}}` / 点路径）
 *   · 模板带**版本号**（docs/06 §6.1：调用要记录 prompt_id + version 才能回溯）
 *   · 渲染结果**包含角色列表**与**输出格式说明**（提示层的第一层防护）
 *   · 缺失变量渲染成空串且可被 onMissing 捕获（不让 prompt 少一个变量就炸任务）
 *   · 情绪列表来自 constants.EMOTIONS（与全应用同一份白名单）
 *   · 未实现的 purpose 明确抛 NOT_IMPLEMENTED，而不是返回空模板
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { isAppError } from '../../src/shared/errors.ts'
import { EMOTIONS } from '../../src/shared/constants.ts'
import {
  ATTRIBUTION_REVIEW_SHAPE,
  ATTRIBUTION_REVIEW_TEMPLATE,
  EMOTION_TAG_SHAPE,
  EMOTION_TAG_TEMPLATE,
  PROMPT_TEMPLATES,
  buildAttributionReviewMessages,
  buildEmotionTagMessages,
  getPromptTemplate,
  getStructuredSchema,
  listPromptVersions,
  previewUserPrompt,
} from '../../src/shared/ai/prompts/templates.ts'
import { lookup, renderPrompt, renderMessages } from '../../src/shared/ai/prompts/render.ts'

const CHARACTERS = [
  { name: '萧炎', aliases: '炎帝、三少爷', desc: '少年，语气倔强' },
  { name: '药老', aliases: '药尘', desc: '苍老，语速偏慢' },
]

const CONTEXT = [
  { index: 1, text: '他缓缓抬起头。' },
  { index: 2, text: '眼中闪过一丝狠厉。' },
]

// ---------------------------------------------------------------------------
// 渲染引擎
// ---------------------------------------------------------------------------

describe('renderPrompt · 插值与循环', () => {
  it('{{var}} 插值（含数字与布尔）', () => {
    assert.equal(renderPrompt('行号：{{lineIndex}} 置信度 {{c}} 启用 {{on}}', { lineIndex: 12, c: 0.5, on: true }), '行号：12 置信度 0.5 启用 true')
  })

  it('支持点路径 {{a.b.c}}', () => {
    assert.equal(renderPrompt('{{project.name}}', { project: { name: '斗破苍穹' } }), '斗破苍穹')
    assert.equal(lookup('project.name', [{ project: { name: 'x' } }]), 'x')
  })

  it('{{#each}} 渲染列表，{{index}} 从 1 开始、{{index0}} 从 0 开始', () => {
    const out = renderPrompt('{{#each items}}{{index}}/{{index0}}:{{text}};{{/each}}', {
      items: [{ text: 'A' }, { text: 'B' }],
    })
    assert.equal(out, '1/0:A;2/1:B;')
  })

  it('循环内的 {{this}} 支持字符串数组', () => {
    assert.equal(renderPrompt('{{#each list}}[{{this}}]{{/each}}', { list: ['a', 'b'] }), '[a][b]')
  })

  it('循环内可用外层变量（作用域回退）', () => {
    assert.equal(
      renderPrompt('{{#each items}}{{prefix}}{{name}} {{/each}}', {
        prefix: '>',
        items: [{ name: 'A' }, { name: 'B' }],
      }),
      '>A >B ',
    )
  })

  it('空数组 / 缺失数组渲染为空串，不抛错', () => {
    assert.equal(renderPrompt('前{{#each items}}x{{/each}}后', { items: [] }), '前后')
    assert.equal(renderPrompt('前{{#each nope}}x{{/each}}后', {}), '前后')
  })

  it('{{#if}} 简单条件', () => {
    assert.equal(renderPrompt('{{#if has}}有{{/if}}', { has: true }), '有')
    assert.equal(renderPrompt('{{#if has}}有{{/if}}', { has: '' }), '')
    assert.equal(renderPrompt('{{#if list}}N={{list}} {{/if}}', { list: ['a'] }), 'N=a ')
  })

  it('缺失变量渲染成空串，并通过 onMissing 上报（不抛错）', () => {
    const missing: string[] = []
    const out = renderPrompt('A{{nope}}B', {}, { onMissing: (n) => missing.push(n) })
    assert.equal(out, 'AB')
    assert.deepEqual(missing, ['nope'])
    assert.equal(renderPrompt('A{{nope}}B', {}, { missingPlaceholder: '-' }), 'A-B')
  })

  it('未闭合的块标记原样保留（便于立刻发现模板写错）', () => {
    assert.equal(renderPrompt('{{#each items}}x', { items: ['a'] }), '{{#each items}}x')
  })

  it('renderMessages 产出 system + [少样本] + user', () => {
    const msgs = renderMessages(
      { system: 'S', userTemplate: 'U{{v}}', examples: [{ input: 'EX-IN', output: 'EX-OUT' }] },
      { v: '1' },
    )
    assert.deepEqual(
      msgs.map((m) => `${m.role}:${m.content}`),
      ['system:S', 'user:EX-IN', 'assistant:EX-OUT', 'user:U1'],
    )
    assert.equal(renderMessages({ system: 'S', userTemplate: 'U' }, {}, { includeExamples: false }).length, 2)
  })
})

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

describe('Prompt 模板 · attribution_review / emotion_tag', () => {
  it('两个模板都有 id / version / purpose（docs/06 §6.1）', () => {
    for (const t of Object.values(PROMPT_TEMPLATES)) {
      assert.ok(t.id.length > 0)
      assert.equal(Number.isInteger(t.version), true)
      assert.ok(t.version >= 1, `${t.id} 的版本号必须 ≥ 1`)
      assert.equal(t.purpose, t.id)
      assert.ok(t.system.length > 0)
      assert.ok(t.userTemplate.includes('{{'), `${t.id} 的 userTemplate 应含占位符`)
      assert.equal(typeof t.outputSchema, 'object')
    }
    const versions = listPromptVersions()
    assert.equal(versions.length, 2)
    assert.deepEqual(versions.map((v) => v.id).sort(), ['attribution_review', 'emotion_tag'])
  })

  it('attribution_review：渲染结果包含完整角色列表（含别名与性格）', () => {
    const messages = buildAttributionReviewMessages({
      characters: CHARACTERS,
      context: CONTEXT,
      lineIndex: 12,
      text: '我萧炎，从来不会认输。',
      lineId: 'L-12',
    })
    const user = messages[messages.length - 1].content

    assert.match(user, /## 角色列表/)
    assert.match(user, /萧炎（别名：炎帝、三少爷）；性格：少年，语气倔强/)
    assert.match(user, /药老（别名：药尘）；性格：苍老，语速偏慢/)
    assert.match(user, /## 上下文/)
    assert.match(user, /1\. 他缓缓抬起头。/)
    assert.match(user, /2\. 眼中闪过一丝狠厉。/)
    assert.match(user, /行号：12/)
    assert.match(user, /内容：我萧炎，从来不会认输。/)
  })

  it('attribution_review：渲染结果包含输出格式说明与 lineId 回填要求', () => {
    const user = previewUserPrompt('attribution_review', {
      characters: CHARACTERS,
      context: CONTEXT,
      lineIndex: 12,
      text: 'x',
      lineId: 'L-12',
    })
    assert.match(user, /## 输出格式/)
    assert.match(user, /\{"lineId":"L-12","speaker":"角色名或 narration","confidence":0\.0,"reason":"不超过20字"\}/)
  })

  it('attribution_review：system 要求「只输出 JSON」且不许编造角色', () => {
    assert.match(ATTRIBUTION_REVIEW_TEMPLATE.system, /只输出 JSON/)
    assert.match(ATTRIBUTION_REVIEW_TEMPLATE.system, /不要编造角色/)
  })

  it('emotion_tag：渲染结果包含可选情绪白名单与句子列表', () => {
    const messages = buildEmotionTagMessages({
      lines: [
        { lineId: 'L1', text: '我萧炎，从来不会认输。' },
        { lineId: 'L2', text: '他缓缓抬起头。' },
      ],
    })
    const user = messages[messages.length - 1].content

    assert.match(user, /## 可选情绪/)
    for (const e of EMOTIONS) assert.ok(user.includes(e), `可选情绪里缺少「${e}」`)
    assert.match(user, /1\. \[lineId=L1\] 我萧炎，从来不会认输。/)
    assert.match(user, /2\. \[lineId=L2\] 他缓缓抬起头。/)
    assert.match(user, /## 输出格式/)
    assert.match(user, /\[{"lineId":"xxx","emotion":"决绝","intensity":4,"speed":"fast","reason":"\.\.\."\}/)
    assert.match(EMOTION_TAG_TEMPLATE.system, /必须只输出 JSON 数组/)
  })

  it('emotion_tag 的情绪白名单可被覆盖（自定义情绪集）', () => {
    const messages = buildEmotionTagMessages({ lines: [{ lineId: 'L1', text: 'x' }], emotions: ['平静', '愤怒'] })
    const user = messages[messages.length - 1].content
    assert.match(user, /平静, 愤怒/)
    assert.ok(!user.includes('厌恶'))
  })

  it('模板携带少样本示例（提升格式服从度）', () => {
    assert.ok((ATTRIBUTION_REVIEW_TEMPLATE.examples?.length ?? 0) >= 1)
    assert.ok((EMOTION_TAG_TEMPLATE.examples?.length ?? 0) >= 1)
    const messages = buildAttributionReviewMessages({
      characters: CHARACTERS,
      context: CONTEXT,
      lineIndex: 1,
      text: 't',
      lineId: 'L1',
    })
    assert.equal(messages.some((m) => m.role === 'assistant'), true)
  })

  it('缺失变量不影响渲染（角色为空时角色列表为空，但其余部分仍在）', () => {
    const user = previewUserPrompt('attribution_review', {
      characters: [],
      context: [],
      lineIndex: 3,
      text: '台词',
      lineId: 'L3',
    })
    assert.match(user, /## 角色列表/)
    assert.match(user, /行号：3/)
    assert.match(user, /## 输出格式/)
  })

  it('getPromptTemplate：未实现的 purpose 抛 NOT_IMPLEMENTED（不返回空模板）', () => {
    assert.equal(getPromptTemplate('attribution_review').id, 'attribution_review')
    assert.throws(
      () => getPromptTemplate('canvas_struct'),
      (e: unknown) => isAppError(e) && e.key === 'NOT_IMPLEMENTED',
    )
    assert.throws(
      () => getStructuredSchema('character_extract'),
      (e: unknown) => isAppError(e) && e.key === 'NOT_IMPLEMENTED',
    )
  })
})

// ---------------------------------------------------------------------------
// 模板 ↔ 结构化 schema 的一致性
// ---------------------------------------------------------------------------

describe('模板与 schema 一致性', () => {
  it('attribution_review 的 schema 自动识别 lineId 为 ID 字段（防幻觉）', () => {
    const schema = getStructuredSchema('attribution_review')
    assert.deepEqual(schema.idFields, ['lineId'])
    assert.equal(ATTRIBUTION_REVIEW_SHAPE.confidence.type, 'number')
    assert.equal(Object.keys(schema.jsonSchema.properties ?? {}).length, 4)
  })

  it('emotion_tag 的 schema 是数组根，情绪枚举与 constants.EMOTIONS 完全一致', () => {
    const schema = getStructuredSchema('emotion_tag')
    assert.equal(schema.jsonSchema.type, 'array')
    assert.deepEqual(schema.idFields, ['lineId'])
    const emotionSchema = (schema.jsonSchema.items?.properties ?? {}).emotion as { enum?: readonly string[] }
    assert.deepEqual([...(emotionSchema.enum ?? [])], [...EMOTIONS])
    assert.deepEqual([...(EMOTION_TAG_SHAPE.emotion.enum ?? [])], [...EMOTIONS])
  })

  it('schema 能校验模板给出的示例输出（示例本身必须是合法的）', () => {
    for (const t of Object.values(PROMPT_TEMPLATES)) {
      const schema = getStructuredSchema(t.purpose as 'attribution_review' | 'emotion_tag')
      for (const ex of t.examples ?? []) {
        const parsed = JSON.parse(ex.output) as unknown
        const validated = schema.validate(parsed)
        assert.equal(validated.ok, true, `${t.id} 的示例输出未通过自己的 schema 校验`)
      }
    }
  })

  it('输出格式说明里出现的字段名与 schema 完全对齐', () => {
    const attribFields = Object.keys(getStructuredSchema('attribution_review').jsonSchema.properties ?? {})
    const userText = previewUserPrompt('attribution_review', {
      characters: [],
      context: [],
      lineIndex: 1,
      text: 't',
      lineId: 'L1',
    })
    for (const f of attribFields) {
      assert.ok(
        userText.includes(`"${f}"`),
        `输出格式说明里缺少 schema 字段 ${f}（提示层与 schema 脱节会让模型自由发挥）`,
      )
    }
  })
})
