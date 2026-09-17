/**
 * Novel Studio · 路径解析（启动顺序第 2 步）
 * ============================================================================
 * 设计依据：docs/01 §10 第 2 步、docs/03 §2「目录结构」、docs/04 §8.2「paths 设置」
 *
 * ### 职责边界
 *   本文件**只做路径计算**，不创建目录、不问 Electron 要任何东西 ——
 *   全部输入由调用方注入（`execPath` / `userDataDir` / `isPackaged`）。
 *   这样它既能被 `src/main/index.ts` 用真实 Electron 值调用，
 *   也能被单测用假值调用（本仓库测试环境没有 Electron）。
 *
 * ### 便携模式（docs/02 §7）
 *   可执行文件同目录存在 `portable` 标记文件 → 所有可写数据放在
 *   `<exeDir>/novel-studio-data`，而不是系统的 AppData。
 *   这是「拷到 U 盘就能带走整套项目」的实现基础，必须在解析路径阶段就定下来，
 *   后续任何一步再去问都会得到不一致的答案。
 */

import { existsSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

import type { AppPaths } from '../shared/types.ts'

export interface ResolveAppPathsOptions {
  /** 可执行文件路径（`process.execPath`）；用于便携模式判定与资源目录定位 */
  execPath: string
  /** Electron `app.getPath('userData')` */
  userDataDir: string
  /** `app.isPackaged`（打包后资源在 `process.resourcesPath` 下） */
  isPackaged: boolean
  /** 打包后的资源根（`process.resourcesPath`）；未打包时忽略 */
  resourcesPath?: string
  /** 项目源码根（未打包时的 `resources/`）；通常 `join(appPath, 'resources')` */
  devResourcesDir?: string
  /** 用户是否在设置里覆盖了导出目录 */
  exportDirOverride?: string | null
  /** 用户是否在设置里覆盖了模型目录 */
  modelDirOverride?: string | null
}

export interface ResolvedAppPaths extends AppPaths {
  /** 数据根（便携模式为 `<exeDir>/novel-studio-data`，否则等于 userData） */
  dataRoot: string
  /** 是否处于便携模式 */
  portable: boolean
}

/** 便携模式标记文件名（与可执行文件同目录） */
export const PORTABLE_MARKER = 'portable'
/** 便携模式的数据目录名 */
export const PORTABLE_DATA_DIR = 'novel-studio-data'

/** 便携模式判定：**只看标记文件是否存在**，不猜、不靠环境变量 */
export function isPortableLayout(execPath: string, exists: (p: string) => boolean): boolean {
  try {
    return exists(join(dirname(execPath), PORTABLE_MARKER))
  } catch {
    return false
  }
}

/**
 * 计算全部应用路径。
 *
 * 注意：**不创建目录**。创建目录是 `bootstrap/db.ts` 与 `bootstrap/steps.ts` 的事，
 * 让本函数保持纯计算，单测才好写（否则测试会真的往磁盘写东西）。
 */
export function resolveAppPaths(
  opts: ResolveAppPathsOptions,
  exists: (p: string) => boolean = existsSync,
): ResolvedAppPaths {
  const portable = isPortableLayout(opts.execPath, exists)
  const dataRoot = portable ? join(dirname(opts.execPath), PORTABLE_DATA_DIR) : opts.userDataDir

  // 资源目录：打包后在 resourcesPath 下（electron-builder extraResources 把
  // resources/bin → bin、resources/models → models 平铺过去，见 package.json）
  //
  // 用 normalize 而不是 resolve：这里的输入**已经是绝对路径**（Electron 的
  // app.getAppPath()/process.resourcesPath）。resolve 会在 Windows 上给它
  // 补上当前盘符（`/repo/resources` → `C:\repo\resources`），
  // 那是「相对当前工作目录」的语义，对已经是绝对路径的输入是错的。
  const resourceDir = opts.isPackaged
    ? normalize(opts.resourcesPath ?? join(dirname(opts.execPath), 'resources'))
    : normalize(opts.devResourcesDir ?? join(process.cwd(), 'resources'))

  const modelDir = opts.modelDirOverride && opts.modelDirOverride.trim() !== ''
    ? resolve(opts.modelDirOverride)
    : join(resourceDir, 'models')

  return {
    dataRoot,
    portable,
    userData: dataRoot,
    projectRoot: join(dataRoot, 'projects'),
    exportDir: opts.exportDirOverride && opts.exportDirOverride.trim() !== ''
      ? resolve(opts.exportDirOverride)
      : join(dataRoot, 'exports'),
    cacheDir: join(dataRoot, 'cache'),
    logDir: join(dataRoot, 'logs'),
    backupDir: join(dataRoot, 'backups'),
    modelDir,
    resourceDir,
  }
}

/**
 * ffmpeg 可执行文件候选路径（探测顺序，docs/02 §5.1 步骤 1）。
 *
 * 顺序有意如此：**用户显式指定 > 随包附带 > PATH**。
 * 用户指定优先是因为他自己知道哪个版本能用；随包附带次之（离线可用）；
 * 最后才落到系统 PATH（版本不可控，只当兜底）。
 */
export function ffmpegCandidates(opts: {
  paths: Pick<ResolvedAppPaths, 'resourceDir'>
  settingsFfmpegPath?: string | null
  platform?: NodeJS.Platform
}): string[] {
  const platform = opts.platform ?? process.platform
  const exeName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const out: string[] = []
  const userPath = opts.settingsFfmpegPath?.trim()
  if (userPath) out.push(userPath)
  out.push(join(opts.paths.resourceDir, 'bin', exeName))
  out.push(exeName) // 交给 PATH 解析
  return out
}
