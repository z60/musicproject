/**
 * Novel Studio · 项目包 / 任务包（.nsp / .nst）对外出口
 * ============================================================================
 * 设计依据：docs/03 §8 §9、docs/11 §6
 *
 * 文件职责：
 *   manifest.ts    格式版本、manifest 构造与校验、内容清单预设、体积预估
 *   zip/reader.ts  **纯 Node ZIP 读取**（EOCD → 中央目录 → inflate）+ 解压防护
 *   zip/writer.ts  ZipWriter 接口 + archiver 生产适配 + 可用的 store 实现
 *   checksums.ts   逐文件 sha256 生成与校验（不匹配则跳过并列报告，绝不整体失败）
 *   wav.ts         WAV 头解析（回传音频的损坏/格式合规判定）
 *   nst.ts         任务包构造（buildNstLine / computeLinesHash / 导出编排 / 解析）
 *   merge.ts       回收合并（linesHash 差异 + 按 lineId 归位 + 去重 + 报告）
 *   nsp.ts         项目包导出/导入编排（contents 选项 + ID 重映射 + id_map）
 *
 * 依赖纪律：本目录只依赖 `node:*` 内置模块与 `src/shared/**`，
 * 不 import archiver / yauzl / better-sqlite3 等第三方包（一律注入式）。
 */

export * from './manifest.ts'
export * from './checksums.ts'
export * from './wav.ts'
export * from './zip/reader.ts'
export * from './zip/writer.ts'
export * from './nst.ts'
export * from './merge.ts'
export * from './nsp.ts'
