/**
 * Novel Studio · 主进程入口（Electron 装配总入口）
 * ============================================================================
 * 设计依据：docs/01-系统架构.md §10「启动顺序（必须严格）」、§11「关闭与崩溃语义」
 *
 * ### 这个文件为什么之前不存在
 *   `src/main/bootstrap/index.ts` 的注释里写着「定义装配所需的窄接口与 BootstrapDeps，
 *   由 `src/main/index.ts` 提供真实实现」—— 但那个文件一直没有被写出来。
 *   后果是：`electron.vite.config.ts` 找不到入口，`npm run dev` 除了 esbuild 报错之外
 *   根本无从谈起；`registerAllHandlers()` 也没有任何地方调用。
 *
 * ### 本文件的职责（只做装配，不做业务）
 *   1. 加载 electron（唯一的动态 import 点，见 infra/electron/index.ts）
 *   2. 解析 preload / renderer 入口路径（dev 与打包两条路）
 *   3. 按 `BOOT_STEPS` 顺序跑启动流程，把每一步的产出写进 `AppState`
 *   4. 装配 `HandlerDeps` 并注册全部 IPC handler
 *   5. 接住进程级兜底（uncaughtException / unhandledRejection / 退出清理）
 *
 *   业务逻辑一律不写在这里：窗口在 bootstrap/window-manager.ts、
 *   启动步骤在 bootstrap-steps.ts、依赖装配在 ports.ts。
 *
 * ### 启动顺序的两个不可交换点（抄自 docs/01 §10，后果是丢数据而不是报错）
 *   · 3 必须在 4 之前：**数据库出问题要留日志**
 *   · 5 必须在 6 之前：**不能把待修复的 .tmp 当垃圾删掉**（会直接导致用户录音丢失）
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppError, wrapUnknown } from '../shared/errors.ts'
import { createAppState } from './app-state.ts'
import { createBootStepHandlers, type BootDeps } from './bootstrap-steps.ts'
import { BOOT_STEPS, formatBootReport, runBootSequence, validateBootPlan } from './bootstrap/index.ts'
import { registerMediaSchemePrivileges } from './bootstrap/window-manager.ts'
import { loadElectron } from './infra/electron/index.ts'
import { registerAllHandlers } from './ipc/index.ts'
import { buildHandlerDeps } from './ports.ts'

// ---------------------------------------------------------------------------
// 入口路径解析
// ---------------------------------------------------------------------------

/**
 * 解析渲染进程入口。
 *
 * dev：electron-vite 注入 `ELECTRON_RENDERER_URL`（Vite dev server，带 HMR）；
 * 打包：`out/renderer/index.html`（相对 `out/main/index.js` 的 `../renderer/`）。
 *
 * **两条路都可能确实不存在**（例如打包产物不完整）—— 那种情况下返回 null，
 * 由启动步骤抛出明确错误，而不是加载一个不存在的 URL 得到空白窗口。
 */
export function resolveRendererEntry(opts: {
  devServerUrl: string | undefined
  outDir: string
}): { url: string | null; file: string | null } {
  if (opts.devServerUrl) return { url: opts.devServerUrl, file: null }
  return { url: null, file: join(opts.outDir, 'renderer', 'index.html') }
}

/**
 * preload 产物路径。
 *
 * 与 `electron.vite.config.ts` 的 preload 配置**必须一致**：
 * `outDir: 'out/preload'` + `output.entryFileNames: '[name].cjs'` → `out/preload/index.cjs`。
 * 写成 `.js` 会得到一个「preload 加载失败、渲染进程没有 window.api」的空白应用，
 * 而且主进程日志里不会有明显报错 —— 是那种很难查的启动期故障。
 */
export function resolvePreloadPath(outMainDir: string): string {
  return join(outMainDir, '..', 'preload', 'index.cjs')
}

/**
 * 当前模块所在目录。
 *
 * **不用 `__dirname`**：主进程产物是 ESM（`electron.vite.config.ts` 里
 * `output: { format: 'es' }`，因为 package.json 是 `"type": "module"`），
 * 而 ESM 里 `__dirname` 不是语言内建 —— 能不能用取决于 electron-vite 是否注入了
 * CommonJS shim，那是它的内部实现细节，不该成为我们的启动依赖。
 * `import.meta.url` 在 ESM 里永远存在，用它换算目录是确定性的。
 */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const state = createAppState()

  // ── 1) 加载 electron ─────────────────────────────────────────────────────
  let electron
  try {
    electron = await loadElectron()
  } catch (e) {
    // 没有 electron = 这个文件不该在这个环境里执行（例如被脚本误 import）
    const msg = e instanceof AppError ? e.message : String(e)
    console.error(`[novel-studio] 无法加载 electron：${msg}`)
    process.exitCode = 1
    return
  }
  state.electron = electron

  // ── 1.5) 注册自定义协议的权限（**必须在 ready 之前**）─────────────────────
  // 这是 Electron 的硬要求：`protocol.registerSchemesAsPrivileged` 只在应用就绪前有效，
  // 之后调用会直接抛错。真机上第一次跑就撞在这里 —— 启动流程的
  // `register-media-protocol` 步骤是在 `whenReady()` 之后执行的，
  // 于是那一步 0ms 就失败，而且当时错误详情还被日志吃掉了，完全看不出原因。
  //
  // 权限声明与 handler 注册**时机不同**，因此拆成两处：
  //   · 这里（ready 前）：声明 `ns-media://` 的权限（standard/secure/stream 等）
  //   · 启动流程第 11 步（ready 后）：注册真正的 handler（`protocol.handle`）
  //
  // 失败不致命：没有媒体协议时「播放项目内音频」不可用，但书籍/画本/设置等仍能用，
  // 所以只记 warn 并继续，而不是把整个应用挡住。
  try {
    registerMediaSchemePrivileges(electron)
  } catch (e) {
    console.warn(`[novel-studio] 注册 ns-media 协议权限失败（音频播放将不可用）：${String(e)}`)
  }

  // ── 等待 app ready ──────────────────────────────────────────────────────
  // **必须**在任何 `app.getPath()` / `BrowserWindow` / `dialog` 之前 await。
  // 在 ready 之前调用 Electron 会直接抛错（或返回不可用值），而那是启动期故障，
  // 现象是「应用一闪而过」或「窗口是空白」，很难从日志看出根因。
  await electron.app.whenReady()

  const outMainDir = moduleDir()
  const isDev = !electron.app.isPackaged
  const renderer = resolveRendererEntry({
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
    outDir: join(outMainDir, '..'),
  })

  const bootDeps: BootDeps = {
    state,
    version: electron.app.getVersion(),
    isPackaged: electron.app.isPackaged,
    isDev,
    rendererUrl: renderer.url,
    rendererFile: renderer.file,
    execPath: process.execPath,
    ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}),
    ...(process.env.DSH_DEV_RESOURCES ? { devResourcesDir: process.env.DSH_DEV_RESOURCES } : {}),
    preloadPath: resolvePreloadPath(outMainDir),
  }

  const handlers = createBootStepHandlers(bootDeps)

  // ── 2) 启动计划自检 ──────────────────────────────────────────────────────
  // 顺序错了要在**动任何数据之前**炸掉，而不是跑到一半才发现
  const planIssues = validateBootPlan()
  if (planIssues.length > 0) {
    const detail = planIssues.map((i) => i.detail).join('；')
    console.error(`[novel-studio] 启动顺序校验失败：${detail}`)
    process.exitCode = 1
    return
  }

  // ── 3) 注册 IPC handler 的那一步需要完整的 HandlerDeps ──────────────────
  //    它在「数据库已打开、迁移已跑、设置已就绪」之后才可能装配，
  //    而 BOOT_STEPS 的第 12 步正好在那个位置。因此这里用闭包延迟装配。
  let deps: ReturnType<typeof buildHandlerDeps> | null = null
  handlers['register-ipc-handlers'] = async () => {
    const built = buildHandlerDeps({
      state,
      version: electron.app.getVersion(),
      portable: state.portable,
      openExternal: (url) => electron.shell.openExternal(url),
      showItemInFolder: (path) => electron.shell.showItemInFolder(path),
      pickFolder: async (o) => {
        const r = await electron.dialog.showOpenDialog(state.mainWindow, {
          ...(o.title ? { title: o.title } : {}),
          ...(o.defaultPath ? { defaultPath: o.defaultPath } : {}),
          properties: ['openDirectory', 'createDirectory'],
        })
        return r.canceled ? null : (r.filePaths[0] ?? null)
      },
      pickFiles: async (o) => {
        const r = await electron.dialog.showOpenDialog(state.mainWindow, {
          ...(o.title ? { title: o.title } : {}),
          ...(o.filters ? { filters: o.filters } : {}),
          properties: o.multi ? ['openFile', 'multiSelections'] : ['openFile'],
        })
        return r.canceled ? [] : r.filePaths
      },
      pickSavePath: async (o) => {
        const r = await electron.dialog.showSaveDialog(state.mainWindow, {
          ...(o.title ? { title: o.title } : {}),
          ...(o.defaultPath ? { defaultPath: o.defaultPath } : {}),
          ...(o.filters ? { filters: o.filters } : {}),
        })
        return r.canceled ? null : (r.filePath ?? null)
      },
      quit: (force) => {
        // force=true 跳过 before-quit 的未完成操作拦截（用户在对话框里选了「强制退出」）
        if (force) electron.app.exit(0)
        else electron.app.quit()
      },
    })
    deps = built
    state.queue = built.queue

    const result = registerAllHandlers(built.deps, {
      ipcMain: electron.ipcMain,
      // 契约里每个通道都必须有 handler：未实现的由占位 handler 兜住（抛 NOT_IMPLEMENTED）
      placeholderForMissing: true,
      assertParity: true,
      // 领域 handler（书籍导入域等）：持有服务实例，因此由装配层注入而不是静态汇总。
      // 不传的话这些通道会退化成 NOT_IMPLEMENTED 占位 —— 看起来「有 handler」但功能不可用。
      domainHandlers: built.domainHandlers,
    })

    state.log().info('ipc.registered', {
      event: 'ipc.registered',
      implemented: result.implemented,
      placeholders: result.placeholders,
      registered: result.registered,
      contractTotal: result.parity.expected,
    })
    if (result.placeholders > 0) {
      // 明确告知：这些通道点了会报「功能未提供」，而不是静默无反应
      state.log().warn('ipc.placeholders', {
        event: 'ipc.placeholders',
        count: result.placeholders,
        first: result.placeholderChannels.slice(0, 10),
      })
    }

    // ── 确保默认项目存在 ─────────────────────────────────────────────────
    // 为什么必须在这里做：契约里**没有** project:create 通道，而 `books.project_id`
    // 是 NOT NULL 外键 —— 没有项目就一本书都建不了。用户第一次打开导入页时
    // 不应该需要先「创建项目」（那是实现细节，不是产品概念）。
    //
    // 失败不致命：只影响「导入/列书」，其它功能照常。
    try {
      const projectId = await built.book.ensureProject()
      state.log().info('book.project.ready', { event: 'book.project.ready', projectId })
    } catch (e) {
      state.log().warn('book.project.ensureFailed', {
        event: 'book.project.ensureFailed',
        reason: e instanceof Error ? e.message : String(e),
      })
    }

    return { implemented: result.implemented, placeholders: result.placeholders }
  }

  // ── 4) 跑启动流程 ────────────────────────────────────────────────────────
  const report = await runBootSequence({
    handlers,
    onStepFinish: (r) => {
      if (!r.ok) {
        // 用 `r.cause`（原始对象）而不是 `r.error`（拼好的字符串）——
        // 字符串化的错误只剩「AppError: 无法打开数据库」这种给用户看的标题，
        // causeChain / details / numericCode 全丢，故障就无法定位（docs/91 §5.4）。
        // `toLogFields` 会把 cause / causeChain / stack / code 全部展开。
        state.log().errorFields(r.cause ?? new Error(r.error ?? '未知错误'), 'app.boot.stepFailed', {
          step: r.id,
          skipped: r.skipped,
        })
      }
    },
  })

  for (const line of formatBootReport(report)) state.log().info('app.boot.report', { event: 'app.boot.report', line })

  // 单实例锁没拿到 → 聚焦已有窗口并退出（这不是失败）
  if (!state.hasLock) {
    state.log().info('app.exit.singleInstance', { event: 'app.exit.singleInstance' })
    electron.app.quit()
    return
  }

  if (report.abortedAt) {
    const failed = report.steps.find((s) => s.id === report.abortedAt)
    state.log().error('app.boot.aborted', {
      event: 'app.boot.aborted',
      step: report.abortedAt,
      error: failed?.error ?? '',
      // 提示排查位置：日志目录与数据库路径是这类故障最先要看的两个东西
      logDir: state.paths?.logDir ?? null,
      dbPath: state.dbPath,
    })
    // 致命步骤失败的提示交给用户：这里只负责把进程退出，避免留下半个应用
    // （showMessageBox 是 optional：Electron 老版本可能没有，缺了就只写日志）
    const box = electron.dialog.showMessageBox?.(null, {
      type: 'error',
      title: 'Novel Studio 启动失败',
      message: '应用无法完成启动。',
      detail: `${report.abortedAt}：${failed?.error ?? '未知原因'}\n\n日志目录：${state.paths?.logDir ?? '(未解析)'}`,
      buttons: ['退出'],
    })
      .catch(() => undefined)
      .finally(() => electron.app.exit(1))
    if (!box) electron.app.exit(1)
    return
  }

  // ── 5) 进程级兜底 ────────────────────────────────────────────────────────
  installProcessGuards(state, () => deps)

  // ── 6) 退出清理 ──────────────────────────────────────────────────────────
  let cleanedUp = false
  electron.app.on('before-quit', () => {
    if (cleanedUp) return
    cleanedUp = true
    // 窗口状态必须在这里落盘：窗口已经 close 过，晚于此就取不到 bounds
    void state.windowManager?.persistState().catch(() => undefined)
    void state.dispose().catch(() => undefined)
  })

  // 所有窗口关闭即退出（macOS 习惯是保留进程，但本应用没有 dock 交互，直接退出更可预期）
  electron.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') electron.app.quit()
  })

  state.log().info('app.ready', {
    event: 'app.ready',
    version: electron.app.getVersion(),
    isDev,
    portable: state.portable,
    readOnly: state.readOnly,
  })
}

/**
 * 进程级错误兜底。
 *
 * `uncaughtException` 之后进程状态已不可信，因此策略是「记日志 + 提示 + 退出」，
 * 而不是继续跑 —— 继续跑会写坏数据，比崩溃更难收拾。
 */
function installProcessGuards(
  state: ReturnType<typeof createAppState>,
  getDeps: () => ReturnType<typeof buildHandlerDeps> | null,
): void {
  process.on('uncaughtException', (e) => {
    const appErr = wrapUnknown(e, 'INTERNAL')
    state.log().errorFields(appErr, 'main.uncaughtException')
    void getDeps()
    try {
      const box = state.electron?.dialog.showMessageBox?.(null, {
        type: 'error',
        title: 'Novel Studio 遇到问题',
        message: appErr.message,
        detail: `编号：${appErr.numericCode}\n日志目录：${state.paths?.logDir ?? '(未解析)'}`,
        buttons: ['退出'],
      })
      if (box) box.catch(() => undefined).finally(() => state.electron?.app.exit(1))
      else state.electron?.app.exit(1)
    } catch {
      state.electron?.app.exit(1)
    }
  })

  process.on('unhandledRejection', (reason) => {
    // 未处理的 Promise 拒绝通常不致命（漏 catch 的异步链路），记日志 + 继续
    const appErr = wrapUnknown(reason, 'INTERNAL')
    state.log().errorFields(appErr, 'main.unhandledRejection')
  })
}

// ---------------------------------------------------------------------------
// 引导
// ---------------------------------------------------------------------------

main().catch((e) => {
  // 走到这里说明连 AppState 都没建起来（极早期失败），只能用控制台
  const appErr = wrapUnknown(e, 'INTERNAL')
  console.error(`[novel-studio] 启动失败：${appErr.key} ${appErr.message}`)
  process.exitCode = 1
})

export { BOOT_STEPS }
