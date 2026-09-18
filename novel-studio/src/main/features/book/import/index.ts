/**
 * Novel Studio · 书籍导入功能域（docs/10）
 * ============================================================================
 * 对外出口（主进程 IPC handler / 任务队列只从这里 import）：
 *   · book.service.ts   —— **把纯逻辑接到真实环境的那一层**（SQLite 仓储 / iconv-lite /
 *                          真实文件系统 / 任务队列）。IPC handler 直接用这个。
 *   · import.service.ts —— 八步管线编排（探测→读取→解码→清洗→分章→预览→入库）
 *   · parsers/          —— txt / plain / docx / pdf / web 解析器与文件探测分发
 *   · repositories/     —— 仓储：接口 + 内存实现（测试）+ SQLite 实现（生产）
 *
 * 分层：`import.service.ts` 是零 Electron、零 SQLite 的纯逻辑（可在测试里直接跑）；
 * `book.service.ts` 负责注入真实依赖。两者的边界是 `ImportDeps`。
 *
 * 渲染进程需要的那部分纯逻辑（编码/清洗/分章/引号/切句）在
 * `src/shared/text/`，主进程与渲染进程都可直接 import。
 */

export * from './import.service.ts'
export * from './parsers/index.ts'
export * from './repositories/book.repo.ts'
export * from './repositories/chapter.repo.ts'
export * from './repositories/mappers.ts'
export * from './repositories/project.repo.ts'
export * from './repositories/book.repo.sqlite.ts'
export * from './repositories/chapter.repo.sqlite.ts'
export * from './book.service.ts'
