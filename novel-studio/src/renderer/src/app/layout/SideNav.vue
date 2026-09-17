<!--
  Novel Studio · 侧边导航
  ============================================================================
  设计依据：
    · docs/README §4 / docs/01 §3.2 —— 功能域划分（书架 → 画本 → 录音 → 对轨 → 混音导出）
    · docs/00 主链 —— 六步流程就是导航顺序，用户按顺序往下走不会迷路
    · docs/04 §2.4 —— 任务中心是全局入口（不是某个功能域的子页）

  设计要点：
    · 导航按「主链顺序」排列，并显示当前书/章的上下文（无书时后几步提示先导入）；
    · 折叠态只留图标，宽度动画不影响内容区（用 CSS 变量控制）；
    · 录音页激活时会接管快捷键，导航仍可用（不阻断用户切页，但会提示）。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useTasksStore } from '@/app/store/tasks.store.ts'
import { useUiStore } from '@/app/store/ui.store.ts'

interface NavItem {
  name: string
  path: string
  label: string
  icon: string
  /** 需要先选中书籍才可用 */
  needsBook?: boolean
  /** 需要先选中章节才可用 */
  needsChapter?: boolean
  /** 分组标题（在主链里做视觉分段） */
  group: 'prepare' | 'work' | 'deliver' | 'system'
}

const items: NavItem[] = [
  { name: 'bookshelf', path: '/bookshelf', label: '书架', icon: '📚', group: 'prepare' },
  { name: 'import', path: '/import', label: '导入向导', icon: '📥', group: 'prepare' },
  { name: 'chapters', path: '/chapters', label: '章节管理', icon: '🗂', needsBook: true, group: 'prepare' },

  { name: 'canvas', path: '/canvas', label: '画本编辑', icon: '📝', needsChapter: true, group: 'work' },
  { name: 'recording', path: '/recording', label: '录音', icon: '🎙', needsChapter: true, group: 'work' },
  { name: 'alignment', path: '/alignment', label: '对轨', icon: '🎚', needsChapter: true, group: 'work' },

  { name: 'mixer', path: '/mixing', label: '混音台', icon: '🎛', needsChapter: true, group: 'deliver' },
  { name: 'export', path: '/export', label: '导出向导', icon: '📤', needsBook: true, group: 'deliver' },

  { name: 'tasks', path: '/tasks', label: '任务中心', icon: '⏱', group: 'system' },
  { name: 'settings', path: '/settings', label: '设置', icon: '⚙', group: 'system' },
  { name: 'help', path: '/help', label: '帮助', icon: '❓', group: 'system' },
]

const GROUP_LABELS: Record<NavItem['group'], string> = {
  prepare: '准备',
  work: '创作',
  deliver: '交付',
  system: '系统',
}

const route = useRoute()
const session = useSessionStore()
const tasks = useTasksStore()
const ui = useUiStore()

const collapsed = computed(() => ui.sidebarCollapsed)

const grouped = computed(() => {
  const groups: Array<{ key: NavItem['group']; label: string; items: NavItem[] }> = []
  for (const item of items) {
    let group = groups.find(g => g.key === item.group)
    if (!group) {
      group = { key: item.group, label: GROUP_LABELS[item.group], items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
})

function isActive(item: NavItem): boolean {
  return route.path === item.path || route.path.startsWith(`${item.path}/`)
}

/** 前置条件不满足时给出原因（而不是把入口藏起来，用户会以为功能不存在） */
function blockReason(item: NavItem): string | null {
  if (item.needsChapter && !session.hasChapter) return '请先在书架选择一本书并打开某一章'
  if (item.needsBook && !session.hasBook) return '请先在书架选择一本书'
  return null
}

const taskBadge = computed(() => tasks.runningCount)
const taskAlert = computed(() => tasks.hasFailure)
</script>

<template>
  <nav class="ns-nav" :class="{ 'ns-nav--collapsed': collapsed }" aria-label="主导航">
    <div class="ns-nav__brand">
      <span class="ns-nav__logo" aria-hidden="true">🎧</span>
      <span v-if="!collapsed" class="ns-nav__brand-text">
        <strong>Novel Studio</strong>
        <small>有声画本工作站</small>
      </span>
    </div>

    <div v-for="group in grouped" :key="group.key" class="ns-nav__group">
      <p v-if="!collapsed" class="ns-nav__group-title">{{ group.label }}</p>

      <template v-for="item in group.items" :key="item.name">
        <RouterLink
          v-if="!blockReason(item)"
          class="ns-nav__item"
          :class="{ 'is-active': isActive(item) }"
          :to="item.path"
          :title="collapsed ? item.label : undefined"
        >
          <span class="ns-nav__icon" aria-hidden="true">{{ item.icon }}</span>
          <span v-if="!collapsed" class="ns-nav__label">{{ item.label }}</span>

          <span v-if="item.name === 'tasks' && taskBadge > 0" class="ns-nav__badge">{{ taskBadge }}</span>
          <span
            v-else-if="item.name === 'tasks' && taskAlert"
            class="ns-nav__badge ns-nav__badge--alert"
          >!</span>
        </RouterLink>

        <span
          v-else
          class="ns-nav__item ns-nav__item--disabled"
          :title="blockReason(item) ?? ''"
        >
          <span class="ns-nav__icon" aria-hidden="true">{{ item.icon }}</span>
          <span v-if="!collapsed" class="ns-nav__label">{{ item.label }}</span>
          <span v-if="!collapsed" class="ns-nav__lock" aria-hidden="true">🔒</span>
        </span>
      </template>
    </div>

    <div class="ns-nav__foot">
      <button type="button" class="ns-nav__toggle" @click="ui.toggleSidebar()">
        {{ collapsed ? '»' : '« 收起' }}
      </button>
    </div>
  </nav>
</template>

<style scoped>
.ns-nav {
  display: flex;
  flex-direction: column;
  width: 208px;
  padding: 10px 8px;
  overflow-y: auto;
  border-right: 1px solid var(--ns-border, #dcdfe6);
  background: var(--ns-bg-elevated, #fff);
  transition: width 0.16s ease;
}
.ns-nav--collapsed {
  width: 56px;
  padding: 10px 6px;
}
.ns-nav__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 12px;
}
.ns-nav__logo {
  font-size: 20px;
}
.ns-nav__brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.ns-nav__brand-text strong {
  font-size: 13px;
}
.ns-nav__brand-text small {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-nav__group {
  margin-bottom: 6px;
}
.ns-nav__group-title {
  margin: 8px 8px 4px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  letter-spacing: 0.04em;
}
.ns-nav__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
}
.ns-nav__item:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-nav__item.is-active {
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
  font-weight: 600;
}
.ns-nav__item--disabled {
  color: var(--ns-text-placeholder, #c0c4cc);
  cursor: not-allowed;
}
.ns-nav__icon {
  width: 18px;
  text-align: center;
}
.ns-nav__label {
  flex: 1;
}
.ns-nav__lock {
  font-size: 11px;
}
.ns-nav__badge {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--ns-primary, #409eff);
  color: #fff;
  font-size: 11px;
  text-align: center;
}
.ns-nav__badge--alert {
  background: var(--ns-danger, #f56c6c);
}
.ns-nav__foot {
  margin-top: auto;
  padding-top: 8px;
}
.ns-nav__toggle {
  width: 100%;
  padding: 5px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: transparent;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  cursor: pointer;
}
</style>
