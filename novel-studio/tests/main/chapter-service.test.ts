/**
 * 章节管理服务（`chapter:*` 9 个通道的业务逻辑）
 * ============================================================================
 * 设计依据：docs/91 §5.2.8（本域实现时拍板的语义）、docs/03 §「软删除」、docs/21 §「chapters 表」
 *
 * 用**真 SQLite**（`node:sqlite` + 真实迁移）跑，而不是内存仓储：本章节的正确性
 * 一大半在 SQL 里（`seq` 重排、偏移重算、软删除过滤、进度聚合），
 * 拿假仓储测等于什么都没测。画本行写入用**注入的假实现**（真实现要跑 29 列 INSERT，
 * 属于画本域的事，另有专门测试覆盖）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createChapterService, type CanvasLineWriter } from '../../src/main/features/book/chapter/chapter.service.ts'
import { createSqliteChapterRepo } from '../../src/main/features/book/import/repositories/chapter.repo.sqlite.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { Logger } from '../../src/main/infra/log/index.ts'
import type { CanvasLine, Chapter } from '../../src/shared/types.ts'

const noopLog = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'level') return 'info'
      if (prop === 'recent') return () => []
      if (prop === 'child') return () => noopLog
      return () => {}
    },
  },
) as unknown as Logger

/** 内存版画本写入器（只覆盖端口需要的 5 个动作） */
function fakeCanvasLines() {
  const lines = new Map<string, CanvasLine[]>() // chapterId → 未删除的行（seq 升序由读取时排）
  const repo: CanvasLineWriter = {
    async countLines(chapterId) {
      return (lines.get(chapterId) ?? []).length
    },
    async findTitleLine(chapterId) {
      return (lines.get(chapterId) ?? []).find((l) => l.isTitle) ?? null
    },
    async shiftSeqDown(chapterId) {
      lines.set(chapterId, (lines.get(chapterId) ?? []).map((l) => ({ ...l, seq: l.seq + 1 })))
    },
    async insert(line) {
      lines.set(line.chapterId, [...(lines.get(line.chapterId) ?? []), { ...line }])
    },
    async updateText(lineId, text) {
      for (const [chapterId, list] of lines) {
        lines.set(
          chapterId,
          list.map((l) => (l.id === lineId ? { ...l, text } : l)),
        )
      }
    },
  }
  return { repo, lines }
}

interface Harness {
  db: DatabaseSync
  service: ReturnType<typeof createChapterService>
  lines: Map<string, CanvasLine[]>
  ids: string[]
}

async function harness(): Promise<Harness> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  // 一本书 + 4 章（正文用可预测的字符数，便于断言偏移）
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', '默认项目', 'C:/tmp/p1', 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '示例书', '旁白', 'zh-CN', 'txt', 'hash-b1', 0, 4, 1, 1)`)

  const repo = createSqliteChapterRepo(db as unknown as DbLike)
  const ids = ['c1', 'c2', 'c3', 'c4']
  const texts = ['甲甲甲甲', '乙乙乙乙乙', '丙丙丙', '丁丁丁丁丁丁']
  let offset = 0
  await repo.insertMany(
    ids.map((id, i) => {
      const text = texts[i]!
      const chapter: Chapter = {
        id,
        bookId: 'b1',
        seq: i + 1,
        title: `第${i + 1}章`,
        kind: 'chapter',
        volumeSeq: null,
        volumeTitle: null,
        charCount: text.length,
        startOffset: offset,
        endOffset: offset + text.length,
        canvasState: 'none',
        lineCount: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      offset += text.length
      return { chapter, rawText: text, text }
    }),
  )

  const { repo: canvasRepo, lines } = fakeCanvasLines()
  let n = 0
  const service = createChapterService({
    getDb: () => db as unknown as DbLike,
    log: noopLog,
    newId: () => `new-${++n}`,
    now: () => 1000,
    canvasLines: canvasRepo,
  })
  return { db, service, lines, ids }
}

const seqs = async (h: Harness, bookId = 'b1') =>
  (await h.service.list(bookId)).map((c) => `${c.id}:${c.seq}`).join(',')

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

describe('chapter:list / get / stats', () => {
  it('列表按 seq 升序，并带上 progress（没有画本行时是 0 值而不是 null）', async () => {
    const h = await harness()
    const rows = await h.service.list('b1')

    assert.deepEqual(rows.map((r) => r.id), ['c1', 'c2', 'c3', 'c4'])
    for (const r of rows) {
      assert.ok(r.progress, `${r.id} 应该有 progress 对象`)
      assert.equal(r.progress.lineCount, 0, '没有画本行 → 0（不是 null/NaN）')
      assert.equal(r.progress.audioMs, 0)
    }
  })

  it('书不存在 → 返回 []（不抛错：界面的空态文案是「这本书还没有章节」）', async () => {
    const h = await harness()
    assert.deepEqual(await h.service.list('不存在的书'), [])
  })

  it('不存在的章节 → NOT_FOUND（get / stats 都是）', async () => {
    const h = await harness()
    await assert.rejects(() => h.service.get('nope'), { key: 'NOT_FOUND' })
    await assert.rejects(() => h.service.stats('nope'), { key: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// 单章编辑
// ---------------------------------------------------------------------------

describe('chapter:update', () => {
  it('改标题 / 类型 / 卷名，其它字段不动', async () => {
    const h = await harness()
    const before = await h.service.get('c2')

    const after = await h.service.update('c2', { title: '改名了', kind: 'extra', volumeTitle: '第一卷' })

    assert.equal(after.title, '改名了')
    assert.equal(after.kind, 'extra')
    assert.equal(after.volumeTitle, '第一卷')
    assert.equal(after.seq, before.seq, '不该动顺序')
    assert.equal(after.charCount, before.charCount, '不该动字数')
  })

  it('卷名传空串 → 归一为 null（UI 的「清除卷名」发的就是空串）', async () => {
    const h = await harness()
    await h.service.update('c2', { volumeTitle: '第一卷' })
    const cleared = await h.service.update('c2', { volumeTitle: '' })
    assert.equal(cleared.volumeTitle, null, '空串应归一为 null，而不是在库里混入 ""')
  })

  it('标题传空串 → INVALID_PAYLOAD（标题列 NOT NULL 且界面必须显示点什么）', async () => {
    const h = await harness()
    await assert.rejects(() => h.service.update('c2', { title: '   ' }), { key: 'INVALID_PAYLOAD' })
  })
})

// ---------------------------------------------------------------------------
// 重排
// ---------------------------------------------------------------------------

describe('chapter:reorder', () => {
  it('按入参顺序重写 seq 为 1..N', async () => {
    const h = await harness()
    await h.service.reorder('b1', ['c3', 'c1', 'c4', 'c2'])
    assert.equal(await seqs(h), 'c3:1,c1:2,c4:3,c2:4')
  })

  it('集合不匹配（缺项 / 多项 / 重复）→ INVALID_PAYLOAD，且**库内 seq 不变**', async () => {
    const h = await harness()
    const before = await seqs(h)

    await assert.rejects(() => h.service.reorder('b1', ['c1', 'c2']), { key: 'INVALID_PAYLOAD' }, '缺项')
    await assert.rejects(() => h.service.reorder('b1', ['c1', 'c2', 'c3', 'c4', 'x9']), { key: 'INVALID_PAYLOAD' }, '多项')
    await assert.rejects(() => h.service.reorder('b1', ['c1', 'c1', 'c3', 'c4']), { key: 'INVALID_PAYLOAD' }, '重复')

    assert.equal(await seqs(h), before, '被拒的重排不能留下半成品')
  })
})

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

describe('chapter:merge', () => {
  it('合并 2 章：文本双换行连接、幸存者=seq 最小者、其余消失、偏移重算', async () => {
    const h = await harness()
    const merged = await h.service.merge(['c2', 'c1'], '合起来的章')

    assert.equal(merged.id, 'c1', '幸存者是 seq 最小的那章（不以入参顺序为准）')
    assert.equal(merged.title, '合起来的章')
    assert.equal(merged.charCount, '甲甲甲甲\n\n乙乙乙乙乙'.length)
    assert.equal(merged.lineCount, 2)

    const rows = await h.service.list('b1')
    assert.deepEqual(rows.map((r) => r.id), ['c1', 'c3', 'c4'], 'c2 已被软删除')
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3], 'seq 重排为连续')
    assert.equal(rows[0]!.startOffset, 0)
    assert.equal(rows[0]!.endOffset, merged.charCount)
    assert.equal(rows[1]!.startOffset, merged.charCount, '后续章节的偏移要跟着平移')
  })

  it('少于 2 章 → INVALID_PAYLOAD', async () => {
    const h = await harness()
    await assert.rejects(() => h.service.merge(['c1'], 'x'), { key: 'INVALID_PAYLOAD' })
  })

  it('跨书合并 → INVALID_PAYLOAD', async () => {
    const h = await harness()
    h.db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
               VALUES ('b2', 'p1', '另一本', '旁白', 'zh-CN', 'txt', 'hash-b2', 0, 1, 1, 1)`)
    const repo = createSqliteChapterRepo(h.db as unknown as DbLike)
    await repo.insertMany([
      {
        chapter: {
          id: 'x1', bookId: 'b2', seq: 1, title: '别的章', kind: 'chapter', volumeSeq: null, volumeTitle: null,
          charCount: 2, startOffset: 0, endOffset: 2, canvasState: 'none', lineCount: 0, createdAt: 1, updatedAt: 1,
        },
        rawText: '甲甲', text: '甲甲',
      },
    ])
    await assert.rejects(() => h.service.merge(['c1', 'x1'], '跨书'), { key: 'INVALID_PAYLOAD' })
  })

  it('**已有画本行的章节拒绝合并**（不静默销毁录音成果）', async () => {
    const h = await harness()
    // 给 c1 放一行画本行
    h.lines.set('c1', [{ id: 'l1', chapterId: 'c1', isTitle: false } as unknown as CanvasLine])

    await assert.rejects(
      () => h.service.merge(['c1', 'c2'], '不许合'),
      { key: 'CHAPTER_HAS_CANVAS_LINES' },
      '应给出「这一章已经有画本了」这种用户可理解的拒绝，而不是笼统的 INVALID_PAYLOAD',
    )
    assert.equal(await seqs(h), 'c1:1,c2:2,c3:3,c4:4', '被拒后什么都没变')
  })
})

// ---------------------------------------------------------------------------
// 拆分
// ---------------------------------------------------------------------------

describe('chapter:split', () => {
  it('按**全书绝对偏移**切成多片：原章复用为第 1 片，其余新建，seq 不重复', async () => {
    const h = await harness()
    // c2 是「乙乙乙乙乙」，全书偏移 4..9；在 6 与 8 处切
    const created = await h.service.split('c2', [6, 8])

    assert.equal(created.length, 3)
    assert.equal(created[0]!.id, 'c2', '第 1 片复用原章 id')
    assert.equal(created[0]!.charCount, 2)
    assert.equal(created[1]!.charCount, 2)
    assert.equal(created[2]!.charCount, 1)

    const rows = await h.service.list('b1')
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6], 'seq 必须连续且不重复')
    assert.deepEqual(
      rows.map((r) => r.id),
      ['c1', 'c2', 'new-1', 'new-2', 'c3', 'c4'],
    )
    // 偏移连续：每章的 start = 前一章的 end
    for (let i = 1; i < rows.length; i++) {
      assert.equal(rows[i]!.startOffset, rows[i - 1]!.endOffset, `${rows[i]!.id} 的 startOffset 应接上前一章`)
    }
  })

  it('偏移越界 / 空数组 → INVALID_PAYLOAD（**章内相对偏移会被拒**，避免「切在别处」）', async () => {
    const h = await harness()
    await assert.rejects(() => h.service.split('c2', []), { key: 'INVALID_PAYLOAD' }, '空数组')
    await assert.rejects(() => h.service.split('c2', [1]), { key: 'INVALID_PAYLOAD' }, '章内相对偏移（1 < startOffset=4）')
    await assert.rejects(() => h.service.split('c2', [4, 9]), { key: 'INVALID_PAYLOAD' }, '边界值不算章内')
  })

  it('已有画本行的章节拒绝拆分', async () => {
    const h = await harness()
    h.lines.set('c2', [{ id: 'l1', chapterId: 'c2', isTitle: false } as unknown as CanvasLine])
    await assert.rejects(() => h.service.split('c2', [6]), { key: 'CHAPTER_HAS_CANVAS_LINES' })
  })
})

// ---------------------------------------------------------------------------
// 删除（软删除）
// ---------------------------------------------------------------------------

describe('chapter:delete', () => {
  it('软删除：列表里消失、seq 重排，**画本行与录音元数据保留在库里**', async () => {
    const h = await harness()
    // 给 c3 塞一行画本行（模拟「已录过音」的章节）
    h.db.exec(`INSERT INTO canvas_lines (id, chapter_id, book_id, seq, speaker_type, kind, text,
                 char_start, char_end, pause_after_ms, state, needs_review, is_title, rev, created_at, updated_at)
               VALUES ('l-c3', 'c3', 'b1', 0, 'narration', 'narration', '正文', 0, 2, 500, 'recorded', 0, 0, 1, 1, 1)`)

    await h.service.remove('c3')

    const rows = await h.service.list('b1')
    assert.deepEqual(rows.map((r) => r.id), ['c1', 'c2', 'c4'], 'c3 从列表消失')
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3], 'seq 重排为连续')

    const kept = h.db.prepare(`SELECT COUNT(*) AS n FROM canvas_lines WHERE chapter_id = 'c3'`).get() as { n: number }
    assert.equal(kept.n, 1, '画本行（录音成果）必须还在 —— 这正是软删除而非物理删除的理由')
    const chapterRow = h.db.prepare(`SELECT deleted_at FROM chapters WHERE id = 'c3'`).get() as { deleted_at: number | null }
    assert.notEqual(chapterRow.deleted_at, null, '章节行应带删除标记，而不是被 DELETE 掉')
  })

  it('不存在的章节 → NOT_FOUND', async () => {
    const h = await harness()
    await assert.rejects(() => h.service.remove('nope'), { key: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// 章首标题念白行
// ---------------------------------------------------------------------------

describe('chapter:inserTitleLine', () => {
  it('插入标题行：内容=章节标题、seq=0、已有行整体后移；章节的画本状态与行数同步', async () => {
    const h = await harness()
    // 先放两行正文
    h.lines.set('c1', [
      { id: 'a', chapterId: 'c1', seq: 0, isTitle: false, text: '一', decidedBy: null } as unknown as CanvasLine,
      { id: 'b', chapterId: 'c1', seq: 1, isTitle: false, text: '二', decidedBy: null } as unknown as CanvasLine,
    ])

    const line = await h.service.insertTitleLine('c1')

    assert.equal(line.text, '第1章', '标题行内容 = 章节标题')
    assert.equal(line.kind, 'narration')
    assert.equal(line.speakerType, 'narration')
    assert.equal(line.isTitle, true)
    assert.equal(line.seq, 0, '标题行占 seq 0（与生成路径一致）')
    assert.equal(line.pauseAfterMs, 500)
    assert.equal(line.rev, 1)
    assert.deepEqual(line.flags, [])

    const after = h.lines.get('c1')!
    assert.deepEqual(after.map((l) => `${l.id}:${l.seq}`), ['a:1', 'b:2', `${line.id}:0`], '已有行整体 +1')

    const chapter = await h.service.get('c1')
    assert.equal(chapter.canvasState, 'generated', '插了行就不该还是「未生成」')
    assert.equal(chapter.lineCount, 3, '行数要跟着更新，否则列表页显示 0 行')
  })

  it('幂等：已有标题行时更新其正文并返回同一行，不会变两行', async () => {
    const h = await harness()
    const first = await h.service.insertTitleLine('c1')
    await h.service.update('c1', { title: '改过的标题' })
    const second = await h.service.insertTitleLine('c1')

    assert.equal(second.id, first.id, '同一行，不是新行')
    assert.equal(second.text, '改过的标题', '标题变了就同步过来')
    assert.equal(h.lines.get('c1')!.length, 1, '库里仍然只有一行')
  })

  it('人工改过的标题行**不覆盖**（docs/11 §3：人工结果永不覆盖）', async () => {
    const h = await harness()
    const first = await h.service.insertTitleLine('c1')
    h.lines.set('c1', [{ ...first, text: '人工写的念白', decidedBy: 'human' }])
    await h.service.update('c1', { title: '新的章节标题' })

    const again = await h.service.insertTitleLine('c1')
    assert.equal(again.text, '人工写的念白', '人工结果不能被自动同步覆盖')
  })

  it('章节不存在 → NOT_FOUND', async () => {
    const h = await harness()
    await assert.rejects(() => h.service.insertTitleLine('nope'), { key: 'NOT_FOUND' })
  })
})
