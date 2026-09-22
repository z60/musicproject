/**
 * 测试 · 渲染进程日志落地（主进程侧）
 * ============================================================================
 * 事故（docs/91 §5.2.41）：渲染进程的日志从来没有进过日志文件。
 * `src/renderer/src/app/main.ts` 写着「console.* → webContents 的 console-message
 * → 主进程 electron-log 落盘」，但主进程**从未注册 `console-message`**。
 * 取证代价：日志里有 738 条 `record.frameGap {claimed:2304, written:0}`，
 * 却没有任何一条渲染侧的 `recording.attachPort.failed`。
 *
 * 这里补两件事：
 *   1. 参数归一（Electron ≤31 的位置参数 / ≥32 的 details 对象）与结构化解析；
 *   2. `console-message` 真的被注册、真的落盘、真的不会把异常抛回 Electron。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  RENDERER_CONSOLE_MAX_CHARS,
  RENDERER_LOG_PREFIX,
  createWindowManager,
  parseConsoleMessageArgs,
  parseRendererLogPayload,
} from '../../src/main/bootstrap/window-manager.ts'
import type { ElectronLike } from '../../src/main/infra/electron/types.ts'

// ---------------------------------------------------------------------------
// 极简假 Electron（只实现 window-manager 用到的成员）
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

function makeEmitter() {
  const listeners = new Map<string, Listener[]>()
  return {
    on(event: string, fn: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
    },
    count(event: string) {
      return (listeners.get(event) ?? []).length
    },
  }
}

interface FakeWindow {
  webContents: { id: number; send: () => void; isDestroyed: () => boolean; on: (event: string, fn: Listener) => void }
  emitted: ReturnType<typeof makeEmitter>
  isDestroyed: () => boolean
  getBounds: () => { x: number; y: number; width: number; height: number }
  loadURL: () => Promise<void>
  on: (event: string, fn: Listener) => void
}

function makeWindow(): FakeWindow {
  const contentsEvents = makeEmitter()
  const winEvents = makeEmitter()
  const win: FakeWindow = {
    webContents: {
      id: 1,
      send: () => undefined,
      isDestroyed: () => false,
      on: (event, fn) => contentsEvents.on(event, fn),
    },
    emitted: contentsEvents,
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    loadURL: async () => undefined,
    on: (event, fn) => winEvents.on(event, fn),
  }
  return win
}

function makeElectron(): { electron: ElectronLike; windows: FakeWindow[]; appEvents: ReturnType<typeof makeEmitter> } {
  const windows: FakeWindow[] = []
  const appEvents = makeEmitter()
  function BrowserWindowCtor(this: unknown, _options: unknown): FakeWindow {
    const win = makeWindow()
    windows.push(win)
    // 真实 Electron：创建 BrowserWindow 时会先发 `web-contents-created`，
    // 应用级硬化就是挂在这个事件上的 —— 于是主窗口会被硬化**两次**
    // （应用级一次 + createMainWindow 显式一次）。这里如实复现，
    // 否则"重复注册"这个缺陷在测试里永远看不见（真机日志里每条渲染日志落盘两次）。
    appEvents.emit('web-contents-created', {}, win.webContents)
    return win
  }
  const electron = {
    app: { on: appEvents.on, whenReady: async () => undefined, getPath: () => process.cwd(), quit: () => undefined },
    BrowserWindow: Object.assign(BrowserWindowCtor, { getAllWindows: () => windows }),
    shell: { openExternal: () => undefined },
  } as unknown as ElectronLike
  return { electron, windows, appEvents }
}

interface LogCall {
  level: 'info' | 'warn' | 'error'
  event: string
  fields: Record<string, unknown>
}

function makeLogger(calls: LogCall[], control: { throwing: boolean } = { throwing: false }) {
  const push = (level: LogCall['level']) => (event: string, fields: Record<string, unknown>) => {
    if (control.throwing) throw new Error('logger down')
    calls.push({ level, event, fields })
  }
  return { info: push('info'), warn: push('warn'), error: push('error') }
}

async function openWindow() {
  const calls: LogCall[] = []
  /** 可变的抛错开关：窗口**创建本身**也要写日志（window.create.done），
   *  所以只能在创建完成之后再让日志器开始抛错 */
  const control = { throwing: false }
  const { electron, windows, appEvents } = makeElectron()
  const manager = createWindowManager({
    electron,
    preloadPath: join(process.cwd(), 'out/preload/index.cjs'),
    appUrl: 'file:///app/index.html',
    log: makeLogger(calls, control),
  })
  await manager.createMainWindow()
  const win = windows[0]!
  // 建窗口自己会写 window.create.done —— 清掉，断言只看 console-message 的落盘
  calls.length = 0
  return { win, windows, appEvents, manager, calls, control }
}

/** Electron ≤31：`(event, level, message, line, sourceId)` */
function emitConsole(win: FakeWindow, level: number, message: string, line = 1, source = 'file:///app/assets/index.js') {
  win.emitted.emit('console-message', {}, level, message, line, source)
}

// ---------------------------------------------------------------------------
// 参数归一
// ---------------------------------------------------------------------------

describe('console-message 参数归一', () => {
  it('Electron 31 的位置参数形态', () => {
    const parsed = parseConsoleMessageArgs([{}, 3, 'boom', 42, 'file:///a.js'])
    assert.deepEqual(parsed, { level: 3, message: 'boom', line: 42, sourceId: 'file:///a.js' })
  })

  it('Electron 32+ 的 details 对象形态', () => {
    const parsed = parseConsoleMessageArgs([{}, { level: 'warning', message: 'careful', lineNumber: 7, sourceId: 'file:///b.js' }])
    assert.deepEqual(parsed, { level: 2, message: 'careful', line: 7, sourceId: 'file:///b.js' })
  })

  it('未知/缺失的级别退到 info，且级别被夹在 0..3', () => {
    assert.equal(parseConsoleMessageArgs([{}, undefined, 'x']).level, 1)
    assert.equal(parseConsoleMessageArgs([{}, 99, 'x']).level, 3)
    assert.equal(parseConsoleMessageArgs([{}, -5, 'x']).level, 0)
    assert.equal(parseConsoleMessageArgs([{}, 'nonsense', 'x']).level, 1)
  })

  it('缺失的 message 变成空串（调用方据此丢弃）', () => {
    assert.equal(parseConsoleMessageArgs([{}]).message, '')
  })
})

describe('渲染日志结构化解析', () => {
  it('识别 [ns] {json}', () => {
    const parsed = parseRendererLogPayload(`${RENDERER_LOG_PREFIX}{"event":"a.b","code":"E1"}`)
    assert.deepEqual(parsed, { event: 'a.b', code: 'E1' })
  })

  it('没前缀 / 不是对象 / 被截断的 JSON 都返回 null（走纯文本落盘）', () => {
    assert.equal(parseRendererLogPayload('普通输出'), null)
    assert.equal(parseRendererLogPayload(`${RENDERER_LOG_PREFIX}普通输出`), null)
    assert.equal(parseRendererLogPayload(`${RENDERER_LOG_PREFIX}[1,2]`), null)
    assert.equal(parseRendererLogPayload(`${RENDERER_LOG_PREFIX}{"event":"a.b"`), null)
    assert.equal(parseRendererLogPayload(`${RENDERER_LOG_PREFIX}null`), null)
  })
})

// ---------------------------------------------------------------------------
// 注册与落盘
// ---------------------------------------------------------------------------

describe('console-message → 主进程日志', () => {
  it('创建窗口时装上 console-message（以前根本没有这个监听）', async () => {
    const { win } = await openWindow()
    assert.equal(win.emitted.count('console-message'), 1)
  })

  it('应用级新建的 webContents 也装上（devtools / 后续窗口）', async () => {
    const { appEvents } = await openWindow()
    const other = makeWindow()
    appEvents.emit('web-contents-created', {}, other.webContents)
    assert.equal(other.emitted.count('console-message'), 1)
  })

  it('同一个 webContents 被两条路径硬化时只装一次（否则每条日志落盘两遍）', async () => {
    const { win } = await openWindow()
    // 应用级（web-contents-created）+ createMainWindow 显式调用 = 两次硬化尝试
    assert.equal(win.emitted.count('console-message'), 1, '必须去重')
  })

  it('一次渲染日志只落一条盘', async () => {
    const { win, calls } = await openWindow()
    emitConsole(win, 1, 'only-once')
    assert.equal(calls.length, 1, `重复注册会让日志翻倍，实际落了 ${calls.length} 条`)
  })

  it('结构化渲染日志按自身事件名与字段落盘（可检索）', async () => {
    const { win, calls } = await openWindow()
    emitConsole(
      win,
      3,
      `${RENDERER_LOG_PREFIX}${JSON.stringify({
        event: 'recording.attachPort.failed',
        code: 'E20020',
        numericCode: 'E20020',
        severity: 'error',
        params: {},
        context: { reason: 'attach-port-failed', sessionId: 's-1' },
      })}`,
      12,
      'file:///app/assets/recorder.js',
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.level, 'error')
    assert.equal(calls[0]!.event, 'recording.attachPort.failed')
    assert.equal(calls[0]!.fields.event, 'recording.attachPort.failed')
    assert.equal(calls[0]!.fields.code, 'E20020')
    assert.deepEqual(calls[0]!.fields.context, { reason: 'attach-port-failed', sessionId: 's-1' })
    assert.equal(calls[0]!.fields.rendererConsole, true)
    assert.equal(calls[0]!.fields.line, 12)
    assert.equal(calls[0]!.fields.source, 'file:///app/assets/recorder.js')
  })

  it('级别映射：error→error、warning→warn、info/verbose→info', async () => {
    const { win, calls } = await openWindow()
    emitConsole(win, 3, 'e')
    emitConsole(win, 2, 'w')
    emitConsole(win, 1, 'i')
    emitConsole(win, 0, 'v')
    assert.deepEqual(calls.map(c => c.level), ['error', 'warn', 'info', 'info'])
  })

  it('普通输出（Vue 警告、CSP 违规）也能落盘，事件名统一 renderer.console', async () => {
    const { win, calls } = await openWindow()
    emitConsole(win, 2, 'Refused to load the script because it violates CSP')
    assert.equal(calls[0]!.event, 'renderer.console')
    assert.equal(calls[0]!.fields.message, 'Refused to load the script because it violates CSP')
    assert.equal(calls[0]!.fields.rendererConsole, undefined)
  })

  it('事件名不合规时退回 renderer.console，并把原名留在 rendererEvent（日志不能因命名消失）', async () => {
    const { win, calls } = await openWindow()
    emitConsole(win, 3, `${RENDERER_LOG_PREFIX}${JSON.stringify({ event: 'Bad Event!', code: 'X' })}`)
    assert.equal(calls[0]!.event, 'renderer.console')
    assert.equal(calls[0]!.fields.rendererEvent, 'Bad Event!')
    assert.equal(calls[0]!.fields.code, 'X')
  })

  it('超长消息被截断（堆栈/巨型 JSON 不许挤爆日志）', async () => {
    const { win, calls } = await openWindow()
    emitConsole(win, 1, 'x'.repeat(RENDERER_CONSOLE_MAX_CHARS + 500))
    const message = String(calls[0]!.fields.message)
    assert.ok(message.startsWith('x'.repeat(100)), '前缀要保留')
    assert.ok(message.includes('（已截断'), '要有截断标记')
    assert.ok(message.length < RENDERER_CONSOLE_MAX_CHARS + 100, `不该原样落盘，实际 ${message.length}`)
  })

  it('空消息直接丢弃（Chromium 会发空行）', async () => {
    const { win, calls } = await openWindow()
    emitConsole(win, 1, '')
    assert.equal(calls.length, 0)
  })

  it('日志器自己抛错也不会把异常抛回 Electron', async () => {
    const { win, control } = await openWindow()
    control.throwing = true
    assert.doesNotThrow(() => emitConsole(win, 3, `${RENDERER_LOG_PREFIX}${JSON.stringify({ event: 'a.b' })}`))
  })

  it('没有注入 log 时也不炸（降级运行）', async () => {
    const { electron, windows } = makeElectron()
    const manager = createWindowManager({
      electron,
      preloadPath: 'x.cjs',
      appUrl: 'file:///app/index.html',
    })
    await manager.createMainWindow()
    assert.doesNotThrow(() => emitConsole(windows[0]!, 3, 'boom'))
  })
})

// ---------------------------------------------------------------------------
// 跨进程契约：两侧的前缀必须逐字相同，且渲染侧必须发单个字符串
// ---------------------------------------------------------------------------

describe('渲染侧与主侧的对接契约', () => {
  /** 注释里会引用「错误写法」本身，必须先剥注释再断言（否则守卫会假红） */
  const stripComments = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
  const rendererMain = stripComments(readFileSync(join(process.cwd(), 'src/renderer/src/app/main.ts'), 'utf8'))
  const rendererRaw = readFileSync(join(process.cwd(), 'src/renderer/src/app/main.ts'), 'utf8')

  it('渲染进程声明的前缀与主进程逐字一致', () => {
    const match = /RENDERER_LOG_PREFIX\s*=\s*'([^']*)'/.exec(rendererRaw)
    assert.ok(match, '渲染进程必须声明 RENDERER_LOG_PREFIX')
    assert.equal(match![1], RENDERER_LOG_PREFIX)
  })

  it('渲染进程把日志编成单个字符串参数（多参数的对象过不来）', () => {
    assert.match(rendererMain, /formatRendererLogLine\(/, '要经 formatRendererLogLine 编码')
    assert.ok(
      !/console\.(error|warn|info)\(\s*'\[ns\]'\s*,/.test(rendererMain),
      "不能写成 console.error('[ns]', payload)：Chromium 只把格式化文本交给 console-message，结构化字段会丢",
    )
    assert.match(rendererMain, /JSON\.stringify\(payload\)/, '结构化字段要经 JSON 序列化')
  })

  it('主进程确实注册了 console-message（这条通路曾经只存在于注释里）', () => {
    const main = stripComments(readFileSync(join(process.cwd(), 'src/main/bootstrap/window-manager.ts'), 'utf8'))
    assert.match(main, /contents\.on\('console-message'/, '必须注册 console-message')
    assert.match(main, /forwardRendererConsole\(/, '必须转发到日志')
  })
})
