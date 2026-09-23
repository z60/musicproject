/**
 * Novel Studio · 编码嗅探：二进制容器（DOCX / PDF）不做文本编码嗅探
 * ============================================================================
 * 真机现象：导入向导第 1 步选好 DOCX、点「下一步」，第 2 步报「无法确定文本编码」。
 * 根因：DOCX 是 ZIP（头是 PK\x03\x04），字节层面没有「文本编码」这回事；
 * 嗅探把它判成 UTF-16BE、置信度 0.16、needsUserChoice=true，于是把用户挡在门外。
 * 正文其实由 mammoth 以 Unicode 提取，落库按 UTF-8 —— 根本不需要用户选编码。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createBookService } from '../../src/main/features/book/import/book.service.ts'
import type { Logger } from '../../src/main/infra/log/index.ts'

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

function service(root: string) {
  return createBookService({ getDb: () => null, projectRoot: root, log: silentLogger() })
}

describe('book:detectEncoding · 二进制容器', () => {
  it('DOCX 不做文本编码嗅探：直接返回内部 Unicode（utf-8 / confidence 1 / 无需选择）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ns-enc-'))
    try {
      const docx = join(root, 'sample.docx')
      // ZIP 魔数（PK\x03\x04）+ 一些零字节，模拟真实 docx 的头
      writeFileSync(docx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096, 0)]))

      const det = await service(root).detectEncoding(docx)
      assert.equal(det.encoding, 'utf-8')
      assert.equal(det.confidence, 1)
      assert.equal(det.needsUserChoice, false, '不能把 docx 判成「编码不确定」')
      assert.deepEqual(det.candidates, [], 'docx 不需要候选编码表')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('纯文本仍然走真实嗅探（候选表非空）—— 修复没有误伤 txt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ns-enc-'))
    try {
      const txt = join(root, 'novel.txt')
      writeFileSync(txt, '第一章 开始\n这是一个普通的文本文件，用来验证编码嗅探仍然生效。\n', 'utf8')

      const det = await service(root).detectEncoding(txt)
      assert.ok(det.encoding.length > 0)
      assert.ok(det.candidates.length > 0, '文本文件的候选编码表不应为空（说明真的嗅探了）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
