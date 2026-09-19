<!--
  Novel Studio · 错误边界（路由级渲染错误的兜底）
  ============================================================================
  设计文档：docs/22-错误码与消息体系.md §5 三级兜底

  用途：包住路由视图。当某个页面的渲染/生命周期抛错时，
  只让这一块区域退化，而不是整页白屏。

  <router-view v-slot="{ Component }">
    <ErrorBoundary>
      <component :is="Component" />
    </ErrorBoundary>
  </router-view>

  行为：
    · onErrorCaptured 捕获子树异常 → 交给 error-bus 统一兑现（文案/分级/日志一致）
    · errorCaptured 返回 false 阻止继续向上冒泡（避免同时触发全局钩子造成双弹）
    · 展示兜底 UI（标题 + 编号 + 重试/刷新 + 开发期详情）
    · 路由切换时自动复位（否则报错页会粘住不切走）
-->

<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { AppError, resolve } from '@shared/errors.ts'
import type { DisplayableError } from '@shared/errors.ts'
import { reportError } from '@/shared/lib/error-bus.ts'
import { staleModuleHint } from '@/shared/lib/stale-module-hint.ts'

const props = withDefaults(defineProps<{
  /** 兜底区最小高度，避免内容过少时页面跳动 */
  minHeight?: string
  /** 是否把错误同时交给全局展示（默认 false：由本组件自己渲染，避免双弹） */
  alsoReportGlobally?: boolean
}>(), {
  minHeight: '320px',
  alsoReportGlobally: false,
})

const route = useRoute()
const failure = ref<DisplayableError | null>(null)
const technical = ref<string | null>(null)
/** 开发期「热更新没同步」提示（见 stale-module-hint.ts；生产构建里恒为 null） */
const devHint = ref<string | null>(null)

/** 是否开发模式：决定是否展示技术细节 */
const isDev = import.meta.env.DEV

onErrorCaptured((err, instance, info) => {
  const appErr = err instanceof AppError
    ? err
    : new AppError('UI_RENDER_ERROR', {
        cause: err,
        details: {
          info,
          component: (instance?.$options as { name?: string } | undefined)?.name,
          route: route.fullPath,
        },
      })

  // 1) 统一兑现为可渲染消息（含编号，方便报障）
  failure.value = resolve(appErr, { includeDev: isDev })
  devHint.value = staleModuleHint({
    message: err instanceof Error ? err.message : String(err),
    isDev,
  })

  // 2) 记日志（silent 时只落日志不弹提示）
  //    路由名可能是 symbol（vue-router 允许），拼进事件名必须显式 String()，
  //    否则插值会隐式调用 Symbol 的 toString 而抛 TypeError。
  const routeName = route.name === undefined || route.name === null ? 'unknown' : String(route.name)
  if (props.alsoReportGlobally) {
    reportError(appErr, { event: `renderer.boundary.${routeName}` })
  } else {
    reportError(appErr, { event: `renderer.boundary.${routeName}`, silent: true })
  }

  // 3) 开发期保留原始信息，便于定位
  if (isDev) {
    technical.value = [
      appErr.key,
      appErr.causeChain.join(' → '),
      appErr.stack,
    ].filter(Boolean).join('\n')
  }

  // 阻止继续冒泡：否则全局 errorHandler 与 unhandledrejection 也会各报一次
  return false
})

/** 路由变化即复位，避免用户切到别的页面还看到报错页 */
watch(() => route.fullPath, () => {
  failure.value = null
  technical.value = null
  devHint.value = null
})

function retry(): void {
  failure.value = null
  technical.value = null
  devHint.value = null
}

function reload(): void {
  window.location.reload()
}
</script>

<template>
  <!-- 正常状态：直接渲染子内容 -->
  <slot v-if="!failure" />

  <!-- 兜底状态 -->
  <div v-else class="ns-error-boundary" :style="{ minHeight: props.minHeight }">
    <div class="ns-error-boundary__icon" aria-hidden="true">⚠</div>

    <h2 class="ns-error-boundary__title">{{ failure.title }}</h2>

    <p v-if="failure.detail" class="ns-error-boundary__detail">{{ failure.detail }}</p>
    <p v-if="failure.hint" class="ns-error-boundary__hint">{{ failure.hint }}</p>
    <p v-if="devHint" class="ns-error-boundary__devhint">{{ devHint }}</p>

    <p class="ns-error-boundary__code">
      错误编号：<code>{{ failure.code }}</code>
      <span class="ns-error-boundary__code-hint">（反馈时请附上此编号）</span>
    </p>

    <div class="ns-error-boundary__actions">
      <button type="button" class="ns-btn ns-btn--primary" @click="retry">重试</button>
      <button type="button" class="ns-btn" @click="reload">刷新页面</button>
    </div>

    <details v-if="isDev && technical" class="ns-error-boundary__dev">
      <summary>开发信息</summary>
      <pre>{{ technical }}</pre>
    </details>
  </div>
</template>

<style scoped>
.ns-error-boundary {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 24px;
  text-align: center;
  color: var(--ns-text-primary, #303133);
}
.ns-error-boundary__icon {
  font-size: 40px;
  line-height: 1;
  color: var(--ns-warning, #e6a23c);
}
.ns-error-boundary__title {
  margin: 4px 0 0;
  font-size: 18px;
  font-weight: 600;
}
.ns-error-boundary__detail {
  margin: 0;
  max-width: 560px;
  color: var(--ns-text-regular, #606266);
  font-size: 14px;
  line-height: 1.6;
}
.ns-error-boundary__hint {
  margin: 0;
  max-width: 560px;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
  line-height: 1.6;
}
.ns-error-boundary__code {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
/* 开发期的「热更新没同步」提示：只在 dev 出现，措辞明确写清「刷新即可 / 刷新后仍报才是代码问题」 */
.ns-error-boundary__devhint {
  max-width: 620px;
  margin: 4px 0 0;
  padding: 8px 12px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
  text-align: left;
}
.ns-error-boundary__code code {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  font-family: ui-monospace, Consolas, monospace;
}
.ns-error-boundary__code-hint {
  margin-left: 6px;
}
.ns-error-boundary__actions {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}
.ns-btn {
  padding: 8px 18px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: #fff;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
  cursor: pointer;
}
.ns-btn:hover {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-btn--primary:hover {
  background: #66b1ff;
  color: #fff;
}
.ns-error-boundary__dev {
  width: 100%;
  max-width: 860px;
  margin-top: 20px;
  text-align: left;
  font-size: 12px;
  color: var(--ns-text-secondary, #909399);
}
.ns-error-boundary__dev pre {
  max-height: 260px;
  overflow: auto;
  padding: 10px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
