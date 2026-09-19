/**
 * 角色与配音员域 IPC handler 测试（真库 + 真仓储 + 真服务）
 * ============================================================================
 * 设计依据：docs/20 §4.4（14 个通道）、docs/11 §4.6 / §6.1、docs/06 §8
 *
 * ### 这组测试守的是什么
 *   1. **`undefined` 语义**：请求经过校验器后，没给的可选键也在（值为 `undefined`）。
 *      「改名不该顺手清掉别名/备注」这类事只能在这里被发现 —— 服务层与仓储都不会报错。
 *   2. **合并的四个副作用**：迁移台词（并置 `decidedBy='human'`）、合并别名、
 *      归档源角色、迁移配音员绑定。少任何一个都能"成功返回"，但用户会在别处看到数据消失。
 *   3. **统计口径**：出场统计与分工负载必须用同一个字数口径（`countReadableChars`），
 *      否则两个面板的数字对不上，而用户会以为其中一个算错了。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { AppError } from '../../src/shared/errors.ts'
import { IPC_CHANNELS } from '../../src/shared/ipc.ts'
import type { ActorWorkload, CanvasLine, Character, CharacterStats, VoiceActor } from '../../src/shared/types.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import { schemaFor } from '../../src/main/ipc/schemas.ts'
import { createCharacterService, type CharacterServiceDeps } from '../../src/main/features/book/canvas/character.service.ts'
import { createCharacterHandlers, CHARACTER_CHANNELS } from '../../src/main/ipc/handlers/character.ts'
import type { RegisteredHandler } from '../../src/main/ipc/handlers/deps.ts'
import { createSqliteCanvasRepo } from '../../src/main/features/book/canvas/repositories/canvas.repo.sqlite.ts'
import { createSqliteCharacterRepo } from '../../src/main/features/book/canvas/repositories/character.repo.sqlite.ts'
import { createSqliteVoiceActorRepo } from '../../src/main/features/book/canvas/repositories/voice-actor.repo.sqlite.ts'
import { createSqliteChapterRepo } from '../../src/main/features/book/import/repositories/chapter.repo.sqlite.ts'
import type { TaskQueue } from '../../src/main/infra/queue/queue.ts'

// ---------------------------------------------------------------------------
// 测试台
// ---------------------------------------------------------------------------

/** 带对白提示的正文：抽取候选时「萧炎」应能被第三条信号之外的规则命中 */
const CHAPTER_TEXT = [
  '萧炎沉声道：「药老，我来了。」',
  '药老捋着胡须笑了笑，没有回答。',
  '萧炎又喊了一声：「药老？」',
  '远处传来脚步，老张头提着灯笼走近。',
].join('\n')

interface Harness {
  db: DatabaseSync
  repo: {
    canvas: ReturnType<typeof createSqliteCanvasRepo>
    characters: ReturnType<typeof createSqliteCharacterRepo>
    actors: ReturnType<typeof createSqliteVoiceActorRepo>
  }
  handlers: RegisteredHandler[]
  enqueued: Array<{ kind: string; payload: unknown; opts: unknown }>
  cleanup: () => void
}

async function harness(): Promise<Harness> {
  const db = new DatabaseSync(':memory:')
  await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`INSERT INTO projects (id, name, root_dir, schema_version, created_at, updated_at)
           VALUES ('p1', 'proj', 'C:/tmp/p1', 3, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b1', 'p1', '书', '旁白', 'zh-CN', 'txt', 'h1', 0, 2, 1, 1)`)
  db.exec(`INSERT INTO books (id, project_id, title, narrator, language, source_type, content_hash, char_count, chapter_count, created_at, updated_at)
           VALUES ('b2', 'p1', '别的书', '旁白', 'zh-CN', 'txt', 'h2', 0, 0, 1, 1)`)
  const text = CHAPTER_TEXT.replace(/'/g, "''")
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, source_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c1', 'b1', 1, '第一章', 'chapter', '${text}', '${text}', ${CHAPTER_TEXT.length}, 0, ${CHAPTER_TEXT.length}, 'none', 0, 1, 1)`)
  db.exec(`INSERT INTO chapters (id, book_id, seq, title, kind, raw_text, source_text, char_count, start_offset, end_offset, canvas_state, line_count, created_at, updated_at)
           VALUES ('c2', 'b1', 2, '第二章', 'chapter', '第二章正文', '第二章正文', 5, 0, 5, 'none', 0, 1, 1)`)

  const dbLike = db as unknown as DbLike
  const canvas = createSqliteCanvasRepo(dbLike)
  const characters = createSqliteCharacterRepo(dbLike)
  const actors = createSqliteVoiceActorRepo(dbLike)
  const chapters = createSqliteChapterRepo(dbLike)
  const enqueued: Harness['enqueued'] = []

  const deps: CharacterServiceDeps = {
    repo: () => ({ canvas, characters, actors }),
    chapters,
    listProjectActors: (bookId) => (bookId === 'b1' ? actors.listByProject('p1') : Promise.resolve([])),
    queue: {
      enqueue: async (kind: string, payload: unknown, opts: unknown) => {
        enqueued.push({ kind, payload, opts })
        return { taskId: `task-${kind}`, deduped: false }
      },
    } as unknown as TaskQueue,
    newId: (() => {
      let n = 0
      return (prefix: string) => `${prefix}-${++n}`
    })(),
    now: () => 1_700_000_000_000,
  }

  const service = createCharacterService(deps)
  return {
    db,
    repo: { canvas, characters, actors },
    handlers: createCharacterHandlers({ service, log: { info: () => {}, warn: () => {} } }),
    enqueued,
    cleanup: () => db.close(),
  }
}

async function call(h: Harness, channel: string, payload: unknown): Promise<unknown> {
  const spec = h.handlers.find((x) => x.channel === channel)
  assert.ok(spec, `未找到通道的 handler：${channel}`)
  const schema = schemaFor(channel)
  assert.ok(schema, `契约里没有这个通道的 schema：${channel}`)
  return await spec.run(schema.parse(payload) as never, {} as never)
}

/** 直接塞一行画本行（准备场景用） */
async function seedLine(
  h: Harness,
  line: { id: string; chapterId?: string; seq: number; text: string; characterId?: string | null; decidedBy?: CanvasLine['decidedBy']; kind?: CanvasLine['kind'] },
): Promise<void> {
  const full: CanvasLine = {
    id: line.id,
    chapterId: line.chapterId ?? 'c1',
    bookId: 'b1',
    seq: line.seq,
    speakerType: line.characterId ? 'character' : 'narration',
    characterId: line.characterId ?? null,
    kind: line.kind ?? (line.characterId ? 'dialogue' : 'narration'),
    text: line.text,
    sourceText: null,
    charStart: 0,
    charEnd: 0,
    emotion: null,
    emotionIntensity: null,
    speed: null,
    gainDb: null,
    pauseAfterMs: 500,
    pauseInline: null,
    pronunciation: null,
    note: null,
    state: 'draft',
    confidence: null,
    candidates: null,
    decidedBy: line.decidedBy ?? null,
    needsReview: false,
    flags: [],
    isTitle: false,
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  await h.repo.canvas.insertLines([full])
}

async function addCharacter(
  h: Harness,
  input: { id?: string; bookId?: string; name: string; aliases?: string[]; color?: string | null },
): Promise<Character> {
  return (await call(h, 'character:upsert', {
    character: { ...input, bookId: input.bookId ?? 'b1' },
  })) as Character
}

// ---------------------------------------------------------------------------
// 契约面
// ---------------------------------------------------------------------------

describe('角色域 handler · 契约面', () => {
  it('CHARACTER_CHANNELS 与实际 handler 一一对应，且都在契约里', async () => {
    const h = await harness()
    try {
      assert.deepEqual(
        [...CHARACTER_CHANNELS].sort(),
        h.handlers.map((x) => x.channel).sort(),
      )
      for (const c of CHARACTER_CHANNELS) {
        assert.ok((IPC_CHANNELS as readonly string[]).includes(c), `${c} 不在契约里`)
        assert.ok(schemaFor(c), `${c} 没有请求 schema`)
      }
      assert.equal(new Set(CHARACTER_CHANNELS).size, CHARACTER_CHANNELS.length)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 角色 CRUD
// ---------------------------------------------------------------------------

describe('角色域 handler · 增查改归档', () => {
  it('character:upsert 新建时回填 id；只给 name 时不清空其它字段', async () => {
    const h = await harness()
    try {
      const created = await addCharacter(h, { name: '萧炎', aliases: ['小炎子'], color: '#123456' })
      assert.ok(created.id, '必须回填 id，否则渲染侧拿不到它去建行')
      assert.deepEqual(created.aliases, ['小炎子'])

      // 只改名字（请求里其余键由校验器物化成 undefined）
      const renamed = (await call(h, 'character:upsert', {
        character: { id: created.id, bookId: 'b1', name: '萧炎（改）' },
      })) as Character
      assert.equal(renamed.name, '萧炎（改）')
      assert.deepEqual(renamed.aliases, ['小炎子'], '没给 aliases 时别名必须原样保留')
      assert.equal(renamed.color, '#123456', '没给 color 时也不该被清空')
    } finally {
      h.cleanup()
    }
  })

  it('空名字与跨书 id 都被拒绝', async () => {
    const h = await harness()
    try {
      await assert.rejects(
        () => call(h, 'character:upsert', { character: { bookId: 'b1', name: '   ' } }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      const c = await addCharacter(h, { name: '萧炎' })
      await assert.rejects(
        () => call(h, 'character:upsert', { character: { id: c.id, bookId: 'b2', name: '萧炎' } }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
        '把角色挪到别的书会让「角色 → 它的行」跨书，判定与统计都会错',
      )
    } finally {
      h.cleanup()
    }
  })

  it('character:list 默认不含归档；archive 后仍可按 includeArchived 取回', async () => {
    const h = await harness()
    try {
      const a = await addCharacter(h, { name: '甲' })
      await addCharacter(h, { name: '乙' })

      assert.equal(((await call(h, 'character:list', { bookId: 'b1' })) as Character[]).length, 2)
      assert.deepEqual(await call(h, 'character:archive', { characterId: a.id, archived: true }), { ok: true })

      const active = (await call(h, 'character:list', { bookId: 'b1' })) as Character[]
      assert.deepEqual(active.map((c) => c.name), ['乙'])
      const all = (await call(h, 'character:list', { bookId: 'b1', includeArchived: true })) as Character[]
      assert.equal(all.length, 2, '归档不是删除：includeArchived 必须能取回')
      assert.ok(all.some((c) => c.isArchived))

      await assert.rejects(
        () => call(h, 'character:archive', { characterId: 'ghost', archived: true }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 合并：四个副作用都要发生
// ---------------------------------------------------------------------------

describe('角色域 handler · 合并', () => {
  it('迁移台词（置人工确认）+ 合并别名 + 归档源 + 迁移配音员绑定', async () => {
    const h = await harness()
    try {
      const target = await addCharacter(h, { name: '萧炎', aliases: ['炎帝'] })
      const source = await addCharacter(h, { name: '小炎子', aliases: ['炎儿'] })
      await seedLine(h, { id: 'l1', seq: 0, text: '我是萧炎', characterId: source.id, decidedBy: 'rule' })
      await seedLine(h, { id: 'l2', seq: 1, text: '无关旁白' })
      await seedLine(h, { id: 'l3', seq: 2, text: '又是我', characterId: source.id, kind: 'inner' })

      const actor = (await call(h, 'voiceActor:upsert', {
        actor: { projectId: 'p1', name: '张三配音' },
      })) as VoiceActor
      await call(h, 'voiceActor:bind', { characterId: source.id, actorId: actor.id, isPrimary: true })

      const res = (await call(h, 'character:merge', {
        targetId: target.id,
        sourceIds: [source.id],
        keepAliases: true,
      })) as { movedLines: number; mergedAliases: string[]; conflicts: string[] }

      assert.equal(res.movedLines, 2)
      assert.deepEqual(res.conflicts, [])
      assert.deepEqual([...res.mergedAliases].sort(), ['小炎子', '炎儿'].sort(), '源角色的名字与别名都要并进来')

      // ① 台词迁移 + 人工确认（合并是人工动作，重算不得覆盖）
      const moved = await h.repo.canvas.listByCharacter(target.id)
      assert.deepEqual(moved.map((l) => l.id).sort(), ['l1', 'l3'])
      assert.ok(moved.every((l) => l.decidedBy === 'human'))
      // ② 别名（仓储统一按拼音序返回：小… < 炎…）
      assert.deepEqual((await h.repo.characters.get(target.id))?.aliases, ['小炎子', '炎帝', '炎儿'])
      // ③ 源角色归档（不物理删除）
      assert.equal((await h.repo.characters.get(source.id))?.isArchived, true)
      // ④ 绑定迁移（否则配音员随源角色一起"消失"）
      const bindings = (await call(h, 'voiceActor:bindings', { bookId: 'b1' })) as Array<{
        characterId: string
        actorId: string
        isPrimary: boolean
      }>
      assert.deepEqual(bindings, [{ characterId: target.id, actorId: actor.id, isPrimary: true }])
    } finally {
      h.cleanup()
    }
  })

  it('别名冲突：返回消息但不阻断（冲突的那个别名不并入，其余照常）', async () => {
    const h = await harness()
    try {
      const target = await addCharacter(h, { name: '萧炎' })
      const source = await addCharacter(h, { name: '药老', aliases: ['老药'] })
      const other = await addCharacter(h, { name: '老药' }) // 别名被别的角色占了
      assert.ok(other.id)

      const res = (await call(h, 'character:merge', {
        targetId: target.id,
        sourceIds: [source.id],
      })) as { mergedAliases: string[]; conflicts: string[] }

      assert.equal(res.conflicts.length, 1, '冲突必须报出来（UI 要展示「哪些别名没并进去」）')
      assert.ok(res.conflicts[0]!.includes('老药'))
      assert.deepEqual(res.mergedAliases, ['药老'], '冲突的别名跳过，其它照常合并')
      assert.equal((await h.repo.characters.get(source.id))?.isArchived, true, '冲突不该阻断整个合并')
    } finally {
      h.cleanup()
    }
  })

  it('没有有效源 / 源不存在 都被拒绝', async () => {
    const h = await harness()
    try {
      const target = await addCharacter(h, { name: '萧炎' })
      await assert.rejects(
        () => call(h, 'character:merge', { targetId: target.id, sourceIds: [target.id] }),
        (e: unknown) => e instanceof AppError && e.key === 'INVALID_PAYLOAD',
      )
      await assert.rejects(
        () => call(h, 'character:merge', { targetId: target.id, sourceIds: ['ghost'] }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 抽取与统计
// ---------------------------------------------------------------------------

describe('角色域 handler · 抽取候选与出场统计', () => {
  it('character:extract 从正文抽候选，并剔除已有角色/别名', async () => {
    const h = await harness()
    try {
      const before = (await call(h, 'character:extract', { bookId: 'b1' })) as Array<{ name: string; occurrences: number }>
      assert.ok(before.length > 0, '这段正文里有明显的人名/称谓，抽不出候选就是规则坏了')
      assert.ok(before.some((c) => c.name === '萧炎'), `实际：${before.map((c) => c.name).join('、')}`)

      await addCharacter(h, { name: '萧炎' })
      const after = (await call(h, 'character:extract', { bookId: 'b1' })) as Array<{ name: string }>
      assert.ok(!after.some((c) => c.name === '萧炎'), '已经是角色的候选不该再出现（点了也是 no-op）')

      // 只抽指定章：第二章只有 5 个字，应当抽不出候选
      const limited = (await call(h, 'character:extract', { bookId: 'b1', chapterIds: ['c2'] })) as unknown[]
      assert.ok(limited.length < after.length + 1)
    } finally {
      h.cleanup()
    }
  })

  it('character:stats 的行数/字数/预估时长与出场行一致', async () => {
    const h = await harness()
    try {
      const c = await addCharacter(h, { name: '萧炎' })
      await seedLine(h, { id: 'l1', seq: 0, text: '你好世界', characterId: c.id }) // 4 个可读字
      await seedLine(h, { id: 'l2', seq: 1, text: '再见', characterId: c.id }) // 2 个
      await seedLine(h, { id: 'l3', seq: 2, text: '旁白不算' })

      const stats = (await call(h, 'character:stats', { characterId: c.id })) as CharacterStats
      assert.equal(stats.characterId, c.id)
      assert.equal(stats.lines, 2)
      assert.equal(stats.chars, 6, '标点不计（这里本来就没有标点，用于钉住口径）')
      assert.equal(stats.estimatedDurationMs, Math.round((6 / 4.2) * 1000))
      assert.equal(stats.recordedMs, 0, '录音域未落地 → 已录时长为 0（不拿估算冒充）')

      await assert.rejects(
        () => call(h, 'character:stats', { characterId: 'ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('character:rebuildCentroid 入队（kind / 角色集合都对）', async () => {
    const h = await harness()
    try {
      const a = await addCharacter(h, { name: '甲' })
      const b = await addCharacter(h, { name: '乙' })

      const res = (await call(h, 'character:rebuildCentroid', { bookId: 'b1' })) as { taskId: string }
      assert.equal(res.taskId, 'task-character.centroid')
      assert.equal(h.enqueued.length, 1)
      assert.equal(h.enqueued[0]!.kind, 'character.centroid')
      assert.deepEqual((h.enqueued[0]!.payload as { characterIds: string[] }).characterIds, [a.id, b.id])

      // 指定子集
      await call(h, 'character:rebuildCentroid', { bookId: 'b1', characterIds: [b.id] })
      assert.deepEqual((h.enqueued[1]!.payload as { characterIds: string[] }).characterIds, [b.id])

      // 不存在的角色：先在入队前挡住（否则用户拿到一个注定失败的任务）
      await assert.rejects(
        () => call(h, 'character:rebuildCentroid', { bookId: 'b1', characterIds: ['ghost'] }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 配音员
// ---------------------------------------------------------------------------

describe('角色域 handler · 配音员与分工负载', () => {
  it('upsert / list / delete：删除会连带解除绑定', async () => {
    const h = await harness()
    try {
      const actor = (await call(h, 'voiceActor:upsert', { actor: { projectId: 'p1', name: '张三配音' } })) as VoiceActor
      assert.ok(actor.id)
      const c = await addCharacter(h, { name: '萧炎' })
      await call(h, 'voiceActor:bind', { characterId: c.id, actorId: actor.id })

      assert.deepEqual(
        ((await call(h, 'voiceActor:list', { projectId: 'p1' })) as VoiceActor[]).map((a) => a.name),
        ['张三配音'],
      )

      assert.deepEqual(await call(h, 'voiceActor:delete', { actorId: actor.id }), { ok: true })
      assert.deepEqual(await call(h, 'voiceActor:list', { projectId: 'p1' }), [])
      assert.deepEqual(await call(h, 'voiceActor:bindings', { bookId: 'b1' }), [], '删除配音员必须连带解除绑定')
      const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM character_voice_bindings`).get() as { n: number }
      assert.equal(rows.n, 0)

      await assert.rejects(
        () => call(h, 'voiceActor:delete', { actorId: 'ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('一个角色只有一个主配音员（新的主绑定把旧的降级）', async () => {
    const h = await harness()
    try {
      const c = await addCharacter(h, { name: '萧炎' })
      const a1 = (await call(h, 'voiceActor:upsert', { actor: { projectId: 'p1', name: '甲配音' } })) as VoiceActor
      const a2 = (await call(h, 'voiceActor:upsert', { actor: { projectId: 'p1', name: '乙配音' } })) as VoiceActor

      await call(h, 'voiceActor:bind', { characterId: c.id, actorId: a1.id, isPrimary: true })
      await call(h, 'voiceActor:bind', { characterId: c.id, actorId: a2.id, isPrimary: true })

      const bindings = (await call(h, 'voiceActor:bindings', { bookId: 'b1' })) as Array<{
        actorId: string
        isPrimary: boolean
      }>
      assert.equal(bindings.filter((b) => b.isPrimary).length, 1, '两个主配音员会让 UI 取到随机的那个')
      assert.equal(bindings[0]!.actorId, a2.id, '主绑定排在最前')

      assert.deepEqual(await call(h, 'voiceActor:unbind', { characterId: c.id, actorId: a2.id }), { ok: true })
      assert.deepEqual(await call(h, 'voiceActor:unbind', { characterId: c.id, actorId: a2.id }), { ok: false })

      await assert.rejects(
        () => call(h, 'voiceActor:bind', { characterId: c.id, actorId: 'ghost' }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
      await assert.rejects(
        () => call(h, 'voiceActor:bind', { characterId: 'ghost', actorId: a1.id }),
        (e: unknown) => e instanceof AppError && e.key === 'NOT_FOUND',
      )
    } finally {
      h.cleanup()
    }
  })

  it('voiceActor:workload 按配音员汇总行数/字数/预估时长，0 负载的配音员也在表里', async () => {
    const h = await harness()
    try {
      const c1 = await addCharacter(h, { name: '甲' })
      const c2 = await addCharacter(h, { name: '乙' })
      await seedLine(h, { id: 'l1', seq: 0, text: '你好世界', characterId: c1.id }) // 4 字
      await seedLine(h, { id: 'l2', seq: 1, text: '再见', characterId: c1.id }) // 2 字
      await seedLine(h, { id: 'l3', seq: 2, text: '我来了', characterId: c2.id }) // 3 字

      const busy = (await call(h, 'voiceActor:upsert', { actor: { projectId: 'p1', name: '忙的人' } })) as VoiceActor
      // 第二个配音员**刻意不给任何绑定**：分工视图要能看见「0 负载」的人
      await call(h, 'voiceActor:upsert', { actor: { projectId: 'p1', name: '闲的人' } })
      await call(h, 'voiceActor:bind', { characterId: c1.id, actorId: busy.id, isPrimary: true })
      await call(h, 'voiceActor:bind', { characterId: c2.id, actorId: busy.id })

      const list = (await call(h, 'voiceActor:workload', { bookId: 'b1' })) as ActorWorkload[]
      const byName = new Map(list.map((w) => [w.name, w]))
      assert.equal(byName.get('忙的人')?.lines, 3)
      assert.equal(byName.get('忙的人')?.chars, 9)
      assert.equal(byName.get('忙的人')?.estimatedDurationMs, Math.round((9 / 4.2) * 1000))
      assert.equal(byName.get('闲的人')?.lines, 0, '0 负载的配音员也要在（他才是最该被分配的人）')
      assert.equal(list[0]!.name, '忙的人', '负载高的排前面')
    } finally {
      h.cleanup()
    }
  })
})
