import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

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
