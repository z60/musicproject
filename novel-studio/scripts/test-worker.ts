/**
 * Novel Studio · 测试 Worker 引导（在独立线程里跑一个测试文件）
 * ============================================================================
 * 为什么需要它：
 *   测试文件之间会通过**模块级状态**互相污染（单例、缓存、全局态），表现为
 *   「单独跑都过、一起跑有少数失败」。解决办法是让每个测试文件拥有**独立的
 *   模块注册表**。
 *
 *   本项目的开发环境**禁止 spawn 子进程**（`spawnSync ... EPERM`），
 *   因此官方的 `node --test`（内部 fork 子进程）在这里不可用；
 *   而 **Worker 线程可用** —— Worker 拥有独立模块注册表，等价于隔离。
 *
 * ============================================================================
 * ### 用例数是怎么数的（这段是本文件最重要的内容，请勿随手改）
 * ============================================================================
 * 「一个测试文件到底跑了多少用例」在这个环境里**没有官方出口**：
 *
 *   · `node --test` → 不可用（要 fork 子进程 → `spawn EPERM`）。
 *   · `run()` 把事件流交给我们：
 *       - `run()` 不带参 → 它按 Node 的默认 glob **把仓库里所有 `*.test.ts` 都 spawn 起来**
 *         （实测 42 个 `test:fail`，错误全是 `spawn EPERM`），等于没用。
 *       - `run({ reporter: 'spec' })` 在 Worker 里 `for await` 拿不到任何 chunk；
 *       - `spec(stream)` 二次转换会挂住（报告器流不 end）；
 *       - 裸 `run()` 发出的是**测试事件对象**，事件里只有单个用例，没有总数。
 *   · 替换 `process.stdout.write` 抓 TAP 文本：能抓到全部 `ok` 行与 `not ok` 行，
 *     但**抓不到汇总行**（`# pass N`）—— 报告器把汇总行写到别处去了
 *     （实测：等到 1 秒静默、或等到进程该退出，捕获文本里依然没有 `# pass`）。
 *
 * ### 因此：不做任何计时猜测，改为**逐行分类**
 *   TAP 里每个 `ok N - 名称` / `not ok N - 名称` 后面紧跟一段 YAML 诊断块，
 *   其中的 `type:` 字段明确区分这条结果是**用例**还是**套件**：
 *
 *     ok 1 - 引号族标签与字符表齐备
 *       ---
 *       type: 'test'      ← 用例
 *       ...
 *
 *     ok 1 - 引号族（constants.QUOTE_PAIRS）
 *       ---
 *       type: 'suite'     ← describe 块，不是用例
 *       ...
 *
 *   于是「数用例」= 逐条 `ok`/`not ok` 判断它是不是 suite，**完全确定**，
 *   不需要等、不需要猜、不会因机器快慢而漂移。
 *
 * ### 这条纪律的来历（别重犯）
 *   早期版本「替换 stdout + `setTimeout(150)` + 只在拿到 `# pass` 时信它」，
 *   导致总数在 1333 / 1347 / 1351 之间**每次跑都不一样**，而每轮都打印「全部通过」。
 *   **静默少算用例 + 看起来一切正常**，是最危险的一类缺陷。
 *   现在：只要出现一条**无法分类**的 `ok` 行，就报 `loadError` 让整轮失败 ——
 *   宁可响，不可静默错。
 *
 * 用法：new Worker(本文件, { workerData: { file } })
 */

import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

import { parseTap } from './tap-parse.ts'

interface WorkerData {
  file: string
}

const { file } = workerData as WorkerData

/** 单个文件的墙钟超时（与 run-tests.ts 的 FILE_TIMEOUT_MS 对齐，留出上报余量） */
const OVERALL_TIMEOUT_MS = 110_000
/** TAP 写完后判定「安静」的阈值；纯属性能优化，不影响计数正确性 */
const QUIET_MS = 250

let loadError: string | null = null
const chunks: string[] = []
const origOut = process.stdout.write.bind(process.stdout)
const origErr = process.stderr.write.bind(process.stderr)

let lastWriteAt = 0
const capture = (chunk: unknown): boolean => {
  chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
  lastWriteAt = Date.now()
  return true
}



try {
  // `process.stderr.write` 的重载签名比 stdout 窄（`WriteStream & { fd: 2 }`），
  // 直接断言成 capture 会被 TS 判为「类型不重叠」（TS2352），必须先经 unknown。
  ;(process as { stdout: { write: unknown } }).stdout.write = capture
  ;(process as { stderr: { write: unknown } }).stderr.write = capture
  await import(pathToFileURL(file).href)

  // 等「安静」：不再有新的 TAP 写入即认为跑完。
  // 这只是为了不截断文本；用例数的正确性由下面的分类保证，与等多久无关。
  const deadline = Date.now() + OVERALL_TIMEOUT_MS
  for (;;) {
    if (lastWriteAt > 0 && Date.now() - lastWriteAt > QUIET_MS) break
    if (Date.now() >= deadline) {
      loadError = `测试运行超时（${OVERALL_TIMEOUT_MS}ms）`
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
} catch (e) {
  loadError = e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : String(e)
} finally {
  ;(process as { stdout: { write: unknown } }).stdout.write = origOut
  ;(process as { stderr: { write: unknown } }).stderr.write = origErr
}

const text = chunks.join('')
const parsed = parseTap(text)

if (loadError === null) {
  if (parsed.entries.length === 0) {
    loadError = '测试结果为空：没有解析到任何 TAP 结果行'
  } else if (parsed.unclassified.length > 0) {
    // 无法判断是用例还是套件 → 计数必然不准。明确失败，不静默放行。
    loadError =
      `有 ${parsed.unclassified.length} 条 TAP 结果无法分类（缺少 type 字段），用例数不可信。` +
      `首条：${parsed.unclassified[0]!.slice(0, 120)}`
  }
}

parentPort?.postMessage({
  passed: parsed.tests,
  failed: parsed.failures.length,
  skipped: parsed.skipped,
  failures: parsed.failures.slice(0, 80),
  loadError,
  // 「可信」= 每条结果都分好类了（与是否拿到汇总行无关，汇总行在本环境抓不到）
  summaryFound: loadError === null && parsed.entries.length > 0 && parsed.unclassified.length === 0,
  suiteCount: parsed.suites,
  sawSummary: parsed.sawSummary,
})
