/**
 * 测试 · 人名形态学（抽取精度的判别器）
 * ============================================================================
 * 设计依据：docs/11 §4.6（角色表「自动抽取」）、docs/06 §5.1 Step 3、docs/91 §5.2.32
 *
 * 真机事故：94 章 / 122 万字抽出 231 个候选，`开始(355)`、`上面(354)`、`尽管(245)`、
 * `躬身(106)`、`随口(74)` 全混在真角色中间 —— 那本书里真正的角色是
 * `姜练(5304)`、`晏灵修(2173)`、`沈绪(1207)`、`白言书(60)`、`无畏(23)`、`琉璃(9)`。
 * 用户原话：「抽取到 7 个候选角色 的丑陋/毫无疑/骂咧咧/模样不/丧尸星/嫌弃的/一通」
 * —— 这 7 个**全是错误对象**。
 *
 * 这组测试钉的是判别器本身（每一类证据的正例与反例）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  isRoleTitle,
  looksLikeAppellation,
  looksLikeTransliteratedName,
  normalizeSurname,
  startsWithSurname,
  startsWithSurnameExact,
} from '../../src/shared/canvas/person-name.ts'

describe('姓氏证据：真角色命中，常用词不命中', () => {
  it('真角色的姓氏写法命中（真机那本书的实测名单）', () => {
    for (const name of ['姜练', '晏灵修', '沈绪', '景琼', '段青', '朱载霄', '白言书', '王渺', '杜云', '林傲']) {
      assert.equal(startsWithSurname(name), true, `${name} 应当以姓氏开头`)
    }
  })

  it('被误抽的常用词不命中', () => {
    for (const junk of ['开始', '上面', '尽管', '第二', '年人', '躬身', '随口', '难道', '随后轻', '修神色', '至于魔', '为天下']) {
      assert.equal(startsWithSurname(junk), false, `${junk} 不该被当成姓氏`)
    }
  })

  it('复姓也算（司空峙 / 上官云 / 欧阳克）', () => {
    assert.equal(startsWithSurname('司空峙'), true)
    assert.equal(startsWithSurname('上官云'), true)
    assert.equal(startsWithSurname('欧阳克'), true)
  })

  it('异体姓氏归一：沉破天 → 沈破天（同一本书里两种写法并存）', () => {
    assert.equal(startsWithSurnameExact('沉破天'), false, '严格表里没有「沉」')
    assert.equal(startsWithSurname('沉破天'), true, '按异体归一后应当命中')
    assert.equal(normalizeSurname('沉破天'), '沈破天')
    assert.equal(normalizeSurname('沈破天'), '沈破天', '标准写法原样返回')
    assert.equal(normalizeSurname('萧炎'), '萧炎', '没有异体的原样返回')
  })
})

describe('音译名证据：汉名之外的角色（真机上全是漏抽的）', () => {
  it('音译名命中', () => {
    for (const name of ['哈维尔', '独眼多特', '舍沙', '诺顿·阿兰', '沙加']) {
      assert.equal(looksLikeTransliteratedName(name), true, `${name} 应当像音译名`)
    }
  })

  it('常用词不命中（这是它能当判别器用的前提）', () => {
    for (const junk of ['开始', '上面', '尽管', '躬身', '随口', '随后轻', '修神色', '至于魔']) {
      assert.equal(looksLikeTransliteratedName(junk), false, `${junk} 不该像音译名`)
    }
  })
})

describe('角色称谓：要分配声音的角色 vs 泛称', () => {
  it('窄表里的角色称谓命中（它们确实需要一个配音员）', () => {
    for (const title of ['师尊', '掌教', '祖师', '剑尊', '冰帝', '魔帝', '门主', '护法']) {
      assert.equal(isRoleTitle(title), true, `${title} 应当被当成角色称谓`)
    }
  })

  it('泛称不命中（指向不唯一，收进来候选表又会变脏）', () => {
    for (const generic of ['师兄', '师姐', '弟子', '长老', '前辈', '大人', '姑娘', '公子', '老爷', '执事', '侍卫']) {
      assert.equal(isRoleTitle(generic), false, `${generic} 是泛称，不该单独成为角色`)
    }
  })

  it('后缀匹配被关掉：拜见师尊 / 劳烦师尊 不算角色称谓', () => {
    // 真机实测：`师尊` 名下曾挂上 60 多个这种动词短语别名
    for (const phrase of ['拜见师尊', '劳烦师尊', '知道师尊', '既然师尊', '包括师尊', '四位长老', '外门长老']) {
      assert.equal(isRoleTitle(phrase), false, `${phrase} 是动词短语，不是角色称谓`)
    }
  })
})

describe('称谓写法：老X / 小X / 大X / 阿X / X儿 / X兄 / X老', () => {
  it('命中的写法', () => {
    for (const word of ['老张', '小炎', '大白', '阿兰', '炎儿', '张兄', '荒老', '练老', '小丧']) {
      assert.equal(looksLikeAppellation(word), true, `${word} 应当被当成称谓写法`)
    }
  })

  it('「名字 + 尊称」不算（必须由抽取器找到正名后并成别名）', () => {
    for (const word of ['景琼师兄', '顾安祖师', '晏掌教', '拜见师尊']) {
      assert.equal(looksLikeAppellation(word), false, `${word} 走别名归并，不走形态白名单`)
    }
  })
})
