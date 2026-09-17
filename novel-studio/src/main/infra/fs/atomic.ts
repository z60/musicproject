/**
 * 基础设施 · 原子写与临时目录
 * ============================================================================
 * 设计依据：
 *   · docs/04 §3「原子写：写 .tmp → fsync → rename（同盘 rename 才原子）」
 *   · docs/04 §3「withTempDir(projectId, prefix, fn)：保证异常时也清理」
 *   · docs/04 §3「safeRemove：拒绝删除项目根、模型目录、数据库」
 *   · docs/01 §10「5 崩溃恢复必须在 6 清理之前」——本模块只提供动作，
 *     顺序由 bootstrap/app-lifecycle.ts 保证
 *
 * 铁律：**写文件失败绝不能留下半成品**。所有失败路径都要把临时文件删干净，
 * 否则下次启动的「清理过期临时文件」会误伤用户录音（docs/04 §7）。
 */

import { createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'
import { AppError, wrapUnknown } from '../../../shared/errors.ts'
import { isProtectedPath } from './paths.ts'

/** 可注入的文件系统端口（单测用内存实现，生产用 node:fs） */
export interface FsPort {
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  open(path: string, flags: string): Promise<FileHandlePort>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  rm(path: string, opts: { recursive?: boolean; force?: boolean }): Promise<void>
  mkdir(path: string, opts: { recursive?: boolean }): Promise<string | undefined>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean }>
  readdir(path: string, opts?: { withFileTypes?: boolean }): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean } | string>>
  copyFile(from: string, to: string): Promise<void>
  readFile(path: string): Promise<Buffer>
}

export interface FileHandlePort {
  write(data: Uint8Array | string): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

/** 默认实现：node:fs/promises 的薄包装（只暴露本仓库用到的子集） */
export const nodeFsPort: FsPort = {
  writeFile: (p, data) => nodeFs.promises.writeFile(p, data),
  open: async (p, flags) => {
    const fh = await nodeFs.promises.open(p, flags)
    return {
      write: async (data) => {
        const res = await fh.write(data as never)
        return { bytesWritten: res.bytesWritten }
      },
      sync: () => fh.sync(),
      close: () => fh.close(),
    }
  },
  rename: (from, to) => nodeFs.promises.rename(from, to),
  unlink: (p) => nodeFs.promises.unlink(p),
  rm: (p, opts) => nodeFs.promises.rm(p, opts),
  mkdir: async (p, opts) => {
    const r = await nodeFs.promises.mkdir(p, opts)
    return r ?? undefined
  },
  stat: (p) => nodeFs.promises.stat(p),
  readdir: (p, opts) => nodeFs.promises.readdir(p, opts as never) as never,
  copyFile: (from, to) => nodeFs.promises.copyFile(from, to),
  readFile: (p) => nodeFs.promises.readFile(p),
}

export interface AtomicWriteOptions {
  fs?: FsPort
  /** 目录 fsync（POSIX 上 rename 的持久化保证；Windows 无此能力，失败即忽略） */
  fsyncDir?: boolean
  /** 追加写入的内容（如需在写完后拿到大小） */
  onWritten?: (bytes: number) => void
}

/** 生成临时文件名：`{target}.{pid}.{rand}.tmp`（带随机后缀，避免多任务互踩） */
export function tempFileNameFor(target: string): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

/**
 * 原子写文件：写临时文件 → fsync → rename 覆盖目标。
 *
 * 同盘 rename 是原子的，因此读者要么看到旧内容、要么看到新内容，**不会看到半截**。
 * 失败时一定会把临时文件删掉（这正是「不留半成品」的含义）。
 */
export async function atomicWriteFile(
  targetPath: string,
  data: Uint8Array | string,
  opts?: AtomicWriteOptions,
): Promise<{ path: string; bytes: number }> {
  const fs = opts?.fs ?? nodeFsPort
  const tmpPath = tempFileNameFor(targetPath)
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength
  try {
    await fs.mkdir(dirname(targetPath), { recursive: true })
    const fh = await fs.open(tmpPath, 'w')
    try {
      await fh.write(data)
      // fsync 是「掉电也不丢」的前提：只写到页缓存就 rename，崩了会得到空文件
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmpPath, targetPath)
    if (opts?.fsyncDir) await fsyncDirectory(dirname(targetPath), fs)
    opts?.onWritten?.(bytes)
    return { path: targetPath, bytes }
  } catch (e) {
    // 失败清理：不留半成品（清理本身的失败只记忽略，不能掩盖原始错误）
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* 临时文件可能根本没建起来 */
    }
    throw wrapUnknown(e)
  }
}

/** 目录 fsync（仅 POSIX 有意义；Windows 上会失败，按「不支持」处理） */
async function fsyncDirectory(dir: string, fs: FsPort): Promise<void> {
  try {
    const fh = await fs.open(dir, 'r')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch {
    /* 平台不支持（Windows）→ 忽略，不影响 rename 的原子性 */
  }
}

/**
 * 在临时目录里执行一段逻辑，**无论成功失败都会清理**。
 *
 * docs/04 §3 要求「保证异常时也清理」——录音/导出/转码都会往这里写中间产物，
 * 漏一个就会在磁盘上留一辈子。
 *
 * @param baseDir 临时目录的父目录（通常 `{userData}/cache/tmp` 或 `{project}/*.tmp`）
 * @param prefix  目录前缀，便于人工排查（如 `record`、`export`）
 */
export async function withTempDir<T>(
  baseDir: string,
  prefix: string,
  fn: (dir: string) => Promise<T>,
  opts?: { fs?: FsPort },
): Promise<T> {
  const fs = opts?.fs ?? nodeFsPort
  const dir = join(baseDir, `${prefix}-${randomBytes(6).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  try {
    return await fn(dir)
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不能覆盖业务异常；残留目录会在启动清理时按 24 小时规则处理 */
    }
  }
}

export interface SafeRemoveOptions {
  fs?: FsPort
  projectRoot?: string
  modelDir?: string
  dbPath?: string
  userDataDir?: string
  /** 只检查不删除（预演） */
  dryRun?: boolean
  /** 允许递归删除目录（默认 true；删文件时无所谓） */
  recursive?: boolean
}

/**
 * 安全删除：拒绝删除项目根、模型目录、数据库（含 `-wal`/`-shm`/备份副本）与 userData 根。
 *
 * 这是**最后一道防线**：调用方（清理任务、撤销操作）已经出过一次 bug 了，
 * 这一层必须兜住，否则用户素材会被静默删除。
 */
export async function safeRemove(targetPath: string, opts?: SafeRemoveOptions): Promise<boolean> {
  const fs = opts?.fs ?? nodeFsPort
  if (isProtectedPath(targetPath, {
    projectRoot: opts?.projectRoot,
    modelDir: opts?.modelDir,
    dbPath: opts?.dbPath,
    userDataDir: opts?.userDataDir,
  })) {
    throw new AppError('PERMISSION_DENIED', {
      details: { path: targetPath, reason: 'protected-path' },
    })
  }
  if (opts?.dryRun) return true
  try {
    await fs.rm(targetPath, { recursive: opts?.recursive ?? true, force: true })
    return true
  } catch (e) {
    throw wrapUnknown(e)
  }
}

/** 内容哈希（用于缓存键/去重；与 hash.ts 的 sha256 同算法，但输入是内存数据） */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}
