/**
 * Novel Studio · 画本脚本解析测试
 * ============================================================================
 * 覆盖真实样本（进球吧，教练-画本）的格式：
 *   台词行：【角色名-CV名】“台词”（CV 可省略）
 *   旁白行：其余非空段落
 *   角色表：序号/CV/角色名/性别/角色描述/台词数/音色/年龄，每个角色 8 行
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  CANVAS_CHARACTER_TABLE_HEADER,
  blankCanvasCharacterTables,
  detectCanvasScript,
  extractSpeech,
  parseCanvasScript,
  speakerContextOf,
  splitSpeakerTag,
} from '../../src/shared/text/canvas-script.ts'

/** 造一张角色表（header + 每角色 8 行） */
function table(rows: Array<{ no: string | number; cv: string; name: string; gender: string; desc: string; lines: string | number; voice: string; age: string | number }>): string {
  const out: string[] = [...CANVAS_CHARACTER_TABLE_HEADER]
  for (const r of rows) {
    out.push(String(r.no), r.cv, r.name, r.gender, r.desc, String(r.lines), r.voice, String(r.age))
  }
  return out.join('\n')
}

describe('画本脚本解析 · 群白标记不能落成垃圾旁白行', () => {
  /**
   * 真实缺陷（用户报「一行有旁白有角色音，结果复制了一行」）。
   *
   * 真实画本里的形态：
   *
   * ```
   * 【异口同声】【阡陌丨平凡-男龙套 3】“对！哈哈哈！”【异口同声】【鱼头一颗糖-男龙套2】“对！哈哈哈！”
   * ```
   *
   * `【异口同声】` 是**群白标记**：不含 `-`（`looksLikeSpeakerTag` 不认），
   * 且后面紧跟的是**另一个 `【`** 而不是引号（`quotedAfter` 也是 false）。
   * 于是它走进「取到下一个【 或行尾」的分支、取到**空串**，
   * 调用方拿空串去 `pushNarration` —— 把**标记本身**落成了一条旁白行。
   *
   * 实测那本真实书里，这种源行每条会多出 3 条 `【异口同声】` 旁白行，
   * 而用户看到的正是「凭空多出来几行旁白 / 像被复制了一行」。
   */
  it('【异口同声】不被落成旁白行（跳过前导标记后取引号台词）', () => {
    const s = parseCanvasScript(
      '第1章\n【异口同声】【阡陌丨平凡-男龙套 3】“对！哈哈哈！”\n',
      { chapterTitle: '第1章' },
    )
    const texts = s.lines.map((l) => l.text)
    assert.equal(
      texts.some((t) => /^【[^】]*】$/.test(t.trim())),
      false,
      `不该出现「text 就是标记本身」的行，实际：${JSON.stringify(texts)}`,
    )
    assert.ok(
      texts.some((t) => t.includes('对！哈哈哈！')),
      `引号里的台词必须被取出来，实际：${JSON.stringify(texts)}`,
    )
  })

  it('一条源行里多个群白标记 → 每个标记的台词各成一条，没有垃圾行', () => {
    const s = parseCanvasScript(
      '第1章\n【异口同声】【A-龙套1】“甲！”【异口同声】【B-龙套2】“乙！”\n',
      { chapterTitle: '第1章' },
    )
    const garbage = s.lines.filter((l) => /^【[^】]*】$/.test(l.text.trim()))
    assert.deepEqual(garbage, [], '不该有任何「标记本身」的行')
    assert.deepEqual(
      s.lines.map((l) => l.text),
      ['甲！', '乙！'],
    )
    // speaker 取自标记里的名字（`异口同声` 作为一个说话人名）
    assert.equal(s.lines[0]!.speaker, '异口同声')
  })

  it('群白标记后面直接跟引号时，仍然只出一条台词行', () => {
    const s = parseCanvasScript('第1章\n【异口同声】“大家一起说！”\n', { chapterTitle: '第1章' })
    assert.deepEqual(
      s.lines.map((l) => l.text),
      ['大家一起说！'],
    )
  })

  it('extractSpeech 会跳过前导标记（供其它解析路径复用）', () => {
    const r = extractSpeech('【异口同声】【A-龙套1】“台词”', 0)
    assert.equal(r.quoted, true, '跳过标记后应当能识别出引号')
    assert.equal(r.speech, '台词')
  })
})

describe('画本脚本解析 · 台词的其它形态', () => {
  it('【角色-CV】“台词” → 角色行（去掉引号）', () => {
    const r = parseCanvasScript('【杨浩-嬉小天】“只有我才能帮助马竞保级！”')
    assert.equal(r.lines.length, 1)
    const line = r.lines[0]!
    assert.equal(line.speaker, '杨浩')
    assert.equal(line.cv, '嬉小天')
    assert.equal(line.text, '只有我才能帮助马竞保级！')
    assert.equal(line.kind, 'dialogue')
    assert.equal(line.sourceText, '【杨浩-嬉小天】“只有我才能帮助马竞保级！”')
  })

  it('CV 可省略：【角色】“台词”', () => {
    const alts = ['【杨浩】“我来了。”', '【杨浩-】“我来了。”']
    for (const src of alts) {
      const r = parseCanvasScript(src)
      assert.equal(r.lines[0]!.speaker, '杨浩', src)
      assert.equal(r.lines[0]!.cv, null, src)
      assert.equal(r.lines[0]!.text, '我来了。', src)
    }
  })

  it('普通段落 → 旁白行', () => {
    const r = parseCanvasScript('　　2000年4月8日，西班牙首都马德里南部。')
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0]!.speaker, null)
    assert.equal(r.lines[0]!.kind, 'narration')
    assert.equal(r.lines[0]!.text, '2000年4月8日，西班牙首都马德里南部。')
  })

  it('空行被忽略，行序保持', () => {
    const r = parseCanvasScript('旁白一\n\n【甲-CV1】“台词一”\n   \n旁白二')
    assert.deepEqual(r.lines.map((l) => l.kind), ['narration', 'dialogue', 'narration'])
    assert.deepEqual(r.lines.map((l) => l.text), ['旁白一', '台词一', '旁白二'])
  })

  it('charStart/charEnd 指向该行在原文中的位置', () => {
    const text = '旁白\n【甲-CV1】“台词”'
    const r = parseCanvasScript(text)
    assert.equal(text.slice(r.lines[0]!.charStart, r.lines[0]!.charEnd), '旁白')
    assert.equal(text.slice(r.lines[1]!.charStart, r.lines[1]!.charEnd), '【甲-CV1】“台词”')
  })

  it('splitSpeakerTag：无连字符时 CV 为 null', () => {
    assert.deepEqual(splitSpeakerTag('杨浩-嬉小天'), { speaker: '杨浩', cv: '嬉小天' })
    assert.deepEqual(splitSpeakerTag('杨浩'), { speaker: '杨浩', cv: null })
  })
})

describe('画本脚本解析 · 台词与旁白不独占一行', () => {
  it('旁白在前：【旁白】【角色-CV】“台词” → 拆成旁白 + 台词', () => {
    const r = parseCanvasScript('克莱门特·巴拉维德皱眉道：【克莱门特-好风长吟】“这场比赛不好踢。”')
    assert.deepEqual(r.lines.map((l) => l.kind), ['narration', 'dialogue'])
    assert.equal(r.lines[0]!.text, '克莱门特·巴拉维德皱眉道：')
    assert.equal(r.lines[1]!.speaker, '克莱门特')
    assert.equal(r.lines[1]!.cv, '好风长吟')
    assert.equal(r.lines[1]!.text, '这场比赛不好踢。')
  })

  it('旁白在后：【角色-CV】“台词”后接旁白 → 拆成台词 + 旁白', () => {
    const r = parseCanvasScript('【弗洛伦蒂诺-天山雪豹】“你们谁能告诉我？”弗洛伦蒂诺沉声问着面前的众人。')
    assert.deepEqual(r.lines.map((l) => l.kind), ['dialogue', 'narration'])
    assert.equal(r.lines[0]!.text, '你们谁能告诉我？')
    assert.equal(r.lines[1]!.text, '弗洛伦蒂诺沉声问着面前的众人。')
  })

  it('（OS）标注：作为 note，不产生多余旁白，且标成 inner', () => {
    const r = parseCanvasScript('（OS）【杨浩-嬉小天】“回头问问，看他有没有兴趣来马竞。”')
    assert.equal(r.lines.length, 1)
    const line = r.lines[0]!
    assert.equal(line.kind, 'inner')
    assert.equal(line.speaker, '杨浩')
    assert.equal(line.note, '（OS）')
    assert.equal(line.text, '回头问问，看他有没有兴趣来马竞。')
  })

  it('（建议CV老师…）这类长标注也作为 note', () => {
    const r = parseCanvasScript('（建议CV老师先去看看下一章的旁白）【基科-阡陌丨平凡】“请你一定相信。”')
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0]!.note, '（建议CV老师先去看看下一章的旁白）')
    assert.equal(r.lines[0]!.speaker, '基科')
  })

  it('正文方括号【贝利法案】不能被当成角色', () => {
    const r = parseCanvasScript('球王贝利制订了一项新规则，叫做【贝利法案】，有点类似于博斯曼法案。')
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0]!.kind, 'narration')
    assert.equal(r.lines[0]!.speaker, null)
  })

  it('一行内多个台词标记 → 依次拆出', () => {
    const r = parseCanvasScript('【甲-CV1】“第一句”【乙-CV2】“第二句”')
    assert.deepEqual(r.lines.map((l) => l.kind), ['dialogue', 'dialogue'])
    assert.deepEqual(r.lines.map((l) => l.text), ['第一句', '第二句'])
    assert.deepEqual(r.lines.map((l) => l.speaker), ['甲', '乙'])
  })

  it('【角色】不带 CV、后面跟引号也认（旁白可省略引号外内容）', () => {
    const r = parseCanvasScript('他抬起头：【杨浩】“我来了。”')
    assert.equal(r.lines.length, 2)
    assert.equal(r.lines[1]!.speaker, '杨浩')
    assert.equal(r.lines[1]!.cv, null)
  })
})

describe('画本脚本解析 · 章标题', () => {
  it('传 chapterTitle 时，首行章标题不算台词（与画本生成一致）', () => {
    const text = '第1章 开始\n这是旁白。\n【甲-CV】“台词”'
    const withTitle = parseCanvasScript(text, { chapterTitle: '第1章 开始' })
    assert.deepEqual(withTitle.lines.map((l) => l.text), ['这是旁白。', '台词'])
    // 不传 chapterTitle 时按普通文本保留（通用解析，不擅自丢内容）
    const without = parseCanvasScript(text)
    assert.deepEqual(without.lines.map((l) => l.text), ['第1章 开始', '这是旁白。', '台词'])
  })
})

describe('画本脚本解析 · 角色表', () => {
  it('表头 + 8 行/角色 → 解析出角色字段', () => {
    const text = [
      '第1章 标题',
      '普通旁白',
      table([
        { no: 1, cv: '嬉小天', name: '杨浩', gender: '男', desc: '男主', lines: 1645, voice: '青叔音', age: 25 },
        { no: 2, cv: '墨澜', name: '老希尔', gender: '男', desc: '主席', lines: 71, voice: '老年音', age: 67 },
      ]),
    ].join('\n')
    const r = parseCanvasScript(text)
    assert.equal(r.characters.length, 2)
    assert.deepEqual(r.characters[0], {
      name: '杨浩',
      cv: '嬉小天',
      gender: '男',
      description: '男主',
      lineCountText: '1645',
      voiceType: '青叔音',
      ageText: '25',
    })
    // 角色表本身不是台词行，只产出前面的旁白
    assert.deepEqual(r.lines.map((l) => l.text), ['第1章 标题', '普通旁白'])
  })

  it('整行 pipe 连接的角色表（mammoth 把 <tr> 转成的形态）也能解析', () => {
    const text = [
      '第1章 标题',
      '序号 | CV | 角色名 | 性别 | 角色描述 | 台词数 | 音色 | 年龄',
      '1 | 嬉小天 | 杨浩 | 男 | 男主 | 1645 | 青叔音 | 25',
      '2 | 墨澜 | 老希尔 | 男 | 主席 | 71 | 老年音 | 67',
      '【杨浩-嬉小天】“台词”',
    ].join('\n')
    const r = parseCanvasScript(text)
    assert.equal(r.characters.length, 2)
    assert.equal(r.characters[0]!.name, '杨浩')
    assert.equal(r.characters[0]!.cv, '嬉小天')
    assert.equal(r.characters[0]!.voiceType, '青叔音')
    assert.deepEqual(r.lines.map((l) => l.text), ['第1章 标题', '台词'])
    const d = detectCanvasScript(text)
    assert.equal(d.isCanvas, true)
    assert.equal(d.characterRows, 2)
  })

  it('表结束后接正文：序号不是数字就停止（不吞正文）', () => {
    const text = [
      table([{ no: 1, cv: 'A', name: '甲', gender: '男', desc: 'd', lines: 1, voice: 'v', age: 20 }]),
      '第2章 另一个标题',
      '【乙-CV2】“第二段文本”',
    ].join('\n')
    const r = parseCanvasScript(text)
    assert.equal(r.characters.length, 1)
    assert.deepEqual(r.lines.map((l) => l.text), ['第2章 另一个标题', '第二段文本'])
  })

  it('多张表 / 重复角色会去重', () => {
    const t = table([{ no: 1, cv: 'A', name: '甲', gender: '男', desc: 'd', lines: 1, voice: 'v', age: 20 }])
    const r = parseCanvasScript(t + '\n旁白\n' + t)
    assert.equal(r.characters.length, 1)
  })
})


describe('画本脚本解析 · 角色表（列数不固定）', () => {
  it('空单元格被丢掉导致的变列数表格（5/6/7 列）也整张吃掉、不落进正文', () => {
    const text = [
      '第1章 标题',
      '序号 | CV | 角色名 | 性别 | 角色描述 | 台词数 | 音色 | 年龄',
      '15 | 机车教练揭扬眉 | 现场解说A | 男 | 167',
      '18 | 阡陌丨平凡 | 预备助教乙 | 无 | 龙套 | 3',
      '19 | 5号MVP | 预备助教丙 | 无 | 1',
      '【杨浩-嬉小天】“台词”',
    ].join('\n')
    const r = parseCanvasScript(text)
    // 关键：表格行一行都不能变成旁白
    assert.deepEqual(r.lines.map((l) => l.text), ['第1章 标题', '台词'])
    assert.deepEqual(r.characters.map((c) => c.name), ['现场解说A', '预备助教乙', '预备助教丙'])
    assert.equal(r.characters[0]!.cv, '机车教练揭扬眉')
    assert.equal(r.characters[1]!.gender, '无')
  })

  it('表头只剩 6 列（音色/年龄空列被丢）也能识别整表', () => {
    const text = [
      '序号 | CV | 角色名 | 性别 | 角色描述 | 台词数',
      '1 | 嬉小天 | 杨浩 | 男 | 男主 | 1645',
      '旁白正文',
    ].join('\n')
    const r = parseCanvasScript(text)
    assert.equal(r.characters.length, 1)
    assert.equal(r.characters[0]!.name, '杨浩')
    assert.deepEqual(r.lines.map((l) => l.text), ['旁白正文'])
  })
})

describe('blankCanvasCharacterTables · 角色表不进正文', () => {
  it('pipe 形态：等长抹除，正文偏移不变', () => {
    const text = [
      '第1章 标题',
      '序号 | CV | 角色名 | 性别 | 角色描述 | 台词数 | 音色 | 年龄',
      '1 | 嬉小天 | 杨浩 | 男 | 男主 | 1645 | 青叔音 | 25',
      '【杨浩-嬉小天】“台词”',
    ].join('\n')
    const before = parseCanvasScript(text)
    const blanked = blankCanvasCharacterTables(text)
    assert.equal(blanked.length, text.length, '长度必须一致（否则偏移会错位）')
    assert.equal(blanked.split('\n').length, text.split('\n').length, '行数必须一致')
    const lines = blanked.split('\n')
    assert.equal(lines[1]!.trim(), '')
    assert.equal(lines[2]!.trim(), '')
    assert.equal(lines[3], '【杨浩-嬉小天】“台词”', '台词行不能被误抹')
    const after = parseCanvasScript(blanked, { chapterTitle: '第1章 标题' })
    assert.equal(after.characters.length, 0, '正文里已无角色表')
    assert.deepEqual(after.lines.map((l) => l.text), ['台词'])
    assert.equal(after.lines[0]!.charStart, before.lines[1]!.charStart, '偏移必须保持')
    assert.equal(after.lines[0]!.charEnd, before.lines[1]!.charEnd)
  })

  it('每格一行形态：整表抹掉，段落保留', () => {
    const t = table([{ no: 1, cv: 'A', name: '甲', gender: '男', desc: 'd', lines: 1, voice: 'v', age: 20 }])
    const text = '旁白一\n' + t + '\n旁白二'
    const blanked = blankCanvasCharacterTables(text)
    assert.equal(blanked.length, text.length)
    assert.equal(blanked.includes('甲'), false)
    assert.deepEqual(parseCanvasScript(blanked).lines.map((l) => l.text), ['旁白一', '旁白二'])
  })
})

describe('detectCanvasScript', () => {
  it('含【角色-CV】→ 判定为画本', () => {
    const d = detectCanvasScript('【杨浩-嬉小天】“台词”')
    assert.equal(d.isCanvas, true)
    assert.equal(d.dialogueLines, 1)
  })

  it('只有角色表 → 也判定为画本', () => {
    const d = detectCanvasScript(table([{ no: 1, cv: 'A', name: '甲', gender: '男', desc: 'd', lines: 1, voice: 'v', age: 20 }]))
    assert.equal(d.isCanvas, true)
    assert.equal(d.characterRows, 1)
  })

  it('普通小说（含【】但不是台词）→ 不误判', () => {
    const d = detectCanvasScript('第一章\n【此处应有掌声】\n他说道：“你好。”')
    assert.equal(d.isCanvas, false)
    assert.equal(d.dialogueLines, 0)
  })
})
// ---------------------------------------------------------------------------
// 真机样本：角色表列顺序/列数可变 + 说话人标记顺序相反
// ---------------------------------------------------------------------------

describe('角色表列可变 · 说话人标记消歧', () => {
  it('6 列表头（无「性别」、顺序不同）也能整表识别，【CV-角色名】按表消歧', () => {
    // 崛起香江样本：表头是「序号|CV|角色名|角色描述|台词数|音色」，且标记写成【CV-角色名】
    const text = [
      '第2201章 开篇',
      '序号 | CV | 角色名 | 角色描述 | 台词数 | 音色',
      '1 | 阿翼爱热闹 | 男龙套3 | 69',
      '2 | 鱼头一颗糖 | 洪进宝 | 小胖子，武打明星洪金宝 | 34',
      '【阿翼爱热闹-男龙套3】“扑你个街！”',
    ].join('\n')
    const r = parseCanvasScript(text)
    assert.deepEqual(r.characters.map((c) => c.name), ['男龙套3', '洪进宝'])
    assert.equal(r.characters[0]!.cv, '阿翼爱热闹')
    // 表格行不能变成旁白
    assert.deepEqual(r.lines.map((l) => l.text), ['第2201章 开篇', '扑你个街！'])
    // 【CV-角色名】：说话人是角色名，CV 记进 cv
    assert.equal(r.lines[1]!.speaker, '男龙套3')
    assert.equal(r.lines[1]!.cv, '阿翼爱热闹')
  })

  it('角色表只在「前言」章时，逐章解析必须带 speakerContext（否则角色被建成 CV）', () => {
    const chapterText = '【阿翼爱热闹-男龙套3】“扑你个街！”'
    // 没有上下文：无从判断顺序，退回「角色名-CV」→ 左半边被当成角色（真机事故）
    const without = parseCanvasScript(chapterText)
    assert.equal(without.lines[0]!.speaker, '阿翼爱热闹')
    // 带上从全书角色表汇总出来的上下文 → 正确解析成 角色=男龙套3 / CV=阿翼爱热闹
    const ctx = speakerContextOf([{ name: '男龙套3', cv: '阿翼爱热闹' }])
    const withCtx = parseCanvasScript(chapterText, { speakerContext: ctx })
    assert.equal(withCtx.lines[0]!.speaker, '男龙套3')
    assert.equal(withCtx.lines[0]!.cv, '阿翼爱热闹')
  })

  it('【角色名-CV】仍按原顺序解析（进球吧样本）', () => {
    const text = [
      '序号 | CV | 角色名 | 性别 | 角色描述 | 台词数 | 音色 | 年龄',
      '1 | 嬉小天 | 杨浩 | 男 | 男主 | 1645 | 青叔音 | 25',
      '【杨浩-嬉小天】“我来了。”',
    ].join('\n')
    const r = parseCanvasScript(text)
    assert.equal(r.lines[0]!.speaker, '杨浩')
    assert.equal(r.lines[0]!.cv, '嬉小天')
  })
})

