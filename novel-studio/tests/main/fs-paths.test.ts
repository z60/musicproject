/**
 * 测试 · 文件系统与路径（src/main/infra/fs）
 * ============================================================================
 * 设计依据：
 *   · docs/04 §3「路径解析必须强制校验结果落在项目目录内（防 .. 逃逸）」
 *   · docs/03 §2「数据库中只存相对路径」
 *   · docs/05 §9.3「文件名清洗：去特殊字符、UTF-8 字节截断 120、同名加 _2」
 *
 * 这是**安全测试**：路径逃逸一旦漏过，渲染进程被注入后就能读写任意文件。
 * 因此对每一类逃逸手法都单独断言，而不是只测一个 `../../`。
 */

import { strict as assert } from 'node:assert'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { AppError } from '../../src/shared/errors.ts'
import {
  atomicWriteFile,
  cacheKey,
  checkFreeSpace,
  estimateRecordingBytes,
  expandTemplate,
  fileFingerprint,
  isProtectedPath,
  isUserAssetPath,
  normalizeRelPath,
  projectDir,
  resolveProjectPath,
  resolveResourcePath,
  safeRemove,
  sanitizeFileName,
  sha256Buffer,
  sha256File,
  stableStringify,
  toRelativePath,
  truncateUtf8,
  withTempDir,
} from '../../src/main/infra/fs/index.ts'

const PROJECT_ROOT = process.platform === 'win32' ? 'C:\\data\\projects' : '/data/projects'

let workDir = ''

before(async () => {
  workDir = await fsp.mkdtemp(join(tmpdir(), 'ns-fs-test-'))
})

after(async () => {
  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('resolveProjectPath · 逃逸必须被拒绝', () => {
  const escapes: Array<[string, string]> = [
    ['../../etc/passwd', '经典父目录逃逸'],
    ['..\\..\\Windows\\System32\\config', 'Windows 反斜杠逃逸'],
    ['../../../root/.ssh/id_rsa', '多层逃逸'],
    ['recordings/../../secret.txt', '中途折返'],
    ['/etc/passwd', 'POSIX 绝对路径'],
    ['C:\\Windows\\win.ini', 'Windows 盘符'],
    ['C:Windows', '无斜杠盘符'],
    ['\\\\server\\share\\file', 'UNC 路径'],
    ['//server/share', 'POSIX 风格 UNC'],
    ['file:///etc/passwd', 'file URL'],
    ['..%2f..%2fetc/passwd', '百分号编码的 ../'],
    ['..%5c..%5cetc%5cpasswd', '百分号编码的 ..\\'],
    ['%2e%2e/%2e%2e/etc/passwd', '百分号编码的点'],
    ['recordings/..%2f..%2fpasswd', '局部编码逃逸'],
    ['a\u0000b', 'NUL 字节截断'],
    ['', '空路径'],
  ]

  for (const [evil, reason] of escapes) {
    it(`拒绝：${reason}（${JSON.stringify(evil)}）`, () => {
      const err = (() => {
        try {
          resolveProjectPath('p1', evil, PROJECT_ROOT)
          return null
        } catch (e) {
          return e
        }
      })()
      assert.ok(err instanceof AppError, '期望抛 AppError')
      assert.equal((err as AppError).key, 'PATH_ESCAPE_BLOCKED')
      assert.equal((err as AppError).details?.reason !== undefined, true)
    })
  }

  it('项目 ID 本身也走白名单（防跨项目读取）', () => {
    for (const badId of ['..', '../p1', 'p1/../p2', 'p1\\p2', '.', '', 'a'.repeat(200)]) {
      assert.throws(
        () => resolveProjectPath(badId, 'recordings/a.wav', PROJECT_ROOT),
        (e: unknown) => e instanceof AppError && e.key === 'PATH_ESCAPE_BLOCKED',
        `projectId 应被拒绝：${badId}`,
      )
    }
  })

  it('正常相对路径被解析到项目目录之内', () => {
    const abs = resolveProjectPath('p1', 'recordings/abc.wav', PROJECT_ROOT)
    assert.equal(abs, join(projectDir('p1', PROJECT_ROOT), 'recordings', 'abc.wav'))
    assert.ok(abs.includes(join('projects', 'p1', 'recordings')))
  })

  it('等价写法被归一化（./ 与重复分隔符）', () => {
    const a = resolveProjectPath('p1', './recordings//abc.wav', PROJECT_ROOT)
    const b = resolveProjectPath('p1', 'recordings/abc.wav', PROJECT_ROOT)
    assert.equal(a, b)
    assert.equal(normalizeRelPath('a/./b//c'), 'a/b/c')
    assert.equal(normalizeRelPath('takes\\l1\\t1.wav'), 'takes/l1/t1.wav')
  })
})

describe('assertInsideRoot 同前缀陷阱', () => {
  it('`/a/bc` 不属于 `/a/b`（不能用 startsWith 实现包含判断）', () => {
    assert.throws(
      () => toRelativePath(join(PROJECT_ROOT, 'bc', 'x.wav'), join(PROJECT_ROOT, 'b')),
      (e: unknown) => e instanceof AppError && e.key === 'PATH_ESCAPE_BLOCKED',
    )
  })

  it('根目录自身返回 "."，子路径返回以 / 分隔的相对路径', () => {
    assert.equal(toRelativePath(PROJECT_ROOT, PROJECT_ROOT), '.')
    assert.equal(toRelativePath(join(PROJECT_ROOT, 'p1', 'segments', 'a.wav'), PROJECT_ROOT), 'p1/segments/a.wav')
  })

  it('绝对路径 → 相对路径往返一致（入库只存相对路径）', () => {
    const rel = 'recordings/2026-02-14.wav'
    const abs = resolveProjectPath('p1', rel, PROJECT_ROOT)
    assert.equal(toRelativePath(abs, projectDir('p1', PROJECT_ROOT)), rel)
  })
})

describe('resolveResourcePath · 开发/打包两种根', () => {
  it('打包环境用 resourcesPath', () => {
    const p = resolveResourcePath('models/ggml-base.bin', {
      isPackaged: true,
      resourcesPath: process.platform === 'win32' ? 'C:\\app\\resources' : '/app/resources',
    })
    assert.ok(p.includes('models'))
    assert.ok(p.includes('resources'))
  })

  it('开发环境用 devRoot/resources', () => {
    const devRoot = process.platform === 'win32' ? 'C:\\repo' : '/repo'
    const p = resolveResourcePath('bin/ffmpeg.exe', { isPackaged: false, devRoot })
    assert.equal(p, join(devRoot, 'resources', 'bin', 'ffmpeg.exe'))
  })

  it('资源路径同样禁止逃逸；缺根时抛 APP_CONFIG_INVALID', () => {
    assert.throws(
      () => resolveResourcePath('../secrets.txt', { isPackaged: false, devRoot: '/repo' }),
      (e: unknown) => e instanceof AppError && e.key === 'PATH_ESCAPE_BLOCKED',
    )
    assert.throws(
      () => resolveResourcePath('models/a.bin', { isPackaged: true, resourcesPath: null }),
      (e: unknown) => e instanceof AppError && e.key === 'APP_CONFIG_INVALID',
    )
    assert.throws(
      () => resolveResourcePath('models/a.bin', { isPackaged: false, devRoot: null }),
      (e: unknown) => e instanceof AppError && e.key === 'APP_CONFIG_INVALID',
    )
  })
})

describe('sanitizeFileName · 特殊字符 / 字节截断 / 同名冲突', () => {
  it('替换跨平台非法字符与控制字符', () => {
    assert.equal(sanitizeFileName('a:b*c?.mp3'), 'a_b_c_.mp3')
    assert.equal(sanitizeFileName('a<b>c|d"e\\f/g.mp3'), 'g.mp3', '路径分隔符只取最后一段')
    assert.equal(sanitizeFileName('bad\u0001name.txt'), 'badname.txt')
    assert.equal(sanitizeFileName('  空格  .txt'), '空格  .txt')
    assert.equal(sanitizeFileName('尾点...'), '尾点')
  })

  it('空名与纯符号名回退为 untitled', () => {
    assert.equal(sanitizeFileName(''), 'untitled')
    assert.equal(sanitizeFileName('///'), 'untitled')
    assert.equal(sanitizeFileName('..'), 'untitled')
  })

  it('按 UTF-8 字节数截断到上限，且不切断多字节字符', () => {
    const name = `${'斗'.repeat(200)}.mp3` // 每字 3 字节，远超 120
    const out = sanitizeFileName(name, 120)
    assert.ok(Buffer.byteLength(out, 'utf8') <= 120, `实际 ${Buffer.byteLength(out, 'utf8')} 字节`)
    assert.ok(out.endsWith('.mp3'), '扩展名必须保留')
    assert.equal(out.includes('\ufffd'), false, '不能出现半个字符')
    // 截断后的中文字符数 = floor((120 - 4) / 3)
    assert.equal(out.slice(0, -4).length, Math.floor((120 - 4) / 3))
  })

  it('自定义字节上限生效（最小 8 字节，超出则截断主干保留扩展名）', () => {
    const out = sanitizeFileName('abcdefghijklmnop.txt', 12)
    assert.ok(Buffer.byteLength(out, 'utf8') <= 12, `实际 ${Buffer.byteLength(out, 'utf8')} 字节`)
    assert.ok(out.endsWith('.txt'))
    // 上限 4 被夹到最小值 8：主干 4 字节 + 扩展名 4 字节
    const clamped = sanitizeFileName('abcdefghijklmnop.txt', 4)
    assert.equal(clamped, 'abcd.txt')
    assert.ok(Buffer.byteLength(clamped, 'utf8') <= 8)
  })

  it('同名冲突加 _2 / _3，扩展名保持在末尾', () => {
    assert.equal(sanitizeFileName('第1章.mp3', 120, ['第1章.mp3']), '第1章_2.mp3')
    assert.equal(sanitizeFileName('第1章.mp3', 120, ['第1章.mp3', '第1章_2.mp3']), '第1章_3.mp3')
    assert.equal(sanitizeFileName('无扩展名', 120, ['无扩展名']), '无扩展名_2')
    assert.equal(sanitizeFileName('第1章.mp3', 120, []), '第1章.mp3')
  })

  it('truncateUtf8 不产生半个码点（含 emoji 代理对）', () => {
    assert.equal(truncateUtf8('🎧🎧', 4), '🎧')
    assert.equal(truncateUtf8('中文', 3), '中')
    assert.equal(truncateUtf8('中文', 0), '')
    assert.equal(truncateUtf8('abc', 10), 'abc')
  })
})

describe('expandTemplate · 导出命名模板', () => {
  const vars = { bookTitle: '斗破苍穹', chapterIndex: 1, chapterTitle: '陨落的天才', narrator: '旁白A', date: new Date(2026, 1, 14) }

  it('默认模板渲染为 001_第1章（补零三位）', () => {
    assert.equal(
      expandTemplate('{bookTitle}/{chapterIndex:03}_{chapterTitle}', vars),
      '斗破苍穹/001_陨落的天才',
    )
  })

  it('补零宽度可自定义；数值才会补零', () => {
    assert.equal(expandTemplate('{chapterIndex:02}', { chapterIndex: 7 }), '07')
    assert.equal(expandTemplate('{chapterIndex:05}', { chapterIndex: 123 }), '00123')
    assert.equal(expandTemplate('{chapterIndex}', { chapterIndex: 7 }), '7')
    assert.equal(expandTemplate('{chapterIndex:03}', { chapterTitle: 'x' }), '', '缺值时不补零，替换为空串')
  })

  it('未知占位符默认原样保留（用户能看出模板写错了）', () => {
    assert.equal(expandTemplate('{bookTitle}-{unknownVar}-{chapterIndex}', vars), '斗破苍穹-{unknownVar}-1')
    assert.equal(expandTemplate('{unknownVar}', vars, { onUnknown: 'empty' }), '')
  })

  it('日期占位符与自定义 fallback', () => {
    assert.equal(expandTemplate('{date}_{bookTitle}', vars), '2026-02-14_斗破苍穹')
    assert.equal(expandTemplate('{narrator}-{date}', { date: '2026-01-01' }), '-2026-01-01')
    assert.equal(expandTemplate('{narrator}', {}, { fallback: '未知' }), '未知')
  })

  it('模板值不会被二次解析（防书名里的花括号注入）', () => {
    assert.equal(expandTemplate('{bookTitle}', { bookTitle: '{chapterIndex}' }), '{chapterIndex}')
  })
})

describe('atomicWriteFile / withTempDir / safeRemove', () => {
  it('原子写：写入成功且内容正确，覆盖已有文件', async () => {
    const target = join(workDir, 'a.txt')
    await atomicWriteFile(target, 'first')
    assert.equal(await fsp.readFile(target, 'utf8'), 'first')
    await atomicWriteFile(target, 'second')
    assert.equal(await fsp.readFile(target, 'utf8'), 'second')
  })

  it('原子写失败不留半成品（目标被目录占用时 rename 失败）', async () => {
    const target = join(workDir, 'occupied')
    await fsp.mkdir(target, { recursive: true })
    await assert.rejects(() => atomicWriteFile(target, 'x'))
    const leftovers = (await fsp.readdir(workDir)).filter((n) => n.startsWith('occupied') && n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], '失败后不允许残留 .tmp')
  })

  it('原子写失败抛业务异常（不再是裸 errno）', async () => {
    const target = join(workDir, 'occupied2')
    await fsp.mkdir(target, { recursive: true })
    await assert.rejects(
      () => atomicWriteFile(target, 'x'),
      (e: unknown) => e instanceof AppError,
    )
  })

  it('withTempDir 在成功与异常两种情况下都清理', async () => {
    let seen = ''
    const base = join(workDir, 'tmpbase')
    const ok = await withTempDir(base, 'record', async (dir) => {
      seen = dir
      await fsp.writeFile(join(dir, 'x.bin'), 'data')
      assert.ok(dir.startsWith(base))
      return 'done'
    })
    assert.equal(ok, 'done')
    await assert.rejects(() => fsp.stat(seen), '成功后临时目录必须被删除')

    let seen2 = ''
    await assert.rejects(
      () =>
        withTempDir(base, 'record', async (dir) => {
          seen2 = dir
          throw new Error('任务失败')
        }),
      /任务失败/,
    )
    await assert.rejects(() => fsp.stat(seen2), '失败后临时目录也必须被删除')
  })

  it('safeRemove 拒绝删除项目根 / 模型目录 / 数据库（含 -wal）', async () => {
    const opts = {
      projectRoot: join(workDir, 'projects'),
      modelDir: join(workDir, 'models'),
      dbPath: join(workDir, 'novel-studio.db'),
      userDataDir: workDir,
    }
    for (const target of [
      opts.projectRoot,
      opts.modelDir,
      opts.dbPath,
      `${opts.dbPath}-wal`,
      `${opts.dbPath}-shm`,
      workDir,
    ]) {
      await assert.rejects(
        () => safeRemove(target, opts),
        (e: unknown) => e instanceof AppError && e.key === 'PERMISSION_DENIED',
        `应拒绝删除：${target}`,
      )
    }
  })

  it('safeRemove 正常删除普通临时文件；dryRun 不真删', async () => {
    const f = join(workDir, 'garbage.tmp')
    await fsp.writeFile(f, 'x')
    assert.equal(await safeRemove(f, { dryRun: true, userDataDir: join(workDir, 'other') }), true)
    assert.equal(await fsp.readFile(f, 'utf8'), 'x', 'dryRun 不应删除')

    assert.equal(await safeRemove(f, { userDataDir: join(workDir, 'other') }), true)
    await assert.rejects(() => fsp.stat(f))
  })

  it('isProtectedPath 只保护「根本身」与数据库系文件；isUserAssetPath 只保护素材目录', () => {
    // 只保护根本身：userData 内部的 cache/tmp 必须可清理，否则缓存永远清不掉
    assert.equal(isProtectedPath(workDir, { userDataDir: workDir }), true)
    assert.equal(isProtectedPath(join(workDir, 'cache', 'tmp', 'x.bin'), { userDataDir: workDir }), false)
    // 数据库及其 -wal/-shm 是同一份数据，必须一起保护
    const db = join(workDir, 'novel-studio.db')
    assert.equal(isProtectedPath(db, { dbPath: db }), true)
    assert.equal(isProtectedPath(`${db}-wal`, { dbPath: db }), true)
    // 用户素材目录（recordings 等）受保护，项目内的 .tmp 不受保护（那是垃圾区）
    const projects = join(workDir, 'projects')
    assert.equal(isUserAssetPath(join(projects, 'p1', 'recordings', 'a.wav.tmp'), projects), true, '录音目录受保护')
    assert.equal(isUserAssetPath(join(projects, 'p1', '.tmp', 'a.bin'), projects), false, '项目临时目录可清理')
  })
})

describe('哈希与稳定序列化', () => {
  it('sha256Buffer 与 sha256File 对同一内容结果一致（流式与内存一致）', async () => {
    const content = 'Novel Studio · 音频管线 ' + 'x'.repeat(5000)
    const f = join(workDir, 'hash.bin')
    await fsp.writeFile(f, content)
    assert.equal(await sha256File(f), sha256Buffer(content))
    assert.match(await sha256File(f), /^[0-9a-f]{64}$/)
  })

  it('sha256File 对不存在的文件抛业务异常', async () => {
    await assert.rejects(
      () => sha256File(join(workDir, 'missing.bin')),
      (e: unknown) => e instanceof AppError && e.key === 'FILE_NOT_FOUND',
    )
  })

  it('stableStringify 键排序：字面量顺序不同 → 同一串', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
    assert.equal(stableStringify({ a: 2, b: 1 }), '{"a":2,"b":1}')
    assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}')
    assert.equal(stableStringify([3, 1, 2]), '[3,1,2]')
    assert.equal(stableStringify(new Date(0)), '"1970-01-01T00:00:00.000Z"')
    assert.equal(stableStringify({ z: { y: [1, { b: 2, a: 1 }] } }), '{"z":{"y":[1,{"a":1,"b":2}]}}')
  })

  it('stableStringify 遇到循环引用抛 INTERNAL（缓存键必须有限）', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    assert.throws(
      () => stableStringify(cyclic),
      (e: unknown) => e instanceof AppError && e.key === 'INTERNAL',
    )
  })

  it('cacheKey 不因参数分隔符而撞键', () => {
    assert.notEqual(cacheKey('a|b', 'c'), cacheKey('a', 'b|c'))
    assert.equal(cacheKey('a', 'b'), cacheKey('a', 'b'))
  })

  it('fileFingerprint 随内容变化（size/mtime 参与）', async () => {
    const f = join(workDir, 'fp.bin')
    await fsp.writeFile(f, 'one')
    const first = await fileFingerprint(f)
    await fsp.writeFile(f, 'one+two')
    const second = await fileFingerprint(f)
    assert.notEqual(first.hash, second.hash)
    assert.equal(second.sizeBytes, 7)
  })
})

describe('磁盘空间估算', () => {
  it('estimateRecordingBytes 按格式计算（24bit/48k/单声道 ≈ 8.6 MB/分钟）', () => {
    const perMinute = 48000 * 3 * 60
    const bytes = estimateRecordingBytes(1, { sampleRate: 48000, bitDepth: 24, channels: 1 })
    assert.equal(bytes, perMinute + 44)
    assert.ok(bytes > 8_000_000 && bytes < 9_000_000, `实际 ${bytes}`)
    assert.equal(estimateRecordingBytes(0, { sampleRate: 48000, bitDepth: 24, channels: 1 }), 44)
    // 立体声 32bit = 8 字节/帧，是单声道 24bit（3 字节/帧）的 8/3 倍
    const stereo32 = estimateRecordingBytes(1, { sampleRate: 48000, bitDepth: 32, channels: 2 })
    assert.equal(stereo32, 48000 * 2 * 4 * 60 + 44)
  })

  it('checkFreeSpace 返回结构化结果（不支持时明确标 supported=false）', async () => {
    const res = await checkFreeSpace(workDir)
    assert.equal(typeof res.supported, 'boolean')
    if (res.supported) {
      assert.equal(typeof res.availableBytes, 'number')
      assert.ok((res.availableBytes ?? 0) > 0)
    } else {
      assert.equal(res.availableBytes, null)
      assert.ok(typeof res.note === 'string' && res.note.length > 0, '不支持时必须说明原因')
    }
  })

  it('目录不存在时不抛错，返回不支持（避免启动即崩）', async () => {
    const res = await checkFreeSpace(join(workDir, 'not', 'exists', 'yet'))
    assert.equal(typeof res.supported, 'boolean')
  })
})
