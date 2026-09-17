<!--
  Novel Studio · 布局壳
  ============================================================================
  设计依据：
    · docs/01 §3.2 —— app/ 负责应用装配（App.vue / main.ts / router.ts）
    · docs/04 §2.4 —— 全局只有一个任务进度区（TaskProgressDock）
    · docs/22 §7   —— fatal 错误必须阻断：这里渲染全局阻断遮罩（连导航一起挡住）

  结构：
    ┌ TopBar ───────────────────────────────────────────────┐
    │ 书名 · 章节 / 保存状态 / 任务 / 主题                   │
    ├ SideNav ┬ 内容区（路由视图 + 错误边界）────────────────┤
    │         │                                              │
    └─────────┴──────────┬───────────────────────────────────┘
                        └ TaskProgressDock（右下角，可折叠）
-->

<script setup lang="ts">
import { computed } from 'vue'
import TopBar from './TopBar.vue'
import SideNav from './SideNav.vue'
import TaskProgressDock from './TaskProgressDock.vue'
import { useUiStore } from '@/app/store/ui.store.ts'

const ui = useUiStore()
const blocked = computed(() => ui.isBlocked)

/** 模板里不能直接写 window.*（Vue 模板作用域只允许白名单全局），因此包成方法 */
function reloadPage(): void {
  globalThis.location?.reload()
}
</script>

<template>
  <div class="ns-shell" :class="{ 'is-blocked': blocked }">
    <TopBar class="ns-shell__top" />

    <div class="ns-shell__body">
      <SideNav class="ns-shell__nav" />

      <main class="ns-shell__main" :aria-busy="blocked">
        <!-- 路由视图由 App.vue 通过默认插槽传入（错误边界包在外层） -->
        <slot />
      </main>
    </div>

    <!-- 全局任务进度区：禁止各功能自建进度 UI（docs/04 §2.4） -->
    <TaskProgressDock />

    <!-- fatal 阻断遮罩：数据库损坏 / 磁盘满 / 录音写入失败（docs/22 §7） -->
    <div v-if="blocked && ui.fatal" class="ns-shell__blocker" role="alertdialog" aria-modal="true">
      <div class="ns-shell__blocker-card">
        <h2 class="ns-shell__blocker-title">{{ ui.fatal.title }}</h2>
        <p v-if="ui.fatal.detail" class="ns-shell__blocker-detail">{{ ui.fatal.detail }}</p>
        <p v-if="ui.fatal.hint" class="ns-shell__blocker-hint">{{ ui.fatal.hint }}</p>
        <p class="ns-shell__blocker-code">
          错误编号：<code>{{ ui.fatal.code }}</code>
        </p>
        <div class="ns-shell__blocker-actions">
          <button type="button" class="ns-btn" @click="ui.clearFatal()">我已处理，继续</button>
          <button type="button" class="ns-btn ns-btn--primary" @click="reloadPage">重新加载</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ns-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--ns-bg, #f5f7fa);
  color: var(--ns-text-primary, #303133);
}
.ns-shell__top {
  flex: 0 0 auto;
}
.ns-shell__body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.ns-shell__nav {
  flex: 0 0 auto;
}
.ns-shell__main {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.ns-shell__blocker {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 55%);
}
.ns-shell__blocker-card {
  max-width: 520px;
  padding: 24px 28px;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 40px rgb(0 0 0 / 30%);
}
.ns-shell__blocker-title {
  margin: 0 0 8px;
  color: var(--ns-danger, #f56c6c);
  font-size: 18px;
}
.ns-shell__blocker-detail,
.ns-shell__blocker-hint {
  margin: 0 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 14px;
  line-height: 1.6;
}
.ns-shell__blocker-hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
}
.ns-shell__blocker-code {
  margin: 10px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-shell__blocker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
.ns-shell.is-blocked .ns-shell__body {
  pointer-events: none;
  filter: grayscale(0.15);
}
.ns-btn {
  padding: 7px 16px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: #fff;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
</style>
