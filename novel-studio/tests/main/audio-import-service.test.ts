/**
 * 测试 · 按说话人导入音频（服务层）
 * ============================================================================
 * 设计依据：docs/12-功能域-录音.md、docs/91 §5.2.49
 *
 * 运行：
 *   node --experimental-strip-types tests/main/audio-import-service.test.ts
 *
 * ### 本文件最重要的一条断言
 *
 *   **「预览说多少行，实际就写入多少条」**（`describe('预览与实际导入必须一致')`）。
 *
 *   为什么值得单独测：
 *     预览走**文档行**、导入走**数据库行**，是两套数据源。
 *     如果选行逻辑各写一份，就会出现「预览 90 行、实际 40 条」——
 *     两边都不报错、只是数量对不上，用户要到录音界面才发现少了一堆行。
 *     服务层因此强制与规划层共用 `shared/audio-import/select.ts`，
 *     本用例把这个约束钉住。
 */

import { strict as assert } from 'node:assert'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createAudioImportService, sanitizeFileName, type AudioImportServiceDeps } from '../../src/main/features/audio/import.service.ts'
import { createMemoryTakeRepo } from '../../src/main/features/audio/repositories/take.repo.ts'
import { createMemoryVoiceSegmentRepo } from '../../src/main/features/audio/repositories/voice-segment.repo.ts'
import type { FfmpegRunner } from '../../src/shared/ffmpeg/commands.ts'
import type { Take, VoiceSegment } from '../../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 画本 fixture（与真实样本同构：一格一行 + 格间空行 + 章末小角色表）
// ---------------------------------------------------------------------------

const CANVAS_FROM = 2221
const CANVAS_TO = 2226

/** 角色 → 章节（照真实样本的分布裁小） */
const CHARACTER_CHAPTERS: Record<string, number[]> = {
  石玉凤: [2221, 2225],
  石志坚: [2221, 2222, 2226],
  女龙套2: [2223],
  木瓜: [2224, 2225],
  方艺华: [2225],
  罗文: [2221, 2222],
  邵毅天: [2221],
}

const CHARACTER_CV: Record<string, string> = {
  石玉凤: '德钦',
  石志坚: '月光_深白色',
  女龙套2: '兔小舟',
  木瓜: '兔小舟',
  方艺华: '语心草',
  罗文: '春哥拿大顶',
  // 同一 CV 配多个角色 —— 「多角色」路径的前提（兔小舟/春哥拿大顶 都各配 2 个）
  邵毅天: '春哥拿大顶',
}

function rosterBlock(rows: Array<[string, string]>): string[] {
  const out: string[] = []
  const cell = (s: string) => {
    out.push(s)
    out.push('')
  }
  for (const h of ['序号', 'CV', '角色名', '角色描述', '台词数', '音色']) cell(h)
  rows.forEach(([cv, character], i) => {
    cell(String(i + 1))
    cell(cv)
    cell(character)
    cell('')
    cell('1')
    cell('')
  })
  return out
}

function buildCanvasText(): string {
  const out: string[] = []
  out.push(...rosterBlock(Object.keys(CHARACTER_CHAPTERS).map((c) => [CHARACTER_CV[c]!, c] as [string, string])))

  const byChapter = new Map<number, string[]>()
  for (const [ch, chapters] of Object.entries(CHARACTER_CHAPTERS)) {
    for (const c of chapters) {
      const l = byChapter.get(c)
      if (l) l.push(ch)
      else byChapter.set(c, [ch])
    }
  }

  for (let ch = CANVAS_FROM; ch <= CANVAS_TO; ch++) {
    out.push(`第${ch}章`)
    out.push(`【异口同声】“第${ch}章众人齐声。”`)
    out.push(`这是第${ch}章的旁白。`)
    for (const character of byChapter.get(ch) ?? []) {
      out.push(`【${CHARACTER_CV[character]}-${character}】“第${ch}章 ${character} 的台词。”`)
    }
    out.push(...rosterBlock([['德钦', '石玉凤']]))
  }
  return out.join('\n')
}

const CANVAS_TEXT = buildCanvasText()

// ---------------------------------------------------------------------------
// 假仓储：从 fixture 派生「数据库里的画本」
// ---------------------------------------------------------------------------

interface FakeDbLine {
  id: string
  chapterId: string
  seq: number
  speakerType: 'narration' | 'character'
  characterId: string | null
  kind: 'dialogue' | 'narration' | 'inner' | 'sfx_note'
  text: string
}

/**
 * 导入副本的落盘根目录（临时目录，测试结束即删）。
 *
 * 为什么要有真实目录：`applyImport` 现在校验「复制出来的那一份」的容器格式，
 * 假实现会让这段校验逻辑**完全测不到**。
 */
const COPY_ROOT = mkdtempSync(join(tmpdir(), 'ns-import-copy-'))

/**
 * 源文件根目录。
 *
 * `applyImport` 现在会**先读源文件的头**判断容器（不是只看扩展名），
 * 所以源路径必须是真实存在的文件 —— 用 `${SRC}/xxx.mp3` 这种假路径会直接
 * 报「文件不存在」，整组用例就变成在测错误处理而不是导入逻辑。
 */
const SOURCE_ROOT = mkdtempSync(join(tmpdir(), 'ns-import-src-'))
/** 供模板字符串用的正斜杠形式（Windows 上 join 出来是反斜杠） */
const SRC = SOURCE_ROOT.replace(/\\/g, '/')

/**
 * 假的项目根。
 *
 * 转码那条路径**由服务自己**拼 `join(projectRoot, projectId, target)` 并写文件
 * （不像 WAV 那条走 `copyIntoProject` 依赖），所以这个目录必须真的可写。
 */
const PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'ns-import-proj-'))

/** 合法的 WAV 头（`RIFF`…`WAVE`），让默认用例能通过格式校验 */
function wavHeader(): Buffer {
  const b = Buffer.alloc(64)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(56, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(48_000, 24)
  b.writeUInt32LE(96_000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(20, 40)
  return b
}

/** 假装是 mp3 的文件（真实样本都是 `ID3` 开头，实测见 docs/91 §5.2.49） */
function mp3Header(): Buffer {
  const b = Buffer.alloc(64)
  b.write('ID3', 0, 'ascii')
  b[3] = 0x03
  b[4] = 0x00
  b[5] = 0x00
  // syncsafe 大小 0 → 音频数据紧跟在 10 字节头之后
  b.writeUInt8(0, 6)
  b.writeUInt8(0, 7)
  b.writeUInt8(0, 8)
  b.writeUInt8(0, 9)
  // 之后是 MPEG 帧同步
  b[10] = 0xff
  b[11] = 0xfb
  b[12] = 0x90
  return b
}

/**
 * 把一个源文件真的写到磁盘上（默认内容是合法 WAV）。
 *
 * 同名文件**总是重写**：mp3 用例与正常用例共用同一个文件名
 * （`2221-2230-石玉凤-德钦.mp3`），靠子目录隔离而不是靠「谁先跑」。
 */
function writeSource(name: string, bytes: Buffer = wavHeader(), sub = ''): string {
  const dir = sub ? join(SOURCE_ROOT, sub) : SOURCE_ROOT
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, name)
  writeFileSync(abs, bytes)
  return abs
}

/** 真机那 5 个样本的「内容」—— 全都是 mp3（`ID3` 开头），见 docs/91 §5.2.49 */
function writeMp3Source(name: string): string {
  return writeSource(name, mp3Header(), 'mp3')
}

/**
 * 造一段「朗读」PCM（说话段 = 440 Hz 正弦，静音段 = 0）。
 *
 * 为什么需要：切句链路原本只能靠真音频才能跑到，而真音频要 ffmpeg。
 * 有了这个（配合注入的 `decodeAudio`），「解码 → VAD → 逐行区间 → 落库」
 * 这一段可以**完全脱离 ffmpeg** 验证。
 */
function makeSpeechBlocks(blocks: Array<[number, boolean]>): Float32Array {
  const rate = 48_000
  const total = blocks.reduce((s, [ms]) => s + Math.round((ms / 1000) * rate), 0)
  const out = new Float32Array(total)
  let cursor = 0
  for (const [ms, voiced] of blocks) {
    const n = Math.round((ms / 1000) * rate)
    if (voiced) {
      for (let i = 0; i < n; i++) out[cursor + i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate)
    }
    cursor += n
  }
  return out
}

/**
 * 假的 ffmpeg 执行器。
 *
 * 成功时把「产物」写成一段合法 WAV —— 不这么做的话，
 * 服务紧接着的「校验产物是 WAV」那一步就永远测不到（会一直走失败分支）。
 */
function fakeFfmpeg(
  opts: { exitCode?: number; stderr?: string; onRun?: (command: string[]) => void } = {},
): FfmpegRunner {
  return {
    async execute(command) {
      opts.onRun?.(command)
      const exitCode = opts.exitCode ?? 0
      if (exitCode === 0) {
        // 命令数组的最后一项就是输出路径（`buildDecodeToWavCommand` 的约定）
        const out = command[command.length - 1]!
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, wavHeader())
      }
      return { command, exitCode, stdout: '', stderr: opts.stderr ?? '', elapsedMs: 1 }
    },
  }
}

/**
 * 把文档解析结果「导入数据库」——即构造与真实落库一致的行集合。
 *
 * 这一步刻意**独立实现**（不复用服务里的转换），因为它模拟的是
 * 「画本已经通过画本编辑域落库」这个前置事实。
 */
function buildFakeDb(): {
  /**
   * ⚠️ 这里刻意让 `no`（章节号）与 `seq`（序号）**不同**，
   * 模拟真实书：真实样本那本书章节号 2201~2300，而 `seq` 是 1~100。
   *
   * 早期 fixture 把两者设成同一个值，于是「误用 seq 当章节号」这个 bug
   * **在测试里永远绿**。现在让它们错开 —— 任何退回 `seq` 的写法都会立刻红。
   */
  chapters: Array<{ id: string; no: number; title: string }>
  lines: FakeDbLine[]
  characters: Array<{ id: string; name: string; aliases: string[] }>
  voiceActors: Array<{ id: string; name: string }>
} {
  const chapters: Array<{ id: string; no: number; title: string }> = []
  const lines: FakeDbLine[] = []
  const characters: Array<{ id: string; name: string; aliases: string[] }> = []

  const characterIdByName = new Map<string, string>()
  let ci = 0
  for (const name of Object.keys(CHARACTER_CHAPTERS)) {
    const id = `char${++ci}`
    characterIdByName.set(name, id)
    characters.push({ id, name, aliases: [] })
  }

  // `no` = 章节号（2221…）；而真实库里的 `seq` 是 1…N 的**序号**。
  // 这里不再提供 seq —— 因为 `AudioImportRepos.listChapters` 只给 `no`，
  // 想误用 seq 也无从下手（这正是修完那个 bug 之后的契约形态）。
  for (let ch = CANVAS_FROM; ch <= CANVAS_TO; ch++) {
    const chapterId = `chap${ch}`
    chapters.push({ id: chapterId, no: ch, title: `第${ch}章` })
    let seq = 0
    // 群白：数据库里表现为 narration 类型但 kind=dialogue（无角色）→ group
    lines.push({
      id: `${chapterId}-g`,
      chapterId,
      seq: seq++,
      speakerType: 'character',
      characterId: null,
      kind: 'dialogue',
      text: `第${ch}章众人齐声。`,
    })
    // 旁白
    lines.push({
      id: `${chapterId}-n`,
      chapterId,
      seq: seq++,
      speakerType: 'narration',
      characterId: null,
      kind: 'narration',
      text: `这是第${ch}章的旁白。`,
    })
    // 对白
    for (const [character, chaptersOf] of Object.entries(CHARACTER_CHAPTERS)) {
      if (!chaptersOf.includes(ch)) continue
      lines.push({
        id: `${chapterId}-${character}`,
        chapterId,
        seq: seq++,
        speakerType: 'character',
        characterId: characterIdByName.get(character)!,
        kind: 'dialogue',
        text: `第${ch}章 ${character} 的台词。`,
      })
    }
  }

  // 与真实项目一样：配音演员是**项目级**的（不属于某一本书）
  const voiceActors = [...new Set(Object.values(CHARACTER_CV))].map((name, i) => ({
    id: `va${i + 1}`,
    name,
  }))

  return { chapters, lines, characters, voiceActors }
}

const FAKE_DB = buildFakeDb()

/** 测试用的音频文件名（全部来自真实样本命名法） */
const FILE_SHIYUFENG = '2221-2230-石玉凤-德钦.mp3'
const FILE_SHIZHIJIAN = '2221-2230-石志坚-月光.mp3'
const FILE_MULTI = '2221-2230-多角色-兔小舟.mp3'
const FILE_NARRATION = '2251-2255-旁白-语心草.mp3'
const FILE_MULTI_CHUNGE = '2221-2230-多角色-春哥拿大顶.mp3'

/**
 * 提前把这几个源文件写到磁盘上（内容是合法 WAV）。
 *
 * 为什么不全在用例里写：`applyImport` 会读源文件头判断容器，
 * 而「源文件存在」属于前置条件而不是被测行为 —— 放在这里，
 * 每个用例只表达自己关心的那一件事（比如「这个文件是 mp3」）。
 */
for (const n of [FILE_SHIYUFENG, FILE_SHIZHIJIAN, FILE_MULTI, FILE_NARRATION, FILE_MULTI_CHUNGE]) {
  writeSource(n)
}

function makeService(overrides: Partial<AudioImportServiceDeps> = {}): {
  service: ReturnType<typeof createAudioImportService>
  takes: Take[]
  segments: VoiceSegment[]
  copied: Array<{ sourcePath: string; relativeTarget: string }>
  logged: Array<{ event: string; fields?: Record<string, unknown> }>
} {
  const takeRepo = createMemoryTakeRepo()
  const segmentRepo = createMemoryVoiceSegmentRepo()
  const takes: Take[] = []
  const segments: VoiceSegment[] = []
  const copied: Array<{ sourcePath: string; relativeTarget: string }> = []
  const logged: Array<{ event: string; fields?: Record<string, unknown> }> = []

  // 包一层记录写入，便于断言
  const wrappedTakeRepo = {
    ...takeRepo,
    insert: async (t: Take) => {
      const r = await takeRepo.insert(t)
      takes.push(r)
      return r
    },
  }
  const wrappedSegmentRepo = {
    ...segmentRepo,
    upsertByLine: async (s: VoiceSegment) => {
      const r = await segmentRepo.upsertByLine(s)
      segments.push(r)
      return r
    },
  }

  const deps: AudioImportServiceDeps = {
    getDb: () => ({}),
    projectRoot: () => PROJECT_ROOT,
    scope: {} as never,
    repos: {
      listChapters: async () => FAKE_DB.chapters,
      listLines: async (chapterId: string) => FAKE_DB.lines.filter((l) => l.chapterId === chapterId),
      listCharacters: async () => FAKE_DB.characters,
      listVoiceActors: async () => FAKE_DB.voiceActors,
    },
    takeRepo: () => wrappedTakeRepo,
    segmentRepo: () => wrappedSegmentRepo,
    lineChapterId: async (lineId: string) => lineId.split('-')[0] ?? null,
    readDocument: async () => CANVAS_TEXT,
    copyIntoProject: async ({ sourcePath, relativeTarget }) => {
      copied.push({ sourcePath, relativeTarget })
      const absolutePath = join(COPY_ROOT, relativeTarget)
      mkdirSync(dirname(absolutePath), { recursive: true })
      /**
       * **真的做一次字节复制**，而不是写一段固定的 WAV 头。
       *
       * 因为服务接下来会读这一份的**内容**判断容器：写死 WAV 头的话，
       * 「源文件是 mp3 时复制出来也是 mp3」这个真实行为就测不到了。
       */
      copyFileSync(sourcePath, absolutePath)
      return { relativePath: relativeTarget, absolutePath }
    },
    probeDurationMs: async () => 60_000,
    newId: (() => {
      let n = 0
      return (prefix: string) => `${prefix}_${++n}`
    })(),
    now: () => 1_700_000_000_000,
    log: {
      info: (event: string, fields?: Record<string, unknown>) => logged.push({ event, ...(fields ? { fields } : {}) }),
      warn: (event: string, fields?: Record<string, unknown>) => logged.push({ event, ...(fields ? { fields } : {}) }),
      error: (event: string, fields?: Record<string, unknown>) => logged.push({ event, ...(fields ? { fields } : {}) }),
    },
    ...overrides,
  }

  return { service: createAudioImportService(deps), takes, segments, copied, logged }
}

const PROJECT = 'proj1'
const BOOK = 'book1'
const CANVAS_PATH = 'C:/samples/画本.docx'

// ---------------------------------------------------------------------------

/** 导入副本落在临时目录，测完必须清掉（否则每跑一次泄漏一个目录） */
after(() => rmSync(COPY_ROOT, { recursive: true, force: true }))

describe('sanitizeFileName（路径穿越防护）', () => {
  it('把路径分隔符替换成下划线', () => {
    assert.equal(sanitizeFileName('a/b\\c.mp3'), 'a_b_c.mp3')
    // 具体替换出的下划线个数属于实现细节，这里只断言分隔符没被保留、名字没丢
    const out = sanitizeFileName('../../etc/passwd')
    assert.equal(out.includes('/'), false)
    assert.equal(out.includes('\\'), false)
    assert.ok(out.includes('etc'), '正常字符不该被吃掉')
    assert.ok(out.includes('passwd'), '正常字符不该被吃掉')
  })

  it('去掉 Windows 非法字符与控制字符', () => {
    assert.equal(sanitizeFileName('a<b>c:d"e|f?g*h.mp3'), 'a_b_c_d_e_f_g_h.mp3')
    assert.equal(sanitizeFileName('a\u0000b.mp3'), 'a_b.mp3')
  })

  it('空名与超长名有兜底', () => {
    assert.equal(sanitizeFileName(''), 'unnamed')
    assert.equal(sanitizeFileName('   '), 'unnamed')
    assert.equal(sanitizeFileName('x'.repeat(500)).length, 120)
  })

  /**
   * **这条才是这个函数存在的理由**：不论输入多恶意，
   * 输出都不能含分隔符或 `..`，否则拼进项目内路径就会写到项目外。
   *
   * 不去断言具体字符串形态（那取决于替换顺序，属于实现细节），
   * 只断言**安全性质** —— 这才是真正要守住的东西。
   */
  it('任何输入的结果都不含分隔符与目录穿越片段', () => {
    const nasty = [
      '../../x',
      'a/b/c',
      '..\\..\\y',
      '....//',
      '....\\\\....\\\\z',
      '..%2f..%2f',
      'a\u0000/../b',
      'C:\\Windows\\System32\\evil.dll',
      '...\\...\\...',
    ]
    for (const input of nasty) {
      const out = sanitizeFileName(input)
      assert.equal(out.includes('/'), false, `「${input}」→「${out}」不该含 /`)
      assert.equal(out.includes('\\'), false, `「${input}」→「${out}」不该含 \\`)
      assert.equal(out.includes('..'), false, `「${input}」→「${out}」不该含 ..`)
      assert.ok(out.length > 0, `「${input}」不该产出空名`)
    }
  })

  it('结果永远是单个路径片段（不含分隔符 ⇒ 不可能跳出目标目录）', () => {
    for (const input of ['a/b', 'a\\b', '../a', '..\\a']) {
      const joined = `imports/${sanitizeFileName(input)}`
      // 没有分隔符注入 ⇒ 拼接后仍然只有一层目录
      assert.equal(joined.split('/').length, 2, `「${input}」拼出的路径层级被改变了`)
    }
  })
})

describe('scanCanvas：画本解析 + 与数据库对齐', () => {
  it('解析出章节、角色、CV，并与数据库章节号对齐', async () => {
    const { service } = makeService()
    const scan = await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })

    assert.equal(scan.chapters.length, CANVAS_TO - CANVAS_FROM + 1)
    assert.equal(scan.chapters[0]!.no, CANVAS_FROM)
    assert.equal(scan.chapters[scan.chapters.length - 1]!.no, CANVAS_TO)
    assert.equal(scan.characters.length, Object.keys(CHARACTER_CHAPTERS).length)
    assert.equal(scan.documentChapterRange?.from, CANVAS_FROM)
    assert.deepEqual(
      scan.canvasCvs.sort(),
      [...new Set(Object.values(CHARACTER_CV))].sort(),
      'CV 列表应来自角色表',
    )
  })

  it('**不传 canvasPath**：直接用数据库里的画本，不再需要画本文件', async () => {
    const { service } = makeService()
    const scan = await service.scanCanvas({ projectId: PROJECT, bookId: BOOK })
    // 章节与角色都来自数据库（不是任何 docx）
    assert.equal(scan.chapters.length, CANVAS_TO - CANVAS_FROM + 1)
    assert.equal(scan.chapters[0]!.no, CANVAS_FROM)
    assert.equal(scan.characters.length, Object.keys(CHARACTER_CHAPTERS).length)
    assert.equal(scan.filePath, '', '没有画本文件时 filePath 为空')
  })

  it('**不传 canvasPath**也能生成预览：行来自数据库', async () => {
    const { service } = makeService()
    const result = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      files: [{ filePath: 'C:/s/2221-2240-石志坚-月光.mp3' }],
    })
    assert.equal(result.plan.files.length, 1)
    assert.ok(result.plan.files[0]!.lineCount > 0, `数据库里的画本行要能被命中：${result.plan.files[0]!.lineCount}`)
  })

  it('每章的行数来自数据库（不是文档）', async () => {
    const { service } = makeService()
    const scan = await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    const ch2221 = scan.chapters.find((c) => c.no === 2221)!
    // 2221：群白 1 + 旁白 1 + 石玉凤/石志坚/罗文/邵毅天 4 = 6
    assert.equal(ch2221.lineCount, 6)
  })

  it('文档里有、数据库里没有的章节被跳过（不报错）', async () => {
    const { service } = makeService({
      repos: {
        listChapters: async () => FAKE_DB.chapters.filter((c) => c.no <= 2223),
        listLines: async (chapterId: string) => FAKE_DB.lines.filter((l) => l.chapterId === chapterId),
        listCharacters: async () => FAKE_DB.characters,
        listVoiceActors: async () => FAKE_DB.voiceActors,
      },
    })
    const scan = await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    assert.equal(scan.chapters.length, 3, '只保留数据库里存在的 2221~2223')
    assert.equal(scan.documentChapterRange?.to, CANVAS_TO, '文档范围仍如实上报')
  })

  /**
   * ⚠️ **回归**：这一条防的是「把 `chapters.seq` 当章节号用」。
   *
   * 真实书里 `seq` 是**序号**（1…N），章节号在**标题**里（2201…2300），
   * 两者完全不重合。误用 `seq` 会让「按说话人导入」一个章节都对不上，
   * 症状是「全部文件都报区间不在画本内」。
   *
   * 这条用例的做法：给一份 `no` 与标题里的章节号**故意不一致**的数据 ——
   * 若实现退回 `seq`（或退回标题以外的任何东西），行数就会变 0。
   */
  it('章节对齐用的是「章节号」而不是序号（seq）', async () => {
    // 冒充一个「seq = 1，但章节号 = 2221」的库：正是真实书的形态
    const { service } = makeService({
      repos: {
        listChapters: async () =>
          FAKE_DB.chapters.map((c, i) => ({ id: c.id, no: c.no, title: c.title, seq: i + 1 })) as never,
        listLines: async (chapterId: string) => FAKE_DB.lines.filter((l) => l.chapterId === chapterId),
        listCharacters: async () => FAKE_DB.characters,
        listVoiceActors: async () => FAKE_DB.voiceActors,
      },
    })
    const scan = await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    assert.equal(
      scan.chapters.length,
      CANVAS_TO - CANVAS_FROM + 1,
      '必须按章节号对齐 —— 用 seq 会一个都对不上',
    )
    assert.equal(scan.chapters[0]!.no, CANVAS_FROM)

    // 而且这个对齐要真的传导到「命中行数」上
    const { plan } = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })
    assert.equal(plan.files[0]!.lineCount, 2, '石玉凤在 2221 与 2225 各 1 句')
  })
})

describe('buildPlan：预览', () => {
  it('真实命名法的文件能正确解析出说话人与行数', async () => {
    const { service } = makeService()
    const { plan } = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [
        { filePath: `${SRC}/${FILE_SHIYUFENG}` },
        { filePath: `${SRC}/${FILE_SHIZHIJIAN}` },
        { filePath: `${SRC}/${FILE_MULTI}` },
        { filePath: `${SRC}/${FILE_MULTI_CHUNGE}` },
      ],
    })

    const byName = new Map(plan.files.map((f) => [f.fileName, f]))

    const shiyufeng = byName.get(FILE_SHIYUFENG)!
    assert.equal(shiyufeng.status, 'ready')
    // 契约形态里用展示字段（`targetExplanation` / `cvMatchedName`），
    // 而不是内部 `target` 结构 —— UI 也只拿得到这些
    assert.match(shiyufeng.targetExplanation ?? '', /石玉凤/)
    assert.equal(shiyufeng.targetKind, 'character')
    assert.equal(shiyufeng.lineCount, 2, '石玉凤在 2221 与 2225 各 1 句')

    const shizhijian = byName.get(FILE_SHIZHIJIAN)!
    assert.equal(shizhijian.status, 'needs-review', '月光 → 月光_深白色 是缩写补全')
    assert.equal(shizhijian.lineCount, 3, '石志坚在 2221/2222/2226 各 1 句')

    const multi = byName.get(FILE_MULTI)!
    assert.equal(multi.status, 'ready')
    assert.equal(multi.targetKind, 'multiRole', '兔小舟 配了 女龙套2 与 木瓜 两个角色')
    assert.equal(multi.cvMatchedName, '兔小舟')
    assert.equal(multi.lineCount, 3, '女龙套2(2223) 1 句 + 木瓜(2224/2225) 2 句')

    const chunge = byName.get(FILE_MULTI_CHUNGE)!
    assert.equal(chunge.status, 'ready')
    assert.equal(chunge.targetKind, 'multiRole', '春哥拿大顶 配了 罗文 与 邵毅天 两个角色')
    assert.equal(chunge.cvMatchedName, '春哥拿大顶')
    assert.equal(chunge.cvMatchMethod, 'exact')
    assert.equal(chunge.lineCount, 3, '罗文(2221/2222) 2 句 + 邵毅天(2221) 1 句')
  })

  it('区间完全不在画本里 → no-lines，并说明原因', async () => {
    const { service } = makeService()
    const { plan } = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_NARRATION}` }],
    })
    assert.equal(plan.files[0]!.status, 'no-lines')
    assert.ok(plan.files[0]!.notes.some((n) => /不在画本范围|没有任何章节/.test(n)))
  })

  it('人工修正覆盖自动判定', async () => {
    const { service } = makeService()
    const { plan } = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}`, overrides: { character: '木瓜' } }],
    })
    const f = plan.files[0]!
    assert.equal(f.status, 'ready')
    assert.match(f.targetExplanation ?? '', /木瓜/)
    assert.equal(f.lineCount, 2, '只取木瓜自己的 2 句，不含同 CV 的另一个角色（女龙套2）')
  })

  it('预览不写库（不产生 take / segment）', async () => {
    const { service, takes, segments, copied } = makeService()
    await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })
    assert.equal(takes.length, 0, '预览绝不能写 take')
    assert.equal(segments.length, 0, '预览绝不能写 segment')
    assert.equal(copied.length, 0, '预览绝不能复制文件')
  })
})

describe('applyImport：落库', () => {
  it('就绪文件会写入 take，并复制一次源文件到项目内', async () => {
    const { service, takes, segments, copied } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    assert.equal(res.files, 1)
    assert.equal(res.createdTakes, 2, '石玉凤 2 行 → 2 条 take')
    // ⚠️ 是**每行**第一条 take 设成品，不是「每个文件只设一行」——
    // 后者会让「已录」永远停在 0%（真机故障）
    assert.equal(res.createdSegments, 2, '每一行的第一条 take 都自动设为成品')
    assert.equal(res.skipped.length, 0)
    assert.equal(takes.length, 2)
    assert.equal(segments.length, 2)

    // 文件只复制一次（不是按行复制），且落点在项目内
    assert.equal(copied.length, 1, '一个导入文件只复制一份，避免 74 章复制 74 份')
    assert.match(copied[0]!.relativeTarget, /^imports\//)
    assert.equal(copied[0]!.relativeTarget.includes('..'), false)
  })

  it('源文件是 mp3 且没装 ffmpeg 时如实拒绝，并给出专属错误码', async () => {
    // 真机那 5 个样本全是 mp3（`ID3` 开头），用户机器上 ffmpeg 也还没配
    const mp3 = writeMp3Source(FILE_SHIYUFENG)
    const { service, takes, segments } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: mp3 }],
    })

    assert.equal(res.createdTakes, 0, '不能把 mp3 冒充成 wav 落库')
    assert.equal(res.createdSegments, 0)
    assert.equal(takes.length, 0)
    assert.equal(segments.length, 0)
    assert.equal(res.skipped.length, 1)
    /**
     * 这里必须断言**专属键**而不是 `INVALID_PAYLOAD`。
     * `applyImport` 记 `skipped[].reason` 用的是 `AppError.key`，
     * 通用键会在界面上显示成「请求数据不合法」，用户看不出是格式问题。
     */
    assert.equal(
      res.skipped[0]!.reason,
      'AUDIO_IMPORT_SOURCE_NOT_WAV',
      '真机 5 个样本全是 mp3，用户必须一眼看出是格式问题',
    )
  })

  it('源文件是 mp3、ffmpeg 可用时转码成 WAV 再落库', async () => {
    const mp3 = writeMp3Source(FILE_SHIYUFENG)
    const commands: string[][] = []
    const { service, takes, copied } = makeService({
      ffmpeg: fakeFfmpeg({ onRun: (c) => commands.push(c) }),
      ffmpegAvailable: () => true,
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: mp3 }],
    })

    assert.equal(res.createdTakes, 2, '石玉凤 2 行')
    assert.equal(res.skipped.length, 0)
    assert.equal(commands.length, 1, '一个导入文件只转一次（不是按行转）')
    assert.equal(copied.length, 0, '走转码就不该再复制源文件，否则项目里会留两份')

    // 转码命令本身：输入是源文件，输出以 .wav 结尾
    const cmd = commands[0]!
    assert.ok(cmd.includes(mp3), '命令里必须有源文件')
    assert.match(cmd[cmd.length - 1]!, /\.wav$/, '产物必须是 .wav')

    /**
     * take 指向的是**转码产物**，且扩展名是 `.wav`。
     * 这条断言是这次修复的核心：第一版会写一个「.wav 结尾、内容是 mp3」的文件，
     * 下游按内容校验必然失败，而扩展名看起来完全正确。
     */
    for (const t of takes) {
      assert.match(t.filePath, /^imports\//)
      assert.match(t.filePath, /\.wav$/)
      assert.equal(t.filePath.includes('..'), false)
    }
  })

  it('转码失败时记 AUDIO_IMPORT_TRANSCODE_FAILED，且不写任何 take', async () => {
    const mp3 = writeMp3Source(FILE_SHIYUFENG)
    const { service, takes } = makeService({
      ffmpeg: fakeFfmpeg({ exitCode: 1, stderr: 'Invalid data found when processing input' }),
      ffmpegAvailable: () => true,
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: mp3 }],
    })

    assert.equal(res.createdTakes, 0)
    assert.equal(takes.length, 0)
    assert.equal(res.skipped.length, 1)
    assert.equal(res.skipped[0]!.reason, 'AUDIO_IMPORT_TRANSCODE_FAILED')
  })

  it('转码产物不是 WAV 时按实现缺陷对待（project-copy-not-wav）', async () => {
    const mp3 = writeMp3Source(FILE_SHIYUFENG)
    /**
     * 这个假执行器「声称成功」却写了个非 WAV 的文件 —— 模拟转码命令写错参数的场景。
     * 必须被拦下：否则「.wav 里装 mp3」这个真实事故会再次发生。
     */
    const lyingFfmpeg: FfmpegRunner = {
      async execute(command) {
        const out = command[command.length - 1]!
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, mp3Header())
        return { command, exitCode: 0, stdout: '', stderr: '', elapsedMs: 1 }
      },
    }
    const { service, takes } = makeService({ ffmpeg: lyingFfmpeg, ffmpegAvailable: () => true })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: mp3 }],
    })

    assert.equal(takes.length, 0, '产物不可读就不能落库')
    assert.equal(res.createdTakes, 0)
    assert.equal(res.skipped.length, 1)
    // 这是我们自己的产物坏了，属于实现缺陷，不是用户输入问题
    assert.equal(res.skipped[0]!.reason, 'INVALID_PAYLOAD')
  })

  it('解出来是空音频时明确跳过（不写 N 条指向空文件的 take）', async () => {
    const { service, takes } = makeService({
      // 解码「成功」但一个采样都没有
      decodeAudio: async () => ({ samples: new Float32Array(0), sampleRate: 48_000 }),
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    assert.equal(takes.length, 0, '空音频写出的 take 会让界面显示「已导入 N 行」而全是静音')
    assert.equal(res.createdTakes, 0)
    assert.equal(res.skipped.length, 1)
    assert.match(res.skipped[0]!.reason, /空的/)
    assert.equal(res.perFile[0]!.splitMethod, 'empty')
    assert.equal(res.perFile[0]!.needsReview, 2, '两行都要进复核清单')
  })

  it('结果里回报切句质量（splitMethod / sliceCount / needsReview）', async () => {
    const samples = makeSpeechBlocks([
      [700, true],
      [500, false],
      [700, true],
      [900, false],
    ])
    const { service } = makeService({
      decodeAudio: async () => ({ samples, sampleRate: 48_000 }),
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    const f = res.perFile[0]!
    assert.equal(f.splitMethod, 'vad')
    assert.equal(f.sliceCount, 2, '两段语音 → 2 片')
    /**
     * **理想情形（2 片铺 2 行）不该被判为「需要复核」**。
     *
     * 这是本条断言真正要钉的东西：如果连一片一行的理想情形都进复核清单，
     * 这个标记就变成了噪声，用户会学会无视它 —— 那它还不如没有。
     * （实测值 0；刻意写的具体数字，因为「不该报警」是一个确定的期望。）
     */
    assert.equal(f.needsReview, 0, '一片一行的理想情形不该被标成「需复核」')
  })

  it('take 的字段语义正确（source=import、partIndex 递增）', async () => {
    const { service, takes } = makeService()
    await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    for (const t of takes) {
      assert.equal(t.source, 'import')
      assert.equal(t.sessionId, null, '导入的 take 不属于任何录音会话')
      assert.ok(t.flags.includes('imported'))
      assert.ok(t.note?.includes(FILE_SHIYUFENG))
      assert.equal(t.filePath.includes('..'), false)
    }
    // 两条 take 属于不同行，各自 partIndex 从 1 开始
    assert.deepEqual(takes.map((t) => t.partIndex).sort(), [1, 1])
  })

  /**
   * **不注入 `decodeAudio` 时**退回整段 take。
   *
   * 这是有意的降级而不是缺陷：用户给的是既成音频，切句不可用不该让导入失败。
   * 但「整段」与「逐行切好」在听感上差别极大，所以必须**分别有断言**，
   * 不能让某一版悄悄变成另一版。
   */
  it('没有解码能力时退回整段 take（srcIn=0 / srcOut=探测时长）', async () => {
    const { service, takes } = makeService()
    await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })
    for (const t of takes) {
      assert.equal(t.srcInMs, 0, '整段 take：从 0 开始')
      assert.equal(t.srcOutMs, 60_000, '整段 take：到探测出的时长')
      assert.equal(t.durationMs, 60_000)
      assert.ok(!t.flags.includes('import-needs-review'), '退回整段时不该打「需复核」标记')
      assert.ok(t.note?.includes('整段'))
    }
  })

  it('解码可用时**切成每行一条 take**（srcIn/srcOut 逐行接续）', async () => {
    // 两段语音夹静音：石玉凤在这个区间有 2 行
    const samples = makeSpeechBlocks([
      [700, true],
      [500, false],
      [700, true],
      [900, false],
    ])
    const { service, takes } = makeService({
      decodeAudio: async () => ({ samples, sampleRate: 48_000 }),
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    assert.equal(res.createdTakes, 2)
    assert.equal(takes.length, 2)

    for (const t of takes) {
      assert.ok(t.srcOutMs > t.srcInMs, `${t.lineId} 的区间必须是正长度`)
      assert.equal(t.durationMs, t.srcOutMs - t.srcInMs, 'durationMs 必须等于区间长度')
      assert.equal(t.trimmedInMs, 0)
      assert.equal(t.trimmedOutMs, t.durationMs)
      assert.ok(t.note?.includes('ms'), '备注里应带上这一行的区间')
    }

    /**
     * 核心断言：两行的区间**接续且不重叠**（不是两行都覆盖整段）。
     * 上一版整段 take 的写法在这里会两条都是 `0~60000` —— 一眼可辨。
     */
    const sorted = [...takes].sort((a, b) => a.srcInMs - b.srcInMs)
    assert.equal(sorted[0]!.srcInMs, 0)
    assert.equal(sorted[1]!.srcInMs, sorted[0]!.srcOutMs, '第二行必须紧接第一行')

    /**
     * ⚠️ 上界用**整段时长**（2800ms）而不是「最后一片语音的结束点」（1900ms）。
     *
     * 第一版我按 1900ms 断言，结果红了 —— 而**实现是对的**：
     * VAD 的 `tailKeepMs`（默认 200ms）就是要把语音尾后的自然收尾保留下来，
     * 所以最后一片的 `endMs` 是 2100ms 左右。这是 docs/05 §4.3 明确规定的行为，
     * 不是溢出。**断言写错会让人误以为实现有 bug**，所以这里记一笔。
     */
    const totalMs = 700 + 500 + 700 + 900
    assert.ok(sorted[1]!.srcOutMs <= totalMs, `区间越过了整段音频（${sorted[1]!.srcOutMs} > ${totalMs}）`)
    assert.ok(sorted[1]!.srcOutMs >= 1900, '尾后的自然收尾（tailKeepMs）应当被保留下来')

    // 区间来自 PCM 长度（2800ms），不是 ffprobe 的 60000
    assert.ok(sorted[1]!.srcOutMs < 60_000, '切句后不应再用 ffprobe 的时长')
  })

  it('解码成功但整段没有静音时兜底为按比例切分，导入仍然成功', async () => {
    // 连续 2 秒正弦：VAD 会因为「没有静音窗口」抛 VAD_NO_SPEECH_FOUND
    const samples = makeSpeechBlocks([[2000, true]])
    const { service, takes, logged } = makeService({
      decodeAudio: async () => ({ samples, sampleRate: 48_000 }),
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    assert.equal(res.createdTakes, 2, '兜底也要把两行都写进去（用户要的是「先能用」）')
    assert.equal(takes.length, 2)
    for (const t of takes) assert.ok(t.srcOutMs > t.srcInMs)

    // 必须留下可排查的日志：方法 + 片数 + 需复核行数
    const info = logged.find((l) => l.event === 'audioImport.fileImported')
    assert.ok(info, '必须有 fileImported 日志')
    assert.equal(info.fields?.splitMethod, 'whole-timeline')
    assert.equal(info.fields?.sliceCount, 1)

    // 并且要显式警告（warn 事件）
    assert.ok(
      logged.some((l) => l.event === 'audioImport.splitWarning'),
      '兜底路径必须 warn，否则「为什么这次切得不准」永远查不出来',
    )
  })

  it('解码失败（返回 null）时退回整段并 warn，不让导入失败', async () => {
    const { service, takes, logged } = makeService({
      decodeAudio: async () => null,
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    assert.equal(res.createdTakes, 2, '解码不了也要让导入可用')
    for (const t of takes) {
      assert.equal(t.srcInMs, 0)
      assert.equal(t.srcOutMs, 60_000)
    }
    const info = logged.find((l) => l.event === 'audioImport.fileImported')
    assert.equal(info?.fields?.splitMethod, 'none')
  })

  it('解码抛错时同样退回整段并记 decodeFailed 日志', async () => {
    const { service, takes, logged } = makeService({
      decodeAudio: async () => {
        throw new Error('WAV 头损坏（模拟）')
      },
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })

    assert.equal(res.createdTakes, 2)
    assert.equal(takes[0]!.srcOutMs, 60_000)
    assert.ok(
      logged.some((l) => l.event === 'audioImport.decodeFailed'),
      '解码抛错必须留日志（否则「为什么没有逐行区间」查不出来）',
    )
  })

  it('多角色文件把该 CV 名下所有角色的行都写入', async () => {
    const { service, takes } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}` }],
    })
    assert.equal(res.createdTakes, 3, '女龙套2(1) + 木瓜(2) 共 3 句')
    assert.equal(new Set(takes.map((t) => t.lineId)).size, 3, '写在三个不同的行上')
  })

  it('只处理 onlyFiles 指定的文件', async () => {
    const { service } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }, { filePath: `${SRC}/${FILE_MULTI}` }],
      onlyFiles: [FILE_MULTI],
    })
    assert.equal(res.files, 1, '只处理了 1 个文件')
    assert.equal(res.createdTakes, 3)
  })

  it('skipNeedsReview 会跳过需人工确认的文件', async () => {
    const { service } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIZHIJIAN}` }],
      skipNeedsReview: true,
    })
    assert.equal(res.createdTakes, 0)
    assert.equal(res.skipped.length, 1)
    assert.match(res.skipped[0]!.reason, /需人工确认/)
  })

  it('区间不在画本里的文件被跳过并给出原因（不是静默忽略）', async () => {
    const { service } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_NARRATION}` }],
    })
    assert.equal(res.createdTakes, 0)
    assert.equal(res.skipped.length, 1)
    assert.ok(res.skipped[0]!.reason.length > 0)
  })

  it('文件名不合法 → 跳过并记原因，不抛错', async () => {
    const { service } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      // 文件名不合规 → 在「解析文件名」这一步就被挡下，不会走到读源文件
      files: [{ filePath: `${SRC}/readme.txt` }],
    })
    assert.equal(res.createdTakes, 0)
    assert.equal(res.skipped.length, 1)
    assert.match(res.skipped[0]!.reason, /文件名/)
  })

  /**
   * 单个文件失败不能毁掉整批导入 —— 这是「面对整个文件夹操作」的基本要求。
   */
  it('某个文件复制失败时，其它文件照常导入', async () => {
    let n = 0
    const { service, takes } = makeService({
      copyIntoProject: async ({ sourcePath, relativeTarget }) => {
        n++
        if (n === 1) throw new Error('磁盘已满（模拟）')
        // 第二个文件仍要真的落盘，否则测不到「失败一个不毁整批」的后半段
        const absolutePath = join(COPY_ROOT, relativeTarget)
        mkdirSync(dirname(absolutePath), { recursive: true })
        copyFileSync(sourcePath, absolutePath)
        return { relativePath: relativeTarget, absolutePath }
      },
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }, { filePath: `${SRC}/${FILE_MULTI}` }],
    })
    assert.equal(res.files, 2)
    assert.equal(res.skipped.length, 1, '第一个文件失败被如实记录')
    assert.equal(res.createdTakes, 3, '第二个文件（多角色 3 行）仍然导入成功')
    assert.equal(takes.length, 3)
  })

  it('探测不到时长（无 ffmpeg）不影响导入', async () => {
    const { service, takes } = makeService({ probeDurationMs: async () => null })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })
    assert.equal(res.createdTakes, 2, '时长缺失只是展示信息，不该阻断导入')
    assert.equal(takes[0]!.durationMs, 0)
  })

  /**
   * 真机需求：「以后解析不出的可以在处理里自己选择哪个 CV 或者角色」。
   *
   * 这条用例走完整链路：文件名解析失败 → 用户补章节区间 + 指定角色 → 真的写入 take。
   * 以前 applyImport 在 parseAudioFileName 失败时就 continue 了，界面上指定了也没用。
   */
/**
   * 真机需求：「需要音频转文字 记录每段文字的位置后分割 导入速度无所谓」。
   *
   * 这条走完整链路：识别段（文字 + 起止）→ 文本强制对齐 → 写入 take 的 srcIn/srcOut。
   * 断言两件事：
   *   · `splitMethod === 'asr'`（界面据此说「按识别文本对齐」，而不是「按停顿估计」）；
   *   · take 的区间**等于识别段的边界**（句间停顿归前一行，与 VAD 路径同一口径）。
   */
  it('有 ASR 时按识别文本对齐：区间 = 识别段边界（splitMethod=asr）', async () => {
    const seenPaths: string[] = []
    const { service, takes, logged } = makeService({
      // 假引擎：不碰真进程，只回两段与画本行对得上的识别文本
      asr: {
        availability: () => ({ ok: true, reason: null, binary: 'whisper-cli.exe', model: 'ggml-small.bin' }),
        transcribe: async (input: { absolutePath: string }) => {
          seenPaths.push(input.absolutePath)
          return {
            shape: 'whisper.cpp' as const,
            elapsedMs: 12,
            segments: [
              { startMs: 800, endMs: 6100, text: '第2221章石玉凤的台词' },
              { startMs: 9000, endMs: 15200, text: '第2225章石玉凤的台词' },
            ],
          }
        },
      } as never,
    })
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_SHIYUFENG}` }],
    })
    assert.equal(res.perFile[0]!.splitMethod, 'asr')
    assert.equal(res.createdTakes, 2)
    assert.equal(seenPaths.length, 1, '每个文件识别一次')
    // 第一行：从第一段起点到**第二段起点**（句间停顿归前一行）
    assert.equal(takes[0]!.srcInMs, 800)
    assert.equal(takes[0]!.srcOutMs, 9000)
    // 第二行：从第二段起点收到音频末尾（不留尾巴）
    assert.equal(takes[1]!.srcInMs, 9000)
    assert.equal(takes[1]!.srcOutMs, 60_000)
    assert.ok(
      logged.some((l) => l.event === 'audioImport.asrAligned'),
      '识别对齐必须留下日志（用户问「为什么这行慢」时能答）',
    )
  })
  it('文件名解析不出 + 人工补区间与角色 → 仍然真的导入', async () => {
    const badPath = writeSource('最终版-配音-勿删.wav')
    const { service, takes } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [
        {
          filePath: badPath,
          overrides: { character: '石玉凤', fromChapter: 2221, toChapter: 2225 },
        },
      ],
    })
    assert.equal(res.createdTakes, 2, '石玉凤在 2221~2225 里有 2 句')
    assert.equal(takes.length, 2)
    assert.equal(res.skipped.length, 0)
  })

  it('文件名解析不出且没补区间 → 跳过，但原因里说明怎么补', async () => {
    const badPath = writeSource('另一个-看不懂的名字.wav')
    const { service } = makeService()
    const res = await service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: badPath }],
    })
    assert.equal(res.createdTakes, 0)
    assert.equal(res.skipped.length, 1)
    assert.match(res.skipped[0]!.reason, /文件名无法解析/)
    assert.match(res.skipped[0]!.reason, /指定说话人/, '要告诉用户去哪儿补')
  })
})

describe('scanAudioFiles：目录遍历（用真实临时目录）', () => {
  /**
   * 这一组用**真实文件系统**（`mkdtempSync`）而不是假的对象。
   *
   * 因为要验证的正是「遍历本身」：非递归不进屋、递归进屋、坏文件名被过滤、
   * 目录读取失败不中断。用假的 `readdirSync` 就测不到这些。
   */
  function makeTree(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'ns-import-scan-'))
    // 顶层：2 个合规 + 2 个不合规
    writeFileSync(join(root, '2221-2230-石玉凤-德钦.mp3'), 'x')
    writeFileSync(join(root, '2221-2230-多角色-兔小舟.mp3'), 'x')
    writeFileSync(join(root, 'readme.txt'), 'x')
    writeFileSync(join(root, '没有章节区间.mp3'), 'x')
    // 隐藏文件必须被跳过
    writeFileSync(join(root, '.hidden-2221-2230-A-B.mp3'), 'x')
    // 子目录：1 个合规
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', '2231-2240-石志坚-月光.mp3'), 'x')
    // 二级子目录：1 个合规（测递归深度）
    mkdirSync(join(root, 'sub', 'deep'))
    writeFileSync(join(root, 'sub', 'deep', '2241-2250-旁白-语心草.mp3'), 'x')
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  it('非递归只扫顶层；隐藏文件与非音频文件跳过；**命名不合规的音频要带出来**', async () => {
    const { root, cleanup } = makeTree()
    try {
      const { service } = makeService()
      const found = await service.scanAudioFiles({ dir: root })
      const names = found.map((f) => f.fileName).sort()
      assert.deepEqual(names, ['2221-2230-多角色-兔小舟.mp3', '2221-2230-石玉凤-德钦.mp3', '没有章节区间.mp3'])
      assert.equal(
        found.some((f) => f.fileName.startsWith('.')),
        false,
        '隐藏文件必须跳过（macOS/Windows 都会生成 ._ 之类）',
      )
      assert.equal(found.some((f) => f.fileName === 'readme.txt'), false, '非音频扩展名不看')
      // 真机反馈「24 个文件只扫出 6 个」：解析失败的文件以前被静默丢掉，
      // 用户只看到一个变小的数字。现在必须带出来（UI 会列「跳过了哪些、为什么」）。
      const bad = found.find((f) => f.fileName === '没有章节区间.mp3')
      assert.ok(bad?.parseError, '解析失败的文件也要在候选里，并说明原因')
      assert.equal(bad!.parseError!.reason, 'no-chapter-range')
      assert.equal(found.filter((f) => !f.parseError).length, 2, '合规的仍是 2 个')
    } finally {
      cleanup()
    }
  })

  it('递归时把子目录（含二级）的文件一并扫出来', async () => {
    const { root, cleanup } = makeTree()
    try {
      const { service } = makeService()
      const found = await service.scanAudioFiles({ dir: root, recursive: true })
      // 3 个顶层音频（含 1 个命名不合规）+ 子目录 1 + 二级子目录 1
      assert.equal(found.length, 5, `应当扫到 5 个音频文件，实际 ${JSON.stringify(found.map((f) => f.fileName))}`)
      assert.ok(found.some((f) => f.fileName === '2241-2250-旁白-语心草.mp3'), '二级子目录的文件也要扫到')
    } finally {
      cleanup()
    }
  })

  it('结果按路径排序（顺序稳定，UI 表格不会每次刷新都变）', async () => {
    const { root, cleanup } = makeTree()
    try {
      const { service } = makeService()
      const found = await service.scanAudioFiles({ dir: root, recursive: true })
      const paths = found.map((f) => f.filePath)
      assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)))
    } finally {
      cleanup()
    }
  })

  it('带出真实文件大小（用于 UI 显示体积合计）', async () => {
    const { root, cleanup } = makeTree()
    try {
      const { service } = makeService()
      const found = await service.scanAudioFiles({ dir: root })
      for (const f of found) assert.ok(f.sizeBytes > 0, `${f.fileName} 的大小应当 > 0`)
    } finally {
      cleanup()
    }
  })

  it('探测时长失败时留 null，而不是中断整批扫描', async () => {
    const { root, cleanup } = makeTree()
    try {
      // 第一次探测抛错（模拟坏文件），之后正常 —— 扫描必须继续
      let n = 0
      const { service } = makeService({
        probeDurationMs: async () => {
          n++
          if (n === 1) throw new Error('坏文件（模拟）')
          return 1234
        },
      })
      const found = await service.scanAudioFiles({ dir: root })
      assert.equal(found.length, 3, '一个文件探测失败不该影响其它文件')
      assert.equal(found.filter((f) => f.durationMs === null).length, 1, '失败的那个留 null')
    } finally {
      cleanup()
    }
  })

  it('未注入探测函数时时长全为 null（未装 ffmpeg 的情形）', async () => {
    const { root, cleanup } = makeTree()
    try {
      const { service } = makeService({ probeDurationMs: undefined })
      const found = await service.scanAudioFiles({ dir: root })
      assert.equal(found.length, 3)
      for (const f of found) assert.equal(f.durationMs, null)
    } finally {
      cleanup()
    }
  })

  it('目录不存在时返回空数组并记 warn（不抛错）', async () => {
    const { service, logged } = makeService()
    const found = await service.scanAudioFiles({ dir: join(tmpdir(), 'ns-绝对不存在的目录-zzz') })
    assert.deepEqual(found, [])
    assert.ok(
      logged.some((l) => l.event === 'audioImport.scanDirFailed'),
      '读不到目录应当记一条 warn —— 静默返回空数组会让用户以为「文件夹里没文件」',
    )
  })
})

describe('文档解析缓存（避免同一份画本被解析三次）', () => {
  /**
   * 正常流程会三次请求同一份画本：扫描 → 预览 → 导入。
   * 真实样本里最大的画本是 2.13 MB / 16,537 行，每次都重新解析会让用户明显感到卡。
   *
   * 但缓存最怕的是**用旧内容**：用户在导入过程中换了画本，
   * 第二次预览却仍按旧内容算 —— 那正是「预览与实际不一致」的温床。
   * 所以下面既测「命中」，也测「该失效时必须失效」。
   */
  function makeCountingService(): {
    service: ReturnType<typeof createAudioImportService>
    reads: () => number
    /** 模拟「用户换了画本」：改 mtime */
    bumpMtime: () => void
  } {
    let reads = 0
    let mtime = 1000
    const built = makeService({
      readDocument: async () => {
        reads++
        return CANVAS_TEXT
      },
      mtimeOf: async () => mtime,
    })
    return { service: built.service, reads: () => reads, bumpMtime: () => { mtime += 1 } }
  }

  it('同一份画本 + mtime 未变 → 只解析一次（三次调用命中缓存）', async () => {
    const { service, reads } = makeCountingService()
    await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    assert.equal(reads(), 1, '第一次必然真解析')
    await service.buildPlan({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH, files: [] })
    assert.equal(reads(), 1, '第二次应当命中缓存')
    await service.applyImport({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH, files: [] })
    assert.equal(reads(), 1, '第三次应当命中缓存')
  })

  it('mtime 变了 → 缓存失效，重新解析（不能用旧内容）', async () => {
    const { service, reads, bumpMtime } = makeCountingService()
    await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    assert.equal(reads(), 1)
    bumpMtime()
    await service.buildPlan({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH, files: [] })
    assert.equal(reads(), 2, '画本变了必须重新解析 —— 否则预览按旧内容算')
  })

  it('换了画本路径 → 缓存失效', async () => {
    const { service, reads } = makeCountingService()
    await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: 'C:/other/别的画本.docx' })
    assert.equal(reads(), 2, '不同路径不能共用缓存')
  })

  it('换了书 → 缓存失效（同一份画本在不同书下对齐出的章节不同）', async () => {
    const { service, reads } = makeCountingService()
    await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    await service.scanCanvas({ projectId: PROJECT, bookId: '另一本书', canvasPath: CANVAS_PATH })
    assert.equal(reads(), 2, '换书必须重新对齐')
  })

  it('没注入 mtimeOf → 完全不用缓存（每次真解析）', async () => {
    let reads = 0
    const { service } = makeService({
      readDocument: async () => {
        reads++
        return CANVAS_TEXT
      },
      mtimeOf: undefined,
    })
    await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    assert.equal(reads, 2, '不知道文件有没有变就不该用缓存（保守策略）')
  })

  it('缓存命中时结果与真解析完全一致（不能因为缓存而少算）', async () => {
    const { service } = makeCountingService()
    const first = await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    const second = await service.scanCanvas({ projectId: PROJECT, bookId: BOOK, canvasPath: CANVAS_PATH })
    assert.deepEqual(second.chapters, first.chapters)
    assert.deepEqual(second.canvasCvs, first.canvasCvs)
    assert.equal(second.chapters.length, CANVAS_TO - CANVAS_FROM + 1)
  })
})

// ---------------------------------------------------------------------------
// 最重要的一组：预览与实际导入必须一致
// ---------------------------------------------------------------------------

describe('预览与实际导入必须一致', () => {
  /**
   * 这条断言防的是**最危险的一类缺陷**：
   *   预览走文档行、导入走数据库行。若两边选行逻辑不同，
   *   会出现「预览 40 行、实际写入 2 条」—— 两边都不报错，只是数量对不上。
   */
  it('每个文件的「预览行数」与「实际写入 take 数」一致', async () => {
    const files = [
      FILE_SHIYUFENG,
      FILE_SHIZHIJIAN,
      FILE_MULTI,
      FILE_MULTI_CHUNGE,
    ].map((n) => ({ filePath: `${SRC}/${n}` }))

    const preview = makeService()
    const { plan } = await preview.service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files,
    })

    const applied = makeService()
    const res = await applied.service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files,
    })

    const plannedTotal = plan.files
      .filter((f) => f.status === 'ready' || f.status === 'needs-review' || f.status === 'duplicate-lines')
      .reduce((n, f) => n + f.lineCount, 0)

    assert.equal(
      res.createdTakes,
      plannedTotal,
      `预览计划 ${plannedTotal} 行，实际写入 ${res.createdTakes} 条 —— ` +
        '两者必须相等，否则说明预览与导入用了不同的选行逻辑',
    )

    // 逐文件比对，失败时能直接看出是哪个文件漂了
    for (const f of plan.files) {
      if (f.status === 'no-lines' || f.status === 'invalid-name') continue
      const detail = res.perFile.find((p) => p.fileName === f.fileName)
      assert.ok(detail, `${f.fileName} 应当出现在执行明细里`)
      assert.equal(
        detail!.lineCount,
        f.lineCount,
        `${f.fileName}：预览 ${f.lineCount} 行，导入时匹配到 ${detail!.lineCount} 行`,
      )
      assert.equal(
        detail!.createdTakes,
        f.lineCount,
        `${f.fileName}：预览 ${f.lineCount} 行，实际写入 ${detail!.createdTakes} 条`,
      )
    }
  })

  it('人工修正后仍然一致', async () => {
    const files = [
      { filePath: `${SRC}/${FILE_MULTI}`, overrides: { character: '木瓜' } },
      { filePath: `${SRC}/${FILE_MULTI_CHUNGE}`, overrides: { narration: true } },
    ]
    const preview = makeService()
    const { plan } = await preview.service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files,
    })
    const applied = makeService()
    const res = await applied.service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files,
    })

    const plannedTotal = plan.files
      .filter((f) => f.status !== 'no-lines' && f.status !== 'invalid-name')
      .reduce((n, f) => n + f.lineCount, 0)
    assert.equal(res.createdTakes, plannedTotal, '人工修正后仍必须一致')
    assert.equal(res.createdTakes, 8, '木瓜 2 行 + 2221~2230 的旁白 6 行 = 8')
  })

  it('多角色与非多角色的结果不同（证明 target 真的生效，不是碰巧相等）', async () => {
    const multiRun = makeService()
    const multi = await multiRun.service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}` }],
    })
    const singleRun = makeService()
    const single = await singleRun.service.applyImport({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}`, overrides: { character: '木瓜' } }],
    })
    assert.equal(multi.createdTakes, 3, '多角色：该 CV 名下两个角色都算（女龙套2 1 句 + 木瓜 2 句）')
    assert.equal(single.createdTakes, 2, '指定角色：只算木瓜这一个角色的 2 句')
    assert.notEqual(multi.createdTakes, single.createdTakes)
  })
})

// ---------------------------------------------------------------------------
// 人工修正（UI 的「指定说话人」走的就是这条路径）
// ---------------------------------------------------------------------------

describe('修正后重新预览：结果必须真的变（UI 强制重算的依据）', () => {
  /**
   * 这组用例支撑 UI 里的一个**硬性做法**：
   * 用户在「指定说话人」对话框里改完之后，向导**必须重新调 `record:importPlan`**，
   * 不能在本地的数字上做加减。
   *
   * 因为换个说话人，命中行数就变了（多角色 → 单角色会变少，未解析 → 角色会从 0 变正）。
   * 若界面自己改数字，用户看到的与实际导入的就会不一致 ——
   * 正是本功能最要避免的「预览与导入漂移」。
   */
  it('把「多角色」改成一个角色 → 命中行数变少', async () => {
    const { service } = makeService()
    const before = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}` }],
    })
    const after = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}`, overrides: { character: '木瓜' } }],
    })
    const a = before.plan.files[0]!
    const b = after.plan.files[0]!
    assert.equal(a.targetKind, 'multiRole')
    assert.equal(a.lineCount, 3)
    assert.equal(b.lineCount, 2, '指定单一角色后只算那个角色的行')
    assert.ok(b.lineCount < a.lineCount, '修正后行数必须真的变化 —— 否则 UI 重算就是多余的')
  })

  it('从未解析改成指定角色 → 从 0 行变成有行', async () => {
    const { service } = makeService()
    const before = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/2221-2230-多角色-查无此人.mp3` }],
    })
    const a = before.plan.files[0]!
    assert.equal(a.status, 'needs-review')
    assert.equal(a.targetKind, 'unknown')
    assert.equal(a.lineCount, 0, '说话人判不出来时不该猜任何行')

    const after = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/2221-2230-多角色-查无此人.mp3`, overrides: { character: '木瓜' } }],
    })
    const b = after.plan.files[0]!
    assert.equal(b.status, 'ready', '人工指定后应当就绪')
    assert.equal(b.lineCount, 2, '变成木瓜的 2 句')
  })

  it('改成旁白 → 取旁白行（与角色行互不重叠）', async () => {
    const { service } = makeService()
    const asNarration = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}`, overrides: { narration: true } }],
    })
    const f = asNarration.plan.files[0]!
    assert.equal(f.targetKind, 'narration')
    // fixture 只有 2221~2226 六章，每章 1 句纯旁白；群白（【异口同声】）不算旁白
    assert.equal(f.lineCount, CANVAS_TO - CANVAS_FROM + 1)
    // 而且应当与「按角色」取到的行完全不同（旁白 vs 对白）
    assert.ok(f.samples.length > 0)
    assert.equal(
      f.samples.every((s) => s.character === '旁白'),
      true,
      `旁白行的 character 应为「旁白」，实际 ${JSON.stringify(f.samples.map((s) => s.character))}`,
    )
  })

  it('清除修正后回到自动判定结果', async () => {
    const { service } = makeService()
    const auto = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}` }],
    })
    // 先带修正，再显式传 null（UI 的「清除修正」按钮）
    const cleared = await service.buildPlan({
      projectId: PROJECT,
      bookId: BOOK,
      canvasPath: CANVAS_PATH,
      files: [{ filePath: `${SRC}/${FILE_MULTI}`, overrides: { character: null } }],
    })
    assert.equal(
      cleared.plan.files[0]!.lineCount,
      auto.plan.files[0]!.lineCount,
      'character: null 应当等同于「没有修正」',
    )
  })
})
