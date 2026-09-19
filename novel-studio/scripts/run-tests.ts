/**
 * Novel Studio · 全量测试运行器（Worker 隔离版）
 * ============================================================================
 * 设计依据：docs/22 §10、docs/30 §6.1
 *
 * ### 为什么用 Worker 线程，而不是子进程 / 同进程
 *   · **同进程**：测试文件之间通过模块级状态互相污染（单例、缓存、全局态），
 *     表现为「单独跑都过、一起跑有少数失败」，且失败项随加载顺序漂移。
 *   · **子进程**：本项目的开发环境禁止 spawn（`spawnSync ... EPERM`），
 *     官方的 `node --test`（内部 fork 子进程）在这里不可用。
 *   · **Worker 线程**：每个 Worker 有**独立的模块注册表**，等价于文件级隔离，
 *     且在无沙箱限制的机器上同样有效 —— 实测可用。
 *
 * 每个 Worker 跑一个测试文件（见 scripts/test-worker.ts），结果通过 postMessage 回传。
 *
 * 用法：
 *   node --experimental-strip-types scripts/run-tests.ts
 *   node --experimental-strip-types scripts/run-tests.ts --filter canvas
 *   node --experimental-strip-types scripts/run-tests.ts --verbose
 *   node --experimental-strip-types scripts/run-tests.ts --no-isolation   # 同进程（排障用）
 *
 * 退出码：0 = 全部通过；1 = 有失败或加载失败
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import { parseTap } from './tap-parse.ts'

const ROOT = process.cwd()
const VERBOSE = process.argv.includes('--verbose')
const NO_ISOLATION = process.argv.includes('--no-isolation')
const filterIdx = process.argv.indexOf('--filter')
const FILTER = filterIdx >= 0 ? process.argv[filterIdx + 1] : undefined

/** 单个文件的墙钟超时（防止某个死循环挂住整轮） */
const FILE_TIMEOUT_MS = 120_000

/**
 * TAP 汇总行（`# pass N` / `# tests N`）—— 报告器把它写在**根套件跑完之后**，
 * 所以「看到它」就等于「这个文件跑完了」。它只走 Worker 的真实 stdout（fd 1），
 * 走不到被替换的 `process.stdout.write`，因此必须由父线程收流才能看到（见 test-worker.ts）。
 */
const TAP_SUMMARY = /^#\s*(?:pass|fail|tests)\s+\d+\s*$/m
/** 看到汇总行后再等一小会儿，让尾部文本（`# suites N` 等）落定 */
const QUIET_AFTER_SUMMARY_MS = 120

// ---------------------------------------------------------------------------
// 收集
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
    else if (name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

function collect(): string[] {
  const all = [...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'src'))].sort()
  if (!FILTER) return all
  const needle = FILTER.toLowerCase().replace(/\\/g, '/')
  return all.filter(f => relative(ROOT, f).replace(/\\/g, '/').toLowerCase().includes(needle))
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

interface FileResult {
  file: string
  passed: number
  failed: number
  skipped: number
  durationMs: number
  failures: string[]
  loadError: string | null
  /** TAP 汇总行是否拿到（false = passed 数字不可信） */
  summaryFound: boolean
}

// ---------------------------------------------------------------------------
// 隔离执行：一个文件一个 Worker
// ---------------------------------------------------------------------------

/**
 * 隔离执行：一个文件一个 Worker。
 *
 * ### 谁来判断「跑完了 / 跑了多少」
 * Worker 只负责 `import` 那个文件；**TAP 文本由本函数收**（`stdout: true` / `stderr: true`
 * 把 Worker 的输出接成流，而不是让它直接污染本轮输出）。
 *
 * 这样做的原因见 `test-worker.ts` 顶部的三次踩坑记录 —— 一句话：
 * **TAP 汇总行（`# pass N`）不经过被替换的 `process.stdout.write`**，
 * 所以只有在「父线程收流」这条路上才拿得到它；而它正是「这个文件真的跑完了」的权威标记。
 *
 * 收工顺序：
 *   ① 流里出现汇总行 → 再等 `QUIET_AFTER_SUMMARY_MS` 让尾部文本落定 → 解析并收工；
 *   ② Worker 自然退出（测试跑完、事件循环空转）→ 用已收到的文本解析；
 *   ③ 超时 → 报「文件超时」，绝不静默当作通过。
 */
function runFileIsolated(file: string): Promise<FileResult> {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const started = Date.now()

  return new Promise<FileResult>(resolve => {
    let settled = false
    /** 该文件从 Worker 收到的全部 stdout/stderr 文本 */
    let text = ''
    let summaryTimer: NodeJS.Timeout | null = null

    const settleFromText = (forced: Partial<FileResult> = {}): void => {
      const parsed = parseTap(text)
      let loadError: string | null = forced.loadError ?? null
      if (loadError === null) {
        if (!parsed.sawSummary) {
          /**
           * **没有汇总行 = 没跑完**（崩溃、被掐断、或输出被吞）→ 计数不可信，明确失败。
           * 少算的用例不会让任何断言失败，所以必须在这里拦住（docs/91 §5.2.34）。
           */
          loadError =
            `没有拿到 TAP 汇总行（# pass N）：这个文件可能没跑完，用例数不可信。` +
            `已解析到 ${parsed.tests} 个用例`
        } else if (parsed.entries.length === 0) {
          loadError = '测试结果为空：没有解析到任何 TAP 结果行'
        } else if (parsed.unclassified.length > 0) {
          // 无法判断是用例还是套件 → 计数必然不准。明确失败，不静默放行。
          loadError =
            `有 ${parsed.unclassified.length} 条 TAP 结果无法分类（缺少 type 字段），用例数不可信。` +
            `首条：${parsed.unclassified[0]!.slice(0, 120)}`
        }
      }
      finish({
        passed: parsed.tests,
        failed: parsed.failures.length,
        skipped: parsed.skipped,
        failures: parsed.failures.slice(0, 80),
        loadError,
        // 「可信」= 拿到汇总行（跑完了）+ 每条结果都分好类
        summaryFound: loadError === null && parsed.sawSummary && parsed.unclassified.length === 0,
        ...forced,
      })
    }

    const finish = (r: Omit<FileResult, 'file' | 'durationMs'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (summaryTimer) clearTimeout(summaryTimer)
      void worker.terminate()
      resolve({ file: rel, durationMs: Date.now() - started, ...r })
    }

    // 注意：Worker 的 filename 必须是绝对路径或 './' 开头的相对路径；
    // 传 `file://` 字符串会抛 ERR_WORKER_PATH（要传 URL 对象才行）。
    const worker = new Worker(join(ROOT, 'scripts/test-worker.ts'), {
      workerData: { file },
      // 让 Worker 能直接跑 .ts（类型剥离）
      execArgv: ['--experimental-strip-types'],
      // 输出接到父线程的流里：TAP 文本（含汇总行）由这里解析，不污染本轮输出
      stdout: true,
      stderr: true,
    })

    const onChunk = (chunk: Buffer | string): void => {
      text += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (summaryTimer !== null || !TAP_SUMMARY.test(text)) return
      // 汇总行已出现 = 根套件跑完；再等一小会儿让尾部文本落定，然后收工
      summaryTimer = setTimeout(() => settleFromText(), QUIET_AFTER_SUMMARY_MS)
    }
    worker.stdout?.on('data', onChunk)
    worker.stderr?.on('data', onChunk)

    const timer = setTimeout(() => {
      finish({
        passed: 0,
        failed: 1,
        skipped: 0,
        failures: [`文件超时（${FILE_TIMEOUT_MS}ms）`],
        loadError: null,
        summaryFound: false,
      })
    }, FILE_TIMEOUT_MS)

    worker.on('error', (e: Error) => {
      finish({
        passed: 0,
        failed: 1,
        skipped: 0,
        failures: [],
        loadError: `${e.name}: ${e.message.split('\n')[0]}`,
        summaryFound: false,
      })
    })
    worker.on('exit', code => {
      // 正常跑完的 Worker 会在测试结束后自然退出（**有用例失败时退出码也是 1**，
      // 那是 TAP 里的事，不是夹具故障）：只要拿到了汇总行，就按 TAP 结算。
      if (TAP_SUMMARY.test(text)) {
        settleFromText()
        return
      }
      finish({
        passed: 0,
        failed: 1,
        skipped: 0,
        failures: [`Worker 异常退出（code ${code}），且没有拿到 TAP 汇总行`],
        loadError: `Worker 退出码 ${code}`,
        summaryFound: false,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 非隔离执行（保留用于排障对比）
// ---------------------------------------------------------------------------

async function runFileInProcess(file: string): Promise<FileResult> {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const started = Date.now()
  const chunks: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  const capture = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }
  let loadError: string | null = null
  try {
    process.stdout.write = capture as typeof process.stdout.write
    process.stderr.write = capture as typeof process.stderr.write
    await import(pathToFileURL(file).href)
    await new Promise(resolve => setTimeout(resolve, 80))
  } catch (e) {
    loadError = e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : String(e)
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  const text = chunks.join('')
  const failures: string[] = []
  let passed = 0
  let failed = 0
  for (const line of text.split(/\r?\n/)) {
    const notOk = /^\s*not ok \d+ - (.+?)\s*$/.exec(line)
    if (notOk) { failed++; failures.push(notOk[1]) }
  }
  const sp = /# pass (\d+)/.exec(text)
  const sf = /# fail (\d+)/.exec(text)
  if (sp) passed = Number(sp[1])
  if (sf) failed = Number(sf[1])
  return {
    file: rel,
    passed,
    failed,
    skipped: 0,
    durationMs: Date.now() - started,
    failures,
    loadError,
    summaryFound: sp !== null && sf !== null,
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const files = collect()
if (files.length === 0) {
  console.error(`[run-tests] 没有找到测试文件（tests|src 下的 *.test.ts）${FILTER ? `（过滤：${FILTER}）` : ''}`)
  process.exit(1)
}

console.log(
  `[run-tests] ${files.length} 个测试文件　` +
  `隔离方式：${NO_ISOLATION ? '同进程（--no-isolation）' : 'Worker 线程（每文件独立模块表）'}` +
  `${FILTER ? `　过滤：${FILTER}` : ''}`,
)
console.log('')

const results: FileResult[] = []
for (const f of files) {
  const r = NO_ISOLATION ? await runFileInProcess(f) : await runFileIsolated(f)
  results.push(r)
  const bad = r.failed > 0 || r.loadError !== null
  console.log(
    `  ${bad ? '✗' : '✓'} ${r.file.padEnd(44)} ` +
    `pass ${String(r.passed).padStart(4)}  fail ${String(r.failed).padStart(2)}  ${String(r.durationMs).padStart(6)}ms` +
    (bad || r.summaryFound ? '' : '  ⚠ 报告不完整'),
  )
  if (r.loadError) console.log(`      LOAD ERROR: ${r.loadError}`)
  if (bad && r.failures.length > 0) {
    const show = VERBOSE ? r.failures : r.failures.slice(0, 6)
    for (const f2 of show) console.log(`      · ${f2}`)
    if (!VERBOSE && r.failures.length > 6) console.log(`      · …还有 ${r.failures.length - 6} 项（--verbose 看全部）`)
  }
}

const failedFiles = results.filter(r => r.failed > 0 || r.loadError !== null)
const totalPass = results.reduce((s, r) => s + r.passed, 0)
const totalFail = results.reduce((s, r) => s + r.failed, 0)
const totalSkip = results.reduce((s, r) => s + r.skipped, 0)
const elapsed = results.reduce((s, r) => s + r.durationMs, 0)

// 用例总数只有在**每个文件都拿到 TAP 汇总行**时才可信。
// 少算的用例不会让任何断言失败，所以必须单独拦一道（见 test-worker.ts 的说明）。
const incomplete = results.filter(r => !r.summaryFound)

console.log('')
console.log('='.repeat(78))
console.log(
  `[run-tests] 文件 ${results.length} | 通过 ${results.length - failedFiles.length}` +
  ` | 用例 pass ${totalPass} / fail ${totalFail} / skip ${totalSkip} | 合计 ${elapsed}ms`,
)
if (incomplete.length > 0) {
  console.error(
    `[run-tests] ⚠ ${incomplete.length} 个文件的用例数不完整（未拿到 TAP 汇总行）：`,
  )
  for (const r of incomplete) console.error(`  ⚠ ${r.file}`)
  console.error('[run-tests] 上面的 pass 总数**不可信**，请当作失败处理并排查报告捕获。')
}

// 失败文件与「报告不完整」都算失败：后者不会让任何断言失败，
// 却会让上面那个 pass 总数悄悄变少（这正是它值得拦一道的原因）。
if (failedFiles.length > 0 || incomplete.length > 0) {
  if (failedFiles.length > 0) {
    console.error(`[run-tests] 未通过的文件 ${failedFiles.length} 个：`)
    for (const r of failedFiles) {
      console.error(`  ✗ ${r.file}${r.loadError ? '  (加载失败)' : `  (${r.failed} 项)`}`)
    }
  }
  console.log('='.repeat(78))
  process.exit(1)
}

console.log(`[run-tests] 全部通过 ✓（${results.length} 个文件的 TAP 结果全部成功分类，用例总数可信）`)
console.log('='.repeat(78))
