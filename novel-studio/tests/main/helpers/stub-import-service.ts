/**
 * 测试辅助 · `AudioHandlerDeps.importService` 的哑实现
 * ============================================================================
 * 为什么需要它：
 *   `createAudioHandlers` 的依赖里新增了「按说话人导入音频」的服务
 *   （`AudioImportService`）。录音/取/设备这几个域的测试**不关心**它，
 *   但类型上必须提供 —— 于是共用一个哑实现，避免三个测试文件各写一份
 *   （那样任何签名变化都要改三处）。
 *
 * ⚠️ 它是**哑的**：所有方法都抛错，而不是返回空数据。
 *   理由与 `handlers/placeholders.ts` 同一纪律 ——
 *   「返回空数组」会让「忘了注入真实现」表现成「功能正常但永远没有数据」，
 *   而抛错会立刻暴露。这些测试不会调用它，所以抛错不会有副作用。
 */

import type { AudioImportService } from '../../../src/main/features/audio/import.service.ts'

export function createStubAudioImportService(): AudioImportService {
  const notWired = (): never => {
    throw new Error('测试用哑实现：AudioImportService 未被这些用例使用')
  }
  return {
    scanCanvas: notWired,
    scanAudioFiles: notWired,
    buildPlan: notWired,
    applyImport: notWired,
  }
}
