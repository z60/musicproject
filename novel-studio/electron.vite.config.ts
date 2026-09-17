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
// ### 为什么内联在配置文件里（不 import 自定义模块）
//   electron-vite 启动时**先用 esbuild 把本文件打成一个临时 bundle**。
//   跨文件 import 会多一个解析环节，而本仓库的验证环境禁止 spawn（跑不了 esbuild），
//   **无法预先验证那个 import 能否被解析** —— 不引入无法验证的风险，故内联。
//
// ### 为什么挂 writeBundle 而不是 postbuild 脚本
//   dev 与 build 两条路都会走 vite 插件；postbuild 脚本只覆盖 build，
//   `npm run dev` 依然会踩同一个坑。且全程只用 node:fs，不 spawn 任何进程。
const RUNTIME_ASSET_DIRS = [
  { from: 'src/main/infra/db/migrations', to: 'main/infra/db/migrations' },
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
      for (const asset of RUNTIME_ASSET_DIRS) {
        const src = resolve(asset.from)
        if (!existsSync(src)) continue
        const dest = resolve(outDir, asset.to)
        mkdirSync(dest, { recursive: true })
        for (const name of readdirSync(src)) {
          if (!name.endsWith('.sql')) continue
          cpSync(resolve(src, name), resolve(dest, name))
          copied++
        }
      }
      this.info(`[runtime-assets] 已复制 ${copied} 个文件到 ${outDir}`)
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
