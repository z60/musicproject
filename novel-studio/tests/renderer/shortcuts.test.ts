/**
 * 渲染进程纯逻辑测试 · 快捷键解析与匹配
 * ============================================================================
 * 覆盖 docs/12 §9.1 默认键位表与 docs/11 §4.5 待确认队列所需的能力：
 *   · 解析（含 Cmd/Ctrl/Option/Win 别名、序列化回显）
 *   · 匹配（大小写不敏感、修饰键顺序无关、修饰键必须完全一致）
 *   · 冲突检测与非法键位校验
 *   · 任何畸形输入都不抛异常
 *
 * 运行（仓库约定：不用 `node --test`，受限环境会 EPERM）：
 *   node --experimental-strip-types tests/renderer/shortcuts.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RECORDING_SHORTCUTS,
  REVIEW_QUEUE_SHORTCUTS,
  eventToShortcutString,
  findConflicts,
  formatShortcut,
  isEditableTarget,
  matchAny,
  matchEvent,
  normalizeKeyName,
  parseShortcut,
  shortcutEquals,
  validateBindings,
} from '../../src/renderer/src/shared/lib/shortcuts.ts'

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

test('parseShortcut：解析基本组合', () => {
  const s = parseShortcut('Ctrl+Shift+P')
  assert.equal(s.valid, true)
  assert.equal(s.key, 'p')
  assert.equal(s.ctrl, true)
  assert.equal(s.shift, true)
  assert.equal(s.alt, false)
  assert.equal(s.meta, false)
  assert.equal(s.canonical, 'ctrl+shift+p')
  assert.equal(s.display, 'Ctrl+Shift+P')
  assert.equal(s.error, null)
})

test('parseShortcut：Cmd / Command / ⌘ / Win 都是 Meta 别名', () => {
  const expected = parseShortcut('Meta+P').canonical
  for (const alias of ['Cmd+P', 'command+p', '⌘+P', 'Win+P', 'super+p']) {
    const parsed = parseShortcut(alias)
    assert.equal(parsed.valid, true, `${alias} 应可解析`)
    assert.equal(parsed.meta, true, `${alias} 应映射到 meta`)
    assert.equal(parsed.canonical, expected, `${alias} 应与 Meta+P 等价`)
  }
  // Cmd 与 Ctrl 必须是两个不同的键（mac 上不能混为一谈）
  assert.notEqual(parseShortcut('Cmd+P').canonical, parseShortcut('Ctrl+P').canonical)
})

test('parseShortcut：修饰键顺序无关，且重复修饰键不会报错', () => {
  const a = parseShortcut('Ctrl+Shift+P')
  const b = parseShortcut('Shift+Ctrl+P')
  const c = parseShortcut('shift+control+shift+p')
  assert.equal(a.canonical, b.canonical)
  assert.equal(a.canonical, c.canonical)
  assert.ok(shortcutEquals(a, b))
  assert.ok(shortcutEquals('Shift+Ctrl+P', 'Ctrl+Shift+P'))
})

test('parseShortcut：方向键与特殊键的别名', () => {
  assert.equal(parseShortcut('Ctrl+→').key, 'right')
  assert.equal(parseShortcut('Ctrl+ArrowRight').key, 'right')
  assert.equal(parseShortcut('Ctrl+Right').key, 'right')
  assert.equal(parseShortcut('Space').key, 'space')
  assert.equal(parseShortcut(' ').key, 'space')
  assert.equal(parseShortcut('Esc').key, 'escape')
  assert.equal(parseShortcut('Return').key, 'enter')
  assert.equal(parseShortcut('Del').key, 'delete')
  assert.equal(parseShortcut('F13').key, 'f13')
  // 展示串对方向键用箭头（快捷键速查面板可读性更好）
  assert.equal(formatShortcut('Ctrl+Right'), 'Ctrl+→')
})

test('parseShortcut：加号作为主键（Ctrl++ / ++）', () => {
  const s = parseShortcut('Ctrl++')
  assert.equal(s.valid, true)
  assert.equal(s.key, '+')
  assert.equal(s.ctrl, true)
  assert.equal(s.canonical, 'ctrl++')

  const bare = parseShortcut('+')
  assert.equal(bare.valid, true)
  assert.equal(bare.key, '+')
})

test('parseShortcut：非法输入不抛异常，统一返回 valid:false', () => {
  const badInputs: Array<string | null | undefined> = [
    '', '   ', 'Ctrl+', '+Ctrl', 'Ctrl+Foo', 'Ctrl+Shift', 'P+Q',
    'Hyper+P', 'Ctrl+++', undefined, null,
  ]
  for (const input of badInputs) {
    let parsed
    assert.doesNotThrow(() => { parsed = parseShortcut(input) })
    assert.equal(parsed!.valid, false, `「${String(input)}」应判定为非法`)
    assert.equal(parsed!.error !== null, true, `「${String(input)}」应给出错误原因`)
    // 非法键位不能参与匹配
    assert.equal(matchEvent({ key: 'p', ctrlKey: true }, parsed!), false)
  }
  // 非字符串输入（真实场景：设置文件被手改成数字）
  assert.doesNotThrow(() => parseShortcut(123 as unknown as string))
  assert.equal(parseShortcut(123 as unknown as string).valid, false)
})

test('normalizeKeyName：认不出的键名返回 null 而不是原样返回', () => {
  assert.equal(normalizeKeyName('P'), 'p')
  assert.equal(normalizeKeyName('7'), '7')
  assert.equal(normalizeKeyName('VolumeUp'), null)
  assert.equal(normalizeKeyName(''), null)
})

test('空格键：匹配与回写都要认（默认「开始/停止录音」就是 Space）', () => {
  // 回归：' '.trim() === '' 曾让 normalizeKeyName 返回 null，Space 永远匹配不上
  assert.equal(normalizeKeyName(' '), 'space')
  assert.equal(matchEvent({ key: ' ' }, 'Space'), true)
  assert.equal(eventToShortcutString({ key: ' ' }), 'space')
  assert.equal(parseShortcut(eventToShortcutString({ key: ' ' })).valid, true)
  // 修饰键仍然必须完全一致
  assert.equal(matchEvent({ key: ' ', shiftKey: true }, 'Space'), false)
  assert.equal(matchEvent({ key: ' ' }, 'Ctrl+Space'), false)
  // 默认表里空格绑定「开始/停止录音」
  const hit = DEFAULT_RECORDING_SHORTCUTS.filter(b => matchEvent({ key: ' ' }, b.shortcut))
  assert.deepEqual(hit.map(b => b.id), ['record.toggle'])
})

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

test('matchEvent：大小写不敏感', () => {
  const binding = parseShortcut('Ctrl+Shift+P')
  assert.equal(matchEvent({ key: 'P', ctrlKey: true, shiftKey: true }, binding), true)
  assert.equal(matchEvent({ key: 'p', ctrlKey: true, shiftKey: true }, binding), true)
  // 直接传字符串同样可用（组件里常见写法）
  assert.equal(matchEvent({ key: 'P', ctrlKey: true, shiftKey: true }, 'Ctrl+Shift+P'), true)
})

test('matchEvent：修饰键必须完全一致（否则录音页会互相抢键）', () => {
  assert.equal(matchEvent({ key: 'p', shiftKey: true }, 'P'), false)
  assert.equal(matchEvent({ key: 'p' }, 'Shift+P'), false)
  assert.equal(matchEvent({ key: 'p', shiftKey: true }, 'Shift+P'), true)
  assert.equal(matchEvent({ key: 'p', ctrlKey: true }, 'P'), false)
  // Ctrl+Z 不能被 Cmd+Z 命中
  assert.equal(matchEvent({ key: 'z', metaKey: true }, 'Ctrl+Z'), false)
  assert.equal(matchEvent({ key: 'z', metaKey: true }, 'Cmd+Z'), true)
})

test('matchEvent：修饰键顺序无关（用户配置里怎么写都能命中）', () => {
  assert.equal(matchEvent({ key: 'p', ctrlKey: true, shiftKey: true }, 'Shift+Ctrl+P'), true)
  assert.equal(matchEvent({ key: 'p', ctrlKey: true, shiftKey: true, altKey: true }, 'Alt+Ctrl+Shift+P'), true)
})

test('matchEvent：空事件 / 缺字段 / 未知按键都不会误命中', () => {
  assert.equal(matchEvent(null, 'P'), false)
  assert.equal(matchEvent(undefined, 'P'), false)
  assert.equal(matchEvent({ key: '' }, 'P'), false)
  assert.equal(matchEvent({ key: 'VolumeUp' }, 'P'), false)
  assert.equal(matchEvent({ key: 'p' }, 'Ctrl+Foo'), false)
})

test('matchAny：按注册顺序取第一个命中（优先级由调用方决定）', () => {
  const bindings = [
    { id: 'a', shortcut: 'Ctrl+Enter' },
    { id: 'b', shortcut: 'Enter' },
  ]
  assert.equal(matchAny({ key: 'Enter', ctrlKey: true }, bindings)?.id, 'a')
  assert.equal(matchAny({ key: 'Enter' }, bindings)?.id, 'b')
  assert.equal(matchAny({ key: 'x' }, bindings), null)
})

test('eventToShortcutString：回写用于「踏板测试 / 自定义快捷键」', () => {
  assert.equal(eventToShortcutString({ key: 'F13' }), 'f13')
  assert.equal(eventToShortcutString({ key: 'P', ctrlKey: true, shiftKey: true }), 'ctrl+shift+p')
  assert.equal(eventToShortcutString({ key: 'ArrowDown', ctrlKey: true }), 'ctrl+down')
  assert.equal(eventToShortcutString({ key: 'VolumeUp' }), '')
})

// ---------------------------------------------------------------------------
// 冲突检测
// ---------------------------------------------------------------------------

test('findConflicts：同一键位被两个功能占用时能检出', () => {
  const conflicts = findConflicts([
    { id: 'a', shortcut: 'Ctrl+P', label: '打印' },
    { id: 'b', shortcut: 'Ctrl+P', label: '播放' },
    { id: 'c', shortcut: 'P' },
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]!.canonical, 'ctrl+p')
  assert.equal(conflicts[0]!.items.length, 2)
  assert.equal(conflicts[0]!.display, 'Ctrl+P')
})

test('findConflicts：修饰键顺序不同视为同一键位（这是最容易漏的一种冲突）', () => {
  const conflicts = findConflicts([
    { id: 'a', shortcut: 'Ctrl+Shift+P' },
    { id: 'b', shortcut: 'Shift+Ctrl+P' },
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]!.items.length, 2)
})

test('findConflicts：非法键位不参与冲突，重复 id 只算一次', () => {
  assert.deepEqual(findConflicts([
    { id: 'a', shortcut: 'Ctrl+Foo' },
    { id: 'b', shortcut: 'Ctrl+Foo' },
  ]), [])

  const same = findConflicts([
    { id: 'a', shortcut: 'P' },
    { id: 'a', shortcut: 'P' },
  ])
  assert.deepEqual(same, [])
})

test('默认键位表自身无冲突，且全部可解析', () => {
  assert.deepEqual(validateBindings(DEFAULT_RECORDING_SHORTCUTS), [])
  assert.deepEqual(validateBindings(REVIEW_QUEUE_SHORTCUTS), [])
  assert.deepEqual(findConflicts(DEFAULT_RECORDING_SHORTCUTS), [])
  assert.deepEqual(findConflicts(REVIEW_QUEUE_SHORTCUTS), [])
  // 录音页必须有「开始/停止」与「下一行」（docs/12 §9.1）
  assert.ok(DEFAULT_RECORDING_SHORTCUTS.some(b => b.id === 'record.toggle'))
  assert.ok(DEFAULT_RECORDING_SHORTCUTS.some(b => b.shortcut === 'Ctrl+M'))
})

test('validateBindings：列出非法键位与原因', () => {
  const problems = validateBindings([
    { id: 'ok', shortcut: 'Ctrl+S' },
    { id: 'bad', shortcut: 'Ctrl+这不是键' },
  ])
  assert.equal(problems.length, 1)
  assert.equal(problems[0]!.id, 'bad')
  assert.match(problems[0]!.error, /无法识别/)
})

// ---------------------------------------------------------------------------
// 焦点判断
// ---------------------------------------------------------------------------

test('isEditableTarget：输入框里不抢键，勾选框不拦截', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false)
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false)
  assert.equal(isEditableTarget(null), false)
})
