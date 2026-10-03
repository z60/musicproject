/**
 * Novel Studio · ffmpeg 命令构建单元测试
 * ============================================================================
 * 覆盖 docs/05 §8 §9 与 docs/15 §5：
 *   · 分章导出 MP3/WAV/M4A（-write_xing 1、-id3v2_version 3、元数据、封面 attached_pic）
 *   · 两遍法响度：measure（loudnorm print_format=json -f null -）/ apply（volume + alimiter 线性 limit）
 *   · ★ M4B：`-map_metadata 1` 与 `-map_chapters 1` 必须同时存在，且 `+faststart`
 *   · ★ ffmetadata 章节严格连续无缝、毫秒整数、TIMEBASE=1/1000
 *   · concat 列表：正斜杠 + 单引号转义 `'\''`
 *   · `-progress pipe:1` 解析
 *
 * 运行：node --experimental-strip-types tests/shared/ffmpeg-commands.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  buildChapterExportCommand,
  buildDecodeToWavCommand,
  buildDurationProbeCommand,
  buildLoudnessApplyCommand,
  buildLoudnessMeasureCommand,
  buildLoudnessVerifyCommand,
  buildM4bCommand,
  buildM4bProbeCommand,
  buildMixRenderCommand,
  commandIncludes,
  escapeFfmetadataValue,
  formatCommandForDisplay,
  generateConcatList,
  generateFfmetadata,
  metadataPairs,
  parseConcatList,
  parseFfmetadata,
  verifyChapterContinuity,
  withProgress,
} from '../../src/shared/ffmpeg/commands.ts'
import {
  REQUIRED_FILTERS,
  buildFfmpegCapabilities,
  computeCapabilities,
  parseAstats,
  parseEncoders,
  parseFfprobeJson,
  parseFilters,
  parseFfmpegTimeToUs,
  parseProgress,
  parseProgressOutput,
  parseVersion,
} from '../../src/shared/ffmpeg/parse.ts'

/** 取某个参数后面的值（命令数组是成对出现的） */
function valueOf(cmd: string[], flag: string): string | undefined {
  const i = cmd.indexOf(flag)
  return i >= 0 ? cmd[i + 1] : undefined
}

function allValuesOf(cmd: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < cmd.length - 1; i++) if (cmd[i] === flag) out.push(cmd[i + 1] as string)
  return out
}

// ---------------------------------------------------------------------------
// 分章导出
// ---------------------------------------------------------------------------

describe('命令构建：分章导出（docs/05 §9.1）', () => {
  const baseInput = {
    input: 'C:/tmp/chapter-1.wav',
    output: 'C:/out/001_第1章 陨落的天才.mp3',
    format: 'mp3' as const,
    metadata: { title: '第1章 陨落的天才', artist: '天蚕土豆', album: '斗破苍穹', narrator: '旁白君', date: '2026' },
    chapterIndex: 1,
    chapterTotal: 120,
  }

  it('MP3：libmp3lame / 192k / 44.1k / -write_xing 1 / -id3v2_version 3', () => {
    const cmd = buildChapterExportCommand(baseInput)
    assert.equal(cmd[0], 'ffmpeg')
    assert.equal(valueOf(cmd, '-c:a'), 'libmp3lame')
    assert.equal(valueOf(cmd, '-b:a'), '192k')
    assert.equal(valueOf(cmd, '-ar'), '44100')
    assert.equal(valueOf(cmd, '-ac'), '1')
    // 这两项漏了就是「时长显示不准 / 标签读不出」
    assert.equal(valueOf(cmd, '-write_xing'), '1')
    assert.equal(valueOf(cmd, '-id3v2_version'), '3')
    assert.equal(cmd[cmd.length - 1], baseInput.output, '输出文件必须是最后一个参数')
  })

  it('MP3 元数据：title/artist/album/album_artist/track/genre/comment', () => {
    const cmd = buildChapterExportCommand(baseInput)
    const meta = allValuesOf(cmd, '-metadata')
    assert.ok(meta.includes('title=第1章 陨落的天才'))
    assert.ok(meta.includes('artist=天蚕土豆'))
    assert.ok(meta.includes('album=斗破苍穹'))
    assert.ok(meta.includes('album_artist=旁白君'))
    assert.ok(meta.includes('track=1/120'), 'track 必须是 序号/总数')
    assert.ok(meta.includes('genre=Audiobook'))
    assert.ok(meta.includes('date=2026'))
  })

  it('MP3 + 封面：以 attached_pic 方式嵌入（-map 1:v -c:v copy -disposition:v attached_pic）', () => {
    const cmd = buildChapterExportCommand({ ...baseInput, coverPath: 'C:/out/cover.jpg' })
    assert.equal(cmd[cmd.indexOf('C:/out/cover.jpg') - 1], '-i')
    assert.deepEqual(allValuesOf(cmd, '-map'), ['0:a', '1:v'])
    assert.equal(valueOf(cmd, '-c:v'), 'copy')
    assert.equal(valueOf(cmd, '-disposition:v'), 'attached_pic')
  })

  it('无封面时不引入第二个输入（避免空 map 导致失败）', () => {
    const cmd = buildChapterExportCommand(baseInput)
    assert.equal(allValuesOf(cmd, '-map').length, 0)
    assert.ok(!cmd.includes('-disposition:v'))
  })

  it('WAV：pcm_s24le（不重编码为有损）', () => {
    const cmd = buildChapterExportCommand({ ...baseInput, format: 'wav', output: 'C:/out/001.wav' })
    assert.equal(valueOf(cmd, '-c:a'), 'pcm_s24le')
    assert.ok(!cmd.includes('-write_xing'))
  })

  it('M4A：aac + faststart（moov 前置）', () => {
    const cmd = buildChapterExportCommand({ ...baseInput, format: 'm4a', output: 'C:/out/001.m4a' })
    assert.equal(valueOf(cmd, '-c:a'), 'aac')
    assert.equal(valueOf(cmd, '-movflags'), '+faststart')
    assert.equal(valueOf(cmd, '-b:a'), '192k')
  })

  it('线程限制与响度滤镜可注入', () => {
    const cmd = buildChapterExportCommand({
      ...baseInput,
      threadCount: 4,
      audioFilters: 'volume=-1.2dB,alimiter=limit=0.891251',
    })
    assert.equal(valueOf(cmd, '-threads'), '4')
    assert.equal(valueOf(cmd, '-af'), 'volume=-1.2dB,alimiter=limit=0.891251')
  })

  it('metadataPairs 顺序稳定且省略空值', () => {
    const pairs = metadataPairs({ title: 'T', genre: '' }, 3, 10)
    assert.deepEqual(pairs[0], ['title', 'T'])
    assert.ok(pairs.some(([k, v]) => k === 'track' && v === '3/10'))
    assert.ok(pairs.some(([k, v]) => k === 'genre' && v === 'Audiobook'), 'genre 缺省为 Audiobook')
  })

  it('formatCommandForDisplay 让含空格的参数可复制到终端', () => {
    const text = formatCommandForDisplay(['ffmpeg', '-i', 'C:/a b/c.wav', 'C:/out/001_第1章.mp3'])
    assert.ok(text.includes('"C:/a b/c.wav"'))
  })
})

// ---------------------------------------------------------------------------
// 解码为 WAV（导入外来音频）
// ---------------------------------------------------------------------------

describe('命令构建：解码为 WAV（导入 mp3 等外来音频）', () => {
  const base = { input: 'C:/samples/2221-2230-石玉凤-德钦.mp3', output: 'C:/proj/imports/x.wav' }

  it('默认输出 48 kHz / 单声道 / 16 位 PCM', () => {
    const cmd = buildDecodeToWavCommand(base)
    assert.equal(valueOf(cmd, '-ar'), '48000')
    assert.equal(valueOf(cmd, '-ac'), '1')
    assert.equal(valueOf(cmd, '-c:a'), 'pcm_s16le')
    assert.equal(cmd[cmd.length - 1], base.output)
    assert.equal(cmd[0], 'ffmpeg')
  })

  /**
   * 这三条是「漏了就会在真机上出问题」的参数，单独立用例钉住。
   * 详见 `buildDecodeToWavCommand` 的注释。
   */
  it('-vn 丢掉封面流（mp3 常带 attached_pic，不丢会让 -c:a 选择失败）', () => {
    assert.ok(buildDecodeToWavCommand(base).includes('-vn'))
  })

  it('-map 0:a:0 只取第一条音频流（真机样本里有多流文件）', () => {
    const cmd = buildDecodeToWavCommand(base)
    assert.equal(valueOf(cmd, '-map'), '0:a:0')
  })

  it('-map_metadata -1 不带源文件元数据（ID3 会污染项目内文件）', () => {
    const cmd = buildDecodeToWavCommand(base)
    assert.equal(valueOf(cmd, '-map_metadata'), '-1')
  })

  it('24 位与 2 声道可显式指定', () => {
    const cmd = buildDecodeToWavCommand({ ...base, bitDepth: 24, channels: 2, sampleRate: 44100 })
    assert.equal(valueOf(cmd, '-c:a'), 'pcm_s24le')
    assert.equal(valueOf(cmd, '-ac'), '2')
    assert.equal(valueOf(cmd, '-ar'), '44100')
  })

  it('默认覆盖已有文件（-y），显式传 overwrite:false 时不加', () => {
    assert.ok(buildDecodeToWavCommand(base).includes('-y'))
    assert.ok(!buildDecodeToWavCommand({ ...base, overwrite: false }).includes('-y'))
  })
})

// ---------------------------------------------------------------------------
// 响度
// ---------------------------------------------------------------------------

describe('命令构建：两遍法响度（docs/05 §8.1）', () => {
  it('Pass 1 测量：loudnorm=I=..:TP=..:LRA=..:print_format=json -f null -', () => {
    const cmd = buildLoudnessMeasureCommand({ input: 'mixed.wav', targetLufs: -16, truePeakDb: -1, lra: 11 })
    assert.equal(valueOf(cmd, '-af'), 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json')
    assert.equal(valueOf(cmd, '-f'), 'null')
    assert.equal(cmd[cmd.length - 1], '-', '必须输出到 null muxer')
    assert.ok(!cmd.includes('-y'), '测量不产出文件，不需要 -y')
  })

  it('Pass 2 施加：volume=增益dB + alimiter（limit 为线性值 0.891251）', () => {
    const cmd = buildLoudnessApplyCommand({ input: 'mixed.wav', output: 'norm.wav', gainDb: -3.4, truePeakDb: -1 })
    assert.equal(valueOf(cmd, '-af'), 'volume=-3.4dB,alimiter=limit=0.891251:attack=5:release=80')
    assert.equal(valueOf(cmd, '-c:a'), 'pcm_s24le')
    assert.equal(cmd[cmd.length - 1], 'norm.wav')
  })

  it('Pass 2 用线性 volume 而不是 loudnorm 第二遍（docs/05 §8.1 的核心决策）', () => {
    const cmd = buildLoudnessApplyCommand({ input: 'a.wav', output: 'b.wav', gainDb: 4 })
    const af = valueOf(cmd, '-af') as string
    assert.ok(af.startsWith('volume=4dB,'))
    assert.ok(!af.includes('loudnorm'))
  })

  it('Pass 3 复核命令与 Pass 1 一致（偏差 > 0.5 LU 时微调一次）', () => {
    const p1 = buildLoudnessMeasureCommand({ input: 'out.wav', targetLufs: -16, truePeakDb: -1, lra: 11 })
    const p3 = buildLoudnessVerifyCommand({ input: 'out.wav', targetLufs: -16, truePeakDb: -1, lra: 11 })
    assert.deepEqual(p3, p1)
  })

  it('真峰目标可改（-14 LUFS 流媒体目标时仍是 TP=-1）', () => {
    const cmd = buildLoudnessMeasureCommand({ input: 'a.wav', targetLufs: -14, truePeakDb: -1, lra: 11 })
    assert.equal(valueOf(cmd, '-af'), 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json')
    const apply = buildLoudnessApplyCommand({ input: 'a.wav', output: 'b.wav', gainDb: 1, truePeakDb: -0.5 })
    assert.ok((valueOf(apply, '-af') as string).includes('alimiter=limit=0.944061'))
  })
})

// ---------------------------------------------------------------------------
// M4B
// ---------------------------------------------------------------------------

describe('命令构建：M4B 合并（docs/05 §9.2 / docs/15 §5.2）', () => {
  it('★ 必须同时有 -map_metadata 1 与 -map_chapters 1（否则章节全丢）', () => {
    const cmd = buildM4bCommand({
      listFile: 'list.txt',
      metadataFile: 'chapters.txt',
      output: '斗破苍穹.m4b',
    })
    assert.equal(valueOf(cmd, '-map_metadata'), '1')
    assert.equal(valueOf(cmd, '-map_chapters'), '1')
    assert.ok(cmd.indexOf('-map_chapters') > cmd.indexOf('chapters.txt'), 'map 参数必须在输入之后')
  })

  it('★ -movflags +faststart 与 aac/96k/44.1k/单声道', () => {
    const cmd = buildM4bCommand({ listFile: 'list.txt', metadataFile: 'chapters.txt', output: 'out.m4b' })
    assert.equal(valueOf(cmd, '-movflags'), '+faststart')
    assert.equal(valueOf(cmd, '-c:a'), 'aac')
    assert.equal(valueOf(cmd, '-b:a'), '96k')
    assert.equal(valueOf(cmd, '-ar'), '44100')
    assert.equal(valueOf(cmd, '-ac'), '1')
    assert.equal(cmd[cmd.length - 1], 'out.m4b')
  })

  it('concat demuxer 参数：-f concat -safe 0', () => {
    const cmd = buildM4bCommand({ listFile: 'list.txt', metadataFile: 'chapters.txt', output: 'out.m4b' })
    assert.equal(valueOf(cmd, '-f'), 'concat')
    assert.equal(valueOf(cmd, '-safe'), '0')
  })

  it('M4B 验收：ffprobe 读章节与容器', () => {
    const cmd = buildM4bProbeCommand({ file: 'out.m4b' })
    assert.equal(cmd[0], 'ffprobe')
    assert.ok(cmd.includes('-show_chapters'))
    assert.ok(cmd.includes('-show_format'))
  })

  it('时长探测：第一项必须是程序名 ffprobe，不能直接从 -v 起头', () => {
    const cmd = buildDurationProbeCommand({ file: 'take.mp3' })
    // 第一项是程序名：`FfmpegRunner.execute` 按它分派二进制（ffprobe）。
    // 曾经这里手写成「从 -v 开始」，spawn('-v') ENOENT 后被 catch 吞成 null ——
    // 断言这一条，静默失败就再也回不来了。
    assert.equal(cmd[0], 'ffprobe')
    assert.equal(cmd[cmd.length - 1], 'take.mp3')
    assert.equal(valueOf(cmd, '-show_entries'), 'format=duration')
  })

  it('时长探测：显式给的 ffprobePath 优先于裸名字', () => {
    const cmd = buildDurationProbeCommand({ file: 'take.mp3', ffprobePath: 'C:\\bin\\ffprobe.exe' })
    assert.equal(cmd[0], 'C:\\bin\\ffprobe.exe')
  })
})

// ---------------------------------------------------------------------------
// ffmetadata
// ---------------------------------------------------------------------------

describe('命令构建：ffmetadata 章节文件（严格连续无缝）', () => {
  const chapters = [
    { title: '第1章 陨落的天才', durationMs: 742_000 },
    { title: '第2章 斗之气', durationMs: 747_000 },
    { title: '第3章 客人', durationMs: 610_000 },
  ]

  it('首行是 ;FFMETADATA1，含书名/作者等元数据', () => {
    const text = generateFfmetadata(chapters, { title: '斗破苍穹', artist: '天蚕土豆', narrator: '旁白君', date: '2026' })
    const lines = text.split('\n')
    assert.equal(lines[0], ';FFMETADATA1')
    assert.ok(text.includes('title=斗破苍穹'))
    assert.ok(text.includes('artist=天蚕土豆'))
    assert.ok(text.includes('album_artist=旁白君'))
    assert.ok(text.includes('genre=Audiobook'))
  })

  it('每章都有 [CHAPTER] + TIMEBASE=1/1000 + START/END（整数毫秒）', () => {
    const text = generateFfmetadata(chapters, {})
    assert.equal((text.match(/\[CHAPTER\]/g) ?? []).length, 3)
    assert.equal((text.match(/TIMEBASE=1\/1000/g) ?? []).length, 3)
    const { chapters: parsed } = parseFfmetadata(text)
    assert.equal(parsed.length, 3)
    for (const c of parsed) {
      assert.ok(Number.isInteger(c.startMs), `START 必须是整数毫秒：${c.startMs}`)
      assert.ok(Number.isInteger(c.endMs), `END 必须是整数毫秒：${c.endMs}`)
    }
  })

  it('★ START/END 严格连续无缝：上一章 END == 下一章 START，首章 START=0', () => {
    const text = generateFfmetadata(chapters, {})
    const { chapters: parsed } = parseFfmetadata(text)
    assert.equal(parsed[0]!.startMs, 0)
    assert.equal(parsed[0]!.endMs, 742_000)
    assert.equal(parsed[1]!.startMs, 742_000, '必须无缝衔接')
    assert.equal(parsed[1]!.endMs, 1_489_000)
    assert.equal(parsed[2]!.startMs, 1_489_000)
    const continuity = verifyChapterContinuity(parsed)
    assert.equal(continuity.ok, true, `存在缝隙：${JSON.stringify(continuity.gaps)}`)
  })

  it('★ 累积整数加法：1000 章 × 0.4 ms 的时长也不会产生 1 ms 缝隙', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ title: `第${i + 1}章`, durationMs: 1000.4 }))
    const text = generateFfmetadata(many, {})
    const { chapters: parsed } = parseFfmetadata(text)
    assert.equal(parsed.length, 1000)
    const continuity = verifyChapterContinuity(parsed)
    assert.equal(continuity.ok, true, `存在缝隙：${JSON.stringify(continuity.gaps.slice(0, 3))}`)
    // 累加后总时长 = 1000 × round(1000.4) = 1000000
    assert.equal(parsed[parsed.length - 1]!.endMs, 1_000_000)
  })

  it('元数据与章节标题里的 ; # = 换行被转义（否则 ffmpeg 解析出错）', () => {
    assert.equal(escapeFfmetadataValue('a;b#c=d'), 'a\\;b\\#c\\=d')
    assert.equal(escapeFfmetadataValue('a\\b'), 'a\\\\b')
    assert.equal(escapeFfmetadataValue('a\nb'), 'a\\\nb')
    const text = generateFfmetadata([{ title: '第1章 = 天才;上', durationMs: 1000 }], { title: '书名;副标题' })
    const { meta, chapters: parsed } = parseFfmetadata(text)
    assert.equal(meta['title'], '书名;副标题')
    assert.equal(parsed[0]!.title, '第1章 = 天才;上')
  })

  it('时长为 0 的章节被跳过，且不破坏后续连续性', () => {
    const text = generateFfmetadata(
      [
        { title: 'A', durationMs: 1000 },
        { title: 'B', durationMs: 0 },
        { title: 'C', durationMs: 2000 },
      ],
      {},
    )
    const { chapters: parsed } = parseFfmetadata(text)
    assert.equal(parsed.length, 2)
    assert.deepEqual(parsed.map(c => c.title), ['A', 'C'])
    assert.equal(parsed[1]!.startMs, 1000)
    assert.equal(verifyChapterContinuity(parsed).ok, true)
  })
})

// ---------------------------------------------------------------------------
// concat 列表
// ---------------------------------------------------------------------------

describe('命令构建：concat 列表（docs/05 §9.2 步骤 2）', () => {
  it('路径用正斜杠 + 单引号包裹', () => {
    const text = generateConcatList(['C:\\out\\斗破苍穹\\001_第1章.mp3', 'C:/out/002.mp3'])
    const lines = text.trim().split('\n')
    assert.equal(lines[0], "file 'C:/out/斗破苍穹/001_第1章.mp3'")
    assert.equal(lines[1], "file 'C:/out/002.mp3'")
  })

  it("含单引号的路径按 '\\'' 转义", () => {
    const text = generateConcatList(["C:/out/it's a chapter.mp3"])
    assert.equal(text.trim(), "file 'C:/out/it'\\''s a chapter.mp3'")
  })

  it('解析回原始路径（往返一致）', () => {
    const files = ["C:/out/it's a chapter.mp3", 'C:/out/002.mp3']
    assert.deepEqual(parseConcatList(generateConcatList(files)), files)
  })

  it('空路径被跳过', () => {
    assert.equal(generateConcatList(['', 'C:/a.mp3']).trim(), "file 'C:/a.mp3'")
  })
})

// ---------------------------------------------------------------------------
// 进度与能力探测
// ---------------------------------------------------------------------------

describe('解析：-progress pipe:1 输出', () => {
  it('out_time_us / total_size / speed / progress', () => {
    assert.deepEqual(parseProgress('out_time_us=12345678'), { outTimeUs: 12345678 })
    assert.deepEqual(parseProgress('total_size=4096000'), { totalSize: 4096000 })
    assert.deepEqual(parseProgress('speed=1.23x'), { speed: 1.23 })
    assert.deepEqual(parseProgress('speed= 0.5x'), { speed: 0.5 })
    assert.deepEqual(parseProgress('progress=end'), { progress: 'end' })
  })

  it('★ out_time_ms 实际也是微秒（ffmpeg 历史遗留），必须当 µs 处理', () => {
    assert.deepEqual(parseProgress('out_time_ms=4000000'), { outTimeUs: 4000000 })
  })

  it('out_time 的 HH:MM:SS.micro 也能换算成微秒', () => {
    assert.equal(parseFfmpegTimeToUs('00:00:04.000000'), 4_000_000)
    assert.equal(parseFfmpegTimeToUs('01:02:03.500000'), 3_723_500_000)
    assert.deepEqual(parseProgress('out_time=00:12:22.500000'), { outTimeUs: 742_500_000 })
    assert.equal(parseFfmpegTimeToUs('N/A'), null)
  })

  it('无关行返回 null（调用方按行喂入，不必先过滤）', () => {
    // frame 虽然在契约之外，但确实属于 -progress 输出，解析出来无害（进度面板可用作参考）
    assert.deepEqual(parseProgress('frame=1'), { frame: 1 })
    assert.equal(parseProgress('bitrate= 192.0kbits/s'), null)
    assert.equal(parseProgress(''), null)
    assert.equal(parseProgress('nonsense'), null)
    assert.equal(parseProgress('dup_frames=0'), null)
  })

  it('parseProgressOutput 合并多行（一次 stdout chunk）', () => {
    const chunk = 'frame=100\nfps=25\nout_time_us=4000000\ntotal_size=1024\nspeed=2.0x\nprogress=continue\n'
    const info = parseProgressOutput(chunk)
    assert.deepEqual(info, { outTimeUs: 4_000_000, totalSize: 1024, speed: 2, frame: 100, progress: 'continue' })
    assert.equal(parseProgressOutput('nothing'), null)
  })

  it('withProgress 把 -progress pipe:1 插到输出文件之前', () => {
    const cmd = withProgress(['ffmpeg', '-i', 'a.wav', 'b.wav'])
    assert.deepEqual(cmd, ['ffmpeg', '-i', 'a.wav', '-progress', 'pipe:1', 'b.wav'])
  })
})

describe('解析：版本 / 滤镜 / 能力探测（docs/02 §5.1）', () => {
  it('parseVersion 取版本号', () => {
    assert.equal(
      parseVersion('ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers'),
      '6.1.1-full_build-www.gyan.dev',
    )
    assert.equal(parseVersion('ffmpeg version n7.0'), 'n7.0')
    assert.equal(parseVersion('command not found'), null)
    assert.equal(parseVersion(''), null)
  })

  it('parseFilters 旧格式：三字符标记（6.x 及更早）', () => {
    const stdout = [
      'Filters:',
      '  T.. = Timeline support',
      '  .S. = Slice threading',
      '  ..C = Command support',
      '  A = Audio input/output',
      '  ... acompressor       A->A       Audio compressor.',
      '  ..C afftdn            A->A       Affine denoise.',
      '  T.. alimiter          A->A       Audio lookahead limiter.',
      '  ... amix              N->A       Audio mixing.',
      '  ... loudnorm          A->A       EBU R128 loudness normalization.',
    ].join('\n')
    const filters = parseFilters(stdout)
    assert.deepEqual(filters, ['acompressor', 'afftdn', 'alimiter', 'amix', 'loudnorm'])
  })

  it('parseFilters 新格式：**两字符**标记（实测 ffmpeg 9.0.2）', () => {
    // ★ 这十条是真实输出（`ffmpeg -hide_banner -filters` 的前几行 + 几个音频滤镜），
    //   不是照着正则手写的。旧正则写死「三字符标记」，在这种输出上匹配 **0 行** ——
    //   后果是滤镜列表为空 ⇒ 必需滤镜「全部缺失」⇒ UI 把降噪/EQ/压缩控件全隐藏，
    //   而 ffmpeg 明明是好的。单测当时没抓住，因为 fixture 是照旧格式手写的。
    const stdout = [
      'Filters:',
      '  T.. = Timeline support',
      '  .S. = Slice threading',
      '  A = Audio input/output',
      '  V = Video input/output',
      '  N = Dynamic number and/or type of input/output',
      '  | = Source or sink filter',
      '  ------',
      ' TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.',
      ' .. abench            A->A       Benchmark part of a filtergraph.',
      ' .. acompressor       A->A       Audio compressor.',
      ' TS afftdn            A->A       Denoise audio samples using FFT.',
      ' .. amix              N->A       Audio mixing.',
      ' .. anullsink         A->|       Do absolutely nothing with the input audio.',
      ' .. abuffer           |->A       Buffer audio frames, and make them accessible to the filterchain.',
      ' .. loudnorm          A->A       EBU R128 loudness normalization',
    ].join('\n')
    const filters = parseFilters(stdout)
    assert.deepEqual(filters, [
      'aap',
      'abench',
      'abuffer',
      'acompressor',
      'afftdn',
      'amix',
      'anullsink',
      'loudnorm',
    ])
    // 表头与图例必须一条都不进来（它们里面没有 `->`；表头里那个 `->` 在说明文字里）
    assert.ok(!filters.includes('='), '图例行不能被当成滤镜')
  })

  it('parseFilters 的判据是签名列：必需滤镜能被真的认出来', () => {
    // 这是「能力探测」的最后一公里：解析不出名字，能力探测就等于没做
    const stdout = REQUIRED_FILTERS.map((f, i) => ` .. ${f}${' '.repeat(Math.max(1, 18 - f.length))}A->A       ${i}`).join('\n')
    assert.deepEqual(parseFilters(stdout), [...REQUIRED_FILTERS].sort())
  })

  it('parseEncoders 取音频/视频编码器名', () => {
    const stdout = [
      'Encoders:',
      ' ------',
      ' V....D libx264              libx264 H.264',
      ' A....D libmp3lame           libmp3lame MP3',
      ' A....D aac                  AAC (Advanced Audio Coding)',
    ].join('\n')
    assert.deepEqual(parseEncoders(stdout), ['aac', 'libmp3lame', 'libx264'])
  })

  it('computeCapabilities：全部具备时 missing 为空', () => {
    const caps = computeCapabilities('6.1.1', [...REQUIRED_FILTERS, 'anull'])
    assert.deepEqual(caps.missing, [])
    assert.equal(caps.available, true)
    assert.equal(caps.version, '6.1.1')
  })

  it('computeCapabilities：缺 afftdn/deesser 时精确列出（UI 据此隐藏控件）', () => {
    const filters = REQUIRED_FILTERS.filter(f => f !== 'afftdn' && f !== 'deesser')
    const caps = computeCapabilities('6.1.1', filters)
    assert.deepEqual(caps.missing, ['afftdn', 'deesser'])
  })

  it('★ 未探测到 ffmpeg（版本为空）时 available=false，并列出全部缺失滤镜', () => {
    const caps = computeCapabilities(null, [])
    assert.equal(caps.available, false)
    assert.equal(caps.missing.length, REQUIRED_FILTERS.length)
  })

  it('docs/02 §5.1 要求的关键滤镜清单完整（12 个）', () => {
    assert.equal(REQUIRED_FILTERS.length, 12)
    for (const f of ['loudnorm', 'afftdn', 'deesser', 'equalizer', 'acompressor', 'alimiter', 'sidechaincompress', 'amix', 'concat', 'atempo', 'highpass', 'lowpass']) {
      assert.ok(REQUIRED_FILTERS.includes(f as never), `缺少 ${f}`)
    }
  })

  it('buildFfmpegCapabilities 组装 IPC 返回值', () => {
    const caps = buildFfmpegCapabilities({
      versionStdout: 'ffmpeg version 6.1.1 Copyright',
      filtersStdout: REQUIRED_FILTERS.map(f => `  ... ${f}            A->A       desc.`).join('\n'),
      encodersStdout: ' A....D libmp3lame  libmp3lame MP3',
      path: 'C:/ffmpeg/bin/ffmpeg.exe',
    })
    assert.equal(caps.version, '6.1.1')
    assert.equal(caps.available, true)
    assert.deepEqual(caps.missing, [])
    assert.deepEqual(caps.encoders, ['libmp3lame'])
    assert.equal(caps.path, 'C:/ffmpeg/bin/ffmpeg.exe')
  })

  it('parseAstats 解析噪声轮廓（nf 自动填充用）', () => {
    const stderr = '[Parsed_astats_0 @ 0x1] Overall\n  RMS level dB: -52.3\n  Peak level dB: -8.1\n  Flat factor: 0.000000\n'
    const r = parseAstats(stderr)
    assert.ok(r)
    assert.equal(r!.rmsDb, -52.3)
    assert.equal(r!.peakDb, -8.1)
    assert.equal(parseAstats('nothing'), null)
  })

  it('parseFfprobeJson 解析 M4B 验收信息（章节/时长）', () => {
    const json = JSON.stringify({
      format: { duration: '742.000000', size: '17825792', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
      chapters: [
        { start_time: '0.000000', end_time: '742.000000', tags: { title: '第1章' } },
        { start_time: '742.000000', end_time: '1489.000000', tags: { title: '第2章' } },
      ],
    })
    const r = parseFfprobeJson(json)
    assert.ok(r)
    assert.equal(r!.durationMs, 742_000)
    assert.equal(r!.chapters.length, 2)
    assert.equal(r!.chapters[1]!.startMs, 742_000)
    assert.equal(r!.chapters[1]!.title, '第2章')
    assert.equal(parseFfprobeJson('not json'), null)
  })
})

// ---------------------------------------------------------------------------
// 混音渲染命令（docs/15 §3）
// ---------------------------------------------------------------------------

describe('命令构建：混音渲染（docs/15 §3）', () => {
  it('filter_complex + map 输出标签 + 中间格式统一', () => {
    const cmd = buildMixRenderCommand({
      inputs: ['a.wav', 'b.wav'],
      filterGraph: '[0:a]...;[g0]anull[voice]',
      output: 'C:/tmp/chapter-1.wav',
    })
    assert.equal(valueOf(cmd, '-filter_complex'), '[0:a]...;[g0]anull[voice]')
    assert.equal(valueOf(cmd, '-map'), '[voice]')
    assert.equal(valueOf(cmd, '-c:a'), 'pcm_s24le')
    assert.equal(allValuesOf(cmd, '-i').length, 2)
    assert.equal(cmd[cmd.length - 1], 'C:/tmp/chapter-1.wav')
  })

  it('预览渲染可用 -t 截取前 N 秒（docs/13 §6.2）', () => {
    const cmd = buildMixRenderCommand({
      inputs: ['a.wav'],
      filterGraph: '[0:a]anull[voice]',
      output: 'preview.wav',
      durationMs: 30_000,
    })
    assert.equal(valueOf(cmd, '-t'), '30')
  })

  it('命令数组可直接用于「查看命令」排障（docs/14 §7.3）', () => {
    const cmd = buildChapterExportCommand({
      input: 'in.wav',
      output: 'out.mp3',
      format: 'mp3',
    })
    assert.ok(commandIncludes(cmd, 'libmp3lame'))
    assert.ok(formatCommandForDisplay(cmd).startsWith('ffmpeg '))
  })
})
