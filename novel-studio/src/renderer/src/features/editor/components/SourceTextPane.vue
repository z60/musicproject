<!--
  画本编辑 · 原文对照面板（docs/11 §4.1 右栏、§4.4「原文片段」）
  ============================================================================
  用途：核对「划本划得对不对」——画本行是从原文哪一段来的、有没有被切碎/漏字。

  实现说明（重要，别被误以为功能残缺）：
    · IPC 契约里 `canvas:getChapter` 只返回画本行，**没有**章节正文全文的通道；
      所以这里用每行的 `sourceText` 顺次拼出「原文上下文」，而不是重新读正文文件。
    · 每行都带 charStart / charEnd，用于显示这一行在正文中的字符区间；
      点击任一原文段落即选中对应的画本行（表格/剧本/抽屉会同步）。
    · 当前行高亮并可在切换行时自动跟随（开关默认开）。
-->

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CanvasLine, Id } from '@shared/types.ts'
import { formatInt } from '@/shared/lib/format.ts'

const props = withDefaults(defineProps<{
  /** 章节全部画本行（用于拼接原文上下文） */
  lines: CanvasLine[]
  /** 当前行（高亮） */
  activeLineId?: Id | null
  /** 章节标题（面板头部展示） */
  chapterTitle?: string | null
  /** 上下文条数（前后各 N 行，默认 8） */
  contextSize?: number
  /** 只读（本面板只读，保留给任务包模式下的说明文案） */
  readonly?: boolean
} >(), {
  activeLineId: null,
  chapterTitle: null,
  contextSize: 8,
  readonly: false,
})

const emit = defineEmits<{
  /** 点击原文段落 → 选中对应画本行 */
  select: [lineId: Id]
  /** 请求打开单行编辑抽屉 */
  open: [lineId: Id]
  /** 折叠/展开右栏 */
  'toggle-collapse': []
}>()

const autoFollow = ref(true)
const bodyRef = ref<HTMLElement | null>(null)

const currentIndex = computed(() => props.lines.findIndex(l => l.id === props.activeLineId))
const current = computed<CanvasLine | null>(() => (currentIndex.value >= 0 ? props.lines[currentIndex.value] ?? null : null))

interface ContextSegment {
  id: Id
  seq: number
  text: string
  isCurrent: boolean
  /** 该行的原文与可录文本是否不同（不同说明被人工改过） */
  edited: boolean
  charStart: number
  charEnd: number
}

/** 原文上下文：以当前行为中心取前后各 N 行 */
const segments = computed<ContextSegment[]>(() => {
  const size = Math.max(1, props.contextSize)
  const from = currentIndex.value >= 0 ? Math.max(0, currentIndex.value - size) : 0
  const to = currentIndex.value >= 0
    ? Math.min(props.lines.length - 1, currentIndex.value + size)
    : Math.min(props.lines.length - 1, size * 2)
  const out: ContextSegment[] = []
  for (let i = from; i <= to; i++) {
    const line = props.lines[i]
    if (!line) continue
    out.push({
      id: line.id,
      seq: line.seq,
      text: line.sourceText ?? line.text,
      isCurrent: line.id === props.activeLineId,
      edited: Boolean(line.sourceText) && line.sourceText !== line.text,
      charStart: line.charStart,
      charEnd: line.charEnd,
    })
  }
  return out
})

const missingSource = computed(() => segments.value.filter(s => !s.text).length)

/** 当前行的原文片段与其可录文本对照 */
const diff = computed(() => {
  const line = current.value
  if (!line) return null
  const source = line.sourceText ?? ''
  if (!source || source === line.text) return null
  return { source, text: line.text }
})

/** 切换当前行：自动跟随（把高亮段滚进面板可视区） */
watch(() => props.activeLineId, async () => {
  if (!autoFollow.value) return
  await nextTick()
  // 用 class 查询而不是 v-for 里的模板 ref：v-for 中的字符串 ref 会变成数组，点位很别扭
  bodyRef.value?.querySelector('.ns-source__segment.is-current')?.scrollIntoView({ block: 'center' })
})

function onSegmentClick(segment: ContextSegment): void {
  emit('select', segment.id)
}
</script>

<template>
  <div class="ns-source">
    <header class="ns-source__head">
      <span class="ns-source__title">原文对照</span>
      <span v-if="props.chapterTitle" class="ns-source__chapter" :title="props.chapterTitle">{{ props.chapterTitle }}</span>
      <span class="ns-source__grow" />
      <el-switch v-model="autoFollow" size="small" active-text="跟随" />
      <el-button size="small" text @click="emit('toggle-collapse')">折叠</el-button>
    </header>

    <div ref="bodyRef" class="ns-source__body">
      <div v-if="current" class="ns-source__current">
        <div class="ns-source__current-head">
          <span>当前行 #{{ current.seq }}</span>
          <span class="ns-source__muted">字符 {{ formatInt(current.charStart) }} ~ {{ formatInt(current.charEnd) }}</span>
          <el-button size="small" text @click="emit('open', current.id)">编辑这一行</el-button>
        </div>

        <p class="ns-source__current-text">
          {{ current.sourceText ?? '（这一行没有原文片段，可能是人工新增的行）' }}
        </p>

        <div v-if="diff" class="ns-source__diff">
          <p class="ns-source__diff-label">可录文本已被人工修改：</p>
          <p class="ns-source__diff-text">{{ diff.text }}</p>
        </div>
      </div>
      <p v-else class="ns-source__muted">还没有选中行。在表格或剧本里点一行，这里会跟着定位。</p>

      <section class="ns-source__context">
        <p class="ns-source__context-label">
          上下文原文（当前行 ±{{ props.contextSize }} 行）
          <span v-if="missingSource" class="ns-source__muted">· {{ missingSource }} 行缺原文片段</span>
        </p>

        <ol class="ns-source__list">
          <li
            v-for="segment in segments"
            :key="segment.id"
            class="ns-source__segment"
            :class="{ 'is-current': segment.isCurrent }"
            @click="onSegmentClick(segment)"
          >
            <span class="ns-source__seq">{{ segment.seq }}</span>
            <span class="ns-source__text">
              <mark v-if="segment.isCurrent">{{ segment.text }}</mark>
              <template v-else>{{ segment.text }}</template>
              <em v-if="segment.edited" class="ns-source__edited" title="这一行的可录文本与原文不同">已改</em>
            </span>
          </li>
        </ol>

        <p v-if="!segments.length" class="ns-source__muted">这一章还没有画本行。</p>
      </section>

      <p class="ns-source__note">
        说明：原文按每行的 sourceText 顺次拼接（IPC 未提供章节正文全文通道），
        因此这里校对的是「切句与剥离引号的结果」，而不是排版后的整章原文。
      </p>
    </div>
  </div>
</template>

<style scoped>
.ns-source {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.ns-source__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-source__title {
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-source__chapter {
  max-width: 140px;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-source__grow {
  flex: 1;
}
.ns-source__body {
  flex: 1;
  min-height: 0;
  padding: 8px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.8;
}
.ns-source__current {
  padding: 8px;
  border-radius: 4px;
  background: rgb(64 158 255 / 10%);
}
.ns-source__current-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-source__current-text {
  margin: 4px 0 0;
  color: var(--ns-text-primary, #303133);
  word-break: break-word;
}
.ns-source__diff {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
}
.ns-source__diff-label {
  margin: 0;
  color: var(--ns-warning, #e6a23c);
  font-size: 11px;
}
.ns-source__diff-text {
  margin: 2px 0 0;
  color: var(--ns-text-regular, #606266);
  word-break: break-word;
}
.ns-source__context {
  margin-top: 10px;
}
.ns-source__context-label {
  margin: 0 0 4px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-source__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ns-source__segment {
  display: flex;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: pointer;
}
.ns-source__segment:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-source__segment.is-current {
  background: rgb(64 158 255 / 14%);
}
.ns-source__seq {
  flex: 0 0 30px;
  color: var(--ns-text-placeholder, #c0c4cc);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.ns-source__text {
  flex: 1;
  word-break: break-word;
}
.ns-source__text mark {
  background: rgb(64 158 255 / 25%);
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-source__edited {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 2px;
  background: rgb(230 162 60 / 18%);
  color: var(--ns-warning, #e6a23c);
  font-style: normal;
  font-size: 10px;
}
.ns-source__muted {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-source__note {
  margin: 12px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
</style>
