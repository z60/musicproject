/**
 * Novel Studio · 画本质检测试
 * ============================================================================
 * 设计文档：docs/11 §5（12 种 issue 与「一键修复仅限安全项」）、§2.1（too_long）、
 *           §2.2（引号不配对）、§2.3（no_pause）、docs/06 §5.5（置信度与人工确认）
 *
 * 运行：
 *   node --experimental-strip-types tests/shared/canvas-quality.test.ts
 *
 * 守护点：
 *   · 12 种 issue **每一种**都能被构造出来并被检出（防止漏实现/漏判定）
 *   · 多音字提示命中，且「有消歧词」时能给出具体读音建议
 *   · autoFixIssues 只改安全项（no_pause / missing_pronunciation），且**不修改入参**
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  SAFE_FIX_KINDS,
  analyzePolyphones,
  autoFixIssues,
  findPolyphoneHints,
  isQuoteUnbalanced,
  qualityCheck,
  suggestPronunciation,
  type QualityCheckLine,
  type QualitySegmentRef,
} from '../../src/shared/canvas/quality.ts'
import { isAppError } from '../../src/shared/errors.ts'
import { createCharacter } from '../../src/shared/canvas/character.ts'
import type { Character, QualityIssue, QualityIssueKind } from '../../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeLine(over: Partial<QualityCheckLine> & Pick<QualityCheckLine, 'id' | 'seq'>): QualityCheckLine {
  return {
    text: '他说了一句话。',
    sourceText: null,
    kind: 'narration',
    speakerType: 'narration',
    characterId: null,
    state: 'draft',
    pauseAfterMs: 500,
    confidence: null,
    decidedBy: 'rule',
    flags: [],
    pronunciation: null,
    ...over,
  }
}

function makeCharacter(over: Partial<Character> & Pick<Character, 'id' | 'name'>): Character {
  return createCharacter({ id: over.id, bookId: 'book-1', name: over.name, ...(over as object) })
}

const XIAO = makeCharacter({ id: 'c-萧炎', name: '萧炎' })
const YAO = makeCharacter({ id: 'c-药老', name: '药老' })
const UNUSED = makeCharacter({ id: 'c-纳兰', name: '纳兰嫣然' })

// ---------------------------------------------------------------------------
// 多音字
// ---------------------------------------------------------------------------

describe('多音字提示（docs/11 §5）', () => {
  it('findPolyphoneHints 命中多音字并给出可读提示', () => {
    const hints = findPolyphoneHints('他重新走上这条街。')
    assert.ok(hints.some((h) => h.startsWith('重(')), JSON.stringify(hints))
    assert.ok(hints.some((h) => h.includes('重要 / 重复')))
  })

  it('excludeCommon 时跳过地/了/得/着/为这类高频功能字', () => {
    const all = findPolyphoneHints('他慢慢地走了。')
    assert.ok(all.some((h) => h.startsWith('地(')))
    assert.ok(all.some((h) => h.startsWith('了(')))
    const filtered = findPolyphoneHints('他慢慢地走了。', { excludeCommon: true })
    assert.equal(filtered.length, 0)
  })

  it('上下文有消歧词时给出具体读音建议（只建议，不改文本）', () => {
    const hits = analyzePolyphones('他去银行取钱。', { excludeCommon: true })
    const hang = hits.find((h) => h.char === '行')
    assert.ok(hang)
    assert.equal(hang!.suggestedReading, 'háng')
    assert.equal(hang!.disambiguator, '银行')
    assert.equal(suggestPronunciation('他去银行取钱。'), '行：háng')

    const xing = analyzePolyphones('他在山间行走。', { excludeCommon: true }).find((h) => h.char === '行')!
    assert.equal(xing.suggestedReading, 'xíng')
  })

  it('空文本返回空数组（不抛错）', () => {
    assert.deepEqual(findPolyphoneHints(''), [])
    assert.equal(suggestPronunciation(''), null)
  })
})

// ---------------------------------------------------------------------------
// 12 种 issue
// ---------------------------------------------------------------------------

describe('画本质检：12 种 issue 每种都能被检出', () => {
  /** 一份「把所有问题都造出来」的画本 */
  const lines: QualityCheckLine[] = [
    // 0: 空文本
    makeLine({ id: 'L0', seq: 0, text: '   ', kind: 'narration' }),
    // 1: 超长（> maxLineChars=12）+ 多音字（差）
    makeLine({
      id: 'L1', seq: 1, kind: 'dialogue', speakerType: 'character', characterId: XIAO.id,
      text: '他抬头看着天边那轮明月，心中的念头一个接一个地翻涌起来，差一点就说出了口。', pauseAfterMs: 0,
    }),
    // 2: 与上一行同角色且 pauseAfterMs=0（no_pause 报在第 1 行）+ duplicate_text 报在本行
    makeLine({
      id: 'L2', seq: 2, kind: 'dialogue', speakerType: 'character', characterId: XIAO.id,
      text: '他抬头看着天边那轮明月，心中的念头一个接一个地翻涌起来，差一点就说出了口。', pauseAfterMs: 500,
    }),
    // 3: 未指派说话人的台词 + 引号不配对（flags）
    makeLine({
      id: 'L3', seq: 3, kind: 'dialogue', speakerType: 'narration', characterId: null,
      text: '我还没有说完。', sourceText: '“我还没有说完。', flags: ['quote_unmatched'],
    }),
    // 4~6: 连续三行旁白（narration_run，maxNarrationRun=3）
    makeLine({ id: 'L4', seq: 4, kind: 'narration', text: '风停了。' }),
    makeLine({ id: 'L5', seq: 5, kind: 'narration', text: '雨也停了。' }),
    makeLine({ id: 'L6', seq: 6, kind: 'narration', text: '天边透出光。' }),
    // 7: 已录但片段文件缺失
    makeLine({
      id: 'L7', seq: 7, kind: 'dialogue', speakerType: 'character', characterId: YAO.id,
      text: '丹药的药材还差三味。', state: 'recorded', pauseAfterMs: 200,
    }),
    // 8~10: 连续三行同一角色对白（dialogue_run，maxDialogueRun=3）+ 置信度低（suspicious_speaker）
    makeLine({
      id: 'L8', seq: 8, kind: 'dialogue', speakerType: 'character', characterId: YAO.id,
      text: '灵魂之火快熄了。', confidence: 0.3, decidedBy: 'vector', pauseAfterMs: 100,
    }),
    makeLine({
      id: 'L9', seq: 9, kind: 'dialogue', speakerType: 'character', characterId: YAO.id,
      text: '再撑一撑就好。', confidence: 0.8, decidedBy: 'vector', pauseAfterMs: 100,
    }),
    makeLine({
      id: 'L10', seq: 10, kind: 'dialogue', speakerType: 'character', characterId: YAO.id,
      text: '我一定救你。', confidence: 0.8, decidedBy: 'vector', pauseAfterMs: 100,
    }),
    // 11: 引用了不存在的角色（suspicious_speaker 的另一种来源）
    makeLine({
      id: 'L11', seq: 11, kind: 'dialogue', speakerType: 'character', characterId: 'c-不存在',
      text: '我是谁？', confidence: 0.9, decidedBy: 'vector', pauseAfterMs: 300,
    }),
  ]

  const segments: QualitySegmentRef[] = [
    { lineId: 'L7', filePath: 'takes/L7.wav', exists: false },
    { lineId: 'L8', filePath: 'takes/L8.wav', exists: true },
  ]

  const issues = qualityCheck(lines, [XIAO, YAO, UNUSED], segments, {
    maxLineChars: 12,
    maxNarrationRun: 3,
    maxDialogueRun: 3,
    suspiciousConfidence: 0.5,
  })
  const kinds = new Set(issues.map((i) => i.kind))

  const EXPECTED: QualityIssueKind[] = [
    'empty_text', 'too_long', 'unassigned', 'quote_unmatched', 'no_character_ref',
    'narration_run', 'dialogue_run', 'no_pause', 'suspicious_speaker',
    'missing_pronunciation', 'recorded_missing', 'duplicate_text',
  ]

  it('12 种 issue 全部出现（一个不少）', () => {
    const missing = EXPECTED.filter((k) => !kinds.has(k))
    assert.deepEqual(missing, [], `未检出的 issue：${missing.join(', ')}（实际：${[...kinds].join(', ')}）`)
  })

  it('每种 issue 的定位与文案可用（lineId/seq/message 都填好）', () => {
    for (const issue of issues) {
      assert.ok(issue.message.length > 0, `${issue.kind} 的 message 不能为空`)
      if (issue.lineId != null) {
        assert.ok(lines.some((l) => l.id === issue.lineId), `${issue.kind} 的 lineId 必须存在于画本`)
        assert.ok(issue.seq != null)
      }
    }
    // no_character_ref 是「角色级」问题，不挂行
    const orphan = issues.find((i) => i.kind === 'no_character_ref')
    assert.equal(orphan?.lineId, null)
    assert.match(orphan!.message, /纳兰嫣然/)
  })

  it('empty_text / too_long / duplicate_text / quote_unmatched 定位到正确行', () => {
    const at = (k: QualityIssueKind): Array<number | null> =>
      issues.filter((i) => i.kind === k).map((i) => i.seq).sort((a, b) => (a ?? 0) - (b ?? 0))
    assert.deepEqual(at('empty_text'), [0])
    assert.deepEqual(at('too_long'), [1, 2])
    assert.deepEqual(at('duplicate_text'), [2])
    assert.deepEqual(at('quote_unmatched'), [3])
    assert.deepEqual(at('unassigned'), [3])
  })

  it('no_pause 只报「相邻同角色且 pause=0」的前一行', () => {
    const noPause = issues.filter((i) => i.kind === 'no_pause')
    assert.deepEqual(noPause.map((i) => i.seq), [1])
    assert.equal(noPause[0].autoFixable, true)
  })

  it('narration_run / dialogue_run 每个 run 只报一次（报在首行）', () => {
    assert.deepEqual(issues.filter((i) => i.kind === 'narration_run').map((i) => i.seq), [4])
    // L7~L10 是同一角色（药老）的连续 4 行对白 → 报在首行 seq=7
    assert.deepEqual(issues.filter((i) => i.kind === 'dialogue_run').map((i) => i.seq), [7])
    const msg = issues.find((i) => i.kind === 'dialogue_run')!.message
    assert.match(msg, /连续 4 行/)
  })

  it('recorded_missing 依据注入的 exists 判定', () => {
    assert.deepEqual(issues.filter((i) => i.kind === 'recorded_missing').map((i) => i.seq), [7])
  })

  it('suspicious_speaker 命中「低置信」与「引用不存在的角色」两种来源，人工确认的行不告警', () => {
    const seqs = issues.filter((i) => i.kind === 'suspicious_speaker').map((i) => i.seq).sort((a, b) => (a ?? 0) - (b ?? 0))
    assert.deepEqual(seqs, [8, 11])
    const humanLines = lines.map((l) => (l.id === 'L8' ? { ...l, decidedBy: 'human' as const } : l))
    const again = qualityCheck(humanLines, [XIAO, YAO, UNUSED], segments, { maxLineChars: 12, suspiciousConfidence: 0.5 })
    assert.ok(!again.some((i) => i.kind === 'suspicious_speaker' && i.seq === 8), '人工确认过的行不该再报可疑')
  })

  it('missing_pronunciation 只在没有发音提示时报警，补上提示就消失', () => {
    const withPronunciation = lines.map((l) =>
      l.id === 'L1' || l.id === 'L2' ? { ...l, pronunciation: '差：chà' } : l,
    )
    const again = qualityCheck(withPronunciation, [XIAO, YAO, UNUSED], segments, { maxLineChars: 12 })
    assert.ok(!again.some((i) => i.kind === 'missing_pronunciation' && (i.seq === 1 || i.seq === 2)))
  })

  it('质检不改动入参（纯函数）', () => {
    const snapshot = JSON.stringify(lines)
    qualityCheck(lines, [XIAO, YAO, UNUSED], segments, { maxLineChars: 12 })
    assert.equal(JSON.stringify(lines), snapshot)
  })

  it('入参不是数组时抛 AppError(INVALID_PAYLOAD)', () => {
    assert.throws(
      () => qualityCheck(null as unknown as QualityCheckLine[], [], []),
      (e: unknown) => isAppError(e) && e.key === 'INVALID_PAYLOAD',
    )
  })
})

// ---------------------------------------------------------------------------
// 边界：空画本 / 只有一行 / 无 segments
// ---------------------------------------------------------------------------

describe('质检边界', () => {
  it('空画本 + 空角色表 → 无问题', () => {
    assert.deepEqual(qualityCheck([], [], []), [])
  })

  it('单行画本不会误报 run / duplicate / no_pause', () => {
    const one = [makeLine({ id: 'L0', seq: 0 })]
    const issues = qualityCheck(one, [], [])
    assert.equal(issues.length, 0, JSON.stringify(issues))
  })

  it('不传 segments 时不报 recorded_missing（调用方未提供文件信息）', () => {
    const line = makeLine({ id: 'L0', seq: 0, state: 'recorded' })
    const issues = qualityCheck([line], [], [])
    assert.ok(!issues.some((i) => i.kind === 'recorded_missing'))
  })

  it('isQuoteUnbalanced 能识别各种不配对', () => {
    assert.equal(isQuoteUnbalanced('“你好。”'), false)
    assert.equal(isQuoteUnbalanced('“你好。'), true)
    assert.equal(isQuoteUnbalanced('你好。”'), true)
    assert.equal(isQuoteUnbalanced('他没有引号。'), false)
  })
})

// ---------------------------------------------------------------------------
// 一键修复
// ---------------------------------------------------------------------------

describe('一键修复：只动安全项，且不修改入参', () => {
  const lines: QualityCheckLine[] = [
    makeLine({
      id: 'L0', seq: 0, kind: 'dialogue', speakerType: 'character', characterId: XIAO.id,
      text: '丹药的药材还差三味。', pauseAfterMs: 0,
    }),
    makeLine({
      id: 'L1', seq: 1, kind: 'dialogue', speakerType: 'character', characterId: XIAO.id,
      text: '他也想不出别的办法。', pauseAfterMs: 500,
    }),
    makeLine({ id: 'L2', seq: 2, text: '', kind: 'narration' }),
    makeLine({ id: 'L3', seq: 3, kind: 'dialogue', speakerType: 'narration', text: '我没说完。' }),
  ]

  const issues: QualityIssue[] = qualityCheck(lines, [], [], { maxLineChars: 120 })

  it('只对 no_pause / missing_pronunciation 生成补丁', () => {
    const result = autoFixIssues(lines, issues, { defaultPauseAfterMs: 500 })
    const patchedKinds = new Set(result.patches.map((p) => p.issueKind))
    for (const k of patchedKinds) assert.ok(SAFE_FIX_KINDS.includes(k), `${k} 不是安全项`)
    assert.ok(patchedKinds.has('no_pause'))
    assert.ok(patchedKinds.has('missing_pronunciation'))
    assert.ok(!patchedKinds.has('empty_text'))
    assert.ok(!patchedKinds.has('unassigned'))
    // 跳过计数必须回报（UI 要告诉用户「哪些没自动改」）
    assert.ok(result.skipped > 0)
    assert.ok(result.skippedKinds.includes('empty_text'))
  })

  it('no_pause 的补丁把停顿补成默认值', () => {
    const result = autoFixIssues(lines, issues, { defaultPauseAfterMs: 620 })
    const p = result.patches.find((x) => x.issueKind === 'no_pause')!
    assert.equal(p.lineId, 'L0')
    assert.equal(p.patch.pauseAfterMs, 620)
    assert.ok(p.note.includes('620'))
  })

  it('missing_pronunciation 的补丁写入发音建议（不改 text）', () => {
    const result = autoFixIssues(lines, issues)
    const p = result.patches.find((x) => x.issueKind === 'missing_pronunciation')!
    assert.equal(p.lineId, 'L0')
    assert.equal(p.patch.pronunciation, suggestPronunciation(lines[0].text))
    assert.ok(p.patch.pronunciation!.includes('差：'), p.patch.pronunciation!)
    assert.equal('text' in p.patch, false, '安全修复绝不能改文本')
  })

  it('不修改入参（前后快照一致）', () => {
    const before = JSON.stringify(lines)
    const beforeIssues = JSON.stringify(issues)
    autoFixIssues(lines, issues)
    assert.equal(JSON.stringify(lines), before)
    assert.equal(JSON.stringify(issues), beforeIssues)
  })

  it('allowedKinds 可收窄（比如只允许补停顿）', () => {
    const result = autoFixIssues(lines, issues, { allowedKinds: ['no_pause'] })
    assert.deepEqual([...new Set(result.patches.map((p) => p.issueKind))], ['no_pause'])
    assert.ok(result.skippedKinds.includes('missing_pronunciation'))
  })

  it('lineId 找不到对应行时计入 skipped，不抛错', () => {
    const orphan: QualityIssue[] = [
      { kind: 'no_pause', lineId: 'missing-line', seq: 99, message: 'x', autoFixable: true },
    ]
    const result = autoFixIssues(lines, orphan)
    assert.equal(result.fixed, 0)
    assert.equal(result.skipped, 1)
  })
})
