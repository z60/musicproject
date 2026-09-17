/**
 * 渲染进程纯逻辑测试 · 导出命名模板
 * ============================================================================
 * 覆盖 docs/15 §5.3（命名与目录）与 §5.5（向导需要实时预览）：
 *   · 占位符替换与 `:03` 补零
 *   · 未知占位符**原样保留**（用户能看出写错了，而不是静默留空）
 *   · 非法字符清洗、UTF-8 字节截断到 120、路径穿越拒绝
 *   · 重名自动加 `_2`
 *
 * 运行：node --experimental-strip-types tests/renderer/template.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CHAPTER_TITLE_TEMPLATE,
  DEFAULT_FILE_NAME_TEMPLATE,
  MAX_FILE_NAME_BYTES,
  buildChapterTitle,
  buildFileName,
  buildFileNames,
  emptyPlaceholders,
  parseTemplate,
  renderTemplate,
  sanitizeFileName,
  sanitizeRelativePath,
  truncateUtf8,
  unknownPlaceholders,
  utf8ByteLength,
} from '../../src/renderer/src/shared/lib/template.ts'

const CTX = {
  bookTitle: '斗破苍穹',
  author: '天蚕土豆',
  chapterIndex: 1,
  chapterTitle: '第1章 陨落的天才',
  narrator: 'AI 播讲',
  date: new Date(2024, 4, 1),
  format: 'mp3',
  totalChapters: 120,
}

// ---------------------------------------------------------------------------
// 占位符
// ---------------------------------------------------------------------------

test('renderTemplate：占位符替换与 :03 补零', () => {
  assert.equal(renderTemplate('{bookTitle}/{chapterIndex:03}_{chapterTitle}', CTX), '斗破苍穹/001_第1章 陨落的天才')
  assert.equal(renderTemplate('{chapterIndex} - {chapterIndex:03} - {chapterIndex:3}', { chapterIndex: 7 }), '7 - 007 - 007')
  assert.equal(renderTemplate('{chapterIndex:05}', { chapterIndex: 42 }), '00042')
  assert.equal(renderTemplate('{bookTitle}（{author}）', CTX), '斗破苍穹（天蚕土豆）')
  assert.equal(renderTemplate('{date}', CTX), '2024-05-01')
  assert.equal(renderTemplate('{totalChapters} 章', CTX), '120 章')
  assert.equal(renderTemplate('{format}', CTX), 'mp3')
})

test('renderTemplate：值为空时留空串，不出现 null/undefined 字样', () => {
  assert.equal(renderTemplate('{author}_{bookTitle}', { bookTitle: '无名', author: null }), '_无名')
  assert.equal(renderTemplate('{author}', { author: undefined }), '')
  assert.equal(renderTemplate('{chapterIndex}', { chapterIndex: null }), '')
  // 数字 0 是合法值（第 0 章不存在，但模板逻辑不该把它当空）
  assert.equal(renderTemplate('{chapterIndex}', { chapterIndex: 0 }), '0')
})

test('renderTemplate：未知占位符原样保留', () => {
  assert.equal(renderTemplate('{bookTitle}_{unknownToken}', CTX), '斗破苍穹_{unknownToken}')
  assert.equal(renderTemplate('{foo} {bar:03}', CTX), '{foo} {bar:03}')
  assert.deepEqual(unknownPlaceholders('{bookTitle}_{foo}_{bar}'), ['foo', 'bar'])
  assert.deepEqual(unknownPlaceholders('{bookTitle}_{chapterIndex:03}'), [])
})

test('parseTemplate：拆出 token 位置与格式说明', () => {
  const tokens = parseTemplate('{bookTitle}/{chapterIndex:03}_{chapterTitle}.mp3')
  assert.equal(tokens.length, 3)
  assert.deepEqual(tokens.map(t => t.name), ['bookTitle', 'chapterIndex', 'chapterTitle'])
  assert.equal(tokens[1]!.formatSpec, '03')
  assert.equal(tokens[0]!.known, true)
  assert.equal(tokens[0]!.raw, '{bookTitle}')
  assert.equal(tokens[1]!.start, 12)
})

test('renderTemplate：非法输入不抛异常', () => {
  assert.equal(renderTemplate(null, CTX), '')
  assert.equal(renderTemplate(undefined, CTX), '')
  assert.equal(renderTemplate('', CTX), '')
  assert.equal(renderTemplate(123 as unknown as string, CTX), '')
  assert.doesNotThrow(() => parseTemplate(undefined as unknown as string))
})

test('emptyPlaceholders：提示哪些占位符会留白', () => {
  assert.deepEqual(emptyPlaceholders('{bookTitle}_{author}', { bookTitle: 'x', author: null }), ['author'])
  assert.deepEqual(emptyPlaceholders('{bookTitle}', CTX), [])
})

// ---------------------------------------------------------------------------
// 清洗
// ---------------------------------------------------------------------------

test('sanitizeFileName：去掉非法字符与控制字符', () => {
  assert.equal(sanitizeFileName('第1章: 陨落/天才?.mp3'), '第1章 陨落天才.mp3')
  assert.equal(sanitizeFileName('a<b>c|d"e\\f*g.mp3'), 'abcdefg.mp3')
  assert.equal(sanitizeFileName('带\u0000控制\u001f字符.mp3'), '带控制字符.mp3')
  assert.equal(sanitizeFileName('  前后空格  .mp3'), '前后空格.mp3')
  assert.equal(sanitizeFileName('连续___下划线.mp3'), '连续_下划线.mp3')
  assert.equal(sanitizeFileName('第1章   多个空格.mp3'), '第1章 多个空格.mp3')
})

test('sanitizeFileName：结尾的点与空格必须去掉（Windows 会拒写）', () => {
  assert.equal(sanitizeFileName('章节名...'), '章节名')
  assert.equal(sanitizeFileName('章节名. '), '章节名')
  assert.equal(sanitizeFileName('...'), '')
  assert.equal(sanitizeFileName(''), '')
  assert.equal(sanitizeFileName(null), '')
})

test('sanitizeFileName：Windows 保留名加前缀', () => {
  assert.equal(sanitizeFileName('con'), '_con')
  assert.equal(sanitizeFileName('NUL.mp3'), '_NUL.mp3')
  assert.equal(sanitizeFileName('lpt1'), '_lpt1')
  assert.equal(sanitizeFileName('console'), 'console') // 只是前缀相同，不算保留名
})

test('sanitizeFileName：UTF-8 字节数截断到 120，且不切断多字节字符', () => {
  const longChinese = '陨'.repeat(100) // 300 字节
  const out = sanitizeFileName(longChinese)
  assert.ok(utf8ByteLength(out) <= MAX_FILE_NAME_BYTES, `实际 ${utf8ByteLength(out)} 字节`)
  assert.equal(utf8ByteLength(out), 120) // 40 个汉字
  assert.equal(out.length, 40)

  // 带扩展名时优先保留扩展名
  const withExt = sanitizeFileName(`${'长'.repeat(100)}.mp3`)
  assert.ok(withExt.endsWith('.mp3'))
  assert.ok(utf8ByteLength(withExt) <= MAX_FILE_NAME_BYTES)

  assert.equal(truncateUtf8('abc', 2), 'ab')
  assert.equal(truncateUtf8('中文', 3), '中')
  assert.equal(truncateUtf8('中文', 4), '中')
  assert.equal(truncateUtf8('中文', 6), '中文')
  assert.equal(truncateUtf8('中文', 0), '')
  assert.equal(utf8ByteLength('a中'), 4)
})

test('sanitizeRelativePath：拒绝路径穿越与空段', () => {
  assert.equal(sanitizeRelativePath('斗破苍穹/001_第1章.mp3'), '斗破苍穹/001_第1章.mp3')
  assert.equal(sanitizeRelativePath('斗破苍穹//001_第1章.mp3'), '斗破苍穹/001_第1章.mp3')
  assert.equal(sanitizeRelativePath('./斗破苍穹/001.mp3'), '斗破苍穹/001.mp3')
  assert.equal(sanitizeRelativePath('../../etc/passwd'), 'etc/passwd')
  assert.equal(sanitizeRelativePath('a\\b\\c.mp3'), 'a/b/c.mp3')
  assert.equal(sanitizeRelativePath('..'), '')
  assert.equal(sanitizeRelativePath(null), '')
  assert.equal(sanitizeRelativePath('/绝对路径.mp3'), '绝对路径.mp3')
})

// ---------------------------------------------------------------------------
// 组合
// ---------------------------------------------------------------------------

test('buildFileName：默认模板 + 扩展名', () => {
  assert.equal(DEFAULT_FILE_NAME_TEMPLATE, '{bookTitle}/{chapterIndex:03}_{chapterTitle}')
  const preview = buildFileName(undefined, CTX)
  assert.equal(preview.relativePath, '斗破苍穹/001_第1章 陨落的天才.mp3')
  assert.equal(preview.fileName, '001_第1章 陨落的天才.mp3')
  assert.equal(preview.dir, '斗破苍穹')
  assert.deepEqual(preview.unknownTokens, [])
  assert.equal(preview.renamed, false)
})

test('buildFileName：模板已带扩展名时不重复追加', () => {
  const preview = buildFileName('{chapterIndex:03}_{chapterTitle}.WAV', CTX, 'wav')
  assert.equal(preview.fileName, '001_第1章 陨落的天才.WAV')
})

test('buildFileName：未知占位符会被报出来（向导据此给黄色提示）', () => {
  const preview = buildFileName('{bookTitle}/{unknown:03}_{chapterTitle}', CTX)
  assert.deepEqual(preview.unknownTokens, ['unknown'])
  // 注意：`:` 属于文件名非法字符，清洗后花括号里的内容仍可见（不会被静默丢掉）
  assert.ok(preview.relativePath.includes('{unknown'), `实际：${preview.relativePath}`)
})

test('buildFileName：非法字符在最终路径里被清掉', () => {
  const preview = buildFileName('{bookTitle}/{chapterTitle}', { ...CTX, chapterTitle: '第1章: 陨落/天才?' }, 'mp3')
  // 值里的 `/` 必须被清洗掉，而不是凭空多出一层目录
  assert.equal(preview.relativePath, '斗破苍穹/第1章 陨落天才.mp3')
  assert.equal(preview.dir, '斗破苍穹')
})

test('buildFileNames：重名自动加 _2、_3', () => {
  const previews = buildFileNames(DEFAULT_FILE_NAME_TEMPLATE, [
    { chapterIndex: 1, chapterTitle: '第1章 陨落的天才' },
    { chapterIndex: 1, chapterTitle: '第1章 陨落的天才' },
    { chapterIndex: 1, chapterTitle: '第1章 陨落的天才' },
  ], { bookTitle: '斗破苍穹', format: 'mp3' })

  assert.deepEqual(previews.map(p => p.fileName), [
    '001_第1章 陨落的天才.mp3',
    '001_第1章 陨落的天才_2.mp3',
    '001_第1章 陨落的天才_3.mp3',
  ])
  assert.deepEqual(previews.map(p => p.renamed), [false, true, true])
})

test('buildFileNames：不同目录同名不算冲突', () => {
  const previews = buildFileNames('{volumeTitle}/{chapterIndex:03}_{chapterTitle}', [
    { chapterIndex: 1, chapterTitle: '开端', volumeTitle: '第一卷' },
    { chapterIndex: 1, chapterTitle: '开端', volumeTitle: '第二卷' },
  ], { format: 'mp3' })
  assert.deepEqual(previews.map(p => p.relativePath), [
    '第一卷/001_开端.mp3',
    '第二卷/001_开端.mp3',
  ])
  assert.equal(previews.every(p => !p.renamed), true)
})

test('buildChapterTitle：章标题模板', () => {
  assert.equal(DEFAULT_CHAPTER_TITLE_TEMPLATE, '第{index}章 {title}')
  assert.equal(buildChapterTitle(undefined, { index: 1, title: '陨落的天才' }), '第1章 陨落的天才')
  assert.equal(buildChapterTitle('{index:03} - {title}', { index: 5, title: '药老现身' }), '005 - 药老现身')
  assert.equal(buildChapterTitle('{title}', { index: 3, title: '  多余空格  ' }), '多余空格')
  assert.equal(buildChapterTitle('{index}章', { index: 0, title: '' }), '0章')
})
