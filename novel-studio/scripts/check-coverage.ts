/**
 * Novel Studio · 文档覆盖度与契约完整性检查
 * ============================================================================
 * 这个项目的特殊性：先有 22 份设计文档，再有代码。因此最该回答的问题是
 * **「文档是否真的落成了代码」**，而不是「代码编译过了没有」。
 *
 * 本脚本做四件事：
 *   1. 通道覆盖：src/shared/ipc.ts 的每个 channel 是否在主进程注册了 handler
 *   2. 错误码覆盖：messages.ts 的每个语义键是否被至少一处代码使用
 *   3. 文档引用：每个源码文件是否在注释里引用了 docs/ 的章节（可追溯性）
 *   4. 域覆盖：docs/ 的每个功能域文档是否都有对应代码目录
 *
 * 用法：
 *   node --experimental-strip-types scripts/check-coverage.ts
 *   node --experimental-strip-types scripts/check-coverage.ts --json
 *   node --experimental-strip-types scripts/check-coverage.ts --strict   # 缺口也作为失败
 *
 * 退出码：0 = 通过（非 strict 模式下只报缺口不失败）；1 = strict 且存在缺口
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const STRICT = process.argv.includes('--strict')
const AS_JSON = process.argv.includes('--json')
const OUT_FILE = join(ROOT, 'docs', '90-代码覆盖度报告.md')

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const srcFiles = walk(join(ROOT, 'src')).filter(f => /\.(ts|vue)$/.test(f) && !f.endsWith('.d.ts'))
const rel = (f: string): string => relative(ROOT, f).replace(/\\/g, '/')
const read = (f: string): string => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}

const fileText = new Map<string, string>()
for (const f of srcFiles) fileText.set(rel(f), read(f))

//（已移除：allSource 未使用 —— 覆盖率统计改为按文件逐个判断，不再拼接全文）

// ---------------------------------------------------------------------------
// 1. 通道覆盖
// ---------------------------------------------------------------------------

const ipcSrc = read(join(ROOT, 'src/shared/ipc.ts'))
const channels: string[] = []
{
  // 只从 IpcContract 接口体里取通道名。
  // 不能全文件扫 —— 运行期数组 IPC_CHANNELS 里是同一批字符串，会重复计数。
  // 域与动作都允许大写：`voiceActor:list` 这类驼峰域不是纯小写，
  // 用 [a-z]+ 会在 `voice` 处断开导致漏项（实测会漏 7 个通道）。
  const iface = ipcSrc.match(/export interface IpcContract \{([\s\S]*?)\n\}/)?.[1] ?? ''
  for (const m of iface.matchAll(/^\s{2}'([a-zA-Z]+:[a-zA-Z]+)':/gm)) channels.push(m[1])
}
/** 运行期数组（用于校验契约与数组是否同步） */
const runtimeChannels: string[] = []
{
  const arr = ipcSrc.match(/export const IPC_CHANNELS = \[([\s\S]*?)\] as const satisfies/)?.[1] ?? ''
  for (const m of arr.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)) runtimeChannels.push(m[1])
}

/**
 * 主进程「真正实现了 handler」的判定 —— 必须是可执行的注册，而不是提到过名字。
 *
 * 踩过的坑：早先版本只判断「主进程文本里是否出现该通道字符串」，
 * 而 `tests/main/ipc-handlers.test.ts` 会逐字提到全部通道名，
 * 于是覆盖度虚报成 100%。**用错误的方法测出漂亮数字，比不测更危险。**
 *
 * 现在的判据（两者取并集）：
 *   A. handler 声明表：`channel: 'xxx' as IpcChannel` 形式（对象字面量写法）
 *   B. `h('xxx', ...)` 工厂调用：`handlers/deps.ts` 的 `h()` 是**推荐的**登记方式，
 *      它把通道名作为第一个实参传入，因此不会出现 `channel:` 前缀 ——
 *      漏掉这一条曾让覆盖度虚报成 0%（全部 28 个真实 handler 都被判为「未实现」）。
 *      **过低和过高一样是错误的方法**，两个方向都会让人做错决策。
 */
const mainSrcFiles = srcFiles.filter(f => rel(f).startsWith('src/main/'))
const mainText = mainSrcFiles.map(f => fileText.get(rel(f)) ?? '').join('\n')

/**
 * handler 声明表里的通道。两种写法都认：
 *   · 对象字面量：`channel: 'app:getInfo' as IpcChannel`
 *   · h() 工厂：  `h('app:getInfo', ...)` / `h(\n  'app:getInfo',`（多行实参）
 * 这是「显式声明实现了」的最强信号。
 */
const CHANNEL_LITERAL = String.raw`'[a-zA-Z]+:[a-zA-Z]+'`
const DECLARED_PATTERNS = [
  new RegExp(String.raw`channel:\s*(${CHANNEL_LITERAL})`, 'g'),
  // h( 之后允许空白与换行（多行调用很常见）
  new RegExp(String.raw`\bh\(\s*(${CHANNEL_LITERAL})`, 'g'),
]

const declaredChannels = new Set<string>()
for (const [file, text] of fileText) {
  if (!file.startsWith('src/main/')) continue
  for (const re of DECLARED_PATTERNS) {
    for (const m of text.matchAll(re)) {
      declaredChannels.add(m[1]!.slice(1, -1))
    }
  }
}
const rendererText = srcFiles
  .filter(f => rel(f).startsWith('src/renderer/'))
  .map(f => fileText.get(rel(f)) ?? '')
  .join('\n')

interface ChannelStatus {
  channel: string
  /** handler 声明表里显式声明了（最强信号） */
  declared: boolean
  /** 主进程源码里提到过（弱信号，可能是注释） */
  mentionedInMain: boolean
  /** 渲染进程调用过 */
  calledFromRenderer: boolean
}

const channelStatus: ChannelStatus[] = channels.map(ch => {
  const literal = new RegExp(`["'\`]${ch}["'\`]`)
  return {
    channel: ch,
    declared: declaredChannels.has(ch),
    mentionedInMain: literal.test(mainText),
    calledFromRenderer: literal.test(rendererText),
  }
})

// ---------------------------------------------------------------------------
// 2. 错误码覆盖
// ---------------------------------------------------------------------------

const msgSrc = read(join(ROOT, 'src/shared/messages.ts'))
const msgKeys: string[] = []
{
  // 只取 MESSAGES 对象体里的顶层键
  const body = msgSrc.match(/export const MESSAGES = \{([\s\S]*?)\n\} as const satisfies/)
  if (body) for (const m of body[1].matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*\{/gm)) msgKeys.push(m[1])
}
const segSrc = msgSrc.match(/const SEGMENTS[\s\S]*?as const/)
/**
 * 段号表里的键：只取 `keys: [...]` 数组内部的内容。
 * 不能对整个 SEGMENTS 块扫引号 —— 那里还有 label: 'GENERIC' 这类段名会被误计。
 */
const segKeys: string[] = []
if (segSrc) {
  for (const m of segSrc[0].matchAll(/keys:\s*\[([\s\S]*?)\]/g)) {
    for (const k of m[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)) segKeys.push(k[1])
  }
}

/** 排除 messages.ts 自身的定义与 SEGMENTS 登记 */
const otherSource = srcFiles
  .filter(f => rel(f) !== 'src/shared/messages.ts')
  .map(f => fileText.get(rel(f)) ?? '')
  .join('\n')
/** 文档里的错误码也算"被使用"（设计文档明确引用） */
const docsText = walk(join(ROOT, 'docs'))
  .filter(f => f.endsWith('.md'))
  .map(f => read(f))
  .join('\n')

const unusedCodes = msgKeys.filter(k => {
  const re = new RegExp(`["'\`]${k}["'\`]`)
  return !re.test(otherSource) && !docsText.includes(k)
})
const definedOnlyInTable = msgKeys.filter(k => {
  const re = new RegExp(`["'\`]${k}["'\`]`)
  return !re.test(otherSource) && docsText.includes(k)
})

// ---------------------------------------------------------------------------
// 3. 文档引用（可追溯性）
// ---------------------------------------------------------------------------

const docRefRe = /docs\/\d\d[\d-]*[\u4e00-\u9fa5A-Za-z0-9-]*\.md|docs\/\d\d[\u4e00-\u9fa5]+/g
//（已移除：docFiles 未使用；docs 文本已在上方用于「错误码是否被文档引用」的判定）

interface FileTrace {
  file: string
  refs: string[]
  hasRef: boolean
}

const traces: FileTrace[] = [...fileText.entries()].map(([file, text]) => {
  const refs = [...new Set([...text.matchAll(docRefRe)].map(m => m[0]))]
  return { file, refs, hasRef: refs.length > 0 }
})

const coreFiles = traces.filter(t =>
  !t.file.endsWith('.d.ts') &&
  !t.file.includes('/shared/types.ts') &&
  !t.file.includes('/shared/ipc.ts'),
)
const untracedCore = coreFiles.filter(t => !t.hasRef)

// ---------------------------------------------------------------------------
// 4. 域覆盖：docs 里的功能域文档 -> 是否有对应代码
// ---------------------------------------------------------------------------

interface DomainExpectation {
  doc: string
  label: string
  codeGlobs: string[]
}

const DOMAINS: DomainExpectation[] = [
  { doc: 'docs/10-功能域-书籍导入.md', label: '书籍导入', codeGlobs: ['src/shared/text/', 'src/main/features/book/import/', 'src/renderer/src/features/book/'] },
  { doc: 'docs/11-功能域-画本编辑.md', label: '画本编辑', codeGlobs: ['src/shared/canvas/', 'src/main/features/book/canvas/', 'src/renderer/src/features/editor/'] },
  { doc: 'docs/12-功能域-录音.md', label: '录音', codeGlobs: ['src/shared/audio/', 'src/main/features/audio/', 'src/renderer/src/features/recording/'] },
  { doc: 'docs/13-功能域-对轨.md', label: '对轨', codeGlobs: ['src/shared/arrange/', 'src/main/features/book/alignment/', 'src/renderer/src/features/alignment/'] },
  { doc: 'docs/14-功能域-音频处理.md', label: '音频处理', codeGlobs: ['src/shared/ffmpeg/', 'src/main/features/audio/processor'] },
  { doc: 'docs/15-功能域-混音导出.md', label: '混音导出', codeGlobs: ['src/main/features/audio/mixer', 'src/main/features/audio/exporter', 'src/renderer/src/features/mixing/'] },
  { doc: 'docs/06-AI抽象层与向量判定.md', label: 'AI 与向量', codeGlobs: ['src/shared/ai/'] },
  { doc: 'docs/04-基础设施与队列.md', label: '基础设施', codeGlobs: ['src/main/infra/'] },
  { doc: 'docs/20-IPC契约.md', label: 'IPC 层', codeGlobs: ['src/main/ipc/', 'src/preload/'] },
  { doc: 'docs/03-数据模型与存储.md', label: '数据与项目包', codeGlobs: ['src/main/features/book/package/', 'src/main/infra/db/'] },
  { doc: 'docs/22-错误码与消息体系.md', label: '错误体系', codeGlobs: ['src/shared/errors.ts', 'src/shared/messages.ts', 'src/main/infra/errors/', 'src/renderer/src/shared/lib/error-bus.ts'] },
]

const allRel = [...fileText.keys()]
const domainStatus = DOMAINS.map(d => {
  const present = d.codeGlobs.filter(g => allRel.some(f => f.startsWith(g)))
  const missing = d.codeGlobs.filter(g => !allRel.some(f => f.startsWith(g)))
  return { ...d, present, missing, ok: present.length > 0, complete: missing.length === 0 }
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const summary = {
  files: {
    total: allRel.length,
    shared: allRel.filter(f => f.startsWith('src/shared/')).length,
    main: allRel.filter(f => f.startsWith('src/main/')).length,
    renderer: allRel.filter(f => f.startsWith('src/renderer/')).length,
  },
  channels: {
    total: channelStatus.length,
    /** 已显式声明 handler 实现（可信覆盖度） */
    declared: channelStatus.filter(c => c.declared).length,
    mentionedInMain: channelStatus.filter(c => c.mentionedInMain).length,
    calledFromRenderer: channelStatus.filter(c => c.calledFromRenderer).length,
    missingInMain: channelStatus.filter(c => !c.declared).map(c => c.channel),
    declaredChannels: channelStatus.filter(c => c.declared).map(c => c.channel),
  },
  codes: {
    total: msgKeys.length,
    registeredInSegments: segKeys.length,
    unused: unusedCodes,
    onlyInDocs: definedOnlyInTable,
  },
  traceability: {
    coreFiles: coreFiles.length,
    withDocRef: coreFiles.filter(t => t.hasRef).length,
    untraced: untracedCore.map(t => t.file),
    totalRefs: traces.reduce((s, t) => s + t.refs.length, 0),
  },
  domains: domainStatus.map(d => ({ label: d.label, doc: d.doc, ok: d.ok, complete: d.complete, missing: d.missing })),
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 百分比（分母为 0 时返回占位符） */
const pct = (a: number, b: number): string => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`)

/** 契约接口 与 运行期数组 是否同步 */
const channelParity = {
  contract: channels.length,
  runtime: runtimeChannels.length,
  onlyInContract: channels.filter(c => !runtimeChannels.includes(c)),
  onlyInRuntime: runtimeChannels.filter(c => !channels.includes(c)),
}

if (AS_JSON) {
  console.log(JSON.stringify({ ...summary, channelParity }, null, 2))
} else {
  console.log('')
  console.log('='.repeat(80))
  console.log('Novel Studio · 代码覆盖度报告')
  console.log('='.repeat(80))
  console.log('')
  console.log('【代码规模】')
  console.log(`  总文件 ${summary.files.total}  (shared ${summary.files.shared} / main ${summary.files.main} / renderer ${summary.files.renderer})`)
  console.log('')
  console.log('【IPC 契约完整性】')
  console.log(`  契约接口成员    ${channelParity.contract}`)
  console.log(`  运行期数组      ${channelParity.runtime}`)
  if (channelParity.onlyInContract.length || channelParity.onlyInRuntime.length) {
    console.log(`  ✗ 不同步！仅契约有：${channelParity.onlyInContract.join(', ') || '无'}`)
    console.log(`           仅数组有：${channelParity.onlyInRuntime.join(', ') || '无'}`)
  } else {
    console.log('  ✓ 契约与数组一致')
  }
  console.log('')
  console.log('【IPC 通道覆盖】')
  console.log(`  契约通道        ${summary.channels.total}`)
  console.log(`  handler 已声明   ${summary.channels.declared}  (${pct(summary.channels.declared, summary.channels.total)})  <- 可信覆盖度`)
  console.log(`  主进程提到过     ${summary.channels.mentionedInMain}  (${pct(summary.channels.mentionedInMain, summary.channels.total)})  <- 弱信号，含注释`)
  console.log(`  渲染进程已调用   ${summary.channels.calledFromRenderer}  (${pct(summary.channels.calledFromRenderer, summary.channels.total)})`)
  if (summary.channels.missingInMain.length > 0) {
    console.log(`  尚未实现 (${summary.channels.missingInMain.length} 个)：`)
    const show = summary.channels.missingInMain.slice(0, 12)
    console.log(`    ${show.join(', ')}${summary.channels.missingInMain.length > 12 ? ` …还有 ${summary.channels.missingInMain.length - 12} 个` : ''}`)
  }
  console.log('')
  console.log('【错误码覆盖】')
  console.log(`  消息表条目      ${summary.codes.total}`)
  console.log(`  段号表登记      ${summary.codes.registeredInSegments}  ${summary.codes.total === summary.codes.registeredInSegments ? '(一致 ✓)' : '(不一致 ✗)'}`)
  console.log(`  代码中未引用    ${summary.codes.unused.length}`)
  if (summary.codes.unused.length > 0) console.log(`    ${summary.codes.unused.slice(0, 15).join(', ')}${summary.codes.unused.length > 15 ? ' …' : ''}`)
  console.log('')
  console.log('【文档可追溯性】')
  console.log(`  核心源文件      ${summary.traceability.coreFiles}`)
  console.log(`  引用了 docs 的   ${summary.traceability.withDocRef}  (${pct(summary.traceability.withDocRef, summary.traceability.coreFiles)})`)
  console.log(`  文档引用总次数   ${summary.traceability.totalRefs}`)
  if (summary.traceability.untraced.length > 0) {
    console.log(`  未引用文档的文件 (${summary.traceability.untraced.length} 个)：`)
    for (const f of summary.traceability.untraced.slice(0, 12)) console.log(`    · ${f}`)
    if (summary.traceability.untraced.length > 12) console.log(`    · …还有 ${summary.traceability.untraced.length - 12} 个`)
  }
  console.log('')
  console.log('【功能域覆盖】')
  for (const d of summary.domains) {
    const mark = d.complete ? '✓ 完整' : d.ok ? '△ 部分' : '✗ 缺失'
    console.log(`  ${mark}  ${d.label.padEnd(12)} ${d.doc}`)
    if (d.missing.length > 0) console.log(`         缺：${d.missing.join('  ')}`)
  }
  console.log('')
  console.log('='.repeat(80))
}

// 生成 markdown 报告
const md: string[] = []
md.push('# 90 · 代码覆盖度报告（自动生成）')
md.push('')
md.push('> **本文件由 `scripts/check-coverage.ts` 自动生成，请勿手工编辑。**')
md.push('> 生成方式：`npm run check:coverage`')
md.push('')
md.push('这个项目先有 22 份设计文档、再有代码，因此最该回答的问题是**「文档是否真的落成了代码」**。')
md.push('本报告给出四个维度的客观数字，用于判断实现进度，而不是主观宣称。')
md.push('')
md.push('## 1. 代码规模')
md.push('')
md.push('| 范围 | 文件数 |')
md.push('|------|--------|')
md.push(`| 全部源码 | ${summary.files.total} |`)
md.push(`| ` + '`src/shared`' + ` （零依赖可测逻辑 + 契约） | ${summary.files.shared} |`)
md.push(`| ` + '`src/main`' + ` （Electron 主进程） | ${summary.files.main} |`)
md.push(`| ` + '`src/renderer`' + ` （Vue 渲染进程） | ${summary.files.renderer} |`)
md.push('')
md.push('## 2. IPC 通道覆盖')
md.push('')
md.push('契约定义在 `src/shared/ipc.ts`。**可信覆盖度是「handler 已声明」这一列** ——')
md.push('它统计 `src/main/**` 里 `channel: \'xxx\' as IpcChannel` 形式的显式声明。')
md.push('「主进程提到过」是弱信号（可能只是注释或文档引用），不要用它判断进度。')
md.push('')
md.push('| 指标 | 数量 | 占比 |')
md.push('|------|------|------|')
md.push(`| 契约通道总数 | ${summary.channels.total} | 100% |`)
md.push(`| **handler 已声明** | **${summary.channels.declared}** | **${pct(summary.channels.declared, summary.channels.total)}** |`)
md.push(`| 主进程提到过（弱信号） | ${summary.channels.mentionedInMain} | ${pct(summary.channels.mentionedInMain, summary.channels.total)} |`)
md.push(`| 渲染进程已调用 | ${summary.channels.calledFromRenderer} | ${pct(summary.channels.calledFromRenderer, summary.channels.total)} |`)
md.push('')
if (summary.channels.missingInMain.length > 0) {
  md.push(`**尚未实现 handler（${summary.channels.missingInMain.length} 个）**：`)
  md.push('')
  md.push('```')
  md.push(summary.channels.missingInMain.join('\n'))
  md.push('```')
  md.push('')
}
md.push('## 3. 错误码覆盖')
md.push('')
md.push('| 指标 | 数量 |')
md.push('|------|------|')
md.push(`| 消息表条目 | ${summary.codes.total} |`)
md.push(`| 段号表登记 | ${summary.codes.registeredInSegments} |`)
md.push(`| 代码中未被引用 | ${summary.codes.unused.length} |`)
md.push('')
if (summary.codes.unused.length > 0) {
  md.push('未被引用的错误码（可能是预留，也可能是漏接）：')
  md.push('')
  md.push('```')
  md.push(summary.codes.unused.join('\n'))
  md.push('```')
  md.push('')
}
md.push('## 4. 文档可追溯性')
md.push('')
md.push('每个核心源文件是否在注释里引用了对应的 `docs/` 章节 —— 这是「代码为什么这么写」的证据链。')
md.push('')
md.push('| 指标 | 数量 | 占比 |')
md.push('|------|------|------|')
md.push(`| 核心源文件 | ${summary.traceability.coreFiles} | 100% |`)
md.push(`| 引用了 docs | ${summary.traceability.withDocRef} | ${pct(summary.traceability.withDocRef, summary.traceability.coreFiles)} |`)
md.push(`| 文档引用总次数 | ${summary.traceability.totalRefs} | — |`)
md.push('')
if (summary.traceability.untraced.length > 0) {
  md.push(`**未引用文档的文件（${summary.traceability.untraced.length} 个）**：`)
  md.push('')
  md.push('```')
  md.push(summary.traceability.untraced.join('\n'))
  md.push('```')
  md.push('')
}
md.push('## 5. 功能域覆盖')
md.push('')
md.push('| 状态 | 功能域 | 文档 | 缺失的代码位置 |')
md.push('|------|--------|------|----------------|')
for (const d of summary.domains) {
  const mark = d.complete ? '✅ 完整' : d.ok ? '🟡 部分' : '❌ 缺失'
  md.push(`| ${mark} | ${d.label} | \`${d.doc}\` | ${d.missing.length > 0 ? d.missing.map(m => '`' + m + '`').join(' ') : '—'} |`)
}
md.push('')
md.push('---')
md.push('')
md.push(`_生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC_`)
md.push('')

try {
  writeFileSync(OUT_FILE, md.join('\n'), 'utf8')
  if (!AS_JSON) console.log(`[check-coverage] 报告已写入 docs/90-代码覆盖度报告.md`)
} catch (e) {
  console.error(`[check-coverage] 报告写入失败：${String(e)}`)
}

// strict 模式：缺口即失败
if (STRICT) {
  const gaps: string[] = []
  if (summary.channels.missingInMain.length > 0) gaps.push(`主进程缺少 ${summary.channels.missingInMain.length} 个通道`)
  if (summary.codes.total !== summary.codes.registeredInSegments) gaps.push('消息表与段号表不一致')
  const missingDomains = domainStatus.filter(d => !d.ok)
  if (missingDomains.length > 0) gaps.push(`功能域完全缺失：${missingDomains.map(d => d.label).join(', ')}`)
  if (gaps.length > 0) {
    console.error(`[check-coverage] strict 模式未通过：\n${gaps.map(g => `  · ${g}`).join('\n')}`)
    process.exit(1)
  }
  console.log('[check-coverage] strict 模式通过 ✓')
}
