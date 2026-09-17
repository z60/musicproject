/**
 * 基础设施 · 磁盘空间
 * ============================================================================
 * 设计依据：
 *   · docs/04 §3「磁盘空间：录音前与导出前检查」
 *   · docs/12 §3.3 / constants.ts RECORD_LIMITS.requiredFreeBytes（录音前要求 ≥ 500 MB）
 *   · docs/11「背压：写入跟不上时必须明确告知用户，绝不静默丢帧」
 *
 * 关于 `statfs`：Node 18.15+ 提供 `fs.statfs`（POSIX 与 Windows 均实现），
 * 但**部分受限环境/旧内核会返回 ENOSYS 或没有该函数**。因此这里做了能力探测，
 * 不可用时返回 `{ availableBytes: null, supported: false }`，让调用方决定是
 * 「跳过预检」还是「按最坏情况处理」——**绝不假设还有空间**。
 */

import { promises as fsp } from 'node:fs'
import { AppError, formatBytes, wrapUnknown } from '../../../shared/errors.ts'

export interface FreeSpaceResult {
  /** 可用字节数；探测不可用时为 null */
  availableBytes: number | null
  /** 总字节数；探测不可用时为 null */
  totalBytes: number | null
  /** 平台/环境是否支持探测 */
  supported: boolean
  /** 不支持的说明或探测失败的摘要（进日志，不进 UI） */
  note?: string
}

export interface DiskFormat {
  sampleRate: number
  bitDepth: number
  channels: number
}

/** WAV 头长度（RIFF 44 字节，见 src/shared/constants.ts WAV_HEADER_BYTES） */
export const WAV_HEADER_BYTES = 44

/**
 * 查询目录所在卷的可用空间。
 *
 * @param dir 已存在的目录（不存在的路径会向上回退到最近的存在祖先，避免调用方还要自己处理）
 */
export async function checkFreeSpace(dir: string): Promise<FreeSpaceResult> {
  const statfsFn = (fsp as unknown as { statfs?: (p: string) => Promise<StatfsLike> }).statfs
  if (typeof statfsFn !== 'function') {
    return {
      availableBytes: null,
      totalBytes: null,
      supported: false,
      note: 'Node 未提供 fs.statfs（需要 Node 18.15+）',
    }
  }
  let target = dir
  for (let i = 0; i < 8; i++) {
    try {
      const st = await statfsFn(target)
      // bavail = 非特权用户可用块数（比 bfree 更保守，才是「我能写多少」）
      const blockSize = Number(st.bsize ?? st.blocksize ?? 0)
      const available = Number(st.bavail ?? st.bfree ?? 0) * blockSize
      const total = Number(st.blocks ?? 0) * blockSize
      return { availableBytes: available, totalBytes: total, supported: true }
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // 目录还不存在（首次启动）→ 回退到父目录
        const parent = target.replace(/[\\/][^\\/]*$/, '')
        if (parent === target || parent.length === 0) {
          return { availableBytes: null, totalBytes: null, supported: false, note: `路径不存在：${dir}` }
        }
        target = parent
        continue
      }
      if (code === 'ENOSYS' || code === 'ERR_NOT_IMPLEMENTED' || code === 'EINVAL') {
        return { availableBytes: null, totalBytes: null, supported: false, note: `平台不支持 statfs（${code}）` }
      }
      return { availableBytes: null, totalBytes: null, supported: false, note: `探测失败：${code ?? String(e)}` }
    }
  }
  return { availableBytes: null, totalBytes: null, supported: false, note: '向上查找可用卷超过 8 层，已放弃' }
}

/**
 * 预估录音所需空间。
 *
 * 计算方式：`字节/秒 = sampleRate × channels × (bitDepth / 8)`，
 * 再乘时长加 44 字节头。24-bit 是 3 字节/样本，32-bit float 是 4 字节
 * （与 constants.ts 里的 BYTES_PER_SECOND_* 常量同源）。
 */
export function estimateRecordingBytes(minutes: number, format: DiskFormat): number {
  const seconds = Math.max(0, minutes) * 60
  const bytesPerSecond = bytesPerSecondOf(format)
  return Math.ceil(seconds * bytesPerSecond) + WAV_HEADER_BYTES
}

/** 每秒写入字节数 */
export function bytesPerSecondOf(format: DiskFormat): number {
  return format.sampleRate * format.channels * (format.bitDepth / 8)
}

/**
 * 断言空间足够；不足时抛 `DISK_FULL`（可重试错误，UI 会给出「需释放 X」的明确提示）。
 *
 * `supported: false` 时**不阻断**（无法探测 ≠ 没有空间），只返回跳过标记，
 * 由调用方在日志里留下「未做空间预检」的痕迹。
 */
export async function assertFreeSpace(
  dir: string,
  needBytes: number,
): Promise<{ ok: boolean; checked: boolean; availableBytes: number | null }> {
  const res = await checkFreeSpace(dir)
  if (!res.supported || res.availableBytes === null) {
    return { ok: true, checked: false, availableBytes: null }
  }
  if (res.availableBytes < needBytes) {
    throw new AppError('DISK_FULL', {
      params: { need: formatBytes(needBytes - res.availableBytes) },
      details: { dir, needBytes, availableBytes: res.availableBytes },
    })
  }
  return { ok: true, checked: true, availableBytes: res.availableBytes }
}

/** 确保目录存在（幂等） */
export async function ensureDir(dir: string): Promise<string> {
  try {
    await fsp.mkdir(dir, { recursive: true })
    return dir
  } catch (e) {
    throw wrapUnknown(e)
  }
}

interface StatfsLike {
  bsize?: number
  blocksize?: number
  blocks?: number | bigint
  bfree?: number | bigint
  bavail?: number | bigint
}
