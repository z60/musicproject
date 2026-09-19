/**
 * 测试 · 书籍导入域的 SQLite 层自检（不需要真正打开数据库）
 * ============================================================================
 * 设计依据：docs/21-数据字典与SQL.md（DDL 是列名的唯一权威）、docs/03 §1
 *
 * ### 这个文件解决什么问题
 *   本仓库的测试环境**不能加载 better-sqlite3**（它是按 Electron ABI 编译的，
 *   在 Node 里 require 会报 NODE_MODULE_VERSION 不匹配 —— 见 docs/91 §5.8）。
 *   所以「真的开一个库跑一遍 SQL」在测试里做不到。
 *
 *   但 SQL 层最容易出错、且**症状最隐蔽**的部分是**列名拼写**：
 *   把 `content_hash` 写成 `contentHash`、把 `source_type` 写成 `sourceType`，
 *   SQLite 会在运行期报 `no such column` —— 而那要到真机导入时才暴露。
 *
 *   本文件用两种**静态 + 半动态**手段把它挡住：
 *
 *   A. **从 DDL 抽出合法列名**，再检查仓储源码里出现的标识符是否都在其中。
 *      这能抓住任何列名拼写错误，包括我将来新加代码时的笔误。
 *
 *   B. **用一个「记录型」DbLike** 捕获仓储真正生成的 SQL 与参数，
 *      验证：SQL 里没有占位符数量与参数数量不匹配（那是 SQLite 的经典报错），
 *      且 INSERT 的列清单与 values 数量一一对应。
 *
 *   它**不能**替代真机验证（SQL 语义、约束、外键行为仍需真机），这一点如实记录在 docs/91。
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createSqliteBookRepo } from '../../src/main/features/book/import/repositories/book.repo.sqlite.ts'
import { createSqliteChapterRepo } from '../../src/main/features/book/import/repositories/chapter.repo.sqlite.ts'
import { createSqliteProjectRepo } from '../../src/main/features/book/import/repositories/project.repo.ts'
import { BOOK_PATCH_COLUMNS, CHAPTER_PATCH_COLUMNS } from '../../src/main/features/book/import/repositories/mappers.ts'
import type { DbLike, StatementLike } from '../../src/main/infra/db/types.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS_DIR = join(ROOT, 'src', 'main', 'infra', 'db', 'migrations')

/**
 * DDL 来源 = **全部**迁移脚本（001 + 002 + 003 …）。
 *
 * 以前只读 `001_init.sql`：一旦后续迁移新增表（例如 003 的
 * `canvas_generate_reports`），那张表的列就不在检查集合里，
 * 新代码里的列名笔误会被**当成合法**放过去 —— 守卫静默失效。
 */
const DDL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n')

// ---------------------------------------------------------------------------
// 从 DDL 抽取表结构
// ---------------------------------------------------------------------------

/** 从 `CREATE TABLE xxx (...)` 里取出列名（跳过约束行） */
export function parseDdlColumns(ddl: string, table: string): Set<string> {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\);`, 'i')
  const m = re.exec(ddl)
  assert.ok(m, `DDL 里找不到表 ${table}`)
  const cols = new Set<string>()
  for (const rawLine of m[1]!.split('\n')) {
    // 去掉行内注释
    const line = rawLine.replace(/--.*$/, '').trim()
    if (line === '') continue
    // 跳过表级约束
    if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)) continue
    const col = /^([a-z_][a-z0-9_]*)\s+/i.exec(line)
    if (col) cols.add(col[1]!)
  }
  return cols
}

// ---------------------------------------------------------------------------
// 记录型 DbLike：捕获 SQL 与参数，不真的执行
// ---------------------------------------------------------------------------

interface RecordedCall {
  sql: string
  params: unknown[]
}

interface RecordingDb {
  db: DbLike
  calls: RecordedCall[]
  /** 预置的 get 返回值（按 SQL 关键词匹配） */
  setGetResult(match: RegExp, value: unknown): void
  setAllResult(match: RegExp, value: unknown[]): void
}

function createRecordingDb(): RecordingDb {
  const calls: RecordedCall[] = []
  const getResults: Array<{ match: RegExp; value: unknown }> = []
  const allResults: Array<{ match: RegExp; value: unknown[] }> = []

  function makeStatement(sql: string): StatementLike {
    return {
      run(...params: unknown[]) {
        calls.push({ sql, params })
        return { changes: 1, lastInsertRowid: 1 }
      },
      get(...params: unknown[]) {
        calls.push({ sql, params })
        const hit = getResults.find((r) => r.match.test(sql))
        return hit?.value
      },
      all(...params: unknown[]) {
        calls.push({ sql, params })
        const hit = allResults.find((r) => r.match.test(sql))
        return hit?.value ?? []
      },
    }
  }

  const db: DbLike = {
    prepare: makeStatement,
    exec(sql: string) {
      calls.push({ sql, params: [] })
    },
    close() {
      /* no-op */
    },
    name: 'recording',
    open: true,
  }

  return {
    db,
    calls,
    setGetResult(match, value) {
      getResults.push({ match, value })
    },
    setAllResult(match, value) {
      allResults.push({ match, value })
    },
  }
}

// ---------------------------------------------------------------------------
// A. 列名自检
// ---------------------------------------------------------------------------

describe('SQL 列名与 DDL 一致（防「拼错列名」这类运行期才炸的错）', () => {
  it('检查器本身有效：能从合成 DDL 里抽出列名，并识别出不存在的列', () => {
    // 一个「永远通过」的检查器等于没有检查器。
    // 这里用一段合成 DDL 验证解析器真的在工作：能抽列、能跳过约束行。
    const synthetic = `
CREATE TABLE IF NOT EXISTS demo (
  id          TEXT PRIMARY KEY,
  user_name   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_name),
  CHECK (created_at >= 0)
);
`
    const cols = parseDdlColumns(synthetic, 'demo')
    assert.deepEqual([...cols].sort(), ['created_at', 'id', 'user_name'])
    // 表级约束不该被当成列
    assert.equal(cols.has('UNIQUE'), false)
    assert.equal(cols.has('CHECK'), false)
    // 不存在的列必须能被判否 —— 这正是主断言的判据
    assert.equal(cols.has('userName'), false)
  })

  it('books 表的列集合符合预期', () => {
    const cols = parseDdlColumns(DDL, 'books')
    // 抽查关键列：这些是仓储与映射层直接用到的
    for (const c of [
      'id',
      'project_id',
      'title',
      'author',
      'narrator',
      'language',
      'source_type',
      'source_path',
      'encoding',
      'content_hash',
      'char_count',
      'chapter_count',
      'cover_path',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      assert.ok(cols.has(c), `books 表缺少列 ${c}（DDL 改了？）`)
    }
  })

  it('BOOK_PATCH_COLUMNS 里的每个列名都在 books 表里存在', () => {
    const cols = parseDdlColumns(DDL, 'books')
    for (const [field, col] of Object.entries(BOOK_PATCH_COLUMNS)) {
      assert.ok(cols.has(col), `BOOK_PATCH_COLUMNS['${field}'] = '${col}'，但 books 表没有这一列`)
    }
  })

  it('CHAPTER_PATCH_COLUMNS 里的每个列名都在 chapters 表里存在', () => {
    const cols = parseDdlColumns(DDL, 'chapters')
    for (const [field, col] of Object.entries(CHAPTER_PATCH_COLUMNS)) {
      assert.ok(cols.has(col), `CHAPTER_PATCH_COLUMNS['${field}'] = '${col}'，但 chapters 表没有这一列`)
    }
  })

  it('仓储源码里 SELECT/INSERT/UPDATE 引用的列名都合法（含**别名限定**列）', () => {
    // 这是本文件的主力断言：把仓储源码里出现的裸标识符当候选列名，
    // 凡是「看起来像列名（snake_case）但不在 DDL 里」的都报出来。
    //
    // ⚠️ **为什么要单独处理别名限定列**：原先只在 books/chapters/projects 三张表的列集合里
    // **并集**查找，于是 `l.char_count` 里的 `char_count` 会被 chapters 的列名喂饱 ——
    // 而它实际限定的是 `canvas_lines`（**那张表没有 char_count 列**），
    // 真机上会 100% 抛 `SQLITE_ERROR: no such column: l.char_count`。
    // 这个假绿差点放过一个「每次调用必炸」的缺陷（docs/91 §5.2.8）。
    // 现在：先把源码里的 `FROM/JOIN <表> <别名>` 收成别名表，再拿 `别名.列` 去**对应表**里查。
    const files = [
      'src/main/features/book/import/repositories/book.repo.sqlite.ts',
      'src/main/features/book/import/repositories/chapter.repo.sqlite.ts',
      'src/main/features/book/import/repositories/project.repo.ts',
      // 画本行仓储：29 列手写 INSERT + 子查询，是最需要这类守卫的地方
      'src/main/features/book/canvas/repositories/canvas.repo.sqlite.ts',
      'src/main/features/book/canvas/repositories/canvas-line.repo.sqlite.ts',
      'src/main/features/book/canvas/repositories/character.repo.sqlite.ts',
      // 配音员与绑定：`profile` 是 JSON 列、绑定表有 UNIQUE(character_id, actor_id)
      'src/main/features/book/canvas/repositories/voice-actor.repo.sqlite.ts',
    ]
    const TYPED_TABLES = [
      'books',
      'chapters',
      'projects',
      'canvas_lines',
      'voice_segments',
      'takes',
      // 画本域另外两张表：向量的 BLOB 与快照的 gzip payload 都在这两张表里，
      // 列名写错同样只在运行期报错
      'line_embeddings',
      'canvas_snapshots',
      // 角色域（画本生成要用：说话人判定、原型向量、配音员绑定）
      'characters',
      'character_aliases',
      'character_centroids',
      'voice_actors',
      'character_voice_bindings',
      // 003 迁移新增：生成报告（一章一行）
      'canvas_generate_reports',
    ]
    const tableCols = new Map<string, Set<string>>(TYPED_TABLES.map((t) => [t, parseDdlColumns(DDL, t)]))
    const allCols = new Set<string>()
    for (const cols of tableCols.values()) for (const c of cols) allCols.add(c)

    // 允许出现的非列名标识符（SQL 关键字、表名、别名、函数名）
    const allowed = new Set([
      'id', 'book_id', 'project_id', 'deleted_at', 'created_at', 'updated_at',
      'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'and', 'is', 'not', 'null',
      'order', 'by', 'asc', 'desc', 'limit', 'offset', 'count', 'as', 'n', 'on', 'conflict', 'do', 'excluded',
      'begin', 'immediate', 'commit', 'rollback', 'pragma', 'sqlite_',
      'books', 'chapters', 'projects', 'chapter_rule_sets',
      'name', 'value', 'key', 'settings', 'description', 'root_dir', 'schema_version', 'definition', 'builtin',
      // 别名限定列里会用到的 SQL 函数（`SUM(LENGTH(l.text))` 等）
      'length', 'sum', 'coalesce', 'case', 'when', 'then', 'else', 'end', 'in', 'join', 'left', 'inner', 'group',
      'true', 'false', 'max', 'min', 'abs', 'replace', 'exists',
      // 错误详情里的**实体名**（`details: { entity: 'canvas_line' }`），不是列名。
      // 它之所以会出现在 SQL 扫描块里，是因为块是按「反引号配对」切的，
      // 而注释里的反引号会把相邻代码一起圈进来。
      'canvas_line',
    ])
    // 表名本身不是列名，别让它们被裸标识符检查误报（新增表时自动生效，不必手工维护）
    for (const t of TYPED_TABLES) allowed.add(t)

    for (const rel of files) {
      const src = readFileSync(join(ROOT, rel), 'utf8')

      /** 别名 → 表（文件级收集：`${PROGRESS_COLS}` 这类片段会把别名与 FROM 拆到两处） */
      const aliasToTable = new Map<string, string>()
      for (const m of src.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/gi)) {
        const table = m[1]!
        const alias = m[2]!
        if (!tableCols.has(table)) continue
        // `... FROM chapters WHERE` 这类：第二个词是关键字而不是别名
        if (allowed.has(alias)) continue
        aliasToTable.set(alias, table)
      }

      // 只检查 SQL 字符串字面量内部（反引号与单引号包裹的多行 SQL）
      const sqlChunks = [...src.matchAll(/`([^`]*?(?:SELECT|INSERT|UPDATE|DELETE)[^`]*?)`/gis)].map((m) => m[1]!)
      for (const chunk of sqlChunks) {
        // ① 别名（或表名）限定列：`l.char_count` → 必须是 canvas_lines 的列
        //
        // ⚠️ 只看**含 SQL 关键字的行**：块是按「反引号配对」切的，注释里的反引号会把
        // 相邻的 TS 代码一起圈进来（例如 `const msg = e instanceof Error ? e.message : …`
        // 里的 `e.message`，而 `e` 恰好是 `line_embeddings` 的别名）→ 假阳性。
        // SQL 一行里必然出现 SELECT/FROM/WHERE/SET/VALUES/ON 之类关键字，用它筛掉代码行。
        const SQL_LINE = /\b(select|insert|update|delete|from|join|where|and|or|on|set|values|as|group|order|by|limit|offset|conflict|excluded|returning)\b/i
        for (const rawLine of chunk.split('\n')) {
          if (!SQL_LINE.test(rawLine)) continue
          for (const m of rawLine.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g)) {
            const qualifier = m[1]!
            const col = m[2]!
            const table = aliasToTable.get(qualifier) ?? (tableCols.has(qualifier) ? qualifier : null)
            if (!table) continue
            assert.ok(
              tableCols.get(table)!.has(col),
              `${rel} 的 SQL 里出现 '${qualifier}.${col}'，但 **${table} 表没有 '${col}' 列**。\n` +
                `  这类缺陷数据库要到真正 prepare/执行时才报 'no such column'，` +
                `而并集式检查会把它放过去 —— 所以这里按别名解析到具体表再查。`,
            )
          }
        }

        // ② 裸标识符（原有检查，并集）
        //    `AS xxx` 定义的是**输出别名**，不是对已有列的引用 —— 自动视为合法，
        //    否则每加一个派生列都要来手工维护白名单（而漏维护只会得到假红）。
        const outputAliases = new Set(
          [...chunk.matchAll(/\bAS\s+([a-z][a-z0-9_]*)\b/gi)].map((m) => m[1]!),
        )
        const tokens = chunk.match(/\b[a-z][a-z0-9_]*\b/g) ?? []
        for (const t of tokens) {
          if (allowed.has(t) || outputAliases.has(t)) continue
          // 只对「snake_case 且长度>3」的 token 报错，避免误报普通单词
          if (!t.includes('_') || t.length < 4) continue
          assert.ok(
            allCols.has(t),
            `${rel} 的 SQL 里出现 '${t}' —— 不在任何已声明表的列里。` +
              `若这是新加的列，请先在 001_init.sql 里加（或用新迁移）。`,
          )
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// B. SQL 与参数一致性
// ---------------------------------------------------------------------------

describe('SQL 占位符与参数数量一致', () => {
  it('books.insert 的列数与参数个数相同', async () => {
    const rec = createRecordingDb()
    const repo = createSqliteBookRepo(rec.db)
    await repo.insert({
      id: 'b1',
      projectId: 'p1',
      title: 'T',
      author: null,
      narrator: '旁白',
      language: 'zh-CN',
      sourceType: 'txt',
      sourcePath: null,
      encoding: 'UTF-8',
      contentHash: 'h',
      charCount: 10,
      chapterCount: 1,
      coverPath: null,
      createdAt: 1,
      updatedAt: 1,
    })
    const insert = rec.calls.find((c) => /INSERT INTO books/i.test(c.sql))
    assert.ok(insert, '没有产生 INSERT INTO books')
    const colCount = (insert.sql.match(/^\s*INSERT INTO books \(([^)]*)\)/i)?.[1] ?? '').split(',').length
    const placeholders = (insert.sql.match(/\?/g) ?? []).length
    assert.equal(colCount, placeholders, 'INSERT 的列数与占位符数不一致')
    assert.equal(insert.params.length, placeholders, '传入的参数个数与占位符数不一致')
  })

  it('chapters.insertMany 的列数与参数个数相同', async () => {
    const rec = createRecordingDb()
    const repo = createSqliteChapterRepo(rec.db)
    await repo.insertMany([
      {
        chapter: {
          id: 'c1',
          bookId: 'b1',
          seq: 1,
          title: '第一章',
          kind: 'chapter',
          volumeSeq: null,
          volumeTitle: null,
          charCount: 5,
          startOffset: 0,
          endOffset: 5,
          canvasState: 'none',
          lineCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        rawText: '正文',
        text: '正文',
      },
    ])
    const insert = rec.calls.find((c) => /INSERT INTO chapters/i.test(c.sql))
    assert.ok(insert, '没有产生 INSERT INTO chapters')
    const colCount = (insert.sql.match(/^\s*INSERT INTO chapters \(([^)]*)\)/i)?.[1] ?? '').split(',').length
    const placeholders = (insert.sql.match(/\?/g) ?? []).length
    assert.equal(colCount, placeholders, 'INSERT 的列数与占位符数不一致')
    assert.equal(insert.params.length, placeholders, '传入的参数个数与占位符数不一致')
  })

  it('list 的 WHERE 与参数一致（带 projectId 过滤）', async () => {
    const rec = createRecordingDb()
    const repo = createSqliteBookRepo(rec.db)
    await repo.list({ projectId: 'p1', limit: 10, offset: 5 })
    const q = rec.calls.find((c) => /SELECT[\s\S]*FROM books/i.test(c.sql))
    assert.ok(q, '没有产生 SELECT FROM books')
    const placeholders = (q.sql.match(/\?/g) ?? []).length
    assert.equal(q.params.length, placeholders, 'SELECT 的占位符与参数数不一致')
    assert.ok(placeholders >= 3, `期望至少 3 个占位符（deleted_at/project_id/limit），实际 ${placeholders}`)
  })

  it('list 不带参数时也产生合法 SQL（不出现悬空 WHERE）', async () => {
    const rec = createRecordingDb()
    const repo = createSqliteBookRepo(rec.db)
    await repo.list()
    const q = rec.calls.find((c) => /SELECT[\s\S]*FROM books/i.test(c.sql))
    assert.ok(q)
    assert.ok(/WHERE deleted_at IS NULL/.test(q.sql), q.sql)
    assert.equal((q.sql.match(/\?/g) ?? []).length, 0, '无过滤条件时不应有占位符')
  })
})

// ---------------------------------------------------------------------------
// C. 软件行为：软删除过滤与错误语义
// ---------------------------------------------------------------------------

describe('仓储的读操作过滤软删除', () => {
  it('findById / list / count 的 SQL 都带 deleted_at IS NULL', async () => {
    const rec = createRecordingDb()
    const repo = createSqliteBookRepo(rec.db)
    await repo.findById('b1')
    await repo.list()
    await repo.count()
    const reads = rec.calls.filter((c) => /FROM books/i.test(c.sql))
    assert.equal(reads.length, 3)
    for (const r of reads) {
      assert.ok(/deleted_at IS NULL/i.test(r.sql), `读操作必须过滤软删除记录：${r.sql}`)
    }
  })

  it('章节的读操作同样过滤软删除', async () => {
    const rec = createRecordingDb()
    const repo = createSqliteChapterRepo(rec.db)
    await repo.findById('c1')
    await repo.listByBook('b1')
    await repo.countByBook('b1')
    for (const r of rec.calls) {
      assert.ok(/deleted_at IS NULL/i.test(r.sql), `章节读操作必须过滤软删除：${r.sql}`)
    }
  })
})

describe('项目仓库：ensureDefault 的三种情况', () => {
  it('指定 id 且已存在 → 直接复用，不新建', async () => {
    const rec = createRecordingDb()
    rec.setGetResult(/FROM projects WHERE deleted_at IS NULL AND id = \?/i, {
      id: 'p1',
      name: '已有项目',
      description: null,
      root_dir: '/root/p1',
      schema_version: 1,
      settings: null,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    const repo = createSqliteProjectRepo(rec.db)
    const p = await repo.ensureDefault({ projectId: 'p1', projectRoot: '/root' })
    assert.equal(p.id, 'p1')
    assert.equal(p.name, '已有项目')
    assert.equal(rec.calls.some((c) => /INSERT INTO projects/i.test(c.sql)), false, '不该新建')
  })

  it('指定 id 但不存在 → 用它建（目录为 projectRoot/id）', async () => {
    const rec = createRecordingDb()
    rec.setGetResult(/FROM projects WHERE deleted_at IS NULL AND id = \?/i, undefined)
    const repo = createSqliteProjectRepo(rec.db)
    const p = await repo.ensureDefault({ projectId: 'p9', projectRoot: '/root' })
    assert.equal(p.id, 'p9')
    assert.equal(p.rootDir, '/root/p9')
    assert.ok(rec.calls.some((c) => /INSERT INTO projects/i.test(c.sql)), '应该新建')
  })

  it('不指定 id 且已有项目 → 复用第一个（不重复建）', async () => {
    const rec = createRecordingDb()
    rec.setAllResult(/FROM projects WHERE deleted_at IS NULL ORDER BY/i, [
      {
        id: 'existing',
        name: 'A',
        description: null,
        root_dir: '/root/existing',
        schema_version: 1,
        settings: null,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    ])
    const repo = createSqliteProjectRepo(rec.db)
    const p = await repo.ensureDefault({ projectRoot: '/root' })
    assert.equal(p.id, 'existing')
    assert.equal(rec.calls.some((c) => /INSERT INTO projects/i.test(c.sql)), false, '不该新建')
  })

  it('不指定 id 且一个项目都没有 → 建默认项目（固定 id）', async () => {
    const rec = createRecordingDb()
    rec.setAllResult(/FROM projects WHERE deleted_at IS NULL ORDER BY/i, [])
    const repo = createSqliteProjectRepo(rec.db)
    const p = await repo.ensureDefault({ projectRoot: '/root' })
    assert.equal(p.id, 'default')
    assert.equal(p.rootDir, '/root/default')
    assert.ok(rec.calls.some((c) => /INSERT INTO projects/i.test(c.sql)))
  })
})

// ---------------------------------------------------------------------------
// D. 映射层：NULL 的处理纪律
// ---------------------------------------------------------------------------

describe('行 → 领域对象的映射', () => {
  it('narrator 为 NULL 时映射成空串（领域类型是非空 string）', async () => {
    const { bookFromRow } = await import('../../src/main/features/book/import/repositories/mappers.ts')
    const book = bookFromRow({
      id: 'b1',
      project_id: 'p1',
      title: 'T',
      author: null,
      narrator: null, // ← 库里的 NULL
      language: 'zh-CN',
      source_type: 'txt',
      source_path: null,
      source_pages: null,
      encoding: null,
      content_hash: 'h',
      char_count: 0,
      chapter_count: 0,
      cover_path: null,
      metadata: null,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    // 领域类型是 `string`，直接透传 null 会让 UI 显示 "null"
    assert.equal(book.narrator, '')
    assert.equal(book.author, null, 'author 在领域类型里可空，应保持 null')
  })

  it('source_type 原样转成 BookSourceType', async () => {
    const { bookFromRow } = await import('../../src/main/features/book/import/repositories/mappers.ts')
    const mk = (t: string) =>
      bookFromRow({
        id: 'b',
        project_id: 'p',
        title: 'T',
        author: null,
        narrator: 'n',
        language: 'zh-CN',
        source_type: t,
        source_path: null,
        source_pages: null,
        encoding: null,
        content_hash: 'h',
        char_count: 0,
        chapter_count: 0,
        cover_path: null,
        metadata: null,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
    for (const t of ['txt', 'docx', 'pdf', 'paste', 'url']) {
      assert.equal(mk(t).sourceType, t)
    }
  })
})
