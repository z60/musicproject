/**
 * Novel Studio · 纯文本处理（零依赖，可被主进程 / 渲染进程 / Node 脚本直接导入）
 * ============================================================================
 * 汇总导出 docs/10（书籍导入）与 docs/11 §2（切句）用到的纯逻辑：
 *   · encoding.ts      编码嗅探与解码（docs/10 §4）
 *   · chapter-split.ts 分章（docs/10 §6）
 *   · clean.ts         清洗（docs/10 §5）
 *   · quote.ts         引号与对白解析（docs/11 §2.2）
 *   · sentence.ts      切句（docs/11 §2.1）
 *
 * 本目录禁止引入任何第三方依赖。
 */

export * from './encoding.ts'
export * from './chapter-split.ts'
export * from './clean.ts'
export * from './quote.ts'
export * from './sentence.ts'
