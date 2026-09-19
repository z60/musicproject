/**
 * 测试 · 角色画像聚合与过滤（移植自 Online-novel-character-extraction 的统计规则）
 * ============================================================================
 * 上游：https://github.com/wx331406/Online-novel-character-extraction （MIT）
 * 本仓库只移植**统计/聚合部分**，不移植它的 AI 抽取（本地 Qwen3-8B）—— 见模块头注释。
 *
 * 三条上游规则各有用例：
 *   ① 别名去重 + 排除自身 + 保序（`character_stats.py`）
 *   ② 四类描述各取**最长**（同文件 `best_appearance`）
 *   ③ 出现次数 < 3 直接删除（`filter_characters.py`）—— 这条正是「抽到一堆碎片」的对症规则
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  buildCharacterProfiles,
  describeFromText,
  filterCharacterProfiles,
  normalizeAliases,
  splitChaptersByUpstreamRule,
  UPSTREAM_MIN_OCCURRENCES,
  type CharacterObservation,
} from '../../src/shared/canvas/character-profile.ts'

function obs(patch: Partial<CharacterObservation> & { name: string }): CharacterObservation {
  return { occurrences: 3, ...patch }
}

describe('角色画像 · 别名规范化（上游规则 1）', () => {
  it('去重保序、去掉自身、去掉空串', () => {
    assert.deepEqual(normalizeAliases('萧炎', ['炎帝', '萧炎', '炎帝', '  ', '萧家三少']), ['炎帝', '萧家三少'])
    assert.deepEqual(normalizeAliases('A', []), [])
  })

  it('聚合时跨观察累计别名，最终仍按同一条规则清理', () => {
    const profiles = buildCharacterProfiles([
      obs({ name: '萧炎', aliases: ['炎帝'], occurrences: 10, chapterTitle: '第一章' }),
      obs({ name: '萧炎', aliases: ['萧炎', '炎帝', '少族长'], occurrences: 5, chapterTitle: '第二章' }),
    ])
    assert.equal(profiles.length, 1)
    assert.deepEqual(profiles[0]!.aliases, ['炎帝', '少族长'])
    assert.equal(profiles[0]!.occurrences, 15, '出现次数按上游口径累加')
    assert.equal(profiles[0]!.chapterCount, 2)
    assert.deepEqual(profiles[0]!.chapterTitles, ['第一章', '第二章'])
    assert.equal(profiles[0]!.firstChapterTitle, '第一章', '首见章节取最早那次观察')
  })
})

describe('角色画像 · 描述取最长（上游规则 2）', () => {
  it('同一类描述保留更长的句子（最短的往往是「他」这类片段）', () => {
    const profiles = buildCharacterProfiles([
      obs({ name: '萧炎', text: '萧炎是个少年。萧炎身材修长、面容俊朗，一双眼睛很有神。', chapterTitle: '第一章' }),
      obs({ name: '萧炎', text: '萧炎很累。', chapterTitle: '第二章' }),
    ])
    const d = profiles[0]!.descriptions
    assert.equal(d.appearance, '萧炎身材修长、面容俊朗，一双眼睛很有神', '应当保留最长的那条外貌描写')
    assert.equal(d.personality, null, '没有命中性格关键词就如实为空，不要拿外貌句凑数')
  })

  it('四类互不串味：性格句不会被当成外貌句', () => {
    const text = '萧炎性格沉稳、为人谨慎。萧炎嗓音低沉，说话很有分寸。萧炎左眼有一道疤痕。'
    const d = describeFromText(text, '萧炎')
    assert.match(d.personality ?? '', /性格沉稳/)
    assert.match(d.speech ?? '', /嗓音低沉/)
    assert.match(d.feature ?? '', /左眼.*疤痕/)
    assert.equal(d.appearance, null)
  })

  it('不含该名字的句子不参与（避免把别人的描写算到他头上）', () => {
    const d = describeFromText('药老身材干瘦、白发苍苍。萧炎站在一旁。', '萧炎')
    assert.equal(d.appearance, null)
  })

  it('超长文本按窗口截断（不对几十万字做正则扫描）', () => {
    const head = '萧炎身材修长。'
    const tail = 'x'.repeat(50_000) + '。萧炎面容俊朗、个子很高。'
    const d = describeFromText(head + tail, '萧炎', { windowChars: 100 })
    assert.equal(d.appearance, '萧炎身材修长', '窗口外的描写不该被扫到')
  })
})

describe('角色画像 · 出现次数过滤（上游规则 3，本轮的落地重点）', () => {
  it('少于 3 次的角色被删除，并**返回被删的那批**（好让日志说清过滤了什么）', () => {
    const profiles = buildCharacterProfiles([
      obs({ name: '萧炎', occurrences: 42 }),
      obs({ name: '药老', occurrences: 3 }),
      obs({ name: '丑陋', occurrences: 2 }),
      obs({ name: '毫无疑', occurrences: 1 }),
    ])
    const { kept, removed } = filterCharacterProfiles(profiles)
    assert.deepEqual(kept.map((p) => p.name), ['萧炎', '药老'])
    assert.deepEqual(removed.map((p) => p.name).sort(), ['丑陋', '毫无疑'])
    assert.equal(UPSTREAM_MIN_OCCURRENCES, 3, '阈值与上游 filter_characters.py 一致')
  })

  it('真机碎片样本会被这条规则挡住（事故回归）', () => {
    // 用户真机报告的原话：「抽取到 7 个候选角色 的丑陋/毫无疑/骂咧咧/模样不/丧尸星/嫌弃的/一通」
    const fragments = ['丑陋', '毫无疑', '骂咧咧', '模样不', '丧尸星', '嫌弃的', '一通']
    const profiles = buildCharacterProfiles([
      ...fragments.map((name, i) => obs({ name, occurrences: i === 0 ? 2 : 1 })),
      obs({ name: '萧炎', occurrences: 120 }),
    ])
    const { kept, removed } = filterCharacterProfiles(profiles)
    assert.deepEqual(kept.map((p) => p.name), ['萧炎'])
    assert.equal(removed.length, fragments.length)
  })

  it('阈值可调（不同书籍的规模差别很大，不写死）', () => {
    const profiles = buildCharacterProfiles([obs({ name: '配角', occurrences: 2 })])
    assert.equal(filterCharacterProfiles(profiles).kept.length, 0)
    assert.equal(filterCharacterProfiles(profiles, { minOccurrences: 2 }).kept.length, 1)
  })
})

describe('角色画像 · 排序与上限', () => {
  it('按出现次数降序；相同则章节数多的优先；上限生效', () => {
    const profiles = buildCharacterProfiles(
      [
        obs({ name: '甲', occurrences: 5, chapterTitle: '第一章' }),
        obs({ name: '乙', occurrences: 9, chapterTitle: '第一章' }),
        obs({ name: '丙', occurrences: 5, chapterTitle: '第一章' }),
        obs({ name: '丙', occurrences: 1, chapterTitle: '第二章' }),
      ],
      { maxProfiles: 2 },
    )
    assert.deepEqual(profiles.map((p) => p.name), ['乙', '丙'], '乙次数最多；丙与甲同次数但跨两章')
  })

  it('性别/年龄取首个非未知（上游 gender_found 规则）', () => {
    const profiles = buildCharacterProfiles([
      obs({ name: '甲', gender: '未知', ageHint: '未知' }),
      obs({ name: '甲', gender: '男', ageHint: '20岁' }),
      obs({ name: '甲', gender: '女' }),
    ])
    assert.equal(profiles[0]!.gender, '男', '第一次拿到非未知值就固定下来')
    assert.equal(profiles[0]!.ageHint, '20岁')
  })

  it('空名字/空白名字不产生画像', () => {
    assert.deepEqual(buildCharacterProfiles([obs({ name: '  ' }), obs({ name: '' })]), [])
  })
})

describe('角色画像 · 上游章节切分口径（只做对照，不参与业务流程）', () => {
  it('按「第X章」切分（上游 split_novel.py 的正则）', () => {
    const text = '序章内容\n第一章 起点\n正文一\n第二章 转折\n正文二\n'
    const chapters = splitChaptersByUpstreamRule(text)
    assert.equal(chapters.length, 2)
    assert.equal(chapters[0]!.title, '第一章 起点')
    assert.match(chapters[0]!.body, /正文一/)
    assert.equal(chapters[1]!.title, '第二章 转折')
  })

  it('没有章节标记时返回空（而不是把整本书当成一章）', () => {
    assert.deepEqual(splitChaptersByUpstreamRule('一段没有任何章节标题的文本'), [])
    assert.deepEqual(splitChaptersByUpstreamRule(''), [])
  })
})
