/**
 * Novel Studio · 错误码与消息体系测试
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md §10 测试要点
 *
 * 运行（Node 22.6+ 原生即可，无需额外依赖）：
 *   npm test
 *   node --experimental-strip-types --test tests/shared/errors.test.ts
 *
 * 这个文件守护的是「错误体系本身不会坏」，而不是某个业务功能：
 *   · 编号稳定性 —— 防止有人往段中间插消息导致历史编号漂移
 *   · 目录完整性 —— MESSAGES 与 SEGMENTS 必须严格一致
 *   · 占位符     —— 声明与文案必须对齐，缺参不能漏出 {name}
 *   · 包裹语义   —— 取消不是错误、不重复包裹、未知键不抛错
 *   · 不外泄     —— UI 文案不得含绝对路径 / 技术名词 / 堆栈
 *   · 映射完整性 —— SYSTEM_ERRNO_MAP 的目标键必须存在
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  MESSAGES,
  SEGMENT_INFO,
  assertCatalogIntegrity,
  getMessage,
  interpolate,
  listAllCodes,
  resolveCode,
  segmentLabel,
  validatePlaceholders,
  type MessageCatalog,
  type MessageKey,
} from '../../src/shared/messages.ts'
import {
  AppError,
  PLACEHOLDER_FALLBACK,
  SYSTEM_ERRNO_MAP,
  formatBytes,
  isAbortError,
  isSerializedAppError,
  resolve,
  toLogFields,
  toSerialized,
  wrapUnknown,
} from '../../src/shared/errors.ts'

// ---------------------------------------------------------------------------
// 目录与编号
// ---------------------------------------------------------------------------

/**
 * `MESSAGES` 在源码里是 `as const satisfies Record<string, ErrorMessage>`，
 * 因此逐条保留了各自的字面量形状：没写 `retryable`/`detail`/`hint`/`dev` 的条目
 * 在类型上**没有**这些属性（`MESSAGES[key]` 于是成了「有/没有」的联合）。
 *
 * 本文件要按统一形状遍历整个目录（这正是测试的目的），所以在这里一次性
 * 视作 `MessageCatalog`：可选字段按 `ErrorMessage` 的声明变成 `undefined`，
 * `action`/`severity` 恢复成联合类型（否则 `!== 'none'` 会被判成恒真比较）。
 * 只影响静态类型，运行时对象一字未改。
 */
const CATALOG = MESSAGES as MessageCatalog


describe('消息目录完整性', () => {
  it('MESSAGES 与 SEGMENTS 严格一致（漏登记/多登记都会失败）', () => {
    assert.doesNotThrow(() => assertCatalogIntegrity())
  })

  it('每条消息都能派生出非兜底编号', () => {
    for (const key of Object.keys(CATALOG) as MessageKey[]) {
      const code = resolveCode(key)
      assert.notEqual(code, 'E000000', `${key} 未登记到 SEGMENTS，无法派生编号`)
      assert.match(code, /^E\d{5}$/, `${key} 的编号格式异常：${code}`)
    }
  })

  it('编号全局唯一', () => {
    const codes = listAllCodes().map(c => c.code)
    assert.equal(new Set(codes).size, codes.length, '存在重复编号')
  })

  it('每条消息都有段标签', () => {
    for (const key of Object.keys(CATALOG) as MessageKey[]) {
      assert.notEqual(segmentLabel(key), 'UNKNOWN', `${key} 的段标签未知`)
    }
  })

  it('段号覆盖 1/2/3/4/5/6/7/8/9/0 十个段', () => {
    const segs = SEGMENT_INFO.map(s => s.segment).sort()
    assert.deepEqual(segs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('段内条目数非零', () => {
    for (const seg of SEGMENT_INFO) {
      assert.ok(seg.keys.length > 0, `段 ${seg.segment} (${seg.label}) 没有任何条目`)
    }
  })
})

describe('编号稳定性（防止历史编号漂移）', () => {
  /**
   * 快照：一旦发布，这些编号不得改变。
   * 若本测试失败，说明有人往段中间插入了消息或删除了条目 —— 这是纪律违规。
   */
  const SNAPSHOT: Record<string, string> = {
    INVALID_PAYLOAD: 'E10000',
    INTERNAL: 'E10010',
    DEVICE_UNAVAILABLE: 'E20000',
    DEVICE_LOST: 'E20002',
    FILTER_UNSUPPORTED: 'E20019',
    FILE_TOO_LARGE: 'E30000',
    RULE_PATTERN_UNSAFE: 'E30016',
    EXPORT_QCPRECHECK_FAILED: 'E40000',
    EXPORT_M4B_VERIFY_FAILED: 'E40017',
    CANVAS_CHAPTER_EMPTY: 'E50000',
    VOICE_ACTOR_UNBOUND: 'E50016',
    PROVIDER_UNAVAILABLE: 'E60000',
    AI_FORCED_ALIGN_UNAVAILABLE: 'E60013',
    PROVIDER_NETWORK_ERROR: 'E60014',
    DB_BUSY: 'E70000',
    AUDIO_FILE_MISSING: 'E70008',
    TASK_FAILED: 'E80000',
    TASK_NOT_FOUND: 'E80003',
    APP_SINGLE_INSTANCE: 'E90000',
    APP_DIAGNOSTICS_EXPORTED: 'E90006',
    UI_RENDER_ERROR: 'E00000',
    MAIN_UNHANDLED_REJECTION: 'E00003',
  }

  it('已发布的关键编号保持不变', () => {
    for (const [key, expected] of Object.entries(SNAPSHOT)) {
      assert.equal(resolveCode(key as MessageKey), expected, `${key} 的编号发生了漂移`)
    }
  })

  it('每段编号从 0000 连续递增，无空洞', () => {
    for (const seg of SEGMENT_INFO) {
      seg.keys.forEach((key, i) => {
        const expected = `E${seg.segment}${String(i).padStart(4, '0')}`
        assert.equal(resolveCode(key), expected, `段 ${seg.segment} 第 ${i} 条编号不连续`)
      })
    }
  })
})

// ---------------------------------------------------------------------------
// 文案质量
// ---------------------------------------------------------------------------

describe('文案与占位符', () => {
  it('占位符声明与文案完全对齐', () => {
    const problems = validatePlaceholders()
    assert.deepEqual(problems, [], `占位符问题：\n${problems.join('\n')}`)
  })

  it('插值缺参数时退化为占位符而非漏出花括号', () => {
    assert.equal(interpolate('还需要约「{need}」才能继续。', {}), '还需要约「-」才能继续。')
    assert.equal(interpolate('文件「{name}」不存在', { name: 'a.txt' }), '文件「a.txt」不存在')
    assert.equal(interpolate('无占位符'), '无占位符')
  })

  it('标题非空、无句号结尾、长度合理', () => {
    for (const key of Object.keys(CATALOG) as MessageKey[]) {
      const msg = CATALOG[key]
      assert.ok(msg.title.trim().length > 0, `${key} 标题为空`)
      assert.ok(!msg.title.endsWith('。'), `${key} 标题不应以句号结尾（标题不是句子）`)
      assert.ok(!msg.title.includes('{'), `${key} 的标题不应含占位符（标题在 toast 里是单行，无法容纳变量）`)
      assert.ok(msg.title.length <= 40, `${key} 标题过长：${msg.title.length} 字`)
    }
  })

  it('严重度与动作取值合法', () => {
    const severities = new Set(['info', 'warning', 'error', 'fatal'])
    const actions = new Set(['retry', 'open_settings', 'open_folder', 'reload', 'contact_support', 'dismiss', 'none'])
    for (const key of Object.keys(CATALOG) as MessageKey[]) {
      const msg = CATALOG[key]
      assert.ok(severities.has(msg.severity), `${key} 严重度非法：${msg.severity}`)
      assert.ok(actions.has(msg.action), `${key} 动作非法：${msg.action}`)
    }
  })

  it('可重试的消息必须配一个可执行的重试类动作', () => {
    // 注意：可重试不等于必须有「重试」按钮 —— 例如 CONFLICT（数据已被修改）
    // 的正确动作是 reload（重新加载最新数据），而不是重放同一个写请求。
    const RETRY_LIKE = new Set(['retry', 'reload'])
    for (const key of Object.keys(CATALOG) as MessageKey[]) {
      const msg = CATALOG[key]
      if (msg.retryable === true) {
        assert.ok(
          RETRY_LIKE.has(msg.action),
          `${key} 声明了 retryable，但 action 是 ${msg.action}（应为 retry 或 reload）`,
        )
      }
    }
  })

  it('取消类消息必须是提示级且无按钮', () => {
    for (const key of ['TASK_CANCELLED', 'PROVIDER_ABORTED', 'PROCESS_ABORTED'] as MessageKey[]) {
      assert.equal(CATALOG[key].severity, 'info', `${key} 应为 info 级（不弹错框）`)
    }
    assert.equal(MESSAGES.TASK_CANCELLED.action, 'none')
    assert.equal(MESSAGES.PROVIDER_ABORTED.action, 'none')
  })

  it('阻断级消息必须提供可行动作或明确说明', () => {
    for (const key of Object.keys(CATALOG) as MessageKey[]) {
      const msg = CATALOG[key]
      if (msg.severity !== 'fatal') continue
      assert.ok(
        msg.action !== 'none' && msg.action !== 'dismiss',
        `${key} 是阻断级（fatal），必须给出可执行动作，不能只有"知道了"`,
      )
      assert.ok(msg.hint, `${key} 是阻断级（fatal），必须给出 hint 告诉用户下一步`)
    }
  })
})

describe('不外泄内部信息（UI 文案纪律）', () => {
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/\bffmpeg\b/i, 'ffmpeg'],
    [/\bSQLite\b/i, 'SQLite'],
    [/\bEACCES\b|\bENOENT\b|\bENOSPC\b|\bEBUSY\b/, '系统错误码'],
    [/\bIPC\b/, 'IPC'],
    [/\bundefined\b|\bnull\b/, 'JavaScript 空值'],
    [/[A-Za-z]:[\\/]/, 'Windows 绝对路径'],
    [/\/(Users|home)\//, 'Unix 绝对路径'],
    [/\bat [\w.$]+ \(/, '调用栈'],
    [/\bstack\b/i, 'stack 字样'],
    [/\bZod\b/, 'Zod'],
    [/\bONNX\b/i, 'ONNX'],
    [/\bSHA-?256\b/i, 'SHA-256'],
  ]

  it('用户可见文案（标题/说明/建议）不含技术名词与路径', () => {
    const violations: string[] = []
    for (const key of Object.keys(CATALOG) as MessageKey[]) {
      const msg = CATALOG[key]
      for (const [field, text] of [['title', msg.title], ['detail', msg.detail], ['hint', msg.hint]] as const) {
        if (!text) continue
        for (const [pattern, label] of FORBIDDEN) {
          if (pattern.test(text)) violations.push(`${key}.${field} 含「${label}」：${text}`)
        }
      }
    }
    assert.deepEqual(violations, [], `文案泄露内部信息：\n${violations.join('\n')}`)
  })

  it('dev 字段允许（且应当）含技术细节', () => {
    // dev 只进日志与诊断包，因此可以写 ffmpeg / SQL 等；抽查几条确实有内容
    const withDev = (Object.keys(CATALOG) as MessageKey[]).filter(k => CATALOG[k].dev)
    assert.ok(withDev.length > 50, `带 dev 说明的消息过少（${withDev.length}），不利于排障`)
  })
})

// ---------------------------------------------------------------------------
// 取值与回退
// ---------------------------------------------------------------------------

describe('getMessage 取值与回退', () => {
  it('已知键返回完整字段', () => {
    const m = getMessage('DEVICE_LOST', { duration: '3 分 12 秒' })
    assert.equal(m.key, 'DEVICE_LOST')
    assert.equal(m.code, 'E20002')
    assert.equal(m.segment, 'RECORD')
    assert.equal(m.severity, 'fatal')
    assert.match(m.detail!, /3 分 12 秒/)
  })

  it('未知键回退到 INTERNAL 且不抛错', () => {
    const m = getMessage('TOTALLY_UNKNOWN_KEY')
    assert.equal(m.key, 'INTERNAL')
    assert.equal(m.code, resolveCode('INTERNAL'))
    assert.ok(m.dev?.includes('未登记的语义键'))
  })

  it('缺少参数时不会漏出花括号', () => {
    const m = getMessage('DISK_FULL', {})
    assert.equal(m.detail, '还需要约「-」才能继续。')
    assert.ok(!m.detail!.includes('{'))
  })

  it('字段可选项不会被写成 undefined', () => {
    const m = getMessage('TASK_CANCELLED')
    assert.ok(!('detail' in m), '无 detail 的消息不应带 detail 键')
    assert.ok(!('hint' in m), '无 hint 的消息不应带 hint 键')
  })
})

// ---------------------------------------------------------------------------
// AppError
// ---------------------------------------------------------------------------

describe('AppError 构造与序列化', () => {
  it('用消息表 title 作为 Error.message（便于日志可读）', () => {
    const e = new AppError('DEVICE_LOST', { params: { duration: '1 分钟' } })
    assert.equal(e.message, '录音设备已断开')
    assert.equal(e.name, 'AppError')
    assert.ok(e instanceof Error)
    assert.ok(e instanceof AppError)
  })

  it('携带编号、严重度、动作与可重试标记', () => {
    const e = new AppError('FILE_BUSY', { params: { name: 'out.mp3' } })
    assert.equal(e.key, 'FILE_BUSY')
    assert.equal(e.numericCode, 'E10006')
    assert.equal(e.severity, 'warning')
    assert.equal(e.action, 'retry')
    assert.equal(e.retryable, true)
  })

  it('允许覆盖严重度与动作（同一码在不同场景下阻断性不同）', () => {
    const e = new AppError('PROVIDER_TIMEOUT', { severity: 'fatal', action: 'contact_support', retryable: false })
    assert.equal(e.severity, 'fatal')
    assert.equal(e.action, 'contact_support')
    assert.equal(e.retryable, false)
  })

  it('resolved 与 getMessage 一致', () => {
    const e = new AppError('MODEL_MISSING', { params: { model: 'bge-small-zh' } })
    assert.equal(e.resolved.title, getMessage('MODEL_MISSING', { model: 'bge-small-zh' }).title)
  })

  it('序列化 → 反序列化保持字段完整', () => {
    const e = new AppError('EXPORT_FFMPEG_FAILED', {
      params: { chapter: 42, stage: '响度标准化' },
      details: { cmd: 'ffmpeg -i ...' },
      cause: new Error('exit code 1'),
    })
    const s = toSerialized(e)
    assert.ok(isSerializedAppError(s))
    assert.equal(s.code, 'EXPORT_FFMPEG_FAILED')
    assert.equal(s.numericCode, 'E40002')
    assert.equal(s.severity, 'error')
    assert.equal(s.action, 'retry')
    assert.equal(s.retryable, true)
    assert.equal(s.params.chapter, 42)

    const back = AppError.fromSerialized(s)
    assert.equal(back.key, s.code)
    assert.equal(back.numericCode, s.numericCode)
    assert.equal(back.severity, s.severity)
    assert.equal(back.action, s.action)
    assert.equal(back.retryable, s.retryable)
    assert.equal(back.message, s.message)
    assert.deepEqual(back.causeChain, s.causeChain)
  })

  it('details 中的密钥被脱敏', () => {
    const e = new AppError('PROVIDER_UNAVAILABLE', {
      details: { apiKey: 'sk-1234567890', Authorization: 'Bearer abc', prompt: 'x'.repeat(5000) },
    })
    const s = toSerialized(e)
    assert.equal(s.details!.apiKey, '***')
    assert.equal(s.details!.Authorization, '***')
    assert.ok(String(s.details!.prompt).includes('截断'))
    assert.ok(!JSON.stringify(s).includes('sk-1234567890'))
  })
})

// ---------------------------------------------------------------------------
// 包裹语义
// ---------------------------------------------------------------------------

describe('wrapUnknown 包裹规则', () => {
  it('已是 AppError 时不重复包裹', () => {
    const original = new AppError('MODEL_OOM')
    const once = wrapUnknown(original)
    const twice = wrapUnknown(once)
    assert.equal(once, original, '不应创建新对象')
    assert.equal(twice.key, 'MODEL_OOM', '重复包裹会退化成「未预期的错误」，必须避免')
  })

  it('AbortError 映射为取消（静默）', () => {
    const e = wrapUnknown(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    assert.equal(e.key, 'TASK_CANCELLED')
    assert.equal(e.isCancelled, true)
    assert.ok(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })))
    assert.ok(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' })))
  })

  it('系统 errno 按映射表转成具体业务码', () => {
    const cases: Array<[string, string]> = [
      ['ENOENT', 'FILE_NOT_FOUND'],
      ['EACCES', 'PERMISSION_DENIED'],
      ['ENOSPC', 'DISK_FULL'],
      ['EBUSY', 'FILE_BUSY'],
      ['SQLITE_BUSY', 'DB_BUSY'],
      ['SQLITE_CORRUPT', 'DB_CORRUPT'],
      ['ETIMEDOUT', 'PROVIDER_TIMEOUT'],
      ['ECONNRESET', 'PROVIDER_NETWORK_ERROR'],
      ['ECONNREFUSED', 'PROVIDER_UNAVAILABLE'],
      ['NotAllowedError', 'DEVICE_PERMISSION'],
    ]
    for (const [errno, expected] of cases) {
      const e = wrapUnknown(Object.assign(new Error('x'), { code: errno }))
      assert.equal(e.key, expected, `${errno} 应映射为 ${expected}，实际 ${e.key}`)
    }
  })

  it('网络中断不能被当成取消（否则会被静默吞掉）', () => {
    const e = wrapUnknown(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    assert.equal(e.key, 'PROVIDER_NETWORK_ERROR')
    assert.equal(e.isCancelled, false, '网络故障不是用户取消，必须让用户看到')
    assert.equal(e.severity, 'warning')
    assert.equal(e.retryable, true)
  })

  it('未知 Error 落入兜底码并保留原因链', () => {
    const e = wrapUnknown(new Error('something exploded'))
    assert.equal(e.key, 'INTERNAL')
    assert.ok(e.causeChain.length > 0)
    assert.match(e.causeChain[0], /something exploded/)
  })

  it('抛出非 Error（字符串/对象）也不崩', () => {
    assert.equal(wrapUnknown('boom').key, 'INTERNAL')
    assert.equal(wrapUnknown(42).key, 'INTERNAL')
    assert.equal(wrapUnknown(null).key, 'INTERNAL')
    assert.equal(wrapUnknown(undefined).key, 'INTERNAL')
    assert.equal(wrapUnknown({ weird: true }).key, 'INTERNAL')
  })

  it('可用自定义兜底码', () => {
    assert.equal(wrapUnknown(new Error('x'), 'TASK_FAILED').key, 'TASK_FAILED')
  })
})

// ---------------------------------------------------------------------------
// 兑现与日志
// ---------------------------------------------------------------------------

describe('resolve 兑现（渲染侧可直接使用）', () => {
  it('产出可渲染字段，且不含 dev 说明（除非显式要求）', () => {
    const e = new AppError('MODEL_MISSING', { params: { model: 'ggml-base.bin' } })
    const d = resolve(e)
    assert.equal(d.code, 'E60005')
    assert.equal(d.title, '缺少必需的功能模型')
    assert.match(d.detail!, /ggml-base\.bin/)
    assert.equal(d.severity, 'error')
    assert.equal(d.action, 'open_settings')
    assert.equal(d.devText, undefined, '默认不应把 dev 说明带给用户')
  })

  it('开发模式下附带 dev 与原因链', () => {
    const e = new AppError('INTERNAL', { cause: new Error('root cause here') })
    const d = resolve(e, { includeDev: true })
    assert.ok(d.devText, '开发模式应带 devText')
    assert.match(d.devText!, /root cause here/)
  })

  it('接受序列化对象、AppError 与任意原始错误三种输入', () => {
    const s = toSerialized(new AppError('DB_CORRUPT'))
    assert.equal(resolve(s).code, 'E70001')
    assert.equal(resolve(new AppError('DB_CORRUPT')).code, 'E70001')
    assert.equal(resolve(new Error('raw')).code, resolveCode('INTERNAL'))
    assert.equal(resolve(new AppError('NOT_FOUND')).title, '找不到对应的数据')
  })
})

describe('日志字段（docs/22 §8 必填项）', () => {
  it('error/fatal 级别必须带 code/numericCode/causeChain/stack', () => {
    const e = new AppError('DB_CORRUPT', { cause: new Error('disk image corrupted') })
    const f = toLogFields(e, 'db.integrityCheck.failed', { channel: 'app:startup' })
    assert.equal(f.code, 'DB_CORRUPT')
    assert.equal(f.numericCode, 'E70001')
    assert.equal(f.severity, 'fatal')
    assert.ok(f.causeChain && f.causeChain.length > 0, 'causeChain 不能为空')
    assert.ok(f.stack, 'error/fatal 应带 stack')
    assert.deepEqual(f.context, { channel: 'app:startup' })
  })

  it('info 级别不写 stack（避免日志膨胀）', () => {
    const f = toLogFields(new AppError('TASK_CANCELLED'), 'record.cancelled')
    assert.equal(f.severity, 'info')
    assert.equal(f.stack, undefined)
  })

  it('事件名与上下文透传', () => {
    const f = toLogFields(new AppError('NOT_FOUND'), 'canvas:updateLine.failed', { projectId: 'p1', chapterId: 'c1' })
    assert.equal(f.event, 'canvas:updateLine.failed')
    assert.equal(f.context!.projectId, 'p1')
  })
})

// ---------------------------------------------------------------------------
// 系统错误映射表
// ---------------------------------------------------------------------------

describe('SYSTEM_ERRNO_MAP 完整性', () => {
  it('每个映射目标键都存在于消息表', () => {
    for (const [errno, key] of Object.entries(SYSTEM_ERRNO_MAP)) {
      assert.ok(key in MESSAGES, `${errno} 指向不存在的语义键：${key}`)
    }
  })

  it('映射目标都能派生编号', () => {
    for (const [errno, key] of Object.entries(SYSTEM_ERRNO_MAP)) {
      assert.match(resolveCode(key), /^E\d{5}$/, `${errno} 的目标键无法派生编号`)
    }
  })

  it('磁盘与数据库的关键错误都有映射', () => {
    for (const errno of ['ENOSPC', 'ENOENT', 'EACCES', 'SQLITE_BUSY', 'SQLITE_CORRUPT']) {
      assert.ok(errno in SYSTEM_ERRNO_MAP, `${errno} 缺少映射，会退化成「未预期的错误」`)
    }
  })
})

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

describe('辅助函数', () => {
  it('formatBytes 输出人类可读体积', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(1024), '1 KB')
    assert.equal(formatBytes(1536), '1.5 KB')
    assert.equal(formatBytes(20 * 1024 * 1024), '20 MB')
    assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GB')
    // 非法输入退化为占位符（与 interpolate 的缺值显示保持一致）
    assert.equal(formatBytes(-1), PLACEHOLDER_FALLBACK)
    assert.equal(formatBytes(Number.NaN), PLACEHOLDER_FALLBACK)
  })

  it('wrapUnknown 保留原始 stack 便于定位', () => {
    const e = wrapUnknown(new Error('trace me'))
    assert.ok(e.stack && e.stack.includes('Error'))
  })
})
