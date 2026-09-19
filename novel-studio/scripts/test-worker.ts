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
 * ### 这个脚本现在只做一件事：import 那个文件
 * ============================================================================
 * 用例数、加载失败、是否跑完，**全部由父线程（`scripts/run-tests.ts`）判断** ——
 * 因为它才拿得到完整的 TAP 文本。
 *
 * #### 为什么不在 Worker 里数（两次踩坑的完整记录，别再改回来）
 *
 * ① 最早在 Worker 里替换 `process.stdout.write` 抓 TAP 文本，靠「静默 250ms」收工。
 *    **静默 ≠ 跑完**：用例里任何一次非 TAP 输出（典型：第一次用 `node:sqlite` 时 Node
 *    写的实验性警告）都会重置计时，于是「写了警告 → 这个用例还要跑 250ms 以上 →
 *    一行 TAP 都还没写」时 Worker 带着**空结果**收工，整轮报「测试结果为空」。
 *    真机表现：`tests/main/package-service.test.ts` 单跑 20/20、全量跑偶发加载失败
 *    （docs/91 §5.2.31）。
 *
 * ② 改成「静默 + 已解析出结果且没有无法分类的行」——不再空手而归，却**悄悄少算用例**：
 *    两条结果之间只要隔了 250ms（慢用例、满负载），Worker 就会收工。
 *    实测 `package-service.test.ts` 报过 `pass 1`（真实 20）**却仍算整轮通过** ——
 *    比偶发失败更危险（静默少算 + 看起来一切正常，docs/91 §5.2.34）。
 *
 * ③ 试过「等 TAP 汇总行（`# pass N`）」。汇总行**确实存在**，但它不经过被替换的
 *    `process.stdout.write`（实测：结果行全都在捕获文本里，`# tests N / # pass N`
 *    一条都没有；换成长轮询/短轮询都一样）。在 Worker 内部替换 stdout 这条路，
 *    注定拿不到「跑完了」的权威标记。
 *
 * #### 现在的分工
 *   · Worker：`await import(file)`，然后什么都不做（测试跑完、事件循环空转，线程自然结束）
 *   · 父线程：把 Worker 的 stdout/stderr **收进自己的缓冲**（`stdout: true`），
 *     在其中找 TAP 汇总行 —— 它由报告器写在**根套件跑完之后**，所以
 *     「看到汇总行」= 这个文件真的跑完了；数用例仍然走 `parseTap` 的逐行分类。
 *
 * 用法：new Worker(本文件, { workerData: { file }, stdout: true, stderr: true })
 */

import { workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

interface WorkerData {
  file: string
}

const { file } = workerData as WorkerData

await import(pathToFileURL(file).href)
