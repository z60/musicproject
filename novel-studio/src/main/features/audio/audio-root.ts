/**
 * Novel Studio · 音频路径基准（主进程侧）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §2 「数据库里只存相对于 `projects/{projectId}/` 的路径」
 *   · docs/02 §3 `ns-media://{projectId}/{relPath}` 必须落在项目目录内
 *
 * 库里的路径（`takes/x/y.wav`、`segments/x.wav`、`recordings/x.wav`）**不是**相对
 * `projectRoot`（`{userData}/projects`），而是相对 `projectRoot/{projectId}`。
 * 这里只做这一件事，并把它做成一个可被测试钉住的纯函数：
 * 拼错基准的后果是「主进程自己读写得到、渲染进程播放 404」这类半通不通的故障。
 */

import { join } from 'node:path'

/** `{projectRoot}/{projectId}`：库内相对路径的基准目录（绝对路径） */
export function projectAudioRoot(projectRoot: string, projectId: string): string {
  return join(projectRoot, projectId)
}
