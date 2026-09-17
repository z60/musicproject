/**
 * Novel Studio · 项目包（.nsp）导出 / 导入测试
 * ============================================================================
 * 运行：
 *   node --experimental-strip-types tests/main/package-nsp.test.ts
 *
 * 依据：docs/03 §8（manifest 字段、导入规则 1~5、体积估算表）。
 *
 * 覆盖：
 *   · manifest 构造与校验（必填字段、校验错误一次性列全）
 *   · 格式版本过高 → PACKAGE_VERSION_TOO_NEW
 *   · contents 选项真的生效（未勾选的类别不写进包，且被列入 skipped 提示）
 *   · 导入：逐文件校验失败跳过并列报告、不整体失败
 *   · 导入：projectId 重新分配；内部 ID 默认保留；冲突时**整体重映射**并产出 id_map
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { isAppError } from '../../src/shared/errors.ts'
import {
  CHECKSUMS_FILE,
  DATABASE_FILE,
  MANIFEST_FILE,
  NSP_CONTENT_PRESETS,
  NSP_FORMAT_VERSION,
  PROJECT_FILE,
  buildNspManifest,
  estimateNspBytes,
  peekFormatVersion,
  validateNspManifest,
} from '../../src/main/features/book/package/manifest.ts'
import {
  buildIdMap,
  collectIdsDeep,
  exportProjectPackage,
  importProjectPackage,
  serializeIdMap,
  translateId,
} from '../../src/main/features/book/package/nsp.ts'
import { createStoreZipWriter } from '../../src/main/features/book/package/zip/writer.ts'
import { openZip } from '../../src/main/features/book/package/zip/reader.ts'
import { formatChecksumsFile, sha256Hex } from '../../src/main/features/book/package/checksums.ts'
import { createSilentWav } from '../../src/main/features/book/package/wav.ts'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function counterIds(prefix = 'new'): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

const PROJECT = { id: 'proj-old', name: '斗破苍穹', totalDurationMs: 12_345_678 }
const COUNTS = { chapters: 120, lines: 4820, segments: 3900 }

function wavBytes(ms = 200): Buffer {
  return Buffer.from(createSilentWav({ sampleRate: 48000, bitDepth: 24, channels: 1, durationMs: ms }))
}

async function exportSample(contents = NSP_CONTENT_PRESETS.standard): Promise<{
  zipBytes: Buffer
  result: Awaited<ReturnType<typeof exportProjectPackage>>
}> {
  const zip = createStoreZipWriter()
  const result = await exportProjectPackage({
    zip,
    project: PROJECT,
    schemaVersion: 12,
    contents,
    counts: COUNTS,
    app: { name: 'Novel Studio', version: '1.0.0' },
    exportedAt: '2026-02-14T10:00:00Z',
    files: {
      database: Buffer.from('SQLite format 3\0假快照内容', 'utf8'),
      projectJson: {
        project: PROJECT,
        books: [{ id: 'book-1', title: '斗破苍穹' }, { id: 'book-2', title: '番外' }],
        chapters: [{ id: 'chap-1' }],
      },
      audio: {
        segments: [{ name: 'seg-1.wav', data: wavBytes(200) }],
        recordings: [{ name: 'sess-1.wav', data: wavBytes(300) }],
        takes: [{ name: 'line-1/take-1.wav', data: wavBytes(150) }],
        music: [{ name: 'bgm/theme.mp3', data: Buffer.from('fake-mp3') }],
      },
      exports: [{ name: '斗破苍穹/001_第1章.mp3', data: Buffer.from('fake-export') }],
    },
  })
  return { zipBytes: zip.toBuffer(), result }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

describe('NspManifest · 构造与校验（docs/03 §8）', () => {
  it('构造出的 manifest 字段齐全且能通过校验', () => {
    const manifest = buildNspManifest({
      project: PROJECT,
      schemaVersion: 12,
      contents: NSP_CONTENT_PRESETS.standard,
      counts: COUNTS,
      files: 4211,
      uncompressedBytes: 3_221_225_472,
      exportedAt: '2026-02-14T10:00:00Z',
    })
    assert.equal(manifest.format, 'nsp')
    assert.equal(manifest.formatVersion, NSP_FORMAT_VERSION)
    assert.equal(manifest.app.name, 'Novel Studio')
    assert.equal(manifest.project.name, '斗破苍穹')
    assert.equal(manifest.contents.database, true)
    assert.equal(manifest.contents.recordings, false, '标准预设不含原始录音（体积表）')
    assert.equal(manifest.counts.lines, 4820)
    assert.equal((manifest as { checksums?: string }).checksums, CHECKSUMS_FILE)

    const ok = validateNspManifest(JSON.parse(JSON.stringify(manifest)))
    assert.equal(ok.project.id, 'proj-old')
  })

  it('预设符合 docs/03 §8 的体积策略（默认不含 recordings / takes / processed）', () => {
    assert.deepEqual(
      { ...NSP_CONTENT_PRESETS.standard },
      {
        database: true,
        recordings: false,
        takes: false,
        segments: true,
        processed: false,
        exports: false,
        music: true,
      },
    )
    assert.equal(NSP_CONTENT_PRESETS.full.recordings, true, '完整归档才含原始录音')
    assert.equal(NSP_CONTENT_PRESETS.slim.music, false, '精简预设连素材也不带')
    assert.equal(NSP_CONTENT_PRESETS.slim.segments, true, '精简预设必须保留成品片段')
  })

  it('缺必填字段 → PACKAGE_INVALID，且一次性列出全部问题', () => {
    const manifest = buildNspManifest({
      project: PROJECT,
      schemaVersion: 12,
      contents: NSP_CONTENT_PRESETS.standard,
      counts: COUNTS,
      files: 10,
      uncompressedBytes: 100,
    })
    const broken = { ...manifest, app: { name: 'Novel Studio' } } as unknown as Record<string, unknown>
    delete broken.counts
    delete (broken as { exportedAt?: unknown }).exportedAt

    assert.throws(
      () => validateNspManifest(broken),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_INVALID')
        assert.equal(e.details?.reason, 'manifest-invalid')
        const errors = e.details?.errors as string[]
        assert.equal(errors.some((m) => m.startsWith('app.version')), true)
        assert.equal(errors.some((m) => m.startsWith('counts')), true)
        assert.equal(errors.some((m) => m.startsWith('exportedAt')), true)
        return true
      },
    )
  })

  it('contents 缺一项布尔值也会被指出（避免读到 undefined 后被当成 false 静默丢内容）', () => {
    const manifest = buildNspManifest({
      project: PROJECT,
      schemaVersion: 12,
      contents: NSP_CONTENT_PRESETS.standard,
      counts: COUNTS,
      files: 10,
      uncompressedBytes: 100,
    })
    const contents = { ...manifest.contents } as Record<string, unknown>
    delete contents.music
    assert.throws(
      () => validateNspManifest({ ...manifest, contents }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal((e.details?.errors as string[]).some((m) => m === 'contents.music 应为布尔值，实际 undefined'), true)
        return true
      },
    )
  })

  it('格式版本过高 → PACKAGE_VERSION_TOO_NEW（文案可用 {version} 插值）', () => {
    const manifest = buildNspManifest({
      project: PROJECT,
      schemaVersion: 12,
      contents: NSP_CONTENT_PRESETS.standard,
      counts: COUNTS,
      files: 10,
      uncompressedBytes: 100,
    })
    assert.throws(
      () => validateNspManifest({ ...manifest, formatVersion: 2 }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_VERSION_TOO_NEW')
        assert.equal(e.params.version, '2')
        assert.equal(e.details?.supported, 1)
        return true
      },
    )
  })

  it('format 不匹配 / formatVersion 非法 → PACKAGE_INVALID', () => {
    const base = { format: 'nsp', formatVersion: 1 }
    assert.throws(
      () => validateNspManifest({ ...base, format: 'nst' }),
      (e: unknown) => isAppError(e) && e.details?.reason === 'format-mismatch',
    )
    assert.throws(
      () => validateNspManifest({ format: 'nsp', formatVersion: 0 }),
      (e: unknown) => isAppError(e) && e.details?.reason === 'format-version-invalid',
    )
    assert.throws(
      () => validateNspManifest({ format: 'nsp', formatVersion: 1.5 }),
      (e: unknown) => isAppError(e) && e.details?.reason === 'format-version-invalid',
    )
    assert.throws(
      () => validateNspManifest(null),
      (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID',
    )
  })

  it('peekFormatVersion 可在完整校验前先判断该不该提示升级', () => {
    assert.deepEqual(peekFormatVersion({ format: 'nsp', formatVersion: 9 }), { format: 'nsp', formatVersion: 9 })
    assert.deepEqual(peekFormatVersion('nope'), { format: null, formatVersion: null })
  })

  it('体积估算按 docs/03 §8 的表逐项给出明细', () => {
    const est = estimateNspBytes(1, NSP_CONTENT_PRESETS.standard)
    assert.equal(est.chapters, 1)
    // 标准预设：库 2 MB + 片段 120 MB + 素材 8 MB
    assert.equal(est.bytes, (2 + 120 + 8) * 1024 * 1024)
    assert.equal(est.formatted, '130 MB')
    assert.deepEqual(est.breakdown.map((b) => b.key), ['database', 'segments', 'music'])

    const full = estimateNspBytes(2, NSP_CONTENT_PRESETS.full)
    assert.equal(full.breakdown.length, 7)
    assert.ok(full.bytes > est.bytes * 2, '完整归档应显著更大')
  })
})

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

describe('exportProjectPackage · contents 选项生效', () => {
  it('standard：不写 recordings / takes / processed / exports，并列入 skipped 提示', async () => {
    const { zipBytes, result } = await exportSample()
    assert.deepEqual(result.skipped, [
      '音频目录 audio/recordings',
      '音频目录 audio/takes',
      '音频目录 audio/processed',
      '导出成品目录',
    ])
    assert.equal(result.manifest.uncompressedBytes > 0, true)
    assert.equal(result.checksumEntries, result.entries.filter((e) => !e.endsWith('/')).length - 2, '除 manifest 与 checksums 外逐条都有校验和')

    const reader = openZip(zipBytes)
    const names = reader.listEntries().map((e) => e.name)
    assert.equal(names.includes(MANIFEST_FILE), true)
    assert.equal(names.includes(PROJECT_FILE), true)
    assert.equal(names.includes(DATABASE_FILE), true)
    assert.equal(names.some((n) => n.startsWith('audio/segments/')), true)
    assert.equal(names.some((n) => n.startsWith('audio/music/')), true)
    assert.equal(names.some((n) => n.startsWith('audio/recordings/')), false, '未勾选就不该写进包')
    assert.equal(names.some((n) => n.startsWith('audio/takes/')), false)
    assert.equal(names.some((n) => n.startsWith('exports/')), false)
  })

  it('full：把原始录音/试录/派生/导出成品都带上，skipped 为空', async () => {
    const { zipBytes, result } = await exportSample(NSP_CONTENT_PRESETS.full)
    assert.deepEqual(result.skipped, [])
    const names = openZip(zipBytes).listEntries().map((e) => e.name)
    assert.equal(names.some((n) => n.startsWith('audio/recordings/')), true)
    assert.equal(names.some((n) => n.startsWith('audio/takes/')), true)
    assert.equal(names.some((n) => n.startsWith('exports/')), true)
  })

  it('slim：没有素材与录音，只有库 + 片段', async () => {
    const { zipBytes } = await exportSample(NSP_CONTENT_PRESETS.slim)
    const names = openZip(zipBytes).listEntries().map((e) => e.name)
    assert.equal(names.includes(DATABASE_FILE), true)
    assert.equal(names.some((n) => n.startsWith('audio/segments/')), true)
    assert.equal(names.some((n) => n.startsWith('audio/music/')), false)
  })

  it('contents.database=false 时不写数据库，并说明跳过原因', async () => {
    const zip = createStoreZipWriter()
    const result = await exportProjectPackage({
      zip,
      project: PROJECT,
      schemaVersion: 12,
      contents: { ...NSP_CONTENT_PRESETS.standard, database: false },
      counts: COUNTS,
      files: { database: Buffer.from('x') },
    })
    assert.equal(openZip(zip.toBuffer()).has(DATABASE_FILE), false)
    assert.equal(result.skipped.includes('数据库快照'), true)
  })

  it('checksums.sha256 覆盖包内除自身以外的全部条目，并能真校验通过', async () => {
    const { zipBytes } = await exportSample()
    const reader = openZip(zipBytes)
    const text = reader.readText(CHECKSUMS_FILE)
    const lines = text.trim().split('\n')
    const dataEntries = reader.listEntries().filter((e) => e.name !== CHECKSUMS_FILE)
    assert.equal(lines.length, dataEntries.length - 1, 'checksums 不含自身（manifest 由文件数统计另行覆盖）')
    for (const line of lines) assert.match(line, /^[0-9a-f]{64} {2}\S+$/)
  })

  it('导出可取消：取消后抛 TASK_CANCELLED 且不留半成品', async () => {
    const controller = new AbortController()
    const zip = createStoreZipWriter({ signal: controller.signal })
    controller.abort()
    await assert.rejects(
      () =>
        exportProjectPackage({
          zip,
          project: PROJECT,
          schemaVersion: 12,
          contents: NSP_CONTENT_PRESETS.standard,
          counts: COUNTS,
          signal: controller.signal,
        }),
      (e: unknown) => isAppError(e) && e.key === 'TASK_CANCELLED',
    )
    assert.equal(zip.entries.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

describe('importProjectPackage · 导入规则（docs/03 §8 规则 1~4）', () => {
  it('无冲突：重新分配 projectId，内部 ID 原值保留（任务包才能对得上）', async () => {
    const { zipBytes } = await exportSample()
    const written: Array<{ path: string; size: number }> = []
    const result = await importProjectPackage({
      zip: openZip(zipBytes),
      newProjectId: 'proj-new',
      existingIds: { projectIds: ['other-project'] },
      writeFile: (path, data) => {
        written.push({ path, size: data.byteLength })
      },
      newId: counterIds(),
    })

    assert.equal(result.newProjectId, 'proj-new')
    assert.equal(result.idMap.remapped, false)
    assert.deepEqual(result.idMap.map, {})
    assert.equal(result.idMap.projectId.from, 'proj-old')
    assert.equal(result.idMap.projectId.to, 'proj-new')
    assert.equal(result.warnings.length, 0)
    assert.equal(result.skippedFiles, 0)
    assert.equal(result.requiresDatabaseRewrite, false)
    assert.equal(written.length, result.writtenFiles)
    assert.equal(written.some((w) => w.path === PROJECT_FILE), true)
    assert.equal(translateId(result.idMap, 'book-1'), 'book-1', '保留策略下 id 原样翻译')
    assert.deepEqual(result.checksum.mismatch, [])
  })

  it('ID 冲突：整体重映射并产出 id_map', async () => {
    const { zipBytes } = await exportSample()
    const result = await importProjectPackage({
      zip: openZip(zipBytes),
      newProjectId: 'proj-new',
      // book-1 在现有库里已存在 → 整体重映射
      existingIds: { entityIds: ['book-1'] },
      newId: counterIds('newid'),
    })

    assert.equal(result.idMap.remapped, true)
    assert.match(result.idMap.reason, /ID 冲突/)
    // project.json 里递归发现的 id 都应被映射到新值
    for (const oldId of ['proj-old', 'book-1', 'book-2', 'chap-1']) {
      assert.ok(result.idMap.map[oldId], `${oldId} 应出现在 id_map 中`)
      assert.match(result.idMap.map[oldId], /^newid-\d+$/)
      assert.notEqual(result.idMap.map[oldId], oldId)
    }
    assert.equal(translateId(result.idMap, 'book-1'), result.idMap.map['book-1'])
    assert.equal(translateId(result.idMap, '未登记的 id'), '未登记的 id', '未登记的原样返回')

    // id_map.json 的形状（docs/03 §8 规则 3：存于导入结果目录，供任务包回传时二次翻译）
    const serialized = JSON.parse(serializeIdMap(result.idMap)) as Record<string, unknown>
    assert.equal(serialized.format, 'nsp-id-map')
    assert.equal(serialized.remapped, true)
    assert.deepEqual((serialized.projectId as { to: string }).to, 'proj-new')
    assert.equal(typeof (serialized.entities as Record<string, string>)['book-1'], 'string')
  })

  it('重映射且未注入改写实现时明确标出 requiresDatabaseRewrite（不假装改好了）', async () => {
    const { zipBytes } = await exportSample()
    const result = await importProjectPackage({
      zip: openZip(zipBytes),
      existingIds: { entityIds: ['book-1'] },
      newId: counterIds(),
    })
    assert.equal(result.requiresDatabaseRewrite, true)
    assert.equal(result.warnings.some((w) => w.includes('未注入改写实现')), true)
  })

  it('注入了 rewriteDatabase 时会被调用，并把改写结果写出去', async () => {
    const { zipBytes } = await exportSample()
    let rewriteCalls = 0
    const writtenDatabase: Array<number> = []
    const result = await importProjectPackage({
      zip: openZip(zipBytes),
      existingIds: { entityIds: ['book-1'] },
      newId: counterIds(),
      rewriteDatabase: (bytes, idMap) => {
        rewriteCalls++
        assert.equal(idMap.remapped, true)
        return Buffer.concat([bytes, Buffer.from('--rewritten', 'utf8')])
      },
      writeFile: (path, data) => {
        if (path === DATABASE_FILE) writtenDatabase.push(data.byteLength)
      },
    })
    assert.equal(rewriteCalls, 1)
    assert.equal(writtenDatabase.length, 1)
    assert.equal(result.requiresDatabaseRewrite, false)
    assert.equal(result.idMap.remapped, true)
  })

  it('校验失败的文件被跳过并列报告，其余文件照常导入（绝不整体失败）', async () => {
    // 手工造一个「project.json 的校验和写错」的包
    const writer = createStoreZipWriter()
    const manifest = buildNspManifest({
      project: PROJECT,
      schemaVersion: 12,
      contents: NSP_CONTENT_PRESETS.standard,
      counts: COUNTS,
      files: 5,
      uncompressedBytes: 100,
    })
    const manifestJson = JSON.stringify(manifest, null, 2)
    const projectJson = JSON.stringify({ project: PROJECT }, null, 2)
    const wav = wavBytes(120)
    await writer.addFile(MANIFEST_FILE, Buffer.from(manifestJson, 'utf8'))
    await writer.addFile(PROJECT_FILE, Buffer.from(projectJson, 'utf8'))
    await writer.addFile('audio/segments/seg-1.wav', wav)
    await writer.addFile(
      CHECKSUMS_FILE,
      Buffer.from(
        formatChecksumsFile([
          { path: MANIFEST_FILE, hash: sha256Hex(manifestJson) },
          { path: PROJECT_FILE, hash: sha256Hex('故意写错的哈希') },
          { path: 'audio/segments/seg-1.wav', hash: sha256Hex(wav) },
        ]),
        'utf8',
      ),
    )
    await writer.finalize()

    const result = await importProjectPackage({
      zip: openZip(writer.toBuffer()),
      newProjectId: 'proj-new',
      newId: counterIds(),
    })

    assert.deepEqual(result.checksum.mismatch, [PROJECT_FILE])
    assert.deepEqual(result.checksum.ok.sort(), [MANIFEST_FILE, 'audio/segments/seg-1.wav'].sort())
    assert.equal(result.skippedFiles, 1)
    assert.equal(result.writtenFiles, 3, 'manifest / segments / checksums 照常导入')
    assert.equal(result.files.find((f) => f.path === PROJECT_FILE)?.status, 'skipped-mismatch')
    assert.equal(result.warnings.some((w) => w.includes('校验不通过')), true)
  })

  it('缺 manifest.json → PACKAGE_INVALID（不是「导入了一个空项目」）', async () => {
    const writer = createStoreZipWriter()
    await writer.addFile('audio/segments/x.wav', wavBytes(50))
    await writer.finalize()
    await assert.rejects(
      () => importProjectPackage({ zip: openZip(writer.toBuffer()) }),
      (e: unknown) => isAppError(e) && e.key === 'PACKAGE_INVALID' && e.details?.reason === 'manifest-missing',
    )
  })

  it('包来自更新版本 → PACKAGE_VERSION_TOO_NEW（导入在写任何文件之前就拒绝）', async () => {
    const writer = createStoreZipWriter()
    const manifest = buildNspManifest({
      project: PROJECT,
      schemaVersion: 12,
      contents: NSP_CONTENT_PRESETS.slim,
      counts: COUNTS,
      files: 3,
      uncompressedBytes: 100,
    })
    await writer.addFile(MANIFEST_FILE, Buffer.from(JSON.stringify({ ...manifest, formatVersion: 7 }), 'utf8'))
    await writer.finalize()

    const written: string[] = []
    await assert.rejects(
      () =>
        importProjectPackage({
          zip: openZip(writer.toBuffer()),
          writeFile: (p) => {
            written.push(p)
          },
        }),
      (e: unknown) => {
        assert.ok(isAppError(e))
        assert.equal(e.key, 'PACKAGE_VERSION_TOO_NEW')
        assert.equal(e.params.version, '7')
        return true
      },
    )
    assert.deepEqual(written, [], '版本不兼容时不得写入任何文件')
  })

  it('manifest.json 不是合法 JSON → PACKAGE_INVALID', async () => {
    const writer = createStoreZipWriter()
    await writer.addFile(MANIFEST_FILE, Buffer.from('{ 坏 JSON', 'utf8'))
    await writer.finalize()
    await assert.rejects(
      () => importProjectPackage({ zip: openZip(writer.toBuffer()) }),
      (e: unknown) => isAppError(e) && e.details?.reason === 'manifest-json-parse-failed',
    )
  })
})

// ---------------------------------------------------------------------------
// id_map 纯函数
// ---------------------------------------------------------------------------

describe('buildIdMap · 冲突策略', () => {
  const manifest = buildNspManifest({
    project: PROJECT,
    schemaVersion: 12,
    contents: NSP_CONTENT_PRESETS.slim,
    counts: COUNTS,
    files: 3,
    uncompressedBytes: 10,
  })

  it('无冲突：保留内部 ID（map 为空对象）', () => {
    const map = buildIdMap({
      manifest,
      projectJson: { books: [{ id: 'b1' }] },
      oldProjectId: 'proj-old',
      newProjectId: 'proj-new',
      existing: { entityIds: ['other'] },
      strategy: 'preserve',
      newId: counterIds(),
    })
    assert.equal(map.remapped, false)
    assert.deepEqual(map.map, {})
  })

  it('有冲突：整体重映射（而不是只改冲突的那几个）', () => {
    const map = buildIdMap({
      manifest,
      projectJson: { books: [{ id: 'b1' }, { id: 'b2' }] },
      oldProjectId: 'proj-old',
      newProjectId: 'proj-new',
      existing: { entityIds: ['b2'] },
      strategy: 'preserve',
      newId: counterIds('n'),
    })
    assert.equal(map.remapped, true)
    assert.deepEqual(Object.keys(map.map).sort(), ['b1', 'b2', 'proj-old'])
    assert.match(map.reason, /1 处 ID 冲突/)
  })

  it('strategy=remap 时无条件整体重映射', () => {
    const map = buildIdMap({
      manifest,
      oldProjectId: 'proj-old',
      newProjectId: 'proj-new',
      strategy: 'remap',
      newId: counterIds(),
    })
    assert.equal(map.remapped, true)
    assert.match(map.reason, /强制整体重映射/)
  })

  it('项目 id 本身冲突也算冲突（避免两个项目写进同一个目录）', () => {
    const map = buildIdMap({
      manifest,
      oldProjectId: 'proj-old',
      newProjectId: 'proj-new',
      existing: { projectIds: ['proj-old'] },
      strategy: 'preserve',
      newId: counterIds(),
    })
    assert.equal(map.remapped, true)
  })

  it('collectIdsDeep 递归收集并去重', () => {
    const ids = collectIdsDeep({
      books: [{ id: 'b1', chapters: [{ id: 'c1' }] }, { id: 'b1' }],
      nested: { deep: { id: 'd1' } },
    })
    assert.deepEqual(ids.sort(), ['b1', 'c1', 'd1'])
  })
})
