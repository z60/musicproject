/**
 * Novel Studio · 把别名加载器注册进 Node 的模块解析
 * ============================================================================
 * 为什么单独一个文件：`--import` 只接受「模块」，而模块解析钩子必须通过
 * `module.register()` 显式注册（旧写法 `--experimental-loader` 已废弃）。
 * 于是拆成两半：
 *   · `test-alias-loader.mjs` —— 纯钩子实现（导出 `resolve`，无副作用，可被单测直接调用）
 *   · 本文件 —— 只负责把它注册进去
 * 使用：Worker 的 `execArgv` 加 `--import ./scripts/test-alias-register.mjs`。
 */

import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

register(pathToFileURL(fileURLToPath(new URL('./test-alias-loader.mjs', import.meta.url))).href)
