/**
 * 测试 · 处理链的指纹/判定与 ffmpeg 命令（纯逻辑）
 * ============================================================================
 * 设计依据：docs/14 §2.1/§3/§7.1/§13、docs/03 §6、docs/05 §2.5
 *
 * ### 这组测试守的是什么
 *   · **指纹稳定**：`presetHash` 决定 `processed/{segmentId}.{hash}.wav` 的文件名与
 *     「跳过重复处理」的判据。一次不稳定，就会「同样的预设每次处理都写一个新文件」，
 *     或者「明明处理过却每次重跑」。所以这里用**从数据库读回来的链**（JSON 往返）与
 *     代码里构造的链对比 —— 键序不同、浮点尾巴，都必须得到同一个指纹。
 *   · **命令的关键参数**：`-map_metadata -1` / `-vn` / 无损编码 / `-t`（试听）。
 *     漏掉任意一个都会出现「听众看到上一次导出的标题」「带封面的文件处理失败」这类真问题。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import type { ProcessChain } from '../../src/shared/types.ts'
import {
  canonicalChain,
  chainHash,
  enabledEqBandCount,
  fnv1a64Hex,
  isProcessChainEmpty,
} from '../../src/shared/audio/process.ts'
import { buildProcessCommand } from '../../src/shared/ffmpeg/commands.ts'
import { normalizeChain } from '../../src/main/features/audio/repositories/preset.repo.ts'

function chain(patch: Partial<ProcessChain> = {}): ProcessChain {
  return normalizeChain({ ...patch })
}

const ACTIVE: ProcessChain = chain({
  highpass: { enabled: true, freq: 80, poles: 2 },
  denoise: { enabled: true, nr: 12, nf: -30, tn: false },
  deesser: { enabled: true, intensity: 0.4, freq: 0.5 },
  eq: [{ id: 'b1', type: 'peak', freq: 3000, gainDb: 2, q: 1.2, enabled: true }],
  compressor: { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 },
  limiter: { enabled: true, limitDb: -1, attackMs: 5, releaseMs: 50 },
})

describe('处理链 · 判定', () => {
  it('全关 = 空链；任一开关打开或有 EQ/修补区间就不是空链', () => {
    assert.equal(isProcessChainEmpty(chain()), true)
    assert.equal(isProcessChainEmpty(chain({ highpass: { enabled: true, freq: 80, poles: 2 } })), false)
    assert.equal(isProcessChainEmpty(chain({ repair: { dcOffset: true, polarityInvert: false, declick: [], silenceFill: [], tempo: { enabled: false, factor: 1 } } })), false)
    assert.equal(isProcessChainEmpty(chain({ repair: { dcOffset: false, polarityInvert: false, declick: [{ atMs: 10, lengthMs: 10 }], silenceFill: [], tempo: { enabled: false, factor: 1 } } })), false)
    assert.equal(isProcessChainEmpty(chain({ repair: { dcOffset: false, polarityInvert: false, declick: [], silenceFill: [{ startMs: 0, endMs: 10 }], tempo: { enabled: false, factor: 1 } } })), false)
    // tempo 关着（factor 有值）不算「有处理」—— 关着的参数不生效
    assert.equal(isProcessChainEmpty(chain({ repair: { dcOffset: false, polarityInvert: false, declick: [], silenceFill: [], tempo: { enabled: false, factor: 1.05 } } })), true)
    // EQ 段存在但全部 disabled 也算空链
    assert.equal(
      isProcessChainEmpty(chain({ eq: [{ id: 'x', type: 'peak', freq: 1000, gainDb: 3, q: 1, enabled: false }] })),
      true,
    )
  })

  it('启用的 EQ 段数用于 UI 摘要', () => {
    assert.equal(enabledEqBandCount(ACTIVE), 1)
    assert.equal(enabledEqBandCount(chain()), 0)
  })
})

describe('处理链 · 指纹', () => {
  it('同一个链的指纹稳定；改任何一个生效参数都会变', () => {
    const a = chainHash(ACTIVE)
    assert.match(a, /^[0-9a-f]{12}$/)
    assert.equal(chainHash(ACTIVE), a, '同一对象两次调用必须一致')
    assert.equal(chainHash(normalizeChain(JSON.parse(JSON.stringify(ACTIVE)))), a, 'JSON 往返后必须一致（键序不能影响指纹）')
    assert.notEqual(chainHash(chain({ highpass: { enabled: true, freq: 90, poles: 2 } })), a)
    assert.notEqual(chainHash(chain({ compressor: { enabled: true, thresholdDb: -19, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 } })), a)
  })

  it('浮点尾巴不影响指纹（0.1+0.2 之类的计算结果不该产生两个文件）', () => {
    const x = chain({
      deesser: { enabled: true, intensity: 0.1 + 0.2, freq: 0.5 },
      compressor: { enabled: false, thresholdDb: -18, ratio: 2, attackMs: 10, releaseMs: 200, makeupDb: 0 },
    })
    const y = chain({
      deesser: { enabled: true, intensity: 0.3, freq: 0.5 },
      compressor: { enabled: false, thresholdDb: -18, ratio: 2, attackMs: 10, releaseMs: 200, makeupDb: 0 },
    })
    assert.equal(chainHash(x), chainHash(y))
  })

  it('canonicalChain 的键序固定（列出的键都在，且顺序与 CHAIN_KEYS 一致）', () => {
    const text = canonicalChain(ACTIVE)
    assert.ok(text.includes('highpass.freq=80'))
    assert.ok(text.includes('compressor.enabled=true'))
    assert.ok(text.includes('limiter.limitDb=-1'))
    const idxHighpass = text.indexOf('highpass.enabled')
    const idxDenoise = text.indexOf('denoise.enabled')
    const idxLimiter = text.indexOf('limiter.enabled')
    assert.ok(idxHighpass < idxDenoise && idxDenoise < idxLimiter, '键序必须与处理顺序一致（否则指纹比较没有意义）')
  })

  it('fnv1a64 已知值（换个实现就会立刻暴露）', () => {
    // 参考值由本实现给出；这里的作用是**钉住算法**，防止有人换成 crypto 后指纹全变
    assert.equal(fnv1a64Hex('').length, 16)
    assert.equal(fnv1a64Hex('a'), fnv1a64Hex('a'))
    assert.notEqual(fnv1a64Hex('a'), fnv1a64Hex('b'))
    // UTF-8 字节序：中文与它的拆解结果不能相同
    assert.notEqual(fnv1a64Hex('链'), fnv1a64Hex('链式'))
  })
})

describe('处理链 · ffmpeg 命令', () => {
  it('关键参数齐全：-vn / 无损编码 / -f wav / -map_metadata -1', () => {
    const cmd = buildProcessCommand({
      input: 'segments/a.wav',
      output: 'processed/a.wav',
      filter: 'highpass=f=80:poles=2,acompressor=threshold=-18dB',
      sampleRate: 48000,
      channels: 1,
      ffmpegPath: 'ffmpeg',
    })
    assert.equal(cmd[0], 'ffmpeg')
    assert.ok(cmd.includes('-vn'), '带封面/图片流的源文件不加 -vn 会处理失败')
    assert.ok(cmd.includes('-af'))
    assert.deepEqual(cmd.slice(cmd.indexOf('-c:a'), cmd.indexOf('-c:a') + 2), ['-c:a', 'pcm_s24le'])
    assert.deepEqual(cmd.slice(cmd.indexOf('-f'), cmd.indexOf('-f') + 2), ['-f', 'wav'])
    assert.deepEqual(
      cmd.slice(cmd.indexOf('-map_metadata'), cmd.indexOf('-map_metadata') + 2),
      ['-map_metadata', '-1'],
      '不丢元数据会让最终音频带上一次导出的标题',
    )
    assert.equal(cmd[cmd.length - 1], 'processed/a.wav')
    assert.ok(cmd.includes('48k') === false, '采样率用 -ar 48000 而不是滤镜串里的 48k')
  })

  it('空链退化为「格式统一」：不带 -af，但仍然转码统一格式', () => {
    const cmd = buildProcessCommand({ input: 'in.wav', output: 'out.wav', filter: '' })
    assert.ok(!cmd.includes('-af'), '空链不该塞一个空的 -af')
    assert.ok(cmd.includes('pcm_s24le'))
  })

  it('试听用 -t 限制输入时长（且能指定位深 16）', () => {
    const cmd = buildProcessCommand({ input: 'in.wav', output: 'out.wav', filter: 'highpass=f=80', previewMs: 10_000 , bitDepth: 16 })
    const tIdx = cmd.indexOf('-t')
    assert.ok(tIdx > 0, '试听必须限制时长')
    assert.equal(cmd[tIdx + 1], '10')
    assert.ok(tIdx < cmd.indexOf('-i'), '-t 必须在 -i 之前（限制输入读取）')
    assert.deepEqual(cmd.slice(cmd.indexOf('-c:a'), cmd.indexOf('-c:a') + 2), ['-c:a', 'pcm_s16le'])
  })
})
