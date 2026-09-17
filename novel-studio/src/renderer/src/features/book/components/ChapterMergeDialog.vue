<!--
  书籍导入域 · 合并 / 拆分对话框（docs/10 §7.1 「合并 / 拆分」+ 边界预览）
  ============================================================================
  设计依据：
    · docs/10 §7.1 —— Step 5 必须能做「改名 / 合并 / 拆分 / 删除 / 勾选」，
      且合并**必须能看清边界**：否则用户无法判断「这一刀切得对不对」
    · docs/10 §7.1 —— 章标题支持批量前后缀；合并后的标题必须可选（默认取第一段标题）
    · docs/10 §6.6 —— 章偏移 startOffset/endOffset 的含义（全书坐标），
      预览期草稿的偏移同样是全书坐标，因此这里显示的偏移可直接与 store 对账
    · docs/11 §4.7 —— 破坏性批量操作必须说清影响范围（合并后原章节不再独立存在）
    · docs/22 §6.2 —— 本组件不弹提示、不自拼错误文案：真正写库失败由父视图交给 error-bus

  两种模式的差异：
    · merge：选「用哪个标题」+ 看首段头部与末段尾部的正文边界；
    · split：给拆分点（相对本章正文的字符偏移）。预览期有 rawText，可按段落点选；
      已入库章节没有正文可读（chapter:get 只给元数据），因此只能手填偏移 —— 界面会写明这一点。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatCount, formatDuration, formatInt } from '@/shared/lib/format.ts'
import { estimateDurationMs } from '@/features/book/stores/import.store.ts'

/**
 * 参与合并 / 拆分的条目（预览期用 ChapterDraft 的字段，入库后用 Chapter 的字段）。
 * 注意：`script setup` 块里不能写 export，父视图按这个结构传对象即可（结构化类型兼容）。
 */
interface MergeItem {
  id: string
  title: string
  charCount: number
  /** 正文（预览期草稿有；已入库章节通常没有） */
  rawText?: string
}

const props = withDefaults(defineProps<{
  /** 双向绑定：是否显示 */
  modelValue: boolean
  /** merge = 合并多章；split = 拆分一章 */
  mode?: 'merge' | 'split'
  /** 参与操作的条目（merge 至少 2 条；split 传 1 条） */
  items?: MergeItem[]
  /** 提交中（禁用按钮，避免重复提交） */
  loading?: boolean
}>(), {
  mode: 'merge',
  items: () => [],
  loading: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /**
   * merge：ids 为要合并的章节、title 为合并后的标题；
   * split：id 为目标章节、offsets 为相对该章正文的字符偏移（升序、去重）
   */
  confirm: [payload:
    | { mode: 'merge'; ids: string[]; title: string }
    | { mode: 'split'; id: string; offsets: number[] }]
  cancel: []
}>()

/** 用于边界预览的截断长度 */
const HEAD_CHARS = 120
const TAIL_CHARS = 120

/** merge：标题来源（'first' = 用第一段标题，其余为 items 的 id）+ 自定义标题 */
const titleSource = ref<string>('first')
const customTitle = ref('')
/** split：用户在原文里点选的偏移（相对该章正文） */
const pickedOffsets = ref<number[]>([])
/** split：手填偏移（逗号分隔；已入库章节没有正文时只能手填） */
const manualOffsets = ref('')

const isMerge = computed(() => props.mode === 'merge')

const first = computed(() => props.items[0] ?? null)
const last = computed(() => props.items[props.items.length - 1] ?? null)

const totalChars = computed(() => props.items.reduce((sum, item) => sum + item.charCount, 0))
const totalDurationMs = computed(() => estimateDurationMs(totalChars.value))

/** 合并后的标题：标题来源优先，其次自定义 */
const resolvedTitle = computed(() => {
  if (titleSource.value === 'custom') return customTitle.value.trim()
  if (titleSource.value === 'first') return first.value?.title ?? ''
  return props.items.find(item => item.id === titleSource.value)?.title ?? ''
})

const customMissing = computed(() => titleSource.value === 'custom' && !customTitle.value.trim())

// ── 拆分：拆分点候选（预览期有正文时按段落起点给出可点选的边界）────────────
const paragraphOffsets = computed<Array<{ offset: number; preview: string }>>(() => {
  const raw = first.value?.rawText ?? ''
  if (!raw) return []
  const out: Array<{ offset: number; preview: string }> = []
  let cursor = 0
  for (const line of raw.split('\n')) {
    const start = cursor
    cursor += line.length + 1
    if (start === 0) continue // 第一段起点不是合法拆分点
    if (!line.trim()) continue
    out.push({ offset: start, preview: line.trim().slice(0, 40) })
    if (out.length >= 200) break
  }
  return out
})

/** 手填偏移解析：支持「1200, 3400」这类输入 */
const manualParsed = computed<number[]>(() => manualOffsets.value
  .split(/[,，\s]+/)
  .map(part => Number(part.trim()))
  .filter(value => Number.isFinite(value) && value > 0)
  .map(value => Math.round(value)))

/** 最终拆分点（点选 + 手填，去重升序）；上限由本章长度决定 */
const splitOffsets = computed(() => {
  const limit = first.value?.charCount ?? 0
  const merged = [...new Set([...pickedOffsets.value, ...manualParsed.value])]
    .filter(offset => offset > 0 && (limit <= 0 || offset < limit))
    .sort((a, b) => a - b)
  return merged
})

/** 拆分预览：把正文按拆分点切成若干段，显示每段首 40 字（没有正文时退化为纯偏移说明） */
const splitPreview = computed(() => {
  const raw = first.value?.rawText
  const offsets = splitOffsets.value
  if (!raw) {
    return offsets.map((offset, index) => ({
      label: `第 ${index + 1} 段`,
      head: `正文从偏移 0 到 ${formatInt(offset)}（该章节没有可用正文，无法显示内容预览）`,
    }))
  }
  const pieces: Array<{ label: string; head: string }> = []
  let cursor = 0
  const bounds = [...offsets, raw.length]
  bounds.forEach((end, index) => {
    const text = raw.slice(cursor, end).trim()
    pieces.push({ label: `第 ${index + 1} 段（${formatInt(text.length)} 字）`, head: text.slice(0, 40) || '（空段会被丢弃）' })
    cursor = end
  })
  return pieces
})

function headOf(item: MergeItem | null): string {
  const raw = item?.rawText
  if (!raw) return '（没有可用正文，无法预览内容）'
  return raw.slice(0, HEAD_CHARS).replace(/\s+/g, ' ').trim()
}

function tailOf(item: MergeItem | null): string {
  const raw = item?.rawText
  if (!raw) return '（没有可用正文，无法预览内容）'
  return raw.slice(Math.max(0, raw.length - TAIL_CHARS)).replace(/\s+/g, ' ').trim()
}

function toggleOffset(offset: number): void {
  const set = new Set(pickedOffsets.value)
  if (set.has(offset)) set.delete(offset)
  else set.add(offset)
  pickedOffsets.value = [...set]
}

// 打开时复位：合并默认用第一段标题，拆分清空已选偏移
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  titleSource.value = 'first'
  customTitle.value = ''
  pickedOffsets.value = []
  manualOffsets.value = ''
})

const canConfirm = computed(() => {
  if (props.loading) return false
  if (isMerge.value) return props.items.length >= 2 && !!resolvedTitle.value
  return props.items.length === 1 && splitOffsets.value.length > 0
})

const blockReason = computed(() => {
  if (isMerge.value) {
    if (props.items.length < 2) return '至少选两章才能合并（Shift 点选可连选一段）'
    if (customMissing.value) return '请先填写合并后的自定义标题'
    return null
  }
  if (props.items.length !== 1) return '拆分一次只能处理一章'
  if (!splitOffsets.value.length) return '还没有拆分点：在下方点选段落边界，或手填相对本章正文的字符偏移'
  return null
})

function close(): void {
  emit('update:modelValue', false)
}

function onCancel(): void {
  emit('cancel')
  close()
}

function onConfirm(): void {
  if (!canConfirm.value) return
  if (isMerge.value) {
    emit('confirm', { mode: 'merge', ids: props.items.map(item => item.id), title: resolvedTitle.value })
  } else if (first.value) {
    emit('confirm', { mode: 'split', id: first.value.id, offsets: splitOffsets.value })
  }
  close()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="merge" role="dialog" aria-modal="true">
      <div class="merge__mask" @click="onCancel" />
      <div class="merge__panel">
        <header class="merge__head">
          <h3 class="merge__title">{{ isMerge ? '合并章节' : '拆分章节' }}</h3>
          <button type="button" class="ns-btn ns-btn--small" @click="onCancel">关闭</button>
        </header>

        <div class="merge__body">
          <!-- ── 合并 ─────────────────────────────────────────────────── -->
          <template v-if="isMerge">
            <p class="merge__summary">
              将把 {{ formatInt(items.length) }} 章合并为 1 章：{{ formatCount(totalChars) }}字 ·
              预估 {{ formatDuration(totalDurationMs) }}。合并后原章节编号与边界消失，请确认边界无误。
            </p>

            <fieldset class="merge__group">
              <legend>合并后的标题</legend>
              <label class="merge__option">
                <input v-model="titleSource" type="radio" value="first">
                <span>用第一段标题：<strong>{{ first?.title || '（无标题）' }}</strong></span>
              </label>
              <label v-for="item in items" :key="item.id" class="merge__option">
                <input v-model="titleSource" type="radio" :value="item.id">
                <span>用「{{ item.title }}」（第 {{ formatInt(item.charCount) }} 字）</span>
              </label>
              <label class="merge__option">
                <input v-model="titleSource" type="radio" value="custom">
                <span>自定义：</span>
                <input
                  v-model="customTitle"
                  class="merge__input"
                  type="text"
                  placeholder="如：第一章 少年（含序章）"
                  :disabled="titleSource !== 'custom'"
                >
              </label>
            </fieldset>

            <section class="merge__boundary">
              <h4 class="merge__subtitle">首尾边界预览</h4>
              <div class="merge__boundary-item">
                <span class="merge__boundary-label">合并后开头（来自「{{ first?.title || '—' }}」）</span>
                <p class="merge__boundary-text">{{ headOf(first) }}</p>
              </div>
              <div class="merge__boundary-item">
                <span class="merge__boundary-label">合并后结尾（来自「{{ last?.title || '—' }}」）</span>
                <p class="merge__boundary-text">{{ tailOf(last) }}</p>
              </div>
            </section>

            <table class="merge__table">
              <thead>
                <tr>
                  <th>章节</th>
                  <th class="merge__col-num">字数</th>
                  <th class="merge__col-num">预估时长</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in items" :key="item.id">
                  <td>{{ item.title }}</td>
                  <td class="merge__col-num">{{ formatInt(item.charCount) }}</td>
                  <td class="merge__col-num">{{ formatDuration(estimateDurationMs(item.charCount)) }}</td>
                </tr>
              </tbody>
            </table>
          </template>

          <!-- ── 拆分 ─────────────────────────────────────────────────── -->
          <template v-else>
            <p class="merge__summary">
              把「{{ first?.title || '—' }}」（{{ formatInt(first?.charCount ?? 0) }} 字）拆成
              {{ formatInt(splitPreview.length) }} 段。拆分点使用<strong>相对本章正文</strong>的字符偏移，
              与 store.split 的语义一致（store 会自行换算成全书偏移）。
            </p>

            <section v-if="paragraphOffsets.length" class="merge__group">
              <h4 class="merge__subtitle">点选段落边界（正文前 200 段）</h4>
              <div class="merge__offsets">
                <button
                  v-for="candidate in paragraphOffsets"
                  :key="candidate.offset"
                  type="button"
                  class="merge__offset"
                  :class="{ 'merge__offset--on': pickedOffsets.includes(candidate.offset) }"
                  @click="toggleOffset(candidate.offset)"
                >
                  <span class="merge__offset-no">{{ formatInt(candidate.offset) }}</span>
                  <span class="merge__offset-text">{{ candidate.preview }}</span>
                </button>
              </div>
            </section>

            <label class="merge__field">
              <span>手动偏移（逗号分隔，可叠加在上面的点选之上）</span>
              <input
                v-model="manualOffsets"
                class="merge__input"
                type="text"
                placeholder="如：1200, 3400"
              >
            </label>

            <section class="merge__boundary">
              <h4 class="merge__subtitle">拆分预览（{{ formatInt(splitPreview.length) }} 段）</h4>
              <ul class="merge__preview-list">
                <li v-for="(piece, index) in splitPreview" :key="index">
                  <span class="merge__preview-label">{{ piece.label }}</span>
                  <span class="merge__preview-head">{{ piece.head }}</span>
                </li>
              </ul>
              <p v-if="!splitPreview.length" class="merge__hint">还没有拆分点，预览为空。</p>
            </section>
          </template>

          <p v-if="blockReason" class="merge__block">{{ blockReason }}</p>
        </div>

        <footer class="merge__foot">
          <button type="button" class="ns-btn" :disabled="loading" @click="onCancel">取消</button>
          <button
            type="button"
            class="ns-btn ns-btn--primary"
            :disabled="!canConfirm"
            @click="onConfirm"
          >
            {{ loading ? '处理中…' : (isMerge ? '确认合并' : '确认拆分') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.merge {
  position: fixed;
  inset: 0;
  z-index: 2900;
  display: flex;
  align-items: center;
  justify-content: center;
}
.merge__mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 45%);
}
.merge__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(680px, 94vw);
  max-height: 88vh;
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
  box-shadow: 0 8px 32px rgb(0 0 0 / 20%);
}
.merge__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px 8px;
}
.merge__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 16px;
  font-weight: 600;
}
.merge__body {
  flex: 1;
  overflow: auto;
  padding: 0 18px 8px;
}
.merge__summary {
  margin: 0 0 10px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  line-height: 1.7;
}
.merge__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 12px;
  padding: 10px 12px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
}
.merge__group legend {
  padding: 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.merge__option {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.merge__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.merge__input {
  flex: 1;
  min-width: 160px;
  padding: 5px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.merge__input:disabled {
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
}
.merge__boundary {
  margin-bottom: 12px;
}
.merge__subtitle {
  margin: 0 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.merge__boundary-item {
  padding: 8px 10px;
  border-left: 3px solid var(--ns-primary, #409eff);
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
}
.merge__boundary-item + .merge__boundary-item {
  margin-top: 6px;
}
.merge__boundary-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.merge__boundary-text {
  margin: 4px 0 0;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  line-height: 1.8;
  word-break: break-word;
}
.merge__offsets {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
}
.merge__offset {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  text-align: left;
  cursor: pointer;
}
.merge__offset--on {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 10%);
}
.merge__offset-no {
  min-width: 56px;
  color: var(--ns-text-secondary, #909399);
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.merge__offset-text {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge__preview-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.merge__preview-list li {
  display: flex;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--ns-border-light, #e4e7ed);
}
.merge__preview-label {
  min-width: 130px;
  color: var(--ns-text-secondary, #909399);
}
.merge__preview-head {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.merge__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.merge__table th,
.merge__table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  text-align: left;
}
.merge__table th {
  color: var(--ns-text-regular, #606266);
  font-weight: 500;
}
.merge__col-num {
  width: 110px;
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.merge__block {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ns-warning, #e6a23c);
  border-radius: 4px;
  background: rgb(230 162 60 / 10%);
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  line-height: 1.6;
}
.merge__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px 16px;
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
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
