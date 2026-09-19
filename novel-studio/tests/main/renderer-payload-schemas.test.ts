/**
 * 测试 · 「渲染侧真的会发的载荷」必须能通过契约校验
 * ============================================================================
 * 设计依据：docs/20 §1.2（校验器）、docs/91 §5.2.11（真机堵点复盘）
 *
 * ### 为什么需要这组测试（而不是只测 handler）
 *   handler 测试是我**按 schema 的形状**写的载荷 —— 它证明「形状对的时候能跑通」，
 *   但证明不了「渲染侧发的东西形状对」。这两件事之间的缝隙很宽：
 *
 *   · 界面上「清空一个可空字段」发的就是 `null`：
 *     `CharacterPanel.vue` 写的是 `description: form.description || null`，
 *     `LineEditorDrawer.vue` 写的是 `{ note: null }`，`CanvasTable.vue` 的
 *     `setEmotion` 发 `{ emotion: null }`。
 *   · 而 schema 里若把可空字段写成 `v.optional(v.string())`，`null` 会被拒收 →
 *     `INVALID_PAYLOAD`。**用户看到的是「参数不对」，真正原因是他清空了一个备注。**
 *   · 更狠的一例：新建角色时描述通常是空的 → `description: null` →
 *     若该字段不可空，**「新建角色」这个功能整个用不了**（本轮真机堵点）。
 *
 *   所以这里把渲染侧**真实的构造代码**抄成载荷样本（每例注明来源文件），
 *   逐条过 `IPC_REQ_SCHEMAS`。规则：**领域类型可空 ⇒ schema 必须可空**。
 */

import { strict as assert } from 'assert'
import { describe, it } from 'node:test'

import { schemaFor } from '../../src/main/ipc/schemas.ts'

interface Sample {
  /** 用例名（含来源，便于回溯到渲染侧代码） */
  name: string
  channel: string
  payload: unknown
}

/**
 * 样本全部来自渲染侧的**真实构造**（不是想象出来的形状）。
 * 新增界面动作时，把它的载荷抄到这里一份 —— 这是最便宜的真机防线。
 */
const SAMPLES: Sample[] = [
  {
    // CharacterPanel.vue 的 saveCharacter：描述/备注/配色空着就是 null
    name: 'CharacterPanel.vue · 新建角色（描述为空 → null）',
    channel: 'character:upsert',
    payload: {
      character: {
        bookId: 'b1',
        name: '甲',
        aliases: [],
        gender: null,
        ageGroup: null,
        description: null,
        note: null,
        color: null,
        defaultSpeed: null,
        defaultEmotion: null,
        defaultGainDb: null,
        defaultPauseMs: null,
      },
    },
  },
  {
    // CharacterPanel.vue 的编辑分支：带了 id，且只改了名字（其余字段照样发 null）
    name: 'CharacterPanel.vue · 编辑角色（只改名字）',
    channel: 'character:upsert',
    payload: {
      character: { id: 'ch1', bookId: 'b1', name: '乙', aliases: ['小乙'], description: null, color: '#409eff' },
    },
  },
  {
    // LineEditorDrawer.vue:108 `canvas.commitFields(line.id, { note: value.trim() ? value : null })`
    name: 'LineEditorDrawer.vue · 清空备注',
    channel: 'canvas:updateLine',
    payload: { lineId: 'l1', patch: { note: null } },
  },
  {
    // CanvasTable.vue / CanvasScriptView.vue 的 setEmotion（清空情绪）
    name: 'CanvasTable.vue · 清空情绪',
    channel: 'canvas:updateLine',
    payload: { lineId: 'l1', patch: { emotion: null, emotionIntensity: null } },
  },
  {
    // 画本行补丁里所有「可空字段」同时清空（一次改多列）
    name: '画本行补丁 · 可空字段全部清空',
    channel: 'canvas:updateLine',
    payload: {
      lineId: 'l1',
      patch: {
        characterId: null,
        emotion: null,
        emotionIntensity: null,
        speed: null,
        gainDb: null,
        pauseInline: null,
        pronunciation: null,
        note: null,
      },
    },
  },
  {
    // useSpeakerAssign.ts:167 指派为旁白
    name: 'useSpeakerAssign.ts · 指派旁白',
    channel: 'canvas:updateLine',
    payload: { lineId: 'l1', patch: { characterId: null, speakerType: 'narration', decidedBy: 'human', needsReview: true } },
  },
  {
    // canvas.store 的批量动作：lineIds + 同一个 patch
    name: 'canvas.store · 批量清空备注',
    channel: 'canvas:batchUpdate',
    payload: { lineIds: ['l1', 'l2'], patch: { note: null } },
  },
  {
    // characters.store.load / CanvasEditorView 的取行
    name: 'characters.store · 列角色（含归档）',
    channel: 'character:list',
    payload: { bookId: 'b1', includeArchived: true },
  },
  {
    name: 'canvas.store · 待确认队列（只给 filter，不带 limit）',
    channel: 'canvas:getChapter',
    payload: { chapterId: 'c1', filter: { needsReview: true } },
  },
  {
    name: 'canvas.store · 分页加载（带 offset/limit）',
    channel: 'canvas:getChapter',
    payload: { chapterId: 'c1', offset: 0, limit: 500 },
  },
  {
    name: 'canvas.store · 未分配筛选（characterId: null）',
    channel: 'canvas:getChapter',
    payload: { chapterId: 'c1', filter: { characterId: null } },
  },
  {
    name: 'character:merge · 合并（带 keepAliases）',
    channel: 'character:merge',
    payload: { targetId: 'ch1', sourceIds: ['ch2', 'ch3'], keepAliases: true },
  },
  {
    name: 'character:archive · 归档',
    channel: 'character:archive',
    payload: { characterId: 'ch1', archived: true },
  },
  {
    name: 'character:extract · 全书抽取',
    channel: 'character:extract',
    payload: { bookId: 'b1' },
  },
  {
    name: 'character:rebuildCentroid · 重建全部',
    channel: 'character:rebuildCentroid',
    payload: { bookId: 'b1' },
  },
  {
    name: 'voiceActor:upsert · 新增配音员（联系方式为空 → null）',
    channel: 'voiceActor:upsert',
    payload: { actor: { projectId: 'p1', name: '甲', contact: null, note: null, profile: null } },
  },
  {
    name: 'voiceActor:bind · 绑定为备选（isPrimary 省略）',
    channel: 'voiceActor:bind',
    payload: { characterId: 'ch1', actorId: 'va1' },
  },
  {
    name: 'voiceActor:bindings · 查绑定',
    channel: 'voiceActor:bindings',
    payload: { bookId: 'b1' },
  },
  {
    name: 'voiceActor:workload · 分工负载',
    channel: 'voiceActor:workload',
    payload: { bookId: 'b1' },
  },
  {
    // canvas.store.startGenerate
    name: 'canvas.store · 生成画本（options 全给）',
    channel: 'canvas:generate',
    payload: {
      chapterId: 'c1',
      options: {
        useEmbedding: true,
        useLlm: false,
        contextWindow: 2,
        threshold: 0.62,
        margin: 0.06,
        ruleSetId: null,
        overwriteHuman: false,
        inferTags: true,
      },
    },
  },
  {
    // canvas.store.recomputeAttribution（selection 时带 lineIds）
    name: 'canvas.store · 重算判定（selection）',
    channel: 'canvas:recomputeAttribution',
    payload: { chapterId: 'c1', scope: 'selection', lineIds: ['l1'] },
  },
  {
    name: 'CanvasEditorView.vue · 导出文本（不带 outPath）',
    channel: 'canvas:exportText',
    payload: { chapterId: 'c1', format: 'txt' },
  },
  {
    name: 'canvas.store · 打快照（reason 由界面给）',
    channel: 'canvas:snapshotCreate',
    payload: { chapterId: 'c1', label: '生成前', reason: 'manual' },
  },
]

describe('契约 schema · 必须接受渲染侧真实载荷', () => {
  it('每个样本都能通过对应通道的请求校验（可空字段要真的可空）', () => {
    const failures: string[] = []
    for (const s of SAMPLES) {
      const schema = schemaFor(s.channel)
      if (!schema) {
        failures.push(`${s.name}：契约里没有 ${s.channel} 的 schema`)
        continue
      }
      try {
        schema.parse(s.payload)
      } catch (e) {
        const issues = (e as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? []
        failures.push(
          `${s.name}（${s.channel}）：${issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`,
        )
      }
    }
    assert.deepEqual(failures, [], `渲染侧会发的载荷被契约拒收：\n${failures.join('\n')}`)
  })

  it('可空字段用 null 清空时，全部通道都不该报错（抽查 4 个域）', () => {
    // 这条是上一条的「反向」断言：明确列出被清空的字段，防止有人把 nullable 又改回 optional
    const nullChecks: Array<[string, unknown]> = [
      ['canvas:updateLine', { lineId: 'l1', patch: { emotion: null, note: null, pronunciation: null } }],
      ['character:upsert', { character: { bookId: 'b1', name: '甲', description: null, note: null, color: null } }],
      ['voiceActor:upsert', { actor: { projectId: 'p1', name: '甲', contact: null, note: null } }],
    ]
    for (const [channel, payload] of nullChecks) {
      assert.doesNotThrow(() => schemaFor(channel)!.parse(payload), `${channel} 拒收 null`)
    }
  })
})
