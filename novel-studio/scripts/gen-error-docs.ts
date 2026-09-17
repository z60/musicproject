#!/usr/bin/env node
/**
 * Novel Studio · 错误码文档生成器
 * ============================================================================
 * 权威来源（唯一真值）：
 *   · src/shared/messages.ts   —— 消息表 + 段号（数字编号由此派生）
 *   · src/shared/errors.ts     —— SYSTEM_ERRNO_MAP（系统错误 → 业务码）
 *
 * 本脚本**从模块 import 取真值**，而不是用正则解析源文件。
 * 这一点很关键：正则方案在 `dev` 字段写字符串拼接、或在字段里出现转义引号时
 * 会静默抽不全，生成出看似正常实则缺字的文档。
 *
 * 用法（Node 22.6+ 原生即可，无需额外安装）：
 *   node --experimental-strip-types scripts/gen-error-docs.ts            # 生成文档
 *   node --experimental-strip-types scripts/gen-error-docs.ts --check    # 校验是否与源同步（CI）
 *   node --experimental-strip-types scripts/gen-error-docs.ts --stdout   # 打印，不写文件
 *   node --experimental-strip-types scripts/gen-error-docs.ts --table    # 只打印紧凑表
 *   node --experimental-strip-types scripts/gen-error-docs.ts --json     # 输出 JSON
 *   node --experimental-strip-types scripts/gen-error-docs.ts --out <path>
 *
 * 也可用包管理器的快捷脚本（见 package.json）：
 *   npm run errors:docs / errors:docs:check / errors:docs:table
 *
 * 退出码：
 *   0 成功 / 已同步      1 校验失败（--check）或自检失败      2 用法错误
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 注意：这里显式带 .ts 扩展名。
// 本脚本以 ESM + 类型剥离方式直接运行（不经过打包），扩展名是 ESM 解析的硬要求；
// tsconfig 需开启 allowImportingTsExtensions（本文件不参与编译产物）。
import {
  MESSAGES,
  SEGMENT_INFO,
  assertCatalogIntegrity,
  resolveCode,
  segmentLabel,
  validatePlaceholders,
  type ErrorAction,
  type ErrorMessage,
  type MessageKey,
  type Severity,
} from '../src/shared/messages.ts'
import { SYSTEM_ERRNO_MAP } from '../src/shared/errors.ts'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_OUT = resolve(ROOT, 'docs/23-错误码一览.md')
const SOURCE_FILES = ['src/shared/messages.ts', 'src/shared/errors.ts']

/** 段号 → 覆盖范围说明（纯文档措辞，不属于代码逻辑，因此放在脚本里） */
const SEGMENT_SCOPE: Record<number, string> = {
  1: '通用（校验/权限/磁盘/未知兜底）',
  2: '录音、设备、切片、片段、处理链',
  3: '书籍导入与解析',
  4: '混音与导出',
  5: '画本、角色、任务包',
  6: 'AI Provider、模型、识别',
  7: '数据库、项目包、备份、文件',
  8: '任务队列',
  9: '应用生命周期、窗口、更新',
  0: '框架内部 / 未捕获异常兜底',
}

const SEVERITY_ZH: Record<Severity, string> = {
  fatal: '阻断',
  error: '错误',
  warning: '警告',
  info: '提示',
}

const ACTION_ZH: Record<ErrorAction, string> = {
  retry: '重试',
  open_settings: '前往设置',
  open_folder: '打开文件夹',
  reload: '重新加载',
  contact_support: '导出诊断包',
  dismiss: '知道了',
  none: '无',
}

// ---------------------------------------------------------------------------
// 数据组装
// ---------------------------------------------------------------------------

interface Entry {
  code: string
  key: MessageKey
  segment: number
  segmentLabel: string
  severity: Severity
  action: ErrorAction
  retryable: boolean
  title: string
  detail?: string
  hint?: string
  dev?: string
  params: readonly string[]
  deprecated: boolean
}

interface SegmentGroup {
  segment: number
  label: string
  scope: string
  entries: Entry[]
}

function buildEntries(): { groups: SegmentGroup[]; entries: Entry[] } {
  const groups: SegmentGroup[] = []
  const all: Entry[] = []

  for (const seg of SEGMENT_INFO) {
    const entries: Entry[] = seg.keys.map((key) => {
      const msg: ErrorMessage = MESSAGES[key]
      return {
        code: resolveCode(key),
        key,
        segment: seg.segment,
        segmentLabel: seg.label,
        severity: msg.severity,
        action: msg.action,
        retryable: msg.retryable ?? false,
        title: msg.title,
        ...(msg.detail ? { detail: msg.detail } : {}),
        ...(msg.hint ? { hint: msg.hint } : {}),
        ...(msg.dev ? { dev: msg.dev } : {}),
        params: msg.params ?? [],
        deprecated: msg.deprecated ?? false,
      }
    })
    groups.push({
      segment: seg.segment,
      label: seg.label,
      scope: SEGMENT_SCOPE[seg.segment] ?? '—',
      entries,
    })
    all.push(...entries)
  }

  return { groups, entries: all }
}

/** 自检：把「配置型错误」在生成前就炸出来，而不是生成一份错的文档 */
function selfCheck(entries: Entry[]): string[] {
  const problems: string[] = []

  // 1) 消息表与段号表必须严格一致
  try {
    assertCatalogIntegrity()
  } catch (e) {
    problems.push(`目录完整性失败：${(e as Error).message}`)
  }

  // 2) 占位符声明必须与文案一致
  const ph = validatePlaceholders()
  problems.push(...ph.map(p => `占位符：${p}`))

  // 3) 编号必须唯一（段内序号派生若有异常会在这里暴露）
  const seen = new Map<string, MessageKey>()
  for (const e of entries) {
    const dup = seen.get(e.code)
    if (dup) problems.push(`编号冲突：${e.code} 同时属于 ${dup} 与 ${e.key}`)
    else seen.set(e.code, e.key)
  }

  // 4) 每个 SYSTEM_ERRNO_MAP 的目标键都必须存在（否则文档会渲染成「未定义」）
  for (const [sys, key] of Object.entries(SYSTEM_ERRNO_MAP)) {
    if (!(key in MESSAGES)) problems.push(`SYSTEM_ERRNO_MAP.${sys} 指向不存在的语义键：${key}`)
  }

  // 5) 标题不应为空、不应明显过长
  for (const e of entries) {
    if (!e.title.trim()) problems.push(`${e.key}：标题为空`)
    if (e.title.length > 40) problems.push(`${e.key}：标题过长（${e.title.length} 字），建议 ≤ 24 字`)
  }

  return problems
}

// ---------------------------------------------------------------------------
// Markdown 生成
// ---------------------------------------------------------------------------

/** 表格单元格转义：竖线会截断表格，换行会毁掉整行 */
function cell(s: string | undefined): string {
  if (!s) return '—'
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function renderDoc(generatedAt: string): string {
  const { groups, entries } = buildEntries()
  const total = entries.length
  const out: string[] = []

  out.push('# 23 · 错误码与消息一览（自动生成）')
  out.push('')
  out.push('> **本文件由 `scripts/gen-error-docs.ts` 自动生成，请勿手工编辑。**')
  out.push('> 权威来源：`src/shared/messages.ts`（消息与编号）、`src/shared/errors.ts`（系统错误映射）。')
  out.push('> 设计说明：`22-错误码与消息体系.md`。')
  out.push('>')
  out.push(`> 重新生成：\`npm run errors:docs\`　·　校验：\`npm run errors:docs:check\``)
  out.push('>')
  out.push('> 用户报障时只需提供**编号**（如 `E200005`），据此即可定位到具体分支与日志事件。')
  out.push('')
  out.push(`_共 ${total} 条。_`)
  out.push('')

  // ── 编号规则 ──────────────────────────────────────────────────────────────
  out.push('## 编号规则')
  out.push('')
  out.push('```')
  out.push('E + 段号(1位) + 段内序号(4位)     例：E2 0005 = 录音段第 6 条')
  out.push('序号 = 该条在本段中的声明顺序。新增消息只能追加在段末，')
  out.push('因此已发布条目的编号恒定不变（历史日志可长期引用）。')
  out.push('```')
  out.push('')
  out.push('**文案里的 `{xxx}` 是占位符**，运行时由调用方传入实际值替换（如 `{need}` → `120 MB`）。')
  out.push('本表展示模板原文，便于校对与翻译。')
  out.push('')

  // ── 段总览 ────────────────────────────────────────────────────────────────
  out.push('| 段号 | 段名 | 覆盖范围 | 条数 | 编号区间 |')
  out.push('|------|------|----------|------|----------|')
  for (const g of groups) {
    const n = g.entries.length
    const first = `E${g.segment}0000`
    const last = `E${g.segment}${String(n - 1).padStart(4, '0')}`
    out.push(`| \`${g.segment}\` | ${g.label} | ${g.scope} | ${n} | \`${first}\` ~ \`${last}\` |`)
  }
  out.push(`| — | **合计** | — | **${total}** | — |`)
  out.push('')
  out.push('**严重度 → 展示形式**（详见 `22` §7）：')
  out.push('`提示`=顶部轻提示 · `警告`=Toast 可展开 · `错误`=Toast+重试按钮 · `阻断`=不可自动关闭的 Modal。')
  out.push('')
  out.push('**动作 → 按钮**：')
  out.push('`重试`（需调用方注入重试回调）· `前往设置`（并高亮相关项）· `打开文件夹` · `重新加载` · `导出诊断包` · `知道了` · `无`。')
  out.push('')

  // ── 分段明细 ──────────────────────────────────────────────────────────────
  for (const g of groups) {
    out.push(`## 段 ${g.segment} · ${g.label}`)
    out.push('')
    out.push(`${g.scope}　·　共 ${g.entries.length} 条`)
    out.push('')
    out.push('| 编号 | 语义键 | 级别 | 标题 | 说明 / 建议 | 动作 | 可重试 |')
    out.push('|------|--------|------|------|-------------|------|--------|')
    for (const e of g.entries) {
      let desc = e.detail ?? ''
      if (e.hint) desc = desc ? `${desc}<br>▸ ${e.hint}` : `▸ ${e.hint}`
      const key = e.deprecated ? `~~${e.key}~~（已废弃）` : `\`${e.key}\``
      out.push(
        `| \`${e.code}\` | ${key} | ${SEVERITY_ZH[e.severity]} | ${cell(e.title)} | ` +
        `${cell(desc)} | ${ACTION_ZH[e.action]} | ${e.retryable ? '是' : ''} |`,
      )
    }
    out.push('')
  }

  // ── 系统错误映射 ──────────────────────────────────────────────────────────
  const codeOfKey = new Map<MessageKey, string>(entries.map(e => [e.key, e.code]))
  out.push('## 系统错误自动映射')
  out.push('')
  out.push('发生系统级错误（`errno`）时，`wrapUnknown()` 按下表自动转成业务码，')
  out.push('用户看到的是可行动的具体提示，而不是「发生了未预期的错误」。')
  out.push('映射表位置：`src/shared/errors.ts` 的 `SYSTEM_ERRNO_MAP`（单一来源，本表由其生成）。')
  out.push('')
  out.push('| 系统错误 | 转为编号 | 语义键 | 用户看到的标题 | 可重试 |')
  out.push('|----------|----------|--------|----------------|--------|')
  for (const [sys, key] of Object.entries(SYSTEM_ERRNO_MAP)) {
    const code = codeOfKey.get(key)
    if (!code) continue // 自检已报错，这里跳过避免渲染脏数据
    const msg: ErrorMessage = MESSAGES[key]
    out.push(
      `| \`${sys}\` | \`${code}\` | ${key} | ${cell(msg.title)} | ${msg.retryable ? '是' : ''} |`,
    )
  }
  out.push('')
  out.push('> `AbortError` 映射到 `TASK_CANCELLED`（提示级、静默）是刻意设计：它是**用户主动取消**，不是故障。')
  out.push('> 但**网络中断（`ECONNRESET` / `EPIPE`）不属于取消**，单独映射到 `PROVIDER_NETWORK_ERROR`，')
  out.push('> 否则会被 `error-bus` 当取消吞掉，用户永远不知道请求失败了。')
  out.push('')

  // ── 维护纪律 ──────────────────────────────────────────────────────────────
  out.push('---')
  out.push('')
  out.push('## 维护纪律')
  out.push('')
  out.push('1. 新增消息**只能追加在所属段末尾**（`src/shared/messages.ts` 的 `SEGMENTS` 与该段 `MESSAGES`），禁止在段中间插入或删除——否则该段后续编号整体漂移，历史日志里的编号会指向另一个错误。')
  out.push('2. 该纪律由 `listAllCodes()` 快照测试守护；本脚本的 `--check` 模式也会在 CI 中拦截不同步。')
  out.push('3. 下线某条消息时保留定义并标记 `deprecated: true`，不要删行。')
  out.push('4. `dev` 字段请写**单行字符串**，不要用字符串拼接——`22` 的静态检查会拦截，但保持一致更省事。')
  out.push('5. 修改 `messages.ts` 或 `errors.ts` 后，运行 `pnpm errors:docs` 重新生成本文件。')
  out.push('')
  out.push('---')
  out.push('')
  out.push(`_生成时间：${generatedAt}（内容由源码决定，时间戳变化不影响内容一致性校验）_`)
  out.push('')

  return out.join('\n')
}

/** 紧凑表：用于嵌入 20-IPC契约.md 或粘贴进 PR/工单 */
function renderCompactTable(): string {
  const { entries } = buildEntries()
  const out: string[] = []
  out.push('| 编号 | 语义键 | 级别 | 标题 | 动作 | 可重试 |')
  out.push('|------|--------|------|------|------|--------|')
  for (const e of entries) {
    out.push(
      `| \`${e.code}\` | \`${e.key}\` | ${SEVERITY_ZH[e.severity]} | ${cell(e.title)} | ` +
      `${ACTION_ZH[e.action]} | ${e.retryable ? '是' : ''} |`,
    )
  }
  return out.join('\n')
}

/** JSON：供前端帮助页、报障表单、埋点校验使用 */
function renderJson(): string {
  const { groups, entries } = buildEntries()
  return JSON.stringify(
    {
      generatedFrom: SOURCE_FILES,
      total: entries.length,
      segments: groups.map(g => ({ segment: g.segment, label: g.label, scope: g.scope, count: g.entries.length })),
      messages: entries.map(e => ({
        code: e.code,
        key: e.key,
        segment: e.segment,
        segmentLabel: e.segmentLabel,
        severity: e.severity,
        severityLabel: SEVERITY_ZH[e.severity],
        action: e.action,
        actionLabel: ACTION_ZH[e.action],
        retryable: e.retryable,
        title: e.title,
        detail: e.detail ?? null,
        hint: e.hint ?? null,
        params: e.params,
        deprecated: e.deprecated,
      })),
      systemErrnoMap: Object.entries(SYSTEM_ERRNO_MAP).map(([sys, key]) => ({
        errno: sys,
        key,
        code: resolveCode(key),
        segment: segmentLabel(key),
      })),
    },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  mode: 'write' | 'check' | 'stdout' | 'table' | 'json'
  out: string
} {
  const args = argv.slice(2)
  let out = DEFAULT_OUT
  let mode: 'write' | 'check' | 'stdout' | 'table' | 'json' = 'write'

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case '--check': mode = 'check'; break
      case '--stdout': mode = 'stdout'; break
      case '--table': mode = 'table'; break
      case '--json': mode = 'json'; break
      case '--out': {
        const next = args[++i]
        if (!next) fail(2, '--out 需要跟一个路径')
        out = resolve(process.cwd(), next)
        break
      }
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        fail(2, `未知参数：${a}`)
    }
  }
  return { mode, out }
}

function printUsage(): void {
  console.log(
    [
      '用法: node --experimental-strip-types scripts/gen-error-docs.ts [选项]',
      '',
      '  （无选项）      生成 docs/23-错误码一览.md',
      '  --check        校验文件是否与源码一致；不一致则 exit 1（CI 用）',
      '  --stdout       打印完整文档到标准输出，不写文件',
      '  --table        只打印紧凑表（编号/语义键/级别/标题/动作）',
      '  --json         输出 JSON（供帮助页 / 报障表单使用）',
      '  --out <path>   指定输出文件路径',
      '  -h, --help     显示本帮助',
      '',
      '真值来源: src/shared/messages.ts, src/shared/errors.ts',
      '等价快捷脚本: npm run errors:docs / errors:docs:check / errors:docs:table',
    ].join('\n'),
  )
}

function fail(code: number, message: string): never {
  console.error(`[gen-error-docs] ${message}`)
  process.exit(code)
}

/**
 * 一致性比较时忽略时间戳行：它每次运行都变，但内容其实没变，
 * 否则 CI 的 --check 永远失败。
 */
function normalizeForCompare(text: string): string {
  return text
    .replace(/_生成时间：.*$/m, '_生成时间：<ignored>_')
    .trimEnd()
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const { mode, out } = parseArgs(process.argv)

  // 自检先跑：宁可报错退出，也不要生成一份看似正常的错文档
  const { entries } = buildEntries()
  const problems = selfCheck(entries)
  if (problems.length > 0) {
    console.error('[gen-error-docs] 自检未通过，已中止生成：')
    for (const p of problems) console.error(`  · ${p}`)
    process.exit(1)
  }

  if (mode === 'table') {
    process.stdout.write(renderCompactTable() + '\n')
    return
  }

  if (mode === 'json') {
    process.stdout.write(renderJson() + '\n')
    return
  }

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const content = renderDoc(generatedAt)

  if (mode === 'stdout') {
    process.stdout.write(content + '\n')
    return
  }

  if (mode === 'check') {
    let existing: string
    try {
      existing = readFileSync(out, 'utf8')
    } catch {
      fail(1, `文档不存在：${out}\n请运行 pnpm errors:docs 生成。`)
    }
    if (normalizeForCompare(existing) !== normalizeForCompare(content)) {
      console.error(
        [
          '[gen-error-docs] 文档与源码不一致：',
          `  文件：${out}`,
          '  原因：messages.ts / errors.ts 有改动，但未重新生成文档。',
          '  修复：npm run errors:docs',
        ].join('\n'),
      )
      process.exit(1)
    }
    console.log(`[gen-error-docs] 已同步 ✓（${entries.length} 条）`)
    return
  }

  // mode === 'write'
  let previous: string | null = null
  try {
    previous = readFileSync(out, 'utf8')
  } catch {
    /* 首次生成 */
  }

  if (previous !== null && normalizeForCompare(previous) === normalizeForCompare(content)) {
    console.log(`[gen-error-docs] 内容无变化，跳过写入（${entries.length} 条）`)
    return
  }

  writeFileSync(out, content, 'utf8')
  const verb = previous === null ? '已生成' : '已更新'
  console.log(`[gen-error-docs] ${verb}：${out}`)
  console.log(`[gen-error-docs] 共 ${entries.length} 条消息，覆盖 ${SEGMENT_INFO.length} 个段`)
}

main()
