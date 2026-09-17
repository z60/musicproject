/**
 * Novel Studio · 滤镜图构建单元测试
 * ============================================================================
 * 覆盖 docs/14 §3 §3.1 §9 与 docs/05 §7.2 §7.4：
 *   · 7 个内置预设的滤镜串**快照比对**（防止有人随手改参数/顺序）
 *   · 固定的处理顺序（修补前置 → 高通 → 降噪 → 去齿音 → EQ → 压缩 → 限幅 → 修补后置）
 *   · §3.1 三处参数单位：acompressor.makeup 用 dB→线性、alimiter.limit 是线性、afftdn 参数拼装
 *   · ★ 混音图必须含 `normalize=0` 与 `apad=whole_dur=`，且 adelay 必须写**两个**值
 *   · ducking 的 threshold 是线性 0~1（不是 dB）
 *   · BGM 轨：loop/fade/apad/atrim
 *
 * 运行：node --experimental-strip-types tests/shared/ffmpeg-filters.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AUDIO_DEFAULTS, BUILTIN_PRESETS, createEmptyChain } from '../../src/shared/constants.ts'
import { AppError } from '../../src/shared/errors.ts'
import {
  ACOMPRESSOR_MAKEUP_UNIT,
  buildAfftdnFilter,
  buildBusMixFilter,
  buildChainFilter,
  buildDuckingFilter,
  buildDuckingGraph,
  buildEqFilter,
  buildMixFilterGraph,
  buildMusicTrackFilters,
  buildProcessFilterGraph,
  duckRatioForAmount,
  limiterLimitLinear,
  makeupDbToLinear,
  resolveSoloMutes,
} from '../../src/shared/ffmpeg/filters.ts'
import type { DuckingConfig, MusicTrackConfig, ProcessChain } from '../../src/shared/types.ts'

/** 7 个内置预设的滤镜串快照（docs/14 §4.1 的起点参数，改动必须是有意的） */
const PRESET_SNAPSHOT: Record<string, string> = {
  'builtin:narration-male':
    'highpass=f=70:poles=2,afftdn=nr=10:nf=-30,deesser=i=0.3:f=0.5,' +
    'equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=2,' +
    'acompressor=threshold=-18dB:ratio=3:attack=8:release=180:makeup=1.258925,alimiter=limit=0.891251:attack=5:release=80',
  'builtin:character-female':
    'highpass=f=90:poles=2,afftdn=nr=8:nf=-32,deesser=i=0.5:f=0.5,' +
    'equalizer=f=400:t=q:w=1:g=-1.5,equalizer=f=6000:t=h:w=0.7:g=1.5,' +
    'acompressor=threshold=-20dB:ratio=2.5:attack=8:release=150:makeup=1.258925,alimiter=limit=0.891251:attack=5:release=80',
  'builtin:broadcast':
    'highpass=f=80:poles=2,afftdn=nr=12:nf=-28,deesser=i=0.5:f=0.5,' +
    'equalizer=f=200:t=q:w=1:g=-3,equalizer=f=3000:t=q:w=1.2:g=3,equalizer=f=8000:t=h:w=0.7:g=1.5,' +
    'acompressor=threshold=-16dB:ratio=4:attack=5:release=150:makeup=1.412538,alimiter=limit=0.891251:attack=5:release=80',
  'builtin:phone-rescue':
    'highpass=f=120:poles=2,afftdn=nr=18:nf=-26:tn=1,deesser=i=0.7:f=0.5,' +
    'equalizer=f=300:t=q:w=1:g=-4,equalizer=f=2500:t=q:w=1.2:g=3,' +
    'acompressor=threshold=-15dB:ratio=4:attack=5:release=120:makeup=1.412538,alimiter=limit=0.891251:attack=5:release=80',
  'builtin:asmr':
    'highpass=f=100:poles=2,afftdn=nr=6:nf=-36,deesser=i=0.2:f=0.5,' +
    'equalizer=f=5000:t=q:w=0.8:g=2,acompressor=threshold=-22dB:ratio=2:attack=15:release=250:makeup=1.122018,' +
    'alimiter=limit=0.891251:attack=5:release=80',
  'builtin:old-tape':
    'highpass=f=150:poles=2,afftdn=nr=14:nf=-24:tn=1,deesser=i=0.8:f=0.55,' +
    'equalizer=f=350:t=q:w=1:g=-2,equalizer=f=7000:t=q:w=1:g=-1,equalizer=f=2000:t=q:w=1:g=1.5,' +
    'acompressor=threshold=-18dB:ratio=3:attack=8:release=180:makeup=1.258925,alimiter=limit=0.891251:attack=5:release=80',
  'builtin:trim-only': 'alimiter=limit=0.891251:attack=5:release=80',
}

const DUCKING: DuckingConfig = {
  enabled: true,
  amountDb: -12,
  thresholdDb: -30,
  attackMs: 20,
  releaseMs: 400,
  mode: 'sidechain',
}

// ---------------------------------------------------------------------------
// 预设快照
// ---------------------------------------------------------------------------

describe('滤镜链：7 个内置预设快照', () => {
  it('内置预设数量为 7（与 docs/14 §4.1 表格一致）', () => {
    assert.equal(BUILTIN_PRESETS.length, 7)
  })

  for (const preset of BUILTIN_PRESETS) {
    it(`${preset.name}（${preset.id}）滤镜串与快照完全一致`, () => {
      const expected = PRESET_SNAPSHOT[preset.id]
      assert.ok(expected !== undefined, `快照缺少 ${preset.id}`)
      assert.equal(buildChainFilter(preset.chain), expected)
    })
  }

  it('「仅修剪」预设不启用任何处理模块，只做限幅（-1 dBFS）', () => {
    const trimOnly = BUILTIN_PRESETS.find(p => p.id === 'builtin:trim-only')!
    assert.equal(trimOnly.chain.highpass.enabled, false)
    assert.equal(trimOnly.chain.denoise.enabled, false)
    assert.equal(trimOnly.chain.eq.length, 0)
    assert.equal(buildChainFilter(trimOnly.chain), 'alimiter=limit=0.891251:attack=5:release=80')
  })

  it('全关的处理链返回空串（调用方据此走「仅格式统一」路径）', () => {
    const chain = createEmptyChain()
    chain.limiter.enabled = false
    assert.equal(buildChainFilter(chain), '')
  })
})

// ---------------------------------------------------------------------------
// 顺序与单位
// ---------------------------------------------------------------------------

describe('滤镜链：固定顺序（docs/14 §2.1）', () => {
  const fullChain = (): ProcessChain => {
    const c = createEmptyChain()
    c.repair.dcOffset = true
    c.repair.polarityInvert = true
    c.highpass = { enabled: true, freq: 80, poles: 2 }
    c.denoise = { enabled: true, nr: 12, nf: -30, tn: true }
    c.deesser = { enabled: true, intensity: 0.5, freq: 0.5 }
    c.eq = [{ id: 'e1', type: 'peak', freq: 3000, gainDb: 2.5, q: 1.2, enabled: true }]
    c.compressor = { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 }
    c.limiter = { enabled: true, limitDb: -1, attackMs: 5, releaseMs: 80 }
    c.repair.declick = [{ atMs: 1500, lengthMs: 10 }]
    c.repair.silenceFill = [{ startMs: 2000, endMs: 2500 }]
    c.repair.tempo = { enabled: true, factor: 1.05 }
    return c
  }

  it('修补前置 → 高通 → 降噪 → 去齿音 → EQ → 压缩 → 限幅 → 修补后置', () => {
    const f = buildChainFilter(fullChain()).split(',')
    const idx = (prefix: string): number => f.findIndex(x => x.startsWith(prefix))
    assert.ok(idx('highpass=f=10') === 0, '去 DC 必须在最前面')
    assert.equal(idx('aeval'), 1, '极性反转紧随其后')
    assert.ok(idx('highpass=f=80') > idx('aeval'), '高通在修补前置之后')
    assert.ok(idx('afftdn') > idx('highpass=f=80'), '降噪在高通之后')
    assert.ok(idx('deesser') > idx('afftdn'), '去齿音在降噪之后')
    assert.ok(idx('equalizer') > idx('deesser'), 'EQ 在去齿音之后')
    assert.ok(idx('acompressor') > idx('equalizer'), '压缩在 EQ 之后')
    assert.ok(idx('alimiter') > idx('acompressor'), '限幅在压缩之后')
    assert.ok(idx('volume=enable') > idx('alimiter'), 'declick/silenceFill 门控在限幅之后')
    assert.equal(idx('atempo'), f.length - 1, '变速是最后一步')
    assert.match(f[f.length - 1] as string, /^atempo=1\.05$/)
  })

  it('降噪必须在压缩之前 —— 顺序反了会「把噪声抬起来再降」（docs/14 §2.1）', () => {
    const f = buildChainFilter(fullChain())
    assert.ok(f.indexOf('afftdn') < f.indexOf('acompressor'))
  })

  it('修补后置门控：declick / silenceFill 用区间置零，且时间用秒', () => {
    const f = buildChainFilter(fullChain())
    assert.ok(f.includes("volume=enable='between(t,1.5,1.51)':volume=0"), 'declick 1.5 s 起 10 ms')
    assert.ok(f.includes("volume=enable='between(t,2,2.5)':volume=0"), 'silenceFill 2~2.5 s')
  })

  it('declick/silenceFill 可通过 includeRepairGates=false 关闭（PCM 域修补时）', () => {
    const f = buildChainFilter(fullChain(), { includeRepairGates: false })
    assert.ok(!f.includes('volume=enable'))
    assert.ok(f.includes('atempo'))
  })
})

describe('滤镜链：三处必须实测确认的参数（docs/14 §3.1）', () => {
  it('acompressor 的 makeup 按 dB→线性换算（makeupDb=2 → 1.2589）', () => {
    assert.equal(ACOMPRESSOR_MAKEUP_UNIT, 'linear')
    assert.ok(Math.abs(makeupDbToLinear(2) - 1.258925) < 1e-6)
    assert.ok(Math.abs(makeupDbToLinear(3) - 1.412538) < 1e-6)
    const c = createEmptyChain()
    c.limiter.enabled = false
    c.compressor = { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 }
    assert.equal(buildChainFilter(c), 'acompressor=threshold=-18dB:ratio=3:attack=8:release=180:makeup=1.258925')
  })

  it('makeupDb=0 时不输出 makeup 参数（避免无意义参数）', () => {
    const c = createEmptyChain()
    c.limiter.enabled = false
    c.compressor = { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 0 }
    assert.equal(buildChainFilter(c), 'acompressor=threshold=-18dB:ratio=3:attack=8:release=180')
  })

  it('若现场实测发现某个构建的 makeup 是 dB，可切到 makeupUnit=db', () => {
    const c = createEmptyChain()
    c.limiter.enabled = false
    c.compressor = { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 }
    assert.match(buildChainFilter(c, { makeupUnit: 'db' }), /makeup=2dB$/)
  })

  it('alimiter 的 limit 是线性值：-1 dBFS → 0.891251（不是 -1）', () => {
    assert.ok(Math.abs(limiterLimitLinear(-1) - 0.891251) < 1e-6)
    const c = createEmptyChain()
    assert.equal(buildChainFilter(c), 'alimiter=limit=0.891251:attack=5:release=80')
    c.limiter.limitDb = -3
    assert.ok(Math.abs(limiterLimitLinear(-3) - 0.707946) < 1e-6)
  })

  it('afftdn 参数拼装：nr/nf，tn 为真时补 tn=1', () => {
    assert.equal(buildAfftdnFilter({ enabled: true, nr: 12, nf: -30, tn: false }), 'afftdn=nr=12:nf=-30')
    assert.equal(buildAfftdnFilter({ enabled: true, nr: 18, nf: -26, tn: true }), 'afftdn=nr=18:nf=-26:tn=1')
  })

  it('参数越界一律夹紧（nr 上限 97、nf 范围 -80~-20），绝不产生非法滤镜串', () => {
    assert.equal(buildAfftdnFilter({ enabled: true, nr: 999, nf: -200, tn: false }), 'afftdn=nr=97:nf=-80')
  })

  it('EQ 段映射：peak→t=q、lowshelf→t=l、highshelf→t=h、lowpass/highpass 直出', () => {
    assert.equal(buildEqFilter({ id: '1', type: 'peak', freq: 3000, gainDb: 2.5, q: 1.2, enabled: true }), 'equalizer=f=3000:t=q:w=1.2:g=2.5')
    assert.equal(buildEqFilter({ id: '2', type: 'lowshelf', freq: 200, gainDb: -3, q: 1, enabled: true }), 'equalizer=f=200:t=l:w=1:g=-3')
    assert.equal(buildEqFilter({ id: '3', type: 'highshelf', freq: 8000, gainDb: 1.5, q: 0.7, enabled: true }), 'equalizer=f=8000:t=h:w=0.7:g=1.5')
    assert.equal(buildEqFilter({ id: '4', type: 'lowpass', freq: 12000, gainDb: 0, q: 1, enabled: true }), 'lowpass=f=12000')
    assert.equal(buildEqFilter({ id: '5', type: 'highpass', freq: 60, gainDb: 0, q: 1, enabled: true }), 'highpass=f=60:poles=1')
  })

  it('disabled 的 EQ 段被跳过（用户可保留但不生效）', () => {
    const c = createEmptyChain()
    c.limiter.enabled = false
    c.eq = [
      { id: 'on', type: 'peak', freq: 1000, gainDb: 2, q: 1, enabled: true },
      { id: 'off', type: 'peak', freq: 2000, gainDb: -2, q: 1, enabled: false },
    ]
    assert.equal(buildChainFilter(c), 'equalizer=f=1000:t=q:w=1:g=2')
  })
})

describe('滤镜链：内部工作格式统一（docs/14 §3.2）', () => {
  it('处理图先 aresample → aformat(s32/mono) → 处理链', () => {
    const c = createEmptyChain()
    const g = buildProcessFilterGraph({ chain: c })
    assert.ok(g.startsWith(`aresample=${AUDIO_DEFAULTS.sampleRate},aformat=sample_fmts=s32:channel_layouts=mono`))
    assert.ok(g.endsWith('alimiter=limit=0.891251:attack=5:release=80'))
  })

  it('立体声输出时 channel_layouts=stereo', () => {
    const g = buildProcessFilterGraph({ chain: createEmptyChain(), channels: 2, sampleRate: 44100 })
    assert.ok(g.includes('aresample=44100'))
    assert.ok(g.includes('channel_layouts=stereo'))
  })
})

// ---------------------------------------------------------------------------
// 混音图（★ 三个致命参数）
// ---------------------------------------------------------------------------

describe('混音图：三个「漏了就出大问题」的参数（docs/05 §7.2）', () => {
  const items = Array.from({ length: 3 }, (_, i) => ({
    inputIndex: i,
    srcInMs: 100,
    srcOutMs: 1100,
    timelineStartMs: 1500 + i * 1000,
    fadeInMs: 5,
    fadeOutMs: 5,
  }))

  it('★ 必须有 amix=normalize=0（不加会音量暴跌）', () => {
    const g = buildMixFilterGraph({ items, chapterDurationMs: 60_000 })
    assert.ok(g.includes('amix=inputs=3:normalize=0:dropout_transition=0'), g)
    assert.ok(g.includes('normalize=0'))
  })

  it('★ 每条流都必须 apad=whole_dur=章节总长（不加只出前几秒）', () => {
    const g = buildMixFilterGraph({ items, chapterDurationMs: 60_000 })
    const apads = g.split('apad=whole_dur=60').length - 1
    assert.equal(apads, 3, '每个 item 都要补到章节总长')
    assert.ok(g.includes('apad=whole_dur=60[a0]'), 'apad 必须在 item 流的最末尾')
  })

  it('★ adelay 必须写两个值（单声道也写），写一个在某些版本只作用于第一声道', () => {
    const g = buildMixFilterGraph({ items, chapterDurationMs: 60_000 })
    assert.ok(g.includes('adelay=1500|1500'), g)
    assert.ok(g.includes('adelay=2500|2500'))
    assert.ok(g.includes('adelay=3500|3500'))
    // 不允许出现只有一个值的 adelay
    assert.ok(!/adelay=\d+(?!\|)/.test(g.replace(/adelay=(\d+)\|\1/g, 'ADELAY_OK')), '存在单值 adelay：' + g)
  })

  it('item 流顺序：atrim → asetpts → afade → volume → adelay → apad', () => {
    const g = buildMixFilterGraph({
      items: [{ inputIndex: 0, srcInMs: 100, srcOutMs: 1100, timelineStartMs: 500, fadeInMs: 5, fadeOutMs: 10, gainDb: -3 }],
      chapterDurationMs: 10_000,
    })
    assert.match(
      g,
      /\[0:a\]atrim=start=0\.1:end=1\.1,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0\.005,afade=t=out:st=0\.99:d=0\.01,volume=-3dB,adelay=500\|500,apad=whole_dur=10\[a0\]/,
    )
  })

  it('分批：33 个 item → 2 组（32 + 1）→ 第 3 层再 amix 一次', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
      inputIndex: i,
      srcInMs: 0,
      srcOutMs: 1000,
      timelineStartMs: i * 100,
      fadeInMs: 0,
      fadeOutMs: 0,
    }))
    const g = buildMixFilterGraph({ items: many, chapterDurationMs: 10_000 })
    assert.ok(g.includes('amix=inputs=32:normalize=0:dropout_transition=0[g0]'), '第 1 组 32 个')
    assert.ok(g.includes('[a32]anull[g1]'), '第 2 组只有 1 个 → anull 重命名')
    assert.ok(g.includes('[g0][g1]amix=inputs=2:normalize=0:dropout_transition=0'), '第 3 层合并各组')
    assert.ok(g.endsWith('[voice]'))
  })

  it('分批大小可配置（AUDIO_DEFAULTS.mixBatchSize = 32）', () => {
    assert.equal(AUDIO_DEFAULTS.mixBatchSize, 32)
    const g = buildMixFilterGraph({
      items: Array.from({ length: 4 }, (_, i) => ({
        inputIndex: i,
        srcInMs: 0,
        srcOutMs: 1000,
        timelineStartMs: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
      })),
      chapterDurationMs: 1000,
      batchSize: 2,
    })
    assert.ok(g.includes('amix=inputs=2:normalize=0:dropout_transition=0[g0]'))
    assert.ok(g.includes('amix=inputs=2:normalize=0:dropout_transition=0[g1]'))
  })

  it('空 items：返回合法占位图（调用方应先抛 MIX_ARRANGEMENT_EMPTY）', () => {
    const g = buildMixFilterGraph({ items: [], chapterDurationMs: 5000 })
    assert.ok(g.includes('anullsrc'))
    assert.ok(g.endsWith('[voice]'))
  })

  it('章首静音会叠加到 adelay 上', () => {
    const g = buildMixFilterGraph({
      items: [{ inputIndex: 0, srcInMs: 0, srcOutMs: 1000, timelineStartMs: 1000, fadeInMs: 0, fadeOutMs: 0 }],
      chapterDurationMs: 10_000,
      headSilenceMs: 500,
    })
    assert.ok(g.includes('adelay=1500|1500'))
  })

  it('总线混音同样必须 normalize=0，并可选主总线限幅', () => {
    const g = buildBusMixFilter({
      buses: [{ label: 'voice' }, { label: 'music', gainDb: -18 }, { label: 'sfx' }],
      masterGainDb: -1,
      limiter: { enabled: true, limitDb: -1, attackMs: 5, releaseMs: 80 },
    })
    assert.ok(g.includes('amix=inputs=3:normalize=0:dropout_transition=0'))
    assert.ok(g.includes('volume=-18dB'))
    assert.ok(g.includes('alimiter=limit=0.891251:attack=5:release=80'))
    assert.ok(g.endsWith('[mixed]'))
  })
})

// ---------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------

describe('Ducking：sidechaincompress（docs/05 §7.5 / docs/14 §9）', () => {
  it('★ threshold 必须是线性 0~1：-30 dB → 0.031623（不是 -30）', () => {
    const f = buildDuckingFilter(DUCKING)
    assert.ok(f.startsWith('sidechaincompress='))
    assert.ok(f.includes('threshold=0.031623'), f)
    assert.ok(!f.includes('dB'), 'threshold 用 dB 是「BGM 永不下潜」的根因，绝不能出现 dB 单位')
    assert.ok(f.includes('ratio=8'), '默认 ratio 8（docs 建议 6~12）')
    assert.ok(f.includes('attack=20'))
    assert.ok(f.includes('release=400'))
    assert.ok(f.includes('makeup=1'), '增益统一在轨道级处理')
    assert.ok(f.includes('level_sc=1'))
  })

  it('由下潜量反推 ratio：threshold=-30、amount=-12 → ≈1.667', () => {
    assert.ok(Math.abs(duckRatioForAmount(-12, -30) - 1.6667) < 0.01)
    assert.equal(duckRatioForAmount(-30, -30), 8, '参数不合理时退回默认 8')
    const f = buildDuckingFilter(DUCKING, { deriveRatioFromAmount: true })
    assert.ok(f.includes('ratio=1.6667'), f)
  })

  it('完整子图：[music][voice]sidechaincompress…[ducked]', () => {
    const g = buildDuckingGraph({
      musicLabel: 'music',
      sidechainLabel: 'voice',
      outputLabel: 'ducked',
      config: DUCKING,
    })
    assert.match(g, /^\[music\]\[voice\]sidechaincompress=.*\[ducked\]$/)
  })

  it('未启用 ducking 时只做重命名（不引入侧链，避免多一条空输入）', () => {
    const g = buildDuckingGraph({
      musicLabel: 'music',
      sidechainLabel: 'voice',
      outputLabel: 'ducked',
      config: { ...DUCKING, enabled: false },
    })
    assert.equal(g, '[music]anull[ducked]')
  })

  it('Solo 语义：任一轮轨 solo 时其他轨静音，但侧链源（人声总线）始终有效', () => {
    const r = resolveSoloMutes([
      { id: 'narration', kind: 'voice', isMute: false, isSolo: true },
      { id: 'char-a', kind: 'voice', isMute: false, isSolo: false },
      { id: 'bgm', kind: 'music', isMute: false, isSolo: false },
    ])
    assert.equal(r.anySolo, true)
    assert.deepEqual(r.audible, ['narration'])
    assert.deepEqual(r.muted, ['char-a', 'bgm'])
    assert.equal(r.sidechainSourceActive, true, '侧链源必须在场，否则 ducking 失效')
  })

  it('无 solo 时按各自 mute 生效', () => {
    const r = resolveSoloMutes([
      { id: 'narration', kind: 'voice', isMute: false, isSolo: false },
      { id: 'bgm', kind: 'music', isMute: true, isSolo: false },
    ])
    assert.equal(r.anySolo, false)
    assert.deepEqual(r.audible, ['narration'])
    assert.deepEqual(r.muted, ['bgm'])
  })
})

// ---------------------------------------------------------------------------
// BGM / 音效轨
// ---------------------------------------------------------------------------

describe('BGM 轨滤镜：loop / fade / apad / atrim（docs/05 §7.4）', () => {
  const config = (partial: Partial<MusicTrackConfig> = {}): MusicTrackConfig => ({
    assetId: 'asset-1',
    startMs: 5000,
    endMs: 25_000,
    loop: false,
    fadeInMs: 2000,
    fadeOutMs: 3000,
    ducking: DUCKING,
    ...partial,
  })

  it('atrim 窗口 → asetpts → fade in/out → apad 到章节总长', () => {
    const f = buildMusicTrackFilters(config(), 60_000)
    // 窗口 5~25 s（长 20 s）；淡入 2 s；淡出 3 s → st = 20 - 3 = 17 s
    assert.match(
      f,
      /^atrim=start=0:end=20,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=2,afade=t=out:st=17:d=3,apad=whole_dur=60$/,
    )
  })

  it('endMs=null → 到章节结束', () => {
    const f = buildMusicTrackFilters(config({ endMs: null }), 60_000)
    assert.ok(f.includes('atrim=start=0:end=55'), f)
  })

  it('loop=true 必须提供源样本数，否则抛 FILTER_UNSUPPORTED（aloop 需要 size）', () => {
    assert.throws(
      () => buildMusicTrackFilters(config({ loop: true }), 60_000),
      (e: unknown) => e instanceof AppError && e.key === 'FILTER_UNSUPPORTED',
    )
    const f = buildMusicTrackFilters(config({ loop: true }), 60_000, { sourceFrames: 1_323_000 })
    assert.ok(f.startsWith('aloop=loop=-1:size=1323000,'), f)
    assert.ok(f.includes('atrim=start=0:end=20'), 'loop 之后必须按窗口裁剪')
  })

  it('轨道增益与 padToChapter 开关', () => {
    const f = buildMusicTrackFilters(config(), 60_000, { gainDb: -18 })
    assert.ok(f.includes('volume=-18dB'))
    const noPad = buildMusicTrackFilters(config(), 60_000, { padToChapter: false })
    assert.ok(!noPad.includes('apad'))
  })

  it('淡入淡出为 0 时不输出 afade（避免无意义滤镜）', () => {
    const f = buildMusicTrackFilters(config({ fadeInMs: 0, fadeOutMs: 0 }), 60_000)
    assert.ok(!f.includes('afade'))
  })

  it('atrim 必须在 apad 之前（否则补出来的静音会被截掉）', () => {
    const f = buildMusicTrackFilters(config(), 60_000)
    assert.ok(f.indexOf('atrim') < f.indexOf('apad'))
  })
})
