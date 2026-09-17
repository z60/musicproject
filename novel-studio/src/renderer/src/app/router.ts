/**
 * Novel Studio · 路由表
 * ============================================================================
 * 设计依据：
 *   · docs/README §4 —— 目录与功能域划分
 *   · docs/01 §4.1  —— 主链顺序即导航顺序：导入 → 画本 → 录音 → 对轨 → 混音导出
 *   · docs/22 §5    —— **路由懒加载失败必须兜底**（构建产物更新后旧页面点击会出现
 *     chunk 加载失败）；错误由 app/error-handler.ts 的 router.onError 统一兑现，
 *     这里只负责「全部懒加载」这件事本身
 *
 * 三个约定：
 *   1. 全部路由 `import()` 懒加载：首屏只加载壳与书架，启动更快；
 *   2. 每个路由都写 meta.title / meta.requiresBook / meta.requiresChapter，
 *      顶栏与前置条件提示都从这里读，不在页面里各写一遍；
 *   3. 路由级错误由 App.vue 的 <ErrorBoundary> 包裹 <router-view>（页面崩了不白屏）。
 */

import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面标题（顶栏/浏览器标题用） */
    title: string
    /** 需要已选中书籍，否则引导去书架 */
    requiresBook?: boolean
    /** 需要已选中章节 */
    requiresChapter?: boolean
    /** 录音类页面：激活时接管全局快捷键（docs/12 §9.3） */
    capturesShortcuts?: boolean
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/bookshelf' },

  // ── 书籍导入域（docs/10）────────────────────────────────────────────────
  {
    path: '/bookshelf',
    name: 'bookshelf',
    component: () => import('@/features/book/views/BookshelfView.vue'),
    meta: { title: '书架' },
  },
  {
    path: '/import',
    name: 'import',
    component: () => import('@/features/book/views/ImportWizardView.vue'),
    meta: { title: '导入向导' },
  },
  {
    path: '/chapters',
    name: 'chapters',
    component: () => import('@/features/book/views/ChapterListView.vue'),
    meta: { title: '章节管理', requiresBook: true },
  },

  // ── 画本编辑（docs/11）──────────────────────────────────────────────────
  {
    path: '/canvas',
    name: 'canvas',
    component: () => import('@/features/editor/views/CanvasEditorView.vue'),
    meta: { title: '画本编辑', requiresChapter: true },
  },

  // ── 录音（docs/12）──────────────────────────────────────────────────────
  {
    path: '/recording',
    name: 'recording',
    component: () => import('@/features/recording/views/RecordingView.vue'),
    meta: { title: '录音', requiresChapter: true, capturesShortcuts: true },
  },
  {
    path: '/recording/continuous',
    name: 'recording-continuous',
    component: () => import('@/features/recording/views/ContinuousReviewView.vue'),
    meta: { title: '连续录制切片确认', requiresChapter: true, capturesShortcuts: true },
  },
  {
    path: '/recording/diagnostics',
    name: 'recording-diagnostics',
    component: () => import('@/features/recording/views/DeviceDiagnosticsView.vue'),
    meta: { title: '设备诊断' },
  },
  {
    path: '/recording/task/:packageId?',
    name: 'recording-task',
    component: () => import('@/features/recording/views/TaskRecordingView.vue'),
    meta: { title: '任务包录音', capturesShortcuts: true },
  },

  // ── 对轨（docs/13）──────────────────────────────────────────────────────
  {
    path: '/alignment',
    name: 'alignment',
    component: () => import('@/features/alignment/views/AlignmentView.vue'),
    meta: { title: '对轨', requiresChapter: true },
  },
  {
    path: '/alignment/match',
    name: 'alignment-match',
    component: () => import('@/features/alignment/views/MatchReviewView.vue'),
    meta: { title: '录制对齐', requiresChapter: true },
  },

  // ── 混音与导出（docs/14 / docs/15）──────────────────────────────────────
  {
    path: '/mixing',
    name: 'mixing',
    component: () => import('@/features/mixing/views/MixerView.vue'),
    meta: { title: '混音台', requiresChapter: true },
  },
  {
    path: '/export',
    name: 'export',
    component: () => import('@/features/mixing/views/ExportWizardView.vue'),
    meta: { title: '导出向导', requiresBook: true },
  },

  // ── 系统（设置 / 任务 / 帮助）────────────────────────────────────────────
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/features/settings/SettingsView.vue'),
    meta: { title: '设置' },
  },
  {
    path: '/tasks',
    name: 'tasks',
    component: () => import('@/features/task/TaskCenterView.vue'),
    meta: { title: '任务中心' },
  },
  {
    path: '/help',
    name: 'help',
    component: () => import('@/features/help/HelpView.vue'),
    meta: { title: '帮助与快捷键' },
  },

  // 兜底：未知路径不静默重定向（用户会以为「点了没反应」），而是明确提示
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/features/help/NotFoundView.vue'),
    meta: { title: '页面不存在' },
  },
]

export const router = createRouter({
  // Electron 里用 hash 模式：file:// 加载时 history 模式会 404
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

/**
 * 前置条件守卫：需要书/章却没有选择时，**引导到书架并带上回跳地址**，
 * 而不是把用户挡在一个空白页上（也不静默失败）。
 */
router.beforeEach(async (to) => {
  if ((!to.meta.requiresBook && !to.meta.requiresChapter) || to.name === 'bookshelf') return true

  // 动态导入 store：避免 router 模块在 pinia 安装前就求值 store
  const { useSessionStore } = await import('@/app/store/session.store.ts')
  const session = useSessionStore()

  if (to.meta.requiresBook && !session.hasBook) {
    return { path: '/bookshelf', query: { redirect: to.fullPath, reason: 'need-book' } }
  }
  if (to.meta.requiresChapter && !session.hasChapter) {
    return {
      path: '/chapters',
      query: session.hasBook ? { redirect: to.fullPath, reason: 'need-chapter' } : { reason: 'need-book' },
    }
  }
  return true
})

/** 统一写页面标题（顶栏也会显示，双保险便于窗口切换识别） */
router.afterEach((to) => {
  const title = to.meta.title ?? 'Novel Studio'
  globalThis.document !== undefined && (globalThis.document.title = `${title} · Novel Studio`)
})

export default router
