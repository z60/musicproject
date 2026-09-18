import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// ============================================================================
// 运行时资源复制插件
// ============================================================================
// ### 为什么必须存在（真实踩过的坑）
//   迁移 SQL（`src/main/infra/db/migrations/*.sql`）是**运行时用
//   `readFileSync(join(dirname(import.meta.url), file))` 读取**的 ——
//   打包器不认识 `.sql`，不会把它带进 bundle。
//
//   真机上第一次 `npm run dev` 的现象：
//     db.opened                    schemaVersion: 0     ← 库开了，但没有表
//     db.migrate.failed.readOnly   reason: DB_MIGRATION_FAILED
//     [FAIL] register-media-protocol
//   而 `out/main/infra/db/migrations/` 目录**根本不存在**。
//   结果：应用能起窗口，但没有任何表可用。
//
// ### 第三次踩坑（最终定论）：目标必须是 outDir **本身**
//   前两次都错了，而且错法不同，值得完整记下：
//
//   ① 第一次：`to = 'main/infra/db/migrations'` → `out/main/main/infra/db/migrations/`
//      （outDir 已是 out/main，多套了一层）
//   ② 第二次：`to = 'infra/db/migrations'` → `out/main/infra/db/migrations/`
//      路径"看起来对"（和源码树 src/main/infra/db/migrations 形状一致），**但仍然是错的**。
//
//   为什么 ② 也错 —— 关键在于**别把源码树的形状当成 bundle 后的形状**：
//     · 源码里 `infra/db/migrations/index.ts` 与 .sql **同目录**
//     · 但 electron-vite 把整个主进程**内联成单个 bundle**：`out/main/index.js`
//       （目录结构不复存在，`infra/db/migrations/` 这一层在产物里根本不存在）
//     · 而 `migrations/index.ts` 里的
//           `const migrationsDir = dirname(fileURLToPath(import.meta.url))`
//       被内联进 index.js 后，`import.meta.url` 就是 **out/main/index.js** 的 URL
//         ⇒ `migrationsDir = <outDir>`（产物里就是这么算的，日志实证：
//            ENOENT …\out\main\001_init.sql）
//
//   所以 SQL 必须与 `index.js` **同级**，即 `to` 必须解析为 `<outDir>` 本身（`'.'`）。
//
//   真机日志（第二次修复后）：
//     causeChain: ["[ENOENT] Error: ENOENT: no such file or directory,
//                  open '…\novel-studio\out\main\001_init.sql'"]
//     —— 文件名是 001_init.sql，目录是 out/main，与上面的推导完全一致。
//
//   四条纪律：
//     1. `to` 解析结果必须**正好等于 outDir**；写成任何子目录都会 ENOENT；
//     2. 源目录不存在 → 直接抛错（静默 continue 会把「打包漏文件」拖到运行时才暴露）；
//     3. 一个 .sql 都没复制 → 直接抛错；
//     4. 想改 `to` 之前，先读产物里 `migrationsDir` 的实际取值（见 docs/91 §5.2.1）。
const RUNTIME_ASSET_DIRS = [
  // 目标 = <outDir> 本身（'.'），与产物里 dirname(import.meta.url) 对齐 —— 见上面 ③
  { from: 'src/main/infra/db/migrations', to: '.' },
]

function copyRuntimeAssetsPlugin() {
  return {
    name: 'novel-studio:copy-runtime-assets',
    apply: () => true,
    /**
     * `this` 是 Rollup 的插件上下文（`PluginContext`），带 `info/warn` 等方法。
     * 必须显式标注：不标注时 TS 会把对象字面量的 `this` 推成上面那个结构，
     * 报 `Property 'info' does not exist on type ...`。
     */
    writeBundle(this: { info(msg: string): void }, options: { dir?: string }) {
      const outDir = options.dir ?? resolve('out')
      let copied = 0
      const copiedTo: string[] = []
      for (const asset of RUNTIME_ASSET_DIRS) {
        const src = resolve(asset.from)
        if (!existsSync(src)) {
          // 静默跳过会让「源目录改名/移动」这类错误一路潜伏到运行时，
          // 表现成「库连上了但没有表」——排查成本极高。这里直接失败。
          throw new Error(
            `[runtime-assets] 源目录不存在：${src}\n` +
              `  迁移 SQL 必须存在于源码树中；若已移动，请同步修改 electron.vite.config.ts 的 RUNTIME_ASSET_DIRS。`
          )
        }
        const dest = resolve(outDir, asset.to)
        mkdirSync(dest, { recursive: true })
        for (const name of readdirSync(src)) {
          if (!name.endsWith('.sql')) continue
          cpSync(resolve(src, name), resolve(dest, name))
          copied++
          copiedTo.push(resolve(dest, name))
        }
      }
      if (copied === 0) {
        throw new Error(
          `[runtime-assets] 一个 .sql 都没复制到 ${outDir} —— 运行时 loadMigrations() 必然 ENOENT。`
        )
      }
      this.info(`[runtime-assets] 已复制 ${copied} 个文件：`)
      for (const p of copiedTo) this.info(`[runtime-assets]   ${p}`)
    },
  }
}

// ============================================================================
// Novel Studio · electron-vite 配置
// ============================================================================
// 设计依据：docs/02-技术选型与依赖.md §6
//
// 三条要点：
//   1. 原生模块（better-sqlite3 / onnxruntime-node）必须 external，否则会被
//      打进 bundle 导致 .node 找不到（参见 docs/02 §4 ABI 排错清单）。
//   2. preload 产物用 CJS：sandbox 场景下 preload 走 CJS 最稳。
//   3. 路径别名：渲染进程用 @ / @shared；主进程内部一律用相对路径，
//      理由是 src/shared 里带 .ts 扩展名的相对导入也能被 Node 直接执行
//      （文档生成脚本与纯逻辑单测都靠这一点，见 docs/22 §12）。
// ============================================================================

const nativeExternals = [
  'better-sqlite3',
  'onnxruntime-node',
  'electron-log',
  'fluent-ffmpeg',
  'archiver',
  'yauzl'
]

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        external: nativeExternals,
        output: { format: 'es' }
      }
    },
    // ⚠️ 必须有这个插件：迁移 SQL 是**运行时读文件**的（打包器不认识 .sql，不会带进 bundle）。
    //    少了它，真机上 `out/main/infra/db/migrations/` 不存在 →
    //    loadMigrations() 读不到 SQL → DB_MIGRATION_FAILED → 应用起得来但没有任何表。
    //    做成插件（而不是 postbuild 脚本）是因为 dev 与 build 两条路都会走 vite。
    plugins: [copyRuntimeAssetsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },

  preload: {
    build: {
      outDir: 'out/preload',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },

  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      sourcemap: true,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
        output: {
          manualChunks: {
            vendor: ['vue', 'vue-router', 'pinia'],
            element: ['element-plus', '@element-plus/icons-vue']
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      vue(),
      AutoImport({
        imports: ['vue', 'vue-router', 'pinia'],
        // 设计文档禁止组件直接调 window.api，因此不自动导入任何 IPC 助手，
        // 强制显式 import 自 src/shared 的 ipc 客户端。
        dts: 'src/renderer/src/types/auto-imports.d.ts',
        resolvers: [ElementPlusResolver()]
      }),
      Components({
        dts: 'src/renderer/src/types/components.d.ts',
        resolvers: [ElementPlusResolver()]
      })
    ],
    worker: { format: 'es' },
    server: { port: 5173, strictPort: false }
  }
})
