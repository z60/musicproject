<!--
  Novel Studio · 全局任务进度坞（右下角）
  ============================================================================
  设计依据：
    · docs/04 §2.4 —— 「统一的任务进度卡」：全局只有这一处进度 UI，
      每个功能域禁止自建；本组件是它的宿主
    · docs/20 §7 —— 窗口重建后要能用 `task:list` 恢复显示；事件幂等
    · docs/22 §7 —— 批量任务的失败要**汇总成一条**提示，而不是刷 8 条 toast；
      因此进度坞只展示，不做逐条弹提示

  行为：
    · 默认折叠成一个小胶囊（显示进行中任务数），点开显示任务卡列表；
    · 任务完成/失败后卡片保留一段时间（由 tasks.store 的自动淡出控制）；
    · 取消/重试直接调主进程（组件只抛事件，IPC 在 store 里）。
-->

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useTasksStore } from '@/app/store/tasks.store.ts'
import { useUiStore } from '@/app/store/ui.store.ts'

const router = useRouter()
const tasks = useTasksStore()
const ui = useUiStore()

onMounted(() => {
  // 启动时拉一次列表 + 订阅事件：窗口重建/崩溃恢复后仍能显示进行中的任务
  tasks.init()
  void tasks.refresh()
})

/** 展示顺序：进行中在前，失败次之，其余按创建时间倒序 */
const visible = computed(() => {
  const rank = (status: string): number => {
    if (status === 'running' || status === 'queued' || status === 'waiting') return 0
    if (status === 'failed' || status === 'interrupted') return 1
    return 2
  }
  return [...tasks.records]
    .sort((a, b) => (rank(a.status) - rank(b.status)) || (b.createdAt - a.createdAt))
    .slice(0, 6)
})

const collapsed = computed(() => ui.dockCollapsed)

async function onCancel(taskId: string): Promise<void> {
  await tasks.cancel(taskId)
}

async function onRetry(taskId: string): Promise<void> {
  await tasks.retry(taskId)
}

function onOpen(taskId: string): void {
  void router.push({ path: '/tasks', query: { taskId } })
}

function onClose(taskId: string): void {
  tasks.records = tasks.records.filter(r => r.id !== taskId)
}
</script>

<template>
  <div class="ns-dock" :class="{ 'ns-dock--collapsed': collapsed }">
    <button type="button" class="ns-dock__head" @click="ui.toggleDock()">
      <span class="ns-dock__title">任务</span>
      <span v-if="tasks.runningCount" class="ns-dock__count">{{ tasks.runningCount }}</span>
      <span v-else-if="tasks.hasFailure" class="ns-dock__count ns-dock__count--alert">!</span>
      <span class="ns-dock__chevron" aria-hidden="true">{{ collapsed ? '▲' : '▼' }}</span>
    </button>

    <div v-if="!collapsed" class="ns-dock__body">
      <p v-if="!visible.length" class="ns-dock__empty">当前没有任务</p>

      <TaskProgressCard
        v-for="record in visible"
        :key="record.id"
        :task-id="record.id"
        size="compact"
        :title="record.stage ?? undefined"
        :kind="record.kind"
        :status="record.status"
        :progress="tasks.progressOf(record.id)"
        :error-message="record.error"
        cancelable
        retryable
        closable
        @cancel="onCancel"
        @retry="onRetry"
        @open="onOpen"
        @close="onClose"
      />

      <button type="button" class="ns-dock__more" @click="router.push('/tasks')">打开任务中心</button>
    </div>
  </div>
</template>

<style scoped>
.ns-dock {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-height: 60vh;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 10px;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: 0 6px 24px rgb(0 0 0 / 12%);
  overflow: hidden;
}
.ns-dock--collapsed {
  width: 128px;
}
.ns-dock__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  border-bottom: 1px solid var(--ns-border, #dcdfe6);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.ns-dock__title {
  flex: 1;
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
  text-align: left;
}
.ns-dock__count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--ns-primary, #409eff);
  color: #fff;
  font-size: 11px;
}
.ns-dock__count--alert {
  background: var(--ns-danger, #f56c6c);
}
.ns-dock__chevron {
  color: var(--ns-text-secondary, #909399);
}
.ns-dock__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow-y: auto;
}
.ns-dock__empty {
  margin: 0;
  padding: 8px 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  text-align: center;
}
.ns-dock__more {
  padding: 5px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 6px;
  background: transparent;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  cursor: pointer;
}
</style>
