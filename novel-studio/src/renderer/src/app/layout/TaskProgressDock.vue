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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
  restorePos()
  globalThis.addEventListener?.('resize', onViewportResize)
})

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('resize', onViewportResize)
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

/**
 * ---- 拖动 ----
 * 真机反馈：「任务模块 可以拖动，初期固定右下角」。
 * 默认仍是 CSS 的 right/bottom（右下角）；按住标题栏拖动后改为按 left/top 定位，
 * 位置记到 localStorage，重启后还在原地。拖动全程夹在视口内，不会拖出屏幕外找不回来。
 */
const STORAGE_KEY = 'ns.dock.pos'
const dockRef = ref<HTMLElement | null>(null)
/** null = 还没拖过，用 CSS 默认的右下角 */
const pos = ref<{ left: number; top: number } | null>(null)
const dragging = ref(false)
/** 拖动过就不该再触发「折叠」（否则拖完一松手面板自己合上） */
let suppressClick = false
const drag = { pointerId: -1, startX: 0, startY: 0, originLeft: 0, originTop: 0, moved: false }

const dockStyle = computed<Record<string, string>>(() => {
  if (!pos.value) return {} as Record<string, string>
  return {
    left: `${Math.round(pos.value.left)}px`,
    top: `${Math.round(pos.value.top)}px`,
    right: 'auto',
    bottom: 'auto',
  }
})

/** 夹在视口内：至少留 8px 可见，别拖出去找不回来 */
function clampPos(left: number, top: number): { left: number; top: number } {
  const rect = dockRef.value?.getBoundingClientRect()
  const w = rect?.width ?? 320
  const h = rect?.height ?? 240
  const vw = globalThis.innerWidth ?? 1280
  const vh = globalThis.innerHeight ?? 800
  const margin = 8
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, vw - w - margin)),
    top: Math.min(Math.max(margin, top), Math.max(margin, vh - h - margin)),
  }
}

function onHeadPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !dockRef.value) return
  const rect = dockRef.value.getBoundingClientRect()
  drag.pointerId = event.pointerId
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.originLeft = rect.left
  drag.originTop = rect.top
  drag.moved = false
  suppressClick = false
  dragging.value = true
  // 注意：这里**不**写 pos —— 单纯点一下（没拖动）不该把右下角的 CSS 定位换成绝对像素，
  // 否则「点一下折叠」之后窗口再变大，坞就不再贴着右下角了。
  // 真正越过死区时再按 origin + 总位移一次性定位（像素完全对得上，不会跳）。
  const head = event.currentTarget as HTMLElement | null
  head?.setPointerCapture?.(event.pointerId)
}

function onHeadPointerMove(event: PointerEvent): void {
  if (!dragging.value || event.pointerId !== drag.pointerId) return
  const dx = event.clientX - drag.startX
  const dy = event.clientY - drag.startY
  // 4px 死区：手抖不算拖动，别把「点一下折叠」吃掉
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true
  if (!drag.moved) return
  pos.value = clampPos(drag.originLeft + dx, drag.originTop + dy)
}

function onHeadPointerUp(event: PointerEvent): void {
  if (event.pointerId !== drag.pointerId) return
  dragging.value = false
  drag.pointerId = -1
  const head = event.currentTarget as HTMLElement | null
  head?.releasePointerCapture?.(event.pointerId)
  if (!drag.moved) return
  // 拖过：吞掉随后的 click，避免松手就折叠
  suppressClick = true
  if (pos.value) persistPos(pos.value)
}

/** 标题栏的点击：拖动结束那一下不当作点击 */
function onHeadClick(): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
  ui.toggleDock()
}

function persistPos(next: { left: number; top: number }): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 无 localStorage（隐私模式/测试环境）：位置不持久化，功能不受影响
  }
}

function restorePos(): void {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown }
    if (typeof parsed.left === 'number' && typeof parsed.top === 'number') {
      pos.value = clampPos(parsed.left, parsed.top)
    }
  } catch {
    // 数据坏了就当没存过
  }
}

/** 窗口尺寸变化后原来的位置可能跑到屏幕外，重新夹一次 */
function onViewportResize(): void {
  if (pos.value) pos.value = clampPos(pos.value.left, pos.value.top)
}

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
  <div
    ref="dockRef"
    class="ns-dock"
    :class="{ 'ns-dock--collapsed': collapsed, 'ns-dock--dragging': dragging }"
    :style="dockStyle"
  >
    <button
      type="button"
      class="ns-dock__head"
      title="按住可拖动，点一下折叠/展开"
      @pointerdown="onHeadPointerDown"
      @pointermove="onHeadPointerMove"
      @pointerup="onHeadPointerUp"
      @pointercancel="onHeadPointerUp"
      @click="onHeadClick"
    >
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
.ns-dock--dragging {
  /* 拖动中不要选中文字，也不要有过渡，跟手 */
  transition: none;
  user-select: none;
}
.ns-dock__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  /* 触屏/触控板拖动：别把拖动当成滚动 */
  touch-action: none;
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
