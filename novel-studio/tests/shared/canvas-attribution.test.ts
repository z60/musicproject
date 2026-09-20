/**
 * Novel Studio · 说话人判定与画本生成测试（本域最重要的一份）
 * ============================================================================
 * 设计文档：docs/06 §5.1（Step 1~8）、§5.2（阈值）、§5.4（准确率 ≥ 85%）、§5.5（人工保护）、
 *           §8（降级矩阵）、docs/11 §2（生成流程）、§2.2（引号解析）、§2.3（停顿）、
 *           §3（confidence/candidates/decidedBy 必须存在）、§9（测试要点）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/canvas-attribution.test.ts
 *
 * 关于「假向量」：环境无网络、无 ONNX 模型，因此这里用一个**确定性词袋哈希** embedder
 * 代替 bge-small-zh-v1.5。它不具备语义泛化能力，只能反映「词面重合度」——
 * 但它足以验证判定流水线本身（分句 / 粗筛 / 上下文 / 余弦 / 阈值 / 规则后处理 / 降级），
 * 这正是本文件要守护的东西。真实模型下用同一个流水线即可（provider 由调用方注入）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  CUE_LOOKBACK_DEFAULT,
  EMOTION_LEXICON,
  RULE_CONFIDENCE,
  applyRulePostProcess,
  attributeByVector,
  buildContext,
  classifyKind,
  countReadableChars,
  findTopLevelQuoteSpans,
  generateCanvas,
  generateCanvasLines,
  inferPause,
  inferTags,
  matchCue,
  resolveSpeakerHint,
  splitToLines,
  type AttributionLine,
  type CanvasCharacterRef,
  type EmbeddingProvider,
  type LineDecision,
} from '../../src/shared/canvas/attribution.ts'
import { computeCentroid, l2Normalize } from '../../src/shared/canvas/vector.ts'
import { CANVAS_DEFAULTS, EMOTIONS } from '../../src/shared/constants.ts'
import { AppError, isAppError } from '../../src/shared/errors.ts'
import type { CanvasGenerateOptions, CanvasLine, LineKind, SpeakerType } from '../../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 确定性词袋哈希 embedder（代替 ONNX 模型；无网络环境下的注入式替身）
// ---------------------------------------------------------------------------

const EMBED_DIM = 512

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function isWordChar(ch: string): boolean {
  return /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch)
}

/** 单字 + 双字 bigram 的词袋哈希（纯确定性，无随机） */
function bagOfChars(text: string, dim = EMBED_DIM): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < text.length; i++) {
    if (!isWordChar(text[i])) continue
    v[fnv1a(text[i]) % dim] += 1
    if (i + 1 < text.length && isWordChar(text[i + 1])) {
      v[fnv1a(text.slice(i, i + 2)) % dim] += 1.5
    }
  }
  return l2Normalize(v)
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = 'fake-bagofchars-v1'
  readonly dim = EMBED_DIM
  /** 记录所有被向量化的文本，用于断言「短句不参与向量判定」 */
  readonly seen: string[] = []
  batchSizes: number[] = []
  failWith: Error | null = null

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.failWith) throw this.failWith
    this.batchSizes.push(texts.length)
    this.seen.push(...texts)
    return texts.map((t) => bagOfChars(t))
  }
}

// ---------------------------------------------------------------------------
// 8 个角色的假数据 + 30 行人工标注回归集
// ---------------------------------------------------------------------------

interface CharacterFixture {
  name: string
  aliases: string[]
  /** 冷启动原型词（docs/03 §5.3：角色名 + 别名 + 性格描述 + 首次出场上下文） */
  keywords: string[]
}

const CHARACTERS: CharacterFixture[] = [
  { name: '萧炎', aliases: ['炎帝', '小炎子'], keywords: ['斗气', '异火', '修炼', '焚天'] },
  { name: '药老', aliases: ['药尘'], keywords: ['丹药', '药材', '灵魂', '炼药'] },
  { name: '美杜莎', aliases: ['女王'], keywords: ['蛇人族', '部落', '沙漠', '进贡'] },
  { name: '小医仙', aliases: [], keywords: ['医术', '厄难毒体', '解毒', '经脉'] },
  { name: '云韵', aliases: [], keywords: ['云岚宗', '宗门', '弟子', '宗主'] },
  { name: '纳兰嫣然', aliases: ['嫣然'], keywords: ['家族', '悔婚', '名声', '骄傲'] },
  { name: '海波东', aliases: ['冰皇'], keywords: ['帝国', '雇佣兵', '一击', '加玛'] },
  { name: '紫研', aliases: ['小丫头'], keywords: ['太虚古龙', '龙皇', '吞天兽', '血脉'] },
]

function protoText(c: CharacterFixture): string {
  return [c.name, c.name, c.aliases.join(' '), c.keywords.join(' ')].join(' ')
}

function makeCharacters(): CanvasCharacterRef[] {
  return CHARACTERS.map((c) => ({
    id: `c-${c.name}`,
    name: c.name,
    aliases: c.aliases,
    description: null,
    // 单样本原型：等价于 cold start 的合成文本（docs/03 §5.3）
    centroid: bagOfChars(protoText(c)),
  }))
}

const idOf = (name: string): string => `c-${name}`

/** 30 行回归集：每行一句（单句末标点，保证一行 == 一行画本） */
const CORPUS_LINES: Array<{ text: string; expect: string | null; note: string }> = [
  { text: '夜色如墨，魔兽山脉深处传来低沉的兽吼。', expect: null, note: '旁白' },
  { text: '萧炎沉声道：“这点斗气还伤不到我，异火之下皆为蝼蚁。”', expect: idOf('萧炎'), note: '引导语在前' },
  { text: '“异火焚天，斗气化翼，谁也挡不住我修炼的脚步。”', expect: idOf('萧炎'), note: '无引导语，靠内容词' },
  { text: '“斗气修炼到九段，异火便能认主，我心中有数。”', expect: idOf('萧炎'), note: '连续对白（同一人）' },
  { text: '后山的雾气被晨光一寸寸撕开。', expect: null, note: '旁白（打断连续对白）' },
  { text: '“为师教你的炼药之法，你可还记得？”药老抚须笑道。', expect: idOf('药老'), note: '引导语在后' },
  { text: '“丹药的药材还差三味，灵魂之火已经快要熄了。”', expect: idOf('药老'), note: '无引导语' },
  { text: '“炼药需要三味药材，灵魂感知一刻也不能断。”', expect: idOf('药老'), note: '连续对白（同一人）' },
  { text: '洞府外的石阶上落了一层薄薄的灰。', expect: null, note: '旁白' },
  { text: '美杜莎冷冷道：“蛇人族的尊严，不容沙漠之外的人践踏。”', expect: idOf('美杜莎'), note: '引导语在前' },
  { text: '“蛇人族的部落就在沙漠深处，女王从不怜悯弱者。”', expect: idOf('美杜莎'), note: '无引导语' },
  { text: '“沙漠的部落每年都要向蛇人族女王进贡。”', expect: idOf('美杜莎'), note: '连续对白（同一人）' },
  { text: '远处的沙丘被风推着缓慢移动。', expect: null, note: '旁白' },
  { text: '小医仙轻声道：“你的毒已经深入经脉，我只能先救你性命。”', expect: idOf('小医仙'), note: '引导语在前' },
  { text: '“医术救不了厄难毒体，毒发之时无人能够近身。”', expect: idOf('小医仙'), note: '无引导语' },
  { text: '“我的医术能解百毒，却解不了自身的厄难。”', expect: idOf('小医仙'), note: '连续对白（同一人）' },
  { text: '药庐里的铜炉冒着淡淡的白烟。', expect: null, note: '旁白' },
  { text: '云韵说道：“云岚宗的弟子，从不与外门中人争执。”', expect: idOf('云韵'), note: '引导语在前' },
  { text: '“宗门弟子若败，云岚宗的脸面往哪里放。”', expect: idOf('云韵'), note: '无引导语' },
  { text: '云韵心想，宗门与弟子之间终究要有取舍。', expect: idOf('云韵'), note: '内心独白（内心引导语）' },
  { text: '山门前的青石板被雨水洗得很干净。', expect: null, note: '旁白' },
  { text: '纳兰嫣然傲然道：“悔婚之事，我纳兰家族从不后悔。”', expect: idOf('纳兰嫣然'), note: '引导语在前' },
  { text: '“家族的名声比命还重要，悔婚之时我便说过此话。”', expect: idOf('纳兰嫣然'), note: '无引导语' },
  { text: '演武场上的旗帜在风里猎猎作响。', expect: null, note: '旁白' },
  { text: '海波东说道：“冰皇之名，在加玛帝国无人不知。”', expect: idOf('海波东'), note: '引导语在前' },
  { text: '“帝国的雇佣兵再多，也挡不住冰皇的一击。”', expect: idOf('海波东'), note: '无引导语' },
  { text: '边境的城墙下积着未化的残雪。', expect: null, note: '旁白' },
  { text: '紫研嘟囔道：“太虚古龙的龙皇，才不怕什么吞天兽。”', expect: idOf('紫研'), note: '引导语在前' },
  { text: '“小丫头只想吃掉吞天兽，古龙的血脉从来不怕饿。”', expect: idOf('紫研'), note: '无引导语' },
  { text: '夜里的林子里只剩下虫鸣。', expect: null, note: '旁白' },
]

const CORPUS = CORPUS_LINES.map((l) => l.text).join('\n')

function baseOptions(over: Partial<CanvasGenerateOptions> = {}): CanvasGenerateOptions {
  return {
    useEmbedding: true,
    useLlm: false,
    contextWindow: CANVAS_DEFAULTS.contextWindow,
    // 假 embedder 的相似度尺度与 bge 不同（词袋余弦整体偏高且区分度低），因此回归集显式给阈值；
    // 阈值敏感度由「阈值扫描」用例覆盖（docs/06 §5.2 注：阈值必须可调且能实测）
    threshold: 0.5,
    margin: 0.02,
    ruleSetId: null,
    overwriteHuman: false,
    inferTags: true,
    ...over,
  }
}

/** 跑一遍回归集，返回每行的判定与期望 */
async function runCorpus(
  over: Partial<CanvasGenerateOptions> = {},
  embed: EmbeddingProvider | null = new FakeEmbeddingProvider(),
) {
  const out = await generateCanvas({
    chapterId: 'ch-regression',
    bookId: 'book-1',
    chapterText: CORPUS,
    characters: makeCharacters(),
    options: baseOptions(over),
    embed: embed ?? undefined,
    limits: { attributionThreshold: over.threshold ?? 0.5, attributionMargin: over.margin ?? 0.02 },
  })
  const rows = out.lines.map((l, i) => ({
    i,
    line: l,
    expect: CORPUS_LINES[i]?.expect ?? null,
    note: CORPUS_LINES[i]?.note ?? '',
    ok: (l.characterId ?? null) === (CORPUS_LINES[i]?.expect ?? null),
  }))
  const correct = rows.filter((r) => r.ok).length
  return { out, rows, correct, accuracy: correct / rows.length }
}

// ---------------------------------------------------------------------------
// Step 1：分句
// ---------------------------------------------------------------------------

describe('Step 1 分句：splitToLines', () => {
  it('按句末标点切分并保留 charStart/charEnd', () => {
    const text = '他抬头。风停了！你走吗？'
    const lines = splitToLines(text)
    assert.equal(lines.length, 3)
    assert.deepEqual(lines.map((l) => l.text), ['他抬头。', '风停了！', '你走吗？'])
    for (const l of lines) {
      assert.equal(text.slice(l.charStart, l.charEnd), l.text, 'charStart/charEnd 必须能切回原文')
    }
  })

  it('引号内部不切（台词保持完整）', () => {
    const text = '“你好。我叫萧炎。”他笑了笑。'
    const lines = splitToLines(text)
    assert.equal(lines.length, 1, `引号内的句号不应切开，实际：${JSON.stringify(lines.map((l) => l.text))}`)
    assert.equal(lines[0].text, text)
  })

  it('超过 maxLineChars 的长句在逗号处二次切且不产生空段', () => {
    const long = `“${'甲乙丙丁戊己庚辛'.repeat(6)}，${'壬癸子丑寅卯辰巳'.repeat(6)}。”`
    const lines = splitToLines(long, { maxLineChars: 30 })
    assert.ok(lines.length >= 2, '应被二次切分')
    assert.ok(lines.every((l) => l.text.trim().length > 0))
  })

  it('段落边界（空行）标记 startsParagraph / endsParagraph', () => {
    const lines = splitToLines('第一段。\n\n第二段。')
    assert.equal(lines.length, 2)
    assert.equal(lines[0].startsParagraph, true)
    assert.equal(lines[0].endsParagraph, true)
    assert.equal(lines[1].startsParagraph, true)
  })

  it('插入式对白按引号边界切分，插入的叙述不丢失', () => {
    const lines = splitToLines('“我……”他顿了顿，“……不去了。”')
    assert.equal(lines.length, 3, `实际：${JSON.stringify(lines.map((l) => l.text))}`)
    assert.equal(lines[0].text, '“我……”')
    assert.equal(lines[1].text, '他顿了顿，')
    assert.equal(lines[2].text, '“……不去了。”')
  })

  it('嵌套引号按最内层配对（顶层引号段只取一层）', () => {
    const spans = findTopLevelQuoteSpans('“他说：‘我不去。’”')
    assert.equal(spans.length, 1)
    const cls = classifyKind('“他说：‘我不去。’”')
    assert.equal(cls.kind, 'dialogue')
    assert.equal(cls.text, '他说：‘我不去。’')
    assert.ok(cls.matched.includes('nested_quote'))
  })

  it('空文本返回空数组；章节为空时 generateCanvas 抛 CANVAS_CHAPTER_EMPTY', async () => {
    assert.deepEqual(splitToLines(''), [])
    await assert.rejects(
      () => generateCanvasLines({
        chapterId: 'ch-empty', bookId: 'b', chapterText: '   \n\n ', characters: [], options: baseOptions(),
      }),
      (e: unknown) => isAppError(e) && e.key === 'CANVAS_CHAPTER_EMPTY',
    )
  })
})

// ---------------------------------------------------------------------------
// Step 2：规则粗筛
// ---------------------------------------------------------------------------

describe('Step 2 规则粗筛：classifyKind', () => {
  it('引号包裹 → dialogue，text 剥掉引号，识别「引导语在前」的人名', () => {
    const cls = classifyKind('萧炎沉声道：“我必去。”')
    assert.equal(cls.kind, 'dialogue')
    assert.equal(cls.text, '我必去。')
    assert.equal(cls.quoteStyle, '“”')
    assert.equal(cls.cue?.position, 'before')
    assert.equal(cls.cue?.verb, '沉声道')
    assert.equal(cls.cue?.speakerHint, '萧炎')
  })

  it('引导语在后（”萧炎说道。）也能提取说话人；代词只保留窗口不留人名', () => {
    const cls = classifyKind('“别过来。”萧炎冷冷地说道。')
    assert.equal(cls.kind, 'dialogue')
    assert.equal(cls.cue?.position, 'after')
    assert.equal(cls.cue?.speakerHint, '萧炎')
    assert.equal(resolveSpeakerHint(makeCharacters(), cls.cue!)?.character.name, '萧炎')

    const pronoun = classifyKind('“别过来。”他冷冷地说道。')
    assert.equal(pronoun.cue?.position, 'after')
    assert.equal(pronoun.cue?.speakerWindow, '他')
    assert.equal(pronoun.cue?.speakerHint, null, '代词不能当人名（否则会抽出角色「他」）')
    assert.equal(resolveSpeakerHint(makeCharacters(), pronoun.cue!), null)
  })

  it('破折号对白 → dialogue', () => {
    const cls = classifyKind('——我不去。')
    assert.equal(cls.kind, 'dialogue')
    assert.equal(cls.text, '我不去。')
    assert.equal(cls.dashDialogue, true)
  })

  it('心理描写 → inner（含内心引导语）', () => {
    const cls = classifyKind('萧炎心道，异火与斗气终究要合为一体。')
    assert.equal(cls.kind, 'inner')
    assert.equal(cls.cue?.verb, '心道')
    assert.equal(cls.cue?.speakerHint, '萧炎')
  })

  it('音效括号 → sfx_note', () => {
    assert.equal(classifyKind('【马蹄声由远及近】').kind, 'sfx_note')
    assert.equal(classifyKind('（音效：雷声）').kind, 'sfx_note')
  })

  it('整行以引导语结尾（他说道。）→ narration，不是台词', () => {
    assert.equal(classifyKind('他说道。').kind, 'narration')
    assert.equal(classifyKind('他缓缓抬起头，眼中闪过一丝狠厉。').kind, 'narration')
  })

  it('引号不配对时保留 unbalanced 标记', () => {
    const cls = classifyKind('“我还没有说完。')
    assert.equal(cls.unbalanced, true)
  })

  it('matchCue 对含修饰语的引导语能给出人名窗口', () => {
    const cue = matchCue('药老抚须笑道。', 'after')
    assert.equal(cue?.verb, '笑道')
    assert.equal(cue?.speakerWindow, '药老抚须')
    const resolved = resolveSpeakerHint(makeCharacters(), cue!)
    assert.equal(resolved?.character.name, '药老', '窗口里有修饰语时要靠包含匹配兜底')
  })
})

// ---------------------------------------------------------------------------
// 引号外的文字（真机事故：画本里「只有双引号里面的内容」）
// ---------------------------------------------------------------------------

/** 真机原文（《我陪魔神历劫》楔子，82 字）—— 用户报「只有引号里的内容」的就是它 */
const REAL_PREFACE = '楔子\n为了三界安生，我带着他的神魂下界，历劫的世界是天帝一手操办的，可是我刚睁眼，一颗脑袋混着血浆“嘭”的一声，在我跟前炸了，眼前尸横遍野，那一刻我懵在了原地。\n\n'

describe('引号外的文字必须成行（旁白），不能只留引号里的内容', () => {
  it('classifyKind 把引号前后的话交出来（偏移能切回原文）', () => {
    const raw = '疑惑的看向无畏：“什么意思，今年桃花宴换地方了？”'
    const cls = classifyKind(raw)
    assert.equal(cls.kind, 'dialogue')
    assert.equal(cls.text, '什么意思，今年桃花宴换地方了？')
    assert.equal(cls.narrations.length, 1, '引号前的叙述必须交出来')
    const lead = cls.narrations[0]
    assert.equal(lead.position, 'before')
    assert.equal(lead.text, '疑惑的看向无畏：')
    assert.equal(raw.slice(lead.start, lead.end), lead.text, 'start/end 必须能切回原文')
  })

  it('引号后的叙述也算旁白（我：“那现在怎么办？”总不能等死吧。）', () => {
    const cls = classifyKind('我：“那现在怎么办？”总不能等死吧。')
    assert.equal(cls.kind, 'dialogue')
    assert.equal(cls.text, '那现在怎么办？')
    assert.deepEqual(
      cls.narrations.map((n) => `${n.position}:${n.text}`),
      ['after:总不能等死吧。'],
      '「我：」是纯说话人标签（不朗读），标点后的「总不能等死吧。」是旁白',
    )
  })

  it('纯说话人标签不产出旁白片段（说了半天到底谁说的已经写进 cue）', () => {
    for (const raw of ['萧炎沉声道：“我必去。”', '“别过来。”药老抚须笑道。', '无畏：“你瞎啊？”', '他们：“对，没错。”']) {
      const cls = classifyKind(raw)
      assert.equal(cls.kind, 'dialogue', raw)
      assert.equal(cls.narrations.length, 0, `纯标签不该成行：${raw}`)
    }
    // 带动作的描述不是标签：它是有声书正文，必须念
    assert.equal(classifyKind('无畏翻了个白眼：“你瞎啊？”').narrations[0]?.text, '无畏翻了个白眼：')
  })

  it('行内短引号（拟声/强调）整句按旁白，不切成一行一个字的台词', () => {
    const raw = '一颗脑袋混着血浆“嘭”的一声，在我跟前炸了。'
    const cls = classifyKind(raw)
    assert.equal(cls.kind, 'narration')
    assert.equal(cls.text, raw, '整句保留（引号里的拟声词照读）')
    assert.ok(cls.matched.includes('inline_quote'))
    assert.equal(cls.narrations.length, 0)
  })

  it('generateCanvas：一句话切出「旁白 → 台词」，顺序与原文一致', async () => {
    const out = await generateCanvas({
      chapterId: 'ch-outside', bookId: 'b',
      chapterText: '疑惑的看向无畏：“什么意思，今年桃花宴换地方了？”',
      characters: [], options: baseOptions(), embed: new FakeEmbeddingProvider(),
    })
    assert.deepEqual(
      out.lines.map((l) => `${l.kind}:${l.text}`),
      ['narration:疑惑的看向无畏：', 'dialogue:什么意思，今年桃花宴换地方了？'],
    )
  })

  it('真机楔子：整章文字都进画本（除了章节标题），不再只剩「嘭」', async () => {
    const out = await generateCanvas({
      chapterId: 'ch-preface', bookId: 'b', chapterText: REAL_PREFACE,
      characters: [], options: baseOptions(), embed: new FakeEmbeddingProvider(),
    })
    const kinds = out.lines.map((l) => `${l.kind}:${l.text}`)
    assert.equal(kinds[0], 'narration:楔子')
    assert.equal(kinds.length, 2, `实际 ${JSON.stringify(kinds)}`)
    assert.match(out.lines[1].text, /为了三界安生/, '叙述正文必须成行')
    assert.match(out.lines[1].text, /血浆“嘭”的一声/, '行内拟声词保留在旁白里')
    assert.equal(out.lines.filter((l) => l.kind === 'dialogue').length, 0, '这章没有台词，不该凭空造一个「嘭」')
    // 覆盖率：原文所有非空白字符都出现在某一行里
    const joined = out.lines.map((l) => l.text).join('')
    for (const ch of REAL_PREFACE) {
      if (/\s/.test(ch)) continue
      assert.ok(joined.includes(ch), `原文的「${ch}」在画本里找不到`)
    }
  })

  it('同一句原文切出的旁白不打断「连续对白」链', async () => {
    // 第一句有引导语（判定为萧炎），引号后的叙述单独成行；
    // 第二句无引导语 —— 它仍应沿用上一说话人（同一句原文的旁白只是叙述，不是换人说话）
    const text = '萧炎沉声道：“我乃斗气大陆的炼药师。”他站在原地。\n“你说什么，再说一遍。”'
    const out = await generateCanvas({
      chapterId: 'ch-chain', bookId: 'b', chapterText: text,
      characters: makeCharacters(), options: baseOptions(), embed: new FakeEmbeddingProvider(),
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    const kinds = out.lines.map((l) => `${l.kind}:${l.text}`)
    assert.deepEqual(kinds, [
      'dialogue:我乃斗气大陆的炼药师。',
      'narration:他站在原地。',
      'dialogue:你说什么，再说一遍。',
    ])
    const second = out.lines[2]
    assert.equal(second.characterId, idOf('萧炎'), `中间那句旁白不该把「上一说话人」清掉，实际 ${second.characterId}`)
    assert.equal(second.decidedBy, 'rule')
    assert.match(second.attributionReason, /连续对白/)
  })
})

// ---------------------------------------------------------------------------
// Step 5 + 6：回归集准确率（docs/06 §5.4 目标 ≥ 85%）
// ---------------------------------------------------------------------------

describe('说话人判定：30 行人工标注回归集准确率 ≥ 85%', () => {
  it('切句结果与人工标注逐行对齐（30 行）', async () => {
    const { out } = await runCorpus()
    assert.equal(out.lines.length, CORPUS_LINES.length, '切句数必须与人工标注一致，否则准确率无意义')
    assert.equal(out.report.totalLines, CORPUS_LINES.length)
  })

  it('准确率 ≥ 85% 且真的用了向量判定', async () => {
    const { accuracy, correct, rows, out } = await runCorpus()
    assert.equal(out.report.embeddingUsed, true, '注入了 embed 就应当是 embeddingUsed=true')
    assert.ok(
      out.report.byDecision.vector > 0,
      `应有向量判定的行，实际：${JSON.stringify(out.report.byDecision)}`,
    )
    // 诊断输出（失败时能一眼看出哪行判错）
    for (const r of rows.filter((x) => !x.ok)) {
      console.log(`  x #${r.i} 期望=${r.expect ?? '旁白'} 实际=${r.line.characterId ?? '旁白'} [${r.note}] ${r.line.text}`)
    }
    console.log(`  回归集准确率：${(accuracy * 100).toFixed(1)}%（${correct}/${rows.length}）`)
    assert.ok(accuracy >= 0.85, `准确率 ${(accuracy * 100).toFixed(1)}%（${correct}/${rows.length}）低于 85%`)
  })

  it('阈值扫描：最优阈值下同样达标（docs/06 §5.2「阈值必须可调且能实测」）', async () => {
    const curve: Array<{ threshold: number; accuracy: number }> = []
    for (const threshold of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
      const { accuracy } = await runCorpus({ threshold })
      curve.push({ threshold, accuracy })
    }
    const best = curve.reduce((a, b) => (b.accuracy > a.accuracy ? b : a))
    console.log('  阈值-准确率曲线：' + curve.map((p) => `${p.threshold}:${(p.accuracy * 100).toFixed(0)}%`).join(' '))
    assert.ok(best.accuracy >= 0.85, `最优阈值 ${best.threshold} 下准确率仅 ${best.accuracy}`)
  })

  it('Top-3 候选与置信度被写入每行（UI「为什么判给他」的依据）', async () => {
    const { out } = await runCorpus()
    const vectorLines = out.lines.filter((l) => l.decidedBy === 'vector')
    assert.ok(vectorLines.length > 0)
    for (const l of vectorLines) {
      assert.ok(l.confidence != null && l.confidence > 0 && l.confidence <= 1)
      assert.ok(l.candidates != null && l.candidates.length >= 1 && l.candidates.length <= 3)
      const scores = l.candidates!.map((c) => c.score)
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), '候选必须按分数降序')
      assert.equal(l.candidates![0].characterId, l.characterId, 'Top1 必须就是判定的角色')
      assert.ok(Math.abs(l.candidates![0].score - l.confidence!) < 1e-6)
    }
    // 报告里也要能看到「判给谁、多少行、多少字」
    const yan = out.report.bySpeaker.find((s) => s.characterId === idOf('萧炎'))
    assert.ok(yan && yan.lines >= 3, `萧炎应至少 3 行，实际 ${JSON.stringify(yan)}`)
    assert.ok(yan!.chars > 0)
    assert.ok(out.report.bySpeaker.some((s) => s.characterId === null), '旁白也要出现在 bySpeaker 里')
  })

  it('报告统计口径完整（byKind / byDecision / lowConfidence / elapsedMs）', async () => {
    const { out } = await runCorpus()
    const kinds: LineKind[] = ['dialogue', 'narration', 'inner', 'sfx_note']
    for (const k of kinds) assert.equal(typeof out.report.byKind[k], 'number')
    const sum = kinds.reduce((a, k) => a + out.report.byKind[k], 0)
    assert.equal(sum, out.report.totalLines)
    const decisions = Object.values(out.report.byDecision).reduce((a, b) => a + b, 0)
    assert.equal(decisions, out.report.totalLines, '每行都必须有 decidedBy（旁白也由规则决定）')
    assert.ok(out.report.elapsedMs >= 0)
    assert.equal(typeof out.report.lowConfidence, 'number')
    assert.equal(out.report.unmatchedQuote, 0)
  })
})

// ---------------------------------------------------------------------------
// Step 6 的规则 2b：引号前的说话人标签 / 行内主语（真机事故：整本书只有旁白）
// ---------------------------------------------------------------------------

/** 只用「名字」构造判定引用（不需要向量：2b 是规则层的活） */
const nameRef = (name: string): CanvasCharacterRef => ({ id: `c-${name}`, name, aliases: [], centroid: null })

describe('Step 6 · 2b 说话人标签与行内主语（docs/91 §5.2.36）', () => {
  async function run(text: string, characters: string[]) {
    const out = await generateCanvas({
      chapterId: 'ch-subject', bookId: 'b', chapterText: text,
      characters: characters.map(nameRef),
      options: baseOptions(),
      // 无向量：与章节管理在「没有 ONNX 模型」时走的同一条路径（真机就是这个路径）
      embed: undefined,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    // 引号外的叙述会成为单独一行旁白（docs/91 §5.2.29），所以按 kind 取台词行
    return {
      lines: out.lines,
      dialogue: out.lines.filter((l) => l.kind === 'dialogue'),
    }
  }

  it('剧本体：行首「名字 + 冒号 + 引号」直接判给那个人（一个引导语动词都没有）', async () => {
    const { dialogue } = await run('无畏：“你瞎啊？”\n琉璃：“是这个道理。”', ['无畏', '琉璃'])
    assert.equal(dialogue[0]?.characterName, '无畏', `实际：${dialogue[0]?.attributionReason}`)
    assert.equal(dialogue[0]?.decidedBy, 'rule')
    assert.equal(dialogue[0]?.confidence, RULE_CONFIDENCE.speakerLabel)
    assert.match(dialogue[0]?.attributionReason ?? '', /行首说话人标签/)
    assert.equal(dialogue[1]?.characterName, '琉璃')
  })

  it('剧本体的前缀写法：`无畏翻了个白眼：“…”` 也算无畏', async () => {
    const { dialogue } = await run('无畏翻了个白眼：“你瞎啊？”', ['无畏'])
    assert.equal(dialogue.length, 1)
    assert.equal(dialogue[0]?.characterName, '无畏')
    assert.match(dialogue[0]?.attributionReason ?? '', /行首说话人标签/)
  })

  it('主语 + 叙述 + 引号：`沈绪轻轻的推开殿门而入，“拜见师尊。”` → 沈绪（短台词也不再丢）', async () => {
    const { dialogue } = await run('沈绪轻轻的推开殿门而入，“拜见师尊。”', ['沈绪', '师尊'])
    assert.equal(dialogue[0]?.characterName, '沈绪', `实际：${dialogue[0]?.attributionReason}`)
    assert.match(dialogue[0]?.attributionReason ?? '', /行内主语/)
  })

  it('引导语被状语顶开时回到句首主语：`姜练…看了一眼沈绪，随口问道，“…”` → 姜练', async () => {
    const { dialogue } = await run('姜练微微点头，抬头看了一眼沈绪，随口问道，“入门试炼结束了？”', ['姜练', '沈绪'])
    assert.equal(dialogue[0]?.characterName, '姜练', `不该判给被提及的沈绪：${dialogue[0]?.attributionReason}`)
    assert.equal(dialogue[0]?.needsReview, false)
  })

  it('主语边界优先：`作为代掌教的沈绪…问，“…”` 判沈绪，而不是「代掌教」里的掌教', async () => {
    // 真机第一次跑出来判成了「掌教」（它在「代掌教」里被先命中）——这是回归用例
    const { dialogue } = await run('此刻，作为代掌教的沈绪有些心神不宁，连忙赶上去问，“入门试炼的事？”', ['掌教', '沈绪'])
    assert.equal(dialogue[0]?.characterName, '沈绪', `实际：${dialogue[0]?.attributionReason}`)
  })

  it('歧义（引号前有两个角色名）→ 给结论但标待确认', async () => {
    const { dialogue } = await run('姜练看向沈绪，沈绪又看向掌教，“谁去？”', ['姜练', '沈绪', '掌教'])
    assert.ok(dialogue[0]?.characterName, '仍要给一个结论，而不是一律旁白')
    assert.equal(dialogue[0]?.needsReview, true, '歧义必须进待确认')
    assert.equal(dialogue[0]?.confidence, RULE_CONFIDENCE.subjectAmbiguous)
    assert.match(dialogue[0]?.attributionReason ?? '', /多个角色名/)
  })

  it('引号前没有角色名时不瞎猜（仍是未指派 + 待确认）', async () => {
    const { dialogue } = await run('“就这些？”\n“在可能的情况下，系统会发布任务。”', ['姜练', '沈绪'])
    assert.equal(dialogue[0]?.characterName, null)
    assert.equal(dialogue[0]?.speakerType, 'narration')
    assert.equal(dialogue[0]?.needsReview, true)
  })

  it('引导语指名仍然优先（不被 2b 覆盖）', async () => {
    const { dialogue } = await run('萧炎沉声道：“我必去。”', ['萧炎', '药老'])
    assert.equal(dialogue[0]?.characterName, '萧炎')
    assert.equal(dialogue[0]?.confidence, RULE_CONFIDENCE.cueOverride)
    assert.match(dialogue[0]?.attributionReason ?? '', /引导语指名/)
  })

  it('标签对不上角色表时不动手（`说明：“…”`）', async () => {
    const { dialogue } = await run('说明：“这里没有角色名。”', ['姜练'])
    assert.equal(dialogue[0]?.characterName, null, '标签没能对上角色表就不能指派')
  })
})

// ---------------------------------------------------------------------------
// Step 6 的硬规则
// ---------------------------------------------------------------------------

describe('Step 6 规则后处理', () => {
  it('引导语明确指名时必须覆盖向量结果（规则优先于相似度）', async () => {
    // 内容全是药老的词，但引导语指名萧炎 → 必须判给萧炎
    const text = '萧炎沉声道：“这点丹药的药材还差三味，灵魂之火快要熄了。”'
    const out = await generateCanvas({
      chapterId: 'ch-cue', bookId: 'b', chapterText: text,
      characters: makeCharacters(), options: baseOptions(), embed: new FakeEmbeddingProvider(),
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    const line = out.lines[0]
    assert.equal(line.kind, 'dialogue')
    assert.equal(line.characterId, idOf('萧炎'), `引导语必须覆盖向量结果，实际 ${line.characterId}`)
    assert.equal(line.decidedBy, 'rule')
    assert.ok(line.confidence! >= 0.9)
    assert.match(line.attributionReason, /引导语指名/)
  })

  it('连续对白无引导语时偏向上一说话人（向量未达阈值 → 规则接管）', async () => {
    const text = '萧炎沉声道：“我乃斗气大陆的炼药师。”\n“你说什么，再说一遍。”'
    const out = await generateCanvas({
      chapterId: 'ch-run', bookId: 'b', chapterText: text,
      characters: makeCharacters(), options: baseOptions(), embed: new FakeEmbeddingProvider(),
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(out.lines.length, 2)
    const second = out.lines[1]
    assert.equal(second.characterId, idOf('萧炎'), `应偏向上一说话人，实际 ${second.characterId}`)
    assert.equal(second.decidedBy, 'rule')
    assert.match(second.attributionReason, /连续对白/)
  })

  it('连续对白只是「偏向」：向量差距大于加成时不被拉走，差距小时才偏向', () => {
    const lineA: AttributionLine = {
      id: 'L1', seq: 0, kind: 'dialogue', text: '我乃斗气大陆的炼药师。', sourceText: '“我乃斗气大陆的炼药师。”',
      cue: null, cueSpeaker: null, charStart: 0, charEnd: 12, paragraphIndex: 0, sceneIndex: 0,
      startsParagraph: true, endsParagraph: false, quoteUnmatched: false, tooLong: false,
    }
    const lineB: AttributionLine = {
      ...lineA, id: 'L2', seq: 1, text: '丹药的药材还差三味。', sourceText: '“丹药的药材还差三味。”',
    }
    const first: LineDecision = {
      lineId: 'L1', characterId: idOf('萧炎'), name: '萧炎', speakerType: 'character', confidence: 0.95,
      candidates: [{ characterId: idOf('萧炎'), name: '萧炎', score: 0.95 }],
      decidedBy: 'rule', needsReview: false, reason: '引导语指名', vector: null, shortLineProtected: false,
    }
    const strongCandidates = [
      { characterId: idOf('药老'), name: '药老', score: 0.91 },
      { characterId: idOf('萧炎'), name: '萧炎', score: 0.3 },
    ]
    const strong: LineDecision = {
      lineId: 'L2', characterId: idOf('药老'), name: '药老', speakerType: 'character', confidence: 0.91,
      candidates: strongCandidates,
      decidedBy: 'vector', needsReview: false, reason: '语义判定',
      vector: {
        characterId: idOf('药老'), name: '药老', confidence: 0.91, candidates: strongCandidates,
        accepted: true, reason: 'accepted', query: null,
      },
      shortLineProtected: false,
    }
    const opts = {
      characters: makeCharacters(), threshold: 0.62, margin: 0.06, embeddingAvailable: true, sceneFilter: false,
    }
    const res = applyRulePostProcess([first, strong], [lineA, lineB], opts)
    assert.equal(res[1].characterId, idOf('药老'), '向量差距 > bonus 时不应被「连续对白」拉走')
    assert.equal(res[1].decidedBy, 'vector')

    // 向量只以微弱差距领先上一说话人（差距 < bonus）→ 偏向上一说话人
    const closeCandidates = [
      { characterId: idOf('药老'), name: '药老', score: 0.7 },
      { characterId: idOf('萧炎'), name: '萧炎', score: 0.68 },
    ]
    const close: LineDecision = {
      ...strong,
      candidates: closeCandidates,
      confidence: 0.7,
      vector: {
        characterId: idOf('药老'), name: '药老', confidence: 0.7, candidates: closeCandidates,
        accepted: true, reason: 'accepted', query: null,
      },
    }
    const res2 = applyRulePostProcess([first, close], [lineA, lineB], opts)
    assert.equal(res2[1].characterId, idOf('萧炎'), '差距小于加成时应偏向上一说话人')
    assert.match(res2[1].reason, /连续对白/)
  })

  it('短句（可读字数 < 6）不做向量判定，也不把文本送去 embed', async () => {
    const provider = new FakeEmbeddingProvider()
    const text = '萧炎沉声道：“我乃斗气大陆的炼药师。”\n“嗯。”'
    const out = await generateCanvas({
      chapterId: 'ch-short', bookId: 'b', chapterText: text,
      characters: makeCharacters(), options: baseOptions(), embed: provider,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    const short = out.lines[1]
    assert.equal(countReadableChars(short.text) < CANVAS_DEFAULTS.shortLineChars, true)
    assert.ok(short.flags.includes('short_line'), `应带 short_line 标记，实际 ${JSON.stringify(short.flags)}`)
    assert.equal(short.decidedBy, 'rule')
    assert.equal(short.characterId, idOf('萧炎'), '短句应沿用上一说话人')
    assert.ok(!provider.seen.some((t) => t.includes('嗯。') && !t.includes('炼药师')), '短句文本不应单独送进 embed')
  })

  it('未注入 embed 时 embeddingUsed=false 且仍能产出结果（规则降级，不抛错）', async () => {
    const providerless = await generateCanvas({
      chapterId: 'ch-nomodel', bookId: 'b', chapterText: CORPUS,
      characters: makeCharacters(), options: baseOptions(),
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(providerless.report.embeddingUsed, false)
    assert.equal(providerless.lines.length, CORPUS_LINES.length)
    assert.ok(providerless.report.byDecision.rule > 0)
    assert.ok(
      providerless.report.warnings.some((w) => w.includes('CANVAS_EMBEDDING_UNAVAILABLE')),
      `降级必须显式写进报告，实际：${JSON.stringify(providerless.report.warnings)}`,
    )
    // 规则降级下：引导语明确指名的行仍然全对
    const cueIdx = CORPUS_LINES.map((l, i) => ({ l, i })).filter(({ l }) => l.note.startsWith('引导语'))
    for (const { l, i } of cueIdx) {
      assert.equal(providerless.lines[i].characterId, l.expect, `#${i} ${l.text}`)
    }
  })

  it('embed 抛错时同样降级（不阻断流程），并把失败原因写进报告', async () => {
    const provider = new FakeEmbeddingProvider()
    provider.failWith = new Error('CUDA out of memory')
    const out = await generateCanvas({
      chapterId: 'ch-oom', bookId: 'b', chapterText: CORPUS,
      characters: makeCharacters(), options: baseOptions(), embed: provider,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(out.report.embeddingUsed, false)
    assert.equal(out.lines.length, CORPUS_LINES.length)
    assert.ok(out.report.warnings.some((w) => w.includes('MODEL_OOM')), JSON.stringify(out.report.warnings))
  })

  it('取消信号（已中止）抛 AppError(TASK_CANCELLED)', async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => generateCanvas({
        chapterId: 'ch2', bookId: 'b', chapterText: CORPUS,
        characters: makeCharacters(), options: baseOptions(), embed: new FakeEmbeddingProvider(),
        signal: ac.signal,
      }),
      (e: unknown) => isAppError(e) && e.key === 'TASK_CANCELLED',
    )
  })

  it('角色表为空时全部台词行进待确认（docs/06 §8）', async () => {
    const out = await generateCanvas({
      chapterId: 'ch3', bookId: 'b', chapterText: CORPUS,
      characters: [], options: baseOptions(), embed: new FakeEmbeddingProvider(),
    })
    assert.ok(out.report.warnings.some((w) => w.includes('角色表为空')))
    const dialogue = out.lines.filter((l) => l.kind === 'dialogue')
    assert.ok(dialogue.length > 0)
    assert.ok(dialogue.every((l) => l.needsReview === true), '没有角色表时台词必须进待确认')
    assert.ok(dialogue.every((l) => l.speakerType === 'narration'))
  })
})

// ---------------------------------------------------------------------------
// 人工保护（docs/06 §5.5 / docs/11 §3）
// ---------------------------------------------------------------------------

function makeCanvasLine(over: Partial<CanvasLine> & Pick<CanvasLine, 'id' | 'seq' | 'text'>): CanvasLine {
  const now = 1_700_000_000_000
  return {
    chapterId: 'ch-human',
    bookId: 'b',
    speakerType: 'character' as SpeakerType,
    characterId: null,
    kind: 'dialogue' as LineKind,
    sourceText: null,
    charStart: 0,
    charEnd: 0,
    emotion: null,
    emotionIntensity: null,
    speed: null,
    gainDb: null,
    pauseAfterMs: 500,
    pauseInline: null,
    pronunciation: null,
    note: null,
    state: 'assigned',
    confidence: 1,
    candidates: null,
    decidedBy: 'human',
    needsReview: false,
    flags: [],
    isTitle: false,
    rev: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

describe('人工确认的行永不自动覆盖', () => {
  it('existingLines 里 decidedBy=human 的行在重算后保持原说话人', async () => {
    const text = '萧炎沉声道：“我乃斗气大陆的炼药师。”\n“你说什么，再说一遍。”'
    const existing = [
      makeCanvasLine({ id: 'L-1', seq: 1, text: '你说什么，再说一遍。', characterId: idOf('美杜莎') }),
    ]
    const out = await generateCanvas({
      chapterId: 'ch-human', bookId: 'b', chapterText: text,
      characters: makeCharacters(), options: baseOptions(), embed: new FakeEmbeddingProvider(),
      existingLines: existing,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    const second = out.lines[1]
    assert.equal(second.characterId, idOf('美杜莎'), '人工结论必须保留')
    assert.equal(second.decidedBy, 'human')
    assert.match(second.attributionReason, /人工确认/)
    assert.ok(out.report.warnings.some((w) => w.includes('CANVAS_ALREADY_EDITED')))

    // overwriteHuman=true 时才允许覆盖
    const forced = await generateCanvas({
      chapterId: 'ch-human', bookId: 'b', chapterText: text,
      characters: makeCharacters(), options: baseOptions({ overwriteHuman: true }), embed: new FakeEmbeddingProvider(),
      existingLines: existing,
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.notEqual(forced.lines[1].decidedBy, 'human')
  })

  it('applyRulePostProcess 对 decidedBy=human 的行原样返回', () => {
    const line: AttributionLine = {
      id: 'L1', seq: 0, kind: 'dialogue', text: '你说什么。', sourceText: '“你说什么。”',
      cue: null, cueSpeaker: null, charStart: 0, charEnd: 7, paragraphIndex: 0, sceneIndex: 0,
      startsParagraph: true, endsParagraph: true, quoteUnmatched: false, tooLong: false,
    }
    const human: LineDecision = {
      lineId: 'L1', characterId: 'c-美杜莎', name: '美杜莎', speakerType: 'character',
      confidence: 1, candidates: [], decidedBy: 'human', needsReview: false,
      reason: '人工', vector: null, shortLineProtected: false,
    }
    const res = applyRulePostProcess([human], [line], { characters: makeCharacters(), embeddingAvailable: true })
    assert.equal(res[0].characterId, 'c-美杜莎')
    assert.equal(res[0].decidedBy, 'human')
    assert.equal(res[0].confidence, 1)
  })
})

// ---------------------------------------------------------------------------
// Step 4 / 5 的单元级验证
// ---------------------------------------------------------------------------

describe('Step 4 上下文拼装 + Step 5 余弦判定', () => {
  const lines: AttributionLine[] = [
    {
      id: 'L1', seq: 0, kind: 'dialogue', text: '我必去。', sourceText: '萧炎说道：“我必去。”',
      cue: { verb: '说道', speakerHint: '萧炎', speakerWindow: '萧炎', position: 'before', text: '萧炎说道：' },
      cueSpeaker: { id: 'c-萧炎', name: '萧炎', aliases: [] },
      charStart: 0, charEnd: 12, paragraphIndex: 0, sceneIndex: 0,
      startsParagraph: true, endsParagraph: false, quoteUnmatched: false, tooLong: false,
    },
    {
      id: 'L2', seq: 1, kind: 'dialogue', text: '我也去。', sourceText: '“我也去。”',
      cue: null, cueSpeaker: null, charStart: 12, charEnd: 18, paragraphIndex: 0, sceneIndex: 0,
      startsParagraph: false, endsParagraph: true, quoteUnmatched: false, tooLong: false,
    },
    {
      id: 'L3', seq: 2, kind: 'narration', text: '风停了。', sourceText: '风停了。',
      cue: null, cueSpeaker: null, charStart: 18, charEnd: 22, paragraphIndex: 1, sceneIndex: 1,
      startsParagraph: true, endsParagraph: true, quoteUnmatched: false, tooLong: false,
    },
  ]

  it('dialogue 的上下文包含「最近引导语 + 当前行」，narration 用前后 N 行', () => {
    const ctx = buildContext(lines, 1, CANVAS_DEFAULTS.contextWindow, {
      staticPriorSpeaker: { characterId: 'c-萧炎', name: '萧炎' },
    })
    assert.equal(ctx.shape, 'dialogue-context')
    assert.equal(ctx.parts.cue, '萧炎说道：')
    assert.equal(ctx.parts.current, '我也去。')
    assert.equal(ctx.parts.prevSpeakerName, '萧炎')
    assert.ok(ctx.text.includes('萧炎说道：') && ctx.text.includes('我也去。'))

    const narr = buildContext(lines, 2, CANVAS_DEFAULTS.contextWindow)
    assert.equal(narr.shape, 'neighborhood')
    assert.deepEqual(narr.parts.before, ['萧炎说道：“我必去。”', '“我也去。”'])
    assert.deepEqual(narr.parts.after, [])
  })

  it('attributeByVector：Top-3 降序、通过阈值+margin 才归属、否则只给候选', () => {
    const chars = makeCharacters()
    const centroids = chars.map((c) => ({ characterId: c.id, name: c.name, vector: c.centroid! }))
    const ctx = buildContext(lines, 1, 2)
    ctx.vector = bagOfChars('丹药 药材 灵魂 炼药') // 明显是药老的语义
    const ok = attributeByVector(ctx, centroids, { threshold: 0.5, margin: 0.02 })
    assert.equal(ok.accepted, true)
    assert.equal(ok.characterId, idOf('药老'))
    assert.equal(ok.reason, 'accepted')
    assert.equal(ok.candidates.length, 3)
    assert.ok(ok.candidates[0].score >= ok.candidates[1].score)

    // 提高阈值到不可能通过 → 不再归属，但候选与分数仍然返回（可解释性）
    const strict = attributeByVector(ctx, centroids, { threshold: 0.999, margin: 0.5 })
    assert.equal(strict.accepted, false)
    assert.equal(strict.characterId, null)
    assert.equal(strict.reason, 'below_threshold')
    assert.ok(strict.candidates.length > 0)
    assert.ok(strict.confidence > 0)

    // 场景过滤（restrictTo）只在给定角色集合里排序
    const filtered = attributeByVector(ctx, centroids, { threshold: 0.5, margin: 0.02, restrictTo: [idOf('小医仙')] })
    assert.equal(filtered.candidates.length, 1)
    assert.equal(filtered.candidates[0].characterId, idOf('小医仙'))
    assert.equal(filtered.characterId, null, '单候选且分数未达阈值 → 不归属')

    // 无向量 → 显式表达为 no_query（不猜角色）
    const noVec = buildContext(lines, 1, 2)
    assert.equal(attributeByVector(noVec, centroids).reason, 'no_query')
    // 无原型 → no_centroids
    assert.equal(attributeByVector(ctx, []).reason, 'no_centroids')
  })

  it('场景内角色过滤：场外角色被排除后改判场内候选（docs/06 §5.1 Step 6）', () => {
    const line: AttributionLine = { ...lines[1], text: '我也跟着一起去吧。', sourceText: '“我也跟着一起去吧。”' }
    const candidates = [
      { characterId: idOf('药老'), name: '药老', score: 0.8 },
      { characterId: idOf('萧炎'), name: '萧炎', score: 0.7 },
    ]
    const decision: LineDecision = {
      lineId: line.id, characterId: idOf('药老'), name: '药老', speakerType: 'character',
      confidence: 0.8, candidates, decidedBy: 'vector', needsReview: false, reason: '向量',
      vector: {
        characterId: idOf('药老'), name: '药老', confidence: 0.8, candidates,
        accepted: true, reason: 'accepted', query: null,
      },
      shortLineProtected: false,
    }
    // 场景里先出现了萧炎（第 0 行由引导语确定）
    const first: LineDecision = {
      ...decision, lineId: lines[0].id, characterId: idOf('萧炎'), name: '萧炎', candidates: [], vector: null,
    }
    const res = applyRulePostProcess([first, decision], [{ ...lines[0] }, line], {
      characters: makeCharacters(),
      threshold: 0.6,
      margin: 0.05,
      sceneFilter: true,
      embeddingAvailable: true,
    })
    assert.equal(res[1].characterId, idOf('萧炎'), `场外候选应被过滤，实际 ${res[1].characterId}`)
    assert.match(res[1].reason, /场景内角色过滤/)
  })

  it('CUE_LOOKBACK_DEFAULT 之外不取引导语（避免把很久以前的引导语当上下文）', () => {
    const far = Array.from({ length: CUE_LOOKBACK_DEFAULT + 3 }, (_, i) => ({
      ...lines[2],
      id: `L${i}`,
      seq: i,
      sourceText: `第 ${i} 行`,
    })) as AttributionLine[]
    far[0] = { ...lines[0], id: 'L0', seq: 0 }
    const ctx = buildContext(far, far.length - 1, 2, { cueLookback: CUE_LOOKBACK_DEFAULT })
    assert.equal(ctx.parts.cue, null, '超出行距的引导语不应被采用')
  })
})

// ---------------------------------------------------------------------------
// Step 8：停顿推断（PAUSE_RULES）
// ---------------------------------------------------------------------------

describe('Step 8 停顿推断：inferPause', () => {
  it('按句末标点取 PAUSE_RULES 的值', () => {
    assert.equal(inferPause('我必去。', '下一行。', null, null).pauseAfterMs, 500)
    assert.equal(inferPause('走！', '下一行。', null, null).pauseAfterMs, 450)
    assert.equal(inferPause('走吗？', '下一行。', null, null).pauseAfterMs, 450)
    assert.equal(inferPause('我……', '下一行。', null, null).pauseAfterMs, 700)
    assert.equal(inferPause('他抬头，', '下一行。', null, null).pauseAfterMs, 200)
  })

  it('段落结束 900、场景切换 1200（说话人变化 + 段落边界）', () => {
    const para = inferPause('我必去。', null, null, 'c-a', { paragraphEnd: true })
    assert.equal(para.pauseAfterMs, 900)
    const scene = inferPause('我必去。', '下一行。', null, 'c-a', {
      paragraphEnd: true, nextSpeakerId: 'c-b', nextStartsParagraph: true,
    })
    assert.equal(scene.pauseAfterMs, 1200)
    assert.match(scene.ruleLabel, /场景切换/)
  })

  it('连续对白（同一角色）压缩到 350，全局节奏系数按比例缩放', () => {
    const same = inferPause('我必去。', '下一行。', 'c-a', 'c-a', { kind: 'dialogue' })
    assert.equal(same.pauseAfterMs, 350)
    assert.match(same.ruleLabel, /连续对白/)

    const tight = inferPause('我必去。', '下一行。', null, null, { tempoFactor: 0.8 })
    assert.equal(tight.pauseAfterMs, 400)
    const relaxed = inferPause('我必去。', '下一行。', null, null, { tempoFactor: 1.3 })
    assert.equal(relaxed.pauseAfterMs, 650)
  })

  it('显式标记优先级最高', () => {
    const r = inferPause('我必去。', null, null, 'c-a', { explicitPauseMs: 1234, paragraphEnd: true })
    assert.equal(r.pauseAfterMs, 1234)
    assert.match(r.ruleLabel, /显式/)
  })

  it('长句产生句内停顿插入点（pauseInline）', () => {
    const long = '他抬起头，看着天边，云层很低，风也停了，四周静得能听见心跳。'
    const r = inferPause(long, '下一行。', null, null)
    assert.ok(r.pauseInline != null && r.pauseInline.length >= 2, JSON.stringify(r.pauseInline))
    for (const i of r.pauseInline!) assert.equal(long[i], '，')
    assert.equal(inferPause('短句。', null, null, null).pauseInline, null)
  })
})

// ---------------------------------------------------------------------------
// Step 7：情绪/语速（词表优先）
// ---------------------------------------------------------------------------

describe('Step 7 情绪与语速：inferTags 词表优先', () => {
  it('命中词表时不标记 needsLlm（不调 LLM）', () => {
    const r = inferTags({ text: '他怒吼一声，一掌拍碎了石桌。', kind: 'dialogue' }, { llmEnabled: true })
    assert.equal(r.emotion, '愤怒')
    assert.equal(r.speed, 'fast')
    assert.equal(r.source, 'lexicon')
    assert.equal(r.needsLlm, false)
    assert.ok(r.matched.includes('怒吼'))
  })

  it('未命中时给默认情绪，并在开启 LLM 时把决定权交给上层', () => {
    const r = inferTags({ text: '他走上了山坡。', kind: 'narration' }, { llmEnabled: true })
    assert.equal(r.source, 'none')
    assert.equal(r.emotion, CANVAS_DEFAULTS.defaultEmotion)
    assert.equal(r.needsLlm, true)
    assert.equal(inferTags({ text: '他走上了山坡。' }, { llmEnabled: false }).needsLlm, false)
  })

  it('词表里的情绪名全部在 EMOTIONS 白名单内（UI 下拉框不会出现未知值）', () => {
    const allowed = new Set<string>(EMOTIONS)
    assert.ok(EMOTION_LEXICON.length > 0)
    for (const e of EMOTION_LEXICON) assert.ok(allowed.has(e.emotion), e.emotion)
  })

  it('inferTags 关闭时不标注（留空由角色表的默认情绪继承）', () => {
    const r = inferTags({ text: '他怒吼一声。' }, { enabled: false })
    assert.equal(r.emotion, null)
    assert.equal(r.emotionIntensity, null)
    assert.equal(r.speed, null)
    assert.equal(r.source, 'none')
  })
})

// ---------------------------------------------------------------------------
// 边界与健壮性
// ---------------------------------------------------------------------------

describe('边界与健壮性', () => {
  it('本域错误码可构造且消息会插值（UI 直接用 resolved）', () => {
    const e = new AppError('CANVAS_ATTRIBUTION_LOW_CONFIDENCE', { params: { count: 3 } })
    assert.equal(e.key, 'CANVAS_ATTRIBUTION_LOW_CONFIDENCE')
    assert.match(e.numericCode, /^E\d{5}$/)
    assert.match(e.resolved.detail ?? '', /3/)
    const merge = new AppError('CHARACTER_MERGE_CONFLICT', { params: { count: 2 } })
    assert.match(merge.resolved.detail ?? '', /2/)
  })

  it('computeCentroid 用来把单个原型向量归一化（写入前归一化约束）', () => {
    const raw = new Float32Array([3, 4, 0, 0])
    const { centroid } = computeCentroid([raw], { outlierThreshold: -1 })
    assert.ok(Math.abs(centroid[0] - 0.6) < 1e-6)
    assert.ok(Math.abs(l2Normalize(raw)[1] - 0.8) < 1e-6)
  })

  it('generateCanvasLines 与 generateCanvas 产出同一批行', async () => {
    const lines = await generateCanvasLines({
      chapterId: 'ch-eq', bookId: 'b', chapterText: CORPUS,
      characters: makeCharacters(), options: baseOptions(), embed: new FakeEmbeddingProvider(),
      limits: { attributionThreshold: 0.5, attributionMargin: 0.02 },
    })
    assert.equal(lines.length, CORPUS_LINES.length)
  })

  it('章首标题念白行可通过 includeTitleLine 打开（docs/15 §7）', async () => {
    const out = await generateCanvas({
      chapterId: 'ch-t', bookId: 'b', chapterTitle: '第一章 陨落的天才', chapterText: '风起了。',
      characters: makeCharacters(), options: baseOptions(), includeTitleLine: true,
    })
    assert.equal(out.lines.length, 2)
    assert.equal(out.lines[0].kind, 'narration')
    assert.equal(out.lines[0].text, '第一章 陨落的天才')
  })
})
