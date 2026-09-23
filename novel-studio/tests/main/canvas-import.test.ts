/**
 * Novel Studio · 画本导入落库测试
 * ============================================================================
 * 验证「已经是画本」的文档导入后：
 *   · 角色按名字复用/创建，CV/音色/年龄写进备注
 *   · 画本行直接落库（说话人来自【角色-CV】，state=assigned，不需要复核）
 *   · 章节被标记为 generated，line_count 用真实画本行数
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  createCanvasImportPort,
  mapScriptAge,
  mapScriptGender,
} from '../../src/main/features/book/canvas/canvas-import.service.ts'
import { createMemoryCanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.ts'
import { createMemoryCharacterRepo } from '../../src/main/features/book/canvas/repositories/character.repo.ts'
import { parseCanvasScript } from '../../src/shared/text/canvas-script.ts'
import type { Character } from '../../src/shared/types.ts'

const BOOK = 'b1'
const CHAPTER = 'c1'

function character(name: string, id: string): Character {
  return {
    id,
    bookId: BOOK,
    name,
    aliases: [],
    gender: null,
    ageGroup: null,
    description: null,
    note: null,
    color: null,
    defaultSpeed: null,
    defaultEmotion: null,
    defaultGainDb: null,
    defaultPauseMs: null,
    isArchived: false,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makePort(seed?: { characters?: Character[] }) {
  const canvasRepo = createMemoryCanvasRepo()
  const characterRepo = createMemoryCharacterRepo(seed ?? {})
  const patches: Array<{ chapterId: string; canvasState: string; lineCount: number }> = []
  let n = 0
  const port = createCanvasImportPort({
    getCanvasRepo: () => canvasRepo,
    getCharacterRepo: () => characterRepo,
    updateChapter: async (chapterId, patch) => {
      patches.push({ chapterId, canvasState: patch.canvasState, lineCount: patch.lineCount })
    },
    newId: () => 'char-' + String(++n),
    now: () => 1000,
  })
  return { canvasRepo, characterRepo, patches, port }
}

describe('画本导入落库', () => {
  it('创建角色 + 写画本行 + 章节标 generated', async () => {
    const h = makePort()
    const script = parseCanvasScript([
      '旁白一',
      '【杨浩-嬉小天】“我来了。”',
      '【老希尔-墨澜】“很好。”',
    ].join('\n'))

    const res = await h.port.writeChapter({
      bookId: BOOK,
      chapterId: CHAPTER,
      chapterTitle: '第一章',
      script,
    })
    assert.equal(res.lines, 3)
    assert.equal(res.characters, 2)

    const lines = await h.canvasRepo.listLines(CHAPTER)
    assert.equal(lines.length, 3)
    assert.equal(lines[0]!.speakerType, 'narration')
    assert.equal(lines[0]!.kind, 'narration')
    assert.equal(lines[1]!.speakerType, 'character')
    assert.equal(lines[1]!.text, '我来了。')
    assert.equal(lines[1]!.kind, 'dialogue')
    assert.equal(lines[1]!.id, CHAPTER + '-L00001')
    assert.equal(lines[1]!.state, 'assigned', '导入的画本行不需要复核')
    assert.equal(lines[1]!.needsReview, false)
    assert.ok(lines[1]!.characterId, '角色行必须绑定角色')

    const chars = await h.characterRepo.listByBook(BOOK)
    assert.deepEqual(chars.map((c) => c.name).sort(), ['杨浩', '老希尔'].sort())
    assert.deepEqual(h.patches, [{ chapterId: CHAPTER, canvasState: 'generated', lineCount: 3 }])
  })

  it('同名角色被复用（不重复建、不覆盖用户备注）', async () => {
    const existing = character('杨浩', 'existing-1')
    existing.note = '用户手写的备注'
    const h = makePort({ characters: [existing] })
    const script = parseCanvasScript('【杨浩-嬉小天】“我来了。”')

    const res = await h.port.writeChapter({
      bookId: BOOK,
      chapterId: CHAPTER,
      chapterTitle: '第一章',
      script,
    })
    assert.equal(res.characters, 0, '已存在的角色不该再建一次')
    const chars = await h.characterRepo.listByBook(BOOK)
    assert.equal(chars.length, 1)
    assert.equal(chars[0]!.note, '用户手写的备注', '不能覆盖用户改过的资料')
    const lines = await h.canvasRepo.listLines(CHAPTER)
    assert.equal(lines[0]!.characterId, 'existing-1', '要绑到已有角色上')
  })

  it('角色表里的性别/年龄/CV/音色写进角色', async () => {
    const h = makePort()
    const script = parseCanvasScript([
      '序号',
      'CV',
      '角色名',
      '性别',
      '角色描述',
      '台词数',
      '音色',
      '年龄',
      '1',
      '嬉小天',
      '杨浩',
      '男',
      '男主',
      '1645',
      '青叔音',
      '25',
      '【杨浩-嬉小天】“我来了。”',
    ].join('\n'))

    await h.port.writeChapter({ bookId: BOOK, chapterId: CHAPTER, chapterTitle: '第一章', script })
    const chars = await h.characterRepo.listByBook(BOOK)
    assert.equal(chars.length, 1)
    assert.equal(chars[0]!.name, '杨浩')
    assert.equal(chars[0]!.gender, 'male')
    assert.equal(chars[0]!.ageGroup, 'young')
    assert.equal(chars[0]!.description, '男主')
    assert.match(chars[0]!.note ?? '', /CV：嬉小天/)
    assert.match(chars[0]!.note ?? '', /音色：青叔音/)
  })

  it('性别 / 年龄映射', () => {
    assert.equal(mapScriptGender('男'), 'male')
    assert.equal(mapScriptGender('女'), 'female')
    assert.equal(mapScriptGender(null), null)
    assert.equal(mapScriptAge('25'), 'young')
    assert.equal(mapScriptAge('67'), 'elder')
    assert.equal(mapScriptAge('中年'), 'middle')
    assert.equal(mapScriptAge(''), null)
  })
})
