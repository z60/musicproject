<!--
  书籍导入域 · 章节草稿表（docs/10 §6.6 分章结果 / §7.1 Step 5）
  ============================================================================
  设计依据：
    · docs/10 §7.1 —— Step 5「章节列表（人工干预：改名/合并/拆分/删除/勾选）」，
      且**必须能预览章节正文（右侧抽屉）**，否则用户无法判断合并是否正确
    · docs/10 §7.1 —— 章标题支持**批量前缀/后缀增删**（如统一加「斗破苍穹·」）
    · docs/10 §7.1 —— 排序支持拖拽 + 「按标题中的数字排序」（正则切出来的顺序可能是乱的）
    · docs/10 §6.6 —— 分章结果结构（tempId/index/title/rawText/charCount/
      estimatedDurationMs/kind/startOffset/endOffset/included）
    · docs/00 非功能指标 —— 长列表必须虚拟滚动：一本 3000 章的书不能把 DOM 撑爆
    · docs/10 §7.1 —— 删除必须可恢复（store.removedDrafts 提供恢复入口），不静默删用户的东西

  实现约定：
    · 虚拟滚动用 shared/lib/virtual-list.ts 的 computeVisibleRange（仓库唯一实现，不自己写一套）；
    · 本组件**不直接调 IPC**：所有改动都 emit 给父视图（→ stores/import.store.ts 的纯本地变换）。
-->

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChapterDraft } from '@shared/types.ts'
import { formatCount, formatDuration, formatInt } from '@/shared/lib/format.ts'
import { computeVisibleRange } from '@/shared/lib/virtual-list.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'

const props = withDefaults(defineProps<{
  /** 解析出来的章节草稿（含勾选态） */
  drafts?: ChapterDraft[]
  /** 已勾选章数 / 全文总字数 / 已勾选字数 / 已勾选预估时长 */
  includedCount?: number
  totalChars?: number
  includedChars?: number
  includedDurationMs?: number
  /** 被删除的草稿（可恢复） */
  removedDrafts?: Array<{ draft: ChapterDraft; at: number }>
  /** 抽屉里正在预览的草稿（由父视图把它传回来，保证与 store 同步） */
  previewDraft?: ChapterDraft | null
  /** 章节切分可疑 / 分章告警 / 是否已人工改动过 */
  suspiciousSplit?: boolean
  splitWarnings?: string[]
  draftsEdited?: boolean
  /** 解析中 */
  busy?: boolean
  /** 单章异常长提示（store.longestDraft） */
  longestDraft?: ChapterDraft | null
}>(), {
  drafts: () => [],
  includedCount: 0,
  totalChars: 0,
  includedChars: 0,
  includedDurationMs: 0,
  removedDrafts: () => [],
  previewDraft: null,
  suspiciousSplit: false,
  splitWarnings: () => [],
  draftsEdited: false,
  busy: false,
  longestDraft: null,
})

const emit = defineEmits<{
  /** 改单章标题 */
  rename: [tempId: string, title: string]
  /** 勾选 / 取消勾选一章（included） */
  toggle: [tempId: string]
  /** 全选 / 全不选 */
  'set-all': [included: boolean]
  /** 反选 */
  invert: []
  /** 上移 / 下移（delta = ±1） */
  move: [tempId: string, delta: number]
  /** 拖拽落位：把 from 处的草稿放到 to 处 */
  drop: [from: number, to: number]
  /** 按标题中的数字排序 */
  'sort-by-number': []
  /** 删除（可恢复） */
  remove: [tempId: string]
  /** 恢复某一条被删除的草稿 */
  restore: [tempId: string]
  /** 恢复全部被删除的草稿 */
  'restore-all': []
  /** 批量加/去前缀后缀 */
  affix: [payload: { affix: string; position: 'prefix' | 'suffix'; action: 'add' | 'remove' }]
  /** 打开 / 关闭右侧正文抽屉 */
  'open-preview': [tempId: string]
  'close-preview': []
  /** 请求合并选中的若干章（父视图弹 ChapterMergeDialog） */
  'merge-request': [tempIds: string[]]
  /** 请求拆分某一章（父视图弹 ChapterMergeDialog 的拆分模式） */
  'split-request': [tempId: string]
}>()

// ── 虚拟滚动 ───────────────────────────────────────────────────────────────
/** 行高固定：虚拟滚动按等高计算（标题换行会破坏等高，因此用 nowrap + 省略号） */
const ROW_HEIGHT = 46
const scrollEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)

const range = computed(() => computeVisibleRange({
  scrollTop: scrollTop.value,
  viewportHeight: viewportHeight.value,
  rowHeight: ROW_HEIGHT,
  total: props.drafts.length,
  overscan: 6,
}))

const windowRows = computed(() => {
  const { startIndex, endIndex } = range.value
  if (endIndex < startIndex) return []
  return props.drafts.slice(startIndex, endIndex + 1).map((draft, i) => ({
    draft,
    index: startIndex + i,
  }))
})

function onScroll(): void {
  scrollTop.value = scrollEl.value?.scrollTop ?? 0
}

function measure(): void {
  viewportHeight.value = scrollEl.value?.clientHeight ?? 0
}

onMounted(() => {
  measure()
  globalThis.addEventListener?.('resize', measure)
})

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('resize', measure)
})

// ── 本地状态 ───────────────────────────────────────────────────────────────
/** 合并用的多选（与 included 是两件事：included = 要不要导入，selected = 要合并哪几章） */
const selectedIds = ref<string[]>([])
/** 行内改名 */
const editingId = ref<string | null>(null)
const titleDraft = ref('')
/** 批量前后缀表单 */
const affixText = ref('')
const affixPosition = ref<'prefix' | 'suffix'>('prefix')
/** 最近一次点击的行（Shift 范围选择锚点） */
let anchorIndex = -1

const selectedCount = computed(() => selectedIds.value.length)
const canMerge = computed(() => selectedIds.value.length >= 2)
/** 相邻性检查：合并非相邻章节在预览期没有明确语义，直接禁用并说明原因 */
const selectedIndexes = computed(() => props.drafts
  .map((draft, index) => (selectedIds.value.includes(draft.tempId) ? index : -1))
  .filter(index => index >= 0))
const contiguous = computed(() => {
  const indexes = selectedIndexes.value
  return indexes.length >= 2 && indexes[indexes.length - 1]! - indexes[0]! === indexes.length - 1
})

function isSelected(tempId: string): boolean {
  return selectedIds.value.includes(tempId)
}

function onRowCheck(index: number, event: Event): void {
  const tempId = props.drafts[index]?.tempId
  if (!tempId) return
  const checked = (event.target as HTMLInputElement).checked
  const shift = (event as MouseEvent).shiftKey === true
  if (shift && anchorIndex >= 0) {
    const from = Math.min(anchorIndex, index)
    const to = Math.max(anchorIndex, index)
    const rangeIds = props.drafts.slice(from, to + 1).map(draft => draft.tempId)
    const next = new Set(selectedIds.value)
    for (const id of rangeIds) {
      if (checked) next.add(id)
      else next.delete(id)
    }
    selectedIds.value = [...next]
  } else {
    const next = new Set(selectedIds.value)
    if (checked) next.add(tempId)
    else next.delete(tempId)
    selectedIds.value = [...next]
    anchorIndex = index
  }
}

function clearSelection(): void {
  selectedIds.value = []
  anchorIndex = -1
}

/**
 * 草稿集合变化（合并 / 拆分 / 删除 / 重新解析）后剪掉失效的选择。
 * 不做这一步的话，合并后的 tempId 变化会留下一批「选了但不存在」的 id，
 * 用户下一次点「合并」就会拿到对不上的章节。
 */
watch(() => props.drafts, (list) => {
  const valid = new Set(list.map(draft => draft.tempId))
  const next = selectedIds.value.filter(id => valid.has(id))
  if (next.length !== selectedIds.value.length) selectedIds.value = next
  if (editingId.value && !valid.has(editingId.value)) editingId.value = null
})

/** 行数从 0 变为有值时容器才真正挂载：补量一次视口高度，否则虚拟滚动会退化成一行的窗口 */
watch(() => props.drafts.length, async (length, previous) => {
  if (length === 0 || length === previous) return
  await nextTick()
  measure()
})

// ── 交互 ───────────────────────────────────────────────────────────────────

function startEdit(draft: ChapterDraft): void {
  editingId.value = draft.tempId
  titleDraft.value = draft.title
}

function commitEdit(draft: ChapterDraft): void {
  const next = titleDraft.value.trim()
  editingId.value = null
  if (!next || next === draft.title) return
  emit('rename', draft.tempId, next)
}

function onDragStart(index: number, event: DragEvent): void {
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDropOn(index: number, event: DragEvent): void {
  event.preventDefault()
  const raw = event.dataTransfer?.getData('text/plain') ?? ''
  const from = Number(raw)
  if (!Number.isFinite(from) || from === index) return
  emit('drop', Math.max(0, Math.trunc(from)), index)
}

function onApplyAffix(action: 'add' | 'remove'): void {
  const affix = affixText.value
  if (!affix) return
  emit('affix', { affix, position: affixPosition.value, action })
}

async function onOpenPreview(tempId: string): Promise<void> {
  emit('open-preview', tempId)
  await nextTick()
}
</script>

<template>
  <section class="ct">
    <!-- 汇总与批量操作 -->
    <header class="ct__head">
      <div class="ct__stats">
        <strong class="ct__stats-main">共 {{ formatInt(drafts.length) }} 章</strong>
        <span class="ct__stats-sub">
          勾选 {{ formatInt(includedCount) }} 章 ·
          {{ formatCount(includedChars) }}字 ·
          预估 {{ formatDuration(includedDurationMs) }}
          <template v-if="totalChars > includedChars">（全文 {{ formatCount(totalChars) }}字）</template>
        </span>
      </div>
      <div class="ct__head-ops">
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="emit('set-all', true)">全选</button>
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="emit('set-all', false)">全不选</button>
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="emit('invert')">反选</button>
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="emit('sort-by-number')">
          按标题数字排序
        </button>
      </div>
    </header>

    <!-- 批量前后缀 -->
    <div class="ct__affix">
      <label class="ct__affix-field">
        <span>批量标题</span>
        <input
          v-model="affixText"
          class="ct__input"
          type="text"
          placeholder="如：斗破苍穹·"
          :disabled="busy"
        >
      </label>
      <select v-model="affixPosition" class="ct__select" :disabled="busy">
        <option value="prefix">加到标题前</option>
        <option value="suffix">加到标题后</option>
      </select>
      <button type="button" class="ns-btn ns-btn--small" :disabled="busy || !affixText" @click="onApplyAffix('add')">
        批量添加
      </button>
      <button type="button" class="ns-btn ns-btn--small" :disabled="busy || !affixText" @click="onApplyAffix('remove')">
        批量去除
      </button>
      <span class="ct__affix-hint">只作用于已勾选的章节（保持可预期）</span>
    </div>

    <!-- 合并 / 拆分入口 -->
    <div class="ct__merge-bar">
      <span class="ct__merge-info">
        已选中 {{ formatInt(selectedCount) }} 章（Shift 点选可连选一段）
        <span v-if="selectedCount >= 2 && !contiguous" class="ct__merge-warn">只有相邻的章节才能合并</span>
      </span>
      <button type="button" class="ns-btn ns-btn--small" :disabled="busy || !canMerge || !contiguous" @click="emit('merge-request', selectedIds)">
        合并选中章节
      </button>
      <button type="button" class="ns-btn ns-btn--small" :disabled="busy || !selectedCount" @click="clearSelection">
        清除选择
      </button>
    </div>

    <!-- 告警 -->
    <p v-if="suspiciousSplit" class="ct__alert">
      分章结果可疑（章数很少却有超长单章）：
      <template v-if="longestDraft">最长一章 {{ formatCount(longestDraft.charCount) }}字「{{ longestDraft.title }}」。</template>
      建议回第 3 步调整规则（多数是「行长上限」太小或标题行被清洗规则删掉了）。
    </p>
    <ul v-if="splitWarnings.length" class="ct__warnings">
      <li v-for="(warning, index) in splitWarnings" :key="index">{{ warning }}</li>
    </ul>
    <p v-if="draftsEdited" class="ct__hint">
      你已经人工调整过章节（改名/合并/拆分/删除/排序），提交时会带着这些结果一起入库。
    </p>

    <!-- 表格（虚拟滚动） -->
    <EmptyState
      v-if="!drafts.length"
      title="还没有章节"
      description="回到第 3 步调整分章规则，或选一种备选分章策略（空行分块 / 长度均分 / 整本一章）。"
      icon="📄"
      size="small"
    />

    <div v-else class="ct__table">
      <div class="ct__thead">
        <span class="ct__col-check" />
        <span class="ct__col-seq">#</span>
        <span class="ct__col-title">标题</span>
        <span class="ct__col-kind">类型</span>
        <span class="ct__col-num">字数</span>
        <span class="ct__col-num">预估时长</span>
        <span class="ct__col-include">导入</span>
        <span class="ct__col-ops">操作</span>
      </div>

      <div ref="scrollEl" class="ct__scroll" @scroll="onScroll">
        <div :style="{ height: `${range.paddingTop}px` }" />
        <div
          v-for="row in windowRows"
          :key="row.draft.tempId"
          class="ct__row"
          :class="{ 'ct__row--off': !row.draft.included, 'ct__row--selected': isSelected(row.draft.tempId) }"
          :style="{ height: `${ROW_HEIGHT}px` }"
          draggable="true"
          @dragstart="onDragStart(row.index, $event)"
          @dragover.prevent
          @drop="onDropOn(row.index, $event)"
        >
          <span class="ct__col-check">
            <input
              type="checkbox"
              :checked="isSelected(row.draft.tempId)"
              :disabled="busy"
              :title="'选中用于合并（按住 Shift 连选）'"
              @change="onRowCheck(row.index, $event)"
            >
          </span>
          <span class="ct__col-seq">{{ formatInt(row.draft.index + 1) }}</span>

          <span class="ct__col-title">
            <input
              v-if="editingId === row.draft.tempId"
              v-model="titleDraft"
              class="ct__input ct__input--title"
              type="text"
              @keydown.enter.prevent="commitEdit(row.draft)"
              @keydown.esc.prevent="editingId = null"
              @blur="commitEdit(row.draft)"
            >
            <template v-else>
              <span class="ct__title-text" :title="row.draft.title">{{ row.draft.title || '（无标题）' }}</span>
              <button type="button" class="ct__linkbtn" :disabled="busy" @click="startEdit(row.draft)">改名</button>
              <button type="button" class="ct__linkbtn" :disabled="busy" @click="onOpenPreview(row.draft.tempId)">
                预览
              </button>
            </template>
          </span>

          <span class="ct__col-kind">{{ row.draft.kind === 'chapter' ? '正文' : row.draft.kind === 'volume' ? '卷' : row.draft.kind === 'extra' ? '番外' : row.draft.kind === 'front' ? '前言' : '后记' }}</span>
          <span class="ct__col-num">{{ formatInt(row.draft.charCount) }}</span>
          <span class="ct__col-num">{{ formatDuration(row.draft.estimatedDurationMs) }}</span>

          <span class="ct__col-include">
            <input
              type="checkbox"
              :checked="row.draft.included"
              :disabled="busy"
              title="是否导入这一章"
              @change="emit('toggle', row.draft.tempId)"
            >
          </span>

          <span class="ct__col-ops">
            <button
              type="button"
              class="ct__linkbtn"
              :disabled="busy || row.index === 0"
              title="上移"
              @click="emit('move', row.draft.tempId, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="ct__linkbtn"
              :disabled="busy || row.index === drafts.length - 1"
              title="下移"
              @click="emit('move', row.draft.tempId, 1)"
            >
              ↓
            </button>
            <button type="button" class="ct__linkbtn" :disabled="busy" title="拆分这一章" @click="emit('split-request', row.draft.tempId)">
              拆分
            </button>
            <button type="button" class="ct__linkbtn ct__linkbtn--danger" :disabled="busy" title="删除（可恢复）" @click="emit('remove', row.draft.tempId)">
              删除
            </button>
          </span>
        </div>
        <div :style="{ height: `${range.paddingBottom}px` }" />
      </div>

      <p class="ct__virtual-hint">
        虚拟滚动：DOM 中只渲染 {{ formatInt(range.renderCount) }} / {{ formatInt(drafts.length) }} 行（滚动不卡）；
        拖动行可调整顺序。
      </p>
    </div>

    <!-- 被删除草稿的恢复入口（docs/10 §7.1：删除必须可恢复） -->
    <div v-if="removedDrafts.length" class="ct__removed">
      <div class="ct__removed-head">
        <strong>已删除 {{ formatInt(removedDrafts.length) }} 章</strong>
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="emit('restore-all')">全部恢复</button>
      </div>
      <ul class="ct__removed-list">
        <li v-for="record in removedDrafts" :key="record.draft.tempId">
          <span class="ct__removed-title">{{ record.draft.title }}</span>
          <span class="ct__removed-meta">{{ formatInt(record.draft.charCount) }} 字 · 原位置 #{{ formatInt(record.at + 1) }}</span>
          <button type="button" class="ct__linkbtn" :disabled="busy" @click="emit('restore', record.draft.tempId)">恢复</button>
        </li>
      </ul>
    </div>

    <!-- 右侧正文抽屉（docs/10 §7.1 硬性要求） -->
    <Teleport to="body">
      <div v-if="previewDraft" class="ct-drawer" role="dialog" aria-modal="true">
        <div class="ct-drawer__mask" @click="emit('close-preview')" />
        <aside class="ct-drawer__panel">
          <header class="ct-drawer__head">
            <div>
              <h3 class="ct-drawer__title">{{ previewDraft.title || '（无标题）' }}</h3>
              <p class="ct-drawer__meta">
                第 {{ formatInt(previewDraft.index + 1) }} 章 ·
                {{ formatInt(previewDraft.charCount) }} 字 ·
                预估 {{ formatDuration(previewDraft.estimatedDurationMs) }} ·
                偏移 {{ formatInt(previewDraft.startOffset) }}~{{ formatInt(previewDraft.endOffset) }}
              </p>
            </div>
            <button type="button" class="ns-btn ns-btn--small" @click="emit('close-preview')">关闭</button>
          </header>
          <div class="ct-drawer__body">
            <pre class="ct-drawer__text">{{ previewDraft.rawText }}</pre>
          </div>
        </aside>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.ct {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ct__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ct__stats-main {
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.ct__stats-sub {
  margin-left: 10px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ct__head-ops {
  display: flex;
  gap: 6px;
}
.ct__affix,
.ct__merge-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ct__affix-field {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ct__affix-hint,
.ct__merge-info {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ct__merge-warn {
  margin-left: 6px;
  color: var(--ns-danger, #f56c6c);
}
.ct__input,
.ct__select {
  padding: 5px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ct__input--title {
  width: 100%;
  border-color: var(--ns-primary, #409eff);
}
.ct__alert {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ns-warning, #e6a23c);
  border-radius: 4px;
  background: rgb(230 162 60 / 10%);
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  line-height: 1.6;
}
.ct__warnings {
  margin: 0;
  padding-left: 20px;
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.6;
}
.ct__hint,
.ct__virtual-hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ct__table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  overflow: hidden;
}
.ct__thead,
.ct__row {
  display: grid;
  grid-template-columns: 40px 56px minmax(220px, 1fr) 72px 90px 110px 56px 150px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 13px;
}
.ct__thead {
  height: 34px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ct__scroll {
  max-height: 46vh;
  min-height: 160px;
  overflow: auto;
}
.ct__row {
  border-top: 1px solid var(--ns-border-light, #e4e7ed);
  color: var(--ns-text-primary, #303133);
}
.ct__row--off {
  opacity: 0.5;
}
.ct__row--selected {
  background: rgb(64 158 255 / 8%);
}
.ct__col-seq,
.ct__col-num {
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ct__col-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ct__title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct__col-kind,
.ct__col-include,
.ct__col-ops {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ct__col-ops {
  justify-content: flex-end;
}
.ct__linkbtn {
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--ns-primary, #409eff);
  font-size: 12px;
  cursor: pointer;
}
.ct__linkbtn--danger {
  color: var(--ns-danger, #f56c6c);
}
.ct__linkbtn:disabled {
  color: var(--ns-text-placeholder, #c0c4cc);
  cursor: not-allowed;
}
.ct__removed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ct__removed-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ct__removed-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.ct__removed-list li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ct__removed-title {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct__removed-meta {
  color: var(--ns-text-secondary, #909399);
}
.ct-drawer {
  position: fixed;
  inset: 0;
  z-index: 2600;
  display: flex;
  justify-content: flex-end;
}
.ct-drawer__mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 35%);
}
.ct-drawer__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(560px, 90vw);
  height: 100%;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: -6px 0 24px rgb(0 0 0 / 16%);
}
.ct-drawer__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
}
.ct-drawer__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
}
.ct-drawer__meta {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ct-drawer__body {
  flex: 1;
  overflow: auto;
  padding: 12px 16px 20px;
}
.ct-drawer__text {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.9;
  white-space: pre-wrap;
  word-break: break-word;
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
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
