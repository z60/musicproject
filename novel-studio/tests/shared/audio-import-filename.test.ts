/**
 * 测试 · 按说话人导入音频：文件名解析
 * ============================================================================
 * 设计依据：docs/12-功能域-录音.md、docs/91 §5.2.1
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/audio-import-filename.test.ts
 *
 * 判据来源：`C:\projectText\cloudproject\musicproject\样本` 里的 5 个真实 mp3。
 * 这些文件名不是编的，所以下面把**真实字符串原样**写进用例 ——
 * 将来命名规则变化时，这些用例会第一时间红。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  SPEAKER_MARKERS,
  classifySpeakerToken,
  isAudioExtension,
  normalizeToken,
  parseAudioFileName,
  rangeCovers,
  rangeLength,
} from '../../src/shared/audio-import/filename.ts'

/** 真实样本文件名（逐个核对过画本，见 docs/91 §5.2.1） */
const REAL_SAMPLES = [
  '2127-2300-石玉凤-德钦.mp3',
  '2221-2240-石志坚-月光.mp3',
  '2221-2250-多角色-春哥拿大顶.mp3',
  '2226-2300-多角色-兔小舟.mp3',
  '2251-2255-旁白-语心草.mp3',
] as const

describe('文件名解析 · 真实样本', () => {
  it('5 个真实样本全部解析成功', () => {
    for (const name of REAL_SAMPLES) {
      const r = parseAudioFileName(name)
      assert.equal(r.ok, true, `${name} 应当解析成功，实际失败：${r.ok ? '' : r.detail}`)
    }
  })

  it('章节区间解析正确（含 174 章这种大区间）', () => {
    const cases: Array<[string, number, number]> = [
      ['2127-2300-石玉凤-德钦.mp3', 2127, 2300],
      ['2221-2240-石志坚-月光.mp3', 2221, 2240],
      ['2221-2250-多角色-春哥拿大顶.mp3', 2221, 2250],
      ['2226-2300-多角色-兔小舟.mp3', 2226, 2300],
      ['2251-2255-旁白-语心草.mp3', 2251, 2255],
    ]
    for (const [name, from, to] of cases) {
      const r = parseAudioFileName(name)
      assert.equal(r.ok, true, name)
      if (!r.ok) continue
      assert.equal(r.value.range.from, from, `${name} 起始章`)
      assert.equal(r.value.range.to, to, `${name} 结束章`)
    }
  })

  /**
   * 这是整个功能最容易搞反的一点：**第二个名字是 CV（配音演员）**。
   * 用画本里的 `【CV-角色】` 标记统计确定过（docs/91 §5.2.1）：
   * `石玉凤` 出现在标记右半边（角色位）9 次，`德钦` 出现在左半边（CV 位）9 次。
   */
  it('第一个名字是角色 token、第二个名字是 CV（顺序不能反）', () => {
    const cases: Array<[string, string, string]> = [
      ['2127-2300-石玉凤-德钦.mp3', '石玉凤', '德钦'],
      ['2221-2240-石志坚-月光.mp3', '石志坚', '月光'],
      ['2221-2250-多角色-春哥拿大顶.mp3', '多角色', '春哥拿大顶'],
      ['2226-2300-多角色-兔小舟.mp3', '多角色', '兔小舟'],
      ['2251-2255-旁白-语心草.mp3', '旁白', '语心草'],
    ]
    for (const [name, charToken, cvToken] of cases) {
      const r = parseAudioFileName(name)
      assert.equal(r.ok, true, name)
      if (!r.ok) continue
      assert.equal(r.value.characterToken, charToken, `${name} 的角色 token`)
      assert.equal(r.value.cvToken, cvToken, `${name} 的 CV token`)
    }
  })

  it('保留标记「多角色」「旁白」被正确识别（不是角色名）', () => {
    const multi = parseAudioFileName('2226-2300-多角色-兔小舟.mp3')
    assert.equal(multi.ok, true)
    if (multi.ok) assert.equal(multi.value.speakerKind, 'multiRole')

    const narr = parseAudioFileName('2251-2255-旁白-语心草.mp3')
    assert.equal(narr.ok, true)
    if (narr.ok) assert.equal(narr.value.speakerKind, 'narration')
  })

  it('普通角色名归类为 unknown（是否角色要查表才知道，纯解析层不下结论）', () => {
    const r = parseAudioFileName('2221-2240-石志坚-月光.mp3')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.value.speakerKind, 'unknown')
  })

  it('扩展名与主体被拆开', () => {
    const r = parseAudioFileName('2127-2300-石玉凤-德钦.mp3')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.ext, 'mp3')
    assert.equal(r.value.stem, '2127-2300-石玉凤-德钦')
    assert.equal(r.value.fileName, '2127-2300-石玉凤-德钦.mp3')
  })
})


describe('真机样本：`…/音频` 的 24 个文件名全部可解析', () => {
  /**
   * 真机反馈：「目录里有 24 个音频文件，扫描只能扫出 6 个」。
   *
   * 根因是解析器只认「数字-数字-角色-CV」这一种写法，而真实交付里混着：
   *
   * | 写法 | 例子 | 以前 |
   * |------|------|------|
   * | 区间用 `~` 分隔 | `2201~2300-蓝刚-匠心茶叙` | no-chapter-range |
   * | 单章（没有区间） | `2221-刘真雄-日岳星河` | no-chapter-range |
   * | 只写 CV | `2201-2300-珊瑚水月` / `2231-2240-鱼头一颗糖` | missing-name |
   * | 区间后用空格 | `2001-2300 云湛泊舟` | no-chapter-range |
   *
   * 这 24 个名字是**真机样本的原文**（一个字都没改），作为回归夹具钉住。
   */
  const REAL_SAMPLES = [
    '2001-2300 云湛泊舟',
    '2201-2250-全部角色-飞天的小猪',
    '2201-2299-奇怪山茶花',
    '2201-2300-珊瑚水月',
    '2201-2300-长夜怪人',
    '2201~2300-刘真雄等-日岳星河',
    '2201~2300-蓝刚-匠心茶叙',
    '2221-2230-胡俊才-袁问天',
    '2221-2230-鱼头一颗糖',
    '2221-刘真雄-日岳星河',
    '2221~2230-百里渠-匠心茶叙',
    '2223-2225-百里冰-蜉蝣',
    '2230-颜雄-日岳星河',
    '2231-2235-百里冰-蜉蝣',
    '2231-2240-鱼头一颗糖',
    '2241-2250-鱼头一颗糖',
    '2247-百里冰-蜉蝣',
    '2251-2260-鱼头一颗糖',
    '2251-2270-多角色-春哥那个哥',
    '2251-2300-全部-飞天的小猪',
    '2261-2270-鱼头一颗糖',
    '2271-2280-鱼头一颗糖',
    '2281-2290-鱼头一颗糖',
    '2291-2300-鱼头一颗糖',
  ]

  it('24 个全部解析成功（一个都不能少）', () => {
    const failed = REAL_SAMPLES.filter((name) => !parseAudioFileName(`${name}.mp3`).ok)
    assert.deepEqual(failed, [], `这些名字仍然解析不了：${failed.join(' / ')}`)
  })

  it('`~` 区间等价于 `-` 区间', () => {
    const r = parseAudioFileName('2201~2300-蓝刚-匠心茶叙.mp3')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual({ from: r.value.range.from, to: r.value.range.to }, { from: 2201, to: 2300 })
    assert.equal(r.value.characterToken, '蓝刚')
    assert.equal(r.value.cvToken, '匠心茶叙')
  })

  it('单章写法：区间退化成 from == to', () => {
    const r = parseAudioFileName('2221-刘真雄-日岳星河.mp3')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual({ from: r.value.range.from, to: r.value.range.to }, { from: 2221, to: 2221 })
    assert.equal(r.value.characterToken, '刘真雄')
    assert.equal(r.value.cvToken, '日岳星河')
  })

  it('只写 CV 的写法（含空格分隔的那种）都归到 cvOnly', () => {
    for (const name of ['2201-2300-珊瑚水月.mp3', '2231-2240-鱼头一颗糖.mp3', '2001-2300 云湛泊舟.mp3']) {
      const r = parseAudioFileName(name)
      assert.equal(r.ok, true, name)
      if (!r.ok) continue
      assert.equal(r.value.speakerKind, 'cvOnly', name)
      assert.equal(r.value.characterToken, null, name)
      assert.ok(r.value.cvToken.length > 0, name)
    }
  })
})

describe('文件名解析 · 边界与反例', () => {
  it('非音频文件名（readme.txt / 无区间）被拒绝且给出原因', () => {
    const cases: Array<[string, string]> = [
      ['readme.txt', 'no-chapter-range'],
      ['没有区间.mp3', 'no-chapter-range'],
      ['新建文本文档.txt', 'no-chapter-range'],
    ]
    for (const [name, reason] of cases) {
      const r = parseAudioFileName(name)
      assert.equal(r.ok, false, `${name} 应当被拒绝`)
      if (!r.ok) assert.equal(r.reason, reason, name)
    }
  })

  it('只有一个名字：那是 **CV**（真机样本 `2201-2300-珊瑚水月` 这类最多）', () => {
    const r = parseAudioFileName('2127-2300-珊瑚水月.mp3')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.speakerKind, 'cvOnly')
    assert.equal(r.value.characterToken, null, 'cvOnly 没有角色 token')
    assert.equal(r.value.cvToken, '珊瑚水月')
  })

  it('只有一个名字且它是保留标记时拒绝（标记不是人，缺 CV 没法导）', () => {
    for (const name of ['2127-2300-多角色.mp3', '2127-2300-旁白.mp3']) {
      const r = parseAudioFileName(name)
      assert.equal(r.ok, false, name)
      if (!r.ok) assert.equal(r.reason, 'missing-name', name)
    }
  })

  it('结束章小于起始章时拒绝', () => {
    const r = parseAudioFileName('2300-2127-倒序-A.mp3')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'chapter-range-invalid')
  })

  it('章节号为 0 时拒绝（正整数才合法）', () => {
    const r = parseAudioFileName('0-100-角色-A.mp3')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'chapter-range-invalid')
  })

  it('空文件名拒绝', () => {
    const r = parseAudioFileName('')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'empty-name')
  })

  /**
   * 解析失败**不能抛错**：导入是面对整个文件夹的操作，
   * 混进一个坏文件不该毁掉整批导入。上层靠 `ok:false` 汇总成「无法解析」列表。
   */
  it('任何输入都不抛错（用一串畸形输入压一遍）', () => {
    const nasty = [
      '',
      ' ',
      '.',
      '..',
      '-',
      '--',
      'a-b-c-d',
      '1-2',
      '1-2-',
      '1-2--x',
      '1e9-2e9-A-B',
      '99999999-99999999-A-B',
      '\u0000-\u0001-A-B',
      '１２３-１２４-全角-A',
      null as unknown as string,
      undefined as unknown as string,
    ]
    for (const n of nasty) {
      assert.doesNotThrow(() => parseAudioFileName(n), `输入 ${JSON.stringify(n)} 不该抛错`)
    }
  })

  it('传全路径时只取最后一段', () => {
    const r = parseAudioFileName('C:\\samples\\2226-2300-多角色-兔小舟.mp3')
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.value.fileName, '2226-2300-多角色-兔小舟.mp3')
      assert.equal(r.value.cvToken, '兔小舟')
    }
  })

  it('全角连字符与数字两边空格也能解析', () => {
    const r = parseAudioFileName('2226 － 2300 － 多角色 － 兔小舟.mp3')
    assert.equal(r.ok, true, r.ok ? '' : r.detail)
    if (r.ok) {
      assert.equal(r.value.range.from, 2226)
      assert.equal(r.value.range.to, 2300)
      assert.equal(r.value.cvToken, '兔小舟')
    }
  })

  /**
   * CV 名可能含分隔符（画本里有 `月光_深白色`）。
   * 这里验证「用最后一个分隔符切分」：含 `-` 的 CV 也能被完整保留。
   */
  it('CV 名含连字符时完整保留（用最后一个分隔符切）', () => {
    const r = parseAudioFileName('2221-2240-石志坚-月光-深白色.mp3')
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.value.characterToken, '石志坚')
      assert.equal(r.value.cvToken, '月光-深白色')
    }
  })

  it('大写扩展名归一为小写', () => {
    const r = parseAudioFileName('2226-2300-多角色-兔小舟.MP3')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.value.ext, 'mp3')
  })
})

describe('辅助函数', () => {
  it('classifySpeakerToken 识别两种保留标记', () => {
    assert.equal(classifySpeakerToken(SPEAKER_MARKERS.multiRole), 'multiRole')
    assert.equal(classifySpeakerToken(SPEAKER_MARKERS.narration), 'narration')
    assert.equal(classifySpeakerToken('石志坚'), 'unknown')
    assert.equal(classifySpeakerToken(''), 'unknown')
  })

  it('isAudioExtension 只认支持的音频格式', () => {
    for (const e of ['mp3', 'wav', 'flac', 'm4a', 'MP3']) {
      assert.equal(isAudioExtension(e), true, e)
    }
    for (const e of ['txt', 'docx', '', 'mp4']) {
      assert.equal(isAudioExtension(e), false, e)
    }
  })

  it('normalizeToken 去空白与零宽字符、大小写折叠，但保留下划线', () => {
    assert.equal(normalizeToken('  月光  '), '月光')
    assert.equal(normalizeToken('AbC'), 'abc')
    assert.equal(normalizeToken('月光\u200b深白色'), '月光深白色')
    // 下划线是名字的一部分（画本里就是 `月光_深白色`），不能被去掉
    assert.equal(normalizeToken('月光_深白色'), '月光_深白色')
  })

  it('rangeCovers / rangeLength 语义正确', () => {
    const range = { from: 2221, to: 2240, raw: '2221-2240' }
    assert.equal(rangeCovers(range, 2221), true, '含左端点')
    assert.equal(rangeCovers(range, 2240), true, '含右端点')
    assert.equal(rangeCovers(range, 2220), false, '左端外')
    assert.equal(rangeCovers(range, 2241), false, '右端外')
    assert.equal(rangeLength(range), 20)

    // 单章区间
    const single = { from: 100, to: 100, raw: '100-100' }
    assert.equal(rangeLength(single), 1)
    assert.equal(rangeCovers(single, 100), true)
  })
})
