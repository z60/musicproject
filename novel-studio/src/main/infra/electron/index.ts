/**
 * 基础设施 · Electron 运行时加载器（延迟动态导入）
 * ============================================================================
 * 设计依据：docs/02 §3、docs/20 §8
 *
 * 环境约束（本次实现的前提）：**当前环境没有安装 electron**，任何
 * `import { app } from 'electron'` 都会让模块加载失败，测试也就跑不起来。
 *
 * 因此全仓库唯一允许接触 `electron` 的地方就是本文件：
 *   · 用 `await import('electron')` 放在 try/catch 里
 *   · 失败时抛 `AppError('INTERNAL')`，并给出**可操作**的说明
 *     （而不是一个「Cannot find package 'electron'」的裸错误）
 *   · 结果缓存，避免每次调用都走一次模块解析
 *
 * 类型层面：本文件返回 {@link ElectronLike}（本仓库自己定义的最小接口），
 * **不** `import type ... from 'electron'`。
 */

import { AppError } from '../../../shared/errors.ts'
import type { ElectronLike } from './types.ts'

export type {
  AppLike,
  BrowserWindowCtorLike,
  BrowserWindowLike,
  BrowserWindowOptionsLike,
  DialogLike,
  DialogFilterLike,
  ElectronLike,
  IpcMainInvokeEventLike,
  IpcMainLike,
  PowerMonitorLike,
  ProtocolLike,
  SafeStorageLike,
  ScreenLike,
  ShellLike,
  WebContentsLike,
} from './types.ts'

let cached: ElectronLike | null = null
let loadFailure: unknown = null

/**
 * 加载 electron 模块（幂等、缓存）。
 *
 * @throws AppError('INTERNAL') —— 环境里没有 electron（单测/纯 Node 脚本），
 *         或模块加载抛错时。`details.reason` 区分两种情况，便于排障。
 */
export async function loadElectron(): Promise<ElectronLike> {
  if (cached) return cached
  try {
    // 动态导入 + 变量形式：打包器不会把它静态内联，从而保住「可替换可测试」的性质
    const mod = (await import(/* @vite-ignore */ 'electron')) as unknown as Partial<ElectronLike>
    if (!mod || typeof mod !== 'object' || !mod.app || !mod.ipcMain) {
      throw new Error('electron 模块加载成功但缺少 app/ipcMain，疑似被错误地 stub 或版本不兼容')
    }
    cached = mod as ElectronLike
    return cached
  } catch (e) {
    loadFailure = e
    throw new AppError('INTERNAL', {
      cause: e,
      details: {
        reason: 'electron-unavailable',
        hint: '该功能只能在 Electron 主进程中运行；纯 Node 环境（测试/脚本）请注入假实现（见 infra/electron/types.ts）',
      },
    })
  }
}

/**
 * 同步加载（**仅 preload 使用**）。
 *
 * 为什么 preload 必须同步拿：`contextBridge.exposeInMainWorld()` 要在 preload 脚本
 * 求值期间完成，否则渲染进程的首个脚本可能读不到 `window.api`。
 * 沙箱化 preload（`sandbox: true`）里只有受限的 `require`，**没有** ESM 动态导入能力，
 * 所以这里优先用 `require('electron')`，失败再退回动态导入（非沙箱 preload 场景）。
 */
export function loadElectronSync(): ElectronLike {
  if (cached) return cached
  const globalRequire = (globalThis as { require?: (id: string) => unknown }).require
  if (typeof globalRequire === 'function') {
    try {
      const mod = globalRequire('electron') as Partial<ElectronLike>
      if (mod && typeof mod === 'object' && mod.app && mod.ipcMain) {
        cached = mod as ElectronLike
        return cached
      }
    } catch (e) {
      loadFailure = e
    }
  }
  throw new AppError('INTERNAL', {
    cause: loadFailure,
    details: {
      reason: 'electron-sync-unavailable',
      hint:
        'preload 需要在沙箱下同步取得 electron（require("electron")）。' +
        '若 preload 被当作 ESM 执行（sandbox:false + .mjs），请改回 CJS 产物。',
    },
  })
}

/** 是否已成功加载过（诊断用，不触发加载） */
export function isElectronLoaded(): boolean {
  return cached !== null
}

/** 注入实现（单测/自检用）：绕过真实 electron */
export function __setElectronForTest(fake: ElectronLike | null): void {
  cached = fake
}
