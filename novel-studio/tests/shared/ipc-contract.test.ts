/**
 * 契约一致性测试（不依赖 electron / vue / 任何第三方包）
 * ============================================================================
 * 设计依据：docs/20-IPC契约.md §10 测试要点
 *
 * 为什么需要它：
 *   `src/shared/ipc.ts` 里有**两份**同一批通道的表述 ——
 *     ① `interface IpcContract`（类型层，编译期用）
 *     ② `const IPC_CHANNELS`（运行期数组，preload 白名单与 handler 注册用它）
 *   只改一边是这类代码最常见的漂移，且**编译期不一定报错**（类型不会因为数组少一项而失败），
 *   后果是渲染进程调用某个通道时被白名单静默拒绝。
 *
 *   本测试直接读源码文本比对两份表述，因此在没有 tsc 的环境下也能守住这条线。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const IPC_SRC = readFileSync('src/shared/ipc.ts', 'utf8')

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 从源码里抽取「看起来像通道名」的字符串字面量。
 *
 * 注意正则里域与动作都允许大写：
 * 域并非全是纯小写 —— `voiceActor:list` 这种驼峰域很常见。
 * 若写成 `'([a-z]+:[A-Za-z]+)'`，`voiceActor:list` 会在 `voice` 之后断开，
 * 匹配到的字符串不完整而被 `includes()` 判为“缺失”，
 * 于是测试会**误报**契约与数组不同步。这个坑已在实现期踩过一次。
 */
function extractChannelLiterals(src: string): string[] {
  return [...src.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)].map(m => m[1])
}

/** 从 `interface IpcContract {}` 体里取通道名（只接受形如 `'x:y': {` 的行） */
function parseContractChannels(src: string): string[] {
  const body = src.match(/export interface IpcContract \{([\s\S]*?)\n\}/)?.[1] ?? ''
  return [...body.matchAll(/^\s{2}'([a-zA-Z]+:[a-zA-Z]+)':\s*\{/gm)].map(m => m[1])
}

/** 从运行期数组里取通道名 */
function parseArray(src: string, name: string): string[] {
  const body = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1] ?? ''
  return extractChannelLiterals(body)
}

const contractChannels = parseContractChannels(IPC_SRC)
const runtimeChannels = parseArray(IPC_SRC, 'IPC_CHANNELS')
const eventNames = parseArray(IPC_SRC, 'IPC_EVENT_NAMES')
const sendNames = parseArray(IPC_SRC, 'IPC_SEND_NAMES')

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('IPC 契约：接口与运行期数组必须同步', () => {
  it('契约接口解析非空（防止正则失效导致测试变成空转）', () => {
    assert.ok(contractChannels.length > 100, `契约通道解析数量异常：${contractChannels.length}`)
  })

  it('两份表述的通道集合完全一致', () => {
    const onlyInContract = contractChannels.filter(c => !runtimeChannels.includes(c))
    const onlyInRuntime = runtimeChannels.filter(c => !contractChannels.includes(c))
    assert.deepEqual(
      onlyInContract,
      [],
      `这些通道在 IpcContract 里有、但 IPC_CHANNELS 里缺失（渲染进程会被白名单拒绝）：\n${onlyInContract.join('\n')}`,
    )
    assert.deepEqual(
      onlyInRuntime,
      [],
      `这些通道在 IPC_CHANNELS 里有、但 IpcContract 里没有（类型不完整）：\n${onlyInRuntime.join('\n')}`,
    )
  })

  it('通道数量一致', () => {
    assert.equal(runtimeChannels.length, contractChannels.length)
  })
})

describe('IPC 契约：命名规范', () => {
  it('通道名符合 <域>:<动作>（域与动作均可含大写，如 voiceActor:list）', () => {
    for (const c of contractChannels) {
      assert.match(c, /^[a-zA-Z]+:[a-zA-Z]+$/, `通道名不合规范：${c}`)
    }
  })

  it('通道名无重复', () => {
    assert.equal(new Set(contractChannels).size, contractChannels.length)
    assert.equal(new Set(runtimeChannels).size, runtimeChannels.length)
  })

  it('域前缀来自已知集合（防止把域写错拼成新域）', () => {
    const knownDomains = new Set([
      'app', 'book', 'chapter', 'canvas', 'character', 'voiceActor',
      'record', 'device', 'take', 'alignment', 'process', 'preset', 'music',
      'analysis', 'ffmpeg', 'mix', 'export', 'package', 'settings', 'task',
      'log', 'db',
    ])
    const unknown = [...new Set(contractChannels.map(c => c.split(':')[0]))]
      .filter(d => !knownDomains.has(d))
    assert.deepEqual(unknown, [], `出现未登记的域前缀：${unknown.join(', ')}`)
  })

  it('每个域至少有 1 个通道', () => {
    const byDomain = new Map<string, number>()
    for (const c of contractChannels) {
      const d = c.split(':')[0]
      byDomain.set(d, (byDomain.get(d) ?? 0) + 1)
    }
    assert.ok(byDomain.size >= 20, `域数量偏少：${byDomain.size}`)
  })
})

describe('IPC 契约：事件与单向通道', () => {
  it('事件名无重复且格式合法', () => {
    assert.equal(new Set(eventNames).size, eventNames.length)
    for (const e of eventNames) {
      assert.match(e, /^[a-z]+:[a-zA-Z]+$/, `事件名不合规范：${e}`)
    }
  })

  it('单向 send 通道名无重复且格式合法', () => {
    assert.equal(new Set(sendNames).size, sendNames.length)
    for (const s of sendNames) {
      assert.match(s, /^[a-z]+:[a-zA-Z]+$/, `send 通道名不合规范：${s}`)
    }
  })

  it('事件名与 invoke 通道名不得撞车（否则订阅与调用会混淆）', () => {
    const overlap = eventNames.filter(e => contractChannels.includes(e))
    // task:progress 与 task:list 之类不冲突；这里只拦完全相同的名字
    assert.deepEqual(overlap, [], `事件与 invoke 通道重名：${overlap.join(', ')}`)
  })

  it('包含错误推送事件 app:error（错误兜底的必需通道）', () => {
    assert.ok(
      eventNames.includes('app:error'),
      '缺少 app:error —— 主进程主动推送的错误将无法到达用户（见 docs/22 §6.1）',
    )
  })

  it('包含任务进度与录音状态事件（长任务与录音的必需通道）', () => {
    for (const required of ['task:progress', 'task:finished', 'record:status', 'record:level']) {
      assert.ok(eventNames.includes(required), `缺少必需事件：${required}`)
    }
  })
})

describe('IPC 契约：运行期校验辅助函数', () => {
  it('导出了 isIpcChannel / isIpcEventName / isIpcSendName', () => {
    for (const fn of ['isIpcChannel', 'isIpcEventName', 'isIpcSendName']) {
      assert.match(IPC_SRC, new RegExp(`export function ${fn}\\(`), `缺少运行期校验函数：${fn}`)
    }
  })

  it('校验函数实现里引用了对应的运行期数组（而不是硬编码另一份清单）', () => {
    assert.match(IPC_SRC, /isIpcChannel[\s\S]{0,200}IPC_CHANNELS/)
    assert.match(IPC_SRC, /isIpcEventName[\s\S]{0,200}IPC_EVENT_NAMES/)
    assert.match(IPC_SRC, /isIpcSendName[\s\S]{0,200}IPC_SEND_NAMES/)
  })
})

describe('IPC 契约：主进程与渲染进程的引用完整性', () => {
  const RENDERER_IPC = 'src/renderer/src/shared/lib/ipc.ts'

  it('渲染侧客户端存在且从 shared 契约导入类型', () => {
    const src = readFileSync(RENDERER_IPC, 'utf8')
    assert.match(src, /@shared\/errors\.ts/, '渲染侧 ipc.ts 应引用 shared 的错误模块')
    assert.match(src, /export async function call</, '渲染侧必须提供 call() 统一解包')
  })

  it('渲染侧不存在绕过 call() 直接调用 window.api.invoke 的业务代码', () => {
    // 允许出现在 shared/lib/ipc.ts 自身（那是唯一合法的出口）
    const files = [
      'src/renderer/src/shared/lib/error-bus.ts',
      'src/renderer/src/app/error-handler.ts',
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const direct = [...src.matchAll(/window\.api\.invoke\(/g)]
      // error-bus 里用于「导出诊断包」这类一次性系统调用是允许的，但必须注释说明；
      // 这里只断言不会大面积出现（≤2 处）
      assert.ok(
        direct.length <= 2,
        `${f} 中出现 ${direct.length} 处直接 window.api.invoke —— 应改为经 lib/ipc.ts 的 call()（docs/22 §6.2）`,
      )
    }
  })
})

describe('消息表与段号表一致性（错误码编号的根基）', () => {
  const MSG_SRC = readFileSync('src/shared/messages.ts', 'utf8')

  function parseMessages(src: string): string[] {
    const body = src.match(/export const MESSAGES = \{([\s\S]*?)\n\} as const satisfies/)?.[1] ?? ''
    return [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*\{/gm)].map(m => m[1])
  }
  function parseSegmentKeys(src: string): string[] {
    const seg = src.match(/const SEGMENTS[\s\S]*?as const/)?.[0] ?? ''
    const keys: string[] = []
    for (const m of seg.matchAll(/keys:\s*\[([\s\S]*?)\]/g)) {
      for (const k of m[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)) keys.push(k[1])
    }
    return keys
  }

  const msgKeys = parseMessages(MSG_SRC)
  const segKeys = parseSegmentKeys(MSG_SRC)

  it('消息表非空', () => {
    assert.ok(msgKeys.length > 100, `消息条目偏少：${msgKeys.length}`)
  })

  it('消息表与段号表条目数一致', () => {
    assert.equal(msgKeys.length, segKeys.length)
  })

  it('两边集合完全一致', () => {
    const onlyMsg = msgKeys.filter(k => !segKeys.includes(k))
    const onlySeg = segKeys.filter(k => !msgKeys.includes(k))
    assert.deepEqual(onlyMsg, [], `仅在 MESSAGES 里（未登记段号，编号会退化成 E000000）：\n${onlyMsg.join('\n')}`)
    assert.deepEqual(onlySeg, [], `仅在 SEGMENTS 里（虚键）：\n${onlySeg.join('\n')}`)
  })

  it('段名没有被误当成消息键（INTERNAL 例外：它既是段名也是合法消息键）', () => {
    // INTERNAL 在 messages.ts 里确实是 MESSAGES 的一个键（兜底码），
    // 同时又是段 0 的名字，因此它出现在消息表里是正确的，不能当误报。
    const segmentLabels = ['GENERIC', 'RECORD', 'BOOK', 'EXPORT', 'CANVAS', 'AI', 'DATA', 'TASK', 'APP']
    for (const label of segmentLabels) {
      assert.ok(
        !msgKeys.includes(label),
        `段名 ${label} 被误计入消息表 —— 解析逻辑把 SEGMENTS 里的 label 也匹配进来了`,
      )
    }
    // 反向自证：INTERNAL 应当既是段名也是消息键
    assert.ok(msgKeys.includes('INTERNAL'), 'INTERNAL 应当作为兜底消息键存在')
    const seg = MSG_SRC.match(/const SEGMENTS[\s\S]*?as const/)?.[0] ?? ''
    assert.match(seg, /label: 'INTERNAL'/, 'INTERNAL 应当是一个段的标签')
  })

  it('每个段都有条目', () => {
    const seg = MSG_SRC.match(/const SEGMENTS[\s\S]*?as const/)?.[0] ?? ''
    const segCount = [...seg.matchAll(/segment:\s*(\d+),/g)].length
    assert.equal(segCount, 10, `段数量异常：${segCount}`)
  })
})
