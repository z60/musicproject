/**
 * 测试 · TAP 结果解析（scripts/tap-parse.ts）
 * ============================================================================
 * 设计依据：docs/91 §5「自动防线」、docs/30 §6.1
 *
 * 这个文件守护的是**测试运行器自己的数字**，不是某个业务功能：
 *   · `describe`（type: 'suite'）**不得**被算作用例 —— 早期版本把套件也算进去，
 *     用例总数虚高，而且数量随运行在 1333/1347/1351 之间漂移。
 *   · 用例（type: 'test'）必须被精确计数，包含嵌套层级与多套件混排。
 *   · 缺 `type:` 的结果行必须进入 `unclassified`（调用方据此判定「计数不可信」），
 *     绝不能静默当成用例或静默丢弃。
 *   · `# SKIP` / `# TODO` 计入 skipped，不计入 tests。
 *   · 失败用例名要被收集，供 UI 展示。
 *
 * 为什么要有这个测试：这段解析是「1351 / 1141 / 到底多少」的唯一依据。
 * 它错了不会让任何业务断言失败，只会安静地给出一个错数字 —— 必须钉住。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { parseTap } from '../../scripts/tap-parse.ts'

// ---------------------------------------------------------------------------
// 真实形态的 TAP 片段（取自 node:test 的实际输出，缩进与 YAML 块原样保留）
// ---------------------------------------------------------------------------

const SAMPLE = [
  'TAP version 13',
  '# Subtest: 引号族（constants.QUOTE_PAIRS）',
  '    # Subtest: 引号族标签与字符表齐备',
  '    ok 1 - 引号族标签与字符表齐备',
  '      ---',
  '      duration_ms: 1.6393',
  "      type: 'test'",
  '      ...',
  '    1..1',
  'ok 1 - 引号族（constants.QUOTE_PAIRS）',
  '  ---',
  '  duration_ms: 2.9074',
  "  type: 'suite'",
  '  ...',
  '# Subtest: 引号配对（docs/11 §2.2 第 1 步）',
  '    # Subtest: 嵌套引号按最内层优先记录，深度正确',
  '    ok 1 - 嵌套引号按最内层优先记录，深度正确',
  '      ---',
  '      duration_ms: 0.5834',
  "      type: 'test'",
  '      ...',
  '    # Subtest: 三引号族混用也能配对',
  '    ok 2 - 三引号族混用也能配对',
  '      ---',
  '      duration_ms: 0.2462',
  "      type: 'test'",
  '      ...',
  '    not ok 3 - 故意失败的用例',
  '      ---',
  '      duration_ms: 0.1',
  "      type: 'test'",
  '      ...',
  '    ok 4 - 待补的用例 # SKIP 还没实现',
  '      ---',
  '      duration_ms: 0.1',
  "      type: 'test'",
  '      ...',
  '    1..4',
  'ok 2 - 引号配对（docs/11 §2.2 第 1 步）',
  '  ---',
  '  duration_ms: 2.4072',
  "  type: 'suite'",
  '  ...',
  '1..2',
  '# tests 4',
  '# suites 2',
  '# pass 3',
  '# fail 1',
  '# cancelled 0',
  '# skipped 1',
  '# todo 0',
  '',
].join('\n')

describe('TAP 解析：把套件与用例分开', () => {
  it('describe（type: suite）不计入用例数', () => {
    const r = parseTap(SAMPLE)
    // 结果行 7 条 = 5 用例（3 通过 / 1 失败 / 1 SKIP）+ 2 套件
    assert.equal(r.entries.length, 7, '结果行总数应为 7（5 用例 + 2 套件）')
    assert.equal(r.suites, 2, '套件数必须是 2 —— 把它算进用例就是用例总数虚高的根因')
    assert.equal(r.tests, 3, '通过用例应为 3（失败的与 SKIP 的都不算）')
    assert.equal(r.skipped, 1, 'SKIP 计入 skipped，不计入 tests')
    assert.equal(r.failures.length, 1)
    assert.equal(r.failures[0], '故意失败的用例')
    // 关键不变式：套件 + 用例 + 失败 + 跳过 == 全部结果行（一条都不许凭空消失）
    assert.equal(r.suites + r.tests + r.skipped + r.failures.length, r.entries.length)
  })

  it('可分类的结果行不会被放进 unclassified', () => {
    const r = parseTap(SAMPLE)
    assert.deepEqual(r.unclassified, [], '每条结果都有 type 字段，不该有未分类项')
  })

  it('识别汇总行（本环境抓不到，但拿到时必须认出来）', () => {
    const r = parseTap(SAMPLE)
    assert.equal(r.sawSummary, true)
    assert.equal(parseTap(SAMPLE.replace(/# pass \d+/, '# pass X')).sawSummary, false)
  })

  it('嵌套 describe 的多层套件全部排除', () => {
    const nested = [
      'ok 1 - 外层套件',
      '  ---',
      "  type: 'suite'",
      '  ...',
      '    ok 1 - 内层套件',
      '      ---',
      "      type: 'suite'",
      '      ...',
      '        ok 1 - 真正的用例',
      '          ---',
      "          type: 'test'",
      '          ...',
      '',
    ].join('\n')
    const r = parseTap(nested)
    assert.equal(r.suites, 2)
    assert.equal(r.tests, 1)
  })

  it('缺 type 字段的结果行进入 unclassified（宁可报错，不可静默少算）', () => {
    const broken = ['ok 1 - 没有诊断块的结果', 'ok 2 - 正常用例', '  ---', "  type: 'test'", '  ...', ''].join('\n')
    const r = parseTap(broken)
    assert.equal(r.unclassified.length, 1, '缺 type 的那条必须被标出来')
    assert.match(r.unclassified[0]!, /没有诊断块的结果/)
    // 未分类的那条**不计入任何一类**：把它算成「通过」只会给出一个偏大的漂亮数字。
    // 调用方会因为 unclassified 非空而判定整轮失败，所以这里只需保证数字偏保守。
    assert.equal(r.tests, 1, '只有明确 type=test 的那条算用例')
    assert.equal(r.suites, 0)
  })

  it('空文本不崩，且报告 0 条结果', () => {
    const r = parseTap('')
    assert.equal(r.entries.length, 0)
    assert.equal(r.tests, 0)
    assert.equal(r.suites, 0)
    assert.deepEqual(r.failures, [])
  })

  it('CRLF 与无末尾换行都能正确解析', () => {
    const crlf = ['ok 1 - 用例A', '  ---', "  type: 'test'", '  ...', 'ok 2 - 套件B', '  ---', "  type: 'suite'", '  ...'].join('\r\n')
    const r = parseTap(crlf)
    assert.equal(r.tests, 1)
    assert.equal(r.suites, 1)
    assert.equal(r.entries[0]!.name, '用例A')
  })

  it('带 # TODO 的用例计入 skipped 而不是 tests', () => {
    const t = ['ok 1 - 以后再说 # TODO 依赖未到位', '  ---', "  type: 'test'", '  ...', ''].join('\n')
    const r = parseTap(t)
    assert.equal(r.tests, 0)
    assert.equal(r.skipped, 1)
  })
})
