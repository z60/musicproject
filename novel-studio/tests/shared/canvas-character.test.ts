/**
 * Novel Studio · 角色抽取与角色表工具测试
 * ============================================================================
 * 设计文档：docs/11 §4.6（角色表：自动抽取 / 别名管理 / 合并 / 归档 / 出场统计）、
 *           docs/11 §8（合并角色时的同名别名冲突）、docs/06 §5.1 Step 3（三种抽取信号）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/canvas-character.test.ts
 *
 * 守护点：
 *   · 三种信号各自生效，且**未注入分词器时明确降级**（只用前两种，不静默失败）
 *   · 称谓能归并成别名（小炎子/炎儿 → 萧炎），而不是冒出一堆假角色
 *   · 合并：台词迁移 + 别名迁移 + 冲突清单 + 源角色归档（不物理删除）
 *   · 拆分/别名/统计等小工具是纯函数（不修改入参）
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  addAlias,
  archiveCharacter,
  buildCharacterStats,
  createCharacter,
  extractCharacterCandidates,
  mergeCharacters,
  removeAlias,
  resolveCharacterByName,
  splitCharacter,
  type Tokenizer,
} from '../../src/shared/canvas/character.ts'
import { isAppError } from '../../src/shared/errors.ts'
import type { Character } from '../../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BOOK = 'book-1'

function char(name: string, over: Partial<Character> = {}): Character {
  return createCharacter({ id: `c-${name}`, bookId: BOOK, name, ...over })
}

/** 注入式分词器替身（生产：nodejieba 的 tag()，人名词性 nr） */
function fakeTokenizer(map: Record<string, string>): Tokenizer {
  return {
    tokenize(text: string) {
      const out: Array<{ word: string; pos?: string }> = []
      // 最长匹配：只要词表里的词出现在文本里就产出
      for (const [word, pos] of Object.entries(map)) {
        if (text.includes(word)) out.push({ word, pos })
      }
      return out
    },
  }
}

const SAMPLE = [
  '萧炎沉声道：“我必去。”',
  '药老抚须笑道：“随你。”',
  '老张说道：“来了来了。”',
  '萧炎说道：“炎儿，别怕。”',
  '炎儿，你来了。',
  '老张又说了一遍。',
  '药老摇了摇头。',
  '炎儿，快点。',
  '小医仙轻声道：“我会救你。”',
  '云韵说道：“宗门之事，不必多言。”',
].join('\n')

// ---------------------------------------------------------------------------
// 抽取
// ---------------------------------------------------------------------------

describe('角色抽取：三种信号（docs/11 §4.6）', () => {
  it('信号 1：从引导语前的 2~6 字窗口抽人名', () => {
    const cands = extractCharacterCandidates(SAMPLE, { minOccurrences: 1 })
    const names = cands.map((c) => c.name)
    assert.ok(names.includes('萧炎'), JSON.stringify(names))
    assert.ok(names.includes('药老'))
    assert.ok(names.includes('小医仙'), '3 字名也要能抽出来')
    assert.ok(names.includes('云韵'))
  })

  it('信号 2：高频称谓（老X / X儿 / 尊称）能作为独立候选', () => {
    const cands = extractCharacterCandidates(SAMPLE, { minOccurrences: 2 })
    const names = cands.map((c) => c.name)
    assert.ok(names.includes('老张'), `老X 应被抽出：${JSON.stringify(names)}`)
  })

  it('称谓能归并为别名（炎儿 → 萧炎），不产生假角色', () => {
    const cands = extractCharacterCandidates(SAMPLE, { minOccurrences: 1 })
    const yan = cands.find((c) => c.name === '萧炎')!
    assert.ok(yan, JSON.stringify(cands.map((c) => c.name)))
    assert.ok(yan.aliases.includes('炎儿'), `别名应迁移到全名下：${JSON.stringify(yan.aliases)}`)
    assert.ok(!cands.some((c) => c.name === '炎儿'), '归并后不应再出现独立候选「炎儿」')
  })

  it('出现次数与排序（降序、同次数按名字稳定排序）', () => {
    const cands = extractCharacterCandidates(SAMPLE, { minOccurrences: 1 })
    const counts = cands.map((c) => c.occurrences)
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a))
    for (const c of cands) assert.ok(c.occurrences >= 1)
  })

  it('代词/停用词不会被当成角色（他/她/众人）', () => {
    const text = '他说道：“走吧。”\n她说道：“好。”\n众人说道：“是。”'
    const names = extractCharacterCandidates(text, { minOccurrences: 1 }).map((c) => c.name)
    for (const bad of ['他', '她', '众人', '我们']) {
      assert.ok(!names.includes(bad), `不应抽出「${bad}」：${JSON.stringify(names)}`)
    }
  })

  it('minOccurrences 生效（只出现一次且无引导语的噪声被过滤）', () => {
    const text = '小路上没有人。\n老抚须笑道：“走吧。”'
    const loose = extractCharacterCandidates(text, { minOccurrences: 1 }).map((c) => c.name)
    const strict = extractCharacterCandidates(text, { minOccurrences: 2 }).map((c) => c.name)
    assert.ok(strict.length <= loose.length)
    // 「小路上」不是人名：小 + 路 命中停用词表
    assert.ok(!strict.includes('小路'))
  })

  it('信号 3：注入分词器后能抽出词性为 nr 的名字', () => {
    const text = '那人正是美杜莎。\n美杜莎冷冷地看着他。'
    const without = extractCharacterCandidates(text, { minOccurrences: 1 }).map((c) => c.name)
    assert.ok(!without.includes('美杜莎'), '没有引导语也没有称谓时，只靠信号 1/2 抽不出来')

    const withNer = extractCharacterCandidates(text, {
      minOccurrences: 1,
      tokenizer: fakeTokenizer({ 美杜莎: 'nr' }),
    }).map((c) => c.name)
    assert.ok(withNer.includes('美杜莎'), `注入分词器后应能抽出：${JSON.stringify(withNer)}`)
  })

  it('分词器抛错时不影响其余信号（L1 必须无条件可用）', () => {
    const bad: Tokenizer = {
      tokenize() {
        throw new Error('jieba 崩了')
      },
    }
    const cands = extractCharacterCandidates(SAMPLE, { minOccurrences: 1, tokenizer: bad })
    assert.ok(cands.some((c) => c.name === '萧炎'), '分词器故障不应让抽取整体失败')
  })

  it('chapterTitle 写进 firstChapterTitle（UI 用它提示「首次出现在哪」）', () => {
    const cands = extractCharacterCandidates(SAMPLE, { minOccurrences: 1, chapterTitle: '第一章 陨落的天才' })
    assert.ok(cands.every((c) => c.firstChapterTitle === '第一章 陨落的天才'))
  })

  it('maxCandidates 截断，且结果稳定可复现', () => {
    const a = extractCharacterCandidates(SAMPLE, { minOccurrences: 1, maxCandidates: 2 })
    const b = extractCharacterCandidates(SAMPLE, { minOccurrences: 1, maxCandidates: 2 })
    assert.equal(a.length, 2)
    assert.deepEqual(a, b, '同一输入必须给出同一结果（无随机）')
  })

  it('非字符串输入抛 AppError(INVALID_PAYLOAD)', () => {
    assert.throws(
      () => extractCharacterCandidates(null as unknown as string),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })
})

// ---------------------------------------------------------------------------
// 别名与查询
// ---------------------------------------------------------------------------

describe('别名与查询', () => {
  const xiao = char('萧炎', { aliases: ['炎帝'] })

  it('addAlias 是纯函数（不修改入参）', () => {
    const before = JSON.stringify(xiao)
    const r = addAlias(xiao, '小炎子', { now: () => 1 } as unknown as { now?: number })
    assert.equal(r.added, true)
    assert.ok(r.character.aliases.includes('小炎子'))
    assert.equal(r.character.aliases.includes('炎帝'), true, '已有别名不能丢')
    assert.equal(JSON.stringify(xiao), before, 'addAlias 不得修改入参')
  })

  it('重复别名/与自身同名 → added=false（不报错）', () => {
    assert.equal(addAlias(xiao, '炎帝').added, false)
    assert.equal(addAlias(xiao, '萧炎').added, false)
    assert.equal(addAlias(xiao, '   ').added, false)
  })

  it('与他人名字/别名冲突 → 不加并返回冲突（CHARACTER_MERGE_CONFLICT 语义）', () => {
    const yao = char('药老')
    const r = addAlias(xiao, '药老', { allCharacters: [xiao, yao] })
    assert.equal(r.added, false)
    assert.equal(r.conflict?.otherId, 'c-药老')
    assert.match(r.conflict!.message, /药老/)
    // force=true 才强行加
    assert.equal(addAlias(xiao, '药老', { allCharacters: [xiao, yao], force: true }).added, true)
  })

  it('removeAlias / archiveCharacter 都是纯函数', () => {
    const removed = removeAlias(xiao, '炎帝')
    assert.deepEqual(removed.aliases, [])
    assert.deepEqual(xiao.aliases, ['炎帝'], '不得修改入参')
    const archived = archiveCharacter(xiao, true)
    assert.equal(archived.isArchived, true)
    assert.equal(xiao.isArchived, false)
  })

  it('resolveCharacterByName：精确名 → 别名 → 最长包含匹配', () => {
    const xiao2 = char('萧炎', { aliases: ['炎帝', '小炎子'] })
    const yao = char('药老')
    const all = [xiao2, yao]
    assert.equal(resolveCharacterByName(all, '萧炎')?.id, 'c-萧炎')
    assert.equal(resolveCharacterByName(all, '炎帝')?.id, 'c-萧炎')
    assert.equal(resolveCharacterByName(all, '萧炎沉声')?.id, 'c-萧炎', '要能吃下带修饰语的窗口')
    assert.equal(resolveCharacterByName(all, '药老皱眉')?.id, 'c-药老')
    assert.equal(resolveCharacterByName(all, '路人甲'), null)
  })
})

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

describe('角色合并（docs/11 §4.6 / §8）', () => {
  const target = char('萧炎', { aliases: ['炎帝'], sortOrder: 0 })
  const sourceA = char('小炎子', { aliases: ['小炎'], sortOrder: 1 })
  const sourceB = char('炎帝', { aliases: ['火火'], sortOrder: 2 })
  const other = char('药老')
  const lines = [
    { id: 'L1', characterId: target.id },
    { id: 'L2', characterId: sourceA.id },
    { id: 'L3', characterId: sourceB.id },
    { id: 'L4', characterId: other.id },
    { id: 'L5', characterId: null },
  ]

  it('迁移台词与别名，并给出「将影响 N 行」的数字', () => {
    const r = mergeCharacters({
      target, sources: [sourceA, sourceB], lines, allCharacters: [target, sourceA, sourceB, other], now: 1,
    })
    assert.equal(r.movedLines, 2)
    assert.deepEqual(r.linePatches.map((p) => p.lineId), ['L2', 'L3'])
    for (const p of r.linePatches) {
      assert.equal(p.patch.characterId, target.id)
      assert.equal(p.patch.decidedBy, 'human', '合并是人工动作，必须锁定 decidedBy=human 防重算覆盖')
    }
    // 「炎帝」原本既是 target 的别名，也是 sourceB 的名字 → 已被去重，不算冲突
    assert.ok(r.mergedAliases.includes('小炎子'))
    assert.ok(r.mergedAliases.includes('火火'))
    assert.equal(r.mergedAliases.filter((a) => a === '炎帝').length, 0, '重复别名只保留一份')
    assert.deepEqual(r.archivedSourceIds.sort(), [sourceA.id, sourceB.id].sort())
    assert.equal(r.ok, true)
    assert.deepEqual(r.conflicts, [])
  })

  it('别名与「未参与合并的角色」冲突时返回冲突清单，ok=false', () => {
    const conflictSource = char('路人甲', { aliases: ['药老'] })
    const r = mergeCharacters({
      target, sources: [conflictSource], lines, allCharacters: [target, conflictSource, other], now: 1,
    })
    assert.equal(r.ok, false)
    assert.equal(r.conflicts.length, 1)
    assert.equal(r.conflicts[0].kind, 'alias_collision')
    assert.equal(r.conflicts[0].otherName, '药老')
    assert.ok(!r.target.aliases.includes('药老'), '有冲突的别名不得静默写入')
  })

  it('strict=true 时冲突直接抛 AppError(CHARACTER_MERGE_CONFLICT)', () => {
    const conflictSource = char('路人甲', { aliases: ['药老'] })
    assert.throws(
      () => mergeCharacters({
        target, sources: [conflictSource], lines, allCharacters: [target, conflictSource, other], strict: true,
      }),
      (e: unknown) => isAppError(e) && e.key === 'CHARACTER_MERGE_CONFLICT',
    )
  })

  it('把自己合并给自己 / 重复来源 → 冲突', () => {
    const r1 = mergeCharacters({ target, sources: [target], lines: [] })
    assert.equal(r1.ok, false)
    assert.equal(r1.conflicts[0].kind, 'self_merge')
    const r2 = mergeCharacters({ target, sources: [sourceA, sourceA], lines: [] })
    assert.ok(r2.conflicts.some((c) => c.kind === 'duplicate_source'))
  })

  it('keepAliases=false 时只迁移台词，不迁移任何别名（含源角色名）', () => {
    const r = mergeCharacters({ target, sources: [sourceA], lines, keepAliases: false, now: 1 })
    assert.deepEqual(r.mergedAliases, [])
    assert.equal(r.movedLines, 1, '台词迁移与别名策略无关')
    assert.deepEqual(r.archivedSourceIds, [sourceA.id])
  })

  it('不修改入参（target / sources / lines 都不动）', () => {
    const before = JSON.stringify({ target, sourceA, sourceB, lines })
    mergeCharacters({ target, sources: [sourceA, sourceB], lines, now: 1 })
    assert.equal(JSON.stringify({ target, sourceA, sourceB, lines }), before)
  })

  it('缺 target 抛 AppError(INVALID_PAYLOAD)', () => {
    assert.throws(
      () => mergeCharacters({ target: null as unknown as Character, sources: [], lines: [] }),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })

  it('合并后没有孤立引用（所有源角色的台词都被改写）', () => {
    const r = mergeCharacters({ target, sources: [sourceA, sourceB], lines, now: 1 })
    const patched = new Set(r.linePatches.map((p) => p.lineId))
    const stillSource = lines.filter(
      (l) => (l.characterId === sourceA.id || l.characterId === sourceB.id) && !patched.has(l.id),
    )
    assert.deepEqual(stillSource, [])
  })
})

// ---------------------------------------------------------------------------
// 拆分
// ---------------------------------------------------------------------------

describe('角色拆分（合并的逆操作）', () => {
  const merged = char('萧炎', { aliases: ['炎帝', '小炎子'], description: '主角' })

  it('按 parts 生成新角色并把指定台词改派过去', () => {
    const r = splitCharacter({
      character: merged,
      parts: [
        { name: '萧炎', lineIds: ['L1', 'L2'] },
        { name: '炎帝', aliases: ['小炎子'], lineIds: ['L3'] },
      ],
      now: 1,
    })
    assert.equal(r.created.length, 2)
    assert.equal(r.created[0].bookId, BOOK)
    assert.equal(r.created[1].aliases.length, 1)
    assert.equal(r.created[1].isArchived, false)
    assert.equal(r.linePatches.length, 3)
    assert.equal(r.linePatches[0].patch.characterId, r.created[0].id)
    assert.equal(r.linePatches[0].patch.decidedBy, 'human')
    assert.equal(r.source.id, merged.id, '源角色保留（由调用方决定是否归档）')
  })

  it('parts 为空时抛 AppError(INVALID_PAYLOAD)', () => {
    assert.throws(
      () => splitCharacter({ character: merged, parts: [] }),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })

  it('idFactory 可注入（生产用 nanoid，测试要确定性）', () => {
    const r = splitCharacter({
      character: merged,
      parts: [{ name: 'A' }, { name: 'B' }],
      idFactory: (i) => `new-${i}`,
    })
    assert.deepEqual(r.created.map((c) => c.id), ['new-0', 'new-1'])
  })
})

// ---------------------------------------------------------------------------
// 出场统计
// ---------------------------------------------------------------------------

describe('出场统计（docs/11 §4.6 / docs/20 §4.4）', () => {
  it('行数 / 字数 / 预估时长 / 已录时长', () => {
    const stats = buildCharacterStats('c-萧炎', [
      { characterId: 'c-萧炎', text: '我必去。', recordedMs: 1200 },
      { characterId: 'c-萧炎', text: '你也来吧。' },
      { characterId: 'c-药老', text: '随你。', recordedMs: 500 },
    ])
    assert.equal(stats.characterId, 'c-萧炎')
    assert.equal(stats.lines, 2)
    // 标点不计：我必去(3) + 你也来吧(4) = 7
    assert.equal(stats.chars, 7)
    assert.equal(stats.recordedMs, 1200)
    // 预估时长按 VAD_DEFAULTS.charsPerSecond = 4.2 字/秒
    assert.equal(stats.estimatedDurationMs, Math.round((7 / 4.2) * 1000))
  })

  it('没有出场的角色统计为 0（不抛错）', () => {
    const stats = buildCharacterStats('c-无人', [])
    assert.equal(stats.lines, 0)
    assert.equal(stats.chars, 0)
    assert.equal(stats.estimatedDurationMs, 0)
  })
})
