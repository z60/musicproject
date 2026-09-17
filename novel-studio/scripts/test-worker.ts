/**
 * Novel Studio · 测试 Worker 引导（在独立线程里跑一个测试文件）
 * ============================================================================
 * 为什么需要它：
 *   测试文件之间会通过**模块级状态**互相污染（单例、缓存、全局态），表现为
 *   「单独跑都过、一起跑有少数失败」。解决办法是让每个测试文件拥有**独立的
 *   模块注册表**。
 *
 *   本项目的开发环境**禁止 spawn 子进程**（`spawnSync ... EPERM`），
 *   因此官方的 `node --test`（它 fork 子进程）在这里不可用；
 *   而 **Worker 线程可用** —— Worker 拥有独立模块注册表，等价于隔离，
 *   且在没有沙箱限制的机器上同样有效。
 *
 * 数字来源：在 Worker 内接管 `process.stdout` 捕获 node:test 的 TAP 报告。
 *   不在父进程接管是为了让**每个文件独立**，互不干扰。
 *
 * ### 一个必须记录的坑：固定等待时间会**静默少算用例**
 *   捕获是异步的：`await import(file)` 只等到「测试已注册」，之后 node:test 才
 *   逐个跑用例并把 TAP 写进被替换的 stdout。早期版本在这里 `setTimeout(150)` 一把，
 *   然后用正则从已捕获的文本里找 `# pass N`。
 *   但用例数多的文件（canvas-quality、queue…）在 150ms 内**还没写完汇总行**，
 *   于是 `# pass` 匹配不到，代码退化成「数 `ok <n> -` 行」。
 *   而嵌套 `describe` 的 ok 行数 ≠ 用例数（子测试记账方式不同），
 *   结果是**总数在 1333 / 1347 / 1351 之间漂移** —— 每次跑都不一样，且都报「全通过」。
 *
 *   这是最危险的一类缺陷：**数字不可信，却看起来一切正常**。
 *   现在的做法是**轮询等待汇总行**（而不是固定等待），并且
 *   一旦超时仍没拿到汇总行，就明确标记 `summaryFound: false`，
 *   由 `run-tests.ts` 报成失败 —— 宁可响，不可静默错。
 *
 * 用法：new Worker(本文件, { workerData: { file } })
 */

import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

interface WorkerData {
  file: string
}

const { file } = workerData as WorkerData

/** TAP 汇总行出现前的最长轮询时间（单文件；超过就判定捕获不完整） */
const SUMMARY_WAIT_TIMEOUT_MS = 15_000
const SUMMARY_POLL_INTERVAL_MS = 20

const chunks: string[] = []
const origOut = process.stdout.write.bind(process.stdout)
const origErr = process.stderr.write.bind(process.stderr)
const capture = (chunk: unknown): boolean => {
  chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
  return true
}

const text = (): string => chunks.join('')

let loadError: string | null = null
try {
  process.stdout.write = capture as typeof process.stdout.write
  process.stderr.write = capture as typeof process.stderr
  await import(pathToFileURL(file).href)
} catch (e) {
  loadError = e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : String(e)
}

// ── 轮询等待 node:test 写完全部 TAP（含 `# pass` 汇总行）──────────────────
let summaryFound = false
if (loadError === null) {
  const deadline = Date.now() + SUMMARY_WAIT_TIMEOUT_MS
  for (;;) {
    // TAP 的 summary 一定同时带 `# pass` 与 `# fail`，两个都出现才算写完
    if (/# pass \d+/.test(text()) && /# fail \d+/.test(text())) {
      summaryFound = true
      break
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, SUMMARY_POLL_INTERVAL_MS))
  }
}

// 还原 stdout/stderr 要在**读完之后**，否则最后几段可能落在还原之后丢失
const captured = text()
process.stdout.write = origOut
process.stderr.write = origErr

let passed = 0
let failed = 0
let skipped = 0
const failures: string[] = []

for (const line of captured.split(/\r?\n/)) {
  const notOk = /^\s*not ok \d+ - (.+?)\s*$/.exec(line)
  if (notOk) {
    failed++
    failures.push(notOk[1])
    continue
  }
  const ok = /^\s*ok \d+ - (.+?)(\s+#\s+(SKIP|TODO))?\s*$/.exec(line)
  if (ok) {
    if (ok[3] === 'SKIP') skipped++
    else passed++
  }
}

// TAP 的汇总行更权威（含嵌套子测试），拿到就用它覆盖「数 ok 行」的估算
const sp = /# pass (\d+)/.exec(captured)
const sf = /# fail (\d+)/.exec(captured)
const ss = /# skipped (\d+)/.exec(captured)
if (sp) passed = Number(sp[1])
if (sf) failed = Number(sf[1])
if (ss) skipped = Number(ss[1])

// 没拿到汇总行 = 用例数不可信。明确标记，让上层报错而不是报一个漂移的数字。
if (loadError === null && !summaryFound) {
  loadError = `测试报告不完整：${SUMMARY_WAIT_TIMEOUT_MS}ms 内未出现 TAP 汇总行（# pass / # fail）`
}

parentPort?.postMessage({
  passed,
  failed,
  skipped,
  failures: failures.slice(0, 80),
  loadError,
  summaryFound,
})
