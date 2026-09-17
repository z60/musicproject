<!--
  书籍导入域 · 清洗报告面板（docs/10 §5 清洗规则 / §5.3 清洗报告 / §7.1 Step 4）
  ============================================================================
  设计依据：
    · docs/10 §5.1 —— 必须清洗项（广告行 / 导航行 / 网址水印 / 重复行 / 页码行 /
      零宽字符 / 全角空格 / 多余空行 / 行首尾空白 / 不换行空格）默认开启，可逐项关闭
    · docs/10 §5.2 —— 谨慎处理项（非相邻重复行 / 合并硬换行 / 繁简转换 / 去括号内容）
      默认关闭，开启需用户明确动作 —— 本组件对它们加红色风险标注
    · docs/10 §5.3 —— 「清洗删了什么必须看得见」：给出计数 + 「查看被删除的内容」列表
    · docs/10 §7.1 Step 4 —— 调整开关后**实时重算**（重算由父视图交给 useImportFlow
      的 300 ms 防抖，组件不自己发 IPC，避免一次改动触发两遍解析）
    · docs/22 §6.2 —— 本组件不弹提示、不自拼错误文案

  一处必须说清的边界：
    store 只提供「改开关 → 重算」这一条恢复路径（没有「逐条恢复被删行」的动作）。
    因此这里不假装能逐条恢复，而是明确告诉用户：要保住某一行，就关掉对应的清洗开关再重算。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CleanReport } from '@shared/types.ts'
import type { CleanReportDetail } from '@shared/text/clean.ts'
import { formatCount, formatInt } from '@/shared/lib/format.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { CLEAN_OPTION_DEFS, type CleanOptionKey } from '@/features/book/stores/import.store.ts'

const props = withDefaults(defineProps<{
  /** book:previewSplit 返回的 CleanReport（null = 还没解析过） */
  report?: CleanReport | null
  /** 超集详情（被删内容清单 / 按原因分组计数 / 警告），缺失时降级为只显示计数 */
  detail?: CleanReportDetail | null
  /** 清洗开关当前值（键名以 shared/text/clean.ts 的 CleanOptions 为准） */
  options?: Partial<Record<CleanOptionKey, boolean>>
  /** store.enabledCleanCount */
  enabledCount?: number
  /** store.removedLineCount：四类主要删除项之和 */
  removedLineCount?: number
  /** 解析/重算中 */
  busy?: boolean
  /** 当前切出的章节数（清洗过度会把章节标题一起删掉，用章数变化提醒） */
  draftCount?: number
  /** 全文清洗后剩余字数（report.remainingChars） */
  remainingChars?: number
}>(), {
  report: null,
  detail: null,
  options: () => ({}),
  enabledCount: 0,
  removedLineCount: 0,
  busy: false,
  draftCount: 0,
  remainingChars: 0,
})

const emit = defineEmits<{
  /** 切换单个清洗开关（父视图 → store.setCleanOption + flow.onCleanOptionsChanged） */
  'toggle-option': [key: CleanOptionKey, value: boolean]
  /** 恢复默认（必须全开、谨慎项全关） */
  'reset-options': []
  /** 请求按当前开关重算预览（父视图 → flow.onCleanOptionsChanged，300 ms 防抖） */
  changed: []
}>()

/** 被删内容抽屉 */
const drawerOpen = ref(false)
/** 抽屉里的筛选：只按原因看（内容可能上千条，必须能筛） */
const reasonFilter = ref<string>('all')

const defs = CLEAN_OPTION_DEFS

const mustDefs = computed(() => defs.filter(def => !def.caution))
const cautionDefs = computed(() => defs.filter(def => def.caution))

function isOn(key: CleanOptionKey): boolean {
  return props.options[key] === true
}

function onToggle(key: CleanOptionKey, event: Event): void {
  const value = (event.target as HTMLInputElement).checked
  emit('toggle-option', key, value)
  // 改开关要立刻看到新的报告（docs/10 §7.1 Step 4）
  emit('changed')
}

/** 计数卡片：字段名 → 展示（字段以 docs/10 §5.3 的 CleanReport 为准） */
const counterItems = computed(() => {
  const report = props.report
  if (!report) return []
  return [
    { key: 'ad', label: '站点广告行', value: report.removedAdLines, hint: '命中 AD_LINE_PATTERNS 关键词' },
    { key: 'dup', label: '重复行', value: report.removedDuplicateLines, hint: '±5 行窗口内的完全重复' },
    { key: 'page', label: '页码行', value: report.removedPageNumberLines, hint: '第 12 页 / - 12 - / 纯数字行' },
    { key: 'zw', label: '零宽字符', value: report.removedZeroWidthChars, hint: 'U+200B~U+200F 等不可见字符' },
    { key: 'nl', label: '换行归一', value: report.normalizedNewlines, hint: '连续换行被压缩的处数' },
  ]
})

/** 被删内容列表（契约超集；没有时用 suspiciousLines 兜底，让人至少能看到可疑行） */
const removedLines = computed(() => props.detail?.removedLines ?? [])
const suspiciousLines = computed(() => props.report?.suspiciousLines ?? [])

const reasonOptions = computed(() => {
  const set = new Map<string, number>()
  for (const line of removedLines.value) set.set(line.reason, (set.get(line.reason) ?? 0) + 1)
  return [...set.entries()].map(([reason, count]) => ({ reason, count }))
})

const filteredRemovedLines = computed(() => {
  if (reasonFilter.value === 'all') return removedLines.value
  return removedLines.value.filter(line => line.reason === reasonFilter.value)
})

const hasDetail = computed(() => !!props.detail)
const warnings = computed(() => props.detail?.warnings ?? [])

function openDrawer(): void {
  reasonFilter.value = 'all'
  drawerOpen.value = true
}

/** 恢复默认开关（必须项全开、谨慎项全关），并立刻重算 */
function onResetOptions(): void {
  emit('reset-options')
  emit('changed')
}

/** 报告缺失时的动线：请求父视图再跑一次解析预览 */
function onRequestParse(): void {
  emit('changed')
}
</script>

<template>
  <section class="clean">
    <EmptyState
      v-if="!report"
      title="还没有清洗报告"
      description="清洗报告来自解析结果（book:previewSplit）。先在第 2 步完成解析，这里就会显示「删了什么、剩多少」。"
      icon="🧹"
      size="small"
      action-text="回到第 2 步解析"
      @action="onRequestParse"
    />

    <template v-else>
      <!-- 汇总：删了什么 / 剩多少 -->
      <header class="clean__head">
        <div>
          <h3 class="clean__title">清洗报告</h3>
          <p class="clean__sub">
            已启用 {{ formatInt(enabledCount) }} / {{ formatInt(defs.length) }} 项 ·
            共删除或归一笔 {{ formatInt(removedLineCount) }} 处 ·
            剩余 {{ formatCount(remainingChars || report.remainingChars) }}字 ·
            当前切出 {{ formatInt(draftCount) }} 章
          </p>
        </div>
        <div class="clean__head-actions">
          <button type="button" class="ns-btn" :disabled="busy" @click="onResetOptions">
            恢复默认（必须项全开）
          </button>
          <button type="button" class="ns-btn ns-btn--primary" :disabled="busy" @click="openDrawer">
            查看被删内容（{{ formatInt(removedLines.length || suspiciousLines.length) }}）
          </button>
        </div>
      </header>

      <div class="clean__counters">
        <div v-for="item in counterItems" :key="item.key" class="clean__counter" :title="item.hint">
          <span class="clean__counter-value">{{ formatInt(item.value) }}</span>
          <span class="clean__counter-label">{{ item.label }}</span>
        </div>
      </div>

      <p v-if="busy" class="clean__busy">正在按新的清洗开关重算预览，请稍候…（大文件可能需要几十秒）</p>

      <!-- 必须清洗项（docs/10 §5.1） -->
      <fieldset class="clean__group">
        <legend class="clean__legend">必须清洗（默认开启，可关）</legend>
        <label v-for="def in mustDefs" :key="def.key" class="clean__option">
          <input
            type="checkbox"
            :checked="isOn(def.key)"
            :disabled="busy"
            @change="onToggle(def.key, $event)"
          >
          <span class="clean__option-label">{{ def.label }}</span>
          <span class="clean__option-hint">{{ def.hint }}</span>
        </label>
      </fieldset>

      <!-- 谨慎处理项（docs/10 §5.2）：默认关闭，开启会改原文 -->
      <fieldset class="clean__group clean__group--caution">
        <legend class="clean__legend">谨慎处理（默认关闭，开启前请确认）</legend>
        <p class="clean__caution-note">
          这些开关会改变原文语义（删掉作者注释、合并对白、改写字形），
          开启后请在第 5 步逐章核对正文。
        </p>
        <label v-for="def in cautionDefs" :key="def.key" class="clean__option clean__option--caution">
          <input
            type="checkbox"
            :checked="isOn(def.key)"
            :disabled="busy"
            @change="onToggle(def.key, $event)"
          >
          <span class="clean__option-label">{{ def.label }}</span>
          <span class="clean__option-hint">{{ def.hint }}</span>
        </label>
      </fieldset>

      <!-- 主进程给的分组计数与告警 -->
      <div v-if="hasDetail" class="clean__detail-summary">
        <p v-if="detail?.removedLinesTruncated" class="clean__note">
          被删内容清单已截断展示（计数仍然精确）：只列出前 {{ formatInt(removedLines.length) }} 条。
        </p>
        <p class="clean__note">
          按原因分组：
          <span v-for="(count, reason) in detail?.removedByReason ?? {}" :key="reason" class="clean__reason-chip">
            {{ reason }} {{ formatInt(count) }}
          </span>
        </p>
        <p class="clean__note">
          谨慎项实际生效：合并硬换行 {{ formatInt(detail?.mergedHardWrapLines ?? 0) }} 处 ·
          压缩连续空行 {{ formatInt(detail?.collapsedBlankRuns ?? 0) }} 处 ·
          空格归一 {{ formatInt(detail?.normalizedSpaces ?? 0) }} 处
        </p>
        <ul v-if="warnings.length" class="clean__warnings">
          <li v-for="(warning, index) in warnings" :key="index">{{ warning }}</li>
        </ul>
      </div>

      <p class="clean__restore-hint">
        需要保住某一行？关闭对应的清洗开关后本页会自动重算（例如把「页码行」关掉可保住纯数字章节标题）。
        逐条恢复被删行不在导入阶段提供 —— 导入完成后可在章节列表里直接编辑正文。
      </p>
    </template>

    <!-- 被删内容抽屉 -->
    <Teleport to="body">
      <div v-if="drawerOpen" class="clean-drawer" role="dialog" aria-modal="true">
        <div class="clean-drawer__mask" @click="drawerOpen = false" />
        <aside class="clean-drawer__panel">
          <header class="clean-drawer__head">
            <h3 class="clean-drawer__title">被删内容</h3>
            <button type="button" class="ns-btn ns-btn--small" @click="drawerOpen = false">关闭</button>
          </header>

          <div class="clean-drawer__filter">
            <button
              type="button"
              class="ns-btn ns-btn--small"
              :class="{ 'ns-btn--active': reasonFilter === 'all' }"
              @click="reasonFilter = 'all'"
            >
              全部 {{ formatInt(removedLines.length) }}
            </button>
            <button
              v-for="option in reasonOptions"
              :key="option.reason"
              type="button"
              class="ns-btn ns-btn--small"
              :class="{ 'ns-btn--active': reasonFilter === option.reason }"
              @click="reasonFilter = option.reason"
            >
              {{ option.reason }} {{ formatInt(option.count) }}
            </button>
          </div>

          <div class="clean-drawer__body">
            <table v-if="removedLines.length" class="clean-drawer__table">
              <thead>
                <tr>
                  <th class="clean-drawer__col-no">行号</th>
                  <th>被删内容</th>
                  <th class="clean-drawer__col-reason">原因</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="line in filteredRemovedLines" :key="`${line.lineNo}-${line.reason}`">
                  <td class="clean-drawer__col-no">{{ formatInt(line.lineNo) }}</td>
                  <td class="clean-drawer__text">{{ line.text }}</td>
                  <td class="clean-drawer__col-reason">{{ line.reasonText }}</td>
                </tr>
              </tbody>
            </table>

            <table v-else-if="suspiciousLines.length" class="clean-drawer__table">
              <thead>
                <tr>
                  <th class="clean-drawer__col-no">行号</th>
                  <th>可疑内容</th>
                  <th class="clean-drawer__col-reason">原因</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="line in suspiciousLines" :key="line.lineNo">
                  <td class="clean-drawer__col-no">{{ formatInt(line.lineNo) }}</td>
                  <td class="clean-drawer__text">{{ line.text }}</td>
                  <td class="clean-drawer__col-reason">{{ line.reason }}</td>
                </tr>
              </tbody>
            </table>

            <p v-else class="clean-drawer__empty">
              这次解析没有记录被删内容（可能本文件很干净，或主进程未返回明细）。
              计数仍然有效，见上一页的清洗报告。
            </p>
          </div>
        </aside>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.clean {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.clean__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.clean__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
}
.clean__sub {
  margin: 6px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.clean__head-actions {
  display: flex;
  gap: 8px;
}
.clean__counters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.clean__counter {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.clean__counter-value {
  color: var(--ns-text-primary, #303133);
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.clean__counter-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.clean__busy {
  margin: 0;
  color: var(--ns-primary, #409eff);
  font-size: 12px;
}
.clean__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 10px 14px 14px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
}
.clean__group--caution {
  border-color: rgb(230 162 60 / 45%);
  background: rgb(230 162 60 / 6%);
}
.clean__legend {
  padding: 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.clean__option {
  display: grid;
  grid-template-columns: 20px 160px 1fr;
  align-items: baseline;
  gap: 6px;
  padding: 3px 0;
  font-size: 13px;
}
.clean__option-label {
  color: var(--ns-text-primary, #303133);
}
.clean__option--caution .clean__option-label {
  color: var(--ns-warning, #e6a23c);
}
.clean__option-hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.clean__caution-note {
  margin: 0 0 4px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.6;
}
.clean__detail-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.clean__note {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.6;
}
.clean__reason-chip {
  display: inline-block;
  margin: 0 6px 4px 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--ns-fill-light, #f5f7fa);
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
.clean__warnings {
  margin: 0;
  padding-left: 20px;
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.7;
}
.clean__restore-hint {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ns-primary, #409eff);
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.6;
}
.clean-drawer {
  position: fixed;
  inset: 0;
  z-index: 2600;
  display: flex;
  justify-content: flex-end;
}
.clean-drawer__mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 35%);
}
.clean-drawer__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(640px, 92vw);
  height: 100%;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: -6px 0 24px rgb(0 0 0 / 16%);
}
.clean-drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
}
.clean-drawer__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
}
.clean-drawer__filter {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
}
.clean-drawer__body {
  flex: 1;
  overflow: auto;
  padding: 0 16px 16px;
}
.clean-drawer__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.clean-drawer__table th,
.clean-drawer__table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  text-align: left;
  vertical-align: top;
}
.clean-drawer__table th {
  position: sticky;
  top: 0;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-weight: 500;
}
.clean-drawer__col-no {
  width: 64px;
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.clean-drawer__col-reason {
  width: 140px;
  color: var(--ns-text-secondary, #909399);
}
.clean-drawer__text {
  color: var(--ns-text-primary, #303133);
  word-break: break-all;
}
.clean-drawer__empty {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-btn {
  padding: 6px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn--small {
  padding: 4px 10px;
  font-size: 12px;
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-btn--active {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 12%);
  color: var(--ns-primary, #409eff);
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
