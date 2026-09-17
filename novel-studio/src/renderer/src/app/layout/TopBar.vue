<!--
  Novel Studio · 顶栏
  ============================================================================
  设计依据：
    · docs/01 §4.1 —— 主链：导入 → 生成画本 → 校对 → 录音 → 对轨 → 混音导出
      （顶栏用面包屑告诉你「现在在哪本书的哪一章」）
    · docs/11 §4.9 —— 顶栏要能显示保存状态（写库失败必须显眼）
    · docs/12 §9.3 —— 录音中拦截「关闭窗口」：顶栏在录音中显示录音态提示
    · docs/22 §7   —— fatal 阻断态由 AppShell 渲染，顶栏只反映常规状态

  内容：
    左：面包屑（书名 · 章节）+ 录音中提示
    中：全局搜索入口（章节/角色快速跳转，1.0 占位但交互可用）
    右：保存状态 / 任务指示 / 主题切换 / 折叠导航
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useTasksStore } from '@/app/store/tasks.store.ts'
import { useUiStore } from '@/app/store/ui.store.ts'

const router = useRouter()
const session = useSessionStore()
const tasks = useTasksStore()
const ui = useUiStore()

const keywords = ref('')
const searching = ref(false)

const title = computed(() => session.book?.title ?? '未选择书籍')
const subtitle = computed(() => session.chapter?.title ?? (session.hasBook ? '未选择章节' : '先从书架导入一本书'))

/** 录音页激活时接管快捷键（docs/12 §9.3），顶栏给出明确提示，避免用户以为键盘坏了 */
const recording = computed(() => ui.capturingShortcuts)

const taskText = computed(() => {
  if (tasks.runningCount > 0) return `${tasks.runningCount} 个任务进行中`
  if (tasks.hasFailure) return '有任务失败'
  return ''
})

function toggleTheme(): void {
  const order = ['system', 'light', 'dark'] as const
  const index = order.indexOf(ui.theme)
  ui.setTheme(order[(index + 1) % order.length]!)
}

const themeLabel = computed(() => ({
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
} as const)[ui.theme])

async function onSearch(): Promise<void> {
  const keyword = keywords.value.trim()
  if (!keyword) return
  searching.value = true
  try {
    // 1.0 的实现：跳到章节管理页并带上关键词（章节视图自己按标题过滤）
    await router.push({ path: '/chapters', query: { q: keyword } })
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <header class="ns-topbar">
    <div class="ns-topbar__left">
      <button
        type="button"
        class="ns-topbar__icon-btn"
        :title="ui.sidebarCollapsed ? '展开导航' : '收起导航'"
        @click="ui.toggleSidebar()"
      >
        ☰
      </button>

      <div class="ns-topbar__title">
        <strong class="ns-topbar__book" :title="title">{{ title }}</strong>
        <small class="ns-topbar__chapter" :title="subtitle">{{ subtitle }}</small>
      </div>

      <span v-if="recording" class="ns-topbar__recording" title="录音中：已拦截会误关窗口的快捷键">
        ● 录音中
      </span>
    </div>

    <div class="ns-topbar__center">
      <input
        v-model="keywords"
        class="ns-topbar__search"
        type="search"
        placeholder="搜索章节标题（回车跳转章节管理）"
        :disabled="!session.hasBook"
        @keydown.enter="onSearch"
      >
      <button
        type="button"
        class="ns-topbar__icon-btn"
        :disabled="searching || !session.hasBook"
        title="搜索"
        @click="onSearch"
      >
        🔍
      </button>
    </div>

    <div class="ns-topbar__right">
      <span v-if="tasks.runningCount > 0" class="ns-topbar__task" @click="router.push('/tasks')">
        <span class="ns-topbar__spinner" aria-hidden="true" />
        {{ taskText }}
      </span>
      <span v-else-if="tasks.hasFailure" class="ns-topbar__task ns-topbar__task--alert" @click="router.push('/tasks')">
        {{ taskText }}
      </span>

      <button type="button" class="ns-topbar__text-btn" :title="`主题：${themeLabel}`" @click="toggleTheme">
        {{ themeLabel }}
      </button>

      <button type="button" class="ns-topbar__icon-btn" title="导出诊断包（报障用）" @click="router.push('/settings?focus=diagnostics')">
        🩺
      </button>
    </div>
  </header>
</template>

<style scoped>
.ns-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 12px;
  border-bottom: 1px solid var(--ns-border, #dcdfe6);
  background: var(--ns-bg-elevated, #fff);
}
.ns-topbar__left,
.ns-topbar__right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ns-topbar__left {
  min-width: 260px;
}
.ns-topbar__center {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  justify-content: center;
}
.ns-topbar__right {
  min-width: 260px;
  justify-content: flex-end;
}
.ns-topbar__title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
}
.ns-topbar__book {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-topbar__chapter {
  overflow: hidden;
  max-width: 320px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-topbar__recording {
  padding: 1px 6px;
  border-radius: 3px;
  background: rgb(245 108 108 / 14%);
  color: var(--ns-danger, #f56c6c);
  font-size: 11px;
}
.ns-topbar__search {
  width: min(420px, 40vw);
  padding: 5px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  font-size: 13px;
}
.ns-topbar__icon-btn {
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  font-size: 14px;
  cursor: pointer;
}
.ns-topbar__icon-btn:hover:not(:disabled) {
  border-color: var(--ns-border, #dcdfe6);
}
.ns-topbar__icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.ns-topbar__text-btn {
  padding: 4px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: transparent;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.ns-topbar__task {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
  font-size: 11px;
  cursor: pointer;
}
.ns-topbar__task--alert {
  background: rgb(245 108 108 / 14%);
  color: var(--ns-danger, #f56c6c);
}
.ns-topbar__spinner {
  width: 10px;
  height: 10px;
  border: 2px solid rgb(64 158 255 / 30%);
  border-top-color: var(--ns-primary, #409eff);
  border-radius: 50%;
  animation: ns-top-spin 0.9s linear infinite;
}
@keyframes ns-top-spin {
  to { transform: rotate(360deg); }
}
</style>
