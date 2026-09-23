/**
 * Novel Studio · 书籍导入：DOCX 解析依赖（mammoth）已注入
 * ============================================================================
 * 真机现象：选了 docx 点下一步，解析失败「文档结构异常」。
 * 根因：importDeps() **从来没有注入 docxConverter**（pdf/html/sniffer/fetch 同样漏了），
 * 于是 parseDocx 直接抛 DOCX_CORRUPT。之前只导入过 txt，所以一直没暴露。
 *
 * 这组测试自造一个最小合法 docx（store zip writer + 三份 OOXML 部件），
 * 不依赖仓库里的大样本，确保 DOCX 解析链路真的通。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createBookService, loadDocxConverter } from '../../src/main/features/book/import/book.service.ts'
import { createStoreZipWriter } from '../../src/main/features/book/package/zip/writer.ts'
import { loadMigrations } from '../../src/main/infra/db/migrations/index.ts'
import { migrate } from '../../src/main/infra/db/migrate.ts'
import type { DbLike } from '../../src/main/infra/db/types.ts'
import type { Logger } from '../../src/main/infra/log/index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function silentLogger(): Logger {
  const noop = (): void => undefined
  const stub = {
    level: 'info' as const,
    setLevel: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    errorFields: noop,
    child: () => stub,
    write: noop,
    addSink: noop,
    setEntryListener: noop,
    recent: () => [],
  }
  return stub as unknown as Logger
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

/** 长旁白：>200 字，避免分章器把过短章节并入上一章 */
const LONG = '这是一段足够长的旁白文本，用来确保分章器不会把它并入上一章。'.repeat(8)

const DOCUMENT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:r><w:t>第1章 开始</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>' + LONG + '</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>【杨浩-嬉小天】“我来了。”</w:t></w:r></w:p>' +
  '</w:body></w:document>'

async function writeMinimalDocx(path: string): Promise<void> {
  const zip = createStoreZipWriter()
  await zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8'))
  await zip.addFile('_rels/.rels', Buffer.from(RELS, 'utf8'))
  await zip.addFile('word/document.xml', Buffer.from(DOCUMENT, 'utf8'))
  await zip.finalize()
  writeFileSync(path, zip.toBuffer())
}

describe('书籍导入 · DOCX', () => {
  it('mammoth 已注入：previewSplit 能真正解析 docx', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ns-docx-'))
    try {
      const db = new DatabaseSync(':memory:')
      await migrate(db as unknown as DbLike, loadMigrations(), { log: () => {} })
      const docx = join(root, 'sample.docx')
      await writeMinimalDocx(docx)

      const service = createBookService({
        getDb: () => db as unknown as DbLike,
        projectRoot: root,
        log: silentLogger(),
      })
      const preview = await service.previewSplit({ filePath: docx })

      assert.ok(preview.drafts.length >= 1, '应切出至少一章（未注入 mammoth 时会抛 DOCX_CORRUPT）')
      const joined = preview.drafts.map((d) => d.rawText).join('\n')
      assert.ok(joined.includes('这是一段足够长的旁白'), '正文段落应被解析出来')
      assert.ok(joined.includes('【杨浩-嬉小天】'), '画本标记应原样保留')
      assert.equal(preview.encoding, 'utf-8', 'DOCX 应标记为内部 Unicode（utf-8）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loadDocxConverter 能加载 mammoth 且形态正确', async () => {
    const converter = await loadDocxConverter()
    assert.ok(converter, 'mammoth 应可加载（依赖里已声明）')
    assert.equal(typeof converter.convertToHtml, 'function')
  })

  it('importDeps 真的把可选解析依赖注入进去了（源码级防回归）', () => {
    const src = readFileSync(join(ROOT, 'src/main/features/book/import/book.service.ts'), 'utf8')
    assert.match(src, /loadDocxConverter\(\)/)
    assert.match(src, /loadPdfExtractor\(\)/)
    assert.match(src, /loadHtmlExtractor\(\)/)
    assert.match(src, /docxConverter \? \{ docxConverter \}/)
    assert.match(src, /pdfExtractor \? \{ pdfExtractor \}/)
    assert.match(src, /htmlExtractor \? \{ htmlExtractor \}/)
    assert.match(src, /sniffer \? \{ sniffer \}/)
    assert.match(src, /fetchImpl \? \{ fetchImpl \}/)
  })
})
