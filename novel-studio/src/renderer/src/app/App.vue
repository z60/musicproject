<!--
  Novel Studio · 根组件
  ============================================================================
  设计依据：
    · docs/01 §3.2 —— app/ 负责装配：App.vue 是「布局壳 + 路由视图」
    · docs/22 §5   —— 三级兜底：路由级渲染错误由 ErrorBoundary 兜住，页面崩了不白屏
    · docs/04 §2.4 —— 全局任务进度区在布局壳里（TaskProgressDock），不在各页面

  职责边界（重要）：
    · 这里只做「装配 + 一次性初始化」：恢复会话上下文、订阅设置变更、应用主题；
    · 业务数据一律由各功能域 store 自己加载，App.vue 不碰业务。

  <router-view> 用 v-slot 拿到组件再包 ErrorBoundary：
    这样即使某个页面 setup 抛错，也只有内容区退化，导航与顶栏仍可用
    （用户可以切到别的页面，或点「重试」）。
-->

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import AppShell from './layout/AppShell.vue'
import ErrorBoundary from '@/shared/ui/ErrorBoundary.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useSessionStore } from './store/session.store.ts'
import { useSettingsStore } from './store/settings.store.ts'
import { useTasksStore } from './store/tasks.store.ts'
import { useUiStore } from './store/ui.store.ts'

const session = useSessionStore()
const settings = useSettingsStore()
const tasks = useTasksStore()
const ui = useUiStore()

onMounted(async () => {
  // 1) 主题先应用，避免首屏闪白
  ui.applyTheme()

  // 2) 恢复上次打开的书/章（失败静默：书可能已被删除）
  await session.restore()

  // 3) 设置 + 能力探测（渲染侧据此隐藏不可用控件，docs/02 §5.1）
  void settings.load()
  settings.init()

  // 4) 任务：拉列表 + 订阅进度（窗口重建后恢复显示，docs/20 §7）
  tasks.init()
  void tasks.refresh()
})

onBeforeUnmount(() => {
  settings.dispose()
  tasks.dispose()
})
</script>

<template>
  <AppShell>
    <RouterView v-slot="{ Component, route }">
      <ErrorBoundary :key="route.fullPath">
        <Suspense>
          <component :is="Component" />

          <template #fallback>
            <LoadingBlock variant="skeleton" text="正在加载页面…" :rows="6" min-height="60vh" />
          </template>
        </Suspense>
      </ErrorBoundary>
    </RouterView>
  </AppShell>
</template>

<style scoped>
:deep(.router-page) {
  padding: 16px;
}
</style>
