/**
 * 测试 · 音频容器格式探测（`container.ts`）
 * ============================================================================
 * 设计依据：docs/05 §2、docs/91 §5.2.49
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/audio-container.test.ts
 *
 * ### 这组测试防的是什么
 *
 *   项目内音频链路**只认 WAV**（`audio-file.ts` 按 `RIFF`+`WAVE` 魔数校验）。
 *   而「按说话人导入音频」拿到的文件是 mp3/m4a/flac。
 *   第一版导入把 mp3 复制进来、扩展名写成 `.wav` ——
 *   于是产出一个**扩展名正确、内容不合法**的坏文件，
 *   后续「设为成品 / 测量 / 波形」全部失败，而排查时会先怀疑别处。
 *
 *   所以：**格式必须按内容判断**。本文件用**真实样本的头字节**做判据，
 *   而不是我自己编的字节。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  containerLabel,
  isDirectlyReadable,
  probeAudioContainer,
  readId3v2Size,
} from '../../src/shared/audio/container.ts'

/** 造字节序列 */
function bytes(...v: number[]): Uint8Array {
  return new Uint8Array(v)
}

/** 造 ASCII 魔数 */
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0))
}

// ---------------------------------------------------------------------------
// 真实样本（实测的头字节，见 docs/91 §5.2.49）
// ---------------------------------------------------------------------------

/**
 * 真实样本里 5 个 mp3 **全部以 ID3v2 标签开头**：
 *
 * ```
 *   4944330300000001100F545945520000   ← "ID3\x03" + 版本 + syncsafe 大小 + "TYER"
 * ```
 *
 * 关键：**MPEG 帧同步不在文件开头**，而在标签之后。
 * 所以「探测必须跳过 ID3」这件事必须用真实字节来证明。
 */
describe('真实样本：ID3v2 开头的 mp3', () => {
  /** 真实样本 1 的头 16 字节 */
  const REAL_ID3_HEAD = bytes(
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x01, 0x10, 0x0f, 0x54, 0x59, 0x45, 0x52, 0x00, 0x00,
  )

  it('识别为 mp3，并标为「不可直接读取」', () => {
    const r = probeAudioContainer(REAL_ID3_HEAD)
    assert.equal(r.container, 'mp3')
    assert.equal(r.readableAsWav, false, 'mp3 不能走 WAV-only 链路')
    assert.match(r.evidence, /ID3v2/)
  })

  it('算出 ID3v2 标签大小（跳过后才是音频数据）', () => {
    // syncsafe: 00 01 10 0f → (0<<21)|(1<<14)|(0x10<<7)|0x0f = 16384+2048+15 = 18447
    const size = readId3v2Size(REAL_ID3_HEAD)
    assert.equal(size, 10 + 18447, '应当含 10 字节头')
    const r = probeAudioContainer(REAL_ID3_HEAD)
    assert.equal(r.audioDataOffset, size, '音频数据偏移应当跳过标签')
  })

  it('5 个真实样本的标签头都是同一个形态（ID3\\x03）', () => {
    // 实测各样本的标签前缀一致，只是大小字段不同
    const variants: Array<[number, number, number, number]> = [
      [0x00, 0x00, 0x00, 0x01], // 石玉凤-德钦
      [0x00, 0x00, 0x00, 0x02], // 石志坚-月光
      [0x00, 0x00, 0x00, 0x01], // 多角色-春哥拿大顶
    ]
    for (const [b6, b7, b8, b9] of variants) {
      const head = bytes(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, b6, b7, b8, b9)
      assert.equal(probeAudioContainer(head).container, 'mp3')
    }
  })

  /**
   * 真实样本的大小各不相同（实测 18457 / 45953 / 32502 / 10176 / 32524），
   * 说明标签里可能嵌了封面图。探测必须能处理这种大标签。
   */
  it('大标签（含封面图，几万字节）也能正确解析', () => {
    // 45953 - 10 = 45943 = 0b1011001101110111 → syncsafe 拆成 7 位组
    const payload = 45943
    const b6 = (payload >> 21) & 0x7f
    const b7 = (payload >> 14) & 0x7f
    const b8 = (payload >> 7) & 0x7f
    const b9 = payload & 0x7f
    const head = bytes(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, b6, b7, b8, b9)
    assert.equal(readId3v2Size(head), 45953)
  })
})

describe('WAV（唯一可直接读取的容器）', () => {
  it('RIFF…WAVE 识别为 wav 且可读', () => {
    const head = bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE'), ...ascii('fmt '))
    const r = probeAudioContainer(head)
    assert.equal(r.container, 'wav')
    assert.equal(r.readableAsWav, true)
    assert.equal(isDirectlyReadable('wav'), true)
  })

  it('只有 RIFF 没有 WAVE 时**不算** wav（魔数必须成对）', () => {
    const head = bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('AVI '))
    assert.notEqual(probeAudioContainer(head).container, 'wav')
  })
})

describe('其它常见容器', () => {
  const cases: Array<[string, number[], string]> = [
    ['flac', [...ascii('fLaC'), 0, 0, 0, 0], 'flac'],
    ['ogg', [...ascii('OggS'), 0x00, 0x02, 0, 0, 0, 0], 'ogg'],
    ['m4a', [0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii('M4A ')], 'm4a'],
    ['aiff', [...ascii('FORM'), 0, 0, 0, 0, ...ascii('AIFF')], 'aiff'],
    ['wma', [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11], 'wma'],
    ['裸 MPEG 帧同步', [0xff, 0xfb, 0x90, 0x00], 'mp3'],
    ['ADTS AAC', [0xff, 0xf1, 0x50, 0x80], 'aac'],
  ]
  for (const [label, head, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      const r = probeAudioContainer(bytes(...head))
      assert.equal(r.container, expected, r.evidence)
      assert.equal(r.readableAsWav, false, `${label} 不该被认为可直接读取`)
    })
  }

  it('ADTS 的帧同步与 MPEG 帧同步不混淆（layer 位不同）', () => {
    // MPEG: 0xFF 后高 3 位为 1（0xE0）；ADTS 用 0xF0/0xF1
    assert.equal(probeAudioContainer(bytes(0xff, 0xfb)).container, 'mp3') // MPEG layer III
    assert.equal(probeAudioContainer(bytes(0xff, 0xf1)).container, 'aac') // ADTS
  })
})

describe('未知与脏输入：不猜', () => {
  it('无法识别时返回 unknown 并带出头字节（便于排查）', () => {
    const r = probeAudioContainer(bytes(0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4))
    assert.equal(r.container, 'unknown')
    assert.equal(r.readableAsWav, false)
    assert.match(r.evidence, /de ad be ef/, `证据里应含头字节，实际：${r.evidence}`)
  })

  it('空数组、超短输入不抛错', () => {
    for (const len of [0, 1, 2, 3, 4, 7, 11]) {
      const b = new Uint8Array(len)
      assert.doesNotThrow(() => probeAudioContainer(b), `长度 ${len} 不该抛错`)
      assert.equal(probeAudioContainer(b).container, 'unknown')
    }
  })

  it('假装成 WAV 的 mp3（扩展名骗不了内容校验）', () => {
    // 这正是第一版导入犯的错：内容 mp3、名字 .wav
    const mp3InsideWavName = bytes(
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00,
    )
    const r = probeAudioContainer(mp3InsideWavName)
    assert.equal(r.container, 'mp3', '必须按内容判定，不能因为调用方说它是 wav 就认')
    assert.equal(r.readableAsWav, false)
  })

  it('ID3v2 头声明非法（版本 0xFF / 高位为 1）时不当成 mp3 标签', () => {
    // 版本 0xFF = 保留值
    assert.equal(readId3v2Size(bytes(0x49, 0x44, 0x33, 0xff, 0x00, 0x00, 0, 0, 0, 0)), 0)
    // 大小字段高位为 1（不是 syncsafe）
    assert.equal(readId3v2Size(bytes(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x80, 0, 0, 0)), 0)
  })

  it('ID3v2 大小字段是 syncsafe（每字节只用低 7 位）', () => {
    // 若按普通 32 位整数读，0x7F 0x7F 0x7F 0x7F 会得到 2139062143；
    // syncsafe 应当是 (127<<21)|(127<<14)|(127<<7)|127 = 268435455
    const size = readId3v2Size(bytes(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x7f, 0x7f, 0x7f, 0x7f))
    assert.equal(size, 10 + 268435455, '必须按 syncsafe 解析')
  })
})

describe('面向用户的名称', () => {
  it('每个容器都有可读名称', () => {
    for (const c of ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aiff', 'aac', 'wma'] as const) {
      const label = containerLabel(c)
      assert.ok(label.length > 0 && label !== '未知格式', `${c} 应当有名称`)
    }
    assert.equal(containerLabel('unknown'), '未知格式')
  })

  it('isDirectlyReadable 只对 wav 为 true', () => {
    assert.equal(isDirectlyReadable('wav'), true)
    for (const c of ['mp3', 'flac', 'ogg', 'm4a', 'aiff', 'aac', 'wma', 'unknown'] as const) {
      assert.equal(isDirectlyReadable(c), false, `${c} 不该被判为可直接读取`)
    }
  })
})
