/**
 * Novel Studio · 编码嗅探测试
 * ============================================================================
 * 设计文档：docs/10-功能域-书籍导入.md §4（判定顺序 / 打分 / GBK→GB18030 升级 / needsUserChoice）
 *
 * 运行（Node 22.6+ 原生即可，无需任何第三方依赖）：
 *   node --experimental-strip-types tests/shared/text-encoding.test.ts
 *
 * 覆盖点（对应 docs/10 §11 测试要点的「编码」一栏）：
 *   · UTF-8 / BOM / UTF-16LE / UTF-16BE 判定
 *   · GBK 字节必须升级为 GB18030（docs/10 §4.2 —— 中文小说导入最容易踩的坑）
 *   · Big5 文本仍判为 Big5
 *   · 乱码输入不崩、needsUserChoice 触发条件
 *   · 打分规则（汉字/中文标点 +2、ASCII +1、控制字符 -10、U+FFFD -20）
 *   · 严格 UTF-8 校验（过长编码 / 代理区 / 截断序列）
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  NO_DECODER_NOTE,
  createBuiltinDecoder,
  createDecoder,
  detectEncoding,
  guessUtf16ByNulParity,
  isStrictUtf8,
  matchBom,
  normalizeEncodingName,
  normalizeNewlines,
  normalizeNewlinesWithCount,
  scoreText,
  scriptAffinity,
  stripBom,
} from '../../src/shared/text/encoding.ts'

// ---------------------------------------------------------------------------
// 测试样本
// ---------------------------------------------------------------------------

/** 真实 GBK 字节：`这个时候，他说道：我们为了国家，应该开放门户，让读书人看到更长的历史。\n第一章 开始\n他说：你好。` */
const GBK_BYTES = Buffer.from([
  213, 226, 184, 246, 202, 177, 186, 242, 163, 172, 203, 251, 203, 181, 181, 192, 163, 186, 206, 210, 195, 199, 206,
  170, 193, 203, 185, 250, 188, 210, 163, 172, 211, 166, 184, 195, 191, 170, 183, 197, 195, 197, 187, 167, 163, 172,
  200, 195, 182, 193, 202, 233, 200, 203, 191, 180, 181, 189, 184, 252, 179, 164, 181, 196, 192, 250, 202, 183, 161,
  163, 10, 181, 218, 210, 187, 213, 194, 32, 191, 170, 202, 188, 10, 203, 251, 203, 181, 163, 186, 196, 227, 186, 195,
  161, 163,
])

/** 真实 Big5 字节：`這個時候，他說道：我們為了國家，應該開放門戶，讓讀書人看到更長的歷史。` */
const BIG5_BYTES = Buffer.from([
  179, 111, 173, 211, 174, 201, 173, 212, 161, 65, 165, 76, 187, 161, 185, 68, 161, 71, 167, 218, 173, 204, 172, 176,
  164, 70, 176, 234, 174, 97, 161, 65, 192, 179, 184, 211, 182, 125, 169, 241, 170, 249, 164, 225, 161, 65, 197, 253,
  197, 170, 174, 209, 164, 72, 172, 221, 168, 236, 167, 243, 170, 248, 170, 186, 190, 250, 165, 118, 161, 67,
])

const utf8Body = '第一章 开始\n他说：“你好。”'

function utf16be(text: string): Buffer {
  const buf = Buffer.from(text, 'utf16le')
  buf.swap16()
  return buf
}

/** 确定性伪随机乱码（不用 Math.random，保证失败可复现） */
function garbageBytes(n = 64): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => (0x80 + ((i * 37) % 0x60)) & 0xff))
}

// ---------------------------------------------------------------------------
// 判定顺序：BOM → 严格 UTF-8 → 打分
// ---------------------------------------------------------------------------

describe('编码判定顺序（docs/10 §4.1）', () => {
  it('纯 UTF-8 文本判为 UTF-8，置信度高且不需要用户确认', () => {
    const d = detectEncoding(Buffer.from(utf8Body, 'utf8'))
    assert.equal(d.encoding, 'UTF-8')
    assert.equal(d.bomLength, 0)
    assert.ok(d.confidence >= 0.9, `confidence=${d.confidence}`)
    assert.equal(d.needsUserChoice, false)
    assert.match(d.candidates[0]!.preview, /第一章/)
  })

  it('UTF-8 BOM 被识别，bomLength = 3', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8Body, 'utf8')])
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-8')
    assert.equal(d.bomLength, 3)
    assert.equal(d.needsUserChoice, false)
    const decoded = createDecoder('UTF-8')!(buf.subarray(3))!
    assert.ok(decoded.startsWith('第一章'), decoded.slice(0, 10))
  })

  it('UTF-16LE BOM 被识别，bomLength = 2 且能解出原文', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8Body, 'utf16le')])
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-16LE')
    assert.equal(d.bomLength, 2)
    assert.equal(createDecoder('UTF-16LE')!(buf.subarray(2)), utf8Body)
  })

  it('UTF-16BE BOM 被识别，bomLength = 2 且能解出原文', () => {
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(utf8Body)])
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-16BE')
    assert.equal(d.bomLength, 2)
    assert.equal(createDecoder('UTF-16BE')!(buf.subarray(2)), utf8Body)
  })

  it('无 BOM 的 UTF-16LE 靠 0x00 奇偶启发式判出', () => {
    const text = 'Chapter 1 第一章\nHello world'
    const buf = Buffer.from(text, 'utf16le')
    const guess = guessUtf16ByNulParity(buf)
    assert.ok(guess, '应识别出 UTF-16 结构')
    assert.equal(guess!.encoding, 'UTF-16LE')
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-16LE')
    assert.equal(d.needsUserChoice, false)
    assert.equal(createDecoder('UTF-16LE')!(buf), text)
  })

  it('纯 ASCII 的 UTF-16LE 本身是合法 UTF-8，必须靠结构信号先判（否则会误判成 UTF-8）', () => {
    const text = 'Hello world'
    const buf = Buffer.from(text, 'utf16le')
    assert.equal(isStrictUtf8(buf), true, '前提：这些字节确实是合法 UTF-8')
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-16LE')
    assert.equal(createDecoder('UTF-16LE')!(buf), text)
  })

  it('无 BOM 的 UTF-16BE 同样可判', () => {
    const text = 'Chapter 1 第一章\nHello world'
    const buf = utf16be(text)
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-16BE')
    assert.equal(createDecoder('UTF-16BE')!(buf), text)
  })

  it('UTF-32LE BOM 能识别出编码，但本环境无解码器时必须让用户介入', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x2d, 0x4e, 0x00, 0x00])
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-32LE')
    assert.equal(d.bomLength, 4)
    // UTF-32 需要注入解码器（或换来源），不能假装解出来了
    assert.equal(d.needsUserChoice, true)
    assert.equal(d.candidates[0]!.preview, NO_DECODER_NOTE)
    assert.equal(createDecoder('UTF-32LE'), null)
  })

  it('matchBom 的优先级：FF FE 00 00 是 UTF-32LE 而不是 UTF-16LE', () => {
    assert.deepEqual(matchBom(Buffer.from([0xff, 0xfe, 0x00, 0x00])), { encoding: 'UTF-32LE', bomLength: 4 })
    assert.deepEqual(matchBom(Buffer.from([0xff, 0xfe, 0x41, 0x00])), { encoding: 'UTF-16LE', bomLength: 2 })
    assert.deepEqual(matchBom(Buffer.from([0xef, 0xbb, 0xbf])), { encoding: 'UTF-8', bomLength: 3 })
    assert.equal(matchBom(Buffer.from([0x41, 0x42])), null)
  })
})

// ---------------------------------------------------------------------------
// 中文场景：GBK → GB18030
// ---------------------------------------------------------------------------

describe('GBK → GB18030 升级（docs/10 §4.2）', () => {
  it('编码名归一化把 GBK / GB2312 升成 GB18030', () => {
    assert.equal(normalizeEncodingName('GBK'), 'GB18030')
    assert.equal(normalizeEncodingName('gb2312'), 'GB18030')
    assert.equal(normalizeEncodingName('x-gbk'), 'GB18030')
    assert.equal(normalizeEncodingName('GB18030'), 'GB18030')
    // 其它名字不受影响
    assert.equal(normalizeEncodingName('big5'), 'Big5')
    assert.equal(normalizeEncodingName('utf8'), 'UTF-8')
  })

  it('GBK 字节被判为 GB18030（绝不是 GBK/GB2312），且能用 GB18030 解出正确中文', () => {
    const decoder = createDecoder('GB18030')
    assert.ok(decoder, '本环境应支持 GB18030（Node 官方构建为 full-ICU）')
    assert.equal(decoder!(GBK_BYTES), '这个时候，他说道：我们为了国家，应该开放门户，让读书人看到更长的历史。\n第一章 开始\n他说：你好。')

    const d = detectEncoding(GBK_BYTES)
    assert.equal(d.encoding, 'GB18030')
    assert.equal(d.bomLength, 0)
    assert.ok(d.candidates.some((c) => c.encoding === 'GB18030'), '候选里必须有 GB18030')
    assert.ok(!d.candidates.some((c) => c.encoding === 'GBK' || c.encoding === 'GB2312'), 'GBK/GB2312 不得出现在候选里')
    assert.match(d.candidates[0]!.preview, /第一章 开始/)
  })

  it('注入嗅探器报 GBK 时同样升级为 GB18030（docs/10 §4.1 第 3~4 步）', () => {
    const sniffer = { detect: () => [{ encoding: 'GBK', confidence: 0.9 }] }
    const d = detectEncoding(GBK_BYTES, { sniffer })
    assert.equal(d.encoding, 'GB18030')
  })

  it('真正的 Big5 文本判为 Big5（简体优先不能过头）', () => {
    const decoder = createDecoder('Big5')
    assert.ok(decoder)
    assert.equal(decoder!(BIG5_BYTES), '這個時候，他說道：我們為了國家，應該開放門戶，讓讀書人看到更長的歷史。')
    const d = detectEncoding(BIG5_BYTES)
    assert.equal(d.encoding, 'Big5')
    assert.equal(d.needsUserChoice, false, `confidence=${d.confidence}`)
  })

  it('脚本判别：简体/繁体特征字能互相区分', () => {
    assert.ok(scriptAffinity('这个时候我们为了国家').net > 0)
    assert.ok(scriptAffinity('這個時候我們為了國家').net < 0)
  })

  it('注入的解码器会被真正调用（生产环境用 iconv-lite）', () => {
    let called = 0
    const injected = (buf: Buffer): string => {
      called++
      return `注入解码:${buf.length}`
    }
    const d = detectEncoding(GBK_BYTES, { decoders: { GB18030: injected } })
    assert.ok(called > 0, '注入解码器必须被调用')
    assert.ok(
      d.candidates.some((c) => c.preview === `注入解码:${GBK_BYTES.length}`),
      'GB18030 候选的预览应来自注入实现',
    )
  })

  it('按 iconv-lite 的用法注入（注册在 GBK 名下）也能正常判定', () => {
    // 模拟：const decoder = (buf) => iconv.decode(buf, 'gbk')
    const iconvLike = (buf: Buffer): string => new TextDecoder('gb18030').decode(buf)
    const d = detectEncoding(GBK_BYTES, { decoders: { GBK: iconvLike } })
    assert.equal(d.encoding, 'GB18030')
    assert.match(d.candidates[0]!.preview, /第一章 开始/)
  })
})

// ---------------------------------------------------------------------------
// 乱码与 needsUserChoice
// ---------------------------------------------------------------------------

describe('乱码输入与 needsUserChoice（docs/10 §4.1 第 6 步、§4.3）', () => {
  it('完全乱码的字节不崩，且必然 needsUserChoice=true', () => {
    const buf = garbageBytes()
    const d = detectEncoding(buf)
    assert.equal(typeof d.encoding, 'string')
    assert.equal(d.bomLength, 0)
    assert.equal(d.needsUserChoice, true)
    assert.ok(d.confidence < 0.7, `confidence=${d.confidence}`)
    assert.ok(d.candidates.length > 0 && d.candidates.length <= 3)
    assert.ok(d.candidates.length === 0 || typeof d.candidates[0]!.preview === 'string')
  })

  it('空文件退化为 UTF-8（不抛错；上游另有「空文件」拦截）', () => {
    const d = detectEncoding(Buffer.alloc(0))
    assert.equal(d.encoding, 'UTF-8')
    assert.equal(d.confidence, 1)
    assert.equal(d.needsUserChoice, false)
  })

  it('字节合法但含 U+FFFD（被错误转码过的产物）→ UTF-8 + 让用户确认', () => {
    const buf = Buffer.from('第一章 \uFFFD 开始', 'utf8')
    assert.equal(isStrictUtf8(buf), true)
    const d = detectEncoding(buf)
    assert.equal(d.encoding, 'UTF-8')
    assert.ok(d.confidence < 0.7)
    assert.equal(d.needsUserChoice, true, 'docs/10 §4.4 的「锟斤拷」类损坏必须提示用户')
  })

  it('置信度阈值可配（更严格时正常 UTF-8 也会要求确认）', () => {
    const buf = Buffer.from(utf8Body, 'utf8')
    const strict = detectEncoding(buf, { confidenceThreshold: 0.5 })
    assert.equal(strict.needsUserChoice, false) // BOM/严格 UTF-8 路径不受阈值影响（confidence=0.98）
    const gbk = detectEncoding(GBK_BYTES, { confidenceThreshold: 0.99 })
    assert.equal(gbk.needsUserChoice, true)
  })

  it('previewChars 可配（UI 的多列表格预览）', () => {
    const d = detectEncoding(GBK_BYTES, { previewChars: 4 })
    assert.equal(d.candidates[0]!.preview, '这个时候')
  })
})

// ---------------------------------------------------------------------------
// 打分规则与 UTF-8 校验
// ---------------------------------------------------------------------------

describe('合理字符打分（docs/10 §4.1 第 5 步）', () => {
  it('汉字 / 中文标点 +2，ASCII 可见 +1，控制字符 -10，U+FFFD -20', () => {
    assert.equal(scoreText('汉').score, 2)
    assert.equal(scoreText('。').score, 2)
    assert.equal(scoreText('a').score, 1)
    assert.equal(scoreText(' ').score, 1)
    assert.equal(scoreText('\u0001').score, -10)
    assert.equal(scoreText('\u007f').score, -10)
    assert.equal(scoreText('\uFFFD').score, -20)
  })

  it('换行与制表符不扣分', () => {
    assert.equal(scoreText('\n\t\r').score, 0)
    assert.equal(scoreText('汉\n').score, 2)
  })

  it('明细里的分类计数正确', () => {
    const m = scoreText('汉a\u0001\uFFFD')
    assert.equal(m.chars, 4)
    assert.equal(m.cjk, 1)
    assert.equal(m.asciiVisible, 1)
    assert.equal(m.control, 1)
    assert.equal(m.replacement, 1)
    assert.equal(m.score, 2 + 1 - 10 - 20)
  })

  it('乱码文本得分为负（用于与正常文本拉开差距）', () => {
    const decoder = createDecoder('UTF-8')!
    assert.ok(scoreText(decoder(GBK_BYTES)!).score < 0)
  })
})

describe('严格 UTF-8 校验（docs/10 §4.1 第 2 步）', () => {
  it('合法 UTF-8 通过', () => {
    assert.equal(isStrictUtf8(Buffer.from('第一章 abc', 'utf8')), true)
    assert.equal(isStrictUtf8(Buffer.from('😀 表情', 'utf8')), true)
    assert.equal(isStrictUtf8(Buffer.alloc(0)), true)
  })

  it('过长编码被拒绝', () => {
    assert.equal(isStrictUtf8(Buffer.from([0xc0, 0x80])), false)
    assert.equal(isStrictUtf8(Buffer.from([0xe0, 0x80, 0x80])), false)
    assert.equal(isStrictUtf8(Buffer.from([0xf0, 0x80, 0x80, 0x80])), false)
  })

  it('非法起始字节与游离续字节被拒绝', () => {
    assert.equal(isStrictUtf8(Buffer.from([0x80])), false)
    assert.equal(isStrictUtf8(Buffer.from([0xff])), false)
    assert.equal(isStrictUtf8(Buffer.from([0x41, 0xbf, 0x42])), false)
  })

  it('代理区码点与越界码点被拒绝', () => {
    assert.equal(isStrictUtf8(Buffer.from([0xed, 0xa0, 0x80])), false) // U+D800
    assert.equal(isStrictUtf8(Buffer.from([0xf5, 0x80, 0x80, 0x80])), false) // > U+10FFFF
  })

  it('截断的多字节序列被拒绝', () => {
    assert.equal(isStrictUtf8(Buffer.from([0xe4, 0xb8])), false)
    assert.equal(isStrictUtf8(Buffer.from([0xf0, 0x9f, 0x98])), false)
  })

  it('GBK 字节不是合法 UTF-8（这正是需要嗅探的原因）', () => {
    assert.equal(isStrictUtf8(GBK_BYTES), false)
  })
})

// ---------------------------------------------------------------------------
// 文本归一化辅助
// ---------------------------------------------------------------------------

describe('BOM 剥离与换行归一化', () => {
  it('stripBom 只去开头的 U+FEFF', () => {
    assert.equal(stripBom('\uFEFF第一章'), '第一章')
    assert.equal(stripBom('第一章\uFEFF'), '第一章\uFEFF')
    assert.equal(stripBom(''), '')
  })

  it('normalizeNewlines 把 \\r\\n 与 \\r 统一成 \\n', () => {
    assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd')
  })

  it('normalizeNewlinesWithCount 返回替换次数（清洗报告要这个数）', () => {
    const r = normalizeNewlinesWithCount('a\r\nb\rc\nd')
    assert.equal(r.text, 'a\nb\nc\nd')
    assert.equal(r.replaced, 2)
    assert.equal(normalizeNewlinesWithCount('a\nb').replaced, 0)
  })
})

describe('内置解码器能力边界', () => {
  it('UTF-8 / UTF-16LE / UTF-16BE 必然可用', () => {
    assert.ok(createBuiltinDecoder('UTF-8'))
    assert.ok(createBuiltinDecoder('UTF-16LE'))
    assert.ok(createBuiltinDecoder('UTF-16BE'))
  })

  it('未知编码返回 null（调用方据此抛 ENCODING_DECODE_FAILED 或注入实现）', () => {
    assert.equal(createBuiltinDecoder('KOI8-R'), null)
    assert.equal(createDecoder('KOI8-R'), null)
  })

  it('注入表按编码名覆盖内置实现', () => {
    const decoder = createDecoder('GB18030', { GB18030: () => 'x' })
    assert.equal(decoder!(Buffer.alloc(1)), 'x')
  })
})
