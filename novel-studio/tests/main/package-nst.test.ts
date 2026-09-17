/**
 * Novel Studio · 任务包（.nst）构造、导出与解析测试
 * ============================================================================
 * 运行：
 *   node --experimental-strip-types tests/main/package-nst.test.ts
 *
 * 本文件守护：
 *   · `computeLinesHash`：同输入稳定；文本/情绪/停顿/说话人/顺序任一改动都会变化；
 *     **下发时算的哈希 == 用任务包行重算的哈希**（否则回收会误判「画本已变更」）
 *   · `buildNstLine`：上下文（前后行）、表演提示、发音提示、备注、旁白与角色名
 *   · `exportTaskPackage`：包结构、进度回调、可取消、checksums 真实可校验
 *   · `parseTaskPackage`：缺 manifest / 版本过高 / 结构异常的报错码正确；
 *     takes.json 损坏不整体失败
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { isAppError } from '../../src/shared/errors.ts'
import type { CanvasLine, Character } from '../../src/shared/types.ts'
import {
  buildNstLine,
  buildNstLines,
  computeLinesHash,
  createPackageId,
  diffLines,
  exportTaskPackage,
  lineSignature,
  listSlotEntries,
  parseSlotPath,
  parseTaskPackage,
  parseTakesFile,
  resolveSpeakerName,
  speakerKey,
} from '../../src/main/features/book/package/nst.ts'
import {
  CHECKSUMS_FILE,
  DEFAULT_RECORD_SETTINGS,
  MANIFEST_FILE,
  SLOTS_DIR,
  TASK_FILE,
  TAKES_FILE,
  buildNstManifest,
  validateNstManifest,
} from '../../src/main/features/book/package/manifest.ts'
import { openZip } from '../../src/main/features/book/package/zip/reader.ts'
import { createStoreZipWriter } from '../../src/main/features/book/package/zip/writer.ts'
import { parseChecksumsFile, verifyPackage } from '../../src/main/features/book/package/checksums.ts'
import { createSilentWav } from '../../src/main/features/book/package/wav.ts'

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const BOOK_ID = 'book-1'
const PROJECT_ID = 'proj-1'

const XIAO_YAN: Character = {
  id: 'char-xy',
  bookId: BOOK_ID,
  name: '萧炎',
  aliases: ['炎帝', '三少爷'],
  gender: 'male',
  ageGroup: 'young',
  description: '少年，语气倔强',
  note: null,
  color: '#f00',
  defaultSpeed: 'normal',
  defaultEmotion: '平静',
  defaultGainDb: null,
  defaultPauseMs: null,
  isArchived: false,
  sortOrder: 1,
  createdAt: 0,
  updatedAt: 0,
}

const YAO_LAO: Character = { ...XIAO_YAN, id: 'char-yl', name: '药老', aliases: ['药尘'], sortOrder: 2 }

function makeLine(patch: Partial<CanvasLine> & { id: string; seq: number; text: string }): CanvasLine {
  return {
    chapterId: 'ch-1',
    bookId: BOOK_ID,
    // speakerType 只有 'narration' | 'character'（谁在念）；'dialogue' 是 kind（这句是什么）。
    // 角色台词 → speakerType: 'character'，角色 id 指向萧炎。
    speakerType: 'character',
    characterId: XIAO_YAN.id,
    kind: 'dialogue',
    sourceText: null,
    charStart: 0,
    charEnd: patch.text.length,
    emotion: '愤怒',
    emotionIntensity: 4,
    speed: 'fast',
    gainDb: null,
    pauseAfterMs: 600,
    pauseInline: null,
    pronunciation: '行(háng)',
    note: '这里是情绪爆发点，不要喊破音',
    state: 'assigned',
    confidence: 0.9,
    candidates: null,
    decidedBy: 'vector',
    needsReview: false,
    flags: [],
    isTitle: false,
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

const LINES: CanvasLine[] = [
  makeLine({ id: 'line-1', seq: 11, text: '他缓缓抬起头。', speakerType: 'narration', characterId: null, kind: 'narration', emotion: '低沉', pauseAfterMs: 500 }),
  makeLine({ id: 'line-2', seq: 12, text: '我萧炎，从来不会认输。' }),
  makeLine({ id: 'line-3', seq: 13, text: '小子，别冲动。', characterId: YAO_LAO.id, emotion: '焦急', pauseAfterMs: 400 }),
]

const CHARACTERS = [XIAO_YAN, YAO_LAO]

function makeManifest(lines = LINES, overrides: Partial<Parameters<typeof buildNstManifest>[0]> = {}) {
  return buildNstManifest({
    packageId: 'pkg-1',
    source: { projectId: PROJECT_ID, bookId: BOOK_ID, exportedAt: '2026-02-14T10:00:00Z' },
    assignee: { voiceActorId: 'actor-1', name: '小林', note: '录音环境：安静卧室' },
    recordSettings: DEFAULT_RECORD_SETTINGS,
    characters: CHARACTERS.map((c) => ({
      id: c.id,
      name: c.name,
      note: c.description,
      defaultSpeed: c.defaultSpeed,
      defaultEmotion: c.defaultEmotion,
    })),
    lines: buildNstLines(lines, CHARACTERS, { chapterTitle: '第1章 陨落的天才' }),
    linesHash: computeLinesHash(lines),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// linesHash
// ---------------------------------------------------------------------------

describe('computeLinesHash · 画本快照哈希（docs/11 §6.2）', () => {
  it('同输入多次计算结果稳定（64 位十六进制）', () => {
    const a = computeLinesHash(LINES)
    const b = computeLinesHash(LINES.map((l) => ({ ...l })))
    assert.equal(a, b)
    assert.match(a, /^[0-9a-f]{64}$/)
  })

  it('文本、情绪、停顿、说话人、顺序任一改动都会改变哈希', () => {
    const base = computeLinesHash(LINES)

    const textChanged = LINES.map((l, i) => (i === 1 ? { ...l, text: '我萧炎，绝不会认输。' } : l))
    assert.notEqual(computeLinesHash(textChanged), base, '文本改动必须被发现')

    const emotionChanged = LINES.map((l, i) => (i === 1 ? { ...l, emotion: '平静' } : l))
    assert.notEqual(computeLinesHash(emotionChanged), base, '情绪改动必须被发现')

    const pauseChanged = LINES.map((l, i) => (i === 1 ? { ...l, pauseAfterMs: 900 } : l))
    assert.notEqual(computeLinesHash(pauseChanged), base, '停顿改动必须被发现')

    const speakerChanged = LINES.map((l, i) => (i === 1 ? { ...l, characterId: YAO_LAO.id } : l))
    assert.notEqual(computeLinesHash(speakerChanged), base, '说话人改动必须被发现')

    const reordered = [LINES[1], LINES[0], LINES[2]]
    assert.notEqual(computeLinesHash(reordered), base, '顺序改动必须被发现')

    const removed = LINES.slice(0, 2)
    assert.notEqual(computeLinesHash(removed), base, '行数变化必须被发现')
  })

  it('画本行与任务包行算出同一个哈希（旁白标签被归一）', () => {
    const nstLines = buildNstLines(LINES, CHARACTERS, { chapterTitle: '第1章' })
    assert.equal(
      computeLinesHash(nstLines),
      computeLinesHash(LINES),
      '两者不一致会让「重新下发后立即被判定为画本已变更」',
    )
    assert.equal(speakerKey({ id: 'x', text: 't', speaker: '旁白' }), 'narration')
    assert.equal(speakerKey({ id: 'x', text: 't', speakerType: 'narration' }), 'narration')
    assert.equal(speakerKey({ id: 'x', text: 't', characterId: 'char-1' }), 'char-1')
  })

  it('lineSignature 的分隔符不会被内容碰撞（含分隔符的文本不会误判相同）', () => {
    const a = lineSignature({ id: 'l1', text: 'a\u001fb', emotion: '平静' })
    const b = lineSignature({ id: 'l1', text: 'a', emotion: 'b' })
    assert.notEqual(a, b)
    assert.notEqual(computeLinesHash([{ id: 'l1', text: 'a\u001fb' }]), computeLinesHash([{ id: 'l1', text: 'a', pauseAfterMs: 0 }]))
  })

  it('diffLines 正确区分新增 / 删除 / 修改', () => {
    const prev = buildNstLines(LINES, CHARACTERS, { chapterTitle: '第1章' })
    const current = [
      { ...LINES[0], text: '（旁白）他缓缓抬起了头。' }, // 修改
      LINES[1], // 不变
      // line-3 删除
      makeLine({ id: 'line-4', seq: 14, text: '新增的行' }), // 新增
    ]
    const diff = diffLines(prev, current)
    assert.deepEqual(diff.modified, ['line-1'])
    assert.deepEqual(diff.removed, ['line-3'])
    assert.deepEqual(diff.added, ['line-4'])
    assert.equal(diff.unchanged, 1)
    assert.equal(diff.count, 3)
    assert.equal(diff.changed, true)

    const clean = diffLines(prev, buildNstLines(LINES, CHARACTERS, { chapterTitle: '第1章' }))
    assert.equal(clean.changed, false)
    assert.equal(clean.count, 0)
  })
})

// ---------------------------------------------------------------------------
// buildNstLine
// ---------------------------------------------------------------------------

describe('buildNstLine · 任务包行（docs/03 §9 / docs/11 §6.2）', () => {
  it('上下文按「（角色名）文本」渲染，旁白也带前缀', () => {
    const line = buildNstLine(LINES[1], CHARACTERS, {
      chapterTitle: '第1章 陨落的天才',
      prev: { text: '他缓缓抬起头。', characterName: '旁白' },
      next: { text: '小子，别冲动。', characterName: '药老' },
      hasReference: true,
    })
    assert.equal(line.prevLine, '（旁白）他缓缓抬起头。')
    assert.equal(line.nextLine, '（药老）小子，别冲动。')
    assert.equal(line.hasReference, true)
    assert.equal(line.chapterTitle, '第1章 陨落的天才')
    assert.equal(line.characterId, XIAO_YAN.id)
    assert.equal(line.characterName, '萧炎')
  })

  it('表演提示与发音提示：情绪 / 强度 / 语速 / 停顿 / 发音 / 备注原样带出', () => {
    const line = buildNstLine(LINES[1], CHARACTERS, { chapterTitle: '第1章' })
    assert.equal(line.emotion, '愤怒')
    assert.equal(line.emotionIntensity, 4)
    assert.equal(line.speed, 'fast')
    assert.equal(line.pauseAfterMs, 600)
    assert.equal(line.pronunciation, '行(háng)')
    assert.equal(line.note, '这里是情绪爆发点，不要喊破音')
    assert.equal(line.text, '我萧炎，从来不会认输。')
  })

  it('旁白行：characterId 为 null、characterName 为「旁白」', () => {
    const line = buildNstLine(LINES[0], CHARACTERS, { chapterTitle: '第1章' })
    assert.equal(line.characterId, null)
    assert.equal(line.characterName, '旁白')
  })

  it('选项可关闭上下文 / 备注 / 发音提示（docs/11 §6.2 的勾选项）', () => {
    const line = buildNstLine(LINES[1], CHARACTERS, {
      chapterTitle: '第1章',
      prev: '前一行',
      next: '后一行',
      includeContext: false,
      includeNotes: false,
      includePronunciation: false,
    })
    assert.equal(line.prevLine, null)
    assert.equal(line.nextLine, null)
    assert.equal(line.note, null)
    assert.equal(line.pronunciation, null)
    assert.equal(line.text, '我萧炎，从来不会认输。', '文本永远保留')
  })

  it('角色表用 Map 或数组都支持；查不到角色时用兜底名', () => {
    const map = new Map(CHARACTERS.map((c) => [c.id, c]))
    assert.equal(resolveSpeakerName(LINES[1], map), '萧炎')
    assert.equal(resolveSpeakerName(LINES[1], [XIAO_YAN]), '萧炎')
    assert.equal(resolveSpeakerName({ speakerType: 'character', characterId: 'ghost' }, map, '未知角色'), '未知角色')
  })

  it('buildNstLines 自动按顺序补齐 prev/next 上下文', () => {
    const lines = buildNstLines(LINES, CHARACTERS, { chapterTitle: '第1章' })
    assert.equal(lines.length, 3)
    assert.equal(lines[0].prevLine, null, '首行没有上一行')
    assert.equal(lines[0].nextLine, '（萧炎）我萧炎，从来不会认输。')
    assert.equal(lines[1].prevLine, '（旁白）他缓缓抬起头。')
    assert.equal(lines[1].nextLine, '（药老）小子，别冲动。')
    assert.equal(lines[2].nextLine, null, '末行没有下一行')
    assert.equal(lines[1].chapterTitle, '第1章')
  })

  it('章节标题可按行覆盖（跨章导出）', () => {
    const lines = buildNstLines(LINES, CHARACTERS, {
      chapterTitle: '默认',
      chapterTitleOf: (line) => (line.chapterId === 'ch-1' ? '第1章' : '第2章'),
    })
    assert.equal(lines[0].chapterTitle, '第1章')
  })
})

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

describe('exportTaskPackage · 导出编排', () => {
  it('包结构完整：manifest.json / task.json / checksums.sha256 / slots/，并带参考音', async () => {
    const zip = createStoreZipWriter()
    const stages: string[] = []
    const manifest = makeManifest()
    const reference = Buffer.from(createSilentWav({ sampleRate: 48000, bitDepth: 24, durationMs: 50 }))

    const result = await exportTaskPackage({
      zip,
      manifest,
      referenceFiles: [{ name: 'line-2_opponent.wav', data: reference }],
      onProgress: (p) => stages.push(p.stage),
    })

    assert.equal(result.packageId, 'pkg-1')
    assert.equal(result.linesHash, manifest.linesHash)
    assert.ok(stages.length >= 5, '应持续上报进度')
    assert.equal(stages[stages.length - 1], '导出完成')

    const reader = openZip(zip.toBuffer())
    const names = reader.listEntries().map((e) => e.name)
    assert.deepEqual(
      names.sort(),
      [CHECKSUMS_FILE, MANIFEST_FILE, TASK_FILE, 'reference/line-2_opponent.wav'].sort(),
    )
    assert.equal(reader.listEntries({ includeDirectories: true }).some((e) => e.name === `${SLOTS_DIR}/`), true)
  })

  it('checksums.sha256 覆盖 manifest / task / reference，且能真校验通过', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    await exportTaskPackage({
      zip,
      manifest,
      referenceFiles: [{ name: 'ref.wav', data: Buffer.from(createSilentWav({ sampleRate: 48000, bitDepth: 24, durationMs: 30 })) }],
    })
    const reader = openZip(zip.toBuffer())
    const entries = parseChecksumsFile(reader.readText(CHECKSUMS_FILE))
    assert.deepEqual(entries.map((e) => e.path).sort(), [MANIFEST_FILE, TASK_FILE, 'reference/ref.wav'].sort())
    const verify = verifyPackage(reader, entries)
    assert.deepEqual(verify.mismatch, [])
    assert.deepEqual(verify.missing, [])
    assert.equal(verify.ok.length, 3)
  })

  it('可取消：取消后抛 TASK_CANCELLED 并清理半成品', async () => {
    const controller = new AbortController()
    const zip = createStoreZipWriter({ signal: controller.signal })
    controller.abort()
    await assert.rejects(
      () => exportTaskPackage({ zip, manifest: makeManifest(), signal: controller.signal }),
      (e: unknown) => isAppError(e) && e.key === 'TASK_CANCELLED',
    )
    assert.equal(zip.entries.length, 0, '取消后不应留下已写入的条目')
  })

  it('createPackageId 产出 uuid 形状的 id', () => {
    assert.match(createPackageId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

describe('parseTaskPackage · 解析与报错码', () => {
  it('往返一致：manifest / lines 原样读回', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    await exportTaskPackage({ zip, manifest })
    const parsed = parseTaskPackage(openZip(zip.toBuffer()))

    assert.equal(parsed.manifest.packageId, manifest.packageId)
    assert.equal(parsed.manifest.linesHash, manifest.linesHash)
    assert.equal(parsed.manifest.assignee.name, '小林')
    assert.equal(parsed.lines.length, 3)
    assert.deepEqual(parsed.lines[1], manifest.lines[1])
    assert.equal(parsed.hasTakesFile, false)
    assert.equal(parsed.takes, null)
    assert.equal(parsed.consistent, true)
    assert.deepEqual(parsed.warnings, [])
  })

  it('缺 task.json 与 manifest.json → PACKAGE_INVALID（reason=task-file-missing）', () => {
    const zip = createStoreZipWriter()
    const reader0 = (() => {
      const w = createStoreZipWriter()
      void w.addFile('other.txt', Buffer.from('x'))
      return w
    })()
    void zip
    return reader0.finalize().then(() => {
      assert.throws(
        () => parseTaskPackage(openZip(reader0.toBuffer())),
        (e: unknown) => {
          assert.ok(isAppError(e))
          assert.equal(e.key, 'PACKAGE_INVALID')
          assert.equal(e.details?.reason, 'task-file-missing')
          return true
        },
      )
    })
  })

  it('格式版本过高 → PACKAGE_VERSION_TOO_NEW（带 version 参数，UI 直接可渲染）', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    await zip.addFile(TASK_FILE, Buffer.from(JSON.stringify({ ...manifest, formatVersion: 99 }), 'utf8'))
    await zip.finalize()
    assert.throws(
      () => parseTaskPackage(openZip(zip.toBuffer())),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_VERSION_TOO_NEW')
        assert.equal(e.params.version, '99')
        return true
      },
    )
  })

  it('lines 结构异常（不是数组）→ PACKAGE_INVALID（details 里带全部字段错误）', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    await zip.addFile(TASK_FILE, Buffer.from(JSON.stringify({ ...manifest, lines: 'not-an-array' }), 'utf8'))
    await zip.finalize()
    assert.throws(
      () => parseTaskPackage(openZip(zip.toBuffer())),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_INVALID')
        assert.equal(e.details?.reason, 'manifest-invalid')
        assert.equal((e.details?.errors as string[]).some((m) => m.includes('lines')), true)
        return true
      },
    )
  })

  it('缺必填字段（assignee.name）→ PACKAGE_INVALID 且列出缺失项', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    const broken = { ...manifest, assignee: { voiceActorId: null, note: null } }
    await zip.addFile(TASK_FILE, Buffer.from(JSON.stringify(broken), 'utf8'))
    await zip.finalize()
    assert.throws(
      () => parseTaskPackage(openZip(zip.toBuffer())),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal((e.details?.errors as string[]).some((m) => m.includes('assignee.name')), true)
        return true
      },
    )
  })

  it('TASK_FILE 不是合法 JSON → PACKAGE_INVALID（reason=json-parse-failed）', async () => {
    const zip = createStoreZipWriter()
    await zip.addFile(TASK_FILE, Buffer.from('{ 这不是 JSON', 'utf8'))
    await zip.finalize()
    assert.throws(
      () => parseTaskPackage(openZip(zip.toBuffer())),
      (e: unknown) => isAppError(e) && e.details?.reason === 'json-parse-failed',
    )
  })

  it('manifest.json 与 task.json 不一致 → consistent=false 且以 task.json 为准', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    await zip.addFile(TASK_FILE, Buffer.from(JSON.stringify(manifest), 'utf8'))
    await zip.addFile(MANIFEST_FILE, Buffer.from(JSON.stringify({ ...manifest, linesHash: 'deadbeef' }), 'utf8'))
    await zip.finalize()
    const parsed = parseTaskPackage(openZip(zip.toBuffer()))
    assert.equal(parsed.consistent, false)
    assert.equal(parsed.manifest.linesHash, manifest.linesHash)
    assert.equal(parsed.warnings.some((w) => w.includes('不一致')), true)
  })

  it('takes.json 损坏不整体失败：takes=null + warning（音频仍可按 slots/ 扫描）', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    await zip.addFile(TASK_FILE, Buffer.from(JSON.stringify(manifest), 'utf8'))
    await zip.addFile(TAKES_FILE, Buffer.from('{"takes":[{"lineId":123}]}', 'utf8'))
    await zip.addFile('slots/line-2/t1.wav', Buffer.from(createSilentWav({ sampleRate: 48000, bitDepth: 24, durationMs: 20 })))
    await zip.finalize()

    const parsed = parseTaskPackage(openZip(zip.toBuffer()))
    assert.equal(parsed.takes, null)
    assert.equal(parsed.hasTakesFile, true)
    assert.equal(parsed.warnings.some((w) => w.includes('takes.json')), true)

    const slots = listSlotEntries(openZip(zip.toBuffer()))
    assert.deepEqual(slots.entries.map((s) => `${s.lineId}/${s.takeId}`), ['line-2/t1'])
  })

  it('takes.json 合法时被解析出来（时长/峰值/设备）', async () => {
    const zip = createStoreZipWriter()
    const manifest = makeManifest()
    await zip.addFile(TASK_FILE, Buffer.from(JSON.stringify(manifest), 'utf8'))
    await zip.addFile(
      TAKES_FILE,
      Buffer.from(
        JSON.stringify({
          takes: [
            { lineId: 'line-2', takeId: 't1', fileName: 't1.wav', durationMs: 1234, peakDb: -6.2, recordedAt: 1700000000000, device: 'USB Mic' },
          ],
        }),
        'utf8',
      ),
    )
    await zip.finalize()
    const parsed = parseTaskPackage(openZip(zip.toBuffer()))
    assert.equal(parsed.takes?.length, 1)
    assert.equal(parsed.takes?.[0].durationMs, 1234)
    assert.equal(parsed.takes?.[0].device, 'USB Mic')
  })

  it('parseTakesFile 对结构异常返回 null（不抛错）', () => {
    assert.equal(parseTakesFile(null), null)
    assert.equal(parseTakesFile({}), null)
    assert.equal(parseTakesFile({ takes: 'x' }), null)
    assert.equal(parseTakesFile({ takes: [{ lineId: 'l' }] }), null)
    assert.deepEqual(parseTakesFile({ takes: [] }), { takes: [] })
  })
})

// ---------------------------------------------------------------------------
// slots 路径
// ---------------------------------------------------------------------------

describe('slots 路径解析', () => {
  it('parseSlotPath 识别 {lineId}/{takeId}.wav，拒绝其它形状', () => {
    assert.deepEqual(parseSlotPath('slots/line-1/t1.wav'), {
      path: 'slots/line-1/t1.wav',
      lineId: 'line-1',
      takeId: 't1',
      fileName: 't1.wav',
    })
    assert.equal(parseSlotPath('slots/line-1/t1.mp3'), null, '非 wav 不识别')
    assert.equal(parseSlotPath('slots/line-1/sub/t1.wav'), null, '多层目录不识别')
    assert.equal(parseSlotPath('reference/t1.wav'), null)
    assert.equal(parseSlotPath('slots/t1.wav'), null)
  })

  it('listSlotEntries 忽略不符合命名的条目并报告，且按路径排序', async () => {
    const zip = createStoreZipWriter()
    const wav = Buffer.from(createSilentWav({ sampleRate: 48000, bitDepth: 24, durationMs: 20 }))
    await zip.addFile('slots/line-2/t2.wav', wav)
    await zip.addFile('slots/line-2/t1.wav', wav)
    await zip.addFile('slots/line-1/t1.wav', wav)
    await zip.addFile('slots/README.md', Buffer.from('说明'))
    await zip.finalize()
    const { entries, unrecognized } = listSlotEntries(openZip(zip.toBuffer()))
    assert.deepEqual(entries.map((e) => e.path), ['slots/line-1/t1.wav', 'slots/line-2/t1.wav', 'slots/line-2/t2.wav'])
    assert.deepEqual(unrecognized, ['slots/README.md'])
  })
})

// ---------------------------------------------------------------------------
// manifest 校验（nst 侧）
// ---------------------------------------------------------------------------

describe('NstManifest 校验', () => {
  it('构造出的 manifest 能通过自身校验', () => {
    const manifest = makeManifest()
    const ok = validateNstManifest(JSON.parse(JSON.stringify(manifest)))
    assert.equal(ok.format, 'nst')
    assert.equal(ok.lines.length, 3)
    assert.equal(ok.recordSettings.sampleRate, 48000)
  })

  it('format 不匹配 / 缺 formatVersion 都抛 PACKAGE_INVALID', () => {
    assert.throws(
      () => validateNstManifest({ format: 'nsp', formatVersion: 1 }),
      (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID' && e.details?.reason === 'format-mismatch',
    )
    assert.throws(
      () => validateNstManifest({ format: 'nst' }),
      (e: unknown) => isAppError(e) && e.details?.reason === 'format-version-invalid',
    )
  })

  it('recordSettings 缺字段会被列出（避免配音端拿到不完整的录音建议）', () => {
    const manifest = makeManifest()
    const broken = { ...manifest, recordSettings: { sampleRate: 48000 } }
    assert.throws(
      () => validateNstManifest(broken),
      (e: unknown) => {
        assert.ok(isAppError(e))
        const errors = e.details?.errors as string[]
        assert.equal(errors.some((m) => m.includes('recordSettings.bitDepth')), true)
        assert.equal(errors.some((m) => m.includes('recordSettings.channels')), true)
        return true
      },
    )
  })
})
