/**
 * Novel Studio · 书籍导入功能域（docs/10）
 * ============================================================================
 * 对外出口（主进程 IPC handler / 任务队列只从这里 import）：
 *   · import.service.ts —— 八步管线编排（含取消、事务入库、去重）
 *   · parsers/          —— txt / plain / docx / pdf / web 解析器与文件探测分发
 *   · repositories/     —— 书籍与章节仓库接口 + 内存实现（生产实现由 infra 注入）
 *
 * 渲染进程需要的那部分纯逻辑（编码/清洗/分章/引号/切句）在
 * `src/shared/text/`，主进程与渲染进程都可直接 import。
 */

export * from './import.service.ts'
export * from './parsers/index.ts'
export * from './repositories/book.repo.ts'
export * from './repositories/chapter.repo.ts'
