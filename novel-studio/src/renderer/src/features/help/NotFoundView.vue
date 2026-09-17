<!--
  Novel Studio · 路由兜底页（/settings /tasks /help 之外的未知路径）
  ============================================================================
  设计依据：
    · docs/22 §5 —— 三级兜底：路由级渲染错误由 ErrorBoundary 兜住；
      而「路径根本不存在」是第四种情况，必须**明确告知**，不能静默重定向 ——
      静默跳回书架会让用户以为「点了没反应」，链接坏了也永远发现不了。
    · docs/02 §6 —— 打包后旧书签/旧深链可能指向已经改名或移除的页面
      （构建产物更新后旧 chunk 地址也会失效），因此这里要把「当前路径与来源」显示出来，
      方便用户报障时直接口述或截图。

  本页只读路由信息：route.fullPath / route.query / route.redirectedFrom，
  以及浏览器历史长度（判断能不能「回上一页」）。不做任何 IPC 调用。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EmptyState from '@/shared/ui/EmptyState.vue'

const route = useRoute()
const router = useRouter()

/** 当前路径（含 query 与 hash）：报障时要能一字不差地念出来 */
const fullPath = computed(() => route.fullPath)

/** 来源：路由重定向信息优先，其次是别处带过来的 redirect 参数 */
const from = computed(() => {
  const redirected = route.redirectedFrom?.fullPath
  if (redirected) return redirected
  const queryRedirect = route.query.redirect
  if (typeof queryRedirect === 'string' && queryRedirect) return queryRedirect
  return '直接访问（没有来源页面）'
})

const queryText = computed(() => {
  const query = route.query
  const keys = Object.keys(query)
  if (!keys.length) return '（无参数）'
  return keys.map(key => `${key}=${String(query[key])}`).join(' & ')
})

/** 历史里还有上一页时才能「回上一页」，否则按钮禁用并说明原因 */
const canGoBack = computed(() => (globalThis.history?.length ?? 1) > 1)

const REASONS = [
  '链接已过期：页面改名或入口位置调整过，旧链接会落到这里。',
  '地址输错了：路径大小写、拼写或多了一段。',
  '版本更新：应用升级后旧版本的书签/深链可能失效。',
  '前置条件不满足时不会跳到这里，而是会被引导到书架或章节列表（并带上回跳地址）。',
]

function goBookshelf(): void {
  void router.push('/bookshelf')
}

function goBack(): void {
  if (!canGoBack.value) return
  router.back()
}

function goHelp(): void {
  void router.push('/help')
}
</script>

<template>
  <div class="ns-notfound">
    <EmptyState
      icon="🧭"
      title="页面不存在或已被移除"
      description="没有找到与你访问的地址对应的页面。你的作品数据没有受到任何影响，可以安全地回到书架继续。"
    >
      <div class="ns-notfound__actions">
        <el-button type="primary" @click="goBookshelf">返回书架</el-button>
        <el-button :disabled="!canGoBack" @click="goBack">回上一页</el-button>
        <el-button @click="goHelp">打开帮助</el-button>
      </div>
    </EmptyState>

    <section class="ns-notfound__card">
      <h2 class="ns-notfound__title">当时访问的地址</h2>
      <dl class="ns-kv">
        <div class="ns-kv__row"><dt>当前路径</dt><dd class="ns-mono">{{ fullPath }}</dd></div>
        <div class="ns-kv__row"><dt>来源</dt><dd class="ns-mono">{{ from }}</dd></div>
        <div class="ns-kv__row"><dt>查询参数</dt><dd class="ns-mono">{{ queryText }}</dd></div>
        <div class="ns-kv__row">
          <dt>浏览器历史</dt>
          <dd>
            <template v-if="canGoBack">可以回退到上一页。</template>
            <template v-else>这是打开应用后的第一页，没有可回退的上一页（按钮已禁用）。</template>
          </dd>
        </div>
      </dl>
    </section>

    <section class="ns-notfound__card">
      <h2 class="ns-notfound__title">可能的原因</h2>
      <ul class="ns-notfound__list">
        <li v-for="(reason, index) in REASONS" :key="index">{{ reason }}</li>
      </ul>
      <p class="ns-notfound__note">
        如果这个地址是从「提示条」或帮助页跳过来的，那它多半是应用内部生成的旧链接：
        请把上面的「当前路径」连同提示里的错误编号一起反馈，方便定位是哪一处还在生成旧地址。
      </p>
    </section>
  </div>
</template>

<style scoped>
.ns-notfound {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.ns-notfound__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}
.ns-notfound__card {
  padding: 14px 16px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-notfound__title {
  margin: 0 0 8px;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
}
.ns-notfound__list {
  margin: 0;
  padding-left: 20px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.9;
}
.ns-notfound__note {
  margin: 8px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.8;
}
.ns-kv {
  margin: 0;
}
.ns-kv__row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.7;
}
.ns-kv__row dt {
  flex: 0 0 110px;
  color: var(--ns-text-secondary, #909399);
}
.ns-kv__row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ns-text-regular, #606266);
  word-break: break-all;
}
.ns-mono {
  font-family: ui-monospace, Consolas, monospace;
}
</style>
