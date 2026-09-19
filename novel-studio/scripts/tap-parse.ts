/**
 * Novel Studio · TAP 结果解析（供测试运行器统计用例数）
 * ============================================================================
 * 为什么要有这个文件（而不是把解析写进 Worker 引导里）：
 *   这段逻辑是「用例数是否可信」的唯一依据，必须**能被单元测试直接调用**。
 *   Worker 引导脚本在模块顶层读 `workerData`，无法在普通进程里 import，
 *   因此把纯函数拆到这里，由 `tests/main/tap-parse.test.ts` 覆盖。
 *
 * ### 为什么不用 TAP 汇总行来数用例，但**要用它来判断「跑完了」**
 *   数用例仍然逐行分类（见下）：汇总行的 `# pass N` 在本环境里**抓得到**，
 *   但早期误判成「抓不到」，于是收工条件只能靠「静默」，连踩两个坑
 *   （先偶发「测试结果为空」，后**静默少算用例**，见 docs/91 §5.2.31 / §5.2.34）。
 *   现在：`sawSummary` 是「这个文件真的跑完了」的判据，缺了它整轮判失败（宁可响，不可静默少算）。
 *
 *   而 `node --test` 需要 fork 子进程（`spawn EPERM`），`run()` 不带参会把仓库里
 *   所有测试文件都 spawn 一遍（实测 42 个 `test:fail`，全是 `spawn EPERM`）。
 *
 * ### 做法：逐行分类，不猜
 *   TAP 里每条结果后面紧跟一段 YAML 诊断块，`type:` 字段明确区分**用例**与**套件**：
 *
 *     ok 1 - 引号族标签与字符表齐备
 *       ---
 *       type: 'test'      ← 用例
 *       ...
 *
 *     ok 1 - 引号族（constants.QUOTE_PAIRS）
 *       ---
 *       type: 'suite'     ← describe 块，不是用例（**早期把它也算成用例，总数虚高**
 *                            并且数量随运行漂移 —— 见 docs/91 §5）
 *       ...
 *
 *   由此「用例数」= 结果行里 `type !== 'suite'` 的条数，完全确定：
 *   不需要等待、不受机器快慢影响、不会一次一个数。
 *
 * ### 纪律
 *   任何一条结果**无法分类**（缺 `type:`）都不许静默放过 —— 那会让计数悄悄变少。
 *   解析器把它记进 `unclassified`，由调用方判失败。
 */

/** TAP 里的一条结果行 */
export interface TapEntry {
  status: 'ok' | 'not ok'
  name: string
  /** 诊断块里的 `type:`；`null` = 没找到（会被列入 unclassified） */
  type: string | null
  /** `# SKIP` / `# TODO` 指令 */
  directive: 'SKIP' | 'TODO' | null
}

export interface TapParseResult {
  entries: TapEntry[]
  /** 无法判断是用例还是套件的原始行（非空即代表计数不可信） */
  unclassified: string[]
  /** 文本里是否出现汇总行（`# pass N` / `# tests N`）—— 出现即代表这个文件跑完了 */
  sawSummary: boolean
  /** 判定为套件（describe）的条数 */
  suites: number
  /** 判定为用例且没有 SKIP/TODO 的条数 */
  tests: number
  /** 用例里带 SKIP/TODO 的条数 */
  skipped: number
  /** 失败用例名 */
  failures: string[]
}

/** 下一条结果行 / 子计划行 —— 诊断块的边界 */
const NEXT_RESULT = /^\s*(not ok|ok) \d+ - /
const SUBPLAN = /^\s*1\.\.\d+\s*$/
const TYPE_LINE = /^\s*type:\s*'?([A-Za-z]+)'?\s*$/
const BLOCK_END = /^\s*\.\.\.\s*$/

/** 解析一份 TAP 文本，按 `type:` 把结果行分成用例与套件 */
export function parseTap(text: string): TapParseResult {
  const lines = text.split(/\r?\n/)
  const entries: TapEntry[] = []
  const unclassified: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^\s*(not ok|ok) \d+ - (.*)$/.exec(line)
    if (!m) continue

    const status: TapEntry['status'] = m[1] === 'ok' ? 'ok' : 'not ok'
    let rest = m[2]!

    let directive: TapEntry['directive'] = null
    const dir = /\s+#\s+(SKIP|TODO)\b/i.exec(rest)
    if (dir) {
      directive = dir[1]!.toUpperCase() as 'SKIP' | 'TODO'
      rest = rest.slice(0, dir.index)
    }

    // 往下找本条结果的诊断块（遇到下一条结果行 / 子计划行就停）
    let type: string | null = null
    let sawBlockEnd = false
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!
      if (NEXT_RESULT.test(next) || SUBPLAN.test(next)) break
      const t = TYPE_LINE.exec(next)
      if (t) {
        type = t[1]!
        break
      }
      if (BLOCK_END.test(next)) {
        sawBlockEnd = true
        break
      }
    }
    void sawBlockEnd

    if (type === null) unclassified.push(line.trim())
    entries.push({ status, name: rest.trim(), type, directive })
  }

  let suites = 0
  let tests = 0
  let skipped = 0
  const failures: string[] = []

  for (const e of entries) {
    if (e.type === 'suite') {
      suites++
      continue
    }
    if (e.type !== 'test') {
      // 未分类（type 缺失）：**不计入任何一类**。
      // 调用方会因为 unclassified 非空而判整轮失败；在这里把它算成「通过用例」
      // 只会给出一个偏大的漂亮数字 —— 那正是我们要避免的。
      continue
    }
    if (e.status === 'not ok') {
      failures.push(e.name)
      continue
    }
    if (e.directive === 'SKIP' || e.directive === 'TODO') skipped++
    else tests++
  }

  return {
    entries,
    unclassified,
    sawSummary: /^#\s*(?:pass|fail|tests)\s+\d+\s*$/m.test(text),
    suites,
    tests,
    skipped,
    failures,
  }
}
