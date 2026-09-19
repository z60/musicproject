/**
 * Novel Studio · 开发期「模块没同步」提示
 * ============================================================================
 * 设计依据：docs/91 §5.2.16（真机/开发机反馈：新增文件与新增 import 之后，
 *           Vite 热更新把「用了新函数」的组件推给了浏览器，却没有把新模块一并推过去，
 *           于是页面报 `ReferenceError: xxx is not defined`）
 *
 * ### 为什么值得单独一个纯函数
 *   这类报错的**表现**和「代码里写错了变量名」一模一样，但处置完全不同：
 *   · 热更新没同步 → 刷新页面就好，**代码没问题**（生产构建也正常）
 *   · 真的少写了 import / 拼错名字 → 刷新也不会好，是代码问题
 *   两者只能靠「刷新后是否复现」区分，所以提示里必须把这两句话都写清楚。
 *
 * ### 刻意**不**包含 TDZ（`Cannot access 'x' before initialization`）
 *   那是**真实的代码缺陷**（`watch{immediate}` 引用了后面声明的 const，见 docs/91 §5.2.13），
 *   现在由 `npm run check:setup-order` 静态拦截。把它归到「刷新一下就好」会掩盖真 bug。
 */

export interface StaleModuleHintInput {
  /** 错误消息（`err.message`） */
  message: string
  /** 是否开发模式（生产构建里这些提示一律不出现） */
  isDev: boolean
}

/** 只在「模块解析/绑定失败」这类**热更新特征**上报错时才给提示 */
const STALE_MODULE_PATTERNS: readonly RegExp[] = [
  /\bis not defined\b/i, // 用了没进作用域的标识符（漏 import / 模块没同步）
  /does not provide an export named/i, // ESM 绑定失败
  /failed to fetch dynamically imported module/i, // 动态 import 拿不到模块
  /the requested module .* does not provide/i,
]

export function staleModuleHint(input: StaleModuleHintInput): string | null {
  if (!input?.isDev) return null
  const message = input.message ?? ''
  if (!STALE_MODULE_PATTERNS.some((p) => p.test(message))) return null
  return [
    '开发模式提示：这多半是 Vite 热更新没有同步（新增了文件 / 新增了 import / 改了 <script setup> 之后常见）。',
    '先按「刷新页面」（Ctrl+R）—— 通常立刻恢复，说明代码本身没问题。',
    '若刷新后仍然报同样的错，那才是代码问题（漏 import 或写错了名字），请把这条消息连同上面的编号一起反馈。',
  ].join('')
}
