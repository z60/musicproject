/**
 * Novel Studio · 导入 · 画本模式（runImport 端到端）
 * ============================================================================
 * 验证 importMode: 'canvas' 时：
 *   · 每章 rawText 被解析成画本行 + 角色
 *   · 解析结果交给注入的 CanvasImportPort（由装配层写库）
 *   · 章节 canvas_state=generated、line_count = 画本行数
 *   · text 模式完全不受影响（不解析、不写画本）
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  createPassthroughTransaction,
  runImport,
  type CanvasImportWriteInput,
} from '../../src/main/features/book/import/import.service.ts'
import { createMemoryBookRepo } from '../../src/main/features/book/import/repositories/book.repo.ts'
import { createMemoryChapterRepo } from '../../src/main/features/book/import/repositories/chapter.repo.ts'
import { BUILTIN_RULE_SETS } from '../../src/shared/constants.ts'

/** 长旁白：避免分章器把过短的章节并入上一章（阈值 200 字） */
const LONG = '这是一段足够长的旁白文本，用来避免分章器把过短的章节并入上一章。'.repeat(8)

const CANVAS_TEXT = [
  '第1章 开始',
  '',
  LONG,
  '【杨浩-嬉小天】“我来了。”',
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
  '1',
  '青叔音',
  '25',
  '',
  '第2章 继续',
  '',
  LONG,
  '【老希尔-墨澜】“很好。”',
].join('\n')

function harness() {
  const bookRepo = createMemoryBookRepo()
  const chapterRepo = createMemoryChapterRepo()
  const written: CanvasImportWriteInput[] = []
  let n = 0
  const deps = {
    bookRepo,
    chapterRepo,
    withTransaction: createPassthroughTransaction({ bookRepo, chapterRepo }),
    newId: () => 'id-' + String(++n),
    now: () => 1000,
  }
  return { bookRepo, chapterRepo, written, deps }
}

describe('导入 · 画本模式', () => {
  it('canvas 模式：解析每章画本并交给 CanvasImportPort', async () => {
    const h = harness()
    const result = await runImport(
      {
        projectId: 'p1',
        source: { type: 'paste', text: CANVAS_TEXT, title: '画本书' },
        ruleSet: BUILTIN_RULE_SETS[0]!,
        persist: true,
        duplicatePolicy: 'copy',
        importMode: 'canvas',
      },
      {
        ...h.deps,
        canvasImport: {
          async writeChapter(input) {
            h.written.push(input)
            return { lines: input.script.lines.length, characters: input.script.characters.length }
          },
        },
      },
    )

    assert.ok(result.bookId, '入库应返回 bookId')
    assert.equal(h.written.length, 2, '两章各写一次')

    const ch1 = h.written[0]!
    assert.deepEqual(ch1.script.lines.map((l) => l.text), [LONG, '我来了。'])
    assert.equal(ch1.script.lines[0]!.kind, 'narration')
    assert.equal(ch1.script.lines[1]!.speaker, '杨浩')
    assert.equal(ch1.script.lines[1]!.cv, '嬉小天')
    assert.equal(ch1.script.characters.length, 1, '第一章角色表 1 个角色')

    const chapters = await h.chapterRepo.listByBook(result.bookId!)
    assert.equal(chapters.length, 2)
    assert.equal(chapters[0]!.canvasState, 'generated', '画本模式章节必须是 generated')
    assert.equal(chapters[0]!.lineCount, 2, 'line_count 用真实画本行数')
    // 预览草稿也带着解析结果（persist 路径）
    assert.ok(result.preview.chapters[0]!.canvasScript)
  })

  it('text 模式：不解析画本、不调用端口', async () => {
    const h = harness()
    let called = 0
    const result = await runImport(
      {
        projectId: 'p1',
        source: { type: 'paste', text: CANVAS_TEXT, title: '普通书' },
        ruleSet: BUILTIN_RULE_SETS[0]!,
        persist: true,
        duplicatePolicy: 'copy',
        // 不传 importMode
      },
      {
        ...h.deps,
        canvasImport: {
          async writeChapter() {
            called++
            return { lines: 0, characters: 0 }
          },
        },
      },
    )
    assert.ok(result.bookId)
    assert.equal(called, 0, 'text 模式不得触碰画本端口')
    const chapters = await h.chapterRepo.listByBook(result.bookId!)
    assert.equal(chapters[0]!.canvasState, 'none')
  })
})
